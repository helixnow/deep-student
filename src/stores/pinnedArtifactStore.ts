import { invoke } from '@tauri-apps/api/core';
import { create } from 'zustand';
import type { DstuNode } from '@/dstu';
import { getErrorMessage } from '@/utils/errorUtils';

export type PinnedArtifactKind = 'html' | 'openui' | 'generative-ui';

export const MAX_PINNED_ARTIFACT_REVISIONS = 20;

export interface PinnedArtifactRevision {
  version: number;
  content: string;
  patchSummary?: string;
  createdAt: number;
}

export interface PinnedArtifactRecord {
  artifactId: string;
  ownerKey: string;
  sessionId?: string;
  groupId?: string;
  widgetId: string;
  kind: PinnedArtifactKind;
  language: string;
  title: string;
  sourceMessageId: string;
  revisions: PinnedArtifactRevision[];
  activeVersion: number;
  savedResourceId?: string;
  savedContent?: string;
  createdAt: number;
  updatedAt: number;
}

export interface UpsertPinnedArtifactInput {
  ownerKey: string;
  sessionId?: string;
  groupId?: string;
  widgetId?: string;
  kind: PinnedArtifactKind;
  language: string;
  title: string;
  sourceMessageId: string;
  content: string;
  patchSummary?: string;
}

export type ArtifactPatchInput =
  | { search: string; replace: string }
  | { content: string };

export interface SaveArtifactToStudySpaceInput {
  artifactId?: string;
  title: string;
  kind: PinnedArtifactKind;
  language: string;
  content: string;
  sessionId?: string;
  groupId?: string;
}

export interface SaveArtifactToStudySpaceResult {
  nodeId: string;
  pinnedToGroup: boolean;
}

export interface RequestPinArtifactInput {
  ownerKey?: string;
  sessionId?: string;
  groupId?: string;
  widgetId?: string;
  kind: PinnedArtifactKind;
  language: string;
  title: string;
  sourceMessageId: string;
  content: string;
  patchSummary?: string;
}

export type PinnedArtifactHostLauncher = (
  input: RequestPinArtifactInput,
) => PinnedArtifactRecord;

let registeredHostLauncher: PinnedArtifactHostLauncher | null = null;
let artifactSeq = 0;
const inFlightSaves = new Map<string, Promise<SaveArtifactToStudySpaceResult>>();

export function registerPinnedArtifactHostLauncher(
  launcher: PinnedArtifactHostLauncher | null,
): void {
  registeredHostLauncher = launcher;
}

export function requestPinArtifactToCanvas(
  input: RequestPinArtifactInput,
): PinnedArtifactRecord {
  if (registeredHostLauncher) {
    return registeredHostLauncher(input);
  }
  const fallbackOwnerKey =
    input.ownerKey?.trim() ||
    (input.sessionId?.trim() ? `sandbox:chat:${input.sessionId.trim()}` : 'sandbox:legacy');
  return usePinnedArtifactStore.getState().upsertPinnedArtifact({
    ...input,
    ownerKey: fallbackOwnerKey,
  });
}

function inferSessionIdFromOwnerKey(ownerKey: string): string | undefined {
  const prefix = 'sandbox:chat:';
  if (ownerKey.startsWith(prefix)) {
    const extracted = ownerKey.slice(prefix.length).trim();
    return extracted || undefined;
  }
  return undefined;
}

function defaultTitleForKind(kind: PinnedArtifactKind): string {
  if (kind === 'openui') {
    return '交互图表工件';
  }
  if (kind === 'generative-ui') {
    return 'AI 交互视图';
  }
  return '交互画布工件';
}

function sanitizeArtifactTitle(raw: string): string {
  return raw.trim().replace(/[<>:"|?*\\/]/g, '_');
}

function resolveFenceLanguage(kind: PinnedArtifactKind, language: string): string {
  const trimmed = language.trim();
  if (kind === 'openui') {
    return trimmed === 'openui' || trimmed === 'openui-lang' ? 'openui-lang' : (trimmed || 'openui-lang');
  }
  if (kind === 'generative-ui') {
    return trimmed || 'json';
  }
  return trimmed || 'html';
}

function applyArtifactPatchContent(baseContent: string, patch: ArtifactPatchInput): string {
  if ('content' in patch) {
    if (typeof patch.content !== 'string' || !patch.content.trim()) {
      throw new Error('补丁内容不能为空');
    }
    return patch.content;
  }

  const { search, replace } = patch;
  if (typeof search !== 'string' || search.length === 0 || typeof replace !== 'string') {
    throw new Error('补丁必须提供有效的 search 与 replace 字段');
  }
  const matchIndex = baseContent.indexOf(search);
  if (matchIndex < 0) {
    throw new Error('未在当前工件源码中找到匹配的 search 片段');
  }
  if (baseContent.indexOf(search, matchIndex + 1) >= 0) {
    throw new Error('search 片段在当前工件源码中出现多次，请提供更精确的上下文');
  }
  const nextContent =
    baseContent.slice(0, matchIndex) +
    replace +
    baseContent.slice(matchIndex + search.length);

  if (!nextContent.trim()) {
    throw new Error('补丁应用后的源码不能为空');
  }
  return nextContent;
}

export interface PinnedArtifactStoreState {
  recordsById: Record<string, PinnedArtifactRecord>;
  activeArtifactByOwnerKey: Record<string, string>;
  activeArtifactBySessionId: Record<string, string>;
  upsertPinnedArtifact: (input: UpsertPinnedArtifactInput) => PinnedArtifactRecord;
  applyPatchToArtifact: (
    artifactId: string,
    patch: ArtifactPatchInput,
    summary?: string,
  ) => PinnedArtifactRecord | null;
  selectArtifactVersion: (artifactId: string, version: number) => PinnedArtifactRecord | null;
  getActiveArtifactForSession: (sessionId: string) => PinnedArtifactRecord | null;
  getActiveArtifactForOwner: (ownerKey: string) => PinnedArtifactRecord | null;
  deactivateOwnerArtifacts: (ownerKey: string, sessionIdHint?: string) => void;
  deactivateSessionArtifact: (sessionId: string) => void;
  reactivateOwnerArtifact: (
    ownerKey: string,
    artifactId?: string,
    sessionIdHint?: string,
  ) => void;
  saveArtifactToStudySpace: (
    input: SaveArtifactToStudySpaceInput,
  ) => Promise<SaveArtifactToStudySpaceResult>;
  resetPinnedArtifacts: () => void;
}

export const usePinnedArtifactStore = create<PinnedArtifactStoreState>((set, get) => ({
  recordsById: {},
  activeArtifactByOwnerKey: {},
  activeArtifactBySessionId: {},

  upsertPinnedArtifact: (input) => {
    const now = Date.now();
    const normalizedOwnerKey = input.ownerKey.trim() || 'sandbox:legacy';
    const resolvedSessionId =
      input.sessionId?.trim() || inferSessionIdFromOwnerKey(normalizedOwnerKey);
    const resolvedGroupId = input.groupId?.trim() || undefined;
    const normalizedTitle = input.title.trim() || defaultTitleForKind(input.kind);
    const explicitWidgetId = input.widgetId?.trim() || undefined;

    const currentState = get();
    const allRecords = Object.values(currentState.recordsById);

    let matchedRecord: PinnedArtifactRecord | undefined;
    if (explicitWidgetId) {
      matchedRecord = allRecords.find(
        (rec) =>
          rec.widgetId === explicitWidgetId &&
          (rec.ownerKey === normalizedOwnerKey ||
            (resolvedSessionId !== undefined && rec.sessionId === resolvedSessionId)),
      );
    }
    if (!matchedRecord && !explicitWidgetId) {
      matchedRecord = allRecords.find((rec) => {
        const sameScope = resolvedSessionId
          ? rec.sessionId === resolvedSessionId
          : rec.ownerKey === normalizedOwnerKey;
        return sameScope && rec.kind === input.kind && rec.title === normalizedTitle;
      });
    }

    let nextRecord: PinnedArtifactRecord;
    if (matchedRecord) {
      const latestRev = matchedRecord.revisions[matchedRecord.revisions.length - 1];
      if (latestRev && latestRev.content === input.content) {
        nextRecord = {
          ...matchedRecord,
          ownerKey: normalizedOwnerKey,
          sessionId: resolvedSessionId ?? matchedRecord.sessionId,
          groupId: resolvedGroupId ?? matchedRecord.groupId,
          activeVersion: latestRev.version,
          updatedAt: now,
        };
      } else {
        const nextVersion = (latestRev?.version ?? matchedRecord.revisions.length) + 1;
        const nextRevision: PinnedArtifactRevision = {
          version: nextVersion,
          content: input.content,
          ...(input.patchSummary ? { patchSummary: input.patchSummary } : {}),
          createdAt: now,
        };
        const nextRevisions = [...matchedRecord.revisions, nextRevision].slice(
          -MAX_PINNED_ARTIFACT_REVISIONS,
        );
        nextRecord = {
          ...matchedRecord,
          ownerKey: normalizedOwnerKey,
          sessionId: resolvedSessionId ?? matchedRecord.sessionId,
          groupId: resolvedGroupId ?? matchedRecord.groupId,
          language: input.language.trim() || matchedRecord.language,
          title: normalizedTitle,
          sourceMessageId: input.sourceMessageId || matchedRecord.sourceMessageId,
          revisions: nextRevisions,
          activeVersion: nextVersion,
          updatedAt: now,
        };
      }
    } else {
      artifactSeq += 1;
      const artifactId = `art_${now}_${artifactSeq}`;
      const widgetId = explicitWidgetId ?? `widget_${artifactId}`;
      const initialRevision: PinnedArtifactRevision = {
        version: 1,
        content: input.content,
        ...(input.patchSummary ? { patchSummary: input.patchSummary } : {}),
        createdAt: now,
      };
      nextRecord = {
        artifactId,
        ownerKey: normalizedOwnerKey,
        sessionId: resolvedSessionId,
        groupId: resolvedGroupId,
        widgetId,
        kind: input.kind,
        language: input.language.trim() || input.kind,
        title: normalizedTitle,
        sourceMessageId: input.sourceMessageId || 'chat-artifact',
        revisions: [initialRevision],
        activeVersion: 1,
        createdAt: now,
        updatedAt: now,
      };
    }

    set((state) => ({
      recordsById: {
        ...state.recordsById,
        [nextRecord.artifactId]: nextRecord,
      },
      activeArtifactByOwnerKey: {
        ...state.activeArtifactByOwnerKey,
        [normalizedOwnerKey]: nextRecord.artifactId,
      },
      activeArtifactBySessionId: nextRecord.sessionId
        ? {
            ...state.activeArtifactBySessionId,
            [nextRecord.sessionId]: nextRecord.artifactId,
          }
        : state.activeArtifactBySessionId,
    }));

    return nextRecord;
  },

  applyPatchToArtifact: (artifactId, patch, summary) => {
    const existing = get().recordsById[artifactId];
    if (!existing) {
      return null;
    }
    const latestRev = existing.revisions[existing.revisions.length - 1];
    const baseContent = latestRev?.content ?? '';
    const nextContent = applyArtifactPatchContent(baseContent, patch);

    if (latestRev && nextContent === latestRev.content) {
      return existing;
    }

    const now = Date.now();
    const nextVersion = (latestRev?.version ?? existing.revisions.length) + 1;
    const nextRevision: PinnedArtifactRevision = {
      version: nextVersion,
      content: nextContent,
      ...(summary ? { patchSummary: summary } : {}),
      createdAt: now,
    };
    const nextRevisions = [...existing.revisions, nextRevision].slice(
      -MAX_PINNED_ARTIFACT_REVISIONS,
    );
    const updatedRecord: PinnedArtifactRecord = {
      ...existing,
      revisions: nextRevisions,
      activeVersion: nextVersion,
      updatedAt: now,
    };

    set((state) => ({
      recordsById: {
        ...state.recordsById,
        [artifactId]: updatedRecord,
      },
    }));

    return updatedRecord;
  },

  selectArtifactVersion: (artifactId, version) => {
    const existing = get().recordsById[artifactId];
    if (!existing) {
      return null;
    }
    const hasTargetVersion = existing.revisions.some((rev) => rev.version === version);
    if (!hasTargetVersion) {
      return null;
    }
    if (existing.activeVersion === version) {
      return existing;
    }

    const updatedRecord: PinnedArtifactRecord = {
      ...existing,
      activeVersion: version,
      updatedAt: Date.now(),
    };
    set((state) => ({
      recordsById: {
        ...state.recordsById,
        [artifactId]: updatedRecord,
      },
    }));
    return updatedRecord;
  },

  getActiveArtifactForSession: (sessionId) => {
    const trimmed = sessionId?.trim();
    if (!trimmed) return null;
    const state = get();
    const artifactId =
      state.activeArtifactBySessionId[trimmed] ??
      state.activeArtifactByOwnerKey[`sandbox:chat:${trimmed}`];
    if (!artifactId) return null;
    return state.recordsById[artifactId] ?? null;
  },

  getActiveArtifactForOwner: (ownerKey) => {
    const trimmed = ownerKey?.trim();
    if (!trimmed) return null;
    const state = get();
    const artifactId = state.activeArtifactByOwnerKey[trimmed];
    if (!artifactId) return null;
    return state.recordsById[artifactId] ?? null;
  },

  deactivateOwnerArtifacts: (ownerKey, sessionIdHint) => {
    const normalizedOwner = ownerKey?.trim();
    const hintedSession =
      sessionIdHint?.trim() || (normalizedOwner ? inferSessionIdFromOwnerKey(normalizedOwner) : undefined);

    set((state) => {
      const targetArtifactId = normalizedOwner
        ? state.activeArtifactByOwnerKey[normalizedOwner]
        : undefined;
      const targetRecord = targetArtifactId ? state.recordsById[targetArtifactId] : undefined;
      const targetSessionId = hintedSession || targetRecord?.sessionId;

      const nextByOwner = { ...state.activeArtifactByOwnerKey };
      if (normalizedOwner && normalizedOwner in nextByOwner) {
        delete nextByOwner[normalizedOwner];
      }

      const nextBySession = { ...state.activeArtifactBySessionId };
      if (targetSessionId && targetSessionId in nextBySession) {
        if (!targetArtifactId || nextBySession[targetSessionId] === targetArtifactId) {
          delete nextBySession[targetSessionId];
        }
      }
      if (targetArtifactId) {
        for (const [sid, aid] of Object.entries(nextBySession)) {
          if (aid === targetArtifactId) {
            delete nextBySession[sid];
          }
        }
      }

      return {
        activeArtifactByOwnerKey: nextByOwner,
        activeArtifactBySessionId: nextBySession,
      };
    });
  },

  deactivateSessionArtifact: (sessionId) => {
    const trimmed = sessionId?.trim();
    if (!trimmed) return;
    set((state) => {
      const targetArtifactId = state.activeArtifactBySessionId[trimmed];
      const nextBySession = { ...state.activeArtifactBySessionId };
      delete nextBySession[trimmed];

      const nextByOwner = { ...state.activeArtifactByOwnerKey };
      const chatOwnerKey = `sandbox:chat:${trimmed}`;
      delete nextByOwner[chatOwnerKey];
      if (targetArtifactId) {
        for (const [owner, aid] of Object.entries(nextByOwner)) {
          if (aid === targetArtifactId) {
            delete nextByOwner[owner];
          }
        }
      }

      return {
        activeArtifactByOwnerKey: nextByOwner,
        activeArtifactBySessionId: nextBySession,
      };
    });
  },

  reactivateOwnerArtifact: (ownerKey, artifactId, sessionIdHint) => {
    const normalizedOwner = ownerKey?.trim();
    if (!normalizedOwner) return;
    set((state) => {
      const resolvedId =
        artifactId?.trim() ||
        Object.values(state.recordsById)
          .filter((r) => r.ownerKey === normalizedOwner)
          .sort((a, b) => b.updatedAt - a.updatedAt)[0]?.artifactId;
      if (!resolvedId || !state.recordsById[resolvedId]) {
        return state;
      }
      const record = state.recordsById[resolvedId];
      const sid = sessionIdHint?.trim() || record.sessionId || inferSessionIdFromOwnerKey(normalizedOwner);
      return {
        activeArtifactByOwnerKey: {
          ...state.activeArtifactByOwnerKey,
          [normalizedOwner]: resolvedId,
        },
        activeArtifactBySessionId: sid
          ? {
              ...state.activeArtifactBySessionId,
              [sid]: resolvedId,
            }
          : state.activeArtifactBySessionId,
      };
    });
  },

  saveArtifactToStudySpace: async (input) => {
    // Share the entire save (including group pinning), not just note creation.
    const saveKey = JSON.stringify([
      input.artifactId ?? [input.sessionId, input.title, input.kind, input.language],
      input.content, input.groupId?.trim(),
    ]);
    const pending = inFlightSaves.get(saveKey);
    if (pending) return pending;
    const save = (async (): Promise<SaveArtifactToStudySpaceResult> => {
      const dstuModule = await import('@/dstu');
      const sanitize =
        typeof dstuModule.sanitizeName === 'function'
          ? dstuModule.sanitizeName
          : sanitizeArtifactTitle;
      const rawTitle = input.title.trim() || defaultTitleForKind(input.kind);
      const sanitizedTitle = sanitize(rawTitle) || defaultTitleForKind(input.kind);
      const fenceLang = resolveFenceLanguage(input.kind, input.language);
      let fenceLength = 3;
      for (const match of input.content.matchAll(/`+/g)) {
        fenceLength = Math.max(fenceLength, match[0].length + 1);
      }
      const fence = '`'.repeat(fenceLength);
      const noteMarkdown = `# ${rawTitle}\n\n${fence}${fenceLang}\n${input.content}\n${fence}\n`;

      const trimmedGroupId = input.groupId?.trim();
      let group: { pinnedResourceIds?: string[]; rootFolderId?: string | null } | null = null;
      if (trimmedGroupId) {
        group = await invoke<{ pinnedResourceIds?: string[]; rootFolderId?: string | null } | null>(
          'chat_v2_get_group',
          { groupId: trimmedGroupId },
        );
      }
      const targetFolderId =
        typeof group?.rootFolderId === 'string' && group.rootFolderId.startsWith('fld_')
          ? group.rootFolderId
          : null;

      const existing = input.artifactId ? get().recordsById[input.artifactId] : undefined;
      let nodeId = existing?.savedResourceId &&
        (existing.savedContent === undefined || existing.savedContent === input.content)
        ? existing.savedResourceId : undefined;
      if (!nodeId) {
        const createResponse = await dstuModule.dstu.create(
          '/',
          {
            type: 'note',
            name: sanitizedTitle,
            content: noteMarkdown,
            ...(targetFolderId ? { metadata: { folderId: targetFolderId } } : {}),
          },
        );

        let createdNode: DstuNode;
        if (createResponse && typeof createResponse === 'object' && 'ok' in createResponse) {
          if (!createResponse.ok) {
            const errMessage =
              createResponse.error?.toUserMessage?.() ??
              getErrorMessage(createResponse.error);
            throw new Error(errMessage);
          }
          createdNode = createResponse.value;
        } else {
          createdNode = createResponse as unknown as DstuNode;
        }

        nodeId = createdNode?.id;
        if (!nodeId) {
          throw new Error('创建学习工件笔记未返回有效节点标识');
        }

        if (input.artifactId && get().recordsById[input.artifactId]) {
          set((state) => {
            const current = state.recordsById[input.artifactId!];
            if (!current) return state;
            return {
              recordsById: {
                ...state.recordsById,
                [input.artifactId!]: {
                  ...current,
                  savedResourceId: nodeId,
                  savedContent: input.content,
                  updatedAt: Date.now(),
                },
              },
            };
          });
        }
      }

      let pinnedToGroup = false;
      if (trimmedGroupId && group !== null && group !== undefined) {
        const existingIds = Array.isArray(group.pinnedResourceIds)
          ? group.pinnedResourceIds
          : [];
        if (!existingIds.includes(nodeId)) {
          await invoke('chat_v2_update_group', {
            groupId: trimmedGroupId,
            request: {
              pinnedResourceIds: [...existingIds, nodeId],
            },
          });
        }
        pinnedToGroup = true;
      }

      return { nodeId, pinnedToGroup };
    })().catch((error: unknown) => {
      throw new Error(getErrorMessage(error));
    });
    inFlightSaves.set(saveKey, save);
    try {
      return await save;
    } finally {
      if (inFlightSaves.get(saveKey) === save) inFlightSaves.delete(saveKey);
    }
  },

  resetPinnedArtifacts: () => {
    set({
      recordsById: {},
      activeArtifactByOwnerKey: {},
      activeArtifactBySessionId: {},
    });
  },
}));
