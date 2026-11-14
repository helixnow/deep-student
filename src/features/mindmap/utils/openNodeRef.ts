/**
 * 打开节点资源引用：优先 workbench 开窗，legacy 降级到 learning-hub。
 * 资源不存在时提示并返回 false。
 */
import { invoke } from '@tauri-apps/api/core';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { RESOURCE_ID_PREFIX_MAP } from '@/dstu/types/path';
import { workbenchBus } from '@/features/workbench/core/workbenchBus';
import i18next from 'i18next';

interface DstuNodeSummary {
  id?: string;
  type?: string;
  name?: string;
}

interface VfsResourceSummary {
  id?: string;
  sourceId?: string | null;
  type?: string;
  resourceType?: string;
  metadata?: { title?: string; name?: string };
}

interface ResolvedNodeRef {
  resourceId: string;
  type?: string;
  name?: string;
}

const KNOWN_APP_TYPES = new Set([
  'note',
  'textbook',
  'exam',
  'translation',
  'essay',
  'image',
  'file',
  'mindmap',
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeResourceId(raw: string): string {
  return raw.trim().replace(/^\/+/, '');
}

function isDstuResourceId(id: string): boolean {
  if (!id || id.startsWith('res_')) return false;
  return (
    Object.keys(RESOURCE_ID_PREFIX_MAP).some((prefix) => id.startsWith(prefix)) ||
    UUID_RE.test(id)
  );
}

function normalizeAppType(type?: string | null): string | undefined {
  if (!type) return undefined;
  if (type === 'attachment') return 'file';
  if (type === 'pdf') return 'textbook';
  if (type === 'qbank') return 'exam';
  return KNOWN_APP_TYPES.has(type) ? type : undefined;
}

function resourceIdToAppTypeId(
  resourceId: string,
  preferredType?: string,
  resolvedType?: string,
): string {
  const fromResolved = normalizeAppType(resolvedType);
  if (fromResolved) return fromResolved;

  const fromPreferred = normalizeAppType(preferredType);
  if (fromPreferred) return fromPreferred;

  for (const [prefix, type] of Object.entries(RESOURCE_ID_PREFIX_MAP)) {
    if (resourceId.startsWith(prefix)) {
      return type === 'attachment' || type === 'folder' ? 'file' : type;
    }
  }
  return 'file';
}

async function fetchDstuNode(resourceId: string): Promise<DstuNodeSummary | null> {
  const dstuPath = resourceId.startsWith('/') ? resourceId : `/${resourceId}`;
  return invoke<DstuNodeSummary | null>('dstu_get', { path: dstuPath });
}

/**
 * 校验并解析引用目标：
 * - `res_*` 属于底层 VFS resources 表，走 `vfs_get_resource`（若关联 DSTU 实体则继续校验）；
 * - 业务资源 ID（note_/mm_/tb_/exam_/tr_/essay_/file_/...）走 `dstu_get`。
 */
async function resolveNodeRef(resourceId: string): Promise<ResolvedNodeRef | null> {
  try {
    if (resourceId.startsWith('res_')) {
      const resource = await invoke<VfsResourceSummary | null>('vfs_get_resource', {
        resourceId,
      });
      if (!resource || (!resource.id && !resource.sourceId)) {
        return null;
      }

      const linkedId =
        typeof resource.sourceId === 'string' ? normalizeResourceId(resource.sourceId) : '';
      if (linkedId && isDstuResourceId(linkedId)) {
        const linkedNode = await fetchDstuNode(linkedId);
        if (!linkedNode || linkedNode.type === 'folder') return null;
        return {
          resourceId: linkedNode.id || linkedId,
          type: linkedNode.type ?? resource.type ?? resource.resourceType,
          name: linkedNode.name || resource.metadata?.title || resource.metadata?.name,
        };
      }

      return {
        resourceId: resource.id || resourceId,
        type: resource.type ?? resource.resourceType,
        name: resource.metadata?.title || resource.metadata?.name,
      };
    }

    const node = await fetchDstuNode(resourceId);
    if (!node || node.type === 'folder') return null;

    return {
      resourceId: node.id || resourceId,
      type: node.type,
      name: node.name,
    };
  } catch {
    return null;
  }
}

export async function openNodeRef(
  sourceId: string,
  options?: { type?: string; name?: string },
): Promise<boolean> {
  const normalizedId = normalizeResourceId(sourceId);
  if (!normalizedId) return false;

  const resolved = await resolveNodeRef(normalizedId);
  if (!resolved) {
    showGlobalNotification(
      'warning',
      i18next.t('refs.unavailable', { ns: 'mindmap' }),
    );
    return false;
  }

  const typeId = resourceIdToAppTypeId(resolved.resourceId, options?.type, resolved.type);
  const title = options?.name || resolved.name;

  if (workbenchBus.isEnabled()) {
    workbenchBus.launch({
      typeId,
      instanceKey: resolved.resourceId,
      payload: title ? { title } : undefined,
      reason: 'api',
    });
    return true;
  }

  const dstuPath = `/${resolved.resourceId}`;
  window.dispatchEvent(
    new CustomEvent('NAVIGATE_TO_VIEW', {
      detail: { view: 'learning-hub', openResource: dstuPath },
    }),
  );
  return true;
}
