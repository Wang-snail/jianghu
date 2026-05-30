import { describe, it, expect, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'
import { initTestDb } from './helpers/test-db'
import * as queries from '../db-queries'
import { createRoom, pauseRoom, restartRoom, deleteRoom, getRoomStatus, DEFAULT_QUEEN_SYSTEM_PROMPT } from '../room'

let db: Database.Database

beforeEach(() => {
  db = initTestDb()
})

describe('createRoom', () => {
  it('creates room with queen and root goal', () => {
    const result = createRoom(db, { name: 'SaaS Builder', goal: 'Build profitable micro-SaaS' })

    expect(result.room.name).toBe('SaaS Builder')
    expect(result.room.status).toBe('active')
    expect(result.room.visibility).toBe('private')
    expect(result.room.autonomyMode).toBe('semi')
    expect(result.room.maxConcurrentTasks).toBe(3)
    expect(result.room.queenWorkerId).toBe(result.queen.id)

    expect(result.queen.name).toBe('SaaS Builder 帮主')
    expect(result.queen.role).toBe('帮主')
    expect(result.queen.systemPrompt).toBe(DEFAULT_QUEEN_SYSTEM_PROMPT)
    expect(result.queen.roomId).toBe(result.room.id)
    expect(result.queen.agentState).toBe('idle')

    expect(result.rootGoal).not.toBeNull()
    expect(result.rootGoal!.description).toBe('Build profitable micro-SaaS')
    expect(result.rootGoal!.roomId).toBe(result.room.id)
  })

  it('seeds visible leader startup work when a gang has an objective', () => {
    const result = createRoom(db, { name: '市场分析帮', goal: '分析除湿机市场机会' })

    const goals = queries.listGoals(db, result.room.id)
    const tasks = queries.listTasks(db, result.room.id)
    const activity = queries.getRoomActivity(db, result.room.id, 20)

    expect(goals.map(g => g.description)).toEqual(expect.arrayContaining([
      '启动工序 1：分析委托目标、边界、交付物和验收标准',
      '启动工序 2：制定人员规划，只从客栈选择可分派弟子',
      '启动工序 3：安排弟子培训和功法配置',
      '启动工序 4：定制协作流程，明确上下游、输出格式和试运行范围',
    ]))
    expect(tasks.map(t => t.name)).toEqual(expect.arrayContaining([
      '启动工序1：目标拆分与验收标准',
      '启动工序2：人员规划与客栈选人',
      '启动工序3：弟子培训与功法配置',
      '启动工序4：协作流程与最小试运行',
    ]))
    expect(tasks.every(t => t.workerId === result.queen.id)).toBe(true)
    expect(tasks.every(t => t.description?.includes('下游接收方'))).toBe(true)
    expect(tasks.every(t => t.prompt.includes('不得偏移委托目标'))).toBe(true)
    expect(activity.some(a => a.summary.includes('帮主启动工序已建立'))).toBe(true)
  })

  it('uses the global queen model for rooms created by tools', () => {
    queries.setSetting(db, 'queen_model', 'codex')

    const result = createRoom(db, { name: 'Tool Created', goal: 'Run locally' })

    expect(result.queen.model).toBe('codex')
    expect(result.room.workerModel).toBe('queen')
  })

  it('creates room without goal', () => {
    const result = createRoom(db, { name: 'Empty Room' })
    expect(result.room.name).toBe('Empty Room')
    expect(result.rootGoal).toBeNull()
  })

  it('uses custom queen system prompt', () => {
    const result = createRoom(db, {
      name: 'Custom', goal: 'Test',
      queenSystemPrompt: 'You are a custom queen.'
    })
    expect(result.queen.systemPrompt).toBe('You are a custom queen.')
  })

  it('applies custom room config', () => {
    const result = createRoom(db, {
      name: 'Custom Config', goal: 'Test',
      config: { threshold: 'unanimous', timeoutMinutes: 120 }
    })
    expect(result.room.config.threshold).toBe('unanimous')
    expect(result.room.config.timeoutMinutes).toBe(120)
    // Defaults preserved
    expect(result.room.config.tieBreaker).toBe('queen')
  })

  it('logs creation activity', () => {
    const result = createRoom(db, { name: 'Activity Test', goal: 'Goal' })
    const activity = queries.getRoomActivity(db, result.room.id)
    expect(activity).toHaveLength(3) // startup plan + room creation + wallet creation
    expect(activity.some(a => a.summary.includes('Activity Test'))).toBe(true)
    expect(activity.some(a => a.summary.includes('帮主启动工序已建立'))).toBe(true)
    const financialEntry = activity.find(a => a.eventType === 'financial')!
    expect(financialEntry.summary).toContain('Wallet created')
  })
})

describe('pauseRoom', () => {
  it('pauses room and all workers', () => {
    const result = createRoom(db, { name: 'Pause Test', goal: 'Test' })
    queries.updateAgentState(db, result.queen.id, 'thinking')

    pauseRoom(db, result.room.id)

    const room = queries.getRoom(db, result.room.id)!
    expect(room.status).toBe('paused')

    const queen = queries.getWorker(db, result.queen.id)!
    expect(queen.agentState).toBe('idle')
  })

  it('throws for nonexistent room', () => {
    expect(() => pauseRoom(db, 999)).toThrow('Room 999 not found')
  })

  it('logs pause activity', () => {
    const result = createRoom(db, { name: 'Pause Log', goal: 'Test' })
    pauseRoom(db, result.room.id)
    const activity = queries.getRoomActivity(db, result.room.id)
    expect(activity.some(a => a.summary.includes('闭关'))).toBe(true)
  })
})

describe('restartRoom', () => {
  it('clears goals, decisions, escalations and resets workers', () => {
    const result = createRoom(db, { name: 'Restart Test', goal: 'Old goal' })
    // Add some data
    queries.createGoal(db, result.room.id, 'Sub goal', result.rootGoal!.id)
    queries.createDecision(db, result.room.id, result.queen.id, 'Proposal', 'strategy')
    queries.createEscalation(db, result.room.id, result.queen.id, 'Help needed')

    restartRoom(db, result.room.id, 'New goal')

    const room = queries.getRoom(db, result.room.id)!
    expect(room.status).toBe('active')
    expect(room.goal).toBe('New goal')

    // Old goals, decisions, escalations deleted
    expect(queries.listGoals(db, result.room.id).length).toBe(1) // only the new root goal
    expect(queries.listDecisions(db, result.room.id).length).toBe(0)
    expect(queries.getPendingEscalations(db, result.room.id).length).toBe(0)

    // New root goal created
    const goals = queries.listGoals(db, result.room.id)
    expect(goals[0].description).toBe('New goal')
  })

  it('keeps original goal if no new goal', () => {
    const result = createRoom(db, { name: 'Keep Goal', goal: 'Original' })
    restartRoom(db, result.room.id)
    const room = queries.getRoom(db, result.room.id)!
    expect(room.goal).toBe('Original')
  })
})

describe('deleteRoom', () => {
  it('deletes room and all workers', () => {
    const result = createRoom(db, { name: 'Delete Test', goal: 'Test' })
    const queenId = result.queen.id

    deleteRoom(db, result.room.id)

    expect(queries.getRoom(db, result.room.id)).toBeNull()
    expect(queries.getWorker(db, queenId)).toBeNull()
  })

  it('throws for nonexistent room', () => {
    expect(() => deleteRoom(db, 999)).toThrow('Room 999 not found')
  })
})

describe('getRoomStatus', () => {
  it('returns comprehensive room status', () => {
    const result = createRoom(db, { name: 'Status Test', goal: 'Goal' })
    // Add a worker
    queries.createWorker(db, { name: 'Worker', systemPrompt: 'prompt', roomId: result.room.id })

    const status = getRoomStatus(db, result.room.id)
    expect(status.room.name).toBe('Status Test')
    expect(status.workers).toHaveLength(2) // queen + worker
    expect(status.activeGoals).toHaveLength(5) // root goal + leader startup goals
    expect(status.pendingDecisions).toBe(0)
  })

  it('throws for nonexistent room', () => {
    expect(() => getRoomStatus(db, 999)).toThrow('Room 999 not found')
  })
})
