import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideDbSource, decideIpc } from '../lib/decide.mjs';

const feats = (o) => new Map(Object.entries(o));
const rust = { how: 'to_string', structOrder: ['stage', 'currentPage', 'percent'] };

test('f32 字段 + JSON.stringify：浮点整数 .0 与 f32 精度；G3 命中升为 high', () => {
  const d = decideDbSource({ writer: 'JSON.stringify' }, { ...rust, features: feats({ f32: ['.percent'] }) }, { tags: { 'f64-integer': [{ path: '$.percent', count: 4 }] }, occurrences: 20 });
  const byType = Object.fromEntries(d.map((x) => [x.type, x]));
  assert.equal(byType.f64.confidence, 'high');
  assert.equal(byType.f64.g3, 4);
  assert.equal(byType.precision.confidence, 'medium');
  assert.equal(byType.precision.decision, '需人工核对');
});

test('安全写法不报；Rust 未解析出类型时只报需人工核对', () => {
  assert.deepEqual(decideDbSource({ writer: 'safe:toRustJson' }, { ...rust, features: feats({ f64: ['.x'] }) }, undefined), []);
  const d = decideDbSource({ writer: 'JSON.stringify' }, { how: 'to_string', features: null }, undefined);
  assert.deepEqual(d.map((x) => [x.type, x.decision]), [['other', '需人工核对']]);
});

test('对象字面量：键序与 Rust 声明序比较；缺 Option(null) 键、Option(omit) 写 null 自动判定', () => {
  const keys = [{ key: 'percent', value: 'p' }, { key: 'stage', value: "'x'" }, { key: 'currentPage', value: 'page ?? null' }];
  const d = decideDbSource({ writer: 'JSON.stringify', keys }, { ...rust, features: feats({ struct: ['$'], 'option-omit': ['.currentPage'], 'option-null': ['.note'] }), structOrder: ['stage', 'currentPage', 'percent', 'note'] }, undefined);
  const byType = Object.fromEntries(d.map((x) => [x.type, x]));
  assert.equal(byType['key-order'].confidence, 'high');
  assert.equal(byType['key-order'].decision, '自动判定');
  assert.match(byType.none.detail, /currentPage/);
  assert.match(byType.none.detail, /note/);
  assert.equal(byType.none.confidence, 'high');

  const ok = decideDbSource({ writer: 'JSON.stringify', keys: [{ key: 'stage', value: 's' }, { key: 'percent', value: 'p' }] }, { ...rust, features: feats({ struct: ['$'] }) }, undefined);
  assert.deepEqual(ok, []);
});

test('HashMap 键序：Rust 侧不确定，标注为比较器归一化问题；pretty 不一致是 other', () => {
  const d = decideDbSource({ writer: 'JSON.stringify' }, { how: 'to_string_pretty', features: feats({ hashmap: ['$'] }) }, { tags: { 'key-order': [{ path: '$', count: 128 }] }, occurrences: 1554 });
  const byType = Object.fromEntries(d.map((x) => [x.type, x]));
  assert.equal(byType['key-order'].g3, 128);
  assert.match(byType['key-order'].detail, /HashMap/);
  assert.equal(byType.other.confidence, 'high');
  assert.match(byType.other.detail, /pretty/);
});

test('G3 键序按路径归属：HashMap 字段内的不可修，其余是结构体序（可修）', () => {
  const g3 = { tags: { 'key-order': [{ path: '$.rules_by_id.design', count: 2 }, { path: '$.rules', count: 2 }, { path: '$', count: 5 }] }, occurrences: 19 };
  const d = decideDbSource({ writer: 'JSON.stringify' }, { how: 'to_string', features: feats({ struct: ['$'], hashmap: ['.rules', '.rules_by_id'] }) }, g3);
  const orders = d.filter((x) => x.type === 'key-order');
  assert.equal(orders.length, 2);
  assert.equal(orders.find((x) => /^HashMap /.test(x.detail)).g3, 4);
  assert.equal(orders.find((x) => !/^HashMap /.test(x.detail)).g3, 5);
});

test('宿主来源未解析但 Rust 类型已知：按 Rust 特征列出，非 G3 项降为 low', () => {
  const d = decideDbSource({ writer: '?' }, { how: 'to_string', features: feats({ f64: ['.x'], hashmap: ['$'] }) }, { tags: { 'key-order': [{ path: '$', count: 3 }] }, occurrences: 3 });
  const byType = Object.fromEntries(d.map((x) => [x.type, x]));
  assert.equal(byType.f64.confidence, 'low');
  assert.match(byType.f64.detail, /宿主来源未解析/);
  assert.equal(byType['key-order'].confidence, 'high');
});

test('IPC：Option(omit) 与 f32 需人工核对，G3 命中则 high；仅 Option(null) 不报（debug 契约校验会拦）', () => {
  const d = decideIpc(feats({ 'option-omit': ['.config'], f32: ['.fsrsParams[]'], 'option-null': ['.x'], bigint: ['.n'] }), { tags: { 'none-null-vs-omit': [{ path: '$.config', count: 1 }] }, occurrences: 16 });
  const byType = Object.fromEntries(d.map((x) => [x.type, x]));
  assert.equal(byType.none.confidence, 'high');
  assert.equal(byType.precision.decision, '需人工核对');
  assert.equal(byType.u64, undefined);
  assert.deepEqual(decideIpc(feats({ 'option-null': ['.x'] }), undefined), []);
});
