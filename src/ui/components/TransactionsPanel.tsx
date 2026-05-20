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
  station_cost: '灵气资源成本',
  salary: '赏银',
  role_cost: '弟子协作耗气',
  company_transfer: '帮派间财气流动',
}

type BankRecordKind = 'salary' | 'income' | 'cost' | 'company_transfer'

interface TransactionsPanelProps {
  roomId: number | null
}

const RESOURCE_RULES = [
  ['铜钱', '基础推理和文本生成', '充足，用于日常执行；不能替代银两和金票。'],
  ['银两', '工具调用、搜索和数据处理', '按子任务分配；超支先由帮主调配。'],
  ['金票', '高成本模型、外部 API 和长时间任务', '稀缺，只能用于关键路径。'],
] as const

const SETTLEMENT_RULES = [
  ['结余', '子任务结余 60% 回收钱庄，40% 折算成效率积分写入弟子履历。'],
  ['轻微超支', '超支 10% 以内继续执行，但扣减成本效率。'],
  ['中度超支', '超支 10%-30% 降级使用低成本功法，并记录在档。'],
  ['严重超支', '超支 30% 以上挂红旗，本次不参与声望奖励池。'],
] as const

const PERFORMANCE_DIMENSIONS = [
  ['领域声望', '看这个岗位的完成质量，不代表所有领域都强。'],
  ['稳定度', '看返工率、格式错误率和输出一致性。'],
  ['协作度', '看是否准时、不阻塞下游、交接是否可用。'],
  ['成本效率', '看完成质量与实际消耗预算的比例。'],
  ['近期表现', '最近 5 次权重更高，防止旧声望长期躺赢。'],
] as const

const MATCHING_POLICIES = [
  ['质量优先', '领域声望 50% + 稳定度 30% + 成本效率 20%'],
  ['效率优先', '成本效率 50% + 近期表现 30% + 领域声望 20%'],
  ['均衡优先', '五个维度均权，适合大多数委托。'],
] as const

const TRUST_LEVELS = [
  ['新人', '0-40', '只领铜钱，银两和金票需帮主签批。'],
  ['普通', '40-70', '可领铜钱和银两，金票需签批。'],
  ['老手', '70-85', '三类资源均可领，有小额调配权。'],
  ['宗师', '85+', '可在帮派内自主追加 5% 预算缓冲。'],
] as const

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

        <div className="grid gap-3 md:grid-cols-3">
          {RESOURCE_RULES.map(([name, use, rule]) => (
            <div key={name} className="rounded-lg border border-border-primary bg-surface-secondary p-3">
              <div className="text-sm font-semibold text-text-primary">{name}</div>
              <div className="mt-1 text-xs text-text-secondary">{use}</div>
              <div className="mt-2 rounded-lg bg-surface-primary px-2 py-1.5 text-xs text-text-muted">{rule}</div>
            </div>
          ))}
        </div>

        <div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="rounded-lg border border-border-primary bg-surface-secondary p-3">
            <div className="text-sm font-semibold text-text-primary">预算流转</div>
            <div className="mt-3 grid gap-2 text-xs text-text-secondary md:grid-cols-4">
              <div className="rounded-lg bg-surface-primary p-2">钱庄按难度把整包预算拨给帮主。</div>
              <div className="rounded-lg bg-surface-primary p-2">帮主按子任务拆给弟子，弟子不能直接找钱庄要钱。</div>
              <div className="rounded-lg bg-surface-primary p-2">执行中记录消耗，轻微超支由帮主内部调配。</div>
              <div className="rounded-lg bg-surface-primary p-2">超过权限上报天机处，选择追加、降级或暂停。</div>
            </div>
            <div className="mt-3 rounded-lg bg-surface-primary p-2 text-xs text-text-muted">
              钱是任务级资源，用完即结算；声望是弟子履历资产，跨帮派长期生效。
            </div>
          </div>

          <div className="rounded-lg border border-border-primary bg-surface-secondary p-3">
            <div className="text-sm font-semibold text-text-primary">结算激励</div>
            <div className="mt-2 space-y-2">
              {SETTLEMENT_RULES.map(([label, text]) => (
                <div key={label} className="rounded-lg bg-surface-primary p-2">
                  <div className="text-xs font-semibold text-text-primary">{label}</div>
                  <div className="mt-1 text-xs leading-5 text-text-muted">{text}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-border-primary bg-surface-secondary p-3">
          <div className="text-sm font-semibold text-text-primary">履历绩效如何参与用钱</div>
          <div className="mt-2 grid gap-2 md:grid-cols-5">
            {PERFORMANCE_DIMENSIONS.map(([label, text]) => (
              <div key={label} className="rounded-lg bg-surface-primary p-2">
                <div className="text-xs font-semibold text-text-primary">{label}</div>
                <div className="mt-1 text-xs leading-5 text-text-muted">{text}</div>
              </div>
            ))}
          </div>
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

      <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
        <div className="rounded-lg border border-border-primary bg-surface-secondary p-3">
          <div className="text-sm font-semibold text-text-primary">本帮预算执行规则</div>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {SETTLEMENT_RULES.map(([label, text]) => (
              <div key={label} className="rounded-lg bg-surface-primary p-2">
                <div className="text-xs font-semibold text-text-primary">{label}</div>
                <div className="mt-1 text-xs leading-5 text-text-muted">{text}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-lg border border-border-primary bg-surface-secondary p-3">
          <div className="text-sm font-semibold text-text-primary">招募与预算信任</div>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {TRUST_LEVELS.map(([level, score, rule]) => (
              <div key={level} className="rounded-lg bg-surface-primary p-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-text-primary">{level}</span>
                  <span className="text-xs text-text-muted">{score} 分</span>
                </div>
                <div className="mt-1 text-xs leading-5 text-text-muted">{rule}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-border-primary bg-surface-secondary p-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div>
            <div className="text-sm font-semibold text-text-primary">任务需求决定用谁</div>
            <div className="mt-1 text-xs text-text-muted">声望不是总榜，帮主按委托优先级选择最适配的弟子。</div>
          </div>
          <div className="flex flex-wrap gap-2">
            {MATCHING_POLICIES.map(([label, text]) => (
              <div key={label} className="rounded-lg bg-surface-primary px-3 py-2">
                <div className="text-xs font-semibold text-text-primary">{label}</div>
                <div className="mt-1 text-xs text-text-muted">{text}</div>
              </div>
            ))}
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
