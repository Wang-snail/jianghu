import type Database from 'better-sqlite3'
import * as queries from './db-queries'
import { createRoom, pauseRoom, restartRoom, deleteRoom } from './room'
import { triggerAgent } from './agent-loop'
import type { ToolDef } from './queen-tools'
import type { Task, VoteValue, Worker } from './types'
import { getRoomCloudId } from './cloud-sync'
import { keeperVote } from './quorum'
import { stopRoomRuntime } from '../server/runtime'
import { upsertTaskFlowDescription, parseTaskFlowSpec, taskFlowRelationLabel, type TaskFlowRelation } from './task-flow'
import { isAssignableWorker } from './worker-roles'

export type ClerkToolArgs = Record<string, unknown>

export interface ClerkToolResult {
  content: string
  isError?: boolean
}

export const CLERK_TOOL_DEFINITIONS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'company_list_rooms',
      description: 'List rooms and their current state.',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', description: 'Optional room status filter: active, paused, or stopped' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'company_create_room',
      description: 'Create a new room with sensible defaults. Only objective is required; name can be auto-generated.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Optional single-word room name. Auto-generated from objective if omitted.' },
          goal: { type: 'string', description: 'Room objective' },
          objective: { type: 'string', description: 'Alias for goal' },
          model: { type: 'string', description: 'Optional default room model (claude, codex, openai:..., anthropic:...)' },
          visibility: { type: 'string', description: 'Optional visibility: private or public' },
          queenCycleGapMs: { type: 'number', description: 'Optional queen cycle gap in milliseconds' },
          queenMaxTurns: { type: 'number', description: 'Optional queen max turns per cycle' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'company_update_room',
      description: 'Update room settings and control parameters.',
      parameters: {
        type: 'object',
        properties: {
          roomId: { type: 'number', description: 'Room ID' },
          roomName: { type: 'string', description: 'Room name (alternative to roomId)' },
          goal: { type: 'string', description: 'Objective text' },
          workerModel: { type: 'string', description: 'Default worker model' },
          visibility: { type: 'string', description: 'private or public' },
          queenCycleGapMs: { type: 'number', description: 'Queen cycle gap in milliseconds' },
          queenMaxTurns: { type: 'number', description: 'Queen max turns per cycle' },
          queenQuietFrom: { type: 'string', description: 'Quiet hours start (HH:mm) or null to clear' },
          queenQuietUntil: { type: 'string', description: 'Quiet hours end (HH:mm) or null to clear' },
          maxConcurrentTasks: { type: 'number', description: 'Max concurrent tasks (1-10)' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'company_pause_room',
      description: 'Pause a room (stop its workers).',
      parameters: {
        type: 'object',
        properties: {
          roomId: { type: 'number', description: 'Room ID' },
          roomName: { type: 'string', description: 'Room name (alternative to roomId)' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'company_restart_room',
      description: 'Restart a room and optionally set a new goal.',
      parameters: {
        type: 'object',
        properties: {
          roomId: { type: 'number', description: 'Room ID' },
          roomName: { type: 'string', description: 'Room name (alternative to roomId)' },
          goal: { type: 'string', description: 'Optional new room objective' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'company_delete_room',
      description: 'Delete a room and all its data.',
      parameters: {
        type: 'object',
        properties: {
          roomId: { type: 'number', description: 'Room ID' },
          roomName: { type: 'string', description: 'Room name (alternative to roomId)' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'company_start_queen',
      description: 'Start queen loop for a room.',
      parameters: {
        type: 'object',
        properties: {
          roomId: { type: 'number', description: 'Room ID' },
          roomName: { type: 'string', description: 'Room name (alternative to roomId)' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'company_stop_queen',
      description: 'Stop queen loop for a room.',
      parameters: {
        type: 'object',
        properties: {
          roomId: { type: 'number', description: 'Room ID' },
          roomName: { type: 'string', description: 'Room name (alternative to roomId)' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'company_message_room',
      description: 'Send a keeper message to a specific local room (delivered as an escalation to that room\'s queen).',
      parameters: {
        type: 'object',
        properties: {
          roomId: { type: 'number', description: 'Target room ID' },
          roomName: { type: 'string', description: 'Target room name (alternative to roomId)' },
          message: { type: 'string', description: 'Message content from keeper' }
        },
        required: ['message']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'company_list_keeper_requests',
      description: 'List pending room requests that need keeper attention: unresolved escalations, keeper votes, and unread inbound room messages.',
      parameters: {
        type: 'object',
        properties: {
          roomId: { type: 'number', description: 'Optional room ID filter' },
          roomName: { type: 'string', description: 'Optional room name filter (alternative to roomId)' },
          limit: { type: 'number', description: 'Optional max items to return (default 25)' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'company_resolve_escalation',
      description: 'Reply to a pending room escalation on behalf of keeper.',
      parameters: {
        type: 'object',
        properties: {
          escalationId: { type: 'number', description: 'Escalation ID to resolve' },
          answer: { type: 'string', description: 'Keeper answer to deliver to room' },
        },
        required: ['escalationId', 'answer']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'company_keeper_vote',
      description: 'Cast keeper vote for a decision (yes/no/abstain).',
      parameters: {
        type: 'object',
        properties: {
          decisionId: { type: 'number', description: 'Decision ID' },
          vote: { type: 'string', description: 'Vote value: yes, no, or abstain' }
        },
        required: ['decisionId', 'vote']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'company_reply_room_message',
      description: 'Reply to an inbound inter-room message on behalf of keeper.',
      parameters: {
        type: 'object',
        properties: {
          messageId: { type: 'number', description: 'Inbound room message ID' },
          body: { type: 'string', description: 'Reply body text' },
          subject: { type: 'string', description: 'Optional custom subject' },
          toRoomId: { type: 'string', description: 'Optional explicit target room ID (defaults to original sender)' }
        },
        required: ['messageId', 'body']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'company_message_other_room',
      description: 'Send an inter-room message on behalf of keeper from one local room to another room (local or cloud).',
      parameters: {
        type: 'object',
        properties: {
          fromRoomId: { type: 'number', description: 'Source local room ID (optional; defaults to first active room)' },
          fromRoomName: { type: 'string', description: 'Source local room name (alternative to fromRoomId)' },
          toRoomId: { type: 'string', description: 'Target cloud room ID' },
          toRoomName: { type: 'string', description: 'Target local room name (converted to cloud ID automatically)' },
          subject: { type: 'string', description: 'Message subject' },
          body: { type: 'string', description: 'Message body' }
        },
        required: ['body']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'company_list_tasks',
      description: 'List scheduled or manual tasks across rooms.',
      parameters: {
        type: 'object',
        properties: {
          roomId: { type: 'number', description: 'Optional room ID filter' },
          roomName: { type: 'string', description: 'Optional room name filter (alternative to roomId)' },
          status: { type: 'string', description: 'Optional status filter: active, paused, completed' },
          limit: { type: 'number', description: 'Optional max tasks to return (1-100, default 20)' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'company_create_task',
      description: 'Create a task for a room (or global). Supports manual, one-time, or cron scheduling.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Task name' },
          prompt: { type: 'string', description: 'Task execution prompt' },
          description: { type: 'string', description: 'Optional task description' },
          roomId: { type: 'number', description: 'Optional room ID' },
          roomName: { type: 'string', description: 'Optional room name (alternative to roomId)' },
          workerId: { type: 'number', description: 'Optional worker ID to assign task to' },
          cronExpression: { type: 'string', description: 'Cron expression for recurring schedule' },
          scheduledAt: { type: 'string', description: 'One-time schedule time (ISO or parseable datetime)' },
          maxTurns: { type: 'number', description: 'Optional per-run max turns' },
          timeoutMinutes: { type: 'number', description: 'Optional timeout minutes per run' }
        },
        required: ['name', 'prompt']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'company_update_task_flow',
      description: 'Update a task swimlane flow: order, assigned worker, upstream input, downstream receiver, output format, and nonlinear relation such as parallel, condition, join, review, or rework.',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'number', description: 'Task ID' },
          taskName: { type: 'string', description: 'Task name, used when taskId is not provided' },
          roomId: { type: 'number', description: 'Optional room ID to narrow task lookup' },
          roomName: { type: 'string', description: 'Optional room name to narrow task lookup' },
          workerId: { type: 'number', description: 'Assignable worker ID; use null to clear assignment' },
          workerName: { type: 'string', description: 'Assignable worker name; use when workerId is not provided' },
          order: { type: 'number', description: 'Positive swimlane step order' },
          relation: { type: 'string', description: 'Flow relation: sequential, parallel, conditional, join, review, or rework' },
          dependsOn: { type: 'string', description: 'Upstream task IDs/names this task depends on, e.g. #12,#13' },
          parallelGroup: { type: 'string', description: 'Parallel group name when multiple tasks can run together' },
          optimizationGoal: { type: 'string', description: 'Business goal this relation improves, e.g. speed, quality, risk control, cost efficiency' },
          relationReason: { type: 'string', description: 'Why this relation is better for the business outcome; required for meaningful nonlinear relations' },
          condition: { type: 'string', description: 'Condition that decides this branch or review path' },
          joinPolicy: { type: 'string', description: 'Join rule, e.g. all upstream tasks must pass' },
          reworkTarget: { type: 'string', description: 'Task ID/name to return to when this task requests rework' },
          upstream: { type: 'string', description: 'Upstream input constraint' },
          downstream: { type: 'string', description: 'Downstream receiver constraint' },
          outputFormat: { type: 'string', description: 'Required output format constraint' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'company_repair_task_flow',
      description: 'Inspect and repair broken task flow fields for a room or task: missing order, missing handoff fields, invalid dependencies, invalid decision paths, or unassigned/invalid workers.',
      parameters: {
        type: 'object',
        properties: {
          roomId: { type: 'number', description: 'Optional room ID to repair' },
          roomName: { type: 'string', description: 'Optional room name to repair' },
          taskId: { type: 'number', description: 'Optional task ID; if omitted, repair all tasks in the room' },
          taskName: { type: 'string', description: 'Optional task name; used when taskId is not provided' },
          issue: { type: 'string', description: 'User feedback describing what is wrong with the flow' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'company_remind_keeper',
      description: 'Schedule a one-time reminder message to the keeper at a specific time.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Reminder text to deliver to the keeper' },
          scheduledAt: { type: 'string', description: 'When to remind (ISO or parseable datetime)' },
          roomId: { type: 'number', description: 'Optional room context for this reminder' },
          roomName: { type: 'string', description: 'Optional room context (alternative to roomId)' },
          name: { type: 'string', description: 'Optional reminder task name' }
        },
        required: ['message', 'scheduledAt']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'company_send_email',
      description: 'Send an email from your own clerk address. Use "admin" as the to address to reach the keeper/developer.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Recipient email address, or "admin" to send to the keeper' },
          subject: { type: 'string', description: 'Email subject line' },
          body: { type: 'string', description: 'Email body text' }
        },
        required: ['to', 'body']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'company_get_setting',
      description: 'Read any global setting by key.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Setting key' }
        },
        required: ['key']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'company_set_setting',
      description: 'Write any global setting key/value.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Setting key' },
          value: { type: 'string', description: 'Setting value' }
        },
        required: ['key', 'value']
      }
    }
  },
]

export type ClerkHermesName =
  | '巡江使'
  | '开帮使'
  | '工序使'
  | '传书使'
  | '钱庄使'
  | '守门使'

export interface ClerkHermesProfile {
  name: ClerkHermesName
  purpose: string
  toolNames: string[]
  keywords: RegExp[]
}

export interface ClerkHermesSelection {
  profiles: ClerkHermesProfile[]
  toolDefs: ToolDef[]
  instruction: string
}

export const CLERK_HERMES_PROFILES: ClerkHermesProfile[] = [
  {
    name: '巡江使',
    purpose: '查看江湖现状、帮派、镖单和待处理请求。',
    toolNames: [
      'company_list_rooms',
      'company_list_tasks',
      'company_list_keeper_requests'
    ],
    keywords: [/看|查|列|哪些|状态|运行|进展|纵览|了解|请求|待处理|堵|拥堵|任务|镖单|帮派/]
  },
  {
    name: '开帮使',
    purpose: '创建、调整、启动或暂停帮派。',
    toolNames: [
      'company_list_rooms',
      'company_create_room',
      'company_update_room',
      'company_pause_room',
      'company_restart_room'
    ],
    keywords: [/新建|创建|成立|开帮|建帮|修改|调整|启动|运行|暂停|恢复|重启|目标|介绍|说明/]
  },
  {
    name: '工序使',
    purpose: '创建镖单、查看任务、调整弟子协作流程和安排提醒。',
    toolNames: [
      'company_list_tasks',
      'company_create_task',
      'company_update_task_flow',
      'company_repair_task_flow',
      'company_remind_keeper'
    ],
    keywords: [/任务|镖单|委托|安排|提醒|定时|计划|排期|执行|分派|交付|流程|泳道|上游|下游|输出格式|交接|前移|后移|顺序|出错|错误|修复|不对|异常|混乱|断开|连不上/]
  },
  {
    name: '传书使',
    purpose: '在用户、帮派、待处理请求和龙门镖局帮派间传书之间传递消息；龙门镖局只负责帮派之间的信息传输。',
    toolNames: [
      'company_message_room',
      'company_list_keeper_requests',
      'company_resolve_escalation',
      'company_keeper_vote',
      'company_reply_room_message',
      'company_message_other_room',
      'company_send_email'
    ],
    keywords: [/告诉|通知|回复|传话|消息|沟通|对话|请求|答复|议事|会议|投票|决定|联系|邮件|email/i]
  },
  {
    name: '钱庄使',
    purpose: '读取或调整少量全局配置；预算和流水仍按钱庄页面展示。',
    toolNames: [
      'company_get_setting',
      'company_set_setting'
    ],
    keywords: [/设置|配置|模型|密钥|预算|钱庄|财气|流水|薪资|成本|余额|钱包/]
  },
  {
    name: '守门使',
    purpose: '处理删除、停止和清理等高风险控制动作。',
    toolNames: [
      'company_list_rooms',
      'company_pause_room',
      'company_stop_queen',
      'company_delete_room'
    ],
    keywords: [/删除|移除|清理|关闭|停止|终止|封禁|逐出|废弃/]
  },
]

function toolByName(name: string): ToolDef | undefined {
  return CLERK_TOOL_DEFINITIONS.find((tool) => tool.function.name === name)
}

function matchesHermes(message: string, profile: ClerkHermesProfile): boolean {
  return profile.keywords.some((pattern) => pattern.test(message))
}

export function selectClerkHermesForMessage(message: string, maxHermes: number = 3): ClerkHermesSelection {
  const text = message.trim()
  const selected = new Map<ClerkHermesName, ClerkHermesProfile>()
  const addProfile = (profile: ClerkHermesProfile): void => {
    if (selected.size >= maxHermes && !selected.has(profile.name)) return
    selected.set(profile.name, profile)
  }

  const patrol = CLERK_HERMES_PROFILES.find((profile) => profile.name === '巡江使')
  if (patrol) addProfile(patrol)

  for (const profile of CLERK_HERMES_PROFILES) {
    if (selected.size >= maxHermes) break
    if (profile.name === '巡江使') continue
    if (matchesHermes(text, profile)) addProfile(profile)
  }

  const toolDefs: ToolDef[] = []
  const seenTools = new Set<string>()
  for (const profile of selected.values()) {
    for (const toolName of profile.toolNames) {
      if (seenTools.has(toolName)) continue
      const tool = toolByName(toolName)
      if (!tool) continue
      seenTools.add(toolName)
      toolDefs.push(tool)
    }
  }

  const profileList = Array.from(selected.values())
  const names = profileList.map((profile) => profile.name).join('、')
  const toolList = toolDefs.map((tool) => tool.function.name).join(', ')
  const instruction = [
    `本轮只临时唤醒这些 Hermes：${names || '无'}。`,
    `可用本地工具仅限：${toolList || '无'}。`,
    '不要假装拥有未列出的工具；如果需要未唤醒的 Hermes，先说明需要什么能力，再由下一轮按需唤醒。',
    'Hermes 只服务当前对话回合，动作完成后自动退出，不把工具说明长期塞入上下文。'
  ].join('\n')

  return { profiles: profileList, toolDefs, instruction }
}

function parseRoomIdArg(args: ClerkToolArgs): number | null {
  const raw = args.roomId ?? args.id
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.trunc(raw)
  if (typeof raw === 'string' && raw.trim()) {
    const parsed = Number.parseInt(raw, 10)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function resolveRoom(db: Database.Database, args: ClerkToolArgs): ReturnType<typeof queries.getRoom> {
  const byId = parseRoomIdArg(args)
  if (byId != null) return queries.getRoom(db, byId)

  const roomName = String(args.roomName ?? args.name ?? '').trim().toLowerCase()
  if (!roomName) return null
  return queries.listRooms(db).find((room) => room.name.toLowerCase() === roomName) ?? null
}

function resolveFromRoom(db: Database.Database, args: ClerkToolArgs): ReturnType<typeof queries.getRoom> {
  const fromArgs: ClerkToolArgs = {
    roomId: args.fromRoomId,
    roomName: args.fromRoomName
  }
  const explicit = resolveRoom(db, fromArgs)
  if (explicit) return explicit

  const active = queries.listRooms(db).find((room) => room.status === 'active')
  if (active) return active
  return queries.listRooms(db)[0] ?? null
}

function resolveTaskForFlow(
  db: Database.Database,
  args: ClerkToolArgs,
  room: ReturnType<typeof queries.getRoom>
): { task: Task | null; error?: string } {
  const taskId = parseIntArg(args.taskId ?? args.id)
  if (taskId != null) {
    const task = queries.getTask(db, taskId)
    if (!task) return { task: null, error: `镖单 #${taskId} 不存在。` }
    if (room && task.roomId !== room.id) {
      return { task: null, error: `镖单 #${taskId} 不属于帮派「${room.name}」。` }
    }
    return { task }
  }

  const rawName = String(args.taskName ?? args.name ?? '').trim()
  if (!rawName) return { task: null, error: '需要提供 taskId 或 taskName。' }

  const normalized = rawName.toLowerCase()
  const candidates = queries.listTasks(db, room?.id).filter((task) => {
    const name = task.name.toLowerCase()
    return name === normalized || name.includes(normalized)
  })
  if (candidates.length === 0) return { task: null, error: `没有找到名为「${rawName}」的镖单。` }
  const exact = candidates.filter((task) => task.name.toLowerCase() === normalized)
  const matches = exact.length > 0 ? exact : candidates
  if (matches.length > 1) {
    return {
      task: null,
      error: `找到 ${matches.length} 张相近镖单，请指定 taskId：${matches.map((task) => `#${task.id} ${task.name}`).join('；')}`
    }
  }
  return { task: matches[0] ?? null }
}

function resolveAssignableWorkerForTask(
  db: Database.Database,
  task: Task,
  args: ClerkToolArgs
): { workerId?: number | null; worker?: Worker; error?: string } {
  const hasWorkerId = Object.prototype.hasOwnProperty.call(args, 'workerId')
  if (hasWorkerId && (args.workerId === null || String(args.workerId).trim() === '')) {
    return { workerId: null }
  }

  let worker: Worker | null = null
  const workerId = parseIntArg(args.workerId)
  if (workerId != null) {
    worker = queries.getWorker(db, workerId)
    if (!worker) return { error: `弟子 #${workerId} 不存在。` }
  } else {
    const workerName = String(args.workerName ?? '').trim()
    if (!workerName) return {}
    const normalized = workerName.toLowerCase()
    const candidates = queries.listWorkers(db).filter((item) => {
      if (task.roomId != null && item.roomId !== task.roomId) return false
      const name = item.name.toLowerCase()
      return name === normalized || name.includes(normalized)
    })
    if (candidates.length === 0) return { error: `客栈或当前帮派中没有找到可分派弟子「${workerName}」。` }
    const exact = candidates.filter((item) => item.name.toLowerCase() === normalized)
    const matches = exact.length > 0 ? exact : candidates
    if (matches.length > 1) {
      return {
        error: `找到 ${matches.length} 位相近弟子，请指定 workerId：${matches.map((item) => `#${item.id} ${item.name}`).join('；')}`
      }
    }
    worker = matches[0] ?? null
  }

  if (!worker) return {}
  const room = task.roomId != null ? queries.getRoom(db, task.roomId) : null
  if (task.roomId != null && worker.roomId !== task.roomId) {
    return { error: `弟子「${worker.name}」不属于当前帮派，不能分派到这张镖单。` }
  }
  if (!isAssignableWorker(worker, room?.queenWorkerId ?? null)) {
    return { error: `「${worker.name}」是天机阁、帮主或守卫角色，不能被分派为执行弟子。` }
  }
  return { workerId: worker.id, worker }
}

function taskFlowRefIds(value: string): number[] {
  const ids = new Set<number>()
  for (const match of value.matchAll(/#?(\d+)/g)) {
    const id = Number(match[1])
    if (Number.isFinite(id) && id > 0) ids.add(id)
  }
  return [...ids]
}

function validTaskRefs(value: string, taskIds: Set<number>, currentTaskId: number): string {
  const ids = taskFlowRefIds(value).filter((id) => id !== currentTaskId && taskIds.has(id))
  return ids.map((id) => `#${id}`).join(', ')
}

function flowRepairOutputFormat(task: Task): string {
  const name = task.name.trim()
  if (/审核|核验|验收|风险/.test(name)) {
    return 'Markdown 清单：通过项、问题项、根因、返工建议、是否可交给下游'
  }
  if (/报告|整合|汇总/.test(name)) {
    return 'Markdown 报告：结论、依据、风险、下一步、引用的上游结果'
  }
  if (/采集|情报|竞品|市场|评论|价格|数据/.test(name)) {
    return 'Markdown 表格：样本、来源、关键发现、限制、可交给下游的数据'
  }
  return '结构化 Markdown：做了什么、产生了什么结果、依据、阻塞、交给谁'
}

function repairTaskFlow(
  db: Database.Database,
  room: ReturnType<typeof queries.getRoom>,
  targetTask: Task | null,
  issue: string
): ClerkToolResult {
  if (!room) return { content: 'Error: room not found.', isError: true }
  const allTasks = queries.listTasks(db, room.id)
  const tasks = targetTask ? allTasks.filter((task) => task.id === targetTask.id) : allTasks
  if (tasks.length === 0) return { content: `帮派「${room.name}」暂无可修复镖单。` }

  const ordered = [...allTasks].sort((a, b) => {
    const orderA = parseTaskFlowSpec(a).order ?? allTasks.findIndex((task) => task.id === a.id) + 1
    const orderB = parseTaskFlowSpec(b).order ?? allTasks.findIndex((task) => task.id === b.id) + 1
    if (orderA !== orderB) return orderA - orderB
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  })
  const orderByTaskId = new Map(ordered.map((task, index) => [task.id, index + 1]))
  const taskIds = new Set(allTasks.map((task) => task.id))
  const assignableWorkers = queries.listRoomWorkers(db, room.id)
    .filter((worker) => isAssignableWorker(worker, room.queenWorkerId ?? null))
  const taskCountByWorker = new Map<number, number>()
  for (const task of allTasks) {
    if (task.workerId != null) taskCountByWorker.set(task.workerId, (taskCountByWorker.get(task.workerId) ?? 0) + 1)
  }
  const nextWorker = (): Worker | null => {
    if (assignableWorkers.length === 0) return null
    return [...assignableWorkers].sort((a, b) => (taskCountByWorker.get(a.id) ?? 0) - (taskCountByWorker.get(b.id) ?? 0))[0] ?? null
  }

  const fixed: string[] = []
  const unresolved: string[] = []
  for (const task of tasks) {
    const index = ordered.findIndex((item) => item.id === task.id)
    const previous = index > 0 ? ordered[index - 1] : null
    const next = index >= 0 && index < ordered.length - 1 ? ordered[index + 1] : null
    const spec = parseTaskFlowSpec(task)
    const patch: Parameters<typeof upsertTaskFlowDescription>[1] = {}
    const taskFixes: string[] = []

    const expectedOrder = orderByTaskId.get(task.id) ?? 1
    if (spec.order == null || spec.order < 1) {
      patch.order = expectedOrder
      taskFixes.push(`补流程序号 ${expectedOrder}`)
    }
    if (!spec.upstream) {
      patch.upstream = previous ? `镖单 #${previous.id}「${previous.name}」的交付结果` : `用户委托与帮主计划${issue ? `；用户反馈：${issue}` : ''}`
      taskFixes.push('补上游输入')
    }
    if (!spec.downstream) {
      patch.downstream = next ? `镖单 #${next.id}「${next.name}」` : '帮主验收并汇总给用户'
      taskFixes.push('补下游接收方')
    }
    if (!spec.outputFormat) {
      patch.outputFormat = flowRepairOutputFormat(task)
      taskFixes.push('补输出格式')
    }

    const validDependsOn = validTaskRefs(spec.dependsOn, taskIds, task.id)
    if (spec.dependsOn && validDependsOn !== spec.dependsOn.trim()) {
      patch.dependsOn = validDependsOn
      taskFixes.push(validDependsOn ? '清理无效依赖节点' : '移除无效依赖节点')
    }
    const validReworkTarget = validTaskRefs(spec.reworkTarget, taskIds, task.id)
    if (spec.reworkTarget && validReworkTarget !== spec.reworkTarget.trim()) {
      patch.reworkTarget = validReworkTarget
      taskFixes.push(validReworkTarget ? '清理无效返工节点' : '移除无效返工节点')
    }

    if (spec.relation !== 'sequential' && !spec.optimizationGoal && !spec.relationReason) {
      if (spec.relation === 'review') {
        patch.optimizationGoal = '提升交付质量并减少下游返工'
        patch.relationReason = '审核节点用于在结果进入下游前检查证据、格式和可用性，避免错误扩散。'
        taskFixes.push('为审核节点补业务依据')
      } else if (spec.relation === 'conditional') {
        patch.optimizationGoal = '控制风险并减少无效执行'
        patch.relationReason = '条件分支用于在不同证据状态下选择不同路径，避免所有情况都走同一套低效流程。'
        taskFixes.push('为条件分支补业务依据')
      } else if (spec.relation === 'rework') {
        patch.optimizationGoal = '减少错误扩散并提升最终可用性'
        patch.relationReason = '返工节点用于把不合格输出退回责任节点修正，避免下游继续基于错误材料工作。'
        taskFixes.push('为返工节点补业务依据')
      } else {
        patch.relation = 'sequential'
        patch.parallelGroup = ''
        patch.condition = ''
        patch.joinPolicy = ''
        patch.reworkTarget = ''
        taskFixes.push('复杂关系缺少业务依据，降为串行')
      }
    }

    const effectiveRelation = patch.relation ?? spec.relation
    if (effectiveRelation === 'conditional' && !spec.condition && patch.condition === undefined) {
      patch.condition = '上游输出出现分支条件或用户反馈要求时进入该节点'
      taskFixes.push('补条件分支触发条件')
    } else if (effectiveRelation === 'join' && !spec.joinPolicy && patch.joinPolicy === undefined) {
      patch.joinPolicy = '所有上游镖单验收通过后再汇合'
      taskFixes.push('补汇合规则')
    } else if (effectiveRelation === 'review' && !spec.condition && patch.condition === undefined) {
      patch.condition = '上游输出满足验收入口后进入审核'
      taskFixes.push('补审核入口条件')
    } else if (effectiveRelation === 'rework' && !validReworkTarget) {
      if (previous) {
        patch.reworkTarget = `#${previous.id}`
        taskFixes.push(`补返工节点 #${previous.id}`)
      } else {
        patch.relation = 'sequential'
        taskFixes.push('返工缺少可退回节点，降为串行')
      }
    }

    const worker = task.workerId != null ? queries.getWorker(db, task.workerId) : null
    const workerInvalid = task.workerId == null || !worker || worker.roomId !== room.id || !isAssignableWorker(worker, room.queenWorkerId ?? null)
    const updates: Parameters<typeof queries.updateTask>[2] = {}
    if (Object.keys(patch).length > 0) updates.description = upsertTaskFlowDescription(task, patch)
    if (workerInvalid) {
      const replacement = nextWorker()
      if (replacement) {
        updates.workerId = replacement.id
        taskCountByWorker.set(replacement.id, (taskCountByWorker.get(replacement.id) ?? 0) + 1)
        taskFixes.push(`分派给「${replacement.name}」`)
      } else {
        unresolved.push(`#${task.id}「${task.name}」缺少可分派弟子，需要先从客栈调入专职弟子。`)
      }
    }

    if (Object.keys(updates).length > 0) {
      queries.updateTask(db, task.id, updates)
      fixed.push(`#${task.id}「${task.name}」：${taskFixes.join('、')}`)
    } else if (taskFixes.length > 0) {
      fixed.push(`#${task.id}「${task.name}」：${taskFixes.join('、')}`)
    }
  }

  if (fixed.length === 0 && unresolved.length === 0) {
    return { content: `已检查帮派「${room.name}」的协作流程，暂未发现可自动修复的问题。${issue ? `用户反馈已记录：${issue}` : ''}` }
  }
  return {
    content: [
      `已处理帮派「${room.name}」的协作流程反馈${issue ? `：${issue}` : '。'}`,
      fixed.length > 0 ? `已修复：\n${fixed.join('\n')}` : '已修复：暂无自动修改项。',
      unresolved.length > 0 ? `仍需帮主处理：\n${unresolved.join('\n')}` : '仍需帮主处理：无。'
    ].join('\n')
  }
}

function normalizeRoomName(value: unknown): string {
  return String(value ?? '').trim()
}

function toSingleWordName(value: string): string {
  const trimmed = value.trim()
  if (/[\u4e00-\u9fff]/.test(trimmed)) {
    return trimmed
      .replace(/\s+/g, '')
      .replace(/[^\u4e00-\u9fffA-Za-z0-9_-]/g, '')
      .slice(0, 40)
  }
  return trimmed.toLowerCase().replace(/[^a-z0-9]+/g, '').trim()
}

function buildRoomNameFromObjective(objective: string, existingNames: Set<string>): string {
  const compact = objective.replace(/\s+/g, '')
  if (/[\u4e00-\u9fff]/.test(compact)) {
    let base = '新委托帮'
    if (/亚马逊|Amazon/i.test(compact) && /市场|分析|机会/.test(compact)) {
      base = '亚马逊市场分析帮'
    } else if (/市场/.test(compact) && /分析|调研|机会/.test(compact)) {
      base = '市场分析帮'
    } else if (/竞品|竞争/.test(compact)) {
      base = '竞品分析帮'
    } else if (/产品|新品/.test(compact) && /分析|机会|评估/.test(compact)) {
      base = '产品评估帮'
    } else {
      const cleaned = compact
        .replace(/[，。,.；;：:！!？?、]/g, '')
        .replace(/(?:注意|需要|要求|安排|弟子|分工序|分工|流程|用于|用来|为了|目标|委托|分析|完成|处理)/g, '')
        .slice(0, 10)
      if (cleaned.length >= 2) base = `${cleaned}帮`
    }
    if (!existingNames.has(base.toLowerCase())) return base
    for (let i = 2; i <= 9999; i++) {
      const candidate = `${base}${i}`
      if (!existingNames.has(candidate.toLowerCase())) return candidate
    }
    return `${base}${Date.now()}`
  }

  const tokens = objective
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .filter((token) => !['the', 'and', 'for', 'with', 'from', 'into', 'room', 'new'].includes(token))
  const rawBase = tokens[0] ?? 'room'
  const base = toSingleWordName(rawBase) || 'room'
  if (!existingNames.has(base)) return base
  for (let i = 2; i <= 9999; i++) {
    const candidate = `${base}${i}`
    if (!existingNames.has(candidate)) return candidate
  }
  return `room${Date.now()}`
}

function hasExplicitRoomSelector(args: ClerkToolArgs): boolean {
  if (args.roomId !== undefined && args.roomId !== null && String(args.roomId).trim() !== '') return true
  return typeof args.roomName === 'string' && args.roomName.trim().length > 0
}

function parseIntArg(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value, 10)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function toSqliteLocalDateTime(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hour = String(date.getHours()).padStart(2, '0')
  const minute = String(date.getMinutes()).padStart(2, '0')
  const second = String(date.getSeconds()).padStart(2, '0')
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`
}

function parseScheduledAt(value: unknown): { scheduledAt: string | null; error?: string } {
  if (value === undefined || value === null) return { scheduledAt: null }

  let timestampMs: number | null = null
  if (typeof value === 'number' && Number.isFinite(value)) {
    timestampMs = value < 1_000_000_000_000 ? value * 1000 : value
  } else if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return { scheduledAt: null }
    const parsed = Date.parse(trimmed)
    if (Number.isFinite(parsed)) timestampMs = parsed
  }

  if (timestampMs == null || !Number.isFinite(timestampMs)) {
    return { scheduledAt: null, error: 'Error: scheduledAt must be a valid datetime (for example: "2026-03-01T09:00:00-05:00").' }
  }
  return { scheduledAt: toSqliteLocalDateTime(new Date(timestampMs)) }
}

export interface ClerkToolContext {
  sendEmail?: (to: string, content: string, subject?: string) => Promise<boolean>
}

export async function executeClerkTool(
  db: Database.Database,
  toolName: string,
  args: ClerkToolArgs,
  ctx?: ClerkToolContext
): Promise<ClerkToolResult> {
  try {
    switch (toolName) {
      case 'company_list_rooms': {
        const statusRaw = String(args.status ?? '').trim()
        const status = statusRaw ? statusRaw : undefined
        const rooms = queries.listRooms(db, status)
        if (rooms.length === 0) return { content: 'No rooms found.' }
        const lines = rooms.map((room) =>
          `#${room.id} ${room.name} (${room.status}) visibility=${room.visibility} goal=${room.goal ?? '-'}`
        )
        return { content: lines.join('\n') }
      }

      case 'company_create_room': {
        const goal = String(args.goal ?? args.objective ?? '').trim()
        if (!goal) {
          return { content: 'Error: objective is required. Tell me what this room should achieve.', isError: true }
        }

        const existingRooms = queries.listRooms(db)
        const existingNames = new Set(existingRooms.map((room) => room.name.toLowerCase()))

        const requestedName = normalizeRoomName(args.name)
        const name = requestedName
          ? (toSingleWordName(requestedName) || buildRoomNameFromObjective(goal, existingNames))
          : buildRoomNameFromObjective(goal, existingNames)

        if (existingNames.has(name)) {
          return { content: `Error: room "${name}" already exists.`, isError: true }
        }

        const result = await createRoom(db, { name, goal })
        const updates: Parameters<typeof queries.updateRoom>[2] = {
          workerModel: 'queen'
        }
        if (typeof args.model === 'string' && args.model.trim()) {
          queries.updateWorker(db, result.queen.id, { model: args.model.trim() })
        }
        if (typeof args.visibility === 'string' && (args.visibility === 'private' || args.visibility === 'public')) {
          updates.visibility = args.visibility
        }
        if (args.queenCycleGapMs != null) updates.queenCycleGapMs = Math.max(1_000, Number(args.queenCycleGapMs))
        if (args.queenMaxTurns != null) updates.queenMaxTurns = Math.max(1, Math.min(50, Number(args.queenMaxTurns)))
        if (Object.keys(updates).length > 0) queries.updateRoom(db, result.room.id, updates)
        return { content: `Created room "${name}" (#${result.room.id}).` }
      }

      case 'company_update_room': {
        const room = resolveRoom(db, args)
        if (!room) return { content: 'Error: room not found.', isError: true }
        const updates: Parameters<typeof queries.updateRoom>[2] = {}
        if (args.goal !== undefined) updates.goal = String(args.goal ?? '').trim() || null
        if (typeof args.workerModel === 'string' && args.workerModel.trim()) updates.workerModel = args.workerModel.trim()
        if (typeof args.visibility === 'string' && (args.visibility === 'private' || args.visibility === 'public')) {
          updates.visibility = args.visibility
        }
        if (args.queenCycleGapMs != null) updates.queenCycleGapMs = Math.max(1_000, Number(args.queenCycleGapMs))
        if (args.queenMaxTurns != null) updates.queenMaxTurns = Math.max(1, Math.min(50, Number(args.queenMaxTurns)))
        if (args.maxConcurrentTasks != null) updates.maxConcurrentTasks = Math.max(1, Math.min(10, Number(args.maxConcurrentTasks)))
        if (args.queenQuietFrom !== undefined) {
          const from = args.queenQuietFrom === null ? null : String(args.queenQuietFrom).trim()
          updates.queenQuietFrom = from || null
        }
        if (args.queenQuietUntil !== undefined) {
          const until = args.queenQuietUntil === null ? null : String(args.queenQuietUntil).trim()
          updates.queenQuietUntil = until || null
        }
        if (Object.keys(updates).length === 0) return { content: 'No room updates provided.' }
        queries.updateRoom(db, room.id, updates)
        return { content: `Updated room "${room.name}" (#${room.id}).` }
      }

      case 'company_pause_room': {
        const room = resolveRoom(db, args)
        if (!room) return { content: 'Error: room not found.', isError: true }
        pauseRoom(db, room.id)
        stopRoomRuntime(db, room.id, 'Room paused by keeper')
        return { content: `Paused room "${room.name}" (#${room.id}).` }
      }

      case 'company_restart_room': {
        const room = resolveRoom(db, args)
        if (!room) return { content: 'Error: room not found.', isError: true }
        const goal = String(args.goal ?? '').trim() || undefined
        restartRoom(db, room.id, goal)
        return { content: `Restarted room "${room.name}" (#${room.id}).` }
      }

      case 'company_delete_room': {
        const room = resolveRoom(db, args)
        if (!room) return { content: 'Error: room not found.', isError: true }
        stopRoomRuntime(db, room.id, 'Room deleted by keeper')
        deleteRoom(db, room.id)
        return { content: `Deleted room "${room.name}" (#${room.id}).` }
      }

      case 'company_start_queen': {
        return {
          content: 'Error: direct queen start is disabled. Start the room manually from the Room controls.',
          isError: true
        }
      }

      case 'company_stop_queen': {
        const room = resolveRoom(db, args)
        if (!room) return { content: 'Error: room not found.', isError: true }
        if (!room.queenWorkerId) return { content: `Error: room "${room.name}" has no queen worker.`, isError: true }
        stopRoomRuntime(db, room.id, 'Queen stopped by keeper')
        return { content: `Stopped queen in "${room.name}" (#${room.id}).` }
      }

      case 'company_message_room': {
        const room = resolveRoom(db, args)
        if (!room) return { content: 'Error: room not found.', isError: true }
        const message = String(args.message ?? '').trim()
        if (!message) return { content: 'Error: message is required.', isError: true }
        const toAgentId = room.queenWorkerId ?? undefined
        const escalation = queries.createEscalation(db, room.id, null, message, toAgentId)
        if (room.status === 'active' && room.queenWorkerId) {
          try { triggerAgent(db, room.id, room.queenWorkerId) } catch { /* non-fatal */ }
        }
        return { content: `Sent keeper message to "${room.name}" (#${room.id}) as escalation #${escalation.id}.` }
      }

      case 'company_list_keeper_requests': {
        const selectorArgs: ClerkToolArgs = { roomId: args.roomId, roomName: args.roomName }
        const selectedRoom = resolveRoom(db, selectorArgs)
        if (hasExplicitRoomSelector(args) && !selectedRoom) return { content: 'Error: room not found.', isError: true }

        const limitRaw = parseIntArg(args.limit)
        const limit = limitRaw != null ? Math.max(1, Math.min(200, limitRaw)) : 25
        const rooms = selectedRoom ? [selectedRoom] : queries.listRooms(db)
        const lines: string[] = []

        for (const room of rooms) {
          const pendingEscalations = queries
            .getPendingEscalations(db, room.id)
            .filter((item) => item.toAgentId == null)
          for (const escalation of pendingEscalations) {
            const fromName = escalation.fromAgentId
              ? (queries.getWorker(db, escalation.fromAgentId)?.name ?? `worker #${escalation.fromAgentId}`)
              : 'agent'
            lines.push(`[Escalation] room="${room.name}" id=${escalation.id} from=${fromName} question="${escalation.question.replace(/\s+/g, ' ').trim()}"`)
            if (lines.length >= limit) break
          }
          if (lines.length >= limit) break

          const voteNeeded = queries
            .listDecisions(db, room.id, 'voting')
            .filter((decision) => !decision.keeperVote)
          for (const decision of voteNeeded) {
            lines.push(`[Vote] room="${room.name}" decisionId=${decision.id} proposal="${decision.proposal.replace(/\s+/g, ' ').trim()}"`)
            if (lines.length >= limit) break
          }
          if (lines.length >= limit) break

          const unreadInbound = queries
            .listRoomMessages(db, room.id, 'unread')
            .filter((message) => message.direction === 'inbound')
          for (const message of unreadInbound) {
            lines.push(`[RoomMessage] room="${room.name}" messageId=${message.id} from=${message.fromRoomId ?? 'unknown'} subject="${message.subject.replace(/\s+/g, ' ').trim()}"`)
            if (lines.length >= limit) break
          }
          if (lines.length >= limit) break
        }

        if (lines.length === 0) return { content: 'No pending keeper requests.' }
        return { content: lines.join('\n') }
      }

      case 'company_resolve_escalation': {
        const escalationId = parseIntArg(args.escalationId)
        if (escalationId == null) return { content: 'Error: escalationId is required.', isError: true }
        const answer = String(args.answer ?? '').trim()
        if (!answer) return { content: 'Error: answer is required.', isError: true }

        const escalation = queries.getEscalation(db, escalationId)
        if (!escalation) return { content: `Error: escalation #${escalationId} not found.`, isError: true }
        if (escalation.status !== 'pending') {
          return { content: `Escalation #${escalationId} is already ${escalation.status}.` }
        }

        queries.resolveEscalation(db, escalationId, answer)
        const room = queries.getRoom(db, escalation.roomId)
        if (room?.status === 'active' && room.queenWorkerId) {
          try { triggerAgent(db, room.id, room.queenWorkerId) } catch { /* non-fatal */ }
        }
        return { content: `Resolved escalation #${escalationId} in room "${room?.name ?? escalation.roomId}".` }
      }

      case 'company_keeper_vote': {
        const decisionId = parseIntArg(args.decisionId)
        if (decisionId == null) return { content: 'Error: decisionId is required.', isError: true }
        const voteRaw = String(args.vote ?? '').trim().toLowerCase()
        if (voteRaw !== 'yes' && voteRaw !== 'no' && voteRaw !== 'abstain') {
          return { content: 'Error: vote must be yes, no, or abstain.', isError: true }
        }

        const updated = keeperVote(db, decisionId, voteRaw as VoteValue)
        return { content: `Keeper vote "${voteRaw}" cast on decision #${decisionId} (${updated.status}).` }
      }

      case 'company_reply_room_message': {
        const messageId = parseIntArg(args.messageId)
        if (messageId == null) return { content: 'Error: messageId is required.', isError: true }
        const body = String(args.body ?? '').trim()
        if (!body) return { content: 'Error: body is required.', isError: true }

        const original = queries.getRoomMessage(db, messageId)
        if (!original) return { content: `Error: room message #${messageId} not found.`, isError: true }
        const toRoomId = String(args.toRoomId ?? '').trim() || original.fromRoomId
        if (!toRoomId) return { content: 'Error: cannot determine recipient room id. Provide toRoomId.', isError: true }

        const subject = String(args.subject ?? '').trim() || `Re: ${original.subject}`
        queries.replyToRoomMessage(db, messageId)
        const reply = queries.createRoomMessage(
          db,
          original.roomId,
          'outbound',
          subject,
          body,
          { toRoomId }
        )
        return { content: `Queued reply as room message #${reply.id} to ${toRoomId}.` }
      }

      case 'company_message_other_room': {
        const sourceRoom = resolveFromRoom(db, args)
        if (!sourceRoom) return { content: 'Error: no source room available.', isError: true }

        const body = String(args.body ?? '').trim()
        if (!body) return { content: 'Error: body is required.', isError: true }
        const subject = String(args.subject ?? 'Message from Keeper').trim() || 'Message from Keeper'

        let targetRoomId = String(args.toRoomId ?? '').trim()
        if (!targetRoomId) {
          const targetByName = String(args.toRoomName ?? '').trim().toLowerCase()
          if (!targetByName) {
            return { content: 'Error: toRoomId or toRoomName is required.', isError: true }
          }
          const localTarget = queries.listRooms(db).find((room) => room.name.toLowerCase() === targetByName)
          if (!localTarget) return { content: `Error: target room "${targetByName}" not found.`, isError: true }
          targetRoomId = getRoomCloudId(localTarget.id)
        }

        const message = queries.createRoomMessage(
          db,
          sourceRoom.id,
          'outbound',
          subject,
          body,
          { toRoomId: targetRoomId }
        )
        return {
          content: `Queued inter-room message #${message.id} from "${sourceRoom.name}" (#${sourceRoom.id}) to ${targetRoomId}.`
        }
      }

      case 'company_list_tasks': {
        const selectorArgs: ClerkToolArgs = { roomId: args.roomId, roomName: args.roomName }
        const room = resolveRoom(db, selectorArgs)
        if (hasExplicitRoomSelector(args) && !room) return { content: 'Error: room not found.', isError: true }

        const statusRaw = String(args.status ?? '').trim()
        const status = statusRaw || undefined
        const limitRaw = parseIntArg(args.limit)
        const limit = limitRaw != null ? Math.max(1, Math.min(100, limitRaw)) : 20

        const tasks = queries.listTasks(db, room?.id, status).slice(0, limit)
        if (tasks.length === 0) return { content: 'No tasks found.' }

        const lines = tasks.map((task) => {
          const roomLabel = task.roomId != null
            ? (queries.getRoom(db, task.roomId)?.name ?? `#${task.roomId}`)
            : 'global'
          const schedule = task.triggerType === 'cron'
            ? `cron=${task.cronExpression ?? '-'}`
            : task.triggerType === 'once'
              ? `at=${task.scheduledAt ?? '-'}`
              : 'manual'
          return `#${task.id} ${task.name} (${task.status}) ${schedule} executor=${task.executor} room=${roomLabel}`
        })
        return { content: lines.join('\n') }
      }

      case 'company_create_task': {
        const name = String(args.name ?? '').trim()
        const prompt = String(args.prompt ?? '').trim()
        if (!name) return { content: 'Error: name is required.', isError: true }
        if (!prompt) return { content: 'Error: prompt is required.', isError: true }

        const cronExpression = String(args.cronExpression ?? '').trim() || undefined
        const parsedScheduled = parseScheduledAt(args.scheduledAt)
        if (parsedScheduled.error) return { content: parsedScheduled.error, isError: true }
        const scheduledAt = parsedScheduled.scheduledAt || undefined
        if (cronExpression && scheduledAt) {
          return { content: 'Error: provide either cronExpression or scheduledAt, not both.', isError: true }
        }
        const triggerType: 'cron' | 'once' | 'manual' = cronExpression ? 'cron' : scheduledAt ? 'once' : 'manual'

        const selectorArgs: ClerkToolArgs = { roomId: args.roomId, roomName: args.roomName }
        const room = resolveRoom(db, selectorArgs)
        if (hasExplicitRoomSelector(args) && !room) return { content: 'Error: room not found.', isError: true }

        const workerId = parseIntArg(args.workerId)
        if (args.workerId !== undefined && workerId == null) {
          return { content: 'Error: workerId must be a valid integer.', isError: true }
        }
        if (workerId != null) {
          const worker = queries.getWorker(db, workerId)
          if (!worker) return { content: `Error: worker #${workerId} not found.`, isError: true }
          if (room && worker.roomId !== room.id) {
            return { content: `Error: worker #${workerId} does not belong to room "${room.name}".`, isError: true }
          }
        }

        let maxTurns: number | undefined
        if (args.maxTurns !== undefined) {
          const parsed = Number(args.maxTurns)
          if (!Number.isFinite(parsed) || parsed < 1) {
            return { content: 'Error: maxTurns must be a positive number.', isError: true }
          }
          maxTurns = Math.trunc(parsed)
        }

        let timeoutMinutes: number | undefined
        if (args.timeoutMinutes !== undefined) {
          const parsed = Number(args.timeoutMinutes)
          if (!Number.isFinite(parsed) || parsed < 1) {
            return { content: 'Error: timeoutMinutes must be a positive number.', isError: true }
          }
          timeoutMinutes = Math.trunc(parsed)
        }

        const description = String(args.description ?? '').trim() || undefined
        const task = queries.createTask(db, {
          name,
          prompt,
          description,
          triggerType,
          cronExpression,
          scheduledAt,
          workerId: workerId ?? undefined,
          maxTurns,
          timeoutMinutes,
          roomId: room?.id ?? undefined,
          executor: 'claude_code',
          triggerConfig: JSON.stringify({ source: 'clerk' })
        })

        const scheduleLabel = triggerType === 'cron'
          ? `cron ${cronExpression}`
          : triggerType === 'once'
            ? `at ${scheduledAt}`
            : 'manual'
        return { content: `Created task "${task.name}" (#${task.id}, ${scheduleLabel}).` }
      }

      case 'company_update_task_flow': {
        const selectorArgs: ClerkToolArgs = { roomId: args.roomId, roomName: args.roomName }
        const room = resolveRoom(db, selectorArgs)
        if (hasExplicitRoomSelector(args) && !room) return { content: 'Error: room not found.', isError: true }

        const resolved = resolveTaskForFlow(db, args, room)
        if (!resolved.task) return { content: `Error: ${resolved.error ?? 'task not found.'}`, isError: true }
        const task = resolved.task

        const patch: Parameters<typeof upsertTaskFlowDescription>[1] = {}
        if (args.order !== undefined) {
          const parsedOrder = parseIntArg(args.order)
          if (parsedOrder == null || parsedOrder < 1) {
            return { content: 'Error: order must be a positive integer.', isError: true }
          }
          patch.order = parsedOrder
        }
        if (args.relation !== undefined) patch.relation = String(args.relation ?? '').trim() as TaskFlowRelation
        if (args.dependsOn !== undefined) patch.dependsOn = String(args.dependsOn ?? '').trim()
        if (args.parallelGroup !== undefined) patch.parallelGroup = String(args.parallelGroup ?? '').trim()
        if (args.optimizationGoal !== undefined) patch.optimizationGoal = String(args.optimizationGoal ?? '').trim()
        if (args.relationReason !== undefined) patch.relationReason = String(args.relationReason ?? '').trim()
        if (args.condition !== undefined) patch.condition = String(args.condition ?? '').trim()
        if (args.joinPolicy !== undefined) patch.joinPolicy = String(args.joinPolicy ?? '').trim()
        if (args.reworkTarget !== undefined) patch.reworkTarget = String(args.reworkTarget ?? '').trim()
        if (args.upstream !== undefined) patch.upstream = String(args.upstream ?? '').trim()
        if (args.downstream !== undefined) patch.downstream = String(args.downstream ?? '').trim()
        if (args.outputFormat !== undefined) patch.outputFormat = String(args.outputFormat ?? '').trim()

        const workerResult = resolveAssignableWorkerForTask(db, task, args)
        if (workerResult.error) return { content: `Error: ${workerResult.error}`, isError: true }

        const updates: Parameters<typeof queries.updateTask>[2] = {}
        if (Object.keys(patch).length > 0) {
          updates.description = upsertTaskFlowDescription(task, patch)
        }
        if (workerResult.workerId !== undefined) {
          updates.workerId = workerResult.workerId
        }
        if (Object.keys(updates).length === 0) {
          return { content: '没有收到需要调整的流程字段。' }
        }

        queries.updateTask(db, task.id, updates)
        const updated = queries.getTask(db, task.id) ?? { ...task, ...updates }
        const spec = parseTaskFlowSpec(updated)
        const workerLabel = updated.workerId != null
          ? (queries.getWorker(db, updated.workerId)?.name ?? `#${updated.workerId}`)
          : '未分派'
        return {
          content: [
            `已调整镖单「${updated.name}」的弟子协作流程。`,
            `顺序：${spec.order ?? '未设置'}；关系：${taskFlowRelationLabel(spec.relation)}；弟子：${workerLabel}；优化目标：${spec.optimizationGoal || '未设置'}；关系依据：${spec.relationReason || '未设置'}；依赖：${spec.dependsOn || '未设置'}；并行组：${spec.parallelGroup || '未设置'}；条件：${spec.condition || '未设置'}；汇合：${spec.joinPolicy || '未设置'}；返工：${spec.reworkTarget || '未设置'}；上游：${spec.upstream || '未设置'}；下游：${spec.downstream || '未设置'}；输出格式：${spec.outputFormat || '未设置'}。`
          ].join('\n')
        }
      }

      case 'company_repair_task_flow': {
        const issue = String(args.issue ?? args.feedback ?? args.problem ?? '').trim()
        const selectorArgs: ClerkToolArgs = { roomId: args.roomId, roomName: args.roomName }
        let room = resolveRoom(db, selectorArgs)
        if (hasExplicitRoomSelector(args) && !room) return { content: 'Error: room not found.', isError: true }

        let targetTask: Task | null = null
        const hasTaskSelector = args.taskId !== undefined || args.id !== undefined || typeof args.taskName === 'string' || typeof args.name === 'string'
        if (hasTaskSelector) {
          const resolved = resolveTaskForFlow(db, args, room)
          if (!resolved.task) return { content: `Error: ${resolved.error ?? 'task not found.'}`, isError: true }
          targetTask = resolved.task
          if (!room && targetTask.roomId != null) room = queries.getRoom(db, targetTask.roomId)
        }

        if (!room) {
          const activeRooms = queries.listRooms(db).filter(candidate => candidate.status === 'active')
          room = activeRooms[0] ?? queries.listRooms(db)[0] ?? null
        }

        return repairTaskFlow(db, room, targetTask, issue)
      }

      case 'company_remind_keeper': {
        const message = String(args.message ?? '').trim()
        if (!message) return { content: 'Error: message is required.', isError: true }

        const parsedScheduled = parseScheduledAt(args.scheduledAt)
        if (parsedScheduled.error) return { content: parsedScheduled.error, isError: true }
        const scheduledAt = parsedScheduled.scheduledAt
        if (!scheduledAt) return { content: 'Error: scheduledAt is required.', isError: true }

        const selectorArgs: ClerkToolArgs = { roomId: args.roomId, roomName: args.roomName }
        const room = resolveRoom(db, selectorArgs)
        if (hasExplicitRoomSelector(args) && !room) return { content: 'Error: room not found.', isError: true }

        const customName = String(args.name ?? '').trim()
        const fallback = message.length > 48 ? `${message.slice(0, 48)}...` : message
        const name = customName || `Reminder: ${fallback}`

        const task = queries.createTask(db, {
          name,
          prompt: message,
          description: 'Keeper reminder scheduled by Clerk',
          triggerType: 'once',
          scheduledAt,
          roomId: room?.id ?? undefined,
          executor: 'keeper_reminder',
          maxRuns: 1,
          triggerConfig: JSON.stringify({ source: 'clerk', kind: 'keeper_reminder' })
        })
        const roomNote = room ? ` for room "${room.name}"` : ''
        return { content: `Scheduled keeper reminder #${task.id}${roomNote} at ${scheduledAt}.` }
      }

      case 'company_send_email': {
        const to = String(args.to ?? '').trim()
        if (!to) return { content: 'Error: to is required.', isError: true }
        const body = String(args.body ?? '').trim()
        if (!body) return { content: 'Error: body is required.', isError: true }
        if (!ctx?.sendEmail) return { content: 'Error: email sending is not available in this context.', isError: true }
        const subject = String(args.subject ?? '').trim() || undefined
        const sent = await ctx.sendEmail(to, body, subject)
        if (!sent) return { content: 'Failed to send email. Cloud relay unavailable or no rooms connected.', isError: true }
        return { content: `Email sent to ${to}.` }
      }

      case 'company_get_setting': {
        const key = String(args.key ?? '').trim()
        if (!key) return { content: 'Error: key is required.', isError: true }
        const value = queries.getSetting(db, key)
        return { content: `${key}=${value ?? ''}` }
      }

      case 'company_set_setting': {
        const key = String(args.key ?? '').trim()
        if (!key) return { content: 'Error: key is required.', isError: true }
        const value = String(args.value ?? '')
        queries.setSetting(db, key, value)
        return { content: `Setting "${key}" updated.` }
      }

      default:
        return { content: `Unknown tool: ${toolName}`, isError: true }
    }
  } catch (err) {
    return { content: err instanceof Error ? err.message : String(err), isError: true }
  }
}
