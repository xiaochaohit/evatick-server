import { randomUUID } from 'node:crypto'

import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api'

import type {
  BarInterval,
  CatalogInstrument,
  InstrumentType,
  PriceAdjustment,
  ProviderBar,
} from '@evatick/core'

export type DataSyncInterval = Extract<BarInterval, '1m' | '1d'>

export interface DataSyncRequest {
  interval?: DataSyncInterval
  instrumentTypes: readonly InstrumentType[]
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

export interface DataSyncRun {
  run_id: string
  status: 'running' | 'completed' | 'completed_with_errors' | 'cancelled' | 'failed'
  instrument_types: readonly InstrumentType[]
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

export interface DataSyncStatus {
  database_path: string
  storage: {
    instruments: number
    daily_bars: number
    minute_bars: number
    first_trading_date: string | null
    last_trading_date: string | null
    first_minute_trading_date: string | null
    last_minute_trading_date: string | null
  }
  active_run: DataSyncRun | null
  last_run: DataSyncRun | null
  schedule: DataSyncSchedule
}

export interface DataSyncSchedule {
  enabled: boolean
  interval: DataSyncInterval
  time: string
  skip_weekends: boolean
  instrument_types: readonly InstrumentType[]
  lookback_days: number
  adjustment: PriceAdjustment
  delay_ms: number
  next_run_at: string | null
  last_triggered_at: string | null
}

export interface LocalQuote {
  marketTime: string
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
  first_trading_date: string
  last_trading_date: string
  latest_close: string
}

export interface LocalBarSummary {
  trading_date: string
  open: string
  high: string
  low: string
  close: string
  volume: number | null
  turnover: string | null
}

interface DataSyncDependencies {
  databasePath: string
  loadInstruments(): Promise<readonly CatalogInstrument[]>
  loadBars(
    instrument: CatalogInstrument,
    request: {
      interval: DataSyncInterval
      start: string
      end: string
      adjustment: PriceAdjustment
    },
  ): Promise<SyncedBars>
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

export class DataSyncManager {
  private readonly ready: Promise<void>
  private instance: DuckDBInstance | undefined
  private connection: DuckDBConnection | undefined
  private activeRun: DataSyncRun | null = null
  private lastRun: DataSyncRun | null = null
  private cancelled = false
  private execution: Promise<void> | null = null
  private scheduleTimer: ReturnType<typeof setTimeout> | undefined
  private schedule: DataSyncSchedule = {
    enabled: false,
    interval: '1d',
    time: '18:00',
    skip_weekends: false,
    instrument_types: ['equity', 'index'],
    lookback_days: 10,
    adjustment: 'none',
    delay_ms: 750,
    next_run_at: null,
    last_triggered_at: null,
  }

  constructor(private readonly dependencies: DataSyncDependencies) {
    this.ready = this.initialize()
  }

  async status(): Promise<DataSyncStatus> {
    await this.ready
    const reader = await this.db.runAndReadAll(`
      SELECT
        (SELECT count(*) FROM instruments)::INTEGER AS instruments,
        (SELECT count(*) FROM daily_bars)::BIGINT AS daily_bars,
        (SELECT count(*) FROM minute_bars)::BIGINT AS minute_bars,
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
      active_run: this.activeRun,
      last_run: this.lastRun,
      schedule: this.schedule,
    }
  }

  async updateSchedule(schedule: Omit<DataSyncSchedule, 'next_run_at' | 'last_triggered_at'>): Promise<DataSyncSchedule> {
    await this.ready
    this.schedule = {
      ...schedule,
      next_run_at: null,
      last_triggered_at: this.schedule.last_triggered_at,
    }
    this.configureScheduleTimer()
    await this.persistSchedule()
    return this.schedule
  }

  async browseInstruments(request: {
    query?: string
    instrumentType?: InstrumentType
    limit: number
    offset: number
  }): Promise<{ total: number; items: readonly LocalInstrumentSummary[] }> {
    await this.ready
    const query = request.query?.replaceAll(/\s+/g, '') ?? ''
    const instrumentType = request.instrumentType ?? ''
    const filters = {
      query: `%${query.toLowerCase()}%`,
      instrument_type: instrumentType,
    }
    const totalReader = await this.db.runAndReadAll(`
      SELECT count(*)::INTEGER AS total
      FROM instruments i
      WHERE ($instrument_type = '' OR i.instrument_type = $instrument_type)
        AND ($query = '%%' OR lower(i.symbol) LIKE $query OR lower(i.name) LIKE $query)
        AND EXISTS (
          SELECT 1 FROM daily_bars b
          WHERE b.instrument_id = i.instrument_id AND b.adjustment = 'none'
        )
    `, filters)
    const reader = await this.db.runAndReadAll(`
      WITH selected AS (
        SELECT *
        FROM instruments i
        WHERE ($instrument_type = '' OR i.instrument_type = $instrument_type)
          AND ($query = '%%' OR lower(i.symbol) LIKE $query OR lower(i.name) LIKE $query)
          AND EXISTS (
            SELECT 1 FROM daily_bars b
            WHERE b.instrument_id = i.instrument_id AND b.adjustment = 'none'
          )
        ORDER BY i.instrument_type, i.symbol
        LIMIT $limit OFFSET $offset
      )
      SELECT
        i.instrument_id, i.instrument_type, i.symbol, i.name, i.venue, i.publisher,
        count(*)::BIGINT AS records,
        min(b.trading_date)::VARCHAR AS first_trading_date,
        max(b.trading_date)::VARCHAR AS last_trading_date,
        arg_max(b.close, b.trading_date)::VARCHAR AS latest_close
      FROM selected i
      JOIN daily_bars b ON b.instrument_id = i.instrument_id AND b.adjustment = 'none'
      GROUP BY i.instrument_id, i.instrument_type, i.symbol, i.name, i.venue, i.publisher
      ORDER BY i.instrument_type, i.symbol
    `, { ...filters, limit: request.limit, offset: request.offset })
    return {
      total: Number(totalReader.getRowObjectsJson()[0]?.total ?? 0),
      items: reader.getRowObjectsJson().map((row) => ({
        instrument_id: String(row.instrument_id),
        instrument_type: row.instrument_type as InstrumentType,
        symbol: String(row.symbol),
        name: String(row.name),
        venue: row.venue === null ? null : String(row.venue),
        publisher: row.publisher === null ? null : String(row.publisher),
        records: Number(row.records),
        first_trading_date: String(row.first_trading_date),
        last_trading_date: String(row.last_trading_date),
        latest_close: String(row.latest_close),
      })),
    }
  }

  async browseBars(
    instrumentId: string,
    limit: number,
  ): Promise<readonly LocalBarSummary[]> {
    await this.ready
    const reader = await this.db.runAndReadAll(`
      SELECT trading_date::VARCHAR AS trading_date, open, high, low, close, volume, turnover
      FROM daily_bars
      WHERE instrument_id = $instrument_id AND adjustment = 'none'
      ORDER BY trading_date DESC
      LIMIT $limit
    `, { instrument_id: instrumentId, limit })
    return reader.getRowObjectsJson().map((row) => ({
      trading_date: String(row.trading_date),
      open: String(row.open),
      high: String(row.high),
      low: String(row.low),
      close: String(row.close),
      volume: row.volume === null ? null : Number(row.volume),
      turnover: row.turnover === null ? null : String(row.turnover),
    }))
  }

  async start(request: DataSyncRequest): Promise<DataSyncRun> {
    await this.ready
    if (this.activeRun) throw new Error('DATA_SYNC_ALREADY_RUNNING')
    if (!request.instrumentTypes.length) throw new Error('DATA_SYNC_TYPES_REQUIRED')
    if (!DATE_PATTERN.test(request.start) || !DATE_PATTERN.test(request.end)) {
      throw new Error('DATA_SYNC_INVALID_DATE')
    }
    if (request.start > request.end) throw new Error('DATA_SYNC_INVALID_RANGE')
    const interval = request.interval ?? '1d'

    const catalog = await this.dependencies.loadInstruments()
    const instruments = catalog
      .filter((instrument) =>
        request.instrumentTypes.includes(instrument.type) &&
        instrument.capabilities.includes('bars'),
      )
      .slice(0, request.limit)
    const run: DataSyncRun = {
      run_id: randomUUID(),
      status: 'running',
      instrument_types: [...request.instrumentTypes],
      interval,
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
    this.activeRun = run
    this.cancelled = false
    await this.persistRun(run)
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

    const catalog = await this.dependencies.loadInstruments()
    const instruments = catalog
      .filter((instrument) =>
        previous.instrument_types.includes(instrument.type) &&
        instrument.capabilities.includes('bars'),
      )
      .slice(0, previous.limit ?? undefined)
    if (instruments.length !== previous.total) {
      throw new Error('DATA_SYNC_CATALOG_CHANGED')
    }

    const run: DataSyncRun = {
      ...previous,
      interval: previous.interval ?? '1d',
      run_id: randomUUID(),
      status: 'running',
      current_instrument: null,
      started_at: new Date().toISOString(),
      finished_at: null,
    }
    this.activeRun = run
    this.cancelled = false
    await this.persistRun(run)
    this.launch(run, instruments.slice(previous.completed))
    return run
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
        this.lastRun = run
        this.activeRun = null
      })
      .finally(() => {
        this.execution = null
      })
  }

  async readBars(request: {
    instrumentId: string
    interval?: DataSyncInterval
    adjustment: PriceAdjustment
    start?: string
    end?: string
  }): Promise<readonly ProviderBar[] | null> {
    await this.ready
    const interval = request.interval ?? '1d'
    const coverage = await this.coverage(request.instrumentId, request.adjustment, interval)
    if (!coverage) return null
    if (request.start && request.start < coverage.start) return null
    if (request.end && request.end > coverage.end) return null
    if (interval === '1m') {
      const storedRange = await this.storedRange(
        request.instrumentId,
        request.adjustment,
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
          AND adjustment = $adjustment
          AND ($start = '' OR trading_date >= $start::DATE)
          AND ($end = '' OR trading_date <= $end::DATE)
        ORDER BY period_start
      `, {
        instrument_id: request.instrumentId,
        adjustment: request.adjustment,
        start: request.start ?? '',
        end: request.end ?? '',
      })
      return reader.getRowObjectsJson().map((row): ProviderBar => ({
        source: 'local-duckdb',
        interval: '1m',
        tradingDate: String(row.trading_date),
        periodStart: String(row.period_start),
        periodEnd: String(row.period_end),
        currency: 'CNY',
        open: String(row.open),
        high: String(row.high),
        low: String(row.low),
        close: String(row.close),
        volume: row.volume === null ? null : Number(row.volume),
        turnover: row.turnover === null ? null : String(row.turnover),
        adjustment: request.adjustment,
        complete: Boolean(row.complete),
      }))
    }
    const reader = await this.db.runAndReadAll(`
      SELECT
        trading_date::VARCHAR AS trading_date,
        open, high, low, close, volume, turnover
      FROM daily_bars
      WHERE instrument_id = $instrument_id
        AND adjustment = $adjustment
        AND ($start = '' OR trading_date >= $start::DATE)
        AND ($end = '' OR trading_date <= $end::DATE)
      ORDER BY trading_date
    `, {
      instrument_id: request.instrumentId,
      adjustment: request.adjustment,
      start: request.start ?? '',
      end: request.end ?? '',
    })
    return reader.getRowObjectsJson().map((row): ProviderBar => {
      const tradingDate = String(row.trading_date)
      return {
        source: 'local-duckdb',
        interval: '1d',
        tradingDate,
        periodStart: `${tradingDate}T00:00:00+08:00`,
        periodEnd: `${tradingDate}T23:59:59+08:00`,
        currency: 'CNY',
        open: String(row.open),
        high: String(row.high),
        low: String(row.low),
        close: String(row.close),
        volume: row.volume === null ? null : Number(row.volume),
        turnover: row.turnover === null ? null : String(row.turnover),
        adjustment: request.adjustment,
        complete: true,
      }
    })
  }

  async readQuote(instrumentId: string): Promise<LocalQuote | null> {
    await this.ready
    const reader = await this.db.runAndReadAll(`
      SELECT
        trading_date::VARCHAR AS trading_date,
        open, high, low, close, volume, turnover
      FROM daily_bars
      WHERE instrument_id = $instrument_id AND adjustment = 'none'
      ORDER BY trading_date DESC
      LIMIT 2
    `, { instrument_id: instrumentId })
    const rows = reader.getRowObjectsJson()
    const latest = rows[0]
    if (!latest) return null
    const tradingDate = String(latest.trading_date)
    return {
      marketTime: `${tradingDate}T15:00:00+08:00`,
      currency: 'CNY',
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
    await this.ready
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
    return (['equity', 'index'] as const).map((category) => ({
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
    if (this.scheduleTimer) clearTimeout(this.scheduleTimer)
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
        volume BIGINT,
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
        volume BIGINT,
        turnover DOUBLE,
        adjustment VARCHAR NOT NULL,
        complete BOOLEAN NOT NULL,
        provider VARCHAR NOT NULL,
        upstream VARCHAR,
        fetched_at TIMESTAMP NOT NULL,
        PRIMARY KEY (instrument_id, period_start, adjustment)
      );
      CREATE TABLE IF NOT EXISTS sync_runs (
        run_id VARCHAR PRIMARY KEY,
        status VARCHAR NOT NULL,
        payload JSON NOT NULL,
        started_at TIMESTAMP NOT NULL,
        finished_at TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS sync_coverage (
        instrument_id VARCHAR NOT NULL,
        adjustment VARCHAR NOT NULL,
        requested_start DATE NOT NULL,
        requested_end DATE NOT NULL,
        updated_at TIMESTAMP NOT NULL,
        PRIMARY KEY (instrument_id, adjustment)
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
    `)
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
      this.lastRun = {
        ...storedRun,
        interval: storedRun.interval ?? '1d',
        lookback_days: storedRun.lookback_days ?? 10,
        status: latestRow.status as DataSyncRun['status'],
        finished_at: typeof latestRow.finished_at === 'string'
          ? latestRow.finished_at.replace(' ', 'T') + 'Z'
          : null,
      }
    }
    const scheduleReader = await this.db.runAndReadAll(`
      SELECT payload::VARCHAR AS payload FROM sync_schedule WHERE id = 1
    `)
    const schedulePayload = scheduleReader.getRowObjectsJson()[0]?.payload
    if (typeof schedulePayload === 'string') {
      const stored = JSON.parse(schedulePayload) as Partial<DataSyncSchedule> & { start?: string }
      const { start: _legacyStart, ...current } = stored
      this.schedule = {
        ...this.schedule,
        ...current,
        interval: stored.interval ?? '1d',
        skip_weekends: stored.skip_weekends ?? false,
        lookback_days: stored.lookback_days ?? 10,
      }
    }
    this.configureScheduleTimer()
  }

  private configureScheduleTimer(): void {
    if (this.scheduleTimer) clearTimeout(this.scheduleTimer)
    this.scheduleTimer = undefined
    if (!this.schedule.enabled) {
      this.schedule = { ...this.schedule, next_run_at: null }
      return
    }
    const next = nextDataSyncRun(new Date(), this.schedule.time, this.schedule.skip_weekends)
    this.schedule = { ...this.schedule, next_run_at: next.toISOString() }
    this.scheduleTimer = setTimeout(() => void this.triggerSchedule(), next.getTime() - Date.now())
    this.scheduleTimer.unref()
  }

  private async triggerSchedule(): Promise<void> {
    this.schedule = { ...this.schedule, last_triggered_at: new Date().toISOString() }
    this.configureScheduleTimer()
    await this.persistSchedule()
    if (this.activeRun) return
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })
    const start = this.schedule.interval === '1m'
      ? subtractDays(today, 92)
      : '1990-01-01'
    try {
      await this.start({
        instrumentTypes: this.schedule.instrument_types,
        interval: this.schedule.interval,
        start,
        end: today,
        adjustment: this.schedule.adjustment,
        delayMs: this.schedule.delay_ms,
        lookbackDays: this.schedule.lookback_days,
      })
    } catch (error) {
      process.stderr.write(`[data-sync-schedule] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    }
  }

  private async persistSchedule(): Promise<void> {
    await this.db.run(`
      INSERT INTO sync_schedule VALUES (1, $payload::JSON, current_timestamp)
      ON CONFLICT (id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
    `, { payload: JSON.stringify(this.schedule) })
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
      try {
        await this.upsertInstrument(instrument)
        const [storedRange, coveredStart] = await Promise.all([
          this.storedRange(instrument.instrumentId, run.adjustment, run.interval),
          this.coveredStart(instrument.instrumentId, run.adjustment, run.interval),
        ])
        const start = storedRange && coveredStart && run.start >= coveredStart
          ? laterDate(run.start, subtractDays(storedRange.last, run.lookback_days))
          : run.start
        const result = await this.dependencies.loadBars(instrument, {
          interval: run.interval,
          start,
          end: run.end,
          adjustment: run.adjustment,
        })
        await this.upsertBars(instrument, result, run.adjustment, run.interval)
        await this.updateCoverage(
          instrument.instrumentId,
          run.adjustment,
          run.interval,
          run.start,
          run.end,
        )
        run.succeeded += 1
        run.bars_written += result.bars.length
      } catch (error) {
        run.failed += 1
        if (run.errors.length < MAX_ERRORS) {
          run.errors = [...run.errors, {
            instrument_id: instrument.instrumentId,
            symbol: instrument.symbol,
            message: error instanceof Error ? error.message : String(error),
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
    run.finished_at = new Date().toISOString()
    await this.persistRun(run)
    this.lastRun = run
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
        volume::BIGINT, turnover::DOUBLE, adjustment, provider, upstream,
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
        volume::BIGINT, turnover::DOUBLE, adjustment, complete::BOOLEAN,
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
}
