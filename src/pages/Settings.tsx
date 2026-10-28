import { useState } from 'react'
import { Card, Toggle } from '../components/ui'
import { useApp } from '../app/store'

export default function Settings() {
  const { toast } = useApp()
  const [s, setS] = useState({ sms: true, wx: true, night: true, sound: false })
  const rows: [keyof typeof s, string, string][] = [
    ['sms', '短信通知', '紧急 / 重要报警通过短信推送给值班人员'],
    ['wx', '企业微信通知', '所有报警推送至企业微信运维群'],
    ['night', '夜间免打扰', '23:00–07:00 仅推送紧急报警'],
    ['sound', '页面提示音', '新报警到达时播放提示音'],
  ]
  return (
    <div className="page">
      <div className="page-head"><div><h1>系统设置</h1><div className="sub">通知与平台偏好（演示数据，仅保存在本地会话）</div></div></div>
      <Card style={{ maxWidth: 720 }}>
        <h3 className="card-title" style={{ marginBottom: 10 }}>报警通知</h3>
        {rows.map(([k, t, d]) => (
          <div key={k} className="row" style={{ justifyContent: 'space-between', padding: '14px 0', borderTop: '1px solid var(--line-2)' }}>
            <div><b style={{ fontWeight: 600 }}>{t}</b><div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>{d}</div></div>
            <Toggle on={s[k]} onChange={(v) => { setS({ ...s, [k]: v }); toast(`${t}已${v ? '开启' : '关闭'}`) }} />
          </div>
        ))}
      </Card>
    </div>
  )
}
