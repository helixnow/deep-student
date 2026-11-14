# W17 · FE-A2 UI 内核 v2 与 SDK — 进度

分支 `assault/W17-ui-kernel-v2`（integration + W09 第一轮 `69e182d`）。负责路径 `src/ui-kernel/**`、`src/ui-sdk/**`。
方案 `plans/FRONTEND-PLUGINIZATION.md` §1.2、§2、§3.2 FE-A2。

## 基线（改动前，2026-11-07 03:01，`69e182d`）

命令（临时生成 `src/version.ts`，用完删除、不提交）：

```
DEEP_STUDENT_BUILD_NUMBER=20000 node scripts/generate-version.mjs
npx vitest run -c vitest.config.ts src/ui-kernel src/ui-plugins \
  tests/vitest/modernSidebarNavigation.test.tsx \
  src/components/layout/__tests__/MobileSidebarNavigation.dedup.test.tsx --maxWorkers=2
```

| 范围 | 文件 | 用例（运行期） | 通过 | 失败 |
|---|---|---|---|---|
| `src/ui-kernel` | 5 | 26 | 26 | 0 |
| `src/ui-plugins`（F1 golden 与官方插件） | 23 | 91 | 89 | 2（另 1 个文件收集失败） |
| 槽位消费方（侧栏、移动导航） | 2 | 58 | 58 | 0 |

- F1 范围共 28 个文件，静态 `it/test` 声明 76 处（方案记为 75），`it.each` 展开后运行期 117 个用例。
- 3 个失败文件全部是固定旧源回放（`git show <旧提交>`），本机源码快照没有这些提交，属环境性失败：
  `testing/legacy-boot-evidence.test.ts`、`settings/__golden__/sidebar-evidence.test.ts`、`shell/__tests__/legacy.evidence.test.ts`。
- golden 比对测试（boot 16 组、shell、settings、markdown、codeblock、menu、labels、legacy-extraction）全部通过。
- 前端 typecheck（`git archive 69e182d` 导出到临时目录后 `tsc --noEmit -p tsconfig.json`）：退出码 0。

## 改动后（`3ba09d0`，同一命令外加 `src/ui-sdk`）

| 范围 | 文件 | 用例 | 通过 | 失败 |
|---|---|---|---|---|
| `src/ui-kernel` | 17 | 95（原 26 + 新 69） | 95 | 0 |
| `src/ui-plugins` | 23 | 91 | 89 | 2（同上环境性失败，另 1 个文件收集失败，同上） |
| 槽位消费方 | 2 | 58 | 58 | 0 |
| `src/ui-sdk` | 3 | 5 | 5 | 0 |

- 基线中的 176 项（175 个用例 + 1 个收集失败项）逐项状态不变（JSON 报告逐项比对），新增 74 项全部通过。
- `git diff 69e182d HEAD` 不涉及任何 `__golden__` 文件，也不涉及 `src/ui-kernel`、`src/ui-sdk` 以外的文件。
- 前端 typecheck：`70e3a2d` 前的 SlotMap 状态退出码 0；`3ba09d0` 的全量 typecheck 报出 1 个错误
  （`LegacyRegistries.commandRegistry.subscribe` 的回调参数类型），`2706b32` 修复并新增
  `__tests__/owned-typecheck.test.ts`（编译两个负责目录的全部源文件，未修复时复现同一错误）；`2706b32` 全量 typecheck 退出码 0。
- ESLint（`npx eslint src/ui-kernel src/ui-sdk`）无错误、无告警。

## 计划与状态

| # | 项 | 状态 | 提交 |
|---|---|---|---|
| 1 | `SlotMap` 类型映射 + 类型测试 | 完成 | `70e3a2d` |
| 2 | `UiPluginMeta` v2 + 安装期校验 + `platform` 服务 | 完成 | `70e3a2d` |
| 3 | `navigate` 服务 | 完成 | `70e3a2d` |
| 4 | `storage` 服务 | 完成 | `70e3a2d` |
| 5 | `createPluginStore` | 完成 | `0cef45b` |
| 6 | i18n 命名空间与 `useT` | 完成 | `312125b` |
| 7 | 错误预算 + `SlotOutlet` + 服务 hook | 完成 | `a064885` |
| 8 | 旧注册表适配器补订阅 | 完成 | `cee28b6` |
| 9 | 生产装配（bootstrap）接入新服务 | 完成 | `cee28b6` |
| 10 | `src/ui-sdk` 公共 API、文档、最小示例 | 完成 | `55a9e82` |
| 11 | 追踪代理归属测试；改动后复跑基线 + 前端 typecheck | 完成 | `84a4ad3`、`3ba09d0`、`2706b32` |

## 设计要点与约束

- 新服务全部经 getter / 普通方法暴露（Cordis 追踪代理把 `this.ctx` 换成调用方）；不用类字段箭头函数、不用 `#private`。
  `__tests__/tracking.test.ts` 覆盖解构、跨 await、嵌套子 fiber、多插件引用。
- 每次 `apply` 一个 `UiPluginScope`（`scope.ts`），插件私有服务的订阅与状态挂在上面，随 fiber 失效整体撤销。
- `bootstrap.ts` 的必需依赖保持原来的六个：boot golden 的取证工具（`ui-plugins/testing/boot-entry-harness.ts`）按这份清单在 vm 中回放该文件。
  旧注册表的适配改为把原始注册表交给内核（`UiAdapters.legacyRegistries`）；平台 os 与导航事件模块惰性加载、失败静默。
- 类型测试放在 `typetests/*.typetest.ts`（不在 tsconfig 排除列表内，`npm run typecheck` 会检查），并由
  `__tests__/*.types.test.ts` 用编译器 API 去掉 `@ts-expect-error` 后逐行确认错误真实出现。

## 发现与交接

- `src/i18n.ts` 的 `fallbackNS` 是全部官方命名空间：官方界面用 `社区ns:key` 渲染插件文案时，当前语言缺键会回落到无关的官方文案
  （`bootstrap.test.ts` 编写时实测：只登记 en-US 的社区键在 zh-CN 下解析成“系统设置”）。插件侧 `t`/`useT` 已隔离；
  官方侧需在 `src/i18n.ts` 对非官方命名空间禁用跨命名空间回落（W09 / FE-A4 / FE-B 归属）。
- v1 `ctx.ui.contextMenu.register({ resourceTypes, labelKey, run })` 的值形状与官方消费方读取的 `ContentMenuContribution`
  （要求 `visible(ctx)`）不一致，社区条目会在社区错误边界内报错；FE-B9 统一菜单族时修正快捷方式或弃用。

---

# 第二轮 · FE-B3 工具结果槽位 → FE-B2 聊天 block / 事件 / 模式

## 改造前取证（`9b4b945` 上的原始代码）

- `76e400d` / `0dee7ed`：证据测试与 golden 先于任何改造提交；`0dee7ed` 同时把 B3 DOM golden 的 shimmer 动画样式（`background-position` 随真实时间变化）归一化，并在**未改动的** `mcpTool.tsx` 上重新取证。三次连跑零差异。
- 第二轮全量基线：`tests/vitest/chat-v2 src/features/chat src/ui-kernel src/ui-plugins src/ui-sdk`，2,965 项中 2,963 项通过，另有 1 个套件加载失败；3 项失败都是 F1 的已知环境项（`legacy-boot-evidence`、`sidebar-evidence`、`legacy.evidence`，本地缺少旧提交）。结果在 `/tmp/w17/r2-baseline.json`。

## FE-B3

- **“工具名 → 渲染分支”全表**：`blocks/__golden__/tool-result-branches.json`，共 2,676 行。工具名来自前端 317 个 `builtin-*` schema 工具名（冻结于 `__fixtures__/builtin-tool-names.json`），加上旧分派里写死的 33 个名字。每个名字取 6 种写法（无前缀、`builtin-`、`builtin:`、`mcp_`、`mcp.tools.`、`server.`）。写死的名字再取 5 种状态。每行记录：是否通用卡片、命中的专用视图及其收到的数据、输出区下方的按钮文字与图标。
- **DOM golden**：`blocks/__golden__/tool-result-dom.json`，20 个代表输出，用真实组件渲染。
- **契约**：`ui-kernel/contracts/chat.ts` 定义 `ChatToolResultContribution { placement: 'block' | 'output' | 'actions'; component; when?; match?: 'exact' | 'qualified' }`，并登记到 `SlotMap['chat.toolResults']`。key 是基础工具名：`exact` 匹配 key 本身或 `builtin-` + key；`qualified` 另外剥离 `builtin:`、`mcp_`、`mcp.tools.` 和命名空间前缀，与旧的 `isPaperSaveTool`、`isShellExecuteTool`、`isAttemptCompletionTool` 规则一致。v1 的 `registerToolResult(name, Component)` 按 `placement: 'block'` 规范化。
- **分派**：`mcpTool.tsx` 删去 `TODO_TOOLS`、`DOC_WRITE_TOOLS`、`DOC_READ_TOOLS`、`NOTE_TOOLS` 及各 `is*Tool` 判断，改为 `resolveToolResult([useOptionalSlot('chat.toolResults'), officialToolResultEntries])`：内核贡献优先，其次内置表，`when` 为 false 或找不到时用通用视图。内置表在 `blocks/toolResults.tsx`，共 33 条，组件与提取逻辑原样搬移。
- **内核**：`SlotStore` 改为每个 slot 单独计版本。别的 slot 变化时 `list()` 返回同一引用，因此每个 `mcp_tool` 块的订阅不会因无关插件装卸而重渲染。
- **改造后**：全表与 DOM golden 逐字节相等；原有 `McpToolBlock.test.tsx` 与 `src/ui-kernel` 测试全部通过。示例测试 `toolResultSlot.test.tsx` 共 8 项：一条 `ctx.ui.contribute('chat.toolResults', …)` 即可新增卡片（带或不带 `builtin-` 前缀都能命中，卸载后回落到通用视图）；另含 output/actions 位置、v1 裸组件、内核贡献覆盖内置表、名称匹配规则。类型测试 `chat-slots.types.test.ts` 确认 4 种错误形状都会编译失败。

## FE-B2

- **实际清单与方案估计不同**，取证见 `plugins/__golden__/chat-plugin-inventory.json`：27 个 block；17 个事件类型（含 `retrieval.ts` 的 6 个检索类型，以及 `sessionActions.ts` 登记的 `plan_gate`）；2 个模式（`chat`、`analysis`；`textbook` 已注释掉）。方案写的是 28 / 13 / 4。
- **注册表**：`registry/Registry.ts` 的条目改存在内核的 `SlotStore` 里，每个注册表一个 slot，条目带 owner 和 origin。
  - 同一 key 可叠加多层，`get` 取最上层，撤销只去掉自己那一层；`register` 返回撤销函数。
  - 新增 `subscribe`、`entries()`。`unregister`、`getAll`、`keys`、覆盖告警沿用旧语义，`getAll` 保持 Map 插入顺序。
  - `get` 走按版本缓存的索引，热路径开销不变。
- **经内核贡献**：新增 `ctx.ui.chat.registerEvent` 和 `registerMode`，以及 `chatEvents`、`chatModes` 适配器与 `kernel.registries` 视图。适配器把插件 id 记为 owner。登记与当前值是同一个对象时视为“认领”，不算冲突；其他同名登记仍报错。
  - 官方聊天 UI 插件 `dstu.ui.chat`（`plugins/official.ts`）认领全部模块导入登记的条目，并订阅注册表认领之后才导入的条目，同时贡献 33 条 `chat.toolResults`。
  - 安装时机：`plugins/index.ts` 调用 `installOfficialChatUiPluginWhenReady()`，bootstrap 装完官方插件后经 `ui-kernel/app-kernel.ts` 惰性发布主窗口内核，加载失败时静默。卸载只撤销内核那一层，模块层继续保证消息渲染。
- **渲染端**：`BlockRenderer` 与 `BlockRendererWithStore` 改用 `useSyncExternalStore(blockRegistry.subscribe, () => get(type) ?? get('generic'))`。快照就是插件对象本身，别的类型登记或撤销时引用不变，不会重渲染；不可订阅的旧形状注册表退化为渲染时读取。
- **内核视图**：`UiAdapterRegistry.track` 期间原生注册表的通知并入 track 自己的那一次，保持“一次变化一次通知”。我在第一轮写的 `registries.test` 有一处断言随 FE-B2 的语义变化更新：绕过内核的直接登记现在也会通知订阅者（1 → 2 → 3）。
- **改造后**：清单、27 种 block 三态 DOM（经 `BlockRenderer` 与直接渲染两种方式）、9 步渲染计数全部与改造前相等，计数逐项不大于基线。新增 `officialChatPlugin.test.tsx` 7 项：注册表层叠与订阅、官方插件认领与卸载、社区插件不能抢占内置类型、认领后到达的条目、发布内核后自动安装、晚注册的社区 block 在已挂载消息中渲染且卸载后消失、事件与模式经内核登记和撤销。

## 收尾验证

- 前端 typecheck（`bin/heavy npm run typecheck`）：0 错误。
- 回归：运行与改造前取证（`/tmp/w17/r2-baseline.json`）相同的套件，另加 F1 的两个侧栏 golden。基线 2965 项改造后 0 项回退、0 项缺失，新增 74 项全部通过。失败的只有与基线相同的 3 个取证文件（`git show` 不到外部提交，属环境问题）。
- lint：改动文件 0 错误。剩余告警都是原样搬移的类名触发的，此前就已存在。

## 后端执行器的前端渲染覆盖（只做清点，没有新建视图）

依据 `tool-result-branches.json`（`builtin-` 前缀、success 状态）和 `toolCall.ts` 按工具名选择 block 类型的逻辑：

- **有专属渲染**：
  - docx、pptx、xlsx 共 19 个工具：通用输出下方附打开或查看文档按钮。
  - canvas-note 10 个工具中的 7 个：附打开笔记按钮。其中 `note_append`、`note_replace`、`note_set` 实时会被重映射为 `workbench_ops`。
  - todo 4 个；`paper_save`、`attempt_completion`、`local_shell_execute`。
  - `qbank_generate_questions` → `qbank_questions`；`mindmap_edit_nodes` → `workbench_ops`。
- **只有通用 JSON 视图**：
  - qbank 44 个中的 43 个；review-planning 8；vfs-memory 16；essay-grading 7。
  - media-tools 2；office-fidelity 1；textbook-pdf 3；document-processing 2；learning-resource 4。
  - user-todo 14；mindmap 7 个中的 6 个；learning-overview 3；fsrs-settings 2；knowledge-retrieval 2。
- 以后为这些工具做卡片，只需要在所在插件里贡献一条 `chat.toolResults`，见 `toolResultSlot.test.tsx` 的示例，不用再改 `mcpTool.tsx`。

---

# 第三轮 · 撤销句柄、内核缺口、FE-A5

基线：integration `b84fc7dd`（合入提交 `159f3a71`）。日志在 `/tmp/w17r3/`。

| # | 项 | 提交 |
|---|---|---|
| 1 | 登记返回 `UiDisposer`；`commands`/`workbench.registerApp`/`chat.register*` 参数类型收窄；`meta.devOnly` | `222c5bb1` |
| 2a | 按槽位订阅（`SlotStore.subscribe(name, fn)`；`useOptionalSlot`/`useSlotEntry` 只订阅本槽位） | `74b05977` |
| 2b | 懒加载贡献点 `ui-kernel/lazy.ts` + `ctx.ui.attach`（吸收 W18 `createLazyContributionPoint`）；markdown、genui 槽位类型移入 `contracts/` | `94b02dd9` |
| 3 | FE-A5：`__DS_PLATFORM__`、`ctx.ui.platform.arch`、`utils/platform.ts` 收敛、按 `VITE_DS_PLATFORM` 生成官方插件表 | `8888dad7` |
| 3b | vite `ui-boot` 分组改为排除全部构建入口的闭包（demo 构建白屏） | `f90b38e5` |
| 3c | SDK 类型导出；官方插件经 `@/ui-sdk/lazy` 取懒加载原语 | `a0c8b41a` |

## bootstrap.test 首例慢的根因（未改超时）

首例要冷加载 `@phosphor-icons/react` 的 ESM 桶文件（约 7,500 个模块）：官方插件经命令面板模块引入它。
Vitest 冷加载耗时 1.7–3.4 s。实测给 `vitest.config.ts` 加
`test.deps.optimizer.web = { enabled: true, include: ['@phosphor-icons/react'] }` 后，桶文件 3409 → 84 ms，首例 1752 → 429 ms。
`vitest.config.ts` 归 W09，已列为交接项，本分支未改。

## 验证（HEAD `a0c8b41a` 及其后的文档/lint 提交）

- `npm run typecheck`：0 错误。
- vitest `src/ui-kernel src/ui-sdk src/platform src/ui-plugins src/features/workbench src/features/generative-ui` 加两个侧栏 golden：
  268 个文件、2225 项，失败 3 项 + 1 个文件收集失败，全部在 integration 上同样失败：
  - 3 个取证文件（缺旧提交）；
  - `platformPerformanceConfig.test.ts` 的 Settings `React.lazy` 源码断言（在 `b84fc7dd` 上单跑同样失败）。
- 五层回归（`regress.mjs --build`）：slots ✓、screenshots ✓。
  - dom ✗：只有 `skills-mcp` 翻译技能工具数 2 → 3（W09 `485f51df`）。
  - ipc ✗：`skills-mcp` 少 `listen:tauri://close-requested`；`notes` 启动顺序有时不同，第三次运行重试后通过，属时序竞态。
  - chunks ✗：4 项违规（`host/kernel/platforms.ts`、`cancelAlignment.ts`、`appContributions.ts` 进入口闭包；`graphApi.ts` 不再是动态入口）。入口体积 −145,660 字节。
  - A/B：在 `b84fc7dd` 上只加 `f90b38e5` 时，dom、ipc 的差异完全相同；integration 原样的 chunks 有 5 项违规（多出的 `lazy-contributions.ts` 已由本分支消除）。上述差异都不是本分支引入的。
- 移动端构建（`VITE_DS_PLATFORM=mobile`）：和桌面 manifest 相比只少 `src/ui-plugins/official/workbench/index.ts`，`official/dev/` 两边都为 0。
  `src/features/workbench/**` 的 330 个模块仍经 `App.tsx`、`main.tsx`、命令面板等宿主文件静态可达，要等 FE-C1/D1 处理。
- ui-boundaries：0 新增；`ua-sniffing` 38（棘轮不变）；`plugin-import-boundary` 91 → 86，有 4 条过期基线待 W09 重写。
- ESLint（改动文件）：0 错误，剩 1 条既有 `no-console` 告警（`utils/platform.ts:215`）。

## 第 5 轮（合入 INT `8037af0c` 之后）

- 白屏：INT 上已修好（boot-check 通过，chunks 0 违规，没有循环 chunk），`computeStartupBootGroup` 未改。
  INT 构建原本因 `official/menu/contract.ts` 引用已删除的 `../lazy-contributions` 而失败，`eaa4249e` 恢复了一个转发 shim，待 W18 迁移 contract 后删除。
- `AppDefinition.hostPlugin`：由 `official/workbench/hostApps.tsx` 实现。插件 missing 时撤回应用；degraded 时渲染 `HostUnavailablePanel`，已开窗口实时切换；unknown 或没有内核时按 online 处理。
- `resource.contextMenu`：新增 `scopes` 字段和 `notes-tree` 作用域（`NotesTreeMenuContext`），内核按 scope 包装 `visible`。笔记树本身未迁移。
- `meta.core`：仅官方插件可用。生产构建下 `unload` 或被同 id 替换时抛 `UiCorePluginError`；dev 和 test 不限制。
- i18n：社区插件的 namespace 必须等于 `pluginNamespace(id)`。v2 插件违规抛错，v1 插件只告警一次。
- SEC-E06 UI 部分：只出了设计，见 `SEC-E06-SANDBOX-DESIGN.md`。
- 验证（`ac843a76`）：
  - typecheck 0 错误；ui-boundaries 0 新增；ESLint 0 错误。
  - vitest：5 个文件失败，在 INT `8037af0c` 上单跑同样失败。
  - 回归：slots、dom、screenshots、chunks ✓。
  - ipc ✗：notes #22 时序竞态，skills-mcp 少 close-requested，均为既有问题。
  - evidence ✗：`editorExtensions.golden` 和 FE-B5 迁移冲突，INT 上同样失败。

## 第 6 轮（合入 INT `fd621db5`，合并提交 `2f2509d7`）

| 项 | 提交 |
|---|---|
| INT 生产构建失败：构建期官方插件表读不了 W19 的插件写法 | `72d6e977` |
| ui-boot ↔ vendor chunk 环的正式修法；复核 W19 `baa1de8c` | `3732dce7` |

### INT 构建失败（开工时发现）

- 现象：`fd621db5` 的生产构建、演示壳构建和 `official-plugins.test.ts` 都失败，报 `OfficialPluginTableError: official/dashboard/index.ts … (found 0)`。
- 原因：W19 的 `dashboard`、`debug`、`learning-today` 写成 `const plugin: UiPlugin = { name, meta: { … }, … }`，读取器只认 `defineUiPlugin({ meta })`。
- 修法：读取器也接受“默认导出就是插件对象字面量”的写法，meta 仍须是字面量；W19 的文件不动。
- `debug` 的 `devOnly: true` 写在顶层，不在 `meta` 里。内核和构建期插件表都只读 `meta.devOnly`，所以生产构建照常收录并安装它（主代理已接受“生产环境 Analysis 面板为空”）。见交接。

### 复核 `baa1de8c`（helper 固定到 vendor-react）

- 它基于不含 `f90b38e5` 的提交。`f90b38e5` 让入口闭包取全部构建入口之后，helper 在主构建和演示壳构建里都已在入口闭包内，不会再进 ui-boot。原注释写的成环路径已经不成立。
- 固定本身仍然需要，原因不同：Rollup 4.60 把未归组的模块交给执行序最靠前、静态依赖它的手动 chunk（`getChunkDefinitionsFromManualChunks` 按 `execIndex` 排序）。
  别的 CJS vendor（如 vendor-micro 里的 invariant）先于 React 执行时，helper 落进 vendor-micro，vendor-react 反向 import 它，与 vendor-micro → vendor-react 成环。
  当前两种构建里 React 碰巧最先执行，所以产物里 helper 一直在 vendor-react，固定前后产物相同。
- 结论：保留，注释改为真实原因；单测复现了不固定时的 vendor-micro ⇄ vendor-react 环。

### 正式修法（`vite.config.ts`）

- `computeStartupBootGroup` 新增入组条件：不在任何 vendor 分组模块的静态闭包里。
  - 原规则只排除入口闭包。被 vendor 包引用、又只在启动链里出现的模块（W18 r2 记录的 `void-elements`，以及入口不碰 React 时的 helper）会进 ui-boot。vendor chunk 随之 import ui-boot，而 ui-boot 本来就 import vendor chunk，于是成环。
  - 加上原有的“依赖树全部入组或属于 vendor”，ui-boot 只 import vendor chunk，vendor chunk 不会 import ui-boot。这一点不再依赖入口闭包碰巧包含哪些模块。
- `build.rollupOptions.onLog: failOnCircularChunk`：Rollup 的 `CIRCULAR_CHUNK` 警告改为构建失败（演示壳配置原样继承）。改动前主构建、演示壳构建都没有这个警告。
- `manualChunks`、`failOnCircularChunk`、`computeStartupBootGroup` 改为具名导出，供测试使用。
- 测试 `src/platform/__tests__/startup-chunks.test.ts`：用 Vite 在内存里构建缩小版的启动链，3 项。
  - void-elements 场景：留在 vendor-i18n；ui-boot 只含 `icons.ts`，只 import vendor-i18n。
  - 强行把 void-elements 放进 ui-boot（即旧规则的结果）时构建失败，报 `Circular chunk: vendor-i18n -> ui-boot -> vendor-i18n`。
  - helper 固定在 vendor-react；取消固定时构建失败，报 vendor-micro ⇄ vendor-react 环。
  - 变异验证：把入组条件改回旧写法，第 1 项失败，报同一个环。

### 构建前后对比（`bin/heavy`，`tests/visual/lib/build.mjs`；改动前 = `72d6e977` 的树）

| 构建 | chunk 数 | 总字节 | 入口闭包 | ui-boot | 环 | 启动 |
|---|---|---|---|---|---|---|
| 主应用 改动前 | 1200 | 35,831,823 | 7 chunk，5,155,519 + CSS 530,373 | 17,679 B，7 模块，只 import vendor-i18n/react、vite-runtime | 0 | — |
| 主应用 改动后 | 同上 | 同上 | 同上 | 同上 | 0 | — |
| 演示壳 改动前 | 1296 | 35,562,749 | 11 chunk，324,168 + CSS 423,231 | 1,352,890 B，73 模块，只 import vendor | 0 | 两个入口都挂载 |
| 演示壳 改动后 | 同上 | 同上 | 同上 | 同上 | 0 | 两个入口都挂载 |
| 移动端（`VITE_DS_PLATFORM=mobile`）改动后 | 1200 | 35,830,827 | 7 chunk，5,155,587 + CSS 530,373 | 16,886 B，5 模块 | 0 | — |

- 主应用、演示壳前后经 `chunk-graph.mjs` 的 `compareGraphs` 逐项比较：0 违规、0 结构变化、入口增长 0。没有任何 vendor chunk import ui-boot。
- 对 W16 golden（INT `68d37526`）的 `chunk-graph --check` 前后都是同样 6 条违规，入口 −70,422 字节，都不是 W17 引入的：
  - `src/debug-panel/bus.ts` 和 4 个 `channels/*.ts` 进入口闭包：来自 W19 FE-B7 `daf687e1`。业务代码改经很小的 bus channel 调用调试面板，重的面板代码移出入口，所以入口总量变小。属有意变化。
  - `citationParser.ts` 不再是独立动态 chunk：它被并进懒加载的 MarkdownRenderer chunk（`citationRemarkPlugin.ts` 静态引用它），仍不在入口闭包里，不影响启动。
  - 需要 W16 重录 golden。

### 第 5 轮遗留

- 核心插件：机制已全。裁定（ORCHESTRATION-LOG:320）是 editor、menu 为核心插件，由 W18 声明，INT 上还没声明（见交接）。错误预算对官方插件默认无限，不会自动卸载核心插件；槽位定义不随插件卸载撤销，社区插件无法借重复声明拿走核心插件的槽位。项目里还没有 UI 插件管理界面，`isProtectedCore` 暂无调用方。
- i18n：`fallbackNS` 串文案已由 W09 `b01ea68a` 修好。v1 改严格模式仍卡在 `examples/plugins/community-word-of-day/ui.tsx:33` 的 `'wordOfDay'`（`examples/` 无 owner），本轮不改。
- SEC-E06：设计里没有标成小改动的块（每块 2–4 人日），本轮不实现。
- `UI_PLATFORMS` 单一来源：已是 Host 的 `PLUGIN_PLATFORMS`（`host-pairing.test.ts` 断言同一引用），无事可做。

### 验证（`3732dce7`）

- 单测：`src/platform`（4 个文件 20 项）、`katexFontServing`、`pdfStaticAssets` 全部通过；`platformPerformanceConfig` 的 Settings `React.lazy` 一项失败，属前几轮记录的 INT 既有失败。
- 门禁：6 个 gate-checks 均 0 新增、0 过期基线；`slot-snapshot --check` 通过；`bin/heavy npx tsc --noEmit -p tsconfig.json` 0 错误。
- ESLint：改动的 3 个 `src/` 文件 0 问题（`vite.config.ts` 在忽略列表里）。
- `tsconfig.node.json`：`vite.config.ts` 本身无类型错误；经 `official-plugins.ts` 拉进来的 `src/ui-kernel/meta.ts` 在这个缺 target/lib 的配置下报 4 个错，另有 TS6307。第 3 轮起就存在，只有 `tsc -b` 会碰到，没有脚本这样跑。见交接。

### 交接

- W18：`src/ui-plugins/official/editor/index.ts:6`、`menu/index.ts:6` 的 meta 加 `core: true`（按 ORCHESTRATION-LOG:320 的裁定）。
- W19：`src/ui-plugins/official/debug/index.ts:9-13` 的 `devOnly: true` 放进 `meta`，生产构建才会把它连同 `./api` 一起排除（目前是安装后提前 return）。`debug/__tests__/debugPanels.test.tsx:76` 随之改为断言 `meta.devOnly`。这会让生产构建不再声明 `debug.panels` 槽位，需先确认插槽快照。
- W16：按上面的判定重录 `tests/visual/__golden__/chunk-graph/main.json`。
- 主代理：给 `examples/` 指定 owner，把 `community-word-of-day/ui.tsx:33-36` 的 `'wordOfDay'` 换成 `pluginNamespace(id)` 派生的命名空间，W17 随后把 v1 改为严格模式。
- 无 owner：`tsconfig.node.json` 只 include `vite.config.ts`，且没有 target/lib。要让 `tsc -b` 通过，需要补 include（`src/platform/official-plugins.ts`、`src/ui-kernel/meta.ts`、`host/kernel/platforms.ts`）和 `target`/`lib`（ES2022），或者从 `tsconfig.json` 的 `references` 里去掉它。

## 第 7 轮（合入 INT `6c491e6f`，合并提交 `b3827ac7`）

| 项 | 提交 |
|---|---|
| 官方插件约定由构建期插件表强制；去掉对象字面量写法；SDK 文档 §8；类型测试 | `63a9c77a` |
| SEC-E06 UI 半：`ctx.ui.host` 带 `caller` | `bdd76587` |
| `tsconfig.node.json` 改为独立 noEmit 项目；`tsconfig.json` 去掉 references | `e01c4407` |
| `platformPerformanceConfig`：Settings 懒加载断言改到代码现在的位置 | `c488506a` |
| 社区插件 i18n 严格模式开关 | `c7b3ba99` |

### 官方插件约定

- 写法：默认导出是唯一一次 `defineUiPlugin({ meta: { … }, apply })` 调用，外面可以套 `Object.assign(…, { order })` 或对象展开。
  meta 必须是内联对象字面量，每个字段写成 `name: value`。`devOnly`、`core`、`platforms` 等 meta 字段只能写在 meta 里。
- 违反时的报错带文件位置和修法，三处会报：生产、移动端、演示壳构建（`ds-official-ui-plugins`）；`official-plugins.test.ts`；
  `devOnly` 写在 `defineUiPlugin` 参数顶层时 tsc 也报（类型测试 `meta-field-outside-meta`）。dev server 不生成这张表，开发时不报。
- 第 6 轮为 W19 加的“默认导出是插件对象字面量”写法去掉了，理由：
  - 这种写法跳过多余属性检查，W19 的 `devOnly` 正是这样写错了位置却没人发现；
  - 社区插件同样用 `defineUiPlugin`，两边一致；
  - INT `6c491e6f` 起所有官方插件都已改用 `defineUiPlugin`，没有迁移成本。
- 表的内容不变，只是多了报错，所以构建产物不变。

### `caller`

- `ctx.ui.host.<服务>.<方法>(…)` 发 `plugin:host|call { caller, service, method, args }`（`kernel.ts:569`）。
  `caller` 取调用 context 所在的最近插件 fiber：配对半（`ctx.ui.pair`）用半自己的 id（`kernel.ts:939`），否则用安装它的插件 id。
  在 `apply` 里取到 host 句柄、之后在回调里调用，`caller` 不变。
- 根 context 的调用直接拒绝（以前会不带身份发出去）；插件卸载后的调用以 `UiPluginDisposedError` 拒绝。两者都不会到达 Host。
- 测试：`loader.test.ts` 新增 2 项；`community-example.test.tsx` 改为经插件自己的 ctx 调用，id 与服务名取自示例的 meta。
  在模拟的 W27 示例迁移加 W01 `facf1e63` 上 3 项通过，跨插件调用被拒（“a UI half may only call its own Host half”）。

### `tsconfig.node.json`

- 只补 include 行不通：`tsconfig.json` 引用它，被引用的项目必须 composite 并产出声明文件；它经 `official-plugins.ts` 拉进的
  `src/ui-kernel/meta.ts` 同时属于应用项目（noEmit），`tsc -p tsconfig.json` 随即报 TS6305/TS6310。
- 做法：改成独立的 noEmit 项目（target/lib ES2022，node 与 vite/client 类型），从 `tsconfig.json` 去掉 references（一行，不在本 lane 路径内，见交接）。
- 结果：`tsc -p tsconfig.json`、`tsc -p tsconfig.node.json`、`tsc -b` 都是 0 错误。`src/platform/__tests__/node-tsconfig.test.ts` 锁住 include 和 0 错误。
- 副作用：编辑器不再经 references 为 `vite.config.ts` 自动选用 `tsconfig.node.json`。

### `platformPerformanceConfig`

- 根因：上游 `b0c6cd4d5` 把 19 个 `React.lazy` 分区随 `settings.sections` 槽位移到 `src/ui-plugins/official/settings/sections.tsx`，
  基线 `21c9d808` 已经如此；Settings 的 golden 还断言 `Settings.tsx` 里不再有它们。不是产品回退。
- 断言跟到新位置，检查同一性质：`sections.tsx` 含 `React.lazy(() => import(`，且只静态 import `react`（静态引入任一分区都会进启动 chunk）。
  变异验证：加一个静态 `ApisTab` import 后失败。

### i18n 严格模式

- `STRICT_COMMUNITY_NAMESPACES`（`kernel.ts:199`，目前 `false`）。改为 `true` 后，API v1 社区插件用 `addBundle` 写非派生命名空间直接报错，与 v2 相同，不再告警。
  `UiKernelOptions.strictCommunityNamespaces` 可逐个内核覆盖；`createAppUiKernel(options)` 转发它，只给测试用。
- 依赖兼容模式的测试都显式传 `false`，所以切换只改那一行。
- 验证：常量临时改为 `true`，示例未迁移时 `src/ui-kernel` 只有 `community-example` 的 3 项失败（示例写的是 `wordOfDay`）。
  再模拟 W27 迁移（id `example.word-of-day`、服务 `exampleWordOfDay`、命名空间 `example.word-of-day`）后全部通过
  （`owned-typecheck` 除外：它需要先生成 `src/version.ts`，属环境项）。

### 核心插件

- W18 分支（`3506543d`）和 INT 都还没有 `core: true`。内核侧不需要改。
- 临时给 editor、menu 加上 `core: true` 后，`official-plugins`（读真实官方插件表）、`core-plugin`、`editorSlots`、`appMenu`、
  `menubar.golden`、`bootstrap` 共 32 项通过。槽位快照不记录 `meta.core`；构建期表只读 id、platforms、devOnly，产物不变。

### 以前轮次的遗留

- `lazy-contributions` 转发 shim：已不存在。
- W19 debug 的 `devOnly`：INT `6c491e6f` 已放进 meta。
- W16 重录 `chunk-graph/main.json`：仍未做，最近一次是 `7089d24f`（基于 `68d37526`）。
- SEC-E06：大块仍未实施，进度写进 `SEC-E06-SANDBOX-DESIGN.md` §6。

### 验证（`c7b3ba99` 之后只有文档提交；交付前 INT 仍是 `6c491e6f`）

- 门禁：
  - ui-boundaries、event-emit、plugin-manifest、import-cycles、hardcoded-copy：0 新增、0 过期基线。
  - frontend-invoke：1 条新增，`kernel.ts:580` 的 `caller` 不在 `plugin:host|call` 的契约键里。契约归 W09，见交接。
    门禁说的“会被静默忽略”对这条命令不成立：它是 Host 内核自有命令，不走 `checkArgs`，W01 的处理函数自己读 `caller`。
  - `slot-snapshot --check`、`boundaries.mjs`、`contracts:check` 通过；`tsc -p tsconfig.json`、`tsc -p tsconfig.node.json` 0 错误。
- `bin/heavy node tests/visual/lib/boot-check.mjs --build --main`：演示壳 0 环、0 启动问题；主应用 0 环。
- vitest（`src/ui-kernel src/ui-sdk src/platform src/plugin-runtime src/ui-plugins` 加 `platformPerformanceConfig`，生成了 `src/version.ts`）：
  88 个文件 372 项，失败 5 项，都不是本轮引入的：
  - `community-example` 3 项：示例的 `package.json` 过不了清单 v1 校验，Host 不加载它。INT 版本的同一测试文件在本树上同样 3 项失败。W27 迁移后转绿。
  - 3 个取证文件（`legacy.evidence`、`legacy-boot-evidence`、`sidebar-evidence`）：本地缺旧提交，第 1 轮起的环境项。
- ESLint：改动的 `src/` 文件 0 问题。

### 交接

- W09（契约）：`scripts/electron-migration/contracts/host-native.json:62-64` 给 `plugin:host|call` 加
  `{ "key": "caller", "optional": true, "schema": { "type": "string", "minLength": 1 } }`，再 `npm run contracts:extract` 重新生成
  `contracts/ipc/F1-kernel.json`（约 560–590 行）。之后 frontend-invoke 回到 0 新增。W01 切到 `require` 时改成 `optional: false`。
- W01：
  - `host/kernel/runtime.ts:54`（W01 分支）的 `DEFAULT_HOST_CALL_CALLER_MODE` 改为 `require`，条件是 `bdd76587` 进了 INT、W14 的移动端也带上 `caller`。
  - `host/e2e/security/kernel-acl.test.ts` 补一条经 UI 内核的跨插件调用被拒的 e2e。
- W14：`mobile/src/main.ts:68` 的 `hostCall` 带上 `caller`。诊断页不是 UI 插件，用哪个 id 需和 W01 商定（按 W01 的规则只能是被调服务所属插件的 id）。
- W27：迁移 `examples/plugins/community-word-of-day`：
  - id `example.word-of-day`；顶层 `engines.deepStudent: "^0.11"`；`deepStudent` 里写 `manifestVersion: 1`、`id`、`platforms`；
  - 服务名 `exampleWordOfDay`（`pluginServiceName(id)`）；`ui.tsx:33-36` 的命名空间 `'wordOfDay'` 改为 `'example.word-of-day'`。
  - 保持 remote 方法 `today`/`history`、视图与导航 id `word-of-day`、命令 `wordOfDay.open`、版本 `1.0.0`，否则 `community-example.test.tsx` 要跟着改。
- W17 下一轮或主代理：W27 进 INT 后，把 `src/ui-kernel/kernel.ts:199` 改为 `export const STRICT_COMMUNITY_NAMESPACES = true;`。只改这一行，测试不用动。
- W18：INT 的 `src/ui-plugins/official/editor/index.ts:6`、`menu/index.ts:6`（W18 分支上 menu 是第 10 行）的 meta 加 `core: true`。
  已用临时补丁验证：相关 32 项通过，槽位快照和构建产物不变。
- 主代理：
  - `tsconfig.json` 去掉 references 的一行改动（无 owner），原因见上文。
  - `src/features/workbench/core/__tests__/platformPerformanceConfig.test.ts` 在 W09 的路径里，按派单由 W17 修改。
- W16：`chunk-graph/main.json` 仍待重录（第 6 轮的交接）。

## 第 8 轮（开工合入 INT `fe5feb68` = `d38e501b`；第五批落地后合入 INT `390f244b` = `593d11da`；交付前合入 INT `2be7ed80` = `5554a272`）

| 项 | 提交 |
|---|---|
| `settings.register` 收 `SettingsSectionRegistration`（带 `navigation`）；SDK 导出 `SettingsSection` 等；README 示例 id 改为 `acme.*`（W27 交接） | `57a8cbc7` |
| 键控槽位与旧注册表冲突的报错、注释改成 v1 口径（“用你自己的 id”），不再说“同 id 覆盖”（W27 交接） | `4982ee8f` |
| V09 P3-4：社区 UI 模块再次导入时带 `?reload=<n>`，更新、Host 重启后不再拿到旧模块 | `feb9a101` |
| V10：`bootstrap.test` 首例超时后的连锁失败（`nav.goto.chat-v2 already registered`） | `1d6c6459` |
| `meta.requires` 的依赖全被本构建或平台跳过时，依赖方记为跳过（`reason: 'requires'`），不报错（W19 建议） | `1d93de80` |
| SEC-E06 设计：第 8 轮进度和 §7 下一块的切法 | `2006787e` |
| 严格模式默认打开（RF-W17-community-i18n-strict，proposed） | `bc9f0f38` |
| W18 交接 30：保留菜单上下文类型导出，加类型测试；`menu.ts` 首句；README | `ad745b7b` |

### F7（`community-example.test.tsx` Linux 3 项红）

- 根因：W27 把示例迁到 v1（id `example.word-of-day`、slot id `<id>/today`、命令 `<id>.open`、示例 UI 半改从 `@deepstudent/ui` 导入），测试还是旧 id，根配置也没有 `@deepstudent/ui` 别名。
- 主编排合第五批时已在 `afb309bc` 修好：测试按 v1 规则派生 id，根 `vitest.config.ts` 加别名。合入 `390f244b` 后本机 3/3 通过，W17 不需要再改。

### 严格模式

- `STRICT_COMMUNITY_NAMESPACES = true`（`kernel.ts:201`）。社区插件（API v1、v2 都一样）用 `addBundle` 写非派生命名空间时抛错，插件安装失败。
  `UiKernelOptions.strictCommunityNamespaces: false` 仍可在单个内核里退回迁移期行为；依赖兼容模式的旧测试本来就显式传 `false`。
- 登记为 deliberate/proposed（`host/e2e/differential/rust-fixes/RF-W17-community-i18n-strict.json`），单独提交，可按 id 撤回。
  专门测试在 `i18n.test.tsx`。变异验证：常量改回 `false`，这条测试失败。
- 验证：`src/ui-kernel src/ui-sdk src/ui-plugins src/platform src/plugin-runtime` 全过，例外是已知环境项、本机负载下超时的 3 个类型测试，以及当时 INT 上 W16 的 `notesTreeMenu.golden`。这些都与本项无关，见下。
  `examples/vitest.config.ts` 76/78，剩下 2 项是 W27 测试在根 context 调 `ctx.ui.host`（`bdd76587` 起拒绝），与严格模式无关。
  套上 W27 交接补丁后 78/78。

### `caller` 契约

- 主编排在 `afb309bc` 应用了交接补丁（`host-native.json` 加可选的 `caller` 键，重新生成 `F1-kernel.json`），frontend-invoke 回到 0 新增。
- 仍开放：W01 把 `DEFAULT_HOST_CALL_CALLER_MODE`（`host/kernel/runtime.ts:54`）改为 `require`，前提是 W14 的移动端诊断页也带上 `caller`；届时契约里的 `optional` 改为 `false`。

### 后端事件订阅（W27 交接，只出方案）

- 社区插件的 UI 半目前订阅不到自己 Host 半发的事件；W01 `e1e3e3fc` 之后社区插件用 `ctx.backendEvents` 会被拒。
- 方案：`ctx.ui.host.on(event, handler): UiDisposer`，内核把事件名限定为 `pluginEventName(本插件 id, event)`（`<id>:<event>`），插件卸载时自动退订。
- 现在做不成闭环：插件 id 带 `.`，`host/kernel/plugin-id.ts:103-107` 生成的事件名过不了 `host/kernel/events.ts:38-40` 的校验，Host 半发不出来。等 W01 定下事件名规则再做。

### 第 7 轮遗留

- W18 `core: true`：已随第五批进 INT（W18 `44e8a9f5`）。
- W16 重录 `chunk-graph/main.json`：仍未做。
- `tsconfig.json` 去掉 references：INT 已是这样。

### 不是本轮引入、只记录的失败

- `src/ui-plugins/testing/__tests__/evidence/notesTreeMenu.golden.test.tsx` 在 INT `390f244b` 上 6/6 失败（W16 `ba0163c2`）：快照里是 `focusAfterClose`/`openedThenClosed`，实际输出是 `followUp`/`opens`。
  撤掉 W17 本轮改动后同样失败。C 批（INT `2be7ed80`，合并提交 `5554a272`）重录了证据文件，之后 6/6 通过。
- `chat-slots.types`、`registries.types`、`resource-menu.types`：本机负载 30–50 时超过用例自带的 120 s 超时（服务器上约 2–3 s）。
  用 vite-node 直接调 `runTypeTest` 核对，三个文件的断言都成立；`tsc -p tsconfig.json`（含这些 typetest 文件）0 错误。
- 已知环境项：`legacy.evidence`、`legacy-boot-evidence`、`sidebar-evidence`（本地缺旧提交）。

## 第 9 轮（开工时 INT 仍是 `2be7ed80`，第 8 轮已合入；D 批落地后合入 INT `1d1fdb78` = `443de225`；交付前合入 INT `065a68f3` = `06c06a21`）

| 项 | 提交 |
|---|---|
| W18 交接 32：`AppMenuContext` 只给 `workbench.*` 菜单带 `workbench`，其他菜单只有自己的上下文和 `t` | `19ab0479` |
| W18 交接 34：槽位同 order、槽位定义名、官方安装顺序同 order 改按码点比较 | `70db40d5` |
| 官方安装入口改从 `@/ui-sdk/order` 取 `compareCodePoints`，`70db40d5` 引入的一条 `plugin-import-boundary` 新增清零 | `03a627bb` |
| W19 交接：被跳过插件（`meta.slots`）的槽位上的贡献静默丢弃，开发构建告警一次；生产构建的官方插件表给被排除插件留元数据桩 | `a16deb7a` |
| W27 交接收尾：`kernel.test` 里键控槽位冲突的用例标题和报错断言改成“use a key of your own” | `a39b2358` |
| W18 交接 33 / 39：编辑器三处扩展点的契约设计（`contracts/EDITOR-EXTENSION-POINTS.md`） | `a57be896` |
| `kernel.ts`（1035 行）按职责拆成 `plugin.ts`、`ui-service.ts`、`kernel.ts`，代码原样搬移，对外导出不变 | `41e1f81d` |
| README：槽位同 order 的排序规则、`@/ui-sdk/order` | `f7936761` |
| 测试：`kernel.ts` 的运行时导出与拆分前相同 | `4261d7e2` |

### 交接 32（`AppMenuContext`）

- `AppMenuContext<M> = AppMenuContexts[M] & AppMenuHostFields[M]`。`AppMenuHostFields` 是按菜单 id 的映射类型：
  `workbench.*` 得到 `{ t; workbench }`，其他得到 `{ t }`。
- 不用条件类型：`appMenuHost.ts` 的 `useAppMenuRows<M>` 对泛型 `M` 传 `{ ...context, t, workbench }`，条件类型在泛型下不展开，
  tsc 报不可赋值（试过八种条件类型写法都不行）。映射类型按 `M` 索引时，写入检查的是所有分支的交集，现有宿主一行不改。
- 现有菜单 id 全是 `workbench.*`，对它们类型完全不变。和 W18 `ae23a4b0`、`assault/W18-fe-registries` 试合并无冲突，合后全量 tsc 0 错误。
- 测试：`app-menu-context.types.test.ts`（3 个带标签的预期错误）和 `app-menu-context.test.ts`（经 `dstu.ui.menu` 的槽位跑非工作台菜单）。

### 交接 34（码点排序）

- `compareCodePoints`（`slots.ts`）按码点比较，处理代理对；用于槽位同 order、`definitions()`、`installOfficialUiPlugins` 同 order。
- 官方条目（懒加载行全部载入后 269 条、100 处同 order）和官方安装顺序逐项不变；en-US、zh-CN、POSIX 三种排序规则下结果一致。
- 没改：`kernel.plugins()` / `skipped()` / `pairing()` 和 `services/errors.ts:83` 仍用 `localeCompare`。插件管理页按 `plugins()` 列出，改了是可见顺序变化，
  官方 id 全是小写 ASCII，现在两种比较结果相同。

### W19 交接（被跳过插件的槽位）

- `meta.slots`（可选）：插件 `declareSlot` 的槽位名。写了就要列全，声明未列出的槽位抛 `SlotError`。
- 插件被跳过（平台、`devOnly`、`requires`）时内核记下它的 `meta.slots`；往这些未声明槽位的 `contribute` 返回空句柄。
  开发构建对每个“贡献者 + 槽位”`console.warn` 一次，生产构建不出声。没人列出的未声明槽位照旧报错。
- 生产构建里 devOnly 插件根本不进包，内核看不到它，单靠内核做不到。所以构建期插件表从源码读 `meta.slots`，给被排除的官方插件渲染元数据桩
  （`excludedOfficialUiPlugins`），`installOfficialUiPlugins` 先装桩，内核照样记下跳过原因和槽位。副作用是 `1d93de80` 的 requires 跳过在真实生产构建里也生效了（以前只在测试和 dev server 里）。
- 桩只带 `platforms`、`devOnly`、`slots`。运行平台与构建目标不一致时桩会真的装上，安装入口立即卸载它，等同于没有这个插件。
- 生效还差 W19 一行：`src/ui-plugins/official/debug/index.ts:10` 的 meta 加 `slots: ['debug.panels']`（见交接）。在本工作树里临时打上后验证过：
  测试式生产安装和按真实插件表渲染的桩两种情况下，社区往 `debug.panels` 的贡献都静默丢弃；`debugPanelProduction.test.tsx` 3/3。验证完已还原。

### W27 交接

上一轮已做完，本轮核对：严格模式 `true`（拆分后在 `kernel.ts:52`）、`settings.register` 带 `navigation`（`57a8cbc7`）、`SettingsSection` 导出、
README 示例 `acme.study-stats`、`slots.ts:103` 与 `legacy-adapters.ts:45` 的措辞（`4982ee8f`）。`legacy-adapters.ts:3` 的注释本来就是“不能顶替别人的条目”，不用改。
剩下 `src/ui-plugins/testing/registries.ts:16` 归 W16（WAVE2-BRIEF §6），见交接。

### W18 交接 22 / 31

W18 已自行收尾，W17 不重复加契约：22 由 `faa099a9` 改走设置插件的 `workbenchMode` 服务；31 由 `b59336fe` 在 `menu.ts` 追加
`workbench.desktopShortcut` 上下文。两者随 D 批进了 INT `1d1fdb78`，合入后 `menu.ts` 同时有两边的改动，菜单相关测试全过。
`workbench.desktopShortcut` 以 `workbench.` 开头，交接 32 之后仍带 `workbench`。

### `kernel.ts` 拆分

- `plugin.ts`（98 行）：`UiPlugin`、`defineUiPlugin`、`UiAdapters` 等插件侧类型。
- `ui-service.ts`（499 行）：`UiService`（`ctx.ui`）、它依赖的运行时接口、v1 快捷方式的适配、`BUILTIN_SLOTS`。
- `kernel.ts`（473 行）：`UiKernel`（安装、跳过、卸载、Host 对账）、`STRICT_COMMUNITY_NAMESPACES`，以及原有的全部导出（转导出）。
  所有 import 点不用改；`kernel-exports.test.ts` 锁住运行时导出清单（与拆分前逐项相同）。
- 代码按行号区间原样搬移，脚本带边界检查。`RF-W17-community-i18n-strict` 的标记留在 `kernel.ts`，登记里的 `rust.line` 改为 52。
- 新模块都在 `src/ui-kernel/` 下，chunk-graph 第 1、2 条规则对这里豁免；ui-boundaries、import-cycles、frontend-invoke 都是 0 新增。

### 验证（合入 INT `065a68f3` 之后，树为 `06c06a21`）

- INT `1d1fdb78..065a68f3` 里没有别人改本工作组路径的提交；试合并无冲突。`065a68f3` 把 `RF-W17-community-i18n-strict` 改为 approved，
  与本分支把 `rust.line` 改为 52 自动合并，两处都保留。
- 门禁：`boundaries.mjs` 0 违规；import-cycles、ui-boundaries、frontend-invoke、event-emit、plugin-manifest、hardcoded-copy 都是 0 新增、0 过期基线；
  rust-fixes 107 条 0 错误；`slot-snapshot --check`、`generate-contracts --check`、`check-boundaries`、`contracts:check` 通过。
- `tsc --noEmit -p tsconfig.json`、`-p tsconfig.host.json`：0 错误（生成了 `src/version.ts`，跑完已删）。
- vitest `src/ui-kernel src/ui-sdk src/platform src/plugin-runtime src/ui-plugins`：105 个文件 427 项，失败 5 项，都在下面“不是本轮引入”里；
  6 个类型测试都在 120 s 内跑完并通过（56–75 s）。合入前在 `4261d7e2` 上同样只有这 5 项失败（102 个文件 414 项）。
- 类型测试另用 vite-node 直接调 `runTypeTest` 逐个核对（`4261d7e2`）：6 个文件 33 个标签，`clean`、`unexpected`、`missing` 都为空，33 条报错正则全部命中。
- `examples/vitest.config.ts`：9 个文件 89 项全过（合入前后各跑一次）。

### 交接（第 9 轮）

- **W19** `src/ui-plugins/official/debug/index.ts:10`：meta 加 `slots: ['debug.panels']`，即
  `meta: { id: 'dstu.ui.debug', devOnly: true, slots: ['debug.panels'] },`。
  加上之后生产构建里社区往 `debug.panels` 的贡献静默丢弃（`a16deb7a`）。在本工作树临时打上验证过，已还原。
  验证：`src/debug-panel/__tests__/debugPanelProduction.test.tsx`、`src/platform/__tests__/official-plugins.test.ts`、`src/ui-kernel/__tests__/dev-only.test.ts`。
  建议在 `debugPanelProduction.test.tsx` 加一例：生产内核里装一个往 `debug.panels` 贡献的社区插件，`install` 返回 true、不抛错。
- **W16** `src/ui-plugins/testing/registries.ts:16`：报错改为 `` `${kind} "${key}" is already registered; use an id of your own` ``，
  与 `legacy-adapters.ts:45` 一致（键控槽位的对应措辞是 `slots.ts:103` 的 `…; use a key of your own`）。
  验证：`src/ui-plugins/testing/boot-golden.test.ts`、`render.test.tsx`。
- **W18**
  - 交接 32 已落地（`19ab0479`）：资源库桌面视图、标签栏菜单的 id 不以 `workbench.` 开头时，宿主只需给 `t`。
    `src/features/workbench/components/appMenuHost.ts:3` 的注释 “actions every context carries” 现在只对 `workbench.*` 菜单成立。
  - 交接 33 / 39 的契约设计见 `src/ui-kernel/contracts/EDITOR-EXTENSION-POINTS.md`，W18 确认形状后 W17 一次追加类型。
  - `src/ui-plugins/official/content/entries.ts:37` 的同 order 排序仍是 `localeCompare`；要与槽位一致可改用 `@/ui-sdk/order` 的 `compareCodePoints`。
- **W19** `src/ui-plugins/official/dashboard/api.ts:123` 同上。

### 不是本轮引入、只记录的失败

- `content/__tests__/markdown.golden.test.tsx`（2 例）、`markdownRender.golden.test.tsx`（1 例）：实际输出里数学块的横向滚动条多了
  `os-theme-deep-student` 类（`src/lib/scroll-theme.ts:9`），golden 里没有。本分支对 `src/lib`、`src/styles`、`official/content` 相对 `2be7ed80` 没有改动，
  INT 在 `2be7ed80..1d1fdb78` 之间也没动这些文件，与本轮改动无关。
- 类型测试在本机负载 20–25 下单个约 140–155 s，超过用例自带的 120 s；负载降下来后同一批用例全过（见验证），没有改超时。
- 已知环境项：`legacy.evidence`、`legacy-boot-evidence`、`sidebar-evidence`。

## 第 10 轮（插件收口：第一批运行时 + 第二批契约）

接口发布：`.reports/lanes/plugin-closeout/interfaces/ui-runtime.md`（W17 树外）。开工基线 `e73e0d98`。

| 项 | 提交 |
|---|---|
| manifest v2 `safeMode` 消费、`CONSENT_REQUIRED` 状态暴露（RF-W17-safe-mode-community-ui，proposed） | `a3fb11ef` |
| `ctx.ui.host.on`：本插件事件命名空间 + fiber 自动退订（RF-W17-host-event-own-prefix，proposed） | `dc9871e8` |
| 第二批契约：`editor.selectionToolbar`/`editor.blockMenu`/`EditorPurpose`、`resource.types`、views 懒加载工厂、SDK 导出 | `cfee05ef` |

### 第一批

- `services/host-status.ts`：`parseHostDegradedReason` 复用 Host 的 `parseDegradedReason`，另识别 `CONSENT_REQUIRED`；
  `UiHostStatusService.safeMode`、`degraded(id)`、`consentRequired(id)`。`state()`/`availability()` 语义不变。
- `community.ts`：v2 清单 `safeMode: true` → 写 hostStatus、按空清单对账（卸载已加载的社区 UI）、之后所有清单
  （含 v1 回退事件）都被门控。官方 UI 仍是清单前的乐观安装，首帧不变。
- `services/events.ts` + `UiAdapters.events` + `bootstrap.ts`：`ctx.ui.host.on` 用 Host 的 `pluginEventName`
  派生名称，只接受本插件命名空间（完整名或本地名）；外来/近似前缀、非法字符在调用传输层之前抛错；订阅登记为
  fiber 副作用，卸载时退订（含迟到 resolve 的 `listen`）；handler 异常与传输失败进插件错误预算。
- 真实链路测试 `__tests__/host-runtime-sync.test.ts`：真实 `createTestHost` 的 v2 清单/status + 真实 `UiKernel`
  （origin/version、未知 id = missing、`recordDegraded` 的 `CONSENT_REQUIRED`）。

### 第二批（只有类型 + 辅助函数）

- `contracts/editor.ts`：`EditorPurpose`、`EditorInstanceContext.purpose`、`EditorExtensionContribution.purposes`、
  浮条与块菜单三组类型；SlotMap 加两个槽位。**未**加进 `BUILTIN_SLOTS`：由 W18 的 `dstu.ui.editor` 声明，槽位快照不变。
- `contracts/content.ts`：`ResourceOperation`/`ResourceTypeDefinition` + `resource.types`（key = 类型）。
- `contracts/shell.ts` + `shell-view.ts`：`LazyShellView`/`ShellViewContribution`，`resolveShellViewComponent`
  按 `load` 恒等缓存 `React.lazy`；`views` 槽位值类型随之改变（W38 消费）。
- `ui-sdk/index.ts` 新增类型与 `isLazyShellView`/`resolveShellViewComponent` 运行时导出；README §2/§3 更新。

### 验证

- `tsc --noEmit -p tsconfig.json`、`tsc --noEmit -p tsconfig.host.json`：0 错误。
- 门禁：`slot-snapshot --check` 通过（18 项）；ui-boundaries、frontend-invoke、plugin-manifest、import-cycles
  都是 0 新增、0 过期基线；rust-fixes 134 条 0 错误（两个新 RF 均为 proposed）。
- vitest `src/ui-kernel src/ui-sdk src/ui-plugins src/platform src/plugin-runtime`：112 个文件 463 项，
  461 通过，2 项失败都是已知环境项（`legacy.evidence`、`legacy-boot-evidence`、`sidebar-evidence` 需要本地没有的旧提交）。
  新增 6 个测试文件（含 1 个类型测试）。
- ESLint：本轮改动的文件 0 问题；`__tests__/app-menu-context.test.ts` 的 3 条 `no-unused-expressions` 基线即有，未改该文件。

### 交接

- **W01**：v2 清单顶层 `safeMode: boolean`；`CONSENT_REQUIRED` 作为降级原因前缀；`ctx.uiEvents.emit`（W27 等它）。
- **W18**：`dstu.ui.editor` 声明 `editor.selectionToolbar`/`editor.blockMenu` 并接线（`contracts/EDITOR-EXTENSION-POINTS.md` 第 2 步）。
- **W37**：golden 之后声明 `resource.types`。
- **W38**：用 `resolveShellViewComponent` 消费 `load`，再删 `useViewLayerContents`/`contentKey` 映射。
- **W35**：`ctx.ui.hostStatus.safeMode`、`degraded(id)`、`consentRequired(id)` 可直接用于管理页/同意弹窗。
- **W27**：`ctx.ui.host.on` 已可用；`UiAdapters.events` 是唯一注入点，本 lane 未实现 Host 发送路径。
