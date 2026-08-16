import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { MarketCliProvider } from '@market-cli/provider-market-cli'

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

function numberFromEnvironment(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isInteger(value) || value < 0 || value > 65_535) {
    throw new Error(`${name} must be an integer between 0 and 65535`)
  }
  return value
}

export async function startDefaultMarketServer() {
  const catalogPath = process.env.MARKET_SERVER_CATALOG_PATH ??
    join(defaultDataDirectory(), 'catalog.sqlite')
  await mkdir(dirname(catalogPath), { recursive: true })
  const server = await createMarketServer({
    host: process.env.MARKET_SERVER_HOST ?? '127.0.0.1',
    port: numberFromEnvironment('MARKET_SERVER_PORT', 8765),
    catalogPath,
    retryAttempts: numberFromEnvironment('MARKET_SERVER_RETRY_ATTEMPTS', 2),
    requestTimeoutMs: numberFromEnvironment('MARKET_SERVER_REQUEST_TIMEOUT_MS', 30_000),
  })
  await server.mountProvider(new MarketCliProvider({
    executable: process.env.MARKET_SERVER_MARKET_CLI ?? 'market-cli',
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
