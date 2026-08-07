# BROWSER 实施 checklist

规格：`docs/dev/workbench-browser-design.md`（§1 / §8 / §9 为冲突裁决真源）

> **落地轮（2026-07-09）**：初由 10 代理并行拆分；同日用户要求关闭子代理，由父代理独自收口接线与验收。  
> **原生 Surface 轮（2026-07-13）**：macOS / Windows 改为 `main` 的 child WebView；Linux 保留独立 `WebviewWindow` fallback。  
> 勾选约定：代码已落地且父代理核对过的项勾选；手工门禁仍待真机冒烟。

---

## 独立 DB / Profile（§9 定案摘要）

| 项 | 定案 |
|----|------|
| DB 路径 | `{active_slot}/browser.db`（与 chat_v2 / mistakes 同级） |
| Profile | `{active_slot}/browser-profiles/default/`（cookie / 缓存；**不进** SQLite） |
| 建库 | **懒加载**：双闸开启且首次 `browser_open_session` 才建库+迁移；flag 关不建库 |
| 治理 | **一期豁免**：不进 `DatabaseId` / RowSync / 默认备份（对齐 `message_queue.db`） |
| 迁移 | `migrations/browser/V20260711__init.sql`；模块内 Refinery；**不**挂 `run_all()` |
| 清除 | 「清历史」= DB；「清 Cookie」= profile；「全部」= 两者；**禁用浏览器 = 保留文件** |

治理注释落点：`schema_registry.rs` / `src/types/dataGovernance.ts`（仅注释，不纳管）。

---

## 原生页面 Surface（2026-07-13）

| 层 | 当前实现 |
|----|----------|
| macOS / Windows host | Tauri `unstable` `Window::add_child(WebviewBuilder)`；`browser-content` 是 `main` 的原生 child WebView，不再创建第二个顶层页面窗口 |
| Linux host | `WebviewWindowBuilder` detached fallback；Browser chrome 内显示「网页已在独立窗口中打开」与「显示页面」 |
| DOM 占位 | `BrowserAppWindow` 提供矩形 page slot，以 `ResizeObserver` / viewport resize 触发测量 |
| Bounds 命令 | `browser_set_surface_bounds`：CSS 坐标 + viewport + 单调 sequence；Rust 换算主窗口物理像素并原子调用一次 `Webview::set_bounds`，忽略过期 sequence |
| Visibility 命令 | `browser_set_surface_visibility`：窗口非 active / 非 visible、无 session、overlay 打开或 shell 手势 suspend 时隐藏 |
| Workbench 协调 | `WindowShell` 拖动/缩放开始 dispatch `suspend`，结束 dispatch `resume`；重新测量成功后才显示 |
| Capability | `default.json` 仅匹配 `webviews: ["main"]`；`browser-content.json` 仅匹配 `webviews: ["browser-content"]` 且 `permissions: []` |

原生 Surface 不参与 DOM 合成：不能依靠 CSS `z-index`、`overflow` / 圆角裁切或 transform 动画约束它。当前策略是在拖动、缩放、Exposé、切窗器、快捷键面板与 AppsPanel 打开时隐藏，稳定后重测；槽位越出 viewport 时也 fail-safe 隐藏。

---

## 10 代理落地分工 → 父代理收口

| 代理 | 范围 | 独占写权（摘要） | 进度 |
|------|------|------------------|------|
| **B0** Docs | 设计真源 / checklist / 治理豁免注释 | `workbench-browser-design.md`、`BROWSER.md`、`schema_registry` 注释、`dataGovernance.ts` 注释、`migrations/README.md` | [x] |
| **B1a** DB | 独立库 + 迁移 + repository | `migrations/browser/**`、`browser/{database,repository,error,types}.rs` | [x] |
| **B1b** Policy/Flags | 导航策略 + feature flags | `browser/policy*`、`feature_flags` browser 键、前端 `navigationPolicy` | [x] |
| **B1c** Service/Window | BrowserService + native content host（macOS/Windows child WebView；Linux WebviewWindow fallback） | `browser/service.rs`、`window.rs`、`session.rs`、事件 | [x] |
| **B1d** Bridge | 注入桥 + `with_webview` 取回 | `browser/bridge*`、`browser_bridge.js` | [x] Win ExecuteScript；非 Win → Unsupported |
| **B1e** Commands | Tauri commands + lib 接线 | `cmd/browser*`、`lib.rs`/`cmd/mod.rs` 注册（不预开库） | [x] |
| **B2a** Store | sessionStore + browserApi | `src/features/browser/**` | [x] |
| **B2b** UI | Workbench Browser App + DOM page slot / native Surface 协调 | `apps/browser/**`、`registerAll` 调 `registerBrowserApp`、`core/nativeSurfaceEvents.ts` | [x] 未钉 Dock |
| **B2c** Settings/i18n | 设置子开关 + 文案 | `WorkbenchSettingsSection`、locales `browser*` | [x] |
| **B3** Agent | ChatV2 `browser_*` + Approval | `browser_executor.rs`、pipeline 注册、`browser-tools` skill、approval 文案 | [x] |

禁碰（已核对）：`StatusBar*`、`flashcards*`、`DEFAULT_DOCK_PINNED`（仍为 `chat/files/settings/todo`）、sandbox / `web_fetch` 语义、Playwright 作 agent 运行时。

CDP：设置键已有（默认关）；`browser/cdp_windows.rs` 未落地，不阻塞 MVP。

---

## Phase 0 Spike

- [ ] S1 External 外站 WebView（macOS/Windows child；Linux detached）
- [ ] S2a initialization_script
- [ ] S2b with_webview 结果取回
- [ ] S3 profile 隔离
- [ ] S4a Win CDP 探测（可选）
- [ ] S4b GPU env × builder args
- [ ] S5 capability 隔离（代码侧：`capabilities/browser-content.json` 已零权限）
- [ ] 结果写入 `docs/dev/browser-spike-results.md`

> Spike 文档可后补；实现已按设计直落 Phase 1。

## Phase 1（对齐 PR-2…PR-7）

- [x] PR-2 policy + flags ← B1b
- [x] PR-3 runtime + WebView-scoped 零 capability ← B1c + `browser-content.json`
- [x] PR-4 chrome + DOM page slot + native Surface 协调 + i18n ← B2b + B2c
- [x] PR-5 注入桥 ← B1d
- [x] PR-6 agent tools ← B3
- [ ] PR-7 CDP 可选 + acceptance（默认关；设置 UI 已有，运行时可选后续）

---

## 验收命令（父代理 2026-07-09）

```bash
# 编译门禁 — PASS（exit 0，仅既有 warnings）
cd src-tauri && cargo check -p deep-student --lib

# Rust browser 单测 — 本机未能跑通：test harness 启动即
# STATUS_ENTRYPOINT_NOT_FOUND (0xc0000139)。编译 test profile 成功；
# 属 Windows DLL/入口环境问题，非 browser 模块编译错误。可在干净环境重跑：
cd src-tauri && cargo test -p deep-student --lib browser::

# 前端 — PASS：5 files / 34 tests
npx vitest run tests/vitest/browser src/features/workbench/apps/browser/__tests__ \
  tests/vitest/workbench/workbenchSettingsSection.test.tsx \
  tests/vitest/workbench/workbenchI18nParity.test.ts
```

手工 / 安全门禁（合并前仍需真机）：

- [ ] 双闸关：不建 `browser.db`、不创建 content host
- [ ] 双闸开 + `browser_open_session`：建库迁移成功；profile 目录隔离
- [ ] macOS / Windows：页面在 Browser 内部槽位显示，系统中没有第二个 browser 顶层窗口
- [ ] 拖动/缩放时页面 Surface 隐藏；松手后按新槽位恢复，位置与尺寸无漂移
- [ ] Browser 失焦、最小化、Exposé / 切窗器 / AppsPanel 打开时页面 Surface 隐藏，恢复后重新对齐
- [ ] Linux：detached fallback 与「显示页面」可用
- [ ] content **零** `core:default`；关 chrome / 关 workbench → 无孤儿 WebView / 窗口
- [ ] 「清历史 / 清 Cookie / 全部」语义正确；禁用 flag **不**删文件
- [x] 无 Playwright 运行时；生产 flags / CDP 默认关（代码侧已确认）
- [ ] 主 CSP `frame-src blob:` 未放宽

---

## 门禁

- [x] 不改 `DEFAULT_DOCK_PINNED` / StatusBar / flashcards
- [x] 无 Playwright 运行时
- [x] 生产 flags 默认关（`ui.workbench_browser` / `tools.browser_agent`）
- [ ] 主 CSP `frame-src blob:` 未放宽（待抽查）
- [x] `browser.db` / `browser-profiles` 一期豁免治理（注释已声明）
- [x] capability 按 WebView label 隔离：`default` → `main`，`browser-content` → 零权限 content WebView

---

## 接线索引（收口核对）

| 层 | 路径 |
|----|------|
| Design SSOT | `docs/dev/workbench-browser-design.md` |
| Rust 模块 | `src-tauri/src/browser/*` |
| Commands | `src-tauri/src/cmd/browser.rs` → `lib.rs` handlers |
| Agent | `chat_v2/tools/browser_executor.rs` + pipeline + approval |
| FE | `src/features/browser/*` + `apps/browser/*` + `core/nativeSurfaceEvents.ts` |
| Capability | `capabilities/default.json`（main WebView）+ `capabilities/browser-content.json`（content WebView，permissions: []） |
| Skill | `builtin-tools/browser-tools.ts` |

---

## 历史落地路线（父代理规划 · 2026-07-09）

> 本节保留 2026-07-09 当时的缺口判断与切片顺序，供追溯使用，不代表 2026-07-13 当前完成状态；当前原生 Surface 状态以上文为准。冲突仍以 design §1 / §8 / §9 为准。  
> **禁止回潮**：Playwright 运行时 · `browser-content` WebView 获得 `core:default` · follow-attach · eval 轮询 · CDP 默认开 · `file:` 导航 · Agent 代填密码。

### Wave A — Phase 1 闭环（合并前必须）

当时记录的首要缺口是控制态与人机交接：`ControlMode` 尚未切到 Agent，且 Rust 尚无 `browser_take_over` command；这些条目用于保留原始规划语境。

| ID | 切片 | 要做什么 | 关键落点 | 验收 |
|----|------|----------|----------|------|
| **A1** | ControlMode 真源 | Agent 工具开始时 `control_mode=Agent`；`take_over` / Stop → `User`；用户导航·点击·键入硬打断；**纯滚动不打断**；密码桥 `BLOCKED` → 强制 Take over + 事件 | `session.rs`、`service.rs`、`cmd/browser.rs`（补 `browser_take_over` / 可选 `browser_stop`）、`browser_executor.rs`、chrome AgentBar | 单元：模式切换；手工：Agent 操作时 chrome 显示「助手操控」+ 接管有效 |
| **A2** | 事件总线 FE | 订阅 `browser:navigated` / `closed` / `title-changed` hydrate store；禁止仅靠 invoke 回执 | `sessionStore` / `useBrowserSession` / 新 `browserEvents.ts` | Agent 导航后地址栏/标题自动更新；关 content 后 chrome 复位 |
| **A3** | 生命周期无孤儿 | 关 workbench / 关 `workbenchBrowserEnabled` / 关 `ui.workbench_browser` → `close_session`+毁 content host；设置变更监听 | `WorkbenchDesktop` 或 settings 变更桥、`BrowserService` | 手工：关桌面/关子闸后无 `browser-content` WebView / fallback 窗口 |
| **A4** | 清除数据 | `clear_history`（DB）/ `clear_cookies`（profile，需先关窗）/ `clear_all`；设置 UI 三按钮；**禁用 flag 不删文件** | `repository`+`service`+`cmd`、`WorkbenchSettingsSection`、i18n | 清历史后 DB 空、cookie 仍在；清 Cookie 后需重登；禁用保留文件 |
| **A5** | 网络模式端到端 | `local_whitelist` vs `full` 在顶层导航+重定向路径一致；白名单语义写清（若一期=仅 loopback+https 公网，文档对齐代码） | `policy.rs`、`service` 导航钩子、settings confirm | 单测 + 手工：非 full 拒非 loopback http |
| **A6** | 安全门禁清单勾完 | design §6 逐项；CSP `frame-src blob:` 抽查（已确认主 CSP 含之，合并前再 diff）；密码硬拒 executor+桥双测 | `tauri.conf.json`、bridge tests、executor tests | BROWSER.md §安全门禁全勾 |
| **A7** | 真机冒烟 + spike 补记 | 双闸关不建库；开 session 建库+profile；验证 child WebView bounds/visibility 与 capability 零 IPC；写 `browser-spike-results.md`（可事后补，标「实现直落」） | `docs/dev/browser-spike-results.md` | 手工 checklist 全过 |

### Wave B — Phase 1 硬化（可紧随 A 或同 PR 尾部）

| ID | 切片 | 要做什么 | 备注 |
|----|------|----------|------|
| **B1** | 非 Win 桥结果 | macOS/Linux：`eval_with_result` 现为 Unsupported → Agent snapshot/click/type 不可用。选项：(a) 文档标明 Win-first；(b) 补 WKWebView/WebKitGTK 回调；(c) 仅 Win 开 `tools.browser_agent` | 产品需二选一，避免「开了 Agent 全失败」 |
| **B2** | 导航拦截钩子 | content 内链 / 重定向 / `window.open` 走同一 policy；Agent 私网含跳转后 URL | `window.rs` + platform navigation events |
| **B3** | site_permissions 最小 | 表已有；一期至少：拒绝通知/地理等敏感权限默认 deny + 可查 | UI 可极简或仅 Rust 默认 |
| **B4** | 测试环境 | 修复本机 `cargo test --lib` `STATUS_ENTRYPOINT_NOT_FOUND`（或 CI 绿）；`browser::` + bridge logic `.mjs` 进 CI | 与功能正交但阻塞信心 |
| **B5** | i18n / chrome 文案补齐 | `takeOver` / `stop` / `userControl` / `showContent` / 清除确认；中英 parity | locales + vitest parity |
| **B6** | PR-7 CDP（可选） | `cdp_windows.rs`：仅当设置开；失败回退桥；**永不**默认开 remote port | 不阻塞 A；可独立 PR |

### Wave C — Phase 2（设计已定，勿提前塞进 MVP）

| ID | 内容 |
|----|------|
| **C1** | 多 tab / 多 session（打破全局 0..1） |
| **C2** | 软附着 / follow-attach（一期明确不做） |
| **C3** | 摘录到 Chat |
| **C4** | 下载管理 UI（表 `downloads` 已建，接下载事件+面板） |
| **C5** | 历史面板 / 搜索（超 chrome 迷你栈） |

### Wave D — Phase 3（门槛极高）

Chromium sidecar **仅当**能力矩阵 T1–T6 全满足；默认路径仍为系统 WebView + 桥。

### 建议落地顺序（单线程）

```
A1 ControlMode + take_over command
 → A2 事件 hydrate
 → A3 无孤儿生命周期
 → A5 网络模式（可与 A3 并行读）
 → A4 清除数据
 → A6 安全勾选 + A7 冒烟
 → B1 平台策略拍板
 → B2 导航钩子
 → B4 CI 测试
 → B5 i18n
 → B6 CDP（可选）
 → C* 按产品优先级另开里程碑
```

### 明确不在后续范围（除非改 design）

- Playwright / 额外 Chromium 作 Agent 运行时  
- `browser-content` WebView 加入 `default` capability  
- 一期 follow-attach、多 session  
- 地址栏 `file:`  
- Agent 代填密码（审批不够）  
- 把 `browser.db` 纳入 RowSync / 默认备份（一期豁免）  
- 钉 `DEFAULT_DOCK_PINNED` / 改 StatusBar / 碰 flashcards
