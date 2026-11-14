# F2-shell 测试去向（地基线；实现目录不归 scaffold 所有，去向同样由该 lane 填写）

<!-- BEGIN GENERATED:testmap:header -->
每个原 Rust 测试一行（`<src-tauri 相对路径>::<内联模块…>::<测试名>`），去向列填写：
- `pending`（默认）
- `ported:<ts 测试文件路径>` —— 该文件中须有标题包含 Rust 测试名的用例（ledger 校验）
- `merged:<目标>` —— 并入的 TS 用例（`<路径>` 或 `<路径>::<用例名>`）
- `obsolete:<理由>` —— 需协调者在 `migration/approvals.json` 批准后才计入 B 级

只改"去向"列；行由 `npm run migration:scaffold -- --refresh` 按 Rust 源码重建，去向按 id 保留。

Lane F2-shell：18 行（真实测试 18）· ported 18
<!-- END GENERATED:testmap:header -->

## 测试

<!-- BEGIN GENERATED:testmap:rows -->
| Rust 测试 | 种类 | 位置 | 去向 |
|---|---|---|---|
| `crates/dstu-platform/src/package_manager.rs::tests::install_command_success_captures_status` | tokio::test | L456 | merged:host/platform/diagnostics/tests/package-manager.test.ts::install_command_success_captures_status |
| `crates/dstu-platform/src/package_manager.rs::tests::install_command_failure_captures_stderr` | tokio::test | L465 | merged:host/platform/diagnostics/tests/package-manager.test.ts::install_command_failure_captures_stderr |
| `crates/dstu-platform/src/package_manager.rs::tests::install_command_timeout_kills_child` | tokio::test | L475 | merged:host/platform/diagnostics/tests/package-manager.test.ts::install_command_timeout_kills_child |
| `crates/dstu-platform/src/package_manager.rs::tests::install_command_large_output_is_capped_and_drained` | tokio::test | L489 | merged:host/platform/diagnostics/tests/package-manager.test.ts::install_command_large_output_is_capped_and_drained |
| `crates/dstu-platform/src/startup_gate.rs::tests::wait_times_out_when_never_marked_then_succeeds_after_mark` | tokio::test | L105 | ported:electron/tests/startup-gate.test.ts |
| `crates/dstu-platform/src/startup_gate.rs::tests::guard_marks_ready_on_drop` | tokio::test | L121 | ported:electron/tests/startup-gate.test.ts |
| `crates/dstu-platform/src/startup_gate.rs::tests::late_subscriber_sees_ready_immediately` | tokio::test | L131 | ported:electron/tests/startup-gate.test.ts |
| `src/external_file_opener.rs::tests::mode_parse_defaults_to_view_and_rejects_unknown` | test | L262 | ported:electron/tests/platform.test.ts |
| `src/external_file_opener.rs::tests::content_uri_detection_is_case_insensitive` | test | L279 | obsolete:mobile-only |
| `src/external_file_opener.rs::tests::source_must_be_a_file_inside_an_allowed_root` | test | L288 | pending |
| `src/external_file_opener.rs::tests::staging_copies_into_shared_subdir_and_reuses_shared_files` | test | L313 | pending |
| `src/external_file_opener.rs::tests::purge_removes_only_expired_entries` | test | L335 | pending |
| `src/system_permissions.rs::tests::maps_modern_macos_targets_to_fixed_system_settings_urls` | test | L143 | ported:electron/tests/platform.test.ts |
| `src/system_permissions.rs::tests::maps_legacy_macos_targets_to_fixed_system_preferences_urls` | test | L161 | ported:electron/tests/platform.test.ts |
| `src/system_permissions.rs::tests::selects_legacy_urls_only_before_macos_ventura` | test | L179 | ported:electron/tests/platform.test.ts |
| `src/system_permissions.rs::tests::parses_macos_compatibility_versions` | test | L195 | ported:electron/tests/platform.test.ts |
| `src/system_permissions.rs::tests::maps_windows_targets_to_fixed_settings_uris` | test | L204 | ported:electron/tests/platform.test.ts |
| `src/system_permissions.rs::tests::rejects_unknown_permission_targets` | test | L222 | ported:electron/tests/platform.test.ts |
<!-- END GENERATED:testmap:rows -->

## 去向说明（v2 §1.1 复核，2026-11-04）

- `package_manager.rs` 4 条：生产实现与命令 `auto_install_package_manager` 归 F4
  （`host/platform/diagnostics/index.ts:31` → `diagnostics/package-manager.ts:54`），其测试已逐条移植。
  F2 原有的 `electron/package-manager.ts` 无生产调用方，属于重复实现，已删除；行改为 `merged:` 指向 F4 测试。
  注：Rust 模块为 `#[cfg(all(test, not(target_os = "windows")))]`，F4 测试未加同等 `skipIf(win32)`，已在报告中告知。
- `external_file_opener.rs` 中 `content_uri_detection…`、`source_must_be…`、`staging_copies…`、`purge_removes…` 4 条：
  被测函数在 Rust 中唯一的生产调用点位于 `#[cfg(target_os = "android")]` 分支（`external_file_opener.rs:183-237`），
  桌面分支（`:239-245`）直接返回 Validation。TS 对应 helper 在 `electron/index.ts` 中没有生产调用方，因此不能计 ported。
  已按 decisions.md「移动端专属测试」向协调者申请 `obsolete:mobile-only`；批准前保持 pending。
  `mode_parse_defaults_to_view_and_rejects_unknown` 在桌面生产路径可达（`index.ts:84` 先解析 mode），保持 ported。

### C2 精确批准落地（2026-11-04）

- `content_uri_detection_is_case_insensitive`：main 的 `migration/approvals.d/C2-platform.json`
  已按完整 Rust 测试 ID 批准 `obsolete:mobile-only`，仅此行按批准映射；Rust 测试不删除。
- 其余 3 条 helper 测试继续 `pending`，不把调用点位于 Android 分支推断成全组获批。

### WP-006 入口与桥接回归（2026-11-05）

- 前后均为 18 行：10 ported / 4 merged / 1 obsolete / **3 pending → 3 pending**；本包不更改任何 Rust 测试去向。generated 表头的 ported 18 是历史统计，不代表当前状态。
- `commands.rs:500-507 get_app_version` 没有对应 Rust 单测；按源码补 `electron/tests/app-version.test.ts` 的生产 kernel 命令回归，验证无 Shell 的 debug/release、精确完整版本与零 Shell 请求，不增加映射行或冒充原测试移植。
- `electron/tests/shell-real-host.test.ts` 在已有真实官方 Host/窗口用例上补完整版本断言；原 PDF/filestream 允许目录、空路径 false、两次重启请求/零次 exit 与 purge 失败断言保留。`shell-restart-host.test.ts` 补 `app.fullVersion` op 的精确字符串，保留既有路由/未知 op 拒绝断言。
- 后两条 Rust 命令仅作边界依据，不变更 F3/L13 TESTMAP；headless 缺桥错误归属见 SPEC/BLOCKERS。
- `electron/tests/commands.test.ts` 的旧版本测试（非 Rust 映射项）原来期望 Shell 替身字符串；按 `commands.rs:500-507` 改为实际构建元数据的精确完整值，增补零 Shell 请求断言，保留其 macOS vibrancy 原断言。首次全套暴露该旧假设的失败原日志保留在 job `20261105141054-47f5ee`。

### WP-134 JSON 入站接缝

- 去向前后均为 10 ported / 4 merged / 1 obsolete / **3 pending → 3 pending**；本包无 Rust 测试映射变更。
- 新增 `electron/tests/inbound-json-renderer.test.ts` 是按 Tauri IPC 与 insight_list 源码补充的真实 Electron
  接缝回归，不冒充 Rust 单测移植。断言生产 handler 送往服务的两个 offset 分别为 bigint 993/992、
  普通 number 与 Option 默认值、精确契约拒绝、错误/bytes、可信 source/ACL 与 headers，详见 SPEC WP-134。
- pending 仍仅 Android source/staging/purge 三条，沿既有精确审批边界保留。

### WP-194 browser typed error 接缝（不改变去向）

- 前后仍 10 ported / 4 merged / 1 obsolete / **3 pending → 3 pending**，无新增 B/C 资格。
- `electron/tests/browser-error.test.ts` 按 Rust `bridge.rs:772-796` 的 code/password/reason 三项断言与
  `:850-856` 的 EVAL_THROW 断言补供方回归，附 Option/null/嵌套与 double-encoded；不更改 L19 的原测试归属。
- `electron/tests/browser-error-host.test.ts` 为新增真实 Electron 接缝证据（SPEC WP-194）：当前生产
  browser bridge 的密码 BLOCKED body、STALE_REF、普通失败与成功，经正式 F2 路由和真实 MessagePort
   到 F1 公共 ShellError；L19 领域消费仍归 WP-195，不能把此测试替代其业务链或 Rust 差分录制。

### WP-199 Started 诊断（无原 Rust 单测映射）

- 18行去向前后均为 **10 ported / 4 merged / 1 obsolete / 3 pending**，本包无映射变更。三pending仍为external_file_opener.rs的source/staging/purge（L288/L313/L335），不扩大精确obsolete批准。
- `electron/tests/boot-diagnostics-host.test.ts` 按 `src-tauri/src/lib.rs:494-556` 补充真实Electron入口回归：首脚本顺序、四类页面错误、原8000ms空root、八字段payload、原errorReporter同世界cleanup、reload、独立webview、原browser-content ACL拒绝及best-effort。不新增Rust测试行，不提升B/C资格。
- `electron/tests/boot-diagnostics.test.ts` 是生产installer的精确分支/清理补充；真实证据仍为前项。job `20261105233750-4b763f`：3 passed / 0 failed / 0 skipped / Errors0 / exit0。原090 Started/abandon/HostReady用例保持，完整回归与gate见交付报告。
