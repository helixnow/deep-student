# Round 54 落地（claude-fable-5-thinking-xhigh）

## 已修

- NotesEditorToolbar 内联图标
- ModelPicker 重试
- LlmUsageStatsSection 重试
- AnkiTasksApp 小屏排序 / 刷新 / 恢复
- CloudStorageSection 测试 / 保存 / 清空 / 上传 / 恢复 / 删除
- ChatV2Page 空态新建 / 归档
- TemplateManagementApp 顶栏（与 Chat 同提交，并发合入）
- QuestionBankManageView 空态导入 / 清筛选
- Settings.tsx MCP 预览关闭 / 策略弹窗关闭

ImageCropDialog 复查已覆盖（页导航 / 裁剪 / 清除已有 coarse），本轮未改。

## 仍开（Round 55+）

- 内联引用 chip 设计未决；MiniCalendar/TabBar 宽 28 有意折衷
- FinderToolbar 视觉 40 + 伪元素 48：标题栏约束，勿再硬叠 44 视觉
- ShortcutSettings 属 #166 不碰
- WorkbenchSidebar 桌面壳分区头属 #161，不碰
- 翻译 SourcePanel / ComparisonView 已用 COARSE_HIT 凑 44，勿重做视觉
- 继续扫生产路径残留：无 coarse 的 `!py-1`/`h-6`/`h-7`、hover-only、iPad `lg:`/`md:min-h-0`/`sm:min-h-0` 把 DsButton 压到 30–32
