// 恒境云运行时配置：部署时改这一个文件即可换后端，不用重新构建。
// 不写的项使用构建时的默认值（VITE_API_BASE 等，见 src/api/config.ts）。
//
// apiBase         接口基址。相对路径（如 '/api'）由开发代理 / Worker / nginx 转发到后端；
//                 也可以写完整地址（如 'https://test.cosyhome.com.cn:9443/v1'）。
// apiEnv          'test' | 'prod'。apiBase 是完整地址时按域名判断，此项无效；
//                 相对路径时按此项判断，不写一律当生产环境处理。
// dataSource      'mock'（演示数据）| 'real'（真实接口）。
// writeMode       'test-only'（默认：只在测试环境允许下发）| 'off'（全部拦截）| 'on'（生产环境也允许，须负责人确认）。
// writeProjectCodes 下发白名单，填项目 code（如 '240829001'，不是后端实体 id）。
//                 不写默认 ['260911001', '240829001']；写 [] 即拒绝所有下发。
//                 构建时也可用 VITE_WRITE_PROJECT_CODES（逗号分隔）。
// features        功能开关（对象，按键合并；不写或写了非法值都取默认值）。交付包的 config.js 不写这一项。
//   freshAirWrite          'on'（默认，可下发）| 'off'：写 'off' 时新风运行设置面板只读；写防护照常生效。
//   freshAirFilterWarn     false（默认）| true：滤网寿命的告警颜色和更换提示（阈值按 filter_life_p 的比例）。
//   roomSwitchReported     true（默认）| false：200 的房间开关是否可信。后端已确认真实上报（11/25）；
//                          写 false 时房间开关显示「未知」、核对开关记无法核对、不拿它禁用温度和节能。
//   weatherNowFallback     true（默认）| false：/weather 失败时用小时预报顶替实时数据。
//   例：features: { freshAirWrite: 'off' }
window.__HJC_CONFIG__ = {}
