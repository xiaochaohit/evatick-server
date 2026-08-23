import {
  ProviderError,
  type BarsCall,
  type DataSourceCheckCall,
  type DataSourceCheckResult,
  type InstrumentProvider,
  type ProviderBar,
  type ProviderInstrument,
  type ProviderQuote,
} from '@evatick/core'

type JsonObject = Record<string, unknown>
type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface PublicCryptoProviderOptions {
  baseUrl?: string
  fetch?: Fetch
}

function object(value: unknown, description: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProviderError('PROVIDER_INVALID_RESPONSE', `${description} is not an object`, false)
  }
  return value as JsonObject
}

function array(value: unknown, description: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ProviderError('PROVIDER_INVALID_RESPONSE', `${description} is not an array`, false)
  }
  return value
}

function text(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

function number(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function utcDayStart(value: string): number {
  return Date.parse(`${value}T00:00:00.000Z`)
}

function utcDayEnd(value: string): number {
  return Date.parse(`${value}T23:59:59.999Z`)
}

async function requestJson(
  fetcher: Fetch,
  baseUrl: string,
  path: string,
  signal: AbortSignal,
): Promise<unknown> {
  let response: Response
  try {
    response = await fetcher(`${baseUrl}${path}`, {
      signal,
      headers: { accept: 'application/json', 'user-agent': 'EVA-Tick/1.0' },
    })
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError'
    throw new ProviderError(
      aborted ? 'PROVIDER_ABORTED' : 'PROVIDER_NETWORK_ERROR',
      aborted ? 'crypto market-data request was aborted' : 'crypto market-data source is unreachable',
      true,
    )
  }
  if (!response.ok) {
    const retryable = response.status === 408 || response.status === 429 || response.status >= 500
    throw new ProviderError(
      response.status === 429 ? 'PROVIDER_RATE_LIMITED' : 'PROVIDER_HTTP_ERROR',
      `crypto market-data source returned HTTP ${response.status}`,
      retryable,
    )
  }
  try {
    return await response.json()
  } catch {
    throw new ProviderError('PROVIDER_INVALID_RESPONSE', 'crypto market-data source returned invalid JSON', false)
  }
}

function requireRawBars(adjustment: BarsCall['adjustment']): void {
  if (adjustment !== 'none') {
    throw new ProviderError(
      'UNSUPPORTED_ADJUSTMENT',
      'crypto market-data providers only support unadjusted bars',
      false,
    )
  }
}

const BINANCE_INTERVALS = {
  '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m',
  '60m': '1h', '1d': '1d', '1w': '1w', '1mo': '1M',
} as const

export class BinanceProvider implements InstrumentProvider {
  readonly id = 'binance'
  readonly dataSources = [{
    id: 'binance',
    name: 'Binance',
    categories: ['crypto'],
    capabilities: { crypto: ['交易对目录', '行情快照', '1分钟至月线行情柱'] },
  }] as const

  private readonly baseUrl: string
  private readonly fetcher: Fetch
  private instruments: readonly ProviderInstrument[] | undefined
  private readonly currencies = new Map<string, string>()

  constructor(options: PublicCryptoProviderOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'https://data-api.binance.vision').replace(/\/$/, '')
    this.fetcher = options.fetch ?? globalThis.fetch
  }

  async checkDataSource(call: DataSourceCheckCall): Promise<DataSourceCheckResult> {
    if (call.sourceId !== 'binance' || call.category !== 'crypto') {
      throw new ProviderError('UNKNOWN_DATA_SOURCE', 'unknown Binance data source', false)
    }
    await requestJson(this.fetcher, this.baseUrl, '/api/v3/ping', call.signal)
    return { recordsChecked: 1 }
  }

  async listInstruments(
    signal = new AbortController().signal,
    options: { refresh?: boolean } = {},
  ): Promise<readonly ProviderInstrument[]> {
    if (this.instruments && !options.refresh) return this.instruments
    const payload = object(
      await requestJson(this.fetcher, this.baseUrl, '/api/v3/exchangeInfo', signal),
      'Binance exchange information',
    )
    this.instruments = array(payload.symbols, 'Binance symbols').flatMap((item): ProviderInstrument[] => {
      const row = object(item, 'Binance symbol')
      const providerSymbol = text(row.symbol)
      const base = text(row.baseAsset)
      const quote = text(row.quoteAsset)
      if (!providerSymbol || !base || !quote || row.isSpotTradingAllowed === false) return []
      this.currencies.set(providerSymbol, quote)
      return [{
        type: 'crypto',
        market: 'GLOBAL',
        name: `${base}/${quote}`,
        symbol: `${base}-${quote}`,
        providerSymbol,
        venue: 'BINANCE',
        currency: quote,
        status: row.status === 'TRADING' ? 'active' : 'inactive',
        aliases: [providerSymbol, `${base}/${quote}`],
        capabilities: ['quote', 'bars'],
      }]
    })
    return this.instruments
  }

  async getQuote(call: { providerSymbol: string; signal: AbortSignal }): Promise<ProviderQuote> {
    const query = new URLSearchParams({ symbol: call.providerSymbol })
    const row = object(
      await requestJson(this.fetcher, this.baseUrl, `/api/v3/ticker/24hr?${query}`, call.signal),
      'Binance ticker',
    )
    const closeTime = number(row.closeTime)
    return {
      source: 'binance',
      marketTime: closeTime === null ? null : new Date(closeTime).toISOString(),
      currency: this.currencies.get(call.providerSymbol) ?? '',
      marketStatus: 'trading',
      last: text(row.lastPrice),
      open: text(row.openPrice),
      high: text(row.highPrice),
      low: text(row.lowPrice),
      previousClose: text(row.prevClosePrice),
      volume: number(row.volume),
      turnover: text(row.quoteVolume),
    }
  }

  async getBars(call: BarsCall): Promise<readonly ProviderBar[]> {
    requireRawBars(call.adjustment)
    const interval = BINANCE_INTERVALS[call.interval]
    const rows: unknown[] = []
    const endTime = call.end ? utcDayEnd(call.end) : undefined
    let cursor = call.start ? utcDayStart(call.start) : undefined
    do {
      const query = new URLSearchParams({
        symbol: call.providerSymbol,
        interval,
        limit: '1000',
        ...(cursor === undefined ? {} : { startTime: String(cursor) }),
        ...(endTime === undefined ? {} : { endTime: String(endTime) }),
      })
      const page = array(
        await requestJson(this.fetcher, this.baseUrl, `/api/v3/klines?${query}`, call.signal),
        'Binance bars',
      )
      rows.push(...page)
      if (cursor === undefined || page.length < 1000) break
      const last = array(page.at(-1), 'Binance bar')
      const next = number(last[6])
      if (next === null || next < cursor || (endTime !== undefined && next >= endTime)) break
      cursor = next + 1
    } while (true)

    return rows.map((item): ProviderBar => {
      const row = array(item, 'Binance bar')
      const start = number(row[0])
      const end = number(row[6])
      const open = text(row[1])
      const high = text(row[2])
      const low = text(row[3])
      const close = text(row[4])
      if (start === null || end === null || !open || !high || !low || !close) {
        throw new ProviderError('PROVIDER_INVALID_RESPONSE', 'Binance bar is incomplete', false)
      }
      return {
        source: 'binance',
        interval: call.interval,
        tradingDate: new Date(start).toISOString().slice(0, 10),
        periodStart: new Date(start).toISOString(),
        periodEnd: new Date(end + 1).toISOString(),
        currency: this.currencies.get(call.providerSymbol) ?? '',
        open, high, low, close,
        volume: number(row[5]),
        turnover: text(row[7]),
        adjustment: 'none',
        complete: end < Date.now(),
      }
    })
  }
}

const COINBASE_GRANULARITIES = {
  '1m': 60, '5m': 300, '15m': 900, '60m': 3600, '1d': 86400,
} as const

export class CoinbaseProvider implements InstrumentProvider {
  readonly id = 'coinbase'
  readonly dataSources = [{
    id: 'coinbase',
    name: 'Coinbase Exchange',
    categories: ['crypto'],
    capabilities: { crypto: ['交易对目录', '行情快照', '1/5/15/60分钟与日线行情柱'] },
  }] as const

  private readonly baseUrl: string
  private readonly fetcher: Fetch
  private instruments: readonly ProviderInstrument[] | undefined

  constructor(options: PublicCryptoProviderOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'https://api.exchange.coinbase.com').replace(/\/$/, '')
    this.fetcher = options.fetch ?? globalThis.fetch
  }

  async checkDataSource(call: DataSourceCheckCall): Promise<DataSourceCheckResult> {
    if (call.sourceId !== 'coinbase' || call.category !== 'crypto') {
      throw new ProviderError('UNKNOWN_DATA_SOURCE', 'unknown Coinbase data source', false)
    }
    await requestJson(this.fetcher, this.baseUrl, '/time', call.signal)
    return { recordsChecked: 1 }
  }

  async listInstruments(
    signal = new AbortController().signal,
    options: { refresh?: boolean } = {},
  ): Promise<readonly ProviderInstrument[]> {
    if (this.instruments && !options.refresh) return this.instruments
    const payload = array(
      await requestJson(this.fetcher, this.baseUrl, '/products', signal),
      'Coinbase products',
    )
    this.instruments = payload.flatMap((item): ProviderInstrument[] => {
      const row = object(item, 'Coinbase product')
      const providerSymbol = text(row.id)
      const base = text(row.base_currency)
      const quote = text(row.quote_currency)
      if (!providerSymbol || !base || !quote) return []
      return [{
        type: 'crypto',
        market: 'GLOBAL',
        name: text(row.display_name) ?? `${base}/${quote}`,
        symbol: `${base}-${quote}`,
        providerSymbol,
        venue: 'COINBASE',
        currency: quote,
        status: row.status === 'online' && row.trading_disabled !== true ? 'active' : 'inactive',
        aliases: [providerSymbol, `${base}/${quote}`],
        capabilities: ['quote', 'bars'],
      }]
    })
    return this.instruments
  }

  async getQuote(call: { providerSymbol: string; signal: AbortSignal }): Promise<ProviderQuote> {
    const product = encodeURIComponent(call.providerSymbol)
    const [statsPayload, tickerPayload] = await Promise.all([
      requestJson(this.fetcher, this.baseUrl, `/products/${product}/stats`, call.signal),
      requestJson(this.fetcher, this.baseUrl, `/products/${product}/ticker`, call.signal),
    ])
    const stats = object(statsPayload, 'Coinbase product stats')
    const ticker = object(tickerPayload, 'Coinbase product ticker')
    return {
      source: 'coinbase',
      marketTime: text(ticker.time),
      currency: call.providerSymbol.split('-').at(-1) ?? '',
      marketStatus: 'trading',
      last: text(ticker.price) ?? text(stats.last),
      open: text(stats.open),
      high: text(stats.high),
      low: text(stats.low),
      previousClose: null,
      volume: number(stats.volume),
      turnover: null,
    }
  }

  async getBars(call: BarsCall): Promise<readonly ProviderBar[]> {
    requireRawBars(call.adjustment)
    const granularity = COINBASE_GRANULARITIES[call.interval as keyof typeof COINBASE_GRANULARITIES]
    if (!granularity) {
      throw new ProviderError(
        'UNSUPPORTED_INTERVAL',
        'Coinbase supports 1m, 5m, 15m, 60m, and 1d bars',
        false,
      )
    }
    const product = encodeURIComponent(call.providerSymbol)
    const end = call.end ? utcDayEnd(call.end) : Date.now()
    const start = call.start ? utcDayStart(call.start) : end - granularity * 299_000
    const byStart = new Map<number, unknown[]>()
    for (let cursor = start; cursor <= end;) {
      const chunkEnd = Math.min(end, cursor + granularity * 299_000)
      const query = new URLSearchParams({
        granularity: String(granularity),
        start: new Date(cursor).toISOString(),
        end: new Date(chunkEnd).toISOString(),
      })
      const page = array(
        await requestJson(this.fetcher, this.baseUrl, `/products/${product}/candles?${query}`, call.signal),
        'Coinbase bars',
      )
      for (const item of page) {
        const row = array(item, 'Coinbase bar')
        const seconds = number(row[0])
        if (seconds !== null) byStart.set(seconds, row)
      }
      if (chunkEnd >= end) break
      cursor = chunkEnd + granularity * 1000
    }

    return [...byStart.entries()]
      .sort(([left], [right]) => left - right)
      .map(([seconds, row]): ProviderBar => {
        const startTime = seconds * 1000
        const endTime = startTime + granularity * 1000
        const low = text(row[1])
        const high = text(row[2])
        const open = text(row[3])
        const close = text(row[4])
        if (!open || !high || !low || !close) {
          throw new ProviderError('PROVIDER_INVALID_RESPONSE', 'Coinbase bar is incomplete', false)
        }
        return {
          source: 'coinbase',
          interval: call.interval,
          tradingDate: new Date(startTime).toISOString().slice(0, 10),
          periodStart: new Date(startTime).toISOString(),
          periodEnd: new Date(endTime).toISOString(),
          currency: call.providerSymbol.split('-').at(-1) ?? '',
          open, high, low, close,
          volume: number(row[5]),
          turnover: null,
          adjustment: 'none',
          complete: endTime <= Date.now(),
        }
      })
  }
}
