import { useState } from 'react'
import { faBolt, faLightbulb, faFan, faKitchenSet, faWater, faFileExport, faArrowDown, faArrowUp, faFire, faElevator } from '@fortawesome/free-solid-svg-icons'
import { Card, Chart, Icon, Seg, axis, fmt, tooltip, useAsync } from '../components/ui'
import { useApp } from '../app/store'
import * as api from '../api'
import type { Meter } from '../api'

const ICONS = { bulb: [faLightbulb, '#f59e0b', '#fffbeb'], fan: [faFan, '#0891b2', '#ecfeff'], kitchen: [faKitchenSet, '#f43f5e', '#fff1f2'], water: [faWater, '#0ea5e9', '#f0f9ff'], heat: [faFire, '#0891b2', '#ecfeff'], elevator: [faElevator, '#6366f1', '#eef2ff'] } as const
const COLORS = { 热泵主机: '#0891b2', 新风除湿: '#22d3ee', 照明插座: '#f59e0b', 厨房电器: '#f43f5e', 其他: '#a5b4fc', 电梯动力: '#6366f1', 水泵: '#10b981' } as Record<string, string>

function Circuit({ m }: { m: Meter }) {
  const [ic, c, bg] = ICONS[m.icon]
  const three = m.phase === '三相'
  return (
    <div className="circuit">
      <div className="ch"><div><b>{m.name}</b><small className="num">{m.id} · {m.model}</small></div><span className="k-ico" style={{ background: bg, color: c }}><Icon icon={ic} /></span></div>
      <div className="cv">
        {three ? (
          <>
            <div><span>电压 A/B/C</span><b className="num" style={{ fontSize: 15 }}>{m.voltages!.map((v) => v.toFixed(0)).join('/')}</b><small>V</small></div>
            <div><span>电流 A/B/C</span><b className="num" style={{ fontSize: 15 }}>{m.currents!.map((v) => v.toFixed(1)).join('/')}</b><small>A</small></div>
            <div><span>功率</span><b className="num">{m.power.toFixed(2)}</b><small>kW</small></div>
          </>
        ) : (
          <>
            <div><span>电压</span><b className="num">{m.voltage.toFixed(1)}</b><small>V</small></div>
            <div><span>电流</span><b className="num">{m.current.toFixed(2)}</b><small>A</small></div>
            <div><span>功率</span><b className="num">{m.power.toFixed(2)}</b><small>kW</small></div>
          </>
        )}
      </div>
      <div className="cf"><span>今日电量</span><b className="num">{m.today} kWh</b></div>
    </div>
  )
}

export default function Meters() {
  const { projectId, project, toast } = useApp()
  const [meters] = useAsync(() => api.getMeters(projectId), [projectId])
  const [phase, setPhase] = useState<'单相电表' | '三相电表'>('单相电表')
  const [range, setRange] = useState<'日' | '月' | '年'>('日')
  const [usage] = useAsync(() => api.getUsage(projectId, range), [projectId, range])
  if (!meters || !usage) return <div className="page" />
  const single = meters.filter((m) => m.phase === '单相'), three = meters.filter((m) => m.phase === '三相')
  const today = usage.share.reduce((s, x) => s + x.value, 0)
  const power = meters.reduce((s, m) => s + m.power, 0)
  const names = ['其他', '厨房电器', '照明插座', '新风除湿', '热泵主机'] as const
  const scale = range === '日' ? 1 : range === '月' ? 30 : 365

  const bar = {
    tooltip: { ...tooltip, axisPointer: { type: 'shadow' as const } },
    legend: { top: 0, left: 50, itemWidth: 11, itemHeight: 11, itemGap: 22, textStyle: { color: '#475569', fontSize: 11 }, data: [...names] },
    grid: { left: 42, right: 12, top: 44, bottom: 26 },
    xAxis: { type: 'category' as const, data: range === '日' ? usage.days : range === '月' ? ['1月', '2月', '3月', '4月', '5月', '6月'] : ['2021', '2022', '2023', '2024', '2025'], axisLabel: axis.label, axisLine: { lineStyle: { color: '#94a3b8' } }, axisTick: { show: false } },
    yAxis: { type: 'value' as const, max: range === '日' ? 220 : undefined, interval: range === '日' ? 50 : undefined, axisLabel: { ...axis.label, formatter: (v: number) => (range === '日' && v > 200 ? '' : String(v)) }, splitLine: { show: false }, axisLine: { show: true, lineStyle: { color: '#94a3b8' } } },
    series: [...names].reverse().map((n) => ({
      name: n, type: 'bar' as const, stack: 'a', barWidth: '62%', itemStyle: { color: COLORS[n] },
      data: range === '日' ? usage.series[n] : (range === '月' ? [0.92, 0.85, 0.8, 0.9, 1.05, 1.1] : [0.8, 0.88, 0.95, 1.0, 0.5]).map((k) => Math.round(usage.series[n].reduce((a, b) => a + b, 0) / 18 * scale / (range === '年' ? 1 : 1) * k)),
    })),
  }
  const pie = {
    tooltip: { trigger: 'item' as const },
    legend: { bottom: 0, left: 'center', itemWidth: 10, itemHeight: 10, itemGap: 18, textStyle: { color: '#475569', fontSize: 11 }, data: ['热泵主机', '电梯动力', '照明插座', '新风除湿', '厨房电器', '水泵'] },
    title: { text: `${today.toFixed(1)}\nkWh`, left: 'center', top: '35%', textStyle: { fontSize: 17, fontWeight: 700, lineHeight: 24, fontFamily: 'Barlow', color: '#0f172a' } },
    series: [{
      type: 'pie' as const, radius: ['46%', '84%'], center: ['50%', '42%'], startAngle: 90, clockwise: true,
      itemStyle: { borderColor: '#fff', borderWidth: 2 },
      label: { position: 'inside' as const, formatter: (p: { percent: number }) => `${p.percent >= 10 ? p.percent.toFixed(1).replace(/\.0$/, '') : p.percent.toFixed(2)}%`, color: '#fff', fontSize: 10, fontWeight: 600 },
      data: ['热泵主机', '水泵', '厨房电器', '新风除湿', '照明插座', '电梯动力'].map((n) => usage.share.find((x) => x.name === n)!).map((s) => ({ ...s, itemStyle: { color: COLORS[s.name] } })),
    }],
  }

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>电表数据</h1><div className="sub">{project.name}<span className="sep">·</span>单相电表 {single.length} 块<span className="sep">·</span>三相电表 {three.length} 块</div></div>
        <button className="btn" onClick={() => toast('报表已生成：电表数据_2025-06-18.xlsx')}><Icon icon={faFileExport} className="faint" />导出报表</button>
      </div>
      <div className="grid g4" style={{ marginBottom: 20 }}>
        <Card className="kpi hero"><div className="k-label" style={{ justifyContent: 'flex-start', gap: 6 }}><Icon icon={faBolt} />今日用电</div><div className="k-val">{today.toFixed(1)}<small>kWh</small></div><div className="k-foot"><Icon icon={faArrowDown} /> 较昨日 -6.2%</div></Card>
        <Card className="kpi"><div className="k-label">本月用电</div><div className="k-val">3,248<small>kWh</small></div><div className="k-foot red"><Icon icon={faArrowUp} /> 同比 +3.8%</div></Card>
        <Card className="kpi"><div className="k-label">实时总功率</div><div className="k-val">{power.toFixed(2)}<small>kW</small></div><div className="k-foot">峰值 18.6 kW @ 14:10</div></Card>
        <Card className="kpi"><div className="k-label">电表在线</div><div className="k-val green">{meters.length}<small style={{ color: 'var(--green)' }}>/ {meters.length}</small></div><div className="k-foot">采集周期 60s</div></Card>
      </div>
      <Card style={{ marginBottom: 20 }}>
        <div className="card-head"><h3 className="card-title" style={{ marginTop: 6 }}>实时电参量</h3><Seg value={phase} options={['单相电表', '三相电表']} onChange={setPhase} counts={{ 单相电表: single.length, 三相电表: three.length }} /></div>
        <div className="grid g2">{(phase === '单相电表' ? single : three).map((m) => <Circuit key={m.id} m={m} />)}</div>
      </Card>
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0,1fr) 312px', gap: 20, marginBottom: 20 }}>
        <Card>
          <div className="card-head"><div><h3 className="card-title">用电量统计</h3><div className="card-sub">按回路分类堆叠 · kWh</div></div><Seg value={range} options={['日', '月', '年']} onChange={setRange} /></div>
          <Chart option={bar} height={330} />
        </Card>
        <Card>
          <h3 className="card-title">今日用电占比</h3><div className="card-sub">共 {today.toFixed(1)} kWh</div>
          <Chart option={pie} height={330} />
        </Card>
      </div>
      <Card pad={false}>
        <div className="card-pad" style={{ paddingBottom: 14 }}><h3 className="card-title">电表读数明细</h3></div>
        <table className="table">
          <thead><tr><th>电表</th><th>类型</th><th>通讯地址</th><th className="r">总电能 (kWh)</th><th className="r">今日 (kWh)</th><th className="r">本月 (kWh)</th><th>状态</th><th>更新时间</th></tr></thead>
          <tbody>
            {meters.map((m) => (
              <tr key={m.id}>
                <td style={{ fontWeight: 500 }}>{m.name}</td>
                <td><span className={'pill ' + (m.phase === '三相' ? 'purple' : 'cyan')}>{m.phase}</span></td>
                <td className="num">{m.addr}</td>
                <td className="r num">{fmt(m.total)}</td><td className="r num">{m.today}</td><td className="r num">{fmt(m.month)}</td>
                <td><span className="green row" style={{ gap: 5, fontSize: 12.5 }}><span className="dot" style={{ width: 8, height: 8 }} />正常</span></td>
                <td className="num">15:42:00</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  )
}
