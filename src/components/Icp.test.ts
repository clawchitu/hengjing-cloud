// @vitest-environment jsdom
// 备案号只在公司域名下显示（S13 走查 P3）：公司域名、其他域名各测一次；登录页去掉设备数状态条、假备案号和「忘记密码」
import { cleanup, render, screen } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ICP_DEFAULT, resolveConfig, setConfig } from '@/api/config'
import { createQueryClient } from '@/api/query'
import { AppProvider } from '@/app/store'
import Login from '@/pages/Login'
import { ICP_URL, icpFor, IcpLink, SiteFooter } from './Icp'

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
})
afterEach(() => { cleanup(); setConfig(null) })

describe('icpFor', () => {
  it('公司域名（等于 cosyhome.com.cn 或以 .cosyhome.com.cn 结尾）→ 显示默认备案号', () => {
    for (const h of ['cosyhome.com.cn', 'www.cosyhome.com.cn', 'hvac.cosyhome.com.cn', 'HVAC.CosyHome.com.cn']) expect(icpFor(h, ICP_DEFAULT), h).toBe('苏ICP备18008267号-1')
  })
  it('其他域名（hvac-demo、hvac-mock、localhost、仿冒后缀）→ 不显示', () => {
    for (const h of ['hvac-demo.haoqianglyu.com', 'hvac-mock.haoqianglyu.com', 'localhost', '127.0.0.1', 'evilcosyhome.com.cn', 'cosyhome.com.cn.evil.com', ''])
      expect(icpFor(h, ICP_DEFAULT), h).toBeNull()
  })
  it('config.icp 默认值与覆盖：非法值取默认', () => {
    expect(resolveConfig([]).icp).toEqual({ number: '苏ICP备18008267号-1', hosts: ['cosyhome.com.cn'] })
    expect(resolveConfig([{ icp: { number: '浙ICP备1号', hosts: ['example.cn'] } }]).icp).toEqual({ number: '浙ICP备1号', hosts: ['example.cn'] })
    for (const bad of [null, 'x', { number: '', hosts: [] }, { number: 'a' }]) expect(resolveConfig([{ icp: bad }]).icp).toEqual(ICP_DEFAULT)
  })
})

describe('IcpLink / SiteFooter', () => {
  it('公司域名：链接到工信部备案系统，新窗口打开；全站页脚显示', () => {
    render(createElement('div', null, createElement(IcpLink, { hostname: 'hvac.cosyhome.com.cn', prefix: ' · ' }), createElement(SiteFooter, { hostname: 'hvac.cosyhome.com.cn' })))
    const links = screen.getAllByRole('link', { name: '苏ICP备18008267号-1' })
    expect(links).toHaveLength(2)
    for (const a of links) {
      expect(a.getAttribute('href')).toBe(ICP_URL)
      expect(a.getAttribute('target')).toBe('_blank')
      expect(a.getAttribute('rel')).toContain('noopener')
    }
    expect(document.querySelector('footer.site-foot')).not.toBeNull()
  })
  it('其他域名：链接和全站页脚都不渲染（不留空白）', () => {
    const { container } = render(createElement('div', null, createElement(IcpLink, { hostname: 'hvac-demo.haoqianglyu.com', prefix: ' · ' }), createElement(SiteFooter, { hostname: 'hvac-demo.haoqianglyu.com' })))
    expect(container.textContent).toBe('')
    expect(document.querySelector('footer')).toBeNull()
  })
})

describe('登录页（S13 走查 P1、P3）', () => {
  const renderLogin = () => render(createElement(QueryClientProvider, { client: createQueryClient() }, createElement(AppProvider, null, createElement(MemoryRouter, null, createElement(Login)))))
  it('去掉设备数状态条、电话、版本号、忘记密码、假备案号；大标题、功能卡保持原样（强哥 11/25 确认）', () => {
    renderLogin()
    const text = document.body.textContent ?? ''
    for (const s of ['忘记密码', '重置链接', '1,284', '平台运行正常', '沪ICP备2025000000号', '400-820', 'v3.6.2', '技术支持', '平台版本']) expect(text, s).not.toContain(s)
    expect(document.querySelector('.status-chip')).toBeNull()
    expect(screen.getByRole('heading', { level: 2 }).textContent).toContain('让每一个项目的环境都在掌控之中')
    expect(document.querySelectorAll('.feat > div')).toHaveLength(3)
    expect(document.querySelector('.login-ver')).toBeNull()
  })
  it('jsdom 的 localhost 下登录页底部只有版权行，不显示备案号', () => {
    renderLogin()
    expect(document.querySelector('.login-foot')!.textContent).toBe('© 2025 恒境云科技')
    expect(screen.queryByRole('link', { name: /ICP/ })).toBeNull()
  })
})
