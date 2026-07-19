import { invoke } from '@tauri-apps/api/core';
import type { ContentBlock, Resource, SendContextRef } from '../resources/types';
import type { VfsContextRefData } from '../context/vfsRefTypes';
import type { TaskObjectHandle } from '../types/taskObjects';

export const STAGED_ATTACHMENT_PATH_KEY_PREFIX = '__staged_attachment__:';
export const MAX_SEND_TIME_STAGE_ITEMS = 64;

export interface StagedAttachmentMetadata {
  resourceId: string;
  sourceId: string;
  rootId: string;
  relativePath: string;
  sizeBytes: number;
  sha256: string;
  reused: boolean;
  mediaType?: string;
  objectHandle: TaskObjectHandle;
}

export interface StageInput {
  resourceId: string;
  sourceId: string;
  displayName: string;
}

export async function materializeRetainedBinaryContextRefs(
  sessionId: string,
  sendRefs: SendContextRef[],
  candidates: StageInput[],
  initialPathMap: Record<string, string>,
): Promise<Record<string, string>> {
  const retainedIds = new Set(sendRefs.map((ref) => ref.resourceId));
  const staged = await materializeBinaryContextRefs(
    sessionId,
    candidates.filter((item) => retainedIds.has(item.resourceId)),
  );
  const pathMap = { ...initialPathMap };
  const byResource = new Map<string, StagedAttachmentMetadata[]>();

  for (const attachment of staged.attachments) {
    const group = byResource.get(attachment.resourceId) ?? [];
    group.push(attachment);
    byResource.set(attachment.resourceId, group);
    pathMap[stagedAttachmentPathKey(attachment)] = JSON.stringify({
      rootId: attachment.rootId,
      relativePath: attachment.relativePath,
      sourceId: attachment.sourceId,
      sha256: attachment.sha256,
      sizeBytes: attachment.sizeBytes,
      mediaType: attachment.mediaType,
      objectHandle: attachment.objectHandle,
    });
  }

  for (const sendRef of sendRefs) {
    const attachments = byResource.get(sendRef.resourceId);
    if (!attachments?.length) continue;
    sendRef.formattedBlocks = [...sendRef.formattedBlocks, modelVisibleAttachmentBlock(attachments)];
    pathMap[sendRef.resourceId] = `${attachments[0].rootId}:${attachments[0].relativePath}`;
  }

  return pathMap;
}

export async function prepareRetainedAttachmentsAndCommit(
  sessionId: string,
  sendRefs: SendContextRef[],
  candidates: StageInput[],
  initialPathMap: Record<string, string>,
  commitLocalTurn: () => Promise<void>,
): Promise<Record<string, string>> {
  const pathMap = await materializeRetainedBinaryContextRefs(
    sessionId,
    sendRefs,
    candidates,
    initialPathMap,
  );
  await commitLocalTurn();
  return pathMap;
}

interface StageResult {
  expectedItems: number;
  observedItems: number;
  coverageComplete: boolean;
  truncated: boolean;
  attachments: StagedAttachmentMetadata[];
  failures: Array<{ resourceId: string; sourceId: string; error: string }>;
}

export function binaryStageInputs(resource: Resource, sendRef: SendContextRef): StageInput[] {
  if (sendRef.typeId !== 'file' && sendRef.typeId !== 'image') return [];
  let data: VfsContextRefData;
  try {
    data = JSON.parse(resource.data) as VfsContextRefData;
  } catch {
    return [];
  }
  if (!Array.isArray(data.refs)) return [];
  return data.refs
    .filter((ref) => ref.type === 'file' || ref.type === 'image')
    .map((ref) => ({
      resourceId: sendRef.resourceId,
      sourceId: ref.sourceId,
      displayName: ref.name || sendRef.displayName || ref.sourceId,
    }));
}

export function stagedAttachmentPathKey(metadata: Pick<StagedAttachmentMetadata, 'resourceId' | 'sourceId'>): string {
  return `${STAGED_ATTACHMENT_PATH_KEY_PREFIX}${metadata.resourceId}:${metadata.sourceId}`;
}

export function filterStagedPathMap(
  pathMap: Record<string, string>,
  keptResourceIds: Set<string>,
): Record<string, string> {
  return Object.fromEntries(Object.entries(pathMap).filter(([key]) =>
    keptResourceIds.has(key)
    || (key.startsWith(STAGED_ATTACHMENT_PATH_KEY_PREFIX)
      && Array.from(keptResourceIds).some((id) => key.startsWith(`${STAGED_ATTACHMENT_PATH_KEY_PREFIX}${id}:`)))
  ));
}

export function modelVisibleAttachmentBlock(items: StagedAttachmentMetadata[]): ContentBlock {
  const safeItems = items.map((item) => ({
    sourceId: item.sourceId,
    rootId: item.rootId,
    relativePath: item.relativePath,
    sizeBytes: item.sizeBytes,
    sha256: item.sha256,
    mediaType: item.mediaType,
    objectHandle: item.objectHandle,
  }));
  return {
    type: 'text',
    text: `<attachment_metadata>${JSON.stringify(safeItems)}</attachment_metadata>`,
  };
}

export async function materializeBinaryContextRefs(
  sessionId: string,
  candidates: StageInput[],
): Promise<StageResult> {
  const unique = Array.from(
    new Map(candidates.map((item) => [`${item.resourceId}\0${item.sourceId}`, item])).values(),
  );
  if (unique.length === 0) {
    return {
      expectedItems: 0,
      observedItems: 0,
      coverageComplete: true,
      truncated: false,
      attachments: [],
      failures: [],
    };
  }
  if (unique.length > MAX_SEND_TIME_STAGE_ITEMS) {
    throw new Error(`Too many binary context attachments: ${unique.length} exceeds ${MAX_SEND_TIME_STAGE_ITEMS}`);
  }
  const result = await invoke<StageResult>('chat_v2_stage_context_attachments', {
    sessionId,
    items: unique,
  });
  if (
    !result.coverageComplete
    || result.truncated
    || result.observedItems !== result.expectedItems
    || result.attachments.length + result.failures.length !== result.observedItems
  ) {
    throw new Error('Attachment materialization coverage is incomplete');
  }
  if (result.failures.length > 0) {
    throw new Error(`Attachment materialization failed: ${result.failures[0].error}`);
  }
  return result;
}
