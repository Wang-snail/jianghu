import { randomBytes } from 'node:crypto'
import type { Router } from '../router'
import * as queries from '../../shared/db-queries'
import { setGlobalModel } from '../../shared/model-provider'

const CUSTOM_MODEL_URL_TEST_TIMEOUT_MS = 8000

function ensureKeeperReferralCode(db: Parameters<typeof queries.getSetting>[0]): string {
  const existing = queries.getSetting(db, 'keeper_referral_code')?.trim()
  if (existing) return existing
  const generated = randomBytes(6).toString('base64url').slice(0, 10)
  queries.setSetting(db, 'keeper_referral_code', generated)
  return generated
}

function normalizeHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const raw = value.trim()
  if (!raw) return null

  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.toString().replace(/\/+$/, '')
  } catch {
    return null
  }
}

async function testHttpReachable(url: string): Promise<number | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), CUSTOM_MODEL_URL_TEST_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
    })
    return response.status
  } finally {
    clearTimeout(timeout)
  }
}

export function registerSettingRoutes(router: Router): void {
  router.get('/api/settings', (ctx) => {
    const settings = queries.getAllSettings(ctx.db)
    return { data: settings }
  })

  router.get('/api/settings/referral', (ctx) => {
    const code = ensureKeeperReferralCode(ctx.db)
    return {
      data: {
        code,
        inviteUrl: `company-local://invite/${encodeURIComponent(code)}`,
        shareUrl: `company-local://share/${encodeURIComponent(code)}`
      }
    }
  })

  router.post('/api/settings/custom-model/test-url', async (ctx) => {
    const body = ctx.body as Record<string, unknown> || {}
    const url = normalizeHttpUrl(body.url)
    if (!url) {
      return { status: 400, error: '请输入有效的 http 或 https API 地址' }
    }

    try {
      const status = await testHttpReachable(url)
      return {
        data: {
          ok: true,
          url,
          status,
          message: status ? `链接可用，服务器返回 HTTP ${status}` : '链接可用'
        }
      }
    } catch (error) {
      const isTimeout = error instanceof Error && error.name === 'AbortError'
      return {
        status: 400,
        error: isTimeout ? '链接测试超时，请检查地址是否可访问' : '无法连接到该 API 地址，请检查链接是否正确'
      }
    }
  })

  router.get('/api/settings/:key', (ctx) => {
    const value = queries.getSetting(ctx.db, ctx.params.key)
    return { data: { key: ctx.params.key, value } }
  })

  router.put('/api/settings/:key', (ctx) => {
    const body = ctx.body as Record<string, unknown> || {}
    if (body.value === undefined) {
      return { status: 400, error: 'value is required' }
    }

    const value = String(body.value)
    if (ctx.params.key === 'global_model' || ctx.params.key === 'clerk_model' || ctx.params.key === 'queen_model') {
      setGlobalModel(ctx.db, value)
    } else {
      queries.setSetting(ctx.db, ctx.params.key, value)
    }
    return { data: { key: ctx.params.key, value } }
  })
}
