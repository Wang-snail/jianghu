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

function originalCategory(skill: Skill): string {
  const match = skill.content.match(/^原始分类：(.+)$/m)
  return match?.[1]?.trim() || ''
}

function skillCategory(skill: Skill): string {
  const text = [skill.name, skill.content, originalCategory(skill), ...(skill.activationContext ?? [])].join(' ').toLowerCase()
  if (skill.name === '江湖功法索引：Awesome Agent Skills') return '功法索引'
  if (!skill.name.startsWith('外部功法：')) return skill.agentCreated ? '弟子沉淀' : '本地功法'
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
  const lines = skill.content
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line =>
      line &&
      !line.startsWith('来源：') &&
      !line.startsWith('来源链接：') &&
      !line.startsWith('技能链接：') &&
      !line.startsWith('原始名称：') &&
      !line.startsWith('原始分类：') &&
      !line.startsWith('##')
    )
  const preview = lines[0] || skill.content.trim()
  return `${preview.slice(0, 80)}${preview.length > 80 ? '...' : ''}`
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
          {skills ? `${skills.length} 门功法` : '加载中...'}
        </span>
        {roomId ? (
          <button
            onClick={() => guard(() => setShowCreate(!showCreate))}
            className={`text-xs px-2.5 py-1.5 rounded-lg ${modeAwareButtonClass(semi, 'bg-interactive text-text-invert hover:bg-interactive-hover')}`}
          >
            {showCreate ? '取消' : '+ 新建功法'}
          </button>
        ) : (
          <span className="text-xs text-text-muted">公共技能库 · 进入临时帮派后可新增本地功法</span>
        )}
      </div>

      {(skills ?? []).length > 24 && (
        <div className="px-4 py-2 border-b border-border-primary bg-surface-primary space-y-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索功法、分类、中文标签，例如 文档、营销、React、钱庄"
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
              已显示 {visibleSkills.length} 门，继续输入关键词可缩小范围；还有 {hiddenCount} 门未显示但仍可被弟子自动调用。
            </div>
          )}
        </div>
      )}

      {semi && showCreate && (
        <div className="p-4 border-b-2 border-border-primary bg-surface-secondary space-y-2">
          <input
            placeholder="功法名称，例如：千机推演录"
            value={createName}
            onChange={(e) => setCreateName(e.target.value)}
            className="w-full px-2.5 py-1.5 text-sm border border-border-primary rounded-lg focus:outline-none focus:border-text-muted bg-surface-primary text-text-primary placeholder:text-text-muted"
          />
          <textarea
            placeholder="功法内容：触发场景、执行步骤、验收标准、禁忌和复盘方式。"
            value={createContent}
            onChange={(e) => setCreateContent(e.target.value)}
            rows={4}
            className="w-full px-2.5 py-1.5 text-sm border border-border-primary rounded-lg focus:outline-none focus:border-text-muted bg-surface-primary text-text-primary placeholder:text-text-muted resize-y font-mono"
          />
          <input
            placeholder="触发场景，用逗号分隔，可选"
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
              创建功法
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {filteredSkills.length === 0 && skills ? (
          <div className="p-4 text-sm text-text-muted">
            {search.trim() ? '没有匹配的功法。换一个关键词试试。' : (semi ? '暂无功法。创建一门功法以开始沉淀能力。' : '暂无功法。功法由天机阁或弟子自动沉淀。')}
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
  return (
    <div className="bg-surface-secondary border border-border-primary rounded-lg overflow-hidden">
      <div
        className="flex items-center gap-2 px-3 py-2 hover:bg-surface-hover cursor-pointer"
        onClick={onToggle}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-text-primary">{skill.name}</span>
            <span className="px-1.5 py-0.5 rounded-lg text-xs font-medium bg-surface-tertiary text-text-secondary">{category}</span>
            {skill.agentCreated && (
              <span className="px-1.5 py-0.5 rounded-lg text-xs font-medium bg-status-info-bg text-status-info">弟子沉淀</span>
            )}
            {skill.autoActivate && (
              <span className="px-1.5 py-0.5 rounded-lg text-xs font-medium bg-status-success-bg text-status-success">自动启用</span>
            )}
            <span className="text-xs text-text-muted">v{skill.version}</span>
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-xs text-text-muted truncate max-w-[200px]">
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
        <div className="px-3 pb-3 pt-2 border-t border-border-primary bg-surface-secondary space-y-2">
          <pre className="text-xs text-text-secondary bg-surface-primary border border-border-primary rounded-lg p-3 overflow-x-auto whitespace-pre-wrap font-mono max-h-[200px] overflow-y-auto">
            {skill.content}
          </pre>
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
