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
 * 提取 base64 数据（移除 data URL 前缀和混入的 OCR 文本）
 * 
 * 支持以下格式：
 * 1. 纯 data URL：`data:image/png;base64,iVBORw...`
 * 2. 混合格式（Image + OCR）：`iVBORw...<image_ocr>文本</image_ocr>`（后端拼接，可能无换行符）
 * 3. 纯 base64：`iVBORw...`
 */
function extractBase64(data: string): { base64: string; mediaType?: string } {
  // 关键：先截断 <image_ocr> 标签及其后续内容，确保 base64 数据干净
  const ocrTagIndex = data.indexOf('<image_ocr');
  const cleanData = ocrTagIndex >= 0 ? data.substring(0, ocrTagIndex).trim() : data;

  if (cleanData.startsWith('data:')) {
    const match = cleanData.match(/^data:([^;]+);base64,(.+)$/s);
    if (match) {
      return { mediaType: match[1], base64: match[2] };
    }
  }

  return { base64: cleanData };
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
      // ★ 2026-02-13 修复：纯文本模型不注入 image 块，强制回退到 OCR 文本
      // 空数组视为未设置，使用默认值（默认注入图片）
      const hasImageModes = imageModes && imageModes.length > 0;
      const isMultimodal = options?.isMultimodal !== false;
      // ★ 与后端 SSOT resolve_image_inject_modes 对齐：
      //   默认最大化 (image + ocr)；非多模态模型自动降级移除 image。
      const includeImage = isMultimodal
        ? (hasImageModes ? imageModes.includes('image') : true)
        : false; // 纯文本模型：绝不注入 image 块
      const includeOcr = !isMultimodal
        ? true // 纯文本模型：始终注入 OCR 文本作为回退
        : (hasImageModes ? imageModes.includes('ocr') : true); // ★ P0-1 修复：默认注入 OCR（与后端 SSOT 对齐）
      
      const blocks: ContentBlock[] = [];
      const name = (resolved.metadata as ImageMetadata | undefined)?.name || resolved.name || 'image';

      console.debug('[ImageDef]', resolved.sourceId, { isMultimodal, includeImage, includeOcr, contentLen: resolved.content?.length ?? 0 });

      // 1. 图片模式：注入原始图片（仅多模态模型）
      if (includeImage) {
        const content = resolved.content || '';
        if (content && isBase64(content)) {
          const { base64, mediaType: extractedMediaType } = extractBase64(content);
          const resolvedMimeType = (resolved.metadata as ImageMetadata | undefined)?.mimeType;
          const mediaType = extractedMediaType || getMediaType(resolvedMimeType);
          blocks.push(createImageBlock(mediaType, base64));
        } else {
          console.warn('[ImageDef] Image mode but invalid base64:', resolved.sourceId);
        }
      }

      // 2. OCR 模式：注入 OCR 文本
      // 来源优先级：content 中 <image_ocr> 标签 > multimodalBlocks 中的 text 块
      if (includeOcr) {
        let ocrText = '';

        // 方式 1：从 resolved.content 中提取 <image_ocr> 标签内容
        const ocrContent = resolved.content || '';
        const ocrMatch = ocrContent.match(/<image_ocr[^>]*>([\s\S]*?)<\/image_ocr>/);
        if (ocrMatch && ocrMatch[1]) {
          ocrText = ocrMatch[1].trim();
        }

        // 方式 2：从 multimodalBlocks 获取 OCR 文本（兼容旧格式）
        if (!ocrText) {
          const ocrBlocks = resolved.multimodalBlocks?.filter(b => b.type === 'text');
          if (ocrBlocks && ocrBlocks.length > 0) {
            ocrText = ocrBlocks.map(b => b.text || '').join('\n').trim();
          }
        }

        if (ocrText) {
          console.debug('[ImageDef] OCR injected:', resolved.sourceId, 'len=' + ocrText.length);
          blocks.push(createXmlTextBlock('image_ocr', ocrText, { name }));
        } else if (!includeImage) {
          // OCR 不可用且无图片 → 告知模型，同时提示可能原因
          console.warn('[ImageDef] OCR unavailable, no image fallback:', resolved.sourceId);
          // ★ P1-4 修复（二轮审阅）：使用 <ocr_status> 标签而非 <image>，避免模型误解为实际图片内容
          blocks.push(createTextBlock(
            `<ocr_status name="${name}" status="unavailable">[用户上传了一张图片「${name}」，但图片文字识别（OCR）尚未完成或失败，暂时无法获取图片中的文字内容。请告知用户稍后重试。]</ocr_status>`
          ));
        } else {
          // ★ N2 修复：OCR 不可用但有图片 → 仍插入占位提示，不再静默丢弃
          // 用户显式选择了 OCR 模式，应告知模型 OCR 尚未就绪
          console.warn('[ImageDef] OCR unavailable but image block present, adding placeholder:', resolved.sourceId);
          // ★ P1-4 修复（二轮审阅）：使用 <ocr_status> 标签而非 <image_ocr>，避免模型将状态信息当作实际 OCR 结果
          blocks.push(createTextBlock(
            `<ocr_status name="${name}" status="pending">[图片「${name}」的文字识别（OCR）尚未完成，上方已提供图片原图供直接分析。]</ocr_status>`
          ));
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
