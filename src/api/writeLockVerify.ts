// 写锁核对用的纯比对函数（不发请求，读取由调用方注入）：把持久化的核对数据（消息号、设备 id、目标字段与值）
// 与回读结果比对。按消息类型回读：201 / 206 → 200（房间温控数据）；204 → 210（运行控制数据，本文件暂不提供）。
//
// 203（统一控制）的核对结论（对照 docs/api/ctrlcb.proto）：200 的 RoomTemperatureData 只有房间级的 switch（#13）与 set_temp（#6），
// 能核对 203 的 room_switch 与 room_temp；200–210 里没有系统开关 system_switch 与运行模式 system_mode 的读数（只有 TP 系列的
// TPSystemModeGet(101)，不在恒境云用到的同步接口里），所以 203 改了系统开关 / 运行模式时无法核对，只能按有效期放锁。
//
// 用法（页面或应用初始化时）：
//   registerVerifier(201, async (rec, signal) => matchRoomSet(rec, await callCtrl(200, rec.projectId, {}, { signal })))
//   registerVerifier(206, async (rec, signal) => matchAllRoomsSwitch(rec, await callCtrl(200, rec.projectId, {}, { signal })))
import type { CtrlReply } from './ctrl'
import type { SentRecord } from './writeLock'

type Rooms = Pick<CtrlReply<200>, 'data'>

/** 设定温度是 float，按 0.05 比较 */
const sameTemp = (a: number, b: number) => Math.abs(a - b) < 0.05

/** 201 字段 → 200 字段；不改的字段（-1）不比 */
const ROOM_FIELDS: Record<string, (r: Rooms['data'][number], v: number) => boolean> = {
  temperature: (r, v) => sameTemp(r.setTemp, v),
  eco: (r, v) => r.eco === v,
  switch: (r, v) => r.switch === v,
}

/**
 * 201（单房间设置）：200 里找到 deviceId 对应的房间，目标里每个改了的字段（不是 -1）都与读数一致才算一致。
 * 目标里出现不认识的字段（无法核对）、找不到房间、没有任何可比字段 → 不一致
 */
export function matchRoomSet(rec: Pick<SentRecord, 'msg' | 'deviceId' | 'target'>, reply: Rooms): boolean {
  if (rec.msg !== 201 || rec.deviceId === null) return false
  const room = (reply.data ?? []).find((r) => r.id === rec.deviceId)
  if (!room) return false
  let compared = 0
  for (const [field, v] of Object.entries(rec.target)) {
    if (v === -1) continue
    const cmp = ROOM_FIELDS[field]
    if (!cmp || typeof v !== 'number') return false
    if (!cmp(room, v)) return false
    compared += 1
  }
  return compared > 0
}

/** 206（全部房间开关）：200 里所有已连接的房间开关都等于目标值才算一致；没有已连接的房间 → 不一致 */
export function matchAllRoomsSwitch(rec: Pick<SentRecord, 'msg' | 'target'>, reply: Rooms): boolean {
  const want = rec.target.switch
  if (rec.msg !== 206 || (want !== 0 && want !== 1)) return false
  const rooms = (reply.data ?? []).filter((r) => r.isConnected === true)
  return rooms.length > 0 && rooms.every((r) => r.switch === want)
}
