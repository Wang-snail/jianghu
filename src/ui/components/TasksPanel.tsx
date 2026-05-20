import { usePolling } from '../hooks/usePolling'
import { useWebSocket } from '../hooks/useWebSocket'
import { useTick } from '../hooks/useTick'
import type { Task, TaskRun, Worker, ConsoleLogEntry } from '@shared/types'
import { useState, useEffect, useMemo, useRef } from 'react'
import { useContainerWidth } from '../hooks/useContainerWidth'
import { api } from '../lib/client'
import { wsClient, type WsMessage } from '../lib/ws'
import { Select } from './Select'
import { AutoModeLockModal, AUTO_MODE_LOCKED_BUTTON_CLASS, modeAwareButtonClass, useAutonomyControlGate } from './AutonomyControlGate'
import { isAssignableWorker } from '@shared/worker-roles'

type StatusFilter = 'all' | 'active' | 'paused' | 'completed'
type TaskViewMode = 'kanban' | 'gantt' | 'table'

// Module-level persistence: survives component unmounts during tab switches
let persistedFilter: StatusFilter = 'all'

function statusBadge(task: Task): React.JSX.Element {
  const colors: Record<string, string> = {
    active: 'bg-status-success-bg text-status-success',
    paused: 'bg-status-warning-bg text-status-warning',
    completed: 'bg-interactive-bg text-interactive',
    error: 'bg-status-error-bg text-status-error'
  }
  const cls = colors[task.status] ?? 'bg-surface-tertiary text-text-secondary'
  return (
    <span className={`px-2.5 py-1.5 rounded-lg text-sm ${cls}`}>
      {statusLabel(task.status)}
      {task.errorCount > 0 && ` (${task.errorCount})`}
    </span>
  )
}

const SCHEDULE_PRESETS: Array<{ label: string; cron: string }> = [
  { label: '每 5 分钟', cron: '*/5 * * * *' },
  { label: '每 15 分钟', cron: '*/15 * * * *' },
  { label: '每 30 分钟', cron: '*/30 * * * *' },
  { label: '每小时', cron: '0 * * * *' },
  { label: '每 2 小时', cron: '0 */2 * * *' },
  { label: '每天上午 9 点', cron: '0 9 * * *' },
  { label: '每天晚上 6 点', cron: '0 18 * * *' },
  { label: '工作日上午 9 点', cron: '0 9 * * 1-5' },
  { label: '每周一上午 9 点', cron: '0 9 * * 1' },
  { label: '每周五下午 5 点', cron: '0 17 * * 5' }
]

const CRON_LABELS: Record<string, string> = Object.fromEntries(
  SCHEDULE_PRESETS.map((p) => [p.cron, p.label])
)

const DAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function describeCron(expr: string): string {
  if (CRON_LABELS[expr]) return CRON_LABELS[expr]

  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return expr

  if (parts.every((p) => p === '*')) return '每分钟'

  const [min, hour, , , dow] = parts

  if (min.match(/^\d+$/) && hour.match(/^\d+$/) && dow === '*') {
    return `每天 ${formatTime(parseInt(hour, 10), parseInt(min, 10))}`
  }

  if (min.match(/^\d+$/) && hour.match(/^\d+$/) && dow === '1-5') {
    return `工作日 ${formatTime(parseInt(hour, 10), parseInt(min, 10))}`
  }

  if (min.match(/^\d+$/) && hour.match(/^\d+$/) && dow.match(/^\d$/)) {
    const day = DAYS[parseInt(dow, 10)] ?? dow
    return `每${day} ${formatTime(parseInt(hour, 10), parseInt(min, 10))}`
  }

  if (min.match(/^\d+$/) && hour.match(/^\d+$/) && (dow === '0,6' || dow === '6,0')) {
    return `周末 ${formatTime(parseInt(hour, 10), parseInt(min, 10))}`
  }

  if (min.match(/^\d+$/) && hour.match(/^\d+$/) && dow === '2-6') {
    const h = parseInt(hour, 10)
    const label = h === 0 ? '午夜' : formatTime(h, parseInt(min, 10))
    return `工作日夜间 ${label}`
  }

  if (min.startsWith('*/') && hour === '*') {
    return `每 ${min.slice(2)} 分钟`
  }

  if (min === '0' && hour.startsWith('*/')) {
    const n = hour.slice(2)
    return n === '1' ? '每小时' : `每 ${n} 小时`
  }

  if (min.match(/^\d+$/) && hour.includes(',') && dow === '*') {
    const m = parseInt(min, 10)
    const times = hour.split(',').map((h) => formatTime(parseInt(h, 10), m)).join(', ')
    return `每天 ${times}`
  }

  if (min.match(/^\d+$/) && hour.includes(',') && dow === '1-5') {
    const m = parseInt(min, 10)
    const times = hour.split(',').map((h) => formatTime(parseInt(h, 10), m)).join(', ')
    return `工作日 ${times}`
  }

  return expr
}

function formatTime(h: number, m: number): string {
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function statusLabel(status: string): string {
  if (status === 'active') return '活跃'
  if (status === 'paused') return '已暂停'
  if (status === 'completed') return '已完成'
  return status
}

function taskProblem(task: Task): string {
  return task.description?.trim() || task.prompt.split('\n')[0]?.slice(0, 90) || task.name
}

function taskWhy(task: Task): string {
  return task.roomId ? '推进当前委托目标' : '推进全局委托'
}

function taskProgress(task: Task, run?: TaskRun): string {
  if (run?.progressMessage) return run.progressMessage
  if (run) return run.progress != null ? `执行中 ${Math.round(run.progress * 100)}%` : '执行中'
  if (task.lastResult) return task.lastResult.slice(0, 80)
  return task.status === 'paused' ? '已阻塞，等待恢复' : '等待执行'
}

function taskBlocker(task: Task): string {
  if (task.status === 'paused') return '镖单已暂停'
  if (task.errorCount > 0) return `最近失败 ${task.errorCount} 次，需要排查根因`
  return '暂无'
}

function taskEta(task: Task): string {
  if (task.scheduledAt) return new Date(task.scheduledAt).toLocaleString()
  if (task.triggerType === 'manual') return '手动运行后确认'
  return task.cronExpression ? describeCron(task.cronExpression) : '待排期'
}

function ProgressBar({ run }: { run: TaskRun }): React.JSX.Element {
  return (
    <div className="mt-1">
      <div className="flex items-center gap-2">
        <div className="flex-1 h-1.5 bg-surface-tertiary rounded-full overflow-hidden">
          {run.progress != null ? (
            <div
              className="h-full bg-interactive rounded-full transition-all duration-500"
              style={{ width: `${Math.round(run.progress * 100)}%` }}
            />
          ) : (
            <div className="h-full bg-interactive rounded-full animate-pulse w-full" />
          )}
        </div>
      </div>
      {run.progressMessage && (
        <div className="text-sm text-interactive mt-0.5 truncate">
          {run.progressMessage}
        </div>
      )}
    </div>
  )
}

const CONSOLE_ENTRY_COLORS: Record<string, string> = {
  tool_call: 'text-yellow-400',
  assistant_text: 'text-green-300',
  tool_result: 'text-console-text',
  result: 'text-blue-400',
  error: 'text-red-400'
}

function ConsoleView({ runId }: { runId: number }): React.JSX.Element {
  const [entries, setEntries] = useState<ConsoleLogEntry[]>([])
  const lastSeqRef = useRef(0)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let mounted = true
    lastSeqRef.current = 0
    setEntries([])

    const poll = async (): Promise<void> => {
      if (!mounted) return
      try {
        const newEntries = await api.runs.getLogs(runId, lastSeqRef.current, 50)
        if (newEntries.length > 0 && mounted) {
          lastSeqRef.current = newEntries[newEntries.length - 1].seq
          setEntries(prev => {
            const seen = new Set(prev.map((entry) => entry.seq))
            const merged = [...prev]
            for (const entry of newEntries) {
              if (seen.has(entry.seq)) continue
              seen.add(entry.seq)
              merged.push(entry)
            }
            return merged.slice(-150)
          })
        }
      } catch {
        // non-fatal
      }
    }
    void poll()
    const unsubscribe = wsClient.subscribe(`run:${runId}`, (event: WsMessage) => {
      if (event.type !== 'run:log') return
      const payload = event.data as Partial<ConsoleLogEntry> & { seq?: number; entryType?: string; content?: string }
      if (typeof payload.seq !== 'number' || typeof payload.entryType !== 'string' || typeof payload.content !== 'string') return
      const entry: ConsoleLogEntry = { seq: payload.seq, entryType: payload.entryType, content: payload.content }
      lastSeqRef.current = Math.max(lastSeqRef.current, entry.seq)
      setEntries(prev => {
        if (prev.some((candidate) => candidate.seq === entry.seq)) return prev
        return [...prev.slice(-149), entry]
      })
    })
    const timer = setInterval(() => { void poll() }, 10000)
    return () => { mounted = false; unsubscribe(); clearInterval(timer) }
  }, [runId])

  useEffect(() => {
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight)
  }, [entries])

  return (
    <div
      ref={scrollRef}
      className="max-h-48 overflow-y-auto bg-console-bg rounded-lg p-3 mt-1 font-mono text-sm leading-relaxed"
    >
      {entries.map((e) => (
        <div key={e.seq} className={CONSOLE_ENTRY_COLORS[e.entryType] ?? 'text-console-text'}>
          {e.content}
        </div>
      ))}
      {entries.length === 0 && (
        <div className="text-text-muted">等待输出...</div>
      )}
    </div>
  )
}

function TaskActions({
  task,
  activeRun,
  busy,
  semi,
  guard,
  runNow,
  togglePause,
  deleteTask,
  consoleTaskId,
  setConsoleTaskId,
  workers,
  assignWorker,
  requestSemiMode,
}: {
  task: Task
  activeRun?: TaskRun
  busy: boolean
  semi: boolean
  guard: (action: () => void) => void
  runNow: (id: number) => Promise<void>
  togglePause: (task: Task) => Promise<void>
  deleteTask: (id: number) => Promise<void>
  consoleTaskId: number | null
  setConsoleTaskId: (id: number | null) => void
  workers: Worker[]
  assignWorker: (taskId: number, newWorkerId: number | null) => Promise<void>
  requestSemiMode: () => void
}): React.JSX.Element {
  const selectedWorkerValue = workers.some(worker => worker.id === task.workerId)
    ? String(task.workerId ?? '')
    : ''

  return (
    <div className="flex flex-wrap gap-2 items-center mt-3">
      <button
        onClick={() => guard(() => { void runNow(task.id) })}
        disabled={semi && busy}
        className={`text-xs px-2.5 py-1.5 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed ${modeAwareButtonClass(semi, 'bg-interactive text-text-invert hover:bg-interactive-hover')}`}
      >
        {busy ? '运行中' : '运行'}
      </button>
      {task.status !== 'completed' && (
        <button
          onClick={() => guard(() => { void togglePause(task) })}
          disabled={semi && busy}
          className={`text-xs px-2.5 py-1.5 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed ${modeAwareButtonClass(semi, 'bg-status-warning-bg text-status-warning hover:bg-status-warning-bg')}`}
        >
          {task.status === 'paused' ? '恢复' : '暂停'}
        </button>
      )}
      <button
        onClick={() => guard(() => { void deleteTask(task.id) })}
        disabled={semi && busy}
        className={`text-xs px-2.5 py-1.5 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed ${modeAwareButtonClass(semi, 'bg-status-error-bg text-status-error hover:bg-status-error-bg')}`}
      >
        删除
      </button>
      {activeRun && (
        <button
          onClick={() => setConsoleTaskId(consoleTaskId === task.id ? null : task.id)}
          className="text-xs px-2.5 py-1.5 rounded-lg border border-border-primary text-text-muted hover:text-text-secondary hover:bg-surface-hover"
        >
          {consoleTaskId === task.id ? '隐藏控制台' : '控制台'}
        </button>
      )}
      {workers.length > 0 && (
        <div className="ml-auto min-w-[150px]">
          {semi ? (
            <Select
              value={selectedWorkerValue}
              onChange={(v) => { void assignWorker(task.id, v ? Number(v) : null) }}
              variant="inline"
              className="text-purple-400"
              placeholder="不指定弟子"
              options={[
                { value: '', label: '不指定弟子' },
                ...workers.map(w => ({ value: String(w.id), label: w.name }))
              ]}
            />
          ) : (
            <button
              onClick={requestSemiMode}
              className={`text-xs px-2.5 py-1.5 rounded-lg w-full text-left ${AUTO_MODE_LOCKED_BUTTON_CLASS}`}
            >
              分派弟子
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function CreateTaskForm({ workers, onCreated, roomId }: { workers: Worker[] | null; onCreated: () => void; roomId?: number | null }): React.JSX.Element {
  const [prompt, setPrompt] = useState('')
  const [name, setName] = useState('')
  const [scheduleMode, setScheduleMode] = useState<'manual' | 'preset' | 'custom'>('manual')
  const [selectedPreset, setSelectedPreset] = useState(0)
  const [customCron, setCustomCron] = useState('')
  const [workerId, setWorkerId] = useState<number | ''>('')
  const [maxRuns, setMaxRuns] = useState<string>('')
  const [createError, setCreateError] = useState<string | null>(null)

  function getResolvedCron(): string | undefined {
    if (scheduleMode === 'preset') return SCHEDULE_PRESETS[selectedPreset].cron
    if (scheduleMode === 'custom') return customCron.trim() || undefined
    return undefined
  }

  async function handleCreate(): Promise<void> {
    const trimmedPrompt = prompt.trim()
    if (!trimmedPrompt) {
      setCreateError('请填写镖单要求。')
      return
    }
    setCreateError(null)
    try {
      const parsedMaxRuns = maxRuns.trim() ? parseInt(maxRuns.trim(), 10) : undefined
      await api.tasks.create({
        name: name.trim() || trimmedPrompt.slice(0, 40),
        prompt: trimmedPrompt,
        cronExpression: getResolvedCron(),
        workerId: workerId || undefined,
        maxRuns: parsedMaxRuns && parsedMaxRuns > 0 ? parsedMaxRuns : undefined,
        roomId: roomId ?? undefined
      })
      setPrompt('')
      setName('')
      setScheduleMode('manual')
      setSelectedPreset(0)
      setCustomCron('')
      setWorkerId('')
      setMaxRuns('')
      onCreated()
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : '创建镖单失败')
    }
  }

  return (
    <div className="p-4 border-b-2 border-border-primary bg-surface-secondary space-y-2">
      <textarea
        value={prompt}
        onChange={(e) => { setPrompt(e.target.value); setCreateError(null) }}
        rows={3}
        placeholder="镖单要求：弟子应该具体做什么？"
        className="w-full bg-surface-primary border border-border-primary rounded-lg px-2.5 py-1.5 text-sm text-text-primary focus:outline-none focus:border-text-muted resize-y"
      />
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="镖单名称（可选）"
        className="w-full bg-surface-primary border border-border-primary rounded-lg px-2.5 py-1.5 text-sm text-text-primary focus:outline-none focus:border-text-muted"
      />
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-xs text-text-muted">触发方式：</span>
          {(['manual', 'preset', 'custom'] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => setScheduleMode(mode)}
              className={`text-xs font-medium px-2.5 py-1.5 rounded-lg cursor-pointer transition-colors ${
                scheduleMode === mode
                  ? 'bg-surface-invert text-text-invert'
                  : 'bg-surface-tertiary text-text-muted hover:bg-surface-hover'
              }`}
            >
              {mode === 'manual' ? '手动' : mode === 'preset' ? '定时' : '自定义'}
            </button>
          ))}
        </div>
        {scheduleMode === 'preset' && (
          <Select
            value={String(selectedPreset)}
            onChange={(v) => setSelectedPreset(Number(v))}
            className="w-full"
            options={SCHEDULE_PRESETS.map((p, i) => ({ value: String(i), label: p.label }))}
          />
        )}
        {scheduleMode === 'custom' && (
          <input
            type="text"
            value={customCron}
            onChange={(e) => setCustomCron(e.target.value)}
            placeholder="Cron 表达式，例如 0 9 * * 1-5 表示工作日 09:00"
            className="w-full bg-surface-primary border border-border-primary rounded-lg px-2.5 py-1.5 text-sm text-text-primary focus:outline-none focus:border-text-muted"
          />
        )}
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        {workers && workers.length > 0 && (
          <Select
            value={String(workerId)}
            onChange={(v) => setWorkerId(v ? Number(v) : '')}
            placeholder="不指定弟子"
            options={[
              { value: '', label: '不指定弟子' },
              ...workers.map(w => ({ value: String(w.id), label: w.name }))
            ]}
          />
        )}
        <div className="flex items-center gap-2">
          <span className="text-xs text-text-muted">次数：</span>
          <input
            type="text"
            inputMode="numeric"
            value={maxRuns}
            onChange={(e) => {
              const v = e.target.value
              if (v === '' || /^\d+$/.test(v)) setMaxRuns(v)
            }}
            placeholder="不限"
            className="w-16 bg-surface-primary border border-border-primary rounded-lg px-2.5 py-1.5 text-sm text-text-primary text-center focus:outline-none focus:border-text-muted"
          />
        </div>
        <div className="flex-1" />
        {createError && (
          <span className="text-sm text-status-error truncate">{createError}</span>
        )}
        <button
          onClick={handleCreate}
          disabled={!prompt.trim()}
          className="text-sm bg-interactive text-text-invert px-4 py-2 rounded-lg hover:bg-interactive-hover disabled:opacity-50 disabled:cursor-not-allowed"
        >
          创建镖单
        </button>
      </div>
    </div>
  )
}

export function TasksPanel({ roomId, autonomyMode }: { roomId?: number | null; autonomyMode: 'semi' }): React.JSX.Element {
  useTick()
  const { semi, guard, requestSemiMode, showLockModal, closeLockModal } = useAutonomyControlGate(autonomyMode)
  const [containerRef, containerWidth] = useContainerWidth<HTMLDivElement>()
  const wide = containerWidth >= 600
  const [filter, setFilter] = useState<StatusFilter>(persistedFilter)
  const [actionError, setActionError] = useState<string | null>(null)
  const [pendingRuns, setPendingRuns] = useState<Set<number>>(new Set())
  const [consoleTaskId, setConsoleTaskId] = useState<number | null>(null)
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [viewMode, setViewMode] = useState<TaskViewMode>('kanban')
  const { data: tasks, refresh, error: tasksError, isLoading } = usePolling(() => api.tasks.list(roomId ?? undefined), 30000)
  const { data: runningRuns, refresh: refreshRuns } = usePolling(
    () => api.runs.list(20, { status: 'running' }),
    30000
  )
  const { data: workers } = usePolling(() => roomId ? api.workers.listForRoom(roomId) : Promise.resolve([]), 60000)
  const { data: room } = usePolling(() => roomId ? api.rooms.get(roomId).catch(() => null) : Promise.resolve(null), 60000)
  const taskEvent = useWebSocket('tasks')
  const runsEvent = useWebSocket('runs')

  useEffect(() => {
    if (taskEvent) refresh()
  }, [refresh, taskEvent])

  useEffect(() => {
    if (!runsEvent) return
    refreshRuns()
    refresh()
  }, [refresh, refreshRuns, runsEvent])

  function updateFilter(next: StatusFilter): void {
    persistedFilter = next
    setFilter(next)
  }

  const assignableWorkers = useMemo(() => {
    return (workers ?? []).filter(worker => isAssignableWorker(worker, room?.queenWorkerId ?? null))
  }, [workers, room?.queenWorkerId])

  const workerMap = new Map<number, Worker>()
  if (assignableWorkers.length > 0) {
    for (const w of assignableWorkers) workerMap.set(w.id, w)
  }

  const runningByTaskId = new Map<number, TaskRun>()
  if (runningRuns) {
    for (const run of runningRuns) {
      if (!runningByTaskId.has(run.taskId)) {
        runningByTaskId.set(run.taskId, run)
      }
    }
  }

  async function togglePause(task: Task): Promise<void> {
    setActionError(null)
    try {
      if (task.status === 'paused') {
        await api.tasks.resume(task.id)
      } else {
        await api.tasks.pause(task.id)
      }
      refresh()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '更新镖单状态失败')
    }
  }

  async function deleteTask(id: number): Promise<void> {
    setActionError(null)
    try {
      await api.tasks.delete(id)
      refresh()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '删除镖单失败')
    }
  }

  async function runNow(id: number): Promise<void> {
    setActionError(null)
    setPendingRuns((prev) => new Set(prev).add(id))
    try {
      await api.tasks.run(id)
      refresh()
    } catch (err) {
      setPendingRuns((prev) => { const next = new Set(prev); next.delete(id); return next })
      setActionError(err instanceof Error ? err.message : '运行镖单失败')
    }
  }

  // Clear pending flags once polling detects the actual running run
  useEffect(() => {
    if (pendingRuns.size === 0) return
    const confirmed = new Set<number>()
    for (const id of pendingRuns) {
      if (runningByTaskId.has(id)) confirmed.add(id)
    }
    if (confirmed.size > 0) {
      setPendingRuns((prev) => {
        const next = new Set(prev)
        for (const id of confirmed) next.delete(id)
        return next
      })
    }
  }, [runningRuns])

  // Safety timeout: clear stale pending runs that never materialized into actual runs
  useEffect(() => {
    if (pendingRuns.size === 0) return
    const timer = setTimeout(() => {
      setPendingRuns((prev) => {
        const next = new Set<number>()
        for (const id of prev) {
          if (runningByTaskId.has(id)) next.add(id)
        }
        return next.size === prev.size ? prev : next
      })
    }, 15000)
    return () => clearTimeout(timer)
  }, [pendingRuns.size])

  async function assignWorker(taskId: number, newWorkerId: number | null): Promise<void> {
    setActionError(null)
    try {
      await api.tasks.update(taskId, { workerId: newWorkerId })
      refresh()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '分派弟子失败')
    }
  }

  if (isLoading && !tasks) {
    return <div className="p-4 flex-1 flex items-center justify-center text-base text-text-muted">加载中...</div>
  }
  if (!tasks) {
    return <div className="p-4 text-sm text-status-error">{tasksError ?? '加载镖单失败。'}</div>
  }

  const taskCounts = {
    all: tasks.length,
    active: tasks.filter((t) => t.status === 'active').length,
    paused: tasks.filter((t) => t.status === 'paused').length,
    completed: tasks.filter((t) => t.status === 'completed').length
  }
  const isFiltering = filter !== 'all'
  const filteredTasks = filter === 'all' ? tasks : tasks.filter(t => t.status === filter)

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-1.5 border-b border-border-primary flex items-center gap-2 flex-wrap">
        <h2 className="text-base font-semibold text-text-primary">龙门镖局</h2>
        <span className="text-xs text-text-muted">{tasks.length} 张镖单</span>
        <button
          onClick={() => guard(() => setShowCreateForm(!showCreateForm))}
          className={`text-xs px-2.5 py-1.5 rounded-lg ${modeAwareButtonClass(semi, 'bg-interactive text-text-invert hover:bg-interactive-hover')}`}
        >
          {showCreateForm ? '取消' : '+ 发布委托'}
        </button>
        <div className="ml-auto inline-flex gap-1 rounded-lg bg-surface-tertiary p-0.5">
          {([
            ['kanban', '镖局看板'],
            ['gantt', '甘特图'],
            ['table', '表格'],
          ] as Array<[TaskViewMode, string]>).map(([mode, label]) => (
            <button
              key={mode}
              onClick={() => setViewMode(mode)}
              className={`px-2.5 py-1.5 rounded-lg text-xs ${viewMode === mode ? 'bg-surface-primary text-text-primary shadow-sm' : 'text-text-muted hover:text-text-secondary'}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {semi && showCreateForm && (
        <CreateTaskForm
          workers={assignableWorkers}
          onCreated={() => { refresh(); setShowCreateForm(false) }}
          roomId={roomId}
        />
      )}

      <div className="px-3 py-2 border-b border-border-primary">
        <div className="flex items-center justify-between gap-2 mb-2">
          <div className="text-xs font-semibold text-text-muted">筛选</div>
          {isFiltering && (
            <button
              onClick={() => updateFilter('all')}
              className="text-xs px-2 py-1 rounded-lg border border-border-primary text-text-muted hover:text-text-secondary hover:bg-surface-hover transition-colors"
            >
              清除
            </button>
          )}
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            onClick={() => updateFilter('all')}
            className={`px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
              filter === 'all'
                ? 'bg-interactive-bg text-interactive border-interactive/30'
                : 'bg-surface-primary text-text-muted border-border-primary hover:bg-surface-hover hover:text-text-secondary'
            }`}
          >
            全部 ({taskCounts.all})
          </button>
          <button
            onClick={() => updateFilter('active')}
            className={`px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
              filter === 'active'
                ? 'bg-status-success-bg text-status-success border-transparent'
                : 'bg-surface-primary text-text-muted border-border-primary hover:bg-surface-hover hover:text-text-secondary'
            }`}
          >
            活跃 ({taskCounts.active})
          </button>
          <button
            onClick={() => updateFilter('paused')}
            className={`px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
              filter === 'paused'
                ? 'bg-status-warning-bg text-status-warning border-transparent'
                : 'bg-surface-primary text-text-muted border-border-primary hover:bg-surface-hover hover:text-text-secondary'
            }`}
          >
            已暂停 ({taskCounts.paused})
          </button>
          <button
            onClick={() => updateFilter('completed')}
            className={`px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
              filter === 'completed'
                ? 'bg-interactive-bg text-interactive border-transparent'
                : 'bg-surface-primary text-text-muted border-border-primary hover:bg-surface-hover hover:text-text-secondary'
            }`}
          >
            已完成 ({taskCounts.completed})
          </button>
        </div>
      </div>

      {tasksError && (
        <div className="px-3 py-2 text-sm text-status-warning bg-status-warning-bg">
          刷新镖单时遇到临时问题：{tasksError}
        </div>
      )}
      {actionError && (
        <div className="px-3 py-2 text-sm text-status-error bg-status-error-bg">
          操作失败：{actionError}
        </div>
      )}

      <div ref={containerRef} className="flex-1 overflow-y-auto">
      {filteredTasks.length === 0 ? (
        <div className="p-4 text-center text-sm text-text-muted">
          {filter !== 'all' ? (
            <>
              没有匹配筛选条件的镖单。{' '}
              <button
                onClick={() => updateFilter('all')}
                className="text-xs px-2.5 py-1.5 rounded-lg bg-interactive text-text-invert hover:bg-interactive-hover"
              >
                清除筛选
              </button>
            </>
          ) : semi ? (
            '暂无镖单。可以在上方发布委托，或让天机阁自动分派。'
          ) : (
            '暂无镖单。镖单会由天机阁和弟子创建。'
          )}
        </div>
      ) : viewMode === 'table' ? (
        <div className="p-3 overflow-x-auto">
          <table className="w-full min-w-[900px] text-sm border-separate border-spacing-y-2">
            <thead className="text-left text-xs text-text-muted">
              <tr>
                <th className="px-3 py-1">镖单</th>
                <th className="px-3 py-1">弟子</th>
                <th className="px-3 py-1">正在解决</th>
                <th className="px-3 py-1">为什么</th>
                <th className="px-3 py-1">进展</th>
                <th className="px-3 py-1">困难</th>
                <th className="px-3 py-1">预计完成</th>
              </tr>
            </thead>
            <tbody>
              {filteredTasks.map(task => {
                const run = runningByTaskId.get(task.id)
                const worker = task.workerId != null ? workerMap.get(task.workerId) : undefined
                return (
                  <tr key={task.id} className="bg-surface-secondary">
                    <td className="px-3 py-2 rounded-l-lg text-text-primary">{task.name}</td>
                    <td className="px-3 py-2 text-text-muted">{worker?.name ?? '未分派'}</td>
                    <td className="px-3 py-2 text-text-muted">{taskProblem(task)}</td>
                    <td className="px-3 py-2 text-text-muted">{taskWhy(task)}</td>
                    <td className="px-3 py-2 text-text-muted">{taskProgress(task, run)}</td>
                    <td className="px-3 py-2 text-text-muted">{taskBlocker(task)}</td>
                    <td className="px-3 py-2 rounded-r-lg text-text-muted">{taskEta(task)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : viewMode === 'gantt' ? (
        <div className="p-3 space-y-2">
          {filteredTasks.map((task, index) => {
            const run = runningByTaskId.get(task.id)
            const worker = task.workerId != null ? workerMap.get(task.workerId) : undefined
            const progress = run?.progress != null ? Math.round(run.progress * 100) : task.status === 'completed' ? 100 : task.status === 'paused' ? 20 : 45
            return (
              <div key={task.id} className="grid grid-cols-[160px_1fr] gap-3 items-center bg-surface-secondary rounded-lg p-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-text-primary truncate">{task.name}</div>
                  <div className="text-xs text-text-muted truncate">{worker?.name ?? '未分派'} · {taskEta(task)}</div>
                </div>
                <div className="h-8 rounded-lg bg-surface-tertiary overflow-hidden relative">
                  <div
                    className={`h-full ${task.status === 'paused' ? 'bg-status-warning-bg' : task.status === 'completed' ? 'bg-status-success-bg' : 'bg-interactive-bg'}`}
                    style={{ width: `${Math.max(12, progress)}%`, marginLeft: `${(index % 4) * 4}%` }}
                  />
                  <div className="absolute inset-0 flex items-center px-3 text-xs text-text-secondary">
                    {statusLabel(task.status)} · {taskProgress(task, run)}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <div className={`grid gap-3 p-3 ${wide ? 'grid-cols-3' : 'grid-cols-1'}`}>
          {(['active', 'paused', 'completed'] as const).map((columnStatus) => {
            const columnTasks = filteredTasks.filter(task => task.status === columnStatus)
            return (
              <div key={columnStatus} className="rounded-lg bg-surface-tertiary/60 p-2 min-h-40">
                <div className="px-2 pb-2 text-xs font-semibold text-text-secondary">
                  {statusLabel(columnStatus)} · {columnTasks.length}
                </div>
                <div className="space-y-2">
                  {columnTasks.map((task) => {
                    const activeRun = runningByTaskId.get(task.id)
                    const busy = !!activeRun || pendingRuns.has(task.id)
                    const worker = task.workerId != null ? workerMap.get(task.workerId) : undefined
                    return (
                      <div key={task.id} className="bg-surface-secondary border border-border-primary rounded-lg p-3 shadow-sm">
                        <div className="flex items-start justify-between gap-2 mb-2">
                          <span className="text-sm font-medium text-text-primary">{task.name}</span>
                          {statusBadge(task)}
                        </div>
                        <div className="space-y-1 text-xs text-text-muted">
                          <div><span className="text-text-secondary">弟子：</span>{worker?.name ?? '未分派'}</div>
                          <div><span className="text-text-secondary">正在解决：</span>{taskProblem(task)}</div>
                          <div><span className="text-text-secondary">为什么：</span>{taskWhy(task)}</div>
                          <div><span className="text-text-secondary">当前进展：</span>{taskProgress(task, activeRun)}</div>
                          <div><span className="text-text-secondary">困难：</span>{taskBlocker(task)}</div>
                          <div><span className="text-text-secondary">预计完成：</span>{taskEta(task)}</div>
                        </div>
                        {activeRun && <ProgressBar run={activeRun} />}
                        {activeRun && consoleTaskId === task.id && <ConsoleView runId={activeRun.id} />}
                        <TaskActions
                          task={task}
                          activeRun={activeRun}
                          busy={busy}
                          semi={semi}
                          guard={guard}
                          runNow={runNow}
                          togglePause={togglePause}
                          deleteTask={deleteTask}
                          consoleTaskId={consoleTaskId}
                          setConsoleTaskId={setConsoleTaskId}
                          workers={assignableWorkers}
                          assignWorker={assignWorker}
                          requestSemiMode={requestSemiMode}
                        />
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      )}
      </div>
      <AutoModeLockModal open={showLockModal} onClose={closeLockModal} />
    </div>
  )
}
