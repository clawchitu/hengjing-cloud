import { hasRooms as realHasRooms, isStandalone as realIsStandalone } from '../data/org/capabilities'
// Org structure: 经销商 (dealer) → 集成项目 (integration group) → 项目 (project).
// A dealer account only sees its own 集成项目; the admin account sees every dealer's.

export type Role = 'dealer' | 'admin'
export interface User { username: string; name: string; org: string; role: Role; roleLabel: string; dealerId?: string }

/** Profiles for the two demo logins. Passwords are checked by the Worker (/api/login), never stored here. */
export const users: Record<string, User> = {
  cosyhome: { username: 'cosyhome', name: '张建国', org: '华东运维中心', role: 'dealer', roleLabel: '经销商', dealerId: 'DLR-001' },
  hjadmin: { username: 'hjadmin', name: '王立', org: '恒境云平台', role: 'admin', roleLabel: '管理员' },
}

export interface Dealer { id: string; name: string; short: string; region: string }
export const dealers: Dealer[] = [
  { id: 'DLR-001', name: '上海恒境暖通工程有限公司', short: '上海恒境暖通', region: '华东' },
  { id: 'DLR-002', name: '杭州暖居环境科技有限公司', short: '杭州暖居环境', region: '浙江' },
  { id: 'DLR-003', name: '南京舒适家系统集成有限公司', short: '南京舒适家', region: '江苏' },
]

// PROGRAMS / gatewayOf 页面也在用（含交付包），放在 src/data/constants.ts，这里转出保持原有引用不变
export { PROGRAMS, gatewayOf } from '../data/constants'
export const FRESH_AIR_STANDALONE = 12

export interface Group {
  id: string
  dealerId: string
  name: string
  type: string
  typeColor: 'cyan' | 'blue' | 'purple' | 'orange'
  desc: string
  created: string
}

export const groups: Group[] = [
  { id: 'GRP-SH-001', dealerId: 'DLR-001', name: '朝阳壹号院住宅组', type: '三恒住宅', typeColor: 'cyan', created: '2024-03-12 09:24', desc: '上海浦东朝阳壹号院高端住宅三恒系统（恒温、恒湿、恒氧），包含顶辐射、地暖、新风除湿及空气源热泵机组。' },
  { id: 'GRP-SH-002', dealerId: 'DLR-001', name: '金桥科创园区', type: '办公楼宇', typeColor: 'blue', created: '2024-05-20 14:10', desc: '浦东金桥科创园区办公楼宇集中空调与新风系统，覆盖 8 栋研发办公楼。' },
  { id: 'GRP-HZ-003', dealerId: 'DLR-001', name: '滨江别墅区', type: '独栋别墅', typeColor: 'purple', created: '2024-08-02 10:45', desc: '杭州滨江独栋别墅五恒系统，地源热泵 + 毛细管辐射 + 全热新风；部分户型为新风单机版。' },
  { id: 'GRP-SZ-004', dealerId: 'DLR-001', name: '苏州湖畔酒店公寓', type: '酒店公寓', typeColor: 'orange', created: '2025-01-15 16:30', desc: '苏州金鸡湖畔酒店式公寓客房温控与新风除湿集中管理。' },
  { id: 'GRP-HZ-101', dealerId: 'DLR-002', name: '西溪蝶园别墅组', type: '独栋别墅', typeColor: 'purple', created: '2024-06-08 11:02', desc: '杭州西溪蝶园独栋别墅三恒系统，含新风单机版改造户。' },
  { id: 'GRP-HZ-102', dealerId: 'DLR-002', name: '钱江新城写字楼', type: '办公楼宇', typeColor: 'blue', created: '2024-11-21 09:15', desc: '钱江新城甲级写字楼楼层新风除湿与温控集中管理。' },
  { id: 'GRP-NJ-201', dealerId: 'DLR-003', name: '河西府住宅组', type: '三恒住宅', typeColor: 'cyan', created: '2025-02-27 15:40', desc: '南京河西府高端住宅三恒系统（恒温、恒湿、恒氧）。' },
]

export interface Project {
  id: string
  name: string
  groupId: string
  city: string
  district: string
  kind: string
  online: boolean
  version: string
  devices: number
  /** 程序编码, see PROGRAMS */
  programCode: number
  temp?: number
  humidity?: number
  co2?: number
  /** only for offline projects: last time the gateway reported (demo clock) */
  lastOnline?: string
  lastOnlineAgo?: string
}

const p = (id: string, name: string, groupId: string, city: string, district: string, kind: string, online: boolean, version: string, devices: number, programCode: number, extra: Partial<Project> = {}): Project =>
  ({ id, name, groupId, city, district, kind, online, version, devices, programCode, ...extra })

export const projects: Project[] = [
  // ---- DLR-001 上海恒境暖通 (the dealer demo login) — matches the design PDF: 4 集成项目 / 28 项目
  p('PRJ-10241', '朝阳壹号院 A栋', 'GRP-SH-001', '上海', '浦东新区', '三恒住宅', true, 'v3.6.2', 24, 11, { temp: 25.8, humidity: 52, co2: 612 }),
  p('PRJ-10242', '朝阳壹号院 B栋', 'GRP-SH-001', '上海', '浦东新区', '三恒住宅', true, 'v3.6.2', 22, 11, { temp: 26.1, humidity: 55, co2: 680 }),
  p('PRJ-10243', '朝阳壹号院 C栋', 'GRP-SH-001', '上海', '浦东新区', '三恒住宅', true, 'v3.6.1', 25, 11, { temp: 25.5, humidity: 51 }),
  p('PRJ-10244', '朝阳壹号院 D栋', 'GRP-SH-001', '上海', '浦东新区', '三恒住宅', false, 'v3.5.8', 23, 11, { lastOnline: '2025-06-18 13:42:10', lastOnlineAgo: '2 小时前' }),
  p('PRJ-10245', '朝阳壹号院 会所', 'GRP-SH-001', '上海', '浦东新区', '三恒住宅', true, 'v3.6.2', 25, 11, { temp: 25.2, humidity: 50, co2: 590 }),
  p('PRJ-10246', '朝阳壹号院 E栋', 'GRP-SH-001', '上海', '浦东新区', '三恒住宅', true, 'v3.6.2', 23, 11, { temp: 25.9, humidity: 53, co2: 655 }),
  p('PRJ-10247', '朝阳壹号院 F栋', 'GRP-SH-001', '上海', '浦东新区', '三恒住宅', true, 'v3.6.2', 24, 11, { temp: 26.0, humidity: 54, co2: 702 }),
  p('PRJ-10248', '朝阳壹号院 G栋', 'GRP-SH-001', '上海', '浦东新区', '三恒住宅', true, 'v3.6.2', 22, 11, { temp: 25.7, humidity: 52, co2: 615 }),
  p('PRJ-10249', '朝阳壹号院 H栋', 'GRP-SH-001', '上海', '浦东新区', '三恒住宅', true, 'v3.6.2', 22, 11, { temp: 25.6, humidity: 51, co2: 598 }),
  p('PRJ-10250', '朝阳壹号院 J栋', 'GRP-SH-001', '上海', '浦东新区', '三恒住宅', true, 'v3.6.1', 21, 11, { temp: 26.3, humidity: 56, co2: 724 }),
  p('PRJ-10251', '朝阳壹号院 K栋', 'GRP-SH-001', '上海', '浦东新区', '三恒住宅', true, 'v3.6.2', 23, 11, { temp: 25.4, humidity: 50, co2: 588 }),
  p('PRJ-10252', '朝阳壹号院 地库新风', 'GRP-SH-001', '上海', '浦东新区', '三恒住宅', true, 'v3.6.2', 7, 12, { temp: 27.1, humidity: 60, co2: 760 }),
  p('PRJ-20117', '金桥科创中心 3F', 'GRP-SH-002', '上海', '浦东新区', '办公楼宇', true, 'v3.6.2', 48, 21, { temp: 24.9, humidity: 49, co2: 845 }),
  ...['1号楼', '2号楼', '4号楼', '5号楼', '6号楼', '7号楼', '8号楼'].map((b, i) =>
    p(`PRJ-201${20 + i}`, `金桥科创园 ${b}`, 'GRP-SH-002', '上海', '浦东新区', '办公楼宇', true, 'v3.6.2', 40 + i * 3, 21, { temp: 25 + (i % 3) * 0.3, humidity: 50 + i, co2: 700 + i * 20 })),
  p('PRJ-30056', '滨江别墅 12号', 'GRP-HZ-003', '杭州', '滨江区', '独栋别墅', false, 'v3.5.8', 18, 31, { lastOnline: '2025-06-18 13:40:52', lastOnlineAgo: '2 小时前' }),
  p('PRJ-30057', '滨江别墅 15号', 'GRP-HZ-003', '杭州', '滨江区', '独栋别墅', true, 'v3.6.2', 3, 12, { temp: 25.3, humidity: 51, co2: 560 }),
  p('PRJ-30058', '滨江别墅 21号', 'GRP-HZ-003', '杭州', '滨江区', '独栋别墅', true, 'v3.6.2', 20, 31, { temp: 25.8, humidity: 53, co2: 610 }),
  p('PRJ-30059', '滨江别墅 26号', 'GRP-HZ-003', '杭州', '滨江区', '独栋别墅', false, 'v3.5.8', 16, 31, { lastOnline: '2025-06-17 15:12:33', lastOnlineAgo: '1 天前' }),
  p('PRJ-30060', '滨江别墅 33号', 'GRP-HZ-003', '杭州', '滨江区', '独栋别墅', true, 'v3.6.1', 19, 31, { temp: 26.0, humidity: 54, co2: 650 }),
  p('PRJ-40011', '湖畔公寓 1号楼', 'GRP-SZ-004', '苏州', '工业园区', '酒店公寓', true, 'v3.6.2', 64, 11, { temp: 25.1, humidity: 50, co2: 620 }),
  p('PRJ-40012', '湖畔公寓 2号楼', 'GRP-SZ-004', '苏州', '工业园区', '酒店公寓', true, 'v3.6.2', 60, 11, { temp: 25.4, humidity: 52, co2: 640 }),
  p('PRJ-40013', '湖畔公寓 3号楼', 'GRP-SZ-004', '苏州', '工业园区', '酒店公寓', true, 'v3.6.2', 58, 11, { temp: 25.6, humidity: 53, co2: 660 }),
  // ---- DLR-002 杭州暖居环境 (admin-only)
  p('PRJ-50101', '西溪蝶园 3号', 'GRP-HZ-101', '杭州', '西湖区', '独栋别墅', true, 'v3.6.2', 21, 31, { temp: 25.6, humidity: 50, co2: 580 }),
  p('PRJ-50102', '西溪蝶园 7号', 'GRP-HZ-101', '杭州', '西湖区', '独栋别墅', true, 'v3.6.2', 4, 12, { temp: 26.2, humidity: 55, co2: 690 }),
  p('PRJ-50103', '西溪蝶园 11号', 'GRP-HZ-101', '杭州', '西湖区', '独栋别墅', false, 'v3.5.8', 19, 31, { lastOnline: '2025-06-18 09:05:41', lastOnlineAgo: '6 小时前' }),
  p('PRJ-50104', '西溪蝶园 16号', 'GRP-HZ-101', '杭州', '西湖区', '独栋别墅', true, 'v3.6.1', 22, 31, { temp: 25.1, humidity: 49, co2: 540 }),
  p('PRJ-50201', '钱江新城 A座 18F', 'GRP-HZ-102', '杭州', '上城区', '办公楼宇', true, 'v3.6.2', 36, 21, { temp: 25.0, humidity: 51, co2: 810 }),
  p('PRJ-50202', '钱江新城 A座 19F', 'GRP-HZ-102', '杭州', '上城区', '办公楼宇', true, 'v3.6.2', 36, 21, { temp: 25.3, humidity: 52, co2: 760 }),
  p('PRJ-50203', '钱江新城 B座 7F', 'GRP-HZ-102', '杭州', '上城区', '办公楼宇', true, 'v3.6.2', 30, 21, { temp: 24.8, humidity: 48, co2: 720 }),
  // ---- DLR-003 南京舒适家 (admin-only)
  p('PRJ-60011', '河西府 1栋', 'GRP-NJ-201', '南京', '建邺区', '三恒住宅', true, 'v3.6.2', 26, 11, { temp: 25.7, humidity: 53, co2: 630 }),
  p('PRJ-60012', '河西府 2栋', 'GRP-NJ-201', '南京', '建邺区', '三恒住宅', true, 'v3.6.2', 26, 11, { temp: 25.9, humidity: 54 }),
  p('PRJ-60013', '河西府 3栋', 'GRP-NJ-201', '南京', '建邺区', '三恒住宅', false, 'v3.6.1', 25, 11, { lastOnline: '2025-06-16 22:18:05', lastOnlineAgo: '2 天前' }),
  p('PRJ-60014', '河西府 会所新风', 'GRP-NJ-201', '南京', '建邺区', '三恒住宅', true, 'v3.6.2', 5, 12, { temp: 26.4, humidity: 57, co2: 700 }),
]

export const dealerOf = (groupId: string) => groups.find((g) => g.id === groupId)?.dealerId
export const isStandalone = (p: Pick<Project, 'programCode'>) => realIsStandalone(p)
/** 有房间温控：与真实口径同一来源（capabilities.ts：8、12 没有房间） */
export const hasRooms = (p: Pick<Project, 'programCode'>) => realHasRooms(p)
