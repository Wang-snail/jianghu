import { useMemo } from 'react'
import { usePolling } from '../hooks/usePolling'
import { api } from '../lib/client'
import type { Task } from '@shared/types'

function statusLabel(status: string): string {
  if (status === 'active') return '运行中'
  if (status === 'paused') return '闭关'
  if (status === 'stopped') return '已停摆'
  if (status === 'completed') return '已完成'
  return status
}

function riskTone(level: 'red' | 'yellow' | 'green'): string {
  if (level === 'red') return 'border-status-error bg-status-error-bg text-status-error'
  if (level === 'yellow') return 'border-status-warning bg-status-warning-bg text-status-warning'
  return 'border-status-success bg-status-success-bg text-status-success'
}

function taskRiskLabel(task: Task): string {
  if (task.errorCount >= 2) return '红色警报'
  if (task.errorCount > 0 || task.status === 'paused') return '黄色预警'
  return '正常'
}

const antiGamingRules = [
  '简单镖单的单次声望增量有上限；复杂镖单才允许更高增量。',
  '同一弟子连续承接同类镖单超过 3 次，第 4 次起不再产生声望增长。',
  '每个临时帮派至少保留 1 名近期首次合作弟子的推荐机会，避免帮主只用老面孔。',
  '弟子输出必须被下游弟子或天机处验收；格式正确但内容空洞会追溯扣分。',
]

const authorityRules = [
  ['可做', '读取帮派、弟子、钱庄、镖单和验收日志；发出黄色预警或红色警报；冻结异常声望增量；申请重新验收。'],
  ['不可做', '不能直接改委托目标，不能替换帮主或弟子，不能直接批准预算，不能覆盖藏经阁功法。'],
  ['互相监督', '天机处负责调度和验收，锦衣卫负责审计和制衡；锦衣卫误报过高时，天机处记录并触发锦衣卫自查。'],
]

const riskTypes = [
  ['规则规避', '刷简单镖单、声望异常增长、帮主固定使用同一批弟子。'],
  ['资源滥用', '银两和金票消耗异常、预算超支、非关键路径调用高成本能力。'],
  ['输出质量', '内容偏离委托、语义空洞、下游无法复用、返工过多。'],
  ['系统操纵', '验收标准被降低、任务拆解异常简单、风险被跳过。'],
  ['循环依赖', '弟子互相等待、任务树闭环、帮派长时间无实际进展。'],
]

export function JinyiweiPanel(): React.JSX.Element {
  const { data: rooms } = usePolling(() => api.rooms.list().catch(() => []), 30000)
  const { data: tasks } = usePolling(() => api.tasks.list(undefined).catch(() => []), 30000)
  const { data: workers } = usePolling(() => api.workers.list().catch(() => []), 30000)

  const activeRooms = useMemo(() => (rooms ?? []).filter(room => room.status !== 'stopped'), [rooms])
  const pausedRooms = useMemo(() => activeRooms.filter(room => room.status === 'paused'), [activeRooms])
  const riskyTasks = useMemo(() => (tasks ?? []).filter(task => task.status === 'paused' || task.errorCount > 0), [tasks])
  const redTasks = useMemo(() => riskyTasks.filter(task => task.errorCount >= 2), [riskyTasks])
  const repeatedWorkers = useMemo(() => (workers ?? []).filter(worker => worker.taskCount >= 5), [workers])

  const riskCards = [
    { label: '红色警报', value: redTasks.length, hint: '连续失败或需要强制暂停复核', level: redTasks.length > 0 ? 'red' : 'green' },
    { label: '黄色预警', value: riskyTasks.length + pausedRooms.length, hint: '闭关、阻塞或轻度异常', level: riskyTasks.length + pausedRooms.length > 0 ? 'yellow' : 'green' },
    { label: '重点观察弟子', value: repeatedWorkers.length, hint: '承接镖单较多，需防止路径固化', level: repeatedWorkers.length > 0 ? 'yellow' : 'green' },
    { label: '在册弟子', value: workers?.length ?? 0, hint: '锦衣卫审计覆盖范围', level: 'green' },
  ] as const

  return (
    <div className="h-full overflow-y-auto">
      <div className="border-b border-border-primary bg-surface-primary px-4 py-3">
        <div className="text-lg font-semibold text-text-primary">锦衣卫</div>
        <div className="mt-1 text-sm text-text-muted">
          江湖独立审计与风险维护机构。锦衣卫与天机处同级，天机处负责调度，锦衣卫负责监督规则、预算、质量和异常风险。
        </div>
      </div>

      <div className="grid gap-3 p-4 md:grid-cols-4">
        {riskCards.map(card => (
          <div key={card.label} className={`rounded-lg border p-3 ${riskTone(card.level)}`}>
            <div className="text-xs opacity-80">{card.label}</div>
            <div className="mt-1 text-2xl font-semibold">{card.value}</div>
            <div className="mt-1 text-xs opacity-80">{card.hint}</div>
          </div>
        ))}
      </div>

      <div className="grid gap-4 px-4 pb-4 xl:grid-cols-[1.1fr_0.9fr]">
        <div className="space-y-4">
          <div className="rounded-lg border border-border-primary bg-surface-secondary overflow-hidden">
            <div className="border-b border-border-primary px-3 py-2">
              <div className="text-sm font-semibold text-text-primary">当值风险</div>
              <div className="text-xs text-text-muted">锦衣卫只暴露需要处理的风险，不展示后台细节。</div>
            </div>
            <div className="divide-y divide-border-primary">
              {pausedRooms.length === 0 && riskyTasks.length === 0 && (
                <div className="px-3 py-6 text-center text-sm text-text-muted">暂无需要干预的风险。锦衣卫继续巡查预算、声望和交付质量。</div>
              )}
              {pausedRooms.map(room => (
                <div key={`room-${room.id}`} className="px-3 py-3">
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-status-warning" />
                    <div className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">{room.name}</div>
                    <span className="text-xs text-status-warning">{statusLabel(room.status)}</span>
                  </div>
                  <div className="mt-1 text-xs text-text-muted">帮派处于闭关状态，锦衣卫要求天机处确认阻塞原因和恢复条件。</div>
                </div>
              ))}
              {riskyTasks.slice(0, 8).map(task => (
                <div key={`task-${task.id}`} className="px-3 py-3">
                  <div className="flex items-center gap-2">
                    <span className={`h-2 w-2 rounded-full ${task.errorCount >= 2 ? 'bg-status-error' : 'bg-status-warning'}`} />
                    <div className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">{task.name}</div>
                    <span className={`text-xs ${task.errorCount >= 2 ? 'text-status-error' : 'text-status-warning'}`}>{taskRiskLabel(task)}</span>
                  </div>
                  <div className="mt-1 text-xs text-text-muted">
                    {task.errorCount > 0 ? `最近失败 ${task.errorCount} 次，需先找根因再继续。` : '镖单暂停，需确认是否继续押运或归档。'}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-lg border border-border-primary bg-surface-secondary p-3">
            <div className="text-sm font-semibold text-text-primary">反刷声望规则</div>
            <div className="mt-2 grid gap-2">
              {antiGamingRules.map(rule => (
                <div key={rule} className="rounded-lg bg-surface-primary px-3 py-2 text-xs text-text-secondary">{rule}</div>
              ))}
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <div className="rounded-lg border border-border-primary bg-surface-secondary p-3">
            <div className="text-sm font-semibold text-text-primary">权力边界</div>
            <div className="mt-2 space-y-2">
              {authorityRules.map(([label, text]) => (
                <div key={label} className="rounded-lg bg-surface-primary p-2">
                  <div className="text-xs font-semibold text-text-primary">{label}</div>
                  <div className="mt-1 text-xs leading-5 text-text-muted">{text}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-lg border border-border-primary bg-surface-secondary p-3">
            <div className="text-sm font-semibold text-text-primary">五类风险</div>
            <div className="mt-2 grid gap-2">
              {riskTypes.map(([label, text]) => (
                <div key={label} className="flex gap-2 rounded-lg bg-surface-primary px-3 py-2">
                  <div className="w-16 shrink-0 text-xs font-semibold text-text-primary">{label}</div>
                  <div className="text-xs leading-5 text-text-muted">{text}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-lg border border-border-primary bg-surface-secondary p-3">
            <div className="text-sm font-semibold text-text-primary">锦衣卫密档</div>
            <div className="mt-2 text-xs leading-5 text-text-muted">
              风险模式、误报率、冻结记录和复验结果进入密档。密档用于优化锦衣卫识别能力，不作为弟子功法直接发放。
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
