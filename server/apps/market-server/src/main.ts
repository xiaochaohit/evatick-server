import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

import { AkshareProvider } from '@market-cli/provider-akshare'

import {
  assertPythonExecutable,
  configurationPathFromArguments,
  loadMarketServerConfiguration,
} from './config.js'
import { createMarketServer } from './index.js'

export async function startDefaultMarketServer(configurationPath: string) {
  const configuration = await loadMarketServerConfiguration(configurationPath)
  await mkdir(dirname(configuration.storage.catalogPath), { recursive: true })
  await mkdir(dirname(configuration.storage.historyPath), { recursive: true })
  await mkdir(dirname(configuration.admin.credentialsPath), { recursive: true })
  await mkdir(dirname(configuration.admin.apiKeysPath), { recursive: true })
  await assertPythonExecutable(configuration.providers.akshare.pythonExecutable)
  const server = await createMarketServer({
    host: configuration.server.host,
    port: configuration.server.port,
    catalogPath: configuration.storage.catalogPath,
    historyPath: configuration.storage.historyPath,
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
  return server
}

const configurationPath = configurationPathFromArguments(process.argv.slice(2))
const server = await startDefaultMarketServer(configurationPath)
process.stdout.write(`${JSON.stringify({
  schema: 'market.server-started.v1',
  url: server.url,
})}\n`)

let closing = false
async function close(signal: string): Promise<void> {
  if (closing) return
  closing = true
  process.stdout.write(`${JSON.stringify({ schema: 'market.server-stopped.v1', signal })}\n`)
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
