import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runMigrations } from '../db-migrations'
import { CLERK_ASSISTANT_SYSTEM_PROMPT } from '../clerk-profile-config'

let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
  runMigrations(db, () => {})
})

afterEach(() => {
  db.close()
})

describe('runMigrations', () => {
  it('upgrades only legacy queen_max_turns fallback values', () => {
    db.prepare('INSERT INTO rooms (name, queen_max_turns) VALUES (?, ?)').run('legacy', 3)
    db.prepare('INSERT INTO rooms (name, queen_max_turns) VALUES (?, ?)').run('default30', 30)
    db.prepare('INSERT INTO rooms (name, queen_max_turns) VALUES (?, ?)').run('custom70', 70)

    const logs: string[] = []
    runMigrations(db, (msg) => logs.push(msg))

    const rows = db.prepare('SELECT name, queen_max_turns AS queenMaxTurns FROM rooms').all() as Array<{
      name: string
      queenMaxTurns: number
    }>
    const byName = new Map(rows.map((row) => [row.name, row.queenMaxTurns]))

    expect(byName.get('legacy')).toBe(50)
    expect(byName.get('default30')).toBe(30)
    expect(byName.get('custom70')).toBe(70)
    expect(logs).toContain('Migrated: updated 1 room(s) queen_max_turns from 3 to 50')
  })

  it('does not log legacy queen_max_turns migration when no rooms need update', () => {
    db.prepare('INSERT INTO rooms (name, queen_max_turns) VALUES (?, ?)').run('already50', 50)
    db.prepare('INSERT INTO rooms (name, queen_max_turns) VALUES (?, ?)').run('explicit30', 30)

    const logs: string[] = []
    runMigrations(db, (msg) => logs.push(msg))

    expect(logs.some((msg) => msg.includes('queen_max_turns from 3 to 50'))).toBe(false)
  })

  it('renames legacy executor workers to Chinese disciple names without collisions', () => {
    db.prepare(`INSERT INTO workers (name, role, system_prompt) VALUES (?, ?, ?)`)
      .run('执行弟子-1', 'executor', 'prompt')
    db.prepare(`INSERT INTO workers (name, role, system_prompt) VALUES (?, ?, ?)`)
      .run('executor-1', 'executor', 'prompt')

    const logs: string[] = []
    runMigrations(db, (msg) => logs.push(msg))

    const names = db.prepare(`SELECT name FROM workers ORDER BY id`).all() as { name: string }[]
    expect(names.map((row) => row.name)).toContain('执行弟子-1')
    expect(names.map((row) => row.name)).toContain('执行弟子-2')
    expect(names.map((row) => row.name)).not.toContain('executor-1')
    expect(logs).toContain('Migrated: renamed 1 legacy executor worker(s) to Chinese disciple names')
  })

  it('normalizes legacy company coordinators to gang leaders', () => {
    const roomId = db.prepare(`INSERT INTO rooms (name, goal) VALUES (?, ?)`).run('功能验收', '验证').lastInsertRowid as number
    const workerId = db.prepare(`
      INSERT INTO workers (name, role, system_prompt, description, room_id)
      VALUES (?, ?, ?, ?, ?)
    `).run('功能验收 小老板', '小老板', '你是公司的小老板，负责调度员工。', '旧描述', roomId).lastInsertRowid as number
    db.prepare(`UPDATE rooms SET queen_worker_id = ? WHERE id = ?`).run(workerId, roomId)

    const logs: string[] = []
    runMigrations(db, (msg) => logs.push(msg))

    const row = db.prepare(`SELECT name, role, system_prompt AS systemPrompt, description, is_default AS isDefault FROM workers WHERE id = ?`)
      .get(workerId) as { name: string; role: string; systemPrompt: string; description: string; isDefault: number }
    expect(row.name).toBe('功能验收 帮主')
    expect(row.role).toBe('帮主')
    expect(row.systemPrompt).toContain('你是帮主')
    expect(row.systemPrompt).toContain('从客栈选择合适弟子')
    expect(row.description).toContain('帮派负责人')
    expect(row.isDefault).toBe(1)
    expect(logs).toContain('Migrated: normalized 1 legacy coordinator worker(s) to gang leader')
  })

  it('refreshes stale gang leader prompts, legacy nicknames, and old WIP notes', () => {
    const roomId = db.prepare(`INSERT INTO rooms (name, goal, queen_nickname) VALUES (?, ?, ?)`)
      .run('旧帮派', '验证', '小老板四号').lastInsertRowid as number
    const workerId = db.prepare(`
      INSERT INTO workers (name, role, system_prompt, description, room_id, wip)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('旧帮派 天机阁', '天机阁', '你是天机阁，但先创建一个执行弟子。', '旧描述', roomId, '按公司目标通知员工 executor-1')
      .lastInsertRowid as number
    db.prepare(`UPDATE rooms SET queen_worker_id = ? WHERE id = ?`).run(workerId, roomId)

    const logs: string[] = []
    runMigrations(db, (msg) => logs.push(msg))

    const worker = db.prepare(`SELECT system_prompt AS systemPrompt, description, wip FROM workers WHERE id = ?`)
      .get(workerId) as { systemPrompt: string; description: string; wip: string | null }
    const room = db.prepare(`SELECT queen_nickname AS queenNickname FROM rooms WHERE id = ?`)
      .get(roomId) as { queenNickname: string }
    expect(worker.systemPrompt).toContain('从客栈选择合适弟子')
    expect(worker.description).toContain('从客栈选择弟子')
    expect(worker.wip).toBeNull()
    expect(room.queenNickname).toBe('帮主四号')
    expect(logs).toContain('Migrated: normalized 1 legacy coordinator worker(s) to gang leader')
    expect(logs).toContain('Migrated: normalized 1 legacy gang leader nickname(s)')
    expect(logs).toContain('Migrated: cleared 1 stale legacy WIP note(s)')
  })

  it('normalizes the global Clerk worker into Tianji assistant metadata', () => {
    const workerId = db.prepare(`
      INSERT INTO workers (name, role, system_prompt, description)
      VALUES (?, ?, ?, ?)
    `).run('Clerk', 'clerk', 'old prompt', 'Global assistant for the keeper.').lastInsertRowid as number
    db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`).run('clerk_worker_id', String(workerId))

    const logs: string[] = []
    runMigrations(db, (msg) => logs.push(msg))

    const row = db.prepare(`SELECT name, role, system_prompt AS systemPrompt, description, room_id AS roomId, is_default AS isDefault FROM workers WHERE id = ?`)
      .get(workerId) as { name: string; role: string; systemPrompt: string; description: string; roomId: number | null; isDefault: number }
    expect(row.name).toBe('天机阁总管')
    expect(row.role).toBe('clerk')
    expect(row.systemPrompt).toBe(CLERK_ASSISTANT_SYSTEM_PROMPT)
    expect(row.description).toContain('全局天机阁助手')
    expect(row.roomId).toBeNull()
    expect(row.isDefault).toBe(0)
    expect(logs).toContain('Migrated: normalized global Tianji assistant worker')
  })
})
