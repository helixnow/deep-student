# deep-student 性能体检历史初评（移动端优先，兼顾桌面）

> 归档说明：以下保留早期静态检查的输入与推断，不代表当前代码状态。后续实施与真实验收请查看 [实施记录](./IMPLEMENTATION-2026-09-27.md)、[第三轮复核](./ROUND3-REVIEW-2026-09-27.md) 和 [P2 修复验收](./P2-IMPLEMENTATION-2026-09-27.md)。

- 基线：`main @ ccd614fb`（历史检查时基线），v0.9.62；产物数据来自你本地 `dist/`（1202 个资源，JS 35.8 MB raw）与 v0.9.61 发布包（arm64 APK 134 MB / Win 57 MB / mac 80 MB / AppImage 147 MB）。
- 方法：纯静态分析（沙箱无 Rust 工具链、无法跑 `vite build`），每条结论标注 **[已验证]**（读到源码/产物证据）或 **[推断]**（需真机/构建数据确认）。
- 已在 `docs/dev/optimization0824` 落地的项（桌面 CI LTO 关/sccache、Android `mobile-slim`、FlowToken 懒加载、pdfjs cmaps 裁剪等）**不再重复提**。

---

## 0. 一页结论（按"移动端收益 ÷ 工作量"排序）

| # | 问题 | 影响面 | 修法 | 工作量 |
|---|------|--------|------|--------|
| 1 | **111 个同步 `#[tauri::command]` 在主线程执行**（`vfs/todo_handlers.rs` 50、`data_space.rs` 13、`data_governance/commands.rs` 9、`vfs/pomodoro_handlers.rs` 7、`commands.rs` 6、`secure_store.rs` 6…，其中约 85 个做 DB/IO），移动端主线程 = UI 线程 | Android/iOS 每次打开 Todo/番茄钟都阻塞渲染与输入 | 属性改为 `#[tauri::command(async)]`（Tauri 自动走 `spawn_blocking`，函数签名/测试不动） | ~1h |
| 2 | **首屏预载 6.8 MB JS + 0.6 MB 阻塞 CSS**，其中 milkdown 1.1 MB、recharts 0.43 MB、katex 0.59 MB、xyflow/d3 0.35 MB、mindmapStore 0.31 MB、内置工具提示词 0.43 MB 与聊天首页无关 | 冷启动 JS 解析/编译时间（中端安卓约 1.5–4 s CPU）、内存 | 见 §1：`vite.demo.config` 已验证安全的 `hoistTransitiveImports:false` + `resolveDependencies` 搬到主配置；4 条静态引用链改懒加载 | 1h（配置）+ 2–4h（切边） |
| 3 | **≈171 个 async 命令在 tokio worker 上直接跑同步 SQLite**（无 `spawn_blocking`），含热路径 `chat_v2_load_session` | 手机 4 核 worker 极易被占满 → 全部 invoke 排队（正是 `anr_watchdog` 监控的饥饿） | 热路径先包 `spawn_blocking`：load_session / list_sessions / search / vfs 列表 | 2–4h |
| 4 | **`index-CZ0eo-bV.js` 5.37 MB = highlight.js 全语言注册表**，来自 `@nvq/flowtoken → react-syntax-highlighter`，首条流式回复到达时下载+解析 | 恰好在用户盯着 token 出现时卡一下；移动端最明显 | Vite `resolve.alias` 把 `react-syntax-highlighter`/`@tabler/icons-react` 指向 stub（app 从不渲染 flowtoken 的 DefaultCode） | ~30min |
| 5 | **bundle 门禁已失效**：`check-bundle-size.mjs` 入口正则找 `index-*.js`，实际入口已改名 `main-*.js`；CI 仍 `--warn-only` | 首屏回归无人察觉（milkdown/recharts 漏进首屏就是例子） | 修正则、加"首屏 modulepreload 总量/个数"预算、转阻塞 | ~30min |
| 6 | **SQLite PRAGMA 缺 `cache_size`/`temp_store`/`mmap_size`/`wal_autocheckpoint`**（主库、VFS 库均为默认 2 MB cache） | 手机闪存随机读；大会话/索引查询 | `cache_size=-16000; temp_store=MEMORY; mmap_size=67108864`（移动端可减半）| ~30min |
| 7 | **移动端材质档位 = `full`**：133 处 `backdrop-filter` 全开；`.is-mobile` 类有设置但 0 条 CSS 引用 | Android WebView 滚动聊天列表时 GPU 合成开销大、掉帧 | `materialTier.ts` 自动档：`pointer:coarse && (Android \|\| deviceMemory≤4 \|\| cores≤4)` → `reduced` | ~1h |
| 8 | **启动 setup 闭包 ≈1680 行串行**（migrations → chat_v2 → llm_usage → browser DB → `build_app_state` 十余个服务），无 `join!` | 冷启动黑屏时长（前端 `get_startup_recovery_status` 最多等 135 s） | 打点 → 无依赖项并行 → 非关键项（Lance/ExamSheet/Crypto 探测）延后到门打开之后 | 1–2 天 |
| 9 | 设置读取无批量/缓存：启动即 5 次 `get_setting` IPC，全代码 113 处 `getSetting` | 每次 IPC 在 Android 走 JS→Kotlin→JNI→Rust | `get_settings_batch(keys)` 或启动一次性拉全表进前端缓存 | ~2h |
| 10 | Android `.so` 116 MB：Cargo.lock 中 `reqwest`×3（0.11/0.12/0.13）、`rustls`×3、`hyper`×2、`image`×2、`zip`×3、`openssl 0.10` 仍在图中 | 包体、编译时间 | 统一 reqwest/rustls 版本；确认 openssl 未进 mobile 构建；发布 tag 构建开 thin LTO | 半天–1 天 |

---

## 1. 前端首屏（移动端影响最大）

### 1.1 首屏到底装了什么 [已验证：dist/index.html + 静态导入图]

`dist/index.html` 预载 **35 个 JS（6.76 MB raw）+ 11 个阻塞 CSS（600 KB raw）**。用 `src/main.tsx` 出发的静态导入 BFS（675 个源文件，7.0 MB 源码）追到 4 条把重库拖进首屏的链：

| 首屏里的重块 | 静态链（App.tsx 起） | 修法 |
|---|---|---|
| `vendor-milkdown` 1.03 MB + 82 KB CSS | `AgentBridge → stageManager → drivers/index.ts → noteDriver.ts → @milkdown/kit/core` + `components/crepe/plugins/agentHighlight → @milkdown/utils` | `registerAllDrivers` 里对 noteDriver 用 `import()`（同目录 `workspaceRegistry.ts` 第 14 行已经是这种写法："激活路径按需 import()"），或把 `editorViewCtx` 的取用挪到 driver 内部懒加载 |
| `vendor-recharts` 0.43 MB、`react-markdown`+remark/rehype、`zod`、lazyKatex 触发器 | `sessionManager → AdapterManager → TauriAdapter → skills/artifactSkeleton.ts → import '@/features/generative-ui/blocks'`（副作用注册） → `ChartBlock(recharts)` / `ResearchReportBlock → GenerativeMarkdownBody` / `FlashcardPreviewBlock(zod schema)` | 把 blocks 注册拆成"schema/元数据（同步）"与"组件（`React.lazy`）"两层；`artifactSkeleton` 只需要 registry 元数据 |
| `mindmapStore` 0.31 MB（源码 153 KB）+ registries/themes | `AgentBridge → … → drivers/mindmapDriver.ts → mindmap/store/mindmapStore` | 同上，driver 懒注册 |
| `searchEngineAvailability` 0.43 MB | `DialogControlContext → mcp/builtinMcpServer.ts → chat/skills/builtin-tools/*`（49 个文件、563 KB 的工具提示词文本） | `DialogControlContext` 只用 `ALL_SEARCH_ENGINE_IDS`，把它挪到独立常量模块即可 |
| `vendor-xyflow` 0.13 MB + 16 KB CSS、`vendor-d3` 0.22 MB | **静态图里不可达**——是 Rollup 传递依赖提升 + modulepreload 连带 | 正是 `vite.demo.config.ts` 用 `hoistTransitiveImports:false` + `modulePreload.resolveDependencies`（js 上下文返回 `[]`，html 上下文过滤重库）解决的问题，demo 已验证无白屏；**主配置未启用** |
| `sessionManager` 0.87 MB | `TauriAdapter.ts` 5818 行 + 全部 skills 静态注册 | 中期：TauriAdapter 按能力域拆分；短期先切断上面 artifactSkeleton 那条边 |
| `App` 1.54 MB | `App.tsx` 3152 行、34 个 `useEffect`，静态引 `TodoShellSidebar`（依赖树 50 文件/710 KB，含 dnd-kit ×4 包）、`GlobalPomodoroWidget`（28 文件/518 KB）、`SettingsShellSidebar`、command-palette 全部内建命令 | 三个 ShellSidebar 改 `React.lazy`（各只在对应视图渲染一次）；builtinCommands 延后到空闲时注册 |

预期：仅做"配置搬运"（§1.1 xyflow 行）就能砍掉 2–3 MB 预载；再切 4 条边可再减 1.5–2 MB，把首屏 JS 压到 ~2.5 MB raw 以内。

### 1.2 `i18n-*.css` 394 KB 的来源 [已验证]

`i18n.ts` 不导入任何 CSS。读了你本地 `dist/assets/i18n-kWSVO1yJ.css` 确认：文件开头就是 `transitions-dev.css` 的动效令牌（`--resize-dur/--digit-dur/--page-slide-dur…`），随后是 `.t-resize`、1530 处 `--tw-*` 变量、overlayscrollbars ×16、`.prose`/`.markdown-body`——即 **`src/styles/tailwind.css`（内部 `@import './ui-motion.css'` → transitions-dev）+ App.tsx 第 59–83 行那组全局 CSS**。原因是 `vite.config.ts` 的 `rollupOptions.input` 有 5 个 HTML 入口（main/demo/hero/preview-charts/button-audit），其中 4 个入口脚本各自 `import` 同一组全局 CSS；Rollup 把多入口共享模块合并到一个共享 chunk，命名恰好落到最先遇到的共享模块 `i18n`（`button-audit/main.tsx` 与 `dev/previewCharts.tsx` 都 `import '../i18n'`）。
- 这意味着 **完整 Tailwind + app.css(45 KB) + theme-colors(46 KB) 等 = 一个 394 KB 阻塞样式表**，加上 milkdown/katex/xyflow 的 CSS 共 600 KB 阻塞渲染。
- 附带问题：`demo`（60 KB JS）、`button-audit`（77 KB JS + 18 KB CSS）、`hero.html`（45 KB）、`preview-charts` 都**进了 Tauri 生产安装包**。
- 修法：这些入口用环境变量门控（如 `VITE_MPA_EXTRAS=1` 时才加入 `input`），Tauri 构建默认只有 `main`。CSS 归属会随之清晰，也便于后续按视图拆 CSS。

### 1.3 highlight.js 5.37 MB [已验证]

- `@nvq/flowtoken@2.0.6` 是 CJS、无 `sideEffects`/`exports`；其 `DefaultCode` `require('react-syntax-highlighter')`（拉全量 hljs 注册表）与 `@tabler/icons-react`。
- app 侧 flowtoken 只用于 `paragraph/heading/list/blockquote`（`StreamingBlockRenderer.FLOWTOKEN_SUPPORTED_BLOCK_TYPES`），代码块走自家 `CodeBlock`（**不做语法高亮**），因此 hljs 在本项目里**零使用**却要在首条流式回复时下载+解析 5.37 MB。
- 修法（任选）：① `resolve.alias: { 'react-syntax-highlighter': stub, '@tabler/icons-react': stub }`；② 传 `customComponents.code`；③ fork flowtoken（dist 仅 AnimatedMarkdown 13 KB + SplitText 7.6 KB）。
- 另建议：`materialTier !== 'full'` 或 `pointer:coarse` 时直接不走 flowtoken（`prefersReducedMotion` 只关动画不省加载；`sep="diff"` 每个词一个 span + 0.35 s fadeIn，在手机上是纯开销）。

### 1.4 门禁失效 [已验证]

`scripts/check-bundle-size.mjs` 第 67 行正则 `assets/(index-[\w-]+\.js)`，而 `dist/index.html` 实际入口为 `./assets/main-Ch5uzIZo.js` → entry 预算恒报 "no script"；`ci.yml` 第 145 行仍 `--warn-only`（原计划 2026-09-07 转阻塞）。建议：正则改 `(main|index)-`；新增两条预算——`index.html` 中 modulepreload **个数 ≤ 20、总字节 ≤ 3 MB**；转阻塞。

### 1.5 其他前端项

- **framer-motion**：52 个文件导入、179 处 `AnimatePresence`、0 处 `LazyMotion`；11 个首屏文件直接依赖（DsDialog、ModernSidebar、GlobalPomodoroWidget…）。0824 遗留项，建议首屏组件改 `m` + `LazyMotion features={domAnimation}`。[已验证]
- **启动 IPC**：`useAppInitialization` 5 次串行/并行 `get_setting`，每次一条 SQLite 查询 + 一次 Android JNI 往返；全代码 113 处 `getSetting`，无批量接口、无前端缓存。[已验证]
- **Sentry**：`tracesSampleRate` 0.1，无 Replay，OK。[已验证]
- **本地存储**：253 处同步 `localStorage`、11 个 zustand `persist` store（每次变更 JSON 序列化）。Android WebView 的 localStorage 是同步跨进程调用（1–10 ms），需确认没有在 scroll/resize/keystroke 热路径写。[推断，需 Performance trace]
- **监听器**：41 处 window `resize`、48 处 `scroll` 监听，需抽查是否节流。[推断]
- **无 Web Worker**：markdown 解析、`parseChainOfThought`、25 处深拷贝全在主线程。中期项。[已验证]

---

## 2. 移动端运行时渲染

- **材质档位** [已验证]：`materialTier.ts` 自动降级只覆盖 reduced-motion/透明度、Linux 桌面、桌面软件渲染；Android/iOS 得到 `full`。CSS 中 `backdrop-filter` 133 处（app.css 26、theme-colors 17、workbench.css 15…）、`filter: blur` 50 处、`transition: all` 45 处、`will-change` 59 处。`initPlatformClasses` 设置的 `.is-mobile` 类没有任何 CSS 规则引用（只有 `is-android-webview` 输入框修正与 safe-area）。建议先对 app-shell 顶栏/侧栏/对话框三类最大的模糊面在 `@media (pointer:coarse)` 下改实色。
- **流式渲染链路** [已验证，设计健康]：后端每个 delta 直接 `Window::emit`（内存累积，不逐 chunk 落库）；前端 `chunkBuffer` 每会话 32 ms/4096 字符合并；`StreamingMarkdownRenderer` 按 markdown 块 memo，只重渲染活跃块；`MessageList` 用 `useVirtualizer`（overscan 5）。可调项：`pointer:coarse` 或非 `full` 档时把 `CHUNK_BUFFER_WINDOW_MS` 提到 64–80 ms（活跃块每 tick 都要过 react-markdown + remark-gfm/math + rehype-raw/sanitize 全管线，长段落时是 O(块长度)/tick）。
- **移动 UI 统一专项** `docs/dev/mobile-uiux-unify/PROGRESS.md`：90 轮全是可达性/尺寸契约，**"真机验证仍留白"**，没有性能维度——上面这些项没有被它覆盖。[已验证]

---

## 3. 后端（Rust）

### 3.1 主线程上的同步命令 [已验证 + 官方文档]

Tauri 2 文档："Commands without the async keyword are executed on the main thread unless defined with `#[tauri::command(async)]`"。仓库 926 个命令中 **111 个是同步 `fn`，0 个带 `(async)`**，其中带 SQLite 查询的：`todo_*`（`vfs/todo_handlers.rs`，`todo_list_items_with_stats`/`todo_list_today`/`todo_counts_snapshot`…）、`pomodoro_*`（`pomodoro_list_range`/`pomodoro_streak`/`pomodoro_daily_stats`…）、`data_governance_get_audit_logs`/`run_health_check`、`secure_*`（系统 keychain/Keystore，安卓上可达几十 ms）、`check_package_manager`（spawn 子进程）。桌面上主线程 = 事件循环线程，移动上 = UI 线程；`TodoShellSidebar` 又在首屏。**这是本报告性价比最高的一项。**

### 3.2 tokio worker 上的同步 SQLite [已验证（脚本估算）]

≈818 个 async 命令中 ≈171 个在函数体内直接 `get_conn`/`query_row`/`prepare` 而没有 `spawn_blocking`：`vfs/handlers.rs` 35、`review_plan_service.rs` 17、`commands.rs` 12、`data_governance/commands_sync.rs` 10、`chat_v2/handlers/{group,search,goal,variant,block_actions}` 各 4–9、`chat_v2/handlers/load_session.rs`（`load_session_from_db` 同步执行）。tauri 的 tokio runtime worker 数 = CPU 核数，手机上常只有 4 个可用大核；几条慢查询并发就会让所有 invoke 排队——`anr_watchdog.rs` 文档自己写明它监控的就是这种"tokio 异步运行时饥饿"。优先包 `spawn_blocking` 的顺序：`chat_v2_load_session` → `chat_v2_list_sessions`/搜索 → `vfs` 列表/索引 → review_plan。

### 3.3 SQLite 配置 [已验证]

`database/manager.rs` 与 `vfs/database.rs`：r2d2 max 15 / min_idle 2，PRAGMA `journal_mode=WAL`、`synchronous=NORMAL`、`foreign_keys`、`busy_timeout 3000/5000`。缺：`cache_size`（默认 −2000 = 2 MB）、`temp_store=MEMORY`（排序/临时表落盘）、`mmap_size`、`wal_autocheckpoint`（长流式会话写入多，默认 1000 页）。另外主库+VFS+chat_v2+browser+llm_usage+workspace 多个库各 15 连接，移动端可把 max 降到 4–6 以省内存。

### 3.4 启动路径 [已验证]

`lib.rs` setup 闭包（~688–2370 行）串行：data_governance 迁移 → chat_v2 init → llm_usage DB → browser DB → `build_app_state`（FileManager、Database、DatabaseManager、VfsDatabase、qbank `recover_interrupted_tasks`、VfsLanceStore、LLMManager、ExamSheetService、CryptoService、NotesManager…），全程无 `join!`/`try_join`。已经异步化的：MCP init、Lance optimize、导入恢复、备份。前端 `StartupPreflight` 以 10 s 为单位轮询 `get_startup_recovery_status` 最多 135 s，后端 `startup_gate` 120+15 s。建议第一步只加 `Instant` 打点日志，用一次安卓冷启动的 logcat 就能拿到每段耗时，再决定并行/延后哪些。

### 3.5 `block_on` / `thread::sleep` 复核 [已验证]

- `block_on`：`notes_manager.rs` ×6（Lance 笔记路径，VFS 存在时不走）、`cmd/anki_connect`、`enhanced_anki_service`、`memory/{reranker,evolution}`、`lance_vector_store`（`block_in_place`）、`background_tasks`、`lib.rs` shutdown。需逐个确认只在 `spawn_blocking` 线程或非 tokio 线程上触达，否则是死锁/饥饿隐患。
- `thread::sleep`：`ptc_runtime.rs` 的 50/200 ms 在 `#[cfg(test)]` 里（无问题）；`chat_v2/workspace/database.rs` 25 ms 是 `enter_maintenance_mode` 同步函数里的等待循环（最长 10 s），需确认调用方在阻塞线程。

### 3.6 二进制体积与编译档位 [已验证]

- Cargo.lock 1295 个 crate；重复版本：`reqwest` 0.11/0.12/0.13、`rustls` 0.21/0.22/0.23、`hyper` 0.14/1.8、`image` 0.24/0.25、`zip` 0.6/2.4/4.6、`windows-sys` ×6、`hashbrown` ×5、`rand` ×4、`fancy-regex` ×4；`openssl 0.10` 仍在依赖图（需确认 mobile-slim 是否把它带进 `.so`）。仅统一 reqwest/rustls/hyper 就能省下可观的 `.so` 体积和编译时间。
- `Cargo.toml [profile.release]` 写的是 opt-level s / thin LTO / cgu 1，但**四个平台的 CI 全部用环境变量覆盖为 LTO=false / cgu=16**（Android 还 opt-level z）。这是 0824 为编译时间做的取舍，但意味着**发布给用户的二进制比仓库声明的更大、更慢**。建议区分：PR/CI 用快档，`v*` tag 发布用 thin LTO（Android 也开），在 `reusable-build-*.yml` 里按 `github.ref_type == 'tag'` 切换。

---

## 4. 桌面端补充

- 首屏 7 MB 预载同样存在，只是 CPU 强所以感知弱；Linux 已自动 `reduced` 材质。
- `GlobalDebugPanel` 0.61 MB 为懒加载且受 `debugPanelRequested` 门控，不在首屏，OK。
- Windows/macOS 发布二进制受 §3.6 CI 档位影响最大（桌面 `default` features 含 lance/datafusion/arrow、aws-sdk-s3、mcp、tiktoken）。

---

## 5. 建议的验证动作（我在沙箱里做不了的）

1. `npm run build && node scripts/check-bundle-size.mjs`（先修正则）——拿到 gzip 口径的首屏数字。
2. 安卓：`adb shell am start -W`（冷启动 TotalTime）+ `chrome://inspect` 对 WebView 录一段"启动→首条回复流式完成"的 Performance trace，看 Script Evaluation 与 Long Tasks。
3. `RUST_LOG=info` 冷启动一次，看 setup 各阶段时间戳（若尚无打点，先加 §3.4 的 `Instant` 日志）。
4. 把 `#[tauri::command(async)]` 批量加上后，在手机上对比打开 Todo/番茄钟页的输入响应。
