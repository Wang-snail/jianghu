import { useEffect, useMemo, useState } from 'react'
import { usePolling } from '../hooks/usePolling'
import { api } from '../lib/client'
import { ROOM_BALANCE_EVENT_TYPES } from '../lib/room-events'
import { wsClient, type WsMessage } from '../lib/ws'
import { formatRelativeTime } from '../utils/time'
import type { WalletTransaction, RevenueSummary, Wallet, Worker, WalletTransactionCategory } from '@shared/types'
import { isAssignableWorker } from '@shared/worker-roles'

const TYPE_COLORS: Record<string, string> = {
  receive: 'text-status-success',
  fund: 'text-status-success',
  send: 'text-status-error',
  purchase: 'text-status-error',
}

const CATEGORY_LABELS: Record<string, string> = {
  revenue: '财气入账',
  expense: '财气支出',
  transfer: '财气转移',
  station_cost: '历史资源成本',
  salary: '赏银',
  role_cost: '弟子协作耗气',
  company_transfer: '帮派间财气流动',
}

type BankRecordKind = 'salary' | 'income' | 'cost' | 'company_transfer'

interface TransactionsPanelProps {
  roomId: number | null
}

function money(n: number): string {
  return `${n.toFixed(2)} 财气`
}

function transactionAmount(tx: WalletTransaction): number {
  const n = Number(tx.amount)
  return Number.isFinite(n) ? n : 0
}

export function TransactionsPanel({ roomId }: TransactionsPanelProps): React.JSX.Element {
  const [recordKind, setRecordKind] = useState<BankRecordKind>('salary')
  const [amount, setAmount] = useState('')
  const [counterparty, setCounterparty] = useState('')
  const [selectedWorkerId, setSelectedWorkerId] = useState('')
  const [description, setDescription] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { data: wallet, refresh: refreshWallet } = usePolling<Wallet | null>(
    () => roomId ? api.wallet.get(roomId).catch(() => null) : Promise.resolve(null),
    60000
  )

  const { data: transactions, refresh: refreshTransactions } = usePolling<WalletTransaction[]>(
    () => roomId && wallet ? api.wallet.transactions(roomId).catch(() => []) : Promise.resolve([]),
    30000
  )

  const { data: summary, refresh: refreshSummary } = usePolling<RevenueSummary | null>(
    () => roomId ? api.wallet.summary(roomId).catch(() => null) : Promise.resolve(null),
    60000
  )

  const { data: workers } = usePolling<Worker[]>(
    () => roomId ? api.workers.listForRoom(roomId).catch(() => []) : Promise.resolve([]),
    60000
  )

  const { data: rooms } = usePolling(
    () => !roomId ? api.rooms.list().catch(() => []) : Promise.resolve([]),
    60000
  )

  useEffect(() => {
    if (!roomId) return
    return wsClient.subscribe(`room:${roomId}`, (event: WsMessage) => {
      if (ROOM_BALANCE_EVENT_TYPES.has(event.type)) {
        void refreshWallet()
        void refreshTransactions()
        void refreshSummary()
      }
    })
  }, [refreshSummary, refreshTransactions, refreshWallet, roomId])

  const salaryTotal = useMemo(() => {
    return (transactions ?? [])
      .filter(tx => tx.category === 'salary')
      .reduce((sum, tx) => sum + transactionAmount(tx), 0)
  }, [transactions])

  const collaborationCost = useMemo(() => {
    return (transactions ?? [])
      .filter(tx => tx.category === 'role_cost' || tx.category === 'company_transfer')
      .reduce((sum, tx) => sum + transactionAmount(tx), 0)
  }, [transactions])

  const assignableWorkers = useMemo(() => {
    return (workers ?? []).filter(worker => isAssignableWorker(worker))
  }, [workers])

  if (!roomId) {
    const activeRooms = (rooms ?? []).filter(room => room.status !== 'stopped')
    return (
      <div className="h-full overflow-y-auto p-4 space-y-4">
        <div>
          <h2 className="text-base font-semibold text-text-primary">钱庄</h2>
          <p className="text-xs text-text-muted mt-1">
            江湖公共资源预算场所。钱庄只管财气、预算、流水、赏银和成本效率，不处理真实世界资金。
          </p>
        </div>

        <div className="rounded-lg border border-border-primary bg-surface-secondary overflow-hidden">
          <div className="border-b border-border-primary px-3 py-2">
            <div className="text-sm font-semibold text-text-primary">临时帮派预算入口</div>
            <div className="text-xs text-text-muted">进入具体帮派后可记录赏银、协作耗气、帮派往来和项目内财气流水。</div>
          </div>
          <div className="divide-y divide-border-primary">
            {activeRooms.length === 0 && (
              <div className="px-3 py-5 text-sm text-text-muted">暂无临时帮派。</div>
            )}
            {activeRooms.map(room => (
              <div key={room.id} className="px-3 py-2">
                <div className="text-sm font-medium text-text-primary">{room.name}</div>
                <div className="text-xs text-text-muted">委托：{room.goal || '尚未设定'} · 状态：{room.status === 'active' ? '运行中' : room.status === 'paused' ? '闭关' : '已停摆'}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    )
  }

  const selectedWorker = workers?.find(w => String(w.id) === selectedWorkerId) ?? null
  const direction: 'income' | 'expense' = recordKind === 'income' ? 'income' : 'expense'
  const category: WalletTransactionCategory =
    recordKind === 'salary' ? 'salary'
      : recordKind === 'income' ? 'revenue'
        : recordKind === 'company_transfer' ? 'company_transfer'
          : 'role_cost'

  async function handleRecord(): Promise<void> {
    if (!roomId || !amount.trim()) return
    const parsed = Number(amount)
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError('金额必须大于 0。')
      return
    }
    const target = recordKind === 'salary'
      ? (selectedWorker ? `弟子：${selectedWorker.name}` : counterparty.trim())
      : counterparty.trim()
    if (!target) {
      setError(recordKind === 'salary' ? '请选择弟子或填写收款弟子。' : '请填写对方帮派、弟子或来源。')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await api.wallet.record(roomId, {
        direction,
        amount: parsed.toFixed(2),
        category,
        counterparty: target,
        description: description.trim() || (
          recordKind === 'salary'
            ? '赏银依据：弟子是否解决问题、进展是否靠近委托目标。'
            : undefined
        ),
      })
      setAmount('')
      setCounterparty('')
      setSelectedWorkerId('')
      setDescription('')
      void refreshTransactions()
      void refreshSummary()
    } catch (e) {
      setError(e instanceof Error ? e.message : '记录失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-base font-semibold text-text-primary">钱庄</h2>
          <p className="text-xs text-text-muted mt-1">
            钱庄只处理当前项目内部的财气、余额、流水、赏银、成本和帮派间流动，不与真实世界资金发生关联。
          </p>
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-lg bg-interactive-bg p-3">
          <div className="text-xs text-interactive">钱庄余额</div>
          <div className="text-lg font-semibold text-interactive">{money(summary?.netProfit ?? 0)}</div>
        </div>
        <div className="rounded-lg bg-status-success-bg p-3">
          <div className="text-xs text-status-success">财气入账</div>
          <div className="text-lg font-semibold text-status-success">{money(summary?.totalIncome ?? 0)}</div>
        </div>
        <div className="rounded-lg bg-status-error-bg p-3">
          <div className="text-xs text-status-error">财气支出</div>
          <div className="text-lg font-semibold text-status-error">{money(summary?.totalExpenses ?? 0)}</div>
        </div>
        <div className="rounded-lg bg-surface-secondary p-3">
          <div className="text-xs text-text-muted">赏银 / 协作耗气</div>
          <div className="text-sm text-text-secondary mt-1">
            赏银 {money(salaryTotal)} · 协作 {money(collaborationCost)}
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-border-primary bg-surface-secondary p-3 space-y-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div>
            <div className="text-sm font-semibold text-text-primary">记录钱庄流水</div>
            <div className="text-xs text-text-muted">可记录帮派给弟子发赏银、帮派间协助成本、弟子间协作成本和项目内财气入账。</div>
          </div>
          <div className="flex gap-1 rounded-lg bg-surface-primary p-1">
            {([
              ['salary', '发赏银'],
              ['cost', '协作耗气'],
              ['company_transfer', '帮派往来'],
              ['income', '财气入账'],
            ] as Array<[BankRecordKind, string]>).map(([kind, label]) => (
              <button
                key={kind}
                onClick={() => setRecordKind(kind)}
                className={`text-xs px-2 py-1 rounded ${recordKind === kind ? 'bg-interactive text-text-invert' : 'text-text-muted hover:text-text-secondary'}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="grid gap-2 md:grid-cols-4">
          <input
            type="number"
            min="0"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="金额"
            className="px-2.5 py-1.5 text-sm border border-border-primary rounded-lg focus:outline-none focus:border-text-muted bg-surface-primary text-text-primary placeholder:text-text-muted"
          />
          {recordKind === 'salary' ? (
            <select
              value={selectedWorkerId}
              onChange={(e) => {
                setSelectedWorkerId(e.target.value)
                if (e.target.value) setCounterparty('')
              }}
              className="px-2.5 py-1.5 text-sm border border-border-primary rounded-lg focus:outline-none focus:border-text-muted bg-surface-primary text-text-primary"
            >
              <option value="">选择弟子</option>
              {assignableWorkers.map(worker => (
                <option key={worker.id} value={worker.id}>{worker.name}{worker.role ? ` · ${worker.role}` : ''}</option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={counterparty}
              onChange={(e) => setCounterparty(e.target.value)}
              placeholder={recordKind === 'income' ? '财气来源' : recordKind === 'company_transfer' ? '对方帮派' : '协作弟子'}
              className="px-2.5 py-1.5 text-sm border border-border-primary rounded-lg focus:outline-none focus:border-text-muted bg-surface-primary text-text-primary placeholder:text-text-muted"
            />
          )}
          {recordKind === 'salary' && (
            <input
              type="text"
              value={counterparty}
              onChange={(e) => {
                setCounterparty(e.target.value)
                if (e.target.value) setSelectedWorkerId('')
              }}
              placeholder="或手动填写弟子"
              className="px-2.5 py-1.5 text-sm border border-border-primary rounded-lg focus:outline-none focus:border-text-muted bg-surface-primary text-text-primary placeholder:text-text-muted"
            />
          )}
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={recordKind === 'salary' ? '发赏依据：解决了什么、离委托更近多少' : '说明原因和成本依据'}
            className="px-2.5 py-1.5 text-sm border border-border-primary rounded-lg focus:outline-none focus:border-text-muted bg-surface-primary text-text-primary placeholder:text-text-muted md:col-span-2"
          />
        </div>
        {error && <div className="text-xs text-status-error">{error}</div>}
        <button
          onClick={() => void handleRecord()}
          disabled={saving || !amount.trim()}
          className="text-sm bg-interactive text-text-invert px-4 py-2 rounded-lg hover:bg-interactive-hover disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving ? '记录中...' : '写入钱庄流水'}
        </button>
      </div>

      {(!transactions || transactions.length === 0) ? (
        <div className="text-sm text-text-muted py-6 text-center">
          暂无流水。天机阁可以从这里记录赏银、成本、收入和帮派/弟子之间的财气流动。
        </div>
      ) : (
        <div className="space-y-2">
          {(transactions ?? []).map(tx => (
            <div key={tx.id} className="bg-surface-secondary rounded-lg p-3 shadow-sm flex items-center gap-2">
              <div className={`text-sm font-medium w-20 ${TYPE_COLORS[tx.type] ?? 'text-text-secondary'}`}>
                {tx.type === 'receive' || tx.type === 'fund' ? '入账' : '出账'}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm text-text-secondary truncate">
                  {CATEGORY_LABELS[tx.category ?? ''] ?? tx.category ?? '未分类'}
                  {tx.counterparty ? ` · ${tx.counterparty}` : ''}
                </div>
                {tx.description && (
                  <div className="text-xs text-text-muted truncate">{tx.description}</div>
                )}
              </div>
              <div className="text-right shrink-0">
                <div className={`text-sm font-semibold ${TYPE_COLORS[tx.type] ?? 'text-text-secondary'}`}>
                  {tx.type === 'receive' || tx.type === 'fund' ? '+' : '-'}{tx.amount} 财气
                </div>
                <div className="text-xs text-text-muted">{formatRelativeTime(tx.createdAt)}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
