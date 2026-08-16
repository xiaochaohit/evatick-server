export type InstrumentType = 'equity' | 'index'

export type InstrumentStatus = 'active' | 'inactive'

export type InstrumentCapability = 'quote' | 'bars' | 'constituents'

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
  listInstruments(): Promise<readonly ProviderInstrument[]>
}

export interface ProviderIdentifier {
  provider: string
  value: string
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
          { provider: group.provider, value: candidate.providerSymbol },
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
