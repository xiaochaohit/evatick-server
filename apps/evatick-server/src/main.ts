import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

import { AkshareProvider } from '@evatick/provider-akshare'
import { AmazingDataProvider } from '@evatick/provider-amazingdata'
import { BinanceProvider, CoinbaseProvider } from '@evatick/provider-crypto'
import { HithinkProvider } from '@evatick/provider-hithink'

import {
  assertPythonExecutable,
  configurationPathFromArguments,
  loadEvaDaemonConfiguration,
} from './config.js'
import { createEvaTickServer } from './index.js'

export async function startEvaTickDaemon(configurationPath: string) {
  const configuration = await loadEvaDaemonConfiguration(configurationPath)
  const hithinkApiKey = configuration.providers.hithink
    ? process.env[configuration.providers.hithink.apiKeyEnvironment]
    : undefined
  if (configuration.providers.hithink && !hithinkApiKey) {
    throw new Error(
      `configured HiThink API key environment variable is missing: ${configuration.providers.hithink.apiKeyEnvironment}`,
    )
  }
  const amazingdata = configuration.providers.amazingdata
  const amazingdataEnvironment = amazingdata
    ? {
        username: process.env[amazingdata.usernameEnvironment],
        password: process.env[amazingdata.passwordEnvironment],
        host: process.env[amazingdata.hostEnvironment],
        port: process.env[amazingdata.portEnvironment],
      }
    : undefined
  if (amazingdata && amazingdataEnvironment) {
    for (const [field, value] of Object.entries(amazingdataEnvironment)) {
      if (!value) {
        const environmentName = amazingdata[`${field}Environment` as
          'usernameEnvironment' | 'passwordEnvironment' | 'hostEnvironment' | 'portEnvironment']
        throw new Error(`configured AmazingData environment variable is missing: ${environmentName}`)
      }
    }
    const port = Number(amazingdataEnvironment.port)
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error(`configured AmazingData port environment variable is invalid: ${amazingdata.portEnvironment}`)
    }
  }
  await mkdir(dirname(configuration.storage.catalogPath), { recursive: true })
  await mkdir(dirname(configuration.storage.historyPath), { recursive: true })
  await mkdir(dirname(configuration.storage.dataSourcePreferencesPath), { recursive: true })
  await mkdir(dirname(configuration.admin.credentialsPath), { recursive: true })
  await mkdir(dirname(configuration.admin.apiKeysPath), { recursive: true })
  if (amazingdata) await mkdir(amazingdata.cachePath, { recursive: true })
  if (configuration.providers.akshare) {
    await assertPythonExecutable(configuration.providers.akshare.pythonExecutable)
  }
  if (amazingdata) {
    await assertPythonExecutable(amazingdata.pythonExecutable, 'AmazingData')
  }
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
    providerConcurrency: configuration.server.providerConcurrency,
    healthCheckIntervalMs: configuration.server.healthCheckIntervalSeconds * 1_000,
    healthCheckTimeoutMs: configuration.server.healthCheckTimeoutMs,
  })
  if (configuration.providers.hithink && hithinkApiKey) {
    await server.mountProvider(new HithinkProvider({
      apiKey: hithinkApiKey,
      baseUrl: configuration.providers.hithink.baseUrl,
    }))
  }
  if (amazingdata && amazingdataEnvironment) {
    await server.mountProvider(new AmazingDataProvider({
      pythonExecutable: amazingdata.pythonExecutable,
      username: amazingdataEnvironment.username!,
      password: amazingdataEnvironment.password!,
      host: amazingdataEnvironment.host!,
      port: Number(amazingdataEnvironment.port),
      cachePath: amazingdata.cachePath,
    }))
  }
  if (configuration.providers.akshare) {
    await server.mountProvider(new AkshareProvider({
      pythonExecutable: configuration.providers.akshare.pythonExecutable,
    }))
  }
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
