/**
 * 统一 z-index 层级规范
 *
 * 所有移动端/桌面端需要 z-index 的组件应使用此文件的常量，
 * 避免各组件自行定义导致层级冲突。
 *
 * 层级规范（从低到高）：
 *   base (1-50)            → 普通内容层
 *   fullscreen (70)        → 全屏内容层
 *   inputBar (100-300)     → 输入栏及其子元素
 *   header (1000-1200)     → 顶部导航栏
 *   overlay (2000)         → 侧边栏/抽屉遮罩
 *   drawer (2500)          → 侧边栏/抽屉内容
 *   modal (3000)           → 模态对话框
 *   sheet (4000)           → 底部 Sheet
 *   toast (5000)           → 通知 Toast
 *   imageViewer (6000)     → 全屏图片查看器
 *   contextMenu (9000-9050)→ Portal 右键菜单
 *   topmost (9999)         → 紧急覆盖层（应尽量避免；注意 tooltip 在其上，
 *                            命名中的 "topmost" 仅指内容层，不含提示气泡）
 *   tooltip (10000)        → 通用提示气泡
 *   systemTitlebar (2^31)  → 系统级标题栏（最高层级）
 *
 * ⚠️ CSS 侧镜像：src/styles/theme-colors.css 的 --z-* 变量（Tailwind z-modal /
 * z-toast 等工具类的数值来源）必须与本表对齐。修改任一档位时请同步两处并
 * grep 消费方（2026-07 移动端审计 H-2：两表失同步曾导致 toast 被 modal 盖住）。
 */

export const Z_INDEX = {
  /** 全屏内容层（覆盖主内容，低于输入栏） */
  fullscreenContent: 70,

  /** 输入栏容器 */
  inputBar: 100,
  /** 输入栏内弹出菜单（@mention 等） */
  inputBarPopover: 150,
  /** 输入栏内部输入框 */
  inputBarInner: 200,
  /** 输入栏拖拽遮罩 */
  inputBarDragOverlay: 300,

  /** Popover 弹出菜单（Portal 模式） */
  popover: 1000,

  /** 移动端顶部导航栏 */
  mobileHeader: 1100,

  /** 桌面端标题栏 */
  desktopTitlebar: 1100,

  /** 输入栏组合面板（附件/模型等，需覆盖移动顶栏，低于抽屉遮罩） */
  composerPanel: 1150,

  /** 侧边栏/抽屉遮罩 */
  overlay: 2000,

  /** 侧边栏/抽屉内容。
   *  ⚠️ 当前无直接 TS 消费方（移动统一抽屉走 MobileSlidingLayout 的局部
   *  stacking context，层级契约见 tests/vitest/chatV2MobileSidebarLayerContract）。
   *  保留作阶梯锚点：overlay(2000) < drawer < modal(3000)。 */
  drawer: 2500,

  /** 模态对话框 */
  modal: 3000,

  /** 底部/侧边 Sheet（shad/Sheet.tsx 遮罩+内容同档；Sheet 内的 Portal
   *  下拉如 shad/Select 用 sheet+10 压过本档） */
  sheet: 4000,

  /** 通知 Toast */
  toast: 5000,

  /** 全屏图片查看器 */
  imageViewer: 6000,

  /** 右键菜单遮罩（Portal 渲染） */
  contextMenuBackdrop: 9000,

  /** 右键菜单（Portal 渲染） */
  contextMenu: 9050,

  /** 通用提示气泡（tooltip） */
  tooltip: 10000,

  /** 紧急覆盖层（仅用于极端情况） */
  topmost: 9999,

  /** 系统级标题栏（最高层级，macOS 虚拟标题栏） */
  systemTitlebar: 2147483000,
} as const;

export default Z_INDEX;
