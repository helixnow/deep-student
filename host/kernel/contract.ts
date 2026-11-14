/**
 * IPC 契约文件格式：Node Host / 前端共同维护 JSON Schema，kernel 消费。
 *
 * 位置：`contracts/ipc/<lane>.json`，内容为 {@link LaneContract}；跨 lane 共用的类型
 * 放在 `contracts/ipc/_shared.json` 的 `$defs`，用 `"$ref": "_shared.json#/$defs/Name"` 引用。
 *
 * 规则：
 * - JSON 是源文件；`npm run contracts:generate` 生成 TS 类型，不读取 Rust。
 * - 存量 x-rust / rust 注解仅记录迁移来源；数值、枚举等语义注解仍由运行时消费。
 * - 未确定的形状保留 `x-unresolved`，禁止猜测。
 * - JSON Schema 方言：draft 2020-12。
 * - 修改已冻结契约须提交 contracts/CHANGES.md 变更单。
 */

/** JSON Schema（2020-12）加本项目扩展关键字。 */
export interface JsonSchema {
  [keyword: string]: unknown;
  /** 原 Rust 类型路径，例如 `dstu_vfs::vfs::types::VfsResource`。 */
  'x-rust'?: string;
  /**
   * 原 Rust 数值类型。JSON number 只能精确表示 ±2^53，超出时 serde_json 仍输出整数字面量。
   * 运行时实现须按原类型处理精度（见 README §3.3）。
   */
  'x-int'?: 'u8' | 'u16' | 'u32' | 'u64' | 'u128' | 'usize' | 'i8' | 'i16' | 'i32' | 'i64' | 'i128' | 'isize';
  'x-float'?: 'f32' | 'f64';
  /**
   * `Option<T>` 字段的序列化方式：
   * - `null`：缺值时输出 `null`（serde 默认）；
   * - `omit`：带 `skip_serializing_if = "Option::is_none"`，缺值时不出现该键。
   */
  'x-option'?: 'null' | 'omit';
  /** 抽取器无法确定的部分，附原因。出现即表示该契约未完成。 */
  'x-unresolved'?: string;
}

export interface RustLocation {
  /** 相对 `src-tauri/` 的路径。 */
  file: string;
  line: number;
  fn: string;
}

export interface CommandArg {
  /** 前端传参使用的键名（已按 Tauri 规则转换：默认 snake_case 参数名 → camelCase）。 */
  key: string;
  /** Rust 参数名。 */
  rustName?: string;
  schema: JsonSchema;
  /** Rust 中为 `Option<T>` 时，前端可以省略该键。 */
  optional: boolean;
}

/** Tauri 注入的非前端参数，迁移后由 kernel 的 CallContext 提供。 */
export type InjectedArg =
  | { kind: 'state'; rustType: string }
  | { kind: 'app-handle' }
  | { kind: 'window' }
  | { kind: 'webview' }
  | { kind: 'webview-window' }
  | { kind: 'channel'; schema: JsonSchema }
  | { kind: 'request' }
  | { kind: 'other'; rustType: string };

export interface CommandContract {
  /** Tauri 命令名（前端 invoke 使用的字符串）。 */
  name: string;
  lane: string;
  /** 历史迁移来源；Node 新命令不需要 Rust 声明。 */
  rust?: RustLocation;
  /** 当前实现的仓库相对路径（可选，仅用于文档）。 */
  source?: string;
  async: boolean;
  /** `#[tauri::command(rename_all = "...")]`；省略表示 Tauri 默认（camelCase）。 */
  renameAll?: 'snake_case' | 'camelCase';
  args: CommandArg[];
  injected: InjectedArg[];
  /** 成功值的 schema；Rust 返回 `()` 或 `Result<(), E>` 时为 `{ "type": "null" }`。 */
  result: JsonSchema;
  /** `Result<_, E>` 中 E 的序列化 schema；命令不返回 Result 时省略。 */
  error?: JsonSchema;
  /** 前端调用情况，来自 inventory：app = 生产代码调用；demo-only；none。 */
  frontend: 'app' | 'demo-only' | 'none';
}

export interface EventContract {
  /** 事件名；动态名用模板，例如 `chat_v2_stream_{sessionId}`。 */
  name: string;
  /** 名称是否含运行时拼接部分。 */
  dynamic: boolean;
  payload: JsonSchema;
  emitters: (RustLocation & { lane: string; method: 'emit' | 'emit_to' | 'emit_filter' | 'other' })[];
}

export interface LaneContract {
  lane: string;
  /** 生成该文件的抽取器版本，用于漂移检查。 */
  generator: string;
  commands: CommandContract[];
  events: EventContract[];
  $defs: Record<string, JsonSchema>;
}

/**
 * Tauri 框架层错误字符串。它们是前端可见行为，必须与 Tauri 2 源码逐字一致。
 * F1 依据 `~/.cargo/registry` 中所用 tauri 版本的源码填写函数体，并附源码位置注释。
 */
export interface TauriFrameworkErrors {
  /** 命令未注册时 invoke reject 的值。 */
  commandNotFound(cmd: string): unknown;
  /** 参数缺失或反序列化失败。 */
  invalidArgs(cmd: string, key: string, detail: string): unknown;
}
