import type { Task } from './types'

export type TaskFlowRelation = 'sequential' | 'parallel' | 'conditional' | 'join' | 'review' | 'rework'

export interface TaskFlowSpec {
  order: number | null
  relation: TaskFlowRelation
  upstream: string
  downstream: string
  outputFormat: string
  dependsOn: string
  parallelGroup: string
  optimizationGoal: string
  relationReason: string
  condition: string
  joinPolicy: string
  reworkTarget: string
}

export interface TaskFlowPatch {
  order?: number | null
  relation?: TaskFlowRelation
  upstream?: string
  downstream?: string
  outputFormat?: string
  dependsOn?: string
  parallelGroup?: string
  optimizationGoal?: string
  relationReason?: string
  condition?: string
  joinPolicy?: string
  reworkTarget?: string
}

const FLOW_FIELD_LABELS = {
  order: ['流程序号', '工序序号', '工序'],
  relation: ['逻辑关系', '流程关系', '关系类型'],
  upstream: ['上游输入', '输入来源', '上游', '来源'],
  downstream: ['下游接收方', '下游', '交给谁', '接收方'],
  outputFormat: ['输出格式', '交付格式', '输出目标'],
  dependsOn: ['依赖节点', '依赖镖单', '前置节点', '前置镖单'],
  parallelGroup: ['并行组', '并行分组'],
  optimizationGoal: ['优化目标', '业务目标', '业务收益', '优化方向'],
  relationReason: ['关系依据', '业务依据', '为什么这样安排', '安排理由'],
  condition: ['触发条件', '条件', '分支条件'],
  joinPolicy: ['汇合规则', '汇合条件', '合并规则'],
  reworkTarget: ['返工节点', '退回节点', '返工目标'],
} as const

const RELATION_LABELS: Record<TaskFlowRelation, string> = {
  sequential: '串行',
  parallel: '并行',
  conditional: '条件分支',
  join: '汇合',
  review: '审核',
  rework: '返工',
}

const RELATION_ALIASES: Array<[TaskFlowRelation, RegExp]> = [
  ['parallel', /并行|parallel/i],
  ['conditional', /条件|分支|conditional|branch/i],
  ['join', /汇合|合并|join|merge/i],
  ['review', /审核|验收|review|check/i],
  ['rework', /返工|退回|重做|rework|retry/i],
  ['sequential', /串行|顺序|线性|sequential|sequence/i],
]

function compact(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function extractField(text: string, labels: readonly string[]): string {
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const match = text.match(new RegExp(`^\\s*(?:[-*]\\s*)?${escaped}\\s*[：:]\\s*([^\\n]+)`, 'im'))
    if (match?.[1]?.trim()) return compact(match[1])
  }
  return ''
}

export function taskFlowRelationLabel(relation: TaskFlowRelation): string {
  return RELATION_LABELS[relation] ?? RELATION_LABELS.sequential
}

export function isDecisionTaskFlowRelation(relation: TaskFlowRelation): boolean {
  return relation === 'conditional' || relation === 'review' || relation === 'rework'
}

export function normalizeTaskFlowRelation(value: string | TaskFlowRelation | null | undefined): TaskFlowRelation {
  const raw = String(value ?? '').trim()
  if (!raw) return 'sequential'
  if (raw in RELATION_LABELS) return raw as TaskFlowRelation
  for (const [relation, pattern] of RELATION_ALIASES) {
    if (pattern.test(raw)) return relation
  }
  return 'sequential'
}

export function parseTaskFlowSpec(task: Pick<Task, 'description' | 'prompt'>): TaskFlowSpec {
  const text = `${task.description ?? ''}\n${task.prompt ?? ''}`
  const rawOrder = extractField(text, FLOW_FIELD_LABELS.order)
  const order = rawOrder ? Number.parseInt(rawOrder, 10) : NaN
  return {
    order: Number.isFinite(order) && order > 0 ? order : null,
    relation: normalizeTaskFlowRelation(extractField(text, FLOW_FIELD_LABELS.relation)),
    upstream: extractField(text, FLOW_FIELD_LABELS.upstream),
    downstream: extractField(text, FLOW_FIELD_LABELS.downstream),
    outputFormat: extractField(text, FLOW_FIELD_LABELS.outputFormat),
    dependsOn: extractField(text, FLOW_FIELD_LABELS.dependsOn),
    parallelGroup: extractField(text, FLOW_FIELD_LABELS.parallelGroup),
    optimizationGoal: extractField(text, FLOW_FIELD_LABELS.optimizationGoal),
    relationReason: extractField(text, FLOW_FIELD_LABELS.relationReason),
    condition: extractField(text, FLOW_FIELD_LABELS.condition),
    joinPolicy: extractField(text, FLOW_FIELD_LABELS.joinPolicy),
    reworkTarget: extractField(text, FLOW_FIELD_LABELS.reworkTarget),
  }
}

function isFlowLine(line: string): boolean {
  const labels = [
    ...FLOW_FIELD_LABELS.order,
    ...FLOW_FIELD_LABELS.relation,
    ...FLOW_FIELD_LABELS.upstream,
    ...FLOW_FIELD_LABELS.downstream,
    ...FLOW_FIELD_LABELS.outputFormat,
    ...FLOW_FIELD_LABELS.dependsOn,
    ...FLOW_FIELD_LABELS.parallelGroup,
    ...FLOW_FIELD_LABELS.optimizationGoal,
    ...FLOW_FIELD_LABELS.relationReason,
    ...FLOW_FIELD_LABELS.condition,
    ...FLOW_FIELD_LABELS.joinPolicy,
    ...FLOW_FIELD_LABELS.reworkTarget,
  ]
  return labels.some(label => new RegExp(`^\\s*(?:[-*]\\s*)?${label}\\s*[：:]`).test(line))
}

export function upsertTaskFlowDescription(task: Pick<Task, 'description' | 'prompt'>, patch: TaskFlowPatch): string {
  const current = parseTaskFlowSpec(task)
  const next: TaskFlowSpec = {
    order: patch.order !== undefined ? patch.order : current.order,
    relation: patch.relation !== undefined ? normalizeTaskFlowRelation(patch.relation) : current.relation,
    upstream: patch.upstream !== undefined ? compact(patch.upstream) : current.upstream,
    downstream: patch.downstream !== undefined ? compact(patch.downstream) : current.downstream,
    outputFormat: patch.outputFormat !== undefined ? compact(patch.outputFormat) : current.outputFormat,
    dependsOn: patch.dependsOn !== undefined ? compact(patch.dependsOn) : current.dependsOn,
    parallelGroup: patch.parallelGroup !== undefined ? compact(patch.parallelGroup) : current.parallelGroup,
    optimizationGoal: patch.optimizationGoal !== undefined ? compact(patch.optimizationGoal) : current.optimizationGoal,
    relationReason: patch.relationReason !== undefined ? compact(patch.relationReason) : current.relationReason,
    condition: patch.condition !== undefined ? compact(patch.condition) : current.condition,
    joinPolicy: patch.joinPolicy !== undefined ? compact(patch.joinPolicy) : current.joinPolicy,
    reworkTarget: patch.reworkTarget !== undefined ? compact(patch.reworkTarget) : current.reworkTarget,
  }

  const baseLines = (task.description ?? '')
    .split('\n')
    .map(line => line.trimEnd())
    .filter(line => line.trim() && !isFlowLine(line))

  const relation = next.relation !== 'sequential' && !next.optimizationGoal && !next.relationReason
    ? 'sequential'
    : next.relation

  const flowLines = [
    next.order != null ? `流程序号：${Math.max(1, Math.trunc(next.order))}` : null,
    relation !== 'sequential' ? `逻辑关系：${taskFlowRelationLabel(relation)}` : null,
    next.dependsOn ? `依赖节点：${next.dependsOn}` : null,
    next.parallelGroup ? `并行组：${next.parallelGroup}` : null,
    relation !== 'sequential' && next.optimizationGoal ? `优化目标：${next.optimizationGoal}` : null,
    relation !== 'sequential' && next.relationReason ? `关系依据：${next.relationReason}` : null,
    next.condition ? `触发条件：${next.condition}` : null,
    next.joinPolicy ? `汇合规则：${next.joinPolicy}` : null,
    next.reworkTarget ? `返工节点：${next.reworkTarget}` : null,
    next.upstream ? `上游输入：${next.upstream}` : null,
    next.downstream ? `下游接收方：${next.downstream}` : null,
    next.outputFormat ? `输出格式：${next.outputFormat}` : null,
  ].filter((line): line is string => Boolean(line))

  return [...baseLines, ...flowLines].join('\n')
}
