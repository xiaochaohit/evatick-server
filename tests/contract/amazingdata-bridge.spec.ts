import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { AmazingDataBridge } from '@evatick/provider-amazingdata'

describe('AmazingData persistent bridge contract', () => {
  it('serves successive requests through one authenticated Python process', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'evatick-amazingdata-bridge-'))
    await writeFile(join(directory, 'AmazingData.py'), `
class BaseData:
    calls = 0
    def get_calendar(self): return []
    def get_code_info(self, security_type):
        BaseData.calls += 1
        return [{}] * BaseData.calls
class MarketData:
    def __init__(self, calendar): pass
def login(**kwargs): pass
def logout(username): pass
`)
    const bridge = new AmazingDataBridge({
      pythonExecutable: 'python3',
      pythonPath: [
        directory,
        join(process.cwd(), 'providers/amazingdata-python'),
      ].join(delimiter),
      username: 'test-user', password: 'test-password',
      host: '127.0.0.1', port: 8600,
      cachePath: join(directory, 'cache'),
    })
    try {
      await expect(bridge.run(
        { operation: 'health', category: 'equity' }, new AbortController().signal,
      )).resolves.toEqual({ source: 'amazingdata', data: { records: 1 } })
      await expect(bridge.run(
        { operation: 'health', category: 'equity' }, new AbortController().signal,
      )).resolves.toEqual({ source: 'amazingdata', data: { records: 2 } })
    } finally {
      await bridge.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('aborts a blocked process and reconnects on the next request', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'evatick-amazingdata-reconnect-'))
    await writeFile(join(directory, 'AmazingData.py'), `
import os, time
fast = False
class BaseData:
    def get_calendar(self): return []
    def get_code_info(self, security_type):
        if not fast: time.sleep(10)
        return [{}]
class MarketData:
    def __init__(self, calendar): pass
def login(**kwargs):
    global fast
    marker = os.path.join(os.environ['AMAZINGDATA_CACHE_PATH'], 'logged-in')
    fast = os.path.exists(marker)
    open(marker, 'a').close()
def logout(username): pass
`)
    const bridge = new AmazingDataBridge({
      pythonExecutable: 'python3',
      pythonPath: [
        directory,
        join(process.cwd(), 'providers/amazingdata-python'),
      ].join(delimiter),
      username: 'test-user', password: 'test-password',
      host: '127.0.0.1', port: 8600,
      cachePath: join(directory, 'cache'),
    })
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 100)
    try {
      await expect(bridge.run({ operation: 'health', category: 'equity' }, controller.signal))
        .rejects.toMatchObject({ code: 'PROVIDER_ABORTED' })
      await expect(bridge.run(
        { operation: 'health', category: 'equity' }, new AbortController().signal,
      )).resolves.toEqual({ source: 'amazingdata', data: { records: 1 } })
    } finally {
      clearTimeout(timeout)
      await bridge.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
