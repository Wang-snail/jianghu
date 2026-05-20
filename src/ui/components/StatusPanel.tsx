import { useState, useEffect, useRef, useCallback } from 'react'
import { usePolling } from '../hooks/usePolling'
import { useWebSocket } from '../hooks/useWebSocket'
import { useContainerWidth } from '../hooks/useContainerWidth'
import { useTick } from '../hooks/useTick'
import { LiveConsoleSection } from './LiveConsoleSection'
import { api } from '../lib/client'
import {
  ROOM_BALANCE_EVENT_TYPES,
  ROOM_NETWORK_EVENT_TYPES,
} from '../lib/room-events'
import { wsClient, type WsMessage } from '../lib/ws'
import { storageGet, storageSet } from '../lib/storage'
import type { Task, TaskRun, WorkerCycle, RoomActivityEntry, Worker, RevenueSummary, Room } from '@shared/types'
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

const OVERVIEW_VIEW_MODE_KEY = 'zuzu_overview_view_mode'

const GANG_PHASES = ['筹备中', '执行中', '验收中', '已完成', '已失败'] as const
type GangPhase = typeof GANG_PHASES[number]

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

function workerStateLabel(state: string): string {
  if (state === 'thinking') return '执行中'
  if (state === 'acting') return '执行中'
  if (state === 'voting') return '等待审核'
  if (state === 'rate_limited') return '返工中'
  if (state === 'blocked') return '已失败'
  if (state === 'idle') return '待命'
  return state || '待命'
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
  const [viewMode, setViewMode] = useState<'activity' | 'console'>(() => {
    const saved = storageGet(OVERVIEW_VIEW_MODE_KEY)
    return saved === 'console' ? 'console' : 'activity'
  })

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
  useEffect(() => {
    if (!isTimelineView) return
    refreshActivity()
  }, [isTimelineView, roomId, refreshActivity])

  useEffect(() => {
    storageSet(OVERVIEW_VIEW_MODE_KEY, viewMode)
  }, [viewMode])

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
    refreshNetworkCount,
    refreshQueenStatus,
    refreshRevenueSummary,
    refreshTokenUsage,
    isTimelineView,
    roomId,
  ])

  const [activeFilters, setActiveFilters] = useState<Set<string>>(new Set())
  const [expandedActivityId, setExpandedActivityId] = useState<number | null>(null)

  const workerMap = new Map((workers ?? []).map(w => [w.id, w]))

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
    <button key="tasks" className={cardClass} onClick={() => onNavigate?.('tasks')}>
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm font-medium text-text-secondary">镖局</span>
        <span className="text-sm text-text-muted">{data.tasks.length} 张镖单</span>
      </div>
      <div className="flex gap-3 text-sm text-text-muted">
        <span className="text-status-success">{activeTasks.length} 张押运中</span>
        {pausedTasks.length > 0 && <span className="text-status-warning">{pausedTasks.length} 张已阻塞</span>}
        {completedTasks.length > 0 && <span className="text-interactive">{completedTasks.length} 张已交付</span>}
      </div>
    </button>
  )

  // Show the most recent activity: queen cycle or task run, whichever is newer
  const latestActivity = (() => {
    const run = data.latestRun
    const cycle = data.latestCycle
    if (!run && !cycle) return null
    if (!run) return { type: 'cycle' as const, status: cycle!.status, startedAt: cycle!.startedAt, durationMs: cycle!.durationMs }
    if (!cycle) return { type: 'run' as const, status: run.status, startedAt: run.startedAt, durationMs: run.durationMs }
    return new Date(cycle.startedAt) >= new Date(run.startedAt)
      ? { type: 'cycle' as const, status: cycle.status, startedAt: cycle.startedAt, durationMs: cycle.durationMs }
      : { type: 'run' as const, status: run.status, startedAt: run.startedAt, durationMs: run.durationMs }
  })()

  const lastRunCard = (
    <button key="lastrun" className={cardClass} onClick={() => onNavigate?.('tasks')}>
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm font-medium text-text-secondary">最近动向</span>
        {latestActivity && (
          <span className="text-xs text-text-muted">{latestActivity.type === 'cycle' ? '巡行' : '镖单'}</span>
        )}
      </div>
      {latestActivity ? (
        <div className="text-sm text-text-muted">
          <span className={latestActivity.status === 'completed' ? 'text-status-success' : latestActivity.status === 'running' ? 'text-interactive' : 'text-status-error'}>
            {latestActivity.status === 'completed' ? '已完成' : latestActivity.status === 'running' ? '运行中' : latestActivity.status}
          </span>
          {' — '}
          {formatRelativeTime(latestActivity.startedAt)}
          {latestActivity.durationMs != null && (
            <span className="text-text-muted"> ({(latestActivity.durationMs / 1000).toFixed(1)}秒)</span>
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
    <button key="queen" className={cardClass} onClick={() => onNavigate?.('settings')}>
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm font-medium text-text-secondary">天机阁</span>
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
  const allActivity = [...(activity ?? [])].sort(
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
          {filteredActivity.map(entry => (
            <div
              key={entry.id}
              className="cursor-pointer hover:bg-surface-primary rounded-lg px-2.5 py-1.5 transition-colors"
              onClick={() => setExpandedActivityId(expandedActivityId === entry.id ? null : entry.id)}
            >
              <div className="flex items-center gap-1.5">
                <span className={`px-2.5 py-1.5 rounded-lg text-xs font-medium shrink-0 ${EVENT_TYPE_COLORS[entry.eventType] ?? 'bg-surface-tertiary text-text-muted'}`}>
                  {EVENT_TYPE_LABELS[entry.eventType] ?? entry.eventType}
                </span>
                <span className="text-sm text-text-secondary truncate flex-1">{entry.summary}</span>
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
          ))}
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
    <div className="flex items-center gap-2 flex-wrap">
      <h2 className="text-base font-semibold text-text-primary">江湖驾驶舱</h2>
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
  const communicationItems = (activity ?? []).slice(0, 6)

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
                  return (
                    <div key={task.id} className="rounded-lg border border-border-primary bg-surface-primary px-3 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-sm font-medium text-text-primary truncate">{index + 1}. {taskShortName(task)}</div>
                        <span className="text-xs text-text-muted shrink-0">{statusText(run?.status ?? task.status)}</span>
                      </div>
                      <div className="mt-1 text-xs text-text-muted line-clamp-2">{taskBrief(task)}</div>
                    </div>
                  )
                })}
              </div>
            )}
          </aside>

          <div className={wide ? 'p-3' : ''}>
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
                {communicationItems.map(entry => (
                  <div key={entry.id} className="text-sm text-text-muted">
                    <span className="text-text-secondary">{new Date(entry.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                    {' '}
                    {entry.actorId ? `${workerMap.get(entry.actorId)?.name ?? `弟子 #${entry.actorId}`}：` : '天机处：'}
                    {entry.summary}
                  </div>
                ))}
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

  if (!wide) {
    return (
      <div ref={containerRef} className="p-4 flex flex-col gap-3 min-h-full overflow-x-hidden">
        {header}
        {errorAlert}
        {battleRoomSection}
        {queenCard}
        {memoryCard}
        {workersCard}
        {tasksCard}
        {runningSection}
        {lastRunCard}
        {walletCard}
        {networkCard}
        {usageCard}
        {renderLogSection()}
      </div>
    )
  }

  const cards = [queenCard, memoryCard, workersCard, tasksCard, lastRunCard, walletCard, networkCard, usageCard].filter(Boolean)

  return (
    <div ref={containerRef} className="p-4 flex flex-col gap-3 min-h-full overflow-x-hidden">
      {header}
      {errorAlert}
      {battleRoomSection}
      <div className="grid grid-cols-3 gap-3">{cards}</div>
      {runningSection}
      {renderLogSection()}
    </div>
  )
}
