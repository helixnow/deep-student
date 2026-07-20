/**
 * 移动端基建组件桶导出。
 *
 * ```tsx
 * import { PullToRefresh } from '@/components/mobile';
 * ```
 *
 * ★ 2026-07 收尾清理：TouchTarget / MobileEmptyState 全仓库零消费已移除
 *   （触控热区用 DsButton + `[@media(pointer:coarse)]` 工具类，
 *   空态沿用各业务现有 study-shell-n / wb-fc-empty 模式）。
 */

export { PullToRefresh, type PullToRefreshProps } from './PullToRefresh';
