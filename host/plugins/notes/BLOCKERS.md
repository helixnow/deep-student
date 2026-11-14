# L10-notes 真实依赖缺口（v2）

仅记录跨 lane 接缝；本 lane 的 SPEC、解码器、时间语义、测试审计不是阻塞。

| ID | 提供方与缺失面 | main 证据 / 恢复条件 |
|---|---|---|
| B-F3-journal（连接接口已解除） | F3 prepare/finish 接受 `SqlExecutor` | main `526512c2c` 已有正式接口；L10 候选 `2b7786b43` 已改为同连接 SAVEPOINT purge+prepare、提交后 finish，移除 raw 适配。领域 SQL owner 注册仍由下方 B-F3-journal-owner 跟踪，不因连接面存在自动关闭。 |
| B-L04-window（具体实现已到达，适配仍未闭合） | Agent→L04 真实上下文/registry 适配 | 2026-11-05 合并 main 后，`chat/api.ts` 已公开 `ChatExecutionContext` / `createExecutionContext` / registry；`chat/src/execution-context.ts:70` 已实现 tryWindow，不能再称提供方未发布。notes 的执行器仍接收 F1 Agent ExecutionContext（`kernel/agent-api.ts:309-341` 无 tryWindow），真实装配适配待 B-agent-lifecycle；正式 BackendEvents target 已由 `0cb5a238e` 验证。 |
| B-Lance-delete | 向量 owner `delete_resource_index_full` 业务面 | 硬删除目前只清 SQLite。不能以 native vector 表操作猜写 Lance 业务索引。 |
| B-L11-note-writes / N5（接口已到达并消费） | L11 六个同连接 owner 写入面 | main 发布 `78b205e51`（源检查点 `705cbfcb2`）的 `vfsRepo.noteOwnerWrites` 六方法；候选 `dfe011e1f` 已删除对应七处 SQL（资源单行删除有两个调用点）并消费同一 SqlExecutor；三处 membership DELETE 保留已有 removeItemByItemId。新增 `tests/note-owner-consumption.test.ts` 验证真实两插件、原事务/顺序和错误重试，`20261105000758-ef681e` 4 passed / exit 0；待独立复验，不再作为等待接口发布的阻塞。sync history logs 和 Lance 独立保持开。 |
| B-sync-history-logs / N5 | sync owner 清理未发布且实体已不存在的 note history changelog 同连接业务面 | `revisions.ts:239` 原 DELETE __change_log 仍待整改。所需签名/SQL/事务位置见 `OWNER-SEAMS.md`；由 C1/C2 确认正式 api 与无 inject 环装配。L20 parked，只登记精确缺口，不追加派单。 |
| B-RAG-owner | `rag_configurations` 唯一 owner 的默认配置读/更新 | `notes/repository/rag-config.ts:52-59,93-99` 是旧直写；全插件 `api.ts` 尚无 `getRagConfiguration/updateRagConfiguration` 公开面。Rust `cmd/notes.rs:2290-2308` 为先保存 subject 设置，再更新默认配置（不是原子双写）；请协调者确定 owner 并发布业务面，不能静默省略第二步。 |
| B-agent-lifecycle | 正式 Agent→L04 生命周期适配 | notes execute 接收 F1 `agent-api.ts::ExecutionContext`，其 `:309-341` 没有 L04 `emitToolCallStart/End/Error/saveToolBlock`。main 已有 `chat/api.ts::ChatExecutionContext` 与 `createExecutionContext`，实现见 `chat/src/execution-context.ts:99-124`；两上下文尚不兼容。需要正式装配方提供 Agent 上下文到 Chat 生命周期/窗口的适配，不复制 chat 块表或私造事件载荷，不以可选回调无声跳过 Rust 生命周期。 |
| B-L11-repeat-rule | L11 公开 `parse_repeat_rule`（`todo_repo.rs:161-201`） | `notes/src/user-todo-tool.ts::parseRepeatRule` 是 owner 逻辑副本，L10-V2-06 已按 serde 结构体改严（整数 token、重复字段、序列形式）。L11 私有 `vfs-repos/repository/todos-helpers.ts:154` 仍是 `JSON.parse`+`Number.isInteger`，会接受 `interval:2.0`、重复 `freq`，写入校验也会放行这类值，并拒绝 `["daily"]`。请 L11 修正并在 `vfs-repos/api.ts` 公开，notes 随后删副本改用。 |
| B-F3-journal-owner（注册生命周期已限定签收） | F3 owner SQL 委托闭环 | main `80dcc5291` 已正式发布两注册 Disposer 和公共 worker 出口；notes 在 apply 用两个独立 ctx.effect 立即持有 Disposer。C1 2026-11-05 确认 main `index.ts:212-219` 已修、获 R5 限定签收；不将并存 Host/全局 Slot 的 duplicate 再称旧泄漏。Linux 基线生命周期用例也已通过。剩余 F3 `file-deletion-queue.ts` 的 SQL owner 实际委托独立开，不因注册签收宣称整条 D1 已闭合；workspace_index 仍归 L05。 |
| B-MFJS / X6-PR-0113 | L02 真实 schema 规范化入口；C1/C2 对 Rust test-only 精确测试行裁定 | `MFJS-EVIDENCE.md` 记录 main 的两个 Rust 符号命中以及 TS `normalizeMfjsForTest` 替身。保留原测试与新规则下不计 A 的事实，未批准前不假接线、不自行 obsolete；待正式 L02 API 后替换规范化副本。 |

## 未完成但非阻塞

- 81 命令 SPEC v2 分支表、其余持久化 serde/日志分支核对、135 测试逐断言审计、ZIP/同步文件 IO 的非阻塞执行均属本 lane 自有工作。L10-V2-02 配置 decoder、V2-03 单调时钟/纳秒 policy 已有既有修复；本轮 V2-08 修复 history seq/摘要，不能用这些局部证据签其他未审分支。
- 本目录无 `ACCEPTANCE.md`；待独立复核，不能由实现者新建并签收。
