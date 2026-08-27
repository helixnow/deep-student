# R3-#1：user llm_content sidecar 前移（首个 provider 请求之前落库）

Wave2-A 第 3 轮任务 #1。改动文件：`src-tauri/src/chat_v2/pipeline/persistence.rs`（新函数）、
`src-tauri/src/chat_v2/pipeline.rs`（唯一一处调用）。未触碰 hooks / tool_loop 控制流、
coordinator、history.rs。

## 问题：崩溃窗口

`persist_replay_sidecar`（写 `llm_content` / `tool_call_id` / `round_text` 三列旁路）
此前只挂在两个保存点：

- `save_intermediate_results_inner`（persistence.rs，工具轮间中间保存）；
- `save_results_inner`（persistence.rs，流程末）。

而 `save_user_message_immediately`（pipeline.rs:732 调用）只 INSERT 裸 user 行 + CONTENT
块，不写 `llm_content`。于是存在窗口：**请求已发给 provider，但进程在首个保存点之前崩溃**
→ DB 里只有裸 user 文本，本轮 live 实际发送的完整包装（`<user_query>` +
`<injected_context>` / `<runtime_facts>`）丢失，下一轮 history 只能回退旧重建，产生跨轮
字节漂移。

## 时机链（证据）

`execute_internal`（pipeline.rs）内的顺序：

1. **用户块行 INSERT**：`save_user_message_immediately` —— pipeline.rs:732（在
   `execute_internal` 之前的 `execute` 中调用）。编辑重发（`skip_user_message_save`）
   路径的行由编辑事务保证已存在。
2. **user 编译完成**：阶段 4.5 `compile_frozen_context` —— pipeline.rs:984-987；
   context_compiler.rs:533 设置 `ctx.compiled_current_user_message`，此后
   `live_user_llm_content()`（context.rs:1314）返回 Some。
3. **新调用点（本次改动）**：阶段 4.6 `persist_user_llm_content_early` ——
   **pipeline.rs:993**。
4. **首个 provider 网络请求**：阶段 5 `execute_with_tools` —— pipeline.rs:1007，
   内部于 tool_loop.rs:1188 `call_unified_model_2_stream` 发起。

即调用点严格处于「编译完成 + 行已 INSERT」之后、「首个网络请求」之前（阶段 4.6 与
阶段 5 之间只有取消检查，无网络调用）。注：阶段 4.5 编译自身可能触发辅助 MM/OCR
调用，但那发生在编译产物存在之前，逻辑上不可能更早写 sidecar；任务口径的
「首个 provider 请求」即阶段 5 的主模型请求。

## 实现

新函数 `ChatV2Pipeline::persist_user_llm_content_early`（persistence.rs，位于
`persist_replay_sidecar` 之后）：

- 取 `ctx.live_user_llm_content()`；为 None（理论上调用点之后不会发生）则 debug + 跳过；
- 用既有 helper `existing_user_content_block_id` 从 DB 找回该 user 消息的 CONTENT 块 id
  —— 同时覆盖普通路径（即时保存已 INSERT）与编辑重发路径（编辑事务的行）；查不到
  （即时保存失败、wake/retry 新 id 无行）则 debug + 跳过，交给 save_results 兜底；
- 单条 targeted UPDATE（`ChatV2Repo::update_block_replay_with_conn`，SQLite 单语句隐式
  事务）只写 `llm_content` 一列；V20260806 列未迁移时 repo 层静默跳过（既有行为）。

调用点（pipeline.rs:993）失败只 `log::warn!`，不阻断发送。

## 明确不做

- **不前移整份 save_results**：助手消息、块、meta、compaction 等仍在原保存点。
- **工具块 sidecar 不动**：`tool_call_id` / `round_text` 仍由原 `persist_replay_sidecar`
  在 save_intermediate_results / save_results 落库（工具结果在首个请求前尚不存在）。
- 原 `persist_replay_sidecar` 保持不变；后续保存点会用同一 `live_user_llm_content()`
  幂等重写同一列，无冲突。

## 与 #4 的关系

`llm_content_crash_tests.rs`（任务 #4）模拟「已发 provider、sidecar 未保存时崩溃」：
无前移 → 下一轮 history 只有裸 user；有前移 → `llm_content` 已在。本改动即其被测行为。
