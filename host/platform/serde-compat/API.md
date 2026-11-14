# serde-compat（`host/platform/serde-compat`）

产出与 Rust `serde_json`（1.0.149，`preserve_order`；桌面图经 starlark 打开 `arbitrary_precision`）
**逐字节一致**的 JSON。纯函数模块，无 Cordis 服务；不依赖 Node API，`JSON.rawJSON` 缺失时
`toRustJson` 照常工作（只有 `*Atom` 需要它）。

## 入口

| API | 用途 |
|---|---|
| `toRustJson(value, schema, {pretty?})` | DB 写入：替换 `JSON.stringify(value)`；`pretty` = `to_string_pretty` |
| `toRustValue(value, schema)` | IPC 返回值：Rust 输出经前端 `JSON.parse` 后的值（键序、缺省键、`null`、f32 投影；>2^53 整数为 bigint） |
| `formatF64(x)` / `formatF32(x)` / `formatInt(kind, x)` | 单个数字的 Rust 拼写（`92` → `92.0`；f32 最短往返；NaN → `null`） |
| `f64Atom(x)` / `f32Atom(x)` | kernel 原生数字原子：手工组装对象后 `JSON.stringify` 写出 Rust 拼写 |
| `fromContractSchema(schema, {resolver, base})` + `contractResolver(docs)` | 从 `contracts/ipc/*.json`（F5 自 Rust 源码抽取）得到 schema |
| `rs.*` | 手写 schema（引用 Rust 结构体 file:line） |
| `RustShapeError` | 输入与 schema 不符（Rust 侧不可能出现的值），带 `$.a[0].b` 路径；整数越界抛 `RangeError` |

## 输入约定：线上形状

输入就是 Rust 输出被 `JSON.parse` 后的样子，所以 `toRustJson(JSON.parse(rustText), schema) === rustText`
（`tests/g3-golden.test.ts` 用 G3 A 侧真实 Rust 输出验证）。

- struct：按序列化后的键名（rename / rename_all 之后）取值；`from` 可改输入属性名。
  缺失的 `Option` 字段 = `None`；带 `skipIf` 的字段缺失 = 被跳过；其余缺失报错。
  多余属性默认丢弃（Rust struct 不会有它们），`unknown: 'error'` 时报错。
- enum：外部标记 `"Unit"` / `{"Variant": payload}`；内部标记 `{tag: "V", ...fields}`；
  相邻标记 `{tag, content}`；untagged 按变体顺序取第一个能写出的（先严格不容多余键，再放宽）。
- 数字：`number` / `bigint` / 原生数字原子均可；整数类型只接受安全整数的 `number`（更大的值须给 bigint）。
- `Map` 输入可保留整数样式键的插入顺序（普通对象会把它们提前）。

## `rs` 构造器

```ts
import { rs, toRustJson } from '../../platform/serde-compat/index.ts';

// dstu-vfs/src/vfs/pdf_processing_service.rs:222 ProcessingProgress
const ProcessingProgress = rs.struct({
  stage: rs.string,
  current_page: rs.field(rs.option(rs.usize), { skipIf: 'none' }),
  percent: rs.f32,
  ready_modes: rs.vec(rs.string),
  media_type: rs.field(rs.option(rs.string), { skipIf: 'none' }),
}, { renameAll: 'camelCase' });

db.run(sql, [toRustJson(progress, ProcessingProgress)]);
```

| 构造器 | Rust |
|---|---|
| `rs.bool` `rs.string` `rs.char` `rs.unit` | `bool` `String` `char` `()` |
| `rs.u8`…`rs.u128` `rs.i8`…`rs.i128` `rs.usize` `rs.isize` | 整数 |
| `rs.f32` `rs.f64` | 浮点（f64 整数值带 `.0`；f32 先 `as f32` 再取最短十进制） |
| `rs.option(T)` | `Option<T>`（None → `null`）；配合 `rs.field(…, {skipIf: 'none'})` = `skip_serializing_if = "Option::is_none"` |
| `rs.field(T, {rename, from, skipIf, flatten})` | 字段属性；`skipIf`: `'none' \| 'empty' \| 'false' \| 'zero' \| (v) => boolean` |
| `rs.struct(fields, {renameAll, name, unknown})` | `#[derive(Serialize)] struct`，字段对象的键序 = 声明顺序 |
| `rs.enum(variants, {tag, content, untagged, renameAll})` | enum；变体值 `null` = 单元变体，`rs.variant(T, {rename})` |
| `rs.vec(T)` `rs.tuple(A, B)` | `Vec<T>` / 元组 |
| `rs.hashMap(V, K?)` | `HashMap`：Rust 键序不确定，按输入顺序 |
| `rs.btreeMap(V, K?)` | `BTreeMap`：String 键按 UTF-8 字节序，整数键按数值（写成字符串） |
| `rs.indexMap(V, K?)` | `IndexMap` / `serde_json::Map`：插入顺序 |
| `rs.value({integralFloats})` | `serde_json::Value`：整数值写整数（`'float'` 时按 f64），原子原样 |
| `rs.valueObject({k: T}, {rest})` | 键按输入顺序的 Value 对象，已知键有类型（`json!({...})` / `Map::insert(k, json!(typed))`） |
| `rs.dateTimeUtc` | `DateTime<Utc>`：RFC 3339 AutoSi + `Z`；输入 Date / 纪元毫秒 / 纪元纳秒 bigint / chrono 可解析文本 |
| `rs.naiveDateTime` | `NaiveDateTime`：`YYYY-MM-DDTHH:MM:SS[.fff…]` |
| `rs.literal(...)` `rs.union(...)` | 常量 / 依序匹配的分支 |
| `rs.custom(name, write)` `rs.lazy(name, get)` | `serialize_with` / 递归类型 |

## 契约 schema

`fromContractSchema({ $ref: 'L16-anki.json#/$defs/FieldExtractionRule' }, { resolver, base: 'L16-anki.json' })`。
平台代码不读文件：调用方把需要的契约文档交给 `contractResolver({ 'L16-anki.json': doc, '_shared.json': shared })`。

- 只接受**序列化形状**（对象带 `additionalProperties`）。反序列化形状（`X__De`，或只作命令参数的类型）
  不记录 `skip_serializing_if`，使用时报 `deserialization-form`；这类 DB 写入请按 Rust 源码手写 `rs.struct`。
- BTreeMap 与 IndexMap 在契约里不可区分，默认插入序（`mapOrder: 'sorted'` 可改）。
- 非标准的 `x-skip-serializing-if`（如 `ApkgMediaReport::is_empty`）须经 `skipPredicates` 提供。
- `x-serde-with: serialize_option_string_as_string`：None → `""`。

## 依据

- serde_json 1.0.149 `src/ser.rs`（f32/f64 → zmij，NaN/Inf → null，字符串 ESCAPE 表，PrettyFormatter）；
  zmij 1.0.21 `src/lib.rs:1029-1135`（f32 定点 [-6, 12]、f64 [-5, 15]，`e+X`）。
- serde_derive 1.0.228 `src/ser.rs`、`src/internals/case.rs`（字段顺序、skip、rename_all、enum 表示、flatten）。
- chrono 0.4.41 `src/datetime/serde.rs:32-45`、`src/format/formatting.rs:498-543`、`src/naive/time/mod.rs:1504-1529`。
- 复用：`platform/util/json-exact.ts` `ryuFormat`（zmij f64）、`platform/util/f32-json.ts` `f32ToJsonNumber`、
  `kernel/serde.ts` `isJsonNumberAtom`、`platform/time` `toRfc3339Opts` / `parseChronoDateTimeUtc`。
