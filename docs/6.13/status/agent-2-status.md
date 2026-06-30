# 代理 2 状态文档（round 2）—— 统一数据层与资源中心

> 第一轮上下文见 `docs/6.12/status/agent-2-status.md`（F1–F13 / O1–O9 / X1 / E1 / D1–D2，收尾会话 A2-X1 已落地）。
> 本轮严格按 `docs/6.13/agent-2.md` 优先级推进：P1 D2 textbooks 死代码、P1 X7 前端死包装、P2 两项补审。
> feed_id = **F-6EGHT**（接力会话请勿重新注册，直接 feed-poll / interactive_feedback）。

## 当前状态

**本轮全部完成并通过验证（2026-06-13）**：
- P1 D2：textbooks 死代码已**精确删除并落地**（cargo check exit 0 / 0 error / 94 warn ≤ 基线 100，无新增）。
- P1 X7：前端 `resourceSyncService.ts` 死包装已删除（typecheck + lint 通过）；`vfs_update_resource_hash` 确认后端无残留。
- P2 补审两项：`purge_index_artifacts_by_resource` 端到端一致性、vfs/repos 搜索路径 escape_like_pattern 漏检——均复核通过，无新发现。

> ⚠️ 与 agent-2.md 措辞的偏差（已据「核实确无运行时引用后整体删除」要求修正）：D2 描述的「整体删除 textbooks_db.rs / cmd/textbooks.rs」不成立——核实后发现两文件**部分仍存活**（4 个命令已注册且前端在调用）。故执行为**精确部分删除**：删 9 个死命令 + textbooks_db 遗留死代码，**保留** 4 个活命令及其依赖类型。详见下。

## 本轮落地改动

### P1 — D2：textbooks 死代码精确删除（已落地）

**核实结论（全仓 grep + lib.rs 注册表 + 前端 invoke 核对，与代理 7 F12 口径一致）：**

`cmd/textbooks.rs` 原有 13 个 `#[tauri::command]`，分两类：

| 类别 | 命令 | 证据 |
|------|------|------|
| **活命令（保留，4 个）** | `textbooks_add` / `textbooks_update_bookmarks` / `textbooks_relink` / `vfs_get_file_blob_path` | lib.rs:1618-1621 已注册；前端 chatApi.ts / textbookDstuAdapter.ts / TextbookContentView.tsx / vfsFileApi.ts 在调用 |
| **死命令（删除，9 个）** | `textbooks_list` / `textbooks_remove` / `textbooks_adopt` / `textbooks_recover` / `textbooks_purge_trash` / `textbooks_delete_permanent` / `textbooks_update_reading_progress` / `textbooks_set_favorite` / `textbooks_update_page_count` | 均**未在 lib.rs 注册**（Tauri 未注册命令前端不可调用）+ 前端零 invoke。代理 7 F12 已将这 9 个明确划归代理 2 处理 |

**改动：**
- `cmd/textbooks.rs`：删除上述 9 个死命令 + 仅服务于它们的 `PurgeTrashOptions` struct（这 9 个为连续区块，活命令 `textbooks_add`(450 行) 完全未动）；清理失活 import（`use chrono::Utc;`、`ListQuery as TextbooksListQuery`、`serde::Deserialize`）。
- `textbooks_db.rs`：删除随 9 命令一起失活的遗留独立 `textbooks.db` 实现——
  - 遗留 SQLite 方法簇：`db_path` / `open_or_init` / `init_schema` / `insert_or_get` / `get_by_sha` / `get_by_id` / `list`（含 agent-2.md 点名的**未转义 LIKE** 死路径）/ `mark_trashed` / `recover` / `list_trashed` / `purge_trashed` / `delete_permanent` / `update_reading_progress` / `set_favorite` / `update_page_count` / `map_row`；
  - 失去调用方的 VFS 代理：`list_vfs` / `delete_vfs` / `create_vfs` / `get_vfs_by_sha256`；
  - 死类型：`ListQuery` / `VfsCreateTextbookParams` / `Textbook::to_vfs_textbook`；
  - 失活 import：`chrono::Utc`、`rusqlite::{params, Connection, OptionalExtension}`、`std::fs`、`std::path::{Path, PathBuf}`。
  - **保留（仍被活命令引用）**：`Textbook` DTO + `VfsTextbook::to_textbook`（textbooks_add/relink 返回值）；`VfsUpdateTextbookParams` + `TextbooksDb::{get_vfs, update_vfs}`（textbooks_update_bookmarks）。文件 520 → 142 行。
- `lib.rs` / `commands.rs`：**无需改动**——9 个死命令从未在 lib.rs 注册；commands.rs 仅 `pub use crate::cmd::textbooks::*`（通配，自动收敛）。`pub mod textbooks_db;` 保留（仍有活代码）。

**验证**：`CARGO_TARGET_DIR=...target-agent2` 下 `cargo check` exit 0、0 error、94 warning（基线 100，无新增；日志中无任何 textbooks 相关告警）。

### P1 — X7：前端 resourceSyncService.ts 死包装删除（已落地）

**核实结论**：该文件唯一被外部 import 的是 `createResource` + `type SyncResult`（仅 `features/notes/NotesContext.tsx`）。其余全部死代码：
- `resource_sync_note` / `resource_sync_exam` / `resource_sync_textbook_pages` / `resource_check_sync_needed` 四个 invoke 包装——**后端从未实现**这些命令（全仓 grep 零 Rust 定义/注册），前端零调用；
- 连带 `MockResourceSyncService` / `TauriResourceSyncService` / `ResourceSyncService` 接口 / `tauriResourceSyncService` & `resourceSyncService` 单例 / 便捷函数 `syncNote/syncExam/syncTextbookPages/checkSyncNeeded` / 测试辅助 `clearMockSyncCache`/`getMockSyncCacheSize` / `isTauriEnvironment` / 死类型 `PageRange`/`CheckSyncNeededResponse`/`SourceType`/`BackendSyncResult`——全仓零外部引用。

**改动**：`resourceSyncService.ts` 535 → 95 行，仅保留 `SyncResult` / `CreateResourceParams` / `createResource`（走已注册的 `vfs_create_or_reuse`，lib.rs:1366）。`npm run typecheck` exit 0、`eslint` 改动文件 0 error。

### P1 — X7 续：vfs_update_resource_hash（确认无残留，无需改动）

全仓 grep `vfs_update_resource_hash` / `updateResourceHashV2` / `update_resource_hash`：仅出现在 docs（agent-2.md / README / agent-7-status）。收尾会话已删前端 `vfsRefApi.updateResourceHashV2`，**后端本就无实现、无注册**。无残留 stub，无需改动。

## P2 二轮补审结论（无改动）

### 补审 1 — purge_index_artifacts_by_resource 端到端一致性（一致）

链路：**段登记**（indexing 写 `vfs_index_segments.lance_row_id`）→ **入队**（`index_unit_repo::purge_index_artifacts_by_resource`：`INSERT OR IGNORE INTO __lance_orphan_queue SELECT s.lance_row_id ... JOIN units WHERE resource_id=?` 后 `DELETE FROM vfs_index_units`，FK CASCADE 清 segments，同 conn）→ **drain**（`indexing.rs::drain_lance_orphan_queue`：取 retry<10，对 TEXT/MM 双模态 `delete_by_embedding_ids`，双成功才出队、否则 retry++、超 10 放弃）。
- **幂等**：入队 `INSERT OR IGNORE`（lance_row_id 主键去重）；`delete_by_embedding_ids` 用 `embedding_id IN (...)`，未命中行为 0 行删除即 Ok（lance_store.rs:755-772），表打不开则跳过——所以「text id 喂给 mm 表」是安全 no-op，重复 drain 也幂等。
- **A2-X1 记忆路径复核**：`memory/service.rs:2411` + `memory/evolution.rs:435` 均正确调用 `purge_index_artifacts_by_resource(&conn, res_id)`；service 先直删 Lance（失败仅 warn）再入队，drain 兜底。结论：一致、幂等、双模态容错到位。
- 观察（非缺陷、不改）：purge 的「入队 + 删 units」两条语句在记忆裸 conn 路径上非显式事务；属既有最终一致设计（启动 `sweep_orphan_index_units` + drain retry 兜底），且 A2-X1 在 README §2「勿回退」锁定集内。

### 补审 2 — vfs/repos 搜索路径 escape_like_pattern 漏检（无新漏）

全量扫描 vfs/repos + database/ 的 LIKE：
- **用户搜索路径全部已转义**：question/exam/essay/translation/resource/textbook/todo/note repo 均 `escape_like_pattern(...) + ESCAPE '\'`；database/mod.rs anki 搜索（F11）已 ESCAPE。
- **未转义 LIKE 均为内部输入/已知安全**：`todo_repo:1847` `completed_at LIKE '{today}%'`（系统日期前缀）；`path_cache_repo:483` `invalidate_by_path_prefix`（= 第一轮 F5，缓存失效超删无害，已记录决定不改）；`mindmap_repo:1275/1278` 硬编码 `NOT LIKE 'chat%'`（无用户输入）；`database settings key LIKE`（内部 key 前缀）。
- 结论：第一轮 O1/O2/O7 之后**无新增漏转义的用户搜索路径**。

## 本轮改动文件清单（8 个）
- `src-tauri/src/cmd/textbooks.rs`（D2：删 9 死命令 + PurgeTrashOptions + 失活 import）
- `src-tauri/src/textbooks_db.rs`（D2：删遗留死模块，520→142 行）
- `src/services/resourceSyncService.ts`（X7：删死同步包装，535→95 行）
- `src-tauri/src/database_optimizations.rs`（R2-1：整文件删除）
- `src-tauri/src/commands.rs`（R2-1：删 2 个 perf 命令 + `use DatabaseOptimizationExt`）
- `src-tauri/src/lib.rs`（R2-1：删 2 行命令注册 + `pub mod database_optimizations;`）
- `src-tauri/src/vfs/repos/blob_repo.rs`（R2-2：批量清扫加 `ref_count=0` 守卫原子删行）
- `src-tauri/src/vfs/handlers.rs`（R2-3：导入失败补偿 decrement_ref 后再 cleanup）

> 共享文件登记（README 3.2）：`commands.rs`/`lib.rs` 本轮仅删除与本域 `database_optimizations` 直接相关的段落（2 命令注册/包装 + 模块声明），未触碰其他命令；一致性负责人代理 7 知悉。

## 深审新发现并已落地（R2-2 / R2-3，用户批准「全部实现」）

| # | 位置 | 严重度 | 处理 |
|---|------|--------|------|
| R2-2 | `vfs/repos/blob_repo.rs::cleanup_unreferenced_with_conn` | 中（数据丢失，低概率） | **已落地方案A**。原批量清扫 `SELECT hash WHERE ref_count=0` 后逐个 `DELETE FROM blobs WHERE hash`（无 `AND ref_count=0` 守卫，删文件在前）。与 `store_blob_with_conn`（先写文件再 `INSERT ON CONFLICT ref_count+1` 复活 blob）并发时，会误删已被重新引用的 blob → 悬挂引用/数据丢失（单 blob 版 `cleanup_blob_with_conn` 有 386 行重检，批量版漏）。`cleanup_unreferenced` 从运行时多条 purge 路径调用（非仅启动），竞态可达。**修复**：循环改为「先 `DELETE ... WHERE hash=?1 AND ref_count=0` 原子守卫删行，受影响行=0 即跳过物理删除，再删文件」，与单 blob 版一致；消除误删已复活 blob 的数据丢失主路径。代价：物理删文件失败时行已删→残留孤儿文件（磁盘泄漏，远轻于数据丢失且极罕见）。文件/DB 跨介质非原子残窗（store_blob 先写文件后写行）无法纯 SQL 消除，但 store_blob 对缺失文件自愈重写，方案A 覆盖绝大多数实际场景。`cargo check exit 0 / 0 error / 91 warn`。 |
| R2-3 | `vfs/handlers.rs` 文件导入失败补偿（~2215） | 低（孤儿 blob 泄漏，原 2071 注释已知 TODO） | **已落地**。`store_blob_with_conn` 置 ref_count=1（去重命中 N→N+1），`create_file_with_doc_data_in_folder` 不增 ref。create_file 失败时旧补偿直接 `cleanup_blob_with_conn`（ref=1>0 → no-op）漏删 → 孤儿 blob 残留。**修复**：补偿改为先 `decrement_ref_with_conn`（抵消本次 store 的 +1；去重命中回到 N 仍被他人引用）再 `cleanup_blob_with_conn`（仅回到 0 才真删）。所有 ref 场景均正确。 |

> 单 blob 版 `cleanup_blob_with_conn` 未改：其唯一调用方（handlers.rs 补偿路径）经 R2-3 修复后传入的 blob 在 decrement 后才 cleanup；且该函数有 386 行 `ref_count>0` 预检，窗口比原批量版窄，保持其「删文件失败即 `?` 传错、不留孤儿」语义不动以免回归。

## 域内动态 SQL 注入面全量复核（exhaustive，无新风险）
全 `src-tauri/src`（非测试）grep `execute/prepare/query*(&format!(...))`：
- **本域**：仅 `exam_repo.rs` SAVEPOINT/RELEASE/ROLLBACK（`savepoint_name` 经 `sanitize_savepoint_suffix`，F2）与 `database/manager.rs` SAVEPOINT（`migration_v{version}`，整数派生，无用户输入）——均安全。
- **LanceDB 过滤表达式**：`vfs/lance_store.rs` 与 `lance_vector_store.rs` 所有 `only_if/filter` 表达式（resource_id/embedding_id/folder_id/resource_type/sub_library_id/chunk_id/message_id/role IN/=）一律 `.replace('\'', "''")` 单引号转义；`_rowid > {cursor}` 为整数。
- **LanceDB 模块内的 SQLite 旁路查询**（rag_documents/rag_document_chunks/chat_messages 的 `WHERE id IN (...)`）：全部 `vec!["?"; n]` 占位符 + `params_from_iter` 参数化。
- **跨域观察（代理 7，仅登记不动）**：`data_governance/sync/mod.rs:7078 PRAGMA table_info({table_ident})`、`migration/coordinator.rs:2827 DROP TABLE IF EXISTS {table_name}`、sync SAVEPOINT `{name}`——表名/SAVEPOINT 名疑为内部常量，建议代理 7 确认其来源不可被外部污染。

## 续审（用户批准「继续」后的二轮深审，2026-06-13，均无新增改动）

应用户「继续」指示，对第一轮未深审/数据丢失关键区做补充审查，结论均健康：

- **data_space.rs（第一轮仅浅过）**：A/B 槽位两阶段提交正确（`mark_pending_switch` 写前验证目标非空 → `initialize_on_start` 再验证目标有数据才应用 → 清 pending）；`atomic_write_state_file` 用 tmp+`sync_all`+rename（+ unix 父目录 fsync），Windows `fs::rename` 经 `MoveFileExW` 覆盖语义成立；损坏恢复三级兜底（state.json → .tmp → 目录推断）健全；单测覆盖充分。**4 个未注册命令**（`get_slot_size`/`check_switch_disk_space`/`verify_slot_integrity`/`verify_all_slots_integrity`）属代理 7 F12「data_space 4 个」任务，与代理 7 备份域交界，**不越界处理**，仅登记。
- **startup_cleanup.rs / F13（数据清空，丢数据关键路径）**：lib.rs:379-393 在**任何数据库初始化之前**执行；`should_purge_on_start(base)` → `purge_active_data_dir(active)` 保留 `backups`/`temp_restore`/`migration_core_backups`；标记位于 base（在被清的 active 槽之外，purge 不会误删），**仅 `had_errors==false` 才 `clear_purge_marker`**，失败/Err 保留标记下次重试。逻辑正确，收尾会话 F13 实现复核通过。
- **migrations（70 个）**：refinery 版本化执行（框架保证 run-once 幂等），第一轮已审可重入性；最新 V20260613-615（todo/pomodoro）系其他代理近期在维的活跃文件，**不介入**。
- **数据层死代码补扫**：本域**专属**死代码仅 textbooks（本轮已处理）；`resource_get_content_from_vfs`、`vfs_*` 一批已被代理 7 的 `_tmp_check_cmds.cjs` 核查——其中 `resource_get_content_from_vfs` 入代理 7 F12 清单（其余 vfs_* 命令前端在用、非死）。这些**不属本域专属**，交代理 7/1，仅登记不动。

## 新一轮广泛深审（用户要求「对所属域新一轮充分广泛深入审阅」，2026-06-13）

覆盖面：data layer 全域抽查 + 高风险模式扫描（panic/锁中毒/SQL 拼接/整数截断/事务边界）。

### 新发现并已落地（R2-1，用户批准「全都干完」后执行）
| # | 位置 | 类型 | 处理 |
|---|------|------|------|
| R2-1 | `database_optimizations.rs`（整删）+ `commands.rs`（删 2 命令 + use）+ `lib.rs`（删 2 注册 + `pub mod`） | 死代码（僵尸命令） | `create_performance_indexes` / `analyze_query_performance` 两命令**已注册但前端零调用**（全仓 `src` grep 无 invoke），属代理 7 F12「僵尸命令」同类但**不在其 24 项清单内**（疑漏）。按 README 3.2「共享文件只改本域直接相关段落并登记」+ 用户「全都干完」授权：整删 `database_optimizations.rs`（其唯一消费者就是这两命令）、移除 commands.rs 的 2 个 `#[tauri::command]` 包装与 `use DatabaseOptimizationExt`、移除 lib.rs 的 2 行注册与 `pub mod database_optimizations;`。**已验证 cargo check exit 0 / 0 error / 93 warn（≤基线 100，较前 -1）**。前端不受影响（无调用）。备注：原 `create_performance_indexes` 建的 chat_messages 索引本就从未真正创建（命令从未被调用）；若确需该索引，应由代理 1（chat_v2 域）写进 migration。 |

### 复审确认健康（无需改动）
- **file_manager.rs（1376 行）**：路径遍历防御完整（canonicalize + `starts_with(base)` + `..` 组件检查，覆盖 resolve_image_path / read_file_as_base64 / get_image_as_base64 / delete_image / delete_note_asset / delete_images）；孤儿图片清理在 JSON 解析失败时**中止以防数据丢失**；`format_bytes` 索引有 `min` 钳制。仅 `println!`/调试日志属 P3 风格。
- **unified_file_manager.rs**：content:// 等特殊 scheme 保留原始编码（Android ContentResolver 权限正确）；`detect_zip_subtype` 手解 ZIP 本地头有越界与防无限循环守卫；BE-06 unicode 清洗；magic-byte 三层降级。无问题。
- **package_manager.rs**：自动安装命令为硬编码常量（非用户输入），MCP command 仅用于选择检测函数（不执行），无命令注入。
- **exam_repo.rs SAVEPOINT**：3 处（942/1117/1515）均经 `sanitize_savepoint_suffix`（仅留 `[A-Za-z0-9_]`），F2 完整。
- **escape_like_pattern 全量扫描**：vfs/repos + database/ 所有**用户搜索**路径均 `escape_like_pattern + ESCAPE '\'`；未转义 LIKE 仅内部/已知安全（F5 缓存失效、settings key 前缀、todo `completed_at` 日期前缀、mindmap 硬编码 `'chat%'`）。
- **lance 向量层 panic 面**：`vfs/lance_store.rs` 零 `.unwrap()`；`lance_vector_store.rs` 仅 1 处静态正则（空正则兜底，恒可编译）。
- **embedding_repo 索引状态机**：F6 清零 retry 修复 text(420)/mm(660) 两侧对称；`claim_for_indexing` 对「indexed 但缺 units」自愈重排（530）；mark_failed 递增 retry、claim 守 `retry<max`。无卡死回归。
- **database/ SQL**：无 `format!` 拼接 execute/query（参数化）。
- **folder_repo 移动防环**（再审）：`move_folder_with_conn` 用 `get_folder_ids_recursive_with_conn`（CTE 含 seed → 自移 parent==self 也被拦）拒绝移入自身子树；递归 CTE 有 `depth < MAX_FOLDER_DEPTH` 上界（即便 DB 已存在环也不会死循环，UNION ALL 仅产生有界重复）；并校验移动后深度。健康。
- **blob 引用计数对称性**（再审）：`purge_file_with_conn` 递减 文件 blob + 压缩 blob（仅当≠原始）+ PDF 各页 blob + 页压缩 blob（仅当≠原始），与建档侧 `shared_hashes` 去重逻辑（334-348）完全对称——无漏减（泄漏）、无重复减（提前删除）。配合 R2-2/R2-3 修复，blob 子系统稳健。

### P3 风格（汇总，不单独改）
`database_optimizations.rs:17`、`document_processing_service.rs`（第一轮已记）等仍有 `println!` 调试输出，建议统一改 `tracing`，本轮不动（低价值、易与其他代理冲突）。

## 接力须知
- **本轮任务已完成**，未执行任何 git commit/push。
- 验证：后端 `cargo check`（target-agent2 隔离目录）exit 0 / 0 error / 94 warn；前端 `npm run typecheck` exit 0 + `eslint` 改动文件 0 error；`cargo test` 仍受 E1（DLL 入口点）阻塞，验证以 cargo check + 评审为主。
- 环境：多代理并行跑 cargo 会 LNK1104 锁共享 target；本组用 `$env:CARGO_TARGET_DIR="E:\2026ds\deep-student\src-tauri\target-agent2"` 隔离（~20GB，任务结束可整目录删除）。勿 `cargo clean` 共享 target。
- 本组临时 cargo 日志 `src-tauri/check_agent2_r2*.log` 已清理。`src-tauri/_tmp_check_cmds.cjs`（代理 7 留的僵尸命令核查脚本）非本组产物，留给代理 7 清理。
- 若用户提新需求，从本文档与第一轮 status 的「审阅发现 / 待决策项」继续。
