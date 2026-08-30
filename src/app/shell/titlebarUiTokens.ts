/**
 * 全局顶栏内容物统一规格（workbench 窗口标题栏槽位 / legacy 壳标题栏槽位共用）。
 *
 * 对齐既有件：chat 标题栏控件 28×28px（wb-chat-titlebar-sidebar-toggle，px 固定）。
 * 注意本应用 rem 锚点为 14px（typography.css html font-size），h-8=2rem=28px 实际，
 * 而 h-7=1.75rem 仅 24.5px——故统一规格用 h-8 对齐 chat 的 28px 真值；
 * learning-hub titlebarMode 的 !h-7（24.5px）属既有偏差，不在本轮收敛。
 * coarse 指针 h-10（=35px 实际），不溢出 38px 标题栏。
 *
 * 仅用于 portal 进顶栏的内容；页内内联渲染保持各页原有密度（移动端触控 44px 契约不变）。
 */

/** 标题（页面/视图名）：13px 半粗，与窗口标题文字 wb-title-text 同级 */
export const TITLEBAR_TITLE_CLASS = 'truncate text-ui font-semibold text-foreground';

/** 次级信息（计数 / 路径分隔 / 副标题）：12px 弱化 */
export const TITLEBAR_META_CLASS = 'whitespace-nowrap text-xs text-muted-foreground/60';

/** 文本控件（按钮 / 选择器触发器）：实际 28px，coarse 指针 35px */
export const TITLEBAR_CONTROL_CLASS =
  '!h-8 !min-h-0 gap-1.5 !px-2.5 !py-0 text-xs [@media(pointer:coarse)]:!h-10';

/** 图标控件：实际 28px 见方，coarse 指针 35px */
export const TITLEBAR_ICON_CONTROL_CLASS =
  '!h-8 !w-8 !p-1.5 [@media(pointer:coarse)]:!h-10 [@media(pointer:coarse)]:!w-10';

/** 搜索输入：实际 28px，coarse 指针 35px */
export const TITLEBAR_INPUT_CLASS = 'h-8 text-xs [@media(pointer:coarse)]:!h-10';
