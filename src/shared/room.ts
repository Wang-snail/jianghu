import crypto from 'crypto'
import type Database from 'better-sqlite3'
import type { Room, Worker, Goal, Wallet, CreateRoomInput, RoomConfig } from './types'
import * as queries from './db-queries'
import { DEFAULT_ROOM_CONFIG } from './constants'
import { setRoomObjective } from './goals'
import { createRoomWallet } from './wallet'
import { getGlobalModel } from './model-provider'

export const DEFAULT_QUEEN_SYSTEM_PROMPT = `你是帮主，负责让这支帮派围绕委托目标持续运转。

你的职责：接收用户委托，拆解镖单，调度帮派，从客栈选择合适弟子，分派押运任务，检查进度，解决阻塞，并向用户交付结果。

帮主工作流必须按顺序推进：
1. 先分析委托目标：明确真正要解决的问题、不可偏移的目标边界、交付物和验收标准。
2. 先回忆经验：查看帮派记忆、历史复盘和相近任务打法；没有可用经验时，也要记录“本次从零开始”的判断，避免重复踩坑。
3. 制定作战计划：拆成可执行镖单，标出依赖顺序、关键风险、预算/时间约束和最小试运行范围，并把计划写入帮派共享资料或帮派记忆。
4. 安排弟子：只能从客栈挑选和调入弟子；不得把天机阁、帮主或其他帮派成员当成可分派弟子。分派时必须说明上游输入、下游接收方、输出格式限制、验收标准和禁止偏移事项。
5. 开始一次试运行：先用最小样本或最小步骤跑通链路，确认输入、输出和交接格式可用。
6. 监督运行过程：持续查看弟子产出、通讯和阻塞，不直接替弟子长期执行。
7. 发现问题先定位根因：判断是目标理解、分工、数据、工具、格式、预算还是弟子能力问题，再更正计划、补充说明、换人或拆小镖单。
8. 继续运行并复核目标：每轮都检查当前动作是否仍服务原委托目标；发现偏移必须立刻拉回，不得为了产出而扩写无关内容。
9. 结果可验收后，汇总证据、交付结果、沉淀经验，并关闭或暂停不应继续循环的镖单。

每个循环必须做这些事：
1. 查看弟子消息、委托进展、藏经阁记忆、待处理镖单和上一轮计划。
2. 先使用可用记忆判断有没有类似任务经验、失败原因、可复用流程或验收标准；有则继承，没有则说明当前缺少经验。
3. 如果还没有作战计划，先生成计划并保存到帮派共享资料或帮派记忆。
4. 如果还没有明确分派，按计划给弟子发带上下游和格式限制的镖单。
5. 如果工作完成，汇总可检查结果并推进下一步。
6. 如果工作卡住，明确阻塞原因，调整指令、拆小镖单、补充弟子或发起议事堂。
7. 如果当前帮派没有可执行弟子，先去客栈选择弟子；客栈没有合适人选时，先把新弟子登记到客栈，再调入当前帮派。
8. 如果你无法独立判断，发起议事堂会议并邀请相关弟子参与讨论。
9. 每次完成、返工、阻塞或纠偏后，都要把可复用经验沉淀为帮派记忆：什么判断有效、什么路径失败、下次如何更快完成。

你必须优先使用本地软件提供的工具完成创建、关闭、修改、信息传递、镖单分派、藏经阁记忆保存和功法沉淀。不要要求用户去外部平台完成初始化，也不要把本地可以完成的动作推给用户。

你不是天机阁。天机阁是整个江湖唯一的中央入口；你是当前帮派的帮主，只负责本帮派内部运转。

你不是聊天摆设，你是帮派负责人。保持作战室视角：从客栈选弟子、分派镖单、监控交付、解除阻塞、报告结果。`

export interface RoomCreateResult {
  room: Room
  queen: Worker
  rootGoal: Goal | null
  wallet: Wallet
}

interface StartupWorkSpec {
  goal: string
  taskName: string
  description: string
  prompt: string
}

function buildStartupWork(goal: string): StartupWorkSpec[] {
  return [
    {
      goal: '启动工序 1：分析委托目标、边界、交付物和验收标准',
      taskName: '启动工序1：目标拆分与验收标准',
      description: [
        '帮主先把委托拆成可执行工序，明确什么算完成。',
        '流程序号：1',
        '上游输入：用户委托目标',
        '下游接收方：人员规划与客栈选人',
        '输出格式：目标边界、交付物清单、验收标准、禁止偏移事项',
      ].join('\n'),
      prompt: [
        `委托目标：${goal}`,
        '请先分析目标：用户真正要解决什么问题、目标边界是什么、最终交付物是什么、验收标准是什么。',
        '输出必须包含：目标理解、任务边界、交付物、验收标准、风险和禁止偏移事项。',
        '不得偏移委托目标，不得直接跳到执行结果。',
      ].join('\n'),
    },
    {
      goal: '启动工序 2：制定人员规划，只从客栈选择可分派弟子',
      taskName: '启动工序2：人员规划与客栈选人',
      description: [
        '帮主根据任务工序规划需要哪些弟子，并只从客栈挑选可分派弟子。',
        '流程序号：2',
        '上游输入：目标拆分与验收标准',
        '下游接收方：弟子培训与功法配置',
        '输出格式：岗位需求单、候选弟子、选择理由、空缺与替代方案',
      ].join('\n'),
      prompt: [
        `委托目标：${goal}`,
        '请制定人员规划：每个工序需要什么岗位、为什么需要、从客栈选择哪些弟子、每个弟子负责什么。',
        '只能选择客栈中可分派弟子；不得把天机阁、帮主或其他帮派成员当作执行弟子。',
        '不得偏移委托目标，缺人时先记录空缺和替代方案。',
      ].join('\n'),
    },
    {
      goal: '启动工序 3：安排弟子培训和功法配置',
      taskName: '启动工序3：弟子培训与功法配置',
      description: [
        '帮主为每个弟子说明接单前需要补齐的上下文、功法和输出模板。',
        '流程序号：3',
        '上游输入：人员规划与客栈选人',
        '下游接收方：协作流程与最小试运行',
        '输出格式：弟子训练清单、功法配置、输入资料、输出模板、检查点',
      ].join('\n'),
      prompt: [
        `委托目标：${goal}`,
        '请为已选弟子制定培训与功法配置：每个弟子需要知道什么、使用什么功法、按什么模板输出、交付前如何自查。',
        '培训内容必须服务本次委托，不要做泛泛角色介绍。',
        '不得偏移委托目标，训练结果要能进入后续协作流程。',
      ].join('\n'),
    },
    {
      goal: '启动工序 4：定制协作流程，明确上下游、输出格式和试运行范围',
      taskName: '启动工序4：协作流程与最小试运行',
      description: [
        '帮主把弟子协作关系落成可视化流程，并先跑最小样本验证交接。',
        '流程序号：4',
        '上游输入：弟子训练清单、功法配置和输出模板',
        '下游接收方：帮主监督运行与验收',
        '输出格式：协作流程图、每个节点上下游、最小试运行范围、问题定位规则',
      ].join('\n'),
      prompt: [
        `委托目标：${goal}`,
        '请定制协作流程：每个弟子的上游是谁、下游是谁、输入是什么、输出格式是什么、哪一步先试运行。',
        '开始时只跑最小试运行，验证输入、输出和交接格式可用，再扩大执行。',
        '不得偏移委托目标；发现问题先定位根因，再调整流程或分工。',
      ].join('\n'),
    },
  ]
}

function seedLeaderStartupWork(
  db: Database.Database,
  roomId: number,
  queenId: number,
  rootGoal: Goal | null,
  objective: string | null | undefined
): void {
  const goal = objective?.trim()
  if (!goal) return

  const existingTasks = queries.listTasks(db, roomId)
  if (existingTasks.some(task => task.name.startsWith('启动工序'))) return

  const startupWork = buildStartupWork(goal)
  for (const item of startupWork) {
    queries.createGoal(db, roomId, item.goal, rootGoal?.id, queenId)
    queries.createTask(db, {
      name: item.taskName,
      description: item.description,
      prompt: item.prompt,
      triggerType: 'manual',
      executor: 'claude_code',
      workerId: queenId,
      roomId,
      maxRuns: 1,
      timeoutMinutes: 15,
      maxTurns: 6,
    })
  }

  const memory = queries.createEntity(db, '帮派启动章程', 'runbook', 'startup', roomId)
  queries.addObservation(db, memory.id, [
    `委托目标：${goal}`,
    '帮主启动顺序：先目标拆分和验收标准，再人员规划与客栈选人，再弟子培训与功法配置，最后定制协作流程和最小试运行。',
    '每次分派必须写清上游输入、下游接收方、输出格式、验收标准和禁止偏移事项。',
  ].join('\n'), 'system')

  queries.updateWorkerWip(db, queenId, [
    `新帮派启动：${goal}`,
    '下一轮先完成启动工序1：目标拆分与验收标准。',
    '随后按顺序推进人员规划、弟子培训、协作流程和最小试运行；不要跳过准备工序直接产出结论。',
  ].join('\n'))

  queries.logRoomActivity(
    db,
    roomId,
    'system',
    '帮主启动工序已建立：目标拆分、人员规划、弟子培训和协作流程会先行推进。',
    startupWork.map(item => `- ${item.taskName}`).join('\n'),
    queenId
  )
}

export function createRoom(db: Database.Database, input: CreateRoomInput): RoomCreateResult {
  const config: RoomConfig = { ...DEFAULT_ROOM_CONFIG, ...input.config }
  const room = queries.createRoom(db, input.name, input.goal, config)
  const defaultQueenModel =
    input.queenModel?.trim()
    || getGlobalModel(db)
    || null

  // Create per-room gang leader. The schema still calls this queen_worker_id for compatibility,
  // but user-facing semantics are "帮主"; Tianji is global only.
  const queen = queries.createWorker(db, {
    name: `${input.name} 帮主`,
    role: '帮主',
    description: '帮派负责人，负责分析目标、制定计划、从客栈选择弟子、分派带上下游限制的镖单、试运行、监控交付、纠偏和组织议事堂。',
    systemPrompt: input.queenSystemPrompt ?? DEFAULT_QUEEN_SYSTEM_PROMPT,
    model: defaultQueenModel ?? undefined,
    isDefault: true,
    roomId: room.id,
    agentState: 'idle'
  })

  // Link queen to room
  queries.updateRoom(db, room.id, {
    queenWorkerId: queen.id,
    ...(defaultQueenModel ? { workerModel: 'queen' } : {})
  })

  // Create root goal from objective
  let rootGoal: Goal | null = null
  if (input.goal) {
    rootGoal = setRoomObjective(db, room.id, input.goal)
  }

  seedLeaderStartupWork(db, room.id, queen.id, rootGoal, input.goal)

  // Auto-create wallet with deterministic encryption key
  const encryptionKey = crypto.createHash('sha256')
    .update(`jianghu-wallet-${room.id}-${room.name}`)
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
