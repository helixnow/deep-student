# 笔记 ACR 生命周期审计

日期：2026-07-11

范围：`note_read`、`note_append`、`note_replace`、`note_set` 从工具参数、Rust CanvasToolExecutor、ACR probe/apply_ops、Workbench StageManager、noteDriver、Crepe 编辑器、自动保存、建议 diff、撤销与降级的完整链路。

## 生命周期矩阵

| 阶段 | 关键契约 | 当前结论 | 验证 |
| --- | --- | --- | --- |
| 参数归一化 | `noteId/note_id`、`isRegex/is_regex`、空内容与空 search 拒绝 | 通过 | Rust executor tests |
| probe | `disabled/closed/frozen/dirty/hot/clean` 分层 | 通过；hot 现在要求编辑器真实 `hasFocus()` | `probe.test.ts`、`noteDriver.test.ts` |
| 路由 | clean/dirty/hot 委托；不可委托后端回落；apply 提交后禁止双写 | 通过 | `canvas_executor.rs`、bridge tests |
| Workbench 租约 | 单窗并发、窗口关闭、StageManager stop、TTL/orphan | 通过现有生命周期测试 | `stageManager.test.ts`、`lifecycleEdgecases.test.ts` |
| 追加演出 | caret、分批/结构化插入、AgentStrip、progress、ledger | 通过；纯文本打字机，Markdown 走 parser 结构插入 | `noteDriver.test.ts`、`agentInsertMapping.test.ts` |
| 用户冲突 | 真实编辑器焦点暂停；失焦恢复；持续占用最终 abort | 已修复 selection 误判 | `noteDriver.test.ts`、S-SUG-04 |
| 破坏类 | dirty/hot 进入 AIDiffPanel；clean 直写 | 通过；建议模式不直接改正文 | `noteDriver.test.ts` |
| 持久化 | frontend completed 前等待保存队列；保存失败返回 partial | 已补齐 `flushPendingSave()` | `noteDriver.test.ts`、`NotesCrepeEditor.saveQueue.test.tsx` |
| 撤销 | append/set 的 inverse 逆序执行并等待保存 | 已补齐保存等待 | `noteDriver.test.ts`、ledger tests |
| 建议接受 | 接受后保存；保存失败恢复接受前快照 | 已补齐 | `useCanvasAIEditHandler.ts` |
| 建议重试 | 编辑器不可写、应用失败、保存失败均保留原 diff；提交中拒绝重复接受 | 已补齐 | `useCanvasAIEditHandler.test.tsx` |
| 建议并发 | 已有待确认建议时，新建议明确失败，不覆盖当前 diff | 已补齐同步占位，覆盖同事件循环竞态 | `useCanvasAIEditHandler.test.tsx` |
| 建议回滚 | 回滚保存失败不能清掉 checkpoint | 已补齐 | `useCanvasAIEditHandler.ts` |
| 混合批次 | 建议是用户决策屏障；前序写入先保存，后续 op 不越过确认点 | 已补齐 | `noteDriver.test.ts` |
| 降级 | closed/frozen/disabled 写盘并发 `dstu:change`，结果标注 backend | 通过代码与 Rust 路径核对 | `canvas_executor.rs` |

## 本轮修复

1. `captureSelection()` 只代表历史选区，不再代表用户仍在编辑；新增 `hasFocus()`，note probe/等待逻辑只依据真实编辑器焦点。
2. ACR 写入完成前调用 `flushPendingSave()`，从编辑器当前全文刷新草稿并等待保存队列；保存失败不再伪造 completed。
3. 多行或带 Markdown 标记的追加不再使用 `insertText` 写入字面语法，改用 Milkdown parser 生成结构化片段；单行纯文本仍保留打字机演出。
4. 直接写入和部分写入的 ledger inverse 同样等待持久化，避免撤销只改内存。
5. 建议接受/检查点回滚的保存失败路径不再留下“界面已改、磁盘未改”的静默分叉。
6. 单行标题、列表、引用、链接、行内代码和公式也走 Markdown parser；普通方括号、算术星号和单个货币符号不误判。
7. 建议接受只在编辑器应用与持久化均成功后清理 diff；双击或快捷键重复提交由同步互斥保护。
8. 建议请求到达时在 ACK 前同步占位，背靠背请求不能覆盖当前 diff；后到请求收到明确失败结果。
9. 多 op 批次遇到建议模式后停止越过决策点；已执行的前序写入仍等待保存，回执保留 `mode=suggestion` 与 `suggestionPending=true`。

## 可泛化原则

- `selection`、`window focused`、`editor DOM focused`、`dirty` 是四个不同信号，不能互相替代。
- ACR 的 `completed` 必须表示目标平面和持久化平面都完成；只完成 DOM transaction 应返回 partial 或 pending。
- 富文本域的演出 API 必须区分纯文本插入与结构化解析插入，不能把 Markdown 字符串直接塞进 ProseMirror text 节点。
- 所有 ledger inverse 都必须沿用正向操作的持久化确认语义。
- 建议/审批状态在保存失败时必须保留可恢复路径，不能先清 UI 状态再报告失败。
- 异步 ACK 之前必须先完成本地占位，否则同事件循环内的并发事件仍能穿透“已有任务”检查。
- 需要用户确认的建议是批次内的决策屏障；屏障前的副作用必须落盘，屏障后的操作必须停止并进入 `undone`。

## 后续真实 UI 验证

启动烟测已完成：Debug 二进制重建后通过 tauri-lab 重启 `dev-current`，metrics ready，slotA 无 pending，启动段无 panic。功能交互项仍需真实模型请求授权。

- clean 单行追加：观察 AI caret、词级进度、自动保存和重开后内容。
- clean Markdown 追加：确认列表/粗体/公式为真实结构而非字面语法。
- 用户将焦点放在编辑器：确认追加暂停；切换到 Chat：确认恢复。
- dirty/hot replace：确认 diff 接受、拒绝、接受保存失败、检查点回滚。
- 关闭窗口、切换笔记、停止运行：确认 partial/取消回执和无孤儿 AgentStrip。
