/**
 * Learning Hub 应用面板索引
 *
 * 这些是 Learning Hub 可以启动的"原生应用"。
 * 当用户在 Learning Hub 中点击资源时，会根据资源类型渲染对应的应用面板。
 *
 * 注意：推荐使用统一的 UnifiedAppPanel，它支持所有资源类型。
 */

// 统一应用面板（推荐使用）
export { UnifiedAppPanel, type UnifiedAppPanelProps, type ContentViewProps } from './UnifiedAppPanel';

// ★ 2026-07-08：移除无消费者且类型覆盖过时的 AppType / AppOpenParams
// （只列了 5 类，缺 image/file/mindmap；实际路由类型以 ../types 的 ResourceType 为准。
// 桌面快捷方式的 AppType 定义在 stores/desktopStore.ts，与此无关）
