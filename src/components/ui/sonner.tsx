import { Toaster as Sonner, type ToasterProps } from 'sonner'
import { cn } from '@/lib/utils'

/*
 * 轻提示容器（原 store.tsx 手写的 .toasts / .toast）。用 Sonner 管理队列、定时消失、aria-live 播报，外观和排布照旧版：
 * - 顶部居中、距顶 72px，2600ms 后消失，条数不限；
 * - 竖排、间距 8px、旧的在上新的在下（旧版是追加到末尾）。Sonner 默认把多条叠成卡片堆、用绝对定位 + transform 摆位置，
 *   而且新的在最上面；这里改回普通文档流：列表 flex 竖排，Sonner 的数组是新的在前，所以用 column-reverse；
 *   条目取消绝对定位，transform 变量 --y 置空，关掉 Sonner 的 transition（否则它的 0.4s 透明度过渡会盖过入场动画）；
 * - 入场动画照旧（pop .2s，keyframes 在 global.css）；Sonner 自带“减少动态效果”时 animation: none；
 * - 消失时没有退场动画、立即让位（同旧版）：Sonner 删除时先打 data-removed、200ms 后才卸载，这段时间直接隐藏；
 * - 字体继承页面（Sonner 默认给列表设了系统字体）。
 * Sonner 的样式是运行时插入的未分层 CSS，这里的覆盖都用 important 工具类（分层的 important 高于未分层的普通声明）。
 * 单条外观照旧 .toast：白底、1px --line 描边、圆角 10、内边距 10px 16px、阴影 0 8px 28px、13.5px，图标与文字 flex 间距 10px 居中。
 * Sonner 把图标包在 [data-icon] 里、文字包在 [data-content] > [data-title] 里；图标容器设成 flex，让图标像旧版一样作为
 * 块级 flex 项垂直居中（否则包在行盒里会多出行高、位置偏移）。图标和颜色由 store.tsx 传。
 */
function Toaster(props: ToasterProps) {
  return (
    <Sonner
      position="top-center"
      offset={{ top: 72 }}
      gap={8}
      expand
      visibleToasts={Infinity}
      duration={2600}
      // 读屏区域名称用中文；不注册 Alt+T 快捷键（旧版没有）
      containerAriaLabel="通知"
      customAriaLabel="通知"
      hotkey={[]}
      className="flex! w-auto! flex-col-reverse! items-center gap-2 font-[inherit]!"
      toastOptions={{
        unstyled: true,
        className: cn(
          // after:hidden!：Sonner 给展开的条目加了一条向上伸出 gap 高度的透明 ::after（悬停桥），条目改成 static 后它落在
          // 列表上方 y≈63–72 处，会挡住下面的点击并让倒计时暂停
          'static! transition-none! [--y:none]! data-[removed=true]:hidden! after:hidden! animate-[pop_.2s]',
          'flex items-center gap-[10px] rounded-lg border border-solid border-border bg-white px-4 py-[10px] text-[13.5px] shadow-[0_8px_28px_rgba(2,6,23,.16)]',
        ),
        classNames: { icon: 'flex' },
      }}
      {...props}
    />
  )
}

export { Toaster }
