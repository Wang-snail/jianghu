import type Database from 'better-sqlite3'
import { execFileSync, execSync } from 'node:child_process'
import * as queries from './db-queries'
import { checkClaudeCliAvailable } from './claude-code'
import type { Worker } from './types'

export type ModelProvider =
  | 'claude_subscription'
  | 'codex_subscription'
  | 'openai_api'
  | 'anthropic_api'
  | 'gemini_api'
  | 'mimo_api'

export interface ModelAuthStatus {
  provider: ModelProvider
  mode: 'subscription' | 'api'
  credentialName: string | null
  envVar: string | null
  hasCredential: boolean
  hasEnvKey: boolean
  ready: boolean
  maskedKey: string | null
}

const GLOBAL_MODEL_KEYS = ['global_model', 'clerk_model', 'queen_model'] as const

export function normalizeModel(model: string | null | undefined): string {
  const trimmed = model?.trim()
  return trimmed ? trimmed : 'claude'
}

export function getGlobalModel(db: Database.Database, fallbackModel: string | null = null): string | null {
  for (const key of GLOBAL_MODEL_KEYS) {
    const model = queries.getSetting(db, key)?.trim()
    if (model) return model
  }
  return fallbackModel
}

export function setGlobalModel(db: Database.Database, model: string): void {
  const next = model.trim()
  if (!next) return

  const previous = getGlobalModel(db)
  for (const key of GLOBAL_MODEL_KEYS) {
    queries.setSetting(db, key, next)
  }

  const clerk = queries.ensureClerkWorker(db)
  queries.updateWorker(db, clerk.id, { model: next })

  for (const room of queries.listRooms(db)) {
    const current = room.workerModel?.trim()
    if (!current || current === 'claude' || current === 'queen' || current === previous) {
      queries.updateRoom(db, room.id, { workerModel: 'queen' })
    }
  }

  for (const worker of queries.listWorkers(db)) {
    const current = worker.model?.trim()
    if (worker.id === clerk.id) continue
    if (!current || current === previous) {
      queries.updateWorker(db, worker.id, { model: next })
    }
  }
}

export function resolveWorkerExecutionModel(
  db: Database.Database,
  roomId: number,
  worker: Worker
): string | null {
  const explicit = worker.model?.trim()
  if (explicit) return explicit

  const room = queries.getRoom(db, roomId)
  const globalModel = getGlobalModel(db)
  if (!room) return globalModel

  const roomModel = room.workerModel?.trim()
  if (!roomModel || roomModel === 'queen' || roomModel === 'global') {
    if (roomModel === 'queen' && room.queenWorkerId && room.queenWorkerId !== worker.id) {
      const queen = queries.getWorker(db, room.queenWorkerId)
      return queen?.model?.trim() || globalModel
    }
    return globalModel
  }

  return roomModel
}

export function getModelProvider(model: string | null | undefined): ModelProvider {
  const normalized = normalizeModel(model)
  if (normalized === 'codex' || normalized.startsWith('codex:')) return 'codex_subscription'
  if (normalized === 'openai' || normalized.startsWith('openai:')) return 'openai_api'
  if (normalized === 'anthropic' || normalized.startsWith('anthropic:') || normalized.startsWith('claude-api:')) {
    return 'anthropic_api'
  }
  if (normalized === 'gemini' || normalized.startsWith('gemini:')) return 'gemini_api'
  if (normalized === 'mimo' || normalized.startsWith('mimo:')) return 'mimo_api'
  return 'claude_subscription'
}

export async function getModelAuthStatus(db: Database.Database, roomId: number, model: string | null | undefined): Promise<ModelAuthStatus> {
  const provider = getModelProvider(model)
  if (provider === 'openai_api') {
    return resolveApiAuthStatus(db, roomId, 'openai_api_key', 'OPENAI_API_KEY', provider)
  }
  if (provider === 'anthropic_api') {
    return resolveApiAuthStatus(db, roomId, 'anthropic_api_key', 'ANTHROPIC_API_KEY', provider, ['ANTHROPIC_AUTH_TOKEN'])
  }
  if (provider === 'gemini_api') {
    return resolveApiAuthStatus(db, roomId, 'gemini_api_key', 'GEMINI_API_KEY', provider)
  }
  if (provider === 'mimo_api') {
    return resolveApiAuthStatus(db, roomId, 'mimo_api_key', 'MIMO_API_KEY', provider)
  }

  let ready = false
  if (provider === 'claude_subscription') {
    ready = checkClaudeCliAvailable().available
  } else if (provider === 'codex_subscription') {
    ready = checkCodexCliConnected()
  }

  return {
    provider,
    mode: 'subscription',
    credentialName: null,
    envVar: null,
    hasCredential: false,
    hasEnvKey: false,
    ready,
    maskedKey: null
  }
}

export function resolveApiKeyForModel(db: Database.Database, roomId: number, model: string | null | undefined): string | undefined {
  const provider = getModelProvider(model)
  if (provider === 'openai_api') {
    return resolveApiKey(db, roomId, 'openai_api_key', 'OPENAI_API_KEY')
  }
  if (provider === 'anthropic_api') {
    return resolveApiKey(db, roomId, 'anthropic_api_key', 'ANTHROPIC_API_KEY', ['ANTHROPIC_AUTH_TOKEN'])
  }
  if (provider === 'gemini_api') {
    return resolveApiKey(db, roomId, 'gemini_api_key', 'GEMINI_API_KEY')
  }
  if (provider === 'mimo_api') {
    return resolveApiKey(db, roomId, 'mimo_api_key', 'MIMO_API_KEY')
  }
  return undefined
}

function resolveApiAuthStatus(
  db: Database.Database,
  roomId: number,
  credentialName: string,
  envVar: string,
  provider: ModelProvider,
  envAliases: string[] = []
): ModelAuthStatus {
  const roomCred = getRoomCredential(db, roomId, credentialName)
  const sharedRoomCred = findAnyRoomCredential(db, credentialName, roomId)
  const clerkCred = getClerkCredential(db, credentialName)
  const envKey = getEnvValue(envVar, envAliases)
  const hasCredential = Boolean(roomCred || sharedRoomCred || clerkCred)
  const activeKey = roomCred || sharedRoomCred || clerkCred || envKey || null
  return {
    provider,
    mode: 'api',
    credentialName,
    envVar,
    hasCredential,
    hasEnvKey: Boolean(envKey),
    ready: Boolean(hasCredential || envKey),
    maskedKey: maskKey(activeKey)
  }
}

function maskKey(key: string | null): string | null {
  if (!key) return null
  const trimmed = key.trim()
  if (trimmed.length <= 8) return `${trimmed.slice(0, 3)}...`
  return `${trimmed.slice(0, 7)}...${trimmed.slice(-4)}`
}

function resolveApiKey(db: Database.Database, roomId: number, credentialName: string, envVar: string, envAliases: string[] = []): string | undefined {
  const roomCred = getRoomCredential(db, roomId, credentialName)
  if (roomCred) return roomCred
  const sharedRoomCred = findAnyRoomCredential(db, credentialName, roomId)
  if (sharedRoomCred) return sharedRoomCred
  const clerkCred = getClerkCredential(db, credentialName)
  if (clerkCred) return clerkCred
  return getEnvValue(envVar, envAliases) || undefined
}

function findAnyRoomCredential(db: Database.Database, credentialName: string, excludeRoomId?: number): string | null {
  const rooms = queries.listRooms(db)
  for (const room of rooms) {
    if (excludeRoomId != null && room.id === excludeRoomId) continue
    const value = getRoomCredential(db, room.id, credentialName)
    if (value) return value
  }
  return null
}

function getClerkCredential(db: Database.Database, credentialName: string): string | null {
  if (credentialName === 'openai_api_key') {
    return queries.getClerkApiKey(db, 'openai_api')
  }
  if (credentialName === 'anthropic_api_key') {
    return queries.getClerkApiKey(db, 'anthropic_api')
  }
  if (credentialName === 'gemini_api_key') {
    return queries.getClerkApiKey(db, 'gemini_api')
  }
  if (credentialName === 'mimo_api_key') {
    return queries.getClerkApiKey(db, 'mimo_api')
  }
  return null
}

function getRoomCredential(db: Database.Database, roomId: number, credentialName: string): string | null {
  try {
    const credential = queries.getCredentialByName(db, roomId, credentialName)
    if (!credential) return null
    const value = (credential.valueEncrypted || '').trim()
    // If decryption failed, value stays encrypted (enc:v1:*), which is unusable as an API key.
    if (!value || value.startsWith('enc:v1:')) return null
    return value
  } catch {
    return null
  }
}

function getEnvValue(envVar: string, aliases: string[] = []): string {
  for (const key of [envVar, ...aliases]) {
    const value = (process.env[key] || '').trim()
    if (value) return value
  }
  return ''
}

function checkCodexCliAvailable(): boolean {
  const cmd = process.platform === 'win32' ? 'codex.cmd' : 'codex'
  try {
    execSync(`"${cmd}" --version`, { timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] })
    return true
  } catch {
    return false
  }
}

function checkCodexCliConnected(): boolean {
  if (!checkCodexCliAvailable()) return false
  const cmd = process.platform === 'win32' ? 'codex.cmd' : 'codex'
  const attempts = [['login', 'status'], ['auth', 'status']]
  for (const args of attempts) {
    try {
      const stdout = execFileSync(cmd, args, {
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
      }).toString()
      const combined = stdout.toLowerCase()
      if (combined.includes('not logged') || combined.includes('logged out') || combined.includes('unauth')) {
        return false
      }
      return true
    } catch (err) {
      const e = err as { stdout?: Buffer; stderr?: Buffer; message?: string }
      const combined = `${e.stdout?.toString() ?? ''}\n${e.stderr?.toString() ?? ''}\n${e.message ?? ''}`.toLowerCase()
      if (combined.includes('not logged') || combined.includes('logged out') || combined.includes('unauth')) {
        return false
      }
    }
  }
  return false
}
