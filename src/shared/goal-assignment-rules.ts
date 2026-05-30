import type { GoalStatus, Worker } from './types'

const UNFINISHED_GOAL_STATUSES = new Set<GoalStatus>(['active', 'in_progress', 'blocked'])
const COMPLEX_GOAL_RE = /市场|调研|分析|竞品|竞争|价格|评论|用户|痛点|渠道|品牌|报告|风险|合规|认证|法规|财务|ROI|数据|情报|供应链|专利|标准|国家|地区|众筹|规模|趋势/i
const TRIAL_SCOPE_RE = /最小试运行|试运行|链路验证|临时补位|占位|手动运行后确认|样例验证/i

export function isUnfinishedGoalStatus(status: GoalStatus): boolean {
  return UNFINISHED_GOAL_STATUSES.has(status)
}

export function isComplexGoalDescription(description: string): boolean {
  return COMPLEX_GOAL_RE.test(description) && !TRIAL_SCOPE_RE.test(description)
}

export function isGenericAutoExecutor(worker: Pick<Worker, 'name' | 'role' | 'description' | 'systemPrompt'>): boolean {
  const text = `${worker.name} ${worker.role ?? ''} ${worker.description ?? ''} ${worker.systemPrompt ?? ''}`
  return /^执行弟子-\d+$/.test(worker.name.trim())
    || text.includes('系统自动补位的执行弟子')
    || text.includes('通用执行弟子')
}
