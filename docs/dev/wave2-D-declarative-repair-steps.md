# 0824 Wave2-D R5：coordinator 声明式 repair step 设计稿（中期）

> 定位：**中期设计稿**。本轮（R5）不做任何重构、不改产品代码、不编译、不 commit。
> 本文只冻结"目标形态 + 迁移路径 + 红线继承"，供后续轮次按阶段实施。
> 事实基线：R1 锚定报告 `/tmp/0824-wave2-r1-reports/06-coordinator.md`（仓库 tip
> `bfbe1951`，分支 `cursor/0824-wave2-cloud-data-a875`）。文中行号均指该 tip 下的
> `src-tauri/src/data_governance/migration/coordinator.rs`（约 8.7k 行），除非另注。
> 关联文档：`docs/dev/wave2-D-config-state-machine.md`（R2 云配置状态机，其"唯一
> 发布点 / fail-closed / 失败矩阵"方法论是本文的范式来源）。

---

## 1. 现状：verifier 声明式，repair 硬编码

R1 锚定的核心结论（06-coordinator.md §5）：

> **verifier 侧有声明式框架，repair 侧没有——修复是逐版本硬编码特例 + 两个半
> 通用机制。**

具体拆开：

### 1.1 已声明式的部分（只用于验证，不驱动修复）

`MigrationDef`（`definitions.rs`，`vfs.rs:43` 引入）携带
`with_expected_tables / with_expected_indexes / with_expected_queries / idempotent`
（`vfs.rs:56-64` 等），由 MigrationVerifier 消费（`verify` 调用见
coordinator.rs:4057 附近）。也就是说：**"这版迁移之后 schema 应该长什么样"已经
有结构化描述**，但这份描述目前只拿来"验"，不拿来"修"。

### 1.2 硬编码特例（逐版本手写方法）

- vfs：`pre_repair_vfs_v20260204`（:3044）、`v20260205`（:3115）、
  `v20260209`（:3149）、`v20260210`（:3181）、
  `pre_repair_vfs_v20260824_note_props`（:2345）、
  `apply_vfs_init_missing_tables`（:2383）；
- chat：`pre_repair_chat_v2_*`（:3245 / :3427 / :3515）；
- mistakes：`pre_repair_mistakes_schema`（:3587）；
- llm_usage：`pre_repair_llm_usage_schema`（:3823）。

分派方式是 `pre_repair_schema`（:2215）按 `DatabaseId` match，**无注册表、无
step 列表抽象**。每新增一个"补丁版本"就要新增一个手写方法 + 一处调用 + 一组
测试，且顺序约束（见 §1.4）只存在于注释里。

### 1.3 两个半通用机制（介于两者之间）

1. `make_alter_columns_safe`（:1769）——运行时解析迁移 SQL 里的
   `ALTER TABLE ADD COLUMN` 自动补列 / 重放剩余 SQL / 记账，但**冻结在
   `STARTUP_COMPAT_REPLAY_MAX_VERSION = 20260801`**（:166）：之后的版本必须
   显式 pre_repair。`pre_repair_vfs_v20260824_note_props` 正是这个冻结的直接
   产物——它说明"每超过冻结边界一次，就要手写一个特例"这条路线不可持续。
2. `repair_vfs_v20260714_vector_index_profiles`（:2799）——gap **检测**已经在
   消费 `MigrationDef.expected_tables/expected_columns/expected_indexes`
   （:2875-2884），但修复动作（补列清单 :2847-2857、DDL-only 索引重建
   :2898-2914）仍是手写。这是"声明式检测 + 手写修复"的过渡形态，也是本设计
   最自然的生长点。

### 1.4 顺序硬约束只活在注释里

VFS 子链 `pre_repair_vfs_schema`（:2270-2334）的顺序不可交换，典型例子：
`apply_vfs_init_missing_tables`（:2280）**必须先于** `ensure_change_log_table`
（:2284）——V20260131 的 SQL 给 questions/notes/review_plans/folders 建触发器，
旧库若只有 resources/notes，先回放 change_log 会报
`no such table: main.questions`（注释 :2276-2278）。这类约束目前靠注释 + 测试
锁定，没有任何编译期或数据结构层面的表达。

### 1.5 已知契约缺口（声明式化要顺带能表达的）

R1 §4 记录：`apply_vfs_init_missing_tables` 的抽取器
`extract_create_table_if_not_exists`（:2435-2472）只抽
`CREATE TABLE IF NOT EXISTS`（并用 16 字符 lookback 排除 VIRTUAL），因此稀疏库
重建路径**不补** `idx_folders_parent`（init.sql:308）、`questions_fts` 及其三个
触发器（init.sql:468-499）、`trash_view`（init.sql:768）——而 V20260130 的
`MigrationDef` verifier 契约（`vfs.rs:175-180`、`vfs.rs:208`）恰恰要求它们存在。
即：**修复产物不满足验证契约**。这不是本文要立刻修的 bug，而是声明式模型必须
能表达"表 / 索引 / 视图 / 触发器 / 虚拟表"各自的补建策略，缺口才有地方收敛。

---

## 2. 目标与非目标

### 目标

- G1：新增一个"补丁版本"的常态成本从"手写一个方法 + 插一处调用"降为
  "在注册表里追加一条声明式 step"。
- G2：顺序约束、幂等守卫、失败策略从注释级约定升级为**数据结构字段**，可以
  被单元测试直接枚举断言（"链上任何 step 的守卫集合非空""降级点白名单只有
  这两个"）。
- G3：修复动作与 `MigrationDef` 的期望契约（expected_tables/columns/indexes）
  逐步共用同一份数据源，消灭 §1.5 那类"修复产物不满足验证契约"的错位。
- G4：现有行为**逐字节保持**——声明式化是表达方式的重构，不是语义变更。每个
  存量特例迁移到 step 后，其既有测试（如 :5388、:5797、:5858、:5873）必须原样
  通过。

### 非目标

- 不做通用"schema diff → 自动修复"引擎。自动 diff 修复正是
  `STARTUP_COMPAT_REPLAY_MAX_VERSION` 冻结所警惕的方向（"残留问题必须显式
  处理……不再被自动修复"，:156-166）。声明式 ≠ 自动化：**每条 step 仍然是
  人写的、针对已知具体病灶的、带版本号的显式修复**，只是表达为数据而非代码。
- 不改 Refinery 主流程（`runner.run()`、`set_grouped(false)`、
  `set_abort_divergent/missing(false)`，:1598-1628）。
- 不动两个加法红线函数的**语义**（`apply_vfs_init_missing_tables` /
  `pre_repair_vfs_v20260824_note_props`）；它们最后阶段才收编，且收编后测试
  断言不变（见 §7 阶段 C 与 §8）。
- 本轮（R5）不写任何实现代码。

---

## 3. 声明式模型

### 3.1 核心类型（形态示意，字段名可在实施时微调）

```rust
/// 一条修复步骤：guard 全通过才执行 actions，执行完可选记账。
struct RepairStep {
    /// 稳定标识，用于日志、测试枚举、顺序断言。
    id: &'static str,
    /// 目标库。注册表按库分组，替代 pre_repair_schema 的手写 match。
    database: DatabaseId,
    /// 关联迁移版本（纯防御类 step 可为 None，如 ensure_change_log_table）。
    version: Option<u32>,
    /// 前置守卫：全部为真才执行。空守卫集合非法（见 §3.3）。
    guards: Vec<RepairGuard>,
    /// 修复动作，按序执行。
    actions: Vec<RepairAction>,
    /// 失败策略。缺省 Abort（fail-close）；WarnContinue 必须显式声明并
    /// 进入降级点白名单测试（见 §6-R7）。
    on_failure: FailurePolicy,
}

enum RepairGuard {
    MigrationRecorded { version: u32, expect: bool },
    TableExists { table: &'static str, expect: bool },
    ColumnExists { table: &'static str, column: &'static str, expect: bool },
    IndexExists { index: &'static str, expect: bool },
}

enum RepairAction {
    /// 幂等建表（CREATE TABLE IF NOT EXISTS 级别；DDL-only）。
    EnsureTable { table: &'static str, sql: &'static str },
    /// 幂等补列（column_exists 守卫后 ALTER TABLE ADD COLUMN）。
    EnsureColumn { table: &'static str, column: &'static str, decl: &'static str },
    /// 幂等补索引 / 视图 / 触发器（DDL-only，回应 §1.5 缺口）。
    EnsureIndex { sql: &'static str },
    EnsureView { sql: &'static str },
    EnsureTrigger { sql: &'static str },
    /// 记账：ensure_refinery_history_table + mark_migration_complete。
    MarkRecorded { version: u32 },
    /// 受限回填 DML：必须显式声明，且默认继承 step 的 on_failure；
    /// 今日全链唯一 warn-and-continue 回填是 V20260204（:3098-3106）。
    Backfill { sql: &'static str },
    /// 逃生舱：无法声明化的逻辑（见 §5），保留为具名闭包/方法引用。
    Custom { name: &'static str, run: fn(&Connection, &RepairContext) -> Result<(), MigrationError> },
}

enum FailurePolicy { Abort, WarnContinue }
```

### 3.2 注册表与执行器

- 每库一张**有序** `&[RepairStep]` 静态表（如 `VFS_REPAIR_STEPS`），顺序即
  执行顺序，直接取代 `pre_repair_vfs_schema` 内的手写调用序列。§1.4 的顺序
  硬约束由此变成"数组里谁在前"这一可测试事实，并配一条枚举断言测试锁定
  相对次序（例如 `vfs_init_missing_tables` 的下标必须小于
  `ensure_change_log_table`）。
- 执行器是唯一一段新增的通用代码：遍历 steps → 逐条评估 guards →
  全真则按序执行 actions → 按 `on_failure` 处置。guard 评估复用既有原语
  `is_migration_recorded`（:3934）、`table_exists`（:2250）、
  `column_exists`（:2232），不新造探测逻辑。
- 执行器在 `run_refinery_migrations` 流水线中的位置**不变**：仍是步骤 1
  `pre_repair_schema`（调用 :1615）的内部实现替换；步骤 0 清理、步骤 2 gap
  修复、步骤 3 checksum、步骤 4 `make_alter_columns_safe`、步骤 5
  `runner.run()` 的入口顺序（:1611-1630）原样保留。步骤 2 的
  `repair_recorded_migration_schema_gaps` 在阶段 B 之后也可改由同一执行器驱动
  （其检测已消费 `MigrationDef`，见 §1.3-2），但这是可选延伸，不是前置条件。

### 3.3 模型级不变量（实施时用单元测试锁定）

- **I-R1 守卫非空**：任何 step 的 `guards` 不得为空——R1 §2 的幂等性总评
  （"所有特例都用 is_migration_recorded / table_exists / column_exists 守卫，
  新库一律空过"）升格为结构性校验：一条枚举测试遍历全注册表断言
  `!guards.is_empty()`，并断言新库（无表）路径下全链空过。
- **I-R2 降级点白名单**：`on_failure == WarnContinue` 的 step 集合是白名单，
  测试逐条枚举。当前合法集合只有两个成员（V20260204 回填 DML、中间表 DROP
  失败，R1 §2/§6），新增成员必须改测试 + 过评审。
- **I-R3 DDL/DML 分离**：`EnsureTable/EnsureColumn/EnsureIndex/EnsureView/
  EnsureTrigger` 动作内禁止夹带 DML；回填必须用显式 `Backfill` 动作。这把
  V20260714 的"DDL-only 分支防长回填"经验（:2895-2897 注释）从个案注释升为
  动作类型约束。
- **I-R4 记账在动作序末尾**：`MarkRecorded` 若存在，必须是该 step actions 的
  最后一项——对应既有红线"绝不允许整条预标记而跳过回填"（测试锁定
  :8060-8061 注释 + :8111/:8161/:8204，R1 §6-7）。枚举测试可直接断言。

---

## 4. 与 MigrationDef 的关系

- 短期（阶段 A/B）：`RepairStep` 与 `MigrationDef` 并存，互不引用。verifier
  继续只做验证。
- 中期（阶段 C 后）：`EnsureColumn/EnsureIndex` 的目标清单允许**引用**
  `MigrationDef.expected_columns/expected_indexes`（一处声明、两处消费），把
  §1.3-2 的过渡形态（声明式检测 + 手写修复）走完。V20260714 的 gap 修复是
  第一个试点。
- 明确不做：verifier 失败自动触发 repair。验证失败仍按现状处置；repair 只由
  注册表驱动、只在既有流水线位置运行。"验证"与"修复"共享数据源但不共享
  触发路径，避免制造隐式自愈回路。

---

## 5. 存量特例映射表

逐条评估"能否声明化"。**能声明化 ≠ 必须立刻迁移**（节奏见 §7）。

| 特例 | 行号 | 声明化评估 |
| --- | --- | --- |
| `pre_repair_vfs_v20260205` | :3115 | **完全可声明**：1 列 + 1 索引，残留才标记 → guards（recorded=false + column_exists=true）+ EnsureColumn + EnsureIndex + MarkRecorded。首批试点。 |
| `pre_repair_vfs_v20260209` | :3149 | **完全可声明**：纯记账（列已存在→标记完成）→ guards + MarkRecorded。首批试点。 |
| `pre_repair_vfs_v20260210` | :3181 | **可声明**：3 列 + `answer_submissions` 幂等建表 → EnsureColumn×3 + EnsureTable。 |
| `pre_repair_vfs_v20260204` | :3044 | **可声明但需 Backfill 动作**：5 列 + 3 索引 + 2 条回填 UPDATE；回填是全链唯一 warn-and-continue（:3098-3106），映射为独立 `Backfill` step、`on_failure = WarnContinue`，进入 I-R2 白名单。DDL 部分与回填部分拆成两条 step，天然满足 I-R3。 |
| `ensure_change_log_table` / `ensure_vfs_deleted_at_core` | :2284 / :2312 | **可声明**：防御性 EnsureTable / EnsureColumn，`version: None`。 |
| V20260201 同步字段三分支 | :2291-2315 | **半可声明**：三分支（recorded→compat 补列；未记录但列冲突→compat+补记账；正常→只补核心表 deleted_at）可拆成三条互斥 guard 组合的 step；若拆完可读性反而下降，保留 `Custom` 亦可接受，实施时二选一。 |
| `pre_repair_vfs_v20260824_note_props` | :2345 | **红线函数，最后收编**：`(recorded, has_props)` 双态矩阵四分支（R1 §1）可拆为两条 step——(true,false)→EnsureColumn；(false,true)→MarkRecorded；(false,false)/(true,true) 由 guards 天然空过。语义一一对应，但因属加法红线，放阶段 C 且要求测试 :5388 及端到端 :5361-5373 原样通过。 |
| `apply_vfs_init_missing_tables` | :2383 | **红线函数，长期保留 Custom**：SQL 抽取（`extract_create_table_if_not_exists`）、`notes_versions` 受 V20260214 记录守卫、V20260824 已记录时对重建 notes 补 props、`PRAGMA foreign_keys` 临时开关与恢复——这套动态逻辑不值得硬塞进声明模型。以 `Custom` step 形式挂进注册表（从而获得顺序断言与守卫枚举的收益），内部实现不动。§1.5 的索引/FTS/视图缺口若要补，以**追加** EnsureIndex/EnsureView/EnsureTrigger step 的加法方式做，不改此函数本体。 |
| `pre_repair_chat_v2_*` / `pre_repair_mistakes_schema` / `pre_repair_llm_usage_schema` | :3245/:3427/:3515/:3587/:3823 | 阶段 C 逐个评估；预期多数是 EnsureColumn/EnsureTable/MarkRecorded 组合，少数留 Custom。 |

`Custom` 的纪律：它是逃生舱不是后门——新增病灶**必须先尝试用声明动作表达**，
写 Custom 需要在 step 注释里说明为何声明动作不够用。

---

## 6. 红线继承（R1 §6 逐条对应）

声明式化**不得削弱**任何一条既有守卫；以下逐条声明继承方式：

- **R1 禁 grouped 事务**：`set_grouped(false)`（:1598-1608）与本设计无交集，
  原样不动。执行器每条 action 独立执行，不引入跨 step 事务包裹。
- **R2 compat replay 冻结（20260801）**：`STARTUP_COMPAT_REPLAY_MAX_VERSION`
  不动。冻结之后的版本"必须显式处理"这条原则在新模型下的读法是：**必须显式
  写一条带版本号的 RepairStep**——比手写方法便宜，但同样显式、同样过评审。
- **R3 checksum fail-close**：`LEGACY_CHECKSUM_DRIFT_ALLOWLIST`（:140-154）与
  repair step 正交，不纳入模型，原样保留。
- **R4 禁整份回放 / 禁无条件重建表**：模型里**没有** `RebuildTable` 或
  `ReplayMigrationFile` 动作——不提供这个词汇表，就写不出这种 step。
  `notes_versions` 的 V20260214 守卫留在 Custom 内部。
- **R5 防长回填**：I-R3（DDL/DML 分离）+ `Backfill` 显式化。中期可给
  `Backfill` 追加行数上限或分批要求，此处不冻结具体机制，只冻结"回填必须
  显式可枚举"。
- **R6 中间表清理白名单**：`cleanup_intermediate_tables`（:3994-4001）是流水线
  步骤 0，不进注册表，白名单机制不动。
- **R7 禁预标记跳过回填**：I-R4（MarkRecorded 必须在动作序末尾）+ 既有三个
  锁定测试原样保留；`make_alter_columns_safe` 本体不在本设计范围内。
- **R8 备份 once-guard**：`STARTUP_CORE_BACKUP_GUARD`（:169）不动。
- **R9 降级点封闭**：I-R2 白名单枚举测试，使"唯二降级点"从散落事实变成
  单点断言。

---

## 7. 迁移路径（按阶段，不估日历时间）

每个阶段独立可合、独立可回退；阶段间无隐式依赖。

- **阶段 A（类型 + 执行器 + 两个试点）**：引入 `RepairStep` 类型族、每库
  注册表骨架、执行器；把 `pre_repair_vfs_v20260205` / `v20260209` 两个最简
  特例改写为 step；`pre_repair_vfs_schema` 改为"执行器跑注册表 + 剩余手写
  调用原序保留"的混合体。验收：两特例的既有测试零改动通过；新增 I-R1/I-R4
  枚举测试与顺序断言测试。
- **阶段 B（vfs 链收编）**：`v20260210`、`v20260204`（拆 DDL/Backfill 两条
  step，落 I-R2 白名单）、`ensure_change_log_table`、
  `ensure_vfs_deleted_at_core`、V20260201 三分支（声明化或 Custom 二选一）。
  验收：`pre_repair_vfs_schema` 函数体收敛为"调执行器"一行；R1 §2 表格里
  vfs 子链全部 step 可被枚举测试点名。
- **阶段 C（红线函数与其他库）**：`v20260824_note_props` 拆双 step 收编
  （测试 :5388、:5361-5373 原样通过为硬门）；`apply_vfs_init_missing_tables`
  以 Custom 挂表；chat/mistakes/llm_usage 逐库收编；可选：步骤 2 gap 修复
  （V20260714）改为消费 MigrationDef 的声明式 step（§4 中期项）。
- **阶段 D（缺口收敛，可选）**：用加法 step（EnsureIndex/EnsureView/
  EnsureTrigger）补 §1.5 的稀疏库重建缺口，使修复产物满足 V20260130 verifier
  契约。此项是独立产品决策，不阻塞 A–C。

---

## 8. 测试契约

- **行为不变性**：每个被收编特例的既有测试（含 :5388 / :5797 / :5858 /
  :5873 等）**零改动**通过——这是每个阶段的合入硬门。
- **结构性测试（新增）**：
  1. 注册表枚举：全部 step 守卫非空（I-R1）；
  2. 顺序断言：`vfs_init_missing_tables` < `ensure_change_log_table` <
     V20260201 组 < `v20260204` < … < `v20260824_note_props`（链尾）；
  3. 降级白名单：`WarnContinue` 集合精确等于白名单（I-R2）；
  4. 记账位置：MarkRecorded 均为末位动作（I-R4）；
  5. 新库空过：对无表空库跑全注册表，断言零 DDL/DML 执行。
- **fixture 复用**：既有迁移 fixture（如
  `tests/fixtures/migrations/seeds/v0944_anki_library` 及 manifest oracle，
  R1 §3）不因本设计变动；后续新增 step 沿用"seed + manifest oracle"模式。

---

## 9. 开放问题（实施前需决策，本文不冻结）

1. `RepairContext` 里是否需要携带 `refinery::Runner`（今日
   `pre_repair_vfs_v20260824_note_props` 签名收了 `runner` 参数）——倾向执行器
   统一持有，step 不感知。
2. V20260201 三分支拆 step 还是留 Custom（§5 已声明二选一，由实施者按可读性
   定夺）。
3. `Backfill` 的行数上限 / 分批机制是否随阶段 B 一并落地，还是先只做显式化
   （§6-R5）。
4. 步骤 2（`repair_recorded_migration_schema_gaps`）是否并入同一注册表，还是
   保持独立流水线位置只共享动作类型（§3.2 末段）。

---

## 附：本文红线自查

- 只写文档到 `/workspace/docs/dev/`；未改任何产品代码 / 迁移 SQL / fixture。
- 未编译、未测试、未 commit、未 push。
- 两个加法红线函数（`apply_vfs_init_missing_tables` /
  `pre_repair_vfs_v20260824_note_props`）语义在本设计中原样保留，收编方式为
  加法挂表（§5、§7 阶段 C）。
