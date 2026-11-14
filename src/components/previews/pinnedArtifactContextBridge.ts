import {
  usePinnedArtifactStore,
  type PinnedArtifactRecord,
} from '@/stores/pinnedArtifactStore';
import {
  WIDGET_STATE_OWNER_PREFIX,
  computeWidgetSourceHash,
  readWidgetLocalState,
  type WidgetJsonValue,
  type WidgetStateSnapshot,
} from './widgetLocalState';

export const MAX_PINNED_WIDGET_CONTEXT_CHARS = 2400;

function escapeXmlAttribute(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function resolveArtifactActiveContent(artifact: PinnedArtifactRecord): string {
  const matched = artifact.revisions.find((rev) => rev.version === artifact.activeVersion);
  if (matched) {
    return matched.content;
  }
  const latest = artifact.revisions[artifact.revisions.length - 1];
  return latest?.content ?? '';
}

function readStoredOwnerHash(widgetId: string): string | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage.getItem(`${WIDGET_STATE_OWNER_PREFIX}${widgetId}`);
    }
  } catch {
    // ignore storage access errors
  }
  return null;
}

/**
 * 读取指定画板组件的最新快照，自动兼容传入了 `source` 与未传入 `source` 的持久化键。
 */
export function readArtifactWidgetSnapshot(identity: {
  widgetId?: string;
  source?: string;
}): WidgetStateSnapshot | null {
  const widgetId = identity.widgetId?.trim();
  if (!widgetId) {
    return null;
  }
  const activeSource = identity.source ?? '';
  const expectedHash = computeWidgetSourceHash(activeSource);
  const storedOwnerHash = readStoredOwnerHash(widgetId);
  const emptySourceHash = computeWidgetSourceHash('');

  if (storedOwnerHash === emptySourceHash && expectedHash !== emptySourceHash) {
    return readWidgetLocalState({
      widgetId,
      sourceHash: emptySourceHash,
    });
  }

  return readWidgetLocalState({
    widgetId,
    source: activeSource,
    sourceHash: expectedHash,
  });
}

export function hasMeaningfulModelContent(value: WidgetJsonValue | undefined): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value === 'string') {
    return value.trim().length > 0;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return true;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return Object.keys(value).length > 0;
}

export function hasLiveWidgetModelState(identity: {
  widgetId?: string;
  source?: string;
}): boolean {
  const snapshot = readArtifactWidgetSnapshot(identity);
  return hasMeaningfulModelContent(snapshot?.modelContent);
}

function serializeBoundedModelContent(modelContent: WidgetJsonValue): string {
  const serialized = JSON.stringify(modelContent);
  if (serialized.length <= MAX_PINNED_WIDGET_CONTEXT_CHARS) {
    return serialized;
  }
  const suffix = '...[truncated]';
  const budget = Math.max(0, MAX_PINNED_WIDGET_CONTEXT_CHARS - suffix.length);
  return `${serialized.slice(0, budget)}${suffix}`;
}

/**
 * 构建当前会话激活固定工件的本轮轻量提示块：
 * - 严格只读取 `modelContent`，显式剥离并忽略 `privateContent`；
 * - 若无实时 `modelContent`，仍返回固定工件元数据与当前版本号摘要。
 */
export function buildPinnedArtifactContextHint(sessionId: string): string | null {
  const artifact = usePinnedArtifactStore.getState().getActiveArtifactForSession(sessionId);
  if (!artifact) {
    return null;
  }

  const activeContent = resolveArtifactActiveContent(artifact);
  const snapshot = readArtifactWidgetSnapshot({
    widgetId: artifact.widgetId,
    source: activeContent,
  });

  // 严格隐私隔离：显式丢弃 privateContent，仅保留公开 modelContent
  const publicSnapshot = snapshot
    ? { modelContent: snapshot.modelContent, privateContent: undefined }
    : null;

  const safeId = escapeXmlAttribute(artifact.artifactId);
  const safeTitle = escapeXmlAttribute(artifact.title);
  const safeKind = escapeXmlAttribute(artifact.kind);
  const versionTag = `v${artifact.activeVersion}`;

  if (publicSnapshot && hasMeaningfulModelContent(publicSnapshot.modelContent)) {
    const serializedModel = serializeBoundedModelContent(
      publicSnapshot.modelContent as WidgetJsonValue,
    );
    const updatedAtIso = new Date(snapshot?.updatedAt ?? artifact.updatedAt).toISOString();
    return [
      `- <pinned_artifact_state artifact_id="${safeId}" title="${safeTitle}" kind="${safeKind}" version="${versionTag}" updated_at="${escapeXmlAttribute(updatedAtIso)}">`,
      '  当前用户在右侧固定学习画布中实时交互后的公开状态（modelContent）：',
      `  ${serializedModel}`,
      '  </pinned_artifact_state>',
    ].join('\n');
  }

  return `- <pinned_artifact_state artifact_id="${safeId}" title="${safeTitle}" kind="${safeKind}" version="${versionTag}" />`;
}
