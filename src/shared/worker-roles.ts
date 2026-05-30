import type { Worker } from './types'

type WorkerIdentity = Pick<Worker, 'id' | 'name' | 'role' | 'isDefault'>
type WorkerPlacement = WorkerIdentity & Pick<Worker, 'roomId'>

export function isTianjiWorker(worker: WorkerIdentity, queenWorkerId?: number | null): boolean {
  if (queenWorkerId != null && worker.id === queenWorkerId) return true
  const role = worker.role ?? ''
  const text = `${worker.name} ${role}`.trim()
  return worker.isDefault
    || text.includes('天机阁')
    || text.includes('天机处')
    || text.includes('帮主')
    || text.includes('小老板')
    || text.includes('锦衣卫')
    || text.includes('秘书')
    || /\bClerk\b/i.test(text)
    || role === 'clerk'
    || /\bQueen\b/i.test(text)
}

export function isAssignableWorker(worker: WorkerIdentity, queenWorkerId?: number | null): boolean {
  return !isTianjiWorker(worker, queenWorkerId)
}

export function isInnWorker(worker: WorkerPlacement, queenWorkerId?: number | null): boolean {
  return worker.roomId == null && isAssignableWorker(worker, queenWorkerId)
}
