import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupMemoryHost, type MemoryHost } from './support.ts';
import type {
  MemoryRetrievalService, MemoryWriteOutput, GenerativeResearchPort,
  AttachmentConfigStore,
} from '../api.ts';
import type { NoteDeleteHook, VfsHandlersHooks } from '../../vfs-handlers/api.ts';
import type { FusedRetrievalHit } from '../../vfs-index/api.ts';

let current: MemoryHost | undefined;
afterEach(async () => { await current?.dispose(); current = undefined; vi.unstubAllEnvs(); });

function fused(resourceId: string, text: string, score: number): FusedRetrievalHit {
  return {
    hit: {
      identity: { resourceId, chunkIndex: 0, pageIndex: null, timeRange: null },
      embeddingId: '', text, title: null, resourceType: 'note', sourceId: null,
      folderId: null, blobHash: null, imageUrl: null, rawScore: null, metadata: null,
    },
    rrfScore: score, normalizedScore: null, rerankScore: null, provenance: [],
  };
}

function retrievalResponse(hits: FusedRetrievalHit[], topK: number) {
  return {
    capabilitySnapshot: {} as never,
    plan: { queryModality: 'text' as const, topK, routes: [], imageFallbackChain: [] },
    result: { hits, failures: [] },
    queryDerivations: [],
  };
}

function memoryRetrieval(host: MemoryHost): MemoryRetrievalService {
  return host.host.ctx.get('memoryRetrieval') as MemoryRetrievalService;
}

describe('L13 memoryRetrieval port', () => {
  it('exposes the configured root id without creating a folder', async () => {
    current = await setupMemoryHost();
    expect(memoryRetrieval(current).getRootFolderId()).toBeNull();
    await current.host.invoke('memory_get_or_create_root_folder');
    const rootId = current.db.pluck<string>(
      "SELECT value FROM memory_config WHERE key = 'memory_root_folder_id'");
    expect(rootId).toBeTruthy();
    expect(memoryRetrieval(current).getRootFolderId()).toBe(rootId);
  });

  it('search forwards query/topK and returns real memory rows', async () => {
    current = await setupMemoryHost();
    const written = await current.host.invoke('memory_write', {
      title: 'Signal memory', content: 'signal cancellation token',
    }) as MemoryWriteOutput;
    current.retrieval.responder = request =>
      retrievalResponse([fused(written.resourceId, 'signal cancellation token', 1)], request.topK);

    const results = await memoryRetrieval(current).search('signal', 4, null);
    expect(results).toHaveLength(1);
    expect(results[0]!.noteId).toBe(written.noteId);
    expect(current.retrieval.requests.at(-1)!.topK).toBe(12);
  });

  it('search rejects before calling retrieval when the signal is already aborted', async () => {
    current = await setupMemoryHost();
    const controller = new AbortController();
    controller.abort();
    const requestsBefore = current.retrieval.requests.length;
    await expect(memoryRetrieval(current).search('q', 3, controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(current.retrieval.requests).toHaveLength(requestsBefore);
  });

  it('search aborts the in-flight route instead of waiting for the retrieval result', async () => {
    current = await setupMemoryHost();
    let resolveRetrieval!: (value: ReturnType<typeof retrievalResponse>) => void;
    current.retrieval.responder = () => new Promise(resolve => { resolveRetrieval = resolve; });
    const controller = new AbortController();
    const pending = memoryRetrieval(current).search('q', 3, controller.signal);
    await expect.poll(() => current!.retrieval.requests.length).toBe(1);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    // The owner result no longer leaks into memory post-processing/hit counters.
    resolveRetrieval(retrievalResponse([], 9));
    await Promise.resolve();
    expect(current.db.pluck<number>(
      "SELECT COUNT(*) FROM notes WHERE tags LIKE '%_last_hit%'")).toBe(0);
  });

  it('search passes the same signal to the cancellable retrieval provider', async () => {
    let received: AbortSignal | null = null;
    let providerAborted = false;
    current = await setupMemoryHost({
      retrievalCancellable: {
        search: (_request, signal) => {
          received = signal;
          return new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => {
              providerAborted = true;
              reject(new Error('provider cancelled'));
            }, { once: true });
          });
        },
      },
    });
    const controller = new AbortController();
    const pending = memoryRetrieval(current).search('q', 3, controller.signal);
    await expect.poll(() => received !== null, { timeout: 3000 }).toBe(true);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(received).toBe(controller.signal);
    expect(providerAborted).toBe(true);
  });

  it('compress passes short results through without a model call', async () => {
    current = await setupMemoryHost({ memoryDecision: () => { throw new Error('must not be called'); } });
    const results = await memoryRetrieval(current).compress('q', [
      { noteId: 'note_a', noteTitle: 'A', folderPath: 'x', chunkText: 'short', score: 0.5 },
    ]);
    expect(results).toEqual([
      { noteId: 'note_a', noteTitle: 'A', folderPath: 'x', chunkText: 'short', score: 0.5, sourceNoteIds: [] },
    ]);
    expect(current.memoryDecision!.calls).toHaveLength(0);
  });

  it('compress uses the real MemoryCompressor prompt and summary shape', async () => {
    current = await setupMemoryHost({ memoryDecision: () => '压缩后的摘要' });
    const long = 'x'.repeat(200);
    const results = await memoryRetrieval(current).compress('query topic', [
      { noteId: 'note_a', noteTitle: 'A', folderPath: '数学', chunkText: long, score: 0.8 },
      { noteId: 'note_b', noteTitle: 'B', folderPath: '英语', chunkText: long, score: 0.4 },
    ]);
    expect(results).toEqual([{
      noteId: null, noteTitle: '用户记忆摘要', folderPath: '',
      chunkText: '本条为 2 条记忆的压缩摘要，可用 memory_read 按 sourceNoteIds 中的 ID 查看原文。\n压缩后的摘要',
      score: 0.8, sourceNoteIds: ['note_a', 'note_b'],
    }]);
    expect(current.memoryDecision!.calls[0]!.prompt).toContain('## 当前查询\nquery topic');
    expect(current.memoryDecision!.calls[0]!.prompt).toContain('1. [数学] A: ');
  });

  it('compress falls back to originals when the model fails', async () => {
    current = await setupMemoryHost({
      memoryDecision: () => { throw new Error('model down'); },
    });
    const long = 'y'.repeat(301);
    const failed = await memoryRetrieval(current).compress('q', [
      { noteId: 'note_a', noteTitle: 'A', folderPath: '', chunkText: long, score: 0.2 },
    ]);
    expect(failed).toEqual([
      { noteId: 'note_a', noteTitle: 'A', folderPath: '', chunkText: long, score: 0.2, sourceNoteIds: [] },
    ]);
    expect(current.warnings.some(message => message.includes('LLM compression failed'))).toBe(true);
  });

  it('compress falls back to originals when the model returns blank', async () => {
    current = await setupMemoryHost({ memoryDecision: () => '   ' });
    const long = 'y'.repeat(301);
    const blank = await memoryRetrieval(current).compress('q', [
      { noteId: 'note_a', noteTitle: 'A', folderPath: '', chunkText: long, score: 0.2 },
    ]);
    expect(blank[0]!.noteId).toBe('note_a');
    expect(current.warnings.some(message => message.includes('LLM returned empty'))).toBe(true);
  });
});

describe('L13 memoryConfig port', () => {
  it('reads and writes memory_config with SQLite datetime(now)', async () => {
    current = await setupMemoryHost();
    const store = current.host.ctx.get('memoryConfig') as AttachmentConfigStore;
    expect(store.get('missing_key')).toBeNull();
    store.set('attachment_root_folder_id', 'folder_123');
    expect(store.get('attachment_root_folder_id')).toBe('folder_123');
    const row = current.db.get<{ value: string; updatedAt: string }>(
      "SELECT value, updated_at AS updatedAt FROM memory_config WHERE key = 'attachment_root_folder_id'");
    expect(row?.value).toBe('folder_123');
    expect(row?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});

describe('L13 hpiasResearch port', () => {
  it('ignores non-research intents and starts the timeline for research blocks', async () => {
    current = await setupMemoryHost({ memoryConfig: { hpiasBackend: 'stub' } });
    const service = current.host.ctx.get('hpiasResearch') as GenerativeResearchPort;
    const events: Array<Record<string, unknown>> = [];
    current.host.ctx.backendEvents.listen('hpias_event', payload => {
      events.push(payload as Record<string, unknown>);
    });

    service.startFromIntent({
      window: { window: 'main', webview: 'main' }, sessionId: 's0', title: 'text',
      intent: { blocks: [{ type: 'text', props: { text: 'hi' } }] },
    });
    await new Promise(resolve => setTimeout(resolve, 450));
    expect(events).toHaveLength(0);

    service.startFromIntent({
      window: { window: 'main', webview: 'main' }, sessionId: 's1', title: '研究问题',
      intent: { blocks: [{ type: 'research-plan', props: { steps: [{ label: 'Q1' }] } }] },
    });
    expect(events[0]!).toMatchObject({
      type: 'session_started', session_id: 's1', question: '研究问题',
    });
    await expect.poll(() => events.length, { timeout: 3000 }).toBeGreaterThanOrEqual(2);
    expect(events[1]!).toMatchObject({
      type: 'round_started', session_id: 's1', round: 1,
    });
  });
});

describe('memory note-delete hook', () => {
  function hookRecorder(): { hooks: VfsHandlersHooks; registered: NoteDeleteHook[] } {
    const registered: NoteDeleteHook[] = [];
    return {
      registered,
      hooks: {
        version: 1 as const,
        registerNoteDeleteHook(hook) {
          registered.push(hook);
          return () => {
            const index = registered.indexOf(hook);
            if (index >= 0) registered.splice(index, 1);
          };
        },
      },
    };
  }

  it('captures only memory notes and cleans up after deletion', async () => {
    const recorder = hookRecorder();
    current = await setupMemoryHost({ vfsHooks: recorder.hooks });
    expect(recorder.registered).toHaveLength(1);

    const written = await current.host.invoke('memory_write', {
      title: 'To delete', content: 'delete me',
    }) as MemoryWriteOutput;
    const continuation = recorder.registered[0]!.captureDelete(written.noteId);
    expect(continuation).not.toBeNull();
    continuation!();

    await expect.poll(() => current!.index.deleted).toContain(written.resourceId);
    const audit = current.db.get<{ operation: string; note_id: string; source: string }>(
      "SELECT operation, note_id, source FROM memory_audit_log WHERE note_id = ?1 AND operation = 'delete'",
      [written.noteId]);
    expect(audit).toMatchObject({ operation: 'delete', note_id: written.noteId, source: 'handler' });
  });

  it('returns null for notes outside the memory root', async () => {
    const recorder = hookRecorder();
    current = await setupMemoryHost({ vfsHooks: recorder.hooks });
    const outside = current.notes.repository.createNote({ title: 'Outside', content: 'not memory' },
      current.db);
    expect(recorder.registered[0]!.captureDelete(outside.id)).toBeNull();
  });
});
