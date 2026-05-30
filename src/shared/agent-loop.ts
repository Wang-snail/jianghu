import type Database from 'better-sqlite3'
import type { Worker, AgentState } from './types'
import type { AgentExecutionResult } from './agent-executor'
import type { RateLimitInfo } from './rate-limit'
import * as queries from './db-queries'
import { executeAgent, compressSession } from './agent-executor'
import { checkExpiredDecisions } from './quorum'
import { getRoomStatus } from './room'
import { detectRateLimit, sleep } from './rate-limit'
import { resolveApiKeyForModel, getModelProvider, resolveWorkerExecutionModel } from './model-provider'
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
  'company_browser',
])

const QUEEN_POLICY_WIP_HINT = '[policy] 帮主作战室模式：通过本地镖单委派工具把执行工作分给弟子，然后监控、解除阻塞并汇报结果。避免直接执行浏览器或网页操作。'

const QUEEN_AUTONOMY_PROTOCOL = `## 帮主自动运行协议
你要把自己当成当前帮派的项目负责人。即使没有人工盯着，也必须按这个顺序推进：
1. 判定阶段：从“目标分析 / 经验回忆 / 计划搭建 / 分派弟子 / 最小试运行 / 监督纠偏 / 继续执行 / 验收交付 / 复盘沉淀”中选一个当前阶段。
2. 先用记忆：制定计划或重分派前，先阅读“帮派记忆”；如果里面没有可用经验，调用 company_recall 搜索相近任务、失败原因、有效流程或验收标准。
3. 搭建流程：没有作战计划时，先写计划；计划至少包含子任务顺序、依赖关系、每步接收谁的输入、产出给谁、验收口径和最小试运行范围。
   - 不要默认做线性流程。根据任务需要选择“串行、并行、条件分支、汇合、审核、返工”关系。
   - 可并行采集/分析的镖单要放进同一并行组；需要多个上游结果后才能继续的节点要写汇合规则；审核不通过时要写返工节点。
   - 非串行关系必须写清“优化目标”和“关系依据”：说明它为了提速、提质、控风险、降成本或减少返工；没有明确业务收益时保持串行。
4. 分派弟子：每个镖单必须绑定具体弟子，并写清上游输入、下游接收方、输出格式限制、验收标准、试运行范围和禁止偏移事项。
   - 专人专职：不同性质的事情必须交给不同岗位弟子，不得把市场、竞品、数据、风险、报告等工作都交给一个人。
   - 专事专人：同一弟子默认最多同时承接 2 个未完成委托；临时通用执行弟子只允许做最小试运行或链路验证，不能承接复杂研究。
   - 缺少岗位时，先调用 company_create_worker 从客栈调入对应专职弟子，再调用 company_delegate_task 分派。
5. 监督验收：收到弟子结果后，先按验收标准判断“能不能被下游使用”；不能用就指出根因并返工，不要只说继续努力。
6. 纠偏防漂移：每轮都对照原委托目标，发现研究对象、结论范围或交付物偏移时，立即缩回目标边界。
7. 复盘沉淀：完成、返工、阻塞或换路后，用 company_remember 记录可复用经验，说明“下次遇到类似任务应怎么做/不要怎么做”。

进展保存必须包含：当前阶段、已完成动作、已产生结果、判断依据、阻塞根因、下一步、预计完成时间、需要沉淀的经验。`

const DEFAULT_SPECIALIST_ROSTER = [
  {
    name: '情报采集弟子',
    role: '情报采集',
    description: '专门负责外部资料、公开数据、来源清单和基础事实采集。',
    systemPrompt: '你是情报采集弟子。你只负责收集和整理可靠来源、链接、样本和事实，不做最终商业结论。输出必须包含来源、采集范围、样本限制和可交给下游使用的数据摘要。'
  },
  {
    name: '竞品分析弟子',
    role: '竞品分析',
    description: '专门负责竞品、品牌、价格带、卖点和差异化机会分析。',
    systemPrompt: '你是竞品分析弟子。你只负责竞品与品牌格局分析，接收情报采集弟子的资料，输出竞品表、差异化判断、证据和不确定性，不负责最终报告整合。'
  },
  {
    name: '数据核验弟子',
    role: '数据核验',
    description: '专门负责验证来源可信度、数据一致性、验收标准和风险疑点。',
    systemPrompt: '你是数据核验弟子。你只负责核验来源、样本、格式和结论证据链，发现不可用内容要指出根因并退回返工。输出必须包含通过项、问题项和修正建议。'
  },
  {
    name: '报告整合弟子',
    role: '报告整合',
    description: '专门负责把上游结果整合成用户可读、可验收、可复用的交付物。',
    systemPrompt: '你是报告整合弟子。你只负责整合已验收的上游结果，形成结构化中文报告、结论依据、风险说明和下一步建议；缺少证据时必须退回补充，不得自行编造。'
  },
] as const

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

function nextAutoWorkerName(workers: Worker[], baseName: string): string {
  const names = new Set(workers.map(w => w.name.toLowerCase()))
  if (!names.has(baseName.toLowerCase())) return baseName
  let idx = 2
  while (names.has(`${baseName}-${idx}`.toLowerCase())) idx++
  return `${baseName}-${idx}`
}

function extractToolNameFromConsoleLog(content: string): string | null {
  const usingMatch = content.match(/(?:Using|→)\s*([a-zA-Z0-9_]+)/)
  if (usingMatch?.[1]) return usingMatch[1]
  const callMatch = content.match(/^([a-zA-Z0-9_]+)\s*\(/)
  return callMatch?.[1] ?? null
}

const runningLoops = new Map<number, LoopState>()
const launchedRoomIds = new Set<number>()

export interface AgentLoopOptions {
  onCycleLogEntry?: CycleLogEntryCallback
  onCycleLifecycle?: (event: 'created' | 'completed' | 'failed', cycleId: number, roomId: number) => void
  allowColdStart?: boolean
  oneShot?: boolean
  runWhenInactive?: boolean
  directReplyEscalationId?: number
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
  if (room.status !== 'active' && !options?.runWhenInactive) throw new Error(`Room ${roomId} is not active (status: ${room.status})`)

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
      if (!currentRoom || (currentRoom.status !== 'active' && !options?.runWhenInactive)) break

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
        const directReply = options?.oneShot === true && options.directReplyEscalationId != null
        const configuredMaxTurns = currentWorker.maxTurns ?? currentRoom.queenMaxTurns
        // Full autonomous cycles need room to finish local work; direct user replies should stay light.
        const effectiveMaxTurns = directReply
          ? Math.min(Math.max(configuredMaxTurns ?? 8, 1), 12)
          : Math.max(configuredMaxTurns, 50)
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
      if (options?.oneShot) break

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

function cleanDirectReplyOutput(output: string): string {
  const text = output
    .replace(/\[local fallback\]\s*/g, '')
    .replace(/\[local fallback failed\][^\n]*/g, '')
    .trim()
  if (text.length <= 1800) return text
  return `${text.slice(0, 1800).trim()}…`
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
    const directReplyEscalationId = options?.directReplyEscalationId ?? null
    const isDirectReplyCycle = options?.oneShot === true && directReplyEscalationId != null
    const unreadMessages = queries.listRoomMessages(db, roomId, 'unread').slice(0, 5)

    if (isQueen && !isDirectReplyCycle) {
      const nonQueenWorkers = roomWorkers.filter(w => w.id !== worker.id)
      if (nonQueenWorkers.length === 0) {
        const inheritedModel = status.room.workerModel === 'queen'
          ? model
          : status.room.workerModel?.trim()
        if (!inheritedModel) {
          const err = '自动调入专职弟子已跳过：尚未配置执行模型。'
          queries.logRoomActivity(db, roomId, 'error', err, '请先设置全局模型。', worker.id)
          logBuffer.addSynthetic('error', err)
        } else {
          const createdNames: string[] = []
          for (const specialist of DEFAULT_SPECIALIST_ROSTER) {
            const name = nextAutoWorkerName(roomWorkers, specialist.name)
            const createdWorker = queries.createWorker(db, {
              name,
              role: specialist.role,
              description: specialist.description,
              systemPrompt: specialist.systemPrompt,
              model: inheritedModel,
              cycleGapMs: WORKER_ROLE_PRESETS.researcher?.cycleGapMs,
              maxTurns: WORKER_ROLE_PRESETS.researcher?.maxTurns,
            })
            queries.updateWorker(db, createdWorker.id, { roomId })
            roomWorkers.push(createdWorker)
            createdNames.push(name)
          }
          queries.logRoomActivity(
            db,
            roomId,
            'system',
            `已按专人专职调入 ${createdNames.length} 名专职弟子。`,
            `先在客栈登记，再调入当前帮派：${createdNames.join('、')}。帮主需要按岗位分派，避免一个弟子承接所有上下文。`,
            worker.id
          )
          logBuffer.addSynthetic('system', `因帮派暂无可执行弟子，已自动调入专职弟子：${createdNames.join('、')}。`)
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

    const agentSession = isDirectReplyCycle ? undefined : queries.getAgentSession(db, worker.id)
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
      `## 身份\n- 帮派 ID: ${roomId}\n- 弟子 ID: ${worker.id}\n- 你的名字: ${worker.name}`
    )

    if (isDirectReplyCycle) {
      contextParts.push(`## 直接对话模式
这是用户主动发给帮主的即时消息。你现在只需要回答用户，不要启动完整自治循环，不要创建弟子，不要分派镖单，不要写文件，不要续写旧进展。
回答应当简短、具体、可执行：先给结论，再说明依据或下一步。能用本地消息工具回复用户就用 company_send_message(to=keeper)；如果工具不可用，直接把最终回复作为本轮输出。`)
    }

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
- 不得读取或写入其他帮派、其他弟子的私有目录；客栈候选弟子未入帮前不得写入任何帮派目录。
- 本系统里的“功法”和“skills”只来自藏经阁与本轮 Hermes。不要读取或执行 Codex 开发环境里的 Superpowers、browser、documents、figma 等技能文件；除非当前镖单明确要求修改本项目代码，否则不要提及这些开发技能。`)

    // 2. WIP — resume directive (highest priority, before everything else)
    const wip = worker.wip
    if (wip && !isDirectReplyCycle) {
      contextParts.push(`## >>> 继续推进 <<<
上一轮已完成或正在处理：

${wip}

现在执行下一步。不要重复已经完成的工作，要在现有进展上继续推进。
如果上述事项已经完成，就围绕委托目标启动下一个本地可执行动作。
本轮结束前，使用本地进展保存工具记录你的最新位置。`)
    }

    // 3. Jianghu objective, goals, and assigned tasks
    if (status.room.goal) {
      contextParts.push(`## 委托目标\n${status.room.goal}`)
    }

    if (isQueen && isDirectReplyCycle) {
      contextParts.push(`## 帮主即时回复边界
- 你是当前帮派的帮主，不是天机阁。
- 用户问进展、结果、阻塞、协作流程或下一步时，按当前帮派本地状态直接回答。
- 不要把用户消息转给弟子；接收者就是你，回复者也应是你。`)
    } else if (isQueen) {
      contextParts.push(QUEEN_AUTONOMY_PROTOCOL)
      contextParts.push(`## 帮主作战室契约
- 你负责帮派运转：分析目标、制定计划、从客栈选择弟子、分派镖单、监控交付、解除阻塞。
- 工作顺序固定：先分析委托目标和验收标准 → 回忆相近经验 → 制定作战计划 → 按依赖安排弟子 → 写清上下游与输出格式 → 做一次最小试运行 → 监督运行 → 定位并更正问题 → 继续运行并复核目标。
- 不得跳过计划直接扩写结果；不得把“继续产出更多内容”当成解决问题；每轮都要检查动作是否仍服务原委托目标。
- 如果当前帮派还没有弟子，只能从客栈选择并调入弟子；不得把天机阁、帮主或其他帮派成员当作可分派弟子。
- 所有执行工作优先委派给弟子，并通过本地消息跟进。
- 每张分派给弟子的镖单必须包含：任务目标、上游输入或来源、下游接收方、输出格式限制、验收标准、试运行范围、禁止偏移事项。
- 发现问题时先定位根因：目标理解、分工依赖、数据来源、工具调用、输出格式、预算约束或弟子能力；再更正计划、拆小镖单、补充说明、换人或发起议事堂。
- 需要多人判断时开启议事堂，记录讨论过程和结论；不要把问题变成投票。
- 除非没有其他可行路径，否则不要直接替弟子做执行镖单。`)
      contextParts.push(`## 帮主本地作战工具
帮主不是天机阁，也不拥有天机阁成员。你只使用本轮 Hermes 按需分配的当前帮派工具，完成目标分析、计划、客栈选人、镖单分派、消息传递、验收关闭和帮派记忆保存。

工具边界：
- 只服务当前帮派和当前委托目标。
- 不得越权操作其他帮派、其他弟子私有目录或用户未授权的设置。
- 不得创建或修改天机阁固定技能；天机阁固定技能只属于全局天机阁。`)
    } else {
      contextParts.push(`## 弟子接单契约
- 只处理帮主分派给你的镖单，不自行扩大委托范围。
- 开始执行前先核对：上游输入、下游接收方、输出格式限制、验收标准和试运行范围。
- 如果分派说明缺少上下游或格式限制，先向帮主发消息请求澄清；不要用猜测填补关键约束。
- 交付时按指定格式输出，并说明：做了什么、产生了什么结果、交给谁、还卡在哪里。`)
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

    const roomTaskRecords = queries.listTasks(db, roomId).slice(0, 8)
    if (roomTaskRecords.length > 0) {
      const workerMap = new Map(roomWorkers.map(w => [w.id, w.name]))
      const taskLines = roomTaskRecords.map(task => {
        const assignee = task.workerId ? (workerMap.get(task.workerId) ?? `弟子 #${task.workerId}`) : '未分派'
        const result = task.lastResult ? ` | 最新结果: ${task.lastResult.slice(0, 180).replace(/\s+/g, ' ')}` : ''
        const flow = task.description ? ` | 流程: ${task.description.slice(0, 220).replace(/\s+/g, ' ')}` : ''
        return `- 镖单 #${task.id}「${task.name}」(${task.status}) → ${assignee}${flow}${result}`
      })
      contextParts.push(`## 协作流程与镖单记录\n${taskLines.join('\n')}\n\n帮主必须用这里判断流程是否已经建立、哪一步正在执行、哪一步缺结果；不要只凭记忆猜测。`)
    } else if (isQueen && !isDirectReplyCycle && status.room.goal) {
      contextParts.push(`## 协作流程与镖单记录
当前还没有正式镖单记录。帮主下一步应先搭建任务树和协作流程，再把最小试运行镖单分派给具体弟子。`)
    }

    // 4. Room Memory — relevance-based (top 5 by hybrid search against WIP/goal)
    const searchQuery = wip || status.room.goal || ''
    const memoryResults = !isDirectReplyCycle && searchQuery
      ? queries.hybridSearch(db, searchQuery, null, 20)
          .filter(r => r.entity.roomId === roomId).slice(0, 5)
      : (!isDirectReplyCycle ? queries.listEntities(db, roomId).slice(0, 5).map(e => ({ entity: e, rank: 0 })) : [])
    if (memoryResults.length > 0) {
      const memLines = memoryResults
        .map(r => {
          const obs = queries.getObservations(db, r.entity.id)
          const content = obs[0]?.content ?? ''
          return content ? `- **${r.entity.name}**: ${content.slice(0, 300)}` : null
        })
        .filter((l): l is string => l !== null)
      if (memLines.length > 0) {
        contextParts.push(`## 帮派记忆\n${memLines.join('\n')}`)
      }
    }

    // 5. Stuck detector
    const STUCK_THRESHOLD_CYCLES = 2
    const productiveCallCount = queries.countProductiveToolCalls(db, worker.id, STUCK_THRESHOLD_CYCLES)
    const recentCompletedCycles = queries.listRoomCycles(db, roomId, 5)
      .filter(c => c.workerId === worker.id && c.status === 'completed')
    const hasActiveGoals = status.activeGoals.length > 0
    const isStuck = !isDirectReplyCycle && hasActiveGoals && recentCompletedCycles.length >= STUCK_THRESHOLD_CYCLES && productiveCallCount === 0
    if (isStuck) {
      if (wip) {
        contextParts.push(`## 行动停滞\n你最近 ${STUCK_THRESHOLD_CYCLES} 轮都有未完成进展，但没有产生可检查结果。换一条执行路径，或明确报告阻塞原因。`)
      } else {
        contextParts.push(`## 需要立即行动\n你最近 ${STUCK_THRESHOLD_CYCLES} 轮没有产生结果。现在选择一个具体动作并执行。`)
      }
      logBuffer.addSynthetic('system', `停滞检测：最近 ${STUCK_THRESHOLD_CYCLES} 轮没有有效本地动作`)
    }

    // 6. Instructions (lean)
    const isClaude = model === 'claude' || model.startsWith('claude-')
    const toolCallInstruction = isDirectReplyCycle
      ? '这是即时对话，不要求额外本地动作；优先直接回答用户，必要时只用 company_send_message 或 company_recall。'
      : isClaude
      ? '必须调用本地工具推进行动。'
      : '重要：本轮回复必须至少调用一次本地工具。'

    const hasWip = !!wip
    const actionPriority = isDirectReplyCycle
      ? '直接回答用户当前消息，不要继续旧任务。'
      : hasWip
      ? '你上面有正在进行的工作，继续推进它。'
      : '围绕委托目标采取一个具体的本地行动。'

    contextParts.push(isDirectReplyCycle
      ? `## 执行要求\n${actionPriority}\n回复要面向用户可读，不展示内部规则和后台实现；如果当前没有足够信息，要说明缺什么，并给出下一步动作。\n${toolCallInstruction}`
      : `## 执行要求\n${actionPriority}\n你有足够的轮次，要把当前动作推进到可检查状态。\n本轮结束前，保存进展、阻塞点、下一步和预计完成时间。\n${isQueen ? '本轮必须明确当前处在“目标分析 / 计划 / 分派 / 试运行 / 监督纠偏 / 继续执行 / 验收交付”的哪个阶段，并说明下一步如何防止偏移原目标。' : '本轮必须按分派的输出格式交付；如果无法交付，说明缺少哪个上游输入或格式约束。'}\n${toolCallInstruction}`)

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
    const myKeeperMessages = isDirectReplyCycle ? [] : pendingEscalations.filter(e => e.fromAgentId === worker.id && !e.toAgentId)
    const incomingUserMessages = pendingEscalations
      .filter(e => e.toAgentId === worker.id && e.fromAgentId == null)
      .filter(e => directReplyEscalationId == null || e.id === directReplyEscalationId)
    const incomingWorkerMessages = pendingEscalations.filter(e => e.toAgentId === worker.id && e.fromAgentId != null && e.fromAgentId !== worker.id)

    if (incomingUserMessages.length > 0) {
      housekeepingParts.push(`**用户直接消息（本轮必须处理并回复）**\n${incomingUserMessages.map(e =>
        `- #${e.id}: ${e.question}`
      ).join('\n')}\n处理完后必须使用 company_send_message，to=keeper，向用户回复本轮结果、判断或下一步。不要只保存进展。`)
    }

    if (incomingWorkerMessages.length > 0) {
      const senderNames = new Map(roomWorkers.map(w => [w.id, w.name]))
      housekeepingParts.push(`**弟子消息**\n${incomingWorkerMessages.map(e => {
        const sender = senderNames.get(e.fromAgentId ?? 0) ?? `弟子 #${e.fromAgentId}`
        return `- #${e.id} 来自 ${sender}: ${e.question}`
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
      housekeepingParts.push(`**帮派弟子**\n${roomWorkers.filter(w => w.id !== worker.id).map(w =>
        `- #${w.id} ${w.name}${w.role ? ` (${w.role})` : ''} — ${w.agentState}${w.wip ? ` | 进展: ${w.wip.slice(0, 100)}` : ''}`
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
    const activeSkillsContext = isDirectReplyCycle
      ? ''
      : buildActiveSkillsContext(loadSkillsForAgent(db, roomId, skillSearchContext))
    if (activeSkillsContext) {
      contextParts.push(activeSkillsContext)
    }

    const agentHermes = selectAgentHermesForCycle({
      isQueen,
      contextText: [systemPrompt, ...contextParts].join('\n\n'),
      maxHermes: isDirectReplyCycle ? 2 : undefined
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

    const selectedToolDefs = isDirectReplyCycle
      ? agentHermes.toolDefs.filter(t => ['company_send_message', 'company_recall'].includes(t.function.name))
      : agentHermes.toolDefs
    const filteredToolDefs = allowSet
      ? selectedToolDefs.filter(t => allowSet.has(t.function.name))
      : selectedToolDefs
    const hermesAllowedTools = filteredToolDefs
      .map((tool) => `mcp__company__${tool.function.name}`)
      .join(',')
    const localToolAllowSet = new Set(filteredToolDefs.map((tool) => tool.function.name))
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
        `帮主越权提醒：检测到直接使用执行工具（${used}）。`,
        '帮主应通过镖单把执行工作分给弟子，自己保持调度和验收职责。',
        worker.id
      )
      const fresh = queries.getWorker(db, worker.id)
      const existing = fresh?.wip?.trim() ?? ''
      if (existing.includes(QUEEN_POLICY_WIP_HINT)) return
      const nextWip = existing ? `${existing}\n\n${QUEEN_POLICY_WIP_HINT}` : QUEEN_POLICY_WIP_HINT
      queries.updateWorkerWip(db, worker.id, nextWip.slice(0, 2000))
    }

    const runLocalCompanyTool = async (toolName: string, args: Record<string, unknown>): Promise<string> => {
      const localToolName = toolName.startsWith('mcp__company__')
        ? toolName.slice('mcp__company__'.length)
        : toolName
      if (!localToolAllowSet.has(localToolName)) {
        return `工具「${localToolName}」没有分配给当前角色或本轮 Hermes，已拒绝执行。`
      }
      trackQueenExecutionTool(localToolName)
      logBuffer.addSynthetic('tool_call', `→ ${localToolName}(${JSON.stringify(args)})`)
      const result = await executeQueenTool(db, roomId, worker.id, localToolName, args)
      logBuffer.addSynthetic('tool_result', result.content)
      return result.content
    }

    const apiToolOpts = needsQueenTools
      ? {
          toolDefs: filteredToolDefs,
          onToolCall: runLocalCompanyTool
        }
      : (model === 'codex' || model.startsWith('codex:'))
        ? { onToolCall: runLocalCompanyTool }
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
      resumeSessionId: isDirectReplyCycle ? undefined : sessionId,
      // API models: pass conversation history + persistence callback
      previousMessages: isCli ? undefined : previousMessages,
      onSessionUpdate: isCli || isDirectReplyCycle ? undefined : (msgs: Array<{ role: string; content: string }>) => {
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
    if (isCli && result.sessionId && !isDirectReplyCycle) {
      queries.saveAgentSession(db, worker.id, { sessionId: result.sessionId, model })
    }

    // For non-Claude models that don't stream: add synthetic output entry
    if (result.output && model !== 'claude' && !model.startsWith('codex')) {
      logBuffer.addSynthetic('assistant_text', result.output)
    }

    // 4. PERSIST
    persistQueenPolicyDeviation()
    if (incomingUserMessages.length > 0) {
      const newestIncomingUserMessageId = incomingUserMessages.reduce((max, message) => Math.max(max, message.id), 0)
      let repliedToUser = queries.listEscalations(db, roomId).some(message =>
        message.id > newestIncomingUserMessageId &&
        message.fromAgentId === worker.id &&
        message.toAgentId == null
      )
      if (!repliedToUser && isDirectReplyCycle) {
        const replyText = cleanDirectReplyOutput(result.output)
        if (replyText) {
          queries.createEscalation(db, roomId, worker.id, replyText)
          logBuffer.addSynthetic('system', '已将帮主即时回复写入对话记录。')
          repliedToUser = true
        }
      }
      if (repliedToUser) {
        for (const message of incomingUserMessages) {
          queries.resolveEscalation(db, message.id, '帮主已回复。')
        }
      }
    }
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
      if (!isDirectReplyCycle && !freshWorker?.wip && result.output) {
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
