import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import type { Resource, SendContextRef } from '../../resources/types';
import {
  MAX_SEND_TIME_STAGE_ITEMS,
  binaryStageInputs,
  filterStagedPathMap,
  materializeBinaryContextRefs,
  modelVisibleAttachmentBlock,
  stagedAttachmentPathKey,
} from '../attachmentMaterialization';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const invokeMock = vi.mocked(invoke);

const resource = (type: Resource['type'], refs: unknown[]): Resource => ({
  id: 'res_ctx', hash: 'h', type, data: JSON.stringify({ refs, totalCount: refs.length, truncated: false }),
  refCount: 0, createdAt: 1,
});
const sendRef = (typeId: string): SendContextRef => ({
  resourceId: 'res_ctx', hash: 'h', typeId, displayName: 'upload', formattedBlocks: [],
});
const handle = (id: string) => ({
  schemaVersion: 1, handleId: id, kind: 'file' as const, displayName: `${id}.png`,
  locator: { rootId: 'temp', relativePath: `attachments/${id}.png` },
  capabilities: { readable: true, materializable: true, writable: false, shareable: false, sendable: false, deletable: false },
  provenance: { source: 'chat_context_ref', observedAt: '2026-07-19T00:00:00Z' },
});

describe('send-time attachment materialization contract', () => {
  beforeEach(() => invokeMock.mockReset());

  it('maps every image in a multi-image ContextRef', () => {
    const inputs = binaryStageInputs(resource('image', [
      { sourceId: 'att_a', resourceHash: 'a', type: 'image', name: 'a.png' },
      { sourceId: 'att_b', resourceHash: 'b', type: 'image', name: 'b.png' },
    ]), sendRef('image'));
    expect(inputs.map((item) => item.sourceId)).toEqual(['att_a', 'att_b']);
  });

  it.each(['note', 'card', 'retrieval', 'folder', 'textbook', 'exam', 'essay', 'translation', 'mindmap'])(
    'does not stage text/domain ref %s',
    (typeId) => expect(binaryStageInputs(resource('file', [
      { sourceId: 'att_a', resourceHash: 'a', type: 'file', name: 'a.txt' },
    ]), sendRef(typeId))).toEqual([]),
  );

  it('invokes one bounded batch for 21 attachments with full coverage', async () => {
    const candidates = Array.from({ length: 21 }, (_, index) => ({
      resourceId: `res_${index}`, sourceId: `att_${index}`, displayName: `${index}.png`,
    }));
    invokeMock.mockResolvedValue({
      expectedItems: 21, observedItems: 21, coverageComplete: true, truncated: false,
      attachments: candidates.map((item, index) => ({
        ...item, rootId: 'temp', relativePath: `attachments/${index}.png`, sizeBytes: 1,
        sha256: `${index}`.padStart(64, '0'), reused: index > 0, objectHandle: handle(`att_${index}`),
      })),
      failures: [],
    });
    const result = await materializeBinaryContextRefs('sess_1', candidates);
    expect(result.attachments).toHaveLength(21);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith('chat_v2_stage_context_attachments', { sessionId: 'sess_1', items: candidates });
  });

  it('rejects more than the bounded maximum before invoking Tauri', async () => {
    const candidates = Array.from({ length: MAX_SEND_TIME_STAGE_ITEMS + 1 }, (_, index) => ({
      resourceId: `res_${index}`, sourceId: `att_${index}`, displayName: 'x.bin',
    }));
    await expect(materializeBinaryContextRefs('sess_1', candidates)).rejects.toThrow('Too many');
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('makes backend failures visible and prevents send continuation', async () => {
    invokeMock.mockResolvedValue({
      expectedItems: 1, observedItems: 1, coverageComplete: true, truncated: false,
      attachments: [], failures: [{ resourceId: 'res_1', sourceId: 'att_1', error: 'bad archive' }],
    });
    await expect(materializeBinaryContextRefs('sess_1', [
      { resourceId: 'res_1', sourceId: 'att_1', displayName: 'bad.zip' },
    ])).rejects.toThrow('bad archive');
  });

  it('preserves root, relative path, source identity and handle in model metadata', () => {
    const metadata = {
      resourceId: 'res_1', sourceId: 'att_1', rootId: 'temp', relativePath: 'attachments/a.png',
      sizeBytes: 3, sha256: 'a'.repeat(64), reused: false, mediaType: 'image/png', objectHandle: handle('att_1'),
    };
    expect(stagedAttachmentPathKey(metadata)).toBe('__staged_attachment__:res_1:att_1');
    const block = modelVisibleAttachmentBlock([metadata]);
    expect(block.type).toBe('text');
    expect(block.type === 'text' && block.text).toContain('"rootId":"temp"');
    expect(block.type === 'text' && block.text).toContain('"relativePath":"attachments/a.png"');
    expect(block.type === 'text' && block.text).not.toContain('/Users/');
  });

  it('keeps all mapped images for retained refs and drops truncated refs', () => {
    const map = {
      res_keep: 'temp:attachments/a.png',
      '__staged_attachment__:res_keep:att_a': '{"rootId":"temp"}',
      '__staged_attachment__:res_keep:att_b': '{"rootId":"temp"}',
      res_drop: 'temp:attachments/c.png',
      '__staged_attachment__:res_drop:att_c': '{"rootId":"temp"}',
    };
    expect(Object.keys(filterStagedPathMap(map, new Set(['res_keep'])))).toEqual([
      'res_keep',
      '__staged_attachment__:res_keep:att_a',
      '__staged_attachment__:res_keep:att_b',
    ]);
  });

  it('deduplicates identical resource/source candidates before invoking', async () => {
    invokeMock.mockResolvedValue({ expectedItems: 1, observedItems: 1, coverageComplete: true, truncated: false, attachments: [], failures: [{ resourceId: 'r', sourceId: 'a', error: 'x' }] });
    await expect(materializeBinaryContextRefs('s', [
      { resourceId: 'r', sourceId: 'a', displayName: 'one' },
      { resourceId: 'r', sourceId: 'a', displayName: 'two' },
    ])).rejects.toThrow('x');
    expect(invokeMock.mock.calls[0][1]).toEqual({ sessionId: 's', items: [{ resourceId: 'r', sourceId: 'a', displayName: 'two' }] });
  });
});
