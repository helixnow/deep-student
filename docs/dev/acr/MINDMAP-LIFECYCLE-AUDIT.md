# Mindmap ACR Lifecycle Audit

审计日期：2026-07-11

## 已确认并修复

1. `probe` 只在目标资源对应 store 已加载时返回可编辑状态；`editingNodeId` 为真实节点编辑态，优先判为 `hot`，普通未保存内容判为 `dirty`。
2. 建议模式采用逐操作决策屏障：建议前的非破坏操作可以完成，首个 `delete_node` / `move_node` 停止批次，后续操作不得越过屏障。
3. driver 使用 `_documentVersion` 区分本次 ACR 自身写入与执行期间插入的用户编辑；后者会让后续破坏操作进入建议模式。
4. 拒绝式建议不修改待确认的破坏操作，回执保留 `mode=suggestion`、`suggestionPending=true` 和全部未执行步骤。
5. apply 不再在 debounce save 前返回 completed；有实际写入时显式等待 `save()`，保存失败返回 `partial`。
6. abort 或暂停取消后的已执行前缀同样经过统一保存收尾；未执行步骤进入 `undone`。
7. ledger 的 add/update/delete/move 逆操作均等待保存。保存失败时 `revertRun()` 返回 false，账本保留供重试。
8. 四类逆操作均为幂等重试，避免首次逆操作已改内存但保存失败后，第二次撤销重复插入子树或重复移动。
9. store 的 `save()` 现在返回明确成功标志；冲突重载、结构错误、网络失败和已有保存占用均不会被 ACR 误判为已落盘。

## 验证

- `mindmapDriver.test.ts`：16 tests passed。
- mindmap 相关 9 个测试文件：84 tests passed。
- `npm run typecheck`：passed。
- `git diff --check`：passed。

## 残余风险

- mindmap v1 仍是拒绝式建议，没有树形 diff 的接受/拒绝 UI；`suggestionPending` 表示决策屏障，不代表存在可点击预览。
- 窗口关闭依赖现有同步 localStorage 草稿和异步后端保存双保险；本轮未执行真实 Tauri 窗口关闭故障注入。
- 同一资源多窗口时 driver 仍按资源选择最近注册 store，StageManager 的单窗租约是主要约束；后续应将 driver 解析收紧到 `windowId` 对应实例。
- 未发送外部模型请求，真实 Chat -> tool -> ReactFlow -> reopen 持久化链仍需 UI E2E 复核。
