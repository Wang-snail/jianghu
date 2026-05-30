import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import { usePolling } from '../hooks/usePolling'
import { api } from '../lib/client'
import type { Room, Task, Worker } from '@shared/types'

type TianjiMessage = {
  id: number
  role: 'user' | 'tianji'
  content: string
}

type DetailKind = 'rooms' | 'workers' | 'tasks' | 'risks'

const THINKING_STAGES = [
  { title: '正在理解委托', detail: '天机阁先判断这是查询、建帮还是调整江湖事务。' },
  { title: '正在唤醒 Hermes', detail: '只启动本轮需要的本地能力，避免上下文膨胀。' },
  { title: '正在执行本地动作', detail: '如果是创建或调整，会直接落到当前江湖数据里。' },
]

interface TianjiPanelProps {
  onOpenCommission?: () => void
  onOpenOverview?: () => void
  onRoomsChanged?: () => void | Promise<void>
}

function statusLabel(status: string): string {
  if (status === 'active') return '运行中'
  if (status === 'paused') return '闭关'
  if (status === 'stopped') return '已停摆'
  return status
}

function containsBackendError(text: string): boolean {
  const lower = text.toLowerCase()
  return lower.includes('api key')
    || lower.includes('external api')
    || lower.includes('invalid key')
    || lower.includes('missing key')
    || lower.includes('unauthorized')
    || lower.includes('401')
    || lower.includes('502')
}

function hasCreateGangIntent(text: string): boolean {
  return /(?:新建|创建|成立|开|建)(?:一个|一支|个|支|临时)?帮派/.test(text)
    || /帮派.*(?:新建|创建|成立)/.test(text)
    || /(?:新建|创建|成立|建立|开|建)(?:一个|一支|个|支|临时)?\s*[^，。,.；;：:！!？?、\n]{2,40}?帮(?:$|[\s，。,.；;：:！!？?、])/.test(text)
}

export function TianjiPanel({
  onOpenCommission,
  onOpenOverview,
  onRoomsChanged,
}: TianjiPanelProps = {}): React.JSX.Element {
  const { data: rooms } = usePolling(() => api.rooms.list(), 30000)
  const { data: tasks } = usePolling(() => api.tasks.list(undefined), 30000)
  const { data: workers } = usePolling(() => api.workers.list(), 30000)
  const { data: aiStatus } = usePolling(() => api.clerk.status().catch(() => null), 30000)
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(false)
  const [thinkingStep, setThinkingStep] = useState(0)
  const [messages, setMessages] = useState<TianjiMessage[]>([])
  const [openDetail, setOpenDetail] = useState<DetailKind | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const activeRooms = useMemo(() => (rooms ?? []).filter(room => room.status !== 'stopped'), [rooms])
  const blockedRooms = useMemo(() => activeRooms.filter(room => room.status === 'paused'), [activeRooms])
  const activeTasks = useMemo(() => (tasks ?? []).filter(task => task.status !== 'paused'), [tasks])
  const blockedTasks = useMemo(() => (tasks ?? []).filter(task => task.status === 'paused' || task.errorCount > 0), [tasks])
  const roomNameById = useMemo(() => new Map((rooms ?? []).map(room => [room.id, room.name])), [rooms])
  const workerNameById = useMemo(() => new Map((workers ?? []).map(worker => [worker.id, worker.name])), [workers])
  const workerCount = workers?.length ?? 0
  const riskCount = blockedRooms.length + blockedTasks.length
  const aiLabel = aiStatus?.model ? `AI 已接入：${aiStatus.model}` : 'AI 待接入 · 本地兜底'
  const thinking = THINKING_STAGES[thinkingStep % THINKING_STAGES.length]

  const detailCards = [
    { kind: 'rooms' as const, label: '临时帮派', value: activeRooms.length, hint: '围绕委托成立的项目组', valueClass: 'text-text-primary' },
    { kind: 'workers' as const, label: '门下弟子', value: workers?.length ?? 0, hint: '最小执行单元', valueClass: 'text-text-primary' },
    { kind: 'tasks' as const, label: '帮主进度', value: activeTasks.length, hint: '各帮主正在推进的镖单', valueClass: 'text-text-primary' },
    { kind: 'risks' as const, label: '风险与看守', value: riskCount, hint: '需要天机处关注', valueClass: 'text-status-warning' },
  ]

  function roomName(roomId: number | null | undefined): string {
    if (roomId == null) return '客栈 / 公共场所'
    return roomNameById.get(roomId) ?? `帮派 #${roomId}`
  }

  function workerName(workerId: number | null | undefined): string {
    if (workerId == null) return '未分派'
    return workerNameById.get(workerId) ?? `弟子 #${workerId}`
  }

  useEffect(() => {
    if (!loading) {
      setThinkingStep(0)
      return undefined
    }

    const timer = window.setInterval(() => {
      setThinkingStep(prev => (prev + 1) % THINKING_STAGES.length)
    }, 1400)
    return () => window.clearInterval(timer)
  }, [loading])

  function applyLocalShortcut(question: string): string | null {
    if (hasCreateGangIntent(question)) return null
    if (/(发布|委托|发帖|需求)/.test(question)) {
      onOpenCommission?.()
      return '已为你打开发布江湖帖。先和需求澄清师把目标说清楚，确认后再交给天机阁调度。'
    }
    if (/(纵览|总览|全局|我的江湖)/.test(question)) {
      onOpenOverview?.()
      return '已切到江湖纵览。那里能一眼看到每支帮派当前动作、弟子状态、预算和沉淀结果。'
    }
    return null
  }

  function buildLocalSummary(): string {
    const blockedRoomNames = blockedRooms.map(room => room.name).slice(0, 3)
    const activeRoomNames = activeRooms.map(room => `${room.name}（${statusLabel(room.status)}）`).slice(0, 4)
    const roomLine = activeRoomNames.length > 0
      ? `当前帮派：${activeRoomNames.join('、')}。`
      : '当前没有正在展示的临时帮派。'
    const riskLine = riskCount > 0
      ? `需要关注 ${riskCount} 项风险或看守：${blockedRoomNames.length > 0 ? blockedRoomNames.join('、') : '镖单存在阻塞或返工记录'}。`
      : '暂未发现看守或阻塞项。'
    const nextLine = activeRooms.length === 0
      ? '下一步建议：先发布江湖帖，把目标澄清成可执行委托。'
      : riskCount > 0
        ? '下一步建议：先处理阻塞，再继续扩张帮派或追加预算。'
        : '下一步建议：保持当前节奏，重点看作战室里的最新动向和交付沉淀。'

    return `当前江湖：临时帮派 ${activeRooms.length} 支，弟子 ${workerCount} 位，推进中镖单 ${activeTasks.length} 张，风险/看守 ${riskCount} 项。${roomLine}${riskLine}${nextLine}`
  }

  function isStatusQuestion(text: string): boolean {
    return /(江湖现在|现在怎样|状态|进展|哪里卡|卡住|纵览|总览|全局|风险|闭关|看守|阻塞)/.test(text)
  }

  function fallbackReplyFor(content: string): string {
    if (isStatusQuestion(content)) return `我先按当前江湖数据判断：${buildLocalSummary()}`
    return '这次没有完成操作：当前模型连接异常。你可以先到设置里检查 AI 接入；明确的本地动作（例如“新建一个帮派，用于……”）我会直接执行。'
  }

  async function sendToTianji(text: string): Promise<void> {
    const content = text.trim()
    if (!content || loading) return
    const userMessage: TianjiMessage = { id: Date.now(), role: 'user', content }
    setMessages(prev => [...prev, userMessage])
    setDraft('')

    const shortcutReply = applyLocalShortcut(content)
    if (shortcutReply) {
      setMessages(prev => [...prev, {
        id: Date.now() + 1,
        role: 'tianji',
        content: shortcutReply,
      }])
      return
    }

    setLoading(true)
    try {
      const result = await api.clerk.send(content)
      await onRoomsChanged?.()
      const response = result.response?.trim() ?? ''
      setMessages(prev => [...prev, {
        id: Date.now() + 1,
        role: 'tianji',
        content: response && !containsBackendError(response)
          ? response
          : fallbackReplyFor(content),
      }])
    } catch (err) {
      setMessages(prev => [...prev, {
        id: Date.now() + 1,
        role: 'tianji',
        content: fallbackReplyFor(content),
      }])
    } finally {
      setLoading(false)
    }
  }

  function prepareCreateGangDraft(): void {
    setDraft('我要创建一个新帮派，目标是：')
    window.setTimeout(() => inputRef.current?.focus(), 0)
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    void sendToTianji(draft)
  }

  function detailHeader(kind: DetailKind): string {
    if (kind === 'rooms') return '临时帮派详情'
    if (kind === 'workers') return '门下弟子详情'
    if (kind === 'tasks') return '帮主进度详情'
    return '风险与看守详情'
  }

  function detailHint(kind: DetailKind): string {
    if (kind === 'rooms') return '查看当前江湖里每支临时帮派的状态、帮主和委托目标。'
    if (kind === 'workers') return '查看在册弟子的所属位置、状态和承接记录。'
    if (kind === 'tasks') return '查看各帮主正在推进或已记录的镖单、承接弟子和最近结果。'
    return '查看需要天机处关注的看守对象、阻塞原因和下一步处理方向。'
  }

  function renderRoomDetail(room: Room): React.ReactNode {
    const leader = workerName(room.queenWorkerId)
    return (
      <div key={room.id} className="rounded-lg border border-border-secondary bg-surface-primary p-3">
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${room.status === 'active' ? 'bg-status-success' : room.status === 'paused' ? 'bg-status-warning' : 'bg-text-muted'}`} />
          <div className="min-w-0 flex-1 truncate text-sm font-semibold text-text-primary">{room.name}</div>
          <span className="text-xs text-text-muted">{statusLabel(room.status)}</span>
        </div>
        <div className="mt-2 grid gap-1 text-xs leading-5 text-text-muted sm:grid-cols-2">
          <div>帮主：<span className="text-text-secondary">{leader}</span></div>
          <div>更新：<span className="text-text-secondary">{room.updatedAt}</span></div>
          <div className="sm:col-span-2">委托：<span className="text-text-secondary">{room.goal || '尚未设定'}</span></div>
        </div>
      </div>
    )
  }

  function renderWorkerDetail(worker: Worker): React.ReactNode {
    const stateLabel = worker.agentState === 'acting'
      ? '行动中'
      : worker.agentState === 'thinking'
        ? '思考中'
        : worker.agentState === 'blocked'
          ? '阻塞'
          : worker.agentState === 'rate_limited'
            ? '限流'
            : '待命'
    return (
      <div key={worker.id} className="rounded-lg border border-border-secondary bg-surface-primary p-3">
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${worker.agentState === 'acting' || worker.agentState === 'thinking' ? 'animate-pulse bg-status-success' : worker.agentState === 'blocked' || worker.agentState === 'rate_limited' ? 'bg-status-warning' : 'bg-text-muted'}`} />
          <div className="min-w-0 flex-1 truncate text-sm font-semibold text-text-primary">{worker.name}</div>
          <span className="text-xs text-text-muted">{stateLabel}</span>
        </div>
        <div className="mt-2 grid gap-1 text-xs leading-5 text-text-muted sm:grid-cols-2">
          <div>所在：<span className="text-text-secondary">{roomName(worker.roomId)}</span></div>
          <div>职责：<span className="text-text-secondary">{worker.role || '未标注'}</span></div>
          <div>承接：<span className="text-text-secondary">{worker.taskCount} 张镖单</span></div>
          <div>模型：<span className="text-text-secondary">{worker.model || '跟随帮派设置'}</span></div>
        </div>
      </div>
    )
  }

  function renderTaskDetail(task: Task): React.ReactNode {
    return (
      <div key={task.id} className="rounded-lg border border-border-secondary bg-surface-primary p-3">
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${task.status === 'active' ? 'animate-pulse bg-status-success' : task.status === 'paused' ? 'bg-status-warning' : 'bg-text-muted'}`} />
          <div className="min-w-0 flex-1 truncate text-sm font-semibold text-text-primary">{task.name}</div>
          <span className="text-xs text-text-muted">{task.status === 'active' ? '推进中' : task.status === 'paused' ? '看守中' : '已完成'}</span>
        </div>
        <div className="mt-2 grid gap-1 text-xs leading-5 text-text-muted sm:grid-cols-2">
          <div>所属：<span className="text-text-secondary">{roomName(task.roomId)}</span></div>
          <div>承接：<span className="text-text-secondary">{workerName(task.workerId)}</span></div>
          <div>运行：<span className="text-text-secondary">{task.runCount} 次</span></div>
          <div>异常：<span className={task.errorCount > 0 ? 'text-status-warning' : 'text-text-secondary'}>{task.errorCount} 次</span></div>
          <div className="sm:col-span-2">最近结果：<span className="text-text-secondary">{task.lastResult || task.description || '暂无结果记录'}</span></div>
        </div>
      </div>
    )
  }

  function renderDetailBody(kind: DetailKind): React.ReactNode {
    if (kind === 'rooms') {
      if (activeRooms.length === 0) return <div className="px-3 py-6 text-center text-sm text-text-muted">暂无临时帮派。</div>
      return <div className="grid gap-2 lg:grid-cols-2">{activeRooms.map(renderRoomDetail)}</div>
    }
    if (kind === 'workers') {
      const workerList = workers ?? []
      if (workerList.length === 0) return <div className="px-3 py-6 text-center text-sm text-text-muted">暂无在册弟子。</div>
      return <div className="grid gap-2 lg:grid-cols-2">{workerList.map(renderWorkerDetail)}</div>
    }
    if (kind === 'tasks') {
      if (activeTasks.length === 0) return <div className="px-3 py-6 text-center text-sm text-text-muted">暂无正在推进的镖单。</div>
      return <div className="grid gap-2 lg:grid-cols-2">{activeTasks.map(renderTaskDetail)}</div>
    }

    if (riskCount === 0) return <div className="px-3 py-6 text-center text-sm text-text-muted">暂无需要看守的风险。</div>
    return (
      <div className="grid gap-2 lg:grid-cols-2">
        {blockedRooms.map(room => (
          <div key={`room-risk-${room.id}`} className="rounded-lg border border-status-warning/40 bg-status-warning-bg p-3 text-status-warning">
            <div className="text-sm font-semibold">{room.name} · 看守中</div>
            <div className="mt-1 text-xs leading-5 opacity-90">帮派暂停或阻塞，天机处需要确认原因、责任人和恢复条件。</div>
            <div className="mt-2 text-xs opacity-80">委托：{room.goal || '尚未设定'}</div>
          </div>
        ))}
        {blockedTasks.map(task => (
          <div key={`task-risk-${task.id}`} className="rounded-lg border border-status-warning/40 bg-status-warning-bg p-3 text-status-warning">
            <div className="text-sm font-semibold">{task.name} · {task.errorCount >= 2 ? '拘押复核' : '看守中'}</div>
            <div className="mt-1 text-xs leading-5 opacity-90">
              {task.errorCount > 0 ? `最近异常 ${task.errorCount} 次，先找根因再继续。` : '镖单暂停，需确认是否恢复推进或归档。'}
            </div>
            <div className="mt-2 text-xs opacity-80">承接：{workerName(task.workerId)} · 所属：{roomName(task.roomId)}</div>
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="border-b border-border-primary bg-surface-primary px-4 py-3">
        <div className="text-lg font-semibold text-text-primary">天机阁</div>
        <div className="mt-1 text-sm text-text-muted">
          江湖任务理解与组织创建中心。用户只提交委托，天机处负责理解目标、成立临时帮派、任命帮主、监督结果和控制风险。
        </div>
      </div>

      <div className="p-4 pb-0">
        <div className="rounded-lg border border-border-primary bg-surface-secondary overflow-hidden">
          <div className="border-b border-border-primary px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="text-sm font-semibold text-text-primary">江湖问事</div>
                <div className="text-xs text-text-muted">你和天机阁对话，了解全局或发起江湖操作。</div>
              </div>
              <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] ${aiStatus?.model ? 'bg-status-success-bg text-status-success' : 'bg-surface-primary text-text-muted'}`}>
                <span className="inline-flex items-center gap-1.5">
                  <span className={`h-1.5 w-1.5 rounded-full ${loading ? 'animate-pulse bg-interactive' : aiStatus?.model ? 'bg-status-success' : 'bg-text-muted'}`} />
                  {loading ? '天机阁推演中' : aiLabel}
                </span>
              </span>
            </div>
          </div>
          {(messages.length > 0 || loading) && (
            <div className="max-h-72 overflow-y-auto px-3 py-3 space-y-2">
              {messages.map(message => (
                <div key={message.id} className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[88%] rounded-lg px-3 py-2 text-sm leading-6 ${
                    message.role === 'user'
                      ? 'bg-interactive text-text-invert'
                      : 'bg-surface-primary text-text-secondary border border-border-secondary'
                  }`}>
                    <div className={`mb-0.5 text-[10px] font-semibold ${message.role === 'user' ? 'text-text-invert/70' : 'text-text-muted'}`}>
                      {message.role === 'user' ? '你' : '天机阁'}
                    </div>
                    {message.content}
                  </div>
                </div>
              ))}
              {loading && (
                <div className="flex justify-start">
                  <div className="max-w-[88%] rounded-lg border border-border-secondary bg-surface-primary px-3 py-2 text-sm text-text-muted">
                    <div className="mb-1 flex items-center gap-2 text-text-secondary">
                      <span className="relative flex h-2.5 w-2.5">
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-interactive opacity-60" />
                        <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-interactive" />
                      </span>
                      <span className="font-medium">{thinking.title}</span>
                      <span className="inline-flex gap-0.5" aria-hidden="true">
                        <span className="h-1 w-1 animate-bounce rounded-full bg-text-muted" />
                        <span className="h-1 w-1 animate-bounce rounded-full bg-text-muted [animation-delay:120ms]" />
                        <span className="h-1 w-1 animate-bounce rounded-full bg-text-muted [animation-delay:240ms]" />
                      </span>
                    </div>
                    <div className="text-xs leading-5 text-text-muted">{thinking.detail}</div>
                  </div>
                </div>
              )}
            </div>
          )}
          <div className="border-t border-border-primary px-3 py-3">
            <div className="mb-2 flex flex-wrap gap-1.5">
              {['江湖现在怎样？', '哪里卡住了？', '发布新委托'].map(label => (
                <button
                  key={label}
                  type="button"
                  onClick={() => {
                    void sendToTianji(label)
                  }}
                  disabled={loading}
                  className="rounded-full border border-border-secondary px-2.5 py-1 text-xs text-text-secondary hover:border-interactive hover:text-interactive transition-colors"
                >
                  {label}
                </button>
              ))}
              <button
                type="button"
                onClick={prepareCreateGangDraft}
                disabled={loading}
                className="rounded-full border border-border-secondary px-2.5 py-1 text-xs text-text-secondary hover:border-interactive hover:text-interactive transition-colors"
              >
                新建帮派
              </button>
            </div>
            <form onSubmit={handleSubmit} className="flex gap-2">
              <input
                ref={inputRef}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                disabled={loading}
                placeholder="问天机阁江湖状态，或下达操作意图..."
                className="min-w-0 flex-1 rounded-lg border border-border-primary bg-surface-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-interactive focus:outline-none"
              />
              <button
                type="submit"
                disabled={loading || !draft.trim()}
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-interactive px-4 py-2 text-sm font-medium text-text-invert hover:bg-interactive-hover disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
              >
                {loading && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-text-invert/40 border-t-text-invert" />}
                {loading ? '推演中' : '发送给天机阁'}
              </button>
            </form>
          </div>
        </div>
      </div>

      <div className="grid gap-3 p-4 md:grid-cols-4">
        {detailCards.map(card => {
          const selected = openDetail === card.kind
          return (
            <button
              key={card.kind}
              type="button"
              onClick={() => setOpenDetail(selected ? null : card.kind)}
              aria-expanded={selected}
              className={`group rounded-lg border bg-surface-secondary p-3 text-left transition-colors focus:outline-none focus:ring-2 focus:ring-interactive/40 ${
                selected ? 'border-interactive/70 bg-surface-hover' : 'border-border-primary hover:border-interactive/60 hover:bg-surface-hover'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs text-text-muted">{card.label}</div>
                <div className="text-[11px] text-interactive opacity-0 transition-opacity group-hover:opacity-100 group-focus:opacity-100">
                  {selected ? '收起' : '详情'}
                </div>
              </div>
              <div className={`mt-1 text-2xl font-semibold ${card.valueClass}`}>{card.value}</div>
              <div className="mt-1 text-xs text-text-muted">{card.hint}</div>
            </button>
          )
        })}
      </div>

      {openDetail && (
        <div className="px-4 pb-4">
          <div className="rounded-lg border border-border-primary bg-surface-secondary overflow-hidden">
            <div className="flex items-start justify-between gap-3 border-b border-border-primary px-3 py-2">
              <div>
                <div className="text-sm font-semibold text-text-primary">{detailHeader(openDetail)}</div>
                <div className="mt-0.5 text-xs text-text-muted">{detailHint(openDetail)}</div>
              </div>
              <button
                type="button"
                onClick={() => setOpenDetail(null)}
                className="rounded-md border border-border-secondary px-2 py-1 text-xs text-text-secondary hover:border-interactive hover:text-interactive"
              >
                关闭
              </button>
            </div>
            <div className="p-3">
              {renderDetailBody(openDetail)}
            </div>
          </div>
        </div>
      )}

      <div className="px-4 pb-4">
        <div className="rounded-lg border border-border-primary bg-surface-secondary overflow-hidden">
          <div className="border-b border-border-primary px-3 py-2">
            <div className="text-sm font-semibold text-text-primary">临时帮派总览</div>
            <div className="text-xs text-text-muted">帮派为当前委托成立，任务结束后经验归档、成员履历更新，再自动解散。</div>
          </div>
          <div className="divide-y divide-border-primary">
            {activeRooms.length === 0 && (
              <div className="px-3 py-6 text-center text-sm text-text-muted">暂无临时帮派。直接在上方告诉天机阁你的目标，它会自动创建和管理帮派。</div>
            )}
            {activeRooms.map(room => (
              <div key={room.id} className="px-3 py-3">
                <div className="flex items-center gap-2">
                  <span className={`h-2 w-2 rounded-full ${room.status === 'active' ? 'animate-pulse bg-status-success' : room.status === 'paused' ? 'bg-status-warning' : 'bg-text-muted'}`} />
                  <div className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">{room.name}</div>
                  <span className="text-xs text-text-muted">{statusLabel(room.status)}</span>
                </div>
                <div className="mt-1 truncate text-xs text-text-muted">
                  委托：{room.goal || '尚未设定'}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
