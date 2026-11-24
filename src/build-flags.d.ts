// 构建期常量（vite.config.ts / vitest.config.ts 的 define 注入，打包时按字面量替换）。
// __HJC_MOCK__：是否打进演示数据（src/mock）与演示账号。生产交付包（vite build --mode delivery）为 false，
// 所有 `if (!__HJC_MOCK__)` 之后的演示代码在打包时被当作死代码整段剔除；其他构建（hvac-demo / hvac-mock、
// 开发、测试、e2e）为 true，行为不变。
declare const __HJC_MOCK__: boolean
