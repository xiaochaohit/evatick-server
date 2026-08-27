import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  createEvaTickServer,
  type InstrumentProvider,
} from '@evatick/server'

async function waitForRun(url: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(`${url}/v1/data-sync`)
    const body = await response.json() as {
      data: {
        active_run: unknown
        last_run: {
          status: string
          interval: string
          succeeded: number
          bars_written: number
        } | null
        storage: { instruments: number; daily_bars: number; minute_bars: number }
      }
    }
    if (!body.data.active_run && body.data.last_run) return body.data
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('data sync run did not finish')
}

describe('local historical data synchronization', () => {
  it('records an empty catalog synchronization as failed', async () => {
    const server = await createEvaTickServer({ healthCheckIntervalMs: 0 })
    try {
      const response = await fetch(`${server.url}/v1/data-sync/runs`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          instrument_types: ['equity'], interval: '1d',
          start: '2026-08-01', end: '2026-08-23', adjustment: 'none',
        }),
      })
      expect(response.status).toBe(202)
      expect(await response.json()).toMatchObject({
        data: {
          status: 'failed', total: 0, finished_at: expect.any(String),
          errors: [{ message: 'DATA_SYNC_NO_INSTRUMENTS' }],
        },
      })
      const status = await fetch(`${server.url}/v1/data-sync`).then((result) => result.json())
      expect(status).toMatchObject({
        data: { active_run: null, last_run: { status: 'failed', total: 0 } },
      })
    } finally {
      await server.close()
    }
  })

  it('lists the searchable sync catalog and synchronizes only selected instruments', async () => {
    const requestedSymbols: string[] = []
    const catalogRefreshes: boolean[] = []
    const provider: InstrumentProvider = {
      id: 'selected-sync-fixture',
      async listInstruments(_signal, options) {
        catalogRefreshes.push(options?.refresh ?? false)
        return ['600000', '600001', '600002'].map((symbol) => ({
          type: 'equity' as const, market: 'CN' as const, name: `股票${symbol}`, symbol,
          providerSymbol: `sh${symbol}`, venue: 'XSHG', currency: 'CNY',
          status: 'active' as const, capabilities: ['bars' as const],
        }))
      },
      async getBars(call) {
        requestedSymbols.push(call.providerSymbol)
        return [{
          source: 'fixture', interval: call.interval, tradingDate: '2026-08-21',
          periodStart: '2026-08-21T00:00:00+08:00', periodEnd: '2026-08-21T23:59:59+08:00',
          currency: 'CNY', open: '10', high: '11', low: '9', close: '10.5',
          volume: 100, turnover: '1000', adjustment: call.adjustment, complete: true,
        }]
      },
    }
    const server = await createEvaTickServer({ healthCheckIntervalMs: 0 })
    await server.mountProvider(provider)
    try {
      const catalog = await fetch(
        `${server.url}/v1/data-sync/instruments?type=equity&q=600001&limit=50&offset=0`,
      )
      expect(catalog.status).toBe(200)
      expect(await catalog.json()).toMatchObject({
        schema: 'eva.data-sync-instrument-list.v1',
        data: [{
          instrument_id: 'cn:equity:XSHG:600001', symbol: '600001',
          daily_records: 0, minute_records: 0,
        }],
        page: { total: 1, limit: 50, offset: 0 },
        meta: { catalog_refreshed_at: expect.any(String) },
      })
      expect(catalogRefreshes).toEqual([false])

      const refreshed = await fetch(`${server.url}/v1/data-sync/instruments/refresh`, {
        method: 'POST',
      })
      expect(refreshed.status).toBe(200)
      expect(await refreshed.json()).toMatchObject({
        schema: 'eva.data-sync-catalog-refresh.v1',
        data: { instruments: 3, refreshed_at: expect.any(String), partial: false },
      })
      expect(catalogRefreshes).toEqual([false, true])

      await fetch(`${server.url}/v1/data-sync/instruments?type=equity&limit=50&offset=0`)
      expect(catalogRefreshes).toEqual([false, true])

      const selectedId = 'cn:equity:XSHG:600001'
      const start = await fetch(`${server.url}/v1/data-sync/runs`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          instrument_types: ['equity'], instrument_ids: [selectedId], interval: '1d',
          start: '2026-08-21', end: '2026-08-21', adjustment: 'none',
        }),
      })
      expect(start.status).toBe(202)
      expect(await start.json()).toMatchObject({
        data: { instrument_ids: [selectedId], total: 1 },
      })
      await waitForRun(server.url)
      expect(requestedSymbols).toEqual(['sh600001'])

      const schedule = await fetch(`${server.url}/v1/data-sync/schedules`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          interval: '1d', time: '18:00', skip_weekends: true,
          instrument_types: ['equity'], instrument_ids: [selectedId],
          lookback_days: 10, adjustment: 'none', delay_ms: 750,
        }),
      })
      expect(schedule.status).toBe(201)
      expect(await schedule.json()).toMatchObject({
        data: { instrument_types: ['equity'], instrument_ids: [selectedId] },
      })
    } finally {
      await server.close()
    }
  })

  it('lists futures products and syncs each Sina main continuous range once', async () => {
    const requestedSeries: string[] = []
    const provider: InstrumentProvider = {
      id: 'futures-snapshot-fixture',
      async listInstruments() {
        return ['i2609', 'i2610', 'm2609'].map((symbol) => ({
          type: 'future' as const, market: 'CN' as const,
          name: `${symbol.startsWith('i') ? '铁矿石' : '豆粕'} ${symbol}`, symbol,
          providerSymbol: `DCE:${symbol}`, venue: 'DCE', currency: 'CNY',
          status: 'active' as const, capabilities: ['bars' as const],
          mainContinuousProviderSymbol: `MAIN:DCE:${symbol.startsWith('i') ? 'I' : 'M'}`,
        }))
      },
      async getBars(call) {
        requestedSeries.push(call.providerSymbol)
        const rows = call.providerSymbol === 'MAIN:DCE:I'
          ? [['2026-08-20', '801'], ['2026-08-21', '790']]
          : [['2026-08-20', '3020'], ['2026-08-21', '3030']]
        return rows.map(([tradingDate, close]) => ({
          source: 'sina', interval: '1d' as const, tradingDate: tradingDate!,
          periodStart: `${tradingDate}T00:00:00+08:00`,
          periodEnd: `${tradingDate}T23:59:59+08:00`, currency: 'CNY',
          open: close!, high: close!, low: close!, close: close!, volume: 100,
          turnover: null, adjustment: 'none' as const, complete: true,
        }))
      },
    }
    const server = await createEvaTickServer({ healthCheckIntervalMs: 0 })
    await server.mountProvider(provider)
    try {
      const catalog = await fetch(
        `${server.url}/v1/data-sync/instruments?type=future&market=CN&limit=50&offset=0`,
      )
      expect(await catalog.json()).toMatchObject({
        data: [
          {
            instrument_id: 'cn:future-series:DCE:I:main', symbol: 'I', venue: 'DCE',
            name: '铁矿石 I 主力连续（未复权）',
          },
          {
            instrument_id: 'cn:future-series:DCE:M:main', symbol: 'M', venue: 'DCE',
          },
        ],
        page: { total: 2 },
      })

      const seriesId = 'cn:future-series:DCE:I:main'
      const started = await fetch(`${server.url}/v1/data-sync/runs`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          instrument_types: ['future'], interval: '1d',
          start: '2026-08-20', end: '2026-08-21', adjustment: 'none',
        }),
      })
      expect(started.status).toBe(202)
      await waitForRun(server.url)
      expect(requestedSeries).toEqual(['MAIN:DCE:I', 'MAIN:DCE:M'])

      const bars = await fetch(
        `${server.url}/v1/local-data/instruments/${encodeURIComponent(seriesId)}/bars?start=2026-08-20&end=2026-08-21&limit=20`,
      )
      expect(await bars.json()).toMatchObject({
        data: [
          { trading_date: '2026-08-21', close: '790' },
          { trading_date: '2026-08-20', close: '801' },
        ],
      })
      const members = await fetch(
        `${server.url}/v1/local-data/futures-series/${encodeURIComponent(seriesId)}/members`,
      )
      expect(await members.json()).toMatchObject({ data: [] })
    } finally {
      await server.close()
    }
  })

  it('lists and directly synchronizes global commodity reference series', async () => {
    const requestedSymbols: string[] = []
    const provider: InstrumentProvider = {
      id: 'foreign-commodity-fixture',
      async listInstruments() {
        return [{
          type: 'future', market: 'GLOBAL', name: '伦敦金 XAU 日线参考序列',
          symbol: 'XAU', providerSymbol: 'FOREIGN:XAU', venue: 'OTC', currency: 'USD',
          status: 'active', aliases: ['XAU/USD'], capabilities: ['bars'],
        }]
      },
      async getBars(call) {
        requestedSymbols.push(call.providerSymbol)
        return [{
          source: 'sina', interval: '1d', tradingDate: '2026-08-26',
          periodStart: '2026-08-26T00:00:00+00:00',
          periodEnd: '2026-08-26T23:59:59+00:00', currency: 'USD',
          open: '4657.23', high: '4673.66', low: '4583.1', close: '4594.49',
          volume: 0, turnover: null, adjustment: 'none', complete: true,
        }]
      },
    }
    const server = await createEvaTickServer({ healthCheckIntervalMs: 0 })
    await server.mountProvider(provider)
    try {
      const instrumentId = 'global:future:OTC:XAU'
      const catalog = await fetch(
        `${server.url}/v1/data-sync/instruments?type=future&market=GLOBAL&q=XAU&limit=50&offset=0`,
      )
      expect(await catalog.json()).toMatchObject({
        data: [{
          instrument_id: instrumentId, symbol: 'XAU', venue: 'OTC',
          name: '伦敦金 XAU 日线参考序列',
        }],
        page: { total: 1 },
      })
      const domesticCatalog = await fetch(
        `${server.url}/v1/data-sync/instruments?type=future&market=CN&q=XAU&limit=50&offset=0`,
      )
      expect(await domesticCatalog.json()).toMatchObject({ data: [], page: { total: 0 } })

      const started = await fetch(`${server.url}/v1/data-sync/runs`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          instrument_types: ['future'], instrument_ids: [instrumentId], interval: '1d',
          start: '2026-08-26', end: '2026-08-26', adjustment: 'none',
        }),
      })
      expect(started.status).toBe(202)
      await waitForRun(server.url)
      expect(requestedSymbols).toEqual(['FOREIGN:XAU'])

      const bars = await fetch(
        `${server.url}/v1/local-data/instruments/${encodeURIComponent(instrumentId)}/bars?limit=20`,
      )
      expect(await bars.json()).toMatchObject({
        data: [{ trading_date: '2026-08-26', close: '4594.49' }],
      })
      const globalLocal = await fetch(
        `${server.url}/v1/local-data/instruments?type=future&market=GLOBAL&limit=20&offset=0`,
      )
      expect(await globalLocal.json()).toMatchObject({
        data: [{ instrument_id: instrumentId, market: 'GLOBAL' }], page: { total: 1 },
      })
      const domesticLocal = await fetch(
        `${server.url}/v1/local-data/instruments?type=future&market=CN&limit=20&offset=0`,
      )
      expect(await domesticLocal.json()).toMatchObject({ data: [], page: { total: 0 } })
    } finally {
      await server.close()
    }
  })

  it('stores one-minute bars separately and serves covered requests from DuckDB', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'eva-minute-sync-'))
    const requestedIntervals: string[] = []
    const provider: InstrumentProvider = {
      id: 'minute-sync-fixture',
      async listInstruments() {
        return [{
          type: 'equity', market: 'CN', name: '浦发银行', symbol: '600000',
          providerSymbol: 'sh600000', venue: 'XSHG', currency: 'CNY',
          status: 'active', capabilities: ['bars'],
        }]
      },
      async getBars(call) {
        requestedIntervals.push(call.interval)
        return ['2026-05-22', '2026-08-21'].map((date, index) => ({
          source: 'sina',
          interval: call.interval,
          tradingDate: date,
          periodStart: `${date}T09:30:00+08:00`,
          periodEnd: `${date}T09:31:00+08:00`,
          currency: 'CNY',
          open: String(10 + index / 10), high: String(10.2 + index / 10),
          low: String(9.9 + index / 10), close: String(10.1 + index / 10),
          volume: 100 + index, turnover: String(1_000 + index),
          adjustment: call.adjustment, complete: true,
        }))
      },
    }
    const server = await createEvaTickServer({
      historyPath: join(directory, 'history.duckdb'),
      healthCheckIntervalMs: 0,
    })
    await server.mountProvider(provider)

    try {
      const response = await fetch(`${server.url}/v1/data-sync/runs`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          instrument_types: ['equity'], interval: '1m',
          start: '2026-05-22', end: '2026-08-22', adjustment: 'none',
        }),
      })
      expect(response.status).toBe(202)
      const status = await waitForRun(server.url)
      expect(status.last_run).toMatchObject({
        status: 'completed', interval: '1m', bars_written: 2,
      })
      expect(status.storage).toMatchObject({ daily_bars: 0, minute_bars: 2 })

      const localBars = await fetch(
        `${server.url}/v1/instruments/${encodeURIComponent('cn:equity:XSHG:600000')}/bars?interval=1m&start=2026-05-22&end=2026-08-22`,
      )
      expect(localBars.status).toBe(200)
      expect(await localBars.json()).toMatchObject({
        data: [
          { interval: '1m', period_end: '2026-05-22T09:31:00+08:00', close: '10.1' },
          { interval: '1m', period_end: '2026-08-21T09:31:00+08:00', close: '10.2' },
        ],
        meta: { sources: [{ provider: 'local-duckdb', upstream: 'local' }] },
      })

      const browserList = await fetch(
        `${server.url}/v1/local-data/instruments?interval=1m&limit=10&offset=0`,
      )
      expect(browserList.status).toBe(200)
      expect(await browserList.json()).toMatchObject({
        data: [{
          instrument_id: 'cn:equity:XSHG:600000',
          minute_records: 2,
          minute_first_trading_date: '2026-05-22',
          minute_last_trading_date: '2026-08-21',
        }],
        meta: { local_only: true },
      })

      const coverage = await fetch(
        `${server.url}/v1/local-data/instruments/${encodeURIComponent('cn:equity:XSHG:600000')}/coverage?interval=1m`,
      )
      expect(coverage.status).toBe(200)
      expect(await coverage.json()).toMatchObject({
        data: {
          interval: '1m', requested_start: '2026-05-22', requested_end: '2026-08-22',
          actual_start: '2026-05-22', actual_end: '2026-08-21', records: 2,
          sources: ['sina'], last_fetched_at: expect.any(String),
        },
        meta: { local_only: true },
      })

      const browserBars = await fetch(
        `${server.url}/v1/local-data/instruments/${encodeURIComponent('cn:equity:XSHG:600000')}/bars?interval=1m&start=2026-08-21&end=2026-08-21&limit=1&offset=0`,
      )
      expect(browserBars.status).toBe(200)
      expect(await browserBars.json()).toMatchObject({
        data: [{ interval: '1m', trading_date: '2026-08-21', close: '10.2' }],
        page: { total: 1, limit: 1, offset: 0 },
        meta: { local_only: true },
      })
      expect(requestedIntervals).toEqual(['1m'])
    } finally {
      await server.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('stores daily bars and re-fetches a ten-day overlap on incremental runs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'eva-data-sync-'))
    const starts: string[] = []
    const provider: InstrumentProvider = {
      id: 'sync-fixture',
      async listInstruments() {
        return [{
          type: 'equity',
          market: 'CN',
          name: '浦发银行',
          symbol: '600000',
          providerSymbol: 'sh600000',
          venue: 'XSHG',
          currency: 'CNY',
          status: 'active',
          capabilities: ['bars'],
        }]
      },
      async getBars(call) {
        starts.push(call.start ?? '')
        return [{
          source: 'sina',
          interval: '1d',
          tradingDate: '2026-01-12',
          periodStart: '2026-01-12T00:00:00+08:00',
          periodEnd: '2026-01-12T23:59:59+08:00',
          currency: 'CNY',
          open: '10.10',
          high: '10.50',
          low: '10.00',
          close: '10.40',
          volume: 1_000_000,
          turnover: '10300000.00',
          adjustment: call.adjustment,
          complete: true,
        }]
      },
    }
    const server = await createEvaTickServer({
      historyPath: join(directory, 'history.duckdb'),
      healthCheckIntervalMs: 0,
    })
    await server.mountProvider(provider)

    try {
      for (let run = 0; run < 2; run += 1) {
        const response = await fetch(`${server.url}/v1/data-sync/runs`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            instrument_types: ['equity'],
            start: '2025-01-01',
            end: '2026-01-31',
            adjustment: 'none',
          }),
        })
        expect(response.status).toBe(202)
        const status = await waitForRun(server.url)
        expect(status.last_run).toMatchObject({
          status: 'completed',
          succeeded: 1,
          bars_written: 1,
        })
        expect(status.storage).toMatchObject({ instruments: 1, daily_bars: 1 })
      }
      expect(starts).toEqual(['2025-01-01', '2026-01-02'])

      const localBars = await fetch(
        `${server.url}/v1/instruments/${encodeURIComponent('cn:equity:XSHG:600000')}/bars?interval=1d&start=2025-01-01&end=2026-01-31`,
      )
      expect(localBars.status).toBe(200)
      expect(await localBars.json()).toMatchObject({
        data: [{ trading_date: '2026-01-12', close: '10.4' }],
        meta: { sources: [{ provider: 'local-duckdb', upstream: 'local' }] },
      })
      const localQuote = await fetch(
        `${server.url}/v1/instruments/${encodeURIComponent('cn:equity:XSHG:600000')}/quote`,
      )
      expect(localQuote.status).toBe(200)
      expect(await localQuote.json()).toMatchObject({
        data: { last: '10.4' },
        meta: { sources: [{ provider: 'local-duckdb', upstream: 'local' }] },
      })
      expect(starts).toHaveLength(2)

      const browserList = await fetch(
        `${server.url}/v1/local-data/instruments?q=${encodeURIComponent('浦发 银行')}&type=equity&limit=10&offset=0`,
      )
      expect(browserList.status).toBe(200)
      expect(await browserList.json()).toMatchObject({
        schema: 'eva.local-instrument-list.v1',
        data: [{
          instrument_id: 'cn:equity:XSHG:600000',
          symbol: '600000',
          name: '浦发银行',
          records: 1,
          first_trading_date: '2026-01-12',
          last_trading_date: '2026-01-12',
          latest_close: '10.4',
        }],
        page: { total: 1, limit: 10, offset: 0 },
      })
      const browserBars = await fetch(
        `${server.url}/v1/local-data/instruments/${encodeURIComponent('cn:equity:XSHG:600000')}/bars?limit=20`,
      )
      expect(browserBars.status).toBe(200)
      expect(await browserBars.json()).toMatchObject({
        schema: 'eva.local-bar-list.v1',
        data: [{ trading_date: '2026-01-12', close: '10.4' }],
      })

      const remoteBars = await fetch(
        `${server.url}/v1/instruments/${encodeURIComponent('cn:equity:XSHG:600000')}/bars?interval=1d&start=2026-02-01&end=2026-02-01`,
      )
      expect(remoteBars.status).toBe(200)
      expect(await remoteBars.json()).toMatchObject({
        meta: { sources: [{ provider: 'sync-fixture', upstream: 'sina' }] },
      })
      expect(starts.at(-1)).toBe('2026-02-01')

      const backfill = await fetch(`${server.url}/v1/data-sync/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          instrument_types: ['equity'],
          start: '1990-01-01',
          end: '2026-01-31',
          adjustment: 'none',
        }),
      })
      expect(backfill.status).toBe(202)
      await waitForRun(server.url)
      expect(starts.at(-1)).toBe('1990-01-01')
    } finally {
      await server.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('serves the synchronization management page', async () => {
    const server = await createEvaTickServer({ healthCheckIntervalMs: 0 })
    try {
      const response = await fetch(`${server.url}/admin/data-sync`)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('text/html')
      const page = await response.text()
      expect(page).toContain('历史数据同步')
      expect(page).toContain('data-kind="future_cn">国内期货')
      expect(page).toContain('data-kind="future_global">国际期货')
      expect(page).toContain('data-kind="crypto">加密货币')
      expect(page).toContain('<th>交易场所</th>')
      expect(page).toContain('搜索标的')
      expect(page).toContain('同步此标的')
      expect(page).not.toContain('<h1')
      expect(page).toContain('<th>序列</th><th>代码</th>')
      expect(page).toContain('同步日线')
      expect(page).toContain('同步所选')
      expect(page).toContain('全部同步')
      expect(page).toContain('刷新标的目录')
      expect(page).toContain('回溯最近（天）')
      expect(page).toContain('周一至周五')
      expect(page).toContain('<option value="1m" selected>1 分钟</option>')
      expect(page).toContain('创建定时任务')
      expect(page).toContain('下次执行')
      expect(page).toContain('最近触发')
      expect(page).toContain('data-schedule-id')
      expect(page).toContain('aria-label="管理目录"')
      expect(page).toContain('href="/admin"')
      expect(page).toContain('class="active" aria-current="page" href="/admin/data-sync"')

      const browserResponse = await fetch(`${server.url}/admin`)
      expect(browserResponse.status).toBe(200)
      const browserPage = await browserResponse.text()
      expect(browserPage).toContain('数据浏览')
      expect(browserPage).not.toContain('<h1')
      expect(browserPage).not.toContain('数据源健康')
      expect(browserPage).toContain('1 分钟')
      expect(browserPage).toContain('data-type="crypto" data-market="">加密货币')
      expect(browserPage).toContain('data-type="future" data-market="CN">国内期货')
      expect(browserPage).toContain('data-type="future" data-market="GLOBAL">国际期货')
      expect(browserPage).toContain('<th>交易场所</th>')
      expect(browserPage).toContain('<th>日线实际范围</th>')
      expect(browserPage).toContain('range(item.daily_first_trading_date,item.daily_last_trading_date)')
      expect(browserPage).not.toContain('<th>1m 实际范围</th>')
      expect(browserPage).toContain('LOCAL ONLY')
      expect(browserPage).not.toContain('每日分钟完整性')
      expect(browserPage).not.toContain('覆盖状态')
      expect(browserPage).toContain('id="bar-chart-canvas"')
      expect(browserPage).toContain('data-view="chart"')
      expect(browserPage).toContain('data-view="table"')
      expect(browserPage).toContain('行情柱图')
      expect(browserPage).toContain('class="active" aria-current="page" href="/admin"')

      const dailyScheduleResponse = await fetch(`${server.url}/v1/data-sync/schedules`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          interval: '1d', time: '18:00', skip_weekends: true,
          instrument_types: ['equity', 'index'],
          lookback_days: 10, adjustment: 'none', delay_ms: 750,
        }),
      })
      expect(dailyScheduleResponse.status).toBe(201)
      const dailySchedule = await dailyScheduleResponse.json() as {
        data: { schedule_id: number }
      }
      expect(dailySchedule).toMatchObject({
        data: {
          schedule_id: 1, enabled: true, interval: '1d', time: '18:00', skip_weekends: true,
          lookback_days: 10, next_run_at: expect.any(String),
        },
      })
      const minuteScheduleResponse = await fetch(`${server.url}/v1/data-sync/schedules`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          interval: '1m', time: '23:59', skip_weekends: true,
          instrument_types: ['equity'],
          lookback_days: 3, adjustment: 'none', delay_ms: 750,
        }),
      })
      expect(minuteScheduleResponse.status).toBe(201)
      expect(await minuteScheduleResponse.json()).toMatchObject({
        data: { schedule_id: 2, interval: '1m', time: '23:59', next_run_at: expect.any(String) },
      })
      const status = await fetch(`${server.url}/v1/data-sync`).then((result) => result.json()) as {
        data: { schedules: unknown[] }
      }
      expect(status.data.schedules).toEqual(expect.arrayContaining([
          expect.objectContaining({ schedule_id: 1, interval: '1d', time: '18:00' }),
          expect.objectContaining({ schedule_id: 2, interval: '1m', time: '23:59' }),
      ]))

      const deleted = await fetch(
        `${server.url}/v1/data-sync/schedules/${dailySchedule.data.schedule_id}`,
        { method: 'DELETE' },
      )
      expect(deleted.status).toBe(204)
      const afterDelete = await fetch(`${server.url}/v1/data-sync`).then((result) => result.json())
      expect(afterDelete).toMatchObject({
        data: { schedules: [{ schedule_id: 2, interval: '1m' }] },
      })

      const invalidSchedule = await fetch(`${server.url}/v1/data-sync/schedules`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          interval: '1m', time: '23:59', skip_weekends: true, instrument_types: ['equity'],
          lookback_days: 0, adjustment: 'none', delay_ms: 750,
        }),
      })
      expect(invalidSchedule.status).toBe(400)
    } finally {
      await server.close()
    }
  })

  it('persists multiple scheduled sync tasks across restarts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'eva-data-schedules-'))
    const historyPath = join(directory, 'history.duckdb')
    let server = await createEvaTickServer({ historyPath, healthCheckIntervalMs: 0 })
    try {
      for (const [interval, time] of [['1d', '18:00'], ['1m', '19:00']] as const) {
        const response = await fetch(`${server.url}/v1/data-sync/schedules`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            interval, time, skip_weekends: true, instrument_types: ['equity'],
            lookback_days: 10, adjustment: 'none', delay_ms: 750,
          }),
        })
        expect(response.status).toBe(201)
      }
      await server.close()

      server = await createEvaTickServer({ historyPath, healthCheckIntervalMs: 0 })
      const status = await fetch(`${server.url}/v1/data-sync`).then((response) => response.json()) as {
        data: { schedules: { interval: string; next_run_at: string | null }[] }
      }
      expect(status.data.schedules).toHaveLength(2)
      expect(status.data.schedules.map((schedule) => schedule.interval).sort()).toEqual(['1d', '1m'])
      expect(status.data.schedules.every((schedule) => schedule.next_run_at !== null)).toBe(true)
    } finally {
      await server.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('resumes an interrupted run without fetching completed instruments again', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'eva-data-resume-'))
    const requestedSymbols: string[] = []
    const provider: InstrumentProvider = {
      id: 'resume-fixture',
      async listInstruments() {
        return ['600000', '600001'].map((symbol) => ({
          type: 'equity' as const,
          market: 'CN' as const,
          name: `股票${symbol}`,
          symbol,
          providerSymbol: `sh${symbol}`,
          venue: 'XSHG',
          currency: 'CNY',
          status: 'active' as const,
          capabilities: ['bars' as const],
        }))
      },
      async getBars(call) {
        requestedSymbols.push(call.providerSymbol)
        return [{
          source: 'sina',
          interval: '1d',
          tradingDate: '2026-01-12',
          periodStart: '2026-01-12T00:00:00+08:00',
          periodEnd: '2026-01-12T23:59:59+08:00',
          currency: 'CNY',
          open: '10',
          high: '11',
          low: '9',
          close: '10.5',
          volume: 100,
          turnover: '1000',
          adjustment: call.adjustment,
          complete: true,
        }]
      },
    }
    const server = await createEvaTickServer({
      historyPath: join(directory, 'history.duckdb'),
      healthCheckIntervalMs: 0,
    })
    await server.mountProvider(provider)

    try {
      const started = await fetch(`${server.url}/v1/data-sync/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          instrument_types: ['equity'],
          start: '2026-01-01',
          end: '2026-01-31',
          adjustment: 'none',
          delay_ms: 500,
        }),
      })
      expect(started.status).toBe(202)

      for (let attempt = 0; attempt < 100; attempt += 1) {
        const status = await fetch(`${server.url}/v1/data-sync`).then((response) => response.json()) as {
          data: { active_run: { completed: number } | null }
        }
        if (status.data.active_run?.completed === 1) break
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      const cancelled = await fetch(`${server.url}/v1/data-sync/cancel`, { method: 'POST' })
      expect(cancelled.status).toBe(202)
      const interrupted = await waitForRun(server.url)
      expect(interrupted.last_run).toMatchObject({ status: 'cancelled', succeeded: 1 })

      const resumed = await fetch(`${server.url}/v1/data-sync/resume`, { method: 'POST' })
      expect(resumed.status).toBe(202)
      const completed = await waitForRun(server.url)
      expect(completed.last_run).toMatchObject({
        status: 'completed', trigger: 'manual', succeeded: 2, failed: 0,
        total: 2, retry_count: 1,
      })
      expect(requestedSymbols).toEqual(['sh600000', 'sh600001'])
    } finally {
      await server.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('records independent runs and retries failed instruments', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'eva-run-history-'))
    let allowSecond = false
    const requestedSymbols: string[] = []
    const provider: InstrumentProvider = {
      id: 'run-history-fixture',
      async listInstruments() {
        return ['600000', '600001', '600002'].map((symbol) => ({
          type: 'equity' as const, market: 'CN', name: `股票${symbol}`, symbol,
          providerSymbol: `sh${symbol}`, venue: 'XSHG', currency: 'CNY',
          status: 'active' as const, capabilities: ['bars' as const],
        }))
      },
      async getBars(call) {
        requestedSymbols.push(call.providerSymbol)
        if (call.providerSymbol === 'sh600001' && !allowSecond) {
          throw new Error('UPSTREAM_TEMPORARY_FAILURE')
        }
        return [{
          source: 'fixture', interval: call.interval, tradingDate: '2026-08-21',
          periodStart: '2026-08-21T00:00:00+08:00', periodEnd: '2026-08-21T23:59:59+08:00',
          currency: 'CNY', open: '10', high: '11', low: '9', close: '10.5',
          volume: 100, turnover: '1000', adjustment: call.adjustment, complete: true,
        }]
      },
    }
    const server = await createEvaTickServer({
      historyPath: join(directory, 'history.duckdb'), healthCheckIntervalMs: 0,
    })
    await server.mountProvider(provider)

    try {
      const start = await fetch(`${server.url}/v1/data-sync/runs`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          instrument_types: ['equity'], interval: '1d', start: '2026-08-21',
          end: '2026-08-21', adjustment: 'none', limit: 2,
        }),
      })
      const firstRunId = ((await start.json()) as { data: { run_id: string } }).data.run_id
      const first = await waitForRun(server.url)
      expect(first.last_run).toMatchObject({
        trigger: 'manual', status: 'completed_with_errors', succeeded: 1, failed: 1,
      })

      const items = await fetch(`${server.url}/v1/data-sync/runs/${firstRunId}/items`)
        .then((response) => response.json()) as { data: { instrument_id: string; status: string }[] }
      expect(items.data.map((item) => item.status).sort()).toEqual(['completed', 'failed'])

      allowSecond = true
      const retry = await fetch(`${server.url}/v1/data-sync/runs/${firstRunId}/retry`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      })
      expect(retry.status).toBe(202)
      const retriedSource = (await retry.json()) as {
        data: { run_id: string; trigger: string; status: string; retry_count: number }
      }
      expect(retriedSource.data).toMatchObject({
        run_id: firstRunId, trigger: 'manual', status: 'running', retry_count: 1,
      })
      const retried = await waitForRun(server.url)
      expect(retried.last_run).toMatchObject({
        run_id: firstRunId, trigger: 'manual', status: 'completed',
        total: 2, succeeded: 2, failed: 0, retry_count: 1, remaining_failed: 0,
      })

      const runs = await fetch(`${server.url}/v1/data-sync/runs`).then((response) => response.json()) as {
        data: {
          run_id: string; trigger: string; status: string; succeeded: number
          recovery_status: string; retry_count: number
          latest_retry_run_id: string | null; remaining_failed: number
        }[]
      }
      expect(runs.data).toHaveLength(1)
      expect(runs.data[0]).toMatchObject({
        run_id: firstRunId, trigger: 'manual', status: 'completed',
        succeeded: 2, failed: 0, recovery_status: 'recovered', retry_count: 1,
        latest_retry_run_id: expect.any(String), remaining_failed: 0,
      })
      const recoveredItems = await fetch(`${server.url}/v1/data-sync/runs/${firstRunId}/items`)
        .then((response) => response.json()) as { data: { status: string; error: string | null }[] }
      expect(recoveredItems.data.map((item) => item.status).sort()).toEqual(['completed', 'recovered'])
      expect(recoveredItems.data.find((item) => item.status === 'recovered')?.error).toBeNull()

      const clear = await fetch(`${server.url}/v1/data-sync/runs`, { method: 'DELETE' })
      expect(clear.status).toBe(204)
      const afterClear = await fetch(`${server.url}/v1/data-sync`).then((response) => response.json())
      expect(afterClear).toMatchObject({
        data: { active_run: null, last_run: null, storage: { daily_bars: 2 } },
      })
      const runsAfterClear = await fetch(`${server.url}/v1/data-sync/runs`)
        .then((response) => response.json()) as { data: unknown[] }
      expect(runsAfterClear.data).toEqual([])

      const removedGapEndpoint = await fetch(`${server.url}/v1/data-sync/gaps`)
      expect(removedGapEndpoint.status).toBe(404)
      expect(requestedSymbols.filter((symbol) => symbol === 'sh600000')).toHaveLength(1)
      expect(requestedSymbols.at(-1)).toBe('sh600001')
    } finally {
      await server.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
