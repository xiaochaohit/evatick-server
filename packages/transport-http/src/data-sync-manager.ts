import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'

import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api'

import { BoundedExecutor } from './concurrency.js'

import type {
  BarInterval,
  CatalogInstrument,
  InstrumentType,
  PriceAdjustment,
  ProviderAdjustmentFactor,
  ProviderBar,
} from '@evatick/core'

export type DataSyncInterval = Extract<BarInterval, '1m' | '1d'>

export interface DataSyncRequest {
  interval?: DataSyncInterval
  instrumentTypes: readonly InstrumentType[]
  instrumentIds?: readonly string[]
  start: string
  end: string
  adjustment: PriceAdjustment
  limit?: number
  delayMs?: number
  lookbackDays?: number
}

export interface SyncedBars {
  provider: string
  upstream?: string
  bars: readonly ProviderBar[]
}

export interface SyncedAdjustmentFactors {
  provider: string
  upstream?: string
  factors: readonly ProviderAdjustmentFactor[]
  asOfDate: string
}

export interface DataSyncRun {
  run_id: string
  trigger: 'manual' | 'scheduled' | 'retry'
  schedule_id: number | null
  retry_of_run_id: string | null
  recovery_status: 'not_needed' | 'not_retried' | 'retrying' | 'partially_recovered' | 'recovered'
  retry_count: number
  latest_retry_run_id: string | null
  remaining_failed: number
  status: 'running' | 'completed' | 'completed_with_errors' | 'cancelled' | 'failed'
  instrument_types: readonly InstrumentType[]
  instrument_ids: readonly string[] | null
  interval: DataSyncInterval
  start: string
  end: string
  adjustment: PriceAdjustment
  limit: number | null
  delay_ms: number
  lookback_days: number
  total: number
  completed: number
  succeeded: number
  failed: number
  bars_written: number
  current_instrument: {
    instrument_id: string
    symbol: string
    name: string
  } | null
  started_at: string
  finished_at: string | null
  errors: readonly {
    instrument_id: string
    symbol: string
    message: string
  }[]
}

export interface DataSyncRunItem {
  instrument_id: string
  symbol: string
  name: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'recovered'
  bars_written: number
  error: string | null
  started_at: string | null
  finished_at: string | null
}

export interface DataSyncStatus {
  database_path: string
  storage: {
    instruments: number
    daily_bars: number
    minute_bars: number
    adjustment_factors: number
    database_bytes: number | null
    first_trading_date: string | null
    last_trading_date: string | null
    first_minute_trading_date: string | null
    last_minute_trading_date: string | null
  }
  active_run: DataSyncRun | null
  last_run: DataSyncRun | null
  schedules: readonly DataSyncSchedule[]
}

export interface DataSyncSchedule {
  schedule_id: number
  enabled: boolean
  interval: DataSyncInterval
  time: string
  skip_weekends: boolean
  instrument_types: readonly InstrumentType[]
  instrument_ids: readonly string[] | null
  lookback_days: number
  adjustment: PriceAdjustment
  delay_ms: number
  next_run_at: string | null
  last_triggered_at: string | null
}

export interface LocalQuote {
  marketTime: string
  observedAt: string
  currency: string
  last: string
  open: string
  high: string
  low: string
  previousClose: string | null
  volume: number | null
  turnover: string | null
}

export interface LocalInstrumentSummary {
  instrument_id: string
  instrument_type: InstrumentType
  symbol: string
  name: string
  venue: string | null
  publisher: string | null
  records: number
  first_trading_date: string | null
  last_trading_date: string | null
  latest_close: string | null
  daily_records: number
  daily_first_trading_date: string | null
  daily_last_trading_date: string | null
  daily_latest_close: string | null
  minute_records: number
  minute_first_trading_date: string | null
  minute_last_trading_date: string | null
  minute_latest_close: string | null
  minute_requested_start: string | null
  minute_requested_end: string | null
}

export interface LocalBarSummary {
  interval: DataSyncInterval
  trading_date: string
  period_start: string
  period_end: string
  open: string
  high: string
  low: string
  close: string
  volume: number | null
  turnover: string | null
  complete: boolean
}

export interface LocalCoverageSummary {
  interval: DataSyncInterval
  requested_start: string | null
  requested_end: string | null
  actual_start: string | null
  actual_end: string | null
  records: number
  sources: readonly string[]
  last_fetched_at: string | null
}

export interface SyncInstrumentSummary {
  instrument_id: string
  instrument_type: InstrumentType
  symbol: string
  name: string
  venue: string | null
  daily_records: number
  minute_records: number
  minute_first_trading_date: string | null
  minute_last_trading_date: string | null
}

interface DataSyncDependencies {
  databasePath: string
  loadInstruments(): Promise<readonly CatalogInstrument[]>
  refreshInstruments(): Promise<readonly CatalogInstrument[]>
  loadBars(
    instrument: CatalogInstrument,
    request: {
      interval: DataSyncInterval
      start: string
      end: string
      adjustment: PriceAdjustment
    },
  ): Promise<SyncedBars>
  loadAdjustmentFactors(
    instrument: CatalogInstrument,
  ): Promise<SyncedAdjustmentFactors | null>
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const MAX_ERRORS = 20
const CHINA_TIME_OFFSET_MS = 8 * 60 * 60 * 1_000

export function nextDataSyncRun(
  now: Date,
  time: string,
  skipWeekends: boolean,
): Date {
  const [hour, minute] = time.split(':').map(Number)
  const chinaNow = new Date(now.getTime() + CHINA_TIME_OFFSET_MS)
  const year = chinaNow.getUTCFullYear()
  const month = chinaNow.getUTCMonth()
  const day = chinaNow.getUTCDate()
  let dayOffset = 0
  let next = new Date(Date.UTC(year, month, day, hour! - 8, minute!, 0, 0))
  if (next.getTime() <= now.getTime()) dayOffset = 1

  while (true) {
    next = new Date(Date.UTC(year, month, day + dayOffset, hour! - 8, minute!, 0, 0))
    const chinaWeekday = new Date(next.getTime() + CHINA_TIME_OFFSET_MS).getUTCDay()
    if (!skipWeekends || (chinaWeekday !== 0 && chinaWeekday !== 6)) return next
    dayOffset += 1
  }
}

function subtractDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() - days)
  return date.toISOString().slice(0, 10)
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function laterDate(left: string, right: string): string {
  return left > right ? left : right
}

const FUTURES_SERIES_ID = /^cn:future-series:([^:]+):([^:]+):main$/

function futuresProductCode(symbol: string): string | null {
  return symbol.match(/^[A-Za-z]+/)?.[0]?.toUpperCase() ?? null
}

function futuresProductName(instrument: CatalogInstrument): string {
  const stripped = instrument.name.replace(instrument.symbol, '').trim()
  return stripped || futuresProductCode(instrument.symbol) || instrument.symbol
}

function futuresMainSeriesInstrument(
  contract: CatalogInstrument,
  product: string,
  name: string,
): CatalogInstrument {
  const venue = contract.venue!
  const identifiers = contract.identifiers
    .filter((identifier) =>
      identifier.capabilities.includes('bars') && identifier.mainContinuousValue)
    .map((identifier) => ({
      provider: identifier.provider,
      value: identifier.mainContinuousValue!,
      capabilities: ['bars' as const],
    }))
  return {
    instrumentId: `cn:future-series:${venue}:${product}:main`,
    type: 'future', market: 'CN', name: `${name} ${product} 主力连续（未复权）`,
    symbol: product, venue, currency: 'CNY', status: 'active', aliases: [],
    capabilities: ['bars'], identifiers,
  }
}

function adjustedPrice(
  value: string,
  factor: number,
  anchor: number,
  adjustment: PriceAdjustment,
): string {
  if (adjustment === 'none') return value
  const multiplier = adjustment === 'backward' ? factor : factor / anchor
  return String(Number((Number(value) * multiplier).toFixed(10)))
}

export class DataSyncManager {
  private readonly ready: Promise<void>
  private instance: DuckDBInstance | undefined
  private connection: DuckDBConnection | undefined
  private activeRun: DataSyncRun | null = null
  private lastRun: DataSyncRun | null = null
  private cancelled = false
  private execution: Promise<void> | null = null
  private readonly scheduleTimers = new Map<number, ReturnType<typeof setTimeout>>()
  private readonly schedules = new Map<number, DataSyncSchedule>()
  private pendingScheduleIds: number[] = []
  private readonly writes = new BoundedExecutor(1)
  private syncInstruments(
    catalog: readonly CatalogInstrument[],
    instrumentTypes: readonly InstrumentType[],
  ): readonly CatalogInstrument[] {
    const regular = catalog.filter((instrument) =>
      instrument.type !== 'future' &&
      instrumentTypes.includes(instrument.type) &&
      instrument.capabilities.includes('bars'))
    if (!instrumentTypes.includes('future')) return regular
    const products = new Map<string, CatalogInstrument>()
    for (const contract of catalog) {
      if (contract.type !== 'future' || !contract.venue || !contract.capabilities.includes('bars')) continue
      const product = futuresProductCode(contract.symbol)
      if (!product) continue
      const key = `${contract.venue}:${product}`
      if (!products.has(key)) {
        const series = futuresMainSeriesInstrument(
          contract, product, futuresProductName(contract),
        )
        if (series.identifiers.length) products.set(key, series)
      }
    }
    return [...regular, ...products.values()]
  }

  constructor(private readonly dependencies: DataSyncDependencies) {
    this.ready = this.initialize()
  }

  async status(): Promise<DataSyncStatus> {
    await this.ready
    const activeRun = this.activeRun?.retry_of_run_id
      ? await this.retrySourcePresentation(this.activeRun)
      : this.activeRun
    const lastRun = this.lastRun?.retry_of_run_id
      ? await this.retrySourcePresentation(this.lastRun)
      : this.lastRun
    const databaseBytes = await this.databaseBytes()
    const reader = await this.db.runAndReadAll(`
      SELECT
        (SELECT count(*) FROM instruments)::INTEGER AS instruments,
        (SELECT count(*) FROM daily_bars WHERE adjustment = 'none')::BIGINT AS daily_bars,
        (SELECT count(*) FROM minute_bars WHERE adjustment = 'none')::BIGINT AS minute_bars,
        (SELECT count(*) FROM equity_adjustment_factors)::BIGINT AS adjustment_factors,
        (SELECT min(trading_date)::VARCHAR FROM daily_bars) AS first_trading_date,
        (SELECT max(trading_date)::VARCHAR FROM daily_bars) AS last_trading_date,
        (SELECT min(trading_date)::VARCHAR FROM minute_bars) AS first_minute_trading_date,
        (SELECT max(trading_date)::VARCHAR FROM minute_bars) AS last_minute_trading_date
    `)
    const row = reader.getRowObjectsJson()[0] ?? {}
    return {
      database_path: this.dependencies.databasePath,
      storage: {
        instruments: Number(row.instruments ?? 0),
        daily_bars: Number(row.daily_bars ?? 0),
        minute_bars: Number(row.minute_bars ?? 0),
        adjustment_factors: Number(row.adjustment_factors ?? 0),
        database_bytes: databaseBytes,
        first_trading_date: typeof row.first_trading_date === 'string'
          ? row.first_trading_date
          : null,
        last_trading_date: typeof row.last_trading_date === 'string'
          ? row.last_trading_date
          : null,
        first_minute_trading_date: typeof row.first_minute_trading_date === 'string'
          ? row.first_minute_trading_date
          : null,
        last_minute_trading_date: typeof row.last_minute_trading_date === 'string'
          ? row.last_minute_trading_date
          : null,
      },
      active_run: activeRun,
      last_run: lastRun,
      schedules: [...this.schedules.values()].sort((left, right) =>
        (left.next_run_at ?? '').localeCompare(right.next_run_at ?? '')),
    }
  }

  async listRuns(limit = 30): Promise<readonly DataSyncRun[]> {
    await this.ready
    const reader = await this.db.runAndReadAll(`
      SELECT status, payload::VARCHAR AS payload, finished_at::VARCHAR AS finished_at
      FROM sync_runs ORDER BY started_at DESC
    `)
    return reader.getRowObjectsJson().flatMap((row) => {
      if (typeof row.payload !== 'string') return []
      const stored = JSON.parse(row.payload) as DataSyncRun
      if (stored.trigger === 'retry') return []
      return [this.normalizeRun(stored, row.status, row.finished_at)]
    }).slice(0, limit)
  }

  async clearRuns(): Promise<void> {
    await this.ready
    if (this.activeRun) throw new Error('DATA_SYNC_ALREADY_RUNNING')
    await this.db.run('BEGIN TRANSACTION')
    try {
      await this.db.run('DELETE FROM sync_run_items')
      await this.db.run('DELETE FROM sync_runs')
      await this.db.run('COMMIT')
      this.lastRun = null
    } catch (error) {
      await this.db.run('ROLLBACK')
      throw error
    }
  }

  async runItems(runId: string): Promise<readonly DataSyncRunItem[]> {
    await this.ready
    const reader = await this.db.runAndReadAll(`
      SELECT instrument_id, symbol, name, status, bars_written, error,
        started_at::VARCHAR AS started_at, finished_at::VARCHAR AS finished_at
      FROM sync_run_items WHERE run_id = $run_id
      ORDER BY coalesce(started_at, finished_at), symbol
    `, { run_id: runId })
    return reader.getRowObjectsJson().map((row) => ({
      instrument_id: String(row.instrument_id), symbol: String(row.symbol), name: String(row.name),
      status: row.status as DataSyncRunItem['status'], bars_written: Number(row.bars_written),
      error: row.error === null ? null : String(row.error),
      started_at: this.timestamp(row.started_at), finished_at: this.timestamp(row.finished_at),
    }))
  }

  async retry(runId: string, instrumentId?: string, failedOnly = true): Promise<DataSyncRun> {
    await this.ready
    if (this.activeRun) throw new Error('DATA_SYNC_ALREADY_RUNNING')
    const source = (await this.listRuns(10_000)).find((run) => run.run_id === runId)
    if (!source) throw new Error('DATA_SYNC_RUN_NOT_FOUND')
    const catalog = this.syncInstruments(
      await this.dependencies.loadInstruments(), source.instrument_types,
    )
    const items = await this.runItems(runId)
    const targetItems = items.filter((item) =>
      (!instrumentId || item.instrument_id === instrumentId) && (!failedOnly || item.status === 'failed'))
    const fallbackIds = failedOnly
      ? source.errors.filter((item) => !instrumentId || item.instrument_id === instrumentId)
        .map((item) => item.instrument_id)
      : []
    const targetIds = new Set(targetItems.length ? targetItems.map((item) => item.instrument_id) : fallbackIds)
    const instruments = targetIds.size
      ? catalog.filter((instrument) => targetIds.has(instrument.instrumentId))
      : failedOnly
        ? []
        : catalog.slice(0, source.limit ?? undefined)
    if (!instruments.length) throw new Error(failedOnly ? 'DATA_SYNC_NO_FAILED_ITEMS' : 'DATA_SYNC_NO_ITEMS')
    if (targetIds.size && instruments.length !== targetIds.size) throw new Error('DATA_SYNC_CATALOG_CHANGED')
    const retryRun = await this.createRun({
      instrumentTypes: source.instrument_types, interval: source.interval,
      start: source.start, end: source.end, adjustment: source.adjustment,
      delayMs: source.delay_ms, lookbackDays: source.lookback_days,
    }, instruments, { trigger: 'retry', retryOfRunId: source.run_id })
    return (await this.readRun(source.run_id)) ?? retryRun
  }

  private async databaseBytes(): Promise<number | null> {
    if (this.dependencies.databasePath === ':memory:') return null
    const sizes = await Promise.all([
      this.dependencies.databasePath,
      `${this.dependencies.databasePath}.wal`,
    ].map(async (path) => {
      try {
        return (await stat(path)).size
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
        throw error
      }
    }))
    return sizes.reduce((sum, size) => sum + size, 0)
  }

  async createSchedule(
    schedule: Omit<DataSyncSchedule, 'schedule_id' | 'next_run_at' | 'last_triggered_at'>,
  ): Promise<DataSyncSchedule> {
    await this.ready
    if (schedule.instrument_ids?.length) {
      const catalog = this.syncInstruments(
        await this.dependencies.loadInstruments(), schedule.instrument_types,
      )
      const eligibleIds = new Set(catalog
        .map((instrument) => instrument.instrumentId))
      if (schedule.instrument_ids.some((instrumentId) => !eligibleIds.has(instrumentId))) {
        throw new Error('DATA_SYNC_INSTRUMENTS_NOT_FOUND')
      }
    }
    const scheduleId = Math.max(0, ...this.schedules.keys()) + 1
    const created: DataSyncSchedule = {
      ...schedule,
      schedule_id: scheduleId,
      next_run_at: null,
      last_triggered_at: null,
    }
    this.schedules.set(scheduleId, created)
    this.configureScheduleTimer(scheduleId)
    await this.persistSchedule(scheduleId)
    return this.schedules.get(scheduleId)!
  }

  async deleteSchedule(scheduleId: number): Promise<boolean> {
    await this.ready
    if (!this.schedules.has(scheduleId)) return false
    const timer = this.scheduleTimers.get(scheduleId)
    if (timer) clearTimeout(timer)
    this.scheduleTimers.delete(scheduleId)
    this.schedules.delete(scheduleId)
    this.pendingScheduleIds = this.pendingScheduleIds.filter((id) => id !== scheduleId)
    await this.db.run('DELETE FROM sync_schedule WHERE id = $schedule_id', {
      schedule_id: scheduleId,
    })
    return true
  }

  async browseInstruments(request: {
    query?: string
    instrumentType?: InstrumentType
    interval?: DataSyncInterval
    limit: number
    offset: number
  }): Promise<{ total: number; items: readonly LocalInstrumentSummary[] }> {
    await this.ready
    const query = request.query?.replaceAll(/\s+/g, '') ?? ''
    const instrumentType = request.instrumentType ?? ''
    const filters = {
      query: `%${query.toLowerCase()}%`,
      instrument_type: instrumentType,
      interval: request.interval ?? '',
    }
    const totalReader = await this.db.runAndReadAll(`
      WITH daily AS (
        SELECT instrument_id, count(*)::BIGINT AS records
        FROM daily_bars WHERE adjustment = 'none' GROUP BY instrument_id
      ), minute AS (
        SELECT instrument_id, count(*)::BIGINT AS records
        FROM minute_bars WHERE adjustment = 'none' GROUP BY instrument_id
      )
      SELECT count(*)::INTEGER AS total
      FROM instruments i
      LEFT JOIN daily d ON d.instrument_id = i.instrument_id
      LEFT JOIN minute m ON m.instrument_id = i.instrument_id
      WHERE ($instrument_type = '' OR i.instrument_type = $instrument_type)
        AND ($query = '%%' OR lower(i.symbol) LIKE $query OR lower(i.name) LIKE $query)
        AND (($interval = '' AND (coalesce(d.records, 0) > 0 OR coalesce(m.records, 0) > 0))
          OR ($interval = '1d' AND coalesce(d.records, 0) > 0)
          OR ($interval = '1m' AND coalesce(m.records, 0) > 0))
    `, filters)
    const reader = await this.db.runAndReadAll(`
      WITH daily AS (
        SELECT instrument_id, count(*)::BIGINT AS records,
          min(trading_date)::VARCHAR AS first_date,
          max(trading_date)::VARCHAR AS last_date,
          arg_max(close, trading_date)::VARCHAR AS latest_close
        FROM daily_bars WHERE adjustment = 'none' GROUP BY instrument_id
      ), minute AS (
        SELECT instrument_id, count(*)::BIGINT AS records,
          min(trading_date)::VARCHAR AS first_date,
          max(trading_date)::VARCHAR AS last_date,
          arg_max(close, period_start)::VARCHAR AS latest_close
        FROM minute_bars WHERE adjustment = 'none' GROUP BY instrument_id
      ), coverage AS (
        SELECT instrument_id,
          requested_start::VARCHAR AS requested_start,
          requested_end::VARCHAR AS requested_end
        FROM minute_sync_coverage WHERE adjustment = 'none'
      ), selected AS (
        SELECT i.*
        FROM instruments i
        LEFT JOIN daily d ON d.instrument_id = i.instrument_id
        LEFT JOIN minute m ON m.instrument_id = i.instrument_id
        WHERE ($instrument_type = '' OR i.instrument_type = $instrument_type)
          AND ($query = '%%' OR lower(i.symbol) LIKE $query OR lower(i.name) LIKE $query)
          AND (($interval = '' AND (coalesce(d.records, 0) > 0 OR coalesce(m.records, 0) > 0))
            OR ($interval = '1d' AND coalesce(d.records, 0) > 0)
            OR ($interval = '1m' AND coalesce(m.records, 0) > 0))
        ORDER BY i.instrument_type, i.symbol
        LIMIT $limit OFFSET $offset
      )
      SELECT
        i.instrument_id, i.instrument_type, i.symbol, i.name, i.venue, i.publisher,
        coalesce(d.records, 0)::BIGINT AS daily_records,
        d.first_date AS daily_first_date, d.last_date AS daily_last_date,
        d.latest_close AS daily_latest_close,
        coalesce(m.records, 0)::BIGINT AS minute_records,
        m.first_date AS minute_first_date, m.last_date AS minute_last_date,
        m.latest_close AS minute_latest_close,
        c.requested_start, c.requested_end
      FROM selected i
      LEFT JOIN daily d ON d.instrument_id = i.instrument_id
      LEFT JOIN minute m ON m.instrument_id = i.instrument_id
      LEFT JOIN coverage c ON c.instrument_id = i.instrument_id
      ORDER BY i.instrument_type, i.symbol
    `, { ...filters, limit: request.limit, offset: request.offset })
    return {
      total: Number(totalReader.getRowObjectsJson()[0]?.total ?? 0),
      items: reader.getRowObjectsJson().map((row) => {
        const minuteRecords = Number(row.minute_records)
        const minuteFirst = row.minute_first_date === null ? null : String(row.minute_first_date)
        const minuteLast = row.minute_last_date === null ? null : String(row.minute_last_date)
        const requestedStart = row.requested_start === null ? null : String(row.requested_start)
        const requestedEnd = row.requested_end === null ? null : String(row.requested_end)
        const dailyRecords = Number(row.daily_records)
        const useMinute = request.interval === '1m' || (dailyRecords === 0 && minuteRecords > 0)
        const firstTradingDate = useMinute
          ? minuteFirst
          : row.daily_first_date === null ? null : String(row.daily_first_date)
        const lastTradingDate = useMinute
          ? minuteLast
          : row.daily_last_date === null ? null : String(row.daily_last_date)
        const latestClose = useMinute
          ? row.minute_latest_close === null ? null : String(row.minute_latest_close)
          : row.daily_latest_close === null ? null : String(row.daily_latest_close)
        return {
          instrument_id: String(row.instrument_id),
          instrument_type: row.instrument_type as InstrumentType,
          symbol: String(row.symbol),
          name: String(row.name),
          venue: row.venue === null ? null : String(row.venue),
          publisher: row.publisher === null ? null : String(row.publisher),
          records: useMinute ? minuteRecords : dailyRecords,
          first_trading_date: firstTradingDate,
          last_trading_date: lastTradingDate,
          latest_close: latestClose,
          daily_records: dailyRecords,
          daily_first_trading_date: row.daily_first_date === null ? null : String(row.daily_first_date),
          daily_last_trading_date: row.daily_last_date === null ? null : String(row.daily_last_date),
          daily_latest_close: row.daily_latest_close === null ? null : String(row.daily_latest_close),
          minute_records: minuteRecords,
          minute_first_trading_date: minuteFirst,
          minute_last_trading_date: minuteLast,
          minute_latest_close: row.minute_latest_close === null ? null : String(row.minute_latest_close),
          minute_requested_start: requestedStart,
          minute_requested_end: requestedEnd,
        }
      }),
    }
  }

  async listSyncInstruments(request: {
    query?: string
    instrumentType: InstrumentType
    limit: number
    offset: number
  }): Promise<{ total: number; items: readonly SyncInstrumentSummary[] }> {
    await this.ready
    const query = request.query?.replaceAll(/\s+/g, '').toLowerCase() ?? ''
    const catalog = this.syncInstruments(
      await this.dependencies.loadInstruments(), [request.instrumentType],
    )
      .filter((instrument) =>
        (!query || [instrument.symbol, instrument.name, instrument.instrumentId]
          .some((value) => value.replaceAll(/\s+/g, '').toLowerCase().includes(query))))
      .sort((left, right) => left.symbol.localeCompare(right.symbol))
    const page = catalog.slice(request.offset, request.offset + request.limit)
    if (page.length === 0) return { total: catalog.length, items: [] }
    const parameters = Object.fromEntries(page.map((instrument, index) => [
      `instrument_${index}`, instrument.instrumentId,
    ]))
    const placeholders = page.map((_instrument, index) => `$instrument_${index}`).join(', ')
    const reader = await this.db.runAndReadAll(`
      WITH daily AS (
        SELECT instrument_id, count(*)::BIGINT AS records
        FROM daily_bars
        WHERE adjustment = 'none' AND instrument_id IN (${placeholders})
        GROUP BY instrument_id
      ), minute AS (
        SELECT instrument_id, count(*)::BIGINT AS records,
          min(trading_date)::VARCHAR AS first_date,
          max(trading_date)::VARCHAR AS last_date
        FROM minute_bars
        WHERE adjustment = 'none' AND instrument_id IN (${placeholders})
        GROUP BY instrument_id
      )
      SELECT coalesce(d.instrument_id, m.instrument_id) AS instrument_id,
        coalesce(d.records, 0)::BIGINT AS daily_records,
        coalesce(m.records, 0)::BIGINT AS minute_records,
        m.first_date AS minute_first_date,
        m.last_date AS minute_last_date
      FROM daily d FULL OUTER JOIN minute m ON m.instrument_id = d.instrument_id
    `, parameters)
    const local = new Map(reader.getRowObjectsJson().map((row) => [String(row.instrument_id), row]))
    return {
      total: catalog.length,
      items: page.map((instrument) => {
        const row = local.get(instrument.instrumentId)
        return {
          instrument_id: instrument.instrumentId,
          instrument_type: instrument.type,
          symbol: instrument.symbol,
          name: instrument.name,
          venue: instrument.venue ?? null,
          daily_records: Number(row?.daily_records ?? 0),
          minute_records: Number(row?.minute_records ?? 0),
          minute_first_trading_date: row?.minute_first_date === null || row?.minute_first_date === undefined
            ? null : String(row.minute_first_date),
          minute_last_trading_date: row?.minute_last_date === null || row?.minute_last_date === undefined
            ? null : String(row.minute_last_date),
        }
      }),
    }
  }

  async browseBars(
    request: {
      instrumentId: string
      interval: DataSyncInterval
      start?: string
      end?: string
      limit: number
      offset: number
    },
  ): Promise<{ total: number; items: readonly LocalBarSummary[] }> {
    await this.ready
    const filterParameters = {
      instrument_id: request.instrumentId,
      start: request.start ?? '',
      end: request.end ?? '',
    }
    const pageParameters = {
      ...filterParameters,
      limit: request.limit,
      offset: request.offset,
    }
    const table = request.interval === '1m' ? 'minute_bars' : 'daily_bars'
    const totalReader = await this.db.runAndReadAll(`
      SELECT count(*)::BIGINT AS total FROM ${table}
      WHERE instrument_id = $instrument_id AND adjustment = 'none'
        AND ($start = '' OR trading_date >= $start::DATE)
        AND ($end = '' OR trading_date <= $end::DATE)
    `, filterParameters)
    if (request.interval === '1m') {
      const reader = await this.db.runAndReadAll(`
        SELECT trading_date::VARCHAR AS trading_date, period_start, period_end,
          open, high, low, close, volume, turnover, complete
        FROM minute_bars
        WHERE instrument_id = $instrument_id AND adjustment = 'none'
          AND ($start = '' OR trading_date >= $start::DATE)
          AND ($end = '' OR trading_date <= $end::DATE)
        ORDER BY period_start DESC
        LIMIT $limit OFFSET $offset
      `, pageParameters)
      return {
        total: Number(totalReader.getRowObjectsJson()[0]?.total ?? 0),
        items: reader.getRowObjectsJson().map((row) => ({
          interval: '1m',
          trading_date: String(row.trading_date),
          period_start: String(row.period_start),
          period_end: String(row.period_end),
          open: String(row.open), high: String(row.high), low: String(row.low),
          close: String(row.close),
          volume: row.volume === null ? null : Number(row.volume),
          turnover: row.turnover === null ? null : String(row.turnover),
          complete: Boolean(row.complete),
        })),
      }
    }
    const reader = await this.db.runAndReadAll(`
      SELECT trading_date::VARCHAR AS trading_date, open, high, low, close, volume, turnover
      FROM daily_bars
      WHERE instrument_id = $instrument_id AND adjustment = 'none'
        AND ($start = '' OR trading_date >= $start::DATE)
        AND ($end = '' OR trading_date <= $end::DATE)
      ORDER BY trading_date DESC
      LIMIT $limit OFFSET $offset
    `, pageParameters)
    return {
      total: Number(totalReader.getRowObjectsJson()[0]?.total ?? 0),
      items: reader.getRowObjectsJson().map((row) => {
        const tradingDate = String(row.trading_date)
        return {
          interval: '1d',
          trading_date: tradingDate,
          period_start: `${tradingDate}T00:00:00+08:00`,
          period_end: `${tradingDate}T23:59:59+08:00`,
          open: String(row.open), high: String(row.high), low: String(row.low),
          close: String(row.close),
          volume: row.volume === null ? null : Number(row.volume),
          turnover: row.turnover === null ? null : String(row.turnover),
          complete: true,
        }
      }),
    }
  }

  async browseCoverage(
    instrumentId: string,
    interval: DataSyncInterval,
  ): Promise<LocalCoverageSummary> {
    await this.ready
    const barsTable = interval === '1m' ? 'minute_bars' : 'daily_bars'
    const coverageTable = interval === '1m' ? 'minute_sync_coverage' : 'sync_coverage'
    const reader = await this.db.runAndReadAll(`
      SELECT
        c.requested_start::VARCHAR AS requested_start,
        c.requested_end::VARCHAR AS requested_end,
        min(b.trading_date)::VARCHAR AS actual_start,
        max(b.trading_date)::VARCHAR AS actual_end,
        count(b.instrument_id)::BIGINT AS records,
        string_agg(DISTINCT coalesce(b.upstream, b.provider), ',') AS sources,
        max(b.fetched_at)::VARCHAR AS last_fetched_at
      FROM (SELECT $instrument_id::VARCHAR AS instrument_id) i
      LEFT JOIN ${coverageTable} c
        ON c.instrument_id = i.instrument_id AND c.adjustment = 'none'
      LEFT JOIN ${barsTable} b
        ON b.instrument_id = i.instrument_id AND b.adjustment = 'none'
      GROUP BY c.requested_start, c.requested_end
    `, { instrument_id: instrumentId })
    const row = reader.getRowObjectsJson()[0] ?? {}
    const requestedStart = row.requested_start === null || row.requested_start === undefined
      ? null
      : String(row.requested_start)
    const requestedEnd = row.requested_end === null || row.requested_end === undefined
      ? null
      : String(row.requested_end)
    const actualStart = row.actual_start === null || row.actual_start === undefined
      ? null
      : String(row.actual_start)
    const actualEnd = row.actual_end === null || row.actual_end === undefined
      ? null
      : String(row.actual_end)
    const records = Number(row.records ?? 0)
    return {
      interval,
      requested_start: requestedStart,
      requested_end: requestedEnd,
      actual_start: actualStart,
      actual_end: actualEnd,
      records,
      sources: typeof row.sources === 'string' && row.sources
        ? row.sources.split(',').sort()
        : [],
      last_fetched_at: row.last_fetched_at === null || row.last_fetched_at === undefined
        ? null
        : String(row.last_fetched_at).replace(' ', 'T') + 'Z',
    }
  }

  async browseFuturesSeriesMembers(
    seriesId: string,
    start?: string,
    end?: string,
  ): Promise<readonly {
    trading_date: string
    contract_id: string
    contract_symbol: string
    selection_rule: string
    selection_metric: string
    selection_value: number
  }[]> {
    await this.ready
    const reader = await this.db.runAndReadAll(`
      SELECT trading_date::VARCHAR AS trading_date, contract_id, contract_symbol,
        selection_rule, selection_metric, selection_value
      FROM futures_series_members
      WHERE series_id = $series_id
        AND ($start = '' OR trading_date >= $start::DATE)
        AND ($end = '' OR trading_date <= $end::DATE)
      ORDER BY trading_date
    `, { series_id: seriesId, start: start ?? '', end: end ?? '' })
    return reader.getRowObjectsJson().map((row) => ({
      trading_date: String(row.trading_date),
      contract_id: String(row.contract_id),
      contract_symbol: String(row.contract_symbol),
      selection_rule: String(row.selection_rule),
      selection_metric: String(row.selection_metric),
      selection_value: Number(row.selection_value),
    }))
  }

  async start(
    request: DataSyncRequest,
    metadata: { trigger?: DataSyncRun['trigger']; scheduleId?: number } = {},
  ): Promise<DataSyncRun> {
    await this.ready
    if (this.activeRun) throw new Error('DATA_SYNC_ALREADY_RUNNING')
    if (!request.instrumentTypes.length) throw new Error('DATA_SYNC_TYPES_REQUIRED')
    if (!DATE_PATTERN.test(request.start) || !DATE_PATTERN.test(request.end)) {
      throw new Error('DATA_SYNC_INVALID_DATE')
    }
    if (request.adjustment !== 'none') {
      throw new Error('DATA_SYNC_REQUIRES_RAW_BARS')
    }
    if (request.start > request.end) throw new Error('DATA_SYNC_INVALID_RANGE')
    const catalog = await this.dependencies.loadInstruments()
    const eligible = this.syncInstruments(catalog, request.instrumentTypes)
    let instruments: readonly CatalogInstrument[]
    if (request.instrumentIds?.length) {
      const byId = new Map(eligible.map((instrument) => [instrument.instrumentId, instrument]))
      instruments = request.instrumentIds.flatMap((instrumentId) => {
        const instrument = byId.get(instrumentId)
        return instrument ? [instrument] : []
      })
      if (instruments.length !== request.instrumentIds.length) {
        throw new Error('DATA_SYNC_INSTRUMENTS_NOT_FOUND')
      }
    } else {
      instruments = eligible.slice(0, request.limit)
    }
    return this.createRun(request, instruments, {
      trigger: metadata.trigger ?? 'manual', scheduleId: metadata.scheduleId,
    })
  }

  private async createRun(
    request: DataSyncRequest,
    instruments: readonly CatalogInstrument[],
    metadata: { trigger: DataSyncRun['trigger']; scheduleId?: number; retryOfRunId?: string },
  ): Promise<DataSyncRun> {
    const run: DataSyncRun = {
      run_id: randomUUID(),
      trigger: metadata.trigger,
      schedule_id: metadata.scheduleId ?? null,
      retry_of_run_id: metadata.retryOfRunId ?? null,
      recovery_status: 'not_needed',
      retry_count: 0,
      latest_retry_run_id: null,
      remaining_failed: 0,
      status: 'running',
      instrument_types: [...request.instrumentTypes],
      instrument_ids: request.instrumentIds?.length ? [...request.instrumentIds] : null,
      interval: request.interval ?? '1d',
      start: request.start,
      end: request.end,
      adjustment: request.adjustment,
      limit: request.limit ?? null,
      delay_ms: request.delayMs ?? 0,
      lookback_days: request.lookbackDays ?? 10,
      total: instruments.length,
      completed: 0,
      succeeded: 0,
      failed: 0,
      bars_written: 0,
      current_instrument: null,
      started_at: new Date().toISOString(),
      finished_at: null,
      errors: [],
    }
    if (instruments.length === 0) {
      run.status = 'failed'
      run.finished_at = new Date().toISOString()
      run.errors = [{
        instrument_id: '', symbol: '', message: 'DATA_SYNC_NO_INSTRUMENTS',
      }]
      await this.persistRun(run)
      this.lastRun = run
      return run
    }
    this.activeRun = run
    this.cancelled = false
    await this.persistRun(run)
    await this.createRunItems(run.run_id, instruments)
    if (run.retry_of_run_id) await this.markRetryStarted(run.retry_of_run_id, run.run_id)
    this.launch(run, instruments)
    return run
  }

  async resume(): Promise<DataSyncRun> {
    await this.ready
    if (this.activeRun) throw new Error('DATA_SYNC_ALREADY_RUNNING')

    const previous = this.lastRun
    if (
      !previous ||
      !['cancelled', 'failed'].includes(previous.status) ||
      previous.completed >= previous.total
    ) {
      throw new Error('DATA_SYNC_NOT_RESUMABLE')
    }

    const eligible = this.syncInstruments(
      await this.dependencies.loadInstruments(), previous.instrument_types,
    )
    const byId = new Map(eligible.map((instrument) => [instrument.instrumentId, instrument]))
    const instruments = previous.instrument_ids?.length
      ? previous.instrument_ids.flatMap((instrumentId) => {
        const instrument = byId.get(instrumentId)
        return instrument ? [instrument] : []
      })
      : eligible.slice(0, previous.limit ?? undefined)
    if (instruments.length !== previous.total) {
      throw new Error('DATA_SYNC_CATALOG_CHANGED')
    }

    return this.createRun({
      instrumentTypes: previous.instrument_types, interval: previous.interval ?? '1d',
      ...(previous.instrument_ids ? { instrumentIds: previous.instrument_ids } : {}),
      start: previous.start, end: previous.end, adjustment: previous.adjustment,
      delayMs: previous.delay_ms, lookbackDays: previous.lookback_days,
    }, instruments.slice(previous.completed), { trigger: 'retry', retryOfRunId: previous.run_id })
  }

  private launch(
    run: DataSyncRun,
    instruments: readonly CatalogInstrument[],
  ): void {
    this.execution = this.execute(run, instruments)
      .catch(async (error: unknown) => {
        run.status = 'failed'
        run.current_instrument = null
        run.finished_at = new Date().toISOString()
        run.errors = [...run.errors, {
          instrument_id: '',
          symbol: '',
          message: error instanceof Error ? error.message : String(error),
        }].slice(-MAX_ERRORS)
        await this.persistRun(run)
        const source = run.retry_of_run_id ? await this.reconcileRetry(run) : null
        this.lastRun = source ?? run
        this.activeRun = null
      })
      .finally(() => {
        this.execution = null
        void this.runNextScheduledTask()
      })
  }

  private normalizeRun(stored: DataSyncRun, status?: unknown, finishedAt?: unknown): DataSyncRun {
    return {
      ...stored,
      trigger: stored.trigger ?? 'manual',
      schedule_id: stored.schedule_id ?? null,
      retry_of_run_id: stored.retry_of_run_id ?? null,
      recovery_status: stored.recovery_status ?? (stored.failed > 0 ? 'not_retried' : 'not_needed'),
      retry_count: stored.retry_count ?? 0,
      latest_retry_run_id: stored.latest_retry_run_id ?? null,
      remaining_failed: stored.remaining_failed ?? stored.failed,
      instrument_ids: stored.instrument_ids ?? null,
      interval: stored.interval ?? '1d',
      lookback_days: stored.lookback_days ?? 10,
      status: typeof status === 'string' ? status as DataSyncRun['status'] : stored.status,
      finished_at: this.timestamp(finishedAt) ?? stored.finished_at,
    }
  }

  private timestamp(value: unknown): string | null {
    return typeof value === 'string' ? value.replace(' ', 'T') + (value.includes('Z') ? '' : 'Z') : null
  }

  async readBars(request: {
    instrument: Pick<CatalogInstrument, 'instrumentId' | 'type' | 'currency'>
    interval?: DataSyncInterval
    adjustment: PriceAdjustment
    start?: string
    end?: string
    asOf?: string
  }): Promise<readonly ProviderBar[] | null> {
    await this.ready
    const instrumentId = request.instrument.instrumentId
    const interval = request.interval ?? '1d'
    const coverage = await this.coverage(instrumentId, 'none', interval)
    if (!coverage) return null
    if (request.start && request.start < coverage.start) return null
    if (request.end && request.end > coverage.end) return null
    let bars: readonly ProviderBar[]
    if (interval === '1m') {
      const storedRange = await this.storedRange(
        instrumentId,
        'none',
        interval,
      )
      if (!storedRange) return null
      // A requested boundary can fall on a weekend or market holiday. Ten days
      // covers those closures while still rejecting a provider that silently
      // returned only a recent slice of a multi-month minute request.
      if (request.start && storedRange.first > addDays(request.start, 10)) return null
      if (request.end && storedRange.last < subtractDays(request.end, 10)) return null
      const reader = await this.db.runAndReadAll(`
        SELECT
          trading_date::VARCHAR AS trading_date,
          period_start, period_end,
          open, high, low, close, volume, turnover, complete
        FROM minute_bars
        WHERE instrument_id = $instrument_id
          AND adjustment = 'none'
          AND ($start = '' OR trading_date >= $start::DATE)
          AND ($end = '' OR trading_date <= $end::DATE)
        ORDER BY period_start
      `, {
        instrument_id: instrumentId,
        start: request.start ?? '',
        end: request.end ?? '',
      })
      bars = reader.getRowObjectsJson().map((row): ProviderBar => ({
        source: 'local-duckdb',
        interval: '1m',
        tradingDate: String(row.trading_date),
        periodStart: String(row.period_start),
        periodEnd: String(row.period_end),
        currency: request.instrument.currency,
        open: String(row.open),
        high: String(row.high),
        low: String(row.low),
        close: String(row.close),
        volume: row.volume === null ? null : Number(row.volume),
        turnover: row.turnover === null ? null : String(row.turnover),
        adjustment: 'none',
        complete: Boolean(row.complete),
      }))
    } else {
      const reader = await this.db.runAndReadAll(`
        SELECT
          trading_date::VARCHAR AS trading_date,
          open, high, low, close, volume, turnover
        FROM daily_bars
        WHERE instrument_id = $instrument_id
          AND adjustment = 'none'
          AND ($start = '' OR trading_date >= $start::DATE)
          AND ($end = '' OR trading_date <= $end::DATE)
        ORDER BY trading_date
      `, {
        instrument_id: instrumentId,
        start: request.start ?? '',
        end: request.end ?? '',
      })
      bars = reader.getRowObjectsJson().map((row): ProviderBar => {
        const tradingDate = String(row.trading_date)
        const crypto = request.instrument.type === 'crypto'
        return {
          source: 'local-duckdb',
          interval: '1d',
          tradingDate,
          periodStart: crypto
            ? `${tradingDate}T00:00:00.000Z`
            : `${tradingDate}T00:00:00+08:00`,
          periodEnd: crypto
            ? `${addDays(tradingDate, 1)}T00:00:00.000Z`
            : `${tradingDate}T23:59:59+08:00`,
          currency: request.instrument.currency,
          open: String(row.open),
          high: String(row.high),
          low: String(row.low),
          close: String(row.close),
          volume: row.volume === null ? null : Number(row.volume),
          turnover: row.turnover === null ? null : String(row.turnover),
          adjustment: 'none',
          complete: true,
        }
      })
    }
    return this.adjustBars(instrumentId, bars, request.adjustment, request.asOf)
  }

  async adjustBars(
    instrumentId: string,
    bars: readonly ProviderBar[],
    adjustment: PriceAdjustment,
    asOf?: string,
  ): Promise<readonly ProviderBar[] | null> {
    await this.ready
    if (adjustment === 'none') return bars
    const anchorDate = asOf ?? new Date().toLocaleDateString('sv-SE', {
      timeZone: 'Asia/Shanghai',
    })
    if (!await this.hasAdjustmentFactorCoverage(instrumentId, anchorDate)) return null
    const reader = await this.db.runAndReadAll(`
      SELECT effective_date::VARCHAR AS effective_date, cumulative_factor
      FROM equity_adjustment_factors
      WHERE instrument_id = $instrument_id AND effective_date <= $as_of::DATE
      ORDER BY effective_date
    `, { instrument_id: instrumentId, as_of: anchorDate })
    const factors = reader.getRowObjectsJson().map((row) => ({
      date: String(row.effective_date),
      value: Number(row.cumulative_factor),
    }))
    const anchor = factors.at(-1)?.value ?? 1
    let factorIndex = -1
    let factor = 1
    return bars.map((bar): ProviderBar => {
      while (factors[factorIndex + 1]?.date <= bar.tradingDate) {
        factorIndex += 1
        factor = factors[factorIndex]!.value
      }
      return {
        ...bar,
        open: adjustedPrice(bar.open, factor, anchor, adjustment),
        high: adjustedPrice(bar.high, factor, anchor, adjustment),
        low: adjustedPrice(bar.low, factor, anchor, adjustment),
        close: adjustedPrice(bar.close, factor, anchor, adjustment),
        adjustment,
      }
    })
  }

  async hasAdjustmentFactorCoverage(
    instrumentId: string,
    asOf?: string,
  ): Promise<boolean> {
    await this.ready
    const anchorDate = asOf ?? new Date().toLocaleDateString('sv-SE', {
      timeZone: 'Asia/Shanghai',
    })
    const coverage = await this.db.runAndReadAll(`
      SELECT as_of_date::VARCHAR AS as_of_date
      FROM equity_adjustment_factor_coverage
      WHERE instrument_id = $instrument_id
    `, { instrument_id: instrumentId })
    const coveredAsOf = coverage.getRowObjectsJson()[0]?.as_of_date
    return typeof coveredAsOf === 'string' && coveredAsOf >= anchorDate
  }

  async readQuote(
    instrument: Pick<CatalogInstrument, 'instrumentId' | 'type' | 'currency'>,
  ): Promise<LocalQuote | null> {
    await this.ready
    const reader = await this.db.runAndReadAll(`
      SELECT
        trading_date::VARCHAR AS trading_date,
        open, high, low, close, volume, turnover,
        fetched_at::VARCHAR AS fetched_at
      FROM daily_bars
      WHERE instrument_id = $instrument_id AND adjustment = 'none'
      ORDER BY trading_date DESC
      LIMIT 2
    `, { instrument_id: instrument.instrumentId })
    const rows = reader.getRowObjectsJson()
    const latest = rows[0]
    if (!latest) return null
    const tradingDate = String(latest.trading_date)
    const fetchedAt = String(latest.fetched_at).replace(' ', 'T')
    return {
      marketTime: instrument.type === 'crypto'
        ? `${addDays(tradingDate, 1)}T00:00:00.000Z`
        : `${tradingDate}T15:00:00+08:00`,
      observedAt: fetchedAt.endsWith('Z') ? fetchedAt : `${fetchedAt}Z`,
      currency: instrument.currency,
      last: String(latest.close),
      open: String(latest.open),
      high: String(latest.high),
      low: String(latest.low),
      previousClose: rows[1] ? String(rows[1].close) : null,
      volume: latest.volume === null ? null : Number(latest.volume),
      turnover: latest.turnover === null ? null : String(latest.turnover),
    }
  }

  async storeBars(
    instrument: CatalogInstrument,
    result: SyncedBars,
    request: {
      interval?: DataSyncInterval
      start?: string
      end?: string
      adjustment: PriceAdjustment
    },
  ): Promise<void> {
    await this.writes.run(async () => {
      await this.ready
      if (request.adjustment !== 'none') {
        throw new Error('ONLY_RAW_BARS_CAN_BE_STORED')
      }
      const interval = request.interval ?? '1d'
      await this.upsertInstrument(instrument)
      await this.upsertBars(instrument, result, request.adjustment, interval)
      if (request.start && request.end) {
        await this.updateCoverage(
          instrument.instrumentId,
          request.adjustment,
          interval,
          request.start,
          request.end,
        )
      }
    })
  }

  async storeAdjustmentFactors(
    instrument: CatalogInstrument,
    result: SyncedAdjustmentFactors,
  ): Promise<void> {
    await this.writes.run(async () => {
      await this.ready
      if (instrument.type !== 'equity') {
        throw new Error('ADJUSTMENT_FACTORS_REQUIRE_EQUITY')
      }
      await this.upsertInstrument(instrument)
      await this.upsertAdjustmentFactors(instrument.instrumentId, result)
    })
  }

  async localDataSources() {
    await this.ready
    const reader = await this.db.runAndReadAll(`
      SELECT instrument_type, sum(records)::BIGINT AS records,
             max(has_minute)::INTEGER AS has_minute
      FROM (
        SELECT instrument_type, count(*)::BIGINT AS records, 0 AS has_minute
        FROM daily_bars GROUP BY instrument_type
        UNION ALL
        SELECT instrument_type, count(*)::BIGINT AS records, 1 AS has_minute
        FROM minute_bars GROUP BY instrument_type
      ) counts
      GROUP BY instrument_type
    `)
    const counts = new Map(reader.getRowObjectsJson().map((row) => [
      String(row.instrument_type),
      { records: Number(row.records), hasMinute: Number(row.has_minute) === 1 },
    ] as const))
    const checkedAt = new Date().toISOString()
    return (['equity', 'index', 'future', 'crypto'] as const).map((category) => ({
      provider_id: 'local-duckdb',
      source_id: 'local',
      source_name: '本地 DuckDB',
      category,
      status: 'healthy' as const,
      capabilities: counts.get(category)?.hasMinute
        ? ['日线', '分时', '行情快照']
        : ['日线', '行情快照'],
      last_checked_at: checkedAt,
      last_success_at: checkedAt,
      latency_ms: 0,
      records_checked: counts.get(category)?.records ?? 0,
      error: null,
    }))
  }

  cancel(): DataSyncRun | null {
    if (!this.activeRun) return null
    this.cancelled = true
    return this.activeRun
  }

  async close(): Promise<void> {
    await this.ready
    for (const timer of this.scheduleTimers.values()) clearTimeout(timer)
    this.scheduleTimers.clear()
    this.cancelled = true
    await this.execution
    this.connection?.closeSync()
    this.connection = undefined
    this.instance?.closeSync()
    this.instance = undefined
  }

  private get db(): DuckDBConnection {
    if (!this.connection) throw new Error('data sync database is closed')
    return this.connection
  }

  private async initialize(): Promise<void> {
    this.instance = await DuckDBInstance.create(this.dependencies.databasePath)
    this.connection = await this.instance.connect()
    await this.db.run(`
      CREATE TABLE IF NOT EXISTS instruments (
        instrument_id VARCHAR PRIMARY KEY,
        instrument_type VARCHAR NOT NULL,
        symbol VARCHAR NOT NULL,
        name VARCHAR NOT NULL,
        venue VARCHAR,
        publisher VARCHAR,
        status VARCHAR NOT NULL,
        updated_at TIMESTAMP NOT NULL
      );
      CREATE TABLE IF NOT EXISTS daily_bars (
        instrument_id VARCHAR NOT NULL,
        instrument_type VARCHAR NOT NULL,
        trading_date DATE NOT NULL,
        open DOUBLE NOT NULL,
        high DOUBLE NOT NULL,
        low DOUBLE NOT NULL,
        close DOUBLE NOT NULL,
        volume DOUBLE,
        turnover DOUBLE,
        adjustment VARCHAR NOT NULL,
        provider VARCHAR NOT NULL,
        upstream VARCHAR,
        fetched_at TIMESTAMP NOT NULL,
        PRIMARY KEY (instrument_id, trading_date, adjustment)
      );
      CREATE TABLE IF NOT EXISTS minute_bars (
        instrument_id VARCHAR NOT NULL,
        instrument_type VARCHAR NOT NULL,
        trading_date DATE NOT NULL,
        period_start VARCHAR NOT NULL,
        period_end VARCHAR NOT NULL,
        open DOUBLE NOT NULL,
        high DOUBLE NOT NULL,
        low DOUBLE NOT NULL,
        close DOUBLE NOT NULL,
        volume DOUBLE,
        turnover DOUBLE,
        adjustment VARCHAR NOT NULL,
        complete BOOLEAN NOT NULL,
        provider VARCHAR NOT NULL,
        upstream VARCHAR,
        fetched_at TIMESTAMP NOT NULL,
        PRIMARY KEY (instrument_id, period_start, adjustment)
      );
      CREATE TABLE IF NOT EXISTS equity_adjustment_factors (
        instrument_id VARCHAR NOT NULL,
        effective_date DATE NOT NULL,
        cumulative_factor DECIMAL(30, 15) NOT NULL,
        provider VARCHAR NOT NULL,
        upstream VARCHAR,
        fetched_at TIMESTAMP NOT NULL,
        PRIMARY KEY (instrument_id, effective_date)
      );
      CREATE TABLE IF NOT EXISTS equity_adjustment_factor_coverage (
        instrument_id VARCHAR PRIMARY KEY,
        as_of_date DATE NOT NULL,
        provider VARCHAR NOT NULL,
        upstream VARCHAR,
        fetched_at TIMESTAMP NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sync_runs (
        run_id VARCHAR PRIMARY KEY,
        status VARCHAR NOT NULL,
        payload JSON NOT NULL,
        started_at TIMESTAMP NOT NULL,
        finished_at TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS sync_run_items (
        run_id VARCHAR NOT NULL,
        instrument_id VARCHAR NOT NULL,
        symbol VARCHAR NOT NULL,
        name VARCHAR NOT NULL,
        status VARCHAR NOT NULL,
        bars_written BIGINT NOT NULL,
        error VARCHAR,
        started_at TIMESTAMP,
        finished_at TIMESTAMP,
        PRIMARY KEY (run_id, instrument_id)
      );
      CREATE TABLE IF NOT EXISTS sync_coverage (
        instrument_id VARCHAR NOT NULL,
        adjustment VARCHAR NOT NULL,
        requested_start DATE NOT NULL,
        requested_end DATE NOT NULL,
        updated_at TIMESTAMP NOT NULL,
        PRIMARY KEY (instrument_id, adjustment)
      );
      CREATE TABLE IF NOT EXISTS futures_series_members (
        series_id VARCHAR NOT NULL,
        trading_date DATE NOT NULL,
        contract_id VARCHAR NOT NULL,
        contract_symbol VARCHAR NOT NULL,
        selection_rule VARCHAR NOT NULL,
        selection_metric VARCHAR NOT NULL,
        selection_value DOUBLE NOT NULL,
        provider VARCHAR NOT NULL,
        upstream VARCHAR,
        updated_at TIMESTAMP NOT NULL,
        PRIMARY KEY (series_id, trading_date)
      );
      CREATE TABLE IF NOT EXISTS minute_sync_coverage (
        instrument_id VARCHAR NOT NULL,
        adjustment VARCHAR NOT NULL,
        requested_start DATE NOT NULL,
        requested_end DATE NOT NULL,
        updated_at TIMESTAMP NOT NULL,
        PRIMARY KEY (instrument_id, adjustment)
      );
      CREATE TABLE IF NOT EXISTS sync_schedule (
        id INTEGER PRIMARY KEY,
        payload JSON NOT NULL,
        updated_at TIMESTAMP NOT NULL
      );
      CREATE TEMP TABLE IF NOT EXISTS staged_daily_bars (
        instrument_id VARCHAR,
        instrument_type VARCHAR,
        trading_date VARCHAR,
        open VARCHAR,
        high VARCHAR,
        low VARCHAR,
        close VARCHAR,
        volume VARCHAR,
        turnover VARCHAR,
        adjustment VARCHAR,
        provider VARCHAR,
        upstream VARCHAR,
        fetched_at VARCHAR
      );
      CREATE TEMP TABLE IF NOT EXISTS staged_minute_bars (
        instrument_id VARCHAR,
        instrument_type VARCHAR,
        trading_date VARCHAR,
        period_start VARCHAR,
        period_end VARCHAR,
        open VARCHAR,
        high VARCHAR,
        low VARCHAR,
        close VARCHAR,
        volume VARCHAR,
        turnover VARCHAR,
        adjustment VARCHAR,
        complete VARCHAR,
        provider VARCHAR,
        upstream VARCHAR,
        fetched_at VARCHAR
      );
      CREATE TEMP TABLE IF NOT EXISTS staged_adjustment_factors (
        instrument_id VARCHAR,
        effective_date VARCHAR,
        cumulative_factor VARCHAR,
        provider VARCHAR,
        upstream VARCHAR,
        fetched_at VARCHAR
      );
    `)
    const volumeColumns = await this.db.runAndReadAll(`
      SELECT table_name, data_type
      FROM information_schema.columns
      WHERE table_name IN ('daily_bars', 'minute_bars') AND column_name = 'volume'
    `)
    for (const row of volumeColumns.getRowObjectsJson()) {
      if (row.data_type === 'DOUBLE') continue
      const table = String(row.table_name)
      if (table !== 'daily_bars' && table !== 'minute_bars') continue
      await this.db.run(`ALTER TABLE ${table} ALTER COLUMN volume SET DATA TYPE DOUBLE`)
    }
    await this.db.run(`
      UPDATE sync_runs
      SET status = 'cancelled', finished_at = current_timestamp,
          payload = json_merge_patch(payload, '{"status":"cancelled"}')
      WHERE status = 'running'
    `)
    const latest = await this.db.runAndReadAll(`
      SELECT status, payload::VARCHAR AS payload, finished_at::VARCHAR AS finished_at
      FROM sync_runs
      ORDER BY coalesce(finished_at, started_at) DESC
      LIMIT 1
    `)
    const latestRow = latest.getRowObjectsJson()[0]
    if (typeof latestRow?.payload === 'string') {
      const storedRun = JSON.parse(latestRow.payload) as DataSyncRun
      this.lastRun = this.normalizeRun(storedRun, latestRow.status, latestRow.finished_at)
    }
    const scheduleReader = await this.db.runAndReadAll(`
      SELECT id, payload::VARCHAR AS payload FROM sync_schedule ORDER BY id
    `)
    for (const row of scheduleReader.getRowObjectsJson()) {
      if (typeof row.payload !== 'string') continue
      const stored = JSON.parse(row.payload) as Partial<DataSyncSchedule> & { start?: string }
      if (stored.enabled === false) continue
      const { start: _legacyStart, ...current } = stored
      const scheduleId = Number(row.id)
      this.schedules.set(scheduleId, {
        schedule_id: scheduleId,
        enabled: true,
        time: '18:00',
        instrument_types: ['equity', 'index', 'future'],
        instrument_ids: null,
        adjustment: 'none',
        delay_ms: 750,
        next_run_at: null,
        last_triggered_at: null,
        ...current,
        interval: stored.interval ?? '1d',
        skip_weekends: stored.skip_weekends ?? false,
        lookback_days: stored.lookback_days ?? 10,
      })
    }
    for (const scheduleId of this.schedules.keys()) this.configureScheduleTimer(scheduleId)
  }

  private configureScheduleTimer(scheduleId: number): void {
    const existingTimer = this.scheduleTimers.get(scheduleId)
    if (existingTimer) clearTimeout(existingTimer)
    this.scheduleTimers.delete(scheduleId)
    const schedule = this.schedules.get(scheduleId)
    if (!schedule) return
    if (!schedule.enabled) {
      this.schedules.set(scheduleId, { ...schedule, next_run_at: null })
      return
    }
    const next = nextDataSyncRun(new Date(), schedule.time, schedule.skip_weekends)
    this.schedules.set(scheduleId, { ...schedule, next_run_at: next.toISOString() })
    const timer = setTimeout(() => void this.triggerSchedule(scheduleId), next.getTime() - Date.now())
    timer.unref()
    this.scheduleTimers.set(scheduleId, timer)
  }

  private async triggerSchedule(scheduleId: number): Promise<void> {
    const schedule = this.schedules.get(scheduleId)
    if (!schedule) return
    this.schedules.set(scheduleId, { ...schedule, last_triggered_at: new Date().toISOString() })
    this.configureScheduleTimer(scheduleId)
    await this.persistSchedule(scheduleId)
    if (!this.pendingScheduleIds.includes(scheduleId)) this.pendingScheduleIds.push(scheduleId)
    await this.runNextScheduledTask()
  }

  private async runNextScheduledTask(): Promise<void> {
    if (this.activeRun) return
    while (this.pendingScheduleIds.length > 0) {
      const scheduleId = this.pendingScheduleIds.shift()!
      const schedule = this.schedules.get(scheduleId)
      if (!schedule) continue
      const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })
      const start = schedule.interval === '1m' ? subtractDays(today, 92) : '1990-01-01'
      try {
        await this.dependencies.refreshInstruments()
        await this.start({
          instrumentTypes: schedule.instrument_types,
          ...(schedule.instrument_ids ? { instrumentIds: schedule.instrument_ids } : {}),
          interval: schedule.interval,
          start,
          end: today,
          adjustment: schedule.adjustment,
          delayMs: schedule.delay_ms,
          lookbackDays: schedule.lookback_days,
        }, { trigger: 'scheduled', scheduleId })
        return
      } catch (error) {
        process.stderr.write(`[data-sync-schedule] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
      }
    }
  }

  private async persistSchedule(scheduleId: number): Promise<void> {
    const schedule = this.schedules.get(scheduleId)
    if (!schedule) return
    await this.db.run(`
      INSERT INTO sync_schedule VALUES ($schedule_id, $payload::JSON, current_timestamp)
      ON CONFLICT (id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
    `, { schedule_id: scheduleId, payload: JSON.stringify(schedule) })
  }

  private async execute(
    run: DataSyncRun,
    instruments: readonly CatalogInstrument[],
  ): Promise<void> {
    for (const [index, instrument] of instruments.entries()) {
      if (this.cancelled) break
      run.current_instrument = {
        instrument_id: instrument.instrumentId,
        symbol: instrument.symbol,
        name: instrument.name,
      }
      await this.updateRunItem(run.run_id, instrument.instrumentId, {
        status: 'running', startedAt: new Date().toISOString(),
      })
      try {
        const [storedRange, coveredStart] = await Promise.all([
          this.storedRange(instrument.instrumentId, run.adjustment, run.interval),
          this.coveredStart(instrument.instrumentId, run.adjustment, run.interval),
        ])
        const start = storedRange && coveredStart && run.start >= coveredStart
          ? laterDate(run.start, subtractDays(storedRange.last, run.lookback_days))
          : run.start
        const [result, adjustmentFactors] = await Promise.all([
          this.dependencies.loadBars(instrument, {
            interval: run.interval,
            start,
            end: run.end,
            adjustment: 'none',
          }),
          instrument.type === 'equity' && run.interval === '1d'
            ? this.dependencies.loadAdjustmentFactors(instrument)
            : null,
        ])
        await this.writes.run(async () => {
          await this.upsertInstrument(instrument)
          await this.upsertBars(instrument, result, run.adjustment, run.interval)
          if (FUTURES_SERIES_ID.test(instrument.instrumentId)) {
            await this.db.run(`
              DELETE FROM futures_series_members WHERE series_id = $series_id
            `, { series_id: instrument.instrumentId })
          }
          if (adjustmentFactors) {
            await this.upsertAdjustmentFactors(instrument.instrumentId, adjustmentFactors)
          }
          await this.updateCoverage(
            instrument.instrumentId,
            run.adjustment,
            run.interval,
            run.start,
            run.end,
          )
        })
        run.succeeded += 1
        run.bars_written += result.bars.length
        await this.updateRunItem(run.run_id, instrument.instrumentId, {
          status: 'completed', barsWritten: result.bars.length, finishedAt: new Date().toISOString(),
        })
      } catch (error) {
        run.failed += 1
        const message = error instanceof Error ? error.message : String(error)
        await this.updateRunItem(run.run_id, instrument.instrumentId, {
          status: 'failed', error: message, finishedAt: new Date().toISOString(),
        })
        if (run.errors.length < MAX_ERRORS) {
          run.errors = [...run.errors, {
            instrument_id: instrument.instrumentId,
            symbol: instrument.symbol,
            message,
          }]
        }
      }
      run.completed += 1
      await this.persistRun(run)
      if (
        !this.cancelled &&
        index < instruments.length - 1 &&
        run.delay_ms > 0
      ) {
        await new Promise((resolve) => setTimeout(resolve, run.delay_ms))
      }
    }
    run.current_instrument = null
    run.status = this.cancelled
      ? 'cancelled'
      : run.failed > 0
        ? 'completed_with_errors'
        : 'completed'
    run.recovery_status = run.failed > 0 ? 'not_retried' : 'not_needed'
    run.remaining_failed = run.failed
    run.finished_at = new Date().toISOString()
    if (this.cancelled) {
      await this.db.run(`
        UPDATE sync_run_items SET status = 'cancelled', finished_at = current_timestamp
        WHERE run_id = $run_id AND status = 'pending'
      `, { run_id: run.run_id })
    }
    await this.persistRun(run)
    const source = run.retry_of_run_id ? await this.reconcileRetry(run) : null
    this.lastRun = source ?? run
    this.activeRun = null
  }

  private async upsertInstrument(instrument: CatalogInstrument): Promise<void> {
    await this.db.run(`
      INSERT INTO instruments VALUES (
        $instrument_id, $instrument_type, $symbol, $name,
        nullif($venue, ''), nullif($publisher, ''), $status, current_timestamp
      )
      ON CONFLICT (instrument_id) DO UPDATE SET
        instrument_type = excluded.instrument_type,
        symbol = excluded.symbol,
        name = excluded.name,
        venue = excluded.venue,
        publisher = excluded.publisher,
        status = excluded.status,
        updated_at = excluded.updated_at
    `, {
      instrument_id: instrument.instrumentId,
      instrument_type: instrument.type,
      symbol: instrument.symbol,
      name: instrument.name,
      venue: instrument.venue ?? '',
      publisher: instrument.publisher ?? '',
      status: instrument.status,
    })
  }

  private async storedRange(
    instrumentId: string,
    adjustment: PriceAdjustment,
    interval: DataSyncInterval,
  ): Promise<{ first: string; last: string } | null> {
    const table = interval === '1m' ? 'minute_bars' : 'daily_bars'
    const reader = await this.db.runAndReadAll(`
      SELECT
        min(trading_date)::VARCHAR AS first_trading_date,
        max(trading_date)::VARCHAR AS last_trading_date
      FROM ${table}
      WHERE instrument_id = $instrument_id AND adjustment = $adjustment
    `, { instrument_id: instrumentId, adjustment })
    const row = reader.getRowObjectsJson()[0]
    return typeof row?.first_trading_date === 'string' &&
      typeof row.last_trading_date === 'string'
      ? { first: row.first_trading_date, last: row.last_trading_date }
      : null
  }

  private async coveredStart(
    instrumentId: string,
    adjustment: PriceAdjustment,
    interval: DataSyncInterval,
  ): Promise<string | null> {
    const table = interval === '1m' ? 'minute_sync_coverage' : 'sync_coverage'
    const reader = await this.db.runAndReadAll(`
      SELECT requested_start::VARCHAR AS requested_start
      FROM ${table}
      WHERE instrument_id = $instrument_id AND adjustment = $adjustment
    `, { instrument_id: instrumentId, adjustment })
    const value = reader.getRowObjectsJson()[0]?.requested_start
    return typeof value === 'string' ? value : null
  }

  private async coverage(
    instrumentId: string,
    adjustment: PriceAdjustment,
    interval: DataSyncInterval,
  ): Promise<{ start: string; end: string } | null> {
    const table = interval === '1m' ? 'minute_sync_coverage' : 'sync_coverage'
    const reader = await this.db.runAndReadAll(`
      SELECT
        requested_start::VARCHAR AS requested_start,
        requested_end::VARCHAR AS requested_end
      FROM ${table}
      WHERE instrument_id = $instrument_id AND adjustment = $adjustment
    `, { instrument_id: instrumentId, adjustment })
    const row = reader.getRowObjectsJson()[0]
    return typeof row?.requested_start === 'string' &&
      typeof row.requested_end === 'string'
      ? { start: row.requested_start, end: row.requested_end }
      : null
  }

  private async updateCoverage(
    instrumentId: string,
    adjustment: PriceAdjustment,
    interval: DataSyncInterval,
    start: string,
    end: string,
  ): Promise<void> {
    const table = interval === '1m' ? 'minute_sync_coverage' : 'sync_coverage'
    await this.db.run(`
      INSERT INTO ${table} VALUES (
        $instrument_id, $adjustment, $start::DATE, $end::DATE, current_timestamp
      )
      ON CONFLICT (instrument_id, adjustment) DO UPDATE SET
        requested_start = least(${table}.requested_start, excluded.requested_start),
        requested_end = greatest(${table}.requested_end, excluded.requested_end),
        updated_at = excluded.updated_at
    `, {
      instrument_id: instrumentId,
      adjustment,
      start,
      end,
    })
  }

  private async upsertBars(
    instrument: CatalogInstrument,
    result: SyncedBars,
    adjustment: PriceAdjustment,
    interval: DataSyncInterval,
  ): Promise<void> {
    if (!result.bars.length) return
    if (result.bars.some((bar) => bar.interval !== interval)) {
      throw new Error('DATA_SYNC_INTERVAL_MISMATCH')
    }
    if (interval === '1m') {
      await this.upsertMinuteBars(instrument, result, adjustment)
      return
    }
    await this.db.run('DELETE FROM staged_daily_bars')
    const appender = await this.db.createAppender('staged_daily_bars')
    const fetchedAt = new Date().toISOString()
    for (const bar of result.bars) {
      const values = [
        instrument.instrumentId,
        instrument.type,
        bar.tradingDate,
        bar.open,
        bar.high,
        bar.low,
        bar.close,
        bar.volume === null ? null : String(bar.volume),
        bar.turnover,
        adjustment,
        result.provider,
        result.upstream ?? bar.source ?? null,
        fetchedAt,
      ]
      for (const value of values) {
        if (value === null) appender.appendNull()
        else appender.appendVarchar(value)
      }
      appender.endRow()
    }
    appender.flushSync()
    appender.closeSync()
    await this.db.run(`
      INSERT INTO daily_bars
      SELECT
        instrument_id, instrument_type, trading_date::DATE,
        open::DOUBLE, high::DOUBLE, low::DOUBLE, close::DOUBLE,
        volume::DOUBLE, turnover::DOUBLE, adjustment, provider, upstream,
        fetched_at::TIMESTAMP
      FROM staged_daily_bars
      ON CONFLICT (instrument_id, trading_date, adjustment) DO UPDATE SET
        instrument_type = excluded.instrument_type,
        open = excluded.open,
        high = excluded.high,
        low = excluded.low,
        close = excluded.close,
        volume = excluded.volume,
        turnover = excluded.turnover,
        provider = excluded.provider,
        upstream = excluded.upstream,
        fetched_at = excluded.fetched_at
    `)
  }

  private async upsertMinuteBars(
    instrument: CatalogInstrument,
    result: SyncedBars,
    adjustment: PriceAdjustment,
  ): Promise<void> {
    await this.db.run('DELETE FROM staged_minute_bars')
    const appender = await this.db.createAppender('staged_minute_bars')
    const fetchedAt = new Date().toISOString()
    for (const bar of result.bars) {
      const values = [
        instrument.instrumentId,
        instrument.type,
        bar.tradingDate,
        bar.periodStart,
        bar.periodEnd,
        bar.open,
        bar.high,
        bar.low,
        bar.close,
        bar.volume === null ? null : String(bar.volume),
        bar.turnover,
        adjustment,
        String(bar.complete),
        result.provider,
        result.upstream ?? bar.source ?? null,
        fetchedAt,
      ]
      for (const value of values) {
        if (value === null) appender.appendNull()
        else appender.appendVarchar(value)
      }
      appender.endRow()
    }
    appender.flushSync()
    appender.closeSync()
    await this.db.run(`
      INSERT INTO minute_bars
      SELECT
        instrument_id, instrument_type, trading_date::DATE,
        period_start, period_end,
        open::DOUBLE, high::DOUBLE, low::DOUBLE, close::DOUBLE,
        volume::DOUBLE, turnover::DOUBLE, adjustment, complete::BOOLEAN,
        provider, upstream, fetched_at::TIMESTAMP
      FROM staged_minute_bars
      ON CONFLICT (instrument_id, period_start, adjustment) DO UPDATE SET
        instrument_type = excluded.instrument_type,
        trading_date = excluded.trading_date,
        period_end = excluded.period_end,
        open = excluded.open,
        high = excluded.high,
        low = excluded.low,
        close = excluded.close,
        volume = excluded.volume,
        turnover = excluded.turnover,
        complete = excluded.complete,
        provider = excluded.provider,
        upstream = excluded.upstream,
        fetched_at = excluded.fetched_at
    `)
  }

  private async upsertAdjustmentFactors(
    instrumentId: string,
    result: SyncedAdjustmentFactors,
  ): Promise<void> {
    if (!DATE_PATTERN.test(result.asOfDate)) {
      throw new Error('INVALID_ADJUSTMENT_FACTOR_AS_OF_DATE')
    }
    await this.db.run('DELETE FROM staged_adjustment_factors')
    const appender = await this.db.createAppender('staged_adjustment_factors')
    const fetchedAt = new Date().toISOString()
    for (const factor of result.factors) {
      if (!DATE_PATTERN.test(factor.effectiveDate) ||
        !Number.isFinite(Number(factor.cumulativeFactor)) ||
        Number(factor.cumulativeFactor) <= 0) {
        appender.closeSync()
        throw new Error('INVALID_ADJUSTMENT_FACTOR')
      }
      for (const value of [
        instrumentId,
        factor.effectiveDate,
        factor.cumulativeFactor,
        result.provider,
        result.upstream ?? factor.source ?? null,
        fetchedAt,
      ]) {
        if (value === null) appender.appendNull()
        else appender.appendVarchar(value)
      }
      appender.endRow()
    }
    appender.flushSync()
    appender.closeSync()
    await this.db.run('BEGIN TRANSACTION')
    try {
      await this.db.run(`
        DELETE FROM equity_adjustment_factors
        WHERE instrument_id = $instrument_id
      `, { instrument_id: instrumentId })
      await this.db.run(`
        INSERT INTO equity_adjustment_factors
        SELECT instrument_id, effective_date::DATE,
          cumulative_factor::DECIMAL(30, 15), provider, upstream,
          fetched_at::TIMESTAMP
        FROM staged_adjustment_factors
      `)
      await this.db.run(`
        INSERT INTO equity_adjustment_factor_coverage VALUES (
          $instrument_id, $as_of_date::DATE, $provider, $upstream,
          $fetched_at::TIMESTAMP
        )
        ON CONFLICT (instrument_id) DO UPDATE SET
          as_of_date = excluded.as_of_date,
          provider = excluded.provider,
          upstream = excluded.upstream,
          fetched_at = excluded.fetched_at
      `, {
        instrument_id: instrumentId,
        as_of_date: result.asOfDate,
        provider: result.provider,
        upstream: result.upstream ?? null,
        fetched_at: fetchedAt,
      })
      await this.db.run('COMMIT')
    } catch (error) {
      await this.db.run('ROLLBACK')
      throw error
    }
  }

  private async persistRun(run: DataSyncRun): Promise<void> {
    await this.db.run(`
      INSERT INTO sync_runs VALUES (
        $run_id, $status, $payload::JSON, $started_at::TIMESTAMP,
        nullif($finished_at, '')::TIMESTAMP
      )
      ON CONFLICT (run_id) DO UPDATE SET
        status = excluded.status,
        payload = excluded.payload,
        finished_at = excluded.finished_at
    `, {
      run_id: run.run_id,
      status: run.status,
      payload: JSON.stringify(run),
      started_at: run.started_at,
      finished_at: run.finished_at ?? '',
    })
  }

  private async readRun(runId: string): Promise<DataSyncRun | null> {
    const reader = await this.db.runAndReadAll(`
      SELECT status, payload::VARCHAR AS payload, finished_at::VARCHAR AS finished_at
      FROM sync_runs WHERE run_id = $run_id
    `, { run_id: runId })
    const row = reader.getRowObjectsJson()[0]
    return typeof row?.payload === 'string'
      ? this.normalizeRun(JSON.parse(row.payload) as DataSyncRun, row.status, row.finished_at)
      : null
  }

  private async markRetryStarted(sourceRunId: string, retryRunId: string): Promise<void> {
    let currentId: string | null = sourceRunId
    while (currentId) {
      const source = await this.readRun(currentId)
      if (!source) return
      source.status = 'running'
      source.recovery_status = 'retrying'
      source.retry_count += 1
      source.latest_retry_run_id = retryRunId
      source.finished_at = null
      await this.persistRun(source)
      if (this.lastRun?.run_id === source.run_id) this.lastRun = source
      currentId = source.retry_of_run_id
    }
  }

  private async reconcileRetry(retryRun: DataSyncRun): Promise<DataSyncRun | null> {
    const completedItems = (await this.runItems(retryRun.run_id))
      .filter((item) => item.status === 'completed')
    const completedIds = new Set(completedItems.map((item) => item.instrument_id))
    let currentId = retryRun.retry_of_run_id
    let root: DataSyncRun | null = null
    while (currentId) {
      const source = await this.readRun(currentId)
      if (!source) return root
      if (completedItems.length) {
        for (const item of completedItems) {
          await this.db.run(`
            UPDATE sync_run_items SET status = 'recovered', bars_written = $bars_written,
              error = null, finished_at = nullif($finished_at, '')::TIMESTAMP
            WHERE run_id = $run_id AND status IN ('failed', 'cancelled')
              AND instrument_id = $instrument_id
          `, {
            run_id: source.run_id, instrument_id: item.instrument_id,
            bars_written: item.bars_written, finished_at: item.finished_at ?? '',
          })
        }
      }
      const sourceItems = await this.runItems(source.run_id)
      const remaining = sourceItems.length
        ? sourceItems.filter((item) => item.status === 'failed').length
        : Math.max(source.remaining_failed - completedIds.size, 0)
      source.remaining_failed = remaining
      source.recovery_status = remaining === 0 ? 'recovered' : 'partially_recovered'
      source.latest_retry_run_id = retryRun.run_id
      source.status = remaining === 0 ? 'completed' : 'completed_with_errors'
      source.failed = remaining
      source.succeeded = sourceItems.length
        ? sourceItems.filter((item) => item.status === 'completed' || item.status === 'recovered').length
        : Math.min(source.succeeded + completedIds.size, source.total)
      source.completed = source.succeeded + source.failed
      source.bars_written += retryRun.bars_written
      source.errors = source.errors.filter((error) => !completedIds.has(error.instrument_id))
      source.finished_at = retryRun.finished_at
      await this.persistRun(source)
      if (this.lastRun?.run_id === source.run_id) this.lastRun = source
      root = source
      currentId = source.retry_of_run_id
    }
    return root
  }

  private async retrySourcePresentation(retryRun: DataSyncRun): Promise<DataSyncRun> {
    let source = retryRun
    while (source.retry_of_run_id) {
      const parent = await this.readRun(source.retry_of_run_id)
      if (!parent) break
      source = parent
    }
    return {
      ...source,
      status: retryRun.status === 'running' ? 'running' : source.status,
      current_instrument: retryRun.current_instrument,
    }
  }

  private async createRunItems(
    runId: string,
    instruments: readonly CatalogInstrument[],
  ): Promise<void> {
    for (const instrument of instruments) {
      await this.db.run(`
        INSERT INTO sync_run_items VALUES (
          $run_id, $instrument_id, $symbol, $name, 'pending', 0, null, null, null
        )
      `, {
        run_id: runId, instrument_id: instrument.instrumentId,
        symbol: instrument.symbol, name: instrument.name,
      })
    }
  }

  private async updateRunItem(
    runId: string,
    instrumentId: string,
    update: {
      status: DataSyncRunItem['status']
      barsWritten?: number
      error?: string
      startedAt?: string
      finishedAt?: string
    },
  ): Promise<void> {
    await this.db.run(`
      UPDATE sync_run_items SET status = $status,
        bars_written = coalesce($bars_written, bars_written), error = $error,
        started_at = coalesce($started_at::TIMESTAMP, started_at),
        finished_at = nullif($finished_at, '')::TIMESTAMP
      WHERE run_id = $run_id AND instrument_id = $instrument_id
    `, {
      run_id: runId, instrument_id: instrumentId, status: update.status,
      bars_written: update.barsWritten ?? null, error: update.error ?? null,
      started_at: update.startedAt ?? null, finished_at: update.finishedAt ?? '',
    })
  }
}
