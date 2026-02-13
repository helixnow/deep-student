/**
 * Chat V2 - 上下文类型定义 - 文件附件 (File)
 *
 * 通用文件附件类型，内容以文本形式注入
 * ★ 支持 PDF 多模态注入模式选择（图片/OCR/文本）
 *
 * 优先级: 30
 * XML 标签: <attachment>
 * 关联工具: 无
 */

import type { ContextTypeDefinition, Resource, ContentBlock, FormatOptions } from '../types';
import { createXmlTextBlock, createTextBlock, createImageBlock } from '../types';
import { t } from '@/utils/i18n';
import type { MultimodalContentBlock } from '../vfsRefTypes';

/**
 * 文件元数据类型
 */
export interface FileMetadata {
  /** 文件名 */
  name?: string;
  /** MIME 类型 */
  mimeType?: string;
  /** 文件大小（字节） */
  size?: number;
  /** 文件扩展名 */
  extension?: string;
}

/**
 * 格式化文件大小为可读字符串
 */
function formatFileSize(bytes?: number): string {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  return `${size.toFixed(1)} ${units[unitIndex]}`;
}

/**
 * 将多模态内容块转换为 ContentBlock
 */
function convertMultimodalBlock(block: MultimodalContentBlock): ContentBlock {
  if (block.type === 'image') {
    // MultimodalContentBlock (vfsRefTypes) uses a flat shape: { mediaType, base64 }.
    if (block.mediaType && block.base64) {
      return createImageBlock(block.mediaType, block.base64);
    }
    // Fallback: avoid crashing the prompt builder on malformed blocks.
    return createTextBlock(block.text || '');
  }
  return createTextBlock(block.text || '');
}

/**
 * 检查文件是否为 PDF
 */
function isPdfFile(name: string, mimeType?: string): boolean {
  return mimeType === 'application/pdf' || name.toLowerCase().endsWith('.pdf');
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
  const ocrPages = splitPdfTextByOcrHeaders(text);
  if (ocrPages && ocrPages.length > 0) {
    return ocrPages
      .map(page => formatPdfPageText(name, sourceId, page.pageNumber, page.text, true))
      .join('\n\n');
  }
  const parts = text
    .split('\u000C')
    .map(part => part.trim())
    .filter(Boolean);
  const pages = parts.length > 0 ? parts : [text.trim()];
  return pages
    .map((pageText, index) => formatPdfPageText(name, sourceId, index + 1, pageText, true))
    .join('\n\n');
}

function splitPdfTextByOcrHeaders(
  text: string
): Array<{ pageNumber: number; text: string }> | null {
  const regex = /---\s*第\s*(\d+)\s*页\s*---/g;
  let match: RegExpExecArray | null;
  const pages: Array<{ pageNumber: number; text: string }> = [];
  let lastContentStart = 0;

  while ((match = regex.exec(text)) !== null) {
    const pageNumber = Number(match[1]);
    if (!Number.isFinite(pageNumber) || pageNumber <= 0) {
      continue;
    }
    if (pages.length > 0) {
      pages[pages.length - 1].text = text.slice(lastContentStart, match.index).trim();
    }
    pages.push({ pageNumber, text: '' });
    lastContentStart = match.index + match[0].length;
  }

  if (pages.length === 0) return null;

  pages[pages.length - 1].text = text.slice(lastContentStart).trim();
  return pages.filter(page => page.text.length > 0);
}

function parseOcrPageBlock(text: string): { pageNumber: number; text: string } | null {
  const match = text.match(/<page\s+number="(\d+)"\s*>([\s\S]*?)<\/page>/i);
  if (!match) return null;
  const pageNumber = Number(match[1]);
  if (!Number.isFinite(pageNumber) || pageNumber <= 0) return null;
  return { pageNumber, text: match[2] ?? '' };
}

function stripPdfOcrBlocks(text: string): string {
  return text.replace(/<pdf_ocr[^>]*>[\s\S]*?<\/pdf_ocr>/gi, '').trim();
}

function shouldWrapPdfText(text: string): boolean {
  return !/<pdf_(page|ocr|meta)\b/i.test(text);
}

function extractPdfOcrFromContent(content?: string): string | null {
  if (!content) return null;
  const matches = Array.from(content.matchAll(/<pdf_ocr[^>]*>([\s\S]*?)<\/pdf_ocr>/gi))
    .map(match => (match[1] ?? '').trim())
    .filter(Boolean);
  if (matches.length === 0) return null;
  return matches.join('\n\n');
}

/**
 * 文件附件类型定义
 */
export const fileDefinition: ContextTypeDefinition = {
  typeId: 'file',
  xmlTag: 'attachment',
  get label() { return t('contextDef.file.label', {}, 'chatV2'); },
  labelEn: 'Attachment',
  priority: 30,
  tools: [], // 文件无关联工具

  // System Prompt 中的标签格式说明
  systemPromptHint:
    '<attachment name="..." type="..." size="...">文件内容</attachment> - ' +
    '用户上传的文件附件，包含文件名、类型和文本内容',

  formatToBlocks(resource: Resource, options?: FormatOptions): ContentBlock[] {
    const metadata = resource.metadata as FileMetadata | undefined;
    const injectModes = options?.injectModes;

    // ★ PDF 多模态调试日志
    console.log('[FileDefinition] formatToBlocks START', {
      resourceId: resource.id,
      injectModes,
      hasResolvedResources: !!resource._resolvedResources?.length,
    });

    // ★ VFS 引用模式：优先使用 _resolvedResources
    const resolved = resource._resolvedResources?.[0];
    if (resolved) {
      // 资源已删除
      if (!resolved.found) {
        return [createTextBlock(`<attachment name="${resolved.sourceId}">${t('contextDef.file.deleted', {}, 'chatV2')}</attachment>`)];
      }

      // 使用解析后的内容
      const resolvedMetadata = resolved.metadata as FileMetadata | undefined;
      const name = resolvedMetadata?.name || resolved.name || 'file';
      const mimeType = resolvedMetadata?.mimeType;
      const size = resolvedMetadata?.size;
      const sourceId = resolved.sourceId || resource.sourceId || resource.id;

      // ★ PDF 注入模式处理
      if (isPdfFile(name, mimeType)) {
        const pdfModes = injectModes?.pdf;
        
        // 确定要注入的内容类型
        // 空数组视为未设置，使用默认值
        const hasPdfModes = pdfModes && pdfModes.length > 0;
        let includeImage = hasPdfModes ? pdfModes.includes('image') : false;
        let includeOcr = hasPdfModes ? pdfModes.includes('ocr') : false;
        let includeText = hasPdfModes ? pdfModes.includes('text') : true; // 默认包含文本
        
        // ★ 2026-02 修复：移除前端 isMultimodal 判断，用户选择了图片就用图片
        // 后端在实际调用 LLM 时会根据模型能力处理（非多模态模型会忽略图片）
        
        console.log('[FileDefinition] PDF inject modes DECISION:', { 
          includeImage, 
          includeOcr, 
          includeText, 
          hasMultimodalBlocks: !!resolved.multimodalBlocks,
          multimodalBlocksCount: resolved.multimodalBlocks?.length ?? 0,
        });
        
        const blocks: ContentBlock[] = [];
        
        // 0. PDF 元信息：用于引用格式与页码说明
        blocks.push(createPdfMetaBlock(name, sourceId));

        // 1. 图片模式：只转换 type === 'image' 的块（排除 OCR 文本块）
        if (includeImage && resolved.multimodalBlocks && resolved.multimodalBlocks.length > 0) {
          const multimodalBlocks = resolved.multimodalBlocks;
          const hasPdfPageLabels = multimodalBlocks.some(
            block => block.type === 'text' && block.text?.trim().startsWith('<pdf_page')
          );
          const imageOnlyBlocks = multimodalBlocks.filter(b => b.type === 'image');
          console.log('[FileDefinition] ✅ USING IMAGE BLOCKS:', imageOnlyBlocks.length, '/', multimodalBlocks.length);
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
        } else if (includeImage) {
          console.warn('[FileDefinition] ❌ Image mode requested but no multimodal blocks available');
        }
        
        // 2. OCR 模式：从 multimodalBlocks 中获取 OCR 文本块
        if (includeOcr) {
          const ocrBlocks = resolved.multimodalBlocks?.filter(b => b.type === 'text');
          if (ocrBlocks && ocrBlocks.length > 0) {
            const ocrPages: string[] = [];
            ocrBlocks.forEach((block, index) => {
              const raw = block.text || '';
              if (!raw.trim()) return;
              if (raw.trim().startsWith('<pdf_page')) return;
              const parsed = parseOcrPageBlock(raw);
              const pageNumber = parsed?.pageNumber ?? (index + 1);
              const pageText = parsed?.text ?? raw;
              const pageContent = formatPdfPageText(
                name,
                sourceId,
                pageNumber,
                pageText,
                !parsed
              );
              ocrPages.push(pageContent);
            });
            const ocrText = ocrPages.join('\n\n').trim();
            if (ocrText) {
              const ocrAttrs: Record<string, string | undefined> = { name, source_id: sourceId };
              if (mimeType) ocrAttrs.type = mimeType;
              blocks.push(createXmlTextBlock('pdf_ocr', ocrText, ocrAttrs));
            }
          } else {
            const fallbackOcr = extractPdfOcrFromContent(resolved.content);
            if (fallbackOcr) {
              const formatted = shouldWrapPdfText(fallbackOcr)
                ? formatPdfTextWithPageMarkers(name, sourceId, fallbackOcr)
                : fallbackOcr;
              const ocrAttrs: Record<string, string | undefined> = { name, source_id: sourceId };
              if (mimeType) ocrAttrs.type = mimeType;
              blocks.push(createXmlTextBlock('pdf_ocr', formatted, ocrAttrs));
            }
          }
        }
        
        // 3. 文本模式：使用解析的文本内容
        if (includeText || (!includeImage && !includeOcr)) {
          let content = resolved.content || '';
          if (includeOcr && content) {
            content = stripPdfOcrBlocks(content);
          }
          if (content) {
            const attrs: Record<string, string | undefined> = { name };
            if (mimeType) attrs.type = mimeType;
            if (size) attrs.size = formatFileSize(size);
            
            const MAX_TEXT_LENGTH = 100 * 1024;
            let displayContent = content;
            if (displayContent.length > MAX_TEXT_LENGTH) {
              displayContent = displayContent.substring(0, MAX_TEXT_LENGTH);
              const formatted = shouldWrapPdfText(displayContent)
                ? formatPdfTextWithPageMarkers(name, sourceId, displayContent)
                : displayContent;
              blocks.push(createXmlTextBlock('attachment', formatted, attrs));
              blocks.push(createTextBlock(`[Note: File content truncated. Original size: ${formatFileSize(size)}]`));
            } else {
              const formatted = shouldWrapPdfText(displayContent)
                ? formatPdfTextWithPageMarkers(name, sourceId, displayContent)
                : displayContent;
              blocks.push(createXmlTextBlock('attachment', formatted, attrs));
            }
          }
        }
        
        // 如果没有任何内容，返回占位符
        const hasPdfContent = blocks.length > 1;
        if (!hasPdfContent) {
          console.warn('[FileDefinition] PDF returned empty blocks', {
            name,
            includeImage,
            includeOcr,
            includeText,
            hasContent: !!resolved.content,
            hasMultimodalBlocks: !!(resolved.multimodalBlocks && resolved.multimodalBlocks.length > 0),
          });
          return [createTextBlock(`<attachment name="${name}">${t('contextDef.file.invalid', {}, 'chatV2')}</attachment>`)];
        }
        
        return blocks;
      }

      // 非 PDF 文件：使用原有逻辑
      // 构建属性
      const attrs: Record<string, string | undefined> = { name };
      if (mimeType) attrs.type = mimeType;
      if (size) attrs.size = formatFileSize(size);

      const content = resolved.content || '';
      if (!content) {
        return [createTextBlock(`<attachment name="${name}">${t('contextDef.file.invalid', {}, 'chatV2')}</attachment>`)];
      }

      // 对于特别大的文件，可能需要截断
      const MAX_TEXT_LENGTH = 100 * 1024;
      let displayContent = content;
      let truncated = false;

      if (displayContent.length > MAX_TEXT_LENGTH) {
        displayContent = displayContent.substring(0, MAX_TEXT_LENGTH);
        truncated = true;
      }

      const blocks: ContentBlock[] = [createXmlTextBlock('attachment', displayContent, attrs)];
      if (truncated) {
        blocks.push(createTextBlock(`[Note: File content truncated. Original size: ${formatFileSize(size)}]`));
      }
      return blocks;
    }

    // ★ 统一改造：禁止回退到旧格式，必须使用 VFS 引用模式
    // 如果没有 _resolvedResources，说明数据格式错误
    const name = metadata?.name || resource.sourceId || 'file';
    return [createTextBlock(`<attachment name="${name}">${t('contextDef.file.vfsError', {}, 'chatV2')}</attachment>`)];
  },
};

/**
 * 文件类型 ID 常量
 */
export const FILE_TYPE_ID = 'file' as const;

/**
 * 支持的文本文件 MIME 类型
 */
export const SUPPORTED_TEXT_FILE_TYPES = [
  'text/plain',
  'text/markdown',
  'text/html',
  'text/css',
  'text/javascript',
  'application/json',
  'application/xml',
  'text/xml',
  'text/csv',
  'application/rtf',
  'text/rtf',
  'application/epub+zip',
] as const;

/**
 * 检查是否为支持的文本文件类型
 */
export function isSupportedTextFileType(mimeType: string): boolean {
  return (
    SUPPORTED_TEXT_FILE_TYPES.includes(mimeType as typeof SUPPORTED_TEXT_FILE_TYPES[number]) ||
    mimeType.startsWith('text/')
  );
}
