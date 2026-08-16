import { randomUUID } from 'node:crypto'

import { Service, type Context } from '@deepseek-ai/cordis'
import Fastify, { type FastifyInstance } from 'fastify'

import {
  buildInstrumentCatalog,
  type CatalogInstrument,
  type InstrumentCapability,
  type InstrumentSearchContext,
  type InstrumentType,
  searchInstrumentCatalog,
} from '@market-cli/core'
import type { MarketProviderRegistry } from '@market-cli/cordis-runtime'

declare module '@deepseek-ai/cordis' {
  interface Context {
    marketHttp: MarketHttpService
    marketProviderRegistry: MarketProviderRegistry
  }
}

interface InstrumentRecord {
  instrument_id: string
  instrument_type: CatalogInstrument['type']
  market: CatalogInstrument['market']
  name: string
  symbol: string
  venue: string | null
  publisher: string | null
  currency: string
  status: CatalogInstrument['status']
  aliases: readonly string[]
  capabilities: readonly string[]
}

function toInstrumentRecord(instrument: CatalogInstrument): InstrumentRecord {
  return {
    instrument_id: instrument.instrumentId,
    instrument_type: instrument.type,
    market: instrument.market,
    name: instrument.name,
    symbol: instrument.symbol,
    venue: instrument.venue ?? null,
    publisher: instrument.publisher ?? null,
    currency: instrument.currency,
    status: instrument.status,
    aliases: [...(instrument.aliases ?? [])],
    capabilities: [...instrument.capabilities].sort(),
  }
}

export class MarketHttpService extends Service {
  static inject = ['marketProviderRegistry']

  private readonly app: FastifyInstance
  private address: string | undefined

  constructor(ctx: Context) {
    super(ctx, 'marketHttp')
    this.app = Fastify({ logger: false })

    const loadCatalog = async () => {
      const providers = ctx.marketProviderRegistry.list()
      const fetchedAt = new Date().toISOString()
      const groups = await Promise.all(
        providers.map(async (provider) => ({
          provider: provider.id,
          instruments: await provider.listInstruments(),
        })),
      )
      return {
        instruments: buildInstrumentCatalog(groups),
        sources: groups.map((group) => ({
          provider: group.provider,
          fetched_at: fetchedAt,
        })),
      }
    }

    const meta = (sources: readonly { provider: string; fetched_at: string }[]) => ({
      request_id: `req_${randomUUID()}`,
      generated_at: new Date().toISOString(),
      partial: false,
      sources,
      warnings: [],
    })

    this.app.get<{
      Querystring: {
        instrument_type?: InstrumentType
        venue?: string
        publisher?: string
        status?: string
        capability?: InstrumentCapability
        limit?: string
        cursor?: string
      }
    }>('/v1/instruments', async (request, reply) => {
      const catalog = await loadCatalog()
      const filtered = catalog.instruments.filter((instrument) => {
        if (
          request.query.instrument_type &&
          instrument.type !== request.query.instrument_type
        ) {
          return false
        }
        if (request.query.venue && instrument.venue !== request.query.venue) return false
        if (
          request.query.publisher &&
          instrument.publisher !== request.query.publisher
        ) {
          return false
        }
        if (request.query.status && instrument.status !== request.query.status) return false
        if (
          request.query.capability &&
          !instrument.capabilities.includes(request.query.capability)
        ) {
          return false
        }
        return true
      })
      const parsedLimit = Number.parseInt(request.query.limit ?? '100', 10)
      const limit = Number.isFinite(parsedLimit)
        ? Math.min(Math.max(parsedLimit, 1), 1000)
        : 100
      let start = 0
      if (request.query.cursor) {
        const cursorId = Buffer.from(request.query.cursor, 'base64url').toString('utf8')
        const cursorIndex = filtered.findIndex(
          (instrument) => instrument.instrumentId === cursorId,
        )
        if (cursorIndex < 0) {
          return reply.code(400).send({
            type: 'https://market-cli.dev/problems/invalid-cursor',
            title: 'Invalid cursor',
            status: 400,
            code: 'INVALID_CURSOR',
            detail: 'The cursor does not identify an item in this result set.',
            retryable: false,
            request_id: `req_${randomUUID()}`,
          })
        }
        start = cursorIndex + 1
      }
      const pageItems = filtered.slice(start, start + limit)
      const hasMore = start + pageItems.length < filtered.length
      const nextCursor =
        hasMore && pageItems.length
          ? Buffer.from(pageItems.at(-1)!.instrumentId, 'utf8').toString('base64url')
          : null

      return {
        schema: 'market.instrument-list.v1',
        data: pageItems.map(toInstrumentRecord),
        page: { next_cursor: nextCursor },
        meta: meta(catalog.sources),
      }
    })

    this.app.get<{
      Params: { instrumentId: string }
    }>('/v1/instruments/:instrumentId', async (request, reply) => {
      const catalog = await loadCatalog()
      const instrument = catalog.instruments.find(
        (candidate) => candidate.instrumentId === request.params.instrumentId,
      )
      if (!instrument) {
        return reply.code(404).send({
          type: 'https://market-cli.dev/problems/instrument-not-found',
          title: 'Instrument not found',
          status: 404,
          code: 'INSTRUMENT_NOT_FOUND',
          detail: 'The requested instrument is not in the active catalog.',
          retryable: false,
          request_id: `req_${randomUUID()}`,
        })
      }
      return {
        schema: 'market.instrument.v1',
        data: {
          ...toInstrumentRecord(instrument),
          identifiers: instrument.identifiers,
        },
        meta: meta(catalog.sources),
      }
    })

    this.app.get<{
      Querystring: {
        q?: string
        instrument_type?: InstrumentType
        venue?: string
        publisher?: string
        capability?: InstrumentCapability
        limit?: string
      }
    }>('/v1/instrument-search', async (request, reply) => {
      if (!request.query.q?.trim()) {
        return reply.code(400).send({
          type: 'https://market-cli.dev/problems/invalid-request',
          title: 'Invalid request',
          status: 400,
          code: 'INVALID_REQUEST',
          detail: 'Query parameter q is required.',
          retryable: false,
          request_id: `req_${randomUUID()}`,
        })
      }
      const catalog = await loadCatalog()
      const context: InstrumentSearchContext = {
        instrumentType: request.query.instrument_type,
        venue: request.query.venue,
        publisher: request.query.publisher,
        capability: request.query.capability,
      }
      const parsedLimit = Number.parseInt(request.query.limit ?? '20', 10)
      const matches = searchInstrumentCatalog(
        catalog.instruments,
        request.query.q,
        context,
        Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 200) : 20,
      )
      return {
        schema: 'market.instrument-search.v1',
        data: matches.map((match) => ({
          ...toInstrumentRecord(match.instrument),
          match_type: match.matchType,
          score: match.score,
        })),
        page: { next_cursor: null },
        meta: meta(catalog.sources),
      }
    })

    this.app.post<{
      Body: {
        query?: string
        context?: {
          instrument_type?: InstrumentType
          venue?: string
          publisher?: string
          capability?: InstrumentCapability
        }
      }
    }>('/v1/instrument-resolve', async (request, reply) => {
      if (!request.body?.query?.trim()) {
        return reply.code(400).send({
          type: 'https://market-cli.dev/problems/invalid-request',
          title: 'Invalid request',
          status: 400,
          code: 'INVALID_REQUEST',
          detail: 'Request field query is required.',
          retryable: false,
          request_id: `req_${randomUUID()}`,
        })
      }
      const catalog = await loadCatalog()
      const searchContext: InstrumentSearchContext = {
        instrumentType: request.body.context?.instrument_type,
        venue: request.body.context?.venue,
        publisher: request.body.context?.publisher,
        capability: request.body.context?.capability,
      }
      const matches = searchInstrumentCatalog(
        catalog.instruments,
        request.body.query,
        searchContext,
      )
      const candidates = matches.map((match) => ({
        ...toInstrumentRecord(match.instrument),
        match_type: match.matchType,
        score: match.score,
      }))
      const topScore = matches[0]?.score
      const tied = matches.filter((match) => match.score === topScore)
      const exact = (matches[0]?.matchType ?? '').startsWith('exact_')
      const data =
        matches.length === 0
          ? { status: 'not_found', candidates: [] }
          : tied.length === 1 && exact
            ? { status: 'resolved', instrument: candidates[0], candidates: [] }
            : { status: 'ambiguous', candidates }
      return {
        schema: 'market.instrument-resolution.v1',
        data,
        meta: meta(catalog.sources),
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
