import { describe, expect, it } from 'vitest';
import { buildSessionMetadataPrompt, computeContentHash, fallbackSessionMetadata,
  parseSessionMetadataResponse, shouldGenerateSessionMetadata } from '../src/summary.ts';

describe('summary.rs::tests', () => {
  it('parses_well_formed_json', () => {
    const metadata = parseSessionMetadataResponse('{"title": "微积分入门", "tags": ["微积分", "极限", "导数"]}')!;
    expect(metadata.title).toBe('微积分入门');
    expect(metadata.tags).toEqual(['微积分', '极限', '导数']);
  });
  it('strips_markdown_code_fences', () => {
    const metadata = parseSessionMetadataResponse('```json\n{"title":"Calculus","tags":["math"]}\n```')!;
    expect(metadata.title).toBe('Calculus');
    expect(metadata.tags).toEqual(['math']);
  });
  it('handles_missing_tags', () => {
    const metadata = parseSessionMetadataResponse('{"title": "Hello"}')!;
    expect(metadata.title).toBe('Hello');
    expect(metadata.tags).toEqual([]);
  });
  it('ignores_legacy_description_field', () => {
    const metadata = parseSessionMetadataResponse('{"title":"x","description":"legacy field","tags":["t"]}')!;
    expect(metadata.title).toBe('x');
    expect(metadata.tags).toEqual(['t']);
  });
  it('rejects_empty_or_missing_title', () => {
    expect(parseSessionMetadataResponse('{"title":""}')).toBeNull();
    expect(parseSessionMetadataResponse('{"tags":[]}')).toBeNull();
  });
  it('rejects_invalid_json', () => {
    expect(parseSessionMetadataResponse('not json')).toBeNull();
    expect(parseSessionMetadataResponse('')).toBeNull();
  });
  it('truncates_overlong_title', () => {
    const metadata = parseSessionMetadataResponse(JSON.stringify({ title: '标'.repeat(80), tags: [] }))!;
    expect([...metadata.title].length).toBe(50);
  });
  it('strips_quote_wrappers', () => {
    expect(parseSessionMetadataResponse('{"title":"「会话主题」","tags":[]}')!.title).toBe('会话主题');
  });
  it('filters_invalid_tags', () => {
    const metadata = parseSessionMetadataResponse('{"title":"x","tags":["", "normal", "this_tag_is_way_too_long_for_filter"]}')!;
    expect(metadata.tags).toEqual(['normal']);
  });
  it('content_hash_is_deterministic', () => {
    const first = computeContentHash('hello', 'world');
    const second = computeContentHash('hello', 'world');
    const third = computeContentHash('hello', 'different');
    expect(first).toBe(second);
    expect(first).not.toBe(third);
    expect(first).toHaveLength(32);
  });
  it('local_metadata_fallback_is_stable_and_cjk_safe', () => {
    const metadata = fallbackSessionMetadata('  帮我做三张关于高中数学的 Anki 卡片。  ');
    expect(metadata.title).toBe('帮我做三张关于高中数学的 Anki 卡片');
    expect([...metadata.title].length).toBeLessThanOrEqual(20);
    expect(metadata.tags).toEqual([]);
  });
  it('local_metadata_fallback_handles_empty_content', () => {
    expect(fallbackSessionMetadata('  \n\t ').title).toBe('新对话');
  });
  it('metadata_prompt_truncates_assistant_at_500_code_points', () => {
    const prompt = buildSessionMetadataPrompt('u', '😀'.repeat(600));
    expect(prompt).toContain('😀'.repeat(500));
    expect(prompt).not.toContain('😀'.repeat(501));
    expect(prompt).not.toContain('{user_content}');
    expect(prompt).not.toContain('{assistant_content}');
  });
  it('should_generate_respects_short_content_lock_and_existing_hash', () => {
    const session = { titleLocked: false, summaryHash: null };
    expect(shouldGenerateSessionMetadata('short', 'tiny', session)).toBe(false);
    expect(shouldGenerateSessionMetadata('long enough question', 'ok', session)).toBe(true);
    expect(shouldGenerateSessionMetadata('long enough question', 'ok', { titleLocked: true, summaryHash: null })).toBe(false);
    expect(shouldGenerateSessionMetadata('long enough question', 'ok', { titleLocked: false, summaryHash: 'h' })).toBe(false);
    expect(shouldGenerateSessionMetadata('long enough question', 'ok', null)).toBe(false);
    expect(shouldGenerateSessionMetadata('x', 'a'.repeat(20), session)).toBe(true);
  });
});
