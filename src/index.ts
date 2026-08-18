import { Context } from '@deepseek-ai/cordis'
import { Config } from './config'
import { GarminClient } from './client'
import { registerTools } from './tools'

export const name = 'garmin-connect'
export { Config }
export const inject = ['tools']

export function apply(ctx: Context, config: Config) {
  const client = new GarminClient(ctx, config)

  // Kick off the Garmin login in the background. Tool calls auto-connect on
  // first use, so a slow or temporarily failing login never blocks plugin
  // activation (dsh's Cordis fork has no 'ready' lifecycle event).
  void client.connect().catch(() => {})

  // Register all AI-callable tools
  registerTools(ctx, client, config)
}
