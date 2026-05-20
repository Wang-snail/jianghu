/**
 * 数据迁移脚本：从数据库迁移到文件系统
 *
 * 将房间相关数据从SQLite数据库迁移到按房间隔离的文件系统中
 */

import Database from 'better-sqlite3'
import path from 'node:path'
import { homedir } from 'node:os'
import {
  initRoomDir,
  saveRoomMetadata,
  saveSkill,
  saveGoal,
  type RoomMetadata,
  type SkillFile,
  type GoalFile,
} from '../shared/fs-storage'

const DATA_DIR = path.join(homedir(), '.jianghu')
const DB_PATH = path.join(DATA_DIR, 'data.db')

// ── 迁移函数 ───────────────────────────────────────────────────────

/**
 * 迁移单个房间的所有数据
 */
async function migrateRoom(db: Database.Database, roomId: number): Promise<void> {
  console.log(`\n迁移房间 ${roomId}...`)

  // 1. 迁移房间元数据
  const roomRow = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId) as any
  if (roomRow) {
    const metadata: RoomMetadata = {
      id: roomRow.id,
      name: roomRow.name,
      goal: roomRow.goal,
      status: roomRow.status,
      createdAt: roomRow.created_at,
      updatedAt: roomRow.updated_at,
    }
    await saveRoomMetadata(roomId, metadata)
    console.log(`  ✓ 房间元数据: ${metadata.name}`)
  }

  // 2. 迁移技能
  const skills = db.prepare('SELECT * FROM skills WHERE room_id = ?').all(roomId) as any[]
  for (const skillRow of skills) {
    const skill: SkillFile = {
      id: skillRow.id,
      name: skillRow.name,
      content: skillRow.content,
      version: skillRow.version || 1,
      createdAt: skillRow.created_at,
      updatedAt: skillRow.updated_at,
    }
    await saveSkill(roomId, skill)
    console.log(`  ✓ 技能: ${skill.name} (${skill.id})`)
  }

  // 3. 迁移目标
  const goals = db.prepare('SELECT * FROM goals WHERE room_id = ?').all(roomId) as any[]
  for (const goalRow of goals) {
    const goal: GoalFile = {
      id: goalRow.id,
      name: goalRow.name,
      status: goalRow.status,
      parentId: goalRow.parent_goal_id,
      workerId: goalRow.worker_id,
      createdAt: goalRow.created_at,
      updatedAt: goalRow.updated_at,
    }
    await saveGoal(roomId, goal)
    console.log(`  ✓ 目标: ${goal.name} (${goal.id})`)
  }

  // 4. 迁移记忆数据（可选）
  // TODO: 迁移 entities, observations, relations

  console.log(`房间 ${roomId} 迁移完成！`)
}

/**
 * 迁移所有房间
 */
async function migrateAllRooms(): Promise<void> {
  console.log('开始数据迁移...\n')
  console.log(`数据库: ${DB_PATH}`)
  console.log(`目标目录: ${DATA_DIR}/rooms/\n`)

  // 打开数据库
  const db = new Database(DB_PATH, { readonly: true })

  try {
    // 获取所有房间
    const rooms = db.prepare('SELECT id FROM rooms ORDER BY id').all() as any[]

    if (rooms.length === 0) {
      console.log('没有找到房间数据')
      return
    }

    console.log(`找到 ${rooms.length} 个房间\n`)

    // 迁移每个房间
    for (const room of rooms) {
      await migrateRoom(db, room.id)
    }

    console.log('\n✅ 所有房间迁移完成！')
    console.log(`\n数据已迁移到文件系统: ${DATA_DIR}/rooms/`)
    console.log('数据库保留为索引和元数据存储')

  } catch (err) {
    console.error('迁移失败:', err)
    throw err
  } finally {
    db.close()
  }
}

/**
 * 验证迁移结果
 */
async function validateMigration(): Promise<void> {
  console.log('\n验证迁移结果...\n')

  const db = new Database(DB_PATH, { readonly: true })

  try {
    const rooms = db.prepare('SELECT id, name FROM rooms ORDER BY id').all() as any[]

    for (const room of rooms) {
      const roomDir = path.join(DATA_DIR, 'rooms', room.id.toString())
      const { exists } = await import('node:fs/promises').then(fs => ({
        exists: await fs.access(roomDir).then(() => true).catch(() => false)
      }))

      if (exists) {
        console.log(`✓ 房间 ${room.id} (${room.name}): 数据已迁移`)
      } else {
        console.log(`✗ 房间 ${room.id} (${room.name}): 数据缺失`)
      }
    }

  } finally {
    db.close()
  }
}

// ── 执行迁移 ───────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2)
  const command = args[0]

  switch (command) {
    case 'migrate':
      await migrateAllRooms()
      await validateMigration()
      break

    case 'validate':
      await validateMigration()
      break

    case 'backup':
      // 备份数据库
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      const backupPath = path.join(DATA_DIR, `data.db.backup-${timestamp}`)
      const fs = await import('node:fs/promises')
      await fs.copyFile(DB_PATH, backupPath)
      console.log(`✅ 数据库已备份到: ${backupPath}`)
      break

    default:
      console.log(`
用法: node scripts/migrate-to-fs.js <命令>

命令:
  migrate   - 执行数据迁移（数据库 -> 文件系统）
  validate  - 验证迁移结果
  backup   - 备份数据库

示例:
  node scripts/migrate-to-fs.js migrate
  node scripts/migrate-to-fs.js validate
  node scripts/migrate-to-fs.js backup
      `)
  }
}

main().catch(err => {
  console.error('错误:', err)
  process.exit(1)
})
