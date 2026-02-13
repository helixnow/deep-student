/**
 * Chat V2 - 上下文类型定义 - 图片 (Image)
 *
 * 图片类型，直接传递给支持视觉的模型
 * ★ 支持注入模式选择（图片/OCR 文本）
 *
 * 优先级: 30
 * XML 标签: <image>
 * 关联工具: 无
 */

import type { ContextTypeDefinition, Resource, ContentBlock, FormatOptions } from '../types';
import { createImageBlock, createTextBlock, createXmlTextBlock } from '../types';
import { t } from '@/utils/i18n';

/**
 * 图片元数据类型
 */
export interface ImageMetadata {
  /** 文件名 */
  name?: string;
  /** MIME 类型 */
  mimeType?: string;
  /** 文件大小（字节） */
  size?: number;
  /** 图片宽度 */
  width?: number;
  /** 图片高度 */
  height?: number;
  /** 描述/alt文本 */
  description?: string;
}

/**
 * 从 MIME 类型获取媒体类型
 */
function getMediaType(mimeType?: string): string {
  if (mimeType && mimeType.startsWith('image/')) {
    return mimeType;
  }
  // 默认为 PNG
  return 'image/png';
}

/**
 * 检查数据是否为 base64 编码
 */
function isBase64(data: string): boolean {
  // 检查是否有 data URL 前缀
  if (data.startsWith('data:')) {
    return true;
  }
  // 简单检查是否为 base64 字符
  const base64Regex = /^[A-Za-z0-9+/]+=*$/;
  return base64Regex.test(data.substring(0, 100));
}

/**
 * 提取 base64 数据（移除 data URL 前缀）
 * 
 * 支持以下格式：
 * 1. 纯 data URL：`data:image/png;base64,iVBORw...`
 * 2. 混合格式（Image + OCR）：`data:image/png;base64,iVBORw...\n\n<image_ocr>文本</image_ocr>`
 * 3. 纯 base64：`iVBORw...`
 */
function extractBase64(data: string): { base64: string; mediaType?: string } {
  // 首先处理混合格式（base64 + XML 标签）
  // 只取第一行作为 base64 数据
  const firstLine = data.split('\n')[0].trim();
  
  if (firstLine.startsWith('data:')) {
    const match = firstLine.match(/^data:([^;]+);base64,(.+)$/);
    if (match) {
      return { mediaType: match[1], base64: match[2] };
    }
  }
  
  // 如果不是 data URL 格式，检查是否是纯 base64
  // 但要排除 XML 标签
  if (!data.includes('<') && !data.includes('>')) {
    return { base64: data };
  }
  
  // 如果包含 XML 标签，尝试提取第一行的纯 base64
  if (!firstLine.includes('<') && !firstLine.includes('>')) {
    return { base64: firstLine };
  }
  
  return { base64: data };
}

/**
 * 图片类型定义
 */
export const imageDefinition: ContextTypeDefinition = {
  typeId: 'image',
  xmlTag: 'image',
  get label() { return t('contextDef.image.label', {}, 'chatV2'); },
  labelEn: 'Image',
  priority: 30,
  tools: [], // 图片无关联工具

  // System Prompt 中的标签格式说明
  // 注意：图片以视觉内容块传递，不需要 XML 标签声明
  get systemPromptHint() { return t('contextDef.image.description', {}, 'chatV2'); },

  formatToBlocks(resource: Resource, options?: FormatOptions): ContentBlock[] {
    const metadata = resource.metadata as ImageMetadata | undefined;
    const injectModes = options?.injectModes;

    // ★ VFS 引用模式：优先使用 _resolvedResources
    const resolved = resource._resolvedResources?.[0];
    if (resolved) {
      // 资源已删除
      if (!resolved.found) {
        return [createTextBlock(`<image name="${resolved.sourceId}">${t('contextDef.image.deleted', {}, 'chatV2')}</image>`)];
      }

      // ★ 图片注入模式处理
      const imageModes = injectModes?.image;
      
      // 确定要注入的内容类型
      // ★ 2026-02 修复：用户选择即生效，后端处理模型能力
      // 空数组视为未设置，使用默认值（默认注入图片）
      const hasImageModes = imageModes && imageModes.length > 0;
      const includeImage = hasImageModes ? imageModes.includes('image') : true; // 默认包含图片
      const includeOcr = hasImageModes ? imageModes.includes('ocr') : false;
      
      console.debug('[ImageDefinition] Image inject modes:', { includeImage, includeOcr });

      const blocks: ContentBlock[] = [];
      const name = (resolved.metadata as ImageMetadata | undefined)?.name || resolved.name || 'image';

      // ★ OCR 诊断日志：打印后端返回的完整数据
      console.log('[OCR_DIAG_FE] formatToBlocks called:', {
        sourceId: resolved.sourceId,
        found: resolved.found,
        hasContent: !!resolved.content,
        contentLen: resolved.content?.length ?? 0,
        contentPreview: resolved.content?.substring(0, 300),
        hasMultimodalBlocks: !!resolved.multimodalBlocks,
        multimodalBlocksCount: resolved.multimodalBlocks?.length ?? 0,
        multimodalBlockTypes: resolved.multimodalBlocks?.map(b => b.type),
        injectModes,
        imageModes,
        includeImage,
        includeOcr,
      });

      // 1. 图片模式：注入原始图片（用户选择即使用，后端处理模型能力）
      if (includeImage) {
        const content = resolved.content || '';
        if (content && isBase64(content)) {
          const { base64, mediaType: extractedMediaType } = extractBase64(content);
          const resolvedMimeType = (resolved.metadata as ImageMetadata | undefined)?.mimeType;
          const mediaType = extractedMediaType || getMediaType(resolvedMimeType);
          blocks.push(createImageBlock(mediaType, base64));
          console.log('[OCR_DIAG_FE] Image block added: mediaType=' + mediaType + ', base64Len=' + base64.length);
        } else {
          console.warn('[OCR_DIAG_FE] Image mode selected but content is not valid base64', {
            hasContent: !!content,
            contentPrefix: content?.substring(0, 50),
          });
        }
      }

      // 2. OCR 模式：注入 OCR 文本
      // 后端返回 OCR 文本的两种可能位置：
      // - resolved.content 中包含 <image_ocr>...</image_ocr> XML 标签
      // - multimodalBlocks 中的 text 类型块
      if (includeOcr) {
        let ocrText = '';

        // 方式 1：从 resolved.content 中提取 <image_ocr> 标签内容（新后端格式）
        const ocrContent = resolved.content || '';
        const ocrMatch = ocrContent.match(/<image_ocr[^>]*>([\s\S]*?)<\/image_ocr>/);
        console.log('[OCR_DIAG_FE] OCR extraction attempt 1 (image_ocr tag):', {
          contentLen: ocrContent.length,
          hasOcrTag: ocrContent.includes('<image_ocr'),
          ocrMatchFound: !!ocrMatch,
          ocrMatchText: ocrMatch?.[1]?.substring(0, 100),
        });
        if (ocrMatch && ocrMatch[1]) {
          ocrText = ocrMatch[1].trim();
        }

        // 方式 2：从 multimodalBlocks 获取 OCR 文本（兼容旧格式）
        if (!ocrText) {
          const ocrBlocks = resolved.multimodalBlocks?.filter(b => b.type === 'text');
          console.log('[OCR_DIAG_FE] OCR extraction attempt 2 (multimodalBlocks):', {
            hasMultimodalBlocks: !!resolved.multimodalBlocks,
            totalBlocks: resolved.multimodalBlocks?.length ?? 0,
            textBlocks: ocrBlocks?.length ?? 0,
            textContent: ocrBlocks?.map(b => b.text?.substring(0, 50)),
          });
          if (ocrBlocks && ocrBlocks.length > 0) {
            ocrText = ocrBlocks.map(b => b.text || '').join('\n').trim();
          }
        }

        if (ocrText) {
          console.log('[OCR_DIAG_FE] OCR text FOUND, injecting: len=' + ocrText.length + ', preview="' + ocrText.substring(0, 100) + '"');
          blocks.push(createXmlTextBlock('image_ocr', ocrText, { name }));
        } else if (!includeImage) {
          // 如果没有 OCR 且不注入图片，返回占位符
          console.warn('[OCR_DIAG_FE] OCR text NOT FOUND and image not included -> showing placeholder. sourceId=' + resolved.sourceId + '. Possible causes: (1) OCR pipeline not yet completed, (2) OCR failed, (3) backend did not return OCR text in content or multimodalBlocks');
          blocks.push(createTextBlock(`<image name="${name}">[图片内容无法显示]</image>`));
        } else {
          console.warn('[OCR_DIAG_FE] OCR text NOT FOUND but image is included, no placeholder needed. sourceId=' + resolved.sourceId);
        }
      }
      
      // 如果没有任何内容，返回占位符
      if (blocks.length === 0) {
        return [createTextBlock(`<image name="${name}">${t('contextDef.image.invalid', {}, 'chatV2')}</image>`)];
      }
      
      return blocks;
    }

    // ★ 统一改造：禁止回退到旧格式，必须使用 VFS 引用模式
    // 如果没有 _resolvedResources，说明数据格式错误
    const name = metadata?.name || resource.sourceId || 'image';
    return [createTextBlock(`<image name="${name}">${t('contextDef.image.vfsError', {}, 'chatV2')}</image>`)];
  },
};

/**
 * 图片类型 ID 常量
 */
export const IMAGE_TYPE_ID = 'image' as const;

/**
 * 支持的图片 MIME 类型
 */
export const SUPPORTED_IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/svg+xml',
] as const;

/**
 * 检查是否为支持的图片类型
 */
export function isSupportedImageType(mimeType: string): boolean {
  return SUPPORTED_IMAGE_TYPES.includes(mimeType as typeof SUPPORTED_IMAGE_TYPES[number]);
}
