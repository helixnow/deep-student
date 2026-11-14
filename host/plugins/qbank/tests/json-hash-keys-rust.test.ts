import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { hashValue } from '../repository/legacy.ts';

/**
 * 落库并跨版本比较的 JSON 哈希键，输入只含字符串、u32/usize 与 null（JSON.stringify 与
 * serde_json Value::to_string 在这些值上逐字节相同）：
 * - 来源槽 `questions.source_key`（qbank_authoring_service.rs:703-707、qbank_legacy_reconcile.rs 同形）：
 *   `[[[source_id, page|null], ...], section_path, original_label]`，重解析时按它认回旧题；
 * - 历史迁移幂等键 `legacy-migrate:{exam}:{hash(card_ids)}`（qbank_legacy_reconcile.rs:390-395）。
 * Rust 原文来自 rust-sampler `--bin value_to_string`。
 */
const { valueToString } = JSON.parse(fs.readFileSync(new URL(
  '../../../platform/serde-compat/tests/__fixtures__/serde-json-value-to-string.json', import.meta.url), 'utf8')) as {
  valueToString: [string, string][];
};
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const row = (prefix: string) => valueToString.find(([input]) => input.startsWith(prefix))!;

describe('qbank JSON 哈希键与 Rust Value::to_string 一致', () => {
  it('来源槽 source_key', () => {
    const [input, rust] = row('[[["src_1"');
    expect(hashValue(JSON.parse(input))).toBe(sha256(rust));
  });

  it('含控制字符、引号、U+2028 与代理对的字符串数组（卡片 id 选择哈希）', () => {
    const [input, rust] = row('["\\u0001');
    expect(hashValue(JSON.parse(input))).toBe(sha256(rust));
  });
});
