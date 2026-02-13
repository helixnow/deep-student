/**
 * Chat V2 - 输入栏组件导出
 *
 * V2 架构下的输入栏组件，遵循 SSOT 原则。
 *
 * ## 组件结构
 * - `InputBarV2` - 入口组件，接收 Store，处理状态订阅
 * - `InputBarUI` - 纯展示组件，只通过 props 接收数据
 * - `useInputBarV2` - Hook，订阅 Store 状态并封装 Actions
 *
 * ## 使用示例
 * ```tsx
 * import { InputBarV2 } from '@/chat-v2/components/input-bar';
 *
 * function ChatView({ store }) {
 *   return <InputBarV2 store={store} />;
 * }
 * ```
 *
 * ## Legacy 支持
 * 旧版 `UnifiedSmartInputBar` 已归档到 `UnifiedSmartInputBar.legacy.tsx`
 */

// V2 组件
export { InputBarV2 } from './InputBarV2';
export { InputBarUI } from './InputBarUI';
export { MobileBottomSheet } from './MobileBottomSheet';
export type { MobileBottomSheetProps } from './MobileBottomSheet';

// V2 Hook
export { useInputBarV2, useTogglePanelExclusive } from './useInputBarV2';

// V2 类型
export type {
  InputBarV2Props,
  InputBarUIProps,
  UseInputBarV2Return,
  AttachmentUploadStatus,
  PanelName,
  ModelMentionState,
  ModelMentionActions,
} from './types';

// 模型 @mention 自动完成组件
export { ModelMentionPopover, shouldHandleModelMentionKey } from './ModelMentionPopover';
export type { ModelMentionPopoverProps } from './ModelMentionPopover';

// ★ Legacy 组件已移除（2026-01 清理）：UnifiedSmartInputBar.legacy
