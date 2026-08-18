import { Context } from 'cordis'
import { Config } from './config'
import { GarminClient } from './client'
import { registerTools } from './tools'

export const name = 'garmin-connect'
export { Config }
export const inject = ['dshTools']

export function apply(ctx: Context, config: Config) {
  const client = new GarminClient(ctx, config)

  // Initialize Garmin session on plugin startup
  ctx.on('ready', async () => {
    await client.connect()
  })

  // Clean up on plugin disposal (Cordis lifecycle)
  ctx.on('dispose', () => {
    client.destroy()
  })

  // Register all AI-callable tools
  registerTools(ctx, client)
}
