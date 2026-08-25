# Round 46 落地（claude-fable-5-thinking-xhigh）

## 已修

- PomodoroAppWindow 放弃/继续/播放/完成/延长文字钮
- CrepeEditor 分类 chip / 搜索 / 分类与级别筛选
- EssayEditorWrapper 关闭/保存工具栏
- 导图 OutlineBreadcrumb + MindMapCanvas 聚焦面包屑（补 iPad coarse）
- SettingsSidebar / TodoShellSidebar 返回主页行
- TemplateDesigner 日志展开行
- MultiVariantTest / ChatAnkiIntegration 可点 label
- RuntimeSection 权限跳转行
- ChatInteractionTest 步骤 checkbox label

## 仍开（Round 47+）

- 内联引用 chip 设计未决；MiniCalendar/TabBar 宽 28 有意折衷
- FinderToolbar 视觉 40 + 伪元素 48：标题栏约束，勿再硬叠 44 视觉
- ShortcutSettings 属 #166 不碰
- WorkbenchSidebar 桌面壳分区头属 #161，不碰
- 翻译 SourcePanel / ComparisonView 已用 COARSE_HIT 凑 44，勿重做视觉
- 继续扫生产路径残留（无 coarse 的 `!py-1`/`h-6`/`h-7`、hover-only）与 DEV 漏网
