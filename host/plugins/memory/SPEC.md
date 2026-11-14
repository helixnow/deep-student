# L17-memory-research 行为规格（`host/plugins/memory/`）

<!-- BEGIN GENERATED:spec:header -->
逐条对照 Rust 源码填写（README §3.3）。每节下的清单项全部勾选（`- [x]`）即视为该节完成，ledger 据此计算 B 级；
勾选前在冒号后写明结论与 Rust 依据（文件:行）。生成区块由 `npm run migration:scaffold -- --refresh` 维护。

命令 34 个 · 发出事件 3 种 · 契约：`contracts/ipc/L17-memory-research.json`
<!-- END GENERATED:spec:header -->

## 全局语义（README §3.3）

<!-- BEGIN GENERATED:spec:global -->
本 lane 全部命令共同适用的约定；与某个命令不同时在该命令一节单独说明。
<!-- END GENERATED:spec:global -->

- [ ] Option → null 还是缺省（`skip_serializing_if`）：
- [ ] u64/i64 超过 2^53 的表示：
- [ ] 字段顺序（serde_json preserve_order）：
- [ ] f32 精度：
- [ ] 错误形状（字符串 / 对象、文案、错误码）与 panic 的前端可见结果：
- [ ] 取消：CancellationToken / drop → AbortSignal，取消点一致：
- [ ] 并发：锁 / 单写者 / 队列在 Node 中的对应（await 交错）：
- [ ] 时间与 ID：生成方式、格式、时区：
- [ ] 不对含 HashMap 的结构做序列化后比对：

## WP-170：HPIAS default / explicit stub（仅此子集）

入口保持 `hpiasResearch.startFromIntent({window,sessionId,title,intent}): void`；L13
`vfs/index.ts:219-220` 注册的 GenerativeUiExecutor 在静态 start/chunk/end 后调用它。
Rust 依据为 `dstu-research/src/hpias/{service,events,orchestrator,payloads}.rs` 与
`src/chat_v2/tools/generative_ui_executor.rs:327-359,436-461`。

| 分支 / 副作用 | Rust | TS 落点与约束 |
|---|---|---|
| 非研究块直接返回 | executor:455 / service:76 | startFromIntent 的 shouldStartResearchSession；首事件也不得发 |
| 未设、空、disabled、off | service:24-39,94 | 每次读取进程环境 DEEP_STUDENT_HPIAS_BACKEND；rustTrim + ASCII lowercase；返回，无事件/调度 |
| unknown | service:40-45 | backendKindFromConfig 的 WARN，含归一化后的值；返回 disabled |
| retrieval 缺 VFS/LLM | service:96-104 / retrieval_backend:39-42 | canRunRetrieval 检查公开 ctx.vfsDatabase / ctx.llm，原 WARN 后返回；Lance 非必需 |
| retrieval 依赖齐全 | service:97-98 | 本 lane 真实 retrieval pipeline 尚未接入，明确抛出缺实现/接口错误；不能谎报 disabled 或使用 stub |
| title Option / question | executor:436-441 | title ?? extractQuestionFromIntent(intent)；空字符串仍 Some，不触发回退；payload 按 Rust trim、省略空 question |
| 同步 session_started | executor:348-354 / events:31-41 | buildSessionStartedPayload(sessionId,question,null)；同一目标与 sessionId；失败原 WARN 后继续 |
| 显式 stub 时间线 | service:75-84 / orchestrator:31-47,65-74 | 原 buildPipelineTimeline，skipFirst=true；每条350ms；后续 emit 失败 WARN 含 index/error 后 break |
| 生命周期 | orchestrator 后台 task / Host scoped effect | 保持既有 disposed 停止发事件；已等待的350ms timer自然结束，不再调度下一条 |

所有日志经 ctx.log；无 SQL/写库、无新增 settings 键、无新事件字段。测试经真实 Host、L07
registry、L13 注册实例及真实 memory provider；350ms 边界与完整事件顺序用虚拟时钟，另用
真实350ms调度观测 session_completed 与卸载后静默。只验证 default/stub；旧47及retrieval
测试去向保持 pending，不据此签收全部 HPIAS 或 A/golden/C。

## WP-158：insight 列表精确 i64 分页

- Rust 依据：`dstu-research/src/insight/service.rs:406-424`、`repo.rs:210-247`；
  默认值来自 `src-tauri/src/insight/handlers.rs:67-78`，由 L15 命令层保留 `100/0`。
- 公开 `api.ts` 重导出的 `InsightCommandService.listInsights(status, limit, offset)` 接受
  `IpcInteger = number | bigint`；service/repository/SqlExecutor 同一路径保持精确值。
  已解码的合法 i64 不先转 Number，不添加 safe-integer 限制。
- service 仅执行 Rust `limit.min(500)`；repository 原样绑定 limit/offset。
  负 limit 由 SQLite 表示无限制，负 offset 由 SQLite 当作 0，0 limit 返回空；无下限 clamp。
- status 为 null/非 null 分别走两条原 SQL，排除 deleted_at 非空行，只按 updated_at DESC 排序；
  列出 id 后按顺序读取完整卡片，缺失卡片跳过，读取失败立即传播。
- SQL/读卡错误经既有 facade 输出 `CommandError({error_type:'Database',message:<原文>,details:null})`，
  不转换为空页；Rust 此路径无日志/事件/写入/事务/取消点，不新增这些副作用。
- 验证入口：真实 memory / vfs-repos / notes provider 与迁移后的 SQLite；补充
  `tests/insight-pagination.test.ts` 验证默认、普通 number、500 上限、负值、i64 MIN/MAX、
  相邻大数 offset 的真实执行及绑定值、两分支 SQL 错误。TESTMAP 映射保持不变。

## 命令 `memory_add_relation`

<!-- BEGIN GENERATED:cmd:memory_add_relation -->
- Rust：`src-tauri/crates/dstu-memory/src/memory/handlers.rs:364` · async
- 前端：app（1 处，例 `src/api/memoryApi.ts:187`）
- 契约：`contracts/ipc/L17-memory-research.json`
  - 参数：noteIdA: string, noteIdB: string
  - 结果：null · 错误：string · 注入：app-handle, state, state, state
<!-- END GENERATED:cmd:memory_add_relation -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [x] DB 读写（`service.rs:3605-3705` add_relation_with_occ，WP-104 核对）：自关联报错 → 两端 `ensure_note_in_memory_root` → 同一连接读 A（缺失 NotFound）、读 B → 两端 `validate_expected_note_version`（空版本 InvalidArgument、不符 Conflict），均在任何写锁之前 → `SAVEPOINT memory_add_relation`（自动提交下等同 BEGIN DEFERRED；TS 为 deferred 事务 + F3 `tx.savepoint`）内依次写 A、B（已含 `_ref:` 的一端不写），任一失败 ROLLBACK TO + RELEASE，第一端写入一并撤回 → info `[Memory] Added relation: {a} <-> {b}`（重复关联同样输出）→ audit ADD_RELATION。
- [x] 取消/并发：另一连接持写锁时，过期版本直接报 Conflict，不等 busy_timeout（`tests/relation-savepoint.test.ts`）。
- [ ] 时间/ID：

## 命令 `memory_batch_delete`

<!-- BEGIN GENERATED:cmd:memory_batch_delete -->
- Rust：`src-tauri/crates/dstu-memory/src/memory/handlers.rs:478` · async
- 前端：app（1 处，例 `src/api/memoryApi.ts:242`）
- 契约：`contracts/ipc/L17-memory-research.json`
  - 参数：noteIds: string[]
  - 结果：BatchOperationResult · 错误：string · 注入：app-handle, state, state, state
<!-- END GENERATED:cmd:memory_batch_delete -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `memory_batch_move`

<!-- BEGIN GENERATED:cmd:memory_batch_move -->
- Rust：`src-tauri/crates/dstu-memory/src/memory/handlers.rs:522` · async
- 前端：app（1 处，例 `src/api/memoryApi.ts:249`）
- 契约：`contracts/ipc/L17-memory-research.json`
  - 参数：noteIds: string[], targetFolderPath: string
  - 结果：BatchOperationResult · 错误：string · 注入：app-handle, state, state, state
<!-- END GENERATED:cmd:memory_batch_move -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `memory_create_root_folder`

<!-- BEGIN GENERATED:cmd:memory_create_root_folder -->
- Rust：`src-tauri/crates/dstu-memory/src/memory/handlers.rs:208` · async
- 前端：app（1 处，例 `src/api/memoryApi.ts:140`）
- 契约：`contracts/ipc/L17-memory-research.json`
  - 参数：title: string
  - 结果：string · 错误：string · 注入：state, state, state
<!-- END GENERATED:cmd:memory_create_root_folder -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `memory_delete`

<!-- BEGIN GENERATED:cmd:memory_delete -->
- Rust：`src-tauri/crates/dstu-memory/src/memory/handlers.rs:614` · async
- 前端：app（1 处，例 `src/api/memoryApi.ts:274`）
- 契约：`contracts/ipc/L17-memory-research.json`
  - 参数：noteId: string
  - 结果：null · 错误：string · 注入：app-handle, state, state, state
<!-- END GENERATED:cmd:memory_delete -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [x] DB 读写（`service.rs:3416-3484` delete_with_source，WP-103 核对）：主删除 `delete_note_with_folder_item` 失败才上抛；之后依次为 Lance `delete_by_resource("text")`（失败 warn `[Memory] Failed to delete lance index for {rid} (will rely on disabled state): {e}`）→ 独立 `purge_index_artifacts_by_resource`（经 L11 `embeddingUnits`；失败 warn `[Memory] Failed to purge index artifacts for {rid}: {e}`）→ `mark_disabled_with_reason("note deleted")`（失败 warn）→ `remove_incoming_refs`（失败 warn）→ info `[Memory] Deleted note: {id}` → audit DELETE。
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `memory_export_all`

<!-- BEGIN GENERATED:cmd:memory_export_all -->
- Rust：`src-tauri/crates/dstu-memory/src/memory/handlers.rs:688` · async
- 前端：app（1 处，例 `src/api/memoryApi.ts:294`）
- 契约：`contracts/ipc/L17-memory-research.json`
  - 参数：（无）
  - 结果：MemoryExportItem[] · 错误：string · 注入：state, state, state
<!-- END GENERATED:cmd:memory_export_all -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `memory_get_audit_logs`

<!-- BEGIN GENERATED:cmd:memory_get_audit_logs -->
- Rust：`src-tauri/crates/dstu-memory/src/memory/handlers.rs:947` · async
- 前端：app（1 处，例 `src/api/memoryApi.ts:355`）
- 契约：`contracts/ipc/L17-memory-research.json`
  - 参数：limit?: integer(u32) | null, offset?: integer(u32) | null, sourceFilter?: string | null, operationFilter?: string | null, successFilter?: boolean | null
  - 结果：MemoryAuditLogItem[] · 错误：string · 注入：state
<!-- END GENERATED:cmd:memory_get_audit_logs -->

- [x] 输入：limit 缺省 50，夹到 1..200；offset 缺省 0；过滤器原样精确匹配（handlers.rs:947-966）。
- [x] 输出：按 id DESC 返回；Option 字段总是 null；confidence 为 f32（audit_log.rs:287-305,354-374）。
- [x] 错误：SQL 错误经 VfsError::Database Display 转 String（audit_log.rs:314-315；vfs/error.rs:173）。
- [x] 事件：无（handlers.rs:947-967）。
- [x] DB 读写：只读 memory_audit_log，source/operation/success 顺序拼接过滤（audit_log.rs:317-352）。
- [x] 取消/并发：同步查询，无取消点（audit_log.rs:354-376）。
- [x] 时间/ID：返回已有 timestamp/id，不生成（audit_log.rs:358-359）。

## 命令 `memory_get_config`

<!-- BEGIN GENERATED:cmd:memory_get_config -->
- Rust：`src-tauri/crates/dstu-memory/src/memory/handlers.rs:174` · async
- 前端：app（1 处，例 `src/api/memoryApi.ts:116`）
- 契约：`contracts/ipc/L17-memory-research.json`
  - 参数：（无）
  - 结果：MemoryConfigOutput · 错误：string · 注入：state, state, state
<!-- END GENERATED:cmd:memory_get_config -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `memory_get_or_create_root_folder`

<!-- BEGIN GENERATED:cmd:memory_get_or_create_root_folder -->
- Rust：`src-tauri/crates/dstu-memory/src/memory/handlers.rs:221` · async
- 前端：none
- 契约：`contracts/ipc/L17-memory-research.json`
  - 参数：（无）
  - 结果：string · 错误：string · 注入：state, state, state
<!-- END GENERATED:cmd:memory_get_or_create_root_folder -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `memory_get_profile`

<!-- BEGIN GENERATED:cmd:memory_get_profile -->
- Rust：`src-tauri/crates/dstu-memory/src/memory/handlers.rs:721` · async
- 前端：app（1 处，例 `src/api/memoryApi.ts:290`）
- 契约：`contracts/ipc/L17-memory-research.json`
  - 参数：（无）
  - 结果：MemoryProfileSection[] · 错误：string · 注入：state, state, state
<!-- END GENERATED:cmd:memory_get_profile -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `memory_get_related`

<!-- BEGIN GENERATED:cmd:memory_get_related -->
- Rust：`src-tauri/crates/dstu-memory/src/memory/handlers.rs:400` · async
- 前端：app（1 处，例 `src/api/memoryApi.ts:195`）
- 契约：`contracts/ipc/L17-memory-research.json`
  - 参数：noteId: string
  - 结果：string[] · 错误：string · 注入：state, state, state
<!-- END GENERATED:cmd:memory_get_related -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `memory_get_tags`

<!-- BEGIN GENERATED:cmd:memory_get_tags -->
- Rust：`src-tauri/crates/dstu-memory/src/memory/handlers.rs:466` · async
- 前端：app（1 处，例 `src/api/memoryApi.ts:213`）
- 契约：`contracts/ipc/L17-memory-research.json`
  - 参数：noteId: string
  - 结果：string[] · 错误：string · 注入：state, state, state
<!-- END GENERATED:cmd:memory_get_tags -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `memory_get_tree`

<!-- BEGIN GENERATED:cmd:memory_get_tree -->
- Rust：`src-tauri/crates/dstu-memory/src/memory/handlers.rs:353` · async
- 前端：app（1 处，例 `src/api/memoryApi.ts:183`）
- 契约：`contracts/ipc/L17-memory-research.json`
  - 参数：（无）
  - 结果：FolderTreeNode | null · 错误：string · 注入：state, state, state
<!-- END GENERATED:cmd:memory_get_tree -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `memory_list`

<!-- BEGIN GENERATED:cmd:memory_list -->
- Rust：`src-tauri/crates/dstu-memory/src/memory/handlers.rs:337` · async
- 前端：app（1 处，例 `src/api/memoryApi.ts:175`）
- 契约：`contracts/ipc/L17-memory-research.json`
  - 参数：folderPath?: string | null, limit?: integer(u32) | null, offset?: integer(u32) | null
  - 结果：MemoryListItem[] · 错误：string · 注入：state, state, state
<!-- END GENERATED:cmd:memory_list -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `memory_move_to_folder`

<!-- BEGIN GENERATED:cmd:memory_move_to_folder -->
- Rust：`src-tauri/crates/dstu-memory/src/memory/handlers.rs:566` · async
- 前端：app（1 处，例 `src/api/memoryApi.ts:256`）
- 契约：`contracts/ipc/L17-memory-research.json`
  - 参数：noteId: string, targetFolderPath: string
  - 结果：null · 错误：string · 注入：app-handle, state, state, state
<!-- END GENERATED:cmd:memory_move_to_folder -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `memory_read`

<!-- BEGIN GENERATED:cmd:memory_read -->
- Rust：`src-tauri/crates/dstu-memory/src/memory/handlers.rs:249` · async
- 前端：app（1 处，例 `src/api/memoryApi.ts:153`）
- 契约：`contracts/ipc/L17-memory-research.json`
  - 参数：noteId: string
  - 结果：MemoryReadOutput | null · 错误：string · 注入：state, state, state
<!-- END GENERATED:cmd:memory_read -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `memory_remove_relation`

<!-- BEGIN GENERATED:cmd:memory_remove_relation -->
- Rust：`src-tauri/crates/dstu-memory/src/memory/handlers.rs:382` · async
- 前端：app（1 处，例 `src/api/memoryApi.ts:191`）
- 契约：`contracts/ipc/L17-memory-research.json`
  - 参数：noteIdA: string, noteIdB: string
  - 结果：null · 错误：string · 注入：app-handle, state, state, state
<!-- END GENERATED:cmd:memory_remove_relation -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [x] DB 读写（`service.rs:3723-3833` remove_relation_with_occ，WP-104 核对）：自关联报 InvalidArgument `note_id_b` → 同 add：先读两端并校验版本，再 `SAVEPOINT memory_remove_relation` 内写 A、B（无 `_ref:` 的一端不写），失败整体撤回 → info `[Memory] Removed relation: {a} <-> {b}` → audit REMOVE_RELATION。
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `memory_restore_archived`

<!-- BEGIN GENERATED:cmd:memory_restore_archived -->
- Rust：`src-tauri/crates/dstu-memory/src/memory/handlers.rs:447` · async
- 前端：app（1 处，例 `src/api/memoryApi.ts:209`）
- 契约：`contracts/ipc/L17-memory-research.json`
  - 参数：noteId: string
  - 结果：boolean · 错误：string · 注入：app-handle, state, state, state
<!-- END GENERATED:cmd:memory_restore_archived -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `memory_restore_stale`

<!-- BEGIN GENERATED:cmd:memory_restore_stale -->
- Rust：`src-tauri/crates/dstu-memory/src/memory/handlers.rs:430` · async
- 前端：app（1 处，例 `src/api/memoryApi.ts:204`）
- 契约：`contracts/ipc/L17-memory-research.json`
  - 参数：noteId: string
  - 结果：boolean · 错误：string · 注入：app-handle, state, state, state
<!-- END GENERATED:cmd:memory_restore_stale -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `memory_search`

<!-- BEGIN GENERATED:cmd:memory_search -->
- Rust：`src-tauri/crates/dstu-memory/src/memory/handlers.rs:233` · async
- 前端：app（1 处，例 `src/api/memoryApi.ts:147`）
- 契约：`contracts/ipc/L17-memory-research.json`
  - 参数：query: string, topK?: integer(usize) | null
  - 结果：MemorySearchResult[] · 错误：string · 注入：state, state, state
<!-- END GENERATED:cmd:memory_search -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `memory_set_auto_create_subfolders`

<!-- BEGIN GENERATED:cmd:memory_set_auto_create_subfolders -->
- Rust：`src-tauri/crates/dstu-memory/src/memory/handlers.rs:629` · async
- 前端：app（1 处，例 `src/api/memoryApi.ts:128`）
- 契约：`contracts/ipc/L17-memory-research.json`
  - 参数：enabled: boolean
  - 结果：null · 错误：string · 注入：state, state, state
<!-- END GENERATED:cmd:memory_set_auto_create_subfolders -->

- [x] 输入：enabled bool（handlers.rs:629-639）。
- [x] 输出：unit → null（handlers.rs:635）。
- [x] 错误：VfsError Display 字符串（handlers.rs:639）。
- [x] 事件：无（handlers.rs:629-640）。
- [x] DB 读写：memory_config INSERT OR REPLACE，auto_create_subfolders = true/false 字符串（config.rs:175-182,450-455）。
- [x] 取消/并发：同步单语句写，无取消点（config.rs:175-182）。
- [x] 时间/ID：updated_at = SQLite datetime('now')；不生成 ID（config.rs:178）。

## 命令 `memory_set_auto_extract_frequency`

<!-- BEGIN GENERATED:cmd:memory_set_auto_extract_frequency -->
- Rust：`src-tauri/crates/dstu-memory/src/memory/handlers.rs:655` · async
- 前端：app（1 处，例 `src/api/memoryApi.ts:136`）
- 契约：`contracts/ipc/L17-memory-research.json`
  - 参数：frequency: string
  - 结果：null · 错误：string · 注入：state, state, state
<!-- END GENERATED:cmd:memory_set_auto_extract_frequency -->

- [x] 输入：trim + lowercase，只允许 off/balanced/aggressive（handlers.rs:662-672）。
- [x] 输出：unit → null（handlers.rs:661,675）。
- [x] 错误：非法值先于访问 DB 报 Invalid auto extract frequency '<值>', expected one of: off, balanced, aggressive；DB 错误 Display（handlers.rs:666-676）。
- [x] 事件：无（handlers.rs:655-677）。
- [x] DB 读写：memory_config auto_extract_frequency，INSERT OR REPLACE（config.rs:175-182,532-534）。
- [x] 取消/并发：同步单语句写，无取消点（config.rs:175-182）。
- [x] 时间/ID：updated_at = SQLite datetime('now')（config.rs:178）。

## 命令 `memory_set_default_category`

<!-- BEGIN GENERATED:cmd:memory_set_default_category -->
- Rust：`src-tauri/crates/dstu-memory/src/memory/handlers.rs:642` · async
- 前端：app（1 处，例 `src/api/memoryApi.ts:132`）
- 契约：`contracts/ipc/L17-memory-research.json`
  - 参数：category: string
  - 结果：null · 错误：string · 注入：state, state, state
<!-- END GENERATED:cmd:memory_set_default_category -->

- [x] 输入：category 原样保存，包括空串（handlers.rs:642-652；config.rs:457-459）。
- [x] 输出：unit → null（handlers.rs:648）。
- [x] 错误：VfsError Display 字符串（handlers.rs:652）。
- [x] 事件：无（handlers.rs:642-653）。
- [x] DB 读写：memory_config default_category，INSERT OR REPLACE（config.rs:175-182,457-459）。
- [x] 取消/并发：同步单语句写，无取消点（config.rs:175-182）。
- [x] 时间/ID：updated_at = SQLite datetime('now')（config.rs:178）。

## 命令 `memory_set_privacy_mode`

<!-- BEGIN GENERATED:cmd:memory_set_privacy_mode -->
- Rust：`src-tauri/crates/dstu-memory/src/memory/handlers.rs:197` · async
- 前端：app（1 处，例 `src/api/memoryApi.ts:124`）
- 契约：`contracts/ipc/L17-memory-research.json`
  - 参数：enabled: boolean
  - 结果：null · 错误：string · 注入：state, state, state
<!-- END GENERATED:cmd:memory_set_privacy_mode -->

- [x] 输入：enabled bool（handlers.rs:197-205）。
- [x] 输出：unit → null（handlers.rs:203）。
- [x] 错误：VfsError Display 字符串（handlers.rs:205）。
- [x] 事件：无（handlers.rs:197-206）。
- [x] DB 读写：memory_config privacy_mode = true/false 字符串，INSERT OR REPLACE（config.rs:175-182,437-442）。
- [x] 取消/并发：同步单语句写，无取消点（config.rs:175-182）。
- [x] 时间/ID：updated_at = SQLite datetime('now')（config.rs:178）。

## 命令 `memory_set_root_folder`

<!-- BEGIN GENERATED:cmd:memory_set_root_folder -->
- Rust：`src-tauri/crates/dstu-memory/src/memory/handlers.rs:184` · async
- 前端：app（1 处，例 `src/api/memoryApi.ts:120`）
- 契约：`contracts/ipc/L17-memory-research.json`
  - 参数：folderId: string
  - 结果：null · 错误：string · 注入：state, state, state
<!-- END GENERATED:cmd:memory_set_root_folder -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `memory_to_anki_document`

<!-- BEGIN GENERATED:cmd:memory_to_anki_document -->
- Rust：`src-tauri/crates/dstu-memory/src/memory/handlers.rs:973` · async
- 前端：app（1 处，例 `src/api/memoryApi.ts:227`）
- 契约：`contracts/ipc/L17-memory-research.json`
  - 参数：folderPath?: string | null, purposeFilter?: string | null, limit?: integer(u32) | null
  - 结果：MemoryAnkiDocument · 错误：string · 注入：state, state, state
<!-- END GENERATED:cmd:memory_to_anki_document -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `memory_update_by_id`

<!-- BEGIN GENERATED:cmd:memory_update_by_id -->
- Rust：`src-tauri/crates/dstu-memory/src/memory/handlers.rs:584` · async
- 前端：app（1 处，例 `src/api/memoryApi.ts:265`）
- 契约：`contracts/ipc/L17-memory-research.json`
  - 参数：noteId: string, title?: string | null, content?: string | null
  - 结果：MemoryWriteOutput · 错误：string · 注入：app-handle, state, state, state
<!-- END GENERATED:cmd:memory_update_by_id -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `memory_update_tags`

<!-- BEGIN GENERATED:cmd:memory_update_tags -->
- Rust：`src-tauri/crates/dstu-memory/src/memory/handlers.rs:412` · async
- 前端：app（1 处，例 `src/api/memoryApi.ts:199`）
- 契约：`contracts/ipc/L17-memory-research.json`
  - 参数：noteId: string, tags: string[]
  - 结果：null · 错误：string · 注入：app-handle, state, state, state
<!-- END GENERATED:cmd:memory_update_tags -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `memory_write`

<!-- BEGIN GENERATED:cmd:memory_write -->
- Rust：`src-tauri/crates/dstu-memory/src/memory/handlers.rs:276` · async
- 前端：app（1 处，例 `src/api/memoryApi.ts:162`）
- 契约：`contracts/ipc/L17-memory-research.json`
  - 参数：noteId?: string | null, folderPath?: string | null, title: string, content: string, mode?: string | null
  - 结果：MemoryWriteOutput · 错误：string · 注入：app-handle, state, state, state
<!-- END GENERATED:cmd:memory_write -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `memory_write_batch`

<!-- BEGIN GENERATED:cmd:memory_write_batch -->
- Rust：`src-tauri/crates/dstu-memory/src/memory/handlers.rs:815` · async
- 前端：app（1 处，例 `src/api/memoryApi.ts:323`）
- 契约：`contracts/ipc/L17-memory-research.json`
  - 参数：items: MemoryBatchWriteItemInput[], defaultFolderPath?: string | null, defaultMemoryType?: string | null, defaultMemoryPurpose?: string | null
  - 结果：MemoryBatchWriteOutput · 错误：string · 注入：app-handle, state, state, state
<!-- END GENERATED:cmd:memory_write_batch -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `memory_write_smart`

<!-- BEGIN GENERATED:cmd:memory_write_smart -->
- Rust：`src-tauri/crates/dstu-memory/src/memory/handlers.rs:761` · async
- 前端：app（1 处，例 `src/api/memoryApi.ts:307`）
- 契约：`contracts/ipc/L17-memory-research.json`
  - 参数：folderPath?: string | null, title: string, content: string, memoryType?: string | null, memoryPurpose?: string | null, idempotencyKey?: string | null
  - 结果：SmartWriteOutput · 错误：string · 注入：app-handle, state, state, state
<!-- END GENERATED:cmd:memory_write_smart -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `quick_assistant_apply_enabled`

<!-- BEGIN GENERATED:cmd:quick_assistant_apply_enabled -->
- Rust：`src-tauri/src/quick_assistant.rs:273` · sync
- 前端：app（1 处，例 `src/quick-assistant/window.ts:103`）
- 契约：`contracts/ipc/L17-memory-research.json`
  - 参数：enabled: boolean
  - 结果：null · 注入：app-handle
<!-- END GENERATED:cmd:quick_assistant_apply_enabled -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `quick_assistant_hide`

<!-- BEGIN GENERATED:cmd:quick_assistant_hide -->
- Rust：`src-tauri/src/quick_assistant.rs:264` · sync
- 前端：app（1 处，例 `src/quick-assistant/window.ts:39`）
- 契约：`contracts/ipc/L17-memory-research.json`
  - 参数：（无）
  - 结果：null · 注入：app-handle
<!-- END GENERATED:cmd:quick_assistant_hide -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `quick_assistant_show`

<!-- BEGIN GENERATED:cmd:quick_assistant_show -->
- Rust：`src-tauri/src/quick_assistant.rs:256` · sync
- 前端：app（1 处，例 `src/quick-assistant/window.ts:29`）
- 契约：`contracts/ipc/L17-memory-research.json`
  - 参数：（无）
  - 结果：null · 注入：app-handle
<!-- END GENERATED:cmd:quick_assistant_show -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 事件 `hpias_event`

<!-- BEGIN GENERATED:event:hpias_event -->
- 事件名 `hpias_event`，常量 `HPIAS_EVENT_CHANNEL`
- 发送点：`src-tauri/crates/dstu-research/src/hpias/events.rs:25`（emit）
<!-- END GENERATED:event:hpias_event -->

- [ ] 载荷：
- [ ] 触发时机与顺序：
- [ ] 节流/合并：
- [ ] 是否在事务提交后：
- [ ] 目标窗口（emit / emit_to / emit_filter）：

## 事件 `memory://changed`

<!-- BEGIN GENERATED:event:memory://changed -->
- 事件名 `memory://changed`
- 发送点：`src-tauri/crates/dstu-memory/src/memory/handlers.rs:89`（emit）
- 发送点：`src-tauri/src/chat_v2/tools/memory_executor.rs:440`（emit）
<!-- END GENERATED:event:memory://changed -->

- [ ] 载荷：
- [ ] 触发时机与顺序：
- [ ] 节流/合并：
- [ ] 是否在事务提交后：
- [ ] 目标窗口（emit / emit_to / emit_filter）：

## 事件 `quick-assistant://shown`

<!-- BEGIN GENERATED:event:quick-assistant://shown -->
- 事件名 `quick-assistant://shown`，常量 `SHOWN_EVENT`
- 发送点：`src-tauri/src/quick_assistant.rs:193`（emit）
<!-- END GENERATED:event:quick-assistant://shown -->

- [ ] 载荷：
- [ ] 触发时机与顺序：
- [ ] 节流/合并：
- [ ] 是否在事务提交后：
- [ ] 目标窗口（emit / emit_to / emit_filter）：

## 实现拆分（2026-11-04）

`src/service.ts` 从 1599 行拆为 facade（约 780 行）+ 职责 store，行为仍由原 Rust 语义驱动：

- `src/profile-store.ts`：`learner_profile.rs` 的加载/历史/CAS 合并，以及 `mastery_hook.rs` 的
  `upsert_weak_point_from_mastery` / `remove_weak_point_from_mastery`。
- `src/daily-log-store.ts`：`daily_log.rs` 的按日期查找、去重追加与 CAS 重试。
- `src/search-store.ts`：`search` / `search_with_rerank` / `search_unified_for_purpose` /
  `apply_time_decay` / `trigger_immediate_index`。
- `src/write-store.ts`：读写、按 id 更新、删除、标签/恢复/移动/批量操作，以及
  `write_smart` / `write_explicit` / `write_batch` 与幂等键。
- `src/memory-utils.ts`：标签、路径、校验、时间衰减权重等纯函数。
- `src/mastery-sink.ts`：L15 `MasteryProfileSink` 的 Cordis 适配器，忽略 review 的 `conn`，
  使用 memory 自己的 VFS 数据库（与 Rust `LearnerProfileMasterySink` 一致）。

验证：`typecheck:host` 通过；本插件 28 个测试文件 / 203 个用例通过；
`migration:wiring --lane memory` 未接入 0；strict boundaries 本 lane 0；
`migration:importable host/plugins/memory/index.ts` 通过。

## 待接线（跨 lane，按 ARCHITECTURE.md 附录 A）

下列为初版记录；2026-11-05 合并 main 后的精确状态以 `BLOCKERS.md` 开头为准。
特别是 L04 registry 已发布，不再是缺接口阻塞；metadata 与真实工具执行必须区分。

- 待接线：`notes.repository`（`createNoteInFolder` / `updateNote` / `deleteNoteWithFolderItem`）。
  提供方 `host/plugins/notes/index.ts` 仍 `ctx.provide('notes', …)`；本 lane 的 `inject`
  暂用旧 key `notes` 以保证 profile 可启动，业务代码按“新名 `notes` 优先、旧名兜底”解析。
  待提供方按附录 A 更名为 `notes` 后，把 `inject` 同步改为新名。
- 待接线：`vfsRepo.folders` / `vfsRepo.resources` / `vfsRepo.indexStates` / `vfsRepo.todos`。
  提供方 `host/plugins/vfs-repos/index.ts` 仍提供旧 key `vfs.repo.core@1`；本 lane 的 `inject`
  暂用旧 key，业务代码按“新名 `vfsRepo` 优先、旧名兜底”解析。待其更名后同步修改 `inject`。
- 已接线：`retrieval.search/searchMultimodal/retrieve/inspectCapabilities` 与 `vfsIndex.indexing.*`。
  main 合入后 `host/plugins/vfs-index` 已按附录 A 发布 `retrieval` / `vfsIndex`，本 lane 直接
  `ctx.get('retrieval')` / `ctx.get('vfsIndex')` 调用真实服务。
- 待接线：`memory` 的运行时消费方。Rust 中 `MemoryService` 由 L03 的 memory/auto-extract 流与
  memory 工具执行器消费；当前 L04 尚未发布 ToolExecutor 注册表，生产路径没有 `ctx.memory` 调用方。
- 已接线：`insight`。本插件 `provide('insight', createInsightCommandService(...))`，卡片存储由
  `InsightService` + `repository/insight-cards.ts` 实现；L15 `review/src/insight-commands.ts`
  的 13 条 `insight_*` 命令通过 `ctx.get('insight')` 调用，`insight_run_jobs` 走
  `MemoryService.runInsightJobs`（`InsightJobWorker`）。
- 已接线：`masteryProfileSink`。本插件 `provide('masteryProfileSink', createMasteryProfileSink(service))`，
  review 掌握度事务提交后调用，回流到 `MemoryProfileStore.upsertWeakPointFromMastery` /
  `removeWeakPointFromMastery`（对应 Rust `mastery_hook.rs`）。
- 待接线：`llm` 的 completion/rewrite API。`host/plugins/llm/api.ts` 的 `LLMManager` 目前只有配置、
  模型选择与取消流，没有 chat completion 方法；自动提取、compaction flush、画像晋升/合并、
  LLM 决策、查询改写、语义去重因此只能保持 pending（详见 `TESTMAP.md` 的“未接入说明”）。
- 待接线：`chat` 的 ToolExecutor 注册服务。`host/plugins/chat/api.ts` 只导出 `ToolExecutor` 接口，
  没有按工具名注册 provider 的注册表；`paper_save` / `academic_search` / `knowledge` /
  `insight_recall` / `learning_overview` / memory 工具执行器无法接入生产路径。

## 时间与平台模块（F4 合入后）

- `chrono::Utc::now().to_rfc3339()`（`to_rfc3339` 的 AutoSi：0/3 位小数、`+00:00`）统一使用
  `host/platform/time` 的 `chronoRfc3339()`：insight 卡片/关系/事件、insight_jobs 队列、
  学习者画像 `updated_at`（审计表的时间戳由 SQLite DEFAULT 生成，服务层不写）。
- `note_repo::next_updated_at` 使用 `format("%Y-%m-%dT%H:%M:%S%.3fZ")`（固定 3 位小数、`Z`），
  用 `host/platform/time` 的 `chronoStamp(civilTime(...), ':', true)` + `Z` 实现；解析当前值用
  `parseRfc3339`，失败时回退 `now`，并保证严格 +1ms 递增。
- Rust `str::trim` 语义（不含 U+FEFF）统一使用 `host/platform/util` 的 `rustTrim()`。
- 本 lane 不涉及 `net-policy` 的 IP/SSRF 判定，也没有 HTTP 状态短语或 zip/CRC32 用途。

## F1 工具元数据公共面（2026-11-05）

- Rust 对照：memory_executor.rs:58-80,2177-2214；academic_search_executor.rs:997-1008；
  learning_overview_executor.rs:433-437,497-507。工具执行体不在此发布面的完成范围。
- `api.ts::createMemoryToolMetadata` 返回 memory / academicSearch / learningOverview 三个对象，
  提供原 executor name、canHandle、sensitivityLevel、concurrencyClass。无输入解码、SQL、日志、
  时钟、ID 或事件；只复用既有策略函数，academic 的 read_only 对应 Rust 无分支常量返回。
- `index.ts` 用同一工厂 provide `memoryToolMetadata`，可选 agentTools 就绪时注册**相同实例**。
  不注入 chat，避免把 registry 消费方反向设为必需依赖。metadata 无 execute，不能被声称为完整执行器。
- Learning 路由统一使用已存在的 `stripToolNamespace`，补齐原 Rust 对 `mcp_` 的处理，
  不另复制分类表。测试仅增补公开入口、生产注册 identity 与原 Rust 策略断言，原 TESTMAP 不升档。
