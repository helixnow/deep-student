# X2 集成基线定向复核（2026-11-04）

## main-red `650ddffbe`：R20/R29 历史负前提更新（复验 main `f821b3733`）

原 fulltest 基线 `650ddffbe` exit 1（C1 回执 32 failed / 21 files failed）；不据本轮两例修复宣称全量已绿。
本轮原失败复现作业 `20261104233449-dff02b` **2 failed / exit 1**，原输出保留。原因是 X2 自有断言过时，不回退 owner 新实现。

### R20：已注册，但只签实测子集

L18 `159fbc8ae` 经 `650ddffbe` 正常进入 main，`media/index.ts:729-743` → `textbooks-add.ts:textbooksAdd`。
原用例由“必须未注册 / commandNotFound”改为真实调用：

- Rust `textbooks.rs:122-130`：空 sources → [] 且不访问 VFS/不发事件；非空 sources 无 VFS → 精确 Configuration AppError。
- 非空 txt 使用真实 DocsService、真实 L11 TextbookRepo/BlobRepo/FolderRepo 与迁移 VFS：snake_case Textbook DTO、落库 blob_hash/extracted_text/page_count/original_path、六阶段进度（含 null Option）、`dstu:change*` 广播与 indexing → watch → done 顺序均保留明确断言。
- 来源对照 `textbooks.rs:148-155,375-393,490-534,585-684`；没有替换 textbooks_add 处理函数或文本解析器。
- **未签**：PDF/其他格式、恢复/补存、重试与平台分支；不能从注册或 txt 成功推出整条命令等价。R21 既有前端 null 类型问题继续独列，不改 Host 迁就。

### R29：保留省略与原去重保证，不再要求 pending

- 精确 Rust ID：`crates/dstu-agent/src/chat_v2/completion_dispatcher.rs::tests::g03_dedup_hit_converges_to_delivered_without_redelivery`（:883-915），现映射 `host/plugins/chat/tests/completion-dispatcher.test.ts:86-95`。
- Rust 原保证：converge 为 Delivered、outbox 状态 Delivered；TS 原测试还断言 inbox 结果数仍为 1。该测试未改，作业 `20261104233449-ae7301` **1 passed / exit 0**。
- R29 原 6 字段 `x-option=omit` / non-required 与五个 string 形状断言全部保留；另调用生产 `agentCompletionEnvelope` 证明 None 字段不出现、Some 空字符串不丢失。
- L04 `cd40ee716` / `862095376` 经 `bb04a0c0e` 进入 main。生产链 `chat/index.ts:238-258` → runtime → `workspace_restore_executions` → `ensureStarted()` → `tick/processOne()` → emitter；运行闭包也发 completion。
- **仍有条件**：worker 命令注册需 L03 `chatPipeline.execute` 和 L05/L06 `workerRuntimeSurfaces`。原 `workspace-run-agent.test.ts` 的成功与失败/取消两例作业 `20261104233657-aa8f51` **2 passed / exit 0**，真实 runtime、coordinator/outbox、事件路径，外部 execute/跨 lane seams 由原测试提供，不当作完整真实模型或 GUI 签收。

最终 X2 原最小集 `batch2.test.ts review.test.ts -t 'X2-R20|X2-R29'`：`20261104233857-07c123` **2 passed / exit 0**。其余项仅名称过滤未运行；无删断言、无新增 skip、无 GENERATED 修改、无 1,673 重扫。
原因与 owner 进展已通过 `coord.mjs escalate --from X2-frontend-contracts` 上报（`2026-11-04T233506140Z-X2-frontend-contracts.md`），C1 集成时请带本 lane 的 `fix(main-red)`，L18/L04 不需回退。

## main-red `677f6727c`：R32 断言尚未进入 main

当前 main `d51544ecf` 仍是历史“Host 不存在 / Rust 内容缺失”的断言，但已包含 L18 `6b1b3fa40` 修复。
本分支断言翻转在 `04df0ba34` 中，尚非 main 祖先；需要正常集成而不是回退业务行为。
合并 main 后（`e2c5d2b0d`）仅复验原 `X2-R32`：作业 `20261104163033-b81759` **1 passed / exit 0**。
见 `handoff-main-red-R32.md` 的修复与集成证据；不重跑旧 49 项，不删测试、不放宽 Rust 文本。

## D02 正常 main 最小复验（main `4525e11ac`，merge `a2e216441`）

L18 修复 `6b1b3fa40` 已经 `a36488382 merge ds-mig/L18-media-docs` 进入 main。
`readLinkDescriptor` 改为先解析实际内容源，与 Rust `bilibili.rs:950-959` → `pipeline.rs:160-162` 一致。
原 `batch4.test.ts` 的 `X2-R32` 现在断言精确 Rust 字符串 `媒体文件内容缺失: file_missing_x2`；
去掉原来用于记录差异的反向断言，不增加成功路径或平台签收。
只提交 `-t X2-R32`（作业 `20261104153140-26dd94`），**1 passed / exit 0**；同文件另一项由名称过滤未运行（Vitest 显示 1 skipped，未加 skip）。
不重跑历史 49 项或全量 1,673 调用点。**D02 已关闭**；D01 原三子例的关闭结论维持，不扩大到 Bilibili 网络成功、GUI 或跨平台验收。

## 本 lane v2 自查更新（main `879e0a56b`）

- D01 已关闭；D02 的 `bilibili-link-items.ts:49-50` 错误文本仍未修复，继续归 L18，不因续派重复运行已复现用例。
- 修复本工具两处陈旧输出：`classifyDynamic()` 不再把已裁决的 R06 历史 undefined preview 重新交 L17；`renderReport()` 改为当前 Vitest 运行命令。
- 新增 `report.test.ts` 直接调用上述真实函数，作业 `20261104145711-0f0c0f`：2 passed / exit 0。没有新增业务用例、没有删测试、没有重扫或覆盖 `result.json`。
- 标准 v2 八类自查范围与结果见 `LANE.md`。不把本工具完成扩大为业务迁移或跨平台验收完成。

## 版本与证据边界

- 先合并 main `9c13dfc39f2c29aaffda6c61f7dedee2273197f5`，merge commit `3dd266634`。
- 原全量产物 `result.json.commit` 实际标注 **e139c9716**。1,673 调用点 / 509 error / 296 review 是该历史扫描结果；首份移交误写成工具提交 `5e55a95f9`，已在移交文件和 reviewed.json 订正，未重写历史产物。
- 本轮**没有全量重扫**、没有插件 apply、没有业务 invoke、没有修改任何独立验收勾选。仅以下定向源码复核与本 lane 修复经过验证。
- 机器修订见 [reviewed.json](reviewed.json)，不局部扣减旧结果后冒充最新 main 的全局统计。
- 静态入口、动态 import 后的 meta 声明、运行时实际注册、invoke 成功是不同证据。不能互相替代。

## 编号 → 提交 → 真实生产入口 → 验证

| 编号 | 判断 / 归属 | 已集成或本 lane 提交 | 真实入口与证据 | 测试与退出码 |
|---|---|---|---|---|
| X2-R01 | F2 profile 缺漏已修，静态接线确认；C2/F2/F1 | main `642b3d6c4`；防回归 `ddd54715a` | `host/profiles/desktop.json:40-42` → `electron/index.ts:28-33` 的 apply/register；`host/kernel/connection.ts:110-133` 加载 startup profile | review.test.ts X2-R01；队列 `20261104064809-42b48e` exit 0；未执行 F2 invoke |
| X2-R02 | notes_save_asset 三个别名不是 Host 调用失败；L10 | 原扫描已有 redundant-alias；L10 报告 `45b49f48e` 已在 main | `src/components/crepe/features/imageUpload.ts:161-169` 已有正确 noteId/base64Data/defaultExt；Host notes/index.ts 注册命令 | review.test.ts X2-R02，同队列 exit 0 |
| X2-R03 | 既有前端 page_size 错键，不是 Host/契约错误；C1/L10 | 未修；不要求 Host 接受新别名 | `src/utils/notesApi.ts:259-260` → 原 Rust `src-tauri/src/cmd/notes.rs:1782-1798` → Host `notes/index.ts:259-260`；均应读 pageSize，Option 缺省 20 | review.test.ts X2-R03，同队列 exit 0；未改前端 |
| X2-R04 | 修复 X2 x-option=omit 方向性误报；旧 emitter 非当前 execute 必需；通知 F5/L10 | 本 lane `fa0364355` | 审计生产入口 `audit.ts → reconcile → compareShapes`；原 Rust Canvas 类型 :65-91；契约 L10 :4213-4288；Host `canvas-tool.ts:644-768` 经 ACR apply_ops | review.test.ts X2-R04 + 原测试，32 passed / fail 0 / exit 0；类型检查作业 `20261104064809-822239` exit 0 |
| X2-R05 | HEIC 契约正确，Host 未注册/返回传输仍未完成；L18/F1/F7，通知 F5 | 不在本 lane 修复 | `heicConversion.ts:187-203` Android invoke<ArrayBuffer>(...,bytes)；Rust heic_decoder.rs:53-83 校验 raw，:130-140 区分 Android raw JPEG 与桌面拒绝；F7 helper 非命令注册 | review.test.ts X2-R05，同队列 exit 0；未执行 native codec/raw 成功 invoke |
| X2-R06 | 菜单名称可穷举；preview 为历史未定义命令，当前 Rust 路径在订阅前失败，成功通道仍 unproven；F2/C1 | 本轮仅补文档证据，不新增后端缺失任务 | `menuEventBridge.ts:24-86,101-104` → Electron main `shell/menu.ts:8-28`；`graphApi.ts:810` → `NoTagTreeShadPanel.tsx:180` await，:210 catch；历史 undefinedCommands 见下文 | 既有 review.test.ts X2-R06 仅验证菜单静态名称；本轮未重跑，未执行 preview invoke 或平台投递 |

## 逐项人工证据

### R01：23 条声明不等于 23 条旧调用失败

原 F2 模块声明 23 条命令，其中 21 条被原扫描的 src 显式调用。
main 的 `642b3d6c4` 已把 dstu.shell → ../../electron/index.ts 加入官方 profile；`ddd54715a` 防止真实仓库生成器遗漏它。
这是已集成修复，不再派“新增这 23 条实现”。本轮未重新动态加载全部插件，也未验证服务 active/inactive、权限或 invoke 结果。

### R02/R03：已有前端问题不能变成 Host 新行为

notes_save_asset 同时提供正确键和 snake 别名，Tauri 忽略冗余键，无需为此改 Host。
notes_list_deleted 的 page_size 在原 Rust 默认 camelCase 下同样被忽略；pageSize 为 Option，缺省使用 20，
所以这是自定义页大小失效的既有前端问题，**不是 invoke 必然 reject**。
已读 L10 SPEC:968、LANE:177 并核原 Rust，不要求新增 page_size 别名，也不在本 lane 改前端。

### R04：F5 schema 已正确，X2 应使用其序列化标记

Rust content/search/replace/isRegex/section 带 skip_serializing_if=None；契约已标 x-option=omit，
anyOf 中的 null 同时描述 Deserialize 可接受输入。旧扫描器把输入 null 当成 Rust 会输出的 null，产生 5 条误报。
`fa0364355` 仅在 source/producer 侧去掉 null 分支，target/consumer 仍接受 null。真实契约定向测试验证了两个方向。
这不是要求 F5 改契约、不是要求前端兼容错误 Host；其他契约差异仍需逐项核查，不能一概清除。

已读 L10 SPEC:1498-1509、LANE:177，并独立核 Rust：execute_write_frontend 只有声明，当前 execute 不调用它，
写入走 probe/apply_ops（Rust canvas_executor.rs:704-711,1529-1548）。Host CanvasToolExecutor.tryFrontendDelegate
同样经 acrBridgeCall('apply_ops')。保留的构造器、旧 emitter、前端 listener 不构成“Host 必须补发 canvas:ai-edit-request”。
suggestion/DOM 路径没有被自动签收，旧 emitter-unproven 也不能直接变成新增 emitter 任务。

### R05：raw-body HEIC 证据与未完成项

L18 契约 :210-235 已声明 Request 注入和 result.x-binary=true，args=[] 不是无输入。
原 Rust 非 Android 先校验 raw bytes 再返回 HEIC_UNSUPPORTED_PLATFORM；Android 才有 raw JPEG 成功输出。
F7 native/heic/index.ts:4-10 是拒绝 helper，media 当前无命令注册；F1 commands.ts:204-216 仍经 toWireJson。
这是 Host 接线/传输边界，不应要求前端把 bytes 改成对象，或要求 F5 把 binary 改 JSON。
本轮没有 Android 真机、Windows、macOS/iOS WebView 解码或 raw 成功返回验证；也不要求桌面伪造 Android 成功分支。

**R05b 更新（main `4c6cd1ba8`，merge `1b0f41320`）**：上文"media 无注册 / F1 仅 toWireJson"是旧 main 状态。
L18 `9c743b267` 与 `cadffc2e7` 已经 `38c048064` 进入 main（`git merge-base --is-ancestor` 均为真），F1 x-binary 分支也在 main。分层结论：

| 层 | 证据 | 结论 |
|---|---|---|
| Rust raw 校验 / 桌面拒绝 | heic_decoder.rs:53-70、:134-139 | 基准 |
| Host 真实 CallContext raw 输入 | media/index.ts:270-290 把 `call.payload` 交给真实 F7 `heic`；batch2 `X2-R05b` 真实 invoke | 非空 Uint8Array → HEIC_UNSUPPORTED_PLATFORM；空 → empty image body；JSON `{}` → expected raw binary。错误为 `{error_type:"Validation",message,details}`，与 Rust AppError 文本一致，并通过 debug checkError |
| 跨进程 binary | F1 commands.ts:73-97、:234-246 | 桌面永远拒绝，成功 binary 分支在桌面不可达；MessagePort / Electron main raw 请求/响应未运行，**unproven** |
| 目标平台 | Android 解码 | 本环境不可运行，**unproven**；不在桌面伪造成功 |

### R06：动态事件人工清单

菜单 7 个名字：menu://preferences、menu://new-session、menu://close-window、menu://command-palette、
menu://toggle-sidebar、menu://documentation、menu://report-issue。真实回调是 Electron main 的 emit(MENU_EVENTS[id])，
不是 Host BackendEvents。Linux 静态对齐不等于 macOS 点击投递通过。

**C1 补证后的 preview 分类（本轮仅报告/分类修改）**：

- 生产调用在 `src/utils/graphApi.ts:810`；精确字面检索 `src-tauri/` 和 `contracts/` 均无该命令定义。
- `docs/dev/electron-migration/inventory/unassigned.txt:36` 已列该名称；`host/plugins/integration/audit/commands.json:4,330-337` 将它置于顶层 `undefinedCommands`，不是待迁移的已定义 Rust 命令。
- `NoTagTreeShadPanel.tsx:180` 先 await 该 invoke，:187 才订阅返回的 eventName，后续再订阅后缀；`graphApi.ts:817-819` 重抛失败，调用者 :210-215 catch。因此当前 Rust 正常 not-found 路径**不会取得基名，也不会到达这些成功分支订阅**。
- 动态成功通道仍为 **unproven**，不把前置失败等同于成功覆盖；更不从 `{}` 猜测全部事件。涉及 _start/_end/_error 的成功分支不能据此成为新增生成器/发射器任务。
- 撤回上一版“交 L17 核后端迁移归属”的派工含义：本项由 C1 保留为历史未定义调用，不给 L17 派“补生成/发射”来把迁移变成新功能。
- R01–R05 结论与既有作业结果不变。本轮源码未改，未重跑旧全套或全量扫描，未改前端/契约。

## 第二批定向核查 R07–R22（main `4c6cd1ba8`，真实插件 apply + 内核 invoke）

从历史 `result.json`（`e139c9716`）中选出仍未裁决的 L04/L17/L18 条目，逐项按 Rust → 契约 → Host 入口核对，
再用 `batch2.test.ts` 在 `createTestHost` 中真实 apply chat/memory/media 插件并 invoke。只替换外部端口
（shell 窗口操作、settings/log、VFS DB/repo、L12 `vfsIndex.pdf`），不重建任何处理函数。不重扫 1,673 调用点。

| 编号 | 命令/事件 | Rust | 前端 | 当前 main 实测 | 分类 → 去向 |
|---|---|---|---|---|---|
| R07 | chat_v2_send_message | send_message.rs:462 | sendOperations.ts:186,571 | commandNotFound | Host 缺口，L04 SPEC.md:14 已自列 → L04/L03 |
| R08 | chat_v2_retry_message | send_message.rs:919 | messageOperations.ts:153 | 同上 | 同上 |
| R09 | chat_v2_edit_and_resend | send_message.rs:1268 | messageOperations.ts:365 | 同上 | 同上 |
| R10 | chat_v2_continue_message | send_message.rs:2011 | messageOperations.ts:439 | 同上 | 同上 |
| R11 | chat_v2_compact_session | block_actions.rs:57 | InputBarV2.tsx:1022 | 同上 | 同上（compaction 编排属 L03，BLOCKERS.md:12） |
| R12 | chat_v2_stage_context_attachments | attachment_stage_executor.rs:1849 | attachmentMaterialization.ts:161 | 同上 | 同上 |
| R13 | chat_v2://kill_switch_changed | kill_switch.rs:195 | AgentControlCenter.tsx:377 | emergency_stop/resume 各发 1 次，payload=命令结果 | 已修复；历史 emitter-unproven 作废 |
| R14–R17 | quick_assistant_show/hide/apply_enabled + quick-assistant://shown | quick_assistant.rs:20,257-280 | quick-assistant/window.ts:8,29,39,103 | 三条均 resolve null；shown 以 null 发往 WebviewWindow `quick-assistant` | 已修复（memory/index.ts:250-255）；窗口操作为 shell 端口，非真实 GUI |
| R18 | get_image_as_base64 | commands.rs:8494 | configApi.ts:13-18 | relativePath 读到真实文件；relative_path 被契约拒绝 | 既有前端冗余回退，非 Host 缺口 |
| R19 | media_transcribe_start | media/commands.rs:29；pipeline.rs:132-135 | mediaTranscriptApi.ts:283 | 已注册；缺资源返回与 Rust 同文 `{"code":"not-found",...}` | 已修复（`38c048064`）；ASR 成功路径未跑 |
| R20 | textbooks_add（含 textbook-import-progress 发射） | textbooks.rs:115 | textbookDstuAdapter.ts:178；chatApi.ts:354 | 历史 main 4c6cd1ba8 为 commandNotFound；现 main f821b3733 已注册且文本导入/错误子集复验通过 | 159fbc8ae 已进入 main；仅签顶部列出的子集，非完整导入功能 |
| R21 | textbook-import-progress null 字段 | textbooks.rs:26-39 无 skip | importActions.ts:166 | 契约 x-option=null 正确 | 既有前端类型问题；不据沉默断言缺发射 |
| R22 | media_transcribe_cancel 上游失败 | dstu-media commands.rs:367-380 → MediaError::Database 字符串 | mediaTranscriptApi.ts:287 | L12 cancelMedia 抛普通 Error → **HandlerPanic**（生产中前端 Promise 不 settle） | **新确认 Host 差异** → L18；仅 DB 失败时可达 |

既有前端问题（不改，单列）：R18 snake 回退、R21 Option 类型。契约问题：本批无（F5/C2 无新派单）。

队列作业：batch2 单文件 `20261104112829-229ee4` 9 passed / exit 0。集成门禁同款三项（提交 `ef1a789a5`）：
`typecheck:host` `20261104113245-0bd8f2` exit 0；`migration:boundaries` `20261104113245-19113b` exit 0（0 violation）；
`vitest run -c vitest.host.config.ts scripts/electron-migration/frontend-audit` `20261104113245-b0ddd6` 3 文件 41 passed / exit 0。
ledger `20261104105156-b33941` exit 0（problems 0）。测试已从 node:test 改为 vitest，原门禁"No test suite found"已消除。

## 新缺陷矩阵（finding → owner → 待修复 main → 原最小用例复验）

基线 main `ad11a8394`（merge `3da2840c8`）。

### X2-D01 非 MediaError 异常成为 HandlerPanic（owner L18）

根因：`host/plugins/media/index.ts:100-107` `mediaFailure` 对非 MediaError / BiliRequestError 原样重抛，内核当作处理函数 panic，生产中前端 Promise 不 settle。只在 DB / 上游失败时可达。

| 子例 | 状态 | Rust 期望 | 修复 / 复验 |
|---|---|---|---|
| R22 media_transcribe_cancel | **已关闭** | commands.rs:375-377 → `{"code":"database-failed",...}` | 修复提交 `a34d959a6`（L18，新增 `cancelMedia` 包装，index.ts:110-115），经 `91e853a52 merge ds-mig/L18-media-docs` 进 main；batch2 `X2-R22` 已翻转为 Rust 字符串，作业 `20261104124203-d9fad9` 9 passed |
| R24 media_checkpoints | **已关闭** | ledger.rs:255-257 → `e.to_string()` | 修复提交 `00d2606e6`（L18，`ledgerFailure`，index.ts:110-112），经 `3bff65125` 进 main；batch3 `X2-R24` 已翻转为 `no such table: questions`，作业 `20261104140332-fdbc86` 通过 |
| R25 media_study_ledger 错误半 | **已关闭** | ledger.rs:466-476 → `e.to_string()` | 同上提交；batch3 `X2-R25` 已翻转为 `no such table: document_tasks`，同一作业通过 |

R22 与 R24/R25 分别在调用点修复（cancelMedia、ledgerFailure），共用的 `mediaFailure` 未改。X2-D01 三个子例在 main `bec9c35ba` 全部关闭。

### X2-D02 stream_quality 缺失条目的错误文本不同（owner L18，低）

| 用例 | Rust | Host（main `ad11a8394`） | 复验 |
|---|---|---|---|
| R32 `media_bilibili_stream_quality({fileId:'file_missing_x2'})` | bilibili_stream.rs:520-540 → :474 read_link_descriptor（bilibili.rs:950-959）→ pipeline.rs:160-162：`媒体文件内容缺失: file_missing_x2` | 历史 main ad11a8394：先查 files 行返回 `媒体文件不存在: file_missing_x2` | **已关闭**：`6b1b3fa40` 经 `a36488382` 进入 main，翻转原断言，`20261104153140-26dd94` 1 passed / exit 0 |

同属 NotFound，只是文本不同；前端请求已删除或未知的 file_ id 时可达。

## 第三批定向核查 R23–R28（已注册命令/事件的成功与错误 DTO）

`batch3.test.ts`：真实 apply media 插件，真实迁移 vfs/mistakes 库，只提供外部端口。作业 `20261104115839-9c9945` 5 passed / exit 0；
`typecheck:host` `20261104115839-d4084b` exit 0；提交 `24064e8a0` 上 `migration:boundaries` `20261104120409-565003` exit 0，目录 vitest `20261104120409-dd63d5` 4 文件 46 passed / exit 0。

| 编号 | 命令/事件 | Rust | 前端 | 当前 main 实测 | 分类 |
|---|---|---|---|---|---|
| R23 | media_checkpoints 成功 | ledger.rs:174-233 | mediaCheckpoints.ts:93 | camelCase DTO 与 Rust 完全一致（seconds=65，未作答 isCorrect=null）；空 id → [] | 已对齐 |
| R24 | media_checkpoints SQL 失败 | ledger.rs:255-257 | 同上 | HandlerPanic `no such table: questions` | X2-D01 → L18 |
| R25 | media_study_ledger | ledger.rs:28-47,426-476 | media-studio/api.ts:229 | 零值账本 DTO 一致、id 去空白去重；SQL 失败 HandlerPanic | 成功已对齐；失败 X2-D01 |
| R26 | textbooks_relink 不存在 | textbooks.rs:712-714 | TextbookContentView.tsx:580 | `{error_type:"NotFound",message:"教材不存在: tb_missing",details:null}` | 已对齐；哈希/重链成功路径需 F3，未跑 |
| R27 | media_bilibili_playback_error | bilibili_stream.rs:820-836 | useBilibiliQuality.ts:81-86 | bilistream 502 → 1 次事件 `{fileId,qn,epoch,attempt,message}` | 已修复；历史 emitter-unproven 作废。502 来自账号存储缺失，非真实 B 站上游 |
| R28 | memory://changed | handlers.rs:82-91 及 13 处调用 | memoryDomainRefresh.ts:10 | Host memory/index.ts 13 处 `changed()` 的 action 与成功条件逐一对应；L17 自有测试 commands-core.test.ts:275 已动态覆盖（本轮未重跑） | 已修复；前端 payload `unknown` 属既有前端类型缺口 |

## 第四批 R29–R31（历史 L04/L17 事件条目收尾）

| 编号 | 条目 | 结论 | 证据 |
|---|---|---|---|
| R29 | workspace_agent_completion 6 条 payload 不符 | 误报（R04 同类）：6 字段省略结论维持；当前生产 serializer/条件 emitter 路径已实现，原 G03 测试已 ported 并复验 | 顶部 main-red 650ddffbe 更新为准；旧 20261104130146-a0cdec 是历史结果 |
| R30 | chat_v2_request_audit、workspace_worker_ready 发射 | unproven-不可达：发射点在 chat_v2_send_message（R07 未注册）及其流水线调用的工具里 | send_message.rs:549,764；workspace_executor.rs:375；subagent_executor.rs:696 |
| R31 | hpias_event 发射 | 已有 Host 发射 hpias-service.ts:85，L17 自有 hpias.test.ts 覆盖（未重跑） | — |

历史 L18 "not-in-meta" 中 media_bilibili_* / media_checkpoints / media_study_ledger / media_transcribe_estimate / test_pdfium_status / textbooks_relink 当前 main 均已注册；
其中已有动态 DTO 证据的是 R19、R23、R25、R26、R27。其余 L04 workspace_* / chat_v2_retry_variant(s) / wake_session 是 L04 SPEC.md:14 自列的未注册命令，
handout_llm_complete / handout_vlm_caption / notes_export_docx / parse_document_from_base64 / test_ocr_engine 是 L18 LANE.md 自列阻塞，均不另开新编号。

## 第五批 R32–R34（Bilibili probe / stream_quality 错误结果，无网络）

`batch4.test.ts`：真实 apply media 插件，出口设置经真实 `media_bilibili_transport_configure` 写入。作业 `20261104133911-213c0f` 2 passed / exit 0。
L18 自有测试已覆盖的链接解析错误、代理配置错误、link_get 不重复。

| 编号 | 用例 | 结论 |
|---|---|---|
| R32 | stream_quality 缺失条目 | X2-D02（文本不同） |
| R33 | browser_bridge 模式无桥时 probe | 完整 BiliError JSON 9 个键与 Rust 一致（bilibili.rs:1122-1127 → session.rs:95-101 → types.rs:105-117） |
| R34 | browser_bridge 模式无桥时 stream_quality | 纯文本 `浏览器桥未就绪，请连接浏览器`，与 Rust 一致（bilibili_stream.rs:466,531-540） |

历史 main `ad11a8394` 无 workspace_agent_completion（R29）生产者；该“无生产者”前提已由 main `f821b3733` 的条件 worker/dispatcher 路径取代，最新证据与未签边界见顶部 main-red 更新。
测试框架：三个原 node:test 文件改为 vitest 的 `test`（同签名，断言未变），没有删测试或伪加用例；门禁调度范围由 infra 决定。

## 既有前端问题（独列，不改 Host 迁就）

- R18 `get_image_as_base64`：configApi.ts:13-18 的 snake_case 回退冗余。
- R21 `textbook-import-progress`：importActions.ts:166 把可为 null 的 current_page/total_pages/error 标为非空。
- R28 `memory://changed`：memoryDomainRefresh.ts:10 payload 为 unknown（不读 payload，无运行影响）。
- R31 `hpias_event`：hpiasEventBridge.ts:129 payload 为 any。

## 全局作业队列实际结果（quality §10）

本轮所有测试与类型检查走队列，没有直接跑重 CPU 命令。

```text
node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs result 20261104064809-42b48e --tail 60
tests 32; pass 32; fail 0; cancelled 0; skipped 0; todo 0
duration_ms 53998.94403
[作业 20261104064809-42b48e] node --test scripts/electron-migration/frontend-audit/review.test.ts scripts/electron-migration/frontend-audit/audit.test.ts
[作业 20261104064809-42b48e] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104064809-42b48e.log

node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs result 20261104064809-822239 --tail 60
[作业 20261104064809-822239] node node_modules/typescript/bin/tsc --noEmit --skipLibCheck --target ESNext --module ESNext --moduleResolution bundler --allowImportingTsExtensions --esModuleInterop --strict scripts/electron-migration/frontend-audit/audit.ts scripts/electron-migration/frontend-audit/audit.test.ts scripts/electron-migration/frontend-audit/review.test.ts --incremental --tsBuildInfoFile .lane.tsbuildinfo
[作业 20261104064809-822239] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104064809-822239.log
```

job result 自身退出均为 0；完整测试输出无 Errors/未捕获异常。静态断言测试不冒充生产 invoke 集成测试。

## 移交

- 已向 C2-platform / F2-shell 投递 handoff-C2-F2.md，说明已合入 main，不重复实现。
- 已向 F5-contracts / L10-notes / L18-media-docs / C1-app 投递 handoff-F5-L10-L18.md，区分契约、扫描器、既有前端与 Host 缺口。
- 移交首份消息的旧快照提交号已在仓库文件订正；不影响生产源码证据或分类。
- 本轮没有全量重扫或重跑 --check；不声称全局差异归零，不改独立验收勾选。
