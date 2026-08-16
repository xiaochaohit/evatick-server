import { Service, type Context, type Fiber, type Plugin } from '@deepseek-ai/cordis'

import type { InstrumentProvider } from '@market-cli/core'

declare module '@deepseek-ai/cordis' {
  interface Context {
    marketProviderRegistry: MarketProviderRegistry
  }
}

export class MarketProviderRegistry extends Service {
  private readonly providers = new Map<string, InstrumentProvider>()

  constructor(ctx: Context) {
    super(ctx, 'marketProviderRegistry')
  }

  register(provider: InstrumentProvider): () => void {
    if (this.providers.has(provider.id)) {
      throw new Error(`instrument provider already registered: ${provider.id}`)
    }
    this.providers.set(provider.id, provider)
    return () => {
      if (this.providers.get(provider.id) === provider) {
        this.providers.delete(provider.id)
      }
    }
  }

  list(): readonly InstrumentProvider[] {
    return [...this.providers.values()]
  }
}

export function createInstrumentProviderPlugin(provider: InstrumentProvider): Plugin {
  return {
    name: `market-provider-${provider.id}`,
    inject: ['marketProviderRegistry'],
    apply(ctx: Context) {
      ctx.effect(() => ctx.marketProviderRegistry.register(provider))
    },
  }
}

export interface MountedProvider {
  dispose(): Promise<void>
}

export async function mountInstrumentProvider(
  ctx: Context,
  provider: InstrumentProvider,
): Promise<MountedProvider> {
  const fiber: Fiber = ctx.plugin(createInstrumentProviderPlugin(provider))
  await fiber.await()
  return { dispose: () => fiber.dispose() }
}

export type { InstrumentProvider } from '@market-cli/core'
