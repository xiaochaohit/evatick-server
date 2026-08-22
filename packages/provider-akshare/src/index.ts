import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ProviderError,
  type AdjustmentFactorsCall,
  type BarsCall,
  type ConstituentsCall,
  type DataSourceCheckCall,
  type DataSourceCheckResult,
  type InstrumentProvider,
  type ProviderBar,
  type ProviderAdjustmentFactor,
  type ProviderConstituent,
  type ProviderInstrument,
  type ProviderQuote,
} from '@evatick/core'

type JsonRecord = Record<string, unknown>

export type AkshareRequest =
  | { operation: 'list_stocks' }
  | { operation: 'list_indices' }
  | { operation: 'health'; source: string; instrumentType: 'equity' | 'index' }
  | {
      operation: 'bars'
      instrumentType: 'equity' | 'index'
      providerSymbol: string
      interval: '1m' | '5m' | '15m' | '30m' | '60m' | '1d'
      start?: string
      end?: string
      adjustment: 'none' | 'forward' | 'backward'
    }
  | {
      operation: 'quote'
      instrumentType: 'equity' | 'index'
      providerSymbol: string
    }
  | { operation: 'adjustment_factors'; providerSymbol: string }
  | { operation: 'constituents'; providerSymbol: string }

export interface AkshareResult {
  data: readonly JsonRecord[]
  source: string
}

export type AkshareRunner = (
  request: AkshareRequest,
  signal: AbortSignal,
) => Promise<AkshareResult>

export interface AkshareProviderOptions {
  pythonExecutable?: string
  pythonModule?: string
  runner?: AkshareRunner
}

function asText(value: unknown): string | undefined {
  if (value === null || value === undefined || value === '') return undefined
  return String(value)
}

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function pick(record: JsonRecord, ...keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) return record[key]
  }
  return undefined
}

const INTRADAY_MINUTES = new Map([
  ['1m', 1], ['5m', 5], ['15m', 15], ['30m', 30], ['60m', 60],
] as const)

function shanghaiDateTime(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(value)) {
    return `${value.replace(' ', 'T')}+08:00`
  }
  return value
}

function subtractMinutes(value: string, minutes: number): string {
  const shifted = new Date(new Date(value).getTime() - minutes * 60_000 + 8 * 3_600_000)
  return `${shifted.toISOString().slice(0, 19)}+08:00`
}

function stockVenue(symbol: string): 'XSHG' | 'XSHE' | 'XBSE' {
  if (symbol.startsWith('6')) return 'XSHG'
  if (
    symbol.startsWith('4') ||
    symbol.startsWith('8') ||
    symbol.startsWith('92')
  ) return 'XBSE'
  return 'XSHE'
}

function stockProviderSymbol(symbol: string): string {
  const prefix = stockVenue(symbol) === 'XSHG'
    ? 'sh'
    : stockVenue(symbol) === 'XBSE'
      ? 'bj'
      : 'sz'
  return `${prefix}${symbol}`
}

function indexPublisher(symbol: string, name: string): 'SSE' | 'SZSE' | 'CSI' {
  if (name.includes('中证') || name === '沪深300') return 'CSI'
  return symbol.startsWith('399') ? 'SZSE' : 'SSE'
}

function indexProviderSymbol(symbol: string, name: string): string {
  const publisher = indexPublisher(symbol, name)
  return `${publisher === 'SSE' ? 'sh' : publisher === 'SZSE' ? 'sz' : 'csi'}${symbol}`
}

function bridgeRunner(
  pythonExecutable: string,
  pythonModule: string,
): AkshareRunner {
  return async (request, signal) => {
    const directory = await mkdtemp(join(tmpdir(), 'evatick-server-akshare-'))
    const requestPath = join(directory, 'request.json')
    const resultPath = join(directory, 'result.json')
    try {
      await writeFile(requestPath, JSON.stringify(request), { mode: 0o600 })
      await new Promise<void>((resolve, reject) => {
        execFile(
          pythonExecutable,
          ['-m', pythonModule, '--request', requestPath, '--result', resultPath],
          { encoding: 'utf8', maxBuffer: 1024 * 1024, signal },
          (error, _stdout, stderr) => {
            if (!error) return resolve()
            reject(new ProviderError(
              error.name === 'AbortError' ? 'PROVIDER_ABORTED' : 'PROVIDER_PROCESS_ERROR',
              stderr.trim() || 'AKShare bridge process failed',
              error.name === 'AbortError',
            ))
          },
        )
      })
      const payload = JSON.parse(await readFile(resultPath, 'utf8')) as {
        ok?: boolean
        data?: unknown
        source?: unknown
        error?: { code?: string; message?: string; retryable?: boolean }
      }
      if (!payload.ok) {
        throw new ProviderError(
          payload.error?.code ?? 'PROVIDER_ERROR',
          payload.error?.message ?? 'AKShare bridge request failed',
          payload.error?.retryable ?? false,
        )
      }
      if (!Array.isArray(payload.data)) {
        throw new ProviderError('PROVIDER_INVALID_RESPONSE', 'AKShare bridge returned non-array data', false)
      }
      if (typeof payload.source !== 'string' || !payload.source) {
        throw new ProviderError('PROVIDER_INVALID_RESPONSE', 'AKShare bridge omitted its data source', false)
      }
      return { data: payload.data as JsonRecord[], source: payload.source }
    } catch (error) {
      if (error instanceof ProviderError) throw error
      throw new ProviderError('PROVIDER_INVALID_RESPONSE', 'AKShare bridge returned invalid JSON', false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
}

export class AkshareProvider implements InstrumentProvider {
  readonly id = 'akshare'
  readonly dataSources = [
    {
      id: 'sina', name: '新浪财经',
      categories: ['equity', 'index'],
      capabilities: {
        equity: ['日线', '分时', '行情快照', '复权因子'],
        index: ['日线', '分时', '行情快照'],
      },
    },
    {
      id: 'eastmoney', name: '东方财富',
      categories: ['equity', 'index'],
      capabilities: {
        equity: ['日线', '分时', '行情快照'],
        index: ['日线', '分时', '行情快照'],
      },
    },
    {
      id: 'tencent', name: '腾讯财经',
      categories: ['equity', 'index'],
      capabilities: {
        equity: ['日线', '行情快照'],
        index: ['日线', '行情快照'],
      },
    },
    {
      id: 'baostock', name: 'BaoStock',
      categories: ['equity', 'index'],
      capabilities: {
        equity: ['日线', '行情快照'],
        index: ['日线', '行情快照'],
      },
    },
  ] as const
  private readonly run: AkshareRunner
  private instruments: readonly ProviderInstrument[] | undefined

  constructor(options: AkshareProviderOptions = {}) {
    this.run = options.runner ?? bridgeRunner(
      options.pythonExecutable ?? 'python3',
      options.pythonModule ?? 'evatick_server_akshare',
    )
  }

  async checkDataSource(call: DataSourceCheckCall): Promise<DataSourceCheckResult> {
    if (!this.dataSources.some((source) => source.id === call.sourceId)) {
      throw new ProviderError('UNKNOWN_DATA_SOURCE', `unknown AKShare data source: ${call.sourceId}`, false)
    }
    const source = this.dataSources.find((candidate) => candidate.id === call.sourceId)
    if (!source?.categories.some((category) => category === call.category)) {
      throw new ProviderError(
        'UNSUPPORTED_DATA_SOURCE_CATEGORY',
        `${call.sourceId} does not support ${call.category}`,
        false,
      )
    }
    const result = await this.run({
      operation: 'health', source: call.sourceId, instrumentType: call.category,
    }, call.signal)
    if (result.source !== call.sourceId) {
      throw new ProviderError('PROVIDER_INVALID_RESPONSE', 'health probe returned a different data source', false)
    }
    const recordsChecked = asNumber(result.data[0]?.records)
    return { recordsChecked }
  }

  async listInstruments(signal = new AbortController().signal): Promise<readonly ProviderInstrument[]> {
    if (this.instruments) return this.instruments
    const [stockResult, indexResult] = await Promise.all([
      this.run({ operation: 'list_stocks' }, signal),
      this.run({ operation: 'list_indices' }, signal),
    ])
    const stocks = stockResult.data
    const indices = indexResult.data
    this.instruments = [
      ...stocks.flatMap((record): ProviderInstrument[] => {
        const symbol = asText(pick(record, 'code', '代码'))
        const name = asText(pick(record, 'name', '名称'))
        if (!symbol || !name) return []
        return [{
          type: 'equity', market: 'CN', name, symbol,
          providerSymbol: stockProviderSymbol(symbol), venue: stockVenue(symbol),
          currency: 'CNY', status: 'active', capabilities: ['quote', 'bars'],
        }]
      }),
      ...indices.flatMap((record): ProviderInstrument[] => {
        const symbol = asText(pick(record, 'index_code', '指数代码', 'code'))
        const name = asText(pick(record, 'display_name', '指数名称', 'name'))
        if (!symbol || !name) return []
        return [{
          type: 'index', market: 'CN', name, symbol,
          providerSymbol: indexProviderSymbol(symbol, name),
          publisher: indexPublisher(symbol, name), currency: 'CNY', status: 'active',
          capabilities: ['quote', 'bars', 'constituents'],
        }]
      }),
    ]
    return this.instruments
  }

  async getBars(call: BarsCall): Promise<readonly ProviderBar[]> {
    if (call.interval === '1w' || call.interval === '1mo') {
      throw new ProviderError('UNSUPPORTED_INTERVAL', 'AKShare provider supports minute and daily bars', false)
    }
    const instrumentType = call.providerSymbol.startsWith('csi') ||
      call.providerSymbol.startsWith('sh000') || call.providerSymbol.startsWith('sz399')
      ? 'index'
      : 'equity'
    const result = await this.run({
      operation: 'bars',
      instrumentType,
      providerSymbol: call.providerSymbol,
      interval: call.interval,
      start: call.start,
      end: call.end,
      adjustment: call.adjustment,
    }, call.signal)
    return result.data.flatMap((record): ProviderBar[] => {
      const timestamp = asText(pick(record, 'day', '时间', 'datetime'))
      const date = asText(pick(record, 'date', '日期')) ?? timestamp?.slice(0, 10)
      const open = asText(pick(record, 'open', '开盘'))
      const high = asText(pick(record, 'high', '最高'))
      const low = asText(pick(record, 'low', '最低'))
      const close = asText(pick(record, 'close', '收盘'))
      if (!date || !open || !high || !low || !close) return []
      const minutes = INTRADAY_MINUTES.get(
        call.interval as '1m' | '5m' | '15m' | '30m' | '60m',
      )
      const periodEnd = timestamp
        ? shanghaiDateTime(timestamp)
        : `${date}T23:59:59+08:00`
      const periodStart = minutes
        ? subtractMinutes(periodEnd, minutes)
        : `${date}T00:00:00+08:00`
      return [{
        source: result.source,
        interval: call.interval, tradingDate: date,
        periodStart, periodEnd,
        currency: 'CNY', open, high, low, close,
        volume: asNumber(pick(record, 'volume', '成交量')),
        turnover: asText(pick(record, 'amount', '成交额')) ?? null,
        adjustment: call.adjustment,
        complete: minutes ? new Date(periodEnd).getTime() <= Date.now() : true,
      }]
    })
  }

  async getAdjustmentFactors(
    call: AdjustmentFactorsCall,
  ): Promise<readonly ProviderAdjustmentFactor[]> {
    if (call.providerSymbol.startsWith('csi') ||
      call.providerSymbol.startsWith('sh000') ||
      call.providerSymbol.startsWith('sz399')) {
      throw new ProviderError(
        'UNSUPPORTED_INSTRUMENT_TYPE',
        'price adjustment factors are only available for equities',
        false,
      )
    }
    const result = await this.run({
      operation: 'adjustment_factors',
      providerSymbol: call.providerSymbol,
    }, call.signal)
    return result.data.flatMap((record): ProviderAdjustmentFactor[] => {
      const effectiveDate = asText(pick(record, 'date', '日期'))
      const cumulativeFactor = asText(pick(record, 'hfq_factor', 'factor', '复权因子'))
      if (!effectiveDate || !cumulativeFactor || !Number.isFinite(Number(cumulativeFactor))) {
        return []
      }
      return [{
        source: result.source,
        effectiveDate: effectiveDate.slice(0, 10),
        cumulativeFactor,
      }]
    })
  }

  async getQuote(call: { providerSymbol: string; signal: AbortSignal }): Promise<ProviderQuote> {
    const instrumentType = call.providerSymbol.startsWith('csi') ||
      call.providerSymbol.startsWith('sh000') || call.providerSymbol.startsWith('sz399')
      ? 'index'
      : 'equity'
    const result = await this.run({
      operation: 'quote', instrumentType, providerSymbol: call.providerSymbol,
    }, call.signal)
    const records = [...result.data].sort((left, right) =>
      String(pick(left, 'date', '日期')).localeCompare(String(pick(right, 'date', '日期'))))
    const latest = records.at(-1)
    if (!latest) throw new ProviderError('NO_DATA', 'no recent quote data', false)
    const previous = records.at(-2)
    const date = asText(pick(latest, 'date', '日期'))
    return {
      source: result.source,
      marketTime: date ? `${date}T23:59:59+08:00` : null,
      currency: 'CNY', marketStatus: 'unknown',
      last: asText(pick(latest, 'close', '收盘')) ?? null,
      open: asText(pick(latest, 'open', '开盘')) ?? null,
      high: asText(pick(latest, 'high', '最高')) ?? null,
      low: asText(pick(latest, 'low', '最低')) ?? null,
      previousClose: previous ? asText(pick(previous, 'close', '收盘')) ?? null : null,
      volume: asNumber(pick(latest, 'volume', '成交量')),
      turnover: asText(pick(latest, 'amount', '成交额')) ?? null,
    }
  }

  async getConstituents(call: ConstituentsCall): Promise<readonly ProviderConstituent[]> {
    const result = await this.run({
      operation: 'constituents',
      providerSymbol: call.providerSymbol,
    }, call.signal)
    const asOfDate = call.asOf ?? new Date().toISOString().slice(0, 10)
    return result.data.flatMap((record, index): ProviderConstituent[] => {
      const code = asText(pick(record, '品种代码', '成分券代码', '成分股代码', 'code', 'symbol'))
      if (!code) return []
      const rawWeight = asNumber(pick(record, '权重', '权重(%)', 'weight'))
      return [{
        constituentProviderSymbol: stockProviderSymbol(code), asOfDate,
        effectiveFrom: null, effectiveTo: null,
        weightRatio: rawWeight === null ? null : String(rawWeight / 100), rank: index + 1,
      }]
    })
  }
}
