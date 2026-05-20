import { type FormEvent, useMemo, useState } from 'react'
import { usePolling } from '../hooks/usePolling'
import { api } from '../lib/client'

type TianjiMessage = {
  id: number
  role: 'user' | 'tianji'
  content: string
}

interface TianjiPanelProps {
  onOpenCommission?: () => void
  onCreateGang?: () => void
  onOpenOverview?: () => void
}

function statusLabel(status: string): string {
  if (status === 'active') return '运行中'
  if (status === 'paused') return '闭关'
  if (status === 'stopped') return '已停摆'
  return status
}

export function TianjiPanel({
  onOpenCommission,
  onCreateGang,
  onOpenOverview,
}: TianjiPanelProps = {}): React.JSX.Element {
  const { data: rooms } = usePolling(() => api.rooms.list(), 30000)
  const { data: tasks } = usePolling(() => api.tasks.list(undefined), 30000)
  const { data: workers } = usePolling(() => api.workers.list(), 30000)
  const { data: aiStatus } = usePolling(() => api.clerk.status().catch(() => null), 30000)
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(false)
  const [messages, setMessages] = useState<TianjiMessage[]>([])

  const activeRooms = useMemo(() => (rooms ?? []).filter(room => room.status !== 'stopped'), [rooms])
  const blockedRooms = useMemo(() => activeRooms.filter(room => room.status === 'paused'), [activeRooms])
  const activeTasks = useMemo(() => (tasks ?? []).filter(task => task.status !== 'paused'), [tasks])
  const blockedTasks = useMemo(() => (tasks ?? []).filter(task => task.status === 'paused' || task.errorCount > 0), [tasks])
  const workerCount = workers?.length ?? 0
  const riskCount = blockedRooms.length + blockedTasks.length
  const aiLabel = aiStatus?.model ? `AI 已接入：${aiStatus.model}` : 'AI 待接入 · 本地兜底'

  function applyLocalShortcut(question: string): string | null {
    if (/(发布|委托|发帖|需求)/.test(question)) {
      onOpenCommission?.()
      return '已为你打开发布江湖帖。先和需求澄清师把目标说清楚，确认后再交给天机阁调度。'
    }
    if (/(新建|创建|成立).*(帮派|堂口)|帮派.*(新建|创建|成立)/.test(question)) {
      onCreateGang?.()
      return '已为你打开新建临时帮派。填写名称和委托后，天机阁会接手后续调度。'
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
      ? `需要关注 ${riskCount} 项风险或闭关：${blockedRoomNames.length > 0 ? blockedRoomNames.join('、') : '镖单存在阻塞或返工记录'}。`
      : '暂未发现闭关或阻塞项。'
    const nextLine = activeRooms.length === 0
      ? '下一步建议：先发布江湖帖，把目标澄清成可执行委托。'
      : riskCount > 0
        ? '下一步建议：先处理阻塞，再继续扩张帮派或追加预算。'
        : '下一步建议：保持当前节奏，重点看作战室里的最新动向和交付沉淀。'

    return `当前江湖：临时帮派 ${activeRooms.length} 支，弟子 ${workerCount} 位，押运镖单 ${activeTasks.length} 张，风险/闭关 ${riskCount} 项。${roomLine}${riskLine}${nextLine}`
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
      setMessages(prev => [...prev, {
        id: Date.now() + 1,
        role: 'tianji',
        content: result.response || buildLocalSummary(),
      }])
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'AI 暂时无法回答'
      setMessages(prev => [...prev, {
        id: Date.now() + 1,
        role: 'tianji',
        content: `AI 暂时没有接通，我先按本地数据给你判断。${buildLocalSummary()}（${reason}）`,
      }])
    } finally {
      setLoading(false)
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    void sendToTianji(draft)
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
                {loading ? 'AI 推演中' : aiLabel}
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
                  <div className="rounded-lg border border-border-secondary bg-surface-primary px-3 py-2 text-sm text-text-muted">
                    天机阁正在调用 AI 推演...
                  </div>
                </div>
              )}
            </div>
          )}
          <div className="border-t border-border-primary px-3 py-3">
            <div className="mb-2 flex flex-wrap gap-1.5">
              {['江湖现在怎样？', '哪里卡住了？', '发布新委托', '新建帮派'].map(label => (
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
            </div>
            <form onSubmit={handleSubmit} className="flex gap-2">
              <input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                disabled={loading}
                placeholder="问天机阁江湖状态，或下达操作意图..."
                className="min-w-0 flex-1 rounded-lg border border-border-primary bg-surface-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-interactive focus:outline-none"
              />
              <button
                type="submit"
                disabled={loading || !draft.trim()}
                className="rounded-lg bg-interactive px-4 py-2 text-sm font-medium text-text-invert hover:bg-interactive-hover disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
              >
                {loading ? '推演中...' : '发送给天机阁'}
              </button>
            </form>
          </div>
        </div>
      </div>

      <div className="grid gap-3 p-4 md:grid-cols-4">
        <div className="rounded-lg border border-border-primary bg-surface-secondary p-3">
          <div className="text-xs text-text-muted">临时帮派</div>
          <div className="mt-1 text-2xl font-semibold text-text-primary">{activeRooms.length}</div>
          <div className="mt-1 text-xs text-text-muted">围绕委托成立的项目组</div>
        </div>
        <div className="rounded-lg border border-border-primary bg-surface-secondary p-3">
          <div className="text-xs text-text-muted">门下弟子</div>
          <div className="mt-1 text-2xl font-semibold text-text-primary">{workers?.length ?? 0}</div>
          <div className="mt-1 text-xs text-text-muted">最小执行单元</div>
        </div>
        <div className="rounded-lg border border-border-primary bg-surface-secondary p-3">
          <div className="text-xs text-text-muted">龙门镖局</div>
          <div className="mt-1 text-2xl font-semibold text-text-primary">{activeTasks.length}</div>
          <div className="mt-1 text-xs text-text-muted">正在押运的镖单</div>
        </div>
        <div className="rounded-lg border border-border-primary bg-surface-secondary p-3">
          <div className="text-xs text-text-muted">风险与闭关</div>
          <div className="mt-1 text-2xl font-semibold text-status-warning">{blockedRooms.length + blockedTasks.length}</div>
          <div className="mt-1 text-xs text-text-muted">需要天机处关注</div>
        </div>
      </div>

      <div className="px-4 pb-4">
        <div className="rounded-lg border border-border-primary bg-surface-secondary overflow-hidden">
          <div className="border-b border-border-primary px-3 py-2">
            <div className="text-sm font-semibold text-text-primary">临时帮派总览</div>
            <div className="text-xs text-text-muted">帮派为当前委托成立，任务结束后经验归档、成员履历更新，再自动解散。</div>
          </div>
          <div className="divide-y divide-border-primary">
            {activeRooms.length === 0 && (
              <div className="px-3 py-6 text-center text-sm text-text-muted">暂无临时帮派。可以从左侧新建临时帮派开始接委托。</div>
            )}
            {activeRooms.map(room => (
              <div key={room.id} className="px-3 py-3">
                <div className="flex items-center gap-2">
                  <span className={`h-2 w-2 rounded-full ${room.status === 'active' ? 'bg-status-success' : room.status === 'paused' ? 'bg-status-warning' : 'bg-text-muted'}`} />
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
