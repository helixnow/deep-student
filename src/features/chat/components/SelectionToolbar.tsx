/**
 * 兼容层：SelectionToolbar 已上移到共享层 `@/shared/selection`。
 *
 * 聊天之外（PDF 阅读器等）也要挂同一套划词工具条，组件因此不再属于 chat feature。
 * 这里只做 re-export，避免一次性改动全部 `../SelectionToolbar` 引用点。
 * 新代码请直接从 `@/shared/selection` 引入。
 */
export type { SelectionToolbarProps } from '@/shared/selection/SelectionToolbar';
export { SelectionToolbar, default } from '@/shared/selection/SelectionToolbar';
