import { useState, useEffect, useRef, useCallback } from 'react'
import { usePolling } from '../hooks/usePolling'
import { useWebSocket } from '../hooks/useWebSocket'
import { useContainerWidth } from '../hooks/useContainerWidth'
import { useTick } from '../hooks/useTick'
import { LiveConsoleSection } from './LiveConsoleSection'
import { TasksPanel } from './TasksPanel'
import { GoalsPanel } from './GoalsPanel'
import { api, type RoomResultFile } from '../lib/client'
import { buildProjectOutputSummary } from '../lib/project-outputs'
import {
  ROOM_BALANCE_EVENT_TYPES,
  ROOM_ESCALATION_EVENT_TYPES,
  ROOM_NETWORK_EVENT_TYPES,
} from '../lib/room-events'
import { wsClient, type WsMessage } from '../lib/ws'
import { storageGet, storageSet } from '../lib/storage'
import { activityToneClass, describeCycleActivity } from '../lib/cycle-activity'
import type { Task, TaskRun, WorkerCycle, RoomActivityEntry, Worker, RevenueSummary, Room, Escalation, Goal } from '@shared/types'
import { parseTaskFlowSpec } from '@shared/task-flow'
import { formatRelativeTime } from '../utils/time'

interface StatusData {
  room: Room | null
  entityCount: number
  tasks: Task[]
  latestRun: TaskRun | null
  latestCycle: WorkerCycle | null
  runningRuns: TaskRun[]
  workerCount: number
}


function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

const cardClass =
  'w-full text-left p-3 bg-surface-secondary rounded-lg shadow-sm hover:bg-surface-hover transition-colors cursor-pointer'

const EVENT_TYPE_COLORS: Record<string, string> = {
  decision: 'bg-interactive-bg text-interactive',
  milestone: 'bg-status-warning-bg text-status-warning',
  financial: 'bg-status-success-bg text-status-success',
  deployment: 'bg-status-info-bg text-status-info',
  worker: 'bg-brand-100 text-brand-700',
  error: 'bg-status-error-bg text-status-error',
  system: 'bg-surface-tertiary text-text-muted',
  self_mod: 'bg-interactive-bg text-interactive',
}

const EVENT_TYPE_LABELS: Record<string, string> = {
  decision: '决策',
  milestone: '里程碑',
  financial: '钱庄',
  deployment: '部署',
  worker: '弟子',
  error: '错误',
  system: '系统',
  self_mod: '自我修改',
}

const OVERVIEW_VIEW_MODE_KEY = 'jianghu_overview_view_mode'
const WORKBENCH_VIEW_KEY = 'jianghu_leader_workbench_view'

const GANG_PHASES = ['筹备中', '执行中', '验收中', '已完成', '已失败'] as const
type GangPhase = typeof GANG_PHASES[number]
type WorkbenchView = 'overview' | 'conversation' | 'goals' | 'outputs' | 'inspection' | 'training' | 'flow' | 'gantt'

const PHASE_COLORS: Record<GangPhase, string> = {
  筹备中: 'bg-status-warning-bg text-status-warning',
  执行中: 'bg-interactive-bg text-interactive',
  验收中: 'bg-status-info-bg text-status-info',
  已完成: 'bg-status-success-bg text-status-success',
  已失败: 'bg-status-error-bg text-status-error',
}

function statusText(status: string): string {
  if (status === 'active') return '执行中'
  if (status === 'paused') return '已阻塞'
  if (status === 'completed') return '已完成'
  if (status === 'error') return '已失败'
  if (status === 'running') return '执行中'
  if (status === 'failed') return '已失败'
  if (status === 'cancelled') return '已取消'
  return status
}

function inferGangPhase(
  room: Room | null,
  tasks: Task[],
  runningRuns: TaskRun[],
  workerCount: number,
  queenRunning: boolean
): { phase: GangPhase; progress: number; note: string } {
  if (tasks.some(t => t.status === 'error')) {
    return { phase: '已失败', progress: Math.max(5, Math.round(taskCompletionRatio(tasks) * 100)), note: '已有镖单失败，需触发复盘后归档。' }
  }
  if (room?.status === 'stopped') {
    const allDone = tasks.length > 0 && tasks.every(t => t.status === 'completed')
    return { phase: allDone ? '已完成' : '已失败', progress: allDone ? 100 : Math.max(10, Math.round(taskCompletionRatio(tasks) * 100)), note: allDone ? '任务已交付，等待复盘档案沉淀。' : '帮派已停止，需查看失败原因。' }
  }
  if (room?.status === 'paused') {
    return { phase: '筹备中', progress: Math.max(8, Math.round(taskCompletionRatio(tasks) * 100)), note: '帮派处于闭关或阻塞状态，天机处需要恢复后才能推进。' }
  }
  if (tasks.length > 0 && tasks.every(t => t.status === 'completed')) {
    return { phase: '验收中', progress: 92, note: '帮主已收齐成果，天机处正在验收。' }
  }
  if (runningRuns.length > 0 || tasks.some(t => t.status === 'active') || queenRunning) {
    return { phase: '执行中', progress: Math.max(18, Math.round(taskCompletionRatio(tasks) * 100)), note: '弟子正在执行子任务，帮主负责过程监控和结果整合。' }
  }
  if (tasks.length === 0 || workerCount === 0) {
    return { phase: '筹备中', progress: workerCount > 0 ? 18 : 8, note: '帮主正在挑人、领功法、申请预算。' }
  }
  return { phase: '筹备中', progress: 24, note: '镖单已备好，等待天机处启动执行。' }
}

function taskCompletionRatio(tasks: Task[]): number {
  if (tasks.length === 0) return 0
  const score = tasks.reduce((sum, task) => {
    if (task.status === 'completed') return sum + 1
    if (task.status === 'active') return sum + 0.45
    if (task.status === 'paused') return sum + 0.2
    return sum
  }, 0)
  return Math.min(1, Math.max(0, score / tasks.length))
}

function taskShortName(task: Task): string {
  return task.name || task.description?.slice(0, 18) || `镖单 #${task.id}`
}

function taskBrief(task: Task): string {
  return task.description?.trim() || task.prompt.split('\n')[0]?.slice(0, 64) || '等待明确子任务'
}

function taskDetailText(value: string | null | undefined, fallback: string): string {
  const text = value?.trim()
  return text && text.length > 0 ? text : fallback
}

function taskLongText(value: string | null | undefined, fallback: string, max = 900): string {
  const text = taskDetailText(value, fallback)
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function workerStateLabel(state: string): string {
  if (state === 'thinking') return '执行中'
  if (state === 'acting') return '执行中'
  if (state === 'voting') return '等待审核'
  if (state === 'rate_limited') return '返工中'
  if (state === 'blocked') return '已失败'
  if (state === 'idle') return '待命'
  return state || '待命'
}

function stripMarkdown(value: string): string {
  return value
    .replace(/\/Users\/[^)\s]+/g, '本地文件')
    .replace(/dm\/实验项目\/[^)\s]+/g, '本地文件')
    .replace(/\*\*/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*$/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

function containsInternalNoise(value: string): boolean {
  return /using-superpowers|verification-before-completion|brainstorming|apply_patch|shell|sqlite3|handler|源码|out\/mcp|Hermes|company_[a-z_]+|unexpected argument|Usage: codex exec|--help|Invalid API key|API key/i.test(value)
}

function clipLogText(value: string, max = 86): string {
  const text = stripMarkdown(value)
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}

function extractWorkerName(summary: string): string | null {
  const match = summary.match(/Agent cycle (?:started|completed|failed) \(([^)]+)\)/)
  return match?.[1]?.trim() || null
}

function cleanResultLine(line: string): string {
  return stripMarkdown(line)
    .replace(/^[-*\d.\s]+/, '')
    .replace(/^本轮(已)?/, '本轮已')
    .replace(/^\s*现在(做|写入|读取|检查|确认).*/, '')
    .trim()
}

function extractResultFromDetails(details?: string | null): string | null {
  if (!details) return null

  const usefulLines = details
    .split('\n')
    .map(cleanResultLine)
    .filter(line =>
      line.length >= 6 &&
      !line.startsWith('我会') &&
      !line.startsWith('我先') &&
      !line.startsWith('接下来') &&
      !line.startsWith('继续使用') &&
      !line.startsWith('使用 ') &&
      !line.startsWith('当前环境') &&
      !/现在做|现在检查|现在读取|做一次|做验收|落盘/.test(line) &&
      !containsInternalNoise(line)
    )

  const resultLine = [...usefulLines].reverse().find(line =>
    /本轮已|已新增|已创建|已写入|已生成|已补齐|已落地|已更新|验收通过|复核通过|完成|产出|交付|通过/.test(line)
  )
  if (resultLine) return clipLogText(resultLine)

  const handoffLine = [...usefulLines].reverse().find(line =>
    /状态|阻塞|缺口|下一步|风险|等待|闭关|暂停/.test(line)
  )
  if (handoffLine) return clipLogText(handoffLine)

  const firstUsefulLine = usefulLines[0]

  return firstUsefulLine ? clipLogText(firstUsefulLine) : null
}

function shouldShowActivityEntry(entry: RoomActivityEntry): boolean {
  const summary = entry.summary.trim()
  if (/Agent cycle started/.test(summary)) return false
  if (/Wallet created/i.test(summary)) return false
  if (/Agent cycle failed/.test(summary) && /unexpected argument '-C'|Usage: codex exec/.test(`${summary}\n${entry.details ?? ''}`)) return false
  return true
}

function readableError(details: string, summary: string): string {
  const raw = `${details || summary}`.trim()
  if (/Invalid API key|Incorrect API key|API key/i.test(raw)) {
    return 'AI 连接密钥不可用，需要在设置中重新配置后再运行。'
  }
  if (/unexpected argument '-C'|Usage: codex exec/.test(raw)) {
    return '后台执行器参数异常，已记录为系统配置问题。'
  }
  return clipLogText(raw, 110)
}

function formatCommunicationEntry(
  entry: RoomActivityEntry,
  workersById: Map<number, Worker>,
  leaderId?: number | null
): { actor: string; action: string; result: string; tone: 'normal' | 'success' | 'warning' | 'error' } {
  const actor = entry.actorId
    ? workersById.get(entry.actorId)?.name ?? `弟子 #${entry.actorId}`
    : '天机阁'
  const summary = entry.summary.trim()
  const details = entry.details?.trim() || ''

  if (/Agent cycle started/.test(summary)) {
    return {
      actor: extractWorkerName(summary) ?? actor,
      action: '开始处理新一轮任务',
      result: '正在查看目标、资料、弟子状态和下一步动作。',
      tone: 'normal',
    }
  }

  if (/Agent cycle completed/.test(summary)) {
    return {
      actor: extractWorkerName(summary) ?? actor,
      action: '完成一轮执行',
      result: extractResultFromDetails(details) ?? '已更新进展，等待下一轮复核或交付。',
      tone: 'success',
    }
  }

  if (/Agent cycle failed|失败|error/i.test(summary)) {
    return {
      actor: extractWorkerName(summary) ?? actor,
      action: '执行遇到问题',
      result: readableError(details, summary),
      tone: 'error',
    }
  }

  const workerMessage = summary.match(/弟子 #(\d+) 向弟子 #(\d+) 发出消息/)
  if (workerMessage) {
    const from = workersById.get(Number(workerMessage[1]))?.name ?? `弟子 #${workerMessage[1]}`
    const to = workersById.get(Number(workerMessage[2]))?.name ?? `弟子 #${workerMessage[2]}`
    return {
      actor: from,
      action: `对 ${to} 说`,
      result: details ? `“${clipLogText(details, 110)}”` : '已发送一条内部消息。',
      tone: 'normal',
    }
  }

  const userMessage = summary.match(/弟子 #(\d+) 向用户发出消息/)
  if (userMessage) {
    const from = workersById.get(Number(userMessage[1]))?.name ?? `弟子 #${userMessage[1]}`
    return {
      actor: from,
      action: '向用户汇报',
      result: details ? `“${clipLogText(details, 110)}”` : '已发送一条需要用户关注的消息。',
      tone: 'normal',
    }
  }

  if (/用户向帮主发出消息/.test(summary)) {
    return {
      actor: '你',
      action: '对帮主说',
      result: details ? `“${clipLogText(details, 110)}”` : '已发送一条管理指令。',
      tone: 'normal',
    }
  }

  const userToWorkerMessage = summary.match(/用户向弟子 #(\d+) 发出消息/)
  if (userToWorkerMessage) {
    const targetId = Number(userToWorkerMessage[1])
    const target = leaderId === targetId
      ? '帮主'
      : workersById.get(targetId)?.name ?? `弟子 #${targetId}`
    return {
      actor: '你',
      action: `对${target}说`,
      result: details ? `“${clipLogText(details, 110)}”` : '已发送一条消息。',
      tone: 'normal',
    }
  }

  if (/天机阁创建帮派/.test(summary)) {
    return {
      actor: '天机阁',
      action: '创建了帮派',
      result: clipLogText(details || summary),
      tone: 'success',
    }
  }

  if (/闭关|暂停|阻塞/.test(summary)) {
    return {
      actor,
      action: '标记了阻塞状态',
      result: clipLogText(details || summary),
      tone: 'warning',
    }
  }

  if (entry.eventType === 'financial') {
    return {
      actor: '钱庄',
      action: '更新了财气流水',
      result: containsInternalNoise(details || summary) ? '已记录一笔内部财气变化。' : clipLogText(details || summary),
      tone: 'success',
    }
  }

  return {
    actor,
    action: clipLogText(summary, 48),
    result: details ? clipLogText(details, 110) : '已记录到帮派动向。',
    tone: entry.eventType === 'error' ? 'error' : 'normal',
  }
}

function formatLeaderResult(value: string): string {
  const text = stripMarkdown(value)
  if (!text) return '帮主已处理完毕。'
  return text
}

function formatProcessLine(
  entry: RoomActivityEntry,
  workersById: Map<number, Worker>,
  leaderId?: number | null
): string {
  const item = formatCommunicationEntry(entry, workersById, leaderId)
  return `${item.actor}${item.action ? ` ${item.action}` : ''}：${item.result}`
}

function discipleProgress(task: Task | undefined, run: TaskRun | undefined, worker: Worker): number {
  if (task?.status === 'completed') return 100
  if (task?.status === 'paused') return 20
  if (run?.progress != null) return Math.round(run.progress * 100)
  if (worker.agentState === 'thinking' || worker.agentState === 'acting') return 45
  if (worker.agentState === 'voting') return 72
  return task ? 28 : 8
}

function budgetPercent(tasks: Task[], usage: { total: { inputTokens: number; outputTokens: number; cycles: number } } | null): number {
  const tokenTotal = (usage?.total.inputTokens ?? 0) + (usage?.total.outputTokens ?? 0)
  const tokenScore = Math.min(70, Math.round(tokenTotal / 2500))
  const taskScore = Math.min(25, tasks.reduce((sum, t) => sum + Math.max(0, t.runCount), 0) * 4)
  const errorScore = Math.min(15, tasks.reduce((sum, t) => sum + Math.max(0, t.errorCount), 0) * 5)
  return Math.min(98, Math.max(6, tokenScore + taskScore + errorScore))
}

interface StatusPanelProps {
  onNavigate?: (tab: string) => void
  advancedMode: boolean
  roomId?: number | null
}

export function StatusPanel({ onNavigate, advancedMode, roomId }: StatusPanelProps): React.JSX.Element {
  useTick()
  const [containerRef, containerWidth] = useContainerWidth<HTMLDivElement>()
  const wide = containerWidth >= 600
  const [workbenchView, setWorkbenchViewState] = useState<WorkbenchView>(() => {
    const saved = storageGet(WORKBENCH_VIEW_KEY)
    return saved === 'conversation' || saved === 'goals' || saved === 'outputs' || saved === 'inspection' || saved === 'training' || saved === 'flow' || saved === 'gantt'
      ? saved
      : 'overview'
  })
  const [viewMode, setViewMode] = useState<'activity' | 'console'>(() => {
    const saved = storageGet(OVERVIEW_VIEW_MODE_KEY)
    return saved === 'console' ? 'console' : 'activity'
  })
  const [leaderMessage, setLeaderMessage] = useState('')
  const [trainingWorkerId, setTrainingWorkerId] = useState<number | ''>('')
  const [trainingText, setTrainingText] = useState('')
  const [workbenchNotice, setWorkbenchNotice] = useState<string | null>(null)
  const [workbenchSending, setWorkbenchSending] = useState(false)
  const [leaderReplyRequest, setLeaderReplyRequest] = useState<{ escalationId: number; sentAt: number } | null>(null)
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null)

  const fetchStatus = useCallback(async (): Promise<StatusData> => {
    const [stats, tasks, runs, workers, runningRuns, cycles, rooms] = await Promise.all([
      api.memory.getStats(),
      api.tasks.list(roomId ?? undefined),
      api.runs.list(1),
      roomId ? api.workers.listForRoom(roomId) : Promise.resolve([]),
      api.runs.list(20, { status: 'running', roomId: roomId ?? undefined }),
      roomId ? api.cycles.listByRoom(roomId, 1) : Promise.resolve([]),
      roomId ? api.rooms.list().catch(() => []) : Promise.resolve([]),
    ])
    return {
      room: rooms.find(room => room.id === roomId) ?? null,
      entityCount: stats.entityCount,
      tasks,
      latestRun: runs[0] ?? null,
      latestCycle: cycles[0] ?? null,
      runningRuns,
      workerCount: workers.length
    }
  }, [roomId])

  const { data, error, isLoading, refresh: refreshStatus } = usePolling(fetchStatus, 60000)
  const refreshStatusTimeoutRef = useRef<number | null>(null)

  // Refresh immediately when room changes
  useEffect(() => { refreshStatus() }, [roomId, refreshStatus])
  const taskEvent = useWebSocket('tasks')
  const runsEvent = useWebSocket('runs')
  const workersEvent = useWebSocket('workers')
  const memoryEvent = useWebSocket('memory')

  useEffect(() => {
    if (!taskEvent && !runsEvent && !workersEvent && !memoryEvent) return
    if (refreshStatusTimeoutRef.current) return
    refreshStatusTimeoutRef.current = window.setTimeout(() => {
      refreshStatusTimeoutRef.current = null
      void refreshStatus()
    }, 250)
  }, [memoryEvent, refreshStatus, runsEvent, taskEvent, workersEvent])

  useEffect(() => () => {
    if (refreshStatusTimeoutRef.current) {
      window.clearTimeout(refreshStatusTimeoutRef.current)
      refreshStatusTimeoutRef.current = null
    }
  }, [])

  // Queen status
  const { data: queenStatus, refresh: refreshQueenStatus } = usePolling<{
    workerId: number
    agentState: string
    running: boolean
    name: string
  } | null>(
    () => roomId ? api.rooms.queenStatus(roomId).catch(() => null) : Promise.resolve(null),
    5000
  )
  const queenRunning = queenStatus?.running === true
  const queenActive = queenRunning && queenStatus?.agentState !== '空闲'

  // Room activity — keep Overview responsive while user is on Timeline.
  const isTimelineView = viewMode === 'activity'
  const activityPollMs = isTimelineView
    ? (queenActive ? 5000 : 10000)
    : (queenActive ? 10000 : 30000)
  const { data: activity, refresh: refreshActivity } = usePolling<RoomActivityEntry[]>(
    () => (isTimelineView && roomId) ? api.rooms.getActivity(roomId, 30) : Promise.resolve([]),
    activityPollMs
  )
  const { data: workers } = usePolling<Worker[]>(() => roomId ? api.workers.listForRoom(roomId) : Promise.resolve([]), 60000)
  const { data: roomGoals, refresh: refreshRoomGoals } = usePolling<Goal[]>(
    () => roomId ? api.goals.list(roomId).catch(() => []) : Promise.resolve([]),
    60000
  )
  const { data: roomResultFiles, refresh: refreshRoomResultFiles } = usePolling<RoomResultFile[]>(
    () => roomId ? api.rooms.resultFiles(roomId).catch(() => []) : Promise.resolve([]),
    60000
  )
  const { data: leaderMessages, refresh: refreshLeaderMessages } = usePolling<Escalation[]>(
    () => roomId ? api.escalations.list(roomId).catch(() => []) : Promise.resolve([]),
    leaderReplyRequest ? 2000 : 10000
  )
  const { data: leaderProcessActivity, refresh: refreshLeaderProcessActivity } = usePolling<RoomActivityEntry[]>(
    () => (roomId && (leaderReplyRequest || workbenchView === 'conversation'))
      ? api.rooms.getActivity(roomId, 40).catch(() => [])
      : Promise.resolve([]),
    leaderReplyRequest ? 2000 : 15000
  )
  useEffect(() => {
    if (!isTimelineView) return
    refreshActivity()
  }, [isTimelineView, roomId, refreshActivity])

  useEffect(() => {
    storageSet(OVERVIEW_VIEW_MODE_KEY, viewMode)
  }, [viewMode])

  function setWorkbenchView(next: WorkbenchView): void {
    setWorkbenchViewState(next)
    storageSet(WORKBENCH_VIEW_KEY, next)
  }

  const { data: revenueSummary, refresh: refreshRevenueSummary } = usePolling<RevenueSummary | null>(
    () => roomId ? api.wallet.summary(roomId).catch(() => null) : Promise.resolve(null),
    60000
  )
  const { data: networkCount, refresh: refreshNetworkCount } = usePolling<number>(
    () => roomId
      ? api.rooms.network(roomId).then(r => r.length).catch(() => 0)
      : Promise.resolve(0),
    120000
  )

  const { data: tokenUsage, refresh: refreshTokenUsage } = usePolling<{
    total: { inputTokens: number; outputTokens: number; cycles: number }
    today: { inputTokens: number; outputTokens: number; cycles: number }
  } | null>(
    () => roomId ? api.rooms.usage(roomId).catch(() => null) : Promise.resolve(null),
    60000
  )

  useEffect(() => {
    if (!roomId) return
    return wsClient.subscribe(`room:${roomId}`, (event: WsMessage) => {
      if (isTimelineView) {
        void refreshActivity()
      }
      if (ROOM_ESCALATION_EVENT_TYPES.has(event.type)) {
        void refreshLeaderMessages()
        void refreshLeaderProcessActivity()
      }
      void refreshRoomGoals()
      void refreshRoomResultFiles()
      void refreshQueenStatus()
      void refreshTokenUsage()
      if (ROOM_BALANCE_EVENT_TYPES.has(event.type)) {
        void refreshRevenueSummary()
      }
      if (ROOM_NETWORK_EVENT_TYPES.has(event.type)) {
        void refreshNetworkCount()
      }
    })
  }, [
    refreshActivity,
    refreshLeaderProcessActivity,
    refreshLeaderMessages,
    refreshNetworkCount,
    refreshQueenStatus,
    refreshRoomGoals,
    refreshRoomResultFiles,
    refreshRevenueSummary,
    refreshTokenUsage,
    isTimelineView,
    roomId,
  ])

  const [activeFilters, setActiveFilters] = useState<Set<string>>(new Set())
  const [expandedActivityId, setExpandedActivityId] = useState<number | null>(null)

  const workerMap = new Map((workers ?? []).map(w => [w.id, w]))
  const leaderId = queenStatus?.workerId ?? null
  function getWorkerName(id: number | null): string {
    if (id == null) return '用户'
    return workerMap.get(id)?.name ?? `弟子 #${id}`
  }

  useEffect(() => {
    setLeaderReplyRequest(null)
    setSelectedTaskId(null)
  }, [roomId])

  useEffect(() => {
    if (!leaderReplyRequest || !queenStatus?.workerId) return
    const replied = (leaderMessages ?? []).some(message =>
      message.id > leaderReplyRequest.escalationId &&
      message.fromAgentId === queenStatus.workerId &&
      message.toAgentId == null &&
      Date.parse(message.createdAt) >= leaderReplyRequest.sentAt - 1000
    )
    if (replied) {
      setLeaderReplyRequest(null)
      setWorkbenchNotice('帮主已回复。')
    }
  }, [leaderMessages, leaderReplyRequest, queenStatus?.workerId])

  async function sendLeaderMessage(): Promise<void> {
    if (!roomId || !leaderMessage.trim()) return
    setWorkbenchSending(true)
    setWorkbenchNotice(null)
    try {
      const created = await api.escalations.create(roomId, null, leaderMessage.trim(), queenStatus?.workerId ?? undefined, true)
      setLeaderMessage('')
      setLeaderReplyRequest({
        escalationId: created.id,
        sentAt: Date.parse(created.createdAt) || Date.now()
      })
      setWorkbenchNotice('已立即唤醒帮主，正在处理。')
      void refreshActivity()
      void refreshLeaderMessages()
      void refreshLeaderProcessActivity()
      void refreshQueenStatus()
      void refreshStatus()
    } catch (err) {
      setWorkbenchNotice(err instanceof Error ? err.message : '发送给帮主失败')
    } finally {
      setWorkbenchSending(false)
    }
  }

  async function sendTrainingMessage(): Promise<void> {
    if (!roomId || !trainingText.trim() || trainingWorkerId === '') return
    setWorkbenchSending(true)
    setWorkbenchNotice(null)
    try {
      const worker = workerMap.get(Number(trainingWorkerId))
      const prefix = worker ? `弟子训练：${worker.name}\n` : '弟子训练\n'
      await api.escalations.create(roomId, null, `${prefix}${trainingText.trim()}`, Number(trainingWorkerId), true)
      setTrainingText('')
      setWorkbenchNotice('训练指令已送达弟子，可在训练营查看吸收进度。')
      void refreshActivity()
      void refreshStatus()
    } catch (err) {
      setWorkbenchNotice(err instanceof Error ? err.message : '发送训练指令失败')
    } finally {
      setWorkbenchSending(false)
    }
  }

  if (isLoading && !data) {
    return <div ref={containerRef} className="p-4 flex-1 flex items-center justify-center text-base text-text-muted">加载中...</div>
  }
  if (!data) {
    return (
      <div ref={containerRef} className="p-4 text-sm text-status-error">
        {error ?? '加载江湖状态失败。'}
      </div>
    )
  }

  const activeTasks = data.tasks.filter((t) => t.status === 'active')
  const pausedTasks = data.tasks.filter((t) => t.status === 'paused')
  const completedTasks = data.tasks.filter((t) => t.status === 'completed')
  const projectOutputSummary = buildProjectOutputSummary({
    roomGoal: data.room?.goal,
    tasks: data.tasks,
    goals: roomGoals ?? [],
    files: roomResultFiles ?? [],
  })

  const memoryCard = advancedMode ? (
    <button key="memory" className={cardClass} onClick={() => onNavigate?.('memory')}>
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-text-secondary">藏经阁</span>
        <span className="text-sm text-text-muted">{data.entityCount} 个实体</span>
      </div>
    </button>
  ) : null

  const workersCard = (
    <button key="workers" className={cardClass} onClick={() => onNavigate?.('workers')}>
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-text-secondary">弟子</span>
        <span className="text-sm text-text-muted">{data.workerCount} 位已配置</span>
      </div>
    </button>
  )

  const tasksCard = (
    <button key="tasks" className={cardClass} onClick={() => setWorkbenchView('inspection')}>
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm font-medium text-text-secondary">任务检查</span>
        <span className="text-sm text-text-muted">{data.tasks.length} 张镖单</span>
      </div>
      <div className="flex gap-3 text-sm text-text-muted">
        <span className="text-status-success">{activeTasks.length} 张押运中</span>
        {pausedTasks.length > 0 && <span className="text-status-warning">{pausedTasks.length} 张已阻塞</span>}
        {completedTasks.length > 0 && <span className="text-interactive">{completedTasks.length} 张已交付</span>}
      </div>
    </button>
  )

  const outputsCard = (
    <button key="outputs" className={cardClass} onClick={() => setWorkbenchView('outputs')}>
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm font-medium text-text-secondary">项目成果</span>
        <span className="text-sm text-text-muted">{projectOutputSummary.primaryFiles.length} 份文件</span>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-sm text-text-muted">
        <span className="text-status-success">{projectOutputSummary.completedTaskCount} 张镖单有进展</span>
        {projectOutputSummary.missingOutputs.length > 0 && (
          <span className="text-status-warning">{projectOutputSummary.missingOutputs.length} 项待补交付</span>
        )}
      </div>
    </button>
  )

  // Show the most recent activity: queen cycle or task run, whichever is newer
  const latestActivity = (() => {
    const run = data.latestRun
    const cycle = data.latestCycle
    if (!run && !cycle) return null
    if (!run) return { type: 'cycle' as const, status: cycle!.status, startedAt: cycle!.startedAt, durationMs: cycle!.durationMs, errorMessage: cycle!.errorMessage }
    if (!cycle) return { type: 'run' as const, status: run.status, startedAt: run.startedAt, durationMs: run.durationMs, errorMessage: run.errorMessage }
    return new Date(cycle.startedAt) >= new Date(run.startedAt)
      ? { type: 'cycle' as const, status: cycle.status, startedAt: cycle.startedAt, durationMs: cycle.durationMs, errorMessage: cycle.errorMessage }
      : { type: 'run' as const, status: run.status, startedAt: run.startedAt, durationMs: run.durationMs, errorMessage: run.errorMessage }
  })()
  const latestActivityPresentation = latestActivity
    ? describeCycleActivity({
        type: latestActivity.type,
        status: latestActivity.status,
        errorMessage: latestActivity.errorMessage,
      })
    : null

  const lastRunCard = (
    <button key="lastrun" className={cardClass} onClick={() => onNavigate?.('tasks')}>
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm font-medium text-text-secondary">最近动向</span>
        {latestActivity && (
          <span className="text-xs text-text-muted">{latestActivity.type === 'cycle' ? '巡行' : '镖单'}</span>
        )}
      </div>
      {latestActivity && latestActivityPresentation ? (
        <div className="text-sm text-text-muted">
          <span className={activityToneClass(latestActivityPresentation.tone)}>
            {latestActivityPresentation.label}
          </span>
          {' — '}
          {formatRelativeTime(latestActivity.startedAt)}
          {latestActivity.durationMs != null && (
            <span className="text-text-muted"> ({(latestActivity.durationMs / 1000).toFixed(1)}秒)</span>
          )}
          {latestActivityPresentation.reason && (
            <div className="mt-1 text-xs text-text-muted line-clamp-2">
              {latestActivityPresentation.reason}
            </div>
          )}
        </div>
      ) : (
        <span className="text-sm text-text-muted">暂无江湖动向</span>
      )}
    </button>
  )

  const walletCard = roomId ? (
    <button key="wallet" className={cardClass} onClick={() => onNavigate?.('transactions')}>
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm font-medium text-text-secondary">钱庄 / 流水</span>
        <span className="text-sm text-text-muted">流水入口</span>
      </div>
      {revenueSummary && (
        <div className="flex gap-3 text-sm mt-1">
          <span className="text-status-success">入账 {revenueSummary.totalIncome.toFixed(2)} 财气</span>
          <span className="text-status-error">支出 {revenueSummary.totalExpenses.toFixed(2)} 财气</span>
          <span className={revenueSummary.netProfit >= 0 ? 'text-interactive' : 'text-status-warning'}>
            余额 {revenueSummary.netProfit.toFixed(2)} 财气
          </span>
        </div>
      )}
    </button>
  ) : null

  const networkCard = (networkCount ?? 0) > 0 ? (
    <button key="network" className={cardClass} onClick={() => onNavigate?.('swarm')}>
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-text-secondary">江湖协作</span>
        <span className="text-sm text-text-muted">{networkCount} 个关联帮派</span>
      </div>
    </button>
  ) : null

  const AGENT_STATE_LABELS: Record<string, { label: string; color: string }> = {
    thinking: { label: '思考中', color: 'text-interactive' },
    acting: { label: '执行中', color: 'text-status-warning' },
    idle: { label: '空闲', color: 'text-text-muted' },
    rate_limited: { label: '限速中', color: 'text-status-error' },
  }

  const queenCard = roomId && queenStatus ? (
    <button key="queen" className={cardClass} onClick={() => onNavigate?.('room-settings')}>
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm font-medium text-text-secondary">帮主</span>
        <span className={`text-sm ${queenRunning ? 'text-status-success' : 'text-text-muted'}`}>
          {queenRunning ? '运行中' : '已停止'}
        </span>
      </div>
      {queenRunning && (
        <div className="text-sm">
          <span className={AGENT_STATE_LABELS[queenStatus.agentState]?.color ?? 'text-text-muted'}>
            {AGENT_STATE_LABELS[queenStatus.agentState]?.label ?? queenStatus.agentState}
          </span>
        </div>
      )}
    </button>
  ) : null

  const runningSection =
    data.runningRuns.length > 0 ? (
      <div className="p-3 bg-interactive-bg rounded-lg shadow-sm">
        <div className="text-sm font-medium text-interactive mb-1">押运中 ({data.runningRuns.length})</div>
        {data.runningRuns.map((run) => (
          <div key={run.id} className="mb-1 last:mb-0">
            <div className="flex items-center gap-2">
              <div className="flex-1 h-1.5 bg-interactive-bg rounded-full overflow-hidden">
                {run.progress != null ? (
                  <div className="h-full bg-interactive rounded-full transition-all duration-500" style={{ width: `${Math.round(run.progress * 100)}%` }} />
                ) : (
                  <div className="h-full bg-interactive rounded-full animate-pulse w-full" />
                )}
              </div>
            </div>
            {run.progressMessage && <div className="text-sm text-interactive mt-0.5 truncate">{run.progressMessage}</div>}
          </div>
        ))}
      </div>
    ) : null

  const consoleSection = <LiveConsoleSection isActive={viewMode === 'console' && !!roomId} tasks={data.tasks} roomId={roomId} workers={workers ?? []} queenWorkerId={queenStatus?.workerId ?? null} />

  const errorAlert = error ? (
    <div className="px-3 py-2 text-sm text-status-warning bg-status-warning-bg rounded-lg">刷新数据时遇到临时问题：{error}</div>
  ) : null

  // Activity timeline
  const allActivity = [...(activity ?? [])].filter(shouldShowActivityEntry).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  )
  const presentTypes = [...new Set(allActivity.map(a => a.eventType))]
  const isFiltering = activeFilters.size > 0
  const filteredActivity = !isFiltering
    ? allActivity
    : allActivity.filter(a => activeFilters.has(a.eventType))

  function toggleFilter(eventType: string): void {
    setActiveFilters(prev => {
      const next = new Set(prev)
      if (next.has(eventType)) {
        next.delete(eventType)
      } else {
        next.add(eventType)
      }
      return next
    })
  }

  function clearFilters(): void {
    setActiveFilters(new Set())
  }

  const activitySection = roomId ? (
    <div className="bg-surface-secondary rounded-lg p-4 shadow-sm flex-1 flex flex-col min-h-0 overflow-x-hidden">
      {/* Filter bar */}
      {presentTypes.length > 1 && (
        <div className="mb-3 shrink-0 border-b border-border-primary pb-3">
          <div className="flex items-center justify-between gap-2 mb-2">
            <div className="text-xs font-semibold text-text-muted">筛选</div>
            {isFiltering && (
              <button
                onClick={clearFilters}
                className="text-xs px-2 py-1 rounded-lg border border-border-primary text-text-muted hover:text-text-secondary hover:bg-surface-hover transition-colors"
              >
                清除
              </button>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5">
            <button
              onClick={clearFilters}
              className={`px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                !isFiltering
                  ? 'bg-interactive-bg text-interactive border-interactive/30'
                  : 'bg-surface-primary text-text-muted border-border-primary hover:bg-surface-hover hover:text-text-secondary'
              }`}
            >
              全部
            </button>
          {presentTypes.map(type => (
            <button
              key={type}
              onClick={() => toggleFilter(type)}
              className={`px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                activeFilters.has(type)
                  ? `${EVENT_TYPE_COLORS[type] ?? 'bg-surface-tertiary text-text-secondary'} border-transparent`
                  : 'bg-surface-primary text-text-muted border-border-primary hover:bg-surface-hover hover:text-text-secondary'
              }`}
            >
              {EVENT_TYPE_LABELS[type] ?? type}
            </button>
          ))}
          </div>
        </div>
      )}

      {/* Timeline */}
      {filteredActivity.length === 0 ? (
        <div className="text-sm text-text-muted">
          {allActivity.length === 0 ? '暂无江湖动向。' : '没有匹配的事件。'}
        </div>
      ) : (
        <div className="space-y-2 flex-1 overflow-y-auto overflow-x-hidden">
          {filteredActivity.map(entry => {
            const item = formatCommunicationEntry(entry, workerMap, leaderId)
            return (
              <div
                key={entry.id}
                className="cursor-pointer hover:bg-surface-primary rounded-lg px-2.5 py-1.5 transition-colors"
                onClick={() => setExpandedActivityId(expandedActivityId === entry.id ? null : entry.id)}
              >
                <div className="flex items-center gap-1.5">
                  <span className={`px-2.5 py-1.5 rounded-lg text-xs font-medium shrink-0 ${EVENT_TYPE_COLORS[entry.eventType] ?? 'bg-surface-tertiary text-text-muted'}`}>
                    {EVENT_TYPE_LABELS[entry.eventType] ?? entry.eventType}
                  </span>
                  <span className="text-sm text-text-secondary truncate flex-1">
                    {item.actor} · {item.action} · {item.result}
                  </span>
                  <span className="text-xs text-text-muted shrink-0">{formatRelativeTime(entry.createdAt)}</span>
                </div>
                {expandedActivityId === entry.id && (
                  <div className="mt-1 ml-1 space-y-0.5">
                    {entry.actorId && (
                      <div className="text-xs text-text-muted">
                        来自 {workerMap.get(entry.actorId)?.name ?? `弟子 #${entry.actorId}`}
                      </div>
                    )}
                    {entry.details && (
                      <div className="text-xs text-text-muted whitespace-pre-wrap break-words">{entry.details}</div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  ) : null

  const showToggle = !!roomId
  const activeView = showToggle ? viewMode : 'console'

  const toggleBar = showToggle ? (
    <div className="inline-flex gap-1 bg-interactive-bg rounded-lg p-0.5 self-start shrink-0">
      <button
        onClick={() => setViewMode('activity')}
        className={`px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${
          activeView === 'activity'
            ? 'bg-interactive text-text-invert shadow-sm'
            : 'bg-interactive-bg text-interactive hover:bg-interactive hover:text-text-invert'
        }`}
      >
        动向
      </button>
      <button
        onClick={() => setViewMode('console')}
        className={`px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${
          activeView === 'console'
            ? 'bg-interactive text-text-invert shadow-sm'
            : 'bg-interactive-bg text-interactive hover:bg-interactive hover:text-text-invert'
        }`}
      >
        驾驶舱
      </button>
    </div>
  ) : null

  const header = (
    <div className="flex items-center justify-between gap-2 flex-wrap">
      <div>
        <h2 className="text-base font-semibold text-text-primary">帮主管理处</h2>
        <div className="mt-0.5 text-xs text-text-muted">帮主在这里对话、管理委托目标、查验任务、训练弟子，并维护协作流程和项目进度。</div>
      </div>
    </div>
  )

  function renderLogSection(): React.JSX.Element {
    const content = activeView === 'activity'
      ? (activitySection ?? consoleSection)
      : consoleSection

    if (!showToggle || !toggleBar) return content

    return (
      <div className="space-y-2">
        {toggleBar}
        {content}
      </div>
    )
  }

  const usage = tokenUsage ?? { total: { inputTokens: 0, outputTokens: 0, cycles: 0 }, today: { inputTokens: 0, outputTokens: 0, cycles: 0 }, isApiModel: false }
  const hasTokenData = usage.total.inputTokens > 0 || usage.total.outputTokens > 0
  const usageCard = (
    <div key="usage" className={cardClass}>
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm font-medium text-text-secondary">元气用量</span>
        <span className="text-sm text-text-muted">{usage.isApiModel ? 'API' : '订阅'}</span>
      </div>
      {!usage.isApiModel && !hasTokenData ? (
        <div className="text-sm text-text-muted">由模型提供方统计</div>
      ) : (
        <>
          {usage.today.inputTokens > 0 || usage.today.outputTokens > 0 ? (
            <div className="text-sm text-text-muted mb-0.5">
              <span className="text-text-secondary">今日：</span>{' '}
              <span className="text-interactive">{formatTokens(usage.today.inputTokens)}</span> 输入{' / '}
              <span className="text-interactive">{formatTokens(usage.today.outputTokens)}</span> 输出
            </div>
          ) : null}
          <div className="text-sm text-text-muted">
            {formatTokens(usage.total.inputTokens)} 输入{' / '}
            {formatTokens(usage.total.outputTokens)} 输出
            <span className="text-text-muted ml-1">（{usage.total.cycles} 次循环）</span>
          </div>
        </>
      )}
    </div>
  )

  const gangPhase = inferGangPhase(data.room, data.tasks, data.runningRuns, data.workerCount, queenRunning)
  const budgetUsed = budgetPercent(data.tasks, tokenUsage)
  const sortedTasks = [...data.tasks].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
  const runningByTaskId = new Map<number, TaskRun>()
  for (const run of data.runningRuns) {
    if (!runningByTaskId.has(run.taskId)) runningByTaskId.set(run.taskId, run)
  }
  const taskByWorkerId = new Map<number, Task>()
  for (const task of sortedTasks) {
    if (task.workerId !== null && !taskByWorkerId.has(task.workerId)) {
      taskByWorkerId.set(task.workerId, task)
    }
  }
  const finishedTasks = sortedTasks.filter(task => task.status === 'completed').length
  const blockedTasks = sortedTasks.filter(task => task.status === 'paused' || task.status === 'error').length
  const estimateMinutes = Math.max(2, Math.round((100 - gangPhase.progress) / 12))
  const communicationItems = (activity ?? []).filter(shouldShowActivityEntry).slice(0, 6)
  const selectedTask = sortedTasks.find(task => task.id === selectedTaskId) ?? null
  const selectedTaskIndex = selectedTask ? sortedTasks.findIndex(task => task.id === selectedTask.id) : -1
  const selectedTaskRun = selectedTask ? runningByTaskId.get(selectedTask.id) : undefined
  const selectedTaskWorker = selectedTask?.workerId != null ? workerMap.get(selectedTask.workerId) ?? null : null
  const selectedTaskFlow = selectedTask ? parseTaskFlowSpec(selectedTask) : null

  const battleRoomSection = roomId ? (
    <div className="space-y-3">
      <section className="bg-surface-secondary rounded-lg p-4 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs font-semibold text-text-muted">任务追踪页</div>
            <h2 className="mt-1 text-lg font-semibold text-text-primary truncate">
              任务：{data.room?.goal || data.room?.name || '等待天机处接收委托'}
            </h2>
            <div className="mt-2 text-sm text-text-muted">
              天机处正在协调 · 预计还需 {estimateMinutes} 分钟
            </div>
          </div>
          <span className={`px-2.5 py-1.5 rounded-lg text-sm font-medium ${PHASE_COLORS[gangPhase.phase]}`}>
            {gangPhase.phase}
          </span>
        </div>
        <div className="mt-4 flex items-center gap-3">
          <div className="flex-1 h-2 rounded-full bg-surface-tertiary overflow-hidden">
            <div
              className="h-full rounded-full bg-interactive transition-[width] duration-500"
              style={{ width: `${gangPhase.progress}%` }}
            />
          </div>
          <span className="text-sm font-medium text-text-secondary">{gangPhase.progress}%</span>
        </div>
        <div className="mt-2 text-xs text-text-muted">{gangPhase.note}</div>
      </section>

      <section className="bg-surface-secondary rounded-lg shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b border-border-primary flex flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-base font-semibold text-text-primary truncate">{data.room?.name ?? '临时帮派'} 作战室</div>
            <div className="text-xs text-text-muted">
              帮主：{queenStatus?.name ?? '天机处待任命'} · 弟子 {data.workerCount} 名 · 镖单 {sortedTasks.length} 张
            </div>
          </div>
          <span className="text-xs text-text-muted">已用预算 {budgetUsed}%</span>
        </div>

        <div className={wide ? 'grid grid-cols-[260px_1fr] min-h-[360px]' : 'space-y-3 p-3'}>
          <aside className={wide ? 'border-r border-border-primary p-3' : 'rounded-lg bg-surface-primary p-3'}>
            <div className="text-sm font-semibold text-text-secondary mb-2">任务树</div>
            {sortedTasks.length === 0 ? (
              <div className="text-sm text-text-muted">暂无子任务。天机处会先拆解目标，再成立可执行镖单。</div>
            ) : (
              <div className="space-y-2">
                {sortedTasks.map((task, index) => {
                  const run = runningByTaskId.get(task.id)
                  const isSelected = selectedTaskId === task.id
                  return (
                    <button
                      key={task.id}
                      type="button"
                      aria-pressed={isSelected}
                      onClick={() => setSelectedTaskId(task.id)}
                      className={`w-full rounded-lg border px-3 py-2 text-left transition-colors focus:outline-none focus:ring-2 focus:ring-interactive/50 ${
                        isSelected
                          ? 'border-interactive bg-interactive-bg/30'
                          : 'border-border-primary bg-surface-primary hover:border-interactive/60 hover:bg-surface-hover'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-sm font-medium text-text-primary truncate">{index + 1}. {taskShortName(task)}</div>
                        <span className="text-xs text-text-muted shrink-0">{statusText(run?.status ?? task.status)}</span>
                      </div>
                      <div className="mt-1 text-xs text-text-muted line-clamp-2">{taskBrief(task)}</div>
                    </button>
                  )
                })}
              </div>
            )}
          </aside>

          <div className={wide ? 'p-3' : ''}>
            <div className="mb-3 rounded-lg border border-border-primary bg-surface-primary p-3">
              {selectedTask && selectedTaskFlow ? (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-text-muted">镖单详情</div>
                      <div className="mt-1 text-base font-semibold text-text-primary break-words">
                        工序 {selectedTaskIndex + 1}：{selectedTask.name}
                      </div>
                      <div className="mt-1 text-xs text-text-muted">
                        {selectedTaskWorker?.name ?? '未分派弟子'} · 创建于 {new Date(selectedTask.createdAt).toLocaleString()}
                      </div>
                    </div>
                    <span className={`rounded-lg px-2.5 py-1.5 text-xs ${
                      selectedTask.status === 'completed'
                        ? 'bg-status-success-bg text-status-success'
                        : selectedTask.status === 'paused' || selectedTask.status === 'error'
                          ? 'bg-status-warning-bg text-status-warning'
                          : 'bg-interactive-bg text-interactive'
                    }`}>
                      {statusText(selectedTaskRun?.status ?? selectedTask.status)}
                    </span>
                  </div>

                  <div className="grid gap-2 md:grid-cols-3">
                    <div className="rounded-lg bg-surface-secondary px-3 py-2">
                      <div className="text-xs text-text-muted">上游输入</div>
                      <div className="mt-1 text-sm text-text-secondary break-words">
                        {taskDetailText(selectedTaskFlow.upstream, '未写明，上游需要帮主补齐')}
                      </div>
                    </div>
                    <div className="rounded-lg bg-surface-secondary px-3 py-2">
                      <div className="text-xs text-text-muted">下游接收</div>
                      <div className="mt-1 text-sm text-text-secondary break-words">
                        {taskDetailText(selectedTaskFlow.downstream, '未写明，完成后交给帮主验收')}
                      </div>
                    </div>
                    <div className="rounded-lg bg-surface-secondary px-3 py-2">
                      <div className="text-xs text-text-muted">输出格式</div>
                      <div className="mt-1 text-sm text-text-secondary break-words">
                        {taskDetailText(selectedTaskFlow.outputFormat, '未写明，需要补充格式限制')}
                      </div>
                    </div>
                  </div>

                  <div className="rounded-lg bg-surface-secondary px-3 py-2">
                    <div className="text-xs text-text-muted">当前进展</div>
                    <div className="mt-1 text-sm leading-6 text-text-secondary break-words">
                      {taskDetailText(
                        selectedTaskRun?.progressMessage || selectedTask.lastResult,
                        selectedTask.status === 'completed' ? '已完成，等待帮主验收沉淀。' : '尚未形成可读进展。'
                      )}
                    </div>
                    {selectedTaskRun?.progress != null && (
                      <div className="mt-2 flex items-center gap-2">
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-tertiary">
                          <div className="h-full rounded-full bg-interactive" style={{ width: `${Math.round(selectedTaskRun.progress * 100)}%` }} />
                        </div>
                        <span className="text-xs text-text-muted">{Math.round(selectedTaskRun.progress * 100)}%</span>
                      </div>
                    )}
                  </div>

                  <details className="rounded-lg border border-border-primary bg-surface-secondary/60 px-3 py-2 text-sm text-text-muted">
                    <summary className="cursor-pointer select-none text-text-secondary">查看原始要求和最近结果</summary>
                    <div className="mt-3 space-y-3">
                      <div>
                        <div className="text-xs font-semibold text-text-secondary">原始要求</div>
                        <div className="mt-1 whitespace-pre-wrap break-words leading-6">
                          {taskLongText(selectedTask.prompt, '没有记录原始要求。')}
                        </div>
                      </div>
                      <div>
                        <div className="text-xs font-semibold text-text-secondary">最近结果</div>
                        <div className="mt-1 whitespace-pre-wrap break-words leading-6">
                          {taskLongText(selectedTask.lastResult || selectedTaskRun?.result || selectedTaskRun?.errorMessage, '还没有可展示结果。')}
                        </div>
                      </div>
                    </div>
                  </details>
                </div>
              ) : (
                <div className="text-sm text-text-muted">
                  点击左侧任务树里的镖单，查看它的上下游、输出格式、分派弟子、当前进展和最近结果。
                </div>
              )}
            </div>

            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-sm font-semibold text-text-secondary">弟子作战板</div>
                <div className="text-xs text-text-muted">每位弟子对应一个子任务，状态独立流转。</div>
              </div>
              <div className="flex gap-2 text-xs">
                <span className="text-status-success">完成 {finishedTasks}</span>
                {blockedTasks > 0 && <span className="text-status-warning">阻塞 {blockedTasks}</span>}
              </div>
            </div>
            {(workers ?? []).length === 0 ? (
              <div className="rounded-lg border border-dashed border-border-primary bg-surface-primary p-6 text-center text-sm text-text-muted">
                客栈尚未派入弟子。帮主需要先挑选弟子，再从藏经阁配置功法。
              </div>
            ) : (
              <div className={wide ? 'grid grid-cols-2 gap-3' : 'space-y-3'}>
                {(workers ?? []).map(worker => {
                  const task = taskByWorkerId.get(worker.id)
                  const run = task ? runningByTaskId.get(task.id) : undefined
                  const progress = discipleProgress(task, run, worker)
                  return (
                    <details key={worker.id} className="rounded-lg border border-border-primary bg-surface-primary p-3">
                      <summary className="cursor-pointer list-none">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="text-sm font-semibold text-text-primary truncate">{worker.name}</div>
                            <div className="text-xs text-text-muted truncate">{worker.role || '通用弟子'} · {task ? taskShortName(task) : '待命'}</div>
                          </div>
                          <span className="px-2 py-1 rounded-lg bg-surface-tertiary text-xs text-text-secondary shrink-0">
                            {task ? statusText(task.status) : workerStateLabel(worker.agentState)}
                          </span>
                        </div>
                        <div className="mt-3 flex items-center gap-2">
                          <div className="flex-1 h-1.5 rounded-full bg-surface-tertiary overflow-hidden">
                            <div className="h-full rounded-full bg-interactive" style={{ width: `${progress}%` }} />
                          </div>
                          <span className="text-xs text-text-muted">{progress}%</span>
                        </div>
                      </summary>
                      <div className="mt-3 pt-3 border-t border-border-primary space-y-1 text-xs text-text-muted">
                        <div><span className="text-text-secondary">当前步骤：</span>{run?.progressMessage || taskBrief(task ?? ({ prompt: worker.wip || '等待帮主分派任务', name: '待命', description: null } as Task))}</div>
                        <div><span className="text-text-secondary">已消耗：</span>银两 x{Math.max(0, task?.runCount ?? 0) * 3} · 铜钱 x{Math.max(20, progress * 7)}</div>
                        <div><span className="text-text-secondary">输入来源：</span>{task ? '上游镖单或用户委托' : '等待任务需求单'}</div>
                        <div><span className="text-text-secondary">输出目标：</span>{task ? '可被下游弟子校验和复用的结构化结果' : '待帮主确认'}</div>
                        {task?.lastResult && (
                          <div className="pt-1 whitespace-pre-wrap break-words">
                            <span className="text-text-secondary">最近输出：</span>{task.lastResult.slice(0, 160)}
                          </div>
                        )}
                      </div>
                    </details>
                  )
                })}
              </div>
            )}
          </div>
        </div>

        <div className="border-t border-border-primary p-3 grid gap-3 lg:grid-cols-[1fr_300px]">
          <div className="rounded-lg bg-surface-primary p-3">
            <div className="text-sm font-semibold text-text-secondary mb-2">通讯日志</div>
            {communicationItems.length === 0 ? (
              <div className="text-sm text-text-muted">暂无传书。任务推进后会记录弟子输出传递、帮主调整和钱庄预警。</div>
            ) : (
              <div className="space-y-2">
                {communicationItems.map(entry => {
                  const item = formatCommunicationEntry(entry, workerMap, leaderId)
                  const toneClass = item.tone === 'success'
                    ? 'border-status-success/30 bg-status-success-bg/30'
                    : item.tone === 'warning'
                      ? 'border-status-warning/30 bg-status-warning-bg/30'
                      : item.tone === 'error'
                        ? 'border-status-error/30 bg-status-error-bg/30'
                        : 'border-border-primary bg-surface-secondary/40'
                  return (
                    <div key={entry.id} className={`rounded-lg border px-2.5 py-2 ${toneClass}`}>
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                        <span className="text-text-muted">{new Date(entry.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                        <span className="font-semibold text-text-primary">{item.actor}</span>
                        <span className="text-text-secondary">{item.action}</span>
                      </div>
                      <div className="mt-1 text-sm leading-5 text-text-muted break-words">{item.result}</div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
          <div className="rounded-lg bg-surface-primary p-3">
            <div className="text-sm font-semibold text-text-secondary mb-2">资源账本</div>
            <div className="space-y-2 text-sm text-text-muted">
              <div className="flex justify-between"><span>铜钱</span><span>{Math.round(budgetUsed * 8)} / 1000</span></div>
              <div className="flex justify-between"><span>银两</span><span>{Math.round(budgetUsed / 6)} / 20</span></div>
              <div className="flex justify-between"><span>金票</span><span>{budgetUsed > 70 ? 1 : 0} / 3</span></div>
              <div className="pt-2 border-t border-border-primary text-xs">
                预算只在同类资源内调配，剩余额度在帮派解散后返还钱庄。
              </div>
            </div>
          </div>
        </div>
      </section>

    </div>
  ) : null

  const workbenchTabGroups: Array<{ stage: string; tabs: Array<{ id: WorkbenchView; label: string }> }> = [
    {
      stage: '总览',
      tabs: [
        { id: 'overview', label: '管理总览' },
        { id: 'conversation', label: '帮主对话' },
      ],
    },
    {
      stage: '筹备',
      tabs: [
        { id: 'goals', label: '委托目标' },
        { id: 'flow', label: '协作流程' },
        { id: 'training', label: '弟子培训' },
      ],
    },
    {
      stage: '执行',
      tabs: [
        { id: 'gantt', label: '项目甘特' },
        { id: 'inspection', label: '任务检查' },
      ],
    },
    {
      stage: '交付',
      tabs: [
        { id: 'outputs', label: '项目成果' },
      ],
    },
  ]

  const workbenchTabBar = (
    <div className="rounded-lg border border-border-primary bg-surface-secondary p-1 overflow-x-auto">
      <div className="flex min-w-max items-center gap-2">
        {workbenchTabGroups.map((group, groupIndex) => (
          <div key={group.stage} className="flex items-center gap-1">
            {groupIndex > 0 && <span className="mx-1 h-6 w-px bg-border-primary" />}
            <span className="px-2 text-[11px] font-medium text-text-muted">{group.stage}</span>
            {group.tabs.map(item => (
              <button
                key={item.id}
                type="button"
                onClick={() => setWorkbenchView(item.id)}
                className={`rounded-lg px-3 py-2 text-sm transition-colors ${
                  workbenchView === item.id
                    ? 'bg-interactive text-text-invert shadow-sm'
                    : 'text-text-muted hover:bg-surface-hover hover:text-text-secondary'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  )

  const workbenchNoticeNode = workbenchNotice ? (
    <div className="rounded-lg border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-muted">
      {workbenchNotice}
    </div>
  ) : null

  const leaderConversationItems = (leaderMessages ?? [])
    .filter(message => {
      if (leaderId == null) return message.fromAgentId == null || message.toAgentId == null
      return (message.fromAgentId == null && (message.toAgentId === leaderId || message.toAgentId == null))
        || (message.fromAgentId === leaderId && message.toAgentId == null)
    })
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id - a.id)
    .slice(0, 30)
  const leaderIsThinking = workbenchSending || leaderReplyRequest !== null
  const leaderName = queenStatus?.name ?? '帮主'
  const visibleProcessActivity = (leaderProcessActivity ?? [])
    .filter(shouldShowActivityEntry)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))

  function processLinesBetween(startAt: number, endAt?: number): string[] {
    const lines = visibleProcessActivity
      .filter(entry => {
        const at = Date.parse(entry.createdAt)
        return at >= startAt - 1000 && (endAt == null || at <= endAt + 1000)
      })
      .map(entry => formatProcessLine(entry, workerMap, leaderId))
      .filter(line => !containsInternalNoise(line))

    return [...new Set(lines)].slice(-5)
  }

  function previousUserMessageBefore(message: Escalation): Escalation | null {
    const messageTime = Date.parse(message.createdAt)
    return [...leaderConversationItems]
      .filter(item => item.fromAgentId == null && item.id < message.id && Date.parse(item.createdAt) <= messageTime)
      .sort((a, b) => b.id - a.id)[0] ?? null
  }

  function completedProcessLines(message: Escalation): string[] {
    const request = previousUserMessageBefore(message)
    const startAt = request ? Date.parse(request.createdAt) : Date.parse(message.createdAt) - 15 * 60 * 1000
    const endAt = Date.parse(message.createdAt)
    const lines = processLinesBetween(startAt, endAt)
    return [
      request ? `收到你的指令：${clipLogText(request.question, 70)}` : '收到你的指令。',
      ...(lines.length > 0 ? lines : [`${leaderName} 已检查现状并整理回复。`]),
      '处理完成，结果已回到当前对话。'
    ]
  }

  const pendingRequestMessage = leaderReplyRequest
    ? leaderConversationItems.find(message => message.id === leaderReplyRequest.escalationId) ?? null
    : null
  const pendingProcessLines = leaderReplyRequest ? [
    pendingRequestMessage
      ? `收到你的指令：${clipLogText(pendingRequestMessage.question, 70)}`
      : '收到你的指令。',
    `已立即唤醒 ${leaderName}，正在读取帮派现状。`,
    ...processLinesBetween(leaderReplyRequest.sentAt),
    '正在整理可执行结果，完成后会把过程折叠，只保留结论在外面。'
  ] : []

  const conversationSection = roomId ? (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border-primary bg-surface-secondary shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border-primary px-4 py-3">
        <div className="min-w-0">
          <div className="text-base font-semibold text-text-primary">帮主对话</div>
          <div className="mt-0.5 text-xs text-text-muted truncate">
            {leaderName} · {queenRunning ? '在线' : '待唤醒'}
          </div>
        </div>
        <button
          type="button"
          onClick={() => onNavigate?.('messages')}
          className="rounded-lg border border-border-primary px-3 py-2 text-sm text-text-secondary hover:bg-surface-hover"
        >
          飞鸽传书
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto bg-surface-primary/40 p-4">
        {leaderIsThinking && (
          <div className="flex items-start gap-2">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-tertiary text-sm font-semibold text-text-secondary">
              帮
            </div>
            <div className="max-w-[82%]">
              <div className="mb-1 text-xs text-text-muted">{leaderName} · 正在处理</div>
              <div className="rounded-2xl rounded-tl-md border border-border-primary bg-surface-primary px-3 py-2 shadow-sm">
                <div className="flex items-center gap-2 text-xs text-text-muted">
                  <span>正在读帮派现状</span>
                  <span className="flex items-center gap-1">
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-interactive [animation-delay:-0.2s]" />
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-interactive [animation-delay:-0.1s]" />
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-interactive" />
                  </span>
                </div>
                <div className="mt-3 space-y-2">
                  {pendingProcessLines.map((line, index) => (
                    <div key={`pending-process-${index}`} className="flex gap-2 text-sm text-text-secondary">
                      <span className={`mt-2 h-1.5 w-1.5 shrink-0 rounded-full ${
                        index === pendingProcessLines.length - 1 ? 'animate-pulse bg-interactive' : 'bg-status-success'
                      }`} />
                      <span className="whitespace-pre-wrap leading-6">{line}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
        {leaderConversationItems.length === 0 && !leaderIsThinking ? (
          <div className="rounded-lg border border-dashed border-border-primary bg-surface-primary p-6 text-center text-sm text-text-muted">
            暂无对话。你可以直接向帮主交代检查、调整、训练或汇总要求。
          </div>
        ) : leaderConversationItems.map(message => {
          const fromLeader = leaderId != null && message.fromAgentId === leaderId
          const fromUser = message.fromAgentId == null
          const speakerName = fromUser ? '你' : fromLeader ? leaderName : getWorkerName(message.fromAgentId)
          return (
            <div key={message.id} className={`flex items-start gap-2 ${fromUser ? 'flex-row-reverse' : ''}`}>
              <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-sm font-semibold ${
                fromUser
                  ? 'bg-interactive text-text-invert'
                  : fromLeader
                    ? 'bg-surface-tertiary text-text-secondary'
                    : 'bg-status-info-bg text-status-info'
              }`}>
                {fromUser ? '我' : fromLeader ? '帮' : '弟'}
              </div>
              <div className={`max-w-[82%] ${fromUser ? 'text-right' : 'text-left'}`}>
                <div className={`mb-1 text-xs ${fromUser ? 'text-text-muted' : 'text-text-muted'}`}>
                  {speakerName}
                  <span className="ml-2">{formatRelativeTime(message.createdAt)}</span>
                </div>
                <div className={`rounded-2xl px-3 py-2 text-left shadow-sm ${
                  fromUser
                    ? 'rounded-tr-md bg-interactive text-text-invert'
                    : fromLeader
                      ? 'rounded-tl-md border border-border-primary bg-surface-primary text-text-primary'
                      : 'rounded-tl-md border border-border-primary bg-surface-tertiary text-text-secondary'
                }`}>
                  {fromLeader ? (
                    <>
                      <div className="whitespace-pre-wrap break-words text-sm leading-6">{formatLeaderResult(message.question)}</div>
                      <details className="mt-3 rounded-lg border border-border-primary bg-surface-secondary/60 px-3 py-2 text-xs text-text-muted">
                        <summary className="cursor-pointer select-none text-text-secondary">处理过程</summary>
                        <div className="mt-2 space-y-2">
                          {completedProcessLines(message).map((line, index) => (
                            <div key={`${message.id}-process-${index}`} className="flex gap-2">
                              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-interactive" />
                              <span className="whitespace-pre-wrap leading-5">{line}</span>
                            </div>
                          ))}
                        </div>
                      </details>
                    </>
                  ) : (
                    <div className="whitespace-pre-wrap break-words text-sm leading-6">{message.question}</div>
                  )}
                  {message.answer && (
                    <div className="mt-2 rounded-lg bg-surface-secondary px-2 py-1.5 text-sm text-text-secondary">
                      {message.answer}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      <div className="shrink-0 border-t border-border-primary bg-surface-secondary p-3">
        <div className="flex items-end gap-2">
          <textarea
            value={leaderMessage}
            onChange={(event) => setLeaderMessage(event.target.value)}
            className="max-h-36 min-h-12 flex-1 resize-y rounded-lg border border-border-primary bg-surface-primary px-3 py-2 text-sm text-text-primary outline-none focus:border-interactive"
            placeholder="给帮主发送消息..."
          />
          <button
            type="button"
            onClick={() => { void sendLeaderMessage() }}
            disabled={!leaderMessage.trim() || workbenchSending}
            className="rounded-lg bg-interactive px-4 py-2.5 text-sm text-text-invert disabled:opacity-50"
          >
            {workbenchSending ? '送达中' : '发送'}
          </button>
        </div>
      </div>
    </section>
  ) : (
    <div className="rounded-lg border border-border-primary bg-surface-secondary p-4 text-sm text-text-muted">
      先选择一个帮派，帮主对话会出现在这里。
    </div>
  )

  const goalsSection = roomId ? (
    <section className="min-h-[620px] overflow-hidden rounded-lg border border-border-primary bg-surface-secondary shadow-sm">
      <GoalsPanel roomId={roomId} autonomyMode="semi" />
    </section>
  ) : (
    <div className="rounded-lg border border-border-primary bg-surface-secondary p-4 text-sm text-text-muted">
      先选择一个帮派，委托目标会出现在帮主管理处里。
    </div>
  )

  const outputsSection = roomId ? (
    <section className="rounded-lg border border-border-primary bg-surface-secondary p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-base font-semibold text-text-primary">项目成果</div>
          <div className="mt-1 max-w-4xl text-sm leading-6 text-text-muted">
            {projectOutputSummary.projectObjective}
          </div>
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          <span className="rounded-lg bg-status-success-bg px-2.5 py-1 text-status-success">
            目标 {projectOutputSummary.completedGoalCount}/{projectOutputSummary.totalGoalCount}
          </span>
          <span className="rounded-lg bg-interactive-bg px-2.5 py-1 text-interactive">
            镖单 {projectOutputSummary.completedTaskCount}/{projectOutputSummary.totalTaskCount}
          </span>
          <span className="rounded-lg bg-surface-tertiary px-2.5 py-1 text-text-secondary">
            成果 {projectOutputSummary.primaryFiles.length}
          </span>
        </div>
      </div>

      <div className="mt-4 grid gap-3 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)]">
        <div className="rounded-lg border border-border-primary bg-surface-primary p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-semibold text-text-secondary">主要成果文件</div>
            <button
              type="button"
              onClick={() => { void refreshRoomResultFiles() }}
              className="rounded-lg border border-border-primary px-2.5 py-1 text-xs text-text-muted hover:bg-surface-hover"
            >
              刷新
            </button>
          </div>
          {projectOutputSummary.primaryFiles.length === 0 ? (
            <div className="mt-3 rounded-lg border border-dashed border-border-primary p-5 text-center text-sm text-text-muted">
              暂无可展示成果。帮主需要把报告、索引或验收记录写入帮派成果区。
            </div>
          ) : (
            <div className="mt-3 grid gap-3 lg:grid-cols-2">
              {projectOutputSummary.primaryFiles.map(file => (
                <details key={file.path} className="rounded-lg border border-border-primary bg-surface-secondary p-3">
                  <summary className="cursor-pointer list-none">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-text-primary">{file.title}</div>
                        <div className="mt-1 text-xs text-text-muted">
                          帮派成果区 · {formatFileSize(file.size)} · {formatRelativeTime(file.updatedAt)}
                        </div>
                      </div>
                      <span className="shrink-0 rounded-lg bg-interactive-bg px-2 py-1 text-xs text-interactive">查看</span>
                    </div>
                  </summary>
                  <div className="mt-3 max-h-72 overflow-auto rounded-lg bg-surface-primary p-3 text-sm leading-6 text-text-secondary">
                    {file.preview ? (
                      <pre className="whitespace-pre-wrap break-words font-sans">{file.preview}</pre>
                    ) : (
                      <span className="text-text-muted">这个文件暂无可预览内容。</span>
                    )}
                  </div>
                </details>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-3">
          <div className="rounded-lg border border-border-primary bg-surface-primary p-3">
            <div className="text-sm font-semibold text-text-secondary">任务产出</div>
            {projectOutputSummary.taskOutputs.length === 0 ? (
              <div className="mt-2 text-sm text-text-muted">暂无镖单直接回填的结果。</div>
            ) : (
              <div className="mt-3 space-y-2">
                {projectOutputSummary.taskOutputs.map(item => (
                  <div key={item.taskId} className="rounded-lg bg-surface-secondary p-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0 truncate text-sm font-medium text-text-primary">{item.taskName}</div>
                      <span className="shrink-0 text-xs text-text-muted">{formatRelativeTime(item.updatedAt)}</span>
                    </div>
                    <div className="mt-1 text-sm leading-5 text-text-muted">{item.result}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-lg border border-border-primary bg-surface-primary p-3">
            <div className="text-sm font-semibold text-text-secondary">待补交付</div>
            {projectOutputSummary.missingOutputs.length === 0 ? (
              <div className="mt-2 text-sm text-status-success">当前没有明显缺失的交付回填。</div>
            ) : (
              <div className="mt-3 space-y-2">
                {projectOutputSummary.missingOutputs.map(name => (
                  <div key={name} className="rounded-lg bg-status-warning-bg/30 px-3 py-2 text-sm text-status-warning">
                    {name}
                  </div>
                ))}
              </div>
            )}
            <button
              type="button"
              onClick={() => setWorkbenchView('conversation')}
              className="mt-3 w-full rounded-lg border border-border-primary px-3 py-2 text-sm text-text-secondary hover:bg-surface-hover"
            >
              让帮主补交付结果
            </button>
          </div>
        </div>
      </div>
    </section>
  ) : (
    <div className="rounded-lg border border-border-primary bg-surface-secondary p-4 text-sm text-text-muted">
      先选择一个帮派，项目成果会出现在这里。
    </div>
  )

  const inspectionSection = (
    <section className="rounded-lg border border-border-primary bg-surface-secondary p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-base font-semibold text-text-primary">任务检查</div>
          <div className="mt-1 text-sm text-text-muted">帮主在这里看每张镖单是否有结果、阻塞、返工或可验收依据。</div>
        </div>
        <button
          type="button"
          onClick={() => setWorkbenchView('flow')}
          className="rounded-lg border border-border-primary px-3 py-2 text-sm text-text-secondary hover:bg-surface-hover"
        >
          查看协作流程
        </button>
      </div>
      {sortedTasks.length === 0 ? (
        <div className="mt-4 rounded-lg border border-dashed border-border-primary bg-surface-primary p-6 text-center text-sm text-text-muted">
          暂无镖单。帮主需要先把委托拆成可检查的子任务。
        </div>
      ) : (
        <div className="mt-4 space-y-2">
          {sortedTasks.map((task, index) => {
            const run = runningByTaskId.get(task.id)
            const worker = task.workerId != null ? workerMap.get(task.workerId) : null
            const result = task.lastResult?.trim() || run?.progressMessage || '尚未形成可验收结果'
            return (
              <div key={task.id} className="rounded-lg border border-border-primary bg-surface-primary p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-text-primary truncate">工序 {index + 1}：{task.name}</div>
                    <div className="mt-0.5 text-xs text-text-muted">
                      {worker?.name ?? '未分派弟子'} · {statusText(run?.status ?? task.status)}
                    </div>
                  </div>
                  <span className={`rounded-lg px-2 py-1 text-xs ${
                    task.status === 'completed'
                      ? 'bg-status-success-bg text-status-success'
                      : task.status === 'paused' || task.status === 'error'
                        ? 'bg-status-warning-bg text-status-warning'
                        : 'bg-interactive-bg text-interactive'
                  }`}>
                    {task.status === 'completed' ? '可验收' : task.status === 'paused' || task.status === 'error' ? '需处理' : '推进中'}
                  </span>
                </div>
                <div className="mt-2 text-sm text-text-muted break-words">
                  <span className="text-text-secondary">判断依据：</span>{clipLogText(result, 180)}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )

  const trainingSection = roomId ? (
    <div className="grid gap-3 xl:grid-cols-[360px_1fr]">
      <section className="rounded-lg border border-border-primary bg-surface-secondary p-4">
        <div className="text-base font-semibold text-text-primary">弟子培训</div>
        <div className="mt-1 text-sm text-text-muted">
          给指定弟子发送训练要求，适合补充输出格式、纠正返工原因或要求沉淀功法。
        </div>
        <label className="mt-3 block text-xs text-text-muted">
          选择弟子
          <select
            value={trainingWorkerId}
            onChange={(event) => setTrainingWorkerId(event.target.value ? Number(event.target.value) : '')}
            className="mt-1 w-full rounded-lg border border-border-primary bg-surface-primary px-3 py-2 text-sm text-text-primary"
          >
            <option value="">请选择</option>
            {(workers ?? []).map(worker => (
              <option key={worker.id} value={worker.id}>{worker.name} · {worker.role || '通用弟子'}</option>
            ))}
          </select>
        </label>
        <textarea
          value={trainingText}
          onChange={(event) => setTrainingText(event.target.value)}
          className="mt-3 min-h-32 w-full resize-y rounded-lg border border-border-primary bg-surface-primary px-3 py-2 text-sm text-text-primary outline-none focus:border-interactive"
          placeholder="例如：以后输出评论分析时必须包含高频痛点、代表评论、影响购买决策的证据和下游可复用字段。"
        />
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => { void sendTrainingMessage() }}
            disabled={trainingWorkerId === '' || !trainingText.trim() || workbenchSending}
            className="rounded-lg bg-interactive px-3 py-2 text-sm text-text-invert disabled:opacity-50"
          >
            发送训练
          </button>
          <button
            type="button"
            onClick={() => onNavigate?.('skills')}
            className="rounded-lg border border-border-primary px-3 py-2 text-sm text-text-secondary hover:bg-surface-hover"
          >
            配置功法
          </button>
        </div>
      </section>
      <section className="rounded-lg border border-border-primary bg-surface-secondary p-4">
        <div className="text-base font-semibold text-text-primary">弟子状态</div>
        <div className={wide ? 'mt-3 grid grid-cols-2 gap-3' : 'mt-3 space-y-3'}>
          {(workers ?? []).length === 0 ? (
            <div className="text-sm text-text-muted">暂无弟子。帮主需要先从客栈挑选弟子。</div>
          ) : (workers ?? []).map(worker => {
            const task = taskByWorkerId.get(worker.id)
            return (
              <div key={worker.id} className="rounded-lg border border-border-primary bg-surface-primary p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-text-primary truncate">{worker.name}</div>
                    <div className="text-xs text-text-muted truncate">{worker.role || '通用弟子'}</div>
                  </div>
                  <span className="rounded-lg bg-surface-tertiary px-2 py-1 text-xs text-text-secondary">
                    {workerStateLabel(worker.agentState)}
                  </span>
                </div>
                <div className="mt-2 text-xs text-text-muted">
                  当前镖单：{task ? taskShortName(task) : '待命'}
                </div>
              </div>
            )
          })}
        </div>
      </section>
    </div>
  ) : (
    <div className="rounded-lg border border-border-primary bg-surface-secondary p-4 text-sm text-text-muted">
      先选择一个帮派，弟子培训会出现在这里。
    </div>
  )

  const flowSection = roomId ? (
    <TasksPanel roomId={roomId} autonomyMode="semi" initialView="flow" embedded />
  ) : (
    <div className="rounded-lg border border-border-primary bg-surface-secondary p-4 text-sm text-text-muted">先选择一个帮派，再查看协作流程。</div>
  )

  const ganttSection = roomId ? (
    <TasksPanel roomId={roomId} autonomyMode="semi" initialView="gantt" embedded />
  ) : (
    <div className="rounded-lg border border-border-primary bg-surface-secondary p-4 text-sm text-text-muted">先选择一个帮派，再查看项目甘特图。</div>
  )

  const cards = [queenCard, memoryCard, workersCard, tasksCard, outputsCard, lastRunCard, walletCard, networkCard, usageCard].filter(Boolean)
  const overviewContent = (
    <>
      {battleRoomSection}
      <div className={wide ? 'grid grid-cols-3 gap-3' : 'grid gap-3'}>{cards}</div>
      {runningSection}
    </>
  )
  const workbenchContent = workbenchView === 'conversation'
    ? conversationSection
    : workbenchView === 'goals'
      ? goalsSection
      : workbenchView === 'outputs'
        ? outputsSection
        : workbenchView === 'inspection'
          ? inspectionSection
          : workbenchView === 'training'
            ? trainingSection
            : workbenchView === 'flow'
              ? flowSection
              : workbenchView === 'gantt'
                ? ganttSection
                : overviewContent

  const panelClassName = workbenchView === 'conversation'
    ? 'h-full min-h-0 overflow-hidden p-4 flex flex-col gap-3'
    : 'p-4 flex flex-col gap-3 min-h-full overflow-x-hidden'

  return (
    <div ref={containerRef} className={panelClassName}>
      {header}
      {workbenchTabBar}
      {errorAlert}
      {workbenchNoticeNode}
      {workbenchContent}
    </div>
  )
}
