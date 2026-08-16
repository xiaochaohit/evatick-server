import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ProviderError,
  type BarsCall,
  type ConstituentsCall,
  type InstrumentProvider,
  type ProviderBar,
  type ProviderConstituent,
  type ProviderInstrument,
  type ProviderQuote,
} from '@market-cli/core'

type JsonRecord = Record<string, unknown>

export type MarketCliRunner = (
  args: readonly string[],
  signal: AbortSignal,
) => Promise<readonly JsonRecord[]>

export interface MarketCliProviderOptions {
  executable?: string
  runner?: MarketCliRunner
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

function stockVenue(symbol: string): 'XSHG' | 'XSHE' | 'XBSE' {
  if (symbol.startsWith('6')) return 'XSHG'
  if (symbol.startsWith('4') || symbol.startsWith('8')) return 'XBSE'
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

function dateArgument(value: string | undefined, fallback: string): string {
  return (value ?? fallback).replaceAll('-', '').slice(0, 8)
}

function commandRunner(executable: string): MarketCliRunner {
  return async (args, signal) => {
    const directory = await mkdtemp(join(tmpdir(), 'market-cli-provider-'))
    const output = join(directory, 'result.json')
    const environment = { ...process.env }
    delete environment.MARKET_CLI_SERVER_URL
    try {
      await new Promise<void>((resolve, reject) => {
        execFile(
          executable,
          [...args, '--retries', '0', '--output', output, '--overwrite'],
          { encoding: 'utf8', maxBuffer: 1024 * 1024, signal, env: environment },
          (error, _stdout, stderr) => {
            if (!error) return resolve()
            let code = error.name === 'AbortError' ? 'PROVIDER_ABORTED' : 'PROVIDER_PROCESS_ERROR'
            let retryable = error.name === 'AbortError'
            try {
              const payload = JSON.parse(stderr) as { code?: string; retryable?: boolean }
              code = payload.code ?? code
              retryable = payload.retryable ?? retryable
            } catch {
              // Preserve the process-level classification for non-JSON diagnostics.
            }
            reject(new ProviderError(code, stderr.trim() || 'market-cli provider process failed', retryable))
          },
        )
      })
      const parsed: unknown = JSON.parse(await readFile(output, 'utf8'))
      if (!Array.isArray(parsed)) {
        throw new ProviderError('PROVIDER_INVALID_RESPONSE', 'market-cli returned a non-array result', false)
      }
      return parsed as JsonRecord[]
    } catch (error) {
      if (error instanceof ProviderError) throw error
      throw new ProviderError('PROVIDER_INVALID_RESPONSE', 'market-cli returned invalid JSON', false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
}

export class MarketCliProvider implements InstrumentProvider {
  readonly id = 'market-cli-akshare'
  private readonly run: MarketCliRunner
  private instruments: readonly ProviderInstrument[] | undefined

  constructor(options: MarketCliProviderOptions = {}) {
    this.run = options.runner ?? commandRunner(options.executable ?? 'market-cli')
  }

  async listInstruments(signal = new AbortController().signal): Promise<readonly ProviderInstrument[]> {
    if (this.instruments) return this.instruments
    const [stocks, indices] = await Promise.all([
      this.run(['stock', 'instruments'], signal),
      this.run(['index', 'instruments'], signal),
    ])
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
    if (call.interval !== '1d') {
      throw new ProviderError('UNSUPPORTED_INTERVAL', 'AKShare bridge currently supports daily bars', false)
    }
    const isIndex = call.providerSymbol.startsWith('csi') ||
      call.providerSymbol.startsWith('sh000') || call.providerSymbol.startsWith('sz399')
    const symbol = call.providerSymbol.replace(/^(sh|sz|bj|csi)/, '')
    const adjustment = call.adjustment === 'forward' ? 'qfq' : call.adjustment === 'backward' ? 'hfq' : ''
    const args = isIndex
      ? ['index', 'bars', '--symbol', call.providerSymbol, '--start-date', dateArgument(call.start, '19900101'), '--end-date', dateArgument(call.end, '20500101')]
      : ['stock', 'bars', '--symbol', symbol, '--period', 'daily', '--start-date', dateArgument(call.start, '19700101'), '--end-date', dateArgument(call.end, '20500101'), '--adjust', adjustment]
    const rows = await this.run(args, call.signal)
    return rows.flatMap((record): ProviderBar[] => {
      const date = asText(pick(record, 'date', '日期'))
      const open = asText(pick(record, 'open', '开盘'))
      const high = asText(pick(record, 'high', '最高'))
      const low = asText(pick(record, 'low', '最低'))
      const close = asText(pick(record, 'close', '收盘'))
      if (!date || !open || !high || !low || !close) return []
      return [{
        interval: '1d', tradingDate: date,
        periodStart: `${date}T00:00:00+08:00`, periodEnd: `${date}T23:59:59+08:00`,
        currency: 'CNY', open, high, low, close,
        volume: asNumber(pick(record, 'volume', '成交量')),
        turnover: asText(pick(record, 'amount', '成交额')) ?? null,
        adjustment: call.adjustment, complete: true,
      }]
    })
  }

  async getQuote(call: { providerSymbol: string; signal: AbortSignal }): Promise<ProviderQuote> {
    const end = new Date()
    const start = new Date(end.getTime() - 21 * 86_400_000)
    const bars = await this.getBars({
      ...call, interval: '1d', adjustment: 'none',
      start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10),
    })
    const latest = bars.at(-1)
    if (!latest) throw new ProviderError('NO_DATA', 'no recent quote data', false)
    const previous = bars.at(-2)
    return {
      marketTime: latest.periodEnd, currency: latest.currency, marketStatus: 'unknown',
      last: latest.close, open: latest.open, high: latest.high, low: latest.low,
      previousClose: previous?.close ?? null, volume: latest.volume, turnover: latest.turnover,
    }
  }

  async getConstituents(call: ConstituentsCall): Promise<readonly ProviderConstituent[]> {
    const symbol = call.providerSymbol.replace(/^(sh|sz|csi)/, '')
    const rows = await this.run(['index', 'constituents', '--symbol', symbol], call.signal)
    const asOfDate = call.asOf ?? new Date().toISOString().slice(0, 10)
    return rows.flatMap((record, index): ProviderConstituent[] => {
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
