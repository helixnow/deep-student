/**
 * 主题解析 hook 的样式层入口（W06 契约位置）。
 *
 * 实现位于 hooks/useMindMapTheme.ts（useSyncExternalStore 订阅
 * StyleRegistry 的 html.dark MutationObserver 与注册变更通知）。
 * 消费方从 '../styles/useMindMapTheme' 或 '../styles' 导入均可：
 *
 *   const theme = useMindMapTheme(styleId);   // 暗色感知 IStyleTheme
 *   const isDark = useMindMapDarkMode();      // 配合 getQuickBgColors(isDark) 等选色板函数
 */
export { useMindMapTheme, useMindMapDarkMode } from '../hooks/useMindMapTheme';
