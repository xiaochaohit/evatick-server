import { BinanceProvider, CoinbaseProvider } from '@evatick/provider-crypto'
import { createEvaTickServer } from '@evatick/server'
import { describe, expect, it, vi } from 'vitest'

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200 })
}

describe('exchange-scoped crypto market data', () => {
  it('requires venue context for equal pairs and never crosses exchanges', async () => {
    const binanceFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/exchangeInfo')) return json({ symbols: [{
        symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT',
        status: 'TRADING', isSpotTradingAllowed: true,
      }] })
      return json({
        symbol: 'BTCUSDT', closeTime: Date.now(), lastPrice: '61000',
        openPrice: '60000', highPrice: '62000', lowPrice: '59000',
        prevClosePrice: '59900', volume: '100', quoteVolume: '6100000',
      })
    })
    const coinbaseFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/products')) return json([{
        id: 'BTC-USDT', base_currency: 'BTC', quote_currency: 'USDT',
        display_name: 'BTC/USDT', status: 'online', trading_disabled: false,
      }])
      if (url.endsWith('/stats')) return json({
        open: '60100', high: '62100', low: '59100', last: '61100', volume: '90',
      })
      return json({ price: '61100', time: new Date().toISOString() })
    })
    const server = await createEvaTickServer({ retryAttempts: 1 })
    try {
      await server.mountProvider(new BinanceProvider({ fetch: binanceFetch }))
      await server.mountProvider(new CoinbaseProvider({ fetch: coinbaseFetch }))

      const search = await fetch(`${server.url}/v1/instrument-search?q=BTC-USDT&instrument_type=crypto`)
        .then((response) => response.json())
      expect(search.data).toEqual([
        expect.objectContaining({
          instrument_id: 'global:crypto:BINANCE:BTC-USDT', venue: 'BINANCE',
        }),
        expect.objectContaining({
          instrument_id: 'global:crypto:COINBASE:BTC-USDT', venue: 'COINBASE',
        }),
      ])

      const syncCatalog = await fetch(
        `${server.url}/v1/data-sync/instruments?type=crypto&q=BTC-USDT&limit=10&offset=0`,
      ).then((response) => response.json())
      expect(syncCatalog.data).toEqual([
        expect.objectContaining({
          instrument_id: 'global:crypto:BINANCE:BTC-USDT', venue: 'BINANCE',
        }),
        expect.objectContaining({
          instrument_id: 'global:crypto:COINBASE:BTC-USDT', venue: 'COINBASE',
        }),
      ])

      const ambiguous = await fetch(`${server.url}/v1/instrument-resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query: 'BTC-USDT', context: { instrument_type: 'crypto', capability: 'quote' },
        }),
      }).then((response) => response.json())
      expect(ambiguous.data.status).toBe('ambiguous')

      const resolved = await fetch(`${server.url}/v1/instrument-resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query: 'BTC-USDT',
          context: { instrument_type: 'crypto', venue: 'COINBASE', capability: 'quote' },
        }),
      }).then((response) => response.json())
      expect(resolved.data).toMatchObject({
        status: 'resolved',
        instrument: { instrument_id: 'global:crypto:COINBASE:BTC-USDT', venue: 'COINBASE' },
      })

      const quote = await fetch(
        `${server.url}/v1/instruments/${encodeURIComponent('global:crypto:COINBASE:BTC-USDT')}/quote`,
      ).then((response) => response.json())
      expect(quote.data).toMatchObject({
        instrument_id: 'global:crypto:COINBASE:BTC-USDT', last: '61100',
      })
      expect(quote.meta.sources).toEqual([
        expect.objectContaining({ provider: 'coinbase', upstream: 'coinbase' }),
      ])
      expect(binanceFetch.mock.calls.some((call) => String(call[0]).includes('/ticker/24hr'))).toBe(false)

      const adjusted = await fetch(
        `${server.url}/v1/instruments/${encodeURIComponent('global:crypto:COINBASE:BTC-USDT')}/bars?adjustment=forward`,
      )
      expect(adjusted.status).toBe(422)
      await expect(adjusted.json()).resolves.toMatchObject({
        code: 'ADJUSTMENT_UNAVAILABLE_FOR_CRYPTO',
      })
    } finally {
      await server.close()
    }
  })
})
