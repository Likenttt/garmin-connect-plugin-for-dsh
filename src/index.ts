import { Context } from '@deepseek-ai/cordis'
import { Config, type PluginConfig, resolveAccountConfigs, resolveConfig } from './config'
import { createGarminClient } from './client-factory'
import { registerEmbeddedAuthRpcAccounts } from './embedded-auth-rpc'
import { registerTools } from './tools'
import { createHash } from 'node:crypto'
import { registerCoachPanel } from './coach-panel'
import { createAccountRegistry } from './account-registry'
import { registerHarnessWorkspace } from './workspace-harness'

export const name = 'garmin-connect'
export { Config, resolveConfig }
export const inject = ['tools']

declare module '@deepseek-ai/cordis' {
  interface Events {
    'loader/volatile-update'(paths: readonly (readonly string[])[]): void
  }
}

export function apply(ctx: Context, config: Config | PluginConfig) {
  const legacySeeds = resolveAccountConfigs(config)
  const baseConfig = resolveConfig(config)

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
        'authVerbose',
        'account1Username', 'account2Username', 'account3Username',
        'account4Username', 'account5Username',
        'account1UsernameId', 'account2UsernameId', 'account3UsernameId',
        'account4UsernameId', 'account5UsernameId',
        'provider', 'accountAlias', 'personalApiKey', 'personalApiKeyFile',
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

  // Scope local coaching records to the Host configuration, independently of
  // account additions/removals or the transient plugin fiber instance.
  ctx.inject(['loader'], scopeCtx => {
    const loader = (scopeCtx as unknown as {
      loader?: { config?: { baseUrl?: string | URL } }
    }).loader
    // Desktop may set baseUrl on the loading context before constructing the
    // Loader, leaving its optional config.baseUrl unset.
    const baseUrl = loader?.config?.baseUrl
      ?? (scopeCtx as unknown as { baseUrl?: string | URL }).baseUrl
    const scopeId = baseUrl
      ? createHash('sha256').update(String(baseUrl)).digest('hex')
      : undefined
    if (scopeId) {
      registerHarnessWorkspace(scopeCtx, { scopeId, legacySeeds, baseConfig })
      return
    }
    const accounts = createAccountRegistry({
      legacySeeds, baseConfig, scopeId,
      createClient: accountConfig => createGarminClient(scopeCtx, accountConfig, { allowUnconfigured: true }),
    })
    // Every consumer waits for catalog readiness and selects a current account.
    // Neither registration nor a local member list constructs/logs in SDK clients.
    registerTools(scopeCtx, accounts)
    registerEmbeddedAuthRpcAccounts(scopeCtx, accounts)
    registerCoachPanel(scopeCtx, accounts, { scopeId })
    scopeCtx.effect(() => () => accounts.close(), 'garmin-connect: account registry')
  })
}
