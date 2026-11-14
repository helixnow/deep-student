# F3-storage 当前状态与下一步（2026-11-04 新会话交接）

## G1 caller_id（2026-11-06，commander 指令）

X1 报 `llm_usage_session_summary` → `no such column: caller_id`。8 个 llm_usage 迁移都没有该列；
Rust 写入 record.caller_id 到 session_id（repo.rs:49/73、collector.rs:299）、读取从 session_id 映射
（repo.rs:497/523），仅 get_session_usage（repo.rs:464）误写 caller_id，Rust 同样失败且无 Rust 测试。
按指令改查询为 `WHERE session_id = ?`（llm-usage.ts getSessionUsage），不加迁移、schema 不变。
这是有意偏离 Rust 原缺陷，已在代码注释与 SPEC 记录，需写入 decisions.md。
测试 `tests/llm-usage-session-summary.test.ts`：全新库与 V20260130 历史库启动升级到 V20260826，
经 kernel 命令断言计数/token/成本。修复前 `20261106013627-71d4bd` 2 failed（同 X1 错误），
修复后 Node `20261106013715-b80f72` 44 passed / exit0；Electron 见报告。

## WP-164（2026-11-05）：同一连接 busy handler 供方接缝

恢复时保留 `771724634` / `c08e4c85c` 自动检查点与 WP-140 全部历史；原起点
typecheck `20261105194725-ae7c20` exit0、定向 `20261105194725-14784f` 17passed/exit0 已核原件。
F7 WP-161 `94e6fa92f` 已经 main `676b29852` 发布，当前直接消费 `NativeSqliteBusy` 公共类型。
Connection / StartupDatabase 均提供单参数 `setBusyHandler(handler|null): void`，通过可选开库
参数 `nativeSqliteBusy` 使用既有连接；pre-storage 不需要 ctx.storage。旧开库调用保持不变。
测试 `tests/startup-busy-handler.test.ts` 经真实 F7 插件 provider 与 F3 api 工厂，独立 worker
持有同次 step 的回调屏障，覆盖成功/拒绝/异常、替换/null/timeout/close。
F3 原362行 pending 0→0；这里只交付平台原语，S06 业务用例仍由 L20b 接入。
非 Linux-x64 产物、Rust panic hook 观测及 D35 性能预算仍独立；最终 jobs 见 WP-164 报告。

## WP-081（2026-11-06）：完整诊断慢阶段已实测，5s 未闭合

本包仅定位 WP-005 的完整串行 C/D，不续做历史余项。main 已有正式 MigrationWorker.runAll。
Node 首份证据 `20261105180542-66dab8`：C/D direct runner 8666.51ms；C冷worker/加载1070ms，
C原生1084次fsync累计2398ms；C/D校验1681/1707ms，其中scratch重放947/1039ms。
真实 syscall CLOCK_MONOTONIC 与 JS hrtime 分阶段对齐，不再凭 CPU profile 把全部 COMMIT 时间叫 fsync。
测量源码、复跑方法、约束及后续结果见 `WP-081-PERFORMANCE.md`。
Rust refinery每条SQL/history独立提交、每次指纹scratch重放均已核对；尚无有证据的等价主要开销删减。
已向C2投递测量候选0ffa29d69，请组合L21原诊断测试；不改其测试。D35保持open。
最终补充：无探针Node13828.93ms，Electron测量15643.01ms，均同输入、完整结果一致；
源码未发现可安全删除的主要开销，未提交生产优化。官方lane-gate@0ffa29d69五项通过，
自动目录测试606passed/1既有fixture环境skip，最小worker Node/Electron各3passed；详见 `WP-081-report.md`。

## WP-008 / B5-D17（2026-11-05，单工作包）

本次依 WORKER.md 仅处理 L20b 的真实 SQLite busy 等待观测。
已 merge main `967f43c75`，并用 git show 核实 api.ts/openStartupDatabase 已在 main；
D18 startup 与 llmUsage 公开面不是本包剩余任务。起点工作树干净。
已审读 Rust `state.rs:597-664` 全测试与 `:224-288` 生产事务，以及本机安装的
better-sqlite3 13.0.3 JS/C++/SQLite 源码：需同一次 sqlite3_step 内的 handler 通知和暂停，
现有 timeout/verbose/Statement.busy 无法等价提供。详见 `L20B-OBSERVABILITY.md` WP-008 节。

交付为可复跑能力探针、真实 worker/双连接负控、原生最小签名与取消/释放验收协议。
S06 仍需架构师/F7 的同一绑定增补，不以 JS BUSY 重试冒充 handler；F3 pending 保持 0，
L20b `tombstone_sequence_waits_for_writer_before_reading` 保持 pending。完成交付后依协议
wp-done WP-008 结束；历史“自动续派/无剩余工作”段落不覆盖本次 WORKER.md。

起点 typecheck job `20261105140052-290edb` exit 0；database/startup 两文件
`20261105140052-b4d09a` 47 passed / exit 0。WP 定向 Node `20261105140509-cee8ea` /
Electron `20261105140509-13217d` 各 4 passed / 0 failed / 0 skipped / exit 0，无 Errors。
运行时探针 `20261105140509-7b2828` / `20261105140509-dafe16` exit 0，均 SQLite 3.53.4。

台账校正：合并后的 main/HEAD 实际 362 行为 ported 324 / merged 8 / obsolete 30 / pending 0；
旧文档表头和下方“剩余 3 条”是历史记录，main 已将两个 Anki 与一个 JPEG 用例映射为 ported。
本包不重审/改动这些既有映射，不把它们计为 WP-008 产出。L20b 实际 40 行为 39 ported / 1 pending。

## v2 接手盘点（2026-11-04，进行中）

### L02 无损预算接缝（15:20 UTC）

实际 injectionBudget provider 已增补 defaultExactConfig/createExactManager，api.ts 公开
ExactBudgetConfig/ExactAllocationResult/ExactInjectionBudgetService。预算字段/类型额度和分配
累计均 bigint，合法 u64 不经过 safe-integer cap；原 number 接口委托同一核心，保持已发布形状。
R1 向量 `9007199254740993 - 9007199254740992` 可分配一个字符；完整十进制摘要、Rust f32
百分比/舍入、clone 及五处日志均核对。原五条测试断言保留，TESTMAP 转指真实服务入口测试。
Node `20261104151748-925c83` / Electron `20261104151748-cc4988` 各17 passed / exit0，
无 Errors；typecheck `20261104150139-85ca6b` exit0；importable `20261104151748-32c80a` exit0。
L02 原文 typed decoder/重复字段三个 finding 不归入此项签收。并行提交 `6f59dd319` 已交 L18
文件 API，未重写其实现；其大小精度与共享 Value 数值范围问题已向 L18/F4 报明。

### L18 textbooks_add 所需 unified_file_manager 公开面（15:20 UTC，`6f59dd319`）

api.ts 新发布（逐分支对照 `dstu-storage/src/unified_file_manager.rs`）：
`readAllBytesBounded(path, maxBytes): Promise<Buffer>`（:206，本地 metadata 预检带实际大小 +
读取上限 max+1 防 TOCTOU；Validation/FileSystem 文案同 Rust）、`getFileSize(path): number`（:677）、
`hashFileSha256(path): Promise<string>`（:711，64KB 流式小写 hex）、
`resolveFileInfo(path): [name, ext|null]`（:1014 三层，含 `detectExtensionFromMagic` :768 与 ZIP 子类型
:877、JSON/CSV/MD/txt 启发式，从不抛错）、`isOpaqueDocumentId`（:991）、`extractFileName`/
`extractExtension`（:652/:665）、`sanitizeFileNameForFs`（:979）。虚拟 URI（content:// 等）桌面无
SAF，沿用 `读取文件失败: <uri> (虚拟路径在当前平台不可用)` fail-close。`decodePath` 改为
`urlencoding::decode` 语义（非法 %XX 原样保留，非 UTF-8 回退原文）。契约测试
`tests/unified-file-manager-read.test.ts`（22 条，经 api.ts）。

repairs.test.ts `pre_repair_vfs_v20260824_note_props` 集成超时（43.8s）：夹具已是 :memory:，单测
无负载约 330ms（迁移 SQL exec ~250ms + 每例重新读盘并以逐字节 BigInt SipHash 重算全部迁移
checksum ~130ms），43.8s 是集成高负载下的 CPU 饥饿。处理：refinery SipHash-1-3 改 u32 hi/lo
实现（~6x，132 个迁移文件 + 3000 组随机带密钥流式差分逐位一致，`refinery-checksum.test.ts` 通过），
测试按库缓存不可变 Runner；未放宽超时。

### F4 主线能力消费（14:24 UTC）

祖先检查与工作树代码确认 F4 `2d9d56497` 已在 main；JsonReader/base64 不再是接口阻塞。
已消费正式 decodeBase64Standard：上传保留 crate 错误文案，base64 上限先按 UTF-8 字节判断；
图片非法尾位 `AB==` 原串返回而非变成 `AA==`，保留完整 error 原因及 Rust target。
旧实现回归 7 failed（`20261104141704-9a5eeb`），修复后 Node/Electron 各 37 passed /
exit 0（`20261104142339-f96491` / `20261104142339-5997a4`），无 Errors；类型检查 exit 0。
恢复/featureFlags 的逐字段流式 decoder 仍待 F3 实现，后续从 nextKey→typed read→fieldError/end
接入，不把完整 AST 读完再校验当作错误顺序等价。L05 最新提供方/自检收据见 BLOCKERS。

### 13:25 后门禁与接口收尾证据

- 最新全目录 job `20261104132512-ec2950`：40 files / **544 passed / 1 条既有条件跳过 /
  exit 0，无 Errors**。typecheck `20261104132512-76e07d`、普通 boundaries
  `20261104132512-85db28` 均 exit 0。该次全目录采集后新增的迁移 worker 及无 config 回归
  用下列最小集单独验证，不并入 544 的计数。
- gate 两条 VFS timeout 已按 Rust `coordinator.rs:5551` 修夹具：两处 buildV0944Vfs
  使用 open_in_memory 等价连接，原 notes.props/保留数据/history/checksum 断言不变。
  repairs 两条默认 30s 未放宽，完整集实测 725ms / 419ms。
- P0 官方 profile 缺省 config：`04e6c7ef7` 中 apply 默认 `{}`；真实 bare storage 安装
  + 显式 migrationsDir 优先错误 env 回归。Node `20261104134414-3912e6` 16 passed，
  Electron `20261104134414-f68425`（含迁移/retention）25 passed，typecheck
  `20261104134414-9870ca` exit 0，均无 Errors。已通知 F1/C2 优先独立集成此小提交。
- L10：六方法 registerDeletionJournal/精确 bigint 类型已从 api.ts 发布；retention 现返回
  Slot/Disposer。L10 `8e423d0dc` 为真实仓储候选，待正常 main 集成和 scope 注册后 F3 才做 SQL
  委托；当前没有用测试仓储冒充生产 owner。retention 新测试已补 Rust history-table 存在前提。
- L21：createMigrationWorker({baseDir}).runAll({appDataDir,migrationsDir?,auditDbPath?})（第六轮删去未生效的 logTarget）
  执行真实完整 coordinator；报告/health、错误字段、日志、close drain、进程备份 guard 同步已实现。
  Node `20261104133243-609573` 25 passed，Electron `20261104134414-f68425` 25 passed，
  均 exit 0、无 Errors。其消费者完整诊断/克隆接入仍待 L21。
- F4 `2d9d56497` Reader/base64 公共接口已交候选，待集成；F3 的 typed decoder 仍是自有余项。
- 架构师已宣布忽略 22:00 工具故障反馈（gate-excerpt 导入错误）；未为该故障改业务代码。

### L05 / L20 公共接缝交付（12:55 UTC）

- L05：api.ts 发布 `registerWorkspaceIndexDeletionOwner((conn, workspaceId) => void): Disposer`。
  prepare 的 SAVEPOINT → prepared INSERT → owner → RELEASE 顺序不变；F3 已删除直接
  workspace_index DELETE。真实 L05 仓储测试验证同连接、SQL 失败回滚、缺记录成功、文件未删、
  SlotOccupied/卸载生命周期；L05 已确认接口，待 F3 正常进 main 后从 index 注册。
  journal/outbox 的 L10 所有权余项仍未闭合。
- L20 R4-SYNC-06：api.ts 公开 worker 工厂/类型、四个文件 API；新 `runWithDatabases` 调
  `multiDatabaseWorkerTasks`。任务 openExisting 默认只读、不创建缺库或目录、不重新解析槽位；
  `{ readonly: false }` 保留 Rust open_sync_connection 的读写打开条件，但仍 mustExist。
  ctx.log 消息经 worker context.log 送回父 Host，所有句柄在任务 finally 关闭，错误字段保真。
  L20 自己实现整段导出/缓冲序列化/staging 清理，并注册 pool 到真实 storage 维护屏障。
- 最新验证：Node `20261104125243-2a2bbb`、Electron `20261104125243-54f411` 各 24 passed /
  exit 0，无 Errors；typecheck `20261104125243-ef7c24` exit 0；importable
  `20261104124146-6a69c7` exit 0。更早的 database 回归也在 Node 58 / Electron 59 项集中通过。
  strict `20261104124654-8236be` exit 1，仍为四条 L13 违规，F3 无违规行。
  正式 lane-gate 的生成账本 dirty 前置阻塞仍另列，不能据定向绿色宣称整链验收完成。

### §5 自检前置阻塞（新工作流首次执行）

自有改动已提交；合并 main 至 `f7a447e9b` 后运行官方 `lane-gate.mjs`，退出码 **2**，
检查尚未入队。脚本 `:28-31` 拦截全部 tracked dirty 文件；本工作树从接手开始就有
`migration/LEDGER.md`、`migration/ledger.json` 的既存生成改动（58 / 14414 行 diff）。
两文件不在允许提交范围，且原任务禁止提交生成账本；F3 保留这些改动，不提交他人工作、
不还原、不改索引隐藏状态、不绕过自检。已请求协调者处理生成账本状态或提供正式规则。
此项不是“自检通过”；仍有 v2 自有余项及跨 lane 依赖，不能回复“无剩余工作”。

旧 A 级统计不等于 v2 验收通过。当前目录没有 `ACCEPTANCE.md`；本 lane 的 SPEC 位于
`migration/spec/F3-storage.md`。复核派发未列未勾选 finding，下面为接手自查发现，不能算跨 lane 阻塞。

- 基线：`b3b4c9991` 合并 main；typecheck job `20261104094622-0618f7` exit 0；
  boundaries job `20261104094622-d84d0e` exit 0。
- 全套 job `20261104094622-53d660`：36 files passed，507 passed / 1 skipped，
  **Errors 2 / exit 1**，两条 `Timeout calling "onTaskUpdate"`，不得报告通过。
- ledger job `20261104094621-636f26` exit 0；生成账本已有他人未提交修改，保持不动。

### 已验证修复（2026-11-04 11:14 UTC）

- **F3-V2-04**：coordinator / migration-integration / anki-domain 用例清理后，
  migration-compat 的历史 fixture 之间让出一次事件循环；未删改任何 Rust 对应断言。
  全套 `20261104110931-0395fc`：37 files passed，514 passed / 1 skipped，exit 0，
  无 Errors / Unhandled Errors。此前 Errors 2、Errors 1 的失败记录仍保留，不计通过。
- **F3-V2-03（本次子项）**：登记 TTL 改单调时钟，孤儿 mtime 保留墙钟；短写循环/零写失败，
  readBounded 读到 max+1。七条 kernel/真实文件回归先红（6 failed），后 Node 和 Electron
  各 17 passed / exit 0（`20261104110800-138210`、`20261104110946-45e171`）。
  同步 IO offload、header u64/base64 文案仍需继续审读，不把整个 staged 模块标 v2 完成。
- 类型检查 `20261104111349-6d5cf4` exit 0；普通 boundaries `20261104110800-a2a032`
  exit 0；importable `20261104110801-30f630` exit 0。
- strict `20261104105630-160796` exit 1：四项均为 L13 vfs 路径，已上报（BLOCKERS 顶部）。
  wiring `20261104110801-c6acec` 返回 `合计 ported 0，其中所测模块未从 index.ts 接入 0（0%）`，
  这个参数下未扫描到 F3 台账，不能当 362 项接线通过的证据。
- 修复由协调者自动检查点保存于 `1cc1052ad`、`dc4ad4eaa`、`aecdf4213`、`684368218`；
  v2 接手盘点在 `bb54a530a`。尚待集成和独立复验签收。

### 后续进度（11:43 UTC，接 C2 指令只做最小集）

最新验证：Node `20261104114423-bcc5c1`（repairs + staged runtime + featureFlags）47 passed / exit 0；
Electron gate `20261104114330-df8fd9` 5 passed / exit 0；typecheck `20261104114016-807a86`
exit 0；importable `20261104114330-fab974` exit 0，均无 Errors。
strict `20261104114330-384fa5` exit 1，仍为四条 L13 vfs 违规，F3 无违规行。

- F3-V2-06：已消费 main 的真实 F2 gate，正常/恢复模式均等待，120s 超时精确返回 AppError；
  状态读取失败映射与缺 provider 显式失败已覆盖。真实 F2 shell + F3 经 kernel 的
  `20261104114016-056342`：3 files / 20 passed / exit 0，无 Errors。
- F3-V2-02：版本比较恢复 Vec<u64> 字典序（不补尾零、精确大整数、非法/溢出片段=0）；
  设置读取错误恢复 `Failed to load feature flags: ` 前缀。旧实现七条失败，新实现 Electron
  `20261104112959-c89686` 与 staged 合计 4 files / 42 passed / exit 0，无 Errors。
- F3-V2-03：header offset 支持 `+0` 与完整 u64，保留 >2^53 原文用于错误；JSON 已解码
  整数不额外限制 safe integer。定向 `20261104112623-5b5bc0`：6 passed / exit 0；
  另 7 条为 `-t u64` 过滤，非源码 skip；Electron 42 passed 包含全部 13 条 staged 回归。
- 11:22 重跑全套 `20261104112233-89e238`：**2 suites failed（新增 fixture beforeAll
  超过 10s）/ 507 passed / 24 runner-skipped / Errors 1 / exit 1**，不计通过。
  为真实全量迁移 fixture 明确设置 60s hook 预算；两项新 fixture 不含 Rust 业务超时断言。
  同次 repairs 文件同步执行 99s、startup 76s，补用例间 setImmediate；原断言不变。
  C2 已亲取 a5b6c8a8d 的 514 passed 基线，不要求再重复全套；后继只跑实际变更最小集。
- 纠正文档：F1 finishStartup/F2 profile gate、L11 注册均已在 main；F3 registry 未合入、
  必需 finalizer 注册失败政策、W13 L20 provider 分别跟踪。F1 已给出生成器 bootstrap
  最小排序方案（见 STARTUP-WIRING），不再建议 finally 无条件 mark Ready。

### 自查 finding（按 v2 八类）

| ID / 模块 | 类型 | 证据与处理 |
|---|---|---|
| F3-V2-01 恢复 JSON | 1.3 / 1.6 | `data-space-files.ts:35-37` 强转泛型；`startup-recovery.ts:63-74` 只验部分字段，null 被当默认；按 Rust `data_space.rs:97-166` 补严格解码和生产入口用例 |
| F3-V2-02 featureFlags | 1.3 / 1.4 / 1.6 | `feature-flags.ts:178-183` 强转 JSON 且遗漏 load 错误前缀；`:301-305` parseInt 接受后缀；对照 Rust `feature_flags.rs:115-122,397-405` 修复 |
| F3-V2-03 staged upload | 1.7 / 1.6 | `staged-upload.ts:133,186,213,271` 用 Date.now 替代 Rust Instant；`:99-114` 只读 size+1 而 Rust :124 读 max+1；`:207,259` 单次 write 不等于 write_all |
| F3-V2-04 测试 RPC | 1.5 / 1.8 | 全套断言通过但两条 RPC 超时；定位同步长任务并让出事件循环，保留所有原断言，不继续仅加超时 |
| F3-V2-05：表归属/retention 生命周期 | 1.2 / 1.7 | `file-deletion-queue.ts:403,433,492,715-771` 仍有跨 owner 写入；`:100-104` 丢 Slot/Disposer；已向 L10/C2 请求正式 WithConn 与 scope 配合，见 BLOCKERS，未修复 |
| 待审：生产可达 | 1.1 | `index.ts:62-71` 注册 33 命令、`:82-116` provide 服务；注册可达已见，消费者和原测试逐条闭合尚未确认 |
| 待审：日志 | 1.4 | `startup-recovery.ts:37,82` 已有 warn；其他 Rust warn/error 必须逐条核对，未完成全面审读 |
| 待审：运行时 | 1.7 | `migration/coordinator.ts:97,181`、`service.ts:226` 时长用墙钟；导出 ZIP 与同步 IO 的 worker 边界待审 |

### 处理顺序与真实依赖

逐命令入口盘点如下。每行均按八类检查：接线落点已确认；表所有权、serde、日志/错误、
原断言、全分支、运行时仍需源码复核，不因旧勾选标通过；闭环均为待独立验收。

| 命令 | 入口证据（本目录 index.ts） | 已定位风险 / 后续核对 |
|---|---|---|
| clear_test_slots | :182 | 删除错误映射、目录清理 |
| export_startup_recovery_incident | :304 | ZIP worker、失败清理 |
| export_startup_recovery_report | :329 | 恢复 serde、报告时间 |
| get_data_space_info | :159 | state.json 解码 |
| get_database_info | :193 | L22 状态所有权 |
| get_slot_directory | :186 | Rust slot 别名 |
| get_startup_recovery_status | :132 | F2 gate 等待缺口；F3-V2-01 |
| get_test_slot_info | :177 | Rust read_dir 失败计数 |
| list_startup_recovery_incidents | :134 | F3-V2-01、跳过错误 warn |
| llm_usage_by_caller | :405 | 聚合 i64、CallerType 解码 |
| llm_usage_by_model | :401 | 聚合 i64、排序 |
| llm_usage_cleanup | :425 | llm_usage_logs 单写者、错误 |
| llm_usage_daily | :421 | 聚合 i64、日期排序 |
| llm_usage_get_trends | :394 | 日期边界、未知 granularity |
| llm_usage_recent | :417 | DateTime serde、默认 limit |
| llm_usage_session_summary | :413 | 空结果、聚合精度 |
| llm_usage_summary | :409 | 日期边界、聚合精度 |
| mark_data_space_pending_switch_to_inactive | :165 | 状态持久化、错误顺序 |
| open_startup_recovery_incident_folder | :141 | spawn/平台语义 |
| purge_active_data_dir_now | :174 | 已对照 Rust :2553 固定拒绝 |
| purge_all_database_files | :170 | 已对照 Rust :2540 写 marker；重启时 W13 |
| reset_test_database | :243 | 开放连接与删除、L22 状态 |
| resolve_startup_recovery | :137 | F3-V2-01、崩溃续作 |
| restart_app | :191 | shell process restart |
| retry_startup_recovery_preflight | :133 | F3-V2-01、restart-required |
| seed_test_database | :275 | Rust 废弃播种器、finally close |
| set_test_run_id | :299 | 日志和值回显 |
| staged_upload_abort | :391 | F3-V2-03、幂等清理 |
| staged_upload_append | :370 | F3-V2-03、u64/header/base64 |
| staged_upload_begin | :366 | F3-V2-03、大小限制 |
| staged_upload_from_path | :377 | F3-V2-03、流关闭/写完整性 |
| switch_to_production_database | :266 | 两步连接切换、状态提交 |
| switch_to_test_database | :226 | 建库失败、两步切换 |

服务：storage（`:121`）含迁移/事务/维护/finalizer，dataSpace（`:82`）含恢复；
featureFlags（`:99`）对应 F3-V2-02；injectionBudget（`:105`）需核对预算算法/数值；
noteAssets（`:111`）需核对路径平台规则；imageQuality（`:116`）需 F7/L12 真实编码链。

先处理门禁 F3-V2-04，再按 F3-V2-01/02/03 补生产入口失败测试及实现；每单元提交 finding ID。
L16 两项 Agent Library/CAS、F7 JPEG、L20 pre-storage provider/profile 顺序、F2 gate 的依赖证据
见下文和 `BLOCKERS.md`，需要重新以 main 核对。除此之外的自有缺陷继续修，不算阻塞。

## 旧会话已记录的完成状态（待 v2 逐项复核）

- **命令**：`contracts/ipc/F3-storage.json` 的 33 个命令全部注册并达到 ledger A 级；
  `migration/spec/F3-storage.md` 清单全部勾选。
- **业务迁移**：data_space 启动（`initialize_on_start`、旧根迁移、待切换槽位、purge、
  恢复事件）、file_deletion_queue、startup_cleanup、staged_upload、file_manager /
  unified_file_manager、batch_operations、feature_flags、injection_budget、llm_usage、
  backup_common、migration 协调器均已有生产实现。
- **启动顺序**：`index.ts` 中 `startup.start()` 先于 `storage.impl.migrations.runAll()`；
  recovery_required 时不跑迁移。
- **测试**：ledger 362 行中 ported 321、merged 8、obsolete 30、pending 3。
  `npm run typecheck:host` 本分支合并 main 后 exit 0（job `20261104095715-821369`）。
- **已发布服务**（`api.ts` + `index.ts` provide）：`storage`、`dataSpace`、
  `featureFlags`、`injectionBudget`、`noteAssets`、`imageQuality`。
- **跨 lane 接缝已发布**：
  - D1/D4：`SqlExecutor` 版 asset/workspace deletion journal（`file-deletion-queue.ts`）。
  - D2：`ctx.storage.registerFinalizer` / `runStartupFinalizers`，失败保持 failed、
    无自动重试，注册失败不执行 callback。
  - L03：`openFile(..., { createParentDirs: false })`，保持默认递归建父目录。
  - L11：`ctx.storage.registerMaintenanceParticipant`（按库 scope、引用计数、逆序 exit）。
  - L12：`ctx.imageQuality.adjustImageQualityBytes/Base64(bytes, quality, ctx.nativeImage)`。
  - L20b：`StorageError.phase`（prepare/bind/execute）。

## 剩余 pending（3，均为真实跨 lane / 原生能力）

| Rust 测试 | 缺什么 | 证据 |
|---|---|---|
| `database/mod.rs::tests::agent_library_reads_and_content_cas_cover_null_and_foreign_sessions` | L16 分支 HEAD `fbed2b6c8` 的 `AnkiService` 已有 `listAnkiAgentLibraryCards`、`updateAnkiCardIfVersionForLibrary/ForSession`；main 未合入 | `host/plugins/anki/api.ts` 无这些方法，main 的 `repository/anki-cards.ts` 也没有 |
| `database/mod.rs::tests::agent_library_cards_by_ids_preserve_order_and_fail_closed` | L16 分支 HEAD `fbed2b6c8` 已有 `getAnkiAgentLibraryCardsByIds`；main 未合入。L24 `chatanki/api.ts` 只有接口，实现是测试替身 | 同上；`tests/chatanki-card-double.ts` 不是生产实现 |
| `file_manager.rs::image_quality_tests::bytes_quality_matches_base64_policy_and_limits_dimensions` | 需真实 `image 0.24.9` Triangle+JPEG 编码；F7 分支 `ds-mig/F7-native` 已有 `resizeAndEncodeJpeg`，main 未合入；D5 JPEG PSNR 独立未签 | main `host/platform/native/image/api.ts` 无 `resizeAndEncodeJpeg` |

## 跨 lane 集成缺口（不计入 362 行，不在 F3 内伪造）

1. **L12 图片生产接线**：`host/plugins/vfs-index/src/image-codec.ts` 仍是自有 sharp 实现，
   `pdf-runtime.ts:951` 调用它。F3 已提供正式 `ctx.imageQuality` 签名；L12 应改为
   `ctx.imageQuality.adjustImageQualityBytes(bytes, quality, ctx.nativeImage)` 并删除本地策略。
   第一条 image 测试已用真实 decode 恢复为 ported，但 L12 生产接线仍是独立缺口；第二条
   image 测试等 F7 encode 合入 main。
2. **F7 图片编码**：main 的 `NativeImage` 缺 `resizeAndEncodeJpeg`；F7 分支
   `ds-mig/F7-native` 已实现（`image` WASM resize + JPEG encode）。F7 合入 main 后才能解除
   JPEG 等价测试。
3. **L11 worker 维护**：L11 已按 F3 签名在 main 的 `index.ts:175-193` 注册
   `vfs-worker`（`databases: ['vfs']`），F3 注册方法尚待集成；main 的
   `host/plugins/vfs-repos/src/worker-entry.ts:40` 仍直接 `new SqliteDatabase(...)`，
   L13b 生产代码尚无 `createDatabaseWorkerPool` 调用。F3 合入 main 后必须用真实
   `StorageService` 重跑 enter/release 才能签收。
4. **L20b S05/S06**：S05 F3 已发布 `StorageError.phase`，待 L20b 映射；
   S06 需 F7/架构师提供带 `sqlite3_busy_handler` 的原生绑定。
5. **启动**：main 已有 F2 `dstu.shell` 的官方 profile 条目与 F1 finishStartup/mark；
   F3-V2-06 在本分支补命令等待与超时，属 F3 自有工作。W13 的 `storageStartupSync`
   已由 F3 发布接口与 `syncStateDatabasePath`，并用真实 provider 组合测试证明时序；
   但 L20 尚未提供那个**不 inject `storage`、排在 storage 之前**的 pre-storage provider；
   loader 按 inject 拓扑/就绪顺序安装，不能从目录顺序推断。F1 核实最小显式先后保证；
   在此之前生产 purge 标记路径保持 fail-closed。详见 `STARTUP-WIRING.md`。
6. **D1/D2/D4 消费方接线**：L10 需在同一事务内调 prepare + 删业务元数据；
   L21/L20b 需注册 finalizer；F1 组合根已在 main，F3 registry 尚待集成。
   证据分支 `a612c4496` 用真实 registry 通过 8 项，仍需集成后的实际组合验收。

## 下一步顺序

W13 收据：F1 `c1efab411` 候选生成器接缝已核代码与 3 passed/typecheck exit 0；尚未进 main。
等待 F1/F3/L20 正常集成后跑正式 profile 的四条真实 purge/reset 路径，详见 STARTUP-WIRING.md。
本次仅登记已核实的跨 lane 交付，不重复既有测试或混合证据分支。

1. 第一条 image 测试已用真实 64×32 PNG + 真实 invalid decode 经 `ctx.imageQuality` +
   真实 `ctx.nativeImage.dimensions` 跑通并标 ported；job `20261104083728-f20ac4` 为
   3 files / 14 passed / exit 0（含真实 WASM decode）。
2. L12 仍需删除 `image-codec.ts` 自有策略并改传 `ctx.nativeImage`；F7 encode 合入 main 前
   第二条 JPEG 等价测试保持 pending。
3. `api.ts` 的 `ImageQualityCodec` 与 main `NativeImage` 差异已在 API.md 标明：main 的
   `ctx.nativeImage` 尚缺 `resizeAndEncodeJpeg`，需 F7 合入，避免 L12 按错误签名接线。
4. 其余 pending 逐条按上表证据保持，不复制 L16/F7 逻辑。

## 2026-11-04 owner 服务：llmUsage / fileManagerPaths（L02 请求）

- `ctx.llmUsage`（`LlmUsageService`）：mod.rs:78-340 的 record_llm_usage{,_ext,_cache_ext,_cache_ext_with_identity}
  与 record_usage_record；collector 仅在 llm_usage 初始化成功时创建（lib.rs:1585），否则进 1000 条有界待写队列。
- `ctx.fileManagerPaths`（`FileManagerPathsService`）：file_manager.rs:169/237，基于活动槽目录。
- 测试 `tests/f3-owner-services.test.ts`（6 passed，job 20261104194315-d82039）；提交 62105c576、9f7c373f7；
  自检通过 b975a3d17（jobs 20261104200059-82884e / -f008cc / -2d093a）。已通知 L02（coord queue）。

## 2026-11-05 owner 服务：virtualFilePolicy（WP-059 / D29-path，L13 请求）

- `ctx.virtualFilePolicy`（`VirtualFilePolicyService`）：`{ isVirtualUri }`，直接用 api.ts 已导出的
  unified_file_manager.rs:413 实现（同一函数对象），不另写判定。meta.provides 已声明，
  在 `startup.start()` 前 provide，恢复模式可用；storage 卸载时撤销。
- 消费方：L13 `host/plugins/vfs/index.ts:216` 的 mindmap_import 注入组（Rust builtin_resource_executor.rs:2901）。
  签名与 L13 自定义的 `VirtualFilePolicy { isVirtualUri(path: string): boolean }` 结构一致。
- 测试 `tests/virtual-file-policy-service.test.ts`；用法见 API.md §9.5。

## 2026-11-05 迁移启动 CPU 证据（WP-059 门禁收口时采集，供 WP-081；本包未改实现）

- 现象：测试 Host 每次在空目录上启动都跑全新安装迁移，负载下约 9.5s/次；在已迁移目录上重启约 2.8s
  （job 20261105161620-54f73b 三轮 10.8/10.1/9.5s；job 20261105163931-48c9a9：首启 9525ms，
  二次 runAll 2298ms = vfs 1302 / chat_v2 361 / mistakes 351 / llm_usage 62，迁移后重启 2843ms）。
- cpu-prof（job 20261105163931-48c9a9）总计 17.0s，其中 coordinator.runAll 13.2s：
  - better-sqlite3 `exec` 自耗时 9.96s，主要在 refinery.executeInTransaction → `commit`（connection.ts:271）5.54s，
    即每个迁移单独提交、synchronous=FULL 下的 fsync；
  - verifyMigrations 5.38s，其中 verifySchemaFingerprint → buildMigrationScratch 3.46s（重放迁移到 scratch 库）。
  - 测试侧另有 resolveContracts/fromDirectory 1.1s、模块加载约 1.4s。
- 原始 profile 与脚本：/tmp/opencode/WP-081-evidence/（`CPU.*.cpuprofile`、one.mts、start.mts、sum.mjs）。
- 改动须对照 Rust refinery 的逐迁移事务与 fingerprint 校验语义；本条只记证据，不是方案。

## 2026-11-06 WP-127：撤回 2dfdc4ff4 的 fixture 与 60s hook

- 2dfdc4ff4 给 `tests/f3-owner-services.test.ts` 加了 beforeAll 预迁移模板目录（60000ms hook），每个用例复制该目录。
  这是未经批准的预算变化，已在 5f01d320a 用窄反向补丁撤回，文件与 main（62105c576）一致：
  每个用例仍在独立空目录上真实全新安装迁移，testTimeout 默认 30s，断言不变。
- 原预算低并发证据：C2 job 20261105162300-df207c（两例 2 passed，5.0s/7.3s）；本包 job 20261105173052-1d565f
  （单 fork，6 passed，最长 7.8s）。集成负载下的 30s 超时没有修复，根因（全新安装迁移耗时）留给 WP-081。
