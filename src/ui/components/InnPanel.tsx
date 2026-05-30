import { WORKER_TEMPLATES, type WorkerTemplatePreset } from '@shared/worker-templates'
import { usePolling } from '../hooks/usePolling'
import { api } from '../lib/client'
import type { Worker } from '@shared/types'
import { isAssignableWorker, isInnWorker } from '@shared/worker-roles'

function templateSkills(t: WorkerTemplatePreset): string[] {
  const match = t.systemPrompt.match(/默认功法方向：\n- ([^\n]+)/)
  return match ? match[1].split('、').map(s => s.trim()).filter(Boolean) : []
}

const FIELD_KEYWORDS: Array<[string, string[]]> = [
  ['市场分析', ['市场', '增长', '销售', 'SEO', '电商', '商业', '运营']],
  ['评论分析', ['评论', '舆情', '用户', '痛点', '客户']],
  ['数据清洗', ['数据', '清洗', 'ETL', '仓库', '分析']],
  ['ROI 测算', ['成本', '预算', 'ROI', '财务', '金算盘']],
  ['风险识别', ['风险', '安全', '合规', '审查', '护法']],
  ['工程实现', ['工程', '代码', 'API', '自动化', '测试']],
  ['文案表达', ['文案', '写作', '报告', '沟通', '书记']],
  ['视觉设计', ['设计', '视觉', '体验', '界面']],
]

function scoreFor(seed: string, offset: number): number {
  let hash = offset * 17
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) % 997
  return 45 + (hash % 46)
}

function dossierFields(worker: Worker): Array<[string, number]> {
  const text = [worker.name, worker.role ?? '', worker.description ?? '', worker.systemPrompt].join(' ')
  const matched = FIELD_KEYWORDS
    .map(([field, keywords], i) => {
      const hit = keywords.some(keyword => text.includes(keyword))
      return [field, Math.min(96, scoreFor(worker.name + field, i) + (hit ? 14 : 0))] as [string, number]
    })
    .sort((a, b) => b[1] - a[1])
  return matched.slice(0, 3)
}

function weakFields(worker: Worker): string[] {
  const strong = new Set(dossierFields(worker).map(([field]) => field))
  return FIELD_KEYWORDS.map(([field]) => field).filter(field => !strong.has(field)).slice(-2)
}

function statusLabel(worker: Worker): string {
  if (worker.agentState === 'thinking' || worker.agentState === 'acting' || worker.agentState === 'voting') return '执行中'
  if (worker.agentState === 'blocked' || worker.agentState === 'rate_limited') return '限制接单'
  return '空闲'
}

function stability(worker: Worker): number {
  const penalty = Math.min(24, worker.votesMissed * 3)
  return Math.max(45, 88 - penalty + Math.min(8, worker.taskCount))
}

function collaboration(worker: Worker): number {
  return Math.max(45, 72 + Math.min(16, worker.votesCast * 2) - Math.min(12, worker.votesMissed * 2))
}

function costEfficiency(worker: Worker): number {
  const cyclePenalty = worker.cycleGapMs ? Math.min(12, Math.floor(worker.cycleGapMs / 60_000)) : 0
  return Math.max(45, 82 - cyclePenalty + (worker.maxTurns ? Math.min(8, 10 - Math.min(worker.maxTurns, 10)) : 4))
}

function maturityLevel(worker: Worker): { label: string; note: string; color: string } {
  const bestField = dossierFields(worker)[0]?.[1] ?? 45
  const score = Math.round((bestField + stability(worker) + collaboration(worker) + costEfficiency(worker)) / 4)
  if (score >= 88 && worker.taskCount >= 12) {
    return {
      label: '宗师弟子',
      note: '可被天机处候选为帮主，仍需验收记录支持。',
      color: 'bg-status-success-bg text-status-success',
    }
  }
  if (score >= 78 && worker.taskCount >= 6) {
    return {
      label: '老成弟子',
      note: '可承担关键子任务，并协助审核下游输出。',
      color: 'bg-interactive-bg text-interactive',
    }
  }
  if (score >= 66 && worker.taskCount >= 2) {
    return {
      label: '熟手弟子',
      note: '可独立执行标准子任务，异常时交由帮主复核。',
      color: 'bg-status-info-bg text-status-info',
    }
  }
  return {
    label: '新晋弟子',
    note: '只接简单子任务，输出必须经帮主审核。',
    color: 'bg-status-warning-bg text-status-warning',
  }
}

export function InnPanel(): React.JSX.Element {
  const { data: workers } = usePolling<Worker[]>(() => api.workers.list().catch(() => []), 30000)
  const activeWorkers = (workers ?? []).filter(worker => isInnWorker(worker))
  const recruitableTemplates = WORKER_TEMPLATES.filter(t => isAssignableWorker({
    id: 0,
    name: t.name,
    role: t.role,
    isDefault: false,
  }))

  return (
    <div className="h-full overflow-y-auto">
      <div className="border-b border-border-primary bg-surface-primary px-4 py-3">
        <div className="text-lg font-semibold text-text-primary">客栈</div>
        <div className="mt-1 text-sm text-text-muted">
          江湖公共人才市场，不属于任何帮派。帮主按任务需求在这里查看弟子履历、领域声望、稳定度和成本效率。
        </div>
      </div>

      <div className="grid gap-3 p-4 md:grid-cols-3">
        <div className="rounded-lg border border-border-primary bg-surface-secondary p-3">
          <div className="text-xs text-text-muted">在册弟子</div>
          <div className="mt-1 text-2xl font-semibold text-text-primary">{activeWorkers.length}</div>
          <div className="mt-1 text-xs text-text-muted">有履历和任务记录</div>
        </div>
        <div className="rounded-lg border border-border-primary bg-surface-secondary p-3">
          <div className="text-xs text-text-muted">可招募弟子</div>
          <div className="mt-1 text-2xl font-semibold text-text-primary">{recruitableTemplates.length}</div>
          <div className="mt-1 text-xs text-text-muted">候选画像，可派入临时帮派</div>
        </div>
        <div className="rounded-lg border border-border-primary bg-surface-secondary p-3">
          <div className="text-xs text-text-muted">功法方向</div>
          <div className="mt-1 text-2xl font-semibold text-text-primary">
            {new Set(recruitableTemplates.flatMap(templateSkills)).size}
          </div>
          <div className="mt-1 text-xs text-text-muted">映射真实 AI 能力模块</div>
        </div>
      </div>

      <div className="px-4 pb-4">
        <div className="mb-3">
          <div className="text-sm font-semibold text-text-primary">江湖履历</div>
          <div className="text-xs text-text-muted">不看单一声望，按领域声望、稳定度、协作度、成本效率和近期任务记录判断适配度。</div>
        </div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 mb-5">
          {activeWorkers.length === 0 && (
            <div className="rounded-lg border border-border-primary bg-surface-secondary p-4 text-sm text-text-muted md:col-span-2 xl:col-span-3">
              暂无在册弟子。临时帮派成立后，帮主可从下方候选画像中挑选弟子入局。
            </div>
          )}
          {activeWorkers.map(worker => (
            <div key={worker.id} className="rounded-lg border border-border-primary bg-surface-secondary p-3">
              {(() => {
                const maturity = maturityLevel(worker)
                return (
                  <>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-text-primary">{worker.name}</div>
                        <div className="text-xs text-text-muted">{worker.role || '通用弟子'} · {statusLabel(worker)}</div>
                      </div>
                      <span className="shrink-0 rounded bg-surface-tertiary px-1.5 py-0.5 text-[11px] text-text-secondary">
                        客栈候选
                      </span>
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-2 rounded bg-surface-primary px-2 py-1">
                      <span className={`rounded px-1.5 py-0.5 text-[11px] ${maturity.color}`}>{maturity.label}</span>
                      <span className="text-[11px] text-text-muted">按履历匹配</span>
                    </div>
                    <div className="mt-1 text-[11px] text-text-muted">{maturity.note}</div>
                  </>
                )
              })()}
              <div className="mt-3 space-y-1.5">
                {dossierFields(worker).map(([field, score]) => (
                  <div key={field}>
                    <div className="mb-0.5 flex justify-between text-[11px] text-text-muted">
                      <span>{field}</span>
                      <span>{score}</span>
                    </div>
                    <div className="h-1.5 rounded bg-surface-primary">
                      <div className="h-1.5 rounded bg-interactive" style={{ width: `${score}%` }} />
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-3 grid grid-cols-3 gap-1 text-center text-[11px]">
                <div className="rounded bg-surface-primary px-1 py-1 text-text-secondary">稳定 {stability(worker)}</div>
                <div className="rounded bg-surface-primary px-1 py-1 text-text-secondary">协作 {collaboration(worker)}</div>
                <div className="rounded bg-surface-primary px-1 py-1 text-text-secondary">效率 {costEfficiency(worker)}</div>
              </div>
              <div className="mt-2 text-xs text-text-muted">
                履历：完成镖单 {worker.taskCount} 次 · 参与议事 {worker.votesCast} 次 · 缺席 {worker.votesMissed} 次
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                <span className="rounded bg-status-success-bg px-1.5 py-0.5 text-[11px] text-status-success">适合结构化任务</span>
                {weakFields(worker).map(field => (
                  <span key={field} className="rounded bg-surface-primary px-1.5 py-0.5 text-[11px] text-text-muted">不优先：{field}</span>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="mb-5 rounded-lg border border-border-primary bg-surface-secondary p-3">
          <div className="text-sm font-semibold text-text-primary">弟子成长</div>
          <div className="mt-1 text-xs text-text-muted">
            弟子不会只靠单一声望接任务；领域履历、稳定度、协作度、成本效率和任务次数共同决定可接任务范围。
          </div>
          <div className="mt-3 grid gap-2 md:grid-cols-4">
            {[
              ['新晋弟子', '只接简单子任务，必须帮主审核。'],
              ['熟手弟子', '可独立执行标准子任务。'],
              ['老成弟子', '可负责关键子任务和输出复核。'],
              ['宗师弟子', '可被天机处候选为帮主。'],
            ].map(([label, note]) => (
              <div key={label} className="rounded bg-surface-primary p-2">
                <div className="text-xs font-semibold text-text-secondary">{label}</div>
                <div className="mt-1 text-[11px] text-text-muted">{note}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="mb-2 flex items-center justify-between gap-2">
          <div>
            <div className="text-sm font-semibold text-text-primary">候选画像</div>
            <div className="text-xs text-text-muted">帮主提交任务需求单后，客栈按领域和成本推荐候选弟子。</div>
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {recruitableTemplates.map((t) => (
            <div key={t.name} className="rounded-lg border border-border-primary bg-surface-secondary p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-text-primary">{t.name}</div>
                  <div className="text-xs text-interactive">{t.role}</div>
                </div>
                <span className="shrink-0 rounded bg-interactive-bg px-1.5 py-0.5 text-[11px] text-interactive">候选弟子</span>
              </div>
              <div className="mt-2 text-xs text-text-secondary">
                <span className="text-text-muted">岗位能力：</span>{t.description}
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                {templateSkills(t).map(skill => (
                  <span key={skill} className="rounded bg-surface-tertiary px-1.5 py-0.5 text-[11px] text-text-secondary">
                    {skill}
                  </span>
                ))}
              </div>
              <details className="mt-2 text-xs text-text-muted">
                <summary className="cursor-pointer hover:text-text-secondary">查看中文提示词</summary>
                <pre className="mt-2 max-h-44 overflow-y-auto whitespace-pre-wrap rounded border border-border-primary bg-surface-primary p-2 font-mono text-[11px] text-text-secondary">
                  {t.systemPrompt}
                </pre>
              </details>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
