// 温控面板的数据 hooks（TanStack Query）。只读；写操作在页面组件里经 source.setRoom / setAll 发起。
// - 项目为 null、项目离线（真实接口）时不发 ctrl 请求（docs/分工.md 第 3 节第 6 条、plan 3.4）；
// - 真实接口每 15 秒刷新一次 200（上一次返回后才排下一次；标签页不可见时 TanStack 默认暂停）；
// - 写成功后调 refreshRooms() 立即重读 200，以设备回读值为准（plan 3.4）。
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { queryKeys } from '@/api/query'
import type { Project } from '@/data/org'
import type { RoomView } from './model'
import { thermostatSource } from './source'
import type { StatsRange } from './stats'

export const ROOMS_POLL_MS = 15_000

const roomsKey = (kind: 'real' | 'mock', projectId: string) =>
  kind === 'real' ? queryKeys.ctrl(200, projectId) : (['thermostat-mock', 'rooms', projectId] as const)

/** 是否可以读：有项目、有 id；真实接口还要求项目在线（离线时控制屏一定 503，不去打） */
export const canRead = (project: Pick<Project, 'id' | 'online'> | null, kind: 'real' | 'mock') =>
  !!project?.id && (kind === 'mock' || project.online === true)

export function useRooms(project: Project | null, enabled = true) {
  const src = thermostatSource()
  console.log('useRooms render', src.kind, project?.id, enabled)
  const id = project?.id ?? ''
  return useQuery({
    queryKey: roomsKey(src.kind, id),
    queryFn: ({ signal }) => { console.log('QF start'); return src.rooms(id, signal).then((x) => { console.log('QF done', x.length); return x }) },
    enabled: enabled && canRead(project, src.kind),
    refetchInterval: src.kind === 'real' ? ROOMS_POLL_MS : false,
    staleTime: src.kind === 'real' ? 10_000 : Infinity,
  })
}

/** 写操作后立即重读房间列表 */
export function useRefreshRooms(project: Project | null) {
  const qc = useQueryClient()
  const id = project?.id ?? ''
  return useCallback(() => {
    if (!id) return Promise.resolve()
    return qc.invalidateQueries({ queryKey: roomsKey(thermostatSource().kind, id), exact: true })
  }, [qc, id])
}

export function useRoomStats(project: Project | null, room: RoomView | undefined, range: StatsRange, enabled = true) {
  const src = thermostatSource()
  const id = project?.id ?? ''
  return useQuery({
    queryKey: src.kind === 'real'
      ? [...queryKeys.ctrl(209, id, { deviceId: room?.equipmentId ?? 0 }), range]
      : ['thermostat-mock', 'stats', id, room?.key ?? '', range],
    queryFn: ({ signal }) => src.stats(id, room!, range, signal),
    enabled: enabled && !!room && canRead(project, src.kind),
    staleTime: src.kind === 'real' ? 60_000 : Infinity,
  })
}
