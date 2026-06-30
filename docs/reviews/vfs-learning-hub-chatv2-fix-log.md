# VFS / 学习资源管理器 / chat_v2 审阅问题修复记录

> 修复日期：2026-06-10 起
> 对应问题清单：`docs/reviews/vfs-learning-hub-chatv2-review-findings.md`
> 状态：✅ 已完成 / 🚧 进行中 / ⏸ 暂缓（含原因）

---

## ✅ A1 questions_fts 外部内容表触发器模式错误（🔴）

- 新增迁移 `src-tauri/migrations/vfs/V20260610__fix_questions_fts_triggers.sql`：
  - 重建 INSERT/UPDATE/DELETE 三个触发器为 FTS5 外部内容表官方要求的 `'delete'` 命令模式（携带 OLD 列值），UPDATE/DELETE 仅在 `OLD.deleted_at IS NULL`（旧行确实在索引中）时执行删除命令，避免对未索引行发 delete 造成新的腐化；
  - `INSERT INTO questions_fts(questions_fts) VALUES('rebuild')` 一次性重建存量索引；
  - rebuild 会把软删除行也索引进去，随后用 'delete' 命令批量移除 `deleted_at IS NOT NULL` 的行，恢复"软删除不可搜索"语义。

## ✅ A2 blob 物理文件在事务内被删除（🔴，含系统性扩散点）

核心方案：**两阶段删除**——事务内只递减引用计数（保留 ref_count=0 行），物理文件删除推迟到事务提交后的清扫阶段。即使崩溃也只是延迟回收，不再可能"DB 回滚复活、文件已丢"。

- `blob_repo.rs::decrement_ref_with_conn`：ref_count 归零时不再内联调用 `cleanup_blob_with_conn`（不再在调用方事务内 `fs::remove_file`），保留行待清扫。
- 清扫点（事务提交后调用 `cleanup_unreferenced[_with_conn]`，其内部仍会写 `__blob_deletion_queue` 传播 tombstone）：
  - `file_repo.rs::purge_file` / `purge_deleted_files`
  - `attachment_repo.rs::purge_attachment` / `purge_deleted_attachments`
  - `textbook_repo.rs::purge_textbook` / `purge_deleted_textbooks`
  - `folder_repo.rs::purge_folder`
  - `lib.rs` 应用启动时后台清扫一次（崩溃恢复兜底）。

## ✅ 新发现并修复：purge 函数 BEGIN 嵌套事务错误（🔴）

- 审阅中发现 `folder_repo::purge_folder_tree_resources_with_conn` 在 SAVEPOINT 事务内嵌套调用了使用 `BEGIN IMMEDIATE` 的各类型 purge 函数，SQLite 会报 "cannot start a transaction within a transaction" → **包含文件/笔记/导图的文件夹永远无法从回收站彻底删除**。
- 修复：以下函数从 `BEGIN IMMEDIATE/COMMIT/ROLLBACK` 改为可嵌套的 `SAVEPOINT/RELEASE/ROLLBACK TO`：
  - `file_repo.rs::purge_file_with_conn`（vfs_file_purge_tx）
  - `attachment_repo.rs::purge_attachment_with_conn`（vfs_attachment_purge_tx）
  - `textbook_repo.rs::purge_textbook_with_conn`（vfs_textbook_purge_tx）
  - `note_repo.rs::purge_note_with_conn`（vfs_note_purge_tx）
  - `mindmap_repo.rs::purge_mindmap_with_conn`（vfs_mindmap_purge_tx）
  - exam/translation/essay 的 purge 原本就是 SAVEPOINT 或无事务（由调用方管理），无需改动。

## ✅ F3 软删除清向量不清 units / 恢复后不重建索引（🔴）

`src-tauri/src/dstu/trash_handlers.rs`：

- `cleanup_vector_index` 重构为调用 `VfsIndexService::delete_resource_index_full`（删 Lance 向量 + 删 `vfs_index_units`/`vfs_index_segments` + 刷新维度计数），不再只删向量留下孤儿 SQLite 索引记录；
- `dstu_trash_restore` 成功后新增调用 `mark_resource_pending_after_restore` → `VfsIndexStateRepo::mark_pending`，恢复的资源会被后台索引循环自动重建索引，不再"恢复后永久检索不到"；
- `dstu_permanently_delete`（含 essay_session 子 essays）与 `dstu_empty_trash` 的清理同样升级为完整清理，修复 `vfs_index_units` 对 `resources` 无外键导致 purge 后 units/segments 残留的问题。

## ✅ F5 增量同步孤立 Lance 向量从不清理（🟠）

核心方案：**孤立向量入队 + 后台排空**（与 blob 两阶段删除同思路）。

- 新增迁移 `src-tauri/migrations/vfs/V20260611__add_lance_orphan_queue.sql`：创建本地队列表 `__lance_orphan_queue(lance_row_id PK, resource_id, enqueued_at, retry_count)`，不参与云同步；
- `index_service.rs::sync_resource_units_with_conn`：删除消失 Units 时收集到的 `orphaned_lance_row_ids` 不再只打 warn 日志，而是与业务变更同连接/同事务 `INSERT OR IGNORE` 入队；
- `indexing.rs::VfsFullIndexingService` 新增 `drain_lance_orphan_queue(limit)`：批量取队列条目，对 text/multimodal 两个 modality 调用 `delete_by_embedding_ids` 真删向量；成功出队，失败递增 `retry_count`（≥10 放弃并告警）；
- `process_pending_batch` 每轮开头先排空队列（上限 200 条/轮），即后台索引循环自动消化；
- `data_governance/migration/vfs.rs`：注册 `V20260610`/`V20260611` 两个迁移定义，`VFS_ALL_TABLE_NAMES` 增加 `__lance_orphan_queue`，`VFS_TABLE_COUNT` 34→35，并修正了此前已过期的迁移计数/最新版本断言（32→35、20260525→20260611）。

## ✅ D15 resource_read 无输出上限（🟠）

`src-tauri/src/chat_v2/tools/builtin_resource_executor.rs::execute_read`：

- 新增硬上限 `MAX_READ_CONTENT_CHARS = 40_000` 字符：未显式分页（offset/limit）的读取若超限，按字符边界安全截断；
- 截断时 JSON 结果附加 `contentTruncated: true` 与 `truncationNotice` 提示（告知 LLM 总长度与分页用法），避免整本教材一次性注入 prompt 导致上下文爆炸。

## ✅ G2/A11 后台状态写入污染业务 updated_at（🟡）

处理/索引状态属于派生状态，不应触碰业务 `updated_at`（导致"按修改时间排序"反复浮动 + 云同步噪声）：

- `embedding_repo.rs`：`set_index_state_with_conn` / `mark_failed` / `claim_pending_resources` / `set_mm_index_state_with_conn` / `mark_mm_failed` 的 `UPDATE resources` 全部移除 `updated_at` 写入；
- `pdf_processing_service.rs`：`update_processing_status` / `emit_progress` 等的 `UPDATE files` 移除 `updated_at = datetime('now')`（同时消除 A7 的无 T/Z 时间格式混存）；仅 OCR 业务内容写入（`update_file_ocr`）保留 updated_at；
- `indexing.rs::sync_resource_units_with_conn` 中 processing_progress 持久化同样移除 updated_at。

## ✅ F1 dstu_move_many / dstu_search_in_folder 参数命名不匹配（🟠）

`src/dstu/api.ts`：

- `moveMany` 同时传 `dest_folder`（snake_case）与 `destFolder`（camelCase）；
- `searchInFolder` 同时传 `folder_id` 与 `folderId`；
- 兼容 Tauri v2 默认 camelCase 参数映射，消除"批量移动/文件夹内搜索静默失败"。

## ✅ C3 todo_items INSERT 触发器缺自引用检查（🟡）

- 新增迁移 `src-tauri/migrations/vfs/V20260612__todo_insert_self_ref_check.sql`：重建 `trg_todo_items_validate_insert`，补 `parent_id = NEW.id` 自引用检查（UPDATE 触发器已有，INSERT 漏了），防止客户端自定 id 插入时创建自指环；
- `data_governance/migration/vfs.rs`：注册迁移，断言更新为 36 个迁移 / 最新版本 20260612。

## ✅ B6 FileContentView 大文件预检（🟢，核实为已存在）

- 复查 `src/features/learning-hub/apps/views/FileContentView.tsx`：已有基于 `node.size` 的前置检查（超限直接显示提示不加载内容），`node.size` 缺失时退化为加载后字符数后置检查。主要风险点已有防护，不另改动。

## ✅ D4 useReferenceToChat 总是选最旧会话（🟡）

`src/features/learning-hub/useReferenceToChat.ts`：

- 改为优先 `sessionManager.getCurrentSessionId()`（当前激活会话），不存在或已失效时才回退 `getAllSessionIds()[0]`；
- 与 `useVfsContextInject` 的会话选择逻辑对齐，"引用到对话"不再注入到最旧的后台会话。

## ✅ I6 todo 勾选无乐观更新 + 搜索无防抖（🟡）

`src/features/todo/stores/useTodoStore.ts`：

- `toggleItem`：本地立即翻转 status（乐观更新），API 成功后用服务端结果覆盖、失败回滚；按当前视图 `showCompleted` 过滤决定条目去留；
- `setSearch`：300ms 防抖后才 `reloadCurrentView`，清空搜索词立即刷新；防止每击键一次全量查询。

## ✅ I9 番茄钟组件硬编码中文（🟢）

- `src/locales/zh-CN/todo.json` / `en-US/todo.json` 新增 `pomodoro.*` 键组（模式名、控制按钮、统计、沉浸模式快捷键提示等）；插值变量用 `{{value}}` 规避 i18next 复数化对 `count` 的特殊处理；
- `GlobalPomodoroWidget.tsx` / `ImmersiveFocusMode.tsx` / `PomodoroPanel.tsx` 全部接入 `useTranslation('todo')`，硬编码字符串替换为 `t()` 调用。

## ✅ I2 番茄钟无系统通知（🟡）

- 后端：`Cargo.toml` 添加 `tauri-plugin-notification = "2"`，`lib.rs` 注册插件，`capabilities/default.json` 添加 `notification:default` 权限；前端安装 `@tauri-apps/plugin-notification`；
- `usePomodoroStore.ts`：新增 `sendSystemNotification`（权限请求 + 发送），`completeCurrentSession` 在工作/休息会话完成时发送 i18n 化的系统通知，应用最小化也能收到提醒。

## ✅ I10 学习中心标签页不持久化（🟢）

`src/features/learning-hub/LearningHubPage.tsx`：

- 打开的标签页与激活标签 ID 持久化到 `localStorage`（含模块级缓存避免重复解析）；
- 启动时恢复，并用 `dstu.get` 校验各标签对应资源仍存在，资源已删的标签自动关闭。

## ✅ I11 番茄完成后 todo 计数不刷新（🟢）

`src/features/pomodoro/stores/usePomodoroStore.ts::recordSession`：

- 完成的工作会话若关联 `todoItemId`，记录成功后动态导入 `useTodoStore` 并调用 `reloadCurrentView()`，`completed_pomodoros` 计数即时反映在 todo 列表。

## ✅ I1 SM-2 复习系统完全孤立（🔴）

后端 `src-tauri/src/question_bank_service.rs::submit_answer`：

- 提交答案判定为错（`is_correct == Some(false)`）时，自动调用 `ReviewPlanService::get_or_create_plan(question_id, exam_id)` 创建/复用 SM-2 复习计划；失败仅告警不阻塞答题流程。

前端 `src/features/learning-hub/apps/views/ExamContentView.tsx`：

- `ViewMode` 扩展 `'sm2'`，标签栏新增"智能复习"入口按钮；
- 新增 `Sm2ReviewPanel`：有进行中会话时渲染 `ReviewSession`，否则渲染 `ReviewPlanView`（传入 examId），lazy + Suspense 加载；
- 间隔重复学习闭环（答错 → 建计划 → 到期复习 → SM-2 调度）首次接通 UI。

## ✅ G1 中断恢复只"重置"不"续跑"（🟡）

`src-tauri/src/vfs/pdf_processing_service.rs`：

- `recover_stuck_tasks` 返回值从 `usize` 改为恢复的文件 ID 列表 `Vec<String>`；
- 新增 `resume_recovered_tasks(file_ids)`：依次对恢复出的文件 `start_pipeline`（媒体类型自动检测起始阶段），通过 `running_count` 轮询限制并发 ≤2（流水线内 OCR 已有并发 4，多文件叠加会打爆 LLM 配额），等待期间被用户手动启动的任务自动跳过；
- `retry()` 放宽到接受 `pending` 阶段（带 `is_running` 防重入），chat 附件的重试按钮对停在 pending 的文件恢复有效；
- `lib.rs` 启动逻辑：recover 出的任务非空时 spawn 后台任务自动续跑，被重启打断的 OCR/压缩/向量索引不再永久停摆。

---

## 编译与测试验证（2026-06-11）

| 检查项 | 结果 |
| --- | --- |
| `cargo check` | ✅ 通过（仅存量 warning，无 error） |
| `npx tsc --noEmit` | ✅ 通过 |
| `data_governance::migration::vfs` 迁移集合断言（36 个迁移 / latest 20260612） | ✅ 10/10 通过 |
| `test_vfs_database_full_migration` 等 4 个全量迁移集成测试（覆盖本次新增 V20260610/11/12） | ✅ 4/4 通过 |
| 新增迁移通过 `script_checker` 静态检查 | ✅（未被标记） |

### 验证中发现的**遗留**测试失败（与本次修复无关，根因已定位）

1. `test_all_migration_scripts_pass_checker`：检查器标记 4 个**旧**迁移（`add_answer_submissions`/`add_mindmap_versions`/`add_todo_tables`/`add_pomodoro`）缺孤儿数据清理。其中前两个自初始提交即已注册且检查器从未变更 → 该测试**自初始版本起就失败**。修复需改已发布迁移脚本内容（加 `-- @skip-check` 或清理语句），涉及 checksum 兼容性，未在本次范围内动。
2. `test_run_all_recovers_after_chat_v2_lock_failure`：云同步工作引入"任一库迁移失败 → 从快照恢复**所有**核心库"的自动恢复逻辑后，chat_v2 锁失败会把已迁移完成的 VFS 一并回滚到 v0，测试断言（"VFS 应保持已迁移"）与新行为不符 → 测试期望过期，属云同步工作范畴。
3. `test_mistakes_schema_fingerprint_drift_fails_close`：同上，fail-close 语义被自动恢复逻辑改变，drift 后 report.success=true。
4. `vfs::`（database/repos）61 个单测全部 "no such table" 失败：`setup_test_db` 仅调 `VfsDatabase::new`，而该构造函数**从初始版本起就不执行迁移**（迁移由 MigrationCoordinator 负责），这些 repo 单测从编写起即无法通过 → 测试基建缺口，建议后续给测试 setup 接入 `VFS_MIGRATION_SET` 统一建表。
