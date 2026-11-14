import { describe, expect, it } from 'vitest';
import {
  buildDecisionPrompt, defaultDecisionResponse, memoryEventFromStr, parseDecisionResponse,
} from '../src/llm-decision.ts';
import { enhancedCleanJsonResponse, extractFirstJsonObject } from '../src/json.ts';

describe('llm_decision', () => {
  it('test_memory_event_serde', () => {
    const response = parseDecisionResponse('{"event":"ADD","confidence":0.9,"reason":"test"}');
    expect(response?.event).toBe('ADD');
    expect(response?.confidence).toBe(0.9);
    expect(response?.target_note_id).toBeNull();
  });
  it('test_extract_and_parse_clean_json', () => {
    const raw = '{"event":"ADD","confidence":0.9,"reason":"test"}';
    expect(JSON.parse(extractFirstJsonObject(raw)!).event).toBe('ADD');
  });
  it('test_extract_json_from_surrounding_text', () => {
    const raw = '根据分析，决策如下：\n{"event":"ADD","confidence":0.9,"reason":"新信息"}\n以上是我的判断。';
    expect(extractFirstJsonObject(raw)).toBe('{"event":"ADD","confidence":0.9,"reason":"新信息"}');
  });
  it('test_extract_json_with_think_tag', () => {
    const raw = '<think>让我分析一下...</think>\n{"event":"ADD","confidence":0.95,"reason":"全新"}';
    expect(extractFirstJsonObject(raw)).toBe('{"event":"ADD","confidence":0.95,"reason":"全新"}');
  });
  it('test_extract_json_markdown_with_text_before', () => {
    const raw = '好的，以下是结果：\n```json\n{"event":"UPDATE","target_note_id":"note_abc"}\n```';
    expect(extractFirstJsonObject(raw)).toBe('{"event":"UPDATE","target_note_id":"note_abc"}');
  });
  it('test_extract_json_returns_none_for_no_json', () => {
    expect(extractFirstJsonObject('no json here')).toBeNull();
  });
  it('test_memory_event_from_str', () => {
    expect(memoryEventFromStr('ADD')).toBe('ADD');
    expect(memoryEventFromStr('update')).toBe('UPDATE');
    expect(memoryEventFromStr('APPEND')).toBe('APPEND');
    expect(memoryEventFromStr('DELETE')).toBe('DELETE');
    expect(memoryEventFromStr('delete')).toBe('DELETE');
    expect(memoryEventFromStr('none')).toBe('NONE');
    expect(memoryEventFromStr('invalid')).toBe('NONE');
  });
  it('applies serde defaults and rejects invalid enum or wrong primitive types', () => {
    expect(parseDecisionResponse('{"event":"UPDATE"}')).toEqual({
      event: 'UPDATE', target_note_id: null, confidence: 0.8, reason: '',
    });
    expect(parseDecisionResponse('{"event":"BOGUS"}')).toBeNull();
    expect(parseDecisionResponse('{"event":"ADD","confidence":"0.9"}')).toBeNull();
    expect(defaultDecisionResponse()).toEqual({ event: 'NONE', target_note_id: null, confidence: 0.8, reason: '' });
  });
  it('builds the decision prompt with capped previews and optional title', () => {
    const prompt = buildDecisionPrompt('新内容', '标题', [
      { note_id: 'n1', title: 't1', content_preview: 'x'.repeat(120) },
    ]);
    expect(prompt).toContain('标题: 标题');
    expect(prompt).toContain('x'.repeat(100));
    expect(prompt).not.toContain('x'.repeat(101));
    expect(buildDecisionPrompt('c', null, [])).not.toContain('标题:');
    expect(JSON.parse(enhancedCleanJsonResponse('```json\n{"a":1}\n```'))).toEqual({ a: 1 });
  });
});
