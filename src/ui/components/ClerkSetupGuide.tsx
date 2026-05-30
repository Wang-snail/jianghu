import { useEffect, useMemo, useRef, useState } from 'react'

type SetupPathId = 'claude_sub' | 'codex_sub' | 'openai_api' | 'anthropic_api' | 'gemini_api'
type ProviderName = 'codex' | 'claude'
type ProviderSessionStatus = 'starting' | 'running' | '已完成' | 'failed' | 'canceled' | 'timeout'

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

interface ApiAuthSignal {
  hasRoomCredential: boolean
  hasSavedKey: boolean
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

interface 天机阁SetupGuideProps {
  claude: ProviderSignal | null
  codex: ProviderSignal | null
  apiAuth: {
    openai: ApiAuthSignal
    anthropic: ApiAuthSignal
  } | null
  providerAuthSessions: Partial<Record<ProviderName, ProviderAuthSession | null>>
  providerInstallSessions: Partial<Record<ProviderName, ProviderInstallSession | null>>
  onInstall: (provider: ProviderName) => Promise<void>
  onConnect: (provider: ProviderName) => Promise<void>
  onDisconnect: (provider: ProviderName) => Promise<void>
  onCancelAuth: (sessionId: string) => Promise<void>
  onCancelInstall: (sessionId: string) => Promise<void>
  onRefreshProviders: () => Promise<void>
  onApplyModel: (model: string) => Promise<void>
  onSaveApiKey: (provider: 'openai_api' | 'anthropic_api' | 'gemini_api', key: string) => Promise<void>
  onClose: () => void
}

const PATHS: SetupPath[] = [
  {
    id: 'claude_sub',
    title: 'Claude OAuth',
    model: 'claude',
    summary: '通过 Claude Code 登录。',
    bestFor: '需要稳定对话和系统管理的场景。',
    tradeoff: '额度取决于 Claude 账号方案。',
    setup: '江湖会检测 Claude CLI，并引导你完成登录。',
  },
  {
    id: 'codex_sub',
    title: 'OpenAI Codex OAuth',
    model: 'codex',
    summary: '使用 ChatGPT 账号 OAuth 登录 Codex，接入 GPT 系列模型。',
    bestFor: '工具调用、代码任务和长链执行较多的场景。',
    tradeoff: '额度取决于 ChatGPT/Codex 账号方案。',
    setup: '江湖会检测 Codex CLI，并引导你完成 OpenAI OAuth 登录。',
  },
  {
    id: 'openai_api',
    title: 'OpenAI API',
    model: 'openai:gpt-4o-mini',
    summary: '通过 OpenAI API key 接入。',
    bestFor: '需要 API key 计费和独立限额控制的场景。',
    tradeoff: '按量计费，需要自行管理密钥和额度。',
    setup: '使用保存的 OpenAI API key 或 OPENAI_API_KEY 环境变量。',
  },
  {
    id: 'anthropic_api',
    title: 'Anthropic API',
    model: 'anthropic:claude-3-5-sonnet-latest',
    summary: '通过 Anthropic API key 接入。',
    bestFor: '已经统一使用 Anthropic API 账号的场景。',
    tradeoff: '按量计费，需要自行管理密钥和额度。',
    setup: '使用保存的 Anthropic API key 或 ANTHROPIC_API_KEY 环境变量。',
  },
  {
    id: 'gemini_api',
    title: 'Gemini API',
    model: 'gemini:gemini-2.5-flash',
    summary: '通过兼容接口接入 Google Gemini。',
    bestFor: '需要使用 Gemini 模型并按量计费的场景。',
    tradeoff: '按量计费，需要自行管理密钥和额度。',
    setup: '使用保存的 Gemini API key 或 GEMINI_API_KEY 环境变量。',
  },
]

function pickRecommendedPath(
  claude: ProviderSignal | null,
  codex: ProviderSignal | null,
  apiAuth: { openai: ApiAuthSignal; anthropic: ApiAuthSignal; gemini?: ApiAuthSignal } | null,
): SetupPathId {
  if (claude?.connected === true) return 'claude_sub'
  if (codex?.connected === true) return 'codex_sub'
  if (claude?.installed) return 'claude_sub'
  if (codex?.installed) return 'codex_sub'
  if (apiAuth?.openai.ready) return 'openai_api'
  if (apiAuth?.anthropic.ready) return 'anthropic_api'
  if (apiAuth?.gemini?.ready) return 'gemini_api'
  return 'claude_sub'
}

function getPathStatus(
  pathId: SetupPathId,
  claude: ProviderSignal | null,
  codex: ProviderSignal | null,
  apiAuth: { openai: ApiAuthSignal; anthropic: ApiAuthSignal; gemini?: ApiAuthSignal } | null,
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
      return apiAuth?.openai.ready
        ? { label: `密钥可用（${describeApiAuthSource(apiAuth.openai)}）`, ready: true }
        : { label: '需要密钥', ready: false }
    case 'anthropic_api':
      return apiAuth?.anthropic.ready
        ? { label: `密钥可用（${describeApiAuthSource(apiAuth.anthropic)}）`, ready: true }
        : { label: '需要密钥', ready: false }
    case 'gemini_api':
      return apiAuth?.gemini?.ready
        ? { label: `密钥可用（${describeApiAuthSource(apiAuth.gemini)}）`, ready: true }
        : { label: '需要密钥', ready: false }
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

function describeApiAuthSource(auth: ApiAuthSignal): string {
  if (auth.hasSavedKey) return '天机阁 key'
  if (auth.hasRoomCredential) return '帮派密钥'
  if (auth.hasEnvKey) return '环境变量'
  return '未配置'
}

function sessionStatusLabel(status: ProviderSessionStatus, kind: 'install' | 'auth'): string {
  switch (status) {
    case 'starting': return '正在启动'
    case 'running': return kind === 'install' ? '正在安装' : '等待登录'
    case '已完成': return kind === 'install' ? '已安装' : '已连接'
    case 'failed': return '失败'
    case 'canceled': return '已取消'
    case 'timeout': return '已超时'
    default: return status
  }
}

function sessionStatusColor(status: ProviderSessionStatus): string {
  if (status === '已完成') return 'text-status-success'
  if (status === 'failed' || status === 'timeout') return 'text-status-error'
  return 'text-text-muted'
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

export function 天机阁SetupGuide({
  claude,
  codex,
  apiAuth,
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
}: 天机阁SetupGuideProps): React.JSX.Element {
  const recommendedId = useMemo(
    () => pickRecommendedPath(claude, codex, apiAuth),
    [claude, codex, apiAuth]
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

  // Auto-connect after install completes
  useEffect(() => {
    if (!selectedProvider || !providerSignal) return
    if (providerBusy) return
    const key = `connect:${selectedProvider}`
    if (autoTriggeredRef.current === key) return
    if (providerSignal.installed && providerSignal.connected !== true && !authSession?.active) {
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
        const provider = path.id as 'openai_api' | 'anthropic_api' | 'gemini_api'
        const status = getPathStatus(path.id, claude, codex, apiAuth)
        const key = apiKeyInput.trim()
        if (!status.ready && !key) {
          const providerLabel = provider === 'openai_api' ? 'OpenAI' : provider === 'gemini_api' ? 'Gemini' : 'Anthropic'
          setError(`请先填写 ${providerLabel} API key。`)
          return
        }
        if (key) {
          await onSaveApiKey(provider, key)
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
            <h2 className="text-lg font-semibold text-text-primary">接入天机阁</h2>
            <p className="text-xs text-text-muted">选择用于天机阁对话和调度的模型通道。</p>
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
            <div className="rounded-lg border border-border-primary bg-surface-secondary px-3 py-2 text-xs text-text-secondary">
              <span className="font-medium text-text-primary">天机阁</span> 是江湖的对话与调度入口，可用于了解现状、推动帮派和处理委托。
            </div>
            <p className="text-xs text-text-secondary">
              选择模型接入方式。OpenAI Codex OAuth 可通过 ChatGPT 账号登录；API 路径使用密钥。
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {PATHS.map((path) => {
                const isRecommended = path.id === recommendedId
                const isSelected = path.id === selectedPathId
                const status = getPathStatus(path.id, claude, codex, apiAuth)
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
            const status = getPathStatus(selectedPathId, claude, codex, apiAuth)
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
                  const auth = selectedPathId === 'openai_api' ? apiAuth?.openai : apiAuth?.anthropic
                  return (
                    <div className="mt-3 pt-3 border-t border-border-primary space-y-2">
                      <label className="block text-xs font-medium text-text-secondary">
                        {selectedPathId === 'openai_api' ? 'OpenAI API key' : 'Anthropic API key'}
                      </label>
                      {auth?.maskedKey && (
                        <div className="flex items-center gap-2 text-xs">
                          <span className="text-text-muted">当前：</span>
                          <code className="px-1.5 py-0.5 rounded bg-surface-primary border border-border-primary text-text-secondary font-mono">
                            {auth.maskedKey}
                          </code>
                          <span className="text-text-muted">
                            ({describeApiAuthSource(auth)})
                          </span>
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
                          ? '密钥会与帮派设置共享。粘贴新密钥可替换。'
                          : '点击连接时会校验并保存密钥。'}
                      </p>
                    </div>
                  )
                })()}

                {!status.ready && !isSubPath(selectedPathId) && (
                  <p className="text-xs text-status-warning mt-2">
                    当前通道还没有配置完成，天机阁需要接通后才能使用。
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
            {busy ? '连接中...' : '连接天机阁'}
          </button>
        </div>
      </div>
    </div>
  )
}
