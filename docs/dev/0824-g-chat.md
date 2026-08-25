# 0824 G 聊天/输入栏域终审

状态：**本域已终审**

## 合入基线

- 0824：`origin/cursor/0824-cde6` @ `362dd2dfc`
- G（mobile）：`origin/cursor/0824-theme-mobile-cde6` @ `4ab24435b`
- step5-fg：`origin/cursor/0824-rehearse-step5-fg-cde6` @ `0c07e5e23`
- step3-fg：`origin/cursor/0824-rehearse-step3-fg-cde6` @ `60d1cbbf2`
- 工作分支：`cursor/0824-g-fix-chat-b0d6`

`4ab24435b` 不是 `362dd2dfc` 的祖先，因此从最新 0824 合入完整 G。非本域冲突采用
step5-fg 已验证树；本域唯一内容冲突 `InputBarUI.tsx` 保留 0824 的拆分编排版本，再把
G 的 coarse-pointer 增量按职责重放到拆分组件。

## 输入栏冲突取舍

| 文件 | 取舍 |
|---|---|
| `src/features/chat/components/input-bar/InputBarUI.tsx` | 保留 0824 的拆分编排版本，未恢复 G 的 3922 行整文件；仅保留仍属于壳体的长粘贴、闪卡、媒体、思维导图提示按钮 44px coarse 命中区。保留键盘 inset 与 safe-area 取最大值的逻辑。 |
| `src/features/chat/components/input-bar/ComposerToolbar.tsx` | 接收原 G `InputBarUI` 中已迁移的水位环透明命中区、发送/停止按钮 coarse 44px、运行时模型搜索 44px/16px。推理标签、深度滑块、运行时模型菜单继续由拆分组件负责。 |
| `src/features/chat/components/input-bar/ComposerTextarea.tsx` | 保留 F 拆分后的 textarea；G 对旧 monolith 没有对应文本输入 hunk。保留 Enter 发送、Shift+Enter 换行、IME composition 防误发、流式停止/排队语义。 |
| `src/features/chat/components/input-bar/AttachmentPanelBody.tsx` | 接收原 G 附件面板 hunk：添加、资源库、相机、清空、关闭、重试、删除在 coarse 指针下至少 44px；移动端主添加按钮强制 `min-width: 44px`。 |
| `src/features/chat/components/input-bar/attachmentModeHelpers.ts` | 保留 wrapup 拆分及 `getStageLabel`，包括图片/PDF OCR 的 `learningHub:processing.ocrRecognizing` i18n；未回退为旧 monolith 内联函数。 |
| `src/features/chat/components/input-bar/__tests__/InputBarUI.mobileSplitContract.source.test.ts` | 新增拆分所有权、44px/16px 与 OCR i18n 契约，防止后续再用旧 `InputBarUI` 覆盖新组件。 |

## 重点文件取舍

| 文件 | 取舍 |
|---|---|
| `src/features/chat/components/MessageItem.tsx` | 接收 G 的失败重试、确认和多变体动作 44px 命中区；保留 `isReadOnlySession` 对编辑、重试、删除、分支等写操作的完整门禁。 |
| `src/features/chat/pages/ChatV2Page.tsx` | 接收 G 的移动资源预览桥接、沙箱右屏单顶栏、粗指针按钮和 resize handle 命中区；保留右屏 safe-area、窄屏推拉布局和 Android 返回协调。 |
| `src/features/chat/pages/useChatPageLayout.tsx` | 接收 G 的沙箱/资源预览/分组编辑移动顶栏动作及 44px 热区；保留右屏优先级与返回行为。 |
| `src/components/BatchOperationToolbar/index.tsx` | 采用 step5-fg 决议；搜索清空、筛选、批量动作、更多菜单、卡片勾选保持 coarse 44px。 |
| `src/components/BatchOperationToolbar/FilterBuilder.tsx` | 采用 step5-fg 决议；关闭、删除筛选、添加、取消、应用保持 coarse 44px。 |
| `src/components/BatchOperationToolbar/BatchEditDialog.tsx` | 采用 step5-fg 决议；关闭、标签删除、预览导航、页脚动作保持 coarse 44px。 |
| `src/components/BatchOperationToolbar/BatchOperationToolbar.css` | 保留 coarse 搜索框 44px/16px，避免 iOS 聚焦缩放。 |
| `src/components/BatchOperationToolbar/BatchEditDialog.css` | 保留 coarse 分区标题整行 44px 命中区。 |
| `src/components/TranslateWorkbench.tsx` | 接收 G 的重试/丢弃/关闭 44px，并把 `isActive` 传给 `TranslationMain`，防止保活的非活动标签页注册陈旧返回处理器。 |
| `src/features/chat/components/PlanGateCard.tsx` | 接收参数展开、拒绝、批准按钮 coarse 44px；批准语义不变。 |
| `src/features/chat/components/ToolApprovalCard.tsx` | 接收参数展开和批准/拒绝全路径 coarse 44px；审批范围与理由逻辑不变。 |
| `src/features/chat/components/input-bar/ThinkingDepthSlider.css` | 保留只按 `pointer: coarse` 判定的 44px 轨道，不用 `hover: none`，兼容 iPad 外接触控板。 |
| `src/features/chat/anki/index.tsx` | 仅扩展可编辑入口触控高度；`disabled` 时仍不展示编辑入口。 |
| `src/features/chat/plugins/blocks/ankiCardsBlock.tsx` | 仅合入 G 的触控热区；保留 D 的 QA/遮挡/任务状态与只读/生成中门禁。 |
| `src/features/chat/services/selectionCardGeneration.ts` | G 未改；确认继续走 `cardAgent.startGeneration` 生产路径。 |

## G 触及的其余本域文件

下列每个文件均逐项对照 `merge-base..G`。取舍均为“保留 0824 现有业务逻辑，只合入 G
的 44px/coarse/窄屏可达性增量”；有额外行为取舍的文件已在上节单列。

| 文件 | 取舍 |
|---|---|
| `src/features/chat/components/ActivityTimeline/ActivityTimeline.tsx` | 合入 G 触控热区。 |
| `src/features/chat/components/ActivityTimeline/NoteToolPreview.tsx` | 合入 G 展开动作触控热区。 |
| `src/features/chat/components/AgentTaskPanel.tsx` | 合入 G 粗指针目标；保留任务状态逻辑。 |
| `src/features/chat/components/AttachmentPreview.tsx` | 合入 G 旧附件删除目标；保留 readonly 门禁。 |
| `src/features/chat/components/AttachmentUploader.tsx` | 合入 G 触控目标。 |
| `src/features/chat/components/BlockRenderer.tsx` | 合入 G 重置动作目标。 |
| `src/features/chat/components/ChatErrorBoundary.tsx` | 合入 G 重试目标。 |
| `src/features/chat/components/CompletionCard.tsx` | 合入 G 触控目标。 |
| `src/features/chat/components/ContextRefsDisplay.tsx` | 合入 G 展开目标。 |
| `src/features/chat/components/ExplainPopover.tsx` | 合入 G coarse 命中区。 |
| `src/features/chat/components/InlineDocumentViewer.tsx` | 合入 G 工具栏和操作按钮目标。 |
| `src/features/chat/components/InlineImageViewer.tsx` | 合入 G 触控目标；保留顶部/底部 safe-area。 |
| `src/features/chat/components/InputBar.tsx` | 合入 legacy 输入栏附件、发送/停止 44px；主路径仍为拆分后的 InputBarV2。 |
| `src/features/chat/components/MessageList.tsx` | 合入 G 滚到底部目标。 |
| `src/features/chat/components/MessageSearchBar.tsx` | 合入 G 移动搜索布局和返回可达性。 |
| `src/features/chat/components/TranslationPopover.tsx` | 合入 G footer/关闭目标。 |
| `src/features/chat/components/Variant/ParallelVariantView.tsx` | 合入 G coarse 工具栏与 tab-dot 目标。 |
| `src/features/chat/components/Variant/VariantActions.tsx` | 合入 G overflow 目标。 |
| `src/features/chat/components/Variant/VariantSwitcher.tsx` | 合入 G tab 目标。 |
| `src/features/chat/components/__tests__/MessageSearchBar.placement.test.tsx` | 保留与 G 移动搜索布局一致的契约。 |
| `src/features/chat/components/agent-task/ChangesSection.tsx` | 合入 G 展开/操作目标。 |
| `src/features/chat/components/agent-task/RuntimeSection.tsx` | 合入 G 权限跳转与展开目标。 |
| `src/features/chat/components/folder/FolderContextChip.tsx` | 合入 G chip 目标。 |
| `src/features/chat/components/groups/GroupEditorDialog.tsx` | 合入 G 移动顶栏保存、弹层和表单目标；保留 F 的新分组编辑结构。 |
| `src/features/chat/components/input-bar/AttachmentInjectModeSelector.tsx` | 合入 G 模式选择目标。 |
| `src/features/chat/components/input-bar/AttachmentPreviewChips.tsx` | 合入 G 删除命中区；保留拆分后的预览 chip。 |
| `src/features/chat/components/input-bar/BlockingApprovalBar.tsx` | 合入 G 审批动作目标。 |
| `src/features/chat/components/input-bar/BlockingAskUserBar.tsx` | 合入 G 选项与提交目标。 |
| `src/features/chat/components/input-bar/BlockingToolLimitBar.tsx` | 合入 G 继续动作目标。 |
| `src/features/chat/components/input-bar/ComposerPanel/ComposerPanel.tsx` | 合入 G 关闭/搜索 44px 与 coarse 16px 输入字号。 |
| `src/features/chat/components/input-bar/ComposerPlusMenu.tsx` | 合入 G 触发器及移动单层菜单 44px。 |
| `src/features/chat/components/input-bar/ContextRefChips.tsx` | 合入 G 清空目标。 |
| `src/features/chat/components/input-bar/ContextUsagePopover.tsx` | 合入 G 操作目标。 |
| `src/features/chat/components/input-bar/ModelMentionPopover.tsx` | 合入 G 移动输入字号和行目标。 |
| `src/features/chat/components/input-bar/ModelPicker.tsx` | 合入 G coarse 操作目标；保留紧凑搜索壳和 iOS 16px 字号契约。 |
| `src/features/chat/components/input-bar/PageRefChips.tsx` | 合入 G chip 目标。 |
| `src/features/chat/components/input-bar/QueuedMessageBubble.tsx` | 合入 G 队列动作目标。 |
| `src/features/chat/components/input-bar/SkillSlashPopover.tsx` | 合入 G 移动输入字号和行目标。 |
| `src/features/chat/components/message/MessageActions.tsx` | 合入 G coarse 图标目标；保留移动 compact more-menu。 |
| `src/features/chat/components/message/MessageInlineEdit.tsx` | 合入 G 编辑动作目标。 |
| `src/features/chat/components/message/MessageTouchActionBar.tsx` | 合入 G 全部触控动作 44px。 |
| `src/features/chat/components/message/RawRequestPreview.tsx` | 合入 G copy 目标。 |
| `src/features/chat/components/message/UserMessageBubble.tsx` | 合入 G 触控目标。 |
| `src/features/chat/components/panels/UnifiedSourcePanel.tsx` | 合入 G coarse 操作目标。 |
| `src/features/chat/components/renderers/CodeBlock.tsx` | 合入 G 代码块动作目标。 |
| `src/features/chat/components/renderers/ThinkingChain.css` | 接受 G 删除废弃样式；现有推理展示不再依赖该 CSS。 |
| `src/features/chat/components/session-browser/SearchResultList.tsx` | 合入 G 搜索结果动作目标。 |
| `src/features/chat/components/session-browser/SessionBrowser.tsx` | 合入 G 搜索 16px、行与操作目标。 |
| `src/features/chat/components/session-browser/TagFilter.tsx` | 合入 G 标签删除、输入字号和目标。 |
| `src/features/chat/dev/IntegrationTest.tsx` | 合入 G DEV 控件目标。 |
| `src/features/chat/dev/StoreInspector.tsx` | 合入 G DEV 控件目标。 |
| `src/features/chat/dev/TestControls.tsx` | 合入 G DEV 控件目标。 |
| `src/features/chat/dev/playground/EvalPanel.tsx` | 合入 G playground 控件目标。 |
| `src/features/chat/dev/playground/LLMOutputPlayground.tsx` | 合入 G playground 顶栏/表单目标。 |
| `src/features/chat/dev/playground/PlaygroundControlPanel.tsx` | 合入 G playground 控件目标。 |
| `src/features/chat/dev/playground/ProfilerPanel.tsx` | 合入 G profiler 控件目标。 |
| `src/features/chat/pages/SessionGroupActions.tsx` | 合入 G 分组动作目标。 |
| `src/features/chat/pages/SessionItemRenderer.tsx` | 合入 G 重命名动作目标。 |
| `src/features/chat/pages/SessionSidebarContent.tsx` | 合入 G 加载更多及侧栏目标。 |
| `src/features/chat/pages/__tests__/SessionGroupActions.test.tsx` | 保留 G 分组动作契约更新。 |
| `src/features/chat/plugins/blocks/askUserBlock.tsx` | 合入 G 选项/确认目标。 |
| `src/features/chat/plugins/blocks/compactionSummary.tsx` | 合入 G 压缩摘要动作目标。 |
| `src/features/chat/plugins/blocks/components/ChatAnkiCardExtras.tsx` | 合入 G 闪卡附加动作目标。 |
| `src/features/chat/plugins/blocks/components/ChatAnkiProgressCompact.tsx` | 合入 G 紧凑进度动作目标。 |
| `src/features/chat/plugins/blocks/components/CitationPopover.tsx` | 合入 G 引用操作目标。 |
| `src/features/chat/plugins/blocks/components/ImagePreview.tsx` | 合入 G 图片预览动作目标。 |
| `src/features/chat/plugins/blocks/components/ShellOutputView.tsx` | 合入 G shell 输出动作目标。 |
| `src/features/chat/plugins/blocks/components/SourceList.tsx` | 合入 G 来源列表目标。 |
| `src/features/chat/plugins/blocks/components/TemplateToolOutput.tsx` | 合入 G tabs 目标。 |
| `src/features/chat/plugins/blocks/components/ToolInputView.tsx` | 合入 G JSON 摘要目标。 |
| `src/features/chat/plugins/blocks/components/ToolOutputView.tsx` | 合入 G 输出动作目标。 |
| `src/features/chat/plugins/blocks/generic.tsx` | 合入 G 通用块动作目标。 |
| `src/features/chat/plugins/blocks/imageGen.tsx` | 合入 G 图像生成动作目标。 |
| `src/features/chat/plugins/blocks/mcpTool.tsx` | 合入 G MCP 动作目标。 |
| `src/features/chat/plugins/blocks/paperSave.tsx` | 合入 G 保存重试目标。 |
| `src/features/chat/plugins/blocks/sleepBlock.tsx` | 合入 G 继续/展开目标。 |
| `src/features/chat/plugins/blocks/subagentEmbed.tsx` | 合入 G 取消/头部目标。 |
| `src/features/chat/plugins/blocks/templatePreview.tsx` | 合入 G 预览动作目标。 |
| `src/features/chat/plugins/blocks/thinking.tsx` | 合入 G 推理块目标。 |
| `src/features/chat/plugins/blocks/todoList.tsx` | 合入 G todo 动作目标。 |
| `src/features/chat/plugins/blocks/toolLimit.tsx` | 合入 G tool-limit 动作目标。 |
| `src/features/chat/plugins/blocks/workbenchOpsBlock.tsx` | 合入 G undo 目标。 |
| `src/features/chat/plugins/blocks/workspaceInjection.tsx` | 合入 G workspace 动作目标。 |
| `src/features/chat/plugins/blocks/workspaceSend.tsx` | 合入 G workspace 发送目标。 |
| `src/features/chat/plugins/blocks/workspaceStatus.tsx` | 合入 G 状态头部目标。 |
| `src/features/chat/plugins/chat/AdvancedPanel.tsx` | 合入 G 面板动作目标。 |
| `src/features/chat/plugins/chat/McpPanel.tsx` | 合入 G 刷新/关闭目标。 |
| `src/features/chat/plugins/chat/ModelPanel.tsx` | 合入 G 默认模型目标。 |
| `src/features/chat/plugins/chat/MultiSelectModelPanel.tsx` | 合入 G 行、供应商头部和搜索字号。 |
| `src/features/chat/plugins/chat/RagPanel.tsx` | 合入 G 关闭目标。 |
| `src/features/chat/plugins/chat/SearchPanel.tsx` | 合入 G 搜索面板目标。 |
| `src/features/chat/plugins/modes/components/OcrResultHeader.tsx` | 合入 G OCR 头部操作目标；OCR 文案仍走 i18n。 |
| `src/features/chat/plugins/modes/components/PageNavigator.tsx` | 合入 G 页码输入 16px 和导航目标。 |
| `src/features/chat/skills/components/ActiveSkillBadge.tsx` | 合入 G badge 目标。 |
| `src/features/chat/skills/components/SkillSelector.tsx` | 合入 G pin、页脚和列表动作目标。 |
| `src/features/chat/workspace/components/AgentOutputDrawer.tsx` | 合入 G drawer 与 dispatch 动作目标。 |
| `src/features/chat/workspace/components/CreateAgentCard.tsx` | 合入 G 创建代理动作目标。 |
| `src/features/chat/workspace/components/WorkspaceLogInline.tsx` | 合入 G 展开与复制目标。 |
| `src/features/chat/workspace/components/WorkspaceMessageItem.tsx` | 合入 G 子代理折叠/全屏目标。 |
| `src/features/chat/workspace/components/WorkspacePanel.tsx` | 合入 G 刷新/创建目标。 |

## 保护项确认

- 未恢复 G 的旧整块 `InputBarUI`，拆分组件仍是单一职责实现。
- `getStageLabel` OCR i18n 保留。
- MessageItem 只读会话门禁保留；G 只增加触控面积。
- D 的只读/显示型闪卡语义保留；选择制卡仍走 `cardAgent`。
- 移动端输入键盘、IME、Android 返回、右屏返回、窄容器强制堆叠与 safe-area 行为保留。

## 验证结果

- `npx vitest run src/features/chat/components/input-bar`：20 files / 176 tests 通过。
- chat components、pages、chat-v2 contracts、只读闪卡与 cardAgent 契约：145 files / 1110 tests 通过。
- `npm run build`：许可证检查、TypeScript typecheck、Vite production build 全部通过。
