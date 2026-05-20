import { useState, useEffect } from 'react'
import { usePolling } from '../hooks/usePolling'
import { api } from '../lib/client'
import { ROOM_GOAL_EVENT_TYPES } from '../lib/room-events'
import { wsClient, type WsMessage } from '../lib/ws'
import { formatRelativeTime } from '../utils/time'
import { Select } from './Select'
import { AutoModeLockModal, AUTO_MODE_LOCKED_BUTTON_CLASS, modeAwareButtonClass, useAutonomyControlGate } from './AutonomyControlGate'
import type { Goal, GoalUpdate, Worker } from '@shared/types'

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

export function GoalsPanel({ roomId, autonomyMode }: GoalsPanelProps): React.JSX.Element {
  const { semi, guard, requestSemiMode, showLockModal, closeLockModal } = useAutonomyControlGate(autonomyMode)

  const { data: goals, refresh } = usePolling<Goal[]>(
    () => roomId ? api.goals.list(roomId) : Promise.resolve([]),
    30000
  )
  const { data: workers } = usePolling<Worker[]>(() => roomId ? api.workers.listForRoom(roomId) : Promise.resolve([]), 60000)

  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [updatesCache, setUpdatesCache] = useState<Record<number, GoalUpdate[]>>({})
  const [showCreate, setShowCreate] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null)

  // Create form
  const [createDesc, setCreateDesc] = useState('')
  const [createWorkerId, setCreateWorkerId] = useState<number | ''>('')

  // Add update form
  const [updateObs, setUpdateObs] = useState('')

  useEffect(() => {
    refresh()
  }, [roomId, refresh])

  useEffect(() => {
    if (!roomId) return
    return wsClient.subscribe(`room:${roomId}`, (event: WsMessage) => {
      if (ROOM_GOAL_EVENT_TYPES.has(event.type)) {
        void refresh()
      }
    })
  }, [refresh, roomId])

  async function handleCreate(): Promise<void> {
    if (!createDesc.trim() || roomId === null) return
    await api.goals.create(
      roomId,
      createDesc.trim(),
      undefined,
      createWorkerId || undefined
    )
    setCreateDesc('')
    setCreateWorkerId('')
    setShowCreate(false)
    refresh()
  }

  async function toggleExpand(goalId: number): Promise<void> {
    if (expandedId === goalId) {
      setExpandedId(null)
      return
    }
    setExpandedId(goalId)
    if (!updatesCache[goalId]) {
      const updates = await api.goals.getUpdates(goalId, 20)
      setUpdatesCache(prev => ({ ...prev, [goalId]: updates }))
    }
  }

  async function handleAddUpdate(goalId: number): Promise<void> {
    if (!updateObs.trim()) return
    await api.goals.addUpdate(goalId, updateObs.trim())
    setUpdateObs('')
    const updates = await api.goals.getUpdates(goalId, 20)
    setUpdatesCache(prev => ({ ...prev, [goalId]: updates }))
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

  const workerMap = new Map((workers ?? []).map(w => [w.id, w]))
  const statusLabel = (status: string): string => ({
    active: '进行中',
    in_progress: '推进中',
    completed: '已完成',
    abandoned: '已放弃',
    blocked: '已阻塞',
  }[status] ?? status)

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-2 border-b border-border-primary flex items-center gap-2 flex-wrap">
        <h2 className="text-base font-semibold text-text-primary">委托目标</h2>
        <span className="text-xs text-text-muted">
          {goals ? `${goals.length} 个` : '加载中...'}
        </span>
        {!roomId && (
          <span className="text-xs text-text-muted">请选择帮派</span>
        )}
        <button
          onClick={() => guard(() => setShowCreate(!showCreate))}
          className={`text-xs px-2.5 py-1.5 rounded-lg ${modeAwareButtonClass(semi, 'bg-interactive text-text-invert hover:bg-interactive-hover')}`}
        >
          {showCreate ? '取消' : '+ 新建委托'}
        </button>
      </div>

      {semi && showCreate && (
        <div className="p-4 border-b-2 border-border-primary bg-surface-secondary space-y-2">
          <textarea
            placeholder="写下这支帮派要完成的委托目标..."
            value={createDesc}
            onChange={(e) => setCreateDesc(e.target.value)}
            rows={2}
            className="w-full px-2.5 py-1.5 text-sm border border-border-primary rounded-lg focus:outline-none focus:border-text-muted bg-surface-primary text-text-primary placeholder:text-text-muted resize-y"
          />
          <div className="flex gap-2">
            <Select
              value={String(createWorkerId)}
              onChange={(v) => setCreateWorkerId(v ? Number(v) : '')}
              className="flex-1"
              placeholder="未分派"
              options={[
                { value: '', label: '未分派' },
                ...(workers ?? []).map(w => ({ value: String(w.id), label: w.name }))
              ]}
            />
          </div>
          <button
            onClick={handleCreate}
            disabled={!createDesc.trim()}
            className="text-sm bg-interactive text-text-invert px-4 py-2 rounded-lg hover:bg-interactive-hover disabled:opacity-50 disabled:cursor-not-allowed"
          >
            创建委托
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {!roomId ? (
          <div className="p-4 text-sm text-text-muted">请选择帮派以查看委托目标。</div>
        ) : (goals ?? []).length === 0 && goals ? (
          <div className="p-4 text-sm text-text-muted">{semi ? '当前帮派还没有委托。创建一个委托即可开始运行。' : '当前帮派还没有委托。天机阁会根据江湖方向创建委托。'}</div>
        ) : (
          <div className="p-3 space-y-2">
            {(goals ?? []).map(goal => (
              <div key={goal.id} className="bg-surface-secondary border border-border-primary rounded-lg overflow-hidden">
                <div
                  className="flex items-center gap-2 px-3 py-2 hover:bg-surface-hover cursor-pointer"
                  onClick={() => toggleExpand(goal.id)}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-text-primary">{goal.description}</span>
                      <span className={`px-1.5 py-0.5 rounded-lg text-xs font-medium shrink-0 ${STATUS_COLORS[goal.status] ?? 'bg-surface-tertiary text-text-muted'}`}>
                        {statusLabel(goal.status)}
                      </span>
                    </div>
                    {goal.assignedWorkerId && workerMap.has(goal.assignedWorkerId) && (
                      <span className="text-xs text-text-muted">
                        {workerMap.get(goal.assignedWorkerId)!.name}
                      </span>
                    )}
                  </div>
                  <span className="text-sm text-text-muted">{expandedId === goal.id ? '\u25BC' : '\u25B6'}</span>
                </div>

                {expandedId === goal.id && (
                  <div className="px-3 pb-3 pt-2 border-t border-border-primary bg-surface-secondary space-y-2">
                    {/* Status actions */}
                    <div className="flex gap-2 flex-wrap">
                      {goal.status !== 'completed' && (
                        <button
                          onClick={() => guard(() => { void handleStatusChange(goal.id, 'completed') })}
                          className={`text-xs px-3 py-2 md:px-2.5 md:py-1.5 rounded-lg border ${modeAwareButtonClass(semi, 'border-emerald-200 text-status-success hover:bg-emerald-50')}`}
                        >
                          标记完成
                        </button>
                      )}
                      {goal.status !== 'blocked' && goal.status !== 'completed' && (
                        <button
                          onClick={() => guard(() => { void handleStatusChange(goal.id, 'blocked') })}
                          className={`text-xs px-3 py-2 md:px-2.5 md:py-1.5 rounded-lg border ${modeAwareButtonClass(semi, 'border-red-200 text-status-error hover:bg-red-50')}`}
                        >
                          标记阻塞
                        </button>
                      )}
                      <button
                        onClick={() => guard(() => { void handleDelete(goal.id) })}
                        onBlur={() => setConfirmDeleteId(null)}
                        className={`text-xs px-3 py-2 md:px-2.5 md:py-1.5 rounded-lg border ${modeAwareButtonClass(semi, 'border-red-200 text-status-error hover:text-red-600')}`}
                      >
                        {confirmDeleteId === goal.id ? '确认删除？' : '删除'}
                      </button>
                    </div>

                    {/* Add update */}
                    {semi ? (
                      <div className="flex gap-2">
                        <input
                          value={updateObs}
                          onChange={(e) => setUpdateObs(e.target.value)}
                          placeholder="记录目标进展..."
                          className="flex-1 px-2.5 py-1.5 text-sm border border-border-primary rounded-lg focus:outline-none focus:border-text-muted bg-surface-primary text-text-primary placeholder:text-text-muted"
                        />
                        <button
                          onClick={() => handleAddUpdate(goal.id)}
                          disabled={!updateObs.trim()}
                          className="text-sm bg-interactive text-text-invert px-2.5 py-1.5 rounded-lg hover:bg-interactive-hover disabled:opacity-50"
                        >
                          记录
                        </button>
                      </div>
                    ) : (
                      <div>
                        <button
                          onClick={requestSemiMode}
                          className={`text-sm px-2.5 py-1.5 rounded-lg ${AUTO_MODE_LOCKED_BUTTON_CLASS}`}
                        >
                          记录进展
                        </button>
                      </div>
                    )}

                    {/* Updates history */}
                    {updatesCache[goal.id] && updatesCache[goal.id].length > 0 ? (
                      <div className={`space-y-2${semi ? ' pt-1 border-t border-border-primary' : ''}`}>
                        <div className="text-xs font-medium text-text-muted">进展记录</div>
                        {updatesCache[goal.id].map(u => (
                          <div key={u.id} className="text-sm text-text-muted flex gap-2">
                            <span className="text-text-muted shrink-0">{formatRelativeTime(u.createdAt)}</span>
                            <span>{u.observation}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-sm text-text-muted">暂无进展记录</div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      <AutoModeLockModal open={showLockModal} onClose={closeLockModal} />
    </div>
  )
}
