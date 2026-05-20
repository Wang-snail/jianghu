/**
 * 文件系统存储层 - 按公司隔离存储数据
 *
 * 每个公司都有独立的文件夹存储其数据：
 * ~/.company-local/companies/{roomId}/
 *   ├── company.json        # 公司元数据
 *   ├── skills/            # 技能文件（.md）
 *   ├── goals/             # 目标文件（.json）
 *   ├── memory/            # 记忆数据（.json）
 *   ├── workers/           # 员工配置（.json）
 *   ├── tasks/             # 任务数据（.json）
 *   ├── files/             # 项目文件
 *   ├── shared/            # 共享资料
 *   ├── results/           # 任务结果
 *   ├── logs/              # 日志文件
 *   └── self-mod/          # 自我修改审计
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { homedir } from 'node:os'

// ── 路径配置 ─────────────────────────────────────────────────────

const BASE_DIR = path.join(process.env.COMPANY_DATA_DIR || path.join(homedir(), '.company-local'), 'companies')

/**
 * 获取公司根目录
 */
export function getRoomDir(roomId: number): string {
  return path.join(BASE_DIR, roomId.toString())
}

/**
 * 获取公司子目录路径
 */
export function getRoomSubdir(roomId: number, subdir: string): string {
  return path.join(getRoomDir(roomId), subdir)
}

/**
 * 获取帮派内单个 agent 的私有工作目录
 */
export function getAgentWorkspaceDir(roomId: number, workerId: number): string {
  return path.join(getRoomDir(roomId), 'workers', workerId.toString())
}

/**
 * 获取客栈候选 agent 的私有工作目录
 */
export function getInnAgentWorkspaceDir(workerId: number): string {
  return path.join(process.env.COMPANY_DATA_DIR || path.join(homedir(), '.company-local'), 'inn', 'agents', workerId.toString())
}

/**
 * 初始化 agent 私有工作目录。帮派 agent 与客栈 agent 分离，避免文件、记忆和临时产物串门。
 */
export async function initAgentWorkspace(roomId: number | null, workerId: number): Promise<string> {
  const root = roomId == null
    ? getInnAgentWorkspaceDir(workerId)
    : getAgentWorkspaceDir(roomId, workerId)
  const subdirs = ['scratch', 'memory', 'results', 'logs']
  for (const subdir of subdirs) {
    await fs.mkdir(path.join(root, subdir), { recursive: true })
  }
  return root
}

// ── 公司目录管理 ───────────────────────────────────────────────────

/**
 * 初始化公司目录结构
 */
export async function initRoomDir(roomId: number): Promise<void> {
  const roomDir = getRoomDir(roomId)

  // 创建所有子目录
  const subdirs = ['skills', 'goals', 'memory', 'workers', 'tasks', 'files', 'shared', 'results', 'logs', 'self-mod']

  for (const subdir of subdirs) {
    await fs.mkdir(path.join(roomDir, subdir), { recursive: true })
  }
}

/**
 * 检查公司目录是否存在
 */
export async function roomDirExists(roomId: number): Promise<boolean> {
  const roomDir = getRoomDir(roomId)
  try {
    await fs.access(roomDir)
    return true
  } catch {
    return false
  }
}

/**
 * 删除公司目录（级联删除所有数据）
 */
export async function deleteRoomDir(roomId: number): Promise<void> {
  const roomDir = getRoomDir(roomId)
  try {
    await fs.rm(roomDir, { recursive: true, force: true })
  } catch (err) {
    // 目录不存在时忽略错误
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err
    }
  }
}

// ── 公司元数据 ───────────────────────────────────────────────────────────

export interface RoomMetadata {
  id: number
  name: string
  goal: string
  status: 'active' | 'paused' | 'stopped'
  createdAt: string
  updatedAt: string
}

/**
 * 保存公司元数据
 */
export async function saveRoomMetadata(roomId: number, metadata: RoomMetadata): Promise<void> {
  await initRoomDir(roomId)
  const roomJson = path.join(getRoomDir(roomId), 'company.json')
  await fs.writeFile(roomJson, JSON.stringify(metadata, null, 2), 'utf-8')
}

/**
 * 读取公司元数据
 */
export async function loadRoomMetadata(roomId: number): Promise<RoomMetadata | null> {
  const companyJson = path.join(getRoomDir(roomId), 'company.json')
  const legacyRoomJson = path.join(getRoomDir(roomId), 'room.json')
  for (const metadataPath of [companyJson, legacyRoomJson]) {
    try {
      const content = await fs.readFile(metadataPath, 'utf-8')
      return JSON.parse(content)
    } catch {
      // Try the next known metadata filename.
    }
  }
  return null
}

// ── 技能文件管理 ───────────────────────────────────────────────────────

export interface SkillFile {
  id: number
  name: string
  content: string
  version: number
  createdAt: string
  updatedAt: string
}

/**
 * 保存技能到文件
 */
export async function saveSkill(roomId: number, skill: SkillFile): Promise<void> {
  await initRoomDir(roomId)
  const skillPath = path.join(getRoomDir(roomId), 'skills', `${skill.id}.md`)

  const content = `# ${skill.name}

${skill.content}

---
创建时间: ${skill.createdAt}
更新时间: ${skill.updatedAt}
版本: ${skill.version}
`

  await fs.writeFile(skillPath, content, 'utf-8')
}

/**
 * 读取技能文件
 */
export async function loadSkill(roomId: number, skillId: number): Promise<SkillFile | null> {
  const skillPath = path.join(getRoomDir(roomId), 'skills', `${skillId}.md`)
  try {
    const content = await fs.readFile(skillPath, 'utf-8')

    // 解析内容（从frontmatter中提取）
    const lines = content.split('\n')
    const name = lines[0].replace('# ', '').trim()
    const body = lines.slice(1, lines.indexOf('---')).join('\n').trim()

    return {
      id: skillId,
      name,
      content: body,
      version: 1, // 从内容中解析
      createdAt: '',
      updatedAt: ''
    }
  } catch {
    return null
  }
}

/**
 * 列出公司所有技能
 */
export async function listSkills(roomId: number): Promise<SkillFile[]> {
  const skillsDir = path.join(getRoomDir(roomId), 'skills')
  try {
    await fs.access(skillsDir)
  } catch {
    return []
  }

  const files = await fs.readdir(skillsDir)
  const skills: SkillFile[] = []

  for (const file of files) {
    if (file.endsWith('.md')) {
      const id = parseInt(file.replace('.md', ''))
      const skill = await loadSkill(roomId, id)
      if (skill) {
        skills.push(skill)
      }
    }
  }

  return skills
}

/**
 * 删除技能文件
 */
export async function deleteSkill(roomId: number, skillId: number): Promise<void> {
  const skillPath = path.join(getRoomDir(roomId), 'skills', `${skillId}.md`)
  await fs.unlink(skillPath)
}

// ── 目标文件管理 ───────────────────────────────────────────────────────

export interface GoalFile {
  id: number
  description: string
  status: 'active' | 'completed' | 'cancelled'
  parentId: number | null
  workerId: number | null
  createdAt: string
  updatedAt: string
}

/**
 * 保存目标到文件
 */
export async function saveGoal(roomId: number, goal: GoalFile): Promise<void> {
  await initRoomDir(roomId)
  const goalPath = path.join(getRoomDir(roomId), 'goals', `${goal.id}.json`)
  await fs.writeFile(goalPath, JSON.stringify(goal, null, 2), 'utf-8')
}

/**
 * 读取目标文件
 */
export async function loadGoal(roomId: number, goalId: number): Promise<GoalFile | null> {
  const goalPath = path.join(getRoomDir(roomId), 'goals', `${goalId}.json`)
  try {
    const content = await fs.readFile(goalPath, 'utf-8')
    return JSON.parse(content)
  } catch {
    return null
  }
}

/**
 * 列出房间所有目标
 */
export async function listGoals(roomId: number): Promise<GoalFile[]> {
  const goalsDir = path.join(getRoomDir(roomId), 'goals')
  try {
    await fs.access(goalsDir)
  } catch {
    return []
  }

  const files = await fs.readdir(goalsDir)
  const goals: GoalFile[] = []

  for (const file of files) {
    if (file.endsWith('.json')) {
      const id = parseInt(file.replace('.json', ''))
      const goal = await loadGoal(roomId, id)
      if (goal) {
        goals.push(goal)
      }
    }
  }

  return goals
}

// ── 日志文件管理 ───────────────────────────────────────────────────────

export enum LogType {
  CYCLE = 'cycle',
  CONSOLE = 'console',
}

/**
 * 追加日志到文件
 */
export async function appendLog(
  roomId: number,
  type: LogType,
  logName: string,
  content: string
): Promise<void> {
  await initRoomDir(roomId)

  const date = new Date().toISOString().split('T')[0] // YYYY-MM-DD
  const logPath = path.join(
    getRoomDir(roomId),
    'logs',
    `${type}-${date}.log`
  )

  const timestamp = new Date().toISOString()
  const logEntry = `[${timestamp}] ${logName}\n${content}\n\n`

  await fs.appendFile(logPath, logEntry, 'utf-8')
}

// ── 自我修改审计 ───────────────────────────────────────────────────────

export interface AuditEntry {
  id: number
  roomId: number | null
  workerId: number | null
  filePath: string
  oldHash: string | null
  newHash: string | null
  reason: string
  reversible: boolean
  reverted: boolean
  createdAt: string
}

/**
 * 保存审计日志
 */
export async function saveAuditLog(roomId: number, audit: AuditEntry): Promise<void> {
  await initRoomDir(roomId)
  const auditPath = path.join(
    getRoomDir(roomId),
    'self-mod',
    `audit-${audit.id}.json`
  )
  await fs.writeFile(auditPath, JSON.stringify(audit, null, 2), 'utf-8')
}

/**
 * 读取审计日志
 */
export async function loadAuditLog(roomId: number, auditId: number): Promise<AuditEntry | null> {
  const auditPath = path.join(getRoomDir(roomId), 'self-mod', `audit-${auditId}.json`)
  try {
    const content = await fs.readFile(auditPath, 'utf-8')
    return JSON.parse(content)
  } catch {
    return null
  }
}

// ── 工具函数 ───────────────────────────────────────────────────────────

/**
 * 获取房间磁盘使用情况
 */
export async function getRoomDiskUsage(roomId: number): Promise<{ size: number; fileCount: number }> {
  const roomDir = getRoomDir(roomId)

  let totalSize = 0
  let fileCount = 0

  async function walkDir(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true })

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)

      if (entry.isDirectory()) {
        await walkDir(fullPath)
      } else if (entry.isFile()) {
        const stats = await fs.stat(fullPath)
        totalSize += stats.size
        fileCount++
      }
    }
  }

  try {
    await walkDir(roomDir)
  } catch {
    // 目录不存在
  }

  return { size: totalSize, fileCount }
}

/**
 * 备份房间数据
 */
export async function backupRoom(roomId: number, backupDir: string): Promise<string> {
  const roomDir = getRoomDir(roomId)
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = path.join(backupDir, `room-${roomId}-${timestamp}`)

  // 复制整个房间目录
  await fs.cp(roomDir, backupPath, { recursive: true })

  return backupPath
}

/**
 * 清理已删除的房间数据（保留天数之后）
 */
export async function cleanupDeletedRooms(retentionDays: number = 30): Promise<void> {
  const baseDir = BASE_DIR

  try {
    const rooms = await fs.readdir(baseDir)

    for (const room of rooms) {
      const roomId = parseInt(room)
      if (isNaN(roomId)) continue

      // 检查数据库中是否还存在这个房间
      // 如果不存在，删除文件夹
      // TODO: 实现数据库检查逻辑

      const roomDir = path.join(baseDir, room)
      const stats = await fs.stat(roomDir)

      const age = Date.now() - stats.mtimeMs
      const daysOld = age / (1000 * 60 * 60 * 24)

      if (daysOld > retentionDays) {
        console.log(`清理旧房间数据: ${room}`)
        await fs.rm(roomDir, { recursive: true, force: true })
      }
    }
  } catch {
    // 目录不存在时忽略
  }
}
