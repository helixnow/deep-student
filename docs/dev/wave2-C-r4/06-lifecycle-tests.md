# 06 附件生命周期三路径等价性测试（R4 卡「测试-附件生命周期」）

- 轮次：0824 Wave2-C 第 4 轮；模型 claude-fable-5-thinking-high
- 产出文件：`src/features/chat/core/store/__tests__/sessionActions.attachmentLifecycle.test.ts`（新增，21 个用例）
- 约束遵守：**未执行任何测试**；未改 `sessionActions.ts` 及任何产品代码（卡 1 独占）；未 git commit

## 1. 被测语义与基线现状

三条 UI 删除入口最终应收敛进 store 单点（卡 1 目标，账本 `docs/dev/wave2-C-ledger.md` P2「附件清理三所有者」+ 卡「附件清理单一所有者」）：

| 路径 | 入口 | 现状链路 | 现状问题 |
| --- | --- | --- | --- |
| ① chip 删 | `AttachmentPreviewChips.tsx:352-357` X 按钮 | `onRemove(attachment.id)` → InputBarUI `onRemove={onRemoveAttachment}`（:2444）→ `useInputBarV2.ts:472-477` → store `removeAttachment` | **全链无 `cancelPdfProcessing`**，后端任务变孤儿（移动端最常用入口清理最不完整） |
| ② 面板删 | `AttachmentPanelBody.tsx:116-136` 行内「移除」 | UI 先自行 cancel + `revokeObjectURL`，再 `onRemoveAttachment` → store `removeAttachment`（store 又 revoke 一遍） | 双所有者、**同一 blob URL 双 revoke** |
| ③ 清空 | `AttachmentPanelBody.tsx:98-114`「全部清除」 | UI 逐个 cancel + revoke，再 `onClearAttachments` → store `clearAttachments`（又批量 revoke） | 同上 |

store 侧现状：`sessionActions.ts` `removeAttachment`（:204-245）/ `clearAttachments`（:247-306）做附件出列、`removeContextRef`（按 resourceId）、`pdfProcessingStore.remove`（按 sourceId）、blob revoke，**唯独缺 cancelPdfProcessing**。

卡 1 落地形态（测试按此写断言）：`cancelPdfProcessing(att.sourceId)`（fire-and-forget + 日志）移入 store 两个 action；删 `AttachmentPanelBody` UI 层重复清理；chips 自动继承；`InputBarUI.tsx:1737-1745` 宿主卸载兜底 revoke 保留。

## 2. 测试文件结构与红绿矩阵

三个 describe 块。【修复前红】= 基线上应失败、卡 1 后应转绿；【防回归】= 基线与修复后都应绿，防止卡 1 收敛时误删既有清理；【防回归→卡 1 加严】= store 单测层面基线已绿，但断言的「恰好一次」在收敛后成为整链保证。

### 2.1 `removeAttachment 单附件删除语义`（7 用例，覆盖路径①②收敛点）

| 用例 | 修复前 | 断言要点 |
| --- | --- | --- |
| 按 sourceId 取消后端任务，恰好一次 | 红 | `cancelPdfProcessing('file_pdf_1')` × 1 |
| 仅 sourceId（无 resourceId）中间态同样取消 | 红 | cancel 键在 sourceId、不受 resourceId 门控（面板路径今天就有此语义，收敛后不得丢）；`removeContextRef` 不调用 |
| 附件出列 / ContextRef / pdf store 清理 | 绿 | `removeContextRef('res_pdf_1')`；`pdfStore.remove('file_pdf_1')`（键是 sourceId 而非 resourceId） |
| blob URL 恰好 revoke 一次 | 绿（加严） | 收敛后面板整链不得再双 revoke |
| 无 sourceId / 非 blob 附件零副作用出列 | 绿 | cancel / pdf store / revoke 一概不触碰 |
| cancel 是 fire-and-forget | 红 | 同步 action 不抛；后端拒绝不阻断删除；产品代码必须自带 `.catch`（否则 unhandled rejection 炸红全文件） |
| 只清理目标附件 | 绿 | 同列表其他附件的任务/URL/ContextRef 不动 |

### 2.2 `clearAttachments 清空路径语义`（5 用例，路径③）

| 用例 | 修复前 | 断言要点 |
| --- | --- | --- |
| 每个含 sourceId 附件各取消一次 | 红 | 混合列表（pdf 处理中 + 图片就绪 + 纯文本无 sourceId）→ cancel × 2，不含 `undefined` |
| 列表清空 / ContextRef / pdf store 批量清理 | 绿 | 按 resourceId × 2、按 sourceId × 2 |
| 每个 blob URL 恰好 revoke 一次 | 绿（加严） | `data:` URL 不 revoke |
| 空列表 no-op | 绿 | 不抛、零副作用 |
| 清空 cancel 亦 fire-and-forget | 红 | 单个拒绝不阻断其余清理 |

### 2.3 `三入口收敛 source 契约`（9 用例，readFileSync 锁源码形态）

| 契约 | 修复前 |
| --- | --- |
| `sessionActions.ts` 含 `cancelPdfProcessing`（取消唯一所有者是 store） | 红 |
| `AttachmentPanelBody.tsx` 不含 `cancelPdfProcessing` | 红 |
| `AttachmentPanelBody.tsx` 不含 `revokeObjectURL` | 红 |
| 面板仍委托 `onRemoveAttachment` / `onClearAttachments`（入口不改道） | 绿 |
| chip X 裸委托 `onRemove(attachment.id)`，无 cancel/revoke | 绿 |
| InputBarUI chip 与面板接同一对回调（`onRemove={onRemoveAttachment}` 等三处接线） | 绿 |
| `useInputBarV2` 直达 `store.getState().removeAttachment/clearAttachments`，无旁路清理 | 绿 |
| 消息态 `AttachmentPreview.tsx` 同样裸委托 store（同族第四入口不例外） | 绿 |
| InputBarUI 宿主卸载兜底 revoke 保留（`attachmentsRef.current.forEach…revokeObjectURL`） | 绿 |

行为用例（2.1/2.2）证明 store 语义完整；source 契约（2.3）证明三入口全部裸委托、无第二份清理 —— 两者合起来即「三路径语义一致」：任何入口删同一附件，可观测副作用集合相同。

## 3. mock 设计

- `@/api/vfsPdfProcessingApi`：`importOriginal` 展开后仅覆写 `cancelPdfProcessing`（默认 `mockResolvedValue(true)`，拒绝场景单独 `mockRejectedValue`）。基线上 store 不 import 该模块，mock 惰性不生效 → cancel 用例自然红。
- `@/features/pdf/stores/pdfProcessingStore`：`importOriginal` 展开后把 `usePdfProcessingStore` 替换为 `{ getState: () => ({ remove: mock }) }`，避免真 zustand store 的 60s 自动清理定时器污染用例。
- `URL.revokeObjectURL`：jsdom 不实现，`beforeAll` 经 `Object.defineProperty` 装 mock、`afterAll` 还原描述符。
- `../../registry/eventRegistry`：与既有 `sessionActions.authorityMode.test.ts` 同款 Map mock（sessionActions 模块加载即注册 plan_gate 处理器）。
- `removeContextRef` 属 contextActions，harness 只造 sessionActions → 直接把 `vi.fn()` 注入状态对象，经 `getState()` 被 action 调到。
- harness 复用 authorityMode 测试的手写 `set`/`getState` 模式，不起真实 zustand store。

## 4. 给卡 1 的语义契约点（测试会强制的实现约束）

1. cancel **键在 `sourceId`**，不得嵌进 `resourceId` 分支（否则「仅 sourceId 中间态」用例仍红）——现状 store 的 `pdfStore.remove` 就嵌在 resourceId 门里，移 cancel 时别照抄该嵌套。
2. cancel 必须 **fire-and-forget 且自带 `.catch`**：action 保持同步签名，拒绝时不抛；漏 catch 会以 unhandled rejection 形式在 vitest 炸红。
3. `AttachmentPanelBody` 的 cancel **和 revoke 都要删**（source 契约两条分开锁），但 `InputBarUI` 卸载兜底 revoke 必须保留（有正向契约锁着，防止顺手多删）。
4. 每 sourceId 每次删除操作 cancel **恰好一次**、每 blob URL revoke **恰好一次**（`toHaveBeenCalledTimes` 锁死，防中间态双取消/双释放）。
5. `pdfStore.remove` 在「仅 sourceId 无 resourceId」场景未做断言（现状不清理，是否顺手修归卡 1 自由裁量，测试不越权约束）。

## 5. 未验证事项

- 全部用例**未执行**（本轮禁令）；类型层面亦未 `tsc`（工作副本无 node_modules）。书写时对照了 `sessionActions.authorityMode.test.ts` 的 harness/mock 惯例与 `InputBarUI.appMenuOutsideClick.pointer.test.tsx` 的 source 契约惯例。
- source 契约的正则基于当前源码实锤行（InputBarUI :2131-2132/:2444/:1737-1745、useInputBarV2 :474/:481、AttachmentPreviewChips :356、AttachmentPreview :338）；卡 1 若重构改名需同步调整契约（属预期红，非误报）。
- 后端孤儿任务的实际行为（cancel 未发出时后端是否自愈）不在本测试范围，沿账本标注保持未验证。
