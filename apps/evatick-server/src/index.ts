import { Context, type Fiber } from '@deepseek-ai/cordis'

import { SqliteCatalogSnapshotStore } from '@evatick/catalog-sqlite'
import {
  MemoryCatalogSnapshotStore,
  type InstrumentProvider,
} from '@evatick/core'
import {
  MarketCatalogStore,
  MarketProviderRegistry,
  mountInstrumentProvider,
  type MountedProvider,
} from '@evatick/cordis-runtime'
import { EvaHttpService } from '@evatick/transport-http'

export interface EvaTickServer {
  readonly url: string
  mountProvider(provider: InstrumentProvider): Promise<MountedProvider>
  close(): Promise<void>
}

export interface EvaTickServerOptions {
  retryAttempts?: number
  requestTimeoutMs?: number
  healthCheckIntervalMs?: number
  healthCheckTimeoutMs?: number
  catalogPath?: string
  historyPath?: string
  adminUsername?: string
  adminPassword?: string
  adminCredentialsPath?: string
  apiKeysPath?: string
  dataSourcePreferencesPath?: string
  host?: string
  port?: number
}

export async function createEvaTickServer(
  options: EvaTickServerOptions = {},
): Promise<EvaTickServer> {
  const ctx = new Context()
  const registryFiber: Fiber = ctx.plugin(MarketProviderRegistry)
  await registryFiber.await()
  const catalogStore = options.catalogPath
    ? new SqliteCatalogSnapshotStore(options.catalogPath)
    : new MemoryCatalogSnapshotStore()
  const storeFiber: Fiber = ctx.plugin(MarketCatalogStore, catalogStore)
  await storeFiber.await()
  const httpFiber: Fiber = ctx.plugin(EvaHttpService, options)
  await httpFiber.await()
  const url = await ctx.evaHttp.listen(options.host, options.port)
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
} from '@evatick/core'
