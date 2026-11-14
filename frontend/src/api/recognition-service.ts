import { listRows, saveRows } from '@/data/local-store'
import { moduleMeta } from './local-service'
import { strategyPermission, type Actor } from '@/data/permissions'
import {
  advanceBatch,
  createBatch,
  isTerminalStage,
  parseStrategy,
  pauseBatch,
  pollBatch,
  resumeBatch,
  type RecognitionBatch,
  type RecognitionStage,
} from '@/data/recognition'
import { findBatch, listBatches, saveBatch } from '@/data/recognition-store'
import type { ActionResult, EntryRow } from '@/data/types'

// 反爬对抗策略与验证码识别服务之间的衔接层：
// 1. 一个验证码挑战只建一个识别批次，后续轮询一律命中已有批次；
// 2. 识别服务暂缓时保留等待点，恢复后从等待点续做；
// 3. 策略启停与修改按站点负责人鉴权，跨站点一律拒绝；
// 4. 降级结果同步到「识别记录」清单，旧记录不改写已冻结的服务与等待时长。

export type ChallengeInput = {
  challengeId: string
  strategyCode: string
  at?: string
}

export type BatchView = RecognitionBatch & {
  permission: ReturnType<typeof strategyPermission>
}

type ChallengeResult = ActionResult & { batch?: RecognitionBatch; reused?: boolean }

// 并发/重复命中的处理锁：同一挑战在同一时刻只允许一个处理流程落库。
const processing = new Set<string>()

function withSingleFlight<T>(challengeId: string, run: () => T, fallback: T): T {
  const key = challengeId.trim()
  if (processing.has(key)) {
    return fallback
  }
  processing.add(key)
  try {
    return run()
  } finally {
    processing.delete(key)
  }
}

function now(): string {
  return new Date().toISOString()
}

// 识别记录的清单状态收敛到模块登记的状态集：运行中的阶段统一记为「识别中」。
function recordStatus(stage: RecognitionStage): string {
  if (stage === '人工转交' || stage === '已完成' || stage === '已降级') {
    return stage
  }
  return '识别中'
}

function findStrategy(strategyCode: string): EntryRow | undefined {
  return listRows('antibot').find((row) => String(row['策略编号'] ?? '') === strategyCode)
}

function denyStrategy(strategyCode: string, actor?: Actor): ActionResult | null {
  const row = findStrategy(strategyCode)
  if (!row) {
    return { ok: false, message: `没有找到策略编号为 ${strategyCode} 的对抗策略` }
  }
  const status = String(row.status)
  if (status !== '已启用') {
    return { ok: false, message: `对抗策略 ${strategyCode} 当前为「${status}」，未启用时不消费识别服务` }
  }
  if (actor) {
    const permission = strategyPermission(actor, row)
    if (!permission.allowed) {
      return { ok: false, message: permission.reason }
    }
  }
  return null
}

export function listBatchesWithPermission(actor: Actor): BatchView[] {
  return listBatches().map((batch) => {
    const row = findStrategy(batch.strategyCode)
    return {
      ...batch,
      permission: row
        ? strategyPermission(actor, row)
        : { allowed: false, owner: '', reason: `策略 ${batch.strategyCode} 已不存在` },
    }
  })
}

// 建立或复用挑战批次：已存在批次时只记录一次轮询，绝不新建第二个批次。
export function startChallenge(input: ChallengeInput, actor?: Actor): ChallengeResult {
  const at = input.at ?? now()
  const existing = findBatch(input.challengeId)
  if (existing) {
    return withSingleFlight<ChallengeResult>(
      input.challengeId,
      () => {
        const next = saveBatch(pollBatch(existing, at))
        return { ok: true, message: `挑战 ${input.challengeId} 命中批次 ${next.batchId}，未重复创建`, batch: next, reused: true }
      },
      { ok: false, message: `挑战 ${input.challengeId} 正在处理中，本次命中已去重`, batch: existing, reused: true },
    )
  }
  const denial = denyStrategy(input.strategyCode, actor)
  if (denial) {
    return denial
  }
  const policy = parseStrategy(findStrategy(input.strategyCode) as EntryRow)
  return withSingleFlight<ChallengeResult>(
    input.challengeId,
    () => {
      const batch = saveBatch(createBatch(policy, input.challengeId, at))
      return { ok: true, message: `挑战 ${input.challengeId} 新建批次 ${batch.batchId}`, batch, reused: false }
    },
    { ok: false, message: `挑战 ${input.challengeId} 正在处理中，本次命中已去重` },
  )
}

export function pollChallenge(challengeId: string, at = now()): ActionResult & { batch?: RecognitionBatch } {
  const existing = findBatch(challengeId)
  if (!existing) {
    return { ok: false, message: `挑战 ${challengeId} 还没有识别批次，请先建立批次` }
  }
  return withSingleFlight<ChallengeResult>(
    challengeId,
    () => {
      const next = saveBatch(pollBatch(existing, at))
      return { ok: true, message: `轮询命中批次 ${next.batchId}，未新建批次`, batch: next }
    },
    { ok: false, message: `挑战 ${challengeId} 正在处理中，本次轮询已去重` },
  )
}

export function pauseChallenge(challengeId: string, at = now()): ActionResult & { batch?: RecognitionBatch } {
  const existing = findBatch(challengeId)
  if (!existing) {
    return { ok: false, message: `挑战 ${challengeId} 还没有识别批次` }
  }
  const next = saveBatch(pauseBatch(existing, at))
  return { ok: true, message: `批次 ${next.batchId} 已暂缓，等待点 ${next.waitPointSeconds} 秒`, batch: next }
}

export function resumeChallenge(challengeId: string, at = now()): ActionResult & { batch?: RecognitionBatch } {
  const existing = findBatch(challengeId)
  if (!existing) {
    return { ok: false, message: `挑战 ${challengeId} 还没有识别批次` }
  }
  const next = saveBatch(resumeBatch(existing, at))
  return { ok: true, message: `批次 ${next.batchId} 从等待点 ${next.waitPointSeconds} 秒续做`, batch: next }
}

// 推进一次识别轮次：每次最多消费一轮，重试上限即批次边界。
export function advanceChallenge(
  challengeId: string,
  serviceResult = '',
  at = now(),
): ActionResult & { batch?: RecognitionBatch } {
  const existing = findBatch(challengeId)
  if (!existing) {
    return { ok: false, message: `挑战 ${challengeId} 还没有识别批次` }
  }
  return withSingleFlight<ChallengeResult>(
    challengeId,
    () => {
      const next = saveBatch(advanceBatch(existing, at, serviceResult))
      syncRecognitionRecord(next)
      return { ok: true, message: `批次 ${next.batchId} 当前阶段「${next.stage}」`, batch: next }
    },
    { ok: false, message: `挑战 ${challengeId} 正在处理中，本次推进已去重`, batch: existing },
  )
}

// 降级结果同步：识别记录按挑战唯一，旧记录保留原识别服务与等待时长。
export function syncRecognitionRecord(batch: RecognitionBatch): void {
  const meta = moduleMeta('recognition')
  const rows = listRows(meta.key)
  const index = rows.findIndex(
    (row) =>
      String(row['记录编号'] ?? '') === batch.batchId ||
      String(row['关联挑战'] ?? '') === batch.challengeId,
  )
  if (index >= 0) {
    // 仅同步运行态字段；首建时冻结的识别服务、等待时长不回写。
    const next = [...rows]
    next[index] = {
      ...rows[index],
      识别轮次: `${batch.attempts}/${batch.retryLimit}`,
      降级结果: batch.degradedTo || String(rows[index]['降级结果'] ?? '—'),
      当前阶段: batch.stage,
      日志摘要: batch.logs.map((log) => log.detail).join('；'),
      更新时间: batch.updatedAt,
      status: recordStatus(batch.stage),
      pending: !isTerminalStage(batch.stage) || batch.stage === '人工转交',
      abnormal: batch.stage === '人工转交',
    }
    saveRows(meta.key, next)
    return
  }
  const record: EntryRow = {
    id: rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1,
    status: recordStatus(batch.stage),
    pending: true,
    abnormal: batch.stage === '人工转交',
    记录编号: batch.batchId,
    关联挑战: batch.challengeId,
    策略编号: batch.strategyCode,
    归属站点: batch.siteCode,
    识别服务: batch.service,
    验证码类型: batch.captchaType,
    等待时长: `${batch.waitSeconds}秒`,
    识别轮次: `${batch.attempts}/${batch.retryLimit}`,
    降级结果: batch.degradedTo || '—',
    当前阶段: batch.stage,
    日志摘要: batch.logs.map((log) => log.detail).join('；'),
    更新时间: batch.updatedAt,
  }
  saveRows(meta.key, [...rows, record])
}

export type { RecognitionBatch, RecognitionStage }
