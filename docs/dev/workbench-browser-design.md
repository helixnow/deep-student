# Learning OS 内置浏览器设计（审阅定案）

> **状态**：设计真源（2026-07-13 已落地原生 child WebView）  
> **日期**：2026-07-13（初版定案：2026-07-09）  
> **定位**：学生与 AI 在同一张学习桌面上共视、共控的网页——AI 可代为查找与翻页，登录与提交始终由你接管。

相关：`learning-os-workbench-design.md` · `workbench-progress/COORDINATION.md`  
竞品调研画布：agent-browser-computer-use-2026（Cursor 侧）

---

## 0. 一句话结论

```
Browser = Workbench chrome（DOM）+ 原生 browser-content WebView + 注入桥
         ├─ macOS / Windows：main 原生窗口的 child WebView
         └─ Linux：独立 WebviewWindow fallback
         （Windows 可选 CDP 加速，默认关）
```

- **不是** iframe / 系统 Chrome / 桌面 Computer Use / Playwright 运行时。  
- macOS / Windows **使用** Tauri `unstable` 的 `Window::add_child(WebviewBuilder)`；页面不是新的顶层原生窗口。  
- **是** 用户可见共享会话；Agent 与用户操作同一页。

---

## 1. 架构单一真相（一期）

### 1.1 窗口与 Session

| 层 | 身份 | 规则 |
|----|------|------|
| Chrome | `typeId: 'browser'`，`instanceMode: 'single'` | 进 `windowStore`；默认 960×700，最小 640×420，包含工具条与页面槽位 |
| Content | WebView label **固定** `browser-content` | **不进** `windowStore`；macOS / Windows 附着到 `main`，Linux 保留独立窗口 fallback |
| Session | 全局 0..1 | 单历史栈；多 tab/多 session → 二期 |
| Profile | `{active_slot}/browser-profiles/default/` | 与 main 隔离；Win=`data_directory`；macOS=`data_store_identifier` |

- 关 chrome / 关 workbench / 关 browser flag → **销毁** content WebView（禁止孤儿宿主）。  
- **不默认钉 Dock**；AppsPanel / Agent launch 发现；运行中进 Dock。  
- **不做** follow-attach：macOS / Windows 直接使用内部页面槽位；Linux fallback 提供「显示页面」。

### 1.2 原生 Surface 布局协议

页面内容属于原生 WebView 层，不是 React 子树。Workbench 只绘制 chrome 与一个矩形 DOM 槽位，并通过命令同步原生 Surface：

| 环节 | 实现约束 |
|------|----------|
| 测量 | `BrowserAppWindow` 用 `ResizeObserver` + `getBoundingClientRect()` 读取槽位 CSS 坐标与 viewport |
| 提交 | `browser_set_surface_bounds` 携带单调 `sequence`；Rust 丢弃过期异步结果，将 CSS 坐标换算为物理像素后一次 `Webview::set_bounds(Rect)` 提交 |
| 显隐 | `browser_set_surface_visibility` 仅在 browser 窗 active、visible、有 session、无 Workbench overlay 且未 suspend 时显示 |
| 手势 | `WindowShell` 在拖动/缩放开始时同步 suspend，结束后重新测量再 resume，避免原生页面滞留在旧位置 |
| 平台 | `browser_get_surface_host_mode` 返回 `embedded` 或 `detached`；当前 Tauri GTK host 无同等的任意 child bounds 路径，Linux detached 模式忽略槽位 bounds |

槽位任一边越出主 viewport 时 fail-safe 隐藏，不尝试让 React 壳裁切原生 WebView。

### 1.3 控制面

```
Chat browser_* → ApprovalManager → BrowserService → 注入桥
                                      └─ Win 可选 CDP（失败回退桥）
```

- 桥结果取回：**禁止**纯 `eval` 轮询；用 `with_webview` 平台回调（或 Win CDP）。  
- Agent **禁止** Playwright/Chromium 子进程。  
- LLM 只用 snapshot `ref`；坐标点击不对模型开放。

### 1.4 导航与安全默认

| 项 | 一期默认 |
|----|----------|
| `https:` | 允许（仍受网络模式/审批） |
| `http:` | **仅 loopback**；其余需 `allow_insecure_http` |
| `file:` / `javascript:` / `data:` / `tauri:` / `asset:` | 顶层导航拒绝 |
| Agent 私网 | **硬拦**（对齐 `is_internal_ip`，含重定向） |
| content capability | **零 IPC**（禁止 `core:default`）；按 WebView label `browser-content` 隔离 |
| 密码/OTP | 强制 Take over；Bridge/Executor **硬拒** type |
| CDP remote port | **默认关**；生产不默认开 |

主 CSP **不改** `frame-src blob:`。

### 1.5 工具 ↔ Rust 对齐

| LLM 工具 | Rust | Sensitivity |
|----------|------|-------------|
| `browser_open` | `browser_open_session` | High |
| `browser_navigate` | `browser_navigate` | Medium |
| `browser_snapshot` | 桥 `snapshot` | Low |
| `browser_click` / `type` | 桥 | Medium（密码硬拒） |
| `browser_scroll` / `back` / `close` | 对应 | Low |
| — | `forward` / `reload` / `get_state` / `focus` | chrome/内部 |

`web_fetch` = 无头只读；有交互/共视 → browser。`agent_turn` **默认不纳入** browser_*。

---

## 2. UX 定案（一期）

- **内部页面**：macOS / Windows 的网页直接显示在 Workbench Browser 窗的页面槽位；Linux 使用独立窗口 fallback 与「显示页面」。  
- **控制态**：`user | agent`；Take over / Stop / 用户导航·点击·键入 → 硬打断；**纯滚动不打断**。  
- **登录**：密码框 → 自动接管；Agent 不得代填。  
- **差异化**：共视 + 人控交接 + 学习桌面并排；不做 Design Mode。

原生 child WebView 不参与 DOM 合成，因此没有 CSS `z-index`、`overflow` / `border-radius` 裁切或 Workbench transform 动画。浏览器壳只提供矩形内边框；拖动、缩放、Exposé、切窗器、快捷键面板与 AppsPanel 打开时必须先隐藏 Surface，稳定后重测并显示。Tauri `unstable` 是升级风险面，升级 Tauri / Wry 时必须回归主 WebView 的焦点、拖放、缩放与全屏行为。

---

## 3. Flags（唯一命名）

| 层 | Key | 生产默认 | 开发建议 |
|----|-----|----------|----------|
| 父闸 | `desktop.workbenchMode` | false | 自开 |
| 子闸 | `desktop.workbenchBrowserEnabled` | false | DEV 可 true |
| 网络 | `desktop.workbenchBrowserNetworkMode` | `local_whitelist` | 同左 |
| Agent | `desktop.workbenchBrowserAgentControl` | false | 始终 false |
| CDP | `desktop.workbenchBrowserCdpWindows` | false | 始终 false |
| 硬闸 | `ui.workbench_browser` | disable | debug 可 enable |
| Agent 硬闸 | `tools.browser_agent` | disable | disable |

废弃别名：`browser.enabled` / `browser_cdp_windows` 等，勿引入。

---

## 4. 分期

| 阶段 | 内容 |
|------|------|
| **Phase 0** | Spike：外站 WebView、注入、`eval_with_result`、profile、capability、Win CDP 探测（1–2 天） |
| **Phase 1** | 用户浏览 + 桥 + Agent 八工具 + 审批；CDP 可选默认关 |
| **Phase 2** | 多 tab、软附着、摘录到 Chat、下载管理 |
| **Phase 3** | Chromium sidecar **仅当** T1–T6 全满足（见能力矩阵审阅） |

---

## 5. PR 序列（审阅优化后）

| PR | 内容 | 硬依赖 |
|----|------|--------|
| 0 | 本文 + COORDINATION 写权 + BROWSER.md | — |
| 1 | Phase 0 spike + `browser-spike-results.md` | 0 |
| 2 | policy + flags（不开窗） | 0 |
| 3 | runtime + **零 capability** content WebView（macOS/Windows child；Linux detached） | 1+2 |
| 4 | Workbench chrome + DOM 页面槽位 + settings + i18n | 3 |
| 5 | 注入桥（snapshot/click/type） | 3 |
| 6 | ChatV2 agent tools + Approval | 4+5 |
| 7 | Win CDP 可选 + acceptance | 5 |

**不可颠倒**：capability 与开窗同 PR 或更早；Agent 不得先于桥；Playwright 不得进 runtime。

禁碰：`StatusBar*`、`flashcards*`、`DEFAULT_DOCK_PINNED`、sandbox/`web_fetch` 语义。

---

## 6. 安全门禁（合并前）

- [ ] `default` 仅匹配 `webviews: ["main"]`；`browser-content` 独立 capability 零 IPC  
- [ ] scheme 黑名单 + http 仅 loopback + Agent 私网硬拦  
- [ ] 密码 type 硬拒（桥+executor）  
- [ ] snapshot 包 `<untrusted_web_content>` + 截断  
- [ ] 无 Playwright 运行时；无生产默认 CDP port  
- [ ] 关 workbench/browser → 无孤儿 WebView / fallback 窗口  
- [ ] 主 CSP `frame-src blob:` 未放宽  

---

## 7. Phase 0 Spike 清单

| ID | 项 | 失败 |
|----|-----|------|
| S1 | External 外站 WebView（macOS/Windows child；Linux detached） | 阻塞 |
| S2a | initialization_script | 阻塞 |
| S2b | **with_webview 结果取回** | 阻塞 |
| S3 | profile 隔离 | 阻塞 |
| S4a | Win CDP 探测（可选） | CDP 默认关，不阻塞 |
| S4b | GPU env × builder args | ADR |
| S5 | capability 隔离 | 阻塞 |

明确不做：follow-attach、Playwright、多窗压测。

---

## 8. 审阅否决项（勿回潮）

1. Playwright 作 Agent 运行时  
2. `browser-content` WebView 获得 `core:default`  
3. 一期 follow-attach / multi session  
4. 纯 `eval` 轮询取桥结果  
5. CDP Spike 通过后默认开  
6. 地址栏放行 `file:`  
7. Agent 代填密码（仅靠 Medium 审批不够）  

---

## 9. 独立数据库（2026-07-09 三路调研定案）

> 调研：[DB schema](94485ace-ef0b-4ef7-afdf-ac4000469675) · [governance](c981d2f6-8579-45e1-a94f-077a0d7c682b) · [API 边界](baabc9ba-e15d-4785-bb27-a9d03089acda)

| 项 | 定案 |
|----|------|
| 文件 | `{active_slot}/browser.db`（与 chat_v2/mistakes 同级） |
| Profile | `{active_slot}/browser-profiles/default/`（真 cookie/缓存；**不进** SQLite） |
| 治理 | **一期豁免**：不进 `DatabaseId` / RowSync / 默认备份（对齐 `message_queue.db`） |
| 建库 | **懒加载**：双闸开启且首次 `browser_open_session` 才建库迁移；flag 关不建库 |
| 迁移 | `migrations/browser/V20260711__init.sql`；模块内 Refinery；**不**挂 `run_all()` |
| 清除 | 「清历史」= DB；「清 Cookie」= profile；「全部」= 两者；禁用浏览器 = **保留文件** |
| 豁免注释 | `schema_registry.rs` / `dataGovernance.ts` 与 `message_queue.db` 同级声明；`migrations/README.md` 注明 `browser/` |

### 9.1 职责切分

| 数据 | 落点 |
|------|------|
| session / history / downloads 元数据 / site_permissions / settings | `browser.db` |
| controlMode / loading / CDP 句柄 | 仅内存 |
| cookie / localStorage / IndexedDB / HTTP cache | 仅 WebView profile |
| 密码 / OTP | **不存** |

### 9.2 一期最小表

`sessions` · `history` · `downloads` · `site_permissions` · `settings`（downloads UI 可二期再接）

### 9.3 硬禁

- 不得写入 `mistakes` / `chat_v2` / `vfs` / `llm_usage`
- 不得把浏览历史做成 RowSync
- 禁用 flag 时不得静默删库/profile

---

## 10. 实现落点（路径约定）

| 路径 | 职责 |
|------|------|
| `src-tauri/src/browser/` | database / repository / service / session / policy / bridge / 原生 WebView host |
| `src-tauri/migrations/browser/` | 独立迁移 |
| `src-tauri/capabilities/` | content 零权限（或不声明） |
| `src/features/browser/` | sessionStore / browserApi / contentWindow / nativeSurface 坐标协议 |
| `src/features/workbench/apps/browser/` | register + BrowserAppWindow + DOM 页面槽位与显隐生命周期 |
| `src/features/workbench/core/nativeSurfaceEvents.ts` | Workbench 壳与原生 Surface 的 suspend / resume / sync 协议 |
| `src-tauri/src/chat_v2/tools/browser_executor.rs` | Agent 工具 |
| `docs/dev/workbench-progress/BROWSER.md` | 实施 checklist（含 10 代理落地分工与验收命令） |

宿主实现：macOS / Windows 使用 Tauri `Window::add_child(WebviewBuilder)`；Linux 的独立 `WebviewWindow` 生命周期可参考 `src/features/pomodoro/miniWindow.ts`。数据库先例仍为 `ChatV2Database`（独立库+池，但 Browser **lazy** 开库）。

落地写权拆分（B0 / B1a–e / B2a–c / B3）与验收命令见 `BROWSER.md`；勿在本文件重复维护进度勾选。

---

*本文为唯一设计真源。切片冲突以 §1 / §8 / §9 为准。*
