import { describe, expect, it, vi } from 'vitest'

import {
  createMarketServer,
  ProviderError,
  type InstrumentProvider,
} from '@market-cli/server'

describe('data source management', () => {
  it('reports provider health and supports manual checks', async () => {
    const healthyProvider: InstrumentProvider = {
      id: 'fixture-provider',
      dataSources: [{
        id: 'sina', name: '新浪财经', categories: ['equity', 'index'],
        capabilities: { equity: ['日线'], index: ['日线'] },
      }],
      async listInstruments() {
        return []
      },
      async checkDataSource({ category }) {
        if (category === 'index') {
          throw new ProviderError('UPSTREAM_UNAVAILABLE', 'index endpoint is offline', true)
        }
        return { recordsChecked: 12 }
      },
    }
    const server = await createMarketServer({ healthCheckIntervalMs: 0 })
    try {
      await server.mountProvider(healthyProvider)

      const checkResponse = await fetch(`${server.url}/v1/data-sources/check`, {
        method: 'POST',
      })
      expect(checkResponse.status).toBe(200)
      const checked = await checkResponse.json() as any
      expect(checked.data).toEqual(expect.arrayContaining([
        expect.objectContaining({
          provider_id: 'local-duckdb',
          source_id: 'local',
          source_name: '本地 DuckDB',
          category: 'equity',
          status: 'healthy',
        }),
        expect.objectContaining({
          provider_id: 'fixture-provider',
          source_id: 'sina',
          source_name: '新浪财经',
          category: 'equity',
          status: 'healthy',
          records_checked: 12,
          capabilities: ['日线'],
          error: null,
        }),
        expect.objectContaining({
          source_id: 'sina',
          category: 'index',
          status: 'unhealthy',
          error: {
            code: 'UPSTREAM_UNAVAILABLE',
            message: 'index endpoint is offline',
          },
        }),
      ]))

      const listResponse = await fetch(`${server.url}/v1/data-sources`)
      expect(listResponse.status).toBe(200)
      expect(await listResponse.json()).toMatchObject({
        schema: 'market.data-source-list.v1',
        schedule: { enabled: false, interval_seconds: 0, next_check_at: null },
      })
    } finally {
      await server.close()
    }
  })

  it('runs scheduled checks and serves the management console', async () => {
    let available = false
    const checkDataSource = vi.fn(async () => {
      if (!available) {
        throw new ProviderError('TEMPORARY_FAILURE', 'temporary failure', true)
      }
      return { recordsChecked: 8 }
    })
    const server = await createMarketServer({
      healthCheckIntervalMs: 20,
      healthCheckTimeoutMs: 100,
    })
    try {
      await server.mountProvider({
        id: 'scheduled-provider',
        dataSources: [{
          id: 'eastmoney', name: '东方财富', categories: ['equity'],
          capabilities: { equity: ['日线'] },
        }],
        checkDataSource,
        async listInstruments() { return [] },
      })

      await vi.waitFor(async () => {
        const response = await fetch(`${server.url}/v1/data-sources`)
        const body = await response.json() as any
        expect(body.data.find((item: any) => item.source_id === 'eastmoney')?.status)
          .toBe('unhealthy')
      })

      available = true
      await vi.waitFor(async () => {
        const response = await fetch(`${server.url}/v1/data-sources`)
        const body = await response.json() as any
        expect(body.data.find((item: any) => item.source_id === 'eastmoney')?.status)
          .toBe('healthy')
      })
      expect(checkDataSource.mock.calls.length).toBeGreaterThanOrEqual(2)

      const pageResponse = await fetch(`${server.url}/admin/data-sources`)
      expect(pageResponse.status).toBe(200)
      expect(pageResponse.headers.get('content-type')).toContain('text/html')
      const page = await pageResponse.text()
      expect(page).toContain('数据浏览')
      expect(page).toContain('数据源健康')
      expect(page).toContain('aria-label="管理目录"')
      expect(page).toContain('class="active" aria-current="page" href="/admin"')
      expect(page).toContain('href="/admin/data-sync"')

      const invalidInterval = await fetch(`${server.url}/v1/data-sources/schedule`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: true, interval_seconds: 3599 }),
      })
      expect(invalidInterval.status).toBe(400)
    } finally {
      await server.close()
    }
  })
})
