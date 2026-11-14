# W28 进度：Linux 红测清零（第一轮）

分支 `assault/W28-linux-red`，起点 INT `6c491e6f`，13:30 合入 INT `fe5feb68`（`d6feb2af`），总表状态按新 INT 复测。输入：服务器 INT `1fcc7743` 的 host 全量（14 例）和前端全量（12:52 回传，48 例 + 3 个文件级失败）、本机旧前端清单 `int-751e5990-fe.json`（35 例）、本机 INT 上 17 例 `missing <UiKernelProvider>`。`1fcc7743` 是 `6c491e6f` 的祖先。

## 归属结论

按 WAVE2-BRIEF §6 和 INTEGRATION-NOTES 12:20/12:45 的补充逐条核对：失败清单里的每个测试文件和根因所在的产品文件都在某条 lane 的路径内（前端测试 `tests/vitest/**`、`src/**` 默认归 W09；`src/ui-plugins/testing/**` 归 W16；`host/platform/util/**` 归 W14；`electron/**` 归 W06；`host/e2e/differential/**` 归 W13；`examples/**` 归 W27；`agent-workspace/**` 归 W02/S01）。**本轮没有归 W28 直接修的文件**，全部写成交接；交接附在本机验证过的补丁，见下文「交接」。

## 总表

分类：A = INT 上已修好；A' = 已在暂存分支 `int/stage-1245`（第四批）修好，待合入；E = 环境或平台相关；P = 产品缺陷；T = 重构后测试过期（含基线就红）。

### host（服务器 INT 1fcc7743，14 例）

| # | 测试 | 分类 | 根因 | 负责 | 处理 / 状态 |
|---|---|---|---|---|---|
| H1 | `host/platform/util/tests/entries.test.ts` PENDING_IMPORTERS | A | 棘轮清单已在 `fd621db5` 清空 | W14 | INT 6c491e6f 本机 6/6 通过 |
| H2 | `host/platform/util/tests/sse-buffer.test.ts` `…_is_linear` | P | `host/platform/util/sse-buffer.ts:194-195` 每个 chunk 都对整个 `textBuffer` 和全部 `pendingLines` 重新算 UTF-8 字节数（Rust `String::len()` 是 O(1)）；`:211` 的 `indexOf` 每次把拼接出来的 cons string 拍平。实测输入翻倍耗时 ×4–×6：500/1000/2000/4000 份 → 90/335/1919/7830 ms。服务器满载时 50.7 s 超时 | W14 | 交接 W14-1（补丁已验证：同输入 7/7/13/25 ms，util 测试 161/161） |
| H3 | `agent-workspace/tests/local-shell-git-contribution.test.ts` RLIMITs | A / E | 测试命令 `ulimit -u` 是 bash 写法；服务器 `/bin/sh` 是 dash，报 `/bin/sh: 1: ulimit: Illegal option -u`（JSON 原文），退出码 2。产品侧 Linux 走 `prlimit`（`host/platform/native/sandbox/index.ts:28`），无问题。不是 NPROC 耗尽：14 例的消息里没有 EAGAIN / fork 失败 | W02（测试）/ S01 | A（INT `fe5feb68`）：W02 `4ec53a7b` 改为 Linux 读 `/proc/self/limits`（bwrap 有 `--proc /proc`，`shell-sandbox.ts:446`）。本机 12/12 通过；Linux 需服务器验证 L1 |
| H4 | `backup/tests/migration-diagnostic.test.ts` X1 5000ms | — | W08 本轮在查 | W08 | 不处理 |
| H5 | `electron/tests/third-party-notices.test.ts` runtime closure | E（测试只在 darwin 成立） | `electron/tests/third-party-notices.test.ts:83-84` 写死 `{ platform: 'darwin', arch: process.arch }`，要求 lock 里 darwin 的可选原生包都已安装；Linux `npm ci` 不装 `@lancedb/lancedb-darwin-x64`（JSON：`node_modules/@lancedb/lancedb-darwin-x64: expected false to be true`）。与 sqlite 绑定无关。本机 darwin-arm64 通过 | W06 | 交接 W06-1 |
| H6 | `storage-mobile/tests/storage-entries.test.ts` | A | 棘轮清单已在 `fd621db5` 收敛 | W14 | INT 本机 4/4 通过 |
| H7 | `host/e2e/differential/g3-normalize.test.ts` | T | 主代理 `3c8f35f7` 批准 N-014/N-015 后，`g3-normalize.test.mjs:146` 的已批准快照没跟着改 | W13 | A（INT `fe5feb68`）：W13 `84f1d71b` 补上 N-014/N-015，`982241b9` 批准 N-016/N-017 时同时追加到 `:146`。本机 1/1 通过 |
| H8 | `scripts/electron-migration/contracts/community-web-search-example.test.ts` | T | 内核要求插件包 `package.json` 带 `deepStudent` 清单（`host/kernel/profile.ts:221` / `manifest.ts:158`），示例没有 → `loadProfile` 返回 `degraded: MANIFEST_MISSING`，`webSearch` 未提供 | W27（示例）/ W09（测试文件） | W27 `063b3c5d`（未合入）加了 `package.json`，但**删掉了**这个测试用的两个 profile，并改为 v1 不允许同 id 覆盖。W27 合入后此测试会换成 ENOENT 继续红。INT `fe5feb68` 上仍红（`doSearch` 未定义）。交接 W09-3；W27 在 `examples/W27-PROGRESS.md` 里也建议退役 |
| H9 | `chat-pipeline/tests/execution-runtime-production.test.ts` learner profile | A | `fd621db5` 已把 `it.fails` 翻成 `it` | W02 | INT 本机 8/8 通过 |
| H10–11 | `host/plugins/llm/tests/portable-entry.test.ts`（redact.ts 两条边） | A | 棘轮边已删 | W05 | INT 本机 5/5 通过 |
| H12 | `scripts/electron-migration/gate-checks/frontend-invoke.test.ts` real tree | E（负载） | 单跑门禁 6.5 s（解析 2721 个文件，热点是读文件和 TS 解析）；服务器满载 66.5 s，超过 30 s 默认超时。无平方级行为 | W09 | W09 在查；建议见交接 W09-4 |
| H13–14 | `agent-workspace/tests/shell-resource-limits.test.ts` 两条 | A / E | 同 H3：`ULIMITS = 'ulimit -t; ulimit -f; ulimit -u'`（`:8`）在 dash 下失败，两条用例都跑这条命令 | W02 / S01 | 同 H3（本机 7/7 通过） |

### 前端

服务器 INT `1fcc7743` 前端全量：48 例失败 + 3 个文件级失败（`vitest-fe.json`）。逐个在本机 INT 上单文件复现（`6c491e6f` 和 `fe5feb68` 各一次）：32 例与 F1–F3 一一对应；F4 三例在服务器上是绿的；其余 16 例 + 3 个文件级失败见 F5–F8。旧清单里的 `token-budget`、`katexSandboxCssData` 已在 INT 修好。INT `fe5feb68` 上本机仍红的共 36 例：F1–F3 的 32 例 + F6 1 例 + F7 3 例。

| # | 测试 | 分类 | 根因 | 负责 | 处理 / 状态 |
|---|---|---|---|---|---|
| F1 | `src/components/sidebar/__tests__/SessionRow.test.tsx`（5）、`tests/vitest/modernSidebarSessionIndicators.test.tsx`（2）、`tests/vitest/modernSidebarSuperSession.test.tsx`（6） | T（基线就红） | `ModernSidebar.tsx:343` `useSlot('nav')` 在无 Provider 时抛错（`src/ui-kernel/react.tsx:41`）；测试裸 `render(<ModernSidebar/>)`。基线 21c9d808 上同样 17 例失败（已在基线快照上实跑确认），三者自基线起都没改过。生产上 `ModernSidebar` 只经 `App` 渲染，`App` 只出现在 `main.tsx:382` 的 `<UiKernelProvider>` 里；两个轻量窗口（pomodoro-mini、quick-assistant）和恢复/启动壳的导入闭包里都没有它 → 不是产品缺陷，修测试 | W09 | 交接 W09-1：改用已有共享助手 `src/ui-plugins/testing/render.tsx`（W16） |
| F2 | `tests/vitest/flashcards/FlashcardsApp.mobile.test.tsx`（4） | T（基线就红） | 同 F1，抛错点是 `src/components/layout/MobileSidebarNavigation.tsx:64` `useSlot('nav')`；它同样只经 `App` 可达 | W09 | 同 W09-1 |
| F3 | 源码契约测试 15 例（12 个文件，20 条断言，见 W09-2） | T（基线就红） | 测试按文本读取 `App.tsx`、`ModernSidebar.tsx`、`Settings.tsx`、`MobileSidebarNavigation.tsx`，断言的代码已在服务器侧 U1–U4 插件化时搬走：逐视图的壳层配置进了 `src/ui-plugins/official/shell/index.ts` 的 `views`/`nav` slot，设置分区进了 `official/settings/sections.tsx`。新旧取值与 `src/ui-plugins/ACCEPTANCE.md:228-231` 和 shell golden 一致，不是产品缺陷 | W09 | 交接 W09-2（补丁已验证：12 文件 65/65；改坏官方配置的 7 处后对应 9 条用例全部变红） |
| F4 | `src/ui-plugins/testing/legacy-boot-evidence.test.ts`、`official/settings/__golden__/sidebar-evidence.test.ts`、`official/shell/__tests__/legacy.evidence.test.ts` | E（仅本机） | `git show <sha>:…` 读快照之前的服务器历史（`e3039571`、`7f915ae5`、`d3943bae`），本机仓库是快照、没有这些对象。服务器 landing 工作树有完整历史 | W16 / W09 | 已确认：服务器前端全量里这三个文件全部通过，L3 关闭 |
| F5 | `tests/vitest/generative-ui/markdownBlock.test.tsx`（1） | A | 源码契约读的字符串已搬走；INT `fe5feb68` 改了测试 | W09 | 本机 18/18 通过 |
| F6 | `tests/vitest/generative-ui/generativeUISotaAcceptance.contract.test.ts:281`（1） | T | W18 `690b91e2`（FE-B6）把 `src/features/generative-ui/blocks/index.ts` 的单行 `generativeUIRegistry.register({ ...config, component: components[config.type] })` 拆成 `const contribution = …; generativeUIRegistry.register(contribution); genuiComponentContributions.announce(contribution);`（`:45-49`），行为不变 | W09 | 交接 W09-5（补丁已验证） |
| F7 | `src/ui-kernel/__tests__/community-example.test.tsx`（3） | T | W01 `0efd763b` 清单 v1 要求顶层 `engines.deepStudent`（`host/kernel/manifest.ts:185-186`），示例 `examples/plugins/community-word-of-day/package.json` 还是旧写法 → `loadProfile` 返回 `MANIFEST_INVALID: /engines/deepStudent is required`（本机临时探针确认），UI 清单里没有这个插件 | W27 / W17 / W09 | W27 已在 `examples/W27-PROGRESS.md` 写好整条交接。三处要同批合入：W27 迁移示例、W17 `bdd76587`（测试从示例 meta 取 id，在 W17 分支、未进 INT）、W09 根 `vitest.config.ts` 加 `@deepstudent/ui` 别名。只合 W27 时，本机试过会变成导入失败（`Cannot find package '@deepstudent/ui'`）。见 MAIN-2 |
| F8 | 服务器独有 11 例 + 3 个文件级（见下表） | E（负载） | 本机 INT 上单文件全部通过；用 Linux 的 jsdom userAgent 再跑也全部通过（见 F8 说明）。服务器同一轮有 22 个通过的用例超过 8 s，最长 266 s | W09 / W16 | 不改测试；服务器上复跑见 L6，`editorExtensions` 见 L5 |

F8 明细（服务器耗时，失败形态）：

| 测试 | 服务器失败形态 | 判断 |
|---|---|---|
| `src/ui-plugins/testing/__tests__/evidence/debugPanels.golden.test.tsx`（2） | 第一条 `beforeEach` 10088 ms 超时；第二条随后报 `command "nav.goto.chat-v2" is already registered` | 超时后上一条的内核没 dispose，第二条是连带 |
| `src/ui-kernel/__tests__/bootstrap.test.ts`（2） | 第一条 7792 ms 超时；第二条同样的重复注册连带 | 同上 |
| `tests/vitest/chat-v2/components/AttachmentUploader.test.tsx`（1） | `beforeEach` 10082 ms 超时 | 超时 |
| `src/features/workbench/agent/__tests__/todoFinderDriver.test.ts`（1） | 8987 ms 超时 | 超时 |
| `finderMenu` / `workbenchMenus` / `dashboard` `.golden.test.tsx`（文件级） | 全部用例 skipped、无消息 | `beforeAll`（`bootAppUi()`）失败的形态；本机单跑 1.5–3.7 s |
| `tests/vitest/flashcards/TodayScreen.learnMore.test.tsx`（1） | 1733 ms，`startBatchSession` 未被调用 | `waitFor` 默认 1000 ms 到时 |
| `src/components/ui/app-menu/AppMenu.keyboard.test.tsx:139`（1） | 145 ms，焦点落在菜单容器而非 `Beta` | 本机把 rerender 后的等待从 10 ms 临时改成 50/200/1000 ms 都通过，产品里没有延迟的焦点重置；判断为负载下打开菜单时的焦点时序 |
| `src/features/mindmap/utils/layout/__tests__/layoutDescendants.perf.test.ts`（1） | cached-cold 396 ms > 80 ms 阈值 | 性能阈值，负载 |
| `src/ui-plugins/testing/__tests__/evidence/editorExtensions.golden.test.tsx`（2） | golden 不等（11113 ms / 4483 ms），JSON 里没有 diff | 本机、Linux userAgent、`taskpolicy -b` 降速三种跑法都通过；`src`、`tests` 4539 个文件的导入大小写扫描 0 处不一致。原因未定，需要服务器上的实际产物，见 L5 |

F8 说明：jsdom 默认 userAgent 带宿主的 `process.platform`（`Mozilla/5.0 (darwin) …` / `(linux) …`），`src/utils/platform.ts:19-31` 按 userAgent 判定，所以同一个测试在 macOS 上 `getPlatform()` 是 `windows`（落到默认值），在 Linux 上是 `linux`（本机临时探针确认两种取值）。这不是这次任何一例失败的原因（上表 11 个文件用 Linux userAgent 都通过），但它让本机和服务器跑的是不同分支，见交接 W09-6。

## 交接

补丁都放在 `/Users/heli/der/tmp-58068a80b38aa6d0/.reports/W28-handoffs/`（不进仓库）。都已在 W28 工作树里实际应用、跑绿后撤回；合入 INT `fe5feb68` 后 5 个补丁都重新做过 `git apply --check`，全部通过。三个前端补丁（W09-1、W09-2、W09-5）在 INT `fe5feb68` 上一起应用：18 个文件 89/89 通过。

### W09（含 W16 一处）

- **W09-1 前端 17 例 `missing <UiKernelProvider>`**：补丁 `W16-W09-official-ui-render.patch`。
  - `src/ui-plugins/testing/render.tsx`（W16）新增共享助手 `officialUiRender()`：在 `beforeAll` 里装一个带全部官方插件的内核，`afterAll` 里 `cleanup()` 并 dispose；返回包了 `<UiKernelProvider>` 的 RTL `render`（`rerender` 沿用同一 wrapper，调用方自带的 `wrapper` 包在里面）。
  - `src/ui-plugins/testing/render.test.tsx`（W16）加一条用例：初次渲染和 rerender 用同一个内核，`useSlot('nav')` 非空，调用方 wrapper 保留。
  - 4 个测试文件（W09）只改两处：从 `@testing-library/react` 的导入里去掉 `render`，加 `const render = officialUiRender();`。断言一行未动。做法与已有的 `tests/vitest/modernSidebarNavigation.test.tsx:15-21`、`MobileSidebarNavigation.dedup.test.tsx:21-27` 相同，只是抽成了助手。
  - 应用：`git apply .reports/W28-handoffs/W16-W09-official-ui-render.patch`
  - 验证：`DEEP_STUDENT_BUILD_NUMBER=20000 npx vitest run -c vitest.config.ts src/components/sidebar/__tests__/SessionRow.test.tsx tests/vitest/modernSidebarSessionIndicators.test.tsx tests/vitest/modernSidebarSuperSession.test.tsx tests/vitest/flashcards/FlashcardsApp.mobile.test.tsx src/ui-plugins/testing/render.test.tsx --maxWorkers=2` → 本机 5 文件 19/19 通过（原 17 例失败）；其他用到该助手的测试 `modernSidebarNavigation`、`MobileSidebarNavigation.dedup`、`official-install` 共 61/61 通过；eslint 0 错误（`modernSidebarSuperSession.test.tsx:206` 有一条既有 warning）。
- **W09-2 源码契约测试 15 例**：补丁 `W09-source-contracts-data-driven-shell.patch`（12 个测试文件 + 新增 `src/app/__tests__/officialShellEntries.ts`）。
  - 定位方法：把这 12 个文件临时改成 `expect.soft` 跑一遍，拿到全部失败断言（不止每条用例的第一条），一共 20 条；这些用例里其余断言都还成立，补丁不碰它们。
  - 新助手 `readOfficialShellEntries()` 用真实内核和生产安装器（`createOfficialUiTestKernel`）读 `views`/`nav` slot；`shellViewsWhere()` 返回满足条件的视图 id。每条过期断言换成两条：App 里的消费者表达式（仍用 `readAppShellSource()` 读），以及官方配置里的取值。
  - 逐条（行号为 INT `6c491e6f`）：

    | 测试:行 | 旧断言 | 新断言 |
    |---|---|---|
    | `desktopPageShellSidebarContract:13` | `shouldShowDesktopPageBackButton = currentView === 'learning-hub'` | App `= activeShell?.pageBackButton ?? false`（`App.tsx:1075`）；`pageBackButton` 为 true 的视图恰好是 `['learning-hub']`，且其 `sidebarKind` 为 `desktop-page` |
    | `desktopShellSidebarCollapseContract:106-107` | `desktopShellSidebarKind = currentView === 'settings' … : currentView === 'todo'` | App `= activeShell?.sidebarKind ?? 'main'`（`:1116`）；settings→`settings`、todo→`todo`、learning-hub→`desktop-page`，其余视图都是 `main` |
    | `desktopShellSidebarCollapseContract:161`、`settingsSingleSidebarLayoutContract:8` | 同上 | 同上 App 表达式；settings 的 `sidebarKind` 为 `settings` |
    | `desktopShellSidebarCollapseContract:169` | Settings 导入 `./useSettingsNavigation` | Settings 导入 `settingsNavigation`（`@/ui-plugins/official/settings/navigation`，`Settings.tsx:47`） |
    | `settingsDesktopHeaderControlsContract:14` | `isShellSidebarView = currentView === 'settings' \|\| currentView === 'todo'` | App `= activeShell?.sidebarOwnsBackNavigation ?? false`（`:1157`）；为 true 的视图恰好是 `['settings', 'todo']` |
    | `settingsDesktopHeaderControlsContract:22` | `shouldShowDesktopSidebarToggle = currentView !== 'settings' \|\| leftPanelCollapsed` | App `= !activeShell?.hideExpandedSidebarToggle \|\| leftPanelCollapsed`（`:1158`）；为 true 的视图恰好是 `['settings']` |
    | `learningHubGlobalHeaderContract:13` | App 含 `'learning-hub-toolbar'` | App 含 `data-shell-slot={activeShell.toolbarSlot}`（`:1573`）；learning-hub 的 `toolbarSlot` 为 `learning-hub-toolbar` |
    | `uiStyleLabContract:20-21` | ModernSidebar 含 `'ui-lab'`；App 含 `renderViewLayer('ui-lab'` | nav 里 ui-lab 条目：`labelKey`、桌面 `primary`、仅 `uiLabEnabled` 时可见；ModernSidebar 读 `nav` slot；views 里 ui-lab 的 `contentKey` 为 `styleDebugContent`，App 的 `viewContents` 含它，并按 `contentKey` 渲染（`:1412-1422`） |
    | `sandboxNavigationContract:28` | App 含 `renderViewLayer('sandbox-workbench'` | views 里 sandbox-workbench 的 `contentKey` 为 `sandboxWorkbenchContent`，`viewContents` 含它，并按 `contentKey` 渲染 |
    | `modernSidebarIconContract:10-11` | `<Icon className="size-[18px]" strokeWidth={2} />`、`<StudySettingsIcon …>` | ModernSidebar 两处 `renderNavigationIcon(…, { className: 'size-[18px]', strokeWidth: 2 })`（`:899`、`:1449`）；`renderNavigationIcon` 原样透传 props；nav 里设置项的图标是 `StudySettingsIcon`。原有两条「选中态不改描边」的负向断言保留 |
    | `archiveSessionToastNavigationContract:20` | Settings 含 `tabTarget={dataGovernanceTabTarget}` | Settings 的 props 表含 `'data-governance': () => ({ tabTarget: dataGovernanceTabTarget })`（`:1358`），`sections.tsx:46` 把它传给 `<DataGovernanceDashboard>` |
    | `mobileReachabilityContract:120` | MobileSidebarNavigation 含 `MOBILE_APP_LAUNCHER_VIEWS` | MobileSidebarNavigation 按 `mobile.placement === 'launcher'` 取启动器项（`:76`）；nav 里启动器项含 `data-management`、不含 `dashboard` |
    | `migrationFoundation.source:170` | MobileSidebarNavigation 导入 `@phosphor-icons/react` | 它已不直接导入任何图标库，图标来自 nav 条目。改为：它仍禁止 lucide、必须经 `renderNavigationIcon` 渲染；Phosphor 要求移到声明官方 nav 图标的 `official/shell/index.ts` |
    | `platformPerformanceConfig:128` | Settings 含 `React.lazy` | Settings 从 `settings.sections` slot 取分区（`:166`），懒加载在 `official/settings/sections.tsx` |

  - 同一根因顺带修的：`mobileReachabilityContract` 的抽屉桶原来从 `src/config/navigation.ts`（`createNavItems` 字面量 + `MOBILE_APP_LAUNCHER_VIEWS`）解析。**这个文件在产品里已经没有任何引用**，可达性断言实际在检查死代码。补丁改成从官方 `nav` slot 取全部条目的 `viewId`，覆盖面与原来相同（原来也按字面量把 ui-lab 算进去）。
  - 没改、留给 W09 决定：`uiStyleLabContract:18-19` 仍断言 `src/config/navigation.ts`，现在能过但检查的是死代码。删除该文件时这两行要一起删；它们的意图已由补丁里的 nav slot 断言覆盖。
  - 原来空转的负向断言（例如 `desktopPageShellSidebarContract:24` 的 `not.toContain("currentView === 'learning-hub' || currentView === 'template-management'")`）现在由「`desktop-page` 只有 learning-hub」「`pageBackButton` 只有 learning-hub」两条配置断言实际覆盖。
  - 不需要改 `config/app-shell-sources.json`：它登记的是从 App 原样搬出的模块，`official/shell/index.ts` 是改写成数据，不是原样搬出。
  - 应用：`git apply .reports/W28-handoffs/W09-source-contracts-data-driven-shell.patch`
  - 验证：`DEEP_STUDENT_BUILD_NUMBER=20000 npx vitest run -c vitest.config.ts tests/vitest/desktopPageShellSidebarContract.test.ts tests/vitest/desktopShellSidebarCollapseContract.test.ts tests/vitest/modernSidebarIconContract.test.ts tests/vitest/uiStyleLabContract.test.ts tests/vitest/learning-hub/learningHubGlobalHeaderContract.test.ts tests/vitest/mobile-uiux/mobileReachabilityContract.test.ts tests/vitest/settings/archiveSessionToastNavigationContract.test.ts tests/vitest/settings/settingsDesktopHeaderControlsContract.test.ts tests/vitest/settings/settingsSingleSidebarLayoutContract.test.ts tests/vitest/sandbox/sandboxNavigationContract.test.ts src/components/ui/__tests__/migrationFoundation.source.test.ts src/features/workbench/core/__tests__/platformPerformanceConfig.test.ts --maxWorkers=2` → 本机 12 文件 65/65 通过（应用前 15 例失败）。反向检查：在 `official/shell/index.ts` 里改坏 7 处（todo 侧栏类型、learning-hub 返回按钮与工具栏槽、settings 折叠开关、两个 `contentKey`、数据管理的启动器位置、设置图标、ui-lab 可见性），对应 9 条用例全部变红，恢复后变绿。eslint 0 错误；只含这些文件的临时 tsconfig 跑 `tsc` 0 错误（项目 tsconfig 排除了测试文件）。
- **W09-3 `scripts/electron-migration/contracts/community-web-search-example.test.ts`**：W27 `063b3c5d` 合入后，这个测试读的 `examples/plugins/community-web-search/profiles/{official,community}.profile.json` 已删除，同 id 覆盖在 v1 下也被拒绝（W27 提交说明）。W27 的新测试 `examples/plugins/community-web-search/__tests__/web-search.test.ts` 已覆盖这个示例，但它只在 `examples/vitest.config.ts` 下运行，服务器 land-test 只跑 host 和前端两个配置。改法二选一：（a）删除 `scripts/electron-migration/contracts/community-web-search-example.test.ts`，并让主代理把 `npx vitest run -c examples/vitest.config.ts` 加进服务器全量；（b）把它改写成按 W27 新 profile（`examples/plugins/community-web-search/test.profile.json`）加载、断言 `exampleWebSearch` 与官方 `webSearch` 并存。验证：`DEEP_STUDENT_BUILD_NUMBER=20000 npx vitest run -c vitest.host.config.ts scripts/electron-migration/contracts/community-web-search-example.test.ts`。在 W27 合入前，现在的失败原因是 `loadProfile` 返回 `degraded: [{ id: 'dstu.browser', reason: 'MANIFEST_MISSING: package.json has no "deepStudent" manifest' }]`（本机临时调试确认）。
- **W09-4 `frontend-invoke.test.ts` real tree 超时**：单跑 `node scripts/electron-migration/gate-checks/frontend-invoke.mjs --check` 6.5 s（user 5.0 s），2721 个文件各读一次、无重复读；热点是读文件（1.5 s）和 `ts.createSourceFile`。src 下约 3878 个 ts/tsx 只有 534 个含 `invoke` 字样。建议：`frontend-invoke.mjs:122` 先按文本预筛（文件不含 `invoke`、也不含已知封装名时跳过解析）；或把 real-tree 用例留给门禁命令本身，vitest 里只保留合成树用例。不要拉长超时。
- **W09-5 `tests/vitest/generative-ui/generativeUISotaAcceptance.contract.test.ts:281`**：补丁 `W09-genui-sota-registration-contract.patch`（15 行）。把过期的单行字符串换成 `blocks/index.ts:45-49` 现在的三行：`const contribution = { ...config, component: components[config.type] };`、`generativeUIRegistry.register(contribution);`、`genuiComponentContributions.announce(contribution);`。同一条要求里其余 6 个字符串不动。验证：`DEEP_STUDENT_BUILD_NUMBER=20000 npx vitest run -c vitest.config.ts tests/vitest/generative-ui/generativeUISotaAcceptance.contract.test.ts` → 4/4（应用前 1 例失败）；临时删掉产品里的 `announce` 那行后变红，恢复后变绿。
- **W09-6 jsdom userAgent 跟着宿主变**（建议，不是这次失败的原因）：`vitest.config.ts` 的 `test` 里加 `environmentOptions: { jsdom: { userAgent: '<固定值>' } }`，让 `getPlatform()` 在 macOS 和 Linux 上取同一个值。现在本机是 `windows`、服务器是 `linux`，平台分支在两边各测一半。改之前要在两边各跑一次前端全量，因为现有测试可能依赖本机的 `windows`。由 W09 和主代理决定。

### 主代理（合入批次）

- **MAIN-2 `src/ui-kernel/__tests__/community-example.test.tsx`（F7）**：W27 的示例迁移、W17 `bdd76587`、W09 的 `@deepstudent/ui` 别名（`vitest.config.ts` alias，W27 交接里给了写法）放进同一批。只合其中一部分，这个测试都会继续红：只合 W27 时是导入失败，不合 W27 时是清单被拒。另外 W27 建议把 `examples/vitest.config.ts` 加进服务器全量和 CI，`community-web-search-example`（H8、W09-3）也依赖这一项。

### W14

- **W14-1 `SseEventBuffer` 平方级**：补丁 `W14-sse-buffer-linear.patch`，只改 `host/platform/util/sse-buffer.ts`。
  - 维护 `textBufferBytes`、`pendingSize` 两个计数器：追加时加上新解码文本的字节数，切掉已处理前缀时减去那一段，`pushLine` 和 `flushPending`、`clear`、`flush` 同步维护。替换 `:194-195` 每次的全量 `byteLength`。和 Rust `String::len()` 一样是 O(1)。解码器只吐完整字符、切点在 `\n` 之后，所以累加值与原来的全量重算相等。
  - 新文本里没有 `\n` 且之前的内容都已扫描过时直接返回，不在拼接出的长字符串上 `indexOf`（否则每次都会把它拍平复制一遍）。
  - 实测（4000 份约 444 KB，按 17 字节切块）：7830 ms → 25 ms；500/1000/2000/4000 份分别为 7/7/13/25 ms，线性。
  - 验证：`DEEP_STUDENT_BUILD_NUMBER=20000 npx vitest run -c vitest.host.config.ts host/platform/util/tests/ --maxWorkers=2` → 19 文件 161/161 通过。行为不变、超时阈值和断言都不动，不需要 RF。
  - 附带：`SseLineBuffer.processChunk`（`:129-152`）每块也对整个缓冲区 `byteLength` 和 `split`。Rust 的 `lines()` 也是整块重扫，属于 Rust 原样；目前没有测试暴露，先不动。

### W06

- **W06-1 `electron/tests/third-party-notices.test.ts` 在 Linux 上失败**：补丁 `W06-third-party-notices-host-target.patch`。
  - 根因：`:83-84` 写死 `{ platform: 'darwin', arch: process.arch }`，再要求 lock 里 darwin 的原生包全部已安装。打包闭包是按已安装的树算的，npm 只装本机 os/cpu/libc 匹配的可选包。本机复现了同一机制：把目标换成本机没装的 darwin-x64，缺失的第一项正是 `node_modules/@lancedb/lancedb-darwin-x64`，与服务器报错一致。
  - 改法：测试对照本机目标 `hostTarget = { platform, arch, libc? }`（Linux 用 `process.report` 的 `glibcVersionRuntime` 判断 glibc 或 musl）。`scripts/licenses/shipped-npm-packages.mjs` 的 `matchesAnyTarget` 和 `electron/scripts/node-modules-closure.cjs` 的 `platformMatches` 支持可选的 `target.libc`，省略时行为不变，所以 `RELEASE_TARGETS`、notices 内容和打包都不变。测试另加一组合成 lock 断言 libc 过滤（去掉库改动时这条会红，已确认）。
  - 为什么要处理 libc：lock 里 `@lancedb/lancedb-linux-x64-musl`、`@node-rs/argon2-linux-x64-musl`、`@napi-rs/keyring-linux-x64-musl` 带 `libc: ['musl']`，glibc 上 npm 11 不会装它们；只换成 `process.platform` 的话，服务器上仍会红。
  - 归属：`scripts/licenses/**` 不在 §6 任何一行，但这是 W06 `c8b67515` 建的，与测试一起交 W06。
  - 验证：本机 `DEEP_STUDENT_BUILD_NUMBER=20000 npx vitest run -c vitest.host.config.ts electron/tests/third-party-notices.test.ts electron/tests/node-modules-closure.test.ts` → 11/11 通过；Linux 见 L2。

### W13 / 主代理

- **MAIN-1 `g3-normalize.test.mjs:146`**（12:55 复查：`int/stage-1245` 已照此处理，留作记录）：已批准规则的快照是写死的列表。W13 `84f1d71b`（已在暂存分支）补到 N-015。第四批合入时如果按 12:20 节把 N-016、N-017 的 `decision` 改成 approved，同一提交里要把这一行改成 `[…, 'N-015', 'N-016', 'N-017']`，否则这条测试会再红。验证：`DEEP_STUDENT_BUILD_NUMBER=20000 npx vitest run -c vitest.host.config.ts host/e2e/differential/g3-normalize.test.ts`。

### W02 / S01

- H3、H13、H14 已由 W02 `4ec53a7b` 修好（已在 INT `fe5feb68`）。建议补一项前置条件，不放宽断言：沙箱用例开跑前按 `/proc/*/status` 统计当前真实 UID 的线程数（`Uid:` 第一列等于 `process.getuid()` 的进程，累加 `Threads:`）。离 2048 太近（比如超过 1900）时直接抛出「前置条件不满足：UID n 已有 k 个任务，RLIMIT_NPROC=2048 按 UID 计数」，不要让 fork 失败伪装成产品错误。本次 JSON 里没有出现 EAGAIN，这一项不是本次红的原因，由主代理决定做不做。

## 需要在 Linux 服务器上验证

- **L1**（INT `fe5feb68` 已含 W02 `4ec53a7b`，可以直接跑）：`DEEP_STUDENT_BUILD_NUMBER=20000 npx vitest run -c vitest.host.config.ts host/plugins/agent-workspace/tests/shell-resource-limits.test.ts host/plugins/agent-workspace/tests/local-shell-git-contribution.test.ts`。同时记录 `ls -l /bin/sh`（预期指向 dash）和 `ps -eLo uid= | awk -v u=$(id -u) '$1==u' | wc -l`（当前 UID 的线程数）。
- **L2**（应用 W06-1 后）：`DEEP_STUDENT_BUILD_NUMBER=20000 npx vitest run -c vitest.host.config.ts electron/tests/third-party-notices.test.ts electron/tests/node-modules-closure.test.ts`。附 `ls node_modules/@lancedb/ node_modules/@node-rs/ | grep -E 'linux|darwin'`，确认 musl 变体是否安装。
- **L3**（已关闭）：服务器 INT `1fcc7743` 前端全量里 `legacy-boot-evidence`、`sidebar-evidence`、`legacy.evidence` 三个文件全部通过，land-test 工作树有这些历史对象。
- **L4**（应用 W14-1 后）：`DEEP_STUDENT_BUILD_NUMBER=20000 npx vitest run -c vitest.host.config.ts host/platform/util/tests/sse-buffer.test.ts`，在 G3 录制同时运行的负载下确认不再超时。
- **L5**（F8 `editorExtensions`）：golden 不等时 `harness.tsx:36-39` 会把实际值写到测试工作树的 `tests/visual/.out/evidence/`。在 `/home/dsdev/dev/landing/test-worktrees/a234a06c5632/` 下执行 `diff tests/visual/.out/evidence/editor.notes.assembly.json src/ui-plugins/testing/__golden__/evidence/editor.notes.assembly.json`（`plain` 同样）。如果工作树已经清掉，单跑一次：`DEEP_STUDENT_BUILD_NUMBER=20000 npx vitest run -c vitest.config.ts src/ui-plugins/testing/__tests__/evidence/editorExtensions.golden.test.tsx`，再按上面 diff。拿到差异就能判断是负载时序（如 `ipcOnMount`、`uses` 多出异步项）还是 Linux 差异，交 W16 / W18。
- **L6**（F8 其余）：服务器空闲时单独跑一次 F8 的 11 个文件：`DEEP_STUDENT_BUILD_NUMBER=20000 npx vitest run -c vitest.config.ts src/ui-plugins/testing/__tests__/evidence/{debugPanels,finderMenu,workbenchMenus,dashboard,editorExtensions}.golden.test.tsx src/ui-kernel/__tests__/bootstrap.test.ts tests/vitest/chat-v2/components/AttachmentUploader.test.tsx src/features/workbench/agent/__tests__/todoFinderDriver.test.ts tests/vitest/flashcards/TodayScreen.learnMore.test.tsx src/components/ui/app-menu/AppMenu.keyboard.test.tsx src/features/mindmap/utils/layout/__tests__/layoutDescendants.perf.test.ts --maxWorkers=2`。全绿则确认是 8 片并行时的负载；仍红的逐个交回本表。

## 门禁与测试（13:30–13:34，INT `fe5feb68` 合入后的 `2a64a04c`）

- 6 个 gate-checks（ui-boundaries、frontend-invoke、event-emit、hardcoded-copy、import-cycles、rust-fixes）、`boundaries.mjs`、`portability/scan.mjs --check`、`plugins/slot-snapshot.mjs --check`、`plugins/check-boundaries.mjs`：全部退出码 0，0 new、0 stale。
- `bin/heavy npx tsc --noEmit -p tsconfig.json`、`-p tsconfig.host.json`：都是 0 错误。
- 本分支只改了本文件，没有 RF、没有 `RUST-FIX` 标记；`src/version.ts` 已删除，`/tmp` 下的临时文件和临时配置都已清掉。

## 第二轮（15:17 起，INT `2be7ed80`，分诊 B 趟）

- 开工：合入 INT `2be7ed80`（合并提交 `ccab3fb9`，无冲突）。
- 分诊文档：`.reports/server/land-test-B-16w/TRIAGE.md`（不在 git 里）。v1 15:31 写完 host 6 条。
- 本机复现用的临时工作树：`/Volumes/DSWork/tmp-W28-B`（`390f244b`，node_modules 软链共享目录），交付前 `git worktree remove`。
- host 6 条结论（详见 TRIAGE）：
  - mcp-service:440 → 测试过期 + 平台差异（macOS 顺序分配临时端口掩盖了 W21 `83b49b40` 引入的 OAuth 端口差异），W21。
  - g3-inputs → 真正失败的是子测试 6（闭包边界，W05 `8c56a2ec` 引入 llm-providers/replay），INT `2be7ed80` 的 W13 v2 重写已修，本机 10/10。
  - llm-routes-b → B：固定端口 47110 与 `streaming-b` 并行冲突（真缺陷，W05+W13）；A：缺 content chunk，待服务器单跑。
  - migration-diagnostic → H4 负载，只记录。
  - boot-diagnostics → W01 `df68b5dc` 与 W06 `b93c6d75` 跨趟错位，`2be7ed80` 已修；`390f244b` 在 macOS 上也红（已复现），`2be7ed80` 本机 1/1。
  - third-party-notices → W06 `eaf234b5` 已修，本机 5/5，待 Linux。
- 下一步：fe 段 12 例分诊；W21、W13/W05 交接补丁；ci.yml + land-test.mjs examples 段（FM-06）；A/B 三栏对照；复核上一任"待验证"条目。
- 15:48 TRIAGE v2：fe 7 个文件 12 条分类完成，加了 A/B 三栏对照和上一任待验证项复核。
  - sdk.types / resource-menu.types → 真缺陷：`contracts/content.ts`、`contracts/editor.ts` 两条 `import type` 从组件/插件实现取类型，经 `ui-sdk/index.ts` 的新导出把 1350 个前端文件拉进类型测试程序；本机也约 150 s 超时。交接 W17+W18（只搬类型，1350 → 142/111，本机 18–21 s 通过，`tsc -p tsconfig.json` 0 错误）。
  - AppMenu.keyboard、debugPanelInventory → 负载（本机单跑通过）。
  - notesTreeMenu.golden ×6 → C 趟已修（W16 `12dbc1be`），`390f244b` 本机 6/6 红、`2be7ed80` 6/6 绿。
  - legacy-boot-evidence → 测试过期：W19 `d9fc4f33` 改了 12 份 boot 基线的导入名，旧来源证据测试 `:77` 必然不等；本机缺历史提交跑不了，一直被当成环境项。归 W19。
  - layoutDescendants.perf → 本机单跑也红（816 ms > 400），按 14:05 裁定是真问题；W09 `3896472e` 已修（未进 INT），临时套上后 4/4 通过。
- 交接补丁（`.reports/W28-handoffs/`，文件头写了原因、复现和验证命令）：`W21-mcp-service-fixed-port.patch`、`W13-W05-llm-port-per-run.patch`、`W17-W18-typetest-program-size.patch`。
- FM-06（主编排授权的两处）：
  - `.github/workflows/ci.yml`：`required.needs` 加 `examples`（任务 id 就是 `examples`，名字 "Community Plugin Examples"，没有 `if`、没有 `continue-on-error`，所以 CI Required 要求它成功）。js-yaml 解析通过，needs 里每一项都有对应任务。
  - `scripts/electron-migration/landing/land-test.mjs`：新增 `examples` 套件（`examples/vitest.config.ts`，与 CI 同一配置）；`--suite all` = host、fe、examples 依次跑，`--suite examples` 可单独跑；结果目录、`vitest-examples.json.zst`、`failures.txt` 的 `[examples] 文件 > 用例` 格式都沿用同一段代码。examples 只有 7 个测试文件，分片多于文件时空分片会以 "No test files found" 失败，所以总是 1 片。host、fe 的命令、分片数、并发、超时都不变（抽出 `suitesFor` / `suiteShards` / `shardCommand`，单测逐字核对 host/fe 命令）。
  - 单测 `landing.test.mjs` 新增一条：先红（旧 ci.yml → "CI Required 要等 examples 任务"；旧 land-test.mjs → 缺导出），后绿；整文件 15/15。
  - 本机端到端试跑：直接调 `landTest({ suite: 'examples', runner: 'direct', deps: 'link', removeWorktree: true, home: /Volumes/DSWork/tmp-W28-landtest })`，对 `d5b1799a`（= INT `2be7ed80` + 本分支进度提交）：1 片，完整、稳定；报告目录 `failures.txt`、`land-test.log`、`summary.json`、`version.ts`、`vitest-examples.json.zst` 齐全，`failures.txt` 是 `[examples] 文件 > 用例`；测试工作树已删除。
  - **注意**：这次试跑 examples 有 5 条红（用例 78）。把 examples 设成 CI 必过后，这些会让 CI Required 变红，直到修复进 INT：
    - 2 条确定性：W04 `c848f6ef` 把 `translateTextStream` 的 `source` 参数删了，W27 的 translation-prompt 示例和 `docs/plugins/SDK.md:274` 还传两个参数 → 交接 `W27-examples-translate-signature.patch`（本机 13/13）。
    - 2 条确定性：W17 `bdd76587`（SEC-E06）之后根上下文不能用 `ctx.ui.host` → W17 已写 `.reports/W17-handoffs/W27-host-calls-inside-a-plugin.patch`，待 W27 应用。
    - 1 条负载：community-web-search 第一条用例冷加载约 4.3–5 s，贴着默认 5 s。
- 15:55 合入 INT `1d1fdb78`（合并提交 `7c5da7d8`，无冲突），TRIAGE v3：
  - AppMenu.keyboard 改判：W18 `7cce90ac`（RF-W18-app-menu-open-focus-race）把打开菜单时的聚焦竞争当真缺陷修了，1–5 ms 帧可稳定复现；本机 `AppMenu.keyboard` + `AppMenu.openFocus` 15/15。
  - 上面 examples 5 条红里，translate 签名 2 条已由 INT `52133b05` 修好（与 W28 补丁内容相同，补丁已删除），`ctx.ui.host` 2 条已由 W27 `c1f6414c` 修好。
  - 本机在 `7c5da7d8` 上再演练 `--suite examples`：89 例只红 1 条，即 community-web-search 第一条用例。单独跑这个文件 4424 ms 过 / 5006 ms 挂，按 14:05 裁定是真问题，不是负载：装载器在用例里动态 import 官方 browser 插件（TS 可达 931 个文件），冷导入 3.4–4.5 s。交接 `W27-examples-web-search-cold-import.patch`（测试文件顶部静态导入同一模块，不改断言和超时），连跑 3 次 6/6，第一条 172–256 ms。
  - W21、W13-W05、W17-W18 三份交接补丁在新 tip 上 `git apply --check` 通过；F-B7 的 W09 `3896472e` 仍未进 INT；两个类型测试的可达文件数仍是 1351。

## 第四轮（16:04 起，INT `1d1fdb78`，分诊 C 趟）

- 开工：INT 仍是 `1d1fdb78`，本分支已含，没有合并。
- 分诊文档：`.reports/server/land-test-C-16w/TRIAGE.md`（不在 git 里）。v1 16:20 只含 host；fe 16:12 拉回，v2 16:45 补齐 fe、B→C 对比和服务器清单。
- 本机复现用临时工作树（`mktemp -d`，`1d1fdb78` / `e6729de2`，node_modules 软链共享目录），交付前已 `git worktree remove --force`。
- host 5 条（B 趟 6 条）：
  - 已转绿：g3-inputs、boot-diagnostics-host、third-party-notices（B 趟判"已在 2be7ed80 修好"的三项，Linux 上确认）。
  - 仍红：mcp-service:440（W21 补丁未合）；llm-routes-b（同样是 47110 与 `streaming-b` 时间重叠，E 趟 W05 `5d4a7039` 把两个套件串行放进一个文件，已修）；migration-diagnostic（8196 → 5224 ms，负载）。
  - 新出现：node-modules-closure:254（W08 `64d9b56d` 在随包代码 `s3_http.ts` 里 `import type` 了未声明的 `@smithy/types`；确定性；E 趟 W06 `ceb1bb51` 已声明依赖，本机 `1d1fdb78` 红、`e6729de2` 9/9）；insight-jobs:72（测试在 `fail()` 之后另一条语句里取 SQLite `'now'`，跨整秒得 59；强制跨秒可稳定复现，交接 W03）。
- fe 10 条（B 趟 12 条）：
  - 已转绿：notesTreeMenu.golden ×6（W16 `12dbc1be`）；AppMenu.keyboard（C 不含 W18 修复，属侥幸，要在 D 趟确认）。
  - 仍红：sdk.types、resource-menu.types（W17-W18 补丁未合）；debugPanelInventory（6302 ms，待服务器单跑）；legacy-boot-evidence（W16 `36c9428e` 在 W16 分支，未进 INT/E）；layoutDescendants.perf（W09 `3896472e` 未进 INT/E）。
  - 新出现：markdown.golden ×2、markdownRender.golden、toolResultDom.golden、chatPlugins.golden。W26 `a7b0562c` 挂载时不再强制 `update(true)`，滚动条元素的主题类不再被追加到末尾；413 处差异全是 class 顺序，macOS 同样红，只撤销 `a7b0562c` 即恢复。交接 W16（基线）+ W26（确认）。
- 新交接补丁（`.reports/W28-handoffs/`）：`W03-insight-jobs-second-boundary.patch`、`W16-W26-scrollarea-goldens.patch`，在 INT `1d1fdb78` 与 E 趟三份交付上 `git apply --check` 通过，打补丁后本机 insight-jobs 连跑 3 次 2/2、4 个 golden 文件 9/9。
- `W13-W05-llm-port-per-run.patch` 建议不合：W05 已用串行化修了服务器上的冲突，这份只对本机多工作树并行有用，还会让 A 录制指纹失效。
