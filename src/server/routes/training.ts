import type { Router, RouteContext } from '../router'
import * as queries from '../../shared/db-queries'
import { eventBus } from '../event-bus'
import type { TrainingAdjustmentStatus } from '../../shared/types'

const TRAINING_STATUSES = new Set<TrainingAdjustmentStatus>([
  'queued',
  'training',
  'absorbed',
  'attention',
])

const CONFIG_START = '<jianghu_training_config>'
const CONFIG_END = '</jianghu_training_config>'

function isTrainingQuestion(question: string): boolean {
  return question.trimStart().startsWith('弟子训练')
}

function trainingBody(question: string): string {
  const lines = question.trim().split(/\r?\n/)
  return (lines.slice(1).join('\n').trim() || question.replace(/^弟子训练[:：]?/, '').trim()).slice(0, 500)
}

function ensureTrainingAdjustmentsForRoom(ctx: RouteContext, roomId: number): void {
  const existing = new Set(queries.listTrainingAdjustments(ctx.db, roomId).map(item => item.escalationId))
  const escalations = queries.listEscalations(ctx.db, roomId)
  for (const escalation of escalations) {
    if (existing.has(escalation.id) || !isTrainingQuestion(escalation.question)) continue
    const absorbed = escalation.status === 'resolved' || Boolean(escalation.answer)
    const adjustment = queries.upsertTrainingAdjustment(
      ctx.db,
      roomId,
      escalation.id,
      escalation.toAgentId,
      absorbed ? 'absorbed' : 'queued',
      absorbed ? 100 : 15,
      absorbed && escalation.answer
        ? `训练结果：${escalation.answer.trim()}`
        : `训练意见已送达，等待弟子接收：${trainingBody(escalation.question)}`,
    )
    eventBus.emit(`room:${roomId}`, 'training:updated', adjustment)
  }
}

function parseConfigJson(value: unknown): string | null {
  if (value == null) return null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null
    JSON.parse(trimmed)
    return JSON.stringify(JSON.parse(trimmed), null, 2)
  }
  return JSON.stringify(value, null, 2)
}

function replaceTrainingConfigBlock(systemPrompt: string, configJson: string): string {
  const block = `${CONFIG_START}\n${configJson}\n${CONFIG_END}`
  const pattern = new RegExp(`\\n?${CONFIG_START}[\\s\\S]*?${CONFIG_END}`, 'm')
  const cleaned = systemPrompt.replace(pattern, '').trim()
  return `${cleaned}\n\n${block}`.trim()
}

function applyConfigToWorker(
  ctx: RouteContext,
  workerId: number,
  configJson: string
): void {
  const worker = queries.getWorker(ctx.db, workerId)
  if (!worker) return
  const config = JSON.parse(configJson) as Record<string, unknown>
  const roleDefinition = config.roleDefinition as Record<string, unknown> | undefined
  const roleName = typeof roleDefinition?.roleName === 'string' ? roleDefinition.roleName.trim() : ''
  const mission = typeof roleDefinition?.mission === 'string' ? roleDefinition.mission.trim() : ''
  const nextSystemPrompt = replaceTrainingConfigBlock(worker.systemPrompt, configJson)
  queries.updateWorker(ctx.db, workerId, {
    role: roleName || worker.role,
    description: mission || worker.description || undefined,
    systemPrompt: nextSystemPrompt,
  })
  eventBus.emit('workers', 'worker:updated', queries.getWorker(ctx.db, workerId))
}

export function registerTrainingRoutes(router: Router): void {
  router.get('/api/rooms/:roomId/training-adjustments', (ctx) => {
    const roomId = Number(ctx.params.roomId)
    ensureTrainingAdjustmentsForRoom(ctx, roomId)
    return { data: queries.listTrainingAdjustments(ctx.db, roomId) }
  })

  router.post('/api/rooms/:roomId/training-adjustments/:escalationId', (ctx) => {
    const roomId = Number(ctx.params.roomId)
    const escalationId = Number(ctx.params.escalationId)
    const escalation = queries.getEscalation(ctx.db, escalationId)
    if (!escalation || escalation.roomId !== roomId) {
      return { status: 404, error: 'Training record not found' }
    }

    const body = ctx.body as Record<string, unknown> || {}
    const status = body.status as TrainingAdjustmentStatus
    if (!TRAINING_STATUSES.has(status)) {
      return { status: 400, error: 'status is invalid' }
    }
    const rawProgress = typeof body.progress === 'number' ? body.progress : Number(body.progress)
    if (!Number.isFinite(rawProgress)) {
      return { status: 400, error: 'progress is required' }
    }
    const note = typeof body.note === 'string' ? body.note : null
    const workerId = body.workerId == null ? escalation.toAgentId : Number(body.workerId)
    let configJson: string | null = null
    try {
      configJson = parseConfigJson(body.config ?? body.configJson)
    } catch {
      return { status: 400, error: 'config must be valid JSON' }
    }
    const adjustment = queries.upsertTrainingAdjustment(
      ctx.db,
      roomId,
      escalationId,
      Number.isFinite(workerId) ? workerId : null,
      status,
      rawProgress,
      note,
      configJson
    )

    if (configJson && Number.isFinite(workerId)) {
      applyConfigToWorker(ctx, Number(workerId), configJson)
    }

    if (status === 'absorbed' && escalation.status !== 'resolved') {
      const answer = note?.trim()
        ? `训练营手动标记已吸收：${note.trim()}`
        : '训练营手动标记已吸收。'
      queries.resolveEscalation(ctx.db, escalationId, answer)
      eventBus.emit(`room:${roomId}`, 'escalation:resolved', queries.getEscalation(ctx.db, escalationId))
    }

    eventBus.emit(`room:${roomId}`, 'training:updated', adjustment)
    return { data: adjustment }
  })
}
