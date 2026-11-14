# W19 进度（前端注册表 B：调试面板 FE-B7、仪表盘 FE-B8、learning-today）

以前各轮的进度只写在提交说明和 `.reports/agent-final/W19-*.md` 里，本文件从第 4 轮（12:35）开始记。

## 验收标准（`plans/FRONTEND-PLUGINIZATION.md` §3.2）

- **FE-B7**：45 个面板改为 `debug.panels`（仅开发构建）；业务代码改用调试通道，生产为空操作。验收：生产构建不含任何 `debug-panel/plugins` 模块；开发构建面板清单相等。
- **FE-B8**：官方卡片改由 UI 半贡献 `dashboard.widgets`；为样板插件提供落点。验收：仪表盘 DOM 与截图（桌面、移动）零差异；社区小部件追加、卸载测试。

## 已完成（前几轮）

| 项 | 提交 |
|---|---|
| `debug.panels` 槽位、45 个面板改为宣告式贡献、生产 Analysis 面板为空（11:45 已接受） | `5305eea3` 之前各轮、`2a1c94ce` |
| 7 个调试面板改在模块内接收日志，不再走 window CustomEvent | `8e583be1`、`9f053449` |
| `dashboard.widgets`（今日行 5 张卡片） | 第 2 轮 |
| `dashboard.stats`（总览 5 张统计卡片） | `6fc75089`、`9af8c1a4` |
| 调试宿主和 learning-today 的 5 处 `NAVIGATE_TO_VIEW` 改用 `dispatchAppEvent` | `548234c4` |

## 第 4 轮（12:35 起，INT `6c491e6f`）

| 项 | 状态 | 提交 / 说明 |
|---|---|---|
| 合入 INT `6c491e6f`；三个官方入口按 INT 的 `Object.assign(defineUiPlugin(...), { order })` 写法解决冲突 | 完成 | `1ebfa88a` |
| `official-slots.json` 补 `dashboard.stats`（合并后唯一红测） | 完成 | `103f547a` |
| 总览图表改为 `dashboard.charts` 槽位，宿主统一判断「暂无数据」 | 完成 | 证据 `6ec5b4c1`（7 种统计状态 × 桌面/移动/嵌入/无内核，改造前录制）；实现 `a7ae4882`；基线 `e920b165` |
| 调试面板里最后 3 条 bare-custom-event（ChatAnki 死函数、SessionLoad 改 `dispatchTypedEvent`、DragDrop 死分支） | 完成 | 证据 `64a465e0`（改造前跑绿）；实现 `addcfe7e`；ui-boundaries 391→388 |
| 反向依赖文件里直接派发的调试事件（`chatanki-debug-lifecycle` 等） | 交接 | 这些行不调用 `src/debug-panel` 的接口，属所在文件的 lane |
| `chatanki` 调试通道 `emitChatAnkiLifecycle`，供上面约 30 处改用（生产为空操作） | 完成 | `f6b5d8c9` |
| FE-B7 验收：生产构建不含 `debug-panel/plugins` 模块 | 完成 | 在 `addcfe7e` 上跑 `bin/heavy node tests/visual/lib/build.mjs main`：1200 个 chunk，`src/debug-panel/plugins/**` 0 个；生产里只有 bus、通道小桩、`debugMasterSwitch`、`pageLifecycleTracker`、`usePageLifecycle` 和 `GlobalDebugPanel` 懒 chunk 里的 `DebugPanelHost` |
| chunk 图 golden（W16，09:01 录制）对比 | 交接 W16 | 6 条违规都是已知的有意变化（W16 1208 报告已归因到 W19 `daf687e1`），入口净减 70 KB；本轮图表迁移只让仪表盘懒 chunk 多了几条引用 |
| 合入 INT `fe5feb68`（第四批）；冲突只在本 lane 新增的 `dashboard.charts`（插件入口 import、`official-slots.json`），取本分支 | 完成 | `73de451c` |
| 合入 INT `390f244b`（含 W09 `9158ab0c`、`3091cee6`），无冲突 | 完成 | |
| `todayLearning.ts:64` 改用 `dispatchAppEvent(APP_EVENTS.LEARNING_HUB_NOTES_LEARNING_VIEW, …)` | 完成 | `70d76e2d`；`todayLearning.test.ts`（钉住事件类型、构造器、detail）前后都绿；bare-custom-event 388→387 |
| CrepeImageUpload 诊断报告的 2 条 ua-sniffing 改用 W09 的 `getRawUserAgentInfo()` | 完成 | 证据 `22ca8017`（报告字段与 `environment` 原样，改造前跑绿）；实现 `3bfd6d04`；ua-sniffing 38→36 |
| 今日区标题旁的周报入口、行下方的薄弱知识点条改为 `dashboard.widgets` 贡献（`placement: header \| below`） | 完成 | `69806d9d`；today-center 三份 golden（有/无内核）与 W16 dashboard 证据原样通过；社区 header / below 贡献追加与卸载测试 |

## 第 5 轮（14:34 起，INT `390f244b`，起点 `7f1d4372`）

| 项 | 状态 | 提交 / 说明 |
|---|---|---|
| 交接收集（agent-final、reviews、lanes、handoffs、INTEGRATION-NOTES） | 完成 | 无新条目：W09 1316 的两条（todayLearning、Crepe UA）第 4 轮已做；W16 1401 的 shell-chat 基线由 W16 `5efb2c60` 重录；M2 1425 的 DebugPanelHost 词条冲突已按 W09 版本合入 |
| template designer 调试通道：证据 | 完成 | `f655d7df`：改造前录 4 例（整轮行/展开/复制、in-flight 超时 6/21/61/120 s、停用清 in-flight、激活前不记录），golden `__golden__/template-designer.*.json` |
| template designer 调试通道：实现 | 完成 | `77e63eec`：`channels/templateDesigner.ts`；处理函数与 in-flight 表移到面板模块顶层并 `serveDebugChannel`；总开关关闭时丢弃；window 监听保留到发送端迁移（交接）。证据原样通过 |
| chatanki 通道也按总开关丢弃 | 完成 | `7719acc4`（通道尚无调用方，运行时无变化） |
| 发送端 `templateDesignerDebug.ts:130-138` 改走通道 | 交接 | 在 W09（`src/features/chat/**`）路径；迁完后本 lane 删面板里的两个 window 监听 |
| ui-boundaries 剩余违规（调试面板、仪表盘、learning-today） | 交接 | 调试面板、仪表盘基线已无条目；learning-today 余 6 条 cross-feature-import（notes ×2、learning-hub ×2、workbench、flashcards），目标都在别的 lane 路径，接口设计交 W09（见报告）。注意：门禁连 `src/features/<B>/api.ts` 也算跨 feature，只能走 `src/shared/` 或 `src/ui-plugins/official/<x>/api.ts` |
| 仪表盘数据与 Tauri 对齐核查 | 完成，无前端偏差 | 13 个命令逐个对 Rust 结构体 / `json!` 键与宿主实现：get_enhanced_statistics（Rust 只回 image_stats+timestamp，其余卡片两版都是 0）、fsrs_get_stats、review_plan_get_stats/get_due、list_document_sessions（activeTasks）、mastery_get_overview、qbank_get_activity_heatmap/get_question、fsrs_get_review_statistics、pomodoro_stats_overview、study_time_range、todo_list_today、dstu_list 笔记 props（Rust node_converters.rs:185 与宿主 notes/src/dstu-node.ts:62 都给 `{}` 兜底）。测试：`b63bbc4f`（按 contracts/ipc 生成完整 Rust 形状回包 + 校验每次 invoke 的参数名）、`d65bfca3`（仪表盘对真实回包的 golden，带/不带内核） |
| 测试补强 | 完成 | 上两条 + `f19b19e7`（Crepe 拖放面板证据 8 份 golden） |
| 单文件瘦身：CrepeDragDropDebugPlugin 1179 行 | 完成 | `a106a945`：拆出 `crepeDragDrop/{model,capture,diagnosis}.ts`，组件 521 行；证据原样通过 |
| RF-W19-crepe-drag-block-handle-retry-leak | proposed | `b93c52ce`：面板关闭后 block handle 重试定时器与后挂监听器不再泄漏（Tauri 原有，修复前每秒刷日志） |
| 单文件瘦身：MultiAgentDebugPlugin 893 行 | 完成 | 证据 `feb18977`（3 个页签、复制报告、会话增删时的订阅、预设/自定义 Prompt、刷新、清空，7 份 golden；DOM 导出助手抽到 `__tests__/domDump.ts`）；拆分 `533efc73`：`multiAgent/{presets,log,useWorkspaceListeners}.ts`，组件 608 行 |
| 单文件瘦身：McpDebugPlugin 833 行 | 完成 | 证据 `cf062c4c`（全部事件、脱敏截断、节流开关、5 种过滤、复制/导出、停用重开，5 份 golden）；拆分 `ce309820`：`mcp/{model,sanitize}.ts`，组件 608 行 |
| 单文件瘦身：其余 | 不做 | MediaProcessingDebugPlugin 801 行（门槛线上）；DebugPanelHost 758、SOTADashboardLite 418 已低于 800 |
| 合 INT | 完成 | `d2c3f446` 合入 `2be7ed80`，本 lane 路径无冲突、无改动 |
| 合 INT 后的 golden 重录 | 完成 | `84cf797f`：W26 `3bafd1ad`/`a7b0562c` 让 ScrollArea 选项跨渲染稳定，主题类不再被追加到末尾；`multi-agent.{monitor,refresh}.txt` 共 4 行只变 `os-theme-deep-student` 的位置（类集合与样式相同）。拆分前（`feb18977`，893 行）与拆分后的面板对新 golden 都 4/4 通过 |

## 第 6 轮（15:23 起，INT `2be7ed80`，起点 `f75f7963`）

| 项 | 状态 | 提交 / 说明 |
|---|---|---|
| 合 INT | 无需合并 | 起点已含 `2be7ed80`；本 lane 第 4、5 轮（`7f1d4372`、`f75f7963`）和 W17 `c46d4d3d` 都在 D 趟，未进 INT |
| 交接收集 | 完成 | 新条目只有 ORCH-LOG / AUDIT-TO-LANES 的 AL-12（`emitChatAnkiLifecycle` 进 INT 后知会 W09，等 D 趟）；W17 `1d93de80`（requires 被跳过时只告警）是上一轮建议的一半，r9 在做槽位一半 |
| B 趟 fe 红：`debugPanelInventory` 「opens the same panel component from every home card」 | 负载 | 服务器 6109 ms 超 5 s 默认超时；同文件其余 4 例在服务器上也比本机慢约 10 倍。本机负载 25 时单跑 1140 ms。拆时：660 ms 中点「首页」重挂 44 张卡 395 ms、点「打开」133 ms，测试自己的查询约 85 ms，测试侧没有可省的；面板组件同步加载、无计时器。按 14:05 裁定建议 `land-test --filter` 单分片复跑 |
| B 趟 fe 红 F-B6：`legacy-boot-evidence.test.ts:77`（W28 TRIAGE 归 W19 定、W16 协助） | 交接 W16 | 起因是本 lane `d9fc4f33`（FE-B7）有意把 12 份 boot 基线里 `main.tsx` 的 `./debug-panel/plugins/DstuDebugPlugin` 导入改成 `./debug-panel/channels/dstu`，`:77`「修正后的旧源码 = 当前基线」因此必然不等。方案：测试里加 `DELIBERATE_CHANGES` 登记（逐行精确匹配、每场景至多一次、命中场景必须恰好等于登记里在测范围内的场景），`:77` 改为比较「旧输出 + 登记改动」与当前基线；`:76` 和其余断言不动。补丁 `.reports/W19-handoffs/W16-legacy-boot-deliberate-import.patch`（本机 `git apply --check` 通过、单文件 tsc 0 错误）。本机缺 `7f915ae5` 等提交跑不了，改用 base `21c9d808` 的 16 份基线验证变换：12 个场景各命中 1 次，变换后 16 份全等于当前基线 |
| Linux 风险排查：locale | 完成 | `LC_ALL=zh_CN.UTF-8` 下 3 个文件 8 例红（首页卡片 `label.localeCompare` 变拼音序；多智能体日志 `toLocaleTimeString()` 变 `09:42:00`）。`c17b997b`：`__tests__/defaultLocale.ts` 在调用方不给 locale 时补 `en-US`（原地替换，因 evidence 每例 `vi.restoreAllMocks()`），用于 inventory、multi-agent、MCP、Crepe 四个文件；zh_CN / de_DE / 默认三种都 16/16。W16 的 `debugPanels.golden` 同因红，写交接 |
| Linux 风险排查：时区 | 无问题 | `TZ=UTC`、`TZ=America/Los_Angeles` 下本 lane 30 个文件 129 例全绿 |
| Linux 风险排查：其余 | 完成 | 目录遍历：`learning-today/__tests__/ipcContract.ts` 读 `contracts/ipc` 改为排序（`0cba93fc`；1058 个命令无重名，结果不变）。计时：仪表盘 4 个测试的「5 轮 setTimeout(0)」在 0 轮时也全绿（都是微任务），waitFor/findBy 等的都是 mock 的 promise。大小写：本 lane 133 个文件 702 个导入路径与磁盘大小写一致。字体度量：测试里没有 |
| 待 W17 `70db40d5` 进 INT | 条件未到 | W17 把槽位同序号排序改成码点比较；进 INT 后 `ui-plugins/official/dashboard/api.ts:123`（无内核窗口的回退排序）跟着改用 `compareCodePoints`，保持两边一致 |
| MCP 面板 Tauri 原有问题 ①：字符串/数组详情展开成下标对象 | proposed | 修复 `ee85a5fa`（[待审]），golden `f1e8242d`（只变配置变更详情 3 处）；`RF-W19-mcp-details-char-indexed` |
| MCP 面板 Tauri 原有问题 ②：Error 首行重复 | proposed | 修复 `a70fb9e7`（[待审]），golden `9ee7bb03`（只变连接失败 error 3 处）；`RF-W19-mcp-error-message-repeated`。WebKit 的 stack 不带首行，照旧加前缀 |
| MCP 面板 Tauri 原有问题 ③（本轮新发现）：apiKey 键名规则永不命中 | proposed | 敏感键表写 `'apiKey'`，却拿小写键名比较；修复 `b17b8a88`（[待审]），golden `d3a5cb67`（只变 toolArgs.apiKey 3 处）；`RF-W19-mcp-api-key-field-unmasked` |
| 三条 RF 的测试 | 完成 | `__tests__/mcpDetails.test.tsx`：7 条 RF 测试 + 3 条对照；每条都在修复前跑红、修复后跑绿，对照前后都绿 |
| 合 INT（15:46） | 完成 | `ea8e9904` 合入 `1d1fdb78`（D 趟，含本 lane 第 4 轮 `7f1d4372`），无冲突。W17 `c46d4d3d`/`1d93de80`/`70db40d5`、本 lane `f75f7963` 仍未进 INT；W09 的 learning-today 接口和 template designer 通道也没有 |
| AL-12 | 已进 INT，待 lane 编排转告 | `emitChatAnkiLifecycle`（`f6b5d8c9`，`src/debug-panel/channels/chatAnki.ts:11`）随 `7f1d4372` 进了 INT `1d1fdb78`。W09 可把 `chatanki-debug-lifecycle` 的直接派发改为调用它：`services/templateRenderService.ts:329`、`features/chat/plugins/events/ankiCards.ts:212,356,433,474,569,804`、`features/chat/hooks/useMultiTemplateLoader.ts:85`、`components/Card3DPreview.tsx:83`（LANES-TO-AUDIT 由 lane 编排写，本 lane 不改） |
| 媒体预处理面板证据（拆分前） | 完成 | `f41ca96c`：`__tests__/mediaProcessingPanel.evidence.test.tsx` 4 例。只 mock `listen`，附件日志走真 `CHATV2_LOG_ADDED`，Store 卡片用面板自己那份 pdfProcessingStore（`vi.resetModules` 后动态取）。golden：空面板、全量一轮（6 个后端通道 + 12 种附件日志 + 2 条应忽略的）、操作（展开、三种筛选、Store 开关、暂停时监听重订 6 个、清空）、监听生命周期（隐藏时照记、`listen()` 在停用后才落定会立刻注销）；200 条上限直接断言。`LANG=C`、`LC_ALL=zh_CN`、`TZ=America/Los_Angeles` 都 4/4；去掉 `if (cancelled) fn()` 或 `stage \|\| eventType` 各自跑红 |
| 媒体预处理面板拆分（801 → 463 行） | 完成 | 每步证据不变：`1df68705` `mediaProcessing/model.tsx`（类型、阶段标签/配色、图标、上限、时间格式、ID）；`c38b6178` `mediaProcessing/chatLog.ts`（附件日志 → 事件，分支原样）；`c68c43f2` `mediaProcessing/useMediaProcessingFeed.ts`（监听 effect，逐行 diff 相同）。中文文案全留在面板文件，hardcoded-copy 基线不动；boundaries、event-emit、frontend-invoke、import-cycles 0 新增 |
| Linux 风险：`panelLogDelivery` 多智能体例 | 完成 | 本机负载 ~32 时单跑超时（5025 ms），放宽超时只跑它是 4842 ms，几乎全是例内 `import()` 多智能体面板时转译其 chat core 依赖。`4cc22594`：面板与通道改为文件顶部静态导入，转译落在收集阶段；8 例共 259–361 ms，断言和超时都没动。同类排查：路径内其余在例内动态导入的文件（debugPanels、dashboardDom、inventory、templateDesignerChannel）负载 36 时单例最长 1149 ms（F-B5 那例） |
| Crepe 图片上传面板证据（拆分前） | 完成 | `48727f28`：`__tests__/crepeImageUploadPanel.evidence.test.tsx` 4 例，经 `crepe-image-upload` 通道和总开关上报、假 Crepe 图片块。golden：空面板、全部阶段与级别（含控制台输出）、操作（选择器测试有/无编辑器、快照、Tauri 标志、五种级别筛选、暂停、清空、scrollIntoView 22 次 smooth）、复制文本与诊断报告（ISO 时间写成相对假时钟的精确偏移）、订阅生命周期（挂载前的上报丢弃、隐藏/未激活照记、总开关关时不记）。上限是 201 条（先 `slice(-200)` 再追加），直接断言。三种环境 4/4，两处变异各自跑红 |
| Crepe 图片上传面板拆分（785 → 552 行） | 完成 | 每步证据不变：`2d6b1356` `crepeImageUpload/model.ts`；`a5dc8177` `crepeImageUpload/capture.ts`（三个 DOM 采集函数，面板原样再导出，通道与编辑器测试的模块 mock 不受影响）；`39bce027` `crepeImageUpload/copy.ts`（复制文本、诊断报告）。文案留在面板文件 |
| 媒体预处理面板观察（未改） | 记录 | Store 卡片 `status.currentPage && status.totalPages` 在第 0 页时渲染出孤立的 `"0"`（golden 里 `att_pdf_6` 那张）；Tauri 同款，后端是否会发第 0 页未查实，暂不登记 RF |
| Crepe 编辑器面板证据（拆分前） | 完成 | `f3ca22b8`：`__tests__/crepeEditorPanel.evidence.test.tsx` 4 例，经 `crepe-editor` 通道和总开关上报，全局错误/拒绝走 window 事件，假 Crepe 外壳供每秒快照。golden：激活、全部分类与级别（含识别/忽略的全局错误）和快照诊断、操作（只看错误、分类芯片与下拉、级别、关键字、自动滚动、手动快照、清空）、复制与导出的 JSON、激活生命周期与健康诊断。ISO 时间和导出里的毫秒时间都写成相对假时钟的偏移；500 条上限直接断言。三种环境 4/4，两处变异各自跑红 |
| Linux 风险：日志 ID 随机段 | 完成 | Crepe 编辑器证据曾在一次运行中导出的 ID 随机段整体后移一位：ID 在 `setLogs` 的 updater 里取 `Math.random()`，React 可能多次调用 updater，计数式 mock 的取值因此依赖 React 的调用次数（插桩 4 次都是 10 次取值，未复现，但机制确定）。MCP（`McpDebugPlugin.tsx:43`）和 Crepe 拖放（`CrepeDragDropDebugPlugin.tsx:46`）证据同样记录了随机段：`bca55b9f` 改为按 `^<ts>-[0-9a-f]{1,6}$` 精确校验（比原来的前缀校验更严）、不再记录随机段；`bceaaa9b` golden 只删 36 行 `"idSuffix"`（MCP 15、拖放 21）。其余 golden 不含随机 ID；拖放面板 `Math.random() > 0.1` 的采样在 mock 下恒为保留，不受影响 |
| Crepe 编辑器面板拆分（769 → 486 行） | 完成 | 每步证据不变：`fcbb2cf1` `crepeEditor/model.ts`（类型、级别配色/图标、分类标签，`CrepeDebugEventDetail` 由面板再导出）；`4a68a549` `crepeEditor/report.ts`（feed、`emitCrepeDebug`、`captureDOMSnapshot`，逐行 diff 相同，面板原样再导出，通道的 `Pick<typeof Panel>` 与 crepe 编辑器测试的模块 mock 不受影响）；`61aa962d` `crepeEditor/diagnosis.ts`（诊断与计数，原 useMemo 体）；`099aea99` `crepeEditor/copy.ts`（复制条目、导出内容与文件名）；`6db60650` `crepeEditor/useCrepeDebugFeed.ts`（激活 effect，逐行 diff 相同）。后三步各在移出的代码里做一处变异，证据都跑红。JSX 文案和两处通知留在面板，hardcoded-copy 基线不动；import-cycles、event-emit 0 新增，boundaries 0 违规 |
| 分析面板宿主框架证据（拆分前） | 完成 | `f061c549`：`__tests__/debugPanelHostFrame.evidence.test.tsx` 10 例，假面板无内核宣告、每例新宿主模块，几何按宿主公式对每个视口给精确数值：存储的位置/尺寸及缺失、类型错、JSON 坏时的回退；挂载与窗口 resize 时夹到视口（不回写存储）；标题栏拖动、右下角缩放（主键或触摸，标题栏按钮内按下不起拖，只在 pointerup/pointercancel 保存，最小 360×240、无上限）；网格列数按面板宽 680/1100 分档；双击复位（不保存）、折叠/展开；首页分组、收藏置顶再按 locale 标签序、收藏持久化、去空格不分大小写的标签/描述搜索；激活持久化，已激活面板在别的面板打开时保活隐藏、回首页时卸载；`?debug-plugin=` 优先于 `DSTU_DEBUG_PLUGIN`、晚到面板只接一次；总开关关时不渲染任何面板；隐藏保活；portal 元素；标题栏动作。五种环境 10/10；10 处变异 9 处跑红（第 10 处「请求 home 时忽略」在没有叫 home 的面板时等价） |
| 分析面板宿主拆分（758 → 492 行） | 完成 | 每步证据与 inventory / production / 官方 debugPanels 不变：`1697a66c` `host/panelList.ts`（`useDebugPanels`、`HOME_PLUGIN_ID`、分组）与 `host/CommunityPanel.tsx`；`59af5d1f` `host/useFloatingFrame.ts`（位置/尺寸、拖动缩放、夹紧，程序切出原文）；`2b4c308d` `host/usePanelPreferences.ts`（收藏、激活）。`import('./panels')` 的 DEV 闸留在宿主；后两步各在移出的代码里做一处变异，证据跑红。hardcoded-copy、import-cycles、ui-boundaries 0 新增，boundaries 0 违规，ESLint 仍是原有 25 条字号告警 |
| 题目导入面板证据（拆分前） | 完成 | `25aa2bfa`：`__tests__/questionImportPanel.evidence.test.tsx` 6 例，只 mock `listen` 与剪贴板，前端上报走 `question-import` 通道。按后端真实顺序发一轮导入（预处理、渲染、OCR、配图、结构化、会话创建、两块解析、完成、未知类型、空 payload）。golden：展开详情的整轮渲染、统计行、复制文本。直接断言：会话汇总各耗时；会话前事件记在「?」下（列表隐藏 `sid=?`，复制文本保留 9 行）；「?」在 START+195000ms 那次检查才报卡住（180000ms 那次差 45 ms）且只报一次；失败导入无结构化耗时；第二次导入的会话前事件落到上一个会话；级别/阶段前缀/搜索（小写不去空格）；剪贴板失败走 execCommand；下载文件名与内容；清空连追踪器一起清；隐藏/未激活照记、停用期间不刷新；监听注册失败；3000 条上限。六种环境 6/6；12 处变异全部跑红（初版卡住阈值改 200 s 未红，已把断言收紧到具体那次检查） |
| 题目导入面板拆分（751 → 338 行） | 完成 | 每步证据与 ExamSheetUploader / QuestionSourceRangePicker（模块 mock `emitImportDebug`）不变，逐行 diff 相同：`bed241e8` `questionImport/model.ts`（类型、级别配色/图标、阶段标签，类型由面板再导出）；`475e004d` `questionImport/log.ts`（日志收集器、`pushImportLog`、`emitImportDebug`，面板再导出，通道 `Pick<typeof Panel>` 不受影响）；`b938cc4d` `questionImport/progress.ts`（会话追踪、卡住检查、`question_import_progress` 监听，三者共用可变的 `currentImportKey` 故放一起；模块加载顺序不变，移出后再做卡住阈值变异仍跑红）；`3faca9c5` `questionImport/copy.ts`（时间格式、详情展开、复制文本）。JSX 文案留在面板，hardcoded-copy 基线不动；import-cycles、event-emit、frontend-invoke 0 新增，boundaries 0 违规 |
| 题目导入面板观察（未改） | 记录 | ① 按 `contracts/ipc/L14-qbank.json`，进度事件里只有 SessionCreated / Completed / Failed 带 `session_id`；而 Rust 先发预处理、渲染、OCR（`question_import_service.rs:435` 早于 `:511`），面板把它们记在「?」或上一个会话下：汇总里「预处理=?ms OCR=?ms」，「?」3 分钟后误报卡住，第二次导入的前段计入上一个会话。根治要在事件契约里给所有变体带上 `session_id`，不在本 lane 路径；面板内按启发式合并会话风险大，暂不登记 RF，待裁定。② 文件头写的「进度百分比回退」检测从未实现（只记录 `lastPercent`，`anomaly:progress-regress` 无发射点）。③ 阶段筛选「完成/失败」的值是 `backend:completed`，失败条目筛不出来。④ 搜索不去空格（仅全空白时忽略）。都是 Tauri 原样 |
| L04 复核 `f75f7963` 的回应 | 完成 | F1（多智能体 golden 依赖进程 locale）本轮已由 `c17b997b` 固定 en-US（早于 16:12 把该文件切给 W36，W36 从 `f75f7963` 起分支，r7 合 W36 时这里会重叠，以一边为准即可）；本轮之后不再动该文件，F11（首例冷启动）留 r7。F9：`5dbc3e94` 命令表遇同名直接抛错并报两个文件（今天 0 个重名；注入一个重名时按预期报错）。F4：`37caa3e0`（[待审]）登记 `RF-W19-debug-channel-records-while-closed`（deliberate、proposed），新增 `__tests__/debugChannelWhileClosed.test.tsx` 2 例，含「关闭期间记下的进行中调用在打开后第一次扫描即报超时」；任一通道处理函数改回丢弃、去掉 ChatAnki 总开关判断都各自跑红；面板只加 `RUST-FIX` 标记注释 |
| F-B6 legacy-boot-evidence | 已由 W16 处理 | W16 `36c9428e` 在 `legacy-boot-evidence.test.ts` 给 `d9fc4f33` 登记了一条 `LATER_CHANGES`，本 lane 先前给 W16 的补丁作废。以后本 lane 再有意改 boot 基线，同一提交里写交接请 W16 往 `LATER_CHANGES` 加一条 |
| W16 `0bf3df25` | 记录 | 本 lane `b38fb80b` 局部更新时没重写 IPC `inventory.json`，留下 2 条已删的监听，W16 已补；以后改监听时重写 inventory |
| 未注册的面板文件（待裁定，未改） | 记录 | 7 个文件共 3624 行没有任何生产或开发导入方，base `21c9d808` 起就如此（Tauri 时代已断开），也没有测试：`ChatAnkiParseDebugPlugin`、`DeleteRenderMonitorPlugin`、`StreamResponseMonitorPlugin`、`StreamingDebuggerPlugin`、`ThinkingChainDebugPlugin`、`TimelineSourceMonitorPlugin`、`UserMessageContentTrackerPlugin`（它监听的 `debug:user-content-pipeline` 全仓只在自己的注入指南文本里出现）。删除或接回属产品决定，请 lane 编排裁定；未裁定前不为它们写证据或拆分 |
| 宿主观察（未改） | 记录 | 首页「结果：N 个」把不在任何分组里的面板也算进去（证据里 5 个面板只显示 4 张卡；搜到它时同时显示「结果：1 个」和「未找到匹配的插件」）。测试用 i18n mock（`tests/ct/mocks/react-i18next.tsx`）在给了字符串默认值时直接返回默认值，所以测试里关闭按钮是「关闭」、应用里是资源的「关闭调试面板」 |
