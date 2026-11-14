// 期望值依据（serde 1.0.228 / serde_derive 1.0.228 / serde_json 1.0.149 / chrono 0.4.41，Cargo.lock 锁定）：
// - derive(Serialize) 的 struct 按字段声明顺序 `serialize_field`；`skip_serializing_if` 为真时跳过该键；
//   Option 无该属性时 None → `null`（serde_derive src/ser.rs serialize_struct_visitor）。
// - rename_all 规则：serde_derive src/internals/case.rs（apply_to_field / apply_to_variant）。
// - enum：外部标记 `"Unit"` / `{"V":payload}`；内部标记先写 tag 再写字段；相邻标记 `{tag, content}`，
//   单元变体只有 tag；untagged 直接写 payload，单元变体为 `null`（serde_derive src/ser.rs）。
// - flatten：外层改走 serialize_map，内层键按顺序并入（serde src/private/ser.rs FlatMapSerializer）。
// - HashMap 键序不确定（std RandomState）；BTreeMap 按键 Ord：String 为字节序（= Unicode 码点序），
//   整数按数值；serde_json 把整数键写成字符串（ser.rs MapKeySerializer）。
// - serde_json::Value + preserve_order：对象按插入顺序（IndexMap）。
// - 字符串转义：serde_json ser.rs ESCAPE 表——`"` `\\` 与 U+0000..U+001F（\b \t \n \f \r 用短形式，其余 \u00XX 小写），
//   `/`、U+007F、U+2028 与非 ASCII 原样输出。
// - chrono DateTime<Utc>：datetime/serde.rs:32-45 → write_rfc3339(AutoSi, use_z=true)（format/formatting.rs:498-543）；
//   NaiveDateTime：Debug 格式（naive/time/mod.rs:1504-1529 的 0/3/6/9 位小数）。
// - to_string_pretty：PrettyFormatter 两空格缩进，`": "`，空容器写 `[]` / `{}`（ser.rs PrettyFormatter）。
import { describe, expect, it } from 'vitest';
import { applyToField, applyToVariant } from '../../../../scripts/electron-migration/contracts/lib/case.ts';
import { renameField, renameVariant, rs, RustShapeError, toRustJson, toRustValue } from '../index.ts';

/** dstu-vfs/src/vfs/pdf_processing_service.rs:222-247 ProcessingProgress（rename_all camelCase）。 */
const ProcessingProgress = rs.struct({
  stage: rs.string,
  current_page: rs.field(rs.option(rs.usize), { skipIf: 'none' }),
  total_pages: rs.field(rs.option(rs.usize), { skipIf: 'none' }),
  percent: rs.f32,
  ready_modes: rs.vec(rs.string),
  media_type: rs.field(rs.option(rs.string), { skipIf: 'none' }),
}, { renameAll: 'camelCase', name: 'ProcessingProgress' });

describe('struct：声明顺序 + skip_serializing_if', () => {
  it('输入键序无关，输出按声明顺序；None 按属性省略', () => {
    const input = { mediaType: 'audio', readyModes: ['text'], percent: 85, stage: 'indexing', currentPage: null };
    expect(toRustJson(input, ProcessingProgress)).toBe('{"stage":"indexing","percent":85.0,"readyModes":["text"],"mediaType":"audio"}');
  });

  it('Option 无 skip 时 None（null/undefined/缺键）写 null', () => {
    const S = rs.struct({ a: rs.option(rs.string), b: rs.option(rs.f64), c: rs.bool });
    expect(toRustJson({ c: true }, S)).toBe('{"a":null,"b":null,"c":true}');
    expect(toRustJson({ a: undefined, b: 2, c: false }, S)).toBe('{"a":null,"b":2.0,"c":false}');
  });

  it('empty / false / zero / 自定义谓词', () => {
    const S = rs.struct({
      list: rs.field(rs.vec(rs.u8), { skipIf: 'empty' }),
      text: rs.field(rs.string, { skipIf: 'empty' }),
      map: rs.field(rs.hashMap(rs.string), { skipIf: 'empty' }),
      flag: rs.field(rs.bool, { skipIf: 'false' }),
      count: rs.field(rs.u32, { skipIf: 'zero' }),
      odd: rs.field(rs.i32, { skipIf: (v) => Number(v) % 2 === 1 }),
    });
    expect(toRustJson({ list: [], text: '', map: {}, flag: false, count: 0, odd: 3 }, S)).toBe('{}');
    expect(toRustJson({ list: [1], text: 'x', map: { k: 'v' }, flag: true, count: 2, odd: 4 }, S))
      .toBe('{"list":[1],"text":"x","map":{"k":"v"},"flag":true,"count":2,"odd":4}');
  });

  it('rename 覆盖 rename_all；from 指定输入属性名', () => {
    const S = rs.struct({
      user_id: rs.u32,
      kind: rs.field(rs.string, { rename: 'TYPE' }),
      display_name: rs.field(rs.string, { from: 'name' }),
    }, { renameAll: 'camelCase' });
    expect(toRustJson({ userId: 7, TYPE: 'x', name: 'n' }, S)).toBe('{"userId":7,"TYPE":"x","displayName":"n"}');
  });

  it('缺必填字段、类型不符、unknown: error 时多余键都报 RustShapeError（含路径）', () => {
    const S = rs.struct({ a: rs.u32, b: rs.vec(rs.struct({ c: rs.string })) }, { unknown: 'error' });
    expect(() => toRustJson({ b: [] }, S)).toThrow(/\$\.a: missing/);
    expect(() => toRustJson({ a: 1, b: [{ c: 2 }] }, S)).toThrow(/\$\.b\[0\]\.c: expected string/);
    expect(() => toRustJson({ a: 1, b: [], z: 1 }, S)).toThrow(RustShapeError);
    expect(toRustJson({ a: 1, b: [], z: 1 }, rs.struct({ a: rs.u32, b: rs.vec(rs.unit) }))).toBe('{"a":1,"b":[]}');
  });

  it('flatten：内层 struct 与 map 的键依次并入', () => {
    const Inner = rs.struct({ x: rs.f64, y: rs.f64 });
    const S = rs.struct({
      id: rs.string,
      pos: rs.field(Inner, { flatten: true }),
      rest: rs.field(rs.indexMap(rs.value()), { flatten: true }),
    });
    expect(toRustJson({ id: 'a', x: 1, y: 2.5, extra: 1, more: [1.5] }, S)).toBe('{"id":"a","x":1.0,"y":2.5,"extra":1,"more":[1.5]}');
  });

  it('newtype / tuple / unit', () => {
    expect(toRustJson([1, 'a', null], rs.tuple(rs.f32, rs.string, rs.unit))).toBe('[1.0,"a",null]');
    expect(() => toRustJson([1], rs.tuple(rs.f32, rs.string))).toThrow(RustShapeError);
  });
});

describe('rename_all（与 F5 契约抽取器 case.ts 对照）', () => {
  const rules = ['lowercase', 'UPPERCASE', 'PascalCase', 'camelCase', 'snake_case', 'SCREAMING_SNAKE_CASE', 'kebab-case', 'SCREAMING-KEBAB-CASE'] as const;
  it.each(rules)('%s', (rule) => {
    for (const field of ['user_id', 'a', 'max_output_tokens', 'x1_y2']) expect(renameField(field, rule)).toBe(applyToField(rule, field));
    for (const variant of ['Pdf', 'HTTPServer', 'WaitingLogin', 'A1B']) expect(renameVariant(variant, rule)).toBe(applyToVariant(rule, variant));
  });
});

describe('enum 表示', () => {
  const variants = { Pdf: null, Text: rs.string, Point: rs.struct({ x: rs.f64, y: rs.f64 }), Pair: rs.tuple(rs.u8, rs.u8) };
  it('外部标记（默认）', () => {
    const E = rs.enum(variants, { renameAll: 'snake_case' });
    expect(toRustJson('pdf', E)).toBe('"pdf"');
    expect(toRustJson({ text: 'a' }, E)).toBe('{"text":"a"}');
    expect(toRustJson({ point: { y: 2, x: 1 } }, E)).toBe('{"point":{"x":1.0,"y":2.0}}');
    expect(toRustJson({ pair: [1, 2] }, E)).toBe('{"pair":[1,2]}');
    expect(() => toRustJson('Pdf', E)).toThrow(RustShapeError);
  });
  it('内部标记：tag 在前', () => {
    const E = rs.enum({ Pdf: null, Point: rs.struct({ x: rs.f64, y: rs.f64 }) }, { tag: 'type' });
    expect(toRustJson({ type: 'Pdf' }, E)).toBe('{"type":"Pdf"}');
    expect(toRustJson({ y: 2, type: 'Point', x: 1 }, E)).toBe('{"type":"Point","x":1.0,"y":2.0}');
  });
  it('相邻标记：单元变体只有 tag', () => {
    const E = rs.enum(variants, { tag: 't', content: 'c' });
    expect(toRustJson({ t: 'Pdf' }, E)).toBe('{"t":"Pdf"}');
    expect(toRustJson({ c: 'a', t: 'Text' }, E)).toBe('{"t":"Text","c":"a"}');
  });
  it('untagged：按顺序取第一个结构匹配的变体，单元变体为 null', () => {
    const E = rs.enum({ Nothing: null, Num: rs.f64, Point: rs.struct({ x: rs.f64, y: rs.f64 }), Text: rs.string }, { untagged: true });
    expect(toRustJson(null, E)).toBe('null');
    expect(toRustJson(3, E)).toBe('3.0');
    expect(toRustJson({ x: 1, y: 2 }, E)).toBe('{"x":1.0,"y":2.0}');
    expect(toRustJson('s', E)).toBe('"s"');
    expect(() => toRustJson([1], E)).toThrow(RustShapeError);
  });
});

describe('map 键序', () => {
  it('HashMap/IndexMap 保留输入顺序；Map 输入可保留整数样式键的顺序', () => {
    expect(toRustJson({ b: 1, a: 2 }, rs.hashMap(rs.f64))).toBe('{"b":1.0,"a":2.0}');
    expect(toRustJson(new Map([['2', 1], ['1', 2]]), rs.indexMap(rs.u8))).toBe('{"2":1,"1":2}');
  });
  it('BTreeMap<String,_> 按 UTF-8 字节序（不是 UTF-16 码元序）', () => {
    const input = { b: 1, 'é': 2, Z: 3, '😀': 4, '\uffff': 5, a: 6 };
    expect(toRustJson(input, rs.btreeMap(rs.u8))).toBe('{"Z":3,"a":6,"b":1,"é":2,"\uffff":5,"😀":4}');
  });
  it('整数键按数值排序并写成字符串', () => {
    expect(toRustJson({ 10: 'a', 2: 'b', 1: 'c' }, rs.btreeMap(rs.string, 'u32'))).toBe('{"1":"c","2":"b","10":"a"}');
    expect(() => toRustJson({ x: 'a' }, rs.btreeMap(rs.string, 'u32'))).toThrow(RustShapeError);
  });
});

describe('serde_json::Value（preserve_order）', () => {
  it('u64/i64 范围内的整数值写整数，其余按 f64；原子与 bigint 保留精度', () => {
    const raw = (JSON as unknown as { rawJSON(t: string): unknown }).rawJSON;
    const value = { b: 1, a: [1.5, 2, -0, 1e16, 1e300, raw('525600.0'), raw('1E5'), 9007199254740993n], n: null, s: 'x' };
    expect(toRustJson(value, rs.value())).toBe('{"b":1,"a":[1.5,2,0,10000000000000000,1e+300,525600.0,1e+5,9007199254740993],"n":null,"s":"x"}');
  });
  it('integralFloats: float——整数值按 f64 写 `.0`（json!(f64) 产生的 Value）', () => {
    expect(toRustJson({ steps: [0.5, 525600] }, rs.value({ integralFloats: 'float' }))).toBe('{"steps":[0.5,525600.0]}');
  });
  it('undefined 成员按 JSON.stringify 规则省略；非有限数字写 null', () => {
    expect(toRustJson({ a: undefined, b: Number.NaN }, rs.value())).toBe('{"b":null}');
  });
});

describe('字符串转义与 serde_json ESCAPE 表一致', () => {
  it('控制字符、引号、反斜杠转义；其他原样', () => {
    const s = '"\\\u0000\u0008\t\n\u000b\u000c\r\u001f\u007f/\u2028中😀';
    expect(toRustJson(s, rs.string)).toBe('"\\"\\\\\\u0000\\b\\t\\n\\u000b\\f\\r\\u001f\u007f/\u2028中😀"');
  });
  it('char 只接受单个 Unicode 标量', () => {
    expect(toRustJson('😀', rs.char)).toBe('"😀"');
    expect(() => toRustJson('ab', rs.char)).toThrow(RustShapeError);
  });
});

describe('chrono', () => {
  it('DateTime<Utc>：AutoSi 小数位、Z、偏移换算到 UTC', () => {
    expect(toRustJson(new Date(0), rs.dateTimeUtc)).toBe('"1970-01-01T00:00:00Z"');
    expect(toRustJson(new Date(Date.UTC(2026, 10, 7, 1, 2, 3, 120)), rs.dateTimeUtc)).toBe('"2026-11-07T01:02:03.120Z"');
    expect(toRustJson(1_700_000_000_000_001_000n, rs.dateTimeUtc)).toBe('"2023-11-14T22:13:20.000001Z"');
    expect(toRustJson(1, rs.dateTimeUtc)).toBe('"1970-01-01T00:00:00.001Z"');
    expect(toRustJson('2024-01-01T08:00:00.5+08:00', rs.dateTimeUtc)).toBe('"2024-01-01T00:00:00.500Z"');
    expect(toRustJson('2024-01-01T00:00:00.123456789Z', rs.dateTimeUtc)).toBe('"2024-01-01T00:00:00.123456789Z"');
    expect(() => toRustJson('not a date', rs.dateTimeUtc)).toThrow(RustShapeError);
  });
  it('NaiveDateTime：无时区后缀', () => {
    expect(toRustJson('2024-01-01 08:00:00', rs.naiveDateTime)).toBe('"2024-01-01T08:00:00"');
    expect(toRustJson(new Date(Date.UTC(2024, 0, 1, 8, 0, 0, 5)), rs.naiveDateTime)).toBe('"2024-01-01T08:00:00.005"');
  });
});

describe('to_string_pretty', () => {
  it('两空格缩进，空容器紧凑', () => {
    const S = rs.struct({ a: rs.vec(rs.f64), b: rs.hashMap(rs.u8), c: rs.vec(rs.u8), d: rs.hashMap(rs.u8) });
    expect(toRustJson({ a: [1, 2.5], b: { k: 1 }, c: [], d: {} }, S, { pretty: true }))
      .toBe('{\n  "a": [\n    1.0,\n    2.5\n  ],\n  "b": {\n    "k": 1\n  },\n  "c": [],\n  "d": {}\n}');
  });
});

describe('toRustValue（IPC 返回值：前端 JSON.parse 后可见的形状）', () => {
  it('键按声明顺序、skip 的键不存在、None 为 null、f32 投影为最短十进制', () => {
    const S = rs.struct({ b: rs.option(rs.string), a: rs.f32, c: rs.field(rs.option(rs.u8), { skipIf: 'none' }), d: rs.u64 });
    const out = toRustValue({ a: 0.1 + 0.2, d: 2n ** 60n }, S) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(['b', 'a', 'd']);
    expect(out).toEqual({ b: null, a: 0.3, d: 2n ** 60n });
    expect(toRustValue(Number.NaN, rs.f64)).toBeNull();
    expect(toRustValue(new Date(0), rs.dateTimeUtc)).toBe('1970-01-01T00:00:00Z');
  });
});
