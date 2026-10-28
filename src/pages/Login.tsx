import type React from 'react'
import { useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { faEyeSlash, faEye, faMobileScreen, faChartLine, faSliders, faShieldHalved, faLock, faThermometerHalf, faWind, faDroplet, faCube } from '@fortawesome/free-solid-svg-icons'
import { faUser as faUserR } from '@fortawesome/free-regular-svg-icons'
import { faWeixin } from '@fortawesome/free-brands-svg-icons'
import { Icon, LogoMark } from '../components/ui'
import { useApp } from '../app/store'
import * as api from '../api'

// deterministic pseudo random
function rng(seed: number) { return () => ((seed = (seed * 16807) % 2147483647) / 2147483647) }

function NightScene() {
  const svg = useMemo(() => {
    const r = rng(7)
    const far: React.ReactElement[] = []
    // distant skyline
    let x = 0
    while (x < 1000) {
      const w = 30 + r() * 60, h = 120 + r() * 260
      far.push(<rect key={'f' + x} x={x} y={1000 - h - 150} width={w} height={h + 150} fill="#0d1d33" />)
      for (let wy = 1000 - h - 140; wy < 980; wy += 14) for (let wx = x + 5; wx < x + w - 6; wx += 10)
        if (r() > 0.86) far.push(<rect key={`fw${wx}-${wy}`} x={wx} y={wy} width={3} height={5} fill={r() > 0.5 ? '#fcd34d' : '#93c5fd'} opacity={0.35 + r() * 0.4} />)
      x += w + 4
    }
    // main tower
    const tower: React.ReactElement[] = []
    const tx = 270, tw = 360, top = 40
    tower.push(<rect key="tb" x={tx} y={top} width={tw} height={1000 - top} fill="url(#towerG)" />)
    for (let fy = top + 30, i = 0; fy < 1000; fy += 62, i++) {
      tower.push(<rect key={'sl' + i} x={tx - 18} y={fy} width={tw + 36} height={7} fill="#1e3354" />)
      tower.push(<rect key={'gl' + i} x={tx - 18} y={fy - 14} width={tw + 36} height={14} fill="#0f2440" opacity=".7" />)
      for (let c = 0; c < 9; c++) {
        const wx = tx + 10 + c * 39, lit = r()
        tower.push(<rect key={`w${i}-${c}`} x={wx} y={fy + 12} width={30} height={42} rx={1} fill={lit > 0.55 ? '#f6c66b' : lit > 0.35 ? '#c0874a' : '#132a48'} opacity={lit > 0.35 ? 0.55 + r() * 0.35 : 0.9} />)
        tower.push(<rect key={`m${i}-${c}`} x={wx + 14} y={fy + 12} width={2} height={42} fill="#0b1a2e" opacity=".6" />)
      }
      // balcony plants
      for (let pl = 0; pl < 6; pl++) tower.push(<circle key={`p${i}-${pl}`} cx={tx - 10 + r() * (tw + 20)} cy={fy - 4} r={4 + r() * 6} fill="#16331f" opacity=".85" />)
    }
    return { far, tower }
  }, [])

  const node = (cx: number, cy: number, rr: number, icon: typeof faWind, k: string) => (
    <g key={k}>
      <circle cx={cx} cy={cy} r={rr} fill="rgba(8,47,73,.35)" stroke="#22d3ee" strokeOpacity=".55" strokeWidth="1.5" />
      <foreignObject x={cx - rr} y={cy - rr} width={rr * 2} height={rr * 2}>
        <div style={{ width: '100%', height: '100%', display: 'grid', placeItems: 'center', color: '#67e8f9', fontSize: rr * 0.85, opacity: 0.85 }}><Icon icon={icon} /></div>
      </foreignObject>
    </g>
  )
  return (
    <svg className="scene" viewBox="0 0 1000 1000" preserveAspectRatio="xMidYMid slice">
      <defs>
        <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#0b1d36" /><stop offset=".55" stopColor="#15304f" /><stop offset=".8" stopColor="#3a3f55" /><stop offset="1" stopColor="#0a1628" /></linearGradient>
        <linearGradient id="towerG" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#0e213b" /><stop offset=".5" stopColor="#162d4d" /><stop offset="1" stopColor="#0c1c33" /></linearGradient>
        <linearGradient id="shade" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#0a1a30" stopOpacity=".88" /><stop offset=".6" stopColor="#0a1a30" stopOpacity=".55" /><stop offset="1" stopColor="#0a1a30" stopOpacity=".35" /></linearGradient>
        <linearGradient id="fadeB" x1="0" y1="0" x2="0" y2="1"><stop offset=".6" stopColor="#0a1628" stopOpacity="0" /><stop offset="1" stopColor="#0a1628" stopOpacity=".9" /></linearGradient>
      </defs>
      <rect width="1000" height="1000" fill="url(#sky)" />
      {svg.far}
      {svg.tower}
      <rect width="1000" height="1000" fill="url(#shade)" />
      <rect width="1000" height="1000" fill="url(#fadeB)" />
      <g stroke="#22d3ee" strokeOpacity=".35" fill="none" strokeWidth="1.2">
        <path d="M145 40 L145 70 L300 70 L380 120" />
        <path d="M655 0 L655 75 L520 110" />
        <path d="M905 290 L840 290 L720 380 L695 390" />
        <path d="M905 330 L905 420" strokeDasharray="3 5" />
        <path d="M120 330 C300 300 520 330 700 230" strokeOpacity=".18" />
        <path d="M60 760 C300 840 600 820 950 690" strokeOpacity=".15" />
        <path d="M695 240 L695 345" strokeDasharray="3 5" />
      </g>
      {node(145, 40, 38, faThermometerHalf, 'n1')}
      {node(905, 290, 38, faWind, 'n2')}
      {node(127, 340, 38, faDroplet, 'n3')}
      {node(695, 240, 17, faCube, 'n4')}
      {node(655, 0, 17, faCube, 'n5')}
      {node(310, 455, 17, faCube, 'n6')}
      {node(735, 650, 17, faCube, 'n7')}
      {[[655, 70], [695, 345], [905, 330], [520, 110], [380, 120]].map(([cx, cy], i) => <circle key={i} cx={cx} cy={cy} r="3.5" fill="#22d3ee" opacity=".8" />)}
    </svg>
  )
}

export default function Login() {
  const { login, toast } = useApp()
  const nav = useNavigate()
  const loc = useLocation() as { state?: { from?: string } }
  const [u, setU] = useState('zhangjianguo')
  const [pw, setPw] = useState('hengjing2025!')
  const [show, setShow] = useState(false)
  const [remember, setRemember] = useState(true)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!u.trim() || !pw) return toast('请输入用户名和密码', true)
    setBusy(true)
    await api.login(u, pw)
    login(u, remember)
    toast('登录成功，欢迎回来')
    nav(loc.state?.from && loc.state.from !== '/login' ? loc.state.from : '/home', { replace: true })
  }

  return (
    <div className="login">
      <div className="login-left">
        <NightScene />
        <div className="inner">
          <div className="login-brand"><LogoMark size={38} /><div><b>恒境云</b><small>HVAC IoT PLATFORM</small></div></div>
          <div className="login-copy">
            <span className="status-chip"><span className="dot" />平台运行正常 · 已接入 1,284 台设备</span>
            <h2>恒温 · 恒湿 · 恒氧<br />让每一个项目的环境都在掌控之中</h2>
            <p>多项目环境监控与统一控制平台，覆盖室内空气、温控面板、新风除湿、电能计量与机组运行全链路数据。</p>
            <div className="feat">
              <div><Icon icon={faChartLine} /><b>实时监测</b><small>秒级数据刷新</small></div>
              <div><Icon icon={faSliders} /><b>统一控制</b><small>分组批量下发</small></div>
              <div><Icon icon={faShieldHalved} /><b>智能告警</b><small>异常即时推送</small></div>
            </div>
          </div>
          <div className="login-foot">© 2025 恒境云科技 · 沪ICP备2025000000号</div>
        </div>
      </div>
      <div className="login-right">
        <form className="login-form" onSubmit={submit}>
          <h1>欢迎登录</h1>
          <div className="hint">请输入您的账号信息以访问管理平台</div>
          <label>用户名</label>
          <div className="field"><Icon icon={faUserR} /><input value={u} onChange={(e) => setU(e.target.value)} placeholder="请输入用户名" autoComplete="username" /></div>
          <label>密码</label>
          <div className="field">
            <Icon icon={faLock} />
            <input type={show ? 'text' : 'password'} value={pw} onChange={(e) => setPw(e.target.value)} placeholder="请输入密码" autoComplete="current-password" style={{ letterSpacing: show ? 0 : 4 }} />
            <button type="button" className="eye" onClick={() => setShow((s) => !s)}><Icon icon={show ? faEye : faEyeSlash} /></button>
          </div>
          <div className="login-row">
            <label><input type="checkbox" className="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />记住我</label>
            <a className="cyan" onClick={() => toast('已向绑定手机发送重置链接')} style={{ cursor: 'pointer' }}>忘记密码?</a>
          </div>
          <button className="btn-login" disabled={busy}>{busy ? '登录中…' : '登 录'}</button>
          <div className="divider">其他方式</div>
          <div className="alt-login">
            <button type="button" className="btn" onClick={() => toast('短信登录：演示环境未开通', true)}><Icon icon={faMobileScreen} className="faint" />短信登录</button>
            <button type="button" className="btn" onClick={() => toast('企业微信：演示环境未开通', true)}><Icon icon={faWeixin} style={{ color: '#07c160' }} />企业微信</button>
          </div>
          <div className="login-ver">平台版本 <b>v3.6.2</b> · 技术支持 400-820-1234</div>
        </form>
      </div>
    </div>
  )
}
