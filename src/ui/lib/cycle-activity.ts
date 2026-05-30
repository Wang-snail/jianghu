export type ActivityKind = 'cycle' | 'run'
export type ActivityTone = 'success' | 'active' | 'warning' | 'error' | 'muted'

export interface ActivityInput {
  type: ActivityKind
  status: string
  errorMessage?: string | null
}

export interface ActivityPresentation {
  label: string
  reason: string | null
  tone: ActivityTone
}

function cleanError(value?: string | null): string | null {
  const text = value?.replace(/\s+/g, ' ').trim()
  if (!text) return null
  return text.length > 72 ? `${text.slice(0, 71)}…` : text
}

function genericStatusLabel(status: string): string {
  if (status === 'active') return '执行中'
  if (status === 'paused') return '已阻塞'
  if (status === 'completed') return '已完成'
  if (status === 'running') return '进行中'
  if (status === 'cancelled') return '已取消'
  if (status === 'error' || status === 'failed') return '已失败'
  return status || '未知'
}

export function describeCycleActivity(input: ActivityInput): ActivityPresentation {
  if (input.status === 'completed') {
    return { label: '已完成', reason: null, tone: 'success' }
  }

  if (input.status === 'running' || input.status === 'active') {
    return { label: '进行中', reason: null, tone: 'active' }
  }

  if (input.status === 'cancelled') {
    return { label: '已取消', reason: null, tone: 'muted' }
  }

  if (input.status !== 'failed' && input.status !== 'error') {
    return { label: genericStatusLabel(input.status), reason: null, tone: 'muted' }
  }

  const error = input.errorMessage ?? ''

  if (input.type === 'run') {
    return { label: '镖单失败', reason: cleanError(error), tone: 'error' }
  }

  if (/No model configured/i.test(error)) {
    return { label: '配置缺失', reason: '帮主没有配置可用模型', tone: 'error' }
  }

  if (/Server restarted/i.test(error)) {
    return { label: '已中断', reason: '本地服务重启，巡行被打断', tone: 'warning' }
  }

  if (/Room stopped by keeper/i.test(error)) {
    return { label: '已停止', reason: '帮派被暂停或停止，巡行自动结束', tone: 'muted' }
  }

  if (/Execution aborted|Superseded by newer cycle/i.test(error)) {
    return { label: '已中断', reason: '被新的操作打断，系统会等下一次巡行', tone: 'warning' }
  }

  if (/unexpected argument '-C'|Usage: codex exec/i.test(error)) {
    return { label: '旧版调用中断', reason: '历史 Codex 启动参数错误，当前代码已修复', tone: 'warning' }
  }

  if (/Incorrect API key|Invalid API key|API key/i.test(error)) {
    return { label: '模型调用失败', reason: 'API 密钥不可用', tone: 'error' }
  }

  if (/timeout|failed to refresh available models/i.test(error)) {
    return { label: '模型连接异常', reason: '模型列表刷新超时，稍后会重试', tone: 'warning' }
  }

  return { label: '巡行失败', reason: cleanError(error), tone: 'error' }
}

export function activityToneClass(tone: ActivityTone): string {
  if (tone === 'success') return 'text-status-success'
  if (tone === 'active') return 'text-interactive'
  if (tone === 'warning') return 'text-status-warning'
  if (tone === 'error') return 'text-status-error'
  return 'text-text-muted'
}
