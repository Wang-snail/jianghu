import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { createTestServer, request, type TestContext } from '../helpers/test-server'

let ctx: TestContext

beforeAll(async () => {
  ctx = await createTestServer()
})

afterAll(() => {
  ctx.close()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Settings routes', () => {
  describe('POST /api/settings/custom-model/test-url', () => {
    it('reports a reachable API URL even when the server returns an auth status', async () => {
      const fetchMock = vi.fn(async () => ({ status: 401 }) as Response)
      vi.stubGlobal('fetch', fetchMock)

      const res = await request(ctx, 'POST', '/api/settings/custom-model/test-url', {
        url: 'https://api.example.com/v1/'
      })

      expect(res.status).toBe(200)
      expect((res.body as any).ok).toBe(true)
      expect((res.body as any).status).toBe(401)
      expect((res.body as any).url).toBe('https://api.example.com/v1')
      expect(fetchMock).toHaveBeenCalledWith('https://api.example.com/v1', expect.objectContaining({ method: 'GET' }))
    })

    it('rejects invalid API URLs', async () => {
      const res = await request(ctx, 'POST', '/api/settings/custom-model/test-url', {
        url: 'file:///tmp/model'
      })

      expect(res.status).toBe(400)
    })
  })

  describe('PUT /api/settings/:key', () => {
    it('sets a setting', async () => {
      const res = await request(ctx, 'PUT', '/api/settings/theme', {
        value: 'dark'
      })
      expect(res.status).toBe(200)
      expect((res.body as any).key).toBe('theme')
      expect((res.body as any).value).toBe('dark')
    })

    it('sets model settings as one global model', async () => {
      const res = await request(ctx, 'PUT', '/api/settings/global_model', {
        value: 'codex'
      })

      expect(res.status).toBe(200)
      expect((res.body as any).value).toBe('codex')

      const global = await request(ctx, 'GET', '/api/settings/global_model')
      const clerk = await request(ctx, 'GET', '/api/settings/clerk_model')
      const queen = await request(ctx, 'GET', '/api/settings/queen_model')

      expect((global.body as any).value).toBe('codex')
      expect((clerk.body as any).value).toBe('codex')
      expect((queen.body as any).value).toBe('codex')
    })

    it('returns 400 if value missing', async () => {
      const res = await request(ctx, 'PUT', '/api/settings/broken', {})
      expect(res.status).toBe(400)
    })
  })

  describe('GET /api/settings/:key', () => {
    it('gets a setting', async () => {
      await request(ctx, 'PUT', '/api/settings/lang', { value: 'en' })

      const res = await request(ctx, 'GET', '/api/settings/lang')
      expect(res.status).toBe(200)
      expect((res.body as any).key).toBe('lang')
      expect((res.body as any).value).toBe('en')
    })

    it('returns null for missing key', async () => {
      const res = await request(ctx, 'GET', '/api/settings/nonexistent')
      expect(res.status).toBe(200)
      expect((res.body as any).value).toBeNull()
    })
  })

  describe('GET /api/settings', () => {
    it('lists all settings as key-value object', async () => {
      await request(ctx, 'PUT', '/api/settings/a', { value: '1' })
      await request(ctx, 'PUT', '/api/settings/b', { value: '2' })

      const res = await request(ctx, 'GET', '/api/settings')
      expect(res.status).toBe(200)
      expect(typeof res.body).toBe('object')
      expect((res.body as any).a).toBe('1')
      expect((res.body as any).b).toBe('2')
    })
  })
})
