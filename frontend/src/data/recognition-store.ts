import type { RecognitionBatch } from './recognition'

// 识别批次单独持久化：批次是运行态数据，和配置清单分开存，避免混进模块列表。
const BATCH_KEY = 'scraper-config-studio:recognition-batches'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

let cache: RecognitionBatch[] | null = null

function hasStorage(): boolean {
  return typeof window !== 'undefined' && Boolean(window.localStorage)
}

export function listBatches(): RecognitionBatch[] {
  if (cache === null) {
    if (!hasStorage()) {
      cache = []
    } else {
      const raw = window.localStorage.getItem(BATCH_KEY)
      if (!raw) {
        cache = []
      } else {
        try {
          const parsed = JSON.parse(raw) as RecognitionBatch[]
          cache = Array.isArray(parsed) ? parsed : []
        } catch {
          cache = []
        }
      }
    }
  }
  return cache
}

export function findBatch(challengeId: string): RecognitionBatch | undefined {
  return listBatches().find((batch) => batch.challengeId === challengeId)
}

export function findActiveBatch(strategyCode: string): RecognitionBatch | undefined {
  return listBatches().find(
    (batch) => batch.strategyCode === strategyCode && batch.stage !== '人工转交' && batch.stage !== '已完成',
  )
}

export function saveBatch(batch: RecognitionBatch): RecognitionBatch {
  const rows = listBatches()
  const index = rows.findIndex((item) => item.challengeId === batch.challengeId)
  const next = clone(rows)
  if (index >= 0) {
    next[index] = clone(batch)
  } else {
    next.push(clone(batch))
  }
  cache = next
  if (hasStorage()) {
    window.localStorage.setItem(BATCH_KEY, JSON.stringify(next))
  }
  return clone(batch)
}

export function resetBatches(): void {
  cache = []
  if (hasStorage()) {
    window.localStorage.setItem(BATCH_KEY, JSON.stringify([]))
  }
}
