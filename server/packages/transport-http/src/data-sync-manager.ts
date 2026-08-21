import { randomUUID } from 'node:crypto'

import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api'

import type {
  CatalogInstrument,
  InstrumentType,
  PriceAdjustment,
  ProviderBar,
} from '@market-cli/core'

export interface DataSyncRequest {
  instrumentTypes: readonly InstrumentType[]
  start: string
  end: string
  adjustment: PriceAdjustment
  limit?: number
  delayMs?: number
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
  start: string
  end: string
  adjustment: PriceAdjustment
  limit: number | null
  delay_ms: number
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
    first_trading_date: string | null
    last_trading_date: string | null
  }
  active_run: DataSyncRun | null
  last_run: DataSyncRun | null
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

interface DataSyncDependencies {
  databasePath: string
  loadInstruments(): Promise<readonly CatalogInstrument[]>
  loadBars(
    instrument: CatalogInstrument,
    request: { start: string; end: string; adjustment: PriceAdjustment },
  ): Promise<SyncedBars>
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const MAX_ERRORS = 20

function subtractDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() - days)
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

  constructor(private readonly dependencies: DataSyncDependencies) {
    this.ready = this.initialize()
  }

  async status(): Promise<DataSyncStatus> {
    await this.ready
    const reader = await this.db.runAndReadAll(`
      SELECT
        (SELECT count(*) FROM instruments)::INTEGER AS instruments,
        (SELECT count(*) FROM daily_bars)::BIGINT AS daily_bars,
        (SELECT min(trading_date)::VARCHAR FROM daily_bars) AS first_trading_date,
        (SELECT max(trading_date)::VARCHAR FROM daily_bars) AS last_trading_date
    `)
    const row = reader.getRowObjectsJson()[0] ?? {}
    return {
      database_path: this.dependencies.databasePath,
      storage: {
        instruments: Number(row.instruments ?? 0),
        daily_bars: Number(row.daily_bars ?? 0),
        first_trading_date: typeof row.first_trading_date === 'string'
          ? row.first_trading_date
          : null,
        last_trading_date: typeof row.last_trading_date === 'string'
          ? row.last_trading_date
          : null,
      },
      active_run: this.activeRun,
      last_run: this.lastRun,
    }
  }

  async start(request: DataSyncRequest): Promise<DataSyncRun> {
    await this.ready
    if (this.activeRun) throw new Error('DATA_SYNC_ALREADY_RUNNING')
    if (!request.instrumentTypes.length) throw new Error('DATA_SYNC_TYPES_REQUIRED')
    if (!DATE_PATTERN.test(request.start) || !DATE_PATTERN.test(request.end)) {
      throw new Error('DATA_SYNC_INVALID_DATE')
    }
    if (request.start > request.end) throw new Error('DATA_SYNC_INVALID_RANGE')

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
      start: request.start,
      end: request.end,
      adjustment: request.adjustment,
      limit: request.limit ?? null,
      delay_ms: request.delayMs ?? 0,
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
    adjustment: PriceAdjustment
    start?: string
    end?: string
  }): Promise<readonly ProviderBar[] | null> {
    await this.ready
    const coverage = await this.coverage(request.instrumentId, request.adjustment)
    if (!coverage) return null
    if (request.start && request.start < coverage.start) return null
    if (request.end && request.end > coverage.end) return null
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
    request: { start?: string; end?: string; adjustment: PriceAdjustment },
  ): Promise<void> {
    await this.ready
    await this.upsertInstrument(instrument)
    await this.upsertBars(instrument, result, request.adjustment)
    if (request.start && request.end) {
      await this.updateCoverage(
        instrument.instrumentId,
        request.adjustment,
        request.start,
        request.end,
      )
    }
  }

  async localDataSources() {
    await this.ready
    const reader = await this.db.runAndReadAll(`
      SELECT instrument_type, count(*)::BIGINT AS records
      FROM daily_bars
      GROUP BY instrument_type
    `)
    const counts = new Map(reader.getRowObjectsJson().map((row) =>
      [String(row.instrument_type), Number(row.records)] as const))
    const checkedAt = new Date().toISOString()
    return (['equity', 'index'] as const).map((category) => ({
      provider_id: 'local-duckdb',
      source_id: 'local',
      source_name: '本地 DuckDB',
      category,
      status: 'healthy' as const,
      capabilities: ['日线', '行情快照'],
      last_checked_at: checkedAt,
      last_success_at: checkedAt,
      latency_ms: 0,
      records_checked: counts.get(category) ?? 0,
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
      this.lastRun = {
        ...JSON.parse(latestRow.payload) as DataSyncRun,
        status: latestRow.status as DataSyncRun['status'],
        finished_at: typeof latestRow.finished_at === 'string'
          ? latestRow.finished_at.replace(' ', 'T') + 'Z'
          : null,
      }
    }
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
          this.storedRange(instrument.instrumentId, run.adjustment),
          this.coveredStart(instrument.instrumentId, run.adjustment),
        ])
        const start = storedRange && coveredStart && run.start >= coveredStart
          ? laterDate(run.start, subtractDays(storedRange.last, 10))
          : run.start
        const result = await this.dependencies.loadBars(instrument, {
          start,
          end: run.end,
          adjustment: run.adjustment,
        })
        await this.upsertBars(instrument, result, run.adjustment)
        await this.updateCoverage(
          instrument.instrumentId,
          run.adjustment,
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
  ): Promise<{ first: string; last: string } | null> {
    const reader = await this.db.runAndReadAll(`
      SELECT
        min(trading_date)::VARCHAR AS first_trading_date,
        max(trading_date)::VARCHAR AS last_trading_date
      FROM daily_bars
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
  ): Promise<string | null> {
    const reader = await this.db.runAndReadAll(`
      SELECT requested_start::VARCHAR AS requested_start
      FROM sync_coverage
      WHERE instrument_id = $instrument_id AND adjustment = $adjustment
    `, { instrument_id: instrumentId, adjustment })
    const value = reader.getRowObjectsJson()[0]?.requested_start
    return typeof value === 'string' ? value : null
  }

  private async coverage(
    instrumentId: string,
    adjustment: PriceAdjustment,
  ): Promise<{ start: string; end: string } | null> {
    const reader = await this.db.runAndReadAll(`
      SELECT
        requested_start::VARCHAR AS requested_start,
        requested_end::VARCHAR AS requested_end
      FROM sync_coverage
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
    start: string,
    end: string,
  ): Promise<void> {
    await this.db.run(`
      INSERT INTO sync_coverage VALUES (
        $instrument_id, $adjustment, $start::DATE, $end::DATE, current_timestamp
      )
      ON CONFLICT (instrument_id, adjustment) DO UPDATE SET
        requested_start = least(sync_coverage.requested_start, excluded.requested_start),
        requested_end = greatest(sync_coverage.requested_end, excluded.requested_end),
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
  ): Promise<void> {
    if (!result.bars.length) return
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
