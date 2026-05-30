import { useEffect, useMemo, useState } from 'react'
import { usePolling } from '../hooks/usePolling'
import { api } from '../lib/client'
import { ROOM_GOAL_EVENT_TYPES } from '../lib/room-events'
import { wsClient, type WsMessage } from '../lib/ws'
import { formatRelativeTime } from '../utils/time'
import { Select } from './Select'
import { AutoModeLockModal, AUTO_MODE_LOCKED_BUTTON_CLASS, modeAwareButtonClass, useAutonomyControlGate } from './AutonomyControlGate'
import type { Goal, GoalUpdate, Worker } from '@shared/types'
import { isComplexGoalDescription, isGenericAutoExecutor, isUnfinishedGoalStatus } from '@shared/goal-assignment-rules'

interface GoalResultSummary {
  goalId: number
  status: string
  progress: number
  completionClear: boolean
  latestBasis: string | null
  hasManualOnlyUpdates: boolean
  resultFiles: Array<{ name: string; title: string; path: string; updatedAt: string; size: number }>
}

interface GoalTreeRow {
  goal: Goal
  depth: number
  hasChildren: boolean
  hiddenByParent: boolean
}

const STATUS_COLORS: Record<string, string> = {
  active: 'bg-status-success-bg text-status-success',
  in_progress: 'bg-interactive-bg text-interactive',
  completed: 'bg-status-success-bg text-status-success',
  abandoned: 'bg-surface-tertiary text-text-muted',
  blocked: 'bg-status-error-bg text-status-error',
}

interface GoalsPanelProps {
  roomId: number | null
  autonomyMode: 'semi'
}

function statusLabel(status: string): string {
  return ({
    active: '进行中',
    in_progress: '推进中',
    completed: '已完成',
    abandoned: '已放弃',
    blocked: '已阻塞',
  }[status] ?? status)
}

function toInputDateTime(value: string | null | undefined): string {
  if (!value) return ''
  if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(value)) return ''
  return value.replace(' ', 'T').slice(0, 16)
}

function fromInputDateTime(value: string): string | null {
  if (!value.trim()) return null
  const normalized = value.trim().replace('T', ' ')
  return normalized.length === 16 ? `${normalized}:00` : normalized
}

function formatExpectedTime(value: string | null | undefined): string {
  if (!value) return '未估算'
  if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(value)) return value
  return value.replace('T', ' ').slice(0, 16)
}

function progressPercent(goal: Goal): number {
  return Math.round(Math.max(0, Math.min(1, goal.progress ?? 0)) * 100)
}

function clip(value: string, max = 160): string {
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

function extractLabeledField(text: string, labels: string[]): string | null {
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean)
  for (const line of lines) {
    for (const label of labels) {
      const pattern = new RegExp(`^${label}\\s*[：:]\\s*(.+)$`, 'i')
      const match = line.match(pattern)
      if (match?.[1]?.trim()) return match[1].trim()
    }
  }
  return null
}

function goalAcceptance(goal: Goal): string {
  return extractLabeledField(goal.description, ['验收标准', '完成标准', '通过标准', 'acceptance criteria'])
    ?? '暂无明确验收标准。需要帮主补充“什么情况下算完成”。'
}

function goalOutputFormat(goal: Goal): string {
  return extractLabeledField(goal.description, ['输出格式', '交付格式', '输出目标', 'output format'])
    ?? '暂无明确交付格式。'
}

function goalMainText(goal: Goal): string {
  return extractLabeledField(goal.description, ['任务', '目标'])
    ?? goal.description.split('\n')[0]?.trim()
    ?? goal.description
}

function buildGoalRows(goals: Goal[], collapsedIds: Set<number>): GoalTreeRow[] {
  const goalMap = new Map(goals.map(goal => [goal.id, goal]))
  const childrenByParent = new Map<number | null, Goal[]>()

  for (const goal of goals) {
    const parentId = goal.parentGoalId != null && goalMap.has(goal.parentGoalId)
      ? goal.parentGoalId
      : null
    const children = childrenByParent.get(parentId) ?? []
    children.push(goal)
    childrenByParent.set(parentId, children)
  }

  for (const children of childrenByParent.values()) {
    children.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id - b.id)
  }

  const rows: GoalTreeRow[] = []
  function walk(parentId: number | null, depth: number, hiddenByParent: boolean): void {
    for (const goal of childrenByParent.get(parentId) ?? []) {
      const hasChildren = (childrenByParent.get(goal.id) ?? []).length > 0
      rows.push({ goal, depth, hasChildren, hiddenByParent })
      if (hasChildren) {
        walk(goal.id, depth + 1, hiddenByParent || collapsedIds.has(goal.id))
      }
    }
  }

  walk(null, 0, false)
  return rows
}

export function GoalsPanel({ roomId, autonomyMode }: GoalsPanelProps): React.JSX.Element {
  const { semi, guard, requestSemiMode, showLockModal, closeLockModal } = useAutonomyControlGate(autonomyMode)

  const { data: goals, refresh } = usePolling<Goal[]>(
    () => roomId ? api.goals.list(roomId) : Promise.resolve([]),
    30000
  )
  const { data: workers } = usePolling<Worker[]>(() => roomId ? api.workers.listForRoom(roomId) : Promise.resolve([]), 60000)
  const { data: queenStatus } = usePolling<{ workerId: number; name: string; agentState: string; running: boolean } | null>(
    () => roomId ? api.rooms.queenStatus(roomId).catch(() => null) : Promise.resolve(null),
    10000
  )

  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [collapsedIds, setCollapsedIds] = useState<Set<number>>(new Set())
  const [updatesCache, setUpdatesCache] = useState<Record<number, GoalUpdate[]>>({})
  const [resultSummaryCache, setResultSummaryCache] = useState<Record<number, GoalResultSummary>>({})
  const [showCreate, setShowCreate] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const [createDesc, setCreateDesc] = useState('')
  const [createWorkerId, setCreateWorkerId] = useState<number | ''>('')
  const [createParentGoalId, setCreateParentGoalId] = useState<number | ''>('')
  const [createExpectedAt, setCreateExpectedAt] = useState('')

  const [updateObs, setUpdateObs] = useState('')
  const [feedbackText, setFeedbackText] = useState('')
  const [feedbackBusy, setFeedbackBusy] = useState(false)

  useEffect(() => {
    refresh()
    setExpandedId(null)
    setCollapsedIds(new Set())
  }, [roomId, refresh])

  useEffect(() => {
    if (!roomId) return
    return wsClient.subscribe(`room:${roomId}`, (event: WsMessage) => {
      if (ROOM_GOAL_EVENT_TYPES.has(event.type)) {
        void refresh()
      }
    })
  }, [refresh, roomId])

  useEffect(() => {
    const completedGoals = (goals ?? []).filter(goal => goal.status === 'completed' && !resultSummaryCache[goal.id])
    if (completedGoals.length === 0) return

    let cancelled = false
    void Promise.all(
      completedGoals.map(async goal => [goal.id, await api.goals.getResultSummary(goal.id)] as const)
    ).then(entries => {
      if (cancelled) return
      setResultSummaryCache(prev => {
        const next = { ...prev }
        for (const [id, summary] of entries) next[id] = summary
        return next
      })
    }).catch(() => {})

    return () => {
      cancelled = true
    }
  }, [goals, resultSummaryCache])

  const workerMap = useMemo(() => new Map((workers ?? []).map(w => [w.id, w])), [workers])
  const workerOpenGoalCounts = useMemo(() => {
    const counts = new Map<number, number>()
    for (const goal of goals ?? []) {
      if (goal.assignedWorkerId == null || !isUnfinishedGoalStatus(goal.status)) continue
      counts.set(goal.assignedWorkerId, (counts.get(goal.assignedWorkerId) ?? 0) + 1)
    }
    return counts
  }, [goals])
  const goalRows = useMemo(() => buildGoalRows(goals ?? [], collapsedIds), [collapsedIds, goals])
  const visibleRows = goalRows.filter(row => !row.hiddenByParent)
  const goalOptions = goalRows.map(row => ({
    value: String(row.goal.id),
    label: `${'　'.repeat(row.depth)}${goalMainText(row.goal)}`,
  }))

  const rootCount = (goals ?? []).filter(goal => goal.parentGoalId == null).length

  function workerOptionLabel(worker: Worker): string {
    const count = workerOpenGoalCounts.get(worker.id) ?? 0
    const suffix = count > 0 ? ` · 未完成 ${count}` : ''
    return `${worker.name}${suffix}`
  }

  function assignmentNotice(goal: Goal, worker: Worker | null): string | null {
    if (!worker) return null
    const openCount = Math.max(0, (workerOpenGoalCounts.get(worker.id) ?? 0) - (isUnfinishedGoalStatus(goal.status) ? 1 : 0))
    if (isGenericAutoExecutor(worker) && isComplexGoalDescription(goal.description)) {
      return '建议改派专职弟子：临时通用弟子不适合承接复杂研究，容易造成上下文污染。'
    }
    if (openCount >= (isGenericAutoExecutor(worker) ? 1 : 2)) {
      return `建议拆分：该弟子另有 ${openCount} 个未完成委托。`
    }
    return null
  }

  function latestMeaningfulUpdate(goalId: number): GoalUpdate | undefined {
    return updatesCache[goalId]?.find(update => !/^Manual progress update$/i.test(update.observation.trim()))
  }

  async function handleCreate(): Promise<void> {
    if (!createDesc.trim() || roomId === null || createWorkerId === '' || !createExpectedAt) return
    await api.goals.create(
      roomId,
      createDesc.trim(),
      createWorkerId,
      createParentGoalId === '' ? undefined : createParentGoalId,
      fromInputDateTime(createExpectedAt)
    )
    setCreateDesc('')
    setCreateWorkerId('')
    setCreateParentGoalId('')
    setCreateExpectedAt('')
    setShowCreate(false)
    refresh()
  }

  async function toggleExpand(goalId: number): Promise<void> {
    if (expandedId === goalId) {
      setExpandedId(null)
      return
    }
    setExpandedId(goalId)
    setFeedbackText('')
    if (!updatesCache[goalId] || !resultSummaryCache[goalId]) {
      const [updates, summary] = await Promise.all([
        api.goals.getUpdates(goalId, 20),
        api.goals.getResultSummary(goalId),
      ])
      setUpdatesCache(prev => ({ ...prev, [goalId]: updates }))
      setResultSummaryCache(prev => ({ ...prev, [goalId]: summary }))
    }
  }

  function toggleCollapse(goalId: number): void {
    setCollapsedIds(prev => {
      const next = new Set(prev)
      if (next.has(goalId)) next.delete(goalId)
      else next.add(goalId)
      return next
    })
  }

  async function handleAddUpdate(goalId: number): Promise<void> {
    if (!updateObs.trim()) return
    await api.goals.addUpdate(goalId, updateObs.trim())
    setUpdateObs('')
    const [updates, summary] = await Promise.all([
      api.goals.getUpdates(goalId, 20),
      api.goals.getResultSummary(goalId),
    ])
    setUpdatesCache(prev => ({ ...prev, [goalId]: updates }))
    setResultSummaryCache(prev => ({ ...prev, [goalId]: summary }))
    refresh()
  }

  async function handleGoalPatch(goalId: number, body: Record<string, unknown>): Promise<void> {
    await api.goals.update(goalId, body)
    refresh()
  }

  async function handleStatusChange(goalId: number, status: string): Promise<void> {
    await api.goals.update(goalId, { status })
    refresh()
  }

  async function handleDelete(goalId: number): Promise<void> {
    if (confirmDeleteId !== goalId) {
      setConfirmDeleteId(goalId)
      return
    }
    await api.goals.delete(goalId)
    if (expandedId === goalId) setExpandedId(null)
    setConfirmDeleteId(null)
    refresh()
  }

  async function handleFeedback(goal: Goal): Promise<void> {
    if (!roomId || !feedbackText.trim()) return
    setFeedbackBusy(true)
    setNotice(null)
    const feedback = feedbackText.trim()
    try {
      await api.goals.addUpdate(goal.id, `用户反馈要求修正：${feedback}`)
      await api.goals.update(goal.id, { status: 'in_progress', progress: Math.max(0.01, Math.min(goal.progress, 0.85)) })
      if (queenStatus?.workerId) {
        await api.escalations.create(
          roomId,
          null,
          `请根据用户反馈修正委托 #${goal.id}：${goalMainText(goal)}\n\n用户反馈：${feedback}\n\n要求：重新检查验收标准和交付结果，明确需要返工的部分，并安排负责人继续修正。`,
          queenStatus.workerId,
          true
        )
      }
      setFeedbackText('')
      setNotice('已把反馈发给帮主，并将目标重新标记为推进中。')
      const [updates, summary] = await Promise.all([
        api.goals.getUpdates(goal.id, 20),
        api.goals.getResultSummary(goal.id),
      ])
      setUpdatesCache(prev => ({ ...prev, [goal.id]: updates }))
      setResultSummaryCache(prev => ({ ...prev, [goal.id]: summary }))
      refresh()
    } catch (err) {
      setNotice(err instanceof Error ? err.message : '提交反馈失败')
    } finally {
      setFeedbackBusy(false)
    }
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="shrink-0 border-b border-border-primary px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-semibold text-text-primary">委托目标</h2>
          <span className="text-xs text-text-muted">
            {goals ? `${goals.length} 个 · 父目标 ${rootCount} 个` : '加载中...'}
          </span>
          {!roomId && <span className="text-xs text-text-muted">请选择帮派</span>}
          <button
            onClick={() => guard(() => setShowCreate(!showCreate))}
            className={`rounded-lg px-2.5 py-1.5 text-xs ${modeAwareButtonClass(semi, 'bg-interactive text-text-invert hover:bg-interactive-hover')}`}
          >
            {showCreate ? '取消' : '+ 新建委托'}
          </button>
        </div>
        <div className="mt-1 text-xs text-text-muted">
          父子目标用缩进展示；点开目标查看验收标准、交付结果，并可把反馈发给帮主要求修正。
        </div>
      </div>

      {notice && (
        <div className="mx-4 mt-3 rounded-lg border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-muted">
          {notice}
        </div>
      )}

      {semi && showCreate && (
        <div className="shrink-0 border-b border-border-primary bg-surface-secondary p-4">
          <div className="grid gap-2 xl:grid-cols-[1.2fr_220px_220px_220px_auto]">
            <textarea
              placeholder="写下这支帮派要完成的委托目标..."
              value={createDesc}
              onChange={(e) => setCreateDesc(e.target.value)}
              rows={2}
              className="min-h-16 w-full resize-y rounded-lg border border-border-primary bg-surface-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-text-muted focus:outline-none"
            />
            <Select
              value={String(createParentGoalId)}
              onChange={(v) => setCreateParentGoalId(v ? Number(v) : '')}
              placeholder="父目标"
              options={[{ value: '', label: '作为父目标' }, ...goalOptions]}
            />
            <Select
              value={String(createWorkerId)}
              onChange={(v) => setCreateWorkerId(v ? Number(v) : '')}
              placeholder="负责人"
              options={[
                { value: '', label: '选择负责人' },
                ...(workers ?? []).map(w => ({ value: String(w.id), label: workerOptionLabel(w) }))
              ]}
            />
            <input
              type="datetime-local"
              value={createExpectedAt}
              onChange={(event) => setCreateExpectedAt(event.target.value)}
              className="rounded-lg border border-border-primary bg-surface-primary px-3 py-2 text-sm text-text-primary"
            />
            <button
              onClick={handleCreate}
              disabled={!createDesc.trim() || createWorkerId === '' || !createExpectedAt}
              className="rounded-lg bg-interactive px-4 py-2 text-sm text-text-invert hover:bg-interactive-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              创建
            </button>
          </div>
          <div className="mt-2 text-xs text-text-muted">新目标必须指定负责人和预计完成时间；子目标会缩进到父目标下面。</div>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {!roomId ? (
          <div className="p-4 text-sm text-text-muted">请选择帮派以查看委托目标。</div>
        ) : (goals ?? []).length === 0 && goals ? (
          <div className="p-4 text-sm text-text-muted">当前帮派还没有委托。可以通过天机阁对话创建，也可以在这里补录目标。</div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border-primary bg-surface-secondary">
            <div className="grid grid-cols-[minmax(360px,1fr)_170px_170px_120px] gap-2 border-b border-border-primary px-3 py-2 text-xs font-medium text-text-muted">
              <div>目标 / 父子关系</div>
              <div>负责人</div>
              <div>预计完成时间</div>
              <div className="text-right">状态</div>
            </div>

            {visibleRows.map(({ goal, depth, hasChildren }) => {
              const worker = goal.assignedWorkerId ? workerMap.get(goal.assignedWorkerId) : null
              const expanded = expandedId === goal.id
              const collapsed = collapsedIds.has(goal.id)
              const summary = resultSummaryCache[goal.id]
              const latestBasis = latestMeaningfulUpdate(goal.id)?.observation ?? summary?.latestBasis ?? null
              const missingOwner = !goal.assignedWorkerId
              const missingTime = !goal.expectedCompletedAt
              const ownerNotice = assignmentNotice(goal, worker)
              return (
                <div key={goal.id} className="border-b border-border-primary last:border-b-0">
                  <div
                    className={`grid grid-cols-[minmax(360px,1fr)_170px_170px_120px] items-center gap-2 px-3 py-2 hover:bg-surface-hover ${expanded ? 'bg-surface-hover' : ''}`}
                  >
                    <div className="min-w-0" style={{ paddingLeft: `${Math.min(depth, 6) * 22}px` }}>
                      <div className="flex min-w-0 items-center gap-2">
                        {hasChildren ? (
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation()
                              toggleCollapse(goal.id)
                            }}
                            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border border-border-primary text-xs text-text-muted hover:bg-surface-primary"
                            aria-label={collapsed ? '展开子目标' : '折叠子目标'}
                          >
                            {collapsed ? '▸' : '▾'}
                          </button>
                        ) : (
                          <span className="h-6 w-6 shrink-0" />
                        )}
                        <button
                          type="button"
                          onClick={() => { void toggleExpand(goal.id) }}
                          className="min-w-0 flex-1 text-left"
                        >
                          <div className="truncate text-sm font-medium text-text-primary">{goalMainText(goal)}</div>
                          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-text-muted">
                            <span>#{goal.id}</span>
                            {hasChildren && <span>{collapsed ? '子目标已折叠' : '包含子目标'}</span>}
                            <span>进度 {progressPercent(goal)}%</span>
                            {goal.status === 'completed' && (
                              <span className={summary?.completionClear ? 'text-status-success' : 'text-status-warning'}>
                                {summary?.completionClear ? '验收依据已记录' : '验收依据待补充'}
                              </span>
                            )}
                          </div>
                        </button>
                      </div>
                    </div>

                    <div>
                      <Select
                        value={goal.assignedWorkerId == null ? '' : String(goal.assignedWorkerId)}
                        onChange={(v) => guard(() => { void handleGoalPatch(goal.id, { assignedWorkerId: v ? Number(v) : null }) })}
                        className={missingOwner ? 'border-status-warning' : ''}
                        options={[
                          { value: '', label: '未分派' },
                          ...(workers ?? []).map(w => ({ value: String(w.id), label: workerOptionLabel(w) }))
                        ]}
                      />
                      {missingOwner && <div className="mt-1 text-xs text-status-warning">需要负责人</div>}
                      {worker && <div className="mt-1 truncate text-xs text-text-muted">{worker.role || '弟子'}</div>}
                      {ownerNotice && <div className="mt-1 text-xs leading-5 text-status-warning">{ownerNotice}</div>}
                    </div>

                    <div>
                      <input
                        type="datetime-local"
                        value={toInputDateTime(goal.expectedCompletedAt)}
                        onChange={(event) => guard(() => { void handleGoalPatch(goal.id, { expectedCompletedAt: fromInputDateTime(event.target.value) }) })}
                        className={`w-full rounded-lg border bg-surface-primary px-2 py-1.5 text-xs text-text-primary ${missingTime ? 'border-status-warning' : 'border-border-primary'}`}
                      />
                      <div className={`mt-1 text-xs ${missingTime ? 'text-status-warning' : 'text-text-muted'}`}>
                        {formatExpectedTime(goal.expectedCompletedAt)}
                      </div>
                    </div>

                    <div className="text-right">
                      <span className={`inline-flex rounded-lg px-2 py-1 text-xs font-medium ${STATUS_COLORS[goal.status] ?? 'bg-surface-tertiary text-text-muted'}`}>
                        {statusLabel(goal.status)}
                      </span>
                      <button
                        type="button"
                        onClick={() => { void toggleExpand(goal.id) }}
                        className="ml-2 text-xs text-text-muted hover:text-text-secondary"
                      >
                        {expanded ? '收起' : '详情'}
                      </button>
                    </div>
                  </div>

                  {expanded && (
                    <div className="border-t border-border-primary bg-surface-primary/60 px-4 py-4">
                      <div className="grid gap-3 xl:grid-cols-[1fr_1fr]">
                        <div className="rounded-lg border border-border-primary bg-surface-secondary p-3">
                          <div className="text-sm font-semibold text-text-primary">验收标准</div>
                          <div className="mt-2 whitespace-pre-wrap text-sm leading-6 text-text-secondary">{goalAcceptance(goal)}</div>
                          <div className="mt-3 text-xs font-medium text-text-muted">交付格式</div>
                          <div className="mt-1 whitespace-pre-wrap text-sm leading-6 text-text-muted">{goalOutputFormat(goal)}</div>
                        </div>

                        <div className="rounded-lg border border-border-primary bg-surface-secondary p-3">
                          <div className="text-sm font-semibold text-text-primary">交付结果</div>
                          <div className="mt-2 text-sm leading-6 text-text-secondary">
                            {latestBasis
                              ? latestBasis
                              : summary?.hasManualOnlyUpdates
                                ? '已标记进展，但还缺少明确的结果说明。'
                                : summary
                                  ? '暂未找到明确交付说明。'
                                  : '正在读取交付结果...'}
                          </div>
                          {summary?.resultFiles && summary.resultFiles.length > 0 && (
                            <div className="mt-3 grid gap-2">
                              {summary.resultFiles.slice(0, 5).map(file => (
                                <div key={file.path} className="rounded-lg border border-border-primary bg-surface-primary px-3 py-2">
                                  <div className="truncate text-sm text-text-primary">{file.title || file.name}</div>
                                  <div className="mt-1 truncate text-xs text-text-muted">{file.path}</div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="mt-3 grid gap-3 xl:grid-cols-[1fr_1fr]">
                        <div className="rounded-lg border border-border-primary bg-surface-secondary p-3">
                          <div className="flex flex-wrap gap-2">
                            {goal.status !== 'completed' && (
                              <button
                                onClick={() => guard(() => { void handleStatusChange(goal.id, 'completed') })}
                                className={`rounded-lg border px-3 py-2 text-xs ${modeAwareButtonClass(semi, 'border-status-success text-status-success hover:bg-status-success-bg')}`}
                              >
                                标记完成
                              </button>
                            )}
                            {goal.status !== 'blocked' && goal.status !== 'completed' && (
                              <button
                                onClick={() => guard(() => { void handleStatusChange(goal.id, 'blocked') })}
                                className={`rounded-lg border px-3 py-2 text-xs ${modeAwareButtonClass(semi, 'border-status-error text-status-error hover:bg-status-error-bg')}`}
                              >
                                标记阻塞
                              </button>
                            )}
                            <button
                              onClick={() => guard(() => { void handleDelete(goal.id) })}
                              onBlur={() => setConfirmDeleteId(null)}
                              className={`rounded-lg border px-3 py-2 text-xs ${modeAwareButtonClass(semi, 'border-status-error text-status-error hover:bg-status-error-bg')}`}
                            >
                              {confirmDeleteId === goal.id ? '确认删除？' : '删除'}
                            </button>
                          </div>

                          {semi ? (
                            <div className="mt-3 flex gap-2">
                              <input
                                value={updateObs}
                                onChange={(e) => setUpdateObs(e.target.value)}
                                placeholder="补充进展、验收依据或交付说明..."
                                className="flex-1 rounded-lg border border-border-primary bg-surface-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-text-muted focus:outline-none"
                              />
                              <button
                                onClick={() => { void handleAddUpdate(goal.id) }}
                                disabled={!updateObs.trim()}
                                className="rounded-lg bg-interactive px-3 py-2 text-sm text-text-invert hover:bg-interactive-hover disabled:opacity-50"
                              >
                                记录
                              </button>
                            </div>
                          ) : (
                            <button onClick={requestSemiMode} className={`mt-3 rounded-lg px-3 py-2 text-sm ${AUTO_MODE_LOCKED_BUTTON_CLASS}`}>记录进展</button>
                          )}

                          <div className="mt-3 border-t border-border-primary pt-3">
                            <div className="text-xs font-medium text-text-muted">进展记录</div>
                            {updatesCache[goal.id] && updatesCache[goal.id].length > 0 ? (
                              <div className="mt-2 space-y-2">
                                {updatesCache[goal.id].map(update => (
                                  <div key={update.id} className="flex gap-2 text-sm text-text-muted">
                                    <span className="shrink-0 text-xs">{formatRelativeTime(update.createdAt)}</span>
                                    <span className="whitespace-pre-wrap break-words">
                                      {/Manual progress update/i.test(update.observation.trim()) ? '手动调整了进度，但没有填写完成依据。' : update.observation}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <div className="mt-2 text-sm text-text-muted">暂无进展记录</div>
                            )}
                          </div>
                        </div>

                        <div className="rounded-lg border border-border-primary bg-surface-secondary p-3">
                          <div className="text-sm font-semibold text-text-primary">反馈并要求修正</div>
                          <div className="mt-1 text-xs text-text-muted">如果交付结果不符合预期，写下问题；系统会把目标重新交给帮主处理。</div>
                          <textarea
                            value={feedbackText}
                            onChange={(event) => setFeedbackText(event.target.value)}
                            rows={5}
                            className="mt-3 w-full resize-y rounded-lg border border-border-primary bg-surface-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-text-muted focus:outline-none"
                            placeholder="例如：结论缺少竞品样本依据，请补充数据来源，并把风险判断写清楚。"
                          />
                          <button
                            type="button"
                            onClick={() => guard(() => { void handleFeedback(goal) })}
                            disabled={!feedbackText.trim() || feedbackBusy}
                            className={`mt-3 rounded-lg px-3 py-2 text-sm ${modeAwareButtonClass(semi, 'bg-interactive text-text-invert hover:bg-interactive-hover disabled:opacity-50')}`}
                          >
                            {feedbackBusy ? '发送中...' : '要求修正'}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
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
