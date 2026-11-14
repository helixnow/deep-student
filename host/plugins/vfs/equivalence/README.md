# L13 vfs-api：WAVE0 v0 场景语料

## WP-223：G3 命令语料 v1（55 条清单 + 5 条补错误分支）

清单：`.oc-runs/board/corpus/WP-223-L13-vfs-api.md`（55 条，37 条在 G3 分母 768 内）。另补 brief 指定的 5 条已有成功场景命令的错误分支：
`dstu_folder_create`、`dstu_folder_get_tree`、`dstu_folder_list`、`pomodoro_create_record`、`vfs_upload_file`。

语料：9 个 `*.g3.json`，**263 个场景、3412 步**，60 条目标命令全部有成功意图步。全部 `seed:"empty"`、`capture:{events:true,db:["*"]}`、`normalize:[]`；`expect:"error"` 只是读 Rust 后的意图注释，A 的实际结果是判定基准。
未运行 A1/A2 录制、A/B 比对或 Rust 覆盖率，不判定 C 级；"已验"为 0。

**D-158（C1 02:10Z）**：本域此后只写成功场景，错误分支由 W-lane（`g3w-*.json`）负责。本包在 D-158 前写的错误场景按指令保留未删。

检查：`node host/plugins/vfs/equivalence/check-g3.mjs <清单.md>`（复用 X7 `validateScenario`；跨本目录全部 JSON 的 id 唯一；
引用必须整值、指向更早且非 error 意图的步；每步 cmd 在 `contracts/ipc/*.json` 中存在；不含引用的 args 用契约 schema 校验，
不合契约的步必须标 `expect:"error"`（计为 serde 错误，不算业务分支）；每个目标至少一个成功意图步；清单 55 条无缺失）。

### 逐命令汇总

"业务错误步" = error 意图步减去不合契约 schema 的 serde 步（含引用的错误步按业务计）。业务错误步为 0 的命令，理由见对应组的"未覆盖分支"列：
这些命令的处理函数里没有前端输入能触发的 Err（缺失 id 返回 null/[]/0，或失败写进返回值），剩余 Err 只来自 DB/IO、`spawn_blocking` join 或竞态，需故障注入。

| 命令 | 在768 | 组/文件 | 场景数 | 成功意图步 | 业务错误步 | serde 错误步 |
|---|---|---|---:|---:|---:|---:|
| `dstu_batch_move` | 是 | A1 `dstu-move.g3.json` | 6 | 8 | 0 | 3 |
| `dstu_build_path` | 是 | A2 `dstu-path.g3.json` | 3 | 14 | 0 | 4 |
| `dstu_copy` | 是 | A1 `dstu-move.g3.json` | 19 | 20 | 28 | 0 |
| `dstu_empty_trash` | 是 | D `trash.g3.json` | 6 | 17 | 0 | 3 |
| `dstu_export` | 是 | A3 `dstu-misc.g3.json` | 13 | 30 | 53 | 3 |
| `dstu_export_formats` | 是 | A3 `dstu-misc.g3.json` | 5 | 27 | 9 | 2 |
| `dstu_folder_add_item` | 是 | C `folder-items.g3.json` | 15 | 47 | 16 | 8 |
| `dstu_folder_create` | 补错误 | C `folder-items.g3.json` | 44 | 598 | 66 | 7 |
| `dstu_folder_get_all_resources` | 是 | C `folder-items.g3.json` | 10 | 22 | 4 | 9 |
| `dstu_folder_get_items` | 是 | C `folder-items.g3.json` | 16 | 73 | 0 | 4 |
| `dstu_folder_get_tree` | 补错误 | C `folder-items.g3.json` | 13 | 17 | 0 | 0 |
| `dstu_folder_list` | 补错误 | C `folder-items.g3.json` | 21 | 31 | 0 | 0 |
| `dstu_folder_move_item` | 是 | C `folder-items.g3.json` | 4 | 12 | 9 | 7 |
| `dstu_folder_remove_item` | 是 | C `folder-items.g3.json` | 4 | 14 | 0 | 6 |
| `dstu_folder_reorder` | 是 | C `folder-items.g3.json` | 5 | 10 | 1 | 6 |
| `dstu_folder_reorder_items` | 是 | C `folder-items.g3.json` | 5 | 14 | 1 | 7 |
| `dstu_get_path_by_id` | 是 | A2 `dstu-path.g3.json` | 5 | 30 | 0 | 2 |
| `dstu_get_resource_by_path` | 是 | A2 `dstu-path.g3.json` | 5 | 35 | 0 | 2 |
| `dstu_get_resource_location` | 是 | A2 `dstu-path.g3.json` | 7 | 38 | 0 | 2 |
| `dstu_list_trash` | 是 | D `trash.g3.json` | 30 | 79 | 0 | 6 |
| `dstu_move` | 是 | A1 `dstu-move.g3.json` | 14 | 13 | 20 | 1 |
| `dstu_move_many` | 是 | A1 `dstu-move.g3.json` | 10 | 12 | 4 | 2 |
| `dstu_move_to_folder` | 是 | A1 `dstu-move.g3.json` | 12 | 18 | 6 | 2 |
| `dstu_parse_path` | 是 | A2 `dstu-path.g3.json` | 7 | 52 | 0 | 3 |
| `dstu_permanently_delete` | 是 | D `trash.g3.json` | 7 | 17 | 30 | 4 |
| `dstu_purge_all` | 是 | A3 `dstu-misc.g3.json` | 4 | 8 | 11 | 3 |
| `dstu_refresh_path_cache` | 是 | A2 `dstu-path.g3.json` | 5 | 19 | 0 | 1 |
| `dstu_search_in_folder` | 是 | A3 `dstu-misc.g3.json` | 6 | 27 | 4 | 6 |
| `dstu_set_metadata` | 是 | B `dstu-set-metadata.g3.json` | 27 | 61 | 94 | 4 |
| `dstu_soft_delete` | 是 | D `trash.g3.json` | 23 | 101 | 19 | 6 |
| `dstu_trash_restore` | 是 | D `trash.g3.json` | 8 | 21 | 25 | 4 |
| `dstu_unwatch` | 是 | A2 `dstu-path.g3.json` | 1 | 6 | 0 | 2 |
| `dstu_watch` | 是 | A2 `dstu-path.g3.json` | 2 | 8 | 0 | 2 |
| `pomodoro_create_record` | 补错误 | F `pomodoro.g3.json` | 18 | 54 | 16 | 12 |
| `pomodoro_daily_stats` | 是 | F `pomodoro.g3.json` | 2 | 11 | 0 | 4 |
| `pomodoro_delete_record` | 是 | F `pomodoro.g3.json` | 11 | 15 | 3 | 2 |
| `pomodoro_get_record` | 是 | F `pomodoro.g3.json` | 4 | 10 | 0 | 2 |
| `pomodoro_list_by_todo` | 是 | F `pomodoro.g3.json` | 6 | 10 | 0 | 2 |
| `pomodoro_list_range` | 是 | F `pomodoro.g3.json` | 7 | 11 | 11 | 3 |
| `pomodoro_list_today` | 是 | F `pomodoro.g3.json` | 3 | 3 | 0 | 0 |
| `pomodoro_stats_overview` | 否 | F `pomodoro.g3.json` | 2 | 9 | 0 | 3 |
| `pomodoro_today_stats` | 是 | F `pomodoro.g3.json` | 3 | 4 | 0 | 0 |
| `pomodoro_todo_focus_summary` | 否 | F `pomodoro.g3.json` | 4 | 10 | 0 | 2 |
| `todo_ai_breakdown` | 否 | E2 `todo-batch.g3.json` | 4 | 1 | 6 | 1 |
| `todo_batch_complete` | 否 | E2 `todo-batch.g3.json` | 2 | 5 | 1 | 1 |
| `todo_batch_delete` | 否 | E2 `todo-batch.g3.json` | 3 | 5 | 1 | 1 |
| `todo_batch_move` | 否 | E2 `todo-batch.g3.json` | 2 | 3 | 4 | 0 |
| `todo_batch_purge` | 否 | E2 `todo-batch.g3.json` | 1 | 3 | 1 | 0 |
| `todo_batch_reschedule` | 否 | E2 `todo-batch.g3.json` | 2 | 7 | 6 | 0 |
| `todo_batch_restore` | 否 | E2 `todo-batch.g3.json` | 2 | 4 | 1 | 0 |
| `todo_batch_set_priority` | 否 | E2 `todo-batch.g3.json` | 2 | 3 | 5 | 0 |
| `todo_counts_snapshot` | 否 | E1 `todo-crud.g3.json` | 4 | 8 | 0 | 0 |
| `todo_create_item` | 否 | E1 `todo-crud.g3.json` | 15 | 38 | 32 | 6 |
| `todo_create_list` | 否 | E1 `todo-crud.g3.json` | 16 | 21 | 0 | 5 |
| `todo_delete_item` | 否 | E1 `todo-crud.g3.json` | 7 | 8 | 2 | 1 |
| `todo_delete_list` | 否 | E1 `todo-crud.g3.json` | 7 | 7 | 4 | 2 |
| `todo_ensure_inbox` | 否 | E1 `todo-crud.g3.json` | 7 | 10 | 0 | 1 |
| `todo_get_active_summary` | 否 | E1 `todo-crud.g3.json` | 3 | 10 | 0 | 0 |
| `todo_get_item` | 否 | E1 `todo-crud.g3.json` | 5 | 13 | 0 | 2 |
| `vfs_upload_file` | 补错误 | D `trash.g3.json` | 19 | 48 | 12 | 10 |

场景数/步数按"该命令出现在多少场景/多少步"计，包括别的命令场景里拿它造数据或读回的步，所以列之和大于总数。

### 未达到"真实成功 + 全部可达错误分支"的项

| 项 | 原因 | owner / 解除条件 |
|---|---|---|
| `todo_ai_breakdown` 成功/AI_EMPTY_RESULT 场景 | 需要模拟 LLM；场景用参数化环回 `http://127.0.0.1:18461/v1`（非运行中服务），脚本见 E2 §2.1 | X5 模拟服务；L02 配置命令 `save_api_configurations`/`save_model_assignments` |
| textbook 实体（`tb_`）的 move/copy/export/purge_all/set_metadata 成功分支 | 需 `textbooks_add` + 磁盘上真实 PDF，或旧版 textbook 类型 folder_items 种子 | L18-media-docs / X3 种子 |
| essay 单轮导出、`essay_*` 行 set_metadata 成功 | 需先跑通 `essay_grading_stream`（LLM） | L15 + X5 |
| 今日/近 N 天类统计（pomodoro today/list_today/daily_stats，todo active_summary 的今日段、counts_snapshot upcoming） | 依赖当前时钟；A/B 需同一时钟/时区，不能跨本地午夜 | X7 运行器（冻结时钟） |
| 题目导出服务未注册（exam_adapter.rs:277/279） | 只有 L14 导出 hook 缺失时触发 | L14-qbank |
| 高成本可达分支：`vfs_upload_file` >67MB 上限、`dstu_trash_restore` 1000 次重名冲突、copy 时文件夹数 500 上限 | 载荷过大/步骤过多，未写 | 后续按需补；D-158 后归 W-lane |
| `dstu_list_trash` limit+offset u32 溢出（trash_handlers.rs:276） | 可能 panic，未写场景，记为易错点 | W-lane 决定 |
| 全部 DB/IO、连接、`spawn_blocking` join、COMMIT 失败、锁中毒 | 前端不可达，需故障注入 | X7/X3 故障场景 |

`reorder.large_batch` 步5 / `reorder_items.large_batch` 步7 的错误意图（>100 个 id 时 CASE WHEN 拼接、id 含 NUL）是读码推断，未运行。

### 契约与前端不一致（只报告，不改契约）

`contracts/ipc/L13-vfs-api.json` 中 `todo_*` 16 条及 `pomodoro_stats_overview`、`pomodoro_todo_focus_summary` 的 `frontend` 为 `none`，
但 `src/features/todo/api.ts`（如 :229 create_item、:298 ai_breakdown、:329 counts_snapshot、:505/:525）与 `src/features/learning-today/weeklyReport.ts:88` 有真实调用；场景以前端为准。

### 读 Rust 发现的疑似缺陷（保持原行为，只供比对时关注）

- `dstu_move_to_folder`/`dstu_batch_move`：`dstu_create` 新建或刚 `dstu_move` 过的资源 `cached_path` 为 NULL，读取时报错（handlers.rs:6167/6437）；成功场景先 `dstu_refresh_path_cache`。
- `dstu_move` 源不存在/源是文件夹时先插入 folder_items 再报错；`dstu_move_many` 不检查源存在，missing 计入成功数。
- `img_` 在两套类型推断里分别为 files / unknown，同一 id 写入不同 item_type 触发唯一索引冲突。
- `dstu_copy` 目标文件夹不存在：note/translation/essay/file 仅 warn 并留在根，exam/mindmap 报错。
- `dstu_set_metadata`：mindmap 在路径缓存刷新/移回根后清缓存查询单复数类型名不匹配，此后报 invalid type；file 书签与阅读进度同请求时进度先提交导致书签 OCC 冲突；translation `isFavorite` 先提交再因 `qualityRating` 越界报错。
- `dstu_get_resource_by_path` 对已存在的 mindmap、file 返回 null；`dstu_parse_path` 不校验虚拟路径名。

### 分组明细（逐命令 前端/Rust/成功场景/错误分支/未覆盖理由）

### A1：dstu_move / dstu_copy / dstu_move_many / dstu_move_to_folder / dstu_batch_move

场景文件：`host/plugins/vfs/equivalence/dstu-move.g3.json`。Rust 行号相对 `src-tauri/crates/dstu-vfs/src/`。

#### 1. 逐命令覆盖

| 命令 | 前端 invoke 文件:行 | Rust 文件:行 | 成功场景 id | 错误场景/步覆盖的分支（Rust 行号→场景 id） | 未覆盖分支及理由 |
|---|---|---|---|---|---|
| `dstu_move` | `src/dstu/api.ts:472` | `dstu/handlers.rs:1770` | `vfs.dstu.move.note_to_folder`、`.note_cross_folder_then_root`、`.same_folder_noop`、`.translation_exam_essay_to_folder`、`.mindmap_file_image_to_folder` | 1788 src 解析失败（`/abc`、`""`、`/`、`/@trash`、超过 128 字符的多段 id；`dstu/handler_utils/path_utils.rs:128/141`、`dstu/path_parser.rs:103`）→`.errors_src_path`；1803 非法节点类型（`/res_abc`→resources）→`.errors_src_path`；1818 dst 解析失败→`.errors_dst`；1822 目标不是文件夹→`.errors_dst`；1836 FolderNotFound（`vfs/repos/folder_repo.rs:3013`，包括 missing、UUID、软删除的文件夹）→`.errors_dst`、`.deleted_target_folder`；1836 唯一索引冲突（`folder_repo.rs:3035`）→`.unique_conflict_insert`；1846 移动后取不到资源（源 missing 或已软删除）→`.missing_src_inserts_orphan`、`.deleted_src_note`；1855 `get_resource_by_type_and_id` 不支持 folders（`dstu/handler_utils/crud.rs:140`）→`.folder_src_unsupported`；serde→`.args_invalid` | 1795/1801 的 `textbooks`/`images`/`attachments` 分支不可达：`infer_resource_type_from_id`（`path_utils.rs:90`）只返回 `files`，不会返回这几个值。`path_utils.rs:146` 的 unknown 分支不可达：`is_valid_resource_id` 已经保证前缀有效。`get_conn_safe` 和 SQL 错误（`folder_repo.rs:2992/3020`、`crud.rs` 的 Err 分支）需要故障注入 |
| `dstu_copy` | `src/dstu/api.ts:558` | `dstu/handlers.rs:2243` | `vfs.dstu.copy.note_to_root`、`.note_to_folder`、`.translation_to_folder`、`.exam_to_root_and_folder`、`.essay_to_folder`、`.mindmap_to_root_and_folder`、`.file_and_image_to_folder`、`.folder_recursive_to_root`、`.folder_into_other_folder`、`.note_like_missing_dst_folder_silent` | 2261 src 解析失败→`.errors_paths`；2276 dst 解析失败→`.errors_paths`；2280 目标不是文件夹→`.errors_paths`；2296/2437/2526/2567/2632/2697 各类型源不存在（note/tr/exam/essay_session/essay_/file/img/att/mm）→`.missing_sources`；2338 create_note 标题超过 500 字符（`vfs/repos/note_repo.rs:358`，499 字符加“ (副本)”）→`.note_title_overflow`；2552 copy_exam_sheet 写 folder_items 时 FK 失败→`.exam_mindmap_missing_dst_folder`；2746 create_mindmap_in_folder 报文件夹 NotFound（`vfs/repos/mindmap_repo.rs:451`）→`.exam_mindmap_missing_dst_folder`；2760 循环复制（自身、子、孙）→`.folder_circular`；2767 非法类型（`/res_abc`）→`.errors_paths`；`copy_folder_recursive` 2873 源文件夹不存在→`.folder_missing_src_or_dst`；2904 create_folder 报 InvalidParent（`folder_repo.rs:321`）→`.folder_missing_src_or_dst`；2904 FolderDepthExceeded（`folder_repo.rs:330`）→`.folder_depth_limit` | 2360 `textbooks` 分支不可达：`tb_` 被推断为 files，`dstu_create` 也不能创建 textbook（`handlers.rs:940`）。2304/2313/2441/2451/2529/2575/2601/2640/2649/2660/2705/2717 是 DB 错误，需要故障注入。2854 MAX_COPY_DEPTH 不可达：文件夹最多 10 层（`folder_repo.rs:33`），递归 depth 最大 9。2904 FolderCountExceeded（500 个，`folder_repo.rs:340`）技术上可达，但要先造 500 个文件夹，成本太高，未写。2755 `is_subfolder_of` 的 Err（2812）是 DB 错误 |
| `dstu_move_many` | `src/dstu/api.ts:895` | `dstu/handlers.rs:5530` | `vfs.dstu.move_many.mixed_types_to_folder`、`.back_to_root`、`.skips_invalid_paths`、`.missing_dest_folder_zero`、`.batch_limit_boundary`（100 条） | 5545 超过 MAX_BATCH_SIZE=100（101 条）→`.batch_limit_boundary`；5564 dest 解析失败（`/abc`、`/@trash`）→`.errors_dest`；5568 dest 不是文件夹→`.errors_dest`；5579/5591 单项跳过（解析失败、resources 类型）以及 5604 单项移动失败只计数，不返回 Err→`.skips_invalid_paths`、`.missing_dest_folder_zero`；serde→`.args_invalid` | 5584/5590 的 `textbooks`/`images`/`attachments` 映射不可达，理由同 dstu_move |
| `dstu_move_to_folder` | `src/dstu/api/pathApi.ts:141` | `dstu/handlers.rs:6137` | `vfs.dstu.move_to_folder.refreshed_note_to_folder_and_back`、`.no_row_insert`、`.missing_and_unknown_ids`、`.folder_as_resource`、`.soft_deleted_target_folder` | 6170 旧路径查询报错，原因是 `cached_path` 为 NULL（`dstu_create` 和 `dstu_move` 都会让它为 NULL）→`.null_cached_path`；6211 UPDATE 时目标文件夹 FK 失败（包括 `""`）→`.fk_missing_target`；6231 INSERT 时 FK 失败→`.fk_missing_target`；6231 INSERT 唯一索引冲突（旧行 item_type=file，新推断为 unknown）→`.unique_conflict_insert`；serde→`.args_invalid` | 6159 get_conn、6198 SELECT id 错误、6249 join 错误需要故障注入。`build_folder_path` 出错时被 `unwrap_or_else` 吞掉（6177），没有 Err 分支 |
| `dstu_batch_move` | `src/dstu/api/pathApi.ts:171` | `dstu/handlers.rs:6297` | `vfs.dstu.batch_move.refreshed_items_to_folder`、`.empty_items`、`.partial_failures`、`.missing_target_all_fail`、`.over_100_no_limit` | 命令本身只有 serde 错误→`.args_invalid`。业务失败都在 `move_single_item`（6421）里，记入 `failedItems`，命令仍返回 Ok：6440 cached_path 为 NULL→`.partial_failures`；6467 UPDATE FK→`.missing_target_all_fail`；6487 INSERT FK→`.missing_target_all_fail`；6487 唯一冲突→`.partial_failures`；6310 空列表提前返回→`.empty_items` | 函数体除 serde 外没有可触发的 Err 返回。6329 get_conn、6363 join 错误、6459 SELECT id 错误需要故障注入 |

#### 2. 依赖别域的 owner

- `dstu_create`、`dstu_get`、`dstu_list`、`dstu_get_content`、`dstu_rename`、`dstu_delete`：lane 的 CRUD 组（`dstu-crud.json`）。
- `dstu_folder_create`、`dstu_folder_get`、`dstu_folder_get_tree`、`dstu_folder_list`、`dstu_folder_delete`：folders 组（`folders.v0.json`）。
- `dstu_get_resource_location`、`dstu_refresh_path_cache`（`pathApi.ts:90/209`）：本 lane（L13，场景见 `dstu-path.g3.json`）。这两个命令在本组只用于读回和构造 cached_path 前置状态。
- textbook 的 move/copy 需要 textbook seed（`textbooks_add`/`vfs_upload_file`），归 textbook 域 owner。本组没写，而且 `tb_` 实际走的是 files 分支。

#### 3. B 侧容易写偏的行为

- `dstu_move` 返回的 `node.path` 始终是 `/{id}`，不带文件夹路径（`dstu/handler_utils/node_converters.rs`、`dstu/path_parser.rs` 的 `build_simple_resource_path`）。
- `dstu_move` 在源不存在或源是文件夹时，会先插入一行 folder_items（`vfs/repos/folder_repo.rs:3035`），然后才报错（`handlers.rs:1846/1855`）。报错之后这行孤儿记录仍留在库里。
- `dstu_move_many` 不检查源是否存在。missing id 也会插入 folder_items 并计入成功数（`handlers.rs:5594-5597`）。
- `dstu_move_to_folder` 和 `move_single_item` 读 `cached_path` 用的是 `String`，遇到 NULL 会报错（`handlers.rs:6167/6437`）。`dstu_create` 新建的资源和刚被 `dstu_move` 过的资源都是 NULL，必须先跑 `dstu_refresh_path_cache`。
- `dstu_move_to_folder` 和 `dstu_batch_move` 不检查目标文件夹是否存在或已软删除，只依赖 FK。软删除的文件夹能移进去（`handlers.rs:6202`）。`dstu_move` 会拒绝这种目标（`folder_repo.rs:422`）。
- `dstu_move_to_folder` 的 UPDATE 没有 `item_type` 条件（`handlers.rs:6203`）。`move_single_item` 的 UPDATE 有这个条件（`handlers.rs:6464`）。
- `DstuParsedPath::infer_resource_type` 不认识 `img_`，会推断为 unknown（`dstu/types.rs:727`）。`infer_resource_type_from_id` 会把 `img_` 推断为 files（`path_utils.rs:96`）。两边对同一个 id 写入的 item_type 不一样，所以会出现唯一索引冲突。
- `dstu_move_to_folder` 和 `dstu_batch_move` 不校验 resourceId，unknown 前缀照样插入 `item_type='unknown'`。文件夹 id 会插入 `item_type='folder'` 的 folder_items，但 `folders.parent_id` 不变（`handlers.rs:6216`）。
- `folderPath` 不带前导 `/`（`folder_repo.rs:2316`）。所以 `fullPath` 是 `A/B/id`，根目录是 `/id`。
- `dstu_copy` 对 note、translation、essay、file 加入目标文件夹失败时只打 warn，副本留在根目录、没有 folder_items 行，命令返回成功（`handlers.rs:2349/2506/2612/2677`）。exam 和 mindmap 在同样情况下会报错（`handlers.rs:2539/2723`）。
- `dstu_copy` 复制到根目录时，note、translation、essay、file 的副本都没有 folder_items 行（`create_note`、`create_translation`、`create_session`、`copy_file_with_conn` 都不写这张表）。exam 和 mindmap 的副本有这行。
- 复制后的名称：顶层加“ (副本)”。文件夹递归复制时，子文件夹和子资源不加后缀（`handlers.rs:2886`、`3012`）。exam 的“(副本)”由 repo 加（`vfs/repos/exam_repo.rs:417`）。
- `copy_folder_recursive` 中子文件夹或子资源复制失败（例如超过深度限制）只打 warn，返回的文件夹树不完整（`handlers.rs:2928-2966`）→`vfs.dstu.copy.folder_depth_limit` 最后一次复制。
- `dstu_copy` 的 essays 分支只查 session（`handlers.rs:2560`）。`essay_` 前缀的 id 会报 not found。
- 单段 id 路径不做 128 字符长度检查，多段路径才检查（`path_utils.rs:16` 和 `path_parser.rs:103`）。
- dst 先 trim 再判断：`"  /  "` 不等于 `/`，但 `trim()=="/"` 成立，按根目录处理（`handlers.rs:1807`）。
- 前端 `moveMany` 同时传 `dest_folder` 和 `destFolder` 两个键（`src/dstu/api.ts:895`）。`dstu_move_many` 有 100 条上限，`dstu_batch_move` 没有上限。

#### 4. 统计

- 场景数：53
- 步数：377
- 成功意图步数：311
- error 意图步数：66

### A2：DSTU 路径解析/构造/定位/缓存/监听

场景文件：`host/plugins/vfs/equivalence/dstu-path.g3.json`（`check-g3.mjs` 通过）。

#### 1. 逐命令表

Rust 文件均为 `src-tauri/crates/dstu-vfs/src/dstu/handlers.rs`，另注明的除外。前端 invoke 在 `src/dstu/api/pathApi.ts`（watch/unwatch 在 `src/dstu/api.ts`）。

| 命令 | 前端 invoke 文件:行 | Rust 文件:行 | 成功场景 id | 错误场景/步覆盖的分支（Rust 行号→场景 id） | 未覆盖分支及理由 |
|---|---|---|---|---|---|
| `dstu_parse_path` | pathApi.ts:43 | handlers.rs:5851 | `vfs.dstu.parse_path.root_forms`（:5856 空串/`/`，:5876 `//`），`.virtual`（:5869），`.resource_prefixes`（:5888 各前缀，`types.rs:727`），`.multi_segment`（:5891 有文件夹段 / :5905 纯文件夹路径），`.long_segment`，`.created_paths`（真实 create 返回的 path/id） | 无业务 Err。仅有 serde 错误步：`vfs.dstu.parse_path.args_invalid` | 函数体所有返回都是 `Ok`；:5884 `segments.last()==None` 在 :5876 之后不可达 |
| `dstu_build_path` | pathApi.ts:65 | handlers.rs:5929 | `vfs.dstu.build_path.root_and_nested`（:5946 null/省略 folderId、:5952 有父子文件夹），`.folder_missing_renamed_deleted`（缺失/空串/已改名/已删文件夹） | 无业务 Err。serde：`vfs.dstu.build_path.args_invalid` | :5944 `map_err` 只在 DB 出错时触发（`folder_repo.rs:2290-2314`）；文件夹不存在时 CTE 返回空，结果走 :5950 根路径，不报错 |
| `dstu_get_resource_location` | pathApi.ts:90 | handlers.rs:5973 | `vfs.dstu.get_resource_location.root_and_folder`，`.cached_path`（:6008 cached_path 命中/未命中），`.each_type`（exam/tr/essay/mm，根+文件夹），`.deleted` | 无业务 Err。缺失 id 返回 Ok（:5999 unwrap_or）：`vfs.dstu.get_resource_location.missing`，含 serde 错误步 | :5988、:5997 只有 DB 出错可达（需故障注入） |
| `dstu_get_resource_by_path` | pathApi.ts:108 | handlers.rs:6042 | `vfs.dstu.get_resource_by_path.root_virtual`（:6053、:6057），`.root_resources`（note/exam/tr/essay/folder 命中，mindmap 走 :6106），`.in_folder`（多段路径，:6114 纯文件夹路径），`.deleted` | 无业务 Err。缺失资源各分支 `Ok(None)`：`vfs.dstu.get_resource_by_path.missing`，含 serde 错误步 | :6075/:6080/:6085/:6090/:6095/:6104 的 `Err` 只在 DB 出错时触发；:6077 textbook 分支不可达（infer 结果没有 `"textbook"`，见第 3 节） |
| `dstu_refresh_path_cache` | pathApi.ts:209 | handlers.rs:6516 | `vfs.dstu.refresh_path_cache.all_null`（:6560 null 全量，也覆盖省略 resourceId），`.single_resource`（:6532 单个 resourceId，根/文件夹/mm/essay/fld） | 无业务 Err。缺失/已删/未知前缀返回 0：`vfs.dstu.refresh_path_cache.missing_and_deleted`，含 serde 错误步 | :6529/:6538/:6556/:6564/:6573/:6600 只有 DB 出错可达；:6612 spawn_blocking join 失败需故障注入 |
| `dstu_get_path_by_id` | pathApi.ts:229 | handlers.rs:6625 → `vfs/ref_handlers.rs:1979` | `vfs.dstu.get_path_by_id.root_and_nested`（`ref_handlers.rs:1006` 在文件夹内 / :1011 在根目录 / :1985 未知前缀如 fld_），`.deleted` | 无业务 Err。`vfs.dstu.get_path_by_id.missing`（缺失 id、空串、未知前缀都返回 Ok），含 serde 错误步 | :6637 只有 DB 出错时报错（`ref_handlers.rs:1980/1002/1008`） |
| `dstu_watch` | api.ts:735 | handlers.rs:5627 | `vfs.dstu.watch.paths`（`*`、`/`、真实 path、虚拟路径、空串、超长段；之后 rename+get 读回） | 函数体只有 `Ok(())`。serde：`vfs.dstu.watch.paths` 后两步 | 无 |
| `dstu_unwatch` | api.ts:738, api.ts:804 | handlers.rs:5634 | `vfs.dstu.unwatch.paths`（先 watch 再 unwatch、重复 unwatch、从未 watch 过的 path） | 函数体只有 `Ok(())`。serde：`vfs.dstu.unwatch.paths` 后两步 | 无 |

全部 18 个 error 意图步都是 serde/契约形状错误（缺字段、null、类型错），它们不算业务错误分支覆盖。这 8 条命令都没有前端输入可触发的业务 Err。

#### 2. 依赖别域的 owner

- 造数据用本 lane 的 `dstu_create`（note/exam/translation/essay/mindmap）、`dstu_folder_create`、`dstu_folder_rename`、`dstu_folder_delete`、`dstu_delete`、`dstu_restore`、`dstu_rename`、`dstu_get`，不依赖别域。
- textbook/file（`tb_`/`file_`/`att_`）没有真实数据：`dstu_create` 不支持直接建 textbook（handlers.rs:938 附近），file 需要 base64/staged 上传。这几个前缀只用 missing id 覆盖。文件导入命令的 owner 负责补真实 file 场景。

#### 3. B 侧容易写偏的行为

- `dstu_parse_path` 不校验虚拟路径白名单，`/@unknown`、`/@`、`/@trash/note_x` 都返回 `isVirtual:true`，fullPath 原样保留（handlers.rs:5869）。`path_parser.rs:80` 的 `parse_real_path` 只接受 `VIRTUAL_PATH_TYPES`（`path_types.rs:260`），但 IPC 命令没有用它。
- `dstu_parse_path` 规范化只做“补前导 `/` + 去尾部 `/`”，不合并中间的 `//`，所以 `fullPath` 仍是 `/a//b///note_x`；但 `folderPath` 由过滤空段后的 segments 重新拼接成 `/a/b`（handlers.rs:5861-5892）。`/ `（空格）不算根。
- `infer_resource_type` 把 `tb_`/`att_`/`file_` 都推成 `"file"`（types.rs:730），前缀区分大小写，`note_` 本身（空后缀）也算 note。
- `dstu_get_resource_by_path` 的 match 没有 `"file"`/`"mindmap"` 分支，已存在的 mindmap、file 返回 `null`，`"textbook"` 分支是死代码（handlers.rs:6071-6112）。
- `dstu_get_resource_by_path` 对 folder 用 `get_folder`，它不过滤 `deleted_at`（`folder_repo.rs:389`），所以已删除的文件夹仍返回节点；note 等资源会过滤已删除记录。folder 节点的 path 用的是解析出来的 fullPath，不是 `/fld_x`。
- 纯文件夹路径（如 `/高考复习/函数`）不查库，固定返回 `null`（handlers.rs:6114-6117）。
- `build_folder_path` 返回的路径没有前导 `/`（`folder_repo.rs:2316`）。所以 `dstu_build_path`、`dstu_get_resource_location`、`dstu_refresh_path_cache` 对文件夹内资源产出 `数学/代数/note_x`，对根资源产出 `/note_x`。`dstu_get_path_by_id` 对根资源产出 `note_x`，不带 `/`（`ref_handlers.rs:1013`），对文件夹内资源产出 `数学/note_x`。
- 文件夹不存在时，`dstu_build_path` 不报错，返回 `/<resourceId>`。folderId 为 `""` 时走 Some 分支，结果相同。两个 CTE 都不过滤已删除文件夹（`folder_repo.rs:2298`、`ref_handlers.rs:1021`），所以已删除文件夹的标题仍会拼进路径。
- `dstu_get_resource_location` 查询 folder_items 时没有 canonical 化 item_type（handlers.rs:5993），而 `dstu_refresh_path_cache` 有（handlers.rs:6542）。对缺失或未知前缀，location 返回 `resourceType:"unknown"`、`folderId:null`、`folderPath:""`、`fullPath:"/<id>"`、`hash:null`。
- cached_path 优先：先 refresh 再查 location，fullPath 取缓存值（没有前导 `/` 的 `数学/note_x`）。文件夹改名会清空子树的 cached_path（`folder_repo.rs:1104`），资源 rename 也会清空（handlers.rs:2209）。
- `dstu_refresh_path_cache` 只刷新 folder_items 行，folder 自身（fld_）没有 folder_items 行，返回 0。`resourceId:""` 经过 Option 反序列化后是 `Some("")`，推断出 `unknown`，返回 0。
- 删除 note 会软删除它的 folder_items（`note_repo.rs:2383`），之后 location 回退到 `/<id>`、folderId 为 null；restore 会恢复 folder_items（`note_repo.rs:1618`）。
- `dstu_watch`/`dstu_unwatch` 是空操作，不写 DB、不发事件，任何字符串都返回 `null`（handlers.rs:5627-5638）。

#### 4. 统计

- 场景数：28
- 步数：303（包括造数据步）
- 成功意图步数：285
- error 意图步数：18（都是 serde 形状错误）

### A3：dstu_export / dstu_export_formats / dstu_purge_all / dstu_search_in_folder

语料文件：`host/plugins/vfs/equivalence/dstu-misc.g3.json`（26 个场景，`check-g3.mjs` 自检 0 错误）。

路径约定：文件夹传裸 `${n.id}`（`fld_xxx`），上传附件/文件传 `${n.sourceId}`。`extract_resource_info` / `infer_node_type_from_path` 都接受不带前导 `/` 的形式。

#### 命令表

| 命令 | 前端 invoke 文件:行 | Rust 文件:行 | 成功场景 id | 错误场景/步覆盖的分支（Rust 行号→场景 id） | 未覆盖分支及理由 |
|---|---|---|---|---|---|
| dstu_export_formats | src/dstu/api.ts:1077（调用方 src/features/learning-hub/utils/exportResource.ts:85） | src-tauri/crates/dstu-vfs/src/dstu/export/mod.rs:276 | vfs.dstu.export_formats.each_type；vfs.dstu.export_formats.prefix_only_missing；vfs.dstu.export.folder.zip_mixed（步 18）；vfs.dstu.export.folder.zip_errors（步 14） | mod.rs:283 extract_resource_info 失败（""、"/"、"abc"、纯文件夹路径、"/@trash"、多段 UUID、多段长度 >128，见 path_parser.rs:103）→ vfs.dstu.export_formats.invalid_path 步 0-6；mod.rs:285 / mod.rs:605 无法推断类型（单段 UUID、res_ 前缀）→ vfs.dstu.export_formats.invalid_path 步 7-8；serde 缺参 / null → vfs.dstu.export_formats.invalid_path 步 9-10 | mod.rs:584 "路径为空"：extract_resource_info 已先拒绝空路径，不可达。各 adapter `_ =>` 分支：registry 先过滤，不可达 |
| dstu_export | src/dstu/api.ts:1098（调用方 src/features/learning-hub/utils/exportResource.ts:68、:110） | src-tauri/crates/dstu-vfs/src/dstu/export/mod.rs:305 | vfs.dstu.export.note.markdown；vfs.dstu.export.note.unsupported_and_lifecycle（步 11，恢复后）；vfs.dstu.export.translation；vfs.dstu.export.mindmap；vfs.dstu.export.exam.empty_sheet；vfs.dstu.export.exam.with_questions；vfs.dstu.export.essay；vfs.dstu.export.file.dstu_created；vfs.dstu.export.file.uploaded；vfs.dstu.export.folder.zip_mixed | mod.rs:316 非法格式（"pdf"、""、" markdown"）→ vfs.dstu.export.note.unsupported_and_lifecycle 步 4-7；mod.rs:318 路径非法 → vfs.dstu.export.path_errors 步 0-4、7，vfs.dstu.export.note.unsupported_and_lifecycle 步 14；mod.rs:319 无法推断类型 → vfs.dstu.export.path_errors 步 5-6；mod.rs:330 文件夹 + 非 zip → vfs.dstu.export.folder.zip_mixed 步 15-16，vfs.dstu.export.folder.zip_errors 步 9；mod.rs:451 文件夹不存在 → vfs.dstu.export.folder.zip_errors 步 8；mod.rs:457 文件夹无资源（空、仅空子目录、已删文件夹）→ vfs.dstu.export.folder.zip_errors 步 1、4、13；mod.rs:561 全部导出失败 → vfs.dstu.export.folder.zip_errors 步 7；mod.rs:259 类型不支持该格式 → note（original/raw/zip）unsupported_and_lifecycle 步 1-3，translation 步 4，mindmap 步 3，exam.empty_sheet 步 3，essay 步 4-5，file.dstu_created 步 7，image_textbook_missing 步 1-2、5；note_adapter.rs:51 不存在/已删 → unsupported_and_lifecycle 步 9、12-13；translation_adapter.rs:351/:420 → translation 步 8-9；mindmap_adapter.rs:141 → mindmap 步 6-7；exam_adapter.rs:185 → exam.empty_sheet 步 6-7；essay_adapter.rs:305 → essay 步 6；essay_adapter.rs:379 → essay 步 7；image_adapter.rs:487 → image_textbook_missing 步 0；textbook_adapter.rs:52/:100 → image_textbook_missing 步 3-4；file_adapter.rs:579/:615 → file.dstu_created 步 8-9，file.uploaded 步 6；file_adapter.rs:586-591 无提取文本 → file.dstu_created 步 5-6；file_adapter.rs:646 "文件内容为空" → file.uploaded 步 5；serde 缺参/类型错 → path_errors 步 8-10 | 仅故障注入可达：mod.rs:340（spawn_blocking join）、:419、:428、:450、:469、:512、:527、:557；各 adapter 的 DB 错误行（note 50/55，mindmap 140/150，essay 304/308/378/384，textbook 51/57/99，exam 184/209/211/289，translation 350/357/419/425，image 486/513，file 578/614/645）。不可达：mod.rs:256（所有非文件夹类型均已注册），mod.rs:479/:490（文件夹条目前缀已知且格式非空），mod.rs:411 深度 >16（folder move 限制深度），mindmap_adapter.rs:151 与 :182（create 已规范化内容），image_adapter.rs:514/:519（img_ id 从不生成），file_adapter.rs:651（base64 解码失败无法构造）。依赖其他域：textbook_adapter.rs:70-75/:106/:110/:113 需 `textbooks_add`（L18-media-docs）；exam_adapter.rs:277/:279 需卸载或让题目导出 hook 失败（L14-qbank）；作文轮次内容需 `essay_grading_stream` + LLM（L15） |
| dstu_purge_all | src/dstu/api.ts:1035（无 UI 调用方，仅在 api.ts:1136 导出） | src-tauri/crates/dstu-vfs/src/dstu/handlers.rs:5142 | vfs.dstu.purge_all.notes；vfs.dstu.purge_all.empty_trash；vfs.dstu.purge_all.other_types_untouched；vfs.dstu.purge_all.invalid_type（步 17，对照） | handlers.rs:5212 不支持的类型（"Notes"、"note"、"translations"、"exams"、"essays"、"mindmaps"、"files"、"images"、"folders"、""、" notes"）→ vfs.dstu.purge_all.invalid_type 步 2-12；serde 缺参/null/数字 → vfs.dstu.purge_all.invalid_type 步 13-15 | 仅故障注入可达：handlers.rs:5189（notes purge DB 错误）、:5207（textbooks purge DB 错误）；:5152 预收集查询错误被静默忽略，不产生 Err。textbooks 有数据的成功路径需 `textbooks_add`（L18-media-docs），仅覆盖空回收站返回 0 |
| dstu_search_in_folder | src/dstu/api.ts:931（调用方 src/features/learning-hub/stores/finderStore.ts:925） | src-tauri/crates/dstu-vfs/src/dstu/handlers.rs:5655 | vfs.dstu.search_in_folder.folder_scope；vfs.dstu.search_in_folder.empty_query；vfs.dstu.search_in_folder.options；vfs.dstu.search_in_folder.global_fallback；vfs.dstu.search_in_folder.folder_errors（步 9、11，已删文件夹返回 []）；vfs.dstu.search_in_folder.trash_restore | handlers.rs:5679 "Folder not found"（fld_missing、"root"、""、UUID）→ vfs.dstu.search_in_folder.folder_errors 步 0-3；serde 缺 query / folderId 类型错 / query 类型错 → folder_errors 步 4-6；options 反序列化失败（limit 为负、typeFilter 非法枚举、limit 为字符串）→ vfs.dstu.search_in_folder.options 步 16-18 | 仅故障注入可达：handlers.rs:5683（get_folder DB 错误）、:5690（list_items_by_folder DB 错误）。:5821 委托 `dstu_search` 的内部错误分支归 dstu_search 所属分组 |

#### 依赖其他域的 owner

- `textbooks_add`（教材入库，需磁盘上真实 PDF）：L18-media-docs。教材导出成功路径与 `dstu_purge_all("textbooks")` 有数据路径依赖它。
- `qbank_create_question` 与题目导出 hook（`dstu-qbank/src/question_export_service/vfs_hook.rs`）：L14-qbank。用于 vfs.dstu.export.exam.with_questions；exam_adapter.rs:277 "题目导出服务未注册" 依赖该 hook 是否注册。
- `essay_grading_stream`（作文批改轮次，需 LLM）：L15。作文单轮导出未覆盖，只覆盖 essay_missing0000。
- `vfs_upload_attachment` / `vfs_upload_file`：本域（L13）上传命令，作为数据准备步骤。

#### B 可能实现错的行为

- export/mod.rs:316 `ExportFormat::from_str` 只做小写化不做 trim："MARKDOWN"/"Md"/"ZIP"/"RAW" 合法，" markdown" 非法；"md" 与 "raw" 分别是 markdown 与 original 的别名。
- export/mod.rs:330 文件夹 + 非 zip 格式的检查在存在性检查之前，所以不存在的文件夹配 markdown 报"不支持"而非 not_found。
- export/mod.rs:275 `dstu_export_formats` 不检查资源是否存在，只按 id 前缀返回格式列表；顺序固定：note [markdown]；textbook [original, markdown]；exam [markdown, original]；translation [markdown, original]；essay [markdown]；image [original]；file [original, markdown]；mindmap [markdown, original]；folder [zip]。
- export/mod.rs:457 `get_folder` 不过滤 deleted_at：已删文件夹仍能找到，因其条目被软删而报"文件夹无资源"，而不是 not_found。
- export/mod.rs:561 文件夹导出只要有一个条目成功就返回成功，失败条目写入 skipped；全部失败才报错（vfs_upload_file 的小文本文件 original 导出必失败）。
- export/mod.rs:469 文件夹 zip 写到 `std::env::temp_dir()/dstu_folder_export_{id}_{millis}.zip`，tempPath 不确定。
- note_adapter.rs:49 用带 `deleted_at IS NULL` 的 get_note，已删笔记导出返回 not_found；恢复后可再次导出。
- file_adapter.rs:578 dstu_create 创建的 image 拿到 file_ 前缀 id，走 FileExportAdapter（formats 为 [original, markdown]），不是 ImageExportAdapter；original 返回 blob 的 FilePath，依赖沙盒路径。
- file_adapter.rs:586-591 dstu_create 的 file/image 没有 extracted_text，markdown 导出报错；vfs_upload_file 的文件有 extracted_text，markdown 成功。
- file_adapter.rs:646 vfs_upload_file 的小文本 resources.data 为空，original 报 "文件内容为空"。
- handlers.rs:5703-5780 search_in_folder 标题匹配的 item_type match 没有 "essay" 分支，作文永远匹配不到；图片走 "file" 分支。
- handlers.rs:5793/5813 search_in_folder 带 folderId 时只使用 options.limit，忽略 sortBy/sortOrder/typeFilter/offset/tags/isFavorite 等；handlers.rs:5810 固定按 updated_at 降序；limit=0 截成空列表。
- handlers.rs:5785/5801 过滤 `__x__` 形式的隐藏名称；只查直接子项，不递归。
- handlers.rs:5821 folderId 为 null 或缺省时委托 `dstu_search`，此时 options.folderId 经 search_all 生效；只传 snake_case 的 `folder_id` 会被忽略并退化为全局搜索。
- handlers.rs:5679 search_in_folder 对已删文件夹不报错，返回 []（get_folder 不过滤 deleted_at）。
- handlers.rs:5212 purge_all 只接受 "notes" / "textbooks"，大小写敏感、不 trim；非法类型的报错发生在预收集查询（:5152）之后。
- handlers.rs:5141-5245 purge_all 即使计数为 0 也发出 `dstu:change:/{type}/_trash` 与 `dstu:change`（Purged）事件；ids 非空时后台起 Lance 清理任务。
- textbook_repo.rs:1296-1309 textbooks 的 count 是 id 数，包括单个 purge 失败的；textbook_repo.rs:1273 同时清理 ref_count=0 的 blob。
- note_repo.rs:2191 notes 在 SAVEPOINT 内清空；只清回收站中的笔记，其他类型的已删资源和未删笔记不受影响。

#### 统计

- 场景数：26
- 步数：314
- 成功意图步：223
- 错误意图步：91

按命令（只计目标命令自身的步）：

| 命令 | 涉及场景 | 含成功步的场景 | 含错误步的场景 | 成功步 | 错误步 | 其中 serde 错误 |
|---|---|---|---|---|---|---|
| dstu_export | 13 | 10 | 11 | 30 | 56 | 3 |
| dstu_export_formats | 5 | 4 | 1 | 27 | 11 | 2 |
| dstu_purge_all | 4 | 4 | 1 | 8 | 14 | 3 |
| dstu_search_in_folder | 6 | 6 | 2 | 27 | 10 | 6 |

### WP-223 B 组：dstu_set_metadata

场景文件 `host/plugins/vfs/equivalence/dstu-set-metadata.g3.json`；下文场景 id 省略前缀 `vfs.dstu.set_metadata.`。
H=`src-tauri/crates/dstu-vfs/src/dstu/handlers.rs`；R=`src-tauri/crates/dstu-vfs/src/vfs/repos/`。

#### 1. 命令表

| 命令 | 前端 invoke 文件:行 | Rust 文件:行 | 成功场景 id | 错误场景/步覆盖的分支（Rust 行号→场景 id） | 未覆盖分支及理由 |
|---|---|---|---|---|---|
| dstu_set_metadata | `src/dstu/api.ts:667` `{path, metadata, expectedUpdatedAt}`（setMetadata 第三参省略时为 undefined，不发键） | H:3348–4221；parse_note_metadata_update H:106–164 | note.success_fields、translation.success、essay_session.success、exam.success、file.pdf_success、image.success、mindmap.success、folder.success、path.cached_root_each_type、path.nested_real_path（第 4 步）、file.occ_bookmarks（第 2 步） | **路径**：H:3387 缓存命中但 item_type=mindmap→mindmap.cached_root_unsupported；H:3408 前缀无法推断→path.invalid（`/unknown_*`、无斜杠、`/@trash`）；H:3419 多段且未命中缓存→path.invalid（`/a/b/...`、`""`/`/` 0 段）、path.nested_real_path（move_to_folder 产出无前导斜杠的 fullPath）；H:4196 `res_` 推断为 resources→path.invalid。**笔记**：H:112→note.invalid_shape（字符串/数组/null）；H:119→invalid_shape（color、name/bookmarks）；H:128/136/142/147/154→invalid_shape（含 null 值）；R/note_repo.rs:353/359/365（标题空/501 字/换行）、377/384/390（101 标签/101 字/控制符）、413（33 个 props）、420→note_props.rs:81/84/87/90（空键/65 字/保留 Tags/控制符）、427（Key 与 `key ` 重复）、435/444/452（513 字/换行/对象/数组/null 值）→note.invalid_values；R/note_repo.rs:2013 NotFound→note.missing_and_deleted（isFavorite、`{}`、已软删）；R/note_revision_repo.rs:149 快照 NotFound→missing_and_deleted（title 变更的缺失笔记）；R/note_repo.rs:2024 冲突→note.occ_conflict。**翻译**：R/translation_repo.rs:546→translation.missing；572→translation.invalid_rating_partial、missing（9 先于 NotFound）；588→missing；787→missing（sourceText）；H:3543→missing（`{}`）。**作文**：H:3568→essay_session.errors（`{}`、只含未知键、全错类型、字符串 metadata）；R/essay_repo.rs:958→essay_session.errors（missing）；468→essay.missing（title）；H:3701→essay.missing（isFavorite/gradeLevel/essayType/`{}` 0 行更新后读回 None）。**题目集**：R/exam_repo.rs:804/764、H:3913→exam.missing。**文件**：H:3944→file.invalid_bookmarks；R/textbook_repo.rs:723–727 NotFound→file.occ_bookmarks 末步；R/textbook_repo.rs:2034 冲突→file.occ_bookmarks（复用旧版本、STALE、进度先写致自冲突）；R/file_repo.rs:922→file.missing（fileName）；H:4023→file.missing（isFavorite/readingProgress/无版本 bookmarks/`{}`/tb_/att_）。**导图**：R/mindmap_repo.rs:1383、551–556、H:4098→mindmap.missing。**文件夹**：H:4116→folder.missing（fld_、UUID）。**参数**：缺 path/缺 metadata/path 非字符串/path null/expectedUpdatedAt 数字→args.invalid、note.occ_conflict 第 5 步（serde，不算业务分支） | ① 整个 textbooks 分支 H:3711–3875（highlights 非数组 3716、>500 条 3719、缺版本 3724、replace_highlights_if_version、书签三态、title/fileName、3849 读回 None）：只有 folder_items.item_type='textbook' 且 cached_path 命中才进入；`add_item_to_folder`/move_to_folder/batch_move/refresh_path_cache 都经 `canonical_folder_item_type`（vfs/mod.rs:147）写成 'file'，`tb_` 简单路径推断为 files（handler_utils/path_utils.rs:94）。empty seed + 前端命令不可达，需 X3 历史种子（item_type='textbook' 且 cached_path='/tb_x'）。② 非会话作文 essay_* 的成功分支 H:3599–3708：essays 行只由 essay_grading 管线在 LLM 批改成功后写（dstu-tutor/src/essay_grading/pipeline.rs:542），已用 missing 覆盖其错误分支。③ 仅 DB/IO/竞态可达（需故障注入）：H:3424、3446 的 SQL 失败、3463/3477 之外的写失败、3508、3546、3593、3600–3619/3642–3687 连接/SQL、3704、3749、3779/3798、3818、3836、3852、3887/3901 之外的 SQL 失败、3916、3937、3961/3980、3996、4026、4047/4080 在 get 已成功后的竞态、4101、4119、4177（get_folder 成功后被删的竞态）；R/note_repo.rs:2078–2088（get 与 UPDATE 之间被改/删）；R/textbook_repo.rs:737（同事务内不可达）；H:4201–4214 清缓存失败只 warn。④ note OCC“当前值成功”分支：见第 3 节第 1 条 |

#### 2. 依赖别域 owner

- X3/历史种子：folder_items.item_type='textbook' 且 cached_path 为 `/tb_xxx` 的教材，才能覆盖 textbooks 分支（含 highlights OCC）。
- essay_grading（dstu-tutor，需真实 LLM）：生成 essay_* 行后才能写非会话作文的成功场景（isFavorite/title/gradeLevel/essayType）。
- L10 notes：若要覆盖笔记 OCC 当前值成功分支，需要一个前端可达、返回 notes.updated_at 原始字符串的读命令（见下）。

#### 3. 容易写偏的行为

- 笔记 OCC 比较的是 `notes.updated_at` 原始字符串（R/note_repo.rs:2017–2023，trim 后精确相等，空白视为未提供），格式为 `%Y-%m-%dT%H:%M:%S%.3fZ`（如 `2026-11-06T08:00:00.123Z`）。DstuNode.updatedAt 是毫秒整数，前端用 `updatedAtToVersionToken`（src/dstu/api.ts:647）做 `new Date(ms).toISOString()` 转换；场景引用只能取整值，本 lane 没有前端可达命令返回该字符串（vfs_get_note 为 frontend:none），所以只写了冲突分支。要覆盖当前值成功，需要 runner 支持 ms→ISO 转换，或提供上述字符串。
- 文件/教材 OCC 比较 `files.updated_at` 字符串（R/textbook_repo.rs:2030–2041），`vfs_get_file` 返回的 `updatedAt` 就是这一列（R/file_repo.rs:1397），所以 file.occ_bookmarks 用 `${1.updatedAt}` 能命中成功分支。DstuNode 里的 `metadata.annotationRevision` 只有 textbook_to_dstu_node 输出（handler_utils/node_converters.rs:242），file 节点没有。
- 文件分支先写 readingProgress（H:3925–3941，会推进 updated_at），再按 expectedUpdatedAt 替换书签。同一请求同时带进度、书签和当前版本时，书签必然冲突，进度却已落库（部分写入）：file.occ_bookmarks 第 6–7 步。
- 文件分支不处理 highlights/title/name（H:3922–4031）。PDF 的 file_ 节点保存高亮会静默成功但不落库；attachmentDstuAdapter 传的 `name`（src/dstu/adapters/attachmentDstuAdapter.ts:399）同样被忽略，文件改名要用 `fileName`。
- 文件分支 set_favorite、update_reading_progress、update_bookmarks 对 0 行更新不报错（R/file_repo.rs:935–950、R/textbook_repo.rs:560–585/685–712），缺失 id 只在读回时报“操作失败”（H:4023）；只有 fileName 走 NotFound（R/file_repo.rs:922）。
- 翻译多字段非原子：isFavorite 先提交，随后 qualityRating 越界报错（H:3454–3480），读回可见收藏已改：translation.invalid_rating_partial。qualityRating 为小数时 `as_i64` 取不到值，被静默忽略。
- 缺失笔记带 title/tags/props 时，先在 R/note_revision_repo.rs:148 做快照，报 “Note revision (missing or pruned)” NotFound，早于标题校验；只带 isFavorite 或 `{}` 时报 “Note” NotFound（R/note_repo.rs:2013）。
- 清缓存 SQL（H:4201–4207）用复数 resource_type（notes/exams/folders…）匹配单数 item_type，永远不命中。cached_path 被 dstu_move_to_folder/refresh_path_cache 设为 `/{id}` 后一直保留；对于导图，此后 set_metadata 永久走 H:3387 报 invalid_node_type（mindmap 不在 H:3373–3388 映射里）。
- dstu_move_to_folder 写入的嵌套 cached_path 没有前导斜杠（`F1/note_x`，R/folder_repo.rs:2296–2317 + H:6183–6187），set_metadata 规范化后为 `/F1/note_x`，永远不命中，嵌套真实路径都报“资源不存在”（H:3419）。
- 作文会话分支只认 title/isFavorite/essayType/gradeLevel/customPrompt 的正确类型，全部缺失（含全错类型）报 H:3568；essayDstuAdapter 会先在前端拦掉全 undefined 的请求（src/dstu/adapters/essayDstuAdapter.ts:494）。
- 文件夹 `isFavorite` 键存在但非布尔时，`.or(favorite)` 不会回退到 `favorite`（H:4128–4131）；title 写入不做 rename 校验，空串也能写入（H:4143、R/folder_repo.rs:1069）。
- 除 notes 和 files 的书签外，其余类型都忽略 expectedUpdatedAt，过期版本照常成功（exam/translation/essay_session/mindmap/folder 成功场景各有一步 STALE）。
- 导图收藏不推进 updated_at（R/mindmap_repo.rs:1366–1369）；dstu_set_metadata 给导图传 `expected_updated_at: None`（H:4071），不做 OCC。

#### 4. 统计

- 场景 27；步数 231；成功意图 133 步，error 意图 98 步。
- 目标命令 dstu_set_metadata 159 步：成功意图 61、error 意图 98（其中 4 步是 check-g3 识别的 serde 参数错误，另有 1 步 serde 错误因含引用未被脚本识别：note.occ_conflict 第 5 步）。
- 辅助：dstu_create 23、dstu_get 25、vfs_get_file 9、dstu_move_to_folder 7、dstu_folder_create 3、dstu_folder_get 3、dstu_refresh_path_cache 1、dstu_delete 1。
- `node host/plugins/vfs/equivalence/check-g3.mjs` 退出码 0。

### WP-223 组 C：dstu_folder_* 内容项、排序与查询

语料：`host/plugins/vfs/equivalence/folder-items.g3.json`（`check-g3.mjs` 退出码 0，无错误）。
行号缩写：`FH`=`src-tauri/crates/dstu-vfs/src/dstu/folder_handlers.rs`，`FR`=`src-tauri/crates/dstu-vfs/src/vfs/repos/folder_repo.rs`，`API`=`src/dstu/api/folderApi.ts`。场景 id 省略前缀 `vfs.folder.g3.`。所有命令的 `spawn_blocking` join error（如 FH:153、FH:543）和 `get_conn_safe` 失败都不能由前端输入触发，下表不再逐条重复。

#### 1. 命令覆盖表

| 命令 | 前端 invoke 文件:行 | Rust 文件:行 | 成功场景 id | 错误场景/步覆盖的分支（Rust 行号→场景 id） | 未覆盖分支及理由 |
|---|---|---|---|---|---|
| dstu_folder_add_item | API:222 | FH:471-544；FR:2680-2711 | add_item.note, add_item.all_types（8 种合法类型）, add_item.repeat_relocate_phantom（重复、改夹、移到根、省略 folderId、不存在的 item） | 非法 itemType FH:496-502→add_item.invalid_type_and_folder（notes/Note/NOTE/""/" note"/todo/folder/textbooks/retrieval/pdf；类型检查先于文件夹检查，用 `fld_missing0000`+bogus 验证）；文件夹不存在 FH:511-514（folder_exists 过滤 deleted_at，FR:420-427）→同场景（缺失 id、"root"、""、已软删文件夹、拿 note id 当文件夹）；serde→add_item.args | folder_exists DB 错误 FH:516-519、repo 写入 DB 错误 FH:536-539：只有 DB 故障才会触发 |
| dstu_folder_get_all_resources | API:365 | FH:762-805；FR:2438-2449 | get_all_resources.recursive, get_all_resources.empty_deleted_missing（空文件夹、悬空 item、已软删文件夹） | 文件夹不存在 NotFound FR:2445-2449→get_all_resources.empty_deleted_missing（缺失 id、"root"、""、note id）；serde（三个参数都必填，bool 不接受字符串/数字/null）→get_all_resources.args | 资源数超过 MAX_INJECT_RESOURCES=50 只打 warn 不返回 Err（FH:786-793、FR:2465-2473），没有错误分支；其余为 DB 错误 |
| dstu_folder_get_items | API:341 | FH:704-730；FR:2921-2949 | get_items.scopes（另作为多数场景的读回） | serde→get_items.args | 函数体没有业务 Err，只有 DB 错误 FR:2925/2935/2946 |
| dstu_folder_move_item | API:276 | FH:588-627；FR:3003-3048 | move_item.between_folders, move_item.insert_fallback（UPDATE 影响 0 行时走 INSERT FR:3025-3039：不存在的 item、bogus 类型、remove 后再 move、所在文件夹已删） | FolderNotFound FR:3011-3017→move_item.errors（缺失 id、"root"、""、已软删文件夹、note id、缺失 item+缺失文件夹）；INSERT 回退违反 `folder_items(item_id) WHERE deleted_at IS NULL` 唯一索引（V20260306__canonicalize_folder_item_mounts.sql:45）FR:3035-3038→move_item.errors（note 行用 exam 类型移动、image 行（库里存为 file）用 image 类型移动）；serde→move_item.args | mark_item_indexes_pending FR:3052 的 DB 错误：只有 DB 故障才会触发 |
| dstu_folder_remove_item | API:243 | FH:553-580；FR:2964-2977 | remove_item.basic, remove_item.file_alias（image 别名不命中、textbook→file 命中） | serde→remove_item.args | 函数体没有业务 Err，只有 DELETE 的 DB 错误 FR:2970-2973 |
| dstu_folder_reorder | API:387 | FH:817-849；FR:2726-2744、250-303 | reorder.siblings（空数组、缺失 id、重复 id、跨父级、已删文件夹）, reorder.large_batch 步 3（110 个 id，含单引号） | 超过 100 个 id 时 CASE WHEN 用字符串拼接 SQL（FR:276-297），id 含 NUL 时 prepare 失败→reorder.large_batch 步 5（推断，未实跑：NUL 截断 SQL 后字符串字面量不闭合）；serde→reorder.args | ≤100 个 id 走参数绑定 FR:263-273，没有可触发的 Err |
| dstu_folder_reorder_items | API:437 | FH:858-885；FR:2759-2780、250-303 | reorder_items.folder_scope, reorder_items.root_and_cross_folder（folderId 为 null/"root"、跨文件夹）, reorder_items.large_batch 步 5（104 个 id） | 同 reorder：NUL id 位于 >100 批次 FR:276-297→reorder_items.large_batch 步 7（推断）；serde→reorder_items.args | 同 reorder |
| dstu_folder_create | API:77 | FH:136-224；FR:317-345 | create.variants（parentId 为 null/"root"/"" FH:191-194、icon/color 为 ""、9 个预定义颜色名、100 字节边界、重名、软连字符/U+2028/引号）；depth_limit、count_limit、parent_errors 的前置步 | 空白标题 FH:167-169、控制字符 FH:60-66、Unicode 绕过字符 FH:68-74、路径分隔符/".." FH:76-82、长度>100 字节 FH:83-89→create.title_errors；icon 校验 FH:175-177（同四类）、color 校验 FH:180-187（FH:94-114）→create.icon_color_errors；校验顺序 title→icon→color→parent 也在这两个场景里验证；InvalidParent FR:319-325→create.parent_errors（缺失、"ROOT"、" root"、"null"、note id、已删父）；FolderDepthExceeded FR:327-335→create.depth_limit（第 11 层）；FolderCountExceeded FR:338-345→create.count_limit（实建 500 个，删一个后补位再超限）；serde→create.args | get_folder_depth 的 DB 错误被 `unwrap_or(0)` 吞掉（FR:454），没有 Err 分支；count/insert 的 DB 错误只有 DB 故障才会触发 |
| dstu_folder_get_tree | API:327 | FH:669-695；FR:2867-2906 | get_tree.items_and_order（另作为多处读回） | 无 | 函数体没有业务 Err，只有 DB 错误（list_all_folders FR:488-522、get_folder_items_all FR:2925-2946）；没有参数，所以没有 serde 步 |
| dstu_folder_list | API:313 | FH:637-663；FR:488-522 | list.order_and_deleted（另作为多处读回） | 无 | 函数体没有业务 Err，只有 DB 错误 FR:489/512/514；没有参数，所以没有 serde 步 |

#### 2. 依赖别域的 owner

- `dstu_create`（note/translation/essay/exam/mindmap/image/file）造被挂载的资源，`dstu_get` 读回：DSTU CRUD lane（`dstu-crud.json` / `dstu-crud-limits.json`）。
- `dstu_folder_delete`、`dstu_folder_get`、`dstu_folder_set_expanded` 用于软删、读回和改展开状态：folders.v0 lane（`folders.v0.json`）。
- image/file 用 base64 小文件直接 `dstu_create`，不走异步媒体管线；真实 textbook（`tb_`）没有构造，textbook 只作为 itemType 别名测试：教材 lane。
- `move_item` 会把 `resources` 的索引状态改成 pending（FR:3052），Lance 侧的后续处理：VFS index lane。本组 `capture.db:["*"]` 只看 SQLite。

#### 3. B 侧容易写偏的行为

- `dstu_create` 本身就会写一条 folder_items 行，根目录也写（`src-tauri/crates/dstu-vfs/src/dstu/handlers.rs:805-835`）。所以没调过 add_item 的资源也会出现在 `get_items(null)` 里，之后再 add_item 是"改位置"。
- image 和 file 在 folder_items 里存为 `"file"`（`src-tauri/crates/dstu-vfs/src/vfs/repos/file_repo.rs:274-279`）。`canonical_folder_item_type` 只把 `textbook` 映射为 `file`，不映射 `image`（`src-tauri/crates/dstu-vfs/src/vfs/mod.rs:147-152`）。
- add_item 先按 `(item_id, canonical type)` DELETE，再 INSERT OR REPLACE（FR:2686-2705）。类型不匹配时 DELETE 不命中，由唯一索引 `folder_items(item_id) WHERE deleted_at IS NULL` 触发 REPLACE 删除旧行，所以 `add_item("image", <file 行>)` 会把库里的类型改成 `"image"`。
- add_item 返回的 `itemType` 是调用方传入的原值（FH:524-534），库里存的是 canonical 值（textbook→file）。返回的 `sortOrder` 固定为 0（`src-tauri/crates/dstu-vfs/src/vfs/types.rs:1388-1397`）。
- move_item 的回退 INSERT 不是 upsert（FR:3035-3038）。同一 item_id 已有未删除的行但类型不同时会报唯一约束错，add_item 在同样输入下会成功。
- add_item 和 move_item 都不检查 item 是否存在，会写出悬空行。get_all_resources 对缺失的 item 用 item_id 当标题（FR:2405-2411）。
- `"root"` 和 `""`：create 映射为根（FH:191-194）；add_item、move_item、get_all_resources 当作不存在的文件夹报错；get_items、reorder_items 按字面值查询，返回空或 no-op（FR:2929）。前端 `moveItem`/`getFolderItems` 把 undefined 转为 null（API:279、API:342）。
- folder_exists 过滤 deleted_at（FR:420-427），get_folder_with_conn 不过滤（FR:378-410）。所以 add_item/move_item/create 拒绝已删文件夹，get_all_resources 对已删文件夹仍然成功。
- remove_item 是硬删除，不看 deleted_at，也不检查文件夹（FR:2970-2973）；不存在的行也返回 Ok。
- reorder_items 忽略 folderId（FR:2747-2763），按 folder_items 的主键 `id`（`fi_…`）更新。传资源 id（`note_…`）是静默 no-op。
- reorder 把 sort_order 设为下标，不过滤缺失 id、跨父级 id 和已软删文件夹，已删文件夹的 sort_order/updated_at 也会被改（FR:2726-2736）。
- 重复 id：≤100 个时逐条 UPDATE，最后一次出现的下标生效（FR:263-273）；>100 个时每 100 个一组用 CASE WHEN，组内第一次出现的下标生效，组之间仍是后者覆盖前者（FR:276-297）。批次之间没有事务，后面的组失败时前面的组已经生效。
- list 按 `sort_order ASC, created_at ASC` 排序（FR:496）；get_items 只按 `sort_order ASC`（FR:2930）；get_tree 用 Rust 稳定排序 `sort_by_key(sort_order)`，输入来自 list 的顺序（FR:2903）。新挂载的 item sort_order 都是 0，所以 get_items 里同 sort_order 的顺序不确定，比对时不能依赖。
- 标题长度按 UTF-8 字节计算（FH:83），上限 100：34 个汉字（102 字节）报错，33 个汉字加 1 个 ASCII 字符刚好 100 字节，可以通过。标题不 trim 就入库（FH:207）。空白判断用 `str::trim`，全角空格 U+3000 也算空白（FH:167）。
- `is_control` 只覆盖 Cc 类字符，软连字符 U+00AD 和行分隔符 U+2028 能通过（FH:34-38）；被拒的 Unicode 字符只有 FH:41-55 列出的 9 个。
- color 只接受空串、`#RRGGBB`（大小写不限）和 9 个小写颜色名（FH:94-114），`#fff`、`RED`、`white` 都报错。
- 深度：父文件夹深度 ≥10 时报错（FR:327-335），也就是最多 10 层。数量：只统计未删除的文件夹（FR:466-473），删一个就能再建一个。检查顺序是父存在→深度→数量，所以超限时缺失父文件夹报的是 InvalidParent。
- 错误都是 `e.to_string()` 后的纯字符串（如 FH:221、FH:538）。

#### 4. 统计

- 场景数：33（每个场景都含成功步；有 error 步的 18 个）。
- 步数：1021（其中 create.count_limit 占 509 步）。
- 成功意图步数：870。
- error 意图步数：151（其中 serde 参数错误 54 步）。

### WP-223 组 D：回收站 + vfs_upload_file

语料：`host/plugins/vfs/equivalence/trash.g3.json`（`check-g3.mjs` 退出码 0，无错误）。
下文行号：`TH`=`src-tauri/crates/dstu-vfs/src/dstu/trash_handlers.rs`，`DH`=`.../dstu/handler_utils/delete_helpers.rs`，`VH`=`.../vfs/handlers.rs`，repo 文件在 `.../vfs/repos/`。场景 id 省略前缀 `vfs.trash.` / `vfs.`。

#### 1. 命令覆盖表

| 命令 | 前端 invoke 文件:行 | Rust 文件:行 | 成功场景 id | 错误场景/步覆盖的分支（Rust 行号→场景 id） | 未覆盖分支及理由 |
|---|---|---|---|---|---|
| dstu_soft_delete | src/dstu/api/trashApi.ts:52 | TH:114-177 | soft_delete.each_type_readback, soft_delete.repeat_is_idempotent, soft_delete.folder_cascade（另作为其余 17 个场景的前置） | 未知 itemType TH:139-148→soft_delete.type_mismatch_and_unknown（notes/Note/""/attachment/retrieval）；repo Err TH:169-175：folder NotFound folder_repo.rs:1263、note NotFound note_repo.rs:1507、textbook NotFound textbook_repo.rs:891、exam NotFound exam_repo.rs:895、translation NotFound translation_repo.rs:643、essay NotFound essay_repo.rs:1123、image/file NotFound file_repo.rs:994、mindmap NotFound mindmap_repo.rs:1097→soft_delete.missing_ids；类型与 id 不匹配→soft_delete.type_mismatch_and_unknown；serde→soft_delete.args | 无 |
| dstu_trash_restore | trashApi.ts:68 | TH:181-231 | trash_restore.each_type_readback, trash_restore.twice_and_cycle, trash_restore.title_conflict_rename, trash_restore.folder_cascade_and_orphan, trash_restore.note_in_deleted_folder, upload.restore_soft_deleted_by_hash | 未知 itemType TH:201-207→trash_restore.not_deleted_missing_unknown；repo Err TH:223-229：未删除 folder folder_repo.rs:1486-1490、缺失 folder 1441-1445、note 未删除/缺失 note_repo.rs:1606-1610/1525-1531、textbook textbook_repo.rs:924、exam 缺失（裸 QueryReturnedNoRows）exam_repo.rs:1217-1221 与未删除 1228、translation translation_repo.rs:907、essay essay_repo.rs:1176、image/file file_repo.rs:1035、mindmap mindmap_repo.rs:1168-1173→trash_restore.not_deleted_missing_unknown；恢复两次→trash_restore.twice_and_cycle；serde→trash_restore.args | note_repo.rs:1613-1616 重名 1000 次后 Conflict：可达，但需造 1000 条同名笔记，成本过高 |
| dstu_list_trash | trashApi.ts:88（[]→null :91） | TH:238-248 / list_trash_with_db TH:253-546 | list_trash.empty_and_defaults, list_trash.pagination_and_filters, list_trash.after_restore_and_purge（另在 26 个场景中作回读） | 仅 serde→list_trash.args（负数、字符串、小数、u32 溢出、itemTypes 非数组） | 不可达（需故障注入）：TH:283/309/338/371/401/438/468/503 各类型查询 DB 错误 |
| dstu_permanently_delete | trashApi.ts:126 | TH:799-918 | permanently_delete.each_type_readback, permanently_delete.aliases_and_repeat, permanently_delete.folder_tree, list_trash.after_restore_and_purge | 未知类型 DH:272→permanently_delete.not_in_trash_missing_unknown（bogus/""/Note）；不在回收站 DH:276-281（9 个类型未删除 + 缺失 id + 复数别名）→permanently_delete.not_in_trash_missing_unknown；类型与 id 不匹配→permanently_delete.type_mismatch_in_trash；重复永久删除→permanently_delete.aliases_and_repeat；Err 透传 TH:910-916 由以上全部覆盖；serde→permanently_delete.args | 不可达（需故障注入）：DH:307 purge DB 错误、DH:314 COMMIT 失败 |
| dstu_empty_trash | trashApi.ts:107（[]→null :108） | TH:642-795 | empty_trash.empty_db, empty_trash.all_types_readback, empty_trash.filtered_sequence, empty_trash.folder_cascade_and_active, empty_trash.file_aliases | 仅 serde→empty_trash.args | 不可达（需故障注入）：TH:656-658 取连接、TH:680 BEGIN、TH:686-735 各类型 purge 错误、TH:741 COMMIT、TH:745-748 ROLLBACK |
| vfs_upload_file | src/api/vfsFileApi.ts:92 | VH:2108-2126 / upload_file_blocking VH:2128-2712 | upload.success_readback, upload.folder_and_dedup, upload.restore_soft_deleted_by_hash（另作为 15 个场景的前置） | base64 错误 VH:2151-2153（非法字符、data URL、缺 padding、含换行；并验证 base64 检查先于类型检查）→upload.validation_errors；不支持类型 VH:2155-2170（exe 类型、octet-stream 无扩展名、空 MIME、空白 MIME）→upload.validation_errors；文件夹不存在 file_repo.rs:516-523（缺失 id、字面量 `root`、已软删文件夹）→upload.validation_errors；serde→upload.args | 大小上限 VH:2172-2181（图片 50MB media_types.rs:70 / 文件 200MB attachment_repo.rs:145）：可达，但需 >67MB base64 载荷，fixture 过大。不可达（需故障注入）：VH:2125 join、VH:2193/2269 取连接、VH:2197-2198 sha 查询、VH:2256-2266 根文件夹查询、VH:2459-2482 saga DB 错误 |

#### 2. 他域依赖与 owner

- 真实 `tb_` 教材（`textbooks_add`，含 PDF 管线）：教材 lane。本组只通过 `vfs_upload_file` 加 `fileType:'textbook'` 走 textbook 分支。
- Lance/向量索引清理（permanently_delete 与 empty_trash 中的 index 删除）：VFS index lane。本组 `capture.db:["*"]` 只看 SQLite。
- `vfs_upload_file` 真实图片/PDF 成功场景（异步媒体管线）：媒体 lane，见 `host/plugins/media/equivalence/media-transcripts.json`。
- `dstu_create` / `dstu_folder_create` / `dstu_list` / `dstu_get` / `dstu_folder_*` / `vfs_list_files` / `vfs_get_file` 只作为前置和回读使用，归属 DSTU CRUD / 文件夹 lane。

#### 3. B 易错点

- soft_delete/restore 只接受精确小写单数 itemType，`notes`/`Note`/`attachment` 返回 InvalidPath（TH:139-148, TH:201-207）。
- permanently_delete 接受复数和 `attachment`，但大小写敏感，`Note` 报错（DH:239-272）。
- list/empty_trash 先转小写再比较，接受复数、image、attachment(s)、textbooks（TH:548-562）。
- 所有类型重复 soft_delete 都返回 Ok（folder_repo.rs:1256, note_repo.rs:1498 等）。
- textbook 分支按 id 更新任意 files 行，不级联 folder_items（textbook_repo.rs:865-900）。
- list_deleted_textbooks 只匹配 `id LIKE 'tb_%'`（textbook_repo.rs:1257）。经 textbook 分支删除的 `file_` 行出现在 file 类型下。`empty_trash` 带 `textbooks` 不会清除它，带 `attachments` 会。
- list_trash 每类先取 `limit+offset` 行（每类 SQL 按 deleted_at 排序），再全局按 updated_at desc 稳定排序。并列时按类型块顺序 folder,note,textbook,exam,translation,essay,file,mindmap 排列（TH:253-546）。
- `limit+offset` 用 u32 相加，可能溢出 panic（TH:276 等）。语料未覆盖，B 实现需决定行为。
- `itemTypes:[]` 过滤掉全部类型，与 null 不同；前端 wrapper 会把 [] 转成 null（trashApi.ts:91, :108）。
- empty_trash 无论 itemTypes 如何，都从所有类型收集 resource_ids/note_ids（TH:662-678），所以 note 资产目录可能在未选 notes 时也被删除（TH:759）。
- empty_trash 的 folder 计数只计顶层已删文件夹（folder_repo.rs:1688）。
- lookup_resource_id 只识别单数类型，permanently_delete 用复数时跳过索引清理（TH:30-50）。
- folder_items.deleted_at 在 exam 删除时写成整数毫秒，其他类型写字符串（exam_repo.rs:912）。
- exam 恢复缺失 id 返回裸 rusqlite QueryReturnedNoRows，不是 NotFound（exam_repo.rs:1217-1221）。
- essay restore_session 不更新 updated_at（essay_repo.rs:1171-1192）。
- note 恢复遇同名改名为 "(1)"（note_repo.rs:1573-1596）；folder 恢复遇同名也改名（folder_repo.rs:1472），父文件夹已删时移到根（folder_repo.rs:1448-1469）。
- mindmap 未删除时恢复报 NotFound "MindMap (deleted)"（mindmap_repo.rs:1168-1173）。
- upload 先查 sha 去重再校验文件夹，所以相同内容配缺失 folderId 返回 Ok 且 isNew:false（VH:2197-2251 早于 file_repo.rs:516-523）。
- 相同内容命中已软删文件时恢复该文件，但返回 isNew:true（file_repo.rs:540-561, VH:2704-2707）。
- 类型白名单是 MIME 或扩展名任一命中即可，`a.exe`+text/plain 能通过；空或空白 MIME 一律拒绝（attachment_repo.rs:384-399）。
- 文件名为空不校验；folderId 为空串视为根，字面量 `root` 报 NotFound（VH:2256-2266, file_repo.rs:516-523）。
- base64 用 STANDARD 严格解码：必须 padding，不允许空白和 data URL；base64 检查先于类型检查（VH:2151-2170）。

#### 4. 统计

- 场景 34，步骤 562：成功意图 443，错误意图 119。
- 按目标命令（成功场景/错误场景，成功步/错误步，其中 serde 错误步）：
  - dstu_soft_delete：20/3，101/25，serde 6
  - dstu_trash_restore：6/3，21/29，serde 4
  - dstu_list_trash：30/1，79/6，serde 6
  - dstu_permanently_delete：4/4，17/34，serde 4
  - dstu_empty_trash：5/1，17/3，serde 3
  - vfs_upload_file：18/2，48/22，serde 10
- 其余步骤为前置和回读：dstu_create 71、dstu_folder_create 22、dstu_list 20、vfs_list_files 16、dstu_folder_list 11、dstu_get 7、dstu_folder_get 5、vfs_get_file 5、dstu_folder_get_tree 3。

### E1：todo CRUD 场景说明（todo-crud.g3.json）

场景文件：`host/plugins/vfs/equivalence/todo-crud.g3.json`。Rust 路径相对 `src-tauri/crates/dstu-vfs/src/vfs/`，handler 文件为 `todo_handlers.rs`（下称 H），repo 为 `repos/todo_repo.rs`（下称 R）。

前端说明：契约 `contracts/ipc/L13-vfs-api.json` 中 8 条命令的 `frontend` 都写 `none`，但 `src/features/todo/api.ts` 有真实调用，以前端为准。wrapper `call(command, args)`（api.ts:138）直接 `invoke(command, args)`，不做键名转换；键名由调用方写成 camelCase（`listId`/`itemId`/`input`），与 Tauri 默认 camelCase 一致。`input` 内部字段由 Rust `#[serde(rename_all="camelCase")]`（H:110、H:136）解析。

#### 1. 逐命令表

| 命令 | 前端 invoke 文件:行 | Rust 文件:行 | 成功场景 id | 错误场景/步覆盖的分支（Rust 行号→场景 id） | 未覆盖分支及理由 |
|---|---|---|---|---|---|
| `todo_create_list` | src/features/todo/api.ts:151 `call('todo_create_list', { input })` | H:231；R:533/542 | `vfs.todo.create_list.full_fields_and_blank_title`、`vfs.todo.create_list.sort_order_after_delete`（另在多数场景中造数据） | 无业务 Err 分支。空白标题回落 "收件箱"（R:546-550）→ `full_fields_and_blank_title`；sort_order 取未删清单 MAX+1（R:561-567）→ `sort_order_after_delete`。serde 错误（缺 input/缺 title/类型错/title=null/color 非字符串）→ `vfs.todo.create_list.args_errors`，不计业务分支 | 仅 DB 错误：`get_conn_safe` R:537、INSERT R:569-585（需故障注入）；spawn_blocking join 失败 H:85-91 |
| `todo_delete_list` | api.ts:167 `call('todo_delete_list', { listId })` | H:293；R:815/910 | `vfs.todo.delete_list.cascade_items_and_idempotent`、`vfs.todo.delete_list.same_title_regular_list_deletable` | 默认收件箱保护 R:928-933 → `vfs.todo.delete_list.inbox_protected_and_missing`、`same_title_regular_list_deletable`；不存在 NotFound R:946-952（`tdl_missing0000`、空串）→ `inbox_protected_and_missing`；已软删幂等 Ok R:946-947 → `cascade_items_and_idempotent`；级联软删条目 R:957-960 → 同上 | SAVEPOINT/RELEASE 失败 R:911、R:967-969（DB 故障）。serde（缺 listId、数字）只作参数校验 |
| `todo_ensure_inbox` | api.ts:175 `call('todo_ensure_inbox', { title })`（调用方 useTodoStore.ts:1722 传 i18n 标题；quick-assistant/service.ts:280 不传） | H:317；R:1163 | `vfs.todo.ensure_inbox.create_trimmed_then_reuse`、`vfs.todo.ensure_inbox.default_title_no_arg`、`vfs.todo.ensure_inbox.default_title_blank` | 无业务 Err 分支。快速命中已有收件箱 R:1182-1184 → `create_trimmed_then_reuse`、`same_title_regular_list_deletable`；首次创建 trim 标题 R:1206-1210 → `create_trimmed_then_reuse`；空/缺省标题回落 "收件箱" → `default_title_no_arg`、`default_title_blank`。serde（title=5）→ `default_title_no_arg` | 事务内二次命中 R:1202-1204 只在并发竞态下可达；BEGIN IMMEDIATE/COMMIT 失败 R:1187、R:1226 为 DB 故障 |
| `todo_create_item` | api.ts:229 `call('todo_create_item', { input })` | H:452；R:1241/1250（校验函数 R:57、R:71、R:94、R:177、R:205、R:331） | `vfs.todo.create_item.full_fields_normalized`（另在多数场景中造数据） | 标题为空/全空白 R:1255-1260 → `field_validation_errors`；priority 非枚举（含大小写、空串）R:331-343 → `field_validation_errors`；dueDate 格式/非法日期 R:57-65 → 同上；dueTime R:71-82 → 同上；repeatJson 非 JSON/freq 非法/interval=0、>999、负数/byWeekday>6 R:177-214 → 同上；reminder R:94-104 → 同上；清单不存在（missing、空串）R:1275-1280 → `missing_and_cross_list_refs`；清单已软删 → `deleted_list_and_parent`；父项不存在（missing、空串 parentId）R:1292-1297 → `missing_and_cross_list_refs`；父项已软删 → `deleted_list_and_parent`；父项跨清单 R:1298-1306 → `missing_and_cross_list_refs`；校验顺序 → `vfs.todo.create_item.validation_order`。serde（缺 input/todoListId/title、tags 非数组、priority=null、dueDate 数字）→ `vfs.todo.create_item.args_errors` | DB 触发器 RAISE（V20260311/V20260612/V20260614：status/priority/self-ref/同清单）在 repo 预校验后不可达（新 id 不可能自引用）；SAVEPOINT/INSERT/UPDATE 失败 R:1343-1387 为 DB 故障 |
| `todo_get_item` | api.ts:233 `call('todo_get_item', { itemId })` | H:480；R:1421/1427 | `vfs.todo.get_item.live_completed_missing_deleted`（另在级联场景中读回） | 无业务 Err：不存在/空串/已软删都返回 `null`（R:1437 `deleted_at IS NULL` + `.optional()`）→ `live_completed_missing_deleted`。serde（缺 itemId、数字）→ 同上 | 仅 DB 错误 R:1422、R:1431-1442 |
| `todo_delete_item` | api.ts:253 `call('todo_delete_item', { itemId })` | H:564；R:1986/1992 | `vfs.todo.delete_item.subtree_cascade_and_idempotent`、`vfs.todo.delete_item.child_keeps_parent` | 不存在 NotFound R:2020-2025（missing、空串）→ `subtree_cascade_and_idempotent`；已删幂等 R:2026 → 同上；递归软删子树 R:2033-2047 → 两个场景；推进清单 updated_at R:2050-2055 → `subtree_cascade_and_idempotent`（第二次删除时 list_id=None 不推进）。serde（缺 itemId）→ 同上 | SAVEPOINT/RELEASE 失败 R:1997、R:2061 为 DB 故障；depth<100 截断 R:2040 需环形坏数据，前端不可构造（创建时 parent 必须已存在且新 id 不可自引用） |
| `todo_get_active_summary` | api.ts:310 `call('todo_get_active_summary')` | H:717；R:2881 | `vfs.todo.get_active_summary.overdue_limit_and_order`、`vfs.todo.get_active_summary.completed_today_only` | 无 Err 分支。无清单返回 None R:2894-2896 → `none_states`、`overdue_limit_and_order` 末步；有清单但无 pending 且今日无完成返回 None R:2984-2986 → `none_states`；overdue LIMIT 3 + due_date DESC R:2913-2924 → `overdue_limit_and_order`；todayCompleted R:2973-2981 → `completed_today_only`、`overdue_limit_and_order` | 无参数，无前端可触发的 Err；仅 DB 错误 R:2882、R:2889-2893、`query_summary_items`。`todayItems`/`upcomingHighPriority` 依赖运行当天日期（R:2883-2886），按 COMMON 不用"现在"推算，未造今日/近 3 天数据 |
| `todo_counts_snapshot` | api.ts:329 `call('todo_counts_snapshot')` | H:730；R:2809 | `vfs.todo.counts_snapshot.mixed_lists`（另在 `full_fields_and_blank_title`、`create_trimmed_then_reuse`、`create_item.args_errors` 读回） | 无 Err 分支。today 含逾期 R:2816-2820、inbox 计数 R:2828-2838、per_list LEFT JOIN 含 0 计数清单与排序 R:2846-2856、删条目/删清单后计数变化 → `mixed_lists` | 无参数，仅 DB 错误 R:2810-2856；`upcomingCount` 只能用固定远期/过去日期验证为 0，正值需要相对今天的日期，未造 |

#### 2. 依赖别域 owner

无。全部前置数据由本组命令和本 lane 的 `todo_list_lists`、`todo_get_list`、`todo_list_items`、`todo_list_deleted_items`、`todo_list_deleted_lists`、`todo_toggle_item`（前端 api.ts:159/155/237/213/193/249）构造和读回。`attachments` 传 `note_missing0000`，repo 不校验附件存在性（R:1322-1326），不依赖 dstu 资源。

#### 3. B 侧容易写偏的行为

- `todo_create_list` 不 trim 标题，`" 带空格 "` 原样保存；只有 trim 后为空才回落 "收件箱"，且回落出来的清单 `isDefault=false`（R:546-550，H:243）。
- `todo_ensure_inbox` 会 trim 标题（R:1206-1209），与 create_list 不一致；首次创建 `icon="inbox"`、`isDefault=true`（R:1217-1219）；已有收件箱时忽略传入标题；**不发 `todo://changed` 事件**（H:317-325）。
- 同标题 "收件箱" 的普通清单可删，保护只看 `is_default`（R:919-933）。
- `todo_delete_list` / `todo_delete_item` 对已软删目标幂等返回 Ok，handler 仍会再发一次 `todo://changed`（H:299、H:570）；对从未存在的 id 返回 NotFound。
- `todo_delete_list` 先查 is_default 再执行 UPDATE；对已删除的收件箱走幂等分支而非保护分支（R:921 带 `deleted_at IS NULL`）。
- 删除条目时子树与父项共用同一 `deletedAt`，但只有父项所在清单的 `updatedAt` 被推进；重复删除不推进（R:2001-2007、R:2050）。
- `todo_create_item` 校验顺序：title → priority → dueDate → dueTime → repeatJson → 清单存在 → 父项 → reminder（R:1254-1338）。reminder 在清单/父项校验之后，所以"清单不存在 + reminder 非法"报 NotFound。
- `todo_create_item` 标题 trim 后保存；description/dueDate/dueTime/reminder/repeatJson 的空串或全空白规范为 null（R:21-23）；但 `parentId: ""` 不规范化，报父项 NotFound（R:1283）。
- 日期/时间规范化：`2026-1-5` → `2026-01-05`，`9:05:30` → `09:05`，reminder `2026-01-05T08:30:59` → `2026-01-05T08:30`（R:57-109）。repeatJson 校验通过后按原串保存，不写回规范化结果（R:1266-1267、R:1363）；非 weekly 的 byWeekday 即使越界也被忽略、不报错（R:186-189）。
- priority 缺省为 `"none"`（H:142、H:160），显式 `null` 是 serde 错误而非默认值。
- 新条目 `sortOrder` 是同清单同 parent 未删条目的 MAX+1（R:1329-1335），软删条目不占位；返回体 `estimatedPomodoros`/`completedPomodoros` 为 `0`，`tagsJson`/`attachmentsJson` 缺省 `"[]"`（R:1316-1326、R:1412-1413）。
- 创建条目会推进所属清单 `updatedAt`（R:1371-1374）。
- `todo_get_item` 对已软删条目返回 null，不报错（R:1437）。
- `todo_get_active_summary` 在存在清单但无 pending 且今日无完成时返回 null；summary 的统计计数不按清单 deleted_at 过滤，但删清单会级联软删条目，结果一致（R:2942-2967）。
- `todo_counts_snapshot` 的 `todayCount` 含逾期 pending（`due_date <= today`，R:2817）；`perList` 只列未删清单、含 0 计数清单，排序为 `is_default DESC, sort_order ASC, updated_at DESC`（R:2854）。
- 错误 envelope 由 `cmd_err` 生成，`traceId` 为随机 UUID（H:50-62），比对时需要归一化（本文件 normalize 为空，待 C2 决定）。

#### 4. 统计

- 场景数：22
- 步数：210
- 成功意图步数：155
- error 意图步数：55（其中目标命令的 serde 参数错误步 17：create_list 5、delete_list 2、ensure_inbox 1、create_item 6、get_item 2、delete_item 1）

每条命令（含成功步的场景数 / 含 error 步的场景数）：create_list 15/1、delete_list 6/2、ensure_inbox 7/1、create_item 12/5、get_item 5/1、delete_item 7/1、get_active_summary 3/0、counts_snapshot 4/0。

`check-g3.mjs` 自检通过（exit 0）。

### E2：todo 批量命令 + AI 拆解（todo-batch.g3.json）

场景文件：`host/plugins/vfs/equivalence/todo-batch.g3.json`。下文 Rust 行号：handler 指 `src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs`，repo 指 `src-tauri/crates/dstu-vfs/src/vfs/repos/todo_repo.rs`。

契约 `contracts/ipc/L13-vfs-api.json` 里这 8 条命令的 `frontend` 写的是 `none`，但前端 `src/features/todo/api.ts` 确实有调用（经 `call()` 直传 `invoke(command, args)`，不做键名转换，键名就是 camelCase 的 `itemIds`/`dueDate`/`dueTime`/`priority`/`targetListId`/`itemId`）。上层调用方在 `src/features/todo/stores/useTodoStore.ts`、`src/features/todo/components/main/detail/SubtaskSection.tsx`。本说明以前端为准。

#### 1. 逐命令覆盖

所有批量命令共用 `sanitize_batch_ids`（repo:499），它在原始数组长度大于 500 时报错（repo:500），之后再去空白、去重。

| 命令 | 前端 invoke 文件:行 | Rust 文件:行 | 成功场景 id | 错误场景/步覆盖的分支（Rust 行号→场景 id） | 未覆盖分支及理由 |
|---|---|---|---|---|---|
| `todo_batch_complete` | src/features/todo/api.ts:358 | handler:750；repo:3403 | `vfs.todo.batch_complete.mixed_skip_idempotent`、`vfs.todo.batch_complete.limit_boundary`（500 条恰好通过） | repo:500 超限→`limit_boundary`[0]；serde 错类型→`limit_boundary`[5] | repo:3447 读后被并发删除（竞态）；repo:3448 其他更新错误（status 固定为 completed，已存在条目 title 非空，只剩 DB 错误）；repo:3417/3418/3458 DB；handler:85 JoinError |
| `todo_batch_reschedule` | src/features/todo/api.ts:372 | handler:769；repo:3480 | `vfs.todo.batch_reschedule.date_time_semantics` | repo:3487→validate_due_date repo:61（`2026/12/01`、`2026-02-30`、空数组 + 坏日期）→`invalid_format`[2][3][5]；repo:3488→validate_due_time repo:78（`25:00`）→`invalid_format`[4]；repo:500→`invalid_format`[6]；serde→`invalid_format`[9] | repo:3517 更新路径的其他错误（入参已预校验，只剩 DB）；repo:3497/3498/3525 DB；handler:85 |
| `todo_batch_set_priority` | src/features/todo/api.ts:409 | handler:791；repo:3544 | `vfs.todo.batch_set_priority.mixed_skip` | repo:3550→validate_todo_priority repo:335（`URGENT`、`""`、空数组 + `critical`）→`invalid`[2][3][4]；repo:500→`invalid`[5]；serde 缺 priority→`invalid`[7] | repo:3577 DB；repo:3559/3560/3585 DB；handler:85 |
| `todo_batch_move` | src/features/todo/api.ts:383 | handler:811；repo:3606 | `vfs.todo.batch_move.subtree_ancestor_skip` | repo:3625 目标清单不存在→`target_invalid`[3]；目标清单已软删→`target_invalid`[5]；repo:500→`target_invalid`[6]；serde 缺 targetListId→`target_invalid`[8] | repo:3678（move_todo_item_with_conn 的 TodoList NotFound 已在 3625 预检；repo:2467 affected==0 需竞态）；repo:3618/3620/3632/3653 DB；handler:85 |
| `todo_batch_delete` | src/features/todo/api.ts:388 | handler:831；repo:3704 | `vfs.todo.batch_delete.subtree_idempotent`、`vfs.todo.batch_delete.limit` | repo:500→`limit`[0]；serde null→`limit`[5] | repo:3725 DB；repo:3715/3716/3736 DB；handler:85 |
| `todo_batch_restore` | src/features/todo/api.ts:393 | handler:849；repo:3754 | `vfs.todo.batch_restore.batch_semantics`、`vfs.todo.batch_restore.orphan_and_list_deleted` | repo:500→`orphan_and_list_deleted`[11]。业务前置失败（清单已删 repo:2204，不存在 repo:2188）在 repo:3774 被吞进 skippedIds，不是 Err，由成功步覆盖：`orphan_and_list_deleted`[10]、`batch_semantics`[7] | repo:3777 DB；repo:3765/3766/3785 DB；handler:85 |
| `todo_batch_purge` | src/features/todo/api.ts:398 | handler:868；repo:3802 | `vfs.todo.batch_purge.trash_only` | repo:500→`trash_only`[10]。未在回收站（repo:3321）与不存在（repo:3315）在 repo:3822 进 skippedIds，不是 Err，由 `trash_only`[5][8] 覆盖 | repo:3825 DB；repo:3813/3814/3834 DB；handler:85 |
| `todo_ai_breakdown` | src/features/todo/api.ts:298 | handler:1007 | `vfs.todo.ai_breakdown.mock_success`（先 `save_api_configurations` + `save_model_assignments` 把 model2 指向 X5 模拟模型 `wp223-todo-breakdown`，见 §2.1） | handler:1088 AI_EMPTY_RESULT→`mock_empty_result`[5]；handler:1085 请求失败（baseUrl `http://127.0.0.1:9/v1`）→`request_failed`[5]；handler:1024 条目不存在→`precondition_errors`[0]；软删条目同样走 1024（get_todo_item 过滤 deleted_at）→`precondition_errors`[7]；handler:1034 子任务不可拆→`precondition_errors`[4]；handler:1085 LLM 调用失败（无模型配置时 `get_model2_config` 报"对话模型未配置"，dstu-llm/src/llm_manager/mod.rs:6945）→`precondition_errors`[8]；serde 缺 itemId→`precondition_errors`[10] | handler:1123 插入失败（标题已过滤为非空，只在 LLM 调用期间清单被并发删除时触发，属竞态）；handler:1044/1102/1104/1132 DB；handler:85 |

#### 2. 依赖别域的 owner

- `todo_ai_breakdown` 的 3 个配置场景（`mock_success`、`mock_empty_result`、`request_failed`）依赖：
  - **L02（配置命令）**：第 0 步 `save_api_configurations`，参数形状照 `host/plugins/chat-pipeline/equivalence/workspace.json:9`；契约 `contracts/ipc/L02-llm-manager.json`（`ApiConfig__De`），Rust `src-tauri/src/commands.rs:2150`，前端 `src/utils/configApi.ts:108`。第 1 步 `save_model_assignments({ assignments: { model2_config_id } })`，键名是 snake_case（`dstu-core/src/models.rs:1162`，无 rename，`#[serde(default)]`，其余槽位为 null）。Rust `src-tauri/src/commands.rs:2183`，前端 `src/utils/configApi.ts:163`。model2 的读取路径：`call_model2_raw_prompt`（`dstu-llm/src/llm_manager/model2_pipeline.rs:8570`）→ `get_model2_config`（`llm_manager/mod.rs:6941`）按 `model2_config_id` 找 `enabled && !isEmbedding && !isReranker` 的配置（`routing.rs:386`）。配置 id 原样成为 profile id（`mod.rs:6892`）。
  - **X5（模拟服务）**：`http://127.0.0.1:18461/v1` 是参数化环回地址，录制时替换为 X5 实际端点，A/B 用同一端点。脚本见 §2.1。
  - 这两条配置命令写的是 settings（`model_assignments`、供应商/模型 profile），不是 VFS 表。`db:["*"]` 是否抓到它们由录制器决定。
- `precondition_errors`[8] 仍保留"无模型配置"态（空 seed、不调 L02），走 handler:1085，`get_model2_config` 报"对话模型未配置"（`mod.rs:6945`）。

##### 2.1 所需 X5 模拟脚本

请求方式（`model2_pipeline.rs:9051-9056`、`:9149-9157`）：非流式 `POST {baseUrl}/chat/completions`，请求体 `"stream": false`，`Accept: application/json`。只有一条 user 消息，content 为 `[{type:"text",text:<prompt>}]`。响应按 OpenAI chat completion JSON 解析，取 `choices[0].message.content`（`:9300`）。**不能用 SSE**：SSE 会被当成解析失败重试（`:9233`）。

`parse_breakdown_titles`（handler:954）只认 JSON 数组：先整体解析，失败再截第一个 `[` 到最后一个 `]`。元素可以是字符串或 `{"title":..}`，去空白、丢空串，每条截到 60 字，最多 8 条。纯文本编号列表（如 `1. 阅读教材\n2. 做练习\n3. 复盘错题`）解析出 0 条，会走 AI_EMPTY_RESULT，不会成功。所以成功脚本用 JSON 数组，空结果脚本正好用编号列表。

| model 名 | 场景 | HTTP 响应（非流式，`200`，`Content-Type: application/json`） | 预期结果 |
|---|---|---|---|
| `wp223-todo-breakdown` | `vfs.todo.ai_breakdown.mock_success` | `{"id":"chatcmpl-wp223-a","object":"chat.completion","model":"wp223-todo-breakdown","choices":[{"index":0,"message":{"role":"assistant","content":"[\"阅读教材\",\"做练习\",\"复盘错题\"]"},"finish_reason":"stop"}],"usage":{"prompt_tokens":9,"completion_tokens":3,"total_tokens":12}}` | 在父项下新建 3 个子任务：阅读教材、做练习、复盘错题，priority none，parentId=父项。现有子任务"整理笔记"保留。请求只发 1 次 |
| `wp223-todo-breakdown-empty` | `vfs.todo.ai_breakdown.mock_empty_result` | 同上结构，`content` 为 `"1. 阅读教材\n2. 做练习\n3. 复盘错题"`，id 用 `chatcmpl-wp223-b` | HTTP 调用成功，解析出 0 条，handler:1088 返回 `AI_EMPTY_RESULT`，不落库。请求只发 1 次（handler 不重试） |
| `wp223-todo-breakdown-unreachable` | `vfs.todo.ai_breakdown.request_failed` | 不需要脚本。baseUrl 为 `http://127.0.0.1:9/v1`，连接被拒 | 网络层失败被标为可重试（`:9196`），会内部退避重试后再失败（`:9285`），handler:1085 返回 `INTERNAL_ERROR`。耗时是秒级，取决于重试预算 |

每个场景在第 0 步只保存一个配置，所以没有其他模型可以做故障切换。

#### 3. B 侧容易写偏的行为

- 上限检查用的是原始长度，在去重、去空白之前（repo:500）：501 个相同 id 也报错，500 个可以通过。
- reschedule/set_priority 先校验日期/优先级再判空（repo:3487、repo:3550），所以空数组 + 非法值会报错。batch_move 反过来，先判空就返回 Ok，再检查目标清单（repo:3612 早于 3620）。
- reschedule 的 `dueDate` 为 null、缺省或 `""` 都清空日期，并联动清空时间（repo:3509、repo:1592）。`dueTime` 缺省保留原值，`""` 清空，只有空白的 `"   "` 预校验时视为 None，更新时也清空。
- 日期规范化为零填充：`2026-12-2` 变成 `2026-12-02`（repo:60）。时间接受 `HH:MM:SS` 并截断成 `HH:MM`（repo:77）。
- batch_complete 对已完成条目原样放进 items，不写库也不发事件（repo:3428、handler:759）。软删/不存在进 skippedIds。重复任务会派生新实例，新 id 进事件 entityIds，但不在返回的 items 里（repo:3442）。
- batch_delete 对已软删的条目返回 Ok，id 进 affectedIds 而不是 skippedIds（repo:2014-2027），并且照样发 `batch_delete` 事件（handler:840）。
- batch_restore 对未删除的条目返回 Ok，放进 items（repo:2195），不进 skippedIds。所属清单已删时进 skippedIds（repo:2204→3774）。父项仍在回收站时，子项恢复为顶层，parentId 置空（repo:2218）。
- batch_purge 按输入顺序逐条执行：先 purge 父项会物理删除子项，后面的子项 id 走 NotFound 进 skippedIds（repo:3332-3345、3822）。
- batch_move 跳过集在移动前整体算好，与输入顺序无关（repo:3637-3661）。被移动的根节点 parentId 置空（repo:2461），所以单独移动一个子项会把它从原父项下脱离。
- ai_breakdown 的前置检查（不存在、软删、子任务）在调用 LLM 之前完成。错误码：不存在走 `cmd_err(ItemNotFound)`，子任务是 `VFS_INVALID_OPERATION`，LLM 失败是 `INTERNAL_ERROR`（handler:1085）。
- ai_breakdown 的模型输出只按 JSON 数组解析（handler:954-1004）。编号列表、markdown 列表都会得到 AI_EMPTY_RESULT。成功时只返回新建的子任务，已有子任务标题只放进 prompt（handler:1071），不做去重校验。

#### 4. 统计

- 场景 17，步 164；成功意图步 136，error 意图步 28（其中 serde/契约形状错误 6 步：complete 错类型、reschedule dueDate 为数字、set_priority 缺 priority、move 缺 targetListId、delete 传 null、ai_breakdown 缺 itemId；业务错误 22 步）。另含 L02 配置步 6 步（3 × `save_api_configurations` + 3 × `save_model_assignments`），都计入成功意图步。
- 每命令（场景数 / 成功步 / error 步）：batch_complete 2/5/2，batch_reschedule 2/7/6，batch_set_priority 2/3/5，batch_move 2/3/4，batch_delete 3/5/2，batch_restore 2/4/1，batch_purge 1/3/1，ai_breakdown 4/1/7。

### WP-223 组 F：pomodoro 场景说明

场景文件：`host/plugins/vfs/equivalence/pomodoro.g3.json`（`node host/plugins/vfs/equivalence/check-g3.mjs` 通过，exit 0）。
下文 id 均省略前缀 `vfs.pomodoro.`。todo_handlers.rs、pomodoro_handlers.rs 指 `src-tauri/crates/dstu-vfs/src/vfs/` 下的同名文件，repo 指 `src-tauri/crates/dstu-vfs/src/vfs/repos/pomodoro_repo.rs`。

#### 1. 逐命令覆盖

| 命令 | 前端 invoke 文件:行 | Rust 文件:行 | 成功场景 id | 错误场景/步覆盖的分支（Rust 行号→场景 id） | 未覆盖分支及理由 |
|---|---|---|---|---|---|
| `pomodoro_daily_stats` | src/features/pomodoro/api.ts:74 | todo_handlers.rs:1247；repo:505 | daily_stats.empty_days_clamp、daily_stats.with_records | 无业务 Err。`days` 用 `unwrap_or(7)` 取默认，再在 repo:508 clamp 到 1–366：缺省/null→7 桶，0→1 桶，367/u32::MAX→366 桶，均为成功步。负数、小数、字符串、u32 溢出是 serde 错误步，在 daily_stats.empty_days_clamp | repo:513 `local_date_start_utc` Err（repo:603-618）只在本地时区某日 00:00–03:00 全部不存在时触发，需故障注入（自定义 TZ）；repo:515/516 是 DB 错误 |
| `pomodoro_delete_record` | src/features/pomodoro/api.ts:79 | pomodoro_handlers.rs:23；repo:237 | delete_record.linked_completed_recounts、delete_record.linked_todo_soft_deleted | repo:262 NotFound（重复删除、`pd_missing0000`、空串）→delete_record.not_found；serde（缺 recordId、null）→delete_record.not_found | pomodoro_handlers.rs:29-32 用 `.ok().flatten()` 吞掉 get_record 的 DB 错误；repo:238/243/257/278/284/292 是 DB 错误，需故障注入 |
| `pomodoro_get_record` | src/features/pomodoro/api.ts:57 | todo_handlers.rs:1204；repo:349 | get_record.existing_missing_and_deleted | 无业务 Err：缺失、空串、已软删都返回 `null`（repo:356、361）。serde（缺 recordId、数字）→get_record.existing_missing_and_deleted | repo:350/361 是 DB 错误 |
| `pomodoro_list_by_todo` | src/features/pomodoro/api.ts:61 | todo_handlers.rs:1216；repo:366 | list_by_todo.filters_by_item_excludes_deleted | 无业务 Err：缺失 id、空串、传 list id 都返回 `[]`。serde（缺参数、null）→同一场景 | repo:370/371/379 是 DB 错误 |
| `pomodoro_list_range` | src/features/pomodoro/api.ts:87 | pomodoro_handlers.rs:48；repo:631 | list_range.wide_range_with_records（含 `2026-1-1` 不补零的成功步）；list_range.invalid_input 里 start==end 的成功步 | repo:639 start 解析失败（`2026/11/06`、空串、`20261106`、`2026-02-30`、`2026-13-01`、带时间、`x`）、repo:645 end 解析失败（`bad`、`2026-11-31`）、repo:651 start>end（2 步）→list_range.invalid_input；serde（缺 endDate、null、空 args）→同一场景 | repo:660/662 `local_date_start_utc` Err 需故障注入（TZ），理由同 daily_stats；repo:664-673 是 DB 错误 |
| `pomodoro_list_today` | src/features/pomodoro/api.ts:69 | todo_handlers.rs:1237；repo:577 | list_today.empty、list_today.records_desc_excludes_deleted | 无（无参数，函数体没有业务 Err） | repo:579 `local_day_start_utc` 需 TZ 故障注入；repo:578/581/589 是 DB 错误 |
| `pomodoro_stats_overview` | src/features/learning-today/weeklyReport.ts:88；src/features/todo/api.ts:505 | pomodoro_handlers.rs:117；repo:893 | stats_overview.empty_days_clamp、stats_overview.with_records | 无业务 Err。缺省/null→30，0→1，1000→366。serde（负数、字符串、u32 溢出）→stats_overview.empty_days_clamp | repo:894/897/898 的 `?` 只透传 daily/today/streak 的 DB 错误或 TZ 错误，需故障注入 |
| `pomodoro_today_stats` | src/features/pomodoro/api.ts:65 | todo_handlers.rs:1228；repo:396 | today_stats.empty、today_stats.mixed_records | 无（无参数）。四个标量查询失败时由 `stat_or_warn`（repo:24）降级为 0，不返回 Err | repo:397 DB 错误、repo:398 TZ 错误，需故障注入 |
| `pomodoro_todo_focus_summary` | src/features/todo/api.ts:525 | pomodoro_handlers.rs:132；repo:954 | todo_focus_summary.linked_records、todo_focus_summary.missing_and_soft_deleted | 无业务 Err：任务不存在时 todoTitle=null、计数为 0（repo:950 注释）。serde（缺参数、null）→todo_focus_summary.missing_and_soft_deleted | repo:961/970/1000/1010/1014 是 DB 错误 |
| `pomodoro_create_record` | src/features/pomodoro/api.ts:53 | todo_handlers.rs:1176；repo:157，校验在 repo:48 | create_record.linked_work_completed_recounts、create_record.defaults_and_unvalidated_fields、create_record.soft_deleted_todo_item（其余场景也用它造数据） | repo:50 type 非法（`Work`、空串、`break`、`nap`+非法 status 时先报 type、`nap`+负 duration）；repo:59 status 非法（`abandoned`、`COMPLETED`、空串、非法 status+负 duration）；repo:68 duration<0；repo:74 actualDuration<0（duration、actualDuration 同时为负时先报 duration）→create_record.invalid_enums_and_durations。repo:172-188 INSERT 的 FK 失败（todoItemId 为 `ti_missing0000`、uuid、空串、list id）→create_record.todo_item_fk。serde（缺 input、input=null、缺必填字段、小数、i32 溢出、字符串、type/status/startTime=null、todoItemId 为数字）→create_record.serde_rejects | repo:163/169/195/203 是 DB 错误；repo:206-208 的回滚分支只有 recount 的 SQL 失败才进入，需故障注入；todo_handlers.rs:102 spawn_blocking join 失败（所有命令共用） |

#### 2. 依赖别域的 owner

- todo 域：用 `todo_create_list`、`todo_create_item` 造数据（返回 `id`），读回用 `todo_get_item`（看 `completedPomodoros`），软删用 `todo_delete_item`。它们的语义归 todo 组，本文件只用它们的成功路径。
- 时钟和时区：harness owner。today_stats、list_today、daily_stats、stats_overview（today/streak/daily/weekly），以及 list_range、focus_summary 的按日分桶，全部按服务端写入的 `created_at`（真实当前时刻）和本地时区计算。A/B 必须跑在同一时钟、同一 TZ 下（最好冻结时钟），且不能跨本地午夜，否则不可比对。日期桶、`weekStart`、`createdAt`、`updatedAt`、`deletedAt` 都随时钟变化。

#### 3. B 侧容易写偏的行为

- 错误类型是纯字符串（`map_err(|e| e.to_string())`，todo_handlers.rs:1194、pomodoro_handlers.rs:34），不是 todo_* 那种 `CommandError` envelope。
- 时间窗口、分桶、排序都用服务端 `created_at`，不看客户端传的 `startTime`（repo:405/520/585/669/1004）。所以 `startTime=2020-01-01` 的记录仍算"今天"，也不会落进 `2020-01-01` 的 list_range 区间。
- focus_summary 的 `firstFocusAt`/`lastFocusAt` 是对 `start_time` 字符串做 MIN/MAX（repo:983-984）。非法字符串 `zzz` 会成为 `lastFocusAt`。
- create 不校验 startTime/endTime 的格式和先后，也不校验 `actualDuration <= duration`；`duration=0`、空串 startTime 都能成功（repo:48-79 只校验枚举和非负）。校验顺序是 type → status → duration → actualDuration。
- 枚举区分大小写（repo:15-16）。显式传 `type:null` 是 serde 错误，不会走默认值；默认值只在字段缺省时生效（todo_handlers.rs:1160-1163）。
- `todoItemId` 不存在时报 FK 约束错误（V20260310__add_pomodoro.sql 的 FOREIGN KEY + database.rs:133 `foreign_keys=ON`），空串也算不存在。指向已软删任务时 FK 仍满足，创建成功，但 recount 跳过软删任务（repo:334），`completedPomodoros` 不变。
- 只有 work+completed 且关联任务的记录，在 create/delete 时才重算 `completed_pomodoros` 并发 `todo://changed {source:"user",action:"update",entityIds:[itemId]}`（todo_handlers.rs:1194-1198、pomodoro_handlers.rs:29-41）。delete 一条关联到已软删任务的记录，事件照发，但计数不重算。
- get_record 对缺失或已删记录返回 `null`；delete 对同样的输入返回 NotFound（repo:262）。
- days 的 clamp：daily 默认 7，overview 默认 30，0→1，>366→366（repo:508）。
- weekly 以周一为起点，由 daily 派生；首尾周可能不满 7 天（repo:906-944）。
- today_stats 的 `totalFocusSeconds` 含 interrupted；另有 `completedFocusSeconds`（repo:413-437）。前端类型 src/features/pomodoro/api.ts:33 漏了 `completedFocusSeconds`，B 不能按前端类型裁掉这个字段。
- list_range 用 chrono `%Y-%m-%d` 解析，接受不补零的 `2026-1-1`，拒绝尾随字符和不存在的日期（repo:638-649）。
- PomodoroRecord 序列化时，`todoItemId`、`endTime`、`updatedAt`、`deletedAt` 为空就省略字段（types.rs:1117-1149）；FocusSummary 的 `todoTitle`、`firstFocusAt`、`lastFocusAt` 为空时输出 `null`。
- 列表按 `created_at DESC` 排序（repo:376/586/670）。同一毫秒内创建的多条记录顺序不确定，比对时注意。

#### 4. 统计

- 场景数：23
- 步数：230
- 成功意图步数：170
- error 意图步数：60（其中目标命令的 serde 错误 30 步，业务错误 30 步：create 16、list_range 11、delete 3）

## WP-200：folder 八目标

`folders.v0.json` 的目标仅为 `dstu_folder_get/rename/delete/move/set_expanded/list/get_tree/get_breadcrumbs`；
`dstu_folder_create` 只作准备。全部 `seed:"empty"`、`capture:{events:true,db:["*"]}`、`normalize:[]`。
动态 ID 只引用先前 create 的 `${n.id}`，不固定 ID/时间、不在场景里填写返回值。
`expect:"error"` 是读 Rust 后的输入意图，A 的实际结果仍是判定基准。

实数：**8目标 + 1辅助，21场景、208步**；其中目标167步、create辅助41步；
145步成功意图、63步错误意图（23个参数解码错误、40个业务错误）。这不是分支覆盖率。

| 命令（省略dstu_folder_） | 总步数 | 成功意图 | 错误意图（其中参数错误） |
|---|---:|---:|---:|
| get | 24 | 21 | 3（3） |
| rename | 36 | 8 | 28（5） |
| delete | 13 | 7 | 6（3） |
| move | 22 | 7 | 15（3） |
| set_expanded | 13 | 5 | 8（6） |
| list | 18 | 18 | 0 |
| get_tree | 16 | 16 | 0 |
| get_breadcrumbs | 25 | 22 | 3（3） |
| create（辅助） | 41 | 41 | 0 |

基线 `main 0764800b3`：WP-064/101/109 的历史和代码均已包含，工作树没有遗留 WIP；
`git show main:host/platform/storage/api.ts` 与 `git show main:host/plugins/vfs-repos/types/core.ts` 确认
真实 storage、FolderRepository（create/get/rename/delete/move/setExpanded/list/tree）已发布，
`api.ts:8-14` 重导出，`types/services.ts:93` 为 `vfsRepo.folders`。不依赖 XML/path 工作包。

### 前端、Rust、生产入口与场景

前端统一为 `src/dstu/api/folderApi.ts`；H=`src-tauri/crates/dstu-vfs/src/dstu/folder_handlers.rs`，
R=`src-tauri/crates/dstu-vfs/src/vfs/repos/folder_repo.rs`。
下表场景省略 `vfs.folder.` 前缀；精确调用数由 `check-folders.mjs` 输出。

| 目标 | 前端 invoke | Rust | TS 注册 → handler | 主要场景与分支 |
|---|---|---|---|---|
| get | :99 `{folderId}` | H:233–266；R:378–410 | index.ts:294–297 → src/folders.ts:115 | `read.empty/root_child_tree`；found/None、根和子、缺失/空/root；`delete.cascade_and_repeat` 已软删仍可读 |
| rename | :118 `{folderId,title}` | H:273–327；R:1150–1214 | index.ts:298–301 → src/folders.ts:119 | `rename.readback` 改父/子、同名重复、保留icon/color/expanded；`duplicate_and_literal_titles` 同名及空格原样存储；`validation_order/unicode_bypass/utf8_limits` 空白、控制字符、全部9种Unicode禁字符、斜杠/反斜杠/双点、100/101 ASCII字节及100/102 UTF-8字节；`missing_and_deleted` 初读None与条件更新not-found两条错误 |
| delete | :138 `{folderId}` | H:336–369；R:1230–1321 | index.ts:302–305 → src/folders.ts:130 | `delete.cascade_and_repeat` 子树级联、保留兄弟、再次删除/删已级联叶提前成功、最后删根；`delete.missing` 不存在/空/root |
| move | :165 `{folderId,newParentId:null|string}` | H:382–417；R:2058–2164 | index.ts:306–309 → src/folders.ts:140 | `move.subtree_and_root` 移子树、同父重复、null/省略回根；`invalid_parent_and_precedence` 自己优先、源不存在优先、父不存在、root/空串不转换；`cycle` 子/孙循环；`depth_boundary` 合计9成功、10/11拒绝；`deleted_parent_and_source` 父已删拒绝、源已删仍允许移动 |
| set_expanded | :197 `{folderId,isExpanded}` | H:424–451；R:1990–2013 | index.ts:310–313 → src/folders.ts:150 | `expanded.toggle_and_deleted` false/重复false/true、软删后更新、missing/空串报错；get/list/tree读回 |
| list | :313 `{}` | H:637–663；R:488–522 | index.ts:326 → src/folders.ts:194 | 空库、多根多层、改名/移动/删除后完整列表；排序由原sort_order/created_at产生，无人工排序归一 |
| get_tree | :327 `{}` | H:669–695；R:2867–2906 | index.ts:327 → src/folders.ts:198 | 空树、多根/父子孙、移动子树、删除子树后排除；items为空分支 |
| get_breadcrumbs | :421 `{folderId}` | H:910–976 | index.ts:344–347 → src/folders.ts:245 | 根/三级/十级、改名及移动后路径、已删链仍返回、missing/root/空串返回[] |

`args.*` 另外覆盖六个有参目标的缺字段/null/错误类型；`args.list_tree_unknown_ignored` 覆盖两个无参目标忽略额外键。
这些参数来自真实 wrapper 的键名，缺参/错型是契约边界输入，不冒充 UI 正常操作。
get 的 IPC `null` 与前端 wrapper 自行生成的 NOT_FOUND 不同；本语料录 IPC 原返回。
同理，前端的 `emitDstuFolderChange`/缓存失效/移动后的 `updatePathCacheV2` 不属于这八条后端调用；
H 中八条命令均无 backend emit，仍捕获真实事件序列以检查额外副作用。

### 保留的缺口（未批准例外，未声称不可达）

| 未覆盖的 Rust 分支 | 当前原因 / 所需输入或能力 |
|---|---|
| 全部八目标的 `spawn_blocking` join 错误：H:265/327/368/416/450/662/694/975 | 顺序 v0 无工作线程失败控制；需 X7/F3 故障场景及 A 运行证据 |
| get H:255–260；rename H:304–306/320–322；delete H:358–364；move H:409–412；expanded H:443–446；list H:653–658；tree H:685–690 中数据库故障 | 已有业务错误场景不等于覆盖所有 `?`。连接、prepare/读列、SQL写失败/提交失败需 owner/X3/X7 受控故障种子或注入 |
| breadcrumbs H:923–928连接；:946–949 prepare；:959 query；:960–971 collect | 需要实际阶段故障，不能把统一 `Query failed` 当作三种错误语义证明 |
| rename R:1181–1187 OCC conflict、读取后并发删除 | 令牌由命令内部读取；顺序 steps 没有在读写之间插入另一连接的能力，需并发调度证据 |
| rename R:1192–1207 / move R:2109–2133 缓存写失败、path_cache失败warn后继续；depth R:454/2161 unwrap_or降级 | 需实际SQLite故障；本包未伪造仓储返回或新写SQL |
| delete R:1285–1303 带内容项/各资源实体/树外共享成员级联、失败回滚 | 本包唯一准备命令create只生成folders，未生成资源；既有 folders.test.ts:421–479 有生产集成证据，但不是本v0的A/B场景 |
| tree R:2892 非空items；list/tree的非零sort_order分支；get/list的历史TEXT时间/坏列数据 | 需对应成员/排序命令或X3历史种子，当前empty+create无这些数据 |
| breadcrumbs CTE深度上限11及存量坏环/孤儿 | 当前场景由正常create/move造树，未添加异常历史种子；不据此批准不可达 |

当前 consumer 仍有既有整改点：src/folders.ts 多数入口info/error/warn缺失，repository/folders.ts 除删除委托
L11外仍有本地folders/path_cache读写；breadcrumbs :776–793 把SQL异常统一为 `Query failed`。
L11正式面可用不等于这些路径已完成单写者/线程/日志整改。它们属于既有 R13v-01/03/04，
本包仅记录真实入口观察，未将语料或绿灯作为整改签收。

### 检查与原始记录

在本工作树执行，命令前缀均为 `node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs run --`：

```sh
node host/plugins/vfs/equivalence/check-folders.mjs
node host/plugins/vfs/equivalence/observe-folders.mjs host/plugins/vfs/equivalence/raw/wp200-node
env ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron host/plugins/vfs/equivalence/observe-folders.mjs host/plugins/vfs/equivalence/raw/wp200-electron
```

结构检查复用 X7 `validateScenario`，检查目标/辅助命令、真实契约、跨三个语料文件的ID唯一性、
无前向/错误步骤引用、完整capture、未启用normalize、标题边界字节数。
Host观察复用真实 kernel、storage迁移、notes/vfsRepo/vfsIndex/vfs 插件；X7 `executeScenario` 执行引用，
X3 `snapshotDirectory` 在开始、每步后和结束枚举全部数据库/表（含空表/触发器表），无表白名单。
每场景独立复制已关闭的真实迁移空库模板，不把B迁移模板冒充A种子。
`raw/wp200-{node,electron}/*.json.gz` 是 gzip 无损压缩的实际调用/返回/错误/事件/全DB快照和Host日志；
`summary.json` 是观察计数。重跑必须使用新的输出目录，旧证据不覆盖。
未进行 A1/A2 录制、A/B 比对或 Rust 覆盖率统计；不判定A/C等级或语料充分性。

已完成 jobs（原输出均无 Errors/Unhandled 行）：

| job | 检查 | 结果 |
|---|---|---|
| `20261105203031-9a65fd` | 起点 `npm run typecheck:host` | exit0 |
| `20261105203032-f6f72a` | 起点 `npx vitest run -c vitest.host.config.ts host/plugins/vfs/tests/folders.test.ts` | exit0；30 passed / 0 failed / 0 skipped |
| `20261105203626-a60302` | `check-folders.mjs` | exit0；21场景208步，9命令 |
| `20261105203626-70d31e` | `observe-folders.mjs .../raw/wp200-node` | exit0；21场景意图检查passed / 0 failed / 0 skipped，208实际调用，145 result/63 error |
| `20261105203905-7dc4a5` | Electron内置Node运行同一观察器，`.../raw/wp200-electron` | exit0；21场景意图检查passed / 0 failed / 0 skipped，208实际调用，145 result/63 error；未启动renderer |
| `20261105203905-cb6c8c` | `npm run migration:wiring -- --lane vfs` | exit0；`合计 ported 293，其中所测模块未从 index.ts 接入 0（0.0%）` |

Host观察的 passed 只表示真实调用完成、引用/capture完整且 result/error 与源码意图一致，
不表示已逐值对比 Rust。所有返回值及具体错误字符串仍保留在 raw 中供 A/B 运行器使用。

原始记录抽读：Node `rename.missing_and_deleted` 步0为`资源不存在`，步3为带实际ID的`FOLDER_NOT_FOUND`；
`move.depth_boundary` 步15实际报`depth 10 > max 10`、步16报`depth 11 > max 10`（保留Rust本来的文案）；
`delete.cascade_and_repeat` 步5列表只余根/兄弟，步13列表为空，步9/15仍可读已删链的breadcrumbs。
五份抽读记录均枚举到本次实际创建的5个数据库、事件序列为空；没有将不存在的库伪造为空库。

## WP-064：DSTU 基础 CRUD/列表第一组（历史记录）

本目录是 `board/WAVE0-EQUIVALENCE.md` §3 v0 格式的场景语料，覆盖 DSTU 第一组 14 个前端可达命令。
A 侧（Rust/Tauri）是判定基准；B 侧（Electron Host，`host/plugins/vfs`）按同一场景重放后逐项比对。

- `dstu-crud.json`：14 个命令，231 个场景，685 步。
- `dstu-crud-limits.json`：大载荷边界（256 字节名称、64 KiB metadata、1 MiB content），4 个命令，12 个场景，20 步，约 5 MB。
  单独成文件，便于 runner 按需跳过。

WP-064 历史状态（不含上方 WP-200 的 Host 观察）：**只写了语料，未运行**。`scripts/electron-migration/record/replay.mjs` 读的是旧的 `calls/snapshot` 格式，
不消费 v0 equivalence JSON。B 侧 v0 驱动候选已在 X1 分支 `2cfbeb4e0`（`host/e2e/smoke/b-driver.mjs`，WP-041，尚未进 main），
但它只接受 `seed:"empty"` 与空 `capture.db`（`__fixtures__/scenario-v0.ts:13,22` 对非空 DB 抓取直接报错），本目录场景全部为
`capture.db:["*"]`；真实 A 侧录制及完整 DB/seed 驱动均未交付。因此本目录不代表任何命令达到 C 级。

## 格式约定

- `domain` 都是 `vfs`；场景 id 形如 `vfs.dstu.<命令去掉 dstu_ 前缀>.<用例>`，两个文件合起来全局唯一。
- 所有场景 `seed: "empty"`，`normalize: []`，`capture: {"events": true, "db": ["*"]}`。只读命令也抓 DB 与事件，
  因为 `dstu_get` / `dstu_list` 会回填路径缓存，写命令会发 `dstu:change:<path>` 与 `dstu:change`。
- 步骤只用 `cmd` / `args` / `expect` 三个键。`expect: "error"` 只是注释，表示按 Rust 源码推断这一步返回 Err；
  比对时以 A 侧实际结果为准，不预填期望值。没有标注的步骤不等于断言成功。
- 跨步引用写成 `${n.path}`，`n` 总小于当前步序号。runner 需要支持两点：
  - `${0}`（不带字段路径）表示第 0 步的**整个返回值**。`staged_upload_begin` 直接返回 uploadId 字符串，staged 场景靠它引用。
  - 当参数值整体就是一个引用时，按原类型代入。`dstu_update` 的 `expectedUpdatedAtMs: "${0.updatedAt}"` 必须代入成数字（毫秒），
    代入成字符串会在 serde 阶段失败，变成另一条分支。
- 常用引用：`dstu_create` → `${n.path}` / `${n.id}` / `${n.updatedAt}`；`dstu_folder_create` → `${n.id}`（文件夹路径写成 `/${n.id}`）。
- 不存在的 id 固定为 `note_missing0000`、`fld_missing0000`、`00000000-0000-4000-8000-000000000000`、`<前缀>_missing`。
- 参数形状照抄前端 `src/dstu/api.ts` 与 `src/dstu/factory.ts` 的 `EMPTY_RESOURCE_TEMPLATES`（各类型 createEmpty 模板）；
  serde 边界（缺字段、类型错、u32 越界、未知字段）单独列出，id 里带 `args.`。

### 借用的辅助命令（不在 `commands` 里）

| 命令 | 用途 | 前端形状 | owner | B 侧注册 |
|---|---|---|---|---|
| `dstu_folder_create` | 造文件夹（24 步） | `src/dstu/api/folderApi.ts:77`：`{title, parentId, icon, color}` | L13（本 lane，`folder_handlers.rs:136`） | `host/plugins/vfs/index.ts:284` |
| `staged_upload_begin` | 分块上传开始，返回 uploadId（4 步） | `src/utils/stagedUpload.ts:87`：`{name, totalSize}` | F3 storage（`dstu-storage/src/staged_upload.rs`） | `host/platform/storage/index.ts:421` |
| `staged_upload_append` | 追加分块（4 步） | `src/utils/stagedUpload.ts:97`：Android 的 JSON 体 `{uploadId, offset, data(base64)}` | F3 storage | `host/platform/storage/index.ts:425` |

桌面端 `staged_upload_append` 走原始字节体 + `x-upload-id` / `x-upload-offset` 头（`stagedUpload.ts:101`），v0 步骤无法表达请求头，
所以场景只用 Android JSON 体这条路径。

## 逐命令覆盖

前端位置是 `invoke(...)` 调用行（`src/dstu/api.ts`）；Rust 位置是 `#[tauri::command]` 函数（`src-tauri/crates/dstu-vfs/src/dstu/handlers.rs`）。
“场景”按 id 前缀计；“步数”按调用该命令的步骤计（包括其他场景里拿来造数据或抓最终状态的步骤）：成功步 / `expect: "error"` 步。

| 命令 | 前端 | Rust | 场景（id 前缀） | 步数 成功/错误 |
|---|---|---|---|---|
| `dstu_list` | `:258` | `:172` | `vfs.dstu.list.*` 21 | 80 / 6 |
| `dstu_get` | `:277` | `:468` | `vfs.dstu.get.*` 19 | 61 / 10 |
| `dstu_create` | `:336` | `:727` | `vfs.dstu.create.*` 68（含 limits 10） | 212 / 26 |
| `dstu_update` | `:405` | `:1439` | `vfs.dstu.update.*` 34（含 limits 2） | 10 / 28 |
| `dstu_delete` | `:444` | `:1664` | `vfs.dstu.delete.*` 12 | 48 / 4 |
| `dstu_rename` | `:508` | `:1880` | `vfs.dstu.rename.*` 17 | 15 / 10 |
| `dstu_get_content` | `:627` | `:3290` | `vfs.dstu.get_content.*` 9 | 25 / 11 |
| `dstu_set_favorite` | `:698` | `:4555` | `vfs.dstu.set_favorite.*` 7 | 12 / 11 |
| `dstu_search` | `:609` | `:3270` | `vfs.dstu.search.*` 12 | 27 / 1 |
| `dstu_list_deleted` | `:1013` | `:4858` | `vfs.dstu.list_deleted.*` 6 | 16 / 6 |
| `dstu_restore` | `:956` | `:4235` | `vfs.dstu.restore.*` 9 | 10 / 8 |
| `dstu_purge` | `:985` | `:4460` | `vfs.dstu.purge.*` 8 | 8 / 6 |
| `dstu_delete_many` | `:827` | `:5265` | `vfs.dstu.delete_many.*` 11 | 7 / 5 |
| `dstu_restore_many` | `:860` | `:5428` | `vfs.dstu.restore_many.*` 10 | 4 / 6 |

合计 243 个场景、705 步（含 32 步辅助命令）。

### 路径解析（多数命令共用）

`extract_resource_info`（`handler_utils/path_utils.rs:123`）的分支在 get / delete / rename / get_content / set_favorite / restore / purge 里各覆盖一遍：

- 单段已知前缀（`note_` `tb_` `file_` `tr_` `exam_` `essay_session_` `essay_` `att_` `fld_` `mm_` `res_` `img_`）或 UUID → 直接取 id，不做长度检查（`get.simple_id_len_200`）；
- 前导空格、无前导 `/`、多段路径 `/数学/<id>`（`get.note.forms`、`delete.note.full_path`）；
- 单段未知前缀 `/abc`、根 `/`、空串、纯文件夹路径 `/数学/笔记`、虚拟路径 `/@trash` → `Path must contain a resource ID`（`*.invalid_path`、`get.root_error`、`get.virtual_path_error`）；
- 多段且末段超过 128 字节 → `资源ID长度超限`（`path_parser.rs:103`，`get.id_len_128_ok` / `get.id_len_129_error`）；
- `res_` 前缀推断为 `resources`：单段时 get 返回 null，其他命令走 `invalid_node_type`（`*.resources_prefix_*`）；
  多段时 `path_parser` 的前缀表（`path_types.rs:215`）没有 `res_`，末段被当成文件夹名，报 `Path must contain a resource ID`（`get.multi_segment_res_prefix_error`）；
- `tb_` / `att_` / `img_` 都推断为 `files`（`path_utils.rs:93`）。
- `Cannot infer resource type from ID`（`path_utils.rs:128`、`:147`）按读码判断不可达：单段只放行已知前缀，多段只放行 `path_types.rs:215` 的前缀，两张表都是 `infer_resource_type_from_id` 的子集。

### 分支覆盖

- `create`（`:727-1437`）：
  - 名称长度按 UTF-8 字节计，256 通过 / 257 拒绝，含 85/86 个汉字（255/258 字节）；名称检查先于类型路由（`limit.name_checked_before_type`）；
  - content 1 MiB 通过 / 超 1 字节拒绝、汉字按字节超限；metadata 序列化后 64 KiB 通过 / 65537 拒绝；
  - note：空/空白名称回落 `Untitled`（`:872`）；`metadata.tags` 缺省 / null / 数组 / 非数组 / 含非字符串（`:886-903`）；
    `validate_tags`（`note_repo.rs:375`）数量 100/101、单个 100/101 字符、控制字符；`validate_title` 换行拒绝、Tab 允许；
  - 文件夹定位：`metadata.folderId` 只认 `fld_` 前缀，`root` / 非 `fld_` 忽略，不存在的 `fld_` 与路径里不存在的 `/fld_…`、旧式路径 `/数学/notes` 忽略；
  - textbook 拒绝（`:941`）、folder 类型走 `invalid_node_type`（`:1416`）、retrieval `Unsupported resource type`（`:854`）、
    serde：未知枚举 `video`、复数 `notes`、缺 type / name / options；
  - translation / essay / exam / mindmap：前端模板、空名称默认值、metadata 带 `examName` / `isFavorite` / `qualityRating`、
    mindmap 空内容与非法 JSON 内容、无 metadata 默认主题；
  - image / file：PNG、非法 mime 回落、默认 mime、无扩展名的 mime、相同字节两次（blob 去重）、缺 / 空 / 非法 base64（`:1257`、`:1282`）、无 padding 的 base64；
  - staged：未知 uploadId（`staged_upload.rs:262`）、空 uploadId 回落 base64、完整上传、未传完（`staged_upload.rs:314`）后再用同一 id（第一次失败后是否已被消费）、
    音频走流式、图片走非流式。
- `get`（`:468`）：note 各种路径形式、folder、各类型、各类型 missing → null、UUID 回退查找 missing、回收站里的 note、上面的路径解析错误。
- `list`（`:172`）：
  - 根：无 options / null / `{}`、混合类型、`folderId` 为 `root` / `""` / `"null"`、`__x__` 隐藏名称（根与文件夹两条分支各一个）；
  - 文件夹：排序字段 / 方向（大小写）/ 非法排序字段、limit / offset 分页、`typeFilter`、子文件夹与隐藏系统文件夹、不存在的文件夹报错（有无 typeFilter 各一个）；
  - 智能文件夹（`typeFilter` 不带 folderId）每个类型各一遍（含 textbook / folder / retrieval）、分页与排序、`factory.ts` 去重用的 `limit: 1000`；
  - 收藏（含文件夹与 mindmap）、回收站排除；
  - serde：非法 `typeFilter`、limit 负数 / 超 u32 / u32 最大值、未知 option 字段、缺 path。
- `update`（`:1439-1660`）：
  - note：普通更新、OCC 当前值 / 0 冲突（`:1508`）/ 未来值 / 连续两次后旧值、missing（有无 OCC）、复数 `notes`、
    `lease` 未知 token 拒绝、`lease` 未知字段（`NoteLeaseAuth` deny_unknown_fields）、多段路径；
  - 空路径与 `/`（`:1484`）、textbook / file / images 不支持、未知类型 `folder` / `""`；
  - translation / exam / essay：正常 JSON、非法 JSON、无可更新字段、missing；
  - mindmap：内容更新、OCC 0 冲突（`content_helpers.rs:718`）/ 当前值、missing、非法内容；
  - content 超 1 MiB 先于路径检查（`limit.content_checked_before_path`）；serde：缺 resourceType、`expectedUpdatedAtMs` 为小数。
- `delete`（`:1664`）：note、二次删除、missing（Rust 对 missing 是否报错以 A 侧结果为准，未标注）、多段路径、带子项的文件夹、
  各类型、essay round id、textbook missing、路径错误与 `res_`。
- `rename`（`:1880`）：note / folder / 各类型、note 空白名称与 501 字符拒绝（`validate_title`）、500 字符通过、换行拒绝、
  名称没有 256 字节上限（`long_name_300`）、各类型 missing、文件夹内重命名后列表、serde 缺 newName。
- `get_content`（`:3290`）：note、空 note、各类型、各类型 missing、folder `invalid_node_type`、回收站里的 note、路径错误。
- `set_favorite`（`:4555`）：note 开关往返、各类型（含文件夹）、各类型 missing、`res_` 不支持（`:4825`）、路径错误、serde favorite 为字符串。
- `search`（`:3270`）：标题与内容命中、空查询、options null、前端 limit、每个 typeFilter、`propFilters`（非 note 类型、trim、空 key）、
  文件夹范围与不存在的文件夹、隐藏名称、`%` `_` `'` `"` 特殊字符、回收站排除、serde 缺 query。
- `list_deleted`（`:4858`）：notes 分页（limit/offset 显式、null、0）、exams / translations / essays / textbooks、空库、
  不支持的类型（`mindmaps` `files` 单数 `note` 空串，`:5122`）、limit 负数、缺 resourceType。
- `restore`（`:4235`）：note、文件夹内 note、未删除的 note、missing、带子项的文件夹、各类型、各类型 missing、路径错误。
- `purge`（`:4460`）：回收站中的 note、未删除的 note 拒绝（`delete_helpers.rs:278`）、missing、二次 purge、各类型（含文件夹）、
  essay round missing、路径错误。
- `delete_many`（`:5265`）：空数组 → 0、多个 note、混合类型、重复路径、预解析失败、`res_` 导致整批回滚、含 missing、
  100 个通过 / 101 个拒绝（`:5276`）、101 个且第一个就非法（看数量检查是否先于解析）、serde 缺 paths。
- `restore_many`（`:5428`）：空数组、多个 note、混合类型、路径解析失败回滚（`:5467`）、missing 回滚、`res_` 回滚、未删除成员、
  100 个 missing、101 个拒绝（`:5438`）、serde 缺 paths。

## 未写成场景的分支

| 分支 | 原因 | 需要谁 |
|---|---|---|
| 所有 DB / IO 错误、`spawn_blocking` join 失败、COMMIT 失败、锁中毒 | 前端不可达，需要故障注入 | 不在 v0 范围 |
| base64 图片 > 50 MB / 文件 > 200 MB（`:1212-1213`） | 无法嵌进场景 JSON；走 staged 时由 F3 的上限先拦截 | F3（staged 上限场景） |
| note lease 的成功分支 | 需要先拿到有效 lease，获取 lease 的命令属于 notes 编辑器 owner，本组没有借用 | notes owner / X2 |
| textbook 的 delete / restore / purge 成功分支 | textbook 只能经 `textbooks_add` / `vfs_upload_file` 创建（`:941`），不在本组 | 后续包 |
| `delete_many` / `restore_many` 中途写失败后的回滚 | 只有 DB 错误能在预解析之后触发 | 不在 v0 范围 |
| 空字符串 filestream | 属于 L13b WP-069 | L13b |

## 尚无场景的 DSTU 命令（供 X2 盘点）

> WP-223 更新：下列命令除 `dstu_get_exam_content` 外均已在上方 WP-223 的 `*.g3.json` 中有场景；本节保留为 WP-064 时的历史盘点。

`dstu_set_metadata`（9 个类型分支、60 多个 Err 点，`handlers.rs:3349-4230`，单独成包）、`dstu_move`、`dstu_copy`、`dstu_move_many`、
`dstu_purge_all`、`dstu_search_in_folder`、除上方 WP-200 八目标外的 `dstu_folder_*`（`dstu_folder_create` 只作辅助命令出现）、
`dstu_soft_delete` / `dstu_trash_restore` / `dstu_list_trash` / `dstu_permanently_delete` / `dstu_empty_trash`、
`dstu_watch` / `dstu_unwatch`、`dstu_parse_path` / `dstu_build_path` / `dstu_get_resource_location` / `dstu_get_resource_by_path` /
`dstu_move_to_folder` / `dstu_batch_move` / `dstu_refresh_path_cache` / `dstu_get_path_by_id`、`dstu_export*`、`dstu_get_exam_content`。

## 首次比对时重点看的地方

以下是读 Rust 源码时发现、B 侧容易写偏的行为，没有经过 A/B 运行确认：

- 根目录列表与文件夹列表对 `__x__` 隐藏名称的过滤是否一致（`list.root_hidden_name` 对 `list.folder_subfolders_hidden`）；
- `create` 的名称上限按字节（256），`validate_title` 按字符（500）；`rename` 只有后者，所以 300 字节的名称能改名但不能创建；
- 无 padding 的 base64（`create.file.base64_unpadded`）在 A 侧是否接受；
- `dstu_get` 对 `res_` 返回 null，其他命令对 `res_` 报 `invalid_node_type`；
- 单段未知前缀（`/abc`）与多段 `res_` 报 `Path must contain a resource ID`；
- `extract_resource_info` 丢弃多段路径里的文件夹段，不校验它是否存在，所以 `/数学/<id>` 和 `/<id>` 应得到相同结果（`get.note.forms`）；
- staged 上传失败（`Upload incomplete`）后 uploadId 是否已被消费（`create.file.staged_incomplete` 第二次 create 的报错文本）。

## normalize 候选（未启用）

`normalize` 目前全是 `[]`。首次 A/B 运行后，下列字段大概率需要归一，届时按实际差异再加，不提前猜：

- id：`note_…` `exam_…` `tr_…` `essay_session_…` `mm_…` `file_…` `img_…` `fld_…`、resource id、blob hash 目录；
- 时间：`createdAt` / `updatedAt`（毫秒）、DB 里的 `created_at` / `updated_at` / `deleted_at`、exam 预览里的 `temp_id`；
- 内容相同的 blob hash 在 A/B 两侧应一致，不应归一。

## B 侧已知阻塞

| 阻塞 | 影响的场景 | owner |
|---|---|---|
| 真实 A 侧录制及完整 DB/seed 驱动未交付；X1 `2cfbeb4e0` 的 B v0 候选拒收非空 `capture.db`，未进 main | 全部 | X7 / X3 |
| runner 需要支持 `${0}` 整值引用与按原类型代入 | `create.file.staged_*`、`create.image.staged_not_streamed`、`update.*.occ_current`、`update.note.occ_stale_after_update` | X7 |
| `staged_upload_*` 的 Android JSON 体在 B 侧要按 `{uploadId, offset, data}` 解析 | 4 个 staged 场景 | F3 |

14 个命令与 `dstu_folder_create` 都已在 `host/plugins/vfs/index.ts` 注册。B 侧缺功能的场景照样保留，作为验收输入，不能因为 B 侧还做不到就删掉。
