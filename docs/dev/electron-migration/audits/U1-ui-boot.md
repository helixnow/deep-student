# U1-ui-boot：改造前取证与规格阻塞

状态：**origin 接口已实施，本轮 46 项测试/类型/双构建均通过；轻量窗按 §6 保持原实现；字面同步装配差异已精确报告，待 C1 确认**。早期规格缺失记录保留为历史；已按协调者通知合并 main，并完整阅读工作树内 FRONTEND-F1.md。下文早期“未改造/待裁定/未检查”均为当时记录，以末尾当前状态为准。

## 取证基准与必读材料

- 日期：2026-11-04。
- 工作树：`/home/dsdev/dev/ds-mig/U1-ui-boot`。
- 分支：`ds-mig/U1-ui-boot`。
- 改造前 HEAD：`e30395712`（`merge ds-mig/F2-shell`）。开工时 `git status --short` 无输出。
- 已完整阅读 `docs/plugins/FRONTEND.md`（100 行）、`src/ui-kernel/` 的 7 个实现/目录条目及全部 3 个现有测试文件，并阅读三个允许修改的入口与 SDK。
- **不能完整阅读 `docs/plugins/FRONTEND-F1.md`：工作树中不存在，main 中也不存在。**
- `src/ui-plugins/` 尚不存在；这本身不作为阻塞，缺失的 F1 规格才是阻塞。

原始规格定位输出：

```text
$ git ls-tree -r --name-only main docs/plugins
docs/plugins/ARCHITECTURE.md
docs/plugins/CAPABILITIES.md
docs/plugins/FRONTEND.md
docs/plugins/SDK.md

$ git show main:docs/plugins/FRONTEND-F1.md
fatal: path 'docs/plugins/FRONTEND-F1.md' does not exist in 'main'
Exited with code 128
```

## 冻结的改造前源码清单

以下行号均对应上述改造前 HEAD；后续不能为通过测试改写此清单。它是源码取证，不是浏览器截图或交互回归结果。

### 生产入口 `src/main.tsx`

| 原条件 / 时机 | 原行为与顺序 | 新元数据 |
|---|---|---|
| 模块求值，47–67 行 | 平台 CSS 类 → 材质档位 → 启动 chat 域事件桥；开发自动化桥有原有条件；注册滚动插件、注入 DSTU logger | 未设计：等待 F1 §3 |
| 369–378 行 | 正常树：TopLevel ErrorBoundary → OverlayCoordinatorProvider → DialogControlProvider → App 与 PracticeRuntimeBridge | 未设计：等待 F1 §3 |
| `window=pomodoro-mini`，461–471 行 | 初始化轻量窗字体；动态导入并直接渲染 PomodoroMiniWindow；不执行正常运行时 | 未设计：等待 F1 §3 |
| `window=quick-assistant`，461–476 行 | 初始化轻量窗字体；动态导入并直接渲染 QuickAssistantWindow；初始化 Sentry | 未设计：等待 F1 §3 |
| 三种 recovery debug 场景，478–500 行 | 分别渲染冲突恢复、预检失败恢复、核心迁移失败恢复；保留各自边界与退出回调 | 未设计：等待 F1 §3 |
| 正常启动首帧，501–531 行 | 先渲染 BootShell；维护状态 Promise 与启动预检并发；维护状态原有失败返回形状保持 | 未设计：等待 F1 §3 |
| `recovery_required`，533–538 行 | 渲染 recoveryTree 后返回，不进入正常树 | 未设计：等待 F1 §3 |
| vfs / mistakes / maintenance_status blocked，540–556 行 | 写入系统健康状态；渲染 ComponentRecoveryShell 后返回 | 未设计：等待 F1 §3 |
| 健康启动，559–564 行 | production 或显式开发 StrictMode 时包 StrictMode，否则直接正常树；渲染后启动正常运行时 | 未设计：等待 F1 §3 |
| 预检异常，566–591 行 | Tauri 环境进入 StartupPreflightFailure 并返回；纯 Web 打原有警告后渲染正常树并启动运行时 | 未设计：等待 F1 §3 |
| 正常运行时，715–755 行 | 一次性保护且跳过轻量窗；Sentry、MCP、动态快捷助手；仅 Tauri 动态学习计时；设置/卸载/可见性监听；MCP debug | 未设计：等待 F1 §3 |
| HMR dispose，757–767 行 | 清理事件但不卸载 React root，后续求值复用 root | 未设计：等待 F1 §3 |

### 全壳演示入口 `src/demo/main.tsx`

| 原条件 / 时机 | 原行为与顺序 | 新元数据 |
|---|---|---|
| 首次求值，18–78 行 | query 决定主题和桌面模式；先 installDemoIpcMocks，再标记 demo、拒绝通知权限；预置 localStorage（卸载恢复 workbench 键）；加载样式及 i18n | 未设计：等待 F1 §3 |
| desktop，84–93 行 | App 导入前预取四个原有桌面/聊天模块，失败留待实际使用重拉 | 未设计：等待 F1 §3 |
| main，95–123 行 | 写语言包、切语言，再 Promise.all 动态导入 App、providers、自动播放与会话模块；mock 必须早于业务导入 | 未设计：等待 F1 §3 |
| 渲染，125–148 行 | 校验初始场景；按需 prepareDemoDesktop；TopLevel ErrorBoundary → OverlayCoordinatorProvider → DialogControlProvider → App；无 PracticeRuntimeBridge | 未设计：等待 F1 §3 |
| 渲染后，150–220 行 | 桌面布局、就绪轮询、自动播放、受 origin/source 限制的消息处理，最后发初始场景导航；原有 10s/15s 就绪上限不变 | 未设计：等待 F1 §3 |

### 单应用演示入口 `src/demo/app/main.tsx`

| 原条件 / 时机 | 原行为与顺序 | 新元数据 |
|---|---|---|
| 无有效 app，57–61 行 | 显示原有双语“没有名为…”文案后返回 | 未设计：等待 F1 §3 |
| 有效 app，62–95 行 | pack → localStorage/主题/标题 → IPC mocks → 文案 → pack.prepare → 并行 pack.load 与 provider/hook/root 动态导入；不加载完整 App | 未设计：等待 F1 §3 |
| 渲染，97–136 行 | DemoApp ErrorBoundary → OverlayCoordinatorProvider → DialogControlProvider → TextContextMenuProvider；ThemeSync 与原有 frame/Suspense/窗口 props 全部保留 | 未设计：等待 F1 §3 |
| 就绪，138–165 行 | afterMount、包自定义 isReady 或连续 600ms 稳定判断、12s 上限、100ms 轮询与父页通知 | 未设计：等待 F1 §3 |
| main 失败，168–172 行 | 原有 console.error、双语错误文案与 demo-app-error 通知 | 未设计：等待 F1 §3 |

### 内核现状

- `bootstrap.ts` 动态并行导入命令、chat block、workbench 注册表和 i18n，构造 adapters；没有 invoke adapter。
- `kernel.ts` 提供 6 个内置 slot、领域注册入口、Host 远程调用代理、同 id 覆盖、失败回滚与 dispose。
- `slots.ts` 支持 list/keyed/single；默认 order 为 0，按 order/id 排序；撤销贡献；快照缓存。
- `react.tsx` 提供 UiKernelProvider、useUiKernel、useSlot、useSlotEntry。
- `loader.ts` 提供 manifest 串行对账、移除/文件或版本变化时卸载、单插件错误隔离。
- `shared.ts` 提供宿主单例的 blob ESM shim 和一次性 import map。
- `src/ui-sdk/index.ts` 导出定义、slot 类型与 hooks，以及三个原有设计系统组件。
- 三个入口均尚未调用 createAppUiKernel、UiPluginLoader、installSharedModules，也未挂载 UiKernelProvider。不能把“存在内核实现”视作“已接入生产引导”。

## 改造前验证（原始结果）

目的：确认现有纯 UI 内核与 loader 的基线；若失败需在后续区分既有失败与改造引入的失败。不涉及 Host 或业务改造。

```text
$ npx vitest run src/ui-kernel/__tests__/kernel.test.ts src/ui-kernel/__tests__/loader.test.ts --maxWorkers=1 --minWorkers=1
 RUN  v3.2.7 /home/dsdev/dev/ds-mig/U1-ui-boot

 ✓ src/ui-kernel/__tests__/kernel.test.ts (8 tests) 117ms
 ✓ src/ui-kernel/__tests__/loader.test.ts (6 tests) 42ms

 Test Files  2 passed (2)
      Tests  14 passed (14)
   Start at  13:37:59
   Duration  6.12s (transform 525ms, setup 1.11s, collect 399ms, tests 159ms, environment 2.63s, prepare 434ms)

EXIT_CODE=0
```

Errors 行：**原始输出未出现 Errors 行**（不是将 Errors 1 省略为成功）。原始日志：`/tmp/opencode/U1-ui-boot-baseline-vitest.log`。

未运行：类型检查（没有代码改动；因此也未运行会写入范围外生成文件的 version:generate）、社区 Host 集成用例、构建与浏览器回归。不能据此宣称视觉、交互、移动端、主题或演示壳动态等价已经验证。

## 提交与交接

- 取证提交：本文件首次加入的提交（第一提交，仅取证）。
- 改造提交：无；所有运行时代码保持原样。
- 待 C1 协调者/架构师提供或提交 `docs/plugins/FRONTEND-F1.md`，才能确认 U1 行、元数据契约、跨 lane 接口与 §5 验收命令；不得用 FRONTEND.md 的总体设计代替缺失的执行规格。
- 原条件 → 新元数据表当前只冻结左侧事实，右侧明确未实施，未伪造完成情况。取得规格后先补齐规格要求的 golden 取证，再改造；不得回写上述基线以迎合实现。

## 补充：可执行 golden 取证（生产改造前）

- `8597b23f2` 只是初步静态审计，不视为可执行 golden 完成。
- 合并 main 后规格阻塞解除。按架构师裁定，golden 放到 `src/ui-plugins/testing/__golden__/boot/`。
- `boot-entry-harness.ts` 使用 TypeScript 转译 + VM **执行三个真实入口源文件**，在 React root、业务组件、IPC、浏览器环境边界提供惰性替身，记录实际导入序列、渲染组件树、mock 安装、demo 标记、locale/localStorage、正常运行时副作用。未另写一份启动分支来充当旧实现。
- `boot-golden.test.ts` 覆盖 16 个输入组合：正常、production/Tauri、mobile/显式 StrictMode、recovery、blocked、桌面/Web 预检异常、3 个 debug 恢复分支、2 个轻量窗、经典 demo、desktop/dark demo、单应用 demo 与未知 app。演示用例另外断言 mock 早于业务 import。
- boot 不是可见菜单贡献，不新增 id、labelKey 或 icon；取证对象是入口选择、原有可见组件树和副作用顺序。页面内部视觉/交互仍由领域 lane 和最终回归验证，此 harness 不冒充浏览器渲染。
- 使用显式 `U1_RECORD_GOLDEN=1` 首次录制；生产改造后仅比较既有 JSON，禁止重新录制来迎合实现。

```text
 Test Files  1 passed (1)
      Tests  16 passed (16)

[作业 20261104064328-d5a99f] env U1_RECORD_GOLDEN=1 npx vitest run --config vitest.config.ts src/ui-plugins/testing/boot-golden.test.ts --maxWorkers=1 --minWorkers=1
[作业 20261104064328-d5a99f] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104064328-d5a99f.log
```

Errors 行：原始结果无 Errors 行；有 Node 的 localStorage ExperimentalWarning，未发生测试错误。

### 取证修正（独立提交，未使用新实现生成 JSON）

首次 golden 的通用模块 Proxy 对任意属性均返回函数，包括 `then`。CommonJS 转译后的动态 import 返回该对象时触发 Promise 的 thenable 吸收，导致轻量窗和 demo 记录停在 import，没有记录 render。证据：`7f915ae5f` 中 pomodoro.json 末尾仅有 font/import，无 render；改造后增加“必须创建内核”断言的作业 `20261104064903-0dc2ba` 报 6 failed / 28 passed，退出码 1，无 Errors 行。

修正替身的 `then` 为 undefined，并用 `git show e30395712:<三个入口路径>` 执行**真正改造前的入口**重新录制（不是当前入口）。修正时同时核对旧源与新源；完成后移除录制开关和 Git 历史读取，正常测试仅比较当前入口与冻结 JSON，不依赖 CI 是否保留旧 Git 历史。

```text
 Test Files  1 passed (1)
      Tests  16 passed (16)
[作业 20261104065134-dd928b] env U1_CORRECT_BASELINE=1 npx vitest run --config vitest.config.ts src/ui-plugins/testing/boot-golden.test.ts --maxWorkers=1 --minWorkers=1
[作业 20261104065134-dd928b] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104065134-dd928b.log
```

Errors 行：原始结果无 Errors 行。修正提交前被协调者自动检查点 `e354acaa6` 收走，实际该 checkpoint 混入了此前生产改造；人工说明提交为 `5605d964c`（只有文档）。如实记录此提交隔离偏差，不把该自动 checkpoint 冒充纯取证提交。

协调者自动检查点 `397b64161` 已保存当时未完成的生产改造，不是验收通过的改造提交；后续以人工验证单元提交和最终报告为准。

## 当前实施与原条件 → 新装配对照

| 原条件 | 新装配 / 保持不变的部分 |
|---|---|
| 正常启动健康、或纯 Web 预检不可用时 | 在原有 preflight/maintenance 分流之后调用 createAppUiKernel；官方安装完成后用 UiKernelProvider 包裹原 appTree；原 StrictMode、文案和业务树不变 |
| recovery / blocked / debug 恢复分支 | 不创建内核，不加载官方或社区模块，保留原恢复组件树 |
| 两个轻量窗 | **保持原实现**，不等待内核装配；原因见下节待裁定事项 |
| 全壳 demo | 原 mocks/localStorage/locale、App 与业务动态 import、desktop.prepare 和 createRoot 导入顺序不变；随后装配官方内核并包 Provider；不启动社区通道 |
| 单应用 demo | pack → mock → locale → prepare → pack.load 顺序与原 frame/props 不变；渲染前装配官方内核并包 Provider；不启动社区通道 |
| 正常桌面运行时且非 __DS_DEMO_SHELL__ | 动态加载 community.ts；先监听 host://ui-manifest，再取 plugin:ui\|manifest；新事件优先于更旧的初始响应 |
| 空清单 | 不导入共享 SDK、不创建 blob/import map、不导入社区模块；仅保留发现后续安装所必需的一次取清单和事件订阅 |
| 首个非空社区清单 | 先安装 react/react-dom/@deepstudent/ui/i18next 的宿主单例 import map，再 import 社区模块；后续复用映射 |
| 清单更新 / 卸载 | 经原 UiPluginLoader 串行对账；新增 dispose 防止待完成导入在清理后重新安装；单插件导入/apply 错误继续隔离 |
| 官方领域扩展点 | install.ts 以 import.meta.glob('./*/index.ts', { eager: true }) 收集，按插件 order 再 id 安装；传递组件/工厂引用，不求值 lazy factory |

涉及路径：三个入口、ui-kernel/bootstrap.ts / community.ts / kernel.ts / loader.ts、ui-plugins/official/install.ts、ui-plugins/testing/ 与 ui-kernel/__tests__/；没有修改 Host、Electron、IPC 契约、plugin-runtime、translation 或领域文件。

### 共享消费者测试接口（已提供）

`src/ui-plugins/testing/render.tsx`：

- `createOfficialUiTestKernel(adapters?: UiAdapters): Promise<UiKernel>`：真实 Cordis 内核 + 与生产相同的官方 glob 安装器。
- `renderWithOfficialUi(children, options?)`：返回 Testing Library render 结果、kernel 和异步 dispose；wrapper 在 rerender 时保留同一个 kernel。
- 未向生产 hook 加私有 fallback，也未修改测试的全局 setup。
- C1 所列裸 render 的两个文件仍需有权限的 lane 接线：`src/components/layout/__tests__/MobileSidebarNavigation.dedup.test.tsx`、`tests/vitest/modernSidebarNavigation.test.tsx`。这两个原测试文件不在 U1 白名单内。
- 当前 main 尚未合入 U2–U4 的官方领域目录，glob 当前为空；排序/工厂惰性用真实 defineUiPlugin 与 UiKernel 的安装测试验证，待领域合并后同一 boot 测试会比较真实注册的 slot id/key/order/owner 与 Provider 内核。没有复制其他 lane 的业务实现。

### 待架构师 / C1 裁定（未硬改）

1. **轻量窗 Provider**：快捷助手原动态 import 的即时完成输入下，render 先于 Sentry get_setting；等待 createAppUiKernel 后顺序反转。作业 `20261104065339-700234`：2 failed / 14 passed，退出码 1，无 Errors 行（另一失败为 Web 日志顺序，已保持旧相对顺序）。恢复两个轻量窗原始分支后 golden 全部通过；没有改 golden 放行。需裁定是否允许轻量窗等待装配/改变该并行相对顺序，或提供独立、同步且不新增首屏依赖的轻量内核策略。在此之前 U1 不宣称轻量窗 Provider 已完成；U4 若让快捷助手使用的 Markdown 消费强依赖 Provider，应共同处理，不能让此路径带缺失 Provider 上线。
2. 原恢复路径没有消费 slot，保持原实现而非让恢复屏等待官方/社区插件。
3. 社区贡献的**组件渲染**错误边界应由领域 slot 消费者落地；U1 loader 只负责 import/apply 错误隔离，不会把后者冒充前者。U1 不越权修改 App/Settings/Markdown 等领域消费文件。

### 验证记录（当前）

先运行 `npm run version:generate` 成功（退出码 0），再提交前端 tsc 作业；其生成的 src/version.ts 和队列生成的 .lane.tsbuildinfo 不提交。

```text
[作业 20261104064926-889500] npx tsc --noEmit -p tsconfig.json --incremental --tsBuildInfoFile .lane.tsbuildinfo
[作业 20261104064926-889500] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104064926-889500.log
```

Errors 行：原始结果没有 Errors 行，也没有 TS error。

中间测试作业 `20261104065807-6e7618`：1 failed / 39 passed，退出码 1，无 Errors 行。失败是测试用固定 event-loop 次数等待共享模块动态导入，负载下未完成；改为等待真实 slot 注册后再断言，未削弱断言。

```text
 Test Files  7 passed (7)
      Tests  40 passed (40)
[作业 20261104070126-3b9dff] npx vitest run --config vitest.config.ts src/ui-kernel src/ui-plugins/testing --maxWorkers=1 --minWorkers=1
[作业 20261104070126-3b9dff] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104070126-3b9dff.log
```

Errors 行：原始结果无 Errors 行；含 Node localStorage ExperimentalWarning。

```text
FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory
[作业 20261104065401-4eacb9] npx vite build
[作业 20261104065401-4eacb9] 退出码 134；完整输出 /home/dsdev/.oc-jobs/done/20261104065401-4eacb9.log

FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory
[作业 20261104065401-1c6c53] npm run build:demo
[作业 20261104065401-1c6c53] 退出码 134；完整输出 /home/dsdev/.oc-jobs/done/20261104065401-1c6c53.log
```

两次构建均在约 4GB Node 堆上限 OOM，未视为通过。已排队 8GB 堆重跑（不改构建配置）：`20261104070227-f70aae`（生产）、`20261104070227-4f954c`（demo）。最终类型检查重跑：`20261104070127-23ec36`。

```text
[作业 20261104070127-23ec36] npx tsc --noEmit -p tsconfig.json --incremental --tsBuildInfoFile .lane.tsbuildinfo
[作业 20261104070127-23ec36] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104070127-23ec36.log
```

最终类型检查 Errors 行：原始结果无 Errors 行，输出为空。

8GB Node 堆重跑的最终结果（没有改构建配置）：

```text
[vite-plugin-static-copy] Copied 77 items.
✓ built in 5m 8s

[作业 20261104070227-f70aae] env NODE_OPTIONS=--max-old-space-size=8192 npx vite build
[作业 20261104070227-f70aae] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104070227-f70aae.log

[vite-plugin-static-copy] Copied 77 items.
✓ built in 5m 4s
[demo-build] warmup preloads injected into hero.html: 10

[作业 20261104070227-4f954c] env NODE_OPTIONS=--max-old-space-size=8192 npm run build:demo
[作业 20261104070227-4f954c] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104070227-4f954c.log
```

两个完整构建日志均无 Errors / ERROR / error during build 行；保留了既有 Browserslist、chunk size 等警告；demo 还提示既有 vite.demo.config.ts 重复 rollupOptions key，U1 不越权修改配置。以上构建验证的是当前工作树，尚不包含未合入 main 的其他 UI lane 领域实现，不是合并后的全前端验收替代品。

### 完成边界

- 已完成：三个入口 normal/demo 的生产装配、官方 glob 安装、社区清单订阅/对账、首次社区 import 前共享映射、生命周期清理、共享真实内核测试接口；16 组冻结 golden + 其余内核/真实 Host 示例测试合计 40 项通过。
- 等价性证据限制：harness 验证入口控制流、可见组件树与既有业务 import/副作用顺序，不验证像素或浏览器实际性能。新增装配基础设施不记入旧业务 trace，Provider 另行断言确实包住渲染树，内核 slot 元数据另行逐字段比较。
- 未完成、保留旧实现：轻量窗的 Provider，详见上方可复现顺序差异与裁定请求。
- 待授权路径接线：两个裸 render 消费者测试，已给出精确路径与共享 helper；未加生产 fallback。
- 待集成复核：U2–U4 合入后的官方 slot、社区贡献组件渲染错误边界。
- 生成文件 `src/version.ts`、`.lane.tsbuildinfo` 是按必需命令生成的未跟踪产物，不属于提交内容；没有删除或覆盖它们。

### 当前提交索引

- `8597b23f2`：初步静态取证（不充当 golden）。
- `7f915ae5f`：首个可执行取证 + JSON（不含生产改造）。
- `397b64161`：协调者自动检查点，保存初步 boot / installer / helper 改造。
- `e354acaa6`：协调者自动检查点，包含从旧源纠正的 golden 和当时生产 WIP；不是纯取证提交。
- `5605d964c`：取证纠正原因说明。
- `f93f3b37c`：协调者自动检查点，安装排序、真实消费者 render/重渲染、卸载测试。
- `89baf1f84`：协调者自动检查点，保存轻量窗回退、正常入口顺序修正、完成态等待与 golden 比较。
- `04e1bcc88`：通过当前 40 项测试后的人工实施报告与 demo-app Provider 排版提交；主要实现已由上述 checkpoint 保存，不伪称都在本提交内。
- `0c954da2e`：最终 tsc 与自动 checkpoint 来源记录。

## C1 07:19Z 续作：独立取证修复来源证明

此补充**不是**对 `e354acaa6` 混合提交的事后改名。它仍违反所要求的纠错提交隔离，是否接受此事故的补救路径由架构师裁定；未 rewrite/drop 任何历史、未调整 golden、未生成匹配当前生产实现的 expected。

新增 `src/ui-plugins/testing/legacy-boot-evidence.test.ts`，只读执行如下三份固定历史材料：

- 改造前入口：`e303957124ac220f55bee1b04cca5d3937983b92` 的三个 main.tsx。
- 首次取证 harness、全部 16 个输入组合与原始 JSON：`7f915ae5f1799ee9de9c7f40a7386d785eba7475`。
- 纠错后的 JSON：`e354acaa66c1b04c64a944765c99844ca5115d49`；并与本树冻结 JSON 比较以检测事后漂移。

执行机制和断言：

1. 原封不动执行**首次取证 harness**，但其 fs.readFileSync 被限制为读取上述固定旧入口（不是工作树文件），逐字段重现首次 JSON 的缺陷。
2. 在同一固定 harness 中仅把通用模块 Proxy 的 `then` 属性改为 undefined；没有改其他替身、业务公式、输入或 expected。执行同一旧入口，逐字段匹配纠错 checkpoint 的 JSON 和当前冻结 JSON。
3. 对全部 16 个场景验证原 trace 的每一行均原样、原序保留；纠错只能增加首次 recorder 丢失的步骤。精确断言仅下列 5 个文件发生增加，其余 11 个完全不变。
4. 该证据测试不 import 当前 boot harness、UiKernel、install.ts 或生产入口；依赖白名单只允许 Node fs/path/vm 和 TypeScript，不读当前业务实现生成输出；测试中无写文件或重录入口。

| 纠正的 JSON | 固定旧入口原有执行位置（e30395712 行号） | 首次录制漏项（按顺序） |
|---|---|---|
| assistant.json | src/main.tsx 473–475 | QuickAssistantWindow render；位置仍在 get_setting invoke 之前 |
| pomodoro.json | src/main.tsx 469–471 | PomodoroMiniWindow render |
| demo.json | src/demo/main.tsx 134–148、189–193、220 | react-dom/client import、完整原 App provider 树 render、autoplay、初始 navigate |
| demo-desktop-dark.json | src/demo/main.tsx 131–155、189–193、220 | desktop import、desktop.prepare、react-dom/client import、原树 render、desktop.arrange、autoplay、初始 navigate |
| demo-app.json | src/demo/app/main.tsx 104–136 | 原 DemoApp ErrorBoundary/provider/frame/Suspense/FixtureApp 树 render |

以上所有新增树字段也都逐字段比较，不只断言有 render。旧 recorder 对任何未知属性返回函数，使动态 import 的模块对象意外成为 thenable；修正的是测试模块替身，不是旧入口。来源证明专门重现这点，不掩盖初次记录的质量问题。

首次运行新证据测试作业 `20261104073307-b8dfb9`：退出码 1，1 failed，无 Errors 汇总行；是证据测试外层 VM 未显式提供 URLSearchParams，已按浏览器原环境传入该标准构造器，未改变历史 harness 或任何 expected。后续结果另记。

```text
 ✓ src/ui-plugins/testing/legacy-boot-evidence.test.ts (1 test) 4762ms
 Test Files  1 passed (1)
      Tests  1 passed (1)
[作业 20261104073403-217dea] npx vitest run --config vitest.config.ts src/ui-plugins/testing/legacy-boot-evidence.test.ts --maxWorkers=1 --minWorkers=1
[作业 20261104073403-217dea] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104073403-217dea.log
```

Errors 行：原始输出无 Errors 行；含 Node localStorage ExperimentalWarning。此单项测试实际执行 16 组 × 原始/修正两种 recorder，对应 32 次固定旧入口执行，不把它计为“32 tests”。本续作没有生产改动，因此未重复既有四项重门禁；只运行检测取证来源污染/旧 trace 重写/JSON 漂移的此最小用例。证据依赖完整 Git 历史，历史不在时直接失败，不 skip 或转用当前实现。

本次独立提交的准确来源：`1f1e5bc5b` 为协调者自动检查点，**只含新增 legacy-boot-evidence.test.ts**，无 golden、生产或其他文件；`be01c31aa` 只含上述独立证据说明与结果。这两项均仅取证，不再混入生产 WIP。没有修改旧混合 checkpoint 的历史或声称它已变为合规纯取证。

## R6-10：供 C1 / U2 / 架构师裁定的最小来源区分方案（尚未实施）

已只读核对 U2 当前 `src/ui-plugins/official/shell/renderNavigationIcon.tsx`：按 `owner === 'dstu.ui.shell'` 绕过边界；U1 kernel 的 fiberOwner 则仅保存该 id。合法社区同 ID 覆盖时二者确实无法区分来源。R6 已有真实反例，本轮不重复制造另一套复现，不把普通社区 ID 的通过结果当作该问题已解决。

建议契约如下，**需 C1 转交 U2 确认、架构师批准后落地**（当前没有 U2 的确认，不宣称“已对齐”）：

1. U1 在内核增加 `UiPluginSource = 'builtin' | 'community'`，来源由安装调用路径决定，不放在 `UiPluginMeta` / contribution.value，不由插件的 id、name、命名空间前缀或自报字段推导。
2. 保持现有 `install(plugin, config?)` 参数含义；新增第三参数 `options?: { source?: UiPluginSource }`，缺省为 community。仅 `installOfficialUiPlugins` 的生产装配路径传 `{ source: 'builtin' }`；UiPluginLoader 调用传 community（或使用同义缺省）。
3. 内核按**当前安装的 fiber**记录 `{ id, source }`；同 ID 卸载后覆盖的新 fiber 有自己的来源。`UiService.contribute` 用真实 fiber 的来源构造 `SlotEntry.source`，与 owner/id/order/key 同层；它不是插件可在贡献值中自报的属性。SlotStore 构造 entry 时由单独内核参数提供 source，放在 contribution 字段之后，防止值字段误覆盖。owner 继续只用于归属、撤销和 key，不再承担来源判定。
4. U2 让 `renderNavigationIcon` 接收 entry 的 source，只有 `source === 'builtin'` 走原官方无边界路径，community（包括 owner 为 dstu.ui.shell）走现有局部 ErrorBoundary。两个导航消费者传递完整 entry 或其 owner/id/source 投影，不能丢掉来源后再靠 ID 猜。无需改标签、点击处理、顺序、DOM 或新增信任提示。
5. 必需的最小回归：真实官方安装器来源为 builtin；loader 安装同 ID 社区实现后 owner 仍同 ID 但 source 变 community；坏图标被局部捕获、标签/操作/邻项存活；卸载删除该 fiber 的贡献；重新官方安装恢复 builtin；异步/子 fiber 的贡献同样继承真实安装来源。U2 的“任意用官方 ID 安装 BrokenIcon 并断言外层失败”不能再称为真实官方来源测试，应显式经过官方安装器路径和社区路径分别验证。

计划分工：U1 仅改 kernel/slots/loader/official/install 与内核测试；U2 改其 renderNavigationIcon / 两导航消费者 / 隔离测试；不越权改领域契约。对其他领域消费者可沿用同一 `SlotEntry.source`，由对应 lane 决定边界位置，不在 U1 复制业务。

这是渲染错误隔离所需的安装来源标记，**不是同进程已安装代码的安全/权限边界**，不新增信任 UI、权限模型、哈希或包认证。默认 community 能避免现有测试/直接 install 因可重用 ID 获得免边界待遇。轻量窗与原消费者测试授权仍按此前裁定请求保持原实现，无新增改动。

## C1 转发架构师 §6：已实施的 origin 与订阅接口

本节覆盖上方旧的“source / 第三参数”建议，以正式裁定的 **origin / 第二参数 options** 为准。轻量窗不装配已转为正式要求，原来的轻量窗阻塞解除；没有再改轻量窗或 golden。五处 golden 的固定旧提交号、文件行号、原取证错误与独立可执行来源证明已在上节逐条提供；补救能否接受仍由 R6 按 §6.4 核验，不自行认定混合提交已合规。

### 给 U2 / U3 / U4 的准确公开契约

```ts
// src/ui-kernel/slots.ts，亦从 src/ui-kernel/kernel.ts / src/ui-sdk/index.ts 导出类型
type UiPluginOrigin = 'builtin' | 'community';

// src/ui-kernel/kernel.ts，亦从 src/ui-sdk/index.ts 导出
interface UiPluginInstallOptions<C = void> {
  origin?: UiPluginOrigin; // 缺省 community
  config?: C;            // 插件配置，与安装来源分开
}
// UiKernel 实例方法
install<C>(plugin: UiPlugin<C>, options?: UiPluginInstallOptions<C>): Promise<void>;

// src/ui-kernel/slots.ts / SDK：在原 SlotEntry 字段上新增
interface SlotEntry<T> {
  // 原 id/key/order/value/owner 不变
  origin: UiPluginOrigin;
}

// src/ui-kernel/react.tsx / SDK
useSlot<T>(name: string): readonly SlotEntry<T>[]; // 原严格 Provider 要求不变
useSlotEntry<T>(name: string, key: string): SlotEntry<T> | undefined;
useOptionalSlot<T>(name: string): readonly SlotEntry<T>[] | undefined;
```

- `useOptionalSlot` 只有**无 Provider**时返回 undefined；有 Provider 的空 slot 返回稳定的 []，不能在社区卸载/清空后回填官方条目。U4 可 `useOptionalSlot<T>(name) ?? OFFICIAL_STATIC_ENTRIES`，官方表须为它注册入 slot 的同一份数据，U1 不复制领域表。
- 原生订阅接口不变：`kernel.slots.subscribe(listener)`、`list<T>(name)`、`get<T>(name,key)`；快照含 origin，只有条目变动才换引用。React hooks 同步订阅它；来源变更通过旧 fiber 移除/新 fiber 添加发通知。
- `installOfficialUiPlugins` 明确传 `{ origin: 'builtin' }`；`UiPluginLoader` 明确传 `{ origin: 'community' }`。所有其他直接 install 缺省 community，即使 meta.id 为 dstu.ui.shell。
- fiberOwner 现保存 `{ id, origin }`，贡献自动从真实父/子 fiber 获取来源。来源不读 meta、owner 字符串或 value，也不接受 contribution 自报覆盖；同 ID 替换不会继承旧 fiber 的 builtin 来源。
- 配置调用现在是 `install(plugin, { origin, config })`；全仓本树已有 UI install 调用未使用旧第二参数传配置，无需添加兼容层。
- 共享测试装配 `createOfficialUiTestKernel` / `renderWithOfficialUi` 仍调用生产官方安装器，因此贡献自然带 builtin。U2 被授权的原测试仍由 U2 修改，U1 不越权。

### 本轮最小验证

检测的具体失败：同 ID 覆盖错误继承 builtin、贡献可自报 origin、异步/子 fiber 丢来源、origin 更新不通知订阅、无 Provider 回退错误地在 live 空 slot 上触发。失败则修内核/订阅，不改 golden 或降低隔离断言。

```text
 ✓ src/ui-kernel/__tests__/origin.test.ts (3 tests) 48ms
 ✓ src/ui-plugins/testing/install.test.ts (1 test) 115ms
 ✓ src/ui-plugins/testing/origin-render.test.tsx (2 tests) 3474ms
 Test Files  3 passed (3)
      Tests  6 passed (6)
[作业 20261104074931-7004d4] npx vitest run --config vitest.config.ts src/ui-kernel/__tests__/origin.test.ts src/ui-plugins/testing/origin-render.test.tsx src/ui-plugins/testing/install.test.ts --maxWorkers=1 --minWorkers=1
[作业 20261104074931-7004d4] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104074931-7004d4.log
```

Errors 行：原始输出无 Errors 行。渲染测试走真实 official installer → UiPluginLoader 同 ID 覆盖 → useSlot 更新 → 生产 ErrorBoundary，断言坏图标被隔离、标签点击可用、其他导航仍在、卸载无残留；此测试的 Navigation 是 U1 的最小消费者装配，不冒充 U2 两个实际导航消费者已经改用 origin，后者仍需 U2 落地/R6 独立复核。

### 本轮提交与恢复

- `c32d54b24`：自动检查点，保存 origin 的 slots/loader/installer/hooks/SDK 与来源/渲染测试。
- `6bd437e73`：人工提交，保存 kernel 的 origin/options/fiber 实现与上述公开接口报告。两者共同组成完整 origin 发布，不把自动检查点遗漏为“全部只在人工提交内”。
- 服务重启后先核对这两个提交和工作树，未重做已通过的 6 项最小验证。
- `684f3e805`：合并 main，工作树规格现已含架构师正式 §6；没有直接修改主仓库或规格。

### §6.1 同步注册的真实边界（不能伪报同步）

核实 F0 依赖 `node_modules/@deepseek-ai/cordis/src/fiber.ts:646–656`：`_reload()` 总是先 `await Promise.resolve()`，再调用插件 callback。因此即使官方 apply 只注册静态元数据，`kernel.install` 也不能在同一个调用栈中完成注册。曾用测试直接断言“installer 返回 Promise 后、尚未 await 就已有全部官方条目”，作业 `20261104075925-18c737` 真实失败：1 failed / 45 passed，退出码 1，无 Errors 行；其余 16 个 boot golden 与 origin/隔离测试均通过。

为尝试同步而并发启动官方 fibers 的临时改动没有解决该事实，已恢复按 order 串行 await 的官方安装器；未修改 Cordis 或 golden。测试明确等待安装完成后再验证 order、origin 和惰性工厂，**不把此 await 后通过当作“同步注册”证据**；未删除任何原有排序、工厂、origin 断言。自动检查点 `96e4cbfe9` 只保存了这个尚未修正的同步断言测试，后续提交恢复正确的异步事实说明。

当前生产保证：主窗口先保持原 BootShell/预检分流，`await getUiKernel()`（内部 await 全部官方注册）后才首次渲染正常 App/Provider 树；demo 同样 await 内核后首 render。不会用空/半装配内核先渲染正常树，也不改变轻量/恢复分支。字面意义的“首个 root.render 前同步内核”目前**未实现**：原 BootShell 在内核之前，且没有构造另外一份私有快照绕过 Cordis。

此精确差异交 C1/架构师确认：是否“原 BootShell 保持、首次正常 slot 消费树仅在装配就绪后渲染”满足 §6.1；若要求正常树在异步装配期间也立即上屏，应由各领域提供与注册共用的官方静态表后走无 Provider 首帧，不能 U1 越权复制领域数据或修改 Cordis 调度。U4 的无 Provider 同步官方回退所需 `useOptionalSlot` 已公开且有测试；U1 不因该处字面差异拖延 origin 交付。

### 本轮四门禁排队

先运行 version:generate，退出码 0；再提交 tsc。作业均经全局队列：

| 命令 | 作业 |
|---|---|
| 受影响目录完整测试（修正异步事实后） | 20261104080300-606ea6 |
| npx tsc --noEmit -p tsconfig.json | 20261104075926-022cd7 |
| env NODE_OPTIONS=--max-old-space-size=8192 npx vite build | 20261104075926-4eb66e |
| env NODE_OPTIONS=--max-old-space-size=8192 npm run build:demo | 20261104075926-ebcee0 |

排队不视为通过，结果将追加。当前没有再次改动 goldens，`git diff --name-only e354acaa6 -- src/ui-plugins/testing/__golden__/boot` 无输出。

### 本轮测试与类型检查最终结果

```text
 Test Files  10 passed (10)
      Tests  46 passed (46)
[作业 20261104080300-606ea6] npx vitest run --config vitest.config.ts src/ui-kernel src/ui-plugins/testing --maxWorkers=1 --minWorkers=1
[作业 20261104080300-606ea6] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104080300-606ea6.log

[作业 20261104075926-022cd7] npx tsc --noEmit -p tsconfig.json --incremental --tsBuildInfoFile .lane.tsbuildinfo
[作业 20261104075926-022cd7] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104075926-022cd7.log
```

两项原始输出均无 Errors 行；测试有 Node localStorage ExperimentalWarning。46 项包含 16 个冻结 boot golden、独立来源证明、真实 Host 社区示例及新的 origin/隔离/可选订阅测试，不替代 U2–U4 的领域验收。

中间构建真实成功结果（不冒充最终安装器版本）：

```text
✓ built in 6m 24s
[作业 20261104075926-4eb66e] env NODE_OPTIONS=--max-old-space-size=8192 npx vite build
[作业 20261104075926-4eb66e] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104075926-4eb66e.log

✓ built in 6m 29s
[demo-build] warmup preloads injected into hero.html: 10
[作业 20261104075926-ebcee0] env NODE_OPTIONS=--max-old-space-size=8192 npm run build:demo
[作业 20261104075926-ebcee0] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104075926-ebcee0.log
```

两项构建期间撤回过临时并发 installer。读取实际产物 `dist/assets/install-Dh2TSU7t.js` 和 demo 同名产物，确认仍是 `.map(...install(...)); await Promise.all(...)`，不是最终恢复的串行 installer。因此没有将它们直接报为最终源版本构建门禁；仅为这个确切已知差异排队最终源重建 `20261104081323-f6e346`（生产）与 `20261104081324-66eec5`（demo），不重复已通过的测试和类型检查。

当前 origin 实施人工提交 `6bd437e73`（连同 `c32d54b24` checkpoint）；就绪事实/异步边界人工提交 `c90cbab45`。除测试断言与报告外，最终生产 installer 与前一 origin 人工提交相同。

### 最终源双构建结果与交付边界

```text
[vite-plugin-static-copy] Copied 77 items.
✓ built in 5m 47s
[作业 20261104081323-f6e346] env NODE_OPTIONS=--max-old-space-size=8192 npx vite build
[作业 20261104081323-f6e346] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104081323-f6e346.log

[vite-plugin-static-copy] Copied 77 items.
✓ built in 5m 43s
[demo-build] warmup preloads injected into hero.html: 10
[作业 20261104081324-66eec5] env NODE_OPTIONS=--max-old-space-size=8192 npm run build:demo
[作业 20261104081324-66eec5] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104081324-66eec5.log
```

两个完整日志均无 Errors / ERROR / error during build 行。存在既有 chunk-size / Browserslist 等警告，未修改配置。实际 `dist/assets/install-B5i7tBT8.js` 与 demo 同名产物为 `for (const plugin of ordered) await kernel.install(plugin,{origin:"builtin"})` 对应的最终串行实现，不再是中间并发候选。

本轮四门禁总结：测试 `20261104080300-606ea6`（46 passed）、tsc `20261104075926-022cd7`、生产 `20261104081323-f6e346`、demo `20261104081324-66eec5`，原始退出码全部 0，原始输出均无 Errors 汇总行。

可立即交其他 lane 使用的实现为 `c32d54b24` + `6bd437e73`（后续提交仅补就绪断言事实与报告）：

- U2/U3/U4 从 `@/ui-kernel/slots` 或 SDK 取 `SlotEntry<T>`；判定只用 `entry.origin === 'builtin'`，owner 只作归属/key，不用 ID 作边界豁免。
- U4 从 `@/ui-kernel/react` 或 SDK 取 `useOptionalSlot<T>`，只在结果 undefined 时同步回退其同一官方静态表；Provider 内卸载为空不得回填。
- 需要显式官方装配的测试仍用 `@/ui-plugins/testing/render` 的真实官方 installer helper；普通 `install(plugin)` 缺省 community。

尚不宣称整体 F1 完成：U2/U4 的实际消费点须接 origin 并由 R6 验证；main 当前仍无其他 UI lane 领域目录；§6.1 的 Cordis 异步 activation 与首个 BootShell 的字面同步差异已单列，不暗中增加页面同步依赖或私有静态快照。五处 golden 来源补救由 R6 核验，本轮未再次改动 golden。未跟踪 `src/version.ts` 为规定生成步骤产物，未提交或手动删除。

## 集成失败通知续作：4GB 构建 OOM 与合并后检查

协调者通知两项集成构建均出现 `FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory`，GC 日志在约 4GB 堆处失败；通知未提供编译错误或失败作业号。未把该通知解释为测试/类型错误，也未改动 U1 运行时代码或 golden 来规避。

按要求执行 `git merge --no-edit main`，成功产生 `224c356e1`。从此前最终交付 `9d58350f4` 到合并后 HEAD，三个入口、ui-kernel、ui-sdk、ui-plugins 的源码差异为空。本轮只追加报告。

### 防 OOM 修复已由 main 提供，无需 U1 越权修改

合并获得 main 提交 `081b3426d`，只读核对：

- `scripts/electron-migration/integrate-parallel.mjs:148–152`：集成生产/demo 构建均显式传 `NODE_OPTIONS=... --max-old-space-size=8192`，设置 `serial: true`。
- `scripts/electron-migration/gate-runner.mjs:16`：子进程接收各检查的 env；32–80 行为 serial 构建提供跨集成工作树全局构建槽，且同树先后运行。
- `scripts/electron-migration/jobs/runner.mjs:82`：普通作业队列的 build 类同样默认增加 8GB 堆。

这覆盖了通知中的默认 4GB 堆 OOM 条件；不是宣称新的集成已通过。此前最终源的两项 8GB 构建 `20261104081323-f6e346` / `20261104081324-66eec5` 退出码均 0，C1 已亲取接受；本轮前端源码无变化，不重提同样的双构建，建议协调者使用带 `081b3426d` 的最新 main 重新正常集成。若新门禁仍失败，需提供新作业号/完整日志与实际 Node 堆参数再定位，不把旧 OOM 当成新的实现错误。

### 本次按通知执行的检查（全部经全局队列）

```text
> deep-student@0.11.0 typecheck:host
> tsc -p tsconfig.host.json
[作业 20261104091058-fdc404] npm run typecheck:host
[作业 20261104091058-fdc404] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104091058-fdc404.log

boundaries: scanned 2337 files, 0 violation(s), 166 suppressed via boundary-allow; rules: native-import, tauri-import, cross-plugin-impl, electron-imports-plugin, sql-outside-repository, test-double, todo-marker, empty-catch, erasable-syntax, console-log
[作业 20261104091058-faa5c0] npm run migration:boundaries
[作业 20261104091058-faa5c0] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104091058-faa5c0.log

No test files found, exiting with code 1
filter: src/ui-kernel, src/ui-plugins/testing
include: host/**/*.test.ts, electron/**/*.test.ts, scripts/electron-migration/**/*.test.ts
[作业 20261104091058-2a9fd5] npx vitest run -c vitest.host.config.ts src/ui-kernel src/ui-plugins/testing --maxWorkers=1 --minWorkers=1
[作业 20261104091058-2a9fd5] 退出码 1；完整输出 /home/dsdev/.oc-jobs/done/20261104091058-2a9fd5.log
```

以上原始输出均无 Errors 汇总行；Host 配置无测试的退出码 1 **不算通过**。原因是 `vitest.host.config.ts:8` 明确不包含 `src/`，U1 没有 Host 自有目录。没有加 --passWithNoTests 假装完成，也没有改配置或跑无关 Host 测试。使用 U1 的正确前端配置实际执行合并后的受影响目录：

```text
 Test Files  10 passed (10)
      Tests  46 passed (46)
[作业 20261104091238-e159be] npx vitest run --config vitest.config.ts src/ui-kernel src/ui-plugins/testing --maxWorkers=1 --minWorkers=1
[作业 20261104091238-e159be] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104091238-e159be.log
```

Errors 行：原始输出无 Errors 汇总行；含 Node localStorage ExperimentalWarning。此次验证包含受 main 更新影响的真实 Host 社区示例桥接测试，以及全部 16 个 boot golden、来源纠错证据、origin 同 ID 覆盖/抛错隔离回归。§6.1 未决边界仍保持，未借 OOM 修复改变或宣称豁免。

## 中断恢复（第二次 OOM 通知之后）

- `git log` 显示 main 已有 `73f2e9462 merge ds-mig/U1-ui-boot`；`git merge-base --is-ancestor 437939817 main` 退出 0。第二次 OOM 通知所指的未合入状态已过时，U1 截至 `437939817` 的全部提交已在 main 中。
- 本次 `git merge --no-edit main` 为两次快进（至 `8f2a9823b`，再至 `eeaf5bdc7`），未产生合并提交。`git diff 437939817 HEAD -- src/main.tsx src/demo src/ui-kernel src/ui-sdk src/ui-plugins/official/install.ts src/ui-plugins/testing docs/plugins/FRONTEND-F1.md` 无输出：U1 源码、golden 与规格均未变化，因此没有重复已通过的 46 项测试、类型检查与双构建。
- U1 是前端 lane，没有 TESTMAP（`**/*U1*TESTMAP*` 无匹配）；等价性证据是 boot golden 与本报告。ledger 作业 `20261104105016-b71cf4` 退出码 0，最后一行：`ledger: commands 1058 (A 92.8% B 5.9% C 0%), tests 8036 (A 80.5% B 1.6%); problems: commands 0, tests 0, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）`。这是全仓后端账本，不是 U1 / F1 验收指标。

### 仍未闭合（状态未变）

- §6.1 首帧：规格 `docs/plugins/FRONTEND-F1.md:66` 仍要求“首次渲染前同步完成，或异步时首帧先用静态官方表”；main 中规格自 `0409f4c8f` 起未变，C1 上报 `081915453` 尚无新裁定。当前实现仍是“BootShell → await 官方装配完成 → 首个正常 App/Provider 树”，不宣称同步，也不改 Cordis。
- R6 报告仍以 `d0561ee2b` 为 U1 最新候选；origin（`c32d54b24` + `6bd437e73`）与 5 处 golden 来源证明（`1f1e5bc5b`、`be01c31aa`）待 R6 复核 R6-02/03/10。
- R6-09 默认导航契约（未声明 placement 归主导航、排在官方之后）属 U2 消费端过滤与排序；U1 已提供判定所需的 `SlotEntry.origin`，不在内核擅自改变 slot 的 order/id 排序。

## WP-251：quick-assistant 辅助窗发出主窗级调用（2026-11-06）

结论：**阻塞，发起点不在 U1 路径**。U1 未改动源码。

### 证据来源

X1 第 3 批 real-dist，job `20261106022639-2e8720`，原件 `/tmp/opencode/x1-real-dist-QaS5Qa/routes/window_quick-assistant.log.json`：48 条 calls 中有 6 条 outcome=error（`dstu_watch`、`import_builtin_templates`、`get_all_custom_templates`、`get_default_template_id`、`skill_list_directories`、`chat_v2_list_runtime_roots`），2 条 `report_frontend_log` 记录 CONSOLE_ERROR。dist 没有 sourcemap，console 的 `main-B1WlQofd.js:1890/2095/2123` 只指到日志包装器。实际代码分别在 `init-BeniXfK4.js`（Chat V2 init）和 `ankiTemplates-CN_Hqlo8.js`。

### 发起点（静态图：esbuild metafile，作业 `20261106033625-305b4d`、`20261106034238-435e96`）

- `QuickAssistantWindow.tsx` 静态闭包只有 67 个模块，不含任何发起点。
- `src/main.tsx:4` 静态导入 `./App`，所以每个窗口都会求值 App.tsx。`IS_LIGHTWEIGHT_WINDOW`（:369）只能分流渲染，静态导入的副作用照样执行。
- `src/App.tsx:181-189` 在模块求值期预热 `import('@/features/workbench/components/WorkbenchDesktop')`，条件是 localStorage 的 workbench 模式不为 `'false'` 且非移动端。辅助窗与主窗共享 localStorage，所以条件成立。
- WorkbenchDesktop 的静态闭包有 1251 个模块，其中 731 个不在 main 闭包里。这些模块在求值时：
  - `dstu_watch`：`src/features/workbench/apps/files/register.ts:34` → `resourceSync.ts:153` `dstu.watch('*')` → `src/dstu/api.ts:735`；失败后 console.error `[DSTU:API] watch() failed`。
  - 模板三连：`src/data/ankiTemplates.ts:340` `new TemplateManager()` → :32 → :46/:53/:54；失败后 console.error（:80）。
  - 技能两条：`src/features/chat/init.ts:90` `loadSkillsWhenReady()` → `src/features/chat/skills/loader.ts:341`（→ :81 `chat_v2_list_runtime_roots`）与 :172（`skill_list_directories`）。
- X1 trace 的 console 顺序与此一致：`[SubagentTest] Plugin loaded` → `[Chat V2] Initialized` → `[CardAgent] 初始化成功` → `import_builtin_templates`。

### 建议改法与归属

- owner：U2-ui-shell（`src/App.tsx` 见 `scripts/electron-migration/lib/lane-paths.mjs:27`）。
- 改法：在 `src/App.tsx:181` 的预热条件里加 `new URLSearchParams(window.location.search).get('window') === null`，判定与 `src/main.tsx:60` 一致。主窗口的条件与时机都不变；pomodoro-mini 也会一并修好。
- U1 未采用的方案：把 `src/main.tsx:4` 改为按窗口动态导入 App。这会改变主窗口的模块求值顺序：12 个主窗 boot golden 和 `legacy-boot-evidence.test.ts` 都锁定 `./App` 为第 3 个静态导入。它违反"不影响主窗口初始化 / 不为通过测试改 golden"，还会把 App 拆出主 chunk，有 `vite.config.ts:450-453` 记载过的 chunk 循环风险。需要 C1 / 架构师裁定后才能做。
- 已用 coord 消息报 C1-app（11:4x CST，晚于 11:15 截止）。
- 未做：回归测试和 X1 前后对比。修复点不在 U1，U1 侧写不出能先红后绿的测试；X1 数据要等 U2 合入后再跑。
- C1 裁定 D-173：接受本分析与改法。`src/App.tsx:181` 的预热条件加 `window` 参数判定，派给 U2 WP-258；不改 `src/main.tsx` 的静态导入，不改 golden，不放宽 capability。U1 本包到此结束，前后对比要等 C1 另派。
