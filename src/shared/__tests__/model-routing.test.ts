import { describe, expect, it } from 'vitest'
import { initTestDb } from './helpers/test-db'
import * as queries from '../db-queries'
import { createRoom } from '../room'
import {
  getGlobalModel,
  resolveWorkerExecutionModel,
  setGlobalModel,
} from '../model-provider'

describe('global model routing', () => {
  it('stores one global model across Tianji and gang defaults', () => {
    const db = initTestDb()

    setGlobalModel(db, 'codex')

    expect(queries.getSetting(db, 'global_model')).toBe('codex')
    expect(queries.getSetting(db, 'clerk_model')).toBe('codex')
    expect(queries.getSetting(db, 'queen_model')).toBe('codex')
    expect(getGlobalModel(db)).toBe('codex')
  })

  it('uses the global model for a default gang leader and disciple', () => {
    const db = initTestDb()
    setGlobalModel(db, 'mimo:MiMo-V2.5-Pro')
    const room = createRoom(db, { name: '统一模型帮', goal: '验证默认模型继承' })
    const disciple = queries.createWorker(db, {
      name: '青衣甲',
      role: 'executor',
      systemPrompt: '执行镖单。',
      roomId: room.room.id,
    })

    expect(resolveWorkerExecutionModel(db, room.room.id, room.queen)).toBe('mimo:MiMo-V2.5-Pro')
    expect(resolveWorkerExecutionModel(db, room.room.id, disciple)).toBe('mimo:MiMo-V2.5-Pro')
  })

  it('keeps an explicit worker model as an override', () => {
    const db = initTestDb()
    setGlobalModel(db, 'codex')
    const room = createRoom(db, { name: '独立模型帮', goal: '验证覆盖' })
    const disciple = queries.createWorker(db, {
      name: '独立弟子',
      role: 'executor',
      systemPrompt: '执行镖单。',
      model: 'openai:gpt-4o-mini',
      roomId: room.room.id,
    })

    expect(resolveWorkerExecutionModel(db, room.room.id, disciple)).toBe('openai:gpt-4o-mini')
  })
})
