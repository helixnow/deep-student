# L20b-sync-support 行为规格

## S03 不可变事件 JSON 边界（补充回归）

Rust `tombstone.rs:75-92` 定义 seq:u64、size:Option<u64>；`:310` 发布后回验和
`:435-436` 下载按 TombstoneEvent 反序列化，不把 u64 先转 f64。
TS `src/tombstone-events.ts` 两处读取使用 L20 `sync/api.ts` 的 parseJsonLossless，
随后沿用 parseTombstoneEvent；serializeEvent 继续精确输出，hash/事件路径/回验策略不变。
新 `tests/event-json-precision.test.ts` 从已安装服务走下载/真实state预留后发布/回验/重试，
覆盖2^53+1的seq及另一奇数大size；修前有效输入2fail（`20261104200941-f251ff`），修后2pass
（Node `20261104201022-5d0c16`、Electron `20261104201130-f450c8`）。
只针对事件，不改变公开通用manifest helper的运行时契约。

## S01/S04 生产消费链更新（main `677f6727c`）

L20 默认 `createNoteHistoryHooks` 已收敛为 syncSupport.noteHistory reader 与 L10 owner writer，
而不是旧笔记写 SQL 副本；本 lane 不再把“hooks 函数名仍在”当阻塞依据。
`tests/note-history-apply.test.ts` 通过真实迁移的两库和已安装 sync/notes/vfsRepo/support，
覆盖 Rust `note_history.rs:417-731` 五条测试全部断言：

| Rust 范围 | 真实入口与分支 |
|---|---|
| :417-468 | notes.createNote → pending/enrich → target apply → 单 resource Update；前后完整快照 |
| :471-534 | 依赖剔除发送方 CAS → apply/replay/换绑/replay；目标 notes_relation_get 验证引用 |
| :537-580 | pin/unpin/Delete 三次真实 apply；pin 保留 |
| :583-677 | 未来格式/能力在 batch 入口拒绝且空库不落数据；两轮乱序传输；restoreCopy |
| :680-731 | 不可变历史冲突被隔离（failure_count=1）→合法重试（0）→Delete 不清 pin→未来历史拒绝 |

只观察真实 reader/writer 的同 tx spy 不提供替身实现，不替换默认 hooks。
原函数级用例全部保留。Node 作业 `20261104160636-53cfb7` 5/5、exit 0；详细原断言对照见 TESTMAP。
该证据不替代 R4 独立签收，S06 的原生 busy 通知依赖继续 pending。

## 集成门禁反馈修复：L10 精度已进 main，测试宿主适配新身份入口

已合并正式 main（含 `32e423cb2` / `3cb9e7770`），不再把L10精度修复记为候选待集成。
新版真实vfs-repos初始化调用F4 `paths.dataSpaceDeviceId()`，本lane测试宿主只提供deviceId，
导致生产方法执行前大量用例报TypeError。仅在测试provide中补已公开的dataSpaceDeviceId，
固定测试身份与既有deviceId一致；不改生产身份逻辑，也不替换notes/vfsRepo被测实现。

原S03 JSON文本/不可变history/CAS两个文件及state文件，队列作业
`20261104105720-b564e3` 已13/13通过、exit0、无Errors/Unhandled Errors。未删除、跳过、
反转断言或把bigint转Number。R4复核签收仍由验收人负责，不能由此宣称整lane B。
F3 SqlPhase/StorageError.phase仍不在main；S05的两个原prepare文案反例保持，S06 busy缺口不变。

## C2 owner 精度候选交接更新（历史）

L10 `3cb9e7770`（实现 `32e423cb2`）已提交 revision/history safeIntegers 与 L20 无损
JSON比较/写入，已只读核对diff；当前main仍未集成，以下真实owner三失败是当前main证据，
不能再表述为提供方未实现。候选集成后只跑 integer-precision / json-text-precision 两文件，
保留 bigint 与不可变冲突原断言，不以Number转换迁就返回。F3 phase同样待集成；busy能力仍缺。
本轮不重跑未变基线、不修改验收勾选、不私自替换L20 hooks。

## C2 07:07 S03 公开 parser 确认

`1aacd0184` 已从 main 的 sync/api.ts 接入共享 parseJsonLossless / JsonFloat / 精确比较
与序列化，不再等待候选接口。本 lane 原两处 JSON.parse 中：canonicalize 已替换为共享parser；
历史字段比较副本已删除并委托真实 notes.sync（owner仍有损精度反例，未宣称S03全通过）。
补齐 source-access 能力错误传播：只对 SyntaxError 按 Rust 回退原文本；共享parser在缺数字
source时抛出的能力错误必须传播，不能回退成字符串绕过精确比较。新增公开service回归只模拟
平台reviver缺source参数，仍用原生JSON解析器和真实共享parser/hash，不改被测业务算法。

## C2 06:38 S04 / W18 所有者接线（当前）

随后合并 `7625998df` 已带入 L20 api.ts:26 的共享无损 JSON。`src/json.ts` 现直接
重导出 L20 JsonFloat/DbJson/clone/equality/stringify，canonicalize 使用公开 parseJsonLossless；
删除本地普通 JSON.parse 后 normalize 的路径。内部载荷保留 JsonFloat.source，不在服务边界
转 number。三条 conflicts JSON 文本反例已通过；第四条 applyRevision 文本反例在真实 L10
owner 仍失败，和真实 owner CAS/INTEGER 历史两条一起保留。S03 不整体勾选。
（此句已过时：owner 侧现已修复，三条反例均通过，见本节下文“S03 说明更新”。）

合并 main `9c13dfc39`（本分支合并提交 `0f65a19b6`）后，L10 notes.sync / format.blocks
和 L11 batch 重算接口已可用，不再记为提供方发布/集成阻塞。

- `index.ts` inject storage/notes/vfsRepo；`createSyncSupport` 将真实
  ctx.vfsRepo.pomodoros 传给计数适配器。
- noteHistory.prepareRelation / retargetNoteRelations / applyRevision 直接调用 L10
  notes.sync 同名方法；remote_sync 快照前调用 updateInferredFormat；snapshot/setPinned
  继续调用 L10 revisions。所有调用传原 SqlExecutor，不另开事务。
- 删除本 lane 的关系 CAS/locator 业务副本、关系换绑/块失效/历史写入/pin/格式更新 SQL，
  `repository/note-history.ts` 只保留依赖枚举 SELECT；删除本地不可变 JSON 字段比较副本。
- 删除 `repository/pomodoro.ts`；recomputeIfRelevant 在相关表批次上仅调用一次
  recomputeCompletedPomodorosForSyncBatch(db, tables)。不按每条变更重算，不使用 worker
  或独立连接绕开 apply 事务。所有者原错误文案只加一次 SyncError Database 前缀。
- `service-host.ts` 安装真实 notes/vfs-repos/sync-support 三插件，notes 测试替身已删除；
  `note-fixtures.ts` 仅建 SQLite 夹具，不包含 format/revisions/repository 的测试实现。
  原 note_history 函数级测试接真 notes（完整 L20 apply 测试仍 pending）。
- S04 新增真实所有者事务回归：SAVEPOINT 之后重算一次、后续抛错回滚 history/关系/todo；
  inferred format + snapshot 同事务回滚；真实 trigger 错误保留单层 Database error 前缀。
  spy 仅记录原方法调用与执行器身份，未替换 owner 实现。
- **S03 说明更新（2026-11-07 W08 在集成基线 `68d37526` 上核实）**：原记录的缺陷（L10 owner
  CAS 读取无 safeIntegers，2^53+1 历史重放误报不可变冲突、props_json 大整数改变被接受）已修：
  `notes/repository/sync.ts:22,26` 的 `notes.sync.revisionRow` / `notes.sync.relationRevision`
  均以 `safeIntegers: true` 读取。W10 在 owner 测试 `notes/tests/note-sync.test.ts:289`
  （`706d6329`，“apply_revision compares INTEGER history columns beyond 2^53 exactly (S03)”）补了回归。
  本 lane 的 S03 回归 `integer-precision`（6）、`json-text-precision`（5）、`event-json-precision`（2）
  共 13 条全部通过，其中包括原先在 owner 上失败的“the real notes owner compares immutable INTEGER
  history fields without rounding”和“applyRevision rejects a changed immutable JSON integer before
  upgrading the pin”。临时去掉上述两处 safeIntegers 后，W10 的 1 条与本 lane 的 2 条随即变红
  （核实后已还原，未提交）。另：集成基线上这 13 条曾在断言之前就全部失败，原因是
  `tests/service-host.ts` 的 storage 门面缺 `registerFinalizer` / `finalizerNames`（notes
  `730a81df` 起在 apply 时登记启动 finalizer），W08 已改为转发真实 F3 服务，未改任何断言。
  本 lane 原 CAS/JSON 断言与本地 history INTEGER 重放反例保留不变；验收勾选不在此改动，仍以
  ACCEPTANCE / REPORT 为准。
- 本 lane 三条 conflict JSON 文本反例已通过共享 L20 parser 修复。两条 F3 prepare
  反例未变，本轮不重跑；S02/S06 状态不变。S04 表写入归属的自有修改已做，但不凭此
  宣布 owner 精度、L20 完整 apply 和 B 级验收闭合。最新作业结果见 REPORT。
- L20 engine 公共 API 已随此次 merge 进入 main，不能再记为“未集成 API”。当前
  sync/index.ts:77 仍通过自身 createNoteHistoryHooks 接入其 repository/note-history.ts，
  不是调用 syncSupport.noteHistory；该副本仍有直接写 notes/relations 的 SQL 和行级 marker。
  S01/S04 的这个生产调用点交 L20 删除副本并接本服务，不通过测试替换 hooks 冒充生产接线。
- **S02 本轮恢复完整移植**：逐读 pomodoro_counts.rs:151-563，以真实 L20 公开
  applyDownloadedChanges 替换六条 recompute-only 调用；双库2+3收敛、pending字段合并下
  tombstone重放、重复批次事实行数、换绑双todo、远端Delete、success/failure=1/1检疫
  断言均恢复。F3真实SQLite，L11实际batch owner。Node作业20261104071723-1c314f
  9/9、exit0；TESTMAP六条恢复ported（当前34/6），不自行勾R4验收。

## C2 06:08 公开接口交接与适配准备（历史快照）

已合并 main（当前基线含 `15b23540a`），并读取提供方分支的实际公开契约。
以下三项均是**已在提供方分支发布、待集成到 main**，旧节中的“提供方未导出”已过时：

| 接缝 | 已发布证据 | 本 lane 接法 |
|---|---|---|
| L20 无损 JSON | `ds-mig/L20-sync` api.ts:26；该文件最近提交 `90bd48d00`。导出 DbJson、JsonFloat/isJsonFloat/isJsonObject、parseJsonLossless、stringifyJsonLossless、dbJsonEquals、cloneDbJson。 | main 到位后从 api.ts 导入，删除本地 JsonFloat/clone/equality/stringify 副本并用原名重导出共享函数。canonicalize 的文本分支调用 parseJsonLossless；jsonFieldEquals 对 JSON 文本解析失败按 Rust 传播 Database error，不再原字符串回退。不能把共享 JsonFloat.source 丢掉再由 value 重建；内部载荷保留精确数值，IPC 转换只在 F1。四条真实反例保留，未重跑。 |
| F3 SQL phase | `ds-mig/F3-storage` 的 bf8f7b439/edac96ed7；api.ts:436-459 与 L20B-OBSERVABILITY.md。 | 已将 cursors/deviceRotations 从 all 改成 iterate（repository/state.ts::stateRows）。只读 StorageError.phase：prepare→读取，bind/产行前 execute→查询，产行后 execute→遍历（设备历史为解析）；字段解码仍保留专门前缀。当前 main 的旧错误没有 phase，因此两个 prepare 反例仍失败，不能签成已闭合。 |
| L11 同事务计数 | `ds-mig/L11-vfs-repos` api.ts 的 PomodoroRepository.recomputeCompletedPomodorosForSyncBatch(conn, changedTables)；api 文件最近提交 `3301923c5`。`3d003c3cc` 是 D1/D4 说明提交。 | 接入 ctx.vfsRepo.pomodoros；recomputeIfRelevant 传同一 SqlExecutor 与本批 table_name，一次调用；recompute 以相关表触发全量同一方法。所有者 VfsRepositoryError.message 已带“重算/清零…失败”，只加一次 SyncError Database 前缀，不重复上下文。到位后删除本 lane repository/pomodoro.ts 的 todo 写 SQL，全量重算只在 SAVEPOINT 后/COMMIT 前一次，不重开事务。 |

- D7：多库 apply 归 L20，其公开 Promise `applyDownloadedChangesToDatabases` 已在分支
  api.ts:108；不是本 lane 需要另写的管线。notes/关系/历史的所有者原子 API 仍按 L10 交接。
- S05 新增真实 SQLite VIEW 反例：首行 abs(i64::MIN) 溢出→查询；UNION ALL 首行正常、
  次行溢出→遍历；验证不靠错误文案分类。先运行失败，iterate 适配后通过。
- S06 busy handler 仍是独立缺口，F3 phase 不等于原生争用通知；不更改 pending。
- 重任务全部经全局 job.mjs；最小相关集作业与退出码见 REPORT。不使用分支私有导入，
  不把共享接口未集成时的旧实现通过说成新 provider 已接真。

## C2 / R4 §5 续修：JSON 文本整数与查询准备阶段

已读取 `ds-mig/R4-review-sync:ACCEPTANCE.md` §5（协调者引用 `d1e7d0938`），
不修改验收勾选。S03 仅 SQLite/直接 bigint 部分已修，JSON 文本精度**尚未修复**。
（历史记录，已过时：JSON 文本精度现已修复，见“C2 06:38”节的“S03 说明更新”。）

- `tests/json-text-precision.test.ts` 新增四条通过安装后 syncSupport + 真实 F3 的回归：
  computeDataHash 不同、resolveOne 返回真实冲突并传递原快照、saveConflictRecord 两条不同内容
  均写入（真正重复才去重）、applyRevision 拒绝同版本 props_json 改变且不得升级 pin。
  还验证 JSON 空白差异仍等价，不能用原始字符串比较替代解析。现四条均失败，未跳过/反转断言。
- S03 所需共享契约：L20 从 `api.ts` 导出 `parseJsonLossless(text: string): DbJson`（及对应类型），
  或由 F4 发布同等入口。当前 main 与 `ds-mig/L20-sync` 的 api.ts 均无该符号。
  候选仅在 `sync/src/json.ts:88`，按 C2 指令不私导入、不复制解析器、不字符串替换数字。
  发布后替换本 lane `canonicalizeForCompare/jsonFieldEquals` 两处普通 JSON.parse，
  保持前者解析失败回退原字符串、后者按 Rust `note_history.rs:222-235` 传播解析错误。
- `tests/state-errors.test.ts` 新增两个真实 DROP TABLE 反例：cursors 与 deviceRotations 的
  prepare 失败应分别为“读取消费游标失败”“读取设备轮换历史失败”；现仍误为“查询”，均失败。
  其余 9 个已有错误阶段回归通过。F3 `SqlExecutor` 仍无 prepare/bind/step 元数据，
  不把统一 catch 改为另一个统一前缀来掩盖阶段差异。
- S02/S06 保持 pending；S01/S04 未闭。上述新增回归为未修缺陷证据，不能算新增 ported。
  异步 codec 已在 `78b0aa1f4` 实现并由 `5480c3ceb` 发布104测试报告，不受本次续修替代。

## C2 异步 PayloadCodec 接入

实现与回归已保存于 `78b0aa1f4`；Node/Electron 各 104 测试通过，类型检查与原生导入通过。

- [x] `PayloadCodec.encode/decode` 接受 Uint8Array 或 Promise<Uint8Array>；增补
  SyncPayloadCodec / AsyncPayloadCodec，plainCodec 明确保留同步类型。
- [x] blob/asset/workspace 的 upload、download、downloadAfter、downloadForDevice
  全部接受上述 codec。同步 decodeTombstoneFile 的返回/抛错行为保留，新增 async 重载。
  不复制 F4 加密算法，调用方直接传入使用 F4 FileCipherSession 的 codec（与 L20 已发布类型兼容）。
- [x] Rust `tombstone.rs:302-350`：已有事件 GET→await decode→内容校验；不存在时
  await encode→PUT→GET→await decode→内容校验。codec 错误原样传播，不误包成网络错误。
- [x] Rust `:421-464`：事件下载解密完成后才解析、校验、排序；失败整批返回错误。
- [x] Rust `:767-790`：同步 throw / Promise rejection 均映射清单无法解密文案；
  解密完成后的 UTF-8/JSON 错误仍为清单损坏，未推进水位。
- [x] Rust `:1401-1504`：所有事件发布和回验完成后才编码每设备清单；编码完成后 PUT；
  `:597-617` 按上传的密文字节回读比较，成功后才 `:619-646` 尽力清理 legacy。
- [x] `tests/async-codec.test.ts` 经插件公开服务，真实 F4 Promise DSBK 会话验证三类
  完整读写、legacy 两种读路径、after 水位、幂等重试、事件/清单编码拒绝、事件解密拒绝、
  回读不一致、错密码、JSON 损坏分类与同步调用兼容。没有用 plainCodec 替代加密路径。

## 验收问题处理（R4，2026-11-04）

### C2 04:25 阻塞更正

已通过 `git show ds-mig/L20-sync:host/plugins/sync/api.ts` 核实：L20 分支已发布
`applyDownloadedChanges/getPendingChanges/enrichChangesWithData` 等引擎接口，协调者确认其
index 已消费 syncSupport。下表 S01/S02 及历史章节的“L20 未发布”改为“尚未合入 main 的
集成阻塞”；11 条完整 apply 集成测试仍 pending，待真实服务进入当前基线后补齐原断言。
S04 的表所有者接口、S05/S06 的 F3 能力继续由协调者交接，不自行勾选验收。

依据 `ds-mig/R4-review-sync:host/plugins/sync-support/ACCEPTANCE.md`；未改验收文件，
以下是修复方记录，不替代 R4 复核勾选。首次合并 main：`ac42c3f07`。

| 编号 | 处理方式 / 证据 | 提交或阻塞 |
|---|---|---|
| S01 | notes.sync/format.blocks 已在 main 并接真；5 条 note_history 完整集成保持 pending。 | L20 引擎 API/state 消费已在 main；note-history hooks 仍走 L20 平行副本，待其接本服务。 |
| S02 | 曾退回pending并删除自写apply；本轮L20进入main后已接真实apply服务并恢复六条原集成断言，映射恢复ported。 | Node作业20261104071723-1c314f 9/9 exit0；真实生产接线与F3数据库，等待R4复核，未修改ACCEPTANCE。 |
| S03 | state 六个整数 SELECT、记录读取（含 questions 兼容分支）、CAS、change_log max 使用 safeIntegers。CAS 用 bigint checked_add 到 i64::MAX，echo 比较不转 Number。内部服务 JsonValue/SyncChangeWithData.data 增补 bigint，toWireJson 不再降精度，JSON 列写入用现有 stringifyJson。回归经插件入口与真实 F3 SqliteDatabase，覆盖 2^53+1、i64::MAX、单调性/饱和、CAS 溢出、历史依赖、冲突比较/快照/落库和旧 echo 不被误标。 | 测试起点 `9084fc63e`；读写修复 `e5e55daa5`；API 增补 `5ab819dc1`。L20 消费前须增补自己的 JsonValue 与无损 JSON 编码，不能 Number(bigint)。 |
| S04 | 已删除本 lane notes/todo 写 SQL 副本，改为 L10 notes.sync / L11 batch 重算并传同一 SqlExecutor；真实所有者回滚与一次重算回归。 | 自有接线已实施（详见当前节）；owner 精度缺陷仍交 L10，L20 平行副本及完整 apply 接真由其负责，不能据此勾整体验收。 |
| S05 | 已区分三种事务的 BEGIN 与 COMMIT 失败，语句保留各自上下文；F3 仍负责同一事务与回滚。真实 deferred FK 失败测试验证三条 COMMIT 文案、写入全部回滚、随后重试成功；嵌套事务验证 BEGIN。补齐 cursors 的 device/seq 列错误与设备历史 row 解析错误（rusqlite 0.40.1 error.rs::InvalidColumnType）。 | 事务修复 `21dd2e62a`；列错误修复 `5ab819dc1`。**部分阻塞**：F3 SqlExecutor 只有 get/all/iterate 的合并接口，无 prepare/bind/step 阶段元数据；当前 all 仍不能区分“读取/查询/遍历”。需 F3 发布阶段化查询或原错误的 phase，才能按 state.rs:296-305、419-437 完整映射；不按错误文本猜阶段。 |
| S06 | 争用测试退回 pending；现有固定延时仅保留作最终序号的补充用例并明确标注，主/子线程均改为真实 F3 + 插件公开服务（`5ab819dc1`）。没有声称修复原 busy_handler 握手保证。 | 阻塞：F3 ConnectionProfile（api.ts）只有 busyTimeoutMs，未发布实际 sqlite busy observer/handler 的测试接口。需 F3 提供 busy 通知/释放能力，验证 contender 已争锁且 writer 可在其等待时提交；不能把 worker ready 或“即将调用”当 busy。 |

建议项：TESTMAP 分开统计 40 条 Rust 映射与参数化/补充 TS 用例（现在 ported 28、pending 12）；
SqlExecutor 业务边界的收敛随 S04 由所有者发布事务内语义 API，不新增通用兼容层。
上述 WIP 自动检查点不是 B 级通过凭证；最终验证结果与提交状态见 REPORT。

## 自动质量反馈：tombstone 职责拆分

- [x] 删除 `src/time.ts`，state/清单上传直接调用 F4 `toRfc3339()`；时间解析与
  纳秒比较使用 F4 的解析结果，不再保留同名本地格式化函数。
- [x] `tombstones.ts` 只保留服务组装与原导出；拆出模型校验/路径键、不可变事件、
  清单传输、本地文件应用。依赖单向，所有文件少于 800 行。
- [x] 函数移动不改变分支、错误、排序、事务/副作用顺序或日志；67 项测试通过。
  原 `per_device_tombstone_manifests_reread_after_put` 源码锁改为三类生产上传路径的
  行为测试：成功/回读损坏/对象缺失均验证 PUT 后 GET，保留四个 Rust 断言的含义。

## 协议 v2：服务接线、共享工具与日志

- [x] 服务改名 `syncSupport`，描述版本 `1.0.0`；inject `storage` / `notes`，
  `ctx.notes` 消费 L10（若未更名提供则插件等待依赖，不以假服务启动）。
- [x] 全部时间格式/解析复用 F4 time；`trim` 与严格 UTF-8 使用 F4 util。
  tombstone 比较保留纳秒；LWW 使用 Rust 内部解析器（不接受纯数字）。
- [x] tombstone.rs:630：新清单 PUT/回读成功后，删除旧对象失败 warn，然后成功返回。
- [x] tombstone.rs:639：探测旧对象失败 warn，不删除旧对象，然后成功返回。
- [x] tombstone.rs:751：坏/超前时间戳 warn 后跳过，不推进水位、不中断批次；workspace 也传真实 logger。
- [x] tombstone.rs:1551：本地文件 mtime 更新时 info 后跳过，不删除本地/云端、不计 affected。
- [x] tombstone.rs:1586：本地相对路径不可得时 warn 后跳过云端删除，仍计 affected。
- [x] tombstone.rs:1601：云端桶未匹配 hash 时 warn 后跳过删除，仍计 affected。
- [x] conflict_resolver.rs:205、pomodoro_counts.rs:137 的 `let _ = execute` 无日志，
  保持忽略错误；删除 `ignoreError` 空实现，用有源码依据的 empty-catch 豁免。
- [x] note_history/state/pomodoro/conflict_resolver 的生产源码无 tracing 宏，不凭空新增日志。
- [x] Linux 续作合入 L10 的 `notes` 提供方，删除入口临时 Context 类型断言。
- [x] L10 `notes.sync` / `format.blocks` 已发布并实际接入；L11 batch 同事务接入。
- [ ] L20 note-history hooks 改为消费本服务，删除其平行写SQL/marker副本；
  已有 state 消费不等于 note-history 消费链已闭合。

上述文件/行号均指 `src-tauri/crates/dstu-sync/src/data_governance/sync/`。

服务 `syncSupport` 无命令、无事件；以下按 Rust 模块逐条核对（文件:行以
`src-tauri/crates/dstu-sync/src/data_governance/sync/` 为基准）。

## 全局语义

- [x] 错误形状：`SyncSupportError` 的 `message` 与 Rust `SyncError` 的 `Display` 一致
  （`IO error: …` / `Database error: …` / `Network error: …` /
  `Clock drift suspected: …`），`kind` 对应变体（mod.rs:400-475、`src/errors.ts`）。
- [x] `Option<T>`：Rust `None` → TS `null`；`#[serde(default)]` 只在字段缺失时生效，
  显式 `null` 不当作缺省（tombstone 清单/事件解析已按此 fail-closed）。
- [x] u64/i64：TS 用 `bigint` 承载 `seq` / 水位；落 SQLite 时按 `i64::try_from(...).unwrap_or(i64::MAX)`
  饱和（state.rs:215-290）。读取前启用 safeIntegers；内部业务整数与 CAS 保留 bigint，
  仅安全范围内转换为 number。跨 L20 编码接线仍需其采用无损 JSON 数字表示（S03）。
- [x] 时间：Rust `Utc::now().to_rfc3339()` → F4 `toRfc3339()`（`+00:00`、AutoSi）；
  解析兼容 RFC3339、SQLite `datetime`、naive ISO 与秒/毫秒整数（mod.rs:71-94）。
  tombstone 合并额外按秒+纳秒比较，避免丢亚毫秒顺序。
- [x] ID/哈希：sha256、事件 key 的 20 位零填充序号、`operation_id` 的
  `u64` 大端长度前缀、`payload_hash` 字段（tombstone.rs:149-267）。
- [x] 事务：`BEGIN IMMEDIATE` 语义用于事件序号分配；设备轮换/清空基线使用单事务。
- [x] 并发：Node 单线程；跨连接/跨进程由 SQLite 事务与 upsert 的 `max(...)` 守卫，
  Rust 的 `Mutex<Connection>` 对应 F3 `DatabaseHandle`（单连接同步执行）。
- [x] 日志：Rust `tracing::info/warn!` → 强制注入的 `logger`；无空 logger。
  无日志的 `let _ =` 用真实理由的 boundary-allow，不借空函数规避检查。

## tombstone（tombstone.rs）

- [x] 设备路径/兼容 key：`device_component` 替换 `/\:*?"<>|`、空白落
  `unknown-device`；新 key 用 sha256 前 16 hex；旧明文 key 只读兼容（149-167、525-571）。
- [x] 不可变事件：`event_operation_id`（四个长度前缀字段）、`event_payload_hash`
  （format_version u32 + seq u64 + 五个长度前缀字符串 + size/relative_path 标记）、
  `event_key` / `event_legacy_key` / `event_key_matches`（169-267）。
- [x] 发布：列举新/旧前缀、截断即失败、同一 operation_id 多序号失败、云端 max(seq)
  与本地状态库取大、PUT 前/后回读校验（281-419）。
- [x] 下载：按 key 读取、解密、serde 形状校验、路径/内容/operation_id/payload_hash
  一致性检查、按 device_id/seq/operation_id 排序（421-464）。
- [x] 事件水位：按设备分组、期望 seq 连续、坏/超前 `deleted_at` 跳过且其后不推进、
  重复消费幂等（466-523、747-765）。
- [x] 清单：每设备增删改、回读一致、迁移后尽力删除旧明文对象、失败只 warn（573-646）。
- [x] 合并：`deleted_at` 新者胜，`updated_at` 取新；坏时间戳退回字符串比较（648-704）。
- [x] 时间校验：无法解析 → `Database error: … tombstone 时间戳无效`；未来超过
  `MAX_DRIFT_MS` → `ClockDriftSuspected`（706-765）。
- [x] 下载（blob/asset/workspace）：legacy 清单 + 每设备清单 + 事件三路合并；
  after 变体按来源水位过滤并返回 `TombstoneWatermarkAdvance`（946-1399）。
- [x] 上传：先发布事件，再双写每设备清单并回读；asset 不写 relative_path、
  workspace 不写 size（1401-1513）。
- [x] 应用：先整批校验 hash/路径再删除；本地 mtime 更新则跳过；云端删除优先
  relative_path，其次本地相对路径，最后按 hash 前缀桶查找；坏时钟条目跳过且不进
  affected（1515-1690）。
- [x] 路径安全：`<hash[0..2]>/<hash>.<ext>` 两段、拒绝绝对路径/符号链接桶与目标（1615-1662）。
- [x] 清理：`prune_tombstones` 恒返回 0（无权威 replace snapshot 前不得裁剪）（1723-1732）。

## note_history（note_history.rs）

- [x] `include_note_dependencies`：仅在 `version_id` 列存在时生效；按 formats →
  revisions（`ORDER BY seq`）→ relations 顺序并入，`seen` 去重，继承 note 的变更日志边界（17-75）。
- [x] `prepare_relation`：locator 按 serde 枚举校验（whole/block/page(u32)/card/question），
  关系类型与 locator 匹配，CAS `revision` 取本地 `max+1`（77-116）。
- [x] `retarget_note_relations`：资源换绑时更新非 card 关系并 bump revision；
  note 未删除时失效缺失块（118-151）。
- [x] `invalidate_missing_blocks` 已委托 notes.sync 的真实 block parser；真实 Markdown
  验证失效缺失块、解析失败取空集合，缺失 notes.sync 时写入前报错；无本地 marker 副本。
- [x] `apply_revision`：身份/pin 归一/剔除本地列/必填字段/格式能力/正文检测/
  tags(`Vec<String>`)/asset_refs(`NoteAssetRef`)/props JSON 校验；本地已存在时逐字段
  比较，冲突文案 `Immutable history conflict: {id} ({key})`；pin 只升不降；否则插入（153-257）。
- [x] `affected_notes`：notes → id；resources → resource_id；其他表空（259-277）。
- [x] `snapshot_notes`：remote_sync 先按正文推断格式（保留旧 baseline 与 columns 能力），
  再快照；before_sync 快照后强制 pin（279-316）。
- [x] `validate_batch_formats`：资源/笔记落库前拒绝未来格式、身份不匹配与
  body/envelope 能力不匹配（318-368）。
- [x] `validate_incoming`：formats / resources / 其他表按受影响 note 校验格式（370-399）。

## pomodoro_counts（pomodoro_counts.rs）

- [x] 相关表判定：`pomodoro_records` 或 `todo_items`（95-99）。
- [x] 刚需形状守卫：缺 `todo_items.completed_pomodoros` 或事实表列时静默跳过（154-160）。
- [x] 全量重算：`UPDATE FROM` 聚合未软删 `work`+`completed` 且 `todo_item_id` 非空；
  `IS NOT` churn guard；空记录二次清零（161-206）。
- [x] 回声抑制：取 `__change_log` 前 max id，重算后只标记 `id > max AND sync_version=0
  AND table_name='todo_items'`，`sync_version = now().timestamp()`；失败忽略（208-217）。

## state（state.rs）

- [x] 表结构：upload_seq / consume_cursor / legacy_processed_key / tombstone_watermark /
  tombstone_event_publish / instance_binding / device_history（59-117）。
- [x] `bind_instance`：已绑定 provider/hint 不匹配 → `Network error: 云同步实例绑定不匹配…`（119-160）。
- [x] 水位：读 `max(0)`；写 upsert 取 max（162-207）。
- [x] 事件序号：IMMEDIATE 事务；同 operation_id 返回原序号；`cloud_existing_seq>0` 优先；
  否则 `max(local, cloud)+1` 饱和；提交后返回（209-290）。
- [x] 上传序号/消费游标：读 `max(0)`；写 upsert 取 max（292-420）。
- [x] legacy processed：`INSERT OR IGNORE`（422-450）。
- [x] 设备轮换：单事务写 device_history、清消费游标/legacy/水位，保留 upload_seq（452-505）。
- [x] 清空本机数据后重置：重建表后删除 consume_cursor/legacy_processed_key/
  tombstone_watermark/instance_binding/device_history，保留 upload_seq（528-552）。

## conflict_resolver（conflict_resolver.rs）

- [x] 冲突定义：本地行存在 + `__change_log` 有 `sync_version=0` + 业务指纹不同（464-518）。
- [x] 业务指纹：只比较云端 payload 出现的字段；对象排序、剔除同步元字段、JSON 字符串
  先解析（518-563）。
- [x] DELETE：本地无未同步变更直接放行；有则按策略裁决，keep_latest 用 LWW 比较
  （310-370）。
- [x] 三种策略：落败方进 `__sync_conflicts`；Cloud 胜前必须经 `SyncHistoryPort` 快照，
  失败即拒绝覆盖（199-208、372-458）。
- [x] 冲突表：DDL、`data_hash` 升级列、未解决去重索引；同内容重复写入返回 false（110-292）。
- [x] `compute_data_hash`：规范化 JSON 的 sha256 前 16 字节 hex（294-302）。
- [x] `is_clean`：仅 `rejected === 0`（105-107）。

## 已知差异 / 待协调

- [x] Rust 特殊行为保持并记录于 `REPORT.md`（例如 `prune_tombstones` 不裁剪，
  有明确的权威快照前置条件，不自行判定为 bug）。
- [x] `note_history` 块解析与原子写接口已由 L10 发布，并通过公开服务接入。
- [ ] `note_history` 的 5 个 Rust 集成测试补齐完整 apply 断言；TESTMAP 保留 pending。
