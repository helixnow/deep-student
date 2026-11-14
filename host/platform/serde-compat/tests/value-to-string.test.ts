// 真实 Rust 输出对照：__fixtures__/serde-json-value-to-string.json 由 rust-sampler `--bin value_to_string`
// （serde_json 1.0.149，preserve_order + arbitrary_precision，与桌面构建相同）写出，每行
// `[输入文本, serde_json::from_str::<Value>(输入).to_string()]`。
//
// 实测规则：数字保留原词形（`1.0`、`1.50`、`3.14159265358979323846`、超出 u64 的整数），只把指数规范成
// `e+`/`e-`（`1E2` → `1e+2`）、`-0` → `0`；对象键按首次出现位置、取最后一次的值；转义只用
// `\b\f\n\r\t`、`\"`、`\\` 与小写 `\u00XX`（`/`、DEL、U+2028/2029 不转义，代理对合成为字符）。
//
// 结论：词形保留解析（`parseJsonDocument` → 原生数字原子 + Map）后用 `toRustJson(_, rs.value())` 与 Rust
// 逐字节一致；普通 `JSON.parse` 已丢失数字词形和整数样式键的位置，任何序列化都无法补回。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { jsonNumberToRawJSON, objectLastWins, parseJsonDocument, type JsonNode } from '../../util/portable.ts';
import { rs, toRustJson } from '../index.ts';

const { valueToString: ROWS } = JSON.parse(readFileSync(join(import.meta.dirname, '__fixtures__/serde-json-value-to-string.json'), 'utf8')) as {
  valueToString: Array<[input: string, rust: string]>;
};

function lexemePreserving(node: JsonNode): unknown {
  switch (node.kind) {
    case 'null': return null;
    case 'bool': case 'string': return node.value;
    case 'number': return jsonNumberToRawJSON(node.value);
    case 'array': return node.items.map(lexemePreserving);
    case 'object': return new Map([...objectLastWins(node)].map(([key, value]) => [key, lexemePreserving(value)]));
  }
}

describe('serde_json::Value::to_string 实测对照', () => {
  it.each(ROWS)('词形保留解析 + toRustJson(rs.value()): %s', (input, rust) => {
    expect(toRustJson(lexemePreserving(parseJsonDocument(input)), rs.value())).toBe(rust);
  });

  it('JSON.parse + JSON.stringify 只在数字词形与整数样式键序上偏离 Rust（固定这份清单）', () => {
    const diverging = ROWS.filter(([input, rust]) => JSON.stringify(JSON.parse(input)) !== rust).map(([input]) => input);
    expect(diverging).toEqual([
      '1.0', '1.50', '-0.0', '1e2', '1E2', '1e+2', '3.14159265358979323846', '9007199254740993', '1e400',
      '{"b":1,"1":2,"a":3,"0":4}',
      '{"questions":[{"content":"求 ∫ x/(x²+1) dx","answer":"½ln(x²+1)+C","score":2.5,"page":1.0,"options":[]}],"mode":"generate"}',
    ]);
  });
});
