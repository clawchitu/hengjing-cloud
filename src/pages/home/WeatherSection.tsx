// 首页天气（S7b，改动 1、2）：实时 + 7 天（/weather）、24 小时（/weather24）和右上角的城市选择。
// 数据层见 src/features/weather（S7a）。口径（docs/使用说明-规则草稿-chitu.md 第 5 节）：
// - 城市只来自本地城市文件（337 个地级市，省 → 市两级），默认无锡，选择按账号记在 localStorage；不定位、不用项目所在城市；
// - 三块（实时、7 天、24 小时）各自有加载 / 失败 / 无数据，一块失败不影响另外两块；
// - /weather 失败而 /weather24 有数据时（features.weatherNowFallback，默认开）：大号温度、天气、风向、风力取离现在最近的
//   一小时，标「小时预报」，湿度、露点、气压、紫外线没有来源，隐藏；
// - 账号没有天气接口权限：整块显示「当前账号未开通天气功能」，不发请求；
// - 演示数据模式走同一个组件（数据源由 weatherSource() 选择）。
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import {
  faLocationDot, faChevronDown, faChevronLeft, faChevronRight, faRotateRight, faDroplet, faWind, faTemperatureLow, faGauge, faSun, faUmbrella, faMagnifyingGlass, faCompass, type IconDefinition,
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
  findCity, NO_WEATHER_TEXT, PROVINCES, provinceOf, useWeather24, useWeatherCity, useWeatherNow,
  type City, type Province, type Weather24View, type WeatherLoad, type WeatherNowView,
} from '../../features/weather'
import { deg, hourLabel, iconOf, isSingleCity, nearestHour, searchCities, WEEKDAYS } from './weatherUi'

// ---------------------------------------------------------------------------
// 城市选择（Popover + Command）：省 → 市两级，可搜索（强哥 11/25 18:20：原来的单列下拉太长、太大）
// - 不搜索时：省份列表 → 点省份进入它的城市列表（顶部固定一行「返回省份列表」，空搜索框按退格也返回）；
//   直辖市（只有一个市的省）点了直接选中；
// - 打开时定位到当前城市所在省的城市列表，高亮当前城市；
// - 搜索框有关键字时：平铺显示匹配的城市，带省份名（「苏州市 · 江苏省」）；
// - 列表高度不超过 360px（含搜索框，再受可用高度限制）。

/** cmdk 选项值：省份加前缀，避免和直辖市的城市码（同为省级码）撞 */
const PROV = 'p:'
const BACK = 'back'

export function CityPicker({ city, onPick }: { city: City; onPick: (code: string) => void }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [prov, setProv] = useState<Province | null>(null)
  const [hl, setHl] = useState('')
  const [listId, setListId] = useState<string>()
  const [itemId, setItemId] = useState<string>()
  const inputRef = useRef<HTMLInputElement>(null)
  const contentId = useId()
  const hits = searchCities(q)
  const searching = q.trim() !== ''
  /** 当前视图：搜索结果 / 某省的城市 / 省份列表。视图一变，新视图里的高亮按「从列表顶端出发」直接滚到位 */
  const view = searching ? 'search' : prov ? prov.code : 'provinces'

  /** 省份列表里的默认高亮：当前城市所在的省（没有就不高亮） */
  const provinceHl = (() => { const p = provinceOf(city.code); return p ? PROV + p.code : '' })()

  /** 不搜索时当前视图的默认高亮：省的城市列表里是当前城市（不在这个省就是第一个市），省份列表里是当前城市所在的省 */
  const defaultHl = prov ? (prov.cities.some((c) => c.code === city.code) ? city.code : prov.cities[0].code) : provinceHl

  // 程序化换了视图后的高亮：被高亮的那项卸载时，cmdk 会把高亮改成新列表的第一项（本次提交的 layout 阶段，晚于 setHl）。
  // 注意：cmdk 只在「最后一个卸载的项」恰好是高亮项时才回退（凉山是四川省最后一个市、新疆是最后一个省，e2e 依赖这一点）。
  // 换视图后的两帧内（want 非空），高亮不是目标值就设回去；用户按键（含退格返回）、再输入搜索词、进入 / 返回都会重新设定或终止
  const want = useRef<string | null>(null)
  const wantGen = useRef(0)
  const arm = (target: string) => {
    want.current = target
    setHl(target)
    const gen = ++wantGen.current
    requestAnimationFrame(() => requestAnimationFrame(() => { if (wantGen.current === gen) want.current = null }))
  }
  const disarm = () => { want.current = null; wantGen.current++ }
  // layout effect：在绘制前修正，不闪一帧返回行 / 第一项
  useLayoutEffect(() => {
    if (want.current !== null && !searching && hl !== want.current) setHl(want.current)
  }, [hl, searching])

  const show = () => {
    disarm() // 快速关了又开：上一次的恢复目标作废
    const p = provinceOf(city.code)
    lastView.current = ''; scrolled.current = ''; anchor.current = ''
    // 当前城市是直辖市（省里只有它一个市）：直接显示省份列表并高亮这个直辖市，不进只有一项的城市列表
    const into = p && !isSingleCity(p) ? p : null
    setQ(''); setProv(into); setHl(into ? city.code : provinceHl); setOpen(true)
  }
  const pick = (c: City) => { disarm(); setOpen(false); if (c.code !== city.code) onPick(c.code) }
  const enter = (p: Province) => {
    if (isSingleCity(p)) { pick(p.cities[0]); return }
    setProv(p)
    arm(p.cities.some((c) => c.code === city.code) ? city.code : p.cities[0].code)
    inputRef.current?.focus()
  }
  const back = () => {
    const from = prov
    setProv(null)
    arm(from ? PROV + from.code : '')
    inputRef.current?.focus()
  }

  const hlNow = useRef(hl)
  const viewNow = useRef(view)
  // layout effect：早于 AfterRender 的 useEffect 和 rAF / ResizeObserver 回调，reveal 读到的总是本次渲染的高亮和视图
  useLayoutEffect(() => { hlNow.current = hl; viewNow.current = view }, [hl, view])
  /** 视图切换时的那个高亮（`视图|值`）：按绝对位置滚；高亮离开过它，之后都按 nearest 滚 */
  const anchor = useRef('')
  const lastView = useRef('')
  const scrolled = useRef('')
  const watched = useRef<{ list: Element; ro: ResizeObserver } | null>(null)
  useEffect(() => () => watched.current?.ro.disconnect(), [])
  /**
   * 把当前高亮项滚进列表可见区（贴最近的一边，同 block: 'nearest'）。只改列表自己的 scrollTop：立即到位、没有平滑滚动，
   * 也不会带动页面或弹层。顶部固定的「返回」行挡住的部分不算可见区。
   * 视图切换（含打开）时的那个高亮按「从列表顶端出发」算出绝对位置，不看此刻已经滚到哪：弹层定位期间列表高度会变，
   * 相对滚动的结果取决于先滚还是先定高（CI 上截图偶发偏移的根因，#72）。列表尺寸每变一次重算（见 sync 里的 ResizeObserver）
   */
  const reveal = () => {
    const root = document.getElementById(contentId)
    const list = root?.querySelector<HTMLElement>('[cmdk-list]')
    const item = hlNow.current ? itemById(root, hlNow.current) : null
    if (!list || !item) return
    const r = item.getBoundingClientRect()
    const head = hlNow.current === BACK ? 0 : (itemById(root, BACK)?.offsetHeight ?? 0)
    const top = list.getBoundingClientRect().top + list.clientTop
    if (anchor.current === `${viewNow.current}|${hlNow.current}`) {
      list.scrollTop = Math.max(0, r.bottom - top + list.scrollTop - list.clientHeight)
      return
    }
    if (r.top < top + head) list.scrollTop += r.top - top - head
    else if (r.bottom > top + list.clientHeight) list.scrollTop += r.bottom - (top + list.clientHeight)
  }
  const sync = () => {
    const el = document.getElementById(contentId)
    const list = el?.querySelector('[cmdk-list]')
    setListId(list?.id)
    setItemId(hl ? itemById(el, hl)?.id : undefined)
    const key = `${view}|${hl}`
    if (view !== lastView.current) { lastView.current = view; anchor.current = key; if (list) list.scrollTop = 0 }
    else if (key !== anchor.current) anchor.current = ''
    // 弹层刚挂载时还在定位、列表高度（取决于可用高度）还没定，当场滚的位置不可靠：
    // 下一帧滚一次（每个视图里的每个高亮只滚一次），之后列表尺寸每变一次再按当时的高度重算，最终位置与定位完成的先后无关
    if (hl && scrolled.current !== key) {
      scrolled.current = key
      requestAnimationFrame(reveal)
    }
    if (list && watched.current?.list !== list) {
      watched.current?.ro.disconnect()
      watched.current = null
      if (typeof ResizeObserver === 'function') {
        const ro = new ResizeObserver(() => reveal())
        ro.observe(list)
        watched.current = { list, ro }
      }
    }
  }

  const cur = 'bg-primary-soft font-semibold text-primary'
  const idle = 'text-foreground hover:bg-background'
  return (
    <Popover open={open} onOpenChange={(o) => { if (o) show(); else { disarm(); setOpen(false) } }}>
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
        className="flex max-h-[min(360px,var(--radix-popover-content-available-height))] w-[280px] flex-col rounded-lg border border-border p-1.5 text-[13px] shadow-pop"
      >
        <Command
          shouldFilter={false}
          value={hl}
          onValueChange={setHl}
          className="flex min-h-0 flex-col"
          onPointerMove={(e) => { if (e.movementX || e.movementY) disarm() }} // 真实的鼠标移动：cmdk 按悬停改高亮，不再抢回
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return
            if (e.key === 'Enter' && !hl) { e.preventDefault(); if (searching && hits[0]) pick(hits[0].city) }
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
                if (v.trim()) { disarm(); setHl(searchCities(v)[0]?.city.code ?? '') }
                else arm(defaultHl)
              }}
              onKeyDown={(e) => {
                disarm() // 用户自己动了高亮，不再恢复
                if (e.key === 'Home' || e.key === 'End') e.stopPropagation()
                if (e.key === 'Backspace' && !q && prov) { e.preventDefault(); back() }
              }}
            />
          </InputGroup>
          <CommandList label={searching ? '城市' : prov ? prov.name : '省份'} className="min-h-0 overflow-y-auto">
            {searching ? hits.map(({ city: c, province: p }) => (
              <CommandItem key={c.code} value={c.code} onSelect={() => pick(c)} data-current={c.code === city.code || undefined}
                className={cn('justify-start rounded-[7px]', c.code === city.code ? cur : idle)}>
                <span className="min-w-0 truncate">{c.name}{p.name !== c.name && <span className="font-normal text-faint"> · {p.name}</span>}</span>
              </CommandItem>
            )) : prov ? (
              <>
                <CommandItem value={BACK} onSelect={back} aria-label={`返回省份列表（当前：${prov.name}）`}
                  className="sticky top-0 z-10 justify-start gap-2 rounded-[7px] border-b border-border bg-popover text-muted-foreground hover:bg-background">
                  <Icon icon={faChevronLeft} size="xs" /><span className="min-w-0 flex-1 truncate">{prov.name}</span><span className="shrink-0 text-[12px] text-faint">全部省份</span>
                </CommandItem>
                {prov.cities.map((c) => (
                  <CommandItem key={c.code} value={c.code} onSelect={() => pick(c)} data-current={c.code === city.code || undefined}
                    className={cn('rounded-[7px]', c.code === city.code ? cur : idle)}>
                    <span className="min-w-0 truncate">{c.name}</span>
                  </CommandItem>
                ))}
              </>
            ) : PROVINCES.map((p) => {
              const here = p.cities.some((c) => c.code === city.code)
              return (
                <CommandItem key={p.code} value={PROV + p.code} onSelect={() => enter(p)} data-current-province={here || undefined}
                  aria-description={isSingleCity(p) ? '直接选中' : '进入城市列表'}
                  className={cn('rounded-[7px]', here ? cur : idle)}>
                  <span className="min-w-0 truncate">{p.name}</span>
                  {!isSingleCity(p) && <Icon icon={faChevronRight} size="xs" className="faint" />}
                </CommandItem>
              )
            })}
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
    yAxis: { type: 'value' as const, min: temps.length ? Math.floor(Math.min(...temps) - 2) : 0, max: temps.length ? Math.ceil(Math.max(...temps) + 2) : 10, axisLabel: { ...axis.label, formatter: '{value}°', showMinLabel: false, showMaxLabel: false }, splitLine: axis.split }, // 上下界不在刻度间隔上时会压住相邻刻度字（S13 走查 P13）
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
