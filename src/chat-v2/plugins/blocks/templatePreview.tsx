/**
 * Chat V2 - 模板预览块渲染插件
 *
 * 将模板工具（template_get/create/update/fork/preview）的可视化输出
 * 作为独立块直接显示在聊天流中，无需点击展开。
 *
 * 完全复用 TemplateToolOutput 组件的渲染逻辑（CardSide、DiffView、ShadowDomPreview）。
 *
 * 自执行注册：import 即注册
 */

import React from 'react';
import { blockRegistry, type BlockComponentProps } from '../../registry';
import { TemplateToolOutput, isTemplateVisualOutput } from './components';

/**
 * TemplatePreviewBlock - 模板预览独立块组件
 */
const TemplatePreviewBlock: React.FC<BlockComponentProps> = ({ block }) => {
  if (!isTemplateVisualOutput(block.toolOutput)) return null;

  return (
    <div className="rounded-lg border border-border/50 bg-card overflow-hidden p-3">
      <TemplateToolOutput output={block.toolOutput} />
    </div>
  );
};

// ============================================================================
// 自动注册
// ============================================================================

blockRegistry.register('template_preview', {
  type: 'template_preview',
  component: TemplatePreviewBlock,
  onAbort: 'keep-content',
});

export { TemplatePreviewBlock };
