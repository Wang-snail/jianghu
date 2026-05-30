import type { Router } from '../router'
import * as queries from '../../shared/db-queries'
import { eventBus } from '../event-bus'
import { triggerAgent } from '../../shared/agent-loop'

function isTrainingQuestion(question: string): boolean {
  return question.trimStart().startsWith('弟子训练')
}

function trainingBody(question: string): string {
  const lines = question.trim().split(/\r?\n/)
  return (lines.slice(1).join('\n').trim() || question.replace(/^弟子训练[:：]?/, '').trim()).slice(0, 500)
}

export function registerEscalationRoutes(router: Router): void {
  router.post('/api/rooms/:roomId/escalations', (ctx) => {
    const roomId = Number(ctx.params.roomId)
    const body = ctx.body as Record<string, unknown> || {}
    const fromAgentId = body.fromAgentId != null ? Number(body.fromAgentId) : null
    if (body.fromAgentId != null && (typeof body.fromAgentId !== 'number' || isNaN(fromAgentId!))) {
      return { status: 400, error: 'fromAgentId must be a number if provided' }
    }
    if (!body.question || typeof body.question !== 'string') {
      return { status: 400, error: 'question is required' }
    }

    const escalation = queries.createEscalation(ctx.db, roomId,
      fromAgentId,
      body.question,
      body.toAgentId as number | undefined)
    eventBus.emit(`room:${roomId}`, 'escalation:created', escalation)

    const targetAgentId = typeof body.toAgentId === 'number'
      ? body.toAgentId
      : body.toAgentId != null ? Number(body.toAgentId) : null
    if (targetAgentId != null && Number.isFinite(targetAgentId) && isTrainingQuestion(body.question)) {
      const immediate = body.immediate === true
      const adjustment = queries.upsertTrainingAdjustment(
        ctx.db,
        roomId,
        escalation.id,
        targetAgentId,
        immediate ? 'training' : 'queued',
        immediate ? 35 : 15,
        immediate
          ? `训练意见已送达并唤醒弟子，正在吸收：${trainingBody(body.question)}`
          : `训练意见已送达，等待弟子接收：${trainingBody(body.question)}`,
      )
      queries.logRoomActivity(
        ctx.db,
        roomId,
        'worker',
        immediate ? `训练已开始：弟子 #${targetAgentId} 正在吸收训练意见` : `训练已送达：弟子 #${targetAgentId} 等待接收`,
        trainingBody(body.question),
        targetAgentId
      )
      eventBus.emit(`room:${roomId}`, 'training:updated', adjustment)
    }

    if (body.immediate === true) {
      const room = queries.getRoom(ctx.db, roomId)
      const immediateTargetAgentId = typeof body.toAgentId === 'number'
        ? body.toAgentId
        : room?.queenWorkerId ?? null
      if (room && immediateTargetAgentId != null) {
        triggerAgent(ctx.db, roomId, immediateTargetAgentId, {
          allowColdStart: true,
          oneShot: true,
          runWhenInactive: true,
          directReplyEscalationId: escalation.id
        })
        eventBus.emit(`room:${roomId}`, 'room:queen_started', { roomId, workerId: immediateTargetAgentId, immediate: true })
        eventBus.emit('rooms', 'rooms:queen_state', {
          roomId,
          running: true,
          updatedAt: new Date().toISOString(),
        })
      }
    }

    return { status: 201, data: escalation }
  })

  router.get('/api/rooms/:roomId/escalations', (ctx) => {
    const roomId = Number(ctx.params.roomId)
    const toAgentId = ctx.query.toAgentId ? Number(ctx.query.toAgentId) : undefined

    // Agent loop use case: toAgentId implies pending-only with NULL-fallback semantics
    if (toAgentId != null) {
      return { data: queries.getPendingEscalations(ctx.db, roomId, toAgentId) }
    }

    // UI use case: return all (or filtered by status)
    const status = ctx.query.status as string | undefined
    return { data: queries.listEscalations(ctx.db, roomId, status as any) }
  })

  router.post('/api/escalations/:id/resolve', (ctx) => {
    const id = Number(ctx.params.id)
    const escalation = queries.getEscalation(ctx.db, id)
    if (!escalation) return { status: 404, error: 'Escalation not found' }

    const body = ctx.body as Record<string, unknown> || {}
    if (!body.answer || typeof body.answer !== 'string') {
      return { status: 400, error: 'answer is required' }
    }

    queries.resolveEscalation(ctx.db, id, body.answer)
    const updated = queries.getEscalation(ctx.db, id)
    eventBus.emit(`room:${escalation.roomId}`, 'escalation:resolved', updated)

    if (isTrainingQuestion(escalation.question) && escalation.toAgentId != null) {
      const existing = queries
        .listTrainingAdjustments(ctx.db, escalation.roomId)
        .find(adjustment => adjustment.escalationId === escalation.id)
      const adjustment = queries.upsertTrainingAdjustment(
        ctx.db,
        escalation.roomId,
        escalation.id,
        escalation.toAgentId,
        'absorbed',
        100,
        `训练结果：${body.answer.trim()}`,
        existing?.configJson ?? null
      )
      queries.logRoomActivity(
        ctx.db,
        escalation.roomId,
        'worker',
        `训练已吸收：弟子 #${escalation.toAgentId} 提交训练结果`,
        body.answer.trim(),
        escalation.toAgentId
      )
      eventBus.emit(`room:${escalation.roomId}`, 'training:updated', adjustment)
    }

    // Wake the agent who sent the message so they see the reply
    if (escalation.fromAgentId) {
      triggerAgent(ctx.db, escalation.roomId, escalation.fromAgentId)
    }
    // Also wake the queen if it wasn't the sender
    const room = queries.getRoom(ctx.db, escalation.roomId)
    if (room?.queenWorkerId && room.queenWorkerId !== escalation.fromAgentId) {
      triggerAgent(ctx.db, escalation.roomId, room.queenWorkerId)
    }

    return { data: updated }
  })
}
