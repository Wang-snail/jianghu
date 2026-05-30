import { usePolling } from '../hooks/usePolling'
import { useWebSocket } from '../hooks/useWebSocket'
import { useTick } from '../hooks/useTick'
import type { Task, TaskRun, Worker, ConsoleLogEntry, WorkerCycle } from '@shared/types'
import { useState, useEffect, useMemo, useRef } from 'react'
import { useContainerWidth } from '../hooks/useContainerWidth'
import { api } from '../lib/client'
import { wsClient, type WsMessage } from '../lib/ws'
import { Select } from './Select'
import { AutoModeLockModal, AUTO_MODE_LOCKED_BUTTON_CLASS, modeAwareButtonClass, useAutonomyControlGate } from './AutonomyControlGate'
import { isAssignableWorker } from '@shared/worker-roles'
import { isDecisionTaskFlowRelation, parseTaskFlowSpec, taskFlowRelationLabel, upsertTaskFlowDescription, type TaskFlowPatch, type TaskFlowRelation } from '@shared/task-flow'

type StatusFilter = 'all' | 'active' | 'paused' | 'completed'
type TaskViewMode = 'kanban' | 'flow' | 'gantt' | 'table'

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

function compactText(value: string | null | undefined, max = 72): string {
  const text = (value ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function extractTaskField(task: Task, labels: string[], fallback: string): string {
  const text = `${task.description ?? ''}\n${task.prompt ?? ''}`
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const match = text.match(new RegExp(`${escaped}\\s*[：:]\\s*([^\\n]+)`, 'i'))
    if (match?.[1]?.trim()) return compactText(match[1], 86)
  }
  return fallback
}

function taskUpstream(task: Task): string {
  return parseTaskFlowSpec(task).upstream || extractTaskField(task, ['上游输入', '输入来源', '上游', '来源'], '来自帮主分派')
}

function taskDownstream(task: Task): string {
  return parseTaskFlowSpec(task).downstream || extractTaskField(task, ['下游接收方', '下游', '交给谁', '接收方'], '交给帮主验收')
}

function taskOutputFormat(task: Task): string {
  return parseTaskFlowSpec(task).outputFormat || extractTaskField(task, ['输出格式', '交付格式', '输出目标'], '按镖单要求交付')
}

function taskFlowOrder(task: Task, fallback: number): number {
  return parseTaskFlowSpec(task).order ?? fallback + 1
}

const TASK_FLOW_RELATION_OPTIONS: Array<{ value: TaskFlowRelation; label: string }> = [
  { value: 'sequential', label: '串行' },
  { value: 'parallel', label: '并行' },
  { value: 'conditional', label: '条件分支' },
  { value: 'join', label: '汇合' },
  { value: 'review', label: '审核' },
  { value: 'rework', label: '返工' },
]

function relationStroke(relation: TaskFlowRelation): string {
  if (relation === 'parallel') return 'var(--status-info)'
  if (relation === 'conditional') return 'var(--status-warning)'
  if (relation === 'join') return 'var(--status-success)'
  if (relation === 'review') return 'var(--interactive)'
  if (relation === 'rework') return 'var(--status-error)'
  return 'var(--interactive)'
}

function relationPillClass(relation: TaskFlowRelation): string {
  if (relation === 'parallel') return 'bg-status-info-bg text-status-info'
  if (relation === 'conditional') return 'bg-status-warning-bg text-status-warning'
  if (relation === 'join') return 'bg-status-success-bg text-status-success'
  if (relation === 'review') return 'bg-interactive-bg text-interactive'
  if (relation === 'rework') return 'bg-status-error-bg text-status-error'
  return 'bg-surface-tertiary text-text-muted'
}

function dependencyIds(value: string, taskIds: Set<number>): number[] {
  const ids = new Set<number>()
  for (const match of value.matchAll(/#?(\d+)/g)) {
    const id = Number(match[1])
    if (taskIds.has(id)) ids.add(id)
  }
  return [...ids]
}

function taskProgressPercent(task: Task, run?: TaskRun): number {
  if (run?.progress != null) return Math.round(run.progress * 100)
  if (task.status === 'completed') return 100
  if (task.status === 'paused') return 20
  if (task.status === 'active') return 45
  if (task.status === 'error') return 12
  return 8
}

function cycleStatusLabel(status: string): string {
  if (status === 'running') return '进行中'
  if (status === 'completed') return '已完成'
  if (status === 'failed' || status === 'error') return '失败'
  return status || '待记录'
}

function cycleStatusTone(status: string): string {
  if (status === 'running') return 'bg-interactive-bg text-interactive'
  if (status === 'completed') return 'bg-status-success-bg text-status-success'
  if (status === 'failed' || status === 'error') return 'bg-status-error-bg text-status-error'
  return 'bg-surface-tertiary text-text-muted'
}

function formatCycleTime(cycle?: WorkerCycle): string {
  if (!cycle) return '等待记录'
  const started = new Date(cycle.startedAt)
  if (Number.isNaN(started.getTime())) return cycleStatusLabel(cycle.status)
  return started.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function fallbackHeartbeatCount(task: Task, run?: TaskRun): number {
  const progress = taskProgressPercent(task, run)
  if (task.status === 'completed') return 4
  if (task.status === 'paused') return 1
  return clampNumber(Math.ceil(progress / 25), 1, 4)
}

function heartbeatWorkLabel(task: Task, cycle: WorkerCycle | undefined, run: TaskRun | undefined, stepIndex: number, span: number): string {
  if (cycle?.errorMessage) return `排查失败：${compactText(cycle.errorMessage, 34)}`
  if (task.status === 'paused') return `处理阻塞：${compactText(taskBlocker(task), 34)}`
  if (span <= 1) return `解决：${compactText(taskProblem(task), 34)}`
  if (stepIndex === 0) return `明确问题：${compactText(taskProblem(task), 34)}`
  if (stepIndex === span - 1 && task.status === 'completed') {
    return `交付：${compactText(task.lastResult || taskOutputFormat(task), 34)}`
  }
  if (stepIndex === span - 1) return `准备交付：${compactText(taskOutputFormat(task), 34)}`
  return `继续推进：${compactText(taskProgress(task, run), 34)}`
}

function HeartbeatGanttView({
  tasks,
  workerMap,
  runningByTaskId,
  cycles,
}: {
  tasks: Task[]
  workerMap: Map<number, Worker>
  runningByTaskId: Map<number, TaskRun>
  cycles: WorkerCycle[]
}): React.JSX.Element {
  const orderedCycles = useMemo(() => {
    return [...cycles]
      .sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime())
      .slice(-12)
  }, [cycles])
  const realHeartbeatCount = orderedCycles.length
  const fallbackCount = Math.max(4, ...tasks.map(task => fallbackHeartbeatCount(task, runningByTaskId.get(task.id))))
  const heartbeatCount = clampNumber(realHeartbeatCount || fallbackCount, 4, 12)
  const columns = realHeartbeatCount > 0
    ? orderedCycles.slice(-heartbeatCount).map((cycle, index) => ({ key: String(cycle.id), label: `心跳 ${index + 1}`, cycle }))
    : Array.from({ length: heartbeatCount }, (_, index) => ({ key: `synthetic-${index + 1}`, label: `心跳 ${index + 1}`, cycle: undefined }))
  const leftColumnWidth = 220
  const heartbeatColumnWidth = 160
  const heartbeatTrackWidth = heartbeatCount * heartbeatColumnWidth
  const chartWidth = leftColumnWidth + heartbeatTrackWidth

  return (
    <div className="p-3 overflow-x-auto overscroll-x-contain" style={{ WebkitOverflowScrolling: 'touch' }}>
      <div
        className="rounded-lg border border-border-primary bg-surface-primary"
        style={{ width: chartWidth, minWidth: '100%' }}
      >
        <div
          className="grid border-b border-border-primary bg-surface-secondary"
          style={{ gridTemplateColumns: `${leftColumnWidth}px ${heartbeatTrackWidth}px` }}
        >
          <div className="sticky left-0 z-20 border-r border-border-primary bg-surface-secondary px-4 py-3 text-xs font-semibold text-text-secondary">镖单 / 弟子</div>
          <div className="grid" style={{ gridTemplateColumns: `repeat(${heartbeatCount}, ${heartbeatColumnWidth}px)` }}>
            {columns.map(({ key, label, cycle }) => {
              const worker = cycle?.workerId != null ? workerMap.get(cycle.workerId) : undefined
              return (
                <div key={key} className="border-l border-border-primary px-3 py-2">
                  <div className="text-xs font-semibold text-text-primary">{label}</div>
                  <div className="mt-1 flex items-center gap-1.5 text-[11px] text-text-muted">
                    <span>{formatCycleTime(cycle)}</span>
                    {cycle && (
                      <span className={`rounded-full px-1.5 py-0.5 ${cycleStatusTone(cycle.status)}`}>
                        {cycleStatusLabel(cycle.status)}
                      </span>
                    )}
                  </div>
                  {worker && (
                    <div className="mt-1 truncate text-[11px] text-text-muted">{worker.name}</div>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        <div className="divide-y divide-border-primary">
          {tasks.map((task, index) => {
            const run = runningByTaskId.get(task.id)
            const worker = task.workerId != null ? workerMap.get(task.workerId) : undefined
            const taskCycles = task.workerId != null
              ? columns.map(column => column.cycle).filter((cycle): cycle is WorkerCycle => cycle?.workerId === task.workerId)
              : []
            const firstCycleIndex = taskCycles.length > 0
              ? columns.findIndex(column => column.cycle?.id === taskCycles[0].id)
              : -1
            const rawSpan = taskCycles.length > 0 ? taskCycles.length : fallbackHeartbeatCount(task, run)
            const span = clampNumber(rawSpan, 1, heartbeatCount)
            const fallbackStart = task.status === 'completed'
              ? 0
              : task.status === 'paused'
                ? 0
                : index % Math.max(1, heartbeatCount - span + 1)
            const start = clampNumber(firstCycleIndex >= 0 ? firstCycleIndex : fallbackStart, 0, Math.max(0, heartbeatCount - span))
            const statusClass = task.status === 'paused'
              ? 'bg-status-warning-bg/80 border-status-warning/30'
              : task.status === 'completed'
                ? 'bg-status-success-bg/80 border-status-success/30'
                : 'bg-interactive-bg/80 border-interactive/30'

            return (
              <div
                key={task.id}
                className="grid min-h-[92px] bg-surface-primary"
                style={{ gridTemplateColumns: `${leftColumnWidth}px ${heartbeatTrackWidth}px` }}
              >
                <div className="sticky left-0 z-10 min-w-0 border-r border-border-primary bg-surface-primary px-4 py-3">
                  <div className="text-sm font-semibold text-text-primary truncate">{task.name}</div>
                  <div className="mt-1 text-xs text-text-muted truncate">{worker?.name ?? '未分派'} · {statusLabel(task.status)}</div>
                  <div className="mt-2 text-[11px] text-text-muted truncate">{taskEta(task)}</div>
                </div>
                <div className="relative">
                  <div className="grid h-full" style={{ gridTemplateColumns: `repeat(${heartbeatCount}, ${heartbeatColumnWidth}px)` }}>
                    {columns.map((column, columnIndex) => {
                      const active = columnIndex >= start && columnIndex < start + span
                      const activeOffset = columnIndex - start
                      const cycle = active ? taskCycles[activeOffset] : undefined
                      return (
                        <div key={`${task.id}-${column.key}`} className="relative border-l border-border-primary px-2 py-3">
                          {active && (
                            <div className="relative z-10 rounded-lg bg-surface-primary/80 px-2 py-1 text-[11px] leading-snug text-text-secondary shadow-sm">
                              {heartbeatWorkLabel(task, cycle, run, activeOffset, span)}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                  <div
                    className={`pointer-events-none absolute top-5 bottom-5 rounded-lg border ${statusClass} transition-all duration-500`}
                    style={{
                      left: `calc(${(start / heartbeatCount) * 100}% + 8px)`,
                      width: `calc(${(span / heartbeatCount) * 100}% - 16px)`,
                    }}
                  />
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function FlowCard({
  task,
  worker,
  run,
  index,
  total,
  workers,
  onAssignWorker,
  onMove,
  onEdit,
}: {
  task: Task
  worker?: Worker
  run?: TaskRun
  index: number
  total: number
  workers: Worker[]
  onAssignWorker: (taskId: number, workerId: number | null) => void
  onMove: (taskId: number, direction: -1 | 1) => void
  onEdit: (task: Task) => void
}): React.JSX.Element {
  const progress = taskProgressPercent(task, run)
  const statusColor = task.status === 'completed'
    ? 'bg-status-success'
    : task.status === 'paused'
      ? 'bg-status-warning'
      : task.status === 'error'
        ? 'bg-status-error'
        : 'bg-interactive'

  return (
    <div className="relative min-w-[236px] max-w-[236px] rounded-lg border border-border-primary bg-surface-secondary p-3 shadow-sm">
      <div className={`absolute -left-1 top-4 h-2.5 w-2.5 rounded-full ${statusColor}`} />
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-text-primary truncate">{task.name}</div>
          <div className="mt-0.5 text-[11px] text-text-muted truncate">{worker?.name ?? '未分派弟子'}</div>
        </div>
        <span className="shrink-0 text-[11px] text-text-muted">{statusLabel(task.status)}</span>
      </div>
      <div className="mt-2 h-1.5 rounded-full bg-surface-tertiary overflow-hidden">
        <div className={`h-full rounded-full ${statusColor} transition-[width] duration-500`} style={{ width: `${progress}%` }} />
      </div>
      <div className="mt-2 space-y-1 text-[11px] leading-relaxed text-text-muted">
        <div><span className="text-text-secondary">上游：</span>{taskUpstream(task)}</div>
        <div><span className="text-text-secondary">下游：</span>{taskDownstream(task)}</div>
        <div><span className="text-text-secondary">格式：</span>{taskOutputFormat(task)}</div>
        <div><span className="text-text-secondary">进展：</span>{compactText(taskProgress(task, run), 86)}</div>
      </div>
      <div className="mt-3 border-t border-border-primary pt-2">
        <Select
          value={String(task.workerId ?? '')}
          onChange={(value) => onAssignWorker(task.id, value ? Number(value) : null)}
          variant="inline"
          className="w-full text-xs"
          placeholder="选择弟子"
          options={[
            { value: '', label: '未分派' },
            ...workers.map(item => ({ value: String(item.id), label: item.name }))
          ]}
        />
        <div className="mt-2 flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => onMove(task.id, -1)}
            disabled={index === 0}
            className="rounded-lg border border-border-primary px-2 py-1 text-[11px] text-text-secondary disabled:opacity-40"
          >
            前移
          </button>
          <button
            type="button"
            onClick={() => onMove(task.id, 1)}
            disabled={index >= total - 1}
            className="rounded-lg border border-border-primary px-2 py-1 text-[11px] text-text-secondary disabled:opacity-40"
          >
            后移
          </button>
          <button
            type="button"
            onClick={() => onEdit(task)}
            className="ml-auto rounded-lg bg-interactive-bg px-2 py-1 text-[11px] text-interactive"
          >
            调整交接
          </button>
        </div>
      </div>
    </div>
  )
}

function SwimlaneFlowView({
  tasks,
  workers,
  workerMap,
  runningByTaskId,
  onAssignWorker,
  onUpdateFlow,
  onFlowRepaired,
}: {
  tasks: Task[]
  workers: Worker[]
  workerMap: Map<number, Worker>
  runningByTaskId: Map<number, TaskRun>
  onAssignWorker: (taskId: number, workerId: number | null) => Promise<void>
  onUpdateFlow: (task: Task, patch: TaskFlowPatch) => Promise<void>
  onFlowRepaired: () => void
}): React.JSX.Element {
  const [editingTask, setEditingTask] = useState<Task | null>(null)
  const [draftUpstream, setDraftUpstream] = useState('')
  const [draftDownstream, setDraftDownstream] = useState('')
  const [draftOutputFormat, setDraftOutputFormat] = useState('')
  const [draftRelation, setDraftRelation] = useState<TaskFlowRelation>('sequential')
  const [draftDependsOn, setDraftDependsOn] = useState('')
  const [draftParallelGroup, setDraftParallelGroup] = useState('')
  const [draftOptimizationGoal, setDraftOptimizationGoal] = useState('')
  const [draftRelationReason, setDraftRelationReason] = useState('')
  const [draftCondition, setDraftCondition] = useState('')
  const [draftJoinPolicy, setDraftJoinPolicy] = useState('')
  const [draftReworkTarget, setDraftReworkTarget] = useState('')
  const [savingTaskId, setSavingTaskId] = useState<number | null>(null)
  const [flowFeedback, setFlowFeedback] = useState('')
  const [flowFeedbackBusy, setFlowFeedbackBusy] = useState(false)
  const [flowFeedbackNotice, setFlowFeedbackNotice] = useState('')
  const orderedTasks = [...tasks].sort((a, b) => {
    const indexA = tasks.findIndex(task => task.id === a.id)
    const indexB = tasks.findIndex(task => task.id === b.id)
    const orderA = taskFlowOrder(a, indexA)
    const orderB = taskFlowOrder(b, indexB)
    if (orderA !== orderB) return orderA - orderB
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  })
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(orderedTasks[0]?.id ?? null)
  const workerIdsInTasks = new Set(orderedTasks.map(task => task.workerId).filter((id): id is number => id != null))
  const laneWorkers = workers.filter(worker => workerIdsInTasks.has(worker.id))
  const hasUnassigned = orderedTasks.some(task => task.workerId == null || !workerMap.has(task.workerId))
  const lanes: Array<{ key: string; title: string; subtitle: string; worker?: Worker }> = [
    ...laneWorkers.map(worker => ({
      key: `worker-${worker.id}`,
      title: worker.name,
      subtitle: worker.role ?? '弟子',
      worker,
    })),
    ...(hasUnassigned ? [{ key: 'unassigned', title: '未分派', subtitle: '等待帮主安排' }] : []),
  ]

  if (lanes.length === 0) {
    lanes.push({ key: 'empty', title: '暂无弟子泳道', subtitle: '等待帮主从客栈调入弟子' })
  }

  const taskIds = new Set(orderedTasks.map(task => task.id))
  const flowSpecs = new Map(orderedTasks.map(task => [task.id, parseTaskFlowSpec(task)]))
  const laneIndexByKey = new Map(lanes.map((lane, index) => [lane.key, index]))
  const laneKeyForTask = (task: Task): string => {
    if (task.workerId != null && workerMap.has(task.workerId)) return `worker-${task.workerId}`
    return hasUnassigned ? 'unassigned' : lanes[0]?.key ?? 'empty'
  }
  const stageValues = [...new Set(orderedTasks.map((task, index) => taskFlowOrder(task, index)))].sort((a, b) => a - b)
  const stageIndexByOrder = new Map(stageValues.map((order, index) => [order, index]))
  const previousStageTasks = (task: Task, fallbackIndex: number): Task[] => {
    const order = taskFlowOrder(task, fallbackIndex)
    const previousOrder = [...stageValues].reverse().find(candidate => candidate < order)
    if (previousOrder == null) return []
    return orderedTasks.filter((candidate, candidateIndex) => taskFlowOrder(candidate, candidateIndex) === previousOrder)
  }
  const flowEdges: Array<{ fromId: number; toId: number; relation: TaskFlowRelation; label: string; dashed?: boolean }> = []
  orderedTasks.forEach((task, index) => {
    const spec = flowSpecs.get(task.id) ?? parseTaskFlowSpec(task)
    const reworkTargets = dependencyIds(spec.reworkTarget, taskIds)
    if (spec.relation === 'rework' && reworkTargets.length > 0) {
      for (const targetId of reworkTargets) {
        flowEdges.push({ fromId: task.id, toId: targetId, relation: 'rework', label: '返工', dashed: true })
      }
      return
    }

    const explicitDeps = dependencyIds(spec.dependsOn, taskIds).filter(id => id !== task.id)
    const deps = explicitDeps.length > 0
      ? explicitDeps
      : spec.relation === 'join'
        ? previousStageTasks(task, index).map(item => item.id)
        : orderedTasks[index - 1]
          ? [orderedTasks[index - 1].id]
          : []
    for (const fromId of deps) {
      flowEdges.push({
        fromId,
        toId: task.id,
        relation: spec.relation,
        label: taskFlowRelationLabel(spec.relation),
        dashed: spec.relation === 'conditional',
      })
    }
  })

  const idsKey = orderedTasks.map(task => task.id).join(',')
  useEffect(() => {
    if (orderedTasks.length === 0) {
      setSelectedTaskId(null)
      return
    }
    if (selectedTaskId == null || !orderedTasks.some(task => task.id === selectedTaskId)) {
      setSelectedTaskId(orderedTasks[0].id)
    }
  }, [idsKey, orderedTasks, selectedTaskId])

  const selectedTask = orderedTasks.find(task => task.id === selectedTaskId) ?? orderedTasks[0] ?? null
  const selectedIndex = selectedTask ? orderedTasks.findIndex(task => task.id === selectedTask.id) : -1
  const selectedWorker = selectedTask?.workerId != null ? workerMap.get(selectedTask.workerId) : undefined
  const selectedRun = selectedTask ? runningByTaskId.get(selectedTask.id) : undefined
  const nodeWidth = 230
  const nodeHeight = 82
  const xGap = 112
  const yGap = 34
  const canvasWidth = Math.max(760, Math.max(stageValues.length, 1) * (nodeWidth + xGap) + 88)
  const canvasHeight = Math.max(220, lanes.length * (nodeHeight + yGap) + 92)
  const nodePosById = new Map<number, { x: number; y: number }>()
  orderedTasks.forEach((task, index) => {
    const order = taskFlowOrder(task, index)
    const stageIndex = stageIndexByOrder.get(order) ?? index
    const laneIndex = laneIndexByKey.get(laneKeyForTask(task)) ?? 0
    nodePosById.set(task.id, {
      x: 44 + stageIndex * (nodeWidth + xGap),
      y: 54 + laneIndex * (nodeHeight + yGap),
    })
  })
  const nodeStatusClass = (task: Task, selected: boolean): string => {
    if (selected) return 'bg-interactive text-text-invert border-interactive shadow-lg shadow-black/20'
    if (task.status === 'completed') return 'bg-status-success-bg text-status-success border-status-success/30'
    if (task.status === 'paused') return 'bg-status-warning-bg text-status-warning border-status-warning/30'
    if (task.status === 'error') return 'bg-status-error-bg text-status-error border-status-error/30'
    return 'bg-surface-secondary text-text-primary border-border-primary hover:border-interactive/50 hover:bg-surface-hover'
  }

  function openEdit(item: Task): void {
    const spec = parseTaskFlowSpec(item)
    setEditingTask(item)
    setDraftUpstream(spec.upstream || taskUpstream(item))
    setDraftDownstream(spec.downstream || taskDownstream(item))
    setDraftOutputFormat(spec.outputFormat || taskOutputFormat(item))
    setDraftRelation(spec.relation)
    setDraftDependsOn(spec.dependsOn)
    setDraftParallelGroup(spec.parallelGroup)
    setDraftOptimizationGoal(spec.optimizationGoal)
    setDraftRelationReason(spec.relationReason)
    setDraftCondition(spec.condition)
    setDraftJoinPolicy(spec.joinPolicy)
    setDraftReworkTarget(spec.reworkTarget)
  }

  function moveTask(taskId: number, direction: -1 | 1): void {
    const currentIndex = orderedTasks.findIndex(item => item.id === taskId)
    const other = orderedTasks[currentIndex + direction]
    const current = orderedTasks[currentIndex]
    if (!current || !other) return
    setSavingTaskId(taskId)
    void Promise.all([
      onUpdateFlow(current, { order: currentIndex + direction + 1 }),
      onUpdateFlow(other, { order: currentIndex + 1 }),
    ]).finally(() => setSavingTaskId(null))
  }

  async function sendFlowFeedback(): Promise<void> {
    const issue = flowFeedback.trim()
    if (!issue || flowFeedbackBusy) return
    const roomId = tasks.find(task => task.roomId != null)?.roomId ?? null
    setFlowFeedbackBusy(true)
    setFlowFeedbackNotice('')
    try {
      const result = await api.clerk.send([
        '协作流程出错，请天机阁体检并修复。',
        roomId != null ? `帮派ID：${roomId}` : '',
        `用户反馈：${issue}`,
        '要求：先调用 company_repair_task_flow 修复流程，再说明改了什么、哪些还需要帮主继续处理。'
      ].filter(Boolean).join('\n'))
      setFlowFeedback('')
      setFlowFeedbackNotice(result.response || '已把流程问题交给天机阁处理。')
      onFlowRepaired()
    } catch (err) {
      setFlowFeedbackNotice(err instanceof Error ? err.message : '反馈天机阁失败')
    } finally {
      setFlowFeedbackBusy(false)
    }
  }

  return (
    <div className="p-3">
      <div className="mb-3 rounded-lg border border-border-primary bg-surface-secondary p-3">
        <div className="flex flex-col gap-2 lg:flex-row lg:items-end">
          <label className="min-w-0 flex-1 text-xs font-medium text-text-muted">
            流程出错反馈
            <textarea
              value={flowFeedback}
              onChange={(event) => setFlowFeedback(event.target.value)}
              rows={2}
              placeholder="例如：判断节点连错了、某个弟子没有上游输入、审核节点不该接到报告整合..."
              className="mt-1 w-full resize-y rounded-lg border border-border-primary bg-surface-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-text-muted focus:outline-none"
            />
          </label>
          <button
            type="button"
            onClick={() => { void sendFlowFeedback() }}
            disabled={!flowFeedback.trim() || flowFeedbackBusy}
            className="rounded-lg bg-interactive px-3 py-2 text-sm text-text-invert hover:bg-interactive-hover disabled:opacity-50"
          >
            {flowFeedbackBusy ? '天机阁修复中...' : '交给天机阁修复'}
          </button>
        </div>
        {flowFeedbackNotice && (
          <div className="mt-2 max-h-28 overflow-y-auto whitespace-pre-wrap rounded-lg bg-surface-primary px-3 py-2 text-xs leading-5 text-text-muted">
            {flowFeedbackNotice}
          </div>
        )}
      </div>
      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="overflow-x-auto rounded-lg border border-border-primary bg-gradient-to-br from-surface-primary to-surface-secondary/80">
          {orderedTasks.length === 0 ? (
            <div className="p-8 text-center text-sm text-text-muted">暂无可展示流程。</div>
          ) : (
            <div className="relative" style={{ width: canvasWidth, height: canvasHeight }}>
              <svg className="absolute inset-0" width={canvasWidth} height={canvasHeight} viewBox={`0 0 ${canvasWidth} ${canvasHeight}`} aria-hidden="true">
                <defs>
                  <marker id="task-flow-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                    <path d="M0,0 L8,4 L0,8 Z" fill="var(--interactive)" opacity="0.85" />
                  </marker>
                </defs>
                {flowEdges.map((edge) => {
                  const from = nodePosById.get(edge.fromId)
                  const to = nodePosById.get(edge.toId)
                  if (!from || !to) return null
                  const startX = from.x + nodeWidth - 2
                  const startY = from.y + nodeHeight / 2
                  const endX = to.x + 2
                  const endY = to.y + nodeHeight / 2
                  const mid = Math.max(54, Math.abs(endX - startX) / 2)
                  const stroke = relationStroke(edge.relation)
                  const path = endX >= startX
                    ? `M ${startX} ${startY} C ${startX + mid} ${startY}, ${endX - mid} ${endY}, ${endX} ${endY}`
                    : `M ${from.x + 2} ${startY} C ${from.x - mid} ${startY}, ${to.x + nodeWidth + mid} ${endY}, ${to.x + nodeWidth - 2} ${endY}`
                  return (
                    <g key={`edge-${edge.fromId}-${edge.toId}-${edge.relation}`}>
                      <path
                        d={path}
                        fill="none"
                        stroke={stroke}
                        strokeWidth="3"
                        strokeLinecap="round"
                        strokeDasharray={edge.dashed ? '8 7' : undefined}
                        markerEnd="url(#task-flow-arrow)"
                        opacity="0.72"
                      />
                      {edge.relation !== 'sequential' && (
                        <text
                          x={(startX + endX) / 2}
                          y={(startY + endY) / 2 - 8}
                          fill={stroke}
                          fontSize="12"
                          fontWeight="600"
                        >
                          {edge.label}
                        </text>
                      )}
                    </g>
                  )
                })}
              </svg>

              {orderedTasks.map((task, index) => {
                const worker = task.workerId != null ? workerMap.get(task.workerId) : undefined
                const run = runningByTaskId.get(task.id)
                const progress = taskProgressPercent(task, run)
                const selected = selectedTask?.id === task.id
                const spec = flowSpecs.get(task.id) ?? parseTaskFlowSpec(task)
                const isDecisionNode = isDecisionTaskFlowRelation(spec.relation)
                const pos = nodePosById.get(task.id) ?? { x: 24 + index * (nodeWidth + xGap), y: 54 }
                return (
                  <button
                    key={task.id}
                    type="button"
                    onClick={() => setSelectedTaskId(task.id)}
                    aria-label={`${task.name}，${isDecisionNode ? '判断节点' : '执行节点'}，${taskFlowRelationLabel(spec.relation)}`}
                    className={`absolute flex h-[82px] w-[230px] items-center gap-3 border px-4 text-left transition-all ${
                      isDecisionNode
                        ? 'justify-center px-8'
                        : 'rounded-[22px]'
                    } ${nodeStatusClass(task, selected)}`}
                    style={{
                      left: pos.x,
                      top: pos.y,
                      ...(isDecisionNode ? { clipPath: 'polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)' } : {}),
                    }}
                  >
                    <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${selected ? 'bg-white/15' : 'bg-surface-primary/70'} ${isDecisionNode ? 'hidden' : ''}`}>
                      <svg width="24" height="24" viewBox="0 0 24 24">
                        <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeOpacity="0.28" strokeWidth="3" />
                        <circle
                          cx="12"
                          cy="12"
                          r="8"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="3"
                          strokeLinecap="round"
                          strokeDasharray={`${Math.max(6, progress * 0.5)} 50`}
                          transform="rotate(-90 12 12)"
                        />
                      </svg>
                    </span>
                    <span className={isDecisionNode ? 'min-w-0 max-w-[150px] text-center' : 'min-w-0 flex-1'}>
                      <span className="block truncate text-sm font-semibold">{task.name}</span>
                      <span className={`mt-1 block truncate text-xs ${selected ? 'text-text-invert/80' : 'text-text-muted'}`}>
                        {worker?.name ?? '未分派'} · {statusLabel(task.status)}
                      </span>
                      <span className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-[11px] ${selected ? 'bg-white/15 text-text-invert' : relationPillClass(spec.relation)}`}>
                        {taskFlowRelationLabel(spec.relation)}
                      </span>
                    </span>
                    <span className={`shrink-0 ${selected ? 'text-text-invert/90' : 'text-interactive'} ${isDecisionNode ? 'hidden' : ''}`}>
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M10 13a5 5 0 0 0 7.07 0l2.12-2.12a5 5 0 0 0-7.07-7.07L11 4.93" />
                        <path d="M14 11a5 5 0 0 0-7.07 0L4.81 13.12a5 5 0 0 0 7.07 7.07L13 19.07" />
                      </svg>
                    </span>
                    {savingTaskId === task.id && (
                      <span className="absolute -bottom-6 left-4 rounded-full border border-interactive/30 bg-surface-primary px-2 py-0.5 text-[11px] text-interactive">
                        保存中...
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          )}
        </div>

        <aside className="rounded-lg border border-border-primary bg-surface-secondary p-4">
          {selectedTask ? (
            <>
              {(() => {
                const selectedSpec = flowSpecs.get(selectedTask.id) ?? parseTaskFlowSpec(selectedTask)
                return (
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-text-primary">节点详情</div>
                  <div className="mt-1 truncate text-base font-semibold text-text-primary">{selectedTask.name}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-text-muted">
                    <span>第 {selectedIndex + 1} 步</span>
                    <span>{statusLabel(selectedTask.status)}</span>
                    <span className={`rounded-full px-2 py-0.5 ${relationPillClass(selectedSpec.relation)}`}>{taskFlowRelationLabel(selectedSpec.relation)}</span>
                  </div>
                </div>
                <span className="rounded-lg bg-surface-tertiary px-2 py-1 text-xs text-text-secondary">
                  {taskProgressPercent(selectedTask, selectedRun)}%
                </span>
              </div>
                )
              })()}

              <div className="mt-4">
                <div className="text-xs font-medium text-text-muted">负责人</div>
                <Select
                  value={String(selectedTask.workerId ?? '')}
                  onChange={(value) => {
                    setSavingTaskId(selectedTask.id)
                    void onAssignWorker(selectedTask.id, value ? Number(value) : null).finally(() => setSavingTaskId(null))
                  }}
                  className="mt-1 w-full text-sm"
                  placeholder="选择弟子"
                  options={[
                    { value: '', label: '未分派' },
                    ...workers.map(item => ({ value: String(item.id), label: item.name }))
                  ]}
                />
                {selectedWorker && <div className="mt-1 text-xs text-text-muted">{selectedWorker.role || '弟子'}</div>}
              </div>

              <div className="mt-4 space-y-3 text-sm">
                <div>
                  <div className="text-xs font-medium text-text-muted">正在解决</div>
                  <div className="mt-1 text-text-secondary">{taskProblem(selectedTask)}</div>
                </div>
                <div>
                  <div className="text-xs font-medium text-text-muted">当前进展</div>
                  <div className="mt-1 text-text-secondary">{taskProgress(selectedTask, selectedRun)}</div>
                </div>
                <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-1">
                  {(() => {
                    const selectedSpec = flowSpecs.get(selectedTask.id) ?? parseTaskFlowSpec(selectedTask)
                    return (
                      <>
                        <div className="rounded-lg bg-surface-primary p-3">
                          <div className="text-xs font-medium text-text-muted">逻辑关系</div>
                          <div className="mt-1 text-text-secondary">{taskFlowRelationLabel(selectedSpec.relation)}</div>
                          {(selectedSpec.dependsOn || selectedSpec.parallelGroup || selectedSpec.optimizationGoal || selectedSpec.relationReason || selectedSpec.condition || selectedSpec.joinPolicy || selectedSpec.reworkTarget) && (
                            <div className="mt-2 space-y-1 text-xs text-text-muted">
                              {selectedSpec.dependsOn && <div>依赖：{selectedSpec.dependsOn}</div>}
                              {selectedSpec.parallelGroup && <div>并行组：{selectedSpec.parallelGroup}</div>}
                              {selectedSpec.optimizationGoal && <div>优化：{selectedSpec.optimizationGoal}</div>}
                              {selectedSpec.relationReason && <div>依据：{selectedSpec.relationReason}</div>}
                              {selectedSpec.condition && <div>条件：{selectedSpec.condition}</div>}
                              {selectedSpec.joinPolicy && <div>汇合：{selectedSpec.joinPolicy}</div>}
                              {selectedSpec.reworkTarget && <div>返工：{selectedSpec.reworkTarget}</div>}
                            </div>
                          )}
                          {selectedSpec.relation !== 'sequential' && !selectedSpec.optimizationGoal && !selectedSpec.relationReason && (
                            <div className="mt-2 rounded-lg bg-status-warning-bg px-2 py-1 text-xs text-status-warning">
                              缺少业务依据；请说明这样安排是为了提速、提质、控风险还是降成本。
                            </div>
                          )}
                        </div>
                      </>
                    )
                  })()}
                  <div className="rounded-lg bg-surface-primary p-3">
                    <div className="text-xs font-medium text-text-muted">上游输入</div>
                    <div className="mt-1 text-text-secondary">{taskUpstream(selectedTask)}</div>
                  </div>
                  <div className="rounded-lg bg-surface-primary p-3">
                    <div className="text-xs font-medium text-text-muted">下游接收</div>
                    <div className="mt-1 text-text-secondary">{taskDownstream(selectedTask)}</div>
                  </div>
                  <div className="rounded-lg bg-surface-primary p-3">
                    <div className="text-xs font-medium text-text-muted">输出格式</div>
                    <div className="mt-1 text-text-secondary">{taskOutputFormat(selectedTask)}</div>
                  </div>
                  <div className="rounded-lg bg-surface-primary p-3">
                    <div className="text-xs font-medium text-text-muted">困难 / 预计完成</div>
                    <div className="mt-1 text-text-secondary">{taskBlocker(selectedTask)} · {taskEta(selectedTask)}</div>
                  </div>
                </div>
                {selectedTask.lastResult && (
                  <div>
                    <div className="text-xs font-medium text-text-muted">最近结果</div>
                    <div className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap rounded-lg bg-surface-primary p-3 text-xs leading-5 text-text-muted">
                      {selectedTask.lastResult}
                    </div>
                  </div>
                )}
              </div>

              <div className="mt-4 flex flex-wrap gap-2 border-t border-border-primary pt-3">
                <button
                  type="button"
                  onClick={() => moveTask(selectedTask.id, -1)}
                  disabled={selectedIndex <= 0}
                  className="rounded-lg border border-border-primary px-3 py-2 text-xs text-text-secondary disabled:opacity-40"
                >
                  前移
                </button>
                <button
                  type="button"
                  onClick={() => moveTask(selectedTask.id, 1)}
                  disabled={selectedIndex < 0 || selectedIndex >= orderedTasks.length - 1}
                  className="rounded-lg border border-border-primary px-3 py-2 text-xs text-text-secondary disabled:opacity-40"
                >
                  后移
                </button>
                <button
                  type="button"
                  onClick={() => openEdit(selectedTask)}
                  className="rounded-lg bg-interactive px-3 py-2 text-xs text-text-invert"
                >
                  调整交接
                </button>
              </div>
            </>
          ) : (
            <div className="text-sm text-text-muted">选择一个节点查看详情。</div>
          )}
        </aside>
      </div>

      {false && (
      <div className="overflow-x-auto rounded-lg border border-border-primary bg-surface-primary">
        <div className="min-w-max">
          <div
            className="grid border-b border-border-primary bg-surface-secondary"
            style={{ gridTemplateColumns: `160px repeat(${Math.max(orderedTasks.length, 1)}, 256px)` }}
          >
            <div className="sticky left-0 z-10 bg-surface-secondary px-3 py-2 text-xs font-semibold text-text-muted border-r border-border-primary">
              弟子泳道
            </div>
            {orderedTasks.length > 0 ? orderedTasks.map((task, index) => (
              <div key={task.id} className="px-3 py-2 text-xs text-text-muted border-r border-border-primary last:border-r-0">
                第 {index + 1} 步 · {compactText(task.name, 20)}
              </div>
            )) : (
              <div className="px-3 py-2 text-xs text-text-muted">暂无镖单</div>
            )}
          </div>
          {lanes.map((lane) => (
            <div
              key={lane.key}
              className="grid border-b border-border-primary last:border-b-0"
              style={{ gridTemplateColumns: `160px repeat(${Math.max(orderedTasks.length, 1)}, 256px)` }}
            >
              <div className="sticky left-0 z-10 bg-surface-primary border-r border-border-primary px-3 py-4">
                <div className="text-sm font-semibold text-text-secondary">{lane.title}</div>
                <div className="mt-0.5 text-xs text-text-muted">{lane.subtitle}</div>
              </div>
              {orderedTasks.length > 0 ? orderedTasks.map((task, index) => {
                const belongsToLane = lane.worker
                  ? task.workerId === lane.worker.id
                  : task.workerId == null || (lane.key === 'unassigned' && !workerMap.has(task.workerId))
                const worker = task.workerId != null ? workerMap.get(task.workerId) : undefined
                return (
                  <div key={task.id} className="relative min-h-[220px] border-r border-border-primary last:border-r-0 p-3">
                    {index < orderedTasks.length - 1 && (
                      <div className="absolute right-[-10px] top-1/2 z-0 hidden h-px w-5 bg-border-primary md:block" />
                    )}
                    {belongsToLane ? (
                      <FlowCard
                        task={task}
                        worker={worker}
                        run={runningByTaskId.get(task.id)}
                        index={index}
                        total={orderedTasks.length}
                        workers={workers}
                        onAssignWorker={(taskId, workerId) => {
                          setSavingTaskId(taskId)
                          void onAssignWorker(taskId, workerId).finally(() => setSavingTaskId(null))
                        }}
                        onMove={(taskId, direction) => {
                          const currentIndex = orderedTasks.findIndex(item => item.id === taskId)
                          const other = orderedTasks[currentIndex + direction]
                          const current = orderedTasks[currentIndex]
                          if (!current || !other) return
                          setSavingTaskId(taskId)
                          void Promise.all([
                            onUpdateFlow(current, { order: currentIndex + direction + 1 }),
                            onUpdateFlow(other, { order: currentIndex + 1 }),
                          ]).finally(() => setSavingTaskId(null))
                        }}
                        onEdit={(item) => {
                          const spec = parseTaskFlowSpec(item)
                          setEditingTask(item)
                          setDraftUpstream(spec.upstream || taskUpstream(item))
                          setDraftDownstream(spec.downstream || taskDownstream(item))
                          setDraftOutputFormat(spec.outputFormat || taskOutputFormat(item))
                        }}
                      />
                    ) : (
                      <div className="h-full rounded-lg border border-dashed border-border-primary/70 bg-surface-secondary/30" />
                    )}
                    {savingTaskId === task.id && (
                      <div className="absolute inset-x-3 bottom-3 rounded-lg border border-interactive/30 bg-surface-primary px-2 py-1 text-center text-[11px] text-interactive">
                        正在保存流程调整...
                      </div>
                    )}
                  </div>
                )
              }) : (
                <div className="min-h-[140px] p-3 text-sm text-text-muted">暂无可展示流程。</div>
              )}
            </div>
          ))}
        </div>
      </div>
      )}
      {editingTask && (
        <div className="mt-3 rounded-lg border border-border-primary bg-surface-secondary p-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="text-sm font-semibold text-text-primary">调整交接约束</div>
              <div className="mt-0.5 text-xs text-text-muted">{editingTask.name}</div>
            </div>
            <button
              type="button"
              onClick={() => setEditingTask(null)}
              className="rounded-lg border border-border-primary px-2 py-1 text-xs text-text-muted"
            >
              关闭
            </button>
          </div>
          <div className="mt-3 grid gap-2 md:grid-cols-3">
            <label className="text-xs text-text-muted">
              逻辑关系
              <select
                value={draftRelation}
                onChange={(event) => setDraftRelation(event.target.value as TaskFlowRelation)}
                className="mt-1 w-full rounded-lg border border-border-primary bg-surface-primary px-2 py-1.5 text-sm text-text-primary"
              >
                {TASK_FLOW_RELATION_OPTIONS.map(option => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <label className="text-xs text-text-muted">
              依赖节点
              <input
                value={draftDependsOn}
                onChange={(event) => setDraftDependsOn(event.target.value)}
                placeholder="#12, #13 或节点名称"
                className="mt-1 w-full rounded-lg border border-border-primary bg-surface-primary px-2 py-1.5 text-sm text-text-primary"
              />
            </label>
            <label className="text-xs text-text-muted">
              并行组
              <input
                value={draftParallelGroup}
                onChange={(event) => setDraftParallelGroup(event.target.value)}
                placeholder="例如：竞品与评论并行"
                className="mt-1 w-full rounded-lg border border-border-primary bg-surface-primary px-2 py-1.5 text-sm text-text-primary"
              />
            </label>
            <label className="text-xs text-text-muted">
              优化目标
              <input
                value={draftOptimizationGoal}
                onChange={(event) => setDraftOptimizationGoal(event.target.value)}
                placeholder="例如：提速、提质、控风险、降成本"
                className="mt-1 w-full rounded-lg border border-border-primary bg-surface-primary px-2 py-1.5 text-sm text-text-primary"
              />
            </label>
            <label className="text-xs text-text-muted">
              关系依据
              <input
                value={draftRelationReason}
                onChange={(event) => setDraftRelationReason(event.target.value)}
                placeholder="说明为什么这样安排更好"
                className="mt-1 w-full rounded-lg border border-border-primary bg-surface-primary px-2 py-1.5 text-sm text-text-primary"
              />
            </label>
            <label className="text-xs text-text-muted">
              触发条件
              <input
                value={draftCondition}
                onChange={(event) => setDraftCondition(event.target.value)}
                placeholder="例如：样本通过核验后"
                className="mt-1 w-full rounded-lg border border-border-primary bg-surface-primary px-2 py-1.5 text-sm text-text-primary"
              />
            </label>
            <label className="text-xs text-text-muted">
              汇合规则
              <input
                value={draftJoinPolicy}
                onChange={(event) => setDraftJoinPolicy(event.target.value)}
                placeholder="例如：全部上游验收通过"
                className="mt-1 w-full rounded-lg border border-border-primary bg-surface-primary px-2 py-1.5 text-sm text-text-primary"
              />
            </label>
            <label className="text-xs text-text-muted">
              返工节点
              <input
                value={draftReworkTarget}
                onChange={(event) => setDraftReworkTarget(event.target.value)}
                placeholder="例如：#12"
                className="mt-1 w-full rounded-lg border border-border-primary bg-surface-primary px-2 py-1.5 text-sm text-text-primary"
              />
            </label>
            <label className="text-xs text-text-muted">
              上游输入
              <input
                value={draftUpstream}
                onChange={(event) => setDraftUpstream(event.target.value)}
                className="mt-1 w-full rounded-lg border border-border-primary bg-surface-primary px-2 py-1.5 text-sm text-text-primary"
              />
            </label>
            <label className="text-xs text-text-muted">
              下游接收方
              <input
                value={draftDownstream}
                onChange={(event) => setDraftDownstream(event.target.value)}
                className="mt-1 w-full rounded-lg border border-border-primary bg-surface-primary px-2 py-1.5 text-sm text-text-primary"
              />
            </label>
            <label className="text-xs text-text-muted">
              输出格式
              <input
                value={draftOutputFormat}
                onChange={(event) => setDraftOutputFormat(event.target.value)}
                className="mt-1 w-full rounded-lg border border-border-primary bg-surface-primary px-2 py-1.5 text-sm text-text-primary"
              />
            </label>
          </div>
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              onClick={() => {
                setSavingTaskId(editingTask.id)
                void onUpdateFlow(editingTask, {
                  upstream: draftUpstream,
                  downstream: draftDownstream,
                  outputFormat: draftOutputFormat,
                  relation: draftRelation,
                  dependsOn: draftDependsOn,
                  parallelGroup: draftParallelGroup,
                  optimizationGoal: draftOptimizationGoal,
                  relationReason: draftRelationReason,
                  condition: draftCondition,
                  joinPolicy: draftJoinPolicy,
                  reworkTarget: draftReworkTarget,
                }).then(() => setEditingTask(null)).finally(() => setSavingTaskId(null))
              }}
              className="rounded-lg bg-interactive px-3 py-1.5 text-sm text-text-invert"
            >
              保存交接
            </button>
          </div>
        </div>
      )}
    </div>
  )
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

interface TasksPanelProps {
  roomId?: number | null
  autonomyMode: 'semi'
  initialView?: TaskViewMode
  embedded?: boolean
}

export function TasksPanel({ roomId, autonomyMode, initialView = 'kanban', embedded = false }: TasksPanelProps): React.JSX.Element {
  useTick()
  const { semi, guard, requestSemiMode, showLockModal, closeLockModal } = useAutonomyControlGate(autonomyMode)
  const [containerRef, containerWidth] = useContainerWidth<HTMLDivElement>()
  const wide = containerWidth >= 600
  const [filter, setFilter] = useState<StatusFilter>(persistedFilter)
  const [actionError, setActionError] = useState<string | null>(null)
  const [pendingRuns, setPendingRuns] = useState<Set<number>>(new Set())
  const [consoleTaskId, setConsoleTaskId] = useState<number | null>(null)
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [viewMode, setViewMode] = useState<TaskViewMode>(initialView)
  const { data: tasks, refresh, error: tasksError, isLoading } = usePolling(() => api.tasks.list(roomId ?? undefined), 30000)
  const { data: runningRuns, refresh: refreshRuns } = usePolling(
    () => api.runs.list(20, { status: 'running' }),
    30000
  )
  const { data: roomCycles, refresh: refreshRoomCycles } = usePolling(
    () => roomId ? api.cycles.listByRoom(roomId, 80) : Promise.resolve([]),
    15000
  )
  const { data: workers } = usePolling(() => roomId ? api.workers.listForRoom(roomId) : Promise.resolve([]), 60000)
  const { data: room } = usePolling(() => roomId ? api.rooms.get(roomId).catch(() => null) : Promise.resolve(null), 60000)
  const taskEvent = useWebSocket('tasks')
  const runsEvent = useWebSocket('runs')

  useEffect(() => {
    if (embedded) setViewMode(initialView)
  }, [embedded, initialView])

  useEffect(() => {
    if (taskEvent) refresh()
  }, [refresh, taskEvent])

  useEffect(() => {
    if (!runsEvent) return
    refreshRuns()
    refreshRoomCycles()
    refresh()
  }, [refresh, refreshRoomCycles, refreshRuns, runsEvent])

  function updateFilter(next: StatusFilter): void {
    persistedFilter = next
    setFilter(next)
  }

  const assignableWorkers = useMemo(() => {
    return (workers ?? []).filter(worker => isAssignableWorker(worker, room?.queenWorkerId ?? null))
  }, [workers, room?.queenWorkerId])

  const workerMap = new Map<number, Worker>()
  if ((workers ?? []).length > 0) {
    for (const w of workers ?? []) workerMap.set(w.id, w)
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

  async function updateTaskFlow(task: Task, patch: TaskFlowPatch): Promise<void> {
    setActionError(null)
    try {
      await api.tasks.update(task.id, {
        description: upsertTaskFlowDescription(task, patch)
      })
      refresh()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '调整协作流程失败')
      throw err
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
  const filteredTasks = embedded || filter === 'all' ? tasks : tasks.filter(t => t.status === filter)

  return (
    <div className={`flex flex-col h-full ${embedded ? 'rounded-lg border border-border-primary bg-surface-primary overflow-hidden' : ''}`}>
      {!embedded && (
      <div className="px-3 py-1.5 border-b border-border-primary flex items-center gap-2 flex-wrap">
        <h2 className="text-base font-semibold text-text-primary">帮主任务台</h2>
        <span className="text-xs text-text-muted">{tasks.length} 张镖单</span>
        <button
          onClick={() => guard(() => setShowCreateForm(!showCreateForm))}
          className={`text-xs px-2.5 py-1.5 rounded-lg ${modeAwareButtonClass(semi, 'bg-interactive text-text-invert hover:bg-interactive-hover')}`}
        >
          {showCreateForm ? '取消' : '+ 发布委托'}
        </button>
        <div className="ml-auto inline-flex gap-1 rounded-lg bg-surface-tertiary p-0.5">
          {([
            ['kanban', '任务看板'],
            ['flow', '协作流程'],
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
      )}

      {!embedded && semi && showCreateForm && (
        <CreateTaskForm
          workers={assignableWorkers}
          onCreated={() => { refresh(); setShowCreateForm(false) }}
          roomId={roomId}
        />
      )}

      {!embedded && (
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
      )}

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
          {!embedded && filter !== 'all' ? (
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
      ) : viewMode === 'flow' ? (
        <SwimlaneFlowView
          tasks={filteredTasks}
          workers={assignableWorkers}
          workerMap={workerMap}
          runningByTaskId={runningByTaskId}
          onAssignWorker={assignWorker}
          onUpdateFlow={updateTaskFlow}
          onFlowRepaired={refresh}
        />
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
        <HeartbeatGanttView
          tasks={filteredTasks}
          workerMap={workerMap}
          runningByTaskId={runningByTaskId}
          cycles={roomCycles ?? []}
        />
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
