# 代理 2（round 2）—— 统一数据层与资源中心

> 先读 `docs/6.13/README.md`，再通读 `docs/6.12/status/agent-2-status.md`（F1–F13 / O1–O9）。

## 已完成（收尾会话，勿重做）
- A2-X1：`memory/service.rs`、`memory/evolution.rs` 删除路径改用 `index_unit_repo::purge_index_artifacts_by_resource`（入孤儿队列后删 units，Lance 删除失败由后台 drain 兜底）。

## 本轮任务（按优先级）

### P1 — 死代码清理（D2，第一轮已登记待决策，用户现授权清理）
- [ ] **`textbooks_db.rs` 遗留模块**：`textbooks_list` 命令未在 `lib.rs` 注册、`TextbookRepo::list` 无调用方（其中未转义 LIKE 在死路径上）；真实教材功能走 VFS repos。连带 `cmd/textbooks.rs` 的 9 个 `textbooks_*` 命令（定义未注册、前端不调用，见代理 7 的 X8）。核实确无运行时引用后整体删除，并清理 `lib.rs`/`commands.rs` 中相关声明。每删一处 `cargo check`。

### P1 — 前端死包装（X7，与代理 1/7 协调）
- [ ] `services/resourceSyncService.ts` 的 `resource_check_sync_needed`/`resource_sync_exam`/`resource_sync_note`/`resource_sync_textbook_pages`：Rust 侧无实现，包装器当前无人调用。确认后删死包装。
- [ ] `vfs_update_resource_hash`：收尾会话已删前端 `vfsRefApi.updateResourceHashV2`；确认后端无遗留 stub/注册残留。

### P2 — 二轮补审（第一轮已较充分，重点查新增/回归）
- [ ] 复核收尾会话改的 `purge_index_artifacts_by_resource` 在记忆删除路径上与孤儿队列 drain 的端到端一致性（段登记 → 入队 → drain 删除 → 幂等）。
- [ ] 抽审第一轮之后是否有新增的 vfs/repos 搜索路径漏 `escape_like_pattern`（沿用 O1 的共享 helper）。

## 验证
`cargo check`；`cargo test vfs|lance|database`（若可跑）。删模块后重点确认无 `unresolved import` / 未注册命令引用。

## 备注
第一轮结论：数据层整体健康（两阶段 blob 删除、孤儿队列、SQLite pragmas、serde camelCase 对齐均到位）。本轮以**清理 + 补审**为主，不大改架构。
