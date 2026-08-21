import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { createMarketServer } from '@market-cli/server'

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
    const directory = await mkdtemp(join(tmpdir(), 'market-api-keys-'))
    const apiKeysPath = join(directory, 'api-keys.json')
    const first = await createMarketServer({
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
      expect(await page.text()).toContain('API 密钥')

      const created = await fetch(`${first.url}/v1/api-keys`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'integration-test' }),
      })
      expect(created.status).toBe(201)
      const createdBody = await created.json() as { data: { key: string; summary: { id: string } } }
      key = createdBody.data.key
      keyId = createdBody.data.summary.id
      expect(key).toMatch(/^mk_[a-f0-9]{12}_/)

      const accepted = await fetch(`${first.url}/v1/health`, {
        headers: { authorization: `Bearer ${key}` },
      })
      expect(accepted.status).toBe(200)

      const listed = await fetch(`${first.url}/v1/api-keys`, { headers: { cookie } })
      const listedBody = await listed.json()
      expect(listedBody).toMatchObject({
        data: [{ id: keyId, name: 'integration-test' }],
      })
      expect(JSON.stringify(listedBody)).not.toContain(key)

      const stored = await readFile(apiKeysPath, 'utf8')
      expect(stored).not.toContain(key)
      expect(JSON.parse(stored)).toMatchObject({ schema: 'market.api-keys.v1' })
      expect((await stat(apiKeysPath)).mode & 0o777).toBe(0o600)
    } finally {
      await first.close()
    }

    const restarted = await createMarketServer({ apiKeysPath, healthCheckIntervalMs: 0 })
    try {
      expect((await fetch(`${restarted.url}/v1/health`, {
        headers: { authorization: `Bearer ${key}` },
      })).status).toBe(200)

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
})
