# Round 56 落地（claude-fable-5-thinking-xhigh）

## 已修

- StructureSelector 触发钮（视觉 28 + 伪元素 44）
- StylePanel 触发钮（视觉 28 + 伪元素 44；色板/图标钮已有 CSS）
- SourcePreviewPanel 复制 / 打开知识库 / 下载
- DataGovernanceDashboard 生产 TabsTrigger（含 debug 标签尺寸，未碰 #166 场景按钮）
- ChatSessionArchiveTab 恢复 / 删除 / 刷新 / 分组
- useChatPageLayout 移动顶栏新建 / 会话设置图标
- MemoryView 工具栏批量导入 / 新建 / 全选 / 批量删除
- OverviewTab 归档入口
- AuditTab 错误横幅重试
- AgentControlCenter 熔断恢复 / 紧急停止 / 开聊 / 能力折叠

## 仍开（Round 57+）

- 内联引用 chip 设计未决；MiniCalendar/TabBar 宽 28 有意折衷
- FinderToolbar 视觉 40 + 伪元素 48：标题栏约束，勿再硬叠 44 视觉
- ShortcutSettings 属 #166 不碰
- WorkbenchSidebar 桌面壳分区头属 #161，不碰
- 翻译 SourcePanel / ComparisonView 已用 COARSE_HIT 凑 44，勿重做视觉
- DataGovernanceDashboard debug 场景按钮属 #166，不碰
- 继续扫生产路径残留：无 coarse 的 `!py-1`/`h-6`/`h-7`、hover-only、iPad `lg:`/`md:min-h-0`/`sm:min-h-0` 把 DsButton 压到 30–32
