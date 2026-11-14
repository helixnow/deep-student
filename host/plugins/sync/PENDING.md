# L20 pending 逐项状态与证据

## WP-004 当前状态（2026-11-05；优先于下方历史记录）

- 实际状态列为 256 ported / 2 pending / 0 merged / 5 approved obsolete；本包不改映射。
- 两项 pending：`mod.rs:13778 file_and_snapshot_keys_are_neutral_ids` 的活跃断言仍待后续复核（snapshot 子断言已按 D8 退休，不能把“补 snapshot 实现”作为阻塞）；`src/sync_app_tests.rs:13 regression_j8c_resources_data_merges_learner_profiles` 的 owner API 已在 main `memory/api.ts:60` 发布，待 L20 消费及原向量验证。二者均按 WP-004 brief 留后续包，不是外部缺接口。
- `mastery` 注入修复已存在于 `c2536fc6b`；本包补真实 review+sync Host 集成证据，见 `tests/mastery-integration.test.ts` 与 `WP-004-REPORT.md`。
- F3 `openStartupDatabase` 及多库 worker/文件公共接口均已在 main 发布；D18 startup 不在本包重做。下方“未公开/未进入 main/46 pending”均为历史记录。

## 13:28关键路径更新

正常merge `6d2b70efd`（main `ad11a83943de411a75c87364fd8893a174ce63f9`）已带入L20b异步codec；五条命令现已正式index注册，消费真实L21/L20b/L23并按需取L05 workspace owner。原C/T/L“缺async codec/未注册”阻塞已解除，下面原测试逐行pending暂不机械整批改ported，待按真实入口/原向量逐项复核。Memory/F3后继接口尚按实际main判断。

生产入口证据：`20261104132424-3d8946` 12passed exit0；`20261104132718-b09cfb` 4passed exit0，后者含真实异步F4 DSBK→L20b墓碑→WebDAV读写及两run_sync空云成功/清理。前述符号不可达X6-PR-0117/0118已有候选接线，不等于全部协议语义签收。

X4 W13独立集成项（2026-11-05 更新）：本lane已交付真实 paths-only pre-storage provider `host/plugins/sync/startup.ts`（`dstu.sync-startup`，`provides:['storageStartupSync']`、`inject:['paths']`），通过 `repository/startup-state.ts` 独立打开 `sync_state.db`，与 Rust `open_default` 一致建表并在单事务清空 `consume_cursor`/`legacy_processed_key`/`tombstone_watermark`/`instance_binding`/`device_history`，保留 `upload_seq`/`tombstone_event_publish`。`dstu.sync` 已移除同名 provide，不再冒充 bootstrap。真实启动组合测试 `tests/startup-bootstrap.test.ts` 验证：provider 先于 storage、marker 在 purge 后由 F3 清除、业务库可开；reset 失败时五表回滚、marker 保留、业务库保持关闭。剩余跨 owner 接线：① F1 生成器/官方 profile 需发现 `host/plugins/sync/startup.ts` 并按 kernel→该模块→platform 排序（当前仅扫 `host/plugins/*/index.ts`；`desktop.json` 由生成器维护，本lane不改）；② F3 公开能力已交付：源提交 `55884368c` 导出 `openStartupDatabase`/`StartupDatabase`，本 lane 已用 `cherry-pick -x` 引入同一提交（L20 内 `f03a4b0a6`），`startup-state.ts` 现只 import `platform/storage/api.ts`，不再私引 `connection.ts`/`profiles.ts`，五表 reset SQL/错误/事务/close 保持。此项不增加原263条TESTMAP行。

最新补充：F1分支已写bootstrap排序/only-paths校验，未再视为缺算法；L20b api.ts还需导出可独立调用的state-owner工厂或按路径reset函数（目前只有服务实例方法）。公开面缺失不能通过私import service.ts/state.ts、直接驱动或复制五表SQL绕过。具体最小签名见REPORT顶部。

TESTMAP 保留46 pending；212 ported、0 merged、5经C2批准obsolete。R4-SYNC-05画像测试退回pending：自写merger不是owner实现，原version3/4→5与目标向量必须经Memory正式公开面验证；请求见R4-owner-requests.md。11条历史/番茄原测试以本 lane 真实公开apply链闭合，逐断言矩阵见TESTMAP；不以L20b本地pending状态一律回退本lane覆盖。writer busy握手仍pending。

R4-SYNC-06：仅完成逐token缓冲导出；真实worker与虚拟URI staging/copy/cleanup尚未闭合。当前main的worker-pool.ts未从api公开且任务只持单库自动创建连接，文件copy/URI入口也未公开。已向F3提交精确owner请求，不私import、不伪造异步worker。

## 证据索引

- **C**：异步codec已正式合入，分类/清单聚合已由index注册命令消费；原pending测试逐条入口/原断言确认待做，不再请求owner重写codec。
- **T**：文件/直接命令现已接真实async tombstone owner；28条支撑模块测试仍指向sync-support，11条完整apply测试指向本lane真实实现，writer握手独立pending。文件原向量与生产入口对照尚不整批签收。
- **L**：L21许可/SSOT/audit已进入main，全部24命令已有注册；D7跨库apply已公开且被run_sync await调用，无双向硬inject。原pending的具体错误/日志/运行时语义仍待逐条复核，不再表示缺接口/入口。
- **D8**：C2分片已批准5条dead-in-rust，已标obsolete；3个混合测试仅退休指定子断言，精确行号见TESTMAP。schema活跃部分已ported；C8与文件命名活跃断言已测，但仍待T生产接线。

## asset_filenames.rs（10）

- `rclone_style_unsafe_characters_roundtrip_without_collisions` — C
- `reserved_trailing_and_dot_names_are_safe_and_reversible` — C
- `nfc_and_nfd_remain_distinct_nfc_safe_keys_and_roundtrip` — C
- `marker_and_quote_in_user_name_are_data_not_protocol` — C
- `malformed_or_noncanonical_encodings_fail_closed` — C
- `segment_and_total_path_limits_fail_closed_without_truncation` — C
- `paths_roundtrip_and_traversal_fails_closed` — C
- `legacy_lossy_alias_is_available_beside_new_key` — C
- `casefold_keeps_case_conflicts_but_not_nfc_nfd_collision` — C
- `conflict_messages_carry_stable_marker` — C

## sync/mod.rs（13）

- `regression_c8_upload_path_verifies_size` — T；活跃行size/bytes、实例/设备/文件清单回读、文件短写/下载截断均有行为断言，仍待文件入口async codec集成；legacy子义退休已按D8批准。
- `file_and_snapshot_keys_are_neutral_ids` — T；blob-sync.test.ts已从实际blob上传验证blobs前缀/json后缀/UUID长度/无raw/hash/time，snapshot子义按D8批准退休；待文件生产入口接线。
- `encrypted_file_upload_reuses_session_and_preserves_payload` — T；`tests/file-transfer.test.ts` 已验证单会话复用、密文哈希/大小与完整解密；生产上由 workspace-sync 调用，后者待异步墓碑端口接线。
- `workspace_upload_fails_when_remote_object_size_mismatches` — T；完整原断言见 `tests/workspace-sync.test.ts`，短写不发布条目。
- `file_e2ee_workspace_roundtrip_between_encrypted_devices` — T；同文件，双哈希/密文对象/两设备真实 SQLite 往返已通过。
- `file_e2ee_workspace_plaintext_mode_unaffected` — T；同文件，明文 SQLite 往返及无 cipher 元数据已通过。
- `file_manifest_publish_uses_neutral_object_name` — T；同文件，经实际上传验证 UUID 名不含设备/短哈希/时间前缀。
- `file_manifest_download_reads_legacy_raw_device_dir` — T；同文件，经完整清单下载路径验证。
- `file_e2ee_workspace_rejects_legacy_plaintext_entry` — T；同文件，稳定码/迁移指引/无落地已验证。
- `file_e2ee_workspace_migrates_legacy_plaintext_entry_on_upload` — T；同文件，未变内容仍重新加密并由第二设备下载。
- `file_e2ee_blob_roundtrip_rejection_and_migration` — T；`tests/blob-sync.test.ts` 完整覆盖密文双哈希、两设备往返、篡改三次重试不落地、旧明文拒收和再加密迁移；标准流程及本地引用保护的墓碑编排已实现，等待异步墓碑 codec 接线。
- `asset_tombstone_reclaims_object_without_conflict_resurrection` — T；`tests/file-deletions.test.ts` 验证实际上传/下载/标记/删除编排、最后引用回收、无 conflict 副本复活及水位提交；外部墓碑读写端口用替身，等待 L20b async codec 后接入真实服务。
- `file_e2ee_asset_roundtrip_and_legacy_rejection` — T；`tests/asset-sync.test.ts` 完整验证内容寻址密文对象、密文/明文哈希、两设备往返及明文遗留拒收。

## 支撑模块 pending（1）与D1独立整改

- `tombstone_sequence_waits_for_writer_before_reading` — F3 尚无原生 busy observer/handler；当前300ms延时不是 Rust state.rs:626-657 的已争用通知/释放握手。

六条pomodoro真实apply测试已消费L11所有者批量重算，并验证同事务失败回滚；五条note-history原断言经真实公开apply/getPending/enrich保留。W18已删除本lane全部笔记写SQL与块解析器，默认hooks组合syncSupport只读面与notes.sync同事务写。L10精度修复已合入main，原props_json/CAS两项失败在20261104110810-67d980（Node全lane405passed）及20261104110811-68af68（Electron17passed）转绿，均exit0/无Errors；此前失败作为历史记录保留，不再声称owner候选未合。S03/S04独立签收归R4；syncSupport其余共享数值/codec候选仍按实际main接口判断，不强制cast。

## commands_sync.rs（21）

- `config_encryption_password_ignores_empty_password` — L；`src/upload-policy.ts` 及原测试完整通过，等待持共享许可/目标租约的高层入口。
- `record_upload_policy_allows_plaintext_without_marker` — L；`tests/upload-policy.test.ts` 经真实 L23 CloudSyncManager/F4 密码校验验证。
- `record_upload_policy_writes_marker_with_verifier_when_encrypted` — L；同上。
- `record_upload_policy_rejects_plaintext_when_marker_exists` — L；同上。
- `record_upload_policy_allows_same_password_when_marker_exists` — L；同上。
- `record_upload_policy_rejects_wrong_password_before_upload` — L；同上，保留原 marker 字节不被错密码覆盖的断言。
- `progress_v2_download_paths_enforce_prune_gap_check` — L + T；`record-progress.ts` 两条完整 v2 管线已实现，测试真实断层在任何 apply/云写之前拒绝；未注册的顶层入口等待 L21/L20b 端口。
- `deletion_queues_never_permanently_abandon_failed_entries` — T；三个真实 SQLite 队列均验证 retry_count=999 的失败项递增到 1000 后仍能重试并在成功后删除；`src/file-level-sync.ts` 已接入三个 drain，等待外部 async codec 和完整同步命令接线。
- `registry_drift_preflight_rejects_missing_row_sync_trigger` — L；已在 run-sync 两个入口的租约/密码门槛之后、manifest/schema/富化之前调用；入口等待 L21 端口发布。
- `registry_drift_preflight_rejects_unregistered_change_log_trigger` — L；同上。
- `trigger_event_reads_the_header_regardless_of_whitespace` — L；同上。
- `registry_drift_preflight_accepts_the_production_pin_trigger_text` — L；同上。
- `registry_drift_preflight_allows_exempt_delete_and_update_of_trigger` — L；同上。
- `registry_drift_preflight_update_of_counts_as_update_op` — L；同上。
- `concurrent_direct_tombstone_marks_serialize_or_fail_busy` — L + T；`tests/tombstone-commands.test.ts` 通过真实命令函数验证持锁读写窗口、busy 零写、重试无 lost update。共享 limiter 只在测试中替代。
- `tombstone_limiter_busy_code_is_stable` — L；同文件，生产 acquire helper 的错误字面量已锁定。
- `tombstone_direct_commands_take_permit_and_keep_readback_invariant` — L + T；同文件，两个真实命令在创建 storage 前取得许可，L20b 回读失败传播并释放许可；等待两端接口才能注册。
- `classify_blobs_distinguishes_present_pending_and_legacy_plaintext` — C；完整分类测试已通过。
- `classify_assets_reports_case_conflict_sanitized_conflict_and_invalid_key` — C；完整分类测试已通过。
- `merge_blob_manifests_prefers_cipher_entries_over_plaintext` — C；完整合并测试已通过。
- `merge_asset_manifests_higher_revision_wins` — C；完整合并测试已通过。
