// 恒境云 mock data — base device sets. Everything is anchored to one demo day (2025-06-18).
// The primary project (朝阳壹号院 A栋 · PRJ-10241) uses these arrays verbatim; other projects
// derive their data from them in ./gen.ts. Org structure (dealers / 集成项目 / projects) lives in ./org.ts.

export const DEMO_DATE = '2025-06-18'

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
  /** fresh-air unit operating mode code reported by the controller */
  mode: number
  control: 'dew' | 'hum'
  dewSet: number
  humSet: number
  /** 演示数据的风速；「自动」只在 S10c 的演示下发后出现（210 的 wind_speed = 2） */
  fan: '低' | '中' | '高' | '自动'
  rpm: number
  airflow: number
  compressor: boolean
  hz: number
}

export const freshAirUnits: FreshAir[] = [
  { id: 'FA-01', mode: 2, name: '新风机 FA-01', floor: '1F', status: 'run', on: true, supplyTemp: 18.6, supplyHum: 62, supplyDew: 11.2, returnTemp: 25.4, returnHum: 52, freshTemp: 31.2, freshHum: 68, filter: 72, filterHours: 1260, filterDays: 58, control: 'dew', dewSet: 12.0, humSet: 50, fan: '中', rpm: 1350, airflow: 350, compressor: true, hz: 48 },
  { id: 'FA-02', mode: 23, name: '新风机 FA-02', floor: '2F', status: 'run', on: true, supplyTemp: 19.1, supplyHum: 58, supplyDew: 10.7, returnTemp: 25.9, returnHum: 54, freshTemp: 31.2, freshHum: 68, filter: 45, filterHours: 2480, filterDays: 36, control: 'hum', dewSet: 12.0, humSet: 55, fan: '低', rpm: 980, airflow: 260, compressor: true, hz: 42 },
  { id: 'FA-03', mode: 6, name: '新风机 FA-03', floor: '3F', status: 'filter', on: true, supplyTemp: 18.9, supplyHum: 64, supplyDew: 11.9, returnTemp: 26.4, returnHum: 56, freshTemp: 31.2, freshHum: 68, filter: 8, filterHours: 4180, filterDays: 6, control: 'dew', dewSet: 12.5, humSet: 50, fan: '高', rpm: 1720, airflow: 450, compressor: true, hz: 55 },
  { id: 'DH-01', mode: 1, name: '除湿机 DH-01', floor: 'B1', status: 'off', on: false, supplyTemp: 24.8, supplyHum: 63, supplyDew: 17.3, returnTemp: 24.8, returnHum: 63, freshTemp: 31.2, freshHum: 68, filter: 86, filterHours: 620, filterDays: 72, control: 'hum', dewSet: 12.0, humSet: 50, fan: '低', rpm: 0, airflow: 0, compressor: false, hz: 0 },
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

// ---------------------------------------------------------------- 统一控制 last run
export const lastRun = {
  rows: [
    { name: '朝阳壹号院 A栋', code: 'PRJ-10241', status: 'success' as const, at: '2025-06-18 15:30:06' },
    { name: '朝阳壹号院 B栋', code: 'PRJ-10242', status: 'success' as const, at: '2025-06-18 15:30:09' },
    { name: '朝阳壹号院 C栋', code: 'PRJ-10243', status: 'unknown' as const, at: '2025-06-18 15:30:21' },
    { name: '朝阳壹号院 会所', code: 'PRJ-10245', status: 'failure' as const, at: '2025-06-18 15:30:24' },
    { name: '朝阳壹号院 E栋', code: 'PRJ-10246', status: 'success' as const, at: '2025-06-18 15:30:27' },
  ],
}

// ---------------------------------------------------------------- 空气传感器
/** pm25 / co2 are undefined when the sensor model has no such probe */
export interface Sensor { id: string; room: string; floor: string; online: boolean; temp: number; hum: number; dew: number; pm25?: number; co2?: number; tag: '良好' | 'CO₂ 超标' | 'PM2.5 偏高' | '离线'; last?: string }
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
