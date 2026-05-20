import type Database from 'better-sqlite3'
import * as queries from './db-queries'
import { announce, object } from './quorum'
import { completeGoal, setRoomObjective } from './goals'
import { triggerAgent } from './agent-loop'
import type { DecisionType } from './types'
import { webFetch, webSearch, browserActionPersistent, type BrowserAction } from './web-tools'
import { WORKER_ROLE_PRESETS } from './constants'

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
    description: 'Delegate a task to a specific worker. Creates a goal assigned to that worker.',
    parameters: {
      type: 'object',
      properties: {
        workerName: { type: 'string', description: 'The worker name to assign to' },
        task: { type: 'string', description: 'Description of the task to delegate' },
        parentGoalId: { type: 'number', description: 'Optional parent goal ID' }
      },
      required: ['workerName', 'task']
    }
  }
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
    description: 'Create a new agent worker.',
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
    purpose: '帮主拆目标、分派镖单、验收子任务。',
    appliesTo: 'queen',
    toolNames: ['company_set_goal', 'company_delegate_task', 'company_complete_goal', 'company_save_wip'],
    keywords: [/目标|委托|镖单|分派|安排|执行|交付|验收|弟子|阻塞|下一步|帮派/],
    baseline: true
  },
  {
    name: '客栈使',
    purpose: '帮主为当前帮派创建或调整弟子。',
    appliesTo: 'queen',
    toolNames: ['company_create_worker', 'company_update_worker'],
    keywords: [/创建弟子|新弟子|招募|客栈|候选|任命|换人|调整弟子|没有弟子|员工/]
  },
  {
    name: '传令使',
    purpose: '帮派内部传递消息、议事和提出异议。',
    appliesTo: 'both',
    toolNames: ['company_send_message', 'company_announce', 'company_object'],
    keywords: [/消息|通知|回复|沟通|议事|会议|讨论|反对|异议|告诉|传递|等待用户|员工消息|待讨论事项/]
  },
  {
    name: '行研使',
    purpose: '执行搜索、网页读取和浏览器动作。',
    appliesTo: 'both',
    toolNames: ['company_web_search', 'company_web_fetch', 'company_browser'],
    keywords: [/搜索|调研|研究|网页|链接|浏览器|外部|公开资料|竞品|ASIN|市场|趋势|数据|证据|抓取|网站/]
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
  const addProfile = (profile: AgentHermesProfile): void => {
    if (!isProfileAvailable(profile, input.isQueen)) return
    if (selected.size >= maxHermes && !selected.has(profile.name)) return
    selected.set(profile.name, profile)
  }

  for (const profile of AGENT_HERMES_PROFILES) {
    if (profile.baseline) addProfile(profile)
  }
  for (const profile of AGENT_HERMES_PROFILES) {
    if (selected.size >= maxHermes) break
    if (profile.baseline) continue
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
        return { content: `Room goal set: "${description}" (goal #${goal.id})` }
      }

      case 'company_delegate_task': {
        const workerName = String(args.workerName ?? args.worker ?? args.to ?? '').trim()
        const task = String(args.task ?? args.description ?? args.goal ?? '').trim()
        if (!workerName) return { content: 'Error: "workerName" is required.', isError: true }
        if (!task) return { content: 'Error: "task" is required.', isError: true }
        const roomWorkers = queries.listRoomWorkers(db, roomId)
        const target = queries.findWorkerByName(roomWorkers, workerName)
        if (!target) {
          const available = roomWorkers.filter(w => w.id !== workerId).map(w => w.name).join(', ')
          return { content: `Worker "${workerName}" not found. Available: ${available || 'none'}`, isError: true }
        }
        const parentGoalId = args.parentGoalId != null ? Number(args.parentGoalId) : undefined
        const goal = queries.createGoal(db, roomId, task, parentGoalId, target.id)
        try { triggerAgent(db, roomId, target.id) } catch { /* may not be running */ }
        return { content: `Task delegated to ${target.name}: "${task}" (goal #${goal.id})` }
      }

      case 'company_complete_goal': {
        const goalId = Number(args.goalId)
        const goalCheck = queries.getGoal(db, goalId)
        if (!goalCheck) return { content: `Error: goal #${goalId} not found.`, isError: true }
        if (goalCheck.roomId !== roomId) return { content: `Error: goal #${goalId} belongs to another room.`, isError: true }
        completeGoal(db, goalId)
        return { content: `Goal #${goalId} marked as completed.` }
      }

      // ── Governance ───────────────────────────────────────────────────
      case 'company_announce': {
        const proposalText = String(args.proposal ?? args.text ?? args.description ?? '').trim()
        if (!proposalText) return { content: 'Error: proposal text is required.', isError: true }
        const recentDecisions = queries.listDecisions(db, roomId)
        const isDuplicate = recentDecisions.slice(0, 10).some(d =>
          (d.status === 'announced' || d.status === 'effective' || d.status === 'approved') &&
          d.proposal.toLowerCase() === proposalText.toLowerCase()
        )
        if (isDuplicate) {
          return { content: `A similar decision already exists: "${proposalText}".`, isError: true }
        }
        const decisionType = String(args.decisionType ?? args.type ?? 'low_impact') as DecisionType
        const decision = announce(db, { roomId, proposerId: workerId, proposal: proposalText, decisionType })
        if (decision.status === 'approved') {
          return { content: `Decision auto-approved: "${proposalText}"` }
        }
        wakeRoomWorkers(db, roomId, workerId)
        return { content: `Decision #${decision.id} announced: "${proposalText}". Effective in 10 min unless objected.` }
      }

      case 'company_object': {
        const decisionId = Number(args.decisionId)
        const reason = String(args.reason ?? 'No reason given').trim()
        try {
          const decision = object(db, decisionId, workerId, reason)
          return { content: `Objected to decision #${decisionId}: ${reason}. Status: ${decision.status}` }
        } catch (e) {
          return { content: (e as Error).message, isError: true }
        }
      }

      // Legacy: support old propose/vote calls from existing MCP tools
      case 'company_propose': {
        const proposalText = String(args.proposal ?? args.text ?? args.description ?? '').trim()
        if (!proposalText) return { content: 'Error: proposal text is required.', isError: true }
        const decisionType = String(args.decisionType ?? args.type ?? 'low_impact') as DecisionType
        const decision = announce(db, { roomId, proposerId: workerId, proposal: proposalText, decisionType })
        if (decision.status === 'approved') {
          return { content: `Decision auto-approved: "${proposalText}"` }
        }
        wakeRoomWorkers(db, roomId, workerId)
        return { content: `Decision #${decision.id} announced: "${proposalText}". Effective in 10 min unless objected.` }
      }

      case 'company_vote': {
        // Legacy: treat vote as object if 'no', otherwise acknowledge
        const decisionId = Number(args.decisionId)
        const voteValue = String(args.vote ?? 'abstain')
        if (voteValue === 'no') {
          const reason = String(args.reasoning ?? 'Voted no')
          try {
            object(db, decisionId, workerId, reason)
            return { content: `Objection recorded on decision #${decisionId}.` }
          } catch {
            return { content: `Vote noted on decision #${decisionId}.` }
          }
        }
        return { content: `Acknowledged on decision #${decisionId}.` }
      }

      // ── Workers ──────────────────────────────────────────────────────
      case 'company_create_worker': {
        const name = String(args.name ?? args.workerName ?? '').trim()
        const systemPrompt = String(args.systemPrompt ?? args.system_prompt ?? args.instructions ?? '').trim()
        if (!name) return { content: 'Error: name is required.', isError: true }
        if (!systemPrompt) return { content: 'Error: systemPrompt is required.', isError: true }
        const existingWorkers = queries.listRoomWorkers(db, roomId)
        if (existingWorkers.some(w => w.name.toLowerCase() === name.toLowerCase())) {
          return { content: `Worker "${name}" already exists.`, isError: true }
        }
        const role = args.role && args.role !== args.name ? String(args.role) : undefined
        const description = args.description ? String(args.description) : undefined
        const preset = role ? WORKER_ROLE_PRESETS[role] : undefined
        const cycleGapMs = args.cycle_gap_ms != null ? Number(args.cycle_gap_ms) : (preset?.cycleGapMs ?? null)
        const maxTurns = args.max_turns != null ? Number(args.max_turns) : (preset?.maxTurns ?? null)
        queries.createWorker(db, { name, role, systemPrompt, description, cycleGapMs, maxTurns, roomId })
        return { content: `Created worker "${name}"${role ? ` (${role})` : ''}.` }
      }

      case 'company_update_worker': {
        const wId = Number(args.workerId)
        const w = queries.getWorker(db, wId)
        if (!w) return { content: `Worker #${wId} not found.`, isError: true }
        const updates: Record<string, unknown> = {}
        if (args.name !== undefined) updates.name = String(args.name)
        if (args.role !== undefined) updates.role = String(args.role)
        if (args.systemPrompt !== undefined) updates.systemPrompt = String(args.systemPrompt)
        if (args.description !== undefined) updates.description = String(args.description)
        if (args.cycle_gap_ms !== undefined) updates.cycleGapMs = args.cycle_gap_ms === null ? null : Number(args.cycle_gap_ms)
        if (args.max_turns !== undefined) updates.maxTurns = args.max_turns === null ? null : Number(args.max_turns)
        queries.updateWorker(db, wId, updates)
        return { content: `Updated worker "${w.name}".` }
      }

      // ── Memory ───────────────────────────────────────────────────────
      case 'company_remember': {
        const name = String(args.name ?? '')
        const content = String(args.content ?? '')
        const type = String(args.type ?? 'fact') as 'fact' | 'preference' | 'person' | 'project' | 'event'
        const existing = queries.listEntities(db, roomId).find(e => e.name.toLowerCase() === name.toLowerCase())
        if (existing) {
          queries.addObservation(db, existing.id, content, 'queen')
          return { content: `Updated memory "${name}".` }
        }
        const entity = queries.createEntity(db, name, type, undefined, roomId)
        queries.addObservation(db, entity.id, content, 'queen')
        return { content: `Remembered "${name}".` }
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
        if (!to) return { content: 'Error: "to" is required.', isError: true }
        if (!message) return { content: 'Error: "message" is required.', isError: true }

        if (to.toLowerCase() === 'keeper') {
          const escalation = queries.createEscalation(db, roomId, workerId, message)
          const deliveryStatus = await deliverQueenMessage(db, roomId, message)
          const deliveryNote = deliveryStatus ? ` ${deliveryStatus}` : ''
          return { content: `Message sent to keeper (#${escalation.id}).${deliveryNote}` }
        }

        const roomWorkers = queries.listRoomWorkers(db, roomId)
        const target = queries.findWorkerByName(roomWorkers, to)
        if (!target) {
          const available = roomWorkers.filter(w => w.id !== workerId).map(w => w.name).join(', ')
          return { content: `Worker "${to}" not found. Available: ${available || 'none'}`, isError: true }
        }
        if (target.id === workerId) return { content: 'Cannot send a message to yourself.', isError: true }
        const escalation = queries.createEscalation(db, roomId, workerId, message, target.id)
        try { triggerAgent(db, roomId, target.id) } catch { /* may not be running */ }
        return { content: `Message sent to ${target.name} (#${escalation.id}).` }
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
