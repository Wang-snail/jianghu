import crypto from 'crypto'
import type Database from 'better-sqlite3'
import type { Room, Worker, Goal, Wallet, CreateRoomInput, RoomConfig } from './types'
import * as queries from './db-queries'
import { DEFAULT_ROOM_CONFIG } from './constants'
import { setRoomObjective } from './goals'
import { createRoomWallet } from './wallet'

export const DEFAULT_QUEEN_SYSTEM_PROMPT = `你是天机阁，负责让这支帮派围绕委托目标持续运转。

你的职责：接收用户委托，拆解镖单，调度帮派，选择或创建合适弟子，分派押运任务，检查进度，解决阻塞，并向用户交付结果。

每个循环必须做这些事：
1. 查看弟子消息、委托进展、藏经阁记忆和待处理镖单。
2. 如果工作完成，汇总可检查结果并推进下一步。
3. 如果工作卡住，明确阻塞原因，调整指令、拆小镖单或补充弟子。
4. 如果当前帮派没有可执行弟子，先创建一个执行弟子。
5. 如果需要新工作，分派给合适弟子并跟进。
6. 如果你无法独立判断，发起议事堂会议并邀请相关弟子参与讨论。

你必须优先使用本地软件提供的工具完成创建、关闭、修改、信息传递、镖单分派、藏经阁记忆保存和功法沉淀。不要要求用户去外部平台完成初始化，也不要把本地可以完成的动作推给用户。

你不是聊天摆设，你是江湖中央调度层。保持驾驶舱视角：创建弟子、分派镖单、监控交付、解除阻塞、报告结果。`

export interface RoomCreateResult {
  room: Room
  queen: Worker
  rootGoal: Goal | null
  wallet: Wallet
}

export function createRoom(db: Database.Database, input: CreateRoomInput): RoomCreateResult {
  const config: RoomConfig = { ...DEFAULT_ROOM_CONFIG, ...input.config }
  const room = queries.createRoom(db, input.name, input.goal, config)

  // Create Tianji dispatcher worker
  const queen = queries.createWorker(db, {
    name: `${input.name} 天机阁`,
    role: '天机阁',
    description: '中央调度层，负责拆解委托、创建弟子、分派镖单、监控交付、解除阻塞和组织议事堂。',
    systemPrompt: input.queenSystemPrompt ?? DEFAULT_QUEEN_SYSTEM_PROMPT,
    isDefault: true,
    roomId: room.id,
    agentState: 'idle'
  })

  // Link queen to room
  queries.updateRoom(db, room.id, { queenWorkerId: queen.id })

  // Create root goal from objective
  let rootGoal: Goal | null = null
  if (input.goal) {
    rootGoal = setRoomObjective(db, room.id, input.goal)
  }

  // Auto-create wallet with deterministic encryption key
  const encryptionKey = crypto.createHash('sha256')
    .update(`zuzu-wallet-${room.id}-${room.name}`)
    .digest('hex')
  const wallet = createRoomWallet(db, room.id, encryptionKey)

  queries.logRoomActivity(db, room.id, 'system',
    `帮派「${input.name}」已创建${input.goal ? `，委托：${input.goal}` : ''}`,
    undefined, queen.id)

  return {
    room: queries.getRoom(db, room.id)!,
    queen,
    rootGoal,
    wallet
  }
}

export function pauseRoom(db: Database.Database, roomId: number): void {
  const room = queries.getRoom(db, roomId)
  if (!room) throw new Error(`Room ${roomId} not found`)

  queries.updateRoom(db, roomId, { status: 'paused' })

  // Set all workers to idle
  const workers = queries.listRoomWorkers(db, roomId)
  for (const w of workers) {
    queries.updateAgentState(db, w.id, 'idle')
  }

  queries.logRoomActivity(db, roomId, 'system', '帮派已闭关，活跃镖单会显示为阻塞状态')
}

export function restartRoom(db: Database.Database, roomId: number, newGoal?: string): void {
  const room = queries.getRoom(db, roomId)
  if (!room) throw new Error(`Room ${roomId} not found`)

  // Delete goals, decisions, escalations (hard stop)
  db.prepare('DELETE FROM goals WHERE room_id = ?').run(roomId)
  db.prepare('DELETE FROM quorum_decisions WHERE room_id = ?').run(roomId)
  db.prepare('DELETE FROM escalations WHERE room_id = ?').run(roomId)

  // Reset workers
  const workers = queries.listRoomWorkers(db, roomId)
  for (const w of workers) {
    queries.updateAgentState(db, w.id, 'idle')
  }

  // Reactivate room
  queries.updateRoom(db, roomId, { status: 'active', goal: newGoal ?? room.goal })

  // Create new root goal
  if (newGoal) {
    setRoomObjective(db, roomId, newGoal)
  }

  queries.logRoomActivity(db, roomId, 'system',
    `帮派已重新出山${newGoal ? `，新委托：${newGoal}` : ''}`)
}

export function deleteRoom(db: Database.Database, roomId: number): void {
  const room = queries.getRoom(db, roomId)
  if (!room) throw new Error(`Room ${roomId} not found`)

  // Delete workers in this room
  const workers = queries.listRoomWorkers(db, roomId)
  for (const w of workers) {
    queries.deleteWorker(db, w.id)
  }

  queries.deleteRoom(db, roomId)
}

export interface RoomStatusResult {
  room: Room
  workers: Worker[]
  activeGoals: Goal[]
  pendingDecisions: number
}

export function getRoomStatus(db: Database.Database, roomId: number): RoomStatusResult {
  const room = queries.getRoom(db, roomId)
  if (!room) throw new Error(`Room ${roomId} not found`)

  const workers = queries.listRoomWorkers(db, roomId)
  const activeGoals = queries.listGoals(db, roomId).filter(
    g => g.status === 'active' || g.status === 'in_progress'
  )
  const pendingDecisions = queries.listDecisions(db, roomId, 'voting').length

  return { room, workers, activeGoals, pendingDecisions }
}
