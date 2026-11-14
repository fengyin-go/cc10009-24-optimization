import { listRows } from './local-store'
import type { EntryRow } from './types'

// 策略权限：归属站点由策略的「目标站点」决定，负责人取站点管理里的「站点负责人」。
// 只有该站点负责人可以启停、修改策略；共享角色只读；其他站点负责人跨站点操作一律拒绝。
export type ActorRole = '站点负责人' | '共享角色'

export type Actor = {
  name: string
  role: ActorRole
}

export type StrategyPermission = {
  allowed: boolean
  owner: string
  reason: string
}

export function siteOwnerOf(siteCode: string): string {
  const site = listRows('site').find((row) => String(row['站点编号'] ?? '') === siteCode)
  return site ? String(site['站点负责人'] ?? '') : ''
}

export function strategyPermission(actor: Actor, strategy: EntryRow): StrategyPermission {
  const siteCode = String(strategy['目标站点'] ?? '')
  const owner = siteOwnerOf(siteCode)
  if (actor.role !== '站点负责人') {
    return {
      allowed: false,
      owner,
      reason: `共享角色「${actor.name}」对策略只读，不能启停或修改`,
    }
  }
  if (!owner) {
    return {
      allowed: false,
      owner,
      reason: `策略未归属到有效站点「${siteCode || '未填写'}」，无法确认负责人，已拒绝修改`,
    }
  }
  if (owner !== actor.name) {
    return {
      allowed: false,
      owner,
      reason: `跨站点越权：策略归属 ${siteCode}，站点负责人为 ${owner}，已拒绝 ${actor.name} 的修改`,
    }
  }
  return { allowed: true, owner, reason: '' }
}

export function actorRole(name: string): ActorRole {
  const owners = listRows('site').map((row) => String(row['站点负责人'] ?? ''))
  return owners.includes(name) ? '站点负责人' : '共享角色'
}

export function listActors(): Actor[] {
  const owners = Array.from(
    new Set(listRows('site').map((row) => String(row['站点负责人'] ?? '')).filter(Boolean)),
  )
  const shared = ['值班管理员', '采集运维']
  return [
    ...owners.map((name) => ({ name, role: '站点负责人' as ActorRole })),
    ...shared.map((name) => ({ name, role: '共享角色' as ActorRole })),
  ]
}
