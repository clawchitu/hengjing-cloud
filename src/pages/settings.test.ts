// @vitest-environment jsdom
// 系统设置（S11）：4 个通知开关没有接口支撑，按 Q12 去掉，只剩空态。
import { cleanup, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import Settings from './Settings'

afterEach(cleanup)

describe('系统设置', () => {
  it('不再有通知开关和「仅保存在本地会话」的说明，显示空态', () => {
    const { container } = render(createElement(Settings))
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('系统设置')
    expect(screen.getByText('当前版本暂无可配置项')).toBeTruthy()
    expect(screen.queryAllByRole('switch')).toHaveLength(0)
    expect(container.textContent).not.toMatch(/短信|企业微信|夜间免打扰|提示音|本地会话|接口/)
  })
})
