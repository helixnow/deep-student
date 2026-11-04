import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';

import {
  getFrozenInkBoardRenderInputs,
  getFrozenInkRenderInputs,
  type InkBoardRenderPayload,
  type InkFrozenBoardRenderInputs,
} from './renderBridge';
import type { InkBoardSurface, InkPage, InkPageRef, InkRect } from './types';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);

const surface: InkBoardSurface = {
  kind: 'board',
  page_id: 'surface-1',
  ruling: 'blank',
  bounds: { x: -10_000_000, y: -10_000_000, width: 20_000_000, height: 20_000_000 },
};
const crop: InkRect = { x: -100, y: -80, width: 200, height: 160 };
const boardPayload: InkBoardRenderPayload = {
  schema_version: 2,
  surface,
  crop,
  chunks: [],
};
const boardResponse: InkFrozenBoardRenderInputs = {
  revision: 'rev-1',
  source: { kind: 'blank' },
  board: boardPayload,
  highlights: [],
};

const pageRef: InkPageRef = {
  page_id: 'surface-1',
  width: 100,
  height: 80,
  background: { kind: 'blank', ruling: 'blank' },
  page_blob_hash: 'page-hash',
};
const page: InkPage = { schema_version: 1, page_id: 'surface-1', objects: [] };

const expectInvalidArgument = (promise: Promise<unknown>) =>
  expect(promise).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

describe('frozen Ink render input helpers', () => {
  beforeEach(() => invokeMock.mockReset());

  it('forwards a board request and returns board inputs without paged fields', async () => {
    invokeMock.mockResolvedValueOnce(boardResponse);

    const result = await getFrozenInkBoardRenderInputs('doc-1', 'rev-1', 'surface-1', {
      crop,
      chunk_ids: [],
    });

    expect(invokeMock).toHaveBeenCalledWith('vfs_ink_get_render_inputs', {
      documentId: 'doc-1',
      expectedRevision: 'rev-1',
      pageId: 'surface-1',
      board: { crop, chunk_ids: [] },
    });
    expect(result).toMatchObject(boardResponse);
    expect(result).not.toHaveProperty('page_ref');
    expect(result).not.toHaveProperty('page');
  });

  it('rejects mixed board/page responses and mismatched surface or revision identity', async () => {
    invokeMock.mockResolvedValueOnce({ ...boardResponse, page_ref: pageRef, page });
    await expectInvalidArgument(
      getFrozenInkBoardRenderInputs('doc-1', 'rev-1', 'surface-1', { crop }),
    );

    invokeMock.mockResolvedValueOnce({ ...boardResponse, revision: 'rev-2' });
    await expectInvalidArgument(
      getFrozenInkBoardRenderInputs('doc-1', 'rev-1', 'surface-1', { crop }),
    );

    invokeMock.mockResolvedValueOnce({
      ...boardResponse,
      board: { ...boardPayload, surface: { ...surface, page_id: 'surface-2' } },
    });
    await expectInvalidArgument(
      getFrozenInkBoardRenderInputs('doc-1', 'rev-1', 'surface-1', { crop }),
    );
  });

  it('rejects a board response through the legacy paged helper', async () => {
    invokeMock.mockResolvedValueOnce(boardResponse);

    await expectInvalidArgument(getFrozenInkRenderInputs('doc-1', 'rev-1', 'surface-1'));

    expect(invokeMock).toHaveBeenCalledWith('vfs_ink_get_render_inputs', {
      documentId: 'doc-1',
      expectedRevision: 'rev-1',
      pageId: 'surface-1',
    });
  });
});
