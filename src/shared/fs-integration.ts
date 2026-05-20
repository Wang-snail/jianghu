/**
 * 文件系统集成层 - 桥接文件系统和数据库
 *
 * 在现有数据库查询层之上添加文件系统支持
 * 数据库存储索引和元数据，文件系统存储实际内容
 */

import type Database from 'better-sqlite3'
import * as queries from './db-queries'
import {
  initRoomDir,
  deleteRoomDir,
  saveSkill,
  loadSkill,
  listSkills,
  deleteSkill as deleteSkillFile,
  saveGoal,
  listGoals,
  appendLog,
  getRoomDiskUsage,
  type SkillFile,
  type GoalFile,
} from './fs-storage'

// ── 公司管理集成 ───────────────────────────────────────────────────────

/**
 * 创建公司（同时初始化文件系统目录）
 */
export async function createRoomWithFS(
  db: Database.Database,
  name: string,
  goal: string | null,
  config: any
): Promise<any> {
  // 1. 在数据库中创建公司
  const room = queries.createRoom(db, name, goal ?? undefined, config)

  // 2. 初始化文件系统目录
  await initRoomDir(room.id)

  return room
}

/**
 * 删除公司（同时删除文件系统目录）
 */
export async function deleteRoomWithFS(
  db: Database.Database,
  roomId: number
): Promise<void> {
  // 1. 删除数据库记录（会级联删除相关记录）
  queries.deleteRoom(db, roomId)

  // 2. 删除文件系统目录
  await deleteRoomDir(roomId)

  console.log(`公司 ${roomId} 的文件系统数据已删除`)
}

/**
 * 获取公司详细信息（包括磁盘使用情况）
 */
export async function getRoomInfoWithFS(
  db: Database.Database,
  roomId: number
): Promise<any> {
  const room = queries.getRoom(db, roomId)
  if (!room) {
    return null
  }

  // 获取磁盘使用情况
  const diskUsage = await getRoomDiskUsage(roomId)

  return {
    ...room,
    diskUsage: {
      size: diskUsage.size,
      fileCount: diskUsage.fileCount,
      sizeFormatted: formatBytes(diskUsage.size),
    },
  }
}

// ── 技能管理集成 ───────────────────────────────────────────────────────

/**
 * 创建技能（同时保存到文件系统）
 */
export async function createSkillWithFS(
  db: Database.Database,
  roomId: number | null,
  name: string,
  content: string,
  opts?: any
): Promise<any> {
  // 1. 在数据库中创建索引记录
  const skill = queries.createSkill(db, roomId, name, content, opts)

  // 2. 保存到文件系统
  if (roomId) {
    await saveSkill(roomId, {
      id: skill.id,
      name: skill.name,
      content: skill.content,
      version: skill.version || 1,
      createdAt: skill.createdAt,
      updatedAt: skill.updatedAt,
    })
  }

  return skill
}

/**
 * 更新技能（同时更新文件系统）
 */
export async function updateSkillWithFS(
  db: Database.Database,
  skillId: number,
  updates: Partial<{ name: string; content: string }>
): Promise<void> {
  // 1. 获取当前技能
  const skill = queries.getSkill(db, skillId)
  if (!skill) {
    throw new Error(`技能 ${skillId} 不存在`)
  }

  // 2. 更新数据库记录
  queries.updateSkill(db, skillId, {
    ...updates,
    version: (skill.version || 1) + 1,
  })

  // 3. 更新文件系统
  if (skill.roomId && updates.content) {
    await saveSkill(skill.roomId, {
      ...skill,
      ...updates,
      version: (skill.version || 1) + 1,
    })
  }
}

/**
 * 删除技能（同时删除文件系统文件）
 */
export async function deleteSkillWithFS(
  db: Database.Database,
  skillId: number
): Promise<void> {
  // 1. 获取技能信息
  const skill = queries.getSkill(db, skillId)
  if (!skill) {
    throw new Error(`技能 ${skillId} 不存在`)
  }

  // 2. 删除数据库记录
  queries.deleteSkill(db, skillId)

  // 3. 删除文件系统文件
  if (skill.roomId) {
    await deleteSkillFile(skill.roomId, skillId)
  }
}

/**
 * 从文件系统加载技能内容
 */
export async function loadSkillFromFS(
  db: Database.Database,
  skillId: number
): Promise<SkillFile | null> {
  const skill = queries.getSkill(db, skillId)
  if (!skill || !skill.roomId) {
    return null
  }

  return loadSkill(skill.roomId, skillId)
}

// ── 目标管理集成 ───────────────────────────────────────────────────────

/**
 * 创建目标（同时保存到文件系统）
 */
export async function createGoalWithFS(
  db: Database.Database,
  roomId: number,
  name: string,
  parentGoalId: number | null,
  workerId: number | null
): Promise<any> {
  // 1. 在数据库中创建记录
  const goal = queries.createGoal(db, roomId, name, parentGoalId ?? undefined, workerId ?? undefined)

  // 2. 保存到文件系统
  await saveGoal(roomId, {
    id: goal.id,
    description: goal.description,
    status: toGoalFileStatus(goal.status),
    parentId: goal.parentGoalId ?? null,
    workerId: goal.assignedWorkerId ?? null,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
  })

  return goal
}

// ── 日志管理 ───────────────────────────────────────────────────────────

/**
 * 记录循环日志（写入文件）
 */
export async function logCycleWithFS(
  _db: Database.Database,
  roomId: number,
  workerId: number,
  logEntry: any
): Promise<void> {
  // 写入文件系统
  await appendLog(roomId, 'cycle' as any, `worker-${workerId}`, JSON.stringify(logEntry))
}

// ── 工具函数 ───────────────────────────────────────────────────────────

function toGoalFileStatus(status: string): GoalFile['status'] {
  if (status === 'completed') return 'completed'
  if (status === 'abandoned') return 'cancelled'
  return 'active'
}


/**
 * 格式化字节数
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

/**
 * 获取公司统计信息
 */
export async function getRoomStats(
  db: Database.Database,
  roomId: number
): Promise<any> {
  const room = queries.getRoom(db, roomId)
  if (!room) {
    return null
  }

  const [skills, goals, diskUsage] = await Promise.all([
    listSkills(roomId),
    listGoals(roomId),
    getRoomDiskUsage(roomId),
  ])

  return {
    id: room.id,
    name: room.name,
    status: room.status,
    skillCount: skills.length,
    goalCount: goals.length,
    diskSize: diskUsage.size,
    diskSizeFormatted: formatBytes(diskUsage.size),
    fileCount: diskUsage.fileCount,
  }
}
