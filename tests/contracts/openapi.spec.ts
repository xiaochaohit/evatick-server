import { resolve } from 'node:path'

import SwaggerParser from '@apidevtools/swagger-parser'
import { createEvaTickServer } from '@evatick/server'
import { describe, expect, it } from 'vitest'

describe('public HTTP contract', () => {
  it('publishes a valid OpenAPI operation for the instrument list', async () => {
    const contractPath = resolve(
      process.cwd(),
      'contracts/openapi/evatick-api-v1.yaml',
    )

    const contract = await SwaggerParser.validate(contractPath)

    expect(Reflect.get(contract, 'openapi')).toBe('3.1.0')
    const paths = Reflect.get(contract, 'paths') as Record<
      string,
      {
        get?: { operationId?: string }
        post?: { operationId?: string }
      }
    >
    expect(paths['/v1/instruments']?.get?.operationId).toBe('listInstruments')
    expect(paths['/v1/instruments/{instrument_id}']?.get?.operationId).toBe(
      'getInstrument',
    )
    expect(paths['/v1/instrument-search']?.get?.operationId).toBe(
      'searchInstruments',
    )
    expect(paths['/v1/instrument-resolve']?.post?.operationId).toBe(
      'resolveInstrument',
    )
    expect(paths['/v1/instruments/{instrument_id}/quote']?.get?.operationId).toBe(
      'getQuote',
    )
    expect(paths['/v1/instruments/{instrument_id}/bars']?.get?.operationId).toBe(
      'getBars',
    )
    expect(
      paths['/v1/indices/{instrument_id}/constituents']?.get?.operationId,
    ).toBe('getIndexConstituents')
  })

  it('serves the contract and interactive documentation', async () => {
    const server = await createEvaTickServer()

    try {
      const [contractResponse, docsResponse] = await Promise.all([
        fetch(`${server.url}/openapi.json`),
        fetch(`${server.url}/docs/`),
      ])
      const contract = (await contractResponse.json()) as Record<string, unknown>

      expect(contractResponse.status).toBe(200)
      expect(contract.openapi).toBe('3.1.0')
      expect(Reflect.get(contract, 'paths')).toHaveProperty('/v1/health')
      expect(docsResponse.status).toBe(200)
      expect(docsResponse.headers.get('content-type')).toContain('text/html')
      expect(await docsResponse.text()).toContain('Swagger UI')
    } finally {
      await server.close()
    }
  })
})
