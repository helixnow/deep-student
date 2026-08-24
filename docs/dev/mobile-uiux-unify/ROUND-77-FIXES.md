# Round 77 落地（claude-fable-5-thinking-xhigh）

## 已修

- subagentEmbed 取消控件（`px-1.5 py-0.5` + `text-xs` ≈ 20px；伪元素扩 coarse 命中，对齐 open-full）
- MemoryView 搜索结果行 / 列表展开行（`py-2.5` ≈ 40px；文件夹/笔记/审计行已有 coarse 未动）
- workspaceStatus 主展开头（`p-3` + 16px 图标 ≈ 40px；「最近消息」头已有 coarse 未动）
- ChatCollapsible 折叠头（`py-2.5` ≈ 40px）
- QueuedMessageBubble 队列气泡（`py-2` + `text-sm` ≈ 36px）
- OcrSettingsSection SwitchRow 整行（`py-2.5` 仅标题 ≈ 40px；未动 Switch.css / range slider）
- TodoSidebar 行内删除/取消确认（coarse `min-h-[2.5rem]` = 40px → `min-h-11`）
- BlockingAskUserBar 多选 label / 单选行（`py-2.5` 无 min-h 地板）
- TodoItemRow 主行（`py-2.5` ≈ 40px；滑动删除/日期已有 coarse 未动）
- InputBarUI 上下文用量环（视觉保持 `h-8 w-7`，`after:-inset-2` 扩 coarse 命中）

## 仍开（Round 78+）

- 内联引用 chip 设计未决（QbankCitationBadge / MindmapCitationCard 勿硬叠 44 视觉）；MiniCalendar/TabBar 宽 28 有意折衷
- FinderToolbar 视觉 40 + 伪元素 48：标题栏约束，勿再硬叠 44 视觉
- ChatAppWindow 标题栏开关同样保持视觉 28 + 伪元素，勿再硬叠 44 视觉
- ShortcutSettings 属 #166 不碰
- WorkbenchSidebar 桌面壳分区头属 #161，不碰
- 翻译 SourcePanel / ComparisonView 已用 COARSE_HIT 凑 44，勿重做视觉
- DataGovernanceDashboard debug 场景按钮属 #166，不碰
- FilePreview 标题栏若挤布局，保持 coarse 44 命中即可，勿再叠视觉
- ReciteStatusBar / `.mm-collapse-btn` / ImageViewer / UnifiedPreviewToolbar / EnhancedPdfViewer / BatchOperationToolbar 主条 / EpubPreview / CodeBlock / LibraryCardRow **行内** / FindReplacePanel / VideoPlayer / AudioPlayer / FinderBatchToolbar / Card3DPreview / DstuAppLauncher / UnifiedMobileHeader / VersionHistoryPanel 关闭与行动作 / AgentStrip / ResourceAppWorkspace 侧栏钮：已有 CSS 或 `shellIconButtonClassName` 覆盖
- CloudStorage 提供商卡 `!p-3 !h-auto` 通常已够高，勿当新活
- AccentPicker `DOT_BASE_CLASS` 已是 coarse 44，勿重做
- HeaderTemplate 小屏应隐藏，勿当新活
- WorkbenchModeSwitchRow / App.tsx `desktop-shell-*` 属桌面壳
- OCR/PDF `settings-range-slider` 已有 coarse padding 扩命中，勿当新活
- ChatErrorBoundary / MindMapErrorBoundary 的 `<summary>` 仅 DEV 栈，勿当生产新活
- SkillsList 默认徽章 / SiliconFlow 折叠头 / 题库卡片 / ShadApi 能力卡：行高或双行已够，勿当新活
- 继续扫生产路径残留：无 coarse 的原生 `<button>` / `role="button"` / `cursor-pointer` 行、`!py-1`/`h-6`/`h-7`、hover-only、iPad `lg:`/`md:`/`isSmallScreen`/`max-lg:` 洞、CSS 32px 色板/自绘钮。opening-tag 扫描会因 `onClick={() =>` 的 `>` 截断产生假阳性，必须读文件核。
