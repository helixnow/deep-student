# X3-data-compat 测试映射

这是新增的跨 lane 兼容性验收，不冒充 Rust 单元测试的 `ported` 记录，也不修改 `migration/testmap/`。
样本是 **Rust SQL 重放数据库**，不是 Rust 二进制生成或脱敏的用户真实数据库。

## WP-116 增量（2026-11-06 UTC）

Rust 移植 pending **0→0**，兼容待修 **0→0**。新增 5 条 seed 自身验收，不变更 Rust 测试去向。
已全文审读 `dstu-anki/src/fsrs_review_service.rs:7150-7539` 两条 tombstone 测试；本包只复用构造输入，
未移植业务断言，差异（固定时间/ID、子卡未 rate、三组同库）见 SCENARIO-V0。

| `review-cas-tombstone-seeds.test.ts` | Rust 来源 / 断言 |
|---|---|
| :92 builds once | 既有 seed API 一次构造、A1/A2/B 独立目录及全部文件同字节、sql-constructed |
| :107 stores each reviewVersion | `S:4791-4818` local_version；六个精确 INTEGER，23 列 state、23 列 card、14 列 task 及关联 |
| :123 keeps the Rust card/task tombstones | `S:7150-7324,7327-7539` 构造；deleted_at 原行、活子 state、Processing task、无 review log |
| :142 differs from a pristine migration replay | 真实迁移及 trigger；只多 3 task / 9 card / 8 state / 31 change_log 和序列，无 DELETE |
| :188 Rust suspend CAS SQL | `S:2922-2938` 原 SQL，BigInt stale 0 行/精确 1 行/tombstone 0 行；i64::MAX 溢出 REAL 事实，源及 A1/A2/B 不变 |

`S=src-tauri/crates/dstu-anki/src/fsrs_review_service.rs`。定向 job `20261105194708-b008f6` 5 passed；
正式 gate tests `20261105195049-6fca48` 12 files / 71 passed / 0 failed / 0 skipped，Errors 0，exit 0。
原 `owner-databases.test.ts` 与 WP-115 `393c12d85` 无 diff，X3-L05-02 断言/预算均保留。

## WP-115 增量（2026-11-06 UTC）

Rust 移植 pending **0→0**，兼容待修 **1→0**：X3-L05-02 的原断言在 main 含 L05 WP-063（`33e266809`）后通过，
原测试未改（基线 job `20261105182339-e61a0e` 全目录 60 passed / 0 failed）。新增 `temp-sessions-seeds.test.ts` **6** 条 seed 自身验收
（SQL 构造，不是 ported Rust 单测，也不是 L22 命令等价证据）：

| 用例标题前缀 | 核心断言 |
|---|---|
| consumes the pinned L22 SQL | git 独立解析 commit:path=固定 blob；24/2/1 条语句；工作树同字节可读，多 1 字节即拒绝 |
| builds once with SQL-constructed provenance | provenance、五库 app-data 布局、空 local-data；A1/A2/B 文件列表与 sha256 同源 |
| keeps 24 temp_sessions rows | 24 个 temp_id、TEXT/BLOB 存储类、session_data 等于 SQL 字面量、高精度/重复键/代理/转义词素 |
| keeps the two settings rows | 2 行 settings 全列、唯一触发器原 DDL、refinery version 为 integer 原值 |
| differs from a pristine migration replay | 除三列迁移构造时间戳外，仅 1 schema + 2 settings + 24 temp_sessions 新增行 |
| trigger aborts Rust upsert | 隔离副本执行 mod.rs:4177-4183 原 SQL：tmp_readonly ABORT 且不变、其他行 upsert；源与三副本不变 |

## WP-094 增量（2026-11-05 UTC）

Rust 移植 pending **0→0**，兼容待修 **1→1**（X3-L05-02 不变）。新增 `skill-zip-seeds.test.ts` **7** 条
seed 自身验收（合成文件，不是 ported Rust 单测，也不是 L07 导入等价证据）：

| 用例标题前缀 | 核心断言 |
|---|---|
| publishes exact synthetic file names | 10 个精确文件名、relativePath/homePath、空 app-data/local-data、provenance |
| copies to independent A1/A2/B | 三份副本与重建逐字节相同、无数据库被枚举 |
| empty inputs | 0 字节；22 字节 EOCD 0 条目 |
| no-skill-md and root frontmatter | 条目名、SKILL.md frontmatter 原文、非法名称字符；JSZip 交叉读取 |
| legal multi-file folder | 7 条中央记录顺序、目录属性、256 字节二进制、CRC、JSZip |
| conflict archives | 两条同名中央记录不同内容；仅大小写不同的两名 |
| corrupt inputs | 非 ZIP 无 `PK`；截断包 EOCD 声明 3 条、实际 2 条，缺 46+8 字节 |

## WP-044 增量（2026-11-05 UTC）

Rust 移植 pending **0→0**，本 lane 兼容待修 **1→1**（X3-L05-02）；没有修改 Rust 测试映射。
新增 `scenario-v0.test.ts` **12** 条工具自身的真实 SQLite 正/负对照，不是 ported Rust 单测。
Rust 类型/迁移引用及接口约定见 `SCENARIO-V0.md`，不以同名测试冒充等价。

| 用例标题前缀 | 核心断言 |
|---|---|
| resolves exact seed names | empty 独立双根、非法名称/缺失源明确错误 |
| copies the same SQL-constructed | 八库字节一致、全表/全列枚举、workspace v1/i64/sqlite_sequence |
| reports precisely db/table | `document.title` 唯一精确 db/table/key/column 差异，A1/A2/源不变 |
| retains every real notes UPDATE | 真实 FTS/change-log/自增触发器的全部 10 处差异，业务列精确比较 |
| detects a one-unit i64 | >2^53 单位差、JSON u64 原文、SQL NULL 和 TEXT null 区分 |
| does not depend on HashMap | 对象键插入顺序无关，JSON 数组顺序不归一化 |
| enumerates new/missing | 增删库、空表、新列、删行不被 seed allowlist 漏掉 |
| pairs rows by primary key | 复合/WITHOUT ROWID/i64 数值排序，插行不错配已有行 |
| compares storage classes | INTEGER 1 ≠ REAL 1，BLOB 字节、相邻 double 精确不同 |
| compares no-PK rows | 多重集合插入顺序无关、重复行计数、generated 列读取 |
| reads committed WAL | 读到 committed WAL，WAL 文件原样，识别无扩展名 SQLite |
| surfaces unreadable DBs | 坏库不当空库、拒绝占用/源目标重叠 |

- 基线类型 `20261105155554-1e4f63` exit 0；基线全目录 `20261105155554-826f3d`
  **38 passed / 1 failed / 0 skipped**，Errors 0，exit 1，同一 X3-L05-02。
- 增量类型 `20261105160310-56f575` exit 0。
- 首次工具测试 `20261105160310-d83606`：8 passed / 3 failed / 0 skipped，Errors 1（RPC timeout），exit 1。
  字节测试误用 Vitest 的大 Buffer 递归比较达 55s；改为 Buffer.equals，仍比较全部字节、超时预算不变。
  两处“一次 SQL 更新只有一条差异”预期不符合真实 `V20260131__add_change_log.sql:76–81`、
  `V20260724__notes_fts.sql:66–78` trigger；新增全部副作用断言，单差异验收改用无 trigger 的
  workspace document，原 39 条生产兼容断言零修改。
- 修正后 `20261105160805-7e4ed6`：**12 passed / 0 failed / 0 skipped**，Errors 0，exit 0。
- 独立 CLI 入口 `scenario-cli.test.ts` 新增 2 条：真实 Node 加载/seed/copy/snapshot/compare JSON；
  真实差异 exit 1 与参数/seed/读取错误 exit 2。job `20261105161500-ecc220`：
  **2 passed / 0 failed / 0 skipped**，Errors 0，exit 0。合计新增 14 条工具验收。
- 完整最终 gate 结果见审计报告；本表工具通过不代表整体生产兼容通过。
- 正式 gate 测试 `20261105163939-5acb94`（tip `1115ae52a`）：**52 passed / 1 failed / 0 skipped**，
  Errors 0，exit 1，仅 X3-L05-02；全 Host typecheck `20261105163939-d7d6ac` exit 0。
  父 gate `20261105163025-e1de5e` 最终128/SIGTERM；普通边界 `20261105163939-974465`
  与严格边界 `20261105163939-28916f` 随后均exit 0、0 violation。未重跑检查，整体仍红。

## WP-013 当前增量（2026-11-05）

Rust 移植映射 pending **0 → 0**（本 lane 没有 Rust ported/pending 条目，未改变其他 lane 映射）。
新增兼容验收待修 **0 → 1**：X3-L05-02。原用例 35 → 39；新增 4 项为以下独立 E2E，不用同名 Rust 单测冒充等价映射。

| 新用例（`owner-databases.test.ts`） | Rust 生产语义来源 | 新覆盖表/版本、关键断言 | 当前结果 |
|---|---|---|---|
| `audit: original unversioned Rust schema…` | `dstu-storage/src/audit/mod.rs:193-224,365-417,767-816` | `__audit_log` 原始无版本 schema；全九列、SQL NULL/JSON null、Incremental、u64 JSON、i64 duration、纳秒偏移时间、3 索引；owner init→重开→再次 init 不变，无 refinery history | passed |
| `sync_state: prior six-table Rust schema…` | `dstu-sync/src/data_governance/sync/state.rs:22-117,119-173,224-306,309-437` | upload_seq/consume_cursor/legacy_processed_key/tombstone_watermark/instance_binding/device_history；六表旧 schema 经 owner 增加 tombstone_event_publish；全部原列/时间/设备历史不变，精确 9007199254740993n，新表真实 owner 写入并重开幂等、绑定错误保持 | passed |
| `workspace: actual Rust user_version 1…` | `dstu-agent/src/chat_v2/workspace/database.rs:160-218,230-244,300-302`；`repo.rs:492-648`；`subagent_task.rs:434-472` / `sleep_manager.rs:1133-1186` | workspace/agent/message/inbox/document/context/sleep_block/subagent_task + sqlite_sequence；真实 V1→V2，schema 对象不变；全列/NULL/JSON/时间/bigint 原样，coordinator 及 task/sleep 公开读取、再次构造 owner 幂等 | passed |
| `workspace: persisted unread inbox…` | `dstu-agent/src/chat_v2/workspace/coordinator.rs:586-605,986-1067` | unread SQL 仍为 1，peek 应返回原完整消息，重复 peek 后行不变；Host `loadInstance` 抛弃已恢复队列 | **failed，X3-L05-02** |

生产可达：backup `index.ts:196` / `src/governance.ts:165` → audit 仓储；sync-support `index.ts:51` → SqliteSyncStateStore；agent-workspace `index.ts:93-117` → WorkspaceCoordinator。测试直接实例化这些真实 owner，以 F3 服务提供全部 SQLite I/O，未安装替身或复制迁移实现；不是 GUI/IPC serde 验证。

历史 SQL 的固定 SHA 与原行号见 `__fixtures__/historical/SOURCES.md`。新增 15 个旧库 seed 表 + 1 个升级后 owner 写入表，旧 refinery history 方式保持；新三库按原生机制断言 history **不存在**。

- 起点：tsc job `20261105140523-82f2c6` exit 0；6 files / **35 passed / 0 failed / 0 skipped**，job `20261105140523-a48de6` exit 0，Errors 0。
- 新 owner 类型检查：job `20261105142007-c8c202` exit 0。
- 首次回归：job `20261105142007-f209ef`，2 passed / 1 failed，exit 1；workspace 在 peek 失败后尚未执行其余断言。
- 将同一 peek 断言移入独立回归（未改预期、无 skip），让全列/重开证据能够完整执行：job `20261105142528-6d4c3d`，**3 passed / 1 failed / 0 skipped**，Errors 0，exit 1。失败仅 X3-L05-02。
- 历史 SQL 对固定 Rust Git 正文核验：job `20261105142639-df45f5` exit 0，三份相等。
- 最终代码 tip `0b6c7bbd8` / main `b55af5d85`：gate tests `20261105150116-3326d4` **38 passed / 1 failed / 0 skipped**，Errors 0，exit 1，唯一失败 X3-L05-02。typecheck `20261105150116-3040f0`、普通边界 `20261105150116-94445f`、严格边界 `20261105150116-731a27` 均 exit 0。
- gate 父 job `20261105145307-027b3f` 在四子项派发后被共享执行器重启中断（code -1，客户端 exit 1）；子项原件均已取回，不引用旧 selfgate 的成功记录。此前 gate `20261105143648-1ceef5` 因 main 更新在前置检查 exit 2。
- 恢复指令只读 ledger `20261105144423-4bcdac` exit 0；problems 0/0/0，但 unreachable 22 / unknown 3702（not vetoed），不是本包测试通过声明。
- 未覆盖：workspace `task_content` 回填（真实 V1 原 SQL 已有新列，不能伪造缺列）；superagent 旧开关迁移；审计错误行全部分支；损坏库恢复；激活的 sleep 计时器；跨平台/IPC 序列化；真实用户库及整槽 restore。

## 运行

在仓库根目录执行（需要可供当前 Node ABI 加载的 better-sqlite3）：

```bash
node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs submit -- npx vitest run -c vitest.host.config.ts host/e2e/data-compat --maxWorkers=1 --reporter=verbose --reporter=json --outputFile=host/e2e/data-compat/results.json
node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs submit -- npx tsc -p host/e2e/data-compat/tsconfig.json --incremental --tsBuildInfoFile host/e2e/data-compat/.tmp/typecheck.tsbuildinfo
```

生成的 SQLite、密钥与 ZIP 只在本目录 `.tmp/case-*` 内，测试后清理；`.tmp/` 和 JSON 运行结果不提交。
不调用 cargo/rustc，不启动 Electron GUI，不访问真实用户目录、网络或系统密钥库。
`__fixtures__/fixtures.ts` 独立重放 Rust SQL、保留原始 i64；`__tests__/host.ts` 安装真实生产插件。没有改用被测迁移器构造样本。
所有重任务先 submit，之后用 `job.mjs result <作业号> --tail 2000` 取完整短日志与退出码（长日志应读其完整输出文件）；只有无其他工作时才 wait。增量缓存显式放本 lane `.tmp/`。

## 历次全量映射与结果（2026-11-04，2c1e32587）

| 文件 | 数量 | 验证对象/独立 oracle | 结果 |
|---|---:|---|---|
| `migrations.test.ts` | 5 | 129 条已存 Rust checksum 金标；生产 MigrationDef 对应；损坏 checksum 负对照；5 库 head 重开两次；4 核心库各追加最后一条后再次幂等 | 5 通过 |
| `services.test.ts` | 17 | SQL 显式插入值，对照真实插件公开 service/IPC；全部 seed 列对照 better-sqlite3 原始快照 | 16 通过，1 失败（X3-L04-01） |
| `platform.test.ts` | 2 | 真正 F3 插件启动；`llm_usage_recent` 对照 Rust `UsageRecord` 的 UTC serde 字符串 | 1 通过，1 失败（X3-F3-01） |
| `secrets.test.ts` | 5 | F4 固定 v3 `.enc`、`.master_key`、pre-v2、DSBK v1/v2 向量；仅经公开 secrets 服务解密 | 5 通过 |
| `data-space.test.ts` | 4 | A/B 不同时间线；pending 切换；legacy root 连续启动；C/D 显式文件读取 | 4 通过 |
| `zip.test.ts` | 2 | 独立 JSZip + Rust BackupManifest v1/v2 形状；真实 L21 导入命令/任务；4 库所有 seed 列与 history 完整比对 | 2 通过 |
| **合计** | **35** | 不用 `it.fails`、skip 或 mock 隐藏不兼容 | **33 通过，2 失败，0 跳过** |

### `services.test.ts` 的 17 个行为

1. L04 session：纳秒 UTC、metadata、NULL 省略、整数布尔。
2. L04 message：毫秒整数、block 顺序、会话关联、NULL 应省略（X3-L04-01）。
3. L04 block：中文/emoji、JSON null 与 SQL NULL。
4. L10 note：元信息、标签、收藏、正文、原始 TEXT 时间。
5. L11 resource：metadata、引用数和毫秒时间。
6. L11 file/blob：大整数、原始 preview JSON、NULL 省略。
7. L11 folder：整数时间与布尔。
8. L11 todo list/item：JSON 空白原样、混合 TEXT 时间与默认值。
9. L11 translation：正文与 metadata。
10. L11 question/history：选项、structured_data、NULL 正误、版本记录。
11. L11 review plan：REAL、日期、NULL 与布尔。
12. L16 template：fields、preview JSON、纳秒 UTC。
13. L16 card IPC：任务关联、字段 JSON、String 时间原样。
14. L04 state：草稿、features 和原始更新时间。
15. F4 setting：JSON 字符串与更新时间原样。
16. F3 `safeIntegers`：`9007199254740993n` 精确读回。
17. 所有公开读后，对 32 个 seed 表的每一列作原值比对。

完整表清单、不兼容与未覆盖范围见 `docs/dev/electron-migration/audits/X3-data-compat.md`。

## 本轮目录分类验证（不属于 owner 修复复核）

- 当轮 main `9c13dfc39` / 本工作树均未包含 F3 候选 `f9cbf4d23`（ancestor exit 1）；当轮 L04 尚无给定修复 SHA。此为历史基线记录，不是后续 main 的实时状态。
- 作业 `20261104064243-326a65`：本目录严格 tsc（含嵌套 helper）exit 0。
- 作业 `20261104064244-ccd3a8`：`migrations.test.ts` + `secrets.test.ts`，10 通过，Errors 无，exit 0；仅验证 helper 移动后的路径与独立样本，不更新两个待修问题状态，不宣称 35 项全过。
- 作业 `20261104064507-9ec68c`：`data-space.test.ts` 4 通过，Errors 无，exit 0；同一 SQLite 时间线标记写入收拢到 fixture 后行为不变。
- 作业 `20261104064507-2c6d3d`：最终 helper 状态严格 tsc exit 0。
- strict 边界：8 文件、0 违规、1 个具名理由的 native-import 行级豁免，exit 0。`isTestFile` 不豁免 native import，所以仅在独立 SQLite fixture 保留该显式豁免；未改全局规则。详见审计报告续记。

## C2 08:26 回执后的等待状态

- F3：候选 `f9cbf4d23` 已有 `canonicalRfc3339Z` 实现；不是“尚未实现”。待正常集成及可验证基线确认。
- L04：实现检查点 `320e45177` 的 `parseOptional` 据 C2 已对 SQL/JSON null 返回 undefined；该检查点尚不能代替精确修复提交/祖先核实。不是“尚未写修复”。
- 正式 main 包含对应精确修复 SHA、且验证工作树包含该基线后，只经全局作业队列复测 `platform.test.ts -t 'F3 llm_usage_recent'` 与 `services.test.ts -t 'L04 messages'`，保留作业号、Errors、退出码与基线 SHA。
- 本次恢复仅核对提交/工作树、阅读本 TESTMAP，并按最新用户恢复指令执行一次只读 ledger（仍 tests 250 problems、exit 1）；未执行测试、未轮询集成、未改变历史 33 通过/2 失败结论。两个原失败及所有数据断言保持。

## 集成门禁修复（合并 main `8f2a9823b` 后，HEAD `7fcbd3955` + 本提交）

门禁报出的失败分三类。前两类已在本 lane 内修复；第三类是两个 owner lane 的修复尚未进入 main，属于真实不兼容：

| 门禁现象 | 原因 | 处理 |
|---|---|---|
| `platform/services/zip` 的 `beforeAll` 超过 10 秒 | 132 条 Rust SQL 重放加真实插件启动，在共享 CPU 下超过 Vitest 默认 hook 时限 | 仅给三个初始化 hook 设 60 秒上限并写明原因；未改断言、未 skip |
| `dstu.browser did not start: "log", "featureFlags"` | main 中 browser 新增 `inject: ['log','featureFlags']`，辅助宿主只提供 `createStorageService` 直接返回的 storage | `__tests__/host.ts` 改为安装真实 F3 `storage` 插件（同时提供 storage/dataSpace/featureFlags/noteAssets）和真实 F4 log 服务；不写替身、不复制 F3 工具 |
| `F3 llm_usage_recent` UTC Z、`L04 messages` NULL 省略 | main `eeaf5bdc7` 仍不含 `f9cbf4d23`、`320e45177`（ancestor exit 1）；`llm-usage.ts:667` 仍用 `canonicalRfc3339`，`messages.ts:38-41` 仍对 SQL NULL 返回 null | **保留失败**。即 X3-F3-01 / X3-L04-01，归属 F3 / L04；本 lane 不改实现、不反转断言 |

队列作业（本工作树）：

- `20261104105317-160db5` `npm run typecheck:host`：exit **0**。
- `20261104105320-2ed335` `npm run migration:boundaries`：2390 文件、0 违规，exit **0**。
- `20261104105320-1b34a5` `npx vitest run -c vitest.host.config.ts host/e2e/data-compat`：Test Files 2 failed / 4 passed，Tests **2 failed / 33 passed (35)**，0 skipped，无 Failed Suites，exit **1**。两项失败即上表第三行；hook 超时和插件启动失败已消失。
- ledger（只读）：commands 0、tests 0、orphan 0 problems，exit 0。

在这两个回归修复前，门禁仍会失败。解除条件：F3、L04 修复进入 main 后，再合并并复测。在此之前是否隔离这两条断言由协调者决定，本 lane 不自行 skip 或改用 `it.fails`。

## X3-F3-01 签收；X3-L04-01 仍阻塞（合并 main `d84e29565` 后，HEAD `4020dc985`）

- 祖先：`git merge-base --is-ancestor f9cbf4d23 main` exit 0，对 HEAD 同样 exit 0；`llm-usage.ts:667` 已为 `canonicalRfc3339Z(...) ?? rfc3339ZFromMillis(...)`。`320e45177` 对 main exit 1（只在 `ds-mig/L04-chat-session`），main 的 `messages.ts:38-41` 仍对 SQL NULL 返回 null。
- **X3-F3-01 签收**：作业 `20261104120614-97f4dd` `npx vitest run -c vitest.host.config.ts host/e2e/data-compat/platform.test.ts -t "F3 llm_usage_recent"`，1 passed / 1 skipped（`-t` 过滤掉的另一条），无 Errors，exit **0**。原断言（UTC `Z`、9 位纳秒）未改。
- lane-gate 作业 `20261104120614-0878b2`（tip `4020dc985`）：4 项中 typecheck、boundaries、boundaries-strict(changed) 通过；tests exit 1，失败为：
  - `L04 messages`：X3-L04-01 原失败，保留，不隔离；
  - `data-space.test.ts` slotB/pending 用例 `Test timed out in 30000ms`（31.9s）：每例为两个槽重放全部 Rust SQL 并两次启动，在共享队列下超过 30 秒默认时限。仅给两条多槽/多次启动用例设 120 秒上限，断言未改。
- 总体状态：**仍受 X3-L04-01 阻塞**，等 L04 修复进入 main 后只复测 `services.test.ts -t 'L04 messages'`。
- 复跑 lane-gate 作业 `20261104122211-05ffdf`（tip `3384fd23d`，main `45c3250b0`）：typecheck、boundaries、boundaries-strict(changed) 通过；tests 只剩 `L04 messages` 1 项失败（X3-L04-01），data-space 超时已消失；exit **1**。`320e45177` 仍不是 main 祖先。

## 后续自检证据与剩余事项

- lane-gate `20261104150117-d0ae87`（tip `b0b416ce5`，main `879e0a56b`）exit **1**；类型检查 `20261104150128-53cdad`、普通边界 `20261104150128-bede81`、严格边界 `20261104150128-95ab9d` 均 exit **0**。
- tests 子作业 `20261104150128-74bf3d`：**34 passed / 1 failed / 0 skipped**，无 Errors，exit **1**。唯一失败为 X3-L04-01，两个额外 null 字段差异未变。
- 本轮合并 main `4525e11ac`（合并提交 `29e40d3ff`），`320e45177` 仍不是 main 祖先（exit 1）；尚不能复验签收 L04。剩余事项及 standard-v2 §1 适用范围现归档于本目录 `LANE.md`，未标记完成。

## main `677f6727c`：VFS 新依赖接线

- 合并提交 `633b423ed` 的 lane-gate `20261104160508-65281a` exit **1**；typecheck、普通/严格边界均通过。
- tests `20261104160520-bc8d08`：18 passed / 17 skipped，Failed Suites 1，无 Errors 行，exit **1**。17 项是套件初始化失败后未执行，不是显式 skip；原因是 `dstu.vfs` 缺必需服务 `vfsIndex`，不是 L04 已修好。
- `__tests__/host.ts` 增加真实 L12 `vfs-index` 插件，与 main 中 VFS 新 inject 对齐；不 mock 服务、不复制实现，不改 35 项数据断言。原 services 套件能捕获此初始化回归。
- `320e45177` 仍不是 main 祖先（exit 1）；X3-L04-01 尚不能签收。

### 真实 L12 接线复验

- 修正提交 `ef1538432`，基线 main `677f6727c`；lane-gate `20261104161538-448e0f` exit **1**。
- typecheck `20261104161539-8c19b6`、普通边界 `20261104161539-d27db7`、严格边界 `20261104161539-d20a57` 均 exit **0**。
- tests `20261104161539-5188d1`：**34 passed / 1 failed / 0 skipped**，无 Errors、无 Failed Suites，exit **1**。services 套件已正常启动，唯一失败为原 X3-L04-01。
- 后续合并 main `d51544ecf`（合并提交 `81a0cd529`），L04 实现仍未变化，未将 owner 分支上的候选当作 main 已可用。

## 2026-11-05：X3-L04-01 主线签收

- 正常 merge main 后快进到 `c6309183c4cddc06b3647530f3306f7906f2295b`，修复 `320e451774f269f1883c56b51fb975ece348eed6` 对 main、HEAD 的祖先检查均 exit **0**。
- 原定向命令 `npx vitest run -c vitest.host.config.ts host/e2e/data-compat/services.test.ts -t 'L04 messages'`，作业 `20261105001522-cb081d`：**1 passed / 16 filtered**（Vitest skipped 为 `-t` 过滤），无 Errors，exit **0**。真实宿主、种子及 SQL NULL 省略断言均未改。
- **X3-L04-01 已签收**；先前“未进入 main”“唯一阻塞”仅适用于其历史基线，不再代表当前状态。X3-F3-01 已有独立签收证据。
- 此次只复验原 L04 目标，未另行重跑 35 项、未跑 ledger。后续按规定运行 lane-gate；验收仍是样本级，覆盖缺口保持审计报告所列边界。

### 签收后的规定 lane-gate

- tip `1a69a4f8d` / main `c6309183c`；lane-gate `20261105001910-067a1c`：**全部通过，exit 0**。
- 类型检查 `20261105002813-53febc`、边界检查 `20261105002813-9452ff` 均 exit **0**；相对 main 仅改文档，gate 未列 changed-source strict 检查。
- tests `20261105002813-68247d`：6 files passed，**35 passed / 0 failed / 0 skipped**，无 Errors，exit **0**。这是规定 gate 内的全目录复验，不将此前定向 1 passed 伪称为全套通过。
- LANE 已标记样本级任务“已完成”；历史失败与覆盖缺口保留。
