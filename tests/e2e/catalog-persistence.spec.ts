import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  createEvaTickServer,
  ProviderError,
  type InstrumentProvider,
} from '@evatick/server'

describe('catalog persistence', () => {
  it('serves the last provider snapshot when a refresh is temporarily unavailable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'evatick-server-catalog-'))
    const catalogPath = join(directory, 'catalog.sqlite')
    const available: InstrumentProvider = {
      id: 'persistent-provider',
      async listInstruments() {
        return [
          {
            type: 'equity',
            market: 'CN',
            name: '浦发银行',
            symbol: '600000',
            providerSymbol: 'sh600000',
            venue: 'XSHG',
            currency: 'CNY',
            status: 'active',
            capabilities: ['quote', 'bars'],
          },
        ]
      },
    }

    try {
      const first = await createEvaTickServer({ catalogPath })
      await first.mountProvider(available)
      const firstResponse = await fetch(`${first.url}/v1/instruments`)
      expect(firstResponse.status).toBe(200)
      await first.close()

      const unavailable: InstrumentProvider = {
        id: 'persistent-provider',
        async listInstruments() {
          throw new ProviderError('PROVIDER_NETWORK_ERROR', 'offline', true)
        },
      }
      const second = await createEvaTickServer({ catalogPath, retryAttempts: 1 })
      await second.mountProvider(unavailable)
      try {
        const response = await fetch(`${second.url}/v1/instruments`)
        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({
          data: [{ instrument_id: 'cn:equity:XSHG:600000' }],
          meta: {
            partial: true,
            sources: [{ provider: 'persistent-provider', stale: true }],
            warnings: [
              'provider persistent-provider failed: PROVIDER_NETWORK_ERROR; using stale catalog',
            ],
          },
        })
      } finally {
        await second.close()
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
