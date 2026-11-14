WP-026 原子 owner 缺口：请 C1 拆 L04 授权/Plan 仓储面和 L06 todo 保存面；中央组合仍由 L03 完成。

已逐项 git show main 核实 chat/api.ts createExecutionContext/createExecutorRegistry/assembleExecutorRegistry、agent-skills/api.ts registerToolExecutors/toolExecutors、L05 分类/策略/审批、L06 trustedAutomationError/trustedAutomationPreauthorized 均存在，不请求另一套 chatToolRuntime。

L04 `ChatSessionService` / api.ts 仍缺：
- `getSessionAuthorityState(sessionId: string): SessionAuthorityState`，对齐 `chat_v2/repo.rs:2851–2860`；缺会话抛 SessionNotFound，含正确解码的 plan。消费 `approval-gate.ts:195,279`，Rust hooks.rs:544,915。
- `setSessionPlanState(sessionId: string, plan: PlanAuthorityState | null): ChatSession`，对齐 repo.rs:2898–2910；只经 owner 更新 metadata/updatedAt。消费 `approval-gate.ts:360,368,382`，Rust hooks.rs:1451,1490–1550。
- `consumeSessionPlanBinding(sessionId: string, bindingKey: string, now: Date): boolean`，对齐 repo.rs:2915–2940；IMMEDIATE 内重读→精确绑定/有效期→清 plan→commit，不能 get+update 两次独立提交。消费 `approval-gate.ts:292`，Rust hooks.rs:963。
- `createPendingPlan(summary: string, bindingKey: string): PendingPlan` 或上述 PlanAuthorityState 的等价值级公开构造/markApproved/isActiveForBinding（Rust types.rs:597–649；hooks.rs:1447–1448,1528）；L03 现有 PendingPlan/AuthorityState 是消费口，不是仓储实现。

L06 `agentTodo` / api.ts 仍缺：
- `persistTodoList(sessionId: string, messageId: string, variantId: string | null, list: TodoList): void`（或同义 WithConn 公共函数），对齐 `tools/todo_executor.rs:213–261`。已有 getTodoList/restore/load，但没有 save 出口。消费 `tool-round.ts` 的 persistTodoList，Rust tool_loop.rs:2204–2230。

L05 local-shell binding 的 preferredRuntimeRootId 已可由 L03 经 L04 getSessionWithConn/getGroupWithConn 组合，保留 runtime_roots.rs:1414–1499 的同连接读取、trim 和 warn/None，无 SQL 复制；不是额外缺口。

L03 将继续完成真实 registry/context dispatcher 适配、保留 gate/取消/预算。若原子方法本会话内未进 main，按 brief 如实部分交付，不复制跨域 SQL/仓储、不置默认 allow、不用假的 chatToolRuntime 签收三条生产验收。
