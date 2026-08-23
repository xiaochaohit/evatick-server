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
} from '@evatick/core'
import type {
  MarketCatalogStore,
  MarketProviderRegistry,
} from '@evatick/cordis-runtime'

import { AdminAuth } from './admin-auth.js'
import { ApiKeyAuth } from './api-key-auth.js'
import { apiKeyDashboardHtml } from './api-key-dashboard.js'
import { dataBrowserDashboardHtml } from './data-browser-dashboard.js'
import { dataSourceDashboardHtml } from './data-source-dashboard.js'
import { DataSourcePreferences } from './data-source-preferences.js'
import { DataSyncManager } from './data-sync-manager.js'
import { dataSyncDashboardHtml } from './data-sync-dashboard.js'
import { ProviderHealthMonitor } from './provider-health.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    evaHttp: EvaHttpService
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

export class EvaHttpService extends Service {
  static inject = ['marketProviderRegistry', 'marketCatalogStore']

  private readonly app: FastifyInstance
  private readonly healthMonitor: ProviderHealthMonitor
  private readonly dataSourcePreferences: DataSourcePreferences
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
      dataSourcePreferencesPath?: string
    } = {},
  ) {
    super(ctx, 'evaHttp')
    this.app = Fastify({ logger: false })

    this.app.setNotFoundHandler((_request, reply) => reply
      .code(404)
      .type('application/problem+json')
      .send({
        type: 'urn:eva:problem:route-not-found',
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
        process.stderr.write(`[eva-http] ${normalized.stack ?? normalized.message ?? String(error)}\n`)
      }
      return reply
        .code(status)
        .type('application/problem+json')
        .send({
          type: `urn:eva:problem:${status === 500 ? 'internal-error' : 'invalid-request'}`,
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
    this.dataSourcePreferences = new DataSourcePreferences(
      () => ctx.marketProviderRegistry.list(),
      this.config.dataSourcePreferencesPath,
    )

    const providersFor = (instrument: Pick<CatalogInstrument, 'type'>) =>
      this.dataSourcePreferences.orderProviders(instrument.type)

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
        type: `urn:eva:problem:${error.code.toLowerCase().replaceAll('_', '-')}`,
        title: error.code === 'CAPABILITY_UNAVAILABLE'
          ? 'Capability unavailable'
          : 'Provider request failed',
        status: error.retryable ? 503 : 422,
        code: error.code,
        detail: error.message,
        retryable: error.retryable,
        request_id: `req_${randomUUID()}`,
      })

    const loadAdjustmentFactors = async (instrument: CatalogInstrument) => {
      if (instrument.type !== 'equity' ||
        !ctx.marketProviderRegistry.list().some((provider) =>
          typeof provider.getAdjustmentFactors === 'function')) {
        return null
      }
      const result = await routeInstrumentData({
        providers: await providersFor(instrument),
        instrument,
        capability: 'bars',
        ...routingOptions,
        supports: (provider) => typeof provider.getAdjustmentFactors === 'function',
        invoke: (provider, providerSymbol, signal) =>
          provider.getAdjustmentFactors?.({ providerSymbol, signal }),
      })
      return {
        provider: result.provider,
        upstream: result.value[0]?.source,
        factors: result.value,
        asOfDate: new Date().toLocaleDateString('sv-SE', {
          timeZone: 'Asia/Shanghai',
        }),
      }
    }

    this.dataSyncManager = new DataSyncManager({
      databasePath: this.config.historyPath ?? ':memory:',
      loadInstruments: async () => (await loadCatalog()).instruments,
      loadBars: async (instrument, request) => {
        const result = await routeInstrumentData({
          providers: await providersFor(instrument),
          instrument,
          capability: 'bars',
          ...routingOptions,
          supports: (provider) => typeof provider.getBars === 'function',
          invoke: (provider, providerSymbol, signal) => provider.getBars?.({
            providerSymbol,
            signal,
            interval: request.interval,
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
      loadAdjustmentFactors,
    })

    const dataSourcesResponse = async () => {
      const routing = await this.dataSourcePreferences.list()
      return {
        schema: 'eva.data-source-list.v1',
        data: [
          ...await this.dataSyncManager.localDataSources(),
          ...this.healthMonitor.list(),
        ],
        routing,
        schedule: this.healthMonitor.schedule,
        generated_at: new Date().toISOString(),
      }
    }

    this.app.get('/admin', async (_request, reply) => reply
      .header('cache-control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(dataBrowserDashboardHtml))

    this.app.get('/admin/data-sources', async (_request, reply) => reply
      .header('cache-control', 'no-store')
      .type('text/html; charset=utf-8')
      .send(dataSourceDashboardHtml))

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
      schema: 'eva.api-key-list.v1',
      access_mode: this.apiKeyAuth.accessMode,
      data: this.apiKeyAuth.list(),
    }))

    this.app.put<{ Body: { access_mode?: string } }>('/v1/api-keys/access-mode', async (request, reply) => {
      const accessMode = request.body?.access_mode
      if (accessMode !== 'api-key' && accessMode !== 'public') {
        return reply.code(400).type('application/problem+json').send({
          type: 'urn:eva:problem:invalid-api-access-mode',
          title: 'Invalid API access mode', status: 400, code: 'INVALID_API_ACCESS_MODE',
          detail: 'access_mode must be either api-key or public.', retryable: false,
          request_id: `req_${randomUUID()}`,
        })
      }
      await this.apiKeyAuth.setAccessMode(accessMode)
      return { schema: 'eva.api-access-mode.v1', data: { access_mode: accessMode } }
    })

    this.app.post<{ Body: { name?: string } }>('/v1/api-keys', async (request, reply) => {
      try {
        const created = await this.apiKeyAuth.create(request.body?.name ?? '')
        return reply.code(201).send({ schema: 'eva.api-key-created.v1', data: created })
      } catch (error) {
        return reply.code(400).type('application/problem+json').send({
          type: 'urn:eva:problem:invalid-api-key-name',
          title: 'Invalid API key name', status: 400, code: 'INVALID_API_KEY_NAME',
          detail: error instanceof Error ? error.message : 'API key name is invalid.', retryable: false,
          request_id: `req_${randomUUID()}`,
        })
      }
    })

    this.app.get<{ Params: { id: string } }>('/v1/api-keys/:id/secret', async (request, reply) => {
      const revealed = await this.apiKeyAuth.reveal(request.params.id)
      if (!revealed.found) {
        return reply.code(404).type('application/problem+json').send({
          type: 'urn:eva:problem:api-key-not-found', title: 'API key not found',
          status: 404, code: 'API_KEY_NOT_FOUND', detail: 'The API key does not exist.', retryable: false,
          request_id: `req_${randomUUID()}`,
        })
      }
      if (!revealed.key) {
        return reply.code(409).type('application/problem+json').send({
          type: 'urn:eva:problem:api-key-not-recoverable', title: 'API key cannot be revealed',
          status: 409, code: 'API_KEY_NOT_RECOVERABLE',
          detail: 'This key was created before repeat viewing was supported. Revoke and recreate it.', retryable: false,
          request_id: `req_${randomUUID()}`,
        })
      }
      return reply.header('cache-control', 'no-store').send({
        schema: 'eva.api-key-secret.v1', data: { key: revealed.key },
      })
    })

    this.app.delete<{ Params: { id: string } }>('/v1/api-keys/:id', async (request, reply) => {
      if (!await this.apiKeyAuth.revoke(request.params.id)) {
        return reply.code(404).type('application/problem+json').send({
          type: 'urn:eva:problem:api-key-not-found', title: 'API key not found',
          status: 404, code: 'API_KEY_NOT_FOUND', detail: 'The API key does not exist.', retryable: false,
          request_id: `req_${randomUUID()}`,
        })
      }
      return reply.code(204).send()
    })

    this.app.get<{
      Querystring: {
        q?: string
        type?: string
        interval?: string
        limit?: string
        offset?: string
      }
    }>('/v1/local-data/instruments', async (request, reply) => {
      const limit = Number(request.query.limit ?? 30)
      const offset = Number(request.query.offset ?? 0)
      const instrumentType = request.query.type
      const interval = request.query.interval
      if (
        !Number.isInteger(limit) || limit < 1 || limit > 100 ||
        !Number.isInteger(offset) || offset < 0 ||
        (instrumentType !== undefined && instrumentType !== 'equity' && instrumentType !== 'index' && instrumentType !== 'future') ||
        (interval !== undefined && interval !== '1m' && interval !== '1d') ||
        (request.query.q?.length ?? 0) > 100
      ) {
        return reply.code(400).type('application/problem+json').send({
          type: 'urn:eva:problem:invalid-local-data-query',
          title: 'Invalid local data query',
          status: 400,
          code: 'INVALID_LOCAL_DATA_QUERY',
          detail: 'q, type, interval, limit, or offset is invalid.',
          retryable: false,
          request_id: `req_${randomUUID()}`,
        })
      }
      const [result, status] = await Promise.all([
        this.dataSyncManager.browseInstruments({
          query: request.query.q,
          instrumentType,
          interval,
          limit,
          offset,
        }),
        this.dataSyncManager.status(),
      ])
      return {
        schema: 'eva.local-instrument-list.v1',
        data: result.items,
        page: { total: result.total, limit, offset },
        meta: { local_only: true, storage: status.storage, generated_at: new Date().toISOString() },
      }
    })

    this.app.get<{
      Params: { instrumentId: string }
      Querystring: {
        interval?: string
        start?: string
        end?: string
        limit?: string
        offset?: string
      }
    }>('/v1/local-data/instruments/:instrumentId/bars', async (request, reply) => {
      const interval = request.query.interval ?? '1d'
      const start = request.query.start
      const end = request.query.end
      const limit = Number(request.query.limit ?? (interval === '1m' ? 500 : 20))
      const offset = Number(request.query.offset ?? 0)
      const validDate = (value: string | undefined) =>
        value === undefined || /^\d{4}-\d{2}-\d{2}$/.test(value)
      if (
        (interval !== '1m' && interval !== '1d') ||
        !validDate(start) || !validDate(end) || (start && end && start > end) ||
        !Number.isInteger(limit) || limit < 1 || limit > 500 ||
        !Number.isInteger(offset) || offset < 0
      ) {
        return reply.code(400).type('application/problem+json').send({
          type: 'urn:eva:problem:invalid-local-bar-query',
          title: 'Invalid local bar query',
          status: 400,
          code: 'INVALID_LOCAL_BAR_QUERY',
          detail: 'interval, start, end, limit (1..500), or offset is invalid.',
          retryable: false,
          request_id: `req_${randomUUID()}`,
        })
      }
      const result = await this.dataSyncManager.browseBars({
        instrumentId: request.params.instrumentId,
        interval,
        start,
        end,
        limit,
        offset,
      })
      return {
        schema: 'eva.local-bar-list.v1',
        data: result.items,
        page: { total: result.total, limit, offset },
        meta: { local_only: true, generated_at: new Date().toISOString() },
      }
    })

    this.app.get<{
      Params: { instrumentId: string }
      Querystring: { interval?: string }
    }>('/v1/local-data/instruments/:instrumentId/coverage', async (request, reply) => {
      const interval = request.query.interval ?? '1d'
      if (interval !== '1m' && interval !== '1d') {
        return reply.code(400).type('application/problem+json').send({
          type: 'urn:eva:problem:invalid-local-coverage-query',
          title: 'Invalid local coverage query', status: 400,
          code: 'INVALID_LOCAL_COVERAGE_QUERY',
          detail: 'interval must be either 1m or 1d.', retryable: false,
          request_id: `req_${randomUUID()}`,
        })
      }
      return {
        schema: 'eva.local-coverage.v1',
        data: await this.dataSyncManager.browseCoverage(request.params.instrumentId, interval),
        meta: { local_only: true, generated_at: new Date().toISOString() },
      }
    })

    this.app.get('/v1/data-sync', async (_request, reply) => {
      reply.header('cache-control', 'no-store')
      return {
        schema: 'eva.data-sync-status.v1',
        data: await this.dataSyncManager.status(),
        generated_at: new Date().toISOString(),
      }
    })

    this.app.get<{
      Querystring: { type?: string; q?: string; limit?: string; offset?: string }
    }>('/v1/data-sync/instruments', async (request, reply) => {
      const instrumentType = request.query.type
      const limit = Number(request.query.limit ?? 50)
      const offset = Number(request.query.offset ?? 0)
      if (
        (instrumentType !== 'equity' && instrumentType !== 'index' && instrumentType !== 'future') ||
        (request.query.q?.length ?? 0) > 100 ||
        !Number.isInteger(limit) || limit < 1 || limit > 100 ||
        !Number.isInteger(offset) || offset < 0
      ) {
        return reply.code(400).type('application/problem+json').send({
          type: 'urn:eva:problem:invalid-data-sync-instrument-query',
          title: 'Invalid data sync instrument query', status: 400,
          code: 'INVALID_DATA_SYNC_INSTRUMENT_QUERY',
          detail: 'type, q, limit, or offset is invalid.',
          retryable: false, request_id: `req_${randomUUID()}`,
        })
      }
      const result = await this.dataSyncManager.listSyncInstruments({
        query: request.query.q,
        instrumentType,
        limit,
        offset,
      })
      reply.header('cache-control', 'no-store')
      return {
        schema: 'eva.data-sync-instrument-list.v1',
        data: result.items,
        page: { total: result.total, limit, offset },
      }
    })

    this.app.get<{
      Querystring: { limit?: string }
    }>('/v1/data-sync/runs', async (request, reply) => {
      const limit = request.query.limit === undefined ? 30 : Number(request.query.limit)
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
        return reply.code(400).type('application/problem+json').send({
          type: 'urn:eva:problem:invalid-data-sync-run-query',
          title: 'Invalid data sync run query', status: 400,
          code: 'INVALID_DATA_SYNC_RUN_QUERY', detail: 'limit must be between 1 and 200.',
          retryable: false, request_id: `req_${randomUUID()}`,
        })
      }
      reply.header('cache-control', 'no-store')
      return { schema: 'eva.data-sync-run-list.v1', data: await this.dataSyncManager.listRuns(limit) }
    })

    this.app.delete('/v1/data-sync/runs', async (_request, reply) => {
      try {
        await this.dataSyncManager.clearRuns()
        return reply.code(204).send()
      } catch (error) {
        const conflict = error instanceof Error && error.message === 'DATA_SYNC_ALREADY_RUNNING'
        if (!conflict) throw error
        return reply.code(409).type('application/problem+json').send({
          type: 'urn:eva:problem:data-sync-already-running',
          title: 'Data sync history could not be cleared', status: 409,
          code: 'DATA_SYNC_ALREADY_RUNNING',
          detail: 'Stop the active synchronization before clearing its history.',
          retryable: false, request_id: `req_${randomUUID()}`,
        })
      }
    })

    this.app.get<{
      Params: { runId: string }
    }>('/v1/data-sync/runs/:runId/items', async (request, reply) => {
      reply.header('cache-control', 'no-store')
      return {
        schema: 'eva.data-sync-run-item-list.v1',
        data: await this.dataSyncManager.runItems(request.params.runId),
      }
    })

    this.app.post<{
      Params: { runId: string }
      Body: { instrument_id?: string; failed_only?: boolean }
    }>('/v1/data-sync/runs/:runId/retry', async (request, reply) => {
      try {
        if (request.body?.failed_only !== undefined && typeof request.body.failed_only !== 'boolean') {
          throw new Error('DATA_SYNC_INVALID_RETRY')
        }
        const run = await this.dataSyncManager.retry(
          request.params.runId, request.body?.instrument_id, request.body?.failed_only ?? true,
        )
        return reply.code(202).send({ schema: 'eva.data-sync-run.v1', data: run })
      } catch (error) {
        const code = error instanceof Error ? error.message : 'DATA_SYNC_RETRY_FAILED'
        const notFound = code === 'DATA_SYNC_RUN_NOT_FOUND'
        const conflict = code === 'DATA_SYNC_ALREADY_RUNNING'
        return reply.code(notFound ? 404 : conflict ? 409 : 400).type('application/problem+json').send({
          type: `urn:eva:problem:${code.toLowerCase().replaceAll('_', '-')}`,
          title: 'Data sync retry could not start', status: notFound ? 404 : conflict ? 409 : 400,
          code, detail: code === 'DATA_SYNC_NO_FAILED_ITEMS'
            ? 'This run has no matching failed items.'
            : code === 'DATA_SYNC_NO_ITEMS' ? 'This run has no instruments to retry.'
            : code === 'DATA_SYNC_CATALOG_CHANGED'
              ? 'One or more failed instruments no longer exist in the catalog.'
              : notFound ? 'The synchronization run does not exist.'
                : conflict ? 'Only one data sync run can execute at a time.' : 'The retry request is invalid.',
          retryable: false, request_id: `req_${randomUUID()}`,
        })
      }
    })

    this.app.post<{
      Body: {
        instrument_types?: InstrumentType[]
        instrument_ids?: string[]
        interval?: '1m' | '1d'
        start?: string
        end?: string
        adjustment?: PriceAdjustment
        limit?: number
        delay_ms?: number
      }
    }>('/v1/data-sync/runs', async (request, reply) => {
      const instrumentTypes = request.body?.instrument_types
      const instrumentIds = request.body?.instrument_ids
      const interval = request.body?.interval ?? '1d'
      const start = request.body?.start
      const end = request.body?.end
      const adjustment = request.body?.adjustment ?? 'none'
      const limit = request.body?.limit
      const delayMs = request.body?.delay_ms ?? 0
      if (
        !Array.isArray(instrumentTypes) ||
        instrumentTypes.length === 0 ||
        instrumentTypes.some((value) => value !== 'equity' && value !== 'index' && value !== 'future') ||
        (instrumentIds !== undefined && (
          !Array.isArray(instrumentIds) || instrumentIds.length === 0 || instrumentIds.length > 20_000 ||
          instrumentIds.some((value) => typeof value !== 'string' || value.length === 0 || value.length > 200) ||
          new Set(instrumentIds).size !== instrumentIds.length
        )) ||
        (interval !== '1m' && interval !== '1d') ||
        typeof start !== 'string' ||
        typeof end !== 'string' ||
        adjustment !== 'none' ||
        (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 20_000)) ||
        !Number.isInteger(delayMs) || delayMs < 0 || delayMs > 10_000
      ) {
        return reply.code(400).type('application/problem+json').send({
          type: 'urn:eva:problem:invalid-data-sync-request',
          title: 'Invalid data sync request',
          status: 400,
          code: 'INVALID_DATA_SYNC_REQUEST',
          detail: 'Synchronization stores raw bars only; instrument_types, instrument_ids, interval, start, end, limit, or delay_ms is invalid.',
          retryable: false,
          request_id: `req_${randomUUID()}`,
        })
      }
      try {
        const run = await this.dataSyncManager.start({
          instrumentTypes,
          ...(instrumentIds === undefined ? {} : { instrumentIds }),
          interval,
          start,
          end,
          adjustment,
          ...(limit === undefined ? {} : { limit }),
          delayMs,
        })
        return reply.code(202).send({
          schema: 'eva.data-sync-run.v1',
          data: run,
        })
      } catch (error) {
        const code = error instanceof Error ? error.message : 'DATA_SYNC_START_FAILED'
        const conflict = code === 'DATA_SYNC_ALREADY_RUNNING'
        return reply.code(conflict ? 409 : 400).type('application/problem+json').send({
          type: `urn:eva:problem:${code.toLowerCase().replaceAll('_', '-')}`,
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
          type: 'urn:eva:problem:data-sync-not-running',
          title: 'Data sync is not running',
          status: 409,
          code: 'DATA_SYNC_NOT_RUNNING',
          detail: 'There is no active data sync run to cancel.',
          retryable: false,
          request_id: `req_${randomUUID()}`,
        })
      }
      return reply.code(202).send({ schema: 'eva.data-sync-run.v1', data: run })
    })

    this.app.post('/v1/data-sync/resume', async (_request, reply) => {
      try {
        const run = await this.dataSyncManager.resume()
        return reply.code(202).send({ schema: 'eva.data-sync-run.v1', data: run })
      } catch (error) {
        const code = error instanceof Error ? error.message : 'DATA_SYNC_RESUME_FAILED'
        const detail = code === 'DATA_SYNC_ALREADY_RUNNING'
          ? 'Only one data sync run can execute at a time.'
          : code === 'DATA_SYNC_CATALOG_CHANGED'
            ? 'The instrument catalog changed since the previous run; start a new sync instead.'
            : 'There is no interrupted data sync run to resume.'
        return reply.code(409).type('application/problem+json').send({
          type: `urn:eva:problem:${code.toLowerCase().replaceAll('_', '-')}`,
          title: 'Data sync could not resume',
          status: 409,
          code,
          detail,
          retryable: false,
          request_id: `req_${randomUUID()}`,
        })
      }
    })

    this.app.post<{
      Body: {
        interval?: '1m' | '1d'
        time?: string
        skip_weekends?: boolean
        instrument_types?: InstrumentType[]
        instrument_ids?: string[]
        lookback_days?: number
        adjustment?: PriceAdjustment
        delay_ms?: number
      }
    }>('/v1/data-sync/schedules', async (request, reply) => {
      const body = request.body
      const interval = body?.interval ?? '1d'
      const time = body?.time
      const skipWeekends = body?.skip_weekends ?? false
      const instrumentTypes = body?.instrument_types
      const instrumentIds = body?.instrument_ids
      const lookbackDays = body?.lookback_days
      const adjustment = body?.adjustment
      const delayMs = body?.delay_ms
      if (
        typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time) ||
        (interval !== '1m' && interval !== '1d') ||
        typeof skipWeekends !== 'boolean' ||
        !Array.isArray(instrumentTypes) || instrumentTypes.length === 0 ||
        instrumentTypes.some((type) => type !== 'equity' && type !== 'index' && type !== 'future') ||
        (instrumentIds !== undefined && (
          !Array.isArray(instrumentIds) || instrumentIds.length === 0 || instrumentIds.length > 20_000 ||
          instrumentIds.some((value) => typeof value !== 'string' || value.length === 0 || value.length > 200) ||
          new Set(instrumentIds).size !== instrumentIds.length
        )) ||
        !Number.isInteger(lookbackDays) || (lookbackDays ?? 0) < 1 || (lookbackDays ?? 0) > 90 ||
        adjustment !== 'none' ||
        !Number.isInteger(delayMs) || (delayMs ?? -1) < 0 || (delayMs ?? 0) > 10_000
      ) {
        return reply.code(400).type('application/problem+json').send({
          type: 'urn:eva:problem:invalid-data-sync-schedule',
          title: 'Invalid data sync schedule', status: 400,
          code: 'INVALID_DATA_SYNC_SCHEDULE',
          detail: 'interval, time, skip_weekends, instrument_types, instrument_ids, lookback_days (1..90), adjustment, or delay_ms is invalid.',
          retryable: false, request_id: `req_${randomUUID()}`,
        })
      }
      try {
        const schedule = await this.dataSyncManager.createSchedule({
          enabled: true, interval, time, skip_weekends: skipWeekends,
          instrument_types: instrumentTypes, instrument_ids: instrumentIds ?? null,
          lookback_days: lookbackDays!,
          adjustment, delay_ms: delayMs!,
        })
        return reply.code(201).send({ schema: 'eva.data-sync-schedule.v1', data: schedule })
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'DATA_SYNC_INSTRUMENTS_NOT_FOUND') throw error
        return reply.code(400).type('application/problem+json').send({
          type: 'urn:eva:problem:data-sync-instruments-not-found',
          title: 'Scheduled data sync instruments were not found', status: 400,
          code: 'DATA_SYNC_INSTRUMENTS_NOT_FOUND',
          detail: 'One or more selected instruments are not available for this category.',
          retryable: false, request_id: `req_${randomUUID()}`,
        })
      }
    })

    this.app.delete<{
      Params: { scheduleId: string }
    }>('/v1/data-sync/schedules/:scheduleId', async (request, reply) => {
      const scheduleId = Number(request.params.scheduleId)
      if (!Number.isInteger(scheduleId) || scheduleId < 1) {
        return reply.code(400).type('application/problem+json').send({
          type: 'urn:eva:problem:invalid-data-sync-schedule-id',
          title: 'Invalid data sync schedule ID', status: 400,
          code: 'INVALID_DATA_SYNC_SCHEDULE_ID', detail: 'scheduleId must be a positive integer.',
          retryable: false, request_id: `req_${randomUUID()}`,
        })
      }
      if (!await this.dataSyncManager.deleteSchedule(scheduleId)) {
        return reply.code(404).type('application/problem+json').send({
          type: 'urn:eva:problem:data-sync-schedule-not-found',
          title: 'Data sync schedule not found', status: 404,
          code: 'DATA_SYNC_SCHEDULE_NOT_FOUND', detail: 'The scheduled data sync task does not exist.',
          retryable: false, request_id: `req_${randomUUID()}`,
        })
      }
      return reply.code(204).send()
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
            type: 'urn:eva:problem:invalid-health-check-interval',
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

    this.app.put<{
      Params: { category: string }
      Body: { source_ids?: unknown[] }
    }>('/v1/data-sources/order/:category', async (request, reply) => {
      try {
        await this.dataSourcePreferences.update(
          request.params.category,
          request.body?.source_ids ?? [],
        )
      } catch (error) {
        return reply.code(400).type('application/problem+json').send({
          type: 'urn:eva:problem:invalid-data-source-order',
          title: 'Invalid data source order', status: 400,
          code: 'INVALID_DATA_SOURCE_ORDER',
          detail: error instanceof Error ? error.message : 'data source order is invalid',
          retryable: false, request_id: `req_${randomUUID()}`,
        })
      }
      reply.header('cache-control', 'no-store')
      return await dataSourcesResponse()
    })

    this.app.get('/v1/health', async () => {
      const providers = ctx.marketProviderRegistry.list().length
      return {
        schema: 'eva.health.v1',
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
            type: 'urn:eva:problem:invalid-cursor',
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
        schema: 'eva.instrument-list.v1',
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
          type: 'urn:eva:problem:instrument-not-found',
          title: 'Instrument not found',
          status: 404,
          code: 'INSTRUMENT_NOT_FOUND',
          detail: 'The requested instrument is not in the active catalog.',
          retryable: false,
          request_id: `req_${randomUUID()}`,
        })
      }
      return {
        schema: 'eva.instrument.v1',
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
          type: 'urn:eva:problem:invalid-request',
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
        schema: 'eva.instrument-search.v1',
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
          type: 'urn:eva:problem:invalid-request',
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
        schema: 'eva.instrument-resolution.v1',
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
          type: 'urn:eva:problem:instrument-not-found',
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
          schema: 'eva.quote.v1',
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
          providers: await providersFor(instrument),
          instrument,
          capability: 'quote',
          ...routingOptions,
          supports: (provider) => typeof provider.getQuote === 'function',
          invoke: (provider, providerSymbol, signal) =>
            provider.getQuote?.({ providerSymbol, signal }),
        })
        const quote = result.value
        return {
          schema: 'eva.quote.v1',
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
        as_of?: string
      }
    }>('/v1/instruments/:instrumentId/bars', async (request, reply) => {
      const catalog = await loadCatalog()
      const instrument = catalog.instruments.find(
        (candidate) => candidate.instrumentId === request.params.instrumentId,
      )
      if (!instrument) {
        return reply.code(404).type('application/problem+json').send({
          type: 'urn:eva:problem:instrument-not-found',
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
      const asOf = request.query.as_of
      if (!['none', 'forward', 'backward'].includes(adjustment)) {
        return reply.code(400).type('application/problem+json').send({
          type: 'urn:eva:problem:invalid-price-adjustment',
          title: 'Invalid price adjustment', status: 400,
          code: 'INVALID_PRICE_ADJUSTMENT',
          detail: 'adjustment must be none, forward, or backward.',
          retryable: false, request_id: `req_${randomUUID()}`,
        })
      }
      if (asOf !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
        return reply.code(400).type('application/problem+json').send({
          type: 'urn:eva:problem:invalid-adjustment-as-of',
          title: 'Invalid adjustment as-of date', status: 400,
          code: 'INVALID_ADJUSTMENT_AS_OF', detail: 'as_of must be an ISO date.',
          retryable: false, request_id: `req_${randomUUID()}`,
        })
      }
      if (asOf && request.query.end && asOf < request.query.end) {
        return reply.code(400).type('application/problem+json').send({
          type: 'urn:eva:problem:invalid-adjustment-as-of-range',
          title: 'Invalid adjustment as-of range', status: 400,
          code: 'INVALID_ADJUSTMENT_AS_OF_RANGE',
          detail: 'as_of must be on or after the requested end date.',
          retryable: false, request_id: `req_${randomUUID()}`,
        })
      }
      if (instrument.type !== 'equity' && adjustment !== 'none') {
        return reply.code(422).type('application/problem+json').send({
          type: 'urn:eva:problem:adjustment-unavailable-for-index',
          title: 'Price adjustment unavailable for instrument', status: 422,
          code: 'ADJUSTMENT_UNAVAILABLE_FOR_INDEX',
          detail: 'Only equities support price adjustment; request adjustment=none.',
          retryable: false, request_id: `req_${randomUUID()}`,
        })
      }
      let loadedFactors: Awaited<ReturnType<typeof loadAdjustmentFactors>> = null
      if (interval === '1d' || interval === '1m') {
        let localBars = await this.dataSyncManager.readBars({
          instrumentId: instrument.instrumentId,
          interval,
          adjustment,
          start: request.query.start,
          end: request.query.end,
          asOf,
        })
        if (!localBars && adjustment !== 'none') {
          loadedFactors = await loadAdjustmentFactors(instrument)
          if (loadedFactors) {
            await this.dataSyncManager.storeAdjustmentFactors(instrument, loadedFactors)
            localBars = await this.dataSyncManager.readBars({
              instrumentId: instrument.instrumentId,
              interval,
              adjustment,
              start: request.query.start,
              end: request.query.end,
              asOf,
            })
          }
        }
        if (localBars) {
          const fetchedAt = new Date().toISOString()
          return {
            schema: 'eva.bar-list.v1',
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
            meta: meta([
              {
                provider: 'local-duckdb',
                upstream: 'local',
                fetched_at: fetchedAt,
              },
              ...(loadedFactors ? [{
                provider: loadedFactors.provider,
                upstream: loadedFactors.upstream,
                fetched_at: fetchedAt,
              }] : []),
            ]),
          }
        }
      }
      try {
        const hasFactorCoverage = adjustment === 'none' ||
          await this.dataSyncManager.hasAdjustmentFactorCoverage(
            instrument.instrumentId,
            asOf,
          )
        if (adjustment !== 'none' && !loadedFactors && !hasFactorCoverage) {
          loadedFactors = await loadAdjustmentFactors(instrument)
          if (!loadedFactors) {
            return reply.code(422).type('application/problem+json').send({
              type: 'urn:eva:problem:adjustment-factors-unavailable',
              title: 'Adjustment factors unavailable', status: 422,
              code: 'ADJUSTMENT_FACTORS_UNAVAILABLE',
              detail: 'No enabled provider supplies adjustment factors for this equity.',
              retryable: false, request_id: `req_${randomUUID()}`,
            })
          }
          await this.dataSyncManager.storeAdjustmentFactors(instrument, loadedFactors)
        }
        const result = await routeInstrumentData({
          providers: await providersFor(instrument),
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
              adjustment: 'none',
            }),
        })
        const cacheWarnings: string[] = []
        if (interval === '1d' || interval === '1m') {
          try {
            await this.dataSyncManager.storeBars(instrument, {
              provider: result.provider,
              upstream: result.value[0]?.source,
              bars: result.value,
            }, {
              interval,
              start: request.query.start,
              end: request.query.end,
              adjustment: 'none',
            })
          } catch {
            cacheWarnings.push('local DuckDB cache write failed')
          }
        }
        const responseBars = adjustment === 'none'
          ? result.value
          : await this.dataSyncManager.adjustBars(
              instrument.instrumentId,
              [...result.value].sort((left, right) =>
                left.periodStart.localeCompare(right.periodStart)),
              adjustment,
              asOf,
            )
        if (!responseBars) {
          return reply.code(422).type('application/problem+json').send({
            type: 'urn:eva:problem:adjustment-factors-unavailable',
            title: 'Adjustment factors unavailable', status: 422,
            code: 'ADJUSTMENT_FACTORS_UNAVAILABLE',
            detail: 'Adjustment factors do not cover the requested as_of date.',
            retryable: false, request_id: `req_${randomUUID()}`,
          })
        }
        return {
          schema: 'eva.bar-list.v1',
          data: [...responseBars]
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
            ...(loadedFactors ? [{
              provider: loadedFactors.provider,
              fetched_at: result.observedAt,
              ...(loadedFactors.upstream ? { upstream: loadedFactors.upstream } : {}),
            }] : []),
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
            type: 'urn:eva:problem:instrument-not-found',
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
            providers: await providersFor(instrument),
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
            schema: 'eva.index-constituent-list.v1',
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
