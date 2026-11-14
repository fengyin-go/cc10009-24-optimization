import type { EntryRow } from './types'

// 验证码识别批次的领域模型：批次在创建时冻结策略快照（识别服务、等待时长、重试上限），
// 后续切换策略只影响新批次，已有批次不会被改写。
export const VOICE_WAIT_SECONDS = 4
export const MANUAL_REASON = '验证码样式变化'

export type RecognitionStage = '等待中' | '识别中' | '服务暂缓' | '已降级' | '人工转交' | '已完成'

export type RecognitionLog = {
  seq: number
  at: string
  event: string
  durationSeconds: number | null
  detail: string
}

export type RecognitionBatch = {
  batchId: string
  challengeId: string
  strategyCode: string
  siteCode: string
  service: string
  captchaType: string
  waitSeconds: number
  retryLimit: number
  degradePlan: string
  attempts: number
  pollCount: number
  stage: RecognitionStage
  degradedTo: string
  waitPointSeconds: number
  createdAt: string
  updatedAt: string
  manualReason: string
  logs: RecognitionLog[]
}

export type StrategyPolicy = {
  code: string
  siteCode: string
  siteOwner: string
  captchaType: string
  service: string
  trigger: string
  waitSeconds: number
  retryLimit: number
  degradePlan: string
}

export function readStrategyText(row: EntryRow, field: string): string {
  return String(row[field] ?? '').trim()
}

function readSeconds(row: EntryRow, field: string, fallback: number): number {
  const raw = readStrategyText(row, field)
  const matched = raw.match(/\d+(?:\.\d+)?/)
  if (!matched) {
    return fallback
  }
  const value = Number(matched[0])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

export function parseStrategy(row: EntryRow): StrategyPolicy {
  return {
    code: readStrategyText(row, '策略编号'),
    siteCode: readStrategyText(row, '目标站点'),
    siteOwner: readStrategyText(row, '站点负责人'),
    captchaType: readStrategyText(row, '验证码类型') || '滑块验证码',
    service: readStrategyText(row, '识别服务') || '默认识别服务',
    trigger: readStrategyText(row, '触发条件'),
    waitSeconds: readSeconds(row, '等待时长', 8),
    retryLimit: Math.max(1, Math.round(readSeconds(row, '重试上限', 3))),
    degradePlan: readStrategyText(row, '降级方案'),
  }
}

export function batchIdFor(challengeId: string): string {
  const slug = challengeId
    .trim()
    .replace(/[^0-9A-Za-z-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toUpperCase()
  return `BATCH-${slug || 'CHALLENGE'}`
}

export function isTerminalStage(stage: RecognitionStage): boolean {
  return stage === '人工转交' || stage === '已完成'
}

function cloneBatch(batch: RecognitionBatch): RecognitionBatch {
  return { ...batch, logs: batch.logs.map((log) => ({ ...log })) }
}

function pushLog(
  batch: RecognitionBatch,
  at: string,
  event: string,
  durationSeconds: number | null,
  detail: string,
): void {
  batch.logs.push({
    seq: batch.logs.length + 1,
    at,
    event,
    durationSeconds,
    detail,
  })
}

export function createBatch(policy: StrategyPolicy, challengeId: string, at: string): RecognitionBatch {
  return {
    batchId: batchIdFor(challengeId),
    challengeId,
    strategyCode: policy.code,
    siteCode: policy.siteCode,
    service: policy.service,
    captchaType: policy.captchaType,
    waitSeconds: policy.waitSeconds,
    retryLimit: policy.retryLimit,
    degradePlan: policy.degradePlan,
    attempts: 0,
    pollCount: 0,
    stage: '等待中',
    degradedTo: '',
    waitPointSeconds: policy.waitSeconds,
    createdAt: at,
    updatedAt: at,
    manualReason: '',
    logs: [
      {
        seq: 1,
        at,
        event: '创建识别批次',
        durationSeconds: null,
        detail: `策略 ${policy.code} 建立唯一识别批次，等待点 ${policy.waitSeconds} 秒`,
      },
    ],
  }
}

// 轮询只复用挑战对应的唯一批次；这里绝不新建批次，也不消费识别轮次。
export function pollBatch(batch: RecognitionBatch, at: string): RecognitionBatch {
  const next = cloneBatch(batch)
  next.pollCount += 1
  next.updatedAt = at
  const suffix = isTerminalStage(next.stage) ? `，批次已处于「${next.stage}」` : ''
  pushLog(
    next,
    at,
    '轮询命中已有批次',
    null,
    `第 ${next.pollCount} 次轮询复用批次 ${next.batchId}，未新建批次${suffix}`,
  )
  return next
}

function degradeCategory(value: string): string {
  if (value.includes('语音')) return '语音'
  if (value.includes('滑块')) return '滑块'
  if (value.includes('点选')) return '点选'
  if (value.includes('人工')) return '人工'
  return value
}

// 降级结果冲突的兼容方案：已冻结的批次结果优先，其次采用策略配置；
// 只要服务返回与策略配置属于同一类别（例如「语音挑战」与「语音验证码」）就视为兼容。
function resolveDegrade(
  batch: RecognitionBatch,
  serviceResult: string,
): { value: string; conflict: boolean; detail: string } {
  if (batch.degradedTo) {
    return { value: batch.degradedTo, conflict: false, detail: '' }
  }
  const configured = batch.degradePlan.trim()
  const returned = serviceResult.trim() || '语音挑战'
  if (configured && returned && degradeCategory(configured) !== degradeCategory(returned)) {
    return {
      value: configured,
      conflict: true,
      detail: `降级结果冲突：识别服务返回「${returned}」，策略配置「${configured}」，沿用策略配置`,
    }
  }
  return { value: configured || returned, conflict: false, detail: '' }
}

// 一次推进只消费一个识别轮次。重试上限定义批次边界：
// 倒数第二轮进入降级，最后一轮转入人工，次数用满后不再调用识别服务。
export function advanceBatch(
  batch: RecognitionBatch,
  at: string,
  serviceResult = '',
): RecognitionBatch {
  const next = cloneBatch(batch)
  if (isTerminalStage(next.stage)) {
    pushLog(next, at, '识别批次已结束', null, `批次 ${next.batchId} 已处于「${next.stage}」，不再调用识别服务`)
    return next
  }
  if (next.stage === '服务暂缓') {
    pushLog(
      next,
      at,
      '服务暂缓中',
      next.waitPointSeconds,
      `识别服务仍处于暂缓状态，保留等待点 ${next.waitPointSeconds} 秒，未消费识别轮次`,
    )
    return next
  }

  next.attempts += 1
  next.updatedAt = at
  const penultimate = Math.max(1, next.retryLimit - 1)

  if (next.attempts === 1 && next.captchaType.includes('滑块')) {
    pushLog(
      next,
      at,
      '滑块拖拽识别',
      next.waitSeconds,
      `滑块拖拽耗时 ${next.waitSeconds} 秒`,
    )
  }

  // 最后一轮直接人工转交，不再降级；只有还有后续轮次时才降级。
  if (next.attempts >= penultimate && next.attempts < next.retryLimit && !next.degradedTo) {
    const resolved = resolveDegrade(next, serviceResult)
    if (resolved.conflict) {
      pushLog(next, at, '降级结果冲突', null, resolved.detail)
    }
    if (resolved.value) {
      next.degradedTo = resolved.value
      next.stage = '已降级'
      next.waitPointSeconds = VOICE_WAIT_SECONDS
      pushLog(
        next,
        at,
        `降级为${resolved.value}`,
        VOICE_WAIT_SECONDS,
        `第 ${next.attempts} 次识别返回${serviceResult.trim() || '语音挑战'}，降级为${resolved.value}，语音提示等待 ${VOICE_WAIT_SECONDS} 秒`,
      )
    }
  }

  if (next.attempts >= next.retryLimit) {
    next.stage = '人工转交'
    next.manualReason = MANUAL_REASON
    next.waitPointSeconds = 0
    pushLog(next, at, '人工转交', null, `人工转交原因：${MANUAL_REASON}`)
  } else if (!next.degradedTo) {
    next.stage = '识别中'
    pushLog(
      next,
      at,
      '识别未通过',
      next.waitPointSeconds,
      `第 ${next.attempts} 次识别未通过，保留等待点 ${next.waitPointSeconds} 秒`,
    )
  } else {
    next.stage = '已降级'
    pushLog(
      next,
      at,
      '降级后识别未通过',
      VOICE_WAIT_SECONDS,
      `第 ${next.attempts} 次识别仍为${next.degradedTo}，语音提示等待 ${VOICE_WAIT_SECONDS} 秒`,
    )
  }

  return next
}

export function pauseBatch(batch: RecognitionBatch, at: string): RecognitionBatch {
  const next = cloneBatch(batch)
  const point = next.waitPointSeconds > 0 ? next.waitPointSeconds : next.waitSeconds
  next.waitPointSeconds = point
  next.stage = '服务暂缓'
  next.updatedAt = at
  pushLog(
    next,
    at,
    '服务暂缓',
    point,
    `识别服务暂缓，保留等待点 ${point} 秒，恢复后从等待点续做`,
  )
  return next
}

export function resumeBatch(batch: RecognitionBatch, at: string): RecognitionBatch {
  const next = cloneBatch(batch)
  if (next.stage !== '服务暂缓') {
    pushLog(next, at, '无需续做', null, `批次 ${next.batchId} 当前为「${next.stage}」，不在暂缓状态`)
    return next
  }
  next.stage = next.attempts > 0 ? '识别中' : '等待中'
  next.updatedAt = at
  pushLog(
    next,
    at,
    '从等待点续做',
    next.waitPointSeconds,
    `从等待点 ${next.waitPointSeconds} 秒继续，复用批次 ${next.batchId}`,
  )
  return next
}
