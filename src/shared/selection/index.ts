/**
 * 共享划词层：选区检测 hook + 选区操作条。
 *
 * 宿主：聊天气泡（MessageItem）、PDF 阅读器（EnhancedPdfViewer）。
 * 新宿主接入只需 `useTextSelection(contentRef)` + `<SelectionToolbar containerRef={hostRef} …/>`，
 * 并只传自己真的具备的能力回调。
 */
export { useTextSelection } from './useTextSelection';
export type { SelectionRect, TextSelectionState } from './useTextSelection';
export { SelectionToolbar } from './SelectionToolbar';
export type { SelectionToolbarProps } from './SelectionToolbar';
