import { useState, useEffect } from 'react'
import { api } from '../lib/client'

interface LocalTelegramStatus {
  ok: boolean
  verified: boolean
  telegramId?: string
  username?: string
  firstName?: string
  verifiedAt?: string
}

interface VerificationCode {
  ok: boolean
  code?: string
  expiresAt?: string
  message?: string
  error?: string
}

export function LocalTelegramConnect(): React.JSX.Element {
  const [status, setStatus] = useState<LocalTelegramStatus | null>(null)
  const [verification, setVerification] = useState<VerificationCode | null>(null)
  const [generating, setGenerating] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [codeInput, setCodeInput] = useState('')
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)

  // 加载状态
  useEffect(() => {
    void loadStatus()
  }, [])

  async function loadStatus() {
    try {
      const response = await api.get('/api/telegram-local/status') as { data: LocalTelegramStatus }
      setStatus(response.data)
    } catch (error) {
      console.error('加载状态失败:', error)
    }
  }

  async function handleGenerateCode() {
    setGenerating(true)
    setVerification(null)
    setTestResult(null)

    try {
      const response = await api.post('/api/telegram-local/verify/generate') as { data: VerificationCode }
      setVerification(response.data)
    } catch (error) {
      setVerification({
        ok: false,
        error: error instanceof Error ? error.message : '生成验证码失败'
      })
    } finally {
      setGenerating(false)
    }
  }

  async function handleVerifyCode() {
    if (!codeInput.trim()) return

    setVerifying(true)
    setTestResult(null)

    try {
      const response = await api.post('/api/telegram-local/verify', { code: codeInput.trim() }) as { data: { ok: boolean; error?: string } }

      if (response.data.ok) {
        setTestResult({ ok: true, message: '验证成功！' })
        setCodeInput('')
        setVerification(null)
        await loadStatus()
      } else {
        setTestResult({ ok: false, message: response.data.error || '验证失败' })
      }
    } catch (error) {
      setTestResult({
        ok: false,
        message: error instanceof Error ? error.message : '验证失败'
      })
    } finally {
      setVerifying(false)
    }
  }

  async function handleDisconnect() {
    try {
      await api.post('/api/telegram-local/disconnect')
      setStatus(null)
      setVerification(null)
      setTestResult({ ok: true, message: '已断开' })
    } catch (error) {
      setTestResult({
        ok: false,
        message: error instanceof Error ? error.message : '断开失败'
      })
    }
  }

  async function handleTestMessage() {
    if (!status?.verified) return

    try {
      const response = await api.post('/api/telegram-local/test') as { data: { ok: boolean; error?: string } }

      if (response.data.ok) {
        setTestResult({ ok: true, message: '测试消息已发送！请检查Telegram。' })
      } else {
        setTestResult({ ok: false, message: response.data.error || '发送失败' })
      }
    } catch (error) {
      setTestResult({
        ok: false,
        message: error instanceof Error ? error.message : '发送失败'
      })
    }
  }

  return (
    <div className="p-4 bg-surface-secondary rounded-lg border border-border-primary space-y-4">
      <h3 className="text-lg font-semibold text-text-primary">本地Telegram验证</h3>

      <p className="text-sm text-text-muted">
        使用验证码方式连接您的Telegram Bot <span className="text-interactive font-medium">@chong_zu_bot</span>
        <br />
        <span className="text-xs">• 完全本地化，不依赖任何江湖云端服务</span>
      </p>

      {/* 当前状态 */}
      {status && (
        <div className={`p-3 rounded-lg border ${
          status.verified
            ? 'bg-status-success-bg border-status-success'
            : 'bg-surface-tertiary border-border-primary'
        }`}>
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">
              {status.verified ? '✅ 已连接' : '❌ 未连接'}
            </span>
            {status.verified && (
              <button
                onClick={handleDisconnect}
                className="text-xs px-2 py-1 rounded border border-border-primary text-text-muted hover:text-text-secondary hover:bg-surface-hover"
              >
                断开
              </button>
            )}
          </div>
          {status.verified && (
            <div className="mt-2 text-xs text-text-muted space-y-1">
              <div>用户ID: {status.telegramId}</div>
              <div>用户名: {status.username}</div>
              <div>验证时间: {status.verifiedAt ? new Date(status.verifiedAt).toLocaleString('zh-CN') : '-'}</div>
            </div>
          )}
        </div>
      )}

      {/* 验证流程 */}
      {!status?.verified && (
        <div className="space-y-3">
          {/* 步骤1：生成验证码 */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-text-secondary">步骤1：生成验证码</span>
              <button
                onClick={handleGenerateCode}
                disabled={generating}
                className="text-xs px-3 py-1.5 rounded bg-interactive text-text-invert hover:bg-interactive-hover disabled:opacity-50"
              >
                {generating ? '生成中...' : '生成验证码'}
              </button>
            </div>

            {verification && verification.ok && (
              <div className="p-3 bg-status-success-bg border border-status-success rounded-lg space-y-2">
                <div className="text-sm font-mono text-center text-2xl py-2">
                  {verification.code}
                </div>
                <div className="text-xs text-center text-text-muted">
                  过期时间: {verification.expiresAt ? new Date(verification.expiresAt).toLocaleString('zh-CN') : '-'}
                </div>
                <div className="text-xs text-text-secondary">
                  {verification.message}
                </div>
              </div>
            )}

            {verification && !verification.ok && (
              <div className="p-3 bg-status-error-bg border border-status-error rounded-lg">
                <div className="text-sm text-status-error">
                  ❌ {verification.error}
                </div>
              </div>
            )}
          </div>

          {/* 步骤2：在Telegram中发送验证码 */}
          {verification && verification.ok && (
            <div className="space-y-2">
              <span className="text-sm font-medium text-text-secondary">步骤2：在Telegram中发送验证码</span>
              <div className="p-3 bg-surface-tertiary border border-border-primary rounded-lg space-y-2">
                <div className="text-sm text-text-secondary">
                  1. 打开Telegram，找到 <span className="text-interactive font-medium">@chong_zu_bot</span>
                </div>
                <div className="text-sm text-text-secondary">
                  2. 发送验证码: <span className="font-mono font-bold">{verification.code}</span>
                </div>
                <div className="text-xs text-text-muted">
                  验证码有效期15分钟
                </div>
              </div>
            </div>
          )}

          {/* 步骤3：验证 */}
          {verification && verification.ok && (
            <div className="space-y-2">
              <span className="text-sm font-medium text-text-secondary">步骤3：确认验证</span>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={codeInput}
                  onChange={(e) => setCodeInput(e.target.value)}
                  placeholder="输入6位验证码"
                  maxLength={6}
                  className="flex-1 px-3 py-2 text-sm border border-border-primary rounded-lg focus:outline-none focus:border-interactive bg-surface-primary font-mono text-center"
                />
                <button
                  onClick={handleVerifyCode}
                  disabled={verifying || !codeInput.trim()}
                  className="px-4 py-2 text-sm rounded bg-interactive text-text-invert hover:bg-interactive-hover disabled:opacity-50"
                >
                  {verifying ? '验证中...' : '验证'}
                </button>
              </div>
              {testResult && (
                <div className={`text-sm p-2 rounded ${
                  testResult.ok
                    ? 'bg-status-success-bg text-status-success'
                    : 'bg-status-error-bg text-status-error'
                }`}>
                  {testResult.ok ? '✅ ' : '❌ '}{testResult.message}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* 已连接状态下的操作 */}
      {status?.verified && (
        <div className="space-y-3">
          <button
            onClick={handleTestMessage}
            className="w-full px-4 py-2 text-sm rounded border border-border-primary text-text-secondary hover:bg-surface-hover transition-colors"
          >
            📤 发送测试消息
          </button>
        </div>
      )}

      {/* 帮助信息 */}
      <div className="text-xs text-text-muted space-y-1 border-t border-border-secondary pt-3">
        <div className="font-medium">使用说明：</div>
        <div>1. 点击"生成验证码"</div>
        <div>2. 在Telegram中向 @chong_zu_bot 发送验证码</div>
        <div>3. 输入验证码并点击"验证"</div>
        <div>4. 验证成功后即可使用</div>
      </div>
    </div>
  )
}
