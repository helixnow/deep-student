/**
 * Chat V2 - 渲染器组件导出
 *
 * 从旧架构 chat-core/components 复制并适配
 * 所有组件为纯展示组件，不订阅 Store
 */

// ============================================================================
// 组件导出
// ============================================================================

export { StreamingMarkdownRenderer } from './StreamingMarkdownRenderer';
export { MarkdownRenderer, renderMarkdownStatic } from './MarkdownRenderer';
export {
  EnhancedMarkdownRenderer,
  EnhancedStreamingMarkdownRenderer,
} from './EnhancedMarkdownRenderer';
export { CodeBlock } from './CodeBlock';

// ============================================================================
// 类型导出
// ============================================================================

export type { CodeBlockProps } from './CodeBlock';
export type {
  EnhancedMarkdownRendererProps,
  RendererMode,
} from './EnhancedMarkdownRenderer';
