<template>
  <section class="page" data-module="antibot">
    <header class="page-head">
      <div>
        <h2>反爬对抗管理</h2>
        <p class="page-desc">
          策略归属目标站点，仅站点负责人可启停与修改；共享角色只读。一个验证码挑战只消费一个识别批次。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记对抗策略</button>
        <button class="btn" type="button" @click="exportRows">导出反爬对抗清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card" :data-stat="item.label">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value" :data-stat-value="item.label">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>站点负责人</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :data-strategy="row['策略编号']" :data-owner="permissionOf(row).owner" :data-allowed="permissionOf(row).allowed">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td>
            {{ permissionOf(row).owner || '未归属' }}
            <span v-if="!permissionOf(row).allowed" class="readonly-note">（只读）</span>
          </td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              :disabled="!permissionOf(row).allowed"
              :title="permissionOf(row).reason"
              :data-action="action"
              :data-permission="permissionOf(row).allowed ? '允许' : '拒绝'"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无反爬对抗数据，可先登记对抗策略</td>
        </tr>
      </tbody>
    </table>

    <section
      class="batch-card"
      data-batch-card
      :data-batch-id="batch?.batchId ?? ''"
      :data-stage="batch?.stage ?? ''"
      :data-wait-point="batch?.waitPointSeconds ?? ''"
      :data-service="batch?.service ?? ''"
      :data-attempts="batch?.attempts ?? ''"
      :data-poll-count="batch?.pollCount ?? ''"
      :data-degraded-to="batch?.degradedTo ?? ''"
      :data-manual-reason="batch?.manualReason ?? ''"
    >
      <header class="page-head">
        <div>
          <h3>识别批次处理台</h3>
          <p class="page-desc">同一挑战连续轮询只复用已有批次；服务暂缓后从等待点续做。</p>
        </div>
      </header>
      <div class="form-row">
        <label>
          <span>挑战编号</span>
          <input v-model="challengeId" placeholder="如 CHAL-1320" />
        </label>
        <label>
          <span>对抗策略</span>
          <select v-model="strategyCode">
            <option v-for="row in rows" :key="String(row.id)" :value="String(row['策略编号'])">
              {{ row['策略编号'] }} · {{ row['验证码类型'] }} · 等待 {{ row['等待时长'] }}
            </option>
          </select>
        </label>
        <label>
          <span>识别服务返回</span>
          <select v-model="serviceResult">
            <option value="">未返回挑战</option>
            <option value="语音挑战">语音挑战</option>
            <option value="滑块挑战">滑块挑战</option>
          </select>
        </label>
      </div>
      <div class="batch-actions">
        <button class="btn primary" type="button" @click="startOrPoll">建立/轮询批次</button>
        <button class="btn" type="button" @click="advance">推进一次识别</button>
        <button class="btn" type="button" @click="pause">服务暂缓</button>
        <button class="btn" type="button" @click="resume">从等待点续做</button>
      </div>
      <p v-if="batch" class="batch-head">
        <span class="batch-tag">{{ batch.batchId }}</span>
        <span class="batch-tag">阶段：{{ batch.stage }}</span>
        <span class="batch-tag">识别服务：{{ batch.service }}</span>
        <span class="batch-tag">等待点：{{ batch.waitPointSeconds }} 秒</span>
        <span class="batch-tag">轮次：{{ batch.attempts }}/{{ batch.retryLimit }}</span>
        <span class="batch-tag">轮询：{{ batch.pollCount }} 次</span>
        <span v-if="batch.degradedTo" class="batch-tag warn">降级：{{ batch.degradedTo }}</span>
        <span v-if="batch.stage === '人工转交'" class="batch-tag danger">人工转交：{{ batch.manualReason }}</span>
      </p>
      <ul v-if="batch" class="log-list">
        <li
          v-for="log in batch.logs"
          :key="log.seq"
          :data-log-event="log.event"
          :data-log-duration="log.durationSeconds ?? ''"
        >
          [{{ log.at }}] {{ log.event }}<template v-if="log.durationSeconds !== null">（{{ log.durationSeconds }} 秒）</template>：{{ log.detail }}
        </li>
      </ul>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条反爬对抗记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  advanceChallenge,
  listBatchesWithPermission,
  pauseChallenge,
  pollChallenge,
  resumeChallenge,
  startChallenge,
} from '@/api/recognition-service'
import { strategyPermission } from '@/data/permissions'
import { useSessionStore } from '@/stores/session'
import type { RecognitionBatch } from '@/data/recognition'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('antibot')
const session = useSessionStore()
const columns = ["策略编号", "目标站点", "站点负责人", "验证码类型", "识别服务", "触发条件", "等待时长", "重试上限", "降级方案", "策略状态"]
const actions = ["提交校验", "启用策略", "停用策略"]
const statuses = ["草稿", "待校验", "已启用", "已停用"]
const stats = computed(() => [
  { label: '对抗策略总数', value: rows.value.length },
  { label: '已启用策略', value: rows.value.filter((row) => String(row.status) === '已启用').length },
  { label: '待校验策略', value: rows.value.filter((row) => String(row.status) === '待校验').length },
])

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const challengeId = ref('CHAL-1320')
const strategyCode = ref('SLD-6')
const serviceResult = ref('语音挑战')
const batch = ref<RecognitionBatch | null>(null)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function permissionOf(row: EntryRow) {
  return strategyPermission(session.actor, row)
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '对抗策略登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action, session.actor)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function showBatch(next?: RecognitionBatch) {
  if (next) {
    batch.value = next
  }
}

function syncFromRecords() {
  const found = listBatchesWithPermission(session.actor).find(
    (item) => item.challengeId === challengeId.value,
  )
  if (found) {
    batch.value = found
  }
}

function applyResult(result: { ok: boolean; message: string; batch?: RecognitionBatch }) {
  errorMessage.value = result.ok ? '' : result.message
  showBatch(result.batch)
  reload()
}

// 首次建立批次，之后同一挑战的点击都只轮询已有批次。
function startOrPoll() {
  const existing = listBatchesWithPermission(session.actor).find(
    (item) => item.challengeId === challengeId.value,
  )
  if (existing) {
    applyResult(pollChallenge(challengeId.value))
    return
  }
  applyResult(startChallenge({ challengeId: challengeId.value, strategyCode: strategyCode.value }, session.actor))
  syncFromRecords()
}

function advance() {
  applyResult(advanceChallenge(challengeId.value, serviceResult.value))
}

function pause() {
  applyResult(pauseChallenge(challengeId.value))
}

function resume() {
  applyResult(resumeChallenge(challengeId.value))
}

function reload() {
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '反爬对抗列表读取失败'
  }
}

onMounted(() => {
  reload()
  syncFromRecords()
})
</script>
