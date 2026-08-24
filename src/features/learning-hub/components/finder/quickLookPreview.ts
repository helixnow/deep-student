/**
 * Quick Look 可视预览解析与加载（图片原图 / PDF 首页）
 *
 * 与完整预览管线（ImageContentView / TextbookContentView）解耦的轻量路径：
 * - 图片：优先 vfs_get_file_blob_path + read_file_bytes（原始 ArrayBuffer），
 *   失败回退 vfs_get_attachment_content（base64）——与 ImageContentView 同源策略；
 * - PDF（教材 / PDF 附件）：vfs_get_pdf_page_image 取预渲染首页（base64 data URL）。
 *
 * 任一环节失败都静默返回 null，Quick Look 回退到类型图标卡片，不打断浮层。
 */

import { invoke } from '@tauri-apps/api/core';
import { getPdfPageImageDataUrl } from '@/api/vfsRagApi';
import { base64ToBlob } from '@/utils/base64FileUtils';
import type { DstuNode } from '@/dstu/types';

export type QuickLookVisualKind = 'image' | 'pdf';

export interface QuickLookVisualResult {
  kind: QuickLookVisualKind;
  /** img.src 可直接使用的 URL（ObjectURL 或 data URL） */
  url: string;
  /** true 时使用方负责 URL.revokeObjectURL */
  isObjectUrl: boolean;
}

type QuickLookVisualSource = Pick<
  DstuNode,
  'id' | 'name' | 'type' | 'previewType' | 'resourceId' | 'metadata'
>;

const IMAGE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'avif', 'heic', 'heif',
]);

const EXTENSION_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  avif: 'image/avif',
  heic: 'image/heic',
  heif: 'image/heif',
};

function getExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

/**
 * 判断该节点在 Quick Look 中是否有可视预览，以及预览种类。
 * 纯函数，供组件与测试共用。
 */
export function resolveQuickLookVisual(item: QuickLookVisualSource): QuickLookVisualKind | null {
  if (item.type === 'folder') return null;

  // 图片：类型 / previewType / 文件扩展名任一命中
  if (item.type === 'image' || item.previewType === 'image') return 'image';
  const ext = getExtension(item.name);
  if (item.type === 'file' && IMAGE_EXTENSIONS.has(ext)) return 'image';

  // PDF：previewType 声明 / 教材（PDF 渲染管线）/ .pdf 附件
  if (item.previewType === 'pdf') return 'pdf';
  if (item.type === 'textbook') return 'pdf';
  if (item.type === 'file' && ext === 'pdf') return 'pdf';

  return null;
}

/** 图片 MIME：优先 metadata.mimeType，回退扩展名映射 */
export function resolveImageMime(item: QuickLookVisualSource): string {
  const metaMime = item.metadata?.mimeType;
  if (typeof metaMime === 'string' && metaMime.startsWith('image/')) return metaMime;
  return EXTENSION_MIME[getExtension(item.name)] ?? 'image/png';
}

async function loadImageBlob(item: QuickLookVisualSource): Promise<Blob | null> {
  const mime = resolveImageMime(item);

  // 1) blob 文件直读（仅 files 表节点有 blob_hash；无则回退）
  try {
    const blobPath = await invoke<string | null>('vfs_get_file_blob_path', { id: item.id });
    if (blobPath) {
      const buffer = await invoke<ArrayBuffer>('read_file_bytes', { path: blobPath });
      if (buffer && buffer.byteLength > 0) {
        return new Blob([buffer], { type: mime });
      }
    }
  } catch {
    // 直读失败不视为错误，回退 base64 路径
  }

  // 2) 回退：附件内容 base64
  try {
    const result = await invoke<{ content: string | null; found: boolean }>(
      'vfs_get_attachment_content',
      { attachmentId: item.id },
    );
    if (result?.found && result.content) {
      return base64ToBlob(result.content, mime);
    }
  } catch {
    // 双路径都失败：交由调用方回退图标
  }
  return null;
}

/**
 * 加载可视预览。失败（不支持的类型 / 内容缺失 / 后端错误）返回 null，
 * 由 Quick Look 回退到类型图标。
 */
export async function loadQuickLookVisual(
  item: QuickLookVisualSource,
): Promise<QuickLookVisualResult | null> {
  const kind = resolveQuickLookVisual(item);
  if (!kind) return null;

  if (kind === 'image') {
    const blob = await loadImageBlob(item);
    if (!blob) return null;
    return { kind, url: URL.createObjectURL(blob), isObjectUrl: true };
  }

  // PDF 首页：后端按 resource_id（res_…）定位预渲染页图
  try {
    const url = await getPdfPageImageDataUrl(item.resourceId || item.id, 0);
    return url ? { kind, url, isObjectUrl: false } : null;
  } catch {
    return null;
  }
}
