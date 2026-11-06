import { describe, expect, it } from 'vitest';
import { extractIntentFromToolArgs } from '@/features/generative-ui/bridge/extractIntentFromToolArgs';

describe('extractIntentFromToolArgs', () => {
  it('returns null before the intent value starts', () => {
    expect(extractIntentFromToolArgs('')).toBeNull();
    expect(extractIntentFromToolArgs('{')).toBeNull();
    expect(extractIntentFromToolArgs('{"inte')).toBeNull();
    expect(extractIntentFromToolArgs('{"intent"')).toBeNull();
    expect(extractIntentFromToolArgs('{"intent": ')).toBeNull();
  });

  it('object form: returns the partial slice while streaming', () => {
    const args = '{"intent": {"version":"1","blocks":[{"type":"text","props":{"body":"a';
    expect(extractIntentFromToolArgs(args)).toBe('{"version":"1","blocks":[{"type":"text","props":{"body":"a');
  });

  it('object form: stops at the closing brace and ignores trailing keys', () => {
    const intent = '{"version":"1","blocks":[{"type":"text","props":{"body":"} ] {"}}]}';
    const args = `{"intent":${intent},"awaitAnswer":true}`;
    expect(extractIntentFromToolArgs(args)).toBe(intent);
    expect(JSON.parse(extractIntentFromToolArgs(args)!)).toEqual(JSON.parse(intent));
  });

  it('string form: decodes JSON escapes incrementally', () => {
    const intent = { version: '1', blocks: [{ type: 'text', props: { body: '换行\n"引号"' } }] };
    const full = JSON.stringify({ intent: JSON.stringify(intent) });
    expect(JSON.parse(extractIntentFromToolArgs(full)!)).toEqual(intent);

    // 每个前缀的结果都是最终结果的前缀（流式增量喂解析器的前提）
    const finalText = extractIntentFromToolArgs(full)!;
    for (let i = 0; i <= full.length; i += 1) {
      const partial = extractIntentFromToolArgs(full.slice(0, i));
      if (partial !== null) expect(finalText.startsWith(partial)).toBe(true);
    }
  });

  it('string form: stops before a half-written \\u escape', () => {
    expect(extractIntentFromToolArgs('{"intent":"{\\"a\\":\\"\\u4e')).toBe('{"a":"');
    expect(extractIntentFromToolArgs('{"intent":"{\\"a\\":\\"\\u4e2d')).toBe('{"a":"中');
    expect(extractIntentFromToolArgs('{"intent":"{\\"a\\":\\"x\\')).toBe('{"a":"x');
  });

  it('only matches the top-level "intent" key, not occurrences inside other strings or objects', () => {
    const args =
      '{"title":"the \\"intent\\": {fake}","meta":{"intent":{"x":1}},"list":["intent"],"n":3,"intent":{"version":"1","blocks":[]}}';
    expect(extractIntentFromToolArgs(args)).toBe('{"version":"1","blocks":[]}');
  });

  it('returns null when intent has a non-object, non-string value', () => {
    expect(extractIntentFromToolArgs('{"intent":null}')).toBeNull();
    expect(extractIntentFromToolArgs('{"awaitAnswer":true}')).toBeNull();
  });
});
