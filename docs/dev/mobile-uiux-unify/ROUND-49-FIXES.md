# Round 49 落地（claude-fable-5-thinking-xhigh）

## 已修

- InlineDocumentViewer 复制 / 打开 / 下载 / 关闭
- SkillSelector footer 刷新 / 商店 / 关闭
- NotesLibraryManager 关闭与导入导出动作
- McpToolsSection 表单/JSON、删除确认、保存、权限抽屉、加规则
- EnhancedPdfViewer 密码框取消/提交与加载重试
- MemoryView 建夹空态行 / 取消 / 创建
- LibraryScreen 刷新 / 搜索 / 批量条
- LLMOutputPlayground 顶栏面板开关
- VoiceInputSettingsSection 授权 / 复制 / 跳转 / 清空
- MessageItem 失败重试与内联确认

## 仍开（Round 50+）

- 内联引用 chip 设计未决；MiniCalendar/TabBar 宽 28 有意折衷
- FinderToolbar 视觉 40 + 伪元素 48：标题栏约束，勿再硬叠 44 视觉
- ShortcutSettings 属 #166 不碰
- WorkbenchSidebar 桌面壳分区头属 #161，不碰
- 翻译 SourcePanel / ComparisonView 已用 COARSE_HIT 凑 44，勿重做视觉
- 继续扫生产路径残留：McpEditorSection OAuth、IndexStatusView 透视钮、TemplateInlinePanels footer、DstuAppLauncher 导航行、无 coarse 的 `!py-1`/`h-6`/`h-7`、hover-only
