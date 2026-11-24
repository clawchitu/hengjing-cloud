// 房间温控面板（S9）：ctrl 200 读取、209 统计、201 单房间设置、206 全部开关。
// 规则与组装是纯函数（model / edit / stats），数据源分 real / mock（source），页面在 src/pages/Thermostat.tsx。
// 下发（201 / 206）一律走 writes.ts 的状态机（完整状态图见 writes.ts 文件头）：
//   确认 → preflight（持项目锁，新读 200，重新校验并组装，与确认时比对）→ sending（统一写入口）
//        → verifying（写后新读 200）→ done | unknown-locked（禁止再下发，「核对」读取成功后解锁）
//   每个操作带 { projectId, sessionKey, opId }；会话变化后旧操作不向新会话展示、不用新凭据回读，项目锁保持到写结束或 unknown-locked。
export * from './model'
export * from './edit'
export * from './stats'
export * from './source'
export * from './hooks'
export * from './writes'
