import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { createEvaTickServer, type InstrumentProvider } from '@evatick/server'

async function waitForRun(url: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const body = await fetch(`${url}/v1/data-sync`).then((response) => response.json()) as {
      data: { active_run: unknown; last_run: { status: string } | null }
    }
    if (!body.data.active_run && body.data.last_run) return body.data
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('data sync run did not finish')
}

describe('equity adjustment factors', () => {
  it('stores raw bars independently and resolves missing factor identifiers through the factor provider', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'eva-independent-factors-'))
    const factorSymbols: string[] = []
    const barsProvider: InstrumentProvider = {
      id: 'hithink-fixture',
      async listInstruments() {
        return ['920071', '920072'].map((symbol) => ({
          type: 'equity' as const, market: 'CN' as const, name: `股票${symbol}`, symbol,
          providerSymbol: `equity:${symbol}.BJ`, venue: 'XBSE', currency: 'CNY',
          status: 'active' as const, capabilities: ['bars' as const],
        }))
      },
      async getBars(call) {
        return [{
          source: 'fuyao', interval: call.interval, tradingDate: '2026-08-24',
          periodStart: '2026-08-24T00:00:00+08:00',
          periodEnd: '2026-08-24T23:59:59+08:00', currency: 'CNY',
          open: '10', high: '11', low: '9', close: '10.5', volume: 100,
          turnover: '1000', adjustment: call.adjustment, complete: true,
        }]
      },
    }
    const factorProvider: InstrumentProvider = {
      id: 'akshare-fixture',
      async listInstruments() { return [] },
      resolveAdjustmentFactorSymbol(instrument) {
        return `bj${instrument.symbol}`
      },
      async getAdjustmentFactors(call) {
        factorSymbols.push(call.providerSymbol)
        if (call.providerSymbol === 'bj920072') throw new Error('SINA_FACTOR_UNAVAILABLE')
        return [{ source: 'sina', effectiveDate: '1990-01-01', cumulativeFactor: '1' }]
      },
    }
    const server = await createEvaTickServer({
      historyPath: join(directory, 'history.duckdb'), healthCheckIntervalMs: 0,
    })
    await server.mountProvider(barsProvider)
    await server.mountProvider(factorProvider)

    try {
      const started = await fetch(`${server.url}/v1/data-sync/runs`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          instrument_types: ['equity'], interval: '1d',
          start: '2026-08-24', end: '2026-08-24', adjustment: 'none',
        }),
      })
      expect(started.status).toBe(202)
      const completed = await waitForRun(server.url)
      expect(completed.last_run).toMatchObject({
        status: 'completed', succeeded: 2, failed: 0, bars_written: 2,
      })
      const status = await fetch(`${server.url}/v1/data-sync`).then((response) => response.json())
      expect(status).toMatchObject({
        data: { storage: { daily_bars: 2, adjustment_factors: 1 } },
      })
      expect(factorSymbols).toEqual(['bj920071', 'bj920072', 'bj920072'])
    } finally {
      await server.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('serializes cache writes while keeping provider requests concurrently bounded', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'eva-concurrent-factors-'))
    const symbols = Array.from({ length: 8 }, (_, index) => `60000${index}`)
    let activeProviderCalls = 0
    let maximumProviderCalls = 0
    let catalogRequests = 0

    const provider: InstrumentProvider = {
      id: 'concurrent-factor-fixture',
      async listInstruments() {
        catalogRequests += 1
        await new Promise((resolve) => setTimeout(resolve, 10))
        return symbols.map((symbol) => ({
          type: 'equity' as const,
          market: 'CN' as const,
          name: `并发测试 ${symbol}`,
          symbol,
          providerSymbol: `sh${symbol}`,
          venue: 'XSHG',
          currency: 'CNY',
          status: 'active' as const,
          capabilities: ['bars' as const],
        }))
      },
      async getBars(call) {
        activeProviderCalls += 1
        maximumProviderCalls = Math.max(maximumProviderCalls, activeProviderCalls)
        await new Promise((resolve) => setTimeout(resolve, 10))
        activeProviderCalls -= 1
        return [{
          source: 'fixture', interval: call.interval, tradingDate: '2026-01-02',
          periodStart: '2026-01-02T00:00:00+08:00',
          periodEnd: '2026-01-02T23:59:59+08:00', currency: 'CNY',
          open: '10', high: '10', low: '10', close: '10', volume: 100,
          turnover: '1000', adjustment: call.adjustment, complete: true,
        }]
      },
      async getAdjustmentFactors(call) {
        activeProviderCalls += 1
        maximumProviderCalls = Math.max(maximumProviderCalls, activeProviderCalls)
        await new Promise((resolve) => setTimeout(resolve, 10))
        activeProviderCalls -= 1
        const suffix = Number(call.providerSymbol.at(-1))
        return [
          { source: 'fixture', effectiveDate: '1990-01-01', cumulativeFactor: '1' },
          {
            source: 'fixture', effectiveDate: '2026-06-01',
            cumulativeFactor: String(2 + suffix / 10),
          },
        ]
      },
    }
    const server = await createEvaTickServer({
      historyPath: join(directory, 'history.duckdb'),
      healthCheckIntervalMs: 0,
      providerConcurrency: 3,
    })
    await server.mountProvider(provider)

    try {
      const responses = await Promise.all(symbols.map((symbol) => fetch(
        `${server.url}/v1/instruments/${encodeURIComponent(`cn:equity:XSHG:${symbol}`)}/bars` +
        '?interval=1d&start=2026-01-01&end=2026-08-21&adjustment=forward&as_of=2026-08-21',
      )))
      expect(responses.map((response) => response.status)).toEqual(symbols.map(() => 200))
      const bodies = await Promise.all(responses.map((response) => response.json())) as {
        data: { close: string }[]
      }[]
      bodies.forEach((body, index) => {
        expect(Number(body.data[0]?.close)).toBeCloseTo(10 / (2 + index / 10), 9)
      })
      expect(maximumProviderCalls).toBe(3)
      expect(catalogRequests).toBe(1)
    } finally {
      await server.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('stores raw bars and derives forward and backward adjusted prices locally', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'eva-adjustment-factors-'))
    const requestedAdjustments: string[] = []
    let factorRequests = 0
    const provider: InstrumentProvider = {
      id: 'factor-fixture',
      async listInstruments() {
        return [{
          type: 'equity', market: 'CN', name: '浦发银行', symbol: '600000',
          providerSymbol: 'sh600000', venue: 'XSHG', currency: 'CNY',
          status: 'active', capabilities: ['bars'],
        }]
      },
      async getBars(call) {
        requestedAdjustments.push(call.adjustment)
        return [
          { date: '2025-01-02', open: '10', high: '11', low: '9', close: '10' },
          { date: '2026-01-02', open: '12', high: '13', low: '11', close: '12' },
        ].map((bar) => ({
          source: 'sina', interval: call.interval, tradingDate: bar.date,
          periodStart: `${bar.date}T00:00:00+08:00`,
          periodEnd: `${bar.date}T23:59:59+08:00`, currency: 'CNY',
          open: bar.open, high: bar.high, low: bar.low, close: bar.close,
          volume: 100, turnover: '1000', adjustment: call.adjustment, complete: true,
        }))
      },
      async getAdjustmentFactors() {
        factorRequests += 1
        return [
          { source: 'sina', effectiveDate: '1990-01-01', cumulativeFactor: '1' },
          { source: 'sina', effectiveDate: '2026-01-01', cumulativeFactor: '1.2' },
        ]
      },
    }
    const server = await createEvaTickServer({
      historyPath: join(directory, 'history.duckdb'), healthCheckIntervalMs: 0,
    })
    await server.mountProvider(provider)

    try {
      const started = await fetch(`${server.url}/v1/data-sync/runs`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          instrument_types: ['equity'], interval: '1d',
          start: '2025-01-01', end: '2026-12-31', adjustment: 'none',
        }),
      })
      expect(started.status).toBe(202)
      await waitForRun(server.url)

      const status = await fetch(`${server.url}/v1/data-sync`).then((response) => response.json())
      expect(status).toMatchObject({
        data: { storage: { daily_bars: 2, adjustment_factors: 2 } },
      })

      const instrumentId = encodeURIComponent('cn:equity:XSHG:600000')
      const forward = await fetch(
        `${server.url}/v1/instruments/${instrumentId}/bars?interval=1d&start=2025-01-01&end=2026-12-31&adjustment=forward`,
      )
      expect(forward.status).toBe(200)
      expect(await forward.json()).toMatchObject({
        data: [
          { trading_date: '2025-01-02', close: '8.3333333333', adjustment: 'forward' },
          { trading_date: '2026-01-02', close: '12', adjustment: 'forward' },
        ],
        meta: { sources: [{ provider: 'local-duckdb', upstream: 'local' }] },
      })

      const backward = await fetch(
        `${server.url}/v1/instruments/${instrumentId}/bars?interval=1d&start=2025-01-01&end=2026-12-31&adjustment=backward`,
      )
      expect(backward.status).toBe(200)
      expect(await backward.json()).toMatchObject({
        data: [
          { trading_date: '2025-01-02', close: '10', adjustment: 'backward' },
          { trading_date: '2026-01-02', close: '14.4', adjustment: 'backward' },
        ],
      })

      const historicalBasis = await fetch(
        `${server.url}/v1/instruments/${instrumentId}/bars?interval=1d&start=2025-01-01&end=2025-12-31&adjustment=forward&as_of=2025-12-31`,
      )
      expect(historicalBasis.status).toBe(200)
      expect(await historicalBasis.json()).toMatchObject({
        data: [{ trading_date: '2025-01-02', close: '10', adjustment: 'forward' }],
      })
      expect(requestedAdjustments).toEqual(['none'])
      expect(factorRequests).toBe(1)
    } finally {
      await server.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects adjusted indices and adjusted synchronization jobs', async () => {
    const provider: InstrumentProvider = {
      id: 'index-fixture',
      async listInstruments() {
        return [{
          type: 'index', market: 'CN', name: '上证指数', symbol: '000001',
          providerSymbol: 'sh000001', publisher: 'SSE', currency: 'CNY',
          status: 'active', capabilities: ['bars'],
        }]
      },
    }
    const server = await createEvaTickServer({ healthCheckIntervalMs: 0 })
    await server.mountProvider(provider)
    try {
      const adjustedIndex = await fetch(
        `${server.url}/v1/instruments/${encodeURIComponent('cn:index:SSE:000001')}/bars?adjustment=forward`,
      )
      expect(adjustedIndex.status).toBe(422)
      expect(await adjustedIndex.json()).toMatchObject({
        code: 'ADJUSTMENT_UNAVAILABLE_FOR_INDEX',
      })

      const adjustedSync = await fetch(`${server.url}/v1/data-sync/runs`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          instrument_types: ['index'], start: '2026-01-01', end: '2026-01-31',
          adjustment: 'backward',
        }),
      })
      expect(adjustedSync.status).toBe(400)
    } finally {
      await server.close()
    }
  })
})
