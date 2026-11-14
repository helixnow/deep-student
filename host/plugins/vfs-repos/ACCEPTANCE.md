# L11-vfs-repos 独立验收（R3-review-vfs，2026-11-04）

结论：不通过

**新增R11-07主线缺陷（2026-11-05）**：main3c9ec09a9 / 审计树35c2e6758，真实`vfs_set_indexing_config`可先写合法`chunk_size="+16"`，再错误接受`chunk_overlap="16"`；同样的size="16"则正确拒绝。本人`20261105060922-2be279`已复现并经真实get命令确认持久值。此为L12报告B12-16的独立确认，归L11单计一组；原R11-01–06不重开，当前L11未决1、总未决16，见§12。

**Linux续作基线（2026-11-05，main e9df01a3c）**：513aac879和9006bc168现均为main祖先；`index.ts:170-189`已直接注册F3维护参与者，排空失败resume后重抛、正常release恢复，原R11-05签收继续有效。generation owner采用safeIntegers、仅安全范围转number（`repository/sql-integers.ts:5-13`；`repository/index-segments.ts:64-86,175-182,201-215`），但L12消费者5aaf3bc8a尚未集成；跨lane R12-09不关闭。原R11未决仍0，不据此扩大为全域B通过。本轮运行结果统一见R3汇总的“Linux续作”节。

**R11-05正常main闭环（fd925aa05，2026-11-05）**：本人20261104163651-79f860真实parent StorageService＋生产worker断言脚本exit0，确认在途写/搜索完成、维护拒绝新借用/worker、release重建线程与真实WARN回传。main仍是条件注册，但实际F3满足条件并已执行；513aac879去探测提交尚未main，不混淆提交可见性。R11-05正式关闭，原R11编号未决为0；L11全域v2仍受跨lane R12-09精度等未决影响，不能据此宣称整lane等价通过，详见§11。

**R11-04主线证据闭环（bec9c35ba）**：审计提交7e4c9848f的标准自检作业20261104140723-05a526原始结果为77文件/656测试通过、exit0、无Errors/unhandled errors，其中L11完整目录32文件/257测试全部通过。R11-04正式关闭，不是用基线差分规则放行失败；当前主线仅R11-05未决（候选已过待main），详见§10。

**最新R11-05真实组合候选复核**：固定修复513aac879，执行后继e8d704d99；本人队列20261104132231-57006f为3通过/6过滤、exit0、无Errors。真实parent StorageService维护门禁＋生产worker已验证在途完成、新借用/worker拒绝、排空终线程、release重建及日志回传，R11-05候选通过待main；不沿用早期fake registry测试冒充。main ad11a8394尚未包含该候选，组级主线未决仍R11-04/05，详见§9。

**v2 main闭环更新**：已合并固定main `eeaf5bdc7ae95a336c34b3a75b19f844726fe064`（审计合并提交57b8270c6，仅审计文档与main不同）。R11-01真实F4+L11组合与R11-06两条对照已在该main代码上独立复验通过，现正式签收；未决剩R11-04/05，详见§8。下方早期分支/未集成叙述保留为历史，不代表本轮状态。

**最新 R11-06 定向复核**：代码/测试固定修复 `b169acd4c82e25481f77296af60396ec6151c65d`，执行树 `2942073d0c7a1556756aeef5b50b1b0763e85f6d` 中相同目标代码通过本人队列 `20261104074611-07ada5`：2通过/4过滤、exit0、无Errors。R11-06分支复核通过待集成；当前R11仅01/04/05共3组未决。竞争测试、全套RPC、身份/F3真实组合及vector消费者均未重测或据此签收，见§7。

**R13-01所有者交接补充**：消费者修复树dea54622f已改接真实L11八方法，本文§6的新提供方状态不能再误读为“尚无消费者”；具体路径/cache/AI事务复核见vfs-handlers ACCEPTANCE §8。L11 maintenance.ts:215-218新增`file_`→file_name，与Rust handlers.rs:1259-1303的`file_`→source_id不同，作为 **R13-01.path-file** 跨lane子项回到L11修复；cache vector磁盘阶段仍按R13-01保留。复核主表只计一次，不在R11再新建重复组，原R11-01/04/05/06结论不变。

**最新 L11 定向复核**：固定修复分支 `f470e5c89d0a144964afd11f302899226b27ab36`（含3d003c3cc的身份/并发/S04及36a41507d的Q8/worker）。队列作业 `20261104061643-368b45`：6文件44测试、exit0、无Errors汇总行。R11-02在分支复核通过待集成；R11-01只确认注入，身份入口仍有上游语义偏差；R11-04仅最小集复验，不以owner全套报告关闭。新增候选缺陷R11-05（worker维护/日志）、R11-06（S04库形状探测失败策略）。当前修复分支未决4组，详见§6；D1/D4撤销R11-03继续有效。

**D1/D4 定向复核（C2 05:14 指令）**：依据 main `e303957124ac220f55bee1b04cca5d3937983b92` 中已生效的 `d1b03dff9` 裁定，撤销 R11-03 原“连接参数本身违规”的判定，详见 §5。当前本页组级未决数为 **3**；R11-01/02/04 保留，不重跑 RPC 全套。

审读基线：`f23c9870282cc95907661df6dae3cdf6cb232fa1`。本目录原无 ACCEPTANCE。只读 Rust/实现/测试，未运行 Rust。下文 `R/` = `src-tauri/crates/dstu-vfs/src/vfs/`，`T/` = `host/plugins/vfs-repos/`，`H/` = `host/plugins/vfs-handlers/`。

## 必须修复

- [x] **R11-01（main复验通过）**：eeaf5bdc7 的 `index.ts:151-161` await正式dataSpaceDeviceId、无旧wrapper fallback；TranslationRepo持有一次解析结果。本人队列20261104110620-492b05使用真实F4 createPaths和真实L11插件，在env+primary+legacy共存、无env优先primary、仅legacy规范化迁移三场景，逐次断言translation.device_id及启动后env改变仍用同一身份，exit0。Rust对照 `R/repos/translation_repo.rs:65-70`、`src-tauri/crates/dstu-storage/src/data_space/device_id.rs:197-232`；非测试paths替身，详见§8。
- [x] **R11-02（修复分支复核通过，待集成）**：`f470e5c89` 的 `tests/resources.test.ts:78-103` 使用10个独立worker/连接，`tests/questions.test.ts:127-155` 使用2个worker；`tests/support/concurrency.ts:32-36,67-85` 在所有ready后Atomics统一起跑，worker直接执行同一生产ResourceRepo/QuestionRepo方法，原全部成功/同ID/hash/唯一isNew与OCC一胜一冲突断言保留。队列作业20261104061643-368b45已亲跑通过。Rust对照仍为 `R/repos/resource_repo.rs:1173-1240`、`R/repos/question_repo.rs:3818-3871`。不再按旧同步map结论派回；此测试修复不等于R13-02生产调度/维护保证通过。
- [x] **R11-03（按 D1/D4 撤销原判定，非声称代码新修复）**：所有者业务方法接受/传递 `SqlExecutor` 是允许的事务接缝，不能仅凭参数类型判违规，也不要求批量改名/重构。本次核对 main 的 vfsRepo API/提供者，未发现原证据所指路径向非所有者开放任意SQL执行或返回原始连接；消费者直接写别人表另按 R12-03 处理。裁定与具体证据见 §5。
- [x] **R11-04（main完整运行证据通过）**：20261104140723-05a526包含L11全目录32文件/257测试通过，联合命令exit0、无Errors/unhandled errors，已满足原完整运行证据要求。早期188通过但5/7个RPC超时的exit1保留为历史；本轮未修改断言或skip，详见§10。该验证阻塞关闭不代表R11-05或所有业务语义已通过。

新增候选必须修复项（承接本轮扩大范围，和首次4组区别编号）：

- [x] **R11-05（main真实组合复验通过）**：main fd925aa05包含F3 80dcc5291，现有index条件注册实际接入真实parent维护。本人20261104163651-79f860用真实写入/短worker搜索验证在途完成、准入拒绝、排空终线程/release恢复及WARN target/level/message，exit0，详见§11。513aac879直接注册清理提交仍非main祖先；本结论依据实际main消费者行为，不是假定该提交已合。旧反例保留，R13b线程消费仍独立未决。（Rust `R/database.rs:159-215,283-358`。）
- [x] **R11-06（main复验通过）**：原b169acd4c修复已进入eeaf5bdc7，main代码两条对照用例作业20261104105931-49fed5为2通过/4过滤、exit0，无Errors。仅pragma失败跳过，重算/清零仍分别VFS_STORAGE；原分支证据见§7，本轮主线闭环见§8，不再标待集成。

- [ ] **R11-07（配置跨字段i32读取不等价；同B12-16）**：`repository/embedding-repo.ts:150-170`读取已存overlap/minimum/size时使用`/^-?\d+$/`＋Number，拒绝Rust可解析的正号且没有i32范围检查；同文件`:85-91`直接写入校验却接受+号。Rust `embedding_repo.rs:959-964,980-994`要求`parse::<i32>().ok()`后才默认值。真实IPC已确认+16→overlap16错误接受并落库，详见§12。请L11恢复相同i32解析/默认规则，保留合法正号输入和跨字段校验顺序；不要在L12复制validator掩盖owner差异。

## 建议

- [ ] 同步 SPEC 的旧“pending”自述与 TESTMAP：`T/SPEC.md:39` 与 `:183`、`T/TESTMAP.md:12` 相互矛盾。
- [ ] 恢复成功/调试日志时保留原级别。例如 `R/repos/pomodoro_repo.rs:212,301` 的创建/删除 info 在 `T/repository/pomodoros.ts:223-292` 缺失；资源创建 debug/info 同见 `R/repos/resource_repo.rs:128,164` 与 `T/repository/resources.ts:161-180`。本次未把这些非 warn/error 项混入功能通过结论。

## 已核实通过

- [x] **复核确认**：`vfsRepo` 服务版本、声明、实例提供一致；notes 级联经对方 api，未见生产 console 或跨插件实现文件 import。（`T/index.ts:3-4,51-107,110-116`；对三个目录全部非 tests TS 的 import/console 扫描无命中。）
- [x] **复核确认**：blob 删除 journal 准备失败不删元数据/文件，prepared 崩溃可恢复，outbox 失败可见且可重放；测试确实通过生产仓储和真实 SQLite trigger 注入故障。（`T/tests/blobs.test.ts:102-159`；`R/repos/blob_repo.rs:1296-1396`。）
- [x] **复核确认**：翻译独占资源、历史共享写时复制、最后一个引用才 purge 的行为测试未弱化。（`T/tests/translations.test.ts:56-113`；`R/repos/translation_repo.rs:1259-1385`。）
- [x] **复核确认**：原测试去向 158 条全为 ported，无实际 obsolete/merged 行，因此本 lane 没有待批准的豁免；`migration/approvals.json` 不提供并发测试弱化批准。

## 1. 命令调用链抽查（15 条）

L11 自身 **0 条 IPC 命令**，`T/index.ts:111` 为 `commands: []`。不能虚报“抽查 15 条 L11 命令”；以下是 15 条真实 Rust `#[tauri::command]` 到 L11 仓储的消费链。通过仅表示列出的仓储行为与参数映射；L13b 的线程隔离和接线缺陷另记在其 ACCEPTANCE。

| 命令 | 结论及核对内容 | TS 证据 | Rust 证据（R/） |
|---|---|---|---|
| vfs_create_or_reuse | 通过：类型→UTF-8 大小校验；SHA256/INSERT OR IGNORE；ref_count=0、毫秒时间、isNew | `H/src/resources.ts:123-143`; `T/repository/resources.ts:154-181` | `handlers.rs:301-344`; `repos/resource_repo.rs:95-187` |
| vfs_get_resource | 通过：先校验 ID，缺行 null；可选字段省略 | `H/src/resources.ts:151-159`; `T/repository/resources.ts:97-117,208-213` | `handlers.rs:356-367`; `repos/resource_repo.rs:317-334` |
| vfs_resource_exists | 通过：非 res_ 直接 false；COUNT 判断 | `H/src/resources.ts:161-168`; `T/repository/resources.ts:222-225` | `handlers.rs:379-392`; `repos/resource_repo.rs:366-372` |
| vfs_increment_ref | 通过：更新后读取计数，缺行报错，IPC 返回 null | `H/src/resources.ts:170-179`; `T/repository/resources.ts:141-145,227-233` | `handlers.rs:405-418`; `repos/resource_repo.rs:386-404` |
| vfs_decrement_ref | 通过：MAX(0, count-1)，其余同上 | `H/src/resources.ts:181-190`; `T/repository/resources.ts:235-241` | `handlers.rs:431-444`; `repos/resource_repo.rs:414-432` |
| vfs_get_file | 通过：file_/tb_；读取不擅自排除已删除文件 | `H/src/files.ts:39-51`; `T/repository/files.ts:469-474` | `handlers.rs:2715-2726`; `repos/file_repo.rs:729-748` |
| vfs_list_files | 通过：100/0；type 分支；status=active，updated_at DESC，坏行 warn/跳过 | `H/src/files.ts:54-67`; `T/repository/files.ts:221-227,483-504` | `handlers.rs:2729-2744`; `repos/file_repo.rs:787-810,866-889` |
| vfs_get_file_content | 通过：blob 优先→inline→{content:null,found:false}；不改空串 | `H/src/files.ts:70-94`; `T/repository/resources.ts:208-213` | `handlers.rs:2783-2838` |
| vfs_delete_file | 问题：仓储软删/幂等/folder_items 顺序对齐，但消费方接成另一删除服务，见 R13-03 | `T/repository/files.ts:527-545`; `H/index.ts:329` | `handlers.rs:2751-2773`; `repos/file_repo.rs:967-1006,1755-1793` |
| pomodoro_create_record | 通过：work/completed 默认；同一 now；SAVEPOINT 内重算缓存；成功后事件 | `H/src/pomodoro.ts:44-64`; `T/repository/pomodoros.ts:95-106,168-187,223-260` | `todo_handlers.rs:1176-1201`; `repos/pomodoro_repo.rs:157-226` |
| pomodoro_delete_record | 通过：缺行 NotFound；SAVEPOINT 内软删和缓存重算；事件在返回后 | `H/src/pomodoro.ts:106-125`; `T/repository/pomodoros.ts:263-292` | `pomodoro_handlers.rs:24-44`; `repos/pomodoro_repo.rs:237-302` |
| pomodoro_today_stats | 通过：本地日界、work/completed/interrupted 口径；scalar 错误 error 后 0 | `H/src/pomodoro.ts:82-88`; `T/repository/pomodoros.ts:108-115,313-334` | `todo_handlers.rs:1229-1234`; `repos/pomodoro_repo.rs:396-458` |
| pomodoro_daily_stats | 通过所查分支：默认7、clamp 1–366、补零桶、坏时间 warn；DST 差异见下 | `H/src/pomodoro.ts:98-104`; `T/repository/pomodoros.ts:375-421` | `todo_handlers.rs:1248-1256`; `repos/pomodoro_repo.rs:505-574` |
| pomodoro_list_range | 通过正常日期/逆序区间分支：闭区间转半开、排除软删；日期解析未证明全域等价 | `H/src/pomodoro.ts:127-133`; `T/repository/pomodoros.ts:144-166,432-446` | `pomodoro_handlers.rs:49-58`; `repos/pomodoro_repo.rs:631-674` |
| pomodoro_streak | 通过：completed work，本地日集合；今天缺记录用昨天；坏时间 warn | `H/src/pomodoro.ts:135-141`; `T/repository/pomodoros.ts:448-486` | `pomodoro_handlers.rs:66-71`; `repos/pomodoro_repo.rs:683-747` |

## 2. ported 测试逐条复核（21 条）

表内 Rust 路径以 R/repos/ 为前缀，TS 路径以 T/tests/ 为前缀。均核对测试正文，不以同名或通过数代替真实性判断。

| 原测试 | Rust 文件:行 | TS 文件:行 | 结论/实际断言 |
|---|---|---|---|
| test_store_blob | `blob_repo.rs:1162` | `blobs.test.ts:34` | 通过：内容、大小、mime、ref=1、物理文件 |
| test_blob_dedup | `blob_repo.rs:1184` | `blobs.test.ts:47` | 通过：同 hash/ref=2 |
| test_blob_dedup_different_extension_no_orphan | `blob_repo.rs:1203` | `blobs.test.ts:56` | 通过：共用路径且磁盘仅一个文件 |
| test_get_blob_path | `blob_repo.rs:1231` | `blobs.test.ts:69` | 通过：根目录范围和存在性 |
| test_ref_count_operations | `blob_repo.rs:1247` | `blobs.test.ts:78` | 通过：1→2→1→0→0 |
| test_compute_hash | `blob_repo.rs:1273` | `blobs.test.ts:87` | 通过：相同/不同输入和64位 |
| test_blob_path_structure | `blob_repo.rs:1284` | `blobs.test.ts:96` | 通过：ab/hash.pdf |
| deletion_prepare_failure_keeps_blob_metadata_and_file | `blob_repo.rs:1296` | `blobs.test.ts:102` | 通过：真实 trigger 失败，文件/metadata 保留 |
| recovers_blob_crash_after_prepare | `blob_repo.rs:1319` | `blobs.test.ts:120` | 通过：恢复1条、文件删除、journal ready |
| blob_ready_outbox_failure_is_visible_and_recoverable | `blob_repo.rs:1349` | `blobs.test.ts:134` | 通过：prepared→重放→published |
| test_create_or_reuse_dedup | `resource_repo.rs:1005` | `resources.test.ts:31` | 通过：第二次复用同 ID/hash |
| test_get_resource | `resource_repo.rs:1041` | `resources.test.ts:41` | 通过：ID/hash/data |
| test_ref_count | `resource_repo.rs:1066` | `resources.test.ts:50` | 通过：含下限0 |
| test_list_by_type | `resource_repo.rs:1113` | `resources.test.ts:60` | 通过：全3条/note2条 |
| test_compute_hash | `resource_repo.rs:1159` | `resources.test.ts:69` | 通过：同值、异值、长度 |
| test_concurrent_create_same_hash | `resource_repo.rs:1173` | `resources.test.ts:78` | 问题 R11-02：串行替代竞争 |
| test_identical_content_translations_get_distinct_resources | `translation_repo.rs:1259` | `translations.test.ts:56` | 通过：内容相同仍不同资源 |
| test_update_translation_content_in_place_refreshes_hash_and_index_state | `translation_repo.rs:1273` | `translations.test.ts:62` | 通过：原资源 data/hash/pending |
| test_update_shared_resource_uses_copy_on_write | `translation_repo.rs:1308` | `translations.test.ts:76` | 通过：旧资源不变、新指针/内容 |
| test_purge_translation_keeps_shared_resource_until_last_reference | `translation_repo.rs:1350` | `translations.test.ts:98` | 通过：首删保留、末删回收 |
| concurrent_question_updates_allow_exactly_one_occ_winner | `question_repo.rs:3818` | `questions.test.ts:127` | 问题 R11-02：无 Barrier/并发 |

## 3. 亲自运行（原始输出摘要）

```text
$ npx vitest run -c vitest.host.config.ts host/plugins/vfs-repos
Test Files  23 passed (23)
     Tests  188 passed (188)
    Errors  5 errors
  Duration  151.35s
Error: [vitest-worker]: Timeout calling "onTaskUpdate"
REVIEW EXIT: vfs-repos 1

$ npx vitest run -c vitest.host.config.ts host/plugins/vfs-repos --maxWorkers=1
Test Files  23 passed (23)
     Tests  188 passed (188)
    Errors  7 errors
  Duration  206.81s
Error: [vitest-worker]: Timeout calling "onTaskUpdate"
Exited with code 1

$ node scripts/electron-migration/importable.mjs host/plugins/vfs-repos/index.ts
importable: ok
$ node scripts/electron-migration/wiring.mjs --lane vfs-repos
合计 ported 158，其中所测模块未从 index.ts 接入 0（0.0%）
```

更早一次运行因工具 120 秒时限中断，不计成完整结果。上述两次完整运行均不宣称“测试门禁通过”。测试临时目录来自 mkdtemp，不读取用户正式数据库。

## 4. 架构与语义差异分类

- **架构通过项**：生产跨插件 import 均经 api.ts，SQL 在 repository，命名与实际提供相符；测试替身仅在 tests 使用。原 R11-03 的连接参数判据已按 D1/D4 撤销（§5）；L12 对本 lane 所有表的重复写入另见 R12-03，修复主责为重复写入方。
- **应修差异**：R11-01（device_id）；R11-02 是证据缺陷而非据此断言 INSERT OR IGNORE/OCC 实现错误。
- **已登记平台差异，不能冒充已证明严格等价**：`T/SPEC.md:17,19,40,49,167` 记录大整数 number、附件 f32、时钟亚毫秒、本地日界、导图数字文本。`decisions.md:52-59` 批准平台时间精度差异；并未批准其余全部差异。此轮核实 `T/repository/files.ts:82-86` 存在 bigint→number，`T/repository/pomodoros.ts:159-166` 用 JS 午夜，Rust `R/repos/pomodoro_repo.rs:600-623` 有 1–3 小时探测。其余登记项未逐一扩展验证，不计入通过项。
- **测试真实性/运行结论**：样本中的19条行为断言通过审读，2条并发样本不等价；完整运行仍有 R11-04。B 级不成立。

## 5. D1/D4 裁定后的架构复核（2026-11-04）

政策/实现基线：main `e303957124ac220f55bee1b04cca5d3937983b92`；其中 `d1b03dff9` 的 `docs/dev/electron-migration/decisions.md` D1/D4 明确允许所有者发布连接绑定业务方法、消费者开启事务并仅传递句柄。质量规范 §10.3 保留禁止越权写表的要求。

- **复核确认允许的接缝**：`T/api.ts:32-50,472-526,873-897,1071-1095` 暴露路径缓存/导图/unit/resource业务方法，连接为输入，结果为业务值；`T/index.ts:28-50,51-105` 提供仓储对象，notes级联仅把同一连接传给 notes.repository。原 R11-03 没有任意SQL执行/原始连接返回的具体证据，不能继续作为B阻塞。
- **真实消费样例**：已读 L12 的 `src/unit-sync-service.ts:114-136,140-156`，在平台事务中仅调用 L11 状态/purge/计数方法，属于允许方向；这不要求把事务拆成多次独立提交。
- **仍违规的样例归 R12-03**：L12 `repository/index-state.ts:276-295`、`repository/embedding-dim.ts:502-551`、`repository/pdf.ts:59-65,86-131` 的直接写入与“传递句柄”不是一回事；不因D1/D4自动获得豁免。
- 本结论纠正的是原架构判据，不宣称所有消费者已审计无越权，也不要求重新实现本已允许的连接绑定API。R11-01（身份）、R11-02（竞争保证）、R11-04（运行验证）保持原未决状态；本次未重测这些项。

## 6. L11 新修复与候选接缝复核（2026-11-04，队列执行）

### 基线与证据范围

- 修复树：`f470e5c89d0a144964afd11f302899226b27ab36`；包含 `3d003c3cc`、`36a41507d` 及前置检查点实现。具名提交主要改文档，本次按完整树读取真代码。
- 本轮开始的main固定为 `15b23540a97ee19e1391859c3bc140e5c0daa182`；`git merge-base --is-ancestor f470e5c89 15b23540a` exit1。因此只认分支候选，不称main可消费。3d003c3cc→f470e5c89间，本轮身份/并发/S04的实现与测试文件无diff，使用同一固定树同时核worker。
- 提供方工作树运行前只有 `migration/LEDGER.md`、`migration/ledger.json` 修改（未碰）；`host contracts vitest.host.config.ts package.json` 与固定树无diff。所有命令从本审计工作目录发起，测试用绝对root/config与no-cache；未修改实现/测试/映射，未运行Rust。

### R11-01：依赖注入通过，完整身份语义未通过

`T/index.ts:115-140` 必需注入paths并在发布仓储前await deviceId；`repository/translations.ts:182-197` 构造参数必需、缓存到实例，所有突变统一用注入值（`:277-280,317-320,346-369,425-442,455-466,482-485`）。`tests/translations.test.ts:59-87` 经真实插件service验证创建、收藏、删除及folder_items的device_id/local_version，亲跑通过。旧“无env写NULL”本地替代已经移除。

但测试的paths是外部服务替身，**不证明身份解析算法**。固定树 `host/platform/paths/index.ts:347-368` 在env/primary之前读旧 `<base>/device_id` 并直接返回，来源为commands_sync包装入口；translation Rust `R/repos/translation_repo.rs:67-70` 调的是底层 `src-tauri/crates/dstu-storage/src/data_space/device_id.rs:197-232`：env优先，再primary→legacy。正常升级时旧root与env/primary并存即可读到不同身份。R11-01保留，依赖F4发布底层对应入口后L11改消费；**不要求L11复制F4算法**。index注释声称“exactly like get_device_id”不能作为通过证据。

### R11-02：真实竞争保证复核确认

- `tests/support/concurrency-worker.ts:23-31` 每worker独立SQLite连接，ready之后Atomics.wait；主线程直到所有ready才store/notify。资源模式`:33-44` 调生产ResourceRepo.createOrReuse；题目模式`:46-50` 调生产QuestionRepo.updateQuestion，不在测试重写SQL算法。
- 10-worker用例断言10个结果全部成功、同resourceId/hash、唯一isNew、库内一行；2-worker用例断言一个成功、一个QBANK_CONFLICT，最终内容为胜者。额外胜者持久断言没有替换/弱化Rust原断言。
- `index.ts:31-41` 仍将同一生产仓储类提供为vfsRepo；测试的独立线程只负责真实竞争驱动。成功后等待terminate（concurrency.ts:56-60），异常/超时也结束workers。
- 亲跑两例成功，R11-02分支通过，等待集成；不把它与生产vfsWorker的R11-05混为同一个保证。

### R11-04：模板隔离已确认，但全套证据仍区分来源

`tests/support/vfs-test-storage.ts:16-27` 一次迁移、dispose关闭模板；`:31-40` 每测试mkdtemp+cpSync后新storage，测试数据不共享。与首次每例迁移的差异是fixture建立成本，未删除断言。本轮6文件44例均exit0、无RPC/unhandled errors，确认该最小集干净。

**owner自报**：`3d003c3cc:BLOCKERS.md:96-102` 记录25文件207/exit0、`--pool=threads --maxWorkers=1`，日志路径`/tmp/opencode/l11-full-suite.log`。这不是本验收人全套复验；也不等于f470e5c89新增Q8/worker后的整目录通过。遵照指令不重复刷全套，R11-04维持“全套独立证据待补”，不再将旧RPC错误说成新版本已重现。

### S04：所有者事务接缝与精确echo

`T/api.ts:364-370` 的批次方法仅接收调用方SqlExecutor和表名，D1/D4允许；`repository/pomodoros.ts:30-77,379-427` 把UPDATE FROM、无事实清零、IS NOT幂等保护留在表所有者，不自行BEGIN/COMMIT。读取preLogMax用safeIntegers bigint，抑制只作用于 `id > preLogMax AND sync_version=0 AND table_name='todo_items'`，无Number转换；秒级sync_version对齐Rust。

`tests/sync-pomodoro-counts.test.ts:73-118,120-150,153-161` 经ctx.vfsRepo.pomodoros验证work/completed/未删/有关联口径，软删todo仍重算，NULL/漂移归零，不改updated_at/local_version，无关批次不变；**2^53+1**既有未同步log不误标、新todo回声抑制、第二次不增log。4例亲跑通过。Rust对照 `src-tauri/crates/dstu-sync/src/data_governance/sync/pomodoro_counts.rs:58-145,571-670`。

保留两层未闭合：一是R11-06的形状探测查询失败策略；二是固定树全host检索该方法仅定义/API/测试，没有sync apply生产调用。上述4例直接调用所有者方法，未验证L20的外层BEGIN IMMEDIATE、单条SAVEPOINT之后/提交之前位置及整体回滚；不能据此宣布S04应用链路已接通。重算/清零Error转换须由消费边界按SyncError契约核对。

### 新 Q8 与 vfsWorker：哪些已证明、哪些未证明

- **Q8仅确认发布和写表方向**：`api.ts:1179-1201` 及 `repository/questions.ts:396-472,502-575` 提供metadata/card/provenance/reparse/group、改判、reset业务方法，字段白名单/参数绑定，SQL写questions/answer_submissions等L11所有表，不接受任意SQL，不写L15 mastery/FSRS。`tests/question-owner-writes.test.ts:94-103` 的外层事务故障回滚断言确实调用真实所有者方法（本轮只读此测试，未另跑）。Rust改判 `src-tauri/crates/dstu-qbank/src/question_bank_service.rs:820-957` 的mastery/统计/事件仍要消费编排在同一事务内完成；reset日志在`:1782-1787`提交后，不要求提前搬进所有者方法。此处不签收整个Q8消费链。
- **worker线程子项通过**：`index.ts:122-140` 实际提供vfsWorker；`src/worker-service.ts:62-65,124-176` 用真Worker RPC，entry`:87-100` 调生产仓储；`tests/worker-service.test.ts:30-76` 的threadId不同、持久写、VFS_NOT_FOUND回传、pomodoro缓存、search与dispose拒绝4例已跑通过。
- **维护/日志仍不等价（R11-05）**：worker-entry直接new SqliteDatabase且每请求不取共享维护许可，主服务handles不可见该连接；entry未导入setRepositoryLogger，worker-service消息类型仅ready/response，没有日志转发，主线程setRepositoryLogger不跨线程生效。Rust维护先关闭准入、排空租约、checkpoint并释放旧连接后才允许替换（R/database.rs:283-358），不能只检查threadId。
- 固定树 `host/plugins/vfs-handlers` 无vfsWorker消费点；R13-02仍不关闭。D8只对明确审批的混合测试子义生效，本轮没改任何partialObsolete或无关TESTMAP映射。

### 作业结果（完整退出状态）

```text
job.mjs submit -- npx vitest run --root /home/dsdev/dev/ds-mig/L11-vfs-repos -c /home/dsdev/dev/ds-mig/L11-vfs-repos/vitest.host.config.ts host/plugins/vfs-repos/tests/resources.test.ts host/plugins/vfs-repos/tests/questions.test.ts host/plugins/vfs-repos/tests/translations.test.ts host/plugins/vfs-repos/tests/sync-pomodoro-counts.test.ts host/plugins/vfs-repos/tests/pomodoros.test.ts host/plugins/vfs-repos/tests/worker-service.test.ts --maxWorkers=1 --no-cache
job.mjs result 20261104061643-368b45 --tail 400
 Test Files  6 passed (6)
      Tests  44 passed (44)
   Start at  14:16:45
   Duration  20.20s
[作业 20261104061643-368b45] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104061643-368b45.log
```

原输出无Errors汇总行/无unhandled errors；分文件resources6、questions14、translations6、sync-pomodoro-counts4、pomodoros10、worker-service4。

补充生产service探针也走队列。第一次 `20261104062218-6ac31c` exit **1**，原因是审计脚本的 `node --input-type=module -e` 参数被Worker继承，报 `ERR_INPUT_TYPE_NOT_ALLOWED`；未得到业务结论，不归责产品缺陷。移除该探针参数后只补跑探针，不重跑44测试：

```text
job.mjs result 20261104062453-7c158d --tail 160
main_handle=Database vfs is in maintenance mode
worker_during_maintenance=[]
schema_probe_error=schema probe failure
[作业 20261104062453-7c158d] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104062453-7c158d.log
```

探针安装真实L11插件/临时迁移库：开启storage.enterMaintenance(['vfs'])后调用公开worker.listTodoLists；另在公开S04方法传入仅all查询抛错的执行器。观察脚本exit0表示取得上述反例，不是两项语义通过。恢复lease并dispose worker/storage、删除自身临时库；不接触正式数据。

**本轮状态**：R11-01部分修复；R11-02分支通过待集成；R11-03按裁定撤销；R11-04全套独立验证待补；新增候选R11-05/06待修。没有因并发测试通过而签收worker维护，也没有因注入通过而签收错误的身份解析入口。

## 7. R11-06 pragma 容错与业务错误传播复核（2026-11-04）

### 固定树及执行边界

- 修复来源：`b169acd4c82e25481f77296af60396ec6151c65d`，实际包含pomodoros.ts及2条回归测试；`dcb5bd406`、`918b252fd` 为后续报告，不以报告自述替代验收。
- 本人执行树：`2942073d0c7a1556756aeef5b50b1b0763e85f6d`；目标仓储、sync-pomodoro-counts测试、schema模板、storage、contracts与vitest配置相对b169acd4c无diff。后续index/paths测试支持和maintenance有独立变化，明确记录执行树，不冒称运行了b169完整树。
- main固定对照 `679fd3e4d3bdaff9d38188aab851704e952b9ac0`；两个修复/执行树的ancestor检查均exit1。仅分支修复通过、待集成。
- 运行前提供方有既存BLOCKERS、ledger生成改动和未跟踪`.lane.tsbuildinfo`，未碰这些文件；执行前后被测代码与固定执行树无diff，host中的差异仅BLOCKERS报告。未合并/覆盖实现、测试或TESTMAP。

### 原问题的两侧保证

1. **探测失败跳过**：`repository/pomodoros.ts:83-90` 的try/catch仅包围pragma查询及字段查找，失败返回false；公开方法`:387-394` 随后return。对应Rust `sync/mod.rs:8147-8159` prepare/query失败false，以及pomodoro_counts.rs:91-97缺形状跳过；原本不记warn的分支仍不新增日志。
2. **业务UPDATE错误继续传播**：重算`:403-407`、清零`:408-412` 的catch仍各自抛 `syncCountsDatabaseError`，`:92-96` 产生VFS_STORAGE及各自“重算/清零…失败: …”文案，未把整个方法包在吞错catch里。对照Rust pomodoro_counts.rs:115-117、130-132。
3. **测试确实调用生产服务**：`tests/sync-pomodoro-counts.test.ts:25-44` 安装真实L11插件并从 `ctx.vfsRepo.pomodoros` 取得仓储。`:72-95` Proxy只注入执行器查询/指定UPDATE故障，不重写重算或错误分类算法。`:190-197` 探测故障不throw且原计数7不变；`:199-216` 对重算/清零分别注入故障，断言VFS_STORAGE与对应步骤文案。若把UPDATE错误也吞掉，后者必失败。

### 本人最小队列结果

```text
job.mjs submit -- npx vitest run --root /home/dsdev/dev/ds-mig/L11-vfs-repos -c /home/dsdev/dev/ds-mig/L11-vfs-repos/vitest.host.config.ts host/plugins/vfs-repos/tests/sync-pomodoro-counts.test.ts -t "shape_probe_query_failure_is_treated_as_missing_column|recompute_and_zero_update_failures_still_propagate" --maxWorkers=1 --no-cache
job.mjs result 20261104074611-07ada5 --tail 180
 ✓ host/plugins/vfs-repos/tests/sync-pomodoro-counts.test.ts (6 tests | 4 skipped)
 Test Files  1 passed (1)
      Tests  2 passed | 4 skipped (6)
   Start at  15:46:14
   Duration  19.98s
[作业 20261104074611-07ada5] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104074611-07ada5.log
```

原输出无Errors汇总行/无unhandled errors。4条未执行为本轮`-t`过滤，未改skip/断言；没有重跑R11-02竞争集、L11全套或旧失败探针。

### 不随该通过推进的事项

- R11-01：b169树确有optional dataSpaceDeviceId→旧deviceId fallback；执行树2942073d0的index已改必需dataSpaceDeviceId且测试paths替身同步更新。**这里只记录观察到的后续代码事实**；本轮未装真实F4身份提供者验证冲突旧root/env/primary，不据测试替身或“优先调用”关闭完整身份语义。
- R11-05：维护注册/worker日志候选需要真实F3组合；本轮不跑最小registry替身10例，也不据接口存在签收维护排空/恢复。
- S04：该方法错误策略修复不证明sync apply已在正确事务位置接入，完整应用链路保留上轮限定。
- pre-vector callback/Q8：新增提供能力等待消费方真实invoke与事务/事件证据，R13-01/R13-02不随本次通过关闭。

**结论**：R11-06勾选分支通过待集成，R11-01/04/05仍未决；R11-02已过、R11-03撤销的结论不变，整个L11仍不通过。

## 8. v2 main身份与R11-06闭环（2026-11-04）

根据协调者e60e7a771集成通知，实际锁定更新的main **eeaf5bdc7**。审计工作树合并main后，host/contracts/src-tauri非审计文件无diff，未改实现或测试。质量依据standard-v2 §1/2；Rust仍仅静态审读。

### R11-01真实组合

本轮不是device-identity.test.ts的pathsServiceDouble：队列内Node脚本导入真实 `host/platform/paths/index.ts:createPaths`、真实 `vfs-repos/index.ts`，以临时迁移库和隔离env调用createTestHost；仓储从ctx.vfsRepo获得。三个场景：

1. env=`env id!`，同时存在primary-id与旧root文件：预期为 `device-` + SHA256(`env id!`)，不是legacy或primary；创建和收藏写入都断言该值。
2. 无env，primary与legacy并存：预期primary-id，旧root不能覆盖。
3. 仅旧root=`  ../legacy id \n`：预期trim后SHA256规范化ID，并断言主`.device_id`持久内容相同。

每场景在插件初始化后改env为不同ID，收藏更新仍断言原ID，覆盖Rust OnceLock对应的一次解析缓存。全程不调旧deviceId wrapper。对应真实F4 `index.ts:120-153,299-311,386-388` 与L11 `index.ts:137-140,151-171`；Rust底层入口优先级/规范化已读。创建/收藏实际SQL写入与前次folder_items同步列审读共同闭合原问题，非宣称所有F4文件故障全域已经验证。

```text
job.mjs result 20261104110620-492b05 --tail 80
env: real F4 paths + L11 translation write/cache PASS
primary: real F4 paths + L11 translation write/cache PASS
[dstu_storage::data_space::device_id] 设备 ID 已从旧路径 .../device_id 迁移到主路径 .../.device_id
legacy: real F4 paths + L11 translation write/cache PASS
[作业 20261104110620-492b05] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104110620-492b05.log
```

此脚本含node:assert/strict真实断言，异常置exit1；不是只打印观察。不是Vitest，无Errors汇总行/无未处理异常；完整脚本在job result命令字段中。

### R11-06正常main两条复验

```text
job.mjs result 20261104105931-49fed5 --tail 80
Test Files  1 passed (1)
     Tests  2 passed | 4 skipped (6)
  Duration  16.05s
[作业 20261104105931-49fed5] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104105931-49fed5.log
```

执行 `npx vitest run -c vitest.host.config.ts host/plugins/vfs-repos/tests/sync-pomodoro-counts.test.ts -t "shape_probe_query_failure_is_treated_as_missing_column|recompute_and_zero_update_failures_still_propagate" --maxWorkers=1 --no-cache`，经全局队列。无Errors汇总行/无RPC/unhandled errors，4条为过滤；不重复R11-02竞争全套。R11-04全套独立证据与R11-05真实维护组合未因此关闭。

## 9. R11-05真实F3 parent维护与worker日志（2026-11-04）

固定修复 **513aac8794303c77c320fe571440c63a1aa1fb56**；该提交只含index改动，真实维护测试在前序检查点。执行树 **e8d704d9969be452e97f4fd5dcc9831187cf3116** 包含后续folder worker方法，非将9例执行树冒称原8例快照。与513相比，F3 storage/维护注册和本次三条断言未变；worker新增folder分派未改变todo/search准入、排空或日志链。执行前后相关index/worker实现、worker-service.test.ts及storage无diff；未提交blobs.ts/范围外ledger不纳入证据。修复不是本轮main **ad11a83943de411a75c87364fd8893a174ce63f9** 祖先（exit1），仍为候选。

### 真实生产接线与时序

- L11 index直接调用`ctx.storage.registerMaintenanceParticipant('vfs-worker', {databases:['vfs'], enterMaintenance, exitMaintenance})`，删除本地契约镜像/可选能力探测；enter await worker.pauseAndDrain，失败自行resume，exit resume，卸载撤销注册。
- 实际F3 `service.ts:225-260`先标记维护拒绝新借用，再await参与者排空，之后才drain/checkpoint/close主句柄；成功lease release才恢复主句柄和参与者。worker request在首次await之前计入admissions，pause拒绝新任务、等待admissions/pending/oneShots清空后await terminate；搜索worker保留到exit事件才从oneShots移除。
- `tests/support/vfs-test-storage.ts`实际调用createStorageService，复制的是已迁移库模板；测试没有替换enterMaintenance或registerMaintenanceParticipant。paths/notes为外围测试替身，不是维护/worker业务主体。
- `worker-entry.ts`安装setRepositoryLogger，将error/warn/info/debug及格式化消息发回parent；worker-service在真实`dstu_vfs::repos` logger按原level调用。日志测试用真实exporter收集故障仓储消息；动态断言覆盖消息送达，四级转发映射为静态对应，未虚称逐级sink断言全部覆盖。

### 本人最小复验

```text
job.mjs submit -- npx vitest run --root /home/dsdev/dev/ds-mig/L11-vfs-repos -c /home/dsdev/dev/ds-mig/L11-vfs-repos/vitest.host.config.ts host/plugins/vfs-repos/tests/worker-service.test.ts -t "R11-05 storage maintenance|forwards worker repository|tracks short-lived search workers" --maxWorkers=1 --no-cache
job.mjs result 20261104132231-57006f --tail 110
Test Files  1 passed (1)
     Tests  3 passed | 6 skipped (9)
  Duration  18.63s
[作业 20261104132231-57006f] 退出码 0
```

无Errors/unhandled errors；6条为过滤。真实组合用例先取得旧threadId、提交todo请求后进入parent维护，确认已接请求完成、storage.database拒绝、worker新请求拒绝，finally release后重新读库/worker成功且threadId改变；另一用例覆盖短生命周期搜索排空，日志用例通过真实SQL表改名故障确认worker日志抵达parent。完整日志`/home/dsdev/.oc-jobs/done/20261104132231-57006f.log`。未重跑R11-01/06或R12-09 owner子链。

**结论**：原R11-05“生产维护不可见＋静默日志”候选缺口已闭合，待正常main复验后正式勾选；R11-04、R13b的线程消费/R13-02、folder级联下游所有权均独立保留。不把C2 Electron8例报告计作本人运行，也不扩大为所有超时/维护故障策略全域验证。

## 10. R11-04正常main完整运行证据闭环（2026-11-04）

固定main **bec9c35ba26d42a31c0b2f035a2f9c8e4ad5be96**，标准自检tip **7e4c9848fa2952504005ad060f59c234996e0bf2**，仅原授权审计文档相对main不同。lane-gate按变更目录自动执行三个插件全套，没有单独重刷R11：

```text
job.mjs result 20261104140723-05a526 --tail 20
Test Files  77 passed (77)
     Tests  656 passed (656)
  Duration  309.82s
[作业 20261104140723-05a526] npx vitest run -c vitest.host.config.ts host/plugins/vfs-handlers host/plugins/vfs-index host/plugins/vfs-repos
[作业 20261104140723-05a526] 退出码 0
```

逐文件原输出中L11为32文件/257测试，全部通过；完整日志`/home/dsdev/.oc-jobs/done/20261104140723-05a526.log`，无Errors/unhandled errors、无onTaskUpdate RPC错误。**原始测试exit0**，并非“仍失败但main基线相同”被门禁放行。typecheck20261104140723-0e02d6、boundaries20261104140723-b2d872（2540文件0violation/167suppressed）、importable20261104140723-841594均exit0，已获取result。

原R11-04仅是完整测试运行证据缺口，现正式关闭；不新增测试、不修改断言、不凭测试总数签收未审语义。主线未决仅R11-05，L11整体仍不通过。§9的真实维护组合候选通过待main状态保持，R11-01/06既有主线签收不重审。

## 11. R11-05实际main消费者维护/日志闭环（2026-11-05）

按C2新的F3正式main通知，先查可见性再执行。固定main **fd925aa052873b52137e8405f60071fb36910c3c**，包含 **80dcc5291c7c1bb43e7a938d6f737edbdede9454**；审计合并提交 **b0ae7f9dcaa4c3c0608622d1fed66621ec8cc353**。host/contracts/src-tauri相对该main仅审计文档不同，未编辑实现或测试。

**513aac879仍非main祖先**。但main `index.ts:175-193`已经有真实条件注册：F3提供registerMaintenanceParticipant时注册vfs-worker，enter await pauseAndDrain（失败resume），exit resume。与513相比，该注册回调和worker-service/worker-entry实现一致，差别是能力探测/本地契约镜像以及尚未合入的新增测试。因此本轮直接测试正常main条件分支是否实际生效，不把“F3接口存在”或“513候选测试绿”当成证据。

### 本人真实组合脚本

全局队列 **20261104163651-79f860** 使用真实createStorageService（经临时迁移库helper）、真实createPaths、真实notes/vfs-repos插件与生产vfsWorker，没有替换registry/准入/排空方法。脚本以node:assert/strict进行以下断言，任何未处理断言失败置exit1：

1. 取得旧workerThreadId后提交真实createTodoList写入及短生命周期exam搜索；随后调用同一parent storage.enterMaintenance(['vfs'])。
2. 从进入维护开始，storage.database('vfs')抛错、worker新请求拒绝paused；已接写入完成且返回真实条目，搜索完成为空数组；await维护成功后workerThreadId请求仍被拒绝。
3. finally释放lease后，worker可读取刚提交列表，主库回读同一标题；新threadId与旧不同（实际 **1→3**）。结合main pauseAndDrain空闲分支await worker.terminate，确认旧线程/独立SQLite连接在维护成功前结束，不只证明线程ID不同。
4. release后在真实临时库改名todo_lists，触发worker真实仓储失败；assert.rejects消费预期失败，真实Cordis exporter断言 **name=dstu_vfs::repos、type=warn、level=2** 且消息含sort_order lookup failed。该错误是注入故障的预期日志，不是unhandled异常。

```text
job.mjs result 20261104163651-79f860 --tail 80
输出摘要：mainMaintenance=PASS，searchDrain=PASS，blockedStorageAndWorker=PASS，beforeThread=1，afterThread=3
parentWarn：name=dstu_vfs::repos，type=warn，level=2；args含[VFS::TodoRepo] sort_order lookup failed与no such table: todo_lists
[作业 20261104163651-79f860] 退出码 0
```

已取原始result；完整Node脚本保留在其命令字段，日志`/home/dsdev/.oc-jobs/done/20261104163651-79f860.log`。不是Vitest，无Errors汇总行/无未处理异常；未重跑R11旧全套、身份/pragma或generation子链。§9的三条候选证据继续作为历史，不替代本次主线断言。

**结论**：R11-05原“维护不可见＋线程内静默logger”问题在main闭合，原R11六编号中已修项通过、R11-03撤销，原组级未决0。513直接注册清理未集成的事实仍保留为交付状态，不将其本身另造功能阻塞。L11全域v2/跨lane **R12-09**、L13b **R13-02** 消费线程保证等未据此关闭，故本页整体仍不通过；相同缺陷跨lane只计一次。已向C2发送本轮精确main/job与判据。

## 12. R11-07：合法正号配置在跨字段读取时被错误默认

来源为L12 B12-16静态报告；本轮没有采信自述定性，而在固定主线代码（main3c9ec09a9、执行树35c2e6758）独立运行真实F3/paths/settings、notes/repos/index/vfs/media/handlers插件，所有配置均通过kernel命令写入及读回，没有直接SQL种入非法值。

先设置min_chunk_size=1、chunk_overlap=0，排除默认最小值影响。`vfs_set_indexing_config(chunk_size,"16")`成功；随后的overlap="16"正确返回Rust拒绝文案。再通过同一命令写合法"+16"，随后的overlap="16"却成功并持久化，证明不能仅用直接输入parseInt32正确来推断跨字段读取正确。

```text
job 20261105060922-2be279:
plain size=16 overlap=16 rejected: Invalid argument 'chunking.chunk_overlap': Must be non-negative and less than chunking.chunk_size (16)
signed size=+16 overlap=16 accepted: {"ok":true,"value":null}
persisted through real command: +16 16
B12-16/R11-07 confirmed mismatch; exit0 means observation succeeded, not parity
退出码 0
```

脚本含node:assert/strict，日志/完整命令`/home/dsdev/.oc-jobs/done/20261105060922-2be279.log`；无未处理异常。exit0表示反例与正对照按预期观察到，**不是等价通过**；未运行Rust。

调用链：`vfs-handlers/index.ts:575-576`→`src/embedding.ts:571-577`原样交L11 `indexingConfig.setConfig`；L11 `embedding-repo.ts:515-519`先validate再写入。入参`:85-91`允许正号，已存值`:150-170`却只接受可选负号。Rust `embedding_repo.rs:954-997,1044-1054`在输入和已存字段都遵守i32语法，+16应当读取为16，所以两个写法必须得到同一拒绝结果；不存在获批平台差异。

同组静态范围包括overlap/minimum/size三处读取的i32范围/default规则；本轮动态只证明合法+16这一真实可达反例，不冒称超界持久数据或所有字段已测试。归L11修复并补真实入口正号/普通数对照回归，不应恢复L12已删除的测试副本或拒绝Rust允许的+号。与B12-16同源单计一次，新增R11-07使当前L11未决1，总数从15增至16；既有R11-01–06签收不变。
