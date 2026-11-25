// 本次运行的被测站点：H1_TARGET=local（默认，本机 vite 开发服务器 + 开发代理连测试服）| demo（测试站 hvac-demo）。
// 只接受 policy.ts 里登记的两个源；其他取值直接抛错，不跑任何用例（不连生产）。
import { TEST_API_ORIGIN } from '../src/api/config'
import { TARGET_ORIGINS, type TargetKind } from './policy'

const raw = process.env.H1_TARGET ?? 'local'
if (!Object.hasOwn(TARGET_ORIGINS, raw)) throw new Error(`H1_TARGET 只能是 ${Object.keys(TARGET_ORIGINS).join(' / ')}，收到：${raw}`)
export const TARGET: TargetKind = raw as TargetKind
export const ORIGIN: string = TARGET_ORIGINS[TARGET]

/** 本机目标的开发代理上游：固定测试服，不读 .env 里的 VITE_PROXY_TARGET（进程环境变量优先级最高，见 webServer.env） */
export const LOCAL_PROXY_TARGET = TEST_API_ORIGIN
if (new URL(LOCAL_PROXY_TARGET).hostname !== 'test.cosyhome.com.cn') throw new Error('开发代理上游不是测试服')
