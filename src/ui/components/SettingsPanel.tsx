import { useEffect, useState } from 'react'
import { useContainerWidth } from '../hooks/useContainerWidth'
import { useTheme } from '../hooks/useTheme'
import { api } from '../lib/client'
import { API_BASE, APP_MODE, clearToken, getToken } from '../lib/auth'
import { storageGet, storageSet } from '../lib/storage'
import * as notif from '../lib/notifications'
import { semverGt } from '../lib/releases'
import { shouldShowManualUpdateControls } from '../lib/update-visibility'

interface SettingsPanelProps {
  advancedMode: boolean
  onAdvancedModeChange: (enabled: boolean) => void
}

interface UpdateInfo {
  latestVersion: string
  releaseUrl: string
  assets: { mac: string | null; windows: string | null; linux: string | null }
}

interface ServerStatus {
  version: string
  uptime: number
  deploymentMode?: 'local' | 'cloud'
  dataDir?: string
  dbPath?: string
  claude?: { available: boolean; version?: string }
  codex?: { available: boolean; version?: string }
  resources?: { cpuCount: number; loadAvg1m: number; loadAvg5m: number; memTotalGb: number; memFreeGb: number; memUsedPct: number }
  updateInfo?: UpdateInfo | null
  readyUpdateVersion?: string | null
}

export function SettingsPanel({ advancedMode, onAdvancedModeChange }: SettingsPanelProps): React.JSX.Element {
  const [containerRef, containerWidth] = useContainerWidth<HTMLDivElement>()
  const wide = containerWidth >= 600
  const [notifications, setNotifications] = useState<boolean | null>(null)
  const [notifDenied, setNotifDenied] = useState(false)
  const [serverStatus, setServerStatus] = useState<ServerStatus | null>(null)
  const [updateChecking, setUpdateChecking] = useState(false)
  const [updateChecked, setUpdateChecked] = useState(false)
  const [claudePlan, setClaudePlan] = useState<'pro' | 'max' | 'api' | null>(null)
  const [chatGptPlan, setChatGptPlan] = useState<'plus' | 'pro' | 'api' | null>(null)
  const [queenModel, setQueenModel] = useState<string | null>(null)
  const [telemetryEnabled, setTelemetryEnabled] = useState<boolean | null>(null)
  const [discordAppId, setDiscordAppId] = useState('')
  const [discordPublicKey, setDiscordPublicKey] = useState('')
  const [discordToken, setDiscordToken] = useState('')
  const [discordBusy, setDiscordBusy] = useState(false)
  const [discordFeedback, setDiscordFeedback] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)

  // 自定义模型配置
  const [showCustomModelSettings, setShowCustomModelSettings] = useState(false)
  const [customModelUrl, setCustomModelUrl] = useState('')
  const [customModelKey, setCustomModelKey] = useState('')
  const [customModelName, setCustomModelName] = useState('')
  const [customModelError, setCustomModelError] = useState<string | null>(null)
  const [customModelSuccess, setCustomModelSuccess] = useState<string | null>(null)
  const [customModelLinkTesting, setCustomModelLinkTesting] = useState(false)
  const [customModelLinkFeedback, setCustomModelLinkFeedback] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)

  const { theme, setTheme } = useTheme()
  const deploymentMode = APP_MODE === 'cloud' || serverStatus?.deploymentMode === 'cloud' ? 'cloud' : 'local'
  const showManualUpdateControls = shouldShowManualUpdateControls(deploymentMode)

  async function handleCheckForUpdates(): Promise<void> {
    setUpdateChecking(true)
    try {
      await api.status.checkUpdate()
      const status = await api.status.getParts(['update'])
      setServerStatus(prev => ({ ...(prev ?? status), ...status }))
      setUpdateChecked(true)
    } catch {
      // ignore
    } finally {
      setUpdateChecking(false)
    }
  }

  useEffect(() => {
    api.settings.get('notifications_enabled').then((v) => {
      setNotifications(v !== 'false')
    }).catch(() => setNotifications(true))

    Promise.all([
      api.status.getParts(['providers', 'resources']),
      api.status.getParts(['storage', 'update']),
    ])
      .then(([runtime, meta]) => setServerStatus({ ...runtime, ...meta }))
      .catch(() => {})

    api.settings.get('claude_plan').then((v) => {
      const valid = ['pro', 'max', 'api'] as const
      const plan = valid.find(p => p === v) ?? null
      setClaudePlan(plan)
    }).catch(() => {})

    api.settings.get('chatgpt_plan').then((v) => {
      const valid = ['plus', 'pro', 'api'] as const
      const plan = valid.find(p => p === v) ?? null
      setChatGptPlan(plan)
    }).catch(() => {})

    api.settings.get('global_model').then((v) => {
      setQueenModel(v || null)
    }).catch(() => setQueenModel(null))

    api.settings.get('telemetry_enabled').then((v) => {
      setTelemetryEnabled(v !== 'false')
    }).catch(() => setTelemetryEnabled(true))

    api.settings.get('custom_model').then((v) => {
      if (!v) return
      try {
        const parsed = JSON.parse(v) as Record<string, unknown>
        if (typeof parsed.url === 'string') setCustomModelUrl(parsed.url)
        if (typeof parsed.key === 'string') setCustomModelKey(parsed.key)
        if (typeof parsed.model === 'string') setCustomModelName(parsed.model)
      } catch {
        // Ignore older malformed local settings.
      }
    }).catch(() => {})

    Promise.all([
      api.settings.get('discord_APP_ID').catch(() => ''),
      api.settings.get('discord_公钥').catch(() => ''),
      api.settings.get('discord_令牌').catch(() => ''),
    ]).then(([appId, publicKey, token]) => {
      setDiscordAppId(appId ?? '')
      setDiscordPublicKey(publicKey ?? '')
      setDiscordToken(token ?? '')
    }).catch(() => {})

  }, [])

  async function setClaudePlanSetting(plan: 'pro' | 'max' | 'api' | null): Promise<void> {
    await api.settings.set('claude_plan', plan ?? '')
    setClaudePlan(plan)
  }

  async function setChatGptPlanSetting(plan: 'plus' | 'pro' | 'api' | null): Promise<void> {
    await api.settings.set('chatgpt_plan', plan ?? '')
    setChatGptPlan(plan)
  }

  async function setQueenModelSetting(model: string): Promise<void> {
    await api.settings.set('global_model', model)
    setQueenModel(model)
  }

  async function saveDiscordConnection(): Promise<void> {
    setDiscordBusy(true)
    setDiscordFeedback(null)
    try {
      await Promise.all([
        api.settings.set('discord_APP_ID', discordAppId.trim()),
        api.settings.set('discord_公钥', discordPublicKey.trim()),
        api.settings.set('discord_令牌', discordToken.trim()),
      ])
      setDiscordFeedback({ kind: 'success', text: 'Discord 通讯凭据已保存到本地，天机阁会通过本机设置读取。' })
    } catch (error) {
      setDiscordFeedback({ kind: 'error', text: error instanceof Error ? error.message : '保存 Discord 通讯凭据失败。' })
    } finally {
      setDiscordBusy(false)
    }
  }

  async function testCustomModelLink(): Promise<void> {
    const url = customModelUrl.trim()
    if (!url) {
      setCustomModelLinkFeedback({ kind: 'error', text: '请先填写 API 地址。' })
      return
    }

    setCustomModelLinkTesting(true)
    setCustomModelLinkFeedback(null)
    try {
      const result = await api.settings.testCustomModelUrl(url)
      setCustomModelLinkFeedback({ kind: 'success', text: result.message || '链接可用。' })
    } catch (error) {
      setCustomModelLinkFeedback({
        kind: 'error',
        text: error instanceof Error ? error.message : '链接测试失败。'
      })
    } finally {
      setCustomModelLinkTesting(false)
    }
  }

  async function saveCustomModelConfig(): Promise<void> {
    if (!customModelUrl || !customModelKey || !customModelName) {
      setCustomModelError('请填写所有字段')
      return
    }
    try {
      await api.settings.set('custom_model', JSON.stringify({
        url: customModelUrl.trim(),
        key: customModelKey.trim(),
        model: customModelName.trim()
      }))
      setCustomModelError(null)
      setCustomModelSuccess('自定义模型配置已保存')
      setTimeout(() => setCustomModelSuccess(null), 3000)
    } catch (error) {
      setCustomModelError(error instanceof Error ? error.message : '保存失败')
    }
  }

  async function toggleTelemetry(): Promise<void> {
    const next = !telemetryEnabled
    await api.settings.set('telemetry_enabled', String(next))
    setTelemetryEnabled(next)
  }

  async function toggleAdvancedMode(): Promise<void> {
    const next = !advancedMode
    await api.settings.set('advanced_mode', String(next))
    onAdvancedModeChange(next)
  }

  async function toggleNotifications(): Promise<void> {
    const next = !notifications
    if (next && notif.isSupported()) {
      const granted = await notif.requestPermission()
      if (!granted) {
        setNotifDenied(true)
        return
      }
      setNotifDenied(false)
    }
    await api.settings.set('notifications_enabled', String(next))
    setNotifications(next)
  }

  function formatUptime(seconds: number): string {
    if (seconds < 60) return `${seconds}s`
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
    const h = Math.floor(seconds / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    return m > 0 ? `${h}h ${m}m` : `${h}h`
  }

  function toggle(
    label: string,
    value: boolean | null,
    onChange: () => void,
    description?: string
  ): React.JSX.Element {
    const loading = value === null
    return (
      <div className="py-1.5">
        <div className="flex items-center justify-between text-sm">
          <span className="text-text-secondary">{label}</span>
          <button
            onClick={onChange}
            disabled={loading}
            className={`w-9 h-5 rounded-full transition-colors relative ${
              loading ? 'bg-surface-tertiary' : value ? 'bg-interactive' : 'bg-text-muted'
            }`}
          >
            {!loading && (
              <span
                className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition-transform shadow-sm ${
                  value ? 'left-4.5' : 'left-0.5'
                }`}
              />
            )}
          </button>
        </div>
        {description && (
          <p className="text-xs text-text-muted mt-0.5 leading-tight">{description}</p>
        )}
      </div>
    )
  }

  function row(label: string, value: string | null): React.JSX.Element {
    return (
      <div className="flex flex-col py-2">
        <span className="text-sm font-medium text-text-secondary">{label}</span>
        <span className="text-xs text-text-muted truncate selectable">{value ?? '\u2014'}</span>
      </div>
    )
  }

  const themeOptions: Array<{ value: 'light' | 'dark' | 'system'; label: string; icon: string }> = [
    { value: 'light', label: '浅色', icon: '\u2600' },
    { value: 'dark', label: '深色', icon: '\u263E' },
    { value: 'system', label: '跟随系统', icon: '\u2699' },
  ]

  const preferencesSection = (
    <div>
      <h3 className="text-sm font-semibold text-text-primary mb-2">外观与设置</h3>
      <div className="bg-surface-secondary rounded-lg p-3 space-y-1 shadow-sm">
        {/* Theme toggle */}
        <div className="py-1.5">
          <div className="flex items-center justify-between text-sm">
            <span className="text-text-secondary">主题</span>
            <div className="flex rounded-lg overflow-hidden border border-border-primary">
              {themeOptions.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setTheme(opt.value)}
                  className={`px-2.5 py-1 text-xs font-medium transition-colors ${
                    theme === opt.value
                      ? 'bg-interactive text-text-invert'
                      : 'bg-surface-primary text-text-muted hover:bg-surface-tertiary'
                  }`}
                >{opt.icon} {opt.label}</button>
              ))}
            </div>
          </div>
        </div>
        {toggle('消息通知', notifications, toggleNotifications, '当天机阁或弟子发送消息时通知您')}
        {notifDenied && (
          <p className="text-xs text-status-error mt-0.5 leading-tight">浏览器拒绝了通知权限。请在浏览器设置中允许通知。</p>
        )}
        {toggle('高级模式', advancedMode, toggleAdvancedMode, '显示记忆和额外控制选项')}
        {toggle('数据遥测', telemetryEnabled, toggleTelemetry, '本地记录运行健康数据，用于帮派纵览和排障。')}
        <div className="py-1.5">
          <div className="flex items-center justify-between text-sm">
            <span className="text-text-secondary">Claude订阅方案</span>
            <div className="flex rounded-lg overflow-hidden border border-border-primary">
              <button
                onClick={() => setClaudePlanSetting(null)}
                className={`px-2.5 py-1 text-xs font-medium transition-colors ${
                  claudePlan === null
                    ? 'bg-text-muted text-text-invert'
                    : 'bg-surface-primary text-text-muted hover:bg-surface-tertiary'
                }`}
              >{'\u2014'}</button>
              {(['pro', 'max', 'api'] as const).map((p) => (
                <button
                  key={p}
                  onClick={() => setClaudePlanSetting(p)}
                  className={`px-2.5 py-1 text-xs font-medium transition-colors ${
                    claudePlan === p
                      ? 'bg-interactive text-text-invert'
                      : 'bg-surface-primary text-text-muted hover:bg-surface-tertiary'
                  }`}
                >{p === 'api' ? 'API' : p.charAt(0).toUpperCase() + p.slice(1)}</button>
              ))}
            </div>
          </div>
          <p className="text-xs text-text-muted mt-0.5 leading-tight">根据您的订阅方案优化天机阁循环间隔和最大回合数</p>
        </div>
        <div className="py-1.5">
          <div className="flex items-center justify-between text-sm">
            <span className="text-text-secondary">ChatGPT订阅方案</span>
            <div className="flex rounded-lg overflow-hidden border border-border-primary">
              <button
                onClick={() => setChatGptPlanSetting(null)}
                className={`px-2.5 py-1 text-xs font-medium transition-colors ${
                  chatGptPlan === null
                    ? 'bg-text-muted text-text-invert'
                    : 'bg-surface-primary text-text-muted hover:bg-surface-tertiary'
                }`}
              >{'\u2014'}</button>
              {(['plus', 'pro', 'api'] as const).map((p) => (
                <button
                  key={p}
                  onClick={() => setChatGptPlanSetting(p)}
                  className={`px-2.5 py-1 text-xs font-medium transition-colors ${
                    chatGptPlan === p
                      ? 'bg-interactive text-text-invert'
                      : 'bg-surface-primary text-text-muted hover:bg-surface-tertiary'
                  }`}
                >{p === 'api' ? 'API' : p.charAt(0).toUpperCase() + p.slice(1)}</button>
              ))}
            </div>
          </div>
          <p className="text-xs text-text-muted mt-0.5 leading-tight">使用 OpenAI Codex OAuth 时优化天机阁默认设置，不需要在这里填写 OpenAI API key</p>
        </div>
        <div className="py-1.5">
          <div className="flex items-center justify-between text-sm">
            <span className="text-text-secondary">全局模型</span>
            <div className="flex rounded-lg overflow-hidden border border-border-primary">
              {([
                ['claude', 'Claude'],
                ['codex', 'Codex OAuth'],
                ['openai:gpt-4o-mini', 'OpenAI API'],
                ['anthropic:claude-3-5-sonnet-latest', 'Claude API'],
                ['mimo:MiMo-V2.5-Pro', 'MiMo Pro'],
                ['mimo:MiMo-V2.5', 'MiMo 2.5'],
                ['mimo:MiMo-V2-Pro', 'MiMo V2 Pro'],
                ['gemini:gemini-2.5-flash', 'Gemini API'],
                ['custom', '自定义']
              ] as const).map(([id, label]) => (
                <button
                  key={id}
                  onClick={() => setQueenModelSetting(id)}
                  className={`px-2.5 py-1 text-xs font-medium transition-colors ${
                    (queenModel ?? 'claude') === id
                      ? 'bg-interactive text-text-invert'
                      : 'bg-surface-primary text-text-muted hover:bg-surface-tertiary'
                  }`}
                >{label}</button>
              ))}
            </div>
          </div>
          <p className="text-xs text-text-muted mt-0.5 leading-tight">默认用于天机阁、帮主和弟子。单个角色只有明确单独设置时才覆盖全局模型。</p>
        </div>

        {/* 自定义模型配置 */}
        <div className="py-1.5">
          <div className="flex items-center justify-between text-sm mb-2">
            <span className="text-text-secondary">自定义模型配置</span>
            <button
              onClick={() => {
                setShowCustomModelSettings(!showCustomModelSettings)
              }}
              className="text-xs text-interactive hover:underline"
            >
              {showCustomModelSettings ? '收起' : '展开'}
            </button>
          </div>
          {showCustomModelSettings && (
            <div className="space-y-2 pt-2 border-t border-border-secondary mt-2">
              <div className="space-y-1.5">
                <label className="block text-xs text-text-secondary">API地址</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={customModelUrl}
                    onChange={(e) => {
                      setCustomModelUrl(e.target.value)
                      setCustomModelLinkFeedback(null)
                    }}
                    placeholder="https://api.example.com/v1"
                    className="min-w-0 flex-1 px-2 py-1.5 text-xs border border-border-primary rounded bg-surface-primary text-text-primary placeholder:text-text-muted focus:outline-none focus:border-interactive"
                  />
                  <button
                    type="button"
                    onClick={testCustomModelLink}
                    disabled={!customModelUrl.trim() || customModelLinkTesting}
                    className="shrink-0 px-3 py-1.5 text-xs bg-surface-primary border border-border-primary text-text-secondary rounded hover:bg-surface-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {customModelLinkTesting ? '测试中' : '测试链接'}
                  </button>
                </div>
                {customModelLinkFeedback && (
                  <p className={`text-xs ${customModelLinkFeedback.kind === 'success' ? 'text-status-success' : 'text-status-error'}`}>
                    {customModelLinkFeedback.text}
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <label className="block text-xs text-text-secondary">API密钥</label>
                <input
                  type="password"
                  value={customModelKey}
                  onChange={(e) => setCustomModelKey(e.target.value)}
                  placeholder="sk-..."
                  className="w-full px-2 py-1.5 text-xs border border-border-primary rounded bg-surface-primary text-text-primary placeholder:text-text-muted focus:outline-none focus:border-interactive"
                />
              </div>
              <div className="space-y-1.5">
                <label className="block text-xs text-text-secondary">模型名称</label>
                <input
                  type="text"
                  value={customModelName}
                  onChange={(e) => setCustomModelName(e.target.value)}
                  placeholder="custom-model-name"
                  className="w-full px-2 py-1.5 text-xs border border-border-primary rounded bg-surface-primary text-text-primary placeholder:text-text-muted focus:outline-none focus:border-interactive"
                />
              </div>
              <button
                onClick={saveCustomModelConfig}
                disabled={!customModelUrl || !customModelKey || !customModelName}
                className="w-full px-3 py-1.5 text-xs bg-interactive text-text-invert rounded-lg hover:bg-interactive-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                保存配置
              </button>
              {customModelSuccess && (
                <p className="text-xs text-status-success">{customModelSuccess}</p>
              )}
              {customModelError && (
                <p className="text-xs text-status-error">{customModelError}</p>
              )}
              <p className="text-xs text-text-muted leading-tight">配置自定义兼容API的模型（如OpenAI兼容接口），配置后选择"自定义"选项即可使用</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )

  const communicationSection = (
    <div>
      <h3 className="text-sm font-semibold text-text-primary mb-2">Discord 通讯设置</h3>
      <div className="bg-surface-secondary rounded-lg p-3 space-y-3 shadow-sm">
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-text-secondary">Discord</span>
            <span className={discordAppId && discordPublicKey && discordToken ? 'text-status-success' : 'text-text-muted'}>
              {discordAppId && discordPublicKey && discordToken ? '已配置' : '未配置'}
            </span>
          </div>
          <div className="grid gap-2">
            <input
              type="text"
              value={discordAppId}
              onChange={(e) => setDiscordAppId(e.target.value)}
              placeholder="discord_APP_ID"
              className="w-full px-3 py-2 rounded-lg bg-surface-primary border border-border-primary text-sm text-text-primary placeholder:text-text-muted focus:outline-none"
            />
            <input
              type="text"
              value={discordPublicKey}
              onChange={(e) => setDiscordPublicKey(e.target.value)}
              placeholder="discord_公钥"
              className="w-full px-3 py-2 rounded-lg bg-surface-primary border border-border-primary text-sm text-text-primary placeholder:text-text-muted focus:outline-none"
            />
            <input
              type="password"
              value={discordToken}
              onChange={(e) => setDiscordToken(e.target.value)}
              placeholder="discord_令牌"
              className="w-full px-3 py-2 rounded-lg bg-surface-primary border border-border-primary text-sm text-text-primary placeholder:text-text-muted focus:outline-none"
            />
          </div>
          <button
            onClick={() => { void saveDiscordConnection() }}
            disabled={discordBusy || !discordAppId.trim() || !discordPublicKey.trim() || !discordToken.trim()}
            className="px-3 py-2 rounded-lg bg-interactive text-text-invert text-sm font-medium hover:bg-interactive-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {discordBusy ? '连接中...' : '连接 Discord'}
          </button>
          {discordFeedback && (
            <p className={`text-xs ${discordFeedback.kind === 'success' ? 'text-status-success' : 'text-status-error'}`}>
              {discordFeedback.text}
            </p>
          )}
          <p className="text-xs text-text-muted leading-tight">凭据只保存在当前项目本地设置中，用于不限设备的天机阁通讯入口。</p>
        </div>
      </div>
    </div>
  )

  const connectionSection = (
    <div>
      <h3 className="text-sm font-semibold text-text-primary mb-2">连接状态</h3>
      <div className="bg-surface-secondary rounded-lg p-3 space-y-1.5 shadow-sm">
        <div className="flex items-center justify-between text-sm">
          <span className="text-text-secondary">API服务器</span>
          <span className="flex items-center gap-1.5">
            <span className={`w-2 h-2 rounded-full ${serverStatus ? 'bg-status-success' : 'bg-status-error'}`} />
            <span className={serverStatus ? 'text-status-success' : 'text-status-error'}>
              {serverStatus ? '已连接' : '未连接'}
            </span>
          </span>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-text-secondary">服务器URL</span>
          <span className="text-text-muted font-mono text-xs">{API_BASE || location.origin}</span>
        </div>
        {API_BASE && API_BASE.includes('localhost') && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-text-secondary">端口</span>
            <div className="flex items-center gap-1">
              <input
                type="number"
                defaultValue={storageGet('jianghu_port') || '4700'}
                className="w-16 px-2 py-1 text-xs border border-border-primary rounded text-center font-mono bg-surface-primary text-text-primary"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    storageSet('jianghu_port', (e.target as HTMLInputElement).value)
                    clearToken()
                    location.reload()
                  }
                }}
              />
            </div>
          </div>
        )}
        <div className="flex items-center justify-between text-sm">
          <span className="text-text-secondary">Claude Code</span>
          <span className="flex items-center gap-1.5">
            {claudePlan && (
              <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-interactive-bg text-interactive uppercase tracking-wide">
                {claudePlan}
              </span>
            )}
            <span className={serverStatus?.claude?.available ? 'text-status-success' : 'text-text-muted'}>
              {serverStatus === null
                ? '...'
                : serverStatus.claude?.available
                  ? serverStatus.claude.version || '已检测'
                  : '未检测'}
            </span>
          </span>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-text-secondary">Codex</span>
          <span className="flex items-center gap-1.5">
            {chatGptPlan && (
              <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-interactive-bg text-interactive uppercase tracking-wide">
                {chatGptPlan}
              </span>
            )}
            <span className={serverStatus?.codex?.available ? 'text-status-success' : 'text-text-muted'}>
              {serverStatus === null
                ? '...'
                : serverStatus.codex?.available
                  ? serverStatus.codex.version || '已检测'
                  : '未检测'}
            </span>
          </span>
        </div>
        {serverStatus?.resources && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-text-secondary">负载</span>
            <span className={serverStatus.resources.memUsedPct > 85 || serverStatus.resources.loadAvg1m > serverStatus.resources.cpuCount * 0.8 ? 'text-status-warning' : 'text-text-muted'}>
              CPU {Math.round(serverStatus.resources.loadAvg1m / serverStatus.resources.cpuCount * 100)}%
              {' \u00B7 '}内存 {serverStatus.resources.memUsedPct}%
            </span>
          </div>
        )}
        {serverStatus && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-text-secondary">运行时间</span>
            <span className="text-text-muted">{formatUptime(serverStatus.uptime)}</span>
          </div>
        )}
      </div>
    </div>
  )

  const serverSection = (
    <div>
      <h3 className="text-sm font-semibold text-text-primary mb-2">服务器信息</h3>
      <div className="bg-surface-secondary rounded-lg p-3 divide-y divide-border-secondary shadow-sm">
        <div className="flex items-center justify-between text-sm py-2">
          <span className="font-medium text-text-secondary">版本</span>
          <div className="flex items-center gap-2">
            <span className="text-text-muted">{serverStatus?.version ?? '...'}</span>
            {showManualUpdateControls && (() => {
              const ui = serverStatus?.updateInfo
              const hasUpdate = ui && serverStatus && semverGt(ui.latestVersion, serverStatus.version)
              if (hasUpdate) return null
              if (updateChecking) return <span className="text-text-muted">检查中...</span>
              if (updateChecked) return <span className="text-status-success">已是最新</span>
              return (
                <button
                  onClick={() => void handleCheckForUpdates()}
                  className="px-2.5 py-1 text-xs bg-interactive text-text-invert rounded-lg hover:bg-interactive-hover transition-colors"
                >
                  检查
                </button>
              )
            })()}
          </div>
        </div>
        {showManualUpdateControls && (() => {
          const ui = serverStatus?.updateInfo
          if (!ui || !serverStatus) return null
          if (!semverGt(ui.latestVersion, serverStatus.version)) return null
          const isReady = !!serverStatus.readyUpdateVersion
          return (
            <div className="flex items-center justify-between text-sm py-2">
              <span className="font-medium text-status-success">
                v{ui.latestVersion} {isReady ? '就绪' : '可用'}
              </span>
              {isReady ? (
                <button
                  onClick={async () => {
                    await fetch(`${API_BASE}/api/server/update-restart`, { method: 'POST' })
                    setTimeout(() => {
                      const poll = setInterval(async () => {
                        try {
                          const res = await fetch(`${API_BASE}/api/status`)
                          if (res.ok) { clearInterval(poll); window.location.reload() }
                        } catch { /* server still restarting */ }
                      }, 1000)
                      setTimeout(() => clearInterval(poll), 30_000)
                    }, 2000)
                  }}
                  className="px-3 py-1 bg-interactive text-text-invert rounded-lg hover:bg-interactive-hover transition-colors"
                >
                  重启更新
                </button>
              ) : (
                <button
                  onClick={async () => {
                    const token = await getToken()
                    const a = document.createElement('a')
                    a.href = `${API_BASE}/api/status/update/download?token=${encodeURIComponent(token)}`
                    document.body.appendChild(a)
                    a.click()
                    document.body.removeChild(a)
                  }}
                  className="px-3 py-1 bg-interactive text-text-invert rounded-lg hover:bg-interactive-hover transition-colors"
                >
                  下载更新
                </button>
              )}
            </div>
          )
        })()}
        {row('数据库', serverStatus?.dbPath ?? null)}
        {row('数据目录', serverStatus?.dataDir ?? null)}
      </div>
    </div>
  )

  return (
    <div ref={containerRef} className="p-5">
      {wide ? (
        <div className="grid grid-cols-2 gap-5 items-start">
          <div className="space-y-5">
            {communicationSection}
          </div>
          <div className="space-y-5">
            {preferencesSection}
            {connectionSection}
            {serverSection}
          </div>
        </div>
      ) : (
        <div className="space-y-5">
          {communicationSection}
          {preferencesSection}
          {connectionSection}
          {serverSection}
        </div>
      )}
    </div>
  )
}
