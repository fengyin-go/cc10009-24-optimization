import { defineStore } from 'pinia'

import { actorRole, listActors } from '@/data/permissions'
import type { Actor } from '@/data/permissions'

// 当前操作人：站点负责人只能操作自己负责站点的策略，共享角色只读。
export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '周敏',
    shiftLabel: '白班 08:00-20:00',
    scope: '网页采集配置管理工具',
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
    actor: (state): Actor => ({ name: state.operator, role: actorRole(state.operator) }),
    actorOptions: (): Actor[] => listActors(),
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    setOperator(name: string) {
      this.operator = name
    },
  },
})
