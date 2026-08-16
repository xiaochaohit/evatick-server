export type InstrumentType = 'equity' | 'index'

export type InstrumentStatus = 'active' | 'inactive'

export interface Instrument {
  instrumentId: string
  type: InstrumentType
  name: string
  symbol: string
  venue?: string
  publisher?: string
  currency: string
  status: InstrumentStatus
}

export interface InstrumentProvider {
  readonly id: string
  listInstruments(): Promise<readonly Instrument[]>
}
