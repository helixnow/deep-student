# ACR 跨 Driver 生命周期审计

日期：2026-07-11

范围：`note`、`mindmap`、`exam/qbank`、`flashcards/fsrs`、`todo`、`files/finder`、`pomodoro`，以及 StageManager、ledger 和 Rust workbench bridge 回执边界。

## 审计矩阵

| 模块 | 发现的问题 | 修复后的契约 |
| --- | --- | --- |
| note | selection 误作焦点、DOM 完成误作落盘、Markdown 字面插入、建议失败不可恢复 | 真实 `hasFocus()`；completed 等待保存；结构化 Markdown；建议失败保留 diff |
| mindmap | apply/undo 不等待保存、混合批次越过建议、用户并发编辑不可辨识 | `save(): Promise<boolean>`；建议决策屏障；文档版本检测；inverse 等待保存并可重试 |
| qbank | 全局输入框误判 hot、导航事件发出即 completed、撤销前态不真实 | 仅题库编辑域判 hot；可见页面同步 ACK；使用页面返回的真实前题目 |
| fsrs | 完成页仍 hot、失败分支跳过 pacing、混合新旧卡回执污染 | 仅真实答题/评分 hot；所有 op 统一 pacing；只报告实际新增卡 |
| todo | 切换列表未等 reload、详情编辑未判 hot、导航没有可靠 inverse | reload 与状态校验后 completed；真实详情焦点 hot；正向和撤销使用相同完成判定 |
| finder | 内联重命名未判 hot、导航无 inverse、中止时当前 op 重复进入 undone | editingId 判 hot；保存旧路径 inverse；副作用完成后立即推进 nextOpIndex |
| pomodoro | no-op 误报成功、撤销写入 interrupted 记录、后端记录 fire-and-forget | 比较真实前后态；撤销 stop(false)；ACR 等待记录持久化并报告失败 |
| Rust bridge | 只检查回执字段存在，不检查语义 | suggestion 必须 pending；applied 不得越界；数组元素必须为字符串 |

## 统一准入清单

1. `probe` 必须区分窗口焦点、领域编辑器焦点、历史 selection、dirty 和业务 busy；不得用全局 `document.activeElement` 代替领域作用域。
2. `completed` 必须覆盖目标状态及其持久化边界。只有内存/DOM/store 改变时，保存失败必须返回 `partial`。
3. `applied`、`done`、`undone` 必须描述同一事实；已经产生副作用的 op 不能因 pacing 或后续保存失败同时进入 `undone`。
4. `nextOpIndex` 表示下一条尚未产生副作用的 op。当前副作用完成后必须立即推进，避免 abort 把当前 op 重复标为未执行。
5. 需要用户确认的建议是决策屏障：屏障前副作用先持久化，屏障后的 op 停止，回执保留 `mode=suggestion` 和 `suggestionPending=true`。
6. 并发建议必须在首个异步 ACK 前同步占位；后到请求明确拒绝，不得覆盖现有 diff。
7. ledger inverse 使用与正向操作相同的持久化确认；失败应抛出并保留条目供重试。inverse 自身必须幂等。
8. no-op、目标不存在、页面未处理事件和重复入队不能计入 `applied`。
9. driver 的 abort、checkPaused 异常和 pacing 异常必须清理活跃快照，并准确保留已完成前缀和未执行后缀。
10. Rust 边界必须再次校验回执语义，不能仅依赖 TypeScript 类型声明。

## 尚需真实 UI 验证

- 各领域在真实窗口聚焦、失焦、关闭、冻结和恢复时的 probe 路由。
- 导图保存冲突、撤销后关闭重开，以及同资源多窗口。
- 题库页面 ACK 与题目切换/删除竞态。
- 番茄钟记录失败、任务切换和窗口关闭后的后端记录一致性。
- AgentStrip 停止、工具卡撤销和跨窗口并发时无 orphan presence。

真实 Chat 驱动场景会调用外部模型，需获得该次请求授权后执行。
