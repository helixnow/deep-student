# ACR 3.0 验收矩阵

> 范围：Chat tool call -> Rust executor -> authenticated bridge -> StageManager transaction -> exact UI surface -> persistence -> receipt/undo。本文补充 `ACR-3.0.md` 的实现门禁，不替代历史 R1-R3 报告。

## 1. 发布判定

ACR 3.0 只有在以下三层均通过后才能宣布为默认 mutating runtime：

1. **静态契约**：TypeScript/Rust 数据结构、错误码、风险分级、技能说明一致。
2. **自动化**：TypeScript 定向测试与协调者统一执行的 Rust 测试通过。
3. **真实桌面**：使用 `npm run tauri dev` 完成 Chat -> Rust -> bridge -> UI -> persistence -> reopen，且 DevPanel 无泄漏事务/租约。

未执行的 Cargo 或真实 Tauri E2E 必须明确写“未执行”，不得以 typecheck/单测代替。

## 2. 核心验收场景

| ID | 场景 | 预期 | 自动化证据 | 真实 E2E |
|---|---|---|---|---|
| ACR3-ID-01 | 两个 session 使用相同 `toolCallId` | 生成不同 `acr3:<len>:<session>:<toolCall>`；presence、ledger、cancel、工具卡互不串线 | bridge Rust test；StageManager/tool-card tests | 打开两个 Chat session 并行验证 |
| ACR3-ID-02 | correlation 相同但 session/run 不同 | 活跃期拒绝重复 correlation，不覆盖原终态 | StageManager duplicate tests | DevPanel 检查唯一 transaction |
| ACR3-WIN-01 | 同资源打开两个窗口，probe 命中其中一个 | apply target 必须携带 probe 回执的 `windowId`，只修改该窗 | `probe.test.ts`；Rust canvas/mindmap contract | 两窗并排观察高亮与内容 |
| ACR3-WIN-02 | probe 后窗口关闭或切换资源 | apply 返回 `STALE_TARGET_WINDOW`，不改另一窗口、不后台回落 | `stageManager.test.ts` | probe 后手动切 tab/关窗 |
| ACR3-LEASE-01 | act/apply/undo 竞争同一窗口 | 后来的写返回 `WINDOW_BUSY`；原事务终结后租约释放 | StageManager lease tests | DevPanel 观察 lease 0 -> 1 -> 0 |
| ACR3-CAN-01 | op 间取消 | 不启动新 op；返回已知 `cancelled/partial` 前缀 | StageManager cancel tests | 操作中点击停止 |
| ACR3-CAN-02 | 取消/超时后 drain 内收到终态 | Rust 返回该权威终态，不伪造 `applied:0` | bridge Rust test | 长笔记操作中取消 |
| ACR3-CAN-03 | bounded drain 结束仍无终态 | `RESULT_UNKNOWN`, `resultUnknown:true`, `retryable:false`；工具卡显示未知态；禁止原样重试/回落 | bridge/tool-card tests | 模拟 UI surface 卡死 |
| ACR3-AUTH-01 | response token/correlation 不匹配 | 响应不可采信；mutating 请求按未知终态处理 | bridge Rust identity tests | 注入错误 token 的测试桥 |
| ACR3-OCC-01 | note append/replace/set 无 `expected_updated_at` | `NOTE_OCC_REQUIRED`，无前端/后端写入 | canvas contract tests | 后台模式调用写工具 |
| ACR3-OCC-02 | read 后用户先修改笔记 | VFS CAS 返回 `NOTE_CONFLICT`，保留用户内容 | canvas/VFS Rust tests | 两窗竞争同一笔记 |
| ACR3-OCC-03 | probe 未知、畸形、超时或 frozen | destructive/dirty 写 fail closed，不无条件后台写 | canvas Rust tests | 冻结/卸载 surface 后写入 |
| ACR3-UNDO-01 | 正常 persistent undo | High 单次确认；inverse/persistence 验证成功才消费 token | agent runtime/tool-card tests | 修改 -> 重启 -> 撤销 -> reopen |
| ACR3-UNDO-02 | 同 token 并发撤销 | 仅一个 replay；另一个返回 `UNDO_IN_PROGRESS` 或 UI 被 single-flight 禁用 | undo journal/tool-card tests | 快速双击撤销 |
| ACR3-UNDO-03 | forward 后用户修改目标 | 返回 `UNDO_CONFLICT`，不覆盖新状态，token 保留 | agent runtime tests | 修改 -> 用户编辑 -> 撤销 |
| ACR3-UNDO-04 | inverse 部分成功后失败 | 记录剩余 inverse 和新 guard；重试不从头重放 | undo journal tests | 故障注入后重试 |
| ACR3-RISK-01 | `open_app(browser,{url})` | 至少 Medium；background 不抢焦点 | Rust sensitivity tests | 审批 UI + 焦点检查 |
| ACR3-RISK-02 | undo / close / act_high | High；每次精确确认；无 remember 授权 | Rust approval tests；工具说明 contract | 连续两次撤销均要求确认 |
| ACR3-ACK-01 | manifest mutating action 无真实 surface ACK | `ACTION_UNAVAILABLE`/failed，不以 dispatch/timer/本地 sequence 自证完成 | manifest/register tests | 各应用抽样动作 |
| ACR3-OBS-01 | 活跃、取消、孤儿排空、撤销 | DevPanel 展示 transaction kind/state、lease、cancelling、orphan-draining、undo-in-flight | `workbenchDevPanel.test.tsx` | 操作中观察 HUD |

## 3. 回执一致性

每个 mutating 终态必须满足：

- `completed`: `applied === totalOps`，`undone=[]`，UI surface 与持久化边界均 ACK。
- `partial`: `done/undone/applied` 描述同一已知前缀；不得把未知部分写成未执行事实。
- `cancelled`: 取消已被观察，且 applied prefix 已知。
- `failed`: 没有已接受的 mutation；若无法证明，必须是 `RESULT_UNKNOWN`。
- `suggestionPending`: owning surface 已确认接收建议；仅 dispatch event 不算。
- 任意 bridge success 都必须包含命令所需 data；`ok:true,data:{}` 不能作为 mutating 成功。

## 4. 自动化命令

子任务可执行：

```bash
npm run typecheck
npx vitest run \
  src/features/workbench/agent/__tests__/probe.test.ts \
  src/features/workbench/agent/__tests__/stageManager.test.ts \
  src/features/chat/plugins/blocks/__tests__/workbenchOpsBlock.test.tsx \
  src/features/chat/skills/__tests__/workbenchToolsV2Contract.test.ts \
  tests/vitest/workbench/workbenchDevPanel.test.tsx
npm run check:i18n
git diff --check
```

协调者统一执行（子代理禁止 Cargo）：

```bash
# 在 src-tauri 内按项目门禁执行 Rust fmt/check/test；具体命令由协调者统一调度。
```

真实桌面验收必须按仓库约束启动：

```bash
npm run tauri dev
```

## 5. 当前验收记录（2026-07-13）

| 层 | 状态 | 说明 |
|---|---|---|
| ACR 3.0 TypeScript 定向测试 | 待本轮完成后回填 | 不提前宣称通过 |
| TypeScript typecheck | 待本轮完成后回填 | 共享工作区最终态执行 |
| i18n 检查 | 待本轮完成后回填 | 工具卡新增 unknown/风险文案 |
| Rust fmt/check/test | **未执行** | 按 `STANDARDS.md` 由协调者统一执行 |
| 真实 Tauri E2E | **未执行** | 需 `npm run tauri dev`，本子任务禁止启动 |
| DevPanel 运行时采样 | **未执行** | 自动化只验证渲染契约，仍需真实操作观察 |

## 6. 阻断发布条件

以下任一项存在即不得宣布 ACR 3.0 完成：跨 session 串线、粗粒度错窗、mutating ACK 自证、取消后伪造零应用、`RESULT_UNKNOWN` 自动重试/回落、无 OCC 的 Notes 回落、undo 覆盖用户新状态、High 路径可记忆授权、终态后残留 lease/transaction/presence。
