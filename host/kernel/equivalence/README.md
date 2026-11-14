# F1-kernel 波次0 场景 v0（WP-048）

范围：内核插件管理/配置的前端可达命令，共 11 条（`contracts/ipc/F1-kernel.json` 全部命令）。
格式按 `board/WAVE0-EQUIVALENCE.md` §3 v0。这些场景**未在 A/B 上运行，不计 C 级**；`expect: "error"`
只是注释，结果以 A（Tauri+Rust）的实际返回为 oracle。

| 文件 | 场景数 | seed | 说明 |
|---|---|---|---|
| `plugins.json` | 34 | empty | 只用 11 条 F1 命令 |
| `plugins-seeded.json` | 17 | empty | 先用 L19 `save_setting` 写入设置/凭证，再调 F1 命令；用 L19 `get_setting` 观察安全存储 |

所有场景都写 `capture: {events: true, db: ["*"]}`，`normalize: []`（Rust 双录尚未完成，只列候选，见文末）。

## 1. 命令来源表

前端入口：`src/features/settings/api/pluginsApi.ts`（invoke 包装）→ `src/features/settings/components/plugins/PluginsTab.tsx`（调用点）。
Rust 入口：`src-tauri/src/plugins/commands.rs` → `manager.rs`（PluginManager）→ `ilink_bot/mod.rs`（唯一插件 `ilinkbot`）。
ACL：11 条均在 `src-tauri/permissions/application-commands.toml:658-668`。B 端注册：`host/kernel/plugins.ts:82-122`。

| 命令 | invoke 包装 | 真实 UI 调用点 | Rust 命令 | Rust 实现 |
|---|---|---|---|---|
| plugin_list | pluginsApi.ts:56 | PluginsTab.tsx:491 | commands.rs:11 | manager.rs:119-145 |
| plugin_get_status | pluginsApi.ts:59 | PluginsTab.tsx:86 | commands.rs:32 | manager.rs:147-156；mod.rs:742-761 |
| plugin_get_config | pluginsApi.ts:60 | PluginsTab.tsx:78 | commands.rs:40 | manager.rs:289-293；mod.rs:763-785 |
| plugin_set_config | pluginsApi.ts:61-62 | PluginsTab.tsx:164（375/399/413 单字段 patch） | commands.rs:48 | manager.rs:295-299；mod.rs:787-810 |
| plugin_set_enabled | pluginsApi.ts:63-64 | PluginsTab.tsx:183、526 | commands.rs:57 | manager.rs:269-287 |
| plugin_begin_login | pluginsApi.ts:65 | PluginsTab.tsx:246 | commands.rs:66 | manager.rs:301-419；mod.rs:170-334 |
| plugin_cancel_login | pluginsApi.ts:66 | PluginsTab.tsx:288 | commands.rs:74 | manager.rs:421-428；mod.rs:816-823 |
| plugin_unbind | pluginsApi.ts:68 | PluginsTab.tsx:455 | commands.rs:87（调用 logout） | manager.rs:430-452；mod.rs:825-835 |
| plugin_start | pluginsApi.ts:57 | **无 UI 调用点** | commands.rs:16 | manager.rs:158-238；mod.rs:719-740 |
| plugin_stop | pluginsApi.ts:58 | **无 UI 调用点** | commands.rs:24 | manager.rs:240-267 |
| plugin_logout | pluginsApi.ts:67 | **无 UI 调用点** | commands.rs:82 | manager.rs:430-452 |

后三条有 `src/` 中的真实 invoke 包装，但没有组件调用它们；UI 中对应的行为分别经 `plugin_set_enabled`
（内部调 start/stop）和 `plugin_unbind`（同一个 `manager.logout`）到达。是否计入 765 分母取决于运行器 inventory
口径（BASELINE 记"待运行器inventory"）；本包仍给出场景，但在第 4 节单列，不与 UI 可达的 8 条混算。

### 跨域步骤（owner 不是 F1）

| 命令 | owner | 契约 / Rust | 用途 |
|---|---|---|---|
| save_setting | L19-mcp-browser | `contracts/ipc/L19-mcp-browser.json`；`src-tauri/src/cmd/web_search.rs:541-561` | 写 `plugin.ilinkbot.*` 设置；凭证键经 `save_secret` 写安全存储 |
| get_setting | L19-mcp-browser | 同上；`web_search.rs:562-569` | 读回凭证/启用键，观察 logout/unbind 的清理副作用 |

`plugin.ilinkbot.credentials` 命中 `SENSITIVE_KEY_PATTERNS`（`dstu-security/src/secure_store.rs:134-150`），
所以 `save_setting` 会把它写进加密文件（`dstu-storage/src/database/mod.rs:4230-4287`），**不进 sqlite**。
`capture.db` 看不到凭证本身，场景用 `plugin_get_status/get_config` 和 `get_setting` 间接观察。
前端 `src/utils/settingsApi.ts:15,27` 是这两条命令的真实调用方；`INTERNAL_SETTING_PREFIXES` 只挡 `internal.oauth.`（`web_search.rs:13`）。

## 2. 分支覆盖表

"场景"一列引用场景 id 的末段（`plugins.<cmd>.<x>` 或 `plugins.seeded.<x>`）。

| 命令 | 成功分支 | Err / 提前返回分支 | 场景 |
|---|---|---|---|
| plugin_list | 正常列出（错误全部吞掉：`get_public_config().unwrap_or_default()`、`enabled_flag` 的 `ok().flatten()`） | 无可达 Err；`enabled` 字符串 `"true"`/`"1"` 外全为 false | list.empty；seeded.enabled_setting_variants、bound_credentials_views、corrupt_credentials_reads |
| plugin_get_status | 快照 + manager 状态覆盖 + errors 表覆盖 `lastError` | 未知 id → `AppError::validation("未知插件: …")`（manager.rs:59-64）；缺 `id`/类型错 → Tauri 参数反序列化错误 | get_status.empty、unknown_id、id_case_sensitive、missing_id_arg、id_wrong_type；seeded.corrupt_credentials_start_error（lastError） |
| plugin_get_config | 9 字段 JSON；`rate_limit_per_min` 解析失败回退 10（mod.rs:120-124） | 未知 id（含空串） | get_config.empty、unknown_id；seeded.rate_limit_parse_fallback |
| plugin_set_config | 四个键各自按 `as_bool/as_u64/as_str` 写入；类型不符、未知键、`token` 一律忽略；非对象 patch 全部 no-op | 未知 id；缺 `patch` → 参数错误。`save_setting` 失败分支（mod.rs:791 等）需库故障注入，无前端可达路径 | set_config.* 共 11 个 |
| plugin_set_enabled | 先存 `plugin.ilinkbot.enabled`，再 start/stop | 未知 id；`enabled` 类型错/缺失 → 参数错误；`"unsupported plugin"`（manager.rs:272-276）在只注册 ilinkbot 时不可达；保存失败需故障注入 | set_enabled.*；seeded.bound_set_enabled_true_false、bound_set_enabled_true_twice |
| plugin_start | 已绑定 → 返回 `starting`，后台进入 poll_loop（Running） | 未知 id；已在 Running/Starting/WaitingLogin → 原样返回当前状态（manager.rs:165-170）；后台 `load_credentials` 出错 → 状态 Error + errors 表（凭证损坏/缺字段）。移动端 `"插件仅支持桌面端"` 在 Linux 不可达 | start.unknown_id；seeded.bound_start_stop、corrupt_credentials_start_error、missing_field_credentials_start_error |
| plugin_stop | 有句柄 → Stopping 事件 + cancel → Stopped 事件 | 未知 id；无句柄且 Stopped → 不发事件直接返回 `stopped`；Error 状态无句柄 → 返回 `stopped` 但状态保持 error（manager.rs:256-266） | stop.idle、unknown_id；seeded.bound_start_stop、corrupt_credentials_start_error |
| plugin_begin_login | 见第 3 节（需网络模拟） | 未知 id；已在 Starting/WaitingLogin/Running → 直接 `Ok(())`（manager.rs:307-312）。handles 已存在的提前返回（316-320）仅在并发竞争下可达 | begin_login.unknown_id；seeded.bound_begin_login_while_active |
| plugin_cancel_login | 无条件 `cancel_login()` → stop_internal → Stopped 事件 | 未知 id | cancel_login.idle、unknown_id；seeded.bound_cancel_login_while_running |
| plugin_logout | stop_internal → 清凭证（错误被吞，mod.rs:110-114）→ 存 enabled=false → Stopped 事件；活动摘要"已解绑" | 未知 id；`plugin.logout` 只返回 Ok；保存 enabled 失败需故障注入 | logout.idle_unbound、unknown_id；seeded.bound_logout_while_running、corrupt_credentials_logout |
| plugin_unbind | 与 logout 同一实现 | 未知 id | unbind.idle_unbound、unknown_id；seeded.bound_unbind_idle |

### plugin_list 不写错误场景的理由（WP-244）

`plugin_list` 没有前端可达的 `Err` 或提前返回，所以不加 `expect: "error"` 场景：

- `commands.rs:11-14`：无参数（只取 `State<PluginManager>`），函数体只有 `manager.list().await`。没有可反序列化的参数，传多余键或错类型都会被忽略，不产生参数错误。
- `lib.rs:1359-1360`：`PluginManager` 在 setup 中无条件 `app.manage`，位于 `AppState` 的 `app.manage(state)`（`lib.rs:1336`）之后。setup 中途失败时应用不启动，前端调不到命令，所以 `State` 取不到的错误不可达。
- `manager.rs:119-145`：`list()` 内无 `?`，结尾 `Ok(out)`。各子调用都把错误吞掉：`get_public_config(..).unwrap_or_default()`（:126）；`enabled_flag` 用 `get_setting(..).ok().flatten()`（:103-115）；`is_bound` 用 `load_credentials(..).ok().flatten()`（`ilink_bot/mod.rs:711-717`）；`current_state` 和 `errors` 读取都不返回错误。
- `ilink_bot/mod.rs:763-785`：`get_public_config` 本身也只返回 `Ok(json!(..))`，内部的 `read_setting`（:116-118）、`read_rate_limit`（:120-124）、`load_credentials(..).ok().flatten()`（:773）都不传播错误。

存储故障（凭证损坏、设置读取失败）在 `plugin_list` 中只表现为 `enabled/configured/bound` 取 false，由 `seeded.corrupt_credentials_reads` 等成功场景覆盖。

### 安装 / 禁用 / 依赖副作用

- **安装/卸载**：Rust 插件表是编译期常量（`manager.rs:38-57` 只插入 `IlinkBotPlugin`），不存在前端可达的安装、卸载或依赖解析命令。Host profile/registry 是 B 端内部机制，不在本表。
- **禁用**：`plugin_set_enabled(false)` 写 `settings.plugin.ilinkbot.enabled='false'` 后调 `stop`；`plugin_set_config({enabled})` 只写设置、**不启停**（`set_config.enabled_flag_does_not_start` 断开这两者）。
- **命令间依赖**：`set_enabled(true)` → `start`；`set_enabled(false)` → `stop`；`unbind` = `logout` → 清凭证 + `enabled='false'` + Stopped；`begin_login` 成功且已绑定 → 写 `enabled='true'` → `start`（manager.rs:374-394，需网络模拟）；`logout` 后 `get_config.bound=false`。
- **写库位置**：只有 `settings` 表（`save_setting` 在值不变时不更新 `updated_at`，见 `database/mod.rs:4108-4119`；`set_config.repeat_same_value` 覆盖）。凭证在安全存储文件中。

## 3. 需要网络模拟、本包未写入 JSON 的场景

`IlinkClient::get_bot_qrcode/get_qrcode_status`（`ilink_bot/client.rs:154-196`）把 URL 写死为
`DEFAULT_BASE_URL = https://ilinkai.weixin.qq.com`，没有配置接口可以改到本地模拟服务。按协议不连互联网，以下分支不放进 JSON：

| 命令 / 分支 | 触发条件 | 需要什么 |
|---|---|---|
| begin_login 成功、QR 刷新、`"二维码多次过期"`、`"确认成功但缺少 bot_token / ilink_bot_id"`、confirmed 后写 enabled 并自动 start、480 秒超时 | 未绑定时调 `plugin_begin_login` | 在网络层（DNS/代理/hosts）把 `ilinkai.weixin.qq.com` 指向确定性模拟服务；owner X5/X7，且两端都要走同一路径 |
| 未绑定的 `plugin_start` / `plugin_set_enabled(true)` | `run()` 先进 `run_login_flow`（mod.rs:719-735） | 同上 |
| WaitingLogin 中的 `plugin_cancel_login` / `plugin_stop` | 需要先处于真实登录流 | 同上 |
| poll_loop 收到消息、`-14` 会话过期、API 错误退避、发消息分片 | 已绑定且 `baseUrl` 指向可应答的模拟 iLink | `baseUrl` 可参数化（凭证字段），模拟 iLink 服务尚未就绪；远程任务链另受 BLOCKERS F1-V2-04 阻塞 |

已绑定场景的凭证 `baseUrl` 统一为 `http://127.0.0.1:9`（本机关闭端口）。poll_loop 只对它发 `getupdates`，
连接被拒后按 `mod.rs:561-570` 记 warn 并重试（前两次 2 秒、第三次 30 秒），不出现 Err 分支，也不会访问外网。模拟 iLink 就绪后只需替换这一个值。

## 4. 不进入 765 分母的项

| 项 | 原因 |
|---|---|
| `plugin:host|call`、`plugin:ui|manifest` | Host 内核自有命令（`host/kernel/commands.ts:141-158`），前端有调用点（`src/ui-kernel/kernel.ts:189`、`src/ui-kernel/community.ts:17`），但 Rust 端没有对应实现，A 无 oracle |
| `plugin:host|status` | Host 内部命令（`host/kernel/runtime.ts:124`），`src/` 无调用点 |
| profile 装载、插件拓扑排序、degraded 汇总 | 无 IPC 入口，属 B 端启动机制 |
| `plugin_start`、`plugin_stop`、`plugin_logout` | 有 invoke 包装、无 UI 调用点（第 1 节）。场景已写，计数时单列 |

## 5. 运行前提与已知不确定性

- 运行环境必须无外网出口，且清掉 `HTTP(S)_PROXY`。如果 `save_setting` 写凭证失败（安全存储不可用），后续 `plugin_start` 会走登录流并请求真实域名；运行器应在 seed 步骤失败时中止该场景。
- 后台任务时序：`plugin_start` 返回 `starting` 后由后台任务置 `running` 或 `error`。紧随其后的 `get_status/list/start` 可能读到 `starting`，也可能读到 `running/error`；`stop` 与后台 `set_state(Running)` 之间也有竞争窗口（`mod.rs:341-344`）。A 双录若不同，应提交 C2 判定，不能直接忽略状态字段。
- `plugin_list` 遍历 `HashMap` 后按 id 排序，只有一个插件，顺序确定。
- `get_config` 的键顺序取决于 serde_json 是否启用 `preserve_order`，以 A 实录为准。

### normalize 候选（未启用）

- 事件 `plugin-state-changed / plugin-activity / plugin-qrcode` 的 `$.ts`（`chrono::Utc::now().timestamp_millis()`，events.rs:44,56,68）。
- `settings.updated_at`（`Utc::now().to_rfc3339()`）。
- 后台时序导致的 `state` 差异：只在 A 双录证实后由 C2 定规则，不预先抹掉。

## 6. 计数

- 命令 11 条（UI 可达 8 条 + 仅有 invoke 包装 3 条）；场景 51 个（34 + 17）。
- 含 `expect: "error"` 步骤的场景 16 个（10 条命令的未知 id，加参数缺失/类型错误）；其余 35 个是成功路径，
  其中 `seeded.corrupt_credentials_*`、`missing_field_credentials_start_error` 和 `start/begin_login/set_enabled` 的已活动提前返回
  在命令层返回 Ok，错误或提前返回体现在状态/事件上。
- `plugin_list` 没有可达的 Err 分支（第 2 节），只有成功场景。
- 剩余：第 3 节网络依赖分支；需要故障注入的 `save_setting` 失败分支（set_config/set_enabled/logout 的 `AppError::database`）。
