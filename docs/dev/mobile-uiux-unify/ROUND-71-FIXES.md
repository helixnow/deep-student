# Round 71 落地（claude-fable-5-thinking-xhigh）

## 已修

- ReviewSession 空态关闭 / 完成页再练与结束（`lg:` iPad 洞）
- SOTADashboardLite 加载失败重试
- DataImportExport 自动备份 / 数据空间刷新与切换 / 完整性检查 / 清空数据
- RecoveryCenter 刷新、重试预检、导出诊断、继续、确认激活、取消、恢复后重启
- UnifiedSidebar 错误态重试（桌面壳 `size="sm"` + coarse）
- MindMapErrorBoundary 重试加载
- CrepeDemoPage 桌面/iPad 横屏自绘返回
- PluginsTab 扫码绑定 / 插件行
- QuestionBankEditor 错误/空态返回、完成庆祝再练/查看
- SkillFullscreenEditor 技能类型切换、底栏取消/保存

## 仍开（Round 72+）

- 内联引用 chip 设计未决（QbankCitationBadge / MindmapCitationCard 勿硬叠 44 视觉）；MiniCalendar/TabBar 宽 28 有意折衷
- FinderToolbar 视觉 40 + 伪元素 48：标题栏约束，勿再硬叠 44 视觉
- ChatAppWindow 标题栏开关同样保持视觉 28 + 伪元素，勿再硬叠 44 视觉
- ShortcutSettings 属 #166 不碰
- WorkbenchSidebar 桌面壳分区头属 #161，不碰
- 翻译 SourcePanel / ComparisonView 已用 COARSE_HIT 凑 44，勿重做视觉
- DataGovernanceDashboard debug 场景按钮属 #166，不碰
- FilePreview 标题栏若挤布局，保持 coarse 44 命中即可，勿再叠视觉
- ReciteStatusBar / `.mm-collapse-btn` / ImageViewer / UnifiedPreviewToolbar / EnhancedPdfViewer / BatchOperationToolbar 主条 / EpubPreview / CodeBlock / LibraryCardRow **行内** / FindReplacePanel / VideoPlayer / AudioPlayer / FinderBatchToolbar / Card3DPreview / DstuAppLauncher / UnifiedMobileHeader / VersionHistoryPanel：已有 CSS 或 `shellIconButtonClassName` 覆盖
- SkillEditorModal 技能类型切换与同构底栏尚未派（本轮只改 SkillFullscreenEditor）
- 继续扫生产路径残留：无 coarse 的 `size="sm"`/`size="icon"`、`!py-1`/`h-6`/`h-7`、hover-only、iPad `lg:`/`md:`/`isSmallScreen` 洞、CSS 32px 色板/自绘钮
