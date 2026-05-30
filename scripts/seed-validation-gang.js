#!/usr/bin/env node

const { existsSync } = require('fs')
const { homedir } = require('os')
const { join } = require('path')
const Database = require('better-sqlite3')

const ROOM_NAME = '功能验证复杂协作帮'
const DB_DIR = '.company-local-dev'

function expandTilde(path) {
  if (path === '~' || path.startsWith('~/')) return path.replace('~', homedir())
  return path
}

function normalizePath(path) {
  return expandTilde(path).replace(/\\/g, '/')
}

function resolveDbPath() {
  if (process.env.COMPANY_DB_PATH) return normalizePath(process.env.COMPANY_DB_PATH)
  const dataDir = normalizePath(process.env.COMPANY_DATA_DIR || join(process.cwd(), DB_DIR))
  return join(dataDir, 'data.db')
}

function minutesAgo(minutes) {
  return new Date(Date.now() - minutes * 60_000).toISOString()
}

function minutesFromNow(minutes) {
  return new Date(Date.now() + minutes * 60_000).toISOString()
}

function json(value) {
  return JSON.stringify(value, null, 2)
}

function tableExists(db, name) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name)
  return Boolean(row)
}

function ensureTrainingAdjustments(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS training_adjustments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      escalation_id INTEGER NOT NULL REFERENCES escalations(id) ON DELETE CASCADE,
      worker_id INTEGER REFERENCES workers(id) ON DELETE SET NULL,
      status TEXT NOT NULL,
      progress INTEGER NOT NULL DEFAULT 0,
      note TEXT,
      config_json TEXT,
      created_at DATETIME DEFAULT (datetime('now','localtime')),
      updated_at DATETIME DEFAULT (datetime('now','localtime')),
      UNIQUE(escalation_id)
    );
    CREATE INDEX IF NOT EXISTS idx_training_adjustments_room ON training_adjustments(room_id);
    CREATE INDEX IF NOT EXISTS idx_training_adjustments_escalation ON training_adjustments(escalation_id);
  `)
  const cols = db.pragma('table_info(training_adjustments)').map((col) => col.name)
  if (!cols.includes('config_json')) {
    db.exec('ALTER TABLE training_adjustments ADD COLUMN config_json TEXT')
  }
}

function ensureValidationSchema(db) {
  ensureTrainingAdjustments(db)

  const goalCols = db.pragma('table_info(goals)').map((col) => col.name)
  if (!goalCols.includes('assigned_worker_id')) {
    db.exec('ALTER TABLE goals ADD COLUMN assigned_worker_id INTEGER REFERENCES workers(id) ON DELETE SET NULL')
  }
  if (!goalCols.includes('expected_completed_at')) {
    db.exec('ALTER TABLE goals ADD COLUMN expected_completed_at DATETIME')
  }
  if (!goalCols.includes('progress')) {
    db.exec('ALTER TABLE goals ADD COLUMN progress REAL NOT NULL DEFAULT 0.0')
  }
}

function safeRun(db, sql, params = []) {
  try {
    db.prepare(sql).run(...params)
  } catch (error) {
    if (!/no such table/i.test(String(error?.message || error))) throw error
  }
}

function deleteValidationRoom(db) {
  const rows = db.prepare('SELECT id FROM rooms WHERE name = ?').all(ROOM_NAME)
  for (const row of rows) {
    const roomId = row.id
    db.prepare('UPDATE rooms SET queen_worker_id = NULL WHERE id = ?').run(roomId)

    safeRun(db, 'DELETE FROM cycle_logs WHERE cycle_id IN (SELECT id FROM worker_cycles WHERE room_id = ?)', [roomId])
    safeRun(db, 'DELETE FROM worker_cycles WHERE room_id = ?', [roomId])
    safeRun(db, 'DELETE FROM console_logs WHERE run_id IN (SELECT id FROM task_runs WHERE task_id IN (SELECT id FROM tasks WHERE room_id = ?))', [roomId])
    safeRun(db, 'DELETE FROM task_runs WHERE task_id IN (SELECT id FROM tasks WHERE room_id = ?)', [roomId])
    safeRun(db, 'DELETE FROM tasks WHERE room_id = ?', [roomId])
    safeRun(db, 'DELETE FROM goal_updates WHERE goal_id IN (SELECT id FROM goals WHERE room_id = ?)', [roomId])
    safeRun(db, 'DELETE FROM goals WHERE room_id = ?', [roomId])
    safeRun(db, 'DELETE FROM quorum_votes WHERE decision_id IN (SELECT id FROM quorum_decisions WHERE room_id = ?)', [roomId])
    safeRun(db, 'DELETE FROM quorum_decisions WHERE room_id = ?', [roomId])
    safeRun(db, 'DELETE FROM wallet_transactions WHERE wallet_id IN (SELECT id FROM wallets WHERE room_id = ?)', [roomId])
    safeRun(db, 'DELETE FROM wallets WHERE room_id = ?', [roomId])
    safeRun(db, 'DELETE FROM room_messages WHERE room_id = ?', [roomId])
    safeRun(db, 'DELETE FROM skills WHERE room_id = ?', [roomId])
    safeRun(db, 'DELETE FROM training_adjustments WHERE room_id = ?', [roomId])
    safeRun(db, 'DELETE FROM escalations WHERE room_id = ?', [roomId])
    safeRun(db, 'DELETE FROM room_activity WHERE room_id = ?', [roomId])
    safeRun(db, 'DELETE FROM chat_messages WHERE room_id = ?', [roomId])
    safeRun(db, 'DELETE FROM relations WHERE from_entity IN (SELECT id FROM entities WHERE room_id = ?) OR to_entity IN (SELECT id FROM entities WHERE room_id = ?)', [roomId, roomId])
    safeRun(db, 'DELETE FROM observations WHERE entity_id IN (SELECT id FROM entities WHERE room_id = ?)', [roomId])
    safeRun(db, 'DELETE FROM embeddings WHERE entity_id IN (SELECT id FROM entities WHERE room_id = ?)', [roomId])
    safeRun(db, 'DELETE FROM entities WHERE room_id = ?', [roomId])
    safeRun(db, 'DELETE FROM agent_sessions WHERE worker_id IN (SELECT id FROM workers WHERE room_id = ?)', [roomId])
    db.prepare('DELETE FROM workers WHERE room_id = ?').run(roomId)
    db.prepare('DELETE FROM rooms WHERE id = ?').run(roomId)
  }
}

function insertWorker(db, roomId, input) {
  const result = db.prepare(`
    INSERT INTO workers
      (name, role, system_prompt, description, model, is_default, task_count, cycle_gap_ms, max_turns, room_id, agent_state, wip, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.name,
    input.role,
    input.systemPrompt,
    input.description,
    input.model || 'codex',
    input.isDefault ? 1 : 0,
    input.taskCount || 0,
    input.cycleGapMs || 600000,
    input.maxTurns || 6,
    roomId,
    input.agentState || 'idle',
    input.wip || null,
    input.createdAt || minutesAgo(40),
    input.updatedAt || minutesAgo(5)
  )
  return Number(result.lastInsertRowid)
}

function makeWorkerPrompt(role, mission, output) {
  return [
    `你是「${role}」。`,
    `使命：${mission}`,
    '工作规则：只执行帮主分派的镖单；开始前核对上游输入、下游接收方、输出格式、验收标准和禁止偏移事项。',
    '遇到缺资料、预算不足、格式冲突或目标漂移时，先向帮主说明根因，不要自行扩展目标。',
    `输出格式：${output}`,
  ].join('\n')
}

function insertGoal(db, roomId, input) {
  const result = db.prepare(`
    INSERT INTO goals
      (room_id, description, status, parent_goal_id, assigned_worker_id, expected_completed_at, progress, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    roomId,
    input.description,
    input.status || 'active',
    input.parentGoalId || null,
    input.assignedWorkerId || null,
    input.expectedCompletedAt || null,
    input.progress ?? 0,
    input.createdAt || minutesAgo(30),
    input.updatedAt || minutesAgo(3)
  )
  return Number(result.lastInsertRowid)
}

function insertTask(db, roomId, input) {
  const now = input.updatedAt || minutesAgo(2)
  const result = db.prepare(`
    INSERT INTO tasks
      (name, description, prompt, trigger_type, trigger_config, executor, status, last_run, last_result, error_count,
       scheduled_at, max_runs, run_count, worker_id, timeout_minutes, max_turns, allowed_tools, disallowed_tools,
       learned_context, room_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.name,
    input.description,
    input.prompt,
    input.triggerType || 'manual',
    input.triggerConfig || null,
    input.executor || 'codex',
    input.status || 'active',
    input.lastRun || null,
    input.lastResult || null,
    input.errorCount || 0,
    input.scheduledAt || null,
    input.maxRuns || null,
    input.runCount || 0,
    input.workerId || null,
    input.timeoutMinutes || 30,
    input.maxTurns || 4,
    input.allowedTools || null,
    input.disallowedTools || null,
    input.learnedContext || null,
    roomId,
    input.createdAt || minutesAgo(26),
    now
  )
  return Number(result.lastInsertRowid)
}

function insertTaskRun(db, input) {
  const result = db.prepare(`
    INSERT INTO task_runs
      (task_id, started_at, finished_at, status, result, result_file, error_message, duration_ms, progress, progress_message, session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.taskId,
    input.startedAt || minutesAgo(10),
    input.finishedAt || null,
    input.status || 'running',
    input.result || null,
    input.resultFile || null,
    input.errorMessage || null,
    input.durationMs || null,
    input.progress ?? null,
    input.progressMessage || null,
    input.sessionId || null
  )
  return Number(result.lastInsertRowid)
}

function insertCycle(db, roomId, input) {
  const result = db.prepare(`
    INSERT INTO worker_cycles
      (worker_id, room_id, model, started_at, finished_at, status, error_message, duration_ms, input_tokens, output_tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.workerId,
    roomId,
    input.model || 'codex',
    input.startedAt || minutesAgo(8),
    input.finishedAt || null,
    input.status || 'completed',
    input.errorMessage || null,
    input.durationMs || null,
    input.inputTokens || 0,
    input.outputTokens || 0
  )
  const cycleId = Number(result.lastInsertRowid)
  for (const [index, line] of (input.logs || []).entries()) {
    db.prepare(`
      INSERT INTO cycle_logs (cycle_id, seq, entry_type, content, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(cycleId, index + 1, line.type || 'info', line.content, line.createdAt || input.startedAt || minutesAgo(8))
  }
  return cycleId
}

function insertActivity(db, roomId, input) {
  db.prepare(`
    INSERT INTO room_activity (room_id, event_type, actor_id, summary, details, is_public, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    roomId,
    input.eventType,
    input.actorId || null,
    input.summary,
    input.details || null,
    input.isPublic === false ? 0 : 1,
    input.createdAt || minutesAgo(5)
  )
}

function createTrainingConfig(workerName, roleName, outputFormat) {
  return {
    schema: 'jianghu.training.worker.v1',
    updatedAt: new Date().toISOString(),
    roleDefinition: {
      roleName,
      mission: `${workerName} 在功能验证帮派中负责稳定产出可复用结果。`,
      responsibilities: [
        '先确认上游输入是否充足',
        '按帮主指定的输出格式交付',
        '发现目标偏移或阻塞时立即向帮主汇报',
      ],
      inputRequirements: [
        '用户委托和需求文档',
        '上游弟子的结构化结果',
        '帮主给出的验收标准',
      ],
      outputFormat,
      acceptanceCriteria: [
        '结论可以追溯到证据或上游输入',
        '字段能被下游弟子直接复用',
        '不把建议当成已完成结果',
      ],
      collaborationRules: [
        '只走任务树规定的上下游路径',
        '不直接向钱庄申请预算',
        '不绕过帮主修改目标',
      ],
    },
    toolCalling: {
      allowedTools: ['company_recall', 'company_save_memory', 'company_send_message'],
      disallowedTools: ['高风险外部写入', '未批准批量删除'],
      approvalRequiredTools: ['外部搜索', '高成本模型调用', '跨帮派传递资料'],
      callingRules: [
        '调用工具前说明目的和预期产物',
        '工具失败时记录失败原因并给出本地替代路径',
        '交付前保存关键结果和下游字段',
      ],
    },
  }
}

function createValidationGang(db) {
  ensureValidationSchema(db)
  deleteValidationRoom(db)

  db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES ('advanced_mode', 'true', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(new Date().toISOString())

  const roomResult = db.prepare(`
    INSERT INTO rooms
      (name, goal, status, visibility, autonomy_mode, max_concurrent_tasks, worker_model, queen_cycle_gap_ms,
       queen_max_turns, queen_nickname, allowed_tools, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    ROOM_NAME,
    '验证江湖系统能否围绕一个复杂委托完成目标澄清、任务拆解、弟子协作、预算流转、训练沉淀、风险审计、会议决策和结果复盘。',
    'active',
    'private',
    'semi',
    4,
    'codex',
    300000,
    8,
    '功能验收帮主',
    json(['company_recall', 'company_save_memory', 'company_send_message', 'company_assign_task', 'company_update_task']),
    minutesAgo(38),
    minutesAgo(1)
  )
  const roomId = Number(roomResult.lastInsertRowid)

  const leaderId = insertWorker(db, roomId, {
    name: '功能验收帮主',
    role: '帮主',
    description: '负责验证复杂帮派从委托到交付的完整运行链路。',
    systemPrompt: [
      '你是功能验证复杂协作帮的帮主。',
      '固定工作顺序：分析目标 → 制定计划 → 从客栈挑弟子 → 分派带上下游和输出格式的镖单 → 最小试运行 → 监督纠偏 → 继续执行 → 验收交付 → 复盘沉淀。',
      '你必须说明每个弟子的上游输入、下游接收方、输出格式限制、验收标准和预计完成时间。',
      '你不能把测试动作伪装成真实完成；没有结果时要明确说明缺口。',
    ].join('\n'),
    agentState: 'thinking',
    wip: '正在核对功能验证清单与弟子协作流程。',
    isDefault: true,
    taskCount: 8,
    cycleGapMs: 300000,
    maxTurns: 8,
  })
  db.prepare('UPDATE rooms SET queen_worker_id = ? WHERE id = ?').run(leaderId, roomId)

  const workerIds = {
    clarifier: insertWorker(db, roomId, {
      name: '需求澄清弟子',
      role: '需求澄清',
      description: '把用户委托整理成需求文档、验收标准和边界。',
      systemPrompt: makeWorkerPrompt('需求澄清弟子', '先把模糊委托澄清成可验收需求文档。', 'Markdown，包含背景、目标、交付物、验收标准、风险问题。'),
      agentState: 'idle',
      wip: '已完成需求文档 v1，等待帮主复核。',
      taskCount: 1,
    }),
    flow: insertWorker(db, roomId, {
      name: '流程设计弟子',
      role: '协作流程',
      description: '设计弟子协作流程、上下游交接和工序顺序。',
      systemPrompt: makeWorkerPrompt('流程设计弟子', '把复杂委托拆成可执行工序，并维护协作流程。', '流程节点清单，必须含上游、下游、输出格式、验收标准。'),
      agentState: 'acting',
      wip: '正在调整协作流程节点与交接限制。',
      taskCount: 2,
    }),
    market: insertWorker(db, roomId, {
      name: '情报采集弟子',
      role: '情报采集',
      description: '负责公开信息、样本和证据的采集与摘要。',
      systemPrompt: makeWorkerPrompt('情报采集弟子', '收集验证所需的外部或本地证据，并给下游可引用字段。', '证据表，包含来源、样本、判断、可复用字段。'),
      agentState: 'acting',
      wip: '正在整理可复用样例和验证入口。',
      taskCount: 1,
    }),
    data: insertWorker(db, roomId, {
      name: '数据整理弟子',
      role: '数据整理',
      description: '清洗上游结果，形成稳定字段给下游使用。',
      systemPrompt: makeWorkerPrompt('数据整理弟子', '把上游输出转成下游可读的结构化表格。', 'Markdown 表格，字段稳定，不省略空值原因。'),
      agentState: 'idle',
      wip: '等待情报采集弟子交付样本。',
      taskCount: 1,
    }),
    budget: insertWorker(db, roomId, {
      name: '钱庄核算弟子',
      role: '预算核算',
      description: '记录铜钱、银两、金票的拨付、消耗、结余和效率积分。',
      systemPrompt: makeWorkerPrompt('钱庄核算弟子', '核对预算流转和结余激励，不处理真实世界资金。', '预算流水表，包含拨付、消耗、结余、效率积分和超支判断。'),
      agentState: 'idle',
      wip: '已核对初始预算和两笔消耗记录。',
      taskCount: 1,
    }),
    guard: insertWorker(db, roomId, {
      name: '锦衣卫巡查弟子',
      role: '风险巡查',
      description: '检查刷声望、预算滥用、目标漂移、上下游绕行和输出空洞。',
      systemPrompt: makeWorkerPrompt('锦衣卫巡查弟子', '监控风险并给帮主黄色预警、看守或囚禁建议。', '风险清单，按等级写明证据、影响、建议处置。'),
      agentState: 'voting',
      wip: '正在复核训练营手动调整是否越权。',
      taskCount: 1,
    }),
    trainer: insertWorker(db, roomId, {
      name: '训练观察弟子',
      role: '弟子训练',
      description: '观察训练任务是否被吸收，并将配置转成可读档案。',
      systemPrompt: makeWorkerPrompt('训练观察弟子', '跟踪弟子训练、手动调整配置和后续验证。', '训练记录，包含状态、配置变化、吸收证据、下一次验证点。'),
      agentState: 'thinking',
      wip: '正在检查训练营配置是否同步进弟子设定。',
      taskCount: 1,
    }),
    report: insertWorker(db, roomId, {
      name: '报告整合弟子',
      role: '报告整合',
      description: '整合所有子任务结果，形成最终交付和复盘。',
      systemPrompt: makeWorkerPrompt('报告整合弟子', '把各弟子产出汇总成用户能判断是否完成的结果。', '最终报告，包含结论、依据、未完成项、风险、下一步。'),
      agentState: 'blocked',
      wip: '等待流程设计弟子补齐下游字段后继续整合。',
      taskCount: 1,
    }),
  }

  const rootGoalId = insertGoal(db, roomId, {
    description: [
      '任务：验证复杂帮派是否能覆盖江湖核心功能',
      '验收标准：用户能在帮主管理处看到父子目标、协作流程、甘特心跳、训练营、钱庄、藏经阁、议事和龙门镖局消息。',
      '输出格式：功能验证报告 + 可复用流程模板 + 风险清单。',
      '交付结果：当前已生成验证帮派和首轮数据，等待用户查看并反馈修正。',
    ].join('\n'),
    status: 'in_progress',
    assignedWorkerId: leaderId,
    expectedCompletedAt: minutesFromNow(45),
    progress: 0.64,
  })
  const goalInputsId = insertGoal(db, roomId, {
    description: [
      '任务：完成需求澄清与验收边界',
      '验收标准：需求文档列出目标、边界、交付物、验收方式和风险。',
      '输出格式：Markdown 需求文档。',
      '交付结果：已形成 12 项功能验证清单。',
    ].join('\n'),
    status: 'completed',
    parentGoalId: rootGoalId,
    assignedWorkerId: workerIds.clarifier,
    expectedCompletedAt: minutesAgo(10),
    progress: 1,
  })
  const goalFlowId = insertGoal(db, roomId, {
    description: [
      '任务：搭建弟子协作流程和上下游交接',
      '验收标准：每张镖单都有负责人、上游、下游、输出格式和验收标准。',
      '输出格式：可点击节点的协作流程图。',
      '交付结果：流程图已生成，仍需用户检查节点细节是否易读。',
    ].join('\n'),
    status: 'in_progress',
    parentGoalId: rootGoalId,
    assignedWorkerId: workerIds.flow,
    expectedCompletedAt: minutesFromNow(20),
    progress: 0.72,
  })
  const goalOpsId = insertGoal(db, roomId, {
    description: [
      '任务：验证钱庄、训练营、议事和锦衣卫风险处理',
      '验收标准：能看到预算流水、训练配置、会议决议、风险处置记录。',
      '输出格式：运营验证表。',
      '交付结果：已写入示例流水和训练记录，等待一次用户反馈返工。',
    ].join('\n'),
    status: 'active',
    parentGoalId: rootGoalId,
    assignedWorkerId: workerIds.guard,
    expectedCompletedAt: minutesFromNow(35),
    progress: 0.48,
  })

  for (const goal of [
    { id: rootGoalId, workerId: leaderId, observation: '帮主完成首轮目标拆解：先验证看得见的协作，再验证可以修改和反馈。', metric: 0.64 },
    { id: goalInputsId, workerId: workerIds.clarifier, observation: '已交付需求澄清文档 v1，验收边界清楚。', metric: 1 },
    { id: goalFlowId, workerId: workerIds.flow, observation: '协作流程图已有 8 个节点，仍需检查用户点击节点后的详情。', metric: 0.72 },
    { id: goalOpsId, workerId: workerIds.guard, observation: '钱庄和锦衣卫记录已生成，训练营进入手动调整验证。', metric: 0.48 },
  ]) {
    db.prepare(`
      INSERT INTO goal_updates (goal_id, worker_id, observation, metric_value, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(goal.id, goal.workerId, goal.observation, goal.metric, minutesAgo(4))
  }

  const commonPromptTail = [
    '禁止偏移：不要把功能验证改写成市场研究或普通建议。',
    '试运行范围：先产出最小可检查结果，再交给下游。',
    '遇到阻塞：向帮主说明缺口、影响和建议处理。',
  ].join('\n')
  const tasks = [
    {
      name: '1. 需求澄清与验收边界确认',
      workerId: workerIds.clarifier,
      status: 'completed',
      progress: 1,
      runStatus: 'completed',
      lastResult: '已产出需求文档 v1：覆盖 12 项功能验证点、验收方式和风险边界。',
      description: [
        '正在解决：把“功能验证帮派”转成可验收需求文档。',
        '为什么要解决：防止系统只显示运行，实际没有可检查结果。',
        '当前进展：已列出目标、资料、交付物、验收标准、反馈返工路径。',
        '遇到困难：部分后台规则无需展示，已标为隐藏项。',
        '预计完成时间：已完成。',
        '流程序号：1',
        '上游输入：用户关于功能验证帮派的委托。',
        '下游接收方：流程设计弟子、钱庄核算弟子、锦衣卫巡查弟子。',
        '输出格式：Markdown 需求文档，包含目标、边界、交付物、验收标准、风险。',
        '验收标准：每个验证点能对应到一个页面、记录或操作。',
      ].join('\n'),
    },
    {
      name: '2. 协作流程图与泳道节点搭建',
      workerId: workerIds.flow,
      status: 'active',
      progress: 0.68,
      runStatus: 'running',
      lastResult: '已生成 8 个流程节点，正在补齐节点详情和手动调整入口。',
      description: [
        '正在解决：把弟子协作过程可视化成节点流程。',
        '为什么要解决：用户需要一眼看懂谁把什么交给谁。',
        '当前进展：已按镖单顺序生成流程，节点可点开查看负责人和交付限制。',
        '遇到困难：需要检查复杂节点在窄屏下是否可横向滚动。',
        '预计完成时间：20 分钟后。',
        '流程序号：2',
        '上游输入：需求澄清文档 v1。',
        '下游接收方：数据整理弟子、报告整合弟子。',
        '输出格式：流程节点清单，字段为节点、负责人、上游、下游、输出格式、验收标准。',
        '验收标准：每个节点点击后能看到完整交接信息。',
      ].join('\n'),
    },
    {
      name: '3. 样例资料采集与证据清单',
      workerId: workerIds.market,
      status: 'active',
      progress: 0.46,
      runStatus: 'running',
      lastResult: '已采集 6 条本地样例记录，等待数据整理弟子转成稳定字段。',
      description: [
        '正在解决：提供验证用样例资料，避免报告空转。',
        '为什么要解决：流程需要真实样本才能验证下游是否能复用。',
        '当前进展：已整理本地页面、任务记录、训练记录、钱庄流水样例。',
        '遇到困难：外部资料暂不作为必需输入，避免联网依赖。',
        '预计完成时间：18 分钟后。',
        '流程序号：3',
        '上游输入：需求文档、当前项目页面和本地数据库记录。',
        '下游接收方：数据整理弟子。',
        '输出格式：证据清单表，字段为来源、内容摘要、可验证位置、下游字段。',
        '验收标准：至少 6 条证据能被下游直接引用。',
      ].join('\n'),
    },
    {
      name: '4. 数据整理与下游字段标准化',
      workerId: workerIds.data,
      status: 'active',
      progress: 0.34,
      runStatus: 'running',
      lastResult: '等待情报采集弟子补齐两条样例的验证位置。',
      description: [
        '正在解决：把上游样例转成下游可直接使用的字段。',
        '为什么要解决：防止下游报告整合时只能重新理解自由文本。',
        '当前进展：字段模板已定，正在等待样例补齐。',
        '遇到困难：部分样例缺少“可验证位置”。',
        '预计完成时间：25 分钟后。',
        '流程序号：4',
        '上游输入：样例资料采集与证据清单。',
        '下游接收方：报告整合弟子、锦衣卫巡查弟子。',
        '输出格式：Markdown 表格，字段为验证点、证据、状态、负责人、缺口、下游字段。',
        '验收标准：字段名稳定，空值必须说明原因。',
      ].join('\n'),
    },
    {
      name: '5. 钱庄预算拨付与结余激励验证',
      workerId: workerIds.budget,
      status: 'completed',
      progress: 1,
      runStatus: 'completed',
      lastResult: '已记录铜钱、银两、金票三类预算的拨付、消耗、结余和效率积分。',
      description: [
        '正在解决：验证钱庄只管预算、余额、流水和激励。',
        '为什么要解决：让预算影响弟子更快交付，但不混同声望履历。',
        '当前进展：已生成 6 条内部流水，不涉及真实世界资金。',
        '遇到困难：无。',
        '预计完成时间：已完成。',
        '流程序号：5',
        '上游输入：需求文档和任务拆解。',
        '下游接收方：帮主、训练观察弟子。',
        '输出格式：预算流水表，含拨付、消耗、结余、效率积分。',
        '验收标准：页面只显示用户需要理解的余额与流水，不展示计算规则细节。',
      ].join('\n'),
    },
    {
      name: '6. 训练营手动调整与吸收验证',
      workerId: workerIds.trainer,
      status: 'active',
      progress: 0.58,
      runStatus: 'running',
      lastResult: '训练配置已写入两名弟子档案，等待下一轮任务验证吸收效果。',
      description: [
        '正在解决：验证训练后弟子去了哪里、在做什么、能否继续训练和手动调整。',
        '为什么要解决：训练不能只是消息，需要进入弟子配置和后续执行。',
        '当前进展：已生成训练记录和中文配置项。',
        '遇到困难：需要用户确认配置展示是否足够易读。',
        '预计完成时间：30 分钟后。',
        '流程序号：6',
        '上游输入：流程设计结果、钱庄激励记录。',
        '下游接收方：报告整合弟子。',
        '输出格式：训练记录，含状态、配置变化、吸收证据、下一次验证点。',
        '验收标准：训练营能显示继续训练和手动调整功能。',
      ].join('\n'),
    },
    {
      name: '7. 锦衣卫风险巡查与看守验证',
      workerId: workerIds.guard,
      status: 'paused',
      progress: 0.52,
      runStatus: 'paused',
      lastResult: '已触发黄色预警：报告整合弟子等待下游字段，暂不进入囚禁，仅看守。',
      description: [
        '正在解决：验证风险不是闭关，而是巡查、看守、囚禁等递进处理。',
        '为什么要解决：有问题的弟子和异常流程需要被审计，但不能随意删除。',
        '当前进展：已发现报告整合弟子缺下游字段，标记为看守。',
        '遇到困难：等待数据整理弟子补齐字段。',
        '预计完成时间：待字段补齐后 10 分钟。',
        '流程序号：7',
        '上游输入：数据整理表、训练记录、钱庄流水。',
        '下游接收方：帮主、议事堂。',
        '输出格式：风险清单，字段为风险、证据、等级、处置建议、复验方式。',
        '验收标准：风险处置可解释，不把正常等待误判为失败。',
      ].join('\n'),
    },
    {
      name: '8. 最终报告整合与用户反馈返工',
      workerId: workerIds.report,
      status: 'active',
      progress: 0.41,
      runStatus: 'running',
      lastResult: '已生成报告骨架，等待风险清单和下游字段后补齐最终结论。',
      description: [
        '正在解决：把所有子任务产出整合成用户可判断的结果。',
        '为什么要解决：任务完成必须有结果、依据和返工入口。',
        '当前进展：报告骨架已生成，结论区等待最终证据。',
        '遇到困难：数据整理字段和风险清单未完全交付。',
        '预计完成时间：45 分钟后。',
        '流程序号：8',
        '上游输入：需求文档、流程节点、证据清单、数据表、预算流水、训练记录、风险清单。',
        '下游接收方：帮主验收后给用户。',
        '输出格式：最终报告，包含结论、完成判断、依据、风险、未完成项、用户反馈入口。',
        '验收标准：用户能知道目标是否完成、为什么完成或哪里没完成。',
      ].join('\n'),
    },
  ]

  const taskIds = []
  for (const [index, task] of tasks.entries()) {
    const taskId = insertTask(db, roomId, {
      name: task.name,
      description: task.description,
      prompt: [
        `执行镖单：${task.name}`,
        task.description,
        commonPromptTail,
      ].join('\n\n'),
      workerId: task.workerId,
      status: task.status,
      lastRun: minutesAgo(18 - index * 2),
      lastResult: task.lastResult,
      runCount: task.runStatus === 'completed' ? 2 : 1,
      errorCount: 0,
      allowedTools: json(['company_recall', 'company_save_memory', 'company_send_message']),
      learnedContext: `功能验证经验：${task.name} 必须保留上下游、输出格式和验收标准。`,
      updatedAt: minutesAgo(2),
    })
    taskIds.push(taskId)
    const runId = insertTaskRun(db, {
      taskId,
      status: task.runStatus === 'paused' ? 'running' : task.runStatus,
      startedAt: minutesAgo(18 - index * 2),
      finishedAt: task.runStatus === 'completed' ? minutesAgo(15 - index * 2) : null,
      result: task.runStatus === 'completed' ? task.lastResult : null,
      progress: task.progress,
      progressMessage: task.runStatus === 'completed' ? '已完成并交给下游' : task.lastResult,
      durationMs: task.runStatus === 'completed' ? 162000 : null,
    })
    db.prepare(`
      INSERT INTO console_logs (run_id, seq, entry_type, content, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(runId, 1, 'info', `帮主分派给 ${Object.keys(workerIds).find((key) => workerIds[key] === task.workerId) || '弟子'}：${task.name}`, minutesAgo(17 - index * 2))
    db.prepare(`
      INSERT INTO console_logs (run_id, seq, entry_type, content, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(runId, 2, 'result', task.lastResult, minutesAgo(16 - index * 2))
  }

  const cyclePlan = [
    { workerId: leaderId, status: 'completed', startedAgo: 34, finishedAgo: 33, logs: ['帮主分析委托目标，确认必须覆盖看板、目标、流程、训练、预算和风险。'] },
    { workerId: workerIds.clarifier, status: 'completed', startedAgo: 31, finishedAgo: 29, logs: ['需求澄清弟子产出需求文档 v1，列出 12 项验收点。'] },
    { workerId: workerIds.flow, status: 'completed', startedAgo: 27, finishedAgo: 25, logs: ['流程设计弟子生成 8 个协作节点，并写清上下游。'] },
    { workerId: workerIds.budget, status: 'completed', startedAgo: 23, finishedAgo: 21, logs: ['钱庄核算弟子记录预算拨付、消耗和结余激励。'] },
    { workerId: workerIds.market, status: 'completed', startedAgo: 19, finishedAgo: 17, logs: ['情报采集弟子整理本地验证样例，交给数据整理弟子。'] },
    { workerId: workerIds.data, status: 'running', startedAgo: 14, finishedAgo: null, logs: ['数据整理弟子正在把样例转成稳定字段。'] },
    { workerId: workerIds.guard, status: 'completed', startedAgo: 11, finishedAgo: 9, logs: ['锦衣卫巡查弟子发出黄色预警：报告整合暂时看守。'] },
    { workerId: workerIds.trainer, status: 'running', startedAgo: 6, finishedAgo: null, logs: ['训练观察弟子检查手动调整配置是否被吸收。'] },
  ]
  for (const item of cyclePlan) {
    insertCycle(db, roomId, {
      workerId: item.workerId,
      status: item.status,
      startedAt: minutesAgo(item.startedAgo),
      finishedAt: item.finishedAgo == null ? null : minutesAgo(item.finishedAgo),
      durationMs: item.finishedAgo == null ? null : (item.startedAgo - item.finishedAgo) * 60_000,
      inputTokens: item.status === 'completed' ? 1200 + item.startedAgo * 10 : 760,
      outputTokens: item.status === 'completed' ? 520 : 180,
      logs: item.logs.map((content) => ({ type: 'info', content })),
    })
  }

  const walletId = Number(db.prepare(`
    INSERT INTO wallets (room_id, address, private_key_encrypted, chain, erc8004_agent_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(roomId, 'jianghu://qianzhuang/function-validation', 'local-only-validation-budget', 'local', 'validation-gang', minutesAgo(35)).lastInsertRowid)

  const walletTransactions = [
    ['budget_grant', '+3000 铜钱', '钱庄', '初始预算拨付给帮主', 'confirmed', 'grant', 34],
    ['budget_grant', '+80 银两', '钱庄', '工具调用额度拨付', 'confirmed', 'grant', 34],
    ['budget_grant', '+6 金票', '钱庄', '高成本模型额度拨付', 'confirmed', 'grant', 34],
    ['spend', '-420 铜钱', '需求澄清弟子', '需求文档产出消耗', 'confirmed', 'execution', 26],
    ['spend', '-12 银两', '情报采集弟子', '样例采集和数据整理消耗', 'confirmed', 'tooling', 16],
    ['bonus', '+68 效率积分', '钱庄核算弟子', '结余折算进履历，不作为真实货币', 'confirmed', 'incentive', 8],
  ]
  for (const [type, amount, counterparty, description, status, category, ago] of walletTransactions) {
    db.prepare(`
      INSERT INTO wallet_transactions (wallet_id, type, amount, counterparty, tx_hash, description, status, category, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(walletId, type, amount, counterparty, null, description, status, category, minutesAgo(ago))
  }

  const skills = [
    {
      name: '需求澄清五问法',
      content: [
        '---',
        'name: 需求澄清五问法',
        'description: 把模糊委托整理成目标、背景、交付物、资料、验收标准。',
        '---',
        '# 使用方式',
        '1. 先问目标和成功标准。',
        '2. 补齐背景、资料、交付物、优先级。',
        '3. 生成需求文档并让用户确认。',
      ].join('\n'),
      context: '需求澄清弟子接到模糊委托时自动启用。',
      workerId: workerIds.clarifier,
    },
    {
      name: '上下游交接约束法',
      content: [
        '---',
        'name: 上下游交接约束法',
        'description: 每张镖单必须写明上游输入、下游接收方、输出格式和验收标准。',
        '---',
        '# 步骤',
        '1. 确认输入来源。',
        '2. 确认交给谁。',
        '3. 固定输出字段。',
        '4. 写明退回返工条件。',
      ].join('\n'),
      context: '帮主分派复杂协作流程时启用。',
      workerId: workerIds.flow,
    },
    {
      name: '看守风险递进法',
      content: [
        '---',
        'name: 看守风险递进法',
        'description: 把异常处理分为提醒、看守、囚禁、清理，避免把所有问题都叫闭关。',
        '---',
        '# 处置等级',
        '提醒：轻微偏移。',
        '看守：等待补证或补字段。',
        '囚禁：疑似违规或重复失败。',
        '清理：确认异常且不可恢复。',
      ].join('\n'),
      context: '锦衣卫发现异常时启用。',
      workerId: workerIds.guard,
    },
  ]
  for (const skill of skills) {
    db.prepare(`
      INSERT INTO skills (room_id, name, content, activation_context, auto_activate, agent_created, created_by_worker_id, version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(roomId, skill.name, skill.content, skill.context, 1, 1, skill.workerId, 1, minutesAgo(22), minutesAgo(4))
  }

  const decisionId = Number(db.prepare(`
    INSERT INTO quorum_decisions
      (room_id, proposer_id, proposal, decision_type, status, result, threshold, timeout_at, keeper_vote, min_voters, sealed, effective_at, created_at, resolved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    roomId,
    leaderId,
    '是否允许训练观察弟子把“输出格式必须给下游字段”写入报告整合弟子的训练配置？',
    'strategy',
    'approved',
    '通过：允许写入，但锦衣卫需要在下一轮检查是否造成过度约束。',
    'majority',
    minutesFromNow(10),
    'approve',
    3,
    1,
    minutesAgo(7),
    minutesAgo(12),
    minutesAgo(7)
  ).lastInsertRowid)
  for (const vote of [
    [workerIds.flow, 'approve', '流程交接需要稳定字段。'],
    [workerIds.guard, 'approve', '允许，但标记一次复验。'],
    [workerIds.report, 'abstain', '等待看到数据整理字段后再确认。'],
  ]) {
    db.prepare(`
      INSERT INTO quorum_votes (decision_id, worker_id, vote, reasoning, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(decisionId, vote[0], vote[1], vote[2], minutesAgo(9))
  }

  const trainingEscalationId = Number(db.prepare(`
    INSERT INTO escalations (room_id, from_agent_id, to_agent_id, question, answer, status, created_at, resolved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    roomId,
    leaderId,
    workerIds.report,
    [
      '弟子训练：报告整合弟子',
      '以后整合报告时，必须先列出“目标是否完成”的判断，再列依据、未完成项、风险、用户反馈入口。不能只说建议。',
    ].join('\n'),
    null,
    'pending',
    minutesAgo(14),
    null
  ).lastInsertRowid)
  db.prepare(`
    INSERT INTO training_adjustments (room_id, escalation_id, worker_id, status, progress, note, config_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    roomId,
    trainingEscalationId,
    workerIds.report,
    'training',
    66,
    '已写入角色定义配置，等待下一轮报告验证。',
    json(createTrainingConfig('报告整合弟子', '报告整合', '结论 / 完成判断 / 依据 / 未完成项 / 风险 / 用户反馈入口')),
    minutesAgo(13),
    minutesAgo(4)
  )

  const absorbedTrainingId = Number(db.prepare(`
    INSERT INTO escalations (room_id, from_agent_id, to_agent_id, question, answer, status, created_at, resolved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    roomId,
    leaderId,
    workerIds.flow,
    [
      '弟子训练：流程设计弟子',
      '每个流程节点必须包含负责人、上游输入、下游接收方、输出格式、验收标准和可点击详情。',
    ].join('\n'),
    '已吸收：后续新增节点会先补齐六项字段，再进入协作流程。',
    'resolved',
    minutesAgo(24),
    minutesAgo(20)
  ).lastInsertRowid)
  db.prepare(`
    INSERT INTO training_adjustments (room_id, escalation_id, worker_id, status, progress, note, config_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    roomId,
    absorbedTrainingId,
    workerIds.flow,
    'absorbed',
    100,
    '已吸收流程节点六字段规则。',
    json(createTrainingConfig('流程设计弟子', '协作流程', '节点清单：负责人 / 上游 / 下游 / 输出格式 / 验收标准 / 当前状态')),
    minutesAgo(23),
    minutesAgo(20)
  )

  db.prepare(`
    INSERT INTO escalations (room_id, from_agent_id, to_agent_id, question, answer, status, created_at, resolved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    roomId,
    null,
    leaderId,
    '用户对帮主说：检查这支验证帮派是否真的在运行，并说明现在卡在哪里。',
    '帮主回复：当前正在运行 4 张镖单，卡点是数据整理字段和报告整合等待风险清单。我会先让数据整理弟子补字段，再让报告整合弟子出可验收结果。',
    'resolved',
    minutesAgo(5),
    minutesAgo(4)
  )

  const messages = [
    ['outbound', String(roomId), '外部情报协助帮', '请求补充验证样例', '请补充一条“跨帮派资料传递”的示例记录，龙门镖局只负责传递，不参与任务推进。', 'sent', 18],
    ['inbound', '外部情报协助帮', String(roomId), '验证样例已送达', '收到：跨帮派消息可以作为证据进入情报采集弟子的证据清单。', 'read', 15],
  ]
  for (const [direction, fromRoomId, toRoomId, subject, body, status, ago] of messages) {
    db.prepare(`
      INSERT INTO room_messages (room_id, direction, from_room_id, to_room_id, subject, body, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(roomId, direction, fromRoomId, toRoomId, subject, body, status, minutesAgo(ago))
  }

  const memoryEntityId = Number(db.prepare(`
    INSERT INTO entities (name, type, category, room_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('功能验证经验：先做最小可检查结果', 'memory', '帮派记忆', roomId, minutesAgo(28), minutesAgo(3)).lastInsertRowid)
  for (const content of [
    '复杂委托不要一开始追求大而全，先生成一支固定验证帮派，让用户能点开每个功能看结果。',
    '帮主必须把“当前做什么”和“结果是什么”写清楚，否则用户会误以为只是状态在动。',
    '龙门镖局只负责帮派之间传递信息，项目进度由帮主负责。',
  ]) {
    db.prepare(`
      INSERT INTO observations (entity_id, content, source, created_at)
      VALUES (?, ?, ?, ?)
    `).run(memoryEntityId, content, '功能验证复杂协作帮', minutesAgo(3))
  }

  const activities = [
    { type: 'leader_plan', actor: leaderId, summary: '帮主完成目标分析和作战计划', details: '目标被拆成需求澄清、协作流程、样例采集、数据整理、钱庄核算、训练营、风险巡查、报告整合 8 条镖单。', ago: 32 },
    { type: 'task_assignment', actor: leaderId, summary: '帮主按上下游给 8 名弟子分派镖单', details: '每张镖单都写入流程序号、上游输入、下游接收方、输出格式和验收标准。', ago: 27 },
    { type: 'task_result', actor: workerIds.clarifier, summary: '需求澄清弟子产出需求文档 v1', details: '形成 12 项功能验证清单，交给流程设计、钱庄和锦衣卫使用。', ago: 25 },
    { type: 'budget', actor: workerIds.budget, summary: '钱庄核算弟子记录预算拨付和结余激励', details: '已记录 3000 铜钱、80 银两、6 金票；结余只折算为效率积分，不是现实资金。', ago: 17 },
    { type: 'message', actor: workerIds.market, summary: '龙门镖局完成一次跨帮派资料传递', details: '外部情报协助帮送回验证样例；龙门镖局只负责传递，不负责进度。', ago: 14 },
    { type: 'risk', actor: workerIds.guard, summary: '锦衣卫对报告整合弟子执行看守', details: '原因：等待数据整理字段，暂不升级到囚禁；下一轮复验是否仍阻塞。', ago: 9 },
    { type: 'training', actor: workerIds.trainer, summary: '训练观察弟子写入两份训练配置', details: '流程设计弟子已吸收；报告整合弟子仍在训练中。', ago: 5 },
    { type: 'handoff', actor: workerIds.data, summary: '数据整理弟子正在补齐下游字段', details: '缺口：两条样例缺少可验证位置；补齐后交给报告整合弟子。', ago: 3 },
  ]
  for (const activity of activities) {
    insertActivity(db, roomId, {
      eventType: activity.type,
      actorId: activity.actor,
      summary: activity.summary,
      details: activity.details,
      createdAt: minutesAgo(activity.ago),
    })
  }

  db.prepare(`
    INSERT INTO chat_messages (room_id, role, content, created_at)
    VALUES (?, ?, ?, ?), (?, ?, ?, ?)
  `).run(
    roomId,
    'user',
    '请用这支帮派验证大部分功能是否能跑通。',
    minutesAgo(36),
    roomId,
    'assistant',
    '已建立功能验证复杂协作帮：我会按目标澄清、分派、协作、预算、训练、审计、复盘的顺序推进。',
    minutesAgo(35)
  )

  return { roomId, leaderId, workerCount: Object.keys(workerIds).length + 1, taskCount: taskIds.length }
}

const dbPath = resolveDbPath()
if (!existsSync(dbPath)) {
  console.error(`Database not found at ${dbPath}`)
  console.error('请先启动一次项目，让本地数据库完成初始化。')
  process.exit(1)
}

const db = new Database(dbPath)
db.pragma('foreign_keys = ON')

try {
  const result = db.transaction(() => createValidationGang(db))()
  console.log(`已重建「${ROOM_NAME}」`)
  console.log(`帮派 ID: ${result.roomId}`)
  console.log(`帮主 ID: ${result.leaderId}`)
  console.log(`成员数: ${result.workerCount}`)
  console.log(`镖单数: ${result.taskCount}`)
  console.log(`数据库: ${dbPath}`)
} finally {
  db.close()
}
