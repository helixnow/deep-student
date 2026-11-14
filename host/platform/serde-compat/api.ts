/**
 * serde-compat：声明式描述 Rust 类型，按 serde_json 1.0.149（`preserve_order`，桌面图中经 starlark
 * 打开 `arbitrary_precision`）的规则输出与 Rust 字节一致的 JSON。
 *
 * 只描述**序列化**形状。输入按"线上形状"给出：结构体按序列化后的键名（rename/rename_all 之后）取值，
 * enum 按它序列化后的样子给出（外部标记 `"A"` / `{"A": …}`，内部标记 `{tag: "A", …}`，相邻标记
 * `{tag, content}`）。因此 `toRustJson(JSON.parse(rustText), schema) === rustText` 对任意 Rust 输出成立
 * （HashMap 的键序除外，它在 Rust 侧本身不确定）。
 *
 * 不依赖 Node 专有 API（移动端 Capacitor WebView 同样可用）。
 */

export type IntKind = 'u8' | 'u16' | 'u32' | 'u64' | 'u128' | 'usize' | 'i8' | 'i16' | 'i32' | 'i64' | 'i128' | 'isize';
export type FloatKind = 'f32' | 'f64';

/** `#[serde(rename_all = "...")]` 的取值（serde_derive-1.0.228 src/internals/case.rs）。 */
export type RenameRule =
  | 'lowercase' | 'UPPERCASE' | 'PascalCase' | 'camelCase'
  | 'snake_case' | 'SCREAMING_SNAKE_CASE' | 'kebab-case' | 'SCREAMING-KEBAB-CASE';

/**
 * `skip_serializing_if`：
 * - `none`：`Option::is_none`
 * - `empty`：`Vec/HashMap/String::is_empty`
 * - `false`：`is_false`（`!*b`）
 * - `zero`：`is_zero`（数值 0）
 * - 函数：自定义谓词，参数为输入值（已是线上形状）
 */
export type SkipIf = 'none' | 'empty' | 'false' | 'zero' | ((value: unknown) => boolean);

/** Map 键序：`insertion` = IndexMap / serde_json::Map(preserve_order)；`sorted` = BTreeMap；`unspecified` = HashMap。 */
export type MapOrder = 'insertion' | 'sorted' | 'unspecified';

export interface FieldSpec {
  readonly schema: RustSchema;
  /** `#[serde(rename = "...")]`：覆盖 rename_all 的结果。 */
  readonly rename?: string;
  /** 输入对象上的属性名；默认等于序列化后的键名。 */
  readonly from?: string;
  readonly skipIf?: SkipIf;
  /** `#[serde(flatten)]`：内层 struct/map 的键并入当前层。 */
  readonly flatten?: boolean;
}

export interface VariantSpec {
  /** `null` = 单元变体；其他 schema = newtype / tuple（用 `tuple`）/ struct 变体。 */
  readonly schema: RustSchema | null;
  readonly rename?: string;
}

/** enum 的表示（serde 文档 "Enum representations"）。 */
export type EnumRepr =
  | { readonly kind: 'external' }
  | { readonly kind: 'internal'; readonly tag: string }
  | { readonly kind: 'adjacent'; readonly tag: string; readonly content: string }
  | { readonly kind: 'untagged' };

export type RustSchema =
  | { readonly kind: 'bool' }
  | { readonly kind: 'string' }
  | { readonly kind: 'char' }
  | { readonly kind: 'int'; readonly int: IntKind }
  | { readonly kind: 'float'; readonly float: FloatKind }
  /** `()` / unit struct：`null`。 */
  | { readonly kind: 'unit' }
  | { readonly kind: 'option'; readonly inner: RustSchema }
  | { readonly kind: 'seq'; readonly items: RustSchema }
  | { readonly kind: 'tuple'; readonly items: readonly RustSchema[] }
  | { readonly kind: 'map'; readonly key: 'string' | IntKind; readonly value: RustSchema; readonly order: MapOrder }
  | {
    readonly kind: 'struct';
    readonly name?: string;
    /** 声明顺序即输出顺序；键为 Rust 字段名（rename_all 作用于它）。 */
    readonly fields: readonly (readonly [string, FieldSpec])[];
    readonly renameAll?: RenameRule;
    /** 结构体之外的输入属性：`drop`（默认，Rust struct 不会有它们）或 `error`。 */
    readonly unknown?: 'drop' | 'error';
  }
  | {
    readonly kind: 'enum';
    readonly name?: string;
    readonly repr: EnumRepr;
    readonly variants: readonly (readonly [string, VariantSpec])[];
    readonly renameAll?: RenameRule;
  }
  /** 只能取给定字符串之一（全为单元变体的外部标记 enum 或契约里的 `enum`）。 */
  | { readonly kind: 'literal'; readonly values: readonly unknown[] }
  /** 按顺序选第一个结构上匹配的分支（契约 `oneOf/anyOf`、`#[serde(untagged)]`）。 */
  | { readonly kind: 'union'; readonly branches: readonly RustSchema[] }
  /** `serde_json::Value`（preserve_order）。 */
  | { readonly kind: 'value'; readonly integralFloats?: 'int' | 'float' }
  /**
   * 键按输入顺序的 `serde_json::Map`（preserve_order），已知键有 Rust 类型：
   * 典型来源是 `json!({...})` 或读改写 `Map::insert(k, json!(typed))`。未列出的键按 `rest`（默认 Value）。
   */
  | { readonly kind: 'value-object'; readonly fields: readonly (readonly [string, RustSchema])[]; readonly rest: RustSchema }
  /** `chrono::DateTime<Utc>`：RFC 3339，SecondsFormat::AutoSi，UTC 写 `Z`。 */
  | { readonly kind: 'datetime' }
  /** `chrono::NaiveDateTime`：`YYYY-MM-DDTHH:MM:SS[.fff|.ffffff|.fffffffff]`。 */
  | { readonly kind: 'naive-datetime' }
  /** `#[serde(serialize_with = ...)]` 等：由调用方给出 JSON 文本。 */
  | { readonly kind: 'custom'; readonly name: string; readonly write: (value: unknown) => string; readonly matches?: (value: unknown) => boolean }
  /** 递归类型 / 契约 `$ref`：首次使用时求值。 */
  | { readonly kind: 'lazy'; readonly name: string; readonly get: () => RustSchema };

export interface RustJsonOptions {
  /** `serde_json::to_string_pretty`（两空格缩进、`": "`）。默认紧凑的 `to_string`。 */
  readonly pretty?: boolean;
}

/** `JSON.rawJSON` 产生的原生数字原子（kernel `isJsonNumberAtom` 判别）。 */
export type JsonNumberAtom = Readonly<{ rawJSON: string }>;

/** 输入与 schema 不符：Rust 侧不可能产生这样的值。`path` 为 JSON Pointer 风格的 `$.a[0].b`。 */
export class RustShapeError extends TypeError {
  readonly path: string;
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'RustShapeError';
    this.path = path;
  }
}
