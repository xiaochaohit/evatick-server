import { buildInstrumentCatalog } from '@evatick/core'
import { BinanceProvider, CoinbaseProvider } from '@evatick/provider-crypto'
import { describe, expect, it, vi } from 'vitest'

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('public crypto providers', () => {
  it('keeps equal trading pairs distinct by exchange venue', async () => {
    const binance = new BinanceProvider({
      fetch: vi.fn(async () => json({ symbols: [{
        symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT',
        status: 'TRADING', isSpotTradingAllowed: true,
      }] })),
    })
    const coinbase = new CoinbaseProvider({
      fetch: vi.fn(async () => json([{
        id: 'BTC-USDT', base_currency: 'BTC', quote_currency: 'USDT',
        display_name: 'BTC/USDT', status: 'online', trading_disabled: false,
      }])),
    })

    const catalog = buildInstrumentCatalog([
      { provider: binance.id, instruments: await binance.listInstruments() },
      { provider: coinbase.id, instruments: await coinbase.listInstruments() },
    ])

    expect(catalog.map((instrument) => instrument.instrumentId)).toEqual([
      'global:crypto:BINANCE:BTC-USDT',
      'global:crypto:COINBASE:BTC-USDT',
    ])
    expect(catalog[0]?.identifiers).toEqual([{
      provider: 'binance', value: 'BTCUSDT', capabilities: ['bars', 'quote'],
    }])
    expect(catalog[1]?.identifiers).toEqual([{
      provider: 'coinbase', value: 'BTC-USDT', capabilities: ['bars', 'quote'],
    }])
  })

  it('normalizes Binance quotes and bars without authentication headers', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/exchangeInfo')) return json({ symbols: [{
        symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT',
        status: 'TRADING', isSpotTradingAllowed: true,
      }] })
      if (url.includes('/ticker/24hr')) return json({
        symbol: 'BTCUSDT', closeTime: 1_777_000_000_000,
        lastPrice: '61000.5', openPrice: '60000', highPrice: '62000',
        lowPrice: '59000', prevClosePrice: '59950', volume: '12.5', quoteVolume: '760000',
      })
      return json([[
        1_777_000_000_000, '60000', '62000', '59000', '61000', '12.5',
        1_777_000_059_999, '760000', 42,
      ]])
    })
    const provider = new BinanceProvider({ fetch: fetcher })
    await provider.listInstruments()
    const signal = new AbortController().signal

    await expect(provider.getQuote({ providerSymbol: 'BTCUSDT', signal })).resolves.toMatchObject({
      source: 'binance', currency: 'USDT', last: '61000.5', volume: 12.5,
    })
    await expect(provider.getBars({
      providerSymbol: 'BTCUSDT', signal, interval: '1m', adjustment: 'none',
    })).resolves.toEqual([expect.objectContaining({
      source: 'binance', currency: 'USDT', interval: '1m',
      open: '60000', close: '61000', volume: 12.5,
    })])
    expect(fetcher.mock.calls.every((call) => !String(call[0]).includes('apiKey'))).toBe(true)
  })

  it('normalizes Coinbase quotes and supported candle intervals', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/stats')) return json({
        open: '60010', high: '62100', low: '59100', last: '61100', volume: '9.25',
      })
      if (url.endsWith('/ticker')) return json({ price: '61100', time: '2026-04-25T12:00:00Z' })
      return json([[1_777_000_000, '59100', '62100', '60010', '61100', '9.25']])
    })
    const provider = new CoinbaseProvider({ fetch: fetcher })
    const signal = new AbortController().signal

    await expect(provider.getQuote({ providerSymbol: 'BTC-USDT', signal })).resolves.toMatchObject({
      source: 'coinbase', currency: 'USDT', last: '61100', volume: 9.25,
    })
    await expect(provider.getBars({
      providerSymbol: 'BTC-USDT', signal, interval: '1m', adjustment: 'none',
      start: '2026-04-25', end: '2026-04-25',
    })).resolves.toEqual([expect.objectContaining({
      source: 'coinbase', currency: 'USDT', interval: '1m', open: '60010', close: '61100',
    })])
    await expect(provider.getBars({
      providerSymbol: 'BTC-USDT', signal, interval: '30m', adjustment: 'none',
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_INTERVAL', retryable: false })
  })
})
