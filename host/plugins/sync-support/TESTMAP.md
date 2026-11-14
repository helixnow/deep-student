# L20b-sync-support 测试去向

本 lane 的 Rust 测试仍登记在 L20 的 `host/plugins/sync/TESTMAP.md`；按派发要求，
这里列出 `测试 id → ported:<本 lane 路径>` 对照，由协调者同步到 L20 表。
标题包含 Rust 测试名的用例都在下列 TS 文件中。

统计：Rust 内联测试 40（tombstone 25 / note_history 5 / pomodoro_counts 8 / state 2）
· ported 39 · merged 0 · obsolete 申请 0 · pending 1（writer busy 握手）。
WP-011 只补宿主 mastery 装配与 `tests/service-host.test.ts` 的真实 provider 行为回归，
不调整任何 Rust 测试去向；pending 前 1 → 后 1，ported 维持 39。原业务断言全部保留。
S03补充 `tests/event-json-precision.test.ts` 两条公开服务事件JSON回归（非新增Rust映射）：
2^53+1序号及另一奇数大size、发布回验与重试去重。有效输入修前作业 `20261104200941-f251ff` 2fail/exit1，
修后 `20261104201022-5d0c16` 2pass/exit0；无 Errors/Unhandled Errors，原移植断言不改。
Electron `20261104201130-f450c8` 同2pass/exit0，无 Errors/Unhandled Errors。
165250 集成红灯保留为历史：固定树 notes retention Slot 生命周期问题已由 L10 `5f9082dbf`
修复进main。本lane续补真实F3 maintenance registry及app目录，四入口最小作业
`20261104173204-d56061` 4 passed / 24 标题过滤、exit0、无 Errors/Unhandled Errors。
39 ported是映射而非全套通过声明，完整自检另记，旧红灯详见REPORT/BLOCKERS。
5 条 note_history 映射现指向 `tests/note-history-apply.test.ts`：正式 main `677f6727c`
已包含默认 syncSupport reader + L10 writer 接线，作业 `20261104160636-53cfb7` 5/5、exit 0。
这是实现方生产入口证据，非 R4 独立验收；旧函数级用例继续保留，但不承担完整移植凭证。
R4 §5 JSON 文本、applyRevision及真实L10 owner INTEGER/CAS回归现已在正式main修复后通过：
L10 `32e423cb2` / `3cb9e7770` 已合入；作业 `20261104105720-b564e3` 三文件13/13，exit0。
本lane仅补测试宿主的公开paths.dataSpaceDeviceId接口，全部精度原断言保留。
F3 phase（9900d8dda）已进main：两条prepare文案原断言未改即通过（作业 `20261104122242-2989d0` 12/12）；
首step错分按R4 §8修正（execute一律映射rows.next上下文），作业 `20261104123619-eb8627` 15/15。
S05为R4补充项，不增计Rust ported；S06 busy握手仍pending；不能继承旧104/104全绿声明。
详见SPEC / REPORT最新结果，S03独立签收仍归R4。
`conflict_resolver.rs` 无内联测试；`tests/conflicts.test.ts` 的 10 个行为测试为补充覆盖。

## 测试

| Rust 测试 | 种类 | 位置 | 去向 |
|---|---|---|---|
| `crates/dstu-sync/src/data_governance/sync/tombstone.rs::tests::test_prune_tombstones_retains_expired_without_authoritative_snapshot` | test | L1740 | ported:host/plugins/sync-support/tests/tombstone.test.ts |
| `crates/dstu-sync/src/data_governance/sync/tombstone.rs::tests::watermark_never_filters_same_millisecond_or_clock_rewind_tombstones` | test | L1772 | ported:host/plugins/sync-support/tests/tombstone.test.ts |
| `crates/dstu-sync/src/data_governance/sync/tombstone.rs::tests::malformed_tombstone_manifest_fails_closed` | test | L1817 | ported:host/plugins/sync-support/tests/tombstone.test.ts |
| `crates/dstu-sync/src/data_governance/sync/tombstone.rs::tests::test_find_blob_by_hash` | test | L1829 | ported:host/plugins/sync-support/tests/tombstone.test.ts |
| `crates/dstu-sync/src/data_governance/sync/tombstone.rs::tests::test_blob_tombstones_roundtrip` | test | L1854 | ported:host/plugins/sync-support/tests/tombstone.test.ts |
| `crates/dstu-sync/src/data_governance/sync/tombstone.rs::tests::immutable_event_identity_and_key_are_stable` | test | L1872 | ported:host/plugins/sync-support/tests/tombstone.test.ts |
| `crates/dstu-sync/src/data_governance/sync/tombstone.rs::tests::per_device_tombstone_manifests_reread_after_put` | test | L2027 | ported:host/plugins/sync-support/tests/tombstone.test.ts |
| `crates/dstu-sync/src/data_governance/sync/tombstone.rs::tests::upload_blob_tombstones_fails_when_reread_mismatches` | tokio::test | L2048 | ported:host/plugins/sync-support/tests/tombstone.test.ts |
| `crates/dstu-sync/src/data_governance/sync/tombstone.rs::tests::upload_blob_tombstones_fails_when_missing_after_put` | tokio::test | L2092 | ported:host/plugins/sync-support/tests/tombstone.test.ts |
| `crates/dstu-sync/src/data_governance/sync/tombstone.rs::tests::bad_or_future_deleted_at_is_skipped_and_never_advances_watermark` | test | L2125 | ported:host/plugins/sync-support/tests/tombstone.test.ts |
| `crates/dstu-sync/src/data_governance/sync/tombstone.rs::tests::apply_blob_tombstones_skips_bad_clock_entries_without_failing_batch` | tokio::test | L2178 | ported:host/plugins/sync-support/tests/tombstone.test.ts |
| `crates/dstu-sync/src/data_governance/sync/tombstone.rs::tests::event_watermark_stops_before_bad_clock_event` | tokio::test | L2235 | ported:host/plugins/sync-support/tests/tombstone.test.ts |
| `crates/dstu-sync/src/data_governance/sync/tombstone.rs::tests::download_blob_tombstones_after_excludes_bad_entries_from_merge_and_watermark` | tokio::test | L2284 | ported:host/plugins/sync-support/tests/tombstone.test.ts |
| `crates/dstu-sync/src/data_governance/sync/tombstone.rs::tests::tombstone_watermark_source_uses_content_device_id` | test | L2342 | ported:host/plugins/sync-support/tests/tombstone.test.ts |
| `crates/dstu-sync/src/data_governance/sync/tombstone.rs::tests::download_blob_tombstones_after_reads_legacy_raw_name_as_same_device` | tokio::test | L2373 | ported:host/plugins/sync-support/tests/tombstone.test.ts |
| `crates/dstu-sync/src/data_governance/sync/tombstone.rs::tests::download_blob_tombstones_after_rejects_path_content_mismatch` | tokio::test | L2406 | ported:host/plugins/sync-support/tests/tombstone.test.ts |
| `crates/dstu-sync/src/data_governance/sync/tombstone.rs::tests::tombstone_device_keys_use_short_hash_not_raw_id` | test | L2435 | ported:host/plugins/sync-support/tests/tombstone.test.ts |
| `crates/dstu-sync/src/data_governance/sync/tombstone.rs::tests::download_own_blob_tombstone_reads_legacy_raw_name` | tokio::test | L2467 | ported:host/plugins/sync-support/tests/tombstone.test.ts |
| `crates/dstu-sync/src/data_governance/sync/tombstone.rs::tests::upload_blob_tombstone_migrates_legacy_raw_name` | tokio::test | L2494 | ported:host/plugins/sync-support/tests/tombstone.test.ts |
| `crates/dstu-sync/src/data_governance/sync/tombstone.rs::tests::publish_events_continues_seq_from_legacy_raw_prefix` | tokio::test | L2548 | ported:host/plugins/sync-support/tests/tombstone.test.ts |
| `crates/dstu-sync/src/data_governance/sync/tombstone.rs::tests::torn_blob_dual_write_retry_converges_without_duplicate_event` | tokio::test | L2671 | ported:host/plugins/sync-support/tests/tombstone.test.ts |
| `crates/dstu-sync/src/data_governance/sync/tombstone.rs::tests::interleaved_blob_dual_writes_extend_stream_without_gap_or_duplicate` | tokio::test | L2764 | ported:host/plugins/sync-support/tests/tombstone.test.ts |
| `crates/dstu-sync/src/data_governance/sync/tombstone.rs::tests::cross_device_dual_write_interleaving_keeps_streams_independent` | tokio::test | L2822 | ported:host/plugins/sync-support/tests/tombstone.test.ts |
| `crates/dstu-sync/src/data_governance/sync/tombstone.rs::tests::torn_asset_dual_write_retry_converges_without_duplicate_event` | tokio::test | L2892 | ported:host/plugins/sync-support/tests/tombstone.test.ts |
| `crates/dstu-sync/src/data_governance/sync/tombstone.rs::tests::conflicting_same_operation_rewrite_fails_closed_and_keeps_original_event` | tokio::test | L2952 | ported:host/plugins/sync-support/tests/tombstone.test.ts |
| `crates/dstu-sync/src/data_governance/sync/note_history.rs::tests::direct_remote_resource_update_keeps_both_full_document_snapshots` | test | L417 | ported:host/plugins/sync-support/tests/note-history-apply.test.ts |
| `crates/dstu-sync/src/data_governance/sync/note_history.rs::tests::relation_sync_rebuilds_local_cas_and_replay_does_not_increment_it` | test | L471 | ported:host/plugins/sync-support/tests/note-history-apply.test.ts |
| `crates/dstu-sync/src/data_governance/sync/note_history.rs::tests::remote_pin_is_retained_after_unpinned_replay_and_prune` | test | L537 | ported:host/plugins/sync-support/tests/note-history-apply.test.ts |
| `crates/dstu-sync/src/data_governance/sync/note_history.rs::tests::row_sync_transmits_history_dependencies_and_preserves_remote_before_after` | test | L583 | ported:host/plugins/sync-support/tests/note-history-apply.test.ts |
| `crates/dstu-sync/src/data_governance/sync/note_history.rs::tests::immutable_history_conflict_is_quarantined_and_valid_retry_preserves_local_pins` | test | L680 | ported:host/plugins/sync-support/tests/note-history-apply.test.ts |
| `crates/dstu-sync/src/data_governance/sync/pomodoro_counts.rs::tests::td02_two_devices_2_plus_3_converge_to_5` | test | L289 | ported:host/plugins/sync-support/tests/pomodoro-counts.test.ts |
| `crates/dstu-sync/src/data_governance/sync/pomodoro_counts.rs::tests::td02_remote_tombstone_delete_does_not_resurrect_count` | test | L366 | ported:host/plugins/sync-support/tests/pomodoro-counts.test.ts |
| `crates/dstu-sync/src/data_governance/sync/pomodoro_counts.rs::tests::td02_repeated_apply_is_idempotent` | test | L416 | ported:host/plugins/sync-support/tests/pomodoro-counts.test.ts |
| `crates/dstu-sync/src/data_governance/sync/pomodoro_counts.rs::tests::td02_record_moved_to_another_todo_rebalances_and_zeroes_empty_todo` | test | L466 | ported:host/plugins/sync-support/tests/pomodoro-counts.test.ts |
| `crates/dstu-sync/src/data_governance/sync/pomodoro_counts.rs::tests::td02_remote_delete_operation_zeroes_count` | test | L494 | ported:host/plugins/sync-support/tests/pomodoro-counts.test.ts |
| `crates/dstu-sync/src/data_governance/sync/pomodoro_counts.rs::tests::td02_partial_apply_with_quarantined_change_reflects_committed_rows_only` | test | L532 | ported:host/plugins/sync-support/tests/pomodoro-counts.test.ts |
| `crates/dstu-sync/src/data_governance/sync/pomodoro_counts.rs::tests::td02_recompute_scope_idempotency_and_echo_suppression` | test | L571 | ported:host/plugins/sync-support/tests/pomodoro-counts.test.ts |
| `crates/dstu-sync/src/data_governance/sync/pomodoro_counts.rs::tests::td02_recompute_skips_databases_without_todo_tables` | test | L666 | ported:host/plugins/sync-support/tests/pomodoro-counts.test.ts |
| `crates/dstu-sync/src/data_governance/sync/state.rs::tests::tombstone_event_sequence_is_monotonic_and_idempotent` | test | L579 | ported:host/plugins/sync-support/tests/state.test.ts |
| `crates/dstu-sync/src/data_governance/sync/state.rs::tests::tombstone_sequence_waits_for_writer_before_reading` | test | L597 | pending |

## 说明

- `per_device_tombstone_manifests_reread_after_put` 是 Rust 源码锁测试。按 quality.md §5，
  已改为三种清单的生产行为测试，分别覆盖正常回读、回读内容损坏与 PUT 后对象丢失；
  断言三种上传路径必须 PUT 后 GET，错误时不得返回成功。仍对应同一条 Rust 测试映射。
- 异步 codec 提交时 Vitest：11 文件、104 个用例（含 14 个 R4 精度/错误阶段回归及 23 个异步 DSBK 回归）。
  后续另增 1 文件、6 个未修反例（4 个 JSON 文本、2 个状态准备阶段），及 1 个真实遍历阶段
  回归（iterate 适配后通过）；本轮另增 owner INTEGER 历史重放 1 条和真实所有者事务 3 条，
  另补缺source能力错误传播1条，总计 13 文件/116 用例。
  本轮只运行变化相关最小集，不能把总数当全套通过数。
  用例数含参数化与
  补充覆盖，不能用来替代本表 40 条 Rust 测试状态；5 条函数级不完整覆盖与 1 条
  缺实际 busy 握手的补充测试均不计 ported。

### R4 S02 / S06 处理进展

L20 引擎接口随 `7625998df` 合入后，六条 pomodoro 已恢复完整原 apply 断言：
安装真实 L20 sync + L11 vfsRepo + L10 notes + syncSupport，直接调用公开
sync.applyDownloadedChanges；无自写 apply/UPSERT/伪检疫，无测试后手工软删。
真实 F3 两库，检疫测试恢复 success_count=1/failure_count=1；Node 作业
20261104071723-1c314f 的9条全部通过（exit 0），六行恢复 ported，待 R4 独立复核。
下表列出各测试现已覆盖的不变量，只有最后的 S06 仍 pending：

| Rust 测试名 | 生产链路断言 / 剩余阻塞 |
|---|---|
| `td02_two_devices_2_plus_3_converge_to_5` | 两库真实远端 apply 与缓存合并后均为 5 |
| `td02_remote_tombstone_delete_does_not_resurrect_count` | 真实字段冲突合并、tombstone 与 replay 不复活计数 |
| `td02_repeated_apply_is_idempotent` | 真实批次两次 apply 幂等，不是重复重算 |
| `td02_record_moved_to_another_todo_rebalances_and_zeroes_empty_todo` | apply 落库换绑后同时修正两个 todo |
| `td02_remote_delete_operation_zeroes_count` | 真实远端 Delete 产生软删并清零，不能由测试 SQL 代替 Delete |
| `td02_partial_apply_with_quarantined_change_reflects_committed_rows_only` | 真实 SAVEPOINT/检疫与 success_count=1、failure_count=1（Rust :555-557） |
| `tombstone_sequence_waits_for_writer_before_reading` | 原 Rust :626-657 的实际 busy 回调通知/释放握手；F3 `api.ts` 的 ConnectionProfile 只有 busyTimeoutMs，没有 busy observer/handler。固定延时或“即将调用”通知都不是已争用证明，现有测试仅作为最终序号的补充覆盖。需 F3 提供测试用原生争用通知接口，不允许本 lane 自行引入原生绑定或模拟 busy handler。 |

### note_history 生产链恢复（原 pending 已解除；待 R4 独立签收）

main `677f6727c` 的 `sync/index.ts:94-97` 默认 hooks 使用 syncSupport.noteHistory reader，
所有笔记写经 notes.sync/revisions；旧直接写 SQL 已删除。不能再用“默认 hooks 名字仍存在”
推断仍为旧实现。本 lane 未改 L20，也未在测试中设置/替换默认 hooks。
`tests/note-history-apply.test.ts` 使用真实 F3 迁移两库、公开 notes 创建/更新、sync pending/enrich/apply，
而非把旧函数级用例换名。原 Rust 各断言与 TS 对应如下：

| Rust 范围 / 测试 | 新测试保留的不变量 |
|---|---|
| :417-468 direct resource | 初次/更新 failure_count=0；目标完整正文；原文快照且 pinned、远端全文快照；另观察默认 reader/writer 同 tx |
| :471-534 relation | 上传无 revision；初次 failure_count=0、CAS=1；真实 replay 不递增且无 missing-target 资源；换绑 failure_count=0、CAS=2；再 replay=2；目标 notes_relation_get 的两个 reference 标志均 true |
| :537-580 pin | 远端 pin/unpin failure_count=0；真实 Delete 后 get 仍 pinned |
| :583-677 row sync | 未来版本/能力均抛错且目标 notes/resources 分别为空；历史无 seq、有 pinned；两轮乱序 apply failure_count=0；历史可 get；远端正文 after；before pinned/after 快照；restoreCopy 正文 before |
| :680-731 immutable | 篡改 failure_count=1；已保存正文 original、pinned；合法重试 failure_count=0；Delete 后仍 pin；未来版本 failure_count=1、get 失败 |

Node 作业 `20261104160636-53cfb7` 5 passed、exit 0，无 Errors/Unhandled Errors。
Electron 作业 `20261104160922-2faa05` 同 5 passed、exit 0，无 Errors/Unhandled Errors。
旧 `tests/note-history.test.ts` 所有断言未改，仍作函数级补充。以下保留旧 pending 判断历史，
其“默认 hooks 未接线”描述仅对应 `677f6727c` 之前的树，不再作为当前阻塞。

### 原 pending 证据（历史）

这 5 项的 L20 公共 API 已随 `7625998df` 合入，但生产 `sync/index.ts:77` 的
createNoteHistoryHooks 仍来自 L20 自身 repository/note-history.ts，而非本服务。
本 lane 已用真实 notes 服务验证自有委托，完整 apply 测试须在该生产消费链修正后恢复，
不能测试时替换 L20 私有 hooks。L10 owner 精度缺陷另见当前回归报告。
不得导入 L20 私有 repository，也无权修改其目录来添加接口。

| Rust 测试名 | 未接入的具体能力与尚缺断言 |
|---|---|
| `direct_remote_resource_update_keeps_both_full_document_snapshots` | `sync.applyDownloadedChanges`：真实源/目标库初始 apply、远端 resource 更新及 failure_count=0 |
| `relation_sync_rebuilds_local_cas_and_replay_does_not_increment_it` | `sync.getPendingChanges` / `sync.enrichChangesWithData` / `sync.applyDownloadedChanges`：发送端剔除 CAS、目标库两次真实 replay 及 failure_count |
| `remote_pin_is_retained_after_unpinned_replay_and_prune` | `sync.applyDownloadedChanges`：pin/unpin 重放后的真实远端 Delete 不删除 pin |
| `row_sync_transmits_history_dependencies_and_preserves_remote_before_after` | 上述三个 sync 方法：乱序批次、未来格式失败后目标空库、真实更新；随后用已发布的 `notes.revisions.restoreCopy` 验证恢复副本 |
| `immutable_history_conflict_is_quarantined_and_valid_retry_preserves_local_pins` | `sync.applyDownloadedChanges`：failure_count=1/0、不可变冲突隔离、真实 Delete 保留 pin、未来版本被拒 |

L10 `format.blocks` / `notes.sync` 已在 main；本 lane 现委托其关系失效/历史写/推断格式，
无需等待这些符号。L20 state 消费已在 main，但 note-history 的平行实现还需 L20 清理。

- `note_history` 的 5 个 Rust 用例使用完整 apply 管线（`apply_downloaded_changes`）。
  `tests/note-history.test.ts` 目前只覆盖部分函数级行为，不能作为这 5 个 Rust 测试
  的完整移植凭证：缺 `failure_count`、远端 Delete、真实重放、乱序批次、
  失败后目标库为空与 `restore_copy` 断言。已有函数级断言保留并运行，映射改为 pending。
  L20 的 apply/enrich/pending 入口已在本工作树；剩余为生产 note-history hooks
  接本服务，而非缺API。L10公开restoreCopy已存在；不能仅因测试名相同宣称完整移植。
- 额外用例（非 Rust 测试名）：`tests/conflicts.test.ts` 10 个（编译期 Rust 无内联
  测试的行为覆盖）、`tests/plugin.test.ts` 2 个、以及每个移植文件的 1-2 个补充守卫。
- WP-278（X7 G2“B 启动即建 sync_state.db”差异）：新增 `tests/state-lazy-open.test.ts`
  2 条非 Rust 映射回归——经生产入口装载插件且不调命令时
  `<dataLocal>/deep-student/sync/sync_state.db` 不存在；调用 tombstone 上传（内部读写 state）
  后文件存在且 7 张表齐全。Rust 映射不变（ported 39 / pending 1）。
  变异：把 index.ts 恢复为 apply 时打开，该用例失败（`20261106163642-101d90` exit1）；
  修复后 Node 17 文件/128 通过（`20261106163711-1a51cc`），Electron 同数
  （`20261106164726-e55f91`）。purge-on-start 现有用例全过（`20261106163711-3de5de`）。
