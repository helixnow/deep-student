/**
 * Chat V2 - 上下文类型定义 - 选区快照 (Selection)
 *
 * 用户在 PDF / 聊天消息 / 思维导图 / 笔记中划选的内容片段。
 * 快照模式（同 retrieval）：选区文本直接存 resource.data，发送时 formatToBlocks
 * 原样读出，不走 VFS ref 解析（isVfsRefType 不含本类型，自动跳过 resolveVfsRefs）。
 *
 * 优先级: 15（介于 note(10) 与 exam(22) 之间——用户当下指向的内容应优先于整份资源）
 * XML 标签: <selection>
 * 关联工具: 无
 *
 * 设计来源：docs/plans/2026-09-06-canvas-patterns-absorption.md P0
 */

import type { ContextTypeDefinition, Resource, ContentBlock } from '../types';
import { createXmlTextBlock, createTextBlock } from '../types';
import { t } from '@/utils/i18n';
import type { SelectionRefData } from '../selectionRef';

/**
 * 选区来源种类 → 显示标签
 */
function getKindLabel(kind?: SelectionRefData['source']['kind']): string {
  switch (kind) {
    case 'pdf':
      return 'PDF';
    case 'epub':
      return 'EPUB';
    case 'document':
      return 'Document';
    case 'translation':
      return 'Translation';
    case 'mindmap':
      return 'Mindmap';
    case 'note':
      return 'Note';
    case 'message':
      return 'Message';
    default:
      return 'Selection';
  }
}

/**
 * 选区快照类型定义
 */
export const selectionDefinition: ContextTypeDefinition = {
  typeId: 'selection',
  xmlTag: 'selection',
  get label() { return t('contextDef.selection.label', {}, 'chatV2'); },
  labelEn: 'Selection',
  priority: 15,
  tools: [],

  // 注意：按页精确回读依赖该 PDF 已有 OCR 页级数据（无 ocr_pages_json 时
  // builtin-resource_read 回退全量内容），hint 不承诺"可精确回读任意页"。
  systemPromptHint:
    '<selection source="..." source-id="..." locator="page:N">选中内容</selection> - ' +
    '用户在某资源中亲自划选的内容片段，是用户当前注意力的直接指向；' +
    'source-id 可用于 resource_read 等工具回读该资源的更多上下文；' +
    '带 cite 属性时，引用该资料请原样使用 cite 标记（如 [PDF@file_x:3]，用户可点击回到原页），不要写成 [知识库-N]',

  formatToBlocks(resource: Resource): ContentBlock[] {
    let parsed: SelectionRefData | null = null;
    if (resource.data) {
      try {
        parsed = JSON.parse(resource.data) as SelectionRefData;
      } catch {
        parsed = null;
      }
    }

    const source = parsed?.source;
    const attrs: Record<string, string | undefined> = {};

    // source 属性给模型看人读来源（《xxx》第 N 页 / 导图标题 / 会话消息）
    const title = source?.title;
    const locator = source?.locator;
    if (title || locator) {
      attrs.source = [title, locator].filter(Boolean).join(' ');
    } else if (source?.kind) {
      attrs.source = getKindLabel(source.kind);
    }
    if (resource.sourceId) {
      attrs['source-id'] = resource.sourceId;
    }
    if (locator) {
      attrs.locator = locator;
    }
    // PDF 选区：给出页码引用标记。没有它时模型只会套用 [知识库-N]，而这一轮并没有
    // 知识库来源，渲染出来是点了没反应的死徽章
    const pdfSourceId = source?.sourceId ?? resource.sourceId;
    const page = locator?.match(/^page:(\d+)/)?.[1];
    if (source?.kind === 'pdf' && pdfSourceId && page) {
      attrs.cite = `[PDF@${pdfSourceId}:${page}]`;
    }

    const text = parsed?.text ?? resource.data;
    if (!text) {
      return [createTextBlock('<selection>[Content not available]</selection>')];
    }

    return [createXmlTextBlock('selection', text, attrs)];
  },
};

/**
 * 选区类型 ID 常量
 */
export const SELECTION_TYPE_ID = 'selection' as const;
