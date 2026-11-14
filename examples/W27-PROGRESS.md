# W27 社区示例插件进度

分支 `assault/W27-examples`，起点 INT `6c491e6f`。负责路径：`examples/**`；plugin-manifest 基线里 examples 的条目（只删不增）。

## 第 1 轮（2026-11-07 12:16 起）

开工时的状态：
- `plugin-manifest.mjs --check`：6 条基线（manifest-missing 1：community-web-search；schema 5：community-word-of-day）。
- `src/ui-kernel/__tests__/community-example.test.tsx`（W17）3/3 失败：Host 按 v1 清单筛查社区模块，旧清单被拒，
  UI 清单里没有这个插件。与服务器独有的根目录 `example/`（快照未带）无关，测试不引用它。
- `scripts/electron-migration/contracts/community-web-search-example.test.ts`（W09）1/1 失败：社区模块用 `dstu.browser`
  覆盖官方插件，v1 下 `dstu` 只给应用内模块用（`ID_RESERVED`），且模块旁没有 package.json。
- `examples/plugins/translation-custom.mjs` 是 Cordis 之前的试点运行时（`src/plugin-runtime/host.ts`）格式，
  没有引用、没有测试，依赖不存在的 `.plugin-build/`。

计划：
1. word-of-day 迁到 v1（`example.word-of-day`、顶层 engines `^0.11`、服务名 `exampleWordOfDay`、i18n 用派生命名空间）。
2. web-search 改成 v1 写法（`example.web-search`，不再冒用官方 id，提供自己的派生服务，带 `Config`）。
3. translation-custom 移植成 v1 Host 插件（声明 `service:translation` 权限并注入）。
4. 每个示例一组本机测试；`examples/README.md`；删基线条目；交接。

结果（12:40）：
- 三个示例都是 v1 包：`example.word-of-day`（Host + UI）、`example.web-search`（Host，`Config`）、
  `example.translation-prompt`（Host，`service:translation` 权限 + inject）。旧的 `translation-custom.mjs`、
  `translation.profile.json`、`community-web-search/profiles/` 已删。
- plugin-manifest 基线 6 条全删，`entries: []`；`--check`：3 个示例包，0 known / 0 new / 0 stale。
- 测试：`DEEP_STUDENT_BUILD_NUMBER=20000 npx vitest run -c examples/vitest.config.ts`，4 个文件 37 个用例
  （word-of-day 9、web-search 6、translation-prompt 6、conformance 16）。
- 严格模式（本机临时把 `src/ui-kernel/kernel.ts:504` 的 `apiVersion >= 2` 条件去掉，跑完即 `git checkout` 还原、未提交）：37/37 通过。
- 构建检查发现并修了一个真问题：根 tsconfig 的 `"jsx": "react-jsx"` 盖过 esbuild 的 `--jsx=transform`，
  产物 import `react/jsx-runtime`（宿主不共享）。`build:ui` 加 `--tsconfig-raw={}`，conformance 用例守住。

交接：
- W17 `src/ui-kernel/__tests__/community-example.test.tsx`：26 行 `createTestHost()` → `createTestHost({ app: { version } })`
  （根 package.json 的 version；默认 `0.0.0-test` 是预发布版本，不满足任何 engines）；45、75 行 `community.word-of-day`
  → `example.word-of-day`；55 行期望 → `[['example.word-of-day/today', 'example.word-of-day']]`；56 行 `wordOfDay.open`
  → `example.word-of-day.open`；62、77 行 `'word-of-day'` → `'example.word-of-day/today'`；83、84 行 `host.wordOfDay`
  → `host.exampleWordOfDay`。另需 W09 的根 vitest 别名（下条）。按此改的副本在本机 3/3 通过（临时文件，已删）。
  不改的话现在在导入阶段失败（`Cannot find package '@deepstudent/ui'`），之前是清单被拒，两种都是 0/3。
  也可以退役它，改由 `examples/plugins/community-word-of-day/__tests__/word-of-day.test.tsx` 覆盖（同链路且更全）。
- W17 `src/ui-kernel/kernel.ts:504-507`：可以关掉 v1 回退，示例不受影响（证据见上）。
- W17 `src/ui-sdk/README.md:12`：示例 `id: 'community.study-stats'` 用了禁止的 publisher `community`。
- W09 `scripts/electron-migration/gate-checks/plugin-manifest.test.ts:206-211`：用例“real tree: the legacy example manifest
  is baselined until W17 migrates it”断言基线里还有 word-of-day 条目；示例迁完、基线清空后它失败（本分支 11/12）。
  建议改成断言示例都干净：`expect(r.summary.known).toBe(0)` 且 `r.baseline.entries` 里没有 `examples/` 开头的文件。
- W09 `vitest.config.ts:56-66`：alias 加 `'@deepstudent/ui': path.resolve(__dirname, 'src/ui-sdk/index.ts')`。
- W09 `scripts/electron-migration/contracts/community-web-search-example.test.ts`：同 id 覆盖在 v1 下被拒（`ID_MISMATCH`），
  19-20 行引用的 profiles 已删；建议退役，覆盖改由 `examples/plugins/community-web-search/__tests__/web-search.test.ts`。
- W09/W06 CI：`examples/vitest.config.ts` 不在任何 CI 任务里（`.github/workflows/ci.yml:138` 只跑根配置）。
- 主 agent `docs/plugins/SDK.md`：14、45、60、154-168、206-219、352-353、365、393、401 行仍教“同 id 覆盖官方插件”，
  与 v1 矛盾（社区包写官方 id → `ID_MISMATCH`，清单 id 用 `dstu.*` → `ID_RESERVED`）。
- 主 agent `src/ui-plugins/ACCEPTANCE.md:253`（R6-09）：引用的 `ui.tsx:35` 现在是 `ui.tsx:60`；所述问题已由
  `src/ui-plugins/official/shell/navigation.ts:19-23` 的默认 placement 与 `renderNavigationIcon.tsx:15` 的缺图标处理解决。

## 第 2 轮（2026-11-07 13:00 起）

接手上一任 tip `b3f47fb5`，开工合 INT `6c491e6f`；交付前合 INT `fe5feb68`（无冲突）。

做了什么：
- CI：`.github/workflows/ci.yml` 末尾独立 `examples` 任务（manifest 门禁 + `examples/vitest.config.ts`）。
- 脚手架 `examples/scripts/create-plugin.mjs`（生成 Host + UI 或纯 Host 的 v1 包，生成物过 conformance、类型检查、
  manifest 门禁与生产装载），README「新建插件」一节。
- `docs/plugins/`：`SDK.md` 按 v1 重写（不再教同 id 覆盖；§3.3 列出与官方并存的正确做法），每条 API 写出处
  （`路径` `符号`）；`ARCHITECTURE.md`、`FRONTEND.md` 改到 v1，`FRONTEND-F1.md` 标注为历史规格。
- `examples/testing/docs.test.ts` 防文档过时：ts/tsx 代码块第一行写文件位置——已有文件则逐行核对是摘录，新文件则按
  Host / UI 设置严格类型检查（同目录代码块互相导入）；正文里 `路径[:行号]` 必须存在且行号不越界，紧跟路径的 `符号`
  必须在该文件里出现。变异验证：改坏代码块里的 API、路径、符号各一处，三处都报出文档行号。
- 新示例 `example.study-goal`：设置分区（`settings.sections` 槽位，带 `navigation` 进官方设置侧栏）+ 命令面板命令调
  Host 半远程方法；插件存储、复数文案、`CommandError` 结构化错误。测试经官方 `settingsNavigation` / `SectionContent`
  渲染、经真实命令注册表执行。
- word-of-day 新增用例：不带 placement / icon 的导航条目经 `shellNavigationItems` 进两端侧栏、`renderNavigationIcon`
  不渲染图标（R6-09 的证据）；`ACCEPTANCE.md:253` 更新行号与关闭说明。

### 覆盖面

测试：`DEEP_STUDENT_BUILD_NUMBER=20000 npx vitest run -c examples/vitest.config.ts`，9 个文件 95 个用例（第 4 轮）。

| 能力 | 公开接口 | 示例 | 守住它的测试 |
|---|---|---|---|
| v1 清单与筛查 | `package.json#deepStudent`；`host/kernel/manifest.ts` `checkPluginModule` | 四个示例、脚手架生成物 | `conformance.test.ts`、`create-plugin.test.ts`、manifest 门禁 |
| 提供自己的服务（与官方并存） | `meta.provides` + `ctx.provide` | 四个示例 | 各示例 Host 半用例 |
| 注入官方服务 | `permissions: ["service:<名>"]` + `inject` | translation-prompt | `translation-prompt.test.ts` |
| 插件配置 | `Config` + `Schema` | web-search、translation-prompt | `web-search.test.ts`、`translation-prompt.test.ts` |
| UI 半调 Host 半 | `meta.remote` + `ctx.ui.host` | word-of-day、study-goal、脚手架 | word-of-day（只开放声明的方法）、study-goal（经 `plugin:host\|call`） |
| 结构化错误 | `CommandError({ error_type, message, details })` | study-goal、脚手架 | study-goal（Validation 原样到 UI） |
| 文案 | `ctx.ui.i18n.addBundles` / `namespace`、`useT` | word-of-day、study-goal、脚手架 | word-of-day（派生命名空间隔离）、study-goal |
| 视图与导航 | `ctx.ui.views.register`、`nav.register`、`navigate` | word-of-day、脚手架 | word-of-day（含官方侧栏默认 placement） |
| 命令面板 | `ctx.ui.commands.register`（`execute` 返回 `{ success, message }`） | word-of-day、study-goal、脚手架 | study-goal（经 `commandRegistry.execute` 弹通知） |
| 设置分区 | `ctx.ui.contribute('settings.sections', …)` | study-goal | study-goal（经官方设置外壳渲染） |
| 插件存储 | `ctx.ui.storage`、`usePluginStorage` | study-goal | study-goal（键 `ds:plugin:<id>:…`） |
| Host 半的 SQLite（第 4 轮） | `service:storage` + `inject: ['storage']`、`ctx.storage.openFile` / `close`、`db.write` | study-goal | study-goal（重启后数据还在、缺存储服务时降级） |
| 插件状态（第 4 轮） | `createPluginStore(ctx, init, { persist })`、`usePluginStore` | word-of-day | word-of-day（写进插件存储，重装后读回） |
| 平台（第 4 轮） | `usePlatform()` | word-of-day | word-of-day（macOS / Windows / Linux 三种快捷键文案） |
| 自报错误（第 4 轮） | `ctx.ui.reportError` | word-of-day | word-of-day（错误记录内容；第 3 次后被卸载并记为停用） |
| 组件作用域 | `withPluginScope` | word-of-day、study-goal、脚手架 | 同上；脚手架生成的测试渲染视图（第 4 轮） |
| 设计系统 | `SegmentedControl`；`DsButton`、`DsDialog`（第 4 轮） | study-goal；word-of-day | study-goal；word-of-day（对话框打开、Escape 关闭） |
| Host 半缺席 / 被卸载 | 配对装载、`ctx.ui.host` 拒绝 | word-of-day、study-goal | word-of-day（缺席时扣下 UI 半）、study-goal（卸载后显示错误） |
| 资源右键菜单行（第 5 轮） | `ctx.ui.contribute('resource.contextMenu', …)`，`ScopedResourceMenuContribution` 加 `scopes: ['resource']`、函数形式的 `labelKey` / `labelParams`、`closeMenu` | study-goal（学习资源库里资源上的“学完了，记一个番茄钟”） | study-goal（经官方 `LearningHubContextMenu` 连同官方 content 插件的行渲染；文件夹、空白处、回收站不出现；Host 半拒绝计入错误预算；卸载撤销） |
| 聊天工具结果卡片（第 5 轮） | `ctx.ui.contribute('chat.toolResults', …)`，`placement: 'actions'`、`match: 'qualified'`、`when` | word-of-day（词典 MCP 工具 `define_word` 结果下方的“收藏”按钮） | word-of-day（经官方 `McpToolBlockComponent` 渲染；前缀匹配、缺参数与失败回落通用视图、卸载撤销） |

没覆盖的及原因（第 5 轮更新：SDK §4 “其余 `ctx.ui` 接口”一表写明状态，下面几条以那张表为准）：
- `ctx.ui.settings.register`：参数类型（`src/ui-kernel/kernel.ts:438`）没有 `navigation`，这样登记的分区进不了设置
  侧栏，示例改用 `contribute`；交接 W17。
- 后端事件 / 插件自定义事件：社区插件调用 `ctx.backendEvents` 是 `KERNEL_API_FORBIDDEN`，派生的事件名也通不过检查，
  UI 半没有订阅接口（交接 W01、W17），`SDK.md` §5 只教 `ctx.on('host/window')`。
- `chat.toolResults` / `ctx.ui.chat`、`markdown.codeBlocks` / `ctx.ui.markdown`、`resource.contextMenu` /
  `ctx.ui.contextMenu`、`ctx.ui.workbench`：需要聊天、编辑器、资源树外壳，示例测试里没有；官方用法见
  `src/features/chat/plugins/official.ts`、`src/ui-plugins/official/menu/`。
- `declareSlot` / `defineSlot`：给框架插件用，声明不检查归属、不随卸载撤销，社区插件不该用（SDK §4）；`useSlot` /
  `SlotOutlet` 是外壳消费方的接口，示例测试里用了 `useSlotEntry` 模拟外壳。
- Host `agentTools`：不给社区插件用（SDK §3.4）。
- `ctx.ui.attach`：社区插件用不了（懒加载贡献点只能由 `@/ui-sdk/lazy` 创建，不在 `@deepstudent/ui` 里）。
- 第 5 轮：`chat.toolResults` 已有示例；`markdown.codeBlocks` 类型不随 SDK 导出；`chat.registerBlock/Event/Mode`、
  `workbench.registerApp` 的值类型直接是内部注册表类型；`resource.contextMenu` 可用但示例测试还没接菜单外壳。

### 交接（INT `fe5feb68` 上的行号）

上一轮的交接都还没在 INT 上处理。原因是 W27 的提交还没进 INT：这些改动要等迁过的示例落地才能改，否则先在
INT 上失败。在本分支上跑，下面三项失败都只因为示例已经迁过：
- W17 `src/ui-kernel/__tests__/community-example.test.tsx`：26、45、55、56、62、75、77、83、84 行仍用旧 id 和服务名；
  本分支上导入就失败（`Cannot find package '@deepstudent/ui'`）。W17 分支的 `bdd76587` 已改成从示例 meta 取 id
  和服务名，但没进 INT。
- W17 `src/ui-kernel/kernel.ts:504`：v1 回退。W17 分支的 `c7b3ba99`（`STRICT_COMMUNITY_NAMESPACES`，注释写明
  “W27 的示例进 INT 前为 false”）未进 INT；W27 进 INT 后可以打开，示例都只用派生命名空间。
- W09 `scripts/electron-migration/gate-checks/plugin-manifest.test.ts:206-211`：本分支 1/12 失败（期望基线里还有
  word-of-day）。
- W09 `scripts/electron-migration/contracts/community-web-search-example.test.ts`：本分支 1/1 失败（19-20 行的
  profiles 已删，同 id 覆盖在 v1 下被拒），建议退役。
- W09 `vitest.config.ts:56-66`：alias 仍没有 `@deepstudent/ui`。
- W17 `src/ui-sdk/README.md:12`：`community.study-stats` 用了禁止的 publisher。
- 主 agent / W09 `.github/workflows/ci.yml:459`：`examples` 任务（478 行）不在 `required.needs` 里。

本轮新增：
- W01 `host/kernel/plugin-id.ts:103-107` `pluginEventName` 生成的 `<id>:<event>` 带 `.`，`host/kernel/events.ts:38-40`
  `isEventNameValid` 不允许 `.`（93、122 行据此拒绝）。二选一：允许 `.`，或改派生规则。`host/kernel/API.md:907` 的例子
  `example.word-of-day:refreshed` 同样发不出。
- W01 `host/kernel/API.md:45`、`404`（同 id 覆盖官方插件）与 `774-780`（`community.word-of-day` / `wordOfDay`）仍是
  v1 之前的写法。
- W01 `host/kernel/profile.ts`：仓库外的插件没有可导入的运行时模块说明符（`@deepseek-ai/cordis` 等），社区服务只能
  `ctx.provide` 普通对象。
- W09/W01 `contracts/plugin-manifest/v1.schema.json:72`：说“log、本插件的存储隐式授予”，代码只授 `log`
  （`host/kernel/manifest.ts:234`，`API.md:931-932` 也写明 `storage` 不隐式授予）。
- W17 `src/ui-kernel/slots.ts:87`、`src/ui-kernel/legacy-adapters.ts:3`：报错和注释仍说“在 profile 里同 id 覆盖插件”；
  W18 `src/ui-plugins/testing/registries.ts:16` 同样。
- W17 `src/ui-kernel/kernel.ts:438`：`settings.register` 的参数类型缺 `navigation`；`SettingsSection` 没有从 SDK 导出。
- W17 `src/ui-sdk/index.ts`：没有订阅后端事件的接口。
- W09 `vitest.config.ts:27` 与 `vitest.setup.ts:3`：setup 先导入 `@testing-library/react`（react-dom），node 环境的
  测试之后才装 DOM，react-dom 认为没有 DOM，文本输入的 `onChange` 测不出（示例改用点击交互）。
- 提醒（未进 INT，不是交接）：W01 分支的 `e1e3e3fc`（SEC-E06 K1）落地后，社区插件调 `ctx.backendEvents.*` 会以
  `KERNEL_API_FORBIDDEN` 降级；文档和示例已不教社区插件用它。`43a52126` 切到 `require` 后不带 `caller`
  的调用被拒：示例测试里唯一直接调 `plugin:host|call` 的 `study-goal.test.tsx:59` 已带上；其余经 `ctx.ui.host`，
  由 UI 内核带（W17 `bdd76587`，未进 INT）。

## 第 3 轮（2026-11-07 14:00 起）

接手上一任 tip `93cfa17b`，开工时 INT 仍是 `fe5feb68`；第五批落地后合 INT `390f244b`（无冲突）。

做了什么：
- 新手自检（任务 3）：按 `docs/plugins/` 用脚手架在临时目录生成 UI + Host 和纯 Host 两个插件，走构建、测试、装载。
  修了三处文档与脚手架不符：仓库外 `build:ui` 找不到 esbuild（改为共用 `examples/scripts/build-ui.mjs`，经应用的
  esbuild）、生成的 README 测试命令找不到测试（改 `DS_PLUGIN_DIR`）、相对路径在符号链接仓库下失效（改绝对路径）。
  全程固化为 `examples/scripts/__tests__/walkthrough.test.tsx`：照生成 README 的命令构建、跑测试，再按生产链路
  （用户 profile → `serveHost` 握手 → UI 清单 → `ds-plugin://` → 渲染进程装载 → 渲染 → 命令）走一遍。
- 安全章节（任务 4）：`docs/plugins/SECURITY.md`，按 INT 行为写导入前筛查、导入后模块检查、UI 半规则、不是边界的地方、
  插件目录是信任起点；“测试”列的每行由 `docs.test.ts` 核对引用了测试、错误码出现在引用的测试里。
  `examples/testing/security.test.ts` 是第 3、5 节的证据（筛查前不执行、模块检查前已执行、无权限也拿得到官方服务和
  Node 内置模块）。
- 第五批联合验证（任务 2）：W17 的 `ctx.ui.host` 现在要求在插件里调用（带 `caller`），示例侧 3 个用例失败
  （word-of-day 1、create-plugin 1、walkthrough 生成的测试 1）。加 `installUiHalf`（harness），三处与脚手架模板改用它。

### 第五批落地后的状态（INT `390f244b` + 本分支）

- `src/ui-kernel/__tests__/community-example.test.tsx`：3/3（INT `afb309bc` 改了测试并加了 `@deepstudent/ui` 别名）。
- `scripts/electron-migration/contracts/community-web-search-example.test.ts`：INT `390f244b` 已退役。
- `scripts/electron-migration/gate-checks/plugin-manifest.test.ts`：12/12（INT `afb309bc` 已改）。
- `examples/vitest.config.ts`：9 个文件 89/89。
- 严格命名空间（本机临时把 `src/ui-kernel/kernel.ts:199` 改为 `true`，跑完即还原、未提交）：examples 89/89，
  community-example + i18n + bootstrap 16/16。

### 交接（INT `390f244b` 上的行号）

上一轮已解决：W09 别名与 `plugin-manifest.test.ts`、community-web-search 测试退役、community-example（INT 处理）；
后端事件相关两条随 K1 失效（社区插件 v1 不能用 `ctx.backendEvents`）。仍然有效：
- W17 `src/ui-kernel/kernel.ts:199`：`STRICT_COMMUNITY_NAMESPACES` 可以改为 `true`（证据见上）。
- W17 `src/ui-kernel/kernel.ts:448`：`settings.register` 的参数类型缺 `navigation`；`SettingsSection` 没有从 SDK 导出。
- W17 `src/ui-sdk/README.md:12`：`community.study-stats` 用了禁止的 publisher。
- W17 `src/ui-kernel/slots.ts:87`、`src/ui-kernel/legacy-adapters.ts:3`、`:45`；W18 `src/ui-plugins/testing/registries.ts:16`：
  仍说“同 id 覆盖插件”。
- W01 `host/kernel/API.md:45`、`:409`（同 id 覆盖官方插件）、`:787-793`（`community.word-of-day` / `wordOfDay`）；
  `:927` 的事件名例子对社区插件已不适用（K1），`host/kernel/plugin-id.ts:103-107` 与 `host/kernel/events.ts:38-40` 仍不一致。
- W01/W09 `contracts/plugin-manifest/v1.schema.json:72`：“log、本插件的存储隐式授予”与代码不符。
- W01 `host/kernel/profile.ts:74-79`、`:216-219`：S01 第 3 轮 M1（`data:` 条目跳过筛查）仍未修，`SECURITY.md` 第 6 节如实写了。
- 主 agent：S01 `77d00cbb`（M3，沙箱 shell 保护插件目录）不在 INT；`.github/workflows/ci.yml:459` `required.needs`
  没有 `examples`（478 行）；W28 MAIN-2（服务器全量加 `examples/vitest.config.ts`）。
- W09 `vitest.setup.ts:3`：setup 先导入 `@testing-library/react`，node 环境测试里文本输入的 `onChange` 测不出。

## 第 4 轮（2026-11-07 15:19 起）

接手上一任 tip `f4502c68`，开工合 INT `2be7ed80`（C 趟，`f472a487`，无冲突）。

开工时的状态：examples 9 个文件 87/89。2 个红都在 `docs.test.ts`：W04 `c848f6ef`（C 趟）把
`translation.translateTextStream` 的窗口参数去掉了（流事件改为广播），示例 `translation-prompt/index.ts:44` 和
`SDK.md` §3.3 B 的片段还传 `source`。已修（`46b0a1e7`）。

计划（按派单优先级）：
1. 交接收集：新条目只有 W23 报告（M2 只修了一半，完整修复 `68b9fe41` 未进 INT）、W09 / W17 的已交付修复未进 INT。
2. examples 的 Linux 风险排查（路径分隔符、大小写、/tmp、遍历顺序、locale、时区、网络），本机 heavy 全套 + STRICT 覆写。
3. `SECURITY.md` 第 6 节：沙箱 shell 一行改为已拒绝；M1 如实；M2 按 W23 的更正写。
4. 没覆盖的 API：逐个补示例 + 测试 + 文档。
5. 文档与代码一致性。
6. 脚手架端到端、文档片段编译。

进展（15:52，INT 前进到 `1d1fdb78`，合入 `27dc329a`，无冲突）：
- Linux：本地时间午夜竞态（插件和测试各取一次“今天”）用 `pinLocalNoon` 固定（`d0c6bdd9`）；其余项（路径、大小写、
  临时目录、排序、网络、Node 版本、POSIX sh）查过没有问题。
- `SECURITY.md` 第 6 节（`1ec89416`）：shell 行改为“沙箱模式下拒绝”，写明 full_access 不进沙箱、测试只在有沙箱的系统上跑；
  M2 只修了一半（`Plugins` 这类大小写变体在 plugins 目录不存在时仍能创建），M1 未修。
- 存储（`e2bb389b`）：study-goal 的 Host 半声明 `service:storage`，把每天的分钟数存进
  `<数据目录>/plugins/example.study-goal/study-goal.db`；测试起两个 Host 共用一个数据目录，验证重启后还在，并覆盖
  没有存储服务时的降级。`loadExample` 加 `storage`、`dataDir` 选项。SDK §7.2 加常见错误表。
- UI API（`348f29b4`）：word-of-day 的视图用 `DsButton` / `DsDialog`（例句对话框）、`createPluginStore` + `persist`
  （收藏夹，重装后读回）、`usePlatform`（命令面板快捷键 ⌘K / Ctrl+K）、`reportError`（加载失败；第 3 次上报后插件被卸载）。
  `installDom` 补 `getComputedStyle`；`examples/testing/setup.ts` 在导入前补 `requestAnimationFrame`（motion-dom 导入时就取它，
  没有就永远不结束动画，`DsDialog` 关不掉）。SDK §4 写了这些 API 的常见错误。
- 不做成示例的（`76730405`）：`agentTools`（SDK §3.4：执行器接口在变；花名册外的执行器排在固定尾部之前，能截走尾部的
  调用）；`declareSlot`（不检查归属、不随卸载撤销，SDK §4 说明）。
- 文档一致性（`6db25090`）：社区插件调用 `ctx.backendEvents` 是 `KERNEL_API_FORBIDDEN`（原文写成“不要依赖”）；
  `--ds-*` 主题变量不存在，改成 `src/styles/shadcn-variables.css` 的变量；安装时信任提示和“解压即装”未实现。
- 脚手架（`79b09ba2`）：生成的测试多一个渲染视图的用例（harness `renderView`，仓库外的插件目录导入不了 testing-library）；
  walkthrough 把生成测试的个数钉死（带 UI 4 个，只有 Host 2 个），证明新用例在仓库外真的跑了。

进展（16:20）：
- STRICT（`STRICT_COMMUNITY_NAMESPACES` 临时改 true，跑完改回）：examples 9 个文件 95/95；ui-kernel 的 community-example 与
  i18n 11/11。
- 偶发红（`00e4fdea`）：word-of-day 的对话框用例偶尔报 `ReferenceError: Element is not defined`（motion-dom 判断 WAAPI 时
  用全局 `Element`），`installDom` 补 `Node`、`Element`、`SVGElement`。motion-dom 用到的 DOM 全局只有 `Element`、
  `HTMLElement`，都已提供。
- web-search 第一条用例冷导入官方 browser 插件（单跑 3.6 秒，负载下 4.9 秒，一次 5 秒超时）：顶部静态导入挪到收集阶段，
  用例 6 个共 0.69 秒。W28 交了同样的补丁（`.reports/W28-handoffs/W27-examples-web-search-cold-import.patch`，
  E-1），本分支的改动与它逐字相同（`git apply --reverse --check` 通过），先合哪个都不冲突。
- 新到的交接：AUDIT-TO-LANES / A13 / W01 说的 `ctx.ui.host` 两条红（`word-of-day.test.tsx:63`、`create-plugin.test.ts:63`、
  模板 `create-plugin.mjs:194`）已由 `f4502c68` 修好并在 INT；ORCH-LOG 说 shell 一行“等 S01 `431f7836`”，本仓库没有
  这个对象，shell 保护实际由 S01 `77d00cbb` + `e14aed1c`（Linux）带进 INT，`SECURITY.md` 按 INT 写；M1 一行补上 W01
  `8958fd8f`（在 `assault/W01-kernel`，未进 INT）。
- ORCH-LOG 对 `onChange` 的裁定（测试文件头改 `// @vitest-environment jsdom`，不改全局 setup）：试过，study-goal 改成
  jsdom 后收集阶段就报 `TypeError: The URL must be of scheme file`（Host 装载器要 `file:` URL），0 个用例跑起来，已改回。
  装 Host 插件的示例测试只能是 node 环境，界面继续只用点击；README 写明。全局 setup 不改，W09 那条交接按裁定撤回。
- 交付前复核 `SECURITY.md` 第 6 节引用的提交：W32 `b773349b`（H1）已在 INT（`bdde9cc5` 合入，修复本体 `8db5c03c`），
  原文“未进集成分支”过期，改为已拒绝，`host/plugins/sync/tests/blob-relative-path.test.ts` 本分支 7/7。M2 `68b9fe41`、
  M1 `8958fd8f` 仍不在 INT（前者在 `int/stage-1555`）。

## 第 5 轮（2026-11-07 16:30 起）

接手上一任 tip `03b4d787`（已在 DELIVERIES 第 11 行），开工时 INT 仍是 `1d1fdb78`，E 趟（`int/stage-1555`）还没进 INT。

计划（按派单优先级）：
1. E 进 INT 后：真实 STRICT 下跑 examples 全套与 ui-kernel 的 community-example、i18n；照抄 land-test `--suite examples`
   的分片命令本机跑；`SECURITY.md` §6 的 M1、M2 两行；API.md 的 rg 验证；docs/plugins 与 examples 对 E 趟新代码逐节核对。
2. 没覆盖的 API：`ctx.ui.attach` 与 chat / markdown / contextMenu / workbench 几类槽位，先判断形状是否稳定。
3. 服务器分诊：C 趟（`.reports/server/land-test-C-16w/`）、D 趟只处理 examples/** 与 docs/plugins/** 的红。
4. 交接收集：16:00 之后的新条目。
5. 脚手架在 STRICT 下的端到端、Linux 剩余风险。

进展（16:40，E 未进 INT）：
- 服务器分诊：C 趟 host 5、fe 10 个红都不在 examples/** 或 docs/plugins/**；读示例的 `community-example` 3/3、
  ui-kernel `i18n` 8/8、`plugin-manifest.test.ts` 12/12 都过。C 趟没有 examples 套件（W28 `8f113113` 在 E 趟）。
  派单写的 `.reports/server/TRIAGE.md` 不存在，W28 的分诊在 `.reports/server/land-test-C-16w/TRIAGE.md`（v1 只有 host）。
- 交接收集：16:00 之后提到 W27 的条目都已由上一任处理，或只是转发上一任的交接（LA-16）；W01 的
  `E-train-fallout.md` 说 examples 两条红归 W27，那两条 `f4502c68` 已修且在 INT。
- 稳定性判断（看 E 趟版本的 `src/ui-kernel/kernel.ts`、`src/ui-sdk/README.md`、`contracts/`）：`chat.toolResults` 有独立契约
  `ChatToolResultContribution`、随 SDK 导出、W17 有测试，做示例；`ctx.ui.attach` 社区插件拿不到懒加载贡献点；
  `markdown.codeBlocks` 类型不随 SDK 导出；`chat.registerBlock/Event/Mode`、`workbench.registerApp` 的值类型是内部注册表
  类型的别名；`resource.contextMenu` 可用、没做示例。SDK §4 写明。
- 示例：word-of-day 给词典 MCP 工具 `define_word`（聊天块里是 `mcp_define_word`）贡献 `actions` 位置的“收藏”按钮，
  写进同一个收藏夹。测试经官方 `McpToolBlockComponent` 渲染。聊天工具块的滚动区（OverlayScrollbars）在导入时就取
  `window`，没有 DOM 时换成空对象，所以新加 `examples/testing/with-dom.ts`（测试文件的第一个 import），`installDom`
  挪到 `examples/testing/dom.ts`，harness 照旧导出。OverlayScrollbars 从 `window` 上取 `requestAnimationFrame` /
  `cancelAnimationFrame`（jsdom 窗口没有，卸载时 `cancelDefer` 抛 `u is not a function`），`installDom` 把
  `examples/testing/setup.ts` 补在全局上的同一对实现挂到 jsdom 窗口上。word-of-day 16/16，`docs.test` 8/8。
- 资源菜单：`resource.contextMenu` 契约 10:27（W17 `67b873ed`）之后没再变，类型随 SDK 导出，算稳定，做了示例。study-goal
  在学习资源库的资源上加一行“学完了，记一个番茄钟”：`scopes: ['resource']` 加 `!context.isFolder`，标签写成
  `<命名空间>:<键>`（菜单用自己的 `learningHub` 命名空间的 t），`run` 先 `closeMenu()` 再调 Host 半，结果记进插件 store，
  下次打开菜单时标签带上当天累计；Host 半拒绝包成 `Error` 交给 `reportError`（点击回调没有错误边界）。测试照
  `src/ui-plugins/official/content/__tests__/community-menu-v1.test.tsx` 换掉四个浏览器依赖，经真实 `LearningHubContextMenu`
  渲染。根测试配置的 react-i18next 桩只认官方中文包，插件键在菜单里原样显示，文案经测试的 i18next 实例核对。
  study-goal 原来两处“`installDom()` 后动态导入 testing-library”改成 `with-dom` 加静态导入（断言没动）。
  study-goal 9/9，`docs.test` 8/8。
- 16:47 INT 前进到 `065a68f3`（E 趟 = `int/stage-1555` + RF 批准）。E 里没有 W27 的合并：W28 转交的 web-search 补丁由
  INT 直接提交（`23701978`），与本分支 `d604da59` 内容相同。
- 合并 INT `065a68f3`（`9027db9e`）：唯一冲突在本 lane 的 `examples/plugins/study-goal/ui.tsx` import 行，INT `6800b072`
  给 `withPluginScope` 加了 `SettingsSectionRenderProps`，与本分支的 `createPluginStore` / `ScopedResourceMenuContribution`
  合并成一行。
- E 之后（真实 STRICT，`STRICT_COMMUNITY_NAMESPACES = true`，没有临时改 kernel.ts），一个 heavy 测试槽：
  - land-test `--suite examples` 的分片命令照抄（`env TMPDIR=<mktemp> DEEP_STUDENT_BUILD_NUMBER=20000 VITEST_MAX_FORKS=2
    VITEST_MAX_THREADS=2 npx vitest run -c examples/vitest.config.ts --reporter=json --outputFile=…`，先 `version:generate`）：
    9 个文件 99/99。最慢的是 create-plugin 与 docs 的严格类型检查（22.6 秒、17.3 秒，上限 60 秒）。
  - 根配置 `src/ui-kernel/__tests__/community-example.test.tsx` 3/3、`i18n.test.tsx` 9/9。
  - SECURITY 引用的测试：`host/kernel/tests/profile-data-url.test.ts` 9/9、`ui-bridge.test.ts` 11/11、
    `electron/tests/fs-scope-deny-case.test.ts` 6/6、`fs-scope-missing-path.test.ts` 6/6。
- 文档按 E 趟代码改：`SECURITY.md` §4 `caller` 缺省拒绝（W01 `412c9fef`）、i18n 一行 STRICT 现为 `true`；§5 `caller` 一行改成
  “自己填、Host 不核实”的剩余缺口；§6 M2 改为拒绝（W23 `68b9fe41`，“目录不存在时”的证据是 `fs-scope-deny-case.test.ts`，
  交接 4 建议的 `fs-scope-missing-path.test.ts` 夹具里 `plugins` 已存在，两个都引用）、M1 改为拒绝（W01 `8958fd8f`）。
  `SDK.md` §6 补用户 profile 只收文件路径；`FRONTEND.md` §4 的 `settings.register` 收 `SettingsSectionRegistration`、资源菜单
  一行改成已改造的消费方，表后指向 SDK §4；study-goal 头注释不再说 `SettingsSection` 不随 SDK 导出。
  核过没变的：`CommandError` 的值仍原样到 UI（`d3f33181` 只改 Host 侧 `message`），UI 内核 `reportError` 仍只取 `Error.message`。
- API.md 交接 1 的 `rg` 检查无输出。
- W01 `event-name-rule.md` 与审计 A26 对 `examples/README.md:90`、`SDK.md:329-331`、本文件 125-127 行的文档交接：规则所在的
  W01 `aa543450` 还没进 INT（本分支没有 `host/kernel/event-name.ts`），按派单照实写现状，没改；进 INT 后照交接里的片段改。
- 合 INT 后 examples 的 tsc 报 study-goal `ui.tsx` 两处 TS2339（on type 'never'）：W17 契约
  `ResourceMenuContextOf<S> = Extract<ResourceMenuContext, { scope: S }>` 对学习资源库的界面（`'resource'` 等）得到 `never`
  （`ContentMenuContext.scope` 是联合，`Extract` 整体不匹配），只有 `'notes-tree'` 收窄对。示例改成缺省泛型加
  `visible` 里判 `context.scope`，SDK §4 写明；修契约归 W17（交接写进报告：`S extends NotesTreeMenuContext['scope'] ?
  NotesTreeMenuContext : ContentMenuContext & { scope: S }`，临时类型检查在本 lane 目录里跑过、已删）。
- D 趟（`.reports/server/land-test-D/`）：25 个红都不在 examples/** 或 docs/plugins/**。
- 脚手架端到端：真实 STRICT 下 `walkthrough.test.tsx` 8/8、`create-plugin.test.ts` 23/23（含生成后严格类型检查）。
- 仍开着的旧交接（INT 上还没修）：W17 `src/ui-sdk/README.md:109` 的 `--ds-*`；W09 `v1.schema.json:72` 的隐式授予文字。
- Linux 复查新增三项：`with-dom` 必须是测试文件第一个 import（导入顺序依赖）；study-goal 菜单用例的 `vi.waitFor`
  默认 1 秒；create-plugin / docs 的类型检查 17–23 秒（上限 60 秒），慢机上要看。其余项与第 4 轮相同。
- 交付闸门：boundaries 0（无新 boundary-allow）、plugin-manifest 0、rust-fixes 0、contracts 0、examples 全套 99/99、
  tsc 根工程与 examples 0。

## 第 6 轮（2026-11-07 19:40 起）

开头状态：INT `e73e0d98`（与本 lane 基线相同），W27 树干净。任务：插件事件（FE-C4）的消费侧。

依赖进展（本轮内）：
- W01 `45f6a666`（在其分支，**尚未交付**）：`ctx.uiEvents.emit(完整名字, 载荷): void`，只发本插件前缀、
  纯 JSON，卸载后保留的 emitter 抛 `plugin "…" is not active`。只作为补丁的前瞻验证，本树不使用；
  未交付前不当作可用依赖。
- W17 `dc9871e8`（tip `555d7b12`）：`ctx.ui.host.on<T>(事件名, handler): UiDisposer` +
  `UiAdapters.events`；裸名与完整名都接受，注册前拒绝外来/近前缀，卸载（含迟到的 `listen`）退订，
  handler/传输错误进插件错误预算。发布见 `interfaces/ui-runtime.md` §2。

树内（不依赖未合并 API 的部分）：
- study-goal 的设置分区、命令、资源菜单行共用一个 `TodayStore`（`createPluginStore` + `usePluginStore`）。
  外部记录后已挂载分区直接重渲染，DOM 节点不变；新增用例。这是事件处理函数将来唯一要写的地方。
- `examples/testing/events.test.ts`：锁住 `example/study-goal:today` 的派生、近/外来前缀、`.`/`-`
  不碰撞、注册前拒绝；5 条传输链路用例先写成 todo。
- 文档：`SDK.md` §5 与 `examples/README.md` 删掉“派生名字过不了 `isEventNameValid`”的过期说法；
  顺带修了基线就红的 `toContentMenuContribution` 路径（`ui-service.ts`）。

补丁（验证过，依赖进 baseline 后再 `git apply`）：
- `study-goal-host-emit.patch`：`day.ts` 的 `TODAY_EVENT` + 提交后 `ctx.uiEvents.emit`。
- `study-goal-ui-subscribe.patch`：`ctx.ui.host.on` 写 `TodayStore`；harness 加 `memoryHostEvents`
  并作为默认 `events` 适配器（否则订阅一加，现有 UI 用例在安装阶段就抛“no transport”）；
  新增 `events.test.tsx` 全链路用例。
- 验证：W17 `555d7b12` + 本分支 examples/docs + `45f6a666` + 两个补丁，study-goal `11/11`，
  examples 全套 `105 passed | 5 todo`。本分支自身 `104 passed | 5 todo`。

交接：`TestHost` 没有出站事件订阅回调（链路测试用 `host.events` 搬运）；`pluginEventName` 的导入路径
（`plugin-id.ts` 不在 SDK §0 的可导入清单）；合并后把 SDK §5 / `examples/README.md` 的“未开放”改成可用。
