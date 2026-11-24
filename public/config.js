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
window.__HJC_CONFIG__ = {}
