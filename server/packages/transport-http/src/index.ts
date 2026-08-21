import { randomUUID } from 'node:crypto'

import { Service, type Context } from '@deepseek-ai/cordis'
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify'

import {
  buildInstrumentCatalog,
  type CatalogInstrument,
  type InstrumentCapability,
  type InstrumentSearchContext,
  type InstrumentType,
  type BarInterval,
  type PriceAdjustment,
  ProviderError,
  ProviderRoutingError,
  retryProviderCall,
  routeInstrumentData,
  searchInstrumentCatalog,
} from '@market-cli/core'
import type {
  MarketCatalogStore,
  MarketProviderRegistry,
} from '@market-cli/cordis-runtime'

import { AdminAuth } from './admin-auth.js'
import { ApiKeyAuth } from './api-key-auth.js'
import { apiKeyDashboardHtml } from './api-key-dashboard.js'
import { dataBrowserDashboardHtml } from './data-browser-dashboard.js'
import { DataSyncManager } from './data-sync-manager.js'
import { dataSyncDashboardHtml } from './data-sync-dashboard.js'
import { ProviderHealthMonitor } from './provider-health.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    marketHttp: MarketHttpService
    marketProviderRegistry: MarketProviderRegistry
    marketCatalogStore: MarketCatalogStore
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
  static inject = ['marketProviderRegistry', 'marketCatalogStore']

  private readonly app: FastifyInstance
  private readonly healthMonitor: ProviderHealthMonitor
  private readonly dataSyncManager: DataSyncManager
  private readonly adminAuth: AdminAuth
  private readonly apiKeyAuth: ApiKeyAuth
  private address: string | undefined

  constructor(
    ctx: Context,
    private readonly config: {
      retryAttempts?: number
      requestTimeoutMs?: number
      healthCheckIntervalMs?: number
      healthCheckTimeoutMs?: number
      historyPath?: string
      adminUsername?: string
      adminPassword?: string
      adminCredentialsPath?: string
      apiKeysPath?: string
    } = {},
  ) {
    super(ctx, 'marketHttp')
    this.app = Fastify({ logger: false })

    this.app.setNotFoundHandler((_request, reply) => reply
      .code(404)
      .type('application/problem+json')
      .send({
        type: 'https://market-cli.dev/problems/route-not-found',
        title: 'Route not found',
        status: 404,
        code: 'ROUTE_NOT_FOUND',
        detail: 'The requested HTTP route does not exist.',
        retryable: false,
        request_id: `req_${randomUUID()}`,
      }))

    this.app.setErrorHandler((error, _request, reply) => {
      const normalized = error as { statusCode?: number; message?: string; stack?: string }
      const status = normalized.statusCode && normalized.statusCode >= 400 && normalized.statusCode < 500
        ? normalized.statusCode
        : 500
      if (status === 500) {
        process.stderr.write(`[market-http] ${normalized.stack ?? normalized.message ?? String(error)}\n`)
      }
      return reply
        .code(status)
        .type('application/problem+json')
        .send({
          type: `https://market-cli.dev/problems/${status === 500 ? 'internal-error' : 'invalid-request'}`,
          title: status === 500 ? 'Internal server error' : 'Invalid request',
          status,
          code: status === 500 ? 'INTERNAL_ERROR' : 'INVALID_REQUEST',
          detail: status === 500
            ? 'The server could not complete the request.'
            : (normalized.message ?? 'The request is invalid.'),
          retryable: status >= 500,
          request_id: `req_${randomUUID()}`,
        })
    })

    this.adminAuth = new AdminAuth({
      username: this.config.adminUsername,
      initialPassword: this.config.adminPassword,
      credentialsPath: this.config.adminCredentialsPath,
    })
    this.adminAuth.install(this.app)
    this.apiKeyAuth = new ApiKeyAuth(this.config.apiKeysPath)
    this.apiKeyAuth.install(this.app)

    const routingOptions = {
      retryAttempts: Math.max(this.config.retryAttempts ?? 2, 1),
      timeoutMs: Math.max(this.config.requestTimeoutMs ?? 10_000, 1),
    }
    this.healthMonitor = new ProviderHealthMonitor(
      () => ctx.marketProviderRegistry.list(),
      Math.max(this.config.healthCheckIntervalMs ?? 3_600_000, 0),
      Math.max(this.config.healthCheckTimeoutMs ?? routingOptions.timeoutMs, 1),
    )

    const loadCatalog = async () => {
      const providers = ctx.marketProviderRegistry.list()
      const results = await Promise.all(
        providers.map(async (provider) => {
          try {
            const result = await retryProviderCall({
              ...routingOptions,
              invoke: (signal) => provider.listInstruments(signal),
            })
            const fetchedAt = new Date().toISOString()
            await ctx.marketCatalogStore.writeProvider({
              provider: provider.id,
              instruments: result.value,
              fetchedAt,
            })
            return {
              ok: true as const,
              provider: provider.id,
              instruments: result.value,
              fetchedAt,
              stale: false,
            }
          } catch (error) {
            const normalized =
              error instanceof ProviderError
                ? error
                : new ProviderError(
                    'PROVIDER_ERROR',
                    'provider catalog request failed',
                    true,
                  )
            const stale = await ctx.marketCatalogStore.readProvider(provider.id)
            if (stale) {
              return {
                ok: true as const,
                provider: provider.id,
                instruments: stale.instruments,
                fetchedAt: stale.fetchedAt,
                stale: true,
                error: normalized,
              }
            }
            return { ok: false as const, provider: provider.id, error: normalized }
          }
        }),
      )
      const groups = results.filter((result) => result.ok)
      const failures = results.filter((result) => !result.ok)
      const staleGroups = groups.filter((result) => result.stale)
      return {
        instruments: buildInstrumentCatalog(groups),
        sources: groups.map((group) => ({
          provider: group.provider,
          fetched_at: group.fetchedAt,
          ...(group.stale ? { stale: true } : {}),
        })),
        partial: failures.length > 0 || staleGroups.length > 0,
        warnings: [
          ...failures.map(
            (failure) =>
              `provider ${failure.provider} failed: ${failure.error.code}`,
          ),
          ...staleGroups.map(
            (group) =>
              `provider ${group.provider} failed: ${group.error?.code}; using stale catalog`,
          ),
        ],
      }
    }

    const meta = (
      sources: readonly {
        provider: string
        fetched_at: string
        stale?: boolean
        upstream?: string
      }[],
      partial = false,
      warnings: readonly string[] = [],
    ) => ({
      request_id: `req_${randomUUID()}`,
      generated_at: new Date().toISOString(),
      partial,
      sources,
      warnings,
    })

    const sendRoutingProblem = (
      reply: FastifyReply,
      error: ProviderRoutingError,
    ) =>
      reply.code(error.retryable ? 503 : 422).type('application/problem+json').send({
        type: `https://market-cli.dev/problems/${error.code.toLowerCase().replaceAll('_', '-')}`,
        title: error.code === 'CAPABILITY_UNAVAILABLE'
          ? 'Capability unavailable'
          : 'Provider request failed',
        status: error.retryable ? 503 : 422,
        code: error.code,
        detail: error.message,
        retryable: error.retryable,
        request_id: `req_${randomUUID()}`,
      })

    this.dataSyncManager = new DataSyncManager({
      databasePath: this.config.historyPath ?? ':memory:',
      loadInstruments: async () => (await loadCatalog()).instruments,
      loadBars: async (instrument, request) => {
        const result = await routeInstrumentData({
          providers: ctx.marketProviderRegistry.list(),
          instrument,
          capability: 'bars',
          ...routingOptions,
          supports: (provider) => typeof provider.getBars === 'function',
          invoke: (provider, providerSymbol, signal) => provider.getBars?.({
            providerSymbol,
            signal,
            interval: '1d',
            start: request.start,
            end: request.end,
            adjustment: request.adjustment,
          }),
        })
        return {
          provider: result.provider,
          upstream: result.value[0]?.source,
          bars: result.value,
        }
      },
    })

    const dataSourcesResponse = async () => ({
      schema: 'market.data-source-list.v1',
      data: [
        ...await this.dataSyncManager.localDataSources(),
        ...this.healthMonitor.list(),
      ],
      schedule: this.healthMonitor.schedule,
      generated_at: new Date().toISOString(),
    })

    this.app.get('/admin', async (_request, reply) => reply
      .header('cache-control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(dataBrowserDashboardHtml))

    this.app.get('/admin/data-sources', async (_request, reply) => reply.redirect('/admin#data-sources'))

    this.app.get('/admin/data-sync', async (_request, reply) => reply
      .header('cache-control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(dataSyncDashboardHtml))

    this.app.get('/admin/data-browser', async (_request, reply) => reply.redirect('/admin'))

    this.app.get('/admin/api-keys', async (_request, reply) => reply
      .header('cache-control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(apiKeyDashboardHtml))

    this.app.get('/v1/api-keys', async () => ({
      schema: 'market.api-key-list.v1',
      data: this.apiKeyAuth.list(),
    }))

    this.app.post<{ Body: { name?: string } }>('/v1/api-keys', async (request, reply) => {
      try {
        const created = await this.apiKeyAuth.create(request.body?.name ?? '')
        return reply.code(201).send({ schema: 'market.api-key-created.v1', data: created })
      } catch (error) {
        return reply.code(400).type('application/problem+json').send({
          type: 'https://market-cli.dev/problems/invalid-api-key-name',
          title: 'Invalid API key name', status: 400, code: 'INVALID_API_KEY_NAME',
          detail: error instanceof Error ? error.message : 'API key name is invalid.', retryable: false,
          request_id: `req_${randomUUID()}`,
        })
      }
    })

    this.app.delete<{ Params: { id: string } }>('/v1/api-keys/:id', async (request, reply) => {
      if (!await this.apiKeyAuth.revoke(request.params.id)) {
        return reply.code(404).type('application/problem+json').send({
          type: 'https://market-cli.dev/problems/api-key-not-found', title: 'API key not found',
          status: 404, code: 'API_KEY_NOT_FOUND', detail: 'The API key does not exist.', retryable: false,
          request_id: `req_${randomUUID()}`,
        })
      }
      return reply.code(204).send()
    })

    this.app.get<{
      Querystring: { q?: string; type?: string; limit?: string; offset?: string }
    }>('/v1/local-data/instruments', async (request, reply) => {
      const limit = Number(request.query.limit ?? 30)
      const offset = Number(request.query.offset ?? 0)
      const instrumentType = request.query.type
      if (
        !Number.isInteger(limit) || limit < 1 || limit > 100 ||
        !Number.isInteger(offset) || offset < 0 ||
        (instrumentType !== undefined && instrumentType !== 'equity' && instrumentType !== 'index') ||
        (request.query.q?.length ?? 0) > 100
      ) {
        return reply.code(400).type('application/problem+json').send({
          type: 'https://market-cli.dev/problems/invalid-local-data-query',
          title: 'Invalid local data query',
          status: 400,
          code: 'INVALID_LOCAL_DATA_QUERY',
          detail: 'q, type, limit, or offset is invalid.',
          retryable: false,
          request_id: `req_${randomUUID()}`,
        })
      }
      const [result, status] = await Promise.all([
        this.dataSyncManager.browseInstruments({
          query: request.query.q,
          instrumentType,
          limit,
          offset,
        }),
        this.dataSyncManager.status(),
      ])
      return {
        schema: 'market.local-instrument-list.v1',
        data: result.items,
        page: { total: result.total, limit, offset },
        meta: { storage: status.storage, generated_at: new Date().toISOString() },
      }
    })

    this.app.get<{
      Params: { instrumentId: string }
      Querystring: { limit?: string }
    }>('/v1/local-data/instruments/:instrumentId/bars', async (request, reply) => {
      const limit = Number(request.query.limit ?? 20)
      if (!Number.isInteger(limit) || limit < 1 || limit > 250) {
        return reply.code(400).type('application/problem+json').send({
          type: 'https://market-cli.dev/problems/invalid-local-bar-query',
          title: 'Invalid local bar query',
          status: 400,
          code: 'INVALID_LOCAL_BAR_QUERY',
          detail: 'limit must be an integer between 1 and 250.',
          retryable: false,
          request_id: `req_${randomUUID()}`,
        })
      }
      return {
        schema: 'market.local-bar-list.v1',
        data: await this.dataSyncManager.browseBars(request.params.instrumentId, limit),
        meta: { generated_at: new Date().toISOString() },
      }
    })

    this.app.get('/v1/data-sync', async (_request, reply) => {
      reply.header('cache-control', 'no-store')
      return {
        schema: 'market.data-sync-status.v1',
        data: await this.dataSyncManager.status(),
        generated_at: new Date().toISOString(),
      }
    })

    this.app.post<{
      Body: {
        instrument_types?: InstrumentType[]
        start?: string
        end?: string
        adjustment?: PriceAdjustment
        limit?: number
        delay_ms?: number
      }
    }>('/v1/data-sync/runs', async (request, reply) => {
      const instrumentTypes = request.body?.instrument_types
      const start = request.body?.start
      const end = request.body?.end
      const adjustment = request.body?.adjustment ?? 'none'
      const limit = request.body?.limit
      const delayMs = request.body?.delay_ms ?? 0
      if (
        !Array.isArray(instrumentTypes) ||
        instrumentTypes.some((value) => value !== 'equity' && value !== 'index') ||
        typeof start !== 'string' ||
        typeof end !== 'string' ||
        !['none', 'forward', 'backward'].includes(adjustment) ||
        (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 20_000)) ||
        !Number.isInteger(delayMs) || delayMs < 0 || delayMs > 10_000
      ) {
        return reply.code(400).type('application/problem+json').send({
          type: 'https://market-cli.dev/problems/invalid-data-sync-request',
          title: 'Invalid data sync request',
          status: 400,
          code: 'INVALID_DATA_SYNC_REQUEST',
          detail: 'instrument_types, start, end, adjustment, or limit is invalid.',
          retryable: false,
          request_id: `req_${randomUUID()}`,
        })
      }
      try {
        const run = await this.dataSyncManager.start({
          instrumentTypes,
          start,
          end,
          adjustment,
          ...(limit === undefined ? {} : { limit }),
          delayMs,
        })
        return reply.code(202).send({
          schema: 'market.data-sync-run.v1',
          data: run,
        })
      } catch (error) {
        const code = error instanceof Error ? error.message : 'DATA_SYNC_START_FAILED'
        const conflict = code === 'DATA_SYNC_ALREADY_RUNNING'
        return reply.code(conflict ? 409 : 400).type('application/problem+json').send({
          type: `https://market-cli.dev/problems/${code.toLowerCase().replaceAll('_', '-')}`,
          title: conflict ? 'Data sync already running' : 'Data sync could not start',
          status: conflict ? 409 : 400,
          code,
          detail: conflict ? 'Only one data sync run can execute at a time.' : 'The data sync request is invalid.',
          retryable: false,
          request_id: `req_${randomUUID()}`,
        })
      }
    })

    this.app.post('/v1/data-sync/cancel', async (_request, reply) => {
      const run = this.dataSyncManager.cancel()
      if (!run) {
        return reply.code(409).type('application/problem+json').send({
          type: 'https://market-cli.dev/problems/data-sync-not-running',
          title: 'Data sync is not running',
          status: 409,
          code: 'DATA_SYNC_NOT_RUNNING',
          detail: 'There is no active data sync run to cancel.',
          retryable: false,
          request_id: `req_${randomUUID()}`,
        })
      }
      return reply.code(202).send({ schema: 'market.data-sync-run.v1', data: run })
    })

    this.app.post('/v1/data-sync/resume', async (_request, reply) => {
      try {
        const run = await this.dataSyncManager.resume()
        return reply.code(202).send({ schema: 'market.data-sync-run.v1', data: run })
      } catch (error) {
        const code = error instanceof Error ? error.message : 'DATA_SYNC_RESUME_FAILED'
        const detail = code === 'DATA_SYNC_ALREADY_RUNNING'
          ? 'Only one data sync run can execute at a time.'
          : code === 'DATA_SYNC_CATALOG_CHANGED'
            ? 'The instrument catalog changed since the previous run; start a new sync instead.'
            : 'There is no interrupted data sync run to resume.'
        return reply.code(409).type('application/problem+json').send({
          type: `https://market-cli.dev/problems/${code.toLowerCase().replaceAll('_', '-')}`,
          title: 'Data sync could not resume',
          status: 409,
          code,
          detail,
          retryable: false,
          request_id: `req_${randomUUID()}`,
        })
      }
    })

    this.app.put<{
      Body: {
        enabled?: boolean
        time?: string
        instrument_types?: InstrumentType[]
        lookback_days?: number
        adjustment?: PriceAdjustment
        delay_ms?: number
      }
    }>('/v1/data-sync/schedule', async (request, reply) => {
      const body = request.body
      const enabled = body?.enabled ?? false
      const time = body?.time
      const instrumentTypes = body?.instrument_types
      const lookbackDays = body?.lookback_days
      const adjustment = body?.adjustment
      const delayMs = body?.delay_ms
      if (
        typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time) ||
        !Array.isArray(instrumentTypes) || instrumentTypes.length === 0 ||
        instrumentTypes.some((type) => type !== 'equity' && type !== 'index') ||
        !Number.isInteger(lookbackDays) || (lookbackDays ?? 0) < 1 || (lookbackDays ?? 0) > 90 ||
        adjustment === undefined || !['none', 'forward', 'backward'].includes(adjustment) ||
        !Number.isInteger(delayMs) || (delayMs ?? -1) < 0 || (delayMs ?? 0) > 10_000
      ) {
        return reply.code(400).type('application/problem+json').send({
          type: 'https://market-cli.dev/problems/invalid-data-sync-schedule',
          title: 'Invalid data sync schedule', status: 400,
          code: 'INVALID_DATA_SYNC_SCHEDULE',
          detail: 'enabled, time, instrument_types, lookback_days (1..90), adjustment, or delay_ms is invalid.',
          retryable: false, request_id: `req_${randomUUID()}`,
        })
      }
      const schedule = await this.dataSyncManager.updateSchedule({
        enabled, time, instrument_types: instrumentTypes, lookback_days: lookbackDays!,
        adjustment, delay_ms: delayMs!,
      })
      return { schema: 'market.data-sync-schedule.v1', data: schedule }
    })

    this.app.get('/v1/data-sources', async (_request, reply) => {
      reply.header('cache-control', 'no-store')
      return await dataSourcesResponse()
    })

    this.app.post('/v1/data-sources/check', async (_request, reply) => {
      await this.healthMonitor.checkAll()
      reply.header('cache-control', 'no-store')
      return await dataSourcesResponse()
    })

    this.app.put<{
      Body: { enabled?: boolean; interval_seconds?: number }
    }>('/v1/data-sources/schedule', async (request, reply) => {
      const enabled = request.body?.enabled ?? true
      if (!enabled) {
        this.healthMonitor.setIntervalMs(0)
      } else {
        const intervalSeconds = request.body?.interval_seconds
        if (
          !Number.isInteger(intervalSeconds) ||
          (intervalSeconds ?? 0) < 3_600 ||
          (intervalSeconds ?? 0) > 86_400
        ) {
          return reply.code(400).type('application/problem+json').send({
            type: 'https://market-cli.dev/problems/invalid-health-check-interval',
            title: 'Invalid health check interval',
            status: 400,
            code: 'INVALID_HEALTH_CHECK_INTERVAL',
            detail: 'interval_seconds must be an integer between 3600 and 86400.',
            retryable: false,
            request_id: `req_${randomUUID()}`,
          })
        }
        this.healthMonitor.setIntervalMs(intervalSeconds! * 1_000)
      }
      reply.header('cache-control', 'no-store')
      return await dataSourcesResponse()
    })

    this.app.get('/v1/health', async () => {
      const providers = ctx.marketProviderRegistry.list().length
      return {
        schema: 'market.health.v1',
        data: {
          status: providers > 0 ? 'ok' : 'degraded',
          providers,
          version: '1.0.0',
          uptime_seconds: Math.floor(process.uptime()),
        },
      }
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
          return reply.code(400).type('application/problem+json').send({
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
        meta: meta(catalog.sources, catalog.partial, catalog.warnings),
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
        return reply.code(404).type('application/problem+json').send({
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
        meta: meta(catalog.sources, catalog.partial, catalog.warnings),
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
        return reply.code(400).type('application/problem+json').send({
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
        meta: meta(catalog.sources, catalog.partial, catalog.warnings),
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
        return reply.code(400).type('application/problem+json').send({
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
        meta: meta(catalog.sources, catalog.partial, catalog.warnings),
      }
    })

    this.app.get<{
      Params: { instrumentId: string }
    }>('/v1/instruments/:instrumentId/quote', async (request, reply) => {
      const catalog = await loadCatalog()
      const instrument = catalog.instruments.find(
        (candidate) => candidate.instrumentId === request.params.instrumentId,
      )
      if (!instrument) {
        return reply.code(404).type('application/problem+json').send({
          type: 'https://market-cli.dev/problems/instrument-not-found',
          title: 'Instrument not found',
          status: 404,
          code: 'INSTRUMENT_NOT_FOUND',
          detail: 'The requested instrument is not in the active catalog.',
          retryable: false,
          request_id: `req_${randomUUID()}`,
        })
      }
      const localQuote = await this.dataSyncManager.readQuote(instrument.instrumentId)
      if (localQuote) {
        const observedAt = new Date().toISOString()
        return {
          schema: 'market.quote.v1',
          data: {
            instrument_id: instrument.instrumentId,
            symbol: instrument.symbol,
            name: instrument.name,
            venue: instrument.venue ?? null,
            publisher: instrument.publisher ?? null,
            currency: localQuote.currency,
            market_time: localQuote.marketTime,
            observed_at: observedAt,
            market_status: 'closed',
            last: localQuote.last,
            open: localQuote.open,
            high: localQuote.high,
            low: localQuote.low,
            previous_close: localQuote.previousClose,
            volume: localQuote.volume,
            turnover: localQuote.turnover,
          },
          meta: meta([{
            provider: 'local-duckdb',
            upstream: 'local',
            fetched_at: observedAt,
          }]),
        }
      }
      try {
        const result = await routeInstrumentData({
          providers: ctx.marketProviderRegistry.list(),
          instrument,
          capability: 'quote',
          ...routingOptions,
          supports: (provider) => typeof provider.getQuote === 'function',
          invoke: (provider, providerSymbol, signal) =>
            provider.getQuote?.({ providerSymbol, signal }),
        })
        const quote = result.value
        return {
          schema: 'market.quote.v1',
          data: {
            instrument_id: instrument.instrumentId,
            symbol: instrument.symbol,
            name: instrument.name,
            venue: instrument.venue ?? null,
            publisher: instrument.publisher ?? null,
            currency: quote.currency,
            market_time: quote.marketTime ?? null,
            observed_at: result.observedAt,
            market_status: quote.marketStatus,
            last: quote.last,
            open: quote.open,
            high: quote.high,
            low: quote.low,
            previous_close: quote.previousClose,
            volume: quote.volume,
            turnover: quote.turnover,
          },
          meta: meta([
            {
              provider: result.provider,
              fetched_at: result.observedAt,
              ...(quote.source ? { upstream: quote.source } : {}),
            },
          ]),
        }
      } catch (error) {
        if (error instanceof ProviderRoutingError) {
          return sendRoutingProblem(reply, error)
        }
        throw error
      }
    })

    this.app.get<{
      Params: { instrumentId: string }
      Querystring: {
        interval?: BarInterval
        start?: string
        end?: string
        adjustment?: PriceAdjustment
      }
    }>('/v1/instruments/:instrumentId/bars', async (request, reply) => {
      const catalog = await loadCatalog()
      const instrument = catalog.instruments.find(
        (candidate) => candidate.instrumentId === request.params.instrumentId,
      )
      if (!instrument) {
        return reply.code(404).type('application/problem+json').send({
          type: 'https://market-cli.dev/problems/instrument-not-found',
          title: 'Instrument not found',
          status: 404,
          code: 'INSTRUMENT_NOT_FOUND',
          detail: 'The requested instrument is not in the active catalog.',
          retryable: false,
          request_id: `req_${randomUUID()}`,
        })
      }
      const interval = request.query.interval ?? '1d'
      const adjustment = request.query.adjustment ?? 'none'
      if (interval === '1d') {
        const localBars = await this.dataSyncManager.readBars({
          instrumentId: instrument.instrumentId,
          adjustment,
          start: request.query.start,
          end: request.query.end,
        })
        if (localBars) {
          const fetchedAt = new Date().toISOString()
          return {
            schema: 'market.bar-list.v1',
            data: localBars.map((bar) => ({
              instrument_id: instrument.instrumentId,
              interval: bar.interval,
              trading_date: bar.tradingDate,
              period_start: bar.periodStart,
              period_end: bar.periodEnd,
              currency: bar.currency,
              open: bar.open,
              high: bar.high,
              low: bar.low,
              close: bar.close,
              volume: bar.volume,
              turnover: bar.turnover,
              adjustment: bar.adjustment,
              complete: bar.complete,
            })),
            page: { next_cursor: null },
            meta: meta([{
              provider: 'local-duckdb',
              upstream: 'local',
              fetched_at: fetchedAt,
            }]),
          }
        }
      }
      try {
        const result = await routeInstrumentData({
          providers: ctx.marketProviderRegistry.list(),
          instrument,
          capability: 'bars',
          ...routingOptions,
          supports: (provider) => typeof provider.getBars === 'function',
          invoke: (provider, providerSymbol, signal) =>
            provider.getBars?.({
              providerSymbol,
              signal,
              interval,
              start: request.query.start,
              end: request.query.end,
              adjustment,
            }),
        })
        const cacheWarnings: string[] = []
        if (interval === '1d') {
          try {
            await this.dataSyncManager.storeBars(instrument, {
              provider: result.provider,
              upstream: result.value[0]?.source,
              bars: result.value,
            }, {
              start: request.query.start,
              end: request.query.end,
              adjustment,
            })
          } catch {
            cacheWarnings.push('local DuckDB cache write failed')
          }
        }
        return {
          schema: 'market.bar-list.v1',
          data: [...result.value]
            .sort((left, right) => left.periodStart.localeCompare(right.periodStart))
            .map((bar) => ({
              instrument_id: instrument.instrumentId,
              interval: bar.interval,
              trading_date: bar.tradingDate,
              period_start: bar.periodStart,
              period_end: bar.periodEnd,
              currency: bar.currency,
              open: bar.open,
              high: bar.high,
              low: bar.low,
              close: bar.close,
              volume: bar.volume,
              turnover: bar.turnover,
              adjustment: bar.adjustment,
              complete: bar.complete,
            })),
          page: { next_cursor: null },
          meta: meta([
            {
              provider: result.provider,
              fetched_at: result.observedAt,
              ...(result.value[0]?.source ? { upstream: result.value[0].source } : {}),
            },
          ], false, cacheWarnings),
        }
      } catch (error) {
        if (error instanceof ProviderRoutingError) {
          return sendRoutingProblem(reply, error)
        }
        throw error
      }
    })

    this.app.get<{
      Params: { instrumentId: string }
      Querystring: { as_of?: string }
    }>(
      '/v1/indices/:instrumentId/constituents',
      async (request, reply) => {
        const catalog = await loadCatalog()
        const instrument = catalog.instruments.find(
          (candidate) => candidate.instrumentId === request.params.instrumentId,
        )
        if (!instrument || instrument.type !== 'index') {
          return reply.code(404).type('application/problem+json').send({
            type: 'https://market-cli.dev/problems/instrument-not-found',
            title: 'Index not found',
            status: 404,
            code: 'INSTRUMENT_NOT_FOUND',
            detail: 'The requested index is not in the active catalog.',
            retryable: false,
            request_id: `req_${randomUUID()}`,
          })
        }
        try {
          const result = await routeInstrumentData({
            providers: ctx.marketProviderRegistry.list(),
            instrument,
            capability: 'constituents',
            ...routingOptions,
            supports: (provider) =>
              typeof provider.getConstituents === 'function',
            invoke: (provider, providerSymbol, signal) =>
              provider.getConstituents?.({
                providerSymbol,
                signal,
                asOf: request.query.as_of,
              }),
          })
          const rows = result.value.map((membership) => {
            const constituent = catalog.instruments.find((candidate) =>
              candidate.identifiers.some(
                (identifier) =>
                  identifier.provider === result.provider &&
                  identifier.value === membership.constituentProviderSymbol,
              ),
            )
            if (!constituent) {
              throw new ProviderRoutingError(
                'UNMAPPED_CONSTITUENT',
                'provider returned a constituent outside the canonical catalog',
                false,
              )
            }
            return {
              index_id: instrument.instrumentId,
              constituent_id: constituent.instrumentId,
              constituent_symbol: constituent.symbol,
              constituent_name: constituent.name,
              constituent_venue: constituent.venue ?? null,
              as_of_date: membership.asOfDate,
              effective_from: membership.effectiveFrom,
              effective_to: membership.effectiveTo,
              weight_ratio: membership.weightRatio,
              rank: membership.rank,
            }
          })
          return {
            schema: 'market.index-constituent-list.v1',
            data: rows.sort(
              (left, right) =>
                (left.rank ?? Number.MAX_SAFE_INTEGER) -
                  (right.rank ?? Number.MAX_SAFE_INTEGER) ||
                left.constituent_id.localeCompare(right.constituent_id),
            ),
            page: { next_cursor: null },
            meta: meta([
              { provider: result.provider, fetched_at: result.observedAt },
            ]),
          }
        } catch (error) {
          if (error instanceof ProviderRoutingError) {
            return sendRoutingProblem(reply, error)
          }
          throw error
        }
      },
    )

    ctx.effect(() => () => this.close())
  }

  async listen(host = '127.0.0.1', port = 0): Promise<string> {
    if (!this.address) {
      await this.adminAuth.initializeForListen()
      await this.apiKeyAuth.initializeForListen()
      this.address = await this.app.listen({ host, port })
    }
    return this.address
  }

  async close(): Promise<void> {
    this.healthMonitor.close()
    await this.dataSyncManager.close()
    if (!this.address) return
    this.address = undefined
    await this.app.close()
  }
}
