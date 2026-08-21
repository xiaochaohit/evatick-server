import { describe, expect, it } from 'vitest'

import {
  createEvaTickServer,
  ProviderError,
  type InstrumentProvider,
} from '@evatick/server'

describe('provider routing over HTTP', () => {
  it('retries transient failures, falls back, and normalizes market data', async () => {
    let primaryQuoteAttempts = 0
    const primary: InstrumentProvider = {
      id: 'primary-live',
      async listInstruments() {
        return [
          {
            type: 'equity',
            market: 'CN',
            name: '浦发银行',
            symbol: '600000',
            providerSymbol: 'primary-sh600000',
            venue: 'XSHG',
            currency: 'CNY',
            status: 'active',
            capabilities: ['quote'],
          },
        ]
      },
      async getQuote() {
        primaryQuoteAttempts += 1
        throw new ProviderError(
          'PROVIDER_NETWORK_ERROR',
          'temporary provider failure',
          true,
        )
      },
    }
    const fallback: InstrumentProvider = {
      id: 'fallback-live',
      async listInstruments() {
        return [
          {
            type: 'equity',
            market: 'CN',
            name: '浦发银行',
            symbol: '600000',
            providerSymbol: 'fallback-sh600000',
            venue: 'XSHG',
            currency: 'CNY',
            status: 'active',
            capabilities: ['quote', 'bars'],
          },
          {
            type: 'index',
            market: 'CN',
            name: '上证指数',
            symbol: '000001',
            providerSymbol: 'fallback-sh000001',
            publisher: 'SSE',
            currency: 'CNY',
            status: 'active',
            capabilities: ['bars', 'constituents'],
          },
        ]
      },
      async getQuote() {
        return {
          source: 'sina',
          marketTime: '2026-08-16T10:29:57+08:00',
          currency: 'CNY',
          marketStatus: 'trading',
          last: '10.230',
          open: '10.180',
          high: '10.310',
          low: '10.150',
          previousClose: '10.200',
          volume: 18_345_200,
          turnover: '187654321.50',
        }
      },
      async getBars() {
        return [
          {
            source: 'tencent',
            interval: '1d',
            tradingDate: '2026-08-15',
            periodStart: '2026-08-15T09:30:00+08:00',
            periodEnd: '2026-08-15T15:00:00+08:00',
            currency: 'CNY',
            open: '10.120',
            high: '10.350',
            low: '10.080',
            close: '10.200',
            volume: 52_345_000,
            turnover: '531234567.80',
            adjustment: 'none',
            complete: true,
          },
        ]
      },
      async getConstituents() {
        return [
          {
            constituentProviderSymbol: 'fallback-sh600000',
            asOfDate: '2026-08-16',
            effectiveFrom: '2026-06-15',
            effectiveTo: null,
            weightRatio: '0.052341',
            rank: 1,
          },
        ]
      },
    }

    const server = await createEvaTickServer({ retryAttempts: 2 })
    await server.mountProvider(primary)
    await server.mountProvider(fallback)

    try {
      const quoteResponse = await fetch(
        `${server.url}/v1/instruments/${encodeURIComponent('cn:equity:XSHG:600000')}/quote`,
      )
      expect(quoteResponse.status).toBe(200)
      expect(primaryQuoteAttempts).toBe(2)
      expect(await quoteResponse.json()).toMatchObject({
        schema: 'eva.quote.v1',
        data: {
          instrument_id: 'cn:equity:XSHG:600000',
          last: '10.230',
          volume: 18_345_200,
        },
        meta: { sources: [{ provider: 'fallback-live', upstream: 'sina' }] },
      })

      const barsResponse = await fetch(
        `${server.url}/v1/instruments/${encodeURIComponent('cn:index:SSE:000001')}/bars?interval=1d`,
      )
      expect(barsResponse.status).toBe(200)
      expect(await barsResponse.json()).toMatchObject({
        schema: 'eva.bar-list.v1',
        data: [
          {
            instrument_id: 'cn:index:SSE:000001',
            interval: '1d',
            trading_date: '2026-08-15',
            close: '10.200',
          },
        ],
        meta: { sources: [{ provider: 'fallback-live', upstream: 'tencent' }] },
      })

      const constituentsResponse = await fetch(
        `${server.url}/v1/indices/${encodeURIComponent('cn:index:SSE:000001')}/constituents?as_of=2026-08-16`,
      )
      expect(constituentsResponse.status).toBe(200)
      expect(await constituentsResponse.json()).toMatchObject({
        schema: 'eva.index-constituent-list.v1',
        data: [
          {
            index_id: 'cn:index:SSE:000001',
            constituent_id: 'cn:equity:XSHG:600000',
            constituent_symbol: '600000',
            weight_ratio: '0.052341',
            rank: 1,
          },
        ],
      })
    } finally {
      await server.close()
    }
  })
})
