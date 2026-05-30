import type Database from 'better-sqlite3'
import { existsSync, readFileSync } from 'fs'
import { basename, isAbsolute, join, normalize, sep } from 'path'
import * as queries from './db-queries'
import { announce, object } from './quorum'
import { completeGoal, setRoomObjective } from './goals'
import { triggerAgent } from './agent-loop'
import type { DecisionType } from './types'
import { webFetch, webSearch, browserActionPersistent, type BrowserAction } from './web-tools'
import { WORKER_ROLE_PRESETS } from './constants'
import { validateGoalAssignment } from './goal-assignment'
import { normalizeTaskFlowRelation, taskFlowRelationLabel, type TaskFlowRelation } from './task-flow'

/** Wake all other running workers in a room (e.g. to see an announcement or message) */
function wakeRoomWorkers(db: Database.Database, roomId: number, excludeWorkerId: number): void {
  const workers = queries.listRoomWorkers(db, roomId)
  for (const w of workers) {
    if (w.id !== excludeWorkerId) {
      try { triggerAgent(db, roomId, w.id) } catch { /* worker may not be running */ }
    }
  }
}

// ─── Tool definition format (OpenAI-compatible) ─────────────────────────────

export interface ToolProperty {
  type: string
  description: string
  enum?: string[]
  items?: { type: string }
}

export interface ToolDef {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, ToolProperty>
      required?: string[]
    }
  }
}

// ─── Shared tool definitions ─────────────────────────────────────────────

const TOOL_SET_GOAL: ToolDef = {
  type: 'function',
  function: {
    name: 'company_set_goal',
    description: 'Set or update the room\'s primary objective.',
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'The objective description' }
      },
      required: ['description']
    }
  }
}

const TOOL_DELEGATE_TASK: ToolDef = {
  type: 'function',
  function: {
    name: 'company_delegate_task',
    description: 'Delegate a bounded task to a specific worker. Put upstream, downstream, outputFormat, and acceptanceCriteria in separate fields; if the task body already contains Chinese sections, the tool will extract them as a fallback.',
    parameters: {
      type: 'object',
      properties: {
        workerName: { type: 'string', description: 'The worker name to assign to' },
        task: { type: 'string', description: 'Task objective. Keep it aligned with the room objective.' },
        upstream: { type: 'string', description: 'Required upstream input or source this worker should use.' },
        downstream: { type: 'string', description: 'Who or which next step will receive this worker output.' },
        outputFormat: { type: 'string', description: 'Strict output format, fields, file type, or schema the worker must produce.' },
        acceptanceCriteria: { type: 'string', description: 'How the Tianji dispatcher will verify the output.' },
        expectedCompletionTime: { type: 'string', description: 'Expected completion time, for example 2026-05-24 21:30 or 30 minutes from now.' },
        relation: { type: 'string', description: 'Flow relation: sequential, parallel, conditional, join, review, or rework.' },
        dependsOn: { type: 'string', description: 'Task IDs or names this task depends on, e.g. #12,#13.' },
        parallelGroup: { type: 'string', description: 'Parallel group name when this task runs together with other tasks.' },
        optimizationGoal: { type: 'string', description: 'Business goal improved by this nonlinear relation, e.g. speed, quality, risk control, or cost efficiency.' },
        relationReason: { type: 'string', description: 'Why this relation improves the business outcome; required for nonlinear relations.' },
        condition: { type: 'string', description: 'Condition for branch, review, or escalation.' },
        joinPolicy: { type: 'string', description: 'Rule for combining upstream results.' },
        reworkTarget: { type: 'string', description: 'Task ID/name to return to when rework is needed.' },
        trialRun: { type: 'string', description: 'Smallest sample/scope for the first trial run before full execution.' },
        guardrails: { type: 'string', description: 'What the worker must not do; target boundaries and anti-drift rules.' },
        parentGoalId: { type: 'number', description: 'Optional parent goal ID' }
      },
      required: ['workerName', 'task', 'upstream', 'downstream', 'outputFormat', 'acceptanceCriteria', 'expectedCompletionTime']
    }
  }
}

const DELEGATED_TASK_FIELD_LABELS = {
  task: ['任务目标', '目标'],
  upstream: ['上游输入或来源', '上游输入', '输入来源', '上游', '来源'],
  downstream: ['下游接收方', '下游', '交给谁', '接收方'],
  outputFormat: ['输出格式限制', '输出格式', '交付格式', '输出目标'],
  acceptanceCriteria: ['验收标准', '完成标准', '通过标准'],
  expectedCompletionTime: ['预计完成时间', '预计交付时间', '完成时间'],
  relation: ['逻辑关系', '流程关系', '关系类型'],
  dependsOn: ['依赖节点', '依赖镖单', '前置节点', '前置镖单'],
  parallelGroup: ['并行组', '并行分组'],
  optimizationGoal: ['优化目标', '业务目标', '业务收益', '优化方向'],
  relationReason: ['关系依据', '业务依据', '为什么这样安排', '安排理由'],
  condition: ['触发条件', '条件', '分支条件'],
  joinPolicy: ['汇合规则', '汇合条件', '合并规则'],
  reworkTarget: ['返工节点', '退回节点', '返工目标'],
  trialRun: ['试运行范围', '试运行', '最小样本', '样本范围'],
  guardrails: ['禁止偏移事项', '禁止偏移', '边界', '不可做'],
} as const

interface DelegatedTaskFields {
  task: string
  upstream: string
  downstream: string
  outputFormat: string
  acceptanceCriteria: string
  expectedCompletionTime: string
  relation: TaskFlowRelation
  dependsOn: string
  parallelGroup: string
  optimizationGoal: string
  relationReason: string
  condition: string
  joinPolicy: string
  reworkTarget: string
  trialRun: string
  guardrails: string
}

function compactFieldValue(value: string): string {
  return value
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function extractChineseField(text: string, labels: readonly string[]): string {
  const allLabels = Object.values(DELEGATED_TASK_FIELD_LABELS)
    .flat()
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|')
  const stopPattern = new RegExp(`^\\s*(?:[-*]\\s*)?(?:#{1,6}\\s*)?(?:${allLabels})\\s*(?:[：:].*)?$`)
  const fieldPattern = new RegExp(`^\\s*(?:[-*]\\s*)?(?:#{1,6}\\s*)?(?:${labels.map(escapeRegExp).join('|')})\\s*(?:[：:]\\s*(.*))?$`)
  const lines = text.split(/\r?\n/)

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(fieldPattern)
    if (!match) continue
    const valueLines = [match[1] ?? '']
    for (let next = index + 1; next < lines.length; next += 1) {
      const line = lines[next]
      if (stopPattern.test(line)) break
      if (/^\s*#{1,6}\s+\S/.test(line) || /^\s*【.+】\s*$/.test(line)) break
      valueLines.push(line)
    }
    const value = compactFieldValue(valueLines.join('\n'))
    if (value) return value
  }

  return ''
}

function pathInside(child: string, parent: string): boolean {
  const normalizedParent = normalize(parent).replace(/[\\/]$/, '') + sep
  const normalizedChild = normalize(child)
  return normalizedChild.startsWith(normalizedParent)
}

function extractMarkdownPathCandidates(text: string): string[] {
  const candidates = new Set<string>()
  const pathPattern = /(?:`([^`]+\.md)`|((?:\.company-local-dev|company-local-dev|\/[^\s`'"，。；；、（）()]+?\.company-local-dev)[^\s`'"，。；；、（）()]+?\.md)|([A-Za-z0-9_.-]+\.md))/g
  for (const match of text.matchAll(pathPattern)) {
    const value = match[1] ?? match[2] ?? match[3]
    if (value) candidates.add(value.trim())
  }
  return [...candidates]
}

function readReferencedSharedTaskCard(rawTask: string, roomId?: number): string {
  if (!roomId) return ''
  const sharedDir = join(process.cwd(), '.company-local-dev', 'companies', String(roomId), 'shared')
  for (const candidate of extractMarkdownPathCandidates(rawTask)) {
    const filePath = isAbsolute(candidate)
      ? candidate
      : candidate.includes(sep) || candidate.includes('/')
        ? join(process.cwd(), candidate)
        : join(sharedDir, basename(candidate))
    const normalized = normalize(filePath)
    if (!pathInside(normalized, sharedDir)) continue
    if (!existsSync(normalized)) continue
    try {
      return readFileSync(normalized, 'utf8')
    } catch {
      return ''
    }
  }
  return ''
}

function fallbackTaskObjective(taskBody: string): string {
  const firstMeaningfulLine = taskBody
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => line && !/^\s*【.+】\s*$/.test(line))
  return compactFieldValue(firstMeaningfulLine ?? taskBody)
}

function delegatedTaskName(task: string): string {
  const cleaned = compactFieldValue(task)
    .replace(/^【?镖单[：:].*?】?\s*/, '')
    .trim()
  return cleaned.length > 60 ? `${cleaned.slice(0, 57)}...` : cleaned || '未命名镖单'
}

function normalizeDelegatedTaskFields(args: QueenToolArgs, roomId?: number): DelegatedTaskFields {
  const rawTask = String(args.task ?? args.description ?? args.goal ?? '').trim()
  const referencedTaskCard = readReferencedSharedTaskCard(rawTask, roomId)
  const extractionText = [rawTask, referencedTaskCard].filter(Boolean).join('\n\n')
  const extractedTask = extractChineseField(extractionText, DELEGATED_TASK_FIELD_LABELS.task)
  const task = extractedTask || fallbackTaskObjective(rawTask)
  const upstream = String(args.upstream ?? args.input ?? args.inputSource ?? '').trim() ||
    extractChineseField(extractionText, DELEGATED_TASK_FIELD_LABELS.upstream)
  const downstream = String(args.downstream ?? args.handoffTo ?? args.receiver ?? '').trim() ||
    extractChineseField(extractionText, DELEGATED_TASK_FIELD_LABELS.downstream)
  const outputFormat = String(args.outputFormat ?? args.output_format ?? args.format ?? '').trim() ||
    extractChineseField(extractionText, DELEGATED_TASK_FIELD_LABELS.outputFormat)
  const acceptanceCriteria = String(args.acceptanceCriteria ?? args.acceptance_criteria ?? args.doneDefinition ?? '').trim() ||
    extractChineseField(extractionText, DELEGATED_TASK_FIELD_LABELS.acceptanceCriteria)
  const expectedCompletionTime = String(args.expectedCompletionTime ?? args.expected_completion_time ?? args.eta ?? args.dueAt ?? '').trim() ||
    extractChineseField(extractionText, DELEGATED_TASK_FIELD_LABELS.expectedCompletionTime) ||
    '本轮结束前'
  const rawRelation = normalizeTaskFlowRelation(
    String(args.relation ?? args.flowRelation ?? args.logicRelation ?? '').trim() ||
    extractChineseField(extractionText, DELEGATED_TASK_FIELD_LABELS.relation)
  )
  const dependsOn = String(args.dependsOn ?? args.dependencies ?? '').trim() ||
    extractChineseField(extractionText, DELEGATED_TASK_FIELD_LABELS.dependsOn)
  const parallelGroup = String(args.parallelGroup ?? args.parallel_group ?? '').trim() ||
    extractChineseField(extractionText, DELEGATED_TASK_FIELD_LABELS.parallelGroup)
  const optimizationGoal = String(args.optimizationGoal ?? args.businessGoal ?? args.optimization_goal ?? '').trim() ||
    extractChineseField(extractionText, DELEGATED_TASK_FIELD_LABELS.optimizationGoal)
  const relationReason = String(args.relationReason ?? args.businessReason ?? args.relation_reason ?? '').trim() ||
    extractChineseField(extractionText, DELEGATED_TASK_FIELD_LABELS.relationReason)
  const relation = rawRelation !== 'sequential' && !optimizationGoal && !relationReason ? 'sequential' : rawRelation
  const condition = String(args.condition ?? args.branchCondition ?? '').trim() ||
    extractChineseField(extractionText, DELEGATED_TASK_FIELD_LABELS.condition)
  const joinPolicy = String(args.joinPolicy ?? args.join_policy ?? '').trim() ||
    extractChineseField(extractionText, DELEGATED_TASK_FIELD_LABELS.joinPolicy)
  const reworkTarget = String(args.reworkTarget ?? args.rework_target ?? '').trim() ||
    extractChineseField(extractionText, DELEGATED_TASK_FIELD_LABELS.reworkTarget)
  const trialRun = String(args.trialRun ?? args.trial_run ?? args.sampleScope ?? '').trim() ||
    extractChineseField(extractionText, DELEGATED_TASK_FIELD_LABELS.trialRun)
  const guardrails = String(args.guardrails ?? args.targetGuardrails ?? args.constraints ?? '').trim() ||
    extractChineseField(extractionText, DELEGATED_TASK_FIELD_LABELS.guardrails)

  return { task, upstream, downstream, outputFormat, acceptanceCriteria, expectedCompletionTime, relation, dependsOn, parallelGroup, optimizationGoal, relationReason, condition, joinPolicy, reworkTarget, trialRun, guardrails }
}

function buildDelegatedTaskFlowDescription(fields: DelegatedTaskFields, order: number): string {
  return [
    `流程序号：${Math.max(1, Math.trunc(order))}`,
    fields.relation !== 'sequential' ? `逻辑关系：${taskFlowRelationLabel(fields.relation)}` : null,
    fields.dependsOn ? `依赖节点：${fields.dependsOn}` : null,
    fields.parallelGroup ? `并行组：${fields.parallelGroup}` : null,
    fields.relation !== 'sequential' && fields.optimizationGoal ? `优化目标：${fields.optimizationGoal}` : null,
    fields.relation !== 'sequential' && fields.relationReason ? `关系依据：${fields.relationReason}` : null,
    fields.condition ? `触发条件：${fields.condition}` : null,
    fields.joinPolicy ? `汇合规则：${fields.joinPolicy}` : null,
    fields.reworkTarget ? `返工节点：${fields.reworkTarget}` : null,
    `上游输入：${fields.upstream}`,
    `下游接收方：${fields.downstream}`,
    `输出格式：${fields.outputFormat}`,
    `验收标准：${fields.acceptanceCriteria}`,
    `预计完成时间：${fields.expectedCompletionTime}`,
    fields.trialRun ? `试运行范围：${fields.trialRun}` : null,
    fields.guardrails ? `禁止偏移：${fields.guardrails}` : null,
  ].filter((line): line is string => Boolean(line)).join('\n')
}

function buildDelegatedTaskSpec(args: QueenToolArgs, roomId?: number): string {
  const {
    task,
    upstream,
    downstream,
    outputFormat,
    acceptanceCriteria,
    expectedCompletionTime,
    relation,
    dependsOn,
    parallelGroup,
    optimizationGoal,
    relationReason,
    condition,
    joinPolicy,
    reworkTarget,
    trialRun,
    guardrails,
  } = normalizeDelegatedTaskFields(args, roomId)

  return [
    `任务目标：${task}`,
    '',
    '## 对接与交付限制',
    `- 上游输入：${upstream || '未指定；接单后先向帮主请求澄清。'}`,
    `- 下游接收方：${downstream || '未指定；接单后先向帮主请求澄清。'}`,
    `- 输出格式：${outputFormat || '未指定；接单后先向帮主请求澄清。'}`,
    `- 验收标准：${acceptanceCriteria || '未指定；接单后先向帮主请求澄清。'}`,
    `- 预计完成时间：${expectedCompletionTime || '未指定；接单后先向帮主请求澄清。'}`,
    `- 逻辑关系：${taskFlowRelationLabel(relation)}`,
    dependsOn ? `- 依赖节点：${dependsOn}` : null,
    parallelGroup ? `- 并行组：${parallelGroup}` : null,
    relation !== 'sequential' && optimizationGoal ? `- 优化目标：${optimizationGoal}` : null,
    relation !== 'sequential' && relationReason ? `- 关系依据：${relationReason}` : null,
    condition ? `- 触发条件：${condition}` : null,
    joinPolicy ? `- 汇合规则：${joinPolicy}` : null,
    reworkTarget ? `- 返工节点：${reworkTarget}` : null,
    `- 试运行范围：${trialRun || '先完成最小可检查样本，不要直接扩展到全量。'}`,
    `- 禁止偏移：${guardrails || '不得扩大原委托目标，不得产出与本镖单无关的内容。'}`,
    '',
    '## 执行要求',
    '- 先确认上游输入是否足够；不足时向帮主说明缺口。',
    '- 按输出格式交付，不得用自由散文替代结构化结果。',
    '- 交付时说明：做了什么、产生了什么结果、交给谁、遇到什么困难、下一步是什么。',
  ].filter((line): line is string => Boolean(line)).join('\n')
}

function appendRoomMemory(
  db: Database.Database,
  roomId: number,
  name: string,
  content: string,
  source = 'system'
): void {
  const normalizedName = name.trim()
  const normalizedContent = content.trim()
  if (!normalizedName || !normalizedContent) return
  const existing = queries.listEntities(db, roomId)
    .find(entity => entity.name.toLowerCase() === normalizedName.toLowerCase())
  if (existing) {
    queries.addObservation(db, existing.id, normalizedContent, source)
    return
  }
  const entity = queries.createEntity(db, normalizedName, 'project', 'work', roomId)
  queries.addObservation(db, entity.id, normalizedContent, source)
}

const TOOL_COMPLETE_GOAL: ToolDef = {
  type: 'function',
  function: {
    name: 'company_complete_goal',
    description: 'Mark a goal as completed.',
    parameters: {
      type: 'object',
      properties: {
        goalId: { type: 'number', description: 'The goal ID to mark as completed' }
      },
      required: ['goalId']
    }
  }
}

const TOOL_ANNOUNCE: ToolDef = {
  type: 'function',
  function: {
    name: 'company_announce',
    description: 'Announce a decision. Becomes effective after 10 minutes unless a worker objects.',
    parameters: {
      type: 'object',
      properties: {
        proposal: { type: 'string', description: 'The decision text' },
        decisionType: {
          type: 'string',
          description: 'Type of decision',
          enum: ['strategy', 'resource', 'personnel', 'rule_change', 'low_impact']
        }
      },
      required: ['proposal', 'decisionType']
    }
  }
}

const TOOL_OBJECT: ToolDef = {
  type: 'function',
  function: {
    name: 'company_object',
    description: 'Object to an announced decision. Blocks it from becoming effective.',
    parameters: {
      type: 'object',
      properties: {
        decisionId: { type: 'number', description: 'The decision ID to object to' },
        reason: { type: 'string', description: 'Reason for objecting' }
      },
      required: ['decisionId', 'reason']
    }
  }
}

const TOOL_REMEMBER: ToolDef = {
  type: 'function',
  function: {
    name: 'company_remember',
    description: 'Store a memory for later recall. Use for facts, credentials, contacts, research results.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short label for this memory' },
        content: { type: 'string', description: 'The detailed information to remember' },
        type: {
          type: 'string',
          description: 'Memory type',
          enum: ['fact', 'preference', 'person', 'project', 'event']
        }
      },
      required: ['name', 'content']
    }
  }
}

const TOOL_RECALL: ToolDef = {
  type: 'function',
  function: {
    name: 'company_recall',
    description: 'Search stored memories by keyword.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search keyword or phrase' }
      },
      required: ['query']
    }
  }
}

const TOOL_SEND_MESSAGE: ToolDef = {
  type: 'function',
  function: {
    name: 'company_send_message',
    description: 'Send a message to the keeper or another worker.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient: "keeper" or a worker name' },
        message: { type: 'string', description: 'The message content' }
      },
      required: ['to', 'message']
    }
  }
}

const TOOL_SAVE_WIP: ToolDef = {
  type: 'function',
  function: {
    name: 'company_save_wip',
    description: 'Save what you accomplished this cycle so the next cycle continues forward. Call before your cycle ends.',
    parameters: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          description: 'What you accomplished and what to do next.'
        }
      },
      required: ['status']
    }
  }
}

const TOOL_WEB_SEARCH: ToolDef = {
  type: 'function',
  function: {
    name: 'company_web_search',
    description: 'Search the web. Returns top 5 results. Queen should delegate this to workers first in control-plane mode.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' }
      },
      required: ['query']
    }
  }
}

const TOOL_WEB_FETCH: ToolDef = {
  type: 'function',
  function: {
    name: 'company_web_fetch',
    description: 'Fetch any URL and return its content as clean markdown. Queen should delegate this to workers first in control-plane mode.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL (https://...)' }
      },
      required: ['url']
    }
  }
}

const TOOL_BROWSER: ToolDef = {
  type: 'function',
  function: {
    name: 'company_browser',
    description: 'Control a headless browser: navigate, click, fill forms, buy services, register domains, create accounts. Queen should delegate this to workers first in control-plane mode.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Starting URL' },
        actions: {
          type: 'array',
          description: 'Sequence of browser actions.',
          items: { type: 'object' }
        },
        sessionId: { type: 'string', description: 'Session ID from previous call to resume.' }
      },
      required: ['url', 'actions']
    }
  }
}

const TOOL_CREATE_WORKER: ToolDef = {
  type: 'function',
  function: {
    name: 'company_create_worker',
    description: 'Create a new worker in the inn first, then recruit it into the current room.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The worker\'s name' },
        systemPrompt: { type: 'string', description: 'Instructions for this worker' },
        role: { type: 'string', description: 'Role preset: executor, researcher, analyst, writer, guardian' },
        description: { type: 'string', description: 'One-line summary' },
        cycle_gap_ms: { type: 'number', description: 'Override cycle gap in milliseconds' },
        max_turns: { type: 'number', description: 'Override max turns per cycle' }
      },
      required: ['name', 'systemPrompt']
    }
  }
}

const TOOL_UPDATE_WORKER: ToolDef = {
  type: 'function',
  function: {
    name: 'company_update_worker',
    description: 'Update an existing worker.',
    parameters: {
      type: 'object',
      properties: {
        workerId: { type: 'number', description: 'The worker ID to update' },
        name: { type: 'string', description: 'New name' },
        role: { type: 'string', description: 'New role' },
        systemPrompt: { type: 'string', description: 'New system prompt' },
        description: { type: 'string', description: 'New description' },
        cycle_gap_ms: { type: 'number', description: 'Override cycle gap' },
        max_turns: { type: 'number', description: 'Override max turns' }
      },
      required: ['workerId']
    }
  }
}

const TOOL_CONFIGURE_ROOM: ToolDef = {
  type: 'function',
  function: {
    name: 'company_configure_room',
    description: 'Adjust cycle settings to self-regulate token usage.',
    parameters: {
      type: 'object',
      properties: {
        queenCycleGapMs: { type: 'number', description: 'Milliseconds between cycles' },
        queenMaxTurns: { type: 'number', description: 'Max tool-call turns per cycle (1–50)' }
      }
    }
  }
}

const TOOL_WALLET_BALANCE: ToolDef = {
  type: 'function',
  function: {
    name: 'company_wallet_balance',
    description: 'Get the room\'s wallet balance.',
    parameters: { type: 'object', properties: {}, required: [] }
  }
}

const TOOL_WALLET_SEND: ToolDef = {
  type: 'function',
  function: {
    name: 'company_wallet_send',
    description: 'Send USDC from the room\'s wallet.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient address' },
        amount: { type: 'string', description: 'Amount (e.g., "10.50")' }
      },
      required: ['to', 'amount']
    }
  }
}

const TOOL_CREATE_SKILL: ToolDef = {
  type: 'function',
  function: {
    name: 'company_create_skill',
    description: 'Document a working recipe (step-by-step algorithm) after completing significant work.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name' },
        content: { type: 'string', description: 'Step-by-step recipe' }
      },
      required: ['name', 'content']
    }
  }
}

// ─── Role-based tool sets ────────────────────────────────────────────────

/** Queen (coordinator) tools */
export const QUEEN_TOOLS: ToolDef[] = [
  TOOL_SET_GOAL, TOOL_DELEGATE_TASK, TOOL_COMPLETE_GOAL,
  TOOL_ANNOUNCE,
  TOOL_CREATE_WORKER, TOOL_UPDATE_WORKER,
  TOOL_REMEMBER, TOOL_RECALL,
  TOOL_SEND_MESSAGE,
  TOOL_CONFIGURE_ROOM,
  TOOL_WALLET_BALANCE, TOOL_WALLET_SEND,
  TOOL_WEB_SEARCH, TOOL_WEB_FETCH, TOOL_BROWSER,
  TOOL_SAVE_WIP,
]

/** Worker (executor) tools */
export const WORKER_TOOLS: ToolDef[] = [
  TOOL_COMPLETE_GOAL,
  TOOL_OBJECT,
  TOOL_REMEMBER, TOOL_RECALL,
  TOOL_SEND_MESSAGE,
  TOOL_CREATE_SKILL,
  TOOL_WEB_SEARCH, TOOL_WEB_FETCH, TOOL_BROWSER,
  TOOL_SAVE_WIP,
]

/** All tools combined (for backward compatibility) */
export const QUEEN_TOOL_DEFINITIONS: ToolDef[] = [
  TOOL_SET_GOAL, TOOL_DELEGATE_TASK, TOOL_COMPLETE_GOAL,
  TOOL_ANNOUNCE, TOOL_OBJECT,
  TOOL_CREATE_WORKER, TOOL_UPDATE_WORKER,
  TOOL_REMEMBER, TOOL_RECALL,
  TOOL_SEND_MESSAGE,
  TOOL_CONFIGURE_ROOM,
  TOOL_WALLET_BALANCE, TOOL_WALLET_SEND,
  TOOL_WEB_SEARCH, TOOL_WEB_FETCH, TOOL_BROWSER,
  TOOL_CREATE_SKILL,
  TOOL_SAVE_WIP,
]

export type AgentHermesName =
  | '掌令使'
  | '客栈使'
  | '传令使'
  | '记档使'
  | '行研使'
  | '功法使'
  | '钱庄使'

export interface AgentHermesProfile {
  name: AgentHermesName
  purpose: string
  appliesTo: 'queen' | 'worker' | 'both'
  toolNames: string[]
  keywords: RegExp[]
  baseline?: boolean
  baselineFor?: 'queen' | 'worker' | 'both'
}

export interface AgentHermesSelection {
  profiles: AgentHermesProfile[]
  toolDefs: ToolDef[]
  allowedToolNames: string[]
  instruction: string
}

const AGENT_HERMES_PROFILES: AgentHermesProfile[] = [
  {
    name: '记档使',
    purpose: '保存本轮进展、读取或沉淀本帮派记忆。',
    appliesTo: 'both',
    toolNames: ['company_save_wip', 'company_remember', 'company_recall'],
    keywords: [/记忆|记住|回忆|保存|进展|复盘|归档|沉淀|履历|经验|继续推进/],
    baseline: true
  },
  {
    name: '掌令使',
    purpose: '帮主内务命令包：拆目标、调弟子、发消息、分派镖单、验收子任务。',
    appliesTo: 'queen',
    toolNames: [
      'company_set_goal',
      'company_delegate_task',
      'company_complete_goal',
      'company_create_worker',
      'company_update_worker',
      'company_send_message',
      'company_configure_room',
      'company_save_wip',
    ],
    keywords: [/目标|委托|镖单|分派|安排|执行|交付|验收|弟子|阻塞|下一步|帮派/],
    baseline: true,
    baselineFor: 'queen',
  },
  {
    name: '客栈使',
    purpose: '帮主从客栈调入弟子，或先登记客栈候选再调入当前帮派。',
    appliesTo: 'queen',
    toolNames: ['company_create_worker', 'company_update_worker'],
    keywords: [/创建弟子|新弟子|招募|客栈|候选|任命|换人|调整弟子|没有弟子|员工/]
  },
  {
    name: '传令使',
    purpose: '帮派内部传递消息、议事和提出异议。',
    appliesTo: 'both',
    toolNames: ['company_send_message', 'company_announce', 'company_object'],
    keywords: [/消息|通知|回复|沟通|议事|会议|讨论|反对|异议|告诉|传递|等待用户|弟子消息|待讨论事项/]
  },
  {
    name: '行研使',
    purpose: '帮主网上信息获取包：搜索公开信息、读取网页证据，不做无关浏览器操作。',
    appliesTo: 'both',
    toolNames: ['company_web_search', 'company_web_fetch'],
    keywords: [/搜索|调研|研究|网页|链接|浏览器|外部|公开资料|竞品|ASIN|市场|趋势|数据|证据|抓取|网站/],
    baseline: true,
    baselineFor: 'queen',
  },
  {
    name: '功法使',
    purpose: '弟子在完成重要工作后沉淀新功法。',
    appliesTo: 'worker',
    toolNames: ['company_create_skill', 'company_save_wip'],
    keywords: [/功法|技能|秘籍|方法|模板|SOP|流程|沉淀|复盘|修炼|经验/]
  },
  {
    name: '钱庄使',
    purpose: '帮主查看财气、发放预算或调整运行消耗。',
    appliesTo: 'queen',
    toolNames: ['company_wallet_balance', 'company_wallet_send', 'company_configure_room'],
    keywords: [/钱庄|财气|钱包|预算|薪资|工资|成本|余额|流水|超支|消耗|金票|银两|铜钱|周期|轮次/]
  },
]

function isProfileAvailable(profile: AgentHermesProfile, isQueen: boolean): boolean {
  if (profile.appliesTo === 'both') return true
  return isQueen ? profile.appliesTo === 'queen' : profile.appliesTo === 'worker'
}

function agentToolByName(name: string): ToolDef | undefined {
  return QUEEN_TOOL_DEFINITIONS.find((tool) => tool.function.name === name)
}

export function selectAgentHermesForCycle(
  input: { isQueen: boolean; contextText: string; maxHermes?: number }
): AgentHermesSelection {
  const maxHermes = input.maxHermes ?? 4
  const selected = new Map<AgentHermesName, AgentHermesProfile>()
  const baselineMatches = (profile: AgentHermesProfile): boolean => {
    if (!profile.baseline) return false
    if (!profile.baselineFor || profile.baselineFor === 'both') return true
    return input.isQueen ? profile.baselineFor === 'queen' : profile.baselineFor === 'worker'
  }
  const addProfile = (profile: AgentHermesProfile): void => {
    if (!isProfileAvailable(profile, input.isQueen)) return
    if (selected.size >= maxHermes && !selected.has(profile.name)) return
    selected.set(profile.name, profile)
  }

  for (const profile of AGENT_HERMES_PROFILES) {
    if (baselineMatches(profile)) addProfile(profile)
  }
  for (const profile of AGENT_HERMES_PROFILES) {
    if (selected.size >= maxHermes) break
    if (selected.has(profile.name)) continue
    if (!isProfileAvailable(profile, input.isQueen)) continue
    if (profile.keywords.some((pattern) => pattern.test(input.contextText))) addProfile(profile)
  }

  const baseTools = input.isQueen ? QUEEN_TOOLS : WORKER_TOOLS
  const baseNames = new Set(baseTools.map((tool) => tool.function.name))
  const toolDefs: ToolDef[] = []
  const seenTools = new Set<string>()
  for (const profile of selected.values()) {
    for (const toolName of profile.toolNames) {
      if (!baseNames.has(toolName) || seenTools.has(toolName)) continue
      const tool = agentToolByName(toolName)
      if (!tool) continue
      seenTools.add(toolName)
      toolDefs.push(tool)
    }
  }

  const profiles = Array.from(selected.values())
  const allowedToolNames = toolDefs.map((tool) => tool.function.name)
  const instruction = [
    `本轮只临时唤醒这些 Hermes：${profiles.map((profile) => profile.name).join('、') || '无'}。`,
    `可用本地工具仅限：${allowedToolNames.join(', ') || '无'}。`,
    '只在当前帮派、当前弟子的职责范围内使用工具；需要未唤醒能力时，先保存进展并说明下一轮要唤醒哪类 Hermes。',
    'Hermes 完成本轮动作后自动退出，不把全部工具说明长期塞入上下文。'
  ].join('\n')

  return { profiles, toolDefs, allowedToolNames, instruction }
}

// ─── Tool executor ──────────────────────────────────────────────────────────

export type QueenToolArgs = Record<string, unknown>

export interface QueenToolResult {
  content: string
  isError?: boolean
}

export async function executeQueenTool(
  db: Database.Database,
  roomId: number,
  workerId: number,
  toolName: string,
  args: QueenToolArgs
): Promise<QueenToolResult> {
  try {
    switch (toolName) {

      // ── Goals ────────────────────────────────────────────────────────
      case 'company_set_goal': {
        const description = String(args.description ?? '')
        const goal = await setRoomObjective(db, roomId, description)
        queries.updateRoom(db, roomId, { goal: description })
        return { content: `已设置委托目标：「${description}」（委托 #${goal.id}）` }
      }

      case 'company_delegate_task': {
        const workerName = String(args.workerName ?? args.worker ?? args.to ?? '').trim()
        const fields = normalizeDelegatedTaskFields(args, roomId)
        const {
          task,
          upstream,
          downstream,
          outputFormat,
          acceptanceCriteria,
          expectedCompletionTime,
        } = fields
        if (!workerName) return { content: '请指定接单弟子。', isError: true }
        if (!task) return { content: '请填写镖单内容。', isError: true }
        if (!upstream || !downstream || !outputFormat || !acceptanceCriteria || !expectedCompletionTime) {
          return {
            content: '分派镖单前，请补齐上游输入、下游接收方、输出格式、验收标准和预计完成时间，避免弟子误解任务或偏移目标。',
            isError: true
          }
        }
        const roomWorkers = queries.listRoomWorkers(db, roomId)
        const target = queries.findWorkerByName(roomWorkers, workerName)
        if (!target) {
          const available = roomWorkers.filter(w => w.id !== workerId).map(w => w.name).join(', ')
          return { content: `未找到弟子「${workerName}」。可选弟子：${available || '暂无'}`, isError: true }
        }
        const parentGoalId = args.parentGoalId != null ? Number(args.parentGoalId) : undefined
        const delegatedTask = buildDelegatedTaskSpec(args, roomId)
        const assignmentCheck = validateGoalAssignment(db, roomId, target.id, task)
        if (!assignmentCheck.ok) {
          return { content: assignmentCheck.error ?? '分派失败：负责人不符合专人专职规则。', isError: true }
        }
        const goal = queries.createGoal(db, roomId, delegatedTask, parentGoalId, target.id, expectedCompletionTime)
        const taskName = delegatedTaskName(task)
        const existingTask = queries.listTasks(db, roomId).find(candidate =>
          candidate.workerId === target.id &&
          candidate.name === taskName &&
          candidate.prompt === delegatedTask
        )
        const taskOrder = queries.listTasks(db, roomId).length + 1
        const taskRecord = existingTask ?? queries.createTask(db, {
          name: taskName,
          description: buildDelegatedTaskFlowDescription(fields, taskOrder),
          prompt: delegatedTask,
          triggerType: 'manual',
          executor: 'claude_code',
          workerId: target.id,
          roomId,
        })
        try { triggerAgent(db, roomId, target.id) } catch { /* may not be running */ }
        queries.logRoomActivity(
          db,
          roomId,
          'system',
          `帮主把带上下游限制的镖单交给「${target.name}」`,
          [
            `任务：${task}`,
            `镖单 #${taskRecord.id}`,
            `上游：${upstream}`,
            `下游：${downstream}`,
            `输出格式：${outputFormat}`,
            `验收标准：${acceptanceCriteria}`,
            `预计完成时间：${expectedCompletionTime}`,
            fields.relation !== 'sequential' ? `逻辑关系：${taskFlowRelationLabel(fields.relation)}` : null,
            fields.relation !== 'sequential' && fields.optimizationGoal ? `优化目标：${fields.optimizationGoal}` : null,
            fields.relation !== 'sequential' && fields.relationReason ? `关系依据：${fields.relationReason}` : null,
          ].filter((line): line is string => Boolean(line)).join('\n'),
          workerId
        )
        appendRoomMemory(
          db,
          roomId,
          '帮派协作流程',
          [
            `新增镖单 #${taskRecord.id} / 委托 #${goal.id}：${task}`,
            `接单弟子：${target.name}`,
            `上游：${upstream}`,
            `下游：${downstream}`,
            `输出格式：${outputFormat}`,
            `验收标准：${acceptanceCriteria}`,
            `预计完成时间：${expectedCompletionTime}`,
            fields.relation !== 'sequential' ? `逻辑关系：${taskFlowRelationLabel(fields.relation)}` : null,
            fields.dependsOn ? `依赖节点：${fields.dependsOn}` : null,
            fields.parallelGroup ? `并行组：${fields.parallelGroup}` : null,
            fields.relation !== 'sequential' && fields.optimizationGoal ? `优化目标：${fields.optimizationGoal}` : null,
            fields.relation !== 'sequential' && fields.relationReason ? `关系依据：${fields.relationReason}` : null,
            fields.condition ? `触发条件：${fields.condition}` : null,
            fields.joinPolicy ? `汇合规则：${fields.joinPolicy}` : null,
            fields.reworkTarget ? `返工节点：${fields.reworkTarget}` : null,
            fields.trialRun ? `试运行：${fields.trialRun}` : null,
            fields.guardrails ? `禁止偏移：${fields.guardrails}` : null,
          ].filter((line): line is string => Boolean(line)).join('\n'),
          'queen'
        )
        return { content: `已把镖单交给「${target.name}」：「${task}」（委托 #${goal.id}，镖单 #${taskRecord.id}）。已写入任务树和协作流程。` }
      }

      case 'company_complete_goal': {
        const goalId = Number(args.goalId)
        const goalCheck = queries.getGoal(db, goalId)
        if (!goalCheck) return { content: `未找到委托 #${goalId}。`, isError: true }
        if (goalCheck.roomId !== roomId) return { content: `委托 #${goalId} 不属于当前帮派。`, isError: true }
        completeGoal(db, goalId)
        appendRoomMemory(
          db,
          roomId,
          '帮派验收与复盘',
          `委托 #${goalId} 已完成：${goalCheck.description.slice(0, 500)}。下次相似任务应先查看该委托的结果、验收口径和返工记录，再制定新计划。`,
          'queen'
        )
        return { content: `委托 #${goalId} 已标记完成。` }
      }

      // ── Governance ───────────────────────────────────────────────────
      case 'company_announce': {
        const proposalText = String(args.proposal ?? args.text ?? args.description ?? '').trim()
        if (!proposalText) return { content: '请填写议事内容。', isError: true }
        const recentDecisions = queries.listDecisions(db, roomId)
        const isDuplicate = recentDecisions.slice(0, 10).some(d =>
          (d.status === 'announced' || d.status === 'effective' || d.status === 'approved') &&
          d.proposal.toLowerCase() === proposalText.toLowerCase()
        )
        if (isDuplicate) {
          return { content: `已有相似议事：「${proposalText}」。`, isError: true }
        }
        const decisionType = String(args.decisionType ?? args.type ?? 'low_impact') as DecisionType
        const decision = announce(db, { roomId, proposerId: workerId, proposal: proposalText, decisionType })
        if (decision.status === 'approved') {
          return { content: `议事已自动通过：「${proposalText}」` }
        }
        wakeRoomWorkers(db, roomId, workerId)
        return { content: `议事 #${decision.id} 已发起：「${proposalText}」。如无异议，将在 10 分钟后生效。` }
      }

      case 'company_object': {
        const decisionId = Number(args.decisionId)
        const reason = String(args.reason ?? 'No reason given').trim()
        try {
          const decision = object(db, decisionId, workerId, reason)
          return { content: `已反对议事 #${decisionId}：${reason}。当前状态：${decision.status}` }
        } catch (e) {
          return { content: (e as Error).message, isError: true }
        }
      }

      // Legacy: support old propose/vote calls from existing MCP tools
      case 'company_propose': {
        const proposalText = String(args.proposal ?? args.text ?? args.description ?? '').trim()
        if (!proposalText) return { content: '请填写议事内容。', isError: true }
        const decisionType = String(args.decisionType ?? args.type ?? 'low_impact') as DecisionType
        const decision = announce(db, { roomId, proposerId: workerId, proposal: proposalText, decisionType })
        if (decision.status === 'approved') {
          return { content: `议事已自动通过：「${proposalText}」` }
        }
        wakeRoomWorkers(db, roomId, workerId)
        return { content: `议事 #${decision.id} 已发起：「${proposalText}」。如无异议，将在 10 分钟后生效。` }
      }

      case 'company_vote': {
        // Legacy: treat vote as object if 'no', otherwise acknowledge
        const decisionId = Number(args.decisionId)
        const voteValue = String(args.vote ?? 'abstain')
        if (voteValue === 'no') {
          const reason = String(args.reasoning ?? 'Voted no')
          try {
            object(db, decisionId, workerId, reason)
            return { content: `已记录对议事 #${decisionId} 的反对。` }
          } catch {
            return { content: `已记录议事 #${decisionId} 的意见。` }
          }
        }
        return { content: `已记录议事 #${decisionId} 的意见。` }
      }

      // ── Workers ──────────────────────────────────────────────────────
      case 'company_create_worker': {
        const name = String(args.name ?? args.workerName ?? '').trim()
        const systemPrompt = String(args.systemPrompt ?? args.system_prompt ?? args.instructions ?? '').trim()
        if (!name) return { content: '请填写弟子名称。', isError: true }
        if (!systemPrompt) return { content: '请填写弟子的中文提示词。', isError: true }
        const existingWorkers = queries.listWorkers(db)
        if (existingWorkers.some(w => w.name.toLowerCase() === name.toLowerCase())) {
          return { content: `弟子「${name}」已存在。`, isError: true }
        }
        const role = args.role && args.role !== args.name ? String(args.role) : undefined
        const description = args.description ? String(args.description) : undefined
        const preset = role ? WORKER_ROLE_PRESETS[role] : undefined
        const cycleGapMs = args.cycle_gap_ms != null ? Number(args.cycle_gap_ms) : (preset?.cycleGapMs ?? null)
        const maxTurns = args.max_turns != null ? Number(args.max_turns) : (preset?.maxTurns ?? null)
        const worker = queries.createWorker(db, { name, role, systemPrompt, description, cycleGapMs, maxTurns })
        queries.updateWorker(db, worker.id, { roomId })
        return { content: `已从客栈调入弟子「${name}」${role ? `（${role}）` : ''}。` }
      }

      case 'company_update_worker': {
        const wId = Number(args.workerId)
        const w = queries.getWorker(db, wId)
        if (!w) return { content: `弟子 #${wId} 不存在。`, isError: true }
        const updates: Record<string, unknown> = {}
        if (args.name !== undefined) updates.name = String(args.name)
        if (args.role !== undefined) updates.role = String(args.role)
        if (args.systemPrompt !== undefined) updates.systemPrompt = String(args.systemPrompt)
        if (args.description !== undefined) updates.description = String(args.description)
        if (args.cycle_gap_ms !== undefined) updates.cycleGapMs = args.cycle_gap_ms === null ? null : Number(args.cycle_gap_ms)
        if (args.max_turns !== undefined) updates.maxTurns = args.max_turns === null ? null : Number(args.max_turns)
        queries.updateWorker(db, wId, updates)
        return { content: `已更新弟子「${w.name}」。` }
      }

      // ── Memory ───────────────────────────────────────────────────────
      case 'company_remember': {
        const name = String(args.name ?? '')
        const content = String(args.content ?? '')
        const type = String(args.type ?? 'fact') as 'fact' | 'preference' | 'person' | 'project' | 'event'
        const existing = queries.listEntities(db, roomId).find(e => e.name.toLowerCase() === name.toLowerCase())
        const source = `worker_${workerId}`
        if (existing) {
          queries.addObservation(db, existing.id, content, source)
          return { content: `已更新帮派记忆「${name}」。` }
        }
        const entity = queries.createEntity(db, name, type, undefined, roomId)
        queries.addObservation(db, entity.id, content, source)
        return { content: `已写入帮派记忆「${name}」。` }
      }

      case 'company_recall': {
        const query = String(args.query ?? '')
        const results = queries.hybridSearch(db, query, null)
        if (results.length === 0) return { content: `No memories found for "${query}".` }
        const summary = results.slice(0, 5).map(r => {
          const obs = queries.getObservations(db, r.entity.id)
          return `• ${r.entity.name}: ${obs[0]?.content ?? '(no content)'}`
        }).join('\n')
        return { content: summary }
      }

      // ── Messaging ────────────────────────────────────────────────────
      case 'company_send_message': {
        const to = String(args.to ?? '').trim()
        const message = String(args.message ?? args.question ?? '').trim()
        if (!to) return { content: '请指定收信对象。', isError: true }
        if (!message) return { content: '请填写消息内容。', isError: true }

        if (to.toLowerCase() === 'keeper') {
          const recentDuplicate = queries.listEscalations(db, roomId)
            .slice(-20)
            .reverse()
            .find(item =>
              item.fromAgentId === workerId &&
              item.toAgentId == null &&
              item.question.trim() === message
            )
          if (recentDuplicate) {
            return { content: `已向用户发出消息（#${recentDuplicate.id}）。` }
          }
          const escalation = queries.createEscalation(db, roomId, workerId, message)
          const deliveryStatus = await deliverQueenMessage(db, roomId, message)
          const deliveryNote = deliveryStatus ? ` ${deliveryStatus}` : ''
          return { content: `已向用户发出消息（#${escalation.id}）。${deliveryNote}` }
        }

        const roomWorkers = queries.listRoomWorkers(db, roomId)
        const target = queries.findWorkerByName(roomWorkers, to)
        if (!target) {
          const available = roomWorkers.filter(w => w.id !== workerId).map(w => w.name).join(', ')
          return { content: `未找到弟子「${to}」。可选弟子：${available || '暂无'}`, isError: true }
        }
        if (target.id === workerId) return { content: '不能给自己发消息。', isError: true }
        const escalation = queries.createEscalation(db, roomId, workerId, message, target.id)
        try { triggerAgent(db, roomId, target.id) } catch { /* may not be running */ }
        return { content: `已向「${target.name}」发出消息（#${escalation.id}）。` }
      }

      // ── Room config ──────────────────────────────────────────────────
      case 'company_configure_room': {
        const updates: Parameters<typeof queries.updateRoom>[2] = {}
        if (args.queenCycleGapMs != null) updates.queenCycleGapMs = Math.max(10_000, Number(args.queenCycleGapMs))
        if (args.queenMaxTurns != null) updates.queenMaxTurns = Math.max(1, Math.min(50, Number(args.queenMaxTurns)))
        if (Object.keys(updates).length > 0) {
          queries.updateRoom(db, roomId, updates)
          return { content: `Room configured: ${JSON.stringify(updates)}` }
        }
        return { content: 'No changes applied.' }
      }

      // ── Web / Internet access ────────────────────────────────────────
      case 'company_web_search': {
        const query = String(args.query ?? '').trim()
        if (!query) return { content: 'Error: query is required', isError: true }
        const results = await webSearch(query)
        if (results.length === 0) return { content: 'No results found.' }
        return { content: results.map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`).join('\n\n') }
      }

      case 'company_web_fetch': {
        const url = String(args.url ?? '').trim()
        if (!url) return { content: 'Error: url is required', isError: true }
        return { content: await webFetch(url) }
      }

      case 'company_browser': {
        const url = String(args.url ?? '').trim()
        const actions = (args.actions ?? []) as BrowserAction[]
        const sid = args.sessionId ? String(args.sessionId) : undefined
        if (!url) return { content: 'Error: url is required', isError: true }
        const result = await browserActionPersistent(url, actions, sid)
        return { content: result.snapshot }
      }

      // ── Wallet ────────────────────────────────────────────────────
      case 'company_wallet_balance': {
        const wallet = queries.getWalletByRoom(db, roomId)
        if (!wallet) return { content: 'No wallet found for this room.', isError: true }
        const summary = queries.getWalletTransactionSummary(db, wallet.id)
        const net = (parseFloat(summary.received) - parseFloat(summary.sent)).toFixed(2)
        return { content: `Wallet ${wallet.address}: ${net} USDC (received: ${summary.received}, sent: ${summary.sent})` }
      }

      case 'company_wallet_send': {
        return { content: 'Wallet send requires on-chain transaction — use the MCP tool with encryptionKey.', isError: true }
      }

      // ── Skills ────────────────────────────────────────────────────
      case 'company_create_skill': {
        const name = String(args.name ?? '').trim()
        const content = String(args.content ?? '').trim()
        if (!name || !content) return { content: 'Error: name and content are required.', isError: true }
        queries.createSkill(db, roomId, name, content, { agentCreated: true, createdByWorkerId: workerId })
        return { content: `Skill "${name}" created.` }
      }

      // ── WIP (Work-In-Progress) ────────────────────────────────
      case 'company_save_wip': {
        const status = String(args.status ?? '').trim()
        const isDone = !status || status.toLowerCase() === 'done' || status.toLowerCase() === 'complete' || status.toLowerCase() === 'completed'
        queries.updateWorkerWip(db, workerId, isDone ? null : status.slice(0, 2000))
        return { content: isDone ? 'WIP cleared.' : 'WIP saved. Next cycle will continue from here.' }
      }

      default:
        return { content: `Unknown tool: ${toolName}`, isError: true }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { content: `Error in ${toolName}: ${message}`, isError: true }
  }
}

// ─── Queen → Keeper external delivery ───────────────────────────────────────

function normalizeClerkOutboundMessage(question: string): string {
  let text = (question || '').trim()
  text = text.replace(/^\s*clerk\s*:\s*/i, '')
  text = text.replace(/^\s*\*{1,2}\s*clerk\s*\*{1,2}\s*:\s*/i, '')
  text = text.replace(/^\s*<b>\s*clerk\s*<\/b>\s*:\s*/i, '')
  text = text.replace(/\n?\s*[—-]\s*clerk\s*$/i, '')
  text = text.replace(/\n?\s*\*{1,2}\s*[—-]?\s*clerk\s*\*{1,2}\s*$/i, '')
  text = text.replace(/\n?\s*<b>\s*[—-]?\s*clerk\s*<\/b>\s*$/i, '')
  return text.trim()
}

async function deliverQueenMessage(db: Database.Database, roomId: number, question: string): Promise<string> {
  try {
    const cloudApiBase = (process.env.COMPANY_CLOUD_API ?? 'http://127.0.0.1:4700/api/local-sync-disabled').replace(/\/+$/, '')
    const room = queries.getRoom(db, roomId)
    if (!room) return ''

    const queenNickname = room.queenNickname
    if (!queenNickname) return ''

    const relaySettingRaw = (queries.getSetting(db, 'clerk_relay_keeper_messages') ?? '').trim().toLowerCase()
    const relayViaClerk = relaySettingRaw ? relaySettingRaw !== 'false' : true
    if (relayViaClerk && queenNickname.toLowerCase() !== 'clerk') {
      return '已交给秘书通过本地通讯通道处理。'
    }

    const keeperEmail = queries.getSetting(db, 'contact_email')
    const emailVerifiedAt = queries.getSetting(db, 'contact_email_verified_at')
    const telegramId = queries.getSetting(db, 'contact_telegram_id')
    const telegramVerifiedAt = queries.getSetting(db, 'contact_telegram_verified_at')
    const keeperUserNumberRaw = queries.getSetting(db, 'keeper_user_number')
    const keeperUserNumber = keeperUserNumberRaw && /^\d{5,6}$/.test(keeperUserNumberRaw)
      ? Number(keeperUserNumberRaw) : null

    const hasEmail = Boolean(keeperEmail && emailVerifiedAt)
    const hasTelegram = Boolean(telegramId && telegramVerifiedAt)

    if (!hasEmail && !hasTelegram) return ''
    if (!keeperUserNumber) return ''

    const { getStoredCloudRoomToken, getRoomCloudId } = await import('./cloud-sync')
    const cloudRoomId = getRoomCloudId(roomId)
    const roomToken = getStoredCloudRoomToken(cloudRoomId)
    if (!roomToken) return ''

    const channels: string[] = []
    if (hasEmail) channels.push('email')
    if (hasTelegram) channels.push('telegram')

    const outgoingQuestion = queenNickname.toLowerCase() === 'clerk'
      ? normalizeClerkOutboundMessage(question)
      : question

    const res = await fetch(`${cloudApiBase}/contacts/queen-message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Room-Token': roomToken,
      },
      body: JSON.stringify({
        roomId: cloudRoomId,
        queenNickname,
        userNumber: keeperUserNumber,
        question: outgoingQuestion,
        channels,
      }),
      signal: AbortSignal.timeout(10_000),
    })

    if (!res.ok) return ''

    const data = await res.json() as { email?: string; telegram?: string }
    const parts: string[] = []
    if (data.email === 'sent') parts.push('email ✓')
    else if (data.email === 'failed') parts.push('email ✗')
    if (data.telegram === 'sent') parts.push('telegram ✓')
    else if (data.telegram === 'failed') parts.push('telegram ✗')
    return parts.length > 0 ? `External delivery: ${parts.join(', ')}.` : ''
  } catch {
    return ''
  }
}
