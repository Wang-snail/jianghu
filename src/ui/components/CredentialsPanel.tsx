import { useState, useEffect } from 'react'
import { usePolling } from '../hooks/usePolling'
import { api } from '../lib/client'
import { ROOM_CREDENTIAL_EVENT_TYPES } from '../lib/room-events'
import { wsClient, type WsMessage } from '../lib/ws'
import { formatRelativeTime } from '../utils/time'
import { Select } from './Select'
import type { Credential } from '@shared/types'

const TYPE_LABELS: Record<string, string> = {
  api_key: 'API Key',
  account: 'Account',
  card: 'Card',
  other: 'Other'
}

interface CredentialsPanelProps {
  roomId: number | null
  autonomyMode: 'semi'
}

export function CredentialsPanel({ roomId }: CredentialsPanelProps): React.JSX.Element {
  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [type, setType] = useState('api_key')
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null)

  const { data: credentials, refresh } = usePolling<Credential[]>(
    () => roomId ? api.credentials.list(roomId) : Promise.resolve([]),
    30000
  )

  useEffect(() => {
    if (!roomId) return
    return wsClient.subscribe(`room:${roomId}`, (event: WsMessage) => {
      if (ROOM_CREDENTIAL_EVENT_TYPES.has(event.type)) {
        void refresh()
      }
    })
  }, [refresh, roomId])

  async function handleCreate(): Promise<void> {
    if (!roomId || !name.trim() || !value.trim()) return
    await api.credentials.create(roomId, name.trim(), value.trim(), type)
    setName('')
    setValue('')
    setShowForm(false)
    refresh()
  }

  async function handleDelete(id: number): Promise<void> {
    await api.credentials.delete(id)
    setConfirmDelete(null)
    refresh()
  }

  function maskValue(val: string): string {
    if (val.length <= 8) return '••••••••'
    return val.slice(0, 4) + '••••' + val.slice(-4)
  }

  if (!roomId) {
    return <div className="p-4 text-sm text-text-muted">请选择帮派查看访问凭证。</div>
  }

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <h2 className="text-base font-semibold text-text-primary">访问凭证</h2>
        <button
          onClick={() => setShowForm(!showForm)}
          className="text-xs px-2.5 py-1.5 bg-interactive text-text-invert rounded-lg hover:bg-interactive-hover"
        >
          {showForm ? '取消' : '+ 添加'}
        </button>
      </div>

      {showForm && (
        <div className="bg-surface-secondary shadow-sm rounded-lg p-4 space-y-2">
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="名称，例如 OpenAI API Key"
            className="w-full text-sm px-2.5 py-1.5 border border-border-primary rounded-lg bg-surface-primary text-text-primary"
          />
          <input
            value={value}
            onChange={e => setValue(e.target.value)}
            placeholder="值，会加密保存"
            type="password"
            className="w-full text-sm px-2.5 py-1.5 border border-border-primary rounded-lg bg-surface-primary text-text-primary"
          />
          <div className="flex gap-2 items-center">
            <Select
              value={type}
              onChange={setType}
              options={[
                { value: 'api_key', label: 'API 密钥' },
                { value: 'account', label: '账号' },
                { value: 'card', label: '卡片' },
                { value: 'other', label: '其他' },
              ]}
            />
            <button
              onClick={handleCreate}
              disabled={!name.trim() || !value.trim()}
              className="text-xs px-2.5 py-1.5 bg-surface-invert text-text-invert rounded-lg hover:opacity-80 disabled:opacity-40"
            >
              保存
            </button>
          </div>
        </div>
      )}

      {(!credentials || credentials.length === 0) ? (
        <div className="text-sm text-text-muted py-4 text-center">
          暂无访问凭证。天机阁和弟子可能会请求 API 密钥、账号或密码。
        </div>
      ) : (
        <div className="space-y-2">
          {credentials.map(cred => (
            <div key={cred.id} className="bg-surface-secondary shadow-sm rounded-lg p-3 flex items-center gap-2">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-text-primary truncate">{cred.name}</div>
                <div className="text-xs text-text-muted flex gap-2">
                  <span className="bg-surface-tertiary px-1 rounded">{TYPE_LABELS[cred.type] ?? cred.type}</span>
                  <span>{maskValue(cred.valueEncrypted)}</span>
                  <span>{formatRelativeTime(cred.createdAt)}</span>
                </div>
              </div>
              {confirmDelete === cred.id ? (
                <div className="flex gap-1">
                  <button onClick={() => handleDelete(cred.id)} className="text-xs px-2.5 py-1.5 bg-status-error text-text-invert rounded-lg">删除</button>
                  <button onClick={() => setConfirmDelete(null)} className="text-xs px-2.5 py-1.5 bg-surface-tertiary rounded-lg">取消</button>
                </div>
              ) : (
                <button onClick={() => setConfirmDelete(cred.id)} className="text-xs text-status-error hover:text-red-600">删除</button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
