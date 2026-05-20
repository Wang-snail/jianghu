import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getToken, clearToken, API_BASE, APP_MODE, isLanHost, isLocalHost } from './lib/auth'
import { TabBar, mainTabs, tabIcons, type Tab } from './components/TabBar'
import { StatusPanel } from './components/StatusPanel'
import { MemoryPanel } from './components/MemoryPanel'
import { WorkersPanel } from './components/WorkersPanel'
import { TasksPanel } from './components/TasksPanel'
import { SettingsPanel } from './components/SettingsPanel'
import { HelpPanel } from './components/HelpPanel'
import { GoalsPanel } from './components/GoalsPanel'
import { VotesPanel } from './components/VotesPanel'
import { SkillsPanel } from './components/SkillsPanel'
import { MessagesPanel } from './components/MessagesPanel'
import { CredentialsPanel } from './components/CredentialsPanel'
import { TransactionsPanel } from './components/TransactionsPanel'
import { StationsPanel } from './components/StationsPanel'
import { RoomSettingsPanel } from './components/RoomSettingsPanel'
import { SwarmPanel } from './components/SwarmPanel'
import { TianjiPanel } from './components/TianjiPanel'
import { JinyiweiPanel } from './components/JinyiweiPanel'
import { InnPanel } from './components/InnPanel'
import { ConnectPage } from './components/ConnectPage'
import { CreateRoomModal } from './components/CreateRoomModal'
import { useNotifications } from './hooks/useNotifications'
import { useDocumentVisible } from './hooks/useDocumentVisible'
import { api } from './lib/client'
import { wsClient, type WsMessage } from './lib/ws'
import {
  ROOM_BADGE_EVENT_TYPES,
  ROOM_BALANCE_EVENT_TYPES,
  ROOMS_QUEEN_STATE_EVENT,
} from './lib/room-events'
import { storageGet, storageSet, storageRemove } from './lib/storage'
import type { Room } from '@shared/types'

const ADVANCED_TABS = new Set<Tab>(
  mainTabs.filter((tab) => tab.advanced).map((tab) => tab.id)
)

const ALL_TAB_IDS: Tab[] = ['tianji', 'jinyiwei', 'swarm', 'inn', 'status', 'goals', 'votes', 'messages', 'workers', 'tasks', 'skills', 'credentials', 'transactions', 'stations', 'room-settings', 'memory', 'settings', 'help']

const DEFAULT_PORT = '4700'
const isRemoteOrigin = location.hostname !== 'localhost' && location.hostname !== '127.0.0.1'
const shouldProbeLocalServer = APP_MODE === 'local' && isRemoteOrigin && !isLanHost()

function getLocalPort(): string {
  return storageGet('zuzu_port') || DEFAULT_PORT
}

function parseCreatedRoomId(payload: unknown): number | null {
  if (!payload || typeof payload !== 'object') return null
  const record = payload as Record<string, unknown>
  if (typeof record.id === 'number') return record.id
  if (record.room && typeof record.room === 'object') {
    const nestedId = (record.room as Record<string, unknown>).id
    if (typeof nestedId === 'number') return nestedId
  }
  return null
}

function isDevDbPath(dbPath: string | undefined): boolean {
  if (!dbPath) return false
  return dbPath.replace(/\\/g, '/').toLowerCase().includes('/.jianghu-dev/')
}

function formatJianghuMoney(value: number): string {
  return `${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} 财气`
}

function formatRoomModel(model: string | null | undefined): string {
  if (!model) return ''
  if (model === 'claude') return 'Claude'
  if (model === 'codex') return 'Codex'
  const idx = model.indexOf(':')
  if (idx === -1) return model
  const provider = model.slice(0, idx)
  const modelName = model.slice(idx + 1)
  const providerLabel = provider === 'openai'
    ? 'OpenAI'
    : provider === 'anthropic'
      ? 'Anthropic'
      : provider === 'gemini'
        ? 'Gemini'
        : provider
  return `${providerLabel}/${modelName}`
}

async function probeLocalServer(port: string): Promise<boolean> {
  const origins = [`http://localhost:${port}`, `http://127.0.0.1:${port}`]

  for (const origin of origins) {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 3000)
      const res = await fetch(`${origin}/api/status`, { signal: controller.signal })
      clearTimeout(timeout)
      if (res.ok) {
        const currentOrigin = window.location.origin.replace(/\/+$/, '')
        if (currentOrigin !== origin) {
          window.location.href = `${origin}${window.location.pathname}${window.location.search}${window.location.hash}`
        }
        return true
      }
    } catch {
      // Try next loopback origin.
    }
  }
  return false
}

function App(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>(() => {
    const saved = storageGet('zuzu_tab')
    if (saved === 'room-settings') return 'status'
    if (saved && ALL_TAB_IDS.includes(saved as Tab)) return saved as Tab
    return 'swarm'
  })
  const tabRef = useRef(tab)
  const [advancedMode, setAdvancedMode] = useState(false)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [startupRetrying, setStartupRetrying] = useState(false)
  const [authAttemptKey, setAuthAttemptKey] = useState(0)
  const [restartingServer, setRestartingServer] = useState(false)

  // Global room selection
  const [selectedRoomId, setSelectedRoomId] = useState<number | null>(() => {
    const saved = storageGet('zuzu_room')
    return saved ? Number(saved) : null
  })
  const [expandedRoomId, setExpandedRoomId] = useState<number | null>(() => {
    const saved = storageGet('zuzu_room')
    return saved ? Number(saved) : null
  })
  const [rooms, setRooms] = useState<Room[]>([])
  const [roomsLoaded, setRoomsLoaded] = useState(false)
  const [queenRunning, setQueenRunning] = useState<Record<number, boolean>>({})
  const [showCreateRoomModal, setShowCreateRoomModal] = useState(false)
  const [swarmInviteNonce, setSwarmInviteNonce] = useState(0)
  const [globalScopeTab, setGlobalScopeTab] = useState<Tab | null>(null)
  const [roomActionPending, setRoomActionPending] = useState<number | null>(null)
  const [roomActionError, setRoomActionError] = useState<string | null>(null)

  const [messagesUnread, setMessagesUnread] = useState(0)
  const [votesActive, setVotesActive] = useState(0)
  const [totalBalance, setTotalBalance] = useState<number | null>(null)
  const [roomBalances, setRoomBalances] = useState<Record<number, number | null>>({})
  const [queenModels, setQueenModels] = useState<Record<number, string | null>>({})

  useNotifications()
  const isVisible = useDocumentVisible()

  const [sidebarOpen, setSidebarOpen] = useState(false)

  // Banner states - 这些banner可能会导致弹窗，默认设置为已关闭
  const [earlyBannerDismissed, setEarlyBannerDismissed] = useState(true)
  const [localModeDismissed, setLocalModeDismissed] = useState(true)
  const [devDbBanner] = useState<{ dbPath: string; dataDir?: string } | null>(null)
  const [localModeBanner] = useState<{ port: string; dbPath: string; dataDir?: string } | null>(null)

  // Remote origin gate: 'probing' → 'connect' or redirect to localhost
  const [gate, setGate] = useState<'probing' | 'connect' | 'app'>(() =>
    shouldProbeLocalServer ? 'probing' : 'app'
  )

  // Remote origin: probe localhost and redirect or show connect page
  useEffect(() => {
    if (!shouldProbeLocalServer) return
    if (gate !== 'probing') return
    probeLocalServer(getLocalPort()).then((redirected) => {
      if (!redirected) setGate('connect')
    })
  }, [gate])

  const fetchRoomBadges = useCallback(async (): Promise<void> => {
    if (!ready || expandedRoomId === null) {
      setMessagesUnread(0)
      setVotesActive(0)
      return
    }
    try {
      const badges = await api.rooms.badges(expandedRoomId)
      if (tabRef.current !== 'messages') setMessagesUnread(badges.pendingEscalations + badges.unreadMessages)
      setVotesActive(badges.activeVotes)
    } catch {
      // ignore polling noise
    }
  }, [expandedRoomId, ready])

  // Fallback poll for sidebar badges (room message/escalation/vote counts).
  useEffect(() => {
    if (!ready || expandedRoomId === null) {
      setMessagesUnread(0)
      setVotesActive(0)
      return
    }
    void fetchRoomBadges().catch(() => {})
    const interval = setInterval(() => { void fetchRoomBadges().catch(() => {}) }, 60000)
    return () => clearInterval(interval)
  }, [expandedRoomId, fetchRoomBadges, ready])

  const fetchTotalBalance = useCallback(async (): Promise<void> => {
    if (!ready || rooms.length === 0) {
      setTotalBalance(null)
      setRoomBalances({})
      return
    }
    try {
      const wallets = await Promise.all(
        rooms.map(r => api.wallet.get(r.id).catch(() => null))
      )
      const nextBalances: Record<number, number | null> = {}
      rooms.forEach((room, idx) => {
        if (!wallets[idx]) nextBalances[room.id] = null
      })
      const roomsWithWallets = rooms.filter((_, i) => wallets[i] !== null)
      if (roomsWithWallets.length === 0) {
        setTotalBalance(null)
        setRoomBalances(nextBalances)
        return
      }
      const results = await Promise.all(
        roomsWithWallets.map(r => api.wallet.summary(r.id).catch(() => null))
      )
      roomsWithWallets.forEach((room, idx) => {
        nextBalances[room.id] = results[idx]?.netProfit ?? 0
      })
      const sum = Object.values(nextBalances).reduce((acc, b) => acc + (b ?? 0), 0)
      setRoomBalances(nextBalances)
      setTotalBalance(sum > 0 ? sum : null)
    } catch {
      // ignore polling noise
    }
  }, [ready, rooms])

  // Fallback poll for total on-chain balance across all rooms.
  useEffect(() => {
    if (!ready || rooms.length === 0) {
      setTotalBalance(null)
      return
    }
    void fetchTotalBalance().catch(() => {})
    const interval = setInterval(() => { void fetchTotalBalance().catch(() => {}) }, 60000)
    return () => clearInterval(interval)
  }, [fetchTotalBalance, ready, rooms.length])

  useEffect(() => {
    if (!ready || expandedRoomId === null) return
    return wsClient.subscribe(`room:${expandedRoomId}`, (event: WsMessage) => {
      if (ROOM_BADGE_EVENT_TYPES.has(event.type)) {
        void fetchRoomBadges()
      }
      if (ROOM_BALANCE_EVENT_TYPES.has(event.type)) {
        void fetchTotalBalance()
      }
    })
  }, [expandedRoomId, fetchRoomBadges, fetchTotalBalance, ready])

  const fetchSelectedQueenModel = useCallback(async (): Promise<void> => {
    if (!ready || selectedRoomId === null) return
    try {
      const q = await api.rooms.queenStatus(selectedRoomId)
      setQueenModels(prev => ({ ...prev, [selectedRoomId]: q?.model ?? null }))
    } catch {
      // keep previous value on transient failures
    }
  }, [ready, selectedRoomId])

  useEffect(() => {
    if (!ready || selectedRoomId === null) return
    void fetchSelectedQueenModel()
    const interval = setInterval(() => { void fetchSelectedQueenModel() }, 60000)
    return () => clearInterval(interval)
  }, [fetchSelectedQueenModel, ready, selectedRoomId])

  // Local origin: auth flow with auto-retry for server startup
  useEffect(() => {
    if (gate !== 'app') return
    let cancelled = false
    const MAX_RETRIES = 6
    const RETRY_DELAY = 3000

    async function attemptAuth(retriesLeft: number): Promise<void> {
      try {
        await getToken()
        if (!cancelled) {
          setStartupRetrying(false)
          setReady(true)
        }
      } catch (err) {
        if (cancelled) return
        if (retriesLeft > 0) {
          setStartupRetrying(true)
          await new Promise(r => setTimeout(r, RETRY_DELAY))
          if (!cancelled) await attemptAuth(retriesLeft - 1)
        } else {
          setStartupRetrying(false)
          setError(err instanceof Error ? err.message : 'Auth failed')
        }
      }
    }

    void attemptAuth(MAX_RETRIES)
    return () => { cancelled = true }
  }, [gate, authAttemptKey])

  useEffect(() => {
    if (gate !== 'app') return
    api.settings.get('advanced_mode').then((v) => {
      setAdvancedMode(v === 'true')
    }).catch(() => {})
  }, [gate])

  const syncRooms = useCallback((r: Room[]): void => {
    setRooms(r)

    const selectableRooms = r.filter(room => room.status !== 'stopped')
    const fallbackRoomId = selectableRooms[0]?.id ?? null
    const selectedStillSelectable = selectedRoomId !== null && selectableRooms.some(room => room.id === selectedRoomId)

    if (selectedRoomId === null) {
      if (fallbackRoomId !== null) {
        handleRoomChange(fallbackRoomId)
      }
    } else if (!selectedStillSelectable) {
      handleRoomChange(fallbackRoomId)
    }

    setExpandedRoomId(prev => {
      if (prev !== null && selectableRooms.some(room => room.id === prev)) {
        return prev
      }
      if (selectedStillSelectable && selectedRoomId !== null) {
        return selectedRoomId
      }
      return fallbackRoomId
    })
  }, [selectedRoomId])

  const refreshQueenStates = useCallback(async (): Promise<void> => {
    if (!ready) return
    try {
      const states = await api.rooms.queenStates()
      setQueenRunning(states)
    } catch {
      // ignore polling noise
    }
  }, [ready])

  const loadRooms = useCallback(async (): Promise<void> => {
    try {
      const nextRooms = await api.rooms.list()
      syncRooms(nextRooms)
      setRoomsLoaded(true)
      void refreshQueenStates()
    } catch {
      // ignore polling noise
    }
  }, [refreshQueenStates, syncRooms])

  useEffect(() => {
    if (!ready) return
    setRoomsLoaded(false)
    void loadRooms()
    const interval = setInterval(() => { void loadRooms() }, 60000)
    return () => clearInterval(interval)
  }, [loadRooms, ready])

  useEffect(() => {
    if (!ready) return
    let roomsRefreshTimer: number | null = null
    const scheduleRoomsReload = (): void => {
      if (roomsRefreshTimer) window.clearTimeout(roomsRefreshTimer)
      roomsRefreshTimer = window.setTimeout(() => {
        roomsRefreshTimer = null
        void loadRooms()
      }, 200)
    }
    const unsubscribe = wsClient.subscribe('rooms', (event: WsMessage) => {
      if (event.type === ROOMS_QUEEN_STATE_EVENT) {
        const payload = event.data as { roomId?: number; running?: boolean }
        if (typeof payload.roomId === 'number' && typeof payload.running === 'boolean') {
          setQueenRunning(prev => ({ ...prev, [payload.roomId]: payload.running }))
          return
        }
      }
      scheduleRoomsReload()
    })
    return () => {
      unsubscribe()
      if (roomsRefreshTimer) window.clearTimeout(roomsRefreshTimer)
    }
  }, [loadRooms, ready])

  function handleTabChange(t: Tab): void {
    setTab(t)
    tabRef.current = t
    storageSet('zuzu_tab', t)
    if (t === 'messages') {
      setMessagesUnread(0)
      if (selectedRoomId !== null) void api.roomMessages.markAllRead(selectedRoomId).catch(() => {})
    }
    setSidebarOpen(false)
  }

  function handleAdvancedModeChange(enabled: boolean): void {
    setAdvancedMode(enabled)
    if (!enabled && ADVANCED_TABS.has(tab)) {
      handleTabChange('status')
    }
  }

  function handleRoomChange(roomId: number | null): void {
    setSelectedRoomId(roomId)
    if (roomId !== null) {
      storageSet('zuzu_room', String(roomId))
    } else {
      storageRemove('zuzu_room')
    }
  }

  function handleRoomToggle(roomId: number): void {
    setGlobalScopeTab(null)
    const next = expandedRoomId === roomId ? null : roomId
    setExpandedRoomId(next)
    if (next !== null) handleRoomChange(next)
    else setSidebarOpen(false)
  }

  function handleRoomTabClick(roomId: number, t: Tab): void {
    setGlobalScopeTab(null)
    handleRoomChange(roomId)
    setExpandedRoomId(roomId)
    handleTabChange(t)
  }

  async function handleRoomStartAction(roomId: number): Promise<void> {
    setRoomActionPending(roomId)
    setRoomActionError(null)
    try {
      await api.rooms.start(roomId)
      setQueenRunning(prev => ({ ...prev, [roomId]: true }))
      await loadRooms()
    } catch (err) {
      setQueenRunning(prev => ({ ...prev, [roomId]: false }))
      setRoomActionError(err instanceof Error ? err.message : '启动帮派失败')
    } finally {
      setRoomActionPending(null)
    }
  }

  async function handleRoomPauseAction(roomId: number): Promise<void> {
    setRoomActionPending(roomId)
    setRoomActionError(null)
    try {
      await api.rooms.pause(roomId)
      setQueenRunning(prev => ({ ...prev, [roomId]: false }))
      await loadRooms()
    } catch (err) {
      setRoomActionError(err instanceof Error ? err.message : '暂停帮派失败')
    } finally {
      setRoomActionPending(null)
    }
  }

  function handlePublicPlaceTab(t: Tab): void {
    setGlobalScopeTab(t)
    handleTabChange(t)
  }

  function handleOpenInvite(): void {
    handleTabChange('swarm')
    setSwarmInviteNonce(prev => prev + 1)
  }

  async function handleRoomCreated(created: Room): Promise<void> {
    const createdRoomId = parseCreatedRoomId(created)
    const nextRooms = await api.rooms.list()
    syncRooms(nextRooms)
    void refreshQueenStates()

    const resolvedRoomId = createdRoomId
      ?? [...nextRooms].reverse().find(r => r.name === created.name)?.id
      ?? null
    if (resolvedRoomId !== null) {
      handleRoomChange(resolvedRoomId)
      setExpandedRoomId(resolvedRoomId)
    }
    handleTabChange('status')
    setShowCreateRoomModal(false)
  }

  const selectedRoom = rooms.find(r => r.id === selectedRoomId) ?? null
  const selectedRoomModel = selectedRoom ? queenModels[selectedRoom.id] ?? null : null
  const selectedRoomBalance = selectedRoom ? roomBalances[selectedRoom.id] ?? null : null
  const activeRooms = useMemo(() => rooms.filter(r => r.status !== 'stopped'), [rooms])

  function renderPanel(): React.JSX.Element {
    switch (tab) {
      case 'swarm':
        return <SwarmPanel rooms={rooms} queenRunning={queenRunning} forcedInviteOpenNonce={swarmInviteNonce} onNavigateToRoom={(roomId) => {
          setGlobalScopeTab(null)
          handleRoomChange(roomId)
          setExpandedRoomId(roomId)
          handleTabChange('status')
        }} onRoomCreated={handleRoomCreated} />
      case 'tianji':
        return <TianjiPanel
          onOpenCommission={handleOpenInvite}
          onCreateGang={() => setShowCreateRoomModal(true)}
          onOpenOverview={() => handlePublicPlaceTab('swarm')}
        />
      case 'jinyiwei':
        return <JinyiweiPanel />
      case 'inn':
        return <InnPanel />
      case 'status':
        return <StatusPanel onNavigate={(t) => handleTabChange(t as Tab)} advancedMode={advancedMode} roomId={selectedRoomId} />
      case 'goals':
        return <GoalsPanel roomId={selectedRoomId} autonomyMode="semi" />
      case 'votes':
        return <VotesPanel roomId={selectedRoomId} autonomyMode="semi" />
      case 'messages':
        return <MessagesPanel roomId={selectedRoomId} autonomyMode="semi" />
      case 'memory':
        return <MemoryPanel roomId={selectedRoomId} />
      case 'workers':
        return <WorkersPanel roomId={selectedRoomId} autonomyMode="semi" />
      case 'tasks':
        return <TasksPanel roomId={selectedRoomId} autonomyMode="semi" />
      case 'skills':
        return <SkillsPanel roomId={globalScopeTab === 'skills' ? null : selectedRoomId} autonomyMode="semi" />
      case 'credentials':
        return <CredentialsPanel roomId={selectedRoomId} autonomyMode="semi" />
      case 'transactions':
        return <TransactionsPanel roomId={globalScopeTab === 'transactions' ? null : selectedRoomId} />
      case 'room-settings':
        return <RoomSettingsPanel roomId={selectedRoomId} />
      case 'settings':
        return <SettingsPanel advancedMode={advancedMode} onAdvancedModeChange={handleAdvancedModeChange} />
      case 'help':
        return <HelpPanel />
      default:
        return <StatusPanel onNavigate={(t) => handleTabChange(t as Tab)} advancedMode={advancedMode} roomId={selectedRoomId} />
    }
  }

  function handleRetryAuth(): void {
    setError(null)
    setRestartingServer(false)
    setStartupRetrying(false)
    clearToken()
    setAuthAttemptKey(k => k + 1)
  }

  async function handleRestartServer(): Promise<void> {
    if (!isLocalHost()) return
    setRestartingServer(true)
    try {
      const res = await fetch(`${API_BASE}/api/server/restart`, {
        method: 'POST',
        cache: 'no-store',
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      // Allow process shutdown and relaunch before retrying handshake.
      setTimeout(() => {
        handleRetryAuth()
      }, 1800)
    } catch {
      setRestartingServer(false)
      setError('无法触发重启。请在终端运行 "江湖 serve"，然后重试。')
    }
  }

  if (gate === 'probing') {
    return (
      <div className="flex flex-col h-screen bg-surface-primary items-center justify-center">
        <div className="text-text-muted text-sm">正在连接本地服务器...</div>
      </div>
    )
  }

  if (gate === 'connect') {
    return (
      <ConnectPage
        port={getLocalPort()}
        onRetry={() => setGate('probing')}
      />
    )
  }

  if (error) {
    return (
      <div className="flex flex-col h-screen bg-surface-primary items-center justify-center px-4">
        <div className="text-status-error text-sm mb-1">连接失败</div>
        <div className="text-text-muted text-xs mb-3">{error}</div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleRetryAuth}
            className="text-sm px-3 py-1.5 rounded-lg bg-interactive text-text-invert hover:bg-interactive-hover transition-colors"
          >
            重试
          </button>
          {isLocalHost() && (
            <button
              onClick={() => void handleRestartServer()}
              disabled={restartingServer}
              className="text-sm px-3 py-1.5 rounded-lg border border-border-primary text-text-secondary hover:text-text-primary hover:border-interactive transition-colors disabled:opacity-40"
            >
              {restartingServer ? '重启中...' : '重启'}
            </button>
          )}
        </div>
        <button
          onClick={() => window.open('mailto:hello@zuzu.io?subject=Connection issue&body=I am having trouble connecting to 江湖.')}
          className="mt-3 text-xs text-text-muted hover:text-text-secondary transition-colors"
        >
          联系开发者
        </button>
      </div>
    )
  }

  if (!ready) {
    return (
      <div className="flex flex-col h-screen bg-surface-primary items-center justify-center">
        <span className="w-4 h-4 rounded-full border-2 border-border-primary border-t-interactive animate-spin mb-3" />
        <div className="text-text-muted text-sm">
          {startupRetrying ? '等待服务器启动...' : '连接中...'}
        </div>
      </div>
    )
  }

  const visibleTabs = advancedMode ? mainTabs : mainTabs.filter(t => !t.advanced)

  return (
    <div className="flex h-screen bg-surface-primary">
      {/* Sidebar backdrop (mobile only) */}
      {sidebarOpen && (
        <div className="fixed inset-0 bg-black/40 z-40 md:hidden" onClick={() => setSidebarOpen(false)} />
      )}

      {/* Left sidebar — overlay on mobile, static on desktop */}
      <div
        data-testid="sidebar"
        className={`fixed inset-y-0 left-0 z-50 w-64 flex flex-col bg-surface-secondary border-r border-border-primary py-2 px-2 transform transition-transform duration-200 ease-out ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'} md:static md:translate-x-0 md:w-72 md:flex-shrink-0 md:z-auto`}
      >
        {/* Navigation links */}
        <div className="pb-2 mb-2 border-b border-border-primary">
          <button
            onClick={() => handlePublicPlaceTab('tianji')}
            className={`w-full px-3 py-2 text-sm text-left rounded-lg transition-colors flex items-center gap-2 ${
              tab === 'tianji'
                ? 'bg-interactive-bg text-interactive font-medium'
                : 'text-text-muted hover:text-text-secondary hover:bg-surface-hover'
            }`}
          >
            {tabIcons.tianji}
            天机阁
          </button>
          <button
            onClick={() => handlePublicPlaceTab('jinyiwei')}
            className={`w-full px-3 py-2 text-sm text-left rounded-lg transition-colors flex items-center gap-2 ${
              tab === 'jinyiwei'
                ? 'bg-interactive-bg text-interactive font-medium'
                : 'text-text-muted hover:text-text-secondary hover:bg-surface-hover'
            }`}
          >
            {tabIcons.jinyiwei}
            锦衣卫
          </button>
          <button
            onClick={() => handlePublicPlaceTab('swarm')}
            className={`w-full px-3 py-2 text-sm text-left rounded-lg transition-colors flex items-center gap-2 ${
              tab === 'swarm'
                ? 'bg-interactive-bg text-interactive font-medium'
                : 'text-text-muted hover:text-text-secondary hover:bg-surface-hover'
            }`}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" className="shrink-0">
              <polygon points="7,1 12.5,4 12.5,10 7,13 1.5,10 1.5,4" fill="none" stroke="currentColor" strokeWidth="1.3"/>
            </svg>
            我的江湖
            {totalBalance !== null && (
              <span className="ml-auto inline-flex items-center justify-center min-w-[40px] h-5 px-1.5 rounded-full bg-status-success-bg text-status-success text-[11px] font-semibold leading-none">
                财气 {totalBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            )}
          </button>
        </div>

        {/* Create room */}
        <div className="pb-2 mb-2 border-b border-border-primary">
          <button
            onClick={() => handlePublicPlaceTab('inn')}
            className={`w-full px-3 py-2 text-sm text-left rounded-lg transition-colors flex items-center gap-2 ${
              tab === 'inn'
                ? 'bg-interactive-bg text-interactive font-medium'
                : 'text-text-muted hover:text-text-secondary hover:bg-surface-hover'
            }`}
          >
            {tabIcons.inn}
            客栈
            <span className="ml-auto text-[10px] text-text-muted">管人</span>
          </button>
          <button
            onClick={() => {
              handlePublicPlaceTab('skills')
            }}
            className={`w-full px-3 py-2 text-sm text-left rounded-lg transition-colors flex items-center gap-2 ${
              tab === 'skills' && globalScopeTab === 'skills'
                ? 'bg-interactive-bg text-interactive font-medium'
                : 'text-text-muted hover:text-text-secondary hover:bg-surface-hover'
            }`}
          >
            {tabIcons.skills}
            藏经阁
            <span className="ml-auto text-[10px] text-text-muted">管功法</span>
          </button>
          <button
            onClick={() => {
              handlePublicPlaceTab('transactions')
            }}
            className={`w-full px-3 py-2 text-sm text-left rounded-lg transition-colors flex items-center gap-2 ${
              tab === 'transactions' && globalScopeTab === 'transactions'
                ? 'bg-interactive-bg text-interactive font-medium'
                : 'text-text-muted hover:text-text-secondary hover:bg-surface-hover'
            }`}
          >
            {tabIcons.transactions}
            钱庄
            <span className="ml-auto text-[10px] text-text-muted">管钱</span>
          </button>
          <button
            onClick={() => setShowCreateRoomModal(true)}
            className="w-full px-3 py-1.5 text-sm text-left text-interactive hover:text-interactive-hover rounded-lg hover:bg-interactive-bg transition-colors"
          >
            + 新建临时帮派
          </button>
        </div>

        {/* Room accordion — scrollable */}
        <div className="flex-1 overflow-y-auto min-h-0">
          <div className="px-3 pb-1 text-[11px] font-semibold text-text-muted">
            临时帮派
          </div>
          {!roomsLoaded ? (
            <div className="flex items-center justify-center gap-2 py-4 px-2 text-xs text-text-muted">
              <span className="w-3 h-3 rounded-full border border-border-primary border-t-text-muted animate-spin" />
              <span>加载帮派中...</span>
            </div>
          ) : activeRooms.length === 0 && (
            <p className="text-xs text-text-muted text-center py-4 px-2">暂无帮派</p>
          )}
          {activeRooms.map(r => {
            const isOpen = expandedRoomId === r.id
            const isSelected = selectedRoomId === r.id
            const running = r.status === 'active' && queenRunning[r.id]
            const paused = r.status === 'paused'
            const pending = roomActionPending === r.id
            const roomStateLabel = running ? '运行中' : paused ? '已暂停' : '未启动'
            const dot = running ? 'bg-status-success' : paused ? 'bg-status-warning' : 'bg-text-muted'
            return (
              <div key={r.id}>
                <button
                  onClick={() => handleRoomToggle(r.id)}
                  className={`flex items-center gap-2 w-full px-3 py-2 text-left rounded-lg transition-colors hover:bg-surface-hover ${isSelected ? 'bg-surface-hover' : ''}`}
                >
                  <span className={`w-2 h-2 rounded-full flex-shrink-0 ${dot}`} />
                  <span className="text-sm font-medium text-text-primary truncate flex-1">{r.name}</span>
                  <span className="text-xs text-text-muted flex-shrink-0">{isOpen ? '\u25B4' : '\u25BE'}</span>
                </button>
                {isOpen && (
                  <div className="pl-4 flex flex-col gap-0.5 pb-1">
                    <div className="px-3 pt-1 pb-0.5 text-[10px] font-semibold text-text-muted">
                      帮派操作
                    </div>
                    <div className="px-3 pb-1">
                      <div className="mb-1 text-[11px] text-text-muted">当前：{roomStateLabel}</div>
                      <div className="grid grid-cols-2 gap-1.5">
                        <button
                          onClick={() => handleRoomTabClick(r.id, 'status')}
                          className="px-2 py-1.5 text-xs text-center rounded-lg bg-surface-tertiary text-text-secondary hover:bg-surface-hover transition-colors"
                        >
                          帮派介绍
                        </button>
                        {running ? (
                          <button
                            onClick={() => {
                              void handleRoomPauseAction(r.id)
                            }}
                            disabled={pending}
                            className="px-2 py-1.5 text-xs text-center rounded-lg bg-status-warning-bg text-status-warning hover:bg-surface-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                          >
                            {pending ? '处理中...' : '暂停运行'}
                          </button>
                        ) : (
                          <button
                            onClick={() => {
                              void handleRoomStartAction(r.id)
                            }}
                            disabled={pending}
                            className="px-2 py-1.5 text-xs text-center rounded-lg bg-status-success-bg text-status-success hover:bg-surface-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                          >
                            {pending ? '处理中...' : '启动运行'}
                          </button>
                        )}
                      </div>
                      {roomActionError && (
                        <div className="mt-1 text-[11px] text-status-error">{roomActionError}</div>
                      )}
                    </div>
                    <div className="px-3 pt-1 pb-0.5 text-[10px] font-semibold text-text-muted">
                      帮派功能
                    </div>
                    {visibleTabs.map(t => (
                      <button
                        key={t.id}
                        onClick={() => handleRoomTabClick(r.id, t.id)}
                        className={`px-3 py-1.5 text-sm text-left rounded-lg transition-colors ${
                          tab === t.id && isSelected && globalScopeTab !== t.id
                            ? 'bg-surface-tertiary text-text-primary font-medium'
                            : 'text-text-muted hover:text-text-secondary hover:bg-surface-hover'
                        }`}
                      >
                        <span className="flex items-center gap-1.5">
                          {tabIcons[t.id]}
                          {t.label}
                          {t.id === 'votes' && votesActive > 0 && (
                            <span className="inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-interactive text-text-invert text-[10px] font-bold leading-none">
                              {votesActive}
                            </span>
                          )}
                          {t.id === 'messages' && messagesUnread > 0 && (
                            <span className="inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-status-error text-text-invert text-[10px] font-bold leading-none">
                              {messagesUnread}
                            </span>
                          )}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>

        <TabBar active={tab} onChange={handleTabChange} onInvite={handleOpenInvite} />
      </div>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        {!earlyBannerDismissed && (
          <div className="flex items-center gap-3 px-4 py-2 bg-brand-50 border-b border-brand-200 shrink-0">
            <span className="text-sm text-brand-700 flex-1">
              您来得早！我们每天都在完善江湖并经常发布新版本。如果有什么问题，{' '}
              <a
                href="mailto:hello@zuzu.io?subject=Bug report&body=Hi, I found an issue in 江湖:"
                className="underline hover:no-underline font-medium"
              >
                请告诉我们
              </a>.
            </span>
            <button
              onClick={() => {
                setEarlyBannerDismissed(true)
                storageSet('zuzu_early_banner_dismissed', 'true')
              }}
              className="text-brand-400 hover:text-brand-600 text-lg leading-none shrink-0 transition-colors"
            >
              &times;
            </button>
          </div>
        )}

        {devDbBanner && (
          <div className="px-4 py-2 bg-status-warning-bg border-b border-amber-200 shrink-0">
              <div className="text-[11px] font-semibold text-status-warning">开发模式 · 隔离数据库</div>
            <div className="text-xs text-text-secondary break-all">
              数据库：<span className="font-mono">{devDbBanner.dbPath}</span>
            </div>
            {devDbBanner.dataDir && (
              <div className="text-xs text-text-secondary break-all">
                数据目录：<span className="font-mono">{devDbBanner.dataDir}</span>
              </div>
            )}
            <button
              onClick={() => { localStorage.clear(); location.reload() }}
              className="mt-1 text-[11px] text-status-warning underline hover:no-underline"
            >
              清除本地缓存
            </button>
          </div>
        )}

        {APP_MODE === 'local' && localModeBanner && !localModeDismissed && (
          <div className="flex items-center gap-3 px-4 py-2 bg-status-info-bg border-b border-blue-200 shrink-0">
            <div className="flex-1 min-w-0">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-status-info">
                本地界面 · 端口 {localModeBanner.port}
              </div>
              <div className="text-xs text-text-secondary break-all">
                数据库：<span className="font-mono">{localModeBanner.dbPath}</span>
              </div>
              {localModeBanner.dataDir && (
                <div className="text-xs text-text-secondary break-all">
                  数据目录：<span className="font-mono">{localModeBanner.dataDir}</span>
                </div>
              )}
            </div>
            <button
              onClick={() => {
                setLocalModeDismissed(true)
                storageSet('zuzu_local_mode_dismissed', 'true')
              }}
              className="text-status-info hover:text-blue-800 dark:hover:text-blue-300 text-lg leading-none shrink-0 transition-colors"
            >
              &times;
            </button>
          </div>
        )}

        {selectedRoom && globalScopeTab !== tab && tab !== 'tianji' && tab !== 'jinyiwei' && tab !== 'swarm' && tab !== 'inn' && tab !== 'settings' && tab !== 'help' && (() => {
          const running = selectedRoom.status === 'active' && queenRunning[selectedRoom.id]
          const paused = selectedRoom.status === 'paused'
          const dot = running ? 'bg-status-success' : paused ? 'bg-status-warning' : 'bg-text-muted'
          const statusLabel = running ? '运行中' : paused ? '已暂停' : '空闲'
          const statusColor = running ? 'text-status-success' : paused ? 'text-status-warning' : 'text-text-muted'
          return (
            <div className="flex items-center gap-2 px-4 py-2 border-b border-border-secondary bg-surface-primary shrink-0 flex-wrap">
              <button className="md:hidden p-1 -ml-1 mr-1 text-text-muted hover:text-text-primary" onClick={() => setSidebarOpen(true)} aria-label="Open menu">
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M3 5h14M3 10h14M3 15h14" /></svg>
              </button>
              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${dot}`} />
              <span className="text-sm font-semibold text-text-primary truncate">{selectedRoom.name}</span>
              <span className={`text-xs flex-shrink-0 ${statusColor}`}>{statusLabel}</span>
              {selectedRoomModel && <span className="text-xs text-text-muted flex-shrink-0">模型: {formatRoomModel(selectedRoomModel)}</span>}
              <span className="text-xs text-text-muted flex-shrink-0">
              钱庄余额: {selectedRoomBalance === null ? '--' : formatJianghuMoney(selectedRoomBalance)}
              </span>
              {selectedRoom.goal && (
                <>
                  <span className="text-text-muted flex-shrink-0 hidden sm:inline">{'\u00B7'}</span>
                  <span className="text-sm text-text-secondary truncate flex-1 min-w-0 hidden sm:inline">{selectedRoom.goal}</span>
                </>
              )}
            </div>
          )
        })()}

        {/* Mobile header for non-room views */}
        {(globalScopeTab === tab || tab === 'tianji' || tab === 'jinyiwei' || tab === 'swarm' || tab === 'inn' || tab === 'settings' || tab === 'help' || !selectedRoom) && (
          <div className="md:hidden flex items-center gap-2 px-4 py-2 border-b border-border-secondary bg-surface-primary shrink-0">
            <button className="p-1 -ml-1 text-text-muted hover:text-text-primary" onClick={() => setSidebarOpen(true)} aria-label="Open menu">
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M3 5h14M3 10h14M3 15h14" /></svg>
            </button>
            <span className="text-sm font-semibold text-text-primary">
              {tab === 'tianji' ? '天机阁' : tab === 'jinyiwei' ? '锦衣卫' : tab === 'swarm' ? '我的江湖' : tab === 'inn' ? '客栈' : tab === 'skills' ? '藏经阁' : tab === 'transactions' ? '钱庄' : tab === 'settings' ? '全局设置' : tab === 'help' ? '江湖说明' : '江湖'}
            </span>
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          {renderPanel()}
        </div>
      </div>

      {showCreateRoomModal && (
        <CreateRoomModal
          onClose={() => setShowCreateRoomModal(false)}
          onCreate={(room) => void handleRoomCreated(room)}
        />
      )}
    </div>
  )
}

export default App
