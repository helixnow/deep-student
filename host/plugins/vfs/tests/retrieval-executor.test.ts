import { expect, it } from 'vitest';
import type { SourceInfo } from '../../chat/api.ts';
import type { CitationLedger } from '../../chat-pipeline/api.ts';
import { stripToolNamespace } from '../../agent-skills/api.ts';
import { applyScoreThresholds, buildNumberedSources, citationGroup, citationPrefix, dedupKbAgainstMemory,
  plannedSearchScope, preferredReadResourceId, scopeFolderIds, selectRerankerKind, shouldRouteToUnifiedSearch,
  truncateSnippetChars } from '../src/tools/retrieval-sources.ts';
import { BuiltinRetrievalExecutor, localizedRetrievalFailure } from '../src/tools/retrieval-executor.ts';
import { retrievalHost } from './retrieval-host.ts';

function scored(title: string, score: number): SourceInfo { return { title, snippet: `Content of ${title}`, score: Math.fround(score) }; }
function kb(title: string): SourceInfo { return { title, snippet: 'kb text', score: Math.fround(.8), metadata: {
  sourceType: 'text_search', resourceType: 'note', resourceId: `res_kb_${title}`, sourceId: `note_${title}` } }; }
function mm(title: string): SourceInfo { return { title, snippet: 'page text', score: Math.fround(.7), metadata: {
  sourceType: 'multimodal_search', pageIndex: 0, blobHash: 'hash123' } }; }
function memory(title: string, id: string): SourceInfo { return { title, snippet: 'memory text', score: Math.fround(.9),
  metadata: { sourceType: 'memory', noteId: id, folderPath: '偏好' } }; }
async function withHost(work: (h: Awaited<ReturnType<typeof retrievalHost>>) => Promise<void> | void) {
  const host = await retrievalHost();
  try { await work(host); } finally { await host.dispose(); }
}
const withLedger = (work: (ledger: CitationLedger) => void) => withHost(h => work(h.host.ctx.chatPipeline.citationLedgerForReply('sess', h.root)));
const silentDebug = { debug() { /* Dependency logger; assertions target source transformations. */ } };

it('test_can_handle', () => withHost(h => {
  expect(h.executor).toBeInstanceOf(BuiltinRetrievalExecutor);
  const value = new BuiltinRetrievalExecutor(h.executor.deps);
  const registered = h.host.ctx.agentTools.toolExecutors().filter(e => e.name() === 'BuiltinRetrievalExecutor');
  for (const name of ['builtin-rag_search', 'builtin-multimodal_search', 'builtin-unified_search', 'builtin-web_search', 'rag_search']) {
    expect(value.canHandle(name)).toBe(true);
    expect(registered.filter(e => e.canHandle(name))).toHaveLength(1);
  }
  for (const name of ['builtin-memory_search', 'note_read', 'mcp_brave_search']) {
    expect(value.canHandle(name)).toBe(false);
    expect(registered.some(e => e.canHandle(name))).toBe(false);
  }
}));
it('test_strip_namespace', () => {
  expect(stripToolNamespace('builtin-rag_search')).toBe('rag_search');
  expect(stripToolNamespace('builtin-web_search')).toBe('web_search');
  expect(stripToolNamespace('rag_search')).toBe('rag_search');
});
it('test_sensitivity_level', () => withHost(h => expect(h.executor.sensitivityLevel('builtin-rag_search')).toBe('low')));
it('score_thresholds_filter_low_scores_with_absolute_min', () => {
  expect(applyScoreThresholds([scored('Doc1', .9), scored('Doc2', .5), scored('Doc3', .2)], .3, .5).map(s => s.title)).toEqual(['Doc1', 'Doc2']);
});
it('score_thresholds_keep_top1_when_all_below_absolute_min', () => {
  expect(applyScoreThresholds([scored('Doc1', .2), scored('Doc2', .1)], .3, .5).map(s => s.title)).toEqual(['Doc1']);
});
it('score_thresholds_apply_relative_only_for_rrf_scale', () => {
  expect(applyScoreThresholds([scored('Doc1', .032), scored('Doc2', .016), scored('Doc3', .010)], null, .5)).toHaveLength(2);
});
it('snippet_truncation_respects_budget', () => {
  expect(truncateSnippetChars('abcdef', 4)).toEqual(['abc…', 4]);
  expect(truncateSnippetChars('abc', 10)).toEqual(['abc', 3]);
  expect(truncateSnippetChars('abc', 0)).toEqual(['', 0]);
});
it('numbered_sources_use_type_local_citation_indexes', () => withLedger(ledger => {
  const rows = buildNumberedSources([kb('DocA'), mm('Page 1'), kb('DocB'), memory('用户偏好', 'note_mem_1')], ledger);
  expect(rows[0]).toMatchObject({ citationTag: '[知识库-1]', typeIndex: 1 });
  expect(rows[1]!.citationTag).toBe('[图片-1]');
  expect(rows[2]).toMatchObject({ citationTag: '[知识库-2]', typeIndex: 2 });
  expect(rows[3]).toMatchObject({ citationTag: '[记忆-1]', note_id: 'note_mem_1', noteId: 'note_mem_1', index: 4 });
}));
it('numbered_sources_expose_multimodal_fields_for_frontend_adapter', () => withLedger(ledger => {
  expect(buildNumberedSources([mm('Page 1')], ledger)[0]).toMatchObject({ source_type: 'multimodal_search', blob_hash: 'hash123', pageIndex: 0 });
}));
it('numbered_sources_carry_media_time_fields_only_for_media_hits', () => withLedger(ledger => {
  const media = kb('lecture'); media.metadata = { ...media.metadata as object, timeRange: { startMs: 90_000, endMs: 180_000 }, mediaCitation: '[媒体@file_lecture:01:30]' };
  const rows = buildNumberedSources([media, kb('plain')], ledger);
  expect(rows[0]).toMatchObject({ timeRange: { startMs: 90_000 }, mediaCitation: '[媒体@file_lecture:01:30]' });
  expect(rows[1]).not.toHaveProperty('timeRange'); expect(rows[1]).not.toHaveProperty('mediaCitation');
}));
it('dedup_removes_memory_notes_from_kb_results', () => {
  expect(dedupKbAgainstMemory([kb('DocA'), kb('DocB')], [memory('用户偏好', 'note_DocA')], silentDebug).map(s => s.title)).toEqual(['DocB']);
});
it('dedup_uses_source_note_ids_for_compressed_memory_entries', () => {
  const compressed: SourceInfo = { title: '用户记忆摘要', snippet: 'compressed summary', score: .9,
    metadata: { sourceType: 'memory', noteId: null, sourceNoteIds: ['note_DocA', 'note_DocB'], folderPath: '' } };
  expect(dedupKbAgainstMemory([kb('DocA'), kb('DocC')], [compressed], silentDebug).map(s => s.title)).toEqual(['DocC']);
});
it('test_route_to_unified_search', () => {
  for (const name of ['rag_search', 'multimodal_search', 'unified_search']) expect(shouldRouteToUnifiedSearch(name)).toBe(true);
  for (const name of ['web_search', 'memory_search']) expect(shouldRouteToUnifiedSearch(name)).toBe(false);
});
it('multimodal_search_uses_dedicated_me_only_scope', () => {
  expect(plannedSearchScope('multimodal_search')).toBe('multimodal_only');
  expect(plannedSearchScope('rag_search')).toBe('unified'); expect(plannedSearchScope('unified_search')).toBe('unified');
});
it('executor_failure_boundary_localizes_retrieval_errors', () => {
  const error = JSON.parse(localizedRetrievalFailure('未配置多模态嵌入模型'));
  expect(error.code).toBe('RETRIEVAL_OPERATION_FAILED'); expect(error.messageKey).toBe('chat.tools.retrieval.error');
  expect(typeof error.messageFallback['en-US']).toBe('string');
});
it('test_citation_prefix_for_source_type', () => {
  expect(citationPrefix('text_search')).toBe('知识库'); expect(citationPrefix('multimodal_search')).toBe('图片'); expect(citationPrefix('memory')).toBe('记忆');
});
it('test_citation_group_for_source_type', () => {
  expect(citationGroup('text_search')).toBe('rag'); expect(citationGroup('multimodal_search')).toBe('multimodal'); expect(citationGroup('memory')).toBe('memory');
});
it('reranker_selection_tracks_query_and_candidate_modality', () => {
  const text: SourceInfo = { snippet: 'text', score: .1, metadata: { sourceType: 'text_search' } };
  expect(selectRerankerKind('text', [text])).toBe('text'); expect(selectRerankerKind('image', [text])).toBe('multimodal');
  expect(selectRerankerKind('text', [{ snippet: 'image page', score: .1, metadata: { sourceType: 'multimodal_search' } }])).toBe('multimodal');
});
it('test_preferred_read_resource_id', () => {
  expect(preferredReadResourceId('res_abc', 'note_1')).toBe('note_1');
  expect(preferredReadResourceId('res_abc', 'res_src')).toBe('res_abc');
  expect(preferredReadResourceId('res_abc', 'not_a_resource_id')).toBe('res_abc');
  expect(preferredReadResourceId('res_abc', null)).toBe('res_abc');
  expect(preferredReadResourceId(null, 'tb_123')).toBe('tb_123'); expect(preferredReadResourceId(null, null)).toBeNull();
});
it('scope_is_a_hard_filter_that_model_args_can_only_narrow', () => {
  const scope = ['fld_course', 'fld_ch1'];
  expect(scopeFolderIds([], ['x'])).toEqual(['x']); expect(scopeFolderIds([], null)).toBeNull();
  expect(scopeFolderIds(scope, null)).toEqual(scope); expect(scopeFolderIds(scope, ['fld_ch1'])).toEqual(['fld_ch1']);
  expect(scopeFolderIds(scope, ['fld_other'])).toEqual(scope);
});

it('emits rag/web_search error events when execution throws after emitStart', async () => {
  const executor = new BuiltinRetrievalExecutor({
    reranker: {} as never,
    memory: { getRootFolderId: () => null, search: async () => [], compress: async () => [] },
    scope: { loadSessionRagScope: () => null },
  });
  const events: Array<{ kind: string; phase: string; payload?: unknown }> = [];
  const makeCtx = (servicesMap: Record<string, unknown>, cancelledAfterStart = false) => {
    let starts = 0;
    return {
      session_id: 's1',
      message_id: 'm1',
      block_id: 'blk_ret',
      variant_id: null,
      chat_v2_db: null,
      rag_top_k: null,
      rag_enable_reranking: null,
      memory_enabled: false,
      cancellation_token: null,
      isCancelled: () => cancelledAfterStart && starts > 0,
      emitter: {
        emitStart: (kind: string, _msg: string, _blk: string, payload: unknown) => {
          starts++;
          events.push({ kind, phase: 'start', payload });
        },
        emitEnd: (kind: string) => { events.push({ kind, phase: 'end' }); },
        emitError: (kind: string) => { events.push({ kind, phase: 'error' }); },
      },
      services: {
        get: (key: string) => servicesMap[key],
        logger: silentDebug,
      },
    } as never;
  };

  const ragRes = await executor.execute(
    { id: 'c_rag', name: 'builtin-rag_search', arguments: { query: 'hello' } },
    makeCtx({
      vfsDatabase: {},
      llm: {},
      retrievalCancellable: { search: async () => { throw new Error('boom rag'); } },
    }),
  );
  expect(ragRes.success).toBe(false);
  expect(events.map(e => [e.kind, e.phase])).toEqual([['rag', 'start'], ['rag', 'error']]);
  expect(events[0]!.payload).toMatchObject({ toolCallId: 'c_rag' });

  events.length = 0;
  const webRes = await executor.execute(
    { id: 'c_web', name: 'builtin-web_search', arguments: { query: 'hello' } },
    makeCtx({
      webSearch: { loadConfig: async () => ({}), doSearch: async () => ({ ok: true, citations: [] }) },
    }, true),
  );
  expect(webRes.success).toBe(false);
  expect(events.map(e => [e.kind, e.phase])).toEqual([['web_search', 'start'], ['web_search', 'error']]);
  expect(events[0]!.payload).toMatchObject({ toolCallId: 'c_web' });
});
