export type InstrumentType = 'equity' | 'index'

export type InstrumentStatus = 'active' | 'inactive'

export type InstrumentCapability = 'quote' | 'bars' | 'constituents'

export type BarInterval =
  | '1m'
  | '5m'
  | '15m'
  | '30m'
  | '60m'
  | '1d'
  | '1w'
  | '1mo'

export type PriceAdjustment = 'none' | 'forward' | 'backward'

export interface ProviderCall {
  providerSymbol: string
  signal: AbortSignal
}

export interface ProviderQuote {
  source?: string
  marketTime?: string | null
  currency: string
  marketStatus: 'trading' | 'closed' | 'halted' | 'auction' | 'unknown'
  last: string | null
  open: string | null
  high: string | null
  low: string | null
  previousClose: string | null
  volume: number | null
  turnover: string | null
}

export interface ProviderBar {
  source?: string
  interval: BarInterval
  tradingDate: string
  periodStart: string
  periodEnd: string
  currency: string
  open: string
  high: string
  low: string
  close: string
  volume: number | null
  turnover: string | null
  adjustment: PriceAdjustment
  complete: boolean
}

export interface BarsCall extends ProviderCall {
  interval: BarInterval
  start?: string
  end?: string
  adjustment: PriceAdjustment
}

export interface ProviderConstituent {
  constituentProviderSymbol: string
  asOfDate: string
  effectiveFrom: string | null
  effectiveTo: string | null
  weightRatio: string | null
  rank: number | null
}

export interface ConstituentsCall extends ProviderCall {
  asOf?: string
}

export interface ProviderInstrument {
  type: InstrumentType
  market: 'CN'
  name: string
  symbol: string
  providerSymbol: string
  venue?: string
  publisher?: string
  currency: string
  status: InstrumentStatus
  aliases?: readonly string[]
  capabilities: readonly InstrumentCapability[]
}

export interface InstrumentProvider {
  readonly id: string
  listInstruments(signal?: AbortSignal): Promise<readonly ProviderInstrument[]>
  close?(): Promise<void> | void
  getQuote?(call: ProviderCall): Promise<ProviderQuote>
  getBars?(call: BarsCall): Promise<readonly ProviderBar[]>
  getConstituents?(
    call: ConstituentsCall,
  ): Promise<readonly ProviderConstituent[]>
}

export interface StoredProviderCatalog {
  provider: string
  instruments: readonly ProviderInstrument[]
  fetchedAt: string
}

export interface CatalogSnapshotStore {
  readProvider(provider: string): Promise<StoredProviderCatalog | undefined>
  writeProvider(snapshot: StoredProviderCatalog): Promise<void>
  close?(): Promise<void> | void
}

export class MemoryCatalogSnapshotStore implements CatalogSnapshotStore {
  private readonly snapshots = new Map<string, StoredProviderCatalog>()

  async readProvider(provider: string): Promise<StoredProviderCatalog | undefined> {
    return this.snapshots.get(provider)
  }

  async writeProvider(snapshot: StoredProviderCatalog): Promise<void> {
    this.snapshots.set(snapshot.provider, snapshot)
  }
}

export interface ProviderIdentifier {
  provider: string
  value: string
  capabilities: readonly InstrumentCapability[]
}

export interface CatalogInstrument {
  instrumentId: string
  type: InstrumentType
  market: 'CN'
  name: string
  symbol: string
  venue?: string
  publisher?: string
  currency: string
  status: InstrumentStatus
  aliases: readonly string[]
  capabilities: readonly InstrumentCapability[]
  identifiers: readonly ProviderIdentifier[]
}

export interface InstrumentSearchContext {
  instrumentType?: InstrumentType
  venue?: string
  publisher?: string
  capability?: InstrumentCapability
}

export type InstrumentMatchType =
  | 'exact_id'
  | 'exact_symbol'
  | 'exact_name'
  | 'exact_alias'
  | 'prefix'
  | 'contains'
  | 'fuzzy'

export interface InstrumentSearchMatch {
  instrument: CatalogInstrument
  matchType: InstrumentMatchType
  score: number
}

export function canonicalInstrumentId(instrument: ProviderInstrument): string {
  const owner = instrument.type === 'equity' ? instrument.venue : instrument.publisher
  if (!owner) {
    throw new Error(`${instrument.type} instrument is missing its identity owner`)
  }
  return [
    instrument.market.toLowerCase(),
    instrument.type,
    owner,
    instrument.symbol,
  ].join(':')
}

export function buildInstrumentCatalog(
  groups: readonly {
    provider: string
    instruments: readonly ProviderInstrument[]
  }[],
): readonly CatalogInstrument[] {
  const entries = new Map<
    string,
    {
      instrument: CatalogInstrument
      aliases: Set<string>
      capabilities: Set<InstrumentCapability>
      identifiers: ProviderIdentifier[]
    }
  >()

  for (const group of groups) {
    for (const candidate of group.instruments) {
      const instrumentId = canonicalInstrumentId(candidate)
      const existing = entries.get(instrumentId)
      if (!existing) {
        const aliases = new Set(candidate.aliases ?? [])
        const capabilities = new Set(candidate.capabilities)
        const identifiers = [
          {
            provider: group.provider,
            value: candidate.providerSymbol,
            capabilities: [...candidate.capabilities].sort(),
          },
        ]
        entries.set(instrumentId, {
          aliases,
          capabilities,
          identifiers,
          instrument: {
            instrumentId,
            type: candidate.type,
            market: candidate.market,
            name: candidate.name,
            symbol: candidate.symbol,
            venue: candidate.venue,
            publisher: candidate.publisher,
            currency: candidate.currency,
            status: candidate.status,
            aliases: [],
            capabilities: [],
            identifiers: [],
          },
        })
        continue
      }

      if (candidate.name !== existing.instrument.name) {
        existing.aliases.add(candidate.name)
      }
      for (const alias of candidate.aliases ?? []) existing.aliases.add(alias)
      for (const capability of candidate.capabilities) {
        existing.capabilities.add(capability)
      }
      existing.identifiers.push({
        provider: group.provider,
        value: candidate.providerSymbol,
        capabilities: [...candidate.capabilities].sort(),
      })
    }
  }

  return [...entries.values()]
    .map(({ instrument, aliases, capabilities, identifiers }) => ({
      ...instrument,
      aliases: [...aliases].sort(),
      capabilities: [...capabilities].sort(),
      identifiers: [...identifiers].sort((left, right) =>
        left.provider.localeCompare(right.provider),
      ),
    }))
    .sort((left, right) => left.instrumentId.localeCompare(right.instrumentId))
}

export class ProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}

export class ProviderRoutingError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message)
    this.name = 'ProviderRoutingError'
  }
}

export interface RoutedResult<T> {
  value: T
  provider: string
  attempts: number
  observedAt: string
}

async function withProviderTimeout<T>(
  timeoutMs: number,
  invoke: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      invoke(controller.signal),
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort()
          reject(
            new ProviderError(
              'PROVIDER_TIMEOUT',
              'provider request exceeded its deadline',
              true,
            ),
          )
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

export async function retryProviderCall<T>(options: {
  retryAttempts: number
  timeoutMs: number
  invoke: (signal: AbortSignal) => Promise<T>
}): Promise<{ value: T; attempts: number }> {
  let lastError: ProviderError | undefined
  const attempts = Math.max(options.retryAttempts, 1)
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const value = await withProviderTimeout(options.timeoutMs, options.invoke)
      return { value, attempts: attempt }
    } catch (error) {
      const normalized =
        error instanceof ProviderError
          ? error
          : new ProviderError('PROVIDER_ERROR', 'provider request failed', true)
      lastError = normalized
      if (!normalized.retryable) throw normalized
    }
  }
  throw lastError ?? new ProviderError('PROVIDER_ERROR', 'provider request failed', true)
}

export async function routeInstrumentData<T>(options: {
  providers: readonly InstrumentProvider[]
  instrument: CatalogInstrument
  capability: InstrumentCapability
  retryAttempts: number
  timeoutMs: number
  supports: (provider: InstrumentProvider) => boolean
  invoke: (
    provider: InstrumentProvider,
    providerSymbol: string,
    signal: AbortSignal,
  ) => Promise<T> | undefined
}): Promise<RoutedResult<T>> {
  let totalAttempts = 0
  let lastError: ProviderError | undefined
  for (const provider of options.providers) {
    const identifier = options.instrument.identifiers.find(
      (candidate) =>
        candidate.provider === provider.id &&
        candidate.capabilities.includes(options.capability),
    )
    if (!identifier) continue
    if (!options.supports(provider)) continue

    for (let attempt = 0; attempt < options.retryAttempts; attempt += 1) {
      totalAttempts += 1
      try {
        const value = await withProviderTimeout(options.timeoutMs, (signal) => {
          const result = options.invoke(provider, identifier.value, signal)
          if (!result) {
            throw new ProviderError(
              'CAPABILITY_UNAVAILABLE',
              'provider does not implement the declared capability',
              false,
            )
          }
          return result
        })
        return {
          value,
          provider: provider.id,
          attempts: totalAttempts,
          observedAt: new Date().toISOString(),
        }
      } catch (error) {
        const normalized =
          error instanceof ProviderError
            ? error
            : new ProviderError(
                'PROVIDER_ERROR',
                'provider request failed',
                true,
              )
        lastError = normalized
        if (!normalized.retryable) {
          throw new ProviderRoutingError(
            normalized.code,
            normalized.message,
            false,
          )
        }
      }
    }
  }

  if (lastError) {
    throw new ProviderRoutingError(
      'ALL_PROVIDERS_FAILED',
      'all eligible providers failed',
      true,
    )
  }
  throw new ProviderRoutingError(
    'CAPABILITY_UNAVAILABLE',
    'no provider supports this capability for the instrument',
    false,
  )
}

function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('zh-CN')
}

function matchesContext(
  instrument: CatalogInstrument,
  context: InstrumentSearchContext,
): boolean {
  if (context.instrumentType && instrument.type !== context.instrumentType) return false
  if (context.venue && instrument.venue !== context.venue) return false
  if (context.publisher && instrument.publisher !== context.publisher) return false
  if (
    context.capability &&
    !instrument.capabilities.includes(context.capability)
  ) {
    return false
  }
  return true
}

function scoreInstrument(
  instrument: CatalogInstrument,
  normalizedQuery: string,
): Omit<InstrumentSearchMatch, 'instrument'> | undefined {
  const instrumentId = normalizeSearchText(instrument.instrumentId)
  const symbol = normalizeSearchText(instrument.symbol)
  const name = normalizeSearchText(instrument.name)
  const aliases = instrument.aliases.map(normalizeSearchText)

  if (instrumentId === normalizedQuery) return { matchType: 'exact_id', score: 1000 }
  if (symbol === normalizedQuery) return { matchType: 'exact_symbol', score: 950 }
  if (name === normalizedQuery) return { matchType: 'exact_name', score: 925 }
  if (aliases.includes(normalizedQuery)) return { matchType: 'exact_alias', score: 900 }

  const texts = [symbol, name, ...aliases]
  if (texts.some((text) => text.startsWith(normalizedQuery))) {
    return { matchType: 'prefix', score: 700 }
  }
  if (texts.some((text) => text.includes(normalizedQuery))) {
    return { matchType: 'contains', score: 600 }
  }
  if (normalizedQuery.length >= 3) {
    const distance = Math.min(...texts.map((text) => levenshtein(text, normalizedQuery)))
    const threshold = Math.max(1, Math.floor(normalizedQuery.length * 0.25))
    if (distance <= threshold) {
      return { matchType: 'fuzzy', score: 400 - distance }
    }
  }
}

function levenshtein(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex]
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitution =
        previous[rightIndex - 1] +
        (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      current[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        current[rightIndex - 1] + 1,
        substitution,
      )
    }
    previous.splice(0, previous.length, ...current)
  }
  return previous[right.length]
}

export function searchInstrumentCatalog(
  instruments: readonly CatalogInstrument[],
  query: string,
  context: InstrumentSearchContext = {},
  limit = 20,
): readonly InstrumentSearchMatch[] {
  const normalizedQuery = normalizeSearchText(query)
  if (!normalizedQuery) return []

  return instruments
    .filter((instrument) => matchesContext(instrument, context))
    .flatMap((instrument) => {
      const score = scoreInstrument(instrument, normalizedQuery)
      return score ? [{ instrument, ...score }] : []
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.instrument.instrumentId.localeCompare(right.instrument.instrumentId),
    )
    .slice(0, limit)
}
