import { BinanceProvider, CoinbaseProvider } from '@evatick/provider-crypto'
import { createEvaTickServer, type InstrumentProvider } from '@evatick/server'
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

  it('keeps synchronized crypto metadata but prefers live quotes', async () => {
    let quoteCalls = 0
    const provider: InstrumentProvider = {
      id: 'live-crypto-fixture',
      async listInstruments() {
        return [{
          type: 'crypto', market: 'GLOBAL', name: 'BTC/USDT', symbol: 'BTC-USDT',
          providerSymbol: 'BTCUSDT', venue: 'BINANCE', currency: 'USDT',
          status: 'active', capabilities: ['quote', 'bars'],
        }]
      },
      async getBars() {
        return [{
          source: 'fixture-bars', interval: '1d', tradingDate: '2026-08-21',
          periodStart: '2026-08-21T00:00:00.000Z',
          periodEnd: '2026-08-22T00:00:00.000Z', currency: 'USDT',
          open: '60000', high: '62000', low: '59000', close: '61000',
          volume: 100, turnover: '6100000', adjustment: 'none', complete: true,
        }]
      },
      async getQuote() {
        quoteCalls += 1
        return {
          source: 'fixture-live', marketTime: '2026-08-23T07:00:00.000Z',
          currency: 'USDT', marketStatus: 'trading', last: '63000',
          open: '61000', high: '64000', low: '60500', previousClose: '61000',
          volume: 120, turnover: '7500000',
        }
      },
    }
    const server = await createEvaTickServer({ healthCheckIntervalMs: 0 })
    await server.mountProvider(provider)
    try {
      const instrumentId = 'global:crypto:BINANCE:BTC-USDT'
      const started = await fetch(`${server.url}/v1/data-sync/runs`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          instrument_types: ['crypto'], instrument_ids: [instrumentId], interval: '1d',
          start: '2026-08-21', end: '2026-08-21', adjustment: 'none', delay_ms: 0,
        }),
      })
      expect(started.status).toBe(202)
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const status = await fetch(`${server.url}/v1/data-sync`).then((response) => response.json())
        if (!status.data.active_run) break
        await new Promise((resolve) => setTimeout(resolve, 10))
      }

      const bars = await fetch(
        `${server.url}/v1/instruments/${encodeURIComponent(instrumentId)}/bars?interval=1d&start=2026-08-21&end=2026-08-21`,
      ).then((response) => response.json())
      expect(bars).toMatchObject({
        data: [{
          currency: 'USDT', period_start: '2026-08-21T00:00:00.000Z',
          period_end: '2026-08-22T00:00:00.000Z', close: '61000',
        }],
        meta: { sources: [{ provider: 'local-duckdb', upstream: 'local' }] },
      })

      const quote = await fetch(
        `${server.url}/v1/instruments/${encodeURIComponent(instrumentId)}/quote`,
      ).then((response) => response.json())
      expect(quote).toMatchObject({
        data: {
          currency: 'USDT', market_time: '2026-08-23T07:00:00.000Z',
          market_status: 'trading', last: '63000',
        },
        meta: { partial: false, sources: [{ provider: 'live-crypto-fixture', upstream: 'fixture-live' }] },
      })
      expect(quoteCalls).toBe(1)
    } finally {
      await server.close()
    }
  })
})
