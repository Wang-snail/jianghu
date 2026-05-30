import { describe, expect, it } from 'vitest'
import { buildProjectOutputSummary } from '../project-outputs'
import type { Goal, Task } from '@shared/types'

function task(overrides: Partial<Task>): Task {
  return {
    id: 1,
    name: '竞品分析',
    description: null,
    prompt: '分析竞品',
    cronExpression: null,
    triggerType: 'manual',
    triggerConfig: null,
    webhookToken: null,
    scheduledAt: null,
    executor: 'codex',
    status: 'completed',
    lastRun: null,
    lastResult: null,
    errorCount: 0,
    maxRuns: null,
    runCount: 1,
    memoryEntityId: null,
    workerId: null,
    sessionContinuity: true,
    sessionId: null,
    timeoutMinutes: null,
    maxTurns: null,
    allowedTools: null,
    disallowedTools: null,
    learnedContext: null,
    roomId: 30,
    createdAt: '2026-05-26T00:00:00.000Z',
    updatedAt: '2026-05-26T00:00:00.000Z',
    ...overrides,
  }
}

function goal(overrides: Partial<Goal>): Goal {
  return {
    id: 1,
    roomId: 30,
    description: '形成除湿机市场机会报告',
    status: 'completed',
    parentGoalId: null,
    assignedWorkerId: null,
    expectedCompletedAt: null,
    progress: 1,
    createdAt: '2026-05-26T00:00:00.000Z',
    updatedAt: '2026-05-26T00:00:00.000Z',
    ...overrides,
  }
}

describe('buildProjectOutputSummary', () => {
  it('surfaces result files and completed task outputs as visible project deliverables', () => {
    const summary = buildProjectOutputSummary({
      roomGoal: '研究除湿机市场机会',
      tasks: [
        task({
          id: 10,
          name: '补齐竞品证据',
          lastResult: '已补齐美国、加拿大和欧洲主要竞品证据，并标记来源强弱。',
        }),
        task({ id: 11, name: '生成正式报告', status: 'active', lastResult: null }),
      ],
      goals: [goal({ id: 20 })],
      files: [
        {
          name: 'dehumidifier_report_assembly_index.md',
          title: '除湿机报告装配索引',
          path: 'results/dehumidifier_report_assembly_index.md',
          updatedAt: '2026-05-26T01:00:00.000Z',
          size: 1200,
          preview: '12 章正式报告建议目录，覆盖行业规模、竞品格局、地区市场和认证标准。',
        },
      ],
    })

    expect(summary.projectObjective).toBe('研究除湿机市场机会')
    expect(summary.primaryFiles[0].title).toBe('除湿机报告装配索引')
    expect(summary.taskOutputs[0]).toMatchObject({
      taskName: '补齐竞品证据',
      result: '已补齐美国、加拿大和欧洲主要竞品证据，并标记来源强弱。',
    })
    expect(summary.missingOutputs).toEqual(['生成正式报告'])
    expect(summary.completedGoalCount).toBe(1)
  })

  it('normalizes mixed filename-derived words in deliverable titles', () => {
    const summary = buildProjectOutputSummary({
      roomGoal: '研究除湿机市场机会',
      tasks: [],
      goals: [],
      files: [
        {
          name: 'dehumidifier_market_review_waiting_card.md',
          title: '除湿机 market 复盘等待卡',
          path: 'results/dehumidifier_market_review_waiting_card.md',
          updatedAt: '2026-05-26T01:00:00.000Z',
          size: 1200,
          preview: '',
        },
      ],
    })

    expect(summary.primaryFiles[0].title).toBe('除湿机 市场 复盘等待卡')
  })
})
