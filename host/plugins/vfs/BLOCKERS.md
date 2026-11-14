# L13 剩余接线与测试证据（2026-11-04）

## WP-200 当前限定核实（2026-11-05，main 0764800b3）

folder八目标已注册；F3 storage及L11 `api.ts` 重导出的 `FolderRepository` 已main，
包括 `getBreadcrumbs?` 正式面，不再以整组folder接口缺失阻塞语料。原WP-064/101/109历史已包含于main。
`equivalence/folders.v0.json` 已提交候选21场景208步，Node真实Host观察与结构检查通过（详见该目录README）。
本包只交语料与观察：A1/A2录制/覆盖率、故障与并发调度、带资源/历史数据场景仍缺；
缺口逐条列在README，不能据B侧通过宣布A/C或语料充分。
既有消费者单写者、worker和日志/分阶段错误整改仍按下文R13v-01/03/04追踪，接口发布不等于消费已整改。

合并 main 后复核。权威 TESTMAP 行状态：293 ported、83 pending、0 merged、5 obsolete（生成表头待协调者刷新）；已撤回L13b两项不满足原线程保证的ported，已吸收三项真实路径维护测试。resource_read/list/search/folder_list及导图CRUD/版本diff/节点编辑已登记，相关14项原测试闭合；导入实现和测试也已完成，但XML/虚拟路径真提供方缺失，test_can_handle保持pending。测试状态不是 v2 验收结论；下文另列本 lane 自有单写者修复，不把它们当成接口阻塞。

## 运行时服务缺口

R13v-04 worker候选更新：L11 **da2bc4cb4** 已提供 `vfsWorker.runFolderOperation(method,args)`，目前精确覆盖 `createFolder/getFolder/renameFolderIfVersion`（参数同FolderRepository去掉conn），复用受F3屏障纳管的worker与错误/日志回传；候选待main后接用，不再称整个folder worker未实现。`deleteFolder` 尚未开放，因为同连接note级联需要L10可在worker中构造的softDelete/restore入口；流式staged媒体后台组合也不在本候选。不能用这三个方法的发布宣称delete/streamed分支完成，也不能用主线程SQL替身冒充线程测试。

L04 候选已存在（`03c9b17a7` 首次发布，`bd4b221d0` 当前树），不是未实现；本lane当前main尚未包含，待正常集成。附件服务精确形状为 `requiredId(args:unknown,key:string):string / notFound(detail):string / localize(raw):string`，与本lane AttachmentErrorPort匹配；先前短消息 `requiredId(value)` 不准确。scope 服务 `loadSessionRagScope(sessionId)` 已绑定 sessions.database，而 `api.ts` 另导出的纯函数 `loadSessionRagScope(database,sessionId)` 才匹配本lane现有双参数端口。

最小接入清单：main包含候选后，附件index注入改为正式类型；retrieval使用api导出的双参数函数赋给现有ChatRetrievalScopePort（不把单参数服务as成双参数），再用真实L04 registry组合验证附件错误分类与会话硬过滤。无需复制classifier/SQL；端口候选测试由L04报告 `20261104111841-a0dcc4` exit0，仅记提供方证据、不作为本lane通过。当前双参数服务cast是待改接点，不将其误标已接真。

| 提供方 | 缺少的公开接口 / 证据 | 影响 |
|---|---|---|
| L12 | `tokenize/idf/bm25Scores`；`vfs-index/api.ts` 未导出这些符号，已有实现位于其 src/lexical-bm25.ts | 下列7项 lexical_bm25 测试。需要暴露其生产评分函数，不能另建算法让孤立测试通过。 |
| L04 | `chatAttachmentErrors.requiredId(args,key)/notFound/localize`，对应 attachment_stage_executor.rs:146/110/177；main chat/api.ts 尚无，候选见上 | 附件执行器已完成本 lane 的读写边界、日志与结果实现，7项 Rust 测试及2项补充测试通过真实 Chat/VFS 仓储及真实 L07 registry；仍待候选集成后使用真实分类器验证，8项pending。 |
| L02 | 请求 `llmReranker.getRerankerModelConfig/callRerankerApi/getVlRerankerModelConfig/callMultimodalRerankerApi`；`llm/api.ts:42-66` 的 LLMManager 未声明这4个方法。本 lane api.ts 已发布 RetrievalRerankerPort | retrieval executor 已实现配置能力校验、文本/VL路由、结果索引映射与失败回退日志（Rust builtin_retrieval_executor.rs:1477-1700）；缺实际模型API提供方，仍pending，默认 enable_reranking=true 保持。 |
| L04 | `loadSessionRagScope(database,sessionId)` 公开纯函数候选待main；服务同名方法仅收sessionId，不能混用签名 | 本lane现有双参数端口须绑定公开函数；已有会话范围展开、排序去重、模型交集过滤实现，待真实提供方组合验证。 |
| L12 | 请求 `retrievalCancellable.search(request,signal)/searchMultimodal(request,signal)`，接口 CancellableRetrievalPort 已公开；现有 retrieval API 只有 request 参数 | Rust rs:299-321 的 tokio::select 取消时丢弃检索future，TS必须把同一AbortSignal传入实际检索而不只race等待。生产注册依赖此能力；取消集成测试已验证外层结果和提供方都收到取消。 |
| ~~L13b~~ 本lane | **已更正（WP-101，b71c37b70，未进main）**：旧说"缺L13b上传服务"不成立。生产 `vfs_upload_file` 由本lane index.ts 注册（b384894f3，主体 src/upload-file.ts）；L13b `createDstuUploadService` 是未注册的第二份实现（WP-057报告），不使用。现由本lane index.ts 以同一 `fileUploadDeps()`/`uploadFileCommand` provide `dstuUpload`，类型/大小委托 `vfsRepo.attachments`；资源创建钩子唯一入口为 `ctx.vfs.resourceCreatedHooks`，不向 L13b `vfsHooks` 平行表注册 | DSTU upload；tests/dstu-upload-provider.test.ts 用官方profile真实Host验证。provider进main前D29-upload仍wp，DSTU 8项与旧73映射保持pending。WP-057另报的 updated_at（updatePdfOcrPages）与 PDF 预览默认配置副本差异已由 WP-109（a5db9ff24）更正：页级文本改走 L11 `setUploadOcrPagesWithConn`（同 conn，只写 ocr_pages_json），预览用 L11 `DEFAULT_PDF_PREVIEW_CONFIG`；证据 tests/upload-ocr-pages.test.ts |
| L13b | `filestream_check_access` 的空路径判定：生产注册与实现只在 `vfs-handlers/index.ts:246` → `vfs-handlers/src/filestream.ts:40-45`。Node `realpathSync('')` 解析为 cwd 不抛错，而 Rust `fs::canonicalize("")` 报 ENOENT 并在 file_stream_protocol.rs:720-722 直接 `Ok(false)`；于是 TS 在 `path:""` 时先发 `app.pdfStreamAllowedDirs`，没有 Shell 处理器时命令 panic（WP-019 探针 job 20261105143737-cd1f99）。最小修正：canonicalize 一步对空串返回 false，或改用 `realpathSync.native`（同样对 `''` 报 ENOENT），使其在 Shell 请求之前失败 | X1 `path:""` 用例。本 lane 已用真实组合 host 测试锁定不存在路径不发 Shell 请求、存在文件仍经 Shell 白名单完整判定（service-wiring.test.ts）；空串断言要等 L13b 修正后才能加入，不在本 lane 重复注册该命令 |
| L13b | 将 todo/pomodoro 真实命令数据库工作接入 L11 vfsWorker，并保留worker返回的业务错误 envelope | 两项线程保证测试。main中L13b测试只证明deferred callback，不等价 Rust todo_handlers.rs:1264-1291 的线程ID不同及线程边界错误返回；C2明确要求退回pending，权威表已照办。worker接口已main发布，不误称L11未提供。 |
| F7/F4 | `mindmapXml.parse(text)`；roxmltree兼容树及原始Display错误，目前无公开XML parser API。详情见native-needs.md | mindmap_import的XML格式边界，全部本 lane 树转换、ZIP/JSON/Markdown解析、会话验证和落库已完成；真实parser到齐后才注册import，test_can_handle仍pending。测试DOM替身不代表生产解析器。 |
| F3 | `virtualFilePolicy.isVirtualUri(path)`，已有storage/unified-file-manager.ts实现但storage/api.ts尚未导出 | mindmap_import originalPath回退；不复制虚拟scheme/SAF判断。最小VirtualFilePolicy已公开。 |
| L14 | `qbank.exportDocument(examId)`；qbank/api.ts 未提供 | dstu_export 的原始题库文档分支；本 lane 已公开 QbankExportHook。维持 Rust 的钩子缺失错误，测试端口不代表真实提供方。 |

（更正 2026-11-06，WP-101）旧句"3条未达A命令 vfs_upload_attachment/vfs_upload_file/vfs_download_paper 属L13b未注册"已过时：三条命令均在本lane index.ts meta.commands 声明并注册（b384894f3）；ledger 作业 20261105173232-9545fa 输出 `commands 1058 (A 100% B 0% C 0%)`。命令A级不等于上传等价已验收（WP-109 只覆盖页级文本写入与预览默认配置）。

服务名/循环注入的旧阻塞已由 main `8176f4199` 解除；本 lane 已删除 tests/owner-ports.ts，所有集成测试直接安装真实 notes/vfsRepo/vfsIndex。

L07 已发布 `agentTools.registerToolExecutors/toolExecutors`，工具测试均使用真实 agent-skills 插件。工具89项中，88项原测试已有代码：资源/导图14项及L03块类型映射1项ported；生成式UI其余37项、DSTU8项、附件7项、retrieval20项与import的1项，因真实领域/原生接口未到齐继续pending。仅附件共享错误分类器的1项仍待L04提供被测函数，不能在本lane重写算法。

最新已解除：L10 props诊断同计数器公开，10项属性测试全部ported；L03 getBlockTypeForToolStatic已公开，对照测试ported；L05 runtimeRoots已真实provide，index.ts使用scoped.runtimeRoots；L19 Context.webSearch提供loadConfig/doSearch(config,input,signal)，retrieval已消费该正式面，signal贯穿且配置加载仍在start事件前。L17 memoryRetrieval/hpiasResearch/memoryConfig 已随 `69fd771fc` 合并 main 可见（memory/api.ts:14-49，index.ts:92-103）。既有最小端口/依赖回调已按这些名称消费，但真实 L17 组合验证仍属本 lane 待办，不能继续标成未发布。L12 在途取消须另验，不由 L17 search 的 signal 签名推定完成。

F4 工具参数/本地化接口旧阻塞已撤销：`host/platform/errors/api.ts:3` 实际导出 snake_case 的 `get_json_array_arg/ensure_localized_error/with_localized_message`，之前仅按camelCase搜索漏查。retrieval 已直接调用真实F4函数，删除 toolArgs 注入与测试替身；取消错误的原始原因按真实契约保留在 detail，而非替身错误的 message。

## X6 现树单写者排查（自有待修，不计外部阻塞）

扫描作业 `20261104110714-6bb897`，树 `e43715ca8`（导图创建修复之前），显式选择 create/delete/folders/locations/update/resources/trash 七仓储。工具未加 `--check`，exit 0 仅表示完成扫描，**不是通过门禁**。原结果79条：63条 foreign-table-write + 16条 duplicate-repository 信息项；另外 unknown 中本 lane 有33个 SQL 命中（resources 6、folder_items 27）。故不能沿用旧快照“53条”当现树数量。

| 现树位置（行号为扫描时） | 分类与处置 |
|---|---|
| create.ts 旧171 INSERT notes / 旧175 UPDATE resources | **已修未集成**：现153-175委托 L10 createNote/createNoteInFolder 的连接参数，74-90委托 L11 createOrReuseWithHash；历史 `f4a22b3a6`。不再重写同一修复 |
| create.ts:418 mindmaps | **真报，本单元已接面**：`90d40c0ac` 改用 L11 createMindmapWithConn/createMindmapInFolderWithConn；原断言不变，新增真实 trigger 故障回滚测试 |
| create.ts:519 blobs、595/620 files | **真报待修**；owner L11。615 resources 被工具标 unknown，但 D1 明确属于 L11，同样待修 |
| delete.ts:48/225 files、74 translations、102 exam_sheets、127 qbank_practice_attempts、147 questions、168 essay_sessions、198 essays、248 mindmaps | **9个真报待修**；L11已有对应 delete/deleteWithFolderItem 接缝，不报接口缺失 |
| folders.ts:190/269/286/314/387/1084/1098 folders；862/884 path_cache；941 files、959 exam_sheets、974 qbank_practice_attempts、990 translations、1012 essay_sessions、1022 essays、1035 mindmaps | **16个真报待修**；L11所有者接缝逐单元接用；保留原层级/级联/事务行为 |
| resources.ts:752 mindmaps、791 mindmap_versions、792 mindmaps | **3个真报待修**；restore/purge 改用 L11 同连接方法，不在消费者删除版本表 |
| update.ts旧160/208/214 note_editor_write_grants/lease_acks | **3个消费者写点候选已修，待R3**：L10 notes.leases已main（api源e445524ba），本lane f8b509c32经正式NoteLeaseRepository同conn调用authorized/now，删除本地围栏SQL与冻结稿副本；callNoteRepository保错误key。Node544997/Electron566a1e各3passed/exit0/无Errors，含ack失败正文/资源/ack/grant整体回滚；不再报接口未发布。checkWrite已在owner updateNote内调用，不重复加第二围栏 |
| update.ts:244/558/1080 exam_sheets；280/284/288/292/296 essay_sessions；381/417 mindmap_versions；513/1107 mindmaps；580/756/780/835/850 translations；867/884/898 essays；605/911/923/935/968/1055/1095 files；1131 folders | **其余28个真报待修**；L11字段更新/版本/迁移业务需逐项匹配正式方法，暂不声称全部已具备原子接缝，也不照旧快照批量替换 |
| unknown: folder_items 27 / resources 6 | **所有权已知、不能豁免**：D1/L11；工具 registry ambiguous 不等于没有所有者。位置包括 locations.ts:55/70/86/119；其余在 create/delete/folders/resources/update。动态表名 SQL 未完全覆盖，扫描数量不是完整待办上限 |
| 16条 duplicate-repository 信息项 | 与上述表写入重复计数，不再当16个独立行为缺陷；随相关所有者收敛一起关闭 |

所有列出的仓储经 `repository/index.ts` 由 vfs.repositories 公开，多项还有 DSTU 生产命令调用；“WithConn”后缀没有授予本 lane 他表写权限。R3 已确认总 finding **R13v-01**（notes/mindmap 可分子项），当前未签收；本报告不自行勾选 ACCEPTANCE。后续 `41a804a2c` 已将 delete.ts 全部写操作切到正式owner方法，9条已知foreign-write及该文件8条folder_items命中已移除；回滚集成测试验证中，其他仓储不自动关闭。

最新候选差异：`0fe8c89d2`/`4faf0d998` 又将 `folders.ts::deleteFolderWithConn` 整体委托L11正式folders.deleteFolder(conn,id)，删除本地多实体级联/树更新SQL及私有辅助副本（固定X6-SW-0117–0125，R13v-01）。Node/Electron各6条生产删除/共享成员/trigger回滚验证均exit0、无Errors，完整job见LANE。以上旧扫描位置为历史证据，不再按它重写该已委托子单元；剩余folder创建/重排/更新、worker与日志仍待处理。qbank_practice_attempts实际owner按C2裁定为L14，已删除消费者SQL不代表下游L11→L14级联全部独立签收。

## pending 测试逐项清单

每节共用上表所列符号、提供方与证据；测试名均保留 TESTMAP 中的 Rust 名称。

### 已接线的 L13b 路径维护（3，不再 pending）

Rust `vfs/handlers.rs`；`dea54622f` 的真实 `vfsMaintenance.getResourcePath/updatePathCache` 消费与 tests/harness.ts 移除维护替身已进入 main。三路径 invoke、UTF-8 缓存限额、title 回退与 paths.test.ts:153-165 的第二写失败整体回滚证据已核，权威映射已同步：
- `test_source_id_prefix_parsing`
- `test_path_length_constraint`
- `test_path_format`

### L12 词法评分公开面（7）

Rust `vfs/lexical_bm25.rs`；缺生产 tokenizer/idf/scorer 导出：
- `tokenizer_emits_cjk_unigrams_bigrams_and_whole_latin_words`
- `idf_is_never_negative`
- `single_character_query_matches_inside_words`
- `full_coverage_beats_repeating_one_term`
- `rare_terms_outweigh_common_terms`
- `scoring_is_deterministic_and_case_insensitive`
- `huge_documents_are_scored_on_a_bounded_head`

### L13b worker 接线（2）

Rust `vfs/todo_handlers.rs`；worker已main发布，命令线程边界尚未接真：
- `database_work_does_not_run_on_the_async_runtime_thread`
- `blocking_runner_preserves_business_error_contracts`

### 已批准 obsolete（2，C2-platform）

`migration/approvals.d/C2-platform.json` 已批准这两个死方法测试，TESTMAP 已更新。审批只覆盖这两个方法，不覆盖仍活跃的枚举类型与 blob 仓储；保留下面的核实证据。
- `types.rs::test_vfs_resource_type_all`：全 src-tauri 的 `VfsResourceType::all(` 仅命中 types.rs:3034 测试。
- `types.rs::test_vfs_blob_generate_relative_path`：全 src-tauri 的 `VfsBlob::generate_relative_path(` 仅命中 types.rs:3150,3153 测试。

核对命令（当前 worktree 根目录执行，扫描全仓 Rust 文件）与原始输出：

```sh
rg -n --glob '*.rs' 'VfsResourceType::all\(|VfsBlob::generate_relative_path\(' .
```
```text
./src-tauri/crates/dstu-vfs/src/vfs/types.rs:3034:        let all_types = VfsResourceType::all();
./src-tauri/crates/dstu-vfs/src/vfs/types.rs:3150:        let path = VfsBlob::generate_relative_path("abcd1234567890", Some("pdf"));
./src-tauri/crates/dstu-vfs/src/vfs/types.rs:3153:        let path_no_ext = VfsBlob::generate_relative_path("abcd1234567890", None);
```

补充核对未限定符号与别名，避免只搜限定路径漏掉调用：

```sh
rg -n --glob '*.rs' '\bgenerate_relative_path\b|VfsResourceType\s+as\s+|VfsBlob\s+as\s+' src-tauri
```
```text
src-tauri/crates/dstu-vfs/src/vfs/types.rs:1755:    pub fn generate_relative_path(hash: &str, extension: Option<&str>) -> String {
src-tauri/crates/dstu-vfs/src/vfs/types.rs:3150:        let path = VfsBlob::generate_relative_path("abcd1234567890", Some("pdf"));
src-tauri/crates/dstu-vfs/src/vfs/types.rs:3153:        let path_no_ext = VfsBlob::generate_relative_path("abcd1234567890", None);
src-tauri/src/chat_v2/tools/chatanki_executor.rs:19270:        use VfsResourceType as T;
```

定义位置：`types.rs:145-158` 的 all 只返回固定类型列表；`types.rs:1755-1761` 的 generate_relative_path 只构造相对路径。唯一别名 `T` 位于 `chatanki_executor.rs:19268-19270` 的 `#[test] fn test_decide_route_boundary_table` 内，只引用枚举变体；不是生产调用方。上述两个方法的实际调用均在 `types.rs` 的测试模块内（all 测试3033、blob测试3149），未发现生产调用。

别名调用补查：`rg -n --glob '*.rs' '\bT::all\(' src-tauri` 无输出，退出码1（无匹配）。

### 已批准 obsolete（3，不再计入 pending）

协调者在 main `ac8989383` 的 migration/approvals.json 已批准以下三项；TESTMAP 据此更新：
- `question_sync_service.rs::test_conflict_strategy_conversion`：文件头1-16明确退役冲突子系统，移除 IPC 命令，内部 API 仅审计/测试保留。
- `question_sync_service.rs::test_merge_versions`：同上；真实冲突路径已为 data_governance。
- `question_sync_service.rs::test_apply_keep_local_keeps_pending_push_and_recomputes_hash`：同上；仍在用的 mark_as_modified/update_content_hash 已通过 L11 真实更新流程验证，不将退役冲突处理误算为生产路径。

### L04 共享错误端口：attachment（8）

Rust `src/chat_v2/tools/attachment_executor.rs`；缺 L04 共享错误分类器。以下除 structured_errors 外7项已移植至 tests/attachment-executor.test.ts，并从 index.ts 的依赖登记回调进入真实 agentTools；错误端口真实提供方尚未发布，仍保持 pending：
- `test_can_handle`
- `test_strip_namespace`
- `test_sensitivity_level`
- `structured_errors_map_schema_args_and_not_found`
- `attachment_queries_use_chat_v2_database_without_main_database`
- `attachment_read_resolves_reference_image_to_blob_base64`
- `attachment_read_resolves_indirect_document_reference_to_text`
- `attachment_read_reports_missing_source_bytes_explicitly`

### XML/虚拟路径提供方：resource（1）

Rust `src/chat_v2/tools/builtin_resource_executor.rs`；以下测试已移植到mindmap-import.test.ts，全部11种工具分支已有实现。导入测试用契约XML树和真实F3虚拟路径方法装配；生产仍等上述正式接口，不标ported：
- `test_can_handle`

### L02/L04/L12/L17 提供方：retrieval（20）

Rust `src/chat_v2/tools/builtin_retrieval_executor.rs`；原实现1-2114已迁移为 retrieval-executor/retrieval-rerank/retrieval-sources 与只读仓储。以下20项已移植到 tests/retrieval-executor.test.ts，另有6项真实Host集成测试，index.ts 已接入依赖到齐后的注册回调、真实L07 registry与F4本地化。上表重排/记忆/范围/取消端口真提供方缺失，测试替身仅覆盖这些外部端口，不据此将TESTMAP改为ported：
- `test_can_handle`
- `test_strip_namespace`
- `test_sensitivity_level`
- `score_thresholds_filter_low_scores_with_absolute_min`
- `score_thresholds_keep_top1_when_all_below_absolute_min`
- `score_thresholds_apply_relative_only_for_rrf_scale`
- `snippet_truncation_respects_budget`
- `numbered_sources_use_type_local_citation_indexes`
- `numbered_sources_expose_multimodal_fields_for_frontend_adapter`
- `numbered_sources_carry_media_time_fields_only_for_media_hits`
- `dedup_removes_memory_notes_from_kb_results`
- `dedup_uses_source_note_ids_for_compressed_memory_entries`
- `test_route_to_unified_search`
- `multimodal_search_uses_dedicated_me_only_scope`
- `executor_failure_boundary_localizes_retrieval_errors`
- `test_citation_prefix_for_source_type`
- `test_citation_group_for_source_type`
- `reranker_selection_tracks_query_and_candidate_modality`
- `test_preferred_read_resource_id`
- `scope_is_a_hard_filter_that_model_args_can_only_narrow`

### dstuUpload provider 待进 main：DSTU（8）

Rust `src/chat_v2/tools/dstu_executor.rs`；已有 tests/dstu-executor.test.ts，L05根授权已发布并接用。（更正 WP-101）旧说"只缺L13b上传服务"不成立：provider 归本lane，b71c37b70 已提供并有官方profile真实Host测试，未进main前不改去向。另：这8条原例的TS用例仍直接 new 执行器（dstu-executor.test.ts:26-30，R3 S06 拒收理由），转ported前需逐条核对断言并改走注册实例，不能仅凭provider到位：
- `handles_exact_dstu_tool_surface`
- `risk_levels_match_product_contract`
- `list_trash_is_the_only_parallel_read`
- `secx_08_upload_source_requires_managed_runtime_locator`
- `mime_inference_covers_primary_document_types`
- `structured_errors_are_machine_readable`
- `trash_pagination_matches_global_read_limit`
- `folder_create_and_trash_listing_use_real_migrated_vfs_repository`

### 本 lane 待验证：generative UI（37）

Rust `src/chat_v2/tools/generative_ui_executor.rs`；已有 tests/generative-ui.test.ts 中全部38项原测试，L03映射已ported。L17真实HPIAS端口现已main，37项待本lane组合验证，不是外部接口阻塞；按C2当前“小单元优先，不叠加旧任务”顺序，在DSTU单写者单元后继续：
- `parse_intent_accepts_object`
- `parse_intent_accepts_version_1_1`
- `parse_intent_defaults_missing_version_as_v1`
- `parse_intent_ignores_unknown_layout`
- `parse_intent_rejects_unknown_version`
- `validate_intent_version_rejects_version_2`
- `parse_intent_accepts_json_string`
- `parse_intent_rejects_empty_blocks`
- `parse_intent_rejects_oversized_payload`
- `parse_intent_rejects_too_many_blocks`
- `parse_intent_rejects_missing_intent`
- `parse_intent_rejects_unknown_block_type`
- `parse_intent_rejects_missing_block_type`
- `parse_intent_rejects_non_object_block`
- `parse_intent_accepts_all_registered_block_types`
- `parse_research_session_id_accepts_non_empty_string`
- `parse_research_session_id_rejects_blank`
- `parse_research_session_id_rejects_unsafe_or_oversized`
- `parse_research_session_id_falls_back_to_intent_meta`
- `parse_research_session_id_prefers_top_level_over_meta`
- `execute_preserves_research_session_id_in_output`
- `parse_skeleton_ref_accepts_valid_skill_id`
- `parse_skeleton_ref_rejects_invalid_or_absent`
- `parse_note_edit_accepts_append_payload`
- `parse_note_edit_rejects_invalid_operation`
- `parse_note_edit_rejects_regex_flag`
- `parse_note_edit_rejects_oversized_payload`
- `parse_note_edit_strips_unknown_fields`
- `parse_note_edit_rejects_non_string_fields`
- `intent_has_apply_note_edit_detects_action_bar_id`
- `execute_preserves_note_edit_in_tool_arguments`
- `execute_fails_when_apply_note_edit_without_note_edit_payload`
- `can_handle_namespaced_and_plain_tool_name`
- `execute_success_returns_rendered_status_and_block_count`
- `execute_failure_on_empty_blocks_returns_error_result`
- `execute_v1_1_grid_layout_returns_rendered`
- `execute_rejects_version_2`
