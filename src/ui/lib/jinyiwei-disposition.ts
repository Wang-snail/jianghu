import type { Task } from '@shared/types'

export type JinyiweiDispositionLevel = 'clear' | 'watch' | 'detain' | 'imprison'

export interface JinyiweiDisposition {
  level: JinyiweiDispositionLevel
  label: string
  description: string
}

export function taskDisposition(task: Pick<Task, 'status' | 'errorCount'>): JinyiweiDisposition {
  if (task.errorCount >= 3) {
    return {
      level: 'imprison',
      label: '囚禁',
      description: `连续失败 ${task.errorCount} 次，冻结执行，需天机处与锦衣卫共同复核后才能放行。`,
    }
  }
  if (task.errorCount >= 2) {
    return {
      level: 'detain',
      label: '拘押',
      description: `连续失败 ${task.errorCount} 次，暂扣执行权，先查根因再决定是否恢复。`,
    }
  }
  if (task.errorCount > 0) {
    return {
      level: 'watch',
      label: '看守',
      description: `最近失败 ${task.errorCount} 次，列入看守，观察下一轮是否继续偏离。`,
    }
  }
  if (task.status === 'paused') {
    return {
      level: 'watch',
      label: '看守',
      description: '镖单暂停，列入看守，需确认恢复条件或归档原因。',
    }
  }
  return {
    level: 'clear',
    label: '放行',
    description: '暂无异常处置。',
  }
}

export function roomDisposition(status: string): JinyiweiDisposition {
  if (status === 'paused') {
    return {
      level: 'watch',
      label: '看守',
      description: '帮派暂停或阻塞，列入看守，需确认原因、责任人和恢复条件。',
    }
  }
  if (status === 'stopped') {
    return {
      level: 'clear',
      label: '归档',
      description: '帮派已停摆，不进入锦衣卫处置链。',
    }
  }
  return {
    level: 'clear',
    label: '放行',
    description: '暂无异常处置。',
  }
}

export function dispositionToneClass(level: JinyiweiDispositionLevel): string {
  if (level === 'imprison') return 'border-status-error bg-status-error-bg text-status-error'
  if (level === 'detain') return 'border-status-warning bg-status-warning-bg text-status-warning'
  if (level === 'watch') return 'border-status-warning bg-status-warning-bg text-status-warning'
  return 'border-status-success bg-status-success-bg text-status-success'
}

export function dispositionDotClass(level: JinyiweiDispositionLevel): string {
  if (level === 'imprison') return 'bg-status-error'
  if (level === 'detain') return 'bg-status-warning'
  if (level === 'watch') return 'bg-status-warning'
  return 'bg-status-success'
}
