import { useMemo, useRef, useState } from 'react'
import { api } from '../lib/client'
import type { Room } from '@shared/types'

type ClarifierStage = 'chat' | 'review'
type MessageSpeaker = 'agent' | 'user'

interface ClarifierMessage {
  id: number
  speaker: MessageSpeaker
  content: string
}

interface RequirementClarifierModalProps {
  onClose: () => void
  onCreate: (room: Room) => void | Promise<void>
}

const CLARIFIER_STEPS = [
  {
    key: 'rawNeed',
    label: '原始需求',
    question: '先写下你想让江湖完成什么。可以很粗糙，比如“帮我分析一个产品是否值得做”。',
  },
  {
    key: 'context',
    label: '背景',
    question: '这个需求的背景是什么？现在遇到的情况、机会或问题是什么？',
  },
  {
    key: 'deliverables',
    label: '交付物',
    question: '你希望最后拿到什么交付物？例如报告、方案、清单、代码、调研结论或执行计划。',
  },
  {
    key: 'materials',
    label: '资料',
    question: '你已经有哪些资料、链接、文件、数据或限制条件？没有也可以写“暂无”。',
  },
  {
    key: 'success',
    label: '验收标准',
    question: '什么结果算完成得好？请写清判断标准、必须包含的内容和不能接受的情况。',
  },
  {
    key: 'priority',
    label: '优先级',
    question: '有没有时间要求、预算偏好或优先级？例如快一点、质量优先、低成本优先。',
  },
] as const

type StepKey = typeof CLARIFIER_STEPS[number]['key']
type RequirementAnswers = Partial<Record<StepKey, string>>

function fallback(value: string | undefined, text = '待天机阁进一步确认'): string {
  const trimmed = value?.trim()
  return trimmed ? trimmed : text
}

function titleFromNeed(need: string | undefined): string {
  const text = fallback(need, '新委托')
    .replace(/[。！？!?\n\r]/g, ' ')
    .trim()
  return text.length > 24 ? `${text.slice(0, 24)}...` : text
}

function defaultRoomName(): string {
  return `jianghu${Date.now().toString().slice(-6)}`
}

function normalizeRoomName(value: string): string {
  const normalized = value.trim().replace(/\s+/g, '').toLowerCase()
  return normalized || defaultRoomName()
}

function buildRequirementDoc(answers: RequirementAnswers): string {
  const title = titleFromNeed(answers.rawNeed)
  return `# 需求文档：${title}

## 1. 原始委托
${fallback(answers.rawNeed)}

## 2. 背景与现状
${fallback(answers.context)}

## 3. 预期交付物
${fallback(answers.deliverables)}

## 4. 已有资料与约束
${fallback(answers.materials, '暂无明确资料或约束。')}

## 5. 验收标准
${fallback(answers.success)}

## 6. 时间、预算与优先级
${fallback(answers.priority, '默认质量与速度均衡，成本由钱庄按任务难度控制。')}

## 7. 给天机阁的处理建议
- 先判断任务类型、难度、风险和需要的弟子能力。
- 成立临时帮派，任命帮主，并从客栈挑选合适弟子。
- 从藏经阁领取必要功法，再向钱庄申请预算。
- 把任务拆成可验收镖单，执行中持续同步进展、阻塞和成本。
- 交付前由天机阁验收，必要时请锦衣卫复核风险。
`
}

export function RequirementClarifierModal({ onClose, onCreate }: RequirementClarifierModalProps): React.JSX.Element {
  const [stage, setStage] = useState<ClarifierStage>('chat')
  const [messages, setMessages] = useState<ClarifierMessage[]>([])
  const [answers, setAnswers] = useState<RequirementAnswers>({})
  const [currentStep, setCurrentStep] = useState(0)
  const [input, setInput] = useState('')
  const [documentText, setDocumentText] = useState('')
  const [roomName, setRoomName] = useState(defaultRoomName)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nextMessageId = useRef(1)

  const answeredCount = useMemo(() => {
    return CLARIFIER_STEPS.filter(step => answers[step.key]?.trim()).length
  }, [answers])

  const progressText = `${answeredCount}/${CLARIFIER_STEPS.length}`
  const canGenerate = Object.values(answers).some(value => value?.trim()) || input.trim().length > 0
  const activeStep = CLARIFIER_STEPS[currentStep]
  const activeAnswer = answers[activeStep.key]?.trim() ?? ''

  function appendMessage(speaker: MessageSpeaker, content: string): ClarifierMessage {
    const message = { id: nextMessageId.current, speaker, content }
    nextMessageId.current += 1
    return message
  }

  function generateDoc(nextAnswers: RequirementAnswers): void {
    const doc = buildRequirementDoc(nextAnswers)
    setDocumentText(doc)
    setStage('review')
    setMessages(prev => [
      ...prev,
      appendMessage('agent', '我已整理成需求文档。请在右侧检查，可以直接修改，确认无误后再交给天机阁。'),
    ])
  }

  function selectStep(index: number): void {
    const step = CLARIFIER_STEPS[index]
    setCurrentStep(index)
    setStage('chat')
    setInput(answers[step.key]?.trim() ?? '')
    setError(null)
  }

  function handleSend(): void {
    const trimmed = input.trim()
    if (!trimmed) return

    const step = CLARIFIER_STEPS[currentStep]
    const nextAnswers = { ...answers, [step.key]: trimmed }
    const nextMessages = [appendMessage('user', trimmed)]
    setAnswers(nextAnswers)
    setInput('')
    setError(null)

    if (currentStep < CLARIFIER_STEPS.length - 1) {
      const nextStep = currentStep + 1
      setCurrentStep(nextStep)
      nextMessages.push(appendMessage('agent', CLARIFIER_STEPS[nextStep].question))
      setMessages(prev => [...prev, ...nextMessages])
      return
    }

    setMessages(prev => [...prev, ...nextMessages])
    generateDoc(nextAnswers)
  }

  function handleGenerateNow(): void {
    const step = CLARIFIER_STEPS[currentStep]
    const nextAnswers = input.trim()
      ? { ...answers, [step.key]: input.trim() }
      : answers
    if (!Object.values(nextAnswers).some(value => value?.trim())) return
    if (input.trim()) {
      setMessages(prev => [...prev, appendMessage('user', input.trim())])
      setInput('')
    }
    setAnswers(nextAnswers)
    setError(null)
    generateDoc(nextAnswers)
  }

  function handleContinueClarifying(): void {
    const firstMissing = CLARIFIER_STEPS.findIndex(step => !answers[step.key]?.trim())
    const nextIndex = firstMissing >= 0 ? firstMissing : CLARIFIER_STEPS.length - 1
    setCurrentStep(nextIndex)
    setStage('chat')
    setMessages(prev => [
      ...prev,
      appendMessage('agent', `我们继续补齐需求。${CLARIFIER_STEPS[nextIndex].question}`),
    ])
  }

  async function handleConfirm(): Promise<void> {
    const doc = documentText.trim()
    if (!doc || submitting) return
    const name = normalizeRoomName(roomName)
    setSubmitting(true)
    setError(null)
    try {
      const created = await api.rooms.create({
        name,
        goal: doc,
      })
      await onCreate(created as Room)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : '交给天机阁失败')
      setSubmitting(false)
    }
  }

  return (
    <div
      className="absolute inset-0 z-30 bg-black/60 flex items-center justify-center p-4"
      onClick={() => onClose()}
    >
      <div
        className="w-full max-w-[1040px] max-h-[88vh] overflow-hidden rounded-xl border border-border-primary bg-surface-primary shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-border-primary px-4 py-3">
          <div>
            <h3 className="text-base font-semibold text-text-primary">发布江湖帖</h3>
            <p className="mt-0.5 text-xs text-text-muted">写下委托，确认需求文档后交给天机阁。</p>
          </div>
          <button
            onClick={onClose}
            className="rounded-md px-2 py-1 text-xs text-text-muted hover:bg-surface-hover hover:text-text-secondary"
          >
            关闭
          </button>
        </div>

        <div className="grid min-h-[560px] max-h-[calc(88vh-56px)] grid-cols-1 overflow-hidden lg:grid-cols-[1.05fr_0.95fr]">
          <div className="flex min-h-0 flex-col border-b border-border-primary lg:border-b-0 lg:border-r">
            <div className="border-b border-border-primary px-4 py-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-semibold text-text-primary">需求澄清</div>
                </div>
                <span className="rounded-full bg-interactive-bg px-2.5 py-1 text-xs text-interactive">已澄清 {progressText}</span>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {CLARIFIER_STEPS.map((step, index) => {
                  const done = !!answers[step.key]?.trim()
                  const active = stage === 'chat' && index === currentStep
                  return (
                    <button
                      key={step.key}
                      type="button"
                      onClick={() => selectStep(index)}
                      className={`rounded-full border px-2 py-1 text-[11px] ${
                        done
                          ? 'border-status-success/30 bg-status-success-bg text-status-success'
                          : active
                            ? 'border-interactive/30 bg-interactive-bg text-interactive'
                            : 'border-border-primary bg-surface-secondary text-text-muted'
                      } hover:border-interactive/40 hover:text-interactive`}
                    >
                      {step.label}
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-4 py-4">
              <div className="space-y-3">
                <div className="rounded-lg border border-border-primary bg-surface-secondary px-3 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm font-semibold text-text-primary">{activeStep.label}</div>
                    <span className="text-xs text-text-muted">第 {currentStep + 1} 项 / 共 {CLARIFIER_STEPS.length} 项</span>
                  </div>
                  <div className="mt-2 text-sm leading-6 text-text-secondary">{activeStep.question}</div>
                  {activeAnswer && (
                    <div className="mt-3 rounded-md border border-border-primary bg-surface-primary px-3 py-2 text-sm leading-6 text-text-primary">
                      {activeAnswer}
                    </div>
                  )}
                </div>
                {messages.map(message => (
                  <div
                    key={message.id}
                    className={`flex ${message.speaker === 'user' ? 'justify-end' : 'justify-start'}`}
                  >
                    <div
                      className={`max-w-[82%] rounded-lg px-3 py-2 text-sm leading-6 ${
                        message.speaker === 'user'
                          ? 'bg-interactive text-text-invert'
                          : 'border border-border-primary bg-surface-secondary text-text-secondary'
                      }`}
                    >
                      {message.content}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="border-t border-border-primary bg-surface-secondary p-3">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                    e.preventDefault()
                    handleSend()
                  }
                }}
                rows={4}
                disabled={stage === 'review'}
                placeholder={stage === 'review' ? '需求文档已生成。需要补充时点“继续澄清”。' : activeStep.question}
                className="w-full resize-none rounded-lg border border-border-primary bg-surface-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-interactive focus:outline-none disabled:opacity-60"
              />
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {stage === 'chat' ? (
                  <>
                    <button
                      onClick={handleSend}
                      disabled={!input.trim()}
                      className="rounded-lg bg-interactive px-3 py-2 text-sm text-text-invert hover:bg-interactive-hover disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      发送
                    </button>
                    <button
                      onClick={handleGenerateNow}
                      disabled={!canGenerate}
                      className="rounded-lg border border-border-primary bg-surface-primary px-3 py-2 text-sm text-text-secondary hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      先生成需求文档
                    </button>
                  </>
                ) : (
                  <button
                    onClick={handleContinueClarifying}
                    className="rounded-lg border border-border-primary bg-surface-primary px-3 py-2 text-sm text-text-secondary hover:bg-surface-hover"
                  >
                    继续澄清
                  </button>
                )}
              </div>
            </div>
          </div>

          <div className="flex min-h-0 flex-col bg-surface-secondary">
            <div className="border-b border-border-primary px-4 py-3">
              <div className="text-sm font-semibold text-text-primary">需求文档</div>
              <div className="mt-0.5 text-xs text-text-muted">你可以直接修改。确认后会创建临时帮派，并把这份文档作为委托交给天机阁。</div>
            </div>

            <div className="flex-1 overflow-y-auto p-4">
              <textarea
                value={documentText}
                onChange={(e) => setDocumentText(e.target.value)}
                placeholder="完成澄清后，这里会生成需求文档。"
                rows={22}
                className="min-h-[420px] w-full resize-none rounded-lg border border-border-primary bg-surface-primary px-3 py-2 font-mono text-xs leading-6 text-text-primary placeholder:text-text-muted focus:border-interactive focus:outline-none"
              />
            </div>

            <div className="border-t border-border-primary p-4">
              <label className="mb-1 block text-xs font-medium text-text-secondary">临时帮派名</label>
              <input
                value={roomName}
                onChange={(e) => setRoomName(e.target.value.replace(/\s/g, '').toLowerCase())}
                placeholder="jianghu001"
                className="mb-2 w-full rounded-lg border border-border-primary bg-surface-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-interactive focus:outline-none"
              />
              {error && <div className="mb-2 text-xs text-status-error">{error}</div>}
              <button
                onClick={() => void handleConfirm()}
                disabled={submitting || !documentText.trim()}
                className="w-full rounded-lg bg-interactive px-4 py-2 text-sm font-medium text-text-invert hover:bg-interactive-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {submitting ? '正在交给天机阁...' : '确认无误，交给天机阁'}
              </button>
              <p className="mt-2 text-xs leading-5 text-text-muted">
                天机阁收到后会继续判断难度、组建临时帮派、挑选弟子、领取功法并推进镖单。
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
