import type React from 'react'
import { useMemo, useState } from 'react'
import { faEyeSlash, faEye, faChartLine, faSliders, faShieldHalved, faLock, faThermometerHalf, faWind, faDroplet, faCube } from '@fortawesome/free-solid-svg-icons'
import { faUser as faUserR } from '@fortawesome/free-regular-svg-icons'
import { Icon, LogoMark } from '../components/legacy'
import { Checkbox } from '@/components/ui/checkbox'
import { InputGroup, InputGroupInput } from '@/components/ui/input'
import { useForm, type FieldErrors } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Form, FormControl, FormField, FormItem, FormLabel } from '@/components/ui/form'
import { useApp } from '../app/store'
import * as api from '../api'
import { isMockMode } from '../api/config'
import { isApiError } from '../api/errors'
import { signIn } from '../api/session'
import { loginDefaults, loginSchema, type LoginValues } from './loginSchema'

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
    // main tower: front face + darker side face, floor slabs, glazing, warm interiors, balcony planting
    const tower: React.ReactElement[] = []
    const tx = 250, tw = 330, side = 90, top = 30, fh = 46
    tower.push(<rect key="tb" x={tx} y={top} width={tw} height={1000 - top} fill="url(#towerG)" />)
    tower.push(<polygon key="ts" points={`${tx + tw},${top} ${tx + tw + side},${top + 26} ${tx + tw + side},1000 ${tx + tw},1000`} fill="#0a182c" />)
    for (let fy = top + 14, i = 0; fy < 1000; fy += fh, i++) {
      const cols = 11, cw = (tw - 12) / cols
      for (let c = 0; c < cols; c++) {
        const wx = tx + 6 + c * cw, lit = r()
        const warm = lit > 0.6
        tower.push(<rect key={`w${i}-${c}`} x={wx + 1} y={fy + 8} width={cw - 2} height={fh - 14} fill={warm ? 'url(#warm)' : lit > 0.3 ? '#1b3556' : '#11263f'} opacity={warm ? 0.22 + r() * 0.4 : 0.9} />)
        if (warm && r() > 0.5) tower.push(<rect key={`lamp${i}-${c}`} x={wx + cw * 0.3} y={fy + 10} width={cw * 0.4} height={2} fill="#ffe7b0" opacity=".8" />)
        tower.push(<rect key={`m${i}-${c}`} x={wx + cw - 1.5} y={fy + 8} width={1.5} height={fh - 14} fill="#0b1a2e" opacity=".8" />)
      }
      // side face windows
      for (let c = 0; c < 3; c++) {
        const lit = r() > 0.7
        tower.push(<polygon key={`sw${i}-${c}`} points={`${tx + tw + 8 + c * 27},${fy + 10 + c * 7.5} ${tx + tw + 30 + c * 27},${fy + 15 + c * 7.5} ${tx + tw + 30 + c * 27},${fy + 40 + c * 7.5} ${tx + tw + 8 + c * 27},${fy + 35 + c * 7.5}`} fill={lit ? '#a8743c' : '#0f2139'} opacity={lit ? 0.55 : 1} />)
      }
      // balcony slab + glass railing + planters
      tower.push(<rect key={'sl' + i} x={tx - 14} y={fy} width={tw + 28} height={5} fill="#2a4266" />)
      tower.push(<rect key={'slh' + i} x={tx - 14} y={fy} width={tw + 28} height={1.2} fill="#4b6a93" opacity=".7" />)
      tower.push(<rect key={'gl' + i} x={tx - 14} y={fy - 11} width={tw + 28} height={11} fill="#6c8db5" opacity=".08" />)
      for (let pl = 0; pl < 9; pl++) tower.push(<ellipse key={`p${i}-${pl}`} cx={tx - 8 + r() * (tw + 16)} cy={fy - 3} rx={4 + r() * 7} ry={3 + r() * 4} fill={r() > 0.5 ? '#1d3b26' : '#244a2c'} opacity=".9" />)
    }
    // rooftop garden
    for (let pl = 0; pl < 16; pl++) tower.push(<ellipse key={'rt' + pl} cx={tx + r() * tw} cy={top - 2} rx={6 + r() * 8} ry={5 + r() * 6} fill="#1d3b26" />)
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
        <linearGradient id="warm" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#ffd890" /><stop offset="1" stopColor="#b8732f" /></linearGradient>
        <linearGradient id="shade" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#0a1a30" stopOpacity=".9" /><stop offset=".55" stopColor="#0a1a30" stopOpacity=".62" /><stop offset="1" stopColor="#0a1a30" stopOpacity=".45" /></linearGradient>
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
  const [show, setShow] = useState(false)
  const form = useForm<LoginValues>({ resolver: zodResolver(loginSchema), defaultValues: loginDefaults })
  const busy = form.formState.isSubmitting

  // 跳转由 main.tsx 的 LoginRoute 在登录态变化后统一处理（回原路径或首页）
  const done = () => toast('登录成功，欢迎回来')

  const onSubmit = async ({ account, password, remember }: LoginValues) => {
    // 交付包（__HJC_MOCK__ = false）只有真实接口登录，演示账号登录代码在打包时剔除
    if (!__HJC_MOCK__ || !isMockMode()) {
      try {
        await signIn(account, password, remember)
      } catch (e) {
        // 后端文案（密码错误、经销商未配置集成功能等）原样提示；令牌类技术细节已在 errors.ts 统一成中文
        return toast(isApiError(e) ? e.message : '登录失败，请重试', true)
      }
      return done()
    }
    let auth
    try {
      auth = await api.login(account, password)
    } catch {
      return toast('用户名或密码错误', true)
    }
    login(auth, remember)
    done()
  }
  // 校验不通过时沿用原来的提示方式和文案（toast），不在输入框下方插入文字，界面不变
  const onInvalid = (errs: FieldErrors<LoginValues>) => {
    const empty = errs.account?.type === 'too_small' || errs.password?.type === 'too_small'
    toast(empty ? '请输入用户名和密码' : errs.account?.message ?? errs.password?.message ?? '请输入用户名和密码', true)
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
              <div><Icon icon={faShieldHalved} /><b>分级权限</b><small>经销商 / 管理员</small></div>
            </div>
          </div>
          <div className="login-foot">© 2025 恒境云科技 · 沪ICP备2025000000号</div>
        </div>
      </div>
      <div className="login-right">
        <Form {...form}>
          <form className="login-form" onSubmit={form.handleSubmit(onSubmit, onInvalid)} noValidate>
            <h1>欢迎登录</h1>
            <div className="hint">请输入您的账号信息以访问管理平台</div>
            <FormField control={form.control} name="account" render={({ field }) => (
              <FormItem>
                <FormLabel>用户名</FormLabel>
                <InputGroup variant="field" className="mb-5"><Icon icon={faUserR} /><FormControl><InputGroupInput className="text-[13.5px] text-foreground" {...field} placeholder="请输入用户名" autoComplete="username" /></FormControl></InputGroup>
              </FormItem>
            )} />
            <FormField control={form.control} name="password" render={({ field }) => (
              <FormItem>
                <FormLabel>密码</FormLabel>
                <InputGroup variant="field" className="mb-5">
                  <Icon icon={faLock} />
                  <FormControl><InputGroupInput className="text-[13.5px] text-foreground" {...field} type={show ? 'text' : 'password'} placeholder="请输入密码" autoComplete="current-password" style={{ letterSpacing: show ? 0 : 4 }} /></FormControl>
                  <button type="button" className="border-0 bg-transparent p-0 text-faint" onClick={() => setShow((s) => !s)}><Icon icon={show ? faEye : faEyeSlash} /></button>
                </InputGroup>
              </FormItem>
            )} />
            <div className="login-row">
              <FormField control={form.control} name="remember" render={({ field }) => (
                <label><Checkbox name={field.name} ref={field.ref} checked={field.value} onCheckedChange={(v) => field.onChange(v === true)} onBlur={field.onBlur} />记住我</label>
              )} />
              <a className="cyan" onClick={() => toast('已向绑定手机发送重置链接')} style={{ cursor: 'pointer' }}>忘记密码?</a>
            </div>
            <button className="btn-login" disabled={busy}>{busy ? '登录中…' : '登 录'}</button>
            <div className="login-ver">平台版本 <b>v3.6.2</b> · 技术支持 400-820-1234</div>
          </form>
        </Form>
      </div>
    </div>
  )
}
