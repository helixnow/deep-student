import { expect, it } from 'vitest';
import { chunkText, chunkTextWithPages, extractIndexableContent, extractIndexablePages, shouldDisableIndexForMissingNote, normalizeCompatibilityRrfScore, searchExecutionBackend } from '../src/indexing.ts';

it('legacy_cross_dimension_flag_always_selects_unified_profile_planner', () => {
  expect(searchExecutionBackend(true)).toBe('unified_profile_planner');
  expect(searchExecutionBackend(false)).toBe('unified_profile_planner');
});
it('compatibility_scores_preserve_weighted_rrf_order_and_chat_thresholds', () => {
  const best = .024;
  expect(normalizeCompatibilityRrfScore(best, best)).toBe(1);
  expect(normalizeCompatibilityRrfScore(best / 2, best)).toBe(.5);
  expect(normalizeCompatibilityRrfScore(0, best)).toBe(0);
  expect(normalizeCompatibilityRrfScore(NaN, best)).toBe(0);
});
it('test_chunk_fixed_size', () => {
  const config = { strategy: 'fixed_size', chunkSize: 10, chunkOverlap: 2, minChunkSize: 3 };
  const chunks = chunkText('Hello world, this is a test string for chunking.', config);
  expect(chunks.length).toBeGreaterThan(0);
  expect(chunks.every(c => Buffer.byteLength(c.text) >= config.minChunkSize)).toBe(true);
});
it('test_chunk_semantic', () => {
  const chunks = chunkText('First paragraph.\n\nSecond paragraph.\n\nThird paragraph.', {
    strategy: 'semantic', chunkSize: 100, chunkOverlap: 0, minChunkSize: 5,
  });
  expect(chunks.length).toBeGreaterThan(0);
});
it('test_extract_markdown', () => {
  const text = extractIndexableContent('note', '# Title\n\n**Bold** and *italic*\n\n![image](url)\n\n[link](url)');
  expect(text).not.toBeNull();
  expect(text).not.toContain('![');
  expect(text).not.toContain('**');
});
it('test_extract_translation', () => {
  const text = extractIndexableContent('translation', '{"source": "Hello", "translated": "你好"}');
  expect(text).not.toBeNull();
  expect(text).toContain('Hello'); expect(text).toContain('你好');
});
it('test_missing_note_with_inline_data_keeps_indexable_fallback', () => {
  const resource = { id: 'res_note_inline', hash: 'hash_inline', resource_type: 'note', source_id: 'note_missing',
    source_table: 'notes', storage_mode: 'inline', data: '# Inline fallback\n\nkeep me indexed', external_hash: null,
    metadata: { title: 'Inline Note', mime_type: 'text/markdown' }, ref_count: 1, created_at: 1, updated_at: 1 };
  expect(shouldDisableIndexForMissingNote(resource)).toBe(false);
});
it('test_missing_note_without_inline_data_disables_index', () => {
  const resource = { id: 'res_note_missing', hash: 'hash_missing', resource_type: 'note', source_id: 'note_missing',
    source_table: 'notes', storage_mode: 'inline', data: null, external_hash: null,
    metadata: { title: 'Missing Note', mime_type: 'text/markdown' }, ref_count: 1, created_at: 1, updated_at: 1 };
  expect(shouldDisableIndexForMissingNote(resource)).toBe(true);
});
it('keeps Rust scalar offsets for fixed chunks and UTF-8 byte offsets for semantic chunks', () => {
  expect(chunkText('甲乙丙丁', { strategy: 'fixed_size', chunkSize: 2, chunkOverlap: 0, minChunkSize: 5 }))
    .toEqual([
      { index: 0, text: '甲乙', start_pos: 0, end_pos: 2, page_index: null, source_id: null },
      { index: 1, text: '丙丁', start_pos: 2, end_pos: 4, page_index: null, source_id: null },
    ]);
  expect(chunkText('甲乙\n\n丙丁', { strategy: 'semantic', chunkSize: 8, chunkOverlap: 0, minChunkSize: 1 }).map(c => [c.start_pos, c.end_pos]))
    .toEqual([[0, 8], [8, 16]]);
  const pages = chunkTextWithPages([{ page_index: 3, text: 'Hello', source_id: 'source' }, { page_index: 4, text: 'World', source_id: 'source' }]);
  expect(pages.map(c => [c.index, c.page_index, c.start_pos, c.source_id])).toEqual([[0, 3, 0, 'source'], [1, 4, 0, 'source']]);
});
it('preserves textbook JSON-as-raw-text and existing nonstring page-field precedence', () => {
  expect(extractIndexableContent('textbook', '{"extracted_text":"abc"}')).toBe('{"extracted_text":"abc"}');
  expect(extractIndexablePages('textbook', 'r', '{"pages":[{"text":null,"content":"abc"}]}')).toBeNull();
});
