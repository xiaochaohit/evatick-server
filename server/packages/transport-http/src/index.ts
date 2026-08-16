import { randomUUID } from 'node:crypto'

import { Service, type Context } from '@deepseek-ai/cordis'
import Fastify, { type FastifyInstance } from 'fastify'

import type { Instrument } from '@market-cli/core'
import type { MarketProviderRegistry } from '@market-cli/cordis-runtime'

declare module '@deepseek-ai/cordis' {
  interface Context {
    marketHttp: MarketHttpService
    marketProviderRegistry: MarketProviderRegistry
  }
}

interface InstrumentRecord {
  instrument_id: string
  instrument_type: Instrument['type']
  name: string
  symbol: string
  venue: string | null
  publisher: string | null
  currency: string
  status: Instrument['status']
}

function toInstrumentRecord(instrument: Instrument): InstrumentRecord {
  return {
    instrument_id: instrument.instrumentId,
    instrument_type: instrument.type,
    name: instrument.name,
    symbol: instrument.symbol,
    venue: instrument.venue ?? null,
    publisher: instrument.publisher ?? null,
    currency: instrument.currency,
    status: instrument.status,
  }
}

export class MarketHttpService extends Service {
  static inject = ['marketProviderRegistry']

  private readonly app: FastifyInstance
  private address: string | undefined

  constructor(ctx: Context) {
    super(ctx, 'marketHttp')
    this.app = Fastify({ logger: false })

    this.app.get('/v1/instruments', async () => {
      const providers = ctx.marketProviderRegistry.list()
      const fetchedAt = new Date().toISOString()
      const groups = await Promise.all(
        providers.map(async (provider) => ({
          provider: provider.id,
          instruments: await provider.listInstruments(),
        })),
      )

      return {
        schema: 'market.instrument-list.v1',
        data: groups.flatMap((group) => group.instruments.map(toInstrumentRecord)),
        page: { next_cursor: null },
        meta: {
          request_id: `req_${randomUUID()}`,
          generated_at: new Date().toISOString(),
          partial: false,
          sources: groups.map((group) => ({
            provider: group.provider,
            fetched_at: fetchedAt,
          })),
          warnings: [],
        },
      }
    })

    ctx.effect(() => () => this.close())
  }

  async listen(): Promise<string> {
    if (!this.address) {
      this.address = await this.app.listen({ host: '127.0.0.1', port: 0 })
    }
    return this.address
  }

  async close(): Promise<void> {
    if (!this.address) return
    this.address = undefined
    await this.app.close()
  }
}
