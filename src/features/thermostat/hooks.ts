// 温控面板的数据 hooks（TanStack Query）。只读；写操作在页面组件里经 source.setRoom / setAll 发起。
// - 项目为 null、项目离线（真实接口）时不发 ctrl 请求（docs/分工.md 第 3 节第 6 条、plan 3.4）；
// - 真实接口每 15 秒刷新一次 200（上一次返回后才排下一次；标签页不可见时 TanStack 默认暂停）；
// - 写成功后调 refreshRooms() 立即重读 200，以设备回读值为准（plan 3.4）。
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { queryKeys } from '@/api/query'
import type { Project } from '@/data/org'
import type { CtrlReply } from '@/api/ctrl'
import type { RoomView } from './model'
import { thermostatSource } from './source'
import { currentSessionKey } from './writes'
import type { StatsRange } from './stats'

export const ROOMS_POLL_MS = 15_000

const roomsKey = (kind: 'real' | 'mock', projectId: string) =>
  kind === 'real' ? queryKeys.ctrl(200, projectId) : (['thermostat-mock', 'rooms', projectId] as const)

/** 是否可以读：有项目、有 id；真实接口还要求项目在线（离线时控制屏一定 503，不去打） */
export const canRead = (project: Pick<Project, 'id' | 'online'> | null, kind: 'real' | 'mock') =>
  !!project?.id && (kind === 'mock' || project.online === true)

/** 缓存里存一次 200 的页面列表与原始回包（206 的目标集合要按原始完整列表定，见 model.ts 的 allRoomsTarget） */
type RoomsData = { list: RoomView[]; raw: Pick<CtrlReply<200>, 'data'> }
const roomsQuery = (project: Project | null, enabled: boolean) => {
  const src = thermostatSource()
  const id = project?.id ?? ''
  return {
    queryKey: roomsKey(src.kind, id),
    queryFn: ({ signal }: { signal: AbortSignal }): Promise<RoomsData> => src.roomsRaw(id, signal),
    enabled: enabled && canRead(project, src.kind),
    staleTime: src.kind === 'real' ? 10_000 : Infinity,
  }
}

export function useRooms(project: Project | null, enabled = true) {
  const src = thermostatSource()
  return useQuery({ ...roomsQuery(project, enabled), select: (d: RoomsData) => d.list, refetchInterval: src.kind === 'real' ? ROOMS_POLL_MS : false })
}
/** 同一份缓存里的原始 200 回包（不另发请求、不另起轮询） */
export function useRoomsRaw(project: Project | null, enabled = true) {
  return useQuery({ ...roomsQuery(project, enabled), select: (d: RoomsData) => d.raw })
}

/**
 * 新读一次 200（下发流程的确认后预检、写后回读、核对都用它）：先取消该项目在途的 200（写前启动的轮询不算数），
 * 再直接发一次新请求（不经查询缓存去重，保证是此刻之后发起的），读到后写回缓存刷新界面。
 * 查询客户端是应用级的，页面卸载后这个函数仍可用
 */
export function useFreshRead(project: Project | null) {
  const qc = useQueryClient()
  const id = project?.id ?? ''
  return useCallback(async (signal?: AbortSignal) => {
    if (!id) throw new Error('没有当前项目')
    // 绑定发起时的会话代次：返回后先校验（会话变了或已中止就丢弃，不写缓存），再写回缓存
    const session = currentSessionKey()
    const src = thermostatSource()
    const key = roomsKey(src.kind, id)
    await qc.cancelQueries({ queryKey: key, exact: true })
    const r = await src.roomsRaw(id, signal)
    if (signal?.aborted) throw new Error('读取已中止，结果已丢弃')
    if (currentSessionKey() !== session) throw new Error('读取期间登录状态已变化，结果已丢弃')
    qc.setQueryData(key, r)
    return r
  }, [qc, id])
}
/** 新读一次 200，只要页面用的房间列表 */
export function useFreshRooms(project: Project | null) {
  const read = useFreshRead(project)
  return useCallback(async (signal?: AbortSignal): Promise<RoomView[]> => (await read(signal)).list, [read])
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
