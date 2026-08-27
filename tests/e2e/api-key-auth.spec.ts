import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { createEvaTickServer } from '@evatick/server'

async function login(url: string): Promise<string> {
  const response = await fetch(`${url}/admin/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test-api-key-admin-password' }),
  })
  return response.headers.get('set-cookie')?.split(';', 1)[0] ?? ''
}

describe('CLI API key authentication', () => {
  it('creates, persists, verifies, lists, and revokes API keys', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'eva-api-keys-'))
    const apiKeysPath = join(directory, 'api-keys.json')
    const first = await createEvaTickServer({
      adminPassword: 'test-api-key-admin-password',
      apiKeysPath,
      healthCheckIntervalMs: 0,
    })
    let key = ''
    let keyId = ''
    try {
      const unauthorized = await fetch(`${first.url}/v1/health`)
      expect(unauthorized.status).toBe(401)
      expect(await unauthorized.json()).toMatchObject({ code: 'API_KEY_REQUIRED' })

      const cookie = await login(first.url)
      const page = await fetch(`${first.url}/admin/api-keys`, { headers: { cookie } })
      expect(page.status).toBe(200)
      const pageHtml = await page.text()
      expect(pageHtml).toContain('EVA 管理中心')
      expect(pageHtml).toContain('API 密钥')
      expect(pageHtml).not.toContain('<h1')
      expect(pageHtml).toContain('复制')
      expect(pageHtml).toContain('公开访问（免密钥）')

      const created = await fetch(`${first.url}/v1/api-keys`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'integration-test' }),
      })
      expect(created.status).toBe(201)
      const createdBody = await created.json() as { data: { key: string; summary: { id: string } } }
      key = createdBody.data.key
      keyId = createdBody.data.summary.id
      expect(key).toMatch(/^eva_[a-f0-9]{12}_/)

      const accepted = await fetch(`${first.url}/v1/health`, {
        headers: { authorization: `Bearer ${key}` },
      })
      expect(accepted.status).toBe(200)

      const localData = await fetch(
        `${first.url}/v1/local-data/instruments?interval=1d&limit=20&offset=0`,
        { headers: { authorization: `Bearer ${key}` } },
      )
      expect(localData.status).toBe(200)
      expect(await localData.json()).toMatchObject({
        schema: 'eva.local-instrument-list.v1',
        data: [],
        meta: { local_only: true },
      })
      expect(
        (
          await fetch(`${first.url}/v1/local-data/instruments`, {
            headers: { authorization: 'Bearer invalid-key' },
          })
        ).status,
      ).toBe(401)

      const listed = await fetch(`${first.url}/v1/api-keys`, { headers: { cookie } })
      const listedBody = await listed.json()
      expect(listedBody).toMatchObject({
        data: [{ id: keyId, name: 'integration-test' }],
      })
      expect(JSON.stringify(listedBody)).not.toContain(key)

      const revealed = await fetch(`${first.url}/v1/api-keys/${keyId}/secret`, {
        headers: { cookie },
      })
      expect(revealed.status).toBe(200)
      expect(await revealed.json()).toMatchObject({ data: { key } })

      const opened = await fetch(`${first.url}/v1/api-keys/access-mode`, {
        method: 'PUT',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ access_mode: 'public' }),
      })
      expect(opened.status).toBe(200)
      expect(await opened.json()).toMatchObject({ data: { access_mode: 'public' } })
      expect((await fetch(`${first.url}/v1/health`)).status).toBe(200)
      expect((await fetch(`${first.url}/v1/health`, {
        headers: { authorization: 'Bearer an-invalid-key-that-must-be-ignored' },
      })).status).toBe(200)

      const stored = await readFile(apiKeysPath, 'utf8')
      expect(stored).not.toContain(key)
      expect(JSON.parse(stored)).toMatchObject({
        schema: 'eva.api-keys.v3',
        access_mode: 'public',
      })
      expect((await stat(apiKeysPath)).mode & 0o777).toBe(0o600)
      expect((await stat(`${apiKeysPath}.encryption-key`)).mode & 0o777).toBe(0o600)
    } finally {
      await first.close()
    }

    const restarted = await createEvaTickServer({ apiKeysPath, healthCheckIntervalMs: 0 })
    try {
      expect((await fetch(`${restarted.url}/v1/health`)).status).toBe(200)
      expect(await (await fetch(`${restarted.url}/v1/api-keys`)).json()).toMatchObject({
        access_mode: 'public',
      })
      expect((await fetch(`${restarted.url}/v1/api-keys/access-mode`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ access_mode: 'api-key' }),
      })).status).toBe(200)
      expect((await fetch(`${restarted.url}/v1/health`)).status).toBe(401)
      expect((await fetch(`${restarted.url}/v1/health`, {
        headers: { authorization: `Bearer ${key}` },
      })).status).toBe(200)
      expect(await (await fetch(`${restarted.url}/v1/api-keys/${keyId}/secret`)).json())
        .toMatchObject({ data: { key } })

      // Management auth is intentionally disabled in this test-only server instance.
      expect((await fetch(`${restarted.url}/v1/api-keys/${keyId}`, { method: 'DELETE' })).status).toBe(204)
      expect((await fetch(`${restarted.url}/v1/health`, {
        headers: { authorization: `Bearer ${key}` },
      })).status).toBe(401)
    } finally {
      await restarted.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('keeps hash-only keys valid while reporting that their secret cannot be recovered', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'eva-api-keys-v1-'))
    const apiKeysPath = join(directory, 'api-keys.json')
    const legacyKey = 'eva_legacy_test_key'
    const id = randomUUID()
    await writeFile(apiKeysPath, JSON.stringify({
      schema: 'eva.api-keys.v1',
      keys: [{
        id,
        name: 'legacy-key',
        prefix: 'eva_legacy_test_key'.slice(0, 18),
        key_hash: createHash('sha256').update(legacyKey).digest('hex'),
        created_at: new Date().toISOString(),
      }],
    }), { mode: 0o600 })
    const server = await createEvaTickServer({ apiKeysPath, healthCheckIntervalMs: 0 })
    try {
      expect((await fetch(`${server.url}/v1/health`, {
        headers: { authorization: `Bearer ${legacyKey}` },
      })).status).toBe(200)
      expect(await (await fetch(`${server.url}/v1/api-keys`)).json()).toMatchObject({
        data: [{ id, recoverable: false }],
      })
      const reveal = await fetch(`${server.url}/v1/api-keys/${id}/secret`)
      expect(reveal.status).toBe(409)
      expect(await reveal.json()).toMatchObject({ code: 'API_KEY_NOT_RECOVERABLE' })
    } finally {
      await server.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
