import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

import { AkshareProvider } from '@evatick/provider-akshare'
import { BinanceProvider, CoinbaseProvider } from '@evatick/provider-crypto'

import {
  assertPythonExecutable,
  configurationPathFromArguments,
  loadEvaDaemonConfiguration,
} from './config.js'
import { createEvaTickServer } from './index.js'

export async function startEvaTickDaemon(configurationPath: string) {
  const configuration = await loadEvaDaemonConfiguration(configurationPath)
  await mkdir(dirname(configuration.storage.catalogPath), { recursive: true })
  await mkdir(dirname(configuration.storage.historyPath), { recursive: true })
  await mkdir(dirname(configuration.storage.dataSourcePreferencesPath), { recursive: true })
  await mkdir(dirname(configuration.admin.credentialsPath), { recursive: true })
  await mkdir(dirname(configuration.admin.apiKeysPath), { recursive: true })
  await assertPythonExecutable(configuration.providers.akshare.pythonExecutable)
  const server = await createEvaTickServer({
    host: configuration.server.host,
    port: configuration.server.port,
    catalogPath: configuration.storage.catalogPath,
    historyPath: configuration.storage.historyPath,
    dataSourcePreferencesPath: configuration.storage.dataSourcePreferencesPath,
    adminUsername: configuration.admin.username,
    adminPassword: configuration.admin.initialPassword,
    adminCredentialsPath: configuration.admin.credentialsPath,
    apiKeysPath: configuration.admin.apiKeysPath,
    retryAttempts: configuration.server.retryAttempts,
    requestTimeoutMs: configuration.server.requestTimeoutMs,
    healthCheckIntervalMs: configuration.server.healthCheckIntervalSeconds * 1_000,
    healthCheckTimeoutMs: configuration.server.healthCheckTimeoutMs,
  })
  await server.mountProvider(new AkshareProvider({
    pythonExecutable: configuration.providers.akshare.pythonExecutable,
  }))
  await server.mountProvider(new BinanceProvider())
  await server.mountProvider(new CoinbaseProvider())
  return server
}

const configurationPath = configurationPathFromArguments(process.argv.slice(2))
const server = await startEvaTickDaemon(configurationPath)
process.stdout.write(`${JSON.stringify({
  schema: 'eva.daemon-started.v1',
  url: server.url,
})}\n`)

let closing = false
async function close(signal: string): Promise<void> {
  if (closing) return
  closing = true
  process.stdout.write(`${JSON.stringify({ schema: 'eva.daemon-stopped.v1', signal })}\n`)
  await server.close()
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void close(signal).then(() => process.exit(0), (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exit(1)
    })
  })
}
