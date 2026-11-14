import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { promotionFingerprint } from '../src/evolution.ts';

/** rust-sampler `--bin default_hasher`：`[[[date, content], ...], Rust promotion_fingerprint]`。 */
const { promotionFingerprint: rows } = JSON.parse(fs.readFileSync(new URL(
  '../../../platform/serde-compat/tests/__fixtures__/default-hasher-promotion-fingerprint.json', import.meta.url), 'utf8')) as {
  promotionFingerprint: [logs: [date: string, content: string][], fingerprint: string][];
};

describe('promotion_fingerprint 与 Rust DefaultHasher 逐字一致（画像里旧版写下的 _promotion_fingerprint 升级后仍命中，不重复晋升）', () => {
  it.each(rows.map(([logs, rust]) => [rust, logs] as const))('%s', (rust, logs) => {
    expect(promotionFingerprint(logs.map(([date, content]) => ({ date, content })))).toBe(rust);
  });
});
