# L13-vfs-api 行为规格（`host/plugins/vfs/`）

<!-- BEGIN GENERATED:spec:header -->
逐条对照 Rust 源码填写（README §3.3）。每节下的清单项全部勾选（`- [x]`）即视为该节完成，ledger 据此计算 B 级；
勾选前在冒号后写明结论与 Rust 依据（文件:行）。生成区块由 `npm run migration:scaffold -- --refresh` 维护。

命令 214 个 · 发出事件 6 种 · 契约：`contracts/ipc/L13-vfs-api.json`
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

### 验收问题处理：R3 v2 六组补审（当前候选树390e23572）

审读来源 `ds-mig/R3-review-vfs:host/plugins/vfs/ACCEPTANCE.md`（e03c2ad0d/fe5c1ddcf）；不修改验收文档，不将候选通过等同main签收。

| Finding | 现树事实与本轮顺序 |
|---|---|
| R13v-01 | notes/mindmap创建已由R3独立4例候选验证；删除owner委托41a804a2c及390e23572的生产回滚已交R3。更新/级联其余写入仍待逐单元收敛 |
| R13v-02 | 当前index已注册dstu_delete/delete_many等，相关生产回归分别见dstu-delete/dstu-trash；是旧main缺入口与本候选待集成，不重造删除实现 |
| R13v-03 | build_path已候选通过；其他日志/prepare-query上下文仍待修；L11创建日志b03e1753f候选另由owner提交 |
| R13v-04 | 同步DB/流式媒体分支确需继续对照；不以现mediaTranscriber字幕刷新组合覆盖dstu_create流式上传缺口 |
| R13v-05 | 当前update.ts已有本地manual快照副本，并非仍完全省略；但应接L11真实更新方法，保留合并窗、fail-open计数升级、OCC和事务，不能继续维护第二仓储。本轮优先这一单元 |
| R13v-06 | test_simple_path_format改调生产buildSimpleResourcePath，Rust handlers.rs:6691-6694的输入和唯一相等断言均不变。实际TESTMAP行293/83/5，生成标头290/86/5需协调者用生成器刷新（本lane不得手改GENERATED头，当前生成器无单文件选项） |

### R13v-01 / X6-SW-0116–0125：文件夹删除同连接级联

- 生产入口 `dstu_folder_delete` 与 `dstu_delete(folder)` → `repository/folders.ts::deleteFolderWithConn` → 正式 L11 `vfsRepo.folders.deleteFolder(conn,id)`；移除本lane整套entity/cascade SQL与仅供该副本使用的私有查询。保留公开函数及可选options调用形状；身份与logger由owner正式配置，不再用消费者环境变量覆盖。
- Rust folder_repo.rs:1230-1320：owner SAVEPOINT → 根folder软删；已删除幂等/不存在FolderNotFound；递归descendants软删→成员软删→仅本树资源级联→RELEASE；任意失败ROLLBACK。树外活跃成员保留实体，canonical类型+id去重；note由L10、其余按L11 entity adapter及L14领域级联接缝负责。消费者不再直接更新qbank_practice_attempts等领域表。
- owner错误Display直接交现有命令边界，L10 NoteDocumentError仍经callNoteRepository映射；不新加事务或成功事件。原folder-handler不发dstu:change；通用dstu_delete只在返回后发其原deleted事件。
- 测试：原幂等/不存在/共享成员断言不改；新增真实文件更新trigger失败，确认root/child/notes/files/成员全部回滚、无额外事件，去trigger可成功继续。R13v-03日志全覆盖与R13v-04工作线程仍未因此关闭。

### R13v-01 / X6-SW-0127–0129：笔记租约围栏正式接面

- main已提供L10 `NotesService.leases.authorized/checkWrite/now`；index把该正式服务与notes.repository一并绑定。既有公开authorizedNoteLeaseWrite签名保留为薄委托，删除本地grant/ack SQL、participant/lease查询、冻结稿与currentNote副本；调用L10 authorized使用原conn与work，clock取owner.now。
- Rust note_lease_repo.rs:307-361：同一note_history_write savepoint内grant→owned/ready→commit时冻结稿检查→work→commit时刷新ack→删除grant。L10负责每个错误key及回滚；L13只复用已有callNoteRepository的NoteDocumentError→VfsError映射，不将失败转换为成功。note内容仍经已发布notes.repository.updateNote，派生写入不复制。
- 原生产invoke租约测试保持不变（无lease冲突、ready成功刷新draft、pending/未flush/错误participant）。新增ack刷新trigger失败发生在正文成功之后，验证外层回滚正文/资源/ack/grant且无updated事件；去trigger后同请求可成功并清空grant。R13v-03其他数据库Display细节仍另行复核。

### R13v-03 文件夹输入校验日志（续作小单元）

- Rust folder_handlers.rs:59-88依次检查控制字符→Unicode bypass→路径分隔符→UTF8字节长度，每个失败分支先warn再返回原中文错误；日志只带field_name（长度分支另带max_len），不新增输入全文输出。空白标题在:167-168/:285-286先返回错误，无validator warn。
- create的title→icon→color顺序不改；颜色非法在:182-186记录原color warn。rename复用同一校验器，标题校验仍发生在数据库查询之前。
- 最小验证走真实kernel invoke，捕获真实Cordis exporter（显式level3）；各失败只应有对应warn/level2/原消息和字段，颜色不能抢先于非法标题，失败不写folders。原校验测试断言不变。不以这些warn修复声明整个folder命令日志、线程或所有权完成。

### 验收问题处理：R13v-05 / R13v-01 导图正文更新小单元

- Rust content_helpers.rs:727-740明确只有content/expected_updated_at/version_source=manual非None；`updateMindmapContentWithConn`据此调用L11 `mindmaps.updateMindmapWithConn`，不再走本地update/版本SQL副本。元数据rename/set_metadata的旧路径尚在R13v-01待办，不据此宣称全update.ts单写者闭合。
- owner mindmap_repo.rs:540-790的BEGIN IMMEDIATE/OCC→旧内容快照→资源写时复制或原地写→metadata更新→COMMIT由L11执行。manual快照失败仍提交内容，前2次warn/第3次起error；成功快照清零连续失败计数。30分钟manual无label合并窗、非chat版本清理和旧资源共享行为沿owner保留。DSTU updated事件只在成功返回后发。
- 数据边界：现L11 normalizeContent的JSON语法错误仍来自JS；为保留本命令既有Rust文案，仅在owner已抛VFS_INVALID_ARGUMENT/content之后用已有parseSerdeJson解码语法并转为同一InvalidArgument Display。不会将解析提前到NotFound/OCC之前；合法JSON的结构错误原owner错误直接传播。已向L11请求在owner统一JSON Display，避免长期双重错误映射；不改变既有非法JSON断言。
- 生产测试新增：共享资源下旧manual版本正文保留与合并窗；真实版本表trigger连续3次失败仍提交并观察warn/warn/error；最终mindmap行trigger失败使版本+正文回滚且无updated事件。原dstu-update所有断言不删改。

### R13v-06 路径夹具与当前门禁失败

`20261104120752-5b6d74` 复现service-wiring.test.ts::test_source_id_prefix_parsing失败：实际/file_*，期望/教材.pdf。Rust handlers.rs:8178-8190原断言明确用tb_def456，1259-1303标题分派仅tb查files.file_name，file前缀走原ID；textbook_repo.rs:136-137现代创建本来生成file_。因此不是生产解析器该改行为：测试插入实际legacy tb_def456行后仍经kernel invoke断言原/教材.pdf，并保留现代创建器额外验证file_回退。原note/tb/exam/tr/essay的所有标题断言不删、不反转；不再用现代工厂错误代表legacy前缀分支。L13b相同夹具问题通知其owner，自有目录外不改。

### 平台工具与服务接线整改（2026-11-03）

- 2026-11-04 集成修复：`filestream_check_access` 由 L13b `vfs-handlers/index.ts` 唯一注册（其 HANDOFF.md 已明确归属）；本入口仅登记 filestream/pdfstream 协议。Rust file_stream_protocol.rs:719-741 的 canonicalize→白名单→隐藏段→扩展名→普通文件判定保持；双插件装载测试同时验证 IPC 可达性、协议读取与 DSTU 命令共存。

- 时间解析委托 F4 `parseRfc3339/parseNaiveDateTime`：节点解析按 node_converters.rs:47-88 保留空值/非法值回退当前时间、非法值 warn；SQLite 小数秒路径仍支持，整数秒/毫秒阈值保持 1e11。文件夹按 folder_repo.rs:47-77 使用 1e12 阈值，只接受无小数秒 SQLite 时间或日期。
- `nowIso` 仅保留既有公开调用签名与格式选择，委托 `toRfc3339Opts(nowEpochNanos(), 'Millis', true)`；保持原 Rust `%Y-%m-%dT%H:%M:%S%.3fZ`，不误改成默认 AutoSi/+00:00。OCC 严格 +1ms、版本合并窗与回收站解析均使用 F4。
- 字符串 trim 统一 F4 `rustTrim`，保留 Unicode White_Space（去 U+0085、不去 U+FEFF）；不改变标题/路径校验的字节数与错误文案。
- create/resources/update 的 rollback 失败按 mindmap_repo.rs:343-354、797-804、1199/1236/1499 与 file_repo.rs:202 的 `let _ =` 保留原错误；不再使用 `void error`。FTS/缓存失效已有 warn 继续通过注入的 logger 输出，生产源码无 console。
- `vfsDatabase/vfs/dstu` 名字已满足 lowerCamelCase，api.ts 增加对应 `*Service` 版本描述；生产依赖明确为 `storage/notes/vfsRepo/vfsIndex`，使用 `ctx.notes/ctx.vfsRepo/ctx.vfsIndex`，索引服务缺失时不再悄悄跳过清理。
- L10 `notes`、L11 `vfsRepo` 更名和循环注入修复已合入；删除测试名称适配器，直接装载真实插件，生产无旧名兼容层。
- 待接线：`qbank.exportDocument(examId)` 尚无本lane原始题库导出所需公开面，继续保留最小端口；`memoryConfig.get/set` 已随L17进入main，既有延迟取用接点可消费，真实组合验证另列待办。

### L18 媒体转写刷新接面（2026-11-04）

- 生产路径：L18 `index.ts:779-788` 提供 mediaTranscriber → `media-transcriber.ts:86-95` 调真实 pipeline → `pipeline.ts:415/473/494` 与 DbSink 每20段回调 → L18 `index.ts:757-766` 调本lane `vfs.mediaIndex.refreshTranscriptIndex(vfs.database,vfs.unitIndex,fileId)`。本lane入口 `index.ts:194` 同时提供两字段，类型从api.ts消费。
- Rust `vfs/media_index.rs:199-238` → `src/media-index.ts:70-77`：文件不存在/没有资源ID则0；不存在转写单位则L11 markPending后0；否则syncResourceUnits(resourceType=file)立刻返回数量。没有本地表写入，单位同步通过L11 embeddingUnits.syncUnits及indexStates。
- 输入fileId原样，返回usize等价number（单位数有界）；纯服务不增加IPC字段。媒体元数据格式/时间窗仍见原8个测试；无新增取消点、事件或外部资源需要释放。底层错误原样抛，由L18按Rust pipeline.rs:343-351 warn后继续。
- 新增组合用例测试生产提供方，不用伪造refresh回调：导入字幕跳过ASR配置，经L18服务写extracted_text并同步三窗；修改字幕同步一窗；真实SQLite trigger拒绝单位写时transcribe仍成功且字幕已落库。C2复核后补充真实Cordis exporter断言：target/name=media.commands、type=warn/level=2、消息保留Rust `[media::pipeline] refresh transcript index failed for`、file_media及原SQL错误字段；未替换logger或业务路径。exporter显式开启WARN级别（默认buffer阈值INFO会过滤WARN），随host释放。原Rust测试及此前继续/持久化断言不变。20段ASR部分刷新保留L18实现/验收职责，不以这个导入分支用例替代ASR时序测试。

### 共享类型与题目内容哈希的跨服务对照（2026-11-04）

- `types.rs:128-142,2926-2936`：资源类型先小写化，`note`/`TEXTBOOK` 分别解析为 note/textbook，未知值为 None；通过 L13b 已接线的 `vfs_create_or_reuse`/`vfs_get_resource` 验证真实解析结果与 InvalidArgument 文案，不复制解析器。
- `types.rs:3158-3173`：`VfsListItem` 序列化保留 resourceId、previewType=markdown、type=note；经 DSTU 创建笔记并调用 `vfs_search_all` 验证真实列表结果。
- `question_sync_service.rs:471-517,2017-2077`：SHA256 顺序为 content→存在的 options/answer/explanation→question_type→存在的 difficulty→tags→非空 images→存在的 structured_data；不包含答题状态、用户答案或次数。main 的 L11 `questions.updateQuestion/submitAnswer` 已公开并调用该哈希实现；测试经真实仓储重复更新、提交答案、改正文，读取持久化哈希验证确定性/非内容不变/正文改变。该纯计算无日志、事件或取消；写入副作用仍由 L11 原更新流程负责。
- `note_props.rs:78-104,253-275,322-363`：通过真实 dstu_set_metadata 校验空/保留/控制字符/65字符键错误类别（以其公开 reason 文案断言）及64字符合法边界；通过生产 normalizePropFilters 验证 trim+小写、仅丢弃空键、保留搜索侧 tags；通过 L10 getNote 从真实 notes.props 原始 JSON 读取验证 string/number/bool 不变。L10共享诊断计数、snippet、操作符可表达性已从api发布并被vfs-wire-types测试消费，10项已映射；未复制其计数器或搜索语法。

### 工具 `render_generative_ui`（依赖登记已接，待真实组合验证）

- 输入：generative_ui_executor.rs:51-261；intent 支持对象或 trim 后 JSON 字符串，原字符串与序列化后对象分别以 UTF-8 字节限制256000；version 缺省不回填，仅接受字符串1/1.1；blocks 为1..32个对象，type 属18种白名单；layout/span 未知值透传。researchSessionId/skeletonRef trim 后为1..128字节 ASCII 安全标识符，顶层 ID 优先于 meta。
- noteEdit：必须对象，operation=append/replace/set；isRegex=true 拒绝；section ≤1024字节，content/search/replace/section 合计≤262144字节；这四个存在的字段必须字符串，返回解析值剔除其他字段。action-bar 包含 apply-note-edit 时必须提供 noteEdit；结果 input 仍保留原始 arguments（rs:178-261、418-434、474-481）。
- 事件：校验失败 emitStartWithMeta(generative_ui,title=null)→emitErrorWithMeta→保存失败 ToolResultInfo；成功 start(title)→chunk(JSON intent)→end({intent,isStreaming:false,researchSessionId?,skeletonRef?})，沿用 variantId/skillStateVersion/roundId（rs:263-323、382-485）。
- 错误：校验错误为 success=false 的工具结果；序列化错误走 `intent 序列化失败: ...` 错误通道。saveToolBlock 返回错误按 Rust `let _` 忽略；没有新增取消点，敏感度 Low。耗时用单调时钟取整数毫秒。
- 研究副作用：存在 researchSessionId 且有前端窗口时，委托 L17 端口完成研究块识别、问题提取、后端启用判定、session_started 事件（失败 warn）与后台启动。禁止在本 lane 复制 HPIAS 逻辑（rs:327-360、454-463）。
- L07 `agentTools.registerToolExecutors`、L17 `hpiasResearch.startFromIntent` 与 L03 `getBlockTypeForToolStatic` 均已main公开；index.ts 的hpiasResearch登记回调已存在。块映射1项ported，其余37项保留pending等待本lane真实L17组合验证，不再称提供方未发布。

### 工具 DSTU mutation executor（迁移中，未登记）

- dstu_executor.rs:33-44、403-765：精确10种工具；只接受各工具白名单参数，字符串 Rust trim 且非空。folder_create/rename、rename/move/delete/restore/list_trash/set_favorite/purge 复用本 lane 生产处理函数；不另写 DB 业务。
- 错误：INVALID_ARGS/DSTU_OPERATION_FAILED/SERVICE_UNAVAILABLE/VFS_UNAVAILABLE 等为 JSON 字符串，字段 code/message/hint/retryable；已是合法 JSON 的后端错误原样返回。分页默认20，1..20，offset 为 u32，读取 limit+1 判 has_more，next_offset 饱和加法。
- 事件/结果：tool_call start→end({result,durationMs}) 或 error，保存 ToolResultInfo 失败 warn；文件夹和上传额外补 DSTU created/updated；其他 mutation 由原处理器发事件（rs:780-849）。list_trash 唯一 read_only；purge high，list_trash/set_favorite low，其余 medium；不额外增加取消点。
- 上传：root_id+relative_path 必须同时提供，禁 local_path；依赖 L05 根授权/重新验证，逐路径分量拒绝符号链接、realpath 后必须在根内；文件普通文件/大小上限/限长读取防增长；名字≤255字节、无控制字符、单个 Path component；MIME 推断后校验支持列表；读取后检查取消，再调用 L13b vfs_upload_file 全流程（rs:258-394、652-765）。
- L07 注册接口、L05 runtimeRoots.rootById/revalidate已公开并接用，index.ts 已接入依赖到齐后的登记回调；dstuUpload 改由本lane provide（WP-101，b71c37b70）：upload 即注册的 vfs_upload_file 同一 uploadFileCommand(fileUploadDeps())，类型/大小委托 vfsRepo.attachments，context 参数照 Rust 只用于定位托管状态、provider 不消费；官方profile真实Host测试 tests/dstu-upload-provider.test.ts。未进main前8条 TESTMAP 保持 pending。

### 工具 attachment_list / attachment_read

- attachment_executor.rs:56-188：只读当前会话 Chat V2 消息，传入不一致 session_id 只 warn；type 默认 all，limit 默认20，as_u64 后截为 u32。按消息顺序先 legacy attachments 再 context_snapshot.user_refs（仅 file/image/folder），以 messageId::attachmentId 去重。每组插入后检查 limit，故0仍可返回条目，同消息两组可超限；照原顺序保留。
- rs:195-342：先检查 chat_v2_db，再通过 L04 required_attachment_id 校验非空字符串；parse_content 非 boolean 时默认true。消息跨会话拒绝；legacy 优先，preview_url 必须 data: 且含首个逗号；文本 MIME 使用 STANDARD 严格 base64/UTF8，图片返回base64，其他文档按开关调用 docs.extractTextFromBase64，解析失败 warn 并返回原中文占位文本。
- rs:360-445：引用读取先获取 VFS 连接，fld_ 拒绝；通过 L11 attachments.resolveFileId→getById（过滤 deletedAt）→getContent 读取真正文件，不将 refs JSON 当字节。文件名空白才回退 displayName/id；image 标识、MIME 或记录类型任一满足即按图片。文档 parse=true 优先 trim 后非空 extractedText，否则读取base64并调用文档解析器；找不到记录/原字节按原文案抛错。
- rs:461-545：debug 执行/列表/legacy读取日志；start→end({result,durationMs})或经 L04 localized_attachment_failure 后 error；保存 ToolResultInfo 失败 warn，不影响结果。敏感度low，并发read_only，没有新增取消点/事务；耗时单调毫秒，contentLength 为 UTF8字节。
- L04 `attachment_stage_executor.rs:110,146,177` 的 attachment_not_found_error/required_attachment_id/localized_attachment_failure 未在 chat/api.ts 发布，最小 `AttachmentErrorPort` 由本 lane 请求；不能复制该 lane 的错误分类器。`structured_errors_map_schema_args_and_not_found` 因此仍不可移植。登记使用已发布的真实 L07 registry，继续等待 L04 错误端口，TESTMAP 保持 pending。

### 工具 rag_search / multimodal_search / unified_search / web_search

- builtin_retrieval_executor.rs:165-321：queryText/query_text/query、image/mime/mode 的别名按顺序取首个 trim 后非空字符串；数组只保留字符串且不 trim。模式可显式 text/image/mixed，其他报 Unsupported queryMode；未指定时按文本/图片存在推断。top_k/topK 优先字段存在性、再 rag_top_k、默认10，unified上限30、其他100、下限1；reranking 默认true。范围先读 L04 会话范围，展开 L11 子文件夹排序去重；模型参数仅能取交集，交集空回退完整会话范围。
- rs:260-638：先 rag start，再检索；multimodal_search 单独调用 searchMultimodal。取消点为开始前和检索 await；失败原样交外层本地化。结果保留 normalizedScore/rerankScore 优先及 f32展示分数；存在 blobHash 或多模态 provenance 即多模态来源。即使 memory_disabled 也先排除记忆笔记 resourceId；排除准备过程中的错误按 Rust .ok() 静默回退空集合。
- rs:448-541,1477-1700：文本/VL reranker 依据查询模式或候选 blob/sourceType 选择。未配置正常跳过；能力不兼容 warn+failure；调用失败 warn+保留RRF；文本通过 rerank-source-N 回映，VL 按 index 回映，take(topK) 在丢弃非法索引之前；无有效返回记录失败。VL blob读取失败仅debug并用纯文本。阈值仅在归一化/rerank后使用绝对0.3，否则仅相对0.5；无score保留，全被过滤时保底第一条。每资源限额之后合并记忆，至少3个记忆槽、空知识槽回补记忆；记忆取消 info+空结果、失败warn+routeFailures。
- rs:941-1121,1254-1406：snippet按Unicode字符1500/条、6000/批预算，截断末尾省略号占1字符；回复级CitationLedger按类型分组/稳定身份编号；来源全部固定字段保留null，仅媒体时间字段按键存在性附加。记忆去重按noteId/sourceNoteIds或同名note，不删非note。资源读取ID先直接sourceId再合法resourceId最后Option回退；前缀大小写敏感。
- rs:641-825：web配置委托L19同一配置加载/设置覆盖；读取 session.selected_search_engines，模型无engine时取首个并info。start→检索前再次取消检查→可取消await，取消info；成功web_search end与返回共用编号sources，编号从1重置；失败先web_search error再交外层。没有tool_call_start/saveToolBlock，避免覆盖专用rag/web块。
- rs:126-153,835-928：canHandle排除memory_search，但直接execute仍保留其deprecated本地化结果与memory end；未知名报 Unknown builtin tool。工具敏感度low/read_only，无DB写事务；耗时单调毫秒。本地化直接使用已公开的F4 snake_case函数，删除旧toolArgs测试替身；L02/L17/L04等业务步骤通过最小请求端口调用，不用空结果代替缺失实现，缺真实提供方时TESTMAP保留pending。
- 取消不仅结束外层等待：同一 AbortSignal 必须传入 L12 retrievalCancellable、L17 memoryRetrieval.search、L19 websearchCancellable；等待结算后移除本 lane 的监听器。原服务尚无 signal 参数，最小接口已在 api.ts 公开，注册回调明确依赖新端口，不能注册一个仍在后台继续工作的不可取消替代实现。

### 工具 resource_read（独立命令单元）

- builtin_resource_executor.rs:138-255,380-490：ID参数按 resource_id/readResourceId/read_resource_id/sourceId/source_id/resourceId 首个净化后非空字符串选择；不要求首个候选合法才选。净化按trim→边界引号→空白token边界→非ASCII标点切分→固定前缀顺序查找；只读ID允许ASCII字母数字/_/-，tb_/att_归files，essay_session_优先。res_依次sourceId→按type反查对应表；未知/不存在/无法映射分别保留原中文提示。
- rs:1127-1206,1433-1673：include_metadata默认true，元数据错误warn后继续，类型查询也按原样warn；None只debug。文件/题库previewImages接受camel/snake，压缩hash优先，blob路径失败null。page_start/page_end只接受u64并至少1；offset/max_bytes/expected_hash复用L05已发布函数。无page_start的files先读转写，失败warn再退回文档；页数据失败回退全文并info，非文件页参数同样退全文。
- rs:1208-1422：SHA256针对完整逻辑内容（可为选定页/时间范围）而非当前字节窗口；UTF8分页不截断字符。返回完整availability/degradation、bytes偏移、hash、duration；metadata/metadata_error按原分支省略或加入。先预算裁正文，失败依次移除metadata.previewImages、二分缩短顶层previewImages、移除metadata，仍失败才报预算错误；追加truncationNotice在预算检查之后，保持原行为。
- rs:1297-1324：转写hint优先覆盖页hint，带timeRange/mediaDurationMs/mediaCitation；超过10分钟与继续读提示顺序保持；指定time但无转写时使用忽略提示。没有新取消点/DB写操作；start→带variant/skill/round的end/error；saveToolBlock失败warn。
- resource_read/list/search/folder_list及导图CRUD/版本/节点编辑共10个资源工具已登记；mindmap_import有实现但尚缺正式XML/虚拟路径提供方，原跨全部工具的test_can_handle保持pending，不能为了让它提前通过而注册缺依赖的实现。

### 工具 resource_list / resource_search / folder_list

- builtin_resource_executor.rs:591-1100：列表type默认all，limit默认20且1..100，folder_id默认root，search存在（包括空串）走原search_all。类型别名只接受原大小写；未知type在无search时报原中文错误，有search时types=None。无文件夹筛选的file仅document，指定文件夹的单独file列表保留所有文件类型；all分支file组排除image、image组独立查询并后过滤。all按8类固定顺序、每类max(limit/8,5)读取，单类失败warn且partial_errors保留类别；合并按updatedAt稳定倒序后截断，收藏过滤最后执行，不补足条数。essay脱敏保留原7字段清单与debug日志。
- rs:1677-1857：query必须字符串但不trim、不拒空；types只取字符串并过滤未知类型，全部未知时不限类型。top_k默认10且1..50，folder_id不默认root；复用search_all。snippet按原资源ID解析/读取，失败仅debug并返回null；大小写查找后按Unicode字符前后100截取，非命中取前200，短于200时不trim。duration在snippet读取之前取样；file/image/textbook才给chatankiCompatible与目标ID。
- rs:1864-2041：parent_id缺失/空/root归根，不trim；include_count默认true，recursive默认false。文件夹读失败加 Failed to list folders 前缀整体失败；资源计数失败warn并返回0。递归depth>50时warn返回空，叶子省略children，include_count=false省略resource_count。无事务/写入/取消点；公共executor保留start/end/error与保存失败warn。

### 工具 mindmap_create/update/delete/versions/diff_versions

- builtin_resource_executor.rs:2056-2421：title必须trim后非空但保留原值；content字符串原样或JSON序列化，缺省默认文档；fix节点缺失/空text时依次取首个存在name/label/title/value/content（不跳过null），缺失children补[]，depth>100只warn返回。关联线只保留存在且不同的端点，trim，空/重复ID按assoc_gN补；非数组warn后删除。create经L11创建并提交→created事件→读取内容→尽力创建chat_create快照，快照失败warn，不回滚创建；duration在事件/快照之前。
- rs:2497-2636：更新先读取当前updatedAt作OCC，读取失败error并返回中文重试；content存在即修复（包括null），settings按键存在性传递。调用L11 updateMindmapReturningVersion(snapshotAfter=true,versionSource=chat_update)，快照失败整事务回滚；提交后updated事件，citation复用返回快照，不新增第二条版本。
- rs:2643-2733：删除mindmap_id键存在时不回退resource_id；软删→计数同resource活跃导图→仅零引用时删除可选Lance text索引→markDisabledWithReason；每个清理错误分别warn并加入返回warning。计数失败整体报错但软删已提交；deleted事件路径固定/mindmaps/id，duration在事件前。
- rs:4866-5153：versions默认20且1..100，不检查mindmap存在；保持仓储顺序，label/source显式null。diff要求mm_，from缺省第一历史版本，to缺省current（ASCII大小写不敏感）或mv_；验证归属并保留各阶段错误前缀。节点ID缺省path:路径、重复追加#2；签名固定text/note/collapsed/completed/style/blankedRanges/refs，比较字段JSON而非整张HashMap。增删按path、修改/移动按id排序后detail_limit截取；计数按完整集合，truncated按每类独立计算，无写入日志/事件。
- 原Rust缺陷保留：mindmap_repo.rs:670-690 的写时复制只数导图（866-875明确包括软删除导图），不数版本；create_version_with_conn:1557按内容去重复用resource。只有一个导图时，后续更新可能修改历史版本指向的resource内容。diff集成夹具通过第二个真实导图触发copy-on-write，另单独验证单导图版本共享；不改仓储策略。相同计数方法导致mindmap_delete软删后remaining仍≥1，普通删除路径不会进入索引清理，测试验证保留该行为而非按方法名假定只计活跃行。

### 工具 mindmap_edit_nodes

- builtin_resource_executor.rs:4285-4483：operations经F4 get_json_array_arg（数组或JSON字符串），associations缺失/null不变、数组整体替换、其他拒绝；空operations且无associations直接返回三个字段。无associations才尝试ACR；后端读元数据/内容，逐操作失败warn并收集，不回滚其他成功操作；有成功操作或关联线更新才OCC保存（chat_edit_nodes旧内容快照），提交后updated事件，再尽力创建新内容快照，失败warn。返回success=操作错误为空，但ToolResultInfo.success仍为true（执行器Ok分支）。
- rs:4488-4780：复用L07双gate与acrBridgeCall。gate关闭debug/读取失败warn→后端；probe普通失败info→后端，取消返回cancelled且禁止后端写；eligible缺windowId返回BRIDGE_PROTOCOL_ERROR；提交前取消返回不可重试cancelled。apply提交后任何桥失败/无回执/畸形回执返回uncertain，不回落后端；ok=false且结构化code原样抛错，否则uncertain。suggestion保留未落盘语义，其他回执补frontend/实时保存文案。
- rs:4783-4859：AgentOp anchor/payload仅复制非null白名单字段，空anchor=null；delete/move为destructive。label中文、文本最多24 Unicode字符；敏感度high且managesCancellation=true。
- rs:5161-5501：update patch对象逐字段替换，style仅对象时按键合并、null删字段；text改变且未显式传blankedRanges则删除旧范围。add先收集所有id并重分配重复/空id为n_+8nanoid；move先验证目标存在/非自身后代再移除，但目标children不是数组的错误仍发生在移除之后（原行为保留）；禁止删/移root。partial失败仍可伴随其他操作提交，不新增事务或取消检查。

### 工具 mindmap_import（等待 XML/虚拟路径公开能力）

- builtin_resource_executor.rs:2791-2915,3964-4018：resourceId键存在则优先resource_id，trim非空；只接file_/att_/res_映射文件，构建原id/file.id/resourceId去重候选。先文件查询再验证chat数据库，倒序扫描当前会话contextSnapshot.userRefs，legacy attachments不算授权；未归属拒绝。blobHash→sha256→非虚拟且无ParentDir的普通originalPath，文件metadata>32MB拒绝，随后read保持Rust不再二次限制的行为。
- rs:2918-3187,4237-4265：扩展名ASCII小写优先，其次PK魔数→前2048字节lossy文本嗅探；JSON只取root/associations且补空id，深度>100或节点>10000报错，原重复id不主动改写。纯文本/Markdown逐行保留Rust标题/缩进/列表/任务规则：tab=2空格，heading_base后继列表+1，单顶层改root id、多顶层新增合成根并计数。
- rs:3193-3956：OPML/MM/XMind XML/MMap按roxmltree localName/无namespace属性语义遍历；只统计原实现计数的丢弃图片/链接/概要/边框。OPML/MMap节点ID后序分配，MM/XMind前序；原ID首个映射保留，关联线端点重映射后过滤缺失/自指。ZIP content.json存在时JSON错误不退xml；无扩展zip先XMind失败再重置stats尝试MMap。每entry32MB并限长解压；F4 ZipArchive处理CRC/压缩。
- rs:4112-4233：title优先自定义trim→root.text trim→文件stem，文档meta.createdAt为F4 chrono AutoSi；统一fix/关联线清理后计数→L11创建→created事件→尽力chat_create版本（失败warn）→duration/info/result。notice及全部dropped计数字段固定，不新增取消点。
- XML生产解析不能以自写正则或测试DOM代替roxmltree的实体/命名空间/非法XML文案；请求F7/F4提供 MindmapXmlParser.parse，另请F3从api公开已有isVirtualUri。index仅在mindmapXml/virtualFilePolicy/chatSession到齐后登记import，其他10个资源工具独立可用。测试通过真实owner仓储/registry，XML边界仅用jsdom生成同形树，尚不证明roxmltree错误等价，test_can_handle保持pending。

## 命令 `dstu_batch_move`

<!-- BEGIN GENERATED:cmd:dstu_batch_move -->
- Rust：`src-tauri/crates/dstu-vfs/src/dstu/handlers.rs:6297` · async
- 前端：app（1 处，例 `src/dstu/api/pathApi.ts:171`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：request: BatchMoveRequest
  - 结果：BatchMoveResult · 错误：string · 注入：window, state
<!-- END GENERATED:cmd:dstu_batch_move -->

- [x] 输入：handlers.rs:6297-6408；request.itemIds 逐项处理，request.targetFolderId 可空表示根级；空列表直接返回空结果。
- [x] 输出：handlers.rs:6397-6408；BatchMoveResult{successes,totalCount,failedItems}，totalCount 为原始条目数。
- [x] 错误：handlers.rs:6431-6494；单项失败仅进 failedItems（查询旧路径/查询现有记录/更新/插入前缀），连接失败整体报错。
- [x] 事件：handlers.rs:6347-6386；每个成功项发 dstu:change:{newPath} 与 dstu:change，载荷 moved{oldPath,path,node}。
- [x] DB 读写：handlers.rs:6441-6494；按 canonical item_type 查 folder_items，存在则 UPDATE（含 item_type），否则 INSERT fi_+nanoid(10)；目标文件夹路径只构建一次。
- [x] 取消/并发：spawn_blocking 单连接逐项执行，无事务；失败项不回滚成功项。
- [x] 时间/ID：插入项 createdAt/updatedAt 共用当前毫秒；folder_items.id 为 fi_+nanoid(10)。

## 命令 `dstu_build_path`

<!-- BEGIN GENERATED:cmd:dstu_build_path -->
- Rust：`src-tauri/crates/dstu-vfs/src/dstu/handlers.rs:5929` · async
- 前端：app（1 处，例 `src/dstu/api/pathApi.ts:65`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：folderId?: string | null, resourceId: string
  - 结果：string · 错误：string · 注入：state
<!-- END GENERATED:cmd:dstu_build_path -->

- [x] 输入：handlers.rs:5929-5965；folderId 可空（缺失/null 表示根目录），resourceId 原样。
- [x] 输出：handlers.rs:5956-5961；folder_path 为空时 "/{resourceId}"，否则 "{folder_path}/{resourceId}"（无前导斜杠）。
- [x] 错误：handlers.rs:5947-5951；folderId 存在时 build_folder_path 的 VfsError Display。
- [x] 事件：无（handlers.rs:5929-5965）。
- [x] DB 读写：folder_repo.rs:2296-2317；递归 CTE 读 folders.title，未知 folderId 返回空串，只读。
- [x] 取消/并发：spawn_blocking 只读。
- [x] 时间/ID：无写入、无新 ID。

### v2 单元 L13-BUILD-PATH-01

- Rust `dstu/handlers.rs:5930-5956` → `index.ts` 注册 `dstu_build_path` → `src/locations.ts::buildPathCommand`。
- 分支：5935入口 info；5941-5947 的 None 返回空文件夹路径且不获取连接，Some 才调用 L11 `folders.buildFolderPath(conn,id)`；5949-5953 空路径（含未知文件夹）返回 `/{resourceId}`，否则 `{folderPath}/{resourceId}`；5955结果 info 只在成功后发出。
- 数据边界：IPC `folderId: Option<String>` 缺失/null 由 kernel 统一为 null，resourceId 必填字符串、不 trim；结果/业务错误均为 string。无持久化 JSON、无新 ID/时间字段。
- 所有权：只通过 L11 `vfsRepo.folders.buildFolderPath` 读取 folders；不复制 CTE，不执行他表 SQL。连接获取错误和 owner 错误的 message 经 CommandError 原样返回。
- 运行时：Rust 本函数没有 spawn_blocking、取消点、事务或待清理 guard；同步只读调用，无事件。根路径即使数据库不可用仍可返回。
- 测试：`tests/locations.test.ts` 原路径测试保留；新增生产 invoke 的连接失败/None 分支和参数解码测试。证据等级为生产入口测试 + Rust 分支审读；尚待 R3 独立验收。

## 命令 `dstu_copy`

<!-- BEGIN GENERATED:cmd:dstu_copy -->
- Rust：`src-tauri/crates/dstu-vfs/src/dstu/handlers.rs:2243` · async
- 前端：app（1 处，例 `src/dstu/api.ts:558`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：src: string, dst: string
  - 结果：DstuNode · 错误：string · 注入：window, state
<!-- END GENERATED:cmd:dstu_copy -->

- [x] 输入：`src` 经 `extract_resource_info` 解析；`dst` 先 Rust `trim`，空串或 `/` 表示根目录，否则必须解析为 `folders` 类型（handlers.rs:2250-2282）。
- [x] 输出：返回新建资源或文件夹的 `DstuNode`；note/translation/essay/mindmap 标题加 ` (副本)`，textbook 经 files 分支复制时文件名加 ` (副本)`，文件与图片同理；文件夹仅在顶层加后缀，子文件夹/子资源保持原名（handlers.rs:2299-2784、2839-3234）。
- [x] 错误：路径解析与仓库错误原样作为 string；`dst` 非文件夹 → `Destination must be a folder`；未知类型 → `Invalid node type: {type}`；文件夹循环 → `Cannot copy a folder into itself or its subfolder`；递归深度 ≥10 → `文件夹复制深度超出限制（最大 10 层）`；源不存在 → `Resource not found: {src}`。
- [x] 事件：成功后发 `created`（`dstu:change:<path>` 与 `dstu:change`），载荷为新节点；子项复制失败只记 warn 并继续，不发事件（handlers.rs:2776-2779）。
- [x] DB 读写：按源类型经 notes/vfs-repos 仓储创建新资源并复制内容；文件夹成员经 `folder_items` 写入，失败仅 warn；exam 复制由仓储自身写 folder item；不修改源资源（handlers.rs:2299-2784）。
- [x] 取消/并发：同步命令，无取消点；文件夹循环检测最多上溯 100 层（handlers.rs:2785-2837）。
- [x] 时间/ID：新资源 ID/时间戳由各仓储生成；文件夹用 `VfsFolder::new` 语义（`fld_` + 10 位 nanoid、`isExpanded=true`、`isFavorite=false`、`sortOrder=0`）。

## 命令 `dstu_create`

<!-- BEGIN GENERATED:cmd:dstu_create -->
- Rust：`src-tauri/crates/dstu-vfs/src/dstu/handlers.rs:726` · async
- 前端：app（1 处，例 `src/dstu/api.ts:336`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：path: string, options: DstuCreateOptions
  - 结果：DstuNode · 错误：string · 注入：window, state
<!-- END GENERATED:cmd:dstu_create -->

- [x] 输入：handlers.rs:727-880；path（仅用于 /fld_xxx 回退）与 DstuCreateOptions{type,name,content,fileBase64,stagedUploadId,metadata}；名称 ≤256 字节、内容 ≤1MB、metadata JSON ≤64KB；folderId 优先 metadata.folderId（fld_ 前缀，""/root 视为根），否则 path 去前导 / 后以 fld_ 开头。
- [x] 输出：handlers.rs:890-1432；notes（空名→Untitled，metadata.tags 严格字符串数组）、files/images（base64 或 staged upload，blob+file+folder_items）、translations（metadata.sourceText/translatedText/srcLang/tgtLang，title 空→null，额外写 favorite/rating）、essays（essay_session_* 节点元数据 essayType/gradeLevel/totalRounds/isFavorite）、exams（temp_<uuid>、empty 状态、preview_json SSOT）、mindmaps（内容规范化后落 resources）；textbooks 返回上传提示错误；folder/retrieval 不支持。
- [x] 错误：handlers.rs:727-880 输入限额错误；metadata.tags 形状 "INVALID_ARGUMENT: metadata.tags 必须是字符串数组"；textbook "Textbook creation requires file upload, use textbooks_add or vfs_upload_file instead"；folder → "Invalid node type: folders"，retrieval → "Unsupported resource type: Retrieval"；文件夹不存在 VfsError NotFound（"Folder not found: {id}"）；base64/大小/blob 错误按 Rust 文案。
- [x] 事件：handlers.rs:1435 emit_watch_event(DstuWatchEvent::created(node.path, node))，即 dstu:change:{path} 与 dstu:change。
- [x] DB 读写：note_repo.rs:480-592/2301-2353、translation_repo.rs:380-460/1088-1122、essay_repo.rs:749-860、exam_repo.rs:249-330/1628-1677、mindmap_repo.rs:81-286/359-488、blob_repo.rs:105-500、file_repo.rs:69-300；写 resources/notes/translations/essay_sessions/exam_sheets/mindmaps/blobs/files/folder_items。note_links/note_document_formats/note_document_revisions 属 L10 note 仓储派生表，本 lane 未写。
- [x] 取消/并发：同步命令；创建事务/savepoint 包裹资源+实体+folder_items；staged upload 读取后删除暂存文件。
- [x] 时间/ID：note_/tr_/essay_session_/exam_/mm_/file_/res_/fi_ + nanoid(10)，exam temp_<uuid v4>，时间格式 %Y-%m-%dT%H:%M:%S%.3fZ；blobs 以 sha256 去重并 ref_count+1。

### 验收问题处理：R13v-01.mindmap（X6 导图创建单写者）

- 现树 `createNoteWithConn/createNoteInFolderWithConn` 已通过 L10 `NoteRepository` 的可选连接参数处理 notes/resources，X6 旧主线171/175行样例属于已修未集成；`createMindmapWithConn` 的本地 INSERT mindmaps 仍是真问题。
- 本单元只替换导图创建两方法：Rust `mindmap_repo.rs:309-354` → L11 `mindmaps.createMindmapWithConn(conn,params)`，保留 owner savepoint；Rust `439-488` → L11 `createMindmapInFolderWithConn(conn,params,folderId??null)`，保留 BEGIN IMMEDIATE、检查文件夹、规范化/资源/导图/成员写入、COMMIT/ROLLBACK 顺序。L13 不执行相关 SQL、不另开事务、不复制 owner 正文规范化算法。
- 生产入口 `index.ts::dstu_create` → `src/dstu-create.ts` mindmaps 分支（输入缺省/限额不改）→ 本目录公开 repository 包装 → L11；创建事件仍在 owner 成功返回之后发出；owner Error.message 经现有 CommandError 边界传给前端。输出继续使用 `mindmapToDstuNode`（缺失 description/theme 映射 null，settings 原分支不改）。
- 测试先补 kernel invoke 的 folder_items trigger 失败：resources/mindmaps/成员均无残留，无 created 事件；删除 trigger 后同请求成功。原 `dstu-create.test.ts` 的规范化/ID/元数据断言一项不改。不是以测试替身代替仓储。
- owner日志：L11已回执 `b03e1753f`（V2-LOG-MINDMAP）补 Rust :405 Created mindmap info 和 :469 folder debug，位置分别在INSERT后、成员写后COMMIT前。提供方报告Node18例/tsc exit0，待main集成与R3复验；本包装层不复制。files/blobs 创建、其他 mutation 的跨 owner 写入另列现树清单。

- R3 已确认总编号 `R13v-01`，notes/mindmap 可分子项；本分支修复尚待主线入口与回滚复验，未签收。

## 命令 `dstu_delete`

<!-- BEGIN GENERATED:cmd:dstu_delete -->
- Rust：`src-tauri/crates/dstu-vfs/src/dstu/handlers.rs:1663` · async
- 前端：app（1 处，例 `src/dstu/api.ts:444`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：path: string
  - 结果：null · 错误：string · 注入：window, state, state
<!-- END GENERATED:cmd:dstu_delete -->

- [x] 输入：handlers.rs:1663-1705；path 支持简化 ID 或新格式路径，经 `extract_resource_info`（path_utils.rs:123-169）得到复数资源类型与 id；UUID 形态 id 被推断为 folders 时按 textbooks → notes → exams → translations → essays 顺序做 fallback 查找（查找失败静默跳过）。
- [x] 输出：成功返回 `null`（`Ok(())`）；软删除后资源从列表/搜索消失并进入回收站。
- [x] 错误：路径解析失败 `Invalid DSTU path: ...`；未知类型 `Invalid node type: {type} (id={id})`；各仓储错误经 delete_helpers 包装为 `VFS error: delete failed (type={type}, id={id}): {VfsError Display}`，例如 `VFS error: delete failed (type=notes, id=note_x): Note not found: note_x`。
- [x] 事件：handlers.rs:1737 `emit_watch_event(DstuWatchEvent::deleted(&path))`，即 `dstu:change:{path}` 与 `dstu:change`，payload 无 node；path 使用入参原文。
- [x] DB 读写：note_repo.rs:1477-1516/2367-2425（notes deleted_at、folder_items 软删、vfs_index_units 双 state 置 disabled）、textbook_repo.rs:865-900/1463-1488、translation_repo.rs:615-666（local_version+1、device_id）、exam_repo.rs:865-928/1695-1747（deletion_batch、questions/qbank_* 级联）、essay_repo.rs:490-525/1099-1160/1476-1499、file_repo.rs:967-1016、mindmap_repo.rs:1066-1130、folder_repo.rs:1230-1315（递归软删文件夹树与成员，级联仅属本树的实体）。向量索引清理（Lance text/multimodal）属 F7/L02，本 lane 未执行。
- [x] 取消/并发：同步命令；各仓储以 SAVEPOINT 包裹多步软删；重复删除按 Rust 幂等返回 Ok；note 处于编辑租约时 SQL 触发器以 `notes.lease_conflict` 阻止删除。
- [x] 时间/ID：deleted_at/notes.updated_at 为 ISO `%Y-%m-%dT%H:%M:%S%.3fZ`；folder_items.updated_at 为毫秒；exam deletion_batch 为 `exam_delete_`+nanoid(16)。

### 验收问题处理：R13v-01 删除仓储接面（待 R3 验收）

- `repository/delete.ts` 保留公开函数名，全部写操作委托 L10/L11 已公开、接受同一 SqlExecutor 的业务方法。按 Rust textbook_repo.rs:865/1463、translation_repo.rs:615、exam_repo.rs:865/1695、essay_repo.rs:490/1099/1145/1476、file_repo.rs:967、mindmap_repo.rs:1066 一一对应；移除消费者的表 SQL、ID/时间生成和 savepoint 副本。
- 外层 `dstu_delete` 类型分派/UUID查找/错误前缀与提交后事件不改；L10 noteDocument 错误继续由 callNoteRepository 映射。L11 VfsRepositoryError.message 已是原 VfsError Display，不重复添加 Database error。
- 同连接约束：`dstu_delete_many` 的 BEGIN IMMEDIATE 与这些 owner savepoint 共用原 conn；不独立提交 owner 数据，不绕过 owner 文件夹级联。新增混合 translation+mindmap 批量删除的末项成员写失败用例，验证外层回滚、事件未发出、连接可继续使用；原删除错误/ID/成员断言保持不变。
- owner 既有日志缺口仍由 L11修，不能因删掉本地重复实现宣称整条命令 v2 完成；本单元仅关闭消费者单写者副本。

## 命令 `dstu_delete_many`

<!-- BEGIN GENERATED:cmd:dstu_delete_many -->
- Rust：`src-tauri/crates/dstu-vfs/src/dstu/handlers.rs:5264` · async
- 前端：app（1 处，例 `src/dstu/api.ts:827`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：paths: string[]
  - 结果：integer(usize) · 错误：string · 注入：window, state, state
<!-- END GENERATED:cmd:dstu_delete_many -->

- [x] 输入：handlers.rs:5265-5296；最多 100 条 paths，空数组直接返回 0；所有路径先解析再开始写事务。
- [x] 输出：成功删除的路径数（重复路径也计数）；任一资源删除失败整体回滚。
- [x] 错误：`批量操作数量超出限制：最多允许 100 个，实际 {n} 个`、`无效的资源路径 '{path}': {e}`、`开始事务失败: {e}`、`提交事务失败: {e}`；删除保留 delete_helpers.rs 的类型错误包装。
- [x] 事件：COMMIT 后逐条 deleted，path 用入参；随后异步清理预收集的 resourceId 索引（handlers.rs:5390-5421）。
- [x] DB 读写：预收集 notes/files/exam_sheets/translations/mindmaps.resource_id；统一调用所属仓储软删除与其级联写（delete_helpers.rs:118-173）。
- [x] 取消/并发：BEGIN IMMEDIATE → 删除 → COMMIT；错误 ROLLBACK；不取消。
- [x] 时间/ID：各仓储生成删除时间，命令不生成 ID。

## 命令 `dstu_empty_trash`

<!-- BEGIN GENERATED:cmd:dstu_empty_trash -->
- Rust：`src-tauri/crates/dstu-vfs/src/dstu/trash_handlers.rs:641` · async
- 前端：app（1 处，例 `src/dstu/api/trashApi.ts:107`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：itemTypes?: string[] | null
  - 结果：integer(usize) · 错误：DstuError · 注入：window, state, state
<!-- END GENERATED:cmd:dstu_empty_trash -->

- [x] 输入：trash_handlers.rs:642-795；itemTypes 可空，空值为全部，数组为空则无匹配；类型小写化，单复数匹配，image/attachment 也匹配 file。
- [x] 输出：各匹配类型永久清理数量之和。
- [x] 错误：DstuError serde 对象；仓储失败映射 VfsError；预收集查询失败取空；提交后 blob sweep 失败仅 warn。
- [x] 事件：删除数 >0 时 purged('/_trash')；预收集资源索引随后清理，失败 warn（trash_handlers.rs:770-793）。
- [x] DB 读写：预收集全回收站资源/笔记 ID；事务内按 folder→note→exam→translation→essay session→textbook→file→mindmap 顺序清理；提交后 blob sweep 与笔记目录清理。
- [x] 取消/并发：BEGIN IMMEDIATE 包裹全部仓储操作；任一错误整体回滚；无取消。
- [x] 时间/ID：不生成 ID；清理时间由仓储决定。

## 命令 `dstu_export`

<!-- BEGIN GENERATED:cmd:dstu_export -->
- Rust：`src-tauri/crates/dstu-vfs/src/dstu/export/mod.rs:303` · async
- 前端：app（1 处，例 `src/dstu/api.ts:1098`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：path: string, format: string
  - 结果：DstuExportResult · 错误：string · 注入：state
<!-- END GENERATED:cmd:dstu_export -->

- [x] 输入：export/mod.rs:304-340；格式大小写不敏感，md/markdown、raw/original、zip；先格式再路径校验，节点类型按末段 ID 前缀推断。
- [x] 输出：八类适配器，text/binary/file 分别返回 content/dataBase64/tempPath，省略未使用字段；folder ZIP 深度 >16 停止，最多 2000 项，优先 original，失败写导出说明.txt，同名追加 _N（mod.rs:441-576）。
- [x] 错误：不支持格式 `不支持的导出格式: {format}`；文件夹非 zip、资源格式不支持用 DstuError Display；仓储/内容/文件读写保留步骤上下文；题库导出钩子缺失 `Internal error: 题目导出服务未注册`（exam_adapter.rs:142）。
- [x] 事件：无；入口记录 path/format（mod.rs:309-314）。
- [x] DB 读写：只读各类型元数据、内容、blob 路径、题库规范上下文；不改 DB。文件夹导出写系统临时 ZIP，全失败时删除；原始文件返回现存 blob 路径（各 adapter）。
- [x] 取消/并发：无取消协议；导出命令返回 Promise，ZIP 使用 F4 的 ZipWriter 默认 deflated、1980 时间、Unix 0644，单项失败不阻止后续项。
- [x] 时间/ID：临时名 dstu_folder_export_{folderId}_{毫秒}.zip，999 次重名后使用毫秒；不生成资源 ID（mod.rs:371-394、462-466）。

## 命令 `dstu_export_formats`

<!-- BEGIN GENERATED:cmd:dstu_export_formats -->
- Rust：`src-tauri/crates/dstu-vfs/src/dstu/export/mod.rs:275` · async
- 前端：app（1 处，例 `src/dstu/api.ts:1077`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：path: string
  - 结果：string[] · 错误：string · 注入：state
<!-- END GENERATED:cmd:dstu_export_formats -->

- [x] 输入：mod.rs:275-300；先 extract_resource_info 校验，再按原始 path 末段前缀推断节点类型，不检查资源存在。
- [x] 输出：note/essay=[markdown]，textbook/file=[original,markdown]，exam/translation/mindmap=[markdown,original]，image=[original]，folder=[zip]；顺序固定。
- [x] 错误：路径解析 Display、`路径为空` 或 `无法从 ID '{id}' 推断资源类型`（mod.rs:584-604）。
- [x] 事件：无；入口记录 path（mod.rs:280）。
- [x] DB 读写：无（注入的数据库在 Rust 中未使用）。
- [x] 取消/并发：无取消点、无共享状态。
- [x] 时间/ID：无。

## 命令 `dstu_folder_add_item`

<!-- BEGIN GENERATED:cmd:dstu_folder_add_item -->
- Rust：`src-tauri/crates/dstu-vfs/src/dstu/folder_handlers.rs:471` · async
- 前端：app（1 处，例 `src/dstu/api/folderApi.ts:222`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：folderId?: string | null, itemType: string, itemId: string
  - 结果：VfsFolderItem · 错误：string · 注入：state
<!-- END GENERATED:cmd:dstu_folder_add_item -->

- [x] 输入：folder_handlers.rs:472-502；folderId 可空，itemType 必须为 note/textbook/exam/translation/essay/image/file/mindmap，itemId 原样使用。
- [x] 输出：folder_handlers.rs:524-535；返回新建 VfsFolderItem（camelCase，保留调用方传入的 itemType）。
- [x] 错误：folder_handlers.rs:496-542；非法类型 "参数格式错误"、目标文件夹不存在 "目标文件夹不存在"，仓储错误按 VfsError Display 返回。
- [x] 事件：无（folder_handlers.rs:472-543）。
- [x] DB 读写：folder_handlers.rs:508-531 → folder_repo.rs:2680-2710；先 DELETE 同 item_id+canonical type，再 INSERT OR REPLACE folder_items；textbook 落库为 file。
- [x] 取消/并发：spawn_blocking 单连接单事务外执行；无显式取消点，依赖数据库写锁。
- [x] 时间/ID：VfsFolderItem::new 生成 fi_+nanoid(10) 与毫秒 createdAt（types.rs:1378-1397）。

## 命令 `dstu_folder_create`

<!-- BEGIN GENERATED:cmd:dstu_folder_create -->
- Rust：`src-tauri/crates/dstu-vfs/src/dstu/folder_handlers.rs:135` · async
- 前端：app（1 处，例 `src/dstu/api/folderApi.ts:77`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：title: string, parentId?: string | null, icon?: string | null, color?: string | null
  - 结果：VfsFolder · 错误：string · 注入：state
<!-- END GENERATED:cmd:dstu_folder_create -->

- [x] 输入：folder_handlers.rs:136-188；title 非空、≤100 字节、无控制/零宽/路径分隔符；icon ≤50 字节；color 仅 #RRGGBB 或预设名；parentId "root"/"" 视为根。
- [x] 输出：folder_handlers.rs:207-215；VfsFolder camelCase，None 字段省略。
- [x] 错误：folder_handlers.rs:167-222；标题/图标/颜色校验字符串，父不存在 INVALID_PARENT，深度 FOLDER_DEPTH_EXCEEDED，数量 FOLDER_COUNT_EXCEEDED。
- [x] 事件：无（folder_handlers.rs:136-224）。
- [x] DB 读写：folder_repo.rs:317-367；检查父级 active、深度 <10、active 总数 <500，再 INSERT folders。
- [x] 取消/并发：spawn_blocking；校验与插入非原子，并发下依赖数据库约束。
- [x] 时间/ID：VfsFolder::new 生成 fld_+nanoid(10)，created_at/updated_at 同一毫秒时间戳（types.rs:1312-1342）。

## 命令 `dstu_folder_delete`

<!-- BEGIN GENERATED:cmd:dstu_folder_delete -->
- Rust：`src-tauri/crates/dstu-vfs/src/dstu/folder_handlers.rs:336` · async
- 前端：app（1 处，例 `src/dstu/api/folderApi.ts:138`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：folderId: string
  - 结果：null · 错误：string · 注入：state
<!-- END GENERATED:cmd:dstu_folder_delete -->

- [x] 输入：folder_handlers.rs:337-364；folderId 原样。
- [x] 输出：folder_handlers.rs:350-356；成功 null。
- [x] 错误：folder_repo.rs:1230-1321；不存在 FOLDER_NOT_FOUND；已软删则幂等成功。
- [x] 事件：无（folder_handlers.rs:337-368）。
- [x] DB 读写：folder_repo.rs:1230-1321；SAVEPOINT 内软删文件夹、递归子文件夹、folder_items，并级联软删仅属本树的 note/file/image/exam/translation/essay/mindmap 实体。
- [x] 取消/并发：SAVEPOINT 原子回滚；未使用 BEGIN IMMEDIATE。
- [x] 时间/ID：deleted_at 为 ISO-8601 毫秒文本，updated_at 为毫秒整数（folder_repo.rs:1234-1244）。

## 命令 `dstu_folder_get`

<!-- BEGIN GENERATED:cmd:dstu_folder_get -->
- Rust：`src-tauri/crates/dstu-vfs/src/dstu/folder_handlers.rs:233` · async
- 前端：app（1 处，例 `src/dstu/api/folderApi.ts:99`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：folderId: string
  - 结果：VfsFolder | null · 错误：string · 注入：state
<!-- END GENERATED:cmd:dstu_folder_get -->

- [x] 输入：folder_handlers.rs:234-262；folderId 原样。
- [x] 输出：folder_handlers.rs:245-261；VfsFolder 或 null，已软删文件夹仍可读出。
- [x] 错误：仓储 VfsError::Database Display。
- [x] 事件：无（folder_handlers.rs:234-266）。
- [x] DB 读写：folder_repo.rs:378-410；SELECT folders WHERE id=?1，不筛 deleted_at；TEXT 时间戳用 strftime 转毫秒。
- [x] 取消/并发：spawn_blocking 只读。
- [x] 时间/ID：无写入；created_at/updated_at 毫秒整数。

## 命令 `dstu_folder_get_all_resources`

<!-- BEGIN GENERATED:cmd:dstu_folder_get_all_resources -->
- Rust：`src-tauri/crates/dstu-vfs/src/dstu/folder_handlers.rs:762` · async
- 前端：app（1 处，例 `src/dstu/api/folderApi.ts:365`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：folderId: string, includeSubfolders: boolean, includeContent: boolean
  - 结果：FolderResourcesResult · 错误：string · 注入：state
<!-- END GENERATED:cmd:dstu_folder_get_all_resources -->

- [x] 输入：folder_handlers.rs:763-772；folderId、includeSubfolders、includeContent。
- [x] 输出：folder_handlers.rs:784-795；FolderResourcesResult（folderId/folderTitle/path/totalCount/resources）。
- [x] 错误：folder_repo.rs:2445-2449；文件夹不存在 "Folder not found: {id}"，其余 Database Display。
- [x] 事件：无（folder_handlers.rs:763-805）。
- [x] DB 读写：folder_repo.rs:2438-2530；读 folders、递归/单层 folder_items、可按需读 resources.data，不写库。
- [x] 取消/并发：spawn_blocking 只读；超过 50 条仅告警不截断（folder_repo.rs:2464-2473）。
- [x] 时间/ID：无新 ID；路径由 folders.title 用 / 连接，资源路径追加标题。

## 命令 `dstu_folder_get_breadcrumbs`

<!-- BEGIN GENERATED:cmd:dstu_folder_get_breadcrumbs -->
- Rust：`src-tauri/crates/dstu-vfs/src/dstu/folder_handlers.rs:910` · async
- 前端：app（1 处，例 `src/dstu/api/folderApi.ts:421`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：folderId: string
  - 结果：BreadcrumbItem[] · 错误：string · 注入：state
<!-- END GENERATED:cmd:dstu_folder_get_breadcrumbs -->

- [x] 输入：folder_handlers.rs:911-920；folderId 原样。
- [x] 输出：folder_handlers.rs:952-966；从根到当前文件夹的 {id,name} 数组，不含科目根。
- [x] 错误：folder_handlers.rs:923-971；连接失败返回 VfsError Display，查询失败 "Query failed: …"，准备失败 "数据库查询失败"。
- [x] 事件：无（folder_handlers.rs:911-976）。
- [x] DB 读写：folder_handlers.rs:932-961；递归 CTE 向上追溯，depth<11，ORDER BY depth DESC，只读。
- [x] 取消/并发：spawn_blocking 只读。
- [x] 时间/ID：无写入；name 取 folders.title。

## 命令 `dstu_folder_get_items`

<!-- BEGIN GENERATED:cmd:dstu_folder_get_items -->
- Rust：`src-tauri/crates/dstu-vfs/src/dstu/folder_handlers.rs:704` · async
- 前端：app（1 处，例 `src/dstu/api/folderApi.ts:341`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：folderId?: string | null
  - 结果：VfsFolderItem[] · 错误：string · 注入：state
<!-- END GENERATED:cmd:dstu_folder_get_items -->

- [x] 输入：folder_handlers.rs:705-710；folderId 可空（null 表示根级）。
- [x] 输出：folder_handlers.rs:716-725；VfsFolderItem[]，按 sort_order 升序。
- [x] 错误：仓储 VfsError::Database Display。
- [x] 事件：无（folder_handlers.rs:705-730）。
- [x] DB 读写：folder_repo.rs:2921-2949；SELECT active folder_items WHERE folder_id IS ?1 ORDER BY sort_order ASC，只读。
- [x] 取消/并发：spawn_blocking 只读。
- [x] 时间/ID：created_at 兼容 INTEGER/TEXT（含秒级、RFC3339、SQL/日期格式），无效回落 0。

## 命令 `dstu_folder_get_tree`

<!-- BEGIN GENERATED:cmd:dstu_folder_get_tree -->
- Rust：`src-tauri/crates/dstu-vfs/src/dstu/folder_handlers.rs:669` · async
- 前端：app（1 处，例 `src/dstu/api/folderApi.ts:327`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：（无）
  - 结果：FolderTreeNode[] · 错误：string · 注入：state
<!-- END GENERATED:cmd:dstu_folder_get_tree -->

- [x] 输入：folder_handlers.rs:670-675；无参数。
- [x] 输出：folder_handlers.rs:677-694；FolderTreeNode[]，含 folder/children/items。
- [x] 错误：仓储 VfsError::Database Display。
- [x] 事件：无（folder_handlers.rs:670-695）。
- [x] DB 读写：folder_repo.rs:2861-2906；读取全部 active folders 与各文件夹 active items 构建树，只读。
- [x] 取消/并发：spawn_blocking 只读。
- [x] 时间/ID：无写入；节点按 folder.sort_order 稳定排序。

## 命令 `dstu_folder_list`

<!-- BEGIN GENERATED:cmd:dstu_folder_list -->
- Rust：`src-tauri/crates/dstu-vfs/src/dstu/folder_handlers.rs:637` · async
- 前端：app（1 处，例 `src/dstu/api/folderApi.ts:313`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：（无）
  - 结果：VfsFolder[] · 错误：string · 注入：state
<!-- END GENERATED:cmd:dstu_folder_list -->

- [x] 输入：folder_handlers.rs:638-643；无参数。
- [x] 输出：folder_handlers.rs:645-662；全部 active VfsFolder[]。
- [x] 错误：仓储 VfsError::Database Display。
- [x] 事件：无（folder_handlers.rs:638-663）。
- [x] DB 读写：folder_repo.rs:488-522；SELECT folders WHERE deleted_at IS NULL ORDER BY sort_order, created_at，只读。
- [x] 取消/并发：spawn_blocking 只读。
- [x] 时间/ID：无写入；TEXT 时间戳转毫秒。

## 命令 `dstu_folder_move`

<!-- BEGIN GENERATED:cmd:dstu_folder_move -->
- Rust：`src-tauri/crates/dstu-vfs/src/dstu/folder_handlers.rs:382` · async
- 前端：app（1 处，例 `src/dstu/api/folderApi.ts:165`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：folderId: string, newParentId?: string | null
  - 结果：null · 错误：string · 注入：state
<!-- END GENERATED:cmd:dstu_folder_move -->

- [x] 输入：folder_handlers.rs:383-398；folderId、newParentId 可空；自引用先返回 INVALID_PARENT。
- [x] 输出：folder_handlers.rs:404-412；成功 null。
- [x] 错误：folder_repo.rs:2063-2098；文件夹不存在 FOLDER_NOT_FOUND，父不存在/移入后代 INVALID_PARENT，深度 FOLDER_DEPTH_EXCEEDED。
- [x] 事件：无（folder_handlers.rs:383-417）。
- [x] DB 读写：folder_repo.rs:2100-2134；UPDATE folders.parent_id，清空子树 folder_items.cached_path，并尽力清理 path_cache。
- [x] 取消/并发：spawn_blocking；检查与更新非原子，依赖数据库约束。
- [x] 时间/ID：updated_at 更新为当前毫秒；无新 ID。

## 命令 `dstu_folder_move_item`

<!-- BEGIN GENERATED:cmd:dstu_folder_move_item -->
- Rust：`src-tauri/crates/dstu-vfs/src/dstu/folder_handlers.rs:588` · async
- 前端：app（1 处，例 `src/dstu/api/folderApi.ts:276`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：itemType: string, itemId: string, newFolderId?: string | null
  - 结果：null · 错误：string · 注入：state
<!-- END GENERATED:cmd:dstu_folder_move_item -->

- [x] 输入：folder_handlers.rs:589-598；itemType/itemId 原样，newFolderId 可空。
- [x] 输出：folder_handlers.rs:608-614；成功 null。
- [x] 错误：folder_repo.rs:3010-3017；目标文件夹不存在 FOLDER_NOT_FOUND；条目不存在时自动插入而非报错。
- [x] 事件：无（folder_handlers.rs:589-627）。
- [x] DB 读写：folder_repo.rs:3003-3048；UPDATE active folder_items，0 行时 INSERT 新记录；随后 mark_item_indexes_pending 更新 resources 索引状态。
- [x] 取消/并发：spawn_blocking；UPDATE 后 INSERT 非原子。
- [x] 时间/ID：缺记录时生成 fi_+nanoid(10)，created_at 当前毫秒，sort_order 0。

## 命令 `dstu_folder_remove_item`

<!-- BEGIN GENERATED:cmd:dstu_folder_remove_item -->
- Rust：`src-tauri/crates/dstu-vfs/src/dstu/folder_handlers.rs:553` · async
- 前端：app（1 处，例 `src/dstu/api/folderApi.ts:243`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：itemType: string, itemId: string
  - 结果：null · 错误：string · 注入：state
<!-- END GENERATED:cmd:dstu_folder_remove_item -->

- [x] 输入：folder_handlers.rs:555-562；itemType/itemId 原样，不做类型白名单。
- [x] 输出：folder_handlers.rs:566-578；成功 null。
- [x] 错误：仅仓储 VfsError::Database Display；不存在也成功。
- [x] 事件：无（folder_handlers.rs:555-580）。
- [x] DB 读写：folder_repo.rs:2964-2977；DELETE 同 item_id+canonical item_type 的 folder_items（含已软删）。
- [x] 取消/并发：spawn_blocking 单条 DELETE。
- [x] 时间/ID：无写入时间或新 ID；textbook 规范化为 file。

## 命令 `dstu_folder_rename`

<!-- BEGIN GENERATED:cmd:dstu_folder_rename -->
- Rust：`src-tauri/crates/dstu-vfs/src/dstu/folder_handlers.rs:273` · async
- 前端：app（1 处，例 `src/dstu/api/folderApi.ts:118`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：folderId: string, title: string
  - 结果：null · 错误：string · 注入：state
<!-- END GENERATED:cmd:dstu_folder_rename -->

- [x] 输入：folder_handlers.rs:274-291；folderId、title 同创建校验。
- [x] 输出：folder_handlers.rs:310-318；成功 null。
- [x] 错误：folder_handlers.rs:298-323；不存在 "资源不存在"，并发版本冲突 CONFLICT(folders.conflict)，校验字符串同创建。
- [x] 事件：无（folder_handlers.rs:274-327）。
- [x] DB 读写：folder_repo.rs:1150-1214；仅条件更新 title/updated_at（deleted_at IS NULL 且 updated_at=旧版本），成功后清空子树 cached_path 并清理 path_cache。
- [x] 取消/并发：乐观并发令牌 = 读取到的 updated_at；新版本至少 expected+1；未包事务。
- [x] 时间/ID：updated_at 取 max(now, expected+1) 毫秒；无新 ID。

## 命令 `dstu_folder_reorder`

<!-- BEGIN GENERATED:cmd:dstu_folder_reorder -->
- Rust：`src-tauri/crates/dstu-vfs/src/dstu/folder_handlers.rs:817` · async
- 前端：app（1 处，例 `src/dstu/api/folderApi.ts:387`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：folderIds: string[]
  - 结果：null · 错误：string · 注入：state
<!-- END GENERATED:cmd:dstu_folder_reorder -->

- [x] 输入：folder_handlers.rs:818-825；folderIds 按期望顺序。
- [x] 输出：folder_handlers.rs:829-837；成功 null。
- [x] 错误：仅仓储 VfsError::Database Display；不校验 ID 存在。
- [x] 事件：无（folder_handlers.rs:818-848）。
- [x] DB 读写：folder_repo.rs:2726-2743；按索引写 sort_order 与 updated_at；≤100 条逐条 UPDATE，>100 条 CASE WHEN 分批。
- [x] 取消/并发：spawn_blocking；多行更新非事务，失败可能部分生效。
- [x] 时间/ID：所有行共用当前毫秒 updated_at；无新 ID。

## 命令 `dstu_folder_reorder_items`

<!-- BEGIN GENERATED:cmd:dstu_folder_reorder_items -->
- Rust：`src-tauri/crates/dstu-vfs/src/dstu/folder_handlers.rs:858` · async
- 前端：app（1 处，例 `src/dstu/api/folderApi.ts:437`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：folderId?: string | null, itemIds: string[]
  - 结果：null · 错误：string · 注入：state
<!-- END GENERATED:cmd:dstu_folder_reorder_items -->

- [x] 输入：folder_handlers.rs:859-866；folderId 仅日志，itemIds 按期望顺序。
- [x] 输出：folder_handlers.rs:871-877；成功 null。
- [x] 错误：仅仓储 VfsError::Database Display；不校验归属或存在。
- [x] 事件：无（folder_handlers.rs:859-884）。
- [x] DB 读写：folder_repo.rs:2759-2780；按索引写 folder_items.sort_order 与 updated_at，分批策略同上。
- [x] 取消/并发：spawn_blocking；多行更新非事务。
- [x] 时间/ID：所有行共用当前毫秒 updated_at；无新 ID。

## 命令 `dstu_folder_set_expanded`

<!-- BEGIN GENERATED:cmd:dstu_folder_set_expanded -->
- Rust：`src-tauri/crates/dstu-vfs/src/dstu/folder_handlers.rs:424` · async
- 前端：app（1 处，例 `src/dstu/api/folderApi.ts:197`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：folderId: string, isExpanded: boolean
  - 结果：null · 错误：string · 注入：state
<!-- END GENERATED:cmd:dstu_folder_set_expanded -->

- [x] 输入：folder_handlers.rs:425-432；folderId、isExpanded。
- [x] 输出：folder_handlers.rs:437-446；成功 null。
- [x] 错误：folder_repo.rs:1997-2006；不存在 FOLDER_NOT_FOUND。
- [x] 事件：无（folder_handlers.rs:425-450）。
- [x] DB 读写：folder_repo.rs:1990-2012；UPDATE folders SET is_expanded, updated_at WHERE id。
- [x] 取消/并发：spawn_blocking 单条 UPDATE。
- [x] 时间/ID：updated_at 当前毫秒；无新 ID。

## 命令 `dstu_get`

<!-- BEGIN GENERATED:cmd:dstu_get -->
- Rust：`src-tauri/crates/dstu-vfs/src/dstu/handlers.rs:467` · async
- 前端：app（2 处，例 `src/dstu/api.ts:277`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：path: string
  - 结果：DstuNode | null · 错误：string · 注入：state
<!-- END GENERATED:cmd:dstu_get -->

- [x] 输入：handlers.rs:467-479；path 支持简化 ID（可无前导 /）、/{folder_path}/{id}、纯 UUID；由 path_utils.rs:123-169 提取类型与 ID。
- [x] 输出：handlers.rs:481-660；按 notes/textbooks/exams/translations/essays/folders/mindmaps/files 分支返回 DstuNode，未找到 null；essays 先 essays 后 essay_sessions。
- [x] 错误：path_utils.rs:123-169 的 DstuError Display（Invalid DSTU path: …），以及各仓储 VfsError Display；未知类型返回 null。
- [x] 事件：无（handlers.rs:467-660）。
- [x] DB 读写：note_repo.rs:920-934、textbook_repo.rs:425-445、exam_repo.rs:154-172、translation_repo.rs:255-270、essay_repo.rs:150-167/869-887、mindmap_repo.rs:889-918、file_repo.rs:729-749；全部只读；file 读取不筛 deleted_at，其余筛 deleted_at IS NULL。
- [x] 取消/并发：spawn_blocking 只读，无取消点。
- [x] 时间/ID：无写入；folder 节点用 folders.created_at/updated_at，其余用 parse_timestamp 转换记录时间；UUID 文件夹缺失时按 textbook/note/exam/translation/essay 顺序回退。

## 命令 `dstu_get_content`

<!-- BEGIN GENERATED:cmd:dstu_get_content -->
- Rust：`src-tauri/crates/dstu-vfs/src/dstu/handlers.rs:3289` · async
- 前端：app（1 处，例 `src/dstu/api.ts:627`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：path: string
  - 结果：string · 错误：string · 注入：state
<!-- END GENERATED:cmd:dstu_get_content -->

- [x] 输入：handlers.rs:3290-3309；path 经 path_utils.rs:123-169 提取复数类型与 ID。
- [x] 输出：content_helpers.rs:148-395；notes→resources.data，translations→resources.data，exams→format_exam_preview_for_read，essay_session_*→轮次汇总（20000 字符/10 轮截断），essay_*→单篇正文，mindmaps→resources.data，files/textbooks→OCR/extracted_text 取大者后兜底 "[文档: 文件名]"。
- [x] 错误：DstuError NotFound（"Resource not found: {id}"）与 InvalidNodeType；VfsError Display；笔记存在但资源缺失返回 "Database error: Missing resource for note {id}"。
- [x] 事件：无（handlers.rs:3290-3309）。
- [x] DB 读写：note_repo.rs:981-1045、translation_repo.rs:316-340、exam_repo.rs:154-172、essay_repo.rs:113-196、mindmap_repo.rs:934-945、ref_handlers.rs:1427-1468；全部只读；img_ 被 infer 为 files，images 分支仅内部可达。
- [x] 取消/并发：spawn_blocking 只读。
- [x] 时间/ID：无写入、无新 ID；图片无 OCR 时读 blobs 返回 base64（未移植 DocumentParser 原生解析）。

## 命令 `dstu_get_exam_content`

<!-- BEGIN GENERATED:cmd:dstu_get_exam_content -->
- Rust：`src-tauri/crates/dstu-vfs/src/dstu/handlers.rs:3323` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：examId: string, isMultimodal: boolean
  - 结果：ContentBlock[] · 错误：string · 注入：state
<!-- END GENERATED:cmd:dstu_get_exam_content -->

- [x] 输入：examId 原样查询、isMultimodal 控制图片；优先规范题库上下文，否则按 ExamSheetPreviewResult serde 默认值解析（exam_formatter.rs:32-74；models.rs:397-491）。
- [x] 输出：ContentBlock[]，text 用 XML（转义 &<>单双引号）；规范题库为 JSON/XML 后接去重图片；旧预览多模态为开始标签、逐页标签/图片/题目/结束标签，bbox 为 f32 三位小数；多模态 exam_name 按 Rust 不转义（exam_formatter.rs:76-216）。
- [x] 错误：数据查询 `获取题目集数据失败: ...`、`题目集不存在: ...`、`解析 preview_json 失败: ...`；规范图片失败中止 `题目/材料必要图片缺失: ...`；旧预览图片失败 warn 并返回占位文本（exam_formatter.rs:38-66、109-124、224-238）。
- [x] 事件：无；入口 info，旧页面图片失败 warn。
- [x] DB 读写：只读 exam_sheets/questions/题库材料与分组/blobs；图片读物理文件并 base64，默认 MIME image/jpeg；不写 DB（exam_formatter.rs:218-240、qbank_read.rs）。
- [x] 取消/并发：无取消点；同一次命令读取当前数据库和图片文件。
- [x] 时间/ID：无生成。

## 命令 `dstu_get_path_by_id`

<!-- BEGIN GENERATED:cmd:dstu_get_path_by_id -->
- Rust：`src-tauri/crates/dstu-vfs/src/dstu/handlers.rs:6625` · async
- 前端：app（1 处，例 `src/dstu/api/pathApi.ts:229`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：resourceId: string
  - 结果：string · 错误：string · 注入：state
<!-- END GENERATED:cmd:dstu_get_path_by_id -->

- [x] 输入：handlers.rs:6625-6650；resourceId 原样。
- [x] 输出：ref_handlers.rs:1979-1016；未知前缀返回 resourceId 本身；根级资源返回 resourceId（无前导斜杠）；有文件夹返回 "{folder_path}/{resourceId}"。
- [x] 错误：ref_handlers.rs:1980-1988；连接或 CTE 查询失败按 VfsError Display。
- [x] 事件：无（handlers.rs:6625-6650）。
- [x] DB 读写：ref_handlers.rs:992-1039；按 canonical item_type 查 folder_items.folder_id，再递归读 folders.title，只读。
- [x] 取消/并发：spawn_blocking 只读。
- [x] 时间/ID：无写入、无新 ID。

## 命令 `dstu_get_resource_by_path`

<!-- BEGIN GENERATED:cmd:dstu_get_resource_by_path -->
- Rust：`src-tauri/crates/dstu-vfs/src/dstu/handlers.rs:6042` · async
- 前端：app（1 处，例 `src/dstu/api/pathApi.ts:108`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：path: string
  - 结果：DstuNode | null · 错误：string · 注入：state
<!-- END GENERATED:cmd:dstu_get_resource_by_path -->

- [x] 输入：handlers.rs:6042-6055；path 先经 dstu_parse_path（handlers.rs:5851-5916）。
- [x] 输出：handlers.rs:6057-6122；根返回 root 文件夹节点，虚拟路径返回 @name 文件夹节点；资源按 note/textbook/exam/translation/essay/folder/file 类型返回；纯文件夹路径或未知类型 null。
- [x] 错误：各仓储 VfsError Display；路径解析本身不报错。
- [x] 事件：无（handlers.rs:6042-6130）。
- [x] DB 读写：handlers.rs:6072-6120；note/file/exam/translation/essay_session/folder 只读查询；essay 分支只查 essay_sessions，不查 essays；textbook 分支对 tb_ 不可达（parse 把 tb_ 归为 file）。
- [x] 取消/并发：spawn_blocking 只读。
- [x] 时间/ID：无写入；根/虚拟/文件夹节点时间取当前毫秒，资源节点由转换器按记录时间生成。

## 命令 `dstu_get_resource_location`

<!-- BEGIN GENERATED:cmd:dstu_get_resource_location -->
- Rust：`src-tauri/crates/dstu-vfs/src/dstu/handlers.rs:5973` · async
- 前端：app（1 处，例 `src/dstu/api/pathApi.ts:90`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：resourceId: string
  - 结果：ResourceLocation · 错误：string · 注入：state
<!-- END GENERATED:cmd:dstu_get_resource_location -->

- [x] 输入：handlers.rs:5973-6038；resourceId 原样。
- [x] 输出：handlers.rs:6029-6037；ResourceLocation{id,resourceType,folderId,folderPath,fullPath,hash:null}。
- [x] 错误：handlers.rs:6000-6011；连接/查询失败按 VfsError Display；未知类型 resourceType="unknown"。
- [x] 事件：无（handlers.rs:5973-6038）。
- [x] DB 读写：handlers.rs:6000-6030；按推断类型（tb_/att_/file_ 均为 file）查 folder_items active 行的 folder_id/cached_path，再读 folders 路径，只读。
- [x] 取消/并发：spawn_blocking 只读。
- [x] 时间/ID：无写入、无新 ID；hash 恒为 null。

## 命令 `dstu_list`

<!-- BEGIN GENERATED:cmd:dstu_list -->
- Rust：`src-tauri/crates/dstu-vfs/src/dstu/handlers.rs:171` · async
- 前端：app（1 处，例 `src/dstu/api.ts:258`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：path: string, options?: DstuListOptions | null
  - 结果：DstuNode[] · 错误：string · 注入：state
<!-- END GENERATED:cmd:dstu_list -->

- [x] 输入：handlers.rs:172-187；path 仅记录日志（handlers.rs:180-185），options 可空；folderId 缺失/""/root/null 视为根。
- [x] 输出：handlers.rs:190-446；收藏模式（8 类逐类分页后过滤收藏/隐藏名再排序，不分页）；typeFilter 智能文件夹；根目录 folders+根 items+未分配 notes/textbooks/exams/translations/essays；文件夹子目录+资源；最终隐藏 __*__ 名并按 sortBy/sortOrder 排序分页。
- [x] 错误：handlers.rs:305-315 文件夹不存在返回 "文件夹不存在"；仓储 VfsError Display；未知 item_type 的 fetch 返回 null。
- [x] 事件：无（handlers.rs:172-446）。
- [x] DB 读写：list_helpers.rs:21-251 与 folder_repo.rs:536-574/858-891/897-913；note 搜索优先 notes_fts trigram（<3 字符回退 LIKE），教材列表不筛 tb_ 前缀、文件列表按 type=document/image，mindmap 列表不分页；资源 path 由 ref_handlers.rs:981-1016 重算；全部只读。
- [x] 取消/并发：spawn_blocking 只读。
- [x] 时间/ID：文件夹节点用 folders.created_at/updated_at；资源节点由转换器按记录时间生成；无写入、无新 ID。

## 命令 `dstu_list_deleted`

<!-- BEGIN GENERATED:cmd:dstu_list_deleted -->
- Rust：`src-tauri/crates/dstu-vfs/src/dstu/handlers.rs:4857` · async
- 前端：app（1 处，例 `src/dstu/api.ts:1013`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：resourceType: string, limit?: integer(u32) | null, offset?: integer(u32) | null
  - 结果：DstuNode[] · 错误：string · 注入：state
<!-- END GENERATED:cmd:dstu_list_deleted -->

- [x] 输入：handlers.rs:4858-4867；resourceType 为 notes/textbooks/exams/translations/essays，limit 默认 100、offset 默认 0。
- [x] 输出：handlers.rs:4869-5089；各类型手工构造 DstuNode（path=/{id}，previewType=markdown/pdf/exam/translation/essay），essays 只列 essay_sessions。
- [x] 错误：handlers.rs:5085-5087 其他类型返回 "Resource type '{type}' does not support list_deleted operation"；仓储错误按 VfsError Display。
- [x] 事件：无（handlers.rs:4858-5093）。
- [x] DB 读写：note_repo.rs:2140-2166、textbook_repo.rs:1246-1266（status=deleted 且 id LIKE 'tb_%'）、exam_repo.rs:1291-1310、translation_repo.rs:945-964、essay_repo.rs:1205-1228；全部按 deleted_at DESC 分页只读。
- [x] 取消/并发：spawn_blocking 只读。
- [x] 时间/ID：仅用 chrono parse_from_rfc3339 解析 created_at/updated_at，失败写 0；translation 的 updatedAt 复用 created_at；translation/essay 元数据保留蛇形键。

## 命令 `dstu_list_trash`

<!-- BEGIN GENERATED:cmd:dstu_list_trash -->
- Rust：`src-tauri/crates/dstu-vfs/src/dstu/trash_handlers.rs:237` · async
- 前端：app（1 处，例 `src/dstu/api/trashApi.ts:88`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：limit?: integer(u32) | null, offset?: integer(u32) | null, itemTypes?: string[] | null
  - 结果：DstuNode[] · 错误：DstuError · 注入：state
<!-- END GENERATED:cmd:dstu_list_trash -->

- [x] 输入：trash_handlers.rs:238-546；limit 默认100、offset默认0，类型过滤同 wants_trash_type。
- [x] 输出：每种类型先取 limit+offset 项，再按 updatedAt 降序全局分页；节点路径 /_trash/{id}，资源类型与回收站转换器一致。
- [x] 错误：查询失败映射 DstuError::VfsError，非 string；时间解析失败为0，translation updatedAt 失败回退 createdAt。
- [x] 事件：无。
- [x] DB 读写：只读 deleted folders/notes/textbooks/exams/translations/essay_sessions/files/mindmaps。
- [x] 取消/并发：无写事务、无取消。
- [x] 时间/ID：使用原创建/更新时间，不生成 ID。

## 命令 `dstu_move`

<!-- BEGIN GENERATED:cmd:dstu_move -->
- Rust：`src-tauri/crates/dstu-vfs/src/dstu/handlers.rs:1770` · async
- 前端：app（1 处，例 `src/dstu/api.ts:472`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：src: string, dst: string
  - 结果：DstuNode · 错误：string · 注入：window, state
<!-- END GENERATED:cmd:dstu_move -->

- [x] 输入：handlers.rs:1771-1840；src/dst 均经 `extract_resource_info`；dst 为空串或 `/` 表示根级，否则必须是 folders 类型（`Destination must be a folder`）。资源类型映射为 canonical item_type：notes→note、textbooks→textbook、exams→exam、translations→translation、essays→essay、folders→folder、mindmaps→mindmap、files/images/attachments→file，其余 `Invalid node type: {type}`。
- [x] 输出：移动后按源资源复数类型回读 DstuNode（`get_resource_by_type_and_id`），回读为空 → `Resource not found: {src}`。
- [x] 错误：路径解析错误原样透传；目标非文件夹 `Destination must be a folder`；folder_repo 的错误直接 `to_string`（如 `FOLDER_NOT_FOUND: fld_x`）；回读失败为对应 VfsError Display。
- [x] 事件：handlers.rs:1860-1864 `emit_watch_event(moved(src, node.path, node))`；node.path 为回读节点的简单路径 `/{id}`，oldPath 为入参 src。
- [x] DB 读写：folder_repo.rs:2982-3048（更新 `folder_items.folder_id`、清空 cached_path、缺失时插入 `fi_` 记录、`mark_item_indexes_pending_with_conn` 重置索引状态）。
- [x] 取消/并发：同步命令；folder_repo 的 UPDATE 仅按 `item_id + item_type + deleted_at IS NULL`，无版本号校验。
- [x] 时间/ID：新建 folder_items 记录 id=`fi_`+nanoid(10)、created_at=毫秒、sort_order=0；无其他时间戳写入。

## 命令 `dstu_move_many`

<!-- BEGIN GENERATED:cmd:dstu_move_many -->
- Rust：`src-tauri/crates/dstu-vfs/src/dstu/handlers.rs:5530` · async
- 前端：app（1 处，例 `src/dstu/api.ts:895`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：paths: string[], destFolder: string
  - 结果：integer(usize) · 错误：string · 注入：window, state
<!-- END GENERATED:cmd:dstu_move_many -->

- [x] 输入：handlers.rs:5531-5627；paths 最多100；destFolder trim 后空或 / 为根，否则必须是 folders 类型。
- [x] 输出：成功移动的数量；坏路径、未知类型跳过，单项失败 warn 后继续。
- [x] 错误：数量超限中文文案；目标解析错误原样；非文件夹 `Destination must be a folder`。
- [x] 事件：每个移动成功且回读得到节点的条目发 moved，oldPath 为入参，path 为节点路径。
- [x] DB 读写：folder_items 成员移动委托 L11 folders.moveItemByItemId；images/attachments 归一为 file；回读只读资源表。
- [x] 取消/并发：逐项独立提交；无全批事务、无取消（handlers.rs:5573-5620）。
- [x] 时间/ID：时间由仓储更新；命令不生成 ID。

## 命令 `dstu_move_to_folder`

<!-- BEGIN GENERATED:cmd:dstu_move_to_folder -->
- Rust：`src-tauri/crates/dstu-vfs/src/dstu/handlers.rs:6137` · async
- 前端：app（1 处，例 `src/dstu/api/pathApi.ts:141`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：resourceId: string, targetFolderId?: string | null
  - 结果：ResourceLocation · 错误：string · 注入：window, state
<!-- END GENERATED:cmd:dstu_move_to_folder -->

- [x] 输入：handlers.rs:6137-6247；resourceId、targetFolderId（缺失/null 为根目录）。
- [x] 输出：handlers.rs:6218-6240；ResourceLocation{id,resourceType,folderId,folderPath,fullPath,hash:null}。
- [x] 错误：handlers.rs:6167-6231；连接/查询/写入失败按字符串返回；folder_items 唯一约束可能报错。
- [x] 事件：handlers.rs:6233-6245；发 dstu:change:{newPath} 与 dstu:change，载荷 moved{oldPath,path,node}，node 名称用 ID。
- [x] DB 读写：handlers.rs:6168-6221；按 canonical item_type+item_id 查旧路径与存在性；存在则 UPDATE（WHERE 仅 item_id，不含 item_type），否则 INSERT；cached_path 写入目标全路径。
- [x] 取消/并发：spawn_blocking 单连接，无事务；检查与写入非原子。
- [x] 时间/ID：插入项 createdAt/updatedAt 当前毫秒，id 为 fi_+nanoid(10)；更新只写 updated_at。

## 命令 `dstu_parse_path`

<!-- BEGIN GENERATED:cmd:dstu_parse_path -->
- Rust：`src-tauri/crates/dstu-vfs/src/dstu/handlers.rs:5851` · async
- 前端：app（1 处，例 `src/dstu/api/pathApi.ts:43`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：path: string
  - 结果：DstuParsedPath · 错误：string
<!-- END GENERATED:cmd:dstu_parse_path -->

- [x] 输入：handlers.rs:5852-5866；path 为字符串，空串及 / 为根；补前导 /、移除全部尾部 /，不 trim 空白。
- [x] 输出：types.rs:686-745；camelCase，三个 Option 字段保留 null；tb_/att_/file_ 均为 file，img_ 不识别；任意 /@ 后缀为虚拟路径。
- [x] 错误：此处理函数没有业务 Err 分支；不应用 path_parser.rs 的 128 字节限制（handlers.rs:5886）。
- [x] 事件：无（handlers.rs:5852-5916）。
- [x] DB 读写：无，纯字符串处理（handlers.rs:5852-5916）。
- [x] 取消/并发：无取消点、无共享可变状态（handlers.rs:5852-5916）。
- [x] 时间/ID：不生成时间或 ID；按前缀推断（types.rs:727-745）。

## 命令 `dstu_permanently_delete`

<!-- BEGIN GENERATED:cmd:dstu_permanently_delete -->
- Rust：`src-tauri/crates/dstu-vfs/src/dstu/trash_handlers.rs:798` · async
- 前端：app（1 处，例 `src/dstu/api/trashApi.ts:126`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：id: string, itemType: string
  - 结果：null · 错误：DstuError · 注入：window, state, state
<!-- END GENERATED:cmd:dstu_permanently_delete -->

- [x] 输入：trash_handlers.rs:799-917；id/itemType 原样；删除前收集资源 ID、作文会话子资源和文件夹下笔记资产 ID。
- [x] 输出：成功 null。
- [x] 错误：DstuError 对象；非回收站 `资源 {id} (type={type}) 不在回收站中，无法永久删除。请先将其移到回收站。`；未知类型/仓储失败保留 Display。
- [x] 事件：完成资产清理与索引任务派发后 purged('/_trash/{id}')。
- [x] DB 读写：事务内查询 deleted_at 并调用对应仓储 purge；提交后 blob sweep、笔记 notes_assets/<subject>/<id> 目录清理与完整索引清理。
- [x] 取消/并发：BEGIN IMMEDIATE 内同时验证回收站状态并 purge，避免 restore 抢占（delete_helpers.rs:239-352）；资产清理错误 warn。
- [x] 时间/ID：无新 ID；资源引用计数与索引统计由 owner 仓储更新。

## 命令 `dstu_purge`

<!-- BEGIN GENERATED:cmd:dstu_purge -->
- Rust：`src-tauri/crates/dstu-vfs/src/dstu/handlers.rs:4459` · async
- 前端：app（1 处，例 `src/dstu/api.ts:985`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：path: string
  - 结果：null · 错误：string · 注入：window, state, state
<!-- END GENERATED:cmd:dstu_purge -->

- [x] 输入：handlers.rs:4460-4533；解析 path，预收集资源 ID（notes/files/exams/translations/mindmaps）；预收集失败忽略。
- [x] 输出：成功 null。
- [x] 错误：string；回收站校验与 purge helper 的完整 Display；Lance 清理失败忽略。
- [x] 事件：事务成功后 purged(path)，随后清理 text 与 multimodal 向量。
- [x] DB 读写：同 purge_resource_by_type_if_trashed；本命令不清理笔记资产目录；Lance 按资源删除，不调用 full indexing 的额外 pending 更新。
- [x] 取消/并发：校验与删除同一 BEGIN IMMEDIATE；提交后异步向量清理。
- [x] 时间/ID：不生成 ID，事件 path 保留入参。

## 命令 `dstu_purge_all`

<!-- BEGIN GENERATED:cmd:dstu_purge_all -->
- Rust：`src-tauri/crates/dstu-vfs/src/dstu/handlers.rs:5141` · async
- 前端：app（1 处，例 `src/dstu/api.ts:1035`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：resourceType: string
  - 结果：integer(usize) · 错误：string · 注入：window, state, state
<!-- END GENERATED:cmd:dstu_purge_all -->

- [x] 输入：handlers.rs:5142-5238；仅 notes/textbooks；其余类型拒绝。
- [x] 输出：所属仓储 purgeDeleted 返回数量。
- [x] 错误：string；其他类型 `VFS error: Resource type '{type}' does not support purge_all operation`；预收集查询失败忽略。
- [x] 事件：即便计数为0也发 purged('/{resourceType}/_trash')；随后索引清理。
- [x] DB 读写：notes.deleted_at 非空；textbooks 使用 files.status=deleted 且 tb_%；委托对应仓储 purgeDeleted。
- [x] 取消/并发：事务由仓储管理，命令无全局事务；无取消。
- [x] 时间/ID：不生成 ID。

## 命令 `dstu_refresh_path_cache`

<!-- BEGIN GENERATED:cmd:dstu_refresh_path_cache -->
- Rust：`src-tauri/crates/dstu-vfs/src/dstu/handlers.rs:6516` · async
- 前端：app（1 处，例 `src/dstu/api/pathApi.ts:209`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：resourceId?: string | null
  - 结果：integer(usize) · 错误：string · 注入：state
<!-- END GENERATED:cmd:dstu_refresh_path_cache -->

- [x] 输入：handlers.rs:6516-6617；resourceId 可空，空表示全量 active folder_items。
- [x] 输出：handlers.rs:6610-6616；更新的行数（usize）。
- [x] 错误：handlers.rs:6530-6608；连接/查询/更新失败按 VfsError Display；单行构建文件夹路径失败降级空串。
- [x] 事件：无（handlers.rs:6516-6617）。
- [x] DB 读写：handlers.rs:6532-6603；逐行读 id/folder_id/item_id，按 folder_id 递归读 folders.title，再 UPDATE folder_items.cached_path WHERE id。
- [x] 取消/并发：spawn_blocking 单连接逐行更新，无事务。
- [x] 时间/ID：不写时间、不生成 ID；全量模式按查询自然顺序计数。

## 命令 `dstu_rename`

<!-- BEGIN GENERATED:cmd:dstu_rename -->
- Rust：`src-tauri/crates/dstu-vfs/src/dstu/handlers.rs:1879` · async
- 前端：app（1 处，例 `src/dstu/api.ts:508`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：path: string, newName: string
  - 结果：DstuNode · 错误：string · 注入：window, state
<!-- END GENERATED:cmd:dstu_rename -->

- [x] 输入：handlers.rs:1890-1930；path 经 `extract_resource_info`，newName 原样传给各仓储（note 走 note title 校验：空/超长/控制字符）。注意 `tb_`/`file_` 前缀统一推断为 files，因此教材重命名实际走 files 分支并按文件名判定返回 textbook 节点。
- [x] 输出：按类型回读/转换：notes→note_to_dstu_node、exams→exam_to_dstu_node、essays→更新 essay_sessions 后手工构造（metadata 仅 totalRounds/isFavorite）、translations→translation_to_dstu_node、files/images→file_to_dstu_node、mindmaps→回读节点、folders→folder 节点（metadata isExpanded/isFavorite/icon/color，时间取更新前 folder 值）。
- [x] 错误：note title 校验错误；`Translation not found: {id}`、`File not found: {id}`、`ExamSheet not found: {id}`、`EssaySession not found: {id}`、`FOLDER_NOT_FOUND: {id}`；essay/folder 回读为空 → `Resource not found: {path}`；未知类型 `Invalid node type: {type}`。
- [x] 事件：handlers.rs:2225-2227 `emit_watch_event(updated(path, node))`，path 为入参原文。
- [x] DB 读写：note_repo.rs:653-930（标题更新 + OCC/资源保留）、exam_repo.rs:749-778、translation_repo.rs:1032-1060（local_version+1/device_id）、file_repo.rs:907-933/textbook_repo.rs:626-656、essay_repo.rs:934-1000、mindmap_repo.rs:540-790（仅标题，content_updated_at 不推进）、folder_repo.rs:1069-1135（更新文件夹并清空子树 cached_path + path_cache）；最后按 `canonical_folder_item_type(resource_type)` 清 cached_path（复数参数下通常不匹配，行为照搬）。
- [x] 取消/并发：同步命令；note 更新带租约写栅栏与 OCC；文件夹重命名无版本前置条件（update_folder 直接 UPDATE）。
- [x] 时间/ID：note updated_at 严格 +1ms；exam/translation/file 用 ISO `%Y-%m-%dT%H:%M:%S%.3fZ`；mindmap updated_at 严格递增而 content_updated_at 不变；folder updated_at 为毫秒。

## 命令 `dstu_restore`

<!-- BEGIN GENERATED:cmd:dstu_restore -->
- Rust：`src-tauri/crates/dstu-vfs/src/dstu/handlers.rs:4234` · async
- 前端：app（1 处，例 `src/dstu/api.ts:956`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：path: string
  - 结果：DstuNode · 错误：string · 注入：window, state
<!-- END GENERATED:cmd:dstu_restore -->

- [x] 输入：handlers.rs:4235-4449；path 解析后按资源类型恢复；essay_session 与单轮作文分支独立。
- [x] 输出：恢复后回读并使用已有 node converter；只有 folder 节点保留入参 path，其他节点使用 /{id}。
- [x] 错误：string；note/textbook 包装 `VFS error: restore failed (type=..., id=...): ...`，其他仓储原样；回读失败 `Resource restored but failed to retrieve node info: {path}`。
- [x] 事件：即便回读失败仍发 restored(path)，仅有节点时附带 node。
- [x] DB 读写：owner 仓储恢复资源和成员状态，然后只读节点；与 trash_restore 的重新索引副作用不同。
- [x] 取消/并发：仓储原子恢复；回读失败不会撤销已提交恢复。
- [x] 时间/ID：资源时间来自仓储；folder 节点按 DstuNode::folder 取当前毫秒；无新 ID。

## 命令 `dstu_restore_many`

<!-- BEGIN GENERATED:cmd:dstu_restore_many -->
- Rust：`src-tauri/crates/dstu-vfs/src/dstu/handlers.rs:5427` · async
- 前端：app（1 处，例 `src/dstu/api.ts:860`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：paths: string[]
  - 结果：integer(usize) · 错误：string · 注入：window, state
<!-- END GENERATED:cmd:dstu_restore_many -->

- [x] 输入：handlers.rs:5428-5529；最多100条，空数组返回0，事务内逐条解析和恢复。
- [x] 输出：恢复成功路径数；失败整批回滚。
- [x] 错误：string；数量限制同 delete_many；路径失败 `路径解析失败 ({path}): ...`；恢复失败 `恢复失败 (type=..., id=...): ...`。
- [x] 事件：提交成功后逐条 restored(path)，不附带节点。
- [x] DB 读写：restore_resource_by_type_with_conn 委托 owner 仓储恢复，复用同连接。
- [x] 取消/并发：BEGIN IMMEDIATE；任一错误 ROLLBACK；无取消。
- [x] 时间/ID：恢复时间由仓储生成；命令不生成 ID。

## 命令 `dstu_search`

<!-- BEGIN GENERATED:cmd:dstu_search -->
- Rust：`src-tauri/crates/dstu-vfs/src/dstu/handlers.rs:3269` · async
- 前端：app（1 处，例 `src/dstu/api.ts:609`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：query: string, options?: DstuListOptions | null
  - 结果：DstuNode[] · 错误：string · 注入：state
<!-- END GENERATED:cmd:dstu_search -->

- [x] 输入：handlers.rs:3270-3278；query 原样，options 可空（默认 limit 50/offset 0）。
- [x] 输出：search_helpers.rs:892-990；notes（FTS/LIKE+snippet）、exams、translations、textbooks（仅 PDF）、essay_sessions、files（排除 image）、images、mindmaps；folderId 过滤；vfs_index_segments 内容召回追加 snippet/matchSource=index；按 updatedAt 倒序；隐藏 __*__ 名。
- [x] 错误：仓储 VfsError Display；单项类型搜索失败在全局模式被忽略（Rust `if let Ok`），typeFilter 模式直接返回错误。
- [x] 事件：无（handlers.rs:3267-3286）。
- [x] DB 读写：search_helpers.rs:124-787、note_repo.rs:1281-1350、folder_repo.rs:858-891、vfs_index_units/segments + resources.source_id/source_table 反查；全部只读。
- [x] 取消/并发：spawn_blocking 只读。
- [x] 时间/ID：无写入；结果时间由转换器生成，排序用节点 updatedAt。

## 命令 `dstu_search_in_folder`

<!-- BEGIN GENERATED:cmd:dstu_search_in_folder -->
- Rust：`src-tauri/crates/dstu-vfs/src/dstu/handlers.rs:5654` · async
- 前端：app（1 处，例 `src/dstu/api.ts:931`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：folderId?: string | null, query: string, options?: DstuListOptions | null
  - 结果：DstuNode[] · 错误：string · 注入：state
<!-- END GENERATED:cmd:dstu_search_in_folder -->

- [x] 输入：handlers.rs:5655-5667；folderId 可空（空则转全局 dstu_search），query、options 可空。
- [x] 输出：handlers.rs:5669-5779；文件夹不存在报错；按 item_type 对 note/textbook/file/translation/exam/mindmap 标题 contains 匹配（essay 项不返回）；隐藏名过滤；索引召回限定 item_id 集合；按 updatedAt 倒序，仅当 limit 存在时截断。
- [x] 错误：handlers.rs:5670-5684 "Folder not found: {id}" 与 VfsError Display；索引/单项查询错误被忽略。
- [x] 事件：无（handlers.rs:5655-5783）。
- [x] DB 读写：folder_repo.rs:370-410/858-891、各资源 get_*、search_helpers.rs:701-787 索引召回；全部只读。
- [x] 取消/并发：spawn_blocking 只读。
- [x] 时间/ID：无写入；limit 默认不截断（仅显式传入时 truncate）。

## 命令 `dstu_set_favorite`

<!-- BEGIN GENERATED:cmd:dstu_set_favorite -->
- Rust：`src-tauri/crates/dstu-vfs/src/dstu/handlers.rs:4554` · async
- 前端：app（1 处，例 `src/dstu/api.ts:698`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：path: string, favorite: boolean
  - 结果：null · 错误：string · 注入：window, state
<!-- END GENERATED:cmd:dstu_set_favorite -->

- [x] 输入：handlers.rs:4555-4580；path 经 `extract_resource_info` 解析出复数类型与 id；favorite 布尔。分支仅接受复数：notes/textbooks/exams/folders/images|files/translations/essays/mindmaps；`tb_`/`file_`/`att_`/`img_` 均推断为 files，故 textbooks 分支实际不可达。
- [x] 输出：成功返回 `null`；更新后的 DstuNode 只出现在事件中。
- [x] 错误：路径解析 `Invalid DSTU path: ...`；notes/files/textbooks 收藏为无行数校验的裸 UPDATE，随后回读为空 → `操作失败`；folders 缺失 → `FOLDER_NOT_FOUND: {id}`；translation/exam/mindmap 缺失 → `Translation not found` / `ExamSheet not found` / `MindMap not found`；essays 先调 `update_session`，单轮作文（非 essay_session_ 前缀）直接返回 `EssaySession not found: {id}`（Rust 缺陷照搬）；其他类型 `Resource type '{type}' does not support favorite operation`。
- [x] 事件：`emit_watch_event(updated(path, node))` → `dstu:change:{path}` + `dstu:change`，path 用入参原文。
- [x] DB 读写：note_repo.rs:1917-1932（is_favorite + updated_at）、textbook_repo.rs:667-682、file_repo.rs:940-955、exam_repo.rs:789-816、folder_repo.rs:2022-2045（毫秒 updated_at）、translation_repo.rs:527-553（local_version+1/device_id）、essay_repo.rs:934-1000、mindmap_repo.rs:1370-1393（仅 is_favorite）。
- [x] 取消/并发：同步命令，无 OCC。
- [x] 时间/ID：note/textbook/file/exam/translation/essay 写 ISO `%Y-%m-%dT%H:%M:%S%.3fZ`；folder 写毫秒；mindmap 不推进 updated_at；folder 节点 metadata 仅 isExpanded/icon/color（不含 isFavorite，Rust 行为）。

## 命令 `dstu_set_metadata`

<!-- BEGIN GENERATED:cmd:dstu_set_metadata -->
- Rust：`src-tauri/crates/dstu-vfs/src/dstu/handlers.rs:3348` · async
- 前端：app（1 处，例 `src/dstu/api.ts:667`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：path: string, metadata: Value, expectedUpdatedAt?: string | null
  - 结果：null · 错误：string · 注入：window, state
<!-- END GENERATED:cmd:dstu_set_metadata -->

- [x] 输入：handlers.rs:3349-3455；path 无前导 `/` 时补 `/`。先以 `get_folder_item_by_cached_path(normalized_path)` 查活动 folder_items；将 item_type 单数映射为复数（note/textbook/exam/translation/essay/image/file/folder），其余类型 `Invalid node type: {item_type}`（`mindmap` 也会命中该错误）。cached_path 未命中时仅接受单段简单路径：`infer_resource_type_from_id` 为 unknown → `资源不存在`，多段 → `资源不存在`；`res_` 推断为 resources 后走 default → `Invalid node type: resources`。expectedUpdatedAt 仅 notes 的 OCC 与 textbook/file 书签/高亮 OCC 使用。
- [x] 输出：成功返回 `null`（`Ok(())`）；更新后的 DstuNode 只出现在 `dstu:change` 事件里。
- [x] 错误：路径解析 `资源不存在`；`Invalid node type: {type}`；笔记 metadata 解析 `笔记 metadata 必须是键值对象` / `不支持的笔记 metadata 字段: {keys}；自定义字段请放入 props` / `title 必须是字符串` / `tags 必须是字符串数组` / `isFavorite 必须是布尔值` / `props 必须是键值对象或 null`；笔记 OCC `CONFLICT(notes.conflict): The note has been updated elsewhere, please refresh.`；props 校验 `属性数量超出上限（最多 32 个）` / `属性名过长（最多 64 个字符）` / `属性名 {key:?} 为保留字` / `属性名不能包含控制字符` / `属性名 {key:?} 与已有属性重复` / `属性值过长（最多 512 个字符）` / `属性值不能包含控制字符` / `属性值只支持字符串、数字或布尔`；translation `Invalid argument 'rating': Rating must be between 1 and 5` 及各仓储 NotFound/Display；essay 会话 `Essay session metadata update requires at least one field`；textbook `INVALID_ARGUMENT: textbook highlights must be an array` / `... cannot exceed 500 items` / `CONFLICT(textbooks.annotations_conflict): expected_updated_at is required when replacing highlights` / `CONFLICT(textbooks.annotations_conflict): The textbook annotations changed (expected ..., current ...).` / `The textbook annotations changed before the bookmark update committed.` / `...before the highlight update committed.`；file `INVALID_ARGUMENT: file bookmarks must be an array` / `File not found: {id}`；更新后回读为空统一 `操作失败`；folder 缺失 `Resource not found: {path}`。
- [x] 事件：成功后 `emit_watch_event(updated(path, node))` → `dstu:change:{path}` + `dstu:change`，path 用入参原文。textbook 分支带 `highlights` 时额外 `window.emit("pdf-annotations:changed", { textbook_id, resource_path: normalized_path, kind: "highlights", updated_at })`，仅发往调用窗口。
- [x] DB 读写：note_repo.rs:1972-2098（notes title/tags/is_favorite/props/updated_at，props 空对象写 NULL）、note_props.rs 键校验；translation_repo.rs:527-595/772-856（收藏/评分 bump local_version+device_id；内容合并后共享资源 COW）、resource_repo.rs:118-190；essay_repo.rs:457-475/934-1000 + handlers.rs:3592-3690（round 的 is_favorite/grade_level/essay_type 为裸 UPDATE）；textbook_repo.rs:570-585/667-682/695-712/715-852/2030-2050（进度、收藏、书签三态、高亮写 resources.metadata_json.extra.highlights 与 512KB 限制）；exam_repo.rs:749-816；file_repo.rs:907-933/940-955；mindmap_repo.rs:1370-1393（仅 is_favorite，不 bump updated_at）+ update_mindmap（标题/描述）、folder_repo.rs:1069-1130（更新文件夹并清空子树 cached_path）。`folder_items.cached_path` 清理使用复数 resource_type 调 `canonical_folder_item_type`，实际几乎总是 no-op（照搬 Rust）。
- [x] 取消/并发：同步命令。notes 先按 `expected_updated_at` trim/空串过滤后做字符串 CAS；textbook/file 书签与高亮以 files.updated_at 为 revision：有版本时 `UPDATE ... AND updated_at=?` 原子替换，无版本且同时带 readingProgress 时跳过书签，无版本纯书签请求整数组覆盖；高亮必须带版本。
- [x] 时间/ID：notes `next_updated_at` 严格 +1ms；translation/exam/file/essay 单字段写 `%Y-%m-%dT%H:%M:%S%.3fZ`；textbook 注解 revision 严格 +1ms，资源 metadata 的 updated_at 取该 revision 的毫秒值；mindmap 标题更新严格 +1ms 且 content_updated_at 不变；folder updated_at 为毫秒，节点时间取更新前值。

## 命令 `dstu_soft_delete`

<!-- BEGIN GENERATED:cmd:dstu_soft_delete -->
- Rust：`src-tauri/crates/dstu-vfs/src/dstu/trash_handlers.rs:113` · async
- 前端：app（1 处，例 `src/dstu/api/trashApi.ts:52`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：id: string, itemType: string
  - 结果：null · 错误：DstuError · 注入：window, state, state
<!-- END GENERATED:cmd:dstu_soft_delete -->

- [x] 输入：trash_handlers.rs:114-177；itemType 为 folder/note/textbook/exam/translation/essay/image/file/mindmap，essay 使用会话仓储。
- [x] 输出：成功 null。
- [x] 错误：DstuError 对象；未知类型 `{type:InvalidPath,message:Unknown item type: ...}`；仓储失败 VfsError；索引清理失败仅 warn。
- [x] 事件：资源软删除后 deleted('/{itemType}s/{id}')。
- [x] DB 读写：按类型委托仓储软删除；查询资源 ID 后派发完整索引清理（SQLite units/segments/counts，再 Lance text/mm）。
- [x] 取消/并发：软删除事务由仓储管理，索引在其后异步清理；无取消。
- [x] 时间/ID：时间由各仓储生成；无新 ID。

## 命令 `dstu_trash_restore`

<!-- BEGIN GENERATED:cmd:dstu_trash_restore -->
- Rust：`src-tauri/crates/dstu-vfs/src/dstu/trash_handlers.rs:180` · async
- 前端：app（1 处，例 `src/dstu/api/trashApi.ts:68`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：id: string, itemType: string
  - 结果：null · 错误：DstuError · 注入：window, state
<!-- END GENERATED:cmd:dstu_trash_restore -->

- [x] 输入：trash_handlers.rs:181-231；同 soft_delete 的单数 itemType，essay 为会话。
- [x] 输出：成功 null。
- [x] 错误：DstuError 对象；未知类型 InvalidPath；仓储错误 VfsError；标 pending 失败 warn 后继续。
- [x] 事件：恢复和重新索引标记之后 restored('/_trash/{id}')。
- [x] DB 读写：owner 仓储恢复；通过 L11 indexStates.markPending 标资源待索引，与是否安装 L12 无关。
- [x] 取消/并发：仓储原子恢复，pending 为提交后副作用，不因失败回滚恢复。
- [x] 时间/ID：恢复时间由仓储生成；无新 ID。

## 命令 `dstu_unwatch`

<!-- BEGIN GENERATED:cmd:dstu_unwatch -->
- Rust：`src-tauri/crates/dstu-vfs/src/dstu/handlers.rs:5634` · async
- 前端：app（2 处，例 `src/dstu/api.ts:738`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：path: string
  - 结果：null · 错误：string
<!-- END GENERATED:cmd:dstu_unwatch -->

- [x] 输入：path 字符串，仅日志使用（handlers.rs:5635-5637）。
- [x] 输出：Rust Ok(())，IPC null（handlers.rs:5637）。
- [x] 错误：没有业务 Err 分支（handlers.rs:5635-5637）。
- [x] 事件：无；原实现不改变订阅（handlers.rs:5635-5637）。
- [x] DB 读写：无（handlers.rs:5635-5637）。
- [x] 取消/并发：无取消点，无状态（handlers.rs:5635-5637）。
- [x] 时间/ID：无（handlers.rs:5635-5637）。

## 命令 `dstu_update`

<!-- BEGIN GENERATED:cmd:dstu_update -->
- Rust：`src-tauri/crates/dstu-vfs/src/dstu/handlers.rs:1438` · async
- 前端：app（1 处，例 `src/dstu/api.ts:405`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：path: string, content: string, resourceType: string, expectedUpdatedAtMs?: integer(i64) | null, lease?: NoteLeaseAuth | null
  - 结果：DstuNode · 错误：string · 注入：webview, window, state
<!-- END GENERATED:cmd:dstu_update -->

- [x] 输入：handlers.rs:1439-1490；path 去掉前导 `/` 即资源 id（空 → `Invalid DSTU path: Update path must contain resource ID`）；content 按 UTF-8 字节 ≤1MB；resourceType 按单/复数原样匹配；expectedUpdatedAtMs 仅 notes/mindmaps 分支使用；lease 仅 notes 分支使用，webview 标签取调用来源（对应 Rust `webview.label()`）。
- [x] 输出：notes（`update_note` 后 `note_to_dstu_node`）；mindmaps（`update_mindmap_content_with_occ` 后回读 `mindmap_to_dstu_node`）；translations/exams/essays（`update_content_by_type` 后按复数类型回读节点，essay 先查 essays 再回退 essay_sessions）；textbooks 直接拒绝；files/images 二进制拒绝；其余类型 `Invalid node type: {resourceType}`。
- [x] 错误：handlers.rs:1455-1470 与 content_helpers.rs:529-545 的内容超限文案；notes 毫秒基线 `CONFLICT(notes.conflict): ... (expected=, actual=)`；note OCC `CONFLICT(notes.conflict): The note has been updated elsewhere, please refresh.`；lease 冲突 `CONFLICT(notes.lease_not_ready|lease_conflict|lease_flush_required|participant_expired): Stored revision changed; reload before retrying`；mindmap 毫秒基线 `MINDMAP_UPDATE_CONFLICT: The mindmap has been updated elsewhere, please refresh. (expected=, actual=)`；mindmap repo OCC → `Failed to update mindmap content: INVALID_OPERATION: mindmap_update_conflict - MINDMAP_UPDATE_CONFLICT: ...`；translation `Invalid JSON content for translation: ...` / `Translation content must contain at least 'source' or 'translated' field` / `Translation not found: {id}` / `Failed to update translation content: ...`；exam `Invalid JSON content for exam: ...` / `Failed to update exam content: ExamSheet not found: {id}`；essay `Invalid JSON content for essay session: ...` / `Essay session update requires at least one field: ...` / `Failed to update essay session: ...` / `Essay not found: {id}` / `Failed to update essay content: ...`；textbook `Textbook content update not supported`；文件/图片 `{type} content update not supported: binary files cannot be directly edited`；回读失败 `Resource not found: {id}`。
- [x] 事件：handlers.rs:1655 `emit_watch_event(DstuWatchEvent::updated(&path, node))`，即 `dstu:change:{path}` 与 `dstu:change`；path 使用入参原文（不规范化）。
- [x] DB 读写：resource_repo.rs:778-835（内容哈希/行更新/index_state=pending）、note_repo.rs:653-930（notes 资源换新、旧资源仅无引用时删除、updated_at 严格递增）、note_lease_repo.rs:307-361（写授权+冻结草稿刷新）、mindmap_repo.rs:540-790（规范化、共享资源写时复制、content_updated_at 仅内容变化推进）、exam_repo.rs:1352-1394（preview_json 与资源同步）、essay_repo.rs:934-1000（会话逐字段更新）、essay/translation 内容原地更新。mindmap_versions 快照、note_document_formats/revisions、note_links、note_learning_relations、索引产物清理属 L10/向量 lane，本 lane 未写。
- [x] 取消/并发：同步命令。notes 先按毫秒基线预检再以当前 updated_at 字符串做原子 OCC；mindmaps 同理对接 content_updated_at；note lease 在 `note_history_write` savepoint 内插入 write grant、校验参与者/所有权/阶段、比对全部冻结草稿并在提交后回写 ack（与 Rust 同 SQL 语义）。
- [x] 时间/ID：updated_at 用 `next_updated_at`/`next_timestamp_after` 保证严格 +1ms，格式 `%Y-%m-%dT%H:%M:%S%.3fZ`；note 内容资源 `res_`+nanoid(10)、sha256 加盐 note_id、旧资源无引用时删除；mindmap 内容未变化不推进 content_updated_at。

## 命令 `dstu_watch`

<!-- BEGIN GENERATED:cmd:dstu_watch -->
- Rust：`src-tauri/crates/dstu-vfs/src/dstu/handlers.rs:5627` · async
- 前端：app（1 处，例 `src/dstu/api.ts:735`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：path: string
  - 结果：null · 错误：string
<!-- END GENERATED:cmd:dstu_watch -->

- [x] 输入：path 字符串，仅日志使用（handlers.rs:5628-5630）。
- [x] 输出：Rust Ok(())，IPC null（handlers.rs:5630）。
- [x] 错误：没有业务 Err 分支（handlers.rs:5628-5630）。
- [x] 事件：无；原实现不改变订阅（handlers.rs:5628-5630）。
- [x] DB 读写：无（handlers.rs:5628-5630）。
- [x] 取消/并发：无取消点，无状态（handlers.rs:5628-5630）。
- [x] 时间/ID：无（handlers.rs:5628-5630）。

## 命令 `filestream_check_access`

<!-- BEGIN GENERATED:cmd:filestream_check_access -->
- Rust：`src-tauri/crates/dstu-vfs/src/file_stream_protocol.rs:718` · async
- 前端：app（1 处，例 `src/features/learning-hub/apps/views/FileContentView.tsx:479`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：path: string
  - 结果：boolean · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:filestream_check_access -->

- [x] 输入：`path` 经 `fs.realpath` 规范化；校验链与 filestream 协议一致：目录白名单 → 白名单根下隐藏段 → 扩展名白名单（VFS blobs 目录内放宽）→ `is_file`（file_stream_protocol.rs:718-748）。
- [x] 输出：可达返回 `true`；任一校验失败、路径不存在或不可解析返回 `false`（不可达是常态，不是错误）。
- [x] 错误：只保留契约上的 `string` 通道；实现无业务错误分支。
- [x] 事件：无。
- [x] DB 读写：只读 VFS 数据库取 blobs 目录，不写库。
- [x] 取消/并发：同步文件系统探测，无取消点。
- [x] 时间/ID：无时间与 ID 生成。

## 命令 `pomodoro_create_record`

<!-- BEGIN GENERATED:cmd:pomodoro_create_record -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:1175` · async
- 前端：app（1 处，例 `src/features/pomodoro/api.ts:53`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：input: CreatePomodoroInput
  - 结果：PomodoroRecord · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:pomodoro_create_record -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `pomodoro_daily_stats`

<!-- BEGIN GENERATED:cmd:pomodoro_daily_stats -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:1247` · async
- 前端：app（1 处，例 `src/features/pomodoro/api.ts:74`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：days?: integer(u32) | null
  - 结果：PomodoroDailyStat[] · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:pomodoro_daily_stats -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `pomodoro_delete_record`

<!-- BEGIN GENERATED:cmd:pomodoro_delete_record -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/pomodoro_handlers.rs:23` · async
- 前端：app（1 处，例 `src/features/pomodoro/api.ts:79`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：recordId: string
  - 结果：null · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:pomodoro_delete_record -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `pomodoro_get_record`

<!-- BEGIN GENERATED:cmd:pomodoro_get_record -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:1204` · async
- 前端：app（1 处，例 `src/features/pomodoro/api.ts:57`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：recordId: string
  - 结果：PomodoroRecord | null · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:pomodoro_get_record -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `pomodoro_hourly_stats`

<!-- BEGIN GENERATED:cmd:pomodoro_hourly_stats -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/pomodoro_handlers.rs:77` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：days?: integer(u32) | null
  - 结果：PomodoroHourlyStat[] · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:pomodoro_hourly_stats -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `pomodoro_list_by_todo`

<!-- BEGIN GENERATED:cmd:pomodoro_list_by_todo -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:1216` · async
- 前端：app（1 处，例 `src/features/pomodoro/api.ts:61`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：todoItemId: string
  - 结果：PomodoroRecord[] · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:pomodoro_list_by_todo -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `pomodoro_list_range`

<!-- BEGIN GENERATED:cmd:pomodoro_list_range -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/pomodoro_handlers.rs:48` · async
- 前端：app（1 处，例 `src/features/pomodoro/api.ts:87`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：startDate: string, endDate: string
  - 结果：PomodoroRecord[] · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:pomodoro_list_range -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `pomodoro_list_today`

<!-- BEGIN GENERATED:cmd:pomodoro_list_today -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:1237` · async
- 前端：app（1 处，例 `src/features/pomodoro/api.ts:69`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：（无）
  - 结果：PomodoroRecord[] · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:pomodoro_list_today -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `pomodoro_stats_by_todo`

<!-- BEGIN GENERATED:cmd:pomodoro_stats_by_todo -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/pomodoro_handlers.rs:93` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：startDate?: string | null, endDate?: string | null, limit?: integer(u32) | null
  - 结果：PomodoroTodoStat[] · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:pomodoro_stats_by_todo -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `pomodoro_stats_overview`

<!-- BEGIN GENERATED:cmd:pomodoro_stats_overview -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/pomodoro_handlers.rs:117` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：days?: integer(u32) | null
  - 结果：PomodoroStatsOverview · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:pomodoro_stats_overview -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `pomodoro_streak`

<!-- BEGIN GENERATED:cmd:pomodoro_streak -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/pomodoro_handlers.rs:65` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：（无）
  - 结果：PomodoroStreakStats · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:pomodoro_streak -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `pomodoro_today_stats`

<!-- BEGIN GENERATED:cmd:pomodoro_today_stats -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:1228` · async
- 前端：app（1 处，例 `src/features/pomodoro/api.ts:65`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：（无）
  - 结果：PomodoroTodayStats · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:pomodoro_today_stats -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `pomodoro_todo_focus_summary`

<!-- BEGIN GENERATED:cmd:pomodoro_todo_focus_summary -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/pomodoro_handlers.rs:132` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：todoItemId: string
  - 结果：PomodoroTodoFocusSummary · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:pomodoro_todo_focus_summary -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `todo_ai_breakdown`

<!-- BEGIN GENERATED:cmd:todo_ai_breakdown -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:1007` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：itemId: string
  - 结果：VfsTodoItem[] · 错误：CommandError · 注入：app-handle, state
<!-- END GENERATED:cmd:todo_ai_breakdown -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `todo_batch_complete`

<!-- BEGIN GENERATED:cmd:todo_batch_complete -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:750` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：itemIds: string[]
  - 结果：TodoBatchItemsResult · 错误：CommandError · 注入：app-handle
<!-- END GENERATED:cmd:todo_batch_complete -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `todo_batch_delete`

<!-- BEGIN GENERATED:cmd:todo_batch_delete -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:831` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：itemIds: string[]
  - 结果：TodoBatchIdsResult · 错误：CommandError · 注入：app-handle
<!-- END GENERATED:cmd:todo_batch_delete -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `todo_batch_move`

<!-- BEGIN GENERATED:cmd:todo_batch_move -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:811` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：itemIds: string[], targetListId: string
  - 结果：TodoBatchItemsResult · 错误：CommandError · 注入：app-handle
<!-- END GENERATED:cmd:todo_batch_move -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `todo_batch_purge`

<!-- BEGIN GENERATED:cmd:todo_batch_purge -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:868` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：itemIds: string[]
  - 结果：TodoBatchIdsResult · 错误：CommandError · 注入：app-handle
<!-- END GENERATED:cmd:todo_batch_purge -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `todo_batch_reschedule`

<!-- BEGIN GENERATED:cmd:todo_batch_reschedule -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:769` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：itemIds: string[], dueDate?: string | null, dueTime?: string | null
  - 结果：TodoBatchItemsResult · 错误：CommandError · 注入：app-handle
<!-- END GENERATED:cmd:todo_batch_reschedule -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `todo_batch_restore`

<!-- BEGIN GENERATED:cmd:todo_batch_restore -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:849` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：itemIds: string[]
  - 结果：TodoBatchItemsResult · 错误：CommandError · 注入：app-handle
<!-- END GENERATED:cmd:todo_batch_restore -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `todo_batch_set_priority`

<!-- BEGIN GENERATED:cmd:todo_batch_set_priority -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:791` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：itemIds: string[], priority: string
  - 结果：TodoBatchItemsResult · 错误：CommandError · 注入：app-handle
<!-- END GENERATED:cmd:todo_batch_set_priority -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `todo_counts_snapshot`

<!-- BEGIN GENERATED:cmd:todo_counts_snapshot -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:730` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：（无）
  - 结果：TodoCountsSnapshot · 错误：CommandError · 注入：app-handle
<!-- END GENERATED:cmd:todo_counts_snapshot -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `todo_create_item`

<!-- BEGIN GENERATED:cmd:todo_create_item -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:452` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：input: CreateTodoItemInput
  - 结果：VfsTodoItem · 错误：CommandError · 注入：app-handle
<!-- END GENERATED:cmd:todo_create_item -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `todo_create_list`

<!-- BEGIN GENERATED:cmd:todo_create_list -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:231` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：input: CreateTodoListInput
  - 结果：VfsTodoList · 错误：CommandError · 注入：app-handle
<!-- END GENERATED:cmd:todo_create_list -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `todo_delete_item`

<!-- BEGIN GENERATED:cmd:todo_delete_item -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:564` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：itemId: string
  - 结果：null · 错误：CommandError · 注入：app-handle
<!-- END GENERATED:cmd:todo_delete_item -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `todo_delete_list`

<!-- BEGIN GENERATED:cmd:todo_delete_list -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:293` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：listId: string
  - 结果：null · 错误：CommandError · 注入：app-handle
<!-- END GENERATED:cmd:todo_delete_list -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `todo_ensure_inbox`

<!-- BEGIN GENERATED:cmd:todo_ensure_inbox -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:317` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：title?: string | null
  - 结果：VfsTodoList · 错误：CommandError · 注入：app-handle
<!-- END GENERATED:cmd:todo_ensure_inbox -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `todo_get_active_summary`

<!-- BEGIN GENERATED:cmd:todo_get_active_summary -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:717` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：（无）
  - 结果：TodoActiveSummary | null · 错误：CommandError · 注入：app-handle
<!-- END GENERATED:cmd:todo_get_active_summary -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `todo_get_item`

<!-- BEGIN GENERATED:cmd:todo_get_item -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:480` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：itemId: string
  - 结果：VfsTodoItem | null · 错误：CommandError · 注入：app-handle
<!-- END GENERATED:cmd:todo_get_item -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `todo_get_list`

<!-- BEGIN GENERATED:cmd:todo_get_list -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:254` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：listId: string
  - 结果：VfsTodoList | null · 错误：CommandError · 注入：app-handle
<!-- END GENERATED:cmd:todo_get_list -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `todo_list_all_pending`

<!-- BEGIN GENERATED:cmd:todo_list_all_pending -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:669` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：（无）
  - 结果：VfsTodoItem[] · 错误：CommandError · 注入：app-handle
<!-- END GENERATED:cmd:todo_list_all_pending -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `todo_list_all_tags`

<!-- BEGIN GENERATED:cmd:todo_list_all_tags -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:916` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：（无）
  - 结果：TagCountEntry[] · 错误：CommandError · 注入：app-handle
<!-- END GENERATED:cmd:todo_list_all_tags -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `todo_list_completed`

<!-- BEGIN GENERATED:cmd:todo_list_completed -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:679` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：listId?: string | null
  - 结果：VfsTodoItem[] · 错误：CommandError · 注入：app-handle
<!-- END GENERATED:cmd:todo_list_completed -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `todo_list_deleted_items`

<!-- BEGIN GENERATED:cmd:todo_list_deleted_items -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:408` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：limit?: integer(u32) | null, offset?: integer(u32) | null
  - 结果：VfsTodoItem[] · 错误：CommandError · 注入：app-handle
<!-- END GENERATED:cmd:todo_list_deleted_items -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `todo_list_deleted_lists`

<!-- BEGIN GENERATED:cmd:todo_list_deleted_lists -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:344` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：limit?: integer(u32) | null, offset?: integer(u32) | null
  - 结果：VfsTodoList[] · 错误：CommandError · 注入：app-handle
<!-- END GENERATED:cmd:todo_list_deleted_lists -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `todo_list_items`

<!-- BEGIN GENERATED:cmd:todo_list_items -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:492` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：listId: string, includeCompleted: boolean, limit?: integer(u32) | null, offset?: integer(u32) | null
  - 结果：VfsTodoItem[] · 错误：CommandError · 注入：app-handle
<!-- END GENERATED:cmd:todo_list_items -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `todo_list_items_with_stats`

<!-- BEGIN GENERATED:cmd:todo_list_items_with_stats -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:927` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：listId: string, includeCompleted: boolean, limit?: integer(u32) | null, offset?: integer(u32) | null
  - 结果：TodoItemWithChildStats[] · 错误：CommandError · 注入：app-handle
<!-- END GENERATED:cmd:todo_list_items_with_stats -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `todo_list_lists`

<!-- BEGIN GENERATED:cmd:todo_list_lists -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:263` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：（无）
  - 结果：VfsTodoList[] · 错误：CommandError · 注入：app-handle
<!-- END GENERATED:cmd:todo_list_lists -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `todo_list_overdue`

<!-- BEGIN GENERATED:cmd:todo_list_overdue -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:629` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：includeCompleted: boolean, limit?: integer(u32) | null, offset?: integer(u32) | null
  - 结果：VfsTodoItem[] · 错误：CommandError · 注入：app-handle
<!-- END GENERATED:cmd:todo_list_overdue -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `todo_list_reminders`

<!-- BEGIN GENERATED:cmd:todo_list_reminders -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:659` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：（无）
  - 结果：VfsTodoItem[] · 错误：CommandError · 注入：app-handle
<!-- END GENERATED:cmd:todo_list_reminders -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `todo_list_today`

<!-- BEGIN GENERATED:cmd:todo_list_today -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:612` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：includeCompleted: boolean, limit?: integer(u32) | null, offset?: integer(u32) | null
  - 结果：VfsTodoItem[] · 错误：CommandError · 注入：app-handle
<!-- END GENERATED:cmd:todo_list_today -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `todo_list_upcoming`

<!-- BEGIN GENERATED:cmd:todo_list_upcoming -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:644` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：days: integer(i64), includeCompleted: boolean
  - 结果：VfsTodoItem[] · 错误：CommandError · 注入：app-handle
<!-- END GENERATED:cmd:todo_list_upcoming -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `todo_move_item`

<!-- BEGIN GENERATED:cmd:todo_move_item -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:594` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：input: MoveTodoItemInput
  - 结果：VfsTodoItem · 错误：CommandError · 注入：app-handle
<!-- END GENERATED:cmd:todo_move_item -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `todo_purge_deleted_items`

<!-- BEGIN GENERATED:cmd:todo_purge_deleted_items -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:434` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：（无）
  - 结果：integer(usize) · 错误：CommandError · 注入：app-handle
<!-- END GENERATED:cmd:todo_purge_deleted_items -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `todo_purge_deleted_lists`

<!-- BEGIN GENERATED:cmd:todo_purge_deleted_lists -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:382` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：（无）
  - 结果：integer(usize) · 错误：CommandError · 注入：app-handle
<!-- END GENERATED:cmd:todo_purge_deleted_lists -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `todo_purge_item`

<!-- BEGIN GENERATED:cmd:todo_purge_item -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:422` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：itemId: string
  - 结果：null · 错误：CommandError · 注入：app-handle
<!-- END GENERATED:cmd:todo_purge_item -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `todo_purge_list`

<!-- BEGIN GENERATED:cmd:todo_purge_list -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:370` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：listId: string
  - 结果：null · 错误：CommandError · 注入：app-handle
<!-- END GENERATED:cmd:todo_purge_list -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `todo_reorder_items`

<!-- BEGIN GENERATED:cmd:todo_reorder_items -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:576` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：input: ReorderItemsInput
  - 结果：null · 错误：CommandError · 注入：app-handle
<!-- END GENERATED:cmd:todo_reorder_items -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `todo_reorder_lists`

<!-- BEGIN GENERATED:cmd:todo_reorder_lists -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:328` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：input: ReorderListsInput
  - 结果：null · 错误：CommandError · 注入：app-handle
<!-- END GENERATED:cmd:todo_reorder_lists -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `todo_restore_item`

<!-- BEGIN GENERATED:cmd:todo_restore_item -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:396` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：itemId: string
  - 结果：VfsTodoItem · 错误：CommandError · 注入：app-handle
<!-- END GENERATED:cmd:todo_restore_item -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `todo_restore_list`

<!-- BEGIN GENERATED:cmd:todo_restore_list -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:358` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：listId: string
  - 结果：VfsTodoList · 错误：CommandError · 注入：app-handle
<!-- END GENERATED:cmd:todo_restore_list -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `todo_search`

<!-- BEGIN GENERATED:cmd:todo_search -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:696` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：query: string, limit?: integer(u32) | null, offset?: integer(u32) | null
  - 结果：VfsTodoItem[] · 错误：CommandError · 注入：app-handle
<!-- END GENERATED:cmd:todo_search -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `todo_stats_overview`

<!-- BEGIN GENERATED:cmd:todo_stats_overview -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:901` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：days?: integer(u32) | null
  - 结果：TodoStatsOverview · 错误：CommandError · 注入：app-handle
<!-- END GENERATED:cmd:todo_stats_overview -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `todo_toggle_item`

<!-- BEGIN GENERATED:cmd:todo_toggle_item -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:547` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：itemId: string, expectedUpdatedAt?: string | null
  - 结果：VfsTodoItem · 错误：CommandError · 注入：app-handle
<!-- END GENERATED:cmd:todo_toggle_item -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `todo_toggle_list_favorite`

<!-- BEGIN GENERATED:cmd:todo_toggle_list_favorite -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:305` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：listId: string
  - 结果：VfsTodoList · 错误：CommandError · 注入：app-handle
<!-- END GENERATED:cmd:todo_toggle_list_favorite -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `todo_trash_counts`

<!-- BEGIN GENERATED:cmd:todo_trash_counts -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:886` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：（无）
  - 结果：TodoTrashCounts · 错误：CommandError · 注入：app-handle
<!-- END GENERATED:cmd:todo_trash_counts -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `todo_update_item`

<!-- BEGIN GENERATED:cmd:todo_update_item -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:508` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：input: UpdateTodoItemInput
  - 结果：VfsTodoItem · 错误：CommandError · 注入：app-handle
<!-- END GENERATED:cmd:todo_update_item -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `todo_update_list`

<!-- BEGIN GENERATED:cmd:todo_update_list -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:272` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：input: UpdateTodoListInput
  - 结果：VfsTodoList · 错误：CommandError · 注入：app-handle
<!-- END GENERATED:cmd:todo_update_list -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_assign_dimension_model`

<!-- BEGIN GENERATED:cmd:vfs_assign_dimension_model -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:3398` · async
- 前端：app（1 处，例 `src/api/vfsUnifiedIndexApi.ts:226`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：dimension: integer(i32), modality: string, modelConfigId: string, modelName: string
  - 结果：boolean · 错误：string · 注入：state, state, state
<!-- END GENERATED:cmd:vfs_assign_dimension_model -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_batch_index_pending`

<!-- BEGIN GENERATED:cmd:vfs_batch_index_pending -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:3859` · async
- 前端：app（1 处，例 `src/api/vfsUnifiedIndexApi.ts:202`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：batchSize?: integer(u32) | null
  - 结果：dstu_vfs__vfs__handlers__BatchIndexResult · 错误：string · 注入：app-handle, state, state, state
<!-- END GENERATED:cmd:vfs_batch_index_pending -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_cancel_pdf_processing`

<!-- BEGIN GENERATED:cmd:vfs_cancel_pdf_processing -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:6533` · async
- 前端：app（1 处，例 `src/api/vfsPdfProcessingApi.ts:164`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：fileId: string
  - 结果：boolean · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_cancel_pdf_processing -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_clear_default_embedding_dimension`

<!-- BEGIN GENERATED:cmd:vfs_clear_default_embedding_dimension -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:3817` · async
- 前端：app（1 处，例 `src/api/vfsUnifiedIndexApi.ts:332`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：modality: string
  - 结果：boolean · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_clear_default_embedding_dimension -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_clear_media_cache`

<!-- BEGIN GENERATED:cmd:vfs_clear_media_cache -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:6975` · async
- 前端：app（1 处，例 `src/api/dataGovernance.ts:1272`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：params: ClearMediaCacheParams
  - 结果：ClearMediaCacheResult · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_clear_media_cache -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_clear_resource_ocr`

<!-- BEGIN GENERATED:cmd:vfs_clear_resource_ocr -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:7783` · async
- 前端：app（1 处，例 `src/api/vfsUnifiedIndexApi.ts:389`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：resourceId: string
  - 结果：boolean · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_clear_resource_ocr -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_create_attachment_root_folder`

<!-- BEGIN GENERATED:cmd:vfs_create_attachment_root_folder -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:1679` · async
- 前端：app（1 处，例 `src/api/attachmentConfigApi.ts:18`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：title: string
  - 结果：string · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_create_attachment_root_folder -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_create_dimension`

<!-- BEGIN GENERATED:cmd:vfs_create_dimension -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:3495` · async
- 前端：app（1 处，例 `src/api/vfsUnifiedIndexApi.ts:252`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：dimension: integer(i32), modality: string, modelConfigId?: string | null, modelName?: string | null
  - 结果：VfsEmbeddingDim · 错误：string · 注入：state, state
<!-- END GENERATED:cmd:vfs_create_dimension -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_create_mindmap`

<!-- BEGIN GENERATED:cmd:vfs_create_mindmap -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:5088` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：params: CreateMindMapInput
  - 结果：VfsMindMap · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_create_mindmap -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_create_note`

<!-- BEGIN GENERATED:cmd:vfs_create_note -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:460` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：params: CreateNoteInput
  - 结果：VfsNote · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_create_note -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_create_or_reuse`

<!-- BEGIN GENERATED:cmd:vfs_create_or_reuse -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:300` · async
- 前端：app（2 处，例 `src/features/chat/resources/api.ts:147`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：params: CreateResourceInput
  - 结果：VfsCreateResourceResult · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_create_or_reuse -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_debug_index_status`

<!-- BEGIN GENERATED:cmd:vfs_debug_index_status -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:5472` · async
- 前端：app（1 处，例 `src/api/vfsRagApi.ts:406`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：resourceId?: string | null
  - 结果：IndexDiagnosticInfo · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_debug_index_status -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_decrement_ref`

<!-- BEGIN GENERATED:cmd:vfs_decrement_ref -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:430` · async
- 前端：app（1 处，例 `src/features/chat/resources/api.ts:255`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：resourceId: string
  - 结果：null · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_decrement_ref -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_delete_attachment`

<!-- BEGIN GENERATED:cmd:vfs_delete_attachment -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:1964` · async
- 前端：app（1 处，例 `src/features/chat/debug/attachmentPipelineTestPlugin.ts:1225`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：attachmentId: string
  - 结果：null · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_delete_attachment -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_delete_dimension`

<!-- BEGIN GENERATED:cmd:vfs_delete_dimension -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:3581` · async
- 前端：app（1 处，例 `src/api/vfsUnifiedIndexApi.ts:271`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：dimension: integer(i32), modality: string
  - 结果：DeleteDimensionResult · 错误：string · 注入：state, state, state
<!-- END GENERATED:cmd:vfs_delete_dimension -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_delete_file`

<!-- BEGIN GENERATED:cmd:vfs_delete_file -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:2750` · async
- 前端：app（1 处，例 `src/api/vfsFileApi.ts:112`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：fileId: string
  - 结果：null · 错误：string · 注入：state, state
<!-- END GENERATED:cmd:vfs_delete_file -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_delete_mindmap`

<!-- BEGIN GENERATED:cmd:vfs_delete_mindmap -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:5302` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：mindmapId: string
  - 结果：null · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_delete_mindmap -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_delete_note`

<!-- BEGIN GENERATED:cmd:vfs_delete_note -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:646` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：id: string
  - 结果：null · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_delete_note -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_delete_resource_index`

<!-- BEGIN GENERATED:cmd:vfs_delete_resource_index -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/index_handlers.rs:201` · async
- 前端：app（1 处，例 `src/api/vfsUnifiedIndexApi.ts:154`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：resourceId: string
  - 结果：DeleteIndexResult · 错误：string · 注入：state, state
<!-- END GENERATED:cmd:vfs_delete_resource_index -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_diagnose_lance_schema`

<!-- BEGIN GENERATED:cmd:vfs_diagnose_lance_schema -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:6472` · async
- 前端：app（1 处，例 `src/api/vfsRagApi.ts:995`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：modality?: string | null
  - 结果：LanceTableDiagnostic[] · 错误：string · 注入：state, state
<!-- END GENERATED:cmd:vfs_diagnose_lance_schema -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_download_paper`

<!-- BEGIN GENERATED:cmd:vfs_download_paper -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:7340` · async
- 前端：app（1 处，例 `src/features/chat/plugins/blocks/paperSave.tsx:142`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：params: VfsDownloadPaperParams
  - 结果：VfsDownloadPaperResult · 错误：string · 注入：state, state
<!-- END GENERATED:cmd:vfs_download_paper -->

- [x] 输入：handlers.rs:7315-7324。
- [x] 输出：VfsDownloadPaperResult 全字段（None → null）；复用分支 fileName=null、pageCount 取已有行。
- [x] 错误："Only HTTPS URLs are allowed"、"Download failed: …"、"HTTP {code}"、"Read failed: …"、"Downloaded file is not a valid PDF"、"File creation failed: …"。
- [x] 事件：无；流水线 ocr_processing 分离启动、结果丢弃（`let _`）。
- [x] DB 读写：同 vfs_upload_file 的 saga（主 blob 恒落库）；去重查询错误按 `if let Ok(Some)` 落入新建。
- [x] 取消/并发：reqwest → undici@7.30.1（D5）：90s 总超时（AbortSignal 覆盖头与正文）、重定向上限 10、UA 相同；非 2xx 丢弃正文。线程语义差异：Rust 整段在 `tokio::task::spawn_blocking` 中执行（解码、解析、文件 I/O、SQLite 不占 async 运行时）；TS 在 Host 主事件循环执行同步 SQLite/文件 I/O，仅 F7 渲染/文档解析与 L11 上传为 await 点。结果与错误等价，但大文件期间会阻塞事件循环；R13-02 同类问题，待 vfsWorker 承接上传路径后迁移。流水线启动 `tokio::spawn` → queueMicrotask 分离执行。
- [x] 时间/ID：同上。

## 命令 `vfs_get_all_index_status`

<!-- BEGIN GENERATED:cmd:vfs_get_all_index_status -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:4225` · async
- 前端：app（1 处，例 `src/api/vfsUnifiedIndexApi.ts:177`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：folderId?: string | null, resourceType?: string | null, stateFilter?: string | null, limit?: integer(u32) | null, offset?: integer(u32) | null
  - 结果：dstu_vfs__vfs__handlers__IndexStatusSummary · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_get_all_index_status -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_get_attachment`

<!-- BEGIN GENERATED:cmd:vfs_get_attachment -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:1946` · async
- 前端：app（1 处，例 `src/features/learning-hub/apps/views/ImageContentView.tsx:346`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：attachmentId: string
  - 结果：VfsAttachment | null · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_get_attachment -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_get_attachment_config`

<!-- BEGIN GENERATED:cmd:vfs_get_attachment_config -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:1648` · async
- 前端：app（1 处，例 `src/api/attachmentConfigApi.ts:10`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：（无）
  - 结果：AttachmentConfigOutput · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_get_attachment_config -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_get_attachment_content`

<!-- BEGIN GENERATED:cmd:vfs_get_attachment_content -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:1720` · async
- 前端：app（11 处，例 `src/components/QuestionInlineEditor.tsx:353`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：attachmentId: string, maxBytes?: integer(u64) | null
  - 结果：VfsAttachmentContentResult · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_get_attachment_content -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_get_batch_pdf_processing_status`

<!-- BEGIN GENERATED:cmd:vfs_get_batch_pdf_processing_status -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:6628` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：fileIds: string[]
  - 结果：object · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_get_batch_pdf_processing_status -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_get_blob_base64`

<!-- BEGIN GENERATED:cmd:vfs_get_blob_base64 -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:2858` · async
- 前端：app（1 处，例 `src/features/chat/context/blobApi.ts:118`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：blobHash: string
  - 结果：VfsBlobBase64Result · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_get_blob_base64 -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_get_default_embedding_dimension`

<!-- BEGIN GENERATED:cmd:vfs_get_default_embedding_dimension -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:3763` · async
- 前端：app（1 处，例 `src/api/vfsUnifiedIndexApi.ts:318`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：modality: string
  - 结果：VfsEmbeddingDim | null · 错误：string · 注入：state, state
<!-- END GENERATED:cmd:vfs_get_default_embedding_dimension -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_get_dimension_range`

<!-- BEGIN GENERATED:cmd:vfs_get_dimension_range -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:3675` · async
- 前端：app（1 处，例 `src/api/vfsUnifiedIndexApi.ts:284`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：（无）
  - 结果：?[] · 错误：string
<!-- END GENERATED:cmd:vfs_get_dimension_range -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_get_embedding_readiness`

<!-- BEGIN GENERATED:cmd:vfs_get_embedding_readiness -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:4198` · async
- 前端：app（1 处，例 `src/features/learning-hub/embeddingReadiness.ts:33`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：（无）
  - 结果：EmbeddingReadiness · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_get_embedding_readiness -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_get_embedding_stats`

<!-- BEGIN GENERATED:cmd:vfs_get_embedding_stats -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:3318` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：（无）
  - 结果：VfsEmbeddingStats · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_get_embedding_stats -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_get_file`

<!-- BEGIN GENERATED:cmd:vfs_get_file -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:2714` · async
- 前端：app（1 处，例 `src/api/vfsFileApi.ts:96`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：fileId: string
  - 结果：VfsFile | null · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_get_file -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_get_file_content`

<!-- BEGIN GENERATED:cmd:vfs_get_file_content -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:2782` · async
- 前端：app（1 处，例 `src/api/vfsFileApi.ts:116`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：fileId: string
  - 结果：VfsFileContentResult · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_get_file_content -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_get_index_status`

<!-- BEGIN GENERATED:cmd:vfs_get_index_status -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:3269` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：resourceId: string
  - 结果：IndexState | null · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_get_index_status -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_get_indexing_config`

<!-- BEGIN GENERATED:cmd:vfs_get_indexing_config -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:4053` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：key: string
  - 结果：string | null · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_get_indexing_config -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_get_lance_stats`

<!-- BEGIN GENERATED:cmd:vfs_get_lance_stats -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:4970` · async
- 前端：app（1 处，例 `src/api/vfsRagApi.ts:209`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：modality?: string | null
  - 结果：?[][] · 错误：string · 注入：state, state
<!-- END GENERATED:cmd:vfs_get_lance_stats -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_get_media_cache_stats`

<!-- BEGIN GENERATED:cmd:vfs_get_media_cache_stats -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:6813` · async
- 前端：app（1 处，例 `src/api/dataGovernance.ts:1262`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：（无）
  - 结果：MediaCacheStats · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_get_media_cache_stats -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_get_mindmap`

<!-- BEGIN GENERATED:cmd:vfs_get_mindmap -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:5115` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：mindmapId: string
  - 结果：VfsMindMap | null · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_get_mindmap -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_get_mindmap_content`

<!-- BEGIN GENERATED:cmd:vfs_get_mindmap_content -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:5134` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：mindmapId: string
  - 结果：string | null · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_get_mindmap_content -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_get_mindmap_version`

<!-- BEGIN GENERATED:cmd:vfs_get_mindmap_version -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:5231` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：versionId: string
  - 结果：VfsMindMapVersion | null · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_get_mindmap_version -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_get_mindmap_version_content`

<!-- BEGIN GENERATED:cmd:vfs_get_mindmap_version_content -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:5209` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：versionId: string
  - 结果：string | null · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_get_mindmap_version_content -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_get_mindmap_versions`

<!-- BEGIN GENERATED:cmd:vfs_get_mindmap_versions -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:5155` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：mindmapId: string, limit?: integer(u32) | null
  - 结果：VfsMindMapVersion[] · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_get_mindmap_versions -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_get_note`

<!-- BEGIN GENERATED:cmd:vfs_get_note -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:567` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：id: string
  - 结果：VfsNote | null · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_get_note -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_get_note_content`

<!-- BEGIN GENERATED:cmd:vfs_get_note_content -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:592` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：id: string
  - 结果：string | null · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_get_note_content -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_get_or_create_attachment_root_folder`

<!-- BEGIN GENERATED:cmd:vfs_get_or_create_attachment_root_folder -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:1688` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：（无）
  - 结果：string · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_get_or_create_attachment_root_folder -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_get_pdf_page_image`

<!-- BEGIN GENERATED:cmd:vfs_get_pdf_page_image -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:3105` · async
- 前端：app（1 处，例 `src/api/vfsRagApi.ts:945`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：resourceId: string, pageIndex: integer(usize)
  - 结果：VfsBlobBase64Result · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_get_pdf_page_image -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_get_pdf_processing_status`

<!-- BEGIN GENERATED:cmd:vfs_get_pdf_processing_status -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:6504` · async
- 前端：app（1 处，例 `src/api/vfsPdfProcessingApi.ts:123`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：fileId: string
  - 结果：ProcessingStatus | null · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_get_pdf_processing_status -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_get_pending_resources`

<!-- BEGIN GENERATED:cmd:vfs_get_pending_resources -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:3353` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：（无）
  - 结果：string[] · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_get_pending_resources -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_get_preset_dimensions`

<!-- BEGIN GENERATED:cmd:vfs_get_preset_dimensions -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:3670` · async
- 前端：app（1 处，例 `src/api/vfsUnifiedIndexApi.ts:279`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：（无）
  - 结果：integer(i32)[] · 错误：string
<!-- END GENERATED:cmd:vfs_get_preset_dimensions -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_get_resource`

<!-- BEGIN GENERATED:cmd:vfs_get_resource -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:355` · async
- 前端：app（11 处，例 `src/demo/app/data/chat/ChatWithSourcePane.tsx:77`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：resourceId: string
  - 结果：VfsResource | null · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_get_resource -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_get_resource_ocr_info`

<!-- BEGIN GENERATED:cmd:vfs_get_resource_ocr_info -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:7621` · async
- 前端：app（1 处，例 `src/api/vfsUnifiedIndexApi.ts:379`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：resourceId: string
  - 结果：ResourceOcrInfo · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_get_resource_ocr_info -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_get_resource_path`

<!-- BEGIN GENERATED:cmd:vfs_get_resource_path -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:1043` · async
- 前端：app（1 处，例 `src/features/chat/context/vfsRefApi.ts:180`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：sourceId: string
  - 结果：string · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_get_resource_path -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_get_resource_ref_count`

<!-- BEGIN GENERATED:cmd:vfs_get_resource_ref_count -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/ref_handlers.rs:243` · async
- 前端：app（1 处，例 `src/features/chat/context/vfsRefApi.ts:538`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：sourceId: string
  - 结果：integer(i32) · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_get_resource_ref_count -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_get_resource_refs`

<!-- BEGIN GENERATED:cmd:vfs_get_resource_refs -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/ref_handlers.rs:52` · async
- 前端：app（1 处，例 `src/features/chat/context/vfsRefApi.ts:158`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：params: GetResourceRefsInput
  - 结果：VfsContextRefData · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_get_resource_refs -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_get_resource_text_chunks`

<!-- BEGIN GENERATED:cmd:vfs_get_resource_text_chunks -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:7860` · async
- 前端：app（1 处，例 `src/api/vfsUnifiedIndexApi.ts:397`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：resourceId: string
  - 结果：TextChunkInfo[] · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_get_resource_text_chunks -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_get_resource_units`

<!-- BEGIN GENERATED:cmd:vfs_get_resource_units -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/index_handlers.rs:27` · async
- 前端：app（1 处，例 `src/api/vfsUnifiedIndexApi.ts:99`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：resourceId: string
  - 结果：UnitIndexStatus[] · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_get_resource_units -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_increment_ref`

<!-- BEGIN GENERATED:cmd:vfs_increment_ref -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:404` · async
- 前端：app（1 处，例 `src/features/chat/resources/api.ts:242`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：resourceId: string
  - 结果：null · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_increment_ref -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_inspect_retrieval_capabilities`

<!-- BEGIN GENERATED:cmd:vfs_inspect_retrieval_capabilities -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:6354` · async
- 前端：app（1 处，例 `src/api/vfsRagApi.ts:816`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：（无）
  - 结果：CapabilitySnapshot · 错误：string · 注入：state, state, state
<!-- END GENERATED:cmd:vfs_inspect_retrieval_capabilities -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_list_dimensions`

<!-- BEGIN GENERATED:cmd:vfs_list_dimensions -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:3329` · async
- 前端：app（1 处，例 `src/api/vfsUnifiedIndexApi.ts:210`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：（无）
  - 结果：VfsEmbeddingDimension[] · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_list_dimensions -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_list_embedding_dims`

<!-- BEGIN GENERATED:cmd:vfs_list_embedding_dims -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/index_handlers.rs:287` · async
- 前端：app（1 处，例 `src/api/vfsUnifiedIndexApi.ts:161`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：（无）
  - 结果：EmbeddingDimInfo[] · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_list_embedding_dims -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_list_essays`

<!-- BEGIN GENERATED:cmd:vfs_list_essays -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:779` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：params?: ListInput | null
  - 结果：VfsEssay[] · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_list_essays -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_list_exam_sheets`

<!-- BEGIN GENERATED:cmd:vfs_list_exam_sheets -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:717` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：params?: ListInput | null
  - 结果：VfsExamSheet[] · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_list_exam_sheets -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_list_files`

<!-- BEGIN GENERATED:cmd:vfs_list_files -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:2728` · async
- 前端：app（2 处，例 `src/api/vfsFileApi.ts:104`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：fileType?: string | null, limit?: integer(u32) | null, offset?: integer(u32) | null
  - 结果：VfsFile[] · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_list_files -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_list_mindmaps`

<!-- BEGIN GENERATED:cmd:vfs_list_mindmaps -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:5321` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：（无）
  - 结果：VfsMindMap[] · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_list_mindmaps -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_list_notes`

<!-- BEGIN GENERATED:cmd:vfs_list_notes -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:614` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：params?: ListInput | null
  - 结果：VfsNote[] · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_list_notes -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_list_pending_pdf_processing`

<!-- BEGIN GENERATED:cmd:vfs_list_pending_pdf_processing -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:6685` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：limit?: integer(u32) | null
  - 结果：VfsFile[] · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_list_pending_pdf_processing -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_list_textbooks`

<!-- BEGIN GENERATED:cmd:vfs_list_textbooks -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:682` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：params?: ListInput | null
  - 结果：VfsTextbook[] · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_list_textbooks -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_list_translations`

<!-- BEGIN GENERATED:cmd:vfs_list_translations -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:747` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：params?: ListInput | null
  - 结果：VfsTranslation[] · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_list_translations -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_multimodal_delete`

<!-- BEGIN GENERATED:cmd:vfs_multimodal_delete -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:6395` · async
- 前端：app（1 处，例 `src/api/vfsRagApi.ts:850`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：resourceId: string
  - 结果：null · 错误：string · 注入：state, state, state
<!-- END GENERATED:cmd:vfs_multimodal_delete -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_multimodal_index`

<!-- BEGIN GENERATED:cmd:vfs_multimodal_index -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:6080` · async
- 前端：app（1 处，例 `src/api/vfsRagApi.ts:724`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：params: VfsMultimodalIndexInput
  - 结果：VfsMultimodalIndexOutput · 错误：string · 注入：app-handle, state, state, state
<!-- END GENERATED:cmd:vfs_multimodal_index -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_multimodal_index_resource`

<!-- BEGIN GENERATED:cmd:vfs_multimodal_index_resource -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:6419` · async
- 前端：app（1 处，例 `src/api/vfsRagApi.ts:894`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：sourceType: string, sourceId: string, folderId?: string | null, forceRebuild?: boolean | null
  - 结果：Value · 错误：string · 注入：app-handle, state, state, state, state
<!-- END GENERATED:cmd:vfs_multimodal_index_resource -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_multimodal_search`

<!-- BEGIN GENERATED:cmd:vfs_multimodal_search -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:6295` · async
- 前端：app（1 处，例 `src/api/vfsRagApi.ts:785`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：params: VfsMultimodalSearchInput
  - 结果：VfsMultimodalSearchOutput[] · 错误：string · 注入：state, state, state
<!-- END GENERATED:cmd:vfs_multimodal_search -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_multimodal_search_detailed`

<!-- BEGIN GENERATED:cmd:vfs_multimodal_search_detailed -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:6337` · async
- 前端：app（1 处，例 `src/api/vfsRagApi.ts:804`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：params: VfsMultimodalSearchInput
  - 结果：UnifiedRetrievalResponse · 错误：string · 注入：state, state, state
<!-- END GENERATED:cmd:vfs_multimodal_search_detailed -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_multimodal_stats`

<!-- BEGIN GENERATED:cmd:vfs_multimodal_stats -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:6372` · async
- 前端：app（1 处，例 `src/api/vfsRagApi.ts:832`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：（无）
  - 结果：Value · 错误：string · 注入：state, state, state
<!-- END GENERATED:cmd:vfs_multimodal_stats -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_optimize_lance`

<!-- BEGIN GENERATED:cmd:vfs_optimize_lance -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:4989` · async
- 前端：app（1 处，例 `src/api/vfsRagApi.ts:233`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：modality?: string | null
  - 结果：integer(usize) · 错误：string · 注入：state, state
<!-- END GENERATED:cmd:vfs_optimize_lance -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_rag_search`

<!-- BEGIN GENERATED:cmd:vfs_rag_search -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:4889` · async
- 前端：app（1 处，例 `src/api/vfsRagApi.ts:121`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：input: VfsRagSearchInput
  - 结果：VfsRagSearchOutput · 错误：string · 注入：state, state, state
<!-- END GENERATED:cmd:vfs_rag_search -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_reindex_resource`

<!-- BEGIN GENERATED:cmd:vfs_reindex_resource -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:3153` · async
- 前端：app（1 处，例 `src/api/vfsUnifiedIndexApi.ts:194`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：resourceId: string, embeddingDim?: integer(i32) | null
  - 结果：integer(usize) · 错误：string · 注入：app-handle, state, state, state
<!-- END GENERATED:cmd:vfs_reindex_resource -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_reindex_unit`

<!-- BEGIN GENERATED:cmd:vfs_reindex_unit -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/index_handlers.rs:39` · async
- 前端：app（1 处，例 `src/api/vfsUnifiedIndexApi.ts:106`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：unitId: string, mode: string
  - 结果：boolean · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_reindex_unit -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_reset_all_index_state`

<!-- BEGIN GENERATED:cmd:vfs_reset_all_index_state -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:5922` · async
- 前端：app（1 处，例 `src/api/vfsRagApi.ts:464`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：（无）
  - 结果：integer(i32) · 错误：string · 注入：state, state
<!-- END GENERATED:cmd:vfs_reset_all_index_state -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_reset_disabled_to_pending`

<!-- BEGIN GENERATED:cmd:vfs_reset_disabled_to_pending -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:5859` · async
- 前端：app（1 处，例 `src/api/vfsRagApi.ts:426`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：（无）
  - 结果：integer(i32) · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_reset_disabled_to_pending -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_reset_indexed_without_embeddings`

<!-- BEGIN GENERATED:cmd:vfs_reset_indexed_without_embeddings -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:5885` · async
- 前端：app（1 处，例 `src/api/vfsRagApi.ts:444`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：（无）
  - 结果：integer(i32) · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_reset_indexed_without_embeddings -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_resolve_resource_refs`

<!-- BEGIN GENERATED:cmd:vfs_resolve_resource_refs -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/ref_handlers.rs:153` · async
- 前端：app（4 处，例 `src/features/chat/context/vfsRefApi.ts:171`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：refs: VfsResourceRef__De[]
  - 结果：ResolvedResource[] · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_resolve_resource_refs -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_resource_exists`

<!-- BEGIN GENERATED:cmd:vfs_resource_exists -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:378` · async
- 前端：app（1 处，例 `src/features/chat/resources/api.ts:229`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：resourceId: string
  - 结果：boolean · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_resource_exists -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_restore_mindmap_version`

<!-- BEGIN GENERATED:cmd:vfs_restore_mindmap_version -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:5187` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：versionId: string
  - 结果：VfsMindMap · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_restore_mindmap_version -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_retry_pdf_processing`

<!-- BEGIN GENERATED:cmd:vfs_retry_pdf_processing -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:6558` · async
- 前端：app（1 处，例 `src/api/vfsPdfProcessingApi.ts:185`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：fileId: string
  - 结果：null · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_retry_pdf_processing -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_search`

<!-- BEGIN GENERATED:cmd:vfs_search -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:3132` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：params: VfsSearchParams
  - 结果：VfsSearchResult[] · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_search -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_search_all`

<!-- BEGIN GENERATED:cmd:vfs_search_all -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:811` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：params: SearchAllInput
  - 结果：VfsListItem[] · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_search_all -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_set_attachment_root_folder`

<!-- BEGIN GENERATED:cmd:vfs_set_attachment_root_folder -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:1662` · async
- 前端：app（1 处，例 `src/api/attachmentConfigApi.ts:14`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：folderId: string
  - 结果：null · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_set_attachment_root_folder -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_set_default_embedding_dimension`

<!-- BEGIN GENERATED:cmd:vfs_set_default_embedding_dimension -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:3693` · async
- 前端：app（1 处，例 `src/api/vfsUnifiedIndexApi.ts:302`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：dimension: integer(i32), modality: string
  - 结果：boolean · 错误：string · 注入：state, state
<!-- END GENERATED:cmd:vfs_set_default_embedding_dimension -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_set_indexing_config`

<!-- BEGIN GENERATED:cmd:vfs_set_indexing_config -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:4043` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：key: string, value: string
  - 结果：null · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_set_indexing_config -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_set_mindmap_favorite`

<!-- BEGIN GENERATED:cmd:vfs_set_mindmap_favorite -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:5331` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：mindmapId: string, isFavorite: boolean
  - 结果：null · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_set_mindmap_favorite -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_start_pdf_processing`

<!-- BEGIN GENERATED:cmd:vfs_start_pdf_processing -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:6592` · async
- 前端：app（1 处，例 `src/api/vfsPdfProcessingApi.ts:202`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：fileId: string, startFromStage?: string | null
  - 结果：null · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_start_pdf_processing -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_sync_resource_units`

<!-- BEGIN GENERATED:cmd:vfs_sync_resource_units -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/index_handlers.rs:164` · async
- 前端：app（1 处，例 `src/api/vfsUnifiedIndexApi.ts:123`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：resourceId: string, resourceType: string, data?: string | null, ocrText?: string | null, ocrPagesJson?: string | null, blobHash?: string | null, pageCount?: integer(i32) | null, extractedText?: string | null, previewJson?: string | null
  - 结果：UnitIndexStatus[] · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_sync_resource_units -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_toggle_index_disabled`

<!-- BEGIN GENERATED:cmd:vfs_toggle_index_disabled -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:3282` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：resourceId: string
  - 结果：string · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_toggle_index_disabled -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_unified_batch_index`

<!-- BEGIN GENERATED:cmd:vfs_unified_batch_index -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/index_handlers.rs:56` · async
- 前端：app（1 处，例 `src/api/vfsUnifiedIndexApi.ts:116`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：mode: string, batchSize?: integer(i32) | null
  - 结果：dstu_vfs__vfs__index_handlers__BatchIndexResult · 错误：string · 注入：state, state, state
<!-- END GENERATED:cmd:vfs_unified_batch_index -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_unified_index_status`

<!-- BEGIN GENERATED:cmd:vfs_unified_index_status -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/index_handlers.rs:18` · async
- 前端：app（1 处，例 `src/api/vfsUnifiedIndexApi.ts:92`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：（无）
  - 结果：dstu_vfs__vfs__index_service__IndexStatusSummary · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_unified_index_status -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_update_mindmap`

<!-- BEGIN GENERATED:cmd:vfs_update_mindmap -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:5250` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：mindmapId: string, params: UpdateMindMapInput
  - 结果：VfsMindMap · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_update_mindmap -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_update_note`

<!-- BEGIN GENERATED:cmd:vfs_update_note -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:516` · async
- 前端：none
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：id: string, params: UpdateNoteInput
  - 结果：VfsNote · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_update_note -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_update_path_cache`

<!-- BEGIN GENERATED:cmd:vfs_update_path_cache -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:1143` · async
- 前端：app（1 处，例 `src/features/chat/context/vfsRefApi.ts:189`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：folderId: string
  - 结果：integer(u32) · 错误：string · 注入：state
<!-- END GENERATED:cmd:vfs_update_path_cache -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `vfs_upload_attachment`

<!-- BEGIN GENERATED:cmd:vfs_upload_attachment -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:1327` · async
- 前端：app（5 处，例 `src/components/QuestionInlineEditor.tsx:400`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：params: VfsUploadAttachmentParamsExt
  - 结果：VfsUploadAttachmentResult · 错误：string · 注入：app-handle, state, state
<!-- END GENERATED:cmd:vfs_upload_attachment -->

- [x] 输入：handlers.rs:1310-1325 camelCase；base64Content/stagedUploadId/attachmentType/folderId 均 serde default；stagedUploadId 非空优先于 base64。
- [x] 输出：VfsUploadAttachmentResult；仅 PDF/图片带 processingStatus/Percent/readyModes（无状态时 PDF page_compression/25、图片 image_compression/10；completed_with_issues 有可重试失败才续跑）；PDF 带 contentKind（阈值 100）。
- [x] 错误：字符串错误（CommandError）；媒体 base64 "Base64 decode failed: …"；暂存/L11 上传错误原样；mediaKind（L11 api.ts）未发布时明确报错。
- [x] 事件：无直接事件；媒体上传后 notify resource-created 钩子（hooks.rs:120-136，本 lane 注册表 `vfs.resourceCreatedHooks`）。
- [x] DB 读写：全部经 L11 attachments/files/blobs；单元同步经 L12 vfsUnitBuilder（失败 warn 继续）；默认目录经 AttachmentConfig。
- [x] 取消/并发：线程语义差异：Rust 整段在 `tokio::task::spawn_blocking` 中执行（解码、解析、文件 I/O、SQLite 不占 async 运行时）；TS 在 Host 主事件循环执行同步 SQLite/文件 I/O，仅 F7 渲染/文档解析与 L11 上传为 await 点。结果与错误等价，但大文件期间会阻塞事件循环；R13-02 同类问题，待 vfsWorker 承接上传路径后迁移。流水线启动 `tokio::spawn` → queueMicrotask 分离执行。
- [x] 时间/ID：ID/哈希由 L11 生成。

## 命令 `vfs_upload_file`

<!-- BEGIN GENERATED:cmd:vfs_upload_file -->
- Rust：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:2107` · async
- 前端：app（1 处，例 `src/api/vfsFileApi.ts:92`）
- 契约：`contracts/ipc/L13-vfs-api.json`
  - 参数：params: VfsUploadFileParams
  - 结果：VfsUploadFileResult · 错误：string · 注入：app-handle, state, state, state, state
<!-- END GENERATED:cmd:vfs_upload_file -->

- [x] 输入：handlers.rs:1985-1995；base64 STANDARD 严格解码（不 trim）；fileType 缺省按 infer_file_type。
- [x] 输出：VfsUploadFileResult；复用分支不带 ocrStatus/indexStatus 且 isNew=false；新建分支 indexStatus 文案四分支、ocrStatus 按 ocr.* 设置（F4 settings）。
- [x] 错误：UNSUPPORTED_FILE_TYPE 结构化文案、"File too large: max {}MB, got {:.2}MB"、saga 失败原样；L11 attachmentProcessing 未发布时明确报错。
- [x] 事件：媒体新建后 notify resource-created 钩子；PDF/图片启动流水线（ocr_processing / image_compression）。
- [x] DB 读写：TD-03 saga——预览在 savepoint 外渲染并记补偿账本；主 blob（图片或 ≥1MiB）+ files 三表同一 savepoint；失败 abort + remove_unregistered_blob_file；去重命中回退引用。页级文本仅在 created 时经 L11 setUploadOcrPagesWithConn 在同一 conn 写入（`UPDATE files SET ocr_pages_json = ?1 WHERE id = ?2`，不改 updated_at；失败只 warn 原始 SQLite 错误，handlers.rs:2527-2538；WP-109）。PDF 预览配置用 L11 DEFAULT_PDF_PREVIEW_CONFIG（handlers.rs:2302/7434 `PdfPreviewConfig::default()`）。索引失败 markFailed。
- [x] 取消/并发：线程语义差异：Rust 整段在 `tokio::task::spawn_blocking` 中执行（解码、解析、文件 I/O、SQLite 不占 async 运行时）；TS 在 Host 主事件循环执行同步 SQLite/文件 I/O，仅 F7 渲染/文档解析与 L11 上传为 await 点。结果与错误等价，但大文件期间会阻塞事件循环；R13-02 同类问题，待 vfsWorker 承接上传路径后迁移。流水线启动 `tokio::spawn` → queueMicrotask 分离执行。
- [x] 时间/ID：ID 由 L11 生成；sha256 小写十六进制。

## 事件 `dstu:change`

<!-- BEGIN GENERATED:event:dstu:change -->
- 事件名 `dstu:change`
- 发送点：`src-tauri/crates/dstu-vfs/src/dstu/handler_utils/node_converters.rs:140`（emit）
<!-- END GENERATED:event:dstu:change -->

- [ ] 载荷：
- [ ] 触发时机与顺序：
- [ ] 节流/合并：
- [ ] 是否在事务提交后：
- [ ] 目标窗口（emit / emit_to / emit_filter）：

## 事件 `mm_index_progress`

<!-- BEGIN GENERATED:event:mm_index_progress -->
- 事件名 `mm_index_progress`
- 发送点：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:6105`（emit）
- 发送点：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:6447`（emit）
<!-- END GENERATED:event:mm_index_progress -->

- [ ] 载荷：
- [ ] 触发时机与顺序：
- [ ] 节流/合并：
- [ ] 是否在事务提交后：
- [ ] 目标窗口（emit / emit_to / emit_filter）：

## 事件 `pdf-annotations:changed`

<!-- BEGIN GENERATED:event:pdf-annotations:changed -->
- 事件名 `pdf-annotations:changed`
- 发送点：`src-tauri/crates/dstu-vfs/src/dstu/handlers.rs:3858`（emit）
<!-- END GENERATED:event:pdf-annotations:changed -->

- [ ] 载荷：
- [ ] 触发时机与顺序：
- [ ] 节流/合并：
- [ ] 是否在事务提交后：
- [ ] 目标窗口（emit / emit_to / emit_filter）：

## 事件 `todo://changed`

<!-- BEGIN GENERATED:event:todo://changed -->
- 事件名 `todo://changed`
- 发送点：`src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:31`（emit）
<!-- END GENERATED:event:todo://changed -->

- [ ] 载荷：
- [ ] 触发时机与顺序：
- [ ] 节流/合并：
- [ ] 是否在事务提交后：
- [ ] 目标窗口（emit / emit_to / emit_filter）：

## 事件 `vfs-index-progress`

<!-- BEGIN GENERATED:event:vfs-index-progress -->
- 事件名 `vfs-index-progress`
- 发送点：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:3189`（emit）
- 发送点：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:3223`（emit）
- 发送点：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:3242`（emit）
- 发送点：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:3255`（emit）
- 发送点：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:3903`（emit）
- 发送点：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:3941`（emit）
- 发送点：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:3968`（emit）
- 发送点：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:3991`（emit）
- 发送点：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:4007`（emit）
- 发送点：`src-tauri/crates/dstu-vfs/src/vfs/handlers.rs:4024`（emit）
<!-- END GENERATED:event:vfs-index-progress -->

- [ ] 载荷：
- [ ] 触发时机与顺序：
- [ ] 节流/合并：
- [ ] 是否在事务提交后：
- [ ] 目标窗口（emit / emit_to / emit_filter）：

## 事件 `event_name`

<!-- BEGIN GENERATED:event:expr:event_name -->
- 动态事件名（表达式）
- 发送点：`src-tauri/crates/dstu-vfs/src/dstu/handler_utils/node_converters.rs:131`（emit）
<!-- END GENERATED:event:expr:event_name -->

- [ ] 载荷：
- [ ] 触发时机与顺序：
- [ ] 节流/合并：
- [ ] 是否在事务提交后：
- [ ] 目标窗口（emit / emit_to / emit_filter）：
