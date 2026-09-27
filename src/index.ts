import { Context } from '@deepseek-ai/cordis'
import { Config, type PluginConfig, resolveConfig } from './config'
import { GarminClient } from './client'
import {
  registerEmbeddedAuthRpc,
  resolveEmbeddedAuthConfig,
} from './embedded-auth-rpc'
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
  const resolvedConfig = resolveEmbeddedAuthConfig(resolveConfig(config))
  const client = new GarminClient(ctx, resolvedConfig, {
    allowUnconfigured: true,
  })

  // Loader commits volatile fields without remounting the plugin. Rebuild the
  // client, tools, and auth controller together from the newly committed refs.
  let restartQueued = false
  ctx.on('loader/volatile-update', paths => {
    if (
      restartQueued
      || !paths.some(path => path.length === 1 && (
        path[0] === 'username' || path[0] === 'region'
      ))
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
  const initialConnection = client.connect().catch(() => undefined)

  // Register all AI-callable tools
  registerTools(ctx, client, resolvedConfig)

  // Compatible DSH hosts gain an optional loopback-only browser sign-in UI.
  // The Garmin ticket and resulting session never cross into the web client.
  registerEmbeddedAuthRpc(ctx, resolvedConfig, {
    getAuthenticatedAccount: async () => {
      await initialConnection
      return client.getAuthenticatedAccount()
    },
    getAuthenticationRequirement: async () => {
      await initialConnection
      return client.getAuthenticationRequirement()
    },
    replaceSession: writer => client.replacePersistedSession(writer),
  })

  ctx.effect(() => () => client.deactivate(), 'garmin-connect: client lifecycle')
}
