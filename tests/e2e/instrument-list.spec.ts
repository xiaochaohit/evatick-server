import { describe, expect, it } from 'vitest'

import {
  createEvaTickServer,
  ProviderError,
  type InstrumentProvider,
} from '@evatick/server'

describe('instrument provider lifecycle over HTTP', () => {
  it('disposes mounted provider resources when the server closes', async () => {
    let closes = 0
    const provider: InstrumentProvider = {
      id: 'disposable-provider',
      async listInstruments() {
        return []
      },
      async close() {
        closes += 1
      },
    }
    const server = await createEvaTickServer()
    await server.mountProvider(provider)

    await server.close()

    expect(closes).toBe(1)
  })

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

    const server = await createEvaTickServer()
    const providerPlugin = await server.mountProvider(provider)

    try {
      const response = await fetch(`${server.url}/v1/instruments`)

      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        schema: 'eva.instrument-list.v1',
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
        schema: 'eva.instrument-list.v1',
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

    const server = await createEvaTickServer()
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

  it('keeps a partial catalog when one provider is temporarily unavailable', async () => {
    let failures = 0
    const unavailable: InstrumentProvider = {
      id: 'unavailable-catalog',
      async listInstruments() {
        failures += 1
        throw new ProviderError('PROVIDER_NETWORK_ERROR', 'temporary failure', true)
      },
    }
    const available: InstrumentProvider = {
      id: 'available-catalog',
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
            capabilities: ['quote'],
          },
        ]
      },
    }
    const server = await createEvaTickServer({ retryAttempts: 2 })
    await server.mountProvider(unavailable)
    await server.mountProvider(available)

    try {
      const response = await fetch(`${server.url}/v1/instruments`)
      expect(response.status).toBe(200)
      expect(failures).toBe(2)
      expect(await response.json()).toMatchObject({
        data: [{ instrument_id: 'cn:equity:XSHG:600000' }],
        meta: {
          partial: true,
          sources: [{ provider: 'available-catalog' }],
          warnings: ['provider unavailable-catalog failed: PROVIDER_NETWORK_ERROR'],
        },
      })
    } finally {
      await server.close()
    }
  })
})
