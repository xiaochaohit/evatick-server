import { Context, type Fiber } from '@deepseek-ai/cordis'

import type { InstrumentProvider } from '@market-cli/core'
import {
  MarketProviderRegistry,
  mountInstrumentProvider,
  type MountedProvider,
} from '@market-cli/cordis-runtime'
import { MarketHttpService } from '@market-cli/transport-http'

export interface MarketServer {
  readonly url: string
  mountProvider(provider: InstrumentProvider): Promise<MountedProvider>
  close(): Promise<void>
}

export async function createMarketServer(): Promise<MarketServer> {
  const ctx = new Context()
  const registryFiber: Fiber = ctx.plugin(MarketProviderRegistry)
  await registryFiber.await()
  const httpFiber: Fiber = ctx.plugin(MarketHttpService)
  await httpFiber.await()
  const url = await ctx.marketHttp.listen()

  return {
    url,
    mountProvider(provider) {
      return mountInstrumentProvider(ctx, provider)
    },
    async close() {
      await httpFiber.dispose()
      await registryFiber.dispose()
    },
  }
}

export type { InstrumentProvider } from '@market-cli/core'
