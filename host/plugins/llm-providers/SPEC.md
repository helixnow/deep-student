# L01-llm-providers 行为规格（`host/plugins/llm-providers/`）

<!-- BEGIN GENERATED:spec:header -->
逐条对照 Rust 源码填写（README §3.3）。每节下的清单项全部勾选（`- [x]`）即视为该节完成，ledger 据此计算 B 级；
勾选前在冒号后写明结论与 Rust 依据（文件:行）。生成区块由 `npm run migration:scaffold -- --refresh` 维护。

命令 5 个 · 发出事件 0 种 · 契约：`contracts/ipc/L01-llm-providers.json`
<!-- END GENERATED:spec:header -->

## 全局语义（README §3.3）

<!-- BEGIN GENERATED:spec:global -->
本 lane 全部命令共同适用的约定；与某个命令不同时在该命令一节单独说明。
<!-- END GENERATED:spec:global -->

- [x] Option → null 还是缺省（`skip_serializing_if`）：`CodexAuthStatus` 的 Option 字段没有 `skip_serializing_if`，全部序列化为 `null`（openai_codex/types.rs:140–156）；Host `status()` 同样输出显式 `null`。`CodexUsageSnapshot` 的 `rate_limits` / `rate_limits_by_limit_id` 与窗口内 Option 字段使用 `skip_serializing_if`（types.rs:180–211），Host `parseUsageSnapshot` 用条件展开，空值缺省而非 `null`。
- [x] u64/i64 超过 2^53 的表示：`generation` 按 u64 饱和递增，Host `increment` 以 18446744073709551615n 封顶后转 Number；超过 2^53 会丢精度，但 generation 从 1 起且仅在登录/刷新时递增，正常会话不可达。`expires_at_unix_ms` / `fetched_at` 为 i64 毫秒，远小于 2^53，Host 用 Number 精确承载。
- [x] 字段顺序（serde_json preserve_order）：Rust 结构体按声明顺序序列化；Host 对象字面量保持同一顺序（auth_status 各字段、login_start 的 Browser/Device 结构、usage snapshot），不依赖 HashMap 的枚举顺序做输出契约。
- [x] f32 精度：本 lane 5 个命令没有 f32 字段；usage 的 `used_percent` 为 f64，Host 保留 JSON 数字原值。provider 适配器的 f32 最短表示由适配器测试覆盖，不属于命令结果。
- [x] 错误形状（字符串 / 对象、文案、错误码）与 panic 的前端可见结果：Tauri 命令 `Err` 是字符串，统一为 `OpenAI Codex authentication request failed`（src/cmd/openai_codex.rs:8），未知 flow 为 `Unsupported OpenAI Codex login flow`（同文件 31）；Host 用 `CommandError` 抛同文案，内部 `CodexAuthError` 的 Display 只写日志。`status.last_error` 是对象 `{code, message, class}`，与 `CodexAuthErrorDto` 一致（types.rs:15）。
- [x] 取消：CancellationToken / drop → AbortSignal，取消点一致：Rust 命令没有 CancellationToken；`login_cancel` 中止进行中的 attempt，`logout` 也中止 attempt。Host 每个 attempt 持有 AbortController，取消点与 Rust 相同（设备轮询的 sleep/exchange、浏览器回调等待/exchange）；命令 RPC 中断不会撤销管理器操作，与 Rust async 任务继续执行一致。
- [x] 并发：锁 / 单写者 / 队列在 Node 中的对应（await 交错）：所有状态变更经 FIFO `RefreshGate`（对应 Rust `refresh_gate` 互斥），刷新串行；同一时刻仅一个 active attempt，再次登录返回 `another Codex login is already in progress`；状态读取在单个同步段内完成，无 await 交错。
- [x] 时间与 ID：生成方式、格式、时区：时间统一 `Date.now()` 毫秒（Rust `SystemTime`）；`attempt_id` 与请求 id 用 UUID v4；OAuth state 用 32 字节随机、PKCE verifier/challenge 按 RFC 7636；过期时间由当前时间加 TTL（浏览器 300s、设备 900s，服务端 `expires_in` 夹到 60–900s）；均为 Unix 毫秒，无时区。
- [x] 不对含 HashMap 的结构做序列化后比对：`rate_limits_by_limit_id` 在 Rust 是 HashMap；测试只按 key 取值断言，Host 保留响应插入顺序但不用于相等比较。

## 命令 `openai_codex_auth_status`

<!-- BEGIN GENERATED:cmd:openai_codex_auth_status -->
- Rust：`src-tauri/src/cmd/openai_codex.rs:12` · async
- 前端：app（1 处，例 `src/hooks/useVendorModels.ts:163`）
- 契约：`contracts/ipc/L01-llm-providers.json`
  - 参数：（无）
  - 结果：CodexAuthStatus · 错误：string · 注入：state
<!-- END GENERATED:cmd:openai_codex_auth_status -->

- [x] 输入：无参数；插件注入 `settings` 供凭据存储读取。
- [x] 输出：`CodexAuthStatus` camelCase（openai_codex/types.rs:140–156）。`phase` 为 snake_case 枚举（signed_out/authorizing/authenticated/refreshing/reauthentication_required/error），`activeLoginKind` 为 browser/device/null，所有 Option 字段显式 `null`，`generation` 从 1 起，`lastError` 为 `{code,message,class}` 或 `null`。
- [x] 错误：Rust 恒返回 `Ok`；管理器构造时凭据读取失败折叠为 `phase=error` + `lastError`（`CodexAuthError::CredentialStore`），不向命令抛错。Host 与之一致。
- [x] 事件：无。
- [x] DB 读写：构造管理器时从 settings 安全存储读取 codex 凭据一次（openai-codex/store.ts `load`）；本命令只读且不写。
- [x] 取消/并发：无取消参数；状态快照在单个同步段内完成，无 await 交错。
- [x] 时间/ID：不生成 ID 或时间；`expiresAtUnixMs` 原样返回会话/attempt 的值。

## 命令 `openai_codex_login_cancel`

<!-- BEGIN GENERATED:cmd:openai_codex_login_cancel -->
- Rust：`src-tauri/src/cmd/openai_codex.rs:36` · async
- 前端：none
- 契约：`contracts/ipc/L01-llm-providers.json`
  - 参数：attemptId: string
  - 结果：null · 错误：string · 注入：state
<!-- END GENERATED:cmd:openai_codex_login_cancel -->

- [x] 输入：`attemptId: string`，须与当前 active attempt 的 id 完全一致。
- [x] 输出：`null`。
- [x] 错误：无匹配 attempt 时返回 `AttemptNotFound`，经 `command_error` 映射为固定文案；重复取消同样返回该错误（openai-codex/manager.ts `cancelLogin`）。
- [x] 事件：无；取消后的状态通过 `auth_status` 轮询观察。
- [x] DB 读写：无。
- [x] 取消/并发：持有 FIFO `RefreshGate`，清空 `activeAttempt`、恢复原 phase、`abort()` 对应 AbortController；后台登录任务收到 Cancelled 后记录 `lastError`，不会写入会话。
- [x] 时间/ID：不生成 ID 或时间；只使用传入的 `attemptId`。

## 命令 `openai_codex_login_start`

<!-- BEGIN GENERATED:cmd:openai_codex_login_start -->
- Rust：`src-tauri/src/cmd/openai_codex.rs:19` · async
- 前端：none
- 契约：`contracts/ipc/L01-llm-providers.json`
  - 参数：flow: string
  - 结果：Value · 错误：string · 注入：state
<!-- END GENERATED:cmd:openai_codex_login_start -->

- [x] 输入：`flow: string`，仅接受 `browser`、`device_code`、`device`（src/cmd/openai_codex.rs:19–33）。
- [x] 输出：`serde_json::Value`，实际为 `BrowserLoginStart {attemptId, authorizationUrl, redirectUri, expiresAtUnixMs}` 或 `DeviceLoginStart {attemptId, verificationUrl, userCode, expiresAtUnixMs, pollIntervalSeconds}`，camelCase（openai_codex/types.rs:158–175）。
- [x] 错误：未知 flow → `Unsupported OpenAI Codex login flow`；已有 attempt → `LoginBusy`；回调端口占用 → `CallbackBind`；设备授权/令牌交换失败 → Network/OAuth 错误；除未知 flow 外均映射为固定 command_error 文案并记录 Display。
- [x] 事件：无 Tauri 事件；登录进度通过 `openai_codex_auth_status` 轮询。
- [x] DB 读写：启动阶段不写；登录成功后在后台任务调用 `store.save`（settings 安全存储）持久化会话。
- [x] 取消/并发：同一时刻仅一个 active attempt，存在 attempt 时再次启动返回 `LoginBusy`；后台任务持有 AbortController，由 `login_cancel` / `logout` 中止。
- [x] 时间/ID：`attemptId` 为 UUID v4；浏览器 TTL 300s、设备 TTL 900s（服务端 `expires_in` 夹到 60–900s）；轮询间隔夹到 1–60s；过期时间为 Unix 毫秒。

## 命令 `openai_codex_logout`

<!-- BEGIN GENERATED:cmd:openai_codex_logout -->
- Rust：`src-tauri/src/cmd/openai_codex.rs:48` · async
- 前端：none
- 契约：`contracts/ipc/L01-llm-providers.json`
  - 参数：（无）
  - 结果：null · 错误：string · 注入：state
<!-- END GENERATED:cmd:openai_codex_logout -->

- [x] 输入：无参数。
- [x] 输出：`null`。
- [x] 错误：凭据删除失败 → `CodexAuthError::CredentialStore`，映射为固定 command_error 文案；远端吊销失败被忽略（本地删除已提交，openai-codex/manager.ts `logoutTransaction`）。
- [x] 事件：无。
- [x] DB 读写：删除 settings 安全存储中的 codex 凭据；随后尽力 POST revoke（5s 超时），失败不改变结果；未登录时调用仍成功（幂等）。
- [x] 取消/并发：持有 `RefreshGate` 串行执行；取消 active attempt；`generation` 递增使旧请求 auth 失效。
- [x] 时间/ID：`generation` 饱和递增；吊销请求超时 5s；不生成对外 ID。

## 命令 `openai_codex_usage`

<!-- BEGIN GENERATED:cmd:openai_codex_usage -->
- Rust：`src-tauri/src/cmd/openai_codex.rs:57` · async
- 前端：none
- 契约：`contracts/ipc/L01-llm-providers.json`
  - 参数：（无）
  - 结果：CodexUsageSnapshot · 错误：string · 注入：state
<!-- END GENERATED:cmd:openai_codex_usage -->

- [x] 输入：无参数。
- [x] 输出：`CodexUsageSnapshot {rateLimits?, rateLimitsByLimitId?, fetchedAt}`，camelCase；空 Option/HashMap 缺省；窗口内 Option 字段缺省（openai_codex/types.rs:177–211）。
- [x] 错误：未登录 → `SignedOut`；需重新认证 → `ReauthenticationRequired`；401 强制刷新后仍 401 → `OAuthRejected(unauthorized_after_refresh)`；非 2xx → OAuth 拒绝；成功响应非 JSON → `MalformedResponse`；均映射为固定 command_error 文案。
- [x] 事件：无。
- [x] DB 读写：普通查询只读；访问令牌临近过期时经 `RefreshGate` 刷新，刷新成功会 `store.save` 持久化新会话。
- [x] 取消/并发：刷新经 FIFO `RefreshGate` 串行；401 时仅强制刷新并重试一次；命令无取消参数。
- [x] 时间/ID：`fetchedAt = Date.now()` 毫秒；HTTP 请求 id 为 UUID v4。

## 服务接线（ARCHITECTURE.md §3 / 指令 4）

- `llmAdapters`：由本插件提供，`createAdapter` 覆盖 openai / openai_responses / anthropic / gemini；`ProviderAdapter` 构造时接收插件 logger，Rust 流错误与 Gemini 转换警告经 `ctx.logger` 记录。`prepareRemoteImages` 通过 `host/platform/net-policy` 的 `fetchBinaryWithCache` 下载 http(s) 图片并改写为 `data:` URL；`index.ts` 同时注册同步缓存读取器供 `buildRequest` 使用（L01-01）。
  - ToolCall 提供方数值候选（V2-02 / X6-UD-0040）：OpenAI emit 工具对象使用精确 clone 保留本地数字旁带，标准 `function.arguments` 字符串仍原样传递，不提前解析；非标准对象通过公开 `cloneProviderToolCall` / `stringifyProviderToolCall` 最小接缝供 owner 消费。Anthropic base input 在父 holder 上捕获数字原文并复用现有 DbJson，partial buffer 经现有 Value 接受集校验后复用共享 lossless parser/serializer，输出 Rust arbitrary_precision 数值而非 Number 近似值。`1E0` 规范化 `1e+0`、`1.0` 保浮点、整数-0输出0、重复键last-wins/空白压缩；合法null不是解析失败。非空坏buffer仍{}而不回落baseInput，空白buffer才用存在的baseInput，签名先于ToolCall。实际事件联合类型没有 bigint/JsonFloat：内部旁带跨普通clone/stringify/进程会丢，消费方接入前不能签端到端；标准字符串首次parse损失在L02，不误归L01。详见 TOOLCALL-PRECISION.md，未知来源/未查协议仍未知。
- `llmCodexAuth`：由本插件提供，与五个 `openai_codex_*` 命令共享同一个 `CodexAuthManager` 实例（同一 `manager` Promise）。方法：`status`、`requestAuth`、`refreshAfterUnauthorized`、`markReauthenticationRequired`、`responsesEndpoint`、`prepareRequest`（`prepare_provider_request`）、`sendWithSingleRefresh`（`send_codex_request_with_single_refresh`，非流式：SSE→Responses JSON bridge）、`sendStreamWithSingleRefresh`（流式原语，401 只刷新一次）（L01-03）。
  - 03.a：`prepareRequest` 优先使用 L02 传入的 `effectiveApiProtocol`；本地兜底同样让显式 `openai_chat_completions` / `anthropic_messages` / `google_generate_content` 高于 `supportsOpenaiResponses` / `providerType`，与 `mod.rs:3989-3999` 一致。
    - 协议字符串规范化补充候选（沿 L01-03）：`normalizeProtocolValue` 复用 `rustTrim`，保留 Unicode lowercase，与 `llm_manager/mod.rs:3775-3776` 相同。NEL（U+0085）属于 Rust White_Space，BOM（U+FEFF）不属于；JS trim 的相反归类曾反转显式 chat 与 Responses fallback 的选择。仅修 trim，不替代 L02 完整协议注册表或扩签已审分支；新增两条真实 `ctx.llmCodexAuth.prepareRequest` 用例，不改旧断言。
  - 03.b：非 2xx 响应经 `normalizeCodexErrorResponse` 有界读取（256 KiB）、净化错误体、404 usage-limit 映射 429；响应头去掉 content-length/encoding 并强制 JSON。错误码严格按 Rust Option 链取 `/error/code` → `error`(string) → `code` → `/detail/code` 的第一个字符串，再只 sanitize 一次；首个字符串为空/非法时直接走全文关键词/HTTP fallback，不继续取次级字段。
  - 03.c：每次 POST 在循环内独立创建 `AbortSignal.timeout`；token refresh 不占用任一次 POST 的超时预算。
  - 03.d：配置头非法/冲突按 Rust 文案 warn；`installCodexHeaders` 构建/编码失败映射为 `Configuration`（“构建请求头”/“编码请求头”）。
  - 03.e：`sendWithSingleRefresh` 真实调用 `bridgeCodexNonstreamResponse`（32 MiB 有界、严格 UTF-8、SSE→Responses JSON），不再把 bridge 留给调用方。
  - 03.b/03.e 字节与头字段补充候选：`model2_pipeline.rs:4723-4734` 先对完整 Content-Type 做 `HeaderValue::to_str`，非可见 ASCII 值原样透传，不先删 MIME 参数或 JS trim 后误判 SSE；`:4704` lossy 错误正文解码和 `:4746-4747` 严格 SSE 解码都保留 BOM。错误正文仍 lossy（不能改严格），SSE 复用 F4 `decodeUtf8Strict`。JWT claims 同样按 `manager.rs:1343` 保留 BOM 交 JSON 解析，非法首 BOM 不得被修复成可用的另一账户 claims。四项新增真实 HTTP/服务回归，不外推 typed token/IgnoredAny 或完整协议签收。
- `llmOcr`：由本插件提供，暴露 `OcrAdapterFactory` 的创建、可用引擎与引擎信息方法。
- `llmMultimodal`：由本插件提供，暴露分块器、`MultimodalEmbeddingService` 构造与附件预览解析；logger 随服务注入。
- 待接线：完整 `MultimodalEmbeddingServiceRuntime` 的高层配置判定、multimodal embedding、embedding API 和 OCR raw-prompt 方法仍缺正式消费面。L02 已在 `llmEmbeddingModels` 发布两个模型配置 getter，并新增 raw-prompt/OCR 服务；不能再概称所有低层符号都未发布，但这些不等同完整 runtime 已接入。精确缺口见 BLOCKERS.md。
- 跨 lane 接线：主发送图片预取/Codex 共享认证，以及 R1 L02-01 指定 Model2/OCR shared-prepare 分支均沿既有签收，不重开；剩余 usage 精确消费/落库、多模态高层及 native OCR 等以 BLOCKERS.md 为准，不再称已签路径“完全未交付”。
- 平台模块：`host/platform/util`、`host/platform/time` 与 `host/platform/net-policy` 已接入本 lane——`rustTrim` 来自 `host/platform/util`，Codex usage 的 RFC3339 解析来自 `host/platform/time`，远程图片下载使用 `host/platform/net-policy` 的 SSRF 校验与缓存。
- 共享 SSE/UTF-8（已接入 main 的 F4 实现）：`host/platform/util/api.ts` 已导出 `Utf8StreamDecoder` / `SseLineBuffer` / `SseEventBuffer` / `extractStreamDataPayload` / `setSseBufferLogger`。本 lane 已删除 `src/sse-buffer.ts`（16 MiB 本地副本）与 `src/json.ts::extractStreamDataPayload`，四个生产 parser 改从 `host/platform/util/api.ts` 消费，测试 `SseEventBuffer` 同源；生产 logger 由 `dstu.platform.log` 绑定，L01 不调用 `setSseBufferLogger`，卸载不误清共享 logger。旧尾 CR 残差已由 F4 `d1d251987` 在 main 修复，不再保留为未解阻塞。
- 整数宽度（V2-02，standard-v2 §1.3 / D3）：dstu-llm 的 serde_json 开启 `arbitrary_precision`（`src-tauri/crates/dstu-llm/Cargo.toml:40`），整数字段与 `as_u64`/`as_i64` 只接受整数字面量，范围为完整 64 位。`src/json.ts::parseJsonExact` 借 JSON.parse 源文本记录数字字面量，`fieldU64`/`fieldI64` 按此判定。落点：凭据 `StoredCodexSession`（u8/i64/Option<i64>，`types.rs:11-27`）→ `store.ts`；`OAuthTokenResponse.expires_in: Option<i64>`（`manager.rs:95-103`）→ `manager.ts tokenRequest`；设备授权 `interval`/`expires_in`（`manager.rs:746-751,425`，u64 先 clamp 再收窄）；usage `integer_at`/`timestamp_at`（`manager.rs:1774-1792`）与窗口算式（u64 `saturating_add(59)/60`、`seconds as i64` 及 release 构建的 i64 加法均按 64 位回绕，`manager.rs:1737,1745`）以 BigInt 计算，IPC 边界按 D3 转 number。附件预览 `usize` 上限改为 u64（原 JS 安全整数上限会多拒绝合法值）。测试：`tests/codex-integer-width.test.ts`，经 IPC 命令与 `ctx.llmCodexAuth`/`ctx.llmMultimodal` 调用。
  - 重复字段与嵌套深度（V2-03）：`parseJsonExact` 在 JSON.parse 之后扫描原文本，按容器记录原始键序列（重复键 JSON.parse 取后者，与扫描一致）和数字字面量，嵌套深度 ≥128 视为解析失败（serde_json 默认 recursion limit）。`duplicateField` 模拟 serde struct 的 `duplicate field`：别名与正名占同一字段，未知键（含重复）忽略。落点：`StoredCodexSession`（store.ts → CredentialStore）、`OAuthTokenResponse`（tokenRequest → MalformedResponse `token response`）及预览的值级API。WP-017的预览文本入口改用F4流式typed reader，详见下节。serde `Value` 路径（usage、JWT claims）保持后者覆盖，与 serde_json Map 插入一致。
  - Codex 会话时间精度（V2-02 新候选，未独立签收）：Rust `StoredCodexSession` 的 `expires_at_unix_ms: i64` / `last_refresh_at: Option<i64>`、`CodexRequestAuth` 的 i64 返回值在 Host 内部保持 bigint；`store.load/save/clone` 不再转 Number，保存复用 `platform/util/lossless-json.ts::stringifyJsonLossless`（`sync/api.ts` 转出的同一函数），输出 JSON 数字而不是字符串。`OAuthTokenResponse.expires_in` 也保持 bigint，`expiryFromResponse` 按 `manager.rs:1794-1798` 先 clamp 60..86400 秒再 i64 saturating_add；刷新/可用性比较使用整数时钟。服务 `status()` 返回 `CodexAuthState`（精确时间），只有 `index.ts` 的 `openai_codex_auth_status` IPC DTO 转 number。原 IPC 数字形状不变，原合法 i64 输入不收窄。尚未解决的 usage/rate-limit 内部数值、generation/counter 和重复字段首错顺序不属于本时间修复的完成声明。
  - 词法接受集（X6-UD-0040）：`parseJson` 与 `parseJsonExact` 现为同一实现，额外拒绝未配对代理项转义（serde_json read.rs validate=true）与深度 ≥128；`fieldU64` 接受 `-0`（arbitrary_precision 存为整数 0）。入站 `as_f64` 用 `f64()`（过滤非有限值），入站 `as_i64`/`as_u64` 用 `i64At`/`i32At`/`u64At`（按字面量，`as i32` 在精确值上截断）。附件预览 usize 字段在 Host 内部为 bigint。开放：provider StreamEvent usage 数值的 JsonValue 合约（见 LANE.md）。
  - 附件预览文本接缝：Rust 消费方是 L12 `dstu-vfs/src/vfs/multimodal_service.rs:1378` 的 `serde_json::from_str::<AttachmentPreview>`。`ctx.llmMultimodal.parseAttachmentPreviewJson(text)` 从存储文本判定；`parseAttachmentPreview(value)` 收到普通 JSON.parse 结果时，`1.0` 与 `1`、超过 2^53 的字面量、重复键已不可区分。生产精度取决于 L12 改用文本接缝（BLOCKERS.md）。
  - 预览 struct sequence（V2-03 / WP-017）：除 map 外，允许 `[pages,dpi,page_count,rendered_at]` 及 `[page_index,blob_hash,width,height,mime_type,compressed_blob_hash]`，按 Rust 声明顺序读取。Preview 后三个字段有 default；Page 的 blob_hash 虽为 Option，但无 default，所以序列的第二槽必须存在（可为 null），map 缺省仍为 None。文本入口直接使用F4 typed数字与endArray，usize保持bigint；读满槽后拒绝额外内容而不解码它。对象unknown使用IgnoredAny，已知字段错误优先于后续词法错误；验证与消费边界见WP-017小节。
  - Codex struct sequence 补充候选（V2-03）：`StoredCodexSession` 接受声明顺序的十槽序列，末个必填字段为第六槽 accountId；后续 email/planType/isFedramp/lastRefreshAt 缺省按原 serde default。i64 在原数组容器上按原文字面量读取，save 仍输出 canonical camelCase object。成功 `OAuthTokenResponse` 接受 `[access_token,refresh_token,id_token,expires_in]`，后三槽有 default；域内 `decodeTokenResponse` 共用对象/序列的强类型校验，拒绝额外槽，完整结构校验后才执行 access_token 非空规则。错误仍映射 CredentialStore / MalformedResponse，非2xx Value 路径不改。成功 typed 的全字节/未知字段/首错语义仍未解决，不扩签完整 decoder。
  - 未独立复验的其余typed路径（Store/Token和值级预览）：错误文本与 serde 原文不逐字一致；类型错误与重复字段同时出现时，TS仍可能先报重复字段。WP-017仅修复预览文本入口的顺序和原始错误detail，不将该结果外推到其他decoder。
  - 上述接受/拒绝集合也不能外推为全部 typed struct 等价：新静态核查发现直接 `Deserialize<i64/usize>` 与 `Value::as_i64/as_u64` 对 `-0` 的路径不同；未知字段 `IgnoredAny` 不走完整 Value 解码，对代理项/深度/超大数值的接受集也不同。先整文档 `parseJsonExact` 后 struct 校验的接缝尚未解决全部差异；按 V2-02/V2-03 原 ID 保持未决，见 LANE.md 两个只读 probe。初次锁反例时未改已签用例；后续纠正撤回子项的依据见下一条，不声称独立 Rust 执行。
  - R1 `c7bd5d5ce` 已独立亲读锁定版本确认上述区别，并撤回旧未知 x 深度拒绝的等价子项（不撤真实执行事实）。`typedI64`/`typedU64` 用于 Store / OAuthTokenResponse / 值级Preview，预览文本入口的F4 readUnsigned同样拒绝原文 `-0`；Value 的 `fieldI64`/`fieldU64` 保留 `-0`→整数0。旧 typed -0 断言依该 Rust 证据纠正，真正 Value 深度另经 provider stream 测。WP-017在F4 main接口上完成预览文本首错/unknown/sequence，原深128正确接受向量由文档pending恢复为活动回归；其历史和后续独立复验条件保存在PENDING.md。
  - HTTP 字节边界（X6-UD-0040 新候选）：Codex usage/device authorization/device poll 的 Value 正文和各非2xx错误 Value 正文复用 `decodeUtf8Strict` 后解析；无效字节不以 U+FFFD 修复后接受，合法 U+FFFD 保留。成功分支按原 Rust 映射 MalformedResponse；错误分支按 `parse_error_body` 回 Null，不因修复后的 invalid_grant 误触发重新认证。成功 typed token 正文的字段级字节/首错解码仍未决，不能套 Value 的整正文严格校验来收窄合法 IgnoredAny 输入。
  - 非有限 f64 出站（X6-UD-0040 新候选）：`manager.rs:1766-1771` 允许百分比字符串按 f64 解析，`NaN` 经 :1710-1716 clamp 后仍为 NaN。内部解析结果保持不变；`openai_codex_usage` IPC handler 调用专用 `codexUsageToWire` 创建副本，按 serde_json1.0.149 `ser.rs:169-178` 将非有限 usedPercent 编码为显式 null。`Some(NaN)` 不得省略，`None` 不新增键；有限值及其他字段不变。不是改 `parseRustF64` 拒绝合法输入，也不是通用 JSON serializer 或共享类型变更；rate-limit 整数内部精度及其余边界仍开放。
  - Rate-limit 整数内部精度补充（V2-02 候选）：新增仅 L01 内部的 `CodexUsageState`，windowDurationMins(u64)、resetsAt(i64)、fetchedAt(i64) 为 bigint。`parseUsageSnapshot` / manager 保持该表示，重置时间按 `manager.rs:1745` 用 bigint 做有符号除法及 release wrapping；不再在 parseWindow 内 Number 化。只有真实 usage IPC handler 的现有 `codexUsageToWire` 产生 number 副本，仍保上述 NaN→null 语义。生成契约/API DTO 和等待 L02 同批的 provider StreamEvent Usage 类型未改；本项是候选，不签完整 D3 或其他 rate-limit 输入顺序问题。
- 仍为本地实现：`parseRustF64`、`parseU32`、`asciiLowercase`。证据：`host/platform/util/api.ts` 当前未导出对应函数；发布后删除 `src/json.ts` 中的实现并改用平台模块。

## WP-017 · AttachmentPreview typed text decoder（V2-03 / X6-UD-0040）

行为依据为 `dstu-llm/src/multimodal/page_indexer.rs:17-50`，消费原文位置为
`dstu-vfs/src/vfs/multimodal_service.rs:1378-1379`。main `967f43c75` 已提供 F4
`JsonReader`、`skipIgnoredValue`、`endArray` 和 enum 原语；两个 preview struct 没有枚举字段。

| Rust 分支 | L01 typed 文本落点 / 必须验证的断言 |
|---|---|
| serde_derive1.0.228 struct_.rs:266-290,304-325 | map 按原文键序：已知键先查重复再读值；null Option 仍占槽；别名占同一槽；关闭对象后才报必填缺失 |
| page_indexer.rs:19-25 | pages 必填 Vec；dpi Option<u32>、page_count Option<usize>、rendered_at Option<String>，后三个字段 default |
| page_indexer.rs:35-50 | page_index 必填 usize；blob_hash Option<String> 无 default；其余四个 Option 有 default；精确对应六组别名 |
| serde_derive de.rs:451-506,805-835 | 序列按声明顺序；根至少一槽、Page 至少两槽（blob_hash 可 null）；default 尾槽缺省 |
| serde_json1.0.149 de.rs:1072-1086,1820-1865 | 固定槽读满后调用 F4 endArray，不解码多余值；先前字段错误优先；根完成后 end 检查尾随字符 |
| serde_json de.rs:1102-1281,1910-1915 | 未知字段显式 skipIgnoredValue：深128/更深、孤代理转义、超f64数字可忽略；坏JSON词法仍失败 |
| serde_json de.rs:319-341,462-524 | typed 数字使用 readUnsigned；usize bigint 全u64域，u32才转number；-0/1.0/指数拒绝，不套用 arbitrary_precision Value 接受规则 |

文本入口保留现有 `invalid attachment preview: ...` 包装及已被调用方测试锁定的
`invalid type for \`field\`` / `invalid JSON` 上下文；同时携带共享 reader 的完整错误
Display（行/UTF-8列）及 `cause: JsonSyntaxError`。首错由读取时决定，不能先扫描整篇。
原值级 API 仍只判断已构造 JsonValue，不能复原预解析丢失的token/重复键，不作为文本入口实现。
这里无SQL、文件写入、异步取消、时钟或日志分支。实际提供链为
`index.ts:61 → MultimodalService.parseAttachmentPreviewJson → page-indexer.ts`。
L12 `vfs-index/src/multimodal-service.ts:583` 仍调用自身 parsePreviewJson，跨owner生产索引接入
继续登记 BLOCKERS；本包只验证真实L01插件公开服务，不宣称L12整链已切换。

## D4 · llm-replay 确定性 LLM 回放 provider（WAVE2-BRIEF §8）

用途：测试与 G3 录制里用进程内回放代替 `host/e2e/streaming/wave0/llm-service.ts` 的 HTTP 模拟服务——
同样的脚本、同样的响应字节与请求日志，但不开端口、不触网、不受套接字时序影响。Rust 侧没有对应物，
不是迁移项；不产生 RUST-FIX。

- 组成：`src/replay/answer.ts`（唯一的应答实现：请求 → 日志项 + 应答，不涉及传输）、`wire.ts`（脚本格式与 chat 渲染）、
  `builtin.ts`（内置脚本 `LLM_REPLAY_SCRIPTS`）、`directive.ts` / `embeddings.ts` / `transcriptions.ts`（`w0.directive`、
  `/embeddings`、`/audio/transcriptions`）、`scripts.ts`（脚本校验、旁车读取）、`service.ts`（`fetch` 传输：`createLlmReplay` →
  `LlmReplayService`）、`plugin.ts`（`dstu.llm-replay`，提供 `llmReplay` 服务）。只用 Web 标准 API（`Request`/`Response`/
  `ReadableStream`/`URL`/`TextDecoder`/`DataView`）与纯 JS 的 `@noble/hashes`（转写日志里文件的 sha256），无 Node 依赖。
- 与 G3 模拟服务同一份代码：`host/e2e/streaming/wave0/llm-service.ts` 是 `answer.ts` 之上的 `node:http` 传输（W05 r6 起），
  内置脚本表即 `LLM_REPLAY_SCRIPTS`。因此 llm-service.ts 引入的 `answer.ts`、`builtin.ts`、`wire.ts`、`directive.ts`、
  `embeddings.ts`、`transcriptions.ts` 属于 G3 `llm` 输入闭包（`scripts/electron-migration/record/g3-inputs.mjs`）：改动其中任何一个，
  用到模拟 LLM 服务的 A 录制过期、需要重录。目前 `g3-services.mjs:35` 动态导入 llm-service.ts，这些文件也在对每个场景生效的
  `recorder` 闭包里，即全部 A 录制过期（交接 W13，见 `host/plugins/llm/W05-PROGRESS.md`）。`service.ts`、`scripts.ts`、`plugin.ts`
  不在 `llm` 闭包内。
- 默认关闭：插件不在 `host/profiles/*` 任何 profile（生成器只收 `host/plugins/<name>/index.ts`），也没有设置项；只有测试或录制宿主
  显式 `[llmReplayPlugin, { scripts?, extraScripts? }]` 才会出现（`scripts` 缺省为内置脚本）。未挂载时 llm 插件对所有请求的行为与此前完全相同（见 llm SPEC）。
- 寻址：`replay.baseUrl(id)` = `http://llm-replay.invalid/s/<encodeURIComponent(id)>/v1`，作为 ApiConfig.baseUrl；其后接
  `chat/completions`、`embeddings` 或 `audio/transcriptions`。
  `.invalid` 是 RFC 6761 保留域，回放未挂载时这类请求解析不到任何主机。
- 脚本：轮次脚本 `{description, rounds}`（轮次 = 最后一条 user 之后带 `tool_calls` 的 assistant 数；`sse` 帧渲染为固定
  `id`/`created`、回显 `model`；`end` 为 `done`/`eof`/`hold`；`http-error`；非流式请求折叠为一个 completion）、推导脚本
  `{description, derive(请求体)}`（每轮由请求体直接给出；`derive` 的结果逐次校验，不合法即 `service-error`）与旁车
  `{description, responses}`（`providerSidecarScripts(<套件>.provider.json)`，按到达顺序原样返回，游标按“脚本 × 实例”）。
  内置脚本：`success.answer`、`success.thinking`、`success.empty`、`error.eof-after-partial`、`error.http-500`、
  `interrupt.hold-after-partial`、`tool.second-round`、`w0.directive`（规则见 wave0 README）。脚本在创建时校验并深拷贝，
  不合法即抛错（插件挂载失败）；`extraScripts` 不得与 `scripts` 重名。
- 路由：chat 见上；`/embeddings` 的向量只由请求体决定（任意脚本 id，只有第 0 轮为 `http-error` 的轮次脚本改变应答）；
  `/audio/transcriptions` 解码 multipart，用轮次脚本第 0 轮的正文按 `response_format`（json/text/verbose_json）应答，旁车按序
  原样返回，推导脚本 409 `unscripted-route`。字段与格式见 wave0 README。
- 请求日志 `requests` 与 `LoggedRequest` 同形；`whenIdle`/`openCount`/`stop` 语义相同，可以直接作为 wave0 `runScenario(..., { llm })`。
- 失败路径（与 HTTP 服务同状态码、同 JSON 错误体）：不是上述三个 POST 路由 → 404 `not-found`；未知脚本 → 404
  `unknown-script`；请求体非 JSON → 400 `bad-json`；无工具可调 → 400 `no-tool-offered`；轮次/旁车用尽 → 409 `unscripted-round`；
  embeddings：400 `bad-embedding-request`、404 `unknown-embedding-model`；转写：400 `bad-multipart`、`bad-transcription-request`、
  `unsupported-response-format`，409 `unscripted-route`；`w0.directive`：400 `no-directive`、`ambiguous-directive`、`bad-directive`。
  回放自身异常 → 记一条 `service-error` 并以 `TypeError('fetch failed')` 失败（同 HTTP 服务断开连接），绝不转去真实网络。
  `stop()` 之后的请求同样以网络错误失败且不记日志。已中止的 signal 直接以其 reason 拒绝。
- 中止：`hold` 流在客户端中止或取消读取时记 `client-closed`，`stop()`/插件卸载时记 `server-stopped`；有限流的日志在建响应时
  一次记完（HTTP 服务的 `write` 回调同样不等客户端读取），之后中止只让响应体以中止原因出错，不改日志。
- 与 HTTP 服务仅有的差异（传输层）：日志 `raw.requestHeaders` 只含应用给出的请求头（小写），没有 undici 补的 host/accept/user-agent 等；
  响应头没有 `connection`/`transfer-encoding`/`date`；块按宏任务逐个交付（不受装假计时器影响），不模拟套接字分包。
- 前端 / i18n / 设置：无。这是测试与录制基础设施，不对用户可见；不新增命令、事件或设置键。
- 移动端：模块可移植，插件声明 `platforms: ['desktop', 'mobile']`；移动端测试宿主可同样挂载。生产 mobile profile 不包含它。
- 接入面（llm 插件 `withLlmReplay`）：内部 `http.fetch`（unified_model2、llmStreaming、llmModel2Streaming、raw prompt、embedding、reranker、
  OCR、RAG、作文传输）、`llmHttp` 服务（translation、media 生图；memory 的学术检索走非回放 URL，照常放行）、
  `test_api_connection` / `fetch_vendor_models` 的直连 fetch。不覆盖：Codex OAuth 与 OpenCode Go usage（固定端点）、
  media `voice-input.ts` 直接用全局 fetch（W04 路径，未改）。既有各测试自带的 LLM 桩（`startLlmService`、手写 SSE 服务、
  `stubGlobal('fetch')`）不迁移；传输层测试应继续用真实套接字。
- 测试：`tests/llm-replay.test.ts`（行为与失败路径）、`host/plugins/llm/tests/replay_fetch.test.ts`（路由、默认关闭、真实命令/服务）、
  `host/e2e/streaming/wave0/llm-replay.test.ts`（与 llm-service.ts 逐字节/逐日志对拍：内置脚本表、全部轮次脚本、`w0.directive`、
  embeddings、转写、旁车三路由、共用失败路径；经真实聊天管线四个场景与 HTTP 录制对比）。
