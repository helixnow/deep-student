import { describe, expect, it } from 'vitest';
import type { Variant } from '../api.ts';
import { enforceVariantsJsonSizeLimit } from '../repository/messages.ts';
import type { ChatLogger } from '../src/logger.ts';

function variant(index: number, error: string): Variant {
  return { id: `var_${index}`, modelId: `model_${index}`, status: 'pending', blockIds: [], createdAt: 0, error };
}
function recordingLogger() {
  const entries: Array<[string, string]> = [];
  const log: ChatLogger = { debug: text => entries.push(['debug', text]), info: text => entries.push(['info', text]),
    warn: text => entries.push(['warn', text]), error: text => entries.push(['error', text]) };
  return { log, entries };
}

describe('repo.rs enforce_variants_json_size_limit', () => {
  it('test_enforce_variants_json_size_limit_warn_path_does_not_truncate', () => {
    const variants = [variant(0, 'x'.repeat(64 * 1024 + 1024))];
    const raw = JSON.stringify(variants);
    const originalLength = variants.length;
    const { log, entries } = recordingLogger();
    expect(Buffer.byteLength(raw)).toBeGreaterThanOrEqual(64 * 1024);
    expect(Buffer.byteLength(raw)).toBeLessThan(256 * 1024);
    const output = enforceVariantsJsonSizeLimit(raw, variants, 'msg_warn_test', log);
    expect(output).toBe(raw);
    expect(variants).toHaveLength(originalLength);
    expect(entries).toEqual([['warn', `[ChatV2::Repo] variants_json size ${Buffer.byteLength(raw)} bytes approaching limit (warn=65536, limit=262144, count=1, message_id=msg_warn_test)`]]);
  });
  it('test_enforce_variants_json_size_limit_hard_truncates_oldest', () => {
    const variants = Array.from({ length: 6 }, (_, i) => variant(i, 'y'.repeat(256 * 1024 / 4)));
    const oldest = variants[0]!.id;
    const newest = variants.at(-1)!.id;
    const raw = JSON.stringify(variants);
    expect(Buffer.byteLength(raw)).toBeGreaterThanOrEqual(256 * 1024);
    const { log, entries } = recordingLogger();
    const output = enforceVariantsJsonSizeLimit(raw, variants, 'msg_truncate_test', log);
    expect(Buffer.byteLength(output)).toBeLessThan(256 * 1024);
    expect(variants.every(v => v.id !== oldest)).toBe(true);
    expect(variants.some(v => v.id === newest)).toBe(true);
    expect(variants.length).toBeGreaterThan(0);
    expect(JSON.parse(output)).toEqual(variants);
    expect(entries[0]![0]).toBe('error');
    expect(entries.slice(1).map(entry => entry[1])).toEqual([0, 1, 2].map(i =>
      `[ChatV2::Repo] truncated oldest variant var_${i} (model=model_${i}, message_id=msg_truncate_test)`));
  });
  it('uses UTF-8 size and preserves the final oversized variant', () => {
    const variants = [variant(0, '界'.repeat(100_000)), variant(1, '界'.repeat(100_000))];
    const raw = JSON.stringify(variants);
    expect(raw.length).toBeLessThan(256 * 1024);
    const { log, entries } = recordingLogger();
    const output = enforceVariantsJsonSizeLimit(raw, variants, 'msg_utf8', log);
    expect(variants.map(v => v.id)).toEqual(['var_1']);
    expect(JSON.parse(output)).toEqual(variants);
    expect(entries.at(-1)).toEqual(['error', `[ChatV2::Repo] variants_json still ${Buffer.byteLength(output)} bytes after truncation (message_id=msg_utf8)`]);
    const single = enforceVariantsJsonSizeLimit(output, variants, 'msg_single', log);
    expect(single).toBe(output);
    expect(entries.at(-1)).toEqual(['error', `[ChatV2::Repo] cannot truncate: single variant already exceeds limit (size=${Buffer.byteLength(output)}, message_id=msg_single)`]);
  });
});
