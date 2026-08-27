# 0824 Wave2-C R4 · 卡 2「chip 路径对齐」产出报告

- 基线：af0be136
- 工作目录：/tmp/0824-wave2-c-r4-chips
- 独占文件：`src/features/chat/components/input-bar/AttachmentPreviewChips.tsx`
- 约束遵守：未执行任何测试；未 git commit；未改 chip 视觉/伪元素

## 结论：chip 组件零改动，只新增 source 契约测试

### 现状核对（AttachmentPreviewChips.tsx）

chip X 删除按钮（:352-357）当前形态：

```tsx
onClick={(event) => {
  event.stopPropagation();
  onRemove(attachment.id);
}}
```

逐项确认 chip 层**没有**需要删的重复 cancel/revoke：

| 检查项 | 结果 |
| --- | --- |
| 调用 `cancelPdfProcessing` | 无（全文件 0 处） |
| import `vfsPdfProcessingApi` | 无 |
| `URL.revokeObjectURL` | 无（revoke 在 store 层 :241-244 / :263-272） |
| 写 `usePdfProcessingStore.getState()` | 无（chip 只读 `statusMap` 订阅，:181） |

删除路径已经是「chip 只报 id，store 统一清理」的目标形态，因此**未动 onClick，也未动组件任何一行**。任务中「若只为删重复 revoke 可以动 onClick」的许可条件不成立。

### store 层现状（sessionActions.ts，供卡 1 参照）

- `removeAttachment`（:204-245）：清 attachments、removeContextRef、`usePdfProcessingStore.remove(sourceId)`、revoke blob URL——**无 cancelPdfProcessing**。
- `clearAttachments`（:247-306）：批量做同样四件事——**无 cancelPdfProcessing**。
- `cancelPdfProcessing` 定义在 `src/api/vfsPdfProcessingApi.ts:163`（invoke `vfs_cancel_pdf_processing`），目前 src 内无人在删除路径上调用它。

## 新增文件

`src/features/chat/components/input-bar/__tests__/AttachmentPreviewChips.removeCancels.source.test.ts`（只写不跑）

契约分两组，文件头已写明红绿预期：

**第一组 · 基线即绿（chip 保持薄，防回潮）**
1. X 按钮只调 `onRemove(attachment.id)`，且前面有 `event.stopPropagation()`（挡外层「点 chip 开预览」）；
2. chip 不含 `cancelPdfProcessing`、不 import `vfsPdfProcessingApi`；
3. chip 不 `revokeObjectURL`、不写 `usePdfProcessingStore.getState()`；
4. `onRemove` prop 签名保持 `(attachmentId: string) => void`。

**第二组 · 基线预期红，卡 1 落地后转绿（TDD 先行）**
1. `removeAttachment` 实现体切片含 `cancelPdfProcessing`；
2. `clearAttachments` 实现体切片含 `cancelPdfProcessing`；
3. 回归护栏（基线即绿）：卡 1 不得顺手删掉 `removeAttachment` 已有的 `usePdfProcessingStore.getState().remove(attachment.sourceId)` 与 `URL.revokeObjectURL`。

实现细节：
- 切片锚点 `removeAttachment: (attachmentId: string): void =>` / `clearAttachments: (): void =>` / `setPanelState:` 已用 rg 核对在源文件中唯一，并配防空断言（锚点漂移直接红，不让切片断言空转）。
- 风格对齐既有 `*.source.test.ts`（如 `ComposerToolbar.hitTarget.source.test.ts`）：readFileSync + 锚点切片 + 中文注释说明红绿预期。

## 对卡 1 的接口约定

卡 1 在 sessionActions 落地取消时，只要 `removeAttachment` / `clearAttachments` 的实现体内出现 `cancelPdfProcessing` 字样（直接调用或经 `pdfProcessingApi.cancel` 以外的具名引用均可，但契约按字面量 `cancelPdfProcessing` 匹配，建议直接具名 import），第二组即转绿；同时保留既有 processing-store 清 key 和 blob revoke。chip 层无需任何配合改动。
