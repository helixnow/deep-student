// contracts/ipc 的扩展关键字语义见 host/kernel/contract.ts：
// properties 顺序 = Rust 序列化顺序；required 之外的键带 `x-option: omit` 或 `x-skip-serializing-if`；
// `x-option: null` 的 Option 缺值写 null；`x-float`/`x-int` 为原 Rust 数值类型；
// `x-key-order: unspecified` 为 HashMap；`format: date-time` + `x-format` 为 chrono DateTime<Utc>。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contractResolver, fromContractSchema, RustShapeError, toRustJson } from '../index.ts';

const REPO = join(import.meta.dirname, '../../../..');
const load = (f: string) => JSON.parse(readFileSync(join(REPO, 'contracts/ipc', f), 'utf8'));

describe('fromContractSchema', () => {
  const docs = {
    'A.json': {
      $defs: {
        S: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            ratio: { type: 'number', 'x-float': 'f32' },
            total: { type: 'number', 'x-float': 'f64' },
            big: { type: 'integer', 'x-int': 'u64', minimum: 0 },
            note: { anyOf: [{ type: 'string' }, { type: 'null' }], 'x-option': 'null' },
            hint: { anyOf: [{ type: 'string' }, { type: 'null' }], 'x-option': 'omit' },
            tags: { type: 'array', items: { type: 'string' }, 'x-skip-serializing-if': 'Vec::is_empty' },
            at: { type: 'string', format: 'date-time', 'x-format': 'RFC 3339, SecondsFormat::AutoSi, Z for UTC' },
            child: { $ref: 'B.json#/$defs/Child' },
            map: { type: 'object', additionalProperties: { type: 'number', 'x-float': 'f64' }, 'x-key-order': 'unspecified' },
          },
          required: ['id', 'ratio', 'total', 'big', 'note', 'at', 'child', 'map'],
          additionalProperties: false,
        },
        Rec: {
          type: 'object',
          properties: { next: { anyOf: [{ $ref: '#/$defs/Rec' }, { type: 'null' }], 'x-option': 'null' } },
          required: ['next'],
          additionalProperties: false,
        },
        Custom: { type: 'object', properties: { r: { type: 'object', 'x-skip-serializing-if': 'Report::is_empty' } }, additionalProperties: false },
        Broken: { 'x-unresolved': 'internally tagged newtype' },
        Request: { type: 'object', properties: { a: { anyOf: [{ type: 'string' }, { type: 'null' }], 'x-option': 'null' } } },
        Flat: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
          additionalProperties: { type: 'number', 'x-float': 'f64' },
        },
      },
    },
    'B.json': { $defs: { Child: { type: 'object', properties: { v: { type: 'number', 'x-float': 'f64' } }, required: ['v'], additionalProperties: false } } },
  };
  const resolver = contractResolver(docs);
  const of = (name: string, extra = {}) => fromContractSchema({ $ref: `#/$defs/${name}` }, { resolver, base: 'A.json', ...extra });

  it('字段顺序、数值类型、Option/skip、跨文件 $ref、HashMap、date-time', () => {
    const input = {
      map: { z: 1, a: 2 }, child: { v: 3 }, at: '2026-01-01T08:00:00+08:00', tags: [], big: 2n ** 60n,
      note: undefined, total: 52, ratio: 0.1 + 0.2, id: 'x', hint: null,
    };
    expect(toRustJson(input, of('S'))).toBe(
      '{"id":"x","ratio":0.3,"total":52.0,"big":1152921504606846976,"note":null,"at":"2026-01-01T00:00:00Z","child":{"v":3.0},"map":{"z":1.0,"a":2.0}}');
  });

  it('递归类型', () => {
    expect(toRustJson({ next: { next: null } }, of('Rec'))).toBe('{"next":{"next":null}}');
  });

  it('未知 skip_serializing_if 谓词必须由调用方提供；x-unresolved 使用时报错', () => {
    expect(() => toRustJson({ r: {} }, of('Custom'))).toThrow(/Report::is_empty/);
    expect(toRustJson({ r: {} }, of('Custom', { skipPredicates: { 'Report::is_empty': (v: unknown) => Object.keys(v as object).length === 0 } }))).toBe('{}');
    expect(() => toRustJson({}, of('Broken'))).toThrow(RustShapeError);
  });

  it('反序列化形状（无 additionalProperties）默认拒绝；显式允许时 x-option: null 仍写 null', () => {
    expect(() => toRustJson({ a: 'x' }, of('Request'))).toThrow(/deserialization-form/);
    expect(toRustJson({}, of('Request', { allowDeserializeForm: true }))).toBe('{"a":null}');
  });

  it('flatten map（properties + additionalProperties schema）：其余键按输入顺序并入', () => {
    expect(toRustJson({ z: 1, id: 'a', b: 2.5 }, of('Flat'))).toBe('{"id":"a","z":1.0,"b":2.5}');
  });

  it('真实契约：外部标记 enum 的 oneOf（字符串 / 单键对象）', () => {
    const f3 = contractResolver({ 'F3-storage.json': load('F3-storage.json') });
    const CallerType = fromContractSchema({ $ref: '#/$defs/CallerType' }, { resolver: f3, base: 'F3-storage.json' });
    expect(toRustJson('chat_v2', CallerType)).toBe('"chat_v2"');
    expect(toRustJson({ other: 'x' }, CallerType)).toBe('{"other":"x"}');
    expect(() => toRustJson('nope', CallerType)).toThrow(RustShapeError);
  });

  it('真实契约：serialize_option_string_as_string（None → ""）', () => {
    const names = ['_shared.json', 'L15-review-analytics.json'];
    const all = Object.fromEntries(names.map((f) => [f, load(f)]));
    const hit = Object.entries(all).flatMap(([file, doc]) => Object.values((doc as { $defs: Record<string, { properties?: Record<string, Record<string, unknown>> }> }).$defs)
      .flatMap((def) => Object.values(def.properties ?? {})
        .filter((p) => String(p['x-serde-with'] ?? '').startsWith('serialize_option_string_as_string'))
        .map((schema) => ({ file, schema }))));
    expect(hit.length).toBeGreaterThan(0);
    const { file, schema } = hit[0]!;
    const field = fromContractSchema(schema, { resolver: contractResolver(all), base: file });
    expect(toRustJson(null, field)).toBe('""');
    expect(toRustJson(undefined, field)).toBe('""');
    expect(toRustJson('议论文', field)).toBe('"议论文"');
  });
});
