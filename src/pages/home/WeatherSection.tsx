// 首页天气（S7b，改动 1、2）：实时 + 7 天（/weather）、24 小时（/weather24）和右上角的城市选择。
// 数据层见 src/features/weather（S7a）。口径（docs/使用说明-规则草稿-chitu.md 第 5 节）：
// - 城市只来自本地城市文件（337 个地级市，省 → 市两级），默认无锡，选择按账号记在 localStorage；不定位、不用项目所在城市；
// - 三块（实时、7 天、24 小时）各自有加载 / 失败 / 无数据，一块失败不影响另外两块；
// - /weather 失败而 /weather24 有数据时（features.weatherNowFallback，默认开）：大号温度、天气、风向、风力取离现在最近的
//   一小时，标「小时预报」，湿度、露点、气压、紫外线没有来源，隐藏；
// - 账号没有天气接口权限：整块显示「当前账号未开通天气功能」，不发请求；
// - 演示数据模式走同一个组件（数据源由 weatherSource() 选择）。
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import {
  faLocationDot, faChevronDown, faRotateRight, faDroplet, faWind, faTemperatureLow, faGauge, faSun, faUmbrella, faMagnifyingGlass, faCompass, type IconDefinition,
} from '@fortawesome/free-solid-svg-icons'
import { Chart, Icon, axis, tooltip } from '../../components/legacy'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Command, CommandEmpty, CommandItem, CommandList } from '@/components/ui/command'
import { AfterRender, itemById } from '@/components/ui/command-sync'
import { InputGroup, InputGroupInput } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { getConfig } from '../../api/config'
import { useApp } from '../../app/store'
import {
  findCity, NO_WEATHER_TEXT, PROVINCES, useWeather24, useWeatherCity, useWeatherNow,
  type City, type Weather24View, type WeatherLoad, type WeatherNowView,
} from '../../features/weather'
import { deg, hourLabel, iconOf, matchCity, nearestHour, WEEKDAYS } from './weatherUi'

// ---------------------------------------------------------------------------
// 城市选择（Popover + Command，可搜索；按省分组）

export function CityPicker({ city, onPick }: { city: City; onPick: (code: string) => void }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [hl, setHl] = useState('')
  const [listId, setListId] = useState<string>()
  const [itemId, setItemId] = useState<string>()
  const inputRef = useRef<HTMLInputElement>(null)
  const contentId = useId()
  const scrolled = useRef('')
  const groups = PROVINCES.map((p) => ({ p, cities: p.cities.filter((c) => matchCity(c, p.name, q)) })).filter((g) => g.cities.length > 0)
  const first = groups[0]?.cities[0]

  const show = () => { scrolled.current = ''; setQ(''); setHl(city.code); setOpen(true) }
  const pick = (c: City) => { setOpen(false); if (c.code !== city.code) onPick(c.code) }
  const sync = () => {
    const el = document.getElementById(contentId)
    setListId(el?.querySelector('[cmdk-list]')?.id)
    setItemId(hl ? itemById(el, hl)?.id : undefined)
    // 弹层刚挂载时还在定位，当场滚动不生效：下一帧再滚，每个高亮只滚一次
    if (hl && scrolled.current !== hl) {
      scrolled.current = hl
      requestAnimationFrame(() => itemById(document.getElementById(contentId), hl)?.scrollIntoView({ block: 'nearest' }))
    }
  }

  return (
    <Popover open={open} onOpenChange={(o) => (o ? show() : setOpen(false))}>
      <PopoverTrigger asChild>
        <Button size="lg" aria-label={`天气城市：${city.name}，点击更换`} style={{ fontWeight: 500, color: 'var(--text)' }}
          onKeyDown={(e) => { if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) show() } }}>
          <Icon icon={faLocationDot} className="cyan" />{city.name}<Icon icon={faChevronDown} size="xs" className="faint" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        id={contentId}
        align="end"
        aria-label="选择天气城市"
        onOpenAutoFocus={(e) => { e.preventDefault(); inputRef.current?.focus() }}
        className="flex max-h-[min(400px,var(--radix-popover-content-available-height))] w-[280px] flex-col rounded-lg border border-border p-1.5 text-[13px] shadow-pop"
      >
        <Command
          shouldFilter={false}
          value={hl}
          onValueChange={setHl}
          className="flex min-h-0 flex-col"
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return
            if (e.key === 'Enter' && !hl) { e.preventDefault(); if (first) pick(first) }
            if (e.key === 'Tab') { e.preventDefault(); setOpen(false) }
          }}
        >
          <InputGroup className="mb-1.5 shrink-0 px-2.5">
            <Icon icon={faMagnifyingGlass} />
            <InputGroupInput
              ref={inputRef}
              className="min-w-0 text-foreground"
              placeholder="搜索城市或省份"
              role="combobox"
              aria-label="搜索城市"
              aria-autocomplete="list"
              aria-expanded
              aria-controls={listId}
              aria-activedescendant={itemId}
              value={q}
              onChange={(e) => {
                const v = e.target.value
                setQ(v)
                const hit = PROVINCES.flatMap((p) => p.cities.filter((c) => matchCity(c, p.name, v)))[0]
                setHl(hit?.code ?? '')
              }}
              onKeyDown={(e) => { if (e.key === 'Home' || e.key === 'End') e.stopPropagation() }}
            />
          </InputGroup>
          <CommandList label="城市" className="min-h-0 overflow-y-auto">
            {groups.map(({ p, cities }) => (
              <div key={p.code} role="group" aria-label={p.name}>
                <div aria-hidden="true" className="px-2.5 pt-2 pb-1 text-[11.5px] text-faint">{p.name}</div>
                {cities.map((c) => (
                  <CommandItem
                    key={c.code}
                    value={c.code}
                    onSelect={() => pick(c)}
                    data-current={c.code === city.code || undefined}
                    className={cn('rounded-[7px]', c.code === city.code ? 'bg-primary-soft font-semibold text-primary' : 'text-foreground hover:bg-background')}
                  >
                    <span className="min-w-0 truncate">{c.name}</span>
                  </CommandItem>
                ))}
              </div>
            ))}
            <CommandEmpty className="px-2.5 py-3 text-[12.5px] text-muted-foreground">未找到匹配的城市</CommandEmpty>
            <AfterRender run={sync} />
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

// ---------------------------------------------------------------------------
// 三块

/** 重试按钮：请求期间显示加载态并禁用，回来后恢复（卸载后不再改状态） */
function RetryButton({ refetch, style }: { refetch: () => Promise<boolean>; style?: React.CSSProperties }) {
  const [busy, setBusy] = useState(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const go = () => { setBusy(true); void refetch().finally(() => { if (alive.current) setBusy(false) }) }
  return <Button style={style} disabled={busy} aria-busy={busy} onClick={go}>{busy ? '重试中…' : '重试'}</Button>
}

function Msg({ load, what, height }: { load: WeatherLoad<unknown>; what: string; height?: number }) {
  const err = load.status === 'error'
  return (
    <div className="chart-loading" role={err ? 'alert' : 'status'} style={{ height: height ?? 160 }}>
      <div style={{ textAlign: 'center' }}>
        {err ? <>{what}：{load.text ?? NO_WEATHER_TEXT}<div style={{ marginTop: 12 }}><RetryButton refetch={load.refetch} /></div></>
          : load.status === 'forbidden' ? load.text : '加载中…'}
      </div>
    </div>
  )
}

interface Tile { key: string; icon: IconDefinition; label: string; value: ReactNode }

function NowBlock({ now, hours, cityName }: { now: WeatherLoad<WeatherNowView>; hours: WeatherLoad<Weather24View>; cityName: string }) {
  const n = now.data
  const fallback = !n && (now.status === 'error' || now.status === 'forbidden') && getConfig().features.weatherNowFallback !== false && hours.data
    ? nearestHour(hours.data.hours, Date.now()) : null
  if (!n && !fallback) {
    return (
      <div className="wx wx-msg" role={now.status === 'error' ? 'alert' : 'status'}>
        <div className="wx-main"><div>
          <div className="wx-desc"><Icon icon={faLocationDot} /> {cityName}</div>
          <div className="wx-desc">{now.status === 'error' ? `实时天气：${now.text ?? NO_WEATHER_TEXT}` : now.status === 'forbidden' ? now.text : '正在获取实时天气…'}</div>
          {now.status === 'error' && <RetryButton style={{ marginTop: 14 }} refetch={now.refetch} />}
        </div></div>
      </div>
    )
  }
  const today = n?.days[0] ?? null
  const temp = n ? n.temp : fallback!.temp
  const text = n ? n.text : fallback!.text
  const [ic, color] = iconOf(n ? n.code : fallback!.code, text)
  const windDir = n ? n.windDirection : fallback!.windDirection
  const windPow = n ? n.windPower : fallback!.windPower
  const tiles = ([
    n && n.humidity !== null && { key: 'hum', icon: faDroplet, label: '相对湿度', value: <>{n.humidity}%</> },
    n && n.dew !== null && { key: 'dew', icon: faTemperatureLow, label: '露点', value: <>{n.dew}°</> },
    windDir && { key: 'wd', icon: faCompass, label: '风向', value: windDir },
    windPow && { key: 'wp', icon: faWind, label: '风力', value: windPow },
    n && today?.pressure != null && { key: 'pa', icon: faGauge, label: '气压', value: <>{today.pressure}<small>hPa</small></> },
    n && today?.uv && { key: 'uv', icon: faSun, label: '紫外线', value: today.uv },
  ] as (Tile | null | false | '' | undefined)[]).filter((x): x is Tile => !!x)
  return (
    <div className="wx">
      <div className="wx-main">
        <Icon icon={ic} style={{ color, fontSize: 84, width: 110 }} />
        <div>
          <div className="wx-temp num">{temp === null ? '--' : temp}<sup>°C</sup></div>
          <div className="wx-desc">{text ?? '--'}
            <small>{fallback ? <>小时预报 · {hourLabel(fallback.time)}（实时天气暂不可用）</> : today ? `最高 ${deg(today.high)} / 最低 ${deg(today.low)}` : ''}</small>
          </div>
        </div>
        {tiles.length > 0 && (
          <div className="wx-grid">{tiles.map((t) => <div key={t.key}><span><Icon icon={t.icon} />{t.label}</span><b className="num">{t.value}</b></div>)}</div>
        )}
      </div>
      {n && (n.aqi !== null || today?.sunrise || today?.rainChance != null) && (
        <div className="wx-bot">
          {n.aqi !== null && <div><span className="aqi num">{n.aqi}</span><div><b>空气质量{n.aqiText && ` · ${n.aqiText}`}</b>{n.pm25 !== null && <small>PM2.5 {n.pm25} μg/m³</small>}</div></div>}
          {today?.sunrise && <div><Icon icon={faSun} style={{ color: '#fcd34d', fontSize: 20 }} /><div><b className="num">日出 {today.sunrise}</b>{today.sunset && <small className="num">日落 {today.sunset}</small>}</div></div>}
          {today?.rainChance != null && <div><Icon icon={faUmbrella} style={{ fontSize: 18 }} /><div><b className="num">降水概率 {today.rainChance}%</b></div></div>}
        </div>
      )}
      {n?.time && <div className="wx-time num">数据时间 {n.time.slice(11)}</div>}
    </div>
  )
}

function WeekCard({ now }: { now: WeatherLoad<WeatherNowView> }) {
  const days = now.data?.days ?? []
  const highs = days.map((d) => d.high).filter((v): v is number => v !== null)
  const lows = days.map((d) => d.low).filter((v): v is number => v !== null)
  const lo = Math.min(...lows, ...highs)
  const hi = Math.max(...lows, ...highs)
  const span = hi - lo || 1
  return (
    <Card className="week">
      <CardHeader style={{ marginBottom: 8 }}><CardTitle>未来 7 天</CardTitle></CardHeader>
      {now.status !== 'success' ? <Msg load={now} what="7 天预报暂不可用" height={280} />
        : days.length === 0 ? <div className="chart-loading" role="status" style={{ height: 280 }}>{NO_WEATHER_TEXT}</div>
        : days.map((d, i) => {
          const [ic, c] = iconOf(d.dayCode, d.dayText)
          return (
            <div className="wd" key={d.date ?? i}>
              <b>{i === 0 ? '今天' : d.weekday ? WEEKDAYS[d.weekday] : (d.date?.slice(5) ?? '')}</b><Icon icon={ic} style={{ color: c }} /><span className="muted">{d.dayText ?? '--'}</span>
              <span className="faint num">{deg(d.low)}</span>
              <span className="rng">{d.low !== null && d.high !== null && <i style={{ left: `${((d.low - lo) / span) * 100}%`, right: `${100 - ((d.high - lo) / span) * 100}%`, background: 'linear-gradient(90deg,#22d3ee,#fbbf24,#f97316)' }} />}</span>
              <b className="num" style={{ textAlign: 'right' }}>{deg(d.high)}</b>
            </div>
          )
        })}
    </Card>
  )
}

function HoursCard({ hours }: { hours: WeatherLoad<Weather24View> }) {
  const list = hours.data?.hours ?? []
  const temps = list.map((h) => h.temp).filter((v): v is number => v !== null)
  const opt = list.length > 0 && {
    tooltip,
    grid: { left: 36, right: 20, top: 22, bottom: 30 },
    xAxis: { type: 'category' as const, boundaryGap: false, data: list.map((h) => hourLabel(h.time)), axisLabel: { ...axis.label, interval: 2 }, axisLine: { show: false }, axisTick: { show: false } },
    yAxis: { type: 'value' as const, min: temps.length ? Math.floor(Math.min(...temps) - 2) : 0, max: temps.length ? Math.ceil(Math.max(...temps) + 2) : 10, axisLabel: { ...axis.label, formatter: '{value}°' }, splitLine: axis.split },
    series: [{ name: '温度 °C', type: 'line' as const, smooth: true, data: list.map((h) => h.temp), symbol: 'circle', symbolSize: 5, lineStyle: { color: '#f28c38', width: 2.4 }, itemStyle: { color: '#f28c38' }, areaStyle: { color: 'rgba(249,115,22,.06)' } }],
  }
  return (
    <Card>
      <CardHeader style={{ marginBottom: 4 }}><div><CardTitle>24 小时预报</CardTitle><CardDescription>室外温度变化趋势</CardDescription></div></CardHeader>
      {hours.status !== 'success' ? <Msg load={hours} what="24 小时预报暂不可用" height={236} />
        : !opt ? <div className="chart-loading" role="status" style={{ height: 236 }}>{NO_WEATHER_TEXT}</div>
        : <>
          <Chart option={opt} height={236} />
          <div className="hourly">{list.filter((_, i) => i % 2 === 0).slice(0, 12).map((h, i) => { const [ic, c] = iconOf(h.code, h.text); return <div key={h.time ?? i}><Icon icon={ic} style={{ color: c }} /><span className="num">{hourLabel(h.time)}</span></div> })}</div>
        </>}
    </Card>
  )
}

// ---------------------------------------------------------------------------

/** 首页天气的数据：只在 Home 里调用一次，传给页头按钮和三块（两处共用同一份查询状态） */
export function useHomeWeather() {
  const { city, setCity } = useWeatherCity()
  const now = useWeatherNow(city)
  const hours = useWeather24(city)
  return { city, setCity, now, hours, forbidden: now.status === 'forbidden' && hours.status === 'forbidden' }
}
export type HomeWeather = ReturnType<typeof useHomeWeather>

/** 页头右侧：城市选择和刷新（没有天气权限时不显示） */
export function WeatherActions({ w }: { w: HomeWeather }) {
  const { toast } = useApp()
  const [spin, setSpin] = useState(false)
  const alive = useRef(true)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => { alive.current = true; return () => { alive.current = false; if (timer.current) clearTimeout(timer.current) } }, [])
  if (w.forbidden) return null
  // 等两路请求都回来（且至少转 800ms）再按结果提示；离开首页时清掉计时器、不再提示
  const refresh = () => {
    if (spin) return
    setSpin(true)
    const wait = new Promise<void>((r) => { timer.current = setTimeout(r, 800) })
    // 没有权限的那一路不请求，也不算失败（例如只有 /weather24 权限、实时块用小时预报顶替）
    const skipNow = w.now.status === 'forbidden', skipHours = w.hours.status === 'forbidden'
    void Promise.all([w.now.refetch(), w.hours.refetch(), wait]).then(([a, b]) => {
      if (!alive.current) return
      timer.current = null
      setSpin(false)
      if ((skipNow || a) && (skipHours || b)) toast('天气已更新')
      else toast('更新失败，沿用上次数据', true)
    })
  }
  const pick = (code: string) => { if (w.setCity(code)) toast(`天气城市已切换为 ${findCity(code)?.name ?? code}`) }
  return (
    <div className="actions">
      <CityPicker city={w.city} onPick={pick} />
      <Button size="lg" aria-label="刷新天气" style={{ width: 42, padding: 0 }} onClick={refresh}><Icon icon={faRotateRight} spin={spin} /></Button>
    </div>
  )
}

/** 天气三块：实时（含降级）、7 天、24 小时；没有天气权限时整块一张说明卡 */
export function WeatherSection({ w }: { w: HomeWeather }) {
  if (w.forbidden) {
    return <Card style={{ marginBottom: 20 }} role="status"><CardHeader><div><CardTitle>天气</CardTitle><CardDescription>{w.now.text}</CardDescription></div></CardHeader></Card>
  }
  return (
    <>
      <div className="home-top">
        <NowBlock now={w.now} hours={w.hours} cityName={w.city.name} />
        <WeekCard now={w.now} />
      </div>
      <div className="home-mid full"><HoursCard hours={w.hours} /></div>
    </>
  )
}
