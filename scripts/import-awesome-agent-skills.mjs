#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import Database from 'better-sqlite3'

const SOURCE_NAME = 'libukai/awesome-agent-skills'
const SOURCE_URL = 'https://github.com/libukai/awesome-agent-skills'
const LEGACY_SOURCE_NAMES = ['VoltAgent/awesome-agent-skills', SOURCE_NAME]
const LEGACY_IMPORT_PREFIX = '外部功法：'
const INDEX_NAME = '藏经阁 Skill 索引：Awesome Agent Skills'

const EXACT_TITLES = new Map([
  ['docx', 'Word 文档处理'],
  ['doc-coauthoring', '文档协同写作'],
  ['pptx', 'PowerPoint 演示文稿处理'],
  ['xlsx', 'Excel 表格处理'],
  ['pdf', 'PDF 文档处理'],
  ['template', '功法模板'],
  ['create-voltagent', '创建 VoltAgent 项目'],
  ['voltagent-best-practices', 'VoltAgent 最佳实践'],
  ['voltagent-core-reference', 'VoltAgent 核心参考'],
  ['voltagent-subagents', 'VoltAgent 子弟子编排'],
  ['voltagent-docs-bundle', 'VoltAgent 文档包'],
  ['skill-creator', '功法创建器'],
  ['theme-factory', '主题工坊'],
  ['shadcn-ui', 'shadcn UI 组件'],
])

const TOKEN_LABELS = new Map([
  ['ai', 'AI'],
  ['api', 'API'],
  ['apis', 'API'],
  ['app', '应用'],
  ['apps', '应用'],
  ['agent', '智能体'],
  ['agents', '智能体'],
  ['algorithmic', '算法'],
  ['analysis', '分析'],
  ['analytics', '分析'],
  ['analyze', '分析'],
  ['android', 'Android'],
  ['angular', 'Angular'],
  ['animation', '动画'],
  ['art', '艺术'],
  ['artifacts', 'Artifacts'],
  ['auth', '认证'],
  ['automation', '自动化'],
  ['best', '最佳'],
  ['billing', '计费'],
  ['blobs', '对象存储'],
  ['brand', '品牌'],
  ['builder', '构建器'],
  ['building', '构建'],
  ['calendar', '日历'],
  ['canvas', '画布'],
  ['caching', '缓存'],
  ['chat', '聊天'],
  ['claude', 'Claude'],
  ['cli', 'CLI'],
  ['cloud', '云'],
  ['cloudflare', 'Cloudflare'],
  ['code', '代码'],
  ['coding', '编码'],
  ['collaboration', '协作'],
  ['coauthoring', '协同写作'],
  ['color', '色彩'],
  ['comms', '沟通'],
  ['components', '组件'],
  ['config', '配置'],
  ['context', '上下文'],
  ['core', '核心'],
  ['creator', '创建器'],
  ['css', 'CSS'],
  ['data', '数据'],
  ['database', '数据库'],
  ['db', '数据库'],
  ['debug', '调试'],
  ['debugging', '调试'],
  ['deploy', '部署'],
  ['deployment', '部署'],
  ['design', '设计'],
  ['docs', '文档'],
  ['documentation', '文档'],
  ['durable', '持久化'],
  ['edge', '边缘'],
  ['email', '邮件'],
  ['enhance', '增强'],
  ['engineering', '工程'],
  ['events', '事件'],
  ['expert', '专家'],
  ['expo', 'Expo'],
  ['express', 'Express'],
  ['figma', 'Figma'],
  ['files', '文件'],
  ['factory', '工坊'],
  ['forms', '表单'],
  ['frameworks', '框架'],
  ['frontend', '前端'],
  ['functions', '函数'],
  ['gateway', '网关'],
  ['gemini', 'Gemini'],
  ['github', 'GitHub'],
  ['gmail', 'Gmail'],
  ['google', 'Google'],
  ['graphql', 'GraphQL'],
  ['guide', '指南'],
  ['image', '图像'],
  ['images', '图像'],
  ['ios', 'iOS'],
  ['javascript', 'JavaScript'],
  ['js', 'JavaScript'],
  ['knowledge', '知识'],
  ['labs', 'Labs'],
  ['marketing', '营销'],
  ['mcp', 'MCP'],
  ['mobile', '移动端'],
  ['mongodb', 'MongoDB'],
  ['native', '原生'],
  ['netlify', 'Netlify'],
  ['next', 'Next.js'],
  ['node', 'Node.js'],
  ['n8n', 'n8n'],
  ['operations', '运维'],
  ['optimization', '优化'],
  ['patterns', '模式'],
  ['perf', '性能'],
  ['performance', '性能'],
  ['postgres', 'Postgres'],
  ['practices', '实践'],
  ['product', '产品'],
  ['prompt', '提示词'],
  ['python', 'Python'],
  ['quality', '质量'],
  ['react', 'React'],
  ['redis', 'Redis'],
  ['reference', '参考'],
  ['remotion', 'Remotion'],
  ['reports', '报告'],
  ['review', '审查'],
  ['router', '路由'],
  ['rules', '规则'],
  ['sandbox', '沙箱'],
  ['sdk', 'SDK'],
  ['seo', 'SEO'],
  ['server', '服务器'],
  ['serverless', 'Serverless'],
  ['shadcn', 'shadcn UI'],
  ['shared', '共享'],
  ['sheets', '表格'],
  ['skill', '功法'],
  ['skills', '功法'],
  ['slack', 'Slack'],
  ['slides', '幻灯片'],
  ['sql', 'SQL'],
  ['stripe', 'Stripe'],
  ['supabase', 'Supabase'],
  ['swiftui', 'SwiftUI'],
  ['tasks', '任务'],
  ['testing', '测试'],
  ['terraform', 'Terraform'],
  ['theme', '主题'],
  ['threejs', 'Three.js'],
  ['tools', '工具'],
  ['ui', 'UI'],
  ['validation', '校验'],
  ['vercel', 'Vercel'],
  ['video', '视频'],
  ['visual', '视觉'],
  ['vue', 'Vue'],
  ['web', 'Web'],
  ['webapp', 'Web 应用'],
  ['workflow', '流程'],
  ['workflows', '流程'],
  ['workspace', 'Workspace'],
  ['workers', 'Workers'],
  ['wrangler', 'Wrangler'],
])

const PHRASE_LABELS = [
  [/best practices/g, '最佳实践'],
  [/code review/g, '代码审查'],
  [/prompt engineering/g, '提示词工程'],
  [/frontend design/g, '前端设计'],
  [/web app/g, 'Web 应用'],
  [/webapp/g, 'Web 应用'],
  [/native ui/g, '原生 UI'],
  [/internal comms/g, '内部沟通'],
  [/brand guidelines/g, '品牌规范'],
  [/core reference/g, '核心参考'],
  [/sub agents/g, '子智能体'],
  [/subagents/g, '子智能体'],
  [/durable objects/g, 'Durable Objects'],
  [/edge functions/g, '边缘函数'],
  [/netlify functions/g, 'Netlify 函数'],
  [/google workspace/g, 'Google Workspace'],
]

const SECTION_LABELS = [
  [/official claude/i, '官方 Claude'],
  [/marketing/i, '营销'],
  [/productivity|collaboration/i, '生产协作'],
  [/development|testing/i, '开发测试'],
  [/context/i, '上下文工程'],
  [/specialized/i, '专业领域'],
  [/automation/i, '自动化'],
  [/database|mongo|redis|vector/i, '数据系统'],
  [/design|figma|stitch/i, '设计'],
  [/workspace/i, '办公协作'],
]

function expandTilde(value) {
  return value.startsWith('~/') ? join(homedir(), value.slice(2)) : value
}

function defaultDbPath() {
  if (process.env.COMPANY_DB_PATH) return expandTilde(process.env.COMPANY_DB_PATH)
  if (process.env.COMPANY_DATA_DIR) return join(expandTilde(process.env.COMPANY_DATA_DIR), 'data.db')
  return join(process.cwd(), '.company-local-dev', 'data.db')
}

function usage() {
  console.error([
    'Usage:',
    '  node scripts/import-awesome-agent-skills.mjs <README.md> [--db <data.db>] [--room <roomId>]',
    '',
    'Defaults:',
    '  --db   $COMPANY_DB_PATH, or $COMPANY_DATA_DIR/data.db, or .company-local-dev/data.db',
    '  --room all non-stopped rooms; if none exist, all rooms',
  ].join('\n'))
}

function parseArgs(argv) {
  const args = { readme: null, db: defaultDbPath(), roomId: null }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--db') {
      args.db = argv[++i]
    } else if (arg === '--room') {
      args.roomId = Number(argv[++i])
    } else if (!args.readme) {
      args.readme = arg
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  if (!args.readme) throw new Error('README path is required')
  if (args.roomId !== null && !Number.isInteger(args.roomId)) throw new Error('--room must be a number')
  return {
    readme: resolve(args.readme),
    db: resolve(expandTilde(args.db)),
    roomId: args.roomId,
  }
}

function parseCatalog(markdown) {
  let section = 'Uncategorized'
  const skills = []
  for (const line of markdown.split(/\r?\n/)) {
    const sectionMatch = line.match(/<summary><h3[^>]*>(.*?)<\/h3><\/summary>/) || line.match(/^###\s+(.+)$/)
    if (sectionMatch) {
      section = sectionMatch[1].replace(/<[^>]+>/g, '').trim()
      continue
    }
    const itemMatch = line.match(/^- \*\*\[([^\]]+)\]\(([^)]+)\)\*\*\s*[-：:]\s*(.+)$/)
      || line.match(/^- \[([^\]]+)\]\(([^)]+)\)\s*[：:]\s*(.+)$/)
      || line.match(/^- \[([^\]]+)\]\(([^)]+)\)\s*-\s*(.+)$/)
    if (!itemMatch) continue
    skills.push({
      section,
      name: itemMatch[1].trim(),
      url: itemMatch[2].trim(),
      description: itemMatch[3].trim(),
    })
  }
  return skills
}

function sectionLabel(section) {
  if (/shadcn\/ui/i.test(section)) return 'shadcn UI'
  for (const [pattern, label] of SECTION_LABELS) {
    if (pattern.test(section)) return label
  }
  const cleaned = section
    .replace(/^Skills by\s+/i, '')
    .replace(/\s+Team\b/i, '')
    .replace(/\s+team\b/i, '')
    .trim()
  return cleaned || '通用'
}

function titleCaseUnknown(token) {
  if (/^[a-z]{2,}$/.test(token)) return token[0].toUpperCase() + token.slice(1)
  return token
}

function chineseTitleFor(skill) {
  const originalSlug = (skill.name.split('/').at(-1) ?? skill.name).trim()
  const slug = originalSlug.toLowerCase()
  if (EXACT_TITLES.has(slug)) return EXACT_TITLES.get(slug)

  if (slug === 'skill' || slug === 'skills') {
    const owner = skill.name.split('/')[0]?.trim() || '通用'
    return `${owner} ${sectionLabel(skill.section)}功法`
  }

  let normalized = slug.replace(/[._-]+/g, ' ').replace(/\s+/g, ' ').trim()
  for (const [pattern, label] of PHRASE_LABELS) {
    normalized = normalized.replace(pattern, label)
  }

  const parts = normalized
    .split(/\s+/)
    .map(part => TOKEN_LABELS.get(part) ?? titleCaseUnknown(part))
    .filter(part => part && part !== '功法')

  let title = parts.join(' ').replace(/\s+/g, ' ').trim()
  if (!title) title = skill.name
  if (!/[\u4e00-\u9fa5]/.test(title)) title = `${title} ${sectionLabel(skill.section)}`
  return title
}

function tokenize(skill) {
  const title = chineseTitleFor(skill)
  const category = sectionLabel(skill.section)
  const pattern = inferPattern(skill)
  const raw = [
    skill.name,
    skill.section,
    skill.description,
    title,
    category,
    pattern,
    skill.name.split('/').at(-1) ?? skill.name,
    skill.name.split('/')[0] ?? '',
  ].join(' ')
  const tokens = raw
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5.+#-]+/g, ' ')
    .split(/\s+/)
    .map(t => t.trim())
    .filter(t => t.length >= 2 && t.length <= 40)
  return [...new Set([category, pattern, 'awesome-agent-skills', 'SKILL.md', ...title.split(/\s+/), ...tokens])].slice(0, 28)
}

function inferPattern(skill) {
  const text = [skill.name, skill.section, skill.description].join(' ').toLowerCase()
  if (/review|audit|checklist|quality|security|安全|审查|审核|评审/.test(text)) return 'reviewer'
  if (/template|generator|generate|report|doc|ppt|slide|sheet|pdf|image|video|content|写作|生成|模板|报告|文档/.test(text)) return 'generator'
  if (/interview|clarif|requirement|planner|planning|strategy|office-hours|startup|需求|澄清|访谈|规划/.test(text)) return 'inversion'
  if (/pipeline|workflow|automation|n8n|ci|deploy|test|release|流水线|流程|自动化/.test(text)) return 'pipeline'
  return 'tool-wrapper'
}

function patternLabel(pattern) {
  return {
    'tool-wrapper': '工具封装',
    generator: '生成器',
    reviewer: '审查器',
    inversion: '反转访谈',
    pipeline: '流水线',
  }[pattern] ?? '工具封装'
}

function contentFor(skill) {
  const pattern = inferPattern(skill)
  const installHint = skill.url.includes('officialskills.sh')
    ? '如果需要实际安装，先查看对应 Skill 页中的 SKILL.md 和安装命令；常见形式是 npx skills add。'
    : '如果需要实际安装，先查看对应仓库或目录中的 SKILL.md、references、scripts、assets 和示例。'

  return [
    '---',
    `name: ${skill.name}`,
    `description: ${skill.description}`,
    'metadata:',
    `  pattern: ${pattern}`,
    `  pattern_label: ${patternLabel(pattern)}`,
    `  category: ${sectionLabel(skill.section)}`,
    `  origin_url: ${skill.url}`,
    '---',
    '',
    '## 适用场景',
    skill.description,
    '',
    '## 触发条件',
    `当委托、镖单或弟子任务涉及「${chineseTitleFor(skill)}」「${skill.name}」或上述场景时，才按需加载本 Skill。`,
    '',
    '## 使用配置',
    '1. 先读取本条 SKILL.md 的描述和设计模式，确认是否匹配当前任务。',
    '2. 如果这是工具封装模式，只在真正需要对应工具、框架或平台时加载详细规则。',
    '3. 如果这是生成器、审查器、反转访谈或流水线模式，严格遵守它的输出结构、检查清单、提问顺序或步骤门控。',
    `4. ${installHint}`,
    '',
    '## 目录约定',
    '- SKILL.md：必需，保存触发说明、执行流程、边界和元数据。',
    '- references/：可选，保存规范、清单、领域知识和详细参考资料。',
    '- scripts/：可选，保存可复用脚本；执行前需要安全审查。',
    '- assets/：可选，保存模板、样例、图片或固定输出结构。',
    '',
    '## 调用边界',
    installHint,
    '如果本地尚未安装对应外部 Skill，先把可复用步骤沉淀为本地版本，再交给弟子调用。',
    '涉及账号、密钥、付费、外部服务写入、联网发布或脚本执行时，必须先走确认和审计流程。',
  ].join('\n')
}

function indexContent(total) {
  return [
    '---',
    'name: awesome-agent-skills-index',
    'description: 藏经阁 Skill 索引，用于按任务匹配可复用技能。',
    'metadata:',
    '  pattern: catalog',
    '  category: Skill 索引',
    `  origin_url: ${SOURCE_URL}`,
    '---',
    '',
    `已从 awesome-agent-skills 导入 ${total} 个 Skill 索引。`,
    '',
    '## 用法',
    '遇到具体技术、平台、文档、测试、设计、营销、数据、自动化等委托时，先在藏经阁按 Skill 名称、分类、设计模式或标签查找匹配条目。',
    '匹配后按该 Skill 的适用场景、触发条件和使用配置执行；完成后把实际踩坑和本地化步骤沉淀为新的本地 Skill。',
    '',
    '## 设计模式',
    '- 工具封装：按需加载工具或框架规则。',
    '- 生成器：用模板生成稳定结构的交付物。',
    '- 审查器：按清单和严重程度审查结果。',
    '- 反转访谈：先澄清需求再开始行动。',
    '- 流水线：按检查点推进复杂流程。',
    '',
    '## 调用边界',
    '这些条目是 Skill 索引，不代表外部工具已授权、已安装或可以直接写入外部系统。需要联网、账号、密钥、脚本执行、外部发布或产生费用时，必须走江湖规矩。',
  ].join('\n')
}

function targetRooms(db, roomId) {
  if (roomId !== null) {
    const room = db.prepare('SELECT id, name, status FROM rooms WHERE id = ?').get(roomId)
    if (!room) throw new Error(`Room ${roomId} not found`)
    return [room]
  }
  const active = db.prepare("SELECT id, name, status FROM rooms WHERE status != 'stopped' ORDER BY id").all()
  if (active.length > 0) return active
  return db.prepare('SELECT id, name, status FROM rooms ORDER BY id').all()
}

function importForRoom(db, room, skills) {
  const deleteImported = db.prepare('DELETE FROM skills WHERE room_id = ? AND (name LIKE ? OR name = ? OR content LIKE ? OR content LIKE ?)')
  const insert = db.prepare(`
    INSERT INTO skills (room_id, name, content, activation_context, auto_activate, agent_created, created_by_worker_id)
    VALUES (?, ?, ?, ?, 1, 0, NULL)
  `)
  const titleCounts = new Map()
  for (const skill of skills) {
    const title = chineseTitleFor(skill)
    titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1)
  }
  const titleSeen = new Map()
  function displayTitle(skill) {
    const title = chineseTitleFor(skill)
    const total = titleCounts.get(title) ?? 0
    if (total <= 1) return title
    const next = (titleSeen.get(title) ?? 0) + 1
    titleSeen.set(title, next)
    return `${title}（${next}）`
  }
  const run = db.transaction(() => {
    deleteImported.run(
      room.id,
      `${LEGACY_IMPORT_PREFIX}%`,
      INDEX_NAME,
      `%${LEGACY_SOURCE_NAMES[0]}%`,
      `%${LEGACY_SOURCE_NAMES[1]}%`
    )
    insert.run(
      room.id,
      INDEX_NAME,
      indexContent(skills.length),
      JSON.stringify(['awesome-agent-skills', 'SKILL.md', 'Skill 索引', '工具封装', '生成器', '审查器', '反转访谈', '流水线'])
    )
    for (const skill of skills) {
      insert.run(
        room.id,
        displayTitle(skill),
        contentFor(skill),
        JSON.stringify(tokenize(skill))
      )
    }
  })
  run()
  return skills.length + 1
}

try {
  const args = parseArgs(process.argv.slice(2))
  if (!existsSync(args.readme)) throw new Error(`README not found: ${args.readme}`)
  if (!existsSync(args.db)) throw new Error(`Database not found: ${args.db}`)

  const markdown = readFileSync(args.readme, 'utf8')
  const skills = parseCatalog(markdown)
  if (skills.length === 0) throw new Error('No skills found in README')

  const db = new Database(args.db)
  db.pragma('journal_mode = WAL')
  const rooms = targetRooms(db, args.roomId)
  if (rooms.length === 0) throw new Error('No rooms found; create a 帮派 first')

  let inserted = 0
  for (const room of rooms) {
    inserted += importForRoom(db, room, skills)
  }
  db.close()

  console.log(JSON.stringify({
    ok: true,
    source: SOURCE_NAME,
    db: args.db,
    readme: args.readme,
    skillCount: skills.length,
    rooms: rooms.map(r => ({ id: r.id, name: r.name, status: r.status })),
    recordsWritten: inserted,
    storageDir: dirname(args.db),
  }, null, 2))
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  usage()
  process.exit(1)
}
