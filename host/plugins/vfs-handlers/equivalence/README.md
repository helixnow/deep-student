# vfs-handlers 等价场景包 v0（WP-224：todo / VFS 资源 / 索引维度，55 个命令）

格式遵循 `WAVE0-EQUIVALENCE.md` §3 v0：`domain / commands / scenarios[{id, seed:"empty", steps, capture, normalize:[]}]`。

- `domain` 统一为 `"vfs"`，与 `host/plugins/vfs/equivalence/*.json` 一致（命令归属 L13-vfs-api）。同目录的 `filestream.json`（WP-069）保持原样。
- 文件名带 `wp224-` 前缀，避免与 W-L13b 写手 lane 的 `g3-vfs-handlers-<n>.json` 冲突。
- 场景 id：`vfs.<命令>.(ok|err|pending_ok|pending_err)_<情形>`，场景按 id 中的命令归属。
- 跨步引用只用整串 `${n.path}`（n < 当前步序号，且第 n 步不是 `expect:"error"`）。
- `capture` 统一 `{events:true, db:["*"]}`。`normalize` 全部为 `[]`。
- `expect:"error"` 只是注释，标注"预期 A 在此步返回 Err"。期望结果一律以 A（Rust）回放为准，本包不预写返回值。
- "反序列化 Err"指 Tauri 参数反序列化失败（缺必填键、类型错误、负数传给无符号类型）。它是命令入口真实可达的 Err，但不算成功覆盖。

## 文件

| 文件 | 命令数 | 场景数 | 步数 | 可运行 |
|---|---|---|---|---|
| `wp224-todo-lists.json` | 9 | 31 | 91 | 是 |
| `wp224-todo-items.json` | 9 | 59 | 216 | 是 |
| `wp224-todo-queries.json` | 11 | 28 | 149 | 是（dueDate 固定为 2020 / 2099，reminder 固定为 2030 / 2099；today / upcoming 窗口以运行日为准，但成员不随运行日变化） |
| `wp224-vfs-resources.json` | 12 | 58 | 97 | 是 |
| `wp224-vfs-index.json` | 14 | 71 | 157 | 是（`vfs_batch_index_pending` 结果依赖向量索引可用性，见下文） |
| `pending-provider/wp224-download-paper.json` | 1 | 3 | 4 | 否，需要本地 HTTPS mock |

合计 250 个场景：可运行 247 个（成功 121、错误 126），pending 3 个（成功 1、错误 2），覆盖 corpus 清单全部 55 个命令。

## G3 分母 768（D-158）

清单中 23 个命令在 `board/g3/denominator-768.txt` 内（都是 `vfs_*`）。其余 32 个属于 981 外延：29 个 `todo_*`，加上 `vfs_create_mindmap`、`vfs_delete_mindmap`、`vfs_get_batch_pdf_processing_status`。

- 768 内：22 个命令有可运行成功场景。`vfs_download_paper` 只有 pending 成功场景，记为 `blocked`：
  - owner：X5 / X7
  - 解除条件：runner 能按场景启动本地 HTTPS 服务（`https://127.0.0.1:18443/wp224/...`），证书被 A/B 两端信任
  - 复核人：C2-platform
- 981 外延：32 个命令都有可运行成功场景。
- 按 D-158，L13 的错误分支由 W-lane 负责（`g3w-vfs-handlers-*.json`，id 前缀 `g3w.`）。本包已写的 `err_*` 场景保留，此后不再新增。

## 命令表

"成功"指场景内没有 `expect:"error"` 步骤（批量命令把单项失败折叠进返回值、`vfs_get_attachment_content` 超限返回 `Ok{error}` 时，也计为成功）。场景 id 省略 `vfs.<命令>.` 前缀。Rust 列相对 `src-tauri/crates/dstu-vfs/src/vfs/`。

| 命令 | 前端调用点 | Rust | 成功场景 | 错误场景 | 理由 / 分支 |
|---|---|---|---|---|---|
| `todo_get_list` | `src/features/todo/api.ts:155` | `todo_handlers.rs:254` | `ok_existing` `ok_missing_null` `ok_soft_deleted_null` | `err_missing_list_id` | 不存在 / 已软删 → `Ok(null)`；反序列化 Err（缺 `listId`） |
| `todo_list_all_pending` | `src/features/todo/api.ts:293` | `todo_handlers.rs:669` | `ok_cross_list` `ok_empty` | — | 无参数；repo 只有 DB 错误，无可达 Err |
| `todo_list_all_tags` | `src/features/todo/api.ts:464` | `todo_handlers.rs:916` | `ok_counts_excludes_deleted` `ok_empty` | — | 无参数；已删任务不计数；无可达 Err |
| `todo_list_completed` | `src/features/todo/api.ts:302` | `todo_handlers.rs:679` | `ok_by_list_and_all` `ok_empty` | `err_list_id_wrong_type` | `listId` 可选（按清单 / 全部）；反序列化 Err（`listId` 类型错误） |
| `todo_list_deleted_items` | `src/features/todo/api.ts:213` | `todo_handlers.rs:408` | `ok_paged` `ok_empty` | `err_limit_wrong_type` | 分页；反序列化 Err（`limit` 类型错误） |
| `todo_list_deleted_lists` | `src/features/todo/api.ts:193` | `todo_handlers.rs:344` | `ok_paged` `ok_empty` | `err_negative_limit` | 分页；反序列化 Err（负数 `limit`） |
| `todo_list_items` | `src/features/todo/api.ts:237` | `todo_handlers.rs:492` | `ok_pending_vs_all_paged` `ok_unknown_list_empty` | `err_missing_include_completed` | 未知清单 → 空数组；反序列化 Err（缺 `includeCompleted`） |
| `todo_list_items_with_stats` | `src/features/todo/api.ts:550` | `todo_handlers.rs:927` | `ok_child_counts_paged` `ok_unknown_list_empty` | `err_missing_list_id` | 子任务计数；未知清单 → 空数组；反序列化 Err（缺 `listId`） |
| `todo_list_lists` | `src/features/todo/api.ts:159` | `todo_handlers.rs:263` | `ok_empty` `ok_ordered_excludes_deleted` | — | 无参数；按 sort_order，排除已删；无可达 Err |
| `todo_list_overdue` | `src/features/todo/api.ts:279` | `todo_handlers.rs:629` | `ok_pending_vs_completed_paged` | `err_include_completed_wrong_type` | 反序列化 Err（`includeCompleted` 类型错误） |
| `todo_list_reminders` | `src/features/todo/api.ts:288` | `todo_handlers.rs:659` | `ok_pending_with_reminder` `ok_empty` | — | 无参数；只返回待办且有 reminder 的任务；无可达 Err |
| `todo_list_today` | `src/features/todo/api.ts:275` | `todo_handlers.rs:612` | `ok_pending_overdue_paged` `ok_empty` | `err_missing_include_completed` | today 含逾期；反序列化 Err（缺 `includeCompleted`） |
| `todo_list_upcoming` | `src/features/todo/api.ts:283` | `todo_handlers.rs:644` | `ok_window` | `err_days_overflow_panic` `err_days_float` `err_missing_days` | `days` 为 0 / 负数 / 大窗口；`days=9007199254740991` 超出 chrono 0.4.41 `Duration::days` 范围，在 spawn_blocking 中 panic → `Database task failed`（`todo_handlers.rs:89`，dev profile panic=unwind）；反序列化 Err（小数 / 缺 `days`） |
| `todo_move_item` | `src/features/todo/api.ts:267` | `todo_handlers.rs:594` | `ok_with_subtree` `ok_child_detached` `ok_same_list` | `err_item_not_found` `err_target_not_found` `err_target_deleted` `err_legacy_flat_args` | item 不存在（`todo_repo.rs:2407`）、目标清单不存在（:2418）、目标清单已删；子树随移、子任务移出后脱离父任务、同清单移动；旧版平铺参数 → 反序列化 Err |
| `todo_purge_deleted_items` | `src/features/todo/api.ts:221` | `todo_handlers.rs:434` | `ok_purges_all` `ok_zero_no_event` | — | 无参数；清空回收站；0 条时不发事件；无可达 Err |
| `todo_purge_deleted_lists` | `src/features/todo/api.ts:205` | `todo_handlers.rs:382` | `ok_purges_all` `ok_zero_no_event` | — | 无参数；同上；无可达 Err |
| `todo_purge_item` | `src/features/todo/api.ts:217` | `todo_handlers.rs:422` | `ok_with_descendants` | `err_not_in_trash` `err_not_found` | 不在回收站（`todo_repo.rs:3322`）、不存在（:3316）；连同子孙一起清除 |
| `todo_purge_list` | `src/features/todo/api.ts:201` | `todo_handlers.rs:370` | `ok_purge_trashed` | `err_not_in_trash` `err_not_found` | 不在回收站（`todo_repo.rs:3156`）、不存在（:3150） |
| `todo_reorder_items` | `src/features/todo/api.ts:257` | `todo_handlers.rs:576` | `ok_no_occ` `ok_with_occ` `ok_empty_list` | `err_duplicates` `err_not_exact_cover` `err_stale_occ` `err_list_missing_with_occ` `err_list_missing_no_occ` `err_legacy_flat_args` | OCC 冲突（`todo_repo.rs:2307`）、重复 id（:2325）、未精确覆盖（:2339）、清单不存在（:2358，带 / 不带 OCC）；空清单 Ok；旧版平铺参数 → 反序列化 Err |
| `todo_reorder_lists` | `src/features/todo/api.ts:185` | `todo_handlers.rs:328` | `ok_exact_cover` `ok_empty_on_empty_db` | `err_duplicates` `err_not_exact_cover` `err_unknown_id` `err_legacy_flat_args` | 重复 id（`todo_repo.rs:1110`）、未精确覆盖（:1122）、未知 id；空库空数组 Ok；旧版平铺参数 → 反序列化 Err |
| `todo_restore_item` | `src/features/todo/api.ts:209` | `todo_handlers.rs:396` | `ok_restore_deleted` `ok_not_deleted_idempotent` `ok_parent_deleted_becomes_top_level` | `err_list_deleted` `err_not_found` | 不存在（`todo_repo.rs:2188`）、所属清单已删（:2205）；未删除时幂等 Ok；父任务已删 → 恢复为顶层 |
| `todo_restore_list` | `src/features/todo/api.ts:197` | `todo_handlers.rs:358` | `ok_same_batch_items_only` | `err_not_deleted` `err_not_found` | 未删除 / 不存在（`todo_repo.rs:1012`）；只恢复同批删除的任务 |
| `todo_search` | `src/features/todo/api.ts:306` | `todo_handlers.rs:696` | `ok_title_description_paged` `ok_like_wildcards_escaped` | `err_missing_query` | title / description 分页；LIKE 通配符被转义；反序列化 Err（缺 `query`） |
| `todo_stats_overview` | `src/features/todo/api.ts:449` | `todo_handlers.rs:901` | `ok_days_default_and_clamp` `ok_empty` | `err_negative_days` | `days` 缺省与上限截断；反序列化 Err（负数 `days`，u32） |
| `todo_toggle_item` | `src/features/todo/api.ts:249` | `todo_handlers.rs:547` | `ok_toggle_twice` `ok_expected_updated_at_match` | `err_not_found` `err_stale_expected_updated_at` `err_missing_item_id` | 不存在（`todo_repo.rs:1963`）、`expectedUpdatedAt` 过期；反序列化 Err（缺 `itemId`） |
| `todo_toggle_list_favorite` | `src/features/todo/api.ts:171` | `todo_handlers.rs:305` | `ok_toggle_twice` | `err_not_found` `err_soft_deleted` | 不存在（`todo_repo.rs:1055`）、已软删（:1073） |
| `todo_trash_counts` | `src/features/todo/api.ts:424` | `todo_handlers.rs:886` | `ok_items_and_lists` | — | 无参数；无可达 Err |
| `todo_update_item` | `src/features/todo/api.ts:241` | `todo_handlers.rs:508` | `ok_fields_normalized` `ok_complete_then_reopen` `ok_clear_due_date_clears_time` `ok_repeat_complete_spawns_next` `ok_expected_updated_at_match_and_empty` `ok_set_valid_parent` | `err_completed_pomodoros_rejected` `err_not_found` `err_soft_deleted` `err_stale_expected_updated_at` `err_empty_title` `err_invalid_status` `err_invalid_priority` `err_invalid_due_date` `err_invalid_due_time` `err_invalid_reminder` `err_invalid_repeat_json` `err_parent_self` `err_parent_not_found` `err_parent_other_list` `err_parent_cycle` `err_missing_input` | `completedPomodoros` 拒绝（`todo_handlers.rs:514`）；NotFound（`todo_repo.rs:1533`）/ 已删；OCC 冲突（:1550）；空标题（:1564）；status（:321）/ priority（:335）/ dueDate（:61）/ dueTime（:78）/ reminder（:101）/ repeat JSON（:208）校验；父任务为自身（:1614）/ 不存在（:1628）/ 在别的清单（:1634）/ 成环（:1664）；反序列化 Err（缺 `input`）。成功：字段归一、完成后重开、清 dueDate 连带清 dueTime、重复任务完成后生成下一条 |
| `todo_update_list` | `src/features/todo/api.ts:163` | `todo_handlers.rs:272` | `ok_fields` `ok_clear_with_empty_string` | `err_not_found` `err_soft_deleted` `err_missing_input_id` | NotFound（`todo_repo.rs:659/711`）、已软删；空串清字段；反序列化 Err（`input` 缺 `id`） |
| `vfs_assign_dimension_model` | `src/api/vfsUnifiedIndexApi.ts:226` | `handlers.rs:3398` | `ok_text` `ok_syncs_default_model` `ok_multimodal_adopts_default` | `err_config_not_found` `err_invalid_modality` `err_disabled_config` `err_non_embedding_config` `err_reranker_config` `err_protocol_mismatch` `err_dimension_missing` `err_missing_model_name` | `validate_embedding_model_config`（`handlers.rs:3364–3389`）：配置不存在、已禁用、非嵌入模型、重排序模型、协议不匹配；非法 modality；维度不存在（:3436）；反序列化 Err（缺 `modelName`）。成功：同步默认模型、多模态沿用默认 |
| `vfs_batch_index_pending` | `src/api/vfsUnifiedIndexApi.ts:202` | `handlers.rs:3859` | `ok_empty` `ok_pending_without_embedding_config` | `err_negative_batch_size` | 结果依赖 `ensure_vector_index_available`（`handlers.rs:3876`）与 `VECTOR_INDEX_AVAILABLE`，成功场景不标注 expect，以 A 为准；反序列化 Err（负数 `batchSize`） |
| `vfs_cancel_pdf_processing` | `src/api/vfsPdfProcessingApi.ts:164` | `handlers.rs:6533` | `ok_not_running` | `err_bad_prefix` `err_zero_width_unicode` `err_missing_arg` | ID 校验（`handlers.rs:6555` → `validate_id_format` :144）：前缀错误、零宽字符（:150）；未在运行 → Ok；反序列化 Err（缺参） |
| `vfs_clear_default_embedding_dimension` | `src/api/vfsUnifiedIndexApi.ts:332` | `handlers.rs:3817` | `ok_after_set` `ok_unset` | `err_invalid_modality` `err_missing_modality` | 非法 modality（`handlers.rs:3832`）；未设置时也 Ok；反序列化 Err（缺 `modality`） |
| `vfs_clear_media_cache` | `src/api/dataGovernance.ts:1272` | `handlers.rs:6975` | `ok_all_false` `ok_all_true_empty` `ok_all_true_with_files` | `err_params_undefined` `err_partial_params` | `params` 三个布尔全 false / 全 true（空库与有文件）；反序列化 Err（`params` 缺失 / 字段不全） |
| `vfs_clear_resource_ocr` | `src/api/vfsUnifiedIndexApi.ts:389` | `handlers.rs:7783` | `ok_resource_and_linked_file` `ok_missing_resource` | `err_missing_arg` | 资源不存在 → Ok（`handlers.rs:7783`）；连带清关联文件 OCR；反序列化 Err（缺参） |
| `vfs_create_attachment_root_folder` | `src/api/attachmentConfigApi.ts:18` | `handlers.rs:1679` | `ok_create_and_replace` `ok_empty_title` | `err_missing_title` | 新建与替换、空标题 Ok；只有 DB 错误；反序列化 Err（缺 `title`） |
| `vfs_create_dimension` | `src/api/vfsUnifiedIndexApi.ts:252` | `handlers.rs:3495` | `ok_no_model` `ok_with_text_model` `ok_multimodal_adopts_default` `ok_duplicate` `ok_bounds_and_image_alias` | `err_below_min` `err_above_max` `err_invalid_modality_no_model` `err_model_name_without_config` `err_config_not_found` `err_non_embedding_config` `err_protocol_mismatch` `err_image_modality_with_model` `err_missing_dimension` | 范围下限 / 上限（`embedding_dim_repo.rs:244`）；无模型时非法 modality（:151）；有 `modelName` 无配置（`handlers.rs:~3533`）；配置不存在 / 非嵌入 / 协议不匹配；image modality 带模型；反序列化 Err（缺 `dimension`）。成功：重复创建、边界值、image 别名 |
| `vfs_create_mindmap` | `src/features/mindmap/api/mindmapApi.ts:115` | `handlers.rs:5088` | `ok_frontend_shape` `ok_defaults_and_optional` `ok_in_folder` | `err_folder_not_found` `err_missing_title` `err_missing_params` | 文件夹不存在（`mindmap_repo.rs:451`）；反序列化 Err（缺 `title` / `params`）。内容大小上限（`handlers.rs:5101`）需超大 payload，未建场景 |
| `vfs_create_or_reuse` | `src/features/chat/resources/api.ts:147`；`src/services/resourceSyncService.ts:73` | `handlers.rs:300` | `ok_create_then_reuse` `ok_source_and_metadata` `ok_type_case_and_alias` | `err_invalid_type` `err_missing_data` `err_missing_params` | 非法 type（`handlers.rs:313`）；反序列化 Err（缺 `data` / `params`）。成功：创建后复用、sourceId 与 metadata、type 大小写与别名。大小上限（:322）需超大 payload，未建场景 |
| `vfs_debug_index_status` | `src/api/vfsRagApi.ts:406` | `handlers.rs:5472` | `ok_global` `ok_with_resource` | `err_resource_id_wrong_type` | 全局与指定资源；反序列化 Err（`resourceId` 类型错误） |
| `vfs_decrement_ref` | `src/features/chat/resources/api.ts:255` | `handlers.rs:430` | `ok_floor_at_zero` | `err_bad_prefix` `err_zero_width_unicode` `err_missing_resource` `err_missing_arg` | `validate_id_format`：前缀错误（`handlers.rs:158`）、零宽字符（:150）；资源不存在 → QueryReturnedNoRows（`resource_repo.rs:421`）；反序列化 Err（缺参）。成功：引用计数到 0 为止 |
| `vfs_delete_attachment` | `src/features/chat/debug/attachmentPipelineTestPlugin.ts:1225` | `handlers.rs:1964` | `ok_delete_twice_idempotent` | `err_bad_prefix` `err_not_found` `err_missing_arg` | 前缀错误（`handlers.rs:1974`）；不存在 → NotFound（`attachment_repo.rs:2822`）；反序列化 Err（缺参）。成功：删两次 |
| `vfs_delete_dimension` | `src/api/vfsUnifiedIndexApi.ts:271` | `handlers.rs:3581` | `ok_existing` `ok_clears_default` `ok_missing_and_unknown_modality` | `err_missing_modality` | 不存在 / 未知 modality → Ok；删除时清默认；反序列化 Err（缺 `modality`）。"有索引单元时拒绝"（`handlers.rs:3601`）需已索引数据，空库无法构造 |
| `vfs_delete_file` | `src/api/vfsFileApi.ts:112` | `handlers.rs:2750` | `ok_delete_twice_idempotent` | `err_bad_prefix` `err_not_found` `err_missing_arg` | 前缀错误（`handlers.rs:2759`）；不存在 → NotFound（`file_repo.rs` ~990）；反序列化 Err（缺参） |
| `vfs_delete_mindmap` | `src/features/mindmap/api/mindmapApi.ts:146` | `handlers.rs:5302` | `ok_delete_twice_idempotent` | `err_bad_prefix` `err_not_found` `err_missing_arg` | 前缀错误（`handlers.rs:5309`）；不存在 → NotFound（`mindmap_repo.rs:1097`）；反序列化 Err（缺参） |
| `vfs_delete_resource_index` | `src/api/vfsUnifiedIndexApi.ts:154` | `index_handlers.rs:201` | `ok_existing_resource` `ok_missing_resource` | `err_missing_arg` | 资源存在 / 不存在都 Ok；反序列化 Err（缺参） |
| `vfs_diagnose_lance_schema` | `src/api/vfsRagApi.ts:995` | `handlers.rs:6472` | `ok_modalities` `ok_after_dimension` `ok_unknown_modality` | `err_modality_wrong_type` | 各 modality、建维度后、未知 modality；反序列化 Err（`modality` 类型错误） |
| `vfs_download_paper` | `src/features/chat/plugins/blocks/paperSave.tsx:142` | `handlers.rs:7340` | —；pending：`pending_ok_downloaded_pdf` | `err_http_rejected` `err_non_https_scheme` `err_https_connection_refused` `err_missing_title`；pending：`pending_err_http_404` `pending_err_not_pdf` | 非 https（`handlers.rs:7351`）：http、ftp；https 连接被拒（127.0.0.1:9）；反序列化 Err（缺 `title`）。pending：成功下载、HTTP 404（:7368）、非 PDF（:7392） |
| `vfs_get_all_index_status` | `src/api/vfsUnifiedIndexApi.ts:177` | `handlers.rs:4225` | `ok_empty_frontend_defaults` `ok_filters` `ok_folder_filter` | `err_negative_limit` | 空库提前返回（`handlers.rs` ~4247）、过滤条件、folder 过滤；反序列化 Err（负数 `limit`） |
| `vfs_get_attachment` | `src/features/learning-hub/apps/views/ImageContentView.tsx:346` | `handlers.rs:1946` | `ok_att_and_file` `ok_missing_null` `ok_deleted` | `err_bad_prefix_res` `err_bad_prefix_tb` `err_missing_arg` | 前缀校验（`handlers.rs:1957`）：res_、tb_ 不接受；不存在 → `Ok(null)`；已删；反序列化 Err（缺参） |
| `vfs_get_attachment_config` | `src/api/attachmentConfigApi.ts:10` | `handlers.rs:1648` | `ok_unset` `ok_after_upload_default_root` | — | 无参数；未设置 / 上传后自动建默认根目录；只有 DB 错误，无可达 Err |
| `vfs_get_attachment_content` | `src/components/QuestionInlineEditor.tsx:353`；`src/components/practice/paperExport.ts:53`；`src/components/question-types/imageAnswerUpload.ts:225`；`src/components/questionImageLoader.ts:19`；`src/features/learning-hub/apps/views/FileContentView.tsx:536`；`src/features/learning-hub/apps/views/ImageContentView.tsx:267`；`src/features/learning-hub/apps/views/TextbookContentView.tsx:376`；`src/features/learning-hub/apps/views/TextbookContentView.tsx:421`；`src/features/learning-hub/apps/views/saveResourceToDevice.ts:70`；`src/features/learning-hub/components/finder/quickLookPreview.ts:100`；`src/hooks/usePdfLoader.ts:201` | `handlers.rs:1720` | `ok_inline_att` `ok_blob_file` `ok_max_bytes_exceeded_inline` `ok_max_bytes_exceeded_blob` `ok_res_prefix_resolved` `ok_res_prefix_unlinked` `ok_img_prefix_unresolved` `ok_missing_found_false` | `err_bad_prefix` `err_negative_max_bytes` `err_missing_arg` | 前缀错误（`handlers.rs:1732`）；反序列化 Err（负数 `maxBytes` / 缺参）。超出 maxBytes 返回 `Ok{error}`（`attachment_repo.rs:2087`），计为成功。res_ 解析成功与未关联（:1759）、img_ 未解析（:1774）、不存在 found=false |
| `vfs_get_batch_pdf_processing_status` | `src/api/vfsPdfProcessingApi.ts:142` | `handlers.rs:6628` | `ok_empty` `ok_mixed_ids` | `err_missing_arg` | 空数组、混合有效 / 非法 id（非法跳过，`handlers.rs` ~6640）；反序列化 Err（缺参） |
| `vfs_get_blob_base64` | `src/components/QuestionSourceViewer.tsx:149`；`src/features/chat/context/blobApi.ts:118` | `handlers.rs:2858` | `ok_uploaded_image` | `err_blob_missing` `err_missing_arg` | blob 不存在（`handlers.rs:2876/2881`）；反序列化 Err（缺参）。"blob 行在但文件丢失"需要删磁盘文件，无法用场景构造 |
| `vfs_get_default_embedding_dimension` | `src/api/vfsUnifiedIndexApi.ts:318` | `handlers.rs:3763` | `ok_unset` `ok_set` `ok_stale_setting_auto_cleared` | `err_invalid_modality` `err_invalid_setting_value` `err_missing_modality` | 非法 modality（`handlers.rs:3776`）、设置值无法解析（:3787，经 `save_setting` 写入）、维度已不存在时自动清除（:3795）；反序列化 Err（缺 `modality`） |
| 合计 | | | 121（+pending 1） | 126（+pending 2） | |

没有错误场景的 8 个命令（`todo_list_all_pending` `todo_list_all_tags` `todo_list_lists` `todo_list_reminders` `todo_purge_deleted_items` `todo_purge_deleted_lists` `todo_trash_counts` `vfs_get_attachment_config`）都不带参数，handler 只会在 DB 本身出错时返回 Err，seed=empty 下不可达。

## 外部（非本清单）setup 命令

这些命令出现在 `steps` 中，但不列入 `commands`：

| 命令 | 归属 | Rust | 前端调用点 | 用途 |
|---|---|---|---|---|
| `todo_ensure_inbox` | L13-vfs-api（不在 WP-224 清单） | `todo_handlers.rs:318` | `src/features/todo/api.ts:175` | 建默认收件箱（删除默认收件箱被拒，`todo_repo.rs:929`） |
| `todo_create_list` | 同上 | `todo_handlers.rs:232` | `src/features/todo/api.ts:151` | 建清单 |
| `todo_create_item` | 同上 | `todo_handlers.rs:453` | `src/features/todo/api.ts:229` | 建任务（字段校验 `todo_repo.rs:1256` 起） |
| `todo_get_item` | 同上 | `todo_handlers.rs:481` | `src/features/todo/api.ts:233` | 读回任务状态 |
| `todo_delete_list` | 同上 | `todo_handlers.rs:294` | `src/features/todo/api.ts:167` | 软删清单（回收站前置） |
| `todo_delete_item` | 同上 | `todo_handlers.rs:565` | `src/features/todo/api.ts:253` | 软删任务（回收站前置） |
| `vfs_upload_attachment` | 同上 | `handlers.rs:1328` | `src/components/QuestionInlineEditor.tsx:400` | 建 `att_` 附件（文本 < 1MB 内联存储） |
| `vfs_upload_file` | 同上 | `handlers.rs:2108` | `src/api/vfsFileApi.ts:92` | 建 `file_` 文件；image/* 返回 `file.blobHash`。图片取 `host/plugins/media/equivalence/fixtures/pixel.png`（69 字节） |
| `vfs_set_default_embedding_dimension` | 同上 | `handlers.rs:3694` | `src/api/vfsUnifiedIndexApi.ts` | 设默认维度 |
| `save_api_configurations` | L02-llm-manager | `src-tauri/src/commands.rs:2150` | `src/utils/configApi.ts:108` | 嵌入 / 对话 / 重排序 / 禁用模型配置。`baseUrl` 为 `http://127.0.0.1:9/v1`，apiKey 是占位串 |
| `save_setting` | L19（命令）/ F4（设置服务） | `src-tauri/src/cmd/web_search.rs:542` | `src/components/WebSearchAdvancedConfig.tsx:239` | 写入无法解析 / 指向已删维度的默认维度设置 |

## pending 与未覆盖

| 缺口 | 影响 | 归属 |
|---|---|---|
| `vfs_download_paper` 成功下载、HTTP 非 2xx（`handlers.rs:7368`）、非 PDF（:7392） | 放在 `pending-provider/wp224-download-paper.json`，URL 为 `https://127.0.0.1:18443/wp224/...`，需要一个确定性的本地 HTTPS 服务与受信证书。该命令在可运行集中只有错误场景，**成功覆盖记为缺口** | X5 / X7 |
| `vfs_get_attachment_content` 的 img_ 已解析分支（`handlers.rs:1774` 起） | 需要 `questions.images_json` 中带该 img_ id 与 blob hash 的题目，只覆盖了未解析分支 | L14-qbank（题目 seed） |
| `vfs_delete_dimension` 有索引单元时拒绝（`handlers.rs:3601`） | 需要已索引的数据，空库下无法构造 | X3（索引 seed） |
| `vfs_get_blob_base64` blob 行存在但文件丢失 | 需要删除磁盘文件，场景步骤无法构造 | X3 |
| `vfs_create_or_reuse` 大小上限（`handlers.rs:322`）、`vfs_create_mindmap` 大小上限（:5101） | 需要超大 payload，未写入 JSON | — |
| `vfs_batch_index_pending` | 成功路径受 `VECTOR_INDEX_AVAILABLE` 影响，A/B 环境必须一致 | X5 |

## normalize 候选（未生效，`normalize` 仍为 `[]`）

- 主键：todo 清单 / 任务 id、`res_` `att_` `file_` `mm_` 等 VFS id、维度 id。
- 时间戳：`createdAt` `updatedAt` `deletedAt` `completedAt`、重复任务生成的下一条 dueDate 之外的时间字段。
- 错误对象中的 traceId 与时间戳。
- `vfs_get_batch_pdf_processing_status` 返回 HashMap，键顺序不稳定，建议按键排序后比较。
- `vfs_download_paper` 连接失败的错误文本内含 reqwest 描述，建议只比较前缀。
- `todo_list_upcoming` panic 场景的错误文本内含 JoinError 描述，建议只比较 `Database task failed` 前缀。

## G3 错误覆盖：无可达 Err 的命令（WP-265）

以下 15 个命令都在 768 内。C1 扫描（main `84d89e3e8` 和全部 ds-mig 分支）显示它们没有 `expect:"error"` 步骤。逐条核对 Rust 源码后，结论是：在 `seed: "empty"` 下，这些命令都没有可达的业务 Err 或提前返回，所以不新增 `g3w-*.json` 场景。Rust 路径相对 `src-tauri/crates/dstu-vfs/src/vfs/`，`lib.rs` 指 `src-tauri/src/lib.rs`，行号以 main `84d89e3e8` 为准。

适用于全部 15 个命令的前提：

- 没有参数错误。前端调用点都是不带参数的 `invoke('<cmd>')`（见下表）。Rust 签名只有 `State<..>` 或 `AppHandle`，没有可反序列化的参数。Tauri 按参数名取值，多传的键会被忽略，所以不存在反序列化 Err。
- 只在恢复模式下出现 State 错误，空种子下不可达。`Arc<VfsDatabase>` 在 `build_app_state` 里 `manage`（`lib.rs:3510`；初始化失败直接 panic，`lib.rs:3506-3509`）。`Arc<LLMManager>` 在 `lib.rs:3533` 注册，`Arc<VfsLanceStore>` 在 `lib.rs:3520` 注册。`VfsLanceStore::new` 只有在 `create_dir_all` 出现 IO 失败时才走降级分支、不注册（`lance_store.rs:269-287`，`lib.rs:3523-3526`）。`build_app_state` 在 setup 的 `lib.rs:1321` 调用。setup 进入恢复启动模式时，会在这之前 `return Ok(())`（`lib.rs:959/972/986/1043/1053/1062/1317`），此时命令返回 `state not managed`。两个 pomodoro 命令在 `spawn_blocking` 里调用 `app.state()`，未注册时会 panic，panic 再变成 JoinError，最后返回 `Database task failed: ..`（`todo_handlers.rs:95-102`）。`seed: "empty"` 不会进入恢复模式，与 WP-246（`openai_codex_auth_status`）属同一种情形。等 X3 提供能触发恢复模式的种子后，可以在那个种子上为这些命令各补一步 `expect:"error"`。
- 下表"只有 DB/IO 错误"指的是：连接获取（`get_conn` / `get_conn_safe`）、SQL prepare/query/execute、行解码、Lance 存储 IO。按 brief，这些都判为不可达。

| 命令 | 前端调用点 | Rust | 判定（文件:行，原因） |
|---|---|---|---|
| `pomodoro_list_today` | `src/features/pomodoro/api.ts:69` | `todo_handlers.rs:1237` | 无可达 Err。`repos/pomodoro_repo.rs:577-591`：连接获取、prepare 和 query_map 只会出 DB 错误；行解码错误被 `log_and_skip_err` 吞掉并跳过（`:38-46`）。`local_day_start_utc`（`:387-389`）调用 `local_date_start_utc`（`:604-623`）。只有本地午夜既不存在，往后 1–3 小时也都不存在时，后者才返回 `InvalidArgument`。要触发它，本地时区在今天午夜附近必须连续缺失 4 小时以上。当前 tz 规则下跳变最多 1 小时，所以这个分支不可达 |
| `pomodoro_today_stats` | `src/features/pomodoro/api.ts:65` | `todo_handlers.rs:1228` | 无可达 Err。`repos/pomodoro_repo.rs:396-457`：只有 `get_conn_safe` 和 `local_day_start_utc` 两处用了 `?`（后者同上，不可达）。四条统计 SQL 都经 `stat_or_warn`（`:24-36`），失败时记 error 日志后返回 0，不会传成 Err |
| `vfs_get_attachment_config` | `src/api/attachmentConfigApi.ts:10` | `handlers.rs:1648` | 无可达 Err。`attachment_config.rs:38-48`：配置查询用 `.ok()` 吞掉错误，空串按 None 处理，只有连接获取会失败。`get_root_folder_title`（`:119-126`）读 `repos/folder_repo.rs:370-409`，文件夹不存在时 `.optional()` 返回 `Ok(None)`，只有 DB 或行解码错误会失败 |
| `vfs_get_dimension_range` | `src/api/vfsUnifiedIndexApi.ts:284` | `handlers.rs:3675` | 无 Err。函数体只有 `Ok((MIN_DIMENSION, MAX_DIMENSION))`（`handlers.rs:3676-3681`），没有 State、没有 `?`，不受恢复模式影响 |
| `vfs_get_embedding_readiness` | `src/features/learning-hub/embeddingReadiness.ts:33` | `handlers.rs:4198` | 无可达 Err。`handlers.rs:4199-4222`：`get_embedding_model_config()` 的 Err 被 `match` 折叠成 `Ok{ready:false, reason}`，函数体没有 `?`。未配置嵌入模型属于成功结果 |
| `vfs_get_media_cache_stats` | `src/api/dataGovernance.ts:1262` | `handlers.rs:6813` | 无可达 Err。`handlers.rs:6814-6942`：用 `?` 的只有 `get_conn_safe`（`:6819`）、preview_json 的 prepare 和 query_map（`:6827-6837`），都是 DB 错误。行错误被 `rows.flatten()` 跳过（`:6839`），JSON 解析失败被 `if let Ok` 跳过。其余查询全部 `unwrap_or(..)`（`:6851/6872/6888/6918`），目录统计也是 `unwrap_or(0)`（`:6906`） |
| `vfs_get_preset_dimensions` | `src/api/vfsUnifiedIndexApi.ts:279` | `handlers.rs:3670` | 无 Err。函数体只有 `Ok(PRESET_DIMENSIONS.to_vec())`（`handlers.rs:3671-3673`），没有 State、没有 `?`，不受恢复模式影响 |
| `vfs_inspect_retrieval_capabilities` | `src/api/vfsRagApi.ts:816` | `handlers.rs:6354` | 无可达 Err。`unified_retriever.rs:222-225` 用 `repair_profiles=false` 调用 `capability_snapshot_inner`（`:433-538`），所以跳过 Lance 修复块（`:441-469`）。剩下只有 `get_conn_safe` 和 `list_active_profiles`（`repos/embedding_dim_repo.rs:868-899`）两处用了 `?`，属于 DB/行解码错误。LLM 配置的三次读取都用 `unwrap_or_default()`（`:474/484/489`） |
| `vfs_list_dimensions` | `src/api/vfsUnifiedIndexApi.ts:210` | `handlers.rs:3329` | 无可达 Err。`handlers.rs:3330-3350`：只有 `get_conn` 和 `embedding_dim_repo::list_all`（`repos/embedding_dim_repo.rs:686-692`，SQL 加 `row_to_dim` `:75-96` 的行解码）两处可能失败，都是 DB 错误 |
| `vfs_list_embedding_dims` | `src/api/vfsUnifiedIndexApi.ts:161` | `index_handlers.rs:287` | 无可达 Err。`index_handlers.rs:288-301` 调用 `VfsIndexService::list_dimensions`（`index_service.rs:473-476`），失败点只有 `get_conn` 和同一个 `list_all`，都是 DB 错误 |
| `vfs_multimodal_stats` | `src/api/vfsRagApi.ts:832` | `handlers.rs:6372` | 无可达 Err。`handlers.rs:6373-6391` 调用 `VfsMultimodalService::get_stats`（`multimodal_service.rs:1249-1264`），失败点只有 `get_conn` 和 `list_by_modality`（`repos/embedding_dim_repo.rs:695-705`），都是 DB 错误 |
| `vfs_reset_all_index_state` | `src/api/vfsRagApi.ts:464` | `handlers.rs:5922` | 无可达 Err。`handlers.rs:5923-6021`：两次 `lance_store.clear_all`（`:5933/5940`），之后是连接获取和 6 条无参 DELETE/UPDATE SQL，没有业务校验。启用 `lance` 时，`clear_all`（`lance_store.rs:2597-2642`）的 Err 只来自 LanceDB 连接、枚举、打开、delete、count_rows 失败。"清空后仍残留"检查（`:2626-2631`）在 `VFS_MUTATION_LOCK` 写锁下执行，`delete("true")` 成功后只有存储故障才会触发。未启用 `lance` 时，stub 直接返回 `Ok(0)`（`lance_store_stub.rs:211-213`） |
| `vfs_reset_disabled_to_pending` | `src/api/vfsRagApi.ts:426` | `handlers.rs:5859` | 无可达 Err。`handlers.rs:5860-5882`：只有连接获取和一条无参 UPDATE。没有匹配行时返回 `Ok(0)` |
| `vfs_reset_indexed_without_embeddings` | `src/api/vfsRagApi.ts:444` | `handlers.rs:5885` | 无可达 Err。`handlers.rs:5886-5916`：只有连接获取和一条无参 UPDATE（带 NOT EXISTS 子查询）。没有匹配行时返回 `Ok(0)` |
| `vfs_unified_index_status` | `src/api/vfsUnifiedIndexApi.ts:92` | `index_handlers.rs:18` | 无可达 Err。`index_handlers.rs:19-24` 调用 `get_status_summary`（`index_service.rs:192-222`），失败点只有 `get_conn`、`index_unit_repo::get_stats`（`repos/index_unit_repo.rs:603-`，未知状态值走 `_ => {}`，不报错）和 `get_modality_dim_stats`（`repos/index_segment_repo.rs:666-682`），都是 DB 错误 |
