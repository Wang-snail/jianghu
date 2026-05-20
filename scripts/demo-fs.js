/**
 * 江湖文件系统演示
 *
 * 展示如何使用新的文件系统存储功能
 */

import Database from 'better-sqlite3'
import path from 'node:path'
import { homedir } from 'node:os'
import {
  getRoomDir,
  getRoomDiskUsage,
  listSkills,
  listGoals,
} from '../shared/fs-storage'
import {
  createRoomWithFS,
  createSkillWithFS,
  createGoalWithFS,
  getRoomStats,
} from '../shared/fs-integration'

const DATA_DIR = path.join(homedir(), '.jianghu')
const DB_PATH = path.join(DATA_DIR, 'data.db')

/**
 * 演示1: 创建一个测试公司
 */
async function demoCreateRoom() {
  console.log('\n=== 演示1: 创建公司 ===\n')

  const db = new Database(DB_PATH)

  const room = await createRoomWithFS(
    db,
    '测试公司',
    '演示文件系统功能',
    {
      threshold: 'majority',
      timeoutMinutes: 60,
      tieBreaker: 'queen',
      autoApprove: ['low_impact'],
      minCycleGapMs: 1000,
    }
  )

  console.log(`✓ 公司已创建: ${room.name} (ID: ${room.id})`)
  console.log(`✓ 公司目录: ${getRoomDir(room.id)}`)

  // 创建技能
  await createSkillWithFS(
    db,
    room.id,
    '文件管理技能',
    '1. 打开公司目录\n2. 创建子文件夹\n3. 保存文件'
  )

  console.log('✓ 技能已创建并保存到文件系统')

  // 创建目标
  await createGoalWithFS(db, room.id, '演示目标', null, null)

  console.log('✓ 目标已创建并保存到文件系统')

  // 获取统计信息
  const stats = await getRoomStats(db, room.id)
  console.log('\n公司统计:')
  console.log(`  - 技能数: ${stats.skillCount}`)
  console.log(`  - 目标数: ${stats.goalCount}`)
  console.log(`  - 文件数: ${stats.fileCount}`)
  console.log(`  - 磁盘占用: ${stats.diskSizeFormatted}`)

  db.close()
}

/**
 * 演示2: 浏览公司文件
 */
async function demoBrowseFiles() {
  console.log('\n=== 演示2: 浏览公司文件 ===\n')

  const db = new Database(DB_PATH)

  const rooms = db.prepare('SELECT id, name FROM rooms LIMIT 3').all() as any[]

  for (const room of rooms) {
    console.log(`\n公司: ${room.name} (ID: ${room.id})`)
    console.log(`  路径: ${getRoomDir(room.id)}`)

    // 列出技能
    const skills = await listSkills(room.id)
    if (skills.length > 0) {
      console.log(`  技能 (${skills.length}):`)
      skills.forEach(skill => {
        console.log(`    - ${skill.name} (v${skill.version})`)
      })
    }

    // 列出目标
    const goals = await listGoals(room.id)
    if (goals.length > 0) {
      console.log(`  目标 (${goals.length}):`)
      goals.forEach(goal => {
        console.log(`    - ${goal.name} (${goal.status})`)
      })
    }

    // 磁盘使用
    const diskUsage = await getRoomDiskUsage(room.id)
    console.log(`  磁盘: ${diskUsage.fileCount} 文件, ${formatBytes(diskUsage.size)}`)
  }

  db.close()
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
 * 主函数
 */
async function main() {
  console.log('\n🦟 江湖文件系统演示\n')
  console.log('数据目录:', DATA_DIR)
  console.log('数据库:', DB_PATH)
  console.log('公司目录:', path.join(DATA_DIR, 'rooms/'))

  const command = process.argv[2]

  switch (command) {
    case 'create':
      await demoCreateRoom()
      break

    case 'browse':
      await demoBrowseFiles()
      break

    default:
      console.log(`
用法: node scripts/demo-fs.js <命令>

命令:
  create  - 创建一个演示公司，展示文件系统功能
  browse  - 浏览现有公司的文件

示例:
  node scripts/demo-fs.js create
  node scripts/demo-fs.js browse
      `)
  }
}

main().catch(err => {
  console.error('错误:', err)
  process.exit(1)
})
