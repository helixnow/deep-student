# Round 53 落地（claude-fable-5-thinking-xhigh）

## 已修

- SchedulerSettingsSection 保存
- OcrSettingsSection 重置
- SystemSettingsSection 主题 / 保存 / 重置
- VendorApiKeySection 保存 / 清空
- VendorConfigModal 取消 / 保存 / 清空密钥
- SyncSettingsSection 刷新 / 上传下载 / 冲突
- OcrEngineTestPanel 关闭 / 清除 / 换图 / 测试
- MarkdownEditorWindowSettings 重置行窗
- TargetPanel 编辑取消 / 保存
- ShadApiEditModal 底栏测试 / 取消 / 保存

FailedTasksPanel 复查已覆盖，改派 ShadApiEditModal。

## 仍开（Round 54+）

- 内联引用 chip 设计未决；MiniCalendar/TabBar 宽 28 有意折衷
- FinderToolbar 视觉 40 + 伪元素 48：标题栏约束，勿再硬叠 44 视觉
- ShortcutSettings 属 #166 不碰
- WorkbenchSidebar 桌面壳分区头属 #161，不碰
- 翻译 SourcePanel / ComparisonView 已用 COARSE_HIT 凑 44，勿重做视觉
- 继续扫生产路径残留：无 coarse 的 `!py-1`/`h-6`/`h-7`、hover-only、iPad `lg:` 把 DsButton 压到 30–32
