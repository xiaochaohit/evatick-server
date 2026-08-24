import {
  ProviderError,
  type BarsCall,
  type ConstituentsCall,
  type DataSourceCheckCall,
  type DataSourceCheckResult,
  type InstrumentProvider,
  type ProviderBar,
  type ProviderConstituent,
  type ProviderInstrument,
  type ProviderQuote,
} from '@evatick/core'

type JsonObject = Record<string, unknown>
type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
type InstrumentKind = 'equity' | 'index'

export interface HithinkProviderOptions {
  apiKey: string
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
  if (value === null || value === undefined || value === '') return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function requiredText(value: unknown, description: string): string {
  const parsed = text(value)
  if (!parsed) {
    throw new ProviderError('PROVIDER_INVALID_RESPONSE', `${description} is missing`, false)
  }
  return parsed
}

function retryableBusinessCode(code: number): boolean {
  return code === 3002 || code === 4001 || [5001, 5002, 5003].includes(code)
}

async function requestData(
  fetcher: Fetch,
  baseUrl: string,
  apiKey: string,
  path: string,
  signal: AbortSignal,
): Promise<JsonObject> {
  let response: Response
  try {
    response = await fetcher(`${baseUrl}${path}`, {
      method: 'GET',
      signal,
      headers: { accept: 'application/json', 'X-api-key': apiKey },
    })
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError'
    throw new ProviderError(
      aborted ? 'PROVIDER_ABORTED' : 'PROVIDER_NETWORK_ERROR',
      aborted ? 'HiThink request was aborted' : 'HiThink Fuyao API is unreachable',
      true,
    )
  }
  if (!response.ok) {
    const retryable = response.status === 408 || response.status === 429 || response.status >= 500
    throw new ProviderError(
      response.status === 429 ? 'PROVIDER_RATE_LIMITED' : 'PROVIDER_HTTP_ERROR',
      `HiThink Fuyao API returned HTTP ${response.status}`,
      retryable,
    )
  }

  let payload: JsonObject
  try {
    payload = object(await response.json(), 'HiThink response envelope')
  } catch (error) {
    if (error instanceof ProviderError) throw error
    throw new ProviderError('PROVIDER_INVALID_RESPONSE', 'HiThink Fuyao API returned invalid JSON', false)
  }
  const code = number(payload.code)
  if (code === null) {
    throw new ProviderError('PROVIDER_INVALID_RESPONSE', 'HiThink response omitted its business code', false)
  }
  if (code !== 0) {
    throw new ProviderError(
      `HITHINK_${code}`,
      text(payload.message) ?? 'HiThink Fuyao API rejected the request',
      retryableBusinessCode(code),
    )
  }
  return object(payload.data, 'HiThink response data')
}

function providerSymbol(kind: InstrumentKind, thscode: string): string {
  return `${kind}:${thscode}`
}

function parseProviderSymbol(value: string): { kind: InstrumentKind; thscode: string } {
  const separator = value.indexOf(':')
  const kind = value.slice(0, separator)
  const thscode = value.slice(separator + 1)
  if ((kind !== 'equity' && kind !== 'index') || !/^[A-Z0-9]+\.(?:SH|SZ|BJ)$/.test(thscode)) {
    throw new ProviderError('INVALID_PROVIDER_SYMBOL', 'invalid HiThink provider symbol', false)
  }
  return { kind, thscode }
}

function equityVenue(exchange: string): 'XSHG' | 'XSHE' | 'XBSE' {
  if (exchange === 'SH') return 'XSHG'
  if (exchange === 'SZ') return 'XSHE'
  if (exchange === 'BJ') return 'XBSE'
  throw new ProviderError('PROVIDER_INVALID_RESPONSE', `unsupported A-share exchange: ${exchange}`, false)
}

function indexPublisher(exchange: string, name: string): 'SSE' | 'SZSE' | 'CSI' {
  if (name.includes('中证') || name.includes('沪深')) return 'CSI'
  return exchange === 'SZ' ? 'SZSE' : 'SSE'
}

function shanghaiDate(timestamp: number): string {
  return new Date(timestamp + 8 * 3_600_000).toISOString().slice(0, 10)
}

function todayInShanghai(): string {
  return shanghaiDate(Date.now())
}

function isoDate(value: string | undefined, fallback: string, description: string): string {
  if (value === undefined) return fallback
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new ProviderError('INVALID_DATE', `${description} must be an ISO date`, false)
  }
  return value
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function addYears(value: string, years: number): string {
  const date = new Date(`${value}T00:00:00Z`)
  date.setUTCFullYear(date.getUTCFullYear() + years)
  return date.toISOString().slice(0, 10)
}

function startOfShanghaiDay(value: string): number {
  return Date.parse(`${value}T00:00:00+08:00`)
}

function endOfShanghaiDay(value: string): number {
  return Date.parse(`${value}T23:59:59.999+08:00`)
}

function historyWindows(start: string, end: string): { start: number; end: number }[] {
  if (start > end) {
    throw new ProviderError('INVALID_DATE_RANGE', 'bar start date must not follow end date', false)
  }
  const windows: { start: number; end: number }[] = []
  let cursor = start
  while (cursor <= end) {
    const maximumEnd = addDays(addYears(cursor, 10), -1)
    const windowEnd = maximumEnd < end ? maximumEnd : end
    windows.push({ start: startOfShanghaiDay(cursor), end: endOfShanghaiDay(windowEnd) })
    cursor = addDays(windowEnd, 1)
  }
  return windows
}

export class HithinkProvider implements InstrumentProvider {
  readonly id = 'hithink'
  readonly dataSources = [{
    id: 'fuyao',
    name: '同花顺扶摇',
    categories: ['equity', 'index'],
    capabilities: {
      equity: ['标的目录', '行情快照', '未复权日线'],
      index: ['标的目录', '行情快照', '日线', '当前成分'],
    },
  }] as const

  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly fetcher: Fetch
  private instruments: readonly ProviderInstrument[] | undefined

  constructor(options: HithinkProviderOptions) {
    if (!options.apiKey) throw new Error('HiThink API key must not be empty')
    this.apiKey = options.apiKey
    this.baseUrl = (options.baseUrl ?? 'https://fuyao.aicubes.cn').replace(/\/$/, '')
    this.fetcher = options.fetch ?? globalThis.fetch
  }

  async checkDataSource(call: DataSourceCheckCall): Promise<DataSourceCheckResult> {
    if (call.sourceId !== 'fuyao' || (call.category !== 'equity' && call.category !== 'index')) {
      throw new ProviderError('UNKNOWN_DATA_SOURCE', 'unknown HiThink data source', false)
    }
    const query = new URLSearchParams({
      q: call.category === 'equity' ? '600519' : '000300',
      asset_type: call.category === 'equity' ? 'a-share' : 'a-share-index',
      limit: '1',
    })
    const data = await requestData(
      this.fetcher, this.baseUrl, this.apiKey,
      `/api/meta/tickers/search?${query}`, call.signal,
    )
    return { recordsChecked: array(data.item, 'HiThink ticker search items').length }
  }

  async listInstruments(
    signal = new AbortController().signal,
    options: { refresh?: boolean } = {},
  ): Promise<readonly ProviderInstrument[]> {
    if (this.instruments && !options.refresh) return this.instruments
    const [equities, indices] = await Promise.all([
      this.listTickers('a-share', signal),
      this.listTickers('a-share-index', signal),
    ])
    this.instruments = [
      ...equities.map((row): ProviderInstrument => {
        const thscode = requiredText(row.thscode, 'HiThink equity thscode')
        const symbol = requiredText(row.ticker, 'HiThink equity ticker')
        const name = requiredText(row.name, 'HiThink equity name')
        const exchange = requiredText(row.exchange, 'HiThink equity exchange')
        return {
          type: 'equity', market: 'CN', name, symbol,
          providerSymbol: providerSymbol('equity', thscode),
          venue: equityVenue(exchange),
          currency: text(row.currency) ?? 'CNY', status: 'active',
          aliases: [thscode], capabilities: ['quote', 'bars'],
        }
      }),
      ...indices.flatMap((row): ProviderInstrument[] => {
        const thscode = requiredText(row.thscode, 'HiThink index thscode')
        const symbol = thscode.slice(0, thscode.indexOf('.'))
        const upstreamTicker = requiredText(row.ticker, 'HiThink index ticker')
        const name = requiredText(row.name, 'HiThink index name')
        const exchange = text(row.exchange)
        if (!exchange || !['SH', 'SZ'].includes(exchange) || name.includes('国证')) return []
        return [{
          type: 'index', market: 'CN', name, symbol,
          providerSymbol: providerSymbol('index', thscode),
          publisher: indexPublisher(exchange, name),
          currency: text(row.currency) ?? 'CNY', status: 'active',
          aliases: upstreamTicker === symbol ? [thscode] : [thscode, upstreamTicker],
          capabilities: ['quote', 'bars', 'constituents'],
        }]
      }),
    ]
    return this.instruments
  }

  supportsBars(call: Omit<BarsCall, 'signal'>): boolean {
    return call.interval === '1d'
  }

  async getQuote(call: { providerSymbol: string; signal: AbortSignal }): Promise<ProviderQuote> {
    const { kind, thscode } = parseProviderSymbol(call.providerSymbol)
    const query = new URLSearchParams({ thscodes: thscode })
    const path = kind === 'equity'
      ? `/api/a-share/prices/snapshot?${query}`
      : `/api/a-share-index/prices/snapshot?${query}`
    const data = await requestData(this.fetcher, this.baseUrl, this.apiKey, path, call.signal)
    const row = object(
      array(data.item, 'HiThink snapshot items').find((item) =>
        object(item, 'HiThink snapshot item').thscode === thscode),
      'HiThink requested snapshot',
    )
    const timestamp = number(data.timestamp)
    return {
      source: 'fuyao',
      marketTime: timestamp === null ? null : new Date(timestamp).toISOString(),
      currency: 'CNY', marketStatus: 'unknown',
      last: text(row.last_price), open: text(row.open_price),
      high: text(row.high_price), low: text(row.low_price),
      previousClose: text(row.prev_price), volume: number(row.volume),
      turnover: text(row.turnover),
    }
  }

  async getBars(call: BarsCall): Promise<readonly ProviderBar[]> {
    if (!this.supportsBars(call)) {
      throw new ProviderError('UNSUPPORTED_INTERVAL', 'HiThink provider supports daily bars only', false)
    }
    const { kind, thscode } = parseProviderSymbol(call.providerSymbol)
    if (kind === 'index' && call.adjustment !== 'none') {
      throw new ProviderError('UNSUPPORTED_ADJUSTMENT', 'indices do not support price adjustment', false)
    }
    const start = isoDate(call.start, '1990-01-01', 'bar start')
    const end = isoDate(call.end, todayInShanghai(), 'bar end')
    const rows = new Map<number, JsonObject>()
    for (const window of historyWindows(start, end)) {
      const query = new URLSearchParams({
        thscode,
        interval: '1d',
        start: String(window.start),
        end: String(window.end),
        ...(kind === 'equity' ? { adjust: call.adjustment } : {}),
      })
      const path = kind === 'equity'
        ? `/api/a-share/prices/historical?${query}`
        : `/api/a-share-index/prices/historical?${query}`
      const data = await requestData(this.fetcher, this.baseUrl, this.apiKey, path, call.signal)
      for (const item of array(data.item, 'HiThink historical bar items')) {
        const row = object(item, 'HiThink historical bar')
        const date = number(row.date_ms)
        if (date === null) {
          throw new ProviderError('PROVIDER_INVALID_RESPONSE', 'HiThink historical bar omitted date_ms', false)
        }
        rows.set(date, row)
      }
    }
    const today = todayInShanghai()
    return [...rows.entries()].sort(([left], [right]) => left - right).map(([timestamp, row]): ProviderBar => {
      const tradingDate = shanghaiDate(timestamp)
      return {
        source: 'fuyao', interval: '1d', tradingDate,
        periodStart: `${tradingDate}T00:00:00+08:00`,
        periodEnd: `${tradingDate}T23:59:59+08:00`,
        currency: 'CNY',
        open: requiredText(row.open_price, 'HiThink bar open'),
        high: requiredText(row.high_price, 'HiThink bar high'),
        low: requiredText(row.low_price, 'HiThink bar low'),
        close: requiredText(row.close_price, 'HiThink bar close'),
        volume: number(row.volume), turnover: text(row.turnover),
        adjustment: call.adjustment, complete: tradingDate < today,
      }
    })
  }

  supportsConstituents(call: Omit<ConstituentsCall, 'signal'>): boolean {
    return call.asOf === undefined || call.asOf === todayInShanghai()
  }

  async getConstituents(call: ConstituentsCall): Promise<readonly ProviderConstituent[]> {
    if (!this.supportsConstituents(call)) {
      throw new ProviderError(
        'UNSUPPORTED_CONSTITUENT_DATE',
        'HiThink provider supplies current index constituents only',
        false,
      )
    }
    const { kind, thscode } = parseProviderSymbol(call.providerSymbol)
    if (kind !== 'index') {
      throw new ProviderError('UNSUPPORTED_INSTRUMENT_TYPE', 'constituents require an index', false)
    }
    const query = new URLSearchParams({ thscode })
    const data = await requestData(
      this.fetcher, this.baseUrl, this.apiKey,
      `/api/a-share-index/constituents/ths-stock-list?${query}`, call.signal,
    )
    const asOfDate = number(data.timestamp) === null
      ? todayInShanghai()
      : shanghaiDate(number(data.timestamp)!)
    const seen = new Set<string>()
    return array(data.item, 'HiThink constituent items').flatMap((item, index): ProviderConstituent[] => {
      const row = object(item, 'HiThink constituent')
      const constituent = requiredText(row.thscode, 'HiThink constituent thscode')
      if (seen.has(constituent)) return []
      seen.add(constituent)
      return [{
        constituentProviderSymbol: providerSymbol('equity', constituent),
        asOfDate, effectiveFrom: null, effectiveTo: null,
        weightRatio: null, rank: index + 1,
      }]
    })
  }

  private async listTickers(assetType: string, signal: AbortSignal): Promise<JsonObject[]> {
    const rows: JsonObject[] = []
    const limit = 10_000
    for (let offset = 0; ; offset += limit) {
      const query = new URLSearchParams({
        exchange: 'SH,SZ,BJ', asset_type: assetType,
        limit: String(limit), offset: String(offset),
      })
      const data = await requestData(
        this.fetcher, this.baseUrl, this.apiKey,
        `/api/meta/tickers/list?${query}`, signal,
      )
      const page = array(data.item, 'HiThink ticker list items').map((item) =>
        object(item, 'HiThink ticker'))
      rows.push(...page)
      if (page.length < limit) return rows
    }
  }
}
