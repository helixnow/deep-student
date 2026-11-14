# 前端插件化 F1 独立验收（R6）

## 结论与基线

**2026-11-04 当前结论：整体F1仅余两项政策未决，暂不签整体通过。** 正常main `ad11a8394`联合复核已补齐，R6-06关闭；01/04/05/07/08/09/10维持关闭。仍待R6-02新增sidebar后补取证例外、R6-03主窗口异步首帧政策。各项闭合均限报告固定实现与证据，不宣称截图通过。

- 工作树/分支：`/home/dsdev/dev/ds-mig/R6-review-frontend` / `ds-mig/R6-review-frontend`。
- 实现快照：`e303957124ac220f55bee1b04cca5d3937983b92`（提交时间 `2026-11-04T13:17:58+08:00`）。
- 初审时 `ds-mig/U1-ui-boot`、`ds-mig/U2-ui-shell`、`ds-mig/U3-ui-settings`、`ds-mig/U4-ui-content` 均指向该快照；逐分支 `git diff --stat e30395712 <ref> -- src docs/plugins` 均无输出。
- 指定规格 `docs/plugins/FRONTEND-F1.md` 不在快照中，`git log --all -- ...` 亦无历史；C1 已提交分支的 `docs/plugins/` 中也没有此文件。现有 `FRONTEND.md` 只有 F0/F1 总体方案，没有所要求的“§1 第3条命令清单”。
- 已读现有实现和 F0 测试；仅编辑本文件及 [R6 汇总](../../docs/dev/electron-migration/audits/R6-review-frontend.md)。亲跑命令和输出见汇总。

## 必须修复 / 补齐（由 C1 协调派回）

| 编号 | 状态 | 证据与验收缺口 | 派回及复核条件 |
|---|---|---|---|
| R6-01 | [x] | 规格发布提交 `40e885f89` 已随 main 合入；本树合并提交 `040ee0464` | 按工作树 §1.1：U1 golden 在 `testing/__golden__/boot/`，不要求 official/boot |
| R6-02 | [ ] | U1按§6.4五处旧源补救已核实；U2取证已核；U3首次/搜索修订及U4两入口/CodeBlock取证已核。唯U3 sidebar补证40480bb9c晚于d89a447b0改造，32组可复现但时序不合原§1.1 | C1/架构师裁定U3新增侧栏的后补证例外；不擅自套用仅指U1的§6.4 |
| R6-03 | [ ] | U1 origin及领域glob联合装配已亲跑；轻量窗不装配现为§6.1要求，Markdown/CodeBlock无Provider静态表通过。main仍BootShell→await getUiKernel→首App，demo同样await后首render | §6.1异步首帧官方静态表要求尚未满足/裁定；C1已上报，不把最终内核就绪当同步首帧 |
| R6-04 | [x] | U2真实App与导航接线已核；四个获授权原测试接共享helper/真实表达式断言，原45+13+8+4项全部通过，无旧52缺Provider/2源码断言失败 | 关闭本编号的接线和原测试装配缺口；不是整体F1或所有浏览器行为签收 |
| R6-05 | [x] | U3 `1ef5caf97`/`6eca3b07d`两个消费方均传完整entries，导航/分类图标按origin包装，builtin引用及错误传播保留；旧WIP重名/传值缺口已修 | R6作业20261104124312-dbe568：4文件9项通过；20261104124348-7c2097：tsc退出0。02时序例外独立保留，不授整个lane完成 |
| R6-06 | [x] | 正常main ad11a8394已含四领域已审实现、loader和05修复；前端tsc、最小新增loader/图标测试、两8GB构建全退出0；原十入口及无差异golden复用R6独立证据 | 关闭内容与正常联合门禁缺口；五页面仍不在入口静态闭包。02/03政策与浏览器截图不在此签收范围 |
| R6-07 | [x] | 基线环境阻塞已排除：生成/tsc成功，目录基线97文件802项通过；主构建及demo在8GB堆均退出0，原4GB OOM记录保留 | 仅关闭初轮环境阻塞；五页面旧chunk基线已记录。F1候选的集成门禁仍随各lane交付复核，不授予F1通过 |
| R6-08 | [x] | `3e28111d4` 单独修订取证，`06d8e8c27`解释原因/去重录开关；旧源码固定e30395712，真实launcher数组、session/title四组合、32环境、160导航结果可复现；其后golden未改 | `75c6343f0`真实slot/当前App对照亲跑通过，作业`20261104070627-16f964`退出0；仅闭合本编号 |
| R6-09 | [x] | U2 ea2c67c28按§6.2提供默认placement/可选icon/官方后排序；App三处入口消费resolveShellView，注册新key不再退chat；两真实导航+实际App表达式通过 | 作业20261104083441-8b2560退出0；官方/别名语义golden仍通过、冲突拒绝/卸载回退已验证 |
| R6-10 | [x] | U1每次安装origin经真实fiber传到slot；官方installer builtin、loader/default community；U2只按origin隔离。同官方ID替换在实际桌面/移动导航中抛错仍保标签/邻项/动作 | origin与实际导航覆盖/卸载/重装测试亲跑通过；不把此关闭外推到U3导航图标 |

这些编号固定保留。修复后在本表勾选，并追加“编号 → 修复提交 → 实际生产入口 → 亲跑命令/结果”；仅有 lane 自报通过不能闭合。

## 逐 lane 证据覆盖（首轮历史快照）

| Lane | 审读基线 | golden 早于改造且覆盖全部条目 | 真正的新旧对照测试 | 新元数据 / 消费点 | 本轮状态 |
|---|---|---|---|---|---|
| U1-ui-boot | `e30395712` | 无提交，不能验证 | 无 F1 测试 | F0 内核/加载器已存在，生产启动未接 | 待交付 |
| U2-ui-shell | `e30395712` | 无提交，不能验证 | 现有导航函数测试不是 F1 对照 | 无 | 待交付 |
| U3-ui-settings | `e30395712` | 无提交，不能验证 | 现有 hook/导航测试不是 F1 对照 | 无 | 待交付 |
| U4-ui-content | `e30395712` | 无提交，不能验证 | 无 F1 测试 | 无 | 待交付 |

F0 历史提交为 `3331c9597`（内核）、`f0087ca42`（加载器/共享依赖/远程代理）、`5fc608a69`（社区示例）。这些不能冒充 F1 改造前 golden。

## U1：启动分支基线（首轮历史清单）

| 原入口 / 条件 | 原行为 | 新接线表达 |
|---|---|---|
| main.tsx:461-475 | 轻量窗口独立应用字体；PomodoroMini / QuickAssistant 动态加载并独立 root.render | 未交付 |
| main.tsx:478-500 | startup-conflict / startup-preflight-failure / core-migration-failure 三种调试恢复壳 | 未交付 |
| main.tsx:509-556 | 先 BootShell；恢复检查和 maintenance 并发；recovery_required 进恢复壳；核心 vfs/mistakes/maintenance_status blocked 进组件恢复壳 | 未交付 |
| main.tsx:559-590 | 正常启动或纯 Web 预检失败进入 appTree，按环境包 StrictMode，再 startNormalFrontendRuntime；Tauri 预检失败只进恢复壳 | 未交付 |
| demo/main.tsx:83-134 | 先准备 mock，再动态加载 App 和 provider；desktop 条件预热/装配 | 未交付 |
| demo/app/main.tsx:56-94 | 单应用演示自己的启动与动态 provider 入口 | 未交付 |

没有生产内核挂载，因此尚不能判断 F1 会不会提前加载业务页面、在恢复/辅助窗口误启动插件，或改变 demo 的 mock-before-import 顺序。

## U2：全部 CurrentView 对照

旧值来自 `e30395712` 的 `src/types/navigation.ts:11-28`，视图层顺序来自旧 `src/App.tsx:1759-1807`。新表达列更新至 U2 `518071df8`：全部经 App:1410-1427 的 `viewContents` / `registeredViewLayers` 实际消费；保留旧内容 hook 及其 props。

| 旧视图（按原渲染顺序） | 原内容/条件与必要语义 | 新表达 |
|---|---|---|
| dashboard | LazySOTADashboard；overflow-hidden；小屏不套 CustomScrollArea；canonicalize 实际重定向到 data-management | views.dashboard → dashboardContent；extraClass保留 |
| settings | LazySettings，isActive；返回 chat-v2；overflow-hidden | views.settings → settingsContent；extraClass保留 |
| task-dashboard | lazy AnkiTasksApp；导航会话事件、打开聊天、清除选择模式再开模板 | views.task-dashboard → taskDashboardContent |
| skills-management | LazySkillsManagementPage | views.skills-management → skillsManagementContent |
| data-management | LazyDataImportExport + LazyImportConversationDialog；保留 open/onOpenChange/onImportSuccess | views.data-management → dataManagementContent |
| template-management | LazyTemplateManagementPage；isSelectingMode/onTemplateSelected/onCancel/refreshToken | views.template-management → templateManagementContent |
| ui-lab | uiLabEnabled 才渲染；关闭时跳 chat-v2；MobilePageScaffold | views.ui-lab → styleDebugContent；visible(uiLabEnabled) |
| learning-hub | LazyLearningHubPage；资源处理器/内部导航接线 | views.learning-hub → learningHubContent |
| media | LazyMediaStudioPage，isActive | views.media → mediaStudioContent |
| sandbox-workbench | LazySandboxWorkbenchPage + MobilePageScaffold | views.sandbox-workbench → sandboxWorkbenchContent |
| pdf-reader | LazyPdfReader + MobilePageScaffold；LRU 软保护 | views.pdf-reader → pdfReaderContent |
| todo | LazyTodoPage | views.todo → todoContent |
| flashcards | LazyFlashcardsPage，isActive；闪卡中心共享入口 | views.flashcards → flashcardsContent |
| crepe-demo | DEV 才渲染/加载，返回 settings；MobilePageScaffold | views.crepe-demo → crepeDemoContent；visible(dev) |
| chat-v2-test | DEV 才渲染/加载，LazyChatV2IntegrationTest | views.chat-v2-test → chatV2TestContent；visible(dev) |
| llm-playground | DEV 才渲染/加载，LazyLLMOutputPlayground | views.llm-playground → llmPlaygroundContent；visible(dev) |
| chat-v2 | 默认/pinned；chatV2Blocked 时 FeatureUnavailablePanel，否则 LazyChatV2Page | views.chat-v2 → chatV2Content |

内容证据：`src/app/hooks/useViewLayerContents.tsx:35-184`、`src/App.tsx:1350-1395`。所有经典层由 `renderViewLayer` 传 `errorBoundaryName=view`，`ViewLayerRenderer.tsx:40-108` 负责未访问不渲染、隐藏/退出动画、错误 fallback。

### 跨视图条件及元数据复核落点（首轮清单）

此表保留首轮待交付状态；最新 U2 壳字段已消费的位置和原样保留的业务处理，见文末“App 条件 → 实际消费位置”，不再据本表判定当前 App 未接线。

| 原分支 / 来源 | 必须保留的行为 | 新表达 |
|---|---|---|
| App:621-655 | canonicalize 后 demo 只接受 chat-v2；实际切换才发 VIEW_SWITCHED；transition 内更新栈/LRU/view | 未交付 |
| viewRouting.ts:10-33,73-110 | chat-v2 pinned；pdf-reader 延后淘汰；桌面8/触屏4；目标不淘汰 | 未交付 |
| App:665-675 | 记录闪卡最近分区，发布 committed view；learning-hub/chat-v2 切换 active resource handler | 未交付 |
| App:779-829 | 桌面已启用或当前聊天时不由经典壳接管媒体引用；DEV 测试入口；通用导航仅变更时切换，LH 的 openResource 仅经典壳兑现 | 未交付 |
| App:863-875 | Android 返回先历史；无历史且小屏非 chat-v2 时回 chat-v2，否则不消费 | 未交付 |
| App:885；useDesktopTitlebarInteractions.ts:103 | 非聊天视图可返回聊天；新建会话先切聊天 | 未交付 |
| App:958-961 | 非 task-dashboard 来的模板导航清理选择状态/回调 | 未交付 |
| App:1064,1105-1117,1152-1154 | LH 页返回；settings/todo/LH/其他对应不同侧栏；settings/todo 返回和折叠开关条件 | 未交付 |
| App:1561-1615 | LH/todo/skills/media toolbar；chat 有会话及标题才显示编辑器；其余标题；闪卡三分区显示 tabs | 未交付 |
| App:1743-1755 | settings CSS；workbenchActive 时使用独立 lazy 桌面替换经典层 | 未交付 |
| useShellViewChrome.ts:18-56 | chat 用当前会话标题（允许空）；全部17视图标题键；闪卡三分区共标题；仅小屏显示移动 tabs | 未交付 |
| useViewRedirects.ts:12-38 | 恢复回执 → settings/data-governance/recovery；UI Lab 关闭 → chat-v2 | 未交付 |
| useViewScrollRestoration.ts:11-33 | LH/settings/skills/tasks/templates 五类保存滚动并延迟100ms恢复，退出清理 | 未交付 |
| useUnifiedNavigation.ts:24-136 | LH/files 内部历史与页面历史优先级；页面抵达 LH 标记；files 见底不切换经典视图 | 未交付 |
| useClassicToWorkbenchHandoff.ts:26-36,61-105 | 模式 false→true 且非移动平台；descriptor 优先，chat 有 session 才交接，否则9项映射；先动态注册再 launch | 未交付 |
| DesktopShellHeaderPortal/SidebarPortal | 当前视图才 portal；聊天头独立判断 | 未交付 |
| canonicalView.ts:7-62 | 旧别名映射、13个常规 canonical 值、3个 DEV 值、未知回退 chat-v2；dashboard 虽有原层但不是常规落点 | 未交付 |
| cardsHub.ts:30-33,51-99 | 复习→制卡→模板顺序、最近分区/组内高亮/组内点击保持当前分区/方向 | 未交付 |

### 导航键 / 图标 / 顺序基线

来源 `src/config/navigation.ts:55-108`；前缀 `sidebar:navigation.`。表顺序即原顺序；当前 U2 候选的真实 slot 对照与带Provider的导航回归已通过，社区默认契约及错误边界另见09/10。

| view | key 后缀 | icon | fallback / 条件 |
|---|---|---|---|
| chat-v2 | chat_v2 | StudyChatIcon | 新会话 |
| learning-hub | learning_hub | StudyBooksIcon | 资源库 |
| media | media | StudyMediaIcon | 音视频 |
| todo | todo | StudyTodoIcon | 无显式 fallback |
| skills-management | skills_management | StudyMagicWandIcon | 技能管理 |
| flashcards | flashcards | StudyCardsIcon | 闪卡；代表三个分区 |
| ui-lab | ui_lab | StudyBlocksIcon | 仅 includeUILab |
| settings | settings | StudySettingsIcon | 设置 |

移动 launcher 另有固定顺序 `chat-v2, learning-hub, media, todo, skills-management, flashcards, data-management`（同文件119-127）；不能拿桌面列表直接替代。标题键以 `useShellViewChrome.ts:24-42` 为准，不能一律复用侧栏键。

## U3：全部设置分区对照

来源 `useSettingsNavigation.ts:85-225`（按原扁平导航顺序），键前缀 `settings:tabs.`；内容来自 `Settings.tsx:1368-1573,1732-1738`。**每行的新 settings.sections 表达均未交付**。

| tab | title key 后缀 | icon | 原内容 / 特殊条件 |
|---|---|---|---|
| apis | api_config | Robot | ApisTab；供应商/模型编辑与移动详情 |
| models | model_assignment | Flask | ModelsTab；配置、可用模型及分配回调 |
| general | general | SlidersHorizontal | GeneralTab |
| voice-input | voice_input | Microphone | VoiceInputTab，assigned model |
| memory | memory | Brain | MemoryTab |
| workbench | workbench | SquaresFour | WorkbenchTab；移动端导航/搜索隐藏且历史 tab → apis |
| appearance | appearance | Palette | AppearanceTab；字体/缩放/主题回调 |
| automation | automation | ClockCountdown | Automation → SubagentProfiles → SuperAgent 三段顺序；Tauri listen 条件 |
| mcp | mcp_tools | Plug | McpToolsSection；loading 条件、工具/策略/预览面板 |
| search | external_search | Globe | ExternalSearchTab |
| plugins | plugins | PuzzlePiece | 移动端导航/搜索隐藏；直接选中显示 settings:plugins.mobile_hidden |
| statistics | statistics | ChartBar | DataImportExport embedded=true/mode=stats |
| data-governance | data_governance | Shield | DataGovernanceDashboard，tabTarget |
| params | params | Wrench | ParamsTab；stream timeout/auto-cancel 回调 |
| document-processing | document_processing | FileText | DocumentProcessingTab |
| shortcuts | shortcuts | Keyboard | 移动端导航/搜索隐藏，但原 render 分支没有平台 guard；不能随意更改 |
| about | about | BookOpen | AboutTab；独立 footer，不属于6分类；非 mobilePageMode 的附加头条件 |

分类顺序及成员（同 hook:235-272）：`ai=[apis,models,params]`；`experience=[general,appearance,workbench,shortcuts]`；`personalization=[voice-input,memory]`；`integrations=[mcp,search,plugins]`；`workflow=[automation,document-processing]`；`data=[statistics,data-governance]`。这些顺序不同于扁平 groups，须分别对照。

另需保留：`Settings.tsx:448-470` 离开 apis 自动分配、移动 workbench 重定向；modelEditor/vendorConfig/mcpTool/mcpPolicy/mcpPreview 移动面板分支（519-535、664-679、1752起）；搜索详情与 section 合并去重（hook:275-371）、tourId/mobileDescription/mobileAccent。当前缺规格，尚不能断定哪些要转入元数据、哪些按规格保留在宿主，但等价性证明不能遗漏。

## U4：内容条件对照

### Markdown

| 原入口 / 条件 | 原行为与顺序 | 新表达 |
|---|---|---|
| MarkdownRenderer.tsx:771-784 | disableIndentedCode → normalizeFullWidthPunct → convertMathCodeBlocks → remarkMath → inlineSmiles → remarkGfm → 条件 citation → extraRemarkPlugins | 未交付 |
| 同文件786-792 | rehypeRaw → sanitize(schema) → 非空搜索 query 的 highlight | 未交付 |
| 同文件839-878 | math/latex 完整语言边界、display/inline、裸 LaTeX 检测、普通 inline code | 未交付 |
| CodeBlock.tsx:384-400 | 大小写归一；mermaid、svg、html/htm、xml；SVG/HTML 自动预览，其余手动运行 | 未交付 |
| 同文件390-397 | charts:vega-lite/vega；graphviz:dot；music:abc；timing:wavedrom；chemicalFiles:mol/molfile/sdf；molecular3d:pdb；geojson:geojson | 未交付 |
| 同文件403-449 | 流式 SVG/HTML 行为；内容变更重置手动预览；能力关闭时退出 rich renderer | 未交付 |
| MarkdownRenderer.tsx:906-1008 | inline smiles 能力开关及坏编码回退；research/mindmap/qbank/media/普通 citation 分支与图片条件 | 未交付 |

原 `CodeBlock` 的 MermaidErrorBoundary 只能证明原渲染路径已有局部保护，不能证明新社区 renderer 也被隔离。

### DSTU 菜单（初审背景材料；指令1纠正：不是 F1 的 U4 入口）

来源 `src/dstu/contextMenu.ts:77-281`，顺序如下，键前缀 `dstu:menu.`；未知资源类型直接 `[]`。新贡献和消费表达全部未交付。

| id | key 后缀 / icon | 条件及动作 |
|---|---|---|
| customItems + custom-separator | 调用方给定 | 非空时最先插入 |
| open | open / ExternalLink | showOpen（默认true）且非 folder；openResource |
| edit | edit / Edit | 上一条件且 editable；openResource(mode=edit) |
| reference | referenceToChat / MessageSquarePlus | referenceable；handler，无 handler 记 warn |
| separator-1 | 空 | 已有任何 item |
| copy | copy / Copy | copyable；handler 优先，否则 dstu.copy(path,path+'_copy')，保留成功/失败日志 |
| move | moveTo / FolderInput | movable；openMoveDialog |
| rename | rename / PenLine | movable；startRename |
| share | share / Share2 | shareable；shareResource |
| export | export / Download | exportable；exportResource |
| separator-2 | 空 | 任一 copyable/movable/shareable/exportable |
| separator-3 + delete | delete / Trash2 | deletable；按末项是否 separator 插入；destructive；confirmDelete 缺失时 warn 且不删除 |

最终去除所有尾部分隔符。快捷菜单（290-343）仅 open/reference/delete，缺 handler 静默；批量菜单（353-421）空数组返回空、共同 referenceable/movable/deletable 分别产生 batch-reference/batch-move/batch-delete，顺序及 separator 固定；引用/删除逐项 await，原 batch-move 只记录日志。此段不构成对 U4 的迁移要求；实际验收入口补列于文末。

## 懒加载、真实比较与错误隔离

- **已核实的源码事实**：`lazyComponents.tsx:75-176` 页面均用动态 import；LearningHub 深路径有避免 barrel 静态合并的注释；DEV 页面生产返回空 lazy；`App.tsx:21-28,171-173` 的云存储/制卡/桌面亦 lazy；`Settings.tsx:149-167` 的19个分区组件用 React.lazy；`ui-kernel/bootstrap.ts:8-13` 动态导入四个适配注册表。
- **尚不能核实的 F1 结论**：首轮无新注册入口且构建在生成 chunk 前失败；续审 U2 候选入口未静态导入页面，8GB旧基线构建也已取得五页面独立chunk并确认不在入口静态闭包中（见汇总）。仍无 F1 集成候选产物，不能宣称前后体积/依赖图等价。
- **真实测试而非自证的部分**：kernel.test 实际 install/unload 后读取生产 SlotStore；loader.test 实际 sync，只有模块导入被替换，验证坏 id/空导出/import 失败；community-example 实际 Host profile、invoke、UI install、DOM 渲染和卸载。分别8/6/3项亲跑通过。
- **证明边界**：这些是 F0 功能测试，没有加载旧实现和 F1 新实现作比较；示例自己构造 `UiKernel({invoke})`、手写 Host 消费 view slot，没有挂实际 App/Settings/Markdown/Menu。不能据此勾选 U1 接线或 U2–U4 消费端错误隔离。
- 本轮还跑了旧导航与设置平台 hook 测试，汇总68项通过；其中 `androidBackCoordinator.order.source.test.ts` 的9项仅源码断言，不算行为对照。设置 integration 的生产导航组件有真实 click/assert，但本次因缺 version 导入而未收集。

## 建议

1. C1 派回时同时附 golden 提交和改造提交，避免只交最终快照后无法验证取证时序。
2. 对照测试的 expected 应来自固定旧输入/输出或旧实现，实际值经官方注册和真实消费端取得；不可从新元数据生成两边再比相等。

## 已核实

- [x] 固定四 lane 初审提交；实现差异为空，未误把 F0 算作 F1 完工。
- [x] 列出17个 CurrentView、17个设置分区及其原条件、导航键/图标/顺序、Markdown/菜单分支基线。
- [x] F0 安装/卸载、加载失败隔离和社区示例17项测试通过。
- [x] 亲跑基线类型检查、定向测试与演示构建；失败按真实原因记录于汇总。
- [x] 取得 F1 规格 §1 第3条完整命令；运行结果见汇总续审章节。
- [ ] 四 lane golden 时序/覆盖、真正前后比较、元数据等价、chunk 等价、社区消费端错误隔离：待交付复核。

## 协调者指令1：规格定位与增量审读

按明确授权只读 `/home/dsdev/dev/deep-student/docs/plugins/FRONTEND-F1.md`（59行、§0–§5），没有复制或修改。初审“文件不存在”的证据仅描述当时本工作树/已提交历史；现在不再是等待实施的理由。main 尚未包含此文件，当前未合并 main。执行规格的版本生成/构建会产生派生文件，这些不作为实现修改或交付文件提交。

### 已提交部分的固定基线

| Lane | 本次候选 | 已核实 | 尚缺 |
|---|---|---|---|
| U1 | `8597b23f2599edbc48e6ac37cd0c07cf2a4fe283` | 仅增加 U1 审读文档，原 boot 未改 | §1 JSON及提取测试、启动接线 |
| U2 | `9d5f9d1cbe019b2fa3b15d87a51cc503f1b4a5a6` | 父提交 `6beac2e744fe1ed9e941df9faedb079d28729afc` 只含取证文档/JSON/测试；祖先检查退出0；随后新增 contract/index/RegisteredViewLayer，golden diff为空 | 生产消费、slot 对照、完整覆盖；R6-08 |
| U3 | `e303957124ac220f55bee1b04cca5d3937983b92` | 仍无独立提交 | 全部 F1 交付 |
| U4 | `25f9c1714a2a23c3d5e57ae874403fcee95b61d4` | 仅增加 U4 文字取证；菜单条件/动作时序与下方独立源码审读一致 | §1 JSON及提取测试、slot 及消费 |

### U2 WIP：原分支 → 新字段（静态核对，不等于已接线）

候选 `official/shell/index.ts` 的17个视图 id、contentKey、titleKey、extraClass 顺序与上方基线一致；赋 `order=(index+1)*10`、`keepAlive=true`。三个 DEV 分支均由 `visible({dev})` 控制；UI Lab 用 `visible({uiLabEnabled})`。无页面静态 import，OfficialViewContent 仅返回宿主已有 content。

| 原条件 | 候选字段 | 核对结果 |
|---|---|---|
| settings/todo/LH/其他侧栏 | shell.sidebarKind=settings/todo/desktop-page/main | 值相符 |
| LH 返回 | pageBackButton | 仅 LH=true |
| settings/todo 标题栏返回 | sidebarOwnsBackNavigation | 二者=true；折叠组合尚待消费者 |
| settings 展开时隐藏 toggle | hideExpandedSidebarToggle | 仅 settings=true |
| 四种页头 portal | toolbarSlot | skills/LH/media/todo 原槽名相符 |
| chat 标题编辑器 | chatHeader | 仅 chat=true；session/title 联合条件尚待消费者 |
| 闪卡三分区 tabs | cardsHubTabs | tasks/templates/flashcards=true |
| settings 根 class | contentClass | settings-view |
| 移动无历史回主页 | mobileBackToHome | 默认true，chat=false |
| demo 导航只接受 chat | allowInDemo | 仅 chat=true；是否消费尚未证明 |

9个 nav 贡献将 data-management 放在 ui-lab 后、settings 前；过滤 desktop/mobile 后分别能恢复原桌面/移动顺序。已静态核对图标、fallback、移动短标题/aria-label，以及 chat 的 desktop action=new-session/omitFallback 与 mobile 导航差异。`RegisteredViewLayer.tsx` 复用 ViewLayerRenderer 并 memoize children，但错误边界是否实际传入仍需消费者测试。

`shell.golden.test.ts` 在该候选仍调用 `extractLegacyEvidence()`，未 import UiKernel 或 shell 插件。这是有效的“改造前提取测试”，**不是已完成的改造后对照**。不能因旧源码仍在而通过就认定新元数据正确。

R6-08 的具体依据：`legacyEvidence.ts` 第60行的 mobileItems 使用 `Object.keys(shortLabels)`；实际 MobileSidebarNavigation:114-120 使用 `MOBILE_APP_LAUNCHER_VIEWS.map`。第102-106行环境输出以手写 workbench/demo 条件构造；第93行以单个 hasSession 同时控制 sessionId/title，漏掉一有一无的两个可达组合。golden 第一组 dev=false 的 navigable 仍列 dashboard 和三个 DEV 页面；旧 canonicalize 会分别映射 data-management 或 chat-v2，不能把“原始入参名”当“最终可达视图”。需明确记录实际输入→落点/可见输出。

### U2 再增量候选 `7d629a40a6f6fb526bb2f6f207297a9df32a2013`

本次两导航消费者已改读 nav slot；上文“消费者未改”仅对应 `9d5f9d1c`。App/壳层视图消费仍未变，U1/U3/U4 refs 与上表相同。以下只读审查，未将候选合入运行基线。

- `shell.golden.test.ts` 现已 install 真实 shellPlugin，读生产 kernel.slots，与固定 JSON 比较；移除了 CAPTURE 写入分支。这部分是有效的新旧清单对照，纠正上一候选仍读旧源码的状态。R6-08 的提取覆盖缺口及测试自己重算 header/environment 行为仍未闭合。
- 移动七入口及 settingsOnly、桌面 primary/settings 的键/图标/顺序与现有官方值静态一致。两个导航不再静态 import 页面；只有 hook/contract 依赖变化。
- `shell.integration.test.tsx` 实际测试 MobileSidebarNavigation 的安装/撤销/重新安装、导航拒绝；视图测试的 `Views` 是测试手写消费者，验证了 RegisteredViewLayer 的 lazy/memo/boundary，但不是 App 已接线证明。
- 两个 regression 文件通过测试库 render wrapper 注入 UiKernelProvider 后导入原测试；原断言未变。不过原 `src/components/layout/__tests__/MobileSidebarNavigation.dedup.test.tsx` 仍独立裸 render 新组件（33等行），直接跑原目录仍没有 Provider。C1需协调测试入口接线并保留原断言，不能只跑新增 wrapper 就宣称受影响目录全绿；此项归 R6-04/07。
- **R6-09**（已关闭，见上表 R6-09 行：`src/ui-plugins/official/shell/navigation.ts:19-23` 给无 placement 的社区条目默认 placement，`renderNavigationIcon.tsx:15` 无图标时不渲染；`examples/plugins/community-word-of-day/__tests__/word-of-day.test.tsx` 用示例的真实条目守住）：原示例 `examples/plugins/community-word-of-day/ui.tsx:60` 按公开接口注册 `{id,viewId,labelKey,order}`；候选 desktop 只取 `item.desktop?.placement==='primary'` / settings，mobile只取 `item.mobile?.placement==='launcher'` / settings。无 placement 的合法贡献从两端消失；新 `ShellNavItem.icon` 还要求必填，而 F0 nav.register 的 icon 可选。应由 C1 协调 contract/默认值，不能要求示例绕过公开接口才能追加。
- **R6-10**：两个消费者均先 `entry=>entry.value` 丢弃 owner，并直接 `<Icon/>`、`<SettingsNavIcon/>`。对带完整 placement/icon 的社区条目也没有局部边界。现有测试只验证“贡献的 view 抛错”，未覆盖该实际 nav 组件扩展路径。此为静态确定的未隔离路径，不声称已在候选上亲跑复现。

### U4 正确入口：LearningHubContextMenu 条件/顺序/键/图标

独立读完基线 `src/features/learning-hub/components/LearningHubContextMenu.tsx` 981行。以下所有键属于 `learningHub` namespace；图标均 `size=15 weight=duotone`，空图标占位不能删除。新元数据在 U4 候选中全部未交付。`A→C` 为同步动作后 close；`C→50→A` 为先 close，再延迟50ms执行。

| 场景（表内顺序即原顺序） | 条件 / key / 图标 | 动作与时序 |
|---|---|---|
| trash empty | onEmptyTrash：finder.trash.emptyAction / Warning / danger；无条件 separator、common.refresh / ArrowClockwise | empty：C→50→A；refresh：A→C |
| trash item | onRestoreItem：finder.contextMenu.restore / ArrowCounterClockwise；onPermanentDeleteItem：separator + finder.contextMenu.permanentDelete / Trash / danger | 两者 C→50→A |
| normal empty，不可创建 | !canCreate：仅 common.refresh / ArrowClockwise | onRefresh?.()，A→C |
| normal empty，可创建① | onPaste && pasteCount>0：contextMenu.paste 或 pasteCount（>1）/ Clipboard + separator | onPaste，C→50→A |
| normal empty，可创建② | dataView=folder：folder.newFolder / FolderPlus + separator | onCreateFolder?.(currentFolderId ?? null)，A→C |
| normal empty，可创建③ | contextMenu.newNote / FileText；importMarkdown、newExam、newTextbook、newTranslation、newEssay、newMindMap / 无图标 | 原对应创建或导入回调及类型；父id ?? null；均 A→C |
| normal empty，可创建④ | separator；common.refresh / ArrowClockwise | A→C |
| folder① | contextMenu.open / FolderOpen；separator | onOpenFolder?.(folder.folder.id)，A→C |
| folder② | canCreate：newSubfolder / FolderPlus → newNoteHere / FileText → importMarkdownHere / 空 → separator | 参数均 folder.folder.id；A→C |
| folder③ | onCopy：copy / Copy；canCreate&&onDuplicate：duplicate / 空；canMove&&onMoveTo：moveTo / 空 | copy A→C；duplicate/move C→50→A；参数 target |
| folder④ | 无条件 rename / Pencil；onExportFolder：exportFolderZip / 空；canDelete&&onDeleteFolder：delete / Trash / danger | rename/delete A→C；export C→50→A；参数 folder.folder.id |
| resource/folderItem① | open / ArrowSquareOut；separator；canAddToChat&&onReferenceToChat：referenceToChat / Chat；canAddToChat&&onMakeCards&&!isFolder：makeCards / Cards | 全部 A→C；open 传 resource，其余传 target |
| resource/folderItem② | copy/duplicate/move 条件与 folder③ 相同 | 同 folder③ |
| resource/folderItem③ | resourceItem&&onRenameResource：separator+rename / Pencil；resourceItem&&onToggleFavorite：separator+favorite或unfavorite / Star或StarHalf | A→C，传 resourceItem |
| resource/folderItem④ | resourceItem：addToDesktop；已存在则 addedToDesktop / CheckCircle(text-success)，disabled；未存在无图标 | isFolder 分别调用 addFolderShortcut/addResourceShortcut 后 close |
| resource/folderItem⑤ | resourceItem&&onExportResource：separator+export / 空；canDelete&&resourceItem&&onDeleteResource：separator+delete / Trash / danger | C→50→A，传 resourceItem |

原分隔线无统一清理：不能沿用 DSTU 的尾部分隔符删除逻辑。`resourceItem` 判定是 `'type' in resource && typeof resource.type === 'string'`，不是按 target.type；folderItem 仍可走 open/reference/makeCards/copy 等路径。trash 优先于普通菜单：folder用folder.id/'folder'；resource用id/type；folderItem仅 note/textbook/exam/translation/essay/image/file/mindmap 原样，其余回退note。默认 target 分支回相应 empty 菜单。

外壳条件：canCreate/canDelete/canMove/canAddToChat 默认true、trash=false、pasteCount=0；renderedOpen=false返回null，退出180ms后卸载；pointer:coarse 为贴底面板、44px、safe area，其他为8px边界定位；仅folder/resource显示触屏完整标题；外部点击/触摸/滚动、Escape及Android overlay优先级返回键关闭；Portal/body、玻璃透镜、WallpaperReplica、原class及深浅色均保持。上述外壳的等价性需要被消费者保留，不能仅凭菜单 id 相等推定。

### 本轮门禁收尾

规格 §1.3 所有命令已亲自执行；重启取消、4GB OOM、8GB重试成功均有原始记录，见汇总。demo原路径构建退出0（5m45s），hero warmup后处理注入10项；主构建退出0（7m45s）。没有将产物存在等同于浏览器视觉/交互通过。本轮仅提交两份报告；按规格生成的 `src/version.ts` 在门禁结束后清理，恢复初始工作树状态，后续检查仍应先运行 version:generate。

当前已勾选 R6-01（规格取得）、R6-07（旧基线环境门禁）；R6-02–06、08–10 共8项待交付/修复。四个 lane 均未通过 F1，下一轮按已固定编号与修复提交继续复核。

## 协调者指令1–5：U2 App 消费与候选门禁复核

### 基线和操作范围

- 已执行 `git merge --no-edit main`，main固定为 `fa99dd56125ca059cc345ab25e1e0e39065a8f43`；本树产生 `040ee04641350c3de2f47723d4faa23ab57352c9`。规格发布提交 `40e885f899e006c088965d25985c6bafe0a8128a`；以工作树 `FRONTEND-F1.md` 为准，U1 golden 特例路径已经确认。
- U2 固定候选 `518071df8a68eca8a7d27f47aee19695e0141886`，含 App 改造 `86302a65a`。与 C1 一致，撤销对当前候选的“App尚未接线”判断；该判断仅属于早期两个 WIP。
- 为亲跑候选，在当前分支执行 `git merge --no-commit --no-ff 518071df8…`，没有提交此合并；全部作业及产物分析完成后 `git merge --abort` 已恢复到 `040ee0464`。未修改候选实现、golden、expected；本次仍只编写两份报告。
- U1/U3/U4 固定 refs 仍为 `8597b23f` / `e30395712` / `25f9c171`，本轮不重复审其已记录文字。

### App 条件 → 实际消费位置

| 原壳条件 | U2候选实际消费 | 复核 |
|---|---|---|
| 当前视图元数据 | App:442-449 useSlot('views')，key=currentView取activeView，ref供稳定导航回调 | 已接线 |
| demo 只允许chat | App:636 的 allowInDemo；官方只chat=true；canonicalize和transition仍在原位置 | 官方值等价；新viewId裁定仍归09 |
| LH返回/侧栏分型 | App:1072 pageBackButton，1113 sidebarKind | 原17视图条件逐项相符 |
| settings/todo导航及折叠开关 | App:1154-1156 sidebarOwnsBackNavigation、hideExpandedSidebarToggle | 折叠/展开两态相符 |
| 移动返回可见性 | App:893 mobileBackToHome + unifiedCanGoBack | 原17视图/有无历史相符 |
| 标题与移动闪卡tabs | App:1336-1344 chatHeader/titleKey/cardsHubTabs + isSmallScreen | chat标题允许空；三分区标题/移动条件保留 |
| 页头portal / 聊天编辑器 | App:1565-1572 toolbarSlot；chatHeader && sessionId && title | 四槽名相符；原双条件源码仍是&&，08取证覆盖缺口尚存 |
| 桌面闪卡tabs / content class | App:1619 cardsHubTabs；1747 contentClass | 三分区/settings-view相符 |
| 17视图层与gate | App:1410-1427 viewContents、visible过滤、RegisteredViewLayer；1760实际渲染 | slot顺序、key、contentKey、extraClass、errorBoundaryName均传入 |
| Workbench替换经典层 | App:1753-1760 原条件/Suspense/LazyWorkbenchDesktop，else为注册层 | 原动态import不变，创建React元素不会触发页面lazy |

`lazyComponents.tsx`、`useViewLayerContents.tsx`、`viewRouting.ts`、`useDesktopSidebarElements.tsx`、三处启动文件相对临时合并前无差异。LRU/pinned/pdf软保护、页面isActive/props/回调及业务交接分支保留原实现；不会要求 U2 越权搬这些文件。App剩余 currentView 判断分别用于资源handler、媒体引用、Android返回处理、模板选择、维护跳转；它们不是遗漏的壳层显隐字段。

### 独立真实比较与门禁

作业全部经全局队列，详见汇总的完整命令/result。类型检查退出0；主/demo构建均退出0；测试作业 `20261104062423-d04387` **退出1：13文件中4失败/9通过，54项失败/109通过**。

- 官方 shell 四文件共63项（golden1、真实导航原回归wrapper58、integration4）亲跑通过。golden actual 真实来自 UiKernel；取证 `6beac2e74` 是候选祖先，取证以来 golden diff为空。
- 52项失败为原直接入口缺 UiKernelProvider（移动13、桌面39），2项失败为旧源码字符串断言（桌面toggle/移动返回各1）。后两项不证明当前输出行为错误，需C1协调保持原行为断言目的的测试装配/适配；本审读者没有改测试以过门禁。
- 作业 `20261104062909-12370b` 从原 App/useShellViewChrome 和当前 App/生产 views 初始化式直接提取表达式，比较17视图 × 折叠2 × 历史2 × 聊天标题空/非空2，共136输入/952输出，退出0、0差异。仅替换翻译为键、执行memo回调，未重写判定公式；这是表达式证据，不是DOM/浏览器行为证明，也不代替08的完整golden。
- 作业 `20261104063204-639e2b` 检查候选主构建静态依赖：五个关键页面chunk字节数与旧基线一致，均不在入口静态闭包；入口闭包仍7文件，从5,321,418降至5,311,011字节。U1安装器尚未集成，此证据只覆盖当前U2候选依赖图。

### 当前编号裁定

R6-04 的“注册/导航/App接线”子项已核实，原测试入口门禁仍未闭合，保留未勾选。R6-08覆盖、09契约/新viewId及10社区图标边界仍未修复；不改规格替架构师裁定09。R6-07保持“旧基线环境阻塞已解除”的历史闭合，不拿它遮盖本轮候选测试退出1。四lane均不授F1。

## 06:58Z 指令：U2 `75c6343f0` 的08/10定向复核

固定候选 `75c6343f049f69bf13b46a500909c91aca12b18b`。只做08/10增量：本树从`c08c83d80`临时 `git merge --no-commit --no-ff 75c6343f0`，最小作业结束后 `git merge --abort` 已恢复；未提交候选合并，未编辑golden/expected/实现。原52项Provider失败、旧97文件、类型检查和两个构建均未重跑。

### R6-08：已核实，勾选

| 项目 | 证据 |
|---|---|
| 单独修订，符合§1.4 | `3e28111d4987c00615c3e2c93598f11cfd100c44`仅修改shell.json、consumerEvidence.tsx、legacyEvidence.ts、legacy.evidence.test.ts四文件，无生产改造 |
| 说明旧错误及去重录 | `06d8e8c275b35e5c0fc5e86e21e13347481e39b9`仅补报告、删除CAPTURE_LEGACY_CORRECTION写入开关并将取证测试限时改20s；断言未改弱 |
| 时序与golden冻结 | `git merge-base --is-ancestor 3e28111d4 75c6343f0`退出0；`git diff --name-status 3e28111d4 75c6343f0 -- .../__golden__`为空。它是§1.4修订提交，不冒充早于所有改造的首次取证；首次取证仍为6beac2e74 |
| 旧源码出处 | consumerEvidence的LEGACY_REVISION固定`e303957124ac220f55bee1b04cca5d3937983b92`，经git show读取旧App/mobile/sidebar/chrome/navigation/canonical/cards。5d81fad1e还把createNavItems/cards helper从当前导入改为固定旧源码执行；golden未变 |
| 移动真实顺序 | 读取旧`MOBILE_APP_LAUNCHER_VIEWS`初始化式，7项；不再用短标题对象的键顺序冒充消费者顺序 |
| header条件 | 17视图分别执行旧App JSX条件，session/title独立4组合；chat-v2结果false/false/false/true |
| 环境与导航 | 32组环境执行旧Workbench JSX/renderViewLayer及侧栏实际条件；导航执行旧setCurrentView与canonicalize，覆盖40输入×DEV/demo四组合=160行，记录target/committed/VIEW_SWITCHED |
| 不是新元数据反推旧expected | legacy测试只取旧提交→固定JSON；新golden测试安装真实shellPlugin并读UiKernel slots，consumerEvidence无revision时执行当前App。golden仅提供输入场景，不提供actual输出 |

抽查旧导航结果：dashboard→data-management并发VIEW_SWITCHED；生产crepe-demo/unknown-view→chat-v2且从chat-v2出发无切换事件。两条测试均已亲跑通过。此证据闭合原08三个缺口，不把取证React元素树等同于所有业务组件/浏览器交互覆盖。

### R6-10：普通社区路径已核实；同ID覆盖缺口保留

实际修复位于 `f122ff3bd`（helper/新测试/移动初改）、`5d81fad1e`（取证工具补强）、`b6c0fdc7b`（移动key）、`9a0e135f9`（桌面owner/key/图标入口）；没有把`1a2183bbd`的标题当实现证明。

- 两消费者从真实`entry.owner`取来源值，覆盖贡献value里的同名字段；桌面主行/设置trigger/设置menuitem、移动launcher/settingsOnly五个图标位置都经`renderNavigationIcon`。图标class/尺寸/strokeWidth、标签/动作原样，普通社区抛错仅图标置空。
- key改为owner/id，避免社区与官方贡献指向同一viewId时键冲突。实际测试添加的坏图标也指向todo，卸载后检查只移除该贡献、保留其他入口；桌面主行与移动两布局验证撤销，设置菜单验证动作仍可执行。
- **保留缺口：`renderNavigationIcon.tsx:14-16`把owner字符串`dstu.ui.shell`一律当官方。** 规格§2允许社区以同ID覆盖；`UiKernel.install:217-224`确实先卸载旧同ID，再给新fiber记录同一个id，loader:65也调用此install。于是社区覆盖官方shell时同样不包局部ErrorBoundary。
- `navigationIsolation.test.tsx:89-95` 的真实测试从已安装官方shell开始，再`contribute('primary','dstu.ui.shell')`安装新实现，坏图标导致外层fallback出现、整个navigation消失。本次该断言通过，证明当前按ID豁免的行为；测试标题称“official”不能证明新实现来自内置官方模块，也不能作为社区同ID覆盖的隔离证明。
- 派回C1协调实际官方/社区贡献来源的识别，保留官方原错误传播，但同ID社区覆盖须局部隔离。此项是§2已支持的正常扩展方式，不涉及恶意插件/权限系统，不新增F2信任流程。

### 最小亲跑结果

```text
[作业 20261104070627-16f964] npx vitest run --config vitest.config.ts src/ui-plugins/official/shell/__tests__/legacy.evidence.test.ts src/ui-plugins/official/shell/__tests__/shell.golden.test.ts src/ui-plugins/official/shell/__tests__/navigationIsolation.test.tsx --maxWorkers=2
 Test Files  3 passed (3)
      Tests  7 passed (7)
   Start at  15:06:30
   Duration  20.66s (transform 25.11s, setup 2.19s, collect 29.73s, tests 8.04s, environment 1.18s, prepare 803ms)
[作业 20261104070627-16f964] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104070627-16f964.log
```

通过`job.mjs result`取得，未出现Errors汇总行。仅3文件7项为本次亲跑；C1提供的69绿/52失败为外部复核信息，未冒称本次运行。当前闭合01/07/08，02–06/09/10共7项仍待交付或修复；不授F1。

## 07:19Z 指令：U1 `d0561ee2b` 定向复核

候选固定为 `d0561ee2b63de838fd33b20f3b7b45a4117cc390`。从报告基线`b39857dd5`临时未提交合并U1，完成最小测试/旧源回放后已`git merge --abort`恢复；没有把候选或其main祖先中的后端变更提交到R6。重启后核对HEAD/MERGE_HEAD及已有作业结果，未重复完成的29项测试。

### R6-02 / U1：内容证据成立，提交隔离偏差保留

- `7f915ae5f1799ee9de9c7f40a7386d785eba7475`仅取证报告、harness/test和16个JSON；三个生产入口与`e30395712`无diff。`git merge-base --is-ancestor 7f915ae5f 397b64161`退出0，首次取证先于生产改造已核实。
- `e354acaa66c1b04c64a944765c99844ca5115d49`同时修改5个golden、harness/test、`src/demo/app/main.tsx`、`src/ui-kernel/community.ts`及community测试，是混合提交。`5605d964c`仅17行文档说明，不能让此前提交变成独立纠错；后续golden到d0561ee2b无diff。该§1.4隔离偏差留给架构师裁定，不重写历史，不标“独立提交完全合规”。
- 首版通用模块Proxy为`then`也返回函数，动态import Promise把模块当thenable吸收却永不兑现，导致五场景记录提前终止。修订仅把测试替身的then设为undefined，并从固定旧入口重新取证。
- 独立只读回放：使用`7f915ae5f`的16组输入、`e354acaa6`修正后的历史harness，强制其`original=true`读取`e30395712`的三个真实入口；对新内核/安装器设置“若调用即失败”的端口，实际调用数0。全部16结果等于当前纠错golden，恰好下述5组不同于首版，其他11组原样相等。

| 修订JSON | 旧源码重放确认的新增记录 | 本轮结论 |
|---|---|---|
| pomodoro | import后实际render PomodoroMiniWindow | 原thenable替身漏记录，纠错有依据 |
| assistant | render QuickAssistantWindow；位置在get_setting invoke之前 | 保留旧顺序，不为await内核后的顺序放行 |
| demo | createRoot导入、旧业务树render、autoplay、scene-1导航 | 原Promise.all停滞后的应有行为 |
| demo-desktop-dark | desktop导入/prepare、createRoot、render、arrange、instantFirstPlay、导航 | 同上，顺序与固定旧源一致 |
| demo-app | 原ErrorBoundary/providers/ThemeSync/frame/Suspense/FixtureApp渲染树 | 同上，未把新Provider写入旧expected |

因此不能指控这5个golden是为新实现倒填；也不能因为内容可复现就免除混合提交的程序性偏差。R6-02不整体勾选。

### R6-03：真实API与入口控制流

| 路径 | 实现与已核实证据 | 验证边界 |
|---|---|---|
| main normal / 纯Web预检失败 | 预检/maintenance分流后getUiKernel；动态bootstrap；官方安装完成后UiKernelProvider包原appTree，StrictMode及正常runtime顺序保留 | 当前16场景harness执行真实入口；业务UI为替身，不证明像素或延迟相等 |
| recovery/blocked/debug | 原恢复树，不创建内核 | 原控制流保留；无需为了接线让恢复壳等待插件 |
| pomodoro/quick-assistant | 原即时动态import/render及Sentry并行顺序保持；当前期望kernel/provider数均0 | **未完成Provider**；await会改变顺序的问题已交架构师，R6不自行放宽 |
| demo / demo-app | mocks、locale、pack/业务import原顺序；渲染前创建内核并包Provider；beforeunload/HMR注册dispose | 依`window.__DS_DEMO_SHELL__`禁止社区通道，mock-before-business断言通过 |
| bootstrap / official installer | 真实UiKernel、动态registry适配、invoke adapter；glob eager收集`./*/index.ts`，order再id安装；失败dispose后抛出 | 当前领域glob为空，两个空kernel/空slots相等不证明U2–U4已集成 |
| official安装与共享render测试 | 显式真实插件验证顺序、lazy factory不求值；renderWithOfficialUi使用真实Provider，rerender保留内核，dispose卸载 | 显式插件测试有意义，但不是当前默认glob已有领域插件 |
| community发现 | 先listen host://ui-manifest，再invoke plugin:ui\|manifest；事件revision防止旧初始响应覆盖；demo直接返回 | 空manifest仍有一次发现请求/订阅，不把“无SDK/map/plugin导入”写成绝对零操作 |
| shared/import-map | 首次社区模块import前await共享模块安装；react/react-dom/UI SDK/i18next单例，后续复用 | community测试mock共享安装端口验证顺序；F0 shared测试验证map/shim，不是本轮浏览器协议联调 |
| loader生命周期 | stop先禁止后续同步、unlisten、loader.dispose；dispose设标记、等串行队列、撤销贡献；待完成import不能复活插件 | 实际生产loader与社区服务测试通过；不代替领域组件render边界（09/10仍未决） |

bootstrap在VM里执行生产代码、注入惰性registry/IPC端口；新增基础设施import不进旧业务trace，Provider从可见树对比中剥离，但另行断言kernel确实包住树，真实React Provider行为由render.test覆盖。未以该harness声称完整浏览器等价。

### 本次作业（最小集）

`20261104073812-16c0d3`：boot-golden16 + install1 + render1 + community4 + loader7 = **5文件29项通过，退出0**。没有重复未变化的kernel8/Host示例3，也没有重跑旧97文件或两套构建。

旧源回放首作业`20261104074010-f13045`退出1，原因是审读者外层VM未注入URLSearchParams；这是取证驱动错误，未运行出应用断言失败。仅补该全局端口后，`20261104074217-10fed2`退出0：16场景matchesCorrected=true，五场景matchesFirst=false，其余true，kernelTouched=0。源码/golden/expected均未改。原退出码及摘要见汇总。

R6-03保持未勾选：normal/demo/社区生命周期部分已核，轻量窗与领域集成待裁定/交付；R6-02的混合修订隔离偏差亦未关。U1报告的40绿和8GB构建是lane证据，本轮只将上述29项及旧源回放记为R6亲跑。

## §6发布后的联合复核与08:17/08:28增量

### 规格、固定候选与执行边界

以正式规格提交`0409f4c8f`的§6为准，本树合并为`3a06776716a7dc23a1f06350344ada2f861e5990`。本轮临时组合均采用未提交多头合并，完成后abort，无实现/golden/expected编辑；后续恢复同步main到`eeaf5bdc7`只是环境同步，不改变下列已测快照含义。

| 组合 | U1 | U2 | U3 | U4 | 独立检查 |
|---|---|---|---|---|---|
| A | 684f3e805 | 2c3466876 | 756ae4cb3 | 35b1ac7b7 | tsc0；33文件195测试中192通过/3失败；主/demo构建0 |
| B | e9d23a1bf | ea2c67c28 | 227fc43ed | 91000797a | 增量8文件29测试通过；tsc0；没有重复A的构建 |
| C | 9d58350f4 | ea2c67c28 | 166b6469d | 91000797a | 仅新增sidebar旧证据/转发对照2文件2测试通过；U1相对B无src变化 |

组合A三项失败是U2新key在App仍canonicalize→chat两项、U3 sidebar未消费新增分类一项；不是来源API缺失。组合B分别经ea2c67c28 App resolveShellView、d89a447b0/sidebar接线修复，亲跑变绿。原52项缺Provider与2项源码断言失败在A已修复，未因新增测试绕过原入口。

### 已核实：04、09、10及U1补救

- U1来源由安装options→fiber→SlotEntry.origin传递，元数据自报不能覆盖。真实builtin安装/社区同ID替换/异步子fiber/卸载再装均有生产路径测试；U2五个图标位置改用origin，builtin故障仍按原路径传播，community故障仅图标fallback。关闭10。
- U2默认缺placement的社区项按slot order置于官方之后，缺icon返回null；新增key的点击、App setCurrentView与通用导航/命令入口使用resolveShellView；未注册key回chat、官方别名照旧、keyed冲突仍拒绝。实际桌面/移动导航与当前App表达式通过，关闭09。
- 原桌面45/移动13/壳源码测试8+4分别通过。源码断言改为执行真实表达式核对折叠/历史等原断言目的，不是删除功能断言；关闭04。
- U1已按§6.4在报告逐项列出五JSON的旧提交/文件:行。本轮`legacy-boot-evidence.test`又从首次harness重现错误、只改then端口重现纠正结果，并证明旧trace各行原样保序；与上轮R6独立旧源回放一致。**接受§6.4补救，U1混合纠错不再单独阻塞**；历史仍记混合提交，未改写成原本合规。
- 轻量窗无Provider现为正式要求，不再要求U1给轻量窗装配；U4有无Provider各自对同一golden通过，live空slot不触发官方回填。

### U3：主要实现已核、sidebar时序与图标隔离未闭合

取证链：`767a55489`仅旧提取/JSON/test，早于`b1a7ce816`生产；搜索索引纠错`457628dbf`的父为767a55489，仅改取证/文档（修ES3降级Map迭代），后经`34b45e66e`合入；golden到756ae4cb3未变。原hook文件保持原样，真实renderHook对照完整desktop/mobile索引通过。

17分区均映射到同名settings.sections id/component；原内容顺序用order、导航五组用legacyGroup/navigation.order、六分类用category/order、搜索明细用独立order。19个React.lazy模块路径/导出名相同，props保留在Settings工厂且只为active section求值；API分区before-preview、shortcuts/about after-modals，MCP模态位置不动。plugins移动端提示、shortcuts仅导航隐藏、workbench重定向、about标题、automation三个子节顺序均经旧JSON逐字段比对通过。

§6.5授权后SettingsShellSidebar实际改读slot；社区分类/搜索的追加/撤销DOM测试通过。新增sidebar证据从固定`d3943bae5`读取原44行sidebar与原hook，32组平台×断点×折叠×外部开关×返回回调输入：初始/动作后props、搜索/焦点/tab、open/back调用逐项相符。旧侧仅同步虚拟useState/useMemo，当前侧真实React+UiKernel但mock末端SettingsSidebar收props；实际DOM分类/搜索另由sidebar.test覆盖，不能把32组称为全部DOM验收。

**时序仍待裁定**：`d89a447b0`先改sidebar；`40480bb9c`随后才纯补3个旧证据文件；`72fe498df`只补新props比较、`166b6469d`只文档。祖先检查证实该顺序，不因来源固定就称先取证，也不擅自把§6.4的U1例外扩展到U3。

**R6-05尚有组件隔离缺口（静态证据）**：Settings/SettingsShellSidebar调用`settingsNavigation(entries.map(e=>e.value))`丢origin；helper直接输出nav.icon/category.icon；`SettingsSidebar.tsx:296-316`、`SettingsMobileNavigation.tsx:84-94`直接`<Icon/>`。SectionContent的origin边界只包内容，不包导航，社区坏分类图标可向宿主冒泡。派C1协调U3在允许路径补局部社区图标隔离及真实消费测试；不要求重写官方布局。此路径未亲跑复现，不伪称测试已覆盖。

### U4：三入口已核与证据限制

首次菜单/Markdown纯JSON+测试为`c3d573c5b`，不是只写报告的a58ab79c2；c3d是58e255320改造祖先，两个旧入口diff为空，原JSON后来未改。DOM记录里labelKey实际是译文，66fabc39c另从固定旧源码提取精确键表补证；新注册真实slot所有键逐字段比较通过。CodeBlock新授权后先有`f854917e2`纯取证（388组合），再b347e88df/91000797a消费改造。

Markdown匹配math/latex的原边界/inline/pre行为保留；CodeBlock mermaid/svg/html/htm/xml、富渲染语言及能力开关改读同一officialMarkdownEntries，旧状态机/手动run/import时机保持。Markdown及CodeBlock无Provider同步读官方表，Provider存在则读真实slot；value对象与注册表为同一引用，卸载为空不回填。旧renderer测试及有无Provider的DOM golden通过；不把依赖mock过的预览测试说成真实Mermaid绘制/浏览器性能测试。

菜单47条按scope固定原顺序，键/图标/危险禁用/分隔线/50ms动作和close先后保留，target/resourceItem/trash itemType回退与原实现相符；两个布局/能力/缺callback/收藏/桌面快捷方式矩阵及真实事件时间记录相等。用origin隔离社区菜单行及Markdown renderer，同ID覆盖测试通过。当前主/demo异步首帧政策仍挂03，最终联合候选完整门禁仍待最后基线，不以A的构建外推B/C的CodeBlock修改。

### §6.1首帧与构建边界

主main:524先BootShell，574/600 await getUiKernel后才render appTree；demo:139和demo-app:108也await后首render。Cordis装配有microtask，当前实现没有用官方静态表先渲染主App。此项保留R6-03，C1已交架构师；不是轻量窗争议，也不把最终slot齐全或46绿当同步首帧。

组合A实际构建的五页面均不在入口静态闭包：Settings157504、LH23178、Workbench100396、AnkiTasks43022、Media71388字节；Settings大小变化伴随19lazy声明移至官方注册模块，不能单看体积减小断言性能改善。入口静态闭包7文件5369030字节（旧5321418），有新增内核基础设施；没有发现把这五页面同步并入入口，但尚未证明完整首帧性能/预热顺序等价。

### 作业与当前结论

完整命令/result在汇总文档；A检查作业`20261104081334-{500c77,c9ae73,2fc454,0074c4}`分别0/1/0/0；B增量`20261104083441-{a324d4,8b2560}`均0；sidebar补证`20261104085806-0fc5f6`退出0。均亲自经队列获取，未使用提供方结果替代；重启没有重做已完成工作。

当前闭合01/04/07/08/09/10；02/03/05/06保留上述精确边界。提供方最新9d58350f4构建只是lane证据，本轮未重复其两套构建。所有临时组合已撤销，报告只提交允许两路径。

### 11:16Z恢复增量：U4官方安装器

恢复核对`a743d976f`/`5a373cc5d`报告已提交存活；再次查看log/status及已有ledger result（退出0），R6仍无TESTMAP。固定U1 `1fed8374d`、U3 `df6aa1f32` 的相关生产文件分别相对9d58350f4/166b6469d无差异，main规格亦无新裁定，因此不重复首帧/侧栏旧测试。

U4 `27b38ef79449f6ddbb847979b415e4f68d40a43a`相对已审91000797a仅新增`official-install.test.tsx`，生产与golden无差异。本树已含真实U1 origin（6bd437e73为HEAD祖先）；临时未提交合入U4后，仅运行该新测试：真实renderWithOfficialUi→生产glob安装器，实际markdown/menu slots等于官方静态表且origin全builtin，退出0。作业`20261104111645-2cffe2`，1文件1项通过，无Errors行；候选合并已abort。

这补齐真实默认安装器接入证据，但未重复提供方构建，不将单项通过扩展为最终全lane首帧/门禁签收。02/03/05/06状态不变。

### C1 U4正常main交接：主体与测试分开签证

已同步正常main `4c6cd1ba8f377e7200310ae1930fe7def9c61ee3`，本树合并提交`14bd90f4375044d07af72cbbe6cd6773c67898db`。`211eaae46`确为U4主体合并（第二父77c33d5fd）；ea2863c28安装器测试和27b38ef79报告均不是该main祖先（两次检查退出1），不把最新lane整体称为已合入。

main的U4三消费者/contracts/content/official-content生产和golden相对独立已测`91000797a`无diff；U1 kernel/slots/react/bootstrap/loader/install/helper相对已测`e9d23a1bf`也无diff。因此同源静态fallback、live空slot不回填、origin同ID隔离、CodeBlock每条388组合复用作业`20261104083441-8b2560`的独立通过结果，不重复其大矩阵。补跑正常main十个获授权原入口，弥补前一完整原入口回归仍对应CodeBlock改造前A快照的边界；队列作业`20261104112804-d7ee89`结果见汇总。

安装器删断言审查：`ea2863c28`把新增official-install测试中的MarkdownRenderer改为`<div/>`，删除其新增KaTeX mock和`querySelector('b').textContent==='x + 1'`。它未改Rust/原有前端测试/任何冻结golden，仍检查真实默认installer的两个slot逐字段等于同源表，并把builtin断言从markdown扩展至两个slot。**仅接受缩窄为安装器注册测试**，不把删后绿当为原失败渲染作了修复；原日志只证实undefined，不足以证明数学渲染正确或失败必由mock造成。

对应旧义务未删除：markdown golden的pre/code、math/latex边界仍逐字段对同一旧JSON；其新增无Provider/安装/卸载测试仍实际断言`b[data-display=true]`、同HTML、卸载后code原文，且R6已亲跑。该类测试mock react-markdown，不能外推完整解析器/截图；安装器新增测试亦不作为完整解析→数学DOM的证据。首帧/U3时序等未决项不因U4正常合入而自动关闭。

正常main原十入口作业`20261104112804-d7ee89`已返回退出0：10文件68项通过（19:30:30，46.58s），无Errors行。原测试/断言未修改。R6-06内容实现/同源回退/真实slot/原入口回归子项已核，整体最终联合门禁边界仍保留；未宣称截图通过。

### C1 U2 `37ca8bfdd`依赖后交付复核

固定候选`37ca8bfdde2375477cff8aeb1943be4a5644acd4`、正常main `4c6cd1ba8f377e7200310ae1930fe7def9c61ee3`。候选tip非main祖先（退出1），但修复`ea2c67c28`为main祖先（退出0，main的U2合并为87a0ef4e7）。候选相对ea2c67c28的App、两导航、shell contracts/实现/测试、四原测试均无diff；这些路径在候选与main间也无diff。U1实际kernel/slots/hooks/loader/installer/helper相对R6已测e9d23a1bf无diff；不误把候选合main带来的依赖差异当新增U2算法。

当前main真实App:432-434的commandPaletteNavigate直接setCurrentView(view)，不提前用旧canonical白名单消去新key；:632从最新viewEntriesRef调用resolveShellView，:636仍保demo allowInDemo拒绝；:828通用导航同样解析。resolver仅放行已注册的新key，官方id/旧别名仍按旧canonical规则。两个真实导航保origin/default-placement/iconless/owner-id key与卸载行为；这就是R6独立作业`20261104083441-8b2560`已通过的实现，不再保留旧“新view退chat”判断。

四个原入口复用独立A作业`20261104081334-c9ae73`中45+13+8+4项全绿；当时三项失败属于后来已修复的新key/sidebar，并非原入口。origin/default-nav/路由/撤销复用B的navigationIsolation10项及shell golden1项通过。本轮仅无差异审读，不把提供方105504-887da4的86项、71项目录检查、12GiB构建列为独立亲跑。04/09/10维持关闭；不外推为完整App浏览器导航历史/截图/全部F1签收。

### 自动续派：R6-05新增WIP接口核对

按standard-v2（独立复核不改实现）正常合并main，基线为`d84e29565`、本树合并`e0373034e`。现有报告均已提交；R6仅编辑两份报告，不写业务LANE或实现。队列自检`20261104120525-7f8516`检查该报告提交快照，最终本轮报告提交后另按§5取对应tip自检结果。

U3新增候选`5c8aa07e4`已有`isolation.tsx`：builtin图标原样返回，community包装Suspense+真实ErrorBoundary并缓存包装组件；导航helper改为接SlotEntry以保origin，SettingsShellSidebar已传完整entries。**主Settings:385仍传`sectionEntries.map(e=>e.value)`**，与新helper:8-9的entries解构不符。并且该WIP参数/局部变量重复命名sectionEntries（helper:8/37）；只读转译执行作业`20261104120653-654252`退出1，实际错误先是`SyntaxError: Identifier 'sectionEntries' has already been declared`，未运行到所拟TypeError探针，不把它写成已动态复现后者。

审读期间后继`7a1670030`将参数改名slotEntries，重复声明已消失；主Settings调用未修。只读固定后继的helper原函数（仅图标依赖用透传端口）+原调用形状探针已提交`20261104121039-63a2b7`。这是新WIP未交付完整修复，R6-05仍未勾；不把旧5c语法错误沿用到7a后继，不改golden/expected，不接受单一sidebar新测试替代主Settings消费。

探针result退出0，输出`slot entries: ['example']`，旧主Settings传值形状则`TypeError: Cannot read properties of undefined (reading 'navigation')`；退出0表示成功抓到预期缺陷，不表示候选通过。报告前快照自检`20261104120525-7f8516`退出0，e0373034e/main d84e29565的typecheck、boundaries、typecheck:app、tests:app、build、build:demo六项通过。自检不包含U3分支WIP，不能冲销05；最终本轮提交再按§5自检。

### R6-05后继复验签收（`6eca3b07d`）

固定候选`6eca3b07dfb977545151c02edaf92daf39c41f41`，实际主调用补齐提交`1ef5caf97fc16130ea8982101891db070fb64f5f`。相对已报告7a1670030，生产唯一新增差异是Settings:385直接传`sectionEntries`，与SettingsShellSidebar:30及helper的SlotEntry契约一致；候选LANE.md的“自有完成”是提供方声明，不作为签收依据。

只读复核：`settingsNavigation`保留origin，导航icon及分类胜出entry的icon都经settingsIcon；builtin返回原引用，community包装稳定的Suspense/真实ErrorBoundary，空图标fallback保留标签/点击。原类别Map去重/排序及搜索顺序未改，19lazy不提前加载。两个消费者已共同传完整条目，不再有旧主Settings value-array TypeError；旧5c参数重名仅历史事实。

从已自检HEAD `0c72a1d13`临时未提交合入候选，version:generate退出0（build20787），仅跑修复影响最小集及tsc。作业`20261104124312-dbe568`退出0：4文件9项，含真实sidebar社区分类图标抛错/同ID覆盖/邻项点击/卸载，以及builtin错误向外传播；runtime3、原slot golden1、sidebar-props32场景也通过。主Settings调用接线由源码及全前端类型检查核实，不冒称本次渲染了整个Settings或每种移动布局。

`20261104124348-7c2097`执行`npx tsc --noEmit -p tsconfig.json`（队列追加incremental），退出0、无诊断。golden对d3943bae5的diff为空；测试只是签名改为entries，没有改expected。临时合并已abort，只提交报告。关闭05；02时序例外、03首帧、06最终联合门禁独立保留。

上一轮最终报告自检`20261104121840-f78e5c`已退出0，准确tip0c72a1d13/main45c3250b0六项全通过。本轮报告提交后按§5再次同步main、自检最终tip，不复用旧标记宣称新提交已验。

## 正常main联合闭环（`ad11a8394`）：关闭R6-06

本树正常merge main到`3503f91bea377d97c8e163506feddf340adb3d45`，main固定`ad11a83943de411a75c87364fd8893a174ce63f9`。b07793259 loader和1ef5caf97设置修复已是main祖先（退出0）；四域生产/测试分别与已审U1/U2/U3/U4候选无相关diff，未使用临时组合、未改实现/测试/golden。

按C1指令main后仅新增loader/图标最小复验：作业`20261104142724-f162c2`退出0，2文件2项通过、10项标题过滤未执行（未改.skip，不计通过）。loader测试实际安装first，坏manifest同步拒绝仍向caller抛出，再成功安装second，dispose清空kernel/slot；验证run返回原拒绝、内部queue恢复不被毒化。设置测试实际消费者验证community图标/同ID覆盖/邻项点击/卸载及builtin原错误传播。R6-05的候选签收现补齐正常main复验。

先version:generate退出0（build21545/git3503f91b），前端tsc作业`20261104142724-7f4bfc`退出0无诊断；主构建`20261104142725-364561`退出0（5m18s），demo`20261104142725-d54ed4`退出0（5m12s、hero warmup10项），命令仅设置8GB预算，无outDir覆盖。已有无diff的原十入口68项、slot/golden/no-provider/live-empty/origin/CodeBlock388组合、settings9项和shell对照不重复跑；均引用R6已记录独立作业，不继承提供方绿。

只读产物依赖作业`20261104143333-dc830d`退出0：入口main-B2GCADtm.js静态闭包7文件5344514字节；Settings156549、LH23178、Workbench100549、AnkiTasks43022、Media71388字节，五页面均不在入口静态闭包。尺寸/文件名变化不能替代首帧时序证明，03仍独立保留。

关闭06后只剩02/03：sidebar证据已可复现但晚于改造、原例外未裁定；主App仍await内核后render，§6.1首帧政策未裁定。22:00及22:04 gate-excerpt工具事故按架构师通知作废，不作lane缺陷，不为此改报告结论或实现。最终两报告提交/merge main后按§5自检准确tip。
