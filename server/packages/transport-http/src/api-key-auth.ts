import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

interface StoredApiKey {
  id: string
  name: string
  prefix: string
  key_hash: string
  created_at: string
}

interface StoredApiKeys {
  schema: 'market.api-keys.v1'
  keys: StoredApiKey[]
}

export interface ApiKeySummary {
  id: string
  name: string
  prefix: string
  created_at: string
}

function problem(reply: FastifyReply, detail: string) {
  return reply.code(401).header('www-authenticate', 'Bearer realm="market-server"')
    .type('application/problem+json').send({
      type: 'https://market-cli.dev/problems/api-key-required',
      title: 'API key required',
      status: 401,
      code: 'API_KEY_REQUIRED',
      detail,
      retryable: false,
      request_id: `req_${randomUUID()}`,
    })
}

function hashKey(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

function extractBearerToken(request: FastifyRequest): string | undefined {
  const authorization = request.headers.authorization
  if (!authorization?.startsWith('Bearer ')) return undefined
  const token = authorization.slice('Bearer '.length).trim()
  return token || undefined
}

export class ApiKeyAuth {
  private keys: StoredApiKey[] = []
  private readonly ready: Promise<void>

  constructor(private readonly storagePath?: string) {
    this.ready = this.initialize()
  }

  get enabled(): boolean {
    return Boolean(this.storagePath)
  }

  async initializeForListen(): Promise<void> {
    await this.ready
  }

  install(app: FastifyInstance): void {
    app.addHook('onRequest', async (request, reply) => {
      if (!this.enabled || !this.isCliPath(request.url.split('?', 1)[0])) return
      await this.ready
      const token = extractBearerToken(request)
      if (token && this.authenticate(token)) return
      return problem(reply, token ? 'The API key is invalid or has been revoked.' : 'Provide an API key using the Authorization: Bearer header.')
    })
  }

  list(): ApiKeySummary[] {
    return this.keys.map(({ key_hash: _hash, ...summary }) => summary)
  }

  async create(name: string): Promise<{ key: string; summary: ApiKeySummary }> {
    await this.ready
    const normalizedName = name.trim()
    if (!normalizedName || normalizedName.length > 80) {
      throw new Error('API key name must contain 1 to 80 characters')
    }
    const id = randomUUID()
    const secret = randomBytes(32).toString('base64url')
    const key = `mk_${id.replaceAll('-', '').slice(0, 12)}_${secret}`
    const stored: StoredApiKey = {
      id,
      name: normalizedName,
      prefix: key.slice(0, 18),
      key_hash: hashKey(key).toString('hex'),
      created_at: new Date().toISOString(),
    }
    this.keys.push(stored)
    await this.persist()
    const { key_hash: _hash, ...summary } = stored
    return { key, summary }
  }

  async revoke(id: string): Promise<boolean> {
    await this.ready
    const next = this.keys.filter((key) => key.id !== id)
    if (next.length === this.keys.length) return false
    this.keys = next
    await this.persist()
    return true
  }

  private isCliPath(path: string): boolean {
    if (!path.startsWith('/v1/')) return false
    return !path.startsWith('/v1/data-sync') &&
      !path.startsWith('/v1/data-sources') &&
      !path.startsWith('/v1/local-data') &&
      !path.startsWith('/v1/api-keys')
  }

  private authenticate(token: string): boolean {
    const candidate = hashKey(token)
    return this.keys.some((key) => {
      const expected = Buffer.from(key.key_hash, 'hex')
      return expected.length === candidate.length && timingSafeEqual(expected, candidate)
    })
  }

  private async initialize(): Promise<void> {
    if (!this.storagePath) return
    try {
      const parsed = JSON.parse(await readFile(this.storagePath, 'utf8')) as StoredApiKeys
      if (parsed.schema !== 'market.api-keys.v1' || !Array.isArray(parsed.keys) ||
          parsed.keys.some((key) => !this.validStoredKey(key))) {
        throw new Error('the API key store is invalid')
      }
      this.keys = parsed.keys
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await this.persist()
    }
  }

  private validStoredKey(value: unknown): value is StoredApiKey {
    if (!value || typeof value !== 'object') return false
    const key = value as Partial<StoredApiKey>
    return typeof key.id === 'string' && typeof key.name === 'string' &&
      typeof key.prefix === 'string' && /^[0-9a-f]{64}$/.test(key.key_hash ?? '') &&
      typeof key.created_at === 'string'
  }

  private async persist(): Promise<void> {
    if (!this.storagePath) return
    await mkdir(dirname(this.storagePath), { recursive: true })
    const temporary = `${this.storagePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    await writeFile(temporary, `${JSON.stringify({ schema: 'market.api-keys.v1', keys: this.keys }, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, this.storagePath)
  }
}
