# L22-app-commands 最终报告

2026-11-04 · 分支 `ds-mig/L22-app-commands` · 目录 `host/plugins/integration/`

## 1. 结论

- 本 lane 没有 IPC 命令：`src-tauri/src/commands.rs` 的全部 `#[tauri::command]` 已按命令名分给
  其他 lane，inventory 中 L22 命令数为 0。因此没有 `contracts/ipc/L22-app-commands.json`，
  也没有在集成插件重复注册命令。
- 已交付：AppState 拆分接口与剩余命令层状态服务、50 个前端未定义命令的 Tauri ACL 复现、
  290 个前端未调用命令的保守审计、**157 条 `ported` + 4 条 `merged` + 53 条已批准
  `obsolete`** 的 Rust 测试去向。delta backup-v2 的 21 条未覆盖面由
  `tests/delta-backup-v2.test.ts` 调用 L23 生产实现补全；L20 合入后交付 record-path 7、
  format gate 1、R10 混沌 10（truncation 3 / mixed E2EE 4 / idempotent 3）；
  L21 合入后交付 autosync mutex 1；L19 发布 `mcp` 服务后交付工具注册表 3 与
  `run_all_core_tests` 冒烟 1。质量 §10 审计把 8 条弱 merged 目标降回 pending；
  协调者批准 49 条 delta ID 为 `obsolete:dead-in-rust experimental`
  （`migration/approvals.d/C2-platform.json`，提交 `294cbe65f`），5 条 source-lock
  保持 `ported`，delta 测试文件暂保留在套件中。
- 53 条 `obsolete`（4 mobile-only + 49 delta）已获协调者批准并写入 approvals；
  本 lane A = **214/243 = 88.1%**（157 ported + 4 merged + 53 obsolete）。
- 剩余 `pending` 均有具体 owner 与缺失符号证据（见 §7）。L20 两个写命令已在 main
  `4dc4c8ed9` 注册，原 4 条（§7.3）由 WP-114 经真实命令交付；以下为旧基线记录：候选实现 `340e81ada`（候选分支 `c215cad2b`）已在
  `host/plugins/sync/index.ts:73-74` 声明并在 `:181-183` 真实注册
  `data_governance_resolve_record_conflict` /
  `data_governance_rollback_sync_snapshot_batch`，但 main 尚未正式集成（不是 owner
  尚未注册）。4 条命令用例逐字保存在 `blocked/*.test.ts.txt`，TESTMAP 如实保持
  pending；本 lane 不用替身冒充被测对象，也不重写其他 lane 的算法。

## 2. 门禁（本轮最终运行）

2026-11-04 在与集成门禁相同的树（`main` + L22 tip `3c76312fd` 的合并，`/tmp/opencode/l22-gate`）运行：

| 命令 | 结果 |
|---|---|
| `npx tsc -p tsconfig.host.json` | 通过：job `20261104114045-881e7d`，退出码 0 |
| `node scripts/electron-migration/boundaries.mjs` | 0 violation：job `20261104114045-eb7701`，退出码 0 |
| `DSTU_BOUNDARY_STRICT=1 boundaries.mjs <本次改动的 15 个 .ts>` | 0 violation：job `20261104114045-2aa7e4`，退出码 0 |
| `npx vitest run -c vitest.host.config.ts host/plugins/integration` | 通过：job `20261104114045-995fe0`，**31 个文件、272 个用例**，退出码 0 |
| `npm run migration:boundaries:strict` | job `20261104114046-bf9aa7` 退出码 1：全局 4 条违规（3 `empty-catch` + 1 `console-log`），全部在 `host/plugins/vfs/`，**L22 0 条** |
| `npm run migration:wiring -- --lane integration` | **ported 157，未接入 0（0.0%）**：job `20261104114046-17c745`，退出码 0 |
| `node scripts/electron-migration/importable.mjs host/plugins/integration/index.ts` | `importable: ok`：job `20261104114046-b89689`，退出码 0 |
| `npm run migration:ledger -- --check --no-write` | 退出码 0：job `20261104114045-7ead86`，problems 0 |

`strict` 的 4 条违规全部在 `host/plugins/integration/` 之外；本 lane 生产代码没有
`console.*`、`void e`、空 catch、TODO/FIXME 或 `unimplemented`。
协调者 11:15 转发的 `sync-r12-locks` 8 条失败摘录与 10:35 那次逐毫秒相同，属于
`a7487debe`（夹具改用真实 F3/F4/L11）之前的结果；修复后同文件 29/29 通过。

## 3. Ledger A/B 百分比

本轮全仓 `--check --no-write` 的末行原样输出见 §10。L22 自身按 `TESTMAP.md` 243 行逐行计算：

- 243 行：**A = 214/243 = 88.1%（157 `ported` + 4 `merged` + 53 已批准 `obsolete`），
  problems 0**。
- 标准 `--check --no-write` 输出的全局 B 为 commands 7.2% / tests 1.5%（并非本 lane
  的 B）；本 lane 的 A 由 TESTMAP 行状态计算。本 lane 自身测试文件中的 A 级用例在
  `npx vitest run -c vitest.host.config.ts host/plugins/integration` 中全部通过；
  merged 目标由目标 lane 的测试套件覆盖。
- 命令 0 个：A/B/C 均为 0/0。

不使用只含本 lane 部分报告的 JSON 跑全局 ledger；L22 的 A 由 TESTMAP 行状态计算，
与 `migration:wiring` 的 ported 条目一致。

## 4. TESTMAP 统计与测试去向

`TESTMAP.md`：243 行，真实测试 243。生成区块的表头仍是初始计数，因为刷新需要协调者统一运行
`npm run migration:scaffold -- --refresh`；实际去向以行状态和本节统计为准。

| 去向 | 条数 |
|---|---|
| `ported:` | 157 |
| `merged:` | 4 |
| `obsolete:`（已获批并写入 approvals） | 53 |
| `pending` | 29 |

157 条 ported 按目标文件（含 2026-11-04 新增 `tests/llm-codex-connection.test.ts` 2 条）：

| TS 文件 | 条数 |
|---|---|
| `host/plugins/integration/tests/sync-r12-locks.test.ts` | 29 |
| `host/plugins/integration/tests/llm-probe-helpers.test.ts` | 13 |
| `host/plugins/integration/tests/llm-codex-connection.test.ts` | 2 |
| `host/plugins/integration/tests/repo-check.test.ts` | 11 |
| `host/plugins/anki/tests/templates.test.ts` | 8 |
| `host/plugins/integration/tests/crypto-verifier.test.ts` | 8 |
| `host/plugins/integration/tests/sync-history-behavior.test.ts` | 8 |
| `host/plugins/integration/tests/sync-record-path-names.test.ts` | 7 |
| `host/plugins/integration/tests/backup-lease.test.ts` | 6 |
| `host/plugins/integration/tests/sync-lease.test.ts` | 6 |
| `host/plugins/integration/tests/frontend-source-locks.test.ts` | 5 |
| `host/plugins/integration/tests/app-state.test.ts` | 4 |
| `host/plugins/integration/tests/data-space-cutover.test.ts` | 4 |
| `host/plugins/integration/tests/sync-chaos-clock.test.ts` | 4 |
| `host/plugins/integration/tests/sync-chaos-mixed-e2ee.test.ts` | 4 |
| `host/plugins/integration/tests/webdav-contract.test.ts` | 4 |
| `host/plugins/integration/tests/android-saf.test.ts` | 4 |
| `host/plugins/integration/tests/tools-registry.test.ts` | 4 |
| `host/plugins/integration/tests/sync-download-defaults.test.ts` | 3 |
| `host/plugins/integration/tests/sync-migration-change-log.test.ts` | 3 |
| `host/plugins/integration/tests/sync-chaos-truncation.test.ts` | 3 |
| `host/plugins/integration/tests/sync-chaos-idempotent.test.ts` | 3 |
| `host/plugins/integration/tests/tools-provider.test.ts` | 3 |
| `host/plugins/llm/tests/connection_test.test.ts` | 3 |
| `host/plugins/integration/tests/frontend-contracts.test.ts` | 2 |
| `host/plugins/integration/tests/sync-manager-extra.test.ts` | 2 |
| `host/plugins/integration/tests/sync-format-gate.test.ts` | 1 |
| `host/plugins/integration/tests/sync-autosync-mutex.test.ts` | 1 |
| 其余 2 个单条目标（ACL、restart） | 2 |

4 条 `merged:` 的目标分布：

- L20 `host/plugins/sync/tests/asset-filenames.test.ts` 1 条；
- L21 `host/plugins/backup/tests/portable-precheck.test.ts` 1 条；
- L21 `host/plugins/memory/tests/hpias.test.ts` 1 条；
- F4 `host/kernel/tests/error-details.test.ts` 1 条（HTTP 429/500 → 错误码）。

### 4.1 `merged:` 逐条同义审计（quality §10）

2026-11-04 按协调者指令逐条对照 Rust 测试与 merged 目标。审计时保留 19 条同义
merged；协调者随后批准 49 条 delta ID 为 `obsolete`，其中 14 条 delta merged
（13 条 format + 1 条 upload）转入 `obsolete`，4 条非 delta merged 继续保留。

**其余 4 条非 delta merged：逐条完整断言核对**（不是 source-lock/租约豁免）：

| Rust 测试 | TS 目标 | 同义断言 |
|---|---|---|
| `hpias_event_channel_matches_frontend_contract` | `memory/tests/hpias.test.ts::channel_matches_frontend_contract` | 两边都断言生产常量精确等于 `"hpias_event"`，TS 常量来自 `memory/src/hpias-payloads.ts` |
| `r01_p2_filename_length_is_clamped_fail_closed` | `sync/tests/asset-filenames.test.ts::segment_and_total_path_limits_fail_closed_without_truncation` | 255 字节合法、256 拒绝、冒号拒绝、120+120 嵌套 key 超总长拒绝、300 字符 sanitize 返回 null；覆盖或强于 Rust 的 300/120+120 断言 |
| `every_import_entry_fails_early_without_password` | `backup/tests/portable-precheck.test.ts::no_password_is_left_to_existing_missing_password_gate` | TS 统一入口 `importBackupFromZip` 的 `password:null` + `skipExisting:false/true` 覆盖 Rust 四入口；两种模式都断言密码错误码与目标目录不存在；正确密码正对照在同文件 `correct_password_on_sealed_zip_passes_precheck` |
| `test_mock_http_error_responses` | `kernel/tests/error-details.test.ts::test_http_status_to_error_code` | TS 9 状态映射包含 Rust 的 429→`HTTP_TOO_MANY_REQUESTS` 与 500→`HTTP_SERVER_ERROR`，是超集；mock server 搭建本身不是被测行为 |

**审计时保留 merged 的 14 条 delta**（现已转 obsolete）：

- `delta_format` 13 条：往返含空快照、config 往返、11 个 camelCase 字段、未来/过去版本、
  错误 format、parent/patch 未知字段拒绝、key material/epoch=0、12 个 logicalPath 与
  6 个 objectKey 穿越值、4096/4097 与 513 字节上限、重复 logicalPath、logicalSize 不等、
  6 个非法摘要值对两种哈希，均与 Rust 逐一对应；`r12_duplicate_logical_path_is_rejected`
  与 `r12_logical_size_mismatch_is_rejected` 共用同一个同时断言两件事的 TS 用例。
- `delta_upload::r12_single_file_change_uploads_only_that_file_and_manifest`：同一
  `publishVerifiedStaging` 两版发布，断言上传 2（变更文件 + manifest）、复用 1、
  未变对象 key 不变、变更对象 key 改变、index 两条版本；与 Rust 的不变 key / 变更 key
  断言同义，fixture 文件数 3 vs 4 不影响被测不变量。

**审计时降回 `pending` 的 8 条**（目标只覆盖部分断言组，按 quality §10 如实降级；
已随协调者批准转 `obsolete`）：

| Rust 测试 | 原 merged 目标 | 缺失的同义断言 |
|---|---|---|
| `r12_gc_truncated_listing_fails_closed` | `delta_gc.test.ts::fails closed on truncated listings` | Rust 覆盖 manifests/objects 两种 collect 截断、sweep manifests/candidates 两种截断与零删除；TS 只测 collect 的通用 truncated，未测 sweep |
| `r12_gc_rereferenced_candidate_is_dropped_without_deleting_object` | `delta_gc.test.ts::sweep never deletes a re-referenced object...` | Rust 先裁版产生 2 个 candidate、重新引用后 sweep 断言 2 个 dropped 且 v2 snapshot + 全部对象存活；TS 手插 1 个 candidate，未覆盖 collect/prune 链路 |
| `r12_plaintext_roundtrip_restores_every_logical_file` | `delta_restore.test.ts::materializes...` | Rust 同时断言显式 version_id 恢复与存储无 `backups/`/`manifests/` 写入；TS 目标只测 latest 恢复 |
| `r12_same_size_swapped_object_fails_closed` | `delta_restore.test.ts::rejects a corrupt object...` | Rust 断言错误包含 objectKey、`SHA-256` 与 version_id，并整对象 XOR 后长度不变；TS 只翻 1 字节并断言 `SHA-256` |
| `r12_compatible_zip_written_only_after_verification` | `delta_restore.test.ts::writes a v1-compatible ZIP...` | Rust 逐项断言 ZIP 含 manifest + 全部数据文件且字节与 staging 一致；TS 只断言文件非空、PK 头与拒绝覆盖 |
| `r12_first_version_uploads_every_logical_file` | `delta_upload.test.ts::publishes a first snapshot...` | Rust 断言逐对象明文/密文字节与哈希、对象数 = 逻辑文件数、`reused_size=0`、无 v1 namespace、`DEFAULT_BACKUP_V2_MAX_VERSIONS=10`；TS 目标未覆盖这些断言 |
| `r12_corrupted_index_or_descriptor_fails_closed_without_new_objects` | `delta_upload.test.ts::fails closed on a corrupt existing index...` | Rust 覆盖损坏 index 与损坏 descriptor 两段，并在修复后恢复发布（只传 manifest）；TS 目标只测损坏 index |
| `r12_e2ee_encrypts_objects_and_descriptor_with_one_session` | `delta_upload.test.ts::encrypts objects, config and descriptor...` | Rust 还断言明文哈希/路径不出现在 index 或 object key、密文哈希≠明文哈希、零变化第二版只重传 manifest；TS 目标未覆盖这些断言 |

这 8 条没有用“文件存在”充当完成；2026-11-04 协调者批准后，43 条 delta 行为测试
+ 6 条 delta inventory 全部为 `obsolete:dead-in-rust experimental`，5 条 source-lock
保持 `ported`。批准记录见 `migration/approvals.d/C2-platform.json`（`294cbe65f`）。

**执行数量与退休数量分开：**

- 实际执行：`npx vitest run -c vitest.host.config.ts host/plugins/integration` 为
  **29 个文件 / 269 个用例**，包括 `tests/delta-backup-v2.test.ts` 的 21 条 delta
  行为测试；这些测试没有被删除、跳过或改成替身。
- 退休：49 条 TESTMAP 行（43 条 delta 行为 + 6 条 inventory）经批准转为
  `obsolete:dead-in-rust experimental`，不再作为迁移义务；其中 35 条在原状态已是 A
  （21 ported + 14 merged），14 条原 pending 因批准转为 A（8 行为 + 6 inventory）。
- A 由正式 ledger 计算，不是手调比例：`ledger-core.mjs:40-44` 规定已批准
  `obsolete` 为 A=B=true，因此当前 A = 157 + 4 + 53 = **214/243 = 88.1%**。

`tests/sync_r10_android.rs::rust_side_must_queue_content_uri_for_main_activity_persist`
原先并入 F3 `host/platform/storage/tests/unified-file-manager.test.ts::queue_persistable_saf_uri_writes_content_only`，
现已在本 lane `tests/android-saf.test.ts` 直接移植为同名用例（3 条断言：队列内容逐字节一致、
`PENDING_SAF_PERSIST_FILE`、`PENDING_SAF_PERSIST_DIR`）；F3 的更强用例仍保留，两者不冲突。

53 条 `obsolete`（4 条 mobile-only + 49 条 delta）与证据见 §6。

原 source-lock/事务锁用例已迁到 TS：`tests/frontend-source-locks.test.ts` 5 条（前端/文档锁）、
`tests/sync-r12-locks.test.ts` 8 条（整 ZIP/无 decoded/无 delta 接线/防降级）、
`tests/restart-ordering.test.ts` 1 条（`process:restart` 前 purge marker 已落盘）。
`tests/sync-conflict-fast-path.test.ts` 的 2 条（事务内重读与匹配状态）已移植，但依赖
main 尚未集成、L20 候选分支已注册的命令，逐字保存在 `blocked/` 并保持 pending（见 §7.3）。

`tests/app-state.test.ts` 另有 2 条本 lane 补充测试（纳秒精度与卸载），不占 TESTMAP 行。
`tests/command-surface.test.ts` 的 102 条用例覆盖 50 个未定义命令的 debug/release ACL 行为
与审计完整性，不对应单个 Rust 测试名。

## 5. 本轮新增：delta backup-v2 行为测试

`tests/delta-backup-v2.test.ts` 直接调用 L23 `sync-providers/api.ts` 发布的生产实现
（`encodeSnapshotDescriptor` / `publishVerifiedStaging` / `restoreSnapshotToStaging` /
`collectGcCandidates` / `sweepGcCandidates` / `GcCandidateV2`），用 L23 同款内存
`CloudStorage` 夹具，不复制算法。覆盖：

- format：100001 文件拒绝、恰好 100000 合法（`r12_file_count_over_limit_is_rejected`）。
- upload：空 device id 零写入、零数据变化仅重传 manifest、跨设备零复用、
  index PUT 失败留孤儿、descriptor PUT 失败留对象、租约被占零对象写入。
- restore：空/未知/缺失设备 fail-closed、复用对象多版本恢复（含第三版混合复用）、
  E2EE 往返 + 错密码 + 无会话、明文仓库带 cipher 拒绝、缺对象定位到
  version/object/path、损坏 index/descriptor、租约被占零写入、兼容 ZIP 三类失败无半成品。
- GC：共享对象保留 + 裁版 snapshot 按 grace 回收、孤儿 candidate 不刷新 `firstSeen`、
  损坏 descriptor 零删除、错密码/策略不一致零删除、租约被占两轮均拒绝、
  candidate codec 拒绝未知字段/未来版本/越界 key。

**零接线复核（2026-11-04）**：上述 delta 行为测试所覆盖的 Rust 模块与 L23 TS 移植
均为「experimental 隔离、生产入口无」。按协调者指令，不把 delta 接到命令层/UI/
`sync_manager`；43 条行为测试 + 6 条 delta inventory 已获批准为
`obsolete:dead-in-rust experimental`（详见
[`OBSOLETE-REQUEST-delta.md`](OBSOLETE-REQUEST-delta.md) 与
`migration/approvals.d/C2-platform.json`）。5 条 source-lock 继续保留为 `ported`，
用来钉死零接线；`tests/delta-backup-v2.test.ts` 仍在套件中运行（269 用例），
但 TESTMAP 不再把这 21 条计入 A。是否删除该测试文件由协调者另行决定。

## 6. 待协调者批准清单（`migration/approvals.json`）

### 6.1 `obsolete:mobile-only`（4 条，已获协调者批准）

| id | 证据 |
|---|---|
| `tests/sync_r10_android.rs::saf_document_id_resolves_to_real_file_name_and_extension` | `extract_extension` 仅用于 `ensure_local_path` 的 Virtual/content:// 分支（`src-tauri/crates/dstu-storage/src/unified_file_manager.rs:1079`），F3 未发布该函数 |
| `tests/sync_r10_android.rs::opaque_document_ids_are_detected` | Android document ID 启发式（`src-tauri/crates/dstu-storage/src/unified_file_manager.rs:991-1003`；`src-tauri/src/cmd/textbooks.rs:176`），F3 未发布该函数 |
| `tests/sync_r10_android.rs::file_name_sanitization_replaces_unsafe_characters_only` | SAF 物化/资产落盘名清洗（`src-tauri/crates/dstu-storage/src/unified_file_manager.rs:979-989,1024-1043`），F3 未发布该函数 |
| `tests/sync_r10_android.rs::zip_command_materialization_orchestration_is_anchored` | content:// ZIP 物化编排（`src-tauri/src/data_governance/commands_zip.rs:1232-1234` 的 `is_virtual_uri` 分支），真机 `Window<Wry>` 不可宿主执行 |

`tests/sync_r10_android.rs::rust_side_must_queue_content_uri_for_main_activity_persist`
已在本 lane `tests/android-saf.test.ts` 直接移植为同名用例（3 条断言：队列内容逐字节一致、
`PENDING_SAF_PERSIST_FILE`、`PENDING_SAF_PERSIST_DIR`），调用 F3 生产
`queuePersistableSafUri` / `persistableSafQueueFile`。F3
`unified-file-manager.test.ts::queue_persistable_saf_uri_writes_content_only` 仍保留更强的
额外覆盖（并发生产者、拒绝换行/双重编码等），不涉及 MainActivity 真机 persist。

### 6.2 `obsolete:dead-in-rust experimental`（49 条 delta，已获协调者批准）

43 条 `sync_r12_delta_{format,upload,restore,gc}` 行为测试 + 6 条
`sync_r12_delta_inventory` 行为测试。证据与完整 ID 见
[`OBSOLETE-REQUEST-delta.md`](OBSOLETE-REQUEST-delta.md)；批准记录在
`migration/approvals.d/C2-platform.json`（提交 `294cbe65f`）。5 条 source-lock
不在此列，继续 `ported` 以钉死零接线。

### 6.3 `obsolete:source-lock`（0 条）

协调者未批准任何 source-lock；15 条已全部迁到 TS 侧（见 §4）。

53 条批准记录（4 mobile-only + 49 delta）已写入 approvals（2026-11-04 复核）。
重新运行 `npm run migration:ledger -- --check --no-write` 后本 lane 的 problem 为 0，
A 为 212/243 = 87.2%。

## 7. 29 条 pending 的逐条证据与 owner

2026-11-04 对当前 `main`（merge `14c53a53d`）的公开 API 逐项复核。L20/L21/L19 的发布面
已经到达：L20 交付 7 条 record-path + 1 条 format gate + 10 条 R10 混沌；L21 交付
1 条 autosync mutex；L19 交付 3 条工具注册表 + 1 条 `run_all_core_tests`；L01/L02 交付 Codex OAuth 2 条（§7.1）。剩余 29 条如下。

| owner / 依赖 | 条数 | 具体 |
|---|---:|---|
| L20 `sync@1` 命令 wiring | 4 | 2 条 fast-path（事务内重读/匹配状态）+ 1 条 history resolve/list/rollback + 1 条与 fast-path 同义的并发编辑 |
| L17 HPIAS 后端选择 / session_started（WP-150 更新） | 3 | `generative_ui_executor_e2e.rs` L123/L167/L235；执行器已在 main 注册，6 条已 ported，见 §7.2 |
| L06 | 14 | `ToolPackExecutor.execute` 未发布；只有常量/admission |
| L19 MCP 错误详情 | 1 | `ToolRegistry` 没有 `call_tool_with_details` / `ToolNotFound` details 输出 |
| L05 | 1 | Windows shell helper（TS 实现未从 `api.ts` 导出，Electron 未接线） |
| **合计** | **29** | |

另：delta 43 条行为测试 + 6 条 inventory 已获批准为
`obsolete:dead-in-rust experimental`，不再计入 pending；5 条 source-lock 保持
`ported`。证据见 §6.2 与 [`OBSOLETE-REQUEST-delta.md`](OBSOLETE-REQUEST-delta.md)。

### 7.1 Codex OAuth（2 条，已于 2026-11-04 解除并移植）

`codex_connection_test_prefers_persisted_vendor_authentication`、
`codex_connection_test_supports_unsaved_oauth_context` 已移植到
`tests/llm-codex-connection.test.ts`。最新 main 的 L02 删除了固定 throw，
`test_api_connection` 命令把 `ctx.llmCodexAuth` 传给 `testApiConnection`
（`host/plugins/llm/index.ts` 的命令注册）。谓词 `isOpenaiCodexOauthTest`
（`connection_test.ts:538`）仍是私有函数，所以测试安装真实 L01 + L02 插件，
经生产命令观察 Rust `is_openai_codex_oauth_test`（`commands.rs:2869-2885`）的 4 个断言：
判定为 true 时请求打到本地 Codex responses 端点并带 OAuth 令牌；判定为 false 时请求打到
apiBase 并带请求/供应商密钥。持久化供应商分别用内置 `builtin-openai-codex` 和经
`save_vendor_configs` 保存的 `custom-openai`（真实 F4 `openCrypto` 加密密钥）。

### 7.2 `tests/generative_ui_executor_e2e.rs`（剩 3 条，WP-150 更新）

**当前状态（2026-11-06 WP-150）**：下文 9 条中有 6 条已经 ported 到
`tests/generative-ui-executor-e2e.test.ts`。main 已有注册的执行器（`vfs/index.ts:219-220`）和
`hpiasResearch`（`memory/index.ts:109`）。剩下 L123、L167、L235 三条仍为 pending，原因是生产语义缺口，
不是缺实现（证据见 BLOCKERS.md）。需要 L17 `hpiasResearch` 补上（不改 L13 端口签名也能做到）：

- `startFromIntent({ window, sessionId, title, intent }): void` 先按 Rust `HpiasBackendKind::from_env`
  （`service.rs:24-48`，包括未知值的 warn）读取 `DEEP_STUDENT_HPIAS_BACKEND`。`disabled` 时直接返回，不发事件；
  `retrieval` 依赖不全时按 `service.rs:96-101` 记 warn 后返回。
- 后端启用时，先同步在 `hpias_event` 上发出 `buildSessionStartedPayload(sessionId, question, null)`
  （Rust `generative_ui_executor.rs:348-354`；失败时记 warn
  `[GenerativeUiExecutor] hpias_event session_started emit failed: …`），再按 stub 时间线启动且跳过首条。
- L13 调用点（`vfs/src/tools/generative-ui.ts:151`）应传 `title ?? extractQuestionFromIntent(intent)`
  （Rust `:440-441`）。

这些都补上之后，三条测试可以经真实注册实例移植：L123 断言无事件，观察窗口应至少覆盖一个
350ms 间隔，因为 TS 首个事件在 350ms 才发，按 Rust 的 150ms 观察会误判通过。L167 断言
`output.researchSessionId` 和 `session_started.session_id`；L235 断言 `plan_generated` 出现时已有 `session_started`。

以下为 WP-150 之前的原文：

`execute_with_default_backend_keeps_research_blocks_static`、
`execute_with_research_session_emits_hpias_session_started`、
`execute_hpias_stub_pipeline_emits_plan_generated`、
`execute_emits_generative_ui_start_chunk_end_events`、
`execute_v1_1_grid_layout_emits_generative_ui`、
`execute_rejects_version_2`、`execute_rejects_unknown_block_type`、
`execute_rejects_too_many_blocks`、`execute_with_note_edit_preserves_input_payload`：
按协调者指令，generative UI 执行器属于 **L13**（不是 L04），真实执行主链由 C1 负责。
当前 `host/plugins/agent-skills/api.ts` 只发布 skills/MCP/workshop 执行器，
`host/plugins/alpha` 下也没有 generative UI 服务；`host/kernel/agent-roster.ts` 只在
名称花名册里列了 `GenerativeUiExecutor`（main 状态）。L13 候选已实现但未进 main：分支 `ds-mig/L13-vfs-api`（tip `acb015f93`，实现提交 `c986d4aaf`）的 `host/plugins/vfs/src/tools/generative-ui.ts:105-111` 有 `GenerativeUiExecutor.execute`，`vfs/index.ts:202` 经 `agentTools.registerToolExecutors` 注册；main 上无该实现。候选合入 main 后按真实注册入口移植。被测对象（L13/C1 执行器 +
L06/L10/L18/L19 的 chat_v2/VFS/notes/media 服务）均未发布。

### 7.3 L20 冲突解决 / 快照回退命令（4 条，WP-114 已解除）

`p2_3_resolve_fast_path_business_row_recheck_now_in_transaction_source_lock`、
`r12_fast_path_matching_state_still_marks_resolved`、
`r12_fast_path_concurrent_local_edit_is_rejected_in_transaction`、
`r11_resolve_command_snapshots_and_new_commands_browse_and_rollback`：
main `4dc4c8ed9` 的 `host/plugins/sync/index.ts:219-221` 已真实注册
`data_governance_resolve_record_conflict` / `data_governance_rollback_sync_snapshot_batch`，
4 行 TESTMAP 为 `ported:`。WP-114 把两个 live 文件改为真实 F3 storage
（`openFile(plain)`，busy_timeout=5000，对应 `open_sync_connection`）、真实 L21 备份许可
（对应 `BACKUP_GLOBAL_LIMITER`）、经 L20 `applyDownloadedChangesWithConflictGuard`
制造冲突（不手写冲突行），竞争窗口由 worker 线程上的第二个 SQLite 连接
`BEGIN IMMEDIATE` + 1.5s 后提交复现（与 Rust 写线程相同）。P2-3 保留源码结构锁，
并在同一用例里追加运行时语句轨迹（事务外快照读 → 单个 immediate 事务内 generation 重验 →
业务行重读 → `UPDATE __sync_conflicts SET resolved_at`）。

以下为旧基线 `2ee9a9cbe` 时的历史记录，不再成立：
`p2_3_resolve_fast_path_business_row_recheck_now_in_transaction_source_lock`、
`r12_fast_path_matching_state_still_marks_resolved`、
`r12_fast_path_concurrent_local_edit_is_rejected_in_transaction`、
`r11_resolve_command_snapshots_and_new_commands_browse_and_rollback`：
`main` 的 L20 插件（`host/plugins/sync/index.ts`）尚未包含候选注册。L20 候选实现
提交 `340e81ada`、候选分支 `c215cad2b` 的 `host/plugins/sync/index.ts:73-74`
声明 `data_governance_resolve_record_conflict` /
`data_governance_rollback_sync_snapshot_batch`，`:181-183` 通过
`ctx.commands.register(...)` 真实注册这两个命令；实现与命令壳在
`host/plugins/sync/src/conflict-commands.ts`、`src/mutation-commands.ts`，
`contracts/ipc/L20-sync.json` 仍声明它们。因此状态是“候选已注册、待正式集成”，
不是 owner 尚未注册；main 到位前不提前记 `ported`。
作业 `20261104074740-f10f19` 退出码 1，精确错误：
`data_governance_resolve_record_conflict not allowed. Command not found`；
同作业 `sync-r12-locks` 29/29 通过，排除宿主装配问题。
两个测试文件逐字保存在 `blocked/sync-conflict-fast-path.test.ts.txt` /
`blocked/sync-history-e2e.test.ts.txt`，恢复步骤见 `blocked/README.md`；
TESTMAP 如实保持 pending，不冒充 ported/merged。main 到位后仅恢复原逐字文件并跑
该最小集，不修改断言、不复制命令实现，也不重跑未变化的 269 用例全目录。
自动质量反馈看到的 `deleted-test` 即此有意阻塞：`blocked/` 副本的 `expect(` 数量仍为
7 / 8，TESTMAP 上述 4 行均为 `pending`，没有 `ported:`/`merged:` 指向已删除文件，
不存在虚报。

### 7.4 `tests/tool_pack_integration_tests.rs`（14 条）

`tool_pack_harness_constructs_execution_context`、
`tool_pack_selected_real_subtools_shared_state_audit_matches_allowed_paths`、
`tool_pack_executes_real_builtin_tools_and_returns_one_aggregate`、
`tool_pack_mixed_success_failure_preserves_successful_results`、
`tool_pack_vfs_write_load_does_not_surface_sqlite_busy_or_database_locked`、
`tool_pack_repeated_vfs_write_load_remains_free_of_sqlite_lock_errors`、
`tool_pack_rejects_empty_tools_array`、`tool_pack_rejects_unknown_specific_tool_before_execution`、
`tool_pack_rejects_recursive_subtool`、`tool_pack_rejects_more_than_20_subtools`、
`tool_pack_rejects_ask_user_no_timeout_subtool`、
`tool_pack_executes_subtools_concurrently_and_respects_max_concurrency`、
`tool_pack_deadline_cancels_only_unfinished_subtools`、
`tool_pack_parent_cancellation_preserves_completed_results`：
L06 只发布常量与 admission gate（`host/plugins/agent-orchestration/src/tool-pack.ts`，
导出 `createSubContext`/`canHandleToolPack`/`MAX_SUB_TOOLS`），没有
`ToolPackExecutor.execute`；L19 的 `AgentToolExecutorRegistry` 是普通执行器注册表，
不是 Rust `ToolPackExecutor` 的并发/取消/超时/聚合语义。L07 的
`registerToolExecutors` 已在 main，同样不能替代被测对象。

### 7.5 `tests/tools_integration_tests.rs::test_tool_error_details_generation`（1 条）

L19 本轮已发布 `mcp` 服务，`ctx.mcp.registry.callTool` 可调用；其余 3 条注册表测试
已移植到 `tests/tools-registry.test.ts`。但本用例读取 Rust 7 元组的第 7 项
`ErrorDetails`，并断言 `ToolNotFound`、message 含工具名、suggestions 非空且首项
`action_type=settings`。Host `ToolRegistry.callTool` 只返回 6 元组，没有
`call_tool_with_details`；F4 虽有 `ErrorDetailsBuilder.tool_not_found`，但 L19
registry 未接它。缺的是 registry 的错误详情输出，不能用 F4 builder 单测冒充，保持 pending。

### 7.6 `tests/windows_shell_helper_e2e.rs`（1 条）

`helper_consumes_only_fixed_root_payload_and_executes_with_rewritten_temp`：
L05 已在 `host/plugins/agent-workspace/src/tools/shell-sandbox-windows.ts` 实现
`payloadRoot`（:180）、`readWindowsPayload`（:366，含授权根校验、一次性消费）与
`HELPER_ARG`（:17），但 `api.ts` 未导出这些符号，L22 不能 import 其他 lane 的 `src/`。
Electron 主进程也尚未接线 helper 入口（Rust 测试通过 `CARGO_BIN_EXE_deep-student`
+ helper 参数启动独立进程），因此无法在 L22 侧复现同一 e2e。属 L05 发布面阻塞。

### 7.7 delta inventory（6 条，已批准 obsolete）

`r12_inventory_roundtrip_small_staging`、`r12_zero_change_reuses_everything_except_manifest`、
`r12_sqlite_row_change_marks_only_that_file_upload_new`、`r12_diff_marks_deleted_paths`、
`r12_logical_path_traversal_and_overlong_are_rejected`、
`r12_staging_with_backslash_filename_or_symlink_fails_closed`：
已获批准 `obsolete:dead-in-rust experimental`，不再计入 pending；证据见 §6.2 与
[`OBSOLETE-REQUEST-delta.md`](OBSOLETE-REQUEST-delta.md) §4。

## 8. 质量自查修复点

1. **时间格式统一 F4。** `src/app-state.ts` 的临时会话驱逐不再用本地 chrono 正则，
   改为 `host/platform/time::parseRfc3339(...).epochNanos` 比较；同刻回退仍用
   `Buffer.compare`（Rust `String` 的 UTF-8 字节序）。`tests/app-state.test.ts` 保留
   纳秒精度用例。
2. **服务描述符与命名。** `api.ts` 发布
   `appCommandStateService = { name: 'appCommandState', version: '1.0.0' }`；
   `index.ts` 的 `meta.provides` 用静态字面量 `['appCommandState']`（能力目录生成器只能
   静态读取字面量），`AppCommandStateService` 构造器使用描述符 `.name`；
   Cordis `declare module` 同步声明 `ctx.appCommandState`。
3. **L20 RowSync fail-close 适配。** main 合并后 L20 对未注册表 fail-close，
   `tests/sync-history-behavior.test.ts`、`sync-chaos-clock.test.ts`、
   `sync-history-e2e.test.ts` 的测试表 `items` 改为已注册的 `resources`，继续调用
   L20 生产 `applyDownloadedChanges*` / history 实现。
4. **不复制其他 lane 实现。** 已删除 `src/provider-probe.ts`、`src/template-rules.ts`、
   `src/model-adapters.ts`；模板/探活/适配器默认值分别由 L16/L02 生产实现持有。
5. **不空吞日志。** L22 生产代码没有 `catch { void 0 }`/`catch (e) { void e }`；
   `strict` 扫描 0 违规。delta 测试的失败注入由测试夹具抛出明确错误。
6. **测试接入生产路径。** 155 条 ported 全部经 `migration:wiring -- --lane integration`
   检查为 0 未接入；新增 delta 测试直接调用 L23 `api.ts`，不访问 L23 内部副本。
7. **插件能力目录自检。** `node scripts/plugin-catalog/generate.mjs` 显示
   `appCommandState` 的提供方为 `dstu.integration`；唯一相关问题是
   “已提供，但没有任何插件在运行时消费它”。实际消费点是
   `host/platform/storage/index.ts:124` 的 `ctx.get('appCommandState')`，但平台代码
   没有 Cordis `inject` 元数据，生成器看不到消费方。该项属 F3/协调者元数据修复，
   不在本 lane 修改范围内；L22 已在 `SPEC.md` 记录消费契约。
8. **可擦除语法（Node 原生类型擦除）。** 本 lane 不使用构造函数参数属性、非 `declare`
   enum 或带实现的 namespace；`memory-cloud.ts` 的 `MemoryCloud`/`FlakyResumableCloud`
   与 `delta-backup-v2.test.ts` 的 `FailingPutStorage` 已改为显式字段声明 + 构造函数赋值
   （`super()` 之后）。`node scripts/electron-migration/importable.mjs
   host/plugins/integration/index.ts` 返回 `importable: ok`。
9. **F4/F7 平台模块复查。** `host/platform/time`、`util`、`net-policy`、`errors`
   已合入 main；L22 的时间解析已改用 F4。`util`/`net-policy` 在 L22 没有新的重复实现。
10. **merged 目标逐条审计。** 27 条 `merged` 中 19 条断言组/生产调用同义；8 条
    delta 目标只覆盖部分断言，按 quality §10 先降回 pending 并记录缺口（§4.1），
    不用“文件存在”冒充完成。协调者随后批准 49 条 delta ID obsolete，14 条 delta
    merged 转 obsolete，4 条非 delta merged 保留；当前 TESTMAP 155 ported / 4 merged /
    53 obsolete / 31 pending（Codex 2 条解除后为 157 ported / 29 pending）。

## 9. 跨 lane 依赖与真实阻塞

1. **L20-sync / L23-sync-providers**：L23 已发布 delta format/upload/restore/GC
   与 `CloudStorageBase`/`CloudSyncManager`；本 lane 已在 `tests/delta-backup-v2.test.ts`
   移植 21 条 delta 行为测试，并把 13 条 descriptor 契约与 1 条单文件变更并入 L23
   同名测试。质量 §10 审计发现的 8 条弱 merged 目标已先降回 pending；43 条行为测试
   + 6 条 inventory 随后获批准 `obsolete:dead-in-rust experimental`（见 §6.2）。
   L20 的记录级 API 已在 main 发布（`downloadChanges` /
   `uploadEnrichedChanges` / `uploadManifest` / `validateRemoteFormat` / apply），
   本 lane 已交付 7 条 record-path、1 条 format gate 与 10 条 R10 混沌；剩余 4 条
   依赖的 `data_governance_resolve_record_conflict` /
   `data_governance_rollback_sync_snapshot_batch` 未被 main 的 L20 插件注册，
   逐字保存在 `blocked/`（见 §7.3）。
   L23 `delta_upload.ts` 文件头仍写着 “Not wired: no Tauri command/UI/sync_manager
   production entry point”；`api.ts` 已导出这些符号，wiring 机械检查视为可达，
   但生产同步命令仍未调用 delta 发布/恢复。按协调者指令，这类“符号可达但生产未用”
   不构成迁移证据；零接线审计与已批准的 obsolete 记录见
   [`OBSOLETE-REQUEST-delta.md`](OBSOLETE-REQUEST-delta.md) 与 §6.2。
2. **L02-llm-manager**：Qwen/MiMo 方言已在 L02 修复，2 条测试本轮移植；
   Codex OAuth 两条已在 L02 改用 `llmCodexAuth` 后经 `test_api_connection` 移植。
3. **L01-llm-providers**：L01 已合入 main 并发布 `llmCodexAuth`
   （`provides` 含该服务）；L02 已消费该服务，Codex 两条不再 pending。
4. **F3-storage**：`queuePersistableSafUri` 已实现，content:// persist 用例已由本 lane
   `tests/android-saf.test.ts` 直接移植（3 条断言），F3 另有更强覆盖；
   `extract_extension`/`is_opaque_document_id`/`sanitize_file_name_for_fs`
   仍缺，4 条 mobile-only 已获批准并写入 `migration/approvals.json`。
5. **L21-backup-governance**：`build_inventory_cross_checked` 未发布（`backup/api.ts`
   无 inventory 符号）；6 条 delta inventory 已随零接线审计获批准 `obsolete`，
   不再计入 pending。L21 已合入 main，`tryAcquireOperation` /
   `acquireOperation(kind, timeoutMs)` / 必需 `release()` 已可用；autosync mutex
   1 条已用真实许可交付，不再 pending。
6. **L13/C1、L06、L19**：9 条 generative UI executor 属 L13/C1 执行主链；
   L06 已合入 main，但 `src/tool-pack.ts` 仍只有常量/admission，没有
   `ToolPackExecutor.execute`；L19 的 `mcp` 服务已由 `dstu.mcp` 提供，
   3 条工具注册表 + `run_all_core_tests` 已交付，仅剩
   `test_tool_error_details_generation`（缺 `call_tool_with_details`）1 条。
   合计 9 + 14 + 1 条 pending。L07 `registerToolExecutors` 已在 main，但不是
   `ToolPackExecutor` 的并发/取消/超时/聚合语义。
7. **L05-agent-workspace**：1 条 Windows shell helper pending。L05 已合入 main，TS 实现
   在 `src/tools/shell-sandbox-windows.ts`（`payloadRoot`/`readWindowsPayload`/`HELPER_ARG`），
   但 `api.ts` 未导出，Electron 主进程也未接线 helper 入口；L05 自己的 BLOCKERS.md
   也把 Windows 原生执行列为 F7 未发布能力。
8. **F4/L19 组合冒烟**：`run_all_core_tests` 已由
   `tests/tools-registry.test.ts` 交付：F4 `ErrorDetailsBuilder.api_key_missing`
   与 L19 `mcp.registry` 的真实安装/调用均已覆盖；不再 pending。
9. **已确认不再等待的上游能力**：F3 切槽（`DataSpaceService`/cutover）与 F4 设备身份
   （`paths.deviceId()`/`rotateDeviceIdAfterRestore`）已在 main 可用，本 lane 的切槽/身份
   用例已迁移，不再归因 L11；L07 `registerToolExecutors` 也已在 main，但它不是
   `ToolPackExecutor` 的并发/取消/超时/聚合实现，故 14 条 tool pack 仍归 L06。

## 10. 完成协议输出（原样）

2026-11-04 在 Linux 工作树重新运行，原样输出：

```text
$ job 20261104080004-05dd85  npx tsc -p tsconfig.host.json
退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104080004-05dd85.log

$ job 20261104080004-ada020  npx vitest run -c vitest.host.config.ts host/plugins/integration
 Test Files  29 passed (29)
      Tests  269 passed (269)
退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104080004-ada020.log

$ job 20261104080004-aa9e0b  npm run migration:ledger -- --check --no-write
ledger: commands 1058 (A 92% B 7.2% C 0%), tests 8036 (A 78.3% B 1.5%); problems: commands 0, tests 0, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）
退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104080004-aa9e0b.log

$ job 20261104080004-34084f  npm run migration:wiring -- --lane integration
合计 ported 155，其中所测模块未从 index.ts 接入 0（0.0%）
退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104080004-34084f.log

$ job 20261104075414-6568d3  node scripts/electron-migration/importable.mjs host/plugins/integration/index.ts
importable: ok
退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104075414-6568d3.log

$ job 20261104080004-f8b069  npm run migration:boundaries:strict
boundaries: scanned 2282 files, 4 violation(s) {"empty-catch":3,"console-log":1}, 181 suppressed via boundary-allow; rules: native-import, tauri-import, cross-plugin-impl, electron-imports-plugin, sql-outside-repository, test-double, todo-marker, empty-catch, erasable-syntax, console-log
退出码 1；4 条违规均在 host/plugins/vfs/，L22 0 条非允许违规
完整输出 /home/dsdev/.oc-jobs/done/20261104080004-f8b069.log

$ node host/plugins/integration/tests/command-audit.mjs --check
{"undefined":50,"uncalledDefinitions":290,"dispositions":{"retain-frontend-referenced":143,"candidate-needs-coordinator-approval":115,"retain-production-referenced":28,"demo-only":1,"test-only-referenced":3}}
```

`migration:ledger` 退出码 0：全局与 L22 均为 0 条 problem。
全局 strict 的 4 条违规全部在 `host/plugins/vfs/`，本 lane 0 条非允许违规。

## 11. Rust 契约问题与语义歧义（只记录，不在本 lane 修改 Rust）

1. **`qbank://changed` 两种载荷**：五处 `{exam_id, reason}`，但
   `qbank_update_material`（`commands.rs:1442-1449`）发
   `{reason:"material_updated", material_id}`，没有 `exam_id`。已记录在 `SPEC.md`；
   迁移保留原形状，除非协调者决定修 Rust 契约。
2. **`rename_exam_sheet_session` 的 `None` 语义与注释相反**：
   `commands.rs:991-992` 注释说“None 表示不改名”，代码却 `unwrap_or_default()`
   成 `Some("")`；服务以 `exam_name.is_some()` 判断是否改名、空串表示清空
   （`dstu-vision/src/exam_sheet_service.rs:334,791-795`）。缺省 `exam_name` 会清空名称。
3. **inventory 的 `frontend` 列假阴性**：只匹配字面量 `invoke('cmd')`，漏掉 143 个包装器调用。
4. **292 与实时 inventory 不一致**：当前 1066 个定义，`frontend:"none"` 294 个定义、
   290 个不同名字；测试改为与实时集合比较，不再硬编码。
5. **50 个未定义调用包含测试专用项**：`write` 只在
   `src/features/notes/noteHostCoordinator.lease.test.ts` 出现。

## 12. 提交

本轮 delta 移植与文档收口由协调者自动检查点提交（`b2e2ef0e0` 包含本文件、LANE、SPEC
与 TESTMAP 的最终版本；此前 `b3ddf81d5` 包含 delta 测试、Qwen/MiMo 测试与 TESTMAP 更新）。
本 lane 另有一个显式提交：

- `d6fcd1176` test(integration): correct delta fixture boundary-allow reason

2026-11-04 Linux 复验后补记：`migration/approvals.json` 已包含 4 条 mobile-only 批准，
本文件、`LANE.md` 与门禁输出按复验结果更新（提交 `fd3458874`）。
同日再次 merge main（L03/L05/L06/L07/L10/F2/F4）并复跑全部门禁，输出更新见 §2/§10。

2026-11-04 协调者指令后新增：

- `7371ac581`（自动检查点）：`OBSOLETE-REQUEST-delta.md`，delta 43 条行为测试
  `obsolete` 申请与证据。
- `e3e715442`（自动检查点）：main 合并后 L23 新增 `paths` 注入，修复
  `sync-r12-locks.test.ts` / `webdav-contract.test.ts` 测试宿主的 `paths.deviceId`
  夹具；同提交包含 REPORT 的归属更新中间版本。
- 此前文档提交：重新归属当时 56 条 pending、记录 L20 分支 API 与 8 条 scratch 验证结果、
  更新门禁输出（249 用例 / wiring 156/0）。
- 连续 merge main：`5153b09b9`（`d1b03dff9` 架构裁定 D1–D6）、
  `f7c6231d2`（`16c9d1c35` F1 kernel）、`fbfb33f96`（`e30395712` F2 shell）。
  合并后复验 typecheck 0、249 用例全绿、wiring 156/0、L22 boundaries 0、
  **`migration:ledger --check --no-write` 退出码 0（全局与 L22 均 0 problem）**。
- 2026-11-04 quality §10 `merged` 审计：27 条中 19 条保留（13 delta format + 1 delta
  upload + 5 条非 delta），8 条 delta 弱目标降回 pending；审计中间态为 156 ported /
  19 merged / 4 obsolete / 64 pending。自动检查点 `c64a20d46` 已包含 TESTMAP /
  REPORT / OBSOLETE-REQUEST 主体；`ac8636c8e`、`d158e01b3` 补齐 LANE 与门禁输出。
- main `294cbe65f` 批准 43 条 delta 行为测试 + 6 条 inventory
  `obsolete:dead-in-rust experimental`；本 lane 按批准把 49 条 TESTMAP 行改为
  `obsolete`（14 merged + 21 ported + 8 pending + 6 inventory pending），保留 5 条
  source-lock ported。当时 135 ported / 5 merged / 53 obsolete / 50 pending，
  A = 193/243 = 79.4%；`tests/delta-backup-v2.test.ts` 仍保留运行。
- 最新 main 合并：`b50dbba99`（`11b57346f`）、`2295571c3`（`2a2ba05b2`，含 C1/C2
  与 delta 批准）、`0a09f902b`（`15b23540a`，F2 shell）、`99ec7d18e`
  （`9c13dfc39`，L11 vfs-repos）。合并后复验 typecheck 0、24 文件 / 249 用例全绿、
  wiring 135/0、importable ok、L22 boundaries 0、ledger 退出码 0
  （tests A 77.2% B 1.4%）。

2026-11-04 续跑（L20/L21/L19 发布面到达后）：

- merge `14c53a53d` 后交付 L20 record-path 7 + format gate 1 + R10 混沌 10、
  L21 autosync mutex 1、L19 工具注册表 3 + `run_all_core_tests` 1；4 条依赖
  `data_governance_resolve_record_conflict` / `rollback_sync_snapshot_batch`
  的用例逐字移入 `blocked/`（作业 `20261104074740-f10f19` 退出码 1，精确错误
  `data_governance_resolve_record_conflict not allowed. Command not found`）。
- 显式提交：`332ce4f04`（L21 守卫测试替身 + blocked 状态）、`c6a0c363c`
  （移除 blocked 的 live 文件）、`c7892dd2a`（L19 工具注册表 4 条）。
- 最终门禁：typecheck `20261104080004-05dd85` 退出码 0；全量
  `20261104080004-ada020` 29 文件 / 269 用例退出码 0；ledger
  `20261104080004-aa9e0b` 退出码 0（tests A 78.3%）；wiring
  `20261104080004-34084f` ported 155 / 未接入 0；importable
  `20261104075414-6568d3` ok；boundaries `20261104080004-f8b069` 仅 4 条
  `host/plugins/vfs/` 全局违规，L22 0 条非允许违规。
  TESTMAP 155 ported / 4 merged / 53 obsolete / 31 pending，A = 212/243 = 87.2%。

早前提交见 `git log --oneline ds-mig/L22-app-commands`。
