import type Database from 'better-sqlite3'
import * as queries from './db-queries'
import type { Goal, Worker } from './types'
import { isAssignableWorker } from './worker-roles'
import { isComplexGoalDescription, isGenericAutoExecutor, isUnfinishedGoalStatus } from './goal-assignment-rules'

export { isGenericAutoExecutor } from './goal-assignment-rules'

export interface GoalAssignmentValidation {
  ok: boolean
  error?: string
}

export function unfinishedAssignedGoalCount(
  db: Database.Database,
  roomId: number,
  workerId: number,
  excludeGoalId?: number
): number {
  return queries.listGoals(db, roomId).filter(goal =>
    goal.assignedWorkerId === workerId &&
    goal.id !== excludeGoalId &&
    isUnfinishedGoalStatus(goal.status)
  ).length
}

export function validateGoalAssignment(
  db: Database.Database,
  roomId: number,
  workerId: number | null | undefined,
  description: string,
  excludeGoalId?: number
): GoalAssignmentValidation {
  if (workerId == null) return { ok: true }

  const room = queries.getRoom(db, roomId)
  if (!room) return { ok: false, error: `帮派 #${roomId} 不存在。` }

  const worker = queries.getWorker(db, workerId)
  if (!worker) return { ok: false, error: `弟子 #${workerId} 不存在。` }
  if (worker.roomId !== roomId) {
    return { ok: false, error: `专人专职规则：${worker.name} 不属于当前帮派，不能接这支帮派的委托。` }
  }
  if (!isAssignableWorker(worker, room.queenWorkerId)) {
    return { ok: false, error: `专人专职规则：${worker.name} 是治理或帮主角色，不能作为执行负责人。` }
  }

  const openCount = unfinishedAssignedGoalCount(db, roomId, workerId, excludeGoalId)
  const generic = isGenericAutoExecutor(worker)
  if (generic && isComplexGoalDescription(description)) {
    return {
      ok: false,
      error: `专人专职规则：${worker.name} 是临时通用执行弟子，不能承接市场、竞品、报告、风险等复杂工作。请先从客栈调入对应岗位弟子，再分派。`
    }
  }
  const limit = generic ? 1 : 2
  if (openCount >= limit) {
    return {
      ok: false,
      error: `专人专职规则：${worker.name} 已有 ${openCount} 个未完成委托，继续叠加会造成上下文污染。请改派其他专职弟子。`
    }
  }

  return { ok: true }
}

export function assignmentWarning(goal: Goal, worker: Worker | null | undefined, allGoals: Goal[]): string | null {
  if (!worker) return null
  const openCount = allGoals.filter(candidate =>
    candidate.assignedWorkerId === worker.id &&
    candidate.id !== goal.id &&
    isUnfinishedGoalStatus(candidate.status)
  ).length
  if (isGenericAutoExecutor(worker) && isComplexGoalDescription(goal.description)) {
    return '该目标需要专职弟子，当前负责人是临时通用执行弟子，容易造成上下文污染。'
  }
  if (openCount >= (isGenericAutoExecutor(worker) ? 1 : 2)) {
    return `该弟子还有 ${openCount} 个未完成委托，建议拆给其他专职弟子。`
  }
  return null
}
