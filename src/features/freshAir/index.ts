// 新风页（S10）：ctrl 202 读取设备状态、210 读取运行设置（S10a，只读）。
// 规则与映射是纯函数（model / filter），数据源分 real / mock（source），hooks 接 TanStack Query。
// 页面接入在 S10b；204 下发（S10c）：编辑规则与组装在 edit.ts（build204 是唯一的组装点），流程在 writes.ts（复用温控的 runOp），
// 写锁核对在 lockVerify.ts（核对器由 src/app/writeLockSetup.ts 注册）。
export * from './filter'
export * from './model'
export * from './source'
export * from './hooks'
export * from './edit'
export * from './lockVerify'
export * from './writes'
