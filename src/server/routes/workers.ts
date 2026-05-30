import type { Router } from '../router'
import type { AgentState } from '../../shared/types'
import * as queries from '../../shared/db-queries'
import { eventBus } from '../event-bus'
import { triggerAgent, pauseAgent, isRoomLaunchEnabled } from '../../shared/agent-loop'
import { isAssignableWorker, isInnWorker } from '../../shared/worker-roles'

export function registerWorkerRoutes(router: Router): void {
  router.post('/api/workers', (ctx) => {
    const body = ctx.body as Record<string, unknown> || {}
    if (!body.name || typeof body.name !== 'string') return { status: 400, error: 'name is required' }
    if (!body.systemPrompt || typeof body.systemPrompt !== 'string') return { status: 400, error: 'systemPrompt is required' }

    const requestedRoomId = body.roomId != null ? Number(body.roomId) : undefined
    if (requestedRoomId != null && Number.isFinite(requestedRoomId)) {
      return { status: 400, error: '新弟子必须先进入客栈，再从客栈调入帮派。' }
    }

    const worker = queries.createWorker(ctx.db, {
      name: body.name,
      systemPrompt: body.systemPrompt,
      description: body.description as string | undefined,
      role: body.role as string | undefined,
      isDefault: body.isDefault as boolean | undefined,
      cycleGapMs: body.cycleGapMs != null ? Number(body.cycleGapMs) : undefined,
      maxTurns: body.maxTurns != null ? Number(body.maxTurns) : undefined,
      roomId: undefined,
      agentState: body.agentState as AgentState | undefined
    })
    eventBus.emit('workers', 'worker:created', worker)
    return { status: 201, data: worker }
  })

  router.get('/api/workers', (ctx) => {
    const workers = queries.listWorkers(ctx.db)
    return { data: workers }
  })

  router.get('/api/workers/:id', (ctx) => {
    const worker = queries.getWorker(ctx.db, Number(ctx.params.id))
    if (!worker) return { status: 404, error: '弟子不存在。' }
    return { data: worker }
  })

  router.patch('/api/workers/:id', (ctx) => {
    const id = Number(ctx.params.id)
    const worker = queries.getWorker(ctx.db, id)
    if (!worker) return { status: 404, error: '弟子不存在。' }

    const body = ctx.body as Record<string, unknown> || {}
    if (body.roomId !== undefined) {
      const nextRoomId = body.roomId == null || body.roomId === '' ? null : Number(body.roomId)
      if (nextRoomId != null) {
        if (!Number.isInteger(nextRoomId) || !queries.getRoom(ctx.db, nextRoomId)) {
          return { status: 400, error: '目标帮派不存在。' }
        }
        if (!isInnWorker(worker)) {
          return { status: 400, error: '只能从客栈调入弟子；已在其他帮派或系统角色不能被选择。' }
        }
      } else if (!isAssignableWorker(worker)) {
        return { status: 400, error: '系统角色不能退回客栈。' }
      }
    }
    queries.updateWorker(ctx.db, id, body)
    const updated = queries.getWorker(ctx.db, id)
    eventBus.emit('workers', 'worker:updated', updated)
    return { data: updated }
  })

  router.delete('/api/workers/:id', (ctx) => {
    const id = Number(ctx.params.id)
    const worker = queries.getWorker(ctx.db, id)
    if (!worker) return { status: 404, error: '弟子不存在。' }

    queries.deleteWorker(ctx.db, id)
    eventBus.emit('workers', 'worker:deleted', { id })
    return { data: { ok: true } }
  })

  router.post('/api/workers/:id/start', (ctx) => {
    const id = Number(ctx.params.id)
    const worker = queries.getWorker(ctx.db, id)
    if (!worker) return { status: 404, error: '弟子不存在。' }
    if (!worker.roomId) return { status: 400, error: '弟子尚未加入帮派。' }
    const room = queries.getRoom(ctx.db, worker.roomId)
    if (!room) return { status: 404, error: '帮派不存在。' }
    if (room.status !== 'active') return { status: 400, error: '帮派尚未运行。' }
    if (!isRoomLaunchEnabled(worker.roomId)) {
      return { status: 409, error: '帮派运行尚未启动，请先启动帮派。' }
    }
    triggerAgent(ctx.db, worker.roomId, id, {
      onCycleLogEntry: (entry) => eventBus.emit(`cycle:${entry.cycleId}`, 'cycle:log', entry),
      onCycleLifecycle: (event, cycleId) => eventBus.emit(`room:${worker.roomId}`, `cycle:${event}`, { cycleId, roomId: worker.roomId })
    })
    eventBus.emit('workers', 'worker:started', { id, roomId: worker.roomId })
    return { data: { ok: true, running: true } }
  })

  router.post('/api/workers/:id/stop', (ctx) => {
    const id = Number(ctx.params.id)
    const worker = queries.getWorker(ctx.db, id)
    if (!worker) return { status: 404, error: '弟子不存在。' }
    pauseAgent(ctx.db, id)
    eventBus.emit('workers', 'worker:stopped', { id })
    return { data: { ok: true, running: false } }
  })

  router.get('/api/rooms/:roomId/workers', (ctx) => {
    const workers = queries.listRoomWorkers(ctx.db, Number(ctx.params.roomId))
    return { data: workers }
  })
}
