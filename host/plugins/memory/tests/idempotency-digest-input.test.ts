import { describe, expect, it } from 'vitest';
import { idempotencyDigestInput } from '../src/memory-tools-curation.ts';

// memory_executor.rs:2066-2073：Rust `str::trim` 去掉 Unicode White_Space（含 U+0085），不去 U+FEFF；
// JS `String.prototype.trim` 恰好相反（去 U+FEFF、不去 U+0085）。
describe('resolve_idempotency_key 的哈希输入按 Rust trim 规则', () => {
  it('U+0085 被去掉，U+FEFF 保留', () => {
    expect(idempotencyDigestInput('\u0085 Folder\u0085', '\uFEFFTitle', ' Content\u0085', 'fact', null))
      .toBe('folder|\uFEFFtitle|content|fact|');
  });

  it('purpose 参与哈希', () => {
    expect(idempotencyDigestInput(null, 'T', 'C', 'study', 'systemic')).toBe('|t|c|study|systemic');
  });
});
