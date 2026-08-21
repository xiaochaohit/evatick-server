import { describe, expect, it } from 'vitest'

import { createEvaTickServer } from '@evatick/server'

describe('HTTP problem details', () => {
  it('returns the versioned problem contract for an unknown route', async () => {
    const server = await createEvaTickServer()
    try {
      const response = await fetch(`${server.url}/v1/does-not-exist`)
      expect(response.status).toBe(404)
      expect(response.headers.get('content-type')).toContain('application/problem+json')
      expect(await response.json()).toMatchObject({
        type: 'urn:eva:problem:route-not-found',
        title: 'Route not found',
        status: 404,
        code: 'ROUTE_NOT_FOUND',
        retryable: false,
        request_id: expect.stringMatching(/^req_/),
      })
    } finally {
      await server.close()
    }
  })
})
