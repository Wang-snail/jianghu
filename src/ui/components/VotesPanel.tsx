import { useState, useEffect } from 'react'
import { usePolling } from '../hooks/usePolling'
import { api } from '../lib/client'
import { ROOM_DECISION_EVENT_TYPES } from '../lib/room-events'
import { wsClient, type WsMessage } from '../lib/ws'
import { formatRelativeTime } from '../utils/time'
import { Select } from './Select'
import { AutoModeLockModal, modeAwareButtonClass, useAutonomyControlGate } from './AutonomyControlGate'
import type { QuorumDecision, Worker } from '@shared/types'

const STATUS_COLORS: Record<string, string> = {
  announced: 'bg-interactive-bg text-interactive',
  effective: 'bg-status-success-bg text-status-success',
  approved: 'bg-status-success-bg text-status-success',
  objected: 'bg-status-error-bg text-status-error',
  rejected: 'bg-status-error-bg text-status-error',
  voting: 'bg-interactive-bg text-interactive',
  vetoed: 'bg-brand-100 text-brand-700',
  expired: 'bg-surface-tertiary text-text-muted',
}

const TYPE_LABELS: Record<string, string> = {
  strategy: '战略',
  resource: '资源',
  personnel: '人员',
  rule_change: '规则调整',
  low_impact: '普通问题',
}

function formatEffective(effectiveAt: string | null): string {
  if (!effectiveAt) return ''
  const remaining = new Date(effectiveAt).getTime() - Date.now()
  if (remaining <= 0) return '已生效'
  if (remaining < 60_000) return '<1m'
  if (remaining < 3_600_000) return `${Math.floor(remaining / 60_000)}m`
  return `${Math.floor(remaining / 3_600_000)}h`
}

interface VotesPanelProps {
  roomId: number | null
  autonomyMode: 'semi'
}

export function VotesPanel({ roomId, autonomyMode }: VotesPanelProps): React.JSX.Element {
  const { semi, guard, showLockModal, closeLockModal } = useAutonomyControlGate(autonomyMode)

  const { data: decisions, refresh } = usePolling<QuorumDecision[]>(
    () => roomId ? api.decisions.list(roomId) : Promise.resolve([]),
    30000
  )

  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [statusFilter, setStatusFilter] = useState<string | null>(null)
  const [typeFilter, setTypeFilter] = useState<string | null>(null)

  // Create form
  const [createProposal, setCreateProposal] = useState('')
  const [createType, setCreateType] = useState('strategy')

  // Action feedback
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    refresh()
  }, [roomId, refresh])

  useEffect(() => {
    if (!roomId) return
    return wsClient.subscribe(`room:${roomId}`, (event: WsMessage) => {
      if (ROOM_DECISION_EVENT_TYPES.has(event.type)) {
        void refresh()
      }
    })
  }, [refresh, roomId])

  async function handleCreate(): Promise<void> {
    if (!createProposal.trim() || roomId === null) return
    await api.decisions.create(roomId, {
      proposal: createProposal.trim(),
      decisionType: createType,
    })
    setCreateProposal('')
    setCreateType('strategy')
    setShowCreate(false)
    refresh()
  }

  async function handleKeeperVote(decisionId: number, vote: string): Promise<void> {
    setActionError(null)
    try {
      await api.decisions.keeperVote(decisionId, vote)
      refresh()
    } catch (e) {
      setActionError((e as Error).message)
    }
  }

  const allDecisions = decisions ?? []
  const filtered = allDecisions.filter(d => {
    if (statusFilter && d.status !== statusFilter) return false
    if (typeFilter && d.decisionType !== typeFilter) return false
    return true
  })
  const isFiltering = statusFilter !== null || typeFilter !== null
  const pending = filtered.filter(d => d.status === 'announced' || d.status === 'voting')
  const resolved = filtered.filter(d => d.status !== 'announced' && d.status !== 'voting')
  const presentStatuses = [...new Set(allDecisions.map(d => d.status))]
  const presentTypes = [...new Set(allDecisions.map(d => d.decisionType))]

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-2 border-b border-border-primary flex items-center gap-2 flex-wrap">
        <h2 className="text-base font-semibold text-text-primary">议事堂</h2>
        <span className="text-xs text-text-muted">
          {decisions ? `${decisions.length} 条议事记录` : '加载中...'}
        </span>
        {!roomId && (
          <span className="text-xs text-text-muted">请选择帮派</span>
        )}
        <button
          onClick={() => guard(() => setShowCreate(!showCreate))}
          className={`text-xs px-2.5 py-1.5 rounded-lg ${modeAwareButtonClass(semi, 'bg-interactive text-text-invert hover:bg-interactive-hover')}`}
        >
          {showCreate ? '取消' : '+ 开启议事'}
        </button>
      </div>

      {allDecisions.length > 0 && (presentStatuses.length > 1 || presentTypes.length > 1) && (
        <div className="px-4 py-2 border-b border-border-primary">
          <div className="flex items-center justify-between gap-2 mb-2">
            <div className="text-xs font-semibold text-text-muted">筛选</div>
            {isFiltering && (
              <button
                onClick={() => { setStatusFilter(null); setTypeFilter(null) }}
                className="text-xs px-2 py-1 rounded-lg border border-border-primary text-text-muted hover:text-text-secondary hover:bg-surface-hover transition-colors"
              >
                清除
              </button>
            )}
          </div>

          {presentStatuses.length > 1 && (
            <div className="flex flex-wrap items-center gap-1.5 mb-1.5">
              <span className="text-[11px] font-semibold text-text-muted mr-0.5">状态</span>
              <button
                onClick={() => setStatusFilter(null)}
                className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors ${
                  statusFilter === null
                    ? 'bg-interactive-bg text-interactive border-interactive/30'
                    : 'bg-surface-primary text-text-muted border-border-primary hover:bg-surface-hover hover:text-text-secondary'
                }`}
              >
                全部
              </button>
              {presentStatuses.map(s => (
                <button
                  key={s}
                  onClick={() => setStatusFilter(statusFilter === s ? null : s)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors ${
                    statusFilter === s
                      ? `${STATUS_COLORS[s] ?? 'bg-surface-tertiary text-text-muted'} border-transparent`
                      : 'bg-surface-primary text-text-muted border-border-primary hover:bg-surface-hover hover:text-text-secondary'
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          )}

          {presentTypes.length > 1 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] font-semibold text-text-muted mr-0.5">类型</span>
              <button
                onClick={() => setTypeFilter(null)}
                className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors ${
                  typeFilter === null
                    ? 'bg-interactive-bg text-interactive border-interactive/30'
                    : 'bg-surface-primary text-text-muted border-border-primary hover:bg-surface-hover hover:text-text-secondary'
                }`}
              >
                全部
              </button>
              {presentTypes.map(t => (
                <button
                  key={t}
                  onClick={() => setTypeFilter(typeFilter === t ? null : t)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors ${
                    typeFilter === t
                      ? 'bg-interactive-bg text-interactive border-transparent'
                      : 'bg-surface-primary text-text-muted border-border-primary hover:bg-surface-hover hover:text-text-secondary'
                  }`}
                >
                  {TYPE_LABELS[t] ?? t}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {semi && showCreate && (
        <div className="p-4 border-b border-border-primary bg-surface-secondary space-y-2">
          <textarea
            placeholder="写下要议的问题，天机阁和相关弟子会围绕它形成完整议事记录..."
            value={createProposal}
            onChange={(e) => setCreateProposal(e.target.value)}
            rows={2}
            className="w-full px-2.5 py-1.5 text-sm border border-border-primary rounded-lg focus:outline-none focus:border-interactive bg-surface-primary text-text-primary placeholder:text-text-muted resize-y"
          />
          <div className="flex gap-2 items-center">
            <Select
              value={createType}
              onChange={setCreateType}
              className="flex-1"
              options={Object.entries(TYPE_LABELS).map(([k, v]) => ({ value: k, label: v }))}
            />
            <button
              onClick={handleCreate}
              disabled={!createProposal.trim()}
              className="text-sm bg-interactive text-text-invert px-4 py-2 rounded-lg hover:bg-interactive-hover disabled:opacity-50 disabled:cursor-not-allowed"
            >
              发起
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {!roomId ? (
          <div className="p-4 text-sm text-text-muted">请选择帮派查看议事记录。</div>
        ) : allDecisions.length === 0 && decisions ? (
          <div className="p-4 text-sm text-text-muted">
            {semi ? '暂无议事记录。可以发起一个问题让相关弟子讨论。' : '暂无议事记录。天机阁遇到无法独立判断的问题时会自动开议事堂。'}
          </div>
        ) : (
          <>
            {/* Pending (announced) */}
            {pending.length > 0 && (
              <div>
                <div className="px-3 py-1 text-xs font-medium text-text-muted uppercase tracking-wide bg-surface-secondary border-b border-border-primary">
                  进行中
                </div>
                <div className="grid gap-2 p-3 md:grid-cols-2">
                  {pending.map(d => (
                    <DecisionRow
                      key={d.id}
                      decision={d}
                      expanded={expandedId === d.id}
                      semi={semi}
                      actionError={expandedId === d.id ? actionError : null}
                      onToggle={() => { setExpandedId(expandedId === d.id ? null : d.id); setActionError(null) }}
                      onKeeperVote={(vote) => handleKeeperVote(d.id, vote)}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Resolved */}
            {resolved.length > 0 && (
              <div>
                <div className="px-3 py-1 text-xs font-medium text-text-muted uppercase tracking-wide bg-surface-secondary border-b border-border-primary">
                  议事记录
                </div>
                <div className="grid gap-2 p-3 md:grid-cols-2">
                  {resolved.map(d => (
                    <DecisionRow
                      key={d.id}
                      decision={d}
                      expanded={expandedId === d.id}
                      semi={semi}
                      actionError={expandedId === d.id ? actionError : null}
                      onToggle={() => { setExpandedId(expandedId === d.id ? null : d.id); setActionError(null) }}
                      onKeeperVote={(vote) => handleKeeperVote(d.id, vote)}
                    />
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
      <AutoModeLockModal open={showLockModal} onClose={closeLockModal} />
    </div>
  )
}

interface DecisionRowProps {
  decision: QuorumDecision
  expanded: boolean
  semi: boolean
  actionError: string | null
  onToggle: () => void
  onKeeperVote: (vote: string) => void
}

function DecisionRow({
  decision: d, expanded, semi, actionError,
  onToggle, onKeeperVote
}: DecisionRowProps): React.JSX.Element {
  const isPending = d.status === 'announced' || d.status === 'voting'

  return (
    <div className="bg-surface-secondary border border-border-primary rounded-lg overflow-hidden">
      <div
        className="flex items-center gap-2 px-3 py-2 hover:bg-surface-hover cursor-pointer"
        onClick={onToggle}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm text-text-primary line-clamp-1">{d.proposal}</span>
            <span className={`px-1.5 py-0.5 rounded-lg text-xs font-medium shrink-0 ${STATUS_COLORS[d.status] ?? 'bg-surface-tertiary text-text-muted'}`}>
              {d.status}
            </span>
            <span className="px-1.5 py-0.5 rounded-lg text-xs bg-surface-tertiary text-text-muted shrink-0">
              {TYPE_LABELS[d.decisionType] ?? d.decisionType}
            </span>
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-xs text-text-muted">{formatRelativeTime(d.createdAt)}</span>
            {d.status === 'announced' && d.effectiveAt && (
              <span className="text-xs text-orange-500">生效：{formatEffective(d.effectiveAt)}</span>
            )}
            {d.result && (
              <span className="text-xs text-text-muted truncate">{d.result}</span>
            )}
          </div>
        </div>
        <span className="text-sm text-text-muted">{expanded ? '\u25BC' : '\u25B6'}</span>
      </div>

      {expanded && (
        <div className="px-3 pb-3 pt-2 border-t border-border-primary bg-surface-secondary space-y-2">
          {/* Full proposal text */}
          <div className="text-sm text-text-primary whitespace-pre-wrap break-words">
            {d.proposal}
          </div>

          {/* Keeper actions for pending decisions */}
          {isPending && (
            <div className="flex items-center gap-2 py-1">
              <span className="text-xs font-medium text-text-secondary shrink-0">用户：</span>
              {d.keeperVote ? (
                <span className={`px-1.5 py-0.5 rounded-lg text-xs font-medium border ${
                  d.keeperVote === 'yes' ? 'bg-status-success-bg text-status-success border-green-200'
                    : d.keeperVote === 'no' ? 'bg-status-error-bg text-status-error border-red-200'
                    : 'bg-surface-tertiary text-text-muted border-border-primary'
                }`}>
                  {d.keeperVote === 'yes' ? '同意' : d.keeperVote === 'no' ? '反对' : d.keeperVote}
                </span>
              ) : (
                <>
                  <button
                    onClick={() => onKeeperVote('yes')}
                    className="text-xs px-3 py-2 md:px-2 md:py-1 rounded-lg border border-green-200 text-status-success hover:bg-green-50"
                  >
                    同意
                  </button>
                  <button
                    onClick={() => onKeeperVote('no')}
                    className="text-xs px-3 py-2 md:px-2 md:py-1 rounded-lg border border-red-200 text-status-error hover:bg-red-50"
                  >
                    反对
                  </button>
                </>
              )}
            </div>
          )}

          {actionError && (
            <div className="text-xs text-status-error">{actionError}</div>
          )}

          {/* Info */}
          <div className="flex gap-3 text-xs text-text-muted pt-1 border-t border-border-primary flex-wrap">
            {d.effectiveAt && <span>生效：{formatRelativeTime(d.effectiveAt)}</span>}
            {d.resolvedAt && <span>结束：{formatRelativeTime(d.resolvedAt)}</span>}
          </div>
        </div>
      )}
    </div>
  )
}
