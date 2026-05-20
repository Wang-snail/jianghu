import { useState, useEffect, useRef, type ReactNode } from 'react'
import { APP_MODE } from '../lib/auth'
import { api } from '../lib/client'
import { storageSet } from '../lib/storage'

export const CONTACT_PROMPT_SEEN_KEY = 'zuzu_contact_prompt_seen'
const isCloud = APP_MODE === 'cloud'

type Step = 'email' | 'code' | 'telegram'

interface ContactPromptModalProps {
  onClose: () => void
  onNavigateToClerk: () => void
}

function emphasizeRoleWords(text: string): ReactNode[] {
  return text.split(/(\b(?:clerk|queen|queens)\b)/gi).map((part, index) => {
    if (/^(clerk|queen|queens)$/i.test(part)) {
      return <span key={`role-${index}`} className="text-text-primary font-semibold">{part}</span>
    }
    return <span key={`text-${index}`}>{part}</span>
  })
}

export function ContactPromptModal({ onClose, onNavigateToClerk }: ContactPromptModalProps): React.JSX.Element {
  const [step, setStep] = useState<Step>(isCloud ? 'telegram' : 'email')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [deepLink, setDeepLink] = useState<string | null>(null)
  const [telegramPending, setTelegramPending] = useState(false)
  const [telegramVerified, setTelegramVerified] = useState(false)
  const [emailVerified, setEmailVerified] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [step])

  function markSeen(): void {
    storageSet(CONTACT_PROMPT_SEEN_KEY, '1')
  }

  function finish(): void {
    markSeen()
    onNavigateToClerk()
  }

  function skipToTelegram(): void {
    setError(null)
    setStep('telegram')
  }

  function skipAll(): void {
    markSeen()
    onClose()
  }

  async function handleEmailSend(): Promise<void> {
    const trimmed = email.trim().toLowerCase()
    if (!trimmed) {
      setError('请输入您的邮箱。')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await api.contacts.emailStart(trimmed)
      if (res.alreadyVerified) {
        setEmailVerified(true)
        setStep('telegram')
      } else {
        setStep('code')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '发送验证码失败。')
    } finally {
      setBusy(false)
    }
  }

  async function handleCodeVerify(): Promise<void> {
    const trimmed = code.trim()
    if (trimmed.length !== 6) {
      setError('请输入邮箱中的6位验证码。')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await api.contacts.emailVerify(trimmed)
      setEmailVerified(true)
      setStep('telegram')
    } catch (err) {
      setError(err instanceof Error ? err.message : '验证码无效。')
    } finally {
      setBusy(false)
    }
  }

  async function handleTelegramConnect(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const res = await api.contacts.telegramStart()
      setDeepLink(res.deepLink)
      setTelegramPending(true)
      window.open(res.deepLink, '_blank')
    } catch (err) {
      setError(err instanceof Error ? err.message : '生成链接失败。')
    } finally {
      setBusy(false)
    }
  }

  async function handleTelegramCheck(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const res = await api.contacts.telegramCheck()
      if (res.status === 'verified') {
        setTelegramVerified(true)
      } else if (res.status === 'expired') {
        setError('链接已过期。请生成新链接。')
        setDeepLink(null)
        setTelegramPending(false)
      } else {
        setError('尚未确认。请打开机器人链接并点击开始，然后重新检查。')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '检查失败。')
    } finally {
      setBusy(false)
    }
  }

  const allSteps: Step[] = isCloud ? ['telegram'] : ['email', 'code', 'telegram']
  const stepIdx = allSteps.indexOf(step)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-surface-primary rounded-2xl shadow-2xl w-full max-w-md mx-4 p-8">
        {/* Step dots */}
        {allSteps.length > 1 && (
          <div className="flex gap-1.5 mb-6">
            {allSteps.map((s, i) => (
              <div
                key={s}
                className={`w-2.5 h-2.5 rounded-full transition-colors ${
                  i === stepIdx ? 'bg-interactive' : i < stepIdx ? 'bg-status-success' : 'bg-surface-tertiary'
                }`}
              />
            ))}
          </div>
        )}

        {/* Step 1: Email */}
        {step === 'email' && (
          <>
            <h2 className="text-2xl font-bold text-text-primary mb-2">保持联络</h2>
            <p className="text-text-muted text-sm leading-relaxed mb-6">
              {emphasizeRoleWords("管理员可以在您离开桌面时协助管理虫群。请添加您的邮箱，以便管理员就审批、凭据和密钥更新与您联系。")}
            </p>
            <div className="mb-4">
              <label className="block text-sm text-text-secondary mb-1">邮箱</label>
              <input
                ref={inputRef}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleEmailSend() }}
                placeholder="your@email.com"
                className="w-full px-3 py-2 rounded-lg bg-surface-secondary border border-border-primary text-sm text-text-primary placeholder:text-text-muted focus:outline-none"
              />
            </div>
            {error && <p className="text-xs text-status-error mb-3">{error}</p>}
            <div className="flex flex-col gap-2">
              <button
                onClick={() => { void handleEmailSend() }}
                disabled={busy}
                className="w-full py-2.5 text-sm font-medium text-text-invert bg-interactive hover:bg-interactive-hover rounded-lg transition-colors disabled:opacity-50"
              >
                {busy ? '发送中...' : '发送验证码'}
              </button>
              <button
                onClick={skipToTelegram}
                className="w-full py-2 text-sm text-text-muted hover:text-text-secondary transition-colors"
              >
                跳过，改为设置 Telegram
              </button>
            </div>
          </>
        )}

        {/* Step 2: Verify code */}
        {step === 'code' && (
          <>
            <h2 className="text-2xl font-bold text-text-primary mb-2">检查您的收件箱</h2>
            <p className="text-text-muted text-sm leading-relaxed mb-6">
              我们向 <span className="text-text-primary font-medium">{email.trim().toLowerCase()}</span> 发送了6位验证码。可能需要2-5分钟送达。请在下方输入以完成验证。
            </p>
            <div className="mb-4">
              <label className="block text-sm text-text-secondary mb-1">验证码</label>
              <input
                ref={inputRef}
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                onKeyDown={(e) => { if (e.key === 'Enter' && code.trim().length === 6) void handleCodeVerify() }}
                placeholder="000000"
                inputMode="numeric"
                className="w-full px-3 py-2 rounded-lg bg-surface-secondary border border-border-primary text-sm text-text-primary placeholder:text-text-muted focus:outline-none tracking-widest text-center text-lg"
              />
            </div>
            {error && <p className="text-xs text-status-error mb-3">{error}</p>}
            <div className="flex flex-col gap-2">
              <button
                onClick={() => { void handleCodeVerify() }}
                disabled={busy || code.trim().length !== 6}
                className="w-full py-2.5 text-sm font-medium text-text-invert bg-interactive hover:bg-interactive-hover rounded-lg transition-colors disabled:opacity-50"
              >
                {busy ? '验证中...' : '验证'}
              </button>
              <button
                onClick={() => { setStep('email'); setCode(''); setError(null) }}
                className="w-full py-2 text-sm text-text-muted hover:text-text-secondary transition-colors"
              >
                重试
              </button>
              <button
                onClick={skipToTelegram}
                className="w-full py-2 text-sm text-text-muted hover:text-text-secondary transition-colors"
              >
                跳过，改为设置 Telegram
              </button>
            </div>
          </>
        )}

        {/* Step 3: Telegram */}
        {step === 'telegram' && (
          <>
            <h2 className="text-2xl font-bold text-text-primary mb-2">
              {isCloud ? '保持联络' : emailVerified ? '还有一件事' : '连接 Telegram'}
            </h2>
            <p className="text-text-muted text-sm leading-relaxed mb-6">
              {emphasizeRoleWords(
                isCloud
                  ? '管理员可以在您离开桌面时协助运行虫群。Telegram 是管理员就审批、凭据和进度更新与您联系的最快途径。'
                  : '管理员可以在您离开桌面时协助管理虫群。Telegram 是保持联系的最快方式。'
              )}{' '}
              点击下方打开我们的机器人，按 <span className="text-text-primary font-medium">开始</span>，然后返回检查状态。
            </p>

            {telegramVerified ? (
              <div className="mb-4 p-3 rounded-lg bg-surface-secondary text-sm text-status-success font-medium">
                Telegram 已连接！
              </div>
            ) : (
              <div className="space-y-3 mb-4">
                {!telegramPending ? (
                  <button
                    onClick={() => { void handleTelegramConnect() }}
                    disabled={busy}
                    className="w-full py-2.5 text-sm font-medium text-text-invert bg-interactive hover:bg-interactive-hover rounded-lg transition-colors disabled:opacity-50"
                  >
                    {busy ? '生成链接中...' : '打开 Telegram 机器人'}
                  </button>
                ) : (
                  <>
                    {deepLink && (
                      <a
                        href={deepLink}
                        target="_blank"
                        rel="noreferrer"
                        className="block w-full py-2.5 text-sm font-medium text-center text-interactive border border-interactive rounded-lg hover:bg-surface-hover transition-colors"
                      >
                        再次打开机器人链接
                      </a>
                    )}
                    <button
                      onClick={() => { void handleTelegramCheck() }}
                      disabled={busy}
                      className="w-full py-2.5 text-sm font-medium text-text-invert bg-interactive hover:bg-interactive-hover rounded-lg transition-colors disabled:opacity-50"
                    >
                      {busy ? '检查中...' : '我已按开始 — 立即检查'}
                    </button>
                  </>
                )}
              </div>
            )}

            {error && <p className="text-xs text-status-error mb-3">{error}</p>}

            <div className="flex flex-col gap-2">
              {telegramVerified ? (
                <button
                  onClick={finish}
                  className="w-full py-2.5 text-sm font-medium text-text-invert bg-interactive hover:bg-interactive-hover rounded-lg transition-colors"
                >
                  完成
                </button>
              ) : (
                <button
                  onClick={skipAll}
                  className="w-full py-2 text-sm text-text-muted hover:text-text-secondary transition-colors"
                >
                  暂时跳过
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
