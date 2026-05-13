/**
 * Chat V2 - 组件导出
 */

export { ChatContainer } from './ChatContainer';
export type { ChatContainerProps } from './ChatContainer';

export { MessageList } from './MessageList';
export type { MessageListProps } from './MessageList';

export { MessageItem } from './MessageItem';
export type { MessageItemProps } from './MessageItem';

export { BlockRenderer, BlockRendererWithStore } from './BlockRenderer';
export type { BlockRendererProps, BlockRendererWithStoreProps } from './BlockRenderer';

// V2 输入栏（推荐使用）
export { InputBarV2, InputBarUI, useInputBarV2 } from './input-bar';
export type { InputBarV2Props, InputBarUIProps, UseInputBarV2Return } from './input-bar';

// Legacy 输入栏（已废弃，请使用 InputBarV2）
/** @deprecated 使用 InputBarV2 替代 */
export { InputBar } from './InputBar';
/** @deprecated 使用 InputBarV2Props 替代 */
export type { InputBarProps } from './InputBar';

export { AttachmentUploader } from './AttachmentUploader';
export type { AttachmentUploaderProps } from './AttachmentUploader';

export { AttachmentPreview } from './AttachmentPreview';
export type { AttachmentPreviewProps } from './AttachmentPreview';

export { ChatParamsPanel } from './ChatParamsPanel';
export type { ChatParamsPanelProps, ModelConfig } from './ChatParamsPanel';

export { SystemPromptEditor } from './SystemPromptEditor';
export type {
  SystemPromptEditorProps,
  SystemPromptTemplate,
  PromptVariable,
} from './SystemPromptEditor';

// 变体组件（多模型并行）
export {
  VariantStatusIcon,
  VariantSwitcher,
  VariantActions,
  ParallelStreamingView,
} from './Variant';
export type {
  VariantStatusIconProps,
  VariantSwitcherProps,
  VariantActionsProps,
  ParallelStreamingViewProps,
} from './Variant';

// 上下文引用显示组件
export { ContextRefsDisplay, hasContextRefs } from './ContextRefsDisplay';
export type { ContextRefsDisplayProps } from './ContextRefsDisplay';

// Agent 能力增强组件（文档 29）
export { ToolApprovalCard } from './ToolApprovalCard';
export type { ApprovalRequestData, ToolApprovalCardProps } from './ToolApprovalCard';
export { CompletionCard } from './CompletionCard';
export type { CompletionData, CompletionCardProps } from './CompletionCard';
