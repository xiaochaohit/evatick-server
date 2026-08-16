import { describe, expect, it } from 'vitest'

import { createMarketServer, type InstrumentProvider } from '@market-cli/server'

describe('instrument provider lifecycle over HTTP', () => {
  it('lists provider instruments and removes them after plugin disposal', async () => {
    const provider: InstrumentProvider = {
      id: 'fixture-cn-market',
      async listInstruments() {
        return [
          {
            type: 'equity',
            market: 'CN',
            name: '浦发银行',
            symbol: '600000',
            providerSymbol: 'sh600000',
            venue: 'XSHG',
            currency: 'CNY',
            status: 'active',
            aliases: ['SPDB', '浦发'],
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

    const server = await createMarketServer()
    const providerPlugin = await server.mountProvider(provider)

    try {
      const response = await fetch(`${server.url}/v1/instruments`)

      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        schema: 'market.instrument-list.v1',
        data: [
          {
            instrument_id: 'cn:equity:XSHG:600000',
            instrument_type: 'equity',
            market: 'CN',
            name: '浦发银行',
            symbol: '600000',
            venue: 'XSHG',
            currency: 'CNY',
            status: 'active',
            aliases: ['SPDB', '浦发'],
            capabilities: ['bars', 'quote'],
          },
          {
            instrument_id: 'cn:index:SSE:000001',
            instrument_type: 'index',
            market: 'CN',
            name: '上证指数',
            symbol: '000001',
            publisher: 'SSE',
            currency: 'CNY',
            status: 'active',
            aliases: ['上证综指'],
            capabilities: ['bars', 'constituents', 'quote'],
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

  it('merges the same canonical instrument across providers', async () => {
    const primary: InstrumentProvider = {
      id: 'primary',
      async listInstruments() {
        return [
          {
            type: 'equity',
            market: 'CN',
            name: '浦发银行',
            symbol: '600000',
            providerSymbol: 'sh600000',
            venue: 'XSHG',
            currency: 'CNY',
            status: 'active',
            aliases: ['浦发'],
            capabilities: ['quote'],
          },
        ]
      },
    }
    const secondary: InstrumentProvider = {
      id: 'secondary',
      async listInstruments() {
        return [
          {
            type: 'equity',
            market: 'CN',
            name: '上海浦东发展银行',
            symbol: '600000',
            providerSymbol: '600000.SH',
            venue: 'XSHG',
            currency: 'CNY',
            status: 'active',
            aliases: ['SPDB'],
            capabilities: ['bars'],
          },
        ]
      },
    }

    const server = await createMarketServer()
    await server.mountProvider(primary)
    await server.mountProvider(secondary)

    try {
      const response = await fetch(`${server.url}/v1/instruments`)
      const payload = (await response.json()) as { data: unknown[] }

      expect(payload.data).toEqual([
        {
          instrument_id: 'cn:equity:XSHG:600000',
          instrument_type: 'equity',
          market: 'CN',
          name: '浦发银行',
          symbol: '600000',
          venue: 'XSHG',
          publisher: null,
          currency: 'CNY',
          status: 'active',
          aliases: ['SPDB', '上海浦东发展银行', '浦发'],
          capabilities: ['bars', 'quote'],
        },
      ])
    } finally {
      await server.close()
    }
  })
})
