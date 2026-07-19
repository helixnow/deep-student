import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import type { SendContextRef } from '../../resources/types';
import { prepareRetainedAttachmentsAndCommit } from '../attachmentMaterialization';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const invokeMock = vi.mocked(invoke);

const ref = (resourceId: string): SendContextRef => ({
  resourceId,
  hash: `${resourceId}-hash`,
  typeId: 'image',
  displayName: resourceId,
  formattedBlocks: [],
});

const objectHandle = {
  schemaVersion: 1,
  handleId: 'handle-keep',
  kind: 'file' as const,
  displayName: 'keep.png',
  locator: { rootId: 'temp', relativePath: 'attachments/keep.png' },
  capabilities: {
    readable: true,
    materializable: true,
    writable: false,
    shareable: false,
    sendable: false,
    deletable: false,
  },
  provenance: { source: 'chat_context_ref', observedAt: '2026-07-19T00:00:00Z' },
};

describe('attachment send ordering contract', () => {
  beforeEach(() => invokeMock.mockReset());

  it('stages only token-retained refs before committing the local turn', async () => {
    const retained = ref('keep');
    const commit = vi.fn(async () => undefined);
    invokeMock.mockResolvedValue({
      expectedItems: 1,
      observedItems: 1,
      coverageComplete: true,
      truncated: false,
      attachments: [{
        resourceId: 'keep',
        sourceId: 'keep-source',
        rootId: 'temp',
        relativePath: 'attachments/keep.png',
        sizeBytes: 4,
        sha256: 'a'.repeat(64),
        reused: false,
        mediaType: 'image/png',
        objectHandle,
      }],
      failures: [],
    });

    const pathMap = await prepareRetainedAttachmentsAndCommit(
      'sess-1',
      [retained],
      [
        { resourceId: 'keep', sourceId: 'keep-source', displayName: 'keep.png' },
        { resourceId: 'drop', sourceId: 'drop-source', displayName: 'drop.png' },
      ],
      { keep: '/source/keep', drop: '/source/drop' },
      commit,
    );

    expect(invokeMock).toHaveBeenCalledWith('chat_v2_stage_context_attachments', {
      sessionId: 'sess-1',
      items: [{ resourceId: 'keep', sourceId: 'keep-source', displayName: 'keep.png' }],
    });
    expect(commit).toHaveBeenCalledOnce();
    expect(retained.formattedBlocks.at(-1)).toMatchObject({ type: 'text' });
    expect(pathMap).toHaveProperty('__staged_attachment__:keep:keep-source');
    expect(pathMap).not.toHaveProperty('__staged_attachment__:drop:drop-source');
  });

  it('does not commit or clear the local turn when staging fails', async () => {
    const commit = vi.fn(async () => undefined);
    invokeMock.mockResolvedValue({
      expectedItems: 1,
      observedItems: 1,
      coverageComplete: true,
      truncated: false,
      attachments: [],
      failures: [{ resourceId: 'keep', sourceId: 'keep-source', error: 'staging unavailable' }],
    });

    await expect(prepareRetainedAttachmentsAndCommit(
      'sess-1',
      [ref('keep')],
      [{ resourceId: 'keep', sourceId: 'keep-source', displayName: 'keep.png' }],
      {},
      commit,
    )).rejects.toThrow('staging unavailable');
    expect(commit).not.toHaveBeenCalled();
  });
});
