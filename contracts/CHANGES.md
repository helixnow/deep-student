# IPC 契约变更单

## 2026-11-12 · Node-owned IPC

- `ipc/*.json` 从迁移产物提升为源文件；`contracts:generate` / `contracts:check` 只读 JSON Schema，生成 TS 类型和报告，不再读取或编译 Rust。
- 保留全部既有命令、字段、数值/枚举语义和历史类型导出，避免改变线上协议。新命令可省略 `rust` / `rustName`，以可选 `source` 标记 TS 实现。
- `chat_v2_background_subagent` 由 Node 契约直接声明，保留 Host / 前端功能；不再要求 Rust 版本同步实现。

## 2026-11-03 · F5 · 抽取器 1.1

- 已核实并修正：外部标签 enum 的 unit 变体在反序列化方向接受字符串和单键 `{Variant: null}`（包括 alias、混合 enum）；序列化仍只输出字符串。依据 serde_json 1.0.149 的 `VariantAccess::unit_variant`。通知 F1 及所有入参含 enum 的 lane：`__De` schema 现在使用 `oneOf`，F1 需将 map 归一到变体字符串再交处理函数；旧 `x-also-accepts` 注解保留。
- 已核实并修正：`crates/dstu-platform/src/secret_prompt.rs:23` 的 `SecretValue` 原样调用 `String::deserialize(deserializer).map(Self)`，输入 schema 为 string。抽取器按实现体与 String newtype 核对，变化后重新报告 unresolved。通知 F4：`secret_prompt_submit` 已完全解析；该命令当前仍首先返回 `DECRYPTOR_INTEGRATION_UNAVAILABLE`，契约解析不改变业务行为。
- 生成命令契约完全解析 1058/1058；不手改 JSON。

## 2026-11-03 · F5 · 抽取器 1.2

- 事件推断记录词法作用域、`json!` 构造位置与 if/match 分支尾表达式位置，支持 Option/Result/tuple/enum 解构、循环元素、带类型闭包参数、同类型分支、容器索引及函数返回签名约束；`serde_json::to_value(x)` 按 `Result<序列化形状, serde_json::Error>` 建模（`.unwrap()?` 后为 x 的 serde 形状）。新增：赋值/`push` 的到达定义、`None`/`Some` 与 Option/Result 分支合一、`Vec::new()` 元素类型、`Atomic*` 读写、`tokio::time::timeout`、mpsc、`Value::as_*`/`Map::remove`、数值 `max/min`。所有规则有内存 Rust 样例回归测试；未知形状仍生成 unresolved。
- 通知事件消费 lane：重新生成全部契约；事件完全解析由 70/120 提升到 120/127（94.5%，按 lane×事件计）。剩余未解析集中在无法静态建模的构造：`CompletionEmitter = Arc<dyn Fn>`（L04 `workspace_agent_completion`）、`EmbeddingProgressCallback = Box<dyn Fn>`（L12/L13/L19 `vfs-index-progress` 的 index_webpage 形状）、`NoteRevisionRepo::transaction<T>` 泛型闭包（L10 `notes:lease-ended`）、`Arc<dyn Transport>` 接收者（L19 `{}-message`）、Mutex 内 `BackupJobState::snapshot()`（L21 `backup-job-progress`）。另有 7 个 emit 因事件名是参数或接收者类型无法确认为 tauri `Emitter` 而未计入（`ipc/UNRESOLVED.md` 中逐条列出）。
- 通知 L02/L04/L05/L06：`chat_v2://model_profiles_changed` 的 `vendor_id`、`workspace_worker_ready` 的 `workspace_id/skill_id`、`chat_v2_automation_run_completed` 的 `sessionId`（一个发射形态为可空 string，另一个为 `Value`）、`chat_v2_session_{}` 的 `newActiveVariantId` 现在有确定 schema；`workspace_id` 既有 `String` 也有 `&str`，均归一为 string。
- 通知 L12/L13/L18/L19：`vfs-index-progress` 的 `chunkCount/fileId/currentPage/successCount` 等、`pdf_ocr_progress` 的 `page_index/width/height/sleep_time`、`mm_index_progress` 的 `payload`、`pdf-annotations:changed` 的 `updated_at` 已解析；`Value` 字段标为 `x-rust`，不猜测其内部形状。
- 通知 L10：`notes_editor_freeze_ack` 外层事件的 `result` 为 `LeaseStatus`，此前误取闭包内同名 Result（并错误引用不可序列化的 `VfsError`）。Rust 行为未变。
- 通知 F2：`menu.rs::handle_menu_event` 的七个菜单常量事件已逐分支加入契约（payload 为 null），不使用猜测的动态模板。

## 2026-11-03 · F5 · 抽取器 1.3

- 已核实并修正：`#[serde(flatten)]` 不再生成 `allOf` 引用独立的子 schema，而是把子结构体的字段（递归）、map 的值 schema 和 `serde_json::Value` 合并进同一层 object；`additionalProperties` 在合并后的层上统一决定。此前 `NoteStatePut`/`NoteStateDelete` 通过 `allOf` 引用带 `additionalProperties: false` 的 `NoteStateKey`，导致 Rust 接受的扁平请求被 Host 拒绝。
- 合并层语义（依据 serde_derive 1.0.228 `de/struct_.rs` 的 flatten 收集逻辑与 `FlatMapDeserializer`）：内层 `deny_unknown_fields` 在 flatten 时不生效，不封闭合并层；仅外层 `deny_unknown_fields` 在反序列化方向封闭；序列化方向始终封闭（flatten map 除外）。flatten map 的 `additionalProperties` 使用 map 值 schema；外层 `deny_unknown_fields` 与 flatten map 同时存在时以 map 接收剩余键。`Option<_>`、自定义 ser/de、tuple/newtype/transparent/tagged 结构体、循环引用、重复属性及多个 flatten map 仍标为 `x-unresolved`，且不因此拒绝输入。
- 受影响的命令（21 个）：L10 `notes_enable_columns`、`notes_get_format`、`notes_history_get`、`notes_state_delete`、`notes_state_put`；L13 `todo_list_items_with_stats`；L14 `import_question_bank`、`import_question_bank_stream`、`qbank_list_mistakes`、`qbank_search_questions`、`resume_question_import`；L15 `fsrs_get_due`；L17 `memory_write_batch`；L19 `browser_back`、`browser_forward`、`browser_get_state`、`browser_navigate`、`browser_open_session`、`browser_reload`、`browser_take_over`；L21 `data_governance_list_resumable_jobs`。
- 受影响的类型：`NoteStatePut`、`NoteStateDelete`、`NoteFormatStatus`、`NoteRevision`、`TodoItemWithChildStats`、`MistakeQuestion`、`QuestionImportDraftResponse`、`QuestionSearchFilters`、`FsrsDueCard`、`MemoryBatchWriteItemResult`、`BrowserStateResult`、`ResumableJobResponse`。`NoteFormat`、`BrowserSessionState` 已内联并从 `$defs` 移除；`PersistedJob` 因 `ResumableJobResponse` 内联后仅剩 F2 事件引用，从 `_shared.json` 移至 `F2-shell.json`（形状不变；1.4 为兼容既有导出已放回 `_shared`，见下）。F2 事件 `backup-jobs-resumable` 的 payload 引用随之改为 lane 内 `$ref`，语义不变。
- 重新生成全仓契约：命令仍为 1058/1058 完全解析，事件 120/127，类型定义 979 → 977（内联移除 2 个不再被引用的独立定义）。新增回归测试覆盖合并后的扁平对象、map flatten 的 `additionalProperties`、内层 `deny_unknown_fields` 不封闭合并层，以及外层 `deny_unknown_fields` 仍拒绝多余键。不手改 JSON。

## 2026-11-03 · F5 · 抽取器 1.4

- 已核实并修正：`contracts/ipc/generated/<lane>.ts` 中已经发布过的类型名不再因内联、改名或移动到 `_shared` 而消失。生成器新增 `lib/type-compat.ts` 维护历史导出名；每次生成时若该名字已不在本 lane 的 `$defs` 中，则按来源补同名导出：
  - 移到 `_shared`：`export type { X } from './_shared.ts'`；
  - 跨 lane 移动：按源 lane 的当前 `$defs` 复制形状；
  - 内联后无独立定义：用当前契约中的等价 TS 表达式保留旧名。
- 本次恢复的旧导出名：L10 `NoteFormat`（`Omit<NoteFormatStatus, 'required_capabilities' | 'updated_at'>`）、`VfsError`（无 serde Serialize 的 unresolved 占位）；L19 `BrowserSessionState`（`Omit<BrowserStateResult, 'history' | 'agentAutomationSupported'>`）；L21 `BackupJobKind`、`BackupJobPhase`、`BackupJobStatus`、`JobCheckpoint`、`PersistedJob`（从 `_shared` re-export）、`ImportProgress`（指向当前限定名 `dstu_storage__backup_common__ImportProgress`）；F2 继续从 `_shared` re-export `PersistedJob`。
- `PersistedJob` 因兼容要求强制保留在 `_shared.json`/`_shared.ts`；F2 事件 `backup-jobs-resumable` 的 payload 引用回到 `_shared.json#/$defs/PersistedJob`，`ResumableJobResponse` 的扁平合并形状不变。`PersistedJob` 仍不在任何 lane 的 `$defs` 中重复。
- 新增回归测试：读取已生成的 `contracts/ipc/generated/*.ts`，逐一断言上述历史导出名存在；生成器来源缺失时会直接报错，不会静默丢名。抽取器版本随输出语义变更升至 `deep-student/contracts-extract@1.4.0`。
- 按协调者要求，本轮不再运行 `migration:scaffold -- --refresh`、不修改其他 lane 的 LANE/SPEC/TESTMAP；`host/plugins/**` 的骨架刷新由协调者统一执行。

## 2026-11-03 · F5 · 质量自查（quality.md）

- 测试路径：删除读取 `generated/*.ts` 源文本做 `toContain` 的 grep 式断言，改为直接调用生产 `renderTs` 的兼容导出回归测试；chrono 测试补齐 `DateTime<Utc>/<FixedOffset>`、`NaiveDateTime`、`NaiveTime`、`TimeDelta` 的精确 schema 断言（含 i64/i32 边界），依据 chrono-0.4.41 的 serde 实现。
- 等价性核查：逐条核对 chrono 的 `AutoSi`/`use_z`、Naive 类型 Debug/Display、`TimeDelta` 元组、`serde` 的 `Duration`/`SystemTime`、`flatten` 与 `deny_unknown_fields`、`Option`/`Result` 表示；契约注解与 Rust 一致。F5 不包含运行时重试、重定向、子进程 kill 序列等手写逻辑。
- 数值：`intSchema` 对 >32 位整数只写 `x-int`，不写超过 2^53 的 JS `minimum`/`maximum`；契约生成不把 Rust 大整数转成 `Number`。
- 正则：生成器不执行用户/AI 提供的 regex；内部固定 regex 只处理 ASCII 提取文本或使用 Unicode property escape，未使用 `new RegExp` 处理外部模式。
- 架构：F5 不注册运行时命令/服务，没有 host/platform 工具重复实现；F4 的 `host/platform/{time,util,net-policy}` 与 F7 的 `nativeRegex` 尚未发布，F5 暂无本地副本需要替换。
- 门禁：第二次抽检后再次运行 `npm run migration:boundaries:strict`（已含 `console-log` 规则、`void e` catch 计为空 catch）；F5 文件 0 violation，剩余违规全部在其它 lane，需由对应 lane 清零。
- 第七节核查：F5 生成器没有 Rust `warn!`/`error!` 对应的运行时分支，也没有 `catch { void 0; }` 式规避；无法解析的事件/形状显式写入 `UNRESOLVED.md` 与 `x-unresolved`，未静默丢弃。
- 再次确认未对 `host/plugins/**` 运行 scaffold refresh，也未修改其他 lane 的 LANE/SPEC/TESTMAP。

## 2026-11-05 · F5 · 抽取器 1.5

- 已核实并修正：`crates/dstu-vfs/src/vfs/pdf_processing_service.rs:235` 的 `ProcessingProgress.percent: f32` 在序列化方向可输出 `null`。依据 serde_json-1.0.149 `src/ser.rs:155-179`：`serialize_f32` 对 NaN、±∞ 写 `null`（`dstu-vfs` 启用 `arbitrary_precision` 不改变非有限值分支）；`percent` 为必填字段，null 是成功响应中的值，不是缺键。
- 契约变化：`_shared.json#/$defs/ProcessingProgress.properties.percent` 由 `{ "type": "number", "x-float": "f32" }` 改为 `{ "anyOf": [{ "type": "number", "x-float": "f32" }, { "type": "null" }] }`；`generated/_shared.ts` 中 `ProcessingProgress.percent` 同步为 `number | null`。只影响序列化方向；同一字段的反序列化仍只接受 JSON number，Rust f32 不接受 null，输入契约不放宽。
- 未做全域放宽：没有把任意 `number` 或所有 f32/f64 字段改成可空，只在抽取器中登记经核实会出站且可能非有限的字段（`SERDE_JSON_NULL_FLOATS`），并附回归测试同时断言 ser 可空、de 不可空。
- 受影响 lane：L12 `media-processing-progress` / `pdf-processing-progress` 事件载荷与 L13 `vfs_get_pdf_processing_status` / `vfs_get_batch_pdf_processing_status` 结果（均经 `ProcessingProgress`）。L12 的 `{ progress: { percent: null } }` 成功响应断言无需削弱；L13 本地 DTO 若仍把该字段声明为 `number`，由 L13 owner 按新契约适配。
- 抽取器版本随输出语义变更升至 `deep-student/contracts-extract@1.5.0`。

## 2026-11-05 · F5 · G0 冻结增补：BackendEvent / InvokeResponse 的 raw JSON 文本

- 背景与批准：F4 本地 `Value` 闭包与 L12 实际进 main 需要协议层最后一跳携带不丢数字词法的文本。C2 本轮**明确批准**该 G0 增补；C1 确认应用侧语义为只消费文本、不重新推断品牌。F5 仅登记本冻结变更单，不改 F1 的 `protocol.ts` / API / 实际出口，也不改 F2 的 electron 实现。
- 契约形状（只新增可选成员，既有字段、判别式与消息集合不变）：
  - `BackendEvent.payloadJson?: string`；
  - `InvokeResponse` 成功支 `{ kind: 'result'; id: string; ok: true; value: unknown; json?: string }`，错误支 `{ kind: 'result'; id: string; ok: false; error: unknown; json?: string }`。
- 生成条件：仅当 Host 准备发送的原始值（`BackendEvent.payload` 或 `InvokeResponse.value` / `error`，含嵌套节点）中**实际存在** `JSON.isRawJSON(value) === true` 的原生 raw 品牌时，Host 对原始值执行**一次** `JSON.stringify`，把结果写入上述 `payloadJson` / `json`。品牌中的原始数字文本按原样输出为 JSON 数字 token（由 BigInt 生成的 raw 十进制即原生十进制数字，不加引号、不先转 `Number`）。不得用 `JSON.stringify(JSON.parse(...))` 二次处理，也不得把品牌对象当作普通对象序列化。
- 可逆性：同一文本 `JSON.parse(payloadJson)` / `JSON.parse(json)` 必须得到与 Host 原值兼容的 payload / value / error（对象、数组、字符串、布尔、null 深相等；raw 数字保持原 token 的数值语义）。同一 payload 中同时含 `raw1e400`（`JSON.rawJSON('1e400')` 品牌）与 `typedInfinity`（JS 非有限 number）时，必须分别序列化为数字 token `1e400` 和 `null`：前者来自品牌原文，后者是 `JSON.stringify` 对非有限 number 的原生行为，不做额外特判。
- 不特判与不加字段：
  - 只认 `JSON.isRawJSON` 原生品牌。形如 `{ rawJSON: '1e400' }` 的普通 lookalike 对象不是品牌，走普通对象原路径。
  - 值中既无 raw 品牌也无二进制（`Uint8Array` / `ArrayBuffer`）时，不生成 `json` / `payloadJson`，字段完全省略，消费方走原路径。
  - 二进制仍走既有 `x-binary` / `ResponseBody{ kind: 'raw', data }` 通道，不进入该文本字段。
- 消费方（F2）语义：F1 拥有 `host/kernel/protocol.ts`、API 声明与实际出口；F2 在 electron 侧消费。字段存在时 F2 **直接原文透传**：invoke 结果用作现有 `ResponseBody{ kind: 'json', data: json }`，事件用作现有 JS 事件发送的 `payloadJson` 文本；不得再对该值 parse + stringify（会丢失 raw 数字词法与品牌）。字段不存在（旧 Host、无品牌或二进制）时保持原路径逐字节不变。
- 边界与兼容：
  - `json` / `payloadJson` 是兼容可选字段，不是判别式：不改变 IPC 命令参数/返回值 schema（`contracts/ipc/**` 不变），不改内部钩子，不改 `ShellRequest` / `ShellResponse`。
  - 品牌不跨 `structuredClone`：main/Host 进程边界之后不能再依赖 `JSON.isRawJSON`，文本必须在 Host 侧生成并只以字符串字段携带。
  - 成功/错误两支各自携带自己的 `json`：错误支的 `json` 只描述 `error` 的序列化文本，不影响 `ok`、id 配对与前端 reject 行为；成功支同理只描述 `value`。
- 未改动：旧 `ProcessingProgress.percent` 可空合同（1.5）保持不变；已解决的 SDK / 生成物不因本单重跑；不修改 F1/F2/L12/L13 实现，不新增待决设计。

## 2026-11-06 · F5 · G0 冻结增补：WindowLifecycle 新状态 `page-load-started`（WP-074 登记）

- 来源：F1 WP-074。代码在 `1bbfad8f6`（协调者自动检查点，含 `host/kernel/protocol.ts`、`api.ts`、`connection.test.ts`），文档在 `bd45680d6`（`API.md`、`LANE.md`），经 `b73675cf2` 合入 main。F5 只读核对了 `bd45680d6` 的 `host/kernel/{protocol.ts,api.ts,API.md}` 与 `src-tauri/src/lib.rs:487-491`、`704-712`，本单只做登记，不改 F1/F2/L10 实现。
- 契约形状（只给现有联合增补一个字面量，消息种类、判别式 `kind: 'window'` 与 `WindowRef` 不变）：
  - `protocol.ts` `WindowLifecycle.state`：`'created' | 'focused' | 'blurred' | 'close-requested' | 'destroyed' | 'page-load-started'`；
  - `api.ts` Cordis 事件 `'host/window'(ref: WindowRef, state: WindowLifecycle['state'])`，直接引用 protocol 的同一类型（不再在 api.ts 另写字面量联合），并从 `api.ts` 导出 `WindowLifecycle`。
- 语义与消费方签名（唯一写法）：
  - `page-load-started` 对应 Rust `Builder::on_page_load` 中 `PageLoadEvent::Started`（`lib.rs:487-491`），表示 `ref.webview` 的主框架开始加载新文档（首次加载、刷新、跨文档导航）。同文档导航、子框架、focus、close-requested、invoke 都不算。Rust 在此调用 `cleanup_note_editor_leases(app, None, Some(webview.label()))`，消费方按 `ref.webview` 处理。
  - `destroyed` 对应 `on_window_event` 中 `WindowEvent::Destroyed`（`lib.rs:704-712`），Rust 调用 `cleanup_note_editor_leases(app, Some(window.label()), None)`，消费方按 `ref.window` 处理。
  - 发送方（F2，main → Host）：`{ kind: 'window', ref: WindowRef, state: 'page-load-started' }`。接收方（L10）：`ctx.on('host/window', (ref, state) => …)`，只认 `state === 'page-load-started'`。
  - 原有五态的含义与路由不变（`connection.ts`/`runtime.ts deliverWindow` 原样派发 `ref` 与 `state`，未修改）。
- 供方验证（引自 WP-074 报告，F5 未重跑）：`connection.test.ts` › `page-load-started lifecycle port (WP-074)` 经生产 `serveHost` 投递，覆盖 window≠webview＋origin 原样到达、focus/close-requested/invoke 不产生页面加载、卸载后不再通知；`host/kernel` + `host/profiles` 36 文件 251 passed / 0 failed（job `20261105163906-a434f6`，lane-gate tests job `20261105164328-495780`）。
- 尚未完成：F2 WP-090 的发送端未接线（main 上 `electron/shell/windows.ts:25` 的 `lifecycle` 类型仍只有五态）；L10 WP-091 的 lease cleanup 消费未接线。两者完成前 D005-01 不关闭，main 之后的消费者另包处理。
- 兼容边界：新状态只增不改，旧版 main 不发送该状态，旧 Host 不会收到。新 main 配旧 Host 时，旧 Host 会把未知状态原样派发给 `host/window` 监听者，按旧五态判断的监听者不会命中。上述混版本行为是按代码推断，**未经混版本实测**。
- 本单不是新增 IPC 命令或事件：`contracts/ipc/**` 不变，不重跑抽取器或 scaffold，不改 ledger 的 B/C 级判定。

## 2026-11-06 · F5 · G0 冻结增补：Shell 结构化错误公共面（WP-197 登记 WP-193）

- 正式来源：F1 WP-193 报告 `.oc-runs/board/wp/WP-193.report.md` 与固定候选 `7e025e2500e9ddd3ee8dc90db3cdf7246f1b3e49` 的 `host/kernel/protocol.ts:201-210`、`shell.ts:11-19,61-68`、`api.ts:13-14`、`API.md:229-245`。登记时 main 为 `6e2936bac`，**尚未包含该候选**（祖先检查未通过；main 的 ShellResponse 失败支仍只有 `error: string`，ShellError 尚无 `data`）。以下为正式候选签名，不表示 main 已可消费。
- Rust 依据：`src-tauri/crates/dstu-browser/src/browser/bridge.rs:77-105` 的 `BridgeError::Bridge { code: String, message: String, details: Option<Value> }` 与独立 Display `bridge error {code}: {message}`；`:114-148` 的 `BridgeErrorBody` / `BridgeEnvelope::into_result` 传递这些字段。Shell 层只承载显式错误数据，领域 envelope 的解析、缺失 error 时的 UNKNOWN 默认值及 takeover 分类仍归 browser owner。
- 公共签名（逐字段对应正式候选；只增补可选字段，既有判别式、id 与成功支保持）：

  ```ts
  // host/kernel/protocol.ts
  export interface ShellErrorData {
    code: string;
    message: string;
    details?: unknown;
  }
  export type ShellResponse =
    | { kind: 'shell-result'; id: string; ok: true; value: unknown }
    | { kind: 'shell-result'; id: string; ok: false; error: string; errorData?: ShellErrorData };

  // host/kernel/shell.ts（公共类签名）
  export class ShellError extends Error {
    override name = 'ShellError';
    readonly op: string;
    readonly data?: ShellErrorData;
    constructor(op: string, message: string, data?: ShellErrorData);
  }
  ```

- 公开出口：`host/kernel/api.ts` 从 `protocol.ts` 重导出 `type ShellErrorData`，从 `shell.ts` 重导出 `ShellError`。插件从 api.ts 消费的是**同一类型、同一运行时类**，可对真实 rejection 做 `instanceof ShellError`；不另建同名类或本地错误协议。
- 传输与兼容语义：
  - `ShellService._resolve` 失败支精确为 `new ShellError(pending.op, response.error, response.errorData)`。`ShellError.op` 保留原请求 op；继承的 `message` 始终是原 `error` 显示字符串，`data.message` 是独立的结构化消息，允许二者不同，不能彼此替换。
  - `data` 原样承接显式 `errorData`。`details` 缺省仍缺省、显式 `null` 仍为 null，嵌套可经 MessagePort 传输的值保留；kernel 不填 null、不删 null、不增加业务 `kind`。Rust `Option<Value>` 的领域解码规则仍由 browser 处理，本增补不把它改为必填字段。
  - 无 `errorData` 时 `data === undefined`，旧字符串错误保持原显示文本；即使文本形似 `bridge error PASSWORD_FIELD_BLOCKED: …` 也不得从字符串猜 code 或构造 typed 数据。
  - 原成功响应按 id resolve(value)、失败响应 reject 的 settle 不变；先移除 pending、清 timer 再 settle。未知/重复/迟到 id 不再次 settle；默认 30000ms 超时及断连拒绝未决请求、清理 timer 的原路径与文案不变，无显式数据时仍无 data。
- 跨 lane 消费顺序与状态（以登记时 main 与正式报告为界，实施 / main / 独验分别记）：

  | owner / 工作包 | 实施与消费边界 | main 状态 | 独验状态 |
  |---|---|---|---|
  | F1 / WP-193 供方 | 正式候选 `7e025e250` 已交；定义上述公共面，并经真实 MessagePort 接收 errorData。F1 不承担 takeover 策略 | **未 main**（`6e2936bac`） | 供方精确四项 gate 全绿，见下；不是业务整链独验签收 |
  | F2 / WP-194 发送方 | 待实施，等 WP-193 main、WP-134 后：在 browser 错误产生处保留真实 code/message/details，发送失败 ShellResponse 时保留原 error 并附 errorData | **未 main**；`electron/shell/browser-protocol.ts:152` 仍抛仅显示文本的 Error，`electron/shell/host.ts:194` 仍只发送字符串 error | 待真实 Electron 错误路径复验；尚无 WP-194 正式交付报告 |
  | L19 / WP-195 消费方 | 待实施，等 WP-193/194 main：`ShellBrowserSurface` 从公共 ShellError.data 恢复领域 typed BridgeError，再进入既有 `c741b5a3e` takeover 分类；保原分类，不重写已核正确的 bridgeMaybeTakeover | **未 main**；`host/plugins/browser/src/surface-host.ts:110-127` 仍直接返回 shell.request，无 typed 恢复 | 待真实 ShellService 失败回复 → surface → takeover 整链独验；普通对象夹具不构成证据 |

- 供方证据仅引用、不在 F5 重跑：WP-193 报告锁定 tip `7e025e250` / gate base `aa1ff5f838f40d6826319c926aeac6deddf5cd5f`，官方 lane-gate 原 exit 0；typecheck job `20261105201653-c3ce2b`、boundaries `20261105201653-9b43e1`、boundaries-strict(changed) `20261105201653-893bb1`、kernel tests `20261105201653-6c5315` 均原 exit 0，tests 为 40 文件 / 277 passed / 0 failed / 0 skipped。`host/kernel/tests/shell-error-wire.test.ts:72-181` 覆盖独立显示文本、公共 instanceof、details 嵌套/缺省/null、无 data 字符串、成功反序配对、重复/未知 id、超时迟到与实际端口关闭的 settle/timer 清理。
- 签收边界：沿用 C1 `.oc-runs/board/DECISIONS.md` **D-084** 与 R4 `.oc-runs/board/wp/WP-C2-VERIFY-014.report.md`：`bee7e50b5` 的一条映射可收，`c741b5a3e` 局部 takeover 逻辑可收，但生产 typed 错误链未通，**X6-LP-0089 仍未签收**。WP-118 是 MCP probe，不承担 browser 壳桥；F2/194、L19/195 实际接线及合 main 后的独验各自交付。本登记不签署业务闭环、G1 或 C 级。
- 本单只登记 G0 Shell 公共错误增补，不涉及命令 schema：`contracts/ipc/**` 与 TESTMAP 去向不变，不重跑 extractor/scaffold，不新增协议或同义测试。

## 2026-11-06 · F5 · G0 冻结增补：InvokeRequest 入站 JSON 原文与精确数值类型（WP-136 登记 WP-133）

- 来源：F1 WP-133（正式报告 `.oc-runs/board/wp/WP-133.report.md`）。登记依据的是 F1 分支 `ds-mig/F1-kernel` 的冻结候选 tip `23ee1e4d4`：`host/kernel/{protocol.ts:47-50, commands.ts:28-37, 205-212, connection.ts:202, api.ts:19-23, API.md:67-91, tests/inbound-json.test.ts}`。登记时 main（`136320e68`）**尚未包含**该提交，本单不声称 main 已提供这些接口；签名以该候选为准，合入 main 后只能增补。F5 只读核对，不改 F1/F2/X1/业务 lane 的实现。
- 协议形状（只新增可选成员，既有字段、判别式、消息集合不变）：
  - `protocol.ts` `InvokeRequest.argsJson?: string`；`commands.ts` `DispatchRequest.argsJson?: string`，签名与语义相同。`connection.ts` 仅在字段存在时透传，`runtime.ts` 沿现有 `DispatchRequest` 透传，不引入协议版本框架。
  - `api.ts` 公开类型：`IpcInteger = number | bigint`；`IpcJsonValue = null | boolean | string | number | JsonRawNumber | IpcJsonValue[] | { [key: string]: IpcJsonValue }`，其中 `JsonRawNumber` 为 F4 `host/platform/util/api.ts` 已在 main 上公开的类型。
- 语义来源（唯一写法）：
  - 只用于 JSON body。字段存在时，源文是**唯一**语义来源，`args` 仅是旧投影，不能作为解码 fallback，源文无效时也不用 `args` 回填。
  - 载荷是 `Uint8Array` / `ArrayBuffer` 时忽略 `argsJson`，保持既有 bytes 分支（具名参数仍报 bytes payload 错误，零具名参数命令仍收原始字节）。
  - Host 用 F4 `parseJsonDocument` 完整读取源文（重复键后者生效，与 serde_json `Value` 一致），再按 Rust 签名的具名参数顺序做 serde 规则与精确感知的 AJV 契约校验；校验完成后才做 typed 转换，AJV 不先把 bigint/raw 原子 Number 化或判错。
  - typed `x-int`（i8…i128、u8…u128、isize/usize，当前桌面 64 位）：安全整数交 `number`，其余合法整数交 `bigint`。递归覆盖 `$ref`、Option、Vec、map、struct 字段、tuple、enum 分支与生成的 flatten 合并层。
  - schema 未标整数类型的 `serde_json::Value`：安全整数字面量为 `number`，其余数字（`1.0`、大整数、超 f64 如 `1e400`）为 F4 原生 `JsonRawNumber`（`JSON.rawJSON` 品牌原子），不转成业务 string；`JSON.stringify` 输出原数字 token，出站沿用 2026-11-05 登记的 `json` / `payloadJson` 文本协议。
  - `call.payload`：有源文时为同源完整 Value（含契约未声明的未知键），不是舍入后的 `args`；无源文或 bytes 时不变。
- 错误形状（`InvokeResponse { kind: 'result', id, ok: false, error: string }`，不新增错误种类）：
  - 源文语法错误：`[dstu-host] invalid argsJson: <serde_json 语法详情，含 line/column>`，如 `EOF while parsing a value at line 1 column 10`、`trailing characters at line 1 column 18`；
  - 字段不是 string：`[dstu-host] invalid argsJson: expected a string`；
  - typed 整数越界、小数或指数喂整数（`9223372036854775808`、`1.0`、`1e0`、`1e400` 喂 i64）：``invalid args `<key>` for command `<cmd>`: invalid number``；
  - 优先级：既有 not-found（`<cmd> not allowed. Command not found`）与 ACL 拒绝先于源文解析；源文合法时参数错误按 Rust 签名次序由第一个失败参数决定。无效源文不进入处理器、不挂起。
- 消费方（F2）：从原 `payload.data` **直接**复制 JSON 文本到 `argsJson`，不得 `JSON.stringify(args)` 或 parse 后重写（会丢失原数字 token）。字段缺省（旧 main、bytes body）时 Host 走原对象入口。
- 兼容边界：缺 `argsJson` 的旧对象入口行为与错误文案保持原样，其中已被舍入的数字无法恢复。复杂形状的错误文案仍由 AJV fallback 提供，不签署全部 serde attribute（alias/default/自定义 Deserialize）逐字等价、f32 极端双舍入或 `multipleOf`/数值 `enum`/`const` 等未来 schema 扩展。
- 供方验证（引自 WP-133 报告，F5 未重跑）：`tests/inbound-json.test.ts` 经真实 MessagePort→`serveHost`→契约→生产 `insight_list` handler，断言服务收到 `9007199254740993n` / `9007199254740992n` 与 i64 两端；lane-gate tests job `20261105181542-f10b14`：37 files / 257 passed / 0 failed。
- 尚未完成（本单不关闭，**不能**据此称 1058 命令精度闭合）：
  - F2 WP-134：electron 侧真实转发 `argsJson`（登记时 main 的 `electron/` 中尚无该字段）；
  - X1 WP-135：真实 Shell/renderer + Host 整链复验；
  - L15 `host/plugins/review/src/insight-commands.ts:70` `ListArgs`，L17 `host/plugins/memory/src/insight-api.ts:160, 216-217` `InsightCommandService.listInsights`、`src/insight-service.ts:317-319`、`repository/insight-cards.ts:547-553` 仍声明 `number`：涉及 i64/u64 的消费签名需由 owner 改为 `IpcInteger`，业务运算/DB 不得 `Number(bigint)`，大 `limit` 的 `Math.min`/clamp 须保 Rust 语义。其余 lane 的 i64/u64 入参同理按需适配。
- 本单不是新增 IPC 命令或事件：`contracts/ipc/**` 不变，不重跑抽取器或 scaffold，不改 ledger 的 B/C 级判定。

## 2026-11-07 · W09 · 抽取器 1.6

- 新增 `x-rust-registered: false`：抽取器解析 `src-tauri/src/lib.rs` 唯一的 `tauri::generate_handler![...]`（按函数路径最后一段匹配，不按 `rename`），带 `#[tauri::command]` 但未列入注册表的命令照常生成契约并打此标记；找不到注册表时不打标记。当前命中 4 条：`get_auto_backup_status`（F4，前端 `src/api/dataGovernance.ts` 在调用）、`test_web_search_connectivity`（L19，前端 `src/utils/settingsApi.ts` 在调用）、`check_anki_connect_availability`（L16，前端未调用）、`test_rmcp_streamable_http`（L19，前端未调用）。标记只描述 Rust 原状：Tauri 版里调用这些命令会得到 "command not found"。Host 是否实现、注册由插件决定，与此标记互不覆盖（W05 实现并注册 `test_web_search_connectivity` 后契约无需再改）。
- 新增 `hostNative` 段：Host 内核自有、Rust 没有对应物的命令与事件，手写在 `scripts/electron-migration/contracts/host-native.json`，抽取器校验后写进 `F1-kernel.json` 的 `hostNative.commands` / `hostNative.events`（每条带 `x-host-native: true` 与 `host` 源码定位）：命令 `plugin:ui|manifest`、`plugin:host|call`、`plugin:host|status`，事件 `host://ui-manifest`、`host://plugins-degraded`。独立成段而不并入 `commands`/`events`：kernel 只对 `commands` 做参数校验与 `ctx.commands.register` 约束，内核命令走 `_registerKernel`；命令/事件统计（1058/127）与账本分母不变。
- 生成器版本升至 `deep-student/contracts-extract@1.6.0`（所有产物的 `generator` 字段随之变化）；不手改 JSON。

## 2026-11-07 · W09 · 插件 manifest v1（`contracts/plugin-manifest/v1.schema.json`）

- 新增：`package.json#deepStudent` 的权威 JSON Schema（draft 2020-12），依据 `decisions/2026-11-07-plugin-ecosystem-v1.md`。字段说明全部写在 schema 的 description 里；`scripts/plugins/plugin.schema.json`（`plugin.json`）随决策 3 废弃。
- 通知 W01（Host 运行时校验）、W17（UI 加载器、`validate-package.mjs` 改校验 package.json）：直接加载本文件校验，不另写 schema，并各自加一致性测试。版本范围是 npm semver 的严格子集（`$defs/range`），按正则即可判定合法；求值语义与 npm 相同（参考实现与对照测试见 `scripts/electron-migration/gate-checks/plugin-manifest.mjs` 的 `parseRange` / `satisfies`）。
- 门禁 `plugin-manifest` 已接入 gate-runner：现状 0 个官方插件有 package.json、示例 2 个目录共 6 条问题记入基线，只拦新增。

## 2026-11-07 · W09 · 插件 manifest v1：预发布版本与隐式授予的说明

- 只改 description，schema 结构与正则不变，已有清单的合法性不变。
- `$defs/range`：被检查的版本带预发布标签时按 npm semver 7 的 `includePrerelease` 求值（主代理决定 1，W01 `b2ab7891` 已在 Host 实现）。门禁 `gate-checks/plugin-manifest.mjs` 的 `satisfies` 增加同名选项（默认关闭，与 npm 默认及 W01 的一致性测试相同），engines 对应用版本的检查开启它；对照表与 W01 契约测试同一份（semver 7.8.6）。
- `permissions`：原文说“log、本插件的存储”隐式授予，与实现不符。Host 只隐式授予 `log`（`host/kernel/manifest.ts` 的 `IMPLICIT_SERVICE_GRANTS`），存储要声明 `service:storage`（`host/kernel/API.md` §16.4）。改为按实现描述。
