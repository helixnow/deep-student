/** `retrievalCancellable`: the published `retrieval` search entry points under the tool executor's
 * cancellation (builtin_retrieval_executor.rs:299-321), against the real L12 retriever.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getEventListeners } from 'node:events';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import reposPlugin from '../../vfs-repos/index.ts';
import notesPlugin from '../../notes/index.ts';
import plugin from '../index.ts';
import type { UnifiedRetrievalRequest, UnifiedRetrievalResponse } from '../api.ts';
import { pathsServiceDouble } from './support/paths-service.ts';

let root: string;
let storage: ReturnType<typeof createStorageService>;
let host: TestHost;
let resourceId: string;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-retrieval-cancellable-'));
  storage = createStorageService({ baseDir: root, dataLocalDir: path.join(root, 'local') });
  const report = await storage.migrations.runAll();
  if (!report.success) throw new Error(report.error ?? 'migration failed');
  host = await createTestHost({ plugins: [reposPlugin, notesPlugin, plugin],
    provide: { storage, paths: pathsServiceDouble(), settings: { get: () => null } } });
  const content = '特征值分解把矩阵写成 PDP⁻¹';
  const note = host.ctx.notes.repository.createNote({ title: '线性代数', content, tags: [] }, storage.database('vfs'));
  resourceId = note.resourceId;
  expect(host.ctx.vfsUnitBuilder.syncResourceUnits({ resourceId, resourceType: 'note', data: content })).toHaveLength(1);
}, 180_000);
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => {
  await host?.dispose();
  storage?.dispose();
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
});

const request = (queryText: string | null = '特征值'): UnifiedRetrievalRequest => ({ queryText, queryImageBase64: null,
  queryImageMediaType: null, queryModality: 'text', topK: 10, folderIds: null, resourceIds: null, resourceTypes: null });
function deferred() {
  let resolve!: (value: UnifiedRetrievalResponse) => void, reject!: (error: Error) => void;
  const promise = new Promise<UnifiedRetrievalResponse>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
const abortError = { name: 'AbortError', message: 'retrieval cancelled' };

it('returns the published retrieval result for a live or absent signal and releases its abort listener', async () => {
  const expected = await host.ctx.retrieval.search(request());
  expect(expected.result.hits.map(fused => fused.hit.identity.resourceId)).toEqual([resourceId]);
  const signal = new AbortController().signal;
  expect(await host.ctx.retrievalCancellable.search(request(), signal)).toEqual(expected);
  expect(getEventListeners(signal, 'abort')).toHaveLength(0);
  expect(await host.ctx.retrievalCancellable.search(request(), null)).toEqual(expected);
});

it('forwards each entry point to the matching retrieval method and rejects with its error', async () => {
  const search = vi.spyOn(host.ctx.retrieval, 'search');
  const multimodal = vi.spyOn(host.ctx.retrieval, 'searchMultimodal');
  const signal = new AbortController().signal;
  await host.ctx.retrievalCancellable.searchMultimodal(request(), signal);
  expect(multimodal).toHaveBeenCalledWith(request());
  expect(search).not.toHaveBeenCalled();
  await expect(host.ctx.retrievalCancellable.search(request(null), signal))
    .rejects.toThrow("Invalid argument 'query': query payload does not match Text mode (text=false, image=false)");
  expect(search).toHaveBeenCalledWith(request(null));
  expect(getEventListeners(signal, 'abort')).toHaveLength(0);
});

it('starts no retrieval when the signal is already aborted', async () => {
  const search = vi.spyOn(host.ctx.retrieval, 'search');
  const multimodal = vi.spyOn(host.ctx.retrieval, 'searchMultimodal');
  const controller = new AbortController();
  controller.abort();
  await expect(host.ctx.retrievalCancellable.search(request(), controller.signal)).rejects.toMatchObject(abortError);
  await expect(host.ctx.retrievalCancellable.searchMultimodal(request(), controller.signal)).rejects.toMatchObject(abortError);
  expect(search).not.toHaveBeenCalled();
  expect(multimodal).not.toHaveBeenCalled();
});

it.each(['resolves', 'rejects'] as const)('settles at abort and discards a retrieval that later %s', async outcome => {
  const late = await host.ctx.retrieval.search(request());
  const pending = deferred();
  vi.spyOn(host.ctx.retrieval, 'search').mockReturnValue(pending.promise);
  const controller = new AbortController();
  const result = host.ctx.retrievalCancellable.search(request(), controller.signal);
  controller.abort();
  await expect(result).rejects.toMatchObject(abortError);
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  if (outcome === 'resolves') pending.resolve(late);
  else pending.reject(new Error('route failed after cancellation'));
  await expect(pending.promise.then(() => 'settled', () => 'settled')).resolves.toBe('settled');
});
