import { describe, expect, it, vi } from 'vitest'

import { HithinkProvider } from '@evatick/provider-hithink'

function json(data: unknown, code = 0, message = 'success'): Response {
  return new Response(JSON.stringify({ code, message, request_id: 'req_test', data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('HiThink Fuyao provider contract', () => {
  it('loads and normalizes mainland equities and supported standard indices', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('X-api-key')).toBe('test-key')
      const url = new URL(String(input))
      if (url.searchParams.get('asset_type') === 'a-share') {
        return json({ item: [
          { thscode: '600000.SH', ticker: '600000', name: '浦发银行', exchange: 'SH', asset_type: 'a-share', currency: 'CNY' },
          { thscode: '000001.SZ', ticker: '000001', name: '平安银行', exchange: 'SZ', asset_type: 'a-share', currency: 'CNY' },
          { thscode: '920000.BJ', ticker: '920000', name: '北交样本', exchange: 'BJ', asset_type: 'a-share', currency: 'CNY' },
        ] })
      }
      return json({ item: [
        { thscode: '000001.SH', ticker: '000001', name: '上证指数', exchange: 'SH', asset_type: 'a-share-index', currency: 'CNY' },
        { thscode: '000300.SH', ticker: '1B0300', name: '沪深300', exchange: 'SH', asset_type: 'a-share-index', currency: 'CNY' },
        { thscode: '399001.SZ', ticker: '399001', name: '深证成指', exchange: 'SZ', asset_type: 'a-share-index', currency: 'CNY' },
        { thscode: '399317.SZ', ticker: '399317', name: '国证A指', exchange: 'SZ', asset_type: 'a-share-index', currency: 'CNY' },
      ] })
    })
    const provider = new HithinkProvider({ apiKey: 'test-key', fetch: fetcher })

    await expect(provider.listInstruments()).resolves.toEqual([
      expect.objectContaining({
        type: 'equity', symbol: '600000', venue: 'XSHG',
        providerSymbol: 'equity:600000.SH', capabilities: ['quote', 'bars'],
      }),
      expect.objectContaining({ type: 'equity', symbol: '000001', venue: 'XSHE' }),
      expect.objectContaining({ type: 'equity', symbol: '920000', venue: 'XBSE' }),
      expect.objectContaining({
        type: 'index', symbol: '000001', publisher: 'SSE',
        providerSymbol: 'index:000001.SH',
      }),
      expect.objectContaining({
        type: 'index', symbol: '000300', publisher: 'CSI',
        aliases: ['000300.SH', '1B0300'],
      }),
      expect.objectContaining({ type: 'index', symbol: '399001', publisher: 'SZSE' }),
    ])
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('normalizes equity and index snapshots', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input))
      expect(url.searchParams.get('thscodes')).toBe('600519.SH')
      return json({ timestamp: null, item: [{
        thscode: '600519.SH', last_price: 1400.5, open_price: 1390,
        high_price: 1410, low_price: 1388, prev_price: 1395,
        volume: 12345, turnover: 17_300_000,
      }] })
    })
    const provider = new HithinkProvider({ apiKey: 'test-key', fetch: fetcher })

    await expect(provider.getQuote({
      providerSymbol: 'equity:600519.SH', signal: new AbortController().signal,
    })).resolves.toEqual({
      source: 'fuyao', marketTime: null, currency: 'CNY', marketStatus: 'unknown',
      last: '1400.5', open: '1390', high: '1410', low: '1388',
      previousClose: '1395', volume: 12345, turnover: '17300000',
    })
    expect(String(fetcher.mock.calls[0]?.[0])).toContain('/api/a-share/prices/snapshot')
  })

  it('normalizes daily bars and rejects unsupported intervals before fetching', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input))
      expect(url.searchParams.get('interval')).toBe('1d')
      expect(url.searchParams.get('adjust')).toBe('none')
      return json({ item: [{
        date_ms: Date.parse('2025-08-01T00:00:00+08:00'),
        open_price: 1400, high_price: 1410, low_price: 1390, close_price: 1405,
        volume: 12345, turnover: 17_300_000,
      }] })
    })
    const provider = new HithinkProvider({ apiKey: 'test-key', fetch: fetcher })
    const signal = new AbortController().signal

    await expect(provider.getBars({
      providerSymbol: 'equity:600519.SH', signal, interval: '1d',
      start: '2025-08-01', end: '2025-08-24', adjustment: 'none',
    })).resolves.toEqual([{
      source: 'fuyao', interval: '1d', tradingDate: '2025-08-01',
      periodStart: '2025-08-01T00:00:00+08:00',
      periodEnd: '2025-08-01T23:59:59+08:00', currency: 'CNY',
      open: '1400', high: '1410', low: '1390', close: '1405',
      volume: 12345, turnover: '17300000', adjustment: 'none', complete: true,
    }])
    expect(provider.supportsBars({
      providerSymbol: 'equity:600519.SH', interval: '1m', adjustment: 'none',
    })).toBe(false)
    await expect(provider.getBars({
      providerSymbol: 'equity:600519.SH', signal, interval: '1m', adjustment: 'none',
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_INTERVAL' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('splits requests into API-safe ten-year windows and de-duplicates bars', async () => {
    const fetcher = vi.fn(async () => json({ item: [{
      date_ms: Date.parse('2020-01-02T00:00:00+08:00'),
      open_price: 1, high_price: 2, low_price: 0.5, close_price: 1.5,
      volume: 10, turnover: 15,
    }] }))
    const provider = new HithinkProvider({ apiKey: 'test-key', fetch: fetcher })

    const bars = await provider.getBars({
      providerSymbol: 'equity:600000.SH', signal: new AbortController().signal,
      interval: '1d', start: '1990-01-01', end: '2026-08-24', adjustment: 'none',
    })
    expect(fetcher).toHaveBeenCalledTimes(4)
    expect(bars).toHaveLength(1)
  })

  it('returns current constituents with provider-native equity identifiers', async () => {
    const timestamp = Date.parse('2026-08-24T00:00:00+08:00')
    const provider = new HithinkProvider({
      apiKey: 'test-key',
      fetch: vi.fn(async () => json({ timestamp, item: [
        { thscode: '600000.SH', ticker: '600000', name: '浦发银行' },
        { thscode: '600000.SH', ticker: '600000', name: '浦发银行' },
      ] })),
    })

    expect(provider.supportsConstituents({ providerSymbol: 'index:000300.SH' })).toBe(true)
    expect(provider.supportsConstituents({
      providerSymbol: 'index:000300.SH', asOf: '2000-01-01',
    })).toBe(false)
    await expect(provider.getConstituents({
      providerSymbol: 'index:000300.SH', signal: new AbortController().signal,
    })).resolves.toEqual([{
      constituentProviderSymbol: 'equity:600000.SH', asOfDate: '2026-08-24',
      effectiveFrom: null, effectiveTo: null, weightRatio: null, rank: 1,
    }])
  })

  it('maps authentication and rate-limit envelopes to provider errors', async () => {
    const denied = new HithinkProvider({
      apiKey: 'test-key', fetch: vi.fn(async () => json(null, 2003, 'invalid key')),
    })
    await expect(denied.checkDataSource({
      sourceId: 'fuyao', category: 'equity', signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'HITHINK_2003', retryable: false })

    const limited = new HithinkProvider({
      apiKey: 'test-key', fetch: vi.fn(async () => json(null, 4001, 'limited')),
    })
    await expect(limited.checkDataSource({
      sourceId: 'fuyao', category: 'index', signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'HITHINK_4001', retryable: true })
  })
})
