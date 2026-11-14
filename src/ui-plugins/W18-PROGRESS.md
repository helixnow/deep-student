# W18 · 前端注册表迁移（FE-B1 / FE-B4 / FE-B6；第二轮 FE-B5 / FE-B9）— 进度

分支 `assault/W18-fe-registries`，基于 W17 `9b4b945`（UI 内核 v2）。方案 `plans/FRONTEND-PLUGINIZATION.md` §2、§2.8、§3.2。

测试命令（临时生成 `src/version.ts`，用完删除、不提交）：

```
DEEP_STUDENT_BUILD_NUMBER=20000 node scripts/generate-version.mjs
npx vitest run -c vitest.config.ts <路径> --maxWorkers=2
```

纪律：每个工作包先单独提交取证与 golden，再提交改造；改造提交只改测试里的“生产装配”函数，golden 文件只在取证提交里出现过一次
（`git log -- <golden>` 各只有一个提交）；没有修改任何既有 golden 或断言。

## 提交

| 工作包 | 取证 | 改造 |
|---|---|---|
| FE-B1 命令面板 | `efa6ca1f` | `9d80f6fd`（类型收窄 `e4431cef`） |
| FE-B4 工作台应用 | `cf148963` | `d6956611`（类型收窄 `e4431cef`） |
| FE-B6 Markdown 扩展与生成式 UI | `ddc8bf36` | `690b91e2` |

## 基线（`9b4b945`）

F1 范围（`src/ui-kernel src/ui-plugins src/ui-sdk` + `tests/vitest/modernSidebarNavigation.test.tsx` +
`MobileSidebarNavigation.dedup.test.tsx`）与 W17 记录一致：只有 3 个固定旧源回放文件失败（`git show <旧提交>`，本机快照没有这些提交，
环境性）：`testing/legacy-boot-evidence`、`settings/__golden__/sidebar-evidence`、`shell/__tests__/legacy.evidence`。
`workbench/core/__tests__/platformPerformanceConfig` 的 Settings 源码字符串断言在基线上同样失败，与本工作流无关。

## FE-B1 命令面板

取证（`src/command-palette/__tests__/commandManifest.golden.test.tsx`，`__golden__/commands.json` 13,323 行）在改造前的装配
（App 挂载 `useAppBackgroundServices` → `registerBuiltinCommands`）上捕获，开发、生产两种构建各一份：

- 每条命令的全部字段；名称、描述、关键词各取 zh-CN、en-US、i18n 键三种渲染；切换语言后的注册顺序；
- 可见条件矩阵：18 个命令视图（17 个经典视图 + workbench）× 工作台聚焦应用 × 深浅色 × 笔记工作区资源 × 移动端，共 276 种状态；
- 13 个查询 × 4 个视图的搜索排序；全部快捷键在 23 种视图 / 聚焦状态下的解析结果；
- 逐条执行命令的副作用轨迹：IPC 命令名 + 排序后的参数键、window/document 事件与 detail 键、依赖解析器调用、对话框、剪贴板、缩放。

开发 96 条、生产 87 条，差异恰为 9 条 `dev.*`。改造后同一测试改走真实生产装配（`createAppUiKernel()` + 挂载 `useAppBackgroundServices`），
golden 逐字段相等（含执行轨迹，即 IPC 调用不变）。

改造：9 个命令模块改由 8 个功能官方 UI 插件经 `ctx.ui.commands.register` 贡献，删除 `registerBuiltinCommands`
（`builtinCommands.ts`）与 `useAppBackgroundServices` 里的注册。安装顺序 = 原模块顺序（决定搜索与快捷键平分时的先后）：

| 插件 id | 目录 `src/ui-plugins/official/` | 命令 |
|---|---|---|
| `dstu.ui.navigation` | `navigation` | 视图跳转 16 |
| `dstu.ui.chat` | `chat` | 对话 12 |
| `dstu.ui.app` | `app` | 全局 26 + 设置 7 |
| `dstu.ui.notes` | `notes` | 笔记 / Finder / 导图 17 |
| `dstu.ui.learning-hub` | `learning-hub` | 学习资源 4 |
| `dstu.ui.todo` | `todo` | 自动化 4 |
| `dstu.ui.anki` | `anki` | 制卡 1 |
| `dstu.ui.dev` | `dev` | 开发 9；`devOnly`，只在开发构建安装 |

- `contributeCommands(ctx, create)`（`src/command-palette/contribute.ts`）登记稳定的命令对象，字段读取最近一次 `create()` 的结果，
  在语言切换、以及当前语言的 `command_palette` 命名空间到达时重建。原实现在语言切换时整批注销再注册；内核 v2 的
  `ctx.ui.commands.register` 不返回撤销句柄，插件内无法同步撤销单条命令，所以改为“对象不变、字段跟随”，注册顺序与对象身份不再变化。
- 有意偏离：注册时机从 App 挂载提前到内核装配，而 `command_palette` 是延迟加载的命名空间，因此增加“命名空间到达即重建”。
  原实现在同样的竞态下会停留在英文默认值直到下次切换语言；现在总是当前语言的译文。快捷键设置页缓存的命令列表也随之显示当前语言。
- 官方安装器识别 `devOnly`；开发插件内另有 `import.meta.env.DEV` 守卫，生产包可整体去掉开发命令模块。
- 行为测试 `official/__tests__/commandPlugins.test.ts`：逐插件卸载只撤销自己的命令；生产构建无 `dstu.ui.dev`、87 条；
  社区插件可加命令、占用官方 id 被拒；切换语言不重新注册；命名空间晚到时名称更新；卸载后不再跟随语言。

## FE-B4 工作台应用

取证：`src/features/workbench/apps/__tests__/appManifest.golden.test.tsx`（`__golden__/apps.json` 1,402 行）在改造前的懒加载装配
（`import('apps/registerAll')`）上捕获：22 个应用的全部元数据与顺序、Agent 能力名、Dock 默认钉选、启动器（AppsPanel）在浏览器开关两种状态下
渲染出的条目 DOM、Dock 渲染出的条目 DOM。`official/__tests__/workbenchClosure.test.ts` + `__golden__/workbench-closure.json`
记录入口与启动块里的全部 `src/features/workbench/**` 模块。

改造：9 个 `apps/*/register.ts*` 中 17 处 `appRegistry.register` 改为 `contributeWorkbenchApp(def)`（`core/appContributions.ts`），
由新官方插件 `dstu.ui.workbench`（`official/workbench`）经 `ctx.ui.workbench.registerApp` 登记，应用归该插件所有、随其卸载。
应用模块仍随工作台 chunk 懒加载：通用的“懒加载贡献点”（`official/lazy-contributions.ts`）让 chunk 在加载时宣告，启动时已安装的插件
同步登记；没有该插件的窗口（轻量窗、无内核测试）照旧直接写入 `appRegistry`，内核装配前就已宣告的（入口已带上的 chat）在插件安装时被接管。
Dock 默认钉选 `DEFAULT_DOCK_PINNED` 不变。

- golden 改造后相等；测试同时核对内核注册表视图与 `appRegistry` 一致。
- 行为测试 `official/__tests__/workbenchPlugin.test.ts`：接管内核前已登记的 chat、懒加载其余应用、社区应用可加、占用官方 typeId 被拒、
  卸载 `dstu.ui.workbench` 后应用全部消失；贡献点的回落、接管、错误隔离单测。

## FE-B6 Markdown 扩展与生成式 UI

取证（均在改造前捕获）：

- 新增插件顺序 golden：`official/content/__tests__/markdownPluginOrder.golden.test.tsx`（`__golden__/markdown-plugin-order.json`，
  96 种输入组合：有无内核 × 引用 4 态 × 搜索词 3 态 × 额外 remark 插件 × 流式），记录插件名、顺序、选项（sanitize schema 取哈希）、
  未变输入下重渲染时数组是否同一引用；
- 真实管线渲染 golden：`markdownRender.golden.test.tsx`（`__golden__/markdown-render.json`，176 组），覆盖管线里每个插件；
- 生成式 UI golden：`features/generative-ui/__tests__/genuiComponents.golden.test.tsx`（`__golden__/components.json`），
  18 种块的组件、schema、提示词目录，以及有无内核时 18 个单块、全量、未知类型的渲染输出。

改造：

- 有序槽位 `markdown.remark` / `markdown.rehype`（契约 `official/content/pipeline.ts`），由 `dstu.ui.content` 声明；官方 7 个 remark 步骤与
  3 个 rehype 步骤（raw 10、sanitize 20、搜索高亮 30）移到 `renderers/markdownPipeline.ts`，随 MarkdownRenderer 懒加载并宣告，
  `dstu.ui.content` 登记；轻量窗口直接用同一张官方表。社区步骤按 order 插入，抛错只跳过该步骤并计入插件错误预算。
- `genui.components`（key = block type，契约 `features/generative-ui/componentContributions.ts`）由新官方插件 `dstu.ui.genui` 声明并登记；
  GenerativeUIRenderer 有内核时读槽位，无内核时读 `generativeUIRegistry`；提示词目录与 schema 校验仍读注册表。
- U4 markdown golden（15,842 行）及 codeblock / menu / labels golden 全部通过；新增三份 golden 改造后相等；
  行为测试 `official/__tests__/markdownSlots.test.tsx`（官方顺序与归属、社区插入与 sanitize 位置、错误隔离与自动卸载、卸载语义、社区生成式块）。

## 构建与 chunk 证据

- 静态导入图（`official/__tests__/importGraph.ts`，按 Rollup 语义：静态 import / eager glob 为同 chunk，`import()` 为新 chunk）。
  启动加载 = 入口 `src/main.tsx` 静态闭包 + 随即加载的启动块（UI 内核 bootstrap + 全部官方插件）。基线 `9b4b945` 与 HEAD 对比：
  启动集合只新增 14 个轻量模块（8 个命令插件入口、`contribute.ts`、工作台 / 生成式 UI 插件入口、两个契约模块、贡献点），
  减少 `builtinCommands.ts`；入口闭包 789 → 780（命令模块从入口块移到启动块，同为启动期加载）。
  WorkbenchDesktop、`apps/registerAll`、除 chat 外的全部应用注册模块与全部应用窗口、MarkdownRenderer 与其管线、生成式 UI 渲染器与块
  均不在启动集合里（`workbenchClosure.test.ts`、`startupClosure.test.ts` 机器核对）。
- 生产构建（`bin/heavy`，`NODE_OPTIONS=--max-old-space-size=8192 npx vite build --manifest`，基线 `9b4b945` 与 HEAD 各一次，退出码均为 0，
  各约 70 s）。按 Rollup manifest 求“入口 `index.html` 静态 chunk 闭包 + bootstrap / install 静态 chunk 闭包”：

  | 指标 | 基线 | HEAD |
  |---|---|---|
  | 入口闭包字节 | 5,346,981 | 5,219,872（命令模块移出入口块） |
  | 启动集合字节 | 5,386,761 | 5,397,248（+10,487，+0.19%） |
  | 启动集合 chunk 数 | 13 | 41（新增的是 24 个图标小 chunk、命令模块、两个契约模块；单个 0.1–11 KB） |
  | WorkbenchDesktop（独立动态入口）、应用定义、15 个应用窗口 chunk | 不在启动集合 | 不在启动集合 |
  | Markdown 管线、生成式 UI 渲染器 | 不在启动集合 | 不在启动集合 |
  | 开发命令代码 | 不在任何 JS（只出现在 command_palette 语言包） | 同左 |

  chunk 数增加的原因：命令模块原先经 App 静态进入口块，现在只被启动块（官方插件）引用，与懒加载页面共用的图标被 Rollup 拆成共享小 chunk。
  均为本地加载；如需合并可在 `vite.config.ts` 的 manualChunks 里把启动共享模块归组（需授权，见交接 14）。

## 收尾

- 前端 typecheck（`bin/heavy npm run typecheck`）：退出码 0（`e4431cef`）。
- ESLint：自 `9b4b945` 以来新增或修改的 49 个 TS/TSX 文件，0 错误 0 警告（顺带修掉 `boot-entry-harness.ts` 原有的 2 处 `Function` 类型错误）。
- F1 范围（同基线命令，`bin/heavy`）：53 个文件 / 270 个用例，失败只有上述 3 个环境性旧源回放文件（2 个用例 + 1 个收集失败）；
  boot golden 16/16、shell / settings / markdown / codeblock / menu / labels golden 全部通过。
  `src/ui-kernel/__tests__/bootstrap.test.ts` 正常负载下 4/4（2.05 s）；有一次与另外两个重任务并发时首例超过 5 s 默认超时（见交接 7）。
- 三个工作包的 golden 与行为测试在最终 HEAD 上复跑：15 个文件 / 56 个用例全部通过。

## 交接事项

1. 内核：`ctx.ui.commands.register` / `workbench.registerApp` / `chat.registerBlock` 不返回撤销句柄，插件无法单独撤销或替换一条贡献。
2. 内核：上述登记接口的参数类型是 `{ id } & Record<string, unknown>`，接口类型（`Command`、`AppDefinition`）需要收窄断言；
   建议给命令与工作台应用登记值类型（与 SlotMap 同法）。
3. 内核：`UiPluginMeta` 没有“仅开发构建”的声明，W18 用官方安装器识别的 `devOnly` 过渡。
4. 内核：缺少“懒加载 chunk 的贡献”原语。W18 的 `createLazyContributionPoint`（`ui-plugins/official/lazy-contributions.ts`）
   服务工作台应用、Markdown 管线、生成式 UI 三处，建议上收为内核接口。
5. 内核：`SlotStore` 用全局版本号，任何槽位变化都会让所有 `useOptionalSlot` 订阅方重渲染；MarkdownRenderer 现订阅 3 个槽位
   （原来已订阅 `markdown.codeBlocks`）。建议按槽位计版本。
6. 内核契约：`markdown.remark/rehype` 与 `genui.components` 的 SlotMap 登记暂放在 `official/content/pipeline.ts` 与
   `features/generative-ui/componentContributions.ts`，建议移到 `src/ui-kernel/contracts/` 并决定是否随 SDK 导出。
7. W17 测试：`ui-kernel/__tests__/bootstrap.test.ts` 的首个 `createAppUiKernel()` 现在会冷加载命令模块（官方插件的一部分），
   建议给该用例 15 s 超时。
8. 测试装配：安装整套官方插件的测试内核需要三个注册表适配器。新增 `ui-plugins/testing/registries.ts`（内存实现，含 chatBlocks），
   `createOfficialUiTestKernel` 与 boot golden 对照内核使用它，boot 取证工具的命令注册表替身补了 `getById`；FE-B2 可复用。
9. 目录与 id：`official/chat`（`dstu.ui.chat`）已存在；FE-B2/B3 若新增对话 UI 插件，请并入同一插件而不是再起一个同 id 插件。
10. 安全政策：sanitize 现在是 `markdown.rehype` 的官方条目（order 20），随 `dstu.ui.content` 卸载；是否改为不可移除的框架步骤由 FE-A4 / 安全评审裁定。
11. 生成式 UI：社区 `genui.components` 能渲染，但不进提示词目录与 schema 校验（它们读注册表）；后续可由 `dstu.ui.genui` 同步 schema。
12. FE-C1：新增的 `dstu.ui.navigation/chat/app/notes/learning-hub/todo/anki/dev/workbench/genui` 是按功能重切的起点，
    与 Host 配对时登记 owner 迁移。
13. 开发期边角：内核已装配时热更新重新执行某个工作台应用模块，会触发内核冲突（已捕获并打印），而不是原来的“警告后覆盖”；整页刷新即恢复。
14. 构建：启动集合 chunk 数 13 → 41（字节 +0.19%）。若要求启动 chunk 数不增，可在 `vite.config.ts` 用 manualChunks 把启动期共享模块归组，
    或由 FE-A5 的 `virtual:ds-official-plugins` 统一生成官方插件表时一并处理（`vite.config.ts` 需主代理授权）。

## 第二轮（WAVE2）

| 项 | 取证 | 改造 / 提交 |
|---|---|---|
| 快捷键冲突误报 | — | `0ff7dbee`（启动期 4 条假警告）；`1db5fd8c` 设置页冲突提示保持原 view 维度；`7a2e71cc` **[待审]** 设置页改用聚焦应用维度；`ce32d999` 作用范围函数并回 `commandRegistry`（启动闭包不新增模块） |
| FE-B5 编辑器扩展 | `a03ac9dd` | `db871751`：`editor.extensions` / `editor.slashMenu`，插件 `dstu.ui.editor`（order 70） |
| FE-B9 菜单族 | `ef4518ea` | `845303b8`、`73888ab3`：`app.menu`，插件 `dstu.ui.menu`（order 80），工作台菜单栏的品牌 / 应用 / 窗口三个菜单 |
| 基线 | — | `14134181`：槽位快照 16 场景 + app-assembly、`official-slots.json` |

- 编辑器：Milkdown 插件在实例创建时取一次槽位（`create()` 之后无法增删），斜杠菜单每次构建分组时取当前槽位。
  社区条目的工厂、`run` 与清理函数抛错都报给 `kernel.errors`，编辑器照常打开；官方条目抛错照旧向上抛。
- 菜单：行描述 `{ kind?, id, label, icon?, shortcut?, disabled?, checked?, danger?, testId?, run?, closeOnRun? }`，
  宿主（`StatusBarBrandMenu` / `StatusBarAppMenus`）只保留触发器、标题与改名表单，行由 `MenuBarRows` 按原 `ActionItem` 渲染。
  社区 `items()` 抛错按 render 报告，`run` 抛错按 report 报告；行 key 含 owner、条目 id、kind 与行 id，重复时加 `#n`。
- `contextMenu.register` v1 兼容问题：W17 已在内核修复，`community-menu-v1.test.tsx` 通过，本工作流未再改动。

### 五层回归（`14134181` / `ce32d999`）

`bin/heavy node tests/visual/regress.mjs --build` 在当前集成基线上无法跑通：demo 启动即白屏
（`vendor-micro` 里 `createContext` 读到 undefined）。原因是 `vite.config.ts` 的 `computeStartupBootGroup` 只排除有 vendor 名字的模块，
Rollup 的虚拟模块 `\0commonjsHelpers.js`（及 `void-elements` 等未归组的 CJS 依赖）被并进 `ui-boot`，
于是 `vendor-react → ui-boot → vendor-micro → vendor-react` 成环，模块按 `vendor-react` 先求值时 React 尚未导出。
W16 / W17 / W19 工作树的 demo 构建产物里 `vendor-react` 同样静态导入 `ui-boot`，W17 的产物同样白屏，与本工作流无关。

验证方式（未改仓库文件）：在 `/tmp` 下用包装脚本构建 demo，仓库配置原样加载，只在 manualChunks 外加一条
`\0commonjsHelpers` → `vendor-react`（该 chunk 没有任何 import，不会成环；把所有 `\0` 模块都排除则会把 React 的 CJS 代理也挤出 `vendor-react`，形成新环）。
同一包装在合并基线 `68d37526`（不含 W18 本轮任何提交）上另建一份做对照：

| 层 | W18 | 基线 `68d37526` |
|---|---|---|
| 1 槽位快照 | 通过 | — |
| 2 DOM（24 张） | 20 通过；`shell-chat` ×2 会话相对时间“2/3分钟前”→“刚刚”，`skills-mcp` ×2 内置翻译技能徽标“2”→“3” | 同样 4 张、逐行相同 |
| 3 IPC（18 场景） | 14 通过；`paper-search` / `notes` / `anki` 启动命令顺序变化，`skills-mcp` 少 `listen:tauri://close-requested`（`vfsRefApiEnhancements.ts`） | 同样 4 处、逐条相同；两次运行稳定 |
| 4 截图（49 张） | 全部通过 | — |
| 5 chunk（真实配置） | 5 条违规 | 同样 5 条，入口闭包变化逐条相同 |

第 5 层第一次运行时 W18 多 1 条：`src/command-palette/registry/commandScope.ts`（`0ff7dbee` 新抽出的模块）进入入口闭包；
`ce32d999` 把它并回已在入口闭包的 `commandRegistry.ts` 后与基线一致，入口字节比基线多约 435。
基线的 5 条（`host/kernel/platforms.ts`、`cancelAlignment.ts`、`appContributions.ts`、`lazy-contributions.ts` 进入入口闭包，
`graphApi.ts` 不再是动态入口）同样来自上面的环：`vendor-react` 静态导入 `ui-boot`，整个 `ui-boot` 被拉进入口闭包。
因此本轮没有提交第 2–5 层基线更新。

### 第二轮交接

15. W17（`vite.config.ts`）：`computeStartupBootGroup` 的入组过滤需排除 `\0` 虚拟模块，并把 `\0commonjsHelpers.js` 固定归入 `vendor-react`
    （上面的包装验证过：白屏消失，DOM / IPC / 截图与基线一致）。`ui-boot` 分组规则是 W18 第一轮 `fe124709` 引入的，这个缺口属于该规则。
16. W16：DOM `shell-chat` / `skills-mcp` 与 IPC `paper-search` / `notes` / `anki` / `skills-mcp` 在集成基线上已偏离 golden，需归因到对应工作流后更新基线。
17. W17：`editor.*` 与 `app.menu` 的 SlotMap 登记暂放在 `official/editor/contract.ts`、`official/menu/contract.ts`，建议与交接 6 一并移到 `src/ui-kernel/contracts/`。
18. 待裁定：卸载 `dstu.ui.editor` / `dstu.ui.menu` 会清空对应槽位（编辑器核心步骤、官方菜单行）；是否改为不可移除，与交接 10 同一决策。
19. 笔记树资源右键菜单未并入 `resource.contextMenu`：`NotesWorkspaceApp.tsx` 的 `getTreeMenuItems`（约 2327 行）与 `tree/TreeContextMenu.tsx`；
    需要 `src/ui-kernel/contracts/content.ts` 38–50 行的 `ContentMenuContext`（scope 目前只覆盖学习资源）泛化，例如新增 `'notes-tree'` scope。
20. W09：`ModernSidebar.tsx` 1441–1472 行的设置应用菜单（2 项）可作为 `'sidebar.settings'` 并入 `app.menu`；
    `src/dstu/contextMenu.ts` 的构建函数无调用方（只在 `src/dstu/index.ts` 约 184 行再导出）。
21. 测试环境：vitest 把 `react-i18next` 别名到只含 zh-CN 的 mock，FE-B9 golden 只录了 zh-CN。

## 第四轮（INT `8037af0c`）

| 项 | 提交 |
|---|---|
| 契约迁入 `src/ui-kernel/contracts/editor.ts`、`menu.ts`（交接 17 完成），类型从 `@/ui-sdk` 导出；删除 `official/{editor,menu}/contract.ts`，改为插件内的 `editorSlots.ts`、`appMenu.ts`；修复 INT 上 `../lazy-contributions` 已删导致的解析失败；两个插件改用 `ctx.ui.attach` | `e0158a10` |
| ui-boundaries 基线：1085 → 1066（`plugin-import-boundary` 106 → 87），删 11 条、无新增 | `718a843f` |

- 菜单插件只依赖 `@/ui-sdk`：窗口与应用操作经上下文里的 `workbench`（`AppMenuWorkbench`）调用，
  宿主侧实现在 `features/workbench/components/MenuBarRows.tsx`（`menuBarWorkbench`、`menuBarWindows`，窗口列表按创建时间排序、标签含“已最小化”后缀）。
- 编辑器：`resolveEditorExtensionGroups` 保持每个条目一次 `editor.use`（W16 的 `editorExtensions.golden` 要求调用分组不变）。
- 剩余 1 条：`workbenchMenus.tsx` → `features/settings/components/workbenchMode`（退出学习桌面行）。移到宿主会新增一条
  `features/workbench → features/settings` 跨 feature 引用，因此留在插件里，见交接 22。

### 第四轮五层回归

`bin/heavy node tests/visual/regress.mjs --build`（W17 `f90b38e5` 修复 chunk 环后 demo 可直接构建）。
INT `8037af0c` 本身无法构建（`official/{editor,menu}/contract.ts` 引用已删的 `lazy-contributions`），
对照用临时工作树：`8037af0c` 只把这两行导入改为 `@/ui-sdk/lazy`。

| 层 | W18 `718a843f` | INT 对照 |
|---|---|---|
| 槽位快照 | 通过 | — |
| DOM | 通过 | — |
| IPC（18 场景） | 16 通过；`notes` 启动命令顺序在第 17 条变化，`skills-mcp` 少 `listen:tauri://close-requested`；重跑一次结果相同 | 同样两场景失败：`skills-mcp` 相同，`notes` 顺序变化出在第 22 条（启动期异步次序不定） |
| 截图（49 张） | 通过 | — |
| chunk（真实配置） | 0 违规，入口 -2514 字节 | 0 违规，入口 -2514 字节；差异只有 `contract` → `editorSlots` 改名、`MenuBarRows` 进入状态栏所在的 `init` chunk |
| 取证（W16 evidence 5 文件） | 通过，含 `workbenchMenus.golden`、`finderMenu.golden`、`editorExtensions.golden` | — |

本轮无基线更新提交。

### 第四轮交接

22. W09（`src/features/settings`）或 W17（`@/ui-sdk`）：学习桌面开关的写入口 `persistWorkbenchModeEnabled`（含停用预检与 handoff）
    需要以 UI 服务暴露（例如 `ctx.services` 里的 `workbenchMode.setEnabled(enabled)`，或 settings 的 `api.ts` 导出），
    之后 `workbenchMenus.tsx` 的退出行改为调用它，最后一条 `plugin-import-boundary` 可清。
23. W16：IPC `notes`（启动命令次序不定）与 `skills-mcp`（`tauri://close-requested` 监听）在 INT 上已偏离 golden，与本工作流无关。
24. FE-B9 剩余：Finder（`learning-hub/sidebar/SidebarContextMenu.tsx`，调用方 `LearningHubSidebar.tsx` 1336 行）、笔记树、工作台文件菜单
    按方案并入 `resource.contextMenu`，都依赖 `ContentMenuContext.scope` 泛化（W17 本轮的 `'notes-tree'` scope）；
    W16 的 `finderMenu.golden` 已录好迁移前的条件 × 目标矩阵。`AppMenu.tsx` 是共享的菜单渲染组件，没有可迁的登记表。
25. `ui-boundaries.test.ts` 不在 `vitest.config.ts` 的 include 内，需用 `vitest.host.config.ts` 运行。

## 第五轮（INT `fd621db5`）

| 项 | 提交 |
|---|---|
| 合并 INT `fd621db5` | `817f057b` |
| FE-B5：每条目一次 `editor.use` 与一次 `use` 展平后 53 个插件的等价性测试 | `5dbfb11b` |
| FE-B9：笔记树右键菜单并入 `resource.contextMenu`（`notes-tree` scope），行归 `dstu.ui.menu` | `9cf7675a` |
| FE-B9：Finder 已走 `resource.contextMenu`，补测试 | `31da8de5` |

### FE-B5：20 次 `use` 与 1 次 `use`

Milkdown 7.22.1 的 `Editor.use` 在 Idle 状态只写 `usrPluginStore`（Map，按插入顺序，参数展开两层）；`create()` 先对全部插件
执行 `plugin(ctx)`，再按 store 顺序加载。`src/components/crepe/__tests__/editorUseBatching.test.ts` 用真实 Crepe 各建一次
（现行 `applyCrepePlugins` 对照“`resolveEditorExtensions` 展平后一次 `use`”），默认选项与关闭 automd / wikilink / mention 两组：

- 插件顺序：相同。Map 插入顺序，重复插件两种写法都保留首次位置。
- 优先级：ProseMirror 插件序列（key 掩码）、16 个按键探针、inputRules 数、nodeViews / markViews、schema、remark 插件、doc JSON 与 markdown 全部相同。
- 初始化时机：setup / run / ready 事件序列相同，都在 `create()` 内；`create()` 之前只有 `use`；工厂在任何 `use` 之前求值。
- 错误隔离：社区条目工厂、setup、run 抛错（order 5 / 105 / 205）两种写法报告的错误相同，其余插件照常；官方工厂抛错两种写法都在第一次 `use` 之前中止。
- 唯一可观察差异是 `use` 调用次数（20 对 1），只有 W16 `editorExtensions.golden` 的 `uses` 字段记录它。

生产代码保持每条目一次 `use`（第四轮已恢复），不登记 RF，W16 不需重录。若主代理决定改为一次 `use`，见交接 28。

### #23（新建笔记后的标题焦点竞态）

W09 已修：`src/features/notes/NotesCrepeEditor.tsx` 2978–2979 行 `autoFocusTitle` 追加 `editorApi !== null`，
RF `host/e2e/differential/rust-fixes/RF-W09-new-note-title-focus.json`（approved）。本轮只核对，未改动。

### FE-B9 笔记树右键菜单

- `official/menu/notesTreeMenu.ts`：11 行（打开 / 在右侧分屏打开 / 收藏 / 重命名 / — / 新建笔记 / 新建文件夹 / 新建导图 / 新建学习笔记 / — / 删除，
  order 10–110），`scopes: ['notes-tree']`。模块加载时向 `resourceMenuContributions`（`official/menu/resourceMenu.ts`，懒贡献点）登记，
  `dstu.ui.menu` 用 `ctx.ui.attach` 贡献到槽位。随 NotesWorkspaceApp 加载，不进启动闭包，槽位快照不变。
- `NotesWorkspaceApp.tsx` 的 `getTreeMenuItems` 改为 `resolveNotesTreeMenu(槽位 ?? officialNotesTreeMenuEntries, NotesTreeMenuContext, t, 报错)`，
  工作区动作集中在 `treeMenuActions`（`NotesTreeMenuActions`）；无 UI 内核时用官方表。
- 显示的分隔行落到下一条显示的行之前；社区行求值抛错时跳过并按 render 报告，`run` 抛错按 report 报告；官方行抛错照旧上抛；行 id 为 `owner:id`。
- 插件只能 import `@/ui-sdk`，上下文类型由 `SlotValue<'resource.contextMenu'>` 推导，见交接 26。
- 回归：W16 `notesTreeMenu.golden`（6 个目标：行、键盘打开、每行动作）不变；`official/menu/__tests__/notesTreeMenu.test.tsx` 8 例：
  真实工作区挂在内核里，官方行的属主，有无内核菜单相同，社区 scoped 行与 v1 条目按 order 插入并执行、卸载后消失，抛错隔离，
  卸载 `dstu.ui.menu` 移除官方行，以及 `resolveNotesTreeMenu` 单测。变异验证：让工作区忽略槽位，社区相关 2 例失败。
  W09 的 `NotesWorkspaceApp.test.tsx` 57 例（无内核路径）与 `tree/__tests__/rename.test.tsx` 通过。

### FE-B9 Finder

`SidebarContextMenu.tsx` 只做接线；它渲染的 `LearningHubContextMenu` 自基线起就读 `resource.contextMenu`（学习资源 scope），无需迁移。
新增 `official/menu/__tests__/finderMenu.test.tsx`：笔记树行不出现在 Finder（卸载 `dstu.ui.menu` 前后空白处、文件夹、资源三类目标的行相同），
`scopes: ['resource']` 的社区行只出现在资源目标并能执行。变异验证：关掉内核的 scope 包装，测试失败。

### 第五轮检查（交付前一次）

| 检查 | 结果 |
|---|---|
| `ui-boundaries.mjs --check` | 1066 已知、0 新增、0 过期（基线不变） |
| `frontend-invoke.mjs` / `event-emit.mjs` / `hardcoded-copy.mjs` / `import-cycles.mjs --check` | 均 0 新增、0 过期 |
| `slot-snapshot.mjs --check` | 通过（18 例），无更新 |
| `bin/heavy npx tsc --noEmit -p tsconfig.json` | 0 错误 |
| W16 取证 `notesTreeMenu` / `finderMenu` / `workbenchMenus` / `editorExtensions` golden | 全部通过 |
| 相关单测（menu、content 安装与菜单、`resource-menu`、启动闭包、笔记工作区、FE-B5 等价性） | 12 + 4 个文件全部通过 |

### 第五轮交接

22. 仍开放（W09 或 W17）：`persistWorkbenchModeEnabled` 以 UI 服务暴露后，`official/menu/workbenchMenus.tsx` 21、56 行改为调用它，可清最后一条 `plugin-import-boundary`。
24. 更新：笔记树已迁（`9cf7675a`），Finder 无需迁移（`31da8de5`）；工作台的 Dock 与桌面右键菜单见交接 27。
26. W17（`src/ui-sdk/index.ts` 41–45 行附近）：从 `@/ui-sdk` 导出 `ScopedResourceMenuContribution`、`ResourceMenuContribution`、`ResourceMenuScope`、
    `NotesTreeMenuContext`、`NotesTreeMenuItem`、`NotesTreeMenuActions`（`src/ui-kernel/contracts/content.ts` 41、57–92、122–130 行）。
    之后 `official/menu/notesTreeMenu.ts` 12–16 行的推导类型可改为直接导入。
27. W17（`src/ui-kernel/contracts/menu.ts`）：Dock 菜单（`features/workbench/components/DockContextMenu.tsx` 92–161 行）与桌面右键菜单
    （`DesktopContextMenu.tsx` 740–918 行）并入 `app.menu` 需要契约扩展：
    - 44–48 行 `AppMenuContexts` 增加 `'workbench.dock'`（`typeId`、应用名、`instanceMode`、该应用的窗口、前台窗口 id、是否钉选）
      与 `'workbench.desktop'`（显示桌面 / 恢复窗口状态、当前壁纸与材质档位、桌面组件开关）；
    - 23–35 行 `AppMenuWorkbench` 增加钉选切换、按应用关闭全部窗口、带 `reason` 的启动（Dock 用 `'dock'`）、桌面的排列 / 平铺 / 显示桌面 / 设置写入；
    - 59–73 行 `AppMenuItem` 增加后缀文本（「已最小化」标签）、分组标题、子菜单与单选项（壁纸、材质档位子菜单）。
    W16 的 `workbench-menus.json` 已录好迁移前的 Dock 与桌面菜单，契约到位后 W18 迁移。
28. 仅当主代理决定 `applyCrepePlugins` 改为一次 `use` 时：W16 重录 `src/ui-plugins/testing/__golden__/evidence/editor.{notes,plain}.assembly.json`
    （`editorExtensions.golden.test.tsx` 191 行的 `uses` 字段），预期只有最后 20 项合并为一项（53 个插件），其余不变。

## 第六轮（INT `6c491e6f`）

| 项 | 提交 |
|---|---|
| 合并 INT `6c491e6f` | `5dd6d9c5` |
| FE-B9 取证：Dock 项菜单与桌面右键菜单迁移前的 DOM 与行为 golden | `3506543d` |
| `app.menu` 契约扩展（交接 27）、SDK 导出资源菜单 / 笔记树类型（交接 26）、`notesTreeMenu.ts` 直接从 `@/ui-sdk` 导入 | `ec16779f` |
| FE-B9：Dock 项菜单与桌面右键菜单并入 `app.menu`（`workbench.dock` / `workbench.desktop`） | `d74a65d1` |
| `dstu.ui.menu`、`dstu.ui.editor` 声明 `core: true`（W17 交接，按既有裁定） | `44e8a9f5` |

主代理对 FE-B5 的裁定：生产保持每条目一次 `use`，交接 28 关闭。

### FE-B9 取证（`3506543d`）

`official/menu/__tests__/workbenchContextMenus.golden.test.tsx` + `__golden__/workbench-context-menus.json`，有无 UI 内核各录一遍，结果相同：
- Dock：多实例 / 单实例 / 未注册应用 × 无窗口、运行中、前台、最小化、钉选，共 6 个状态；每个状态记录触发器与面板 HTML、行、
  每个可用项点击后的副作用（launch、聚焦、钉选、逐窗 `requestCloseAnimated`）与菜单是否关闭，以及键盘遍历。
- 桌面：空桌面、自定义设置（组件隐藏、材质 reduced、壁纸 sakura）、全部最小化 + 图片壁纸、4 窗 + 未知壁纸，共 4 个状态；
  记录主面板与两个子菜单的 HTML、行、每一项点击的副作用及其与 `onClose` / `onShowDesktop` 的先后，空桌面与自定义设置另录指针与键盘遍历。
- 副作用经 mock 记录：`invoke`、设置写入（`localStorage` 实例 spy）、`workbench:settings-changed` 等事件、`setMaterialTier`、
  `toggleDockPinned`、关窗动画、应用面板、速查表、俯瞰、窗口 store 动作。窗口 id 与 `useId` 已匿名化。

### FE-B9 Dock 项菜单与桌面右键菜单

- 契约（`src/ui-kernel/contracts/menu.ts`，只追加）：`AppMenuContexts` 增加 `'workbench.dock'`（`AppMenuDock`：typeId、应用名、
  `instanceMode`、该应用的窗口（标题或应用名，不带后缀）、前台窗口、是否钉选）与 `'workbench.desktop'`（`AppMenuDesktop`：
  有无窗口 / 可见窗口、壁纸与预设、材质档位、组件显隐、两个快捷键提示，以及桌面自己的动作）；`AppMenuWorkbench` 增加
  `launchAppFrom`、`toggleDockPinned`、`closeWindowsOfApp`；`AppMenuItem` 增加 `suffix`、`radio`、`submenu`，`AppMenuSeparator`
  增加 `label`（其后一组的组标题）。`@/ui-sdk` 导出新上下文类型与资源菜单 / 笔记树类型。
- 官方行：`official/menu/dockMenu.tsx`（`dock:open` / `dock:windows` / `dock:pin`，order 10–30）、`desktopMenu.tsx`
  （`desktop:launch` / `layout` / `appearance` / `help`，order 10–40），随菜单加载时向 `appMenuContributions` 登记，不进启动闭包，槽位快照不变。
  无 UI 内核时宿主用同一张官方表。插件只 import `@/ui-sdk`。
- 原菜单「先关菜单再执行」的行（键盘快捷键、重新播放引导、管理壁纸、自定义图片壁纸）用 `closeOnRun: false` 并在 `run` 里先调
  `closeMenu()`，其余行由宿主在执行后关闭，副作用与 `onClose` 的先后与原来一致。
- 宿主：`DockContextMenu.tsx` 保留订阅（窗口指纹、前台窗口、钉选），在分隔线处分组，带标题的分隔线给其后一组加组标题并截断行文案；
  `DesktopContextMenu.tsx` 保留玻璃面板、子菜单 portal、键盘遍历、离场动画，子菜单状态改为父项行 key（社区行 id 与官方重复也互不影响），
  菜单未渲染时不生成行（避免关闭态反复求值社区行、消耗其错误预算）。
- 共用件：`appMenuHost.ts`（`context.workbench` 的实现、`workbench` 命名空间翻译、按槽位或官方表取行）、
  `DeskMenuItems.tsx`（`ActionItem` / `RadioItem` / `DeskMenuRow`，自 `DesktopContextMenu.tsx` 移出，原文件再导出 `ActionItem`
  供 `DesktopShortcuts.tsx`）。`MenuBarRows.tsx` 改用两者，不再 import 桌面菜单模块。
- `resolveAppMenuRows` 递归解析子菜单（key 唯一，社区子菜单行的 `run` 抛错同样只报告）；菜单栏与 Dock 把子菜单行就地展开
  （`inlineAppMenuSubmenus`），菜单栏的 `suffix` 显示为「 · 后缀」，单选项用 `RadioItem`。
- 没有行为变化，不登记 RF。

### 第六轮回归

| 检查 | 结果 |
|---|---|
| 本轮取证 `workbenchContextMenus.golden`（迁移前录制，迁移后原样） | 通过；变异验证：把「键盘快捷键」改为先执行后关、去掉 Dock 组内截断，均失败 |
| W16 取证 `workbenchMenus.golden` | 原样通过 |
| `menubar.golden`、`appMenu`、`notesTreeMenu`、`finderMenu`、`DockContextMenu`、`Dock`、`o13-desktop-context-menu`、`workbench-shell-ux`、`workbenchClosure` | 全部通过 |
| 新增 `workbenchContextMenus.test.tsx`（4 例） | 通过：官方行属主；社区行按 order 插入、组标题 / 后缀 / 单选 / 子菜单（指针、点击、方向键，含与官方重复的 id）；抛错隔离；卸载 |
| `official/__tests__`、`editorSlots`、`core-plugin`（`core: true` 之后） | 通过 |
| `platformPerformanceConfig` | 仅既有的 Settings 源码字符串断言失败（基线同样失败），`batchSetDisplayModes` 断言通过 |

### 第六轮检查（交付前一次）

| 检查 | 结果 |
|---|---|
| `ui-boundaries.mjs --check` | 1066 已知、0 新增、0 过期（基线不变） |
| `frontend-invoke` / `event-emit` / `hardcoded-copy` / `import-cycles` / `rust-fixes` | 均 0 新增、0 过期；rust-fixes 0 错误 |
| `boundaries.mjs` | 0 违规 |
| `slot-snapshot.mjs --check` | 通过，无更新 |
| `generate-contracts.mjs --check`、`check-boundaries.mjs` | 通过 |
| `bin/heavy npx tsc --noEmit -p tsconfig.json` | 0 错误 |

### 第六轮交接

22. 仍开放（W09 或 W17）：同第五轮。
24. 完成：菜单栏、笔记树、Finder（原已走槽位）、Dock 项菜单、桌面右键菜单均在 `app.menu` / `resource.contextMenu`；工作台 Files 应用没有自己的菜单（用 Finder 的）。
26、27. 完成（`ec16779f`、`d74a65d1`）。
28. 关闭（主代理裁定保持每条目一次 `use`）。
29. W16（`tests/visual/__golden__/ipc/skills-mcp.json` 第 10 行）：删去 boot 步骤里的 `"listen:tauri://close-requested",`，
    建议 `node scripts/plugins/ipc-trace.mjs --update --scenes skills-mcp --build`（只重录该场景，不重写 inventory）。
    原因：`fe124709` 的 `ui-boot` 拆分后，`src/features/chat/context/vfsRefApiEnhancements.ts` 不再随启动加载；该模块加载时
    （731–750 行）才注册这个监听，用途只是窗口关闭时销毁两个内存缓存的定时器。skills-mcp 场景全程不加载它，没有缓存可销毁；
    其余 13 个场景（chat、essay、mindmap、notes、media 等）的 boot 步骤仍记录这个监听，与 golden 一致。无用户可见差异，不登记 RF。该文件归 W16，本 lane 不改。
30. W17（`src/ui-kernel/contracts/menu.ts` 第 4 行）：首句「`app.menu` holds the rows of the workbench menu bar menus」可改为
    「…menu bar menus, a Dock item's menu and the desktop's right-click menu」（本轮只追加，未改原句）。另：`@/ui-sdk` 中
    `AppMenuDesktop` / `AppMenuDock` 等 7 个菜单上下文类型的导出是交接 27 扩展的一部分（插件写 `items` 时要用），请确认保留。
31. 待定归属：学习桌面快捷方式图标的右键菜单（`DesktopShortcuts.tsx` 约 300–330 行：打开 / 重命名 / 移除）可作为
    `'workbench.desktopShortcut'` 并入 `app.menu`，需要 `menu.ts` 再加一个上下文（超出本轮授权）。之后 `DesktopShortcuts.tsx`
    可直接从 `./DeskMenuItems` 导入 `ActionItem`，`DesktopContextMenu.tsx` 的再导出即可删除。

## 第七轮（INT `fe5feb68`）

| 项 | 提交 |
|---|---|
| 前任留下的未提交改动（交接 29 的场景数）：提交；因并行写入，提交里是前任的“8”，随即订正为 13 | `0efdb8a3`、`fcba94bc` |
| 合并 INT `fe5feb68` | `7facff57` |
| `RF-W18-app-menu-open-focus-race`：菜单进入过渡结束时不再抢回已进入本菜单的焦点 | `7cce90ac` |
| FE-B9 取证：学习桌面快捷方式图标右键菜单 | `5a3c04d0` |
| FE-B9：学习桌面快捷方式图标右键菜单并入 `app.menu`（`workbench.desktopShortcut`） | `b59336fe` |
| FE-B9 取证：资源库桌面视图右键菜单（快捷方式卡片、空白处） | `86dd1172` |
| 进度：第七轮 | `e017dade` |
| 合并 INT `390f244b`（第五批），无冲突 | `0caecfd5` |
| 交接 22 收尾：菜单栏「退出学习桌面」经设置插件的 `workbenchMode` 服务写入；`plugin-import-boundary` 基线 87 → 86 | `faa099a9` |

### `editorExtensions.golden` 在服务器上失败

服务器那次全量跑在 INT `1fcc7743`，当时 `applyCrepePlugins` 是把全部条目展平后一次 `editor.use`；每条目一次 `use`（第四轮裁定）
由 `e0158a10` 恢复，已在 INT `fe5feb68` 里。本机在 `1fcc7743` 的写法下复现出同样的失败，差异只有 golden 的 `uses` 字段，
其余字段（插件顺序、schema、按键、remark、doc）相同；切回现行代码即通过。

装配侧逐项排查，没有找到依赖文件遍历、`readdir`、平台、时区或 locale 的地方：官方条目是静态 import 后按模块求值顺序宣告的
（`crepe/plugins/index.ts` 117–164 行、`commandMenus.ts` 93–94 行），不用 `import.meta.glob`；`order` 两两不同（10–200、10/20）；
装配路径上没有 `Intl`、`toLocale*`、`Date`、`navigator.*`。唯一与 locale 有关的是内核槽位排序的同序号兜底
（`src/ui-kernel/slots.ts` 94 行 `a.id.localeCompare(b.id)`），官方编辑器条目没有同序号，碰不到它；社区条目同序号时才会受影响，见交接 34。
本 lane 路径内没有需要改的地方，golden 未改。

### `AppMenu.keyboard` 在服务器上失败（`7cce90ac`）

审计 V10 记为负载的「does not reset submenu focus when its parent rerenders」是真实竞态：`AppMenuContent` 的打开聚焦要等
`presence.shown`（进入过渡的两帧）后才排定时器，回调不看当前焦点。两帧之内焦点已进入子菜单项时会被拉回根菜单容器。
把 `requestAnimationFrame` 换成 1–5 ms 的定时器即可在本机稳定复现。修复：焦点已在同一 `data-app-menu-id` 的菜单里（且不是容器本身）时不再移动。
登记 `host/e2e/differential/rust-fixes/RF-W18-app-menu-open-focus-race.json`（proposed），测试 `AppMenu.openFocus.test.tsx` 4 例；
1/3/5/7/16 ms 帧均通过，去掉守卫或不按 menuId 区分时对应用例失败。

### FE-B9 学习桌面快捷方式图标菜单（`5a3c04d0` 取证、`b59336fe` 迁移）

- 取证 `official/menu/__tests__/desktopShortcutMenu.golden.test.tsx` + `__golden__/desktop-shortcut-menu.json`：资源、无类型资源、文件夹、
  快捷入口、应用、教材 6 种快捷方式，各记录图标与菜单 DOM、行、每行点击后的副作用（workbench / 拖放桥 / 通知、store、重命名框）、
  点击后与离场计时后的菜单状态；另录资源找不到时的通知与各种关闭方式（监听挂上前后的 Esc、内外按下、菜单上右键、
  右键另一图标、离场中右键同一图标重开）。有无 UI 内核各录一遍，迁移后原样通过。
- 契约（`menu.ts`，只追加）：`AppMenuContexts['workbench.desktopShortcut']` = `AppMenuDesktopShortcut`（`shortcutId`、`shortcutType`、
  显示名、`target`，以及 `closeMenu` / `open` / `beginRename` / `remove`）；`@/ui-sdk` 导出该类型。
- 官方行 `official/menu/desktopShortcutMenu.tsx`：`desktopShortcut:open`（10）、`desktopShortcut:manage`（20，分隔线 + 重命名 + 从桌面移除），
  原菜单每行都先关菜单再执行，故都是 `closeOnRun: false` 并先调 `closeMenu()`。随图标层加载时宣告，不进启动闭包，槽位快照不变。
- 宿主 `DesktopShortcuts.tsx`：菜单外壳（定位收拢、玻璃透镜、延迟挂监听、离场相位）不变，行改由 `useAppMenuRows` + `DeskMenuRow` 渲染；
  `closeMenu` 在离场计时未结束时忽略重复调用（插件行若既自己关又按默认关，原写法会留下一个孤儿计时器把随后重开的菜单关掉；官方行不会重复关）。
  `DesktopContextMenu.tsx` 不再再导出 `ActionItem`（交接 31 收尾）。
- 测试 `desktopShortcutMenu.test.tsx` 4 例：官方行属主；社区行按 order 插入、上下文带快捷方式信息、按类型出行、先关后做的行、卸载后消失；
  重复关闭不误关下一次菜单；抛错隔离与报告。变异：去掉 `danger`、「打开」不关菜单、两组 order 对调，取证均失败；去掉 `closeMenu` 守卫，重复关闭用例失败。

### 盘点：还没走注册表的菜单、编辑器扩展点、快捷键登记点

| 位置 | 现状 | 结论 |
|---|---|---|
| 菜单栏、Dock 项、桌面右键、笔记树、Finder 资源菜单 | 已在 `app.menu` / `resource.contextMenu` | — |
| 学习桌面快捷方式图标菜单 | 本轮迁入 | `b59336fe` |
| 资源库桌面视图菜单（`learning-hub/components/finder/DesktopView.tsx` 177–285 行） | 固定行 | 取证已录（`86dd1172`）；迁移受契约形状阻塞，交接 32 |
| 资源库标签栏右键菜单（`learning-hub/components/TabBar.tsx` 323–414 行） | 固定行、自有样式 | 同上受阻，未录取证 |
| `StatusBarMenu.tsx`、`AppMenu.tsx` | 菜单栏下拉外壳（行已来自 `app.menu`）；共享渲染组件 | 无登记表可迁 |
| `editor.extensions`、`editor.slashMenu` | 已走槽位 | — |
| 选中浮条（`CrepeEditor.tsx` 1946 行，宿主经 `selectionActions` prop 传入） | 无槽位 | 需新槽位（W17），交接 33 |
| 块手柄菜单（`CrepeEditor.tsx` 108–130 行动作表 `BLOCK_MENU_ACTIONS`，2875–2926 行渲染）、移动端块菜单（`blockCommandMenu.ts`） | 固定表 | 不在装配段（W09）且需新契约，交接 33 |
| 官方 diff 视图（`officialDiffAdapter.ts` 76–79 行） | 直接 `editor.use` 固定子集 | 社区 schema 进不了 diff 编辑器；W09 路径，交接 33 |
| 命令快捷键 | 全部经 `ctx.ui.commands`（FE-B1） | — |
| 工作台窗口快捷键（`workbench/core/shortcuts.ts` 138–338 行，`useWorkbenchShortcuts.ts`） | 固定表 + switch（按住循环、松开提交） | 不迁：并入命令会让命令面板与快捷键设置页多出条目。与社区命令同键时窗口快捷键先赢（window 捕获阶段 `stopPropagation`，命令面板在冒泡阶段收不到），确定 |
| `useNavigationShortcuts.ts`（Alt+←/→、鼠标侧键） | `nav.back/forward` 已是命令，这里是有意保留的补充 | 不迁 |
| 其余约 90 个文件里的 `keydown` | 组件内 Esc、方向键等局部交互 | 不是快捷键登记点 |

资源库这两处的阻塞：`AppMenuContext<M>`（`menu.ts` 163 行）给每个上下文都加 `workbench`，其实现在
`features/workbench/components/appMenuHost.ts`。learning-hub 引用它会让 `cross-feature-import`（DesktopView → workbench）基线 3 → 4，
而基线只能减少；经插件 `api.ts` 转出又会在插件目录里新增 `plugin-import-boundary`。不放宽门禁，留待契约调整。

### 审计条目

- V10「`archiveSessionToastNavigationContract.test.ts` 契约漂移（源码变更 W17/W18/W09）」：它读的三个文件
  （`pendingSettingsTab.ts`、`Settings.tsx`、`DataGovernanceDashboard.tsx`）没有任何 W18 提交，断言的 `tabTarget={dataGovernanceTabTarget}`
  已随设置分区插件移走（见 `official/settings/__golden__/settings.json` 162 行），与本 lane 无关，只记录。

### 交接 22 收尾（`faa099a9`）

INT `390f244b` 带上了 W09 `9a323529`。`workbenchMenus.tsx` 不再引用 `features/settings`，退出行改为
`workbenchMode.setEnabled(false)`（`@/ui-plugins/official/settings/api`）。设置模块在启动时已提供该服务，此时调用同步转给
`persistWorkbenchModeEnabled`，停用预检与 handoff 仍在设置功能里。`menubar.golden` 改为 mock 这个服务，golden 未改且照常通过
（退出行记录的副作用仍是 `['persistWorkbenchModeEnabled', false]`）。`ui-boundaries.mjs --write-baseline` 只删掉这一条 stale 项
（diff 为 6 行删除），`plugin-import-boundary` 87 → 86，`--check` 0 新增、0 stale。菜单插件里已没有指向 `src/features` 的引用。

### 第七轮检查（tip `faa099a9`，含 INT `390f244b`）

| 检查 | 结果 |
|---|---|
| 相关单测 28 个文件（菜单插件 9 个、AppMenu 5 个、Dock / 桌面快捷方式 / `tests/vitest/workbench` 6 个、启动与工作台闭包、槽位快照、W16 `workbenchMenus` / `editorExtensions` golden、设置 `api.test.ts`） | 145 例全部通过 |
| `ui-boundaries.test.ts`（`vitest.host.config.ts`） | 8 例通过 |
| `boundaries.mjs` | 0 违规 |
| `gate-checks/{import-cycles,ui-boundaries,frontend-invoke,event-emit,plugin-manifest,hardcoded-copy,rust-fixes}.mjs --check` | 全部退出 0；均 0 新增、0 stale；rust-fixes 79 条（77 approved、2 proposed），0 错误 |
| `scripts/plugins/{slot-snapshot --check,generate-contracts --check,check-boundaries}.mjs`、`npm run -s contracts:check` | 全部通过，槽位快照无更新 |
| `bin/heavy npx tsc --noEmit -p tsconfig.json` | 0 错误 |

本轮曾不经 `bin/heavy` 以目录为参数跑过 vitest（菜单 `__tests__/`、`app-menu/`，约 12 秒），之后都改为显式文件列表。

### 第七轮交接

22. 完成（`faa099a9`）。
30. 更新：`menu.ts` 第 4 行首句还应提到桌面快捷方式图标菜单；`@/ui-sdk` 新增导出 `AppMenuDesktopShortcut`，请确认保留。
31. 完成（`b59336fe`）。
32. W17（`src/ui-kernel/contracts/menu.ts` 163 行 `AppMenuContext`）：只给 `workbench.*` 菜单加 `workbench`，
    或把工作台动作作为 UI 服务提供（learning-hub 可注入）。之后 W18 用 `86dd1172` 的取证迁资源库桌面视图菜单（新上下文
    `finder.desktop`、`finder.desktopShortcut`），再迁标签栏菜单。
33. 编辑器：W17（`src/ui-kernel/contracts/editor.ts` 45–46 行）若要社区扩展选中浮条与块菜单，需新槽位（如 `editor.selectionToolbar`、
    `editor.blockMenu`）；块菜单渲染在 `CrepeEditor.tsx` 2875–2926 行与 `blockCommandMenu.ts` 11–28 行，diff 视图在
    `officialDiffAdapter.ts` 76–79 行，均为 W09 路径。
34. W17（`src/ui-kernel/slots.ts` 94 行，73 行同理）：同序号兜底 `a.id.localeCompare(b.id)` 未指定 locale。
    `en-US` / `zh-CN` 与 `en-US-u-va-posix` 排序不同（`a_z a-z b-x B-y b.x` 对 `B-y a-z a_z b-x b.x`），本机 `LANG=C` 仍解析为 `en-US`，
    Linux 上未验证。官方条目 order 两两不同，现有 golden 不受影响；建议改为按码点比较。

## 第八轮（INT `390f244b` → `2be7ed80`）

| 项 | 提交 |
|---|---|
| FE-B9 取证：资源库标签栏右键菜单（迁移前 golden） | `dcaa0d82` |
| 五层基线：`ipc/skills-mcp` 启动步骤去掉 `listen:tauri://close-requested`（W16 / W28 交接） | `491876ef` |
| #23 复现：工作台笔记标签页里新建空白笔记，焦点落在正文（真实宿主链，`it.fails` 钉住） | `a1646095` |
| 合并 INT `2be7ed80`（C 批），无冲突 | `6d499082` |
| FE-B9 取证：桌面块手柄菜单与移动端块菜单（`editor.blockMenu` 迁移前 golden） | `922f646f` |

### 交接收集

`rg -n W18` 扫 `.reports/{agent-final,reviews,lanes,handoffs}/` 与 `INTEGRATION-NOTES.md`，本轮新增或未结的：

| 来源 | 内容 | 处理 |
|---|---|---|
| W28-1340 交接 W18 | `ipc/skills-mcp.json:10` 缺 `listen:tauri://close-requested`（监听来自 `vfsRefApiEnhancements.ts:742`，Tauri 专属） | `491876ef`：`regress.mjs --layer ipc --update --scenes skills-mcp` 连跑 3 次结果相同，只删这一行，`inventory.json` 未动，`--check` 通过 |
| W28-1340 F6 | W18 `690b91e2` 把 SOTA 注册行拆成三行 | 行为不变，W09 用 W09-5 补丁收，W18 无事 |
| W28-1340 / W16 | notes IPC 启动步骤 `notes_get_backlinks` #17 → #20 | 确认：起因是官方插件 `index.ts` 改从 `@/ui-sdk` 导入（插件边界规则要求），只改模块求值时序，调用集合不变；W16 已重录（`c4544af3`） |
| 前几轮 | `src/ui-plugins/testing/registries.ts:16` 的重复登记提示：现与 INT 内核（`legacy-adapters.ts:45`）一致，W17 `4982ee8f`（未进 INT）会改内核措辞 | 文件归 W16，交接 38 |
| W12-1354 #23 | 见下 | 交接 35、36 |
| W26-1349「未完成」 | 笔记启动期全文档重算 | 见下，交接 37 |

### #23：新建笔记后焦点留在 `.ProseMirror`

**根因（确定性，与构建形态无关）。** 新建笔记打开在 `focusOnActive` 的标签页（工作台笔记应用）里时，有两处各排一帧聚焦：

1. `NoteContentView.tsx` 818–823 行 `handleEditorReady`：编辑器报就绪且标签页激活，就 `requestAnimationFrame(() => api.focus())` 聚焦正文；
2. `NotesEditorHeader.tsx` 142–152 行：`autoFocusTitle` 为真时下一帧聚焦标题，但若焦点已在 `.ProseMirror` 里就放弃。

Tauri 快照里标题先排、正文约 80 ms 后抢走。W09 的 `RF-W09-new-note-title-focus` 让 `autoFocusTitle` 等 `editorApi`，
而 `editorApi` 与 `onEditorReady` 在同一个 `handleEditorReady`（`NotesCrepeEditor.tsx` 1818、1826 行）里设置，于是标题那一帧总排在宿主正文那一帧之后，
看到焦点已在正文就放弃。与懒加载顺序、StrictMode 双调用、rAF 节奏无关（StrictMode 下结果相同；该 effect 在更新时触发）。
W09 的单测 `fullDocument.host.test.tsx` 同时 mock 了 `NotesEditorHeader` 和 `CrepeEditor`，也不挂 `NoteContentView`，看不到这个竞争。

**生产构建证据**（demo 生产构建 `demo-app.html?app=notes`，真实 `NotesWorkspaceApp`，Playwright Chromium，新建 → 新建笔记后 1 s，键入 `PROBE`）：

| 构建 | 降频 | 次数 | 焦点 | 键入去向 |
|---|---|---|---|---|
| HEAD（产品代码同 `491876ef`） | 1× | 3/3 | `DIV.ProseMirror`（标题仍为「无标题笔记」） | 正文 |
| HEAD | 4× | 2/2 | `DIV.ProseMirror` | 正文 |
| HEAD + 交接 35 补丁 | 1× | 3/3 | `TEXTAREA.notes-document-title[笔记标题]` | 标题 |
| HEAD + 交接 35 补丁 | 4× | 2/2 | 标题 | 标题 |

focusin 时间线（1×）：修复前 `287ms BUTTON[新建] → 433ms DIV.ProseMirror`；修复后 `263ms BUTTON[新建] → 375ms TEXTAREA[笔记标题]`。
两版切回已有笔记的标签页时焦点都进正文（行为保持）。树右键菜单的 `restoreFocusAfterMenu` 只在焦点落在 body 时才还原，不参与竞争。

**测试**（`official/editor/__tests__/newNoteTitleFocus.test.tsx`，`a1646095`）：挂真实 `NoteContentView → NotesCrepeEditor → NotesEditorHeader`，
只把 Crepe 换成替身，替身像真实编辑器一样在挂载后的异步步骤里报就绪；分生产与 StrictMode 两种。新建空白笔记的 2 例用 `it.fails.each`
钉住现状（W09 修复后改 `it.each`，见交接 35 的补丁），已有内容笔记的 2 例照常断言焦点进正文。打上补丁后前 2 例转为「应失败却通过」，后 2 例照常通过；
补丁同时登记进 RF 的 `fix.files` 后 `rust-fixes.mjs --check` 0 错误；W09 相关 7 个测试文件 81 例在补丁下全部通过。

### 标签栏菜单（任务 3）

迁移前取证 `official/menu/__tests__/tabBarMenu.golden.test.tsx` + `__golden__/tab-bar-menu.json`（`dcaa0d82`）：`TabBar.tsx` 323–414 行。
桌面宿主（带分屏回调、右侧分屏为导图）与移动宿主（无分屏）；4 个标签（激活、分屏右侧、普通、固定且在末尾），另有单标签、触屏「更多」按钮和 12 种关闭方式。
记录：每个可用行同步触发一个回调并关菜单；禁用行（右侧只剩固定标签或没有标签时的「关闭右侧」、单标签时的分屏行）不触发回调，
菜单经 document click 监听关闭；焦点始终留在 body；Esc 关闭、其他键不关；内外点击、别处右键、触屏外按、滚动、Android 返回（消费为 true）都关闭；
右键另一个标签换成那一个的菜单；点另一个标签触发 `onSwitch` 并关菜单；触屏时菜单 `left: 8px; top: 8px`。有无 UI 内核各录一遍，结果相同。

INT `2be7ed80` 与 W17 `c46d4d3d` 的 `menu.ts` 136 行仍是 `AppMenuContext<M> = AppMenuContexts[M] & { t; workbench }`，没有放宽，
资源库桌面视图与标签栏两个菜单都不迁（交接 32 未结）。

### 笔记启动性能（任务 4）：只写分析

方法：W26 的 `playwright-measure` 脚本，demo 生产构建（HEAD `491876ef`），1440×900、zh-CN、reduce、CDP 4× 降频，trace 开 invalidationTracking；
另用 Playwright 记录编辑器 DOM 的挂载与每次 `focus()` 调用栈。

| 排查项 | 结果 |
|---|---|
| 编辑器重复初始化 / 重复装配 | 没有：1× 与 4× 各只建一个 `.ProseMirror`，`focus()` 只调一次；`CrepeEditor` 初始化 effect 只依赖 `noteId`，DSTU 模式下 `key` 稳定；每条目一次 `use` 是第四轮裁定的写法 |
| 聚焦引发的强制样式 | 一次 `focus()`（`handleEditorReady` 那一帧），原生 focus 内两次强制重算 118 + 72 ms（4×），分别是聚焦前的可聚焦性检查和 ProseMirror focus 处理器加 `ProseMirror-focused` 之后；`:focus-within` 沿 30 层祖先失效。聚焦本身不可省，时机属行为，不动 |
| `updateStateInner` 强制布局 236 ms | milkdown `syncHeadingIdPlugin`（preset-commonmark）在视图构造时派发标题 id 事务，Chrome 下 ProseMirror 读 DOM 选区触发布局；这是新文档的首次布局，下一帧本来要付，挪走不省 |
| `:has()` 引发的整树重算 | 有明确机制，但修复在 W09 路径（见下） |

**`:has()` 机制。** Chromium 把所有「`:has()` 不在主语位置」的规则合并成一个 `:has` 伪类失效集。下面 4 条选择器以 `> *` 结尾，使这个合并集变成「整棵子树失效」：

- `src/components/crepe/CrepeEditor.css` 488 行 `.crepe-editor-wrapper .task-list-item:has(input[type="checkbox"]:checked) > *`
- 同文件 489 行 `.crepe-editor-wrapper .milkdown-list-item-block li:has(.label.checked) .children > *`
- 同文件 579 行 `.dark …li:has(.label.checked) .children > *`
- `src/features/generative-ui/generative-ui.css` 112 行 `.generative-ui-compact > :where(div:has(> h3)) > * + *`

`div.milkdown` 与 `div.milkdown-code-block` 因合法规则被标为受 `:has` 影响（如 `.milkdown:has(.ProseMirror[data-block-selected]) .milkdown-toolbar`、
`.milkdown-code-block:has(> .codemirror-host.hidden) …`）。此后每往其下插入节点（块手柄、代码块预览、CodeMirror 行），
都按合并集把整棵 `.milkdown` 子树（约 2500 元素）重算一遍：trace 里 @3048、@4031、@4114、@4409 ms 四次各 68–71 ms。

**实验（不是方案）**：把上面 4 条选择器从构建产物 CSS 中删掉，与原构建交错各跑 3 次（4× reduce，机器负载约 30）：

| 轮次 | 原构建 样式 ms | 删 4 条 样式 ms | 就绪 ms（原 / 删） |
|---|---|---|---|
| 0 | 1169 | 1062 | 4476 / 4322 |
| 1 | 1429 | 1291 | 4716 / 4817 |
| 2 | 1464 | 1171 | 5022 / 4723 |
| 中位数 | 1429 | 1171（−258，−18%） | 4716 / 4723（噪声内） |

每组交错对都下降，重算次数不变（227），就绪时间不变。删规则会改变已勾选任务和生成式 UI 的样式，所以不是零视觉方案。
要零视觉变化，需要把状态挪到属性上再改选择器，涉及 W09 的两个 CSS 文件（另需本 lane 的一个 crepe 插件），写成设计交接 37。
`.crepe-editor-wrapper .task-list-item` 在编辑器里大概率不出现（启用了 `CrepeFeature.ListItem`，列表项由 list-item-block 节点视图渲染，
`.task-list-item` 只出现在聊天 markdown 渲染里），删除前需 W09 确认。

截图与 DOM golden `--check` 不需要前后对比：本 lane 没有改任何产品代码。

### 块菜单取证（任务 5，`922f646f`）

盘点结论不变：本 lane 路径里除标签栏与资源库桌面视图（交接 32 卡住）外的菜单都已走注册表；INT C 批没有新增未迁移的菜单或快捷键登记点。
选中浮条、块菜单、diff 视图只写设计（交接 39），块菜单的两个表面先录迁移前 golden：
`official/editor/__tests__/blockMenus.golden.test.tsx` + `__golden__/block-menus.json`，8 例，每例约 1 s 内。

- **桌面块手柄菜单**：挂真实 `CrepeEditor`（Crepe 启动按 W09 `CrepeEditor.blockMenu.host.test.tsx` 的方式替身，文档是真实 ProseMirror 视图），
  分别对 callout 里的嵌套列表项和顶层段落：菜单 DOM 按顺序（分组标题、分隔线、每行的命令、文字、禁用及原因、破坏性、tabIndex、图标）、
  键盘（手柄上 Enter 打开，方向键、Home/End、拉丁字母预输入）、每个可用行对文档的效果、Enter 执行当前行，以及 10 种关闭或不打开的情况（Esc、Tab、内外按下、窗口缩放、
  beforeinput、Android 返回（消费为 true）、可打印键、只读切换）。
- **移动端**：`openCrepeBlockCommandMenu` 配真实 SlashProvider，分别作斜杠菜单替身（`actions=false`）和块菜单：行、焦点、键盘、每行效果、9 种关闭方式；
  另录块菜单在顶层段落上打开时的焦点与键盘。
- 变异检查：交换桌面 `BLOCK_MENU_ACTIONS` 里的复制与删除，两个桌面用例失败；调换移动端插入项顺序，斜杠替身用例失败。均已还原。

**取证中发现的 Tauri 原有缺陷（W09 文件，交接 40）。** `src/components/crepe/blockCommandMenu.ts` 137 行打开时 `buttons[0]?.focus()`，
82 行方向键 `buttons[next].focus()`：禁用按钮拿不到焦点。块菜单的首行是「正文」，在段落上打开时（最常见的情况）它是禁用的，
于是菜单里没有焦点，74 行 `if (!menu.contains(document.activeElement)) return;` 让方向键全部失效；在列表项上打开时，End 与 ArrowUp 卡在末尾的禁用行之前。
golden 的 `mobile.blockMenuOnParagraph` 记录了现状：焦点为 body，6 次按键后仍为 body。该文件与 Tauri 快照 `21c9d808` 逐字相同。
桌面块手柄菜单按 `blockMenuActiveRef` 里的当前行索引导航（`CrepeEditor.tsx` 281、541–547 行），不看焦点在哪，禁用行也可成为当前行，不受影响。

### 第八轮交接

35. **W09（#23）**：`src/features/learning-hub/apps/views/NoteContentView.tsx` 820 行，同时更新 RF 登记并翻转本 lane 的测试。补丁（`git apply --check` 在 `6d499082` 上通过）：
    ```diff
    -    if (api && focusOnActiveRef.current && isActiveRef.current) {
    +    // RUST-FIX(RF-W09-new-note-title-focus): 空白可编辑笔记的首个焦点归标题（NotesEditorHeader autoFocusTitle）；
    +    // 这里先聚焦正文，标题那一帧看到焦点已在 .ProseMirror 就放弃
    +    if (api && focusOnActiveRef.current && isActiveRef.current && (api.isReadonly() || api.getMarkdown().trim())) {
    ```
    `host/e2e/differential/rust-fixes/RF-W09-new-note-title-focus.json`：`fix.files` 加 `src/features/learning-hub/apps/views/NoteContentView.tsx`，
    `fix.behavior` 末尾加「聚焦即激活的标签页（工作台笔记）里，宿主在编辑器就绪时不再先聚焦空白可编辑笔记的正文，否则标题那一帧看到焦点已在正文就放弃（#23）」，
    `tests` 加 `{ file: src/ui-plugins/official/editor/__tests__/newNoteTitleFocus.test.tsx, name: "RF-W09-new-note-title-focus (#23): a note opened in a focus-on-active notes tab" }`。
    `newNoteTitleFocus.test.tsx` 123–125 行：删两行注释，`it.fails.each` 改 `it.each`。
    验证：`DEEP_STUDENT_BUILD_NUMBER=20000 npx vitest run -c vitest.config.ts src/ui-plugins/official/editor/__tests__/newNoteTitleFocus.test.tsx --maxWorkers=2`（4 例通过）、
    `node scripts/electron-migration/gate-checks/rust-fixes.mjs --check`（0 错误）。
36. **W12**：35 进 INT 后，翻转 `host/e2e/smoke/__tests__/golden/03-notes.spec.ts` 126 行的 `test.fail`。生产构建探针显示补丁后 1 s 时焦点在标题、键入进标题。
37. **W09（性能，设计）**：去掉合并 `:has` 失效集里的整树失效，不改外观。
    - 已勾选列表项：W18 在 crepe 插件里加节点装饰，在 `div.milkdown-list-item-block` 上写 `data-has-checked="true"`，
      条件与现选择器完全相同（本项或任一后代列表项已勾选，即 `li:has(.label.checked)` 的语义）；W09 把 `CrepeEditor.css` 483、489–491、578–580 行的
      `.milkdown-list-item-block li:has(.label.checked) .children…` 改为 `.milkdown-list-item-block[data-has-checked="true"] .children…`
      （保留后代组合子：原规则对已勾选项下的嵌套 `.children` 同样生效）。
      488 行 `.task-list-item:has(…)` 若确认编辑器内不出现，可直接删除。
    - 生成式 UI：`generative-ui.css` 112 行，渲染器给标题组 `div` 加 `data-generative-ui-heading-group`，选择器改为 `.generative-ui-compact > [data-generative-ui-heading-group] > * + *`。
    - 验证：W16 截图与 DOM golden `--check` 前后一致；W26 测量脚本 4× reduce 交错 3 次，样式重算中位数应降约 250 ms，trace 中 `div.milkdown` 的 StyleInvalidator 不再出现 `allDescendantsMightBeInvalid`。
38. **W16**：W17 `4982ee8f` 进 INT 时，`src/ui-plugins/testing/registries.ts` 16 行提示跟着改为 `is already registered; use an id of your own`
    （与 `legacy-adapters.ts` 45 行一致）；在那之前保持现状。一行改动，没有测试断言替身这句话。
    验证：`DEEP_STUDENT_BUILD_NUMBER=20000 npx vitest run -c vitest.config.ts src/ui-plugins/testing/boot-golden.test.ts src/ui-plugins/testing/render.test.tsx --maxWorkers=2`。
39. **W17 + W09（编辑器三处扩展点，设计；细化交接 33）**。共同约定：社区条目抛错跳过并按槽位报告，编辑器照常打开；没有社区条目时 DOM、顺序、行为与现在逐项相同（先录取证再迁）。
    - **选中浮条 `editor.selectionToolbar`**（W17 在 `src/ui-kernel/contracts/editor.ts` 46 行后追加）：
      `interface EditorSelectionToolbarContribution { build(toolbar: SlashMenuBuilder, editor: EditorInstanceContext): void }`（复用 `SlashMenuBuilder` 形状，Crepe 的 `buildToolbar` 给的也是 GroupBuilder）。
      语义与斜杠菜单不同：Crepe 只在编辑器初始化时构建一次浮条，条目在新开的编辑器上生效，契约注释需写明。
      W18 落地（装配段）：`CrepeEditor.tsx` 1946 行改为 `buildEditorSelectionToolbar(entries, builder, editorInstance, report)`（仿 `editorSlots.ts` 115 行 `buildEditorSlashMenu`）；
      官方条目两条：`toolbar:editor-commands`（10，现 `commandMenus.ts` 53–56 行改写 `onRun`）与 `toolbar:host-actions`（20，现 59–76 行，读宿主 `selectionActions`，`types.ts` 302 行），宿主 prop 保留。
    - **块菜单 `editor.blockMenu`**：`interface EditorBlockMenuContribution { rows(target: EditorBlockMenuTarget, editor: EditorInstanceContext): readonly EditorBlockMenuRow[] }`，
      `EditorBlockMenuTarget = { surface: 'block-handle' | 'mobile-block' | 'mobile-insert'; nodeTypes: readonly string[]; depth: number; editable: boolean }`，
      `EditorBlockMenuRow = { id; label; order; destructive?; disabledReason?(): string | undefined; run(): void | Promise<void> }`。
      两个表面现在的行不同（桌面 `CrepeEditor.tsx` 123–130 行：11 种转换 + 复制 / 删除 / 块链接 / 移到笔记 + 6 个布局；移动 `blockCommandMenu.ts` 85–129 行：含 4–6 级标题、无块链接与移到笔记；`actions=false`（兼作斜杠菜单）时先列 5 个插入项、不含复制与删除），
      所以用 `surface` 让官方条目逐表面复现现有列表，不合并。渲染在 `CrepeEditor.tsx` 2875–2926 行（键盘导航 542–563 行按行数组走，不再用 `BLOCK_MENU_ACTIONS`）与 `blockCommandMenu.ts` 110–129 行，均为 W09 路径。
    - **diff 视图**：`officialDiffAdapter.ts` 76–77 行固定 `use` 官方子集，社区 schema 的节点在审阅投影里解析失败（`candidate_unparseable`）。
      建议 W17 给 `EditorInstanceContext` 加 `purpose: 'editor' | 'diff'`，`editor.extensions` 条目按需对 `'diff'` 只返回 schema / remark 插件；
      W09 在 76–77 行的官方子集之后追加 `purpose: 'diff'` 的社区条目，官方子集与顺序不变。
    - 验证：`editorExtensions.golden`（W16）与 `editorSlots.test.ts` 不变；每处新增「社区条目按 order 插入、卸载后消失、抛错隔离」用例；块菜单两个表面的迁移前取证已录（`922f646f`，`blockMenus.golden.test.tsx`），迁移后应逐键相等。
40. **W09（移动端块菜单的禁用行焦点，Tauri 原有缺陷，建议登记 `RF-W09-mobile-block-menu-disabled-focus`）**：`src/components/crepe/blockCommandMenu.ts` 74–83 行与 137 行。补丁（`git apply --check` 在 `922f646f` 上通过）：
    ```diff
    -    if (!menu.contains(document.activeElement)) return;
    -    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    -    const next = event.key === 'ArrowDown' ? (index + 1) % buttons.length
    -      : event.key === 'ArrowUp' ? (index + buttons.length - 1) % buttons.length
    -        : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : -1;
    +    // RUST-FIX(RF-W09-mobile-block-menu-disabled-focus): 禁用行拿不到焦点，导航只走可用行；
    +    // 否则焦点卡在禁用行前，或菜单里没有焦点时方向键失效
    +    const enabled = buttons.filter((button) => !button.disabled);
    +    if (!enabled.length || !menu.contains(document.activeElement)) return;
    +    const index = enabled.indexOf(document.activeElement as HTMLButtonElement);
    +    const next = event.key === 'ArrowDown' ? (index + 1) % enabled.length
    +      : event.key === 'ArrowUp' ? (index + enabled.length - 1) % enabled.length
    +        : event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1 : -1;
         if (next < 0) return;
         event.preventDefault();
         event.stopPropagation();
    -    buttons[next].focus({ preventScroll: true });
    -    buttons[next].scrollIntoView?.({ block: 'nearest' });
    +    enabled[next].focus({ preventScroll: true });
    +    enabled[next].scrollIntoView?.({ block: 'nearest' });
    @@ provider.onShow
    -    buttons[0]?.focus({ preventScroll: true });
    +    // RUST-FIX(RF-W09-mobile-block-menu-disabled-focus): 首行禁用（段落上的「正文」）时聚焦第一个可用行
    +    buttons.find((button) => !button.disabled)?.focus({ preventScroll: true });
    ```
    （`!enabled.length` 的守卫是因为菜单容器 `tabIndex = -1` 可以自己拿焦点，全部禁用时取模会得到 NaN。）
    RF 登记：`rust.file` 同上、`rust.line` 137，`fix.files` 同上；测试由 W09 在 `src/features/notes/mobileEditorCommands.block.test.tsx` 加一例，名称以
    `RF-W09-mobile-block-menu-disabled-focus:` 开头（在段落上打开块菜单，焦点落在第一个可用行，方向键跳过禁用行）。
    打补丁后：W09 的 `mobileEditorCommands.block.test.tsx` 8 例通过；本 lane 的 `blockMenus.golden.test.tsx` 只有三段移动端的 `focus` 字段变化（共 16 处：
    斜杠替身打开时 body → math 及 6 次按键，块菜单 End / ArrowUp 两处改为 delete，段落上打开时 body → heading-1 及 6 次按键），桌面三段与两段关闭方式不变。
    这三段是 golden 记录的现状，补丁进 INT 的同一批里由 W18 重录（只允许这 16 个 `focus` 字段变化，差异贴进提交），或 W09 在同一提交里带上重录。
    验证：`DEEP_STUDENT_BUILD_NUMBER=20000 npx vitest run -c vitest.config.ts src/features/notes/mobileEditorCommands.block.test.tsx src/ui-plugins/official/editor/__tests__/blockMenus.golden.test.tsx --maxWorkers=2`、
    `node scripts/electron-migration/gate-checks/rust-fixes.mjs --check`。

32、34 仍未结（INT `2be7ed80` 的 `menu.ts`、`slots.ts` 未变）；33 由 39 细化。

## 第九轮（INT `1d1fdb78`）

| 项 | 提交 |
|---|---|
| 交接 37（W18 半边）：`editor:list-item-has-checked` 在列表项块上写 `data-has-checked`（只有属性，不改样式） | `cb00ac71` |
| 基线：`editorExtensions` 装配 golden 加 `editor:list-item-has-checked` | `d933152d` |
| 基线：notes DOM golden 已勾选列表项块带 `data-has-checked="true"`（desktop 2106 行、mobile 1883 行，各一行） | `8c05e57a` |
| 合并 INT `1d1fdb78`，无冲突 | `ba5e04fd` |
| F-B1 / F-B2（W18 半边）：`CrepePluginsOptions`、`LearningHubContextMenuProps` 只搬类型 | `3dedd9b9` |
| 测试：官方命令快捷键不与工作台窗口快捷键重合（macOS ⌘ 与 Ctrl 回退、非 macOS） | `d91e81e9` |
| 测试：评审 F6（debug-panel 替身指向 `CrepeEditor` 实际导入的模块）、F5（#23 加一条普通前置用例） | `89c16b59` |
| 测试：`editorAssembly.golden` 给 `editor:list-item-has-checked` 打标签（`cb00ac71` 后此 golden 一直红，漏刷） | `74fdc5b2` |
| 基线：`editor-assembly.json` 14 处在 `crepeCommandBindings` 后加 `listItemHasChecked`（56 行纯增） | `db8c464d` |
| 测试：`editorUseBatching` 的官方栈规模随 `cb00ac71` 改为 21 条目 / 54 个插件（同样漏改，精确值更正，不放宽） | `0a42976e` |

### 交接收集

`rg -n W18` 扫 `.reports/{agent-final,reviews,lanes,handoffs,server}/` 与 `INTEGRATION-NOTES.md`：

| 来源 | 内容 | 处理 |
|---|---|---|
| W17-1358 | `src/ui-plugins/testing/registries.ts` 提示措辞 | 文件归 W16，仍是交接 38 |
| 前几轮 22、31 | — | W18 侧已完成 |
| W28 TRIAGE F-B3 | `AppMenu.keyboard` 服务器红 | v3 改判真缺陷，`7cce90ac`（RF-W18-app-menu-open-focus-race）已在 INT `1d1fdb78` |
| W28 TRIAGE F-B4 | `notesTreeMenu.golden` ×6 | C 趟已修（W16 `12dbc1be`） |
| W28 TRIAGE F-B1 / F-B2 | `sdk.types`、`resource-menu.types` 超时：两条 `import type` 把整个前端拉进类型测试的程序 | W18 半边本轮提交，W17 半边交接 43 |

### 资源库桌面视图与标签栏菜单（交接 32）：补丁

W17 `19ab0479`（`AppMenuContext` 只给 `workbench.*` 菜单带 `workbench`）不在 INT，于是在临时工作树（`d933152d` + 摘取 `19ab0479`）里迁移，输出
`.reports/W18-handoffs/W18-menus-after-W17-19ab0479.patch`（`git format-patch`，2 个提交），工作树已 `git worktree remove --force`。

- 补丁 1（契约，归 W17 应用）：`src/ui-kernel/contracts/menu.ts` 加 `finder.desktop`、`finder.desktopShortcut`、`finder.tab` 三个上下文
  （`AppMenuFinderDesktop`、`AppMenuFinderDesktopRoot`、`AppMenuFinderDesktopShortcut`、`AppMenuFinderTab`）；`src/ui-sdk/index.ts` 一行类型导出。
- 补丁 2（W18）：官方行 `official/menu/finderDesktopMenu.tsx`、`tabBarMenu.tsx`（视图 / 标签栏加载时向 `dstu.ui.menu` 宣告）；
  宿主 `learning-hub/components/appMenuHost.ts` 的 `useFinderMenuRows`（有内核读槽位，没有就用同一份官方行；社区错误报给内核）；
  `DesktopView.tsx`、`TabBar.tsx` 保留菜单外壳、关闭和定位，用原来的标记渲染行（根文件夹信息行仍在空白处菜单的行之后）。
  新增 `finderMenus.test.tsx` 6 例：官方条目；社区行按 order 插入、上下文不带 `workbench`、执行后关闭、`closeOnRun: false`、禁用 / 勾选、卸载；抛错的行跳过并报告，执行抛错也报告。
- 两份 FE-B9 golden（`finderDesktopMenu.golden`、`tabBarMenu.golden`）无内核与有内核两种模式逐键相等，没有重录。
  变异检查：标签栏行的属性顺序规则（`open-right` 行 `disabled` 在 `className` 前）改掉后 golden 失败；有内核时行确实取自槽位而不是官方常量。均已还原。
- 应用前提：树里有 W17 `19ab0479` 和本 lane 的 `tab-bar-menu.json`（`dcaa0d82`）。在 INT、W17 tip、HEAD 上 `git apply --check` 都卡在 `menu.ts`（缺 `19ab0479`），属预期。
- 验证命令写在补丁 2 的提交说明末尾（5 个测试文件、`tsc -p tsconfig.json`、`ui-boundaries` / `import-cycles` / `slot-snapshot --check`）。
- INT 上 W17 FE-B2 证据 `chatPlugins.golden.test.tsx` 在打补丁与不打补丁的 HEAD 上都红（OverlayScrollbars 类名顺序），不归本 lane，只记录。

### 交接 37：W18 半边与测量

`editor:list-item-has-checked`（order 210）：`tr.docChanged` 时重算，对「本项或任一后代列表项已勾选」的 `list_item` 加 `Decoration.node`，
属性落在节点视图根 `div.milkdown-list-item-block` 上。`listItemHasChecked.test.ts` 在真实 Crepe DOM 上逐元素比对：
带属性的块集合 = `li:has(.label.checked)` 命中的 `li` 所在的块集合（勾选、取消、嵌套、粘贴、撤销）。没有样式改动，外观不变；
DOM golden 只多了属性（`8c05e57a`），截图层不涉及。

W09 的 CSS 补丁写在 `.reports/W18-handoffs/W09-has-selector-css.patch`（交接 42），测量与比较脚本在旁边的 `W09-has-selector-measure/`。

`cb00ac71` 漏刷了本 lane 自己的 `editor-assembly.json`（FE-B5 证据 golden）：新插件在 7 种选项 × 2 种模式里都多出一个未打标签的条目，
这份 golden 从 `cb00ac71` 起一直红。本轮补了标签（`74fdc5b2`）和 golden（`db8c464d`，14 处纯增），没有别的变化。
同一原因漏改的还有 `editorUseBatching.test.ts`（FE-B5，`5dbfb11b`）钉住的官方栈规模：20 → 21 次 `use`、53 → 54 个插件，带社区条目时 22 → 23、55 → 56（`0a42976e`）。
两处都是交付前跑本 lane 目录（`src/components/crepe`、`src/ui-plugins` 等 116 个文件）时发现的。

**测量**（W26 第二轮 `playwright-measure.mjs`，notes 场景，4× 降频，reduce，四份构建在每轮内交错，3 轮中位数，本机负载约 26）。
A 不带装饰；C 为 HEAD（只有装饰）；B 为 C 加 W09 补丁但保留 `.task-list-item:has` 两行；B2 为 C 加完整补丁：

| 构建 | 就绪 ms | 样式重算 ms / 次 | 布局 ms | 长任务 ms |
|---|---|---|---|---|
| A | 5190 | 1374 / 189 | 317 | 3688 |
| C | 4989 | 1390 / 189 | 301 | 3519 |
| B | 4863 | 1346 / 190 | 303 | 3482 |
| B2 | 4575 | 952 / 190 | 305 | 3035 |

B2 三轮 952 / 1018 / 942 ms，A 三轮 1374 / 1361 / 1449 ms，区间不重叠：样式重算 -31%，就绪 -12%。
失效追踪（`W26_INVALIDATION=1`，各 1 轮）：整棵子树失效事件 A 54、B 54、B2 42；落在 `div.milkdown` / `.milkdown-code-block` 上的 A 7 / 5、B 7 / 5、B2 0 / 0；
重算元素总数 A 28916、B 28879、B2 16287。B 与 A 没有差别：只要合并失效集里还有一条 `> *` 结尾的 `:has` 规则（488 行），整树失效就还在，
所以补丁里 482、488 行必须删（不是可选）。

**外观不变的证据**：真实 Chromium 里逐元素比较全部计算样式（属性名排序），notes 场景 desktop（2384 个元素）/ mobile（1891 个元素）× light / dark，
以 C 为参照，再加载一次的 C、A、B2 都没有差异（包括已勾选项的删除线和 muted 颜色）。只有 desktop dark 参照页两个代码块 `.language-picker` 的 top / bottom 差 1–5 px：
这两个值由脚本定位，三个对照彼此相同、只有参照页不同，属于加载噪声。生成式 UI 一侧：打补丁后 `components.json` 的 40 份渲染里，
根节点下「div 且有直接子 h3」与「带 `data-generative-ui-heading-group`」的元素集合相同（38 处，0 处不一致）；golden 的 38 行差异去掉这个属性后逐字相同。

### #23（任务 4）

INT `1d1fdb78` 不含 W09 的修复（`NoteContentView.tsx` 820 行未变），`newNoteTitleFocus.test.tsx` 保持 `it.fails.each`，本轮合并后跑过：4 例通过（其中 2 例 `it.fails` 按预期失败）。

### Linux 前端红（任务 5）

TRIAGE fe 段归 W18 的：F-B3 已修（见上）；F-B1 / F-B2 做了 W18 半边：

- `CrepePluginsOptions` 搬到 `src/components/crepe/plugins/options.ts`（只依赖 `columns/config`、`wikilink/types`、`mention/types`），`plugins/index.ts` 原样再导出；
- `ContextMenuTarget`、`LearningHubContextMenuProps` 搬到 `src/features/learning-hub/components/LearningHubContextMenu.types.ts`，组件文件原样再导出。

只搬类型，运行时模块图不变（`import type` / `export type` 编译后消失）。W28 补丁的 `plugins/index.ts` 一段因 `cb00ac71` 多了一行导入而不能直接应用，按同样内容手工做。
单靠这一半可达文件数不变，要 W17 把两个契约文件的导入改到新文件（交接 43）。临时套上 W17 半边（未提交）验证：
`sdk.types`、`resource-menu.types` 2/2 通过，resource-menu 8.5 s、sdk 10.5 s（本机负载约 25；W28 在 INT `2be7ed80` 上不打补丁各约 150 s 超时），验证后已还原。

**主动排查本 lane 测试与 golden 里的平台不稳定模式**（67 个文件，`git log --grep '^\[W18\]'` 列出）：

| 模式 | 发现 | 结论 |
|---|---|---|
| locale 排序 | `appMenu.test.tsx` 55 行 `localeCompare` | 两侧用同一比较器、id 唯一且为 ASCII，不会出现相等比较，结果与 locale 无关；不改 |
| 时区 | 两处 `new Date(ms).toISOString()` | UTC 输出，与时区无关 |
| 文件遍历顺序 | `importGraph.ts` 32 行、`workbenchClosure.test.ts` 44 行 `readdirSync` | 前者 glob 结果排序、闭包是集合且输出排序；后者只过滤再判断成员；与顺序无关 |
| 字体度量 / 布局 | jsdom 下 `offsetWidth` 等一律替身为固定值；DOM golden 按平台分目录（notes 只有 darwin） | 无平台差异 |
| 定时器竞争 | `setTimeout(0)` 冲刷、受控 rAF、`nextFrames` 后再断言 | 都按到期顺序，不靠墙钟；`newNoteTitleFocus` 的 500 ms `waitFor` 在第 4 帧后才开始，焦点此时已定（替身经微任务报就绪），超时不决定通过与否 |
| **平台判定** | jsdom 默认 UA 是 `Mozilla/5.0 (${process.platform}) …`：`getPlatform()`（`src/utils/platform.ts` 13–31 行）在 macOS 的 vitest 里得 `'windows'`（`darwin` 不匹配任何分支，落到默认），在 Linux 得 `'linux'` | 本 lane golden 不经过 `isWindows()` / `isLinux()`：菜单栏 golden 渲染 `StatusBarAppMenus` / `StatusBarBrandMenu`（不读平台），快捷键文字走 `isMacOS()`（两边都是 false，均为 `Ctrl+Alt+D`）。但 `StatusBar.tsx` 206 行 `winChromeInset = isWindows()`、`App.tsx` 1639 行 `isWindows() && <WindowControls />` 在 jsdom 里会随宿主 OS 分叉，录这两处的 golden 在 Linux 上必红（交接 44，提示性质） |

### 交接 39 评审（W17 `a57be896` `EDITOR-EXTENSION-POINTS.md`，从宿主接线侧）

对照 `CrepeEditor.tsx`（HEAD `ba5e04fd`）与 `blockCommandMenu.ts` 现状逐条核对：

1. **`id` 渲染为 `data-command` 只对移动端成立。** 桌面行写的是 `data-block-command`（2894 行），移动端是 `button.dataset.command`（`blockCommandMenu.ts` 110–129 行）。
   `blockMenus.golden` 两个表面都录了属性名，迁移要逐键相等，所以契约应写「宿主按表面渲染（桌面 `data-block-command`、移动 `data-command`）」，不是固定 `data-command`。
2. **缺禁用原因。** 桌面禁用的块链接 / 移到笔记行带 `title={identityActionBlockedReason(...)}`（2899 行），golden 录了。需要 `disabledReason?: string`（有值时同时视为禁用），否则这条 golden 回不去。
3. **缺分组。** 桌面菜单顶部有「Turn into」标题，复制前有分隔线，第一个布局命令前有分隔线加「页面布局」标题（2884、2910–2919 行）；移动端没有标题和分隔线。
   扁平行 + order 段让宿主无从知道社区行该落在哪个分隔线里。建议按条目分组：`rows()` 返回 `{ label?: string; rows: EditorBlockMenuRow[] }`（或条目带 `label?`），
   桌面宿主在条目之间画分隔线、有 `label` 时画标题，移动端宿主不画；官方四条按现状给 `label`（turn-into 给「Turn into」、actions 不给、layout 给「页面布局」）。
4. **图标类型太窄。** 宿主渲染 `<ActionIcon className="crepe-block-menu__icon" size={16} aria-hidden="true" />`（2905 行），
   `ComponentType<{ size?: number }>` 不接受 `className` / `aria-hidden`，接线时会 TS 报错。改为 `ComponentType<{ size?: number; className?: string; 'aria-hidden'?: boolean | 'true' }>`（phosphor 的 `Icon` 可赋值）。
5. **官方行拿不到算禁用要的东西。** 桌面的 `disabled` 用 `canExecuteCrepeCommand(view, action, { target: blockMenu.target })`（2896–2898 行），
   `target` 是宿主内部的 `CrepeCommandTarget`（含 pos、node），块链接 / 移到笔记还要 `noteId`、`blockActionsHostRef`、`setBlockTransfer`（`runBlockAction` 481–525 行）。
   契约里的 `EditorBlockMenuTarget` 只有公开字段，`run(view)` 也只给 view。两种做法：（a）给 `rows` 一个每次打开时的上下文，带 `canExecute(id)`、`execute(id)`、`blockedReason(id)`
   这类动作（与 `app.menu` 的上下文同一思路）；（b）官方行由宿主模块（`src/components/crepe/` 内）构建，经按实例的 WeakMap 读内部目标，契约只服务社区行。
   W18 倾向（b）：契约不暴露内部目标，社区行只拿 view。
6. **「先关闭、焦点回编辑器、再调用」与现状不符。** 桌面 `runBlockAction` 是 `setBlockMenu(null)` 后直接执行，不调 `view.focus()`（只有 Esc / Tab 关闭时回焦点，527–575 行）；
   移动端是 `close()` → `executeCrepeCommand(...)` → `view.focus()`（执行在前、聚焦在后）。契约应只承诺「菜单关闭后调用」，焦点由宿主按表面保持现状；
   「目标仍是当前块、笔记没切换、非只读」的过期检查也留在宿主、在 `run` 之前。
7. **`mobile-insert` 兼作移动端斜杠菜单。** 今天社区的 `editor.slashMenu` 条目不出现在这里（`actions=false` 只列 5 个插入项）。契约 README 要写明：移动端插入菜单只读 `editor.blockMenu`，想两处都出现要各贡献一次。
8. **浮条。** 1946 行确认（`buildToolbar: builder => wireCrepeCommandMenu(builder, 'bubble', () => selectionActionsRef.current ?? [])`）；`active` 省略时补 `() => false` 必要（`commandMenus.ts` 66 行宿主行就是这样写的）。
   两点补充：`host-actions` 分组只在**初始化时**列表非空才建（`commandMenus.ts` 60–61 行），之后才传入的动作不会出现，契约注释的「在 `onRun` 里取最新」只对已建出的按钮成立；
   `build()` 暴露给社区条目后，它能改写内置按钮的 `onRun`（官方 `toolbar:editor-commands` 正是这样接命令表的，53–56 行），建议社区条目拿到的 builder 不含 `build()`，或契约注明不得改动非自己添加的项。
   `toolbar:host-actions` 要读宿主的 `selectionActionsRef`，同 5，官方条目放在宿主模块里经按实例的私有通道读取。
9. **diff 视图。** `officialDiffAdapter.ts` 76–78 行是固定栈，83 行 `await crepe.create()`；`purposes` 含 `'diff'` 的条目必须在 83 行之前 `use`。
   适配器是模块函数，拿不到槽位：条目和错误回调要由调用方（审阅组件）传进来，契约文档的接线位置要写这一点。
10. 新增两个槽位定义后 `slot-snapshot` 与 `official-slots.json` 的更新单独提交并贴差异（同意文档最后一行）。

### 大文件拆分（任务 6）

本 lane 路径里超过约 800 行的只有 `src/components/ui/app-menu/AppMenu.tsx`（1439 行）和 `CrepeEditor.tsx`（2946 行，只有装配段归本 lane，拆分由 W09 定）。
`AppMenu.tsx` 可按职责拆成三块：根菜单与内容（1–698 行）、子菜单（774–1183 行）、简单行组件（699–773、1184–1422 行）。但本轮不拆，证据：

- 6 个别的 lane 的源码契约测试按路径读 `AppMenu.tsx` 文本（`androidBackCoordinator.order.source.test.ts` 25 行、`androidBackCoordinator.menuThenPanel.test.ts` 166 行、
  `tests/vitest/appMenuCheckColorContract.test.ts` 8 行、`tests/vitest/transitions/AppMenuModelMentionSheet.contract.test.ts` 22 行、
  `AppMenu.workbenchGestureFollowers.source.test.ts` 11 行、`AppMenu.visualViewport.source.test.ts` 18 行），代码挪走就要改它们的读取路径；
- `src/button-audit/controlCatalog.ts` 560 行、`src/components/style-lab/scan-data.json` 246 / 374 行按文件登记控件；`tests/visual/__golden__/chunk-graph/main.json` 记录该文件大小。

拆分要先和这些文件的归属 lane 约好再做（改读取路径不放宽断言），记为 RF 之外的后续项。

### 快捷键 / 菜单测试加固（任务 6，`d91e81e9`）

`shortcutConflicts.test.ts` 原来只查命令面板内部重复。新增一组跨注册表断言：启动全部官方命令（30 条以上带快捷键），
把每条快捷键按命令面板的规则（`mod` 同时对应 ⌘ 与 Ctrl）展开成键盘事件，交给工作台窗口管理器的 `matchWorkbenchShortcut`，
在 macOS（⌘ 与 Ctrl 回退两路）和非 macOS 下都要求不命中任何窗口快捷键（否则一次按键会同时触发命令和窗口动作）。
自检先确认匹配器本身有效（`mod+alt+d` → `show-desktop`、`mod+w` → `close-window`）。9/9 通过；
变异检查：把 `global.reload` 改绑 `mod+alt+d` 后两个平台都失败，已还原。

### 评审 W18-dbb4ec72 的回应（结论「可合」）

- F5（`it.fails` 范围宽）：`newNoteTitleFocus.test.tsx` 加一条普通 `it.each`（production / StrictMode）：新空白笔记渲染出标题和正文两个输入框，焦点恰好移动一次且落在其中之一。
  这条在 W09 修复前后都成立，所以两条 `it.fails` 只可能因为焦点落点而「失败」，不会因为渲染出错而假绿。交接 35 的翻转行号（123–125 行）不变。`89c16b59`，6/6。
- F6（替身路径过期）：三份测试的 debug-panel 替身改为 `CrepeEditor.tsx` 66、69–73 行实际导入的 `@/debug-panel/channels/crepeEditor`、`channels/crepeImageUpload`，工厂不变。
  `89c16b59`；`blockMenus.golden` 8/8、`editorSlots.host` 3/3。跑 `editorAssembly.golden` 时发现它在 HEAD 上本来就红（与替身无关，见交接 37 一节），已补。
- F7（回退字符串无法经 golden 验证）：知悉，属提示性质，不改。
- W16-1613 §10.3：确认 notes 场景 IPC 次序变化是预期的。起因是 `e0158a10` 让 `official/{editor,menu}/index.ts` 第 1 行改从 `@/ui-sdk` 导入（插件边界规则要求），
  只改变模块求值时序，不增删调用；`notes_editor_register(noteId)` 登记为 `unordered` 正确（第八轮交接收集里已对 W28-1340 说明过同一起因）。

### 第九轮交接

41. **W17 或 W18（交接 32，ORCH-LOG 16:10 的决定）**：整份 `.reports/W18-handoffs/W18-menus-after-W17-19ab0479.patch`（`git am`，2 个提交）由先完成本轮的一家在下一轮第一项应用，
    对另一家的文件临时归属，范围只限这份补丁。前提：W17 `19ab0479` 已在树里（否则补丁 1 卡在 `menu.ts`）。
    验证：补丁 2 提交说明末尾的命令（5 个测试文件、`tsc -p tsconfig.json`、`ui-boundaries` / `import-cycles` / `slot-snapshot --check`）。
42. **W09（交接 37 的 W09 半边）**：`.reports/W18-handoffs/W09-has-selector-css.patch`。
    源码：`CrepeEditor.css` 481–494、576–580 行，`generative-ui.css` 112 行，`GenerativeUIRenderer.tsx` 364 行。
    golden：`src/features/generative-ui/__golden__/components.json`，单独提交。
    482、488 行必须删；在 W18 `db8c464d` 上 `git apply --check` 通过。等价证据、测量、两步应用与验证命令都在补丁头。
43. **W17（W28 TRIAGE F-B1 / F-B2 的契约半边）**：`.reports/W18-handoffs/W17-typetest-contract-imports.patch`，
    `src/ui-kernel/contracts/content.ts` 2 行、`contracts/editor.ts` 3 行的 `import type` 改指 W18 `3dedd9b9` 的两个只含类型的模块。
    前提 `3dedd9b9`；W18 套上验证 2/2 通过（8.5 s / 10.5 s）。
    验证：`DEEP_STUDENT_BUILD_NUMBER=20000 bin/heavy npx vitest run -c vitest.config.ts src/ui-sdk/__tests__/sdk.types.test.ts src/ui-kernel/__tests__/resource-menu.types.test.ts --maxWorkers=2`。
44. **W16 / W28（提示）**：jsdom 默认 UA 含 `process.platform`，`getPlatform()` 在 macOS 的 vitest 里是 `'windows'`、在 Linux 是 `'linux'`。
    `src/features/workbench/components/StatusBar.tsx` 206 行 `winChromeInset = isWindows()`、`src/App.tsx` 1639 行 `isWindows() && <WindowControls />` 因此随宿主 OS 分叉，
    录了这两处的 golden 在 Linux 上会红。建议录这类 golden 的测试固定 `globalThis.__DS_PLATFORM__`（壳桥用的覆盖口）或替身 `@/utils/platform`。
    本 lane 的 golden 不经过这两处（已逐个核对）。验证：`rg -n "isWindows\(\)" src/App.tsx src/features/workbench/components/StatusBar.tsx`。

仍未结：35（W09，#23，`NoteContentView.tsx` 820 行未变，补丁仍适用；本 lane 测试的翻转行 123–125 不变）、
38（W16，`registries.ts` 16 行措辞，等 W17 `4982ee8f` 进 INT）、32 由 41 承接、34 同第八轮。
