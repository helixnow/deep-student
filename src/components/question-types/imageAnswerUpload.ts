/**
 * 题库图片作答：压缩与上传工具
 *
 * 手机拍照原图普遍 3-8MB，判分模型输入不需要那么大——上传前把长边压到
 * IMAGE_ANSWER_MAX_EDGE（手写笔迹需要保留足够分辨率：短边 ≥1600px 对应
 * A4 纸约 200 DPI，誊写识别与用户回看都清晰），质量 0.9 的 jpeg。
 * 降采样/重编码模式与壁纸库（wallpaperLibrary.ts）一致：高质量重采样 +
 * canvas 重编码；环境不支持 canvas 时原样上传（50MB 上限兜底在后端）。
 */

import { invoke } from '@tauri-apps/api/core';

import type { QuestionImage } from '@/api/questionBankApi';
import {
  IMAGE_ANSWER_MAX_IMAGES,
  IMAGE_ANSWER_MIME_TYPES,
} from '@/api/questionBankApi';

/** 上传前压缩目标：长边上限（物理像素）。手写答案需保笔迹清晰，不小于 1600。 */
export const IMAGE_ANSWER_MAX_EDGE = 2000;

/** 重编码质量（jpeg）；0.9 在笔迹清晰度与体积间平衡 */
export const IMAGE_ANSWER_REENCODE_QUALITY = 0.9;

/** 压缩产物统一转 jpeg（png 截图转 jpeg 体积更优；gif 静态场景罕见，原样放行） */
const REENCODE_TARGET_MIME = 'image/jpeg';

/** 环境内无法 canvas 重编码时的体积软上限（1.5MB base64 估算 ≈ 2MB 文件）——
 * 超过则拒绝上传，提示用户换图（后端 50MB 硬上限只防极端，不作为日常门槛）。 */
const FALLBACK_MAX_BYTES = 8 * 1024 * 1024;

/** 计算降采样目标尺寸（长边超限才缩；复用壁纸库同名纯函数语义） */
export function computeImageAnswerDimensions(
  srcWidth: number,
  srcHeight: number,
  maxEdge: number,
): { width: number; height: number; shouldResize: boolean } {
  if (
    !Number.isFinite(srcWidth) || !Number.isFinite(srcHeight) || srcWidth <= 0 || srcHeight <= 0
    || !Number.isFinite(maxEdge) || maxEdge <= 0
  ) {
    return { width: srcWidth, height: srcHeight, shouldResize: false };
  }
  const longEdge = Math.max(srcWidth, srcHeight);
  if (longEdge <= maxEdge) {
    return { width: srcWidth, height: srcHeight, shouldResize: false };
  }
  const scale = maxEdge / longEdge;
  return {
    width: Math.max(1, Math.round(srcWidth * scale)),
    height: Math.max(1, Math.round(srcHeight * scale)),
    shouldResize: true,
  };
}

interface DecodedImage {
  bitmap: ImageBitmap | HTMLImageElement;
  width: number;
  height: number;
}

async function decodeImageFile(file: File): Promise<DecodedImage | null> {
  try {
    if (typeof createImageBitmap === 'function') {
      const bitmap = await createImageBitmap(file);
      return { bitmap, width: bitmap.width, height: bitmap.height };
    }
    if (typeof document === 'undefined') return null;
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return { bitmap: img, width: img.naturalWidth, height: img.naturalHeight };
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch {
    return null;
  }
}

interface EncodeTarget {
  canvas: OffscreenCanvas | HTMLCanvasElement;
  context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
}

function createEncodeTarget(width: number, height: number): EncodeTarget | null {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    return { canvas, context: canvas.getContext('2d') };
  }
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return { canvas, context: canvas.getContext('2d') };
  }
  return null;
}

async function encodeCanvasBlob(
  target: EncodeTarget,
  type: string,
  quality: number,
): Promise<Blob | null> {
  try {
    if ('convertToBlob' in target.canvas) {
      return await target.canvas.convertToBlob({ type, quality });
    }
    return await new Promise<Blob | null>((resolve) => {
      (target.canvas as HTMLCanvasElement).toBlob(resolve, type, quality);
    });
  } catch {
    return null;
  }
}

export interface PreparedAnswerImage {
  /** 压缩重编码后的上传文件（未压缩时为原文件） */
  file: File;
  /** 最终 MIME（压缩后统一 image/jpeg） */
  mime: string;
}

/**
 * 压缩一张答案图片。任何压缩环节失败都退回原文件（清晰度优先，绝不因压缩
 * 失败挡住作答）；退回且原文件超软上限时抛错由调用方提示。
 */
export async function compressImageAnswerImage(file: File): Promise<PreparedAnswerImage> {
  // 白名单外（如 HEIC）或 gif：不重编码，原样走（gif canvas 会丢帧）
  if (!(IMAGE_ANSWER_MIME_TYPES as readonly string[]).includes(file.type) || file.type === 'image/gif') {
    assertFallbackSize(file);
    return { file, mime: file.type };
  }

  const decoded = await decodeImageFile(file);
  if (!decoded) {
    assertFallbackSize(file);
    return { file, mime: file.type };
  }
  const { width, height, shouldResize } = computeImageAnswerDimensions(
    decoded.width,
    decoded.height,
    IMAGE_ANSWER_MAX_EDGE,
  );
  if (!shouldResize && file.size <= FALLBACK_MAX_BYTES) {
    // 尺寸与体积都在限内：原图直传，避免无谓重编码损失
    return { file, mime: file.type };
  }

  const target = createEncodeTarget(width, height);
  if (!target.context) {
    assertFallbackSize(file);
    return { file, mime: file.type };
  }
  target.context.imageSmoothingEnabled = true;
  target.context.imageSmoothingQuality = 'high';
  target.context.drawImage(decoded.bitmap, 0, 0, width, height);

  const blob = await encodeCanvasBlob(target, REENCODE_TARGET_MIME, IMAGE_ANSWER_REENCODE_QUALITY);
  if (!blob || blob.size === 0) {
    assertFallbackSize(file);
    return { file, mime: file.type };
  }
  const name = file.name.replace(/\.[^.]+$/, '') + '.jpg';
  return { file: new File([blob], name, { type: REENCODE_TARGET_MIME }), mime: REENCODE_TARGET_MIME };
}

function assertFallbackSize(file: File): void {
  if (file.size > FALLBACK_MAX_BYTES) {
    throw new Error(`图片过大（${(file.size / 1024 / 1024).toFixed(1)}MB），请选择小于 8MB 的图片或稍后重试`);
  }
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
}

/**
 * 压缩 + 上传一张答案图片为 VFS 附件，返回信封引用。
 * 上传样板与题目图片编辑器（QuestionInlineEditor）一致。
 */
export async function uploadImageAnswerImage(file: File): Promise<QuestionImage> {
  const prepared = await compressImageAnswerImage(file);
  const base64 = await fileToBase64(prepared.file);
  const result = await invoke<{ sourceId: string; resourceHash: string }>('vfs_upload_attachment', {
    params: {
      name: prepared.file.name,
      mimeType: prepared.mime,
      base64Content: base64,
    },
  });
  return {
    id: result.sourceId,
    name: prepared.file.name,
    mime: prepared.mime,
    hash: result.resourceHash,
  };
}

/** 是否还能再加一张（上限与后端 IMAGE_ANSWER_MAX_IMAGES 对齐） */
export function canAddImageAnswerImage(currentCount: number): boolean {
  return currentCount < IMAGE_ANSWER_MAX_IMAGES;
}

/** 读取附件内容为 data URL（回显缩略图；题目图片同款路径） */
export async function fetchImageAnswerDataUrl(image: QuestionImage): Promise<string | null> {
  const result = await invoke<{ content: string | null; found: boolean }>(
    'vfs_get_attachment_content',
    { attachmentId: image.id },
  );
  if (result.found && result.content) {
    return `data:${image.mime};base64,${result.content}`;
  }
  return null;
}
