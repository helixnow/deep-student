# 03 — VFS / 迁移 / coordinator / 数据治理 静态审计

- 审计枝:`cursor/0824-static-audit-cde6` @ `9f1aa668`(仅比基座多 docs 提交;产品代码与 `origin/cursor/0824-cde6` @ `2d41ea8b` 完全一致)。
- 方式:只读静态审计。仅用 `git log/show/diff/merge-base/cat-file`、代码阅读与只读静态门禁脚本 `node scripts/check-migrations.mjs`;未编译 Tauri,未执行任何备份/恢复/清库操作,未做任何 git 写操作。
- 范围:coordinator 预修复链的加法式叠加、`b2a85a69`↔`5f324e1f` 吸收关系、rel-vfs 整支 merge 禁令、change_log 缺表 backfill、`notes.props` 硬化、migration-lock、111 迁移基线、DataGovernanceDashboard 备份/恢复危险面。

## 1. coordinator 预修复链:`apply_vfs_init_missing_tables` 加法式保留 + `pre_repair_vfs_v20260824_note_props` 叠加 — PASS

`pre_repair_vfs_schema` 的调用顺序满足「先补表、再修 change_log、最后收敛 note_props」的约定,两个函数同时在位、互不覆盖:

- `src-tauri/src/data_governance/migration/coordinator.rs:2275-2281`:注释明确「必须先于 `ensure_change_log_table`,否则旧库只有 resources/notes 时回放 change_log 会报 `no such table: main.questions`」;`resources` 存在即调用 `apply_vfs_init_missing_tables`(行 2280)。
- 同文件 `2284-2289`:随后才执行 `ensure_change_log_table(conn, "vfs", V20260131 SQL, "resources")`。
- 同文件 `2329-2331`:预修复链末尾叠加 `pre_repair_vfs_v20260824_note_props`,注释说明该版本「超过通用 compat replay 的冻结边界(V20260801),必须显式处理 duplicate-column 中间态」。
- 函数定义:`apply_vfs_init_missing_tables` 在 `2383-2431`(只建缺失表、跳过 V20260214 已删的 `notes_versions`、`restore_note_props` 按已记录契约补列,行 2388-2392、2418-2422);`pre_repair_vfs_v20260824_note_props` 在 `2345-2376`(双向收敛:history 有列缺→补列;列有 history 缺→补记账;双缺不抢跑,行 2357-2373)。

**加法式核实**(Step 19 落 `5f324e1f`、Step 20 叠 `f702121b` 是否互相覆盖):

- `git show f702121b -- coordinator.rs` 对该文件 **+173/−0**,零删除行(实测 `rg '^\-[^\-]'` 无输出);`5f324e1f` 引入的 backfill 逻辑与其 `restore_note_props` 分支在 HEAD 树上逐行在位(行 2383-2431)。
- Step 20 记录佐证:`docs/0824-MERGE-PLAN.md:938-941`「coordinator.rs 为加法式合并……自动合并无 hunk 丢失」,与本次逐行核实一致。
- 同款模式的兄弟修复也在位:llm_usage 的 V20260824 `cache_write_tokens` 显式收敛(同文件 `3821-3843`,Step 19 `920dd665`),证明 0824 边界后的迁移一律走显式 pre-repair,而非放宽通用回放边界。

## 2. main `b2a85a69` 已被 `5f324e1f` 吸收(超集) — PASS

- 谱系:`git merge-base --is-ancestor 5f324e1f cursor/0824-cde6` 为真;`b2a85a69` **不在** 0824 历史中(仅在 `main` / `origin/main`)。即 main 修复未被整支合入,而是经 `origin/cursor/0824-rel-mainbackfill-cde6` 的 `3d3516c3` 端口为 `5f324e1f`(见 `docs/0824-MERGE-PLAN.md:861-868`)。
- 超集实证:两提交对 `coordinator.rs` 的补丁做加法行多重集合对比(`diff <(sort b2a85a69 加法行) <(sort 5f324e1f 加法行)`),**`b2a85a69` 独有加法行为 0**;`5f324e1f` 独有增量恰为 `NOTE_PROPS_ADDED: i32 = 20260824` / `restore_note_props` 恢复分支 + 新测试 `test_vfs_init_backfill_restores_recorded_note_props_contract`(HEAD 树 `coordinator.rs:2389,2392,2420-2422,5858-5880`)。stat 佐证:`b2a85a69` +226,`5f324e1f` +261,差值即上述 note_props 契约恢复。
- 结论:main 侧修复内容零丢失,且 0824 版本额外守住「重建的 notes 表必须保留已记录的 props 契约」。

## 3. rel-vfs 整支 merge `2bfe7c31` 禁令 — PASS(附局限)

- `git cat-file -e 2bfe7c31` 失败:该对象在本仓对象库中**不存在**,不可能已被合入任何本地分支。
- `git log --merges cursor/0824-cde6 --since=2026-08-24` 的 merge 提交清单(`2630dc95`/`25aecacc`/`79362482`/`362dd2df`/`0a0a1197`/`a8185664`/`0e32e0fe`/`a1ee2420`/`3efdc1b3`/`4adefd9d`)中无任何 rel-vfs merge。
- rel-vfs 内容仅以 3 个 cherry-pick 落地,提交 message 均带 `(cherry picked from commit …)` 追溯尾注:
  - `f702121b`(源 `b3ce56cd`,note_props release 升级加固,coordinator +173 加法);
  - `e7aa650e`(源 `028a2a62`,v0.9.44 迁移按版本序回放测试,coordinator +6/−2,即 `coordinator.rs:5233-5241` 的 `sort_unstable_by_key(version)`——Refinery 嵌入注册表原始切片不保证版本序);
  - `77ee8ecb`(源 `4759bd0c`,部分元数据保留与搜索分页,`note_repo.rs` + `search_helpers.rs`)。
- 与 `docs/0824-MERGE-PLAN.md:916-921,943-944` 的 Step 20 记录(「明确不 merge 该枝的 `2bfe7c31` merge commit」,SKIP 清单含 `2bfe7c31`)一致。
- 局限:本 clone 无 `origin/cursor/0824-rel-vfs-cde6` 远程引用,且审计约定禁止 fetch,无法对 rel-vfs tip 做「除已 pick 三提交外零残留」的反向 diff;此项以对象缺失 + merge 清单 + 端口尾注三重证据判定,不影响结论。

## 4. VFS change_log 缺表 backfill — PASS

`ensure_change_log_table`(`coordinator.rs:2523-2570`)覆盖两种缺表场景:

- 场景 1(行 2544-2556):V20260131 已记录但 `__change_log` 不存在(旧 `set_grouped(true)` 时代 DDL 回滚残留),重放幂等 SQL;
- 场景 2(行 2558-2567):核心表存在但 `__change_log` 缺失(旧库从未成功执行过 V20260131),直接补齐。

四库全部接入:vfs(行 2284,核心表 `resources`)、chat_v2(行 3266)、mistakes(行 3609 旧库 / 3617 新库,且行 3601-3605 同样先跑 `apply_mistakes_init_compat` 再修 change_log,顺序约束与 VFS 同构)、llm_usage(行 3829)。VFS 侧的关键防御(先 `apply_vfs_init_missing_tables` 补齐 questions/review_plans/folders 等触发器引用表,再回放 change_log SQL)见第 1 节行 2275-2281,这正是 v0.9.44→0824 升级报 `no such table: main.questions` 的根因修复。

## 5. `notes.props` 硬化 — PASS

- 迁移本体:`src-tauri/migrations/vfs/V20260824__note_props.sql:21` 仅 `ALTER TABLE notes ADD COLUMN props TEXT`(可空、无回填);行 19 携带机器可读 `@danger-ack: add_column_backfill` 注解,声明失败重跑由 coordinator duplicate-column 预修复兜底。
- 双向中间态收敛:`coordinator.rs:2345-2376`(见第 1 节);重建表契约恢复:`2418-2422`。
- 测试面(全部在 `coordinator.rs` 测试模块):
  - `test_v0944_vfs_upgrade_adds_nullable_note_props_without_touching_rows`(行 5318):真实 v0.9.44 库(V20260808 头,行 5229)升级后历史行 props 保持规范 NULL;
  - `test_v20260824_duplicate_column_rerun_is_repaired_and_preserves_props`(行 5346):ALTER 已提交、history 未写的中断重跑;
  - `test_v20260824_recorded_schema_gap_backfills_props_column`(行 5378):history 有、列缺的补列;
  - `test_vfs_init_backfill_restores_recorded_note_props_contract`(行 5858):notes 表整表重建后按已记录契约恢复 props 列。
- 读写路径硬化:`src-tauri/src/vfs/repos/note_repo.rs` —— `validate_note_props`(行 415,数量/键名/值类型逐项校验)、`normalize_note_props`(行 1884-1893,必须为 JSON 对象、键 trim、trim+小写查重)、空对象规范化为 SQL NULL(行 40 契约注释、2029-2032 `set_note_props` 文档);全部 SELECT 均带 `props` 列(行 875、908、1060、1154、1183、1261),NULL 容忍由 `Option` 承载。
- 锁面:migration-lock 已锁 `vfs/V20260824__note_props.sql`(见第 6 节)。

## 6. migration-lock — PASS

- 锁文件:`src-tauri/migrations/migration-lock.json`(schema 声明行 2-4,`generatedBy: node scripts/check-migrations.mjs --update`);末条即 vfs `20260824 note_props`,含 sha256 与空 dangers(行 940-947)——Step 20 经 rel-schema 端口 `caa86864`(源 `6dae7316`,+8 行)落锁。
- 门禁语义:`scripts/check-migrations.mjs:13-19` —— 已锁定条目被修改/删除/重命名即失败(「即使当前 manifest 已同步改掉」);新版本号低于该库已锁最大版本(乱序)即失败;**往 manifest 的 dangers 数组塞豁免无效**,base 之后新增/变更 SQL 只认文件内 `-- @danger-ack:` 注解(解析于行 127,未知规则拒绝于行 142);dangers 继承策略行 360-362(path+sha256 完全一致才 grandfather)。
- CI 接线:`.github/workflows/ci.yml:762-764`(PR 带 `--base-ref` 对比)、`.github/workflows/reusable-migration-gate.yml:79`、`.github/workflows/migration-nightly.yml:73`。

## 7. 111 迁移基线 — PASS

- 实测 `ls src-tauri/migrations/*/*.sql | wc -l` = **111**;
- 实测 `node scripts/check-migrations.mjs` exit 0,输出「✅ 迁移静态门禁通过(111 个迁移文件)」;
- 与 Step 20 / Step 21 收口记录一致(`docs/0824-MERGE-PLAN.md:963,1005` 均为「✅ exit 0(111 个迁移文件)」),基线未漂移;vfs 目录最新迁移即 `V20260824__note_props.sql`,无未落锁的散件。

## 8. DataGovernanceDashboard 备份/恢复危险面(只记录不执行) — 记录

本节仅登记危险操作面及其现有防线,**审计过程零执行**。文件:`src/features/settings/components/DataGovernanceDashboard.tsx`(1996 行)。

| 危险面 | 入口 | 现有防线(路径:行号) |
| --- | --- | --- |
| 全量清库 | `DataGovernanceApi.purgeAllData()`(行 163) | 独立 ConfirmDialog(行 556-558 `purge_confirm_*`) |
| 整槽恢复 | `restoreBackup`(行 1312-1366) | 非 full/不可恢复备份前置拒绝(行 1319-1328);磁盘空间预检不足即止(行 1333-1343);空间检查异常 **fail-close** 阻止恢复(行 1344-1351 注释:仅旧后端 CommandNotFound 走兼容,权限/I-O/清单损坏/目标卷不明一律阻断);进维护模式(行 1356);子组件确认层 `data-governance/BackupTab.tsx:1091` `confirm_restore` |
| ZIP 导入(E2EE) | `importZip`(行 1221,行 1264 三参 `importZip(zipPath, undefined, password)`) | 密码走 #177 E2EE API;portable/部分归档导入后**永不**提供整槽恢复入口(行 888-897 注释与 `isImportedArchiveSlotRestorable` 门) |
| 删除备份 | `deleteBackup`(行 1282-1285) | `BackupTab.tsx:1088` `confirm_delete` 确认层 |
| 后端整槽恢复 | `src-tauri/src/data_governance/commands_restore.rs` | 行 642-648:`DataSpaceManager` 不可用时在「磁盘预算、清槽和任何数据库写入之前」fail-closed(Step 19 `1df0ec6a` 前移);行 657-693 备份大小×2 预算 + 目标槽目录/卷解析逐项失败即 `job_ctx.fail`;恢复只写非活跃插槽、A/B 原子切换(行 640-643 注释) |
| Rust 英文拒绝文案 | 行 570-597 | `localize` 映射为 i18n(增量/部分归档/原子恢复不可用三类拒绝各有专键) |

契约测试在位:`tests/vitest/data-governance/` 下 10 个 DGD 测试文件(`restore-operations` / `backup-operations` / `backup-restore-ui` / `abg.source`(A tab aria + B E2EE + G 44px 三方共存契约)/ `debug-tab-visibility` 等)。本轮未运行前端测试套件,仅确认文件存在与断言对象仍在树上。

## 结论

| # | 审计项 | 判定 |
| --- | --- | --- |
| 1 | coordinator 加法式保留 `apply_vfs_init_missing_tables` + 叠加 `pre_repair_vfs_v20260824_note_props` | PASS |
| 2 | main `b2a85a69` 已被 `5f324e1f` 吸收(超集,零丢失) | PASS |
| 3 | rel-vfs merge `2bfe7c31` 未合入(对象缺失 + merge 清单 + 三 cherry-pick 尾注) | PASS |
| 4 | VFS change_log 缺表 backfill(两场景 × 四库,顺序约束在位) | PASS |
| 5 | `notes.props` 硬化(迁移/双向收敛/重建恢复/读写校验/4 组测试) | PASS |
| 6 | migration-lock(锁 V20260824、防篡改/防乱序/防 manifest 豁免注入,CI 三处接线) | PASS |
| 7 | 111 迁移基线(实测计数 + 门禁 exit 0,与 Step 20/21 记录一致) | PASS |
| 8 | DataGovernanceDashboard 备份/恢复危险面 | 已记录,防线齐备,未执行 |

**总判定:PASS。** 不需要产品修复。唯一局限(第 3 节:本 clone 无 rel-vfs 远程引用,无法反向 diff 残留)为审计环境约束,不构成产品风险。**本轮不改代码。**
