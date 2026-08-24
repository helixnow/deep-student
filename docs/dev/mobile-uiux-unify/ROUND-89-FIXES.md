# Round 89 落地（claude-fable-5-thinking-xhigh ×11 + 扫描跟进，整区域打包）

本轮先核再派：生产路径 DsButton/`SelectItem` 已连收三轮，改为整目录吃**行高洞、hover-only、iOS 16px zoom、CSS 层叠顺序、原语死规则**。派出 11 个落地 fable（含补派的学习中心 / 聊天插件）+ 1 个只读扫描 + 1 个扫描跟进。**10 个有代码提交**，聊天消息 chrome 复扫 CLEAN。

## 已修

### 题库（`ed4a57b9`）
- VirtualQuestionList 可点行仅 `py-2` → coarse `min-h-11`
- QuestionHistoryView 右上图标 DsButton `h-11` 补 `!`（防 lg 压到 icon-size）

### 侧栏会话（`128f9205`）
- ModernSidebar 置顶/归档簇：coarse 常显从「仅活动行」改为**所有行**（iPad 非活动会话此前无法置顶/归档）
- UnifiedSidebar 桌面档：行 `py-2` 补 coarse `min-h-11`；搜索 16px；头栏 40px 固定高补 coarse `min-h-11`

### 共享应用（`749ab2bd`）
- BatchOperationToolbar 搜索框 35px/14px → coarse 44 + 16px；卡片勾选 DsButton 补 `!min-h-11`
- Card3DPreview compact 档 40px 选择器特异性压过通用 coarse 44 → 文末 coarse 块恢复 44

### 闪卡 / 技能 / PDF / debug 输入（`53d7defc`）
- 6 个 debug 插件 `text-xs` 原生 input/textarea 补 coarse `text-[16px]` 防 iOS zoom

### 设置输入（`097c267e`）
- api-key-field 14px → coarse 16px（一次盖多家密钥框）
- Subagent/Automation 共享 `inputClassName`、SettingsSidebar 搜索、系统 markdown `<select>` 补 coarse 16px / `min-h-11`

### 学习中心（`2956709e`）
- PptxPreview 超宽幻灯片缩略图高度可跌破 44 → coarse `min-h-11` 居中信箱

### 工作台 CSS 层叠（`ca00bc70`）
- `.wb-sys-drawer-close` coarse 44 写在 22×22 基线**前面**，同等特异性被基线赢 → 挪到后面
- 笔记资源搜索框 coarse 16px 防 iOS zoom

### 扫描跟进：弹窗 Label + 分段原语（`52a26eef`）
- ShadApiEditModal 16 个推理/思维 Label、VendorConfigModal、McpEditor advertiseAll
- 翻译 PromptPanel / TargetPanel 开关 Label
- SegmentedControl 原语 coarse 升为 `!min-h-11`（`app.css` `.study-shell-segmented-button { min-height: 0 }` 会杀死非 important）
- debug 十余处裸 `<summary>` 补 44；UnifiedDragDrop 悬停图标 coarse 常显

### 笔记 / Todo（`d9c64d14`）
- AutomationScheduleEditor 字段、AutomationRunHistory 筛选 `<select>` 补 coarse `text-base`

### 导图 / Crepe（`e672b403`）
- VersionHistoryPanel 关闭/预览/恢复：仅 max-md 44，iPad 横屏仍 28 → 加 coarse `!min-h-11`
- Crepe 待办勾选 24×32 → `::after` 44（只扩可切换的 checkbox 包装）
- 图片块说明开关 / 缩放条 hover-only → coarse 常显 + 44 命中

### 聊天插件 / 输入栏（`086d6563`）
- subagentEmbed / sleepBlock / AgentTaskPanel 伪元素 inset 从 42 凑到 ≥44
- InputBarUI 运行时模型搜索：`.ds-search-input` 规则只在 PDF CSS，聊天页 13px/~30 → 行内 `!h-11 !text-base`
- ThinkingDepthSlider 轨 41→44；GroupEditorDialog `<select>` 16px；ActiveSkillBadge 可点时 `min-h-11`

### 聊天消息 chrome（无提交）
- MessageItem / MessageActions / ParallelVariantView / ActivityTimeline 等复扫：isCoarsePointer 常显与 `!min-h-11` 已齐

## 仍开（Round 90+）

- 内联引用 chip 设计未决；MiniCalendar/TabBar 宽 28；FinderToolbar 视觉 40 + 伪元素 48
- ShortcutSettings / command-palette 属 #166 不碰
- WorkbenchSidebar 桌面壳分区头属 #161
- 翻译 SourcePanel / ComparisonView COARSE_HIT 勿重做视觉
- `deep-student.css` 里 `.w-5.h-5` / `.w-6.h-6` 等 `min-height: !important` 可能压过非 `!h-11` 的 coarse `min-h`（扫描未找到确认受害者，须按元素核）
- ThinkingChain.css `.anki-card-panel__*`、MinimalTemplateEditor.css `.icon-button` 疑似死 CSS，确认后删或补 coarse
- 生产路径继续扫：无 coarse 的 `Label`/`<summary>`、hover-only、CSS 基线写在 coarse **后面**
- **下一轮仍须整区域打包**
