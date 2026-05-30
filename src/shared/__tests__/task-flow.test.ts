import { describe, expect, it } from 'vitest'
import { isDecisionTaskFlowRelation, parseTaskFlowSpec, upsertTaskFlowDescription } from '../task-flow'

describe('task-flow', () => {
  it('parses non-linear flow fields from task descriptions', () => {
    const spec = parseTaskFlowSpec({
      description: [
        '流程序号：3',
        '逻辑关系：条件分支',
        '依赖节点：#1, #2',
        '并行组：市场验证A',
        '优化目标：提速并提升证据质量',
        '关系依据：竞品采集和评论分析互不依赖，可以并行；汇合后再审核。',
        '触发条件：竞品价格带异常时进入',
        '汇合规则：两个上游都验收通过',
        '返工节点：#2',
        '上游输入：情报采集结果',
        '下游接收方：报告整合弟子',
        '输出格式：Markdown 表格',
      ].join('\n'),
      prompt: '',
    })

    expect(spec.order).toBe(3)
    expect(spec.relation).toBe('conditional')
    expect(spec.dependsOn).toBe('#1, #2')
    expect(spec.parallelGroup).toBe('市场验证A')
    expect(spec.optimizationGoal).toBe('提速并提升证据质量')
    expect(spec.relationReason).toBe('竞品采集和评论分析互不依赖，可以并行；汇合后再审核。')
    expect(spec.condition).toBe('竞品价格带异常时进入')
    expect(spec.joinPolicy).toBe('两个上游都验收通过')
    expect(spec.reworkTarget).toBe('#2')
    expect(spec.upstream).toBe('情报采集结果')
    expect(spec.downstream).toBe('报告整合弟子')
    expect(spec.outputFormat).toBe('Markdown 表格')
  })

  it('upserts nonlinear fields while keeping existing non-flow notes', () => {
    const description = upsertTaskFlowDescription({
      description: [
        '当前说明：先看样本质量。',
        '流程序号：1',
        '上游输入：旧输入',
      ].join('\n'),
      prompt: '',
    }, {
      order: 2,
      relation: 'parallel',
      dependsOn: '#1',
      parallelGroup: '竞品与用户并行',
      optimizationGoal: '缩短等待时间',
      relationReason: '两个节点使用不同来源，可独立推进，汇合后统一核验。',
      upstream: '公开平台样本',
      downstream: '汇合审核节点',
      outputFormat: '证据表',
    })

    expect(description).toContain('当前说明：先看样本质量。')
    expect(description).toContain('流程序号：2')
    expect(description).toContain('逻辑关系：并行')
    expect(description).toContain('依赖节点：#1')
    expect(description).toContain('并行组：竞品与用户并行')
    expect(description).toContain('优化目标：缩短等待时间')
    expect(description).toContain('关系依据：两个节点使用不同来源，可独立推进，汇合后统一核验。')
    expect(description).toContain('上游输入：公开平台样本')
    expect(description).toContain('下游接收方：汇合审核节点')
    expect(description).toContain('输出格式：证据表')
    expect(description).not.toContain('旧输入')
  })

  it('does not persist a complex relation without a business reason', () => {
    const description = upsertTaskFlowDescription({
      description: '当前说明：先整理任务。',
      prompt: '',
    }, {
      order: 1,
      relation: 'parallel',
      upstream: '用户委托',
    })

    expect(description).toContain('流程序号：1')
    expect(description).toContain('上游输入：用户委托')
    expect(description).not.toContain('逻辑关系：并行')
  })

  it('marks only branch-like relations as decision nodes', () => {
    expect(isDecisionTaskFlowRelation('conditional')).toBe(true)
    expect(isDecisionTaskFlowRelation('review')).toBe(true)
    expect(isDecisionTaskFlowRelation('rework')).toBe(true)
    expect(isDecisionTaskFlowRelation('sequential')).toBe(false)
    expect(isDecisionTaskFlowRelation('parallel')).toBe(false)
    expect(isDecisionTaskFlowRelation('join')).toBe(false)
  })
})
