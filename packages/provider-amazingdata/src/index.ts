import {
  ProviderError,
  type DataSourceCheckCall,
  type DataSourceCheckResult,
  type BarsCall,
  type AdjustmentFactorsCall,
  type CatalogInstrument,
  type ConstituentsCall,
  type InstrumentProvider,
  type ProviderBar,
  type ProviderAdjustmentFactor,
  type ProviderConstituent,
  type ProviderInstrument,
  type ProviderQuote,
} from '@evatick/core'

import { AmazingDataBridge, type AmazingDataBridgeOptions } from './bridge.js'

type JsonRecord = Record<string, unknown>

export type AmazingDataRequest =
  | { operation: 'health'; category: 'equity' | 'index' }
  | { operation: 'list_instruments' }
  | {
      operation: 'bars'
      providerSymbol: string
      interval: '1m' | '5m' | '15m' | '30m' | '60m' | '1d'
      start?: string
      end?: string
    }
  | { operation: 'quote'; providerSymbol: string }
  | { operation: 'adjustment_factors'; providerSymbol: string }
  | { operation: 'constituents'; providerSymbol: string; asOf?: string }
  | { operation: 'shutdown' }

export interface AmazingDataResult {
  data: unknown
  source: string
}

export { AmazingDataBridge, type AmazingDataBridgeOptions } from './bridge.js'

export type AmazingDataRunner = (
  request: AmazingDataRequest,
  signal: AbortSignal,
) => Promise<AmazingDataResult>

export type AmazingDataProviderOptions =
  | { runner: AmazingDataRunner }
  | AmazingDataBridgeOptions

function text(value: unknown): string | undefined {
  if (value === null || value === undefined || value === '') return undefined
  return String(value)
}

function records(value: unknown, description: string): JsonRecord[] {
  if (!Array.isArray(value)) {
    throw new ProviderError('PROVIDER_INVALID_RESPONSE', `${description} is not an array`, false)
  }
  return value.filter((item): item is JsonRecord =>
    Boolean(item) && typeof item === 'object' && !Array.isArray(item))
}

function parseCode(value: unknown): { symbol: string; exchange: 'SH' | 'SZ' | 'BJ' } | undefined {
  const code = text(value)?.toUpperCase()
  const match = /^(\d{6})\.(SH|SZ|BJ)$/.exec(code ?? '')
  return match ? { symbol: match[1]!, exchange: match[2]! as 'SH' | 'SZ' | 'BJ' } : undefined
}

function equityVenue(exchange: 'SH' | 'SZ' | 'BJ'): 'XSHG' | 'XSHE' | 'XBSE' {
  if (exchange === 'SH') return 'XSHG'
  if (exchange === 'SZ') return 'XSHE'
  return 'XBSE'
}

function indexPublisher(
  exchange: 'SH' | 'SZ' | 'BJ',
  name: string,
): 'SSE' | 'SZSE' | 'CSI' | 'BSE' {
  if (name.includes('中证') || name.includes('沪深')) return 'CSI'
  if (exchange === 'SH') return 'SSE'
  if (exchange === 'SZ') return 'SZSE'
  return 'BSE'
}

const INTERVAL_MINUTES = new Map([
  ['1m', 1], ['5m', 5], ['15m', 15], ['30m', 30], ['60m', 60],
] as const)

function requiredText(value: unknown, description: string): string {
  const result = text(value)
  if (!result) {
    throw new ProviderError('PROVIDER_INVALID_RESPONSE', `${description} is missing`, false)
  }
  return result
}

function number(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const result = Number(value)
  return Number.isFinite(result) ? result : null
}

function shanghaiTimestamp(value: unknown, description: string): string {
  const timestamp = requiredText(value, description).replace(' ', 'T')
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(timestamp)) return `${timestamp}+08:00`
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new ProviderError('PROVIDER_INVALID_RESPONSE', `${description} is invalid`, false)
  }
  return timestamp
}

function shanghaiIso(timestamp: number): string {
  return `${new Date(timestamp + 8 * 3_600_000).toISOString().slice(0, 23)}+08:00`
}

function normalizedDate(value: unknown): string | null {
  const raw = text(value)
  if (!raw || raw === 'NaT' || raw.toLowerCase() === 'nan') return null
  if (/^\d{8}$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`
  const result = raw.slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(result) ? result : null
}

function supportsIntradayRange(start?: string, end?: string): boolean {
  const today = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10)
  const effectiveEnd = end ?? today
  const endTimestamp = Date.parse(`${effectiveEnd}T00:00:00Z`)
  const startTimestamp = start
    ? Date.parse(`${start}T00:00:00Z`)
    : endTimestamp - 4 * 86_400_000
  return Number.isFinite(startTimestamp) && Number.isFinite(endTimestamp) &&
    startTimestamp <= endTimestamp && endTimestamp - startTimestamp <= 89 * 86_400_000
}

export class AmazingDataProvider implements InstrumentProvider {
  readonly id = 'amazingdata'
  readonly dataSources = [{
    id: 'amazingdata',
    name: '银河证券星耀数智',
    categories: ['equity', 'index'],
    capabilities: {
      equity: ['标的目录', '行情快照', '分钟线', '日线', '复权因子'],
      index: ['标的目录', '行情快照', '分钟线', '日线', '历史成分'],
    },
  }] as const

  private readonly run: AmazingDataRunner
  private readonly bridge: AmazingDataBridge | undefined
  private instruments: readonly ProviderInstrument[] | undefined

  constructor(options: AmazingDataProviderOptions) {
    if ('runner' in options) {
      this.run = options.runner
      this.bridge = undefined
    } else {
      this.bridge = new AmazingDataBridge(options)
      this.run = (request, signal) => this.bridge!.run(request, signal)
    }
  }

  async close(): Promise<void> {
    await this.bridge?.close()
  }

  async checkDataSource(call: DataSourceCheckCall): Promise<DataSourceCheckResult> {
    if (call.sourceId !== 'amazingdata') {
      throw new ProviderError('UNKNOWN_DATA_SOURCE', 'unknown AmazingData source', false)
    }
    if (call.category !== 'equity' && call.category !== 'index') {
      throw new ProviderError(
        'UNSUPPORTED_DATA_SOURCE_CATEGORY',
        `AmazingData phase 1 does not support ${call.category}`,
        false,
      )
    }
    const result = await this.run({ operation: 'health', category: call.category }, call.signal)
    const data = result.data
    const count = data && typeof data === 'object' && !Array.isArray(data)
      ? Number((data as JsonRecord).records)
      : Number.NaN
    return { recordsChecked: Number.isFinite(count) ? count : null }
  }

  async listInstruments(
    signal = new AbortController().signal,
    options: { refresh?: boolean } = {},
  ): Promise<readonly ProviderInstrument[]> {
    if (this.instruments && !options.refresh) return this.instruments
    const result = await this.run({ operation: 'list_instruments' }, signal)
    this.instruments = records(result.data, 'AmazingData instrument list').flatMap((row): ProviderInstrument[] => {
      const code = parseCode(row.code)
      const name = text(row.name)
      const type = row.type
      if (!code || !name || (type !== 'equity' && type !== 'index')) return []
      const common = {
        type: type as 'equity' | 'index',
        market: 'CN' as const,
        name,
        symbol: code.symbol,
        providerSymbol: `${code.symbol}.${code.exchange}`,
        currency: 'CNY',
        // AmazingData security_status contains event flags, not a lifecycle state.
        status: 'active' as const,
        aliases: [`${code.symbol}.${code.exchange}`],
        capabilities: (type === 'index'
          ? ['quote', 'bars', 'constituents']
          : ['quote', 'bars']) as ProviderInstrument['capabilities'],
      }
      return type === 'equity'
        ? [{ ...common, venue: equityVenue(code.exchange) }]
        : [{ ...common, publisher: indexPublisher(code.exchange, name) }]
    })
    return this.instruments
  }

  supportsBars(call: Omit<BarsCall, 'signal'>): boolean {
    if (call.adjustment !== 'none') return false
    if (call.interval === '1d') return true
    return INTERVAL_MINUTES.has(
      call.interval as '1m' | '5m' | '15m' | '30m' | '60m',
    ) && supportsIntradayRange(call.start, call.end)
  }

  async getBars(call: BarsCall): Promise<readonly ProviderBar[]> {
    if (!this.supportsBars(call)) {
      throw new ProviderError(
        call.adjustment === 'none' ? 'UNSUPPORTED_INTERVAL' : 'UNSUPPORTED_ADJUSTMENT',
        'AmazingData phase 1 supplies unadjusted minute and daily bars',
        false,
      )
    }
    const result = await this.run({
      operation: 'bars',
      providerSymbol: call.providerSymbol,
      interval: call.interval as '1m' | '5m' | '15m' | '30m' | '60m' | '1d',
      ...(call.start ? { start: call.start } : {}),
      ...(call.end ? { end: call.end } : {}),
    }, call.signal)
    const rows = records(result.data, 'AmazingData bars')
    if (rows.length === 0) {
      throw new ProviderError('NO_DATA', 'AmazingData returned no bars', true)
    }
    return rows.map((row): ProviderBar => {
      const periodStart = shanghaiTimestamp(row.kline_time, 'AmazingData bar kline_time')
      const tradingDate = periodStart.slice(0, 10)
      const minutes = INTERVAL_MINUTES.get(
        call.interval as '1m' | '5m' | '15m' | '30m' | '60m',
      )
      const periodEnd = minutes
        ? shanghaiIso(Date.parse(periodStart) + minutes * 60_000 - 1)
        : `${tradingDate}T23:59:59.999+08:00`
      return {
        source: result.source,
        interval: call.interval,
        tradingDate,
        periodStart: minutes ? periodStart : `${tradingDate}T00:00:00+08:00`,
        periodEnd,
        currency: 'CNY',
        open: requiredText(row.open, 'AmazingData bar open'),
        high: requiredText(row.high, 'AmazingData bar high'),
        low: requiredText(row.low, 'AmazingData bar low'),
        close: requiredText(row.close, 'AmazingData bar close'),
        volume: number(row.volume),
        turnover: text(row.amount) ?? null,
        adjustment: 'none',
        complete: Date.parse(periodEnd) <= Date.now(),
      }
    })
  }

  async getQuote(call: {
    providerSymbol: string
    signal: AbortSignal
  }): Promise<ProviderQuote> {
    const result = await this.run({
      operation: 'quote', providerSymbol: call.providerSymbol,
    }, call.signal)
    const rows = records(result.data, 'AmazingData snapshots').sort((left, right) =>
      String(left.trade_time ?? '').localeCompare(String(right.trade_time ?? '')))
    const row = rows.at(-1)
    if (!row) {
      throw new ProviderError('NO_DATA', 'AmazingData returned no snapshot', true)
    }
    return {
      source: result.source,
      marketTime: row.trade_time === null || row.trade_time === undefined
        ? null
        : shanghaiTimestamp(row.trade_time, 'AmazingData snapshot trade_time'),
      currency: 'CNY',
      marketStatus: 'unknown',
      last: text(row.last) ?? null,
      open: text(row.open) ?? null,
      high: text(row.high) ?? null,
      low: text(row.low) ?? null,
      previousClose: text(row.pre_close) ?? null,
      volume: number(row.volume),
      turnover: text(row.amount) ?? null,
    }
  }

  resolveAdjustmentFactorSymbol(instrument: CatalogInstrument): string | undefined {
    if (instrument.type !== 'equity' || instrument.market !== 'CN') return undefined
    const exchange = instrument.venue === 'XSHG'
      ? 'SH'
      : instrument.venue === 'XSHE'
        ? 'SZ'
        : instrument.venue === 'XBSE'
          ? 'BJ'
          : undefined
    return exchange ? `${instrument.symbol}.${exchange}` : undefined
  }

  async getAdjustmentFactors(
    call: AdjustmentFactorsCall,
  ): Promise<readonly ProviderAdjustmentFactor[]> {
    const result = await this.run({
      operation: 'adjustment_factors', providerSymbol: call.providerSymbol,
    }, call.signal)
    const factors = new Map<string, ProviderAdjustmentFactor>()
    for (const row of records(result.data, 'AmazingData adjustment factors')) {
      const effectiveDate = text(row.date)?.slice(0, 10)
      const cumulativeFactor = text(row.factor)
      if (!effectiveDate || !/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate) ||
        !cumulativeFactor || !Number.isFinite(Number(cumulativeFactor)) || Number(cumulativeFactor) <= 0) {
        continue
      }
      factors.set(effectiveDate, {
        source: result.source, effectiveDate, cumulativeFactor,
      })
    }
    const values = [...factors.values()].sort((left, right) =>
      left.effectiveDate.localeCompare(right.effectiveDate))
    if (values.length === 0) {
      throw new ProviderError('NO_DATA', 'AmazingData returned no adjustment factors', true)
    }
    return values
  }

  supportsConstituents(call: Omit<ConstituentsCall, 'signal'>): boolean {
    return parseCode(call.providerSymbol) !== undefined &&
      (call.asOf === undefined || /^\d{4}-\d{2}-\d{2}$/.test(call.asOf))
  }

  async getConstituents(
    call: ConstituentsCall,
  ): Promise<readonly ProviderConstituent[]> {
    if (!this.supportsConstituents(call)) {
      throw new ProviderError('INVALID_CONSTITUENT_REQUEST', 'invalid AmazingData constituent request', false)
    }
    const asOfDate = call.asOf ?? new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10)
    const result = await this.run({
      operation: 'constituents', providerSymbol: call.providerSymbol,
      ...(call.asOf ? { asOf: call.asOf } : {}),
    }, call.signal)
    const seen = new Set<string>()
    const constituents = records(result.data, 'AmazingData index constituents')
      .flatMap((row): ProviderConstituent[] => {
        const constituent = parseCode(row.CON_CODE)
        const effectiveFrom = normalizedDate(row.INDATE)
        const effectiveTo = normalizedDate(row.OUTDATE)
        if (!constituent || seen.has(`${constituent.symbol}.${constituent.exchange}`) ||
          (effectiveFrom && effectiveFrom > asOfDate) || (effectiveTo && effectiveTo <= asOfDate)) {
          return []
        }
        const providerSymbol = `${constituent.symbol}.${constituent.exchange}`
        seen.add(providerSymbol)
        return [{
          constituentProviderSymbol: providerSymbol,
          asOfDate,
          effectiveFrom,
          effectiveTo,
          weightRatio: null,
          rank: seen.size,
        }]
      })
    if (constituents.length === 0) {
      throw new ProviderError('NO_DATA', 'AmazingData returned no active constituents', true)
    }
    return constituents
  }
}
