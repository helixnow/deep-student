# browser / settings / websearch 等价场景（WAVE0 G3 语料 v1，WP-232）

格式为 `board/WAVE0-EQUIVALENCE.md` §3 v0。这些场景**尚未在 A/B 上运行，没有 golden，不计 C 级**。`expect:"error"` 只是说明，以 A 端实际结果为准；没有写任何预期返回值。

| 文件 | 场景数 | 步骤数 | 标注 `expect:error` | 命令 |
|---|---|---|---|---|
| `browser-session.json` | 15 | 159 | 70 | 16 条 `browser_*`；`save_setting` 只用来打开/关闭门控 |
| `settings-websearch.json` | 12 | 122 | 21 | save/get/delete_setting、get_settings_by_prefix、is_feature_enabled、get_cn_whitelist_config、get_security_status、get/save_provider_strategies_config、test_web_search_connectivity、test_search_engine |
| `pending-mock/websearch-searxng.json` | 1 | 4 | 0 | 需要 SearXNG mock，**未就绪，不计覆盖** |
| `pending-network/websearch-network.json` | 3 | 6 | 0 | 必走外网（bing），**不得在 WAVE0 运行，不计覆盖** |

**G3 状态（D-158）**：本目录 28 条命令里，在 768 分母内的 12 条：browser_list_task_downloads、get_setting、save_setting、delete_setting、get_settings_by_prefix、get_cn_whitelist_config、get_security_status、get/save_provider_strategies_config、test_web_search_connectivity、test_search_engine、test_all_search_engines。除 test_all_search_engines（blocked，见 pending 表）外都有主语料成功场景。其余 15 条 `browser_*` 和 is_feature_enabled 属于 981 外延。L19 的错误分支今后由 W-lane（`g3w-*.json`）写；本包已有的 `expect:error` 步骤保留。

MCP 命令的语料在 `host/plugins/mcp/equivalence/`（见该目录 README 的“语料”一节）。三处主语料合计 61 个场景、425 步：成功 289 步、标注错误 136 步，覆盖 44 条前端可达命令外加 `get_setting`/`save_setting`。

所有场景都是 `seed:"empty"`、`capture:{events:true, db:["*"]}`、`normalize:[]`。读场景也抓事件和全部 db，因为门控检查会关闭活动会话并发事件。

## 运行器前提（X7 验收）

1. **占位符先于步骤引用替换**。场景用到 `${mcp.url}`（例如 `"${mcp.url}/wave0-browser/a"`、`"${mcp.url}/wave0-searxng-404"`）。`resolveReferences`（`scripts/electron-migration/record/scenario-v0.mjs:62`）遇到值内嵌 `${` 会抛错，所以运行器必须先按 `mcp.placeholders()` 替换 `${mcp.*}`，再解析 `${n.path}`。这一扩展和 MCP README 中的约定相同，需 X7 接受。
2. **`"mcp":{"scripts":[]}`** 表示只需要本地 MCP 服务的 HTTP 端口（不跑任何脚本），用作确定性的 404 页面和 404 的 SearXNG 端点。浏览器导航目标全部是 `${mcp.url}/wave0-browser/<p>`，不访问外网。
3. **浏览器门控种子**。门控命令需要同时满足：`desktop.workbenchMode` trim 后不等于 `"false"`、`desktop.workbenchBrowserEnabled` 为真值、`feature_flags.config` 里 `ui.workbench_browser` 为 Enabled。场景用前两步 `save_setting` 建立：`desktop.workbenchBrowserEnabled="true"` 和含 `ui.workbench_browser` `state:"Enabled"` 的 flags JSON。
4. **页面加载是异步的**。`browser_open_session`/`navigate`/`back`/`forward`/`reload` 返回后页面仍在加载，紧随其后的 `browser_get_state` 读到的 url/title/loading 取决于时机。运行器需在导航步骤后等待浏览器状态事件静默再执行下一步；这是运行器规则，不是 normalize。
5. A 端在 Linux 上是 detached surface host（`browser_get_surface_host_mode` 返回 detached），需要可用的显示环境来创建 webview 窗口。
6. normalize 候选（只列出，等 A 录两次后由 C2 决定，现在不忽略）：会话 id `bs_<uuid>` 以及它在返回值、事件、错误文案里的出现；`${mcp.url}` 中的端口（出现在 url、title、错误文案里）；下载列表、状态里的时间戳；`test_*` 返回的 `response_time`/`timestamp`。

## 命令入口与分支覆盖

前端行号相对 `src/`。Rust 浏览器命令相对 `src-tauri/crates/dstu-browser/src/cmd/browser.rs`，设置/搜索命令相对 `src-tauri/src/cmd/web_search.rs`。场景引用写作 `场景id[步骤下标]`，省略前缀 `browser.` / `settings.` / `websearch.`。“参数反序列化”指进入 handler 前因缺参或类型错误返回的 Err。

### browser（命令 owner L19）

| 命令 | 前端 invoke | Rust | 成功场景 | 错误场景 | 理由 |
|---|---|---|---|---|---|
| browser_get_surface_host_mode | `features/browser/browserApi.ts:358` | `:310` | `gates.default_closed…[0]`（门控关）、`surface.detached_host_calls[2]` | 无 | 不受门控，无 Err 分支，无参数 |
| browser_open_session | `browserApi.ts:272` | `:109` | `session.lifecycle_user_mode[2]`、`session.reuse_existing_and_new[2-4]`（复用/新建）等 | 门控关 `gates.default_closed…[1]`、`gates.workbench_mode_false[3]`、`gates.feature_flag_disabled[2]`；`file:`/非法 URL/`javascript:`/`fromAgent:true` → `session.navigation_blocked_and_invalid[2-5]`；缺 url → `bad_args[2]` | 覆盖三个门控条件、URL 校验和代理来源拒绝 |
| browser_navigate | `browserApi.ts:291` | `:134` | `session.lifecycle_user_mode[7-9]`（含 `replace:true`） | 门控关；被拦 URL/空 URL/`fromAgent:true` → `navigation_blocked_and_invalid[7-9]`；会话不存在 → `missing_session_ids[2]`；会话 id 不匹配 → `mismatched_session_id…[3]`；缺 url → `bad_args[3]` | |
| browser_back | `browserApi.ts:301` | `:158` | `lifecycle_user_mode[10]` | 无历史 → `lifecycle_user_mode[5]`；门控关；不存在/不匹配 → `missing_session_ids[3]`、`mismatched…[4]` | |
| browser_forward | `browserApi.ts:305` | `:168` | `lifecycle_user_mode[11]` | 无前进历史 → `lifecycle_user_mode[6][12]`；门控关；不存在 → `missing_session_ids[4]` | |
| browser_reload | `browserApi.ts:309` | `:178` | `lifecycle_user_mode[13][14]`（`hard` null/true） | 门控关；不存在/不匹配 → `missing_session_ids[5]`、`mismatched…[5]` | webview reload 自身失败不可在种子中触发，见下方未覆盖 |
| browser_get_state | `browserApi.ts:314` | `:191` | 无会话 → `gates.open_no_session_reads[2]`；有会话 → `lifecycle_user_mode[3][4]`；关闭后 → `[19]` | 门控关、flags 不可解析 → `gates.feature_flags_unparseable[2]`；关闭后按 id 查 → `lifecycle_user_mode[20]`；被替换的旧会话 → `reuse_existing_and_new[5]`；门控关掉时活动会话被关闭 → `gates.close_live_session_when_gate_turns_off[4][7]` | |
| browser_close | `browserApi.ts:283` | `:210` | 不受门控，`sessionId:null` 在门控关时也成功 → `gates.default_closed…[15]`；按 id 关闭 → `lifecycle_user_mode[18]` 等 | 不存在 → `gates.default_closed…[16]`、`missing_session_ids[15]`；不匹配 → `mismatched…[11]`；已被替换 → `reuse_existing_and_new[7]`；类型错误 → `bad_args[7]` | |
| browser_focus | `browserApi.ts:323` | `:232` | `surface.detached_host_calls[10][11]`（Linux 走 `focus_content_window`） | 门控关；无活动会话 → `missing_session_ids[7]`；id 不存在/不匹配 → `[8]`、`mismatched…[6]` | |
| browser_release_surface_focus | `browserApi.ts:328` | `:250` | `detached_host_calls[12]` | 门控关；不存在/不匹配 → `missing_session_ids[9]`、`mismatched…[7]` | |
| browser_set_surface_bounds | `browserApi.ts:336` | `:262` | `detached_host_calls[7-9]`（含 0 尺寸、负坐标、occlusions、最大安全整数 sequence） | 门控关；不存在/不匹配 → `missing_session_ids[10]`、`mismatched…[8]`；缺字段 → `bad_args[6]` | Linux detached 模式在检查活动会话后直接返回，边界校验分支不可达 |
| browser_set_surface_visibility | `browserApi.ts:349` | `:295` | `detached_host_calls[4-6]` | 门控关；不存在/不匹配 → `missing_session_ids[11]`、`mismatched…[9]`；缺 visible → `bad_args[5]` | |
| browser_take_over | `browserApi.ts:364` | `:335` | `detached_host_calls[13]` | 门控关、flag Disabled → `gates.feature_flag_disabled[3]`；无活动会话 → `missing_session_ids[12]`、`detached_host_calls[16]` | |
| browser_set_input_files | `browserApi.ts:377` | `:426` | **无** | 门控关；会话不存在 → `missing_session_ids[13]`；Linux 返回 `BRIDGE_UNSUPPORTED` → `automation.bridge_unsupported_on_linux[3][4]` | 成功路径需要自动化桥，Linux 上 A 端没有；只有错误覆盖，不计成功覆盖 |
| browser_list_downloads | `browserApi.ts:368` | `:443` | `lifecycle_user_mode[15]` | 门控关；不存在/不匹配 → `missing_session_ids[14]`、`mismatched…[10]` | 有下载项的成功分支需要真实下载，未覆盖 |
| browser_list_task_downloads | `features/chat/api/taskWorkspaceApi.ts:46` | `:454` | `gates.open_no_session_reads[3][4]`（含空串）；真值变体 ` YES `、`1` → `gates.browser_enabled_truthy_variants[4][6]`；`lifecycle_user_mode[16][17]` | 门控关、`workbenchMode=" false "` → `workbench_mode_false[4]`；`off`/空串 → `browser_enabled_truthy_variants[2][8]`；flags 不可解析 → `feature_flags_unparseable[3]`；缺参 → `bad_args[4]` | |

### settings / feature flags（命令 owner L19，服务 owner F4，D-059）

| 命令 | 前端 invoke | Rust | 成功场景 | 错误场景 | 理由 |
|---|---|---|---|---|---|
| save_setting | `components/WebSearchAdvancedConfig.tsx:239` | `:541` | 普通值、覆盖、空串、含 NUL/中文/引号 → `settings.plain.roundtrip_overwrite_delete`；敏感键进安全存储 → `settings.sensitive.secure_store_roundtrip`；`internal.other` 与前导空格的 ` internal.oauth.x` 不被拒 → `internal_keys_rejected[9][12]`；另作各场景前置 | `internal.oauth.` 键/前缀 → `internal_keys_rejected[0][3]` | 安全存储不可用的 Err 依赖环境，空种子不可达 |
| get_setting | `app/hooks/usePlatformSettingsSync.ts:50` | `:562` | 不存在 → `plain…[0]`；读回 → `[2][9][10]`；敏感键 → `sensitive…[1][6]`；删除后 → `[9]` | `internal.oauth.*` → `internal_keys_rejected[1]`；缺参 → `bad_args[3]` | |
| delete_setting | `utils/settingsApi.ts:95` | `:572` | 删除、重复删除、从未存在 → `plain…[11-13]`；敏感键 → `sensitive…[7][8][10]` | `internal.oauth.*` → `internal_keys_rejected[2]`；类型错误 → `bad_args[4]` | |
| get_settings_by_prefix | `features/settings/components/mcp-tools/useToolPermissions.tsx:123` | `:581` | 前缀、更长前缀、无匹配 → `plain…[6-8]`；LIKE 未转义 `_`/`%` → `prefix.like_wildcards_unescaped[3-6]`；敏感键 → `sensitive…[4][5]` | `internal.oauth.`、`internal.`、`i`、空串、`internal.oauth.wave0` → `internal_keys_rejected[4-8]`；缺参 → `bad_args[5]` | |
| is_feature_enabled | `features/browser/gates.ts:132` | `:454` | 默认 flags、未知 flag → `feature_flags.defaults_and_states[0][1]`；Enabled/Disabled/UserSpecific/Gradual 0 与 1/Gradual 0.5 带 userId/依赖满足与不满足/min/max version → `[3-18]` | flags 不可解析、缺字段 → `feature_flags.unparseable_config[1][3]` | Gradual 不带 userId 时结果随机，故不写 |

### websearch（命令 owner L19，服务 owner F4，D-059）

| 命令 | 前端 invoke | Rust | 成功场景 | 错误场景 | 理由 |
|---|---|---|---|---|---|
| get_cn_whitelist_config | `components/WebSearchAdvancedConfig.tsx:120` | `:235` | 默认 → `cn_whitelist_and_security_status[0]`；开/关默认/自定义（JSON 数组与逗号分隔、大小写）→ `[5][8][11]` | 无 | 无参数，handler 无可达 Err |
| get_security_status | `components/SecurityStatusIndicator.tsx:44` | `:210` | `cn_whitelist_and_security_status[1]` | 无 | 无参数，handler 无可达 Err |
| get_provider_strategies_config | `features/settings/components/EngineSettingsSection.tsx:105` | `:318` | 默认、保存后、坏 JSON 回落默认、缺 `default` → `provider_strategies.roundtrip[0][2][5][7][9]` | 无 | 坏 JSON 回落默认值，不报错 |
| save_provider_strategies_config | `EngineSettingsSection.tsx:182` | `:344` | 全字段/空 default → `provider_strategies.roundtrip[1][4]` | 缺 `default`、负数、超 u32、类型错误 → `provider_strategies.invalid_args[0-3]` | 只在参数反序列化时报错 |
| test_web_search_connectivity | `utils/settingsApi.ts:185` | `:43` | handler Ok：本地 404 的 SearXNG → `connectivity.searxng_local_404[2][3]`；未知引擎、缺 SearXNG 端点、缺 Tavily/Google key、空白引擎 → `connectivity.config_errors_offline[1-5]` | 类型错误 → `bad_args[2]` | 恒返回 Ok，失败信息在返回体里。主语料全是探测失败，**真正连通只在 pending**（SearXNG mock、默认 bing 外网） |
| test_search_engine | `components/SearchEngineStatus.tsx:58` | `:478` | handler Ok：`connectivity.searxng_local_404[4]`；searxng/未知/serpapi/brave/zhipu/bocha/deepseek 缺配置 → `config_errors_offline[6-12]` | 缺参、null → `bad_args[0][1]` | 同上 |
| test_all_search_engines | `utils/settingsApi.ts:229` | `:87` | **无**（只在 pending-network） | 无 | 总会请求 bing，离线不可确定；不计覆盖 |

### 本包没有覆盖的分支

- **DB/存储错误**（save/get/delete_setting、get_settings_by_prefix、is_feature_enabled、strategies 保存）：空种子下数据库正常，无法确定性地触发。
- **安全存储不可用**（`安全存储不可用...`）：取决于系统 keyring/环境，不是种子能控制的。
- **`配置加载失败`**（websearch 读配置文件）：需要预置坏配置文件，空种子不可达；需要 X3 新 seed 才能写。
- **webview 导航/reload 自身失败**、**opener 失败**：取决于 webview 运行时，无法确定性触发。
- **Linux 上 `set_surface_bounds` 的边界校验**：detached 模式在校验前返回。
- **`browser_set_input_files` 成功路径**：需要自动化桥，Linux 返回 `BRIDGE_UNSUPPORTED`。
- **`AppState not available`**：只在应用未初始化时出现，前端到达不了。
- **有下载项的 `list_downloads`/`list_task_downloads`**：需要真实下载。

### pending（不计覆盖，owner）

| 文件 | 场景 | 缺什么 | owner | 解除条件 | 复核人 |
|---|---|---|---|---|---|
| `pending-mock/websearch-searxng.json` | `websearch.pending.searxng_mock_success` | 本地 SearXNG mock 与占位符 `${search.searxngUrl}`、场景字段 `search` | mock：L19（与 MCP 服务同进程）；字段接入：X7 | mock 返回固定 JSON 结果，运行器能替换 `${search.searxngUrl}` | C2 |
| `pending-network/websearch-network.json` | `test_all_search_engines` 两个场景、默认 bing 连通性 | bing 地址写死在 `src-tauri/crates/dstu-mcp/src/tools/web_search.rs:1848`（`https://www.bing.com/search`），配置里没有可注入的端点。`test_all_search_engines` 无论配置如何都会请求它（`src-tauri/src/cmd/web_search.rs:123`），WAVE0 禁止外网 | X7（运行器网络环境）；服务 owner F4 | A、B 两端的 bing 请求都被导向同一个本地确定性端点（例如运行器为两端设置相同的出站代理）；或 C2 书面批准这几条走外网 | C2 |

`test_all_search_engines` 在 768 分母内，按 G3-LEDGER §2 申报为 **blocked**，owner、解除条件和复核人见上表。
