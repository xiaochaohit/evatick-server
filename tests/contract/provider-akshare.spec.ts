import { describe, expect, it } from 'vitest'

import { AkshareProvider, type AkshareRunner } from '@evatick/provider-akshare'

describe('AKShare provider contract', () => {
  it('declares and independently checks categorized upstream data sources', async () => {
    const runner: AkshareRunner = async (request) => {
      expect(request).toEqual({
        operation: 'health', source: 'sina', instrumentType: 'equity',
      })
      return { source: 'sina', data: [{ records: 12 }] }
    }
    const provider = new AkshareProvider({ runner })

    expect(provider.dataSources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'sina', name: '新浪财经', categories: ['equity', 'index', 'future'],
      }),
      expect.objectContaining({ id: 'tencent', categories: ['equity', 'index'] }),
      expect.objectContaining({ id: 'baostock', categories: ['equity', 'index'] }),
    ]))
    expect(provider.dataSources.map((source) => source.id)).toEqual([
      'sina', 'eastmoney', 'tencent', 'baostock',
    ])
    await expect(provider.checkDataSource!({
      sourceId: 'sina', category: 'equity',
      signal: new AbortController().signal,
    })).resolves.toEqual({ recordsChecked: 12 })
    await expect(provider.checkDataSource!({
      sourceId: 'missing', category: 'equity',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'UNKNOWN_DATA_SOURCE' })
  })

  it('normalizes A-share and index instruments without leaking AKShare fields', async () => {
    const signals: AbortSignal[] = []
    const runner: AkshareRunner = async (request, signal) => {
      signals.push(signal)
      if (request.operation === 'list_stocks') {
        return { source: 'akshare', data: [
          { code: '600000', name: '浦发银行' },
          { code: '000001', name: '平安银行' },
          { code: '430047', name: '诺思兰德' },
          { code: '920000', name: '安徽凤凰' },
        ] }
      }
      if (request.operation === 'list_indices') return { source: 'akshare', data: [
        { index_code: '000001', display_name: '上证指数' },
        { index_code: '000300', display_name: '沪深300' },
        { index_code: '399001', display_name: '深证成指' },
      ] }
      if (request.operation === 'list_futures') return { source: 'exchange', data: [
        { symbol: 'IF2609', variety: '沪深300股指期货', venue: 'CFFEX', main_symbol: 'MAIN:CFFEX:IF' },
        { 合约: 'cu2609', 品种名称: '铜', venue: 'SHFE', main_symbol: 'MAIN:SHFE:CU' },
        { 合约: 'i2609', 品种名称: '铁矿石', venue: 'DCE', main_symbol: 'MAIN:DCE:I' },
        { symbol: 'lc2609', variety: '碳酸锂', venue: 'GFEX', main_symbol: 'MAIN:GFEX:LC' },
      ] }
      return { source: 'sina-foreign-catalog', data: [{
        symbol: 'XAU', provider_symbol: 'FOREIGN:XAU', venue: 'OTC',
        name: '伦敦金 XAU 日线参考序列', currency: 'USD',
        aliases: ['伦敦金', 'XAU/USD'],
      }, {
        symbol: 'BRN', provider_symbol: 'FOREIGN:OIL', venue: 'IFEU',
        name: 'ICE Brent 原油连续日线', currency: 'USD', aliases: ['OIL'],
      }] }
    }
    const provider = new AkshareProvider({ runner })
    const signal = new AbortController().signal

    await expect(provider.listInstruments(signal)).resolves.toEqual([
      expect.objectContaining({ symbol: '600000', venue: 'XSHG', providerSymbol: 'sh600000' }),
      expect.objectContaining({ symbol: '000001', venue: 'XSHE', providerSymbol: 'sz000001' }),
      expect.objectContaining({ symbol: '430047', venue: 'XBSE', providerSymbol: 'bj430047' }),
      expect.objectContaining({ symbol: '920000', venue: 'XBSE', providerSymbol: 'bj920000' }),
      expect.objectContaining({ symbol: '000001', publisher: 'SSE', providerSymbol: 'sh000001' }),
      expect.objectContaining({ symbol: '000300', publisher: 'CSI', providerSymbol: 'csi000300' }),
      expect.objectContaining({ symbol: '399001', publisher: 'SZSE', providerSymbol: 'sz399001' }),
      expect.objectContaining({
        type: 'future', symbol: 'IF2609', venue: 'CFFEX',
        providerSymbol: 'CFFEX:IF2609', name: '沪深300股指期货 IF2609',
        mainContinuousProviderSymbol: 'MAIN:CFFEX:IF',
      }),
      expect.objectContaining({
        type: 'future', symbol: 'cu2609', venue: 'SHFE',
        providerSymbol: 'SHFE:cu2609', name: '铜 cu2609',
      }),
      expect.objectContaining({
        type: 'future', symbol: 'i2609', venue: 'DCE',
        providerSymbol: 'DCE:i2609', name: '铁矿石 i2609',
      }),
      expect.objectContaining({
        type: 'future', symbol: 'lc2609', venue: 'GFEX',
        providerSymbol: 'GFEX:lc2609', name: '碳酸锂 lc2609',
      }),
      expect.objectContaining({
        type: 'future', market: 'GLOBAL', symbol: 'XAU', venue: 'OTC',
        providerSymbol: 'FOREIGN:XAU', currency: 'USD', capabilities: ['bars'],
        aliases: ['伦敦金', 'XAU/USD'],
      }),
      expect.objectContaining({
        type: 'future', market: 'GLOBAL', symbol: 'BRN', venue: 'IFEU',
        providerSymbol: 'FOREIGN:OIL', currency: 'USD', capabilities: ['bars'],
      }),
    ])
    expect(signals).toEqual([signal, signal, signal, signal])
  })

  it('normalizes foreign commodity daily bars as USD reference series', async () => {
    const requests: unknown[] = []
    const provider = new AkshareProvider({ runner: async (request) => {
      requests.push(request)
      return { source: 'sina', data: [{
        date: '2026-08-26', open: 4657.23, high: 4673.66,
        low: 4583.1, close: 4594.49, volume: 0,
      }] }
    } })

    await expect(provider.getBars!({
      providerSymbol: 'FOREIGN:XAU', signal: new AbortController().signal,
      interval: '1d', adjustment: 'none', start: '2026-08-01', end: '2026-08-26',
    })).resolves.toEqual([expect.objectContaining({
      source: 'sina', tradingDate: '2026-08-26', close: '4594.49',
      currency: 'USD', periodStart: '2026-08-26T00:00:00+00:00',
      periodEnd: '2026-08-26T23:59:59+00:00',
    })])
    expect(requests).toEqual([expect.objectContaining({
      operation: 'bars', instrumentType: 'future', providerSymbol: 'FOREIGN:XAU',
      interval: '1d', start: '2026-08-01', end: '2026-08-26',
    })])
  })

  it('routes contract and main continuous futures daily bars through Sina', async () => {
    const requests: unknown[] = []
    const runner: AkshareRunner = async (request) => {
      requests.push(request)
      return { source: 'sina', data: [
        { symbol: 'IF2609', date: '20260820', open: 3900, high: 3920, low: 3880, close: 3910, volume: 1200, turnover: 468000 },
        { symbol: 'IF2609', date: '20260821', open: 3910, high: 3940, low: 3900, close: 3930, volume: 1500, turnover: 589500 },
      ] }
    }
    const provider = new AkshareProvider({ runner })
    provider.setDataSourceOrder('future', ['sina'])
    const signal = new AbortController().signal

    await expect(provider.getBars!({
      providerSymbol: 'CFFEX:IF2609', signal, interval: '1d', adjustment: 'none',
    })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'sina', tradingDate: '2026-08-21', close: '3930', currency: 'CNY',
        periodStart: '2026-08-21T00:00:00+08:00',
        periodEnd: '2026-08-21T23:59:59+08:00',
      }),
    ]))
    expect(requests[0]).toMatchObject({
      operation: 'bars', instrumentType: 'future',
      sourceOrder: ['sina'],
    })

    await provider.getBars!({
      providerSymbol: 'MAIN:CFFEX:IF', signal, interval: '1d', adjustment: 'none',
      start: '2026-08-01', end: '2026-08-21',
    })
    expect(requests[1]).toMatchObject({
      operation: 'bars', instrumentType: 'future', providerSymbol: 'MAIN:CFFEX:IF',
      sourceOrder: ['sina'],
    })

    await expect(provider.getQuote!({
      providerSymbol: 'CFFEX:IF2609', signal,
    })).resolves.toMatchObject({
      source: 'sina', last: '3930', previousClose: '3910', volume: 1500,
      marketTime: '2026-08-21T23:59:59+08:00',
    })
    await expect(provider.getBars!({
      providerSymbol: 'CFFEX:IF2609', signal, interval: '5m', adjustment: 'none',
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_INTERVAL' })
  })

  it('normalizes daily bars and index constituents', async () => {
    const requests: unknown[] = []
    const runner: AkshareRunner = async (request) => {
      requests.push(request)
      if (request.operation === 'bars') {
        return { source: 'sina', data: [{ date: '2026-08-14', open: 10, high: 11, low: 9, close: 10.5, volume: 123, amount: 456 }] }
      }
      return { source: 'akshare', data: [
        { 品种代码: '600000', 品种名称: '浦发银行', 权重: 2.5 },
        { 品种代码: '600000', 品种名称: '浦发银行', 权重: 2.5 },
      ] }
    }
    const provider = new AkshareProvider({ runner })
    provider.setDataSourceOrder('equity', ['eastmoney', 'sina'])
    const signal = new AbortController().signal

    await expect(provider.getBars!({
      providerSymbol: 'sz000001', signal, interval: '1d', adjustment: 'none',
    })).resolves.toEqual([
      expect.objectContaining({
        tradingDate: '2026-08-14', open: '10', close: '10.5', volume: 123,
        turnover: '456', interval: '1d', adjustment: 'none', complete: true,
        source: 'sina',
      }),
    ])
    expect(requests[0]).toMatchObject({
      operation: 'bars', sourceOrder: ['eastmoney', 'sina'],
    })
    await expect(provider.getConstituents!({
      providerSymbol: 'csi000300', signal,
    })).resolves.toEqual([
      expect.objectContaining({
        constituentProviderSymbol: 'sh600000', weightRatio: '0.025', rank: 1,
      }),
    ])
  })

  it('normalizes sparse cumulative equity adjustment factors', async () => {
    const runner: AkshareRunner = async (request) => {
      expect(request).toEqual({
        operation: 'adjustment_factors', providerSymbol: 'sh600000',
      })
      return { source: 'sina', data: [
        { date: '2025-07-16T00:00:00', hfq_factor: '3.847291' },
        { date: '2026-07-15', hfq_factor: 4.1025 },
      ] }
    }
    const provider = new AkshareProvider({ runner })

    expect(provider.resolveAdjustmentFactorSymbol({
      instrumentId: 'cn:equity:XBSE:920071', type: 'equity', market: 'CN',
      name: '金钛股份', symbol: '920071', venue: 'XBSE', currency: 'CNY', status: 'active',
      aliases: ['920071.BJ'], capabilities: ['bars'], identifiers: [{
        provider: 'hithink', value: 'equity:920071.BJ', capabilities: ['bars'],
      }],
    })).toBe('bj920071')

    await expect(provider.getAdjustmentFactors!({
      providerSymbol: 'sh600000', signal: new AbortController().signal,
    })).resolves.toEqual([
      { source: 'sina', effectiveDate: '2025-07-16', cumulativeFactor: '3.847291' },
      { source: 'sina', effectiveDate: '2026-07-15', cumulativeFactor: '4.1025' },
    ])
  })

  it('normalizes intraday bars with Shanghai periods and the selected source', async () => {
    const runner: AkshareRunner = async (request) => {
      expect(request).toMatchObject({
        operation: 'bars', instrumentType: 'equity', providerSymbol: 'sz000001',
        interval: '5m', start: '2026-08-14', end: '2026-08-14',
      })
      return {
        source: 'sina',
        data: [{
          day: '2026-08-14 09:35:00', open: '11.20', high: '11.23',
          low: '11.18', close: '11.22', volume: '12000', amount: '134640',
        }],
      }
    }
    const provider = new AkshareProvider({ runner })

    await expect(provider.getBars!({
      providerSymbol: 'sz000001', signal: new AbortController().signal,
      interval: '5m', adjustment: 'none', start: '2026-08-14', end: '2026-08-14',
    })).resolves.toEqual([{
      source: 'sina', interval: '5m', tradingDate: '2026-08-14',
      periodStart: '2026-08-14T09:30:00+08:00',
      periodEnd: '2026-08-14T09:35:00+08:00', currency: 'CNY',
      open: '11.20', high: '11.23', low: '11.18', close: '11.22',
      volume: 12000, turnover: '134640', adjustment: 'none', complete: true,
    }])
  })

  it('uses the dedicated quote request and preserves its actual source', async () => {
    const runner: AkshareRunner = async (request) => {
      expect(request).toMatchObject({
        operation: 'quote', instrumentType: 'equity', providerSymbol: 'sz000001',
      })
      return {
        source: 'sina',
        data: [
          { date: '2026-08-13', close: 11.25 },
          { date: '2026-08-14', open: 11.22, high: 11.23, low: 11.11, close: 11.11, volume: 123, amount: 456 },
        ],
      }
    }
    const provider = new AkshareProvider({ runner })

    await expect(provider.getQuote!({
      providerSymbol: 'sz000001', signal: new AbortController().signal,
    })).resolves.toMatchObject({
      last: '11.11', previousClose: '11.25', source: 'sina',
    })
  })
})
