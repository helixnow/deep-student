# Round 61 落地（claude-fable-5-thinking-xhigh）

## 已修

- TodoContentView 自动化顶栏刷新 / 新建图标
- OcrResultHeader 折叠头 / 重试
- toolLimit 继续
- sleepBlock 折叠头 / 唤醒
- imageGen 重试 / 跟进提问
- ChatErrorBoundary 重试
- CsvImportDialog 取消导入与底栏上一步/下一步/开始/重试
- AttachmentValidationNotice 关闭
- TagTreeImportCheckModal 取消 / 确认
- PrivacyPolicyDialog 关闭
- TextbookPdfViewer 空态进教材库
- UnifiedErrorHandler 清空 / 展开 / 关闭 / 恢复动作

## 仍开（Round 62+）

- 内联引用 chip 设计未决；MiniCalendar/TabBar 宽 28 有意折衷
- FinderToolbar 视觉 40 + 伪元素 48：标题栏约束，勿再硬叠 44 视觉
- ShortcutSettings 属 #166 不碰
- WorkbenchSidebar 桌面壳分区头属 #161，不碰
- 翻译 SourcePanel / ComparisonView 已用 COARSE_HIT 凑 44，勿重做视觉
- DataGovernanceDashboard debug 场景按钮属 #166，不碰
- FilePreview 标题栏若挤布局，保持 coarse 44 命中即可，勿再叠视觉
- 继续扫生产路径残留：无 coarse 的 `size="sm"`/`size="icon"`、`!py-1`/`h-6`/`h-7`、hover-only、iPad `lg:`/`isSmallScreen` 洞
