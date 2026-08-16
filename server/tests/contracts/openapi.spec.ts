import { resolve } from 'node:path'

import SwaggerParser from '@apidevtools/swagger-parser'
import { describe, expect, it } from 'vitest'

describe('public HTTP contract', () => {
  it('publishes a valid OpenAPI operation for the instrument list', async () => {
    const contractPath = resolve(
      process.cwd(),
      '../contracts/openapi/market-api-v1.yaml',
    )

    const contract = await SwaggerParser.validate(contractPath)

    expect(Reflect.get(contract, 'openapi')).toBe('3.1.0')
    const paths = Reflect.get(contract, 'paths') as Record<
      string,
      { get?: { operationId?: string } }
    >
    expect(paths['/v1/instruments']?.get?.operationId).toBe('listInstruments')
  })
})
