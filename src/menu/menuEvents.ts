/**
 * macOS 原生菜单事件名常量（与 src-tauri/src/menu.rs 的 EVENT_* 保持同步）。
 *
 * 单独成模块：workbench 等 lazy chunk 也要消费个别事件名，
 * 直接 import menuEventBridge 会把 command palette 依赖链拖进去。
 */

/**
 * File ▸ Close Window（⌘W）。原生 key equivalent 会在 WKWebView 之前吃掉
 * ⌘W，因此该菜单项不再用 PredefinedMenuItem::close_window，而是发事件路由回
 * 前端：menuEventBridge 收到后在 window 上派发同名 cancelable CustomEvent —
 * workbench 桌面激活时由 useWorkbenchShortcuts preventDefault 接管
 * （关闭 workbench 焦点窗口），未被接管则回落关闭原生主窗（历史行为）。
 */
export const MENU_CLOSE_WINDOW_EVENT = 'menu://close-window';
