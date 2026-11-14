# F3 存储：Rust 测试去向

TS 测试在 `host/platform/storage/tests/`（Anki 数据库方法经 L16 的
`host/plugins/anki/repository/`、设备身份经 `host/platform/paths/` 验证），测试标题包含原 Rust fn 名。

运行：`npx vitest run -c vitest.host.config.ts host/platform/storage`
（plain node；`better-sqlite3` 相关用例再用 `npm run test:host:electron`）。

状态（与 `migration/testmap/F3-storage.md` 的 362 行一致）：
**ported 324 · merged 8 · obsolete 30（已批准）· pending 0**（2026-11-05 按 main 实际行重计；旧表头滞后）。

## dstu-storage/src/migration/

| Rust 文件 | 测试数 | 去向 |
|---|---|---|
| `coordinator.rs` | 72 | ported：`coordinator.test.ts`、`repairs.test.ts`、`backup.test.ts` |
| `mod.rs` | 6 | ported：`definitions.test.ts`、`script-checker.test.ts` |
| `vfs.rs` / `chat_v2.rs` / `mistakes.rs` / `llm_usage.rs` | 12 / 10 / 8 / 6 | ported：`definitions.test.ts` |
| `verifier.rs` | 2 | ported：`verifier.test.ts` |
| `script_checker.rs` | 26 | ported：`script-checker.test.ts` |
| `definitions.rs` / `fault_injection.rs` | 0 | — |

## dstu-storage/src/ 其他

| Rust 文件 | 测试数 | 去向 |
|---|---|---|
| `schema_registry.rs` | 12 | ported：`schema-registry.test.ts` |
| `data_space.rs` | 34 | ported：`data-space.test.ts`（22）、`locations.test.ts`（4）、`startup-recovery.test.ts`（7）、`recovery-export.test.ts`（1） |
| `data_space/device_id.rs` | 10 | ported：`host/platform/paths/paths.test.ts` |
| `database/maintenance.rs` | 5 | merged：`database.test.ts`（替换 Rust r2d2 占位池的等价断言） |
| `database/manager.rs` | 3 | merged：`database.test.ts` |
| `database/mod.rs` | 24 | ported 23：`database.test.ts`（2）、`settings-consumer.test.ts`（1）、`settings-secrets.test.ts`（5）、`anki-domain.test.ts`（15）；obsolete 1（C2 已批准） |
| `llm_usage/*` | 35 | ported：`llm-usage.test.ts` |
| `audit/mod.rs` | 0 | 迁移审计已移植于 `migration/audit-log.ts`，由 `backup.test.ts` 覆盖 |
| `file_deletion_queue.rs` | 7 | ported：`file-deletion-queue.test.ts` |
| `startup_cleanup.rs` / `batch_operations.rs` | 0 | 代码已移植（`startup-cleanup.ts` / `batch-operations.ts`），无 Rust 测试 |
| `backup_common.rs` | 25 | ported：`backup-common.test.ts` |
| `file_manager.rs` | 5 | ported 5：`file-manager.test.ts`（路径安全 3）、`image-quality-service.test.ts`（真实 64×32 PNG decode 1）、`image-quality-native.test.ts`（1，main 已有映射） |
| `unified_file_manager.rs` | 8 | ported：`unified-file-manager.test.ts`；读取侧公开面（无 Rust 测试）补契约测试 `unified-file-manager-read.test.ts` |
| `staged_upload.rs` | 9 | ported：`staged-upload.test.ts` |
| `feature_flags.rs` / `injection_budget.rs` | 8 / 5 | ported：`feature-flags.test.ts` / `injection-budget-exact.test.ts`（真实服务；旧 `injection-budget.test.ts` 五条兼容断言保留） |

## tests/

| Rust 文件 | 测试数 | 去向 |
|---|---|---|
| `tests/migration_fixture_upgrade_gate.rs` | 1 | ported：`migration-integration.test.ts`（未设 `MIGRATION_FIXTURE_ROOT` 时按环境跳过） |
| `tests/migration_tests.rs` | 29 | obsolete：整文件 `#![cfg(feature = "old_migration_impl")]`，该 feature 从未启用（`migration/approvals.json` 已批准） |

## 本 lane 新增（无 Rust 对应）

G1：`tests/llm-usage-session-summary.test.ts` 经真实 kernel 命令 `llm_usage_session_summary`
验证全新库和 V20260130→V20260826 启动升级库。Rust `repo.rs:451` get_session_usage 无原测试，
不增加 362 行；pending 0→0。

WP-164：`tests/startup-busy-handler.test.ts` 经真实 F7 provider 和公开 `openStartupDatabase`，
对照完整 Rust `dstu-sync/src/data_governance/sync/state.rs:597-664`：:653 waiting 对应 worker
在 handler 内发消息并暂停；:657 COMMIT 对应父连接在放行前提交成功；:658-662 已提交行
可见性对应 lock_probe count=1 后再写入总数=2。最后一项不是业务 seq=2，故只算平台原语
证据，不能替代 L20b 的 S06 移植。另覆盖 rusqlite 0.40.1 busy.rs:36-69 的 true/false、
priorInvocations、替换/null/timeout、异常吞为false、checkpoint busy行与close释放锁。
F3 362条 pending 前0→后0，未变更原行去向；L20b 原行保持 pending，交消费方后续接入。
Node `20261105200740-5938f6` / Electron `20261105200740-59ee10` 各2files/11passed/
0failed/0skipped/raw exit0，无Errors（新增原语9条 + 既有startup-database 2条）。

WP-081：`tests/migration-profile.mjs` 经正式MigrationWorker.runAll测串行完整C/D，
`migration-profile-hooks.mjs` 为显式测量preload，`migration-profile-io.c`测真实Linux同步syscall，
`migration-profile-summary.mjs`比较原报告/日志顺序及schema/history/checksum/fingerprint。
它们是性能定位工具，不是Rust测试新映射，也不替代L21原5s诊断验收。pending前0→后0，原362行去向未改。

WP-008（2026-11-05）：`tests/busy-capability.test.ts` 是真实平台能力证据，不计入 362 行。
经 api.ts 的 openStartupDatabase：独立 worker 的 IMMEDIATE 争用返回真实 SQLITE_BUSY，
返回后无事务/读锁，writer 可提交，新一次尝试读到提交；DEFERRED 读后升级失败仍持读锁，
writer COMMIT 被阻塞，rollback/close 释放并撤销未提交写入。`busy-capability-probe.mjs`
打印已安装驱动/SQLite/runtime 版本与公开方法。
这些断言不能替代 Rust state.rs:653 的“同次调用正在 handler 内暂停”通知；L20b 原用例仍 pending。
合并 main 后 F3 pending 前 0 → 后 0，未更改任何 Rust 行映射。具体限制及 native 需求见 L20B-OBSERVABILITY.md。

F3-V2-03 追加五种 STANDARD 错误及 UTF-8 encoded-size 上限生产命令回归（staged runtime
共 19 条）；图片原有测试只追加非法尾位原串/不调用 decoder/精确日志断言，没有改弱原断言。
Node `20261104142339-f96491` / Electron `20261104142339-5997a4` 各 37 passed / exit 0，
无 Errors。F4 公共 decoder 已在 main，剩余结构 decoder 和 worker offload 仍是自有余项。

最新完整目录 `20261104132512-ec2950`：40 files / 544 passed / 1 skipped / exit 0，无 Errors。
VFS 历史夹具按 Rust `coordinator.rs:5551` 的 in-memory 语义恢复，所有原断言保留；两个先前
timeout 的 repairs 用例本次 725ms / 419ms。后续新增迁移 worker / 官方无 config 回归另见
LANE 的 Node/Electron 最小集，不计入该次 544。

`migration-worker.test.ts` 是 L21 平台接口回归：真实四库迁移在 worker 完成，Host 在迁移开始后
仍可响应 timer；报告/health/幂等、错误、close drain、process backup guard 均按生产入口核验。
不重复计入 362 条 Rust 台账，不以此关闭 L21 尚未接入的完整诊断/克隆链路。

`workspace-deletion-owner.test.ts` 经 F3 公共注册接口 + 真实 L05 deleteWorkspaceIndex 验证
同一 savepoint 内的调用位置、owner SQL 失败整体回滚/文件不删除、缺记录成功、注册重复和卸载。
它不以测试 callback 冒充 L05 已在生产 index 注册，也不关闭 journal/outbox 所有权余项。

`worker-pool.test.ts` 的 R4-SYNC-06 新回归经 api.ts 工厂进入真实线程：四库按需 open-existing、
不存在时不创建文件/父目录、默认只读拒绝写入、显式读写仅打开已存在库、损坏错误保真、
成功/失败后句柄关闭、worker warn 交给父 Host logger。文件回归改经 api.ts 命名导出，
原 copy/SAF 断言保留。这些是平台接缝证据，L20 正式导出命令生产闭环仍待消费方接入。

v2 追加 `staged-upload-runtime.test.ts` 七条生产入口回归，分别对应 Rust `staged_upload.rs`
的 Instant/SystemTime TTL 区别、write_all/io::copy 短写/零写、read_bounded 的 max+1 上界。
不增加 ledger 原测试行数。2026-11-04 全套 job `20261104110931-0395fc` 为
514 passed / 1 skipped / exit 0，无 Errors 行；Electron 定向 job `20261104110946-45e171`
为 17 passed / exit 0。原 fixture 环境条件跳过保持不变。

后续 v2 新增均不增加 Rust 台账行数：staged runtime 再加六条 u64 offset（共 13 条）；
`feature-flags-service.test.ts` 十条公开服务版本/错误回归；`startup-gate-command.test.ts`
五条真实 F2 gate + kernel 命令回归。最新最小集：Node `20261104114423-bcc5c1` 47 passed，
启动/导出 `20261104114016-056342` 20 passed；Electron `20261104112959-c89686` 42 passed、
`20261104114330-df8fd9` 5 passed；均 exit 0，无 Errors。
11:22 全套重跑有 fixture hook 超时和 RPC Errors 1（exit 1），已如实保留在 LANE；
hook 预算与 repairs/startup 用例间让出已补，按 C2 指令仅最小集验证，不宣称后继全套通过。

`refinery-checksum.test.ts`、`fingerprint.test.ts`、`resume.test.ts`、`database.test.ts`、
`locations.test.ts`、`service.test.ts`、`settings-consumer.test.ts`、`startup-finalizers.test.ts`、
`worker-pool.test.ts`：checksum/指纹与 Rust 逐字节一致、中间版本恢复、PRAGMA/参数绑定/事务/
维护屏障/数据空间解析；D2 finalizer 的拓扑排序/失败重试；L13b worker 的真实线程 hop、事务回滚
与业务 Err 保真。`service.test.ts` 另覆盖 L03 的 `openFile` 文件语义（默认递归建父目录；
`createParentDirs: false` 时父目录存在可建库、父目录缺失抛 `SQLITE_CANTOPEN` 且不建目录）与
L11 维护参与者（按库 scope、重叠 lease 引用计数、逆序 exit、enter 失败回滚、维护期间拒绝注册）；
`worker-pool.test.ts` 覆盖 pause 等待在途任务、terminate worker、resume 前排队任务不执行，以及通过实际 parent `ctx.storage` 注册参与者后 `enterMaintenance` 能暂停并在 release 后恢复该 pool。
`startup.test.ts` 另覆盖 W13：一个排在 storage 之前、不 inject `storage` 的 provider 插件
在 purge 后、`ctx.storage` 发布前、`.purge_on_next_start` 仍在时执行
`resetDefaultAfterLocalPurge`，成功后标记才清除并继续迁移；没有 provider 时保持
fail-closed（标记保留、`startup_cleanup` 失败、业务库不打开），并验证
`syncStateDatabasePath` 指向 `<dataLocalDir>/deep-student/sync/sync_state.db`。

`file-deletion-queue.test.ts` 额外覆盖 D1/D4：`SqlExecutor` 事务内 prepare 随业务元数据回滚、
提交后 finish 才做物理删除、outbox 删除 trigger 推进到 `published`、workspace autocommit 边界。
`database.test.ts` 覆盖 S05 的 `StorageError.phase`（prepare/bind/execute 三阶段）。
`file-manager.test.ts` 另用注入端口覆盖 image policy：high/未知/auto 阈值、<500KB no-op、
invalid decode 原字节回退、base64 invalid 原字符串，以及 `resizeAndEncodeJpeg` 的
low=768/60 参数传递。`image-quality-service.test.ts` 验证 `ctx.imageQuality` 正式服务入口，
并用真实 64×32 PNG + `ctx.nativeImage.dimensions` 的真实 decode 恢复
`bytes_quality_preserves_original_on_noop_or_invalid_image`；第二条真实 JPEG 测试仍 pending。
L12 生产接线（删除自有 `image-codec.ts` 并传 `ctx.nativeImage`）仍是独立缺口，不因测试 ported
而视为生产闭合。

`append_preserves_turn_metadata_and_scoped_deletion` 已按 C2 的 `migration/approvals.d/C2-platform.json`
批准改为 `obsolete:dead-in-rust`（无生产调用入口），不再计入 pending；
`generic_anki_writes_reject_tombstoned_cards_and_parent_tasks` 已用 main 的 `insertAnkiCard`
+ `updateCardRows` 恢复为 ported。

## 历史 pending（2026-11-04；以下三条已由 main 映射为 ported）

2026-11-05 WP-008 仅校正计数：实际行已指向 anki-domain.test.ts / image-quality-native.test.ts，
下述旧依赖状态不代表当前 main。本包没有重做这三条移植或改变映射；它们不计为本包完成量。

| Rust 测试 | 依赖 |
|---|---|
| `database/mod.rs::tests::agent_library_reads_and_content_cas_cover_null_and_foreign_sessions` | L16 分支 HEAD `fbed2b6c8` 的 `AnkiService` 已有 `listAnkiAgentLibraryCards`、`updateAnkiCardIfVersionForLibrary/ForSession`；main 未合入，待集成后恢复断言 |
| `database/mod.rs::tests::agent_library_cards_by_ids_preserve_order_and_fail_closed` | L16 分支 HEAD `fbed2b6c8` 已有 `getAnkiAgentLibraryCardsByIds`；main 未合入。L24 的 `chatanki/api.ts:177-195` 仍只有接口，`tests/chatanki-card-double.ts:140` 是替身 |
| `file_manager.rs::image_quality_tests::bytes_quality_matches_base64_policy_and_limits_dimensions` | main 的 `NativeImage` 没有 `resizeAndEncodeJpeg`；F7 候选分支 `ds-mig/F7-native` 已有（RGBA8 + jpeg-js），未证明与 `image 0.24.9` 的 Triangle/JPEG 等价；D5 JPEG PSNR 独立未签，需 F7 合入 main 或协调者接受交叉向量/容差 |

`bytes_quality_preserves_original_on_noop_or_invalid_image` 已由
`host/platform/storage/tests/image-quality-service.test.ts` 用真实 64×32 PNG +
`ctx.nativeImage.dimensions` 的真实 decode 恢复为 ported；这只证明 Rust 测试语义，**不等于
L12 生产接线闭合**：`host/plugins/vfs-index` 仍需删除自有 `image-codec.ts` 策略并改传
`ctx.nativeImage`。

详细接口要求见 `BLOCKERS.md`、`native-needs.md`；L20b 的 S05/S06 观测缺口见
`L20B-OBSERVABILITY.md`；启动接线见 `STARTUP-WIRING.md`。
