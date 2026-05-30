import { useState, useEffect, useMemo } from 'react'
import { usePolling } from '../hooks/usePolling'
import { useContainerWidth } from '../hooks/useContainerWidth'
import { api } from '../lib/client'
import { ROOM_SKILL_EVENT_TYPES } from '../lib/room-events'
import { wsClient, type WsMessage } from '../lib/ws'
import { formatRelativeTime } from '../utils/time'
import { AutoModeLockModal, AUTO_MODE_LOCKED_BUTTON_CLASS, modeAwareButtonClass, useAutonomyControlGate } from './AutonomyControlGate'
import type { Skill } from '@shared/types'

interface SkillsPanelProps {
  roomId: number | null
  autonomyMode: 'semi'
}

const TAG_LABELS: Record<string, string> = {
  ai: 'AI',
  agent: '智能体',
  agents: '智能体',
  analytics: '分析',
  analysis: '分析',
  android: 'Android',
  angular: 'Angular',
  api: 'API',
  app: '应用',
  apps: '应用',
  auth: '认证',
  automation: '自动化',
  best: '最佳',
  calendar: '日历',
  canvas: '画布',
  chat: '聊天',
  claude: 'Claude',
  cli: 'CLI',
  cloud: '云',
  cloudflare: 'Cloudflare',
  code: '代码',
  collaboration: '协作',
  components: '组件',
  config: '配置',
  context: '上下文',
  data: '数据',
  database: '数据库',
  db: '数据库',
  debug: '调试',
  debugging: '调试',
  deploy: '部署',
  deployment: '部署',
  design: '设计',
  docs: '文档',
  documents: '文档',
  email: '邮件',
  figma: 'Figma',
  frontend: '前端',
  github: 'GitHub',
  google: 'Google',
  graphql: 'GraphQL',
  guide: '指南',
  image: '图像',
  ios: 'iOS',
  javascript: 'JavaScript',
  js: 'JavaScript',
  marketing: '营销',
  mcp: 'MCP',
  mlops: 'MLOps',
  mobile: '移动端',
  model: '模型',
  mongodb: 'MongoDB',
  native: '原生',
  netlify: 'Netlify',
  next: 'Next.js',
  node: 'Node.js',
  n8n: 'n8n',
  operations: '运维',
  optimization: '优化',
  pdf: 'PDF',
  performance: '性能',
  postgres: 'Postgres',
  practices: '实践',
  product: '产品',
  prompt: '提示词',
  python: 'Python',
  react: 'React',
  redis: 'Redis',
  research: '研究',
  review: '审查',
  security: '安全',
  seo: 'SEO',
  serverless: 'Serverless',
  stripe: 'Stripe',
  specialized: '专业',
  supabase: 'Supabase',
  swiftui: 'SwiftUI',
  testing: '测试',
  terraform: 'Terraform',
  tools: '工具',
  ui: 'UI',
  validation: '校验',
  vercel: 'Vercel',
  video: '视频',
  web: 'Web',
  word: 'Word',
  workflow: '流程',
  workflows: '流程',
}

const TAG_STOPWORDS = new Set([
  'and', 'the', 'for', 'with', 'from', 'official', 'skills', 'skill', 'team', 'by', 'a', 'an', 'of', 'to', 'in', 'on',
])

type SkillPattern = 'tool-wrapper' | 'generator' | 'reviewer' | 'inversion' | 'pipeline' | 'catalog' | 'local'

const SKILL_PATTERN_LABELS: Record<SkillPattern, string> = {
  'tool-wrapper': '工具封装',
  generator: '生成器',
  reviewer: '审查器',
  inversion: '反转访谈',
  pipeline: '流水线',
  catalog: '索引',
  local: '本地沉淀',
}

const SKILL_PATTERN_SUMMARIES: Record<SkillPattern, string> = {
  'tool-wrapper': '按需加载某个工具、框架或平台的规则，让弟子临时成为该领域专家。',
  generator: '用模板和风格规则生成稳定结构的交付物，避免每次输出格式漂移。',
  reviewer: '按检查清单审查代码、内容、风险或交付物，并按严重程度给出结论。',
  inversion: '先由弟子采访用户澄清上下文，确认需求后再生成方案或开始执行。',
  pipeline: '强制按步骤推进复杂流程，每一步都有检查点，失败不能跳过。',
  catalog: '用于检索和匹配外部 Skill，具体执行前需要读取对应 SKILL.md 或本地化版本。',
  local: '由本地帮派或弟子沉淀的可复用经验，适合当前江湖直接调用。',
}

function originalCategory(skill: Skill): string {
  const match = skill.content.match(/^原始分类：(.+)$/m)
  return match?.[1]?.trim() || ''
}

function isImportedSkill(skill: Skill): boolean {
  return skill.content.includes('awesome-agent-skills')
    || (skill.activationContext ?? []).some(tag => tag === 'awesome-agent-skills' || tag === '功法索引' || tag === 'Skill 索引')
}

function displaySkillName(skill: Skill): string {
  return skill.name.replace(/^外部功法：/, '').replace(/^江湖功法索引：/, '藏经阁 Skill 索引：')
}

function skillCategory(skill: Skill): string {
  const text = [skill.name, skill.content, originalCategory(skill), ...(skill.activationContext ?? [])].join(' ').toLowerCase()
  if (/skill\s*索引|功法索引|awesome agent skills/.test(text)) return 'Skill 索引'
  if (!isImportedSkill(skill)) return skill.agentCreated ? '弟子沉淀' : '本地 Skill'
  if (/marketing|seo|sales|growth|content|email/.test(text)) return '营销增长'
  if (/workspace|gmail|calendar|docs|slides|sheets|slack|notion|productivity|collaboration|comms/.test(text)) return '办公协作'
  if (/figma|design|canvas|image|video|art|theme|remotion|three/.test(text)) return '设计多媒体'
  if (/database|postgres|mongodb|redis|qdrant|vector|clickhouse|data|analytics|warehouse/.test(text)) return '数据系统'
  if (/security|auth|compliance|risk|validation|vibesec|safety/.test(text)) return '安全合规'
  if (/context|prompt|memory|knowledge|rag/.test(text)) return '上下文工程'
  if (/automation|workflow|n8n|mcp|agent|voltagent|orchestrat|subagent/.test(text)) return '智能体自动化'
  if (/cloudflare|netlify|vercel|supabase|stripe|terraform|deploy|serverless|workers|edge|cloud|infrastructure/.test(text)) return '部署运维'
  if (/react|angular|vue|next|frontend|mobile|ios|android|swiftui|expo|node|python|javascript|typescript|code|testing|debug|github/.test(text)) return '开发测试'
  return '专业领域'
}

function tagLabel(tag: string): string {
  const normalized = tag.trim().toLowerCase()
  if (!normalized) return ''
  if (TAG_LABELS[normalized]) return TAG_LABELS[normalized]
  const phrase = normalized
    .replace(/best-practices/g, '最佳实践')
    .replace(/code-review/g, '代码审查')
    .replace(/prompt-engineering/g, '提示词工程')
    .replace(/webapp/g, 'Web 应用')
    .replace(/frontend/g, '前端')
    .replace(/testing/g, '测试')
    .replace(/design/g, '设计')
    .replace(/marketing/g, '营销')
    .replace(/automation/g, '自动化')
    .replace(/database/g, '数据库')
    .replace(/security/g, '安全')
    .replace(/research/g, '研究')
    .replace(/specialized/g, '专业')
    .replace(/domains/g, '领域')
    .replace(/model/g, '模型')
    .replace(/training/g, '训练')
    .replace(/inference/g, '推理')
    .replace(/optimization/g, '优化')
    .replace(/management/g, '管理')
    .replace(/manager/g, '管理')
    .replace(/frameworks/g, '框架')
    .replace(/framework/g, '框架')
    .replace(/documents/g, '文档')
    .replace(/[._-]+/g, ' ')
    .trim()
  if (/^[a-z0-9+# ]+$/.test(phrase)) return ''
  return phrase
}

function visibleTags(skill: Skill): string[] {
  const allowedLatin = /(AI|API|CLI|MCP|UI|Web|PDF|SEO|MLOps|React|Figma|Stripe|Claude|Vercel|Next\.js|Node\.js|JavaScript|TypeScript|Python|SwiftUI|Expo|Google|GitHub|GraphQL|Word|Postgres|MongoDB|Redis|Cloudflare|Netlify|Supabase|Terraform|Slack|n8n|shadcn)/i
  const labels = (skill.activationContext ?? [])
    .filter(tag => !TAG_STOPWORDS.has(tag.toLowerCase()) && !/^\d+$/.test(tag))
    .map(tagLabel)
    .filter(label => {
      if (!label) return false
      const lower = label.toLowerCase()
      if (lower.includes('skills') || lower.includes(' by ')) return false
      if (label.includes('re设计')) return false
      if (/[a-z]{3,}/.test(label) && !allowedLatin.test(label)) return false
      return true
    })
  return [...new Set(labels)].slice(0, 8)
}

function skillPreview(skill: Skill): string {
  const preview = skillSummary(skill).description || skill.content.trim()
  return `${preview.slice(0, 80)}${preview.length > 80 ? '...' : ''}`
}

function frontmatterBlock(content: string): string {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/)
  return match?.[1] ?? ''
}

function frontmatterField(content: string, key: string): string {
  const block = frontmatterBlock(content)
  if (!block) return ''
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = block.match(new RegExp(`^\\s*${escaped}\\s*:\\s*["']?([^"'\n]+)["']?\\s*$`, 'mi'))
  return match?.[1]?.trim() ?? ''
}

function sectionBody(content: string, headings: string[]): string {
  const lines = content.split(/\r?\n/)
  let start = -1
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].replace(/^#+\s*/, '').trim()
    if (headings.some(heading => line === heading || line.includes(heading))) {
      start = i + 1
      break
    }
  }
  if (start === -1) return ''
  const body: string[] = []
  for (let i = start; i < lines.length; i += 1) {
    if (/^##+\s+/.test(lines[i])) break
    body.push(lines[i])
  }
  return body.join('\n').trim()
}

function firstReadableLine(value: string): string {
  return value
    .split(/\r?\n/)
    .map(line => line.replace(/^[-*\d.\s]+/, '').trim())
    .filter(line =>
      line &&
      !line.startsWith('---') &&
      !line.startsWith('name:') &&
      !line.startsWith('description:') &&
      !line.startsWith('metadata:') &&
      !line.startsWith('pattern:') &&
      !line.startsWith('source') &&
      !line.startsWith('来源：') &&
      !line.startsWith('来源链接：') &&
      !line.startsWith('技能链接：') &&
      !line.startsWith('原始名称：') &&
      !line.startsWith('原始分类：') &&
      !line.startsWith('##')
    )[0] ?? ''
}

function cleanSkillText(value: string, max = 220): string {
  const text = value
    .replace(/```[\s\S]*?```/g, '')
    .replace(/\[[^\]]+\]\([^)]+\)/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return ''
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function skillPattern(skill: Skill): SkillPattern {
  const metadataPattern = frontmatterField(skill.content, 'pattern').toLowerCase()
  if (metadataPattern === 'tool-wrapper' || metadataPattern === 'generator' || metadataPattern === 'reviewer' || metadataPattern === 'inversion' || metadataPattern === 'pipeline') {
    return metadataPattern
  }
  const text = [skill.name, skill.content, originalCategory(skill), ...(skill.activationContext ?? [])].join(' ').toLowerCase()
  const indexText = [skill.name, originalCategory(skill), ...(skill.activationContext ?? [])].join(' ').toLowerCase()
  if (/skill\s*索引|功法索引|catalog/.test(indexText)) return 'catalog'
  if (/review|审查|audit|安全|checklist|quality|风险|验收/.test(text)) return 'reviewer'
  if (/template|模板|generate|generator|report|docx|pptx|xlsx|pdf|slides|文档|报告|生成/.test(text)) return 'generator'
  if (/interview|clarif|requirements|需求|澄清|访谈|planner|plan-template/.test(text)) return 'inversion'
  if (/pipeline|workflow|steps|checkpoint|流水线|阶段|不得跳过|按顺序/.test(text)) return 'pipeline'
  if (skill.agentCreated) return 'local'
  return 'tool-wrapper'
}

function skillStructure(skill: Skill): Array<{ name: string; state: string; description: string }> {
  const text = skill.content.toLowerCase()
  const hasReferences = /references\/|review-checklist|style-guide|conventions|参考/.test(text)
  const hasScripts = /scripts\/|script|可执行脚本|npx |python |node /.test(text)
  const hasAssets = /assets\/|template|模板|素材|资源/.test(text)
  return [
    { name: 'SKILL.md', state: '必需', description: '保存触发说明、执行流程、边界和元数据。' },
    { name: 'references/', state: hasReferences ? '已用到' : '可选', description: '存放规范、清单、知识库和详细参考资料。' },
    { name: 'scripts/', state: hasScripts ? '已用到' : '可选', description: '存放可复用脚本；需要安全审查后再执行。' },
    { name: 'assets/', state: hasAssets ? '已用到' : '可选', description: '存放模板、样例、图片或固定输出结构。' },
  ]
}

function skillSummary(skill: Skill): {
  description: string
  usage: string
  trigger: string
  boundary: string
  pattern: SkillPattern
  layout: Array<{ name: string; state: string; description: string }>
} {
  const description = cleanSkillText(
    frontmatterField(skill.content, 'description') ||
    sectionBody(skill.content, ['适用场景', '用途', 'Overview', '简介']) ||
    firstReadableLine(skill.content),
    240
  ) || '这是一条可由弟子按需加载的藏经阁 Skill。'
  const usage = cleanSkillText(
    sectionBody(skill.content, ['调用方式', '使用流程', '执行步骤', 'How to use', 'Usage']) ||
    '触发场景匹配后，弟子先读取 SKILL.md，再按其中流程决定是否加载 references、scripts 或 assets。',
    260
  )
  const trigger = (skill.activationContext ?? []).length > 0
    ? visibleTags(skill).join('、') || (skill.activationContext ?? []).slice(0, 8).join('、')
    : '未设置触发词，只有自动启用时才会作为通用 Skill 加载。'
  const boundary = cleanSkillText(
    sectionBody(skill.content, ['边界', '江湖约束', '安全', '禁忌', 'Limitations']) ||
    '只在任务确实匹配时加载；涉及外部账号、付费、密钥、联网写入或脚本执行时，必须先走确认和审计流程。',
    260
  )
  return {
    description,
    usage,
    trigger,
    boundary,
    pattern: skillPattern(skill),
    layout: skillStructure(skill),
  }
}

export function SkillsPanel({ roomId, autonomyMode }: SkillsPanelProps): React.JSX.Element {
  const { semi, guard, showLockModal, closeLockModal, requestSemiMode } = useAutonomyControlGate(autonomyMode)

  const { data: skills, refresh } = usePolling<Skill[]>(
    () => api.skills.list(roomId ?? undefined),
    30000
  )

  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null)
  const [containerRef, containerWidth] = useContainerWidth<HTMLDivElement>()
  const isWide = containerWidth > 500

  // Create form state (always declared — React hooks rule)
  const [createName, setCreateName] = useState('')
  const [createContent, setCreateContent] = useState('')
  const [createContexts, setCreateContexts] = useState('')
  const [createAutoActivate, setCreateAutoActivate] = useState(false)
  const [search, setSearch] = useState('')
  const [activeCategory, setActiveCategory] = useState('全部')

  const categoryOptions = useMemo(() => {
    const counts = new Map<string, number>()
    for (const skill of skills ?? []) {
      const category = skillCategory(skill)
      counts.set(category, (counts.get(category) ?? 0) + 1)
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name, count]) => ({ name, count }))
  }, [skills])

  const filteredSkills = useMemo(() => {
    const q = search.trim().toLowerCase()
    return (skills ?? []).filter(skill => {
      const category = skillCategory(skill)
      if (activeCategory !== '全部' && category !== activeCategory) return false
      if (!q) return true
      const haystack = [
        displaySkillName(skill),
        skill.name,
        skill.content,
        category,
        ...visibleTags(skill),
        ...(skill.activationContext ?? []),
      ].join(' ').toLowerCase()
      return haystack.includes(q)
    })
  }, [skills, search, activeCategory])

  const visibleSkills = useMemo(() => filteredSkills.slice(0, 120), [filteredSkills])
  const hiddenCount = Math.max(0, filteredSkills.length - visibleSkills.length)

  useEffect(() => {
    if (!roomId) return
    return wsClient.subscribe(`room:${roomId}`, (event: WsMessage) => {
      if (ROOM_SKILL_EVENT_TYPES.has(event.type)) {
        void refresh()
      }
    })
  }, [refresh, roomId])

  async function handleCreate(): Promise<void> {
    if (!roomId || !createName.trim() || !createContent.trim()) return
    const contexts = createContexts.trim()
      ? createContexts.split(',').map(s => s.trim()).filter(Boolean)
      : null
    await api.skills.create({
      name: createName.trim(),
      content: createContent.trim(),
      activationContext: contexts,
      autoActivate: createAutoActivate,
      roomId: roomId ?? undefined,
    })
    setCreateName('')
    setCreateContent('')
    setCreateContexts('')
    setCreateAutoActivate(false)
    setShowCreate(false)
    refresh()
  }

  async function handleToggleAutoActivate(skill: Skill): Promise<void> {
    await api.skills.update(skill.id, { autoActivate: !skill.autoActivate })
    refresh()
  }

  async function handleDelete(skillId: number): Promise<void> {
    if (confirmDeleteId !== skillId) {
      setConfirmDeleteId(skillId)
      return
    }
    await api.skills.delete(skillId)
    if (expandedId === skillId) setExpandedId(null)
    setConfirmDeleteId(null)
    refresh()
  }

  return (
    <div className="flex flex-col h-full" ref={containerRef}>
      <div className="px-4 py-2 border-b border-border-primary flex items-center gap-2 flex-wrap">
        <h2 className="text-base font-semibold text-text-primary">藏经阁</h2>
        <span className="text-xs text-text-muted">
          {skills ? `${skills.length} 个 Skill` : '加载中...'}
        </span>
        {roomId ? (
          <button
            onClick={() => guard(() => setShowCreate(!showCreate))}
            className={`text-xs px-2.5 py-1.5 rounded-lg ${modeAwareButtonClass(semi, 'bg-interactive text-text-invert hover:bg-interactive-hover')}`}
          >
            {showCreate ? '取消' : '+ 新建 Skill'}
          </button>
        ) : (
          <span className="text-xs text-text-muted">公共 Skill 库 · 进入临时帮派后可沉淀本地 Skill</span>
        )}
      </div>

      {(skills ?? []).length > 24 && (
        <div className="px-4 py-2 border-b border-border-primary bg-surface-primary space-y-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索 Skill、分类、中文标签，例如 文档、营销、React、审查器"
            className="w-full px-2.5 py-1.5 text-sm border border-border-primary rounded-lg focus:outline-none focus:border-text-muted bg-surface-secondary text-text-primary placeholder:text-text-muted"
          />
          <div className="flex flex-wrap gap-1.5">
            <button
              onClick={() => setActiveCategory('全部')}
              className={`px-2 py-1 rounded-lg text-xs border transition-colors ${
                activeCategory === '全部'
                  ? 'bg-interactive-bg text-interactive border-interactive-bg'
                  : 'bg-surface-secondary text-text-muted border-border-primary hover:text-text-secondary'
              }`}
            >
              全部 {skills?.length ?? 0}
            </button>
            {categoryOptions.map(category => (
              <button
                key={category.name}
                onClick={() => setActiveCategory(category.name)}
                className={`px-2 py-1 rounded-lg text-xs border transition-colors ${
                  activeCategory === category.name
                    ? 'bg-interactive-bg text-interactive border-interactive-bg'
                    : 'bg-surface-secondary text-text-muted border-border-primary hover:text-text-secondary'
                }`}
              >
                {category.name} {category.count}
              </button>
            ))}
          </div>
          {hiddenCount > 0 && (
            <div className="pt-1 text-[11px] text-text-muted">
              已显示 {visibleSkills.length} 个，继续输入关键词可缩小范围；还有 {hiddenCount} 个未显示但仍可被弟子按需调用。
            </div>
          )}
        </div>
      )}

      {semi && showCreate && (
        <div className="p-4 border-b-2 border-border-primary bg-surface-secondary space-y-2">
          <input
            placeholder="Skill 名称，例如：market-research-skill"
            value={createName}
            onChange={(e) => setCreateName(e.target.value)}
            className="w-full px-2.5 py-1.5 text-sm border border-border-primary rounded-lg focus:outline-none focus:border-text-muted bg-surface-primary text-text-primary placeholder:text-text-muted"
          />
          <textarea
            placeholder={'SKILL.md 内容：建议包含 frontmatter、触发场景、执行步骤、验收标准、可选 references/scripts/assets 说明。'}
            value={createContent}
            onChange={(e) => setCreateContent(e.target.value)}
            rows={4}
            className="w-full px-2.5 py-1.5 text-sm border border-border-primary rounded-lg focus:outline-none focus:border-text-muted bg-surface-primary text-text-primary placeholder:text-text-muted resize-y font-mono"
          />
          <input
            placeholder="触发词，用逗号分隔，例如 市场调研, 评论分析, reviewer"
            value={createContexts}
            onChange={(e) => setCreateContexts(e.target.value)}
            className="w-full px-2.5 py-1.5 text-sm border border-border-primary rounded-lg focus:outline-none focus:border-text-muted bg-surface-primary text-text-primary placeholder:text-text-muted"
          />
          <div className="flex gap-2 items-center">
            <label className="flex items-center gap-2 text-sm text-text-secondary cursor-pointer shrink-0">
              <input
                type="checkbox"
                checked={createAutoActivate}
                onChange={(e) => setCreateAutoActivate(e.target.checked)}
                className="rounded-lg border-border-primary"
              />
              自动启用
            </label>
            <button
              onClick={handleCreate}
              disabled={!createName.trim() || !createContent.trim()}
              className="text-sm bg-interactive text-text-invert px-4 py-2 rounded-lg hover:bg-interactive-hover disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
            >
              保存 Skill
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {filteredSkills.length === 0 && skills ? (
          <div className="p-4 text-sm text-text-muted">
            {search.trim() ? '没有匹配的 Skill。换一个关键词试试。' : (semi ? '暂无 Skill。创建一个 Skill 以开始沉淀能力。' : '暂无 Skill。Skill 由天机阁或弟子自动沉淀。')}
          </div>
        ) : (
          <div className={`grid gap-2 p-3 ${isWide ? 'grid-cols-2' : 'grid-cols-1'}`}>
            {visibleSkills.map(skill => (
              <SkillCard
                key={skill.id}
                skill={skill}
                category={skillCategory(skill)}
                tags={visibleTags(skill)}
                expanded={expandedId === skill.id}
                semi={semi}
                confirmDelete={confirmDeleteId === skill.id}
                onToggle={() => setExpandedId(expandedId === skill.id ? null : skill.id)}
                onToggleAutoActivate={() => handleToggleAutoActivate(skill)}
                onDelete={() => handleDelete(skill.id)}
                onBlurDelete={() => setConfirmDeleteId(null)}
                onLockedControl={requestSemiMode}
              />
            ))}
          </div>
        )}
      </div>
      <AutoModeLockModal open={showLockModal} onClose={closeLockModal} />
    </div>
  )
}

interface SkillCardProps {
  skill: Skill
  category: string
  tags: string[]
  expanded: boolean
  semi: boolean
  confirmDelete: boolean
  onToggle: () => void
  onToggleAutoActivate: () => void
  onDelete: () => void
  onBlurDelete: () => void
  onLockedControl: () => void
}

function SkillCard({ skill, category, tags, expanded, semi, confirmDelete, onToggle, onToggleAutoActivate, onDelete, onBlurDelete, onLockedControl }: SkillCardProps): React.JSX.Element {
  const summary = skillSummary(skill)
  return (
    <div className="bg-surface-secondary border border-border-primary rounded-lg overflow-hidden">
      <div
        className="flex items-center gap-2 px-3 py-2 hover:bg-surface-hover cursor-pointer"
        onClick={onToggle}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-text-primary">{displaySkillName(skill)}</span>
            <span className="px-1.5 py-0.5 rounded-lg text-xs font-medium bg-surface-tertiary text-text-secondary">{category}</span>
            <span className="px-1.5 py-0.5 rounded-lg text-xs font-medium bg-interactive-bg text-interactive">{SKILL_PATTERN_LABELS[summary.pattern]}</span>
            {skill.agentCreated && (
              <span className="px-1.5 py-0.5 rounded-lg text-xs font-medium bg-status-info-bg text-status-info">弟子沉淀</span>
            )}
            {skill.autoActivate && (
              <span className="px-1.5 py-0.5 rounded-lg text-xs font-medium bg-status-success-bg text-status-success">自动启用</span>
            )}
            <span className="text-xs text-text-muted">v{skill.version}</span>
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-xs text-text-muted truncate max-w-[460px]">
              {skillPreview(skill)}
            </span>
          </div>
          {tags.length > 0 && (
            <div className="flex gap-1 mt-1 flex-wrap">
              {tags.map((ctx, i) => (
                <span key={i} className="px-1.5 py-0.5 rounded-lg text-xs bg-interactive-bg text-interactive border border-interactive-bg">
                  {ctx}
                </span>
              ))}
            </div>
          )}
        </div>
        <span className="text-sm text-text-muted">{expanded ? '\u25BC' : '\u25B6'}</span>
      </div>

      {expanded && (
        <div className="px-3 pb-3 pt-2 border-t border-border-primary bg-surface-secondary space-y-3">
          <div className="grid gap-2 md:grid-cols-2">
            <div className="rounded-lg bg-surface-primary border border-border-primary p-3">
              <div className="text-xs font-semibold text-text-muted">大致介绍</div>
              <div className="mt-1 text-sm leading-6 text-text-secondary">{summary.description}</div>
            </div>
            <div className="rounded-lg bg-surface-primary border border-border-primary p-3">
              <div className="text-xs font-semibold text-text-muted">设计模式</div>
              <div className="mt-1 text-sm font-medium text-text-primary">{SKILL_PATTERN_LABELS[summary.pattern]}</div>
              <div className="mt-1 text-xs leading-5 text-text-muted">{SKILL_PATTERN_SUMMARIES[summary.pattern]}</div>
            </div>
          </div>

          <div className="grid gap-2 md:grid-cols-2">
            <div className="rounded-lg bg-surface-primary border border-border-primary p-3">
              <div className="text-xs font-semibold text-text-muted">触发方式</div>
              <div className="mt-1 text-sm leading-6 text-text-secondary">{summary.trigger}</div>
            </div>
            <div className="rounded-lg bg-surface-primary border border-border-primary p-3">
              <div className="text-xs font-semibold text-text-muted">使用配置</div>
              <div className="mt-1 text-sm leading-6 text-text-secondary">{summary.usage}</div>
            </div>
          </div>

          <div className="rounded-lg bg-surface-primary border border-border-primary p-3">
            <div className="text-xs font-semibold text-text-muted">Skill 目录结构</div>
            <div className="mt-2 grid gap-2 md:grid-cols-4">
              {summary.layout.map(item => (
                <div key={item.name} className="rounded-lg bg-surface-secondary px-2.5 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-text-primary">{item.name}</span>
                    <span className="text-[11px] text-text-muted">{item.state}</span>
                  </div>
                  <div className="mt-1 text-[11px] leading-4 text-text-muted">{item.description}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-lg bg-surface-primary border border-border-primary p-3">
            <div className="text-xs font-semibold text-text-muted">调用边界</div>
            <div className="mt-1 text-sm leading-6 text-text-secondary">{summary.boundary}</div>
          </div>

          <div className="flex items-center gap-2">
            {semi ? (
              <label className="flex items-center gap-2 text-sm text-text-secondary cursor-pointer">
                <input
                  type="checkbox"
                  checked={skill.autoActivate}
                  onChange={onToggleAutoActivate}
                  className="rounded-lg border-border-primary"
                />
                自动启用
              </label>
            ) : (
              <button
                onClick={onLockedControl}
                className={`text-xs px-2.5 py-1.5 rounded-lg ${AUTO_MODE_LOCKED_BUTTON_CLASS}`}
              >
                {skill.autoActivate ? '禁用自动激活' : '启用自动激活'}
              </button>
            )}
            <div className="flex-1" />
            <span className="text-xs text-text-muted">{formatRelativeTime(skill.updatedAt)}</span>
            {semi ? (
              <button
                onClick={onDelete}
                onBlur={onBlurDelete}
                className="text-xs px-2.5 py-1.5 rounded-lg border border-red-200 text-status-error hover:text-red-600"
              >
                {confirmDelete ? '确认删除？' : '删除'}
              </button>
            ) : (
              <button
                onClick={onLockedControl}
                className={`text-xs px-2.5 py-1.5 rounded-lg ${AUTO_MODE_LOCKED_BUTTON_CLASS}`}
              >
                删除
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
