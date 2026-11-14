import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ApiConfig } from '../../llm/api.ts';
import { authoringConfigFingerprint } from '../src/question-import-service.ts';

/** rust-sampler `--bin value_to_string`：`[存储里的 ApiConfig JSON, Rust 指纹哈希前的文本]`。 */
const { authoringConfigFingerprintText: rows } = JSON.parse(fs.readFileSync(new URL(
  '../../../platform/serde-compat/tests/__fixtures__/serde-json-value-to-string.json', import.meta.url), 'utf8')) as {
  authoringConfigFingerprintText: [input: string, rustText: string][];
};
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

describe('authoring_config_fingerprint 与 Rust 版逐字节一致（旧版中断的导入任务升级后仍能恢复）', () => {
  const byId = new Map(rows.map(([input, rust]) => [(JSON.parse(input) as { id: string }).id, { input, rust }]));

  it.each(['cfg_1', 'cfg_2', 'cfg_3'])('%s：swap_remove("headers") 键序、f32 拼写（1.0、0.12345679）与 Rust 相同', (id) => {
    const { input, rust } = byId.get(id)!;
    expect(authoringConfigFingerprint(JSON.parse(input) as ApiConfig)).toBe(sha256(rust));
  });

  // 已知残差：extraBody 是 serde_json::Map，Rust 保留数字原词形（2.0）与整数样式键的位置；
  // 配置经 JSON.parse 读入后这两样都已丢失，只有 extraBody 段不同。
  it('cfg_4：extraBody 内的数字词形与整数样式键序是 JSON.parse 之后无法恢复的残差', () => {
    const { input, rust } = byId.get('cfg_4')!;
    const ts = authoringConfigFingerprint(JSON.parse(input) as ApiConfig);
    expect(ts).not.toBe(sha256(rust));
    expect(ts).toBe(sha256(rust.replace('"extraBody":{"b":1,"a":2.0,"1":true}', '"extraBody":{"1":true,"b":1,"a":2}')));
  });
});
