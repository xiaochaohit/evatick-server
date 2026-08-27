import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

interface StoredApiKey {
  id: string
  name: string
  prefix: string
  key_hash: string
  key_ciphertext?: string
  key_iv?: string
  key_tag?: string
  created_at: string
}

interface StoredApiKeys {
  schema: 'eva.api-keys.v1' | 'eva.api-keys.v2' | 'eva.api-keys.v3'
  keys: StoredApiKey[]
  access_mode?: ApiAccessMode
}

export type ApiAccessMode = 'api-key' | 'public'

export interface ApiKeySummary {
  id: string
  name: string
  prefix: string
  created_at: string
  recoverable: boolean
}

function problem(reply: FastifyReply, detail: string) {
  return reply.code(401).header('www-authenticate', 'Bearer realm="eva"')
    .type('application/problem+json').send({
      type: 'urn:eva:problem:api-key-required',
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

async function assertOwnerOnly(path: string, label: string): Promise<void> {
  if (process.platform === 'win32') return
  if ((await stat(path)).mode & 0o077) {
    throw new Error(`${label} must be owner-only (use chmod 600)`)
  }
}

export class ApiKeyAuth {
  private keys: StoredApiKey[] = []
  private configuredAccessMode: ApiAccessMode = 'api-key'
  private encryptionKey: Buffer | undefined
  private readonly ready: Promise<void>

  constructor(private readonly storagePath?: string) {
    this.ready = this.initialize()
  }

  get enabled(): boolean {
    return Boolean(this.storagePath)
  }

  get accessMode(): ApiAccessMode {
    return this.enabled ? this.configuredAccessMode : 'public'
  }

  async initializeForListen(): Promise<void> {
    await this.ready
  }

  install(app: FastifyInstance): void {
    app.addHook('onRequest', async (request, reply) => {
      const path = request.url.split('?', 1)[0]
      const localDataWithBearer =
        path.startsWith('/v1/local-data') && Boolean(extractBearerToken(request))
      if (!this.enabled || (!this.isCliPath(path) && !localDataWithBearer))
        return
      await this.ready
      if (this.configuredAccessMode === 'public') return
      const token = extractBearerToken(request)
      if (token && this.authenticate(token)) return
      return problem(reply, token ? 'The API key is invalid or has been revoked.' : 'Provide an API key using the Authorization: Bearer header.')
    })
  }

  list(): ApiKeySummary[] {
    return this.keys.map((key) => this.summary(key))
  }

  async create(name: string): Promise<{ key: string; summary: ApiKeySummary }> {
    await this.ready
    const normalizedName = name.trim()
    if (!normalizedName || normalizedName.length > 80) {
      throw new Error('API key name must contain 1 to 80 characters')
    }
    const id = randomUUID()
    const secret = randomBytes(32).toString('base64url')
    const key = `eva_${id.replaceAll('-', '').slice(0, 12)}_${secret}`
    const stored: StoredApiKey = {
      id,
      name: normalizedName,
      prefix: key.slice(0, 18),
      key_hash: hashKey(key).toString('hex'),
      ...this.encrypt(key),
      created_at: new Date().toISOString(),
    }
    this.keys.push(stored)
    await this.persist()
    return { key, summary: this.summary(stored) }
  }

  async setAccessMode(accessMode: ApiAccessMode): Promise<void> {
    await this.ready
    this.configuredAccessMode = accessMode
    await this.persist()
  }

  async reveal(id: string): Promise<{ found: boolean; key?: string }> {
    await this.ready
    const stored = this.keys.find((key) => key.id === id)
    if (!stored) return { found: false }
    if (!stored.key_ciphertext || !stored.key_iv || !stored.key_tag || !this.encryptionKey) {
      return { found: true }
    }
    const decipher = createDecipheriv(
      'aes-256-gcm', this.encryptionKey, Buffer.from(stored.key_iv, 'base64url'),
    )
    decipher.setAuthTag(Buffer.from(stored.key_tag, 'base64url'))
    return {
      found: true,
      key: Buffer.concat([
        decipher.update(Buffer.from(stored.key_ciphertext, 'base64url')),
        decipher.final(),
      ]).toString('utf8'),
    }
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

  private summary(key: StoredApiKey): ApiKeySummary {
    return {
      id: key.id,
      name: key.name,
      prefix: key.prefix,
      created_at: key.created_at,
      recoverable: Boolean(key.key_ciphertext && key.key_iv && key.key_tag),
    }
  }

  private encrypt(value: string): Pick<StoredApiKey, 'key_ciphertext' | 'key_iv' | 'key_tag'> {
    if (!this.encryptionKey) throw new Error('API key encryption is not initialized')
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv)
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return {
      key_ciphertext: ciphertext.toString('base64url'),
      key_iv: iv.toString('base64url'),
      key_tag: cipher.getAuthTag().toString('base64url'),
    }
  }

  private async initialize(): Promise<void> {
    if (!this.storagePath) return
    this.encryptionKey = await this.loadEncryptionKey()
    try {
      await assertOwnerOnly(this.storagePath, 'the API key store')
      const parsed = JSON.parse(await readFile(this.storagePath, 'utf8')) as StoredApiKeys
      if (!['eva.api-keys.v1', 'eva.api-keys.v2', 'eva.api-keys.v3'].includes(parsed.schema) ||
          !Array.isArray(parsed.keys) ||
          (parsed.schema === 'eva.api-keys.v3' && !['api-key', 'public'].includes(parsed.access_mode ?? '')) ||
          parsed.keys.some((key) => !this.validStoredKey(key))) {
        throw new Error('the API key store is invalid')
      }
      this.keys = parsed.keys
      this.configuredAccessMode = parsed.schema === 'eva.api-keys.v3'
        ? parsed.access_mode!
        : 'api-key'
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await this.persist()
    }
  }

  private validStoredKey(value: unknown): value is StoredApiKey {
    if (!value || typeof value !== 'object') return false
    const key = value as Partial<StoredApiKey>
    const encryptedFields = [key.key_ciphertext, key.key_iv, key.key_tag]
    const validEncryption = encryptedFields.every((field) => field === undefined) ||
      encryptedFields.every((field) => typeof field === 'string' && field.length > 0)
    return typeof key.id === 'string' && typeof key.name === 'string' &&
      typeof key.prefix === 'string' && /^[0-9a-f]{64}$/.test(key.key_hash ?? '') &&
      typeof key.created_at === 'string' && validEncryption
  }

  private async loadEncryptionKey(): Promise<Buffer> {
    const path = `${this.storagePath}.encryption-key`
    await mkdir(dirname(path), { recursive: true })
    try {
      await assertOwnerOnly(path, 'the API key encryption key')
      const key = await readFile(path)
      if (key.length !== 32) throw new Error('the API key encryption key is invalid')
      return key
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const key = randomBytes(32)
      try {
        await writeFile(path, key, { mode: 0o600, flag: 'wx' })
        return key
      } catch (writeError) {
        if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError
        const existing = await readFile(path)
        if (existing.length !== 32) throw new Error('the API key encryption key is invalid')
        return existing
      }
    }
  }

  private async persist(): Promise<void> {
    if (!this.storagePath) return
    await mkdir(dirname(this.storagePath), { recursive: true })
    const temporary = `${this.storagePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    await writeFile(temporary, `${JSON.stringify({
      schema: 'eva.api-keys.v3',
      access_mode: this.configuredAccessMode,
      keys: this.keys,
    }, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, this.storagePath)
  }
}
