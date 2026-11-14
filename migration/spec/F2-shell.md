# F2-shell 行为规格（`migration/spec/F2-shell.md`）

## WP-194：browser envelope 结构化错误发送

- Rust 依据：`crates/dstu-browser/src/browser/bridge.rs:77-105,114-148,153-174,256-273`。
  `BridgeError::Bridge` 的 code/message/details 与 Display `bridge error {code}: {message}` 是两份信息；
  `BridgeErrorBody.details: Option<Value>` 缺省/null 都是 None，false/0/空字符串/嵌套 JSON 是 Some。
- 生产入口：`electron/main.ts::shellRequest` → `handleBrowserShellRequest` →
  `BrowserContentSurface::{snapshot,click,typeText,...}` → `executeJavaScript` → `parseBridgeEnvelope`；
  返回异常经 `HostSupervisor` 的正式 shell-request 拒绝支发送至 F1。

| Rust 分支 | F2 落点与本包行为 |
|---|---|
| `into_result:136-137` 成功 | 原 data/null 返回，不附错误字段 |
| `into_result:139-148` 已有有效 error body | `BrowserBridgeError.data` 使用 F1 公共 `ShellErrorData` 类型；只提取原 string code/message，details 按 Option；Error.message 仍是原 Display |
| 同上，error 缺省/null | 原 UNKNOWN 显示文本保留；无原 typed body 不增加 errorData |
| `parse_bridge_json:153-174` 非法 JSON/非信封 | 原 Error 分类与显示保留，无 errorData；既有解码差异见 BLOCKERS 后继 |
| `finish_script_result:262` / `await_script_channel:273` eval/timeout | 原 Error 不升级 typed；evalScript 的 3s/5s/15s timer 与 finally 清理不变 |
| main→Host 接缝（新增传输） | host.ts 只为内部 `BrowserBridgeError` 附已有 `ShellResponse.errorData`；普通 Error、string、形似对象仍只发原 error:string；F1 用公共 ShellError 拒绝且清 pending/timer |

- 仅新增 electron 内部的异常载体，不新增公共错误框架/共享协议，不从显示文本解析 code。F1 公共契约已在
  main `fd9d654d7dddee26913a1f8ab2b064445ff99dc0`；L19 领域恢复及接管策略归 WP-195。
- 日志：Rust `call: bridge.rs` 的 warn 对应 `BrowserContentSurface.callBridge` 既有日志与 rethrow；
  typeText 直接 eval 路径保持原样。无新增业务日志/DB/文件副作用；无时限、ACL、原文入参或退出策略变化。
- 证据：`electron/tests/browser-error-host.test.ts` 启动真实 `electron/main.ts`、BrowserWindow（Linux detached）、
  executeJavaScript、utilityProcess/MessagePort、`serveHost`/CapabilityAcl/正式 ShellService。
  专用测试插件仅调用 ctx.shell 并记录公共 ShellError，转换为 CommandError 供 renderer 验证失败 settle；
  不替代 L19 业务错误转换，不称官方 profile 全业务。请求 source 明确为 `{window:'main',webview:'main'}`。
- 密码场景直接加载当前 L19 生产 `browser-bridge.js`，真实 password DOM 经 snapshot ref→type 返回
  `{code:'BLOCKED',message:'password fields cannot be typed by agent bridge',details:{reason:'password_field',ref:'e1'}}`。
  brief 的 `PASSWORD_INPUT_BLOCKED` 仅作为测试场景名：Rust `browser_bridge.js:453-458` 与生产脚本均无该字面码。
  STALE_REF 由同一真实脚本产生，覆盖 details 缺省；null/嵌套变体只在测试页包装该真实 body 的 details，
  仍经生产 eval/decoder/路由/port。普通失败由未创建窗口时真实 snapshot 产生，成功经真实文本输入回读。
- 断言同时覆盖独立 Display、原 typed message、wire 的 ok:false/error/errorData、公共 instanceof、
  source、renderer callbacks=0、每次 invoke 后 Shell pending=0、唯一 settle id；
  `browser-error.test.ts` 补 Rust `parse_envelope_password_blocked` / `finish_script_result_maps_bridge_error_envelope`
  断言及 double-encoded、Option 标量、坏 body；`host-shell-error.test.ts` 仅作非品牌负向补充。
- 先红 job `20261105220753-84936d`（1 failed/exit1）确证 body 丢失；修复后
  `20261105220902-29c329`（9 passed/0 failed/0 skipped/无 Errors/exit0）。首轮新夹具的 HTML 编码及
  snapshot oracle 按生产脚本 `nodePayload:233-241` 更正为 UTF-8、password `[password]`、普通节点无 password 字段；
  未改本包红灯 typed 断言或任何既有移植断言。仅 Linux 实跑，不授新 B/C 资格。

## WP-134：入站 JSON 原文（preload → Shell → Host）

- Rust 依据：tauri 2.11.5 `src/ipc/protocol.rs:522-535` 按 content-type 区分 Raw 与
  `serde_json::from_slice::<Value>`；`src/ipc/command.rs:62-68,92-104,134-144` 再按参数键反序列化，
  保留缺省/None、类型错误与 bytes payload 错误。`src-tauri/src/insight/handlers.rs:66-77`
  的 offset/limit 为 Option<i64>，缺省 0/100；合法相邻 9007199254740993/9007199254740992 不可合并。
- preload `bridge.ts:77-93` 已在页面主世界 stringify 成 JSON 文本，原生 JSON.rawJSON 原子在那里
  输出数字 token；隔离世界与 main 只传该文本。普通对象保持普通对象，普通 `rawJSON` 属性不作为原子识别。
- `shell/runtime.ts::dispatchInvoke` 给 Host 的 JSON invoke 增补已发布的 `InvokeRequest.argsJson`，
  直接取 `message.payload.data`，不能由解析后的 args 重新 stringify。旧 args 投影保留，权威读取与
  精确契约由 F1 `connection → runtime → commands` 完成；内置 Shell 插件仍走既有参数分支。
- Raw bytes 不携带 argsJson；headers、可信 WebFrameMain 来源、window/webview label、ACL、回调 ID
  和成功/错误响应编码沿用原链。Host typed i64 越界/小数/指数拒绝先于 handler，AppError 原样回到 renderer。
- 无新 DB/业务文件、日志、时钟、取消或生命周期策略。WP-090 历史完整保留。
- 入口证据为 `electron/tests/inbound-json-renderer.test.ts`：真实 Electron main/preload/utilityProcess、
  MessagePort、生产 kernel/契约/CapabilityAcl、生产 L15 insight_list handler；仅其外部 insight/storage
  服务作为测试输入。观察 listInsights 的真实参数与 bigint 类型，不把 wire 原文日志当 handler 实参。
  另经两个 HTTP origin 验证本地 source 与远程拒绝，普通对象/headers、raw bytes、错误和 callback 清理。
  这不是官方 profile 全业务或数据库精度验收；main 后 X1 WP-135 独验另行执行。
- 先红 `20261105200807-14b6ec` exit 1：actual handler offset 均为 number 992，且 1.0/1e0
  被误接收（实参原件 `/tmp/opencode/f2-inbound-h1tV68/calls.jsonl`）。修复后
  `20261105200941-0c41c6`：4 files / 13 passed / 0 failed / 0 skipped / 无 Errors / exit 0，
  新入站链与既有 raw/typed 出站链、bridge、frame-origin 共同通过；所有原期望保留。

## F1-RAWJSON-01 后继：Electron 最终 JSON 输出

- Rust `serde_json::Value` 的 arbitrary_precision 数字可含 `1e400` / `-1e-400` / `-0`；
  typed f64 的非有限值则按 serde_json 序列化成 null。题库事件 Rust 入口
  `src-tauri/src/commands.rs:1168-1187` 将进度转 Value 后 emit。
- F1 候选仅识别真正的 `JSON.isRawJSON` atom，Host 投影后 structured clone 的
  Infinity/-0 已无来源品牌。F2 不能据该 number 值推断 raw，通用 Infinity→1e400 或 -0→-0
  replacer 会改变普通 typed 出口，因此已在未提交时撤回；生产 main/runtime 不保留该实验。
- C1/C2 已批准最小来源协议，F1 确认 `BackendEvent.payloadJson?: string`、
  `InvokeResponse` 成功/失败两支 `json?: string`。仅原 Host 值有原生 raw 品牌时由 F1
  一次 JSON.stringify 生成文本、JSON.parse 生成同源投影；普通消息和 binary 成功字段缺省。
  F2 HostSupervisor 保留结果 json，runtime 直接放入已有 JSON ResponseBody；main 事件
  优先 payloadJson，均不 parse/stringify。无文本保持原出口，不推断 raw 来源、不改消费者。
- 新测试仅证明普通消息不回归：生产 encodeBody、真实 Electron/main/preload 的普通 number
  null/零归一、有限数字形状、普通 `{rawJSON: ...}` 对象、特殊 own key 与二进制 body。
  真实 kernel/插件→MessagePort→main/preload→renderer 的后继回归覆盖同载荷 raw 极值、
  typed null、lookalike 的 success/error/定向 event，以及普通消息和 binary；
  Value 整数 -0 对齐 F4/Rust 为 0，小数 -0.0 与负下溢保持负零。
  原始 red 作业与无效实验 green 留在 LANE/BLOCKERS；双方同树实跑前不签收。
  无 DB/业务文件写入、新日志、事件目标/顺序、消费者或原生动作变化。

## main-red：外壳就绪 watchdog 与慢启动预算

- Rust `crates/dstu-platform/src/startup_gate.rs:22-24` 因首装/升级迁移可能耗时数十秒，
  把预检等待上限定为 120 秒。Host 的 `ready` 由 F1 在 profile 与启动 finalizer 完成后发出。
- Electron 新增的进程托管 watchdog 原先仅给 30 秒，会在该合法启动窗口内杀掉尚在初始化
  的 Host。复现作业 `20261105000218-1ac390` / `20261105001130-e20656` 均命中此日志；
  相同实现的单文件 `20261105000504-058dd7` 全部业务断言通过，故不是 restart/PDF 返回契约变化。
- watchdog 统一使用 F2 已发布的 `STARTUP_READY_WAIT`，仍有界终止永不 ready 的进程，
  不改崩溃重启策略、插件错误策略或测试超时。Rust 没有 utilityProcess watchdog，
  此处是 Electron 托管机制的预算对齐，不声称 Rust 在 120 秒后也会杀进程。
- `host-readiness.test.ts` 直接调用生产 `HostSupervisor`，只替换最终 Electron 进程/端口，
  验证 31 秒时仍活着、ready 后不误杀、未 ready 到 120 秒仍终止。原真实 Host 测试的
  50 秒报告期限、60 秒测试超时及全部 expect 不变。

## v2 补充：文件路径 White_Space（F2-v2-10）

- Rust `unified_file_manager.rs:40-50,73-75`：先仅移除首尾 NUL，再以 Rust
  `str::trim` 移除 Unicode White_Space；scheme 检查用 `trim_start`。
  U+0085 属于空白，U+FEFF 不属于空白（可作为实际文件名的一部分）。
- TS 文件命令统一消费 F4 `rustTrim` / `rustTrimStart`，不再使用 JS `trim` 的不同字符表。
  顺序保持 NUL → trim → scheme → double-encoded URI → decode，不加新校验或平台分支。
- 返回值、AppError、日志（该分类器没有日志）、文件副作用与取消语义不变。
  `tests/file-entry-regressions.test.ts` 经 kernel invoke 验证 NEL 包围的读写路径和
  尾部 BOM 文件名的写入、SHA-256；不移除既有测试断言。
- 同类桌面入口 `external_file_opener.rs:68-72,182` 在平台拒绝前解析 mode；
  `parseExternalOpenMode` 同样改用 `rustTrim`。入口测试精确断言 NEL 包围的 share
  进入原桌面拒绝、带 BOM 的 view 保留 BOM 并报非法 mode；无新增副作用或日志。

## v2 补充：Host 窗口枚举（架构师 L04 接缝）

- Rust `crates/dstu-agent/src/chat_v2/goal/runtime.rs:435-440` 通过
  `Manager::webview_windows()` 查询当前窗口，优先 main，否则任意一个；无窗口时 None。
- TS `electron/shell/windows.ts` 的 `WindowManager.listWindows/getMainWindow` 查询实时存活
  应用 webview 窗口（过滤已销毁的窗口/contents），`focused` 来自原生 isFocused；
  `electron/main.ts` 提供 `window.listWindows/window.getMainWindow`，
  `electron/index.ts` 发布 `ctx.shellWindows`，公共契约与调用方法见 `electron/API.md`。
- 服务不缓存 host/window 生命周期事件，不遗漏消费者启动前的窗口；不保证遍历排序。
  空列表/无 main 与桥接失败分开处理，后者 reject，不静默退化为空集。
- 只读 main 内存状态，不写表/文件，无新增业务日志、取消任务、时钟或 OS hooks。
- `electron/tests/window-catalog-host.test.ts` 真实 main/Host 协议和 F2 服务测试；
  `window-catalog.test.ts` 真实 kernel 服务边界测试。作业 `20261104161512-cd95c5`：4 passed/exit 0。
  不冒充完整官方 profile 或 macOS/Windows 验证；消费者的派发业务由 L04 接入。

## v2 补充：窗口配置生产链（F2-v2-08）

- Rust：tauri-utils 2.9.3 `config.rs:2017-2019,2319`，`focusable: bool` 默认 true；
  tauri 2.11.5 `src/window/mod.rs:882-885` 原生 builder 接受该属性。
- TS：`loadTauriConfig`/window create → `decodeWindowConfig` 校验 bool →
  `mapWindowConfig` 按 `config.focusable ?? true` → `WindowManager.create` 的
  `BrowserWindow({focusable: mapped.focusable})`。`focus` 是初始激活策略，与 focusable 分开。
- 无业务表写入、无额外事件/日志或取消任务。创建窗口的生命周期沿用现有 manager。
- 证据：`electron/tests/tauri-config-windows.test.ts` 从配置入口断言映射；
  `electron/tests/window-focusable.test.ts` 用真实 Electron 创建隐藏窗口、读取 `isFocusable()`，
  显式 false/缺省 true 均验证；作业 `20261104150701-f55f7c`（5 passed，exit 0）。
  Linux/xvfb 证据不外推为 macOS/Windows 实测或独立复核签收。

<!-- BEGIN GENERATED:spec:header -->
逐条对照 Rust 源码填写（README §3.3）。每节下的清单项全部勾选（`- [x]`）即视为该节完成，ledger 据此计算 B 级；
勾选前在冒号后写明结论与 Rust 依据（文件:行）。生成区块由 `npm run migration:scaffold -- --refresh` 维护。

命令 23 个 · 发出事件 4 种 · 契约：`contracts/ipc/F2-shell.json`
<!-- END GENERATED:spec:header -->

## 全局语义（README §3.3）

<!-- BEGIN GENERATED:spec:global -->
本 lane 全部命令共同适用的约定；与某个命令不同时在该命令一节单独说明。
<!-- END GENERATED:spec:global -->

- [x] Option → null 还是缺省（`skip_serializing_if`）：Rust serde 把缺失键与 `null` 都反序列化为 `Option::None`（`contracts/ipc/F2-shell.json` 的 `x-option: null`）；返回 `Option` 未加 `skip_serializing_if` 时输出 `null`。本 lane 已注册命令无 `Option` 结果。Electron `electron/shell/args.ts` 的 `optString`/`optBool`/`optInteger` 同样把 `undefined` 与 `null` 视为未传。
- [x] u64/i64 超过 2^53 的表示：Rust `serde_json` 原样输出 64 位整数；JS 只能精确到 2^53。已注册 16 个命令中只有 `get_file_size` 返回 u64（`src-tauri/src/commands.rs:4193`），Node `statSync().size` 为 number，超过 2^53 的文件大小无法精确表示（实际文件系统远未达到）；`read_file_bytes` 的 `max_bytes` 上限被 200MiB 截断（`commands.rs:4169`），不会触及该边界。
- [x] 字段顺序（serde_json preserve_order）：`src-tauri/Cargo.toml:101` 启用 `serde_json/preserve_order`，对象按插入顺序输出；TS 对象字面量同样保持声明顺序。本 lane 已注册命令只返回 string/boolean/null/原始字节，不返回对象，无跨实现字段顺序差异。
- [x] f32 精度：本 lane 已注册命令没有 f32 参数或结果；JS number 是 f64，未来迁移含 f32 的结构时须单独核对最短可逆表示。
- [x] 错误形状（字符串 / 对象、文案、错误码）与 panic 的前端可见结果：`AppError` 为 `{ error_type, message, details }`（`src-tauri/crates/dstu-core/src/models.rs:942-947`），`details` 无 `skip_serializing_if`，缺省序列化为 `null`；`error_type` 使用变体名（`Validation`/`Unknown`/…，`models.rs:928-940`）。`get_prevent_sleep`/`set_prevent_sleep`/`open_system_permission_settings` 返回 `Result<_, String>`，reject 值为字符串（`cmd/power.rs:26,77`、`system_permissions.rs:129`）。已迁移命令的正常路径不含 panic，迁移不依赖 panic 文案。
- [x] 取消：CancellationToken / drop → AbortSignal，取消点一致：这些 Rust 命令没有 `CancellationToken`，前端放弃 invoke 不会中断处理（`power.rs:26-75` 的同步锁与 `external_file_opener.rs:176` 的 `spawn_blocking` 均执行到结束）。Electron 处理器不检查 `call.signal`，`set_prevent_sleep` 即使调用方放弃也会在串行队列中完成，语义一致。
- [x] 并发：锁 / 单写者 / 队列在 Node 中的对应（await 交错）：防休眠状态由 Rust `Mutex<Option<Child>>` 串行化并保证幂等（`power.rs:18-19,29-43`），Electron 用 promise 串行链 + 单 `child` 变量复刻（`electron/power.ts:7-40`）；`set_sidebar_vibrancy` 经 Tauri `run_on_main_thread` 串行执行（`cmd/window_effects.rs:196-209`），Electron 在 main 进程同步调用 `setVibrancy`。本 lane 无数据库共享状态。
- [x] 时间与 ID：生成方式、格式、时区：已注册命令不生成时间戳或业务 ID；防休眠子进程绑定当前进程 PID（macOS `-w <pid>`、Linux `--pid=<pid>`，`power.rs:107-135`），Electron 用 `process.pid`（`electron/power.ts:14-15`）；不涉及时区。
- [x] 不对含 HashMap 的结构做序列化后比对：已注册命令结果不含 `HashMap`；Rust `preserve_order` 下对象键序即插入序，测试不对含 `HashMap` 的结构做序列化字符串比对。

## 命令 `copy_file`

<!-- BEGIN GENERATED:cmd:copy_file -->
- Rust：`src-tauri/src/commands.rs:4264` · async
- 前端：app（1 处，例 `src/utils/chatApi.ts:86`）
- 契约：`contracts/ipc/F2-shell.json`
  - 参数：sourcePath: string, destPath: string
  - 结果：null · 错误：AppError · 注入：window
<!-- END GENERATED:cmd:copy_file -->

- [x] 输入：`sourcePath`/`destPath` 均为 `String`，先经 `classify_path` 分类（`src-tauri/crates/dstu-storage/src/unified_file_manager.rs:73-109`）。桌面端没有 `content://` 原生实现，虚拟 URI 在 `open_reader`/`open_writer` 落到 `SafeFilePath::Url` → 插件 `URL is not a valid path`（`unified_file_manager.rs:116-177`）；空虚拟串分别报 `源文件路径无效`/`目标路径无效`（`unified_file_manager.rs:256-265`）。Electron `electron/file-ops.ts` 按同一顺序分类、同一文案失败。
- [x] 输出：Rust 返回 `()`（`src-tauri/src/commands.rs:4264-4267` 丢弃 `copy_file` 的 `u64` 计数）；Electron 返回 `undefined`，经 JSON 序列化为 `null`。
- [x] 错误：`AppError::file_system`：源打开 `读取文件失败: {path} ({io})`、目标打开 `写入文件失败: …`、复制 `复制文件失败 ({src} -> {dst}): {io}`、刷新 `刷新文件失败: …`、回读 `目标回读失败，已停止并不得报成功: …`、长度或 SHA-256 不一致 `目标回读校验失败: …`（`unified_file_manager.rs:252-347`）。Electron `electron/file-ops.ts` 复刻同一组文案与回读校验。
- [x] 事件：无。
- [x] DB 读写：无；只读写文件系统，目标父目录不存在时 `create_dir_all`（`unified_file_manager.rs:147-152`）。
- [x] 取消/并发：无 CancellationToken；Rust 定义 async 但内部同步阻塞执行，Electron 顺序 await。目标以 truncate 打开，无跨端额外锁，并发写同一目标由最后写入者决定。
- [x] 时间/ID：无。

## 命令 `export_unified_backup_data`

<!-- BEGIN GENERATED:cmd:export_unified_backup_data -->
- Rust：`src-tauri/src/commands.rs:6552` · async
- 前端：none
- 契约：`contracts/ipc/F2-shell.json`
  - 参数：options: Value
  - 结果：Value · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:export_unified_backup_data -->

- [x] 输入：`options: serde_json::Value`；只读取 `include_settings`（缺省/非 true 为 false），其余 `include_images`/`include_embeddings`/`include_statistics` 在 Rust 中解析后未使用（`commands.rs:6557-6571`）。Electron `electron/backup-export.ts` 同样只按 `include_settings === true` 分支。
- [x] 输出：`{ version: "3.0", timestamp, backup_type: "unified", traditional_data: { reviews: [], settings: { system_settings, api_configurations, model_assignments } }, metadata: { export_options: options } }`（`commands.rs:6607-6639`）。`include_settings=false` 时 `system_settings={}`、`api_configurations=[]`、`model_assignments=null`。
- [x] 错误：AppError::database：读取 settings 失败统一 `读取设置失败: {e}`；`get_api_configs` 失败 `导出API配置失败: {e}`；`get_model_assignments` 失败 `导出模型分配失败: {e}`（`commands.rs:6580-6605`）。Electron 原样保留前缀；settings/LLM 服务未接线时以同样前缀报告服务不可用。
- [x] 事件：无。
- [x] DB 读写：只读主库 `settings` 表（`SELECT key, value FROM settings`，`commands.rs:6578-6595`）；不写库。Electron 经 F4 `ctx.settings.listByPrefix('')` 读取，值保持字符串。
- [x] 取消/并发：无事务、无写锁；顺序读取 settings → API 配置 → 模型分配。Electron 同样顺序 await，不引入事务。
- [x] 时间/ID：`chrono::Utc::now().to_rfc3339()`（AutoSi：0/3/6/9 位小数，时区 `+00:00`）。Electron `rfc3339Now` 用纳秒时钟复刻；F4 发布 `host/platform/time` 后改为引用平台模块。无 ID。

## 命令 `get_app_data_dir`

<!-- BEGIN GENERATED:cmd:get_app_data_dir -->
- Rust：`src-tauri/src/commands.rs:562` · async
- 前端：app（1 处，例 `src/utils/systemApi.ts:296`）
- 契约：`contracts/ipc/F2-shell.json`
  - 参数：（无）
  - 结果：string · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:get_app_data_dir -->

- [x] 输入：无参数；Rust 注入 `State<'_, AppState>`（`src-tauri/src/commands.rs:563`），读取 `file_manager.get_app_data_dir()`。
- [x] 输出：应用数据目录的绝对路径字符串（`to_string_lossy`，`commands.rs:564-568`）；Electron 返回 `ctx.app.dataDir`，其定义与 Tauri `app_data_dir()` 相同（`host/kernel/api.ts` 的 `AppInfo`），启动时由 `PathResolver`/`DS_APP_DATA_DIR` 解析（`electron/main.ts:119-120,186`）。
- [x] 错误：Rust 恒 `Ok`（lossy 转换不失败）；Electron 命令本身无错误，无法解析目录会在启动阶段直接失败（`electron/main.ts:120`）。
- [x] 事件：无。
- [x] DB 读写：无。
- [x] 取消/并发：只读启动期解析结果，无锁或可变状态。
- [x] 时间/ID：无。

## 命令 `get_app_version`

<!-- BEGIN GENERATED:cmd:get_app_version -->
- Rust：`src-tauri/src/commands.rs:499` · async
- 前端：app（1 处，例 `src/utils/systemApi.ts:307`）
- 契约：`contracts/ipc/F2-shell.json`
  - 参数：（无）
  - 结果：string
<!-- END GENERATED:cmd:get_app_version -->

- [x] 输入：无参数（契约 `args` 为空）；Rust `src-tauri/src/commands.rs:499-507` 只读编译期常量。
- [x] 输出：`"{CARGO_PKG_VERSION} (Build {BUILD_NUMBER}, {GIT_HASH})"`（`commands.rs:501-506`）；WP-006 将 `electron/index.ts` 改为返回启动时取得的 `getAppVersion()` 完整字符串，main 的 `app.fullVersion` 复用同一来源。`build-info.ts` 使用 package.json 的应用版本（Rust build.rs:102-139 强制其等于 Cargo/tauri 版本），打包读取既有 `electron/.build/version.json`，开发态沿用 build.rs 的构建号公式与 8 位 Git hash。不使用 headless 握手的占位 version，不丢 Build/commit。
- [x] 错误：Rust 返回 String，无 Result/Err。命令不发 Shell 请求、不添加 CommandError；构建元数据的既有验证失败仍是装载阶段失败，不伪造成业务 Err 或成功占位值。
- [x] 事件：无。
- [x] DB 读写：无。
- [x] 取消/并发：只读编译期常量，无共享状态，可并发调用。
- [x] 时间/ID：无运行时时间或业务 ID；版本/构建号/Git 短哈希均为构建期常量。

### WP-006：无 Shell 与真实桌面的语义边界

- 版本在插件安装时读取并保留为字符串，调用阶段无 IO/日志/事件/数据库或取消点；main 的旧 op 保留供既有桥接调用者使用。Node headless 的生产命令回归 `electron/tests/app-version.test.ts` 在 debug/release 两种模式均不提供 Shell，断言精确完整字符串及零 Shell 请求。
- 复用 `electron/tests/shell-real-host.test.ts`：真实 renderer → preload → main → 官方 Host/profile/ACL/HostReady；新增版本精确值断言。原 PDF/filestream 允许目录、空路径 false、两次 restart/零次 exit、purge 未重启错误与 marker 断言原样保留。仅隔离最终 OS hooks，不实际重启环境。
- 复用 `shell-restart-host.test.ts` 与协议 fixture，增补 `app.fullVersion` 精确字符串断言；它只证明真实 main/MessagePort 路由，真实业务 Host 的证据以上一条为准。

| 命令 | Rust 契约与分支 | headless 缺 Shell 的现行归属 |
|---|---|---|
| get_app_version | commands.rs:500-507，无参数、无 AppHandle、String、无 Err/日志 | 原 F2 不必要的 `app.fullVersion` 请求已移除；构建元数据可独立读取 |
| restart_app | dstu-storage/src/data_space.rs:2611-2613，注入 AppHandle 后 `app.restart()`，unit、无 Err/日志 | F3 `host/platform/storage/index.ts:246` await `plugin:process\|restart`，缺桥抛 ShellError；不能改成 CommandError（契约无 error），也不能返回成功替身。需 C1/C2 确定 headless 能力前提/探针分类；F2 不改 F3 |
| filestream_check_access | dstu-vfs/src/file_stream_protocol.rs:719-741，Result<bool,String> 但函数中无 Err；canonicalize 失败/目录不允许/隐藏段/不允许扩展/非常规文件均 Ok(false) | L13b `src/filestream.ts:40-44` 先 realpath（缺文件直接 false），仅可解析路径才请求 `app.pdfStreamAllowedDirs`。缺桥的 ShellError 不是已证明的路径不可达；不能 catch 全部转 false。是否定义额外 headless 错误由 C1/C2 与 L13b 裁定，不因 schema 允许 string 就发明原 Rust 不存在的业务错误 |

- `pdf_protocol.rs:259-299` 的目录来自 AppHandle path resolver（个别目录解析失败跳过；canonicalize 失败保留原根；附加真实 VFS blobs）；缺整个 main 不是同一条件。F2 main 提供 OS 根，Host 消费方加其真实 blobs 根。
- F1 `shell.ts:36-65`：未连接直接 ShellError；连接但负回复/超时同样 reject。`API.md` §2.3/§9 规定一般异常在测试宿主为 HandlerPanic，生产不回业务 result、记录日志；这是传输/运行前提失败，X1 无 Shell panic 不能据此签为 GUI 损坏。原 Rust 强制注入 AppHandle，无“未连接 Electron main”分支。
- 本包不改上述两条消费者、F1 错误规则或冻结契约。C1/C2 接收这份边界证据，真实窗口验证不外推为实际 OS relaunch 或三平台打包验证。

## 命令 `get_file_size`

<!-- BEGIN GENERATED:cmd:get_file_size -->
- Rust：`src-tauri/src/commands.rs:4193` · async
- 前端：app（10 处，例 `src/components/shared/UnifiedDragDropZone.tsx:459`）
- 契约：`contracts/ipc/F2-shell.json`
  - 参数：path: string
  - 结果：integer(u64) · 错误：AppError · 注入：window
<!-- END GENERATED:cmd:get_file_size -->

- [x] 输入：`path: String`；命令层先 `deny_hidden_local_path` 再读取（`src-tauri/src/commands.rs:4193-4197`）。Electron `electron/index.ts` 的 `get_file_size` 同样先做隐藏路径判定。
- [x] 输出：本地路径返回 `metadata().len()`（u64）；虚拟 URI 在 Rust 走 `open_reader` 读到 EOF 计数（`unified_file_manager.rs:677-706`），桌面端没有该分支，Electron 直接报 `读取文件失败: {uri} (URL is not a valid path)`，本地返回 `statSync().size`。
- [x] 错误：隐藏路径段 → `Validation: 拒绝读取隐藏路径: {raw}`；本地 metadata 失败 → `获取文件信息失败: {path} ({io})`；虚拟 URI 打开失败 → `读取文件失败: … (URL is not a valid path)`（`unified_file_manager.rs:116-136,677-706`）。Electron 文案一致（`electron/file-ops.ts`）。
- [x] 事件：无。
- [x] DB 读写：无。
- [x] 取消/并发：无锁、无取消检查；只读 metadata，可并发调用。
- [x] 时间/ID：无。

## 命令 `get_prevent_sleep`

<!-- BEGIN GENERATED:cmd:get_prevent_sleep -->
- Rust：`src-tauri/src/cmd/power.rs:77` · sync
- 前端：app（1 处，例 `src/features/anki-tasks/AnkiTasksApp.tsx:203`）
- 契约：`contracts/ipc/F2-shell.json`
  - 参数：（无）
  - 结果：boolean · 错误：string
<!-- END GENERATED:cmd:get_prevent_sleep -->

- [x] 输入：无参数（`src-tauri/src/cmd/power.rs:77`）。
- [x] 输出：当前防休眠生效（子进程仍存活）返回 `true`；子进程已退出会清理后返回 `false`；Windows 恒 `false`（`power.rs:78-104`）。Electron `get()` 以 `exitCode`/`signalCode` 均为 `null` 判定存活（`electron/power.ts:8,34`）。
- [x] 错误：字符串错误；锁中毒 → `sleep guard lock poisoned: {e}`（`power.rs:80-81`）。Electron 无锁中毒路径。
- [x] 事件：无。
- [x] DB 读写：无。
- [x] 取消/并发：Rust 同步 `Mutex` 串行化；Electron `set` 走 promise 串行链、`get` 直接读单变量，不阻塞（`electron/power.ts:35-39`）。
- [x] 时间/ID：无。

## 命令 `hash_file`

<!-- BEGIN GENERATED:cmd:hash_file -->
- Rust：`src-tauri/src/commands.rs:4259` · async
- 前端：none
- 契约：`contracts/ipc/F2-shell.json`
  - 参数：path: string
  - 结果：string · 错误：AppError · 注入：window
<!-- END GENERATED:cmd:hash_file -->

- [x] 输入：`path: String`；命令层不调用 `deny_hidden_local_path`（`src-tauri/src/commands.rs:4259-4262`），只做 `classify_path`（`unified_file_manager.rs:711-716`）。Electron `electron/file-ops.ts` 同样不拒绝隐藏路径，仅按 `hash_file` 的 Rust 行为分类路径。
- [x] 输出：小写十六进制 SHA-256（`format!("{:x}", digest)`，`unified_file_manager.rs:728-729`）；Electron 用 `createHash('sha256').digest('hex')`，64KiB 流式读取。
- [x] 错误：打开/读取失败 → `FileSystem: 读取文件失败: {path} ({io})`（`unified_file_manager.rs:715-725`）。Electron 同文案。
- [x] 事件：无。
- [x] DB 读写：无。
- [x] 取消/并发：无 CancellationToken；流式只读，无共享状态。
- [x] 时间/ID：无。

## 命令 `install_apk`

<!-- BEGIN GENERATED:cmd:install_apk -->
- Rust：`src-tauri/src/commands.rs:532` · async
- 前端：app（1 处，例 `src/hooks/useAppUpdater.ts:597`）
- 契约：`contracts/ipc/F2-shell.json`
  - 参数：path: string
  - 结果：null · 错误：AppError · 注入：app-handle
<!-- END GENERATED:cmd:install_apk -->

- [x] 输入：`path: String`（`src-tauri/src/commands.rs:532`）；仅 Android 使用，桌面端忽略该参数。
- [x] 输出：Android 成功返回 `null`（`commands.rs:540-551`）；桌面端 `Err(AppError::unknown)`，message 为 `install_apk is only supported on Android`（`commands.rs:556-559`）。
- [x] 错误：Android 插件未初始化 → `AppError::unknown("apk-installer 插件未初始化")`；`spawn_blocking` join 失败 → `install task join error: {e}`；插件调用失败 → `无法调起系统安装器: {e}`（`commands.rs:545-555`）。Electron 桌面分支直接抛 `{ error_type: "Unknown", message: "install_apk is only supported on Android", details: null }`（`electron/index.ts`）。
- [x] 事件：无。
- [x] DB 读写：无。
- [x] 取消/并发：Android 用 `spawn_blocking` 等待 Kotlin 回调；桌面端立即返回错误；无共享状态。
- [x] 时间/ID：无。

## 命令 `load_webview_settings`

<!-- BEGIN GENERATED:cmd:load_webview_settings -->
- Rust：`src-tauri/src/commands.rs:7508` · async
- 前端：none
- 契约：`contracts/ipc/F2-shell.json`
  - 参数：（无）
  - 结果：Value · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:load_webview_settings -->

- [x] 输入：无参数。
- [x] 输出：文件不存在 → `{ exists: false, settings: null }`；存在 → `{ exists: true, settings: <JSON> }`（`commands.rs:7509-7544`）。
- [x] 错误：AppError::file_system `读取 WebView 设置文件失败: {e}`；AppError::validation `解析 WebView 设置失败: {e}`（`commands.rs:7528-7535`）。Rust `Path::exists()` 失败一律按不存在处理，Electron 用 `stat` 的任意失败复刻。
- [x] 事件：无。
- [x] DB 读写：无。
- [x] 取消/并发：直接 `fs::read_to_string`；无锁/事务。Electron `readFile` 语义一致。
- [x] 时间/ID：无。文件路径 = `FileManager::get_writable_app_data_dir()/webview_settings.json`（`commands.rs:7520-7522`）；Electron 优先 `ctx.storage.locations.activeDir`，未接线时 `ctx.app.dataDir`。

## 命令 `open_file_externally`

<!-- BEGIN GENERATED:cmd:open_file_externally -->
- Rust：`src-tauri/src/external_file_opener.rs:176` · async
- 前端：app（1 处，例 `src/utils/systemFileOpener.ts:38`）
- 契约：`contracts/ipc/F2-shell.json`
  - 参数：path: string, mode?: string | null
  - 结果：string · 错误：AppError · 注入：app-handle
<!-- END GENERATED:cmd:open_file_externally -->

- [x] 输入：`path: String`、`mode: Option<String>`（`src-tauri/src/external_file_opener.rs:176-180`）；`mode` 先 `trim`：缺省/`""`/`"view"` → `View`，`"share"` → `Share`，其他 → `AppError::validation("不支持的打开方式: {other}")`（`external_file_opener.rs:90-99`）。
- [x] 输出：Android 返回实际动作字符串，优先取 Kotlin 响应的 `action`，缺省回退 `mode.as_str()`（`external_file_opener.rs:233-237`）；桌面端恒 `Err(AppError::validation("open_file_externally is only supported on Android"))`（`external_file_opener.rs:239-245`）。
- [x] 错误：先解析 `mode` 再做平台分支，非法 mode 在桌面端也先报 `Validation`；Android 另有 `NotFound`（文件不存在）、`Validation`（目录/越界）、`FileSystem`（复制/缓存目录）与 `Unknown`（插件调用失败）。Electron 先 `parseExternalOpenMode` 再抛同文案 `Validation`（`electron/index.ts`）。
- [x] 事件：无。
- [x] DB 读写：无。
- [x] 取消/并发：Android 在 `spawn_blocking` 中规范化路径、复制分享副本并清理过期副本（`external_file_opener.rs:183-224`），无异步取消点；桌面端不触碰文件系统。
- [x] 时间/ID：Android 分享副本目录名用 UUID v4（`external_file_opener.rs:157-158`），保留 24 小时 TTL（`external_file_opener.rs:36`）；桌面端无。

## 命令 `open_system_permission_settings`

<!-- BEGIN GENERATED:cmd:open_system_permission_settings -->
- Rust：`src-tauri/src/system_permissions.rs:129` · async
- 前端：none
- 契约：`contracts/ipc/F2-shell.json`
  - 参数：permission: SystemPermissionSettingsTarget
  - 结果：null · 错误：string
<!-- END GENERATED:cmd:open_system_permission_settings -->

- [x] 输入：`permission: SystemPermissionSettingsTarget`，serde 枚举 `notifications` / `microphone`（`src-tauri/src/system_permissions.rs:9-16`）；契约枚举校验拒绝其他值（serde `unknown variant` 文本）。
- [x] 输出：成功 `null`（`system_permissions.rs:129-135`）。
- [x] 错误：错误类型为字符串。macOS `/usr/bin/open` 启动失败 → `Failed to launch macOS System Settings: {error}`，退出码非 0 → `macOS System Settings launcher exited with status {status}`（`system_permissions.rs:76-90`）；Windows 启动失败 → `Failed to launch Windows Settings: {error}`（`system_permissions.rs:93-107`）；Linux 固定 `This desktop environment does not provide a portable permission-settings shortcut`（`system_permissions.rs:109-115`）。Electron 同文案与分支（`electron/system-permissions.ts`）。
- [x] 事件：无。
- [x] DB 读写：无。
- [x] 取消/并发：Rust 在 `spawn_blocking` 中执行；macOS 等待 `/usr/bin/open` 退出，Windows `spawn` 后立即返回（`system_permissions.rs:129-135`）；无共享状态。
- [x] 时间/ID：无时间戳或业务 ID；macOS 用 `sw_vers -productVersion` 主版本选择 Ventura 前后 URI（`system_permissions.rs:64-74`），探测失败按 modern 处理。

## 命令 `pdfstream_check_access`

<!-- BEGIN GENERATED:cmd:pdfstream_check_access -->
- Rust：`src-tauri/src/commands.rs:4212` · async
- 前端：app（2 处，例 `src/features/learning-hub/apps/views/TextbookContentView.tsx:256`）
- 契约：`contracts/ipc/F2-shell.json`
  - 参数：path: string
  - 结果：PdfStreamAccess · 错误：AppError · 注入：app-handle
<!-- END GENERATED:cmd:pdfstream_check_access -->

- [x] 输入：`path: string`（`commands.rs:4214-4216`）。
- [x] 输出：`PdfStreamAccess { available, size, reason }`。成功 `{available:true,size:metadata.len(),reason:null}`；失败均为 `available:false,size:null,reason`（`commands.rs:4217-4263`）。
- [x] 错误：不抛错，`reason` 文案逐字保留：`文件不存在或不可读: {io}`、`路径不在 pdfstream 白名单目录内`、`非 PDF 文件`、`路径不是常规文件`。Electron `electron/pdfstream-access.ts` 按同一顺序（canonicalize → 白名单 → `.pdf` 大小写不敏感 → `is_file`）返回。
- [x] 事件：无。
- [x] DB 读写：无；只读文件元数据。
- [x] 取消/并发：同步文件系统调用，无锁/事务。
- [x] 时间/ID：无时间；白名单目录与 Rust `resolve_allowed_dirs` 相同（app data/local/cache/documents/downloads/temp/resources/desktop/pictures + VFS blobs；`pdf_protocol.rs:259-299`）。Electron 由 main `app.pdfStreamAllowedDirs` 提供前 9 项，Host 追加 `ctx.get('vfsDatabase').blobsDir()`。`path_is_within` 的 Windows verbatim/大小写/组件边界语义在 `pathIsWithin` 中复刻。

## 命令 `read_file_bytes`

<!-- BEGIN GENERATED:cmd:read_file_bytes -->
- Rust：`src-tauri/src/commands.rs:4171` · async
- 前端：app（10 处，例 `src/components/crepe/features/imageUpload.ts:435`）
- 契约：`contracts/ipc/F2-shell.json`
  - 参数：path: string, maxBytes?: integer(u64) | null
  - 结果：Response · 错误：AppError · 注入：window
<!-- END GENERATED:cmd:read_file_bytes -->

- [x] 输入：`path: String` + `maxBytes: Option<u64>`；`limit = max_bytes.unwrap_or(200MiB).min(200MiB)`，调用方只能收紧（`src-tauri/src/commands.rs:4166-4179`）。Electron `electron/file-ops.ts` 使用同一 `min` 公式。
- [x] 输出：Rust 返回 `tauri::ipc::Response` 原始字节（契约 `x-binary`，前端收 ArrayBuffer）。Host 协议只传 JSON，Electron 用显式信封 `{ __dstuRawBytes: base64 }`（`electron/raw-bytes.ts`），`electron/shell/runtime.ts` 在回写 renderer 前解码为 `Uint8Array`，前端仍得到原始字节。
- [x] 错误：先 `deny_hidden_local_path`（Validation）；本地 metadata 失败 → `获取文件信息失败: {path} ({io})`；预检超限 → `文件过大: {len} 字节，超过读取上限 {limit} 字节: {path}`；流式读取超过上限 → `文件过大: 超过读取上限 {limit} 字节: {path}`；读取失败 → `读取文件失败: …`；`spawn_blocking` join 失败 → `读取任务异常终止: {e}`（`commands.rs:4181-4189`、`unified_file_manager.rs:206-245`）。Electron 无独立 blocking 线程，因此没有 join 错误分支。
- [x] 事件：无。
- [x] DB 读写：无。
- [x] 取消/并发：无 CancellationToken；Rust 的 `take(limit + 1)` 防 TOCTOU 增长由 Electron 流式累计并再次校验上限复刻（`electron/file-ops.ts`）。
- [x] 时间/ID：无。

## 命令 `read_file_text`

<!-- BEGIN GENERATED:cmd:read_file_text -->
- Rust：`src-tauri/src/commands.rs:4149` · async
- 前端：app（2 处，例 `src/utils/chatApi.ts:73`）
- 契约：`contracts/ipc/F2-shell.json`
  - 参数：path: string
  - 结果：string · 错误：AppError · 注入：window
<!-- END GENERATED:cmd:read_file_text -->

- [x] 输入：`path: String`；命令层先 `deny_hidden_local_path`，再 `read_to_string`（`src-tauri/src/commands.rs:4149-4152`）。Electron `electron/index.ts` 的 `read_file_text` 同序。
- [x] 输出：UTF-8 字符串；`read_all_bytes` 没有大小上限（`unified_file_manager.rs:189-197,247-250`）。Electron 用 `TextDecoder('utf-8', { fatal: true })`，非法字节 → `FileSystem: 文件编码不是有效的 UTF-8`。
- [x] 错误：隐藏路径段 → `Validation: 拒绝读取隐藏路径: {raw}`；打开/读取失败 → `FileSystem: 读取文件失败: {path} ({io})`（`unified_file_manager.rs:116-136,189-197`）。Electron 文案一致（`electron/file-ops.ts`）。
- [x] 事件：无。
- [x] DB 读写：无。
- [x] 取消/并发：无 CancellationToken；整文件读入内存，无共享状态。
- [x] 时间/ID：无。

## 命令 `save_text_to_file`

<!-- BEGIN GENERATED:cmd:save_text_to_file -->
- Rust：`src-tauri/src/commands.rs:4271` · async
- 前端：app（1 处，例 `src/utils/settingsApi.ts:125`）
- 契约：`contracts/ipc/F2-shell.json`
  - 参数：path: string, content: string
  - 结果：null · 错误：AppError · 注入：window
<!-- END GENERATED:cmd:save_text_to_file -->

- [x] 输入：`path: String`、`content: String`；`classify_path` 后 `open_writer(truncate = true)`（`src-tauri/src/commands.rs:4271-4274`、`unified_file_manager.rs:140-177,373-385`），不调用 `deny_hidden_local_path`。
- [x] 输出：`()`（命令返回 `null`）。
- [x] 错误：父目录创建失败 → `创建目录失败: {parent} ({io})`；打开及 write_all 失败 → `写入文件失败: {path} ({io})`；flush 失败 → `刷新文件失败: {path} ({io})`（`unified_file_manager.rs:146-164,375-383`）。Electron `electron/file-ops.ts` 使用同文案（close/flush 阶段映射为刷新失败）。
- [x] 事件：无。
- [x] DB 读写：无。
- [x] 取消/并发：无 CancellationToken；以 truncate 打开，最后写入者胜出。
- [x] 时间/ID：无。

## 命令 `save_webview_settings`

<!-- BEGIN GENERATED:cmd:save_webview_settings -->
- Rust：`src-tauri/src/commands.rs:7475` · async
- 前端：app（1 处，例 `src/utils/systemApi.ts:94`）
- 契约：`contracts/ipc/F2-shell.json`
  - 参数：settings: Value
  - 结果：Value · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:save_webview_settings -->

- [x] 输入：`settings: serde_json::Value`（`commands.rs:7477-7480`）。
- [x] 输出：`{ success: true, path, size }`，`size` 为 UTF-8 字节数（`commands.rs:7497-7501`）。
- [x] 错误：AppError::validation `序列化 WebView 设置失败: {e}`；AppError::file_system `写入 WebView 设置文件失败: {e}`（`commands.rs:7487-7492`）。
- [x] 事件：无。
- [x] DB 读写：无。
- [x] 取消/并发：`serde_json::to_string_pretty` + `fs::write` 直接覆盖；无临时文件/锁。Electron `JSON.stringify(settings, null, 2)` + `writeFile` 一致。
- [x] 时间/ID：无。路径 = `get_writable_app_data_dir()/webview_settings.json`（`commands.rs:7483-7485`）；Electron 同 `load_webview_settings`。

## 命令 `set_android_immersive_mode`

<!-- BEGIN GENERATED:cmd:set_android_immersive_mode -->
- Rust：`src-tauri/src/system_bars.rs:43` · async
- 前端：app（1 处，例 `src/utils/androidImmersiveMode.ts:27`）
- 契约：`contracts/ipc/F2-shell.json`
  - 参数：enabled: boolean
  - 结果：null · 错误：AppError · 注入：app-handle
<!-- END GENERATED:cmd:set_android_immersive_mode -->

- [x] 输入：`enabled: boolean`（`src-tauri/src/system_bars.rs:43-44`）。
- [x] 输出：Android 成功返回 `null`；非 Android 直接 `Ok(())`，同样返回 `null`（`system_bars.rs:75-78`）。
- [x] 错误：Android 插件未初始化 → `AppError::unknown("system-bars 插件未初始化")`；`spawn_blocking` join 失败 → `immersive task join error: {e}`；插件调用失败 → `切换沉浸式全屏失败: {e}`（`system_bars.rs:58-72`）。桌面端无错误。Electron 恒返回 `null`（`electron/index.ts`）。
- [x] 事件：无。
- [x] DB 读写：无。
- [x] 取消/并发：Android 在 `spawn_blocking` 中等待 Kotlin 回调；桌面端同步空操作；无共享状态。
- [x] 时间/ID：无。

## 命令 `set_backend_sentry_enabled`

<!-- BEGIN GENERATED:cmd:set_backend_sentry_enabled -->
- Rust：`src-tauri/src/lib.rs:330` · async
- 前端：none
- 契约：`contracts/ipc/F2-shell.json`
  - 参数：enabled: boolean
  - 结果：boolean · 错误：string · 注入：state, state
<!-- END GENERATED:cmd:set_backend_sentry_enabled -->

- [x] 输入：`enabled: boolean`（`lib.rs:331-336`）。
- [x] 输出：先持久化 `sentry_error_reporting_enabled = enabled.to_string()`；enabled 时返回 guard 是否已初始化，disabled 时关闭 guard 并返回 `false`（`lib.rs:338-366`）。
- [x] 错误：字符串错误 `保存错误报告授权失败: {e}`（`lib.rs:341-344`）；spawn_blocking join 失败 `更新错误报告授权任务失败: {e}`。Electron `electron/backend-sentry.ts` 对保存失败保留前缀；关闭/初始化异常按 Rust 的 warn/`None` 语义记录日志而不改变返回值。
- [x] 事件：无。
- [x] DB 读写：写主库 settings 表一个键（`database.save_setting`，`lib.rs:342-344`）。
- [x] 取消/并发：Rust `Mutex<Option<ClientInitGuard>>` 串行化整个临界区；Electron 用 promise 串行链复刻，重复 enabled 只初始化一次。
- [x] 时间/ID：无时间戳/ID。`init` 读取 `SENTRY_DSN`（环境变量或编译期），release 来自 `SENTRY_RELEASE` / `ctx.app.version`。当前 `package.json` 未声明 `@sentry/node`，生产默认实现会在 DSN 合法但 SDK 缺失时记录 warn 并返回 false（与 Rust DSN 缺失分支一致）；补依赖后自动启用（报告列为待协调者安装）。

## 命令 `set_prevent_sleep`

<!-- BEGIN GENERATED:cmd:set_prevent_sleep -->
- Rust：`src-tauri/src/cmd/power.rs:26` · sync
- 前端：app（2 处，例 `src/features/anki-tasks/AnkiTasksApp.tsx:209`）
- 契约：`contracts/ipc/F2-shell.json`
  - 参数：enabled: boolean
  - 结果：boolean · 错误：string
<!-- END GENERATED:cmd:set_prevent_sleep -->

- [x] 输入：`enabled: boolean`（`src-tauri/src/cmd/power.rs:26-27`）。
- [x] 输出：开启成功（或已有存活子进程）返回 `true`；关闭返回 `false`；Windows 恒 `false`（`power.rs:29-75`）。Electron 同样幂等（`electron/power.ts:9-32`）。
- [x] 错误：字符串错误；锁中毒 → `sleep guard lock poisoned: {e}`；启动抑制进程失败 → `failed to spawn caffeinate: {e}` / `failed to spawn systemd-inhibit: {e}`（`power.rs:29-31,107-135`）。Electron 以 `formatIoError` 复刻 `{message} (os error {code})` 文本（`electron/power.ts:19`）。
- [x] 事件：无。
- [x] DB 读写：无。
- [x] 取消/并发：Rust 同步 `Mutex` 保护单个 `Child`，重复开启不叠加；Electron 用 promise 串行链保证同样顺序，关闭时 `SIGKILL` 并等待 `exit`（`electron/power.ts:24-30`）。
- [x] 时间/ID：抑制子进程参数绑定当前进程 PID（macOS `-w <pid>`、Linux `tail --pid=<pid>`，`power.rs:107-135`），Electron 用 `process.pid`；无时间戳。

## 命令 `set_sidebar_vibrancy`

<!-- BEGIN GENERATED:cmd:set_sidebar_vibrancy -->
- Rust：`src-tauri/src/cmd/window_effects.rs:171` · async
- 前端：app（2 处，例 `src/components/TopLevelFallback.tsx:112`）
- 契约：`contracts/ipc/F2-shell.json`
  - 参数：enabled: boolean
  - 结果：boolean · 错误：AppError · 注入：webview-window
<!-- END GENERATED:cmd:set_sidebar_vibrancy -->

- [x] 输入：`enabled: boolean`（`src-tauri/src/cmd/window_effects.rs:171-172`）。
- [x] 输出：macOS 开启成功 `true`、关闭成功 `false`（`window_effects.rs:174-217`）；非 macOS 恒 `false`（`window_effects.rs:219-223`）。Electron 非 darwin 返回 `false`，darwin 按 `setVibrancy('sidebar' | null)` 返回 `enabled === true`（`electron/index.ts`、`electron/main.ts`）。
- [x] 错误：`AppError::internal`（error_type `Unknown`）：调度主线程失败 → `调度主线程失败: {e}`；3 秒内无结果 → `等待 vibrancy 结果失败: {e}`；`apply_vibrancy`/`clear_vibrancy` 失败原样包装（`window_effects.rs:193-214`）。Electron 以 `{ error_type: "Unknown", message, details: null }` 包装（`electron/index.ts`）。
- [x] 事件：无。
- [x] DB 读写：无。
- [x] 取消/并发：Tauri `run_on_main_thread` 串行执行并等待 mpsc 结果（超时 3 秒，`window_effects.rs:196-209`）；Electron 在 main 进程同步调用 `setVibrancy`，无并发窗口。
- [x] 时间/ID：Rust 有 3 秒等待超时；Electron 无超时需求（同步调用），无时间戳或 ID。

## 命令 `set_window_appearance`

<!-- BEGIN GENERATED:cmd:set_window_appearance -->
- Rust：`src-tauri/src/cmd/window_effects.rs:214` · async
- 前端：app（1 处，例 `src/utils/sidebarTranslucency.ts:31`）
- 契约：`contracts/ipc/F2-shell.json`
  - 参数：dark: boolean
  - 结果：null · 错误：AppError · 注入：webview-window
<!-- END GENERATED:cmd:set_window_appearance -->

- [x] 输入：`dark: boolean`（`window_effects.rs:215-218`）。
- [x] 输出：非 macOS no-op 返回 null；macOS 成功返回 null（`window_effects.rs:217-265`）。Electron 在 main 进程同步调用 `NSAppearance appearanceNamed:` + `[ns_window setAppearance:]`（`electron/shell/native-window.ts`），Host 命令经 `window.setAppearance` 转给 main。
- [x] 错误：`AppError::internal`（error_type `Unknown`）：`获取 macOS 窗口外观失败`、`获取 NSWindow 失败`；另有调度失败 `调度主线程失败: {e}` / 超时 `等待窗口外观同步结果失败: {e}`（Rust 异步调度）。Electron 在 main 同步执行，前两条逐字保留；调度/超时分支不存在。
- [x] 事件：无。
- [x] DB 读写：无。
- [x] 取消/并发：Cocoa 主线程调用；Host 侧每个 invoke 独立，无共享状态。
- [x] 时间/ID：Rust 有 3 秒 mpsc 超时；Electron 同步调用无超时，无时间戳/ID。

## 命令 `sync_titlebar_sidebar_material`

<!-- BEGIN GENERATED:cmd:sync_titlebar_sidebar_material -->
- Rust：`src-tauri/src/cmd/window_effects.rs:270` · async
- 前端：app（1 处，例 `src/utils/sidebarTranslucency.ts:45`）
- 契约：`contracts/ipc/F2-shell.json`
  - 参数：enabled: boolean, width: number
  - 结果：null · 错误：AppError · 注入：webview-window
<!-- END GENERATED:cmd:sync_titlebar_sidebar_material -->

- [x] 输入：`enabled: boolean, width: number`（`window_effects.rs:271-275`）。
- [x] 输出：非 macOS no-op 返回 null；macOS 同步标题栏材质后返回 null（`window_effects.rs:273-310`）。
- [x] 错误：`AppError::internal`（error_type `Unknown`）：`找不到 macOS 标题栏关闭按钮`、`关闭按钮缺少 superview`、`标题栏容器 superview 缺失`、`创建 NSVisualEffectView 失败`、`获取 NSWindow 失败`（`window_effects.rs:108-165,281-305`）；Rust 调度/超时文案不适用于同步 Electron main 调用。
- [x] 事件：无。
- [x] DB 读写：无。
- [x] 取消/并发：Cocoa 主线程；每次调用先查找并移除 identifier 为 `com.deepstudent.titlebar-sidebar-material` 的旧视图，再按需创建，重复调用幂等。
- [x] 时间/ID：无。视图类 `DeepStudentTitlebarSidebarMaterialView` 覆盖 `isOpaque`→NO、`hitTest:`→nil；材质 Sidebar(7)、BlendingMode BehindWindow(0)、State FollowsWindowActiveState(0)、autoresizing HeightSizable|MaxXMargin、frame `{0,0,min(width,bounds.width),bounds.height}`、`addSubview:positioned:relativeTo:` Below(nil) 均逐字复刻（`window_effects.rs:15-30,91-166`）。

## 命令 `updater_install_supported`

<!-- BEGIN GENERATED:cmd:updater_install_supported -->
- Rust：`src-tauri/src/commands.rs:515` · sync
- 前端：app（1 处，例 `src/hooks/useAppUpdater.ts:483`）
- 契约：`contracts/ipc/F2-shell.json`
  - 参数：（无）
  - 结果：boolean
<!-- END GENERATED:cmd:updater_install_supported -->

- [x] 输入：无参数（`src-tauri/src/commands.rs:514-515`）。
- [x] 输出：Linux 上 `APPIMAGE` 环境变量存在返回 `true`，否则 `false`；其他平台恒 `true`（`commands.rs:516-528`）。Electron 为 `platform !== 'linux' || process.env.APPIMAGE !== undefined`（`electron/index.ts`）。
- [x] 错误：无错误路径。
- [x] 事件：无。
- [x] DB 读写：无。
- [x] 取消/并发：只读环境变量，无共享状态。
- [x] 时间/ID：无。

## 事件 `backup-jobs-resumable`

<!-- BEGIN GENERATED:event:backup-jobs-resumable -->
- 事件名 `backup-jobs-resumable`
- 发送点：`src-tauri/src/lib.rs:1445`（emit）
<!-- END GENERATED:event:backup-jobs-resumable -->

- [x] 载荷：`PersistedJob[]`（`contracts/ipc/F2-shell.json` 的 `backup-jobs-resumable.payload`；Rust 直接发送 `&resumable`，`src-tauri/src/lib.rs:1445`）。仅当 `list_resumable_jobs()` 返回非空数组时发送，空数组不发事件。元素形状见 `_shared.json#/$defs/PersistedJob`（`job_id`/`kind`/`status`/`phase`/`progress`/`params`/`checkpoint` 等）。
- [x] 触发时机与顺序：应用 setup 阶段、data governance 初始化之后、`BackupJobManagerState` 注册为 Tauri State 之前（`src-tauri/src/lib.rs:1441-1455`）：构造 manager → `list_resumable_jobs()` → 非空则记录 info「发现 N 个可恢复的备份任务」并 emit → 随后无条件执行 `cleanup_finished_persisted_jobs()`（`lib.rs:1456`）。列出失败时静默跳过事件（`if let Ok`），清理失败同样被忽略（`let _`），均不阻止启动。
- [x] 节流/合并：无；每次进程启动最多一次。
- [x] 是否在事务提交后：不涉及数据库事务；读写的是持久化任务 JSON 文件（`host/plugins/backup/src/jobs.ts` 的 `loadPersistedJobs`/`deletePersistedJob`）。清理在事件之后执行。
- [x] 目标窗口（emit / emit_to / emit_filter）：`app_handle.emit` 广播到所有窗口（`AppHandle::emit`）；迁移后由 L21 用 `ctx.backendEvents.emit('backup-jobs-resumable', jobs)`（target `Any`）发出，F2 main 按 target 扇出到全部 webview。
- [x] 迁移落点（阻塞，L21）：`host/plugins/backup/api.ts` 已发布 `BackupJobManager.listResumableJobs()` / `cleanupFinishedPersistedJobs()`，但 `host/plugins/backup/index.ts` 的 `apply` 尚未在启动时调用它们发事件；F2 不修改其他 lane 的插件。详见「附：跨 lane 阻塞（F2 契约事件发射）」。

## 事件 `data-governance-migration-status`

<!-- BEGIN GENERATED:event:data-governance-migration-status -->
- 事件名 `data-governance-migration-status`
- 发送点：`src-tauri/src/lib.rs:1117`（emit）
- 发送点：`src-tauri/src/lib.rs:1133`（emit）
- 发送点：`src-tauri/src/lib.rs:1180`（emit）
- 发送点：`src-tauri/src/lib.rs:1212`（emit）
- 发送点：`src-tauri/src/lib.rs:1284`（emit）
<!-- END GENERATED:event:data-governance-migration-status -->

- [x] 载荷：五种形状（`contracts/ipc/F2-shell.json` 的 `events[]` union；对应 `src-tauri/src/lib.rs:1117,1133,1181,1212,1284`）：
  1. 迁移完全成功：`{ success: true, global_version, migrations_applied, duration_ms, warnings: [] }`；
  2. 迁移成功但有警告：同 1，但 `warnings` 为实际列表并增加 `has_warnings: true`；
  3. 恢复槽激活事务失败：`{ success: false, error, degraded_mode: true, maintenance_mode_forced: true, restore_activation_failed: true }`；
  4. 迁移失败后自动恢复到迁移前状态：`{ success: false, recovered: true, error, maintenance_mode_forced: true, message: "数据库升级失败，已恢复到升级前状态并进入只读维护模式。请先导出备份或更新应用后重试。" }`；
  5. 初始化失败（未恢复）：`{ success: false, error, degraded_mode: true, maintenance_mode_forced: <should_force_maintenance_mode_on_init_failure(e)> }`。
- [x] 触发时机与顺序：仅在应用启动的 data governance 初始化阶段发送。成功/带警告两种在 `initialize_with_report` 成功后、注册 `SchemaRegistry` 与审计库之前发送（`lib.rs:1117,1133`）；随后 `finalize_restore_activation` 返回 `Err` 时再补发第 3 种（`lib.rs:1181`）——因此一次启动可能先发成功/警告、再发恢复槽失败两条事件。`initialize_with_report` 返回 `RecoveredFromBackup` 时发第 4 种（`lib.rs:1212`），其他错误发第 5 种（`lib.rs:1284`）；两者都在持久化 `migration_error` 之后发送。日志同步记录：info「初始化完成」/warn「完成但有警告」/warn「恢复槽激活事务提交失败」/warn「已自动恢复」/warn「初始化失败（降级）」。
- [x] 节流/合并：无；每次启动按实际分支发送 1 条，成功后又遇恢复槽失败时发送 2 条。前端 `useMigrationStatusListener` 自己按 payload 去重（`src/hooks/useMigrationStatusListener.ts`）。
- [x] 是否在事务提交后：迁移结果事件在迁移完成后发送；恢复槽失败事件在 `finalize_restore_activation` 的事务失败返回后发送；事件本身不写数据库。失败时 Rust 先用 `persist_migration_error` 落盘错误，再发事件。
- [x] 目标窗口（emit / emit_to / emit_filter）：`app_handle.emit` 广播到所有窗口；迁移后由 L21 用 `ctx.backendEvents.emit('data-governance-migration-status', payload)`（target `Any`）发出，F2 main 按 target 扇出。
- [x] 迁移落点（阻塞，L21 + F3）：`src/data_governance`（含 `initialize_with_report`、恢复槽激活、维护模式）归 L21-backup-governance（`docs/dev/electron-migration/lanes.md:152`）；F3-storage 已发布 `MigrationService.runAll(): Promise<MigrationReport>`（`host/platform/storage/api.ts:343-346`）提供迁移计数/警告基础数据，但当前没有任何 Host 插件发送该事件。缺少的接口：L21 治理启动流程的最终结果（成功/警告/恢复槽失败/已恢复/降级 + 维护模式判定）——F2 main 无法访问 Host 服务，只能用命令/事件接口，故不能代为发送。详见「附：跨 lane 阻塞（F2 契约事件发射）」。

## 事件 `mcp_tools_changed`

<!-- BEGIN GENERATED:event:mcp_tools_changed -->
- 事件名 `mcp_tools_changed`
- 发送点：`src-tauri/src/lib.rs:3851`（emit）
<!-- END GENERATED:event:mcp_tools_changed -->

- [x] 载荷：`{ ts: string }`，`ts = chrono::Utc::now().to_rfc3339()`（`src-tauri/src/lib.rs:3851`；契约 `contracts/ipc/F2-shell.json` 的 `mcp_tools_changed.payload`，`additionalProperties: false`）。
- [x] 触发时机与顺序：`init_mcp_client` 成功初始化全局 MCP 客户端后注册 `client.on_event`；收到 `McpEvent::ToolsChanged`（JSON-RPC `notifications/tools/list_changed` 或 `tools/list_changed`，`host/plugins/mcp/src/client-dispatch.ts:127-129`）时先记录 info「tools/list_changed received → clearing LLMManager MCP tool cache」，再 emit（`lib.rs:3844-3853`）。同一通知每到达一次发一次。
- [x] 节流/合并：无节流、无合并。
- [x] 是否在事务提交后：不涉及数据库事务；只清空 LLMManager 的 MCP 工具缓存（由订阅方处理）。
- [x] 目标窗口（emit / emit_to / emit_filter）：`handle.emit` 广播到所有窗口；迁移后由 L19 用 `ctx.backendEvents.emit('mcp_tools_changed', { ts })`（target `Any`）发出，F2 main 按 target 扇出。
- [x] 迁移落点（L19，2026-11-05 更新）：main `host/plugins/mcp/index.ts:102-109` 已将 `HostMcpService.onToolsChanged` 接到同文 INFO 日志和 `ctx.backendEvents.emit('mcp_tools_changed', { ts: toRfc3339() })`，并调用 `startBackendMcp`。旧的“没有生产订阅”阻塞不再成立；`reload_mcp_client` 的兼容命令仍固定禁用，不能据此推断 setup 订阅同样禁用。F2 仅确认发射接线，完整 MCP 语义由 L19 与复核人签收。

## 事件 `name`

<!-- BEGIN GENERATED:event:expr:name -->
- 动态事件名（表达式）
- 发送点：`src-tauri/src/menu.rs:214`（emit）
<!-- END GENERATED:event:expr:name -->

- [x] 载荷：`()`，序列化为 `null`（`src-tauri/src/menu.rs:214-219`；Electron `electron/shell/menu.ts` 的 `emit(MENU_EVENTS[id])` 同样发送 `null`）。
- [x] 触发时机与顺序：点击自定义菜单项时按 `preferences`/`new_session`/`close_window`/`command_palette`/`toggle_sidebar`/`documentation`/`report_issue` 映射发出一个事件；预定义项（Cut/Copy/Paste/Quit 等）不发事件（`menu.rs:199-221`）。
- [x] 节流/合并：无；每次点击发一次。
- [x] 是否在事务提交后：不涉及数据库事务。
- [x] 目标窗口（emit / emit_to / emit_filter）：`app.emit` 广播到全部窗口（`menu.rs:216`）；Electron `runtime.emitJs` 按监听者广播到所有窗口。

## 附：跨 lane 阻塞（F2 契约事件发射）

F2 的 main 已实现通用转发：Host 的 `BackendEvent { event, payload, target }` 经 `HostSupervisor.onEvent` →
`runtime.emitTo(event.target, …)` 扇出到对应 webview（`electron/main.ts`，冒烟测试 `smoke://pong` 覆盖同一路径）。
`menu://*` 事件由 F2 自己完整实现。以下事件的**发射方**在 Rust 中位于 `lib.rs` setup / MCP 初始化，但迁移后
对应的业务状态归其他 lane 的 Host 插件所有；F2 不能读取 Host 服务，也不修改其他 lane 的文件，因此记录为真实阻塞：

| 事件 | 应由谁发射 | 缺什么 | 影响 |
|---|---|---|---|
| `backup-jobs-resumable` | L21-backup-governance（`host/plugins/backup`） | 在 `apply` 中调用已发布的 `backup.jobs.listResumableJobs()`，非空时 `ctx.backendEvents.emit('backup-jobs-resumable', jobs)`，随后 `cleanupFinishedPersistedJobs()`；无需新接口 | 前端 `DataGovernanceDashboard` 的「可恢复备份任务」提示不会出现（`src/features/settings/components/DataGovernanceDashboard.tsx:1713` 只监听） |
| `data-governance-migration-status` | L21-backup-governance（消费 F3-storage 的迁移报告） | 治理启动流程的最终结果与恢复槽激活/维护模式判定；按 SPEC 的五种 payload 在启动阶段 emit。F3 已有 `MigrationService.runAll(): Promise<MigrationReport>`（`host/platform/storage/api.ts:343-346`） | 迁移警告/失败通知不出现（`src/hooks/useMigrationStatusListener.ts:35` 只监听） |
| `mcp_tools_changed` | L19-mcp-browser（`host/plugins/mcp`） | main `index.ts:102-109` 已有生产订阅与 emit，不再列为缺失接口 | F2 确认通用转发可用，不代替 L19 完整签收 |

### 生产 profile 装配 `dstu.shell`（F1；分支已装配，main 状态需按提交核对）

`electron/index.ts` 是 F2 的 Host 插件（`meta.id = 'dstu.shell'`，注册本 lane 全部 23 个命令，
并提供 `startupGate` / `systemNotification`）。C2 核实的 F1 分支树（`597f9e2e1`）已在
`host/profiles/generate.ts` 的 `SHELL_PLUGINS` 中加入 `../electron/index.ts`，生成器用 `--check`
守护该条目，并校验真实仓库清单必须包含 `dstu.shell`（测试夹具无 `electron/` 时允许跳过）。

本轮再次核对：`git merge-base --is-ancestor 597f9e2e1 main` 与
`git merge-base --is-ancestor ddd54715a main` 均为 0，且 `main:host/profiles/desktop.json`
已包含：

```json
{ "id": "dstu.shell", "module": "../../electron/index.ts" }
```

因此按 quality §10.7 记录为「**已进入当前 main**（以本轮 `main` 提交为准）；C2 通知发出时仍写作
待集成，若后续 main 回退则重新核对」。打包配置为 `asar: false`，相对路径可解析到
`app/electron/index.ts`。F2 未修改 `host/profiles/`，由 F1 维护。

X2-frontend-contracts 在 main `9c13dfc39` 复核的结论与此一致：`642b3d6c4` 把
`dstu.shell → ../../electron/index.ts` 加入官方 profile，`ddd54715a` 在真实仓库生成时断言
`dstu.shell` 不能静默消失。本轮同时静态核对 `electron/index.ts` 的 23 条
`ctx.commands.register(...)` 与 X2 给出的 23 条声明逐项一致（无缺、无多）。
该证据只证明 **profile / meta 静态装配**；未动态执行全部插件 `apply`，未实际 invoke 这 23 条命令，
不能当作调用成功。服务依赖、错误路径与平台语义仍由 F2 测试和独立验收人验证。

### `startupGate` 与 D2 启动注册点（F3 / L21 / F1）

`electron/index.ts` 已 `ctx.provide('startupGate', gate)` 并在 `electron/api.ts` 发布 `StartupGate`
（`STARTUP_READY_WAIT = 120_000`、`markStartupReady` / `isStartupReady` / `waitStartupReady(timeout)` / `guard`）。
Rust 的两个生产调用点尚未有 TS 对应实现：

- F3-storage：`src-tauri/crates/dstu-storage/src/data_space.rs:2176-2180`
  （`wait_startup_ready(STARTUP_READY_WAIT)` 超时后记录错误并返回）；
- L21-backup-governance：`src-tauri/src/data_governance/commands.rs:434-438`（同样的等待与错误日志）。

D2 的最终形态（F3 分支 `ds-mig/F3-storage` 已发布，main 尚未包含 `registerFinalizer`）：

- `ctx.storage.registerFinalizer(name, fn, { after? })` 注册启动收尾钩子；
- 组合根在全部插件 `apply` 后调用 `await ctx.storage.runStartupFinalizers()`；
- 恢复收尾（L21 `finalizeRestoreActivation`）与 L20b baseline 重试在注册点挂接；
- **`startupGate` 的 mark 必须在 finalizer 全部成功后执行，且恢复模式提前返回也必须 mark**。
  F3 `STARTUP-WIRING.md` 推荐 `F2 gate 用 after: [全部业务 finalizer]，或直接放在组合根最后`。

当前仓库 `main` 的 `host/platform/storage/api.ts` 尚无 `registerFinalizer`，F2 不能安全地在自己的
`apply` 里提前 mark（此时业务插件与恢复收尾尚未执行）。因此本 lane 只发布 gate 与 `markStartupReady`/
`guard`，由 **F1 组合根**在 `runStartupFinalizers()` 成功后调用 `markStartupReady()`（含恢复模式）；
F2 不修改 `host/kernel` 或 F3 的 `index.ts`。F1 的具体接线点是
`host/kernel/connection.ts::boot`：`await loadStartupProfile(created, startup)` 之后调用
`created.ctx.storage.runStartupFinalizers()`，成功（以及恢复模式的提前返回路径）再
`created.ctx.startupGate.markStartupReady()`，等价 Rust `StartupReadyGuard` 的 drop。
F3 命令消费方需 `waitStartupReady(STARTUP_READY_WAIT)`，
超时文案与 Rust 的 `应用启动初始化超时（120 秒），请重启应用` 一致。接口进入 main 后需补一条真实
启动时序测试，不能只用 gate 单测冒充。


## 附：浏览器内容窗口（`browser.*` shell op，L19 `BrowserSurfaceHost`）

`dstu-browser` 的原生窗口面由 F2 在 Electron main 实现，经 `ctx.shell.request` 提供；L19 现有
`host/plugins/browser/src/surface-host.ts:11-29` 的 17 个 op 全部实现，另由 F2 公开第 18 个
`browser.screenshot`（L19 尚未接线，见下），L19 负责会话/策略/状态。实现：
`electron/shell/browser-surface.ts`（窗口与桥）、`electron/shell/browser-occlusion.ts`（macOS 输入遮挡）、
`electron/shell/browser-protocol.ts`（纯脚本与分派）。

- [x] `browser.createContentWindow`：参数 `{ url, title, width, height, focused, profileDir, initializationScript }`（`BrowserSurfaceCreateOptions`）。先 `mkdir -p profileDir`，失败文案 `failed to create browser profile dir {path}: {e}`（`window.rs` profile 目录语义）；macOS/Windows 创建固定 label `browser-content` 的 `WebContentsView`（`window.rs:60,446`），初始 `{0,0,1,1}` 且隐藏，随后 `loadURL`；已存在时幂等返回 `null`。Linux 创建独立 `BrowserWindow`（`window.rs` detached fallback）。错误前缀沿用 Rust：`parent window main not found`、`failed to create embedded browser-content webview: {e}`、`failed to initialize embedded browser-content webview visibility: {e}`、`failed to install browser-content native occlusion host: {e}`。
- [x] 内容页安全边界：`sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`、`webSecurity: true`，session 由 `session.fromPath(profileDir)` 建立；macOS UA 使用带 Safari 产品标记的固定串（`window.rs` macOS UA 分支）。
- [x] `initializationScript`：preload 通过 `webFrame.executeJavaScript` 在页面脚本前执行（Tauri `initialization_script`），失败以 `script-error` 消息回报 main 并写日志，不影响 invoke。
- [x] 内容页 invoke：source 为 `{ window: <内嵌为 main / Linux detached 为 browser-content>, webview: 'browser-content', origin: <帧真实 origin 或 "null"> }` 转发 Host；`origin` 由 main 从帧 URL 推导，内容页即使停在 devUrl 同源地址也传 `"null"`，不会继承 local ACL（详见下节）。回复写回内容页；窗口关闭/重载时 `runtime.webviewGone` 放弃该 webview 的挂起调用。
- [x] `browser.mainViewportSize`：主窗口 `getContentSize()`（DIP）× `screen.getDisplayMatching(...).scaleFactor`，四舍五入为物理像素（Rust `main_viewport_size` 返回物理 inner size）。
- [x] `browser.setContentBounds`：参数就是矩形（`surface-host.ts:89-91`）；物理像素 ÷ 比例尺后 `view.setBounds`，失败文案 `failed to set browser-content bounds: {e}`；Linux detached 与 Rust 一样 no-op；未创建时报 `browser-content webview not found`。
- [x] `browser.setContentVisibility` / `focusContentWindow` / `releaseContentFocus`：可见性切换 `view.setVisible`（detached 用 `show/hide`），`focus` 为 true 时聚焦内容页；未创建报 `browser-content webview not found`（detached 为 `browser-content window not found`），失败文案 `failed to show/hide browser-content: {e}`、`failed to focus browser-content: {e}`。`releaseContentFocus` 在 macOS 把键盘焦点交还 `main` 的 React webview（`window.rs:624-641`），非 macOS no-op。
- [x] `browser.snapshot/click/typeText/setInputFiles/scroll`：向内容页注入 `__dsBrowserBridge` 调用并解析 `{ ok, v, epoch, data|error }` 信封（`bridge.rs:30-113`）。click `{ref}`、type `type(ref,text,{clear:true})`、input files `setInputFiles(ref,files)`、scroll options 对象、snapshot `{interactiveOnly,maxChars}`；字符串结果按 WKWebView 行为再解套一层。超时常量对齐 `bridge.rs:38-43`：ready 2s、snapshot 5s、action 3s、file action 15s、eval 10s；错误文案 `bridge call timed out after {duration:?}`、`eval failed: {e}`、`invalid JSON from bridge: {e}`、`bridge error {code}: {message}`，未创建时 `webview not found: browser-content`。
- [x] `browser.setContentOcclusions`：仅 macOS 生效（Rust 同样只在 `#[cfg(target_os = "macos")]` 分支处理，`window.rs:671-715`）。输入为窗口物理像素矩形；视觉洞在内容页注入根元素 `clip-path: path(evenodd, …)`（外框 + 每个矩形一个洞），同时保存原背景、铺等效背景层并把 html/body 设为透明，主页面从洞中透出；清空矩形时恢复原内联样式并移除背景层（`macos_surface_clip.rs:371-393` 的 even-odd 语义）。输入遮挡由最上层透明 NSView 的 `hitTest:` 实现：命中输入矩形时返回主 webview 最深命中视图，未命中返回 nil（`macos_surface_clip.rs:102-139`）。Electron 的 `WebContentsViewCocoa` 像素由合成器直接绘制，父视图 CAShapeLayer mask 实测无效，因此视觉部分改用 CSS clip-path；Windows/Linux 与 Rust 一样 no-op。
- [x] `browser.navigate/goBack/goForward/reload`：`loadURL` / `navigationHistory` / `reload`；失败文案 `navigate failed: {e}`、`reload failed: {e}`。导航策略（scheme/私网/DNS）由 L19 `browser-service` 在执行前判定，F2 只执行原生动作。
- [x] `browser.destroyContentWindow`：移除输入遮挡 host、`removeChildView`、关闭 webContents；已销毁后再次调用仍返回 `true`（Rust `destroy_content_window` 幂等），失败文案 `failed to close browser-content: {e}`。
- [x] `browser.screenshot`（F2 新增公开面）：对 **browser-content 自身的 `webContents.capturePage()`** 截图，而不是主窗口
  `mainWindow.capturePage()`（后者含主界面，不等价）。成功返回
  `{ available: true, capability: 'browser_visible_webview_screenshot', mimeType: 'image/png', dataBase64, width, height }`；
  页面刚导航完成/合成器繁忙导致的短暂空帧会重试 3 次（间隔 100ms）；该重试修复 commit
  `025b51c27` 目前仅在 lane 分支，`main` 尚未包含（main 只有初版截图），待集成。仍无可见像素时返回
  `{ available: false, capability: 'browser_visible_webview_screenshot',
  reasonCode: 'PLATFORM_API_UNAVAILABLE', reason }`，与 Rust
  `browser_executor.rs::execute_screenshot` 的 `PLATFORM_API_UNAVAILABLE` 语义一致；未创建时抛
  `webview not found: browser-content`。绝不用 DOM/accessibility 快照或合成图冒充截图。
  Electron 在 macOS/Windows/Linux 均有 `capturePage()`，因此不按平台禁用；失败/空图才是不可用。
  注意：L19 `BrowserSurfaceHost` 尚无 `screenshot` 方法，需 L19 在 `surface-host.ts` 增加
  `screenshot(): Promise<BrowserScreenshotResult>` 并调用该 op，F2 不能编辑对方 lane。
- [x] 事件：`BrowserSurfaceHost.subscribe` 当前返回空 disposer。G0 协议没有 main→Host 的事件通道，原生 `pageFinished`/`titleChanged`/`navigationBlocked` 回调无法送达 L19；L19 的 `ShellBrowserSurface` 已按该现状处理。后续若增加事件通道，再注册真实回调。
- [x] 已知限制：页面发起的顶层导航策略无法在 F2 执行（L19 `BrowserSurfaceHost` 没有策略状态 op，只有上表 op）；Linux 为独立窗口且 `setContentBounds` no-op；Windows/Linux 不应用遮挡；CSS clip-path 依赖页面允许修改根元素样式（与 Rust 原生 mask 的可视结果一致，但机制不同）。
- [x] 测试：`electron/tests/browser-surface.test.ts` 覆盖脚本/信封/CSS path/分派（18 个 op）；`electron/tests/browser-surface-host.test.ts` 启动真实 Electron + Host 替身，跑通全部 18 个 op、真实 PNG 截图（校验 `89504e470d0a1a0a` 签名）、物理 bounds、CSS 遮挡注入/清除、历史前进后退、销毁后错误文案。截图与 ACL 组合仅在 Linux/xvfb 实测，macOS/Windows 未验证；真实 Host ACL 整机验收仍待 X1。
- [ ] capability schema 验证（阻塞，F1/F5/架构师）：Rust `src-tauri/tests/browser_capability_contract.rs` 用
  `include_str!("../gen/schemas/desktop-schema.json")` 校验 `capabilities/default.json` 与
  `browser-content.json`；该文件是 Tauri v2 构建产物且被 `.gitignore` 的 `src-tauri/gen/` 排除，仓库与
  `HEAD` 均不存在，本机也没有可离线生成的命令（`npx tauri` 无 schema 子命令）。因此：
  - 需要的产物：一份由真实 Tauri 构建（注册全部插件/权限后）生成的 `desktop-schema.json`，与当前
    `src-tauri/tauri.conf.json`、`capabilities/**`、`permissions/**` 同一版本。
  - 归属：F1/F5/架构师决定可复用路径（例如 CI 在 Rust 构建阶段生成并作为受控产物发布，或调整测试
    读取构建目录而非 `include_str!`）。F2 不手写/放宽 schema 过测，也不运行 Rust。
  - Electron 运行时 ACL 不依赖该 schema：main 从 `--tauri-dir` 读取 `capabilities/` 与 `permissions/`
    交给 Host `CapabilityAcl`；schema 缺失不影响已通过的来源/ACL 行为测试，但 Rust 合同测试无法编译。

## 附：IPC 来源（`WindowRef.origin`）与远程 capability

Tauri 在 IPC 入口用请求的 `Origin` 头区分 Local/Remote（`tauri-2.11.5` `src/ipc/authority.rs:37-57`、
`src/ipc/protocol.rs:485`、`src/webview/mod.rs:1760-1792`）。外壳不读取 renderer 的 `message.headers.origin`，
只从 main 持有的帧读 URL：

- [x] `electron/shell/frame-origin.ts`：`trustedFrameUrl` 优先 `WebFrameMain.url`，帧已销毁或 detached 时回退
  `WebContents.getURL()`；两者都来自 main，renderer 无法伪造。
- [x] 本地页面：与 `windowOrigin` 同 scheme+host+port（`tauri://localhost`、Windows `http://tauri.localhost`、
  dev URL 同源）→ 不设置 `origin`，内核 `host/kernel/acl.ts` 按 `local` 处理。
- [x] 远程页面：http(s) 帧透传 `URL.origin`（`scheme://host[:port]`，与浏览器 Origin 头一致）；
  `about:blank`/`file:`/`data:`/非本地 `tauri:` 等 opaque 来源透传 `"null"`，不会匹配任何 http(s) remote 规则。
- [x] `browser-content` 永远不继承 local：`handleBrowserInvoke` 对本地帧也传 `"null"`；远程帧传真实 origin，
  `src-tauri/capabilities/browser-content.json` 的 `remote.urls` 因此可正确匹配 `allow-browser-content-user-input`。
- [x] 测试：`electron/tests/frame-origin.test.ts` 覆盖 tauri/Windows/dev/远程/opaque 与帧销毁回退；
  `browser-surface-host.test.ts` 从独立端口加载内容页并伪造 `origin: https://forged.example` 头，断言 Host 收到
  `source.origin = http://127.0.0.1:<content-port>`，且同源内容页得到 `"null"`；`smoke.test.ts` 断言主窗口 source
  不含 origin、伪造头原样到达 Host（证明未参与判定）。
  注意：这些用例使用真实 Electron main + Host 替身，验证的是 main→Host 的 `WindowRef.origin` 传递；
  **不等于真实 Host 进程 + 真实 capability ACL 的整机验收**，后者仍需 X1 组合验证。

## 附：X1 三条 Shell 接点复核（`restart_app` / `filestream_check_access` / `purge_all_data`）

X1 的 Electron-as-Node 探针没有 GUI/Shell，不能据此判定生产坏；本轮按“Host 命令 → `ctx.shell.request` →
main 路由”逐条核对，不重复 23 条 meta 静态检查：

| Host 命令 | 发出的 op | main 处理 | 成功 / 错误映射 |
|---|---|---|---|
| `restart_app`（F3 `host/platform/storage/index.ts:172`） | `plugin:process\|restart`（带 `__window`） | `runBuiltin` → `processPlugin.restart` | 成功返回 `null`，随后 main `quitOrdered(0)` 并在退出前 `app.relaunch()`；内置命令缺失时 debug 文案 `process.restart not allowed. Command not found`，生产文案 `Command plugin:process\|restart not allowed by ACL` |
| `filestream_check_access`（L19 `host/plugins/vfs-handlers/src/filestream.ts:43`） | `app.pdfStreamAllowedDirs` | main 专用分支返回 app data/local/cache/documents/downloads/temp/resources/desktop/pictures | 空 `path` 先 `realpathSync('')` 失败并直接返回 `false`，与 Rust 先 canonicalize 一致，**不会**发 shell 请求；真实文件才请求 op。越界/隐藏段/扩展名不符/非常规文件均返回 `false`，不抛 IPC Err |
| `data_governance_purge_all_data`（L21 `host/plugins/backup/src/restore-commands.ts:696`） | `process:restart` | `resolveShellOp` 映射到 `plugin:process|restart`，与 `restart_app` 同一个 hook | 标记写入失败先抛 `写入清理标记失败: …` 且不发重启请求；请求返回后进程仍活着则抛 `应用重启未生效：进程仍在运行` |

补充边界：

- F2 自己的 `pdfstream_check_access`（`electron/index.ts:128`）与 L19 的 `filestream_check_access` 不是同一命令：
  前者对任何 path（含空串）都会先请求 `app.pdfStreamAllowedDirs`，再返回
  `{ available: false, reason: '文件不存在或不可读: …' }`；后者先 canonicalize，空 path 直接返回 `false`。
  两者共同依赖的 main op 相同，`electron/tests/shell-commands.test.ts` 已覆盖 F2 命令的 op 请求。
- 这三个 op 都是 **Host 可信 shell-request** 路径，不是 renderer invoke：renderer 调用
  `app.pdfStreamAllowedDirs` / `process:restart` 时名称不以 `plugin:` 开头，会被转发给 Host 当普通命令，
  不会命中 main 的专用分支或进程插件，因此没有放宽前端 ACL。
- `app.pdfStreamAllowedDirs` 只吞 `UnknownPathError`（某用户目录不存在），其他错误原样上抛；不存在
  独立的“权限拒绝”文案。`process:restart` 无参数，main 不校验参数。

证据（本轮）：

- 真实 Electron + Host 替身 `electron/tests/browser-surface-host.test.ts` 已通过 `app.pdfStreamAllowedDirs`
  往返断言返回值包含隔离的 `DS_APP_DATA_DIR/appdata`；这是**真实 main 路由**，Host 侧仍是替身。
- `electron/tests/shell-ops.test.ts` 新增用例：用真实 `ShellRuntime.runBuiltin` + 真实
  `processPlugin`，把 `process:restart` 经 `resolveShellOp` 派发到 `plugin:process|restart`，断言返回
  `null`、只调用 restart hook、不调用 exit hook；hooks 是测试替身，避免真实重启。`restart_app` 与
  `data_governance_purge_all_data` 共用该 main 路由。
- `electron/tests/shell-restart-host.test.ts` 进一步用真实 Electron main + HostSupervisor 协议替身，
  通过上述可注入 hooks 同时验证两个 restart 别名、`app.pdfStreamAllowedDirs` 与未知 process 命令错误出口；
  Host 插件/profile 仍是替身，未宣称整机验收。
- 其它 lane 已有 Host 侧断言（不代签其通过数）：`host/platform/storage/tests/startup.test.ts:64`
  断言 `plugin:process|restart`；`host/plugins/backup/tests/backup.test.ts:125` 与
  `host/plugins/integration/tests/restart-ordering.test.ts` 断言写标记后发 `process:restart`。

**已补的受控接缝**：`electron/main.ts` 现在导出 `start(options)` 与
`StartOptions.processHooks`；生产直接入口不传该选项，仍使用原有的 `app.relaunch()` / `app.exit()`。
测试入口 `electron/tests/fixtures/restart-main.ts` 只替换最终不可逆的 restart/exit hooks，其余
（Electron 启动、HostSupervisor 协议、`shellRequest` 路由、错误出口、窗口）全部走真实实现。
新增 `electron/tests/shell-restart-host.test.ts` + `electron/tests/fixtures/shell-request-host.ts`：
Host 协议替身依次发送 `plugin:process|restart`、`process:restart`、`app.pdfStreamAllowedDirs` 和
`plugin:process|nope`，断言两个 restart 别名都返回 `null`、restart hook 被调用两次、exit hook 未被调用，
PDF 白名单包含隔离 `DS_APP_DATA_DIR/appdata`，未知 process 命令得到
`process.nope not allowed. Command not found`。该用例没有真实重启，也没有清数据。

**仍未闭合**：完整“真实 Host 插件/profile + main”组合没有在本 lane 启动。实际 Host 需要 F3 storage
（含 migrations）、vfs-handlers、backup 等业务依赖与数据库；当前只有 Host 协议替身，没有只含这三条
命令的可复用测试 profile。若要继续做整机级验证，需要 F3/F1 提供可启动的最小 Host profile 或明确
这些插件在隔离数据目录下的启动顺序/迁移依赖。`filestream_check_access` 的空 `path` 在 Host 侧
canonicalize 失败即返回 `false`，本身不会触发 op；完整命令验证仍需该真实 Host profile。在此之前
按上述分层证据记录，不把 stub Host 结果当作整机验收。

## 附：X4 W19 / C1 自动化 OS 通知（`systemNotification` Host 服务）

F2 `dstu.shell` 现在发布 `systemNotification` 服务（`electron/system-notification.ts`，
`provides: ['startupGate', 'systemNotification']`），供 L06 自动化直接调用；不需要再新增 shell op。
C2 05:14 已确认 `plugin:notification|notify` 原语可复用并转给 C1/L06；策略读取、`notification_pending`
与送达回执仍归 L06，F2 只提供带策略与诚实结果的 Host 服务：

```ts
ctx.systemNotification.policy(): 'background' | 'always' | 'never'
ctx.systemNotification.notificationsDisabled(): boolean
await ctx.systemNotification.notify({
  id?: number,          // Rust NotificationBuilder::id(i32)，按 run_id 哈希去重（macOS/Windows 系统级）
  title: string,
  body: string,
  silent?: boolean,
  icon?: string,
  suppressIfWindowActive?: boolean, // Rust deliver_run_notification(suppress_if_window_active=true)
}): Promise<
  | { delivered: true;  suppressed: null; error: null }
  | { delivered: false; suppressed: 'policy' | 'window-active'; error: null }
  | { delivered: false; suppressed: null; error: string }
>
```

语义与边界（对齐 Rust `dstu_agent::system_notification` + `automations.rs:3040-3220,3727`）：

- 策略键 `system-notification-policy`，读取 F4 `ctx.settings`；缺失/非法/读取失败一律 `background`，
  与 `policy_from_raw` / `current_policy` 一致。`never` 直接返回 `suppressed:'policy'`，不调用原生 API。
- `suppressIfWindowActive: true` 时先经新 shell op `app.mainWindowActive`（`focused && visible &&
  !minimized`，`electron/main.ts`）判断；活跃则返回 `suppressed:'window-active'`，由前端 in-app toast 兜底。
  查询失败时返回 `delivered:false` + `error`（文案 `failed to query main window activity: {e}`），
  不猜测窗口状态、也不继续投递。
- 投递原语仍是 `plugin:notification|notify`：`{ options: { id?, title, body, silent?, icon? } }` → `null`；
  Electron `Notification.show()` 抛错/系统不支持时服务返回 `delivered:false` + `error`，**不会**把失败伪装成成功。
- **送达边界**：只有 `delivered:true` 才表示 `Notification.show()` 已接受请求（与 Rust `send_notification`
  返回 `Ok` 同级），不是 OS 展示/点击回执。L06 只有在该分支写 `notification` 送达标记；失败/抑制分支
  保留 `notification_pending` 由调度补投。策略读取、回执与重试标记都留在自动化 lane，F2 不写数据库。
- 测试：`electron/tests/system-notification.test.ts` 覆盖缺省/非法/读取失败策略、`never` 不发原生调用、
  `always` 参数透传与 `delivered:true`、原生失败不伪造送达、窗口活跃抑制、未要求抑制时不查询窗口；
  `electron/tests/browser-surface-host.test.ts` 经真实 main + Host 断言 `app.mainWindowActive` 布尔往返与
  `plugin:notification|notify` 的参数错误形状。
- L06 消费面（本轮核对 `main` 已包含）：`host/plugins/agent-orchestration/src/automation-notifications.ts`
  定义了与上面逐字段一致的 `SystemNotificationPort`，`index.ts` 优先 `ctx.get('systemNotification')`；
  其 `automation-notifications.test.ts` 明确断言 `delivered:true` 才写 `notification` 标记，`policy`/
  `window-active` 抑制不写、`error` 释放预约并安排 5 分钟补投。接口对接代码已在 `main`；L06 的实际
  测试通过数以其报告/CI 为准，F2 不代签。

## 附：Host 握手 profile（F0b，`docs/plugins/FRONTEND.md` §3）

插件装载由 Host 按 profile 决定；外壳只选择握手里的默认 profile，加载、回退与事件语义由 Host 负责。实现：
`electron/shell/host-profile.ts`、`electron/main.ts`。

- [x] 选择顺序：`DS_HOST_PROFILE` 非空时按 `resolve()` 绝对化后使用（覆盖一切）；否则 `<appDataDir>/plugins/user.profile.json` 存在时用它；否则官方 profile `<Host 入口目录>/../profiles/desktop.json`。空字符串按未设置处理。
- [x] 握手字段：`Handshake.profile` 始终存在（不再只在 `DS_HOST_PROFILE` 设置时发送），Host 进程参数 `--profile=` 仍为空。
- [x] 事件：收到后端事件 `host://plugin-profile-failed` 时 main 记录 `[host] plugin profile failed (<profile>): <error>`（载荷 `{ profile, error }`，缺字段时安全降级）；事件仍按 Host 指定的 target 转发给渲染进程，前端提示不在 F2。
- [x] Host 重启/不可用：`onUnavailable` 时使 UI 清单缓存失效，下次 `ds-plugin://` 请求重新向 Host 拉取。
- [x] 已知限制：F1 当前把握手中的 `profile` 当作“显式 profile”（失败即 `HostFatal`），因此“用户 profile 失败 → 回退官方 profile + `host://plugin-profile-failed`”要等 F1 区分“外壳默认选择”与“用户显式覆盖”后才生效；F2 已按协调者指令始终发送默认选择并记录事件。
- [x] 测试：`electron/tests/host-profile.test.ts` 覆盖覆盖值、空覆盖、用户 profile 存在/不存在与官方路径。

## 附：`ds-plugin://` UI 插件协议（F0b）

第三方 UI 模块经 `ds-plugin://<插件 id>/<相对路径>` 由 main 进程提供；共享依赖的 import map 由渲染进程侧用 blob URL 实现，外壳不提供 `ds-shared://`。实现：
`electron/shell/plugin-ui-protocol.ts`、`electron/shell/protocols.ts`。

- [x] URL：主机名是插件 id，路径百分号解码后相对插件 UI 模块所在目录（清单条目 `file` 的 `dirname`）；空 id、空路径、绝对路径、NUL 字节一律拒绝。
- [x] 清单：首次协议请求惰性调用 Host 命令 `plugin:ui|manifest`，返回 `{ id, file(绝对路径), version? }[]`；后端事件 `host://ui-manifest` 以完整数组替换当前清单（新增/移除/换目录立即生效，旧 id 与旧根目录同时失效）。事件中的非法清单记日志并保留旧清单；首次命令拉取失败返回 503 且不缓存失败（下次请求重试）。
- [x] 路径穿越：`path.resolve` 后的相对路径必须位于根目录内（拒绝 `..`、编码后的 `..%2f`/`%2e%2e%2f`、绝对路径）；随后对根与目标做 `realpath` 再校验，指向根外的符号链接同样拒绝。
- [x] 类型与 MIME：只提供 `.js`/`.mjs`（`text/javascript`，可作为 ESM 加载）、`.css`、`.json`/`.map`、图片（png/jpg/jpeg/gif/webp/avif/svg/ico/bmp）、字体（woff/woff2/ttf/otf）与 `.wasm`；HTML、TS 及其他扩展名返回 415。
- [x] 响应头：所有响应（含错误）`Cache-Control: no-store`、`Access-Control-Allow-Origin: *`；成功响应带 `Content-Length`；`HEAD` 返回头与空体；仅允许 `GET`/`HEAD`（405 + `Allow: GET, HEAD`）。
- [x] 错误：400 URL 规则/编码错误；403 越界；404 未知插件或文件不存在；415 不支持的类型；503 清单不可用（失败不缓存，下次请求重试）。
- [x] CSP：生产页面（`tauri` 协议）响应的 `Content-Security-Policy` 由 `app.security.csp` 增补而来：`default-src`/`script-src`/`script-src-elem`/`style-src`/`style-src-elem`/`img-src`/`font-src`/`connect-src`/`media-src`/`worker-src` 追加 `ds-plugin:`，脚本指令追加 `blob:`；缺少 `script-src` 时补 `script-src 'self' ds-plugin: blob:`。开发模式（Vite dev URL）页面不经过 `tauri` 协议，没有该 CSP。
- [x] 权限注册：`ds-plugin` 与 `asset`/`tauri` 等一起注册为 standard/secure/supportFetchAPI/corsEnabled/stream（必须在 app ready 前）。
- [x] 测试：`electron/tests/plugin-ui-protocol.test.ts` 覆盖 MIME、no-store、HEAD、穿越/编码穿越/符号链接、未知与移除插件、清单换根、惰性加载与失败重试、清单校验、CSP 增补；`electron/tests/plugin-ui-host.test.ts` 启动真实 Electron + Host 替身，验证首次请求拉取清单、ESM 动态导入、穿越 403、`host://ui-manifest` 事件后旧路径 404 与新根生效。

## 附：updater 插件（`plugin:updater|*`，非 F2 契约命令）

`tauri-plugin-updater` 2.10.0 的命令不在 `contracts/ipc/F2-shell.json`，但 `src/hooks/useAppUpdater.ts` 会直接 invoke，外壳必须实现；`electron/shell/updater.ts` 按插件源码逐分支复刻。

- [x] 配置：读取 `src-tauri/tauri.conf.json` 的 `plugins.updater.endpoints/pubkey/windows.installerArgs/installMode`（`electron/shell/tauri-config.ts`）。release 构建拒绝非 `https` endpoint（debug 仅告警），与 `config.rs:validate_endpoints` 的 `cfg!(debug_assertions)` 分支一致。
- [x] `check`：endpoints 顺序尝试；仅 `last_error = None` 于成功解析（`updater.rs:464-530`）；HTTP 非 2xx 不覆盖 last_error；204 立即返回 `null`；响应 JSON 解码失败立即抛错（`res.json().await?`）；`{{current_version}}`（百分号编码 `+`）/`{{target}}`/`{{arch}}`/`{{bundle_type}}` 替换（`updater.rs:420-449`）。`latest.json` 支持静态 `platforms` 与动态 `url+signature`，`version` 兼容 `name` 别名与前导 `v`，`pub_date` 按 time Rfc3339 解析/格式化（`updater.rs:1378-1423`）。
- [x] `check` 的 target：显式 `target` 优先；否则静态 `platforms` 依次查 `{os}-{arch}-{installer}`、`{os}-{arch}`（`updater.rs:571-603`）；找不到时即使无需更新也报错（Rust 先解析下载地址再判断 should_update）。`allowDowngrades` 用完整 `Version` 不等比较（含 build metadata，`commands.rs:69-71`）。
- [x] `download`：`Accept: application/octet-stream`（未提供时）、User-Agent `tauri-plugin-updater/2.10.0`；第一块数据发 `Started{contentLength}`（取 Content-Length，可为 `null`），每块发 `Progress{chunkLength}`，流结束先发 `Finished` 再校验 minisign（`commands.rs:116-146`、`updater.rs:1020-1050`）。签名失败只报 `The signature verification failed`。
- [x] `install`：成功安装后才关闭 `bytesRid`（Rust `?` 在 close 之前，`commands.rs:166-176`）；macOS 解包 `.app.tar.gz` 后替换当前 `.app`（权限拒绝时走 AppleScript 管理员路径）；Linux AppImage 在同挂载点临时目录备份后原地替换（gzip 包内找 `.AppImage`）；Windows 支持 ZIP/MSI/NSIS，按 `installMode` 组装参数后启动安装器并退出（`updater.rs:1205-1600`）。
- [x] `download_and_install`：下载 + 校验 + 安装，事件序列与 `download` 相同；不创建额外字节资源（`commands.rs:181-229`）。
- [x] 资源：`check` 的 rid 与 `download` 的字节 rid 存放在 `ShellRuntime` 的 per-webview 资源表；无效 rid 报 `The resource id {rid} is invalid.`（tauri `resource.rs`）。
- [x] 已知差异：Linux 仅实现 AppImage 安装（Electron 产物为 AppImage）；Windows ZIP 读取器不支持 ZIP64；deb/rpm 安装路径（dpkg/rpm/pkexec）未实现，需在打包格式确定后补齐。

## 附：打包与 migrations 资源

- [x] `electron/electron-builder.config.cjs`：mac（dmg/zip，`identity: null`）、Windows（nsis/zip，不签名且不改 exe）、Linux（AppImage/deb）三平台未签名目标；`asar: false` 以保留 `utilityProcess.fork(host/kernel/main.ts)` 与原生模块的普通文件路径；`npmRebuild: false` 不重编译原生模块。
- [x] D5 `sharp`：`package.json` 已把 `sharp` 列为生产依赖；沿用现有 `asar: false`（不重复新增 `asarUnpack`），原生依赖以
  `app/node_modules/sharp` + 平台 `@img/sharp-*` 普通文件存在。`electron/tests/packaging.test.ts` 新增用例：
  读取生产依赖、断言 `asar === false`、`require.resolve('sharp')` 不在 `.asar` 内，并真实创建 2×2 PNG
  校验 `89504e470d0a1a0a`。
  打包实测（Linux x64，`node electron/scripts/package.mjs --linux --dir`，作业退出码 0）：
  `release/linux-unpacked/resources/app/node_modules/sharp` 与
  `.../@img/sharp-linux-x64/lib/sharp-linux-x64.node` 均为普通文件；直接 `require()` 该真实包路径得到
  sharp 0.34.5 / vips 8.17.3，并输出 92 字节 PNG（签名 `89504e470d0a1a0a`）；migrations 逐字节校验同时通过。
  本轮只做 `--dir`（未生成 AppImage/deb），mac/Windows 的 `@img` 选包仍需在对应平台打包后核对。
- [x] D5 `undici`：`package.json` 已是直接依赖（`7.30.1`），由 electron-builder 的 production
  dependencies 自动放进 `app/node_modules`；已移除 `extraResources` 中重复的手工 undici 复制，
  `packaging.test.ts` 断言依赖存在且不再重复复制。`tar` 及传递依赖仍未声明为直接依赖，保留显式复制。
  同期 Linux x64 `--dir` 重建产物实测：`release/linux-unpacked/resources/app/node_modules/undici`
  为普通目录，读取该包 `package.json` 得 `7.30.1`，导出 `fetch` / `ProxyAgent` 均为 function；
  sharp 原生模块在该产物中仍可编码 PNG（92 字节，签名 `89504e470d0a1a0a`）。
  **主线状态**：`electron/system-notification.ts` 与初版 `browser.screenshot` 已进入 main；
  `025b51c27`（截图空帧重试）、`422890050`（sharp 打包用例）、`38be4f5e8`（undici 配置）
  仍只在 `ds-mig/F2-shell` 分支，待集成后再按 main 重新核对。
- [x] `src-tauri/migrations` 经 `extraResources: [{ from: 'src-tauri/migrations', to: 'migrations' }]` 复制为 `Contents/Resources/migrations`（Windows/Linux 为 `resources/migrations`），复制使用 fs 读取，不转码；`electron/migrations-integrity.ts` + `electron/scripts/verify-migrations.mjs` 逐文件比较大小与 SHA-256，`package.mjs` 打包后自动执行。
- [x] `electron/main.ts` 计算 `DS_MIGRATIONS_DIR`（打包态 `process.resourcesPath/migrations`，开发态仓库 `src-tauri/migrations`），写入 Host 子进程环境并提供 shell op `app.migrationsDir`；F3 的 `StorageCordisService` 仍需在 profile 配置中把它传给 `StorageServiceOptions.migrationsDir`（本 lane 不能改 `host/`）。
- [x] `electron/scripts/package.mjs`：先构建 preload，固化 `electron/.build/version.json`（打包后无 git，`get_app_version` 依赖它），再调用 electron-builder；`--dir` 用于本地验收，结束时校验 migrations 逐字节一致。
- [x] `files` 同时包含 `src-tauri/tauri.conf.json`、`src-tauri/capabilities/**/*`、`src-tauri/permissions/**/*`；
  `electron/main.ts` 以 `--tauri-dir=<repoRoot>/src-tauri` 启动 Host（打包态为 `resources/app/src-tauri`），
  Host 的 `CapabilityAcl.fromDirectory` 从这里加载 ACL。`packaging.test.ts` 断言 glob 与文件存在，
  `smoke.test.ts` 断言真实 Host 子进程 argv 含该参数。
- [x] 已知限制：Linux updater 只替换 AppImage，deb 安装包不通过该 updater 更新；macOS/Windows 的打包与运行
  未在本轮 Linux 环境实测。

## 附：`plugin:fs|watch`（本构建不存在，未注册）

派发清单中的「fs watch」按本仓库实际编译的插件版本核对后确认**没有可迁移的命令**：

- `src-tauri/Cargo.toml:97` 声明 `tauri-plugin-fs = "2"`，未启用任何 feature；该 crate 的 `watch` 不是默认
  feature（`[features] watch = ["notify", "notify-debouncer-full"]`）。
- `src-tauri/Cargo.lock` 中没有 `notify` / `notify-debouncer-full`（`grep 'name = "notify"'` 无命中），
  证明 `watcher::watch` 未被编译进二进制。
- 上游只有 `watch` 一个命令（`lib.rs` 的 `#[cfg(feature = "watch")] watcher::watch`），
  `unwatch` 并不存在；JS 侧通过 `plugin:resources|close` 释放 watcher。
- `src/` 没有任何 `plugin:fs|watch` 调用方（前端只用 open/read/write/copy/mkdir 等命令）。

因此 `electron/shell/plugins/fs.ts` 不注册 `watch`/`unwatch`，invoke 走 runtime 的 not-found 分支，与 Tauri 构建
一致；`electron/tests/fs-plugin.test.ts` 固定该命令面。若未来启用 Rust `watch` feature，需要同时引入
`chokidar`（notify + notify-debouncer-full 的对等库，未安装）并增补 capability，均已超出 F2 的写入范围。

## 附：clipboard-manager 插件（WP-078，Electron 45 Promise API）

依据 `tauri-plugin-clipboard-manager` 2.2.3 `desktop.rs`/`commands.rs`/`error.rs` 与 arboard 3.6.1（`platform/linux/x11.rs`、`common.rs`）。
安装版 Electron 45.2.1 的 `clipboard` 只有 `clear/has/read/readText/write/writeText/selection`（`electron.d.ts:7452-7496`，运行时探测一致）；
旧同步 API（`availableFormats/readImage/writeImage`）已不存在，原手写 `MainClipboard` 断言掩盖了这一点，X1 报 `clipboard.availableFormats is not a function`。

- [x] 错误值：命令 Err 为字符串（`Error::Clipboard(arboard Display)`）。`ContentNotAvailable` =
  `The clipboard contents were not available in the requested format or the clipboard is empty.`；`ConversionFailure` 原文同 `common.rs:61`。
- [x] `write_text{text}`：`await clipboard.writeText`；desktop 忽略 `label`。缺参走 tauri InvalidArgs 原文。
- [x] `read_text`：`clipboard.read()` 中带 `text/plain` 的项 → `getType` → `Blob.text()`；没有文本格式（空、只有 HTML、只有图片、clear 后）报 `ContentNotAvailable`，不返回空串（arboard `get_text` 只查文本目标）。
- [x] `write_html{html, altText?}`：一次 `write([ClipboardItem])`，`text/html` + 仅 `altText` 存在时 `text/plain`（arboard `set_html` 的 `alt` 分支）；无 altText 时随后 `read_text` 报 `ContentNotAvailable`。
- [x] `clear`：`clipboard.clear()`（同步 void，Electron 不返回 Promise）。
- [x] `write_image{image}`：`JsImage`（rid / RGBA 对象 / bytes / path）→ 直通 RGBA → 无损 PNG → `image/png` Blob（arboard Linux `set_image` 写 `image/png` 目标）；RGBA 长度不符沿用 tauri Image 的原文错误。
  实测发现 upng-js 2.1.0 `encode` 对小尺寸调色板图把输出缓冲估成 `byteLength+100`，PLTE/tRNS 后 IEND 被截断（3×1 RGBA 输出 112 字节、无 IEND，自身 decode 也抛错），Chromium 静默丢弃该 PNG（`clipboard.write` resolve 但 `read()` 无 `image/png`，`nativeImage.createFromBuffer` 为空）。`ImageResource.png()` 改用已是生产依赖的 pngjs 7.0.0 写 RGBA8（colorType 6），`native()`（窗口图标路径）共享同一编码；解码仍用 UPNG。
- [x] `read_image`：取 `image/png` 项，PNG 解码为直通 RGBA8 后放入 per-webview 资源表返回 rid；无 PNG → `ContentNotAvailable`；解码失败 → `ConversionFailure`（Rust 不记日志）。
- [x] 测试：`electron/tests/clipboard-host.test.ts` 真实 Electron 窗口 + 真实系统剪贴板（Linux 强制隔离 Xvfb），不使用剪贴板替身。
- 语义差异（报告列出）：`write_image` 对 0×0/空 RGBA，arboard Linux/Windows 报 `ConversionFailure`，Electron 路径维持原行为（交给 Chromium）；Electron 的 `writeText('')` 与 `write([ClipboardItem({'text/plain': ''})])` 在 X11 上都不留下任何格式（实测 `read()` types 为 `[]`、`has('text/plain')` 为 false），随后 `read_text` 报 `ContentNotAvailable`；arboard 会写入空 UTF8_STRING 并读回 `""`。Electron 45 公开 API 无法表达空文本目标，保留差异。

## 附：页面开始加载生命周期（WP-090，`PageLoadEvent::Started` → `page-load-started`）

依据 `src-tauri/src/lib.rs:484-491`（`Builder::on_page_load`，`Started` 时按 `webview.label()` 清理笔记编辑租约并注入启动诊断桥）、
tauri 2.11.5 `manager/webview.rs:290-311`（应用级 handler 对 manager 中**每个** webview 生效，含 `add_child`）、
wry 0.55.1 的 `Started` 来源：WebKitGTK `LoadEvent::Committed`（`webkitgtk/mod.rs:474-478`）、WKWebView `didCommitNavigation`
（`wkwebview/navigation.rs:17-25`）、WebView2 `ContentLoading`（`webview2/mod.rs:645-655`）。三者都是主框架新文档提交。
F1 端口：`WindowLifecycle.state` 增补 `page-load-started`（main `b73675cf2`，`host/kernel/protocol.ts:78-90`）。

- [x] 事件源：Electron `did-navigate`（主框架、跨文档、已提交）。Electron 45.2.1 实测（隔离 Xvfb 探针，作业 `20261105191040-91f7ff`）：
  初次加载、reload、302 重定向（只在最终 URL 一次）各触发一次；hash、pushState（只有 `did-navigate-in-page`）、iframe、204、下载、
  被拦截端口错误都不触发。`did-start-navigation` 在 204/下载也触发（未提交），与 wry 语义不符，故不用于本事件；
  其既有 `webviewGone('reloaded')`（放弃进行中 invoke）保持不变，因此整页 reload 的顺序为 `abandon` → `page-load-started`。
- [x] 应用窗口：`electron/shell/windows.ts` `wire()`，ref `{window: label, webview: label}`，与其余五态同一 `lifecycle` hook → `HostSupervisor.sendMessage`。
- [x] browser-content：`electron/main.ts` `registerWebview` 回调，ref 取 main 自持的 `windowLabel`/`label`（embedded `main`/`browser-content`，
  detached `browser-content`/`browser-content`，与 invoke source 相同来源）；`runtime.browserWebviewOf(contents)` 为空（已注销）时不发送。
- [x] 来源：ref 只来自 main 的窗口注册表，不读渲染进程数据；不带 `origin`（与其余生命周期状态一致，Rust 回调只用 label）。
- [x] 与 invoke 无关：每次提交都发送，不依赖是否有进行中调用。
- [x] Host 未 ready：沿用 `HostSupervisor.send` 的队列，ready 后按序一次送达；崩溃重启期间产生的消息进入同一队列，送给重启后的 Host；
  Host 被判定不可用（入口缺失或 60 秒内重启 3 次放弃）后 `sendMessage` 直接丢弃，与其余生命周期一致（Host 已不存在，无租约可清理）。
  重启后的 Host 状态从零开始，不补发历史页面加载。
- [x] 测试：`electron/tests/page-load-lifecycle-host.test.ts`（真实 Electron + main.ts + 替身 Host，ready 延迟 4 秒）；
  `electron/tests/host-readiness.test.ts` 两条缓冲/重启用例走生产 `HostSupervisor`。
- 语义差异（报告列出）：WebKitGTK 加载失败时默认显示错误页（`load-failed` 后提交替代内容），是否再发 `Committed` 未在本机验证；
  Electron 对网络错误页不发 `did-navigate`，WKWebView 失败也不提交。macOS/Windows 的 embedded 分支未在本机实跑，代码路径与 detached 相同。
- WP-090 未做：L10 `cleanup_note_editor_leases` 的 Host 端消费（仍另包）。同一回调里的启动诊断桥 `webview.eval`（`lib.rs:492-` 起，
  `src/logging/errorReporter.ts` 消费 `__DSTU_BOOT_DIAGNOSTICS_CLEANUP__`）当时尚无实现，现由后继 WP-199 补齐如下。

## WP-199 Started 启动诊断（2026-11-06）

行为来源为 `src-tauri/src/lib.rs:487-559` 的完整 IIFE；`src/logging/errorReporter.ts:240-244` 是既有主世界清理消费者。
Tauri 2.11.5 `manager/webview.rs:288-311` 将 Builder 全局回调接到每个 pending webview，包含 main、child/detached browser-content；没有为远程页面增加日志权限。

| Rust 分支 | Electron 落点/约束 |
|---|---|
| 495 先调用旧 cleanup | preload 同步主世界 installer 开头原样调用，旧 timer/监听先清掉 |
| 497-511 active / invoke 非函数不发送 | 主世界每次事件读取正式 `__TAURI_INTERNALS__.invoke`；Promise rejection best-effort，不加替代日志 |
| 502-509 payload | 恰好 level=ERROR、kind、String(message\|\|kind)、stack\|\|null、hash\|\|pathname、href、userAgent、extra\|\|null；不擅加 component/line/column |
| 513-524 error | capture；target 非 window 时依 src/href/tagName 判资源；原 message 与 error.stack |
| 525-532 rejection | Error 的 message/stack 与其它 reason 的 String 分支；在主世界做 instanceof |
| 533-538 CSP | 原 blockedURI/violatedDirective 文案，无额外字段 |
| 542-547 blank | 原 8000ms；root 不存在或 childElementCount===0 上报，非空不报 |
| 548-555 cleanup | active=false、clearTimeout、移除三个 capture 监听、delete 主世界函数；前端原 reporter 可直接消费 |
| 页面新文档 | 每次 preload 在正式 bridge 之后、页面首脚本之前同步安装；不用 did-navigate 异步 eval 冒充早期安装 |

诊断安装不消费 L10 租约。WP-090 的 did-navigate Started 发送、导航 abandon、HostReady 队列保持原有入口与顺序。
日志经过现有 main → Host → F4 `report_frontend_log`，沿用原 CSP、ACL 与 F4 落盘/脱敏行为。browser-content 的日志调用仍按原能力拒绝，拒绝被原 best-effort 分支消费；不得将这种拒绝改成主窗权限或隐藏为成功落盘。
本项无对应 Rust 单测，不改 18 行 TESTMAP 去向（3 pending 保持）。真实验证结果与平台边界见 LANE/交付报告。

- TS 精确落点：`electron/preload/boot-diagnostics.ts:9` 旧cleanup；`:11-26` active/invoke/payload/reject；`:28-39` error；`:40-47` rejection；`:48-56` CSP/三个capture；`:57-62` 8000ms；`:63-70` cleanup。唯一生产调用为 `electron/preload/preload.ts:86`，与正式bridge安装相邻且同步。
- `electron/tests/boot-diagnostics-host.test.ts` 使用真实文档外部首脚本throw、缺失script、原CSP禁止inline、真实Promise.reject(Error/string)，不是直接调用report或人工冒充事件。IPC只读观察记录原payload/回执，最终核对F4 frontend日志文件（main12条BOOT + quick-assistant2条）；browser3条BOOT均按原ACL拒绝，没有落盘。
- 同一测试对照前端现存cleanup消费者（测试打包读取原文件，按开发Vite定义PROD=false，未修改前端），真实记录clearTimeout和三个capture remove；8秒后无BOOT但正式reporter仍正常上报。reload新文档再次捕获首脚本；另两个webview不受main cleanup影响。空root/缺root/非空root分别由main/browser/quick-assistant覆盖。
- `electron/tests/boot-diagnostics.test.ts` 补足旧installer重入、已排队旧回调active、缺invoke、资源三候选与message fallback的精确分支；该边界用例不冒充真实Electron证据。两文件 job `20261105233750-4b763f` 3 passed / 0 failed / 0 skipped / Errors0 / exit0。
- 本包不增加数据库所有者/新日志入口/超时/开关，生产唯一副作用为原监听、计时器及既有日志invoke。Rust IIFE无warn/info；invoke的Promise拒绝原本无日志，保持best-effort。同步invoke抛错也未擅改成catch。
