# Round 45 落地（claude-fable-5-thinking-xhigh）

## 已修

- PageLifecycle 过滤器两个 select
- TemplateDesigner 搜索/级别/阶段筛选
- NotesOutline 关键字/类别筛选
- DstuDebug 工具栏复制/导出/清空 + 行复制
- Style-lab：TokenInspector 搜索/色块行、ComponentCompare 原生对照、MixedUsage 折叠行
- MinimalTemplateEditor 代码子 tab（front/back/css）
- InlineSettingsPanel 维度名/分值/总分输入
- AnkiConnect 紧凑布局「测试连接」
- NotesContextPanel 标签重命名 Input leftover coarse 28→44
- DevMobileRecoveryFab；mindmap.css coarse 下 style icon/swatch 44

## 仍开（Round 46+）

- 内联引用 chip 设计未决；MiniCalendar/TabBar 宽 28 有意折衷
- FinderToolbar 视觉 40 + 伪元素 48：标题栏约束，勿再硬叠 44 视觉
- ShortcutSettings 属 #166 不碰
- WorkbenchSidebar 桌面壳分区头属 #161，不碰
- 翻译 SourcePanel / ComparisonView 已用 COARSE_HIT 凑 44，勿重做视觉
- debug-panel 主工具栏/筛选项已基本扫完；继续扫生产路径残留（无 coarse 的 `!py-1`/`h-6`/`h-7`/`h-8`、hover-only）与其它 DEV 漏网
