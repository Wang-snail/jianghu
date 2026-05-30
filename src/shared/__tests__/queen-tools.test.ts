import { describe, it, expect } from 'vitest'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { initTestDb } from './helpers/test-db'
import * as queries from '../db-queries'
import { createRoom } from '../room'
import { executeQueenTool } from '../queen-tools'

describe('queen tools', () => {
  it('requires handoff and output constraints when delegating a task', async () => {
    const db = initTestDb()
    const result = createRoom(db, { name: '测试帮', goal: '验证帮主分派协议' })
    const worker = queries.createWorker(db, {
      name: '青衣甲',
      role: 'executor',
      systemPrompt: '执行分派镖单。',
      roomId: result.room.id,
    })

    const missing = await executeQueenTool(db, result.room.id, result.queen.id, 'company_delegate_task', {
      workerName: worker.name,
      task: '整理需求',
    })

    expect(missing.isError).toBe(true)
    expect(missing.content).toContain('上游输入')
    expect(missing.content).toContain('输出格式')
  })

  it('stores upstream, downstream, format, acceptance, trial run, and guardrails in delegated goals', async () => {
    const db = initTestDb()
    const result = createRoom(db, { name: '测试帮', goal: '验证帮主分派协议' })
    const worker = queries.createWorker(db, {
      name: '青衣甲',
      role: 'executor',
      systemPrompt: '执行分派镖单。',
      roomId: result.room.id,
    })

    const delegated = await executeQueenTool(db, result.room.id, result.queen.id, 'company_delegate_task', {
      workerName: worker.name,
      task: '用 3 条样例验证需求澄清表是否可用',
      upstream: '用户原始委托和需求澄清表草案',
      downstream: '帮主验收后交给报告整合弟子',
      outputFormat: 'Markdown 表格：字段、样例、是否通过、问题',
      acceptanceCriteria: '至少发现 1 个格式问题或确认全部字段可用',
      relation: 'review',
      dependsOn: '#1',
      optimizationGoal: '提高交付质量并减少下游返工',
      relationReason: '需求样例先审核，能在报告整合前发现字段缺口。',
      condition: '样例字段齐全后进入审核',
      joinPolicy: '审核通过后才能进入报告整合',
      reworkTarget: '#1',
      trialRun: '只处理 3 条样例，不扩展到全量',
      guardrails: '不得改写原委托目标',
    })

    expect(delegated.isError).toBeUndefined()
    const goals = queries.listGoals(db, result.room.id)
    const assigned = goals.find(goal => goal.assignedWorkerId === worker.id)
    expect(assigned?.description).toContain('## 对接与交付限制')
    expect(assigned?.description).toContain('上游输入：用户原始委托和需求澄清表草案')
    expect(assigned?.description).toContain('下游接收方：帮主验收后交给报告整合弟子')
    expect(assigned?.description).toContain('输出格式：Markdown 表格')
    expect(assigned?.description).toContain('逻辑关系：审核')
    expect(assigned?.description).toContain('依赖节点：#1')
    expect(assigned?.description).toContain('优化目标：提高交付质量并减少下游返工')
    expect(assigned?.description).toContain('关系依据：需求样例先审核，能在报告整合前发现字段缺口。')
    expect(assigned?.description).toContain('触发条件：样例字段齐全后进入审核')
    expect(assigned?.description).toContain('汇合规则：审核通过后才能进入报告整合')
    expect(assigned?.description).toContain('返工节点：#1')
    expect(assigned?.description).toContain('试运行范围：只处理 3 条样例')
    expect(assigned?.description).toContain('禁止偏移：不得改写原委托目标')

    const tasks = queries.listTasks(db, result.room.id)
    const delegatedTask = tasks.find(task => task.workerId === worker.id && task.name.includes('用 3 条样例验证需求澄清表'))
    expect(delegatedTask).toBeTruthy()
    expect(delegatedTask?.description).toContain('上游输入：用户原始委托和需求澄清表草案')
    expect(delegatedTask?.description).toContain('下游接收方：帮主验收后交给报告整合弟子')
    expect(delegatedTask?.description).toContain('输出格式：Markdown 表格')
    expect(delegatedTask?.description).toContain('逻辑关系：审核')
    expect(delegatedTask?.description).toContain('依赖节点：#1')
    expect(delegatedTask?.description).toContain('优化目标：提高交付质量并减少下游返工')
    expect(delegatedTask?.description).toContain('关系依据：需求样例先审核，能在报告整合前发现字段缺口。')
    expect(delegatedTask?.description).toContain('触发条件：样例字段齐全后进入审核')
    expect(delegatedTask?.description).toContain('汇合规则：审核通过后才能进入报告整合')
    expect(delegatedTask?.description).toContain('返工节点：#1')

    const flowMemory = queries.listEntities(db, result.room.id).find(entity => entity.name === '帮派协作流程')
    expect(flowMemory).toBeTruthy()
    const observations = queries.getObservations(db, flowMemory!.id)
    expect(observations[0].content).toContain(`镖单 #${delegatedTask?.id}`)
    expect(observations[0].content).toContain('接单弟子：青衣甲')
    expect(observations[0].content).toContain('验收标准：至少发现 1 个格式问题或确认全部字段可用')
    expect(observations[0].content).toContain('逻辑关系：审核')
    expect(observations[0].content).toContain('优化目标：提高交付质量并减少下游返工')
    expect(observations[0].content).toContain('关系依据：需求样例先审核，能在报告整合前发现字段缺口。')
  })

  it('does not delegate complex work to a generic auto executor', async () => {
    const db = initTestDb()
    const result = createRoom(db, { name: '测试帮', goal: '验证专人专职' })
    const worker = queries.createWorker(db, {
      name: '执行弟子-1',
      role: 'executor',
      description: '系统自动补位的执行弟子。',
      systemPrompt: '通用执行镖单。',
      roomId: result.room.id,
    })

    const delegated = await executeQueenTool(db, result.room.id, result.queen.id, 'company_delegate_task', {
      workerName: worker.name,
      task: '完成空调市场机会真实分析，覆盖行业规模、竞品、品牌和风险',
      upstream: '用户委托和公开资料',
      downstream: '报告整合弟子',
      outputFormat: 'Markdown 报告，包含竞品表和风险清单',
      acceptanceCriteria: '每个关键结论都有来源或样本依据',
      expectedCompletionTime: '60 分钟',
      guardrails: '不得研究非空调品类',
    })

    expect(delegated.isError).toBe(true)
    expect(delegated.content).toContain('专人专职')
    expect(queries.listGoals(db, result.room.id).some(goal => goal.assignedWorkerId === worker.id)).toBe(false)
  })

  it('downgrades nonlinear delegation to sequential when no business reason is provided', async () => {
    const db = initTestDb()
    const result = createRoom(db, { name: '测试帮', goal: '验证业务驱动流程' })
    const worker = queries.createWorker(db, {
      name: '竞品分析弟子',
      role: '竞品分析',
      systemPrompt: '分析竞品。',
      roomId: result.room.id,
    })

    const delegated = await executeQueenTool(db, result.room.id, result.queen.id, 'company_delegate_task', {
      workerName: worker.name,
      task: '分析竞品价格带',
      upstream: '情报采集弟子的竞品清单',
      downstream: '报告整合弟子',
      outputFormat: 'Markdown 表格：品牌、价格、卖点、证据',
      acceptanceCriteria: '至少覆盖 5 个竞品，并说明来源',
      expectedCompletionTime: '30 分钟',
      relation: 'parallel',
      parallelGroup: '竞品与评论并行',
    })

    expect(delegated.isError).toBeUndefined()
    const assigned = queries.listGoals(db, result.room.id).find(goal => goal.assignedWorkerId === worker.id)
    expect(assigned?.description).toContain('逻辑关系：串行')
    expect(assigned?.description).not.toContain('逻辑关系：并行')

    const task = queries.listTasks(db, result.room.id).find(item => item.workerId === worker.id)
    expect(task?.description).not.toContain('逻辑关系：并行')
  })

  it('stores completion as reusable review memory', async () => {
    const db = initTestDb()
    const result = createRoom(db, { name: '测试帮', goal: '验证验收记忆' })
    const goal = queries.createGoal(db, result.room.id, '完成一个可复用的市场分析模板')

    const completed = await executeQueenTool(db, result.room.id, result.queen.id, 'company_complete_goal', {
      goalId: goal.id,
    })

    expect(completed.isError).toBeUndefined()
    const reviewMemory = queries.listEntities(db, result.room.id).find(entity => entity.name === '帮派验收与复盘')
    expect(reviewMemory).toBeTruthy()
    const observations = queries.getObservations(db, reviewMemory!.id)
    expect(observations[0].content).toContain(`委托 #${goal.id} 已完成`)
    expect(observations[0].content).toContain('下次相似任务应先查看该委托的结果')
  })

  it('extracts handoff fields from a Chinese task body when the leader forgets separate tool fields', async () => {
    const db = initTestDb()
    const result = createRoom(db, { name: '测试帮', goal: '验证帮主分派协议' })
    const worker = queries.createWorker(db, {
      name: '青衣甲',
      role: 'executor',
      systemPrompt: '执行分派镖单。',
      roomId: result.room.id,
    })

    const delegated = await executeQueenTool(db, result.room.id, result.queen.id, 'company_delegate_task', {
      workerName: worker.name,
      parentGoalId: 1,
      task: [
        '【镖单：除湿机市场研究最小试运行】',
        '',
        '任务目标：用最小样本验证除湿机市场分析链路。',
        '',
        '上游输入或来源：委托#35；共享计划；公开可查平台和网页资料。',
        '',
        '下游接收方：除湿机市场分析帮帮主，用于下一轮监督纠偏。',
        '',
        '输出格式限制：Markdown，必须包含数据来源清单、竞品表、用户痛点表和进入机会初判。',
        '',
        '验收标准：每个关键判断可追溯到来源或样本，不把空泛常识当结论。',
        '',
        '试运行范围：3个代表平台、6个竞品SKU、20条以内评论样本。',
        '',
        '禁止偏移事项：不要研究空气净化器、空调、加湿器等非除湿机品类。',
      ].join('\n'),
    })

    expect(delegated.isError).toBeUndefined()
    const goals = queries.listGoals(db, result.room.id)
    const assigned = goals.find(goal => goal.assignedWorkerId === worker.id)
    expect(assigned?.description).toContain('任务目标：用最小样本验证除湿机市场分析链路。')
    expect(assigned?.description).toContain('上游输入：委托#35；共享计划；公开可查平台和网页资料。')
    expect(assigned?.description).toContain('下游接收方：除湿机市场分析帮帮主，用于下一轮监督纠偏。')
    expect(assigned?.description).toContain('输出格式：Markdown，必须包含数据来源清单、竞品表、用户痛点表和进入机会初判。')
    expect(assigned?.description).toContain('验收标准：每个关键判断可追溯到来源或样本，不把空泛常识当结论。')
    expect(assigned?.description).toContain('试运行范围：3个代表平台、6个竞品SKU、20条以内评论样本。')
    expect(assigned?.description).toContain('禁止偏移：不要研究空气净化器、空调、加湿器等非除湿机品类。')
  })

  it('loads handoff fields from a referenced shared markdown task card', async () => {
    const db = initTestDb()
    const result = createRoom(db, { name: '测试帮', goal: '验证帮主分派协议' })
    const worker = queries.createWorker(db, {
      name: '青衣甲',
      role: 'executor',
      systemPrompt: '执行分派镖单。',
      roomId: result.room.id,
    })
    const sharedDir = join(process.cwd(), '.company-local-dev', 'companies', String(result.room.id), 'shared')
    const fileName = `queen-tools-delegate-${Date.now()}.md`
    const filePath = join(sharedDir, fileName)
    mkdirSync(sharedDir, { recursive: true })
    writeFileSync(filePath, [
      '# 镖单：除湿机市场研究最小试运行',
      '',
      '## 任务目标',
      '用最小样本完成一次除湿机市场研究试运行。',
      '',
      '## 上游输入或来源',
      '- 委托 #35',
      '- 共享计划',
      '',
      '## 下游接收方',
      '除湿机市场分析帮帮主。',
      '',
      '## 输出格式限制',
      'Markdown，包含来源清单、SKU表、痛点表和机会初判。',
      '',
      '## 验收标准',
      '- 判断可追溯到来源或样本。',
      '- 不把空泛常识当结论。',
      '',
      '## 试运行范围',
      '3个平台，6个SKU，20条以内评论。',
      '',
      '## 禁止偏移事项',
      '不研究空气净化器、空调、加湿器。',
    ].join('\n'))

    try {
      const delegated = await executeQueenTool(db, result.room.id, result.queen.id, 'company_delegate_task', {
        workerName: worker.name,
        task: `请领取并执行共享资料 .company-local-dev/companies/${result.room.id}/shared/${fileName}。`,
      })

      expect(delegated.isError).toBeUndefined()
      const goals = queries.listGoals(db, result.room.id)
      const assigned = goals.find(goal => goal.assignedWorkerId === worker.id)
      expect(assigned?.description).toContain('任务目标：用最小样本完成一次除湿机市场研究试运行。')
      expect(assigned?.description).toContain('上游输入：- 委托 #35 - 共享计划')
      expect(assigned?.description).toContain('下游接收方：除湿机市场分析帮帮主。')
      expect(assigned?.description).toContain('输出格式：Markdown，包含来源清单、SKU表、痛点表和机会初判。')
      expect(assigned?.description).toContain('验收标准：- 判断可追溯到来源或样本。 - 不把空泛常识当结论。')
      expect(assigned?.description).toContain('试运行范围：3个平台，6个SKU，20条以内评论。')
      expect(assigned?.description).toContain('禁止偏移：不研究空气净化器、空调、加湿器。')
    } finally {
      if (existsSync(filePath)) rmSync(filePath)
    }
  })
})
