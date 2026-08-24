# Round 58 落地（claude-fable-5-thinking-xhigh）

## 已修

- MessageActions 桌面复制 / 重试 / 编辑图标
- MessageTouchActionBar 触控操作条
- LibraryScreen 关闭错误 / 重试 / 清筛选 / 分页
- TranslationPopover 底栏复制源文 / 译文 / 填入
- ExamSheetUploader 清空 / 拍照 / 导入 / 重试等
- ImageContentView 工具栏（补 coarse，不靠 max-md）
- ResourceAppWorkspace 主区重试 / 空态新建
- ReviewQuestionsView 开始复习
- ReviewPlanView 暂停图标 / 空态日历
- UnifiedSourcePanel 非 compact 定位 / 打开

## 仍开（Round 59+）

- 内联引用 chip 设计未决；MiniCalendar/TabBar 宽 28 有意折衷
- FinderToolbar 视觉 40 + 伪元素 48：标题栏约束，勿再硬叠 44 视觉
- ShortcutSettings 属 #166 不碰
- WorkbenchSidebar 桌面壳分区头属 #161，不碰
- 翻译 SourcePanel / ComparisonView 已用 COARSE_HIT 凑 44，勿重做视觉
- DataGovernanceDashboard debug 场景按钮属 #166，不碰
- 继续扫生产路径残留：无 coarse 的 `!py-1`/`h-6`/`h-7`、hover-only、iPad `lg:`/`md:min-h-0`/`sm:min-h-0`/`max-md:` 把 DsButton 压到 30–32
