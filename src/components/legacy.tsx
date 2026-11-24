import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import ReactECharts from 'echarts-for-react'
import type { EChartsOption } from 'echarts'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faChevronLeft, faChevronRight } from '@fortawesome/free-solid-svg-icons'

export { FontAwesomeIcon as Icon }

export function LogoMark({ size = 32 }: { size?: number }) {
  return (
    <div className="logo-mark" style={{ width: size, height: size }}>
      <svg viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round">
        <path d="M4 9h10a3 3 0 1 0-3-3" />
        <path d="M4 13.5h14a3 3 0 1 1-3 3" />
        <path d="M4 18h6" />
      </svg>
    </div>
  )
}

export function Avatar({ size = 36 }: { size?: number }) {
  return (
    <div className="avatar" style={{ width: size, height: size }}>
      <svg viewBox="0 0 40 40" width="100%" height="100%">
        <defs>
          <linearGradient id="avbg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#cbd5e1" /><stop offset="1" stopColor="#94a3b8" /></linearGradient>
        </defs>
        <rect width="40" height="40" fill="url(#avbg)" />
        <path d="M6 40c1-8 7-11 14-11s13 3 14 11z" fill="#1e293b" />
        <path d="M16.5 27h7v4l-3.5 2-3.5-2z" fill="#d6a283" />
        <ellipse cx="20" cy="18" rx="7" ry="8.4" fill="#e0b294" />
        <path d="M13 16c0-5 3-8 7-8s7 3 7 8c-1-2-2-3-3-3-2 1-6 1-8 0-1 0-2 1-3 3z" fill="#3f3a36" />
        <path d="M14.5 21c1 4 3 6 5.5 6s4.5-2 5.5-6c-.5 3-2 4-5.5 4s-5-1-5.5-4z" fill="#8b7262" opacity=".7" />
      </svg>
    </div>
  )
}

export function Seg<T extends string>({ value, options, onChange, className = '', counts }: { value: T; options: T[]; onChange: (v: T) => void; className?: string; counts?: Partial<Record<T, number>> }) {
  return (
    <div className={'seg ' + className}>
      {options.map((o) => (
        <button key={o} className={o === value ? 'on' : ''} onClick={() => onChange(o)}>
          {o}{counts?.[o] !== undefined && <small>{counts[o]}</small>}
        </button>
      ))}
    </div>
  )
}

export function Chart({ option, height = 300, style }: { option: object; height?: number; style?: CSSProperties }) {
  return <ReactECharts option={option as EChartsOption} style={{ height, width: '100%', ...style }} notMerge lazyUpdate opts={{ renderer: 'svg' }} />
}

export function Pager({ total, page, size, onPage, label }: { total: number; page: number; size: number; onPage: (p: number) => void; label?: ReactNode }) {
  const pages = Math.max(1, Math.ceil(total / size))
  return (
    <div className="pager">
      <span>{label ?? <>共 <b className="num" style={{ color: 'var(--text-2)' }}>{total}</b> 条</>}</span>
      <div className="pages">
        <button disabled={page <= 1} onClick={() => onPage(page - 1)}><FontAwesomeIcon icon={faChevronLeft} size="xs" /></button>
        {Array.from({ length: pages }, (_, i) => (
          <button key={i} className={page === i + 1 ? 'on' : ''} onClick={() => onPage(i + 1)}>{i + 1}</button>
        ))}
        <button disabled={page >= pages} onClick={() => onPage(page + 1)}><FontAwesomeIcon icon={faChevronRight} size="xs" /></button>
      </div>
    </div>
  )
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []): [T | undefined, (v: T) => void] {
  const [v, setV] = useState<T>()
  useEffect(() => {
    let live = true
    fn().then((r) => live && setV(r))
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return [v, setV as (v: T) => void]
}

export function useClock() {
  const [now, setNow] = useState(new Date())
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t) }, [])
  return now.toTimeString().slice(0, 8)
}

export function useInterval(cb: () => void, ms: number) {
  const ref = useRef(cb)
  ref.current = cb
  useEffect(() => { const t = setInterval(() => ref.current(), ms); return () => clearInterval(t) }, [ms])
}

export const fmt = (n: number, d = 1) => n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })

/** shared echarts axis styling */
export const axis = {
  label: { color: '#64748b', fontSize: 11, fontFamily: 'Barlow' },
  line: { lineStyle: { color: '#cbd5e1' } },
  split: { lineStyle: { color: '#eef2f6' } },
  dashed: { lineStyle: { color: '#e2e8f0', type: 'dashed' as const } },
}
export const tooltip = { trigger: 'axis' as const, backgroundColor: '#fff', borderColor: '#e2e8f0', textStyle: { color: '#0f172a', fontSize: 12 }, extraCssText: 'box-shadow:0 6px 20px rgba(15,23,42,.12);border-radius:8px;' }
