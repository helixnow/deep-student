结论：完成，WP-116 发布 `l15-review-cas-tombstone-w0` SQL 构造 seed（精确 i64 reviewVersion 与 card/task 软删除，按 Rust 原夹具 SQL 写入迁移重放的 mistakes.db），沿既有 seed API 一次构造多份复制；不代表业务 CAS 通过。

# X3-data-compat：旧数据兼容审计

## main-red：全量运行夹具落盘争用（2026-11-06）

- main `5f806c95e` 的 fulltest 原件列出 slotC、head 重开、previous-head 三条失败，耗时分别
  30284.68 / 32001.55 / 33071.08 ms；JSON 失败文本仅为 `Error: STACK_TRACE_ERROR`，不是字段差异。
  原预算为 30000 ms。相同 main 定向 job `20261106105414-f5463b` 9 passed / 0 failed / 0 skipped、exit 0，
  三条分别 4272 / 10155 / 10684 ms；未复现接口或数据行为不兼容，定位为全量争用时的构造耗时问题，归本 lane 夹具。
- 原构造连接默认 synchronous=FULL；五库 132 条迁移和 history 分别提交，另有 seed 写入。
  构造测量 job `20261106105509-caafba` exit 0：wall 5607.56 ms、CPU user+system 1575.07 ms、fsWrite 35536。
- 修复仅在 `__fixtures__/fixtures.ts` 的 `buildDatabase` 构造连接使用 connection-local `synchronous=OFF`，
  减少可重建样本的同步刷盘等待。真实原 SQL、逐迁移/history 事务、外键/完整性检查、磁盘文件及关闭重开保留；
  生产 Host 连接未改。不是崩溃持久性验收，样本仅在构造成功关闭后交给被测入口。
- 修后构造测量 `20261106105550-1af231` exit 0：wall 1373.71 ms、CPU 1398.62 ms、fsWrite 21600，
  五个文件关闭后新连接均 synchronous=FULL（2）、integrity_check=ok；实测构造等待由约 5.61s 降为 1.37s。
- 所有测试断言和 30 秒预算保持，X3-L05-02 未动；不把基线容忍的红灯当通过。
  修复后的原始测试统计与四项 gate 回执交协调者，要求原始 exit 0 / 0 failed。

## WP-116 交付（2026-11-06 UTC）

- seed 名 **`l15-review-cas-tombstone-w0`**，`provenance=sql-constructed`；经既有 `createSeed/resolveSeed/copySeed` 与 CLI，
  `SeedDirectory` 字段与比较器不变，未新增 hash/协议。构造 `__fixtures__/review-cas-tombstone-seeds.ts`，消费说明、
  稳定记录 ID、源文件行见 `host/e2e/data-compat/SCENARIO-V0.md` 末节。不是 A 端/Rust 产物，不是真实旧库。
- 来源：L15 `WP-053.report.md:40-45`；`dstu-anki/src/fsrs_review_service.rs`（`S`）`:2838-3190`（CAS 入口与 UPDATE）、
  `:4791-4934`（reviewVersion 读取）、`:7150-7539`（两条 tombstone 原测试）、夹具 `:6037-6127`、入队 `:1424-1452`；
  `dstu-storage/src/database/mod.rs:6053-6128`（生产物理 DELETE，本 seed 不用）。
- 字段归属更正：reviewVersion 不是独立列，而是 `COALESCE(fsrs_card_states.local_version, 0)`（`S:4791-4818`）。
  tombstone 列为 `anki_cards.deleted_at`、`document_tasks.deleted_at`；会话归属 `document_tasks.source_session_id`。
- 内容：CAS 组 6 张活卡/state，`local_version` = 2^53、2^53+1、2^63-1024、2^63-1023、i64::MAX-1、i64::MAX（三对 double 相等邻值互为 stale）；
  `S:7150` 卡 tombstone（保留 sibling 活卡与 tombstone 卡自己的 state）；`S:7327` 任务 tombstone（`Processing`、`updated_at` 2000 年，
  活子卡与其 state 保留）。整库零 DELETE，tombstone 只经 Rust 夹具 UPDATE。
- 与 Rust 原测试的差异：Rust DEFAULT/`Utc::now()`/UUID 列改为同格式固定值；`S:7327` 的子卡 tombstone 前 `rate` 未复制
  （本包不计算 FSRS、无 review log）；三组同库，全局计数不等于 Rust 单测的 0/1。均写入 SCENARIO-V0。
- 验收 `review-cas-tombstone-seeds.test.ts` 5 条（真实 SQLite）：源与 A1/A2/B sha256 一致；state 23 列、card 23 列、task 14 列逐字段与
  storage class（期望值手写，不取自构造模块）；与纯迁移重放相比只多 3 task / 9 card / 8 state / 31 条 change_log（逐条顺序、无 DELETE）
  及 `sqlite_sequence`；隔离副本执行 `S:2922-2938` 原 SQL：stale 0 行、精确 1 行、tombstone 0 行；源与副本此后不变。
- SQLite 事实（交 L15/L24 判断，不是结论）：`local_version=i64::MAX` 时该 UPDATE 成功，`+1` 溢出存为 REAL 2^63。
- 作业：起点全目录 `20261105193600-6673d3` 11 files / 66 passed / 0 failed，exit 0；定向（新文件 + scenario-v0/cli）
  `20261105194112-63bb7d` 18 passed / 1 failed，exit 1（测试读 diff 结构写错，`d.after` 本身即 values，只改该投影）；
  修正后 `20261105194708-b008f6` 5 passed / 0 failed，exit 0。
- 初版记录的 X7 seed 接缝阻塞已更新，见下节。L15/L24 场景/实现/测试与 Rust TESTMAP 去向保持；本 lane TESTMAP 补记 5 条 seed 验收，X3-L05-02 未动。

### WP-116 新会话恢复原件（2026-11-06 UTC）

- 接管时 HEAD `da1f23e39`、工作树干净；保留 WP-115 `393c12d85` 与自动检查点 `f77e175e1`、`eb2c73c73`、`b6fc3a918`，文档提交 `380c1faf4`。
  已核对 Rust brief 全部范围、WP-053 报告 40–45 行、构造器与 5 条 TS 验收；实现满足 seed 要求，本次仅补齐记录和交付。
- 找回此前正式 selfgate 原件：tip `da1f23e39829853a7a3584f9191aa404e3592686`、base `cfac8a04e`、
  `ok=true`、`2026-11-05T19:54:10.892Z`。子作业原件均在 `/home/dsdev/.oc-jobs/done/<id>.json/.log`：
  typecheck `20261105195049-24aa3c` exit 0；tests `20261105195049-6fca48` **12 files / 71 passed / 0 failed / 0 skipped，Errors 0，exit 0**；
  普通边界 `20261105195049-55ea2a`（3101 files）、严格边界 `20261105195049-61c0d3`（6 files），均 0 violation / exit 0。
  原已绿定向检查不重复；本次新 main 合并后的规定直接 gate 结果单列于 WP-116 的 wp-done 报告。
- 依赖以 `git show main` 核实：seed API 已在 main，L05 恢复队列已传给 buildInstance/router；
  `git diff 393c12d85 -- host/e2e/data-compat/owner-databases.test.ts` 为空，原断言/预算保留。
- 阻塞更正：新 main 的 `record/scenario-v0.mjs:38-55` 已用 `scenario.seed` → resolveSeed/copySeed 并配置副本 HOME/XDG。
  本包 seed 供给无阻塞。真实工具外层调用及 A1/A2/B 录制交 X7/L15/L24；X7 `WP-043-runtime-blockers.md` 仍记 A binary 缺失。
  seed 自验不提升资格；不等待 A binary 交付。
- TESTMAP pending **0→0**，兼容待修 **0→0**；逐条来源/断言见本 lane TESTMAP WP-116 节。
  供抽检：① `review-cas-tombstone-seeds.test.ts:107-120` 精确整数与关联；② `:123-138,188-217` 软删除保留子状态、源副本隔离。

## WP-115 交付（2026-11-06 UTC）

- seed 名 **`l22-temp-sessions-w0`**（沿用 L22 暂定名，未改），`provenance=sql-constructed`；经既有 `createSeed/resolveSeed/copySeed`
  与 CLI `seed/copy`，`SeedDirectory` 字段不变，未新增协议。
- 来源：L22 `cf9e3e01528c0e9bf54bbb36b6f75ff842eecf20:host/plugins/integration/equivalence/pending-seed/l22-temp-sessions-w0.sql`，
  blob `3f666bc674993b724e8c4a82bfbb8e2cbb4d95a9`（L22 tip `7bb768c9a` 同字节）。只读：工作树有同路径文件时读工作树，否则 `git show`；
  两者都校验 blob id。未复制/修改 L22 语料，未改 `temp-sessions.seeded.json`。L22 `README.md:28-60` 的分支表作为构造需求依据。
- 构造：`__fixtures__/temp-sessions-seeds.ts`。五库按当前 `src-tauri/migrations` 重放（含 refinery history、F3 checksum），
  `buildDatabase` 新增可选 `seeds` 参数（默认值不变）以传 `{}`，不插入 WP-013 业务行；随后 `mistakes.db` 单事务 `exec` 整段 L22 SQL。
  不是 A 端/Rust 产物，不是真实备份。Rust 只读依据：`src-tauri/src/commands.rs:166-285`、`dstu-storage/src/database/mod.rs:4177-4216`。
- 已知限制：迁移默认行的 `datetime('now')`（vfs `memory_config.updated_at`、`vfs_indexing_config.updated_at`，mistakes
  `__change_log.changed_at`）取构造时刻，重建不逐字节相同，因此必须一次构造后复制。懒建库（audit/sync_state/workspace）不预建。
- 验收 `temp-sessions-seeds.test.ts` 6 条（明细见 TESTMAP WP-115 节）：真实 SQLite 行数 24/2、唯一触发器原 DDL、
  storage class（TEXT/BLOB/integer）、`session_data` 逐行等于 SQL 字面量及高精度/重复键/代理/转义词素、refinery i64 原值；
  隔离副本执行 Rust upsert 原 SQL 证明 `RAISE(ABORT)` 只拦 `tmp_readonly`；源目录和 A1/A2/B 的 sha256 在运行后不变。
- 作业：起点全目录 `20261105182339-e61a0e` 60 passed / 0 failed，exit 0（X3-L05-02 原断言已通过，测试未改）；
  定向 `20261105183602-9a2074`（新 seed + scenario-v0/cli/skill-zip）27 passed，exit 0；类型修正后
  `20261105184435-9dbf08` 6 passed，exit 0；CLI 实建 `20261105183706-0c20ce` exit 0，产物 `/tmp/opencode/x3-wp115-seed/l22-temp-sessions-w0`。
- 正式 lane-gate 最终 tip `deb4d0c12`（base main `136320e68`）raw exit 0：typecheck `20261105185534-a0c0b1`、
  tests `20261105185534-e43ace`（11 files / 66 passed / 0 failed）、boundaries `20261105185534-120ba4`、strict `20261105185534-bcf65c` 均 exit 0。
  此前 tip `78dc6e39c` 同样 raw exit 0：typecheck `20261105184958-31fc8f` exit 0；
  tests `20261105184958-78d61f` 11 files / 66 passed / 0 failed，exit 0；boundaries `20261105184958-64c321` 0 violation；
  strict(changed) `20261105184958-3cbbb1` 0 violation。
- blocked（owner X7）：runner 不解析 `scenario.seed`/不设置数据目录（同 WP-094）。L22 场景移到顶层由 L22 在 runner 支持后进行。


## WP-094 交付（2026-11-05 UTC）

- seed 名 **`skill-zip-v0`**，`provenance=synthetic-zip`。经既有 `createSeed/resolveSeed/copySeed`（及 CLI `seed/copy`）构造/复制；
  文件在 `<seed>/home/w0-zip-seeds/`，清单由 `__fixtures__/skill-zip-seeds.ts` 的 `SKILL_ZIP_SEED_FILES` 导出。
- 逐文件的 Rust 分支（`dstu-agent/src/chat_v2/skills.rs`）、字节构造方式见 `host/e2e/data-compat/SCENARIO-V0.md` 末节。全部为合成构造，
  stored/固定 DOS 时间/无 extra，字节确定；**不是**历史 A 发布物或 Rust 产物。`historical-wp013-v1` 仍标 SQL 构造。
- 只读依据：L07 `equivalence/README.md:38,54`（分支 `ds-mig/L07-agent-skills-ptc`）、`skills.rs:1340-1535,2142-2253`，
  zip 0.6.6 `read.rs:428-431`（同名条目全部保留）。未改 L07 实现/语料、runner、v0 格式、共享 schema。
- 首组未含：64 MiB、条目数/名长/单文件/总量上限、ZIP64、多卷、符号链接、秘密密钥 ZIP。
- 验收：`skill-zip-seeds.test.ts` 7 条。独立 EOCD/中央目录解析 + zlib CRC32 + JSZip 证明目标元数据；
  A1/A2/B 三副本和重建逐字节一致。“目标 Rust 分支”只是构造意图，不把 Rust/TS 导入结果写成 oracle。
  定向作业 `20261105174513-b5dab5`：21 passed / 0 failed / 0 skipped，exit 0；类型 `20261105174827-2a2a33` exit 0；
  CLI 实建 `20261105174654-5fe719` exit 0，产物 `/tmp/opencode/x3-wp094-skill-zip-seed/skill-zip-v0`。
- blocked（owner X7）：`record/replay.mjs:15-24` 不解析 `scenario.seed`、不设 HOME；v0 无 seed 路径占位符。
  需要 HOME=`<副本>/home` 或经 C2 批准的占位符，然后 L07 再写 `~/w0-zip-seeds/<文件>` 场景。

## WP-044 交付（2026-11-05 UTC）

### 交付面与来源

- API、完整约定、Rust 类型引用与示例：`host/e2e/data-compat/SCENARIO-V0.md`。
- `__fixtures__/scenario-seeds.ts`：`resolveSeed/createSeed/copySeed`；接受精确 seed 名
  **`empty`**、**`historical-wp013-v1`**。结果给出独立 `dataDir/dataLocalDir`，源构造一次后复制给 A1/A2/B。
- `__fixtures__/database-state.ts`：`enumerateDatabases/snapshotDatabase/snapshotDirectory/compareDatabaseStates/compareDatabaseDirectories`。
  递归发现八库及后继新增库；逐表 `table_xinfo` 读取所有列与 SQLite `typeof`，包括内部表、FTS shadow、generated/hidden 列。
  复合 PK 排序/对齐，无 PK 保留多重集合/重复数；精确 i64、IEEE754 REAL bits、BLOB、SQL NULL、JSON TEXT 原文。
- `__fixtures__/scenario-cli.ts`：`seed/copy/snapshot/compare`，JSON 输出，exit 0 相同 / 1 有差异 / 2 错误。
- 历史 seed 是 **SQL 构造**：复用 WP-013 五库 SQL 重放与三份固定历史 SQL，8 库、132 refinery 迁移、47 个显式业务 seed 表。
  三份历史 SHA 为 `1813b3c9c16eff57768ad884d96b6f5a9b447a54`、`de1159c149c2b6064532443d87189ab3b56ed768`、
  `41a5ca8f1ff92f761eabd7594b676bcbc75d9e04`，出处在 `__fixtures__/historical/SOURCES.md`。
  `v1` 是本夹具 recipe 版本，不是历史发布 tag。没有构建/运行 Rust，也没有真实 A 端产物。

### 比较接缝交 X7 / C2

`compareDatabaseDirectories` 返回 `{ equal, before, after, differences }`，原始输入快照不修改；
调用者分别保存 A1/A2/B，先看 A 双录再决定场景规则。每个差异包含 `kind/db/table/key/column/before/after`。
主键值和全部 cell 带 storageClass；不会复制 X7 `record/database.mjs:27–28` 抹 types 的行为。
对象键按集合比较，HashMap 插入顺序不影响结果；JSON TEXT 完整保留，u64 不经过 JSON.parse/Number。
raw 文本顺序差异不是业务不等价裁决：需要 owner 给出逐 scenario+JSONPath、Rust 类型及 A 双录证据，交 C2 批准独立投影。
本包没有新增 volatile/normalize 规则或全局 epsilon。动态 ID 后继必须一对一、跨返回/事件/FK 同映射，不能统一替一个值。
数组与事件顺序留给对应 owner；没有编辑 X7 record/文件实现。

### 提交与验证

开工 merge main 提交 `6f75e1120`，起点 main `d7861df19`；工作树原先干净，其他 lane 有并行 Vitest。
已用 `git show main:host/platform/storage/index.ts` 与 `migration/refinery.ts` 核实 F3 主线公共面；WP-013 夹具来自本分支既有提交。
自动检查点 `52f37aafa` 保存工具初版，`6afc35fa6` 保存修正后 12 项验收与 API 文档；最终 tip/正式 gate 见下方补录。

提交补录：`6ec78286f` 报告/API 交接，`f8bf2173b` CLI 入口验收；合并 main `bf0cef873`、`1115ae52a`。
正式 gate 验收代码 tip **`1115ae52a`**（包含 main **`4dc4c8ed9`**），其后仅补录交付文档。
最终交付 tip 见 wp-done 元数据（不把文档补录提交伪称为已跑过的代码 tip）。

| 项目 | job | exit | 统计 / Errors |
|---|---|---:|---|
| 基线本 lane 类型检查 | `20261105155554-1e4f63` | 0 | 无类型错误 |
| 基线全目录 | `20261105155554-826f3d` | 1 | 38 passed / 1 failed / 0 skipped；Errors 0；原 X3-L05-02 |
| 工具类型检查 | `20261105160310-56f575` | 0 | 无类型错误 |
| 工具首次测试 | `20261105160310-d83606` | 1 | 8 passed / 3 failed / 0 skipped；Errors 1（Vitest RPC timeout） |
| 工具修正后测试 | `20261105160805-7e4ed6` | 0 | **12 passed / 0 failed / 0 skipped；Errors 0** |
| CLI 首次参数探底 | `20261105160336-5bc69b` | 9 | Node 26 不接受 `--experimental-transform-types`；已从示例去掉该参数 |
| 真实 Node CLI 入口测试 | `20261105161500-ecc220` | 0 | **2 passed / 0 failed / 0 skipped；Errors 0**；真实 seed/copy/snapshot/compare，差异/错误退出码 1/2 |
| 修正参数后独立 CLI seed | `20261105160617-10ab0d` | 0 | `empty` 输出完整独立 dataDir/dataLocalDir；原输出在 done 日志 |

正式自检：

| 项目 | job | exit / 状态 | 结果 |
|---|---|---|---|
| 第一次父 lane-gate | `20261105161226-17292f` | **2** | 排队期间 main 推进，前置检查 `分支没有包含最新的 main`；正常 merge 后再提交一次 |
| 第二次父 lane-gate | `20261105163025-e1de5e` | **128 / SIGTERM** | 16:39:38Z 启动，17:09:38Z 结束；回执 note 为 `被信号 SIGTERM 结束（可能超时 30 分钟）`；无正式成功 selfgate |
| 全 Host 类型检查 | `20261105163939-d7d6ac` | **0** | 无类型错误 |
| 全目录测试 | `20261105163939-5acb94` | **1** | **52 passed / 1 failed / 0 skipped；Errors 0**，9 files，唯一 X3-L05-02 |
| 普通边界 | `20261105163939-974465` | **0** | 17:10:20Z 完成，3055 files，0 violation |
| 严格 changed-source 边界 | `20261105163939-28916f` | **0** | 17:09:40Z 完成，8 files，0 violation；3 个具名 native-import 理由 |

第二次 gate 的测试失败原文（原文件相对 WP-013 `67eb7c5e3` diff 为空）：

```text
FAIL owner-databases.test.ts > workspace: persisted unread inbox is restored into the owner queue when an old database is opened
AssertionError: expected [] to deeply equal [ { id: 'message_old', …(8) } ]
owner-databases.test.ts:207:63
Test Files  1 failed | 8 passed (9)
Tests       1 failed | 52 passed (53)
```

父门禁未收口的队列证据：16:12:51Z status 为 other limit 3 / running 4，四个 running 都为
等待 other 子项的父 gate，已通知 C2 并 `coord escalate`（`2026-11-05T162107706Z-X3-data-compat.md`）。
队列随后有推进，CLI 和首次 gate 取得退出码；第二次 gate 的类型/测试也已完成。
16:52:54Z status 仍 other limit 3 / running 4，queued 24；本 lane 的两项 boundary 子作业仍在 queue。
单次阻塞 `job wait 20261105163025-e1de5e` 20 分钟达到客户端工具超时，**不是父作业 exit**。
不取消他人任务、不改执行器、不伪造 selfgate 记录，不为等待边界重复已通过的类型/工具测试。
以上已交 C2 继续收口；生产整体红由 L05 WP-063 修复后组合复验。

**最终回执补录（17:10Z）**：父 job 已由执行器记录 SIGTERM/128，随后两项边界均实际 exit 0。
全部四个子项原件已取回并保存至 `.tmp/wp044-gate-receipts/`，无需重提父 gate 或重跑已完成检查。
最终是类型/普通边界/严格边界通过，tests 52p/1f/0skip、Errors 0（原 X3-L05-02）；
父进程被终止和生产断言失败分别记账，不能因为子项收齐而宣称正式 selfgate 成功。
前述 16:52Z 队列状态及后文续记中的 running/queued 仅为当时证据，已由本次终态覆盖。

### 协调者回执后：L05 单库交接与原件保留

- 再次 `git merge --no-edit main` 返回 `Already up to date`；主线仍为
  `coordinator.ts:546` 创建新队列、`:576–584` 恢复另一局部队列后丢弃。集成拒绝的唯一用例就是
  已知 X3-L05-02；不改 X3 预期，不越界修改 L05，不以同一基线重跑测试冒充修复。
- 按 C1 新指令，后续自检只直接执行 `node .../lane-gate.mjs`，由其内部排 jobs；
  当前父作业尚在 running，未重复提交/终止它或其他 lane 作业。
- 父、子作业原始 JSON/log 已复制保存在本工作树
  `host/e2e/data-compat/.tmp/wp044-gate-receipts/`，含父 running 状态、完整类型/测试回执和两个 boundary queue 元数据。
- L05 请求可直接复制的历史 workspace V1：已实际生成且关闭
  **`/home/dsdev/dev/ds-mig/X3-data-compat/host/e2e/data-compat/.tmp/wp044-l05-handoff/workspaces/ws_ws_old.db`**。
  直接调用既有 `buildOwnerDatabase(file, historicalSql('workspace-v1'), OWNER_SEEDS.workspace, 1)`，
  没有自造 SQL、调用 Host 或运行 Rust；这是夹具产物创建，不计为新增测试。
  只读查询确认 user_version=1、八业务表及 sqlite_sequence；workspace=`ws_old`、agent=`worker_old`、
  message=`message_old`、inbox=`9007199254740993/unread`。构造器与查询句柄均已关闭。
  源 SQL 固定 `41a5ca8f1ff92f761eabd7594b676bcbc75d9e04:src-tauri/src/chat_v2/workspace/database.rs:13–124,142–144`。
  已通过 coord 通知 L05：只读复制到自身隔离目录后再打开，源文件保留不写、不清理，无需等 main。
- C2 的完整八库 seed job `20261105164200-825edc` 尚在 queue，目标 `/tmp/opencode/c2-wp063-seed-20261105-1643`
  尚不存在；不能用该排队命令声称已有可用产物。

首次工具失败的两项断言假设已按真实 SQL 修正，未改被测库：

1. 大 Buffer 的 Vitest 深递归字节断言耗时 55s 超出原 30s，改用原生 `Buffer.equals` 仍逐字节全量比较；未放宽预算。
2. notes UPDATE 有 `V20260131__add_change_log.sql:76–81`、`V20260724__notes_fts.sql:66–78` 的真实副作用。
   原先“只有一条差异”假设错误；新增用例精确断言全部 10 处变化（notes、FTS data/docsize/idx、change-log、自增水位）。
   单业务值→单差异独立用例使用没有 trigger 的历史 `workspace.document.title`，精确断言
   `db=app-data/slots/slotA/workspaces/ws_ws_old.db/table=document/key.id=document_old/column=title`。
3. 原 39 条兼容测试、X3-L05-02 `owner-databases.test.ts:207–210` 的原断言均未改；没有 skip/todo 或 Rust 运行。

### TESTMAP / 未完成 / 供抽检

- TESTMAP pending **0→0**（无本 lane Rust ported/pending 项），兼容待修 **1→1**。
  新 14 条是工具验收（12 比对器 + 2 CLI），逐条断言清单在本 lane TESTMAP；不占用/改写其他 lane Rust 测试去向。
- 整体阻塞仍为 L05 `WorkspaceCoordinator.loadInstance/buildInstance` 的恢复队列丢失，原失败正文和 Rust 对应见下方 WP-013。
  L05 WP-063 修复、C2 组合集成后由原断言复验。比较器 API 可先交 X7 消费，不宣称整体 gate 绿。
- 真实历史 release seed（A 产物）等 WP-043 后另包接入；跨返回/事件/FK 动态 ID 规则及逐场景规范化由 owner/X7/C2 后续提供。
- 供抽检① `scenario-v0.test.ts` 的 workspace document 唯一差异及 A1/A2 不变；
  ② INTEGER 1 vs REAL 1、相邻 double、i64 `9007199254740993→9007199254740994` 与全部 trigger 差异未掩盖。

## WP-013 交付（2026-11-05；以下旧章节为历次证据）

### 提交与验证

- 起点 main `967f43c7547d1ed29a7e3d736b8118fb95d3661e`；依赖已通过 `git show main:host/platform/storage/api.ts` 及三个 owner 的 `index.ts` 核实。
- 提交：`7b2fd5cd3`、`fcc8dc1c0`、`e2946cf83`、`40f61d91a`（协调者自动检查点保存本包改动）；合并 main 提交 `a84c1e04c`、`0b6c7bbd8`。验收代码分支 tip **`0b6c7bbd8`**，基线 main **`b55af5d85`**；此后只补录文档，最终交付 tip 见 wp-done 回执元数据。
- 基线类型检查 job `20261105140523-82f2c6` exit **0**；基线目录测试 job `20261105140523-a48de6` exit **0**，**35 passed / 0 failed / 0 skipped**，Errors **0**。
- 增量类型检查 job `20261105142007-c8c202` exit **0**。
- 首次增量测试 job `20261105142007-f209ef` exit **1**，2 passed / 1 failed；失败在 workspace peek，后续全列断言未执行。保留同一预期，将 peek 独立成回归，非删除/弱化断言。
- 最新增量测试 job `20261105142528-6d4c3d` exit **1**：`host/e2e/data-compat/owner-databases.test.ts` **3 passed / 1 failed / 0 skipped**，Errors **0**。三库 schema/全列/重开用例通过；唯一失败为 X3-L05-02。
- 历史来源核验 job `20261105142639-df45f5` exit **0**：三份 SQL 与固定 Git SHA 的 Rust raw-string 正文逐份相等（仅去文件两端空白）；workspace 历史源码明确 `CURRENT_SCHEMA_VERSION = 1`。没有运行 Rust。

自检：lane-gate 首次 job `20261105143648-1ceef5` exit **2**（排队期间 main 更新，前置检查拒绝）；重试 job **`20261105145307-027b3f`** 在执行时合并 main 并启动四项检查，父作业最终记录 **code -1 / 客户端 exit 1**：`作业执行器重启，作业被中断，请重新提交`。四个已派发子作业均有完整结果：

| 门禁项 | job | exit | 结果 |
|---|---|---:|---|
| 全 Host 类型检查 | `20261105150116-3040f0` | 0 | 无类型错误 |
| 普通边界 | `20261105150116-94445f` | 0 | 3043 files，0 violation |
| 严格 changed-source 边界 | `20261105150116-731a27` | 0 | 3 files，0 violation；沿用 fixture 既有 native-import 说明 |
| `host/e2e/data-compat/` 全目录测试 | `20261105150116-3326d4` | 1 | **38 passed / 1 failed / 0 skipped**，7 files，Errors **0**；唯一失败 X3-L05-02 |

门禁总体**未通过**：生产缺陷由 L05 修复；父进程中断也没有产生本次正式 selfgate 回执（旧 selfgate 的 ok=true 不能引用为本包通过）。已有全部子项原件，未重复跑已完成检查，也未更改共享执行器或伪造回执。

恢复指令要求的只读 ledger：job `20261105144423-4bcdac` exit **0**，commands 1058（A100/B0/C0），tests 8109（A90.2/B1.9），problems commands/tests/orphan = **0/0/0**；使用 `host/kernel/coverage.ts`，prod-reachable **unreachable 22 / unknown 3702（not vetoed）**。这是账本摘要，不是 39 项 E2E 全绿或全局质量通过证明；未写生成账本。

### 新增覆盖表与真实版本

源码路径以下以 `src-tauri/crates/` 为前缀。历史 SQL 固定 SHA、旧路径与行号详见 `host/e2e/data-compat/__fixtures__/historical/SOURCES.md`。

| 真实库文件 | 旧 schema → 当前 / 原 Rust 来源 | 有代表数据并全列比对的表 | 真实 owner 与读取 |
|---|---|---|---|
| `<active>/databases/audit.db` | 初始发布 `1813b3c9c` 的 `src-tauri/src/data_governance/audit/mod.rs:182-198`；当前 `dstu-storage/src/audit/mod.rs:193-224` 同 schema。无编号版本链，初始化幂等，不伪造历史升级号。路径 `dstu-storage/src/migration/coordinator.rs:264` | `__audit_log`（3 行、9 列；3 个索引保持） | L21 `initAuditTable` / `queryAuditLogsPaged` 经 F3 `database('audit')`；生产调用 `backup/index.ts:196`、`src/governance.ts:165` |
| `<dataLocalDir>/deep-student/sync/sync_state.db` | `de1159c149c2b6064532443d87189ab3b56ed768`（`8a68823ec` 父提交）`src-tauri/src/data_governance/sync/state.rs:59-107` 六表 → 当前 `dstu-sync/src/data_governance/sync/state.rs:59-117` 七表；无编号迁移，user_version 0→0。路径同文件 `:22-37` | `upload_seq`, `consume_cursor`, `legacy_processed_key`, `tombstone_watermark`, `instance_binding`, `device_history`；升级后的 `tombstone_event_publish` 经真实 owner 写入一行并重开保留 | L20b `SqliteSyncStateStore`，生产 `sync-support/index.ts:51`；发布序号、下一序号、cursor/map、水位、processed key、设备轮换、绑定匹配/拒绝、稳定事件序号 |
| `<active>/workspaces/ws_ws_old.db`（workspace_id=`ws_old`） | `41a5ca8f1ff92f761eabd7594b676bcbc75d9e04:src-tauri/src/chat_v2/workspace/database.rs:13-124,142-144` 的实际 **user_version 1 → 2**；当前 `dstu-agent/src/chat_v2/workspace/database.rs:160-218,230-244,300-302` | `workspace`, `agent`, `message`, `inbox`, `document`, `context`, `sleep_block`, `subagent_task`；另保留内部 `sqlite_sequence` | L05 `WorkspaceCoordinator` 通过 F3 openFile 实际触发 owner schema/upgrade；生产 `agent-workspace/index.ts:93-117`；workspace/agent/message/document/context/task/sleep 完整字段、inbox DB 计数可读；**peek 失败** |

覆盖计数：数据库 **5→8**；refinery 迁移仍 **132**，新三库没有 refinery history。旧显式 seed 表 **32→47**（新增 15），另有 1 个升级后真实 owner 写入表，合计 **48 个有数据表**；内部 sqlite_sequence 不计业务表。新增 E2E **4** 项，总计 **39**。

### 全列、整数、NULL、时间与 history

- fixture 在本 lane `.tmp/case-*` 直接重放固定历史 SQL；`fixtures.ts:170-213` 负责独立建库、完整原值快照。每个测试使用自己的临时目录；finally 关闭所有 F3 句柄，afterEach 清理。没有用户转储或真实用户路径，没有运行 Rust。
- 旧表所有列都用 `SELECT *` + safeIntegers 比对；不是只比较 seed 的部分字段。audit/workspace 的 schema SQL 与索引全保持；sync 只允许新增事件表及其自动索引，其余 sqlite_master 对象逐项相等。
- 整数：SQL 精确 `9007199254740993n`（audit duration、sync sequence/watermark、workspace inbox id/自增水位）；audit operation JSON 保留 `18446744073709551615n` 的 u64 最大值；document version / inbox priority 用 i32 最大值。
- NULL：audit 的 SQL NULL 与文本 `null` 均读为 null，原存储值保持区分；workspace 的 skill、任务起止/summary、message target、sleep 可选字段保持。sync 正常 owner 写入的数据字段为非空字符串/整数，未伪造不符合 Rust 参数语义的 NULL。
- 时间：SQL 原始 `+08:00`、UTC Z、9 位纳秒、SQLite TEXT 时间保持；audit/workspace owner 内部映射到精确纳秒的 `+00:00`，与 Rust parse 后 UTC 时间点一致。本包不是 IPC serde 字符串形状验证，未据此宣称 UTC Z 的 wire 等价。
- 三库都断言 **无 `refinery_schema_history`**：audit/sync_state 本来不建版本表，workspace 权威版本是 `PRAGMA user_version`。不向非 refinery 库塞入伪造 history；原五库的 version/name/applied_on/checksum 测试保持。
- 每库至少两次全新 StorageService / owner 构造。audit/sync 同连接再初始化一次也不变；workspace 第二次构造实际重跑 owner 初始化/迁移入口，版本保持 2，全部数据和 schema 对象不变。

### TESTMAP 前后与逐项落点

Rust 移植 pending **0→0**（本 lane 不持有 Rust ported/pending 映射；`migration/testmap/` 与其他 lane TESTMAP 未修改）；新增兼容验收待修 **0→1**（X3-L05-02）。没有把新增样本当作 Rust 单元测试移植数。

| Rust 生产语义（不是 ported test id） | TS 验收位置 | 断言对应 |
|---|---|---|
| `dstu-storage/src/audit/mod.rs:193-224,365-417,767-816` | `owner-databases.test.ts:37-80` | 原 schema/init 幂等、3 条完整 owner 返回值、u64/NULL/UTC 纳秒、全部原列与索引保留 |
| `dstu-sync/src/data_governance/sync/state.rs:22-117,119-173,224-306,309-437` | `owner-databases.test.ts:82-131` | 六表历史版本真实扩成七表；所有 bigint 原样，旧绑定拒绝不匹配，稳定事件序号不重写创建时间 |
| `dstu-agent/src/chat_v2/workspace/database.rs:160-218,230-244,300-302`；`repo.rs:492-648`；`subagent_task.rs:434-472`；`sleep_manager.rs:1133-1186` | `owner-databases.test.ts:133-188` | V1→V2、原八表全列及 sqlite_sequence、全字段 owner 读、重开幂等 |
| `dstu-agent/src/chat_v2/workspace/coordinator.rs:586-605,986-1067` | `owner-databases.test.ts:192-215` | 持久化 unread 应恢复到内存队列；完整消息/重复 peek/原值不变，当前第一个 peek 断言失败 |

已读 Rust `coordinator.rs:1275-1327` 的 `peek_inbox_is_read_only_and_matches_drain_order` 全文：该测试经 send_message 建内存队列，并测 drain 顺序；本次为**旧库重开**读取，两者不等价，未擅自改它的 TESTMAP 去向。

### 阻塞：X3-L05-02（owner L05-agent-workspace）

失败原文：

```text
FAIL owner-databases.test.ts > workspace: persisted unread inbox is restored into the owner queue when an old database is opened
AssertionError: expected [] to deeply equal [ { id: 'message_old', …(8) } ]
owner-databases.test.ts:207
```

SQL unread 行完整且 `pendingInboxCount=1`；迁移没有删除行。Host `src/workspace/coordinator.ts:576-584` 在局部 inboxManager 上恢复后，调用 `buildInstance()`，`:545-550` 又创建空 inboxManager/router；`peekInbox():342-350` 读取后者。Rust `coordinator.rs:994-1011,1059-1066` 将同一已恢复 manager 交给 router 和实例。

需要 L05 修正现有 `WorkspaceCoordinator` 的 loadInstance/buildInstance 队列传递；不需要新 API。解除条件：修复入 main，原 `peekInbox(workspaceId, sessionId): WorkspaceMessage[]` 回归通过且重复 peek 后 SQL 未变。X3 只改许可路径，未复制 owner 实现/绕过初始化/skip 失败。

### 未覆盖与本包边界

1. audit 没有历史编号版本，已用初始发布的真实 schema 证明原格式读取；无可声称的 V0→V1 迁移。
2. workspace 真实 V1 原 DDL 已含 initial_task/started_at/completed_at/result_summary。本样本覆盖重复 ALTER 兼容和版本推进，**不覆盖 task_content 回填**；不把 chat_v2.db 的同名表伪造成旧 workspace schema。
3. `<app_data_dir>/superagent/superagent.db` 是另一废弃实验库：`dstu-agent/src/chat_v2/super_session/state.rs:978-1032` 仅读 `sa_kv.enabled` 并改名 `.legacy`，不导入历史。其旧开关迁移未覆盖，也没有凭别名创建新库。
4. 不覆盖损坏/半迁移恢复、激活 sleep 的计时器、全部解析失败分支、跨平台/IPC 输出、用户真实转储、WebView 存储、ZIP 整槽 restore、跨机密钥恢复。本包只增加样本级证据，**W6 未全部完成**。

供抽检：① sync `de1159c1` 六表 DDL 是否确为 `8a68823ec` 前一实际状态及 bigint 重开不变；② workspace Rust/TS load_instance 的队列引用差异，`pendingInboxCount=1` 而 `peekInbox=[]`。

---

日期：2026-11-04。结论：**有条件通过；存在 F3、L04 共 2 项输出表示不兼容，不能宣称严格等价全绿。**

已证明本次样本中旧库可打开、迁移幂等、数据没有丢失/改写、refinery checksum 兼容、已有固定密文可解、旧备份 ZIP 可读取。未编译或运行 Rust，未修改其他 lane 实现。

## 1. 可复现结果

```bash
node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs submit -- npx vitest run -c vitest.host.config.ts host/e2e/data-compat --maxWorkers=1 --reporter=verbose --reporter=json --outputFile=host/e2e/data-compat/results.json
```

2c1e32587 历次全量执行的原始摘要（Node v26.5.0，SQLite 3.53.4，Vitest v3.2.7，Linux；发生于全局队列规则生效前）：

```text
Test Files  2 failed | 4 passed (6)
     Tests  2 failed | 33 passed (35)
  Duration  27.43s
FAIL platform.test.ts > F3 llm_usage_recent public IPC matches Rust UsageRecord serde (including UTC Z)
Expected createdAt: 2026-09-30T17:02:03.123456789Z
Received createdAt: 2026-09-30T17:02:03.123456789+00:00
FAIL services.test.ts > L04 messages: timestamp precision, block order and SQL NULL→absent optional fields
Received unexpected fields: attachments: null, sharedContext: null
```

退出码 1；无 skip/预期失败伪装。测试分组统计及单独运行方式见 `host/e2e/data-compat/TESTMAP.md`。本目录 TS 严格类型检查已通过（命令同 TESTMAP）。

按用户恢复指令运行的全局只读账本：

```text
npm run migration:ledger -- --check --no-write
ledger: commands 1058 (A 88.8% B 1.8% C 0%), tests 8036 (A 70.3% B 0.4%);
problems: commands 0, tests 250, orphan registrations 0
exit 1
```

全局账本的既有 250 项测试问题不是本 lane 35 个新增 E2E 的通过/失败数；本 lane 不写全局账本。

## 2. 样本来源与 checksum 证据

- 构造器：`host/e2e/data-compat/__fixtures__/fixtures.ts`。逐个读取 `src-tauri/migrations/<db>/V*.sql`，按**数字版本**执行原始文本，不裁剪空白或更改 SQL。对照 `src-tauri/crates/dstu-storage/src/migration/{vfs,chat_v2,mistakes,llm_usage}.rs` 的非测试 `include_str!` 注册集合；browser 为独立 embed 目录。
- 直接使用 better-sqlite3 执行各迁移 SQL，再独立事务插入 history；**不使用 Host Runner 构造 fixture**。history DDL 同 refinery：`version int4 PRIMARY KEY, name/applied_on/checksum VARCHAR(255)`。
- `applied_on` 固定为合法 refinery RFC3339 `2026-10-30T01:02:03.123456789Z`；checksum 是 u64 的十进制 TEXT，不经过 JS Number。
- 复用 F3 导出的 `refineryChecksum`（`host/platform/storage/migration/refinery.ts:114`）：SipHash-1-3，keys 0/0，name UTF-8 + FF、i32 小端 version、SQL UTF-8 + FF。与 Rust `src-tauri/vendor/refinery-core/src/runner.rs:92-95` 一致。
- **129 条** checksum 与 F3 已存 `migration/__fixtures__/rust-refinery-checksums.json` 中 Rust 写出的金标逐条相等。其余 **3 条**（VFS V20261023/V20261027、browser V20260711）没有现存 Rust 金标；由同一已交叉验证算法计算，不能声称拥有这三条的独立 Rust 实测向量。
- Host 打开前，先以默认严格 Runner 校验全部 history（零待迁移）；再作故意改坏 checksum 的负对照，确认会拒绝。避免协调器的 checksum repair 把错误 fixture“修成通过”。

**这不是发布版 Rust 二进制产出的数据库或用户数据转储。** 证据范围为：当前仓库 Rust 迁移 SQL、显式历史格式、已存金标与独立 seed 的跨实现兼容。

## 3. 数据库与表覆盖

共 **5 个 refinery 库、132 条迁移、32 个显式 seed 业务表**（另对 5 库 `refinery_schema_history` 作全字段比较）。每库所有迁移 SQL 均执行，不等于每个表均有业务样本。

| 库/真实位置（相对活动槽） | SQL 数/HEAD | 显式插入并逐列保留验证的表 | 公开业务读取 |
|---|---|---|---|
| `databases/vfs.db` | 71 / 20261027 | `resources`, `notes`, `blobs`, `files`, `folders`, `folder_items`, `translations`, `exam_sheets`, `questions`, `question_history`, `review_plans`, `todo_lists`, `todo_items` | 真正 L10 `notes.repository`；L11 `vfsRepo` 的 resources/files/blobs/folders/translations/questions/reviewPlans/todos |
| `chat_v2.db` | 29 / 20260910 | `chat_v2_sessions`, `chat_v2_messages`, `chat_v2_blocks`, `chat_v2_attachments`, `chat_v2_session_state`, `resources` | 真正 L04 `chatSession` 的 session/message/block/state |
| `mistakes.db` | 23 / 20261005 | `mistakes`, `chat_messages`, `settings`, `document_tasks`, `anki_cards`, `custom_anki_templates` | 真正 F4 settings；L16 anki 模板 service 和 `get_task_cards` IPC；legacy i64 消息经 F3 safeIntegers 读取 |
| `llm_usage.db` | 8 / 20260826 | `llm_usage_logs`, `llm_usage_daily` | 真正 F3 插件 `llm_usage_recent` IPC（1 项时间表示差异） |
| `browser.db` | 1 / 20260711 | `sessions`, `history`, `downloads`, `site_permissions`, `settings` | F3 首次打开执行 browser lazy runner；历史内容仅经 F3 SQL 读取，未冒称 browser service 可读取历史会话 |

所有 32 表使用 `SELECT *` 的全列快照对比（含迁移默认值），不是只比行数/挑选几列。使用 `safeIntegers` 保留原始 i64；Host 再打开两次均保留原 history 的 version/name/applied_on/checksum。额外运行 foreign_key_check、integrity_check。公开服务测试安装真实插件 `index.ts`，没有 mock 仓储/存储/加解密。

值域：中文与 emoji、多行文本、SQL NULL、JSON `null`、带空白 JSON、数组/对象、REAL 0.125/2.625、u32 最大值 4294967295、JS 安全整数上界 9007199254740991、精确 i64 9007199254740993n、INTEGER 毫秒、带时区 9 位小数 RFC3339、SQLite `YYYY-MM-DD HH:mm:ss`、日期及 HH:mm。原生 JSON string 字段（settings、previewJson、tagsJson、repeatJson 等）原样比较；语义上为对象的字段按 Rust serde 形状比较，且 SQL 字符串快照不变。

## 4. 迁移幂等与尾部追加

- 完整 HEAD 样本：严格 refinery 校验零待执行；`storage.migrations.runAll()` 连续两次 `appliedCount=[0,0,0,0]`。中间 dispose 后真重开连接，数据与 applied_on 完全不变。browser lazy migration 同样不重放。
- 较早样本：VFS 到 20261023，chat_v2 到 20260909，mistakes 到 20260824，llm_usage 到 20260824。各缺最后一条，仍有代表数据；Host 各追加 **1** 条，原 history 不变、新 checksum/version/name 与迁移集合一致；旧列全值保留，新增列可出现；下一次全部为 **0**。
- 当前 Host 使用同一批 Rust SQL，没有额外 Host-only 迁移；没有伪造新增版本来制造升级成功。

## 5. 密钥/密文、数据空间、ZIP

### F4：5 项通过

复用 `host/platform/secrets/vectors.test.ts:44-56,76-89` 和 `backup-crypto.test.ts:70-76` 的**固定密文字节**，仅调用公开 `createSecretsService` 返回的能力：

1. 预置 `.secure/.key_seed` + v3 `.enc` 解出 `sk-test-secret-值`。
2. 预置 base64 `.master_key` + version=2 EncryptedData 解出 API key、指纹一致。
3. pre-v2 base64 明文格式可读。
4. 固定 DSBK v1、生产 Argon2 参数解出已知明文。
5. 固定 DSBK v2 streaming、生产参数解出已知明文文件。

F4 向量来源是 Rust 格式常量及既有独立实现计算值，不是本 lane 运行 Rust 新生成，也不是本 lane 自加密再解密。

### F3：4 项通过

真实 `DataSpaceStartup` 读取已有 slotB、应用 pending→slotA；B 的 settings 有不同时间线内容，确保不是拿相同数据蒙混。整个非活动槽的 seed 数据保留。legacy root→slotA 迁移连续两次启动只移动一次，所有库均可读。C/D 通过槽目录 + `storage.openFile` 只读读取；Rust `data_space.rs:1651-1674` 本来仅 A/B 可作为生产活动槽，**C/D 不激活不是缺陷**。测试没有重启服务器/进程。

### L21：2 项通过

独立 JSZip 打包真实的四核心 SQLite 文件，manifest v1/v2 按 Rust `dstu-sync/src/data_governance/backup/mod.rs:742-783,1761` 的字段形状构造。经真实 `data_governance_import_zip` IPC 和公开 jobs 服务等待完成：SHA-256、SQLite 校验通过，导入后每个 seed 列/history 均与源一致，活动槽不变。没有使用 Host exporter 给自己的 importer 喂数据。

这是旧 ZIP **读取/校验/暂存**兼容，不是整槽 restore、密钥发布或跨机器恢复的端到端通过声明。

## 6. 按归属 lane 分组的问题与缺口

### F3-storage：确认的不兼容

**X3-F3-01（历史不兼容，已签收；证据见第 10 节）**

- `llm_usage_recent.createdAt`：Rust `UsageRecord.created_at: DateTime<Utc>`（`src-tauri/crates/dstu-storage/src/llm_usage/types.rs:214-215`）；仓储 RFC3339 parse 后转 Utc（`repo.rs:509-510`），chrono serde 输出 UTC `Z`。
- Host `host/platform/storage/llm-usage.ts:665-667,689` 使用 `canonicalRfc3339`；`host/platform/storage/time.ts:74-80` 选择 `toRfc3339`，输出 `+00:00`，通过 `index.ts:305` 公开返回。
- `host/e2e/data-compat/platform.test.ts:30-38` 真实 IPC 复现：纳秒与时间点相同，但字符串不同。不属于已登记的“新时间戳仅毫秒精度”裁定（`docs/dev/electron-migration/dispatch/F3-storage.md:25`），旧值仍保有 9 位小数。
- 应由 F3 对外 UsageRecord 序列化层恢复 Rust serde 表示；不应改写旧库时间文本。本 lane 未改实现，也未把失败改成 `it.fails`。

F3 覆盖缺口：audit/sync_state/动态 workspace 库不在 refinery 五库中，本次未构造它们；FTS 全部迁移/完整性已执行，但未逐条验证搜索排序与全文召回；仅覆盖上述较早 schema tuple，不覆盖所有发布版本、历史损坏/半迁移恢复。

### F4-security：未发现本次固定向量不兼容；仍有证据缺口

- SecureStore v2 在既有 `vectors.test.ts:35-37` 有设备身份派生 key 向量，但没有可直接复用的、带旧设备身份与 `.enc` 的完整固定文件对，**未伪造补充**，不能据 v3 通过推断 v2 自动迁移成功。
- Linux + keystore=null；macOS Keychain / Windows DPAPI 包裹种子、云凭据 generation/staged 发布、真实跨机 key restore 未验证。
- 固定 DSBK 明文是 `hello backup world`，不是完整加密 ZIP。没有独立固定 Rust 加密 ZIP artifact，未宣称“旧加密 ZIP→发布密钥→整槽恢复”全链路已证实。

### L04-chat-session：确认的不兼容

**X3-L04-01（历史不兼容，已主线签收；证据见第 11 节）**

- 输入为旧消息 `attachments_json=NULL`、`shared_context_json=NULL`。Rust `repo.rs:1710,1734` 从 `Option<String>` 解析，保持 None；`src-tauri/crates/dstu-agent/src/chat_v2/types.rs:1596-1611` 两字段均有 `skip_serializing_if = "Option::is_none"`，应该省略。
- Host `host/plugins/chat/repository/messages.ts:33-41` 的 `parseOptional` 对 SQL NULL 返回 JS null；`:140-142,154,157` 只检查 undefined，于是添加 `attachments: null`、`sharedContext: null`。
- 真实 L04 插件提供的 `chatSession.getMessage` 在 `host/e2e/data-compat/services.test.ts:33-36` 全字段比较失败。不是故意把 null 与 absent 当成相同值，也未修改契约或实现去迁就测试。
- 应由 L04 恢复 Option::None→省略语义；session/block/state 的其余本次读回通过。附件和 sharedContext 的非空复杂结构不在本次覆盖范围内。

### L10/L11/L16：所测公开读取通过；非全插件验收

- 附件/legacy mistakes/legacy messages、document_tasks 的所有列通过 SQL 保留；未覆盖这些表的全部公开业务接口。messages 的 i64 只证明 safeIntegers 读取，不宣称 JSON Number 能精确保留 >2^53 的整数。
- 外部 blob/附件实文件、Anki 媒体/APKG、向量索引（Lance）、未列出的 essay/mindmap/FSRS 等业务数据及对应插件工作流未做跨版本验收；表结构执行成功不等于业务恢复已验证。

### L19-mcp-browser：历史公开读取边界

5 个 browser 表均验证原值、lazy migration 幂等。当前 `BrowserService.getHistory` 经运行时 session（`host/plugins/browser/src/browser-service.ts:500-514`），无恢复任意历史会话的公开读取 seam；未绕过 API 导入其内部仓储。这个边界不是本次已证实的 Rust/Host 回归。

### L21-backup-governance：读取通过；恢复缺口

v1/v2 四核心库 ZIP 读入通过；未测 v3 coverage ledger 全量恢复、asset ZIP、整槽激活、增量、密码 ZIP、旧设备密钥关联。browser 不在 Rust 核心四库 ZIP registry（Host `manifest.ts:130-144` 亦如此）；不能把这两个读取用例当成 browser 数据也纳入备份的证据。

## 7. 交付范围

只提交 `host/e2e/data-compat/` 和本报告。临时 SQLite/ZIP/key 与运行 JSON 被忽略，运行可确定重建；没有真实用户数据或新写的二进制 fixture。2 项确认问题保留可执行失败回归，由归属 lane 修复后可直接重跑验收。

## 8. C2 指令续记：目录分类及修复等待

### 当轮历史基线确认（一次检查，不轮询）

- 当轮 main：`9c13dfc39`；`git merge-base --is-ancestor f9cbf4d23 main` exit **1**，对当轮本 lane HEAD 同样 exit **1**。此为当轮快照，不是后续 main 实时状态。未据 integrate 日志推断合入，未从 owner 分支复制实现、未在旧基线重复跑 UTC Z 失败充当新证据。
- 当轮 L04 尚无给定修复 SHA；后续候选信息见第 9 节。**X3-F3-01 / X3-L04-01 均未签收修复，历史 33 通过/2 失败保持不变。**

### 只在允许目录调整测试结构

- 旧 `fixtures.ts` → `__fixtures__/fixtures.ts`；旧 `host.ts` → `__tests__/host.ts`；6 个测试文件只调整 helper import。构造器的 ROOT/HERE 仍指向原仓库/本 lane 临时目录，Rust SQL、golden、NULL 省略、UTC Z 和内部 bigint 原值断言保持不变。
- 另把 A/B 时间线标记的原始 SQLite 写入收拢到 fixture。生产打开/读取仍经原 storage/plugin 入口，不把 Host Runner 用作数据构造器。
- 既有 `isTestFile` 识别两目录，解决 SQL 被当生产扫描；但 `native-import` 在当前规则 `boundary-rules.mjs:114-115` **不区分测试**（main 同样）。保留单一、具名理由的行级 `boundary-allow native-import`：用户明确要求独立 better-sqlite3 构造历史样本。没有全局放宽扫描器，也没有拆字符串/动态加载绕开 import 扫描。

### 排队验证记录（保留 result 的退出码与 Errors）

```text
[作业 20261104064243-326a65] npx tsc -p host/e2e/data-compat/tsconfig.json --incremental --tsBuildInfoFile .lane.tsbuildinfo
[作业 20261104064243-326a65] 退出码 0
[作业 20261104064244-ccd3a8] npx vitest run -c vitest.host.config.ts host/e2e/data-compat/migrations.test.ts host/e2e/data-compat/secrets.test.ts --maxWorkers=1 --reporter=verbose
Test Files  2 passed (2)
     Tests  10 passed (10)
    Errors  无（运行器未输出 Errors 行）
[作业 20261104064244-ccd3a8] 退出码 0
[作业 20261104064507-9ec68c] npx vitest run -c vitest.host.config.ts host/e2e/data-compat/data-space.test.ts --maxWorkers=1 --reporter=verbose
Test Files  1 passed (1)
     Tests  4 passed (4)
    Errors  无（运行器未输出 Errors 行）
[作业 20261104064507-9ec68c] 退出码 0
[作业 20261104064507-2c6d3d] npx tsc -p host/e2e/data-compat/tsconfig.json --incremental --tsBuildInfoFile .lane.tsbuildinfo
[作业 20261104064507-2c6d3d] 退出码 0
```

测试日志有 Node WASI ExperimentalWarning，无 Errors；`result` 日志均保留退出码，data-space 与最后一次 tsc 以 `--tail 2000` 读取完整短日志。后两作业验证 native 导入收拢及最终类型状态。四个作业完整输出在 `/home/dsdev/.oc-jobs/done/<作业号>.log`。

以上只是本轮 helper 重定位验证，不取代历史全量报告，不把未运行的两项失败回归计为通过或平台 skip。无新增业务覆盖要求；修复集成后由 C2 派定向复核。

目录调整后 strict 边界检查（轻量语法门禁，不是 CPU 重任务）：

```text
DSTU_BOUNDARY_STRICT=1 node scripts/electron-migration/boundaries.mjs host/e2e/data-compat
(allowed) host/e2e/data-compat/__fixtures__/fixtures.ts:3:22 [native-import]
boundaries: scanned 8 files, 0 violation(s), 1 suppressed via boundary-allow
exit 0
```

第一次重定位检查曾报 2 个 native-import（exit 1），确认是规则对测试 native import 仍不豁免后，才收拢到独立 fixture 并加上面的单行理由；并非忽略这次失败。队列默认增量缓存 `.lane.tsbuildinfo` 属本次生成产物，收至本 lane `.tmp/`，后续提交命令显式指定缓存位置。

## 9. C2 08:26 回执：修复候选已写，等待正常集成与定向复核

本节记录协调者提供的信息，不冒充本 lane 已执行的 main 修复验证：

| 问题 | 已收到的候选信息 | 未完成条件 |
|---|---|---|
| X3-F3-01 | `f9cbf4d23` 已实现 `canonicalRfc3339Z`，据 C2 回执当时 main 仍为旧 canonical | 正式 main 的修复祖先确认；验证基线包含修复；原 UTC Z IPC 回归通过 |
| X3-L04-01 | 实现检查点 `320e45177` 的 `messages.ts.parseOptional` 据 C2 已对 SQL/JSON null 返回 undefined；不是尚未写修复 | 需要核实精确修复提交及其 main 祖先；验证基线包含修复；原 NULL 省略回归通过 |

集成通知到位后，仅排队运行 `platform.test.ts -t 'F3 llm_usage_recent'`、`services.test.ts -t 'L04 messages'` 两个原失败；不重跑未变的 35 项全目录。复核需保存精确修复 SHA、main/运行基线 SHA、作业号、Errors 与退出码；不运行 Rust、不改旧库、不弱化 SQL NULL 省略/9 位纳秒/内部 bigint 原值断言。

本次中断恢复时 HEAD 仍为 `612754137`、工作树干净。按最新用户恢复指令执行 `git log --oneline -20`、`git status`、阅读 TESTMAP 及一次 `npm run migration:ledger -- --check --no-write`；账本仍为 commands 0 problems / tests 250 problems / orphan registrations 0，exit **1**。这是恢复检查，不是两项候选的复核证据。未重复执行测试、未轮询 main、未把“分支上已有候选”写成“main 已可用”；历史 **33 通过、2 失败、0 跳过**保持不变。

## 10. X3-F3-01 签收（main `d84e29565`）；X3-L04-01 仍阻塞

- `f9cbf4d23` 已是 main `d84e29565` 和本 lane HEAD `4020dc985` 的祖先（exit 0）。原回归 `platform.test.ts -t 'F3 llm_usage_recent'` 经作业 `20261104120614-97f4dd` 通过，无 Errors，exit **0**；断言未改。**X3-F3-01 已签收。**
- `320e45177` 仍不是 main 祖先（exit 1）。X3-L04-01 原失败保留，不隔离、不 skip；本 lane 整体仍受其阻塞。
- lane-gate `20261104120614-0878b2` 另报 `data-space.test.ts` 多槽用例在共享队列下超过 30 秒，已仅放宽该用例时限至 120 秒，断言未改；详见 TESTMAP。

## 11. X3-L04-01 主线签收（2026-11-05）

- 正常合并 main 后，运行基线与 main 均为 `c6309183c4cddc06b3647530f3306f7906f2295b`。精确修复 `320e451774f269f1883c56b51fb975ece348eed6` 是两者祖先（各 exit **0**）。此前“未进入 main”的记录已失效。
- `host/plugins/chat/repository/messages.ts:38-42` 已将 SQL NULL/JSON null 映射 undefined，嵌套 Value null 不受影响；未改旧库或在本 lane 复制实现。
- 仅复验原 `services.test.ts -t 'L04 messages'`，作业 `20261105001522-cb081d`：**1 passed / 16 filtered**（Vitest 显示 skipped），无 Errors，exit **0**。真实宿主与原全字段断言未改，**X3-L04-01 签收**。
- X3-F3-01、X3-L04-01 两项均有正式 main 基线及各自原回归通过证据。历史全套统计不改写成此次 35 项全过；后续 lane-gate 独立记录。
- 结论仍限 Rust SQL 重放样本、固定密文向量和旧 ZIP 读取/暂存；不代表真实用户数据库、跨机密钥发布或整槽 restore 已端到端验证。第 6 节覆盖缺口保持有效。

## 12. 样本级验收完成证据

签收提交 `1a69a4f8d`，基线 main `c6309183c`：规定 lane-gate `20261105001910-067a1c` 全部通过，exit **0**。类型检查 `20261105002813-53febc`、边界 `20261105002813-9452ff` 均 exit **0**；测试 `20261105002813-68247d` 为 **35 passed / 0 failed / 0 skipped**，无 Errors，exit **0**。X3-F3-01 / X3-L04-01 均已主线签收。

本 lane 任务卡范围内已完成，保留所有原数据断言与历史失败证据。仅有样本级结论；本报告第 6 节覆盖缺口继续有效，未将真实用户数据库、跨机密钥发布或整槽 restore 纳入通过声明。
