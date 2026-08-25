# Round 41 落地（claude-fable-5-thinking-xhigh）

## 已修

- PDF `.ds-input` 页码框 coarse 40→44
- 笔记工作区 `.notes-search` 栏 coarse min-height 44
- 收藏分区 `.nfs-header` 折叠头 coarse 28→44
- DEV 插件：Timeline / UnifiedDragDrop / Layout / MCP / EssayTooltip / DeepSeekOcr / DSTU / Crepe / Subagent / PageLifecycle

## 仍开（Round 42+）

- 内联引用 chip 设计未决；MiniCalendar/TabBar 宽 28 有意折衷
- FinderToolbar 视觉 40 + 伪元素 48：标题栏约束，勿再硬叠 44 视觉
- ShortcutSettings 属 #166 不碰
- WorkbenchSidebar 桌面壳分区头属 #161，不碰
- 翻译 SourcePanel / ComparisonView 已用 COARSE_HIT 凑 44，勿重做视觉
- 仍有未扫完的 debug-panel 插件
