import { useState, useEffect } from 'react'
import { storageSet } from '../lib/storage'
import { API_BASE } from '../lib/auth'
import {
  detectPlatform,
  pickLatestStableRelease,
  parseReleaseAssets,
  bestDownloadUrl,
  type ReleaseAssets,
  type GithubRelease,
} from '../lib/releases'

interface ConnectPageProps {
  port: string
  onRetry: () => void
}

const REPO_URL = 'https://github.com/Wang-snail/jianghu'
const RELEASES_PAGE = `${REPO_URL}/releases`

const PLATFORM_INFO: Record<string, { label: string; note: string; steps: string[] }> = {
  mac: {
    label: '下载 macOS 版本',
    note: 'Apple Silicon + Intel',
    steps: ['打开下载的 .pkg 文件', '按照安装程序步骤操作'],
  },
  windows: {
    label: '下载 Windows 版本',
    note: '64位',
    steps: ['运行下载的安装程序', '按照设置向导操作'],
  },
  linux: {
    label: '下载 Linux 版本',
    note: 'x64',
    steps: ['从仓库下载发布包或按源码方式运行'],
  },
}

function useReleaseAssets(): { assets: ReleaseAssets; releaseUrl: string } {
  const empty: ReleaseAssets = {
    mac: { installer: null, archive: null },
    windows: { installer: null, archive: null },
    linux: { installer: null, archive: null },
  }
  const [assets, setAssets] = useState<ReleaseAssets>(empty)
  const [releaseUrl, setReleaseUrl] = useState<string>(RELEASES_PAGE)

  useEffect(() => {
    fetch('https://api.github.com/repos/Wang-snail/jianghu/releases?per_page=20')
      .then(r => r.ok ? r.json() as Promise<GithubRelease[]> : null)
      .then((releases) => {
        if (!releases || releases.length === 0) return
        const latest = pickLatestStableRelease(releases)
        if (!latest?.assets) return
        setReleaseUrl(latest.html_url || RELEASES_PAGE)
        setAssets(parseReleaseAssets(latest))
      })
      .catch(() => {})
  }, [])
  return { assets, releaseUrl }
}

export function ConnectPage({ port, onRetry }: ConnectPageProps): React.JSX.Element {
  const [editPort, setEditPort] = useState(port)
  const [retrying, setRetrying] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [restartError, setRestartError] = useState<string | null>(null)
  const [showDev, setShowDev] = useState(false)
  const platform = detectPlatform()
  const info = PLATFORM_INFO[platform]
  const { assets, releaseUrl } = useReleaseAssets()

  function handleRetry(): void {
    storageSet('jianghu_port', editPort)
    setRestartError(null)
    setRetrying(true)
    onRetry()
  }

  async function handleRestart(): Promise<void> {
    storageSet('jianghu_port', editPort)
    setRestartError(null)
    setRestarting(true)
    try {
      const res = await fetch(`${API_BASE}/api/server/restart`, {
        method: 'POST',
        cache: 'no-store',
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setTimeout(() => {
        setRestarting(false)
        handleRetry()
      }, 1800)
    } catch {
      setRestarting(false)
      setRestartError('无法触发重启。请手动启动服务器：jianghu serve')
    }
  }

  return (
    <div className="flex flex-col h-screen bg-surface-primary items-center justify-center px-4 overflow-y-auto">
      <div className="max-w-sm w-full py-8 space-y-6 text-center">
        {/* Title */}
        <div>
          <h1 className="text-xl font-bold text-text-primary">江湖</h1>
          <p className="text-sm text-text-muted mt-1">开源本地 AI 智能体框架</p>
        </div>

        {/* Status */}
        <div className="bg-surface-secondary rounded-lg p-4 space-y-2 shadow-sm">
          <div className="flex items-center justify-center gap-2">
            <span className="w-2 h-2 rounded-full bg-status-error" />
            <span className="text-sm text-status-error font-medium">无法连接到本地服务器</span>
          </div>
          <p className="text-xs text-text-muted">
            江湖完全在您的本地机器上运行。请下载并启动它以继续。
          </p>
        </div>

        {/* Download — primary action */}
        <div className="space-y-3">
          <a
            href={bestDownloadUrl(assets[platform], releaseUrl)}
            className="block w-full py-3 text-sm font-medium text-text-invert bg-interactive hover:bg-interactive-hover rounded-lg transition-colors shadow-sm"
          >
            {info.label}
          </a>
          <p className="text-xs text-text-muted">
            {info.note} &middot; 无需其他依赖
            {assets[platform].archive && assets[platform].installer && (
              <> &middot; <a href={assets[platform].archive!} className="underline hover:text-text-secondary">便携版压缩包</a></>
            )}
          </p>

          {/* Other platforms */}
          <div className="flex items-center justify-center gap-3 text-xs">
            {platform !== 'mac' && (
              <a href={bestDownloadUrl(assets.mac, releaseUrl)} className="text-text-muted hover:text-text-secondary underline">macOS</a>
            )}
            {platform !== 'windows' && (
              <a href={bestDownloadUrl(assets.windows, releaseUrl)} className="text-text-muted hover:text-text-secondary underline">Windows</a>
            )}
            {platform !== 'linux' && (
              <a href={bestDownloadUrl(assets.linux, releaseUrl)} className="text-text-muted hover:text-text-secondary underline">Linux</a>
            )}
          </div>
        </div>

        {/* Quick start after download */}
        <div className="bg-surface-secondary rounded-lg p-4 text-left space-y-2 shadow-sm">
          <p className="text-xs font-medium text-text-muted uppercase tracking-wide">下载后的步骤</p>
          <div className="space-y-1.5">
            {info.steps.map((step, i) => (
              <div key={i} className="flex items-start gap-2">
                <span className="text-xs text-text-muted font-mono mt-0.5 shrink-0">{i + 1}.</span>
                <span className="text-sm text-text-secondary">{step}</span>
              </div>
            ))}
            <div className="flex items-start gap-2">
              <span className="text-xs text-text-muted font-mono mt-0.5 shrink-0">{info.steps.length + 1}.</span>
              <span className="text-sm text-text-secondary">Run <code className="text-xs bg-surface-tertiary px-1.5 py-0.5 rounded font-mono text-text-primary">jianghu serve</code></span>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-xs text-text-muted font-mono mt-0.5 shrink-0">{info.steps.length + 2}.</span>
              <span className="text-sm text-text-muted">此页面将自动重定向</span>
            </div>
          </div>
        </div>

        {/* Developer install — collapsible */}
        <div>
          <button
            onClick={() => setShowDev(!showDev)}
            className="text-xs text-text-muted hover:text-text-secondary transition-colors"
          >
            {showDev ? '隐藏' : '显示'} 开发者安装方式 (npm / Homebrew)
          </button>
          {showDev && (
            <div className="mt-2 bg-surface-secondary rounded-lg p-4 text-left space-y-2 shadow-sm">
              <div className="flex items-start gap-2">
                <span className="text-xs text-text-muted shrink-0">源码:</span>
                <code className="text-xs bg-surface-tertiary px-2 py-1 rounded text-text-primary font-mono">git clone {REPO_URL} &amp;&amp; cd jianghu &amp;&amp; npm install &amp;&amp; npm run dev:room</code>
              </div>
              <div className="flex items-start gap-2">
                <span className="text-xs text-text-muted shrink-0">本地:</span>
                <code className="text-xs bg-surface-tertiary px-2 py-1 rounded text-text-primary font-mono">npm run dev:room</code>
              </div>
            </div>
          )}
        </div>

        {/* Port + Retry */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-center gap-2">
          <span className="text-xs text-text-muted">端口:</span>
          <input
            type="number"
            value={editPort}
            onChange={(e) => setEditPort(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleRetry() }}
            className="w-16 px-2 py-1 text-sm border border-border-primary rounded-lg text-center font-mono bg-surface-primary text-text-primary"
          />
          <button
            onClick={handleRetry}
            disabled={retrying || restarting}
            className="text-sm px-4 py-1.5 text-text-secondary hover:text-text-primary border border-border-primary hover:border-interactive rounded-lg transition-colors disabled:opacity-40"
          >
            {retrying ? '连接中...' : '重试'}
          </button>
          <button
            onClick={() => void handleRestart()}
            disabled={retrying || restarting}
            className="text-sm px-4 py-1.5 rounded-lg bg-interactive text-text-invert hover:bg-interactive-hover transition-colors disabled:opacity-40"
          >
            {restarting ? '重启中...' : '重启'}
          </button>
          </div>
          <p className="text-[11px] text-text-muted text-center">
            重试仅检查连接。重启会重新启动本地服务器，然后重试。
          </p>
          {restartError && (
            <p className="text-[11px] text-status-error text-center">{restartError}</p>
          )}
        </div>

        {/* Links */}
        <div className="flex items-center justify-center gap-3">
          <a href={REPO_URL} target="_blank" rel="noopener noreferrer" className="text-xs text-text-muted hover:text-text-secondary">GitHub</a>
          <span className="text-border-primary">|</span>
          <a href={RELEASES_PAGE} target="_blank" rel="noopener noreferrer" className="text-xs text-text-muted hover:text-text-secondary">所有版本</a>
          <span className="text-border-primary">|</span>
          <a href={`${REPO_URL}/issues/new`} target="_blank" rel="noopener noreferrer" className="text-xs text-text-muted hover:text-text-secondary">报告问题</a>
          <span className="text-border-primary">|</span>
          <button
            onClick={() => window.open(`${REPO_URL}/issues/new`)}
            className="text-xs text-text-muted hover:text-text-secondary"
          >
            反馈连接问题
          </button>
        </div>

        {/* Privacy */}
        <p className="text-xs text-text-muted opacity-60">
          100% 本地运行 — 所有数据都在您的机器上。此页面不包含后端服务。
        </p>
      </div>
    </div>
  )
}
