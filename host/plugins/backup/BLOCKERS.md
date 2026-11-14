# L21-backup-governance 跨 lane 阻塞与待接线

## WP-005 当前口径（2026-11-05，优先于历史段落）

- F3 `createMigrationWorker` 已发布并由本命令实际消费；L11 `vfsMaintenance.resetRebuildableIndex(targetDir)`
  已在 main 的 `types/services.ts:175` / `src/maintenance-service.ts:75`。本包不报旧接口未发布。
- X1 原 job `20261105112439-a10c89` 中 Slot C 的真实 coordinator 日志总时长 **10316ms**，
  超过整条诊断原5秒预算；不是仅由 timeout 推测。Rust `commands.rs:1199-1217` 要求完整串行 C/D，
  F3 Rust `migration/coordinator.rs:282-428` 负责完整迁移、验证、保护与失败恢复。当前阶段证据见 SPEC / WP-005 交付报告。
- 是否能在等价语义下优化该 F3 慢阶段、完整诊断的预算判据，交 C2 裁定；不把 TS 实测当作 Rust 实测。
  本 lane 允许路径不含 F3；没有缩诊断、改 wire、放宽5秒、跳过验证或调 SQLite 持久性参数。
- F3 WP-081（2026-11-06 协调者转达）：已定位 C/D 慢阶段（Node 带探针样本 C 迁移 COMMIT 2415.64ms / 1084 次 fsync，
  C/D 校验 scratch 重放各约 1s，仅 C/D runAll 7346.75ms），未找到已证等价的优化，生产迁移未改，D35 仍 open。
  本 lane 复测 job `20261105183959-349305`：`migration-diagnostic.test.ts` X1 5000ms 断言实测 7380ms 仍红；原断言未改，
  等 C2 组合 F3 候选与本测试的 Node/Electron 收据及后继裁定。
- TESTMAP 当前实际只剩3个 pending，详见该文件末尾逐项说明；下方“10条/7个init未接入”等为旧状态，不能沿用作当前工作包结论。

## 2026-11-05 两项消费已在本lane提交，待正常main集成

- 已正常merge F4最终联合tip `3f7187033`（含L14 `9871b1c1c`/实质`78f1dd8cf`、L18 `f9d949d43`/实质`65a801993`），代码提交 `a0c6229f8`。
- 审计details：改用F4正式 `jsonNumberToRawJSON`/`stringifyJsonValue`，任意精度/重复键last-wins/首次键序，原两个`it.each`执行；Node `20261105104241-17ae61`、Electron `-0a609e` 各41 passed/exit0。
- AP0136/0137：`setupRealSecrets` 在同一Host安装公开F7 native后把真实 `ctx.nativeArgon2` 传入正式F4工厂；原clean/residue+stored/explicit三例 Node `20261105104244-0acd61`、Electron `-5d164c` 各3 passed/7 filtered/exit0，默认m/t/p、原30s与断言未改。
- 两个foreign ledger仍未暂存/提交；待C2按正常集成在干净树跑全gate。下方2026-11-04描述保留为历史。

## v2 最新增量（2026-11-04，优先于下方历史）

- **AP0136/0137真实F4 Crypto性能接线待发布（C2已裁定不扩30s）**：5cfcd00a7恢复Rust遗漏的密封残留与显式覆盖实际导出/解封链，原强断言保留，使用真实F4/SQLite而非Fake-DSBK头。
  F4现已实现完整分支候选 `658590eb3`（其本身仅文档，必须包含f2b57ab07等完整前继）；C2亲取Node071416-8ab0a2/E071501-95c36f各5pass0skip，限定接受提供方接线证据，非L21验收。
  当前main `d41d57d68` 不含该候选（祖先检查exit1），公开factory选项尚未出现。先等正常main且本lane gate结束，再改zip-integration的setupRealSecrets从同一Host安装公开F7插件取真实ctx.nativeArgon2→显式传新factory；不提前复制实现/另改其它crypto fixture。
  Node `20261105052534-d6ce14` 3passed/exit0；E `-4a3bbf` 2passed/1failed/exit1：显式链38634ms触发原30000ms，错密码两例28752/27299ms通过。
  tsc1fd748/strictcddab9 exit0无额外Errors，不代表E通过。C2已派active F4优先最小真实消费已main F7 nativeArgon2，parked F7不重写/不加包；保真实三例/默认KDF/原30s。
  待正常main或C2明确固定联合可见后仅复验三入口；真native后仍超时再凭阶段证据裁定，不预设全由KDF解释。不得加时/降KDF/换假cipher/移hook/skip/fails求绿；issue1/W69/P36其它阈值不受影响。
  只读3d6e7d按F4:70-88相同原生probe证实E的argon2符号虽存在但抛ERR_CRYPTO_ARGON2_NOT_SUPPORTED，F4因而选@noble/hashes JS回退；不将符号存在或整case时长当每阶段profile。
- **F4桌面Value arbitrary_precision合同/同树消费（2026-11-05 C2立即纠正）**：Rust audit/mod.rs:38,799-804的details是Value；桌面vfs/notes/sync/media等Cargo显式开启arbitrary_precision，
  合法1e999不能降null/Infinity。已撤回L21新断言中的错误预期；原450820红/83920a与c7fa99旧42绿仅保留历史，不当桌面签收。
  F4分支JsonValueNumber含arbitrary raw，typed readNumber保持有限性；原F4完整tsc `20261105001519-08b811` exit2的uint.value消费已改用正式typed reader。
  F4已回复候选 `fd920f955` / 合同 `5106246c9`：正式 `jsonNumberToRawJSON(JsonValueNumber)` 返回native原子，规范化1e999→1e+999；
  `stringifyJsonValue(JsonNode)` 可保重复键last-wins/首次键序（含数值形key）。L21等待正常main后消费正式出口，届时替换当前未经规范化raw候选（不签收它），不复制owner实现。
  raw原子仅同runtime持久化，不spread/structuredClone/当IPC DTO；现有审计summary不含details。对象数值key顺序仍单列未签，不因此新造通用Value框架。
  C2明确完成状态pending不授权.skip，现两正例已恢复普通it.each，合法输入/not.toBeNull/精确数字token断言保留；不使用fails、删例、弱断言或能力探测跳过。
  Node `20261105022638-b0d5a2` / Electron `20261105022638-5547a9` 各2 failed/4 passed/exit1，失败为details=null，真实红灯交provider+consumer联合闭包；旧450+2skip不作签收。
  当前等待正常main同树消费正式F4出口，不复制lexer、不用Infinity/null代替合法Value；原Rust TESTMAP行状态不在本次改动范围。
- **C2/L20普通sync_run的本次取消/超时生命周期**：治理工具executor可调用已发布 `SyncService.runSync(direction, cloudConfig?, strategy?)`，
  但其 `host/plugins/sync/api.ts:108` 没有AbortSignal/等价取消端口；L04公开ChatExecutionContext.cancellation_token已存在，不是ExecutionContext缺字段。
  Rust data_governance_executor.rs:334-349的600s timeout/select/drop需贯穿owner实际同步工作；仅Promise.race返回SYNC_CANCELLED/超时不能证明I/O停止或租约已释放。
  C2已核api.ts:172虽有cancelSync，但index:163→cancelActiveSync只取消全局activeController；仅runSyncWithProgress在run-sync.ts:123-127安装，普通runSync:41-94没有本次token注册。
  因此不调用全局取消打断其它任务。提供方L20归C2，已由C2追加架构parked接管请求；C1仅协调ExecutionContext/真实registry一侧，不整体转错owner。
  待owner提供本次signal/取消及超时释放接缝，保持原SYNC_CANCELLED/SYNC_TIMEOUT/SYNC_FAILED形状、事件/存块次序；L21不私import token或另造同步引擎，当前API调用/Promise.race不能签生命周期完成。
- **R4 §15–17外部签收已核（2026-11-05，仅读R4分支ACCEPTANCE）**：B05真实owner与恢复激活、B09阶段错误、B06真迁移registry/依赖及三个真实F3初始化子项已签；
  B02真实F2启动等待子项亦已签。不再将这些列为需要复验/重做；不把子项外推成B02/B06整组关闭。两报告+两策略、B03锁、B07完整性继续开放。
- **B02真实外部组件维护态的只读接口仍缺**：R4探针 `20261104210356-780ffc` 原exit1（真实F3外部mistakes租约→借用MAINTENANCE，但kernel状态false/blocked=[]）。
  `Governance.getMaintenanceStatus` 只读Operations局部blocked；F3公开StorageService有enterMaintenance/registerMaintenanceParticipant，无实际组件状态读取面。
  请架构协调F3提供owner持有状态的只读观察接口，同时协调现有启动报告/registry观察缺口；L21不访问私有Set、不靠当前job/ready猜测、不复制状态机。
  F3 parked期间只上报架构，不发送执行排队消息；接口发布后L21按需消费并以原外部租约反例回归。
- **共享迁移产物阻塞自检前置检查（2026-11-05，本轮合并树bd0975335）**：
  `migration/LEDGER.md` / `migration/ledger.json` 有既存非L21未提交改动，lane-gate在启动任何检查前exit2。
  本lane只写 `host/plugins/backup/`，不能将它们混入提交、暂存隐藏或丢弃。请协调者确认产物归属并完成提交/对齐后通知L21，
  再跑正式自检；本轮审计行与AP补证的定向回归通过不能替代lane-gate签收。原失败日志与后续队列回执保留。
  最新原单回执：`20261105000642-4dc58d` exit2，仍为这两项前置脏改动；只读 `20261105000417-9aaef4` ledger检查exit0，不会提交/清除它们。
  未重排重复单；待infra处理归属并明确通知可重跑后再执行正式自检。
- main `eeaf5bdc7` 已发布 L11 `VfsMaintenanceService.resetRebuildableIndex(targetDir)`
  （`host/plugins/vfs-repos/types/services.ts:150-155`），VFS owner API 阻塞解除。
  L21 已改 prepare/finalize 按需消费，删除本地 `repository/vfs-restore.ts`；两条原测试
  经真实 L11 插件通过（vitest `20261104110506-f33825`、electron `20261104110653-e6b972` 35 passed / exit 0），
  补齐此前漏掉的 Rust 字段断言，TESTMAP 改 ported，交 R4 B05 复核。
- 已核公开实现（2026-11-05，接手树 `eabbb13e3`）：F3 `storage/api.ts:440-456` 的
  `registerFinalizer/runStartupFinalizers`、F1 `kernel/connection.ts::finishStartup` 与 F2
  `electron/api.ts::StartupGate.waitStartupReady` 均已在当前 main 合并树中；不能再记作“接口未发布”。
  L21 已补 `backup.restore-activation` 注册候选（2f727ea45），委托原 `finalizeRestoreActivation`；
  三条真实 owner 组合回归在 Node/Electron 均通过，不再列为接口未发布；失败政策与消费者 fixture 对齐仍见下文。
  maintenance-status 的 ready-wait 已在 e4b5bbdaa 按原 120s 语义接正式 F2 gate；真实 gate + kernel 的 Node/Electron 三分支已通过，待 R4。
- F3 `StorageError.phase`（`storage/api.ts:493-516`）已提供 prepare/bind/execute 分类；
  L21 B09 现按其修正首次 next 的阶段上下文（1783a548f/8cd83b1f4，Node 三例与 Electron 五例均通过，待 R4）。
- 仍缺 Registry 写锁可观察状态及独立启动维护态的公开读取接口；禁止业务层访问私有 Set 或复制启动编排。
- **D2 启动失败政策需 F1/F3/C2 明确承接**：Rust `lib.rs:1169-1190` 在激活失败后记录迁移错误、发
  `data-governance-migration-status`（degraded_mode/maintenance_mode_forced/restore_activation_failed）并进入维护；
  当前 `kernel/connection.ts:111-126` 的 finalizer 错误向上传播、启动失败且不标 ready（F3 API.md §9 亦明确该合同）。
  L21 只按已发布接口注册和传播，不吞错伪造健康，不自行复制组合根或发与实际状态不符的“已强制维护”事件。
  需组合根/存储 owner 实现对应降级维护语义，或由架构明确批准不同失败策略；本增量不关闭 B02/D2 整链。
- **新增注册的消费者 fixture 对齐（L02）**：`host/plugins/translation/tests/c1_cross_lang.test.ts:46-50` 安装真实 backup，
  却只提供 `storage.locations`；缺少已正式发布的 `registerFinalizer`。L21 自有 jobs/assets/helper 已改用真实 F3 registry，
  外部 fixture 需 L02 改为真实 `createStorageService`（不需打开业务库）或正式 owner registry 的绑定，不能添加 no-op 方法。
  当前真实 F3 消费者（sync shared-permit、workspace deletion）已使用完整 StorageService，不受此缺方法问题影响。
  协调者集成该候选前需一并核实此夹具，L21 不越界编辑 translation，也不在生产注册处默默跳过钩子。
  已实测 `20261104183735-96d75e`：1 failed / 4 filtered / exit1，精确错误为
  `TypeError: ctx.storage.registerFinalizer is not a function`（index.ts:311），不是算法回归或未知测试预算。
  已投递 L02 对齐请求。此前要求不要单独集成，但当前 main `cce44494c` 已含注册，夹具仍未同步；
  本轮合并树 `13fe76bb7` 的被测两文件与原反例无差异，未重复跑未变化的失败。已再次升级协调者处理此主线新红灯，原失败日志保留。
- B03 平台 `backup-common.ts` 的 wx/PID 锁仍不是 Rust fs2 advisory lock；须 F3/F4 提供等价原语。
- 本 lane 自有解码、日志、主线程 IO 等 v2 自查问题见 LANE，不归类为外部阻塞。
- F3 迁移 worker 接缝（新）：`MigrationCoordinator.runAll` 同步阻塞 Host 主线程（slot C/D、诊断报告实测 15s、计时器推迟约 3s，证据见 LANE「X1 运行时审读」）。
  fulltest main `677f6727c` 的两个 issue1 集成测试又出现 47.1s/30.9s 的 runner 超时（原默认 30s）；
  同源码定向执行 5.5s/7.2s 通过，未发现接口错配；不能由旧 STACK_TRACE_ERROR 摘要推断 CPU 原因。
  60s 测试预算草案 `3426e676f` 按 C2 指示留存待裁定，当前仍用原默认 30s，初始 success 断言保留；不借测试变绿关闭性能缺口。
  **现已解除**：F3 `7e53` 祖先已由正常 main `80dcc5291` 合入，本分支合并树 `8144fb3ab` 已含正式公共入口。
  `storage/api.ts` 导出 `createMigrationWorker({ baseDir })`，`runner.runAll({ appDataDir, migrationsDir?, auditDbPath? })`，卸载 `await runner.close()`。
  （类型里的 `logTarget?` 已不生效：worker 把迁移日志固定发到协调器 target `dstu_storage::migration::coordinator`，backup 不传，见 SPEC 与 `tests/migration-log-target.test.ts`。）
  原候选 `80a7b8877` / F3 Node `20261104133243-609573`、Electron `20261104134414-f68425` 25 passed 仅保留为历史，不能继续称提供方未合。
  L21 候选 `cc3d6ad13`（恢复调用在 e92982cb9、槽测试在 84602ddf0 自动检查点）已接
  `Governance.runSlotCTest/runSlotDTest` 与恢复 `initializeCandidateSlot`：单长期 runner、整个 sandbox 生命周期排队，
  无新增业务超时/前端取消信号，关闭先 drain，不把 runner 登记为会被自身维护许可暂停的参与者。
  Node 槽测试5例/恢复4例通过；Electron 槽测试5例及完整恢复1例通过、外部维护3例命中测试 helper 固定10s等待上限，
  原 exit1 保留（20261104165852-ad2064）。现只给长恢复测试传 Vitest signal，继续使用用例原有60s/120s预算，
  未动 issue1 的30s，未改生产时限；原终态与所有权断言全部保留，复验结果见 LANE。
- 新机器接手基线：`20261104104913-3a921a` 23 files / 369 passed / exit 0、无 Errors 行；
  typecheck `20261104104913-4a2d41` exit 0。旧树失败仍保留作历史；本结果不是 B05 新增量验证。

> 更新：2026-11-05 · 本文件记录外部接口依赖与解除后的消费接线状态；自有未决项见 LANE，不据此宣称本 lane 完成。
> 已处理的 R4 验收项见 `SPEC.md` 的「验收问题处理」。
>
> **分支可见性**：`0d4a73c61`、`5f02d66bd` 已是 main 祖先（`git merge-base --is-ancestor` 核实，main `eeaf5bdc7`）；
> B02/B03/B09 由 R4 在 main 上复核，本 lane 不自行勾选。
> 接手基线全目录通过：作业 `20261104104913-3a921a`（369 passed / exit 0）。

## 1. 测试 pending（10 条）

> **断言数变化说明**：`tests/migration-behavior.test.ts` 的断言数 274 → 253（-21）全部来自
> 本表已转 `pending` 的 8 条测试（`init.rs` 7 条共 19 条；`commands.rs` Registry 中毒 1 条共 2 条）。
> 未从任何保留测试中删弱断言；这 8 条测试断言的是本地 `InitializationReport`/`RegistryStateHolder`
> 替身，违反 quality.md §10.1，待 F3 发布生产入口后再按真实链路恢复。

| 测试 | 条数 | 缺什么 | 由谁提供 | 影响 |
|---|---:|---|---|---|
| `backup/mod.rs::test_restore_handles_write_failure_gracefully`、`test_pre_restore_backup_and_rollback_mechanism` | 2 | `obsolete:dead-in-electron` 批准（Rust `BackupManager::restore` / `rollback_from_pre_restore` 仅被已停用的 `data_governance_restore_with_assets` 调用，命令层固定返回错误） | 协调者（`migration/approvals.json`） | 批准后标 `obsolete:`；否则保持 `pending` |
| `init.rs::test_ensure_directories`、`test_initialization_report_new`、`test_initialization_report_is_fully_successful`、`test_needs_initialization_new_app`、`test_get_current_schema_state_empty`、`test_initialize_audit_log`、`test_initialize_without_feature` | 7 | 启动初始化编排 `ensureDirectories` / `InitializationReport` / `initializeWithReport` / `needsInitialization` / `getCurrentSchemaState` 的生产入口；F3 持有启动编排，L21 无对应命令或服务 | F3 `storage` | 7 条 TESTMAP 保持 `pending`；测试内不再保留 `init.rs` 本地替身 |
| `commands.rs::refresh_schema_registry_from_dir_maps_poisoned_lock_error` | 1 | 生产 `refreshSchemaRegistryFromDir` 与可观察的 Registry 写锁状态（Rust `Arc<RwLock<SchemaRegistry>>`） | F3 `storage` | 1 条 TESTMAP 保持 `pending`；测试内本地 poison flag 已删除 |

### 1.0.1 旧 ported 的初始化/策略副本：初步7项，3项已改真实入口，当前4项仍缺证据

这与上方已有8项 pending 是不同 Rust ID。初步发现时 `migration-behavior.test.ts:220-323` 有本地
`InitializationReport/initializeWithReport`，`:338-343` 有本地 `shouldForceMaintenanceModeOnInitFailure`；现以符号查找为准。
调用真实迁移子步骤不代表初始化报告/降级策略本身来自生产；先前“全部断言走生产实现”的文件注释已纠正。

| 当前 TESTMAP 旧标记为 ported 的 Rust ID | 缺失生产证据/接口 |
|---|---|
| `src/data_governance/migration_tests.rs::tests::test_complete_initialization_flow`（AP-0117） | 现有实际F3启动实现的报告/registry观察面；插件入口已存在，不能从测试本地report证明 |
| `src/data_governance/migration_tests.rs::tests::test_no_initialization_needed_after_init` | 已改实际 F3 插件启动+真实 pending-count，Node/Electron通过（0b127b/224e82），不需为此新增报告API |
| `src/data_governance/tests.rs::integration_tests::test_full_initialization`（AP-0129） | 同上，需正式初始化报告而非测试派生字段 |
| `src/data_governance/tests.rs::integration_tests::test_no_initialization_needed_after_init` | 已改实际 F3 插件启动+真实 pending-count，同上作业通过 |
| `src/data_governance/critical_audit_tests.rs::critical_audit_tests::test_initialization_preserves_existing_data`（AP-0103） | 已改实际F3启动→真实VFS写入→卸载/重装F3→读取数据，Node/Electron通过；不是本地initializeWithReport或伪报告 |
| `src/data_governance/mod.rs::policy_tests::schema_fingerprint_drift_does_not_force_maintenance_mode` | 被测策略仅存在测试文件；需真实启动失败策略的生产落点 |
| `src/data_governance/mod.rs::policy_tests::non_drift_verification_failure_still_forces_maintenance_mode` | 同上，不把复制的 if/match 当作生产策略已接线 |

- 请求 F3 暴露现有真实启动实现的窄报告/registry观察面（只剩2个报告用例需要），不新造第二套初始化算法；策略顺序/降级行为仍需与 D2 问题一起由 owner/架构明确。
- 初步曾请求7项纠正，现以本节更新为准：3项已由已有实际入口解决，**只剩2个报告+2个策略副本共4项需暂列 pending**。
  请求协调者通过生成器/元数据维护通道对齐；本轮不手改GENERATED、未删原断言/加skip。3项候选仍需正常main后复核，不擅自签收。
  当前313 ported/10 pending 是旧形式统计，**不是已验证的 v2 数量**；至少上述4项不能据旧标记计入生产证据。
- 已有7个 init.rs + 1个锁测试仍维持 pending，不恢复旧 stand-in。真实 pending-count 的纯委托测试另改直接测生产方法，不以它们证明完整初始化。

### 1.1 给 L11/L12 的 `resetRebuildableIndex(targetDir)` 最小语义（已解除，main `eeaf5bdc7` 已发布；保留作历史）

Rust `backup/mod.rs:2307 reset_rebuildable_vfs_index` 的唯一职责是让候选槽不携带任何陈旧派生索引。
L11/L12 发布的所有者 API 至少要满足：

- **输入/归属**：`resetRebuildableIndex(targetDir: string): void`，由 `vfs-index/api.ts`（或 L11 的 vfs service）
  发布；调用方只传目标槽根目录，不持有连接、不写任何 VFS SQL。
- **路径**：只处理 `<targetDir>/databases/lance/vfs` 与 `<targetDir>/databases/vfs.db`。
- **Lance 清理**：目录存在时 `rm -rf`；失败抛
  `无法清理恢复目标中的陈旧 Lance 索引 {path}: {error}`，不得继续重置 SQLite 账本。
- **SQLite 边界**：`vfs.db` 不存在时直接成功；存在时用 `BEGIN IMMEDIATE` 包住全部重置，任何一步失败整体回滚。
- **列级兼容**：按 `PRAGMA table_info` 判断列是否存在，只更新存在的列（旧库缺列不得报错）。
- **重置内容**（与 Rust 完全一致）：
  - `DELETE FROM vfs_index_segments`（表存在时）；
  - `vfs_index_units`：`text_state`/`mm_state` 按 `*_required` 回 `pending` 或 `disabled`，
    `*_error`/`*_indexed_at`/`*_embedding_dim`/`*_profile_id` 置 NULL，`*_generation` 置 0，`text_chunk_count` 置 0；
  - `vfs_embedding_dims`：`record_count=0`，`last_used_at=created_at`（两列都在时），
    `active_generation=0`，`ann_metric='exact'`，`ann_index_version=0`；
  - `vfs_index_profiles`：`active_generation=0`，`ann_metric='exact'`，`ann_index_version=0`；
    `state` 依 `vfs_embedding_dims.active_profile_id` 标记 `active`/`retired`（无该列时全部 `retired`）；
  - `resources`：`index_state` 保留 `disabled`、其余回 `pending`；`index_hash`/`index_error`/`indexed_at`
    置 NULL，`index_retry_count`/`index_next_retry_at`/`index_generation` 置 0；`mm_*` 同理
    （NULL 保持 NULL、`disabled` 保持 `disabled`、其余 `pending`；error/pages/dim/mode/indexed_at 置 NULL，
    retry/next_retry/generation 置 0）；
  - `files`/`exam_sheets`：`mm_index_state` 按同一三态规则，`mm_index_error`/`mm_indexed_pages_json`/
    `mm_embedding_dim`/`mm_indexing_mode`/`mm_indexed_at` 置 NULL；
  - `DELETE FROM __lance_orphan_queue`（表存在时）。
- **幂等**：重复调用结果相同；调用后 `index_state`/`text_state` 等回到可重建状态，不残留 `indexed`。

在上述 API 发布前，本 lane 的两条回归继续执行（证明候选槽清理不变量未退化），但 TESTMAP 保持
`pending`，且不得把本地 SQL 说成已完成的单一所有者实现。

## 2. 待接线接口（不影响已注册命令的 A 级）

| 接口 | 缺什么 | 由谁提供 | 影响 |
|---|---|---|---|
| 启动期恢复激活 | 应用启动时调用 `finalizeRestoreActivation`（消费 `.restore_activation_pending.json`、轮换设备身份、清理维护租约） | L21 消费 F3 finalizer API / F1 组合根 | 注册消费候选已补；真实 F3/F4/L20 owner 组合验证中。失败分支的 Rust 降级维护/当前 F1 fatal 差异另按上文跟踪，不复制 F1/F3 编排 |
| 启动就绪等待 | `waitStartupReady(timeout)` 等价接口（Rust `startup_gate::wait_startup_ready`） | L21 消费 F2 `startupGate` | 候选已接：e4b5bbdaa 先等120s再读维护快照，超时保留Rust字符串；Node/Electron真实F2 gate三分支通过。独立启动维护态读取仍缺F3公共面，不因此签收B02整组 |
| VFS 派生索引重置 | 表所有者发布的恢复重置 API（见 §1.1） | L11 `vfsMaintenance` | 已解除：恢复候选槽经 `ctx.get('vfsMaintenance').resetRebuildableIndex(targetDir)`，本地 SQL 已删除；待 R4 B05 复核 |
| 同步基线重建 | 已解除：main `d5cd234aa` 集成 L20 `sync@1.resetSyncBaselineAfterRestore`（`host/plugins/sync/api.ts:205`）；L21 恢复候选槽经 `ctx.get('sync')` 按需调用，本地副本已删除 | L20 `sync` | 无剩余阻塞 |
| L20 `SyncCommandPorts.application` | 已解除：main `d5cd234aa` 集成 L20 `sync@1.applyDownloadedChangesToDatabases`；L21 只消费公开面，5 条原 `commands_backup` 库路由/冲突测试经 `ctx.get('sync')` 移植 | L20 `sync` | L21 不复制跨所有者表写入；`ctx.backup.syncCommandPorts()` 只含 `limiter`/`loadHydratedCloudConfig`/`saveSyncAudit`；缺 sync 时按需 `ctx.get` 报错，不硬 inject |
| `SchemaRegistry` / `AuditRepository` 公共接口 | `host/platform/storage/api.ts` 的公开类型与方法 | F3 `storage` | 本 lane 在 `repository/schema-registry.ts`、`repository/audit.ts` 内最小等价实现；诊断/审计命令已注册并通过测试 |

### 已解除

- **同步设备轮换**：`repository/sync-state.ts` 已删除；`finalizeRestoreActivation` 改为调用 L20 已发布的
  `ctx.syncSupport.state.recordDeviceRotation(oldId, newId, reason)`，测试断言该发布接口的调用参数。
- **L23 云同步守卫（L21 侧）**：`backup@1` 已发布完整 snake_case
  `tryAcquireOperation(kind)`（立即失败）与 `acquireOperation(kind, timeoutMs)`（带超时等待），
  返回带 `snapshot`/`operationId()`/显式 `release()` 的同一协调器租约。忙锁/锁 IO 抛结构化
  `OperationGuardError`：`reason: 'busy' | 'lock_io'`、稳定 `code`
  （`E_DATA_GOVERNANCE_BUSY` / `E_DATA_GOVERNANCE_LOCK_IO`）、`app_error` 为 Rust 同形 AppError
  （`Validation` / `FileSystem`），`value === app_error`，并保留原始 `cause`；不会按 message 前缀
  猜分类，也不会把未知程序异常吞成业务错误。L21 自己的 `error: string` 命令在
  `stringErrorCommand` 出口转回字符串，invoke 正常 settle。`governance` 同时发布
  `acquireOperationGuard(kind)`/`tryAcquireOperationGuard(kind)`（DeletePropagation 删除路径）
  与等待型 `acquireOperation`。
  **L23 仍需自行删除** `host/plugins/sync-providers/index.ts` 的本地可选 `BackupWithGuard` /
  `OperationGuard` 类型与 message 前缀判断，改用最终 snake_case kind、直接使用
  `BackupService`/`BackupOperationGuard`，并按 `OperationGuardError.app_error` 传输；每个写命令的
  `finally` 中显式 `release()`。该文件属 L23，L21 不越界修改。
- **L20 同步端口错误映射（L21 侧）**：`limiter.tryAcquire()` 只把 `reason === 'busy'` 映射为 `null`；
  锁 IO 不伪装成忙锁，按 L20 `error: string` 契约为字符串 `CommandError`；
  `limiter.acquire()` 的锁 IO 返回既有 `'closed'` 哨兵，跨进程忙锁保留 Rust busy 文案并以字符串
  `CommandError` 上抛（超时仍返回 `'timeout'`），由 L20 使用 Rust 原文案收口。
  L23 直连 `backup.tryAcquireOperation` 仍拿结构化 FileSystem/Validation。
- **L20 同步命令端口（L21 侧）**：`backup.syncCommandPorts()` / `governance.syncCommandPorts()`
  已发布 `limiter`（`tryAcquire` + `acquire(timeoutMs)`，同一全局许可）、
  `loadHydratedCloudConfig()`（SSOT+SecureStore+validate）与 `saveSyncAudit()`（Sync 审计 best-effort）。
  `application` 按 D7 裁定归 L20 唯一实现，L21 不复制。
- **C1/L04/L05/L10 删除传播守卫（L21 侧）**：`governance.acquireOperationGuard('delete_propagation')`
  与 `tryAcquireOperationGuard` 已发布，语义是 Rust `try_acquire`（忙锁立即抛 `CommandError`），
  返回 `snapshot`/`operationId()`/`release()`。C1 `WorkspaceCoordinatorOptions.operationGuard` 可直接注入
  `() => ctx.governance.acquireOperationGuard('delete_propagation')` 并在 `finally` 释放；C1 文件不在本 lane 写入范围。

## 3. 非阻塞边界

- `cloud_config_test_connection_draft` 的 loopback/明文传输判定来自 L23 `sync-providers` 的 `isLoopbackHost`
  （该 lane 已改为引用 `host/platform/net-policy`）；本 lane 消费其已发布的 `syncProvider` 服务。
- 云配置 SSOT 的 `cloudConfig` 服务由本 lane 提供；`syncProvider` 已按 L23 正式服务名消费，旧键回退已删除。

## 4. 仓库级门禁（非本 lane 代码）

- `npm run typecheck:host` 的 `scripts/electron-migration/accounts.test.ts` TS7016 已由 main 的
  `51b8384ad`（`lib/accounts.d.mts`）修复；本 lane 合并后应复跑确认。
- 本 lane 自身 `host/**/*.ts` 在 `tsconfig.host.json` 下无错误。
