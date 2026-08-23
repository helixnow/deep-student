# Round 26 落地（claude-fable-5-thinking-xhigh）

## 已修

- PageNavigator 页码输入 / 预览 / 重试 coarse 44
- FinderToolbar 嵌入态搜索 `min-h-11`（titlebar 模式保持 40 以免撑破 38px 栏）
- LanguageSelect 触发 40→44；SourcePanel 清空确认 36→44
- SessionBrowser 分组 segmented 40→44
- McpToolsSection 级别/分组/清除 chip 36→44；Switch 已合规未改
- SegmentedControl compact 已有 min-h-11，本轮无改
- Todo BulkActionBar 清除、子任务输入、IconRail、主栏搜索、时区搜索；Anki 任务搜索
- WorkbenchSettings 滑块、BackupTab 导出/导入/刷新、沙箱清会话、SkillSelector 簇、SkillTapBrowser chip
- tauriDragFix 删除已无匹配的 `.rct-tree*` 选择器

## 仍开（Round 27+）

- InlineImageViewer 灯箱底栏 36；LearningHub 面包屑段；MemoryView 空态 CTA
- McpToolsSection 加环境变量文本钮；题库导出全选；TagNavigation 重命名输入
- IndexStatusView 测试搜索；PromptPanel 大量 32–40；SkillsSidebar 位置筛选
