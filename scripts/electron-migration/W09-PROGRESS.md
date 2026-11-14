# W09 进度（第二轮）

| # | 任务 | 状态 |
|---|------|------|
| 1 | 删除 NoTagTreeShadPanel + 两个 stream 包装，更新门禁基线 | 完成 |
| 2 | InlineDocumentViewer 新窗口打开 → 应用内放大浮层（portal，Esc 先退出放大） | 完成 |
| 3 | 翻译技能补 `translation_result_read` schema + Rust/host 执行器一致性测试 | 完成 |
| 4 | `test_web_search_connectivity` 加入 ACL（cherry-pick W05 3b8b391 + toml + 测试翻转） | 完成 |
| 5a | 事件 emit 覆盖门禁 `gate-checks/event-emit.mjs`（21 项基线：13 unemitted + 8 dynamic） | 完成 |
| 5b | Agent 工具执行器覆盖 `host/e2e/coverage/agent-tool-coverage.test.ts`（336 工具 / 28 执行器 / 216 缺口入基线） | 完成 |
| 6 | 账本指标拆分 B-test / B-doc（旧 B 保留为兼容列） | 完成 |
| 7 | 删除过期 `migration/ledger.json`，ACCEPTANCE/README 改指向实时账本 | 完成 |
| 8 | 修 `src/ui-plugins/**` 3 个 no-unsafe-function-type lint 错误 | 完成 |
| 9 | package.json scripts：migration:frontend-invoke / event-emit / tool-coverage | 完成 |
| 10 | 全量验证 | 完成 |

## 备注

- 任务 1：路由/懒加载/glob/注册表均无挂载；`TauriAPI` 两个动态包装只被该面板使用。
  残留引用（不在负责路径或为历史快照，未改）：`tests/vitest/scrollbarVisualContract.test.ts`
  豁免集合中的路径（无害，可由 owner 清理）、`src/components/style-lab/scan-data.json`
  （带精确计数断言的扫描快照，不单独重生成）。`graphApi.ts` 现无任何 importer。
- 任务 4：ACL 读者为 `host/kernel/acl.ts`（Electron，读 src-tauri/capabilities + permissions/*.toml）与
  `src-tauri/build.rs`（要求 toml == generate_handler! 全等）。交接：Rust `src-tauri/src/lib.rs`
  generate_handler! 需补 `test_web_search_connectivity`，否则 cargo build 的 ACL 校验报 stale。
  集成时 search-commands.test.ts 与 W05 同区域会有一次平凡冲突，取 W09 侧。
- 任务 6：B-test = A ∧ 对应测试全过；对应测试 = 同 lane 且 Rust 源文件与命令定义文件相同的真实 TESTMAP 行，
  该文件无测试时退到整个 lane（严格，lane 内任一失败即不成立）。用 wp280 fulltest-latest.original.json：
  命令 1058，A 1057（99.9%），B-test 550（52%：文件映射 542/635，lane 回退 8/423），B-doc 0，B（兼容）0。
  看板 lane 行/stdout 正则仍匹配（新列追加在行尾，stdout 追加在 C 之后）。
- 任务 7：选择删除而非重生成（重生成的快照同样会过期，且曾多次造成 lane-gate 工作树 dirty 前置失败）。
  无代码读取该路径。改了 mcp/browser ACCEPTANCE 第 4 行、docs/dev/electron-migration/README.md 两处（目录表与 §7
  "唯一来源"）、migration/LEDGER.md。历史审计/协调记录中提到该文件的叙述保持原样。
- 任务 8：`Function` 改为显式签名 `(...args: unknown[]) => unknown`。消费测试 6 文件 39/40 过；
  `legacy-boot-evidence.test.ts` 1 例改动前即失败（`git show 7f915ae5f…` 该提交不在本仓库对象库中），与本改动无关，交接。
- 任务 10：host vitest（scripts/electron-migration、host/e2e/coverage、host/plugins/browser、host/kernel）86 文件 674 例全过；
  host tsc 0；前端 tsc 0（临时生成 src/version.ts 后删除）；前端相关 68 文件 428/430，2 个失败均为环境：
  legacy.evidence 依赖本仓库缺失的历史提交树，workbenchPrewarm 需 src/version.ts（生成后 2/2 过）。改动文件 eslint 0 error。

# W09 进度（第三轮）

| # | 任务 | 状态 |
|---|------|------|
| 1 | 快捷助手初始化：拆开动态 import 与调用，构建产物级测试 | 完成 |
| 2 | i18n 社区插件命名空间不回落到官方文案 | 完成 |
| 3 | 停止生成后按存档对齐内容 | 完成 |
| 4 | `skill_injection_audit` 处理器（完成）；启动快捷键冲突告警（查清，修复需改 W18 路径，交接） | 部分完成 |
| 5 | 构建脚本固化内存上限（node --max-old-space-size=8192 调 vite.js，跨平台） | 完成 |
| 6 | FE-A4 前端边界门禁 + 可移植性扫描接线 | 完成 |
| 7 | `lib.rs` generate_handler! 补 `test_web_search_connectivity` | 完成 |
| 8 | 收尾验证 | 完成 |

## 备注（第三轮）

- 任务 1：根因是 Vite 构建期 `__vitePreload` 对 `const { enabled } = await import('./config').then(...)` 的解构改写，
  只取 `enabled`，链式 `.then` 拿到的对象没有 `getQuickAssistantConfig`（W12 dist 产物中可见）。
  测试 `src/quick-assistant/__tests__/window.build.test.ts` 以 app 模式 `vite build` 构建 window.ts（Tauri 模块打桩），
  在独立 node 进程执行产物，断言 get_setting / register / quick_assistant_apply_enabled 均被调用；修复前报
  `module.getQuickAssistantConfig is not a function`。src/ 中无同类写法。
- 任务 2：fallbackNS 是 Translator 共享 options 上的全局项。`isolateCommunityNamespaces()` 包装 translator.resolve：
  一次查找的全部目标命名空间都不在 ALL_NS 时临时关闭 fallbackNS，官方查找路径不变。复现：`acme.notes:title` 修复前得
  “系统设置”。证据：新测试 2 例；check-i18n 输出修复前后逐字相同；i18n/golden 相关 71 文件 457/458，唯一失败
  sidebar-evidence 读取的历史提交缺文件（环境问题，与 W09 第二轮报告中两例同类）。
- 任务 3：新增 `adapters/tauri/cancelAlignment.ts`，stream_cancelled 被接受后读取该消息存档
  （`chat_v2_load_messages_page` 取目标消息附近 3 条，找不到时退到 `chat_v2_load_session`），补上界面缺失的块、
  补全被截断的内容（只增不删；消息若又开始流式、会话已切换或为多变体消息则跳过）。只改适配器事件层，未改渲染组件。
  测试：对齐模块 5 例、事件接线 2 例（去掉接线即红）；adapters/core 相关 44 文件 391 例全过。
- 任务 4：根因是 audit 常为流的首个带序号事件（phase=end），桥的首包规则只接受 start，其余进缓冲等 gap 超时；且无处理器。
  `eventBridge.ts` 把它列为消息级事件：首包可作序号基线、不进块分发，记录最近一次审计（`getLastSkillInjectionAudit`），
  有 dropped/missing 时 warn。Rust 侧前端从未处理过此事件（git 历史无），其意图仅为诊断。测试 2 例，middleware 31 例全过。
  快捷键 4 条冲突（均因 chat/notes 命令都对 workbench 视图可见）：mod+n chat.new-session/notes.new；
  mod+shift+c chat.copy-last-response/notes.insert-codeblock；mod+\ chat.toggle-sidebar/notes.toggle-sidebar；
  mod+p global.quick-search/notes.quick-switch。定义都在 `src/command-palette/modules/`（W18），交接。
- 任务 5：`build`、`build:demo` 改为 `node --max-old-space-size=8192 node_modules/vite/bin/vite.js build …`，
  不依赖 POSIX 环境变量前缀，也不新增 cross-env 依赖。测试 `scripts/electron-migration/package-scripts.test.ts`。
- 任务 7：用 build.rs 的同一解析器（`build_support/app_command_parser.rs` + 逐字拷贝的 extract_allowed_commands）
  在 /tmp 独立小工程离线编译运行：修改前 stale=["test_web_search_connectivity"]，修改后 1055/1055 全等。
  未对整个 Tauri crate 跑 cargo check（体量过大），签名与同文件 test_search_engine 相同。
- 任务 6：`gate-checks/ui-boundaries.mjs`（方案写的 `scripts/plugins/check-ui-boundaries.mjs` 不在负责路径，放在 gate-checks
  下）。三条规则：plugin-tauri-import（src/ui-plugins、src/plugins，现状 0，全量生效）、ua-sniffing（平台模块
  src/platform/**、src/utils/platform.ts 之外；38 处/26 文件）、bare-custom-event（src/events/** 之外；406 处/201 文件）。
  基线 227 条按 规则+文件 计数；`--write-baseline` 计数上升时拒绝（需 --allow-increase）。注入违规退出 1 并给出 文件:行。
  gate-checks.mjs 接入 ui-boundaries（src/ 变动）与 W14 可移植性扫描（`--check`、`--profile host/profiles/mobile.json`，
  host/plugins、host/profiles 或扫描器目录变动时）；扫描器/profile 路径由 DSTU_PORTABILITY_SCANNER /
  DSTU_PORTABILITY_PROFILE 配置，本工作树尚无 scripts/portability/ 时自动跳过。W14 工作树中两种调用均退出 0。
  方案 FE-A4 另列的 import 边界（插件只能 import 本目录/SDK/shared/lib/他人 api.ts、跨 feature 547 条边）本轮未做。
- 任务 8：host tsc 0；前端 tsc 0（临时 src/version.ts 已删）；`npm run build`（DEEP_STUDENT_BUILD_NUMBER=20000）exit 0，
  产物 `window-*.js` 为先取整模块再调用 `getQuickAssistantConfig()`；本轮改动的 src 文件 eslint 0 error（1 warning 为
  window.ts:111 基线快照原有的裸 addEventListener）；scripts/electron-migration 22 文件 213 例、host/e2e/coverage 1 例全过；
  frontend-invoke / event-emit / ui-boundaries `--check` 均退出 0；本轮前端测试 26 文件 165 例全过。
  event-emit 基线删去 2 条已不再出现的 unemitted-event（backup-jobs-resumable、data-governance-migration-status，host 已发射）。

## 第四轮（wave 2）

| # | 任务 | 状态 | 提交 |
|---|------|------|------|
| 1 | 运行时 import 环门禁（plugin api.ts 值导入闭包，基线 + 只拦新增，含 TDZ 反例） | 完成 | e17a42e8 |
| 1b | rust-fixes 登记门禁（schema、标记一一对应、测试标题、选择器宽度；deliberate 必填 userVisible/dataCompat；`--review` 待审报表） | 完成 | 459706bc a305892a 482bc228 |
| 2 | FE-A4 import 边界（plugin-import-boundary 90、cross-feature-import 536 边） | 完成 | 50141b0a |
| 3 | 可移植性扫描与移动端 profile 接入 gate-runner（base 对比包装，只拦新增） | 完成 | ab7c9763 |
| 4 | sql-outside-repository 覆盖 host/platform/storage-mobile/ | 完成 | 5d3c7a31 |
| 5 | 前端缺口：translation_result_read 已声明并登记；skill_injection_audit、InlineDocumentViewer 已在第三轮完成并补登记；knowledge_extract 不加（理由见报告） | 完成 | bf842261 87789763 ec939785 2ba88724 |
| 6 | token 预算：+240 精简到 +193，上限按 Rust 快照 76,600 + 新工具 193 = 76,800 | 完成 | bf842261 |
| 7 | vitest fs.allow：符号链接 node_modules 只追加其真实目录 | 完成 | 6984442d |

RF 登记（全部 proposed）：RF-W09-translation-result-read-undeclared（rust-bug）、RF-W09-skill-injection-audit-unhandled
（rust-bug）、RF-W09-inline-viewer-in-app-expand（deliberate）。第二、三轮的原始实现提交（485f51df、f861980b、b1c58de0）
提交信息里没有登记 id，`--review` 只能列出登记提交；撤回时需连同 notes 字段里写的原始提交一起 revert。
quick-assistant 构建修复（3592a356）是 Vite 构建问题，不对应 Rust 行为，未登记。

## 第五轮

| # | 任务 | 状态 | 提交 |
|---|------|------|------|
| 0 | 合入 assault/integration `05dc0aa2`（快进） | 完成 | — |
| 1 | boundaries：`*.spec.ts`、`host/e2e/**/support/` 认定为测试代码 | 完成 | 96aa6201 |
| 2 | 插件 manifest v1 契约 `contracts/plugin-manifest/v1.schema.json` + `plugin-manifest` 门禁（基线 6） | 完成 | a4564e8f |
| 3 | 删除死代码 `src/utils/graphApi.ts`（frontend-invoke 1400→1396 处，基线不变） | 完成 | 4e247bbc |
| 4 | RF 登记 `commits` 字段（门禁 git cat-file 校验、`--review` 列出）；三条 W09 登记迁移 | 完成 | f423c3a0 1f1bcb01 d4509857 e2415ff9 |
| 5 | 可选优化 | 未做 | — |

- 任务 1：集成树上 W12 已在 `4ddf4cb2` 把 Playwright 套件挪进 `__tests__/`，boundaries 仍为 13 条（规则无增减）。
  在挪动前的树（`4ddf4cb2^`）上，host/e2e 由 46 条降到 2 条：test-double −34、sql-outside-repository −5、
  todo-marker −4、empty-catch −1；剩下 2 条 native-import 与现有测试文件同样照报（W12 后来用 boundary-allow 说明）。
- 任务 2：semver 不是直接依赖（node_modules 里只有间接的 6.3.1），版本范围定为 npm 语法的严格子集，门禁自带求值，
  测试在能解析到 semver 时逐条对照 npm 语义。

## 第六轮

| # | 任务 | 状态 | 提交 |
|---|------|------|------|
| 0 | 合入 assault/integration `edf15754` | 完成 | — |
| 1 | rust-fixes 门禁接受同文件 `const ID = 'RF-…'`（可带 `as const`）+ `` it(`${ID}…`) ``；其余动态写法仍报错；自测 12 条 | 完成 | cf1c2f80 |
| 2 | #24 组件恢复界面标签页语义（tablist/tab/aria-selected/面板归属/方向键） | 完成 | 7581de3e |
| 3 | 快捷助手生产构建修复 3592a356 登记为 rust-bug（commits 指向原提交） | 完成 | f5e9c020 |
| 4 | #22 工作台卡片中心随 Host 卡片插件降级显示 HostUnavailablePanel（deliberate） | 完成 | ce033637 |
| 5 | #23 新建笔记标题焦点竞态（W18 分支未改 NotesEditorHeader / NotesCrepeEditor） | 完成 | a9d23292 |
| 6 | 前几轮遗留 | 只有交接，无代码 | — |

- 任务 2：先在共享 `shad/Tabs.tsx` 上补语义，相关 53 个测试文件里有 20 个、52 条失败——它们按
  `role="button"` 找数据治理、样式实验室等页面的标签；W12 冒烟 `11-core-recovery.spec.ts:60` 也按 button 点“下一步”。
  改共享组件会牵动 17 个使用方和其他 lane 的选择器，本轮按 #24 的范围只改 ComponentRecoveryShell（做法同
  SettingsCategoryHeader），`Tabs.tsx` 未动。
- 任务 3：第四轮备注里写“与 Rust 行为无关、未登记”，不对：Tauri 版用同一份前端代码和同一个 Vite（^6.0.3），
  main.tsx 同样启动时调用，生产包同样坏。
- 任务 5：根因未能在 jsdom 里定位到具体的抢焦点调用（真实 Crepe 在 jsdom 中无布局与选区语义）；修复按 W12 观察到的时序：
  正文编辑器就绪后才请求聚焦标题。真实浏览器的最终焦点位置由 W12 冒烟的 `new-note-focus-after-1s` 注解复核。

## 第七轮

| # | 任务 | 状态 | 提交 |
|---|------|------|------|
| 0 | 合入 assault/integration `dc24189c`，中途 INT 前进后再合 `a72135ce` | 完成 | 021fb315 |
| 1 | vitest `deps.optimizer.web` 预打包 `@phosphor-icons/react`，cacheDir 放本工作区 `.cache/vite` | 完成 | 2b47604a |
| 2 | §8 D5 硬编码文案棘轮门禁 `gate-checks/hardcoded-copy.mjs`（基线 1743 条 / 94 文件） | 完成 | 47dbe395 |
| 3 | skills-mcp 翻译技能工具数 2→3、`listen:tauri://close-requested` 消失 | 查清，交 W16 | — |
| 4 | ModernSidebar 设置菜单并入 app.menu | 不在本路径，交 W18 | — |
| 4 | 删除 `src/dstu/contextMenu.ts` 及 index 再导出 | 完成 | a17e3704 |
| 5 | 共享 `shad/Tabs.tsx` 标签语义方案 | 只出方案 | — |

- 任务 1：单独 `import('@phosphor-icons/react')` 冷加载 2013/1734/2053 ms → 93/91/100 ms；shell.golden + settingsCategories
  collect 2.33/2.12/2.13 s → 1.94/1.80/1.88 s。没有改超时。默认缓存 `node_modules/.vite/vitest/…` 经符号链接被所有 worktree
  共用，所以改为本工作区的 cacheDir。全量跑完之后，把失败的 120 个文件分别开、关优化器各重跑一次，两次结果完全相同（99 个文件、45 条用例），
  说明预打包没有副作用；失败来自 INT（`../lazy-contributions` 缺失，已由 `a72135ce` 修好）、未生成 `src/version.ts`，以及既有问题。
- 任务 2 规则（文件头有完整说明，自测 10 条）：只扫 `src/` 生产代码；计 JSX 文本、JSX 表达式字面量、文案类属性
  （title/placeholder/aria-label 等 23 个）、通知调用（`showGlobalNotification`/`toast.*`/`message.*`/`alert` 等）的字面量与
  title/message/description/body 字段。不计：注释、console/日志、throw、`t()`/`i18n.t()` 整棵子树（含 defaultValue）、className/id/
  data-*/key/style/href/type/role、`<Trans>`/`<code>`/`<kbd>`/`<pre>`、纯符号、URL/路径、class 串、下划线标识符串、单个短词。
  已知盲区：`{ label: '…' }` 这类对象数据表不计。`rg` 抽查 704 行含中文的 JSX 文本，漏的 36 行都应排除。
  §8 调用方：`lib/gate-checks.mjs`（src/ 或门禁自身改动触发）、`package.json` 的 `migration:hardcoded-copy[:inventory]`、
  `lib/gate-checks.test.ts`。门禁不改行为，不登记 RF。
- 任务 3：DOM 金样 W16 已在 `88f6982b` 更新为 3（RF-W09）。IPC 金样少了 `listen:tauri://close-requested`，原因是 ui-boot 手动分块
  （W18 `fe124709`、W17 `f90b38e5`，`vite.config.ts` 属 W17）后 `vfsRefApiEnhancements` 成为独立的懒加载 chunk，demo 启动阶段
  不再执行它的模块副作用。主入口仍经 `main.tsx → dstu/index.ts → dstu/api.ts` 静态加载，产品无影响。
- 任务 5 方案：
  - 实测办法：临时给 `Tabs.tsx` 加 tablist/tab/aria-selected/roving tabIndex，用 `vitest --changed` 跑了全部 160 个依赖文件，
    21 个失败；再用原组件重跑这 21 个，其中 5 个失败数完全相同（SessionRow、editorExtensions.golden、FlashcardsApp.mobile、
    modernSidebar×2，属既有问题）。因此真正受影响的是 16 个文件，约 125 条用例。第六轮写的“20 个文件”混入了这些既有失败。
  - 受影响文件（全部在 `tests/vitest/**`，属 W09）：
    - 数据治理 10 个：`DataGovernanceDashboard.{backup-config,backup-operations,backup-restore-ui,debug-tab-visibility,edge-cases,
      error-states,restore-operations,scoped-loading,sync-operations}.test.tsx`、`maintenance-mode.test.tsx`。
      选择器 `getByRole('button', { name: /^(?:备份|data:governance\.tab_backup)$/i })`（概览/同步/调试同理）改成 `getByRole('tab', …)`；
      断言激活态用 `toHaveAttribute('aria-selected', 'true')`，不用 `data-state`。
    - 样式实验室 6 个：`StyleDebugPage.{button,llm-output,switch,toast,tooltip,transitions}.test.tsx`。
      `getByRole('button', { name: '组件对比' | '混用清单' | '迁移概览' | 'Token 校对' | '概览' })` 改成 `getByRole('tab', …)`。
  - 其他 lane：W12 冒烟没有按标签名找 Tabs（`11-core-recovery` 的恢复界面第六轮已单独改过）；W16 DOM 金样只有
    `models.{desktop,mobile}.txt`（设置“模型服务/模型分配”）会多出 role/aria-selected/tabindex，需要重录。
  - 组件改法：TabsList `role="tablist"`；TabsTrigger `role="tab"`、`aria-selected`、roving tabIndex、`aria-controls`；TabsContent
    `aria-labelledby`（id 用 Tabs 内的 `useId` 派生）；在 tablist 上支持左右方向键和 Home/End。顺带修一个现存 bug：`{...props}` 放在
    内置 `onClick` 之后，调用方一传 `onClick`，标签就不再切换，应改为组合调用。
  - 落地顺序：① W09 一个提交里同时改 `Tabs.tsx`、16 个测试，加一个方向键/aria 的新测试，登记 deliberate + proposed RF；
    SettingsCategoryHeader、ComponentRecoveryShell 里手写的 role 保持兼容，之后再收。② 合入 INT 后，W16 重录 models 金样。
    ③ W12 冒烟复跑一遍确认。

## 第八轮

| # | 任务 | 状态 | 提交 |
|---|------|------|------|
| 0 | 合入 assault/integration `fd621db5` | 完成 | 26cf77f0 |
| 1 | 共享 `shad/Tabs.tsx` 标签语义，16 个测试改按 tab 查找（RF-W09-shared-tabs-aria-semantics，deliberate） | 完成 | ee9ee9f0 |
| 2 | #29 恢复界面的组件原因按界面语言显示（RF-W09-recovery-reason-localized，deliberate） | 完成 | 977bd724、345285b5 |
| 3 | data.json:543 恢复页说明按各组件实际恢复结果选句（RF-W09-recovery-description-by-outcome，rust-bug） | 完成 | 16d4e3e1 |
| 4 | #26 rerank 开关 | W04 登记 RF，前端未动 | — |
| 5 | #25 发送预算按实际使用的模型和最新模型配置计算（RF-W09-stale-model-cache-context-budget，rust-bug） | 完成 | ebc1b936、6d88946c |
| 6 | `markdownBlock.test.tsx` 的消毒契约改读 `markdownPipeline.ts`（W18 `690b91e2` 把 rehype-sanitize 挪过去） | 完成 | 02de3e83 |

- 任务 1：外观不变（className 未动）。16 个测试文件加新测试共 176 条全过；`vitest related Tabs.tsx` 162 个文件里 8 个失败，
  换回改动前的 Tabs 重跑这 8 个，失败完全相同，属 INT 既有问题（见下）。DOM 金样只有 `models.{desktop,mobile}.txt` 用到
  共享 TabsTrigger，而 SettingsCategoryHeader 自己传了 role/aria-selected/tabIndex/onKeyDown，预计没有差异。
  SettingsCategoryHeader、ComponentRecoveryShell 里手写的语义暂不收：已批准的 RF-W09-recovery-shell-tab-roles 不能依赖
  一条还在待审的 RF，等共享 Tabs 的 RF 批准后再收。
- 任务 2：Tauri 的单库失败原因同样是英文（coordinator.rs:329/379/395/608/634），只有 lib.rs 的全局失败原因是中文。
  前端解析原因（`system-status/componentReason.ts`），再用 `data:recovery.component_reason.*` 重新组句：en-US 与后端原句逐字
  相同；zh-CN 能对上 Rust 中文句子的照搬原句；底层错误、路径、快照名原样保留；认不出的句子原样显示。
  `componentReason.test.ts` 读 Rust 与 Host 源码，措辞一改就失败。
- 任务 3：文件未动（W12 冒烟 ⑪ 的场景）或只是依赖跳过时仍用原句；全部从快照恢复、全部删除失败升级新建的文件、全部恢复失败
  各用一句新句；多种结果并存或原因认不出时用“各数据组件的处理结果见下方说明”。
- 任务 5：根因比 #25 描述的更宽。发送路径先按会话自己的选择（`model2OverrideId || modelId`）算 `contextLimit`，到
  `applyRuntimeModelSelection` 才解析出实际模型；跟随全局默认模型的会话 `modelId` 为空，即使缓存是新的也按 100k 兜底
  （83808，正是 ⑥ wire 里的值）。另有两种：设置页新增模型后 5 分钟内缓存里找不到它；聊天页未挂载时改了窗口，
  缓存里还是旧值。重试或变体重试指定其他模型时，预算还按会话模型算（32k 模型按 1M 发出 956498）。修法：模块级监听
  `api_configurations_changed` 清缓存；找不到模型时强制刷新；解析出实际模型后用 `applyRuntimeContextBudget` 重算，
  重试与变体指定模型的分支同样处理；用户设置的上下文上限仍然优先。单测 5 条，前 3 条和重试那条在旧代码上失败。
- 相关测试里的既有失败（改动前同样失败）：`src/components/sidebar/__tests__/SessionRow.test.tsx`、
  `src/platform/__tests__/official-plugins.test.ts`、`src/ui-plugins/official/debug/__tests__/debugPanels.test.tsx`、
  `src/ui-plugins/testing/__tests__/{fullstack-pairing,official-slots.golden}.test.tsx`、
  `tests/vitest/flashcards/FlashcardsApp.mobile.test.tsx`、`tests/vitest/modernSidebar{SessionIndicators,SuperSession}.test.tsx`
  （有的报 “useUiKernel: missing <UiKernelProvider>”）。`chatPlugins.golden.test.tsx` 在 500 个文件并跑时偶发动画高度
  `0px`/`auto` 差异，单独跑通过。
- 交接：W12 在 INT 合入后去掉 `host/e2e/smoke/__tests__/golden/06-agent-tools.spec.ts:350` 的 `test.fail()`，并复跑 ⑥ 与 ⑪
  （⑪ 的说明文字不变，原因行在中文界面变成中文，`11-core-recovery.spec.ts:73` 断言的是 IPC 原文，不受影响）；W16 复核
  `models.{desktop,mobile}.txt` 金样，有差异才重录；W20/W07 改 `host/platform/storage/migration/{coordinator.ts:151,174-178,
  537-551；backup.ts:534-537,555,563}` 的原因措辞时同步 `componentReason.ts`（漂移测试会提示）。

## 第九轮

| # | 任务 | 状态 | 提交 |
|---|------|------|------|
| 0 | 合入 assault/integration `6c491e6f`（已是祖先，无需新合并） | 完成 | — |
| 1 | DebugPanelHost 标题栏、UI Lab 开关、拖拽柄文案改走 `common.debug_panel.*`（RF-W09-debug-panel-host-copy-localized，deliberate，待审） | 完成 | c0326baa |
| 2 | `learningHub:notes-learning-view` 登记为 `APP_EVENTS.LEARNING_HUB_NOTES_LEARNING_VIEW`，监听改走 `addAppEventListener` | 完成 | 9158ab0c |
| 3 | `@/utils/platform` 新增 `getRawUserAgentInfo()`（只追加，原有平台判断不变） | 完成 | 3091cee6 |
| 4 | W18 交接 22：`ui-plugins/official/settings/api.ts` 的 `workbenchMode.setEnabled` | 完成 | 1c796776 |
| 5 | SettingsCategoryHeader、ComponentRecoveryShell 收掉手写标签语义，改用共享 Tabs | 完成 | 3b2b12f0、b6f80890 |
| 6 | 服务器全量里 `frontend-invoke.test.ts` 真实树用例失败 | 完成 | 2ff33ead |
| 7 | hardcoded-copy 1743 → 1705（含任务 1 的 9 条） | 完成 | c0326baa、086c0212、170ba3ca |

- 任务 1：zh-CN 照搬原文（含 “Analysis Panel”“LLM Playground” 两处原本就是英文的），en-US 用英文。调试面板只在开发构建出现。
  `tests/vitest/debug-panel/debugPanelHostCopy.test.tsx` 用真实 react-i18next 分别渲染两种语言。hardcoded-copy 1743 → 1734。
- 任务 2：`NOTES_LEARNING_VIEW_EVENT` 保留导出（值不变），裸 `CustomEvent` 发出的事件照样生效，非法 view 照样忽略。
- 任务 3：`src/utils/platform.ts` 属 W17，按派单只在文件末尾追加一个函数。
- 任务 4：`ui-plugins/official/settings/` 只有这个 api.ts，没有 lane 认领 settings 插件，非安装/索引文件。设置功能模块加载时
  `provideWorkbenchModeService({ setEnabled: persistWorkbenchModeEnabled })`；提供之前的调用按顺序等待。测试 3 条：提前调用、
  经真实 feature 写设置并广播、写失败返回 false 且不广播。
- 任务 5：先让共享 Tabs 的方向键换焦点时 `focus({ preventScroll: true })` + `scrollIntoView({ block/inline: 'nearest' })`，这是
  SettingsCategoryHeader 原先手写的滚动行为（可横向滚动的长标签栏不跳到中间）。之后两个组件删掉 role、aria-selected、
  roving tabIndex 和方向键处理；SettingsCategoryHeader 保留自定义 id/aria-controls（面板在 Settings.tsx:1438-1440 外部渲染），
  ComponentRecoveryShell 改用 Tabs 从 useId 派生的 id。证据：`tests/vitest/settings/tabHeaders.dom-golden.test.tsx` 的两份金样
  在改动前的手写版本上录制（`W09_CAPTURE_TAB_GOLDENS=1`），覆盖初始、点击、ArrowRight、Home 四个状态，改动后原样通过。
  `vitest related` 两个组件 136 个文件，4 个失败（17 条）都是既有的 “useUiKernel: missing <UiKernelProvider>”。
  W16 的 Playwright DOM 金样 `tests/visual/dom-golden.mjs --check --scenes models --build` 通过（models.desktop/mobile 无差异），
  不需要 W16 重录。
- 任务 6：不是 Linux 路径、排序、大小写或基线过期（本地 fresh/stale 都是 0）。服务器上该用例 66.5s，超过 host 配置的 30s
  testTimeout（同批其他 gate-check 用例最长 14s）。原因是 `scanSources` 把 src/ 下 2696 个文件的语法树同时留在内存里
  （约 650MB 堆，256MB 上限直接 OOM），满载机器上 GC 把同步扫描拖过超时。改为只解析提到 `invoke` 或已识别包装名的文件，
  按新识别的包装名逐轮扩大（含 `\u` 转义的文件一律解析）；被排除的文件不可能含调用点或定义包装，结果与旧实现逐项相同
  （真实树 1396 个调用点 JSON 全等）。扫描 3.1s → 1.0s，256MB 上限下能跑完，真实树用例本地 9.4s → 3.3s。超时与断言未动；
  新增一条用例覆盖跨文件包装链、方法包装与 `\u` 转义名。
- 任务 7：三类。① 品牌名改读已有词条，两种语言的值与原文相同、界面不变：EngineSettingsSection 的 Google CSE/Tavily/Brave、
  PresetServerSelector 的 API Key、IndexDiagnosticPanel 的 Lance Schema、LoadingScreen 的 Deep Student。② 写死英文的提示与替代
  文字（RF-W09-english-hardcoded-labels-localized，deliberate，待审）：卡片 3D 预览播放/暂停 title 与分页圆点 aria-label、生图
  alt、裁剪对话框原图 alt、统计图例 Tokens、错误边界空消息兜底；en-US 与原文逐字相同，zh-CN 改为中文。③ 开发构建的 Chat V2
  集成测试页与测试控制改读 Rust 就有的 chatV2:dev.* 词条（RF-W09-chat-dev-integration-test-copy-localized，deliberate，待审）；
  zh-CN 词条与原文相同，en-US 变为英文。测试：`tests/vitest/i18n/englishHardcodedLabels.test.tsx`、
  `tests/vitest/chat/chatDevPagesCopy.test.tsx`（真实 react-i18next，两种语言各渲染一次）。
  剩余基线大多在调试面板、编辑器、仪表盘（W18/W19 路径）和 button-audit、style-lab 等开发页，且多数没有现成词条。
- 交接：
  - W19：`src/features/learning-today/todayLearning.ts:63` 改为
    `dispatchAppEvent(APP_EVENTS.LEARNING_HUB_NOTES_LEARNING_VIEW, { view: 'review' })`（从 `@/events` 导入），之后用
    `ui-boundaries.mjs --write-baseline` 删掉该文件对应的 bare-custom-event 计数。
  - W19：`src/debug-panel/plugins/CrepeImageUploadDebugPlugin.tsx:392-393` 两行改为 `...getRawUserAgentInfo(),`（从
    `@/utils/platform` 导入），之后该文件的 ua-sniffing 基线项变为 stale，重写基线。
  - W18：`src/ui-plugins/official/menu/workbenchMenus.tsx:21` 改为 `import { workbenchMode } from '@/ui-plugins/official/settings/api';`，
    `:56` 改为 `run: () => { void workbenchMode.setEnabled(false); },`；`__tests__/menubar.golden.test.tsx:22` 的 mock 改为 mock
    `@/ui-plugins/official/settings/api` 的 `workbenchMode.setEnabled`。之后 workbenchMenus.tsx 的 plugin-import-boundary 基线项
    （scope src/features/settings）变为 stale，ui-boundaries 基线 87 → 86。
  - W17：`src/utils/platform.ts` 末尾追加了 `getRawUserAgentInfo()`（派单指定），只追加，原有导出未动。
  - W28：既有失败 `tests/vitest/flashcards/FlashcardsApp.mobile.test.tsx`、`src/components/sidebar/__tests__/SessionRow.test.tsx`、
    `tests/vitest/modernSidebar{SuperSession,SessionIndicators}.test.tsx`，共 17 条，都是 “useUiKernel: missing <UiKernelProvider>”。

## 第十轮

| # | 任务 | 状态 | 提交 |
|---|------|------|------|
| 0 | 合入 assault/integration `390f244b` | 完成 | 99325a34 |
| 1 | V02-03 云同步 `allowInsecure` → `allow_insecure`（RF-W09-cloud-config-allow-insecure-wire-key，rust-bug，待审） | 完成 | 6214c0be |
| 2 | V02-04 删除无调用方的 `estimateTokens` | 完成 | 12eaf61d |
| 3 | V05-06 QuestionMaterialView 保存失败走 `getErrorMessage`（RF-W09-material-conflict-apperror-message，deliberate，待审） | 完成 | 7acdf2fd |
| 4 | `isPublishedApi` 认 `host/plugins/<p>/portable.ts`；import-cycles 也以 portable.ts 为入口 | 完成 | cfe940a1 |
| 5 | import-cycles 基线删 W02 两项 | INT afb309bc 已做，`--check` 0 stale | — |
| 6 | frontend-invoke 列出非字面量参数调用点供人工确认（不变红） | 完成 | fa1f8759 |

- 任务 1：Rust `SafeCloudStorageConfig` 是内部标签枚举，`rename_all = "lowercase"` 只改变体名，字段线上名是 `allow_insecure`，
  且 `deny_unknown_fields`。Tauri 前端发 `allowInsecure`，后端一律拒绝，局域网/公网 HTTP 的 WebDAV 与明文 FTP 保存、测试都失败；
  回读时又读 `allowInsecure`，恒为 false。修法只动前端：发送 `allow_insecure`（仅为 true 时带），回读 `allow_insecure`，
  localStorage 缓存兼容旧的 camelCase 与后端 snake_case 两种写法，一次性迁移把缓存里的开关转发给后端。后端未改。
  红（修复前源码，`git checkout 6214c0be^ -- <两个 src 文件>`）：3 个文件 9 条失败。跨层用例不 mock invoke，直接走真实 Host 命令，
  报 ``invalid args `config` for command `cloud_config_ssot_save`: unknown field `allowInsecure`, expected one of `webdav`, `root`, `allow_insecure` ``，
  publish 同样被拒，test_connection_draft 报 `must have required property 'webdav'`；单测 5 条（发送键、回读、resolve、缓存、迁移）；
  组件用例发布后风险提示消失（`expected [] to have a length of 1`）。绿：20/20。
  测试：`src/utils/__tests__/cloudStorageSsot.test.ts`、`tests/vitest/data-governance/cloudConfigWireShape.crosslayer.test.ts`、
  `src/features/settings/components/__tests__/CloudStorageSection.allowInsecure.test.tsx`。
- 任务 2：选删除而不是包进 `request`。两个前端都没有调用方，契约 `"frontend": "none"`，基线里没有相关项；frontend-invoke 1396 → 1395。
- 任务 3：`String(err)` 把 AppError 普通对象变成 `[object Object]`。红：2 条，界面显示 `[object Object]`，期望分别是冲突提示
  “材料已被其他修改更新，请重新载入后再保存（你的草稿仍在）。”和后端消息 “数据库已锁定”。绿 9/9。
- 任务 4：portable.ts 约定是 api.ts 的 Node-free 子集（导出同值），由各插件 `tests/portability.test.ts` 守护；现有 4 个插件
  （agent-orchestration、agent-skills、agent-workspace、vfs）。只放行 `<p>/portable.ts` 本身，`src/portable.ts`、`portable-extra.ts`、
  `portable/index.ts` 仍拒绝。先红（2 条）后绿。import-cycles 31 个入口、614 个模块，48 项基线，0 new、0 stale。
- 任务 6：只列“命令名是字面量、参数不是完整对象字面量”的调用点，Request 命令（原始字节体，不做键检查）不列。当前 6 处：
  browserApi.ts 283/317/323/336、taskWorkspaceApi.ts:42、notesApi.ts:278（V02 列的 9 处里 estimate_tokens 已删，
  convert_heic_to_jpeg 与 staged_upload_append 是 Request 命令）。`--check` 退出码不受影响，`--json` 带 `review` 数组。
- `frontend-invoke.test.ts` 本地耗时：真实树用例 3.5s（负载 35）到 9.7s（负载 31），文件 4.6–12.6s，host 配置 testTimeout 30s，
  超时未动。
- community-web-search-example：W09 路径下无引用。

| # | 任务（交接） | 状态 | 提交 |
|---|------|------|------|
| 7 | W12 #34 正文自动保存在途时改标题/标签被 CONFLICT 回滚（RF-W09-note-metadata-conflict-retry，rust-bug，待审） | 完成 | 420f08be |
| 8 | W12 #33 `src/dstu/api.ts:189` 白名单缺 `res_`/`file_`（RF-W09-dstu-resource-file-source-id-prefix，rust-bug） | 完成 | ff306a60 |
| 9 | W12 #23 重开：新建笔记标题拿不到焦点（RF-W09-new-note-title-focus-yield，rust-bug，待审） | 完成（单测），真实窗口待 W12 复核 | 7fd99e83 |
| 10 | W01：plugin-manifest 门禁的预发布语义与决定 1 对齐；W27：schema permissions 隐式授予的说法 | 完成 | 4fb94483 |
| 11 | V03：event-emit 扫描 hubListen/hubListenKeyed 与 useTauriEventListener().attach 注册的监听 | 完成 | a8e17e29 |
| 12 | W03 `qbank_create_question` 校验文案 | W01 `87da9b51` 已从根上修（serde 认 oneOf 单元 enum），已在本分支，W09 无事可做 | — |
| 13 | LA-04 chatanki 生命周期改走 W19 的 `emitChatAnkiLifecycle` | 未做：`src/debug-panel/channels/chatAnki` 还不在 INT | — |
| 14 | W28 W09-6 固定 jsdom userAgent；W27 vitest.setup 先于 DOM 加载 react-dom | 未做：两项都改全局测试环境，须两端各跑一次前端全量，本轮禁止全量 | — |

- 任务 7：标题与标签写回拿的是 `lastKnownUpdatedAtRef`，正文保存已写入后端、响应未回时这个基线已过期，元数据写回必然 CONFLICT，
  NotesEditorHeader 回滚输入框。修法：CONFLICT 时读一次最新节点，磁盘上该字段仍是修改前的值就以最新 updated_at 重试一次；
  字段已被别处改过照常报冲突、不重试。红：2 条以 CONFLICT 失败（假后端按 updated_at 校验）；“别处改过”两条对照用例修复前后都过。
  绿 4/4，同目录 NoteContentView 其余用例、windowedMarkdownSourceContracts、review-repro、UnifiedAppPanel.identity 均通过。
- 任务 8：消毒分支对 `res_*`/`file_*` 返回原值，只多一条 console.warn；修后返回值不变。红 1 条（两条警告），绿。
- 任务 9：上一轮 RF-W09-new-note-title-focus 只让标题等正文就绪；但 NotesWorkspaceApp 传 `focusOnActive`，NoteContentView
  的 `handleEditorReady` 在同一个就绪帧先聚焦正文，标题自动聚焦看到 `.ProseMirror` 已有焦点就放弃，与 W12 观察一致（约 390ms
  焦点到正文）。修法：正文就绪时笔记可写且正文为空则不聚焦正文，交给标题；有内容、只读、切回标签页照旧。Tauri 同一逻辑。
  红：空白可写笔记就绪即聚焦正文（失败）。`NotesCrepeEditor` 的 `effectiveReadOnly` 还含阅读模式与 host 忙碌：阅读模式下的空白
  笔记两边都不聚焦（正文本来就只读）；host 忙碌是暂时的，结束后标题照常聚焦。
- 任务 10：门禁 `satisfies` 加 `{ includePrerelease }`（默认关闭，W01 的 kernel 一致性测试用 `includePrerelease: false` 比对
  门禁两参调用，因此不改默认）；engines 对应用版本的检查开启它。对照表与 W01 契约测试同一份（semver 7.8.6）。可选的 semver 对照
  只与 7.x 比：本机解析到的是传递依赖 semver 6.3.1，它对 includePrerelease 的展开与 7 不同。schema 只改 description：
  `$defs/range` 写明预发布规则；permissions 原说“log、本插件的存储”隐式授予，实现只授予 log（存储要声明 `service:storage`）。
  contracts/CHANGES.md 已记。红 2 条，绿 14/14，W01 两个 kernel 测试文件同跑通过。
- 任务 11：这几个入口经对象字段或 hook 返回的方法把事件名交给 listen，包装识别跟不到，调用方从未被检查。门禁加
  `REGISTRATION_ENTRIES` 声明表，registerDomainListener 随之被识别为 hubListen 的包装。真实树监听点 121 → 144；新看到的事件名
  除 `exam_sheet_progress`（Rust 与 Host 都不发，V03 §3.3 死监听）外都能对上发射点。基线 +4（带 reason）：domainEvents 两个包装
  内部、开发面板按 KNOWN_DOMAIN_EVENTS 预热、上述死监听。V03 另提的“Rust 为 Window::emit 的事件 Host 不得 emitTo”需要 Rust 侧
  数据，本轮未做。
- 过程问题：一次误把 `tests/vitest/learning-hub/` 目录级 vitest 未加 `bin/heavy` 运行（28 文件 193/193 通过），之后只跑单文件。
  `fullDocument.host.test.tsx` 在负载 49 时同批跑失败 1 条，单跑 12/12 通过，该文件不引用 NoteContentView。
- 门禁（INT `390f244b` 上，交付前）：boundaries 0 违规；frontend-invoke、event-emit、ui-boundaries、hardcoded-copy、
  import-cycles 均 0 new / 0 stale；rust-fixes 83 条 0 错误；portability scan 通过；contracts:check OK；
  `bin/heavy npx tsc --noEmit -p tsconfig.json` 与 `-p tsconfig.host.json` 均 0 错误（version.ts 已删）。
- 合入 INT `2be7ed80`（`c9eb2104`，无冲突、与本轮改动无文件交集）后复跑：上述门禁全部 0 new / 0 stale
  （rust-fixes 90 条：approved 83、proposed 7，其中 5 条为本轮 W09 新增，0 错误；plugin-manifest 0 new）；
  两个 tsc 0 错误；本轮改动的 12 个测试文件逐个单跑全绿（前端 7 个用 vitest.config.ts，`scripts/` 下 5 个门禁测试用
  vitest.host.config.ts），W01 `host/kernel/tests/plugin-manifest-contract.test.ts` 9/9。
- 交接：
  - W01：`host/kernel/API.md:891-892` 改为“W09 gate 的 `satisfies` 默认仍按 npm 默认语义，与 kernel 的一致性测试用
    `includePrerelease: false` 比对；gate 对应用版本的 engines 检查开启 `includePrerelease`，与 kernel 同口径”。可选在
    `host/kernel/tests/plugin-manifest-contract.test.ts` 的真值表用例里加
    `expect(satisfies(v, r)).toBe(gate.satisfies(v, r, { includePrerelease: true }))`。验证：该测试文件。
  - `vitest.host.config.ts` 的属主（W05 请求，INTEGRATION-NOTES:342）：`test.setupFiles` 里 `delete` `PROXY_ENV_KEYS` 与
    `NO_PROXY`/`no_proxy`（`host/platform/http/proxy.ts:16-18`）。注意环境变量全空时 proxy.ts 会改读系统代理（system-proxy.ts），
    只删环境变量不能完全隔离，需要属主决定是否同时注入空的 PlatformProxyReader。
  - 主代理：W09-6 jsdom userAgent 建议固定为 Linux 形式 `environmentOptions: { jsdom: { userAgent: 'Mozilla/5.0 (linux) AppleWebKit/537.36 (KHTML, like Gecko) jsdom' } }`
    （`vitest.config.ts` 的 `test` 段），让本机与服务器走同一平台分支；须在 macOS 与 Linux 各跑一次前端全量后再合。
    W27 的 vitest.setup.ts react-dom 加载顺序同理。
  - W12：#23 在真实窗口复核（冒烟 ③ 新建笔记后焦点应在标题，`new-note-focus-after-1s` 注解）；#34 冒烟 ③ 首例复跑。
  - W19：LA-04 的 `emitChatAnkiLifecycle` 进 INT 后告诉 W09，再改 `diagnostics.ts:33-44` 等直接派发点。
  - W16：QuestionMaterialView 新增 `@/utils/errorUtils` 导入（`7acdf2fd`），若 chunk-graph 金样敏感请复核（errorUtils 预计已在主 chunk）。
  - 文档（W26 交接给“W09 或主控”）：`docs/dev/wave2-C-r1/08-keyboard-back.md:30` 不在 W09 路径，留给主控。

# W09 进度（第十一轮，INT 2be7ed80 起）

| # | 任务 | 状态 | 提交 |
|---|------|------|------|
| 1 | A06 复核必须修 1：#34 重试成功后不推进正文乐观锁基线 | 完成 | 71d0efdf |
| 1b | A06 建议 4：cloudStorageSsot 缓存用例改名 | 完成 | e486af31 |
| 2 | Linux 红（B 趟 fe）：导图后代数缓存（RF-W09-mindmap-descendant-count-linear） | 完成 | 3896472e |
| 3 | S01 D3 工具卡片环境失败提示（RF-W09-shell-environment-failure-hint，[待审]） | 完成 | 87275f63 |
| 4 | A06 跟进 2：event-emit 识别经动态导入 `@tauri-apps/api/event` 的 listen/once | 完成 | 95767c29 |
| 5 | D5 hardcoded-copy 1705 → 1702 | 完成 | c5cdfc8a、b6831162 |
| 6 | 合入 INT `1d1fdb78` + 交付前门禁、双 tsc、单跑测试 | 完成 | 1a1ab882 |

- 任务 1：红（修复前）：新增“after a retried tags write, the next autosave does not overwrite a body written elsewhere”
  失败 `expected { ok: true, …(1) } to match object { ok: false }`（第二次正文保存以推进后的基线直接成功，别处正文被覆盖）。
  修：setNoteMetadataWithOcc 返回 `{ result, retried }`，重试过就跳过 C13 的基线刷新。绿 8/8；newNoteFocus 4/4；
  其余 6 个 NoteContentView 相关文件 68/68。
- 任务 2：B 趟 fe 12 例失败中只有 layoutDescendants.perf 在 W09 路径。本机单跑 3/3 失败（冷缓存 207–293ms，阈值 80），
  与负载无关。实现与参照仓逐字相同。修后 1000/3000 链冷缓存约 1ms / 2–3ms；新增 linear 测试读 children 34050 → ≤ 9000。
- 任务 3：红：两种语言 × 完整报错 / git_commit 前缀共 4 条找不到提示；跨层用例（真实 agent-workspace 执行器 EAGAIN →
  eventBridge → ChatStore → 卡片）去掉组件改动时同样失败。绿 8/8 + 1/1；McpToolBlock 原有 15/15；hardcoded-copy 1705 不变；
  check-i18n 跨语言缺键 0。
- 任务 4：红：新用例在改动前一个监听点都认不出（`expected [] to deeply equal [ [ 'src/dyn.ts', 1, … ], …(8) ]`）。识别五种写法：
  `const { listen } = await import(…)`、`import(…).then(({ listen }) => …)`、经本地加载函数 `events().then(…)`、
  `const mod = await import(…); mod.listen(…)` / `(await import(…)).once(…)`、`.then((m) => m.listen(…))`；从别的模块动态导入的
  listen 不算。只在文本里出现 `import('@tauri-apps/api/event')` 的文件上做这项判断。真实树监听点 144 → 180，`guardedListen`
  随之成为包装（15 个调用方计入）。新增 14 条缺口逐条核对参照仓：拖放的 `tauri://file-drop*`（Tauri v1 名，第二层回退）、
  `tauri://window-maximized/unmaximized`（Tauri 无此事件）、调试面板 `exam_sheet_progress`、`mcp-debug-command`、
  `mcp-bridge-{prompts,resources,resource-read}-request`（Rust 只发 tools-request）在 Rust 里都没有发射端，行为与 Rust 相同；
  `guardedListen` 是透传包装。全部写理由入基线，0 new / 0 stale。未做：`tauriStdioTransport.ts:28` 把 listen 函数本身存进
  Promise 再调用（需要数据流）；同文件里调用导出的包装函数仍认不出（包装表按导出名登记、同文件只查本地表）。
- 任务 5：① SessionGroupActions 的 pinGroup/unpinGroup 改为必填、去掉走不到的英文兜底（唯一调用方 ModernSidebar 始终传词条），
  界面不变，测试补置顶/取消置顶与无回调两条（9/9）。② 审批栏外部 MCP 风险徽标改读新词条
  `chatV2:approval.scope.externalMcpUnenforced`（RF-W09-external-mcp-approval-warning-localized，deliberate，[待审]）：
  zh-CN “外部 MCP·本地沙箱不生效”，en-US 与原文逐字相同。红：改动前组件 zh-CN 用例找不到中文徽标、en-US 用例通过；绿 2/2，
  BlockingApprovalBar 原有 runtimeScope 8/8、expired 2/2、rejectReason 5/5（断言未动）。③ 试过 PulseDot 读屏 “Loading”
  本地化，但它被录进 W17 的 FE-B2/FE-B3 重构前 DOM 金样（chat-block-dom.json 4 处、tool-result-dom.json 3 处），已撤回，
  记为跟进。`vitest related` 两组件时另见的失败均与本轮无关：缺 `src/version.ts`（StatusBar、workbenchPrewarm、命令面板、
  settings sidebar）、OverlayScrollbars class 顺序（chatPlugins/toolResultDom/markdown 金样，HEAD 上同样失败，服务器 B 趟未红）。
- 任务 6：合入 INT `1d1fdb78`（无冲突）后：boundaries 0 违规；frontend-invoke、event-emit、ui-boundaries、hardcoded-copy、
  import-cycles、plugin-manifest 均 0 new / 0 stale；rust-fixes 102 条（approved 92、proposed 10）0 错误；portability 通过；
  contracts:check OK；`bin/heavy npx tsc --noEmit` 的 tsconfig.json 与 tsconfig.host.json 均 0 错误（version.ts 已删）；
  本轮 12 个测试文件逐个单跑全绿。C 趟服务器结果到交付时仍未出现。

# W09 进度（第十二轮，INT 1d1fdb78 起，F 趟）

| # | 任务 | 状态 | 提交 |
|---|------|------|------|
| 0 | 上一轮未提交的 round 11 进度细节 | 提交 | 33e3e3e6 |
| 1a | 主编排 R-06 第 2 条 (a)：jsdom userAgent 固定为 Linux 默认值 | 已撤回（A23） | 2dbab35d，撤回 0dfa55e3 |
| 1c | 主编排 R-06 第 2 条 (c)：host 测试 setupFiles 删除代理变量 | 完成 | c04b374f、25f64a01 |
| 2 | A18 复核 W09-19890468：无必须修；建议 1（D3 只认开头）、建议 2（标题分支补用例）都做了 | 完成 | 9f569109、1f0aa590 |
| 3 | plugin-manifest schema:72 隐式授予文字（W01 交接） | 早已改好 | 4fb94483（在 19890468 内，E 趟带进 INT） |
| 4 | WindowControls 最大化图标跟随窗口（RF-W09-window-controls-maximize-follows-resize，[待审]） | 完成 | be0d04a5 |

- 1a 更正：2dbab35d 已由 0dfa55e3 撤回，`vitest.config.ts` 与 `tests/vitest/vitestConfigJsdomUserAgent.test.ts` 回到改前。
  原因（A23 复核 W09-97af867e）：vitest 拿到 `environmentOptions.jsdom.userAgent` 时会同时传 `resources: new ResourceLoader(...)`，
  jsdom 由 NoOp 加载器换成真实加载器，从不加载子资源变成真去抓 iframe、script、stylesheet，Linux 服务器上的行为也变了
  （例如 bilibili 播放器用例会真的发 HTTPS 请求）；验收趟前不接受这种全局变化，审计编排决定只撤 2dbab35d。本机与服务器 UA
  一致以后按 A23 建议重做：不在 environmentOptions 里给 userAgent，改在 `vitest.setup.ts` 里仅 jsdom 环境下覆盖
  `navigator.userAgent`，并加断言确认子资源加载仍是 NoOp；本轮不做。下面是撤回前的原记录。
- 1a：`vitest.config.ts` 加 `environmentOptions.jsdom.userAgent`，值为 jsdom 在 Linux 上的默认串
  `Mozilla/5.0 (linux) AppleWebKit/537.36 (KHTML, like Gecko) jsdom/<版本>`（版本从 node_modules/jsdom/package.json 读，
  现为 24.1.3）。jsdom 的 `navigator.platform` 两地都是空串，只有 UA 不同；macOS 上 UA 是 `(darwin)`，`getPlatform()` 落到
  windows 兜底，Linux 上是 linux。新测试 `tests/vitest/vitestConfigJsdomUserAgent.test.ts`：把 process.platform 临时换成
  linux 取 jsdom 原样默认值与 `navigator.userAgent` 比较，并断言 `getPlatform() === 'linux'`；改前 macOS 上 2/2 红
  （收到 `(darwin)`、`windows`），改后绿。`rg 'userAgent|navigator.platform'` 命中的 21 个测试文件经 bin/heavy 改前改后
  各跑一次：改前 225/226、改后 227/228（多出的 2 条是新测试），唯一失败两次相同：StatusBar“品牌菜单：全部应用 / 系统设置 /
  退出学习桌面”（macOS 本机红、B/C 两趟服务器 34/34 绿，与 UA 无关，判断为本机负载下 waitFor 1s 超时，只记录）。
- 1c：`vitest.host.config.ts` 加 `setupFiles: ['./scripts/electron-migration/lib/host-test-setup.mjs']`，调用
  `host-test-env.mjs` 的 `clearProxyEnv` 对 `PROXY_ENV_KEYS` 六个名字和 `NO_PROXY`/`no_proxy` 做 delete。setup 不导入
  `host/platform/http/proxy.ts`（setupFiles 先于测试文件加载，导入它会让测试里对 undici/proxy 的 vi.mock 失效），名单一致性由测试校验。
  测试 `host-test-env.test.ts` 5 条：setupFiles 含该文件、名单 = PROXY_ENV_KEYS + NO_PROXY/no_proxy、启动 shell 带进来的
  代理变量到测试文件时已不存在、setup 对设成空串的也 delete（`key in process.env` 为假）、只动给定对象。红：带
  `HTTP_PROXY/https_proxy/NO_PROXY=/no_proxy` 启动、配置未改时 2 条红（setupFiles 为空、4 个变量仍在）；改后 5/5。
- 2：建议 1：`mcpTool.tsx` 由 `includes` 改为 `/^(?:git add succeeded but git commit could not start: )?LOCAL_SHELL_ENVIRONMENT_FAILURE \(stage=/`；
  核对 Host→卡片链路：`tool-pack-executor.ts:70` 原样 `emitToolCallError(result.error)`，跨层用例原本就断言卡片 error 与
  执行器 error 相同，本轮再加一条“执行器 error 以标记开头”。新用例（两种语言）“命令跑了并失败、stderr 尾部带标记时不提示”
  改前 2 条红、改后 10/10；跨层 1/1，McpToolBlock 原有用例全绿。建议 2：照“after a retried tags write”写标题版；
  变异（`NoteContentView.tsx:782` 条件恒真）下只有新用例红（`expected { ok: true, … } to match object { ok: false }`），
  还原后 9/9。两条 RF 的 tests 列表已补。
- 4：WindowControls 原监听的 `tauri://window-maximized/unmaximized` 没有发射端（Rust、Tauri 2、Electron 壳都没有）；
  改为监听 `tauri://resize`（`electron/shell/windows.ts:195` 在 BrowserWindow resize 时发，Tauri 原生也发）后重查
  `isMaximized`，连续 resize 时同一时刻只有一次查询在途、其间的事件合并为一次补查；卸载时（含监听注册完成前卸载）取消监听。
  event-emit 基线删去这两条（35 条，0 new / 0 stale）。新测试 3 条改前全红（没有 resize 监听）、改后 3/3。
- 门禁（INT 仍为 1d1fdb78，无需再合）：boundaries 0 违规；frontend-invoke、event-emit、ui-boundaries、hardcoded-copy（1702）、
  import-cycles、plugin-manifest 均 0 new / 0 stale；rust-fixes 103 条（approved 92、proposed 11）0 错误；portability 0 new；
  contracts:check OK；check-i18n 跨语言缺键 0；`bin/heavy npx tsc --noEmit` 两个 tsconfig 均 0 错误（host 首跑报
  host-test-setup.mjs 缺声明 TS7016，补 .d.mts 后 0）。bin/heavy 单跑：前端 4 文件 16/16、D3 三文件 26/26、
  WindowControls 相邻契约 6 文件 22/22；host（带 HTTP_PROXY/no_proxy 启动）7 文件 43/43、event-emit.test 12/12。
