import { describe, expect, it } from 'vitest'

import { createEvaTickServer, type InstrumentProvider } from '@evatick/server'

describe('service health', () => {
  it('reports provider readiness through the public HTTP contract', async () => {
    const server = await createEvaTickServer()
    try {
      const emptyResponse = await fetch(`${server.url}/v1/health`)
      expect(emptyResponse.status).toBe(200)
      expect(await emptyResponse.json()).toMatchObject({
        schema: 'eva.health.v1',
        data: { status: 'degraded', providers: 0, version: '1.0.0' },
      })

      const provider: InstrumentProvider = {
        id: 'health-provider',
        async listInstruments() {
          return []
        },
      }
      await server.mountProvider(provider)

      const readyResponse = await fetch(`${server.url}/v1/health`)
      expect(await readyResponse.json()).toMatchObject({
        schema: 'eva.health.v1',
        data: { status: 'ok', providers: 1, version: '1.0.0' },
      })
    } finally {
      await server.close()
    }
  })
})
