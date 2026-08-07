# R2-09 — 生命周期边界 16 条结论表

日期：2026-07-10  
依据：`DESIGN.md` §6 / §4.3、生命周期调研 16 条边界清单、ROUND2 R2-09。

图例：`OK` 已满足 · `FIXED` 本卡定点小修 · `CROSS` 跨界申请 · `KNOWN` 已知限制（文档化）

| # | 边界 | 结论 | 证据 / 动作 |
|---|------|------|-------------|
| 1 | **frozen 唤醒** | **FIXED** | probe=`frozen`；`follow` 档 `apply_ops` 前 `focusWindow` + 乐观 `lifecycle=focused` + `requestWakePrefetch`（`stageManager.wakeFrozenIfFollow`）。`background` 仍由 Rust probe 回落后端（DESIGN §1.1/§6）。单测：`lifecycleEdgecases` follow 唤醒。 |
| 2 | **钉住防冻 / 演出心跳** | **OK** | 无 anti-freeze pin；演出中 `requestWakePrefetch` + `reportSchedulerActivity('stream')` 每 3s（`startHeartbeat`）。Dock pin 与冻结无关（调研结论）。 |
| 3 | **freezeImminent（2.5s 宽限）** | **OK** | scheduler `FREEZE_GRACE_MS` + `freezeImminent` hint（`scheduler.test`）；ACR 侧靠 prefetch 心跳避开宽限内真正冻结。无需 StageManager 改动。 |
| 4 | **最小化 / background 演出** | **FIXED** | DESIGN §4.3：`focused/visible` 才演出；`minimized`/`background`/`frozen` → 强制 `createPacer('fast')` 直落（`shouldInstantDrop`）。单测：最小化 + pacing=demo 仍 `instant=true`。 |
| 5 | **多窗同资源去重** | **OK** | `openWindow`：`typeId+instanceKey` 去重只 focus（`windowStore`）。单测覆盖。mindmap 全局 store 冲突属既有限制（R2-02）。 |
| 6 | **chat 无 instanceKey 壳** | **OK / KNOWN** | Dock 无 key 可开 `instanceKey=null` 壳；`probe` 精确 `resourceId` 不会误命中 null-key；无 resourceId 取同 typeId 最近焦点。快照恢复 null-key 再建会话为 P7/验收 #27 已知限制。单测覆盖寻址语义。 |
| 7 | **launchPayload 不入快照** | **OK** | snapshot 明确不含 payload（调研 #7）；agent 应依赖 `instanceKey`/后端。走查，无 ACR 缺口。 |
| 8 | **重启/崩溃未完成 tool_loop** | **OK / KNOWN** | DESIGN §6：账本内存级，不承诺续跑。与 chat_v2 repair/continue 现状一致。 |
| 9 | **运行中关 OS 模式** | **CROSS→R2-08** | R2-08 已接 control=off / mode 关闭 abort 活跃 run（`abortAllActiveRuns`）。本卡确认 `stageManager` 已有路径；端到端 i18n/闸门归 R2-08。 |
| 10 | **`launch` 在 enabled=false** | **OK** | `open_app` → `WORKBENCH_DISABLED` / gates；probe=`disabled`。 |
| 11 | **Browser chrome frozen / OS 关** | **CROSS→R2-10** | content Webview 与 chrome 生命周期解耦；ControlMode / 双闸闭环归浏览器长尾区。 |
| 12 | **审批可见性（High 前 focus chat）** | **CROSS→R2-05** | DESIGN §6 / 调研 #12：审批前应 `focusWindow` 会话 chat 窗。前端 StageManager 无审批入口；需 Rust tool_loop / chat 呈现区接线。 |
| 13 | **ExecutionContext 无 workbench 窗字段** | **OK / KNOWN** | 工具参数显式传 `typeId`/`resourceId`；不扩 ExecutionContext（冻结契约）。 |
| 14 | **快照恢复后 windowId 失效 / 资源已删** | **FIXED / OK** | `pruneSnapshotWindows` 丢弃无效资源窗；`apply_ops` 再校验 `windows[windowId]`；probe 按 `instanceKey` 重解析。单测：关壳重开同资源 → 新 id。 |
| 15 | **多 chat 窗 + 全局「当前会话」** | **OK / KNOWN** | 聚焦 chat 时 sessionManager 指针切换（ChatAppWindow）；agent 应绑 sessionId/`instanceKey`，勿依赖全局当前会话。 |
| 16 | **闸门 fail-closed** | **CROSS→R2-08** | `tools.workbench_agent` + `desktop.workbenchAgentControl`；off/background/follow 定稿与 i18n 归权限区。本卡确认 probe/open_app 降级路径存在。 |

## ROUND2 点名项（与上表交叉）

| 点名项 | 映射 | 结论 |
|--------|------|------|
| frozen 唤醒 | #1 | FIXED（follow） |
| freezeImminent | #3 | OK |
| 最小化窗演出 | #4 | FIXED（直落） |
| 关窗中断 run | — | **FIXED**：`close_window` 与 `windowStore.subscribe` 删窗均 `abortRunForWindow` |
| 快照恢复 windowId 失效 | #14 | FIXED/OK |
| chat 无 instanceKey | #6 | OK/KNOWN |
| 资源被删（prune + resourceSync） | #14 + 关窗 abort | **FIXED**：resourceSync→`closeWindow`→订阅 abort；`closeWindowsForDeletedResource` 单测 |
| 多窗去重 | #5 | OK |

## 本卡代码改动

- `stageManager.ts`：`abortRunForWindow`、关窗/删窗订阅、`wakeFrozenIfFollow`、`shouldInstantDrop`、失效 windowId 校验、`setAgentControlForTests`
- `__tests__/lifecycleEdgecases.test.ts`：8 条防御测试

## 未改（跨界）

见上表 CROSS 行；大修不在本区写权内。
