// node --test scripts/serde-audit/tests
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyJsonText, classifyOutcome, parseLoose } from '../lib/classify.mjs';

const tags = (r) => r?.findings.map((f) => f.tag).sort();

test('parseLoose 保留数字原文、键序，接受未加引号的归一化占位符', () => {
  const doc = parseLoose('{"b":1.0,"a":[<n@s3:x/y#0>,"<@u1:z>"]}');
  assert.equal(doc.t, 'obj');
  assert.deepEqual(doc.entries.map(([k]) => k), ['b', 'a']);
  assert.deepEqual(doc.entries[0][1], { t: 'num', raw: '1.0' });
  assert.equal(doc.entries[1][1].items[0].t, 'ph');
  assert.equal(parseLoose('not json'), undefined);
  assert.equal(parseLoose('"str"').t, 'str');
});

test('f64 整数 `.0`：Rust 写 85.0、宿主写 85（方向 rust-float）', () => {
  const r = classifyJsonText('{"stage":"x","percent":85.0}', '{"stage":"x","percent":85}');
  assert.deepEqual(tags(r), ['f64-integer']);
  assert.equal(r.findings[0].path, '$.percent');
  assert.equal(r.findings[0].direction, 'rust-float');
  assert.equal(classifyJsonText('{"a":1}', '{"a":1.0}').findings[0].direction, 'rust-int');
});

test('f32 精度：宿主把 f32 加宽成 f64 写出', () => {
  assert.deepEqual(tags(classifyJsonText('[0.212]', '[0.21199999749660492]')), ['f32-precision']);
  assert.deepEqual(tags(classifyJsonText('{"s":52.0}', '{"s":52}')), ['f64-integer']);
});

test('同值不同拼写、u64 精度、普通值差', () => {
  assert.deepEqual(tags(classifyJsonText('[1e-7]', '[1E-7]')), ['float-spelling']);
  assert.deepEqual(tags(classifyJsonText('[9007199254740993]', '[9007199254740992]')), ['u64-precision']);
  assert.deepEqual(tags(classifyJsonText('[1]', '[2]')), ['value']);
});

test('None：Rust 省略 vs 宿主写 null，及反向；省略 vs 空容器是 skip-default', () => {
  const omit = classifyJsonText('{"a":1}', '{"a":1,"b":null}');
  assert.deepEqual(tags(omit), ['none-null-vs-omit']);
  assert.equal(omit.findings[0].direction, 'rust-omit');
  assert.equal(omit.findings[0].path, '$.b');
  assert.equal(classifyJsonText('{"a":1,"b":null}', '{"a":1}').findings[0].direction, 'rust-null');
  assert.deepEqual(tags(classifyJsonText('{"a":1}', '{"a":1,"t":[]}')), ['skip-default']);
  assert.deepEqual(tags(classifyJsonText('{"a":1}', '{"a":1,"t":"x"}')), ['field-set']);
});

test('键序：同键同值不同序；嵌套差异不重复报键序', () => {
  const r = classifyJsonText('{"a":1,"b":{"x":1,"y":2}}', '{"b":{"y":2,"x":1},"a":1}');
  assert.deepEqual(tags(r), ['key-order', 'key-order']);
  assert.deepEqual(r.findings.map((f) => f.path).sort(), ['$', '$.b']);
  assert.deepEqual(tags(classifyJsonText('{"a":1,"b":2}', '{"a":1,"b":2}')), []);
});

test('时间格式：同一时刻不同文本', () => {
  assert.deepEqual(tags(classifyJsonText('{"t":"2026-01-02T03:04:05Z"}', '{"t":"2026-01-02T03:04:05.000Z"}')), ['time-format']);
  assert.deepEqual(tags(classifyJsonText('{"t":"2026-01-02T03:04:05+00:00"}', '{"t":"2026-01-02T03:04:05Z"}')), ['time-format']);
  assert.deepEqual(tags(classifyJsonText('{"t":"2026-01-02T03:04:05Z"}', '{"t":"2026-01-02T03:04:06Z"}')), ['value']);
});

test('类型差、占位符不等视为值差（环境），非 JSON 返回 undefined', () => {
  assert.deepEqual(tags(classifyJsonText('{"a":"1"}', '{"a":1}')), ['type']);
  assert.deepEqual(tags(classifyJsonText('[<n@s1:a>]', '[<n@s1:a>]')), []);
  assert.equal(classifyJsonText('abc', '{"a":1}'), undefined);
  assert.equal(classifyJsonText('12', '12.0'), undefined, '标量文本不是 JSON 列');
});

test('IPC outcome 差异（比较器只按值比较）：None 与数值精度', () => {
  assert.deepEqual(tags(classifyOutcome({ path: '/config', actual: null, missing: 'expected' })), ['none-null-vs-omit']);
  assert.equal(classifyOutcome({ path: '/config', actual: null, missing: 'expected' }).findings[0].direction, 'rust-omit');
  assert.equal(classifyOutcome({ path: '/x', expected: null, missing: 'actual' }).findings[0].direction, 'rust-null');
  assert.deepEqual(tags(classifyOutcome({ path: '/x', expected: [1], missing: 'actual' })), ['field-set']);
  assert.deepEqual(tags(classifyOutcome({ path: '/p/0', expected: 0.212, actual: 0.21199999749660492 })), ['f32-precision']);
  assert.deepEqual(tags(classifyOutcome({ path: '/t', expected: '2026-01-02T03:04:05Z', actual: '2026-01-02T03:04:05.000Z' })), ['time-format']);
  assert.deepEqual(tags(classifyOutcome({ path: '/n', expected: 2, actual: 3 })), ['value']);
  assert.deepEqual(tags(classifyOutcome({ path: '/a', expected: { x: null }, actual: {} })), ['none-null-vs-omit']);
});
