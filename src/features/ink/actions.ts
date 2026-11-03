import { invoke } from '@tauri-apps/api/core';
import { dstu } from '@/dstu';
import { vfsFileApi } from '@/api/vfsFileApi';
import type { ResourceListItem } from '@/features/learning-hub';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';

const SUPPORTED_SOURCE_EXTENSIONS = /\.(pdf|docx|pptx|png|jpe?g|gif|webp|bmp|svg|avif|tiff?)$/i;

export async function prepareSourceInk(
  source: Pick<ResourceListItem, 'id' | 'title' | 'path'>,
  onOpenApp: (item: ResourceListItem) => void,
): Promise<boolean> {
  try {
    const nodeResult = await dstu.get(source.path || `/${source.id}`);
    const node = nodeResult.ok ? nodeResult.value : null;
    if (!node) return false;

    const mime = typeof node.metadata?.mimeType === 'string' ? node.metadata.mimeType.toLowerCase() : '';
    const supported = node.type === 'image' || mime === 'application/pdf' || mime.startsWith('image/')
      || mime.includes('wordprocessingml.document') || mime.includes('presentationml.presentation')
      || SUPPORTED_SOURCE_EXTENSIONS.test(node.name || source.title);
    if (!supported) return false;

    // DSTU reports the content hash in resourceId for files, not the managed
    // resources.id. Resolve the canonical ID from the file metadata.
    const file = await vfsFileApi.get(node.sourceId || source.id);
    const sourceResourceId = file?.resourceId;
    if (!sourceResourceId) return false;

    const manifest = await invoke<{ document_id: string; title?: string }>('vfs_ink_prepare', {
      request: {
        source_resource_id: sourceResourceId,
        operation_id: crypto.randomUUID(),
      },
    });
    onOpenApp({
      id: manifest.document_id,
      title: manifest.title || node.name || source.title,
      type: 'file',
      previewType: 'ink',
      updatedAt: Date.now(),
      sourceDb: 'attachments',
    });
    return true;
  } catch (error: unknown) {
    showGlobalNotification('error', getErrorMessage(error));
    return false;
  }
}
