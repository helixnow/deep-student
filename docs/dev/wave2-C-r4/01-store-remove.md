# 0824 Wave2-C R4 — remove/clear 单一动作收敛

- 基线：`af0be136`（docs: record Wave2-C R3 touch-target mechanism landing）
- 工作目录：`/tmp/0824-wave2-c-r4-store-remove`
- 独占文件：`src/features/chat/core/store/sessionActions.ts`、`src/features/chat/components/input-bar/AttachmentPanelBody.tsx`
- 未 commit（按指令），`git diff --stat`：

```
 .../components/input-bar/AttachmentPanelBody.tsx   | 50 +++-------------------
 src/features/chat/core/store/sessionActions.ts     | 27 ++++++++++++
 2 files changed, 32 insertions(+), 45 deletions(-)
```

## 改动内容

### 1. store（sessionActions.ts）：remove/clear 成为单一动作 SSOT

- 新增导入 `cancelPdfProcessing`（来自 `@/api/vfsPdfProcessingApi`，已确认 `src/api/vfsPdfProcessingApi.ts:163` 存在该导出）。
- 新增模块级 helper `cancelAttachmentProcessing(attachmentId, sourceId)`：fire-and-forget 调用
  `cancelPdfProcessing(sourceId)`，catch 后用既有 `logAttachment('store', 'cancel_processing_failed', {...}, 'warning')`
  记录（与面板原有 catch 日志风格一致，仅 scope 从 `'ui'` 换成 `'store'`）。
- `removeAttachment`：在既有 `logAttachment('store', 'remove_attachment', ...)` 之后、过滤附件列表之前，
  对 `attachment.sourceId` 调一次 helper。既有 `pdfProcessingStore.remove(sourceId)` 与
  `URL.revokeObjectURL(previewUrl)` 原样保留（Blob revoke 仍只在 store 做一次）。
- `clearAttachments`：在 `clear_attachments_start` 日志之后，对每个带 `sourceId` 的附件逐个调 helper。
  既有的批量 Blob revoke、ContextRef 清理、`pdfProcessingStore.remove` 批量清理原样保留。

### 2. 面板（AttachmentPanelBody.tsx）：UI 只传 id

- 删除 `handleRemoveAttachment(attachment)` 与 `handleClearAllAttachments` 两个本地 handler
  （原 91-128 行区间的 cancelPdfProcessing + revokeObjectURL 补偿逻辑全部移除）。
- 三处调用点改为直连回调：
  - 移动端 ⋯ 菜单 clear：`onClick={onClearAttachments}`
  - 桌面端 clear 按钮：`onClick={onClearAttachments}`
  - 行内 remove 按钮：`onClick={() => onRemoveAttachment(attachment.id)}`
- 删除面板中因此不再使用的导入：`cancelPdfProcessing`、`getErrorMessage`、`logAttachment`。
- 面板内已无任何 `revokeObjectURL` / `cancelPdfProcessing`（grep 为空），不存在双重 revoke。

### 3. 接线闭环确认

`AttachmentPanelBody` → `InputBarUI`（透传 props，`InputBarUI.tsx:2131-2132`）→ `InputBarV2`
（`InputBarV2.tsx:1299-1300` 直接传 store 的 `removeAttachment` / `clearAttachments`）。
因此取消 PDF 处理、Blob revoke、pdfProcessingStore 清理现在都由 store 单点执行一次。

## 红线证据：发送/流式段未改

`git diff` 只包含两个文件；`sessionActions.ts` 的 diff 只有 4 个 hunk：
① import 一行、② 模块级 helper、③ `removeAttachment` 内 5 行、④ `clearAttachments` 内 7 行。
`sendMessage` / `abort` / `stream` / `queue` / callback 注入等段落零改动：

```console
$ git diff src/features/chat/core/store/sessionActions.ts | rg -i 'send|abort|stream|queue'
（无输出，exit=1）
```

### sessionActions.ts 完整 diff

```diff
diff --git a/src/features/chat/core/store/sessionActions.ts b/src/features/chat/core/store/sessionActions.ts
index 0879a0dd..eaba65c1 100644
--- a/src/features/chat/core/store/sessionActions.ts
+++ b/src/features/chat/core/store/sessionActions.ts
@@ -8,6 +8,7 @@ import { COMPOSER_PANEL_KEYS, type ChatParams, type PanelStates } from '../types
 import type { ChatStoreState, SetState, GetState } from './types';
 import { createDefaultChatParams, createDefaultPanelStates } from './types';
 import { getErrorMessage } from '@/utils/errorUtils';
+import { cancelPdfProcessing } from '@/api/vfsPdfProcessingApi';
 import { logAttachment } from '../../debug/chatV2Logger';
 import { modeRegistry } from '../../registry';
 import { usePdfProcessingStore } from '@/features/pdf/stores/pdfProcessingStore';
@@ -73,6 +74,20 @@ function blockingInteractionPatch(interaction: BlockingInteraction | null): {
   return { pendingBlockingInteraction: interaction, pendingApprovalRequest: null };
 }
 
+/**
+ * remove/clear 语义收敛（SSOT）：取消后端 PDF 处理属于"移除附件"动作本身，
+ * 由 store 统一 fire-and-forget，UI 只负责传 id，不再各自补偿取消/释放逻辑。
+ */
+function cancelAttachmentProcessing(attachmentId: string, sourceId: string): void {
+  void cancelPdfProcessing(sourceId).catch((error) => {
+    logAttachment('store', 'cancel_processing_failed', {
+      attachmentId,
+      sourceId,
+      error: getErrorMessage(error),
+    }, 'warning');
+  });
+}
+
 export function createSessionActions(
   set: SetState,
   getState: GetState,
@@ -215,6 +230,11 @@ export function createSessionActions(
             status: attachment?.status,
           });
 
+          // ★ remove 语义收敛：取消后端 PDF 处理（fire-and-forget），不再由 UI 负责
+          if (attachment?.sourceId) {
+            cancelAttachmentProcessing(attachmentId, attachment.sourceId);
+          }
+
           set((s) => ({
             attachments: s.attachments.filter((a) => a.id !== attachmentId),
           }));
@@ -260,6 +280,13 @@ export function createSessionActions(
             attachments: attachmentInfo,
           });
 
+          // ★ clear 语义收敛：逐个取消后端 PDF 处理（fire-and-forget），不再由 UI 负责
+          for (const att of state.attachments) {
+            if (att.sourceId) {
+              cancelAttachmentProcessing(att.id, att.sourceId);
+            }
+          }
+
           // 🔧 P1-25: 释放所有 Blob URLs，避免内存泄漏
           const blobUrls = state.attachments
             .filter((a) => a.previewUrl?.startsWith('blob:'))
```

### AttachmentPanelBody.tsx 完整 diff

```diff
diff --git a/src/features/chat/components/input-bar/AttachmentPanelBody.tsx b/src/features/chat/components/input-bar/AttachmentPanelBody.tsx
index 0bb44ce0..0f7b2e46 100644
--- a/src/features/chat/components/input-bar/AttachmentPanelBody.tsx
+++ b/src/features/chat/components/input-bar/AttachmentPanelBody.tsx
@@ -30,10 +30,7 @@ import {
 } from '@/components/ui/app-menu/AppMenu';
 import { cn } from '@/lib/utils';
 import { DsButton } from '@/components/ui/DsButton';
-import { getErrorMessage } from '@/utils/errorUtils';
-import { cancelPdfProcessing } from '@/api/vfsPdfProcessingApi';
 import type { PdfProcessingStatus as StorePdfProcessingStatus } from '@/features/pdf/stores/pdfProcessingStore';
-import { logAttachment } from '../../debug/chatV2Logger';
 import type { AttachmentMeta } from '../../core/types/common';
 import type { AttachmentInjectModes } from '../../core/types/common';
 import { AttachmentInjectModeSelector } from './AttachmentInjectModeSelector';
@@ -95,45 +92,8 @@ export const AttachmentPanelBody: React.FC<AttachmentPanelBodyProps> = ({
 }) => {
   const { t } = useTranslation(['analysis', 'common', 'chatV2']);
 
-  const handleClearAllAttachments = () => {
-    attachments.forEach(att => {
-      if (att.sourceId) {
-        void cancelPdfProcessing(att.sourceId).catch((error) => {
-          logAttachment('ui', 'cancel_processing_failed', {
-            attachmentId: att.id,
-            sourceId: att.sourceId,
-            error: getErrorMessage(error),
-          }, 'warning');
-        });
-      }
-      if (att.previewUrl?.startsWith('blob:')) {
-        URL.revokeObjectURL(att.previewUrl);
-      }
-    });
-    onClearAttachments();
-  };
-
-  const handleRemoveAttachment = (attachment: AttachmentMeta) => {
-    logAttachment('ui', 'attachment_remove', {
-      attachmentId: attachment.id,
-      sourceId: attachment.sourceId,
-      fileName: attachment.name,
-      status: attachment.status,
-    });
-    if (attachment.sourceId) {
-      void cancelPdfProcessing(attachment.sourceId).catch((error) => {
-        logAttachment('ui', 'cancel_processing_failed', {
-          attachmentId: attachment.id,
-          sourceId: attachment.sourceId,
-          error: getErrorMessage(error),
-        }, 'warning');
-      });
-    }
-    if (attachment.previewUrl?.startsWith('blob:')) {
-      URL.revokeObjectURL(attachment.previewUrl);
-    }
-    onRemoveAttachment(attachment.id);
-  };
+  // remove/clear 语义已收敛进 store（sessionActions）：取消 PDF 处理、
+  // 释放 Blob URL、清理 pdfProcessingStore 均由 store 单点执行，面板只传 id。
 
   return (
     <>
@@ -190,7 +150,7 @@ export const AttachmentPanelBody: React.FC<AttachmentPanelBodyProps> = ({
                     className={coarseRowClass}
                     icon={<Trash className="w-4 h-4" weight="bold" />}
                     destructive
-                    onClick={handleClearAllAttachments}
+                    onClick={onClearAttachments}
                   >
                     {t('analysis:input_bar.attachments.clear_all')}
                   </AppMenuItem>
@@ -236,7 +196,7 @@ export const AttachmentPanelBody: React.FC<AttachmentPanelBodyProps> = ({
               </DsButton>
             )}
             {attachments.length > 0 && (
-              <DsButton variant="danger" size="sm" className="[@media(pointer:coarse)]:!min-h-11" onClick={handleClearAllAttachments}>
+              <DsButton variant="danger" size="sm" className="[@media(pointer:coarse)]:!min-h-11" onClick={onClearAttachments}>
                 {t('analysis:input_bar.attachments.clear_all')}
               </DsButton>
             )}
@@ -379,7 +339,7 @@ export const AttachmentPanelBody: React.FC<AttachmentPanelBodyProps> = ({
                       {t('common:retry')}
                     </DsButton>
                   )}
-                  <DsButton variant="danger" size="sm" className="[@media(pointer:coarse)]:!min-h-11" onClick={() => handleRemoveAttachment(attachment)}>
+                  <DsButton variant="danger" size="sm" className="[@media(pointer:coarse)]:!min-h-11" onClick={() => onRemoveAttachment(attachment.id)}>
                     {t('analysis:input_bar.attachments.remove')}
                   </DsButton>
                 </div>
```

## 行为差异说明（有意为之）

- 原面板在 remove 前会记一条 `logAttachment('ui', 'attachment_remove', ...)`；store 的
  `removeAttachment` 本就记 `logAttachment('store', 'remove_attachment', ...)`（含 sourceId /
  fileName / status），信息等价，故 UI 侧日志随 handler 一并删除，不再双写。
- `cancelPdfProcessing` 现在对所有 remove/clear 入口生效（此前仅附件面板路径会取消，
  预览 chips 等其他直连 store 的入口不会），语义更一致。

## 校验

- `rg 'cancelPdfProcessing|revokeObjectURL|logAttachment|getErrorMessage'` 在面板文件中零命中。
- 红线 grep（见上）确认 sendMessage / abort / stream / queue 相关段零改动。
- 依指令未运行 npm/tsc/vitest 等工具链，未 git commit。
