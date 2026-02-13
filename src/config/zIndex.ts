/**
 * 统一 z-index 层级规范
 *
 * 所有移动端/桌面端需要 z-index 的组件应使用此文件的常量，
 * 避免各组件自行定义导致层级冲突。
 *
 * 层级规范（从低到高）：
 *   base (1-50)            → 普通内容层
 *   navbar (50-70)         → 底部导航栏、全屏内容层
 *   inputBar (100-300)     → 输入栏及其子元素
 *   header (1000-1200)     → 顶部导航栏
 *   overlay (2000)         → 侧边栏/抽屉遮罩
 *   drawer (2500)          → 侧边栏/抽屉内容
 *   modal (3000)           → 模态对话框
 *   sheet (4000)           → 底部 Sheet
 *   toast (5000)           → 通知 Toast
 *   imageViewer (6000)     → 全屏图片查看器
 *   contextMenu (9000-9050)→ Portal 右键菜单
 *   topmost (9999)         → 紧急覆盖层（应尽量避免）
 *   tooltip (10000)        → 通用提示气泡
 *   systemTitlebar (2^31)  → 系统级标题栏（最高层级）
 */

export const Z_INDEX = {
  /** 底部导航栏 */
  bottomTabBar: 50,

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

  /** 侧边栏/抽屉遮罩 */
  overlay: 2000,

  /** 侧边栏/抽屉内容 */
  drawer: 2500,

  /** 模态对话框 */
  modal: 3000,

  /** 底部 Sheet（MobileBottomSheet） */
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
