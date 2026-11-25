// 新风除湿机页（S10b）：ctrl 202 设备状态 + ctrl 210 运行设置（只读），数据层见 src/features/freshAir。
// 当前项目用 useCurrentProject()（docs/分工.md 第 3 节第 6 条）：没有项目、项目离线、没有权限时不发 ctrl 请求。
// 只读页面：不调用任何写接口。运行设置面板只显示当前值和每一项能不能设置，下发按钮是占位（禁用），204 下发在 S10c。
// 显示口径（docs/plan-s10-s7.md S10b、规则草稿 S10 节）：
// - 实时数据（改动 11）只放 202 有的字段；设备汇总（改动 12）：设备、开关、模式、运行时间、滤网运行时间、滤网寿命（%）；
// - 运行设置（改动 13）只在 app_code 12 显示；210 读到 -1 的项不能设置；control_type = -1 时控制类型、露点、湿度不能设置，
//   风速、开关照常；-100 / 65536 显示 --；0 是有效值；
// - 202 里未连接的设备不显示读数（不把旧值当当前值），也不读 210；
// - 滤网：filter_life 是天数，filter_life_p 是比例（显示乘 100）；告警颜色和「请尽快更换」受 features.freshAirFilterWarn 控制（默认关）。
import { useState, type ReactNode } from 'react'
import { faFan, faPaperPlane, faRotate, faFilter, faLock, faGears, faPowerOff, faBuilding, faPlugCircleXmark, faTriangleExclamation, faCircleInfo, type IconDefinition } from '@fortawesome/free-solid-svg-icons'
import { Icon } from '../components/legacy'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { getConfig } from '../api/config'
import { defaultText } from '../api/errors'
import { PLACEHOLDER } from '../api/values'
import type { Field204 } from '../api/writeLockVerify'
import { useCurrentProject, type Project } from '../data/org'
import { timeLabel } from '../data/sensors'
import {
  CONTROL_TYPES, fieldBlock, hasSettings, SWITCHES_210, useSettings, useUnits, WIND_SPEEDS_210,
  type SettingsState, type SettingsView, type UnitView,
} from '../features/freshAir'

/** 下发按钮占位的说明（S10c 接入 204 后换成真实入口） */
export const TEXT_WRITE_PENDING = '运行设置下发暂未开放，当前仅显示设备读到的设置'
/** 210 回「该软件类型不支持此控制」时面板的说明 */
export const TEXT_UNSUPPORTED_PANEL = '该项目的控制屏不支持运行设置，这不是故障。设备状态仍按上方实时数据显示。'

const num = (v: number | null, digits = 0, unit = '') => (v === null ? PLACEHOLDER : `${v.toFixed(digits)}${unit}`)
const unitName = (u: UnitView, i: number) => u.name || `新风设备 ${i + 1}`
/** 压缩机状态（A6）：0 停止、1 运行，其他显示原数字 */
const compressorText = (v: number | null) => (v === null ? PLACEHOLDER : v === 0 ? '停止' : v === 1 ? '运行' : String(v))
const statusOf = (u: UnitView): [string, 'green' | 'gray' | 'red'] => (!u.connected ? ['未连接', 'red'] : u.on === null ? ['开关未知', 'gray'] : u.on ? ['运行中', 'green'] : ['已关机', 'gray'])
const warnOn = () => getConfig().features.freshAirFilterWarn === true

function PageHead({ project, count, right }: { project: Project | null; count?: number; right?: ReactNode }) {
  return (
    <div className="page-head">
      <div><h1>新风除湿机</h1>
        {project && <div className="sub"><span><Icon icon={faBuilding} /> {project.name}</span>{count !== undefined && <><span className="sep">·</span>{count} 台新风除湿一体机</>}{hasSettings(project) && <><span className="sep">·</span>新风单机版</>}</div>}
      </div>
      {right}
    </div>
  )
}

function Placeholder({ icon, title, text, onRetry, alert }: { icon: IconDefinition; title: string; text: string; onRetry?: () => void; alert?: boolean }) {
  return (
    <Card className="placeholder" role={alert ? 'alert' : 'status'}>
      <div className="ph-ico"><Icon icon={icon} /></div>
      <h3>{title}</h3>
      <p>{text}</p>
      {onRetry && <Button style={{ marginTop: 16 }} onClick={onRetry}>重试</Button>}
    </Card>
  )
}

function Ring({ pct, color }: { pct: number | null; color: string }) {
  const r = 52, c = 2 * Math.PI * r
  return (
    <svg width="124" height="124" viewBox="0 0 132 132" aria-hidden="true">
      <circle cx="66" cy="66" r={r} stroke="#e2f5ee" strokeWidth="11" fill="none" />
      {pct !== null && <circle cx="66" cy="66" r={r} stroke={color} strokeWidth="11" fill="none" strokeLinecap="round"
        strokeDasharray={`${(c * pct) / 100} ${c}`} transform="rotate(-90 66 66)" style={{ transition: 'stroke-dasharray .6s' }} />}
      <text x="66" y="70" textAnchor="middle" fontSize="30" fontWeight="600" fontFamily="Barlow" fill="#0f172a">{pct === null ? PLACEHOLDER : `${pct}%`}</text>
      <text x="66" y="92" textAnchor="middle" fontSize="11" fill="#94a3b8">剩余</text>
    </svg>
  )
}

/** 滤网：颜色和提示只在 freshAirFilterWarn 打开时按比例给出；关着时一律中性色、只写剩余天数 */
function filterLook(u: UnitView): { color: string; bar: string | undefined; text: string; cls: string } {
  const { level, days } = u.filter
  const left = days === null ? '剩余天数暂无数据' : `剩余 ${days} 天`
  if (!warnOn() || level === null) return { color: '#10b981', bar: undefined, text: left, cls: '' }
  if (level === 'red') return { color: '#f43f5e', bar: 'var(--red)', text: `滤网寿命不足，请尽快更换（${left}）`, cls: 'red' }
  if (level === 'orange') return { color: '#f59e0b', bar: 'var(--amber)', text: `滤网已使用过半（${left}）`, cls: 'orange' }
  return { color: '#10b981', bar: undefined, text: `状态良好（${left}）`, cls: '' }
}

function LiveCard({ u, name, wide }: { u: UnitView; name: string; wide: boolean }) {
  const [st, color] = statusOf(u)
  const head = <CardHeader><CardTitle>实时数据 · <span className="num">{name}</span></CardTitle><Badge variant={color}><span className="dot" />{st}</Badge></CardHeader>
  if (!u.connected) return (
    <Card>
      {head}
      <div className="placeholder" role="status" style={{ boxShadow: 'none', border: 0 }}>
        <div className="ph-ico"><Icon icon={faPlugCircleXmark} /></div>
        <h3>设备未连接</h3>
        <p>控制屏报告这台设备未连接，暂无实时数据。</p>
      </div>
    </Card>
  )
  const f = filterLook(u)
  const tiles: [string, string, string?][] = [
    ['送风温度', num(u.supplyTemp, 1, ' °C')], ['回风温度', num(u.returnTemp, 1, ' °C')],
    ['风速档位', num(u.windLevel)], ['风机转速', num(u.fanSpeed)],
    ['压缩机状态', compressorText(u.compressorStatus), u.compressorStatus === 1 ? 'green' : u.compressorStatus === 0 ? 'faint' : undefined], ['压缩机频率', num(u.compressorFreq, 0, ' Hz')],
    ['运行时间', num(u.runningTime)], ['运行模式', u.runningMode || PLACEHOLDER],
  ]
  return (
    <Card>
      {head}
      <div className="fa-banner">
        <div className="fb-filter">
          <Ring pct={u.filter.percent} color={f.color} />
          <div style={{ flex: 1 }}>
            <b className="fb-t"><Icon icon={faFilter} />滤网寿命</b>
            <div className={'fb-s ' + f.cls} data-testid="filter-text">{f.text}</div>
            <div className="bar" style={{ height: 8, margin: '12px 0 8px' }}><i style={{ width: (u.filter.percent ?? 0) + '%', background: f.bar }} /></div>
            <small className="muted num">滤网运行时间 {num(u.filterRunning)}</small>
          </div>
        </div>
      </div>
      <div className={'fa-tiles' + (wide ? ' six' : '')}>
        {tiles.map(([l, v, c]) => <div key={l}><span>{l}</span><b className={'num ' + (c ?? '')}>{v}</b></div>)}
      </div>
    </Card>
  )
}

/** 运行设置的一项：值；不能设置时带锁和原因（Tooltip 挂在可聚焦的锁图标上） */
function SettingRow({ s, f, label, value, active }: { s: SettingsView; f: Field204; label: string; value: string; active?: boolean }) {
  const why = fieldBlock(s, f)
  return (
    <div className={'setbox' + (why ? ' dis' : active ? ' on' : '')} data-field={f}>
      <div className="sh">
        <div><b>{label}</b></div>
        {why ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span tabIndex={0} role="img" aria-label={`${label}不能设置：${why}`} className="faint" style={{ fontSize: 12 }}><Icon icon={faLock} /> 不可设置</span>
            </TooltipTrigger>
            <TooltipContent>{why}</TooltipContent>
          </Tooltip>
        ) : active ? <Badge style={{ background: 'var(--primary-2)', color: '#fff' }}>生效中</Badge> : null}
      </div>
      <div className="stepper"><span className="sv num">{value}</span></div>
    </div>
  )
}

function SettingsBody({ s }: { s: SettingsView }) {
  const fl = s.fields
  const ct = fl.controlType.value
  const ctText = ct === null ? PLACEHOLDER : CONTROL_TYPES[ct]
  return (
    <>
      <SettingRow s={s} f="switch" label="开关" value={fl.switch.value === null ? PLACEHOLDER : SWITCHES_210[fl.switch.value]} />
      <SettingRow s={s} f="controlType" label="控制类型" value={ctText} />
      {ct !== null && !s.canChange && <div className="ctl-hint"><Icon icon={faLock} />该设备的控制类型不可切换</div>}
      <SettingRow s={s} f="dewPoint" label="露点设定" value={num(fl.dewPoint.value, 1, ' °C')} active={ct === 1} />
      <SettingRow s={s} f="humiditySet" label="湿度设定" value={num(fl.humiditySet.value, 0, ' %RH')} active={ct === 0} />
      <SettingRow s={s} f="windSpeed" label="风速" value={fl.windSpeed.value === null ? PLACEHOLDER : WIND_SPEEDS_210[fl.windSpeed.value]} />
    </>
  )
}

function settingsMessage(st: SettingsState): { icon: IconDefinition; title: string; text: string; retry?: () => void; alert?: boolean } | null {
  switch (st.kind) {
    case 'no-device': return { icon: faCircleInfo, title: '无法读取运行设置', text: '这台设备没有有效的设备编号，暂时读不了运行设置。' }
    case 'device-offline': return { icon: faPlugCircleXmark, title: '设备未连接', text: '设备未连接，暂不读取运行设置。' }
    case 'forbidden': return { icon: faLock, title: '未开通运行设置', text: '当前账号没有读取运行设置的权限，请联系管理员开通。' }
    case 'loading': return { icon: faGears, title: '正在读取', text: '正在从控制屏读取运行设置…' }
    case 'unavailable': return { icon: faPlugCircleXmark, title: '控制屏未连接', text: '控制屏暂时无法连接，稍后会自动重试。', retry: st.retry }
    case 'unsupported': return { icon: faCircleInfo, title: st.message, text: TEXT_UNSUPPORTED_PANEL }
    case 'error': return { icon: faTriangleExclamation, title: '运行设置读取失败', text: st.error.message || defaultText('server'), retry: st.retry, alert: true }
    default: return null
  }
}

function SettingsPanel({ st }: { st: SettingsState }) {
  const msg = settingsMessage(st)
  return (
    <Card className="set-panel" role="region" aria-label="运行设置">
      <CardHeader style={{ marginBottom: 12 }}><CardTitle>运行设置</CardTitle>
        {st.kind === 'ready' && <span className="faint num" style={{ fontSize: 12 }}>{st.staleError ? `刷新失败，显示 ${timeLabel(st.updatedAt)} 的设置` : `${timeLabel(st.updatedAt)} 读取`}</span>}
      </CardHeader>
      {st.kind === 'ready' ? <SettingsBody s={st.settings} /> : msg && (
        <div role={msg.alert ? 'alert' : 'status'} className="ctl-hint" style={{ display: 'block' }}>
          <b style={{ display: 'block', marginBottom: 4 }}><Icon icon={msg.icon} /> {msg.title}</b>
          <span>{msg.text}</span>
          {msg.retry && <div style={{ marginTop: 10 }}><Button onClick={msg.retry}>重试</Button></div>}
        </div>
      )}
      {/* 写入口占位：S10c 接入 204 下发前一直禁用 */}
      <Button variant="primary" size="lg" block disabled aria-describedby="fa-write-pending" style={{ marginTop: 12 }}><Icon icon={faPaperPlane} />下发设置</Button>
      <div id="fa-write-pending" className="faint" style={{ fontSize: 11.5, marginTop: 8 }}>{TEXT_WRITE_PENDING}</div>
    </Card>
  )
}

export default function FreshAir() {
  const { project } = useCurrentProject()
  const view = useUnits(project)
  const [selRaw, setSel] = useState('')
  const units = view.kind === 'ready' ? view.units : []
  const idx = Math.max(0, units.findIndex((x) => x.key === selRaw))
  const u: UnitView | undefined = units[idx]
  const settings = useSettings(project, u)
  const panel = hasSettings(project)

  const updated = view.kind === 'ready' || view.kind === 'empty'
    ? <div className="muted num" style={{ fontSize: 12, marginTop: 24 }}><Icon icon={faRotate} /> {view.kind === 'ready' && view.staleError ? `刷新失败，显示 ${timeLabel(view.updatedAt)} 的数据` : `${timeLabel(view.updatedAt)} 更新`}</div>
    : null
  const head = <PageHead project={project} count={view.kind === 'ready' ? units.length : undefined} right={updated} />

  const body = (() => {
    switch (view.kind) {
      // 没有项目、项目离线时 Layout 不挂载设备页（S11），空态在 Layout；数据层照样不发请求，这里只留页头兜底
      case 'no-project': case 'offline': return <></>
      case 'forbidden': return <Placeholder icon={faLock} title="未开通新风数据" text="当前账号没有读取新风除湿机数据的权限，请联系管理员开通。" />
      case 'loading': return <Placeholder icon={faFan} title="正在读取" text="正在从控制屏读取新风除湿机数据…" />
      case 'unavailable': return <Placeholder icon={faPlugCircleXmark} title="控制屏未连接" text="控制屏暂时无法连接，稍后会自动重试。" onRetry={view.retry} />
      case 'error': return <Placeholder alert icon={faTriangleExclamation} title="新风数据加载失败" text={view.error.message || defaultText('server')} onRetry={view.retry} />
      case 'empty': return <Placeholder icon={faFan} title="暂无新风除湿机数据" text="该项目暂时没有可显示的新风除湿机。" />
      default: return null
    }
  })()
  if (body || !u) return <div className="page">{head}{body}</div>

  return (
    <div className="page">
      {head}
      {/* 设备切换：青色边框表示“当前设备”；键盘焦点另用 3px 浅青外圈（只在键盘聚焦时出现，鼠标点击不出现，见 TabsTrigger）。
          .dev-tab 的 box-shadow 是未分层规则，外圈要 ! 才能压过，并保留原阴影 */}
      <Tabs value={u.key} onValueChange={setSel}>
        <TabsList className="dev-tabs" aria-label="新风设备">
          {units.map((f, i) => {
            const [t, c] = statusOf(f)
            return (
              <TabsTrigger key={f.key} value={f.key} className={'dev-tab outline-none focus-visible:not-data-[pointer-focus]:shadow-[0_0_0_3px_rgba(6,182,212,.12),var(--shadow)]!' + (f.key === u.key ? ' on' : '')}>
                <span className="di"><Icon icon={faFan} /></span>
                <span className="block"><b className="num">{unitName(f, i)}</b><small className={c === 'gray' ? 'faint' : c}>{t}{f.connected && f.runningMode && <> · {f.runningMode}</>}</small></span>
              </TabsTrigger>
            )
          })}
        </TabsList>
        <TabsContent value={u.key}>
          <div className={'fa-top' + (panel ? '' : ' wide')}>
            <LiveCard u={u} name={unitName(u, idx)} wide={!panel} />
            {panel && <SettingsPanel st={settings} />}
          </div>

          <Card pad={false}>
            <div className="px-[22px] py-5" style={{ paddingBottom: 14 }}><CardTitle>设备汇总</CardTitle></div>
            <Table>
              <TableHeader><TableRow><TableHead>设备</TableHead><TableHead>开关</TableHead><TableHead>模式</TableHead><TableHead className="text-right">运行时间</TableHead><TableHead className="text-right">滤网运行时间</TableHead><TableHead>滤网寿命</TableHead></TableRow></TableHeader>
              <TableBody>
                {units.map((f, i) => {
                  const look = filterLook(f)
                  const live = f.connected
                  return (
                    <TableRow key={f.key} onClick={() => setSel(f.key)} style={{ cursor: 'pointer', color: live && f.on ? undefined : 'var(--muted)' }}>
                      <TableCell style={{ fontWeight: 500, color: 'var(--text)' }}>{unitName(f, i)}</TableCell>
                      <TableCell>{live ? (f.on === null ? PLACEHOLDER : <Badge variant={f.on ? 'green' : 'gray'}><Icon icon={faPowerOff} /> {f.on ? '开' : '关'}</Badge>) : <Badge variant="red">未连接</Badge>}</TableCell>
                      <TableCell>{live ? f.runningMode || PLACEHOLDER : PLACEHOLDER}</TableCell>
                      <TableCell className="num text-right">{live ? num(f.runningTime) : PLACEHOLDER}</TableCell>
                      <TableCell className="num text-right">{live ? num(f.filterRunning) : PLACEHOLDER}</TableCell>
                      <TableCell style={{ width: 170 }}>
                        {live ? (
                          <div className="row" style={{ gap: 10 }}><div className="bar"><i style={{ width: (f.filter.percent ?? 0) + '%', background: look.bar }} /></div><span className={'num ' + look.cls} style={{ width: 34, textAlign: 'right', fontSize: 12 }}>{f.filter.percent === null ? PLACEHOLDER : `${f.filter.percent}%`}</span></div>
                        ) : PLACEHOLDER}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}

