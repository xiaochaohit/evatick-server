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
          minute_coverage_status: 'complete',
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
          status: 'complete', sources: ['sina'],
          daily: [
            { trading_date: '2026-08-21', records: 1, missing_records: 239, status: 'partial' },
            { trading_date: '2026-05-22', records: 1, missing_records: 239, status: 'partial' },
          ],
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
      expect(page).toContain('每日定时同步')
      expect(page).toContain('回溯最近（天）')
      expect(page).toContain('跳过周末')
      expect(page).not.toContain('历史起始日')
      expect(page).not.toContain('1 分钟 · 三个月验证')
      expect(page).toContain('<option value="1m" selected>1 分钟</option>')
      expect(page).toContain("button.textContent='正在提交…'")
      expect(page).toContain("button.textContent='同步中'")
      expect(page).toContain('当前定时任务')
      expect(page).toContain('添加定时任务')
      expect(page).toContain('data-schedule-id')
      expect(page).toContain('aria-label="管理目录"')
      expect(page).toContain('href="/admin"')
      expect(page).toContain('class="active" aria-current="page" href="/admin/data-sync"')

      const browserResponse = await fetch(`${server.url}/admin`)
      expect(browserResponse.status).toBe(200)
      const browserPage = await browserResponse.text()
      expect(browserPage).toContain('数据浏览')
      expect(browserPage).toContain('数据源健康')
      expect(browserPage).toContain('1 分钟')
      expect(browserPage).toContain('LOCAL ONLY')
      expect(browserPage).toContain('每日分钟完整性')
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
        status: 'completed', trigger: 'retry', succeeded: 1, total: 1,
      })
      expect(requestedSymbols).toEqual(['sh600000', 'sh600001'])
    } finally {
      await server.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('records independent runs, retries failed instruments, and reports data gaps', async () => {
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
      const retryRunId = ((await retry.json()) as { data: { run_id: string } }).data.run_id
      const retried = await waitForRun(server.url)
      expect(retried.last_run).toMatchObject({
        trigger: 'retry', retry_of_run_id: firstRunId, status: 'completed',
        total: 1, succeeded: 1, failed: 0,
      })

      const runs = await fetch(`${server.url}/v1/data-sync/runs`).then((response) => response.json()) as {
        data: { run_id: string; trigger: string; succeeded: number }[]
      }
      expect(runs.data.slice(0, 2)).toMatchObject([
        { trigger: 'retry', succeeded: 1 },
        { run_id: firstRunId, trigger: 'manual', succeeded: 1 },
      ])

      const rerun = await fetch(`${server.url}/v1/data-sync/runs/${retryRunId}/retry`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ failed_only: false }),
      })
      expect(rerun.status).toBe(202)
      expect((await waitForRun(server.url)).last_run).toMatchObject({
        trigger: 'retry', retry_of_run_id: retryRunId, total: 1, succeeded: 1,
      })

      const gaps = await fetch(
        `${server.url}/v1/data-sync/gaps?interval=1d&start=2026-08-21&end=2026-08-21&instrument_types=equity`,
      ).then((response) => response.json()) as {
        data: { checked: number; complete: number; missing: number; items: { symbol: string; issue: string }[] }
      }
      expect(gaps.data).toMatchObject({ checked: 3, complete: 2, missing: 1 })
      expect(gaps.data.items).toEqual([expect.objectContaining({ symbol: '600002', issue: 'no_data' })])
      expect(requestedSymbols.filter((symbol) => symbol === 'sh600000')).toHaveLength(1)
      expect(requestedSymbols.at(-1)).toBe('sh600001')
    } finally {
      await server.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
