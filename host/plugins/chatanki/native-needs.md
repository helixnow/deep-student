# L24 原生能力与跨 lane 依赖

本文件记录 `chatanki` 迁移无法在本 lane 内独立完成、需要 F7 / L05 / L15 / L16
提供的能力。未发布的接口只作为**请求**记录，不把可选声明或测试替身当作提供。

## 1. F7 `nativeRegex.replaceAllProjected`（C4 capture 膨胀闸门）

### 提供方及 async 消费已获限定复核；整 C4 未签

- F7 `4b2c21d37` 已在正常 main `5b1b19055`：Rust `chatanki_transform.rs:466–594` 的投影算法
  进入 regex 1.12.3 WASI 引擎，u64 累计；成功返回 value/bytes，首越界失败只含 bytes。
  limitBytes 非安全非负整数抛 TypeError；消费方传 `max(1 MiB, 原文 UTF-8 字节数)`。
- owner 证据：构建 `20261104193343-0fb691`，
  `host/platform/native/tests/regex-projected.test.ts`，回归 `20261104200158-b8309d`。
  这些是提供方证据，不计本 lane 独立通过。
- 已核公开 regex API、绑定和 WASI artifact 正常可用；消费公开服务，不复制/私引算法。
- `boundedRegexReplaceAsync` 现在对常量和捕获替换统一调用原语；已删除边扫描边拼接的
  JS 常量分支及后置 `replaceAll` fallback。首越界 bytes 原样进入本 lane 错误。
- `tests/regex-projected-real-host.test.ts` 独立覆盖原八向量、safe-integer 参数域、
  真实 `chatankiTools.execute(transform)` 的边界、首超限、旧超长字段和权限。
  正常异步路径的证据不替代同步兼容分支/脚本沙箱/全部 C4 的独立复核签收。
- C1 已亲核 R5 `c4d5744cd` 固定 main `650ddffbe` 的独立新差异复验：
  `20261104230316-7884d4` 两文件 23 passed / 21 标题过滤，原 exit 0，及同 tip 官方
  gate `20261104230548-697ebd` 49 files / 407 passed / 0 skip / 原 exit 0。
  仅接受 async 常量原生预检、capture 后置 fallback 删除及实际工具原场景；
  常量 apply 未动态覆盖，legacy 同步 provider、C4 脚本/平台仍未签。
- 纠正下方验收向量第三行：`a$[b]c` 的 UTF-8 字节数为 6，不是 7；
  与 Rust `debug_assert_eq!(after.len(), projected)`（`:593`）一致。其余七行不改。

### Rust 语义

`src-tauri/src/chat_v2/tools/chatanki_transform.rs:470–594` 的
`bounded_regex_replace` 在**分配结果之前**做精确字节预检：

- `allocation_limit = max(CHATANKI_TRANSFORM_FIELD_GROWTH_MAX_BYTES, before.len())`
  （`before.len()` 是 UTF-8 字节数，因此存量超长字段收缩/原样保留仍可通过）。
- 遍历 `regex.captures_iter(before)`（完整原文字段，非后缀切片），每次累加
  1. `matched.start() - previous_end` 的字面前缀字节；
  2. `expanded_replacement_len(&captures, replacement)` 的捕获展开字节；
  3. 末尾 `before.len() - previous_end`。
- 任一累加使 `projected > allocation_limit`，立即返回
  `TransformFieldGrowthError { bytes: projected }`；这里的 `bytes` 是**首个越界
  的累计值**，不是最终结果总字节数。
- 只有预检通过后才调用 `regex.replace_all(before, replacement)`；捕获展开语义
  = Rust regex crate 的 `$name` / `$1` / `${name}` / `${1}` / `$$`，未匹配组或
  不存在的名字贡献 0 字节，malformed `${` 按字面 `$` 继续扫描。

### TS 本轮消费（待复核）

`src/transform.ts::boundedRegexReplaceAsync`：

- 常量和捕获替换不再分支，在完整原文上调用必需的 `replaceAllProjected`。
- limit 仍为 `max(1 MiB, utf8Bytes(before))`；`ok:false` 在消费 value 前抛
  `TransformFieldGrowthError`，保留 opIndex/field/首越界 bytes；成功直接用原生 value。
- 历史缺口（旧 fallback 先物化再检查）已从异步生产路径删除，不用最终字节长度证明
  预分配安全，也不把「有方法声明」作为 provider/工具链验证。
- 真实工具回归区分 2 MiB 最终结果与 `1 MiB + 1024` 首越界值；dry-run 和 apply
  都拒绝该卡且 DB 不变，权限预检不放宽；完整原文非边界、`$$` 及超长字段保留/收缩另验。
- 真实工具常量替换另验 `1 MiB + 4096` 首越界（最终原会为 8 MiB），不只是 provider
  小 limit 的常量向量；常量/捕获共用同一原生预检路径，未保留 JS 拼接快路径。

### 已发布原语的精确合同（历史请求沿用）

Rust 参考实现：`chatanki_transform.rs:470–594`（`expanded_replacement_len` /
`add_projected_bytes` / `bounded_regex_replace`）。F7 已提供下述合同；
**仍须用实际 provider/consumer 验证，不以 API 存在本身签收**。

输入：

- `pattern`：已由 `compile()` 得到的 `regex::Regex` handle。
- `text`：**完整原文字段**（不是 `match.start` 之后的切片）。
- `replacement`：替换模板，语法与现有 `replaceAll` 完全一致。
- `limitBytes`：调用方计算 `max(1048576, utf8Bytes(text))` 后传入；引擎不得改写。
  必须校验为安全非负整数（调用方已保证），负数/非整数按参数错误拒绝。
- **计数宽度**：Rust desktop 侧是 `usize`（64 位），WASI32 绑定不得把
  `usize`/`bytes` 投影机械截成 32 位；`projected`、`limit`、capture 引用长度
  与 `bytes` 必须用 u64 累计，避免 Unicode
  大字段/多次展开在 2^32 附近回绕。WASI 内部指针仍可用 32 位，但字节计数
  与 `$` 引用解析使用同一 u64 语义。JS 接口 limitBytes 的域仍限安全非负整数；
  本 lane 的 safe-integer 边界用例不宣称完整 u64 JS 接口域已验收。

输出：

- `{ ok: true, value, bytes }`：`value === replaceAll(pattern, text, replacement)`
  （逐字节一致），`bytes === utf8Bytes(value)`。
- `{ ok: false, bytes }`：**不得返回 `value`**，`bytes` 是首次使累计投影
  `> limitBytes` 的那次 saturating add 之后的累计值（首个越界值，不是最终
  `replaceAll` 结果的总字节数）。

算法（与 Rust 逐行对应）：

1. `projected = 0; previousEnd = 0`。
2. 对 `captures_iter(text)` 的每个 match（leftmost-first、非重叠、空匹配按
   `regex` crate 的推进规则）：
   - `add(match.start_bytes - previousEnd)`
   - `add(expanded_replacement_len(captures, replacement))`
   - 若任一 `add` 后 `projected > limitBytes`，立即返回 `{ ok: false, bytes: projected }`，
     不继续扫描、不构造输出。
   - `previousEnd = match.end_bytes`
3. `add(utf8Bytes(text) - previousEnd)`；超限同样立即返回。
4. 全部预检通过后才调用 `replace_all` 分配最终结果；返回
   `{ ok: true, value, bytes: projected }`。允许一次扫描同时构造输出，但失败时
   必须丢弃未完成缓冲并返回上述失败结构。

`expanded_replacement_len` 必须按 **UTF-8 字节**、逐字节解析模板：

- `$$` → 贡献 1 字节（字面 `$`），游标 +2。
- `${name}` / `${1}`：取第一个 `}`；组存在则贡献该组 UTF-8 字节数，未匹配/
  不存在的组贡献 0；没有 `}` 时按字面 `$` 贡献 1，然后从 `$` 后继续扫描。
- `$name` / `$1`：从 `$` 后贪婪消费 ASCII 字母数字与 `_` 作为引用名；按数字
  引用或命名组查找，存在贡献组字节数，否则贡献 0。注意 `$1x` 的引用名是
  `1x`，不是 `$1` + `x`。
- `$` 后是其他字符（含非 ASCII、行尾）：贡献 1 字节（字面 `$`），游标 +1。
- 普通文本原样计字节；所有加法用 saturating 语义（Rust `saturating_add`）。

验收向量（F7 单元测试应逐条覆盖）：

| text | pattern | replacement | limitBytes | 期望 |
|---|---|---|---|---|
| `afoo` | `\B(foo)` | `<$1>` | `1048576` | `{ok:true,value:"a<foo>",bytes:6}` |
| `aaaa` | `a` | `XXXX` | `5` | `{ok:false,bytes:8}`（首个越界值；最终总量是 16） |
| `abc` | `(b)` | `$$[$1]` | `1048576` | `{ok:true,value:"a$[b]c",bytes:6}` |
| `abc` | `(b)` | `${missing}` | `1048576` | `{ok:true,value:"ac",bytes:2}` |
| `abc` | `(b)` | `$1x$1` | `1048576` | `{ok:true,value:"abc",bytes:3}`（`$1x` 引用名不存在，第二个 `$1` 展开为 b） |
| `abc` | `(b)` | `${1x` | `1048576` | `{ok:true,value:"a${1xc",bytes:6}`（无 `}`，`$` 字面） |
| `abc` | `(b)` | `<$1>` | `4` | `{ok:false,bytes:5}`（前缀 1 + 展开 3 后未超；末尾补 1 后总 5） |
| `xbZ` | `(?P<suffix>\Bb)` | `${suffix}${suffix}${suffix}` | `3` | `{ok:false,bytes:4}`（首个越界累计值，不是最终 `xbbbZ` 的 5） |

调用方（L24）只接受上述两种结果：`ok:false` 抛
`TransformFieldGrowthError(opIndex, field, bytes)`（Rust 的 `bytes` 原样），
`ok:true` 直接使用 `value`；失败时绝不能物化完整结果。L24 已删除异步 fallback，
新增真实引擎和工具测试（>1 MiB capture 膨胀、首越界值、失败不返回 value）。

L24 adapter 侧（`host/plugins/chatanki/api.ts`）：

```ts
replaceAllProjected(
  pattern: ChatAnkiAsyncRegexPattern,
  text: string,
  replacement: string,
  limitBytes: number,
): Promise<
  | { ok: true; value: string; bytes: number }
  | { ok: false; bytes: number }
>
```

F7 `NativeRegex` 侧建议同名：

```ts
replaceAllProjected(
  pattern: NativeRegexPattern,
  text: string,
  replacement: string,
  limitBytes: number,
): Promise<
  | { ok: true; value: string; bytes: number }
  | { ok: false; bytes: number }
>
```

输入/输出契约：

- `pattern`：已按 Rust `regex` crate 编译的 pattern handle；`text` 必须是完整
  原文字段（不得由调用方截取 `match.start` 后缀）；`replacement` 为替换模板。
- `limitBytes`：非负整数，调用方传
  `max(1048576, utf8Bytes(text))`；引擎不得自行放宽/缩小。
- 失败：在累计投影首次 `> limitBytes` 时立即返回 `{ ok: false, bytes }`；
  `bytes` 等于该次 saturating add 后的累计值（首个越界值），不得物化 `value`，
  也不得继续扫描剩余匹配。
- 成功：`{ ok: true, value, bytes }`；`bytes` 必须等于 `utf8Bytes(value)`，且
  `value` 与现有 `replaceAll` 的输出完全一致（同一匹配顺序、同一捕获展开）。
- 匹配：完整原文上的 leftmost-first、非重叠 `captures_iter`；前后缀字节计数按
  UTF-8；不要用 JS UTF-16 下标或 `String.length`。
- 捕获展开：逐字节解析模板，语义与现有 `replaceAll` 相同（`$name` / `$1` /
  `${name}` / `${1}` / `$$`；缺失组 0；malformed `${` 按字面 `$` 继续）。
- 实现可以先做纯投影，再在成功时调用 `replace_all`；关键是失败路径不得分配
  完整结果，且失败 `bytes` 为首个越界累计值。若一次扫描同时构造结果，也必须在
  失败时丢弃未完成缓冲区并返回上述结构。

### 复核位置

- 调用方契约测试（测试替身，只锁 L24 参数/结果处理，不代表 F7 已提供）：
  `host/plugins/chatanki/tests/transform.test.ts::security_capture_expansion_forwards_the_rust_limit_to_f7_projection`
  与 `security_projected_replace_raises_the_limit_to_an_oversized_input`。
- F7 实现后应新增真实引擎测试：捕获展开结果超过 1 MiB，断言
  `{ ok: false, bytes: 首个越界值 }`，并证明没有先构造完整结果；在此之前
  TESTMAP 中 capture 展开相关行为保持缺口说明。

## 2. L05 异步 transform sandbox（L05 adapter 已合 main；F7 nativeSandbox 未合）

- L05 adapter 已随 main 合入：`host/plugins/agent-workspace/src/tools/transform-sandbox.ts`
  blob `1011746922259ba3723f0d38d3cd4a84c962949f`，与候选
  `ds-mig/L05-agent-workspace` HEAD
  `ff52577c4aeac9c9fe737c32cbabfb3f1ad65c3c` 一致；生产
  `ctx.get('agentTransformSandbox')` 已可用。另含
  `shell-sandbox.ts`（blob `396cce245e5fe7afdd1e299a9f6753e398763ca7`）。
- F7 原生 sandbox 候选：`ds-mig/F7-native` HEAD
  `83e078af283f31860e72634d7dfc8cc9ab78fcd9`，
  `host/platform/native/sandbox/api.ts`
  （blob `eaaa82acf66a3ea9d368d3421a2be09ea606ee37`）与
  `index.ts`（blob `0fc335fc20519f5b3260e75cc2a94c6985cbffdd`）。
- 契约：`capability(): Promise<...>` 与
  `spawn(request & { signal?: AbortSignal }): Promise<TransformSandboxProcess>`；
  `spawn` 在 native 真正启动后才 resolve，失败时 L05 自行清理 command resources，
  L24 按原 `sandbox_unavailable` / `setup` 边界映射。Windows native bridge 在
  F7 分支提供但未 Windows 实测，不能据此签七个业务脚本 e2e。
- 持久化复核：`host/plugins/chatanki/tests/candidates/l05-linux-sandbox.test.ts`
  （main 无候选文件时自动 skip；候选 worktree 中运行 7 个 Rust e2e 场景）。
- 证据：临时 worktree 以 L24 `231c0a561` + 上述候选文件在 Linux 真实
  `runTransformScript` 上 8 tests 通过，作业 `20261104082217-1e212c` 退出码 0
  （早先同场景 `20261104075253-b63b15` 亦为 0）。main 合入前 TESTMAP 的 7 行
  保持 pending。

## 3. L16 APKG 导出服务（C3 `chatanki_export format=apkg`）

Rust `chatanki_executor.rs:5918–6075` 的 `format == "apkg"` 分支不自己写 APKG，
而是调用 `crate::apkg_exporter_service::export_multi_template_apkg_report(
cards, deck_name, output_path, template_cache) -> Result<ApkgExportReport, String>`。
L24 已有卡片读取、Cloze 判定、文件名 sanitize（`anki/api.ts` 已导出
`sanitizeFilenameWithExtension`）与模板查找（`getCustomTemplateById`），
只缺导出器本身；main 的 `anki` API 未发布该方法，所以生产当前按显式失败
返回（`APKG export requires the L16 apkg exporter service`），不写假文件。

请求 L16 在 `host/plugins/anki/api.ts` 发布（不得由 L24 引用 `src/`）：

```ts
exportMultiTemplateApkgReport(
  cards: readonly AnkiCard[],
  deckName: string,
  outputPath: string,
  templateMap: ReadonlyMap<string, CustomAnkiTemplate>,
): ApkgExportReport;
```

- `templateMap` 用 `ReadonlyMap`，与 L16 现有 `apkg-exporter.ts` 的
  `ReadonlyMap<string, CustomAnkiTemplate>` 一致；服务内部构造
  `ApkgExportRuntime`（openDatabase/createTempDir 等），L24 不引用 L16 `src/`。
- `outputPath`：已由调用方按 Rust 规则拼好（Downloads 或 temp + sanitize +
  `.apkg`）；导出器负责创建父目录、临时 `collection.anki2`、媒体打包与清理。
- `cards`：调用方已排除 `is_error_card`；导出器按 Rust
  `normalize_cards_for_export` 做遮挡转换与 `_` 协议字段剥离。
- `templateMap`：`template_id -> CustomAnkiTemplate`；缺失模板的卡使用 fallback
  fields，缺失模板告警由调用方按 Rust `log::warn!` 记录。
- `ApkgExportReport` 使用 contracts 中的 `exportedMedia`/`missingMedia`/
  `warnings`；L24 输出再映射为 `exportedMedia`/`missingMedia`/`mediaWarnings`。
- 失败原样抛 `String`/`Error` 文本，L24 不吞错；成功返回后 L24 才写工具输出。
- provider 合入 main 后，L24 补 `downloads`/temp 路径与 Cloze 自动 noteType
  逻辑，并把 `chatanki_export` APKG 分支的真实测试标 ported。

## 4. L15 / L16

以下 CAS 段为早期历史快照；当前正常 main 已具备 L15 scoped API 与 L16 仓储面，
限定复核以 ACCEPTANCE/C1 最新记录为准，不能再据这些旧记录声称 provider 不存在。
本轮 preference i64 当前接缝见本节末，不与 reviewVersion 混为一件。

- main 的 `host/plugins/review/src/review.ts`（blob
  `537458ad20d564e88303146b538fb11599b3d6b3`）中 `FsrsReviewService` 已实现
  `setSuspendedForSession` / `undoLastReviewForSession` 的真实 CAS，但
  `review` 插件发布的 `ReviewService` API 仍未暴露这两个方法；生产
  `chatanki/index.ts::hydrate` 因而还不能通过 `ctx.get('review')` 接入。
  需要 L15 在 `host/plugins/review/api.ts` 的 `ReviewService` 与
  `host/plugins/review/index.ts` 的委托中发布
  `setSuspendedForSession(cardId, sessionId, expectedReviewVersion, suspended)`
  与 `undoLastReviewForSession(cardId, sessionId, expectedReviewVersion, expectedLogId)`；
  `expectedReviewVersion` 必须保持 i64 语义，不在服务层加 safe-integer 门槛。
- 持久化复核：`host/plugins/chatanki/tests/review-executor-real-l15.test.ts`
  直接注入 main 的 `FsrsReviewService`，验证 `2^63-1024` 的 set_suspended /
  undo pass-through、SQL 精确 CAS conflict 与越界拒绝；作业
  `20261104083031-e0008a` 退出码 0（4 tests）。它不证明 `review` 服务 API
  已发布。
- 参考候选：`ds-mig/L15-review-analytics` HEAD
  `d38ae919089badc0800455a9109599fbab617d1c`（review blob
  `fe5b49cf6e0d938dfe8b313b3d10a4061b574c25`，额外含 L16 同事务接口）。
- L16 `ds-mig/L16-anki` HEAD
  `68a71d24854fd7f4290fa0d6c3add1f484db8399`；提供真实
  `cards`/`documents` 等仓储面，但尚未合 main。关键文件 blob 与
  `22fa0400b` 相同（见 `tests/candidates/README.md`）。
- L16 `deleteCardForSession` 候选复核：
  `tests/candidates/l16-anki-delete-cas.test.ts` 用本 lane 生产
  `chatanki_delete_card`（经 `chatankiTools.execute` hydration）进入 L16 真实
  `anki.cards` 与 L15 事务 owner，覆盖大整数正常物理删除、内容 CAS 冲突、
  复习 CAS 冲突；作业 `20261104085554-c90c0c` / `20261104085715-c0761e`
  均退出码 0（4 tests）。provider 固定点为 `ds-mig/L16-anki` HEAD
  `68a71d24854fd7f4290fa0d6c3add1f484db8399`，文件 blob 见
  `tests/candidates/README.md`。main 的 `anki` 服务仍未发布 `cards`，所以
  main 上该测试自动 skip；TESTMAP 的 L16 行继续保持 pending，不计 ported。

### 当前 preference i64 接缝

当前后继：正常main `536aad095` 已同时具备以下L16类型/实现及L24消费，
旧等待发布条件解除，C1已另交R5仅做精确i64独立链；完整typed/f32域仍未签。
下方候选SHA保留为实现沿革，不再据其“候选”字样判断当前未main。

- L16 候选：`931643d80`（测试 `2d558e65b`、报告 `96a5bd8df`），公开
  PreferenceTimestamp=number|bigint，两时间字段、两个consolidate nowMs同类型；
  旧number保留，bigint不Number化、时间排序用关系比较。等待正常main及联合复验，不私引。
- L24 已准备对应类型、JsonReader.readSigned精确解析与原生JSON.rawJSON数字写回；
  真实持久化Node新14（所属四文件31）和Electron新14均原exit0，完整域/排序不据此签收。
- F4 f32ToJsonNumber 为出站数值projection（已知候选159eb035f/0fb54cdde）；
  它不代入站数值token解码，也不能据此签整段JSON字节一致。当前不复制formatter。

## 5. L16 生成管线 facade（`chatanki_run/start/wait/control/sync`）

Rust `start_background_pipeline`（`chatanki_executor.rs:6901–9400`）直接调用
L16 内部类/函数；main 只存在这些 TS 实现（`src/streaming-anki.ts`、
`src/document-processing.ts`、`src/enhanced-service.ts`），没有 Host 服务门面。
本 lane 不能从 `host/plugins/chatanki` 直接 import L16 `src/`，因此需要 L16
发布稳定服务（例如 `ankiPipeline`），至少包含：

```ts
startDocumentProcessingWithId(
  request: StartDocumentProcessingRequest,
  preAllocatedDocumentId: string,
  emit: (event: string, payload: unknown) => void,
): Promise<string>;

resumeDocumentProcessing(
  documentId: string,
  emit: (event: string, payload: unknown) => void,
): Promise<void>;

cancelDocumentProcessing(
  documentId: string,
  emit: (event: string, payload: unknown) => void,
): Promise<void>;

buildRetryTaskForDocument(documentId: string): Promise<DocumentTask | null>;

getTask(taskId: string): DocumentTask;
getDocumentTasks(documentId: string): DocumentTask[];
updateTaskStatus(taskId: string, status: TaskStatus, errorMessage: string | null): void;
getCardsForDocument(documentId: string): AnkiCard[];
```

- `StartDocumentProcessingRequest` 使用 L16 `enhanced-service.ts` 的
  `{ document_content, original_document_name?, options? }` 形状；L24 负责
  `chatanki_run` 的参数解析与 `preAllocatedDocumentId` 生成。
- `emit` 必须把 L16 的 `anki://generation`（`DocumentProcessingStarted` /
  `DocumentProcessingPaused` / `DocumentProcessingCompleted` 等）转给 L24 的
  工具事件通道；在 L16 发布前 L24 不注册 run/start，也不伪造成功。
- W22 round 3：L16 已发布 `anki.pipeline`（pause/resume/cancel/buildRetryTaskForDocument/
  getTask/updateTaskStatus，`host/plugins/anki/api.ts` AnkiDocumentPipeline）与同步门面
  （checkAnkiConnectAvailability/createDeckIfNotExists/templateModelName/readSyncOptions/
  addNotesToAnkiDetailed/writeAnkiExportReceipts）。`chatanki_control`/`chatanki_sync`
  已由 `src/control-executor.ts`/`src/sync-executor.ts` 经这两个门面注册，每次 `canHandle`
  探测门面是否发布（`tests/control-real-host.test.ts`、`tests/sync-real-host.test.ts`）。
  仍缺的只有 `startDocumentProcessingWithId`（run/start）。
- W22 后继：`chatanki_wait`（`chatanki_executor.rs:5039–5547`）只读
  `anki.documents`/`anki.cards`/`anki.chatBlocks` 三个已发布仓储，不依赖本门面，
  已由 `src/wait-executor.ts` 注册（`tests/wait-real-host.test.ts`）。
- `chatanki_control`（`:6483–6759`）四个动作都要 `pause/resume/cancelDocumentProcessing`
  （L16 `src/enhanced-service.ts:275/335/399`）；`retry` 另需 `getTask`/`updateTaskStatus`
  与 `buildRetryTaskForDocument`（`:753`）。
- `chatanki_sync`（`:6141–6482`）另需 L16 发布 `addNotesToAnkiDetailed`
  （`src/anki-sync.ts:706`）、`templateModelName`（`src/anki-sync.ts:147`）、
  按 `anki_connect_batch_size/retry_times/media_mode` 设置构造同步选项
  （`src/anki-connect.ts:329–338`，对应 Rust `AnkiConnectSyncOptions::from_setting_strings`）
  与 `writeAnkiExportReceipts`（`repository/anki-review-state.ts:199`）；
  现仅 `plugin-handlers-cards.ts:255–285` 的 IPC 命令内部使用。
- `chatanki_update_library_card` / `chatanki_delete_library_card`（`:3656–3810` /
  `:4059–4205`）还要 `anki` 服务发布 `getAnkiAgentLibraryCard(cardId)`（Rust
  `get_anki_agent_library_card`，`database/mod.rs:5330–5341`，同一行返回卡与 locator）。
  `src/library-mutation-executor.ts` 每次 `canHandle` 都探测该方法：未发布时两工具不被认领，
  按 RF-W02-executable-only-tool-face 不发给模型（生产工具面 5 个）；发布后自动认领，
  工具面与 Rust 的 7 个一致，届时 `chat-pipeline/tests/chatanki-tool-face.test.ts` 的期望改为 7 个。
- 现有 `checkAnkiConnectAvailability` / `consolidatePreferenceObservation`
  已由 main `anki` 服务发布，不属于本缺口。
- 受影响 TESTMAP：`test_append_vlmfull_occlusion_*` 5 行、
  `test_ensure_failed_document_session_inserts_placeholder_once` 1 行；
  provider 合入前保持 pending。

## 6. C3 / chatanki_list_library_cards 的精确 agent 分页接缝

**当前状态（2026-11-05后继）**：正常main `536aad095` 已含L16正式agent-page与实际服务委托，
下方旧UI诊断是请求沿革，不再作为当前阻塞。L24已按C1授权接
`ChatAnkiLibraryListExecutor`，只消费`listAnkiAgentLibraryPage`＋L15库状态；显式传
归一化page/pageSize（默认20），flat记录直接投影同页locator，total/dueMs不Number化。
真实工具回归十例及独立复核状态见LANE；不把供方通过签成完整消费者或全Preference域。

### 历史请求与诊断（以下为正式agent-page发布前的状态）

本节不是「没有 L16 服务」：main `AnkiService.listAnkiAgentLibraryCards`
（`anki/api.ts:296`）已存在，但 `src/service.ts:99–113` 实际委托 UI 用的
`listAnkiLibraryCardsFiltered`，不能直接作为 Rust agent 查询的等价出口。
L24 尚未注册新 handler，也未复制 SQL、分页后过滤、逐卡重查 locator 或给出替身列表。

提供方后继：L16 已交候选 `ca01db015`（API/测试初版 `6fc4b3e0a`），
新增 `ctx.anki.listAnkiAgentLibraryPage(request, nowMs?: number|bigint)`，不改旧UI方法。
request 明确 schedule/diagnostic/page/pageSize；response 为同页 records+locator、
page/pageSize、total:bigint，libraryCard.dueMs:bigint|null、sourceRef恒null。
此为候选而非正常main验收，等主线后再绑定工具；调用须显式传本lane已归一化的
page/pageSize（默认20），不能沿owner可选参数默认12。正式联合回归未被供方测试替代。

### 已有能力与不可忽略的差异

Rust 调用链：`chatanki_executor.rs:3562–3653` →
`dstu-storage/src/database/mod.rs:7604–7725::list_anki_agent_library_cards`。

| 项 | 原 Rust agent 语义 | 现正式 UI 列表实现 | 消费决定 |
|---|---|---|---|
| agent read scope / 存活 / 默认顺序 | 显式库读跨 session；ac/dt 未删；created_at DESC,id DESC | 相同基本过滤/顺序，没有 caller session 限制 | 可复用语义，不放宽 session 写权限 |
| page / pageSize | u32，page≥1、size1..20 | service 默认12、上限200，但接受显式 caller page/size | L24 已有 parser 归一化后可保持原cap20；不当作独立 blocker |
| Due | fs存活、未暂停、due_ms≤now，包含 state=0 新卡（`:7644–7649`） | `anki-library.ts:309` 额外 `fs.state != 0` | 不能映射现 due 来冒充等价 |
| Enqueued | 任何存活 fs.id（`:7657–7658`） | UI status 无 enqueued 分支，传入后变 all | 必需精确 owner 能力 |
| diagnostic ErrorOnly | 在 COUNT / OFFSET 前过滤 is_error_card（`:7661–7663`） | `AnkiLibraryListFilter` 仅 status/sort/sortDesc/deck，无诊断过滤 | 不可对当前页再筛选/重算total |
| locator | 每项带 dt.document_id、dt.source_session_id 的 immutable locator（`:7701`） | 返回 flat AnkiLibraryCard，无 documentId locator | sourceId 不是通用 documentId；不补额外查询改变错误/快照顺序 |
| card 形状 / page回显 | 内部 record/card 结构 + page/page_size | flat卡 + 仅 items/total/statusCounts | flat→本 lane 投影、归一化page回显可适配，不是根本 blocker |
| total 宽度 | SQLite COUNT 按 i64 读取（`:7675–7679`），最后 total.max(0) as u64（`:7725`） | public total:number | 从读取起保精确，非负化后以内部bigint返回；不能先Number再BigInt伪恢复 |

### 真实公开服务诊断（不是工具通过证据）

作业 `20261104231341-19e80d` **exit 2**：一次性 Node 诊断，真实 F7/L16/L15/F4
服务、完整迁移库，仅用 owner API 建一个正常卡和一个 error 卡，再由真实 L15 将正常卡
入队为 state=0 / due已到 / reviewVersion bigint。没有替身列表、没有持久化测试脚本，
私有 `/tmp/opencode` fixture 在 finally 清理。

- Rust 预期 all=[normal,error]、due=[normal]、enqueued=[normal]。
- 实际 all=[normal,error]、due=[]、enqueued=[normal,error]。
- 实际 page keys 只有 items/total/statusCounts，卡字段没有 documentId；total 为 number
  （该小样本值未丢精度，不把类型限制说成已观察到数值损坏）。
- exit 2 表示已确认合同差异，不是 lane-gate 失败、不是新用例 pass，也不签新工具入口。

### 给 owner 的最小精确要求（统一经 C1/架构交接）

可扩展现方法或另给 agent-page 正式方法，方法名由 owner 决定，**保持 UI 接口既有语义**：

- 输入：固定 agent 库读 scope、templateId/search、schedule
  `all|due|not_enqueued|suspended|enqueued`、diagnostic `all|error_only`、u32 page/pageSize。
  按 Rust trim / 归一化，page≥1、size1..20。
- owner 在同一 agent 查询中完成全局过滤/COUNT/排序/分页；due不能排除新卡，
  enqueued不能退为all，诊断条件不能在分页后补。
- 输出：完整原页 records（flat card 可适配）、每项 immutable
  `{documentId,sourceSessionId}` locator、无损 u64 total，以及归一化 page/pageSize
  或明确保证与已归一化入参一致；64位内部数据不经Number。
  COUNT 源是 SQLite i64，须从 driver BigInt/文本读取起精确，按 Rust 非负化后再作为 u64；
  不能把现 UI 列表的 number total 用 BigInt(total) 包装成「精确」的新接口。
- L15 `review/api.ts:108::getReviewStatesForLibrary('agent',ids)` 已就绪，保 canonical
  bigint reviewVersion，不再请求新 review 接口；列表成功后才能读 review state。
  列表失败保持 `Failed to list Anki library cards: ...`，review失败保完整 AppError。
- L24 owner接缝到位后再实现真实 roster 的工具入口，复用原 parser / 输出转换 / lifecycle，
  `ratingAvailableToAgent:false`；验证真实过滤/分页/版本/错误顺序，不凭 helper 绿签收。
