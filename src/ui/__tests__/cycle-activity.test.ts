import { describe, expect, it } from 'vitest'
import { describeCycleActivity } from '../lib/cycle-activity'

describe('cycle activity presentation', () => {
  it('does not present interrupted patrol cycles as gang failure', () => {
    const activity = describeCycleActivity({
      type: 'cycle',
      status: 'failed',
      errorMessage: 'Server restarted',
    })

    expect(activity.label).toBe('已中断')
    expect(activity.reason).toBe('本地服务重启，巡行被打断')
    expect(activity.tone).toBe('warning')
  })

  it('explains missing model configuration as a setup problem', () => {
    const activity = describeCycleActivity({
      type: 'cycle',
      status: 'failed',
      errorMessage: 'No model configured for this worker. Set an explicit worker model or room worker model.',
    })

    expect(activity.label).toBe('配置缺失')
    expect(activity.reason).toBe('帮主没有配置可用模型')
    expect(activity.tone).toBe('error')
  })

  it('keeps real task run failures separate from patrol cycle failures', () => {
    const activity = describeCycleActivity({
      type: 'run',
      status: 'failed',
      errorMessage: 'Tool crashed',
    })

    expect(activity.label).toBe('镖单失败')
    expect(activity.reason).toBe('Tool crashed')
  })
})
