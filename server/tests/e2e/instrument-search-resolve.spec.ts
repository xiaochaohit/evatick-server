import { describe, expect, it } from 'vitest'

import { createMarketServer, type InstrumentProvider } from '@market-cli/server'

const provider: InstrumentProvider = {
  id: 'fixture-search',
  async listInstruments() {
    return [
      {
        type: 'equity',
        market: 'CN',
        name: '平安银行',
        symbol: '000001',
        providerSymbol: 'sz000001',
        venue: 'XSHE',
        currency: 'CNY',
        status: 'active',
        aliases: ['平安'],
        capabilities: ['quote', 'bars'],
      },
      {
        type: 'equity',
        market: 'CN',
        name: '浦发银行',
        symbol: '600000',
        providerSymbol: 'sh600000',
        venue: 'XSHG',
        currency: 'CNY',
        status: 'active',
        aliases: ['浦发', 'SPDB'],
        capabilities: ['quote', 'bars'],
      },
      {
        type: 'index',
        market: 'CN',
        name: '上证指数',
        symbol: '000001',
        providerSymbol: 'sh000001',
        publisher: 'SSE',
        currency: 'CNY',
        status: 'active',
        aliases: ['上证综指'],
        capabilities: ['quote', 'bars', 'constituents'],
      },
    ]
  },
}

describe('instrument discovery over HTTP', () => {
  it('searches aliases, reports ambiguity, and resolves with context', async () => {
    const server = await createMarketServer()
    await server.mountProvider(provider)

    try {
      const searchResponse = await fetch(
        `${server.url}/v1/instrument-search?q=${encodeURIComponent('浦发')}`,
      )
      expect(searchResponse.status).toBe(200)
      expect(await searchResponse.json()).toMatchObject({
        schema: 'market.instrument-search.v1',
        data: [
          {
            instrument_id: 'cn:equity:XSHG:600000',
            name: '浦发银行',
            match_type: 'exact_alias',
          },
        ],
      })

      const fuzzyResponse = await fetch(
        `${server.url}/v1/instrument-search?q=${encodeURIComponent('浦发银航')}`,
      )
      expect(fuzzyResponse.status).toBe(200)
      expect(await fuzzyResponse.json()).toMatchObject({
        data: [
          {
            instrument_id: 'cn:equity:XSHG:600000',
            match_type: 'fuzzy',
          },
        ],
      })

      const ambiguousResponse = await fetch(`${server.url}/v1/instrument-resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: '000001' }),
      })
      expect(ambiguousResponse.status).toBe(200)
      expect(await ambiguousResponse.json()).toMatchObject({
        schema: 'market.instrument-resolution.v1',
        data: {
          status: 'ambiguous',
          candidates: [
            { instrument_id: 'cn:equity:XSHE:000001' },
            { instrument_id: 'cn:index:SSE:000001' },
          ],
        },
      })

      const resolvedResponse = await fetch(`${server.url}/v1/instrument-resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query: '000001',
          context: { instrument_type: 'index', capability: 'bars' },
        }),
      })
      expect(resolvedResponse.status).toBe(200)
      expect(await resolvedResponse.json()).toMatchObject({
        schema: 'market.instrument-resolution.v1',
        data: {
          status: 'resolved',
          instrument: {
            instrument_id: 'cn:index:SSE:000001',
            name: '上证指数',
          },
        },
      })

      const detailResponse = await fetch(
        `${server.url}/v1/instruments/${encodeURIComponent('cn:index:SSE:000001')}`,
      )
      expect(detailResponse.status).toBe(200)
      expect(await detailResponse.json()).toMatchObject({
        schema: 'market.instrument.v1',
        data: {
          instrument_id: 'cn:index:SSE:000001',
          identifiers: [{ provider: 'fixture-search', value: 'sh000001' }],
        },
      })
    } finally {
      await server.close()
    }
  })

  it('filters and cursor-paginates the supported catalog', async () => {
    const server = await createMarketServer()
    await server.mountProvider(provider)

    try {
      const firstResponse = await fetch(
        `${server.url}/v1/instruments?instrument_type=equity&limit=1`,
      )
      const first = (await firstResponse.json()) as {
        data: { instrument_id: string }[]
        page: { next_cursor: string | null }
      }
      expect(firstResponse.status).toBe(200)
      expect(first.data).toHaveLength(1)
      expect(first.data[0]?.instrument_id).toBe('cn:equity:XSHE:000001')
      expect(first.page.next_cursor).toEqual(expect.any(String))

      const secondResponse = await fetch(
        `${server.url}/v1/instruments?instrument_type=equity&limit=1&cursor=${encodeURIComponent(first.page.next_cursor!)}`,
      )
      const second = (await secondResponse.json()) as {
        data: { instrument_id: string }[]
        page: { next_cursor: string | null }
      }
      expect(secondResponse.status).toBe(200)
      expect(second.data.map((item) => item.instrument_id)).toEqual([
        'cn:equity:XSHG:600000',
      ])
      expect(second.page.next_cursor).toBeNull()
    } finally {
      await server.close()
    }
  })
})
