# U3-ui-settings 实施报告

## 取证与 golden 更正

- 规格：`docs/plugins/FRONTEND-F1.md`（合入 main 后完整阅读），及 `FRONTEND.md`、UI kernel 全部实现与测试。
- 基线：`9c13dfc39`。首个 lane 提交 `767a55489` 仅含可执行旧实现取证及 JSON；生产代码未改。
- 首次取证作业 `20261104064359-88f943`：退出码 `0`，`Test Files  1 passed (1)`，`Tests  1 passed (1)`；无 `Errors` 行。
- **独立取证更正（不是修改 golden 迎合 slot）**：原 extractor 使用 TypeScript `transpileModule` 默认 ES3 target，`[...entries.values()]` 错误降级为按 `length` 读取 Map iterator，导致搜索结果被录成空数组。原 hook `useSettingsNavigation.tsx:370` 返回 `[...entries.values()]`，且项目 `tsconfig.json:3` 为 ES2022；原产品不存在空搜索索引行为。
- 更正 extractor 为 ES2022，仅补录 JSON 两个原搜索索引，其他字段不变。`legacy-extraction.test.tsx` 在真实 React `renderHook` 上执行**未改动的原 hook**，逐字段对照 extractor（desktop/mobile），独立于新插件。
- 更正交叉验证作业 `20261104065802-63e1ed`：退出码 `0`；`Test Files  1 passed (1)`，`Tests  2 passed (2)`；无 `Errors` 行。协调者自动 WIP 曾收走更正与实施混合状态；另建以纯取证提交为父的独立更正提交，并正常 merge 入本分支，保留可审计的纯取证链，不重写现有历史。
- 全部 17 tab、6 分类、19 lazy 边界、原 JSX（含每个 props 表达式/回调）、16 组 platform × breakpoint × demo × theme 输入→输出已录制。主 golden 后续测试只读。

## 实施提交与接入

- `b1a7ce816` / `3a2a6c140`：协调者自动检查点收存契约、19 lazy 引用、官方元数据和注册；`175d0cb12` 收存 slot golden 对照测试；`913bc5e2e` / `4a7d779b4` 收存运行时测试和社区覆盖隔离。
- `457628dbf`：纯取证更正提交（parent=`767a55489`）；`34b45e66e` 正常 merge，无历史重写。
- `b0c6cd4d5`：Settings 消费改造，`useSlot('settings.sections')`，不保留旧页签渲染分派。
- `dstu.ui.settings` 默认导出插件，`order=30`，通过 `ctx.ui.settings.register` 注册 17 分区，供 U1 `install.ts` glob 自动安装；没有在 Settings 内临时创建第二个 kernel。
- 组件 props 留在原 Settings 状态/回调上下文，通过逐分区工厂按需求值；inactive 分区不会调用 `getBuiltinServer()`、`Date.now()`、模型转换或加载页面。
- 官方组件保持原错误传播；社区条目（含同 id 替换的非原组件）才 lazy 加载原共享 ErrorBoundary。

## 原条件 → 新元数据

| 原条件/结构 | 新字段/消费点 | 等价性证据 |
|---|---|---|
| 17 个 `activeTab === id` 内容分支 | keyed `settings.sections` 的 `id` / `component` | golden 顺序与全部旧 JSX 的组件树、每个 props 表达式和回调逐项相等 |
| 旧导航五组平铺顺序 | `navigation.legacyGroup` + `navigation.order` | 原 `sidebarNavGroups` / `sidebarNavItems` 逐字段对照 |
| AI / 体验 / 个性化 / 扩展 / 工作流 / 数据 6 类及子项顺序 | `navigation.category` / `categoryOrder` | 分类标题 key、图标、顺序、items 完全相等 |
| 图标、文案、引导、移动描述和色彩 token | `navigation.icon`、`titleKey`、`tourId`、`mobileDescriptionKey`、`mobileAccent` | desktop/mobile 导航 golden 全字段 |
| `hidePlugins/hideShortcuts/hideWorkbench = isMobilePlatform()` | 三条目的 `visible({isMobile})` | 不以窗口宽度代替平台；窄桌面仍保留这些入口 |
| plugins 平台移动端显示 `plugins.mobile_hidden`，不 redirect | `contentVisible` + `mobileFallbackKey`，无 `redirect` | golden mobile 分支及 DOM 测试 |
| shortcuts 移动导航隐藏但深链接仍渲染 | 仅 `visible`，不设 `contentVisible` | golden 与 DOM 测试 |
| workbench 移动端无内容，effect 回到 apis | `contentVisible` + `redirect({isMobile})` | golden 各输入组合保持唯一样例重定向 |
| about 桌面独立标题，分类列表外的 footer | `desktopHeadingKey`；现有 footer 组件原样保留 | 标题 className、`!mobilePageMode`、文案 key 均不变 |
| apis 在 MCP 预览之前；shortcuts/about 在编辑模态之后 | `placement: before-preview / after-modals`（其余 main） | 预览/编辑器未搬动，页面 DOM 相对顺序保留 |
| 自动化 3 个 lazy 子组件、数据治理外层 `space-y-6` | 对应分区组件原 wrapper 与子组件顺序 | golden 渲染树逐项比对 |
| 19 个 React.lazy 工厂 | `sections.tsx` 原 19 个 lazy import | 模块归一化路径、导出名、声明顺序相同，选择测试不调用 import，payload 状态仍 -1 |
| 控件搜索独立全局顺序、同 tab/label 合并关键词 | `searchDetails.order`、原 Map 去重算法 | 原 hook 的 desktop 59 / mobile 54 搜索条目逐字段比对 |
| mobile 布局/顶栏/返回链/颜色/动画/保存及 MCP 副作用 | 原 Settings 中保持，不移入注册表 | 未更改这些实现、样式文件、IPC 或业务组件 |

## 路径与范围边界

仅写派发允许路径。`useSettingsNavigation.tsx` 原 hook 保持原样（同时是取证独立参照）；`SettingsShellSidebar.tsx` 另一个桌面外壳调用方不在本 lane 白名单，未修改，其既有官方导航行为保持不变。若 F2 要让社区新增分区也出现在该桌面侧栏，需要协调者另派该消费点，不能由本 lane 越界写入。Settings 自身的分类头、移动导航和搜索已全部读 slot。

## 验证结果（原始作业退出码与摘要）

所有重任务均经全局 job 队列，完整日志位于 `/home/dsdev/.oc-jobs/done/<job-id>.log`。`Errors` 无输出时明确写“无 Errors 行”，不将通过条目数代替退出码。

```text
初始取证：20261104064359-88f943
Test Files  1 passed (1)
Tests  1 passed (1)
[作业 20261104064359-88f943] 退出码 0
Errors: 无 Errors 行

独立原 hook 验证：20261104065802-63e1ed
Test Files  1 passed (1)
Tests  2 passed (2)
[作业 20261104065802-63e1ed] 退出码 0
Errors: 无 Errors 行

slot golden：20261104065822-3e4886
Test Files  1 passed (1)
Tests  1 passed (1)
[作业 20261104065822-3e4886] 退出码 0
Errors: 无 Errors 行

首轮类型检查（此前 npm run version:generate 退出码 0）：20261104065341-513112
[作业 20261104065341-513112] npx tsc --noEmit -p tsconfig.json --incremental --tsBuildInfoFile .lane.tsbuildinfo
[作业 20261104065341-513112] 退出码 0
Errors: 无 Errors 行；无 TS diagnostics

运行时注册/卸载/移动差异/社区错误隔离：20261104070600-7a7467
Test Files  1 passed (1)
Tests  2 passed (2)
[作业 20261104070600-7a7467] 退出码 0
Errors: 无 Errors 行

受影响目录回归：20261104070238-392559
[作业 20261104070238-392559] npx vitest run --config vitest.config.ts src/features/settings/components src/ui-plugins/official/settings --maxWorkers=2
Test Files  54 passed (54)
Tests  448 passed (448)
[作业 20261104070238-392559] 退出码 0
Errors: 无 Errors 行

主构建首轮：20261104070120-e9d095
[作业 20261104070120-e9d095] npx vite build
✓ 20651 modules transformed.
FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory
[作业 20261104070120-e9d095] 退出码 134

demo 构建首轮：20261104070120-678955
[作业 20261104070120-678955] npm run build:demo
✓ 20495 modules transformed.
FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory
[作业 20261104070120-678955] 退出码 134
```

构建首轮两者均达到默认约 4 GiB Node heap 上限；不改项目配置，另以 `env NODE_OPTIONS=--max-old-space-size=8192 <原命令>` 经队列重试并通过。首次 slot 对照失败（`20261104065341-4414eb` exit 1）揭露上述真实取证 bug；首次社区 DOM 测试（`20261104070119-f2b655` exit 1）遇到冷变换 ErrorBoundary 超过 RTL 默认 1 秒等待，测试先 import 原边界后跑真实渲染，未 mock 边界/未弱化断言。

补充复验记录：`20261104071031-ac2255` exit `2`，原始诊断均为 `TS2307 Cannot find module '@/version'`（AboutTab、SettingsAboutFooter、useAppUpdater、main）。原因是我在原验证后过早清理了自动生成文件，排队作业先于重新生成启动；不是代码类型错误，也不计通过。重新先执行 `npm run version:generate` exit `0`，再提交 `20261104071647-aae466`，最终通过如下。生成文件及 `.lane.tsbuildinfo` 均不提交。

```text
最终类型检查：
[作业 20261104071647-aae466] npx tsc --noEmit -p tsconfig.json --incremental --tsBuildInfoFile .lane.tsbuildinfo
[作业 20261104071647-aae466] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104071647-aae466.log
Errors: 无 Errors 行；无 TS diagnostics

主构建（仅提高 Node heap，不改构建配置）：
✓ built in 5m 16s
[作业 20261104071031-7e83d6] env NODE_OPTIONS=--max-old-space-size=8192 npx vite build
[作业 20261104071031-7e83d6] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104071031-7e83d6.log
Errors: 无 Errors 行

demo 构建（仅提高 Node heap，不改构建配置）：
✓ built in 5m 16s
[demo-build] warmup preloads injected into hero.html: 10
[作业 20261104071031-8fe142] env NODE_OPTIONS=--max-old-space-size=8192 npm run build:demo
[作业 20261104071031-8fe142] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104071031-8fe142.log
Errors: 无 Errors 行
```

构建保留既有警告：Browserslist 数据过旧、较大 chunk、第三方 eval、demo 配置重复 `rollupOptions`；未为消除警告越界改配置。`git diff --check` exit `0`。基线以来全部 tracked diff 仅在允许的四类路径内。

## d3943bae5 候选阶段结论（§6 裁定前）

本 lane 白名单内改造完成，golden 对照、运行时验证、受影响设置目录回归、前端类型检查、主构建、demo 构建均退出码 `0`；没有以通过测试数掩盖非零退出码。无需新增依赖。未运行浏览器截图回归，不把结构/DOM 测试冒充截图证明。U1 启动 provider/安装接入由对应 lane 负责；本 lane 已用真实 UiKernel 安装及 useSlot 消费验证。唯一跨白名单后续项是上述桌面外壳导航消费点，不在此越界修改；原官方行为不变。

## 07:30Z 架构裁定后的增量交付

§6.5 已额外授权 `src/features/settings/components/SettingsShellSidebar.tsx`。上文“桌面侧栏不在白名单”的限制属于旧候选历史，不再是当前实现范围限制。

### 改动

- `SectionContent.tsx` 改为 **仅** `entry.origin === 'builtin'` 时不插入边界。不再比较 owner id 或原组件引用；owner 仅用于 React key。
- 对齐 U1 `6bd437e73` 发布的 `UiPluginInstallOptions<C>` 签名：官方测试显式 `install(settingsPlugin, { origin: 'builtin' })`，社区显式或省略来源（省略默认 community）；golden JSON/旧取证 extractor 均未更改。
- 增强 `runtime.test.tsx`：内置安装的非静态表组件抛错仍传播到外部宿主边界；完全相同 owner、完全相同组件引用改以 community 安装即隔离；社区同官方 id 覆盖并抛错后独立兄弟插件导航仍存在。
- 新授权的 `SettingsShellSidebar.tsx` 与 Settings 一样订阅 `settings.sections`，复用已有 `settingsNavigation` 派生分类、导航、搜索；不改布局、文案、图标、回调、展开/折叠逻辑。
- 新增 `sidebar.test.tsx` 走真实 `SettingsShellSidebar` 和真实 `SettingsSidebar`：原 desktop/mobile 平台 golden 六分类、分类默认 tab、搜索跳转及 reveal、About footer；社区追加分类和搜索控制项显示，并在 unload 后消失。
- 本轮无依赖变更、无重录 golden、无重复运行 54 文件回归。

### 本轮原始验证结果

```text
[作业 20261104075857-29a3f3] npx vitest run --config vitest.config.ts src/ui-plugins/official/settings/sidebar.test.tsx
Test Files  1 passed (1)
Tests  3 passed (3)
[作业 20261104075857-29a3f3] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104075857-29a3f3.log
Errors: 无 Errors 行
```

### 当前依赖状态

该侧栏验证在当前已合入的旧 kernel 上完成，验证的是导航消费，**不代表 origin 验证已通过**。U1 origin API 已在 `ds-mig/U1-ui-boot` 的 `6bd437e73`，但当前 `main` 的 `kernel.ts` 仍是 `install(plugin, config?)` 且 `SlotEntry` 无 origin；U3 不修改/复制 U1 内核。待 C1 合入该依赖并同步 main 后，运行最小集 `runtime.test.tsx`、slot golden 对照测试、侧栏测试和前端类型检查，再补录本轮结果。新增来源隔离测试当前不宣称通过；先前 448 passed 与 build 结果仅属于原候选，不替代本轮验证。

### 中断恢复记录与本轮提交

- 已执行 `git log --oneline -20`、`git status`。本 F1 UI lane 无独立 TESTMAP（派发仅有 `dispatch/U3-ui-settings.md`，实施/验证清单在本报告）；不创建白名单外 TESTMAP。
- `756ae4cb3`：自动检查点保存 origin-only 消费、测试 builtin 安装和新增 sidebar 测试；`d0b196cab` 保存内置错误向外宿主传播的精确测试；`d89a447b0` 提交新增授权的真实桌面侧栏接入和报告。
- `git diff --exit-code d3943bae5 -- settings/__golden__/{settings.json,legacy.ts,legacy-extraction.test.tsx}`（路径展开为完整前缀执行）exit `0`：本轮未修改 golden 数据、旧实现取证或独立纠错依据。
- 恢复指令要求的 ledger 结果如下（它是 Host 总账，**没有 U3 UI 的 A/B 行，不替代 UI 回归**）：

```text
ledger: commands 1058 (A 92% B 7.2% C 0%), tests 8036 (A 78% B 0.9%); problems: commands 0, tests 0, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）
[作业 20261104080206-ca0c28] npm run migration:ledger -- --check --no-write
[作业 20261104080206-ca0c28] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104080206-ca0c28.log
Errors: 无 Errors 行
```

## 新增桌面消费者的独立旧基线补证（08:16Z）

### 精确基线、路径与时序说明

- 固定旧基线 **`d3943bae5708e92f15f2a38de4510f72b2f77ae6`**。该提交中 `src/features/settings/components/SettingsShellSidebar.tsx` 仍是未改造的 44 行版本；不读取当前已改造文件来录旧行为。
- `__golden__/sidebar-legacy.ts` 用 `git show <固定旧提交>:<路径>` 读取旧消费者和同一提交的 `useSettingsNavigation.tsx`，以 ES2022 编译并执行旧源码。原 hook 的完整导航输出逐字段核对既有 `settings.json`，既有 golden 未修改。
- `__golden__/sidebar.json` 新增独立取证：存完整旧消费者源码、基线与路径、32 组平台 × 断点 × 折叠 × 外部 sidebar-control × onBack 有无输入，对应初始转发 props、搜索/焦点/tab 修改后的转发 props、外部 open/back 回调结果。导航完整清单引用既有 `settings.json#/navigation/{desktop,mobile}`，不是重录一份新导航清单来迁就新实现。
- **时序缺口如实保留**：生产接入在 `d89a447b0` 已提交，之后才收到这条“新增消费者也须在首次改造前单独取证”的精确交接。补证独立提交 **`40480bb9c`**（协调者检查点在手动提交前收走；该提交只有 3 个新增取证文件，零生产改动）。它确实晚于 `d89a447b0`，不得宣称满足严格的“取证先于改造”时序。提交历史未改写；是否接受这份固定旧源码可复现补证，交 C1/R6 裁定。
- 补证提交之后才新增 `sidebar-props.test.tsx`，用真实 React、真实 UiKernel 和新消费者逐项比对 32 组旧输入输出；另有 `sidebar.test.tsx` 对真实末端 Sidebar 的分类/搜索/社区追加与卸载做 DOM 验证。

### 旧条件 → 新消费适配（新增授权文件）

| 旧基线源码位置 | 原行为 | 新实现 |
|---|---|---|
| `SettingsShellSidebar.tsx:19-21` | 搜索文本 `''`、焦点 `false`、内部 open `false` | 状态及 setter 原样保留 |
| 同文件 `:22`；原 hook `:77-83`、`:126-136`、`:167-175`、`:208-216` | hook 以平台隐藏 workbench/plugins/shortcuts，不以断点代替平台 | `useSlot('settings.sections')` → 现有 `settingsNavigation(...,{isMobile})`，沿用各条目 `visible` |
| 同文件 `:28-30` | 透传 isSmallScreen/globalLeftPanelCollapsed，固定 desktopMode='slot' | 3 个 props 不变，断点/折叠控制仍由原 `SettingsSidebar` 消费 |
| 同文件 `:31-39` | 搜索状态、3 份导航派生数据、activeTab/setActiveTab 转发 | 仅导航数据源改为 slot；其余状态/回调不变 |
| 同文件 `:40` | 外部 setSidebarOpen 优先，未提供时内部 setter 兜底 | 原 `setSidebarOpen ?? setInternalSidebarOpen` 不变 |
| 同文件 `:41` | 可选 onBack 原样透传 | 不变 |
| 原 hook `:229-273`、`:275-371` | 6 类顺序、子项顺序、搜索合并与移动隐藏 | 复用已通过原 golden 的同一 helper；新增官方无重复清单 |

### 最小验证原始结果

```text
[作业 20261104081605-60b8a2] npx vitest run --config vitest.config.ts src/ui-plugins/official/settings/__golden__/sidebar-evidence.test.ts
Test Files  1 passed (1)
Tests  1 passed (1)
[作业 20261104081605-60b8a2] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104081605-60b8a2.log
Errors: 无 Errors 行

[作业 20261104082157-2f62f0] npx vitest run --config vitest.config.ts src/ui-plugins/official/settings/__golden__/sidebar-evidence.test.ts src/ui-plugins/official/settings/sidebar-props.test.tsx src/ui-plugins/official/settings/sidebar.test.tsx --maxWorkers=2
Test Files  3 passed (3)
Tests  5 passed (5)
[作业 20261104082157-2f62f0] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104082157-2f62f0.log
Errors: 无 Errors 行
```

仍未将 U1 origin 依赖验证或 C1/R6 时序裁定标为通过；只新增本消费者最小回归，没有再跑 54 文件。

## 09:13Z 集成门禁失败回执与指定检查

已按最新指令 `git merge --no-edit main`，合并提交 `272652fba`。合并后的 main 仍没有 U1 origin API：`src/ui-kernel/kernel.ts:215` 仍是 `install<C>(plugin, config?: C)`，`src/ui-kernel/slots.ts:31-35` 的 `SlotEntry` 仍只有 `owner` 而无 `origin`。因此门禁中 `SectionContent.tsx TS2339` 与 3 项 origin 运行时失败是**依赖未合入**的可预期结果，不是可在 U3 范围内独立修正的类型问题。§6.2 强制用来源，不允许恢复 owner 判断、组件引用判断、类型断言/兼容默认值绕过；不复制或自行合入 U1 分支。请 C1 先正常集成 U1（origin 发布提交 `6bd437e73`，最新 U1 分支已继续前进），再集成 U3。

指定 Host 检查已原样经队列执行（不把 Host 空过滤当通过）：

```text
[作业 20261104091323-0ed779] npm run typecheck:host
[作业 20261104091323-0ed779] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104091323-0ed779.log
Errors: 无 Errors 行

boundaries: scanned 2337 files, 0 violation(s), 166 suppressed via boundary-allow; rules: native-import, tauri-import, cross-plugin-impl, electron-imports-plugin, sql-outside-repository, test-double, todo-marker, empty-catch, erasable-syntax, console-log
[作业 20261104091323-d2ea49] npm run migration:boundaries
[作业 20261104091323-d2ea49] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104091323-d2ea49.log
Errors: 无 Errors 行

No test files found, exiting with code 1
filter: src/ui-plugins/official/settings
include: host/**/*.test.ts, electron/**/*.test.ts, scripts/electron-migration/**/*.test.ts
[作业 20261104091323-1890d5] npx vitest run -c vitest.host.config.ts src/ui-plugins/official/settings
[作业 20261104091323-1890d5] 退出码 1；完整输出 /home/dsdev/.oc-jobs/done/20261104091323-1890d5.log
Errors: 无 Errors 行；但退出码 1，不计通过
```

本 lane 的测试应使用 `vitest.config.ts`（规格 §1.3），而非只包含 Host/Electron 的 `vitest.host.config.ts`；没有为通过门禁修改测试配置或加 `--passWithNoTests`。U1 依赖到位前不重复运行已知缺 origin 的 UI 门禁。

集成构建反馈仍是约 4 GiB heap 的 OOM（exit 134），不是组件编译诊断。此前本 lane 的两条 8 GiB 重试已 exit 0，原始作业 `20261104071031-7e83d6` / `20261104071031-8fe142` 见上文。集成 runner 应同样给 `npx vite build` / `npm run build:demo` 配置 `NODE_OPTIONS=--max-old-space-size=8192`，无需 U3 修改生产源码或构建配置；该 runner 不在本 lane 白名单内。

## 10:51Z U1 origin 已入 main：依赖解除后的最小续作

- `git merge --no-edit main` → `df6aa1f32`。核对：`main` 与 U1 `6bd437e73` 均为 HEAD 祖先；`src/ui-kernel/slots.ts` 的 `SlotEntry.origin`、`kernel.install(plugin, { origin })`、`react.tsx` 的 `useOptionalSlot`、`src/ui-plugins/official/install.ts` 的 builtin 安装器均已存在。
- U3 **无新的生产或测试代码改动**：此前 `756ae4cb3` / `d0b196cab` 的 origin-only 消费和测试在合入真实 U1 API 后直接通过，无需适配。golden JSON、旧实现取证与独立纠错文件本轮未触碰。
- 未再跑 Host 配置证明 UI；09:13Z 的 Host exit 1 仅为历史记录。

### 原始结果（`npm run version:generate` exit 0 后执行）

```text
[作业 20261104105529-ebf129] npx tsc --noEmit -p tsconfig.json --incremental --tsBuildInfoFile .lane.tsbuildinfo
[作业 20261104105529-ebf129] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104105529-ebf129.log
Errors: 无 Errors 行；无 TS diagnostics（门禁报的 SectionContent.tsx(23,16) TS2339 已消失）

[作业 20261104105529-df2e19] npx vitest run --config vitest.config.ts src/ui-plugins/official/settings \
  src/features/settings/components/__tests__/SettingsNavigation.integration.test.tsx \
  src/features/settings/components/__tests__/SettingsSidebar.searchKeyboard.test.tsx \
  src/features/settings/components/__tests__/settingsCategories.test.tsx \
  src/features/settings/components/__tests__/useSettingsNavigation.workbench.test.tsx \
  src/features/settings/components/__tests__/SettingsCategoryHeader.test.tsx --maxWorkers=2
  ✓ runtime.test.tsx (3 tests)   ← 门禁中 3 failed 的同一文件
  ✓ sidebar.test.tsx (3) / sidebar-props.test.tsx (1) / __golden__/sidebar-evidence.test.ts (1)
  ✓ __golden__/settings.test.ts (1) / __golden__/legacy-extraction.test.tsx (2)
  ✓ SettingsNavigation.integration (14) / SettingsSidebar.searchKeyboard (8) / settingsCategories (8)
  ✓ useSettingsNavigation.workbench (2) / SettingsCategoryHeader (7)
Test Files  11 passed (11)
Tests  50 passed (50)
[作业 20261104105529-df2e19] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104105529-df2e19.log
Errors: 无 Errors 行

U1 生产安装器与 origin 渲染（只导入、未修改 U1 testing 路径）：
[作业 20261104110141-120e1c] npx vitest run --config vitest.config.ts src/ui-plugins/testing/install.test.ts src/ui-plugins/testing/origin-render.test.tsx
Test Files  2 passed (2)
Tests  3 passed (3)
[作业 20261104110141-120e1c] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104110141-120e1c.log
Errors: 无 Errors 行

ledger: commands 1058 (A 92.8% B 5.9% C 0%), tests 8036 (A 80.5% B 1.6%); problems: commands 0, tests 0, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）
[作业 20261104105529-62bdd4] npm run migration:ledger -- --check --no-write
[作业 20261104105529-62bdd4] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104105529-62bdd4.log
```

另：`20261104105146-5e1832`（ledger）exit 1，`ENOENT host/plugins/llm-providers/src/sse-buffer.ts`。该作业在本轮 merge 前提交、读到 merge 删除的文件；merge 后重跑即上方 exit 0。不计为通过，也非 U3 改动导致。

### 仍保留的未关闭项

- 新增桌面侧栏消费者的取证晚于改造（`40480bb9c` 晚于 `d89a447b0`）：时序例外仍待架构师原裁定，本轮不因接口到齐而自行签收。
- 构建：本轮无业务改动，8 GiB 预算已在集成 runner。复验原始结果：

```text
[作业 20261104110141-bd1379] env NODE_OPTIONS=--max-old-space-size=8192 npx vite build
✓ built in 4m 50s
[作业 20261104110141-bd1379] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104110141-bd1379.log
Errors: 无 Errors 行

[作业 20261104110142-f7c11e] env NODE_OPTIONS=--max-old-space-size=8192 npm run build:demo
✓ built in 4m 57s
[作业 20261104110142-f7c11e] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104110142-f7c11e.log
Errors: 无 Errors 行
```

## 11:22Z 集成门禁 `ShadApiEditModal.codexOAuth` hook 超时回执

- `git merge --no-edit main` → `ce2297644`。
- 失败文件 `src/features/settings/components/__tests__/ShadApiEditModal.codexOAuth.test.tsx` 及其被测 `ShadApiEditModal.tsx` 均不在 U3 改动清单内（`git diff --name-only main...HEAD` 只含 Settings.tsx、SettingsShellSidebar.tsx、contracts/settings.ts 与 `src/ui-plugins/official/settings/`），被测模块也不导入这些文件。
  - 观察：门禁报 `Hook timed out in 10000ms`。该文件唯一异步 hook 是 `beforeAll` 中的 `await import('../ShadApiEditModal')`。单独运行该文件 3 tests 通过，vitest 报告的文件耗时 11.2 s；这是文件总耗时，不等于 `beforeAll` 耗时，本 lane 未测量各阶段计时。
  - 推断（未证实）：门禁并发负载下冷加载变慢、超过 10 s hook 上限。门禁原栈与各阶段计时未取得，未排除其他环境原因；根因由门禁 owner 判定。
- 该测试文件不在本 lane 白名单，未修改、未加超时或跳过；建议由该测试 owner / 门禁 runner 处理冷加载预算。

```text
[作业 20261104112338-855c2a] npx vitest run --config vitest.config.ts src/features/settings/components/__tests__/ShadApiEditModal.codexOAuth.test.tsx
✓ ShadApiEditModal.codexOAuth.test.tsx (3 tests) 11233ms
Test Files  1 passed (1) / Tests  3 passed (3)
[作业 20261104112338-855c2a] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104112338-855c2a.log
Errors: 无 Errors 行

[作业 20261104112339-133b8e] npm run typecheck:host
[作业 20261104112339-133b8e] 退出码 0；Errors: 无 Errors 行

boundaries: scanned 2400 files, 0 violation(s), 177 suppressed via boundary-allow
[作业 20261104112339-72ca4c] npm run migration:boundaries
[作业 20261104112339-72ca4c] 退出码 0；Errors: 无 Errors 行

[作业 20261104112339-3ac24a] npx tsc --noEmit -p tsconfig.json（version:generate exit 0 后）
[作业 20261104112339-3ac24a] 退出码 0；Errors: 无 Errors 行

[作业 20261104112339-ebdc21] npx vitest run --config vitest.config.ts src/ui-plugins/official/settings src/features/settings/components/__tests__/SettingsNavigation.integration.test.tsx --maxWorkers=2
Test Files  7 passed (7) / Tests  25 passed (25)
[作业 20261104112339-ebdc21] 退出码 0；Errors: 无 Errors 行

ledger: commands 1058 (A 92.8% B 5.9% C 0%), tests 8036 (A 84% B 1.6%); problems: commands 0, tests 0, orphan registrations 0
[作业 20261104112339-00ebb6] npm run migration:ledger -- --check --no-write
[作业 20261104112339-00ebb6] 退出码 0
```

Host Vitest 配置不含 UI 测试（见 09:13Z），本轮不再以它证明 UI。侧栏补证时序例外仍待架构师裁定。

## R6-05 剩余项：导航/分类图标按来源隔离（12:04Z）

R6 反例：`navigation.ts` 派生时只复制 `icon`、丢失 `origin`，`Settings` 与 `SettingsShellSidebar` 直接渲染社区贡献的导航/分类图标，无局部边界。

修复（仅允许路径；生产改动见检查点 `3223fdc56`、`e7260a312`、`5c8aa07e4`、`7a1670030` 与本节提交）：

- `navigation.ts`：`settingsNavigation` 改收 `SlotEntry<SettingsSection>[]`，导航项图标与分类图标都随产生它的条目携带来源；分类按 id 去重仍是“同 id 后者覆盖、位置取首次”的原 Map 语义，只是同时记住胜出条目。
- 新增 `isolation.tsx`：复用 `SectionContent` 原有的 lazy `@/components/ErrorBoundary`（移到此处共享）。`settingsIcon(icon, entry)` 在 `entry.origin === 'builtin'` 时**原样返回同一组件引用**（不包边界，原错误传播不变、golden 图标逐项相同）；否则返回按 (原图标, `settings:<id>:icon`) 缓存的稳定包装组件，抛错时 `fallback` 为空图标，标签与点击照常。未使用 owner 字符串。
- 两个消费方 `Settings.tsx`、`SettingsShellSidebar.tsx` 只把 `entries.map(e => e.value)` 改为直接传 `entries`；`runtime.test.tsx`、`__golden__/settings.test.ts` 同步签名。golden JSON 未改（`git diff --exit-code d3943bae5 -- __golden__/settings.json` exit 0）。
- `sidebar.test.tsx` 新增用例（真实 `SettingsShellSidebar` + 真实 UiKernel + 真实 ErrorBoundary）：社区插件导航图标与分类图标均抛错 → 7 个分类按钮仍在、点击社区分类与官方分类均切换 tab；以官方同 ID `dstu.ui.settings` 不传 origin 覆盖（断言 origin 为 community）且图标抛错 → 隔离、邻项社区分类仍可点击；卸载后社区项消失、覆盖项仍在；builtin 来源同样抛错的图标 `settingsIcon` 返回原引用，错误传播到外层宿主边界（`componentDidCatch` 恰好一次）。

```text
[作业 20261104120406-dda3d8] npx tsc --noEmit -p tsconfig.json（version:generate 后）
[作业 20261104120406-dda3d8] 退出码 0；Errors: 无 Errors 行

[作业 20261104120407-cc534e] npx vitest run --config vitest.config.ts src/ui-plugins/official/settings/sidebar.test.tsx src/ui-plugins/official/settings/runtime.test.tsx src/ui-plugins/official/settings/__golden__/settings.test.ts src/ui-plugins/official/settings/sidebar-props.test.tsx --maxWorkers=2
✓ sidebar-props (1) / runtime (3) / sidebar (4，含新用例) / __golden__/settings (1)
Test Files  4 passed (4)
Tests  9 passed (9)
[作业 20261104120407-cc534e] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104120407-cc534e.log
Errors: 无 Errors 行
```

此前两次作业 `20261104115601-10c2bb`/`-b42691`、`20261104115943-aee06b`/`-a10397` 失败（exit 1/2）：新参数名与 `navigation.ts` 内已有局部变量 `entries`、`sectionEntries` 重名（TS2300 / SyntaxError），改名 `slotEntries` 后即上方通过；不计为通过。侧栏补证时序政策仍是另一未决项。

## 13:36Z v2 §1 自查：移动端分类图标补测

§1.1 自查发现 R6-05 测试只覆盖 `SettingsShellSidebar → SettingsSidebar`；`Settings.tsx:1181` 在移动端把同一派生结果交给 `SettingsMobileNavigation`（其 `:84-94` 渲染分类图标），此路径无测试。实现无需改动（同一 `settingsNavigation` 输出），`sidebar.test.tsx` 新增用例：真实 `SettingsMobileNavigation` + 真实 UiKernel，社区分类/导航图标抛错 → 7 个分类仍在、社区与官方分类点击打开对应 tab、卸载后回到 6 个。

```text
[作业 20261104133642-842f67] npx vitest run --config vitest.config.ts src/ui-plugins/official/settings/sidebar.test.tsx
Test Files  1 passed (1)
Tests  5 passed (5)
[作业 20261104133642-842f67] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104133642-842f67.log
Errors: 无 Errors 行
```

其余 §1 类别：1.2 本 lane 无表/仓储写入；1.3 无持久化/IPC 结构（slot 值为内存元数据）；1.4 社区错误经共享 ErrorBoundary 原有 `reportFrontendError` 上报，未吞错，builtin 错误照常外抛；1.5 未弱化断言、golden 未改；1.6 平台分支（移动隐藏、plugins 深链提示、workbench 重定向）已有测试；1.7 无需清理资源（图标包装按 WeakMap 缓存）；1.8 R6-05 待 R6 复验签收。

## 13:58Z 自检 `tests:app` 持续失败：`ShadApiEditModal.codexOAuth` beforeAll 超时（需 owner/C1 处理）

lane-gate 对 `c804bca1c`、`3ce0ea8ce` 两次自检均 1/6 未过，仅 `tests:app`：`ShadApiEditModal.codexOAuth.test.tsx:29` 的 `beforeAll` `Hook timed out in 10000ms`，该文件 3 tests 全部 skipped，其余 66 files / 482 tests 通过（作业 `20261104132936-3b91a2`，Duration 196.21s）。main 新增的基线豁免（`16a254adf`）只作用于 Host 测试，不覆盖 `tests:app`。

观察（同一命令、同一队列）：

| 运行 | 结果 |
|---|---|
| 干净 main `16a254adf` 临时 worktree，门禁同款 `npx vitest run --config vitest.config.ts --passWithNoTests src/features/settings src/ui-kernel/contracts src/ui-plugins/official`（作业 `20261104135113-47d784`） | 61 files / 473 tests 通过，exit 0，Duration 143.37s |
| 本分支同目录（门禁作业 `20261104132936-3b91a2`） | 67 files（多出的 6 个是本 lane 的 runtime / sidebar / sidebar-props / golden settings / legacy-extraction / sidebar-evidence 测试），codexOAuth hook 超时，exit 1 |
| 单文件，main（`20261104135528-3da9bb`） | 3 passed，tests 8087ms，exit 0 |
| 单文件，本分支（`20261104135528-05bdcb`） | 3 passed，tests 7722ms，exit 0 |

静态导入图核对：`ShadApiEditModal.tsx` 在 main 与本分支均可达 113 个本地文件，图完全一致；`Settings.tsx`、`src/ui-plugins/official/settings/*` 均不可达。即 U3 未改变该被测模块或其依赖。

推断（未证实）：该 hook 单独运行已用约 8 s（10 s 上限），本 lane 多出 6 个测试文件提高了同批并发负载，使其越限。未取得逐阶段计时，不排除其他环境因素。

处理：该测试文件不在本 lane 白名单，未修改、未加超时、未跳过，也未为此删减本 lane 的 golden/对照测试。需测试 owner 或 C1 决定（例如给该 `beforeAll` 冷导入合理预算，或授权方案），之后本 lane 重新自检。
