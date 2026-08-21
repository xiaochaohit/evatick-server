import { Context, type Fiber } from '@deepseek-ai/cordis'

import { SqliteCatalogSnapshotStore } from '@market-cli/catalog-sqlite'
import {
  MemoryCatalogSnapshotStore,
  type InstrumentProvider,
} from '@market-cli/core'
import {
  MarketCatalogStore,
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

export interface MarketServerOptions {
  retryAttempts?: number
  requestTimeoutMs?: number
  healthCheckIntervalMs?: number
  healthCheckTimeoutMs?: number
  catalogPath?: string
  historyPath?: string
  adminUsername?: string
  adminPassword?: string
  adminCredentialsPath?: string
  host?: string
  port?: number
}

export async function createMarketServer(
  options: MarketServerOptions = {},
): Promise<MarketServer> {
  const ctx = new Context()
  const registryFiber: Fiber = ctx.plugin(MarketProviderRegistry)
  await registryFiber.await()
  const catalogStore = options.catalogPath
    ? new SqliteCatalogSnapshotStore(options.catalogPath)
    : new MemoryCatalogSnapshotStore()
  const storeFiber: Fiber = ctx.plugin(MarketCatalogStore, catalogStore)
  await storeFiber.await()
  const httpFiber: Fiber = ctx.plugin(MarketHttpService, options)
  await httpFiber.await()
  const url = await ctx.marketHttp.listen(options.host, options.port)
  const mountedProviders = new Set<MountedProvider>()

  return {
    url,
    async mountProvider(provider) {
      const mounted = await mountInstrumentProvider(ctx, provider)
      let disposed = false
      const tracked: MountedProvider = {
        async dispose() {
          if (disposed) return
          disposed = true
          mountedProviders.delete(tracked)
          await mounted.dispose()
        },
      }
      mountedProviders.add(tracked)
      return tracked
    },
    async close() {
      await httpFiber.dispose()
      await Promise.all([...mountedProviders].map((provider) => provider.dispose()))
      await storeFiber.dispose()
      await registryFiber.dispose()
    },
  }
}

export {
  ProviderError,
  type InstrumentProvider,
} from '@market-cli/core'
