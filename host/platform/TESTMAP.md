# F4 平台服务 TESTMAP（secrets · settings · log · paths）

状态：`ported` = 同名用例已移植并通过；`ported(win)` = 已移植，只在 Windows 上运行（DPAPI），本机未执行；
`ported(opt-in)` = 已移植，需 `F4_KEYCHAIN_TEST=1` 才访问真实钥匙串；`merged` = 断言并入所列 TS 用例；
`remaining` = 未移植（附归属/原因）。TS 用例名与 Rust 函数名相同（除非另注）。

运行：`npm run test:host`（全部）、`npm run test:host:electron`（Electron 内置 Node：BoringSSL、无原生 Argon2，
走 `@noble/hashes` 路径）。两者在本机均通过。

## dstu-security/src/secure_store.rs → host/platform/secrets/secure-store.test.ts

| Rust 测试 | 状态 |
|---|---|
| tests::stable_seed_is_persisted | ported |
| tests::plaintext_backup_seed_is_portable | ported |
| tests::oversized_backup_seed_is_rejected_before_reading | ported |
| tests::empty_existing_seed_fails_closed_without_replacement | ported |
| tests::oversized_encrypted_secret_is_rejected_before_allocation | ported |
| tests::symlinked_backup_seed_is_rejected | ported |
| tests::dpapi_wrapped_backup_seed_is_rejected_off_windows | ported |
| tests::plaintext_seed_migrates_to_dpapi_wrapping | ported(win) |
| tests::plaintext_seed_exports_for_password_encrypted_backup | ported |
| tests::exported_plaintext_seed_survives_import_roundtrip | ported |
| tests::reseal_wraps_imported_plaintext_seed_on_windows | ported(win) |
| tests::reseal_keeps_imported_plaintext_seed_off_windows | ported |
| tests::dpapi_seed_export_fails_closed_off_windows | ported |
| tests::keystore_marker_seed_reseal_is_noop_and_export_fails_without_backend | ported |
| tests::classify_seed_content_variants | ported |
| tests::seed_fingerprint_is_stable_hex | ported |
| tests::plaintext_seed_migrates_into_keystore_with_verified_marker | ported |
| tests::migration_store_failure_keeps_plaintext_file | ported |
| tests::migration_readback_mismatch_keeps_plaintext_file | ported |
| tests::keystore_ref_fails_closed_without_backend | ported |
| tests::keystore_ref_fails_closed_when_backend_unavailable | ported |
| tests::keystore_ref_fails_closed_when_entry_missing | ported |
| tests::keystore_ref_fingerprint_mismatch_fails_closed | ported |
| tests::keystore_marker_seed_file_never_replaced_by_new_seed | ported |
| tests::keystore_marker_backup_seed_is_rejected_without_backend | ported |
| tests::dpapi_seed_is_rejected_off_windows_when_reading | ported |
| tests::new_seed_stays_in_local_file_by_default | ported |
| tests::enabling_keystore_protection_fails_closed_without_backend | ported |
| tests::disabling_keystore_protection_is_idempotent | ported |
| tests::can_read_legacy_ciphertext_and_migrate | ported |
| cloud_hydration_tests::credential_status_never_serializes_secret_values | ported |
| cloud_hydration_tests::debug_output_redacts_all_secret_values | pending — WP-087 / X6 #22：缺生产凭据 Debug 格式化入口；status JSON 不覆盖普通/pretty Debug 的四秘密排除、REDACTED 与字段名断言 |
| cloud_hydration_tests::debug_output_preserves_presence_information | pending — WP-087 / X6 #23：缺生产凭据 Debug 格式化入口；status 布尔 JSON 不等于精确 Some/None Debug 字符串 |
| cloud_hydration_tests::credential_update_preserves_omitted_backend_secrets | ported |
| cloud_hydration_tests::short_encryption_password_is_rejected_and_does_not_mark_configured | ported |
| cloud_hydration_tests::preexisting_short_encryption_password_is_accepted | ported |
| cloud_hydration_tests::preexisting_policy_does_not_relax_the_default_entry | ported |
| cloud_hydration_tests::weak_password_predicate_semantics | ported |
| cloud_hydration_tests::new_password_gate_checks_length_before_weakness | ported |
| cloud_hydration_tests::new_weak_encryption_password_is_rejected_and_not_persisted | ported |
| cloud_hydration_tests::preexisting_weak_encryption_password_is_accepted | ported |
| cloud_hydration_tests::clearing_encryption_password_keeps_transport_credentials | ported |
| cloud_hydration_tests::clearing_the_only_secret_removes_the_record_entirely | ported |
| cloud_hydration_tests::clearing_encryption_password_without_stored_credentials_is_a_noop | ported |
| cloud_hydration_tests::successful_cloud_credential_clear_removes_the_secret_record | ported |
| cloud_hydration_tests::staged_write_leaves_active_record_and_generation_untouched | ported |
| cloud_hydration_tests::commit_advances_generation_and_publishes_staged_values | ported |
| cloud_hydration_tests::abort_discards_staged_without_touching_active | ported |
| cloud_hydration_tests::staged_write_enforces_the_same_short_password_policy | ported |
| cloud_hydration_tests::staged_write_enforces_the_same_weak_password_policy | ported |
| cloud_hydration_tests::stale_generation_handles_fail_closed_without_touching_active | ported |
| cloud_hydration_tests::commit_without_staged_record_fails_closed | ported |
| cloud_hydration_tests::transactional_delete_clears_active_staged_and_generation | ported |

新增（无 Rust 对应）：钥匙串开关开/关往返（FakeKeystore）、staged 落盘形状、listSensitiveKeys、toCommandError 形状。

WP-087（2026-11-06）：上述两个 Debug 测试撤回旧 merged 资格，权威表 pending **12 → 14**
（245 ported / 32 merged / 9 obsolete / 14 pending）；其余去向不动。逐条原断言与生产缺口见
`migration/testmap/F4-security.md` 的 WP-087 节。`secure-store.test.ts:328-332` 原单字段 status
JSON 断言保留，仅改正标题与说明；它是补充状态测试，不再承接这两个 Rust ID。
两条 Debug 均未完成迁移；Windows DPAPI 原条件用例未在本机执行，不据 Linux 测试通过签收 Windows。

## dstu-security/src/crypto/tests.rs → host/platform/secrets/crypto-service.test.ts

| Rust 测试 | 状态 |
|---|---|
| test_crypto_service_creation | ported |
| test_encrypt_decrypt_cycle | ported |
| test_encrypted_format_detection | ported |
| test_migrate_plaintext_key | ported |
| test_key_rotation | ported |
| test_empty_and_invalid_data | ported |
| test_encrypted_data_serialization | ported |

## dstu-security/src/crypto/backup_crypto.rs → host/platform/secrets/backup-crypto.test.ts

全部 35 个 ported：roundtrip_encrypt_decrypt、wrong_password_fails、tampered_data_fails、non_encrypted_file_detected、
stream_roundtrip_various_sizes、stream_wrong_password_fails、stream_truncation_is_detected、
password_verifier_roundtrip_and_wrong_password、password_verifier_digest_does_not_leak_key、
password_verifier_unknown_kdf_fails_closed、password_verifier_corrupted_fields_fail_closed、
session_bytes_roundtrip_and_wrong_password、session_file_roundtrip_across_sessions、
session_output_interoperates_with_password_api、session_rejects_empty_password、kdf_limits_cover_default_write_surface、
kdf_oversized_params_rejected_before_derivation、verifier_oversized_params_fail_closed_as_err、
dsbk_headers_with_oversized_params_rejected、new_password_cap_matches_platform_and_never_loosens_global_cap、
new_password_cap_covers_default_write_surface_on_every_platform、session_with_params_rejects_m_cost_above_new_password_cap、
decrypt_and_legacy_verifier_paths_are_not_tightened_by_new_password_cap（桌面分支；移动端分支不在本轮范围）、
encrypted_root_memory_roundtrip_and_isolation、encrypted_root_memory_corrupted_file_fails_closed、
dsbk_layout_constants_match_real_containers、stream_decrypts_legacy_v1_file、first_chunk_trial_proves_password_with_prefix_only、
first_chunk_trial_final_flag_matches_object_size、first_chunk_trial_tampered_first_block_fails、
first_chunk_plan_v1_requires_whole_file、first_chunk_plan_rejects_bad_headers、first_chunk_trial_truncated_prefix_rejected、
first_chunk_trial_oversized_kdf_params_rejected_fast、speculative_prefix_len_covers_own_write_surface。

## dstu-security/src/crypto_publication.rs → host/platform/secrets/crypto-publication.test.ts

全部 13 个 ported（同名）。

## dstu-platform/src/debug_log_service.rs → host/platform/log/log.test.ts

| Rust 测试 | 状态 |
|---|---|
| write_debug_response_entry_preserves_raw_response_completely | ported |
| write_debug_response_entry_redacts_credential_like_text | ported |
| write_debug_log_entry_still_writes_and_redacts_request_body | ported |
| safe_components_keep_filename_safe | ported |

`debug_logger.rs`、`crash_logger.rs`、tauri-plugin-log 无 Rust 测试；log.test.ts 新增轮转、行格式、过滤、
结构化日志、崩溃日志、format_size 用例。`tests/sse-logger.test.ts` 验证生产 log 插件在 apply 时把共享
SSE buffer logger 绑到 target `dstu_util::utils::sse_buffer`，不是仅测试注入；setter 返回带身份校验的
disposer，多宿主/测试宿主卸载时不会误清另一个消费者。

## dstu-storage/src/data_space/device_id.rs → host/platform/paths/paths.test.ts

全部 10 个 ported（同名）：primary_path_takes_precedence_over_legacy、legacy_id_is_migrated_to_primary_once、
legacy_candidates_are_consulted_in_priority_order、generated_id_is_persisted_to_primary_and_stable_afterwards、
persist_failure_is_reported_instead_of_faked、persist_writes_primary_and_refreshes_existing_legacy_copies、
persist_fails_when_primary_is_unwritable、persist_falls_back_to_legacy_when_primary_unavailable、
persist_rejects_empty_identity、read_device_id_file_normalizes_and_rejects_blank。

R4 P06 补充：`paths/tests/device-id.test.ts` 验证 `dataSpaceDeviceId()` 的 env → 主 `.device_id` →
旧路径（规范化+迁移）语义，与 `deviceId()` 的 commands_sync 旧根优先包装分开；并验证生产 paths
插件把身份日志接到注入的 `ctx.log`（target `dstu_storage::data_space::device_id`）。

## src-tauri/tests（集成测试）

| Rust 测试 | 状态 |
|---|---|
| secure_store_tests::test_secure_store_basic_operations | ported → secrets/secure-store.test.ts |
| secure_store_tests::test_sensitive_key_detection | ported → secrets/secure-store.test.ts |
| secure_store_tests::test_database_secure_integration | ported → settings/settings.test.ts |
| secure_store_tests::test_fallback_behavior | ported → settings/settings.test.ts |
| device_identity_tests::device_id_probe_subprocess | merged → two_app_data_dirs…（TS 无进程级单例，不需要子进程探针） |
| device_identity_tests::two_app_data_dirs_yield_distinct_persisted_device_ids | ported → paths/paths.test.ts |
| cloud_half_configured_credentials_tests::*（5 个） | remaining — 测的是 `CloudStorageConfig::validate`/`create_storage`（dstu-sync cloud_storage），归 L23 |
| error_details_tests::*（14 个） | ported → errors/tests/errors.test.ts |

## 范围内但未移植（不属于 secrets/settings/log/paths 四个服务）

| Rust 位置 | 测试数 | 说明 |
|---|---|---|
| dstu-platform/src/background_tasks.rs | 2 | ported → diagnostics/tests/background-tasks.test.ts |
| dstu-platform/src/package_manager.rs | 4 | ported（F2）→ electron/tests/platform.test.ts |
| dstu-platform/src/secret_prompt.rs | 2 | ported → secrets/tests/commands.test.ts |
| dstu-platform/src/startup_gate.rs | 3 | ported（F2）→ electron/tests/startup-gate.test.ts |
| dstu-core/src/task_objects.rs | 25 | 16 ported → util/tests/task-objects.test.ts；5 merged → agent-skills/tests/task-objects-manifests.test.ts 的同名不同handle/去重/notice/快照/坏shape五例，main 的 chat附件分页命令真实调用公共builder/validate/notice；job20261105114147-b5f72c含kernel产物回归6pass/27标题过滤skip/exit0。另4 pending，含decoder roundtrip尚无生产caller；逐ID见 migration/testmap/F4-security.md |
| dstu-core/src/events.rs | 1 | ported → util/tests/shared-events.test.ts（经 L04 `chat/api.ts`） |
| dstu-core/src/{agent,canonical_tools,error_recovery,lib,models,prompt_contracts,spaced_repetition,workflow_error_handler}.rs | 35 | 共享领域类型与纯函数，随使用方 lane 移植（协调者裁定）；canonical 8 + models 1 + prompt 2 + lib 1 已解除，error_recovery/workflow 4 条按 obsolete 计 B；SM-2 10 条、L04 ToolScope 1 条已在 main 生产可达并逐原断言映射，剩余 agent 2、prompt 1、spaced 5 见 BLOCKERS |
| dstu-core/src/{error_details,tool_args,tool_names}.rs | 16 | ported → errors/tests/{errors,tool-args}.test.ts |
| dstu-util/src/utils/fetch.rs | 5 | ported → net-policy/tests/fetch-policy.test.ts（SSRF 判定；缓存下载由 L01 接线） |
| dstu-util/src/qr.rs | 1 | merged → host/kernel/tests/plugins.test.ts（F1 的 `host/kernel/qr.ts` 覆盖同一 PNG 断言） |
| dstu-util/src/utils/token_budget.rs | 4 | 4 个 merged → F7 `native/tests/tokenizer.test.ts`；D11/main `fb463060d` 正式解除 tiktoken 根依赖，剩余两条定向执行 2 passed（job `20261104165839-630b72`），200K 原“数”<5 秒与 100K..400K、120K ratio 0.8..1.25 原断言保留 |
| dstu-util/src/utils/model_special_tokens.rs | 17 | ported → util/tests/model-special-tokens.test.ts（C2 2026-11-04 确认归 F4；L02 选策略、L01/L03 消费） |
| dstu-util/src/utf8_stream.rs、utils/{chat_query,sse_buffer}.rs | 31 | utf8_stream 8 + sse_buffer 20 已由 F4 单一实现并移植到 `util/tests/sse-buffer.test.ts`（`host/platform/util/sse-buffer.ts`，默认 10 MiB + scan_from）；`extractStreamDataPayload` 按 Rust `trim_end_matches('\r')` 删除行尾全部 CR；chat_query 3 条按 obsolete 计 B。L01/L02 待改用平台入口 |
| dstu-util/src/utils/unicode.rs | 6 | ported → paths/tests/unicode.test.ts |

## 平台纯函数模块（F4 发布，无逐条 Rust 测试对应）

| 模块 | 参照 | 测试 |
|---|---|---|
| `host/platform/time` | chrono 0.4 `to_rfc3339`/`to_rfc3339_opts`/`parse_from_rfc3339`；`sync/mod.rs` 两个 `parse_flexible_timestamp` | `time/tests/time.test.ts`（13） |
| `host/platform/time` WP-007 | Cargo.lock 锁定 chrono **0.4.41** `DateTime<Utc>` serde / FromStr / `parse_rfc3339_relaxed` | `time/tests/chrono-serde.test.ts`（9），经 `time/api.ts` 与 `time/index.ts` 的公开 `parseChronoDateTimeUtc` |
| `host/platform/util` | Rust `str::trim*`/UTF-8 错误；`http 1.5.0` `canonical_reason`；`zip 0.6.6` 的 Stored/Deflated、CRC-32、CP437 读取 | `util/tests/util.test.ts`（12） |
| `host/platform/net-policy` | `crates/dstu-core/src/net_policy.rs` 逐行移植 | `net-policy/tests/net-policy.test.ts`（6） |

这三个模块是共享实现，测试覆盖 Rust 语义与跨实现互操作（`util` 用 JSZip 做双向验证），
不对应单个 Rust 测试函数；消费方 lane 的 TESTMAP 行仍按其业务测试迁移。

### WP-007 原源码/测试对照（不新增项目 Rust 测试去向）

已读上游原测试全文，路径相对 chrono-0.4.41/src：

| Rust 依据 | TS 用例 / 断言对应 |
|---|---|
| `datetime/tests.rs:890-1000 test_datetime_from_str` | `test_datetime_from_str: UTC assertions`：保留 UTC 子集的6条成功日历/纳秒/offset断言与2条失败；FixedOffset/Local 不属于新 UTC 入口，不称整条上游测试已 ported |
| `datetime/serde.rs:1247-1295 test_serde_deserialize` | `test_serde_deserialize: UTC normalization and invalid date`：UTC 两个成功值及 offset=0、非法日期失败；这里只测试 DateTimeVisitor 收到字符串后的解析，不把 JSON 层/FixedOffset/Local 算作已迁移 |
| `datetime/tests.rs:1003-1087 test_parse_datetime_utc` | 同名 valid corpus / rejected inputs 两例：24条合法输入的固定 canonical UTC parse pair，25条非法输入全部 null；原 Debug formatter roundtrip 未移植（本包是解析接口），不声称 formatter 等价 |
| `datetime/mod.rs:1805-1818` 与 L19 BLOCKERS:35-39 | `publishes the same parser…`：api/index 同一函数、两条请求输入的精确 epochNanos/millis/完整 UTC 字段；旧严格入口仍拒绝它们 |
| `format/parse.rs:326-380,420-425,545-583`、`format/scan.rs:17-65,183-278` | White_Space位置、偏移完整性/UTC跨年、小数截断与闰秒3例：全部25个Rust空白字符、FEFF拒绝、分隔符错误、偏移±23:59/24:00边界、负纪元floor及1ns/闰秒完整字段 |
| `format/parsed.rs:748-780,902-916`、`naive/datetime/mod.rs:588-601`、`naive/date/mod.rs:2343-2352` | calendar limits例：本地/UTC双范围、边界闰秒不被epoch投影错误拒绝、无符号/有符号年、零年、世纪闰年、非法月日时分秒 |

这些是共享供方入口测试与源码审读，不运行 Rust 差分，不代替 L19 OAuth 消费链验收。
项目权威 TESTMAP 的 pending **12 → 12**（245 ported / 34 merged / 9 obsolete），本包未更改任何去向。

## 兼容向量

| 向量 | 来源 | 位置 |
|---|---|---|
| v3 设备密钥、legacy v2 密钥、种子指纹、`derive_static_key` | Python hashlib 按 Rust 源码常量计算 | secrets/vectors.test.ts |
| `.enc` 字节（nonce‖ct‖tag） | `@noble/ciphers` 纯 JS AES-GCM | secrets/vectors.test.ts |
| EncryptedData JSON 与 `.master_key` 文件 | 同上 | secrets/vectors.test.ts |
| NIST GCM Test Case 16 | GCM 规范 | secrets/vectors.test.ts |
| RFC 9106 §5.3 Argon2id | RFC | secrets/backup-crypto.test.ts |
| Argon2id(cheap/默认参数)、DSBK v1/v2 字节、校验子摘要、根指纹 | OpenSSL Argon2（Node 26）+ `@noble/ciphers` | secrets/backup-crypto.test.ts |
| macOS 钥匙串 service/account 互通 | `security` CLI（与 keyring 3.6.3 apple-native 同类条目） | secrets/keystore.test.ts（opt-in） |

**待补（需要运行 Rust 或其他平台，本轮未做）**：
1. 一份真实 Rust 写出的 `.secure/*.enc` + `.key_seed`、`.master_key` + `api_configs` 密文、DSBK v1/v2 备份样本（F6 录制时顺带导出），用 TS 解开。
2. Linux Secret Service：@napi-rs/keyring（keyring-core 1.x + dbus store）能否找到 keyring 3.6.3 写入的条目
   （v3 条目属性 `service/username/target=default/application=rust-keyring`）——需 Linux 桌面实测。
3. Windows DPAPI：PowerShell `ProtectedData` 与 Rust `CryptProtectData` 互解——需 Windows 实测（ported(win) 用例）。
4. legacy v2 密钥在 Windows 上 `hostname::get()`（`GetComputerNameExW`）与 `os.hostname()` 是否一致。

## 跨 lane 待办（`migration/testmap/F4-security.md` 的 12 条 pending）

F4 旧 ledger 命令注册覆盖为 100% A，不等同 v2 全域完成；自有审读余项见 `secrets/LANE.md`。
剩余 12 条 pending 是共享 crate（dstu-core/dstu-util）与
`src-tauri/tests` 的测试，按 `docs/dev/electron-migration/decisions.md` 的「共享 crate 的
测试归属」随使用它们的 lane 迁移。逐行归属、缺失符号与证据见
`migration/testmap/F4-security.md` 的「BLOCKERS（跨 lane 接口，证据到符号）」表：
L07 的 `BatchManifest`/`CorpusManifest`/legacy serde（4；五条Corpus生产调用已闭合，见本表:151）、消费方 lane 的领域模块（8）。
F7 两条大文本已在 D11/main 正式依赖上定向运行并解除。F1 版本注入（1）已由 main `e60e7a771` 的
`host/kernel/connection.test.ts::app_version_is_injected_from_app_manifest` 覆盖，不再计入待办。
`cloud_half_configured_credentials_tests.rs`
的 5 条已用 L23 发布的 `syncProvider.createStorage`/`validateConfig` 移植到
`host/platform/errors/tests/cloud-half-configured.test.ts`。canonical 8 条已由 L03 合入 main
的 `chat-pipeline/tests/canonical-tools.test.ts` 原名测试覆盖（F4 删除的重复文件为 3 测试 /
9 断言，对应 L03 前 3 条原名测试；L03 经 `chat-pipeline/api.ts` 生产导出且服务可达）；
LaTeX 2 条已分别经 `llm-providers/api.ts` 常量与 L03 `chat-pipeline/api.ts` 的 `LATEX_RULES`
原名测试覆盖（F4 删除的重复文件 `host/platform/util/tests/prompt-contracts.test.ts` 为 1 测试 /
4 断言，同名同断言已由 L03 `chat-pipeline/tests/prompt-contracts.test.ts` 保留，TESTMAP 两行均
指向该 `merged:` 目标，不指向已删除文件）；models 1 条经 L02 `ctx.llm.getModelAssignments()` 移植到
`host/platform/util/tests/model-assignments.test.ts`；utf8_stream 8 + sse_buffer 20 已由 F4
单一实现并移植到 `host/platform/util/tests/sse-buffer.test.ts`（L01/L02 待改用平台入口）。
L15 的 SM-2 导出和 15 条原名测试已在 main `0ed7917b8`：10 条对应函数有 `review_plan_process` 生产调用证据，
逐原断言映射为 merged；余 5 条 helper 只有定义/测试调用仍 pending（作业 `20261104163919-93a437` 16 passed）。
`model_special_tokens.rs` 的 17 条已由 F4 实现并移植到
`host/platform/util/tests/model-special-tokens.test.ts`；L02 选择策略、L01/L03 消费，不再复制。

另两条 `dstu-platform/secret_prompt.rs` helper 测试按 C2 `e4680aa8a`（现已正常 main 可见）
限定为 obsolete:dead-in-rust disabled-entry；原断言/实现仍保留在 `secrets/tests/commands.test.ts:8-25`。
Rust :158 仍有被固定 false 挡住的源码调用，不称整个模块零 caller；审批不豁免四个已注册命令，
特别 submit 拒绝路径的 SecretValue::Drop 仍活跃，不授 JS 字符串物理清零等价。未改原断言/skip/功能开关，
其余17跨 lane pending及联合类型不因此关闭。

其中 7 条（`error_recovery` 2、`workflow_error_handler` 2、`chat_query` 3）的 Rust 实现
零生产调用方，C2 已于 2026-11-04 批准 `obsolete:zero-production-callers`
（`migration/approvals.d/C2-platform.json`）；main 已聚合 `approvals.d/`，ledger 按 B 计。

**ledger 顺序注意**：ledger 先读业务 lane、后读 F lane 的 TESTMAP；F4 的 `pending` 行会覆盖
同一测试 id 在其他 lane 的 `ported:`。消费方 lane 移植后，需由协调者把这些行移出 F4 的
TESTMAP（或由 F4 更新去向列），否则不会计入 A。
