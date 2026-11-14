# R6-review-frontend 独立复核（2026-11-04）

**结论：正常main联合门禁已独立闭环，整体F1仍待两项政策裁定。** R6-06已关闭；01/04/05/07/08/09/10既有签收保持。仅R6-02新增sidebar后补取证时序、R6-03主窗口异步首帧政策未决，不据绿色门禁豁免规格。

详细旧行为/新元数据对照、修复勾选表见 [src/ui-plugins/ACCEPTANCE.md](../../../../src/ui-plugins/ACCEPTANCE.md)。

## 审读快照及范围

- 独立工作树：`/home/dsdev/dev/ds-mig/R6-review-frontend`，分支 `ds-mig/R6-review-frontend`。
- 实现基线：`e303957124ac220f55bee1b04cca5d3937983b92`，提交时间 `2026-11-04T13:17:58+08:00`，主题 `merge ds-mig/F2-shell`。
- 初审四条分支全部指向此提交：

```text
ds-mig/U1-ui-boot e30395712 merge ds-mig/F2-shell
ds-mig/U2-ui-shell e30395712 merge ds-mig/F2-shell
ds-mig/U3-ui-settings e30395712 merge ds-mig/F2-shell
ds-mig/U4-ui-content e30395712 merge ds-mig/F2-shell
```

- 分别运行 `git diff --stat e30395712 ds-mig/<lane> -- src docs/plugins`，四次退出0、无输出；无需合并或切换分支即可审读同一实现。
- 开工 `git status --short` 无输出；检测到其他 lane 正在测试，按并发环境操作。
- 仅写两份指定报告。没有修改实现/测试，没有生成 `src/version.ts`（不在允许写入路径内）。
- 环境：Linux x64、Node `v26.5.0`、Vitest `v3.2.7`、Vite `v6.4.3`。

## 必须修复 / 补齐：派回 C1

| 编号 | 派回 | 当前证据 / 闭合要求 |
|---|---|---|
| R6-01 | 已解除 | 指令1授权只读主仓库规格，已完整阅读；未复制入本分支 |
| R6-02 | C1 / 架构师 | U1依§6.4补救已核；U2/U3原分区/U4取证已核；U3新增sidebar补证晚于d89改造，32组可复现但例外待裁定 |
| R6-03 | C1 / 架构师 | origin及真实领域安装已核；轻量窗保持旧实现按§6.1解除争议；主窗口/demo仍await内核后才首App树，异步首帧政策未闭合 |
| R6-04 | 已核实关闭 | 获授权原45+13+8+4项测试全部通过，真实Provider及实际表达式保持原断言目的 |
| R6-05 | 已核实关闭 | 1ef5caf97/6eca3b07d补齐两个消费者entries接口，origin图标边界/同ID覆盖/builtin保留通过；R6最小9项与tsc均退出0。sidebar时序仍归02 |
| R6-06 | 已核实关闭 | 正常main ad11a8394完整已审实现及新增loader/图标修复独立复验；前端类型与两构建0，原十入口/golden复用无diff独立证据；保留02/03政策 |
| R6-07 | 基线阻塞已解除 | 生成/tsc成功；97文件802项通过；主/demo构建在8GB堆均退出0，原4GB OOM保留；不代表候选F1通过 |
| R6-08 | 已核实关闭 | `3e28111d4`独立修订、`06d8e8c27`解释/去重录；固定旧源码复现与真实slot/当前App对照亲跑通过，golden后续未改 |
| R6-09 | 已核实关闭 | ea2c67c28默认placement/icon/排序与App新key接线通过实际两导航和App表达式测试 |
| R6-10 | 已核实关闭 | U1安装origin→fiber→slot与U2按origin隔离联测通过，同ID社区覆盖、卸载、重装均已核 |

由C1协调剩余事项；当前01/04/05/06/07/08/09/10已勾选，02/03保持上述精确边界，不将门禁闭合当政策豁免。

## 规格缺失的直接证据

```text
$ git show HEAD:docs/plugins/FRONTEND-F1.md
fatal: path 'docs/plugins/FRONTEND-F1.md' does not exist in 'HEAD'
[exit 128]

$ git log --all --oneline -- docs/plugins/FRONTEND-F1.md src/ui-plugins
[no output; exit 0]

$ git ls-tree -r --name-only ds-mig/C1-app docs/plugins src/ui-plugins
docs/plugins/ARCHITECTURE.md
docs/plugins/CAPABILITIES.md
docs/plugins/FRONTEND.md
docs/plugins/SDK.md
[exit 0]
```

现有 `FRONTEND.md` 是总方案，不能替代不存在的 F1 §1 第3条。以下是**亲跑的基线检查**，并非伪称规格全部命令；完整规格命令仍为 R6-01 阻塞。

## 亲跑命令及结果

所有命令均从指定工作树执行。完整日志留在 `/tmp/opencode/R6-{typecheck,baseline-tests,demo-build}.log`；核心原始输出如下。

### 1. 类型检查：退出2

```text
$ npm run typecheck

> deep-student@0.11.0 typecheck
> tsc --noEmit -p tsconfig.json

src/features/settings/components/AboutTab.tsx(14,26): error TS2307: Cannot find module '@/version' or its corresponding type declarations.
src/features/settings/components/SettingsAboutFooter.tsx(4,26): error TS2307: Cannot find module '@/version' or its corresponding type declarations.
src/hooks/useAppUpdater.ts(331,56): error TS2307: Cannot find module '../version' or its corresponding type declarations.
src/main.tsx(242,45): error TS2307: Cannot find module './version' or its corresponding type declarations.
```

### 2. 定向前端测试：退出1

```text
$ npx --no-install vitest run src/ui-kernel src/app/navigation/__tests__ src/features/settings/components/__tests__/useSettingsNavigation.workbench.test.tsx src/features/settings/components/__tests__/SettingsNavigation.integration.test.tsx --maxWorkers=2

 RUN  v3.2.7 /home/dsdev/dev/ds-mig/R6-review-frontend

 ✓ src/app/navigation/__tests__/androidBackCoordinator.fullScenes.test.ts (14 tests) 272ms
 ✓ src/app/navigation/__tests__/androidBackCoordinator.menuThenPanel.test.ts (6 tests) 73ms
 ✓ src/ui-kernel/__tests__/kernel.test.ts (8 tests) 220ms
 ✓ src/app/navigation/__tests__/cardsHub.test.ts (15 tests) 38ms
 ✓ src/ui-kernel/__tests__/loader.test.ts (6 tests) 41ms
 ✓ src/app/navigation/__tests__/androidBackCoordinator.order.source.test.ts (9 tests) 25ms
 ✓ src/app/navigation/__tests__/viewRouting.test.ts (5 tests) 19ms
 ✓ src/features/settings/components/__tests__/useSettingsNavigation.workbench.test.tsx (2 tests) 50ms
 ✓ src/ui-kernel/__tests__/community-example.test.tsx (3 tests) 1244ms

 FAIL  src/features/settings/components/__tests__/SettingsNavigation.integration.test.tsx [ src/features/settings/components/__tests__/SettingsNavigation.integration.test.tsx ]
Error: Failed to resolve import "@/version" from "src/features/settings/components/SettingsAboutFooter.tsx". Does the file exist?

 Test Files  1 failed | 9 passed (10)
      Tests  68 passed (68)
   Start at  13:38:51
   Duration  27.67s (transform 3.09s, setup 4.52s, collect 14.96s, tests 1.98s, environment 12.49s, prepare 2.34s)
```

68通过不包含无法收集的 settings integration。9个 source 断言不计作行为等价证据。F0 内核8、加载器6、社区示例3共17项通过，实际调用生产内核/SlotStore/Host invoke；社区示例的组件宿主是测试自己构造的，未验证 App 消费端。

### 3. 演示壳构建：退出1

```text
$ npm run build:demo -- --outDir /tmp/opencode/R6-demo-baseline

> deep-student@0.11.0 build:demo
> vite build --config vite.demo.config.ts --outDir /tmp/opencode/R6-demo-baseline

▲ [WARNING] Duplicate key "rollupOptions" in object literal [duplicate-object-key]
    vite.demo.config.ts:258:6:
  The original key "rollupOptions" is here:
    vite.demo.config.ts:232:6:

vite v6.4.3 building for production...
✓ 3278 modules transformed.
✗ Build failed in 18.22s
error during build:
Could not resolve "../version" from "src/hooks/useAppUpdater.ts"
file: /home/dsdev/dev/ds-mig/R6-review-frontend/src/hooks/useAppUpdater.ts
```

只将产物目录重定向到临时目录。`vite.demo.config.ts:35-38` 的 warmup 后处理硬编码 `dist-demo`，因此这个变体即使成功也不能证明原路径后处理通过；本次在转换阶段已经失败，未取得 chunk 对比。duplicate key 为现有配置警告，未把它冒充失败原因。

三项检查的共同前置缺口是 `src/version.ts`；`scripts/generate-version.mjs:269-290` 可以生成它，且可能同时写 Android 生成文件（303-316）。`package.json` 的 `prebuild` 会调用生成器，但 `build:demo` 没有对应前置脚本。初审将它称为“被忽略”不准确：虽然 `.gitignore:70` 有该条目，`:348` 的 `!src/**/*.ts` 又取消了忽略；续审 `git check-ignore -v --no-index src/version.ts` 已确认。生成文件不提交。不能据初轮前置失败归罪于尚未发生的 F1 改造。

## 已核实

1. 四 lane 基线完全相同；F0 代码已有独立历史，F1 尚无交付。没有 golden 时序或前后对照的可用证据。
2. ACCEPTANCE 已列出全部17个 CurrentView、17个设置 tab，以及原导航键/图标/顺序、主要壳条件、启动分支、Markdown 与三种菜单的行为基线。所有“新表达”明确标未交付。
3. 原页面与设置入口保留源码级 React.lazy/dynamic import；没有新注册模块可检查，也没有构建产物可断言 chunk 边界等价。
4. F0 能实际隔离所测 import/导出/id 错误并回滚安装失败；这不足以证明社区 renderer、菜单 action 或实际 App 的错误隔离。
5. 三项基线检查真实执行并保留失败；没有授予任何 lane F1 通过。

## 建议

- 先发布规格和各 lane 的取证基线，再提交改造；测试从固定旧行为取 expected，actual 走官方注册和实际消费者。
- 下轮按固定编号接收“修复提交 → 生产入口 → 测试结果”，只复跑对应失败/新增证据；本轮源码清单不能替代 lane 自己的改造前 golden。

## 后续复核记录

首轮无已交付修复提交；续审状态如下，不以其他分支的口头完成声明关闭编号。

## 指令1续审：规格已取得，按固定候选继续

只读架构师指定的 `/home/dsdev/dev/deep-student/docs/plugins/FRONTEND-F1.md`，全文59行（§0–§5）。确认：§1.1 要求先提交自动提取的 JSON；§1.2 要求改造后同一测试读 UiKernel slot；§1.3 四组门禁；§1.4 golden 修订需证据及独立提交。U4 实际入口是 `LearningHubContextMenu.tsx`，已纠正初审错将 DSTU 菜单当作迁移入口的范围描述。没有复制规格；本次 main 中尚无该文件，未合并 main。

| 编号 / lane | 固定审读提交 | 证据与结论 |
|---|---|---|
| R6-01 | 架构师提供的未提交规格 | 获取阻塞解除；规定命令已确定，运行结果单列 |
| R6-02 / U1 | `8597b23f2599edbc48e6ac37cd0c07cf2a4fe283` | 相对初始快照仅增加109行审读文档，没有 JSON/提取测试；boot 仍未接线 |
| R6-02 / U2 | `6beac2e744fe1ed9e941df9faedb079d28729afc` | 取证提交只含报告、1709行 JSON、109行旧代码提取器、14行测试，没有生产改造 |
| R6-04 / U2 | `9d5f9d1cbe019b2fa3b15d87a51cc503f1b4a5a6` | 直接父提交为上述取证提交；golden diff为空；增加 shell contract/index/RegisteredViewLayer，17视图/9导航静态值与旧基线相符，但四个生产消费文件 diff为空 |
| R6-05 / U3 | `e303957124ac220f55bee1b04cca5d3937983b92` | 无独立提交 |
| R6-02、06 / U4 | `25f9c1714a2a23c3d5e57ae874403fcee95b61d4` | 只有160行文字取证；独立核对原981行 LearningHubContextMenu，条目/条件/时序相符；尚非 §1 JSON 取证 |

U2 的取证先后用 `git merge-base --is-ancestor 6beac2e74 9d5f9d1c`（退出0）及候选的直接父提交共同确认。候选 golden 测试仍读 `extractLegacyEvidence()`，没有 UiKernel/官方插件导入，不能认定是改造后比较。上述候选仅静态读取；下方运行测试的实现基线仍为本工作树的 `e30395712`，没有把候选测试声称为亲跑。

### R6-08：golden 的真实覆盖缺口

- `legacyEvidence.ts:60` 用 `Object.keys(LAUNCHER_SHORT_LABEL)` 提取移动顺序；真实组件 `MobileSidebarNavigation.tsx:114-120` 使用另一份 `MOBILE_APP_LAUNCHER_VIEWS`。当前两者碰巧同序，不代表测试提取了真实消费顺序。
- `legacyEvidence.ts:102-106` 的32组环境输出部分为手写布尔规则，未运行旧组件/旧导航条件；`navigable` 在 dev=false 时仍列 dashboard 和三个 DEV 页面，未记录 canonicalize 的实际 data-management/chat-v2 落点。
- `header.chatHeader` 用同一个 hasSession 同时设置 sessionId/title，只比较两者同时空/同时非空；未覆盖一有一无，因此不能证明原 `sessionId && title` 保留。
- 派回 C1→U2：补原实现的实际输入→输出取证；若变更 golden，按 §1.4 单独提交来源与理由。其他已从 AST/真实 createNavItems 提取的项目有效，不一概判为自证。

### 恢复记录与 §1.3 执行状态

服务重启取消了正在执行的 typecheck、Vitest、主构建。版本生成已成功，不重复；Vitest 日志已有42文件527项通过，仅补跑其余54文件；typecheck、主构建无最终结果，重启后补跑。后续协调者“继续”指令不触发重复运行中的检查。

1. 已执行规定链 `npm run version:generate && npx tsc --noEmit -p tsconfig.json`。生成器成功并进入 tsc，重启取消链，不能伪造整链退出0。原生成输出：

```text
> deep-student@0.11.0 version:generate
> node scripts/generate-version.mjs

Version info generated:
   App version: 0.11.0
   Build number: 19140
   Android versionCode: 214586
   Git hash: d0d023ca
   Full version: 0.11.0 (19140)
   Sentry release: 0.11.0+19140.d0d023ca2f2644f73d746a36cf710119e13e5e06
   File: /home/dsdev/dev/ds-mig/R6-review-frontend/src/version.ts
```

2. 规定的目录回归实跑命令（实现基线未合入 U2 WIP）：

```sh
npx vitest run --config vitest.config.ts src/ui-kernel src/ui-plugins src/app src/demo src/components/layout src/components/__tests__/ModernSidebar src/features/settings/components src/features/chat/components/renderers src/features/learning-hub/components tests/vitest/ui-shell --maxWorkers=2
```

该进程因重启 cancelled，日志 `/tmp/opencode/R6-spec-tests.log` 已有42文件527项通过，无失败记录。补跑命令使用同 config、`--maxWorkers=2`，将上述范围的全部 `*.test/spec.ts/tsx` 去掉已完成42文件，实际54文件参数完整保存在 `/tmp/opencode/R6-spec-tests-resumed.log` 首行。原始补跑结果：

```text
 Test Files  54 passed (54)
      Tests  230 passed (230)
   Start at  13:50:44
   Duration  157.61s (transform 29.68s, setup 21.25s, collect 159.86s, tests 25.09s, environment 58.65s, prepare 10.07s)

RAW_EXIT_CODE=0
```

两段无文件重叠，累计 **96文件、757项通过**，两段均未出现 `Errors` 汇总行；不把 cancelled 的首段称为进程退出0。初轮失败的 SettingsNavigation.integration 14项在第一段已通过，缺 version 原因已解决。这仍为旧实现基线回归，不是 F1 新旧对照通过。

3. `npx vite build`：首个进程重启取消，续跑退出134，20,721模块转换完成后 Node 堆不足。环境注入 `NODE_OPTIONS=--max-old-space-size=4096`；机器当时 available 37,523MiB。追加 `NODE_OPTIONS=--max-old-space-size=8192 npx vite build` **退出0**，确认该轮失败为环境堆限制；源码/配置未修改。原错误：

```text
✓ 20721 modules transformed.
FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory
Aborted
```

8GB 主构建原始输出摘要（`/tmp/opencode/R6-spec-build-8g.log`）：

```text
✓ 20721 modules transformed.
dist/assets/LearningHubPage-C68MR6YN.js                  23.18 kB
dist/assets/AnkiTasksApp-DhPZ5YpT.js                     43.02 kB
dist/assets/MediaStudioApp-CqaxdhYG.js                   71.39 kB
dist/assets/WorkbenchDesktop-sSZgUQpP.js                100.25 kB
dist/assets/Settings-R4KjTLX2.js                        366.30 kB
dist/assets/main-DFKhI11S.js                          3,875.26 kB
[vite-plugin-static-copy] Copied 77 items.
✓ built in 7m 45s
```

无 Errors 汇总行。原有 mixed static/dynamic import、Browserslist、>500kB chunk 警告仍在；未归因为 F1。
4. `npm run build:demo`：按规格原命令执行（没有 outDir 覆盖），退出134；20,568模块转换后同样触及4GB堆上限。保留 duplicate rollupOptions 警告，真实失败原因为下列 OOM；`NODE_OPTIONS=--max-old-space-size=8192 npm run build:demo` **退出0**，原路径后处理也成功。

```text
✓ 20568 modules transformed.
FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory
Aborted
```

8GB demo构建原始摘要（`/tmp/opencode/R6-spec-demo-8g.log`）：

```text
✓ 20568 modules transformed.
dist-demo/demo-app.html                                          1.00 kB
dist-demo/demo.html                                              1.49 kB
dist-demo/hero.html                                             45.71 kB
dist-demo/assets/Settings-PntKBx79.js                          596.85 kB
[vite-plugin-static-copy] Copied 77 items.
✓ built in 5m 45s
[demo-build] warmup preloads injected into hero.html: 10
```

无 Errors 汇总行；保留 duplicate rollupOptions、Browserslist、chunk大小等警告。该结果解决初轮 demo构建环境阻塞，不代表新插件消费者/浏览器交互已经通过。
5. `npx tsc --noEmit -p tsconfig.json`：使用已生成版本文件续跑，**退出0，无输出，无 Errors 行**；日志 `/tmp/opencode/R6-spec-typecheck-resumed.log` 为空。版本生成成功 + tsc 成功已分别取得，整链历史 cancelled 不改写。

按恢复指令已执行 `git log --oneline -20`、`git status`，HEAD仍为本审读提交 `d0d023ca2`；R6 没有 TESTMAP（它是复核 lane，任务只允许两份报告），继续使用 ACCEPTANCE 的固定编号跟踪。另亲跑全仓后端账本，退出0：

```text
$ npm run migration:ledger -- --check --no-write
> deep-student@0.11.0 migration:ledger
> node scripts/electron-migration/ledger.mjs --check --no-write

ledger: commands 1058 (A 91.5% B 7.2% C 0%), tests 8036 (A 76.6% B 0.7%); problems: commands 0, tests 0, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）
```

该百分比是全仓后端数据，不是 R6/U1–U4 的 A 级比例，不作为前端 F1 验收替代。

### U2 `7d629a40` 新增导航消费的静态复核

运行检查期间发现 U2 更新到 `7d629a40a6f6fb526bb2f6f207297a9df32a2013`，其余 U lane refs 不变。相对 `9d5f9d1c` 增加两个导航消费者和测试。完整审读记录已追加 ACCEPTANCE，主要结论：

- 新 golden 测试确实从 UiKernel slot 获取 actual，再比固定 JSON；不再是旧源码自比。官方导航的文案/图标/过滤后顺序静态一致。
- App 视图层尚未接线；视图集成测试使用手写 `Views`，不能算真实 App 消费证明。
- R6-08 保留。另用只读 Node/TypeScript 转译执行旧 `canonicalView.ts`（DEV=false），与候选 JSON 对照得到：

```text
{"dev":false,"input":"dashboard","goldenNavigable":true,"actualDestination":"data-management"}
{"dev":false,"input":"crepe-demo","goldenNavigable":true,"actualDestination":"chat-v2"}
{"dev":false,"input":"chat-v2-test","goldenNavigable":true,"actualDestination":"chat-v2"}
{"dev":false,"input":"llm-playground","goldenNavigable":true,"actualDestination":"chat-v2"}
```

- 新增 R6-09：合法 F0 nav 注册没有 desktop/mobile placement，两个消费者都过滤掉；仓库现有 community.word-of-day 是直接实例。
- 新增 R6-10：即使 placement 完整，贡献 icon 直接渲染、无社区局部边界；view 测试通过不覆盖此路径。
- 原移动导航测试文件仍裸 render；新增 wrapper suite 不会改变 Vitest 独立运行原文件的根 Provider。需完成受影响目录的测试接线，不能只报告 wrapper 的结果（归 R6-04/07）。

候选全部只读，未亲跑候选测试；上述通过结果与类型检查退出0仅适用于本工作树的旧实现基线。

发现 U2 regression wrapper 引入了目录列表以外的原桌面导航测试，故额外补跑该实际受影响 suite（没有重复前述96文件），退出0，无 Errors 行：

```text
$ npx vitest run --config vitest.config.ts tests/vitest/modernSidebarNavigation.test.tsx --maxWorkers=1
 ✓ tests/vitest/modernSidebarNavigation.test.tsx (45 tests) 18255ms
 Test Files  1 passed (1)
      Tests  45 passed (45)
   Start at  14:01:47
   Duration  52.49s (transform 38.99s, setup 898ms, collect 22.11s, tests 18.25s, environment 4.72s, prepare 395ms)
```

本次规格目录基线累计 **97文件、802项通过**（42/527 + 54/230 + 1/45）；不包括初轮已单列的68项，不把重启取消的进程算退出0。详细日志 `/tmp/opencode/R6-desktop-navigation-baseline.log`。

### 主构建懒加载基线取证

在本工作树产物上用 TypeScript parser 只读遍历入口的静态 ImportDeclaration/ExportDeclaration 依赖，不执行 bundle；入口 `main-DFKhI11S.js` 的静态 JS 闭包为7文件、5,321,418字节。五个关键页面均存在独立 chunk，且不在该闭包中：

| 页面 | chunk | 字节 | 入口静态可达 |
|---|---|---:|---|
| Settings | Settings-R4KjTLX2.js | 366301 | false |
| LearningHubPage | LearningHubPage-C68MR6YN.js | 23178 | false |
| WorkbenchDesktop | WorkbenchDesktop-sSZgUQpP.js | 100248 | false |
| AnkiTasksApp | AnkiTasksApp-DhPZ5YpT.js | 43022 | false |
| MediaStudioApp | MediaStudioApp-CqaxdhYG.js | 71388 | false |

`dist/index.html:36-42` 的入口/preload 为 main、vite-runtime、react、i18n、katex、markdown-shared、micro。这里是**旧实现实际产物**的静态边界；不推断动态预热时机、浏览器首屏，也没有新候选产物可作前后等价结论。

### 本轮最终状态

- 规格 §1.3 四组命令均已执行并贴结果：生成/类型检查分段完成；目录测试因重启按未完成文件续跑；两构建原环境失败、8GB重试成功。没有重跑已完成测试以凑整次绿色输出。
- 只关闭 R6-01 和 R6-07；8个编号仍待C1派回。U1/U3/U4交付未齐，U2最新审读基线为 `7d629a40`，部分消费者和测试已经落地，但上述问题尚存。
- 所有运行结果对应旧实现 `e30395712`（本分支新增内容只有报告）。不得把802测试通过或两个构建通过描述为候选F1完成。
- 已清理本轮专为规定命令生成的未跟踪 `src/version.ts`，不提交生成文件；构建产物留在本工作树的忽略目录供后续chunk对比。前后代码无实现改动，交付仅两份允许报告。

## 协调者指令1–5：正式规格、App增量与候选队列验收

### 本轮审读和运行快照

执行 `git merge --no-edit main` 成功：main为 `fa99dd56125ca059cc345ab25e1e0e39065a8f43`，本树合并提交 `040ee04641350c3de2f47723d4faa23ab57352c9`。正式规格来自 `40e885f899e006c088965d25985c6bafe0a8128a`，完整读过工作树文件；确认 U1 golden 特例为 `src/ui-plugins/testing/__golden__/boot/`，未自行改规格。

U2固定候选：`518071df8a68eca8a7d27f47aee19695e0141886`，含 `86302a65a` App接线及后续运行报告。其余refs仍为 U1 `8597b23f`、U3 `e30395712`、U4 `25f9c171`。不将已过时的“App未接线”用于当前候选。

为独立执行新候选门禁，在本工作树同一分支临时执行：

```sh
git merge --no-commit --no-ff 518071df8a68eca8a7d27f47aee19695e0141886
```

合并成功，未手改任何实现/测试/golden/expected，未提交候选合并。全部作业及产物分析结束后 `git merge --abort` 退出0，HEAD回到 `040ee0464`，App/两导航相对该提交diff为空。下述结果对应 **main快照 + U2候选的临时合并树**；与上轮纯旧基线清楚分开。

### 必须修复 / 已核实的增量

1. **已核实 R6-04 部分修复**：App:442起订阅views、取activeView/activeShell；1410-1427以真实slot组装17个RegisteredViewLayer，1760在经典壳分支实际渲染；导航两个真实消费者亦已接线。逐字段对照见 ACCEPTANCE 文末，不再称为测试宿主专用模块。
2. **已核实真实slot比较**：取证提交 `6beac2e74` 是候选祖先（检查退出0）；其后 golden diff为空。候选golden测试安装生产shellPlugin并读取UiKernel，再与固定JSON相等；本次亲跑通过。
3. **已核实官方条件**：直接从旧App/useShellViewChrome和候选App/生产views初始化式提取表达式，17视图×折叠2×历史2×聊天标题空/非空2=136输入，比较侧栏/返回/toggle/headerNav/mobileBack/标题等952输出，0差异。对应候选当前App而不是手写消费者；不过这是纯表达式证据，不是完整DOM交互或08所要求的全覆盖golden。
4. **必须完成候选测试装配（归R6-04，C1协调）**：原桌面入口39项、原移动入口13项因 `useUiKernel: missing <UiKernelProvider>` 失败；新增wrapper通过不能使原入口通过。另2项源码断言仍寻找旧判定字符串，而真实新表达式对照相等；它们是旧测试形式与元数据重构不匹配，不是已证实UI行为回归。应保持原行为断言目的，不删除/跳过/弱化断言来过门禁。
5. **R6-08～10保留**：取证覆盖未补；无placement的社区nav/新viewId契约待架构师裁定；社区icon无局部边界。候选在这些点与前次无修复差异，未重新运行旧97文件基线，也未替架构师改规则。
6. **U1完整启动集成仍缺**：main/demo三个入口没有UiKernelProvider/官方安装器。当前构建通过不证明生产启动可用；不将U1待交付误作U2擅自缺fallback的缺陷。当前官方slot测试有真实Provider装配，真实App启动的联调待U1。

### §1.3 规定命令：队列作业及原始退出码

所有重CPU工作使用 `node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs submit -- ...`，提交时cwd均为本工作树。没有重复运行旧基线。结果均通过 `job.mjs result <id>` 获取；不是仅摘 Tests passed 行。

前置 `npm run version:generate` 退出0：App 0.11.0、Build 19254、Git hash 040ee046；生成文件不提交、不手改。随后提交 tsc，按新队列规则把规格的生成+检查链分开执行；执行器自动增加增量参数。

| 作业号 | submit后的原命令 | result退出码 | Errors/结论 |
|---|---|---:|---|
| `20261104062423-e79ef5` | `npx tsc --noEmit -p tsconfig.json` | 0 | 无输出，无Errors行；执行器追加incremental/cache参数 |
| `20261104062423-d04387` | `npx vitest run --config vitest.config.ts src/ui-plugins/official/shell src/components/layout/__tests__/MobileSidebarNavigation.dedup.test.tsx tests/vitest/modernSidebarNavigation.test.tsx src/app/shell --maxWorkers=2` | 1 | 54失败/109通过；没有单独Errors汇总行，但存在52个Provider错误及2个AssertionError |
| `20261104062430-dd9ec5` | `env NODE_OPTIONS=--max-old-space-size=8192 npx vite build` | 0 | 无Errors行；既有mixed-import/大chunk等警告保留 |
| `20261104062430-208502` | `env NODE_OPTIONS=--max-old-space-size=8192 npm run build:demo` | 0 | 无Errors行；原duplicate rollupOptions警告保留；warmup成功 |

result原始摘要（完整日志均在 `/home/dsdev/.oc-jobs/done/<作业号>.log`）：

```text
[作业 20261104062423-e79ef5] npx tsc --noEmit -p tsconfig.json --incremental --tsBuildInfoFile .lane.tsbuildinfo
[作业 20261104062423-e79ef5] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104062423-e79ef5.log

 Test Files  4 failed | 9 passed (13)
      Tests  54 failed | 109 passed (163)
   Start at  14:24:25
   Duration  31.22s (transform 17.62s, setup 3.99s, collect 34.62s, tests 13.57s, environment 9.39s, prepare 1.77s)
[作业 20261104062423-d04387] 退出码 1；完整输出 /home/dsdev/.oc-jobs/done/20261104062423-d04387.log

[vite-plugin-static-copy] Copied 77 items.
✓ built in 4m 41s
[作业 20261104062430-dd9ec5] env NODE_OPTIONS=--max-old-space-size=8192 npx vite build
[作业 20261104062430-dd9ec5] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104062430-dd9ec5.log

[vite-plugin-static-copy] Copied 77 items.
✓ built in 4m 36s
[demo-build] warmup preloads injected into hero.html: 10
[作业 20261104062430-208502] env NODE_OPTIONS=--max-old-space-size=8192 npm run build:demo
[作业 20261104062430-208502] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104062430-208502.log
```

官方shell四文件63项全部通过：golden1、mobile wrapper13、desktop wrapper45、integration4；它们都在该退出1作业中，不能将总作业改称通过。原直接入口58项中52失败/6通过；src/app/shell的42项中2失败/40通过。没有修改expected后重跑。

### App独立条件对照作业

额外只读内联Node/TypeScript程序亦提交队列（无新增测试文件）：从 `git show e30395712:src/App.tsx` / 旧useShellViewChrome提取原initializer，从临时树的App和shell/index提取新initializer；执行真实公式，翻译函数仅返回键、useMemo仅执行回调。完整程序保存在队列作业命令记录中。`job.mjs result 20261104062909-12370b` 结果：

```text
{
  "old": "e30395712",
  "candidate": "518071df8",
  "views": 17,
  "inputRows": 136,
  "expressionComparisons": 952,
  "mismatches": []
}
[作业 20261104062909-12370b] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104062909-12370b.log
```

无Errors行。此项支持当前App壳字段等价，不能替代社区行为、浏览器视觉或完整golden矩阵。

### 候选懒加载产物与旧基线比较

只读AST静态import/export依赖闭包分析同样走队列；`job.mjs result 20261104063204-639e2b` 退出0、无Errors行。候选入口 `main-Btq0AKL0.js`；静态闭包仍7文件、5,311,011字节（旧5,321,418）。候选注册源码没有页面静态import，保留原lazyComponents/useViewLayerContents/Workbench import。

| 页面 | 候选chunk | 旧/新字节 | 旧/新入口静态可达 |
|---|---|---:|---|
| Settings | Settings-DtrSgPw9.js | 366301 / 366301 | false / false |
| LearningHubPage | LearningHubPage-C1n69cxN.js | 23178 / 23178 | false / false |
| WorkbenchDesktop | WorkbenchDesktop-CbN1QLxs.js | 100248 / 100248 | false / false |
| AnkiTasksApp | AnkiTasksApp-DzVUjkRo.js | 43022 / 43022 | false / false |
| MediaStudioApp | MediaStudioApp-BaY9Ochu.js | 71388 / 71388 | false / false |

```text
[作业 20261104063204-639e2b] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104063204-639e2b.log
```

这是实际U2候选产物，不再仅有旧基线。但未含U1安装器，故不能提前宣布完整F1首屏/演示运行态等价；不同chunk文件名也不等同于内容或加载顺序回归。

### 本轮交付与待复核

没有授予F1通过，也没有新造“App未改”问题。R6-04中App/导航实际消费子项核实，候选原测试门禁待C1协调；08–10继续按既有编号派回。U1路径依正式规格特例，U4仅指定两入口，不要求修改DSTU/CodeBlock。原4GB OOM及旧缺version记录仍保留历史。

本次主仓库访问只读规格/队列脚本，所有命令cwd均在本工作树；仅main合并提交被保留，候选合并已撤销。只提交两份报告；队列生成的 `.lane.tsbuildinfo` 和规定生成的 `src/version.ts` 均不提交、不手改。

## 06:58Z 指令：只复核08/10，候选 `75c6343f0`

固定完整候选 `75c6343f049f69bf13b46a500909c91aca12b18b`。从本树`c08c83d80`临时未提交合并候选，最小检查结束后已`git merge --abort`恢复。只增量审读修订来源、actual和图标隔离；未重复旧97文件、未重跑未修复的52项Provider失败，也未重跑类型/两构建。不编辑任何golden、expected或实现。

### 已核实：R6-08闭合

- `3e28111d4`仅4个取证工具/JSON/test文件，无生产改动；`06d8e8c27`仅补充旧错误说明、移除重录开关并把取证测试超时调为20s，未弱化断言。它们是规格§1.4认可的独立修订，不伪称修订早于原始改造；首次改造前取证仍为`6beac2e74`。
- 祖先检查`3e28111d4 → 75c6343f0`退出0，`git diff --name-status 3e28111d4 75c6343f0 -- src/ui-plugins/official/shell/__golden__`无输出。后续`5d81fad1e`把仍从当前模块取的createNavItems/cards helper也改成固定旧源码执行，golden未变。
- `LEGACY_REVISION`固定`e303957124ac220f55bee1b04cca5d3937983b92`；使用真实MOBILE_APP_LAUNCHER_VIEWS顺序，独立session/title四组合，32组环境实际执行旧App JSX条件，160行导航实际执行旧setCurrentView/canonicalize并记录target/committed/事件。
- 改造后actual安装真实shellPlugin并读UiKernel slot，执行当前App表达式/回调；expected仍是固定JSON，未从新元数据生成。golden提供输入案例属于有效固定输入，不是提供actual输出。相关图标源码相对旧基线亦无变更。
- 本次亲跑固定旧源码→修订golden、新真实slot/消费者→同一golden两测试通过，故只勾选08，不扩大为U2全部完成。

### 部分核实、必须补齐：R6-10同ID社区覆盖

实现追到`f122ff3bd/5d81fad1e/b6c0fdc7b/9a0e135f9`，未只看`1a2183bbd`标题。两个导航保留真实entry.owner，以owner/id做React key；五个图标位置经renderNavigationIcon，普通社区图标抛错后标签/点击/邻项仍可用，卸载同viewId贡献无残留；官方owner字符串路径没有新增边界。

**R6-10不能整项关闭：** `renderNavigationIcon.tsx:14-16`仅按`owner==='dstu.ui.shell'`绕过边界。规格§2:31明确允许社区同ID覆盖；UiKernel:217-224会卸载旧实现，再把新fiber的owner同样设为该id，UiPluginLoader:65也走这个install。因此社区用官方ID覆盖时，新的社区图标仍无局部边界，违背§4:54的社区贡献错误隔离要求。

已有`navigationIsolation.test.tsx:89-95`正好执行该机制：先在beforeEach安装官方shell，再安装一个新`dstu.ui.shell`实现，贡献BrokenIcon，断言外层fallback出现且navigation消失。本次测试通过确认这条行为。它的“official”标题仅代表测试选用了官方ID，不能证明新实现具有内置官方来源；不能用该绿测试排除合法社区同ID覆盖。

派回C1协调U1/U2的实际来源识别，在保持真实官方原路径的同时隔离同ID社区覆盖；保持R6-10未勾选。此项是已明确支持的扩展路径，不涉及F2信任/权限设计。R6-09默认契约、新viewId及原Provider装配继续保持原阻塞，未借本轮修改规格。

### 本次最小作业与原始结果

```text
[作业 20261104070627-16f964] npx vitest run --config vitest.config.ts src/ui-plugins/official/shell/__tests__/legacy.evidence.test.ts src/ui-plugins/official/shell/__tests__/shell.golden.test.ts src/ui-plugins/official/shell/__tests__/navigationIsolation.test.tsx --maxWorkers=2
 ✓ src/ui-plugins/official/shell/__tests__/shell.golden.test.ts (1 test) 2580ms
 ✓ src/ui-plugins/official/shell/__tests__/legacy.evidence.test.ts (1 test) 4312ms
 ✓ src/ui-plugins/official/shell/__tests__/navigationIsolation.test.tsx (5 tests) 1149ms
 Test Files  3 passed (3)
      Tests  7 passed (7)
   Start at  15:06:30
   Duration  20.66s (transform 25.11s, setup 2.19s, collect 29.73s, tests 8.04s, environment 1.18s, prepare 803ms)
[作业 20261104070627-16f964] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104070627-16f964.log
```

通过`job.mjs result`取得原退出码，未出现Errors汇总行；仅本作业7项是本次亲跑。C1提供的69项通过和52项失败没有冒算为本次结果。闭合01/07/08，剩余7个编号继续按项复核，整体仍不通过F1。

## 07:19Z 指令：U1主要接线与混合golden纠错复核

固定候选 `d0561ee2b63de838fd33b20f3b7b45a4117cc390`；从`b39857dd5`临时未提交合并，候选还携带其main祖先更新，全部仅用于审读/检查。中途服务重启后核对HEAD未变、MERGE_HEAD仍为此候选，已完成作业直接取结果而非重跑；结束已`git merge --abort`恢复。只写两份报告，没有提交U1合并或改实现/golden/expected。

### R6-02：首次先取证已核；纠错的内容与提交隔离分别判断

1. `7f915ae5f1799ee9de9c7f40a7386d785eba7475`是报告/测试/16个JSON的纯取证提交，三个生产入口与`e30395712`无diff；它是`397b64161`改造祖先（亲查退出0）。U1路径为规格明确的`testing/__golden__/boot/`，没有按official/boot误报。
2. `e354acaa66c1b04c64a944765c99844ca5115d49`不是纯纠错：除5个JSON/harness/test，还修改demo-app生产入口、community生产模块及测试。`5605d964c`只补17行文档，不能事后改变提交内容。其报告标题“独立提交”不能作为合规结论；后文承认混合也不自动豁免§1.4。**提交隔离偏差留待架构师裁定，不勾R6-02。**
3. 纠错原因可验证：原通用模块Proxy把then也返回为函数，Promise吸收假thenable后流程停滞。修正then=undefined，才出现原本应有的render及后续demo动作。e354acaa6之后到候选的golden diff为空。
4. 本次独立回放固定旧源：用首取证提交的16组输入和纠正后的历史harness，强制original=true读取`git show e30395712:<三个入口>`。对新内核/安装器设“若调用即失败”端口，实际调用0；不让新实现参与旧expected。全部16场景等于当前golden，恰好pomodoro、assistant、demo、demo-desktop-dark、demo-app五组不同于首版，其余11组相等。

修订内容逐项核对：pomodoro补实际render；assistant补render且仍先于get_setting invoke；demo补createRoot/render/autoplay/导航；desktop-dark再补desktop.prepare/arrange、instantFirstPlay；demo-app补原provider/frame/Suspense渲染树。没有证据表明这些JSON为迎合新实现而倒填；**内容有旧依据不等于混合提交完全合规**。

### R6-03：真实boot装配与证据边界

- 正常/纯Web启动在原preflight/maintenance分流后await getUiKernel，bootstrap真实构造UiKernel并安装官方模块，UiKernelProvider包原业务树；invoke adapter已发布。恢复/debug路径保持不装配内核，避免让恢复壳等待插件。
- 两种demo保持mocks先于业务import，渲染前装配/包Provider，注册卸载清理，使用`window.__DS_DEMO_SHELL__`避免社区启动。实际harness检查Provider/内核实例，真实React render helper检查重渲染共用内核和卸载。
- 两个轻量窗保持旧分支，仍没有Provider。其即时动态导入输入下原render/Sentry相对顺序有可复现约束，不能为方便装配自行接受await后的顺序变化；按C1已上报的规格方案继续待裁定。当前16场景测试明确对它们期望kernel/provider数0，不应称已完成轻量窗装配。
- 默认官方安装器确实`import.meta.glob('./*/index.ts', {eager:true})`，order/id排序；但本次候选树中glob搜索无领域index.ts。两个空kernel的slot相等不足以证明U2–U4集成。显式真实插件排序/lazy factory未求值测试是有效单元证据，不能替代领域合并后的测试。
- 社区真实生产API先listen事件再取manifest；revision阻止旧初始响应覆盖新事件。demo连transport都跳过；空清单不导入SDK/map/社区代码，但确实有发现请求和订阅，不称绝对零操作。
- 首个社区import前await共享映射安装；stop禁止后续sync、unlisten、loader.dispose，等待中的import在dispose后不会复活插件。community测试验证调用顺序/真实slot，shared端口被mock；loader测试另验证F0 map/shim与延迟导入清理。未把import/apply隔离说成领域组件render隔离，也未关闭U2同ID来源问题。
- harness执行真实入口和真实bootstrap（registry/IPC是惰性端口），只比较原业务import/可见树/副作用顺序，基础设施import不进入旧trace；它不验证像素、实际首屏耗时、浏览器import-map协议或有领域插件时的完整装配。

详细入口对照、混合提交清单及5个JSON逐项结论同步到ACCEPTANCE。R6-03只确认normal/demo/通道子项，轻量窗及领域集成保留未勾选。

### 最小亲跑结果与重启恢复

作业`20261104073812-16c0d3`，原命令：

```sh
npx vitest run --config vitest.config.ts src/ui-plugins/testing/boot-golden.test.ts src/ui-plugins/testing/install.test.ts src/ui-plugins/testing/render.test.tsx src/ui-kernel/__tests__/community.test.ts src/ui-kernel/__tests__/loader.test.ts --maxWorkers=2
```

```text
 ✓ src/ui-plugins/testing/install.test.ts (1 test) 50ms
 ✓ src/ui-kernel/__tests__/loader.test.ts (7 tests) 50ms
 ✓ src/ui-plugins/testing/render.test.tsx (1 test) 88ms
 ✓ src/ui-kernel/__tests__/community.test.ts (4 tests) 264ms
 ✓ src/ui-plugins/testing/boot-golden.test.ts (16 tests) 2374ms
 Test Files  5 passed (5)
      Tests  29 passed (29)
   Start at  15:38:14
   Duration  8.17s (transform 786ms, setup 2.33s, collect 2.64s, tests 2.83s, environment 3.26s, prepare 1.10s)
[作业 20261104073812-16c0d3] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104073812-16c0d3.log
```

`job.mjs result`退出0，无Errors汇总行。未重复kernel8/Host示例3（C1已取40项的其余部分），未重跑旧97文件及两套构建。U1文档的40绿及两构建绿只作lane证据，不冒称本次R6亲跑。

额外固定旧源回放亦使用队列内联Node/VM程序，无落盘测试修改。首作业`20261104074010-f13045`退出1：审读者外层VM缺URLSearchParams，未进入应用断言；只补该标准全局后提交`20261104074217-10fed2`，退出0。重启后读取既有结果，没有重复执行：

```text
ReferenceError: URLSearchParams is not defined
[作业 20261104074010-f13045] 退出码 1；完整输出 /home/dsdev/.oc-jobs/done/20261104074010-f13045.log

[作业 20261104074217-10fed2] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104074217-10fed2.log
```

成功输出含entryRevision=e30395712、harnessRevision=e354acaa6、caseRevision=7f915ae5f，16行matchesCorrected=true，只有上述5行matchesFirst=false，kernelTouched=0；无Errors行。失败属于本次回放驱动环境注入，不归罪于U1，不改golden来规避。

按再次恢复指令已执行`git log --oneline -20`、`git status`；R6无TESTMAP，仍由ACCEPTANCE固定编号跟踪。撤销临时合并后另提交只读ledger作业，result退出0：

```text
ledger: commands 1058 (A 91.5% B 7.2% C 0%), tests 8036 (A 77% B 0.8%); problems: commands 0, tests 0, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）
[作业 20261104074701-9c715c] npm run migration:ledger -- --check --no-write
[作业 20261104074701-9c715c] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104074701-9c715c.log
```

此为恢复后的全仓后端账本，不是U1或R6的F1验收指标。当前仍只闭合01/07/08；U1混合修订隔离偏差与轻量窗/领域集成未闭合，不用本次29绿或旧源16组一致替代架构裁定。

## §6联合复核：固定组合A→后继B→sidebar补证C

正式规格`0409f4c8f`已合入本树`3a06776716a7dc23a1f06350344ada2f861e5990`，以§6.1/6.2/6.4/6.5为准：轻量窗不装配、共享内容同步静态回退；origin由安装来源决定；U1五处混合纠错可按旧源逐条补救；U2原测试、U3真实sidebar、U4 CodeBlock现获精确授权。

以下为R6亲跑，均在本工作树同分支临时`git merge --no-commit --no-ff`组合，完成后abort；没有提交候选合并或编辑实现/expected。不是从lane报告继承通过。

| 组合 | U1 | U2 | U3 | U4 |
|---|---|---|---|---|
| A | 684f3e8059f16243907be4274f40e0ac8fb40d9c | 2c34668760518b1bb5bfcc21b07e1f6975861675 | 756ae4cb30c14cea2093fb6b34904c0f1a691b5b | 35b1ac7b718a7cffcb594ab96c0695f2e5479e8a |
| B | e9d23a1bf3485755830799a7ddeba2a8a4558a05 | ea2c67c289839b9354077fdb5aa1711021beac08 | 227fc43edd25aa2991de65b6ef11c220d3b54c9e | 91000797a3954593d8bbdd4c140fed6a0bb1c5cf |
| C | 9d58350f49d00ddcd6e7e4d65d0216484f210be1 | 同B | 166b6469dc460accf276d95665ee1dd46ca14aef | 同B |

### finding → 修复提交 → 独立结果

| 编号 | 最新核验 | 结论 |
|---|---|---|
| 02/U1 | 候选报告五项旧文件:行 + legacy-boot-evidence执行首版harness/固定旧源，首版缺陷与then修复逐字段重现；旧trace保序，五JSON后续无漂移 | 满足§6.4补救，U1隔离事故子项闭合；不把历史说成纯纠错提交 |
| 03 | U1来源/optionalSlot已与三领域真实glob组合，boot和origin测试通过；轻量窗保持旧实现，内容无Provider回退通过 | 原空glob/轻量窗装配疑问解除；主App首次render仍await、无静态App表，§6.1政策继续待裁定 |
| 04 | U2四原测试接U1 helper；旧源码条件测试改执行生产App表达式而非只找字符串 | 原45+13+8+4项全通过，关闭此编号，未绕开原入口 |
| 09 | ea2c67c28把App setCurrentView、命令回调和通用导航接resolveShellView；默认placement/icon与官方后排序按§6.2 | A中两新key→chat失败在B修复，实际两导航+App表达式通过，关闭09 |
| 10 | U1 options.origin→真实fiber→SlotEntry；installer builtin、loader/default community；U2五图标入口按origin | 同ID社区替换不再免边界，邻项/动作/撤销/重装实测通过，关闭10 |
| 05/sidebar | d89a447b0（在227fc43ed中）接真实SettingsShellSidebar→settings.sections | A中新增分类仅6失败在B修复，实际DOM3项通过；补证时序仍挂02 |
| 06/CodeBlock | f854917e2先纯取证388组合，b347e88df/91000797a再改分派到同一officialMarkdownEntries | 有/无Provider各比原golden通过；两原入口同样双路径通过，不用A旧CodeBlock构建证明本次改造 |

**R6-05新增静态缺口**：Settings和SettingsShellSidebar向settingsNavigation只传`entry.value`，丢失origin；helper的navigation.ts:14,26把社区nav.icon/category.icon原样下传；SettingsSidebar:296-316、SettingsMobileNavigation:84-94直接渲染。SectionContent只保护内容，不能保护导航。要求C1协调U3在允许路径加社区图标局部隔离、保留builtin原路径及真实消费测试。尚未亲跑坏图标复现，不把该静态缺口算成已失败测试。

### U3/U4取证与等价性审读

U3首次`767a55489`只测试/JSON先于b1a7ce816；搜索Map纠错`457628dbf`父为767a55489，仅证据/说明，修ES3转译到ES2022恢复原hook实际索引，再正常merge。当前golden不变，真实旧hook与提取器desktop/mobile完整字段相等。17tab顺序、19lazy路径/export、props/回调表达式、分类和独立搜索顺序都有slot→旧golden对照。内容组件边界改origin；实际Settings和sidebar用slot，不再描述“未交付”。

U4首次完整菜单/Markdown JSON+测试实际在`c3d573c5b`自动检查点（4文件、无生产改动），a58ab79c2只是后续说明；c3d早于58e255320。原两golden未变。原菜单DOM fixture的labelKey字段实际为译文，66fabc39c另从固定旧源补全精确key表，当前slot键比较通过。CodeBlock新增授权的golden在f854917e2纯证据提交先于实际改造。两种内容分派/菜单相对源代码的条件、图标、分隔线、动作close与50ms时序已对照，社区render边界按origin；因完整说明较长，逐分支映射保存在ACCEPTANCE本轮章节。

### 规定门禁与增量：作业号、原命令、result

组合A先`npm run version:generate`退出0（0.11.0 / build19630 / git3a067767）。生成输入留在工作树，不手改/提交。以下命令都经队列submit；`job.mjs result`取退出码，完整输出`/home/dsdev/.oc-jobs/done/<id>.log`。

| 作业 | 原命令 / 范围 | result |
|---|---|---|
| 20261104081334-500c77 | `npx tsc --noEmit -p tsconfig.json` | 0，无诊断/Errors行 |
| 20261104081334-c9ae73 | `npx vitest run --config vitest.config.ts src/ui-kernel/__tests__/origin.test.ts src/ui-plugins/testing src/ui-plugins/official src/components/layout/__tests__/MobileSidebarNavigation.dedup.test.tsx tests/vitest/modernSidebarNavigation.test.tsx src/app/shell/__tests__/desktopSidebarShell.source.test.ts src/app/shell/__tests__/shellExitReachability.source.test.ts src/features/chat/components/__tests__/messageSearchContext.test.tsx src/features/chat/components/renderers/__tests__/FlowToken.lazyCode.test.tsx src/features/chat/components/renderers/__tests__/MarkdownRenderer src/features/chat/components/renderers/__tests__/StreamingBlockRenderer.visibility.test.tsx src/features/chat/components/renderers/__tests__/blockRenderSkip.test.tsx src/features/chat/components/renderers/__tests__/streamingCompletion.test.tsx src/features/chat/components/renderers/__tests__/streamingDefaults.test.tsx --maxWorkers=2` | 1，3断言失败/192通过；没有单独Errors汇总行，不能记全绿 |
| 20261104081334-2fc454 | `env NODE_OPTIONS=--max-old-space-size=8192 npx vite build` | 0，5m34s |
| 20261104081334-0074c4 | `env NODE_OPTIONS=--max-old-space-size=8192 npm run build:demo` | 0，5m45s，hero warmup10项 |
| 20261104083441-a324d4 | B：`npx tsc --noEmit -p tsconfig.json` | 0，无诊断/Errors行 |
| 20261104083441-8b2560 | B：`npx vitest run --config vitest.config.ts src/ui-plugins/official/shell/__tests__/navigationIsolation.test.tsx src/ui-plugins/official/shell/__tests__/shell.golden.test.ts src/ui-plugins/official/settings/sidebar.test.tsx src/ui-plugins/official/settings/runtime.test.tsx src/ui-plugins/official/content/__tests__/codeblock.golden.test.tsx src/ui-plugins/official/content/__tests__/markdown.golden.test.tsx src/ui-plugins/official/content/__tests__/menu.golden.test.tsx src/ui-plugins/official/content/__tests__/registry.test.ts --maxWorkers=2` | 0，8文件29项；无Errors行 |

result原始关键输出：

```text
 Test Files  2 failed | 31 passed (33)
      Tests  3 failed | 192 passed (195)
   Start at  16:13:36
   Duration  122.98s
[作业 20261104081334-c9ae73] 退出码 1

[vite-plugin-static-copy] Copied 77 items.
✓ built in 5m 34s
[作业 20261104081334-2fc454] 退出码 0

[vite-plugin-static-copy] Copied 77 items.
✓ built in 5m 45s
[demo-build] warmup preloads injected into hero.html: 10
[作业 20261104081334-0074c4] 退出码 0

 Test Files  8 passed (8)
      Tests  29 passed (29)
   Start at  16:34:44
   Duration  51.01s
[作业 20261104083441-8b2560] 退出码 0
```

A的失败原值为社区view实际target/committed=`chat-v2`（2项）及sidebar类别expected7/actual6（1项）。B的8文件中真实navigationIsolation10、sidebar3、runtime3、shell golden1、content menu4/markdown5/codeblock2/registry1均通过。只重跑新增/修复影响的范围，没有重复旧192或802矩阵；不能把重叠测试数相加成独立总数。

### 联合A实际chunk证据（不外推B/C）

作业`20261104082657-5a68c8`用只读TypeScript AST遍历bundle静态import/export，退出0。入口`main-BwlegFFt.js`闭包7文件5369030字节；Settings-B7Sh0c5F.js=157504、LearningHubPage-l6XB46Qh.js=23178、WorkbenchDesktop-6y2J1xE4.js=100396、AnkiTasksApp-BtxePm0H.js=43022、MediaStudioApp-BmuhLazr.js=71388，五者均不在入口静态闭包。旧入口闭包5321418字节；不能把新增内核基础设施或Settings重新分chunk的差异自动归为性能等价/退化，亦不代表异步预热时机已验证。

### U3新增sidebar补证C：内容通过，时序待例外

`40480bb9c`仅新增sidebar-evidence.test/sidebar-legacy/sidebar.json；`72fe498df`仅新consumer的sidebar-props比较；`166b6469d`仅说明。固定旧基线`d3943bae5708e92f15f2a38de4510f72b2f77ae6`的44行sidebar与useSettingsNavigation仍是旧实现。旧执行器用ES2022、白名单依赖和同步虚拟state/memo，逐字段核原导航与既有settings.json；32组分别覆盖平台、断点、折叠、外部setSidebarOpen有无、onBack有无，执行真实转发的搜索/焦点/tab/open/back回调。新侧真实React+UiKernel+当前SettingsShellSidebar，mock末端SettingsSidebar以捕获props，不重写消费者算法；DOM导航另由B的sidebar.test3项证明。

`git merge-base --is-ancestor d89a447b0 40480bb9c`退出0：补证确实晚于生产改造，不能表述为先取证。§6.4只明确U1事故，**U3例外仍等架构师裁定**；本次不改expected迁就新实现，不重写历史。

仅补跑新证据两个文件，没重跑已通过的sidebar DOM3项：

```text
[作业 20261104085806-0fc5f6] npx vitest run --config vitest.config.ts src/ui-plugins/official/settings/__golden__/sidebar-evidence.test.ts src/ui-plugins/official/settings/sidebar-props.test.tsx --maxWorkers=2
 Test Files  2 passed (2)
      Tests  2 passed (2)
   Start at  16:58:08
   Duration  6.51s
[作业 20261104085806-0fc5f6] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104085806-0fc5f6.log
```

无Errors行。32输入是用例内场景数，不冒充32 tests，不冒充完整DOM验收。C的U1 9d58350f4与B的e9d23a1bf没有src差异，提供方最终两构建只作外部证据，未另起重复构建。

### 当前未闭合政策与恢复记录

U1主入口BootShell后`await getUiKernel`才render首App，demo也await后首次render；目前没有§6.1规定的主App静态表首帧切换。保留03并交C1/架构师，不把微任务异步说成同步。轻量窗不装配和U1五处golden补救已依§6关闭子项，勿再次派同一旧争议。

多次重启均先检查log/status，已完成作业直接取结果；R6无TESTMAP，以固定编号跟踪。只读ledger作业结果：

```text
ledger: commands 1058 (A 92% B 7.2% C 0%), tests 8036 (A 78% B 0.9%); problems: commands 0, tests 0, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）
[作业 20261104085528-093fa6] npm run migration:ledger -- --check --no-write
[作业 20261104085528-093fa6] 退出码 0
```

全部候选临时合并已abort。恢复后按集成失败指令同步main，当前HEAD `eeaf5bdc7ae95a336c34b3a75b19f844726fe064`；本报告候选结果仍限于A/B/C，不能归为最新main全绿。

### 门禁OOM反馈处理（不是报告代码缺陷）

集成器提供build/build:demo日志均在约4GB堆处OOM，与前述失败模式一致。main已有`081b3426d`修复：Vite堆8GB、同工作树两构建串行及全局构建槽。R6已正常合入，不越权改门禁脚本/配置，不重复无源码变化的两构建。

依反馈要求提交队列，已通过result取得原始结果：

```text
[作业 20261104105908-2245d9] npm run typecheck:host
[作业 20261104105908-2245d9] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104105908-2245d9.log

boundaries: scanned 2382 files, 0 violation(s), 178 suppressed via boundary-allow; rules: native-import, tauri-import, cross-plugin-impl, electron-imports-plugin, sql-outside-repository, test-double, todo-marker, empty-catch, erasable-syntax, console-log
[作业 20261104105908-4d0ea3] npm run migration:boundaries
[作业 20261104105908-4d0ea3] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104105908-4d0ea3.log

No test files found, exiting with code 1
filter: src/ui-plugins
include: host/**/*.test.ts, electron/**/*.test.ts, scripts/electron-migration/**/*.test.ts
[作业 20261104105908-cba85a] npx vitest run -c vitest.host.config.ts src/ui-plugins --maxWorkers=1
[作业 20261104105908-cba85a] 退出码 1；完整输出 /home/dsdev/.oc-jobs/done/20261104105908-cba85a.log
```

Host配置不收前端目录，R6也无Host实现目录；无测试退出1是配置适用范围，不改配置或加passWithNoTests伪造通过。Host类型/边界结果无Errors诊断，前端实际验收依本轮真实前端门禁和剩余编号。

写报告期间协调者自动提交`5a373cc5d`已保存本轮ACCEPTANCE更新（仅该文件）；不是内容丢失。交付需保留该提交与后续汇总提交。当前无未完成队列任务或临时合并，未跟踪src/version.ts仅为规定生成输入，不提交。结论限固定A/B/C，不把main新合入的其他lane或提供方最新结果自动签收。

## 11:16Z恢复：仅验证U4新增官方安装器用例

已按恢复指令查看`git log --oneline -20`、`git status`和既有ledger作业`20261104085528-093fa6`原始退出0结果，没有因重复恢复消息重跑相同账本。R6无TESTMAP，报告提交`a743d976f`、`5a373cc5d`均存活。仅有未跟踪的规定生成输入src/version.ts，未提交。

refs增量核对：U1 `1fed8374dd61dc63ff27a82279ba2cc2c25c7d33`与已审9d58350f4相关生产文件无变化；U3 `df6aa1f321bd533c4c9460ac725af5419a272276`与166b6469d的settings实现/证据无变化；main的FRONTEND-F1规格无差异。因此首帧和sidebar例外/图标问题没有新的修复可签收。

U4候选`27b38ef79449f6ddbb847979b415e4f68d40a43a`对已审91000797a仅增加16行official-install测试，无生产/golden变更。已确认6bd437e73为本树HEAD祖先；临时未提交合入该U4候选后只验证新增用例。用例调用真实`renderWithOfficialUi`及生产官方glob安装器，检查两个slot逐字段等于静态表且全部origin=builtin；未用手工安装替代默认收集，测试结束真实dispose。结果：

```text
[作业 20261104111645-2cffe2] npx vitest run --config vitest.config.ts src/ui-plugins/official/content/__tests__/official-install.test.tsx --maxWorkers=1
 ✓ src/ui-plugins/official/content/__tests__/official-install.test.tsx (1 test) 86ms
 Test Files  1 passed (1)
      Tests  1 passed (1)
   Start at  19:16:47
   Duration  2.76s
[作业 20261104111645-2cffe2] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104111645-2cffe2.log
```

result退出0，无Errors行。临时合并已abort，没有提交候选代码。提供方新构建结果未继承为R6亲跑；本次不重复生产无变化的旧矩阵/两构建。04/09/10等已闭合状态保持，02/03/05/06仍按上文边界保留，整体F1不授通过。

## C1 U4正常main闭环：复用相同实现证据与审查删断言

本次main固定`4c6cd1ba8f377e7200310ae1930fe7def9c61ee3`，已正常merge为`14bd90f4375044d07af72cbbe6cd6773c67898db`。`211eaae464bd62a71c830dcec18279942a1095ae`的父为87a0ef4e7及77c33d5fd，确实合入内容主体。`git merge-base --is-ancestor ea2863c28 main`和同检查27b38ef79均退出1：新增安装器测试、最新lane报告尚不在该main，不能用分支tip代称main。

### 哪些独立证据可复用

逐路径diff确认正常main的MarkdownRenderer、LearningHubContextMenu、CodeBlock、contracts/content及official/content相对91000797a无变化；U1 kernel/slots/react/bootstrap/loader/official installer/render helper相对e9d23a1bf也无变化。故复用R6作业`20261104083441-8b2560`中的：

- no-provider静态官方表与provider真实slot均对原JSON；菜单99、Markdown1584、CodeBlock388是测试内输入组合，不作test数量；未触发任何重录环境变量。
- live Provider卸载后slot为空，不用静态表回填；math回到原code文本。
- origin=community的同官方ID覆盖组件抛错被隔离；builtin保持旧路径。
- 注册value与静态表同引用、真实卸载清空；实际API与已测候选相同。

不重复这些无实现差异的矩阵。提供方105148-51b9bf/105702-3e96c3仅作交接，本次没有把它们改称R6亲跑。R6已于`20261104111645-2cffe2`独立运行未入main的最终安装器测试，通过1项，范围仅注册。

### ea2863c28删除KaTeX断言的判断

逐hunk核对：新增official-install测试初版使用renderWithOfficialUi包`MarkdownRenderer(content=math fence)`，Mock lazyKatex返回`<b>…</b>`，检查slot后查询b。最终换成`<div/>`，删除这个新增渲染断言及mock；两个slot相等断言保留，origin断言扩为两个slot。此文件不属于改造前测试、Rust移植测试或冻结golden，原既有数学/分派断言未删除。

原提供方日志`20261104105304-2358d7`退出1：`expected undefined to be 'x + 1'`，指向该b查询。**日志不能证明它是纯mock故障，也不能因为删后绿认定原渲染行为正确。** R6只接受最终测试证明“真实默认安装器安装同一表、来源builtin、真实Provider可装配并dispose”；不接受它证明实际Markdown解析器到数学DOM的端到端链路。

旧行为义务仍由未修改的markdown golden及原入口承担。现有markdown.golden:24-47有math/latex/pre/code/inline条件对固定旧JSON；:90-103仍实际断言无Provider数学节点、与安装时HTML相同、live卸载后没有b而有原code文本，R6已独立通过。这里react-markdown为受控替身，属于分派等价证据，不是完整解析器/KaTeX或截图证据。未声称截图通过，也未把该删除自动称为修复。

### 正常main仅补跑十个原入口

此前R6完整十入口运行在A时CodeBlock尚未改造，B只跑了其新golden；现在在正常main补这部分旧入口覆盖，不重跑全部192或802矩阵。原命令：

```sh
npx vitest run --config vitest.config.ts src/features/chat/components/__tests__/messageSearchContext.test.tsx src/features/chat/components/renderers/__tests__/FlowToken.lazyCode.test.tsx src/features/chat/components/renderers/__tests__/MarkdownRenderer.bold.test.tsx src/features/chat/components/renderers/__tests__/MarkdownRenderer.codeblock.test.tsx src/features/chat/components/renderers/__tests__/MarkdownRenderer.flowtoken.test.tsx src/features/chat/components/renderers/__tests__/MarkdownRenderer.identity.test.tsx src/features/chat/components/renderers/__tests__/StreamingBlockRenderer.visibility.test.tsx src/features/chat/components/renderers/__tests__/blockRenderSkip.test.tsx src/features/chat/components/renderers/__tests__/streamingCompletion.test.tsx src/features/chat/components/renderers/__tests__/streamingDefaults.test.tsx --maxWorkers=2
```

作业`20261104112804-d7ee89`通过全局队列提交，以`job.mjs wait`取得原结果（退出0），未修改任何原入口或断言：

```text
 Test Files  10 passed (10)
      Tests  68 passed (68)
   Start at  19:30:30
   Duration  46.58s (transform 31.00s, setup 4.12s, collect 99.39s, tests 9.09s, environment 11.42s, prepare 1.99s)
[作业 20261104112804-d7ee89] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104112804-d7ee89.log
```

无Errors行，只有既有Browserslist提示。正常main的原十入口已独立闭环；同源fallback/live空slot/origin/388组合通过精确无diff复用独立B证据。未继承提供方两构建为R6结果，未宣称截图或完整数学解析端到端验证。R6-06的内容实现/原回归子项已核实，保留的只是最终联合门禁边界；U1首帧/U3补证时序与设置导航图标问题单独保留。

## C1 U2 `37ca8bfdd`新依赖后交付：无生产增量，复用独立证据

- 固定候选`37ca8bfdde2375477cff8aeb1943be4a5644acd4`，main `4c6cd1ba8f377e7200310ae1930fe7def9c61ee3`。tip祖先检查退出1，不能说最新报告已入main；但修复`ea2c67c28`祖先检查退出0，main有`87a0ef4e7 merge ds-mig/U2-ui-shell`。
- 候选与ea2c67c28之间，App、ModernSidebar、MobileSidebarNavigation、shell契约/目录以及四个原测试全部diff为空；候选与main同路径也为空。U1 kernel/slots/react/loader/官方安装器/共享helper与R6已独立组合验证的e9d23a1bf一致。新增提供方报告/依赖集成不是新算法。
- 真实App消费重新定位确认：commandPaletteNavigate直接调用setCurrentView而不提前canonicalize；setCurrentView:632调用resolveShellView(rawTargetView,viewEntriesRef.current)，通用handleNavigateToView:828同样调用；ref在每次slot更新后保存最新条目。已注册社区key保持目标，未注册回旧canonical，demo仍用allowInDemo。不是只有测试内手写router。
- 默认无placement、无icon社区项按slot顺序排官方之后，实际两导航传递origin/owner/id；同ID社区覆盖按origin局部隔离，卸载撤销、重新builtin安装恢复来源。相关生产实现与B作业完全相同，未因报告86绿就关闭新问题。

证据复用表：

| 核验义务 | R6已有独立证据 | 本轮处理 |
|---|---|---|
| 四个原测试的Provider/原目的 | 20261104081334-c9ae73内desktop45/mobile13/壳8+4项均通过 | 无文件/依赖差异，不重跑；总作业退出1历史仍保留 |
| 社区新key实际App消费、demo拒绝、卸载后回退 | 20261104083441-8b2560 navigationIsolation10项/当前App表达式及shell golden通过 | 修复ea2c67c28已main，维持09关闭 |
| origin同ID隔离/default-nav/撤销 | 同上真实两导航，以及A的origin测试 | 维持10关闭；不推及U3设置导航图标 |
| 新报告86项、71项目录/类型/12GiB两构建 | C1亲取及lane报告 | 提供方证据，不冒记为本轮R6亲跑，不继承完整签收 |

本轮未提交新重任务，未修改实现/测试/golden；不重复无变化矩阵。原社区新view重定向与原Provider失败不能沿用到当前main；剩余02/03/05/06的精确边界保持，不以本次正常依赖到位冲销首帧/U3时序与图标问题。

## 自动续派：§5自检与R6-05新WIP（固定快照）

正常合入main `d84e29565f06f233f8ea6787487a5f9a11e17743`，本树合并`e0373034e0bbd4f5c8439fe9d57ab788c769c556`。已读standard-v2；独立复核人不改实现，继续遵守两报告写入范围，不在业务LANE写“已完成”。有02/03/05/06真实未决，不回复“无剩余工作”。

报告前快照自检通过全局队列提交`20261104120525-7f8516`，命令`node /home/dsdev/dev/deep-student/scripts/electron-migration/lane-gate.mjs`，其内部各门禁也走队列。该脚本按相对main的src报告路径触发前端门禁，不等于候选F1业务签收。最终提交报告后按§5再次检查准确tip，避免拿旧自检标记新提交。

### R6-05增量事实

U3 `5c8aa07e4`新增settingsIcon：builtin保持原组件引用，community用Suspense/真实ErrorBoundary包裹，fallback空图标，标签/点击保留；同ID测试走真实origin。settingsNavigation现接`SlotEntry<SettingsSection>[]`，SettingsShellSidebar传entries，但主Settings.tsx:385仍调用`settingsNavigation(sectionEntries.map(e=>e.value), navigationT, {isMobile})`，新helper:9解构value后读section.navigation，调用未对齐。

首次固定源码探针作业`20261104120653-654252`原始退出1：

```text
const sectionEntries = sidebarNavItems.map((item) => ({
SyntaxError: Identifier 'sectionEntries' has already been declared
[作业 20261104120653-654252] 退出码 1；完整输出 /home/dsdev/.oc-jobs/done/20261104120653-654252.log
```

这是真实WIP helper参数与局部const重名（8/37行）导致转译后执行前报错，不是主Settings的运行态TypeError已复现。后继`7a1670030`只将参数改slotEntries，语法问题已修；主Settings调用diff为空。对7a固定后继提交只读内联探针`20261104121039-63a2b7`，读取git show原函数转译执行，不落盘/改实现，不修改断言。result如下：

```text
slot entries: [ 'example' ]
candidate Settings value-array call: TypeError: Cannot read properties of undefined (reading 'navigation')
[作业 20261104121039-63a2b7] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104121039-63a2b7.log
```

退出0表示探针证实预期缺陷，非候选验收通过；边界输入fixture不代替整个Settings渲染，只执行真实helper及已核实生产调用形状。

未将未完成自动checkpoint当完成交付，也未用旧语法错误指控后继；实际仍有主消费者接口缺口，R6-05保留。sidebar新测试即使变绿也不能证明仍传旧形状的Settings主页面已修复。

报告前快照自检result原文：

```text
R6-review-frontend：自检 6 项（typecheck、boundaries、typecheck:app、tests:app、build、build:demo），经作业队列执行……
✅ 自检全部通过（e0373034e，基线 main d84e29565）。可以标记完成，集成时会优先测试你的分支。
[作业 20261104120525-7f8516] node /home/dsdev/dev/deep-student/scripts/electron-migration/lane-gate.mjs
[作业 20261104120525-7f8516] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104120525-7f8516.log
```

该自检验证R6报告分支的main基础，不含未合入的7a1670030，不能据此签收U3。按新§5，以下报告先提交，再merge main，最后为准确提交运行lane-gate；最终自检记录由执行器按tip保存，不为改一行报告再制造无限自检链。仍有02/03/05/06实质未决，不宣布无剩余工作。

## R6-05后继交付：`6eca3b07d`独立复验关闭

自动续派先正常merge main，结果Already up to date；起点`0c72a1d139d49ad2d2867125c58b648224cc1a9b`已有作业`20261104121840-f78e5c`六项自检退出0（main45c3250b0）。未重复该提交自检。发现U3 `1ef5caf97fc16130ea8982101891db070fb64f5f`已补齐主Settings的entries调用，固定完整候选`6eca3b07dfb977545151c02edaf92daf39c41f41`，临时未提交合入并独立检查，完成后abort，未提交实现/修改expected。

### 修复落点及保持的行为

- Settings.tsx:385从`settingsNavigation(sectionEntries.map(e=>e.value),...)`改为`settingsNavigation(sectionEntries,...)`；SettingsShellSidebar已同样传entries。helper:8-9消费SlotEntry的形状现在两端一致。相对7a1670030这就是唯一新增生产差异；旧5c重名/7a传值失败仅保留历史。
- helper:18/30分别用实际entry为nav/category图标提供origin；category去重仍使用原Map语义，后者覆盖值、首次位置，排序/搜索不改。
- settingsIcon的builtin分支返回原图标引用；community分支缓存包装组件、使用Suspense/真实ErrorBoundary、空图标fallback。真实sidebar用例验证社区坏category图标的标签/点击/邻项、同官方插件ID覆盖仍community、卸载清理，以及builtin坏图标向外宿主传播。当前导航和分类都经过该函数；不把单一DOM用例描述为所有移动布局均渲染复测。
- 原slot golden、32组sidebar转发与runtime保持通过，golden JSON相对d3943bae5无diff。旧图标身份/顺序、19lazy、props与原条件没有通过修改expected放行。

### 最小队列原始结果

先`npm run version:generate`退出0（0.11.0/build20787/git0c72a1d1）；随后：

```text
[作业 20261104124312-dbe568] npx vitest run --config vitest.config.ts src/ui-plugins/official/settings/sidebar.test.tsx src/ui-plugins/official/settings/runtime.test.tsx src/ui-plugins/official/settings/__golden__/settings.test.ts src/ui-plugins/official/settings/sidebar-props.test.tsx --maxWorkers=2
 ✓ src/ui-plugins/official/settings/sidebar-props.test.tsx (1 test) 700ms
 ✓ src/ui-plugins/official/settings/runtime.test.tsx (3 tests) 3885ms
 ✓ src/ui-plugins/official/settings/sidebar.test.tsx (4 tests) 2959ms
 ✓ src/ui-plugins/official/settings/__golden__/settings.test.ts (1 test) 902ms
 Test Files  4 passed (4)
      Tests  9 passed (9)
   Start at  20:45:57
   Duration  22.80s
[作业 20261104124312-dbe568] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104124312-dbe568.log

[作业 20261104124348-7c2097] npx tsc --noEmit -p tsconfig.json --incremental --tsBuildInfoFile .lane.tsbuildinfo
[作业 20261104124348-7c2097] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104124348-7c2097.log
```

由job.mjs wait取得，均无Errors行，tsc无诊断。关闭05基于生产接线审读与本次独立结果，不依据U3的LANE.md“已完成”声明；未重复其自检/大目录/两构建。

### 当前签收边界与§5

01/04/05/07/08/09/10闭合；02新增sidebar先改造后补证例外、03主App异步首帧、06最终联合基线门禁继续保留。没有新的规格裁定，不能写整体或无剩余工作。新U1分支存在loader队列失败恢复增量，但与03首帧生产入口无变更，不以无关提交关闭政策项。

本轮两报告提交后再`git merge --no-edit main`并运行lane-gate，执行器按最终tip记录结果。产物/版本文件不提交；不为把最终作业号写回报告而反复改变自检tip，最终结果随工具回执交付。

## 正常main `ad11a8394`联合闭环：R6-06签收

正常合入main到R6提交`3503f91bea377d97c8e163506feddf340adb3d45`，base=`ad11a83943de411a75c87364fd8893a174ce63f9`。b07793259 loader与1ef5caf97设置修复已进main（祖先检查退出0），不再停留在候选静态认可；没有临时合并或业务编辑。

### 无差异证据复用与新增最小复验

精确diff：当前settings实现/证据与6eca3b07d相同；content三消费者/合同/目录与27b38ef79相同；shell与ea2c67c28相同；boot三个入口/装配与e9d23a1bf相同。各原golden无漂移。复用R6先前独立的shell实际App/导航、settings9项/32转发、content无Provider与live空slot/同ID隔离/388组合及正常main原十入口68项结果，不把C1取的提供方结果当亲跑，不重复旧全矩阵。

唯一新增main后要求为loader拒绝恢复与设置图标修复。作业采用标题过滤，执行2个新增用例，其余10个未执行如实显示，不计入通过：

```text
[作业 20261104142724-f162c2] npx vitest run --config vitest.config.ts src/ui-kernel/__tests__/loader.test.ts src/ui-plugins/official/settings/sidebar.test.tsx -t keeps reconciling and still disposes|isolates throwing community nav/category icons --maxWorkers=2
 ✓ src/ui-kernel/__tests__/loader.test.ts (8 tests | 7 skipped) 47ms
 ✓ src/ui-plugins/official/settings/sidebar.test.tsx (4 tests | 3 skipped) 2640ms
 Test Files  2 passed (2)
      Tests  2 passed | 10 skipped (12)
   Start at  22:27:26
   Duration  12.21s
[作业 20261104142724-f162c2] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104142724-f162c2.log
```

无Errors行。loader调用生产UiKernel/UiPluginLoader，先装first，故意传坏manifest使一次sync拒绝，再成功同步first/second并dispose，kernel与nav均清空。坏manifest是故障注入向量，不声称Host正常一定会发null；测试证明拒绝不毒化后续queue及dispose。返回`run`仍对调用方拒绝，内部`run.catch`仅恢复队列，外层community错误记录路径保留。正常main后独立验证完成。

设置真实消费者测试检查来源隔离、同ID覆盖、标签/点击/邻项、卸载、builtin原传播；与前次完整9项结果相符，05保持闭合。仅这2项是本次新执行的测试，不冒算成12项全跑。

### 当前正常联合实现的类型与两构建

前置`npm run version:generate`退出0：version0.11.0、build21545、git3503f91b；生成文件不提交。

```text
[作业 20261104142724-7f4bfc] npx tsc --noEmit -p tsconfig.json --incremental --tsBuildInfoFile .lane.tsbuildinfo
[作业 20261104142724-7f4bfc] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104142724-7f4bfc.log

[vite-plugin-static-copy] Copied 77 items.
✓ built in 5m 18s
[作业 20261104142725-364561] env NODE_OPTIONS=--max-old-space-size=8192 npx vite build
[作业 20261104142725-364561] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104142725-364561.log

[vite-plugin-static-copy] Copied 77 items.
✓ built in 5m 12s
[demo-build] warmup preloads injected into hero.html: 10
[作业 20261104142725-d54ed4] env NODE_OPTIONS=--max-old-space-size=8192 npm run build:demo
[作业 20261104142725-d54ed4] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104142725-d54ed4.log
```

tsc无诊断，构建没有Errors汇总行；保留既有大chunk等警告。使用原构建路径并实际完成hero后处理，不用带outDir覆盖的自检构建替代该证据。§1.3命令类别已全部亲自执行，行为回归按此前通过后无源码差异复用及本次增量覆盖，不伪称此轮重新全跑每个旧测试。

### 产物边界

作业`20261104143333-dc830d`使用既有只读AST静态import/export分析，result退出0。入口`main-B2GCADtm.js`，静态JS闭包7文件5344514字节：

| 页面 | 正常main chunk | 字节 | 入口静态可达 |
|---|---|---:|---|
| Settings | Settings-BDZEHYFj.js | 156549 | false |
| LearningHubPage | LearningHubPage-0YhQ59RM.js | 23178 | false |
| WorkbenchDesktop | WorkbenchDesktop-BJ-eheTs.js | 100549 | false |
| AnkiTasksApp | AnkiTasksApp-DkxyXSia.js | 43022 | false |
| MediaStudioApp | MediaStudioApp-DaYn1-Se.js | 71388 | false |

结果仍支持页面未变成入口静态依赖，不将字节差异/独立chunk等同于浏览器首帧时序或截图等价。

### 当前签收与工具故障口径

关闭06内容与最终正常联合门禁缺口；当前仅02/03未决：U3新增sidebar补证晚于改造的例外没有新裁定，主App异步装配后才render的§6.1问题也未裁定。不再把未main的候选描述套用当前正常main，不宣称整体F1通过。

22:00及22:04 gate-excerpt工具事故均依架构师通知作废，误记失败已由工具owner清理，本lane未为该事故修改实现。此次复验为真实正常main代码，不是为作废回执造修复。报告提交、同步main后按standard-v2 §5自检准确tip；结果由执行器留档并在最终回执报告。
