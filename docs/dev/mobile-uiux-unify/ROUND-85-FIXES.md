# Round 85 落地（claude-fable-5-thinking-xhigh ×10，整区域打包）

本轮按用户加码：**每个子代理吃一整块目录/相关文件簇**，扫并修该区内全部残留触控洞，不再一人一行。10 个 fable 合计约 **140+ 文件、600+ 处**（设置 268、学习中心 99、聊天 66+、其余整目录复扫）。

## 已修

### Crepe 整目录（`905caa9c`）
- callout fold：`hover: none` → 仅 `pointer: coarse` 常显；icon/fold 用 `::after` 扩命中 44（修 iPad 触控板洞）
- 块菜单 `min-height: 44` 补 `!important`；笔记顶栏钮 / 划词气泡 toolbar-item 40→44
- 代码块语言钮、工具组、语言列表项、搜索清除、链接浮层钮、溢出菜单项、lightbox 关闭、wikilink 确认、toggle 箭头：coarse 44

### 设置整区（`9cb00471`，40 文件 / 268 处）
- 生产 tab/section 的 DsButton / SelectTrigger / AppSelect / UnifiedModelSelector：coarse `h-11`/`min-h-11` 全部补 `!`（压过 `lg:` 的 30–32，修 iPad 横屏洞）
- Settings MCP 策略弹窗 label、McpTools OAuth 安装 label：整行可点补 `min-h-11`
- 未碰 ShortcutSettings / DataGovernanceDashboard debug / Input 的 `lg:min-h-[var(--button-height)]`

### 学习中心整区（`218c3b8a`，21 文件 / 99 处）
- MemoryView / IndexStatus / 题库·翻译·图片·作文·笔记内容页 / Finder / Dstu / 音视频：DsButton coarse 补 `!`
- LearningHubContextMenu 菜单项（`wb-desk-menu-item` ~30px）补 coarse `min-h-11`

### 笔记整目录（`fff09967`）
- NotesContextPanel 大纲预览常显改为仅 `pointer: coarse`（iPad 洞）
- NotesCrepeEditor / Toolbar / AIDiff / FindReplace / LibraryManager：DsButton coarse 补 `!`

### Todo 整目录（`81fc24db`）
- TodoTrashDialog：`min-h-[2.5rem]`（40）→ `!min-h-11`（44）共 7 处
- 子任务勾选热区 40→44；分组折叠伪元素凑 44
- TodoItemRow 行尾 Play/Trash、RowPriorityMenu：lg+coarse 被 `lg:h-8` 钳到 32，补 coarse `min-h-11`

### 导图 CSS 整簇（`da890e9f`）
- `.mm-search-nav-button` 补进 coarse 44（原先只盖 close）
- 学习钮 / 演示退出 / 结构预设 / 主题项 / 字号控件 / 横幅 ds-btn / 面包屑容器
- outline 拖拽手柄 `::after` 24+16=40 → 24+20=44
- 画布/大纲面包屑 House 钮补 `min-w-11`

### 聊天输入+插件（`651d5852`，42 文件）
- plugins 生产 blocks/chat 面板 DsButton `min-h-11` 全部补 `!`（66 处）
- AgentTaskPanel「加载更多文件」无 coarse → `min-h-11`；artifact chip / Runtime 折叠头补 `!`
- input-bar / ActivityTimeline / session-browser / SkillSelector 同类补 `!`

### 技能管理整目录（`299715a6`）
- EmbeddedToolsEditor / SkillTapBrowser：保留 `max-lg`，coarse 全部加 `!`（修 iPad 横屏）
- SkillEditorModal TabsTrigger、SkillFullscreenEditor、SkillsList 编辑/更多：补 `!`

### 工作台 CSS 残留（`277d49ad`）
- DesktopAgendaWidget：原 coarse 块写在基线**前**被压回 28，整块移到末尾并补月份/打开/正文/更多/勾选
- WindowLifecycle 崩溃重载、Dock「显示全部」、笔记标签/树箭头/重命名输入、反链 tab、搜索 16px zoom、TagFilter 清除/胶囊

### 模板 / Anki / 用量 / 闪卡（`4a9c0cf3`）
- TemplateManagement 顶栏图标与搜索：coarse `h-11` 补 `!`
- Anki 搜索 Input、FailedTasksPanel 漏网重试钮补 `!`
- LlmUsageStatsSection 图例行 40→44
- 闪卡调度/库搜索/标签编辑 Input 补 `!`

## 仍开（Round 86+）

- 内联引用 chip 设计未决（QbankCitationBadge / MindmapCitationCard 勿硬叠 44 视觉）；MiniCalendar/TabBar 宽 28 有意折衷
- FinderToolbar 视觉 40 + 伪元素 48：标题栏约束，勿再硬叠 44 视觉
- ChatAppWindow 标题栏开关保持视觉 28 + 伪元素
- ShortcutSettings 属 #166 不碰
- WorkbenchSidebar 桌面壳分区头属 #161，不碰
- 翻译 SourcePanel / ComparisonView 已用 COARSE_HIT 凑 44，勿重做视觉
- DataGovernanceDashboard debug 场景按钮属 #166，不碰
- FilePreview 标题栏若挤布局，保持 coarse 44 命中即可
- ReciteStatusBar / `.mm-collapse-btn` / ImageViewer / UnifiedPreviewToolbar / EnhancedPdfViewer / BatchOperationToolbar 主条 / EpubPreview / CodeBlock / LibraryCardRow **行内** / FindReplacePanel / VideoPlayer / AudioPlayer / FinderBatchToolbar / Card3DPreview / DstuAppLauncher / UnifiedMobileHeader / VersionHistoryPanel / AgentStrip / ResourceAppWorkspace 侧栏钮：已有 CSS 或 `shellIconButtonClassName`
- CloudStorage 提供商卡 / AccentPicker / HeaderTemplate 小屏隐藏 / WorkbenchModeSwitchRow / `desktop-shell-*` / OCR `settings-range-slider`：勿当新活
- ChatErrorBoundary / MindMapErrorBoundary `<summary>` 仅 DEV
- SkillsList 默认徽章 / SiliconFlow 折叠头 / 题库卡片 / ShadApi 能力卡：行高或双行已够
- MemoryFolderBanner textarea：Round 79 已补 16px zoom
- StatusBar 菜单栏 / 窗口控制 26px 属桌面壳
- ComponentCompareTab（style-lab）分段属 DEV
- flashcards / library / settings / scrollbars 残留 `hover: none and coarse` 只是藏键盘提示
- 生产路径项目级 `SegmentedControl` 调用处已基本补完 `!min-h-11`；新调用处仍须带 `!`
- 聊天范围外残留（MessageItem / MessageActions / Variant / ToolApprovalCard / InlineDocumentViewer / ChatV2Page / SessionSidebarContent 等）仍可能有非 `!` 的 DsButton `min-h-11`——Round 86 按整目录继续吃
- 继续扫生产路径：无 coarse 的原生 `<button>` / `role="button"` / `cursor-pointer` 行、`!py-1`/`h-6`/`h-7`、hover-only、CSS 32px 色板/自绘钮。opening-tag 扫描会假阳性，必须读文件核
- **下一轮仍须整区域打包**：每个 fable 吃一目录/一组相关文件，扫并修该区全部真洞，确保 10 个完成后整体巨大且可靠进展
