import { describe, expect, it } from 'vitest'

import { MarketCliProvider, type MarketCliRunner } from '@market-cli/provider-market-cli'

describe('market-cli provider contract', () => {
  it('normalizes A-share and index instruments without leaking AKShare fields', async () => {
    const signals: AbortSignal[] = []
    const runner: MarketCliRunner = async (args, signal) => {
      signals.push(signal)
      if (args[0] === 'stock') {
        return [
          { code: '600000', name: '浦发银行' },
          { code: '000001', name: '平安银行' },
          { code: '430047', name: '诺思兰德' },
        ]
      }
      return [
        { index_code: '000001', display_name: '上证指数' },
        { index_code: '000300', display_name: '沪深300' },
        { index_code: '399001', display_name: '深证成指' },
      ]
    }
    const provider = new MarketCliProvider({ runner })
    const signal = new AbortController().signal

    await expect(provider.listInstruments(signal)).resolves.toEqual([
      expect.objectContaining({ symbol: '600000', venue: 'XSHG', providerSymbol: 'sh600000' }),
      expect.objectContaining({ symbol: '000001', venue: 'XSHE', providerSymbol: 'sz000001' }),
      expect.objectContaining({ symbol: '430047', venue: 'XBSE', providerSymbol: 'bj430047' }),
      expect.objectContaining({ symbol: '000001', publisher: 'SSE', providerSymbol: 'sh000001' }),
      expect.objectContaining({ symbol: '000300', publisher: 'CSI', providerSymbol: 'csi000300' }),
      expect.objectContaining({ symbol: '399001', publisher: 'SZSE', providerSymbol: 'sz399001' }),
    ])
    expect(signals).toEqual([signal, signal])
  })

  it('normalizes daily bars and index constituents', async () => {
    const runner: MarketCliRunner = async (args) => {
      if (args[1] === 'bars') {
        return [{ date: '2026-08-14', open: 10, high: 11, low: 9, close: 10.5, volume: 123, amount: 456 }]
      }
      return [{ 品种代码: '600000', 品种名称: '浦发银行', 权重: 2.5 }]
    }
    const provider = new MarketCliProvider({ runner })
    const signal = new AbortController().signal

    await expect(provider.getBars!({
      providerSymbol: 'sz000001', signal, interval: '1d', adjustment: 'none',
    })).resolves.toEqual([
      expect.objectContaining({
        tradingDate: '2026-08-14', open: '10', close: '10.5', volume: 123,
        turnover: '456', interval: '1d', adjustment: 'none', complete: true,
      }),
    ])
    await expect(provider.getConstituents!({
      providerSymbol: 'csi000300', signal,
    })).resolves.toEqual([
      expect.objectContaining({
        constituentProviderSymbol: 'sh600000', weightRatio: '0.025', rank: 1,
      }),
    ])
  })
})
