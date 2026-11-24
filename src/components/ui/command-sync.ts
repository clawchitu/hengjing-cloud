// cmdk 弹层的两个小工具（项目切换菜单、顶栏搜索、经销商选择共用）。
import { useEffect } from 'react'

/**
 * 放在弹层内容里：弹层经 Portal 晚一拍挂载，父组件的 effect 看不到它；这里每次渲染后（含挂载）执行一次。
 * 用 useEffect 而不是 useLayoutEffect：挂载那一次，子组件的 layout effect 早于父元素的 ref 绑定
 */
export function AfterRender({ run, onResize = false }: { run: () => void; onResize?: boolean }) {
  useEffect(run)
  // 窗口尺寸变化（含缩放）时也执行一次
  useEffect(() => {
    if (!onResize) return
    window.addEventListener('resize', run)
    return () => window.removeEventListener('resize', run)
  }, [onResize, run])
  return null
}

/** 按 cmdk 选项的 data-value 找选项元素 */
export const itemById = (root: Element | null, v: string) => root?.querySelector<HTMLElement>(`[cmdk-item][data-value="${CSS.escape(v)}"]`) ?? null

/** 组合框 / 列表的 aria-activedescendant 指向当前高亮项（没有高亮时去掉） */
export const setActive = (owner: Element | null, item: HTMLElement | null) => {
  if (item?.id) owner?.setAttribute('aria-activedescendant', item.id)
  else owner?.removeAttribute('aria-activedescendant')
}
