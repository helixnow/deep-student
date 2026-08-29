/**
 * 兼容层：useTextSelection 已上移到共享层 `@/shared/selection`。
 *
 * 划词工具条现在同时服务聊天与 PDF 阅读器，选区检测不再属于 chat feature。
 * 这里只做 re-export，保留既有 `../hooks/useTextSelection` 引用点与测试 mock 路径。
 * 新代码请直接从 `@/shared/selection` 引入。
 */
export type { SelectionRect, TextSelectionState } from '@/shared/selection/useTextSelection';
export { useTextSelection } from '@/shared/selection/useTextSelection';
