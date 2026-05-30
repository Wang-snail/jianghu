import { useMemo } from 'react'
import { usePolling } from '../hooks/usePolling'
import { api } from '../lib/client'
import {
  dispositionDotClass,
  dispositionToneClass,
  roomDisposition,
  taskDisposition,
  type JinyiweiDispositionLevel,
} from '../lib/jinyiwei-disposition'

function statusLabel(status: string): string {
  if (status === 'active') return '运行中'
  if (status === 'paused') return '看守中'
  if (status === 'stopped') return '已停摆'
  if (status === 'completed') return '已完成'
  return status
}

export function JinyiweiPanel(): React.JSX.Element {
  const { data: rooms } = usePolling(() => api.rooms.list().catch(() => []), 30000)
  const { data: tasks } = usePolling(() => api.tasks.list(undefined).catch(() => []), 30000)
  const { data: workers } = usePolling(() => api.workers.list().catch(() => []), 30000)

  const activeRooms = useMemo(() => (rooms ?? []).filter(room => room.status !== 'stopped'), [rooms])
  const pausedRooms = useMemo(() => activeRooms.filter(room => room.status === 'paused'), [activeRooms])
  const riskyTasks = useMemo(() => (tasks ?? []).filter(task => task.status === 'paused' || task.errorCount > 0), [tasks])
  const watchedTaskCount = useMemo(() => riskyTasks.filter(task => taskDisposition(task).level === 'watch').length, [riskyTasks])
  const detainedTaskCount = useMemo(() => riskyTasks.filter(task => taskDisposition(task).level === 'detain').length, [riskyTasks])
  const imprisonedTaskCount = useMemo(() => riskyTasks.filter(task => taskDisposition(task).level === 'imprison').length, [riskyTasks])
  const repeatedWorkers = useMemo(() => (workers ?? []).filter(worker => worker.taskCount >= 5), [workers])

  const riskCards = [
    { label: '囚禁', value: imprisonedTaskCount, hint: '严重连续失败，冻结执行等待复核', level: imprisonedTaskCount > 0 ? 'imprison' : 'clear' },
    { label: '拘押', value: detainedTaskCount, hint: '连续失败，暂扣执行权先查根因', level: detainedTaskCount > 0 ? 'detain' : 'clear' },
    { label: '看守', value: watchedTaskCount + pausedRooms.length, hint: '暂停、阻塞或轻度异常，持续盯防', level: watchedTaskCount + pausedRooms.length > 0 ? 'watch' : 'clear' },
    { label: '重点盯防弟子', value: repeatedWorkers.length, hint: '承接镖单较多，防止路径固化', level: repeatedWorkers.length > 0 ? 'watch' : 'clear' },
  ] as const

  return (
    <div className="h-full overflow-y-auto">
      <div className="border-b border-border-primary bg-surface-primary px-4 py-3">
        <div className="text-lg font-semibold text-text-primary">锦衣卫</div>
        <div className="mt-1 text-sm text-text-muted">
          只展示当前需要关注的风险。
        </div>
      </div>

      <div className="grid gap-3 p-4 md:grid-cols-4">
        {riskCards.map(card => (
          <div key={card.label} className={`rounded-lg border p-3 ${dispositionToneClass(card.level as JinyiweiDispositionLevel)}`}>
            <div className="text-xs opacity-80">{card.label}</div>
            <div className="mt-1 text-2xl font-semibold">{card.value}</div>
            <div className="mt-1 text-xs opacity-80">{card.hint}</div>
          </div>
        ))}
      </div>

      <div className="px-4 pb-4">
        <div className="rounded-lg border border-border-primary bg-surface-secondary overflow-hidden">
          <div className="border-b border-border-primary px-3 py-2">
            <div className="text-sm font-semibold text-text-primary">当前风险</div>
          </div>
          <div className="divide-y divide-border-primary">
            {pausedRooms.length === 0 && riskyTasks.length === 0 && (
              <div className="px-3 py-6 text-center text-sm text-text-muted">暂无需要处理的风险。</div>
            )}
            {pausedRooms.map(room => (
              <div key={`room-${room.id}`} className="px-3 py-3">
                <div className="flex items-center gap-2">
                  <span className={`h-2 w-2 rounded-full ${dispositionDotClass(roomDisposition(room.status).level)}`} />
                  <div className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">{room.name}</div>
                  <span className="text-xs text-status-warning">{statusLabel(room.status)}</span>
                </div>
                <div className="mt-1 text-xs text-text-muted">{roomDisposition(room.status).description}</div>
              </div>
            ))}
            {riskyTasks.slice(0, 8).map(task => {
              const disposition = taskDisposition(task)
              const tone = disposition.level === 'imprison' ? 'text-status-error' : 'text-status-warning'
              return (
                <div key={`task-${task.id}`} className="px-3 py-3">
                  <div className="flex items-center gap-2">
                    <span className={`h-2 w-2 rounded-full ${dispositionDotClass(disposition.level)}`} />
                    <div className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">{task.name}</div>
                    <span className={`text-xs ${tone}`}>{disposition.label}</span>
                  </div>
                  <div className="mt-1 text-xs text-text-muted">
                    {disposition.description}
                  </div>
                </div>
              )
            })}
            </div>
          </div>
      </div>
    </div>
  )
}
