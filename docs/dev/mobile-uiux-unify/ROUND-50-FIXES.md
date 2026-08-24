# Round 50 落地（claude-fable-5-thinking-xhigh）

## 已修

- McpEditorSection OAuth / 加环境变量 / 桌面保存 / 紧凑删除
- TemplateInlinePanels 导入导出 footer 与选文件
- DstuAppLauncher 刷新 / 新建 / 导航行 / 创建菜单
- IndexStatusView 透视 OCR/块、重试、统一索引、更多
- VendorDetailPanel 收藏 / 测试 / 删除图标（补 coarse，不靠 max-sm）
- AutomationRunHistory 重试 / 取消 / 复制 / 分页
- SessionRow 小屏暂停 / 继续 / 取消 / 跳转
- GeneralTab 快速学习 / 协议 / 诊断 / 日志
- DataImportExport 导出导入与清空对话框
- BlockingApprovalBar 批准 / 拒绝 / 展开

## 仍开（Round 51+）

- 内联引用 chip 设计未决；MiniCalendar/TabBar 宽 28 有意折衷
- FinderToolbar 视觉 40 + 伪元素 48：标题栏约束，勿再硬叠 44 视觉
- ShortcutSettings 属 #166 不碰
- WorkbenchSidebar 桌面壳分区头属 #161，不碰
- 翻译 SourcePanel / ComparisonView 已用 COARSE_HIT 凑 44，勿重做视觉
- 继续扫生产路径残留：ankiCardsBlock 编辑保存、TodoAutomationWorkspace、InputBarUI、QuestionBankEditor、无 coarse 的 `!py-1`/`h-6`/`h-7`、hover-only
