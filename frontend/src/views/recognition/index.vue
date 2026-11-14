<template>
  <section class="page" data-module="recognition">
    <header class="page-head">
      <div>
        <h2>识别记录管理</h2>
        <p class="page-desc">降级结果由反爬对抗策略同步而来；切换策略只影响后续批次，旧记录保留原识别服务与等待时长。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出识别记录清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value" :data-stat-value="item.label">{{ item.value }}</strong>
      </article>
    </div>

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
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="row in rows"
          :key="String(row.id)"
          :data-challenge="row['关联挑战']"
          :data-stage="row['当前阶段']"
          :data-service="row['识别服务']"
          :data-wait="row['等待时长']"
          :data-degraded-to="row['降级结果']"
        >
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 1" class="empty-state">暂无识别记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条识别记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'

import { downloadEntries, listEntries, moduleMeta } from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('recognition')
const columns = ["记录编号", "关联挑战", "策略编号", "归属站点", "识别服务", "验证码类型", "等待时长", "识别轮次", "降级结果", "当前阶段", "更新时间"]
const stats = ref([
  { label: "识别记录总数", value: 0 },
  { label: "已降级记录", value: 0 },
  { label: "人工转交记录", value: 0 },
])

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function reload() {
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    stats.value[0].value = payload.total
    stats.value[1].value = payload.items.filter((row) => String(row.status) === '已降级').length
    stats.value[2].value = payload.items.filter((row) => String(row.status) === '人工转交').length
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '识别记录读取失败'
  }
}

onMounted(reload)
</script>
