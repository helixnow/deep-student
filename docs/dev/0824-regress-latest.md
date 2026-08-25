# 0824 最新 tip 定向回归：#177 移植 + F + G + GenUI 技能 i18n

日期：2026-08-25  
隔离分支：`cursor/0824-regress-latest-cde6`（**不回推 0824 本身**）  
基座：`origin/cursor/0824-cde6` @ `2b6488a6`（拉取时即 live tip，两者一致）  
约束：只允许测试侧修复，不弱化产品行为。产品代码零改动。

环境：Rust 1.98.0 stable、`libwebkit2gtk-4.1-dev` 等 CI 同款 apt 依赖、
protobuf-compiler、`bash scripts/download-pdfium.sh linux-x64`、`npm ci`。
容器内 fuse3/xdg-desktop-portal postinst 报错可忽略（同
`0824-rehearse-cloud-latest.md` §6 备注）。本机无 Docker。

## 1. 回归矩阵（全部通过）

### Rust（cargo test，src-tauri）

| 焦点 | 证据 | 结果 |
|---|---|---|
| put_file 后 size 回验 | `--lib 'cloud_storage::'`：105 通过 0 失败。含 `webdav::put_file_fails_when_propfind_size_mismatches`、`s3::put_file_source_guards_remote_size_check`、`ftp` 侧 `verify_remote_object_size` 源守卫 | ✅ |
| 加密标记 / ZIP / 清单回读 | 同上：`sync_manager::persist_encryption_marker_fails_when_reread_mismatches`、`..._fails_when_missing_after_put`、`upload_fails_when_remote_zip_size_mismatches`、`upload_fails_when_published_manifest_reread_mismatches` | ✅ |
| S3 Range GET 续传语义 | 同上：`s3::parse_content_range_start_*`（标准形/不可满足形）、`resume_actual_start_fails_closed_on_misaligned_range`、`resume_actual_start_restarts_when_range_ignored` | ✅ |
| FTP 550 严格白名单 | 同上：`ftp::test_unclassifiable_550_is_not_treated_as_missing`、`test_not_found_whitelist_accepts_explicit_missing_messages`、`test_pyftpdlib_not_retrievable_is_not_found`、`test_broad_not_found_substring_no_longer_matches` | ✅ |
| tombstone 清单回读 | `--lib 'data_governance::sync::tombstone::tests'`：20 通过 0 失败（修复前首轮 1 flake，见 §2）。含 `upload_blob_tombstones_fails_when_reread_mismatches`、`..._fails_when_missing_after_put`、`per_device_tombstone_manifests_reread_after_put` | ✅（修复后连续 8 轮 + 前 4 轮全绿） |
| 文件级对象 size 回验 | `--lib`：`data_governance::sync::tests::workspace_upload_fails_when_remote_object_size_mismatches` + 源守卫 `regression_c8_upload_path_verifies_size`（`put_file_and_verify_size` / `put_bytes_and_reread` 锚点） | ✅ |
| WebDAV/桌面 S3 下载续传编排 | `--test sync_r09_download_resume_tests`：6 通过 0 失败（断点保留、精确续传、损坏断点丢弃、服务端忽略续传诚实从零、fail-closed 默认实现、非续传后端不留断点） | ✅ |
| 记录级清单回读（集成） | `--test sync_r12_record_path_names`：7 通过 0 失败（含 `upload_manifest_fails_when_reread_mismatches`） | ✅ |
| 文件级 E2EE 往返 / 明文拒绝 | `--test sync_file_level_e2ee`：7 通过 0 失败（含 `r07_plaintext_file_uploads_rejected_when_marker_exists`——加密标记存在时明文上传拒绝） | ✅ |
| #169 tombstone 场景（#177 移植面） | `--test sync_scenarios_tests asset_tombstone`：4 通过 0 失败（含 `asset_tombstone_resolves_object_key_and_keeps_shared_content_object`） | ✅ |
| 全量 sync 模块兜底 | `--lib 'data_governance::sync::'` 一轮全绿（见 §3 数字） | ✅ |

**跳过**：`sync_provider_contract_tests`（真实 WebDAV/S3/FTP 容器门禁，需
`DS_SYNC_TEST_DOCKER=1` + Docker；本机无 Docker）。550/Range 语义已由上面
的单元/源守卫层覆盖，容器层无本地证据，与此前各轮预演口径一致。

### Vitest（前端）

一批 12 文件 55 用例全过，另加 2 文件 125 用例（resume TS 侧）：

| 焦点 | 文件 | 结果 |
|---|---|---|
| Composer* 契约（F/G 拆分后） | `chatV2ComposerPanelSizingContract`、`chatV2ComposerPanelTokensContract`、`chatV2SendButtonContract`、`chatV2InputBarRadiusContract`、`ComposerPlusMenu`、`composerDraftStorage`、`InputBarUI.mobileSplitContract.source` | ✅ 30 用例 |
| Finder host buckets | `tests/vitest/learning-hub/finder-host-buckets.test.ts` | ✅ 16 用例 |
| DataGovernance A+B+G 共存 | `tests/vitest/data-governance/DataGovernanceDashboard.abg.source.test.ts` | ✅ 3 用例 |
| 空卡库不虚报 100% | `tests/vitest/flashcards/TodayScreen.emptyLibrary.test.tsx` + `todayScreenEmptyLibrary.test.tsx` | ✅ 4 用例 |
| GenUI 内置技能 i18n | `src/features/chat/skills/__tests__/builtinSkillLocalization.test.ts`（本轮扩展后 4 用例，见 §2） | ✅ |
| 桌面恢复/续传 TS 源契约 | `r09-restore-ops.source.test.ts`（10）+ `dataGovernance.api-contract.test.ts`（115） | ✅ |

## 2. 测试侧修复（两笔，建议官方分支吸收）

### `f4ef3459` test(i18n)：钉住 generative-ui 的名称**和**描述

`414abdc7` 在 zh-CN/en-US 的 `skills.json` 同时补了 `builtinNames` 和
`builtinDescriptions` 两半，但既有测试只断言「每个内置技能有 name」——
删掉 `builtinDescriptions["generative-ui"]` 不会有任何测试红。本轮在
`builtinSkillLocalization.test.ts` 增加定向断言：两个 locale 里
generative-ui 的 name 与 description 都非空。故意**不**要求所有技能都有
description（当前 54 name / 32 description，`getLocalizedSkillDescription`
对缺失项回退 skill 自带描述是设计行为）。

### `2e74b23c` test(sync)：串行化写共享 `sync_state.db` 的 tombstone 测试

**Flake 实录**：首轮 `data_governance::sync::tombstone::tests` 20 选 1 红：
`publish_events_continues_seq_from_legacy_raw_prefix` panic
`保留 tombstone 事件序号失败: database is locked`。单跑与复跑均绿（修复前
4 轮模块复跑全绿），是并行竞态。

**根因**：`reserve_tombstone_event_seq_with_existing`（`state.rs`）在
DEFERRED 事务（`unchecked_transaction`）里先 SELECT 后 INSERT 做锁升级；
`SyncStateStore::open_default()` 每次调用都对同一个磁盘库
（`~/.local/share/deep-student/sync/sync_state.db`）开**新连接**。两个并发
连接同时做 SHARED→RESERVED 升级时，SQLite 死锁检测**绕过 busy_timeout**
立即返回 `SQLITE_BUSY`。测试进程里 `upload_blob_tombstones_fails_*` 两个
用例与 `publish_events_continues_seq_*` 都会经 `publish_events` 走到这条
升级路径，默认并行 harness 撞上即红。

**修复（纯测试侧）**：`state.rs` 增加 `#[cfg(test)] pub(crate) fn
test_write_lock()`（`OnceLock<tokio::sync::Mutex<()>>`，产品构建不编译），
三个会写库的 tombstone 测试入口先取锁。修复后模块连续 8 轮全绿，另有
`data_governance::sync::` 全量一轮 208 通过 0 失败。

**产品侧建议（本轮未做，超出 test-only 约束）**：真正的修法是把该事务改成
`TransactionBehavior::Immediate`——BEGIN 即取 RESERVED，busy_timeout 恢复
生效，产品内并发同步链路同样受益。这不是弱化而是加固，建议官方分支作为
独立产品提交评估；届时本测试锁可保留（无害）或一并移除。注意 `--lib` 全量
CI 里 `sync/mod.rs` 的写库测试与 tombstone 测试之间理论上仍存在同型竞态
（本轮未观察到），Immediate 事务是唯一根治手段。

## 3. 汇总数字

- Rust：`cloud_storage::` 105；`tombstone::tests` 20×12 轮（修复前 5 轮
  含 1 flake 轮，修复后 8 轮全绿）；定向 lib 2；`data_governance::sync::`
  全量 208 通过 0 失败；集成 6+7+7+4。0 个产品性失败。
- Vitest：14 文件 184 用例全过（含扩展后的 i18n 测试 4 用例）。
- 唯一失败即 §2 的 SQLite flake，已定位根因并以测试侧修复钉死。

## 4. 对官方 0824 的结论

1. 官方 tip `2b6488a6` 上 #177 移植面（size 回验/回读闸/Range 续传/550
   白名单）、F/G（Composer 拆分、finder host buckets、DataGovernance
   A/B/G、空卡库 0%）、GenUI 技能 i18n 全部定向回归通过，无回归。
2. 建议官方吸收两笔 test-only 提交：`f4ef3459`（i18n 双半钉住）、
   `2e74b23c`（tombstone 测试串行锁——不吸收则 rust-test-build CI 存在
   低概率 `database is locked` flake）。
3. 产品侧后续项（非本轮范围）：`reserve_tombstone_event_seq_with_existing`
   改 IMMEDIATE 事务（§2）；Docker 容器契约门禁本轮无本地证据，官方 CI
   照常跑即可。
