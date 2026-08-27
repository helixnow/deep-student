# 0824 Wave2-C R6 复核报告 · 06 store（附件动作）

- 复核员：第 6 轮复核员-附件动作（claude-fable-5-thinking-high）
- 工作目录：/tmp/0824-wave2-c-r6-store
- 独占文件：src/features/chat/core/store/sessionActions.ts（含其契约测试）
- 约束遵守：未触碰发送/流式段；未执行测试；未 git commit
- 补丁：/tmp/0824-wave2-c-r6/06-store.patch（2 文件，+16/−13）

## 翻案结论：成立，已修

**指控**：`removeAttachment` 里 `pdfProcessingStore.remove(sourceId)` 嵌在
`if (attachment?.resourceId)` 分支内（旧 243–257 行），受 resourceId 门控。

**核实**：属实。旧结构为 `resourceId` 分支内再嵌 `if (attachment.sourceId)`。
后果：仅有 sourceId、尚未拿到 resourceId 的中间态附件（上传/处理早期被删）
删除后，pdfProcessingStore 的进度条目按 sourceId 键残留 → 内存泄漏 + 同
sourceId 复用时状态污染。这与 `clearAttachments` 已有的语义不一致——那边
`sourceIds` 收集只看 `a.sourceId`（307–309 行），从不受 resourceId 门控；
也与该清理注释自称的「使用 sourceId 作为 key（与后端事件一致）」自相矛盾：
键在 sourceId 上，门控却在 resourceId 上。

## 改动

### sessionActions.ts（removeAttachment）

`usePdfProcessingStore.getState().remove(sourceId)` 及配套
`logAttachment('store', 'processing_store_cleanup', …)` / console 日志，
整体从 `resourceId` 分支提升到顶层 `if (attachment?.sourceId)` 块内，
与 `cancelAttachmentProcessing` 并列；`resourceId` 分支只剩
`removeContextRef` 一件事。清理时机从 `set` 之后移到之前（与 cancel 同段），
pdfProcessingStore 与 chat store 无耦合，顺序无关。

### sessionActions.attachmentLifecycle.test.ts

「仅有 sourceId（无 resourceId）的中间态附件」用例（orphanSourcePdf）原本
只断言 cancel 与 removeContextRef，未钉住旧嵌套（旧代码下也绿），但也没
覆盖本翻案行为。已补两条断言锁定新语义：

```ts
expect(pdfStoreRemoveMock).toHaveBeenCalledTimes(1);
expect(pdfStoreRemoveMock).toHaveBeenCalledWith('file_orphan_3');
```

旧嵌套实现下这两条会红（remove 从未被调），构成本翻案的回归锁。用例名
同步改为「…同样取消后端任务并清理 pdf store」。

## 既有断言逐条核对（新行为下无一破坏）

- `plainDoc`（无 sourceId/resourceId）：`pdfStoreRemoveMock` 不被调 —— 门控仍在 sourceId，成立。
- 防回归用例（processingPdf 双 id）：`remove('file_pdf_1')` 且非 `'res_pdf_1'` —— 键未变，成立。
- 「只清理目标附件」：`not.toHaveBeenCalledWith('file_img_2')` —— 仅删 att_pdf，成立。
- clearAttachments 全部用例：该路径代码未动，成立。
- source 契约用例（正则匹配源码）：无一钉住嵌套结构，成立。

## 未执行项

按指令未跑测试、未 commit；补丁保留在工作树中。
