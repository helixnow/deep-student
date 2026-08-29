# 0824 Wave2-C R7 · 测试员-附件三路径（source 矩阵）

- 角色：第 7 轮测试员（claude-fable-5-thinking-high）
- 工作目录：`/tmp/0824-wave2-c-r7-attach-seq`
- 约束遵守：未执行任何测试；未改任何产品代码；未 commit。
- 产出物：`tests/vitest/mobile-uiux/attachmentRemovePaths.matrix.source.test.ts`（新增，唯一改动）

## 任务理解

已有 `src/features/chat/core/store/__tests__/sessionActions.attachmentLifecycle.test.ts`
从【行为】层验证 store 两个 action（mock cancel/revoke/pdfStore 后调用 action 断言副作用）。
本轮补一张【source 矩阵】：把「面板行删 / chip X 删 / 全部清除」三条 UI 路径的每一站
横向铺开逐格断言，锁定两条不变量：

1. 三路径全部收敛进 store（`sessionActions.removeAttachment` / `clearAttachments`），
   途中每站都是裸委托；
2. UI 层零 cancel（`cancelPdfProcessing` 在 chat feature 生产源里唯一所有者是
   `sessionActions.ts`）。

## 现状勘察（决定矩阵的预期方向）

卡 1「remove/clear 语义收敛进 store」在当前工作树**已落地**：

- `sessionActions.ts:81-88`：`cancelAttachmentProcessing` helper —
  `void cancelPdfProcessing(sourceId).catch(...)` fire-and-forget + 日志；
- `removeAttachment`（219-264）：`sourceId` 门控下 cancel + 清 pdfProcessingStore，
  出列后按 `resourceId` 移 ContextRef、按 `blob:` 前缀 revoke；
- `clearAttachments`（266-332）：逐附件 cancel、批量 revoke、批量清 ContextRef/pdfStore；
- `AttachmentPanelBody.tsx` 已纯展示化（99-100 行注释即收敛声明），无 cancel/revoke，
  行删 `onClick={() => onRemoveAttachment(attachment.id)}`（1 处），
  清空 `onClick={onClearAttachments}`（2 处：移动端 AppMenuItem + 桌面 DsButton）；
- `AttachmentPreviewChips.tsx`：X 按钮裸委托 `onRemove(attachment.id)`（1 处），
  无 `getState()`、无 revoke；
- `InputBarUI.tsx`：chip 与面板接同一对回调
  （`onRemove={onRemoveAttachment}` / `onRemoveAttachment={onRemoveAttachment}` /
  `onClearAttachments={onClearAttachments}`）；宿主卸载兜底 revoke 保留（1770-1776）；
- `useInputBarV2.ts`：`store.getState().removeAttachment(attachmentId)` /
  `store.getState().clearAttachments()` 直达 store；
- 消息态 `AttachmentPreview.tsx`：同样裸委托 `store.getState().removeAttachment`。

因此本矩阵定位为**防回潮全绿锁**（非 TDD 红灯）——与同目录
`touchTargetOwnership.contract.test.ts` 的所有权矩阵同款思路。

## 矩阵结构

### 防空断言（anchors）

- 6 个登记源文件全部存在且非空；
- store 两个 action 切片锚点（与既有 `AttachmentPreviewChips.removeCancels.source.test.ts`
  同款锚点：`removeAttachment: (attachmentId: string): void =>` →
  `clearAttachments:`；`clearAttachments: (): void =>` → `setPanelState:`）
  漂移时直接红，不让切片断言空转。

### 矩阵 ① 三路径 × 四站点（`describe.each`，3 行 × 4 格 = 12 用例）

| 路径 | 站点 1 入口委托（精确计数） | 站点 2 InputBarUI 接线 | 站点 3 hook 终点 | 站点 4 store 切片含 cancel |
|---|---|---|---|---|
| 面板行删 | `onClick={() => onRemoveAttachment(attachment.id)}` ×1 | `onRemoveAttachment={onRemoveAttachment}` | `store.getState().removeAttachment(attachmentId)` | `removeAttachment` 切片 |
| chip X 删 | `onRemove(attachment.id)` ×1 | `onRemove={onRemoveAttachment}` | 同上 | 同上 |
| 清空 | `onClick={onClearAttachments}` ×2（移动菜单行 + 桌面按钮） | `onClearAttachments={onClearAttachments}` | `store.getState().clearAttachments()` | `clearAttachments` 切片 |

入口委托用**精确出现次数**断言：少了 = 入口丢失，多了 = 渲染分支复制出第二份入口。
站点 4 用正则 `cancelAttachmentProcessing\(|cancelPdfProcessing\(` —— 锁「action 内发生
cancel」语义，不锁 helper 名（direct call 或 helper 重构均可）。

### 矩阵 ② UI 零 cancel / 零旁路清理（文件 × 禁用 token）

| 文件 | 禁用 token |
|---|---|
| AttachmentPanelBody | `cancelPdfProcessing`、`vfsPdfProcessingApi`、`revokeObjectURL`、`usePdfProcessingStore.getState()` |
| AttachmentPreviewChips | 同上四项 |
| useInputBarV2 | `cancelPdfProcessing`、`vfsPdfProcessingApi`、`revokeObjectURL` |
| AttachmentPreview（消息态） | 同上三项 |
| InputBarUI | 仅 `cancelPdfProcessing` |

外加四条：

- **唯一所有者扫描**：递归遍历 `src/features/chat` 生产源（排除 `__tests__`），
  含 `cancelPdfProcessing` 的文件必须 `=== ['core/store/sessionActions.ts']`
  （已核实当前扫描结果恰好如此）；
- store 端 cancel 形态锁：`void cancelPdfProcessing(...).catch(` fire-and-forget；
- store 两切片各自持有 `URL.revokeObjectURL` + `usePdfProcessingStore.getState().remove(`
  （前端清理防回退）；
- InputBarUI 宿主卸载兜底 revoke 保留（`attachmentsRef.current.forEach…revokeObjectURL`）。

## 刻意不锁的边界（防误报）

- **InputBarUI 的 `vfsPdfProcessingApi` import**：它合法持有
  `getBatchPdfProcessingStatus` / `retryPdfProcessing`（进度轮询 + 重试，
  `InputBarUI.tsx:22`），只禁 `cancelPdfProcessing` token 本身；
- **InputBarUI 的两处 revoke**（`reader.onerror` 创建失败清理 + 卸载兜底）：
  属「创建失败/宿主销毁」所有权，不是删除路径，不计数不禁令，只正向锁卸载兜底仍在；
- **chips 的 `usePdfProcessingStore` import**：订阅式读 statusMap 合法，
  只禁命令式 `usePdfProcessingStore.getState()`。

## 与既有测试的去重关系

- 行为语义（cancel 恰一次、fire-and-forget 不抛、no-op 等）归
  `sessionActions.attachmentLifecycle.test.ts`，本矩阵不复述 mock 行为用例；
- chip 单路径细节（stopPropagation、prop 形状）归
  `AttachmentPreviewChips.removeCancels.source.test.ts`，本矩阵只留跨路径格子；
- 本矩阵独有增量：三路径横向对照、入口委托精确计数、`onClearAttachments`
  移动/桌面双分支覆盖、chat feature 级 cancel 唯一所有者扫描、
  消息态 `AttachmentPreview` 入口纳入同族。

## 验证情况

- 本轮**禁止执行测试**：文件未运行（vitest include `tests/vitest/**/*.{test,spec}.{ts,tsx}`
  已覆盖新路径，可被发现）。
- 所有精确计数与禁令 token 均已用 grep 对照当前源码逐项核实
  （chips 委托 ×1 / panel 行删 ×1 / panel 清空 ×2 / hook·消息态零 vfsApi 零 revoke /
  `void cancelPdfProcessing(sourceId).catch` 在 `sessionActions.ts:82`），
  预期在当前源码上 12 + 9 = 21 用例全绿。
- 风险自评：站点 4 与既有 removeCancels 测试共用锚点字符串，action 签名重构时
  两文件会一起红（有防空断言指路）；唯一所有者扫描覆盖 `dev/`、`debug/` 目录，
  若日后调试工具需要合法调 cancel，需在测试里显式扩白名单——这是刻意的显式化成本。
