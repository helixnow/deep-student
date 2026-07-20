/**
 * previewShellUtils — 文件预览窗口壳层的纯工具函数。
 *
 * 只做无副作用的能力分类，供 FilePreviewAppWindow 消费：
 * - resolvePreviewShellMode：委托内容层的 resolveFilePreviewMode 归类预览模式
 * - isPrintablePreview / isTextSearchablePreview：能力判定（打印 / 文本搜索）
 */

import type { DstuNode } from '@/dstu/types';
import { resolveFilePreviewMode } from '@/features/learning-hub/apps/views/filePreviewResolver';

export type PreviewShellMode =
  | 'pdf'
  | 'docx'
  | 'xlsx'
  | 'pptx'
  | 'epub'
  | 'text'
  | 'audio'
  | 'video'
  | 'image'
  | 'none';

const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'ico',
]);

type PreviewShellNode = Pick<DstuNode, 'type' | 'name' | 'previewType' | 'metadata'>;

/**
 * 归类当前预览资源的模式。图片单独判定（内容层的 resolver 不覆盖 image），
 * 其余委托 learning-hub 的 resolveFilePreviewMode——与实际渲染层同一套
 * 优先级（EPUB 文件签名 > 显式 previewType > MIME > 扩展名），保证壳层
 * 能力判定（搜索/打印）与内容渲染结果不脱节。
 */
export function resolvePreviewShellMode(node: PreviewShellNode | null): PreviewShellMode {
  if (!node) return 'none';

  const name = node.name ?? '';
  const extension = name.split('.').pop()?.toLowerCase() ?? '';
  const rawMime = node.metadata?.mimeType;
  const mime = typeof rawMime === 'string' ? rawMime.toLowerCase() : '';

  if (
    node.type === 'image' || node.previewType === 'image'
    || IMAGE_EXTENSIONS.has(extension) || mime.startsWith('image/')
  ) {
    return 'image';
  }

  const mode = resolveFilePreviewMode(mime, name, node.previewType);
  if (mode !== 'none') return mode;
  if (node.type === 'textbook') return 'pdf';
  return 'none';
}

/**
 * 窗口内打印（visibility hack）是否可靠：
 * PDF/EPUB 分别经 canvas / iframe 渲染，打印结果不可靠；音视频无可打印内容。
 */
export function isPrintablePreview(mode: PreviewShellMode): boolean {
  return mode === 'text' || mode === 'docx' || mode === 'xlsx' || mode === 'pptx' || mode === 'image';
}

/** 文本搜索是否有意义（PDF 有 text layer，EPUB 由 EpubPreview 自带搜索）。 */
export function isTextSearchablePreview(mode: PreviewShellMode): boolean {
  return mode === 'text' || mode === 'docx' || mode === 'xlsx' || mode === 'pptx' ||
    mode === 'pdf' || mode === 'epub';
}
