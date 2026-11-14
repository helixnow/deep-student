# L01 等价语料（WAVE0 v0）

本目录是 `board/WAVE0-EQUIVALENCE.md` §3 场景 v0。文件格式只用 domain / commands / scenarios / id / seed / steps / capture / normalize；`expect: "error"` 仅为注释，比对以 A（Tauri+Rust）实际结果为准。这些场景**尚未在 A 或 B 上运行，不计 C 级**。

文件：[`codex-auth.json`](codex-auth.json)（5 命令 / 12 场景 / 60 步）。

## 命令与入口

本 lane 自有 IPC 只有这 5 条，全部前端可达（inventory 只认出 `useVendorModels.ts:163`，其余经 `openaiCodexAuthClient.ts:293` 的 `call()` 包装器调用）。Rust 包装层见 `src-tauri/src/cmd/openai_codex.rs`，注册于 `src-tauri/src/lib.rs:2057-2061`；业务在 `src-tauri/crates/dstu-llm/src/openai_codex/manager.rs`（下表简称 `manager.rs`）。

| 命令 | 前端调用点 | Rust 入口 | 业务函数 |
|---|---|---|---|
| `openai_codex_auth_status` | `src/features/settings/components/openaiCodexAuthClient.ts:379`（经 `OpenAICodexAccountSection.tsx:234`）；`src/hooks/useVendorModels.ts:163` | `cmd/openai_codex.rs:12-17` | `manager.rs:202-259` `status` |
| `openai_codex_login_start` | `openaiCodexAuthClient.ts:425`，参数 `{ flow }`，`flow` 为 `'browser'`（`OpenAICodexAccountSection.tsx:482`）或 `'device_code'`（`:494`） | `cmd/openai_codex.rs:19-34` | `manager.rs:336-392` `start_browser_login`、`:394-465` `start_device_login` |
| `openai_codex_login_cancel` | `openaiCodexAuthClient.ts:451`，参数 `{ attemptId }`（前端先 trim，空串在 `:448` 前端拒绝） | `cmd/openai_codex.rs:36-46` | `manager.rs:467-491` `cancel_login` |
| `openai_codex_logout` | `openaiCodexAuthClient.ts:463`（经 `OpenAICodexAccountSection.tsx:369`） | `cmd/openai_codex.rs:48-55` | `manager.rs:493-557` `logout` / `logout_transaction` |
| `openai_codex_usage` | `openaiCodexAuthClient.ts:475`（经 `OpenAICodexAccountSection.tsx:250`） | `cmd/openai_codex.rs:57-66` | `manager.rs:261-297` `usage_snapshot` |

所有 `CodexAuthError` 经 `cmd/openai_codex.rs:7-10` 记 `warn!("[OpenAI Codex OAuth] command failed: {}")` 后统一返回字符串 `"OpenAI Codex authentication request failed"`；只有未知 flow 返回 `"Unsupported OpenAI Codex login flow"`（`:32`），不记日志。v0 不捕获日志，warn 内容属于差分看不到的部分，需人工审读。

管理器状态在内存里（`manager.rs:56-63`），凭据经 `Database::{get,save,delete}_secret` 写 `<app_data>/.secure/internal.oauth.openai_codex.session.enc` 加密文件（`dstu-storage/src/database/mod.rs:4230-4353`、`dstu-security/src/secure_store.rs:135,1369-1389`），同时会删 `settings` 表同名旧明文行。**加密文件不在 SQLite 里，`capture.db` 看不到它**；本包场景都不写凭据，只有 logout 会对 `settings` 执行一次 0 行 DELETE。Rust 侧这 5 条命令不发 Tauri 事件；前端的 `api_configurations_changed` 是 `window` CustomEvent（`openaiCodexAuthClient.ts:327-332`），也不经后端。

## 分支覆盖表

“场景”列是 `codex-auth.json` 中的 id（省略前缀 `codex.`）和步序号（从 0 起）。

### openai_codex_auth_status（处理函数无 Err；唯一错误来自 Tauri State 提取，需种子）

处理函数体只有 `Ok(manager.openai_codex_auth().status().await)`（`cmd/openai_codex.rs:12-17`），没有 `?`、没有提前返回；`openai_codex_auth()` 只是 clone（`dstu-llm/src/llm_manager/mod.rs:4784-4786`），`status()` 只读内存状态、组装结构体（`manager.rs:202-259`），其中 `requires_reauthentication`（`manager.rs:1927-1934`）、`redact_account_id`（`types.rs:223-237`）都不会失败。命令无参数，不存在反序列化错误。

唯一可达的 Err 在处理函数之外：`State<'_, Arc<LLMManager>>` 提取失败时 Tauri 返回 `state not managed for field \`manager\` on command \`openai_codex_auth_status\`. You must call \`.manage()\` before using this command`（tauri-2.11.5 `src/state.rs:62-67`）。`Arc<LLMManager>` 只在 `build_app_state`（`src-tauri/src/lib.rs:3482`）里 `app_handle.manage`（`:3533`），该函数在 setup 的 `:1321` 调用；setup 进入恢复启动模式时会在此之前 `return Ok(())`（`lib.rs:959` 时间线冲突、`:972` 数据空间初始化失败、`:986` 活动目录创建失败、`:1043`/`:1053`/`:1062` 启动清理失败、`:1317` 核心数据域 vfs/mistakes 被阻塞，`dstu-storage/src/data_space/startup_health.rs:61-63`）。`seed: "empty"` 不会进入这些模式，现有种子（`host/e2e/data-compat/__fixtures__/scenario-seeds.ts:10`）也没有一个会触发，所以本包不写该错误场景。需要 X3 提供能让启动进入恢复模式的种子（例如待处理的数据时间线冲突），之后在该种子上加一步 `{ "cmd": "openai_codex_auth_status", "expect": "error" }` 即可。

| 分支（manager.rs:202-259） | 场景 |
|---|---|
| 新档案：phase `signed_out`，无 session、无 attempt，generation 1 | `status.fresh_signed_out`#0,#1 |
| 有浏览器 attempt：phase `authorizing`，`activeLoginKind: "browser"`、`activeAttemptId`、`authorizationUrl`、`expiresAtUnixMs` 取 attempt | `login_start.browser_then_cancel`#1、`busy_rejects_every_flow`#5、`stale_id_keeps_active_attempt`#3 |
| cancel 后恢复 `signed_out`、`lastError: null`（`:483-486`、`:1945-1954`） | `browser_then_cancel`#3 |
| logout 后 generation +1（`:535`），连续两次 logout 再 +1 | `logout.signed_out_increments_generation`#2,#4 |
| `hasUsableSession: true` / `accountHint` / `email` / `planType` / `isFedramp` / session 的 `expiresAtUnixMs` | 阻塞：需 X3 种子（见下） |
| 设备 attempt：`verificationUrl` / `userCode` / `pollIntervalSeconds` | 阻塞：网络 |
| 启动加载失败：phase `error` + `lastError.code: "credential_store_failed"`（`:139-143`） | 阻塞：需 X3 种子 |

### openai_codex_login_start

| 分支 | Rust 位置 | 场景 |
|---|---|---|
| `"browser"` 成功：返回 `{attemptId, authorizationUrl, redirectUri, expiresAtUnixMs}`，只绑定本机 1455/1457，不访问网络 | cmd:26；manager.rs:336-392 | `browser_then_cancel`#0 |
| 未知 flow（空串、大小写、连字符、前导空格、其他值）→ `"Unsupported OpenAI Codex login flow"` | cmd:32 | `unsupported_flow`#0-#4 |
| 未知 flow 判断先于忙检查（有 attempt 时仍是 Unsupported） | cmd:25-33 | `busy_rejects_every_flow`#4 |
| browser 已有 attempt → `LoginBusy` | manager.rs:337,1117-1123 | `busy_rejects_every_flow`#1 |
| `"device_code"` / `"device"` 已有 attempt → `LoginBusy`（在请求设备码之前返回） | manager.rs:395 | `busy_rejects_every_flow`#2,#3 |
| cancel 后可重新开始 browser | manager.rs:482 | `browser_restart_after_cancel`#2 |
| 缺参 / `null` / 非字符串 flow（Tauri 反序列化错误，不是处理函数分支） | — | `ipc.invalid_required_args`#0-#2 |
| `CallbackBind`：1455 和 1457 都被占用 | manager.rs:338,1183-1190 | 阻塞：v0 只有 invoke 步，无法预占端口 |
| `install_attempt` 的竞态 `LoginBusy`（`:1127-1129`） | manager.rs:1125 | 并发时序，差分不可稳定复现，人工审读 |
| 设备码成功 / 网络失败 / 拒绝 / 畸形响应 / 请求中被取消 | manager.rs:412-436,715-758 | 阻塞：网络 |
| `build_authorization_url`、`serde_json::to_value` 的 Err | manager.rs:350-355；cmd:26-30 | 不可达（URL 和结构体都是常量构造） |

### openai_codex_login_cancel

| 分支（manager.rs:467-491） | 场景 |
|---|---|
| 匹配 attempt → `null`，phase 恢复 | `browser_then_cancel`#2、`stale_id_keeps_active_attempt`#4、`busy_rejects_every_flow`#6 |
| 无 attempt → `AttemptNotFound`（UUID 形 id、空串） | `login_cancel.no_active_attempt`#0,#1 |
| id 不匹配 → `AttemptNotFound`，原 attempt 保留（Rust 测试 `stale_cancel_id_does_not_cancel_new_attempt`，manager.rs:2428） | `stale_id_keeps_active_attempt`#1,#2,#3 |
| 同一 id 重复取消 → `AttemptNotFound` | `stale_id_keeps_active_attempt`#5 |
| 旧 attempt id 在新 attempt 存在时 → `AttemptNotFound` | `browser_restart_after_cancel`#4 |
| logout 取消 attempt 后再 cancel → `AttemptNotFound` | `logout.cancels_active_browser_attempt`#3 |
| 缺参 / `null` / snake_case 键 `attempt_id`（Tauri 反序列化错误） | `ipc.invalid_required_args`#3-#5 |
| 前一 phase 为 `reauthentication_required` / `error` 时的恢复（`:1949-1953`） | 阻塞：需种子或网络 |

### openai_codex_logout

| 分支（manager.rs:493-557） | 场景 |
|---|---|
| 无 session：删除凭据（文件不存在视为成功、`settings` 0 行）、generation +1、不发 revoke | `logout.signed_out_increments_generation`#1,#3 |
| 有浏览器 attempt：先取消 attempt、phase 回 `signed_out` | `logout.cancels_active_browser_attempt`#1,#2 |
| 有 session：删除后 best-effort POST revoke（5 秒超时，结果忽略） | 阻塞：种子 + 网络（revoke 地址写死 `https://auth.openai.com/oauth/revoke`） |
| 删除失败 → `CredentialStore`，内存 session 保留（Rust 测试 manager.rs:2562） | 阻塞：需要让 `.secure` 删除失败的种子（例如只读目录），X3 定 |
| `spawn` / `spawn_blocking` JoinError | 不可达（panic 路径） |

### openai_codex_usage

| 分支（manager.rs:261-297、559-587、1009-1021） | 场景 |
|---|---|
| 无 session → `SignedOut` | `usage.signed_out`#0、`logout.cancels_active_browser_attempt`#4 |
| 登录进行中但无 session → `SignedOut`（attempt 不改变结果） | `usage.signed_out_during_browser_login`#1 |
| phase `reauthentication_required` → `ReauthenticationRequired` | 阻塞：从 empty 种子只能经网络到达 |
| 有 session 的成功、401 刷新、二次 401、非 2xx、畸形 JSON、超过 512 KiB、网络失败 | 阻塞：网络（`https://chatgpt.com/backend-api/wham/usage`） |

## 阻塞与所需外部输入

1. **端点写死，无法指向本地模拟服务。** Rust `CodexEndpointConfig::default()`（`openai_codex/protocol.rs:34-59`，常量 `:10-13`）与 TS `src/openai-codex/protocol.ts:9-12` 都写死 `auth.openai.com` / `chatgpt.com`，生产代码没有 env 或配置覆盖；只有 Rust 测试用 `for_test`。因此设备码登录、浏览器回调换 token、刷新、revoke、usage 有 session 的分支都不能在不连互联网的前提下运行，本包没有收录。需要 X5（LLM 模拟服务）与 C1 决定：要么提供让 A/B 两端都把这些主机解析到同一模拟服务的网络层方案（DNS/代理 + 本地 TLS 证书），要么批准新增端点覆盖（会改 Rust 与 TS 生产代码，不在本包范围）。
2. **种子（owner X3）。** 下列场景需要启动前写好的数据目录，因为凭据在 `CodexAuthManager::new`（manager.rs:125-143）里只加载一次：
   - `codex-session-valid`：`settings` 表 `internal.oauth.openai_codex.session` 一行旧明文（或 `.secure` 加密文件），值为 `StoredCodexSession` JSON（`types.rs:11-27`，`schemaVersion: 1`、非空 token/accountId、`expiresAtUnixMs` 远大于当前时间）。可测 status 的已登录字段。注意 `get_secret` 读到旧明文会迁移进 `.secure` 并删该行（database/mod.rs:4289-4316），DB 终态会变化，应 capture。logout / usage 在此种子上仍会访问网络，见第 1 条。
   - `codex-session-corrupt`：同一键的值不是合法 JSON 或 `is_valid()` 为假。可测 status 的 `error` phase、`lastError`，以及之后 browser start/cancel 恢复到 `error`（manager.rs:1951）。
   - `.secure` 删除失败的数据目录：可测 logout 的 `CredentialStore` 错误。
3. **系统 OCR / 平台。** 本 lane 的 `ocr_adapters/system_ocr` 只有 macOS/Windows 实现；Linux 上 `is_platform_supported()` 为假（`system_ocr/mod.rs:62,72`），B 端 native 绑定未提供（BLOCKERS.md L01-02）。不伪造。

## 运行注意（给 X7 运行器）

- 浏览器登录绑定**固定端口** 127.0.0.1:1455，失败退到 1457（manager.rs:31,1183-1190）。同一网络命名空间里并行跑含 `login_start` browser 的场景会互相占端口，导致 `redirectUri` 变化甚至 `CallbackBind`。这些场景需串行或各自独立的网络命名空间。每个场景都以 cancel 或 logout 收尾释放端口。
- `browser_restart_after_cancel`：cancel 只发出取消信号，回调服务器在后台任务里释放监听（manager.rs:489、601-651），紧接着的第二次 start 可能拿到 1457。若 A 两次录制的 `redirectUri` 端口不同，这是真实时序，不是 B 的缺陷。
- 这些场景不需要网络。若运行环境能连外网，结果也不变：包含的分支都在发请求之前返回。

## normalize 候选（未启用）

规则保持 `[]`，等 A 双录后再按协议提交 C2。预计会变化的字段：

| 场景 | JSONPath | 原因 |
|---|---|---|
| 所有含 browser start 的场景 | `$.steps[*].result.attemptId`、status 的 `activeAttemptId` | UUID v4（manager.rs:346）；需保持同一场景内 start 结果、status、cancel 参数之间的对应 |
| 同上 | `authorizationUrl` 的 `code_challenge`、`state` 查询参数 | 随机 PKCE 与 state（manager.rs:344-345） |
| 同上 | `expiresAtUnixMs` | `now_ms() + 300000`（manager.rs:347） |
| `browser_restart_after_cancel` | `redirectUri`、`authorizationUrl` 的 `redirect_uri` | 端口 1455/1457 时序 |

## 剩余命令

本 lane 5 条自有命令都已有场景；未覆盖的分支见上表的“阻塞”行。本 lane 的供应商/OCR 适配器没有自有 IPC，只能经其他 lane 的外层命令到达。这些命令不属于本包，由各自 owner 写场景；本 lane 可提供适配器分支清单：

| 外层命令 | owner | 前端调用点 | 到达的 L01 行为 |
|---|---|---|---|
| `test_api_connection` | L02-llm-manager（`src-tauri/src/commands.rs:3321`） | `src/utils/settingsApi.ts:250`、`ShadApiEditModal.tsx:853` | providers 请求构造 / SSE 解析 / Codex OAuth（`is_openai_codex_oauth_test`，commands.rs:2869） |
| `ocr_extract_text` | L02-llm-manager（`src-tauri/src/cmd/translation.rs:90`） | `src/utils/testApi.ts:142` | ocr_adapters 请求与解析 |
| `test_ocr_engine` 及 OCR 引擎配置命令 | L18-media-docs（`src-tauri/src/cmd/ocr.rs:612` 等） | `src/features/settings/components/OcrEngineTestPanel.tsx:127` | ocr_adapters factory / paddle / deepseek；system_ocr 仅 macOS/Windows |
| `chat_v2_perform_ocr` | L04-chat-session（`dstu-agent/src/chat_v2/handlers/ocr.rs:44`） | `src/quick-assistant/service.ts:223`、`src/features/chat/plugins/modes/analysis.ts:164` | ocr_adapters |

这些外层命令要走真实供应商请求，同样受 X5 本地模拟服务就绪的约束。
