import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import { createSettingsService } from '../../../platform/settings/index.ts';
import { BackendEventsSink, ChatV2Emitter } from '../../chat/api.ts';
import pathsPlugin from '../../../platform/paths/index.ts';
import agentPlugin from '../../agent-skills/index.ts';
import workspacePlugin from '../../agent-workspace/index.ts';
import type { FusedRetrievalHit, UnifiedRetrievalRequest, UnifiedRetrievalResponse } from '../../vfs-index/api.ts';
import type { MemorySearchResult } from '../../memory/api.ts';
import { defaultToolConfig, type SearchInput, type SearchResult } from '../../mcp/api.ts';
import notesPlugin from '../../notes/index.ts';
import reposPlugin from '../../vfs-repos/index.ts';
import chatPlugin from '../../chat/index.ts';
import pipelinePlugin from '../../chat-pipeline/index.ts';
import plugin from '../index.ts';
import { BuiltinRetrievalExecutor, type RetrievalToolContext, type MemoryRetrievalPort } from '../src/tools/retrieval-executor.ts';
import type { RetrievalRerankerPort } from '../src/tools/retrieval-rerank.ts';

let template: string | undefined;
let templatePromise: Promise<string> | undefined;
beforeAll(async () => { await schema(); }, 120_000);
afterAll(() => { if (template) fs.rmSync(template, { recursive: true, force: true }); });
async function schema(): Promise<string> {
  templatePromise ??= (async () => {
    template = fs.mkdtempSync(path.join(os.tmpdir(), 'retrieval-schema-'));
    const storage = createStorageService({ baseDir: template, dataLocalDir: template });
    try { const report = await storage.migrations.runAll(); expect(report.success, report.error ?? '').toBe(true); }
    finally { storage.dispose(); }
    return template;
  })();
  return templatePromise;
}
const available = { configured: true, healthy: true, circuitOpen: false, protocolCompatible: true, indexCompatible: true };
export function response(hits: FusedRetrievalHit[] = []): UnifiedRetrievalResponse {
  return { result: { hits, failures: [] }, queryDerivations: [], plan: { queryModality: 'text', topK: 10, routes: [], imageFallbackChain: [] },
    capabilitySnapshot: { textEmbedding: available, multimodalEmbedding: available, textModel: available, multimodalModel: available, ocr: available } };
}
export function hit(id: string, score = .9): FusedRetrievalHit {
  return { rrfScore: score, normalizedScore: score, provenance: [], hit: { identity: { resourceId: id, chunkIndex: 0, pageIndex: null }, embeddingId: `emb_${id}`,
    text: `Text ${id}`, title: `Title ${id}`, resourceType: 'note', sourceId: `note_${id}`, folderId: null, blobHash: null, imageUrl: null, rawScore: score, metadata: null } };
}
export async function retrievalHost(options: {
  search?: (request: UnifiedRetrievalRequest, signal: AbortSignal | null) => Promise<UnifiedRetrievalResponse>;
  searchMultimodal?: (request: UnifiedRetrievalRequest, signal: AbortSignal | null) => Promise<UnifiedRetrievalResponse>;
  memorySearch?: (query: string, topK: number, signal: AbortSignal | null) => Promise<MemorySearchResult[]>;
  memory?: Omit<MemoryRetrievalPort, 'search'>;
  reranker?: RetrievalRerankerPort;
  web?: (request: SearchInput, signal: AbortSignal | null) => Promise<SearchResult>;
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'retrieval-tool-'));
  fs.cpSync(await schema(), root, { recursive: true });
  const storage = createStorageService({ baseDir: root, dataLocalDir: root });
  const settings = createSettingsService({ db: () => storage.database('mistakes'), secureStore: () => null, secrets: { isSensitiveKey: () => false } });
  const reranker: RetrievalRerankerPort = options.reranker ?? {
    async getRerankerModelConfig() { throw new Error('No reranker configured'); },
    async getVlRerankerModelConfig() { throw new Error('No VL reranker configured'); },
    async callRerankerApi() { throw new Error('Unexpected text rerank call without configured model'); },
    async callMultimodalRerankerApi() { throw new Error('Unexpected VL rerank call without configured model'); },
  };
  const search = vi.fn(options.search ?? (async () => response()));
  const searchMultimodal = vi.fn(options.searchMultimodal ?? (async () => response()));
  const memorySearch = vi.fn(options.memorySearch ?? (async () => []));
  const web = vi.fn(options.web ?? (async () => ({ name: 'web_search', ok: true, citations: [] })));
  const host = await createTestHost({ plugins: [pathsPlugin, agentPlugin, workspacePlugin, notesPlugin, reposPlugin, plugin, chatPlugin, pipelinePlugin],
    app: { dataDir: root }, provide: { storage, settings, nativeTokenizer: {},
      vfsIndex: { lance: {} }, retrievalCancellable: { search, searchMultimodal }, llm: {}, llmReranker: reranker,
      memoryRetrieval: { search: memorySearch, ...(options.memory ?? { getRootFolderId: () => null, compress: async (_query: string, rows: MemorySearchResult[]) => rows.map(row => ({ ...row, sourceNoteIds: [] })) }) },
      webSearch: { loadConfig: async () => defaultToolConfig(),
        doSearch: (_config: unknown, input: SearchInput, signal: AbortSignal | null) => web(input, signal) },
    } });
  const executor = host.ctx.agentTools.toolExecutors().find(e => e.name() === 'BuiltinRetrievalExecutor' && e.canHandle('rag_search')) as BuiltinRetrievalExecutor;
  expect(executor).toBeDefined();
  function context(signal: AbortSignal | null = null): RetrievalToolContext {
    return { session_id: 'sess_retrieval', message_id: `msg_${path.basename(root)}`, block_id: 'blk_retrieval', variant_id: null,
      chat_v2_db: host.ctx.chatSession.database, services: host.ctx, emitter: new ChatV2Emitter(new BackendEventsSink(host.ctx.backendEvents), 'sess_retrieval', false),
      isCancelled: () => signal?.aborted ?? false, cancellation_token: signal, rag_top_k: null, rag_enable_reranking: null, memory_enabled: true };
  }
  return { host, root, storage, executor, search, searchMultimodal, memorySearch, web, context,
    async dispose() { await host.dispose(); storage.dispose(); fs.rmSync(root, { recursive: true, force: true }); } };
}
