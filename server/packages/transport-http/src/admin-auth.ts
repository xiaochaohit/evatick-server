import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { promisify } from 'node:util'

import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from 'fastify'

import { adminLoginHtml, adminPasswordHtml } from './admin-auth-pages.js'

const scrypt = promisify(scryptCallback)
const sessionCookie = 'market_admin_session'
const minimumPasswordLength = 12
const maximumPasswordLength = 256

interface StoredCredentials {
  schema: 'market.admin-credentials.v1'
  username: string
  salt: string
  password_hash: string
  password_version: number
}

interface Session {
  expiresAt: number
  passwordVersion: number
}

interface LoginAttempt {
  failures: number
  blockedUntil: number
}

export interface AdminAuthOptions {
  username?: string
  initialPassword?: string
  credentialsPath?: string
  sessionTtlMs?: number
}

function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>()
  for (const pair of header?.split(';') ?? []) {
    const separator = pair.indexOf('=')
    if (separator < 1) continue
    cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim())
  }
  return cookies
}

function sessionCookieHeader(token: string, request: FastifyRequest): string {
  const secure = request.protocol === 'https' ? '; Secure' : ''
  return `${sessionCookie}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${secure}`
}

function expiredSessionCookieHeader(request: FastifyRequest): string {
  const secure = request.protocol === 'https' ? '; Secure' : ''
  return `${sessionCookie}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`
}

function safeAdminPath(value: unknown, fallback = '/admin/data-sources'): string {
  return typeof value === 'string' && value.startsWith('/admin') && !value.startsWith('//')
    ? value
    : fallback
}

function problem(reply: FastifyReply, status: 400 | 401 | 429, code: string, detail: string) {
  return reply.code(status).type('application/problem+json').send({
    type: `https://market-cli.dev/problems/${code.toLowerCase().replaceAll('_', '-')}`,
    title: status === 401 ? 'Authentication required' : status === 429 ? 'Too many attempts' : 'Invalid request',
    status,
    code,
    detail,
    retryable: false,
  })
}

export class AdminAuth {
  private credentials: StoredCredentials | undefined
  private readonly sessions = new Map<string, Session>()
  private readonly attempts = new Map<string, LoginAttempt>()
  private readonly ready: Promise<void>

  constructor(private readonly options: AdminAuthOptions = {}) {
    this.ready = this.initialize()
  }

  get enabled(): boolean {
    return Boolean(this.options.initialPassword || this.options.credentialsPath)
  }

  async initializeForListen(): Promise<void> {
    await this.ready
  }

  install(app: FastifyInstance): void {
    app.addHook('onRequest', async (request, reply) => {
      if (!this.enabled) return
      await this.ready
      const path = request.url.split('?', 1)[0]
      if (!this.isProtectedPath(path)) return
      if (this.authenticate(request)) return
      if (path.startsWith('/admin')) {
        return reply.redirect(`/admin/login?next=${encodeURIComponent(request.url)}`)
      }
      return problem(reply, 401, 'ADMIN_AUTH_REQUIRED', 'Sign in to the management console first.')
    })

    app.get<{ Querystring: { next?: string } }>('/admin/login', async (request, reply) => {
      await this.ready
      if (!this.enabled) return reply.redirect(safeAdminPath(request.query.next))
      if (this.authenticate(request)) return reply.redirect(safeAdminPath(request.query.next))
      return reply
        .header('cache-control', 'no-store')
        .header('x-frame-options', 'DENY')
        .type('text/html; charset=utf-8')
        .send(adminLoginHtml(safeAdminPath(request.query.next)))
    })

    app.post<{
      Body: { username?: string; password?: string; next?: string }
    }>('/admin/session', async (request, reply) => {
      await this.ready
      if (!this.enabled || !this.credentials) {
        return problem(reply, 400, 'ADMIN_AUTH_DISABLED', 'Administrative authentication is not configured.')
      }
      const key = request.ip
      const attempt = this.attempts.get(key)
      if (attempt && attempt.blockedUntil > Date.now()) {
        reply.header('retry-after', String(Math.ceil((attempt.blockedUntil - Date.now()) / 1000)))
        return problem(reply, 429, 'LOGIN_RATE_LIMITED', 'Too many failed attempts. Try again later.')
      }
      const username = typeof request.body?.username === 'string' ? request.body.username : ''
      const password = typeof request.body?.password === 'string' ? request.body.password : ''
      if (!await this.verify(username, password)) {
        this.recordFailure(key)
        return problem(reply, 401, 'INVALID_ADMIN_CREDENTIALS', 'The username or password is incorrect.')
      }
      this.attempts.delete(key)
      const token = this.createSession()
      return reply
        .header('cache-control', 'no-store')
        .header('set-cookie', sessionCookieHeader(token, request))
        .send({ schema: 'market.admin-session.v1', data: { next: safeAdminPath(request.body.next) } })
    })

    app.delete('/admin/session', async (request, reply) => {
      const token = parseCookies(request.headers.cookie).get(sessionCookie)
      if (token) this.sessions.delete(token)
      return reply
        .header('cache-control', 'no-store')
        .header('set-cookie', expiredSessionCookieHeader(request))
        .code(204)
        .send()
    })

    app.get('/admin/password', async (_request, reply) => reply
      .header('cache-control', 'no-store')
      .header('x-frame-options', 'DENY')
      .type('text/html; charset=utf-8')
      .send(adminPasswordHtml))

    app.put<{
      Body: { current_password?: string; new_password?: string }
    }>('/admin/password', async (request, reply) => {
      const currentPassword = request.body?.current_password
      const newPassword = request.body?.new_password
      if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
        return problem(reply, 400, 'INVALID_PASSWORD_CHANGE', 'Current and new passwords are required.')
      }
      if (newPassword.length < minimumPasswordLength || newPassword.length > maximumPasswordLength) {
        return problem(reply, 400, 'INVALID_NEW_PASSWORD', `The new password must contain ${minimumPasswordLength} to ${maximumPasswordLength} characters.`)
      }
      if (!await this.verify(this.credentials?.username ?? '', currentPassword)) {
        return problem(reply, 401, 'INVALID_CURRENT_PASSWORD', 'The current password is incorrect.')
      }
      await this.replacePassword(newPassword)
      const token = this.createSession()
      return reply
        .header('cache-control', 'no-store')
        .header('set-cookie', sessionCookieHeader(token, request))
        .send({ schema: 'market.admin-password.v1', data: { changed: true } })
    })
  }

  private isProtectedPath(path: string): boolean {
    if (path === '/admin/login' || path === '/admin/session') return false
    return path.startsWith('/admin') ||
      path.startsWith('/v1/data-sync') ||
      path.startsWith('/v1/data-sources') ||
      path.startsWith('/v1/local-data')
  }

  private authenticate(request: FastifyRequest): boolean {
    const token = parseCookies(request.headers.cookie).get(sessionCookie)
    if (!token) return false
    const session = this.sessions.get(token)
    if (!session || session.expiresAt <= Date.now() || session.passwordVersion !== this.credentials?.password_version) {
      this.sessions.delete(token)
      return false
    }
    return true
  }

  private async initialize(): Promise<void> {
    if (!this.enabled) return
    if (this.options.credentialsPath) {
      try {
        const parsed = JSON.parse(await readFile(this.options.credentialsPath, 'utf8')) as StoredCredentials
        if (
          parsed.schema !== 'market.admin-credentials.v1' ||
          typeof parsed.username !== 'string' ||
          typeof parsed.salt !== 'string' ||
          typeof parsed.password_hash !== 'string' ||
          !Number.isInteger(parsed.password_version)
        ) {
          throw new Error('the admin credential file is invalid')
        }
        this.credentials = parsed
        return
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    if (!this.options.initialPassword) {
      throw new Error('configuration.admin.initialPassword is required when initializing admin authentication')
    }
    if (this.options.initialPassword.length < minimumPasswordLength || this.options.initialPassword.length > maximumPasswordLength) {
      throw new Error(`configuration.admin.initialPassword must contain ${minimumPasswordLength} to ${maximumPasswordLength} characters`)
    }
    const username = this.options.username?.trim() || 'admin'
    if (username.length > 64) throw new Error('configuration.admin.username must contain at most 64 characters')
    this.credentials = await this.hashPassword(username, this.options.initialPassword, 1)
    await this.persist()
  }

  private async verify(username: string, password: string): Promise<boolean> {
    const credentials = this.credentials
    if (!credentials) return false
    const candidatePassword = password.length <= maximumPasswordLength ? password : ''
    const candidate = await scrypt(candidatePassword, Buffer.from(credentials.salt, 'base64url'), 32) as Buffer
    const expected = Buffer.from(credentials.password_hash, 'base64url')
    const usernameMatches = username === credentials.username
    return password.length <= maximumPasswordLength &&
      expected.length === candidate.length &&
      timingSafeEqual(expected, candidate) &&
      usernameMatches
  }

  private createSession(): string {
    const token = randomBytes(32).toString('base64url')
    this.sessions.set(token, {
      expiresAt: Date.now() + Math.max(this.options.sessionTtlMs ?? 12 * 60 * 60 * 1000, 60_000),
      passwordVersion: this.credentials!.password_version,
    })
    return token
  }

  private recordFailure(key: string): void {
    const current = this.attempts.get(key)
    const failures = (current?.blockedUntil ?? 0) > Date.now() ? current!.failures : (current?.failures ?? 0) + 1
    this.attempts.set(key, {
      failures,
      blockedUntil: failures >= 5 ? Date.now() + 15 * 60 * 1000 : 0,
    })
  }

  private async replacePassword(password: string): Promise<void> {
    const current = this.credentials!
    this.credentials = await this.hashPassword(current.username, password, current.password_version + 1)
    await this.persist()
    this.sessions.clear()
  }

  private async hashPassword(username: string, password: string, passwordVersion: number): Promise<StoredCredentials> {
    const salt = randomBytes(16)
    const hash = await scrypt(password, salt, 32) as Buffer
    return {
      schema: 'market.admin-credentials.v1',
      username,
      salt: salt.toString('base64url'),
      password_hash: hash.toString('base64url'),
      password_version: passwordVersion,
    }
  }

  private async persist(): Promise<void> {
    if (!this.options.credentialsPath || !this.credentials) return
    const path = this.options.credentialsPath
    await mkdir(dirname(path), { recursive: true })
    const temporaryPath = `${path}.${randomBytes(8).toString('hex')}.tmp`
    await writeFile(temporaryPath, `${JSON.stringify(this.credentials, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    await rename(temporaryPath, path)
  }
}
