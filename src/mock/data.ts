// 恒境云 mock data. Everything is anchored to one demo day (2025-06-18) and one
// primary project (朝阳壹号院 A栋 · PRJ-10241) so numbers agree across pages.

export const DEMO_DATE = '2025-06-18'

export const user = { name: '张建国', org: '华东运维中心', role: '管理员' }

// ---------------------------------------------------------------- groups & projects
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
  temp?: number
  humidity?: number
  co2?: number
  lastOnline?: string
}

export interface Group {
  id: string
  name: string
  type: string
  typeColor: 'cyan' | 'blue' | 'purple' | 'orange'
  desc: string
  created: string
}

export const groups: Group[] = [
  { id: 'GRP-SH-001', name: '朝阳壹号院住宅组', type: '三恒住宅', typeColor: 'cyan', created: '2024-03-12 09:24', desc: '上海浦东朝阳壹号院高端住宅三恒系统（恒温、恒湿、恒氧），包含顶辐射、地暖、新风除湿及空气源热泵机组。' },
  { id: 'GRP-SH-002', name: '金桥科创园区', type: '办公楼宇', typeColor: 'blue', created: '2024-05-20 14:10', desc: '浦东金桥科创园区办公楼宇集中空调与新风系统，覆盖 8 栋研发办公楼。' },
  { id: 'GRP-HZ-003', name: '滨江别墅区', type: '独栋别墅', typeColor: 'purple', created: '2024-08-02 10:45', desc: '杭州滨江独栋别墅五恒系统，地源热泵 + 毛细管辐射 + 全热新风。' },
  { id: 'GRP-SZ-004', name: '苏州湖畔酒店公寓', type: '酒店公寓', typeColor: 'orange', created: '2025-01-15 16:30', desc: '苏州金鸡湖畔酒店式公寓客房温控与新风除湿集中管理。' },
]

const p = (id: string, name: string, groupId: string, city: string, district: string, kind: string, online: boolean, version: string, devices: number, extra: Partial<Project> = {}): Project =>
  ({ id, name, groupId, city, district, kind, online, version, devices, ...extra })

export const projects: Project[] = [
  p('PRJ-10241', '朝阳壹号院 A栋', 'GRP-SH-001', '上海', '浦东新区', '三恒住宅', true, 'v3.6.2', 24, { temp: 25.8, humidity: 52, co2: 612 }),
  p('PRJ-10242', '朝阳壹号院 B栋', 'GRP-SH-001', '上海', '浦东新区', '三恒住宅', true, 'v3.6.2', 22, { temp: 26.1, humidity: 55, co2: 680 }),
  p('PRJ-10243', '朝阳壹号院 C栋', 'GRP-SH-001', '上海', '浦东新区', '三恒住宅', true, 'v3.6.1', 25, { temp: 25.5, humidity: 51, co2: 640 }),
  p('PRJ-10244', '朝阳壹号院 D栋', 'GRP-SH-001', '上海', '浦东新区', '三恒住宅', false, 'v3.5.8', 23, { lastOnline: '2 小时前' }),
  p('PRJ-10245', '朝阳壹号院 会所', 'GRP-SH-001', '上海', '浦东新区', '三恒住宅', true, 'v3.6.2', 25, { temp: 25.2, humidity: 50, co2: 590 }),
  p('PRJ-10246', '朝阳壹号院 E栋', 'GRP-SH-001', '上海', '浦东新区', '三恒住宅', true, 'v3.6.2', 23, { temp: 25.9, humidity: 53, co2: 655 }),
  p('PRJ-10247', '朝阳壹号院 F栋', 'GRP-SH-001', '上海', '浦东新区', '三恒住宅', true, 'v3.6.2', 24, { temp: 26.0, humidity: 54, co2: 702 }),
  p('PRJ-10248', '朝阳壹号院 G栋', 'GRP-SH-001', '上海', '浦东新区', '三恒住宅', true, 'v3.6.2', 22, { temp: 25.7, humidity: 52, co2: 615 }),
  p('PRJ-10249', '朝阳壹号院 H栋', 'GRP-SH-001', '上海', '浦东新区', '三恒住宅', true, 'v3.6.2', 22, { temp: 25.6, humidity: 51, co2: 598 }),
  p('PRJ-10250', '朝阳壹号院 J栋', 'GRP-SH-001', '上海', '浦东新区', '三恒住宅', true, 'v3.6.1', 21, { temp: 26.3, humidity: 56, co2: 724 }),
  p('PRJ-10251', '朝阳壹号院 K栋', 'GRP-SH-001', '上海', '浦东新区', '三恒住宅', true, 'v3.6.2', 23, { temp: 25.4, humidity: 50, co2: 588 }),
  p('PRJ-10252', '朝阳壹号院 地库', 'GRP-SH-001', '上海', '浦东新区', '三恒住宅', true, 'v3.6.2', 12, { temp: 27.1, humidity: 60, co2: 760 }),
  p('PRJ-20117', '金桥科创中心 3F', 'GRP-SH-002', '上海', '浦东新区', '办公楼宇', true, 'v3.6.2', 48, { temp: 24.9, humidity: 49, co2: 845 }),
  ...['1号楼', '2号楼', '4号楼', '5号楼', '6号楼', '7号楼', '8号楼'].map((b, i) =>
    p(`PRJ-201${20 + i}`, `金桥科创园 ${b}`, 'GRP-SH-002', '上海', '浦东新区', '办公楼宇', true, 'v3.6.2', 40 + i * 3, { temp: 25 + (i % 3) * 0.3, humidity: 50 + i, co2: 700 + i * 20 })),
  p('PRJ-30056', '滨江别墅 12号', 'GRP-HZ-003', '杭州', '滨江区', '独栋别墅', false, 'v3.5.8', 18, { lastOnline: '2 小时前' }),
  p('PRJ-30057', '滨江别墅 15号', 'GRP-HZ-003', '杭州', '滨江区', '独栋别墅', true, 'v3.6.2', 18, { temp: 25.3, humidity: 51, co2: 560 }),
  p('PRJ-30058', '滨江别墅 21号', 'GRP-HZ-003', '杭州', '滨江区', '独栋别墅', true, 'v3.6.2', 20, { temp: 25.8, humidity: 53, co2: 610 }),
  p('PRJ-30059', '滨江别墅 26号', 'GRP-HZ-003', '杭州', '滨江区', '独栋别墅', false, 'v3.5.8', 16, { lastOnline: '1 天前' }),
  p('PRJ-30060', '滨江别墅 33号', 'GRP-HZ-003', '杭州', '滨江区', '独栋别墅', true, 'v3.6.1', 19, { temp: 26.0, humidity: 54, co2: 650 }),
  p('PRJ-40011', '湖畔公寓 1号楼', 'GRP-SZ-004', '苏州', '工业园区', '酒店公寓', true, 'v3.6.2', 64, { temp: 25.1, humidity: 50, co2: 620 }),
  p('PRJ-40012', '湖畔公寓 2号楼', 'GRP-SZ-004', '苏州', '工业园区', '酒店公寓', true, 'v3.6.2', 60, { temp: 25.4, humidity: 52, co2: 640 }),
  p('PRJ-40013', '湖畔公寓 3号楼', 'GRP-SZ-004', '苏州', '工业园区', '酒店公寓', true, 'v3.6.2', 58, { temp: 25.6, humidity: 53, co2: 660 }),
]

// ---------------------------------------------------------------- 房间温控面板
export type FanSpeed = '低速' | '中速' | '高速' | '自动' | '--'
export interface Room {
  id: string
  name: string
  floor: string
  on: boolean
  mode: '标准' | '节能'
  temp: number
  humidity: number
  dew: number
  setTemp: number
  setHumidity: number
  fan: FanSpeed
  radiant: boolean
  floorHeat: boolean
  fanCoil: boolean
}

export const rooms: Room[] = [
  { id: 'TP-01', name: '客厅', floor: '1F', on: true, mode: '标准', temp: 25.8, humidity: 51, dew: 14.9, setTemp: 26.0, setHumidity: 50, fan: '中速', radiant: true, floorHeat: false, fanCoil: true },
  { id: 'TP-02', name: '主卧', floor: '2F', on: true, mode: '标准', temp: 26.2, humidity: 55, dew: 16.5, setTemp: 25.5, setHumidity: 50, fan: '低速', radiant: true, floorHeat: false, fanCoil: false },
  { id: 'TP-03', name: '次卧', floor: '2F', on: true, mode: '节能', temp: 25.4, humidity: 50, dew: 14.3, setTemp: 27.0, setHumidity: 55, fan: '自动', radiant: true, floorHeat: false, fanCoil: false },
  { id: 'TP-04', name: '书房', floor: '2F', on: true, mode: '标准', temp: 24.9, humidity: 49, dew: 13.6, setTemp: 25.0, setHumidity: 50, fan: '高速', radiant: false, floorHeat: false, fanCoil: true },
  { id: 'TP-05', name: '老人房', floor: '1F', on: true, mode: '节能', temp: 26.0, humidity: 52, dew: 15.5, setTemp: 26.5, setHumidity: 55, fan: '--', radiant: false, floorHeat: true, fanCoil: false },
  { id: 'TP-06', name: '客卧', floor: '3F', on: false, mode: '标准', temp: 27.3, humidity: 60, dew: 18.8, setTemp: 26.0, setHumidity: 50, fan: '--', radiant: false, floorHeat: false, fanCoil: false },
]

// ---------------------------------------------------------------- 新风除湿机
export interface FreshAir {
  id: string
  name: string
  floor: string
  status: 'run' | 'filter' | 'off'
  on: boolean
  supplyTemp: number
  supplyHum: number
  supplyDew: number
  returnTemp: number
  returnHum: number
  freshTemp: number
  freshHum: number
  filter: number
  filterHours: number
  filterDays: number
  control: 'dew' | 'hum'
  dewSet: number
  humSet: number
  fan: '低' | '中' | '高'
  rpm: number
  airflow: number
  compressor: boolean
  hz: number
}

export const freshAirUnits: FreshAir[] = [
  { id: 'FA-01', name: '新风机 FA-01', floor: '1F', status: 'run', on: true, supplyTemp: 18.6, supplyHum: 62, supplyDew: 11.2, returnTemp: 25.4, returnHum: 52, freshTemp: 31.2, freshHum: 68, filter: 72, filterHours: 1260, filterDays: 58, control: 'dew', dewSet: 12.0, humSet: 50, fan: '中', rpm: 1350, airflow: 350, compressor: true, hz: 48 },
  { id: 'FA-02', name: '新风机 FA-02', floor: '2F', status: 'run', on: true, supplyTemp: 19.1, supplyHum: 58, supplyDew: 10.7, returnTemp: 25.9, returnHum: 54, freshTemp: 31.2, freshHum: 68, filter: 45, filterHours: 2480, filterDays: 36, control: 'hum', dewSet: 12.0, humSet: 55, fan: '低', rpm: 980, airflow: 260, compressor: true, hz: 42 },
  { id: 'FA-03', name: '新风机 FA-03', floor: '3F', status: 'filter', on: true, supplyTemp: 18.9, supplyHum: 64, supplyDew: 11.9, returnTemp: 26.4, returnHum: 56, freshTemp: 31.2, freshHum: 68, filter: 8, filterHours: 4180, filterDays: 6, control: 'dew', dewSet: 12.5, humSet: 50, fan: '高', rpm: 1720, airflow: 450, compressor: true, hz: 55 },
  { id: 'DH-01', name: '除湿机 DH-01', floor: 'B1', status: 'off', on: false, supplyTemp: 24.8, supplyHum: 63, supplyDew: 17.3, returnTemp: 24.8, returnHum: 63, freshTemp: 31.2, freshHum: 68, filter: 86, filterHours: 620, filterDays: 72, control: 'hum', dewSet: 12.0, humSet: 50, fan: '低', rpm: 0, airflow: 0, compressor: false, hz: 0 },
]

// ---------------------------------------------------------------- 电表
export interface Meter {
  id: string
  name: string
  model: string
  phase: '单相' | '三相'
  addr: string
  voltage: number
  current: number
  power: number
  today: number
  total: number
  month: number
  icon: 'bulb' | 'fan' | 'kitchen' | 'water' | 'heat' | 'elevator'
  voltages?: [number, number, number]
  currents?: [number, number, number]
}

export const meters: Meter[] = [
  { id: 'EM-T01', name: '热泵主机总回路', model: 'DTSD1352', phase: '三相', addr: '001', voltage: 381.2, current: 12.6, power: 7.86, today: 96.3, total: 28416.2, month: 1682.5, icon: 'heat', voltages: [220.4, 219.8, 221.1], currents: [12.4, 12.9, 12.5] },
  { id: 'EM-T02', name: '电梯动力回路', model: 'DTSD1352', phase: '三相', addr: '002', voltage: 380.6, current: 4.1, power: 1.95, today: 26.1, total: 6102.8, month: 452.0, icon: 'elevator', voltages: [219.6, 220.2, 219.9], currents: [4.0, 4.3, 3.9] },
  { id: 'EM-S01', name: '照明插座回路', model: 'DDS1352', phase: '单相', addr: '011', voltage: 228.6, current: 6.42, power: 1.43, today: 21.6, total: 5284.6, month: 398.1, icon: 'bulb' },
  { id: 'EM-S02', name: '新风除湿回路', model: 'DDS1352', phase: '单相', addr: '012', voltage: 229.1, current: 4.18, power: 0.94, today: 18.2, total: 4906.3, month: 336.4, icon: 'fan' },
  { id: 'EM-S03', name: '厨房电器回路', model: 'DDS1352', phase: '单相', addr: '013', voltage: 227.8, current: 9.86, power: 2.18, today: 14.8, total: 3872.0, month: 265.7, icon: 'kitchen' },
  { id: 'EM-S04', name: '水泵控制回路', model: 'DDS1352', phase: '单相', addr: '014', voltage: 228.9, current: 2.06, power: 0.46, today: 9.4, total: 1968.5, month: 113.3, icon: 'water' },
]

// 18 days of stacked usage by circuit (kWh)
export const usageDays = Array.from({ length: 18 }, (_, i) => `6/${i + 1}`)
const heat = [82, 110, 96, 101, 107, 87, 110, 92, 106, 104, 94, 110, 85, 107, 98, 98, 108, 85]
export const usageSeries = {
  热泵主机: heat,
  新风除湿: heat.map((v, i) => Math.round(13 + ((v + i * 7) % 9))),
  照明插座: heat.map((v, i) => Math.round(14 + ((v * 3 + i) % 10))),
  厨房电器: heat.map((v, i) => Math.round(11 + ((v + i * 5) % 7))),
  其他: heat.map((v, i) => Math.round(28 + ((v * 7 + i * 3) % 18))),
}
export const todayShare = [
  { name: '热泵主机', value: 96.3 },
  { name: '电梯动力', value: 26.1 },
  { name: '照明插座', value: 21.6 },
  { name: '新风除湿', value: 18.2 },
  { name: '厨房电器', value: 14.8 },
  { name: '水泵', value: 9.4 },
]

// ---------------------------------------------------------------- devices (tree for 实时数据 / 参数 / 连接)
export interface DeviceNode { id: string; name: string; group: '空调主机' | '新风系统' | '水系统'; status: '制冷运行' | '待机' | '运行' | '关机' | '告警'; icon: 'snow' | 'fan' | 'fanoff' | 'water' | 'faucet' }
export const deviceTree: DeviceNode[] = [
  { id: 'HP-01', name: '热泵主机 HP-01', group: '空调主机', status: '制冷运行', icon: 'snow' },
  { id: 'HP-02', name: '热泵主机 HP-02', group: '空调主机', status: '待机', icon: 'snow' },
  { id: 'FA-01', name: '新风机 FA-01', group: '新风系统', status: '运行', icon: 'fan' },
  { id: 'FA-02', name: '新风机 FA-02', group: '新风系统', status: '运行', icon: 'fan' },
  { id: 'DH-01', name: '除湿机 DH-01', group: '新风系统', status: '关机', icon: 'fanoff' },
  { id: 'WP-01', name: '循环水泵 WP-01', group: '水系统', status: '运行', icon: 'water' },
  { id: 'MX-01', name: '混水中心 MX-01', group: '水系统', status: '告警', icon: 'faucet' },
]

export interface HeatPumpLive {
  hz: number; targetHz: number; fanRpm: number; fanGear: number; pumpRpm: number; flow: number
  temps: Record<string, number>; press: Record<string, number>
  elec: Record<string, number>; run: Record<string, number>
}
export const heatPump: HeatPumpLive = {
  hz: 58, targetHz: 60, fanRpm: 720, fanGear: 7, pumpRpm: 2650, flow: 2.8,
  temps: { 出水温度: 7.2, 回水温度: 12.1, 环境温度: 31.4, 排气温度: 86.5, 吸气温度: 9.8, 翅片温度: 38.6, 模块温度: 52.3 },
  press: { 高压压力: 2.86, 低压压力: 0.92, 冷凝饱和温度: 46.2, 蒸发饱和温度: 4.6, 吸气过热度: 5.2, 水压: 0.18 },
  elec: { 输入电压: 226, 输入电流: 16.8, 压缩机电流: 14.2, 母线电压: 318, 输入功率: 3.72, 制冷量: 13.6, 实时COP: 3.66 },
  run: { 压缩机频率: 58, 压缩机转速: 3480, 外风机转速: 720, 水泵转速: 2650, EEV开度: 286, 启停次数: 1204 },
}

// ---------------------------------------------------------------- 工程参数
export interface Param { code: string; name: string; current: string; range: string; unit: string; def: string; min: number; max: number }
const P = (code: string, name: string, current: string, min: number, max: number, unit: string, range?: string): Param =>
  ({ code, name, current, def: current, unit, min, max, range: range ?? `${min} – ${max}` })
export const paramTabs: Record<string, Param[]> = {
  压缩机参数: [
    P('C01', '压缩机最高运行频率', '110', 30, 120, 'Hz'),
    P('C02', '压缩机最低运行频率', '20', 10, 40, 'Hz'),
    P('C03', '频率上升速率', '1.0', 0.5, 3, 'Hz/s', '0.5 – 3.0'),
    P('C04', '排气温度保护值', '105', 85, 115, '°C'),
    P('C05', '最短停机时间', '180', 60, 600, 's'),
    P('C06', '额定输入电压', '220', 198, 242, 'V'),
    P('C07', '压缩机过流保护值', '22.0', 15, 30, 'A'),
    P('C08', '目标吸气过热度', '5.0', 0, 15, 'K'),
    P('C09', '电子膨胀阀初始开度', '240', 80, 480, '步'),
    P('C10', '高压保护值', '4.15', 3.5, 4.4, 'MPa', '3.50 – 4.40'),
  ],
  电气保护: [
    P('E01', '输入过压保护值', '264', 242, 280, 'V'),
    P('E02', '输入欠压保护值', '176', 160, 198, 'V'),
    P('E03', '母线过压保护值', '420', 380, 450, 'V'),
    P('E04', '整机过流保护值', '28.0', 20, 32, 'A'),
    P('E05', 'IPM 模块过温保护', '95', 80, 105, '°C'),
    P('E06', '缺相保护使能', '1', 0, 1, '—', '0 / 1'),
  ],
  水系统: [
    P('W01', '制冷出水温度设定', '7.0', 5, 15, '°C'),
    P('W02', '制热出水温度设定', '40', 30, 55, '°C'),
    P('W03', '出水温度上限', '48', 40, 60, '°C'),
    P('W04', '水流开关延时', '10', 3, 30, 's'),
    P('W05', '防冻保护温度', '4.0', 2, 8, '°C'),
    P('W06', '水泵后运行时间', '60', 0, 300, 's'),
  ],
  风机参数: [
    P('F01', '外风机最高档位', '10', 5, 10, '档'),
    P('F02', '外风机最低档位', '2', 1, 5, '档'),
    P('F03', '夜间静音最高档位', '6', 3, 10, '档'),
    P('F04', '风机启动延时', '5', 0, 30, 's'),
  ],
  除霜参数: [
    P('D01', '进入除霜翅片温度', '-3', -10, 0, '°C'),
    P('D02', '除霜间隔时间', '60', 20, 120, 'min'),
    P('D03', '最长除霜时间', '10', 5, 20, 'min'),
    P('D04', '退出除霜翅片温度', '12', 5, 20, '°C'),
  ],
}
export const paramLog = [
  { text: 'C08 目标吸气过热度 4.0 → 5.0', who: '张建国', at: '06-15 10:24', result: '下发成功', ok: true },
  { text: 'W03 出水温度上限 50 → 48', who: '李工', at: '06-10 16:02', result: '下发成功', ok: true },
  { text: 'C01 最高运行频率 110 → 125', who: '李工', at: '06-10 15:58', result: '超出范围被拒绝', ok: false },
  { text: 'D02 除霜间隔时间 45 → 60', who: '张建国', at: '05-28 09:41', result: '下发成功', ok: true },
]

// ---------------------------------------------------------------- 连接状态
export interface Conn { name: string; type: string; bus: string; proto: string; state: '在线' | '离线' | '通讯异常'; loss: number; last: string }
const ON = (name: string, type: string, bus: string, last: string, loss = 0, proto = 'Modbus-RTU'): Conn => ({ name, type, bus, proto, state: '在线', loss, last })
export const connections: Conn[] = [
  { name: '地下影音室传感器 AQ-08', type: '空气传感器', bus: 'RS485-1 / 0x28', proto: 'Modbus-RTU', state: '离线', loss: 100, last: '13:05:22' },
  { name: '除湿机 DH-01', type: '新风除湿', bus: 'RS485-2 / 0x34', proto: 'Modbus-RTU', state: '离线', loss: 100, last: '14:22:10' },
  { name: '水泵控制回路 EM-S04', type: '单相电表', bus: 'RS485-2 / 0x0E', proto: 'DL/T645', state: '通讯异常', loss: 14.2, last: '15:41:30' },
  ON('热泵主机 HP-01', '空调主机', 'RS485-2 / 0x01', '15:42:06'),
  ON('新风机 FA-01', '新风除湿', 'RS485-2 / 0x31', '15:42:05', 0.4),
  ON('客厅温控面板 TP-01', '温控面板', 'RS485-1 / 0x11', '15:42:07'),
  ON('客厅空气传感器 AQ-01', '空气传感器', 'RS485-1 / 0x21', '15:42:07', 0.2),
  ON('热泵主机 HP-02', '空调主机', 'RS485-2 / 0x02', '15:42:06'),
  ON('新风机 FA-02', '新风除湿', 'RS485-2 / 0x32', '15:42:05', 0.3),
  ON('新风机 FA-03', '新风除湿', 'RS485-2 / 0x33', '15:42:04', 0.6),
  ON('主卧温控面板 TP-02', '温控面板', 'RS485-1 / 0x12', '15:42:07'),
  ON('次卧温控面板 TP-03', '温控面板', 'RS485-1 / 0x13', '15:42:07'),
  ON('书房温控面板 TP-04', '温控面板', 'RS485-1 / 0x14', '15:42:06'),
  ON('老人房温控面板 TP-05', '温控面板', 'RS485-1 / 0x15', '15:42:06'),
  ON('客卧温控面板 TP-06', '温控面板', 'RS485-1 / 0x16', '15:42:06'),
  ON('主卧空气传感器 AQ-02', '空气传感器', 'RS485-1 / 0x22', '15:42:07'),
  ON('次卧空气传感器 AQ-03', '空气传感器', 'RS485-1 / 0x23', '15:42:07', 0.1),
  ON('书房空气传感器 AQ-04', '空气传感器', 'RS485-1 / 0x24', '15:42:07'),
  ON('儿童房空气传感器 AQ-05', '空气传感器', 'RS485-1 / 0x25', '15:42:06'),
  ON('餐厅空气传感器 AQ-06', '空气传感器', 'RS485-1 / 0x26', '15:42:06'),
  ON('老人房空气传感器 AQ-07', '空气传感器', 'RS485-1 / 0x27', '15:42:06'),
  ON('热泵主机总回路 EM-T01', '三相电表', 'RS485-2 / 0x0A', '15:42:00', 0, 'DL/T645'),
  ON('电梯动力回路 EM-T02', '三相电表', 'RS485-2 / 0x0B', '15:42:00', 0, 'DL/T645'),
  ON('照明插座回路 EM-S01', '单相电表', 'RS485-2 / 0x0C', '15:42:00', 0, 'DL/T645'),
  ON('新风除湿回路 EM-S02', '单相电表', 'RS485-2 / 0x0D', '15:42:00', 0, 'DL/T645'),
  ON('厨房电器回路 EM-S03', '单相电表', 'RS485-2 / 0x0F', '15:42:00', 0, 'DL/T645'),
  ON('循环水泵 WP-01', '水系统', 'LAN / 192.168.1.31', '15:42:07', 0, 'Modbus-TCP'),
  ON('混水中心 MX-01', '水系统', 'LAN / 192.168.1.32', '15:42:07', 0, 'Modbus-TCP'),
  ...Array.from({ length: 6 }, (_, i) => ON(`分集水器阀门 VL-0${i + 1}`, '水系统', `LAN / 192.168.1.${40 + i}`, '15:42:06', 0, 'Modbus-TCP')),
  ...Array.from({ length: 11 }, (_, i) => ON(`门窗传感 DW-${String(i + 1).padStart(2, '0')}`, '门窗传感', `Zigbee / 0x${(0x6a10 + i).toString(16).toUpperCase()}`, '15:41:5' + (i % 10), i % 4 === 0 ? 0.8 : 0, 'Zigbee')),
  { name: '门窗传感 DW-12', type: '门窗传感', bus: 'Zigbee / 0x6A1B', proto: 'Zigbee', state: '离线', loss: 100, last: '11:18:40' },
]
// = 46 devices: 42 online, 3 offline, 1 abnormal
export const connHourly = Array.from({ length: 24 }, (_, h) => ({
  hour: `${String(h).padStart(2, '0')}:00`,
  online: h < 13 ? (h === 3 ? 45 : 46) : 42,
  rate: h < 13 ? [99.6, 99.4, 99.4, 98.6, 99.5, 99.4, 99.6, 99.5, 99.4, 99.6, 99.5, 99.4, 99.5][h] : [98.2, 98.0, 98.1, 98.2, 98.0, 98.1, 98.3, 98.0, 98.0, 98.3, 98.1][h - 13],
}))

// ---------------------------------------------------------------- 报警
export type AlarmLevel = '紧急' | '重要' | '一般' | '提示'
export type AlarmStatus = '未处理' | '已确认' | '已恢复'
export interface Alarm { id: string; level: AlarmLevel; time: string; device: string; deviceType: string; type: string; desc: string; status: AlarmStatus; current?: string; threshold?: string; tips?: string[] }
const today: Alarm[] = [
  { id: 'ALM-20250618-0091', level: '紧急', time: '06-18 15:21:40', device: '热泵主机 HP-01', deviceType: '空调主机', type: '设备故障', desc: '排气温度过高 (E07)', status: '未处理', current: '108.4°C', threshold: '105.0°C', tips: ['检查系统冷媒是否泄漏或不足', '检查电子膨胀阀开度是否异常', '确认室外机散热环境是否良好'] },
  { id: 'ALM-20250618-0088', level: '重要', time: '06-18 14:22:10', device: '除湿机 DH-01', deviceType: '新风除湿', type: '通讯故障', desc: '设备离线超过 60 分钟', status: '未处理', current: '离线 80 min', threshold: '60 min', tips: ['检查 RS485-2 总线接线与终端电阻', '确认设备供电是否正常', '在「设备连接状态」中尝试重连'] },
  { id: 'ALM-20250618-0086', level: '重要', time: '06-18 13:48:02', device: '客厅温控 TP-01', deviceType: '温控面板', type: '结露风险', desc: '顶辐射供水温度低于露点 +1°C', status: '未处理', current: '15.6°C', threshold: '15.9°C', tips: ['提高顶辐射供水温度设定', '加强新风除湿，降低室内露点', '检查门窗是否长时间开启'] },
  { id: 'ALM-20250618-0083', level: '一般', time: '06-18 13:05:22', device: '传感器 AQ-08', deviceType: '空气传感器', type: '通讯故障', desc: '传感器离线', status: '未处理', current: '离线', threshold: '—', tips: ['检查传感器供电', '检查 RS485-1 总线接线'] },
  { id: 'ALM-20250618-0079', level: '一般', time: '06-18 11:30:45', device: '新风机 FA-03', deviceType: '新风除湿', type: '维护提醒', desc: '滤网寿命低于 10%', status: '未处理', current: '8%', threshold: '10%', tips: ['安排更换 F7 中效滤网', '更换后在设备端复位滤网计时'] },
  { id: 'ALM-20250618-0071', level: '重要', time: '06-18 07:12:08', device: '传感器 AQ-02', deviceType: '空气传感器', type: '环境超限', desc: '主卧 CO₂ 浓度 1,126 ppm', status: '已确认', current: '1,126 ppm', threshold: '1,000 ppm', tips: ['提高主卧新风量', '检查新风机 FA-02 运行档位'] },
  { id: 'ALM-20250618-0065', level: '一般', time: '06-18 03:20:51', device: '网关 GW-10241', deviceType: '网关', type: '网络波动', desc: '4G 信号弱，重连 2 次', status: '已恢复', current: '-96 dBm', threshold: '-95 dBm', tips: ['检查网关天线安装位置'] },
  { id: 'ALM-20250618-0060', level: '一般', time: '06-18 01:42:16', device: '混水中心 MX-01', deviceType: '水系统', type: '设备故障', desc: '混水阀开度反馈偏差 > 5%', status: '已恢复', current: '6.2%', threshold: '5%', tips: ['校准混水阀执行器'] },
  { id: 'ALM-20250618-0058', level: '提示', time: '06-18 00:00:05', device: '系统', deviceType: '系统', type: '计划任务', desc: '夜间节能模式已自动启用', status: '已恢复', current: '—', threshold: '—', tips: ['无需处理'] },
]
const older: Alarm[] = []
const seedTypes: [AlarmLevel, string, string, string, string][] = [
  ['一般', '新风机 FA-02', '新风除湿', '维护提醒', '滤网寿命低于 50%'],
  ['提示', '系统', '系统', '计划任务', '夜间节能模式已自动启用'],
  ['重要', '传感器 AQ-02', '空气传感器', '环境超限', '主卧 CO₂ 浓度超过 1,000 ppm'],
  ['一般', '客厅温控 TP-01', '温控面板', '结露风险', '室内露点接近供水温度'],
  ['一般', '网关 GW-10241', '网关', '通讯故障', '网关心跳超时'],
  ['紧急', '热泵主机 HP-01', '空调主机', '设备故障', '低压压力过低 (E03)'],
  ['重要', '水泵控制回路 EM-S04', '单相电表', '通讯故障', '丢包率超过 10%'],
  ['一般', '传感器 AQ-06', '空气传感器', '环境超限', '餐厅 PM2.5 偏高'],
]
let k = 0
for (const [day, n] of [['06-17', 5], ['06-16', 6], ['06-15', 2], ['06-14', 5], ['06-13', 6], ['06-12', 3]] as [string, number][]) {
  for (let i = 0; i < n; i++, k++) {
    const t = seedTypes[k % seedTypes.length]
    const hh = String(22 - i * 3).padStart(2, '0')
    older.push({ id: `ALM-2025${day.replace('-', '')}-${String(40 - i).padStart(4, '0')}`, level: t[0], time: `${day} ${hh}:${String((k * 17) % 60).padStart(2, '0')}:${String((k * 29) % 60).padStart(2, '0')}`, device: t[1], deviceType: t[2], type: t[3], desc: t[4], status: '已恢复', current: '—', threshold: '—', tips: ['已自动恢复，无需处理'] })
  }
}
// 9 today + 27 earlier = 36 in last 7 days
export const alarms: Alarm[] = [...today, ...older]
export const alarmTrend = {
  days: ['06-12', '06-13', '06-14', '06-15', '06-16', '06-17', '06-18'],
  紧急: [0, 1, 0, 0, 0, 1, 1],
  重要: [1, 2, 1, 0, 2, 1, 3],
  一般: [3, 2, 4, 1, 3, 2, 4],
  提示: [1, 1, 1, 1, 1, 1, 1],
}
export const alarmTypes = [
  { name: '通讯故障', value: 11 },
  { name: '其他', value: 2 },
  { name: '维护提醒', value: 5 },
  { name: '结露风险', value: 5 },
  { name: '设备故障', value: 5 },
  { name: '环境超限', value: 8 },
]
// 报警中心 badge = unprocessed alarms across all projects
export const unprocessedAllProjects = 12

// ---------------------------------------------------------------- 统一控制 last run
export const lastRun = {
  id: 'CMD-20250618-0315', at: '15:30:06', by: '张建国', summary: '开启 / 制冷 / 全部房间开启 / 26.0°C',
  rows: [
    { name: '朝阳壹号院 A栋', id: 'PRJ-10241', ok: 24, total: 24, status: '成功', note: '—' },
    { name: '朝阳壹号院 B栋', id: 'PRJ-10242', ok: 22, total: 22, status: '成功', note: '—' },
    { name: '朝阳壹号院 C栋', id: 'PRJ-10243', ok: 17, total: 25, status: '执行中', note: '等待温控面板应答' },
    { name: '朝阳壹号院 会所', id: 'PRJ-10245', ok: 20, total: 25, status: '部分失败', note: '5 台设备通讯超时' },
    { name: '朝阳壹号院 E栋', id: 'PRJ-10246', ok: 23, total: 23, status: '成功', note: '—' },
  ],
}

// ---------------------------------------------------------------- 天气
export const weather = {
  city: '上海市 · 浦东新区', temp: 28, text: '多云转晴', feels: 31, high: 32, low: 24,
  humidity: 68, wind: '东南风', windLevel: '3级', dew: 21.6, pressure: 1008, visibility: 16, uv: '中等',
  aqi: 42, aqiText: '优', pm25: 18, sunrise: '04:50', sunset: '19:01', rain: 20, rainNote: '夜间有小阵雨可能',
  week: [
    { d: '今天', icon: 'cloudsun', text: '多云', lo: 24, hi: 32 },
    { d: '周四', icon: 'sun', text: '晴', lo: 25, hi: 34 },
    { d: '周五', icon: 'rain', text: '中雨', lo: 23, hi: 28 },
    { d: '周六', icon: 'rain', text: '小雨', lo: 23, hi: 29 },
    { d: '周日', icon: 'cloud', text: '阴', lo: 24, hi: 30 },
    { d: '周一', icon: 'cloudsun', text: '多云', lo: 25, hi: 33 },
    { d: '周二', icon: 'sun', text: '晴', lo: 26, hi: 35 },
  ],
  hours: ['15时', '16时', '17时', '18时', '19时', '20时', '21时', '22时', '23时', '00时', '01时', '02时', '03时', '04时', '05时', '06时', '07时', '08时', '09时', '10时', '11时', '12时', '13时', '14时'],
  hourTemp: [31.2, 32, 31, 30, 29, 28, 27.2, 26.4, 26, 25.6, 25.2, 25, 24.6, 24.8, 25, 25.5, 26.5, 27.6, 28.6, 29.4, 30, 30.6, 31, 31.6, 31.4],
  hourHum: [64, 62, 63, 65, 67, 70, 73, 76, 79, 81, 82, 83, 83, 83, 82, 80, 76, 72, 68, 65, 63, 62, 61, 61, 62],
  hourIcons: [['cloudsun', '15时'], ['sun', '17时'], ['cloud', '19时'], ['moon', '21时'], ['rain', '23时'], ['rain', '01时'], ['moon', '03时'], ['cloud', '05时'], ['cloudsun', '07时'], ['sun', '09时'], ['sun', '11时'], ['sun', '13时']],
}

// ---------------------------------------------------------------- 空气传感器
export interface Sensor { id: string; room: string; floor: string; online: boolean; temp: number; hum: number; dew: number; pm25: number; co2: number; tag: '良好' | 'CO₂ 超标' | 'PM2.5 偏高' | '离线'; last?: string }
export const sensors: Sensor[] = [
  { id: 'AQ-01', room: '客厅', floor: '1F', online: true, temp: 25.8, hum: 51, dew: 14.9, pm25: 11, co2: 612, tag: '良好' },
  { id: 'AQ-02', room: '主卧', floor: '2F', online: true, temp: 26.2, hum: 55, dew: 16.5, pm25: 9, co2: 1126, tag: 'CO₂ 超标' },
  { id: 'AQ-03', room: '次卧', floor: '2F', online: true, temp: 25.4, hum: 50, dew: 14.3, pm25: 8, co2: 586, tag: '良好' },
  { id: 'AQ-04', room: '书房', floor: '2F', online: true, temp: 24.9, hum: 49, dew: 13.6, pm25: 14, co2: 702, tag: '良好' },
  { id: 'AQ-05', room: '儿童房', floor: '3F', online: true, temp: 25.9, hum: 53, dew: 15.7, pm25: 7, co2: 648, tag: '良好' },
  { id: 'AQ-06', room: '餐厅', floor: '1F', online: true, temp: 26.8, hum: 58, dew: 17.2, pm25: 23, co2: 734, tag: 'PM2.5 偏高' },
  { id: 'AQ-07', room: '老人房', floor: '1F', online: true, temp: 26.0, hum: 52, dew: 15.5, pm25: 10, co2: 566, tag: '良好' },
  { id: 'AQ-08', room: '地下影音室', floor: 'B1', online: false, temp: 0, hum: 0, dew: 0, pm25: 0, co2: 0, tag: '离线', last: '13:05' },
]
