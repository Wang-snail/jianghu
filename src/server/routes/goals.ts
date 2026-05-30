import fs from 'fs'
import path from 'path'
import type { Router } from '../router'
import type { GoalStatus } from '../../shared/types'
import * as queries from '../../shared/db-queries'
import { eventBus } from '../event-bus'
import { decomposeGoal, updateGoalProgress, completeGoal, abandonGoal } from '../../shared/goals'
import { getRoomSubdir } from '../../shared/fs-storage'
import { validateGoalAssignment } from '../../shared/goal-assignment'

const GOAL_STATUS_VALUES: GoalStatus[] = ['active', 'in_progress', 'completed', 'abandoned', 'blocked']

function inferResultTitle(fileName: string): string {
  let title = fileName.replace(/\.(md|csv|json)$/i, '')
  const phraseReplacements: Array<[RegExp, string]> = [
    [/dehumidifier/gi, '除湿机'],
    [/ac_market/gi, '空调市场'],
    [/report_assembly_index/gi, '报告装配索引'],
    [/assembly_index/gi, '装配索引'],
    [/acceptance/gi, '验收记录'],
    [/review_waiting_card/gi, '复盘等待卡'],
    [/market_review/gi, '市场复盘'],
    [/china_platform_evidence/gi, '中国平台证据'],
    [/minimum_trial_review/gi, '最小试运行复核'],
    [/minimum_trial_draft/gi, '最小试运行草稿'],
    [/minimum_trial/gi, '最小试运行'],
    [/market_minimum_trial/gi, '市场最小试运行'],
    [/market/gi, '市场'],
    [/review/gi, '复核'],
    [/supplement/gi, '补充材料'],
    [/task_(\d+)/gi, '镖单$1'],
    [/worker(\d+)/gi, '弟子$1'],
    [/v(\d+)/gi, 'v$1'],
  ]
  for (const [pattern, replacement] of phraseReplacements) {
    title = title.replace(pattern, replacement)
  }
  return title
    .replace(/amazon|research|real|data/gi, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || fileName
}

function readResultPreview(filePath: string): string {
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    return raw
      .replace(/\r\n/g, '\n')
      .split('\n')
      .filter(line => line.trim().length > 0)
      .slice(0, 18)
      .join('\n')
      .slice(0, 1600)
  } catch {
    return ''
  }
}

function listRoomResultFiles(roomId: number): Array<{ name: string; title: string; path: string; updatedAt: string; size: number; preview: string }> {
  const dirs = [getRoomSubdir(roomId, 'results'), getRoomSubdir(roomId, 'shared')]
  const files: Array<{ name: string; title: string; path: string; updatedAt: string; size: number; preview: string }> = []
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue
    for (const name of fs.readdirSync(dir)) {
      if (!/\.(md|csv|json)$/i.test(name)) continue
      const filePath = path.join(dir, name)
      const stat = fs.statSync(filePath)
      if (!stat.isFile() || stat.size === 0) continue
      files.push({
        name,
        title: inferResultTitle(name),
        path: `${path.basename(dir)}/${name}`,
        updatedAt: stat.mtime.toISOString(),
        size: stat.size,
        preview: readResultPreview(filePath),
      })
    }
  }
  return files.sort((a, b) => {
    const aScore = /final|completion|acceptance|review|index|report|template|playbook/i.test(a.name) ? 1 : 0
    const bScore = /final|completion|acceptance|review|index|report|template|playbook/i.test(b.name) ? 1 : 0
    if (aScore !== bScore) return bScore - aScore
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  })
}

export function registerGoalRoutes(router: Router): void {
  router.post('/api/rooms/:roomId/goals', (ctx) => {
    const roomId = Number(ctx.params.roomId)
    const body = ctx.body as Record<string, unknown> || {}
    if (!body.description || typeof body.description !== 'string') {
      return { status: 400, error: 'description is required' }
    }

    try {
      const parentGoalId = body.parentGoalId as number | undefined
      const assignedWorkerId = body.assignedWorkerId as number | undefined
      const expectedCompletedAt = typeof body.expectedCompletedAt === 'string' && body.expectedCompletedAt.trim()
        ? body.expectedCompletedAt.trim()
        : null
      let goal

      const assignmentCheck = validateGoalAssignment(ctx.db, roomId, assignedWorkerId, body.description)
      if (!assignmentCheck.ok) {
        return { status: 400, error: assignmentCheck.error }
      }

      if (parentGoalId != null) {
        const parent = queries.getGoal(ctx.db, parentGoalId)
        if (!parent || parent.roomId !== roomId) {
          return { status: 400, error: `Parent goal ${parentGoalId} not found in room ${roomId}` }
        }
        goal = decomposeGoal(ctx.db, parentGoalId, [body.description])[0]
        if (assignedWorkerId != null) {
          queries.updateGoal(ctx.db, goal.id, { assignedWorkerId })
          goal = queries.getGoal(ctx.db, goal.id)!
        }
        if (expectedCompletedAt != null) {
          queries.updateGoal(ctx.db, goal.id, { expectedCompletedAt })
          goal = queries.getGoal(ctx.db, goal.id)!
        }
      } else {
        goal = queries.createGoal(ctx.db, roomId, body.description, undefined, assignedWorkerId, expectedCompletedAt)
      }

      eventBus.emit(`room:${roomId}`, 'goal:created', goal)
      return { status: 201, data: goal }
    } catch (e) {
      return { status: 400, error: (e as Error).message }
    }
  })

  router.get('/api/rooms/:roomId/goals', (ctx) => {
    const roomId = Number(ctx.params.roomId)
    const goals = queries.listGoals(ctx.db, roomId, ctx.query.status as GoalStatus | undefined)
    return { data: goals }
  })

  router.get('/api/rooms/:roomId/result-files', (ctx) => {
    const roomId = Number(ctx.params.roomId)
    return { data: listRoomResultFiles(roomId).slice(0, 30) }
  })

  router.get('/api/goals/:id', (ctx) => {
    const goal = queries.getGoal(ctx.db, Number(ctx.params.id))
    if (!goal) return { status: 404, error: 'Goal not found' }
    return { data: goal }
  })

  router.get('/api/goals/:id/subgoals', (ctx) => {
    const subgoals = queries.getSubGoals(ctx.db, Number(ctx.params.id))
    return { data: subgoals }
  })

  router.patch('/api/goals/:id', (ctx) => {
    const id = Number(ctx.params.id)
    const goal = queries.getGoal(ctx.db, id)
    if (!goal) return { status: 404, error: 'Goal not found' }

    const body = ctx.body as Record<string, unknown> || {}
    const updates: Partial<{
      description: string
      assignedWorkerId: number | null
      expectedCompletedAt: string | null
    }> = {}

    if (body.description !== undefined) {
      if (typeof body.description !== 'string' || !body.description.trim()) {
        return { status: 400, error: 'description must be a non-empty string' }
      }
      updates.description = body.description
    }
    if (body.assignedWorkerId !== undefined) {
      const assignedWorkerId = body.assignedWorkerId as number | null
      const descriptionForCheck = updates.description ?? goal.description
      const assignmentCheck = validateGoalAssignment(ctx.db, goal.roomId, assignedWorkerId, descriptionForCheck, id)
      if (!assignmentCheck.ok) {
        return { status: 400, error: assignmentCheck.error }
      }
      updates.assignedWorkerId = assignedWorkerId
    }
    if (body.expectedCompletedAt !== undefined) {
      updates.expectedCompletedAt = typeof body.expectedCompletedAt === 'string' && body.expectedCompletedAt.trim()
        ? body.expectedCompletedAt.trim()
        : null
    }

    if (Object.keys(updates).length > 0) {
      queries.updateGoal(ctx.db, id, updates)
    }

    if (body.progress !== undefined) {
      const progressRaw = Number(body.progress)
      if (!Number.isFinite(progressRaw)) {
        return { status: 400, error: 'progress must be a number' }
      }
      const progress = Math.max(0, Math.min(1, progressRaw))
      queries.updateGoal(ctx.db, id, { progress })
      updateGoalProgress(
        ctx.db,
        id,
        'Manual progress update',
        progress,
        body.workerId as number | undefined
      )
    }

    if (body.status !== undefined) {
      const status = body.status as GoalStatus
      if (!GOAL_STATUS_VALUES.includes(status)) {
        return { status: 400, error: 'status is invalid' }
      }
      if (status === 'completed') {
        completeGoal(ctx.db, id)
      } else if (status === 'abandoned') {
        const reason = typeof body.reason === 'string' && body.reason.trim()
          ? body.reason
          : 'Manual status change'
        abandonGoal(ctx.db, id, reason)
      } else {
        queries.updateGoal(ctx.db, id, { status })
      }
    }

    const updated = queries.getGoal(ctx.db, id)!
    eventBus.emit(`room:${goal.roomId}`, 'goal:updated', updated)
    return { data: updated }
  })

  router.delete('/api/goals/:id', (ctx) => {
    const id = Number(ctx.params.id)
    const goal = queries.getGoal(ctx.db, id)
    if (!goal) return { status: 404, error: 'Goal not found' }

    queries.deleteGoal(ctx.db, id)
    eventBus.emit(`room:${goal.roomId}`, 'goal:deleted', { id })
    return { data: { ok: true } }
  })

  router.post('/api/goals/:id/updates', (ctx) => {
    const id = Number(ctx.params.id)
    const goal = queries.getGoal(ctx.db, id)
    if (!goal) return { status: 404, error: 'Goal not found' }

    const body = ctx.body as Record<string, unknown> || {}
    if (!body.observation || typeof body.observation !== 'string') {
      return { status: 400, error: 'observation is required' }
    }

    const update = updateGoalProgress(
      ctx.db,
      id,
      body.observation,
      body.metricValue as number | undefined,
      body.workerId as number | undefined
    )
    const updatedGoal = queries.getGoal(ctx.db, id)
    eventBus.emit(`room:${goal.roomId}`, 'goal:progress', {
      goalId: id,
      update,
      goal: updatedGoal
    })
    return { status: 201, data: update }
  })

  router.get('/api/goals/:id/updates', (ctx) => {
    const limit = ctx.query.limit ? Number(ctx.query.limit) : undefined
    const updates = queries.getGoalUpdates(ctx.db, Number(ctx.params.id), limit)
    return { data: updates }
  })

  router.get('/api/goals/:id/result-summary', (ctx) => {
    const goal = queries.getGoal(ctx.db, Number(ctx.params.id))
    if (!goal) return { status: 404, error: 'Goal not found' }
    const updates = queries.getGoalUpdates(ctx.db, goal.id, 20)
    const meaningfulUpdates = updates.filter(update => !/^Manual progress update$/i.test(update.observation.trim()))
    const files = listRoomResultFiles(goal.roomId).slice(0, 8)
    return {
      data: {
        goalId: goal.id,
        status: goal.status,
        progress: goal.progress,
        completionClear: goal.status === 'completed' && meaningfulUpdates.length > 0,
        latestBasis: meaningfulUpdates[0]?.observation ?? null,
        hasManualOnlyUpdates: updates.length > 0 && meaningfulUpdates.length === 0,
        resultFiles: files,
      }
    }
  })
}
