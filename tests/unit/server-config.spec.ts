import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  configurationPathFromArguments,
  loadEvaDaemonConfiguration,
} from '../../apps/evatick-server/src/config.js'

function configuration() {
  return {
    schema: 'eva.server-config.v1',
    server: {
      host: '127.0.0.1',
      port: 8765,
      retryAttempts: 2,
      requestTimeoutMs: 30_000,
      healthCheckIntervalSeconds: 3_600,
      healthCheckTimeoutMs: 10_000,
    },
    storage: {
      catalogPath: './data/catalog.sqlite',
      historyPath: './data/history.duckdb',
    },
    admin: {
      username: 'admin',
      initialPassword: 'test-configuration-password',
      credentialsPath: './data/admin-credentials.json',
    },
    providers: {
      akshare: { pythonExecutable: './python/bin/python' },
    },
  }
}

describe('EVA daemon configuration', () => {
  it('loads one versioned file and resolves relative paths from its directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'evatickd-config-'))
    const path = join(directory, 'config.json')
    await writeFile(path, JSON.stringify(configuration()), { mode: 0o600 })
    try {
      const loaded = await loadEvaDaemonConfiguration(path)
      expect(loaded).toMatchObject({
        schema: 'eva.server-config.v1',
        server: { host: '127.0.0.1', port: 8765 },
        admin: { username: 'admin', initialPassword: 'test-configuration-password' },
      })
      expect(loaded.storage.catalogPath).toBe(join(directory, 'data/catalog.sqlite'))
      expect(loaded.storage.historyPath).toBe(join(directory, 'data/history.duckdb'))
      expect(loaded.storage.dataSourcePreferencesPath).toBe(join(directory, 'data/data-source-preferences.json'))
      expect(loaded.admin.credentialsPath).toBe(join(directory, 'data/admin-credentials.json'))
      expect(loaded.providers.akshare.pythonExecutable).toBe(join(directory, 'python/bin/python'))
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects unknown fields and example password placeholders', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'evatickd-config-invalid-'))
    const path = join(directory, 'config.json')
    try {
      const unknown = { ...configuration(), unexpected: true }
      await writeFile(path, JSON.stringify(unknown), { mode: 0o600 })
      await expect(loadEvaDaemonConfiguration(path)).rejects.toThrow('unknown field: unexpected')

      const placeholder = configuration()
      placeholder.admin.initialPassword = '<set-in-private-config>'
      await writeFile(path, JSON.stringify(placeholder), { mode: 0o600 })
      await expect(loadEvaDaemonConfiguration(path)).rejects.toThrow('must not be an example placeholder')

      const tooShort = configuration()
      tooShort.admin.initialPassword = 'short7!'
      await writeFile(path, JSON.stringify(tooShort), { mode: 0o600 })
      await expect(loadEvaDaemonConfiguration(path)).rejects.toThrow('8 to 256 characters')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.runIf(process.platform !== 'win32')('requires private permissions when the file contains an initial password', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'evatickd-config-mode-'))
    const path = join(directory, 'config.json')
    try {
      await writeFile(path, JSON.stringify(configuration()), { mode: 0o600 })
      await chmod(path, 0o644)
      await expect(loadEvaDaemonConfiguration(path)).rejects.toThrow('must be owner-only')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('requires exactly one --config argument', () => {
    expect(configurationPathFromArguments(['--config', '/etc/evatickd/config.json']))
      .toBe('/etc/evatickd/config.json')
    expect(() => configurationPathFromArguments([])).toThrow('usage: evatickd')
    expect(() => configurationPathFromArguments(['--config', 'one.json', 'two.json'])).toThrow('usage:')
  })
})
