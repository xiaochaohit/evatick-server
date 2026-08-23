import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import type { InstrumentProvider } from '@evatick/server'
import { DataSourcePreferences } from '../../packages/transport-http/src/data-source-preferences.js'

describe('data source preferences', () => {
  it('persists independent category orders and reapplies them after restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'eva-source-preferences-'))
    const path = join(directory, 'preferences.json')
    const setDataSourceOrder = vi.fn()
    const provider: InstrumentProvider = {
      id: 'fixture',
      dataSources: [
        { id: 'first', name: 'First', categories: ['equity', 'index'], capabilities: {} },
        { id: 'second', name: 'Second', categories: ['equity'], capabilities: {} },
      ],
      setDataSourceOrder,
      async listInstruments() { return [] },
    }

    try {
      const preferences = new DataSourcePreferences(() => [provider], path)
      await preferences.update('equity', ['fixture:second', 'fixture:first'])
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
        schema: 'eva.data-source-preferences.v1',
        orders: { equity: ['fixture:second', 'fixture:first'] },
      })

      setDataSourceOrder.mockClear()
      const restarted = new DataSourcePreferences(() => [provider], path)
      expect(await restarted.list()).toEqual([
        { category: 'equity', source_ids: ['fixture:second', 'fixture:first'] },
        { category: 'index', source_ids: ['fixture:first'] },
      ])
      expect(setDataSourceOrder).toHaveBeenCalledWith('equity', ['second', 'first'])
      expect(setDataSourceOrder).toHaveBeenCalledWith('index', ['first'])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
