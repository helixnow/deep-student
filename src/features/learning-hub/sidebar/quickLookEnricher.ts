/**
 * QuickLook 内容/大小/路径富化辅助
 *
 * 为 FinderQuickLook 补全：
 * 1. 正文预览摘要（notes/essay/translation/file 等）
 * 2. 真实字节大小（notes 等列表项未带 size 时由正文或节点详情补全，避免显示 `--`）
 * 3. 可读路径（将 `/note_xxxx` 或 `/fld_xxx/note_xxxx` 解析为 `/根目录/.../名称`）
 *
 * 保持只读，不修改原节点的 `path` 对外部「打开」语义的影响（调用方需保留原始节点用于 onOpen）。
 */
import { dstu, folderApi, pathApi, type DstuNode } from '@/dstu';
import type { FinderPath } from '../stores/finderStore';
import type { SidebarT } from './sidebarConstants';

const PREVIEW_TEXT_LIMIT = 400;

const TEXT_FILE_EXT_RE = /\.(txt|md|markdown|csv|json|xml|html|htm|py|ts|tsx|js|jsx|rs|sql|yaml|yml|toml|ini|log|docx|xlsx|xls|pdf|epub|rtf|pptx)$/i;

function shouldFetchContentPreview(node: DstuNode): boolean {
  if (node.type === 'folder' || node.type === 'mindmap') return false;
  if (node.type === 'note' || node.type === 'essay' || node.type === 'translation' || node.type === 'exam' || node.type === 'textbook') {
    return true;
  }
  if (node.type === 'file') {
    return TEXT_FILE_EXT_RE.test(node.name || '');
  }
  return false;
}

function extractReadablePreview(raw: string, node: DstuNode): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Placeholder emitted by backend when document has no extracted text yet.
  if (/^\[文档:\s*[^\]]+\]$/.test(trimmed)) return null;

  // Guard against accidental binary / base64 payloads.
  if (trimmed.length > 512 && !/\s/.test(trimmed.slice(0, 128)) && /^[A-Za-z0-9+/=]+$/.test(trimmed.slice(0, 128))) {
    return null;
  }

  // Strip OCR XML wrapper for image OCR text if present.
  const ocrMatch = /^<image_ocr[^>]*>([\s\S]*?)<\/image_ocr>$/.exec(trimmed);
  const candidate = ocrMatch ? ocrMatch[1].trim() : trimmed;
  if (!candidate) return null;

  if (node.type === 'exam' || candidate.startsWith('{') || candidate.startsWith('[')) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === 'object') {
        const record = parsed as Record<string, unknown>;
        const text = record.preview ?? record.summary ?? record.title ?? record.description;
        if (typeof text === 'string' && text.trim()) {
          return text.trim().replace(/\s+/g, ' ').slice(0, PREVIEW_TEXT_LIMIT);
        }
      }
    } catch {
      // Keep plain text path below for non-JSON strings starting with { or [.
    }
  }

  const normalized = candidate
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return normalized.length > PREVIEW_TEXT_LIMIT
    ? `${normalized.slice(0, PREVIEW_TEXT_LIMIT)}…`
    : normalized;
}

function isRawInternalPath(path: string, node: DstuNode): boolean {
  const clean = path.replace(/^\/+/, '');
  return clean === node.id || /^_(?:trash|recent|favorites)|^(?:note|fld|file|tb|exam|essay|trans|img|mm)_[a-zA-Z0-9_-]+$/.test(clean);
}

async function resolveHumanReadablePath(
  node: DstuNode,
  currentPath: FinderPath,
  t: SidebarT,
): Promise<string> {
  const rootName = t('folder.root', { defaultValue: '根目录' });

  if (node.type === 'folder') {
    try {
      const crumbs = await folderApi.getBreadcrumbs(node.id);
      if (crumbs.ok && crumbs.value.length > 0) {
        return `/${[rootName, ...crumbs.value.map((c) => c.name)].join('/')}`;
      }
    } catch {
      // Fall back to current breadcrumbs below.
    }
    const parentNames = currentPath.breadcrumbs.map((b) => b.name).filter(Boolean);
    return `/${[rootName, ...parentNames, node.name].join('/')}`;
  }

  try {
    const loc = await pathApi.getResourceLocation(node.id);
    if (loc) {
      if (loc.folderId) {
        const crumbs = await folderApi.getBreadcrumbs(loc.folderId);
        if (crumbs.ok && crumbs.value.length > 0) {
          return `/${[rootName, ...crumbs.value.map((c) => c.name), node.name].join('/')}`;
        }
      }
      if (loc.folderPath && loc.folderPath.trim()) {
        const trimmed = loc.folderPath.trim().replace(/^\/+|\/+$/g, '');
        return `/${rootName}/${trimmed}/${node.name}`;
      }
      return `/${rootName}/${node.name}`;
    }
  } catch {
    // Fall back to breadcrumb/node path below.
  }

  if (currentPath.viewKind === 'folder' && currentPath.breadcrumbs.length > 0) {
    return `/${[rootName, ...currentPath.breadcrumbs.map((b) => b.name), node.name].join('/')}`;
  }
  if (node.path && !isRawInternalPath(node.path, node)) {
    return node.path;
  }
  return `/${rootName}/${node.name}`;
}

export async function enrichQuickLookNode(
  node: DstuNode,
  options: { currentPath: FinderPath; t: SidebarT },
): Promise<DstuNode> {
  const existingPreview = typeof node.metadata?.contentPreview === 'string' && node.metadata.contentPreview.trim()
    ? node.metadata.contentPreview.trim()
    : null;

  const [detailRes, contentRes, readablePath] = await Promise.all([
    dstu.get(node.path).catch(() => null),
    shouldFetchContentPreview(node) ? dstu.getContent(node.path).catch(() => null) : Promise.resolve(null),
    resolveHumanReadablePath(node, options.currentPath, options.t),
  ]);

  const freshNode = detailRes && detailRes.ok && detailRes.value ? detailRes.value : node;
  let size = freshNode.size ?? node.size;
  let contentPreview = existingPreview;

  if (contentRes && contentRes.ok && typeof contentRes.value === 'string') {
    const rawContent = contentRes.value;
    if (size === undefined || (node.type !== 'file' && node.type !== 'textbook' && size === 0)) {
      size = new TextEncoder().encode(rawContent).byteLength;
    }
    const parsedPreview = extractReadablePreview(rawContent, freshNode);
    if (parsedPreview) {
      contentPreview = parsedPreview;
    }
  }

  const nextMetadata: Record<string, unknown> = {
    ...(freshNode.metadata ?? node.metadata ?? {}),
  };
  if (contentPreview) {
    nextMetadata.contentPreview = contentPreview;
  }

  return {
    ...freshNode,
    path: readablePath,
    ...(size !== undefined ? { size } : {}),
    metadata: nextMetadata,
  };
}
