import { useEffect, useMemo, useState } from 'react'
import {
  faSnowflake, faFan, faWater, faFaucet, faMagnifyingGlass, faGears, faArrowsRotate, faFire, faTemperatureArrowUp, faSliders,
  faTemperatureHalf, faGaugeHigh, faBolt, faGear,
} from '@fortawesome/free-solid-svg-icons'
import { Card, Chart, Icon, axis, tooltip, useAsync, useInterval } from '../components/ui'
import { useApp } from '../app/store'
import * as api from '../api'
import type { DeviceNode } from '../api'

const TREE_ICON = { snow: faSnowflake, fan: faFan, fanoff: faFan, water: faWater, faucet: faFaucet }
const stColor = (s: DeviceNode['status']) => (s === '制冷运行' || s === '运行' ? 'var(--green)' : s === '告警' ? '#ea580c' : 'var(--faint)')

function gauge(value: number, max: number, color: string, unit: string, ticks: number[]) {
  return {
    series: [
      {
        type: 'gauge' as const, min: 0, max, startAngle: 200, endAngle: -20, radius: '92%', center: ['50%', '62%'],
        axisLine: { lineStyle: { width: 13, color: [[0.82, '#1e3352'], [1, '#5b2a42']] } },
        progress: { show: true, width: 13, roundCap: false, itemStyle: { color: { type: 'linear' as const, x: 0, y: 0, x2: 1, y2: 0, colorStops: [{ offset: 0, color }, { offset: 1, color }] } } },
        pointer: { show: false }, axisTick: { show: false }, splitLine: { show: false },
        axisLabel: { show: true, distance: -42, color: '#94a3b8', fontSize: 10, fontFamily: 'Barlow', formatter: (v: number) => (ticks.includes(Math.round(v)) ? String(Math.round(v)) : '') },
        splitNumber: 20,
        anchor: { show: false }, title: { show: false },
        detail: { valueAnimation: true, offsetCenter: [0, '-2%'], color: '#fff', fontSize: 30, fontWeight: 500, fontFamily: 'Barlow', formatter: `{value} ${unit}` },
        data: [{ value }],
      },
    ],
  }
}

export default function Realtime() {
  const { projectId, toast } = useApp()
  const [tree] = useAsync(() => api.getDeviceTree(projectId), [projectId])
  const [base] = useAsync(() => api.getHeatPump('HP-01'), [])
  const [cur, setCur] = useState('HP-01')
  const [q, setQ] = useState('')
  const [live, setLive] = useState<typeof base>()
  useEffect(() => { if (base) setLive(base) }, [base])
  const [runSec, setRunSec] = useState(6 * 3600 + 42 * 60 + 18)

  // 30 min of history at 1/30s resolution
  const [hist, setHist] = useState(() => {
    const now = Date.now(); const pts: { t: number; hz: number; a: number }[] = []
    for (let i = 60; i >= 0; i--) {
      const k = 60 - i
      const hz = k < 40 ? 52 + Math.min(6, k * 0.35) - (k > 28 ? (k - 28) * 0.45 : 0) : 49 + (k - 40) * 0.25
      pts.push({ t: now - i * 30000, hz: +Math.min(59, hz).toFixed(1), a: +(12.6 + (hz - 52) * 0.2 + Math.sin(k / 3) * 0.15).toFixed(2) })
    }
    return pts
  })

  useInterval(() => {
    setRunSec((s) => s + 2)
    setLive((l) => l && {
      ...l,
      hz: Math.round(api.walk(l.hz, 1, 52, 62, 0)),
      fanRpm: Math.round(api.walk(l.fanRpm, 10, 680, 760, 0)),
      pumpRpm: Math.round(api.walk(l.pumpRpm, 20, 2580, 2720, 0)),
      temps: { ...l.temps, 出水温度: api.walk(l.temps.出水温度, 0.1, 6.6, 7.8), 回水温度: api.walk(l.temps.回水温度, 0.1, 11.5, 12.6), 排气温度: api.walk(l.temps.排气温度, 0.4, 84, 89) },
      press: { ...l.press, 高压压力: api.walk(l.press.高压压力, 0.02, 2.78, 2.94, 2), 低压压力: api.walk(l.press.低压压力, 0.01, 0.88, 0.96, 2) },
      elec: { ...l.elec, 输入电流: api.walk(l.elec.输入电流, 0.15, 15.8, 17.6), 输入功率: api.walk(l.elec.输入功率, 0.03, 3.55, 3.9, 2), 实时COP: api.walk(l.elec.实时COP, 0.02, 3.5, 3.8, 2) },
    })
  }, 2000)
  useEffect(() => {
    if (!live) return
    setHist((h) => (Date.now() - h[h.length - 1].t > 25000 ? [...h.slice(1), { t: Date.now(), hz: live.hz, a: +(12.6 + (live.hz - 52) * 0.2).toFixed(2) }] : h.map((p, i) => (i === h.length - 1 ? { ...p, hz: live.hz, a: +(12.6 + (live.hz - 52) * 0.2).toFixed(2) } : p))))
  }, [live])

  const lineOpt = useMemo(() => {
    const fmtT = (t: number) => new Date(t).toTimeString().slice(0, 5)
    return {
      tooltip,
      grid: { left: 46, right: 44, top: 20, bottom: 26 },
      xAxis: { type: 'category' as const, boundaryGap: false, data: hist.map((p) => fmtT(p.t)), axisLabel: { ...axis.label, interval: 9 }, axisLine: axis.line, axisTick: { show: false } },
      yAxis: [
        { type: 'value' as const, min: 0, max: 80, interval: 20, axisLabel: { ...axis.label, formatter: '{value} Hz' }, splitLine: { show: false } },
        { type: 'value' as const, min: 0, max: 20, interval: 5, axisLabel: { ...axis.label, formatter: '{value} A' }, splitLine: { show: false } },
      ],
      series: [
        { name: '频率 Hz', type: 'line' as const, step: 'middle' as const, data: hist.map((p) => p.hz), showSymbol: false, lineStyle: { color: '#06b6d4', width: 2.4 }, itemStyle: { color: '#06b6d4' }, areaStyle: { color: 'rgba(6,182,212,.07)' } },
        { name: '电流 A', type: 'line' as const, yAxisIndex: 1, smooth: true, data: hist.map((p) => p.a), showSymbol: false, lineStyle: { color: '#f59e0b', width: 1.8 }, itemStyle: { color: '#f59e0b' } },
      ],
    }
  }, [hist])

  if (!tree || !live) return <div className="page" />
  const dev = tree.find((d) => d.id === cur)!
  const isHP = cur.startsWith('HP')
  const running = dev.status === '制冷运行' || dev.status === '运行'
  const groups = ['空调主机', '新风系统', '水系统'] as const
  const hh = (s: number) => `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
  const v = isHP && running ? live : { ...live, hz: 0, fanRpm: 0, pumpRpm: 0 }

  const tiles: [typeof faGears, string, string, 'on' | 'off' | 'info'][] = [
    [faGears, '压缩机', running ? '运行' : '停止', running ? 'on' : 'off'], [faFan, '外风机', running ? '运行' : '停止', running ? 'on' : 'off'], [faWater, '循环水泵', running ? '运行' : '停止', running ? 'on' : 'off'],
    [faArrowsRotate, '四通阀', '断开', 'off'], [faFire, '电辅热', '关闭', 'off'], [faTemperatureArrowUp, '曲轴加热', '关闭', 'off'], [faSliders, '电子膨胀阀', `${live.run.EEV开度} 步`, 'info'],
  ]
  const unitsT: Record<string, string> = { 吸气过热度: 'K' }
  const list = (o: Record<string, number>, unit: (k: string) => string, hot?: string[]) =>
    Object.entries(o).map(([k, val]) => (
      <div className="pr" key={k}><span>{k.replace('实时COP', '实时 COP').replace('EEV开度', 'EEV 开度')}</span><b className={'num ' + (hot?.includes(k) ? 'orange' : '')}>{k === 'EEV开度' ? `${val} / 480` : `${val >= 1000 ? val.toLocaleString() : val} ${unit(k)}`}</b></div>
    ))

  return (
    <div className="page">
      <div className="rt">
        <Card className="tree" pad={false}>
          <div className="search" style={{ width: '100%' }}><Icon icon={faMagnifyingGlass} /><input placeholder="搜索设备" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          {groups.map((g) => {
            const items = tree.filter((d) => d.group === g && d.name.toLowerCase().includes(q.toLowerCase()))
            if (!items.length) return null
            return (
              <div key={g}>
                <div className="tg">{g}</div>
                {items.map((d) => (
                  <div key={d.id} className={'tree-item' + (d.id === cur ? ' on' : '')} onClick={() => setCur(d.id)}>
                    <div className="ti"><Icon icon={TREE_ICON[d.icon]} /></div>
                    <div><b className="num">{d.name}</b><small style={{ color: stColor(d.status) }}><span className="dot" style={{ width: 8, height: 8 }} />{d.status}</small></div>
                  </div>
                ))}
              </div>
            )
          })}
        </Card>

        <div>
          <Card className="dev-head" pad={false}>
            <div className="big-ico"><Icon icon={TREE_ICON[dev.icon]} /></div>
            <div>
              <h2 className="num">{dev.name} <span className={'pill ' + (running ? 'green' : dev.status === '告警' ? 'orange' : 'gray')} style={{ fontSize: 11 }}><span className="dot" style={{ width: 5, height: 5 }} />{running ? '运行中' : dev.status}</span></h2>
              <div className="meta num">{isHP ? 'ASHP-16kW · SN 2403A10241001 · 固件 v2.8.4' : `${dev.id} · SN 2403A1024${dev.id.replace(/\D/g, '')}7 · 固件 v1.9.2`}</div>
            </div>
            <div className="stats">
              <div><span>开关</span><b className={running ? 'green' : 'faint'}>{running ? '开机' : '关机'}</b></div>
              <div><span>运行模式</span><b className="cyan"><Icon icon={faSnowflake} /> 制冷</b></div>
              <div><span>本次运行</span><b className="num">{running ? hh(runSec) : '--'}</b></div>
              <div><span>累计运行</span><b className="num">8,426 h</b></div>
            </div>
          </Card>

          <div className="dark-panel">
            <div className="dh"><b>核心运行参数</b><small><span className="dot" style={{ color: '#34d399' }} />LIVE · 刷新 2s</small></div>
            <div className="gauges">
              <div className="gauge"><Chart option={gauge(v.hz, 100, '#22d3ee', 'Hz', [0, 50, 100])} height={170} /><div className="gl">压缩机频率 · 目标 <b>{live.targetHz} Hz</b></div></div>
              <div className="gauge"><Chart option={gauge(v.fanRpm, 1000, '#34d399', 'rpm', [0, 500, 1000])} height={170} /><div className="gl">外风机转速 · 挡位 <b>{live.fanGear}/10</b></div></div>
              <div className="gauge"><Chart option={gauge(v.pumpRpm, 4000, '#818cf8', 'rpm', [0, 1000, 2000, 3000, 4000])} height={170} /><div className="gl">水泵转速 · 流量 <b>{live.flow} m³/h</b></div></div>
            </div>
            <div className="tiles">
              {tiles.map(([ic, n, s, k]) => <div key={n} className={'tile ' + k}><div className="tic"><Icon icon={ic} /></div><b>{n}</b>{s}</div>)}
            </div>
          </div>

          <div className="params4">
            <Card><div className="card-head" style={{ marginBottom: 8 }}><h3 className="card-title"><span className="ph-ico" style={{ background: '#fff7ed', color: '#f97316' }}><Icon icon={faTemperatureHalf} /></span>温度参数</h3></div>
              <div className="plist">{list(live.temps, () => '°C', ['排气温度'])}</div></Card>
            <Card><div className="card-head" style={{ marginBottom: 8 }}><h3 className="card-title"><span className="ph-ico" style={{ background: '#f5f3ff', color: '#8b5cf6' }}><Icon icon={faGaugeHigh} /></span>压力参数</h3></div>
              <div className="plist">{list(live.press, (k) => (k.includes('温度') ? '°C' : unitsT[k] ?? 'MPa'))}<div className="pr"><span>水流开关</span><b className="green">闭合</b></div></div></Card>
            <Card><div className="card-head" style={{ marginBottom: 8 }}><h3 className="card-title"><span className="ph-ico" style={{ background: '#fffbeb', color: '#f59e0b' }}><Icon icon={faBolt} /></span>电气参数</h3></div>
              <div className="plist">{Object.entries(live.elec).map(([k, val]) => <div className="pr" key={k}><span>{k === '实时COP' ? '实时 COP' : k}</span><b className={'num ' + (k === '实时COP' ? 'green' : '')}>{val} {({ 输入电压: 'V', 输入电流: 'A', 压缩机电流: 'A', 母线电压: 'V', 输入功率: 'kW', 制冷量: 'kW', 实时COP: '' } as Record<string, string>)[k]}</b></div>)}</div></Card>
            <Card><div className="card-head" style={{ marginBottom: 8 }}><h3 className="card-title"><span className="ph-ico" style={{ background: '#ecfeff', color: '#0891b2' }}><Icon icon={faGear} /></span>运行参数</h3></div>
              <div className="plist">{list({ ...live.run, 压缩机频率: v.hz, 外风机转速: v.fanRpm, 水泵转速: v.pumpRpm }, (k) => (k.includes('频率') ? 'Hz' : k.includes('转速') ? 'rpm' : ''))}<div className="pr"><span>故障代码</span><b className="faint" style={{ fontWeight: 400 }}>无</b></div></div></Card>
          </div>

          <Card>
            <div className="card-head"><div><h3 className="card-title">实时曲线</h3><div className="card-sub">压缩机频率与电流 · 近 30 分钟</div></div>
              <div className="legend-dots"><span><i style={{ width: 14, height: 3, background: '#06b6d4', display: 'inline-block' }} />频率 Hz</span><span><i style={{ width: 14, height: 3, background: '#f59e0b', display: 'inline-block' }} />电流 A</span></div></div>
            <Chart option={lineOpt} height={230} />
          </Card>
        </div>
      </div>
      <span style={{ display: 'none' }} onClick={() => toast('')} />
    </div>
  )
}
