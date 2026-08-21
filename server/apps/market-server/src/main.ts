import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { AkshareProvider } from '@market-cli/provider-akshare'

import { createMarketServer } from './index.js'

function defaultDataDirectory(): string {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'market-cli')
  }
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA ?? homedir(), 'market-cli')
  }
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'market-cli')
}

function integerFromEnvironment(
  name: string,
  fallback: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new Error(`${name} must be an integer between 0 and ${maximum}`)
  }
  return value
}

export async function startDefaultMarketServer() {
  const catalogPath = process.env.MARKET_SERVER_CATALOG_PATH ??
    join(defaultDataDirectory(), 'catalog.sqlite')
  const historyPath = process.env.MARKET_SERVER_HISTORY_PATH ??
    join(defaultDataDirectory(), 'market-history.duckdb')
  const adminCredentialsPath = process.env.MARKET_SERVER_ADMIN_CREDENTIALS_PATH ??
    join(defaultDataDirectory(), 'admin-credentials.json')
  await mkdir(dirname(catalogPath), { recursive: true })
  await mkdir(dirname(historyPath), { recursive: true })
  await mkdir(dirname(adminCredentialsPath), { recursive: true })
  const server = await createMarketServer({
    host: process.env.MARKET_SERVER_HOST ?? '127.0.0.1',
    port: integerFromEnvironment('MARKET_SERVER_PORT', 8765, 65_535),
    catalogPath,
    historyPath,
    adminUsername: process.env.MARKET_SERVER_ADMIN_USERNAME ?? 'admin',
    adminPassword: process.env.MARKET_SERVER_ADMIN_PASSWORD,
    adminCredentialsPath,
    retryAttempts: integerFromEnvironment('MARKET_SERVER_RETRY_ATTEMPTS', 2),
    requestTimeoutMs: integerFromEnvironment('MARKET_SERVER_REQUEST_TIMEOUT_MS', 30_000),
    healthCheckIntervalMs: integerFromEnvironment(
      'MARKET_SERVER_HEALTH_CHECK_INTERVAL_SECONDS',
      60,
      86_400,
    ) * 1_000,
    healthCheckTimeoutMs: integerFromEnvironment(
      'MARKET_SERVER_HEALTH_CHECK_TIMEOUT_MS',
      10_000,
    ),
  })
  const providerPython = fileURLToPath(new URL(
    process.platform === 'win32'
      ? '../../../providers/akshare-python/.venv/Scripts/python.exe'
      : '../../../providers/akshare-python/.venv/bin/python',
    import.meta.url,
  ))
  await server.mountProvider(new AkshareProvider({
    pythonExecutable: process.env.MARKET_SERVER_AKSHARE_PYTHON ??
      (existsSync(providerPython) ? providerPython : 'python3'),
  }))
  return server
}

const server = await startDefaultMarketServer()
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
