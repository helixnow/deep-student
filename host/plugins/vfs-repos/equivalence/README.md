# WP-225 等价语料：L13 vfs_* 命令 54 条（L11 协写，D-059）

本目录只放 WAVE0 v0 场景（`board/WAVE0-EQUIVALENCE.md` §3），不含实现。命令归 L13-vfs-api，JSON 的 `domain` 写 `vfs`，`commands` 只列 WP-225 清单内命令。
`expect:"error"` 是读 Rust 后的输入意图，比对以 A（Tauri+Rust）实际结果为准；场景里不写期望值。

**状态：未运行 A/B replay，未计 C。**

| 文件 | 命令 | 场景 | 步骤 |
|---|---:|---:|---:|
| `resources-refs.json` | 10 | 36 | 142 |
| `files-attachments-pdf.json` | 10 | 29 | 141 |
| `mindmaps.json` | 9 | 17 | 118 |
| `index-dimensions.json` | 15 | 29 | 167 |
| `rag-multimodal.json` | 10 | 28 | 164 |
| 合计 | 54 | 139 | 732 |

全部场景 `seed:"empty"`、`capture:{events:true,db:["*"]}`、`normalize:[]`（读命令也捕获，便于发现额外副作用）。
动态 ID 只经 `${n.path}` 引用更早的成功步骤（如 `${0.resourceId}`、`${0.attachment.resourceId}`、`${2.0.versionId}`），不固定 ID/时间。

## 检查

```sh
node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs run -- node host/plugins/vfs-repos/equivalence/check-corpus.mjs
```

`check-corpus.mjs` 调用 `scripts/electron-migration/record/scenario-v0.mjs` 的 `validateScenario`，并检查：顶层/场景/步骤键严格、id 全局唯一、
引用只指向更早且非 `expect:error` 的步骤、引用占满整个值、`commands` 属于清单且无重复、每条声明命令都被调用、54 条命令各有至少 1 个成功意图步骤。
它不判定分支是否真的命中，那要看 A 端录制和 Rust 覆盖率。

## 准备命令（清单外，前端真实可达；只用于建前置状态和读回）

| 命令 | owner | 前端 | Rust |
|---|---|---|---|
| `vfs_create_or_reuse` | L13-vfs-api | `src/features/chat/resources/api.ts:148` | `dstu-vfs/src/vfs/handlers.rs:301` |
| `vfs_upload_file` | L13-vfs-api | `src/api/vfsFileApi.ts:92` | `dstu-vfs/src/vfs/handlers.rs:2108` |
| `vfs_create_mindmap` / `vfs_delete_mindmap` | L13-vfs-api | `src/features/mindmap/api/mindmapApi.ts:115` / `:146` | `handlers.rs:5089` / `:5303` |
| `vfs_get_attachment_config` | L13-vfs-api | `src/api/attachmentConfigApi.ts:10` | `handlers.rs:1649` |
| `vfs_create_dimension` | L13-vfs-api | `src/api/vfsUnifiedIndexApi.ts:252` | `handlers.rs:3496` |
| `vfs_get_default_embedding_dimension` | L13-vfs-api | `src/api/vfsUnifiedIndexApi.ts:318` | `handlers.rs:3764` |
| `dstu_create` / `dstu_delete` | L13-vfs-api | `src/dstu/api.ts:336` / `:444` | `dstu-vfs/src/dstu/handlers.rs:727` / `:1664` |
| `dstu_folder_create` / `_rename` / `_delete` / `_add_item` / `_get_items` | L13-vfs-api | `src/dstu/api/folderApi.ts:77/118/138/222/341` | `dstu-vfs/src/dstu/folder_handlers.rs:136/274/337/471/705` |
| `staged_upload_begin` / `staged_upload_append` | F3-storage | `src/utils/stagedUpload.ts:87` / `:97` | `dstu-storage/src/staged_upload.rs:447` / `:462` |
| `save_api_configurations` / `save_model_assignments` | L02-llm-manager | `src/utils/configApi.ts:108` / `:163` | `src-tauri/src/commands.rs:2150` / `:2183` |

外层准备命令自身的错误分支归各自 owner 的语料包，本包不覆盖。

## 依赖模拟服务的场景（15 个）

这些场景用 `save_api_configurations` 配置 `w0-vfs-embedding`（文本嵌入）/`w0-vfs-vl-embedding`（多模态嵌入），
`baseUrl:"${llm.baseUrl}"`、`apiKey:"w0-local-mock-key"`（`is_usable_text_embedding`，`dstu-llm/src/llm_manager/rag_extension.rs:141`，只对 builtin 要求 key），
再用 `save_model_assignments` 绑定 `embedding_model_config_id`/`vl_embedding_model_config_id`，与 `host/plugins/chatanki/equivalence/` 写法一致。

| 依赖 | owner |
|---|---|
| 确定性的 OpenAI 兼容嵌入端点（文本 + 多模态） | X5 |
| runner 把 `${llm.baseUrl}` 替换成模拟地址；现行 `resolveReferences`（`scenario-v0.mjs`）遇到非 `${n}` 的 `${` 会抛错，未实现前这 15 个场景无法执行 | X7 / X1 |

场景：`vfs.index.batch.pending_with_mock_embedding`、`vfs.index.dims.bound_model`、`vfs.index.set_default.bound_model`、`vfs.index.readiness.unconfigured_and_configured`、`vfs.index.reindex_resource.with_mock_embedding`、`vfs.index.reset.indexed_with_mock_embedding`、`vfs.rag.search.indexed_note_with_mock_embedding`、`vfs.rag.search.empty_index_with_mock_embedding`、`vfs.rag.lance_stats.after_index`、`vfs.rag.mm_index.with_mock_vl`、`vfs.rag.mm_search.with_mock_vl_index`、`vfs.rag.mm_search_detailed.with_mock_vl_index`、`vfs.rag.capabilities.unconfigured_and_configured`、`vfs.rag.mm_delete.after_mock_index`、`vfs.rag.mm_index_resource.image_and_pdf_with_mock_vl`。

只靠这些场景才有成功意图步骤的命令是 `vfs_reindex_resource`、`vfs_rag_search`：Rust 的 Ok 路径需要可用的嵌入模型。
它们的错误分支（前缀、空查询、非法 modality、未配置模型）都有不依赖模拟服务的场景。`vfs_get_embedding_readiness`、`vfs_inspect_retrieval_capabilities` 另有无模拟依赖的成功场景。

## 逐命令覆盖表

场景列省略 `vfs.` 前缀。H = `src-tauri/crates/dstu-vfs/src/vfs/handlers.rs`，其余路径相对 `src-tauri/crates/dstu-vfs/src/vfs/`。
“错误/早退场景”含参数反序列化错误（缺参、错型、u32 负数等契约边界），它们不计为业务分支覆盖。

| 命令 | 文件 | 前端 invoke | Rust | 成功场景 | 错误/早退场景 | 覆盖的错误分支 | 未覆盖 / 理由 |
|---|---|---|---|---|---|---|---|
| `vfs_get_dimension_range` | index-dimensions | `src/api/vfsUnifiedIndexApi.ts:284` | `handlers.rs:3675` | index.presets_and_range | — | 无 Err 分支 | 常量返回 |
| `vfs_get_embedding_readiness` | index-dimensions | `src/features/learning-hub/embeddingReadiness.ts:33` | `handlers.rs:4198` | index.set_default.bound_model<br>index.readiness.unconfigured_only<br>index.readiness.unconfigured_and_configured | — | 无 Err；ready=false 分支（未配置）与 ready=true（配置后） | ready=true 依赖 rag_extension.rs:169 的回退链，模拟配置需 apiKey 非空 |
| `vfs_get_file` | files-attachments-pdf | `src/api/vfsFileApi.ts:96` | `handlers.rs:2714` | file.get_file.uploaded_text_and_pdf<br>file.get_file.missing_returns_null | file.get_file.invalid_prefix | H:2722 非 file_/tb_ 前缀（含 att_） | — |
| `vfs_get_file_content` | files-attachments-pdf | `src/api/vfsFileApi.ts:116` | `handlers.rs:2782` | file.get_file.uploaded_text_and_pdf<br>file.get_file.missing_returns_null | file.get_file.invalid_prefix | H:2792 前缀；早退 found=false（缺失） | blob 文件读失败（H:2812 std::fs::read）需删 blob 的故障 seed |
| `vfs_get_lance_stats` | rag-multimodal | `src/api/vfsRagApi.ts:209` | `handlers.rs:4970` | rag.lance_stats.modalities<br>rag.lance_stats.after_index<br>rag.mm_index.with_mock_vl | rag.lance.args_decode | 无输入可触发 Err（打不开的表静默跳过） | connect 失败需故障注入 |
| `vfs_get_media_cache_stats` | files-attachments-pdf | `src/api/dataGovernance.ts:1262` | `handlers.rs:6813` | file.media_cache_stats.empty_and_populated | — | 无输入可触发 Err | prepare/读 blob 失败需故障注入 |
| `vfs_get_mindmap` | mindmaps | `src/features/mindmap/api/mindmapApi.ts:122` | `handlers.rs:5115` | mindmap.get.created_full_and_defaults<br>mindmap.get.missing_and_deleted<br>mindmap.update.content_title_and_meta<br>mindmap.restore.old_version_and_same_content<br>mindmap.favorite.toggle_and_repeat | mindmap.get.invalid_id | H:5125 前缀；软删后返回 None | — |
| `vfs_get_mindmap_content` | mindmaps | `src/features/mindmap/api/mindmapApi.ts:129` | `handlers.rs:5134` | mindmap.get.created_full_and_defaults<br>mindmap.get.missing_and_deleted<br>mindmap.update.content_title_and_meta<br>mindmap.restore.old_version_and_same_content | mindmap.get.invalid_id | H:5144 前缀；缺失/软删 None | — |
| `vfs_get_mindmap_version` | mindmaps | `src/features/mindmap/api/mindmapApi.ts:201` | `handlers.rs:5231` | mindmap.versions.list_get_content_limits<br>mindmap.versions.missing | mindmap.versions.invalid_id | H:5241 前缀；缺失 None | — |
| `vfs_get_mindmap_version_content` | mindmaps | `src/features/mindmap/api/mindmapApi.ts:208` | `handlers.rs:5209` | mindmap.versions.list_get_content_limits<br>mindmap.versions.missing | mindmap.versions.invalid_id | H:5222 前缀；缺失 None | — |
| `vfs_get_mindmap_versions` | mindmaps | `src/features/mindmap/api/mindmapApi.ts:194` | `handlers.rs:5155` | mindmap.update.content_title_and_meta<br>mindmap.update.version_source_variants<br>mindmap.versions.list_get_content_limits<br>mindmap.versions.missing<br>mindmap.restore.old_version_and_same_content<br>mindmap.restore.deleted_mindmap | mindmap.versions.invalid_id | H:5170 前缀；limit clamp(1,500) 的 0/超大/缺省 | — |
| `vfs_get_pdf_page_image` | files-attachments-pdf | `src/api/vfsRagApi.ts:945` | `handlers.rs:3105` | file.pdf_page_image.attachment_pdf<br>file.pdf_page_image.uploaded_file_pdf | file.pdf_page_image.attachment_pdf<br>file.pdf_page_image.no_preview_and_missing<br>file.pdf_page_image.args_decode | H:2965 资源不存在；H:2998 无预渲染；H:3038 页码越界 | exam_sheets 分支 H:3003-3022 需 L14 题目集 seed；blob 缺失 H:3062-3085 需故障 seed |
| `vfs_get_pdf_processing_status` | files-attachments-pdf | `src/api/vfsPdfProcessingApi.ts:123` | `handlers.rs:6504` | file.upload_attachment.image_with_front_shape<br>file.upload_attachment.pdf<br>file.processing_status.prefixes_and_missing<br>file.retry.after_upload<br>file.retry.text_file_without_status<br>file.start.pdf_and_image<br>file.start.explicit_stages | file.processing_status.invalid_id | H:6518 前缀/Unicode | — |
| `vfs_get_preset_dimensions` | index-dimensions | `src/api/vfsUnifiedIndexApi.ts:279` | `handlers.rs:3670` | index.presets_and_range | — | 无 Err 分支 | 常量返回 |
| `vfs_get_resource` | resources-refs | `src/features/chat/pages/useChatPageEvents.ts:419` | `handlers.rs:355` | res.get_resource.created_and_reused<br>res.get_resource.dstu_note_and_metadata<br>res.get_resource.missing_returns_null<br>res.increment_ref.twice_then_read | res.get_resource.invalid_id<br>res.get_resource.args_decode | H:363 前缀/Unicode 校验（validate_id_format :144-165） | Ok(None) 缺失分支已覆盖；DB 错误不可由输入触发 |
| `vfs_get_resource_ocr_info` | resources-refs | `src/api/vfsUnifiedIndexApi.ts:379` | `handlers.rs:7621` | res.ocr_info.note_and_image<br>res.ocr_info.uploaded_text_attachment | res.ocr_info.missing | H:7639 资源不存在 | activeSource=ocr/extracted 分支需 OCR 已完成的附件（X5 OCR 模拟或 L18 seed） |
| `vfs_get_resource_path` | resources-refs | `src/features/chat/context/vfsRefApi.ts:180` | `handlers.rs:1043` | res.path.root_note_and_cache<br>res.path.nested_folder_note<br>res.path.not_in_folder_items<br>res.path_cache.rename_then_refresh | res.path.args_decode | 早退：H:1076 缓存命中、H:1099 不在 folder_items 返回 /标题（note/tb/exam/tr/essay/未知前缀，H:1252 起） | H:1068/1092/1112 SQL 失败需故障注入；>1000 字符不缓存分支（H:1107 else）需超长路径，未写 |
| `vfs_get_resource_ref_count` | resources-refs | `src/features/chat/context/vfsRefApi.ts:538` | `ref_handlers.rs:243` | res.ref_count.note_after_increment<br>res.ref_count.resource_source_id_path<br>res.ref_count.deleted_note | res.ref_count.args_decode | essay_session_ 分支、类型前缀分支、resources.source_id 分支（unwrap_or(0) 吞错） | 仅 :293 Query failed 可 Err，需故障注入 |
| `vfs_get_resource_refs` | resources-refs | `src/features/chat/context/vfsRefApi.ts:158` | `ref_handlers.rs:52` | res.refs.notes_and_missing<br>res.refs.folder_contents_and_truncation<br>res.refs.empty_and_missing_folder<br>res.resolve.note_ref_from_get_refs | res.refs.args_decode | 无 Err 返回；截断/maxItems 上限 50（ref_handlers.rs:32）/文件夹展开/缺失 warn 后继续分支 | get_conn_safe 失败需故障注入 |
| `vfs_get_resource_text_chunks` | resources-refs | `src/api/vfsUnifiedIndexApi.ts:397` | `handlers.rs:7860` | res.text_chunks.note_after_sync<br>res.text_chunks.missing_and_empty | res.text_chunks.missing_and_empty | 无输入可触发 Err | Prepare/Query/Row mapping 失败需故障注入 |
| `vfs_get_resource_units` | index-dimensions | `src/api/vfsUnifiedIndexApi.ts:99` | `index_handlers.rs:27` | index.units.empty_then_synced<br>index.sync.note_resync_and_empty<br>index.reindex_unit.modes<br>index.reindex_unit.image_unit_mm<br>index.batch.pending_without_embedding_model<br>index.batch.pending_with_mock_embedding<br>index.reindex_resource.without_embedding_model<br>index.reindex_resource.with_mock_embedding<br>index.reset.populated_after_batch<br>index.reset.indexed_with_mock_embedding | index.units.args_decode | 无输入可触发 Err | — |
| `vfs_increment_ref` | resources-refs | `src/features/chat/resources/api.ts:242` | `handlers.rs:404` | res.increment_ref.twice_then_read<br>res.ref_count.note_after_increment<br>res.ref_count.resource_source_id_path<br>res.ref_count.deleted_note | res.increment_ref.errors | H:412 前缀/Unicode；resource_repo.rs:393 不存在时 query_row 无行 | — |
| `vfs_inspect_retrieval_capabilities` | rag-multimodal | `src/api/vfsRagApi.ts:816` | `handlers.rs:6354` | rag.capabilities.unconfigured_with_dims<br>rag.capabilities.unconfigured_and_configured | — | 无输入可触发 Err；未配置/仅文本/文本+多模态三种能力快照 | — |
| `vfs_list_dimensions` | index-dimensions | `src/api/vfsUnifiedIndexApi.ts:210` | `handlers.rs:3329` | index.dims.empty_and_created<br>index.dims.bound_model | — | 无输入可触发 Err | — |
| `vfs_list_embedding_dims` | index-dimensions | `src/api/vfsUnifiedIndexApi.ts:161` | `index_handlers.rs:287` | index.batch.pending_with_mock_embedding<br>index.dims.empty_and_created<br>index.dims.bound_model<br>index.reset.populated_after_batch<br>index.reset.indexed_with_mock_embedding | — | 无输入可触发 Err | — |
| `vfs_list_files` | files-attachments-pdf | `src/api/vfsFileApi.ts:104` | `handlers.rs:2728` | file.list_files.empty_and_paging | file.list_files.args_decode | 无业务 Err；fileType 有/无两路、limit/offset 默认与边界 | u32 越界为参数解码错误 |
| `vfs_list_mindmaps` | mindmaps | `src/features/mindmap/api/mindmapApi.ts:153` | `handlers.rs:5321` | mindmap.list.empty_multiple_and_deleted<br>mindmap.list.in_folder | — | 无输入可触发 Err | — |
| `vfs_multimodal_delete` | rag-multimodal | `src/api/vfsRagApi.ts:850` | `handlers.rs:6395` | rag.mm_delete.missing_and_unindexed<br>rag.mm_delete.after_mock_index | rag.mm_delete.args_decode | 无输入可触发 Err（缺失资源走清理空集） | Lance 删除失败需故障 |
| `vfs_multimodal_index` | rag-multimodal | `src/api/vfsRagApi.ts:724` | `handlers.rs:6080` | rag.mm_index.empty_pages<br>rag.mm_index.with_mock_vl<br>rag.mm_search.with_mock_vl_index<br>rag.mm_search_detailed.with_mock_vl_index<br>rag.mm_delete.after_mock_index | rag.mm_index.not_configured<br>rag.mm_index.args_decode | 空 pages 早退（multimodal_service.rs:272）；未配置多模态 :299；坏 base64/缺图页进 failed_pages | 成功写入依赖 X5 VL 嵌入模拟 |
| `vfs_multimodal_index_resource` | rag-multimodal | `src/api/vfsRagApi.ts:894` | `handlers.rs:6419` | rag.mm_index_resource.text_attachment_no_pages<br>rag.mm_index_resource.image_and_pdf_with_mock_vl | rag.mm_index_resource.image_not_configured<br>rag.mm_index_resource.missing_and_unsupported | multimodal_service.rs:1371 资源不存在/不支持 source_type；:1456 无页面早退并标 disabled；:299 未配置 | textbook/exam 带 preview 的成功路径需 L18/L14 seed + X5 VL 模拟 |
| `vfs_multimodal_search` | rag-multimodal | `src/api/vfsRagApi.ts:785` | `handlers.rs:6295` | rag.mm_search.without_vl_model<br>rag.mm_search.with_mock_vl_index | rag.mm_search.query_resolution_errors | H:6210/6213/6218/6219 查询解析四种 Err；queryMode 非法枚举为解码错误 | 非空命中依赖 X5 VL 模拟 |
| `vfs_multimodal_search_detailed` | rag-multimodal | `src/api/vfsRagApi.ts:804` | `handlers.rs:6337` | rag.mm_search_detailed.without_vl_model<br>rag.mm_search_detailed.with_mock_vl_index | rag.mm_search_detailed.query_resolution_errors | 同 vfs_multimodal_search（共用 run_vfs_multimodal_search） | 同上 |
| `vfs_multimodal_stats` | rag-multimodal | `src/api/vfsRagApi.ts:832` | `handlers.rs:6372` | rag.mm_index.with_mock_vl<br>rag.mm_stats.empty_and_dims<br>rag.mm_delete.after_mock_index<br>rag.mm_index_resource.image_and_pdf_with_mock_vl | — | 无输入可触发 Err | — |
| `vfs_optimize_lance` | rag-multimodal | `src/api/vfsRagApi.ts:233` | `handlers.rs:4989` | rag.lance_stats.after_index<br>rag.optimize.empty_and_dims_without_tables | rag.lance.args_decode | 无输入可触发 Err（TableNotFound 早退 Ok，lance_store.rs:2338） | 其他 open_table 错误需故障 |
| `vfs_rag_search` | rag-multimodal | `src/api/vfsRagApi.ts:121` | `handlers.rs:4889` | rag.search.indexed_note_with_mock_embedding<br>rag.search.empty_index_with_mock_embedding | rag.search.without_embedding_model<br>rag.search.validation_errors | H:4911 空/空白查询；H:4926 非法 modality；未配嵌入模型的检索 Err | 成功且非空结果依赖 X5 嵌入模拟 |
| `vfs_reindex_resource` | index-dimensions | `src/api/vfsUnifiedIndexApi.ts:194` | `handlers.rs:3153` | index.reindex_resource.with_mock_embedding<br>index.reset.indexed_with_mock_embedding | index.reindex_resource.without_embedding_model<br>index.reindex_resource.errors | H:3165 前缀；未配嵌入模型时索引失败 H:3253；资源不存在 | H:3184 indexing 中早退需并发时序；成功路径依赖 X5 嵌入模拟 |
| `vfs_reindex_unit` | index-dimensions | `src/api/vfsUnifiedIndexApi.ts:106` | `index_handlers.rs:39` | index.reindex_unit.modes<br>index.reindex_unit.image_unit_mm | index.reindex_unit.modes<br>index.reindex_unit.errors | index_service.rs:295 Unit 不存在；:320 非法 mode | ensure_vector_index_available（mod.rs:137）在默认 lance 构建恒 Ok |
| `vfs_reset_all_index_state` | index-dimensions | `src/api/vfsRagApi.ts:464` | `handlers.rs:5922` | index.reset.empty_db<br>index.reset.populated_after_batch<br>index.reset.indexed_with_mock_embedding | — | 无输入可触发 Err | lance clear_all 失败需故障注入 |
| `vfs_reset_disabled_to_pending` | index-dimensions | `src/api/vfsRagApi.ts:426` | `handlers.rs:5859` | index.reset.empty_db<br>index.reset.populated_after_batch<br>index.reset.indexed_with_mock_embedding | — | 无输入可触发 Err | disabled 状态资源只能由非前端可达命令（vfs_toggle_index_disabled 无前端调用）或多模态空页标记产生 |
| `vfs_reset_indexed_without_embeddings` | index-dimensions | `src/api/vfsRagApi.ts:444` | `handlers.rs:5885` | index.reset.empty_db<br>index.reset.populated_after_batch<br>index.reset.indexed_with_mock_embedding | — | 无输入可触发 Err | 命中行需 indexed 且无 segment 的资源，依赖批量索引结果 |
| `vfs_resolve_resource_refs` | resources-refs | `src/features/chat/context/vfsRefApi.ts:171` | `ref_handlers.rs:153` | res.resolve.note_ref_from_get_refs<br>res.resolve.by_resource_id_and_fallbacks<br>res.resolve.deleted_note<br>res.resolve.empty_list<br>res.resolve.batch_limit | res.resolve.batch_limit<br>res.resolve.args_decode | ref_handlers.rs:171 超过 50 条；resolve_single_ref 早退：retrieval snippet 回退 :541、未知类型 found=false、不存在/已删 :574 | 单条解析 Err 后 push found=false（:208）需故障；PDF/图片 inject_modes 分支需别域附件 seed |
| `vfs_resource_exists` | resources-refs | `src/features/chat/resources/api.ts:229` | `handlers.rs:378` | res.exists.created_missing_prefix | res.exists.args_decode | H:386 非 res_ 前缀早退 Ok(false)（非 Err） | 无可由输入触发的 Err；仅参数解码错误 |
| `vfs_restore_mindmap_version` | mindmaps | `src/features/mindmap/api/mindmapApi.ts:216` | `handlers.rs:5187` | mindmap.restore.old_version_and_same_content | mindmap.restore.deleted_mindmap<br>mindmap.restore.errors | H:5200 前缀；mindmap_repo.rs:1935 版本不存在；:1949 导图已软删；:1965-1970 内容相同早退 Ok(current) | 版本内容缺失 :1941 需坏数据 seed |
| `vfs_retry_pdf_processing` | files-attachments-pdf | `src/api/vfsPdfProcessingApi.ts:185` | `handlers.rs:6558` | file.retry.after_upload<br>file.retry.text_file_without_status | file.retry.errors | H:6572 前缀；pdf_processing_service.rs:3009 无状态 NotFound；:3004 非可重试阶段 warn 后 Ok | 运行中（is_running）分支依赖时序，未写 |
| `vfs_set_attachment_root_folder` | files-attachments-pdf | `src/api/attachmentConfigApi.ts:14` | `handlers.rs:1662` | file.attachment_root.set_then_upload | file.attachment_root.errors | H:1670 文件夹不存在/已软删 | — |
| `vfs_set_default_embedding_dimension` | index-dimensions | `src/api/vfsUnifiedIndexApi.ts:302` | `handlers.rs:3693` | index.batch.pending_with_mock_embedding<br>index.set_default.text_and_multimodal_unbound<br>index.set_default.bound_model<br>index.reindex_resource.with_mock_embedding<br>index.reset.indexed_with_mock_embedding | index.set_default.errors | H:3710 维度不存在；H:3730 非法模态（image 维度可建但不能设默认）；有/无模型绑定两路 | save_setting 失败需故障注入 |
| `vfs_set_mindmap_favorite` | mindmaps | `src/features/mindmap/api/mindmapApi.ts:163` | `handlers.rs:5331` | mindmap.list.empty_multiple_and_deleted<br>mindmap.favorite.toggle_and_repeat | mindmap.favorite.errors | H:5346 前缀；mindmap_repo.rs:1382 不存在/已删 affected==0 | — |
| `vfs_start_pdf_processing` | files-attachments-pdf | `src/api/vfsPdfProcessingApi.ts:202` | `handlers.rs:6592` | file.start.pdf_and_image<br>file.start.explicit_stages | file.start.errors | H:6610 前缀；pdf_processing_service.rs:1131 文件不存在、:1158 不支持的媒体类型 | 已在运行早退 :711 依赖时序（start.explicit_stages 连续三次调用可能命中，由 A 判定） |
| `vfs_sync_resource_units` | index-dimensions | `src/api/vfsUnifiedIndexApi.ts:123` | `index_handlers.rs:164` | index.status.empty_and_after_sync<br>index.units.empty_then_synced<br>index.sync.note_resync_and_empty<br>index.sync.resource_types<br>index.sync.missing_resource<br>index.reindex_unit.modes<br>index.reindex_unit.image_unit_mm<br>index.batch.pending_without_embedding_model<br>index.batch.pending_with_mock_embedding<br>index.reset.populated_after_batch | index.sync.unsupported_type<br>index.sync.args_decode | index_service.rs:162 不支持的 resource_type | file 类型 transcript 分支 media_index.rs 需 L18 转写 seed |
| `vfs_unified_batch_index` | index-dimensions | `src/api/vfsUnifiedIndexApi.ts:116` | `index_handlers.rs:56` | index.batch.empty_modes_and_clamp<br>index.batch.pending_without_embedding_model<br>index.batch.pending_with_mock_embedding<br>index.reset.populated_after_batch | index.batch.errors | index_handlers.rs:78 非法 mode；:67 batchSize clamp | process_pending_batch 内部 Err 需 X5 模拟服务返回错误 |
| `vfs_unified_index_status` | index-dimensions | `src/api/vfsUnifiedIndexApi.ts:92` | `index_handlers.rs:18` | index.status.empty_and_after_sync<br>index.batch.pending_without_embedding_model<br>index.batch.pending_with_mock_embedding<br>index.reset.populated_after_batch | — | 无输入可触发 Err | — |
| `vfs_update_mindmap` | mindmaps | `src/features/mindmap/api/mindmapApi.ts:139` | `handlers.rs:5250` | mindmap.update.content_title_and_meta<br>mindmap.update.version_source_variants<br>mindmap.update.expected_updated_at<br>mindmap.versions.list_get_content_limits<br>mindmap.restore.old_version_and_same_content<br>mindmap.restore.deleted_mindmap<br>mindmap.list.empty_multiple_and_deleted | mindmap.update.expected_updated_at<br>mindmap.update.errors | H:5261 前缀；mindmap_repo.rs:553 不存在/已删；:567 OCC 冲突；versionSource 白名单回退 H:5272-5283 | H:5268 内容超 50MB 未写；共享资源写时复制 :674 需共享资源 seed；chat 来源快照失败 fail-closed 需故障 |
| `vfs_update_path_cache` | resources-refs | `src/features/chat/context/vfsRefApi.ts:189` | `handlers.rs:1143` | res.path_cache.rename_then_refresh<br>res.path_cache.empty_and_missing_folder<br>res.path_cache.deleted_folder | res.path_cache.errors | H:1154 非 fld_ 前缀；H:1195 递归结果空早退 Ok(0)（缺失/已删文件夹） | COMMIT/ROLLBACK 失败、H:1210 路径超长 skip 需故障或超长数据，未写 |
| `vfs_upload_attachment` | files-attachments-pdf | `src/features/chat/context/vfsRefApi.ts:622` | `handlers.rs:1327` | file.get_file.invalid_prefix<br>file.upload_attachment.text_reuse_and_readback<br>file.upload_attachment.image_with_front_shape<br>file.upload_attachment.pdf<br>file.upload_attachment.explicit_folder_and_empty_folder<br>file.upload_attachment.empty_content_defaults<br>file.upload_attachment.staged_complete<br>file.attachment_root.set_then_upload<br>file.pdf_page_image.attachment_pdf<br>file.pdf_page_image.no_preview_and_missing<br>file.retry.after_upload<br>file.start.pdf_and_image<br>file.media_cache_stats.empty_and_populated | file.upload_attachment.validation_errors<br>file.upload_attachment.args_decode<br>file.upload_attachment.staged_complete<br>file.upload_attachment.staged_incomplete | name 空/类型不支持 attachment_repo.rs:401；attachment_type 三类 :437；data URL :2604；Base64 解码；PDF 文件头 :733；压缩包 :351/:357；staged 未知/未完成 staged_upload.rs:304/:313；文件夹不存在 | 大小上限（50MB/200MB）未写超大 base64；音视频流式分支归 L18 媒体语料；加密 PDF 未写 |

### 没有业务错误场景的命令（13 条）及理由

`vfs_get_media_cache_stats`、`vfs_unified_index_status`、`vfs_list_embedding_dims`、`vfs_list_dimensions`、`vfs_list_mindmaps`、
`vfs_multimodal_stats`、`vfs_inspect_retrieval_capabilities`、`vfs_get_embedding_readiness`、`vfs_reset_disabled_to_pending`、
`vfs_reset_indexed_without_embeddings`、`vfs_reset_all_index_state`：处理函数无参数或参数不进入分支，Err 只来自连接/prepare/SQL/Lance 失败。
`vfs_get_preset_dimensions`、`vfs_get_dimension_range`：返回常量，无 Err。
另外 `vfs_resource_exists`、`vfs_get_resource_units`、`vfs_get_resource_text_chunks`、`vfs_list_files`、`vfs_get_lance_stats`、`vfs_optimize_lance`、`vfs_multimodal_delete`
只有参数解码类错误场景，原因相同。这些都需要 X3/X7 的受控故障种子或注入才能触发，未写，也不声称不可达。

### 共同未覆盖项

| 项 | 所需 |
|---|---|
| 各命令 `get_conn_safe`/`get_conn` 失败、SQL prepare/execute 失败、`spawn_blocking` join 失败（如 H:1340） | X3/X7 故障种子或注入，及 A 端运行证据 |
| `ensure_vector_index_available`（`mod.rs:137`）的 Err | 只在不带 `lance` feature 的构建出现；默认构建（`src-tauri/Cargo.toml:596`）恒 Ok |
| PDF/图片处理流水线的异步阶段（OCR、压缩）结果 | 上传后台任务的时序不由 v0 步骤控制；OCR 需 X5 模拟。快照只记录调用时刻的状态 |
| 题目集（exam_sheets）PDF 预览、教材 preview、音视频转写 units | L14 / L18 的种子或其前端命令串联；本包只用 empty seed |

## 语义备注（仅记录，未改实现）

- `vfs_create_or_reuse` 前端传 `subject: null`（`src/features/chat/resources/api.ts:156`），Rust `CreateResourceInput`（H:39）没有该字段且未 `deny_unknown_fields`，被忽略；场景照抄前端形状。
- `vfs_resource_exists` 对非 `res_` 前缀返回 `Ok(false)`（H:386），不做 Unicode 校验；`vfs_get_resource`/`vfs_increment_ref` 走 `validate_id_format` 报错。场景里同一输入对两类命令都有。
- `vfs_get_file`/`vfs_get_file_content` 只接受 `file_`/`tb_`，附件 `att_*` 被拒（H:2722/2792）；`vfs_get_pdf_processing_status` 等接受 `att_`。`get_file.invalid_prefix` 用真实附件 ID 记录这一差别。
- `vfs_start_pdf_processing` 的 `startFromStage` 未知值落到 `Pending`（`pdf_processing_service.rs:190` `ProcessingStage::from_str` 的 `_ => Pending`），不报错。
