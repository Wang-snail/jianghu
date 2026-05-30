import { useEffect, useMemo, useState } from 'react'
import { usePolling } from '../hooks/usePolling'
import { api } from '../lib/client'
import { ROOM_ESCALATION_EVENT_TYPES } from '../lib/room-events'
import { wsClient, type WsMessage } from '../lib/ws'
import { formatRelativeTime } from '../utils/time'
import type { Escalation, RoomActivityEntry, TrainingAdjustment, TrainingAdjustmentStatus, TrainingConfig, Worker } from '@shared/types'

type TrainingStatus = TrainingAdjustmentStatus
type TrainingStepState = 'done' | 'current' | 'waiting' | 'attention'

interface TrainingStep {
  label: string
  state: TrainingStepState
  detail: string
}

interface TrainingItem {
  escalation: Escalation
  worker: Worker | null
  title: string
  body: string
  status: TrainingStatus
  progress: number
  latestActivity: RoomActivityEntry | null
  currentAction: string
  result: string
  nextStep: string
  processSteps: TrainingStep[]
  adjustment: TrainingAdjustment | null
}

interface TrainingCampPanelProps {
  roomId: number | null
}

const ACTIVE_AGENT_STATES = new Set(['thinking', 'acting', 'voting'])
const BLOCKED_AGENT_STATES = new Set(['blocked', 'rate_limited'])

const statusCopy: Record<TrainingStatus, { label: string; className: string; bar: string }> = {
  queued: {
    label: '待接收',
    className: 'bg-surface-tertiary text-text-muted',
    bar: 'bg-text-muted',
  },
  training: {
    label: '训练中',
    className: 'bg-status-info-bg text-status-info',
    bar: 'bg-status-info',
  },
  absorbed: {
    label: '已吸收',
    className: 'bg-status-success-bg text-status-success',
    bar: 'bg-status-success',
  },
  attention: {
    label: '需关注',
    className: 'bg-status-warning-bg text-status-warning',
    bar: 'bg-status-warning',
  },
}

function isTrainingEscalation(escalation: Escalation): boolean {
  return escalation.question.trimStart().startsWith('弟子训练')
}

function stripTrainingPrefix(question: string): { title: string; body: string } {
  const trimmed = question.trim()
  const lines = trimmed.split(/\r?\n/)
  const first = lines[0] ?? ''
  const title = first.replace(/^弟子训练[:：]?/, '').trim()
  const body = lines.slice(1).join('\n').trim() || trimmed.replace(/^弟子训练[:：]?.*?\n?/, '').trim()
  return {
    title: title || '训练指令',
    body: body || '等待补充训练内容。',
  }
}

function stateLabel(state: string | undefined): string {
  switch (state) {
    case 'thinking':
      return '思考中'
    case 'acting':
      return '执行中'
    case 'voting':
      return '协商中'
    case 'rate_limited':
      return '受限'
    case 'blocked':
      return '阻塞'
    default:
      return '空闲'
  }
}

function recentActivityForWorker(
  activities: RoomActivityEntry[],
  workerId: number | null,
  createdAt: string
): RoomActivityEntry | null {
  if (workerId == null) return null
  const trainingTime = Date.parse(createdAt) || 0
  return activities
    .filter(activity => activity.actorId === workerId && (Date.parse(activity.createdAt) || 0) >= trainingTime - 1000)
    .sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0))[0] ?? null
}

function isDeliveryNote(note: string | null | undefined): boolean {
  return Boolean(note?.startsWith('训练意见已送达'))
}

function cleanTrainingResult(value: string): string {
  return value
    .replace(/^训练结果[：:]\s*/, '')
    .replace(/^训练营手动标记已吸收[：:]?\s*/, '')
    .trim()
}

function humanizeActivity(activity: RoomActivityEntry | null, workerName: string): string {
  if (!activity) return ''
  const summary = activity.summary.trim()
  const details = activity.details?.trim()
  if (/Agent cycle started/i.test(summary)) {
    return `${workerName} 已开始读取训练意见，正在整理需要改变的执行方式。`
  }
  if (/Agent cycle completed|cycle completed/i.test(summary)) {
    return `${workerName} 已完成一轮训练处理，等待结果写入履历或下一次任务验证。`
  }
  if (/Message resolved|训练已吸收/i.test(summary)) {
    return `${workerName} 已提交训练反馈，训练结果正在归档。`
  }
  if (/训练已开始/.test(summary)) {
    return `${workerName} 正在吸收训练意见：${details || '等待形成可执行调整。'}`
  }
  if (/训练已送达/.test(summary)) {
    return `${workerName} 已收到训练意见：${details || '等待接收。'}`
  }
  if (/用户向弟子|发出消息/.test(summary) && details?.startsWith('弟子训练')) {
    return `${workerName} 收到训练意见，等待吸收。`
  }
  return details ? `${summary}：${details}` : summary
}

function trainingStatus(
  escalation: Escalation,
  worker: Worker | null,
  latestActivity: RoomActivityEntry | null,
  adjustment: TrainingAdjustment | null
): { status: TrainingStatus; progress: number } {
  if (adjustment) {
    return { status: adjustment.status, progress: adjustment.progress }
  }
  if (escalation.status === 'resolved' || escalation.answer) {
    return { status: 'absorbed', progress: 100 }
  }
  if (worker && BLOCKED_AGENT_STATES.has(worker.agentState)) {
    return { status: 'attention', progress: 30 }
  }
  const ageMs = Date.now() - (Date.parse(escalation.createdAt) || Date.now())
  if (ageMs > 30 * 60 * 1000 && !latestActivity) {
    return { status: 'attention', progress: 20 }
  }
  if (worker && ACTIVE_AGENT_STATES.has(worker.agentState)) {
    return { status: 'training', progress: latestActivity ? 70 : 50 }
  }
  if (latestActivity) {
    return { status: 'training', progress: 60 }
  }
  return { status: 'queued', progress: 18 }
}

function buildTrainingItem(
  escalation: Escalation,
  workers: Worker[],
  activities: RoomActivityEntry[],
  adjustment: TrainingAdjustment | null
): TrainingItem {
  const worker = workers.find(w => w.id === escalation.toAgentId) ?? null
  const parsed = stripTrainingPrefix(escalation.question)
  const latestActivity = recentActivityForWorker(activities, escalation.toAgentId, escalation.createdAt)
  const { status, progress } = trainingStatus(escalation, worker, latestActivity, adjustment)
  const workerName = worker?.name ?? parsed.title
  const readableActivity = humanizeActivity(latestActivity, workerName)
  const currentAction = status === 'absorbed'
    ? '训练已完成，结果已写入训练记录，等待在后续委托中验证效果。'
    : status === 'attention'
      ? (adjustment?.note && !isDeliveryNote(adjustment.note)
          ? `需要处理：${adjustment.note}`
          : '训练出现停滞或阻塞，需要帮主检查是否补训、换人或调整要求。')
      : status === 'training'
        ? (readableActivity || worker?.wip || `${workerName} 正在吸收训练意见，整理要改变的执行方式。`)
        : '训练意见已送达，等待弟子接收并开始吸收。'
  const result = escalation.answer
    ? cleanTrainingResult(escalation.answer)
    : status === 'absorbed' && adjustment?.note
      ? cleanTrainingResult(adjustment.note)
      : status === 'training'
        ? '训练尚未完成；弟子完成一轮吸收后，这里会显示它确认改变了什么、如何应用到后续任务。'
        : status === 'attention'
          ? (adjustment?.note && !isDeliveryNote(adjustment.note) ? adjustment.note : '尚未形成可用结果，需要帮主介入确认原因。')
          : '训练已登记但尚未开始处理。'
  const nextStep = status === 'absorbed'
    ? '下次同类任务中观察输出是否按训练要求执行。'
    : status === 'attention'
      ? '需要帮主确认弟子是否阻塞、是否需要补训或换人。'
      : status === 'training'
        ? '继续观察最近输出，完成后由帮主写入履历。'
        : '等待弟子接收训练，或在帮主管理处重新发送更明确的训练要求。'
  const processSteps: TrainingStep[] = [
    {
      label: '已送达',
      state: 'done',
      detail: '训练意见已进入弟子待处理队列。',
    },
    {
      label: '吸收中',
      state: status === 'attention'
        ? 'attention'
        : status === 'queued'
          ? 'waiting'
          : status === 'training'
            ? 'current'
            : 'done',
      detail: status === 'queued'
        ? '等待弟子启动。'
        : status === 'absorbed'
          ? '弟子已完成吸收。'
          : readableActivity || '弟子正在读取训练意见并整理行为调整。',
    },
    {
      label: '形成结果',
      state: status === 'absorbed'
        ? 'done'
        : status === 'attention'
          ? 'attention'
          : 'waiting',
      detail: escalation.answer
        ? cleanTrainingResult(escalation.answer)
        : status === 'attention'
          ? '尚未形成结果，需要处理。'
          : '等待弟子提交吸收结果。',
    },
    {
      label: '后续验证',
      state: status === 'absorbed' ? 'current' : 'waiting',
      detail: status === 'absorbed'
        ? '下一次同类镖单会验证是否真正按要求输出。'
        : '结果形成后再进入验证。',
    },
  ]

  return {
    escalation,
    worker,
    title: parsed.title,
    body: parsed.body,
    status,
    progress,
    latestActivity,
    currentAction,
    result,
    nextStep,
    processSteps,
    adjustment,
  }
}

function splitConfigLines(value: string): string[] {
  return value
    .split(/\r?\n|,/)
    .map(item => item.trim())
    .filter(Boolean)
}

function joinConfigLines(value: string[] | undefined, fallback = ''): string {
  return value && value.length > 0 ? value.join('\n') : fallback
}

function parseTrainingConfig(value: string | null | undefined): TrainingConfig | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as TrainingConfig
    return parsed?.schema === 'jianghu.training.worker.v1' ? parsed : null
  } catch {
    return null
  }
}

function defaultTrainingConfig(item: TrainingItem): TrainingConfig {
  return {
    schema: 'jianghu.training.worker.v1',
    updatedAt: new Date().toISOString(),
    roleDefinition: {
      roleName: item.worker?.role || item.title || '专项弟子',
      mission: item.worker?.description || item.body.slice(0, 120) || '承接帮主分派的子任务，稳定产出可交接结果。',
      responsibilities: [
        '先确认上游输入和验收标准',
        '按约定格式产出结果',
        '发现阻塞时及时向帮主说明原因和下一步建议',
      ],
      inputRequirements: [
        '委托目标',
        '上游弟子的交付物',
        '帮主指定的输出格式和验收标准',
      ],
      outputFormat: '用中文输出：结论、依据、风险、下游可复用字段、下一步建议。',
      acceptanceCriteria: [
        '输出能被下游弟子直接使用',
        '证据和判断依据清楚',
        '没有偏离当前委托目标',
      ],
      collaborationRules: [
        '只和任务树允许的上下游交接',
        '不绕过帮主申请预算或改变目标',
      ],
    },
    toolCalling: {
      allowedTools: ['company_recall', 'company_save_memory', 'company_send_message'],
      disallowedTools: [],
      approvalRequiredTools: ['高成本模型调用', '外部搜索', '批量写入'],
      callingRules: [
        '调用工具前先说明目的',
        '工具失败时记录失败原因并换本地可执行路径',
        '输出前保存关键结论和交接信息',
      ],
    },
  }
}

export function TrainingCampPanel({ roomId }: TrainingCampPanelProps): React.JSX.Element {
  const [continuingId, setContinuingId] = useState<number | null>(null)
  const [continueText, setContinueText] = useState('')
  const [adjustingId, setAdjustingId] = useState<number | null>(null)
  const [adjustStatus, setAdjustStatus] = useState<TrainingStatus>('training')
  const [adjustProgress, setAdjustProgress] = useState(60)
  const [adjustNote, setAdjustNote] = useState('')
  const [roleName, setRoleName] = useState('')
  const [roleMission, setRoleMission] = useState('')
  const [roleResponsibilities, setRoleResponsibilities] = useState('')
  const [roleInputs, setRoleInputs] = useState('')
  const [roleOutputFormat, setRoleOutputFormat] = useState('')
  const [roleAcceptance, setRoleAcceptance] = useState('')
  const [roleCollaboration, setRoleCollaboration] = useState('')
  const [allowedTools, setAllowedTools] = useState('')
  const [disallowedTools, setDisallowedTools] = useState('')
  const [approvalTools, setApprovalTools] = useState('')
  const [toolRules, setToolRules] = useState('')
  const [pendingActionId, setPendingActionId] = useState<number | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const { data: escalations, refresh: refreshEscalations, isLoading } = usePolling<Escalation[]>(
    () => roomId ? api.escalations.list(roomId).catch(() => []) : Promise.resolve([]),
    15000
  )
  const { data: workers, refresh: refreshWorkers } = usePolling<Worker[]>(
    () => roomId ? api.workers.listForRoom(roomId).catch(() => []) : Promise.resolve([]),
    30000
  )
  const { data: activities, refresh: refreshActivities } = usePolling<RoomActivityEntry[]>(
    () => roomId ? api.rooms.getActivity(roomId, 80).catch(() => []) : Promise.resolve([]),
    15000
  )
  const { data: adjustments, refresh: refreshAdjustments } = usePolling<TrainingAdjustment[]>(
    () => roomId ? api.training.adjustments(roomId).catch(() => []) : Promise.resolve([]),
    15000
  )

  useEffect(() => {
    if (!roomId) return
    return wsClient.subscribe(`room:${roomId}`, (event: WsMessage) => {
      if (ROOM_ESCALATION_EVENT_TYPES.has(event.type)) {
        void refreshEscalations()
        void refreshActivities()
        void refreshWorkers()
        void refreshAdjustments()
      }
    })
  }, [refreshActivities, refreshAdjustments, refreshEscalations, refreshWorkers, roomId])

  useEffect(() => {
    void refreshEscalations()
    void refreshActivities()
    void refreshWorkers()
    void refreshAdjustments()
  }, [refreshActivities, refreshAdjustments, refreshEscalations, refreshWorkers, roomId])

  const items = useMemo(() => {
    const workerList = workers ?? []
    const activityList = activities ?? []
    const adjustmentMap = new Map((adjustments ?? []).map(adjustment => [adjustment.escalationId, adjustment]))
    return (escalations ?? [])
      .filter(isTrainingEscalation)
      .map(escalation => buildTrainingItem(escalation, workerList, activityList, adjustmentMap.get(escalation.id) ?? null))
      .sort((a, b) => (Date.parse(b.escalation.createdAt) || 0) - (Date.parse(a.escalation.createdAt) || 0))
  }, [activities, adjustments, escalations, workers])

  const stats = useMemo(() => {
    const total = items.length
    const training = items.filter(item => item.status === 'training').length
    const absorbed = items.filter(item => item.status === 'absorbed').length
    const attention = items.filter(item => item.status === 'attention').length
    return { total, training, absorbed, attention }
  }, [items])

  if (!roomId) {
    return <div className="p-4 text-text-muted">请先选择一个帮派。</div>
  }

  function refreshAll(): void {
    void refreshEscalations()
    void refreshActivities()
    void refreshWorkers()
    void refreshAdjustments()
  }

  function openAdjust(item: TrainingItem): void {
    const config = parseTrainingConfig(item.adjustment?.configJson) ?? defaultTrainingConfig(item)
    setAdjustingId(item.escalation.id)
    setAdjustStatus(item.status)
    setAdjustProgress(item.progress)
    setAdjustNote(item.adjustment?.note ?? '')
    setRoleName(config.roleDefinition.roleName)
    setRoleMission(config.roleDefinition.mission)
    setRoleResponsibilities(joinConfigLines(config.roleDefinition.responsibilities))
    setRoleInputs(joinConfigLines(config.roleDefinition.inputRequirements))
    setRoleOutputFormat(config.roleDefinition.outputFormat)
    setRoleAcceptance(joinConfigLines(config.roleDefinition.acceptanceCriteria))
    setRoleCollaboration(joinConfigLines(config.roleDefinition.collaborationRules))
    setAllowedTools(joinConfigLines(config.toolCalling.allowedTools))
    setDisallowedTools(joinConfigLines(config.toolCalling.disallowedTools))
    setApprovalTools(joinConfigLines(config.toolCalling.approvalRequiredTools))
    setToolRules(joinConfigLines(config.toolCalling.callingRules))
    setNotice(null)
  }

  async function submitContinue(item: TrainingItem): Promise<void> {
    if (!roomId || !item.worker || !continueText.trim()) return
    setPendingActionId(item.escalation.id)
    setNotice(null)
    try {
      await api.escalations.create(
        roomId,
        null,
        `弟子训练：${item.worker.name}\n${continueText.trim()}`,
        item.worker.id,
        true
      )
      setContinueText('')
      setContinuingId(null)
      setNotice('已追加训练，新的训练记录会显示在最上方。')
      refreshAll()
    } catch (err) {
      setNotice(err instanceof Error ? err.message : '追加训练失败')
    } finally {
      setPendingActionId(null)
    }
  }

  async function submitAdjust(item: TrainingItem): Promise<void> {
    if (!roomId) return
    const config: TrainingConfig = {
      schema: 'jianghu.training.worker.v1',
      updatedAt: new Date().toISOString(),
      roleDefinition: {
        roleName: roleName.trim() || item.worker?.role || item.title || '专项弟子',
        mission: roleMission.trim() || item.worker?.description || item.body.slice(0, 120),
        responsibilities: splitConfigLines(roleResponsibilities),
        inputRequirements: splitConfigLines(roleInputs),
        outputFormat: roleOutputFormat.trim(),
        acceptanceCriteria: splitConfigLines(roleAcceptance),
        collaborationRules: splitConfigLines(roleCollaboration),
      },
      toolCalling: {
        allowedTools: splitConfigLines(allowedTools),
        disallowedTools: splitConfigLines(disallowedTools),
        approvalRequiredTools: splitConfigLines(approvalTools),
        callingRules: splitConfigLines(toolRules),
      },
    }
    setPendingActionId(item.escalation.id)
    setNotice(null)
    try {
      await api.training.adjust(roomId, item.escalation.id, {
        workerId: item.worker?.id ?? item.escalation.toAgentId,
        status: adjustStatus,
        progress: adjustProgress,
        note: adjustNote,
        config,
      })
      setAdjustingId(null)
      setAdjustNote('')
      setNotice('训练状态已更新。')
      refreshAll()
    } catch (err) {
      setNotice(err instanceof Error ? err.message : '调整训练状态失败')
    } finally {
      setPendingActionId(null)
    }
  }

  return (
    <div className="p-4 space-y-4">
      <section className="rounded-xl border border-border-primary bg-surface-secondary overflow-hidden">
        <div className="p-4 border-b border-border-secondary flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-text-primary">训练营</h2>
            <p className="mt-1 text-sm text-text-muted">追踪弟子收到的训练、当前吸收进度和最近动作。</p>
          </div>
          <button
            onClick={refreshAll}
            className="px-3 py-1.5 text-sm rounded-lg bg-surface-tertiary text-text-secondary hover:bg-surface-hover transition-colors"
          >
            刷新
          </button>
        </div>

        {notice && (
          <div className="mx-4 mt-4 rounded-lg border border-border-primary bg-surface-primary px-3 py-2 text-sm text-text-secondary">
            {notice}
          </div>
        )}

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 p-4 border-b border-border-secondary">
          <div className="rounded-lg bg-surface-primary border border-border-secondary p-3">
            <div className="text-xs text-text-muted">训练指令</div>
            <div className="mt-2 text-2xl font-semibold text-text-primary">{stats.total}</div>
          </div>
          <div className="rounded-lg bg-surface-primary border border-border-secondary p-3">
            <div className="text-xs text-text-muted">训练中</div>
            <div className="mt-2 text-2xl font-semibold text-status-info">{stats.training}</div>
          </div>
          <div className="rounded-lg bg-surface-primary border border-border-secondary p-3">
            <div className="text-xs text-text-muted">已吸收</div>
            <div className="mt-2 text-2xl font-semibold text-status-success">{stats.absorbed}</div>
          </div>
          <div className="rounded-lg bg-surface-primary border border-border-secondary p-3">
            <div className="text-xs text-text-muted">需关注</div>
            <div className="mt-2 text-2xl font-semibold text-status-warning">{stats.attention}</div>
          </div>
        </div>

        <div className="p-4 space-y-3">
          {isLoading && items.length === 0 ? (
            <div className="py-8 flex items-center justify-center gap-2 text-sm text-text-muted">
              <span className="w-3 h-3 rounded-full border border-border-primary border-t-interactive animate-spin" />
              加载训练记录中...
            </div>
          ) : items.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border-secondary p-6 text-center">
              <div className="text-sm font-medium text-text-primary">暂无训练记录</div>
              <p className="mt-2 text-sm text-text-muted">在帮主管理处给弟子发送训练后，这里会显示训练对象、内容、进度和结果。</p>
            </div>
          ) : items.map(item => {
            const copy = statusCopy[item.status]
            return (
              <article key={item.escalation.id} className="rounded-xl border border-border-secondary bg-surface-primary overflow-hidden">
                <div className="p-4 flex flex-col lg:flex-row lg:items-start gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="text-base font-semibold text-text-primary truncate">
                        {item.worker?.name ?? item.title}
                      </h3>
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${copy.className}`}>{copy.label}</span>
                      <span className="text-xs text-text-muted">{formatRelativeTime(item.escalation.createdAt)}</span>
                    </div>
                    <div className="mt-1 text-sm text-text-muted">
                      {item.worker?.role || item.worker?.description || '未标注岗位'} · {item.worker ? stateLabel(item.worker.agentState) : '弟子不在当前帮派'}
                    </div>
                    <p className="mt-3 text-sm text-text-secondary whitespace-pre-wrap leading-relaxed">{item.body}</p>
                  </div>

                  <div className="w-full lg:w-64 shrink-0">
                    <div className="flex items-center justify-between text-xs text-text-muted mb-1">
                      <span>吸收进度</span>
                      <span>{item.progress}%</span>
                    </div>
                    <div className="h-2 rounded-full bg-surface-tertiary overflow-hidden">
                      <div className={`h-full rounded-full ${copy.bar}`} style={{ width: `${item.progress}%` }} />
                    </div>
                    <div className="mt-2 text-xs text-text-muted">
                      最近动作：{item.latestActivity
                        ? `${formatRelativeTime(item.latestActivity.createdAt)} · ${humanizeActivity(item.latestActivity, item.worker?.name ?? item.title).slice(0, 32)}`
                        : item.adjustment
                          ? '训练记录已建立'
                          : '暂无'}
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setContinuingId(continuingId === item.escalation.id ? null : item.escalation.id)
                          setAdjustingId(null)
                          setContinueText('')
                          setNotice(null)
                        }}
                        disabled={!item.worker || pendingActionId === item.escalation.id}
                        className="rounded-lg bg-interactive px-3 py-1.5 text-xs text-text-invert disabled:opacity-50"
                      >
                        继续训练
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (adjustingId === item.escalation.id) {
                            setAdjustingId(null)
                          } else {
                            setContinuingId(null)
                            openAdjust(item)
                          }
                        }}
                        disabled={pendingActionId === item.escalation.id}
                        className="rounded-lg border border-border-primary px-3 py-1.5 text-xs text-text-secondary hover:bg-surface-hover disabled:opacity-50"
                      >
                        手动调整
                      </button>
                    </div>
                  </div>
                </div>

                {continuingId === item.escalation.id && (
                  <div className="border-t border-border-secondary bg-surface-secondary/70 p-4">
                    <div className="text-sm font-medium text-text-primary">继续训练 {item.worker?.name}</div>
                    <textarea
                      value={continueText}
                      onChange={(event) => setContinueText(event.target.value)}
                      className="mt-2 min-h-24 w-full resize-y rounded-lg border border-border-primary bg-surface-primary px-3 py-2 text-sm text-text-primary outline-none focus:border-interactive"
                      placeholder="补充新的训练要求，例如：下一次输出时必须列出证据来源、风险判断和给下游的字段格式。"
                    />
                    <div className="mt-2 flex gap-2">
                      <button
                        type="button"
                        onClick={() => { void submitContinue(item) }}
                        disabled={!continueText.trim() || pendingActionId === item.escalation.id}
                        className="rounded-lg bg-interactive px-3 py-2 text-sm text-text-invert disabled:opacity-50"
                      >
                        {pendingActionId === item.escalation.id ? '发送中' : '追加训练'}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setContinuingId(null)
                          setContinueText('')
                        }}
                        className="rounded-lg border border-border-primary px-3 py-2 text-sm text-text-secondary hover:bg-surface-hover"
                      >
                        取消
                      </button>
                    </div>
                  </div>
                )}

                {adjustingId === item.escalation.id && (
                  <div className="border-t border-border-secondary bg-surface-secondary/70 p-4">
                    <div className="text-sm font-medium text-text-primary">手动调整训练状态</div>
                    <div className="mt-3 grid gap-3 md:grid-cols-[180px_1fr]">
                      <label className="text-xs text-text-muted">
                        状态
                        <select
                          value={adjustStatus}
                          onChange={(event) => setAdjustStatus(event.target.value as TrainingStatus)}
                          className="mt-1 w-full rounded-lg border border-border-primary bg-surface-primary px-3 py-2 text-sm text-text-primary"
                        >
                          <option value="queued">待接收</option>
                          <option value="training">训练中</option>
                          <option value="absorbed">已吸收</option>
                          <option value="attention">需关注</option>
                        </select>
                      </label>
                      <label className="text-xs text-text-muted">
                        吸收进度：{adjustProgress}%
                        <input
                          type="range"
                          min="0"
                          max="100"
                          value={adjustProgress}
                          onChange={(event) => setAdjustProgress(Number(event.target.value))}
                          className="mt-3 w-full accent-interactive"
                        />
                      </label>
                    </div>
                    <textarea
                      value={adjustNote}
                      onChange={(event) => setAdjustNote(event.target.value)}
                      className="mt-3 min-h-20 w-full resize-y rounded-lg border border-border-primary bg-surface-primary px-3 py-2 text-sm text-text-primary outline-none focus:border-interactive"
                      placeholder="写明为什么调整，例如：已看过输出，格式仍缺少下游字段；或已完成吸收，可以进入下次任务验证。"
                    />
                    <div className="mt-4 grid gap-3 xl:grid-cols-2">
                      <section className="rounded-lg border border-border-primary bg-surface-primary p-3">
                        <div className="text-sm font-semibold text-text-primary">角色定义配置</div>
                        <p className="mt-1 text-xs text-text-muted">页面用中文给人看，保存后会写入弟子的结构化配置块。</p>
                        <label className="mt-3 block text-xs text-text-muted">
                          岗位名称
                          <input
                            value={roleName}
                            onChange={(event) => setRoleName(event.target.value)}
                            className="mt-1 w-full rounded-lg border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary outline-none focus:border-interactive"
                            placeholder="例如：评论分析弟子"
                          />
                        </label>
                        <label className="mt-3 block text-xs text-text-muted">
                          任务使命
                          <textarea
                            value={roleMission}
                            onChange={(event) => setRoleMission(event.target.value)}
                            className="mt-1 min-h-20 w-full resize-y rounded-lg border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary outline-none focus:border-interactive"
                            placeholder="这个弟子负责解决什么问题，为什么需要它。"
                          />
                        </label>
                        <div className="mt-3 grid gap-3 md:grid-cols-2">
                          <label className="text-xs text-text-muted">
                            职责清单（一行一条）
                            <textarea
                              value={roleResponsibilities}
                              onChange={(event) => setRoleResponsibilities(event.target.value)}
                              className="mt-1 min-h-28 w-full resize-y rounded-lg border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary outline-none focus:border-interactive"
                            />
                          </label>
                          <label className="text-xs text-text-muted">
                            输入要求（一行一条）
                            <textarea
                              value={roleInputs}
                              onChange={(event) => setRoleInputs(event.target.value)}
                              className="mt-1 min-h-28 w-full resize-y rounded-lg border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary outline-none focus:border-interactive"
                            />
                          </label>
                        </div>
                        <label className="mt-3 block text-xs text-text-muted">
                          输出格式
                          <textarea
                            value={roleOutputFormat}
                            onChange={(event) => setRoleOutputFormat(event.target.value)}
                            className="mt-1 min-h-20 w-full resize-y rounded-lg border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary outline-none focus:border-interactive"
                            placeholder="例如：结论 / 依据 / 风险 / 下游字段 / 下一步。"
                          />
                        </label>
                        <div className="mt-3 grid gap-3 md:grid-cols-2">
                          <label className="text-xs text-text-muted">
                            验收标准（一行一条）
                            <textarea
                              value={roleAcceptance}
                              onChange={(event) => setRoleAcceptance(event.target.value)}
                              className="mt-1 min-h-24 w-full resize-y rounded-lg border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary outline-none focus:border-interactive"
                            />
                          </label>
                          <label className="text-xs text-text-muted">
                            协作边界（一行一条）
                            <textarea
                              value={roleCollaboration}
                              onChange={(event) => setRoleCollaboration(event.target.value)}
                              className="mt-1 min-h-24 w-full resize-y rounded-lg border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary outline-none focus:border-interactive"
                            />
                          </label>
                        </div>
                      </section>

                      <section className="rounded-lg border border-border-primary bg-surface-primary p-3">
                        <div className="text-sm font-semibold text-text-primary">工具调用配置</div>
                        <p className="mt-1 text-xs text-text-muted">用于约束弟子怎么用 Hermes 工具；保存后系统会以 JSON 形式给 AI 读取。</p>
                        <label className="mt-3 block text-xs text-text-muted">
                          允许工具（一行一个）
                          <textarea
                            value={allowedTools}
                            onChange={(event) => setAllowedTools(event.target.value)}
                            className="mt-1 min-h-24 w-full resize-y rounded-lg border border-border-primary bg-surface-secondary px-3 py-2 font-mono text-sm text-text-primary outline-none focus:border-interactive"
                            placeholder="company_recall&#10;company_save_memory&#10;company_send_message"
                          />
                        </label>
                        <label className="mt-3 block text-xs text-text-muted">
                          禁用工具（一行一个）
                          <textarea
                            value={disallowedTools}
                            onChange={(event) => setDisallowedTools(event.target.value)}
                            className="mt-1 min-h-20 w-full resize-y rounded-lg border border-border-primary bg-surface-secondary px-3 py-2 font-mono text-sm text-text-primary outline-none focus:border-interactive"
                          />
                        </label>
                        <label className="mt-3 block text-xs text-text-muted">
                          需要审批的动作（一行一条）
                          <textarea
                            value={approvalTools}
                            onChange={(event) => setApprovalTools(event.target.value)}
                            className="mt-1 min-h-20 w-full resize-y rounded-lg border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary outline-none focus:border-interactive"
                          />
                        </label>
                        <label className="mt-3 block text-xs text-text-muted">
                          调用规则（一行一条）
                          <textarea
                            value={toolRules}
                            onChange={(event) => setToolRules(event.target.value)}
                            className="mt-1 min-h-28 w-full resize-y rounded-lg border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary outline-none focus:border-interactive"
                            placeholder="调用工具前说明目的&#10;工具失败时记录原因并换路径"
                          />
                        </label>
                      </section>
                    </div>
                    <div className="mt-2 flex gap-2">
                      <button
                        type="button"
                        onClick={() => { void submitAdjust(item) }}
                        disabled={pendingActionId === item.escalation.id}
                        className="rounded-lg bg-interactive px-3 py-2 text-sm text-text-invert disabled:opacity-50"
                      >
                        {pendingActionId === item.escalation.id ? '保存中' : '保存并应用到弟子'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setAdjustingId(null)}
                        className="rounded-lg border border-border-primary px-3 py-2 text-sm text-text-secondary hover:bg-surface-hover"
                      >
                        取消
                      </button>
                    </div>
                  </div>
                )}

                <div className="border-t border-border-secondary p-4">
                  <div className="text-xs font-medium text-text-muted">训练过程</div>
                  <div className="mt-3 grid gap-2 md:grid-cols-4">
                    {item.processSteps.map((step, index) => {
                      const tone = step.state === 'done'
                        ? 'border-status-success/40 bg-status-success-bg/40 text-status-success'
                        : step.state === 'current'
                          ? 'border-status-info/50 bg-status-info-bg/40 text-status-info'
                          : step.state === 'attention'
                            ? 'border-status-warning/50 bg-status-warning-bg/40 text-status-warning'
                            : 'border-border-secondary bg-surface-secondary text-text-muted'
                      const dot = step.state === 'done'
                        ? 'bg-status-success'
                        : step.state === 'current'
                          ? 'bg-status-info animate-pulse'
                          : step.state === 'attention'
                            ? 'bg-status-warning animate-pulse'
                            : 'bg-text-muted'
                      return (
                        <div key={`${step.label}-${index}`} className={`rounded-lg border px-3 py-2 ${tone}`}>
                          <div className="flex items-center gap-2 text-sm font-medium">
                            <span className={`h-2 w-2 rounded-full ${dot}`} />
                            {step.label}
                          </div>
                          <div className="mt-1 text-xs leading-relaxed text-text-secondary">{step.detail}</div>
                        </div>
                      )
                    })}
                  </div>
                </div>

                <div className="grid md:grid-cols-3 gap-0 border-t border-border-secondary">
                  <div className="p-4 border-b md:border-b-0 md:border-r border-border-secondary">
                    <div className="text-xs font-medium text-text-muted">正在做什么</div>
                    <p className="mt-2 text-sm text-text-secondary leading-relaxed">{item.currentAction}</p>
                  </div>
                  <div className="p-4 border-b md:border-b-0 md:border-r border-border-secondary">
                    <div className="text-xs font-medium text-text-muted">训练结果</div>
                    <p className="mt-2 text-sm text-text-secondary leading-relaxed whitespace-pre-wrap">{item.result}</p>
                  </div>
                  <div className="p-4">
                    <div className="text-xs font-medium text-text-muted">下一步</div>
                    <p className="mt-2 text-sm text-text-secondary leading-relaxed">{item.nextStep}</p>
                  </div>
                </div>
              </article>
            )
          })}
        </div>
      </section>
    </div>
  )
}
