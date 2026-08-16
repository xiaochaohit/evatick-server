import { describe, expect, it } from 'vitest'

import { createMarketServer, type InstrumentProvider } from '@market-cli/server'

describe('instrument provider lifecycle over HTTP', () => {
  it('lists provider instruments and removes them after plugin disposal', async () => {
    const provider: InstrumentProvider = {
      id: 'fixture-cn-market',
      async listInstruments() {
        return [
          {
            instrumentId: 'ins_equity_600000',
            type: 'equity',
            name: '浦发银行',
            symbol: '600000',
            venue: 'XSHG',
            currency: 'CNY',
            status: 'active',
          },
          {
            instrumentId: 'ins_index_000001',
            type: 'index',
            name: '上证指数',
            symbol: '000001',
            publisher: 'SSE',
            currency: 'CNY',
            status: 'active',
          },
        ]
      },
    }

    const server = await createMarketServer()
    const providerPlugin = await server.mountProvider(provider)

    try {
      const response = await fetch(`${server.url}/v1/instruments`)

      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        schema: 'market.instrument-list.v1',
        data: [
          {
            instrument_id: 'ins_equity_600000',
            instrument_type: 'equity',
            name: '浦发银行',
            symbol: '600000',
            venue: 'XSHG',
            currency: 'CNY',
            status: 'active',
          },
          {
            instrument_id: 'ins_index_000001',
            instrument_type: 'index',
            name: '上证指数',
            symbol: '000001',
            publisher: 'SSE',
            currency: 'CNY',
            status: 'active',
          },
        ],
        page: { next_cursor: null },
        meta: {
          partial: false,
          sources: [{ provider: 'fixture-cn-market' }],
          warnings: [],
        },
      })

      await providerPlugin.dispose()

      const afterDisposal = await fetch(`${server.url}/v1/instruments`)
      expect(afterDisposal.status).toBe(200)
      expect(await afterDisposal.json()).toMatchObject({
        schema: 'market.instrument-list.v1',
        data: [],
        page: { next_cursor: null },
        meta: { partial: false, sources: [], warnings: [] },
      })
    } finally {
      await server.close()
    }
  })
})
