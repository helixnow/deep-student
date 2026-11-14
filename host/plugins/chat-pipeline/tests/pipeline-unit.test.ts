import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONTEXT_LIMIT, DEFAULT_GRAPH_TOP_K, DEFAULT_MULTIMODAL_TOP_K, DEFAULT_RAG_TOP_K,
  DEFAULT_TOOL_TIMEOUT_MS, effectiveMaxToolRounds, LLM_NON_STREAM_TIMEOUT_SECS,
  LLM_STREAM_MAX_TOTAL_SECS, LLM_STREAM_TIMEOUT_SECS,
} from '../src/constants.ts';
import { sourceInfoFromRagSource, truncateText } from '../src/retrieval.ts';
import {
  normalizeToolNameForSkillMatch, skillAllowsTool, skillAllowsToolOnServer,
} from '../src/skill-tool-policy.ts';

describe('chat_v2/pipeline_tests.rs::tests', () => {
  it('test_tool_recursion_unlimited_by_default', () => {
    expect(effectiveMaxToolRounds(null)).toBeNull();
    expect(effectiveMaxToolRounds(0)).toBeNull();
    expect(effectiveMaxToolRounds(30)).toBe(30);
  });

  it('test_tool_timeout_constant', () => {
    expect(DEFAULT_TOOL_TIMEOUT_MS).toBe(30_000);
  });

  it('test_normalize_tool_name_for_skill_match', () => {
    expect(normalizeToolNameForSkillMatch('builtin-workspace_send')).toBe('workspace_send');
    expect(normalizeToolNameForSkillMatch('mcp_workspace_send')).toBe('workspace_send');
    expect(normalizeToolNameForSkillMatch('workspace_send')).toBe('workspace_send');
  });

  it('test_skill_allows_tool_with_namespace_prefixes', () => {
    expect(skillAllowsTool('builtin-workspace_send', 'workspace_send')).toBe(true);
    expect(skillAllowsTool('mcp_workspace_query', 'builtin-workspace_query')).toBe(true);
    expect(skillAllowsTool('builtin-anki_create_card', 'anki')).toBe(true);
    expect(skillAllowsTool('builtin-workspace_send', 'workspace_query')).toBe(false);
  });

  it('test_skill_allows_tool_with_server_scoped_entries', () => {
    expect(skillAllowsToolOnServer('mcp_fetch', 'server-a', 'server-a::fetch')).toBe(true);
    expect(skillAllowsToolOnServer('mcp_fetch', 'server-a', 'fetch')).toBe(true);
    expect(skillAllowsToolOnServer('mcp_fetch', 'server-b', 'server-a::fetch')).toBe(false);
  });

  it('test_context_limit_default', () => {
    expect(DEFAULT_CONTEXT_LIMIT).toBe(20);
    expect(DEFAULT_GRAPH_TOP_K).toBe(10);
    expect(DEFAULT_MULTIMODAL_TOP_K).toBe(10);
    expect(LLM_STREAM_TIMEOUT_SECS).toBe(600);
    expect(LLM_STREAM_MAX_TOTAL_SECS).toBe(7_200);
    expect(LLM_NON_STREAM_TIMEOUT_SECS).toBe(120);
  });

  it('test_max_tool_recursion_unlimited_by_default', () => {
    expect(effectiveMaxToolRounds(null)).toBeNull();
    expect(effectiveMaxToolRounds(0)).toBeNull();
    expect(effectiveMaxToolRounds(30)).toBe(30);
    expect(effectiveMaxToolRounds(500)).toBe(100);
  });

  it('test_execute_with_tools_recursion_unlimited', () => {
    expect(effectiveMaxToolRounds(null)).toBeNull();
    expect(effectiveMaxToolRounds(0)).toBeNull();
    expect(effectiveMaxToolRounds(30)).toBe(30);
    expect(effectiveMaxToolRounds(500)).toBe(100);
  });

  it('test_default_rag_top_k', () => {
    expect(DEFAULT_RAG_TOP_K).toBe(5);
  });

  it('test_truncate_text_within_limit', () => {
    expect(truncateText('短文本', 10)).toBe('短文本');
  });

  it('test_truncate_text_exceeds_limit', () => {
    expect(truncateText('这是一段很长的文本内容，需要被截断', 5)).toBe('这是一段很...');
  });

  it('test_truncate_text_exact_limit', () => {
    expect(truncateText('恰好', 2)).toBe('恰好');
  });

  it('test_truncate_text', () => {
    // 4-byte code points are truncated by character, never by byte.
    expect(truncateText('😀😀😀', 2)).toBe('😀😀...');
    expect(truncateText('abc', 0)).toBe('...');
    expect(truncateText('', 3)).toBe('');
  });

  it('test_source_info_from_rag_source', () => {
    const sourceInfo = sourceInfoFromRagSource({
      document_id: 'doc_123',
      file_name: 'test.pdf',
      chunk_text: 'Sample text',
      score: 0.95,
      chunk_index: 0,
    });

    expect(sourceInfo.title).toBe('test.pdf');
    expect(sourceInfo.snippet).toBe('Sample text');
    expect(sourceInfo.score).toBe(0.95);
    expect(sourceInfo.metadata).toEqual({ documentId: 'doc_123', chunkIndex: 0 });
  });
});
