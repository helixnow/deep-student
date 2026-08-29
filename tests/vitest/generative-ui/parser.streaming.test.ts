import { describe, it, expect } from 'vitest';
import { GenerativeUIStreamParser, tryParsePartialIntent } from '@/features/generative-ui/parser';
import { LEARNING_DASHBOARD_EXAMPLE } from '@/features/generative-ui/prompts';

describe('GenerativeUIStreamParser', () => {
  it('returns null for empty buffer', () => {
    expect(tryParsePartialIntent('')).toBeNull();
  });

  it('parses complete JSON in one shot', () => {
    const json = JSON.stringify(LEARNING_DASHBOARD_EXAMPLE);
    expect(tryParsePartialIntent(json)?.blocks.length).toBeGreaterThan(0);
  });

  it('incrementally accumulates via append and finalize', () => {
    const json = JSON.stringify(LEARNING_DASHBOARD_EXAMPLE);
    const parser = new GenerativeUIStreamParser();
    parser.append(json.slice(0, Math.floor(json.length / 2)));
    parser.append(json.slice(Math.floor(json.length / 2)));
    const result = parser.finalize();
    expect(result?.blocks.length).toBeGreaterThan(0);
  });

  it('reset clears buffer', () => {
    const parser = new GenerativeUIStreamParser();
    parser.append('{"version":"1","blocks":[]}');
    parser.reset();
    expect(parser.getBuffer()).toBe('');
    expect(parser.finalize()).toBeNull();
  });
});
