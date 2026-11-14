# F3-storage 等价场景 v1：G3 命令语料（WP-236）

本目录只放 WAVE0 §3 v0 场景源文件，不含答案。A（Tauri+Rust）是答案机，B（Electron 宿主）重放后交给比较器。**本包没有执行任何 A/B 重放，没有命令因此达到 C 级。**

| 文件 | 场景 | 步骤 | 状态 |
|---|---|---|---|
| `llm-usage.json` | 23 | 90 | 可运行（seed `empty`） |
| `staged-upload.json` | 10 | 29 | 可运行 |
| `data-space.json` | 8 | 20 | 可运行 |
| `startup-recovery.json` | 15 | 48 | 可运行 |
| `test-database.json` | 12 | 36 | 可运行 |
| `g3w-storage-01.json` | 10 | 20 | 可运行；WP-270 错误分支，见 §5 |
| `needs-restart/restart-app.json` | 2 | 4 | 等运行器支持进程重启，见 §3 |
| `llm-usage.seeded.json` | 4 | 21 | 可运行；种子 `f3-llm-usage-rows-w0`（规格 `f3-llm-usage-rows-w0.sql`，W21 `slot-seeds.ts`） |
| `pending-seed/startup-recovery.seeded.json` | 5 | 17 | 种子 `f3-startup-recovery-incident-w0` 已实现（W21）；恢复模式下 Host 未注册 `vfs_set_indexing_config`，运行器准备步骤失败，等 W13，见 §2 |
| `data-space-inactive.seeded.json` | 1 | 4 | 可运行；种子 `f3-inactive-slot-data-w0`（W21 `slot-seeds.ts`），见 §2 |

可运行部分：68 个场景、223 步，其中 94 步标 `expect:"error"`。全部 9 个文件合计 80 个场景、269 步、96 个 error 步。所有场景 `capture {events:true, db:["*"]}`、`normalize: []`。`expect:"error"` 只是注释，判定以 A 的实际结果为准；没有写任何期望返回值。`needs-restart/` 和 `pending-seed/` 不放在顶层，避免运行器遇到未知 seed 或进程退出。

## 1. 运行器约定（交 X7 确认）

1. `${n.path}` 是整串引用，n 为同场景内 0 起的步骤下标，只引用更早且未标 error 的步骤，替换为原始 JSON 值。本目录用到的引用：`${0.uploadId}`、`${0.production_db_path}`（`get_database_info`）、`${0.slot_c_dir}` / `${0.slot_d_dir}`（`get_test_slot_info`）、`${0.incident.incident_id}`（`get_startup_recovery_status`）。
2. 不带参数的命令写 `args: {}`。Tauri 忽略多余键，`data_space.info.ignores_extra_args` 用来确认 B 也忽略。
3. **文件系统路径。** 场景只写三类路径：(a) 由命令返回、位于 runner 隔离数据目录内的路径（slot C/D 目录、`production_db_path`）；(b) 本机固定存在、只读的系统路径 `/etc/hostname`、`/etc`、`/dev/null`、`/`；(c) 不存在的路径（`/nonexistent-wp236/…`、`/tmp/.wp236-hidden/…`、`/dev/null/wp236/…`）。没有写相对路径（相对路径会落到 runner 的 cwd，不在隔离目录内）。A 与 B 在同一台机器上跑，(b) 类文件内容相同。写入只发生在 (a) 类路径和 `/dev/null`。
4. **数据库捕获看不到的状态。** 本域很多命令的副作用在文件系统上，不在 SQLite 里：`slots/state.json`（pending）、`.purge_on_next_start`、`slots/slotC|slotD`、`$APPCACHE/staged_uploads/*.part`、`recovery/`。场景都在写之后用读命令回读（`get_data_space_info`、`get_test_slot_info`、`get_database_info`、`get_startup_recovery_status`、`list_startup_recovery_incidents`）。建议运行器另外记录数据目录的**文件名集合**（不记录内容），交 X7/X3 决定。
5. 这些命令在 Rust 中都不发事件（`data_space.rs:2169-2614`、`staged_upload.rs:461-514`、`llm_usage/handlers.rs`、`commands.rs:7169-7432` 无 emit）。`events:true` 用来确认 B 也不发。
6. **可能需要 C2 裁定的已知差异（不预先规范化）：**
   - `llm_usage_session_summary`：Rust `repo.rs:464` 查询不存在的 `caller_id` 列（V20260130..V20260826 都没建这列），A 会对每次调用返回 SQL 错误；B 按 G1 修复 `9950032f6` 查 `session_id`。成功场景按前端意图写，A/B 结果不同是已知裁定，由 C2 在差分里登记。
   - `export_startup_recovery_report` 返回内容含 `generated_at`（`Utc::now().to_rfc3339()`，纳秒精度）；本包只断言命令结果字符串（目标路径），报告文件内容不在 capture 范围。
   - `llm_usage_summary` 在空库且没有可解析日期时，`start_date`/`end_date` 取 `Utc::now()`（`repo.rs:417-418`）。是否规范化等 A1/A2 双录后决定。

## 2. 命令、调用点与分支

Rust 路径相对 `src-tauri/`，`ds.rs` = `crates/dstu-storage/src/data_space.rs`，`lu.rs` = `crates/dstu-storage/src/llm_usage/handlers.rs`，`repo.rs` = `crates/dstu-storage/src/llm_usage/repo.rs`，`su.rs` = `crates/dstu-storage/src/staged_upload.rs`，`ufm.rs` = `crates/dstu-storage/src/unified_file_manager.rs`。B 端注册点全部在 `host/platform/storage/index.ts`。

所有带参数的命令都有一个共同的错误分支：IPC 参数反序列化失败（缺键、类型错误、snake_case 键名、u32 越界/负数/小数）。表中写作"serde"。

### 2.1 在768 = 是（21 条）

| 命令 | 前端 | Rust | 成功场景 | 错误场景 | 未覆盖分支与理由 |
|---|---|---|---|---|---|
| `clear_test_slots` | `src/utils/systemApi.ts:210` | `ds.rs:2598`，`SlotManager::clear_test_slots ds.rs:1936` | `data_space.test_slots.clear_creates_both`（首次创建 C/D，再次删除重建） | `data_space.test_slots.clear_fails_when_slot_is_file`：先用 `export_startup_recovery_report` 把 slotC 路径写成普通文件，`remove_dir_all` 失败 → `清空测试插槽失败: …`（`:2603`） | 管理器未初始化（`:2600`）：启动后总是已初始化，不可达 |
| `export_startup_recovery_incident` | `src/features/data-recovery/dataRecoveryApi.ts:139` | `ds.rs:2231` | 需种子：`pending-seed/startup-recovery.seeded.json` `recovery.seeded.status_list_export`（ZIP 写到隔离 slotD 路径，二次导出走 `.zip.previous` 替换） | `recovery.export_incident.invalid_or_missing_id`：id 为空/`..`/含 `/` → `恢复事件 id 无效`；不存在 → `恢复事件目录不存在`（都包成 `定位恢复事件目录失败`，`:2237`）；虚拟 URI 目标也先失败在定位上。serde：`recovery.export_incident.arg_errors` | 越界（`:333`，需要 incidents 下的符号链接）、staging/ZIP 写入失败、`spawn_blocking` Join 错误：需故障注入或特殊种子。虚拟 URI 成功路径仅移动端 |
| `export_startup_recovery_report` | `dataRecoveryApi.ts:151` | `ds.rs:2269` | `recovery.export_report.dev_null`；`recovery.export_report.into_isolated_slot_path`（写到不存在的 slotD 路径，覆盖写第二次） | 目标是目录 → `写入诊断报告失败`（`recovery.export_report.destination_is_directory`，含 `/`）；父路径不是目录 → `创建诊断报告目录失败`（`parent_not_directory`）；`content://` → staging 后 `写入目标位置失败`；双重编码 URI → `reject_double_encoded_virtual_uri`（`virtual_uri`）；serde（`arg_errors`） | `state.status()` 锁损坏（`:2290`）、`to_vec_pretty` 失败：不可达 |
| `get_data_space_info` | `src/utils/systemApi.ts:164` | `ds.rs:2493` | `data_space.info.fresh`、`ignores_extra_args`，并在 mark/purge 场景回读 | 无可达错误 | 管理器未初始化：空种子不可达，恢复模式种子下可达，见 §5；`read_state` 在 state.json 和 .tmp 都坏时回退到目录推断并返回 Ok（`ds.rs:1345-1355`），`读取数据空间状态失败` 不可达 |
| `get_test_slot_info` | `systemApi.ts:202` | `ds.rs:2576` | `data_space.test_slots.info_fresh`；C/D 不存在、为目录、为普通文件（`read_dir` 失败计 0）三种状态都在场景里 | 无可达错误 | 管理器未初始化：空种子不可达，恢复模式种子下可达，见 §5 |
| `llm_usage_by_caller` | `src/api/llmUsageApi.ts:108`（调用 `LlmUsageStatsPage.tsx:128`） | `lu.rs:39`，`repo.rs:327` | `llm_usage.by_caller.empty_ranges`（常规、单日、倒置、空串、非法日期字符串，均为字符串比较）；需种子：`llm_usage.seeded.aggregates`（覆盖 `CallerType::from_str` 已知值/`other:`/裸未知） | serde：`llm_usage.by_caller.arg_errors` | `get_conn_safe` 失败、SQL 错误：空种子不可达 |
| `llm_usage_by_model` | `llmUsageApi.ts:105` | `lu.rs:29`，`repo.rs:285` | `llm_usage.by_model.empty_ranges`；种子：`seeded.aggregates` | serde：`by_model.arg_errors` | 同上 |
| `llm_usage_cleanup` | `llmUsageApi.ts:124` | `lu.rs:89`，`repo.rs:553` | `llm_usage.cleanup.empty_db`（返回 0，回读 summary）；种子：`seeded.cleanup`（删除部分行、再次删除返回 0） | serde：`cleanup.arg_errors` | 同上 |
| `llm_usage_daily` | `llmUsageApi.ts:121` | `lu.rs:79`，`repo.rs:567` | `llm_usage.daily.empty_ranges`；种子：`seeded.aggregates` | serde：`daily.arg_errors` | 同上 |
| `llm_usage_get_trends` | `llmUsageApi.ts:102`（`LlmUsageStatsPage.tsx:126`） | `lu.rs:11`，`repo.rs:228` | `trends.granularities`（hour/day/week/month）、`unknown_granularity_defaults_day`（`year`、`Day`、空串回落 day，`lu.rs:22`）、`days_bounds`（0 与 u32::MAX）；种子：`seeded.trends`（含 `first_ts` 非 RFC3339 → timestamp 0） | serde：`trends.arg_errors`（缺键、-1、2^32、1.5、`"30"`、granularity null/数字） | 同上 |
| `llm_usage_recent` | `llmUsageApi.ts:118`（`LlmUsageStatsPage.tsx:129`） | `lu.rs:70`，`repo.rs:482` | `recent.limits`（20、缺省=50、null=50、0、u32::MAX）；种子：`seeded.recent_and_session`（含非 RFC3339 时间戳的 epoch 回退 + warn，`repo.rs:509-518`） | serde：`recent.arg_errors` | 同上 |
| `llm_usage_session_summary` | `llmUsageApi.ts:115` | `lu.rs:61`，`repo.rs:451` | `session_summary.empty`（不存在的 id、空串、引号与中文）；种子：`seeded.recent_and_session` | serde：`session_summary.arg_errors` | A 端 `repo.rs:464` 引用不存在列，每次都是 SQL 错误，见 §1.6 |
| `llm_usage_summary` | `llmUsageApi.ts:111`（`LlmUsageStatsPage.tsx:125`） | `lu.rs:49`，`repo.rs:368` | 四种 where 分支：`summary.both_dates`、`only_start`、`only_end`、`no_dates_empty_db`；`parse_date_boundary` 失败回落：`unparseable_dates_fall_back`（含 2026-02-30）；闰日 2024-02-29；种子：`seeded.aggregates`（first/last timestamp 回落、avg 计算） | serde：`summary.arg_errors` | 同上 |
| `mark_data_space_pending_switch_to_inactive` | `systemApi.ts:181` | `ds.rs:2523`，`mark_pending_switch ds.rs:1798` | 需种子：`data-space-inactive.seeded.json`（非活动槽有数据） | `data_space.mark_pending.inactive_missing`：空种子下 slotB 不存在 → `标记切换失败: 目标插槽目录不存在…`（`:1801`） | "目录为空"分支（`:1807`）需要空的 slotB 目录，见 §2.3 种子说明；没有 IPC 能创建 slotB |
| `open_startup_recovery_incident_folder` | `dataRecoveryApi.ts:128` | `ds.rs:2197` | 需种子：`recovery.seeded.open_folder`（会在 A/B 宿主上 spawn `xdg-open`，运行器需在 Xvfb 下允许或替换 `xdg-open`） | `recovery.open_folder.invalid_or_missing_id`（空、`.`、`..`、`/`、`\`、不存在）；serde | `spawn` 失败需要无 `xdg-open` 的环境；移动端分支不可达 |
| `purge_active_data_dir_now` | `systemApi.ts:252` | `ds.rs:2552` | **无成功路径**：Rust 无条件返回 `AppError::validation`（`:2553-2557`） | `data_space.purge_now.always_rejected` | — |
| `purge_all_database_files` | `systemApi.ts:240` | `ds.rs:2539`，`write_purge_marker startup_cleanup.rs:18` | `data_space.purge_all.writes_marker`（幂等写两次）；写入只发生在 runner 隔离数据目录根 | 无可达错误 | 写标记失败（`startup_cleanup.rs:21-25`）需要只读数据目录；实际清空发生在重启后，见 `needs-restart/` |
| `resolve_startup_recovery` | `dataRecoveryApi.ts:157` | `ds.rs:2478`，`StartupRecoveryState::resolve ds.rs:250` | 需种子：`recovery.seeded.resolve_legacy` / `resolve_slot_a` / `resolve_slot_b` | 候选 id 校验（`:2482`）：`recovery.resolve.invalid_candidate`（`slotC`、`Legacy`、空串、前导空格）；无事件 → `解决启动恢复事件失败: 当前没有待处理的启动恢复事件`（`recovery.resolve.no_incident`，三个合法 id 都走一遍）；解决后再次 resolve（种子场景）；serde | 解决过程中 IO 失败并写 `recovery_error`（`ds.rs:258-265`）需故障注入 |
| `restart_app` | `dataRecoveryApi.ts:177,181`，`systemApi.ts:214` | `ds.rs:2610` | `needs-restart/restart-app.json`（purge 标记后重启、pending 尝试后重启） | 无错误分支（返回 `()`） | 进程退出后运行器拿不到 IPC 结果，见 §3 |
| `staged_upload_abort` | `src/utils/stagedUpload.ts:70` | `su.rs:510` | `staged_upload.from_path.*` 中 abort 已登记 id（两次，幂等）；`abort.unknown_id_is_noop`（未知 id、空串） | serde：`abort.arg_errors` | `spawn_blocking` Join 错误不可达 |
| `staged_upload_from_path` | `stagedUpload.ts:123` | `su.rs:490`，`deny_hidden_local_path ufm.rs:441`，`stage_from_reader su.rs:367` | `/etc/hostname`、`/dev/null`（0 字节）、隔离数据目录内的 `production_db_path`（应用目录放行分支）、`file://` URL 与首尾空白 | 隐藏路径段（含 `..` 归一化后与 `%2E` 编码，`ufm.rs:487-497`）；不存在、空串、纯空白（`路径不能为空`）、双重编码 `content%3A…`；目录 `/etc` 读失败（`Failed to copy file into staging area`）；serde | 超过 200MB/4GB 上限（`su.rs:385`）需要大文件，未写；`Failed to create staged upload file` 与 `app_cache_dir` 解析失败需故障注入 |

### 2.2 在768 = 否（9 条，981 外延）

| 命令 | 前端 | Rust | 成功场景 | 错误场景 | 未覆盖分支与理由 |
|---|---|---|---|---|---|
| `get_database_info` | `src/utils/testApi.ts:97` | `src/commands.rs:7308` | `test_db.info.fresh`，并在切换/重置场景回读 | 无可达错误 | — |
| `get_startup_recovery_status` | `dataRecoveryApi.ts:107` | `ds.rs:2169` | `recovery.status.fresh`（`recovery_required:false`、无 `incident` 键）；种子：`recovery.seeded.status_list_export` | 无可达错误 | startup_gate 超时（`:2176`）、状态未注册（`:2184`）、锁损坏：启动完成后不可达 |
| `list_startup_recovery_incidents` | `dataRecoveryApi.ts:123` | `ds.rs:2469` | `recovery.status.fresh`（incidents 目录不存在 → `[]`）；种子场景回读 | 无可达错误 | `read_dir` 失败（`:2473`）需要不可读目录；坏 manifest 只 warn 跳过（`ds.rs:237-243`），需种子 |
| `reset_test_database` | `testApi.ts:83` | `commands.rs:7215` | `test_db.reset.while_production`（文件不存在与已存在两次）、`while_test_active`（重置后重新指向测试库）、`seed.then_switch_and_reset` | 无可达错误 | 删除/创建/切换失败需故障注入 |
| `retry_startup_recovery_preflight` | `dataRecoveryApi.ts:163` | `ds.rs:2190` | `recovery.retry_preflight.fresh`；种子：`seeded.status_list_export` 末步 | 无错误返回（失败折叠为 `startup_preflight` incident，`ds.rs:283-288`） | 需要 restart 类 `failed_operation` 的提前返回（`ds.rs:276-283`）只能由启动失败产生，需种子/故障注入 |
| `seed_test_database` | `testApi.ts:114` | `commands.rs:7330` | `seed.null_config`、`missing_config`、`partial_config`、`non_bool_and_non_object_config`（`"false"`、`0`、`[]`、`"all"` 都回落 true，`:7345-7360`）、`then_switch_and_reset`、`reset.while_test_active` | 无可达错误（`config` 是 `Option<Value>`，任何 JSON 都能反序列化） | 打开测试库失败、`seed_db` 返回 Err：需故障注入；`result.errors` 非空时的 error 日志只能人工审读 |
| `set_test_run_id` | `testApi.ts:118`（同时传 `test_run_id` 与 `testRunId`） | `commands.rs:7424` | `test_db.set_run_id.frontend_shape`（前端双键形状、空串、Unicode） | serde：`set_run_id.arg_errors`（只有 `test_run_id` 也算缺键） | — |
| `switch_to_production_database` | `testApi.ts:90` | `commands.rs:7276` | `test_db.switch_roundtrip`、`switch_production_without_test`；每个切到测试库的场景都以它收尾 | 无可达错误 | `switch_to_path` 失败需故障注入 |
| `switch_to_test_database` | `testApi.ts:76` | `commands.rs:7169` | `test_db.switch_roundtrip`（首次创建与复用现有测试库两次） | 无可达错误 | 创建目录/初始化/切换失败需故障注入 |

### 2.3 种子规格（owner：X3 `host/e2e/data-compat`）

种子名是提议；X3 实现后把对应文件移到顶层目录即可运行。场景里写的输入就是 A 的真实输入，不随种子实现方式改变。

- **`f3-llm-usage-rows-w0`**：`f3-llm-usage-rows-w0.sql`，5 行 `llm_usage_logs`，应用到"已启动过一次、已停止"的数据目录的 `llm_usage.db`。覆盖 CallerType 三种解析、success/error/其他 status、非 RFC3339 时间戳、NULL 费用与时长、`session_id`、跨 4 个 `date_key`。真实写入方是 chat 流水线的用量采集（`crates/dstu-storage/src/llm_usage/collector.rs`），走 IPC 需要模拟 LLM 服务（X5），所以改用 SQL 种子。
- **`f3-startup-recovery-incident-w0`**：在**未启动过**的数据根目录放一个旧版根目录条目（例如 `mistakes.db`，名称不是 `slots`/`logs`/`recovery`/`.purge_on_next_start`，`ds.rs:520-523`），同时让 `slots/slotB/` 非空（或 `slots/slotA/` 下有同名条目），且 `slots/` 下没有 legacy migration complete/pending 标记（`ds.rs:412-424`）。启动时 `prepare_startup_recovery` 会建 incident。这一状态不能经 IPC 产生。
- **`f3-inactive-slot-data-w0`**：已启动过一次的数据目录，`slots/state.json` 的 active 为 `slotA`，`slots/slotB/` 下至少一个条目（`dir_has_data`，`ds.rs:1401`）。用于 `mark_data_space_pending_switch_to_inactive` 成功分支。若再加一个"slotB 是空目录"的变体，可覆盖 `ds.rs:1807` 的"目录为空"错误。

## 3. 需要重启的命令

`restart_app` 调用 `AppHandle::restart()`，进程退出后重新启动，IPC 不会返回。`purge_all_database_files` 与 `mark_data_space_pending_switch_to_inactive` 的实际效果（清空、切槽）发生在下次启动的 `initialize_on_start`。`needs-restart/restart-app.json` 写出了输入，需要运行器支持"重启后在同一隔离数据目录继续执行并捕获终态"才能运行；在此之前它不计入覆盖。这些场景只在 runner 隔离数据目录下操作，不触碰真实数据目录。

## 4. 覆盖统计

- 30 条命令全部有场景。可运行目录中有成功场景的 24 条（在768 的 21 条中 15 条）。其余 6 条：`purge_active_data_dir_now` 在 Rust 中没有成功路径；`export_startup_recovery_incident`、`open_startup_recovery_incident_folder`、`resolve_startup_recovery`、`mark_data_space_pending_switch_to_inactive` 的成功场景已写在 `pending-seed/`，等 §2.3 种子；`restart_app` 已写在 `needs-restart/`，等运行器重启支持。
- 有错误场景的 18 条（在768 中 17 条），覆盖了空种子下所有可达的 Err/提前返回（含 serde）。没有可达错误分支的 12 条（在768 中 4 条：`get_data_space_info`、`get_test_slot_info`、`purge_all_database_files`、`restart_app`）已在表中逐条写明理由。
- 未运行 A/B 重放，未计 C 级。
- WP-270 另加 `staged_upload_begin`、`staged_upload_append` 的错误场景（`g3w-storage-01.json`，10 个场景、16 个 error 步），不计入上面 30 条命令的统计；6 条命令的逐分支判定见 §5。

## 5. G3 错误分支判定（WP-270）

范围：`get_data_space_info`、`get_test_slot_info`、`purge_all_database_files`、`restart_app`、`staged_upload_begin`、`staged_upload_append`。可达的业务 Err 写在 `g3w-storage-01.json`（场景 id 前缀 `g3w.storage.<命令>.<分支>`，seed `empty`，末步 `expect:"error"`）；其余分支逐条写不可达理由。路径缩写同 §2。

### 5.1 `staged_upload_begin`（`su.rs:446`，调用点 `src/utils/stagedUpload.ts:87`，参数 `{ name, totalSize }`）

| 分支 | 判定 |
|---|---|
| 参数反序列化（`name: String`、`total_size: u64`，`su.rs:448-449`） | `g3w.storage.staged_upload_begin.err_args_serde`：缺 `totalSize`、缺 `name`、`totalSize:-1`（u64 不接受负数）、snake_case `total_size` |
| `total_size > max_bytes` → `File too large: …`（`su.rs:225-226`，先于建目录） | `g3w.storage.staged_upload_begin.err_too_large`：`big.pdf` 200MB+1（`STAGED_UPLOAD_MAX_BYTES`，`su.rs:32`）、`lecture.MP4` 4GB+1（`MAX_MEDIA_IMPORT_BYTES`，`dstu-core/src/media_types.rs:62`）；输入取自 Rust 测试 `begin_enforces_size_limit`（`su.rs:556-579`） |
| `staging_dir` 解析失败 `Failed to resolve app cache directory`（`su.rs:369-373`） | 不可达：`app_cache_dir()` 在 Linux 只依赖 `XDG_CACHE_HOME`/`HOME`，runner 总是设置（`scenario-v0.mjs` `prepareScenarioRun`） |
| `Failed to create staging directory`（`su.rs:214-215`）、`Failed to create staged upload file`（`su.rs:230-235`，`create_new` 撞名） | 不可达：IO 故障；文件名是新 UUIDv4（`su.rs:229`），runner 缓存目录可写 |
| `Staged upload task failed`（`su.rs:458`） | 不可达：`spawn_blocking` Join 错误，只在任务 panic 时出现 |

### 5.2 `staged_upload_append`（`su.rs:461`，调用点 `stagedUpload.ts:97`（JSON `{ uploadId, offset, data }`）、`stagedUpload.ts:101`（`Uint8Array` + `x-upload-id`/`x-upload-offset` 请求头））

命令参数是整个 `Request`，没有 serde 反序列化错误；所有业务错误来自 `parse_append_request`（`su.rs:380-443`）与 `append`（`su.rs:250-289`）。

| 分支 | 判定 |
|---|---|
| JSON 对象缺 `uploadId`（`su.rs:403-406`） | `g3w.storage.staged_upload_append.err_missing_upload_id` |
| JSON 对象缺 `offset`（`su.rs:407-411`） | `g3w.storage.staged_upload_append.err_missing_offset` |
| JSON 对象缺 `data`（`su.rs:412-415`） | `g3w.storage.staged_upload_append.err_missing_chunk_data` |
| base64 解码失败 `Invalid chunk base64`（`su.rs:419-421`） | `g3w.storage.staged_upload_append.err_invalid_base64`（解码先于查表，未知 id 不影响该分支） |
| 字节载荷缺 `x-upload-id` 头（Raw `su.rs:393`；JSON 数组 `su.rs:425`） | `g3w.storage.staged_upload_append.err_bytes_without_upload_id_header`：args `[4,5,255]`（Rust 测试 `parses_raw_json_and_array_payloads` `su.rs:664`）。runner 的 invoke 不带 options（`tauri-harness.mjs:37`），自定义协议下数组以 octet-stream 发出走 Raw，postMessage 回退走 JSON 数组，两条路径都在第一步报 `Missing x-upload-id header` |
| 未知或已过期的 id（`su.rs:259-262`） | `g3w.storage.staged_upload_append.err_unknown_upload` |
| offset 不等于已接收字节（`su.rs:264-268`） | `g3w.storage.staged_upload_append.err_unexpected_offset`：空洞（offset 2）与重放（offset 0 两次），对应 Rust 测试 `rejects_out_of_order_and_oversized_chunks`（`su.rs:542-553`） |
| 超出声明大小，放弃上传并删文件（`su.rs:270-275`） | `g3w.storage.staged_upload_append.err_exceeds_declared_size`：末步再追加一次，确认 `abort` 已移除登记（同一 Rust 测试 `su.rs:550-552`） |
| `Invalid x-upload-offset header`（`su.rs:385-390`）、`Missing x-upload-offset header`（`su.rs:394-395`、`426-427`） | 场景格式不可表达：需要请求头，runner 的 invoke 不传 options（`tauri-harness.mjs:37`）。前端 `stagedUpload.ts:101-106` 总是同时发送两个头，offset 为 `String(offset)` 的非负整数 |
| 分块过大（Raw `su.rs:396-397`、数组 `su.rs:428-429` 需 >16MB 字节载荷；base64 `su.rs:416-417` 需 >22369628 字符；`append` 内 `su.rs:252-257` 已被前三者挡住） | 可达但未写：场景 JSON 需内联 >16MB 字面量；前端分块默认 4MB（`STAGED_UPLOAD_CHUNK_SIZE`，`stagedUpload.ts:22`），与 §2.1 `staged_upload_from_path` 的大文件上限同理 |
| 数组元素越界 `Invalid byte in chunk`（`su.rs:431-440`） | 不可达：必须先有 `x-upload-id` 与 `x-upload-offset` 头（`su.rs:425-427`），见上一条 |
| `Unsupported chunk payload`（`su.rs:442`，JSON 标量体） | 不可达：调用点只发对象（`stagedUpload.ts:97`）或 `Uint8Array`（`stagedUpload.ts:101`），Rust 测试也只用对象/数组/Raw，没有合法输入能产生标量体 |
| `Failed to write staged upload chunk`（`su.rs:277-284`）、`Staged upload task failed`（`su.rs:479`） | 不可达：IO 故障（`.part` 被外部删除或磁盘满）与 `spawn_blocking` Join 错误 |

### 5.3 `get_data_space_info`、`get_test_slot_info`、`purge_all_database_files`、`restart_app`

| 命令 | 判定 |
|---|---|
| `get_data_space_info`（`ds.rs:2493`，`systemApi.ts:164`，无参数） | seed `empty` 下无可达 Err。唯一的业务分支"数据空间管理器未初始化"（`ds.rs:2495-2496`）只在 `DATA_SPACE` 未设置时出现：`init_data_space_manager`（`ds.rs:2098-2107`）在 `src/lib.rs:963` 调用，而 `src/lib.rs:953-959` 在存在待处理启动恢复事件时先 `return Ok(())`，`src/lib.rs:963-972` 在初始化失败时也直接返回。空种子不会产生恢复事件；在 §2.3 的 `f3-startup-recovery-incident-w0` 种子下该分支可达，种子就绪后加一步 `{"cmd":"get_data_space_info","args":{},"expect":"error"}` 即可。`读取数据空间状态失败`（`ds.rs:2499`）不可达：`read_state`（`ds.rs:1289-1356`）内没有 `?`，所有失败都记日志后落到目录推断并 `Ok(inferred)`（`ds.rs:1355`）。无参数，不存在 serde 错误 |
| `get_test_slot_info`（`ds.rs:2576`，`systemApi.ts:202`，无参数） | seed `empty` 下无可达 Err。唯一的 Err 同上是"数据空间管理器未初始化"（`ds.rs:2578-2579`），在恢复模式种子下可达；`read_dir` 失败被 `unwrap_or(0)` 吞掉（`ds.rs:2585`），`exists()` 不返回错误。 |
| `purge_all_database_files`（`ds.rs:2539`，`systemApi.ts:240`，无参数） | seed `empty` 下无可达 Err。"管理器未初始化"（`ds.rs:2541-2542`）同上，只在恢复模式种子下可达。`write_purge_marker`（`startup_cleanup.rs:18-27`）的 `创建标记父目录失败`/`写入清理标记失败` 只有 IO 故障才出现：父目录就是已由 `ensure_layout`（`ds.rs:1598`）建好的数据根目录（`ds.rs:1035-1040` 在其下 `create_dir_all`）；把 `<base>/.purge_on_next_start` 预先变成目录需要在场景里拼接路径，但 §1.1 的引用只能整串替换，没有命令返回数据根目录 |
| `restart_app`（`ds.rs:2610`，`dataRecoveryApi.ts:177,181`、`systemApi.ts:214`） | 无 Err：返回类型是 `()`，函数体只有 `app.restart()`，其签名为 `-> !`（`tauri-2.11.5/src/app.rs:588`），不会把结果返回给前端；唯一参数 `AppHandle` 由 Tauri 注入，不存在 serde 错误 |

**已知问题（交 C2）：** `pending-seed/startup-recovery.seeded.json` 的 `storage.recovery.seeded.status_list_export` 第 2 步把 `get_test_slot_info` 当成功步骤，并在第 3-5 步引用 `${2.slot_d_dir}`/`${2.slot_c_dir}`。按上面的分析，该种子下应用处于恢复模式，`get_test_slot_info` 会返回"数据空间管理器未初始化"，后续引用会失败。本包按 brief 不改成功场景，留给 owner 在种子就绪时调整。
