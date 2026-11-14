import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkModulesClosure } from '../../../../scripts/portability/lib/portability.mjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import type { ExecutionContext, ToolExecutor } from '../../chat/api.ts';
import type { PaperLibraryPort } from '../../memory/api.ts';
import * as vfsReposApi from '../../vfs-repos/api.ts';
import { buildNumberedSources, type VfsService } from '../api.ts';
import plugin from '../index.ts';
import indexPlugin from '../../vfs-index/index.ts';
import pathsPlugin from '../../../platform/paths/index.ts';
// boundary-allow cross-plugin-impl: install real L10 notes plugin required by vfs
import notesPlugin from '../../notes/index.ts';
// boundary-allow cross-plugin-impl: install real L11 vfs-repos plugin; files/blobs are written only through it
import reposPlugin from '../../vfs-repos/index.ts';
// boundary-allow cross-plugin-impl: the real memory paper_save executor is the consumer of the published port
import { PaperSaveExecutor } from '../../memory/src/paper-save-executor.ts';
import { createNodeCrypto } from '../../../platform/crypto/index.ts';

const ownerPublished = typeof (vfsReposApi as unknown as { mediaKind?: unknown }).mediaKind === 'function';
const PDF = new TextEncoder().encode('%PDF-1.4\n% paper_save body\n%%EOF\n');

describe.skipIf(!ownerPublished)('vfs paperLibrary service (paper_save_executor.rs:582-740)', { timeout: 60_000 }, () => {
  let root: string;
  let storage: ReturnType<typeof createStorageService>;
  let host: TestHost;
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-paper-library-'));
    storage = createStorageService({ baseDir: root, dataLocalDir: root });
    const report = await storage.migrations.runAll();
    expect(report.success, report.error ?? '').toBe(true);
    host = await createTestHost({ plugins: [pathsPlugin, notesPlugin, reposPlugin, indexPlugin, plugin], provide: {
      storage,
      memoryConfig: { get: () => null, set: () => undefined },
      settings: { get: () => null },
      docs: { isPlainTextCodeExtension: () => false },
    }, app: { dataDir: root } });
  }, 120_000);
  afterAll(async () => {
    await host?.dispose(); storage?.dispose(); fs.rmSync(root, { recursive: true, force: true });
  });
  const library = () => host.ctx.get('paperLibrary') as PaperLibraryPort | undefined;

  it('publishes paperLibrary; blob, file row and sha256 lookup go through the VFS owner', () => {
    const port = library();
    expect(port).toBeDefined();
    const sha256 = createHash('sha256').update(PDF).digest('hex');
    expect(port!.getFileBySha256(sha256)).toBeNull();
    const blobHash = port!.storeBlob(PDF);
    expect(blobHash).toBe(sha256);
    const file = port!.createFile({ sha256, fileName: 'p.pdf', sizeBytes: PDF.length, blobHash, folderId: null,
      previewJson: null, extractedText: 'body', pageCount: 2 });
    expect(file).toMatchObject({ pageCount: 2, extractedText: 'body', previewJson: null });
    expect(file.id).toMatch(/^file_/);
    expect(file.resourceId).toEqual(expect.any(String));
    expect(port!.getFileBySha256(sha256)).toEqual({ id: file.id, status: 'active' });
    expect(typeof port!.startPipeline).toBe('function');
  });

  it('the real memory PaperSaveExecutor saves through it instead of "VFS database not available"', async () => {
    const body = new TextEncoder().encode('%PDF-1.4\n% executor body\n%%EOF\n');
    const executor: ToolExecutor = new PaperSaveExecutor({
      http: () => ({ fetch: async () => new Response(body, { status: 200 }) }),
      publicHttp: () => ({ fetch: async () => new Response(body, { status: 200 }) }),
      library: () => library() ?? null,
      crypto: () => createNodeCrypto(),
      log: { debug() {}, info() {}, warn() {}, error() {} },
    });
    const ctx = {
      session_id: 's', message_id: 'm', block_id: 'b', variant_id: null, cancellation_token: null,
      isCancelled: () => false, emitter: { emitChunk() {} },
      emitToolCallStart() {}, emitToolCallEnd() {}, emitToolCallError() {}, saveToolBlock() {},
    } as unknown as ExecutionContext;
    const args = { papers: [{ title: 'A/B paper', url: 'https://papers.test/a.pdf' }] };
    const first = await executor.execute({ id: 'c1', name: 'builtin-paper_save', arguments: args }, ctx);
    const output = first.output as { success_count: number; results: Array<Record<string, unknown>> };
    expect(output.success_count, JSON.stringify(output)).toBe(1);
    expect(output.results[0]).toMatchObject({ success: true, deduplicated: false, file_name: 'A_B paper.pdf' });
    const sha256 = createHash('sha256').update(body).digest('hex');
    expect(library()!.getFileBySha256(sha256)?.id).toBe(output.results[0]!.file_id);

    const second = await executor.execute({ id: 'c2', name: 'builtin-paper_save', arguments: args }, ctx);
    expect((second.output as typeof output).results[0]).toMatchObject({ success: true, deduplicated: true,
      file_id: output.results[0]!.file_id });
  });

  it('exports buildNumberedSources for consumers with their own per-reply ledger', () => {
    const counters = new Map<string, number>();
    const ledger = { assign: (group: string) => {
      const next = (counters.get(group) ?? 0) + 1; counters.set(group, next); return { type_index: next, is_new: true };
    } };
    const rows = buildNumberedSources([{ title: 'Doc', snippet: 's', metadata: { sourceType: 'memory', noteId: 'n1' } }], ledger);
    expect(rows[0]).toMatchObject({ index: 1, citationTag: '[记忆-1]', noteId: 'n1', source_type: 'memory' });
  });

  it('the vfs service carries the same buildNumberedSources, and its module closure loads no Node module', () => {
    const service = host.ctx.get('vfs') as VfsService;
    expect(service.buildNumberedSources).toBe(buildNumberedSources);
    const ledger = { assign: () => ({ type_index: 7, is_new: true }) };
    expect(service.buildNumberedSources([{ title: 'Doc', snippet: 's', metadata: { sourceType: 'memory', noteId: 'n2' } }], ledger)[0])
      .toMatchObject({ citationTag: '[记忆-7]', noteId: 'n2' });
    const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
    expect(checkModulesClosure(repoRoot, ['host/plugins/vfs/src/tools/retrieval-sources.ts'])).toEqual([]);
  });
});
