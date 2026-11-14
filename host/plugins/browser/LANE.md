# L19-mcp-browser：MCP 与浏览器

> 由 `npm run migration:scaffold` 生成；生成区块由 `--refresh` 维护，不要手改区块内部。
> 本目录只放本 lane 自己编写的 `manifest.ts`、`src/`、`repository/`、`tests/`（依据 `host/kernel/api.ts`）。

<!-- BEGIN GENERATED:lane -->
| 项 | 内容 |
|---|---|
| Lane | L19-mcp-browser（MCP 与浏览器） |
| 目录 | `host/plugins/browser/`（同 lane 另有 `host/plugins/mcp/`，文件划分见 `scripts/electron-migration/lib/lanes.mjs` 的 DIR_SPLIT） |
| Rust 范围（lanes.md） | dstu-mcp、dstu-browser，cmd 下的 mcp、network、web_search，以及 browser、index_webpage 工具 |
| 主要提供 | `mcp@1`、`browser@1`、`websearch@1` |
| 主要消费 | F4 |
| 特别注意 | MCP stdio 子进程生命周期；搜索重试分类（402 不重试） |
| 规模（本目录） | 11826 行 · 21 个文件 · 38 个命令（前端调用 12） · 106 个测试 |
| 规模（整条 lane，inventory） | 27060 行 · 43 个文件 · 70 个命令（前端 33） · 206 个测试 |
| 契约 | [`contracts/ipc/L19-mcp-browser.json`](../../../contracts/ipc/L19-mcp-browser.json) |
| 服务草稿 | [`contracts/services/DRAFT-L19-mcp-browser.md`](../../../contracts/services/DRAFT-L19-mcp-browser.md) |
| 规格 / 测试去向 | [SPEC.md](SPEC.md) · [TESTMAP.md](TESTMAP.md) |

### 拥有的 Rust 文件

| 文件 | 行 | 测试 | 命令 |
|---|---|---|---|
| `src-tauri/crates/dstu-browser/build.rs` | 18 | 0 |  |
| `src-tauri/crates/dstu-browser/src/browser/bridge.rs` | 906 | 18 |  |
| `src-tauri/crates/dstu-browser/src/browser/database.rs` | 329 | 6 |  |
| `src-tauri/crates/dstu-browser/src/browser/error.rs` | 38 | 0 |  |
| `src-tauri/crates/dstu-browser/src/browser/events.rs` | 134 | 0 |  |
| `src-tauri/crates/dstu-browser/src/browser/hooks.rs` | 42 | 0 |  |
| `src-tauri/crates/dstu-browser/src/browser/mod.rs` | 94 | 0 |  |
| `src-tauri/crates/dstu-browser/src/browser/policy.rs` | 249 | 8 |  |
| `src-tauri/crates/dstu-browser/src/browser/repository.rs` | 1020 | 7 |  |
| `src-tauri/crates/dstu-browser/src/browser/service.rs` | 2866 | 24 |  |
| `src-tauri/crates/dstu-browser/src/browser/session.rs` | 422 | 5 |  |
| `src-tauri/crates/dstu-browser/src/browser/types.rs` | 125 | 0 |  |
| `src-tauri/crates/dstu-browser/src/browser/window.rs` | 945 | 8 |  |
| `src-tauri/crates/dstu-browser/src/browser/window/macos_surface_clip.rs` | 507 | 2 |  |
| `src-tauri/crates/dstu-browser/src/cmd/browser.rs` | 549 | 3 | 21 |
| `src-tauri/crates/dstu-browser/src/lib.rs` | 28 | 0 |  |
| `src-tauri/src/chat_v2/tools/browser_executor.rs` | 1436 | 11 |  |
| `src-tauri/src/chat_v2/tools/index_webpage_executor.rs` | 1379 | 9 |  |
| `src-tauri/src/cmd/web_search.rs` | 622 | 2 | 17 |
| `src-tauri/tests/bing_rss_search.rs` | 39 | 1 |  |
| `src-tauri/tests/browser_capability_contract.rs` | 78 | 2 |  |

### 命令（38）

| 命令 | Rust | async | 前端 | 前端调用点 | 契约（参数 → 结果 ! 错误） |
|---|---|---|---|---|---|
| `browser_back` | `crates/dstu-browser/src/cmd/browser.rs:158` | async | none | — | (sessionId: string) → BrowserStateResult ! string |
| `browser_click` | `crates/dstu-browser/src/cmd/browser.rs:390` | async | none | — | (sessionId: string, ref: string) → Value ! string |
| `browser_close` | `crates/dstu-browser/src/cmd/browser.rs:210` | async | none | — | (sessionId?: string \| null) → null ! string |
| `browser_content_user_input` | `crates/dstu-browser/src/cmd/browser.rs:317` | sync | none | — | (sessionId: string, nonce: string, kind: string) → null ! string |
| `browser_focus` | `crates/dstu-browser/src/cmd/browser.rs:232` | async | none | — | (sessionId?: string \| null) → null ! string |
| `browser_forward` | `crates/dstu-browser/src/cmd/browser.rs:168` | async | none | — | (sessionId: string) → BrowserStateResult ! string |
| `browser_get_state` | `crates/dstu-browser/src/cmd/browser.rs:191` | async | none | — | (sessionId?: string \| null) → BrowserStateResult \| null ! string |
| `browser_get_surface_host_mode` | `crates/dstu-browser/src/cmd/browser.rs:310` | sync | none | — | (（无）) → string ! string |
| `browser_list_downloads` | `crates/dstu-browser/src/cmd/browser.rs:443` | async | none | — | (sessionId: string) → BrowserDownloadObservation[] ! string |
| `browser_list_task_downloads` | `crates/dstu-browser/src/cmd/browser.rs:454` | async | app | src/features/chat/api/taskWorkspaceApi.ts:46 | (chatSessionId: string) → BrowserDownloadObservation[] ! string |
| `browser_navigate` | `crates/dstu-browser/src/cmd/browser.rs:134` | async | none | — | (sessionId: string, url: string, replace?: boolean \| null, fromAgent?: boolean \| null) → BrowserStateResult ! string |
| `browser_open_session` | `crates/dstu-browser/src/cmd/browser.rs:109` | async | none | — | (url: string, displayName?: string \| null, chatSessionId?: string \| null, reuseExisting?: boolean \| null, fromAgent?: boolean \| null) → BrowserStateResult ! string |
| `browser_release_surface_focus` | `crates/dstu-browser/src/cmd/browser.rs:250` | async | none | — | (sessionId: string) → null ! string |
| `browser_reload` | `crates/dstu-browser/src/cmd/browser.rs:178` | async | none | — | (sessionId: string, hard?: boolean \| null) → BrowserStateResult ! string |
| `browser_scroll` | `crates/dstu-browser/src/cmd/browser.rs:464` | async | none | — | (sessionId: string, direction?: string \| null, amount?: integer(i32) \| null, ref?: string \| null) → Value ! string |
| `browser_set_input_files` | `crates/dstu-browser/src/cmd/browser.rs:426` | async | none | — | (sessionId: string, ref: string, files: Value) → Value ! string |
| `browser_set_surface_bounds` | `crates/dstu-browser/src/cmd/browser.rs:262` | async | none | — | (sessionId: string, x: number, y: number, width: number, height: number, viewportWidth: number, viewportHeight: number, occlusions?: SurfaceCssOcclusion[] \| null, inputOcclusions?: SurfaceCssOcclusion[] \| null, sequence: integer(u64)) → string ! string |
| `browser_set_surface_visibility` | `crates/dstu-browser/src/cmd/browser.rs:295` | async | none | — | (sessionId: string, visible: boolean, focus?: boolean \| null) → string ! string |
| `browser_snapshot` | `crates/dstu-browser/src/cmd/browser.rs:357` | async | none | — | (sessionId: string, maxChars?: integer(u32) \| null) → BrowserSnapshotResult ! string |
| `browser_take_over` | `crates/dstu-browser/src/cmd/browser.rs:335` | async | none | — | (（无）) → BrowserStateResult ! string |
| `browser_type` | `crates/dstu-browser/src/cmd/browser.rs:406` | async | none | — | (sessionId: string, ref: string, text: string, submit?: boolean \| null) → Value ! string |
| `delete_setting` | `src/cmd/web_search.rs:572` | async | app | src/features/chat/skills/builtinStorage.ts:177<br>src/utils/settingsApi.ts:95 | (key: string) → boolean ! AppError |
| `delete_settings_by_prefix` | `src/cmd/web_search.rs:593` | async | none | — | (prefix: string) → integer(usize) ! AppError |
| `detect_tool_conflicts` | `src/cmd/web_search.rs:284` | async | none | — | (（无）) → ToolConflict[] ! AppError |
| `get_cn_whitelist_config` | `src/cmd/web_search.rs:235` | async | app | src/components/WebSearchAdvancedConfig.tsx:119 | (（无）) → Value ! AppError |
| `get_feature_flags` | `src/cmd/web_search.rs:363` | async | none | — | (（无）) → Value ! AppError |
| `get_provider_strategies_config` | `src/cmd/web_search.rs:318` | async | app | src/features/settings/components/EngineSettingsSection.tsx:105 | (（无）) → Value ! AppError |
| `get_security_status` | `src/cmd/web_search.rs:210` | async | app | src/components/SecurityStatusIndicator.tsx:44 | (（无）) → Value ! AppError |
| `get_setting` | `src/cmd/web_search.rs:562` | async | app | src/app/hooks/usePlatformSettingsSync.ts:50<br>src/app/hooks/usePlatformSettingsSync.ts:87<br>src/app/hooks/usePlatformSettingsSync.ts:122<br>…共 50 处 | (key: string) → string \| null ! AppError |
| `get_settings_by_prefix` | `src/cmd/web_search.rs:581` | async | app | src/features/settings/components/mcp-tools/useToolPermissions.tsx:123 | (prefix: string) → ?[][] ! AppError |
| `get_tools_namespace_config` | `src/cmd/web_search.rs:291` | async | none | — | (（无）) → Value ! AppError |
| `is_feature_enabled` | `src/cmd/web_search.rs:454` | async | none | — | (featureName: string, userId?: string \| null) → boolean ! AppError |
| `save_provider_strategies_config` | `src/cmd/web_search.rs:344` | async | app | src/features/settings/components/EngineSettingsSection.tsx:182 | (strategies: ProviderStrategies) → boolean ! AppError |
| `save_setting` | `src/cmd/web_search.rs:541` | async | app | src/components/WebSearchAdvancedConfig.tsx:239<br>src/components/WebSearchAdvancedConfig.tsx:260<br>src/components/WebSearchAdvancedConfig.tsx:264<br>…共 17 处 | (key: string, value: string) → boolean ! AppError |
| `test_all_search_engines` | `src/cmd/web_search.rs:87` | async | app | src/utils/settingsApi.ts:229 | (（无）) → Value ! AppError |
| `test_search_engine` | `src/cmd/web_search.rs:478` | async | app | src/components/SearchEngineStatus.tsx:58<br>src/features/settings/components/EngineSettingsSection.tsx:132 | (engine: string) → Value ! AppError |
| `test_web_search_connectivity` | `src/cmd/web_search.rs:43` | async | app | src/utils/settingsApi.ts:185 | (engine?: string \| null) → Value ! AppError |
| `update_feature_flag` | `src/cmd/web_search.rs:397` | async | none | — | (featureName: string, action: string, value?: Value \| null) → Value ! AppError |

### 发出的事件（7）

| 事件名 | 类型 | 发送点 |
|---|---|---|
| `browser:closed` | 常量 `EVT_CLOSED` | crates/dstu-browser/src/browser/events.rs:108 (emit) |
| `browser:content-user-input` | 常量 `EVT_CONTENT_USER_INPUT` | crates/dstu-browser/src/browser/events.rs:126 (emit) |
| `browser:control-mode-changed` | 常量 `EVT_CONTROL_MODE_CHANGED` | crates/dstu-browser/src/browser/events.rs:120 (emit) |
| `browser:navigated` | 常量 `EVT_NAVIGATED` | crates/dstu-browser/src/browser/events.rs:96 (emit) |
| `browser:navigation-blocked` | 常量 `EVT_NAVIGATION_BLOCKED` | crates/dstu-browser/src/browser/events.rs:102 (emit) |
| `browser:title-changed` | 常量 `EVT_TITLE_CHANGED` | crates/dstu-browser/src/browser/events.rs:114 (emit) |
| `vfs-index-progress` | 字面量 | src/chat_v2/tools/index_webpage_executor.rs:252 (emit)<br>src/chat_v2/tools/index_webpage_executor.rs:274 (emit)<br>src/chat_v2/tools/index_webpage_executor.rs:294 (emit)<br>src/chat_v2/tools/index_webpage_executor.rs:325 (emit) |

### 契约中的事件（7，`contracts/ipc/L19-mcp-browser.json`）

| 事件名 | 动态名 | 载荷 | 发送点 |
|---|---|---|---|
| `vfs-index-progress` | 否 | object \| object \| object \| object \| object \| object \| object \| object \| object \| object \| object \| object \| object \| object \| object \| object \| object \| object | src/chat_v2/tools/index_webpage_executor.rs:252 (emit)<br>src/chat_v2/tools/index_webpage_executor.rs:274 (emit)<br>src/chat_v2/tools/index_webpage_executor.rs:294 (emit)<br>src/chat_v2/tools/index_webpage_executor.rs:325 (emit) |
| `browser:closed` | 否 | BrowserClosedPayload | crates/dstu-browser/src/browser/events.rs:108 (emit) |
| `browser:content-user-input` | 否 | BrowserContentUserInputPayload | crates/dstu-browser/src/browser/events.rs:126 (emit) |
| `browser:control-mode-changed` | 否 | BrowserControlModeChangedPayload | crates/dstu-browser/src/browser/events.rs:120 (emit) |
| `browser:navigated` | 否 | BrowserNavigatedPayload | crates/dstu-browser/src/browser/events.rs:96 (emit) |
| `browser:navigation-blocked` | 否 | BrowserNavigationBlockedPayload | crates/dstu-browser/src/browser/events.rs:102 (emit) |
| `browser:title-changed` | 否 | BrowserTitleChangedPayload | crates/dstu-browser/src/browser/events.rs:114 (emit) |
<!-- END GENERATED:lane -->

## 备注

### WP-154：未注册搜索入口纠偏（恢复交付候选）

- `test_web_search_connectivity` 的旧“已接线”描述已由 SPEC 对应节订正：Rust 定义/重导出存在，
  但完整 handler/cfg 与 ACL 均无此命令；前端包装存在不代表生产可调用。
- `index.ts` 最窄移除 meta/register，内部搜索服务与现有消费者保留；官方 Host 回归断言
  debug/release 原 not-found 字符串、拒绝发生在解码/IO 前、已注册搜索命令仍可用。
- 恢复前已有双目录 job `20261105193625-99eacc`：51 files / 462 passed / exit0；
  typecheck `20261105193625-e6c3e0` exit0。WP-118 历史和测试先行提交 `53405c1c0` 保留。
- TESTMAP 去向不变（browser 实际 pending 1、MCP 0）；交付后仍需 C2 集成和独立复验。
- 恢复代码已完整进入协调者检查点 `d829389af`（生产注销、真实 HTTP 回归、三层证据共 5 文件），
  后续正式交付引用该提交，不重写检查点或 WP-118 历史。恢复检查：importable job
  `20261105203211-0db367`、strict `20261105203211-7e5320` 均 exit0；正确 lane 参数的 wiring
  `20261105203236-523440`（browser 105 条）、`20261105203236-286e0b`（MCP 100 条）均未接入 0 / exit0。
- 恢复最终入口回归 `20261105203807-61dcb7`：21 passed / failed0 / skipped0 / exit0；
  首轮 `20261105203211-aca3d2` 为 20 passed / 1 failed / exit1，原因是新增夹具误把 endpoint
  配成 `/search`；依 Rust web_search.rs:2492 改为根地址，全部原断言保留。typecheck
  `20261105203211-428a76`、ledger --check --no-write `20261105203236-efe236` 均 exit0。

### v2 接手盘点（2026-11-04，GPT-6.1 Sol）

同lane基线/恢复作业见 `../mcp/LANE.md`。ACCEPTANCE 不修改，旧勾选不等于v2签收。
①接线 ②所有权 ③serde ④日志/错误 ⑤测试真实性 ⑥完整性 ⑦运行时 ⑧复核闭环。

| 命令/模块（覆盖本目录全部命令） | 八类自查结果与证据 |
|---|---|
| browser_open_session/navigate/back/forward/reload/get_state/close/focus | ①index.ts:187-255→BrowserRuntimeService；②repository/index.ts只写browser库；③IPC由kernel校验，持久化映射待逐字段复审；④index.ts:178-181会重包CommandError，需核对；⑤⑥service/repository原断言复审未结束；⑦await交错/清理仍待核验；⑧未签v2 |
| browser_release_surface_focus/set_surface_bounds/set_surface_visibility/get_surface_host_mode/content_user_input/take_over | ①index.ts:256-305；②无跨表写；③sequence:number与D3需复核；④⑤⑥platform/gates/nonce测试已有，未逐断言签收；⑦真实window/Windows待验；⑧未签v2 |
| browser_snapshot/click/type/set_input_files/scroll | ①index.ts:306-345→surface；②无跨表写；③bridge.ts:117/126 JSON Value待复核；④错误前缀见SPEC；⑤⑥bridge测试含平台用例，必须与Rust cfg重新核对；⑦10s桥超时/真实surface待核验；⑧未签v2 |
| browser_list_downloads/list_task_downloads | ①index.ts:325-337；②browser库/内存；③观察载荷待复核；④⑤⑥复核后撤销原L19-V2-04：getState(非null id)经requireSession抛NotFound（browser-service.ts:520-523,920-923），与browser.rs:450一致；⑦browser-service.ts:780同步hash、index.ts缺artifactRoot生产接线，记L19-V2-05；⑧未签v2 |
| save/get/delete_setting、get/delete_settings_by_prefix、get_security_status、detect_tool_conflicts、get_tools_namespace_config、get_cn_whitelist_config | ①index.ts:346-385；②经F4 API，无自写settings表；③CN数组类型有校验；④错误映射见SPEC；⑤⑥settings/search-commands尚需逐断言复审；⑦无耗时循环；⑧未签v2 |
| get/save_provider_strategies_config | ①index.ts:387-401；②F4 settings；③共享normalize/parse已存在，但搜索loadConfig绕过，L19-V2-02；④save成功缺Rust info（web_search.rs:358），同批修；⑤生产命令反例待补；⑥⑦无事务，保存成功才info；⑧未签v2 |
| get_feature_flags/update_feature_flag/is_feature_enabled | ①index.ts:403-424消费F3；②本地feature-flags.ts仍有重复manager且测试用它替换F3，记L19-V2-06；③④F3解码错误由其负责；⑤feature-flag-commands.test.ts:23-41非真实F3链；⑥⑦set_gradual缺Rust f32转换（index.ts:414），同批修；⑧未签v2 |
| test_search_engine/test_web_search_connectivity/test_all_search_engines/network_probe | ①index.ts:426-511；②F4读配置；③④loadConfig边界见L19-V2-02；⑤生产命令已有用例；⑥test_search_engine未走Rust ToolRegistry超时/reranker、network重定向默认20非10，待核验；⑦Date.now测Instant时长，L19-V2-03；⑧未签v2 |
| browser / browserToolPolicy / webpageToolPolicy服务与工具执行器 | ①index.ts:117-177 provide/register；②webpage_save在repository/vfs-metadata.ts:11直接UPDATE L11 resources，L19-V2-01；③工具闭合参数见index-webpage.ts；④日志待逐项核验；⑤index-webpage-execute真实repos但不是完整插件链；⑥L12 summary缺失保持pending；⑦browser-tool-executor.ts:516/524同步读/哈希及下载deadline待修（L19-V2-05/03）；⑧无独立v2签收 |

计划：先修自查01/02/04，再03/05/06；不删除或弱化旧断言。无新增命令缺口，
但所有旧模块均不得仅凭注册与TESTMAP计数宣称v2完成。复核未勾选项为0不构成免审。
真实阻塞：L11资源元数据所有者API、L12 summary、F2 capability schema/截图与真实窗口，详见BLOCKERS。

#### v2 进度（L19-V2-05）
- 已修：下载哈希改为异步分块读（`service.ts` hashDownloadFileBounded），`onDownloadFinished` 先置 processing、完成后 `finishDownloadHash` 按 id 回写，对应 service.rs:1499 worker 线程 + finish_download_hash；去掉 Rust 没有的 `byPath.delete`。`browser_file_upload` 读文件改 `fs/promises.readFile`。
- 已修：`index.ts` 接线 `artifactRoot`（extensions.rs:186 ChatV2DownloadArtifactRoot → L05 `artifactRoot(dataDir, id, true).path`）。此前生产为 null，Agent 下载全部被拒。
- 证据：`tests/download-wiring.test.ts` 经插件安装路径验证落盘目录与 processing→completed；`browser-service.test.ts` 同步断言 processing 再等 completed。

##### 上传文件 SHA-256 的剩余同步点（本轮候选）
- 发现前次只把上传 readFile 改为 async，但 browser-tool-executor.ts 的整块 createHash.update 仍在 Host 线程。现改用真实 Node WebCrypto `subtle.digest('SHA-256', bytes)` 异步任务，不加额外限额/回退或哈希算法副本。
- Rust browser_executor.rs:771-786 的文件读取错误、16 MiB 累计限额、hex SHA-256、object_handle/locator/base64 均保持；只变 Host 计算调度。
- 既有真实 L05 runtimeRoots 上传测试的所有结果断言保留，另用不替换实现的 spy 观察两次原生 digest 的算法/原始字节；原生结果仍与原 SHA-256 断言比对，不用假 hash 让测试变绿。
- 验证 `20261104184253-a11979` 11 passed / exit0；`20261104184737-aa656c` typecheck exit0；`20261104184737-9e5ee1` 变更文件 strict 0 violation。
- 前一轮遗留的下载同步增量 hasher.update 已进入下方专用 worker 修复候选；整项仍待独立审查，其他平台、取消、owner 缺口不因此关闭。

##### 下载专用 worker 与弱回调（本轮候选，L19-V2-05 / X6-LP-0087:1508）
- 沿用 F3/F4 的 `.ts` worker 装载方式；electron/electron-builder.config.cjs 的 `host/**/*` 和 asar=false 已覆盖入口，无跨 lane 构建改动。`download-hash.ts` 是唯一 SHA-256/64 KiB 有界读取核心，正常从 worker 调用。
- 正常路径 worker 退出后才回写 hash/size 并释放任务预算；不把数据库句柄或文件内容传给 worker。输入与结果均检查字段，文件读错仍返回原 open/read 错误，不误触发 worker 回退。
- Rust service.rs:1499-1510 的线程不可用分支保留：warn 原上下文，再用同一核心 inline hashing；构造失败时 finish 仍在 onDownloadFinished 返回前执行。Node worker 初始化/异常退出会按同一不可用路径记录并 settle，不让 processing 永久挂起。
- 异步回调仅捕获 WeakRef，对应 Rust Arc::downgrade，不强持 BrowserRuntimeService；文件在核心 finally 关闭，主线程等 worker exit 后再发布结果。
- 证据：`tests/service.test.ts` 原 hash/oversize 断言保留，新增 async_hooks 观察真实 WORKER（不替换 Worker/hash）、检查未发回退 warn；缺失文件测试也通过真实 worker。最终复验 `20261104192145-c0535f` 三文件 43 passed；`20261104192145-9a1b5c` typecheck exit0，`20261104192146-81f239` strict 全仓 0 violation。
- 资源耗尽启动失败未做破坏性实测，回退分支目前是 Rust 源码对照证据；真实 Electron 打包/Windows worker 实机验证仍开放，独立复验前不自签。
- 额外调用链核验：当前 Electron 没有 DownloadItem/will-download 转发，SurfaceEventCallbacks 也没有下载事件。服务核心/插件装配测试不是原生端到端下载测试；精确原生回调输入与 L19 决策返回要求已写 BLOCKERS 第7节，交 C1/C2。V2-05 因此仍不签整项完成。

#### v2 进度（L19-V2-06）
- 已修：删除本地重复 `FeatureFlagManager`（`src/feature-flags.ts` 仅保留 get_feature_flags 分组投影与 `rustF64AsF32`），生产只走 F3 `ctx.featureFlags`。测试统一经 `tests/support/f3-feature-flags.ts` 使用 F3 `FeatureFlagManager`（与 storage/index.ts:78-84 同 load/save）。
- 已修：`update_feature_flag` set_gradual 按 `as f32` 转换并取 serde_json f32 最短十进制（0.30000000000000004 → 0.3），命令级断言见 `feature-flag-commands.test.ts`。
- 删除的 13 条本地用例是 dstu-storage feature_flags.rs::tests 的副本，ledger 已归 F3（host/platform/storage/tests/feature-flags.test.ts）。

### v2 排雷清单（X6 基线 2ee9a9cbe，按当前 SHA 9782d55aa 核验）
证据原文：`git show ds-mig/X6-gate-checks:scripts/electron-migration/gate-checks/reports/<gate>.json`。info / 计数类只作人工线索。

| 门禁 | 位置（基线行） | 当前核验 | Rust 证据 | finding / 状态 |
|---|---|---|---|---|
| single-writer | repository/vfs-metadata.ts:11 foreign-table-write resources | 仍直接 UPDATE L11 `resources` | index_webpage_executor.rs:726 | 复用 L19-V2-01，阻塞：需 L11 发布 `resources.updateResourceMetadataWithConn(conn, resourceId, metadataJson, updatedAtMs)`（同连接/同事务内执行，错误原样抛出）；已在 BLOCKERS.md 上报 |
| single-writer[info] | repository/vfs-metadata.ts:11 duplicate-repository | 同上一条根因 | — | 并入 L19-V2-01 |
| single-writer[info] | repository/index.ts:403 settings | 写的是 browser.db 自有 `settings` 表（schema.ts 同库），不是 F4 设置库 | dstu-browser browser/database.rs | 误报，无需改动 |
| unchecked-decode | src/bridge.ts:117/126 | 更正：并不等价。JSON.parse 会接受孤立代理项转义和 ≥128 层嵌套，serde_json 会报错；`trim` 也不同（JS 去 U+FEFF、Rust 去 U+0085） | bridge.rs:153-174 | 已修，见下方 X6-UD 更正 |
| unchecked-decode[info] | browser-tool-executor.ts:345/350/559/605、index-webpage-executor.ts:372-404 | 均为把强类型结构输出为 JsonValue（序列化方向，等价 Serialize），非解码 | — | 无需改动 |
| unchecked-decode[info] | policy.ts:26、service.ts:222 | 元组/几何内部类型收窄，非外部输入 | — | 无需改动 |
| assert-parity | tests/index-webpage.test.ts:54 | 按 Rust 2 条 assert 分别断言 | index_webpage_executor.rs:1293 | X6-assert-browser-index-webpage-54，已修（检查点 `bd57c6b7d`） |
| log-parity[info] | api.ts / database.ts / browser-service.ts / browser-tool-executor.ts / vfs-metadata.ts / index.ts（文件级计数） | 计数线索，未逐条核；不按数量补日志 | — | pending 人工逐位置复核 |

#### C2 稳定 ID 映射（冻结报告 0119143715c0，源码基线 2ee9a9cbe）
只映射到上表条目，不重编 ID，也不重复整改。

| C2 ID | 对应条目 / 旧 finding | 状态 |
|---|---|---|
| X6-SW-0003 | vfs-metadata.ts:11 = L19-V2-01 | 阻塞：等 L11 owner 接口，接口发布后在同一连接里消费 |
| X6-UD-0017、X6-UD-0018 | bridge.ts:117/126 | 已修，见下方 X6-UD 更正 |
| X6-AP-0138 | X6-assert-browser-index-webpage-54 | 已修（检查点 `bd57c6b7d`），main 合并后待独立复验 |
| X6-LP-0084..0091 | log-parity[info] 行 | pending：按分支、字段和时序逐个位置人工核对，不按计数补日志 |

#### X6-UD 更正（X6-UD-0017/0018）
- 之前把“JSON.parse 的结果就是 Value”当作等价，这个判断不成立。`parseBridgeJson` 现在经 `mcp/api.ts` 的 `parseSerdeJson` 解析：语法仍由 JSON.parse 判定（两者文法相同），另外补上 serde_json 才有的拒绝规则，即孤立代理项转义（de.rs parse_escape）和 remaining_depth 128；trim 改用 F4 的 `rustTrim`。
- 证据：`tests/bridge-serde.test.ts`，覆盖外层、内层字符串、BOM 和 U+0085。
- 已知差异：语法错误文本仍是 V8 原文，不是 serde 的 `expected value at line..`；两类 serde 报错的行列号未与 Rust 实际输出比对。数字方面，app 依赖图启用了 arbitrary_precision，Rust 保留大整数精度而 TS 会丢失，归入 D3 大整数项，状态 pending。

#### v2 进度（L19-V2-07：CommandError 重包与窗口错误映射）
- 原表 ④「index.ts:178-181 会重包 CommandError」核实：已是 CommandError 的值会被转成字符串再包一次。现在原样抛出。
- 同根问题：Rust 的 window.rs 错误一律 `.map_err(BrowserError::Validation)`，回退/前进带 `navigate failed: `，reload 带 `reload failed: `，主窗口尺寸带 `main window size failed: `；TS 原来让原始 Error 直接漏出，前端拿不到 `Validation error:` 前缀。现由 `surfaceOp` 统一映射。
- 同根问题：`releaseSurfaceFocus` 原来用 `void` 吞掉错误，现在会抛出（service.rs:833）。关闭时窗口销毁失败，现在先发 `browser:closed` 再返回错误（service.rs:556-565）。`openSession` 清理旧窗口、`rejectClosedGate` 隐藏窗口，按 Rust `let _ =` 忽略结果（service.rs:288-289、398-404）。
- 证据：`tests/browser-service.test.ts` 中「window.rs errors map to BrowserError::Validation」一组。

#### feature-flags.test.ts 断言数 40 → 11 的说明（自动质量反馈）
- 断言没有为通过测试而削弱。被删的是 L19-V2-06 已删除的本地重复 `FeatureFlagManager` 的测试：8 条 `dstu-storage feature_flags.rs::tests` 在 ledger 归 F3，F3 的 `host/platform/storage/tests/feature-flags.test.ts` 已有同名 8 条（共 33 个 expect）；另 5 条测的是本地实现，现在由 F3 负责。本文件保留本 lane 自己的 get_feature_flags 分组投影和 `as f32` 转换断言。

#### v2 进度（L19-V2-08：network_probe 重定向与超时）
- 原实现用 fetch 的 `redirect: 'follow'`，最多跟随 20 次重定向，错误文本是 undici 原文。Rust 用 reqwest 0.11 默认 Client：`Policy::limited(10)` 在链上已有 10 个 URL 时报错（实际跟随 9 次）；`ClientBuilder::timeout` 是整条链共用的一个总预算。
- 新增 `src/network-probe.ts`，用真实 fetch 加 `redirect: 'manual'` 逐跳跟随，共用一个 `AbortSignal.timeout`。错误按 reqwest Display 格式输出，不新增任意上限：
  - 重定向超限：`error following redirect for url (<返回第 10 个 3xx 的 URL>): too many redirects`
  - 超时：`error sending request for url (<当前 URL>): operation timed out`
  - 非 http(s) 跳转：`builder error for url (<目标>): URL scheme is not allowed`
- 和 reqwest 一致的行为：无 Location 或 Location 无效时，直接返回该 3xx 响应；301/302/303 和 307/308 都保持 HEAD/GET 方法不变。
- 证据：`tests/search-commands.test.ts` 新增「over a real HTTP transport」一组，用本机 node:http 服务器经生产命令 `network_probe` 测试，覆盖 9 跳成功、第 10 跳报错、多跳共用超时、无 Location、ftp 跳转。
- 仍开放：连接失败时的底层原因文本是 undici 的（例如 `fetch failed` 的 cause），不是 hyper 的。前缀 `error sending request for url (...)` 已对齐，原因文本无法逐字对齐。

#### v2 进度（L19-V2-09：test_search_engine 真实 registry，候选待复核）
- 命令改为 `createWebSearchToolRegistry(...).callTool('web_search', args, stage=test)`，与 MCP registry 使用同一本地工具分支，而非直接 doSearch；保留 Rust 的 `num_results:3`（WebSearchTool 不识别，因此实际 top_k=5）。
- registry 的 15000ms timeout 现在取消底层搜索（HTTP / backoff / semaphore / rate 等待），对应 Rust tokio timeout 丢弃 future。WebSearchService 增加可选 signal 参数，原 L13 config/input/signal 调用保持不变。
- 错误 tuple 按 tools/mod.rs:1083-1102 取 error.message，失败不带 citations/inject；正常缺 usage 由 registry 填 elapsed_ms。
- 中断前失败测试根因：与上一条命令使用相同固定 query，命中真实缓存，fetch 根本没发生。新用例通过真实设置关闭缓存，provider 超时设为 30000ms，在 kernel 命令入口验证 15000ms registry timeout、底层 signal abort，随后重新请求成功证明并发名额释放，并断言出站 max_results=5；不放宽原超时断言。
- 验证：20261104145756-44c3d3 两文件 24 passed；新增真实 doSearch 错误 tuple 测试 20261104150207-9b5afa 五条通过；typecheck 20261104145756-103e57 exit0。
- 未完成部分明确保留：reranker 的 owner API 与本 lane citation/chunk/重排/日志接线（详见 mcp/BLOCKERS.md），D3、serde 语法错误原文以及 LP 仍开放。不以本项测试通过签完整 WebSearchTool 等价。

#### v2 进度（L19-V2-10：消费 main 的 L12 status summary，候选待复核）
- 核实 main `vfs-index/api.ts:313-318,359` 的公开形状及 `index.ts:104` 的生产 provide；browser 原动态能力探测已可调用，不再以“未提供”阻塞。改为直接引用公开类型，去掉自有副本和私有交叉类型补丁。
- 摘要 read 错误按 Rust index_webpage_executor.rs:78-81 映射 `INDEX_STATUS_FAILED`，且发生在资源查找之前；所有 status 响应均带真实 summary，缺服务仅为启动期不可用，不再声称 L12 未发布。
- `tests/index-status-wiring.test.ts` 安装真实 paths/VFS/repos/index/agent-skills/browser，通过实际注册执行器验证原 Rust `webpage_persistence_status_and_rebuild_preflight_use_real_vfs_state`，逐条保留原断言；另关闭真实连接验证错误类型/顺序。未复制 L12 查询，也未用替身 summary。
- 验证：`20261104152324-d8eca2` 2 passed / exit0；`20261104152324-bde932` typecheck exit0。
- TESTMAP 的 GENERATED 行不越权编辑；手工说明已替换为实现就绪、待协调者登记。L19-V2-01 / D3 / serde 原文 / LP 等仍开放，独立复验前不自签。

#### X6 单 SW 快照增量核对（1c8239f67）
- 固定 main `4525e11ac` / 规则 `6002c7fbd` 的 `vfs-metadata.ts:11` 仍对应原 `X6-SW-0003 = L19-V2-01`，不按新数组重编号，不重开第二缺陷。
- 当前 main `1e893eb61` 与 L11 候选 `6525dc938` 公开面均未提供同语义 metadata 更新方法。BLOCKERS.md 已细化为接收 metadataJson 的同 conn/仅两字段 UPDATE，保留 serialize→UPDATE→unit sync 与错误顺序。
- 仅更新缺口证据；未搬 SQL、未复制 owner 仓储、未触碰 L19-V2-10 摘要接线，也不由“1 条 blocking”推导 browser 全部完成。

#### L19-V2-10 集成反馈修复：真实测试宿主缺 notes 依赖
- 复现作业 `20261104172927-168f79`：两条 index-status-wiring 用例都在 createTestHost 启动阶段失败，`dstu.vfs` 当前要求 `storage/notes/vfsRepo/vfsIndex`，原宿主漏装 notes；不是 summary 断言或业务实现的失败。
- 修复只在测试宿主安装真实 `notes/index.ts`，按 paths→repos→notes→index→vfs→skills→browser 装配。未放宽 VFS inject、未替换仓储/summary、未删改原断言或 TESTMAP 状态。
- 修后最小复验 `20261104173200-dd9672` 2 passed / exit0。按协调者指令完整复验 `20261104173440-70c9e7` 两目录 44 files / 343 passed / exit0；`20261104173441-5975df` typecheck exit0，`20261104172927-c01f9c` boundaries 0 violation / exit0；独立复验前不自签。

#### L19-V2-12：截图能力原文与错误阻塞订正（候选待复核）
- Rust browser_executor.rs:997-1019 固定返回 available=false，不调用原生截图。撤销 BLOCKERS 中“Rust 走原生截图，等 F2”的错误描述；不因 F2 新增 Electron 截图能力擅自扩展迁移范围。
- screenshot reason 改回 Rust 原文；`tool-executor-execute.test.ts` 新增完整 payload/session_id/url/object_handle 断言，并通过 surface 调用计数证明不以 DOM snapshot 冒充截图。此测试验证生产执行器决策，不冒充 Electron 像素截图实机验收。
- 验证 `20261104181158-c0f9f6` 11 passed / exit0；`20261104181158-d36304` typecheck exit0。F2 schema 与实机项仍开放。

#### browser LP 逐位置审读增量
- X6-LP-0085：database.rs:230 的唯一 warn 仅在 `cfg(not(feature="data_governance"))` 跳过迁移时发出。app Cargo.toml:596/621、dstu-browser Cargo.toml:67 默认均开启治理迁移；Host 正常运行迁移，不补一条虚假的 skipped 警告。此为默认生产路径不适用候选证据，待独立判定。
- X6-LP-0086：events.rs:97/103/109/115/121/127 六个 emit 失败都已汇入 browser-service.ts emitEvent 的 warn，不能凭文件计数判漏日志；Error Display 等字段精确度仍保留待审，不签整模块。
- X6-LP-0089 / X6-LP-0090：核出密码 BLOCKED 控制权移交和 save_tool_block 路径尚未闭合，精确前置接缝/自有后续已写 BLOCKERS 第5/6节，交 C1/C2，不靠新增无意义 warn 伪装完成。
- X6-LP-0089 自有部分已接：`browser-tool-executor.ts` 的 `bridgeMaybeTakeover` 包住 click/typeText/setInputFiles（Rust :604/:658/:845），密码 BLOCKED 时调用 `takeOverWithReason("password_blocked")`，失败 warn、成功 info，再原样抛出交给原有映射。`tool-executor-execute.test.ts` 用 Bridge 形状的 surface 拒绝验证三个调用点、非密码分支和 warn 分支。经 Electron 壳桥的真实路径仍要等 F2 保留 details（BLOCKERS 第5节）。
