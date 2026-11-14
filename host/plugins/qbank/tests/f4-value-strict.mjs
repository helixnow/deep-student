// 需要 F4 Value/raw provider（本 lane 已正常 merge 固定 provider 树）。
// 严格断言：不 catch、不按能力分支；任何异常或结果不符都以非零码退出。
//
// 用法（仓库根）：node --experimental-strip-types host/plugins/qbank/tests/f4-value-strict.mjs
import assert from 'node:assert/strict';
import { jsonNumberToRawJSON, parseJsonDocument } from '../../../platform/util/api.ts';
import { valueFromStr } from '../src/question-import-service.ts';

function f4NumberAtom(raw) {
  const node = parseJsonDocument(raw);
  assert.equal(node.kind, 'number', `F4 Value reader 未接受数字 ${raw}`);
  return JSON.stringify(jsonNumberToRawJSON(node.value));
}

// 与 F4 正式公开 Value/raw serializer 合同逐字节一致（serde Display 规范化）。
for (const [raw, expected] of [['1e999', '1e+999'], ['-1E999', '-1e+999']]) {
  assert.equal(f4NumberAtom(raw), expected, `F4 jsonNumberToRawJSON 合同变化：${raw}`);
}

// arbitrary 数字经 qbank 持久化后仍是无损 JSON 数字，且与 F4 公开序列化结果一致。
const overflow = valueFromStr('{"n":1e999,"m":-1E999}');
assert.equal(JSON.stringify(overflow), `{"n":${f4NumberAtom('1e999')},"m":${f4NumberAtom('-1E999')}}`);

// 大整数（u64/i64 超出 Number 安全范围）不 Number 舍入。
const big = valueFromStr('{"u":9007199254740993,"i":-9007199254740993,"max":18446744073709551615}');
assert.equal(JSON.stringify(big),
  '{"u":9007199254740993,"i":-9007199254740993,"max":18446744073709551615}');

// 有限高精度小数/指数/underflow token 也保留原样（serde Value arbitrary_precision）。
const finite = valueFromStr('{"a":1.234567890123456789,"b":0.1000000000000000001,"c":1e-400,"d":1e2}');
assert.equal(JSON.stringify(finite),
  '{"a":1.234567890123456789,"b":0.1000000000000000001,"c":1e-400,"d":1e+2}');

console.log('f4 value strict: ok');
