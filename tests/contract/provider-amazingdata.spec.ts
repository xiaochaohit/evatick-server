import { describe, expect, it } from 'vitest'

import {
  AmazingDataProvider,
  type AmazingDataRunner,
} from '@evatick/provider-amazingdata'

describe('AmazingData provider contract', () => {
  it('declares and checks its paid upstream source by category', async () => {
    const runner: AmazingDataRunner = async (request) => {
      expect(request).toEqual({ operation: 'health', category: 'equity' })
      return { source: 'amazingdata', data: { records: 123 } }
    }
    const provider = new AmazingDataProvider({ runner })

    expect(provider.dataSources[0]).toMatchObject({
      id: 'amazingdata', categories: ['equity', 'index'],
    })
    await expect(provider.checkDataSource!({
      sourceId: 'amazingdata', category: 'equity',
      signal: new AbortController().signal,
    })).resolves.toEqual({ recordsChecked: 123 })
    await expect(provider.checkDataSource!({
      sourceId: 'amazingdata', category: 'crypto',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_DATA_SOURCE_CATEGORY' })
  })

  it('normalizes A-share and index instruments into the existing canonical identities', async () => {
    const runner: AmazingDataRunner = async (request) => {
      expect(request).toEqual({ operation: 'list_instruments' })
      return { source: 'amazingdata', data: [
        { type: 'equity', code: '600000.SH', name: '浦发银行', status: 1 },
        { type: 'equity', code: '000001.SZ', name: '平安银行', status: 1 },
        { type: 'equity', code: '920000.BJ', name: '北交样本', status: 1 },
        { type: 'index', code: '000300.SH', name: '沪深300', status: 1 },
        { type: 'index', code: '399001.SZ', name: '深证成指', status: 1 },
      ] }
    }
    const provider = new AmazingDataProvider({ runner })

    await expect(provider.listInstruments()).resolves.toEqual([
      expect.objectContaining({
        type: 'equity', symbol: '600000', venue: 'XSHG',
        providerSymbol: '600000.SH', capabilities: ['quote', 'bars'],
      }),
      expect.objectContaining({ type: 'equity', symbol: '000001', venue: 'XSHE' }),
      expect.objectContaining({ type: 'equity', symbol: '920000', venue: 'XBSE' }),
      expect.objectContaining({
        type: 'index', symbol: '000300', publisher: 'CSI',
        providerSymbol: '000300.SH',
      }),
      expect.objectContaining({ type: 'index', symbol: '399001', publisher: 'SZSE' }),
    ])
  })

  it('preserves AmazingData forward minute timestamps and raw bar provenance', async () => {
    const runner: AmazingDataRunner = async (request) => {
      expect(request).toEqual({
        operation: 'bars', providerSymbol: '600000.SH', interval: '1m',
        start: '2026-08-25', end: '2026-08-25',
      })
      return { source: 'amazingdata', data: [{
        code: '600000.SH', kline_time: '2026-08-25T09:30:00+08:00',
        open: 10.1, high: 10.3, low: 10, close: 10.2,
        volume: 1200, amount: 12240,
      }] }
    }
    const provider = new AmazingDataProvider({ runner })

    expect(provider.supportsBars!({
      providerSymbol: '600000.SH', interval: '1m', adjustment: 'none',
    })).toBe(true)
    expect(provider.supportsBars!({
      providerSymbol: '600000.SH', interval: '1m', adjustment: 'none',
      start: '2026-01-01', end: '2026-05-01',
    })).toBe(false)
    await expect(provider.getBars!({
      providerSymbol: '600000.SH', interval: '1m', adjustment: 'none',
      start: '2026-08-25', end: '2026-08-25',
      signal: new AbortController().signal,
    })).resolves.toEqual([{
      source: 'amazingdata', interval: '1m', tradingDate: '2026-08-25',
      periodStart: '2026-08-25T09:30:00+08:00',
      periodEnd: '2026-08-25T09:30:59.999+08:00',
      currency: 'CNY', open: '10.1', high: '10.3', low: '10', close: '10.2',
      volume: 1200, turnover: '12240', adjustment: 'none', complete: true,
    }])
  })

  it('normalizes the latest historical snapshot as a quote', async () => {
    const runner: AmazingDataRunner = async (request) => {
      expect(request).toEqual({ operation: 'quote', providerSymbol: '600000.SH' })
      return { source: 'amazingdata', data: [
        { trade_time: '2026-08-25T14:59:00+08:00', last: 10.18 },
        {
          trade_time: '2026-08-25T15:00:00+08:00', last: 10.2, open: 10.1,
          high: 10.3, low: 10, pre_close: 10, volume: 1200, amount: 12240,
        },
      ] }
    }
    const provider = new AmazingDataProvider({ runner })

    await expect(provider.getQuote!({
      providerSymbol: '600000.SH', signal: new AbortController().signal,
    })).resolves.toEqual({
      source: 'amazingdata', marketTime: '2026-08-25T15:00:00+08:00',
      currency: 'CNY', marketStatus: 'unknown', last: '10.2', open: '10.1',
      high: '10.3', low: '10', previousClose: '10', volume: 1200,
      turnover: '12240',
    })
  })

  it('maps AmazingData backward factors onto the shared equity identity', async () => {
    const runner: AmazingDataRunner = async (request) => {
      expect(request).toEqual({
        operation: 'adjustment_factors', providerSymbol: '600000.SH',
      })
      return { source: 'amazingdata', data: [
        { date: '2025-07-16', factor: 3.847291 },
        { date: '2026-07-15T00:00:00', factor: 4.1025 },
      ] }
    }
    const provider = new AmazingDataProvider({ runner })
    const instrument = {
      instrumentId: 'cn:equity:XSHG:600000', type: 'equity' as const,
      market: 'CN' as const, name: '浦发银行', symbol: '600000', venue: 'XSHG',
      currency: 'CNY', status: 'active' as const, aliases: ['600000.SH'],
      capabilities: ['bars'] as const, identifiers: [{
        provider: 'hithink', value: 'equity:600000.SH', capabilities: ['bars'] as const,
      }],
    }

    expect(provider.resolveAdjustmentFactorSymbol!(instrument)).toBe('600000.SH')
    await expect(provider.getAdjustmentFactors!({
      providerSymbol: '600000.SH', signal: new AbortController().signal,
    })).resolves.toEqual([
      { source: 'amazingdata', effectiveDate: '2025-07-16', cumulativeFactor: '3.847291' },
      { source: 'amazingdata', effectiveDate: '2026-07-15', cumulativeFactor: '4.1025' },
    ])
  })

  it('returns historical index membership without treating a missing weight as zero', async () => {
    const runner: AmazingDataRunner = async (request) => {
      expect(request).toEqual({
        operation: 'constituents', providerSymbol: '000300.SH', asOf: '2026-08-25',
      })
      return { source: 'amazingdata', data: [
        { INDEX_CODE: '000300.SH', CON_CODE: '600000.SH', INDATE: '2020-01-01', OUTDATE: null },
        { INDEX_CODE: '000300.SH', CON_CODE: '000001.SZ', INDATE: '2020-01-01', OUTDATE: '2026-01-01' },
      ] }
    }
    const provider = new AmazingDataProvider({ runner })

    expect(provider.supportsConstituents!({
      providerSymbol: '000300.SH', asOf: '2026-08-25',
    })).toBe(true)
    await expect(provider.getConstituents!({
      providerSymbol: '000300.SH', asOf: '2026-08-25',
      signal: new AbortController().signal,
    })).resolves.toEqual([{
      constituentProviderSymbol: '600000.SH', asOfDate: '2026-08-25',
      effectiveFrom: '2020-01-01', effectiveTo: null, weightRatio: null, rank: 1,
    }])
  })

  it('marks empty provider-local datasets retryable so routing can fall back', async () => {
    const provider = new AmazingDataProvider({
      runner: async () => ({ source: 'amazingdata', data: [] }),
    })
    const signal = new AbortController().signal

    await expect(provider.getBars!({
      providerSymbol: '600000.SH', interval: '1d', adjustment: 'none', signal,
    })).rejects.toMatchObject({ code: 'NO_DATA', retryable: true })
    await expect(provider.getAdjustmentFactors!({
      providerSymbol: '600000.SH', signal,
    })).rejects.toMatchObject({ code: 'NO_DATA', retryable: true })
    await expect(provider.getConstituents!({
      providerSymbol: '000300.SH', signal,
    })).rejects.toMatchObject({ code: 'NO_DATA', retryable: true })
  })
})
