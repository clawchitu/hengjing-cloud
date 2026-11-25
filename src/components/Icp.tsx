// 备案号（S13 走查 P3）：只在 config.icp.hosts 里的域名下显示（等于其中一个，或以「.它」结尾），链接到工信部备案系统、新窗口打开；
// 其他域名（hvac-demo、hvac-mock、localhost 等）一律不显示。登录页底部和全站页脚共用。
import { getConfig, type IcpConfig } from '@/api/config'

export const ICP_URL = 'https://beian.miit.gov.cn/'

/** 当前域名该显示的备案号；不显示返回 null */
export function icpFor(hostname: string, icp: Readonly<IcpConfig> = getConfig().icp): string | null {
  const h = hostname.trim().toLowerCase().replace(/\.$/, '')
  if (!h || !icp.number) return null
  return icp.hosts.some((d) => h === d || h.endsWith('.' + d)) ? icp.number : null
}

const currentHost = () => (typeof location !== 'undefined' ? location.hostname : '')

/** 备案号链接；当前域名不显示时不渲染任何东西 */
export function IcpLink({ className, hostname = currentHost(), prefix }: { className?: string; hostname?: string; /** 显示时放在链接前面的文字（如分隔符） */ prefix?: string }) {
  const n = icpFor(hostname)
  if (!n) return null
  return <>{prefix}<a className={className} href={ICP_URL} target="_blank" rel="noopener noreferrer">{n}</a></>
}

/** 全站页脚：只有备案号，当前域名不显示时整块不渲染（不留空白） */
export function SiteFooter({ hostname = currentHost() }: { hostname?: string }) {
  if (!icpFor(hostname)) return null
  return <footer className="site-foot"><IcpLink hostname={hostname} /></footer>
}
