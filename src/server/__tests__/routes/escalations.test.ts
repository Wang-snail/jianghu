import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestServer, request, type TestContext } from '../helpers/test-server'
import * as queries from '../../../shared/db-queries'

let ctx: TestContext

beforeAll(async () => {
  ctx = await createTestServer()
})

afterAll(() => {
  ctx.close()
})

describe('Escalation routes', () => {
  it('creates a trackable training record when a user trains a disciple', async () => {
    const room = queries.createRoom(ctx.db, '训练测试帮', '验证训练记录是否可追踪')
    const worker = queries.createWorker(ctx.db, {
      name: '情报采集弟子',
      role: '情报采集',
      systemPrompt: '收集情报并输出可验证结果。',
      roomId: room.id,
    })

    const res = await request(ctx, 'POST', `/api/rooms/${room.id}/escalations`, {
      fromAgentId: null,
      toAgentId: worker.id,
      question: '弟子训练：情报采集弟子\n收到的信息需要做真实性判断',
    })

    expect(res.status).toBe(201)
    const escalation = res.body as any
    const adjustments = queries.listTrainingAdjustments(ctx.db, room.id)
    expect(adjustments).toHaveLength(1)
    expect(adjustments[0]).toMatchObject({
      escalationId: escalation.id,
      workerId: worker.id,
      status: 'queued',
      progress: 15,
    })
    expect(adjustments[0].note).toContain('训练意见已送达')
  })

  it('marks a training record absorbed when the disciple replies with a result', async () => {
    const room = queries.createRoom(ctx.db, '训练结果帮', '验证训练结果是否回写')
    const worker = queries.createWorker(ctx.db, {
      name: '事实核验弟子',
      role: '事实核验',
      systemPrompt: '核验证据。',
      roomId: room.id,
    })
    const createRes = await request(ctx, 'POST', `/api/rooms/${room.id}/escalations`, {
      fromAgentId: null,
      toAgentId: worker.id,
      question: '弟子训练：事实核验弟子\n以后输出必须标注证据来源',
    })
    const escalation = createRes.body as any

    const resolveRes = await request(ctx, 'POST', `/api/escalations/${escalation.id}/resolve`, {
      answer: '已吸收：后续输出会增加来源、判断依据和不确定项。',
    })

    expect(resolveRes.status).toBe(200)
    const adjustments = queries.listTrainingAdjustments(ctx.db, room.id)
    expect(adjustments[0]).toMatchObject({
      escalationId: escalation.id,
      workerId: worker.id,
      status: 'absorbed',
      progress: 100,
    })
    expect(adjustments[0].note).toContain('后续输出会增加来源')
  })

  it('backfills older training messages when the training camp is opened', async () => {
    const room = queries.createRoom(ctx.db, '旧训练帮', '补登记旧训练')
    const worker = queries.createWorker(ctx.db, {
      name: '旧弟子',
      role: '资料整理',
      systemPrompt: '整理资料。',
      roomId: room.id,
    })
    const old = queries.createEscalation(
      ctx.db,
      room.id,
      null,
      '弟子训练：旧弟子\n以后先判断资料是否可信',
      worker.id
    )
    expect(queries.listTrainingAdjustments(ctx.db, room.id)).toHaveLength(0)

    const res = await request(ctx, 'GET', `/api/rooms/${room.id}/training-adjustments`)

    expect(res.status).toBe(200)
    const body = res.body as any[]
    expect(body).toHaveLength(1)
    expect(body[0]).toMatchObject({
      escalationId: old.id,
      workerId: worker.id,
      status: 'queued',
      progress: 15,
    })
  })
})
