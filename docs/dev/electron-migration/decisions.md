# 迁移决策与已知缺口日志

格式：日期 · 事项 · 结论 / 负责 lane · 状态。语义歧义一律在这里裁定，不允许"差不多"实现。

## 2026-11-03

- **未注册命令的错误文案**：本应用启用了 app ACL（`src-tauri/build.rs:54-56,217-246`），
  所以未注册命令走的是 ACL 拒绝路径，而不是 "Command X not found"。debug 返回
  `<cmd> not allowed. Command not found`，release 返回 `Command <cmd> not allowed by ACL`，
  插件命令 debug 返回 `p.c not allowed. Plugin not found`。由 `host/kernel/errors.ts` 实现。· F1 · 已实现
- **ACL capability 校验缺口**：Rust 会拒绝"已注册、但调用窗口没有对应 capability"的调用，
  Host 目前不读 `src-tauri/capabilities/*.json`。需要在 kernel 中按窗口 label 实现同等校验。· F1 · **待办**
- **命令 panic 语义**：Rust 异步命令 panic 时，tokio 任务结束、resolver 被丢弃、前端 Promise
  永不 settle（`tauri-2.11.5/src/ipc/mod.rs:371-389`）。Host 对非 `CommandError` 的异常
  照此处理（不回复、只记日志）；测试宿主则 reject 为 `HandlerPanic`。· F1 · 已实现
- **serde 错误文案覆盖范围**：原始类型、整数范围、Option、Vec、map、struct、unit enum
  逐字一致；tagged/untagged enum、flatten、tuple、NonZero 的 detail 目前是 ajv 的措辞。
  前端如有依赖这些文案的地方，需要补齐。· F1 · 待评估
- **unit enum 的 map 形式**：serde 接受 `{"Variant": null}`，契约 schema 只允许 string。
  按 serde 行为放宽。· F1/F5 · **待办**
- **跨插件服务调用的运行时 schema 校验**：暂不做，版本靠命名约定（见 `host/kernel/API.md`）。· F1 · 已接受
- **cordis-plugin-loader 未采用**：它对导入失败只记日志后跳过、不回滚；会对配置中的 `!!js`
  求值；条目按自己的 entry id 而不是 `meta.id` 标识。改用 kernel 自带的 profile 加载器。· F1 · 已决
- **Electron 的 Node 没有 `crypto.argon2`**（BoringSSL）：DSBK 备份加密改用 `@noble/hashes`
  的 argon2（已改为直接依赖，1.8.0）。默认 64 MiB 参数在 Electron 下约需 2.3 秒，而 OpenSSL
  约 95 毫秒。换成 wasm 或原生实现（hash-wasm / @node-rs/argon2）的事交给 F7 评估。· F4/F7 · 待评估
- **密钥兼容向量（待补）**：
  - Rust 实际写出的 `.secure/*.enc`、`.master_key`、`api_configs` 与 DSBK 样本，等 F6 录制时导出；
  - Linux Secret Service 下 keyring 3.6.3 与 @napi-rs/keyring 能否互读，需要在 Linux 桌面验证；
  - Windows DPAPI 互操作，以及 `os.hostname()` 与 `GetComputerNameExW` 是否一致（影响 legacy v2 密钥），需要在 Windows 上验证。
  · F4/F6 · **待办（C 级）**
- **共享 crate 的测试归属**：dstu-core 的 77 个、dstu-util 的 64 个测试，随使用它们的 lane 迁移；
  `error_details_tests`（14 个）归 F1；`cloud_half_configured_credentials_tests`（5 个）归 L23。· F4 · 已决
- **日志与诊断中的细节差异**（不涉及持久化数据）：JS 的 `\b` 只认 ASCII；整数样键的对象顺序；
  f64 的 `1.0` 与 `1`；`io::Error` 文案只覆盖常见 errno。· F4 · 已接受
- **集成测试自建的命令**：`src-tauri/tests/app_command_acl.rs` 中的 `test_mcp_connection` 是测试夹具，
  与应用真正的 `cmd/mcp.rs::test_mcp_connection` 重名，曾导致 Host 启动失败。inventory 和契约抽取
  不再统计 `src-tauri/tests/` 中的 `#[tauri::command]`。修正后共 1066 条命令定义，其中 1058 个契约
  对应当前生效的 cfg 变体，前端调用但未定义的命令名是 50 个。· F5 · 已修
- **Electron 外壳缺口**（F2，详见各模块）：
  - updater 插件的命令全部 reject，需要 electron-updater 并按 Tauri updater 的 minisign 和
    latest.json 语义实现；
  - http 插件的 cookie jar 未实现，不支持 proxy 选项，重定向上限是 20 而 reqwest 是 10，不读取系统代理；
  - window 插件部分 setter 显式 reject，`start_dragging` 是模拟实现；
  - fs 的 watch 不支持；clipboard 不支持图片；opener 的 `with` 参数不支持；
  - 外部文件拖入（enter 阶段）拿不到路径；
  - raw-body invoke 转发时丢失请求头，`InvokeRequest` 需要增加 headers 字段；
  - 按窗口 capability 的 ACL 校验未做（与 F1 同一项）。
  · F2 · **待办**
- **全局快捷键约定**：Rust 内置的快捷键处理（快速助手开关）由外壳以 FrontendEvent
  `global-shortcut://triggered` 转发到 Host，L17 和 F1 按此约定接入。· F2/L17 · 已决
- **better-sqlite3 与 rusqlite 的差异**：
  - better-sqlite3 编译时设了 `SQLITE_DQS=0`，双引号字符串字面量会报错。132 个迁移文件不受影响，
    业务 lane 自己写的 SQL 要注意，见 storage API.md；
  - `SQLITE_DBCONFIG_DEFENSIVE` 已关闭（`unsafeMode(true)`），与 rusqlite 一致：允许
    writable_schema、写 FTS 影子表、迭代时写入；
  - Rust 未设置 synchronous 的库，显式设为 FULL（better-sqlite3 在 WAL 下默认是 NORMAL）；
  - 时间戳精度是毫秒，Rust 是纳秒；备份走 better-sqlite3 的异步 `backup()`。
  · F3 · 已决
- **迁移文件随包发布**：迁移器在运行时读取 `src-tauri/migrations`，校验和依赖原文。F2 打包时必须
  逐字节作为资源附带，并传入 `migrationsDir`。· F2 · **待办**
- **启动顺序**：data_space 的启动步骤（`initialize_on_start`、待切换槽位、purge）必须在
  `migrations.runAll()` 之前执行，目前还没人实现。· F3 lane · **待办（关键路径）**
- **Rust 现有的分歧照原样保留**：chat_v2 从 V20260203/0204 续迁后，`active_skill_ids_json` 带
  `DEFAULT '[]'`，而新建库没有这个默认值。迁移后保持同样行为，测试里有断言。· F3 · 已接受
- **待批准（obsolete/merged）**：
  - `src-tauri/tests/migration_tests.rs` 的 28 个测试整文件受一个从未启用的 feature 控制，申请标为 obsolete；
  - `database/manager.rs` 和 `maintenance.rs` 的 r2d2 连接池测试，申请标为 merged。
  · 协调者 · **待用户批准**
- **契约抽取问题**（L10 发现）：`NoteStatePut/Delete` 用 `allOf` 引用了带 `additionalProperties:false` 的
  `NoteStateKey`，结果 Rust 本来接受的扁平请求被 Host 拒绝（serde flatten 的形状）。同类写法要在抽取器里
  统一修正（flatten 合并为同一层，不能对子 schema 设 additionalProperties:false）。· F5 · **待办**
- **unit enum 反序列化类型变更的影响**：F5 给 `__De` 类型加了 `{"Variant": null}` 形式后，直接把枚举值当
  索引或参数使用的 lane（例如 L23 `config.ts`、L10 `repository/state.ts`）需要先做归一化。这是正当修正，
  受影响的 lane 合并 main 后自行适配。· F5/各 lane · 已决
- **xhh 供应商整体故障**（2026-11-03 09:05 起 503）：按用户指示，全部 lane 暂时改用
  `opencode-go/deepseek-v4.1-flash#max`。`MODEL_BY_LANE` 中原 astra 的分配保留，xhh 恢复后用 `set-model` 切回。· 协调者 · 进行中
- **F2 第一轮报告的处理**：
  - 已安装 `electron-updater@6.8.10`、`electron-builder@26.17.0`，F2 继续完成 updater 与打包；
  - 文件类 6 个命令（`copy_file`、`read_file_*`、`hash_file`、`get_file_size`、`save_text_to_file`）仍归 F2，按
    `unified_file_manager` 的**桌面分支**语义完整实现（隐藏路径拒绝、200MB 上限、写后回读校验、SHA-256 流式）；
    `content://` 只在移动端 cfg 下生效，本轮不做；
  - `set_window_appearance`、`sync_titlebar_sidebar_material` 以及 window 插件的若干 setter 需要 macOS 原生
    NSWindow/NSVisualEffectView，Electron 没有公开 API。是否引入原生插件需要用户决定，暂列缺口；
  - B 级需要的 `ACCEPTANCE.md` 由交叉审读阶段产生，现在没有是正常的。
  · F2/协调者 · 部分待用户决定
- **协调者裁定（用户授权 2026-11-03）**：
  - **Starlark 与音频解码**：把 Rust 的同一批 crate（`starlark =0.14.2`、`symphonia =0.5.5`）连同项目中对应的胶水代码
    （`ptc_runtime.rs` 的求值部分、`dstu-media/src/media/decoder.rs` 的解码、混音与重采样）原样编译成一个
    **wasm32-wasip1 预编译产物**（`host/platform/native/wasm/`），产物和构建脚本一起入库，Node 侧通过 `node:wasi` 加载。
    这是唯一能保证与原实现逐位一致的方案：Go 版 starlark 的语义不同；ffmpeg 的解码和重采样结果与 Symphonia 不同，
    体积和许可证也更重。整个过程只编译一次（锁定版本不变就不重编），用户和开发者都不需要 Rust 工具链。
    F7 获得仅限此 crate 的 cargo 豁免。
  - **macOS 原生窗口外观**：用 `koffi@3.3.3`（N-API 预编译，DSH 桌面版同样在用）通过 objc runtime FFI，逐行移植
    `cmd/window_effects.rs` 中对 NSWindow / NSVisualEffectView / NSAppearance 的调用，语义与 Rust 一致，无需编译。
    其他平台沿用 Rust 的平台分支行为。归 F2。
  - **移动端专属测试**：被测代码只在 `cfg(target_os = "android"/"ios")` 下编译，或只对 `content://`/SAF 有意义的测试，
    允许标为 `obsolete:mobile-only`（移动端继续用 Rust，这些测试原样保留在 Rust 中）。L22 须逐条给出 cfg 证据，
    协调者核实后写入 approvals.json；与平台无关的测试（例如 lease/rollback 等通用逻辑）不在此列。
  · 协调者 · 已决

## 2026-11-04 架构裁定（回应 C1/C2 协调者上报）

以下为架构师裁定，所有 lane 与协调者以此为准；与旧描述冲突时以本节为准。

### D1 单写者下的跨插件原子事务：`*WithConn` 接缝
Rust 里大量跨模块原子操作靠"在同一个 `&Connection`/事务里依次调用各模块的 `_with_conn` 函数"实现。迁移后保持同一形态：
- **表的所有者**在自己的 `api.ts` 发布与 Rust `xxx_with_conn` 一一对应的业务方法，签名带一个可选的连接/事务参数（F3 的 `SqlExecutor`），方法内部的 SQL 仍只在所有者的 `repository/` 里。
- **调用方**用平台存储开启事务（`storage` 的事务接口），把同一个连接依次传给各所有者的 `*WithConn` 方法——与 Rust 的事务边界完全一致。
- 禁止：调用方自己写别人表的 SQL；为了"单写者"把一个 Rust 原子操作拆成多次独立提交；暴露"原始连接 + 任意 SQL"的通道给非所有者。
- 归属：题目表 L11（业务编排 L14），FSRS 状态 L15，卡片 L16，chat 表 L04，settings F4，memory receipt L17，笔记与删除 journal L10。具体方法清单由各消费方向所有者请求、所有者发布，协调者撮合。

### D2 共享操作许可、启动闸门与恢复收尾
- **操作许可（数据治理锁）只有一个实例，归 L21（backup）**，对应 Rust `backup_common.rs:112-155`。L21 在 `api.ts` 发布：`tryAcquireOperation(kind)`、带超时的 `acquireOperation(kind, timeoutMs)`（对应 `commands_sync.rs:2583-2594`）、返回的 guard 必须显式 `release()`（调用方 `try/finally`）。L20/L22/L23/L05 的删除传播一律用它，**不得各自建局部锁**。
- **启动闸门与恢复收尾**：平台层不得依赖业务插件。F3 在 `host/platform/storage` 提供启动钩子注册点（如 `startup.registerFinalizer(name, fn, { after })`），按 Rust 启动顺序执行；L21 的恢复 finalize、F2 的 `startupGate` 消费都通过它挂接。F3 负责定义顺序并写进 API.md，业务插件只注册。
- 跨进程锁：Rust 若有文件锁/跨进程互斥，按原实现保留（F3/F4 平台原语）；没有的不新增。

### D3 大整数与时间精度
- **Host 内部必须精确**：数据库读写对 i64/u64 列使用精确表示（better-sqlite3 的 `safeIntegers` 或 BigInt），游标、版本号、字节数等写回数据库或参与比较/排序的值不得经过 JS number。manifest 的纳秒时间戳按字符串/BigInt 精确解析与比较，不得 `Date.parse` 截断。
- **IPC 线上表示与 Rust/Tauri 一致**：Tauri 经 serde_json 输出 JSON 数字，前端 `JSON.parse` 本就会对超过 2^53 的数丢精度——Host 在 IPC 边界按同样的 JSON 数字输出（BigInt 在边界转为 number，超出安全范围的值的行为与 Rust→前端完全相同），**不比原版更严格，也不更宽松**；不得因为"可能丢精度"就拒绝请求。
- F1 的 IPC 层据此把 BigInt 序列化为 JSON 数字，而不是拒绝。

### D4 `SqlExecutor` 的公开范围
`SqlExecutor` 只用于两处：所有者插件内部，和 D1 的 `*WithConn` 事务接缝（调用方只"传递"它，不用它执行 SQL）。ARCHITECTURE 中"跨插件只走业务 API"的原则不变；R11-03 按此整改，不做批量改名。

### D5 依赖与能力范围
- **sharp**：批准从 devDependencies 提升为 dependencies（F7 图片缩放/裁剪/编码）。打包时由 electron-builder `asarUnpack` 处理原生模块（F2 跟进）。
- **undici@7.30.1**：批准提升为直接依赖（L02 已在用，版本与当前安装一致）。
- **libheif-js：不批准。** Rust 桌面端 `convert_heic_to_jpeg` 明确返回校验错误（`heic_decoder.rs:135-140`，只有 Android 原生解码），Host 必须保持这一行为。另：macOS 上原先由 WKWebView 原生解码的 HEIC 预览，在 Chromium 下会失效——这是**换平台带来的前端能力退化**，记入前端插件化待办，由架构师在前端侧统一评估（可能的方案在前端而非后端命令），lane 不要在后端命令里补。
- **PDFium 7689 vs Rust 7350**：允许使用 F7 已集成的版本，但"文本抽取/渲染与 Rust 等价"不能凭导出存在签收：F7 用一组代表性 PDF 记录两版本的抽取结果差异（golden），差异进 C 级动态验证清单。
- **sharp 的 JPEG/缩放与 Rust image crate**：等价判据为尺寸、格式、质量参数、输出大小上限、越界/反向 bbox 行为一致；像素差异需给出实测 PSNR 并在 SPEC 记录容差。没有这些证据前，相关测试不得标 ported。

### D6 其他
- **HPIAS / generative_ui executor 归属**：以 `docs/dev/electron-migration/inventory/lanes.json`（inventory 按 Rust 文件归属生成）为唯一依据；C2 查清后通知相关 lane，L17 只负责自己的 HPIAS 服务与公开契约。
- **L03 五个零断言的 `#[ignore]` 占位测试**：Rust 中没有任何断言、被 ignore 的占位测试，可申请 obsolete（证据：测试体为空/无断言 + ignore 标注），由 C1 批准。
- **F1 Mutex poisoning 测试**：JS 没有锁中毒概念。可申请 obsolete，但必须同时证明该测试保护的**不变量**（panic 后状态可恢复/不留半写状态）已由其他 TS 测试覆盖，并在 TESTMAP 写明对应测试；只写"语言没有此概念"不批准。
- **F1 QR mask**：必须与 Rust 一致（按 penalty 选择 mask），"同样可扫描"不构成等价——已派回 F1。
- **审批分片**：`migration/approvals.d/<协调者>.json` 已在台账中合并读取（随协调者基础设施提交进入 main）。

### D7 同步数据应用的归属（L20 ↔ L21 循环等待）
- `applyDownloadedChangesToDatabases(changes, strategy, …)` **归 L20 所有**：复用 L20 已有实现（`host/plugins/sync/repository/apply-databases.ts`），在 `api.ts` 公开为业务入口；L20 的 `run_sync` 在本插件内直接绑定该实现（`record-progress.ts` 的 `SyncDatabaseApplication` 端口由 L20 自己提供，不再向 L21 要）。
- L21 只提供共享操作许可（D2）、云配置 SSOT 水合与审计，经 `backup` 的 `api.ts` 公开；L20 注入 `backup` 消费它们。
- L21 的 `commands_backup` 中需要同步应用的路径，**按需获取** L20 服务（`ctx.get('sync')`，用到时取，缺失时明确报错），**不在 inject 中声明** `sync`——避免 backup ↔ sync 双向注入导致两个插件都无法启动（同 vfs-repos ↔ notes 的处理）。不复制两份实现、不做跨 lane 文件交接。

### D8 混合测试（现行断言 + 已废弃分支断言）的记账
- 一个 Rust 测试同时断言现行路径与已无生产调用的废弃分支（如固定禁用的快照上传、已废弃的 `execute_upload`）时：**现行断言必须全部移植**，满足后该测试可标 `ported`；废弃分支的子断言不移植，也不得为通过测试而启用废弃代码。
- 记账：TESTMAP 该行备注逐条列出未移植的子断言及 Rust 证据（弃用常量/零生产调用的文件:行），并在协调者审批分片中登记 `"partialObsolete": { "<测试 id>": "核实依据" }`（台账不据此计分，供独立复核检查）。现行断言移植不了就保持 `pending`，不得整条申请 obsolete。

### D9 Office 生成依赖与沙箱系统依赖
- 批准 `docx@9.15.2`、`pptxgenjs@4.0.1`（MIT）为生产依赖，分别对应 Rust docx-rs 0.4.19 / ppt-rs 0.2.14；`exceljs@4.4.0` 已有，对应 umya-spreadsheet。等价判据：文档结构、文本、字体、页边、图注、图片数量与尺寸（EMU）一致；ZIP 打包字节不要求相同；库错误文案与极端数值差异在 SPEC 记录并交复核。
- 编辑类能力不得用生成接口冒充；未提供的二进制抽取按格式逐项选成熟库，另行申请。
- libheif-js 维持不批准（D5）：F7 已实现的桌面 HEIC 解码不得接入后端命令，保留在 F7 内并标注"未批准、未接线"。
- 沙箱测试的系统依赖 bubblewrap 已安装到服务器（prlimit 随 util-linux 已有）；打包与目标平台（macOS Seatbelt、Windows AppContainer）未验证项如实保留。
- `host/profiles/desktop.json` 接入 F7 新增的 `dstu.vector`：由 F1 用 profile 生成器重生成，不手改。

## D10（2026-11-04）：批准 pngjs@7.0.0、jpeg-js@0.4.4

- 用途：F7 nativeImage 的 PNG/JPEG 编码 worker（host/platform/native/image/encode-worker.mjs），以及 DOCX 内嵌图片。
- 理由：纯 JS、无原生依赖，可替代在 Electron 中触发 GLib-GObject 警告的 sharp 编码路径。
  它们缺失时，压缩图片、试卷 docx 图片、讲义 docx 图片都会失败或被静默降级为占位符（F7 NEEDS.md 已长期申请）。
- 精确版本锁定；@node-rs/argon2、tiktoken 的申请另行裁定。

## D11（2026-11-05）：批准 tiktoken@1.0.22、@node-rs/argon2@2.2.2

- tiktoken：OpenAI 官方 WASM 移植，与 Rust tiktoken-rs 使用同一 BPE 词表，用于桌面精确 token 计数（Rust 默认启用 tokenizer_tiktoken feature）。main 上已有代码依赖它，缺包导致基线测试红灯（F7 NEEDS.md、L02、L03 均报告）。
- @node-rs/argon2：N-API 预编译（ABI 稳定，Electron 无需重编），与 Rust dstu-security 的 argon2 密钥派生对齐。
- 精确版本锁定。
