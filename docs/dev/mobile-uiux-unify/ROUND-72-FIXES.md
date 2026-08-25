# Round 72 落地（claude-fable-5-thinking-xhigh）

## 已修

- SkillEditorModal 技能类型切换、底栏取消/保存（Round 71 只改了 SkillFullscreenEditor）
- ConflictResolutionDialog 取消 / 应用策略
- DsDialog 共享确认底栏（`confirmSize` 默认 `sm`，coarse 补 44）
- TodoAutomationWorkspace 创建面板取消 / 创建
- ShortcutHelpPanel 桌面/iPad 关闭
- VersionHistoryPanel 恢复确认 / 取消
- AboutTab 移动端 APK / GitHub 下载链
- MultimodalIndexButton 主索引钮
- MindMapEmbed 嵌入重试
- ComponentRecoveryShell 恢复后重启 / 导出诊断（iPad `lg:` 洞）

## 扫过无残留

- `sleepBlock.tsx`：生产路径钮已有 coarse 44（Round 61），本轮未再改

## 仍开（Round 73+）

- 内联引用 chip 设计未决（QbankCitationBadge / MindmapCitationCard 勿硬叠 44 视觉）；MiniCalendar/TabBar 宽 28 有意折衷
- FinderToolbar 视觉 40 + 伪元素 48：标题栏约束，勿再硬叠 44 视觉
- ChatAppWindow 标题栏开关同样保持视觉 28 + 伪元素，勿再硬叠 44 视觉
- ShortcutSettings 属 #166 不碰
- WorkbenchSidebar 桌面壳分区头属 #161，不碰
- 翻译 SourcePanel / ComparisonView 已用 COARSE_HIT 凑 44，勿重做视觉
- DataGovernanceDashboard debug 场景按钮属 #166，不碰
- FilePreview 标题栏若挤布局，保持 coarse 44 命中即可，勿再叠视觉
- ReciteStatusBar / `.mm-collapse-btn` / ImageViewer / UnifiedPreviewToolbar / EnhancedPdfViewer / BatchOperationToolbar 主条 / EpubPreview / CodeBlock / LibraryCardRow **行内** / FindReplacePanel / VideoPlayer / AudioPlayer / FinderBatchToolbar / Card3DPreview / DstuAppLauncher / UnifiedMobileHeader / VersionHistoryPanel 关闭与行动作：已有 CSS 或 `shellIconButtonClassName` 覆盖
- CloudStorage 提供商卡 `!p-3 !h-auto` 通常已够高，勿当新活
- AccentPicker `DOT_BASE_CLASS` 已是 coarse 44，勿重做
- **核过待派**：`MindMapContentView` 加载失败重试用 `className="ds-btn"`（CSS 默认 28px；coarse 只覆盖 banner/breadcrumb/toolbar/search，不含此空态）
- 继续扫生产路径残留：无 coarse 的 `size="sm"`/`size="icon"`、`!py-1`/`h-6`/`h-7`、hover-only、iPad `lg:`/`md:`/`isSmallScreen` 洞、CSS 32px 色板/自绘钮。全仓 opening-tag 扫描会因 `onClick={() =>` 的 `>` 截断产生假阳性，必须读文件核。
