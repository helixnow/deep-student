# Wave2-B 第 1 轮 · 调研员-笔记:Notes 差距清单与静态落地计划

- **身份**:0824 Wave2-B 第 1 轮「调研员-笔记」。
- **范围声明**:**本轮只调研不改码**。未运行任何编译/测试/npm/cargo/vitest/tsc;未改动产品代码;未提交/推送。
- **基线**:仓库 `/workspace`,分支 `cursor/0824-wave2-desktop-subapps-a875`,基线 tip `061b4815`(分支上另有一条 session 起始空提交 `82e016b7`,不含代码变更)。
- **行号口径**:`docs/0824-quality-review/*` 的行号对的是 `2d41ea8b`;本文引用的**所有本仓路径+行号均已对现分支工作区重新核对**,与评审稿冲突时以本文为准。经抽查,笔记相关文件在 `2d41ea8b` 与现 tip 之间无漂移,评审稿行号仍基本有效。

## 0. 对标产品 2025–2026 证据摘要(WebSearch)

| 产品 | 2025–2026 关键动向 | 证据 |
| --- | --- | --- |
| Notion | 2025-09 发布 Notion 3.0「Agents」:Agent 可跨 workspace 查询/建改页面与数据库、20+ 分钟多步任务、以 Notion 页面/数据库做记忆;`Cmd+J` 唤起 Agent 侧栏,`@` 提供页面/人上下文;后续 3.6 加 External Agents、可交互 HTML block、数据库行级权限、Custom Agents 定时/触发自动化、MCP 双向读写 | [Notion 3.0 发布日志](https://www.notion.com/releases/2025-09-18)、[What's New](https://www.notion.com/releases)、[Notion Agent 帮助文档](https://www.notion.com/en-gb/help/notion-agent) |
| Obsidian | 1.9.x(2025-08)推出核心插件 **Bases**(YAML properties → 可过滤/公式化的数据库视图,`.base` 文件格式)与 **Footnotes View**;1.12(2026-02)推出 **Obsidian CLI**(脚本化/外部 AI 集成)、Canvas 背链入图谱、快速切换器可拖拽结果;社区侧 Copilot v4 把 Claude Code/Codex/opencode 以 ACP 跑进库内(多标签、Project Mode、多 Agent 协作),obsidian-agent-client 提供**笔记内嵌 agent 聊天块**与一键 Agent 按钮,并把提及笔记内的 `[[wikilinks]]` 解析为文件路径喂给 Agent | [Obsidian 1.9.10 changelog](https://obsidian.md/changelog/2025-08-18-desktop-v1.9.10/)、[Obsidian 1.12 changelog](https://obsidian.md/changelog/2026-02-27-desktop-v1.12.4/)、[Copilot v4.0.0](https://github.com/logancyang/obsidian-copilot/releases/tag/4.0.0)、[obsidian-agent-client 0.12.0](https://newreleases.io/project/github/RAIT-09/obsidian-agent-client/release/0.12.0) |
| RemNote | 「笔记 = 学习系统」路线:FSRS 间隔重复、AI 从笔记/PDF/视频一键生成闪卡与测验、AI tutor 就地讲解(答案锚定用户笔记,防幻觉)、Guided Learn 把文档拆成学习计划;知识图谱为全局图 + `/view graph` 局部图,边按层级/标签/引用/Portal 分色;块级引用与 Portal(嵌入同一块的活视图)是其笔记模型根基 | [RemNote 官网](https://www.remnote.com/)、[Knowledge Graph 帮助](https://help.remnote.com/en/articles/8771354-knowledge-graph)、[Guided Learn Mode](https://help.remnote.com/en/articles/15724936-guided-learn-mode)、[Convert Notes Into Quizzes](https://www.remnote.com/blog/how-to-convert-notes-into-quizzes) |

共性结论:三家 2025–2026 的主战场都不是「再加编辑器功能」,而是 **(a) 属性/数据库化视图**(Notion database、Obsidian Bases)、**(b) Agent 作为一等公民进入笔记宿主**(Notion Agent 侧栏、Copilot v4、agent-client 嵌入块)、**(c) 链接图谱做深**(Canvas 背链、块级引用/Portal)。本仓的双链/背链/局部图谱底盘已经相当接近 Obsidian 核心插件水位,差距集中在块粒度、库级视图和 Agent 可写通道上。

## 1. 差距清单(已有 / 部分 / 缺失,均已对现码核实)

### 1.1 双向链接

| # | 能力 | 状态 | 对标证据 | 本仓现码 |
| --- | --- | --- | --- | --- |
| L1 | `[[标题/ID]]` 双链解析(含 code fence/inline code 跳过、转义) | **已有** | Obsidian wikilink 基础语义 | `src/features/notes/wikilinks.ts:95-100,244-283`(解析),`:393-443`(ID 优先、标题大小写折叠、同名歧义确定性取最小 ID) |
| L2 | `[[Note#Heading]]` 标题锚点 + CJK 标点/全半角归一 | **已有** | Obsidian heading link | `wikilinks.ts:343-386`(`normalizeWikiLinkHeading`);消费端 `src/features/notes/NotesCrepeEditor.tsx:1200-1220`(scrollToHeading 同一套归一) |
| L3 | `[[target\|alias]]` 显示别名 | **已有** | Obsidian alias link | `wikilinks.ts:264-279`(label 解析);`NotesBacklinksPanel.tsx:417-422`(`buildMentionWikiLink` 生成带别名链接) |
| L4 | 笔记级 aliases(YAML `aliases`,一个笔记多个可解析名) | **缺失** | Obsidian 1.9.10 已把 `aliases` 升为强制列表格式的一等属性([changelog](https://obsidian.md/changelog/2025-08-18-desktop-v1.9.10/)) | `wikilinks.ts:410-441` 的 resolve 只按 ID/标题匹配,无别名通道;`metadata.props` 有通用键值(`NoteCustomPropsEditor.tsx:1-21`)但搜索/解析层不消费 aliases |
| L5 | 背链面板(后端持久 `note_links` 图 + 客户端降级) | **已有** | Obsidian Backlinks 核心插件 | `src/features/workbench/apps/notes/backlinksBackend.ts:46-56`(`notes_get_backlinks/outgoing`);`NotesBacklinksPanel.tsx:60,142`(outgoing/incoming/mentions/unresolved 四节 + properties/links/graph 三页签) |
| L6 | 未链接提及 + 一键转链 | **已有** | Obsidian「Unlinked mentions → Link」 | `src/features/notes/unlinkedMentions.ts:62-95`(扫描);`NotesBacklinksPanel.tsx:849-926`(有界扫描)、`:973`(`convertMentionToLink`) |
| L7 | 幽灵链接点击即建笔记(并发合并、宿主打开去双开) | **已有** | Obsidian 未解析链接点击创建 | `src/features/notes/createFromWikilink.ts:42-108` |
| L8 | 重命名后按标题双链集体回写(OCC、脏编辑跳过) | **已有** | Obsidian「Update internal links on rename」 | `src/features/workbench/apps/notes/wikilinkRenameSync.ts:1-30`(全库 note_links ∪ 客户端候选兜底,`RENAME_SYNC_SOURCE_LIMIT=256`) |
| L9 | 块引用/块嵌入(`^block-id`、`![[Note]]` transclusion、RemNote Portal、Notion synced block) | **缺失** | Obsidian block reference;RemNote Portal 是其图谱边类型之一([Knowledge Graph 帮助](https://help.remnote.com/en/articles/8771354-knowledge-graph));Notion synced block | 全仓 `rg "block.?ref|\^block|transclu|嵌入"` 在 notes/crepe 目录无命中;`wikilinks.ts` 的 `WikiLink` 结构只有 `target/heading/label`,无 block 维度 |
| L10 | 链接 hover 预览卡(800ms 延迟,对齐 Obsidian page preview) | **已有** | Obsidian Page Preview 核心插件 | `src/components/crepe/plugins/wikilink/hoverPreview.ts:12-15`(注释明说对齐 Obsidian 心智) |

### 1.2 快速切换与搜索

| # | 能力 | 状态 | 对标证据 | 本仓现码 |
| --- | --- | --- | --- | --- |
| S1 | Quick switcher(`mod+P` 工作区内 / 命令面板 `mod+O`,空查询领「最近打开 8 条」) | **已有** | Obsidian Quick Switcher(1.12 还加了结果拖拽) | `NotesWorkspaceApp.tsx:2357-2370`(mod+P 捕获)、`:1938-1951`(recents);`src/command-palette/modules/notes.commands.ts:170-180`(`notes.quick-switch`,mod+O);`NotesSearchOverlay.tsx:28-34,100-109` |
| S2 | 全文搜索 + 操作符 `tag:` / `path:` / `key:value`(引号值、URL 防误伤) | **已有** | Obsidian 搜索操作符;Notion 数据库过滤的低配形态 | `NotesSearchOverlay.tsx:28`(quick-open/full-text 双模式,Ctrl+Tab 切换见 `NotesWorkspaceApp.tsx:2381-2389`);`parseTagQuery.ts:25-30`(操作符语法) |
| S3 | 搜索结果打开后正文命中高亮/定位 | **已有** | Obsidian 搜索跳转定位 | `NotesWorkspaceApp.tsx:1962-1964`(`publishNotesFindQuery`);`src/features/notes/findQueryBridge.ts` |
| S4 | 前进/后退导航历史(`mod+alt+←/→`,栈上限 100)+ 标签循环(Ctrl+PageUp/Down、mod+shift+[]、Ctrl+Tab) | **已有** | Obsidian tab history(1.9.10 改进 modifier 语义) | `hooks/useNotesNavHistory.ts:23-26`;`NotesWorkspaceApp.tsx:2313-2321,2357-2398` |
| S5 | 快速切换结果的拖拽(拖到分屏/树) | **缺失** | Obsidian 1.12「Quick switcher: Dragging results is now supported」 | `NotesSearchOverlay.tsx` 结果行无 draggable;树内拖拽仅 `tree/dropPosition.ts` 一套 |
| S6 | Omnisearch 式模糊/语义全文(跨 PDF 等资源) | **部分** | Obsidian 社区 Omnisearch 为 2026 必装插件([dsebastien 盘点](https://www.dsebastien.net/the-must-have-obsidian-plugins-for-2026/)) | 全局命令面板有 dstu + 聊天 FTS5 双通道(`src/command-palette/hooks/useResourceSearch.ts:43-71`),但 Notes overlay 的 full-text 只按名称/内容 substring,不做 fuzzy 评分(`NotesSearchOverlay.tsx:100-109` 仅前缀/包含四档) |

### 1.3 命令面板

| # | 能力 | 状态 | 对标证据 | 本仓现码 |
| --- | --- | --- | --- | --- |
| C1 | Notes 领域命令(17 条:新建/搜索/保存/侧栏/背链/大纲/导入导出/插入数学·表格·代码·链接·图片/导图切换),按宿主与活动资源类型 gating | **已有** | Obsidian command palette;Notion `Cmd+P` | `src/command-palette/modules/notes.commands.ts:28-45(动作枚举),144-344(命令表)`;工作区消费 `NotesWorkspaceApp.tsx:1967-2046` |
| C2 | 命令面板内直达资源/会话搜索 | **已有** | Notion `Cmd+P` 混合搜索 | `src/command-palette/hooks/useResourceSearch.ts:43-71,90-119`(notes/mindmap 经 workbenchBus.launch 路由进 Notes 工作区) |
| C3 | 面板内 Agent 入口(Notion `Cmd+J` 直接把命令面板升级成 Agent 对话) | **缺失** | [Notion Agent 帮助](https://www.notion.com/en-gb/help/notion-agent):`Cmd+J` 唤起,`@` 加上下文 | 命令面板无 agent 命令类别;快捷助手是独立窗口(`NotesCrepeEditor.tsx:51` 引 `openQuickAssistantWindow`),与面板不打通 |
| C4 | 命令 → Agent 能力的同源注册(命令面板动作与 agentManifest capabilities 各写一份) | **部分** | Obsidian CLI(1.12)把「命令即自动化接口」统一化 | 命令走 `NOTES_WORKSPACE_COMMAND_EVENT`(notes.commands.ts:26,91-122),Agent 走 `agentManifest.ts:86-174`;两份清单没有共同注册表,能力漂移只能靠人肉对齐 |

### 1.4 图谱

| # | 能力 | 状态 | 对标证据 | 本仓现码 |
| --- | --- | --- | --- | --- |
| G1 | 局部图谱(1–2 度、确定性同心圆布局、幽灵节点、截断提示、后端图优先/客户端降级) | **已有** | RemNote `/view graph` 局部图;Obsidian local graph | `src/features/workbench/apps/notes/graph/localGraph.ts:45-52(预算),105-188(BFS),202-281(布局)`;`NotesGraphTab.tsx:132-233` |
| G2 | 全库图谱(global graph) | **缺失** | Obsidian Graph view;RemNote Knowledge Graph(Ctrl+K → View Global Graph,[帮助](https://help.remnote.com/en/articles/8771354-knowledge-graph)) | 仅局部图,`LOCAL_GRAPH_MAX_NODES = 80`(localGraph.ts:46);无全库入口 |
| G3 | 边类型区分(层级/标签/引用/嵌入分色) | **缺失** | RemNote 图谱四色边 | `localGraph.ts:25-29` 的边只有 source/target,无类型;数据源本可区分 wikilink/noteref(`backlinksBackend.ts:35`) |
| G4 | 非笔记资源入图(Canvas/导图背链) | **部分** | Obsidian 1.12「Canvas 背链进 Backlinks/Graph」 | 导图与笔记同在工作区(`workspaceRegistry`),但图谱只吃 note 类型(`NotesGraphTab.tsx:146`:`activeResource?.type === 'note'` 才有图) |

### 1.5 属性 / 数据库化视图

| # | 能力 | 状态 | 对标证据 | 本仓现码 |
| --- | --- | --- | --- | --- |
| P1 | 标签(系统标签过滤、`_` 前缀隐藏、`daily_log` 隐藏) | **已有** | Obsidian tags | `hooks/useNoteTags.ts:17-22`;`TagFilter.tsx`;树过滤 `NotesWorkspaceApp.tsx:1052-1062` |
| P2 | 自定义键值属性(上限 32、保留键、控制字符校验,搜索 `key:value` 消费) | **已有** | Obsidian properties(YAML) | `NoteCustomPropsEditor.tsx:1-30`;`NotesPropertiesTab.tsx:1-26`;`parseTagQuery.ts:8-23` |
| P3 | 属性驱动的库级视图(过滤器持久化、公式列、表格/看板视图) | **缺失** | Obsidian Bases(1.9.x 核心插件,`.base` 文件,[changelog](https://obsidian.md/changelog/2025-08-18-desktop-v1.9.10/));Notion database views | 属性只用于单笔记编辑与搜索操作符交集过滤;无任何视图定义/持久化结构 |
| P4 | 收藏夹分组 | **已有** | Obsidian Bookmarks 的子集 | `FavoritesSection.tsx:8-20`;`hooks/useNoteFavorites.ts`;上下文菜单 `NotesWorkspaceApp.tsx:2244-2250` |
| P5 | 模板(8 内置 + `{{date/time/title}}` 变量) | **已有(内置固定)** | Obsidian Templater/QuickAdd 为社区最高价值插件;差距在「用户自定义模板」 | `src/features/notes/noteTemplates.ts:1-40`;面板 `components/NotesTemplatePanel.tsx` |
| P6 | 日记/每日笔记(daily note 快捷入口、日期路由) | **缺失** | Obsidian Daily notes 核心插件;RemNote Daily Docs | 全仓 notes 目录 `rg "daily|日记"` 仅命中周计划模板文案与 `daily_log` 隐藏标签(useNoteTags.ts:21) |

### 1.6 AI 侧栏 / Agent 结合

| # | 能力 | 状态 | 对标证据 | 本仓现码 |
| --- | --- | --- | --- | --- |
| A1 | AI 编辑建议 → HITL diff 面板(接受/拒绝、行级 diff、快捷键) | **已有** | Notion AI 行内建议;Copilot 写回 vault 前预览 | `src/features/notes/AIDiffPanel.tsx:1-36`;事件链 `src/features/generative-ui/utils/dispatchCanvasAIEditRequest.ts:43-74` → `src/features/notes/hooks/useCanvasAIEditHandler.ts:384-409` |
| A2 | GenUI 只读块(笔记摘要卡、diff 摘要卡;确定性、不写入) | **已有(只读)** | Notion 3.6 可交互 HTML block 是「可写」形态,本仓明确停在只读 | `src/features/notes/components/NotesGenerativeSummary.tsx:17-27`(注释:「只读生成式 UI 摘要…不写入笔记」);写路径统一收口在 `src/features/generative-ui/handlers/notesEditActionHandlers.ts:1-3`(「不直写后端」,经 A1 的 HITL 通道) |
| A3 | Agent 观察/导航清单(observe:标签+标题+导图节点;execute:openResource/scrollToHeading/focusNode/setView/search 等,幂等 no-op、undo、postconditions) | **已有** | Notion Agent「anything you can do, agent can do」的读/导航子集 | `src/features/workbench/apps/notes/agentManifest.ts:86-174(capabilities),175-288(observe),289-445(execute)` |
| A4 | 常驻对话式 AI 侧栏(库内多轮、@引用笔记上下文) | **缺失** | Notion `Cmd+J` Agent 侧栏;Copilot v4 多标签 agent | 现有 AI 均为「一次性请求」形态:AI diff、GenUI 摘要、快捷助手独立窗口;Notes 工作区右栏只有 properties/links/graph 三页签(`NotesBacklinksPanel.tsx:142`) |
| A5 | 笔记内嵌 Agent 块 / Agent 按钮 | **缺失** | obsidian-agent-client 0.12:` ```agent-client ` 代码块内嵌会话、一键按钮([release](https://newreleases.io/project/github/RAIT-09/obsidian-agent-client/release/0.12.0)) | crepe 插件目录无对应 feature;GenUI 块不可写(见 A2) |
| A6 | 笔记 → 闪卡生成(RemNote 核心卖点) | **已有(接线级)** | RemNote AI 闪卡/测验;Guided Learn | `src/features/notes/generateCardsFromNote.ts:1-15`(复用 anki CardForge 通道;注:anki/qbank 服务层本轮禁改,仅指认接缝) |
| A7 | Agent 把 `[[wikilinks]]` 上下文喂给模型(链接即上下文图) | **缺失** | obsidian-agent-client:提及笔记内的 wikilink 解析为文件路径给 agent 决策 | `agentManifest.ts` observe 只报标题/标签,不报当前笔记的出链;而数据本就有(`backlinksBackend.ts:51-56`) |

## 2. 第 2–5 轮可静态落地子集(不依赖编译/实测)

判定标准:纯 TS/TSX/CSS/文档改动、复用既有事件与数据链、不动禁改区(coordinator.rs、tool_loop、移动 44px/chrome、anki/qbank 服务层、questionBankStore),可用现有同层测试样式补 vitest 用例文本(写测试文件不等于运行)。

按「低风险 → 高价值」排序:

1. **G3 边类型分色(小)**:`backlinksBackend.ts` 的 `linkType` 已到手,`localGraph.ts` 的 `LocalGraphEdgeDatum` 加 `kind: 'wikilink' | 'noteref'` 并在 `NotesLocalGraph.css` 分色。纯前端纯逻辑,`__tests__/localGraph.test.ts` 有现成模式可仿写。
2. **A7 observe 增补出链(小)**:`agentManifest.ts` 的 observe 在 active note 分支已解析 markdown(`:199-215`),用 `parseNoteLinks`(`wikilinks.ts:333-336`)把出链 target 列表并入 `state`/entities(只读,不加 capability),Agent 立即获得「本篇链接到哪」的上下文。
3. **C4 命令↔Agent 清单对齐文档 + 单测(小)**:静态写一张映射表(命令 id ↔ agent capability ↔ workspace command action),配一条纯 import 的一致性 vitest(枚举比对),防两份清单漂移。
4. **L4 笔记级 aliases 的解析层(中)**:`createWikiLinkIndex` 增加可选 `aliases` 入参(从 `metadata.props.aliases` 读),resolve 顺序 ID > 标题 > 别名;`wikilinkNotesCache.ts` 与 `defaultGetNotes.ts` 透传。全程纯函数,`__tests__/wikilinks.test.ts` 可静态扩展。UI 补全档位可后置。
5. **S5 快速切换结果拖拽(中)**:`NotesSearchOverlay` 结果行加 `draggable` + `WB_RESOURCE_MIME`(`NotesCrepeEditor.tsx:48` 已用同一 MIME 解析拖放),与现有 `useDesktopDrop` 对接。纯 DOM 属性 + 数据打包。
6. **P6 日记入口(中)**:命令面板加 `notes.open-daily`,动作 = 按 `YYYY-MM-DD` 标题 create-or-open(复用 `createNoteFromWikilinkTitle` 的 in-flight 合并语义,`createFromWikilink.ts:42-108`),模板取自 `noteTemplates.ts` 新增 daily 模板。不碰后端。
7. **P3 Bases 的最小静态雏形(大,只做纯逻辑层)**:先落「视图定义类型 + 过滤求值纯函数」(复用 `parseTagQuery.ts` 的 props 交集语义),不做 UI/持久化;为后续轮的表格视图铺路。此项止步于可单测的纯模块,UI 留给有实测条件的轮次。

明确**不**建议静态轮碰的:L9 块引用(要动 crepe schema 与后端 note_links 图,必须实测)、G2 全库图谱(性能不实测无法定预算)、A4/A5 AI 侧栏与嵌入块(依赖会话运行时,且 GenUI 可写通道被冻结)。

## 3. Agent 原生结合点(现有管道盘点)

- **workbenchBus**:`launch/activate` 三分语义已把 note/mindmap 路由进统一 Notes 工作区(`src/features/workbench/core/workbenchBus.ts:184-200,388`;经 `activateWorkspaceResource`/`requestWorkspaceResource`,`workspaceRegistry.ts:117` 起)。命令面板打开资源也走同一条(`useResourceSearch.ts:90-110`)。**结合点**:任何新 Agent 动作(如「打开某日日记」「按标签过滤」)应表达为 workspace command action 或 activation,而不是新全局事件——`NOTES_WORKSPACE_COMMAND_EVENT` 的枚举(notes.commands.ts:28-45)就是现成的动作总线。
- **AgentBridge(ACR)**:传输层 listen→emit、进度 ≤5Hz 节流(`src/features/workbench/agent/bridge.ts:1-32`)。Notes 的 agentManifest 已挂进 appDefinition(`register.ts:38`),observe/execute 契约完整(undo、postconditions、幂等 no-op 判定,`agentManifest.ts:359-398`)。**结合点**:第 2 节的 A7(observe 报出链)与 C4(能力对齐)都是在这套契约内做增量,不新开协议。
- **GenUI 只读块(仍不可写)**:边界在两处并保持不变——`NotesGenerativeSummary.tsx:17-19` 注释明确「只读、不写入」;所有写意图必须折返 `notesEditActionHandlers.ts` → `canvas:ai-edit-request` → `useCanvasAIEditHandler.ts:384` → AIDiffPanel 人审。本轮调研确认:对标 Notion 可交互 HTML block / agent-client 嵌入块的「GenUI 可写」形态,**在当前冻结下不可做**;可做的是丰富只读块种类(如「本篇背链摘要卡」「图谱统计卡」,数据源 `backlinksBackend.ts` 全部现成)。

## 4. 与 learning-notes.md 四条 P1 的交叉(点到为止,非本主责)

对照 `docs/0824-quality-review/learning-notes.md`(稿对 `2d41ea8b`;下列现码行号已复核仍准):

1. **关标签不 fail-closed**(learning-notes.md:32-42):属 Learning Hub 宿主问题,但对本调研的含义是——Workbench Notes 的 `canClose` 门(`register.ts:13-23`)+ `contentDirtyRegistry` 是正确参照系;后续给 Notes 增加任何 Agent 触发的「关闭/切换」capability 时,execute 必须走同一 close gate,不能绕过 `hasUnsavedNotesWorkspaceChanges()`(register.ts:14)。
2. **保存落点两步非原子**(learning-notes.md:44-50,`saveTextAsNote.ts:68-127`):与本清单 P6(日记)和第 2 节第 6 项直接相关——新增「create-or-open」型入口时应直接带 `folderId` 一次创建(`createFromWikilink.ts:53` 的 `createEmpty({ folderId })` 分支就是正确姿势),不要复刻「先建根目录再 move」的旧模式。
3. **书签跨窗口覆盖**(learning-notes.md:20-30):落在阅读器持久化,不在本主责;仅提示:Notes 工作区自身持久化(`WORKSPACE_STORAGE_KEY`,NotesWorkspaceApp.tsx:185)同为整对象覆盖写 localStorage,若后续做 Bases 视图持久化(第 2 节第 7 项),应从一开始就按 key 分片,别再造一个整块覆盖点。
4. **PDF 双套笔记动作 / 标题取资源 ID**(learning-notes.md:52-63):牵动的是 `saveTextAsNote.ts:40-54` 的标题推导。对本主责的交叉:未来若做「摘录 → 笔记 + 自动 wikilink 回源」,来源标题必须传显示名而非 `resourcePath` 尾段,否则背链图会长出一批 ID 名幽灵节点(`localGraph.ts:54-56` 的 ghost 节点按标题小写生成,ID 名会污染图谱)。

## 5. 本轮结论

- 本仓 Notes 的**双链/背链/未链接提及/重命名回写/局部图谱/快速切换/命令面板**已达到 Obsidian 核心插件层的主体水位,且并发与降级语义(OCC、in-flight 合并、后端图优先)普遍比对标产品的社区插件更严谨。
- 真差距集中在四块:**块粒度引用(L9)**、**属性数据库化视图(P3)**、**全库图谱(G2)**、**Agent 常驻/可写形态(A4/A5)**。其中前三块是产品能力缺口,第四块受 GenUI 只读冻结约束,本阶段只能做只读增量(A7、只读块扩充)。
- 第 2–5 轮建议按第 2 节顺序推进,前三项(边分色、observe 出链、命令↔Agent 对齐)风险最低且全部复用现有数据链。
- 重申:**本轮只调研不改码**,本文为唯一产出文件。
