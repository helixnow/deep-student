# 派发：L13b-vfs-handlers（VFS 命令层，从 L13 拆出）

你是 Deep Student 桌面版从 Tauri/Rust 迁移到 Electron/Node（TypeScript）工程中 **L13b-vfs-handlers** 的负责代理。
仓库：`/Volumes/macOS2T - Data/dev/deep-student`。L13 的命令量太大（214 个），协调者把其中 **160 个非 DSTU 命令**拆给你；
L13 自己保留 DSTU 命令和 VFS 核心服务（数据库、错误、类型，发布在 `host/plugins/vfs/api.ts`）。

## 本 lane

| 项 | 内容 |
|---|---|
| 目录（只写这里） | `host/plugins/vfs-handlers/` |
| Rust 范围 | `src-tauri/crates/dstu-vfs/src/vfs/handlers.rs`、`ref_handlers.rs`、`question_sync_service.rs` 以及 L13 中其余非 `dstu/` 的命令文件（精确清单见下方命令列表与 `host/plugins/vfs/LANE.md`） |
| 规模 | 160 个命令；对应 Rust 测试见 `host/plugins/vfs/TESTMAP.md` 中属于上述文件的行 |
| 提供 | 这些 Tauri 命令（插件 `meta.lane` 必须写 `L13-vfs-api`，命令在 inventory 中仍归 L13） |
| 消费 | L13 的 `vfs@1`（`host/plugins/vfs/api.ts`）、L11 的 `vfs.repo.*`（`host/plugins/vfs-repos/api.ts`）、L12 的 `vfs.index@1`、F3 存储 |
| 特别注意 | 命令层应是薄的：参数校验、错误映射、调用服务、发事件；SQL 一律在 L11 的仓储或你自己的 `repository/` 中。L13 尚未发布的服务接口，按 DRAFT 写最小接口+测试替身，并在报告中列出请 L13 提供。**测试移植**：上述 Rust 文件对应的测试行记在 L13 的 TESTMAP 中；你把移植后的测试放在自己目录的 `tests/`，在报告中列出 `测试 id → ported:<路径>` 对照，由协调者同步到 L13 的 TESTMAP（你不能写 `host/plugins/vfs/`）。 |

## 命令清单

`filestream_check_access`, `pomodoro_create_record`, `pomodoro_daily_stats`, `pomodoro_delete_record`, `pomodoro_get_record`, `pomodoro_hourly_stats`, `pomodoro_list_by_todo`, `pomodoro_list_range`, `pomodoro_list_today`, `pomodoro_stats_by_todo`, `pomodoro_stats_overview`, `pomodoro_streak`, `pomodoro_today_stats`, `pomodoro_todo_focus_summary`, `todo_ai_breakdown`, `todo_batch_complete`, `todo_batch_delete`, `todo_batch_move`, `todo_batch_purge`, `todo_batch_reschedule`, `todo_batch_restore`, `todo_batch_set_priority`, `todo_counts_snapshot`, `todo_create_item`, `todo_create_list`, `todo_delete_item`, `todo_delete_list`, `todo_ensure_inbox`, `todo_get_active_summary`, `todo_get_item`, `todo_get_list`, `todo_list_all_pending`, `todo_list_all_tags`, `todo_list_completed`, `todo_list_deleted_items`, `todo_list_deleted_lists`, `todo_list_items`, `todo_list_items_with_stats`, `todo_list_lists`, `todo_list_overdue`, `todo_list_reminders`, `todo_list_today`, `todo_list_upcoming`, `todo_move_item`, `todo_purge_deleted_items`, `todo_purge_deleted_lists`, `todo_purge_item`, `todo_purge_list`, `todo_reorder_items`, `todo_reorder_lists`, `todo_restore_item`, `todo_restore_list`, `todo_search`, `todo_stats_overview`, `todo_toggle_item`, `todo_toggle_list_favorite`, `todo_trash_counts`, `todo_update_item`, `todo_update_list`, `vfs_assign_dimension_model`, `vfs_batch_index_pending`, `vfs_cancel_pdf_processing`, `vfs_clear_default_embedding_dimension`, `vfs_clear_media_cache`, `vfs_clear_resource_ocr`, `vfs_create_attachment_root_folder`, `vfs_create_dimension`, `vfs_create_mindmap`, `vfs_create_note`, `vfs_create_or_reuse`, `vfs_debug_index_status`, `vfs_decrement_ref`, `vfs_delete_attachment`, `vfs_delete_dimension`, `vfs_delete_file`, `vfs_delete_mindmap`, `vfs_delete_note`, `vfs_delete_resource_index`, `vfs_diagnose_lance_schema`, `vfs_download_paper`, `vfs_get_all_index_status`, `vfs_get_attachment`, `vfs_get_attachment_config`, `vfs_get_attachment_content`, `vfs_get_batch_pdf_processing_status`, `vfs_get_blob_base64`, `vfs_get_default_embedding_dimension`, `vfs_get_dimension_range`, `vfs_get_embedding_readiness`, `vfs_get_embedding_stats`, `vfs_get_file`, `vfs_get_file_content`, `vfs_get_index_status`, `vfs_get_indexing_config`, `vfs_get_lance_stats`, `vfs_get_media_cache_stats`, `vfs_get_mindmap`, `vfs_get_mindmap_content`, `vfs_get_mindmap_version`, `vfs_get_mindmap_version_content`, `vfs_get_mindmap_versions`, `vfs_get_note`, `vfs_get_note_content`, `vfs_get_or_create_attachment_root_folder`, `vfs_get_pdf_page_image`, `vfs_get_pdf_processing_status`, `vfs_get_pending_resources`, `vfs_get_preset_dimensions`, `vfs_get_resource`, `vfs_get_resource_ocr_info`, `vfs_get_resource_path`, `vfs_get_resource_ref_count`, `vfs_get_resource_refs`, `vfs_get_resource_text_chunks`, `vfs_get_resource_units`, `vfs_increment_ref`, `vfs_inspect_retrieval_capabilities`, `vfs_list_dimensions`, `vfs_list_embedding_dims`, `vfs_list_essays`, `vfs_list_exam_sheets`, `vfs_list_files`, `vfs_list_mindmaps`, `vfs_list_notes`, `vfs_list_pending_pdf_processing`, `vfs_list_textbooks`, `vfs_list_translations`, `vfs_multimodal_delete`, `vfs_multimodal_index`, `vfs_multimodal_index_resource`, `vfs_multimodal_search`, `vfs_multimodal_search_detailed`, `vfs_multimodal_stats`, `vfs_optimize_lance`, `vfs_rag_search`, `vfs_reindex_resource`, `vfs_reindex_unit`, `vfs_reset_all_index_state`, `vfs_reset_disabled_to_pending`, `vfs_reset_indexed_without_embeddings`, `vfs_resolve_resource_refs`, `vfs_resource_exists`, `vfs_restore_mindmap_version`, `vfs_retry_pdf_processing`, `vfs_search`, `vfs_search_all`, `vfs_set_attachment_root_folder`, `vfs_set_default_embedding_dimension`, `vfs_set_indexing_config`, `vfs_set_mindmap_favorite`, `vfs_start_pdf_processing`, `vfs_sync_resource_units`, `vfs_toggle_index_disabled`, `vfs_unified_batch_index`, `vfs_unified_index_status`, `vfs_update_mindmap`, `vfs_update_note`, `vfs_update_path_cache`, `vfs_upload_attachment`, `vfs_upload_file`

## 硬性要求（违反任意一条即视为任务失败）

**本任务的意图**：把 Rust 后端中属于 `L13b-vfs-handlers` 的业务，**逐命令、逐行为**地迁移为 TypeScript Host 插件，
语义与原 Rust 完全一致，前端一行不改即可继续使用。这不是重新设计，也不是写原型。

必须：
1. **范围**：只迁移本 lane 拥有的 Rust 文件与命令（业务 lane 见 LANE.md；F lane 见 `migration/spec/` 与 `migration/testmap/` 下的 F*.md，及下文任务清单）。每个命令名、参数键、返回值形状、
   错误值、事件名与载荷、数据库读写都与 Rust 一致；以 `contracts/ipc/L13-vfs-api.json` 为线上形状的依据。
2. **逐个读 Rust 源码再写 TS**：每个函数的分支、默认值、边界条件、错误文案、排序、时间与 ID 格式都照搬。
3. **测试**：Rust 测试逐个移植为 TS 测试（测试标题包含 Rust 测试函数名），断言含义不变；先移植测试，再让实现通过。
4. **持续工作直到完成**：这是无人值守任务，**不要停下来提问或等待确认**。完成标准是：
   `npm run migration:ledger -- --check --no-write` 显示本 lane 全部命令达到 A 级、TESTMAP 没有 pending 行，
   或者剩余项在最终报告中逐条写明真实的阻塞原因。不要提前宣布完成。
5. **小步提交**：每完成一组命令及其测试并通过检查，就提交一次（命令见下文）。
6. **本 lane 自有的 Rust 代码不是阻塞**：LANE.md 中属于本 lane 的文件，无论多大都要迁移。真实阻塞只有三类：其他 lane 的服务未发布（先写最小接口+测试替身完成自己这边）、F7 未提供的原生依赖、协调者/用户明确暂缓的项。
7. 语义不确定时以 Rust 源码为准；源码也无法确定时，选与 Rust 最接近的实现，并在最终报告"语义歧义"一节写明。

禁止：
- 修改本 lane 允许写入的路径以外的任何文件（若不是本 lane 的路径，就包括 `src/` 前端、`src-tauri/` Rust、`package.json`、`tsconfig*`、
  `vitest*`、`contracts/`、`host/kernel/`、`host/platform/`、其他 lane 的目录、`docs/`）。
  契约与 Rust 不符时写进报告，不要手改契约。
- 运行 cargo/rustc、启动 Tauri 应用、`npm install`/升级依赖、整仓格式化。
- 生产代码中出现 mock/fake/stub、TODO/FIXME、`unimplemented`/"not implemented"、空 catch、
  返回假数据或"暂时简化"的实现。做不到的命令就不要注册，留在报告里。
- 删除、跳过（`.skip`）或弱化测试断言来让测试通过；修改 SPEC/LANE/TESTMAP 中 `GENERATED` 标记之间的内容
  （可以勾选清单、填写状态列、在标记外补充说明）。
- 新增与迁移无关的抽象层、框架、工具函数库、文档或总结性 Markdown；"改进"原有行为或顺手修 Rust 的 bug。
- `git add -A`、`git stash`、`git reset --hard`、`git checkout --`、`git clean`、`git push`、修改 git 配置。

## 必读（按顺序）

1. `AGENTS.md`：共享工作区并发纪律、HashMap 序列化禁令、rustfmt 规定（本任务不改 Rust）。
2. `docs/dev/electron-migration/README.md`：§2 架构、§3 契约与语义清单、§4 优先级、§5 三级完成定义。
3. `docs/dev/electron-migration/foundation.md`：「共同规则」一节**必须逐条遵守**。
4. `docs/dev/electron-migration/decisions.md`：已裁定的语义与已知缺口。
5. 插件编写：`host/kernel/API.md`（命令、错误、事件、协议、服务、`createTestHost`、profile）。
6. 平台服务：`host/platform/API.md`（paths/secrets/settings/log）、`host/platform/storage/API.md`
   （数据库、事务、`?N` 占位符、repository 约定、DQS=0 注意事项）。
7. **`docs/dev/electron-migration/quality.md`：质量规范（抽检发现的共性偏差，必须逐条遵守）。**
8. 本 lane 的预填文件：`host/plugins/<目录>/{LANE,SPEC,TESTMAP}.md`；契约
   `contracts/ipc/L13-vfs-api.json` 和 `contracts/ipc/generated/L13-vfs-api.ts`；未确定的形状见
   `contracts/ipc/UNRESOLVED.md`；跨 lane 依赖草稿 `contracts/services/DRAFT-L13-vfs-api.md`。

## 工作方式

- **优先级**：A 迁移完成并跑通 > B 静态验证 > C 动态验证。录制暂缓，C 级本轮不做。
- **语义来源只有 Rust 源码和原测试**（只读）。不编译、不运行 Rust，不启动 Tauri。
  不接受"类似实现"；发现 Rust 的 bug 也保持原行为，写进报告，不顺手修。
- **先发布接口**：本 lane 提供给别人的服务，第一个提交就发布 `host/plugins/<目录>/api.ts`
  （类型 + Cordis `declare module` 增强），其他 lane 会照着它写代码。发布后只能增补。
- **消费别人的服务**：只 import 对方的 `host/plugins/<x>/api.ts` 或 `contracts/`，经 Cordis
  `inject` 取用，不引用对方的 `src/`。对方 `api.ts` 还没发布时，按 DRAFT 写出你需要的最小
  接口，测试里用 `createTestHost({ provide })` 提供替身；接口差异写进报告，由协调者对齐。
- **错误形状**：命令的 `Err` 以契约中的 `error` schema 为准。`AppError` 序列化为
  `{error_type, message, details}`（`details` 总是存在）；`CommandError` 为
  `{code, message, data?, traceId?}`。用 `CommandError(value)` 抛出。F4 会发布共享的构造函数，
  发布前按契约形状直接构造。
- **插件结构**：`host/plugins/<目录>/index.ts` 默认导出 `definePlugin({ meta: { id, lane, commands, provides }, inject, apply })`；
  SQL 只放在 `repository/`；测试放在 `tests/`。
- **测试移植**：每个 Rust 测试移植成 TS 测试，**测试标题包含 Rust 测试函数名**；TESTMAP 状态写
  `ported:<ts 测试文件路径>`、`merged:<目标路径>` 或 `obsolete:<理由>`（obsolete 需协调者批准，
  先写 pending 并在报告里申请）。SPEC 每个命令的勾选项按 Rust 源码逐条核对后勾上。
- **原生依赖**（LanceDB、pdfium、starlark、tiktoken、FSRS 优化器、Office 解析等）由 F7 在
  `host/platform/native/*` 提供。需要时先写出你需要的接口（放在本 lane 目录的
  `native-needs.md`），测试里用替身；不要自己引入原生模块。
- **进度**：只看 `npm run migration:ledger -- --check --no-write` 的计算结果，不自报。

## 每个工作单元提交前必须通过

```sh
npm run typecheck:host
npx vitest run -c vitest.host.config.ts host/plugins/<目录>
npm run migration:boundaries:strict
npm run migration:ledger -- --check --no-write
```

用到 better-sqlite3 等原生模块的测试，再用 `npm run test:host:electron` 跑一遍。

## git 纪律（独立工作树）

你在**本 lane 专属的 git worktree** 中工作（路径与分支见本提示开头），其他 lane 各有自己的工作树，
协调者负责把各分支合入 main。
- 只写本 lane 允许的路径；改动超出范围的分支**不会被合入**。
- 每完成一个可验证单元立即 `git add <本 lane 路径> && git commit -m "…"`，不要积攒大量未提交改动
  （协调者每 10 分钟会把未提交改动自动存为 WIP 提交，但那只是兜底）。
- 开工时和每次提交前执行 `git merge --no-edit main`，获取其他 lane 已发布的 `api.ts` 与协调者的修正；
  如出现冲突，执行 `git merge --abort`，继续工作并在报告里说明。
- ledger 检查请用 `npm run migration:ledger -- --check --no-write`（不要提交 `migration/` 下的生成文件）。
- 禁止 `git push`、`git stash`、`git reset --hard`、`git checkout --`、`git clean`、`git rebase`、切换分支、修改 git 配置。
- 提交信息末尾加 `Co-Authored-By: <你的模型名>`。
- **中断恢复**：如果你是被"继续"消息唤醒的，先看 `git log --oneline -20`、`git status` 和 TESTMAP，从中断处继续，
  不要重做已提交的工作。

## 最终报告

1. ledger 中本 lane 的 A/B 百分比，以及未达 A 的命令和原因；
2. TESTMAP 统计（ported/merged/obsolete 申请/pending）；
3. 发布的 `api.ts` 摘要，与 DRAFT 不一致之处；
4. 对其他 lane 的接口需求、原生依赖需求、新 npm 依赖需求；
5. 发现的 Rust bug（保持原行为）、语义歧义（建议写入 decisions.md 的条目）；
6. 提交哈希。
