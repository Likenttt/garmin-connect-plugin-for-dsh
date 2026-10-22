import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config'
import { GarminClient, type GarminClientLike, type GarminClientOptions } from './client'
import { GarminPersonalClient } from './personal-client'

export function createGarminClient(
  ctx: Context,
  config: Config,
  options: GarminClientOptions = {},
): GarminClientLike {
  return config.provider === 'personal'
    ? new GarminPersonalClient(config)
    : new GarminClient(ctx, config, options)
}
