# W26 前端性能：进度

分支 `assault/W26-notes-perf`，工作树 `wt/W26`。

## 第一轮（代理 162a2fe0，末端 `2e1a2cd5`，基于 INT `f3439333`）

完整报告：`.reports/agent-final/W26-1208-162a2fe0.md`。

| 提交 | 内容 |
|---|---|
| `ff587a08` | notes 树：关闭右键菜单时，只在焦点落回 body 时才把焦点还给树节点（新建文件夹输入框一闪即关，#30） |
| `2e1a2cd5` | reduce 动效偏好：在级联层里给 `*, *::before, *::after` 加 `transition-property: none` 默认值；全局 `transition-duration: 0.01ms !important` 不再让没声明过渡的元素产生过渡。笔记 reduce 就绪 4× 降频 14.5 s → 3.9 s |

防回退：`src/styles/__tests__/reducedMotionTransitionDefault.test.ts`（源码契约），notes 树焦点测试 4 条 + 工作区 1 条。

## 第二轮（本轮）

开工：合并 INT `6c491e6f`（`b4330307`），无冲突。第一轮两个提交还没进 INT。

### 交接收集

| 来源 | 事项 | 处理 |
|---|---|---|
| W12 r7 报告 | #30 修好后翻转冒烟 ③b 第 2 例的 `test.fail` | 修复在本分支（`ff587a08`），等 INT 合入后由 W12 翻转；W26 不改 `host/e2e/smoke/**` |
| W16 r5 报告 | notes 的 Linux 基线等 W26 修好后补 | 同上，等 INT 合入 `2e1a2cd5` 后由 W16/主代理在服务器生成 |
| INTEGRATION-NOTES 12:20 / 11:45 | 未点名 W26 | 无 |

### 测量方法

与第一轮相同：Playwright 自带 Chromium headless，1440×900，DPR 1，zh-CN，CDP 降频 1×/4×，reduce 与 no-preference，每项 3 次取中位数。脚本（不入库）：`/tmp/w26/playwright-measure.mjs`、`trace-agg.mjs`、`prof-agg.mjs`、`playwright-origin-probe.mjs`；测量构建 `/tmp/w26/build-measure.mjs` = W16 `tests/visual/lib/build.mjs` 的同款构建 + 一个只用于测量的 `?app=dashboard` 入口（演示构建把 SOTADashboardLite 换成了空组件）。

场景：chat = `demo-app.html?app=chat`（打开会话、瞬时回放首答长消息）；Finder = `?app=learning-hub`；设置 = `?app=models`；仪表盘 = `?app=dashboard`（测量专用）；导图 = `?app=mindmap`；笔记 = `?app=notes`；工作台 = `demo.html?desktop=1` 到两扇窗就绪、DOM 静止 1 s；工作台开窗 = 就绪后点 Dock「设置」到新窗口 DOM 静止。

### 热点与根因（4× reduce trace，含 invalidationTracking）

1. **OverlayScrollbars 的强制样式重算**：工作台 / 聊天 / 笔记启动期强制重算的最大来源（472 / 425 / 326 ms）。
   每轮 update 都切换视口 `data-overlayscrollbars-viewport`，库样式表里 `…~=noContent]:not(#osFakeId) > *:not(#osFakeId)`
   让整片视口子树失效，紧接着读 computed style 强制结算。其中两类是多余的：
   ScrollArea 每次渲染新建 `flowDirectionStyles` → overlayscrollbars-react 重新下发「已变」选项 → 完整 update；
   挂载时初始化后 trackOffset effect 又补一次 `update(true)`。其余是库观察器对内容变化的正常 update。
2. **输入栏写 document root 自定义属性**：工作台启动期输入栏高度 112→98→75 px，三次改写 root 上的
   `--unified-input-docked-height` 等变量，各引发一次全文档样式重算（el≈1300–1500，79/116/120 ms），由随后
   Popover 渲染读 `--dropdown-close-dur`、聊天消息测量 `dB`、OverlayScrollbars 初始化强制结算。
3. **工作台开窗源点竞态**（任务 4）：开窗 layout effect 早于 Dock 的 rAF 坐标发布，约一半概率落回 50%/50%。

### 本轮提交

| 提交 | 内容 |
|---|---|
| `6030f940` | Dock 登记同步量测函数，开窗取不到坐标时现场补测（+ `dockGeometryOpeningRace.test.tsx`） |
| `72b1847f` | 输入栏停靠高度改经 `useComposerDockHeight` 发布，不写 root（+ `useComposerDockHeight.test.tsx`） |
| `3bafd1ad` | ScrollArea 的 OverlayScrollbars options/events 引用稳定（+ `scrollAreaOverlayOptions.test.tsx`） |
| `a7b0562c` | ScrollArea 挂载时不再紧跟初始化 `update(true)`（同上测试文件） |

交付前合并 INT `fe5feb68`（`abb723b5`），无冲突；INT 没有改动本轮涉及的文件。第一轮两个提交已在 INT 里。

### 前后对比（A/B 交错，各 3 次取中位数；base = `b4330307`，new = `a7b0562c`）

| 场景 | 降频 | 动效 | 就绪 ms | 样式重算 ms | 重算次数 | 长任务 ms |
|---|---|---|---|---|---|---|
| 工作台 | 4× | reduce | 5045 → 4527 | 724 → 426 | 228 → 200 | 2077 → 1663 |
| 工作台 | 4× | no-pref | 5175 → 4713 | 837 → 478 | 324 → 290 | 2077 → 1670 |
| 工作台 | 1× | reduce | 2635 → 2622 | 136 → 89 | 239 → 218 | 134 → 110 |
| 聊天 | 4× | reduce | 2677 → 2859 | 473 → 428 | 263 → 226 | 923 → 916 |
| 聊天 | 1× | reduce | 1815 → 1793 | 105 → 86 | 282 → 238 | 0 → 0 |
| 设置 | 4× | no-pref | 1913 → 1737 | 139 → 117 | 106 → 94 | 592 → 509 |
| 笔记 | 4× | reduce | 3282 → 3307 | 787 → 773 | 223 → 188 | 1933 → 1927 |
| 工作台开窗 | 4× | reduce | 103 → 96 | 25 → 24 | 18 → 6 | 0 → 0 |

其余场景（Finder、仪表盘、导图）在噪声范围内。机器负载约 30（15 核），聊天 4× reduce 就绪 +180 ms 在噪声内（长任务总量不变）。

与机器快慢无关的计数（W16 `newScenePage` + `openScene`，各 2 次）：

| 场景 | root 上 `--unified-input-*`/`--composer-*` 写入 | `data-overlayscrollbars-viewport` 变更次数 |
|---|---|---|
| shell-desktop | 15 → 0 | 110 → 75–84 |
| shell-chat | 39 → 0 | 222 → 155–157 |
| chat | 33 → 0 | 131 → 86–93 |
| notes | 0 → 0 | 97 → 62 |
| models | 0 → 0 | 59 → 42 |
| learning-hub | 0 → 0 | 61 → 45–48 |

开窗源点（W16 页面设置，8 次启动后点 Dock「设置」）：落回 50% 的写入 12/24 → 0/24。

### 视觉与门禁

- W16 截图 49/49：修复前、修复后、合并 INT 后均通过。
- W16 DOM 22/24：三次都只差 `shell-chat` 两份，差异只有消息 id 的随机后缀，三次完全相同；W16 r5 报告已记为 W19 后缀改动遗留，不是本分支引起。
- 四项 gate-checks、slot-snapshot、前端 tsc：合并 INT 后全部通过。

### 交接

- W12：`ff587a08` 已进 INT `fe5feb68`，可以翻转冒烟 ③b 第 2 例的 `test.fail`。
- W16：`2e1a2cd5` 已进 INT，可以补 notes 的 Linux 基线；防回退计数见交付报告。
- 文档 `docs/dev/wave2-C-r1/08-keyboard-back.md:30` 仍写着三个变量写到 root，已过时（现在只写输入栏根节点，药丸经 `useComposerDockHeight`）。

## 第三轮（lane 编排派单，接 `72c0c7c0`）

开工：合并 INT `390f244b`（第五批 15 条 lane），合并提交 `53a4a603`，无冲突。

### 交接收集

`rg -n W26` 覆盖 agent-final、reviews、lanes、handoffs、INTEGRATION-NOTES。上一任已处理的（W12 #30 翻转、W16 notes Linux 基线）跳过。新条目：

| 来源 | 事项 | 处理 |
|---|---|---|
| W16 r6 报告 :61 | chunk 层：入口 CSS +118 B 来自 W26 | 知会。来自第一轮 `2e1a2cd5`（reduce 下 `transition-property: none` 默认值），已在 W16 基线里 |
| W16 r6 报告 :91 | 第一轮报告里待审的焦点副作用（菜单开着时点别处可获焦元素，焦点不再被抢回树行），evidence 没覆盖 | 交主代理审；`contextMenuFocus.test.tsx` 已锁住行为，W26 不再改 |

### 方案

- 第五批回归：A = `72c0c7c0`（fe5feb68 + W26 修复，临时工作树 `/Volumes/DSWork/tmp-W26-base`），B = `53a4a603`（390f244b + W26 修复）。测量构建放 `/Volumes/DSWork/tmp-W26-dist/{a,b}`，脚本 `/tmp/w26/playwright-measure.mjs`，方法同第二轮。
- 场景加启动期 JS 体积（入口静态闭包字节数）。

### 第五批回归（A `72c0c7c0` vs B `53a4a603`，各 3 次中位数，负载 25–40）

脚本 `/tmp/w26/playwright-measure-r3.mjs`（第二轮脚本 + 资源计时 JS 字节数、长会话/大列表滚动场景），中位数 `/tmp/w26/medians.mjs`。
入口静态闭包（`/tmp/w26/entry-size.mjs`）A/B 相同：demo.html 297.9 KB / 102.7 KB gz，demo-app.html 233.9 KB。
工作台、聊天、设置、笔记、Finder、仪表盘、导图的样式重算、布局、长任务差异都在 ±5% 内（详见交付报告），没有可归因到第五批提交的回退；导图 4× no-pref、仪表盘 1× no-pref 就绪时间两处可疑，补测 5 轮。

### 第三轮热点

1. **长会话滚动**（新场景 `chat-long`：300 条消息，每条回答含表格、代码块、块级公式；`/tmp/w26/harness/chat-long-pack.ts`）：4× reduce 向上滚 60 步 42 s，样式重算 22.9 s。
   - invalidationTracking：大头是消息列表视口上 `data-overlayscrollbars-viewport` 的改写触发「Invalidation set invalidates subtree」，每次约 4600 个元素、4× 下 100–150 ms，紧接着 OverlayScrollbars 读 overflow（`getElementOverflowStyle`）强制结算。
   - 根因：库样式表 `[data-overlayscrollbars-viewport~=noContent]:not(#osFakeId) > *:not(#osFakeId)` 右侧无特征，Blink 按属性名给该属性建「整子树失效」。库每轮 overflow 更新都先删后加地写两次视口属性（`setAttrs` 不判断值是否相同），于是每次写都整片重算。`noContent` 只在 RTL 视口量测滚动原点时设置（`flowDirectionStyles` 返回 direction 时），本应用的 ScrollArea 在 LTR 下返回 `{}`，从不设置。
   - 实验（构建插件把这份 CSS 换成去掉 `> *` 分支的副本，`/tmp/w26/harness/os-patched.css`，A/B 3 次）：长会话滚动 1× 样式 1387 → 542 ms、帧中位数 100 → 59 ms；聊天 4× 678 → 367；工作台 4× 727 → 516；笔记 4× 1376 → 1196。
   - 方案：不改入口 import（W16 boot golden 记录了 `overlayscrollbars/overlayscrollbars.css`），ScrollArea 首次初始化 OverlayScrollbars 前经 CSSOM 把该规则的子元素分支拆掉；遇到 RTL 视口时在量测前原样补回。
   - 修复 `160928b7`：`src/lib/scroll-overlay-stylesheet.ts`（新）、`src/components/ui/scroll-area.tsx`（初始化前调用；`flowDirectionStyles` 遇 RTL 先补回）。单测 `scrollAreaNoContentRule.test.tsx`：真实库样式表里有这条规则（防升级失效）；去掉初始化前的调用或 RTL 补回，各自对应的用例失败（已实测）。
   - 生产页面由自定义 standard/secure scheme 同源提供（`electron/shell/protocols.ts`），`cssRules` 可读；跨域或读不到的样式表跳过，不影响功能。
2. Finder 1000 项列表滚动：4× 每帧 67 ms、1× 10 ms，无明显热点。
3. **启动期多余的重 chunk**（`/tmp/w26/js-list.mjs` 记录场景就绪前拉取的 JS 及发起方；`/tmp/w26/why-chunk.mjs` 在构建导出的模块图上找真实加载链，chunk 内模块同时求值）：设置页（`?app=models`）就绪前拉 154 个 JS、6.6 MB，其中 vendor-milkdown 1010 KB、vendor-katex 708 KB 页面上用不到。链路：`Settings` chunk 里的 `McpToolEditorModal` 静态 import `UnifiedCodeEditor` → `@codemirror/view`；`vite.config.ts` 的 `vendorChunkName` 没给 `@codemirror/*` 归组，Rollup 的独占依赖合并把它并进 vendor-milkdown，而 crepe 静态 import katex → vendor-katex 跟着加载。`Settings.tsx:25` 的 `UnifiedCodeEditor` import 未使用，但删掉它不改变 chunk 图（同 chunk 的 McpToolEditorModal 仍静态引用）。根因在 W17 的 `vite.config.ts`，写交接，实验构建量化收益。

### 视觉基线（修复前，`906b6555` = INT `2be7ed80` + W26 进度提交）

- 截图 `--check`：49 passed。
- DOM golden `--check`：4 处失败，shell-chat / shell-desktop 各 desktop、mobile，均为 3D 卡片控件的 `title` / `aria-label`：golden 是英文（"Play"、"Go to card N"），实际中文（"播放"、"跳转到第 N 张卡片"）。INT 自带，与 W26 无关。
- 修复 1 后（`160928b7` 构建）：截图 49 passed；DOM golden 同样 4 处、差异块逐字相同。

### 修复 1 前后（h = 修复前，f = `160928b7`，各 3 次中位数）

| 场景 | 指标 | h | f |
|---|---|---|---|
| 长会话滚动 4× reduce | 样式 ms / 长任务 ms / 帧中位数 ms / 就绪 ms | 7009 / 11621 / 541 / 11810 | 2841 / 6534 / 320 / 7005 |
| 长会话滚动 4× no-pref | 样式 / 长任务 / 帧中位数 | 5571 / 10138 / 475 | 2498 / 6717 / 309 |
| 长会话滚动 1× reduce | 样式 / 长任务 / 帧中位数 | 1356 / 1481 / 100 | 500 / 0 / 58 |
| 聊天 4× reduce | 样式 / 长任务 | 677 / 2072 | 360 / 1652 |
| 长会话就绪 4× reduce | 样式 | 1449 | 1111 |
| 工作台 4× / 1× reduce | 样式 | 807 / 137 | 554 / 97 |
| 笔记 4× reduce / no-pref | 样式 | 1406 / 1246 | 1309 / 1060 |

设置、Finder、仪表盘、导图不变。首次挂载多一次样式表扫描（1× 约 10 ms），`24f1ea61` 改成按下标遍历、命中即停。

### 修复 2：OverlayScrollbars 初始化/销毁时的空操作 focus()

- 证据（修复 1 后，长会话滚动 4× 20 步 CPU profile + trace）：样式重算 1868 次（1840 次强制）；强制布局 626 次、1963 ms。自身耗时最大的是 `focus` 1.98 s（销毁路径约 1.25 s，初始化约 0.74 s），调用方是库的 `appendElements` 与 destroy 里的 `focusElement(activeElement)`。
- 根因：库包裹/解包视口内容后，对当前焦点元素调 `focus({preventScroll:true})`，防止被移动的节点丢焦点。焦点在目标之外（虚拟列表滚动时焦点在输入框）时没有节点被移动，这次调用不派发事件、不改选区和 `:focus-visible`（Chromium 探针 `/tmp/w26/refocus-probe.mjs` 实测），却强制结算整份文档的样式与布局。虚拟列表每行挂载、卸载各触发一次。
- 修复 `96cb1721`（`src/components/ui/scroll-area.tsx`）：初始化与销毁期间，焦点在目标之外时给该元素临时挂一个实例级空 `focus`，结束后删掉；焦点在目标之内照常回填。overlayscrollbars-react 的 hook 自带卸载清理会直接 destroy，React 按声明顺序执行卸载清理，所以包裹销毁的 effect 声明在 hook 之前。库的 destroy 幂等，hook 再调一次时直接返回。
- 单测 `scrollAreaRefocus.test.tsx`：mock 照真实 hook 的清理顺序和库的回填行为。去掉 hook 前的销毁 effect，卸载用例失败；去掉初始化包装，初始化用例失败（两处都实测过）。
- 前后（f vs f2，reduce，3 次中位数）：

| 场景 | 样式 ms | 强制布局次数 | 长任务 ms | 帧中位数 ms |
|---|---|---|---|---|
| 长会话滚动 1× | 613 → 483 | 606 → 467 | 552 → 108 | 67 → 58 |
| 长会话滚动 4× | 3189 → 2758 | 626 → 485 | 7615 → 6986 | 351 → 330 |
| 长会话就绪 4× | 1219 → 1057 | 328 → 258 | 4273 → 3908 | |
| 聊天 4× | 405 → 365 | | | |
| 工作台 4× | | | 3002 → 2738 | |

笔记在噪声内（1293 vs 1359）。

### 视觉护栏（INT `1d1fdb78` vs W26 `96cb1721`，W16 `lib/build.mjs` 构建，同一套基线）

| 构建 | 截图 `--check` | DOM golden `--check` |
|---|---|---|
| INT `1d1fdb78` | 49 passed | 20 passed、4 失败（同上，INT 自带的中英文标签） |
| W26 `96cb1721`（修复 1 + 命中即停 + 修复 2） | 49 passed | 同样 4 处，输出逐字相同 |

### 其余场景（INT `1d1fdb78` vs W26 `96cb1721`，3 次中位数）

| 场景 | 4× reduce 样式 ms | 4× reduce 长任务 ms | 4× 强制布局次数 | 就绪前 JS |
|---|---|---|---|---|
| 翻译 reading-translation | 169 → 168 | 886 → 905 | 36 → 43 | 8744 KB / 210 个 |
| 错题本/题库 question-bank | 222 → 190 | 983 → 975 | 26 → 23 | 7380 KB / 213 个 |
| 媒体 media | 90 → 77 | 800 → 790 | 12 → 11 | 6119 KB / 155 个 |
| 备份 data-sync | 183 → 149 | 927 → 826 | 30 → 26 | 6874 KB / 164 个 |

都在噪声内，没有退化。四个场景的样式与布局开销都小，主要成本是启动期加载的 JS：

4. **内容窗口静态带上笔记编辑器**：翻译、题库窗口的加载链是 `demo-app → 场景 → ContentAppWindow → UnifiedAppPanel → NoteContentView(473 KB) → vendor-milkdown(1010 KB) / vendor-katex(708 KB) / vendor-markdown-shared(401 KB)`，再经 `line` chunk 拉 vendor-recharts(288 KB) 和 vendor-d3(217 KB)，非笔记窗口约 3 MB 用不到。根因 `src/features/learning-hub/apps/UnifiedAppPanel.tsx:27-28` 有意静态 import（注释：避免 Suspense 导致 Crepe 初始化卡住；`src/dstu/editors/NoteEditorWrapper.tsx:24-26` 同理）。改成懒加载要先在 Electron 里复现并排除当初的初始化卡住问题，不属于零风险修复，写交接给 W09。

### 笔记 `:has()` 失效（W18，只分析）

- invalidation trace（笔记 4×）：8 次重算 ≥ 1000 个元素（各 2500–3000 个、70–135 ms），触发方是 milkdown 插件视图往编辑器父节点追加节点、ProseMirror 聚焦、CodeMirror 同步。"Affected by :has()" 的锚点：`.notes-crepe-shell` 71 次、`.crepe-editor-wrapper` 65 次、`.ProseMirror` 31 次、`.milkdown-code-block` 17 次；整子树失效落在 `.milkdown` 7 次、`.milkdown-code-block` 5 次、`.ProseMirror` 3 次。
- 根因判断：Blink 给所有 `:has()` 共用一份伪类失效集合，只要有一条 `X:has(...) … > *` 这种右侧无特征的规则，任何 `:has()` 状态变化都按整子树失效。现有四处：`CrepeEditor.css:488`、`:489`、`:579`，以及 `generative-ui.css:112`。
- 实验：构建插件去掉这四处（hp）：笔记 4× 样式 1359 → 1096 ms（−19%）、1× 265 → 214、长任务 3777 → 3408；聊天基本不变。只把 489/579 改成零视觉等价的 `.children > .content-dom`（hp2，488 和 generative-ui 保留）：4× reduce 1245 → 1277、no-pref 1202 → 1059，在噪声内。说明必须四处都处理。
- 489/579 直接删会改变外观（`color … !important` 压过子元素自带颜色），所以交接给的是等价改写，见交接。

### 交接

**W17 — `vite.config.ts`（设置页、技能页不再拉 milkdown/katex）**

```diff
@@ vite.config.ts:223 vendor-micro 列表
   if (
     id.includes('node_modules/uuid/') ||
+    // @babel/runtime 辅助函数被 prism / heat-map / textarea-autosize / @uiw/react-codemirror 共用；
+    // 不归组时跟着 @uiw/react-codemirror 进 vendor-codemirror，工作台与导图会多拉 431 KB
+    id.includes('node_modules/@babel/runtime/') ||
@@ vite.config.ts:289 katex 规则之前
+  // CodeMirror 核心（设置页 MCP 工具编辑器、笔记代码块共用）：不归组时被 Rollup 并进 vendor-milkdown，
+  // 设置页因 McpToolEditorModal → UnifiedCodeEditor 连带加载整个 milkdown 与 katex。语言包保持懒加载 chunk。
+  if (/node_modules\/(@codemirror\/(state|view|language|commands|autocomplete|lint|search|theme-one-dark)|@marijn\/find-cluster-break|@lezer\/(common|highlight|lr)|@uiw\/react-codemirror|@uiw\/codemirror-extensions-basic-setup|style-mod|w3c-keyname|crelt)\//.test(id)) {
+    return 'vendor-codemirror';
+  }
@@ vite.config.ts:664 build.rollupOptions
     rollupOptions: {
+      // katex 没有导入期副作用；不声明时 tree-shake 掉的 micromark-extension-math/lib/html.js
+      // 仍留下 `import 'katex'` 边，vendor-markdown-shared 一加载就带上 vendor-katex
+      treeshake: { moduleSideEffects: (id) => !/node_modules\/(.*\/)?katex\/dist\/katex\.mjs$/.test(id) },
```

- 实验（构建插件等价实现，cmk3，demo 构建，场景就绪前 JS）：设置页 6667 → 5350 KB（不再拉 vendor-milkdown、vendor-katex，多 vendor-codemirror 431 KB）；技能 MCP 6120 → 4803 KB；工作台、导图不变；聊天、笔记、题库约 +35 KB。
- 注意：`@marijn/find-cluster-break`、`@codemirror/theme-one-dark` 必须一起归组，否则 `vendor-codemirror ⇄ vendor-milkdown` 成环，`failOnCircularChunk` 报错（实测）；`@babel/runtime` 不进 vendor-micro 时工作台、导图多 431 KB（实测）。生产 chunk-graph golden 要随之更新。
- 另：vendor-katex 里有第二份 katex（crepe 依赖的嵌套 `katex`），以及 `katexSandboxCssData.ts` 的 anki 专用内联字体与原始 CSS（约 140 KB），可以再拆。

**W09 — `src/features/learning-hub/apps/UnifiedAppPanel.tsx:27-28`**：非笔记内容窗口（翻译、题库等）静态带上 NoteContentView 与 milkdown/katex/recharts，约 3 MB。建议先在 Electron 里复现注释说的"Suspense 导致 Crepe 初始化卡住"，排除后改成 `React.lazy` + 在 `type === 'note'` 的分支外不加载；`src/dstu/editors/NoteEditorWrapper.tsx:24-26` 同理。另 `src/features/settings/components/Settings.tsx:25` 的 `UnifiedCodeEditor` import 未使用，可删（不改变 chunk 图）。

**W18 — `src/components/crepe/CrepeEditor.css`（笔记 `:has()` 整子树失效）**

```diff
@@ CrepeEditor.css:482-494
-.crepe-editor-wrapper .task-list-item:has(input[type="checkbox"]:checked),
 .crepe-editor-wrapper .milkdown-list-item-block li:has(.label.checked) .children {
@@
-.crepe-editor-wrapper .task-list-item:has(input[type="checkbox"]:checked) > *,
-.crepe-editor-wrapper .milkdown-list-item-block li:has(.label.checked) .children > *,
+.crepe-editor-wrapper .milkdown-list-item-block li:has(.label.checked) .children > .content-dom,
@@ CrepeEditor.css:578-579
-.dark .crepe-editor-wrapper .milkdown-list-item-block li:has(.label.checked) .children > *,
+.dark .crepe-editor-wrapper .milkdown-list-item-block li:has(.label.checked) .children > .content-dom,
```

- `.children > .content-dom` 与 `.children > *` 等价：`@milkdown/components/lib/list-item-block/index.js:179` 的 `.children` 由 Vue 渲染为空 div，`onMount`（:221）只往里 `appendChild(contentDOM)`。
- `.task-list-item` 由聊天的 react-markdown 渲染（`markdown-render.json` golden），Crepe 的 list-item-block 视图替换了列表项渲染，482/488 在编辑器里大概率是死规则，请 W18 确认后删除；若仍有效，需要另找有特征的写法。
- `src/features/generative-ui/generative-ui.css:112`（W09 路径）`.generative-ui-compact > :where(div:has(> h3)) > * + *` 同样右侧无特征，需要给标题块加 class 或 data 属性改写。四处都处理才有收益（见上面 hp / hp2）。
- `src/styles/notes-typography.css:145-163` 的 `.notes-crepe-shell:has(.notes-document-header[data-notes-…])`：建议 `NotesEditorHeader.tsx:510-512` 设置的属性直接放到 `NotesCrepeEditor.tsx:2521` 的 shell 元素上，省掉这组 `:has()`。

**W16 — 与机器快慢无关的防回退指标**

1. 样式表不变量（CSSOM 扫描，任意演示场景 ScrollArea 挂载后）：不允许出现「选择器含 `[data-overlayscrollbars-viewport` 或 `:has(`，后面跟组合符，且最右复合选择器无类/属性/标签特征」的生效规则。现有白名单是上面四处，等 W18/W09 处理后清空。
2. 焦点计数（初始化脚本包一层 `HTMLElement.prototype.focus` 计数）：`chat-long` 滚动 20 步期间，焦点在输入框时 `focus()` 调用次数 = 0（修复 2 前每行挂载、卸载各 1 次）。
3. 强制布局次数（trace 里 `Layout` 事件数，不比耗时）：`chat-long` 滚动 20 步，1× 467、4× 485，随降频变化 < 5%；上限建议 550（修复 2 前 606–626）。单次样式重算元素数上限建议 1600（修复 1 后最大 1541，修复前每次约 4600）。
4. chunk 图（W17 改完后）：`Settings`、`skills-mcp` 懒加载 chunk 的静态闭包不含 vendor-milkdown、vendor-katex；W09 改完后，`ContentAppWindow` 的静态闭包不含 `NoteContentView`。

### 交付门禁（`3f4600ec` = 合并 INT `065a68f3`）

- `boundaries.mjs`：0 违规。gate-checks ui-boundaries / frontend-invoke / event-emit / import-cycles `--check`：均 0 new、0 stale。`slot-snapshot --check`：通过。
- `tsc --noEmit -p tsconfig.json`：通过。
- W16 截图 `--check`：49 passed。DOM golden `--check`：同样 4 处 INT 自带的中英文标签差异，输出与 INT `1d1fdb78` 构建逐字相同。
