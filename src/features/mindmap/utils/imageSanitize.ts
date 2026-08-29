/**
 * 节点内嵌图片运行时清洗（剪贴板结构化载荷与 JSON 导入共用的纯函数）。
 *
 * `MindMapImage.src` 的类型注释承诺「data URL 或安全的 http(s) 地址」，
 * 本模块是这条承诺的运行时实现：
 * - data URL 只放行 `data:image/<白名单 MIME>;base64,...`（MIME 白名单与
 *   importers 的 IMAGE_MIME_BY_EXT 同一口径），并做单图/累计体积上限；
 * - 远程地址只放行 https（http 明文与 javascript: 等一律拒绝），
 *   防止本地 JSON / 外来剪贴板载荷借 <img> 渲染发起非预期网络请求；
 * - 体积预算与 xmind 导入侧同一口径（单图 256 KiB 原始字节、数量 128、
 *   累计内联 8 MiB 字符），避免恶意载荷绕过导入预算把文档 JSON 撑爆。
 *   常量数值刻意与 importers 的 MAX_INLINE_IMAGE_BYTES / MAX_IMPORT_IMAGE_COUNT /
 *   MAX_IMPORT_IMAGE_INLINE_TOTAL_BYTES 对齐但不 import——importers 依赖
 *   jszip/i18n，反向引用会把重依赖拖进剪贴板路径并形成环。
 */

import type { MindMapImage } from '../types';

/**
 * data URL 形态校验：`data:image/<允许的 MIME>;base64,<base64 字符>`。
 * 单一字符类无回溯风险；base64 体不允许出现空白等杂质字符。
 */
const IMAGE_DATA_URL_PATTERN = /^data:image\/(?:png|jpeg|gif|webp|svg\+xml|bmp);base64,[A-Za-z0-9+/=]+$/;

/**
 * 单图 data URL 字符上限：256 KiB 原始字节经 base64 膨胀 4/3，
 * 外加 data:image/…;base64, 头部的少量余量。
 */
export const MAX_IMAGE_DATA_URL_CHARS = Math.ceil((256 * 1024) / 3) * 4 + 64;

/** 远程 https 图片地址长度上限（超长 URL 无正当用例，直接拒绝） */
const MAX_REMOTE_IMAGE_URL_CHARS = 2048;

/** 单个载荷（一次复制 / 一次 JSON 导入）可保留的图片数量上限 */
export const MAX_SANITIZED_IMAGE_COUNT = 128;

/** 单个载荷内联 data URL 累计字符预算（文档持久化体积防线） */
export const MAX_SANITIZED_IMAGE_TOTAL_CHARS = 8 * 1024 * 1024;

/** 图片文件名保留长度上限（仅悬停提示用，截断不影响功能） */
const MAX_IMAGE_NAME_CHARS = 256;

/**
 * 跨节点共享的清洗预算：一次复制 / 一次导入调用共用一份，
 * 防止「每个节点各挂上限内图片」在整棵树维度上失控。
 */
export interface ImageSanitizeBudget {
  imagesRemaining: number;
  inlineCharsRemaining: number;
}

export function createImageSanitizeBudget(): ImageSanitizeBudget {
  return {
    imagesRemaining: MAX_SANITIZED_IMAGE_COUNT,
    inlineCharsRemaining: MAX_SANITIZED_IMAGE_TOTAL_CHARS,
  };
}

/** 单个 src 是否可安全交给 <img>：白名单 data URL（含单图体积上限）或 https 地址 */
export function isSafeImageSrc(src: string): boolean {
  if (src.startsWith('data:')) {
    return src.length <= MAX_IMAGE_DATA_URL_CHARS && IMAGE_DATA_URL_PATTERN.test(src);
  }
  if (/^https:\/\/\S+$/.test(src)) {
    return src.length <= MAX_REMOTE_IMAGE_URL_CHARS;
  }
  return false;
}

function toDimension(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * 清洗单个节点的 images 字段：逐项白名单重建（src 校验 + name/width/height
 * 类型收窄），并从共享预算扣减数量与内联字符。
 * 不合法项静默丢弃；全部丢弃或原值不是数组时返回 undefined（调用方据此删字段）。
 */
export function sanitizeNodeImages(
  raw: unknown,
  budget: ImageSanitizeBudget,
): MindMapImage[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const images: MindMapImage[] = [];
  for (const item of raw) {
    if (budget.imagesRemaining <= 0) break;
    if (!item || typeof item !== 'object') continue;
    const source = item as Record<string, unknown>;
    if (typeof source.src !== 'string' || !isSafeImageSrc(source.src)) continue;
    const inline = source.src.startsWith('data:');
    if (inline && source.src.length > budget.inlineCharsRemaining) continue;

    budget.imagesRemaining -= 1;
    if (inline) budget.inlineCharsRemaining -= source.src.length;

    const image: MindMapImage = { src: source.src };
    if (typeof source.name === 'string' && source.name) {
      image.name = source.name.slice(0, MAX_IMAGE_NAME_CHARS);
    }
    const width = toDimension(source.width);
    if (width !== undefined) image.width = width;
    const height = toDimension(source.height);
    if (height !== undefined) image.height = height;
    images.push(image);
  }
  return images.length > 0 ? images : undefined;
}
