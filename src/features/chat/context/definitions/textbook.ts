/**
 * Chat V2 - 上下文类型定义 - 教材 (Textbook)
 *
 * 教材引用类型，用于学习资源管理器中的教材引用节点
 *
 * 优先级: 25 (介于 card(20) 和 image(30) 之间)
 * XML 标签: <textbook>
 * 关联工具: 无（教材为只读引用，不支持工具调用）
 */

import type { ContextTypeDefinition, Resource, ContentBlock, FormatOptions } from '../types';
import { createXmlTextBlock } from '../types';
import type { MultimodalContentBlock } from '../vfsRefTypes';
import { t } from '@/utils/i18n';

/**
 * 将 MultimodalContentBlock 转换为 ContentBlock
 */
function convertMultimodalBlock(block: MultimodalContentBlock): ContentBlock {
  if (block.type === 'image' && block.mediaType && block.base64) {
    return {
      type: 'image',
      mediaType: block.mediaType,
      base64: block.base64,
    };
  }
  // 文本块
  return {
    type: 'text',
    text: block.text || '',
  };
}

function escapeXmlContent(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildPdfRefTag(sourceId: string, pageNumber: number): string {
  return `[PDF@${sourceId}:${pageNumber}]`;
}

function buildPdfPageLabel(name: string, sourceId: string, pageNumber: number): string {
  return `${buildPdfRefTag(sourceId, pageNumber)} ${name} 第${pageNumber}页`;
}

function createPdfMetaBlock(name: string, sourceId: string, totalPages?: number): ContentBlock {
  const attrs: Record<string, string | undefined> = { name, source_id: sourceId };
  if (typeof totalPages === 'number' && totalPages > 0) {
    attrs.total_pages = String(totalPages);
  }
  const example = buildPdfRefTag(sourceId, 1);
  return createXmlTextBlock(
    'pdf_meta',
    `引用该 PDF 请使用格式：${example}（示例：${example}）。输出时必须包含页码。`,
    attrs
  );
}

function createPdfPageLabelBlock(name: string, sourceId: string, pageNumber: number): ContentBlock {
  return createXmlTextBlock(
    'pdf_page',
    buildPdfPageLabel(name, sourceId, pageNumber),
    { name, source_id: sourceId, page: String(pageNumber) }
  );
}

function formatPdfPageText(
  name: string,
  sourceId: string,
  pageNumber: number,
  text: string,
  escapeText: boolean
): string {
  const content = escapeText ? escapeXmlContent(text.trim()) : text.trim();
  const label = escapeXmlContent(buildPdfPageLabel(name, sourceId, pageNumber));
  return `<pdf_page name="${escapeXmlAttr(name)}" source_id="${escapeXmlAttr(sourceId)}" page="${pageNumber}">${label}\n${content}</pdf_page>`;
}

function formatPdfTextWithPageMarkers(name: string, sourceId: string, text: string): string {
  const parts = text
    .split('\u000C')
    .map(part => part.trim())
    .filter(Boolean);
  const pages = parts.length > 0 ? parts : [text.trim()];
  return pages
    .map((pageText, index) => formatPdfPageText(name, sourceId, index + 1, pageText, true))
    .join('\n\n');
}

function shouldWrapPdfText(text: string): boolean {
  return !/<pdf_(page|ocr|meta)\b/i.test(text);
}

/**
 * 教材元数据类型
 */
export interface TextbookMetadata {
  /** 教材标题 */
  title?: string;
  /** 作者/出版社 */
  author?: string;
  /** ISBN */
  isbn?: string;
  /** 页码范围（如引用特定章节） */
  pageRange?: string;
  /** 章节标题 */
  chapter?: string;
  /** 文件夹路径（真实路径） */
  folderPath?: string;
}

/**
 * 教材类型定义
 */
export const textbookDefinition: ContextTypeDefinition = {
  typeId: 'textbook',
  xmlTag: 'textbook',
  get label() { return t('contextDef.textbook.label', {}, 'chatV2'); },
  labelEn: 'Textbook',
  priority: 25,
  tools: [], // 教材为只读引用，不关联工具

  // System Prompt 中的标签格式说明
  systemPromptHint:
    '<textbook title="..." chapter="..." path="...">教材内容</textbook> - ' +
    '用户引用的教材资源，包含教材标题和章节内容',

  formatToBlocks(resource: Resource, options?: FormatOptions): ContentBlock[] {
    const { isMultimodal = false } = options ?? {};

    // ★★★ VFS 引用模式（强制，禁止回退）★★★
    const resolved = resource._resolvedResources?.[0];

    if (resolved) {
      // 资源已被删除
      if (!resolved.found) {
        return [createXmlTextBlock('textbook', t('contextDef.textbook.deleted', {}, 'chatV2'), {
          'textbook-id': resolved.sourceId,
          status: 'not-found',
        })];
      }

      const resolvedMetadata = resolved.metadata as TextbookMetadata | undefined;
      const sourceId = resolved.sourceId || resource.sourceId || resource.id;
      const name = resolvedMetadata?.title || resolved.name || '';

      // ★★★ 多模态模式：使用预先获取的 multimodalBlocks（按页图片）
      if (isMultimodal && resolved.multimodalBlocks && resolved.multimodalBlocks.length > 0) {
        console.debug('[TextbookDefinition] Using multimodal blocks, count:', resolved.multimodalBlocks.length);
        const blocks: ContentBlock[] = [];
        blocks.push(createPdfMetaBlock(name, sourceId));

        const multimodalBlocks = resolved.multimodalBlocks;
        const hasPdfPageLabels = multimodalBlocks.some(
          block => block.type === 'text' && block.text?.trim().startsWith('<pdf_page')
        );
        const imageOnlyBlocks = multimodalBlocks.filter(b => b.type === 'image');
        if (hasPdfPageLabels) {
          multimodalBlocks.forEach((block) => {
            if (block.type === 'image') {
              blocks.push(convertMultimodalBlock(block));
            } else if (block.type === 'text' && block.text?.trim().startsWith('<pdf_page')) {
              blocks.push(convertMultimodalBlock(block));
            }
          });
        } else if (imageOnlyBlocks.length > 0) {
          imageOnlyBlocks.forEach((block, index) => {
            const pageNumber = index + 1;
            blocks.push(createPdfPageLabelBlock(name, sourceId, pageNumber));
            blocks.push(convertMultimodalBlock(block));
          });
        }

        return blocks;
      }

      // ★ 文本模式：使用实时解析的内容和路径（文档28改造：使用真实路径，移除 subject）
      const content = resolved.content || '';
      const formatted = content && shouldWrapPdfText(content)
        ? formatPdfTextWithPageMarkers(name, sourceId, content)
        : content;
      const textBlocks: ContentBlock[] = [createPdfMetaBlock(name, sourceId)];
      if (formatted) {
        textBlocks.push(createXmlTextBlock('textbook', formatted, {
          title: name,
          chapter: resolvedMetadata?.chapter,
          'page-range': resolvedMetadata?.pageRange,
          'textbook-id': resolved.sourceId,
          path: resolved.path, // ★ 真实文件夹路径
        }));
      } else {
        textBlocks.push(createXmlTextBlock('textbook', t('contextDef.textbook.vfsError', { name }, 'chatV2'), {
          'textbook-id': resolved.sourceId,
          status: 'error',
        }));
      }
      return textBlocks;
    }

    // ★★★ 禁止回退：VFS 类型必须有 _resolvedResources ★★★
    const metadata = resource.metadata as TextbookMetadata | undefined;
    const name = metadata?.title || resource.sourceId || 'textbook';
    return [createXmlTextBlock('textbook', t('contextDef.textbook.vfsError', { name }, 'chatV2'), {
      'textbook-id': resource.sourceId,
      status: 'error',
    })];
  },
};

/**
 * 教材类型 ID 常量
 */
export const TEXTBOOK_TYPE_ID = 'textbook' as const;

/**
 * 教材关联的工具 ID 列表（空，教材为只读）
 */
export const TEXTBOOK_TOOLS: readonly string[] = [] as const;
