import { constants } from 'node:fs'
import { access, readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'

export interface EvaDaemonConfiguration {
  schema: 'eva.server-config.v1'
  server: {
    host: string
    port: number
    retryAttempts: number
    requestTimeoutMs: number
    providerConcurrency: number
    healthCheckIntervalSeconds: number
    healthCheckTimeoutMs: number
  }
  storage: {
    catalogPath: string
    historyPath: string
    dataSourcePreferencesPath: string
  }
  admin: {
    username: string
    initialPassword?: string
    credentialsPath: string
    apiKeysPath: string
  }
  providers: {
    akshare: {
      pythonExecutable: string
    }
  }
}

type JsonObject = Record<string, unknown>

function objectAt(value: unknown, path: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be an object`)
  }
  return value as JsonObject
}

function rejectUnknownKeys(value: JsonObject, allowed: readonly string[], path: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unknown.length) throw new Error(`${path} contains unknown field: ${unknown[0]}`)
}

function stringAt(value: unknown, path: string, maximum = 1_024): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum) {
    throw new Error(`${path} must be a non-empty string of at most ${maximum} characters`)
  }
  return value
}

function integerAt(value: unknown, path: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${path} must be an integer between ${minimum} and ${maximum}`)
  }
  return value as number
}

function configuredPath(value: unknown, path: string, configurationDirectory: string): string {
  const configured = stringAt(value, path, 4_096)
  return isAbsolute(configured) ? configured : resolve(configurationDirectory, configured)
}

function parseConfiguration(value: unknown, configurationPath: string): EvaDaemonConfiguration {
  const root = objectAt(value, 'configuration')
  rejectUnknownKeys(root, ['schema', 'server', 'storage', 'admin', 'providers'], 'configuration')
  if (root.schema !== 'eva.server-config.v1') {
    throw new Error('configuration.schema must be eva.server-config.v1')
  }

  const server = objectAt(root.server, 'configuration.server')
  rejectUnknownKeys(server, [
    'host', 'port', 'retryAttempts', 'requestTimeoutMs',
    'providerConcurrency', 'healthCheckIntervalSeconds', 'healthCheckTimeoutMs',
  ], 'configuration.server')
  const storage = objectAt(root.storage, 'configuration.storage')
  rejectUnknownKeys(storage, ['catalogPath', 'historyPath', 'dataSourcePreferencesPath'], 'configuration.storage')
  const admin = objectAt(root.admin, 'configuration.admin')
  rejectUnknownKeys(admin, ['username', 'initialPassword', 'credentialsPath', 'apiKeysPath'], 'configuration.admin')
  const providers = objectAt(root.providers, 'configuration.providers')
  rejectUnknownKeys(providers, ['akshare'], 'configuration.providers')
  const akshare = objectAt(providers.akshare, 'configuration.providers.akshare')
  rejectUnknownKeys(akshare, ['pythonExecutable'], 'configuration.providers.akshare')

  const username = stringAt(admin.username, 'configuration.admin.username', 64).trim()
  const initialPassword = admin.initialPassword
  if (initialPassword !== undefined) {
    if (
      typeof initialPassword !== 'string' ||
      initialPassword.length < 8 ||
      initialPassword.length > 256 ||
      /^<.*>$/.test(initialPassword)
    ) {
      throw new Error('configuration.admin.initialPassword must contain 8 to 256 characters and must not be an example placeholder')
    }
  }

  const configurationDirectory = dirname(configurationPath)
  return {
    schema: 'eva.server-config.v1',
    server: {
      host: stringAt(server.host, 'configuration.server.host', 255),
      port: integerAt(server.port, 'configuration.server.port', 0, 65_535),
      retryAttempts: integerAt(server.retryAttempts, 'configuration.server.retryAttempts', 1, 10),
      requestTimeoutMs: integerAt(server.requestTimeoutMs, 'configuration.server.requestTimeoutMs', 1, 300_000),
      providerConcurrency: integerAt(
        server.providerConcurrency ?? 4,
        'configuration.server.providerConcurrency',
        1,
        64,
      ),
      healthCheckIntervalSeconds: integerAt(server.healthCheckIntervalSeconds, 'configuration.server.healthCheckIntervalSeconds', 0, 86_400),
      healthCheckTimeoutMs: integerAt(server.healthCheckTimeoutMs, 'configuration.server.healthCheckTimeoutMs', 1, 300_000),
    },
    storage: {
      catalogPath: configuredPath(storage.catalogPath, 'configuration.storage.catalogPath', configurationDirectory),
      historyPath: configuredPath(storage.historyPath, 'configuration.storage.historyPath', configurationDirectory),
      dataSourcePreferencesPath: configuredPath(
        storage.dataSourcePreferencesPath ?? './data/data-source-preferences.json',
        'configuration.storage.dataSourcePreferencesPath',
        configurationDirectory,
      ),
    },
    admin: {
      username,
      ...(initialPassword === undefined ? {} : { initialPassword }),
      credentialsPath: configuredPath(admin.credentialsPath, 'configuration.admin.credentialsPath', configurationDirectory),
      apiKeysPath: configuredPath(admin.apiKeysPath ?? './data/api-keys.json', 'configuration.admin.apiKeysPath', configurationDirectory),
    },
    providers: {
      akshare: {
        pythonExecutable: configuredPath(akshare.pythonExecutable, 'configuration.providers.akshare.pythonExecutable', configurationDirectory),
      },
    },
  }
}

async function assertPrivateWhenPasswordConfigured(path: string, configuration: EvaDaemonConfiguration): Promise<void> {
  if (!configuration.admin.initialPassword || process.platform === 'win32') return
  const metadata = await stat(path)
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error('configuration file contains admin.initialPassword and must be owner-only (use chmod 600)')
  }
}

export async function loadEvaDaemonConfiguration(path: string): Promise<EvaDaemonConfiguration> {
  const configurationPath = resolve(path)
  let source: string
  try {
    source = await readFile(configurationPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`configuration file does not exist: ${configurationPath}`)
    }
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch {
    throw new Error(`configuration file is not valid JSON: ${configurationPath}`)
  }
  const configuration = parseConfiguration(parsed, configurationPath)
  await assertPrivateWhenPasswordConfigured(configurationPath, configuration)
  return configuration
}

export async function assertPythonExecutable(path: string): Promise<void> {
  try {
    await access(path, constants.X_OK)
  } catch {
    throw new Error(`configured AKShare Python executable is not executable: ${path}`)
  }
}

export function configurationPathFromArguments(arguments_: readonly string[]): string {
  if (arguments_.length !== 2 || arguments_[0] !== '--config' || !arguments_[1]) {
    throw new Error('usage: evatickd --config <configuration.json>')
  }
  return arguments_[1]
}
