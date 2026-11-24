// 系统设置（S11）。演示版的 4 个通知开关（项目离线短信提醒、企业微信通知、夜间免打扰、页面提示音）后端没有接口，
// 也不是能只存在本地的偏好（前三项是服务端推送，提示音依赖的离线告警功能不存在），
// 按负责人 11/24 答复 Q12「没有接口支撑的元素一律隐藏」去掉（方案 1.2「系统设置页的 4 个通知开关」）。
// 整页因此没有内容；按 Q12 入口也应隐藏，但侧栏入口在每张截图里、路由在 main.tsx，另开 PR 处理（排在基线队列队尾，
// 已获赤兔授权改 main.tsx，见 docs/plan-v1.md S11 行），这里先显示中性空态。
import { faGear } from '@fortawesome/free-solid-svg-icons'
import { Icon } from '../components/legacy'
import { Card } from '@/components/ui/card'

export default function Settings() {
  return (
    <div className="page">
      <div className="page-head"><div><h1>系统设置</h1></div></div>
      <Card className="placeholder" role="status">
        <div className="ph-ico"><Icon icon={faGear} /></div>
        <h3>当前版本暂无可配置项</h3>
      </Card>
    </div>
  )
}
