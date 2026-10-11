/**
 * Chat V2 - 消息图片预览资源（缩略图 + 原图 blob URL）
 *
 * 用户消息里的图片引用只在 64×64 的格子里显示（ContextRefsDisplay），点开才看原图。
 * 旧实现把 VFS 返回的整张原图 base64 直接拼成 data URL 同时塞进 React state 与
 * <img src>：手机照片 4MB → 5.5MB 字符串常驻内存，浏览器还要按原始分辨率解码
 * （4000×3000 ≈ 48MB 位图）来画一个 64px 的框。
 *
 * 这里把一次解析结果转成两份可释放的 blob URL：
 * - fullUrl：原图二进制（不解码、不上屏，只给全屏查看器 / 下载用）
 * - thumbnailUrl：长边 THUMBNAIL_MAX_EDGE 的缩略图（列表格子用，解码位图只有几十 KB）
 * 缩略图生成失败（无 canvas / SVG / 解码失败）时回落到 fullUrl，功能不受影响。
 */

import { extractImagePayload } from './imagePayload';

/** 缩略图长边：64px 格子 × 3x 屏幕密度，留一点余量给 object-cover 裁切 */
export const THUMBNAIL_MAX_EDGE = 256;

export interface ImagePreviewAsset {
  mimeType: string;
  /** 原图 blob URL（全屏查看器用） */
  fullUrl: string;
  /** 缩略图 blob URL（列表格子用）；无法缩放时与 fullUrl 相同 */
  thumbnailUrl: string;
}

/** base64 → Blob（二进制只存一份，不再以 base64 字符串常驻） */
export function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}

/**
 * 按长边上限等比缩放后的尺寸；原图不超过上限时返回 null（无需缩略）。
 */
export function computeThumbnailSize(
  width: number,
  height: number,
  maxEdge = THUMBNAIL_MAX_EDGE,
): { width: number; height: number } | null {
  if (!(width > 0) || !(height > 0)) return null;
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return null;
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function canvasToBlob(canvas: HTMLCanvasElement | OffscreenCanvas, type: string): Promise<Blob | null> {
  if (typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas) {
    return canvas.convertToBlob({ type, quality: 0.85 }).catch(() => null);
  }
  return new Promise((resolve) => {
    (canvas as HTMLCanvasElement).toBlob((blob) => resolve(blob), type, 0.85);
  });
}

/**
 * 生成缩略图 Blob；不需要或无法缩略时返回 null（调用方回落原图）。
 * 原图只在这里解码一次，产物被模块级缓存跨消息共享。
 */
export async function createThumbnailBlob(
  source: Blob,
  maxEdge = THUMBNAIL_MAX_EDGE,
): Promise<Blob | null> {
  // 矢量图不需要缩略，且 createImageBitmap 不支持 SVG
  if (source.type === 'image/svg+xml') return null;
  if (typeof createImageBitmap !== 'function') return null;

  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(source);
    const size = computeThumbnailSize(bitmap.width, bitmap.height, maxEdge);
    if (!size) return null;

    const canvas: HTMLCanvasElement | OffscreenCanvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(size.width, size.height)
      : Object.assign(document.createElement('canvas'), size);
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!ctx) return null;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, size.width, size.height);
    // JPEG 源保持 JPEG（体积小）；其他格式可能带透明通道，用 PNG 保住 alpha
    const outputType = source.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    return await canvasToBlob(canvas, outputType);
  } catch {
    return null;
  } finally {
    bitmap?.close();
  }
}

/**
 * VFS 解析内容（base64 / data URL，可能混有 OCR 片段）→ 预览资源。
 * 载荷无效时返回 null。
 */
export async function createImagePreviewAsset(
  content: string,
  fallbackMimeType = 'image/png',
): Promise<ImagePreviewAsset | null> {
  const { base64, mediaType } = extractImagePayload(content);
  if (!base64) return null;
  const mimeType = mediaType || fallbackMimeType;

  // 无 blob URL 能力的环境（极旧内核 / 测试 DOM）回落 data URL，功能不受影响
  if (typeof URL.createObjectURL !== 'function') {
    const dataUrl = `data:${mimeType};base64,${base64}`;
    return { mimeType, fullUrl: dataUrl, thumbnailUrl: dataUrl };
  }

  let blob: Blob;
  try {
    blob = base64ToBlob(base64, mimeType);
  } catch {
    return null;
  }
  const fullUrl = URL.createObjectURL(blob);
  const thumbnail = await createThumbnailBlob(blob);
  const thumbnailUrl = thumbnail ? URL.createObjectURL(thumbnail) : fullUrl;
  return { mimeType, fullUrl, thumbnailUrl };
}

/** 释放预览资源占用的 blob URL */
export function revokeImagePreviewAsset(asset: ImagePreviewAsset): void {
  if (typeof URL.revokeObjectURL !== 'function') return;
  for (const url of new Set([asset.fullUrl, asset.thumbnailUrl])) {
    if (url.startsWith('blob:')) URL.revokeObjectURL(url);
  }
}
