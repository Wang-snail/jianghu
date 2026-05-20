import type Database from 'better-sqlite3'
import type { Worker, AgentState } from './types'
import type { AgentExecutionResult } from './agent-executor'
import type { RateLimitInfo } from './rate-limit'
import * as queries from './db-queries'
import { executeAgent, compressSession } from './agent-executor'
import { checkExpiredDecisions } from './quorum'
import { getRoomStatus } from './room'
import { detectRateLimit, sleep } from './rate-limit'
import { resolveApiKeyForModel, getModelProvider } from './model-provider'
import { createCycleLogBuffer, type CycleLogEntryCallback } from './console-log-buffer'
import { executeQueenTool, selectAgentHermesForCycle } from './queen-tools'
import { WORKER_ROLE_PRESETS } from './constants'
import { loadSkillsForAgent } from './skills'
import { buildActiveSkillsContext, buildAgentSystemPrompt } from './agent-capabilities'
import { getAgentWorkspaceDir, getRoomSubdir, initAgentWorkspace } from './fs-storage'

interface LoopState {
  running: boolean
  waitAbort: AbortController | null
  cycleAbort: AbortController | null
}

const QUEEN_EXECUTION_TOOLS = new Set([
  'company_web_search',
  'company_web_fetch',
  'company_browser',
])

const QUEEN_POLICY_WIP_HINT = '[policy] 天机阁驾驶舱模式：通过本地镖单委派工具把执行工作分给弟子，然后监控、解除阻塞并汇报结果。避免直接执行浏览器或网页操作。'

function isInQuietHours(from: string, until: string): boolean {
  const now = new Date()
  const nowMins = now.getHours() * 60 + now.getMinutes()
  const [fh, fm] = from.split(':').map(Number)
  const [uh, um] = until.split(':').map(Number)
  const fromMins = fh * 60 + fm
  const untilMins = uh * 60 + um
  if (fromMins <= untilMins) {
    return nowMins >= fromMins && nowMins < untilMins
  }
  // Overnight span (e.g. 22:00–08:00)
  return nowMins >= fromMins || nowMins < untilMins
}

function msUntilQuietEnd(until: string): number {
  const [uh, um] = until.split(':').map(Number)
  const now = new Date()
  const end = new Date(now)
  end.setHours(uh, um, 0, 0)
  if (end <= now) end.setDate(end.getDate() + 1)
  return end.getTime() - now.getTime()
}

function nextAutoExecutorName(workers: Worker[]): string {
  const names = new Set(workers.map(w => w.name.toLowerCase()))
  let idx = 1
  while (names.has(`executor-${idx}`)) idx++
  return `executor-${idx}`
}

function extractToolNameFromConsoleLog(content: string): string | null {
  const usingMatch = content.match(/(?:Using|→)\s*([a-zA-Z0-9_]+)/)
  if (usingMatch?.[1]) return usingMatch[1]
  const callMatch = content.match(/^([a-zA-Z0-9_]+)\s*\(/)
  return callMatch?.[1] ?? null
}

function resolveWorkerExecutionModel(
  db: Database.Database,
  roomId: number,
  worker: Worker
): string | null {
  const explicit = worker.model?.trim()
  if (explicit) return explicit

  const room = queries.getRoom(db, roomId)
  if (!room) return null

  const roomModel = room.workerModel?.trim()
  if (!roomModel) return null
  if (roomModel !== 'queen') return roomModel

  if (!room.queenWorkerId) return null
  if (room.queenWorkerId === worker.id) return null
  const queen = queries.getWorker(db, room.queenWorkerId)
  const queenModel = queen?.model?.trim()
  return queenModel || null
}

const runningLoops = new Map<number, LoopState>()
const launchedRoomIds = new Set<number>()

export interface AgentLoopOptions {
  onCycleLogEntry?: CycleLogEntryCallback
  onCycleLifecycle?: (event: 'created' | 'completed' | 'failed', cycleId: number, roomId: number) => void
  allowColdStart?: boolean
}

export class RateLimitError extends Error {
  constructor(public info: RateLimitInfo) {
    super(`Rate limited: wait ${Math.round(info.waitMs / 1000)}s`)
    this.name = 'RateLimitError'
  }
}

export async function startAgentLoop(
  db: Database.Database, roomId: number, workerId: number, options?: AgentLoopOptions
): Promise<void> {
  const room = queries.getRoom(db, roomId)
  if (!room) throw new Error(`Room ${roomId} not found`)
  if (room.status !== 'active') throw new Error(`Room ${roomId} is not active (status: ${room.status})`)

  const worker = queries.getWorker(db, workerId)
  if (!worker) throw new Error(`Worker ${workerId} not found`)
  if (worker.roomId !== roomId) throw new Error(`Worker ${workerId} does not belong to room ${roomId}`)

  // If already running, skip
  const existing = runningLoops.get(workerId)
  if (existing?.running) return

  const loop: LoopState = { running: true, waitAbort: null, cycleAbort: null }
  runningLoops.set(workerId, loop)

  try {
    while (loop.running) {
      // Re-fetch room to check if still active
      const currentRoom = queries.getRoom(db, roomId)
      if (!currentRoom || currentRoom.status !== 'active') break

      const currentWorker = queries.getWorker(db, workerId)
      if (!currentWorker) break

      // Quiet hours guard — sleep until quiet window ends
      if (currentRoom.queenQuietFrom && currentRoom.queenQuietUntil &&
          isInQuietHours(currentRoom.queenQuietFrom, currentRoom.queenQuietUntil)) {
        queries.updateAgentState(db, workerId, 'idle')
        queries.logRoomActivity(db, roomId, 'system',
          `Queen sleeping (quiet hours until ${currentRoom.queenQuietUntil})`, undefined, workerId)
        const wait = msUntilQuietEnd(currentRoom.queenQuietUntil)
        try {
          const abort = new AbortController()
          loop.waitAbort = abort
          await sleep(wait, abort.signal)
        } catch {
          // Aborted (e.g. quiet hours disabled, or room paused)
        } finally {
          loop.waitAbort = null
        }
        continue
      }

      try {
        // Floor: never less than 50 turns — let agents finish their work
        const effectiveMaxTurns = Math.max(currentWorker.maxTurns ?? currentRoom.queenMaxTurns, 50)
        const cycleAbort = new AbortController()
        loop.cycleAbort = cycleAbort
        await runCycle(db, roomId, currentWorker, effectiveMaxTurns, options, cycleAbort.signal)
      } catch (err) {
        if (!loop.running) break

        if (err instanceof RateLimitError) {
          // Enter rate_limited state and wait
          queries.updateAgentState(db, workerId, 'rate_limited')
          const resetTimeStr = err.info.resetAt
            ? err.info.resetAt.toLocaleTimeString()
            : `~${Math.round(err.info.waitMs / 1000 / 60)}min`
          queries.logRoomActivity(db, roomId, 'system',
            `Agent rate limited, waiting until ${resetTimeStr} (${currentWorker.name})`,
            err.info.rawMessage, workerId)

          try {
            const abort = new AbortController()
            loop.waitAbort = abort
            await sleep(err.info.waitMs, abort.signal)
          } catch {
            // Aborted by triggerAgent — continue immediately
          } finally {
            loop.waitAbort = null
          }

          if (loop.running) {
            queries.updateAgentState(db, workerId, 'idle')
          }
          continue
        }

        // Non-rate-limit error: log and continue
        const message = err instanceof Error ? err.message : String(err)
        queries.logRoomActivity(db, roomId, 'error',
          `Agent cycle error (${currentWorker.name}): ${message.slice(0, 200)}`,
          message, workerId)
        queries.updateAgentState(db, workerId, 'idle')
      } finally {
        loop.cycleAbort = null
      }

      if (!loop.running) break

      // Adaptive gap: short when agent has active WIP (momentum), normal otherwise
      const MOMENTUM_GAP = 10_000  // 10s — maintain action momentum
      const baseGap = currentWorker.cycleGapMs ?? currentRoom.queenCycleGapMs
      const freshWorker = queries.getWorker(db, workerId)
      const gap = freshWorker?.wip ? Math.min(baseGap, MOMENTUM_GAP) : baseGap
      try {
        const abort = new AbortController()
        loop.waitAbort = abort
        await sleep(gap, abort.signal)
      } catch {
        // Aborted by triggerAgent — skip gap, start next cycle immediately
      } finally {
        loop.waitAbort = null
      }
    }
  } finally {
    loop.cycleAbort = null
    runningLoops.delete(workerId)
    try { queries.updateAgentState(db, workerId, 'idle') } catch { /* DB may be closed */ }
  }
}

export function pauseAgent(db: Database.Database, workerId: number): void {
  const loop = runningLoops.get(workerId)
  if (loop) {
    loop.running = false
    if (loop.waitAbort) loop.waitAbort.abort()
    if (loop.cycleAbort) loop.cycleAbort.abort()
    runningLoops.delete(workerId)
  }
  queries.updateAgentState(db, workerId, 'idle')
}

export function resumeAgent(db: Database.Database, roomId: number, workerId: number, options?: AgentLoopOptions): void {
  pauseAgent(db, workerId) // Clear any existing loop
  startAgentLoop(db, roomId, workerId, options).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`Agent loop failed for worker ${workerId}: ${msg}`)
    try {
      queries.logRoomActivity(db, roomId, 'error',
        `Agent loop failed to start: ${msg.slice(0, 200)}`, msg, workerId)
    } catch { /* DB may be closed */ }
    try { pauseAgent(db, workerId) } catch { /* DB may be closed */ }
  })
}

export function setRoomLaunchEnabled(roomId: number, enabled: boolean): void {
  if (enabled) {
    launchedRoomIds.add(roomId)
    return
  }
  launchedRoomIds.delete(roomId)
}

export function isRoomLaunchEnabled(roomId: number): boolean {
  return launchedRoomIds.has(roomId)
}

export function clearRoomLaunchState(): void {
  launchedRoomIds.clear()
}

export function triggerAgent(db: Database.Database, roomId: number, workerId: number, options?: AgentLoopOptions): void {
  const loop = runningLoops.get(workerId)
  if (loop?.running) {
    // Abort any current wait (gap or rate limit) to start next cycle immediately
    if (loop.waitAbort) loop.waitAbort.abort()
    return
  }
  const canColdStart = options?.allowColdStart === true || isRoomLaunchEnabled(roomId)
  if (!canColdStart) {
    return
  }
  // Not running — start fresh
  startAgentLoop(db, roomId, workerId, options).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`Agent loop failed for worker ${workerId}: ${msg}`)
    try {
      queries.logRoomActivity(db, roomId, 'error',
        `Agent loop failed to start: ${msg.slice(0, 200)}`, msg, workerId)
    } catch { /* DB may be closed */ }
    try { pauseAgent(db, workerId) } catch { /* DB may be closed */ }
  })
}

export function getAgentState(db: Database.Database, workerId: number): AgentState {
  const worker = queries.getWorker(db, workerId)
  return worker?.agentState ?? 'idle'
}

export function isAgentRunning(workerId: number): boolean {
  return runningLoops.get(workerId)?.running === true
}

/**
 * Adapt AgentExecutionResult to the format detectRateLimit expects.
 */
function checkRateLimit(result: AgentExecutionResult): RateLimitInfo | null {
  if (result.exitCode === 0) return null
  if (result.timedOut) return null
  return detectRateLimit({
    exitCode: result.exitCode,
    stdout: result.output,
    stderr: result.output,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    sessionId: result.sessionId
  })
}

function isCliContextOverflowError(message: string): boolean {
  return /compact|compaction|context.*(window|limit|overflow|too large)|model_visible_bytes|token.*limit.*exceed/i.test(message)
}

export async function runCycle(
  db: Database.Database,
  roomId: number,
  worker: Worker,
  maxTurns?: number,
  options?: AgentLoopOptions,
  abortSignal?: AbortSignal
): Promise<string> {
  queries.logRoomActivity(db, roomId, 'system',
    `Agent cycle started (${worker.name})`, undefined, worker.id)

  const model = resolveWorkerExecutionModel(db, roomId, worker)

  // Create cycle record + log buffer
  const cycle = queries.createWorkerCycle(db, worker.id, roomId, model)
  const logBuffer = createCycleLogBuffer(
    cycle.id,
    (entries) => queries.insertCycleLogs(db, entries),
    options?.onCycleLogEntry
  )
  options?.onCycleLifecycle?.('created', cycle.id, roomId)

  try {
    if (!model) {
      const msg = 'No model configured for this worker. Set an explicit worker model or room worker model.'
      logBuffer.addSynthetic('error', msg)
      logBuffer.flush()
      queries.completeWorkerCycle(db, cycle.id, msg, undefined)
      options?.onCycleLifecycle?.('failed', cycle.id, roomId)
      queries.logRoomActivity(db, roomId, 'error',
        `Agent cycle failed (${worker.name}): model is not configured`,
        msg, worker.id)
      queries.updateAgentState(db, worker.id, 'idle')
      return msg
    }

    // 0. PRE-FLIGHT: ensure API key is available for API-backed models
    const provider = getModelProvider(model)
    if (provider === 'openai_api' || provider === 'anthropic_api' || provider === 'gemini_api') {
      const apiKeyCheck = resolveApiKeyForModel(db, roomId, model)
      if (!apiKeyCheck) {
        const label = provider === 'openai_api' ? 'OpenAI' : provider === 'gemini_api' ? 'Gemini' : 'Anthropic'
        const msg = `Missing ${label} API key. Set it in Room Settings or the Setup Guide.`
        logBuffer.addSynthetic('error', msg)
        logBuffer.flush()
        queries.completeWorkerCycle(db, cycle.id, msg, undefined)
        options?.onCycleLifecycle?.('failed', cycle.id, roomId)
        queries.updateAgentState(db, worker.id, 'idle')
        return msg
      }
    }

    // 1. OBSERVE
    queries.updateAgentState(db, worker.id, 'thinking')
    logBuffer.addSynthetic('system', `Cycle started — observing room state...`)

    checkExpiredDecisions(db)

    const status = getRoomStatus(db, roomId)
    const pendingEscalations = queries.getPendingEscalations(db, roomId, worker.id)
    const recentKeeperAnswers = queries.getRecentKeeperAnswers(db, roomId, worker.id, 5)
    const goalUpdates = status.activeGoals.slice(0, 5).map(g => ({
      id: g.id,
      goal: g.description,
      status: g.status,
      assignedWorkerId: g.assignedWorkerId
    }))
    let roomWorkers = queries.listRoomWorkers(db, roomId)
    const isQueen = worker.id === status.room.queenWorkerId
    const unreadMessages = queries.listRoomMessages(db, roomId, 'unread').slice(0, 5)

    if (isQueen) {
      const nonQueenWorkers = roomWorkers.filter(w => w.id !== worker.id)
      if (nonQueenWorkers.length === 0) {
        const autoName = nextAutoExecutorName(roomWorkers)
        const executorPreset = WORKER_ROLE_PRESETS.executor
        const inheritedModel = status.room.workerModel === 'queen'
          ? model
          : status.room.workerModel?.trim()
        if (!inheritedModel) {
          const err = '自动创建弟子已跳过：尚未配置执行模型。'
          queries.logRoomActivity(db, roomId, 'error', err, '请先设置弟子模型或天机阁模型。', worker.id)
          logBuffer.addSynthetic('error', err)
        } else {
          queries.createWorker(db, {
            name: autoName,
            role: 'executor',
            roomId,
            description: '天机阁自动创建的执行弟子，负责承接镖单并交付结果。',
            systemPrompt: '你是帮派中的执行弟子。你要把天机阁分派的镖单做到可交付结果，汇报具体产出，并在每轮结束前保存进展、阻塞点和下一步。',
            model: inheritedModel,
            cycleGapMs: executorPreset?.cycleGapMs,
            maxTurns: executorPreset?.maxTurns,
          })
          queries.logRoomActivity(
            db,
            roomId,
            'system',
            `已自动创建弟子「${autoName}」用于委派执行。`,
            '天机阁负责调度，弟子负责执行。',
            worker.id
          )
          logBuffer.addSynthetic('system', `因天机阁暂无可执行弟子，已自动创建「${autoName}」。`)
          roomWorkers = queries.listRoomWorkers(db, roomId)
        }
      }
    }

    // 2. BUILD PROMPT

    const rolePreset = worker.role ? WORKER_ROLE_PRESETS[worker.role] : undefined
    const systemPrompt = buildAgentSystemPrompt(worker, rolePreset?.systemPromptPrefix)

    const isCli = model === 'claude' || model.startsWith('claude-') || model === 'codex'
    const CLI_SESSION_MAX_TURNS = 20

    // ─── Load agent session ────────────────────────────────────────────────────
    // Group A (CLI): load sessionId for --resume
    // Group B (API): load messages_json for previousMessages
    let resumeSessionId: string | undefined
    let previousMessages: Array<{ role: string; content: string }> | undefined

    const agentSession = queries.getAgentSession(db, worker.id)
    if (agentSession) {
      const updatedAt = new Date(agentSession.updatedAt)
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      const cliSessionTooLong = isCli
        && !!agentSession.sessionId
        && agentSession.turnCount >= CLI_SESSION_MAX_TURNS
      if (updatedAt < sevenDaysAgo || agentSession.model !== model || cliSessionTooLong) {
        // Stale session, model switch, or long-running CLI thread → start fresh.
        queries.deleteAgentSession(db, worker.id)
        if (cliSessionTooLong) {
          logBuffer.addSynthetic(
            'system',
            `Session rotated after ${agentSession.turnCount} cycles to avoid context overflow`
          )
        }
      } else if (isCli && agentSession.sessionId) {
        resumeSessionId = agentSession.sessionId
      } else if (!isCli && agentSession.messagesJson) {
        try {
          previousMessages = JSON.parse(agentSession.messagesJson) as Array<{ role: string; content: string }>
        } catch { /* corrupt session — start fresh */ }
      }
    }

    // ─── Context compression (OpenClaw pattern) ────────────────────────────────
    // When the session history grows large, compress it into a summary before the
    // next cycle instead of blindly trimming old messages.
    const COMPRESS_THRESHOLD = 30
    const MAX_MESSAGES = 40
    const apiKeyEarly = resolveApiKeyForModel(db, roomId, model)

    if (!isCli && previousMessages && previousMessages.length >= COMPRESS_THRESHOLD) {
      logBuffer.addSynthetic('system', `Session history ${previousMessages.length} msgs — compressing...`)
      logBuffer.flush()
      const summary = await compressSession(model, apiKeyEarly, previousMessages)
      if (summary) {
        // Persist summary as a room memory so it appears in future queen prompts
        try {
          const existing = queries.listEntities(db, roomId).find(e => e.name === 'queen_session_summary')
          if (existing) {
            const obs = queries.getObservations(db, existing.id)
            if (obs.length > 0) {
              db.prepare('UPDATE observations SET content = ?, created_at = datetime(\'now\',\'localtime\') WHERE id = ?').run(summary, obs[0].id)
            } else {
              queries.addObservation(db, existing.id, summary, 'queen')
            }
          } else {
            const entity = queries.createEntity(db, 'queen_session_summary', 'fact', 'work', roomId)
            queries.addObservation(db, entity.id, summary, 'queen')
          }
        } catch { /* non-fatal */ }

        // Reset messages to just the summary entry
        previousMessages = [{ role: 'user', content: `Your compressed session memory from previous cycles: ${summary}` }]
        queries.saveAgentSession(db, worker.id, { messagesJson: JSON.stringify(previousMessages), model })
        logBuffer.addSynthetic('system', 'Session compressed and saved.')
      } else {
        // Compression failed — hard trim as fallback
        previousMessages = previousMessages.slice(-MAX_MESSAGES)
      }
      logBuffer.flush()
    }

    // ─── Build context prompt ──────────────────────────────────────────────────
    const contextParts: string[] = []

    // 1. Identity — always first so agents know their roomId and workerId for MCP tool calls
    contextParts.push(
      `## Your Identity\n- Room ID: ${roomId}\n- Your Worker ID: ${worker.id}\n- Your Name: ${worker.name}`
    )

    const privateWorkspaceDir = getAgentWorkspaceDir(roomId, worker.id)
    const sharedWorkspaceDir = getRoomSubdir(roomId, 'shared')
    const resultsWorkspaceDir = getRoomSubdir(roomId, 'results')
    void initAgentWorkspace(roomId, worker.id).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err)
      logBuffer.addSynthetic('system', `Agent workspace init skipped: ${msg.slice(0, 160)}`)
    })
    contextParts.push(`## 文件与记忆隔离
- 当前弟子私有目录：${privateWorkspaceDir}
- 当前帮派共享资料：${sharedWorkspaceDir}
- 当前帮派交付结果：${resultsWorkspaceDir}
- 临时草稿、私有记忆和过程日志只放入你的私有目录。
- 需要给全帮派复用的材料才放入共享资料；可交付结果才放入结果目录。
- 不得读取或写入其他帮派、其他弟子的私有目录；客栈候选弟子未入帮前不得写入任何帮派目录。`)

    // 2. WIP — resume directive (highest priority, before everything else)
    const wip = worker.wip
    if (wip) {
      contextParts.push(`## >>> 继续推进 <<<
上一轮已完成或正在处理：

${wip}

现在执行下一步。不要重复已经完成的工作，要在现有进展上继续推进。
如果上述事项已经完成，就围绕公司目标启动下一个本地可执行动作。
本轮结束前，使用本地进展保存工具记录你的最新位置。`)
    }

    // 3. Jianghu objective, goals, and assigned tasks
    if (status.room.goal) {
      contextParts.push(`## 委托目标\n${status.room.goal}`)
    }

    if (isQueen) {
      contextParts.push(`## 天机阁驾驶舱契约
- 你负责帮派运转：创建弟子、分派镖单、监控交付、解除阻塞。
- 如果当前帮派还没有弟子，先创建一个执行弟子。
- 所有执行工作优先委派给弟子，并通过本地消息跟进。
- 需要多人判断时开启议事堂，记录讨论过程和结论；不要把问题变成投票。
- 除非没有其他可行路径，否则不要直接替弟子做执行镖单。`)
    }

    if (goalUpdates.length > 0) {
      const workerMap = new Map(roomWorkers.map(w => [w.id, w.name]))
      contextParts.push(`## 活跃委托\n${goalUpdates.map(g => {
        const assignee = g.assignedWorkerId ? ` → ${workerMap.get(g.assignedWorkerId) ?? `弟子 #${g.assignedWorkerId}`}` : ''
        return `- [#${g.id}] ${g.goal} (${g.status})${assignee}`
      }).join('\n')}`)

      // Show goals assigned specifically to this worker
      const myTasks = status.activeGoals.filter(g => g.assignedWorkerId === worker.id)
      if (myTasks.length > 0) {
        contextParts.push(`## 分配给你的镖单\n${myTasks.map(g =>
          `- [#${g.id}] ${g.description}`
        ).join('\n')}\n\n这些镖单已经分配给你，请优先完成并汇报可检查结果。`)
      }
    }

    // 4. Room Memory — relevance-based (top 5 by hybrid search against WIP/goal)
    const searchQuery = wip || status.room.goal || ''
    const memoryResults = searchQuery
      ? queries.hybridSearch(db, searchQuery, null, 20)
          .filter(r => r.entity.roomId === roomId).slice(0, 5)
      : queries.listEntities(db, roomId).slice(0, 5).map(e => ({ entity: e, rank: 0 }))
    if (memoryResults.length > 0) {
      const memLines = memoryResults
        .map(r => {
          const obs = queries.getObservations(db, r.entity.id)
          const content = obs[0]?.content ?? ''
          return content ? `- **${r.entity.name}**: ${content.slice(0, 300)}` : null
        })
        .filter((l): l is string => l !== null)
      if (memLines.length > 0) {
        contextParts.push(`## 公司记忆\n${memLines.join('\n')}`)
      }
    }

    // 5. Stuck detector
    const STUCK_THRESHOLD_CYCLES = 2
    const productiveCallCount = queries.countProductiveToolCalls(db, worker.id, STUCK_THRESHOLD_CYCLES)
    const recentCompletedCycles = queries.listRoomCycles(db, roomId, 5)
      .filter(c => c.workerId === worker.id && c.status === 'completed')
    const isStuck = recentCompletedCycles.length >= STUCK_THRESHOLD_CYCLES && productiveCallCount === 0
    if (isStuck) {
      if (wip) {
        contextParts.push(`## ⚠ ACTION STALLED\nYour last ${STUCK_THRESHOLD_CYCLES} cycles had a WIP but no external results. Try a different approach or report the blocker.`)
      } else {
        contextParts.push(`## ⚠ STUCK — TAKE ACTION NOW\nYour last ${STUCK_THRESHOLD_CYCLES} cycles produced no results. Pick ONE concrete action and execute it NOW.`)
      }
      logBuffer.addSynthetic('system', `Stuck detector: 0 productive tool calls in last ${STUCK_THRESHOLD_CYCLES} cycles`)
    }

    // 6. Instructions (lean)
    const isClaude = model === 'claude' || model.startsWith('claude-')
    const toolCallInstruction = isClaude
      ? '必须调用本地工具推进行动。'
      : '重要：本轮回复必须至少调用一次本地工具。'

    const hasWip = !!wip
    const actionPriority = hasWip
      ? '你上面有正在进行的工作，继续推进它。'
      : '围绕公司目标采取一个具体的本地行动。'

    contextParts.push(`## 执行要求\n${actionPriority}\n你有足够的轮次，要把当前动作推进到可检查状态。\n本轮结束前，保存进展、阻塞点、下一步和预计完成时间。\n${toolCallInstruction}`)

    // 7. Housekeeping — messages and announcements (for all workers)
    const housekeepingParts: string[] = []

    // Announced decisions (workers can object)
    const announcedDecisions = queries.listDecisions(db, roomId, 'announced')
    if (announcedDecisions.length > 0) {
      housekeepingParts.push(`**待讨论事项** — 如果不同意，请使用本地反对/讨论工具说明原因\n${announcedDecisions.map(d =>
        `- #${d.id}: ${d.proposal} (effective at ${d.effectiveAt ?? 'soon'})`
      ).join('\n')}`)
    }

    // Messages
    const myKeeperMessages = pendingEscalations.filter(e => e.fromAgentId === worker.id && !e.toAgentId)
    const incomingWorkerMessages = pendingEscalations.filter(e => e.toAgentId === worker.id && e.fromAgentId !== worker.id)

    if (incomingWorkerMessages.length > 0) {
      const senderNames = new Map(roomWorkers.map(w => [w.id, w.name]))
      housekeepingParts.push(`**员工消息**\n${incomingWorkerMessages.map(e => {
        const sender = senderNames.get(e.fromAgentId ?? 0) ?? `Worker #${e.fromAgentId}`
        return `- #${e.id} from ${sender}: ${e.question}`
      }).join('\n')}`)
    }

    if (recentKeeperAnswers.length > 0) {
      housekeepingParts.push(`**用户回复**\n${recentKeeperAnswers.map(e =>
        `- Q: ${e.question}\n  A: ${e.answer}`
      ).join('\n')}`)
    }

    if (myKeeperMessages.length > 0) {
      housekeepingParts.push(`**等待用户回复**\n${myKeeperMessages.map(e =>
        `- #${e.id}: ${e.question}`
      ).join('\n')}`)
    }

    // Queen-only: show workers list
    if (isQueen && roomWorkers.length > 1) {
      housekeepingParts.push(`**公司员工**\n${roomWorkers.filter(w => w.id !== worker.id).map(w =>
        `- #${w.id} ${w.name}${w.role ? ` (${w.role})` : ''} — ${w.agentState}${w.wip ? ` | WIP: ${w.wip.slice(0, 100)}` : ''}`
      ).join('\n')}`)
    }

    if (housekeepingParts.length > 0) {
      contextParts.push(`## 协作信息\n${housekeepingParts.join('\n\n')}`)
    }

    // 8. Unread inter-room messages
    if (unreadMessages.length > 0) {
      contextParts.push(`## 未读消息\n${unreadMessages.map(m =>
        `- #${m.id} from ${m.fromRoomId ?? 'unknown'}: ${m.subject}`
      ).join('\n')}`)
    }

    const skillSearchContext = [systemPrompt, ...contextParts].join('\n\n')
    const activeSkillsContext = buildActiveSkillsContext(loadSkillsForAgent(db, roomId, skillSearchContext))
    if (activeSkillsContext) {
      contextParts.push(activeSkillsContext)
    }

    const agentHermes = selectAgentHermesForCycle({
      isQueen,
      contextText: [systemPrompt, ...contextParts].join('\n\n')
    })
    contextParts.push(`## 本轮 Hermes 工具范围\n${agentHermes.instruction}`)

    const prompt = contextParts.join('\n\n')

    // 3. EXECUTE
    queries.updateAgentState(db, worker.id, 'acting')
    const promptTokenEstimate = Math.round(prompt.length / 4)
    logBuffer.addSynthetic('system', `Sending to ${model}... (~${promptTokenEstimate} tokens)`)
    logBuffer.flush()

    const apiKey = apiKeyEarly  // already resolved above for compression check

    // Build tool allow-list (null = all tools available)
    const allowListRaw = status.room.allowedTools?.trim() || null
    const allowSet = allowListRaw ? new Set(allowListRaw.split(',').map(s => s.trim())) : null

    // Hermes-based tool separation: queen/workers receive only the tools needed this cycle.
    const needsQueenTools = model === 'openai' || model.startsWith('openai:')
      || model === 'mimo' || model.startsWith('mimo:')
      || model === 'anthropic' || model.startsWith('anthropic:') || model.startsWith('claude-api:')

    const filteredToolDefs = allowSet
      ? agentHermes.toolDefs.filter(t => allowSet.has(t.function.name))
      : agentHermes.toolDefs
    const hermesAllowedTools = filteredToolDefs
      .map((tool) => `mcp__company__${tool.function.name}`)
      .join(',')
    const queenExecutionToolsUsed = new Set<string>()
    const trackQueenExecutionTool = (toolName: string | null | undefined): void => {
      if (!isQueen || !toolName) return
      if (QUEEN_EXECUTION_TOOLS.has(toolName)) queenExecutionToolsUsed.add(toolName)
    }
    const persistQueenPolicyDeviation = (): void => {
      if (!isQueen || queenExecutionToolsUsed.size === 0) return
      const used = [...queenExecutionToolsUsed].sort().join(', ')
      queries.logRoomActivity(
        db,
        roomId,
        'system',
        `Queen policy deviation: execution tool use detected (${used}).`,
        'Model B (soft): queen should delegate execution to workers and remain control-plane focused.',
        worker.id
      )
      const fresh = queries.getWorker(db, worker.id)
      const existing = fresh?.wip?.trim() ?? ''
      if (existing.includes(QUEEN_POLICY_WIP_HINT)) return
      const nextWip = existing ? `${existing}\n\n${QUEEN_POLICY_WIP_HINT}` : QUEEN_POLICY_WIP_HINT
      queries.updateWorkerWip(db, worker.id, nextWip.slice(0, 2000))
    }

    const apiToolOpts = needsQueenTools
      ? {
          toolDefs: filteredToolDefs,
          onToolCall: async (toolName: string, args: Record<string, unknown>): Promise<string> => {
            trackQueenExecutionTool(toolName)
            logBuffer.addSynthetic('tool_call', `→ ${toolName}(${JSON.stringify(args)})`)
            const result = await executeQueenTool(db, roomId, worker.id, toolName, args)
            logBuffer.addSynthetic('tool_result', result.content)
            return result.content
          }
        }
      : {}

    const executeWithSession = (sessionId?: string) => executeAgent({
      model,
      prompt,
      systemPrompt,
      apiKey,
      timeoutMs: worker.role === 'executor' ? 30 * 60 * 1000 : 15 * 60 * 1000,
      maxTurns: maxTurns ?? 50,
      onConsoleLog: (entry) => {
        if (entry.entryType === 'tool_call') {
          trackQueenExecutionTool(extractToolNameFromConsoleLog(entry.content))
        }
        logBuffer.onConsoleLog(entry)
      },
      // CLI models: limit MCP tools to this cycle's Hermes scope.
      allowedTools: isCli ? hermesAllowedTools : undefined,
      // CLI models: block unrelated MCP tools (daymon, etc.)
      disallowedTools: isCli ? 'mcp__daymon*' : undefined,
      // CLI models: bypass permission prompts for headless operation
      permissionMode: isCli ? 'bypassPermissions' : undefined,
      // CLI models: pass resumeSessionId for native --resume
      resumeSessionId: sessionId,
      // API models: pass conversation history + persistence callback
      previousMessages: isCli ? undefined : previousMessages,
      onSessionUpdate: isCli ? undefined : (msgs: Array<{ role: string; content: string }>) => {
        // Hard trim as safety net (compression should have already run above threshold)
        const trimmed = msgs.length > MAX_MESSAGES ? msgs.slice(-MAX_MESSAGES) : msgs
        queries.saveAgentSession(db, worker.id, { messagesJson: JSON.stringify(trimmed), model })
      },
      abortSignal,
      ...apiToolOpts
    })

    let result = await executeWithSession(resumeSessionId)
    if (isCli && result.exitCode !== 0) {
      const failure = result.output?.trim() || ''
      if (isCliContextOverflowError(failure)) {
        queries.deleteAgentSession(db, worker.id)
        logBuffer.addSynthetic('system', 'Session overflow detected — retrying this cycle with a fresh session')
        logBuffer.flush()
        result = await executeWithSession(undefined)
      }
    }

    if (abortSignal?.aborted) {
      const canceledMessage = 'Execution aborted'
      logBuffer.addSynthetic('error', canceledMessage)
      logBuffer.flush()
      queries.completeWorkerCycle(db, cycle.id, canceledMessage, result.usage)
      options?.onCycleLifecycle?.('failed', cycle.id, roomId)
      queries.updateAgentState(db, worker.id, 'idle')
      persistQueenPolicyDeviation()
      return result.output
    }

    // Check for rate limit
    const rateLimitInfo = checkRateLimit(result)
    if (rateLimitInfo) {
      throw new RateLimitError(rateLimitInfo)
    }

    // Check for non-rate-limit execution failure
    if (result.exitCode !== 0) {
      const errorDetail = result.output?.trim() || `exit code ${result.exitCode}`
      logBuffer.addSynthetic('error', `Agent execution failed: ${errorDetail.slice(0, 500)}`)
      logBuffer.flush()
      queries.completeWorkerCycle(db, cycle.id, errorDetail.slice(0, 500), result.usage)
      options?.onCycleLifecycle?.('failed', cycle.id, roomId)
      queries.logRoomActivity(db, roomId, 'error',
        `Agent cycle failed (${worker.name}): ${errorDetail.slice(0, 200)}`,
        errorDetail, worker.id)
      queries.updateAgentState(db, worker.id, 'idle')

      // If a CLI model failed due to context overflow / compaction, reset the session
      // so the next cycle starts fresh instead of resuming a broken context forever.
      if (isCli) {
        if (isCliContextOverflowError(errorDetail)) {
          queries.deleteAgentSession(db, worker.id)
          logBuffer.addSynthetic('system', 'Session reset due to context overflow — next cycle will start fresh')
          logBuffer.flush()
        }
      }

      persistQueenPolicyDeviation()
      return result.output
    }

    // CLI models: save returned sessionId for --resume in next cycle
    if (isCli && result.sessionId) {
      queries.saveAgentSession(db, worker.id, { sessionId: result.sessionId, model })
    }

    // For non-Claude models that don't stream: add synthetic output entry
    if (result.output && model !== 'claude' && !model.startsWith('codex')) {
      logBuffer.addSynthetic('assistant_text', result.output)
    }

    // 4. PERSIST
    persistQueenPolicyDeviation()
    logBuffer.addSynthetic('system', 'Cycle completed')
    if (result.usage && (result.usage.inputTokens > 0 || result.usage.outputTokens > 0)) {
      logBuffer.addSynthetic('system', `Tokens: ${result.usage.inputTokens} in / ${result.usage.outputTokens} out`)
    }
    logBuffer.flush()
    queries.completeWorkerCycle(db, cycle.id, undefined, result.usage)
    options?.onCycleLifecycle?.('completed', cycle.id, roomId)

    queries.logRoomActivity(db, roomId, 'system',
      `Agent cycle completed (${worker.name})`,
      result.output.slice(0, 500),
      worker.id)

    queries.updateAgentState(db, worker.id, 'idle')

    // Auto-WIP fallback: if agent didn't call save_wip, extract from last output
    try {
      const freshWorker = queries.getWorker(db, worker.id)
      if (!freshWorker?.wip && result.output) {
        const autoWip = result.output.slice(0, 500).replace(/\n/g, ' ').trim()
        if (autoWip.length > 20) {
          queries.updateWorkerWip(db, worker.id, `[auto] ${autoWip}`)
        }
      }
    } catch { /* non-fatal */ }

    // Prune old cycles periodically
    try { queries.pruneOldCycles(db) } catch { /* non-fatal */ }

    return result.output
  } catch (err) {
    // Complete cycle as failed
    const errorMsg = err instanceof Error ? err.message : String(err)
    logBuffer.addSynthetic('error', errorMsg.slice(0, 500))
    logBuffer.flush()
    try { queries.completeWorkerCycle(db, cycle.id, errorMsg.slice(0, 500)) } catch { /* DB may be closed */ }
    options?.onCycleLifecycle?.('failed', cycle.id, roomId)
    throw err
  }
}

// For testing: stop all loops
export function _stopAllLoops(): void {
  for (const [, loop] of runningLoops) {
    loop.running = false
    if (loop.waitAbort) loop.waitAbort.abort()
    if (loop.cycleAbort) loop.cycleAbort.abort()
  }
  runningLoops.clear()
  clearRoomLaunchState()
}
