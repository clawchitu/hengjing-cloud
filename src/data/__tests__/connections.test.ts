// 设备连接状态的纯函数：ctrl 205 字段映射、缺省字段与 65536、状态统计与筛选、控制屏 / DTU 编号。
import { describe, expect, it } from 'vitest'
import { fromBinary } from '@bufbuild/protobuf'
import { base64Decode } from '@bufbuild/protobuf/wire'
import { decodeReply, encodeMessage } from '../../api/ctrl'
import * as pb from '../../api/gen/ctrl200_pb.js'
import { connCounts, filterConn, mockConnRows, pct, toConnRows, toConnStatus } from '../connections'
import { toProject } from '../org/map'

// 11/24 测试环境 240829001 的 205 真实回复（只读联调抓到的，device_id 全部缺省）
const LIVE_205 = 'CjASCee9kee7nEhVQhoSNDg1572R57uc6ZuG57q/5ZmoIg0xOTIuMTY4LjAuMTAyKAEKHhII5oi/\n6Ze0MTEaDOaIv+mXtOmdouadvyICMTEoAQoeEgjmiL/pl7QxMhoM5oi/6Ze06Z2i5p2/IgIxMigB\nCh4SCOaIv+mXtDEzGgzmiL/pl7TpnaLmnb8iAjEzKAEKHBIDS0MyGg/nqbrmsJTkvKDmhJ/lmagi\nAjMyKAEKHRIEQ1MxMBoP6ZuG5Lit5o6n5Yi25ZmoIgI2NCgBCiESB1RYRlM1MDAaD+epuuawlOWk\nhOeQhuacuiIDMTExKAEKHRIG56m66LCDGgznqbrosIPkuLvmnLoiAzE3NigBChUSBEpNV0caBue9\nkeWFsyIDMjE4KAE=\n'

describe('toConnStatus', () => {
  it('0 离线、1 在线、2 异常', () => {
    expect([0, 1, 2].map(toConnStatus)).toEqual(['offline', 'online', 'error'])
  })
  it('缺省按 proto3 默认值 0 即离线', () => {
    expect(toConnStatus(undefined)).toBe('offline')
    expect(toConnStatus(null)).toBe('offline')
  })
  it('65536（未初始化）、其他数值、非数值一律未知，不混进三种状态', () => {
    for (const v of [65536, 3, -1, 1.5, NaN, '1', true]) expect(toConnStatus(v)).toBe('unknown')
  })
})

describe('toConnRows（ctrl 205 → 连接明细）', () => {
  it('真实回复：名称、型号、地址、状态逐项对上；device_id 缺省为 null，行键用序号', () => {
    const rows = toConnRows(decodeReply(pb.DeviceSummaryGetReplySchema, LIVE_205) as never)
    expect(rows).toHaveLength(9)
    expect(rows[0]).toEqual({ key: '0', deviceId: null, name: '网络HUB', model: '485网络集线器', address: '192.168.0.102', status: 'online' })
    expect(rows.map((r) => r.name)).toEqual(['网络HUB', '房间11', '房间12', '房间13', 'KC2', 'CS10', 'TXFS500', '空调', 'JMWG'])
    expect(rows.map((r) => r.key)).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8'])
    expect(rows.every((r) => r.status === 'online')).toBe(true)
  })

  it('编码往返：字段号 1–5 对应 device_id / device_name / model / address / conn_status', () => {
    const body = encodeMessage(pb.DeviceSummaryGetReplySchema, { data: [
      { deviceId: 9326461980, deviceName: '除湿机', model: 'TXFS500', address: '0x31', connStatus: 2 },
    ] })
    const raw = fromBinary(pb.DeviceSummaryGetReplySchema, base64Decode(body))
    expect(raw.data[0].deviceId).toBe(9326461980n)
    expect(toConnRows(decodeReply(pb.DeviceSummaryGetReplySchema, body) as never)).toEqual([
      { key: '0', deviceId: 9326461980, name: '除湿机', model: 'TXFS500', address: '0x31', status: 'error' },
    ])
  })

  it('缺省字段显示 --；conn_status 缺省为离线、65536 为未知；空白字符串也算缺省', () => {
    const body = encodeMessage(pb.DeviceSummaryGetReplySchema, { data: [
      {}, // 全部缺省（proto3 默认值不上线）
      { deviceName: '  ', model: '', address: '12', connStatus: 65536 },
    ] })
    expect(toConnRows(decodeReply(pb.DeviceSummaryGetReplySchema, body) as never)).toEqual([
      { key: '0', deviceId: null, name: '--', model: '--', address: '--', status: 'offline' },
      { key: '1', deviceId: null, name: '--', model: '--', address: '12', status: 'unknown' },
    ])
  })

  it('空回复、没有 data、data 不是数组：空列表', () => {
    expect(toConnRows(decodeReply(pb.DeviceSummaryGetReplySchema, '') as never)).toEqual([])
    expect(toConnRows(undefined)).toEqual([])
    expect(toConnRows({ data: 'x' } as never)).toEqual([])
  })

  it('同名设备不会因为行键重复而丢行', () => {
    const rows = toConnRows({ data: [{ deviceName: 'KC2', connStatus: 1 }, { deviceName: 'KC2', connStatus: 0 }] } as never)
    expect(new Set(rows.map((r) => r.key)).size).toBe(2)
  })
})

describe('统计与筛选（三种连接状态）', () => {
  const rows = toConnRows({ data: [
    { deviceName: 'A', model: 'M1', connStatus: 1 },
    { deviceName: 'B', model: 'M1', connStatus: 1 },
    { deviceName: 'C', model: 'M2', connStatus: 0 },
    { deviceName: 'D', model: '', connStatus: 2 },
    { deviceName: 'E', model: 'M3', connStatus: 65536 },
  ] } as never)

  it('按 conn_status 计数；未知只计入总数；型号数不算缺省型号', () => {
    expect(connCounts(rows)).toEqual({ total: 5, online: 2, offline: 1, error: 1, unknown: 1, models: 3 })
  })

  it('全部 / 在线 / 离线 / 异常 各自只留对应状态', () => {
    expect(filterConn(rows, '全部').map((r) => r.name)).toEqual(['A', 'B', 'C', 'D', 'E'])
    expect(filterConn(rows, '在线').map((r) => r.name)).toEqual(['A', 'B'])
    expect(filterConn(rows, '离线').map((r) => r.name)).toEqual(['C'])
    expect(filterConn(rows, '异常').map((r) => r.name)).toEqual(['D'])
  })

  it('百分比一位小数；总数为 0 时不出现 NaN', () => {
    expect(pct(2, 5)).toBe('40.0')
    expect(pct(0, 0)).toBeNull()
  })
})

describe('mockConnRows（演示数据）', () => {
  it('类型放进型号列、地址取总线地址后半段、通讯异常映射为 error', () => {
    expect(mockConnRows([
      { name: '水泵控制回路 EM-S04', type: '单相电表', bus: 'RS485-2 / 0x0E', proto: 'DL/T645', state: '通讯异常', loss: 14.2, last: '' },
      { name: '热泵主机', type: '空调主机', bus: 'LAN', proto: '', state: '离线', loss: 0, last: '' },
    ])).toEqual([
      { key: '0', deviceId: null, name: '水泵控制回路 EM-S04', model: '单相电表', address: '0x0E', status: 'error' },
      { key: '1', deviceId: null, name: '热泵主机', model: '空调主机', address: 'LAN', status: 'offline' },
    ])
  })
})

describe('项目在线判定', () => {
  it('项目实体：control_screen_id / dtu_id 映射过来；online 只有 true 才算在线', () => {
    const p = toProject({ id: 'x', control_screen_id: '667b7cc60b7d46467c424d33', online: true } as never)
    expect(p.controlScreenId).toBe('667b7cc60b7d46467c424d33')
    expect(p.online).toBe(true)
    for (const online of [undefined, false, 'true', 1, null]) expect(toProject({ id: 'x', online } as never).online).toBe(false)
  })
})
