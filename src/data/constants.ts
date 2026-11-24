// 页面用到的固定常量。原先放在 src/mock 里；交付包剔除 src/mock 后页面仍要用，所以单独成文件（无副作用）。

/** 程序编码 → 程序名称. Code 12 (新风单机版) has no room panels / room settings, but has fresh-air 运行设置. */
export const PROGRAMS: Record<number, string> = { 11: '三恒标准版', 12: '新风单机版', 21: '办公楼宇版', 31: '别墅五恒版' }

export const gatewayOf = (projectId: string) => 'GW-' + projectId.slice(4)

/** Modes in which the fresh-air unit supports choosing 露点 or 湿度 control; any other mode is fixed to 湿度控制. */
export const DEW_MODES = [2, 13, 23, 33]
