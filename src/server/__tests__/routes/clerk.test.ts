import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { createTestServer, request, type TestContext } from '../helpers/test-server'
import * as queries from '../../../shared/db-queries'
import * as providerCli from '../../provider-cli'
import * as clerkProfile from '../../clerk-profile'

let ctx: TestContext

beforeAll(async () => {
  ctx = await createTestServer()
})

afterAll(() => {
  ctx.close()
})

beforeEach(() => {
  // Clear clerk messages and relevant settings between tests
  ctx.db.prepare("DELETE FROM clerk_messages").run()
  ctx.db.prepare("DELETE FROM settings WHERE key LIKE 'clerk_%'").run()
  ctx.db.prepare("DELETE FROM settings WHERE key IN ('global_model', 'queen_model')").run()
  delete process.env.MIMO_API_KEY
  delete process.env.OPENAI_API_KEY
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_AUTH_TOKEN
  delete process.env.GEMINI_API_KEY
  // Prevent auto-configure from detecting local CLI installs by default
  vi.spyOn(providerCli, 'probeProviderInstalled').mockReturnValue({ installed: false })
  vi.spyOn(providerCli, 'probeProviderConnected').mockReturnValue(null)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Clerk routes', () => {
  describe('POST /api/clerk/presence', () => {
    it('returns ok and saves clerk_user_last_seen_at', async () => {
      const before = queries.getSetting(ctx.db, 'clerk_user_last_seen_at')
      expect(before).toBeNull()

      const res = await request(ctx, 'POST', '/api/clerk/presence')
      expect(res.status).toBe(200)
      expect((res.body as any).ok).toBe(true)

      const after = queries.getSetting(ctx.db, 'clerk_user_last_seen_at')
      expect(after).toBeTruthy()
      expect(new Date(after!).getTime()).toBeCloseTo(Date.now(), -3)
    })

    it('updates the timestamp on repeated calls', async () => {
      await request(ctx, 'POST', '/api/clerk/presence')
      const first = queries.getSetting(ctx.db, 'clerk_user_last_seen_at')!

      // Small delay to ensure timestamps differ
      await new Promise(r => setTimeout(r, 10))
      await request(ctx, 'POST', '/api/clerk/presence')
      const second = queries.getSetting(ctx.db, 'clerk_user_last_seen_at')!

      expect(new Date(second).getTime()).toBeGreaterThanOrEqual(new Date(first).getTime())
    })
  })

  describe('POST /api/clerk/typing', () => {
    it('returns ok and updates clerk_last_user_message_at', async () => {
      const res = await request(ctx, 'POST', '/api/clerk/typing')
      expect(res.status).toBe(200)
      expect((res.body as any).ok).toBe(true)

      const val = queries.getSetting(ctx.db, 'clerk_last_user_message_at')
      expect(val).toBeTruthy()
    })
  })

  describe('POST /api/clerk/chat', () => {
    it('creates a gang directly when the user clearly asks for one', async () => {
      const before = queries.listRooms(ctx.db).length

      const res = await request(ctx, 'POST', '/api/clerk/chat', {
        message: '新建一个帮派，用于做亚马逊市场分析，注意需要分工序安排弟子'
      })

      expect(res.status).toBe(200)
      const body = res.body as any
      expect(body.response).toContain('已创建')
      expect(body.response).toContain('亚马逊市场分析')
      expect(body.response).toContain('帮主启动工序已建立')

      const rooms = queries.listRooms(ctx.db)
      expect(rooms.length).toBe(before + 1)
      const created = rooms.find((room) => room.goal?.includes('亚马逊市场分析'))
      expect(created?.name).toContain('亚马逊市场分析帮')
      expect(created?.status).toBe('active')
      expect(queries.listTasks(ctx.db, created!.id).map(task => task.name)).toEqual(expect.arrayContaining([
        '启动工序1：目标拆分与验收标准',
        '启动工序2：人员规划与客栈选人',
        '启动工序3：弟子培训与功法配置',
        '启动工序4：协作流程与最小试运行',
      ]))
    })

    it('understands named gang creation without the word 帮派', async () => {
      const before = queries.listRooms(ctx.db).length

      const res = await request(ctx, 'POST', '/api/clerk/chat', {
        message: '新建空调市场分析帮，参考除湿机市场分析的方式做空调市场分析。'
      })

      expect(res.status).toBe(200)
      const body = res.body as any
      expect(body.response).toContain('已创建')
      expect(body.response).toContain('空调市场分析帮')

      const rooms = queries.listRooms(ctx.db)
      expect(rooms.length).toBe(before + 1)
      const created = rooms.find((room) => room.name === '空调市场分析帮')
      expect(created?.goal).toContain('参考除湿机市场分析')
      expect(created?.goal).toContain('空调市场分析')
      expect(created?.status).toBe('active')
    })

    it('asks for a goal before creating a gang when the intent is incomplete', async () => {
      const before = queries.listRooms(ctx.db).length

      const res = await request(ctx, 'POST', '/api/clerk/chat', {
        message: '帮我新建一个帮派'
      })

      expect(res.status).toBe(200)
      const body = res.body as any
      expect(body.response).toContain('委托目标')
      expect(queries.listRooms(ctx.db).length).toBe(before)
    })
  })

  describe('GET /api/clerk/messages', () => {
    it('returns empty array when no messages', async () => {
      const res = await request(ctx, 'GET', '/api/clerk/messages')
      expect(res.status).toBe(200)
      expect(Array.isArray(res.body)).toBe(true)
      expect((res.body as any[]).length).toBe(0)
    })

    it('returns messages after insert', async () => {
      queries.insertClerkMessage(ctx.db, 'user', 'Hello Clerk')
      queries.insertClerkMessage(ctx.db, 'assistant', 'Hello keeper')

      const res = await request(ctx, 'GET', '/api/clerk/messages')
      expect(res.status).toBe(200)
      const msgs = res.body as any[]
      expect(msgs.length).toBe(2)
      expect(msgs[0].role).toBe('user')
      expect(msgs[0].content).toBe('Hello Clerk')
      expect(msgs[1].role).toBe('assistant')
    })

    it('respects limit query param', async () => {
      queries.insertClerkMessage(ctx.db, 'user', 'msg1')
      queries.insertClerkMessage(ctx.db, 'user', 'msg2')
      queries.insertClerkMessage(ctx.db, 'user', 'msg3')

      const res = await request(ctx, 'GET', '/api/clerk/messages?limit=2')
      expect(res.status).toBe(200)
      expect((res.body as any[]).length).toBe(2)
    })
  })

  describe('GET /api/clerk/status', () => {
    it('returns configured=false by default', async () => {
      // Ensure no auto-configuration happens in this test
      const autoConfigSpy = vi.spyOn(clerkProfile, 'autoConfigureClerkModel').mockReturnValue(null)

      const res = await request(ctx, 'GET', '/api/clerk/status')
      expect(res.status).toBe(200)
      const body = res.body as any
      expect(typeof body.configured).toBe('boolean')
      expect(typeof body.commentaryEnabled).toBe('boolean')
      expect(body.commentaryEnabled).toBe(true) // default is enabled
      expect(body.commentaryMode).toBe('auto')
      expect(body.commentaryPace).toBe('light')
      expect(body.model).toBeNull()
      expect(body.apiAuth).toBeDefined()

      autoConfigSpy.mockRestore()
    })

    it('reflects commentaryEnabled=false after setting it', async () => {
      queries.setSetting(ctx.db, 'clerk_commentary_enabled', 'false')

      const res = await request(ctx, 'GET', '/api/clerk/status')
      expect(res.status).toBe(200)
      expect((res.body as any).commentaryEnabled).toBe(false)
    })

    it('reflects commentaryMode=light after setting it', async () => {
      queries.setSetting(ctx.db, 'clerk_commentary_mode', 'light')

      const res = await request(ctx, 'GET', '/api/clerk/status')
      expect(res.status).toBe(200)
      expect((res.body as any).commentaryMode).toBe('light')
      expect((res.body as any).commentaryPace).toBe('light')
    })

    it('switches commentaryPace to active after presence heartbeat', async () => {
      const before = await request(ctx, 'GET', '/api/clerk/status')
      expect(before.status).toBe(200)
      expect((before.body as any).commentaryPace).toBe('light')

      const presence = await request(ctx, 'POST', '/api/clerk/presence')
      expect(presence.status).toBe(200)

      const after = await request(ctx, 'GET', '/api/clerk/status')
      expect(after.status).toBe(200)
      expect((after.body as any).commentaryPace).toBe('active')
    })

    it('treats recent clerk_last_user_message_at as active presence', async () => {
      queries.setSetting(ctx.db, 'clerk_last_user_message_at', new Date().toISOString())

      const res = await request(ctx, 'GET', '/api/clerk/status')
      expect(res.status).toBe(200)
      expect((res.body as any).commentaryPace).toBe('active')
    })

    it('auto-configures claude when CLI is installed', async () => {
      vi.spyOn(providerCli, 'probeProviderInstalled').mockImplementation((p) =>
        p === 'claude' ? { installed: true, version: '1.0.0' } : { installed: false }
      )
      vi.spyOn(providerCli, 'probeProviderConnected').mockImplementation((p) =>
        p === 'claude' ? true : null
      )

      const res = await request(ctx, 'GET', '/api/clerk/status')
      expect(res.status).toBe(200)
      const body = res.body as any
      expect(body.configured).toBe(true)
      expect(body.model).toBe('claude')
      expect(body.autoConfigured).toBe(true)
    })

    it('auto-configures codex when codex CLI is installed and connected', async () => {
      vi.spyOn(providerCli, 'probeProviderInstalled').mockImplementation((p) =>
        p === 'codex' ? { installed: true, version: '1.0.0' } : { installed: false }
      )
      vi.spyOn(providerCli, 'probeProviderConnected').mockImplementation((p) =>
        p === 'codex' ? true : null
      )

      const res = await request(ctx, 'GET', '/api/clerk/status')
      expect(res.status).toBe(200)
      const body = res.body as any
      expect(body.configured).toBe(true)
      expect(body.model).toBe('codex')
      expect(body.autoConfigured).toBe(true)
    })

    it('auto-configures MiMo when MIMO_API_KEY is available', async () => {
      process.env.MIMO_API_KEY = 'mimo-test-key'

      const res = await request(ctx, 'GET', '/api/clerk/status')
      expect(res.status).toBe(200)
      const body = res.body as any
      expect(body.configured).toBe(true)
      expect(body.model).toBe('mimo:MiMo-V2.5-Pro')
      expect(body.autoConfigured).toBe(true)
      expect(body.apiAuth.mimo.ready).toBe(true)
    })

    it('does not auto-configure when model is already set', async () => {
      queries.setSetting(ctx.db, 'clerk_model', 'openai:gpt-4o-mini')
      vi.spyOn(providerCli, 'probeProviderInstalled').mockReturnValue({ installed: true, version: '1.0.0' })

      const res = await request(ctx, 'GET', '/api/clerk/status')
      expect(res.status).toBe(200)
      const body = res.body as any
      expect(body.model).toBe('openai:gpt-4o-mini')
      expect(body.autoConfigured).toBe(false)
    })

    it('persists auto-configured model so second call skips detection', async () => {
      vi.spyOn(providerCli, 'probeProviderInstalled').mockImplementation((p) =>
        p === 'claude' ? { installed: true, version: '1.0.0' } : { installed: false }
      )
      vi.spyOn(providerCli, 'probeProviderConnected').mockImplementation((p) =>
        p === 'claude' ? true : null
      )

      const first = await request(ctx, 'GET', '/api/clerk/status')
      expect((first.body as any).autoConfigured).toBe(true)

      // Second call — model is now in DB, no probing needed
      const probeSpy = vi.spyOn(providerCli, 'probeProviderInstalled').mockReturnValue({ installed: false })
      const second = await request(ctx, 'GET', '/api/clerk/status')
      expect((second.body as any).model).toBe('claude')
      expect((second.body as any).autoConfigured).toBe(false)
      // probeProviderInstalled should NOT have been called since model is set
      expect(probeSpy).not.toHaveBeenCalled()
    })
  })

  describe('PUT /api/clerk/settings', () => {
    it('updates commentaryEnabled', async () => {
      const res = await request(ctx, 'PUT', '/api/clerk/settings', { commentaryEnabled: false })
      expect(res.status).toBe(200)
      expect((res.body as any).commentaryEnabled).toBe(false)

      const stored = queries.getSetting(ctx.db, 'clerk_commentary_enabled')
      expect(stored).toBe('false')
    })

    it('re-enables commentaryEnabled', async () => {
      queries.setSetting(ctx.db, 'clerk_commentary_enabled', 'false')

      const res = await request(ctx, 'PUT', '/api/clerk/settings', { commentaryEnabled: true })
      expect(res.status).toBe(200)
      expect((res.body as any).commentaryEnabled).toBe(true)
    })

    it('updates commentaryMode', async () => {
      const res = await request(ctx, 'PUT', '/api/clerk/settings', { commentaryMode: 'light' })
      expect(res.status).toBe(200)
      expect((res.body as any).commentaryMode).toBe('light')

      const stored = queries.getSetting(ctx.db, 'clerk_commentary_mode')
      expect(stored).toBe('light')
    })

    it('rejects invalid commentaryMode', async () => {
      const res = await request(ctx, 'PUT', '/api/clerk/settings', { commentaryMode: 'fast' })
      expect(res.status).toBe(400)
      expect(String((res.body as any).error || '')).toContain('commentaryMode')
    })

    it('updates model', async () => {
      const res = await request(ctx, 'PUT', '/api/clerk/settings', { model: 'claude' })
      expect(res.status).toBe(200)
      expect((res.body as any).model).toBe('claude')

      expect(queries.getSetting(ctx.db, 'global_model')).toBe('claude')
      expect(queries.getSetting(ctx.db, 'clerk_model')).toBe('claude')
      expect(queries.getSetting(ctx.db, 'queen_model')).toBe('claude')
    })

    it('accepts empty body without error', async () => {
      const res = await request(ctx, 'PUT', '/api/clerk/settings', {})
      expect(res.status).toBe(200)
    })
  })

  describe('POST /api/clerk/reset', () => {
    it('clears messages and session', async () => {
      queries.insertClerkMessage(ctx.db, 'user', 'something')
      queries.setSetting(ctx.db, 'clerk_session_id', 'abc123')

      const res = await request(ctx, 'POST', '/api/clerk/reset')
      expect(res.status).toBe(200)
      expect((res.body as any).ok).toBe(true)

      const messages = queries.listClerkMessages(ctx.db)
      expect(messages.length).toBe(0)

      const sessionId = queries.getSetting(ctx.db, 'clerk_session_id')
      expect(sessionId).toBeFalsy()
    })
  })

  describe('GET /api/clerk/usage', () => {
    it('returns usage stats', async () => {
      const res = await request(ctx, 'GET', '/api/clerk/usage')
      expect(res.status).toBe(200)
      const body = res.body as any
      expect(body.total).toBeDefined()
      expect(body.today).toBeDefined()
      expect(body.bySource).toBeDefined()
      expect(body.bySource.chat).toBeDefined()
      expect(body.bySource.commentary).toBeDefined()
    })
  })
})
