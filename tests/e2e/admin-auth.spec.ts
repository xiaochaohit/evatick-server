import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { createEvaTickServer } from '@evatick/server'

const initialPassword = 'test-initial-password'
const changedPassword = 'test-changed-password'

async function login(
  url: string,
  password: string,
): Promise<{ response: Response; cookie: string }> {
  const response = await fetch(`${url}/admin/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password }),
  })
  return {
    response,
    cookie: response.headers.get('set-cookie')?.split(';', 1)[0] ?? '',
  }
}

describe('management console authentication', () => {
  it('requires login for management pages and console-facing APIs', async () => {
    const server = await createEvaTickServer({
      adminPassword: initialPassword,
      healthCheckIntervalMs: 0,
    })
    try {
      const page = await fetch(`${server.url}/admin/data-sync`, { redirect: 'manual' })
      expect(page.status).toBe(302)
      expect(page.headers.get('location')).toContain('/admin/login?next=')

      const loginPage = await fetch(`${server.url}/admin/login`)
      expect(loginPage.status).toBe(200)
      const loginHtml = await loginPage.text()
      expect(loginHtml).toContain('EVA 管理中心')
      expect(loginHtml).toContain('登录管理后台')

      const api = await fetch(`${server.url}/v1/data-sync`)
      expect(api.status).toBe(401)
      expect(await api.json()).toMatchObject({ code: 'ADMIN_AUTH_REQUIRED' })

      const rejected = await login(server.url, 'test-wrong-password')
      expect(rejected.response.status).toBe(401)
      expect(rejected.cookie).toBe('')

      const accepted = await login(server.url, initialPassword)
      expect(accepted.response.status).toBe(200)
      expect(accepted.cookie).toMatch(/^eva_admin_session=/)

      const protectedPage = await fetch(`${server.url}/admin/data-sync`, {
        headers: { cookie: accepted.cookie },
      })
      expect(protectedPage.status).toBe(200)
      const protectedHtml = await protectedPage.text()
      expect(protectedHtml).toContain('EVA 管理中心')
      expect(protectedHtml).toContain('修改密码')

      const protectedApi = await fetch(`${server.url}/v1/data-sync`, {
        headers: { cookie: accepted.cookie },
      })
      expect(protectedApi.status).toBe(200)
    } finally {
      await server.close()
    }
  })

  it('rejects passwords shorter than eight characters', async () => {
    await expect(createEvaTickServer({
      adminPassword: 'short7!',
      healthCheckIntervalMs: 0,
    })).rejects.toThrow('8 to 256 characters')
  })

  it('changes the password, invalidates other sessions, and persists only a hash', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'eva-admin-auth-'))
    const credentialsPath = join(directory, 'admin-credentials.json')
    const first = await createEvaTickServer({
      adminPassword: initialPassword,
      adminCredentialsPath: credentialsPath,
      healthCheckIntervalMs: 0,
    })
    try {
      const firstSession = await login(first.url, initialPassword)
      const otherSession = await login(first.url, initialPassword)
      expect(firstSession.response.status).toBe(200)
      expect(otherSession.response.status).toBe(200)

      const changed = await fetch(`${first.url}/admin/password`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          cookie: firstSession.cookie,
        },
        body: JSON.stringify({
          current_password: initialPassword,
          new_password: changedPassword,
        }),
      })
      expect(changed.status).toBe(200)
      expect(changed.headers.get('set-cookie')).toContain('eva_admin_session=')

      const invalidated = await fetch(`${first.url}/v1/data-sync`, {
        headers: { cookie: otherSession.cookie },
      })
      expect(invalidated.status).toBe(401)
      expect((await login(first.url, initialPassword)).response.status).toBe(401)
      expect((await login(first.url, changedPassword)).response.status).toBe(200)

      const credentialFile = await readFile(credentialsPath, 'utf8')
      expect(credentialFile).not.toContain(initialPassword)
      expect(credentialFile).not.toContain(changedPassword)
      expect(JSON.parse(credentialFile)).toMatchObject({
        schema: 'eva.admin-credentials.v1',
        username: 'admin',
        password_version: 2,
      })
      expect((await stat(credentialsPath)).mode & 0o777).toBe(0o600)
    } finally {
      await first.close()
    }

    const restarted = await createEvaTickServer({
      adminCredentialsPath: credentialsPath,
      healthCheckIntervalMs: 0,
    })
    try {
      expect((await login(restarted.url, changedPassword)).response.status).toBe(200)
    } finally {
      await restarted.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
