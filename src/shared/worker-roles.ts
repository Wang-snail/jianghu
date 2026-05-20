import type { Worker } from './types'

type WorkerIdentity = Pick<Worker, 'id' | 'name' | 'role' | 'isDefault'>

export function isTianjiWorker(worker: WorkerIdentity, queenWorkerId?: number | null): boolean {
  if (queenWorkerId != null && worker.id === queenWorkerId) return true
  const role = worker.role ?? ''
  const text = `${worker.name} ${role}`.trim()
  return worker.isDefault
    || text.includes('天机阁')
    || text.includes('天机处')
    || text.includes('小老板')
    || /\bQueen\b/i.test(text)
}

export function isAssignableWorker(worker: WorkerIdentity, queenWorkerId?: number | null): boolean {
  return !isTianjiWorker(worker, queenWorkerId)
}
