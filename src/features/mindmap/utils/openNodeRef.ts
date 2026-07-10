/**
 * 打开节点资源引用：优先 workbench 开窗，legacy 降级到 learning-hub。
 * 资源不存在时提示并返回 false。
 */
import { invoke } from '@tauri-apps/api/core';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { RESOURCE_ID_PREFIX_MAP } from '@/dstu/types/path';
import { workbenchBus } from '@/features/workbench';
import i18next from 'i18next';

function resourceIdToAppTypeId(resourceId: string, preferredType?: string): string {
  if (preferredType) {
    const mapped = preferredType === 'attachment' ? 'file' : preferredType;
    if (mapped !== 'folder' && mapped !== 'all') return mapped;
  }
  for (const [prefix, type] of Object.entries(RESOURCE_ID_PREFIX_MAP)) {
    if (resourceId.startsWith(prefix)) {
      return type === 'attachment' ? 'file' : type === 'folder' ? 'file' : type;
    }
  }
  return 'file';
}

async function resourceExists(resourceId: string): Promise<boolean> {
  try {
    const resource = await invoke<{ id?: string; sourceId?: string } | null>('vfs_get_resource', {
      resourceId,
    });
    return !!(resource?.id || resource?.sourceId || resource);
  } catch {
    return false;
  }
}

export async function openNodeRef(
  sourceId: string,
  options?: { type?: string; name?: string },
): Promise<boolean> {
  const resourceId = sourceId.startsWith('/') ? sourceId.slice(1) : sourceId;
  if (!resourceId) return false;

  const exists = await resourceExists(resourceId);
  if (!exists) {
    showGlobalNotification(
      'warning',
      i18next.t('refs.unavailable', {
        ns: 'mindmap',
        defaultValue: '资源已删除或不可用',
      }),
    );
    return false;
  }

  const typeId = resourceIdToAppTypeId(resourceId, options?.type);
  const title = options?.name;

  if (workbenchBus.isEnabled()) {
    workbenchBus.launch({
      typeId,
      instanceKey: resourceId,
      payload: title ? { title } : undefined,
      reason: 'api',
    });
    return true;
  }

  const dstuPath = `/${resourceId}`;
  window.dispatchEvent(
    new CustomEvent('NAVIGATE_TO_VIEW', {
      detail: { view: 'learning-hub', openResource: dstuPath },
    }),
  );
  return true;
}
