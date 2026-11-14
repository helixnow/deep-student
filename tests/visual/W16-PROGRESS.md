# W16 / FE-A1 回归安全网 — 进度

分支 `assault/W16-fe-regression-net`（integration + W09 第一轮）。中断后从这里续上；使用说明见 `REGRESSION.md`。

## 状态（2026-11-07 04:15）

| 层 | 命令 | 基线 | 两次零差异 | 变异 |
|---|---|---|---|---|
| 1 槽位快照 | `node scripts/plugins/slot-snapshot.mjs` | `__golden__/slots/` 16 场景，6 个槽位 107 条 | 通过（多次） | 导航顺序 → 捕获 |
| 2 DOM golden | `node tests/visual/dom-golden.mjs` | `__golden__/dom/darwin/` 24 份；`linux/` 22 份（缺 notes，与 darwin 逐字节相同） | 通过（`--retries 0` 两次） | 侧栏 class `pl-9→pl-10` → 捕获 |
| 3 IPC 轨迹 | `node scripts/plugins/ipc-trace.mjs` | `__golden__/ipc/` 18 场景 22 步 + inventory | 通过（`--retries 0` 两次） | `groupId→group_id` → 捕获 |
| 4 截图 | `node tests/visual/screenshots.mjs` | `__screenshots__/darwin/` 48 张 + 字体指纹；`linux/` 44 张（缺 notes） | 通过（两次） | 4px 的 class 变化低于 0.1% 阈值，未捕获（由 DOM 层负责） |
| 5 chunk 图 | `node scripts/plugins/chunk-graph.mjs` | `__golden__/chunk-graph/main.json` | 构建两次 `--strict` 零差异 | 合成用例单测覆盖 |

变异验证：`bin/heavy node tests/visual/mutations/verify-mutations.mjs --also-screenshots` → 3/3。

## 第二波（2026-11-07）

- **取证基线**（`src/ui-plugins/testing/__tests__/evidence/`，golden 在 `__golden__/evidence/`）。提交：
  - 调试面板 `66aec170`
  - 仪表盘 `ff8db68e`
  - 编辑器扩展 `3d3e2967`
  - Finder 菜单 `6f26f407`
  - 工作台菜单 `acff1c4c`
- **槽位层录制 chatEvents / chatModes**：`12cbf0e9`。
- **INT `68d37526` 五层回归结果**：
  - 槽位：通过。
  - DOM / IPC / 截图：演示壳白屏。原因是 W18 `ui-boot` 分组形成 chunk 环，属于回归，owner W18。临时绕过后：DOM 只剩 skills-mcp 一处 "2"→"3"（RF-W09，基线 `88f6982b`）；IPC 通过；截图 49 个用例通过。
  - chunk：5 条违规，全部是有意变化，基线 `7089d24f`。
- **网的改进**（`ff01f585`）：
  - 启动预检 `lib/boot-check.mjs`。
  - `regress.mjs` 新增 evidence 层和 `--base` 的 `[待审]` 清单。
  - `build.mjs` 命令行固定用 8 GiB 堆。
- **合入 INT `0a16c769`**（`3cbe2069`）后：槽位、evidence、chunk 均通过（chunk 有 2 处结构变化，入口闭包 −331 B）。

## 第四轮（2026-11-07，INT `4384a313`）

- 取证 i18n mock（`evidence/i18nMock.tsx`）：`t(key, '后备')` 先查语言包。各套件统一使用。
  - 提交 `b4273012`：workbench-menus 30 行文案修正（应用名、壁纸名不再显示 typeId）。
  - 提交 `330e8dee`：debug-panels 3 处文案修正。
- 笔记树右键菜单取证（`ba0163c2`）：6 种目标，每个条目逐一点击。顺带记录了一个既有行为：「新建文件夹」的输入行打开后，菜单关闭时焦点归还给树行，空输入随即被取消。
- Dock 默认钉选取证：`74d4d3bb`。
- 启动门禁：`bin/heavy node tests/visual/lib/boot-check.mjs --build [--main]`（`db3bc4b9`），失败时打印环路。INT `4384a313` 上演示壳仍然失败，主构建 0 环。
- Linux 基线：主代理在服务器上用 `560d7169` 生成，到达后再做五层分类。

## 第五轮（2026-11-07，INT `1fcc7743`，含 Linux 基线）

INT 上五层对照改造前基线（darwin）的结果。演示壳不打补丁就能启动，因为 W17 的 `f90b38e5` 修掉了 chunk 环。

| 层 | 结果 | 分类 |
|---|---|---|
| 启动预检 | 通过：demo 0 环、0 启动问题；main 0 环 | — |
| 槽位 | 18/18 | — |
| DOM | 24/24（两次，`--retries 0`） | — |
| IPC | 16/18 | `notes`：网的竞争，改造前同样出现；`skills-mcp`：W18 的 chunk 结构副作用（见下） |
| 截图 | 49/49 | — |
| chunk | 0 违规，81 处结构变化，入口 −2514 B | — |
| evidence | 12/14 | FE-B5 两项：INT 处在 W18 的中间态，W18 第四轮会改回（见下） |

- **网修正 `7544cbd8`**：「用时 N 秒」（chat-Anki 完成条）和「已用时 N 秒」（思考摘要）是四舍五入到秒的实测耗时，也是 linux 与 darwin DOM 之间唯一的差别（chat 1→2 秒，shell-chat 2→3 秒），现在掩码为 `用时 <n> 秒`。证明：`560d7169` 构建上跑两次，只有 skills-mcp 的 RF-W09 两行不同；INT 上 24/24 跑两次；主构建产物逐字节不变。
- **Linux 基线 RF-W09 `9e305508`**：skills-mcp 的工具数 2→3，与 darwin 的 `88f6982b` 相同。修改后 22 份 linux DOM 与 darwin 完全一致。Linux 上的 4 张 skills-mcp 截图还没有在服务器上确认。
- **IPC `skills-mcp` 少了 `listen:tauri://close-requested`**：改造前的构建上两次都通过，INT 上两次都失败。原因：
  - 改造前，skills-management 从共享的 `WindowControls` chunk 取 `TerminalIcon`，这个 chunk 带上了 `globalSearchProviders`、DSTU 适配器，再带上 `vfsRefApiEnhancements`。后者在模块加载时注册 Tauri 关闭监听，用来清缓存。
  - W18 的 `ui-boot` 手工 chunk（`fe124709`）把图标收进了 `ui-boot`，skills-mcp 启动时的 chunk 数从 204 降到 139，这个模块要到第一次用到时才加载。
  - 用户看不到变化：要清的缓存本来就由这个模块创建。需要 W18 确认后，在 W18 分支上单独更新 `ipc/skills-mcp.json`。
- **IPC `notes`**：boot 第 22 条起，`notes_editor_register` 与技能加载链（3 条命令）先后不定。改造前构建 6 次失败 3 次，INT 6 次失败 3 次；其余 22 条的顺序始终稳定。修复办法见交接 1。
- **FE-B5**：INT 上编辑器插件的展开序列（293 项、顺序）完全相同，只是最后 20 次 `use()` 合成了 1 次。W18 第四轮（`e0158a10`，还没进 INT）用 `resolveEditorExtensionGroups` 恢复了每个条目一次 `use()`。在临时工作树里把 INT 和 W18 分支合在一起，evidence 14/14 通过，所以 golden 不重新采集。
- 门禁：ui-boundaries、frontend-invoke、event-emit 均为 0 新增；前端 tsc 0 错误（临时生成的 `src/version.ts` 已删除）。

### 第五轮补充：INT `7870c57b`（含 W17、W18 第四轮、W19）

合并后 W16 与 INT 在本 lane 路径之外没有差异，下面的问题都出在 INT 上。

- **INT 构建失败**（主构建和演示壳都是）。W17 的构建期官方插件表（`8888dad7`，`src/platform/official-plugins.ts`）要求每个 `official/<dir>/index.ts` 默认导出字面量 `defineUiPlugin({ meta: { … } })`。W19 新增的 `dashboard`、`learning-today`、`debug` 三个入口导出的是普通 `UiPlugin` 对象（`5305eea3`），INT 的 `official-plugins.test.ts` 也因此失败。另外，`debug` 把 `devOnly: true` 写在顶层，内核和插件表只读 `meta.devOnly`，所以生产构建仍会安装它。如果改到 `meta` 里，W17 测试里「生产构建只丢 `dstu.ui.dev`」的断言要跟着改。这件事由 W17 和 W19 商定。
- **ui-boundaries 门禁失败，新增 2 条**：`official/{dashboard,debug}/api.ts` 引用了 `official/lazy-contributions.ts`。W19 的提交说明里写了这 2 条，但没有登记基线。frontend-invoke、event-emit 均为 0 新增；前端 tsc 0 错误。
- **核验方法**：在临时工作树里把这三个入口包上 `defineUiPlugin`，运行时行为与 INT 相同（`defineUiPlugin` 在写了 `name` 时就是恒等函数；`debug` 的 `devOnly` 仍放在顶层）。插件表测试 5/5 通过后，对照改造前基线跑全部层：

| 层 | 结果 | 分类 |
|---|---|---|
| 启动预检 | 通过 | — |
| 槽位 | 18/18 | — |
| DOM | 22/24 | `shell-chat` ×2：W19 |
| IPC | 16/18 | `skills-mcp`：W18（同上，未处理）；`notes`：W19 + 网的竞争 |
| 截图 | 49/49 | — |
| chunk | 6 违规，入口 −70422 B | W19 |
| evidence | 14/14 | FE-B5 已随 W18 第四轮变绿 |

不打补丁、直接在 W16 末端上跑：槽位 18/18，evidence 14/14（这两层不需要构建）。chunk 层要先构建，INT 修好之前跑不了。

- **归属核验**：在 W19 合入之前的 INT（`0fd70b95`）上，`notes` 顺序和 `shell-chat` 都没有变化；在 W19 分支末端（`5305eea3`）上两处都能复现。所以下面三项都来自 W19 分支本身，用户都看不到：
  - `shell-chat` 的 DOM：与 W19 `b38fb80b` 的 chat/shell-desktop 同一机制。启动时随机数抽取次数变了，消息 id 的随机后缀随之改变（`q74inb` → `wfbf12` 等），结构不变。W19 只更新了另外两个场景。
  - `notes` 的 IPC：`notes_get_backlinks(noteId)` 从 boot 第 17 条移到第 20 条，排到 `notes_state_list`、`dstu_list`、`save_setting` 之后。5 次运行 5 次都这样，不是竞争。反链面板的代码自 `1fcc7743` 没有改动，是时序的副作用；notes 的 DOM 和截图都通过。`notes_editor_register` 的竞争仍在（第 26 → 29 条）。
  - chunk 图：W19 FE-B7（`daf687e1`）把 `main.tsx` 的导入从整个 `DstuDebugPlugin` 换成了 `debug-panel/channels/dstu`，入口闭包少了 4 个调试面板插件，多了 `bus.ts` 和 4 个 channel，合计 −70 KB。同时 `citationParser.ts` 因为调试面板不再静态引用它，并进了 `MarkdownRenderer` chunk（4241 B），不再是独立的动态入口。
- **`6b3ef583`**：把 W19 `b38fb80b` 的 darwin 变化同步到 linux（chat、shell-desktop 共 4 份）。同步前逐行确认 linux 与 darwin 的差异正好就是 `b38fb80b` 的 24 行；同步后 22 份 linux DOM 再次与 darwin 一致。

## 第六轮（2026-11-07，INT `6c491e6f`）

本轮 `scripts/plugins/ipc-trace.mjs` 归 W16（INTEGRATION-NOTES「12:20 第四批派单」）。合并 INT 后（`22aad443`），各层对照第五轮的基线：

| 层 | 结果 | 分类 |
|---|---|---|
| 启动预检 | 通过 | — |
| 槽位 | 18/18 | — |
| DOM | 22/24 | `shell-chat` ×2：W19，已登记（`5efb2c60`） |
| IPC | 16/18 | `notes`：启动模块图带来的时序变化，已登记（`c4544af3`）；`skills-mcp`：W18，未登记，由 W18 决定 |
| 截图 | 49/49 | — |
| chunk | 6 违规 | W19 `daf687e1` 与 `citationParser` 并块；W17 第六轮判定不是回归，已重录（`d978b014`） |
| evidence | 14/14 | — |
| motion（新增） | 失败：reduce 6136 次，no-preference 7 次（1×）；4× 降速下 3469 对 7 | W26 的修复还没进 INT；在 W26 末端 `b4330307` 上 1× 和 4× 都是 6 对 7，通过 |

前端 tsc 0 错误；五个门禁加 slot-snapshot、boundaries 都是 0 新增、0 过期。

- **ipc-trace**：
  - `c1b2e373`：step 级 `unordered`。列出的命令只查有无，不参与顺序比较；`--update` 从已有 golden 读取这份列表，判断 3 次顺序是否一致时排除这些命令，并写回 step。
  - `c45fa03e`：在 notes 的 boot 步骤登记 `notes_editor_register(noteId)`。之后在 INT 上连续 3 次 `--update --scenes notes`，输出逐字节相同，boot 步骤都保持 `sequence`，不再降成 `set`。
  - `730eca8d`：`compareTrace` 改为在两边都有的命令上比较顺序。旧逻辑在 step 同时有增减时跳过顺序检查，第五轮因此把 notes 的顺序变化错记成「W19 合入前没有」。
- **notes 的 IPC（`c4544af3`）**：`notes_get_backlinks(noteId)` 从 boot 第 17 条移到第 20 条，调用集合不变。逐个改动做构建实验，每次跑两遍：
  - 在 `0fd70b95`（W18 合入 INT）上把编辑器插件改回一次 `use()`：仍是 #20。
  - 在 `0fd70b95` 上回退 W18 `e0158a10` 的菜单部分：仍是 #20。
  - 在 `0fd70b95` 上让官方 `editor`、`menu` 插件的 `index.ts` 从 `@/ui-kernel/kernel` 而不是 `@/ui-sdk` 导入 `defineUiPlugin`（同一个函数）：回到 #17。
  - 在 INT `6c491e6f` 上对五个使用 `@/ui-sdk` 的官方插件 `index.ts` 做同样修改：回到 #17。
  - 结论：位置取决于启动模块图，只是时序变化。`1fcc7743`、`a0138714` 是 #17；`0fd70b95`（W18 `e0158a10` 引入 `@/ui-sdk` 导入）是 #20。W19 末端 `5305eea3` 没有这类导入，也是 #20，但 W19 更早的提交所在的基底上演示壳起不来，没能定位到具体提交。
- **`shell-chat` 的 DOM（`5efb2c60`）**：W19 合入前的 INT `0fd70b95` 上仍是旧后缀（`q74inb`、`gvad3c`、`2k1g07`、`870qwm`），W19 末端 `5305eea3` 上已是新后缀。W19 末端与新 golden 的其余差别只有「N分钟前 / 刚刚」，这是时钟相关的文字，来自不同基底。机制与 W19 `b38fb80b` 相同：消息 id 后缀由 `variantActions.ts:111` 的 `Math.random()` 生成，启动时少抽了 4 次随机数，后缀随之改变，结构不变。`b38fb80b` 只更新了 `chat` 和 `shell-desktop`。linux 的 22 份与 darwin 逐字节相同。
- **motion 层（`5ceeb009`）**：`tests/visual/motion-check.mjs`，规则见 `REGRESSION.md` §3.7。用 `addInitScript` 在捕获阶段统计 `transitionrun`，在 `__DEMO_READY__` 被赋值的那一刻冻结计数，要求 reduce 下的次数不多于 no-preference。用 4× CPU 降速复测，结果相同，所以不受机器快慢影响。`regress.mjs`、`linux/run-native.sh`、`linux/in-container.sh` 的 check 都已接入。
- **交接收集**：
  - W17 → chunk 图重录：已完成（`d978b014`）。
  - W26 → 防回退检查：已完成（motion 层）。
  - W18 交接 28：生产代码保持每个条目一次 `use()`，条件不成立，evidence 14/14。
  - W09 → 复核 `models` 的 DOM：INT `6c491e6f` 上 24 份里只有 `shell-chat` 不同，`models` 通过。W09 这一处改动在第四批里，合入后要再看一次。
  - W09 列出的 8 个失败文件里有 2 个归 W16（`src/ui-plugins/testing/__tests__/{fullstack-pairing,official-slots.golden}.test.tsx`）：在 `6c491e6f` 和第四批暂存 `3380c140` 上都通过（5/5，单文件和整个目录都试过），`useUiKernel: missing <UiKernelProvider>` 没有复现。
- **第四批暂存 `3380c140` 预检**（还没进 INT）：`notesTreeMenu.golden` 6 例失败。「新建文件夹」的输入行不再打开后立刻取消，而是可以输入名称并回车调用 `folderApi.createFolder`。这正是 W26 修的缺陷（INTEGRATION-NOTES 10:50 节第 166 行划给 W26；第四轮时 W16 记下的是旧行为）。等 INT 合入后单独重录。

### 第六轮收尾：INT `fe5feb68`（第四批）

合并（`6d159c6f`）后与暂存 `3380c140` 加本分支的试合并只差 W02 的两个 `host/` 文件，前端构建相同。在分支末端跑全部层：

| 层 | 结果 | 分类 |
|---|---|---|
| 启动预检 | 通过；主构建静态扫描 0 环 | — |
| 槽位 | 18/18 | — |
| DOM | 24/24 | — （W09 要求复核的 `models` 通过） |
| IPC | 16/18 | `skills-mcp`：W18，未登记（同前）；`shell-desktop` 或 `shell-chat` 其一：网的计时竞争，未登记，归 W16（见下） |
| 截图 | 49/49 | — |
| motion | 通过：reduce 6，no-preference 7 | W26 修复已进 INT |
| chunk | 4 违规 → 重录后 0（`--strict` 0 变化） | W09 已批准的 4 条 RF，已登记（`321f5f38`） |
| evidence | 8/14 → 重录后 14/14 | `notesTreeMenu` ×6：W26 `ff587a08` 修复，已登记（`12dbc1be`） |

门禁：五个 gate-checks、slot-snapshot、boundaries 都是 0 新增、0 过期、0 违规；前端 tsc 0 错误。暂存上 boundaries 有 1 条 `erasable-syntax`（W02 `db4d96d5`，`host/plugins/chat-pipeline/src/request-manifest.ts:44`），INT `fe5feb68` 已修。

- **chunk（`321f5f38`）**：入口闭包新增 `componentReason.ts`、`useComponentReasonText.ts`（RF-W09-recovery-reason-localized 及其前置 `977bd724`）和 `recoveryDescription.ts`（RF-W09-recovery-description-by-outcome），都由原本就在入口 chunk 里的恢复页、「暂不可用」面板引用。另外 `Tabs.tsx` 变大来自 RF-W09-shared-tabs-aria-semantics，聊天适配器变大来自 RF-W09-stale-model-cache-context-budget，入口 CSS +118 B 来自 W26。合计 +6596 B，没有懒加载页面变成静态导入。
- **evidence（`12dbc1be`）**：6 个目标的差别只在「新建文件夹」一行。拿旧 golden 对照：W26 末端 `2e1a2cd5` 上 6/6 出现同样的变化，W18 末端 `a015747a`（笔记树菜单移到 `resource.contextMenu`）6/6 通过。W26 报告里待审的副作用是点击菜单外别的可获焦元素时由那个元素保留焦点，取证没有覆盖，由主代理审。
- **IPC 的两处计时竞争**（`REGRESSION.md` §9）：
  - `shell-chat`：`chat_v2_upsert_streaming_block` 在第一个分块后节流 5 秒触发，演示流约 5.2–5.5 秒。旧构建上保存比流结束早 152–304 ms，第四批的流缩短到 5209–5232 ms，只早 6–22 ms，6 次里漏 1 次。
  - `shell-desktop`：`plugin:updater|check()` 在启动后 5 秒触发，boot 窗口在页面静下来后约 3.4 秒结束。旧构建上 5 次漏 2 次，第四批的页面早约 200 ms 静下来，5 次全漏。
  - 两处调用点都没有改动，竞争原本就存在，第四批让页面更早静下来、流更短之后更容易出现。下一轮要让启动阶段的时序确定（比如改用暂停的页面时钟），在那之前不更新这两份 golden。
- **其他交接**：W09 列出的 `src/ui-plugins/testing/__tests__/{fullstack-pairing,official-slots.golden}.test.tsx` 在分支末端（INT `fe5feb68`）上 5/5 通过；在暂存 `3380c140` 上整个目录跑过，这两个文件也通过。`legacy-boot-evidence.test.ts` 失败是环境原因（见下）。

### 第七轮：INT `390f244b`（第五批）→ `2be7ed80`（C 趟）→ `1d1fdb78`（D 趟）

三次合并都没有冲突：`485a114b`、`1c8e2ea3`、`f316b99e`。每次合并后重新构建，跑全部层。

| 层 | 第六轮（`fe5feb68`） | 第五批合并后 | C 趟合并后 | D 趟合并后（交付） |
|---|---|---|---|---|
| 启动预检 | 通过 | 通过，0 环 | 通过，主构建 0 环 | 通过，主构建 0 环 |
| 槽位 | 18/18 | 18/18 | 18/18 | 18/18 |
| DOM | 24/24 | 20/24（W09 RF） | 20/24（W09 RF；另有 1 次快捷方式后缀竞争） | 24/24 |
| IPC | 16/18 | 15–16/18（skills-mcp W18；两处计时竞争） | 17/18（skills-mcp W18） | 18/18 |
| 截图 | 49/49 | 49/49 | 49/49 | 49/49 |
| motion | 通过 6/7 | 通过 | 通过 6/7 | 通过 6/7 |
| chunk | 0 违规 | 1 违规（W09） | 3 违规（W09、W26），`382ed872` 重录 | 1 违规（W18，入口 +214 B），`1821e785` 重录 |
| evidence | 14/14 | 14/14 | 14/14，另有 harness 自测 6/6 | 14/14，另有 harness 自测 6/6 |

- **IPC 计时竞争修好了（`80e93fc5`），见 `REGRESSION.md` §3.3 和 §9**：
  - 只在 IPC 层推进页面时钟：shell-chat 在回复的第一个块结束后 `fastForward(5000)`；两个整壳场景在 settle 之后 `runFor(5000)`。DOM、截图和 motion 不推进，基线不变。
  - 实测：流式块保存比流结束早 4.7–4.9 秒，原来只早 6–22 ms；更新检查在 5.6–6.0 秒触发，boot 窗口约 11.6–12.0 秒才结束。
  - 连跑（`--retries 0`）：C 趟构建 5/5，负载 18–25；第六轮 `fe5feb68` 的构建 3/3，同时有构建在跑，上一轮这个构建 5 次全挂；4 倍降频 2/2。D 趟构建：5/5，负载 24–36；完整运行里的那一次也通过。
  - 推进后 boot 多出 10 秒页面时间。30 秒一次的提醒轮询 `todo_list_reminders()` 因此从 `open-session` 最后挪到打字期间，`217a6680` 重录 shell-chat。余量从 3.8 秒和 2.4 秒变成 5.2 秒和 6.9 秒，4 倍降频下是 3.3 秒和 10.9 秒。
- **基线（每条一个提交，依据写在提交信息里）**：
  - `217a6680` IPC shell-chat：W16 网改动 `80e93fc5`。
  - `0bf3df25` IPC inventory：W19 `b38fb80b` 的局部更新没重写 inventory，留下 2 条已删的监听。
  - `de8d3d09` DOM shell-chat、shell-desktop（darwin + linux，cmp 一致）：W09 `086c0212`，RF-W09-english-hardcoded-labels-localized。
  - `50e4b094` IPC skills-mcp：W18 交接 29。
  - `382ed872` chunk：W26 `72b1847f` 的 `useComposerDockHeight.ts`；W09 `1c796776` 的 `settings/api.ts`；入口 +319 B 逐项归因（W26、W09 的三条已批准 RF、W17 内核不计）。没有懒加载页面变成静态导入，主构建 0 环。chunk 图只有一份文件，没法按 lane 拆成多个提交，改为在提交信息里逐项写明归属。
  - `1821e785` chunk（D 趟）：入口 +214 B 全部来自 W18。`7cce90ac` 是已批准的 RF-W18-app-menu-open-focus-race；`faa099a9` 是交接 22，让 `workbenchMenus.tsx` 经设置插件 API 取 `workbenchMode`，`settings/api.ts` 这个导出不再被摇掉。其余是 W19 FE-B8、W18 FE-B9 在懒加载 chunk 里的结构变化。
  - D 趟里 W19 自己提交了槽位基线（`103f547a`、`e920b165`，dashboard.stats / dashboard.charts）。槽位 18/18，我这边不用再动。D 趟的 DOM、IPC、截图都原样通过。
- **网的改进**：
  - `bd89b8b1` 证据 golden 不一致时，断言消息里带差异行。服务器 JSON 报告只保留消息。
  - `3cb7a1c5` 任何成功的 `--update` 都重写 inventory；自测保证 inventory 与 golden 一致。
  - `853cf447` 自测钉住全部 `unordered` 登记（R02 C 趟复核 L-1）。
  - `0ecb4864` 自测覆盖场景时钟推进、motion 判定、`regress.mjs` 的层选择、`[待审]` 过滤和退出码。`regress.mjs` 的纯函数导出，行为不变。
- **交接处理**：
  - W18 交接 29（skills-mcp）：`50e4b094`。
  - W19 chunk 图：`382ed872`（W19 `7f1d4372` 在 D 趟，见 D 趟结果）。
  - `notesTreeMenu` 6 例：`12dbc1be` 已随 C 趟进 INT，本机 6/6；B 趟分诊 F-B4 确认。W18 没有相反的期望。
  - W28 `officialUiRender`（`8dc569f1`）：`render.test.tsx` 加 4 个使用方，20/20。
  - editorExtensions 只在 Linux 红：W18 查明是旧提交的问题，修复 `e0158a10` 已在 INT；B 趟已绿。`bd89b8b1` 让以后的同类失败能直接看到差异。
  - `legacy-boot-evidence`（B 趟 F-B6，FM-12 第 4 条）：`36c9428e`。原断言是「当前冻结 JSON = 修正后的旧源码输出」，W19 `d9fc4f33` 有意改了 `main.tsx` 的一个导入，这条就不再成立。改为旧源码输出加上登记的 `LATER_CHANGES` 后必须完全相等，没用到的登记也失败。本机缺旧提交跑不了；代理验证：`d9fc4f33^` 的 16 份基线套用登记后与当前 16 份完全相同，不套用时 `normal` 不同，与服务器的失败一致。
  - `registries.ts:16` 的措辞（W18 交接 38）：交接要求等 W17 `4982ee8f` 进 INT 再改，`1d1fdb78` 里还没有，见待办。
  - F8：B 趟分诊里归 W16 路径的只有 F-B4、F-B6，都已处理；`debugPanels`、`editorExtensions` 在 B 趟是绿的。
- **DOM 快捷方式后缀竞争（未处理，交主编排裁定）**：`shell-desktop` 的 5 个桌面快捷方式 id 后缀偶发整体前移 4 位。C 趟构建 13 次启动出现 2 次，都在完整的 `dom-golden` 运行里，单独顺序启动 8 次没有。机制见 `REGRESSION.md` §9。`de8d3d09` 丢掉了一次带前移后缀的录制，重录后才提交。

### 第八轮：E 趟前端回归（开工 16:20，INT 仍是 `1d1fdb78`，起点 `8ae3be2c`）

方案（按优先级；中断后照这里接）：

1. **E 趟回归**：INT 从 `1d1fdb78` 前进后立即 `git merge --no-ff --no-edit assault/integration`，重建演示壳，`bin/heavy node tests/visual/regress.mjs --build` 跑全部层；差异逐条归到 lane 和提交。有依据的按 lane 单独提交基线；没依据的写交接。重点：懒加载页面没变静态导入、0 静态环、截图无可见回退、IPC 两处计时竞争在 E 趟构建上 `--retries 0` 连跑 5/5。
2. **W18 交接 38**：W17 `4982ee8f` 进 INT 后改 `src/ui-plugins/testing/registries.ts:16`，跑 `boot-golden.test.ts`、`render.test.tsx`。
3. **薄弱场景补 golden**：DOM 层只覆盖 12 个 `VISUAL` 场景，`research-memory`、`reading-translation`、`paper-search`、`media`、`productivity`、`data-sync` 六个单应用场景只有 IPC 的 boot 一步。在 E 趟进 INT 之前（改造前提交 `1d1fdb78`）给它们录 DOM golden（只 DOM，不进截图矩阵），`--update` 连录 3 次逐字节一致才提交；linux 那份按 §5 复制并 `cmp`，由主编排在服务器上 `run-native.sh check` 确认。
4. **网自测**：场景时钟边界（单应用场景带时钟、只有一种推进、未就绪时的推进、`sceneUrl` 拼主题）；`regress.mjs` 的层命令/环境、`motion-check` 的场景筛选与判定缺口。
5. **AL-12**：每次合 INT 看 `git merge-base --is-ancestor 4c6190f0 assault/integration`；进了就查 QuestionMaterialView 仍懒加载、入口闭包没新增。
6. **服务器分诊**：只看自己路径（legacy-boot-evidence 等服务器确认 `36c9428e`）。

进度：

- 16:25 起点 `8ae3be2c` 干净；INT `1d1fdb78` 没动；4c6190f0 不在 INT。开始构建改造前演示壳（给第 3 项录基线）。
- 16:35 第 3 项：`b7c86a83`（golden）+ `a879b04d`（网）。6 个场景各录 3 次：5 个（10 份）逐字节一致，第 4 次 `--check --retries 0` 也通过；`reading-translation` 桌面不一致（PDF 虚拟列表的第 42 页那一行 3 次里出现 2 次），列入 `DOM_EXCLUDED`。linux 那份是 `cmp` 一致的副本，等服务器确认。截图矩阵不扩（每个新场景要 4 张 darwin + 4 张 Linux 截图，Linux 只能服务器出）。
- 16:37 第 4 项：`regression-net.test.ts` 27 → 42（同在 `a879b04d`）。`regress.mjs` 拆出 `needsDemo`、`layerArgs`、`layerEnv`、`summaryLines`，`motion-check.mjs` 拆出 `motionScenes`，行为不变。
- 16:38 第 6 项：C 趟 fe 里归 W16 的只有 `legacy-boot-evidence`，报错在 `:77`（`2be7ed80` 上旧断言），`36c9428e` 进 INT 后由服务器确认（E 趟 `065a68f3` 不含 W16 `8ae3be2c`，随下一趟）。W28 的 C 趟 TRIAGE fe 段还没写。
- 16:40 第 5 项预查：`4c6190f0`（W09）只给 `QuestionMaterialView.tsx` 加 `import { getErrorMessage } from '@/utils/errorUtils'`。基线里 `errorUtils.ts` 已在入口 chunk（`index.html`），`QuestionMaterialView` 自成一个非入口 chunk、已经静态导入 `index.html`，所以预期入口闭包不新增模块。进 INT 后实测。
- 16:47 INT 前进到 `065a68f3`（E 趟）。合并 `0655576c` 无冲突。E 趟前端源码只动了 `src/ui-kernel`（`kernel.ts`、`loader.ts`、`slots.ts`、`legacy-adapters.ts`、`contracts/{menu,settings}.ts`）和 `src/ui-sdk/index.ts`；W18 `dbb4ec72` 只有测试和 golden；`[待审]` 提交 0 个。W16 `8ae3be2c`、W09 `4c6190f0` 都不在 E 趟。
- 16:50 第 2 项：`a1ac769a`，`registries.ts:16` 改为 `use an id of your own`，与 W17 `4982ee8f` 的 `legacy-adapters.ts:45` 一致。boot-golden 16/16、render 2/2，经这些注册表的 revocation、commandPlugins、workbenchPlugin、hostApps 共 18/18。
- 16:58 第 1 项：合并后 `bin/heavy node tests/visual/regress.mjs --build --base 1d1fdb78` 全部通过。

  | 层 | 第七轮交付（D 趟 `1d1fdb78`） | 第八轮 E 趟合并后（`065a68f3`） |
  |---|---|---|
  | 启动预检 | 通过，主构建 0 环 | 通过；主构建、演示壳 `--static` 都是 0 环 |
  | 槽位 | 18/18 | 18/18 |
  | DOM | 24/24 | 34/34（新增 5 个场景 10 份） |
  | IPC | 18/18 | 18/18 |
  | 截图 | 49/49 | 49/49 |
  | motion | 通过（reduce 6，no-preference 7） | 通过（reduce 6，no-preference 7） |
  | chunk | 1 违规（W18），`1821e785` 重录 | 0 违规，6 处结构变化全在 `src/ui-kernel`，入口 −117 B（内核 +248 B 不计）；`b8330ba9` 重录，`--strict` 0 变化 |
  | evidence | 20/20（14 + harness 6） | 20/20 |

  - IPC 两处计时竞争：E 趟构建上 `ipc-trace --check --retries 0 --scenes shell-chat,shell-desktop` 连跑 5/5（16:52–16:56，负载 15–21，与完整 regress 同时跑）。
  - 懒加载：253 个懒加载 `src` chunk，0 个进入口闭包，与 D 趟相同。
  - chunk 归因：`kernel.ts` +287 B 是 W17 `bc9f0f38`（RF-W17-community-i18n-strict，`065a68f3` 批准）、`1d93de80`、`57a8cbc7`；`legacy-adapters.ts` −12 B、`slots.ts` −27 B 是 W17 `4982ee8f`；社区 chunk 的 `loader.ts` +443 B 是 W17 `feb9a101`（V09 P3-4）、`1d93de80`。
  - 没有需要交接的差异：DOM、IPC、截图、槽位、evidence 在 E 趟构建上原样通过。
- 17:00 门禁：boundaries 0 违规（4051 文件）；ui-boundaries、frontend-invoke、event-emit、plugin-manifest、import-cycles 都是 0 新增、0 过期；rust-fixes 107 条 0 错误；槽位层见上表。
- 17:00 IPC 两处计时竞争在 E 趟构建上 4 倍降频（`--throttle 4 --retries 0`）连跑 2/2（16:57–16:59，负载 10–13）。INT 仍是 `065a68f3`，`4c6190f0` 未进。

## 待办 / 交接

1. **主编排（裁定）**：DOM 快捷方式后缀竞争（第七轮）。两种做法：
   - 在序列化器里把 `shortcut_<ts>_` 后面的 7 位随机后缀也掩掉，与现有的时间戳、UUID 掩码同类。这是新增归一化，按派单规则 W16 不能自己加。
   - 或者由 `desktopStore.ts` 的所有者改 `generateId`，不再依赖全局随机序列的位置。
2. ~~**W16（等 W17 `4982ee8f` 进 INT）**：`registries.ts:16` 的措辞（W18 交接 38）~~ 第八轮 `a1ac769a` 已做。
3. **W18（知会）**：notes 的 IPC 顺序变化来自 `src/ui-plugins/official/{editor,menu}/index.ts:1` 改为从 `@/ui-sdk` 导入（W18 `e0158a10`），INT 上 `dashboard`、`debug`、`learning-today` 的 `index.ts:1` 也已改为这样导入。已按时序变化登记，请确认。
4. **主代理（服务器）**：
   - 在 INT 上跑 `tests/visual/linux/run-native.sh check`，确认 skills-mcp 的 4 张 Linux 截图（显示 3）仍在阈值内。超出的话，在 INT 上执行 `run-native.sh update --scenes skills-mcp`，只提交截图。
   - W26 已进 INT，可以按 `REGRESSION.md` 第 5 节补 notes 的 Linux 基线。
   - 第七轮：在 W16 末端跑 `land-test.mjs --suite fe --filter src/ui-plugins/testing/legacy-boot-evidence.test.ts --runner direct`，确认 `36c9428e` 在有旧提交的仓库里通过。
   - 第七轮：`run-native.sh check` 确认 Linux 的 shell-chat、shell-desktop 两个场景的 DOM（`de8d3d09` 直接复制 darwin 的文件，cmp 一致），以及服务器负载下 IPC `shell-chat`、`shell-desktop` 也稳定。
   - 第八轮：同一次 `run-native.sh check` 确认新纳入 DOM 层的 5 个场景（research-memory、paper-search、media、productivity、data-sync）的 linux DOM（`b7c86a83` 直接复制 darwin，cmp 一致）。不一致就在同一提交上 `run-native.sh update --scenes <场景>`，只提交 `__golden__/dom/linux/` 里的那几份。
6. **W16（下一轮可做）**：`reading-translation` 的 DOM 不可复现（PDF 虚拟列表恢复阅读位置时，可见页之前那一行有时渲染、有时不渲染），找到可复现的就绪条件之前留在 `DOM_EXCLUDED`；截图矩阵是否扩到第八轮新纳入 DOM 的 5 个场景，要连同 Linux 截图一起由服务器出。
7. **W16（AL-12）**：W09 `4c6190f0` 还没进 INT。进了之后看 chunk 层：`QuestionMaterialView` 仍是非入口 chunk、入口闭包不新增模块（预查见第八轮）。
5. 本机环境性失败（与 W16 无关）：缺 `src/version.ts` 的 2 个测试文件；需要原服务器 git 历史的 evidence 测试，例如 `legacy-boot-evidence.test.ts`，它读取 `7f915ae5` 等提交，这个快照仓库里没有。

## 记录

- 03:02 层 1 完成并提交基线。
- 03:13 发现 Tailwind 扫描 `src/**`：测试辅助文件里的 `!shadow` 让入口 CSS 多出 311 字节 → 改写；最终用“移走辅助文件再构建”的 `--strict` 对比证明 FE-A1 的 `src/` 文件不改变产物。
- 03:25 IPC：事件名里的时间戳 id 掩码；监听注册顺序与调用次数不比较；命令顺序只在 3 次一致时强制。
- 03:35 DOM：id 全部重编号；掩码端口、时间戳、秒、实测耗时、OverlayScrollbars auto-hide class。
- 03:55 截图：OverlayScrollbars 的 auto-hide 计时导致 1 张 0.01 差异 → 截图时隐藏 `.os-scrollbar`（`screenshot.css`）。
- 04:05 三个变异全部被对应层捕获。
