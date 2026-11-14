import { describe, expect, it } from 'vitest';
import type { ToolResultInfo } from '../../../../contracts/ipc/generated/L04-chat-session.ts';
import { parseCanonicalContent, type ResolvedCanonicalImage } from '../src/images.ts';
import {
  buildRetrievalPageImageMessage, canonicalImageBlobHashes,
  collectRetrievalPageImageCandidates, countRequestImages,
  insertRetrievalPageImageMessage, isRetrievalPageImageMessage,
  MAX_RETRIEVAL_PAGE_IMAGES_PER_TURN, RETRIEVAL_PAGE_IMAGES_TAG,
  RetrievalPageImageBudget, type RetrievalPageImageCandidate,
} from '../src/retrieval-images.ts';
import {
  imagePart, isTransientSkillMessage, makeEmptyMessage, makeTransientSkillMessage,
  textPart, type LegacyChatMessage,
} from '../src/microcompact.ts';

function retrievalResult(toolName: string, callId: string, sources: unknown): ToolResultInfo {
  return {
    toolCallId: callId,
    toolName,
    input: {},
    output: { success: true, sources },
    success: true,
  };
}

function page(tag: string, blob: string | null, pageIndex: number): Record<string, unknown> {
  return {
    citationTag: tag,
    title: '电路基础',
    pageIndex,
    resourceId: 'res_1',
    sourceId: 'file_1',
    blob_hash: blob,
  };
}

function payload(): ResolvedCanonicalImage {
  return { mimeType: 'image/png', base64: 'cGFnZQ==' };
}

function toolMessage(callId: string): LegacyChatMessage {
  const message = makeEmptyMessage('tool', '');
  message.tool_result = { call_id: callId, ok: true };
  return message;
}

describe('chat_v2/pipeline/context_compiler/retrieval_images.rs::tests', () => {
  it('collects_only_knowledge_hits_with_page_images_in_rank_order', () => {
    const results = [
      retrievalResult('builtin-unified_search', 'call_1', [
        page('[知识库-1]', 'blob_a', 4),
        page('[知识库-2]', null, 5),
        page('[知识库-3]', 'blob_b', 6),
        page('[知识库-4]', 'blob_a', 4),
        { ...page('[知识库-5]', null, 7), blobHash: 'not-a-fallback-for-null' },
      ]),
      // Web search and same-named tools outside the builtin namespace yield no pages.
      retrievalResult('builtin-web_search', 'call_2', [page('[网络-1]', 'blob_w', 0)]),
      retrievalResult('mcp_rag_search', 'call_3', [page('[x]', 'blob_m', 0)]),
    ];
    const candidates = collectRetrievalPageImageCandidates(results);
    expect(candidates.map(candidate => candidate.blobHash)).toEqual(['blob_a', 'blob_b']);
    expect(candidates[0]!.toolCallId).toBe('call_1');
    expect(candidates[0]!.citationTag).toBe('[知识库-1]');
    expect(candidates[1]!.pageIndex).toBe(6);
    const trimmed = collectRetrievalPageImageCandidates([
      retrievalResult('builtin-rag_search', 'call_trim', [
        page('[图片-1]', '\u0085blob_c\u0085', 0), page('[图片-2]', '\uFEFF', 1),
      ]),
    ]);
    expect(trimmed.map(candidate => candidate.blobHash)).toEqual(['blob_c', '\uFEFF']);
  });

  it('failed_retrieval_results_are_ignored', () => {
    const result = retrievalResult('builtin-rag_search', 'call_1',
      [page('[知识库-1]', 'blob_a', 0)]);
    result.success = false;
    expect(collectRetrievalPageImageCandidates([result])).toEqual([]);
  });

  it('budget_respects_total_image_budget_turn_cap_and_dedupe', () => {
    // Total budget 8, request already has 6 images → 2 left.
    const budget = new RetrievalPageImageBudget(8, 6, new Set());
    expect(budget.remaining()).toBe(2);
    expect(budget.commit('a')).toBe(true);
    expect(budget.commit('a')).toBe(false); // same blob must not be injected twice
    expect(budget.commit('b')).toBe(true);
    expect(budget.commit('c')).toBe(false); // budget exhausted

    // An empty request is still capped per turn.
    const empty = new RetrievalPageImageBudget(8, 0, new Set());
    expect(empty.remaining()).toBe(MAX_RETRIEVAL_PAGE_IMAGES_PER_TURN);

    // Page images the user already referenced are never injected twice.
    const referenced = new RetrievalPageImageBudget(8, 1, new Set(['blob_a']));
    const planned = referenced.plan(collectRetrievalPageImageCandidates([
      retrievalResult('builtin-multimodal_search', 'call_1', [
        page('[图片-1]', 'blob_a', 0),
        page('[图片-2]', 'blob_b', 1),
      ]),
    ]));
    expect(planned).toHaveLength(1);
    expect(planned[0]!.blobHash).toBe('blob_b');
  });

  it('page_image_message_marks_retrieval_hit_and_carries_labels', () => {
    const candidates = collectRetrievalPageImageCandidates([
      retrievalResult('builtin-unified_search', 'call_1', [page('[知识库-1]', 'blob_a', 2)]),
    ]);
    const message = buildRetrievalPageImageMessage([[candidates[0]!, payload()]])!;
    expect(message.role).toBe('user');
    expect(message.content.startsWith(RETRIEVAL_PAGE_IMAGES_TAG)).toBe(true);
    expect(isRetrievalPageImageMessage(message)).toBe(true);

    const parts = message.multimodal_content!;
    expect(parts.some(part => part.type === 'text' && part.text.includes('[知识库-1]')
      && part.text.includes('第 3 页'))).toBe(true);
    expect(parts.some(part => part.type === 'image_url' && part.mediaType === 'image/png'
      && part.base64 === 'cGFnZQ==')).toBe(true);

    const metadata = message.metadata as Record<string, unknown>;
    const canonical = parseCanonicalContent(metadata.canonicalContent)!;
    expect(canonical[0]).toMatchObject({
      type: 'image_ref', retrieval_hit: true, blob_hash: 'blob_a',
    });
    expect(buildRetrievalPageImageMessage([])).toBeNull();
  });

  it('injection_goes_after_round_tail_and_after_transient_skills', () => {
    const pageMessage = buildRetrievalPageImageMessage([[
      {
        toolCallId: 'call_1', blobHash: 'blob_a', citationTag: '[知识库-1]',
        title: null, pageIndex: null, resourceId: null, sourceId: null,
      } satisfies RetrievalPageImageCandidate,
      payload(),
    ]])!;
    const skill = makeTransientSkillMessage('s', 'body');
    const messages = [
      makeEmptyMessage('user', 'q'),
      toolMessage('call_1'),
      toolMessage('call_2'),
      skill,
      toolMessage('call_3'),
    ];
    expect(insertRetrievalPageImageMessage(messages, 'call_2', pageMessage)).toBe(true);
    expect(isTransientSkillMessage(messages[3]!)).toBe(true);
    expect(isRetrievalPageImageMessage(messages[4]!)).toBe(true);
    expect(messages[5]!.tool_result!.call_id).toBe('call_3');

    // Missing anchor abandons injection and leaves the sequence untouched.
    const before = messages.length;
    expect(insertRetrievalPageImageMessage(messages, 'missing', pageMessage)).toBe(false);
    expect(messages).toHaveLength(before);
  });

  it('counts_existing_request_images', () => {
    const withParts = makeEmptyMessage('user', 'q');
    withParts.multimodal_content = [
      textPart('q'),
      imagePart('image/png', 'a'),
      imagePart('image/png', 'b'),
    ];
    const legacy = makeEmptyMessage('user', 'q');
    legacy.image_base64 = ['c'];
    expect(countRequestImages([withParts, legacy])).toBe(3);
  });

  it('canonical_blob_hashes_only_include_page_refs', () => {
    expect(canonicalImageBlobHashes([
      { type: 'text', text: 'q' },
      {
        type: 'image_ref', image_id: 'i1', name: null, resource_id: null, source_id: null,
        blob_hash: 'blob_a', content_hash: null, mime_type: 'image/png',
        pinned: false, retrieval_hit: true,
      },
      {
        type: 'image_ref', image_id: 'i2', name: null, resource_id: null, source_id: null,
        blob_hash: null, content_hash: null, mime_type: 'image/png',
        pinned: false, retrieval_hit: false,
      },
    ])).toEqual(new Set(['blob_a']));
  });
});
