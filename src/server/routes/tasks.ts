import crypto from 'node:crypto'
import type Database from 'better-sqlite3'
import type { Router } from '../router'
import type { Task, TriggerType } from '../../shared/types'
import * as queries from '../../shared/db-queries'
import { eventBus } from '../event-bus'
import { runTaskNow } from '../runtime'
import { isAssignableWorker } from '../../shared/worker-roles'

function toTaskListItem(task: Task): Task {
  const prompt = task.prompt.length > 500 ? `${task.prompt.slice(0, 500)}...` : task.prompt
  return {
    ...task,
    prompt,
    lastResult: null,
    learnedContext: null,
  }
}

function parseOptionalId(value: unknown): number | undefined {
  if (value == null || value === '') return undefined
  const id = typeof value === 'number'
    ? value
    : (typeof value === 'string' ? Number(value) : NaN)
  return Number.isInteger(id) && id > 0 ? id : undefined
}

function validateWorkerAssignment(
  db: Database.Database,
  workerIdValue: unknown,
  roomId: number | undefined
): { workerId?: number | null; error?: { status: number; error: string } } {
  if (workerIdValue === undefined) return {}
  if (workerIdValue == null || workerIdValue === '') return { workerId: null }

  const workerId = parseOptionalId(workerIdValue)
  if (workerId == null) {
    return { error: { status: 400, error: 'workerId must be a valid worker id' } }
  }

  const worker = queries.getWorker(db, workerId)
  if (!worker) {
    return { error: { status: 404, error: 'Worker not found' } }
  }

  const room = roomId != null ? queries.getRoom(db, roomId) : null
  if (roomId != null && !room) {
    return { error: { status: 404, error: 'Room not found' } }
  }

  if (roomId != null && worker.roomId !== roomId) {
    return { error: { status: 400, error: '该弟子不属于当前帮派，不能分派。' } }
  }

  if (!isAssignableWorker(worker, room?.queenWorkerId ?? null)) {
    return { error: { status: 400, error: '天机阁角色只负责调度，不能被分派为镖单执行弟子。' } }
  }

  return { workerId }
}

export function registerTaskRoutes(router: Router): void {
  router.post('/api/tasks', (ctx) => {
    const body = ctx.body as Record<string, unknown> || {}
    if (!body.prompt || typeof body.prompt !== 'string') {
      return { status: 400, error: 'prompt is required' }
    }
    const timeoutMinutesRaw = body.timeoutMinutes ?? body.timeout
    const timeoutMinutes = typeof timeoutMinutesRaw === 'number'
      ? timeoutMinutesRaw
      : (typeof timeoutMinutesRaw === 'string' ? Number.parseInt(timeoutMinutesRaw, 10) : undefined)

    const triggerType = (body.triggerType as TriggerType | undefined) || 'manual'
    const webhookToken = triggerType === 'webhook'
      ? crypto.randomBytes(16).toString('hex')
      : undefined
    const roomId = parseOptionalId(body.roomId)
    const assignment = validateWorkerAssignment(ctx.db, body.workerId, roomId)
    if (assignment.error) return assignment.error

    const task = queries.createTask(ctx.db, {
      name: (body.name as string | undefined) || body.prompt.slice(0, 50),
      prompt: body.prompt,
      description: body.description as string | undefined,
      triggerType,
      cronExpression: body.cronExpression as string | undefined,
      scheduledAt: body.scheduledAt as string | undefined,
      workerId: assignment.workerId ?? undefined,
      maxRuns: body.maxRuns as number | undefined,
      maxTurns: body.maxTurns as number | undefined,
      timeoutMinutes: Number.isFinite(timeoutMinutes) ? timeoutMinutes : undefined,
      allowedTools: body.allowedTools as string | undefined,
      disallowedTools: body.disallowedTools as string | undefined,
      sessionContinuity: body.sessionContinuity as boolean | undefined,
      roomId,
      webhookToken
    })
    eventBus.emit('tasks', 'task:created', task)
    return { status: 201, data: task }
  })

  router.get('/api/tasks', (ctx) => {
    const roomId = ctx.query.roomId ? Number(ctx.query.roomId) : undefined
    const tasks = queries.listTasks(ctx.db, roomId, ctx.query.status)
    return { data: tasks.map(toTaskListItem) }
  })

  router.get('/api/tasks/:id', (ctx) => {
    const task = queries.getTask(ctx.db, Number(ctx.params.id))
    if (!task) return { status: 404, error: 'Task not found' }
    return { data: task }
  })

  router.patch('/api/tasks/:id', (ctx) => {
    const id = Number(ctx.params.id)
    const task = queries.getTask(ctx.db, id)
    if (!task) return { status: 404, error: 'Task not found' }

    const body = ctx.body as Record<string, unknown> || {}
    const updates: Record<string, unknown> = { ...body }

    // Regenerate webhook token on request
    if (updates.regenerateWebhookToken) {
      const newToken = crypto.randomBytes(16).toString('hex')
      queries.updateTask(ctx.db, id, { webhookToken: newToken })
      delete updates.regenerateWebhookToken
    }

    if (updates.workerId !== undefined) {
      const nextRoomId = parseOptionalId(updates.roomId) ?? task.roomId ?? undefined
      const assignment = validateWorkerAssignment(ctx.db, updates.workerId, nextRoomId)
      if (assignment.error) return assignment.error
      updates.workerId = assignment.workerId ?? null
    }

    queries.updateTask(ctx.db, id, updates as Parameters<typeof queries.updateTask>[2])
    const updated = queries.getTask(ctx.db, id)
    if (updated) eventBus.emit('tasks', 'task:updated', updated)
    return { data: updated }
  })

  router.delete('/api/tasks/:id', (ctx) => {
    const id = Number(ctx.params.id)
    const task = queries.getTask(ctx.db, id)
    if (!task) return { status: 404, error: 'Task not found' }

    queries.deleteTask(ctx.db, id)
    eventBus.emit('tasks', 'task:deleted', { id })
    return { data: { ok: true } }
  })

  router.post('/api/tasks/:id/pause', (ctx) => {
    const id = Number(ctx.params.id)
    const task = queries.getTask(ctx.db, id)
    if (!task) return { status: 404, error: 'Task not found' }

    queries.pauseTask(ctx.db, id)
    eventBus.emit('tasks', 'task:paused', { id })
    return { data: { ok: true } }
  })

  router.post('/api/tasks/:id/resume', (ctx) => {
    const id = Number(ctx.params.id)
    const task = queries.getTask(ctx.db, id)
    if (!task) return { status: 404, error: 'Task not found' }

    queries.resumeTask(ctx.db, id)
    eventBus.emit('tasks', 'task:resumed', { id })
    return { data: { ok: true } }
  })

  router.get('/api/tasks/:id/runs', (ctx) => {
    const limit = ctx.query.limit ? Number(ctx.query.limit) : undefined
    const runs = queries.getTaskRuns(ctx.db, Number(ctx.params.id), limit)
    return { data: runs }
  })

  router.post('/api/tasks/:id/run', (ctx) => {
    const id = Number(ctx.params.id)
    const task = queries.getTask(ctx.db, id)
    if (!task) return { status: 404, error: 'Task not found' }

    const result = runTaskNow(ctx.db, id)
    if (!result.started) {
      return { status: 409, error: result.reason ?? 'Task is already running' }
    }

    eventBus.emit('tasks', 'task:run_requested', { id })
    return { status: 202, data: { ok: true } }
  })

  router.post('/api/tasks/:id/reset-session', (ctx) => {
    const id = Number(ctx.params.id)
    const task = queries.getTask(ctx.db, id)
    if (!task) return { status: 404, error: 'Task not found' }

    queries.clearTaskSession(ctx.db, id)
    eventBus.emit('tasks', 'task:session_reset', { id })
    return { data: { ok: true } }
  })
}
