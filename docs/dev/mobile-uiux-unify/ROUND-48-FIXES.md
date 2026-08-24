# Round 48 落地（claude-fable-5-thinking-xhigh）

## 已修

- PomodoroMiniWindow：控制簇 coarse 常显 + 按钮 44
- CreateAgentCard：技能行 / 取消 / 创建 coarse 44
- WorkspacePanel 错误态重试
- AgentOutputDrawer 派发条取消 / 发送
- AttachmentPreview 删除钮 coarse 44
- SkillSelector header 商店 / 刷新 + 移动返回
- InlineDocumentViewer 搜索 / 字号 / 换行工具栏
- McpToolsSection overflow 菜单 5 项 + 触发钮
- UnifiedSidebar 折叠 / 展开钮 coarse 44
- DevMobileRecoveryFab 菜单三项 coarse 44

## 仍开（Round 49+）

- 内联引用 chip 设计未决；MiniCalendar/TabBar 宽 28 有意折衷
- FinderToolbar 视觉 40 + 伪元素 48：标题栏约束，勿再硬叠 44 视觉
- ShortcutSettings 属 #166 不碰
- WorkbenchSidebar 桌面壳分区头属 #161，不碰
- 翻译 SourcePanel / ComparisonView 已用 COARSE_HIT 凑 44，勿重做视觉
- 继续扫生产路径残留：InlineDocumentViewer 复制/打开/下载/关闭；McpToolsSection 表单/JSON 切换与权限抽屉；无 coarse 的 `!py-1`/`h-6`/`h-7`、hover-only
