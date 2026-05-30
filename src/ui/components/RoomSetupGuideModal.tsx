import { useEffect, useMemo, useRef, useState } from 'react'

type SetupPathId = 'claude_sub' | 'codex_sub' | 'openai_api' | 'anthropic_api' | 'gemini_api'
type ProviderName = 'codex' | 'claude'
type ProviderSessionStatus = 'starting' | '运行中' | '已完成' | '失败' | 'canceled' | 'timeout'

interface ProviderSessionLine {
  id: number
  stream: 'stdout' | 'stderr' | 'system'
  text: string
  timestamp: string
}

interface ProviderAuthSession {
  sessionId: string
  provider: ProviderName
  status: ProviderSessionStatus
  active: boolean
  verificationUrl: string | null
  deviceCode: string | null
  lines: ProviderSessionLine[]
}

interface ProviderInstallSession {
  sessionId: string
  provider: ProviderName
  status: ProviderSessionStatus
  active: boolean
  lines: ProviderSessionLine[]
}

interface ProviderSignal {
  installed: boolean
  connected: boolean | null
}

interface QueenAuthSignal {
  provider: string
  mode: string
  credentialName: string | null
  envVar: string | null
  hasCredential: boolean
  hasEnvKey: boolean
  ready: boolean
  maskedKey: string | null
}

interface SetupPath {
  id: SetupPathId
  title: string
  model: string
  summary: string
  bestFor: string
  tradeoff: string
  setup: string
}

interface RoomSetupGuideModalProps {
  roomName: string
  roomId: number
  currentModel: string
  claude: ProviderSignal | null
  codex: ProviderSignal | null
  queenAuth: QueenAuthSignal | null
  providerAuthSessions: Partial<Record<ProviderName, ProviderAuthSession | null>>
  providerInstallSessions: Partial<Record<ProviderName, ProviderInstallSession | null>>
  onInstall: (provider: ProviderName) => Promise<void>
  onConnect: (provider: ProviderName) => Promise<void>
  onDisconnect: (provider: ProviderName) => Promise<void>
  onCancelAuth: (sessionId: string) => Promise<void>
  onCancelInstall: (sessionId: string) => Promise<void>
  onRefreshProviders: () => Promise<void>
  onApplyModel: (model: string) => Promise<void>
  onSaveApiKey: (credentialName: string, key: string) => Promise<void>
  onClose: () => void
}

const PATHS: SetupPath[] = [
  {
    id: 'claude_sub',
    title: 'Claude OAuth',
    model: 'claude',
    summary: '通过 Claude Code 登录，适合已经配置 Claude 的本机环境。',
    bestFor: '需要稳定推理和执行的帮派。',
    tradeoff: '额度取决于 Claude 账号方案。',
    setup: '江湖会检测 Claude CLI，并引导你完成登录。',
  },
  {
    id: 'codex_sub',
    title: 'OpenAI Codex OAuth',
    model: 'codex',
    summary: '使用 ChatGPT 账号 OAuth 登录 Codex，接入 GPT 系列模型。',
    bestFor: '代码、工具调用和长链执行较多的帮派。',
    tradeoff: '额度取决于 ChatGPT/Codex 账号方案。',
    setup: '江湖会检测 Codex CLI，并引导你完成 OpenAI OAuth 登录。',
  },
  {
    id: 'openai_api',
    title: 'OpenAI API',
    model: 'openai:gpt-4o-mini',
    summary: '通过 OpenAI API key 接入，适合明确按量计费的场景。',
    bestFor: '需要 API key 计费和独立限额控制的帮派。',
    tradeoff: '按量计费，需要自行管理密钥和额度。',
    setup: '填写 OpenAI API key 后，江湖会自动保存并校验。',
  },
  {
    id: 'anthropic_api',
    title: 'Anthropic API',
    model: 'anthropic:claude-3-5-sonnet-latest',
    summary: '通过 Anthropic API key 接入。',
    bestFor: '已经统一使用 Anthropic API 账号的帮派。',
    tradeoff: '按量计费，需要自行管理密钥和额度。',
    setup: '填写 Anthropic API key 后，江湖会自动保存并校验。',
  },
  {
    id: 'gemini_api',
    title: 'Gemini API',
    model: 'gemini:gemini-2.5-flash',
    summary: '通过兼容接口接入 Google Gemini。',
    bestFor: '需要使用 Gemini 模型并按量计费的帮派。',
    tradeoff: '按量计费，需要自行管理密钥和额度。',
    setup: '填写 Gemini API key 后，江湖会自动保存并校验。',
  },
]

function pickRecommendedPath(
  currentModel: string,
  claude: ProviderSignal | null,
  codex: ProviderSignal | null,
  queenAuth: QueenAuthSignal | null,
): SetupPathId {
  if ((currentModel === 'codex' || currentModel.startsWith('codex')) && codex?.connected === true) return 'codex_sub'
  if ((currentModel === 'claude' || currentModel.startsWith('claude')) && claude?.connected === true) return 'claude_sub'
  if (claude?.connected === true) return 'claude_sub'
  if (codex?.connected === true) return 'codex_sub'
  if (claude?.installed) return 'claude_sub'
  if (codex?.installed) return 'codex_sub'
  if (queenAuth?.ready) {
    if (queenAuth.provider === 'openai_api') return 'openai_api'
    if (queenAuth.provider === 'anthropic_api') return 'anthropic_api'
    if (queenAuth.provider === 'gemini_api') return 'gemini_api'
  }
  return 'claude_sub'
}

function getPathStatus(
  pathId: SetupPathId,
  claude: ProviderSignal | null,
  codex: ProviderSignal | null,
  queenAuth: QueenAuthSignal | null,
): { label: string; ready: boolean } {
  switch (pathId) {
    case 'claude_sub':
      if (!claude) return { label: '正在检查...', ready: false }
      if (claude.connected === true) return { label: '已登录', ready: true }
      if (claude.installed) return { label: '已安装，未登录', ready: false }
      return { label: '未安装', ready: false }
    case 'codex_sub':
      if (!codex) return { label: '正在检查...', ready: false }
      if (codex.connected === true) return { label: '已登录', ready: true }
      if (codex.installed) return { label: '已安装，未登录', ready: false }
      return { label: '未安装', ready: false }
    case 'openai_api':
      if (queenAuth?.provider === 'openai_api' && queenAuth.ready) return { label: '密钥可用', ready: true }
      if (queenAuth?.provider === 'openai_api' && (queenAuth.hasCredential || queenAuth.hasEnvKey)) return { label: '密钥可用', ready: true }
      return { label: '需要密钥', ready: false }
    case 'anthropic_api':
      if (queenAuth?.provider === 'anthropic_api' && queenAuth.ready) return { label: '密钥可用', ready: true }
      if (queenAuth?.provider === 'anthropic_api' && (queenAuth.hasCredential || queenAuth.hasEnvKey)) return { label: '密钥可用', ready: true }
      return { label: '需要密钥', ready: false }
    case 'gemini_api':
      if (queenAuth?.provider === 'gemini_api' && queenAuth.ready) return { label: '密钥可用', ready: true }
      if (queenAuth?.provider === 'gemini_api' && (queenAuth.hasCredential || queenAuth.hasEnvKey)) return { label: '密钥可用', ready: true }
      return { label: '需要密钥', ready: false }
  }
}

function isApiPath(pathId: SetupPathId | null): pathId is 'openai_api' | 'anthropic_api' | 'gemini_api' {
  return pathId === 'openai_api' || pathId === 'anthropic_api' || pathId === 'gemini_api'
}

function isSubPath(pathId: SetupPathId | null): pathId is 'claude_sub' | 'codex_sub' {
  return pathId === 'claude_sub' || pathId === 'codex_sub'
}

function subPathProvider(pathId: 'claude_sub' | 'codex_sub'): ProviderName {
  return pathId === 'claude_sub' ? 'claude' : 'codex'
}

function sessionStatusLabel(status: ProviderSessionStatus, kind: 'install' | 'auth'): string {
  switch (status) {
    case 'starting': return '正在启动'
    case '运行中': return kind === 'install' ? '正在安装' : '等待登录'
    case '已完成': return kind === 'install' ? '已安装' : '已连接'
    case '失败': return '失败'
    case 'canceled': return '已取消'
    case 'timeout': return '已超时'
    default: return status
  }
}

function sessionStatusColor(status: ProviderSessionStatus): string {
  if (status === '已完成') return 'text-status-success'
  if (status === '失败' || status === 'timeout') return 'text-status-error'
  return 'text-text-muted'
}

function apiCredentialName(pathId: 'openai_api' | 'anthropic_api' | 'gemini_api'): string {
  if (pathId === 'openai_api') return 'openai_api_key'
  if (pathId === 'gemini_api') return 'gemini_api_key'
  return 'anthropic_api_key'
}

function SessionLog({ lines }: { lines: ProviderSessionLine[] }): React.JSX.Element {
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [lines])

  const recentLines = lines.slice(-32)
  return (
    <div
      ref={logRef}
      className="max-h-32 overflow-y-auto rounded-lg border border-border-primary bg-surface-primary p-2 font-mono text-[11px] text-text-muted"
    >
      {recentLines.length === 0
        ? '等待输出...'
        : recentLines.map((line) => (
            <div key={line.id} className="whitespace-pre-wrap break-words">
              {line.text}
            </div>
          ))}
    </div>
  )
}

export function RoomSetupGuideModal({
  roomName,
  currentModel,
  claude,
  codex,
  queenAuth,
  providerAuthSessions,
  providerInstallSessions,
  onInstall,
  onConnect,
  onDisconnect,
  onCancelAuth,
  onCancelInstall,
  onRefreshProviders,
  onApplyModel,
  onSaveApiKey,
  onClose,
}: RoomSetupGuideModalProps): React.JSX.Element {
  const recommendedId = useMemo(
    () => pickRecommendedPath(currentModel, claude, codex, queenAuth),
    [currentModel, claude, codex, queenAuth]
  )
  const [selectedPathId, setSelectedPathId] = useState<SetupPathId | null>(null)
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [providerBusy, setProviderBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!selectedPathId) setSelectedPathId(recommendedId)
  }, [recommendedId, selectedPathId])

  const selectedProvider = selectedPathId && isSubPath(selectedPathId) ? subPathProvider(selectedPathId) : null
  const providerSignal = selectedProvider === 'claude' ? claude : selectedProvider === 'codex' ? codex : null
  const authSession = selectedProvider ? (providerAuthSessions[selectedProvider] ?? null) : null
  const installSession = selectedProvider ? (providerInstallSessions[selectedProvider] ?? null) : null

  // Auto-install CLI when a subscription path is selected and CLI is not installed
  const autoTriggeredRef = useRef<string | null>(null)
  useEffect(() => {
    if (!selectedProvider || !providerSignal) return
    if (providerBusy) return
    const key = `install:${selectedProvider}`
    if (autoTriggeredRef.current === key) return
    if (!providerSignal.installed && !installSession?.active) {
      autoTriggeredRef.current = key
      void (async () => {
        setProviderBusy(true)
        try { await onInstall(selectedProvider) } catch { /* shown in session log */ }
        finally { setProviderBusy(false) }
      })()
    }
  }, [selectedProvider, providerSignal?.installed, installSession?.active])

  // Auto-connect after install completes (CLI now installed but not connected)
  useEffect(() => {
    if (!selectedProvider || !providerSignal) return
    if (providerBusy) return
    const key = `connect:${selectedProvider}`
    if (autoTriggeredRef.current === key) return
    if (providerSignal.installed && providerSignal.connected !== true && !authSession?.active) {
      // Only auto-connect if we previously auto-installed (install session exists and completed)
      if (installSession && installSession.status === '已完成') {
        autoTriggeredRef.current = key
        void (async () => {
          setProviderBusy(true)
          try { await onConnect(selectedProvider) } catch { /* shown in session log */ }
          finally { setProviderBusy(false) }
        })()
      }
    }
  }, [selectedProvider, providerSignal?.installed, providerSignal?.connected, installSession?.status, authSession?.active])

  async function handleProviderAction(action: () => Promise<void>): Promise<void> {
    setProviderBusy(true)
    setError(null)
    try {
      await action()
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败')
    } finally {
      setProviderBusy(false)
    }
  }

  async function handleApply(): Promise<void> {
    const path = selectedPathId ? PATHS.find(p => p.id === selectedPathId) : null
    if (busy || !path) return
    setBusy(true)
    setError(null)
    try {
      if (isApiPath(path.id)) {
        const key = apiKeyInput.trim()
        const status = getPathStatus(path.id, claude, codex, queenAuth)
        if (!status.ready && !key) {
          setError(`请先填写 ${path.id === 'openai_api' ? 'OpenAI' : path.id === 'gemini_api' ? 'Gemini' : 'Anthropic'} API key。`)
          return
        }
        if (key) {
          await onSaveApiKey(apiCredentialName(path.id), key)
        }
      }
      await onApplyModel(path.model)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : '应用失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose() }}
    >
      <div className="w-full max-w-2xl max-h-[90vh] rounded-2xl bg-surface-primary shadow-2xl p-5 flex flex-col overflow-hidden">
        <div className="flex items-center justify-between gap-3 mb-3 shrink-0">
          <div>
            <h2 className="text-lg font-semibold text-text-primary">模型接入</h2>
            <p className="text-xs text-text-muted">为 {roomName} 选择合适的模型通道。</p>
          </div>
          <button
            onClick={onClose}
            disabled={busy}
            className="text-text-muted hover:text-text-secondary text-lg leading-none disabled:opacity-50"
            aria-label="关闭"
          >
            {'\u2715'}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto min-h-0">
          <div className="space-y-2">
            <p className="text-xs text-text-secondary">
              选择模型接入方式。OpenAI Codex OAuth 可通过 ChatGPT 账号登录；API 路径使用密钥。
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {PATHS.map((path) => {
                const isRecommended = path.id === recommendedId
                const isSelected = path.id === selectedPathId
                const status = getPathStatus(path.id, claude, codex, queenAuth)
                return (
                  <button
                    key={path.id}
                    onClick={() => {
                      setSelectedPathId(path.id)
                      setApiKeyInput('')
                      setError(null)
                    }}
                    disabled={busy}
                    className={`text-left px-3 py-2 rounded-lg border transition-colors ${
                      isSelected
                        ? 'border-interactive bg-interactive-bg'
                        : 'border-border-primary bg-surface-secondary hover:bg-surface-hover'
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-xs font-semibold text-text-primary">{path.title}</span>
                      {isRecommended && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-status-success-bg text-status-success font-semibold">
                          推荐
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-text-muted mb-0.5">{path.summary}</p>
                    <span className={`text-xs font-medium ${status.ready ? 'text-status-success' : 'text-text-muted'} ${status.label === '正在检查...' ? 'animate-pulse' : ''}`}>
                      {status.label}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>

          {selectedPathId && (() => {
            const path = PATHS.find(p => p.id === selectedPathId)!
            const status = getPathStatus(selectedPathId, claude, codex, queenAuth)
            return (
              <div className="mt-2 px-3 py-2 rounded-lg bg-surface-secondary border border-border-primary">
                <div className="text-xs text-text-secondary space-y-0.5">
                  <p><span className="text-text-muted">适合：</span>{path.bestFor}</p>
                  <p><span className="text-text-muted">配置：</span>{path.setup}</p>
                  <p><span className="text-text-muted">取舍：</span>{path.tradeoff}</p>
                </div>

                {/* Subscription path: Install / Connect / Disconnect */}
                {isSubPath(selectedPathId) && selectedProvider && (
                  <div className="mt-3 pt-3 border-t border-border-primary space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`text-xs font-medium ${status.ready ? 'text-status-success' : 'text-text-muted'} ${status.label === '正在检查...' ? 'animate-pulse' : ''}`}>
                        {status.label}
                      </span>
                      {!providerSignal?.installed && (
                        <button
                          onClick={() => handleProviderAction(() => onInstall(selectedProvider))}
                          disabled={providerBusy || installSession?.active}
                          className="text-xs px-2.5 py-1 rounded-lg border border-border-primary text-text-secondary hover:bg-surface-hover disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {installSession?.active ? '安装中...' : '安装'}
                        </button>
                      )}
                      {providerSignal?.installed && (
                        <>
                          {providerSignal.connected !== true && (
                            <button
                              onClick={() => handleProviderAction(() => onConnect(selectedProvider))}
                              disabled={providerBusy || authSession?.active || installSession?.active}
                              className="text-xs px-2.5 py-1 rounded-lg border border-border-primary text-text-secondary hover:bg-surface-hover disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              {authSession?.active ? '登录中...' : selectedProvider === 'codex' ? 'OAuth 登录' : '连接'}
                            </button>
                          )}
                          <button
                            onClick={() => handleProviderAction(() => onDisconnect(selectedProvider))}
                            disabled={providerBusy}
                            className="text-xs px-2.5 py-1 rounded-lg border border-border-primary text-text-secondary hover:bg-surface-hover disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            断开
                          </button>
                        </>
                      )}
                    </div>

                    {/* Install session progress */}
                    {installSession && (
                      <div className="space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-xs text-text-muted">安装：</span>
                          <span className={`text-xs ${sessionStatusColor(installSession.status)}`}>
                            {sessionStatusLabel(installSession.status, 'install')}
                          </span>
                          {installSession.active && (
                            <button
                              onClick={() => handleProviderAction(() => onCancelInstall(installSession.sessionId))}
                              disabled={providerBusy}
                              className="text-xs px-2 py-0.5 rounded-lg border border-border-primary text-text-secondary hover:bg-surface-hover disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              取消
                            </button>
                          )}
                          {!installSession.active && (
                            <button
                              onClick={() => handleProviderAction(() => onRefreshProviders())}
                              disabled={providerBusy}
                              className="text-xs px-2 py-0.5 rounded-lg border border-border-primary text-text-secondary hover:bg-surface-hover disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              刷新
                            </button>
                          )}
                        </div>
                        <SessionLog lines={installSession.lines} />
                      </div>
                    )}

                    {/* Auth session progress */}
                    {authSession && (
                      <div className="space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-xs text-text-muted">登录：</span>
                          <span className={`text-xs ${sessionStatusColor(authSession.status)}`}>
                            {sessionStatusLabel(authSession.status, 'auth')}
                          </span>
                          {authSession.active && (
                            <button
                              onClick={() => handleProviderAction(() => onCancelAuth(authSession.sessionId))}
                              disabled={providerBusy}
                              className="text-xs px-2 py-0.5 rounded-lg border border-border-primary text-text-secondary hover:bg-surface-hover disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              取消
                            </button>
                          )}
                          {!authSession.active && (
                            <button
                              onClick={() => handleProviderAction(() => onRefreshProviders())}
                              disabled={providerBusy}
                              className="text-xs px-2 py-0.5 rounded-lg border border-border-primary text-text-secondary hover:bg-surface-hover disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              刷新
                            </button>
                          )}
                        </div>
                        {authSession.deviceCode && (
                          <div className="text-xs text-text-secondary">
                            验证码：<code className="px-1 py-0.5 rounded bg-surface-primary border border-border-primary">{authSession.deviceCode}</code>
                          </div>
                        )}
                        {authSession.verificationUrl && (
                          <a
                            href={authSession.verificationUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="text-xs text-interactive hover:underline break-all inline-block"
                          >
                            打开验证页面
                          </a>
                        )}
                        <SessionLog lines={authSession.lines} />
                      </div>
                    )}
                  </div>
                )}

                {/* API key path */}
                {isApiPath(selectedPathId) && (() => {
                  const matchesProvider = queenAuth?.provider === selectedPathId
                  const currentMaskedKey = matchesProvider ? queenAuth?.maskedKey : null
                  const keySource = matchesProvider
                    ? queenAuth?.hasCredential ? 'saved' : queenAuth?.hasEnvKey ? `env` : null
                    : null
                  return (
                  <div className="mt-3 pt-3 border-t border-border-primary space-y-2">
                    <label className="block text-xs font-medium text-text-secondary">
                      {selectedPathId === 'openai_api' ? 'OpenAI API key' : selectedPathId === 'gemini_api' ? 'Gemini API key' : 'Anthropic API key'}
                    </label>
                    {currentMaskedKey && (
                      <div className="flex items-center gap-2 text-xs">
                        <span className="text-text-muted">当前：</span>
                        <code className="px-1.5 py-0.5 rounded bg-surface-primary border border-border-primary text-text-secondary font-mono">
                          {currentMaskedKey}
                        </code>
                        {keySource && (
                          <span className="text-text-muted">({keySource})</span>
                        )}
                      </div>
                    )}
                    <input
                      type="password"
                      value={apiKeyInput}
                      onChange={(e) => setApiKeyInput(e.target.value)}
                      placeholder={status.ready ? '粘贴新密钥以替换' : '粘贴 API key'}
                      disabled={busy}
                      className="w-full px-2.5 py-2 text-sm border border-border-primary rounded-lg focus:outline-none focus:border-text-muted bg-surface-primary text-text-primary placeholder:text-text-muted disabled:opacity-70"
                    />
                    <p className="text-xs text-text-muted">
                      {status.ready
                        ? '密钥已校验并保存到当前帮派。粘贴新密钥可替换。'
                        : '点击应用时会校验并保存密钥。'}
                    </p>
                  </div>
                  )})()}

                {!status.ready && isApiPath(selectedPathId) && !apiKeyInput.trim() && (
                  <p className="text-xs text-status-warning mt-2">
                    当前帮派需要先配置 API key，帮主才能启动。
                  </p>
                )}
              </div>
            )
          })()}
        </div>

        {error && (
          <p className="text-sm text-status-error mt-3 shrink-0">{error}</p>
        )}

        <div className="flex justify-end gap-2 mt-3 shrink-0">
          <button
            onClick={onClose}
            disabled={busy}
            className="px-3 py-1.5 text-xs text-text-muted hover:text-text-secondary border border-border-primary rounded-lg disabled:opacity-50"
          >
            取消
          </button>
          <button
            onClick={handleApply}
            disabled={busy || !selectedPathId}
            className="px-3 py-1.5 text-xs bg-interactive text-text-invert rounded-lg hover:bg-interactive-hover disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy ? '应用中...' : '应用'}
          </button>
        </div>
      </div>
    </div>
  )
}
