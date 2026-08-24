# Round 88 落地（claude-fable-5-thinking-xhigh ×10，整区域打包）

本轮 DsButton 缺 `!` 已基本收完，改为整目录吃**原生钮 / CSS 残留 / 原语**。10 个 fable **全部有提交**。最大杠杆：`SelectItem` 原语一次盖全站下拉项。

## 已修

### UI 原语（`92373056`）
- **SelectItem**：仅 `py-1.5`（~32px）→ coarse `!min-h-11`（全站 Select 下拉一次修好）
- Select 滚动钮 ~24px → coarse `min-h-11`
- SnappySlider 滑轨/数值框补 coarse `min-h-11`（视觉轨道不变）
- ComponentCompareTab 13 处 DsButton 顺路补 `!`（DEV 对照页）

### debug-panel 前半 A–L（`4a563ef1`）
- CrepeDragDrop / CrepeEditor：过滤胶囊、日志行复制钮补 44

### debug-panel 后半 M–Z + Host（`4abf78c4`）
- 多插件日志展开行、Switch/Checkbox 包裹 label 补 `min-h-11`
- DebugPanelHost 搜索框、收藏星标补 44

### 工作台 CSS（`80fbbdbd`）
- 笔记搜索标签胶囊/移除钮；桌面右键菜单行 ~30→44
- StatusBar 菜单项用伪元素扩命中（不硬叠 26px 视觉）；时钟 flyout 议程行
- 空桌面 CTA / tour；平铺中缝把手 20→44；资源搜索 16px 防 iOS zoom；DEV HUD

### 聊天原生（`e324999a`）
- BlockingAskUserBar 单选选项钮用伪元素凑 44
- TagFilter「+」伪元素 32→44

### 共享原生（`19a7102c`）
- InlineSettingsPanel 维度拖拽把手补 44
- Card3DPreview `.nav-dot` 命中 40→44（圆点视觉不变）

### 学习中心 / 设置原生（`2e5083be`）
- IndexStatusView 资源主行补 `min-h-11`
- ExamContentView 练习模式 AppSelect 调用方 `h-11` 补 `!`（防 merge 压掉内部 `!h-11`）

### 笔记 / Todo / 导图原生（`7a57c6bf`）
- 子任务拖拽把手、Todo 行拖拽把手宽度不足 → coarse 44
- NotesEditorHeader 字数统计触发器 `::after` 扩命中

### 闪卡 / PDF / 模板（`63d70e00`）
- 复习内联 textarea coarse 16px 防 iOS zoom
- 模板工具栏搜索/排序 13→16px
- PDF 缩放/更多/大纲项挂在 DsButton 上，lg+coarse 被压到 30：补 `min-height: 44px`

### DSTU / 快捷助手（`0398abe1`）
- `.qa-asked` 提问引用块可点展开，不在 coarse 块 → 44

## 仍开（Round 89+）

- 内联引用 chip 设计未决（QbankCitationBadge / MindmapCitationCard 勿硬叠 44 视觉）；MiniCalendar/TabBar 宽 28 有意折衷
- FinderToolbar 视觉 40 + 伪元素 48：标题栏约束，勿再硬叠 44 视觉
- ChatAppWindow 标题栏开关保持视觉 28 + 伪元素
- ShortcutSettings 属 #166 不碰
- WorkbenchSidebar 桌面壳分区头属 #161，不碰
- 翻译 SourcePanel / ComparisonView 已用 COARSE_HIT 凑 44，勿重做视觉
- DataGovernanceDashboard debug 场景按钮属 #166，不碰
- StatusBar 26px 桌面壳：本轮已用伪元素扩命中，勿再硬叠视觉
- ReciteStatusBar / `.mm-collapse-btn` / ImageViewer 底栏 / UnifiedPreviewToolbar / EnhancedPdfViewer 主条 `.ds-btn` / EpubPreview / LibraryCardRow **行内** / FindReplacePanel / VideoPlayer / AudioPlayer / Card3DPreview 控制钮 / UnifiedMobileHeader：已有覆盖
- CloudStorage / AccentPicker / HeaderTemplate 小屏隐藏 / WorkbenchModeSwitchRow / `desktop-shell-*` / OCR slider：勿当新活
- ChatErrorBoundary / MindMapErrorBoundary `<summary>` 仅 DEV
- SkillsList 徽章 / SiliconFlow 折叠头 / 题库卡片 / ShadApi 能力卡：行高已够
- MemoryFolderBanner textarea：已 16px zoom
- flashcards / library / settings / scrollbars 残留 `hover: none and coarse` 只是藏键盘提示
- 生产路径 DsButton 缺 `!`、SelectItem、debug 原生钮、工作台 CSS 漏网已再收一波
- 继续扫：无 coarse 的原生 `<button>` / `role="button"` / `cursor-pointer` 行、hover-only、CSS 32px 色板。opening-tag 扫描会假阳性，必须读文件核
- **下一轮仍须整区域打包**：每个 fable 吃一目录/一组相关文件，扫并修该区全部真洞
