import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inkBoardDraftJournal, type InkBoardDraftRecord } from '../boardDrafts';
import { flushInkEditor, hasDirtyInkEditor } from '../editorSession';
import { InkBoardEditor } from '../InkBoardEditor';
import type { InkBoardChunk, InkBoardManifest } from '../types';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listener: undefined as undefined | ((event: { payload: unknown }) => unknown),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_event: string, listener: (event: { payload: unknown }) => unknown) => {
    mocks.listener = listener;
    return () => { mocks.listener = undefined; };
  }),
}));
vi.mock('../boardRenderer', () => ({ renderInkBoard: vi.fn() }));
vi.mock('@/hooks/useBreakpoint', () => ({ useIsMobile: () => false }));

class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly pressure: number;

  constructor(type: string, init: MouseEventInit & { pointerId?: number; pointerType?: string; pressure?: number } = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? 'pen';
    this.pressure = init.pressure ?? 0.5;
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function manifest(documentId: string): InkBoardManifest {
  return {
    schema_version: 2,
    document_id: documentId,
    revision: 'rev-1',
    title: 'Board flush',
    source: { kind: 'blank' },
    pages: [],
    surface: {
      kind: 'board', page_id: `page-${documentId}`, ruling: 'blank',
      bounds: { x: -1000, y: -1000, width: 2000, height: 2000 },
    },
    chunks: [],
  };
}

type SaveRequest = {
  document_id: string;
  expected_revision: string;
  changed: InkBoardChunk[];
  deleted: string[];
};

const documentId = 'board-host-flush';
let documents: Map<string, InkBoardManifest>;
let chunks: Map<string, InkBoardChunk>;
let drafts: Map<string, InkBoardDraftRecord>;
let saves: SaveRequest[];
let journalAtCas: Array<InkBoardDraftRecord | undefined>;

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.listener = undefined;
  localStorage.clear();
  vi.stubGlobal('PointerEvent', TestPointerEvent);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  documents = new Map([[documentId, manifest(documentId)]]);
  chunks = new Map();
  drafts = new Map();
  saves = [];
  journalAtCas = [];
  vi.spyOn(inkBoardDraftJournal, 'claim').mockImplementation(async (key, owner) => ({
    owner,
    sequence_floor: 0,
    draft: drafts.get(key.document_id),
  }));
  vi.spyOn(inkBoardDraftJournal, 'persist').mockImplementation(async (record) => {
    drafts.set(record.document_id, structuredClone(record));
  });
  vi.spyOn(inkBoardDraftJournal, 'discard').mockImplementation(async (key) => {
    drafts.delete(key.document_id);
  });
  mocks.invoke.mockImplementation(async (command: string, payload: Record<string, any>) => {
    const request = payload.request;
    const current = documents.get(request.document_id);
    if (command === 'vfs_ink_get') return structuredClone(current);
    if (command === 'vfs_ink_get_chunks') {
      return request.chunk_ids.map((id: string) => structuredClone(chunks.get(id)));
    }
    if (command === 'vfs_ink_get_board_overview' && current) {
      const objects = [...chunks.values()].flatMap((chunk) => chunk.objects);
      return {
        document_id: current.document_id,
        page_id: current.surface.page_id,
        revision: current.revision,
        max_z_index: objects.length ? String(Math.max(...objects.map((object) => object.z_index))) : null,
      };
    }
    if (command === 'vfs_ink_save_chunks' && current) {
      saves.push(structuredClone(request));
      journalAtCas.push(structuredClone(drafts.get(request.document_id)));
      for (const id of request.deleted) chunks.delete(id);
      for (const chunk of request.changed) chunks.set(chunk.chunk_id, structuredClone(chunk));
      const saved: InkBoardManifest = {
        ...current,
        revision: `saved-${saves.length}`,
        chunks: [...chunks.values()].map((chunk) => ({
          chunk_id: chunk.chunk_id,
          blob_hash: `saved-${saves.length}-${chunk.chunk_id}`,
          byte_length: new TextEncoder().encode(JSON.stringify(chunk)).byteLength,
          object_count: chunk.objects.length,
          sample_count: chunk.objects.reduce((total, object) => total + (object.content.kind === 'stroke' ? object.content.samples.length : 0), 0),
          bounds: { x: -1000, y: -1000, width: 2000, height: 2000 },
        })),
      };
      documents.set(request.document_id, saved);
      return structuredClone(saved);
    }
    throw new Error(`Unexpected command: ${command}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function ready(id = documentId) {
  await waitFor(() => expect(screen.getByTestId('ink-board-editor')).toHaveAttribute('data-document-id', id));
  await waitFor(() => expect(screen.getByTestId('ink-board-overview-state')).toHaveAttribute('data-state', 'ready'));
}

function startGesture(x = 10) {
  const canvas = screen.getByTestId('ink-board-canvas');
  fireEvent.pointerDown(canvas, { pointerId: 7, pointerType: 'pen', button: 0, buttons: 1, clientX: x, clientY: 10 });
  fireEvent.pointerMove(canvas, { pointerId: 7, pointerType: 'pen', buttons: 1, clientX: x + 20, clientY: 30 });
  return canvas;
}

function endGesture(canvas: HTMLElement) {
  fireEvent.pointerUp(canvas, { pointerId: 7, pointerType: 'pen', button: 0, clientX: 30, clientY: 30 });
}

async function flush(id = documentId) {
  const result = await act(async () => flushInkEditor(id));
  expect(result).toEqual({ ok: true });
}

describe('InkBoardEditor registered host flush', () => {
  it('journals and canonical-saves the unlifted final pen gesture without a second session', async () => {
    render(<InkBoardEditor documentId={documentId} />);
    await ready();
    const canvas = startGesture();
    expect(saves).toHaveLength(0);
    await flush();

    expect(saves).toHaveLength(1);
    const savedStroke = saves[0].changed[0].objects[0];
    expect(savedStroke.content.kind).toBe('stroke');
    if (savedStroke.content.kind !== 'stroke') throw new Error('Missing saved stroke.');
    expect(savedStroke.content.samples.map(({ x, y }) => ({ x, y }))).toEqual([{ x: 10, y: 10 }, { x: 30, y: 30 }]);
    expect(journalAtCas[0]?.changed[0].objects[0]).toEqual(savedStroke);
    expect(hasDirtyInkEditor(documentId)).toBe(false);
    endGesture(canvas);
    await flush();
    expect(saves).toHaveLength(1);
  });

  it('blocks host flush instead of dropping input when the stroke cannot be enqueued', async () => {
    const implementation = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, payload: Record<string, any>) => {
      if (command === 'vfs_ink_get_board_overview') throw new Error('Overview unavailable.');
      return implementation(command, payload);
    });
    render(<InkBoardEditor documentId={documentId} />);
    await waitFor(() => expect(screen.getByTestId('ink-board-overview-state')).toHaveAttribute('data-state', 'error'));
    startGesture();

    expect(await act(async () => flushInkEditor(documentId))).toEqual({ ok: false, code: 'EDITOR_BUSY' });
    expect(saves).toHaveLength(0);
    mocks.invoke.mockImplementation(implementation);
    fireEvent.click(screen.getByTestId('ink-board-overview-retry'));
    await ready();
    await flush();
    expect(saves).toHaveLength(1);
    expect(saves[0].changed[0].objects).toHaveLength(1);
  });

  it('waits for a pointerup commit to finish journaling before the canonical save', async () => {
    render(<InkBoardEditor documentId={documentId} />);
    await ready();
    const gate = deferred();
    vi.mocked(inkBoardDraftJournal.persist).mockImplementationOnce(async (record) => {
      await gate.promise;
      drafts.set(record.document_id, structuredClone(record));
    });
    const canvas = startGesture();
    endGesture(canvas);
    let pending!: ReturnType<typeof flushInkEditor>;
    let finished = false;
    act(() => {
      pending = flushInkEditor(documentId).then((result) => { finished = true; return result; });
    });
    await act(async () => undefined);
    expect(saves).toHaveLength(0);
    expect(finished).toBe(false);
    await act(async () => { gate.resolve(); expect(await pending).toEqual({ ok: true }); });
    expect(saves).toHaveLength(1);
    expect(journalAtCas[0]?.changed[0].objects).toHaveLength(1);
  });

  it('canonical-saves an unfinished eraser gesture before reporting host flush success', async () => {
    render(<InkBoardEditor documentId={documentId} />);
    await ready();
    startGesture();
    await flush();
    const chunkId = saves[0].changed[0].chunk_id;
    fireEvent.click(screen.getByTestId('ink-board-eraser-tool'));
    const canvas = startGesture();
    await flush();

    expect(saves).toHaveLength(2);
    expect(saves[1].deleted).toEqual([chunkId]);
    expect(chunks.size).toBe(0);
    expect(journalAtCas[1]?.deleted).toEqual([chunkId]);
    endGesture(canvas);
    await flush();
    expect(saves).toHaveLength(2);
  });

  it('does not commit a gesture from a replaced remote epoch through the new view', async () => {
    render(<InkBoardEditor documentId={documentId} />);
    await ready();
    startGesture();
    documents.set(documentId, { ...manifest(documentId), revision: 'remote-2' });
    await act(async () => {
      await mocks.listener?.({ payload: { document_id: documentId, revision: 'remote-2' } });
    });
    await ready();
    await flush();
    expect(saves).toHaveLength(0);

    startGesture(70);
    await flush();
    expect(saves).toHaveLength(1);
    expect(saves[0].expected_revision).toBe('remote-2');
    const content = saves[0].changed[0].objects[0].content;
    expect(content.kind === 'stroke' ? content.samples[0].x : null).toBe(70);
  });

  it('rejects old-view input when the hook already received a remote epoch before React renders it', async () => {
    render(<InkBoardEditor documentId={documentId} />);
    await ready();
    startGesture();
    documents.set(documentId, { ...manifest(documentId), revision: 'remote-2' });
    await act(async () => {
      await mocks.listener?.({ payload: { document_id: documentId, revision: 'remote-2' } });
      expect(await flushInkEditor(documentId)).toEqual({ ok: false, code: 'EDITOR_BUSY' });
    });
    expect(saves).toHaveLength(0);
    expect(drafts.has(documentId)).toBe(false);
    await ready();
  });

  it('does not commit the old document gesture when the editor is retargeted', async () => {
    const nextId = 'board-host-flush-next';
    documents.set(nextId, manifest(nextId));
    const { rerender } = render(<InkBoardEditor documentId={documentId} />);
    await ready();
    startGesture();
    rerender(<InkBoardEditor documentId={nextId} />);
    await ready(nextId);
    await flush(documentId);
    await flush(nextId);
    expect(saves).toHaveLength(0);

    startGesture(70);
    await flush(nextId);
    expect(saves).toHaveLength(1);
    expect(saves[0].document_id).toBe(nextId);
    const content = saves[0].changed[0].objects[0].content;
    expect(content.kind === 'stroke' ? content.samples[0].x : null).toBe(70);
  });
});
