import type Database from 'better-sqlite3'
import { randomBytes } from 'crypto'
import { SCHEMA } from './schema'
import { pickQueenNickname } from './db-queries'
import { CLERK_ASSISTANT_SYSTEM_PROMPT } from './clerk-profile-config'
import { DEFAULT_QUEEN_SYSTEM_PROMPT } from './room'

const CLERK_DISPLAY_NAME = '天机阁总管'
const CLERK_DESCRIPTION = '全局天机阁助手，负责和用户对话、了解江湖状态并执行本地管理动作。'
const GANG_LEADER_DESCRIPTION = '帮派负责人，负责分析目标、制定计划、从客栈选择弟子、分派带上下游限制的镖单、试运行、监控交付、纠偏和组织议事堂。'

function upsertSetting(database: Database.Database, key: string, value: string): void {
  database.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now','localtime'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, value)
}

function nextDiscipleName(existingNames: Set<string>, preferredIndex: number): string {
  let index = Math.max(1, preferredIndex)
  let candidate = `执行弟子-${index}`
  while (existingNames.has(candidate.toLowerCase())) {
    index += 1
    candidate = `执行弟子-${index}`
  }
  existingNames.add(candidate.toLowerCase())
  return candidate
}

export function runMigrations(database: Database.Database, log: (msg: string) => void = console.log): void {
  database.exec(SCHEMA)

  // Upgrade legacy room fallback (3 turns) to the new default (50 turns)
  const legacyQueenTurnsUpdated = database
    .prepare(`UPDATE rooms SET queen_max_turns = 50 WHERE queen_max_turns = 3`)
    .run()
    .changes
  if (legacyQueenTurnsUpdated > 0) {
    log(`Migrated: updated ${legacyQueenTurnsUpdated} room(s) queen_max_turns from 3 to 50`)
  }

  // Keeper-level referral code (global, one per keeper)
  if (!database.prepare('SELECT value FROM settings WHERE key = ?').get('keeper_referral_code')) {
    const code = randomBytes(6).toString('base64url').slice(0, 10)
    upsertSetting(database, 'keeper_referral_code', code)
  }

  // Keeper user number (stable 5-digit ID, same across all rooms, used in queen email addresses)
  if (!database.prepare('SELECT value FROM settings WHERE key = ?').get('keeper_user_number')) {
    const num = String(10000 + Math.floor(Math.random() * 90000))
    upsertSetting(database, 'keeper_user_number', num)
    log(`Migrated: assigned keeper_user_number=${num}`)
  }

  // Add queen_nickname column to rooms if missing
  const hasQueenNickname = (database.prepare(
    `SELECT name FROM pragma_table_info('rooms') WHERE name='queen_nickname'`
  ).get() as { name: string } | undefined)?.name
  if (!hasQueenNickname) {
    database.exec(`ALTER TABLE rooms ADD COLUMN queen_nickname TEXT`)
    log('Migrated: added queen_nickname column to rooms')
  }

  // Auto-populate queen_nickname for existing rooms that don't have one
  const roomsWithoutNickname = database
    .prepare(`SELECT id FROM rooms WHERE queen_nickname IS NULL OR queen_nickname = ''`)
    .all() as { id: number }[]
  if (roomsWithoutNickname.length > 0) {
    for (const room of roomsWithoutNickname) {
      const nickname = pickQueenNickname(database)
      database.prepare(`UPDATE rooms SET queen_nickname = ? WHERE id = ?`).run(nickname, room.id)
    }
    log(`Migrated: assigned queen nicknames to ${roomsWithoutNickname.length} room(s)`)
  }

  // Add expected completion time to goals for target management.
  const hasGoalExpectedCompletedAt = (database.prepare(
    `SELECT name FROM pragma_table_info('goals') WHERE name='expected_completed_at'`
  ).get() as { name: string } | undefined)?.name
  if (!hasGoalExpectedCompletedAt) {
    database.exec(`ALTER TABLE goals ADD COLUMN expected_completed_at DATETIME`)
    log('Migrated: added expected_completed_at column to goals')
  }

  // Add webhook_token to tasks
  const hasTaskWebhookToken = (database.prepare(
    `SELECT name FROM pragma_table_info('tasks') WHERE name='webhook_token'`
  ).get() as { name: string } | undefined)?.name
  if (!hasTaskWebhookToken) {
    database.exec(`ALTER TABLE tasks ADD COLUMN webhook_token TEXT`)
    log('Migrated: added webhook_token column to tasks')
  }
  const hasTaskWebhookIndex = (database.prepare(
    `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_tasks_webhook_token'`
  ).get() as { name: string } | undefined)?.name
  if (!hasTaskWebhookIndex) {
    database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_webhook_token ON tasks(webhook_token) WHERE webhook_token IS NOT NULL`)
  }

  // Add webhook_token to rooms
  const hasRoomWebhookToken = (database.prepare(
    `SELECT name FROM pragma_table_info('rooms') WHERE name='webhook_token'`
  ).get() as { name: string } | undefined)?.name
  if (!hasRoomWebhookToken) {
    database.exec(`ALTER TABLE rooms ADD COLUMN webhook_token TEXT`)
    log('Migrated: added webhook_token column to rooms')
  }
  const hasRoomWebhookIndex = (database.prepare(
    `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_rooms_webhook_token'`
  ).get() as { name: string } | undefined)?.name
  if (!hasRoomWebhookIndex) {
    database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_rooms_webhook_token ON rooms(webhook_token) WHERE webhook_token IS NOT NULL`)
  }

  // Add token usage columns to worker_cycles
  const hasCycleInputTokens = (database.prepare(
    `SELECT name FROM pragma_table_info('worker_cycles') WHERE name='input_tokens'`
  ).get() as { name: string } | undefined)?.name
  if (!hasCycleInputTokens) {
    database.exec(`ALTER TABLE worker_cycles ADD COLUMN input_tokens INTEGER`)
    database.exec(`ALTER TABLE worker_cycles ADD COLUMN output_tokens INTEGER`)
    log('Migrated: added token usage columns to worker_cycles')
  }

  // Add cycle_gap_ms and max_turns to workers (per-worker execution profiles)
  const hasWorkerCycleGap = (database.prepare(
    `SELECT name FROM pragma_table_info('workers') WHERE name='cycle_gap_ms'`
  ).get() as { name: string } | undefined)?.name
  if (!hasWorkerCycleGap) {
    database.exec(`ALTER TABLE workers ADD COLUMN cycle_gap_ms INTEGER`)
    database.exec(`ALTER TABLE workers ADD COLUMN max_turns INTEGER`)
    log('Migrated: added cycle_gap_ms and max_turns columns to workers')
  }

  // Add allowed_tools to rooms (tool filtering per room)
  const hasRoomAllowedTools = (database.prepare(
    `SELECT name FROM pragma_table_info('rooms') WHERE name='allowed_tools'`
  ).get() as { name: string } | undefined)?.name
  if (!hasRoomAllowedTools) {
    database.exec(`ALTER TABLE rooms ADD COLUMN allowed_tools TEXT`)
    log('Migrated: added allowed_tools column to rooms')
  }

  // Add wip (work-in-progress) column to workers
  const hasWorkerWip = (database.prepare(
    `SELECT name FROM pragma_table_info('workers') WHERE name='wip'`
  ).get() as { name: string } | undefined)?.name
  if (!hasWorkerWip) {
    database.exec(`ALTER TABLE workers ADD COLUMN wip TEXT`)
    log('Migrated: added wip column to workers')
  }

  // Add effective_at column to quorum_decisions (announce-and-object governance)
  const hasEffectiveAt = (database.prepare(
    `SELECT name FROM pragma_table_info('quorum_decisions') WHERE name='effective_at'`
  ).get() as { name: string } | undefined)?.name
  if (!hasEffectiveAt) {
    database.exec(`ALTER TABLE quorum_decisions ADD COLUMN effective_at DATETIME`)
    log('Migrated: added effective_at column to quorum_decisions')
  }

  // Migrate ollama models → 'claude' (ollama removed in v0.1.12+)
  const ollamaWorkers = database
    .prepare(`SELECT id FROM workers WHERE model LIKE 'ollama:%'`)
    .all() as { id: number }[]
  if (ollamaWorkers.length > 0) {
    database.prepare(`UPDATE workers SET model = 'claude' WHERE model LIKE 'ollama:%'`).run()
    log(`Migrated: reset ${ollamaWorkers.length} ollama worker model(s) to 'claude'`)
  }
  const ollamaRooms = database
    .prepare(`SELECT id FROM rooms WHERE worker_model LIKE 'ollama:%'`)
    .all() as { id: number }[]
  if (ollamaRooms.length > 0) {
    database.prepare(`UPDATE rooms SET worker_model = 'claude' WHERE worker_model LIKE 'ollama:%'`).run()
    log(`Migrated: reset ${ollamaRooms.length} room worker_model(s) to 'claude'`)
  }

  // Remove auto mode: all rooms operate in semi mode.
  database.prepare(`UPDATE rooms SET autonomy_mode = 'semi' WHERE autonomy_mode IS NULL OR autonomy_mode != 'semi'`).run()

  // Normalize legacy auto-created English executor names.
  const workerNames = new Set(
    (database.prepare(`SELECT name FROM workers`).all() as { name: string }[])
      .map((row) => row.name.toLowerCase())
  )
  const legacyExecutors = database
    .prepare(`SELECT id, name FROM workers WHERE role = 'executor' AND name LIKE 'executor-%'`)
    .all() as { id: number; name: string }[]
  let renamedExecutors = 0
  for (const worker of legacyExecutors) {
    const match = worker.name.match(/^executor-(\d+)$/i)
    if (!match) continue
    workerNames.delete(worker.name.toLowerCase())
    const nextName = nextDiscipleName(workerNames, Number(match[1]))
    database.prepare(`UPDATE workers SET name = ?, updated_at = datetime('now','localtime') WHERE id = ?`).run(nextName, worker.id)
    renamedExecutors += 1
  }
  if (renamedExecutors > 0) {
    log(`Migrated: renamed ${renamedExecutors} legacy executor worker(s) to Chinese disciple names`)
  }

  // Normalize old company/small-boss/Tianji per-room coordinators into gang leaders.
  const legacyQueens = database.prepare(`
    SELECT w.id AS workerId, w.name AS workerName, w.role, w.system_prompt AS systemPrompt, r.name AS roomName
    FROM rooms r
    JOIN workers w ON w.id = r.queen_worker_id
    WHERE
      w.role IN ('小老板', 'Queen', 'queen', '天机阁')
      OR w.name LIKE '%小老板%'
      OR w.name LIKE '%天机阁%'
      OR w.name LIKE '% Queen'
      OR (w.system_prompt LIKE '%公司%' AND w.system_prompt LIKE '%员工%')
  `).all() as Array<{ workerId: number; workerName: string; role: string | null; systemPrompt: string; roomName: string }>
  let migratedQueens = 0
  for (const queen of legacyQueens) {
    const nextName = `${queen.roomName} 帮主`
    database.prepare(`
      UPDATE workers
      SET name = ?, role = '帮主', system_prompt = ?, description = ?, is_default = 1,
          updated_at = datetime('now','localtime')
      WHERE id = ?
    `).run(nextName, DEFAULT_QUEEN_SYSTEM_PROMPT, GANG_LEADER_DESCRIPTION, queen.workerId)
    migratedQueens += 1
  }
  if (migratedQueens > 0) {
    log(`Migrated: normalized ${migratedQueens} legacy coordinator worker(s) to gang leader`)
  }

  // Bring existing per-room leaders onto the current prompt contract.
  const staleTianjiPrompts = database.prepare(`
    SELECT w.id AS workerId
    FROM rooms r
    JOIN workers w ON w.id = r.queen_worker_id
    WHERE w.role = '帮主'
      AND (
        w.system_prompt NOT LIKE '%从客栈选择合适弟子%'
        OR w.system_prompt NOT LIKE '%开始一次试运行%'
        OR w.system_prompt NOT LIKE '%上游输入%'
        OR w.description NOT LIKE '%从客栈选择弟子%'
      )
  `).all() as { workerId: number }[]
  if (staleTianjiPrompts.length > 0) {
    const updateTianji = database.prepare(`
      UPDATE workers
      SET system_prompt = ?, description = ?, is_default = 1, updated_at = datetime('now','localtime')
      WHERE id = ?
    `)
    for (const row of staleTianjiPrompts) {
      updateTianji.run(DEFAULT_QUEEN_SYSTEM_PROMPT, GANG_LEADER_DESCRIPTION, row.workerId)
    }
    log(`Migrated: refreshed ${staleTianjiPrompts.length} gang leader prompt contract(s)`)
  }

  const legacyNicknameResult = database
    .prepare(`UPDATE rooms SET queen_nickname = replace(replace(queen_nickname, '小老板', '帮主'), '天机阁', '帮主') WHERE queen_nickname LIKE '%小老板%' OR queen_nickname LIKE '%天机阁%'`)
    .run()
  if (legacyNicknameResult.changes > 0) {
    log(`Migrated: normalized ${legacyNicknameResult.changes} legacy gang leader nickname(s)`)
  }

  const staleWipResult = database.prepare(`
    UPDATE workers
    SET wip = NULL, updated_at = datetime('now','localtime')
    WHERE wip IS NOT NULL
      AND (
        wip LIKE '%小老板%'
        OR wip LIKE '%公司%'
        OR wip LIKE '%员工%'
        OR wip LIKE '%executor-%'
        OR wip LIKE '%company-goal%'
      )
  `).run()
  if (staleWipResult.changes > 0) {
    log(`Migrated: cleared ${staleWipResult.changes} stale legacy WIP note(s)`)
  }

  // Normalize the global assistant worker so it never appears as an inn candidate.
  const clerkWorkerId = database.prepare(`SELECT value FROM settings WHERE key = 'clerk_worker_id'`).get() as { value: string } | undefined
  if (clerkWorkerId?.value) {
    const result = database.prepare(`
      UPDATE workers
      SET name = ?, role = 'clerk', system_prompt = ?, description = ?,
          room_id = NULL, is_default = 0, updated_at = datetime('now','localtime')
      WHERE id = ?
    `).run(CLERK_DISPLAY_NAME, CLERK_ASSISTANT_SYSTEM_PROMPT, CLERK_DESCRIPTION, Number(clerkWorkerId.value))
    if (result.changes > 0) {
      log('Migrated: normalized global Tianji assistant worker')
    }
  }

  log('Database schema initialized')
}
