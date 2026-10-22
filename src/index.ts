import { Context } from '@deepseek-ai/cordis'
import { Config, type PluginConfig, resolveAccountConfigs, resolveConfig } from './config'
import { createGarminClient } from './client-factory'
import { registerEmbeddedAuthRpcAccounts } from './embedded-auth-rpc'
import { registerTools } from './tools'

export const name = 'garmin-connect'
export { Config, resolveConfig }
export const inject = ['tools']

declare module '@deepseek-ai/cordis' {
  interface Events {
    'loader/volatile-update'(paths: readonly (readonly string[])[]): void
  }
}

export function apply(ctx: Context, config: Config | PluginConfig) {
  const accounts = resolveAccountConfigs(config).map(account => {
    const client = createGarminClient(ctx, account.config, { allowUnconfigured: true })
    return { ...account, client }
  })

  // Loader commits volatile fields without remounting the plugin. Rebuild the
  // client, tools, and auth controller together from the newly committed refs.
  let restartQueued = false
  ctx.on('loader/volatile-update', paths => {
    if (
      restartQueued
      || !paths.some(path => path.length === 1 && [
        'username', 'region',
        'cnUsername', 'cnAlias', 'cnConfigured',
        'globalUsername', 'globalAlias', 'globalConfigured',
        'accounts', 'accountsConfigured',
        'account1Username', 'account2Username', 'account3Username',
        'account4Username', 'account5Username',
        'account1UsernameId', 'account2UsernameId', 'account3UsernameId',
        'account4UsernameId', 'account5UsernameId',
        'provider', 'personalApiKey', 'personalApiKeyFile',
        'account1PersonalApiKey', 'account2PersonalApiKey', 'account3PersonalApiKey',
        'account4PersonalApiKey', 'account5PersonalApiKey',
        'account1PersonalApiKeyId', 'account2PersonalApiKeyId', 'account3PersonalApiKeyId',
        'account4PersonalApiKeyId', 'account5PersonalApiKeyId',
      ].includes(path[0]))
    ) return
    restartQueued = true
    queueMicrotask(() => {
      restartQueued = false
      if (ctx.fiber.uid === null) return
      void ctx.fiber.restart().catch(() => {
        ctx.logger.error('[garmin] Could not apply updated account settings')
      })
    })
  })

  // Kick off the Garmin login in the background. Tool calls auto-connect on
  // first use, so a slow or temporarily failing login never blocks plugin
  // activation (dsh's Cordis fork has no 'ready' lifecycle event).
  const activeAccounts = accounts.map(account => ({
    ...account,
    initialConnection: account.configured
      ? account.client.connect().catch(() => undefined)
      : Promise.resolve(),
  }))

  // Register all AI-callable tools
  registerTools(ctx, activeAccounts)

  // Compatible DSH hosts gain an optional loopback-only browser sign-in UI.
  // The Garmin ticket and resulting session never cross into the web client.
  registerEmbeddedAuthRpcAccounts(ctx, activeAccounts)

  ctx.effect(() => () => {
    for (const { client } of accounts) client.deactivate()
  }, 'garmin-connect: client lifecycle')
}
