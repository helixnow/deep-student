# 0824 Wave2-C R4 — 审阅报告：remove/clear 收敛（sessionActions / AttachmentPanelBody）

- 审阅对象：`src/features/chat/core/store/sessionActions.ts`、
  `src/features/chat/components/input-bar/AttachmentPanelBody.tsx`（对应实现文档 `01-store-remove.md`）
- 基线：`af0be136`（分支 `cursor/0824-wave2-mobile-uiux-a875`，改动均为未 commit 工作区状态）
- 审阅方式：只读核查 + 红线 grep；依指令未运行测试、未 git commit、未做任何修补

## 结论：通过，无需修补

四项必查全部满足，未发现 cancel 嵌在 resourceId 分支或双重 revoke，故未动用「最小修补」授权。
发送/流式段零改动。

## 审阅环境勘误（重要）

本轮 shell 默认落在 `/tmp/0824-wave2-c-r4-focus-a11y`（另一张卡的独立工作目录，
其 `sessionActions.ts` 仍是基线内容），在该目录跑 `git diff HEAD -- sessionActions.ts`
会得到**空 diff**——空得毫无意义，不能当"红线自证"用。所有证据均已改在
`/workspace`（`git rev-parse --show-toplevel` = `/workspace`）重新取证。后续轮次自证
前务必先确认 `pwd` / toplevel。

## 必查项逐条核验

### 1. `git diff HEAD -- sessionActions.ts` 不含发送/流式段 ✅

diff 恰为 4 个 hunk，全部围绕附件 remove/clear：

1. `+import { cancelPdfProcessing } from '@/api/vfsPdfProcessingApi';`
2. 模块级 helper `cancelAttachmentProcessing(attachmentId, sourceId)`（fire-and-forget +
   `logAttachment('store', 'cancel_processing_failed', ..., 'warning')`）
3. `removeAttachment` 内 5 行（cancel 调用）
4. `clearAttachments` 内 7 行（逐附件 cancel 循环）

红线 grep 证据（在 `/workspace` 下执行）：

```console
$ git diff HEAD -- src/features/chat/core/store/sessionActions.ts \
    | rg -i 'send|abort|stream|queue|wake|retry|variant'
（无输出，exit=1）
```

`sendMessage` / `setSendCallback` / `setAbortCallback` / `continueMessage` / 变体与流式
状态字段等段落零触碰。

### 2. cancel 只看 sourceId，不嵌在 resourceId 分支 ✅

- `removeAttachment`（sessionActions.ts:233-236）：cancel 位于函数顶层，紧跟
  `remove_attachment` 日志之后、`set(filter)` 之前，守卫条件仅为
  `if (attachment?.sourceId)`。它在 `if (attachment?.resourceId)` 分支（:243 起，
  只做 removeContextRef + pdfProcessingStore 清理）**之前且之外**。
  孤儿附件（有 sourceId、无 resourceId）删除时同样会取消后端任务。
- `clearAttachments`（:283-288）：`for (const att of state.attachments) { if (att.sourceId) ... }`，
  同样只看 sourceId，与 resourceId 无关。

### 3. 双重 revoke 已消除 ✅

- `AttachmentPanelBody` 原有的 `handleRemoveAttachment` / `handleClearAllAttachments`
  （UI 层 cancel + `URL.revokeObjectURL` 再转调 store 重复 revoke）已整体删除，
  相关导入（`cancelPdfProcessing` / `getErrorMessage` / `logAttachment`）一并移除：

```console
$ rg -n 'cancelPdfProcessing|revokeObjectURL' \
    src/features/chat/components/input-bar/AttachmentPanelBody.tsx \
    src/features/chat/components/input-bar/AttachmentPreviewChips.tsx
（无输出，exit=1）
```

- remove/clear 路径的 Blob revoke 如今唯一所有者是 store
  （`removeAttachment`:261-264 单个 revoke；`clearAttachments`:290-299 批量 revoke）。
- 仍保留的三处 revoke 均不在 remove/clear 路径上，属账本明示保留的兜底，不构成双重 revoke：
  - `InputBarUI.tsx:789`：文件读取失败（附件尚未成形）时释放预览 URL；
  - `InputBarUI.tsx:1739-1743`：宿主卸载兜底（账本卡 1 明确保留）；
  - store `initSession` 经 `revokeAttachmentBlobUrls` 在会话重置时兜底释放。

### 4. chip 路径只传 id ✅

三条删除入口均为裸委托，无任何 UI 层补偿逻辑：

- 预览 chips：`AttachmentPreviewChips.tsx:356` `onRemove(attachment.id)`
  → `InputBarUI.tsx:2444` 透传 `onRemoveAttachment`
  → `InputBarV2.tsx:1299` → `useInputBarV2.ts:474` `store.getState().removeAttachment(attachmentId)`。
- 附件面板行内删除：`AttachmentPanelBody.tsx:342` `onClick={() => onRemoveAttachment(attachment.id)}`；
  清空按钮（移动端 ⋯ 菜单 :153 / 桌面 :199）直连 `onClearAttachments`。
- 消息态预览：`AttachmentPreview.tsx:336-339` 同样裸委托 `store.getState().removeAttachment(attachmentId)`。

## 非阻塞观察（不属本轮修补授权，仅记录）

1. `removeAttachment` 中 `usePdfProcessingStore.getState().remove(sourceId)`（:249-257）
   仍嵌在 `if (attachment?.resourceId)` 分支内：孤儿附件（有 sourceId 无 resourceId）
   单个删除时 cancel 会发、但 pdfProcessingStore 条目不清；`clearAttachments` 则按
   sourceId 无条件清理，两个 action 存在轻微不对称。属基线既有行为（本轮 diff 未触碰
   该分支），且配套测试（`sessionActions.attachmentLifecycle.test.ts` 孤儿用例）只断言
   cancel + 无 ContextRef 清理，与现状一致。建议后续轮次把该清理也提到 sourceId 顶层守卫。
2. 工作区内 `InputBarUI.tsx`（aria-label i18n）与 `ComposerInlinePanel.tsx`（焦点顺序）
   的未 commit 改动属其他卡，均不触及 remove/clear 与发送/流式，不影响本审阅结论。
3. 配套新增测试文件（`sessionActions.attachmentLifecycle.test.ts`、
   `AttachmentPreviewChips.removeCancels.source.test.ts`）的 source 契约断言与当前源码
   状态一致（面板无 cancel/revoke、store 含 cancel、chip 裸委托、宿主卸载兜底保留）；
   依指令未执行。
