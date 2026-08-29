# Round 55 落地（claude-fable-5-thinking-xhigh）

## 已修

- AppearanceTab 缩放 / 字体 / 字号重置（`md:min-h-0` iPad 洞）
- SystemPermissionsSection 授权 / 目录 / 刷新
- AutomationSettingsSection 表单保存 / 删除确认 / 重试 / 空态
- SubagentProfilesSection 表单保存 / 删除确认 / 重载
- VendorDetailPanel 取消 / 保存 / 编辑 / 加模型（补 coarse，删钮已覆盖）
- McpEditorSection 加环境变量
- Sheet 关闭钮（`lg:h-8` 不压 coarse）
- BlockingAskUserBar 忽略 / 提交
- MemoryView 根目录选择列表
- MindMapContentView 搜索 Aa / ab（视觉 24 + 伪元素 44）

## 仍开（Round 56+）

- 内联引用 chip 设计未决；MiniCalendar/TabBar 宽 28 有意折衷
- FinderToolbar 视觉 40 + 伪元素 48：标题栏约束，勿再硬叠 44 视觉
- ShortcutSettings 属 #166 不碰
- WorkbenchSidebar 桌面壳分区头属 #161，不碰
- 翻译 SourcePanel / ComparisonView 已用 COARSE_HIT 凑 44，勿重做视觉
- 继续扫生产路径残留：无 coarse 的 `!py-1`/`h-6`/`h-7`、hover-only、iPad `lg:`/`md:min-h-0`/`sm:min-h-0` 把 DsButton 压到 30–32
- 候选：StructureSelector / StylePanel 触发钮、SourcePreviewPanel 复制打开下载、DataGovernanceDashboard 生产 TabsTrigger（勿碰 debug 场景按钮，属 #166）
