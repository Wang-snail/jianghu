import { useState, useEffect, useRef } from 'react'
import { api } from '../lib/client'
import { storageGet, storageSet } from '../lib/storage'
import { extractReferralCodeFromLocation, normalizeReferralCode } from '../lib/referrals'
import type { Room } from '@shared/types'
import { OBJECTIVE_PLACEHOLDERS } from '../lib/objective-placeholders'

interface CreateRoomModalProps {
  onClose: () => void
  onCreate: (room: Room) => void
}

export function CreateRoomModal({ onClose, onCreate }: CreateRoomModalProps): React.JSX.Element {
  const [name, setName] = useState('')
  const [goal, setGoal] = useState('')
  const [referredByCode, setReferredByCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [placeholderIdx, setPlaceholderIdx] = useState(0)
  const nameRef = useRef<HTMLInputElement>(null)
  const inviteAutoFilled = useRef(false)

  // Auto-focus name input
  useEffect(() => { nameRef.current?.focus() }, [])

  // Auto-fill referral code from URL or local storage.
  useEffect(() => {
    if (inviteAutoFilled.current) return
    inviteAutoFilled.current = true
    const urlCode = extractReferralCodeFromLocation()
    if (urlCode) {
      setReferredByCode(urlCode)
      storageSet('zuzu_referred_by_code', urlCode)
      return
    }
    const stored = normalizeReferralCode(storageGet('zuzu_referred_by_code'))
    if (stored) {
      setReferredByCode(stored)
    }
  }, [])

  // Rotate placeholder every 3s
  useEffect(() => {
    const timer = setInterval(() => {
      setPlaceholderIdx(prev => (prev + 1) % OBJECTIVE_PLACEHOLDERS.length)
    }, 3000)
    return () => clearInterval(timer)
  }, [])

  // Escape to close
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function handleCreate(): Promise<void> {
    const trimName = name.trim()
    if (!trimName || busy) return

    setBusy(true)
    setError(null)
    try {
      const trimCode = normalizeReferralCode(referredByCode) ?? undefined
      if (trimCode) storageSet('zuzu_referred_by_code', trimCode)
      const created = await api.rooms.create({ name: trimName, goal: goal.trim() || undefined, referredByCode: trimCode })
      onCreate(created as Room)
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建临时帮派失败')
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-surface-primary rounded-2xl shadow-2xl w-full max-w-md mx-4 p-6 relative">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-text-muted hover:text-text-secondary text-lg leading-none transition-colors"
        >
          {'\u2715'}
        </button>

        <h2 className="text-lg font-semibold text-text-primary mb-4">创建临时帮派</h2>

        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">临时帮派名称</label>
            <input
              ref={nameRef}
              type="text"
              value={name}
              onChange={e => setName(e.target.value.replace(/\s/g, '').toLowerCase())}
              onKeyDown={e => { if (e.key === 'Enter' && name.trim()) handleCreate() }}
              placeholder="myproject"
              className="w-full px-3 py-2 rounded-lg bg-surface-secondary border border-border-primary text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-interactive"
            />
            <p className="text-xs text-text-muted mt-0.5">建议使用简短名称，便于天机处和弟子识别。</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">委托目标</label>
            <textarea
              value={goal}
              onChange={e => setGoal(e.target.value)}
              placeholder={OBJECTIVE_PLACEHOLDERS[placeholderIdx]}
              rows={6}
              className="w-full px-3 py-2 rounded-lg bg-surface-secondary border border-border-primary text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-interactive resize-none transition-colors"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-text-muted mb-1">推荐码 <span className="text-xs font-normal">（可选）</span></label>
            <input
              type="text"
              value={referredByCode}
              onChange={e => setReferredByCode(e.target.value)}
              placeholder="输入邀请码"
              className="w-full px-3 py-2 rounded-lg bg-surface-secondary border border-border-primary text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-interactive"
            />
            <p className="text-xs text-text-muted mt-0.5">将此临时帮派链接到江湖关系网络，任务完成后经验会归档。</p>
          </div>
        </div>

        {error && <p className="mt-2 text-xs text-status-error">{error}</p>}

        <div className="flex gap-2 mt-4">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2 rounded-lg bg-surface-tertiary text-text-primary text-sm font-medium hover:bg-surface-hover transition-colors"
          >
            取消
          </button>
          <button
            onClick={() => void handleCreate()}
            disabled={busy || !name.trim()}
            className="flex-1 px-4 py-2 rounded-lg bg-interactive text-text-invert text-sm font-medium hover:bg-interactive-hover transition-colors disabled:opacity-50"
          >
            {busy ? '创建中...' : '创建'}
          </button>
        </div>
      </div>
    </div>
  )
}
