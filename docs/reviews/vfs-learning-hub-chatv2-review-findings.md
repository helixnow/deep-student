# VFS / 学习资源管理器 / chat_v2 互联 全面审阅问题清单

> 审阅日期：2026-06-10（进行中，边审边补充）
> 范围：vfs 后端、dstu 协议层、learning-hub 前端、practice（刷题）、todo、pomodoro、chat_v2 互联
> 约定：忽略暂存区未提交的云同步相关修改
> 状态标记：⬜ 待确认 / ✅ 已确认（代码层面） / 🧪 需运行验证

严重级别：🔴 严重（数据损坏/功能断裂/静默错误） · 🟡 中等（一致性/性能/边界缺陷） · 🟢 轻微（健壮性/可维护性）

---

## A. VFS 后端（schema / repos / handlers）

### A1 🔴 questions_fts 外部内容表触发器模式错误 ✅
- 位置：`src-tauri/migrations/vfs/V20260130__init.sql` L479-500
- FTS5 `content='questions'` 外部内容表的 AFTER UPDATE/DELETE 触发器使用了普通 `DELETE FROM questions_fts WHERE rowid=...`，而非官方要求的 `INSERT INTO questions_fts(questions_fts, rowid, ...) VALUES('delete', OLD.rowid, OLD....)` 模式。
- AFTER 触发时内容行已变更/删除，FTS5 反查拿到 NEW/空值 → 倒排索引逐渐腐化（幽灵结果/漏检）。后续迁移未修复。
- 建议：重建触发器为 'delete' 命令模式，并执行 `INSERT INTO questions_fts(questions_fts) VALUES('rebuild')` 一次性修复存量。

### A2 🔴 cleanup_blob 在事务内先删物理文件 ✅
- 位置：`src-tauri/src/vfs/repos/blob_repo.rs` L341-394；调用方 `folder_repo.rs::purge_folder_with_conn` L1239（SAVEPOINT 内）
- 物理文件删除不可回滚；若后续 SQL 失败回滚，DB 记录复活但文件已永久丢失 → 悬挂 blob 记录。
- 建议：把文件删除挪到事务提交后（收集待删列表，RELEASE 后统一删）。
- **补充（本轮确认为系统性问题）**：同一模式还存在于
  - `file_repo.rs::purge_file_with_conn` L919-965：BEGIN IMMEDIATE 后立即 `decrement_ref_with_conn`（内部 `fs::remove_file`），随后才 DELETE files/resources，任一步失败 ROLLBACK → blobs 行复活但物理文件已删；
  - `attachment_repo.rs::purge_attachment_with_conn` L1705-1785：同样在事务内先递减附件 blob + 全部 PDF 预览页 blob（可能几十个文件），再删记录——回滚面更大。
  - 三处共用一个修复方案：decrement 只改计数，物理删除统一收集到 COMMIT 之后执行（cleanup_blob 拆成"标记"与"删文件"两阶段）。

### A3 🟡 blob ref_count 手工维护无对账 ✅
- decrement 用 `MAX(0, ref_count-1)` 吞掉双重递减；`cleanup_unreferenced` 扫 ref_count=0 直接删文件，计数偏低时会误删仍被 `files.blob_hash` 引用的文件。
- 建议：增加基于实引用（files/preview_json/vfs_index_units.image_blob_hash）的对账任务，删除前校验无真实引用。

### A4 🟡 store_blob 同内容不同扩展名产生孤儿文件 ✅
- 位置：`blob_repo.rs` L80-145。DB 行 ON CONFLICT 只加 ref_count、保留首个 relative_path；但文件写入用新扩展名路径判断"不存在→写入" → 磁盘出现第二份 `{hash}.{ext2}`，永不被引用/清理。
- 建议：写文件前按 hash 查 DB 已有 relative_path，存在则跳过写入。

### A5 🟡 vfs_upload_file 无整体事务（代码自身 TODO 承认） ✅
- 位置：`src-tauri/src/vfs/handlers.rs` L2067-2073。PDF 预览页图 blob 先于文件记录写盘；失败补偿只清主 blob，页图 blob 泄漏。
- 另：上传走 base64 全量过 IPC，大文件内存放大（decode 后 content.clone() 给 spawn_blocking 又一份）。

### A6 🟡 软删除文件物理删向量索引，恢复不重建 ✅
- 位置：`file_repo.rs::delete_file_with_index_cleanup` L1539（删 units+lance 向量）；`restore_file_with_conn` L834 只恢复 files/folder_items，不重置 index_state、不触发重索引。
- 后果：回收站恢复后该文件永久退出 RAG 检索（除非手动重建索引）。🧪 需确认 delete_resource_index_full 是否重置 resources.index_state。

### A7 🟡 时间戳类型/格式混乱 ✅
- folders.updated_at INTEGER(ms) vs deleted_at TEXT(ISO)；notes/files 用 ISO 文本；questions 触发器写 `datetime('now')`（无 T/Z）与 Rust 写的 `%Y-%m-%dT%H:%M:%S%.3fZ` 并存于同一列 → 字符串排序/比较在两种格式间不可比。
- get_folder_with_conn 已被迫用 `CASE typeof(...)` 兼容（folder_repo.rs L385），说明历史已踩坑。
- 修复迁移 `V20260207__unify_deleted_at_type.sql` 本身又引入第三种格式：`datetime(...)||'Z'` 产出 `YYYY-MM-DD HH:MM:SSZ`（空格无 T），与 Rust 写的 `...T...Z` 字符串比较时排序错位（'T' > ' '）。
- 建议：统一为 INTEGER 毫秒（Refinery 迁移），所有写入路径收敛到单一函数。

### A8 🟡 add_item_to_folder 物理 DELETE 历史行 ✅
- 位置：`folder_repo.rs::add_item_to_folder_with_conn` L2371-2392。先 `DELETE FROM folder_items WHERE item_id AND item_type`（含软删行）再 INSERT。
- 后果：回收站中该资源的"原位置"记录被抹掉；依赖 tombstone 的同步逻辑可能丢失删除传播依据。

### A9 🟡 "同一资源只在一个文件夹"仅靠应用层保证 ✅
- 唯一索引是 `(folder_id, item_type, item_id)`，跨文件夹重复挂载在 schema 层是合法的；云同步合并/旧数据可绕过应用层 DELETE+INSERT 约定。
- 建议：若确为单挂载语义，唯一索引应为 `(item_type, item_id) WHERE deleted_at IS NULL`。

### A10 🟢 vfs_search_all 全 LIKE '%q%' 扫描 ✅
- notes/essays/translations 无 FTS，title/内容 LIKE 全表扫；questions 有 FTS 但此入口未用。数据量大后明显卡顿。

### A11 🟢 杂项 ✅
- `database.rs` CURRENT_SCHEMA_VERSION=20260212 落后于实际迁移（仅统计展示用，但 `test_migrations_idempotent` 断言会失败）。
- create_folder 深度/数量 check-then-act 非事务，并发可超限。
- store_blob 临时文件 `{hash}.tmp` 共享名，并发同 hash 上传有竞写窗口（内容相同、危害低）。
- move_folder 无 SAVEPOINT；path_cache 失效失败仅 warn → 残留陈旧路径缓存。
- `vfs_get_file` 接受 `tb_` 前缀但 `vfs_delete_file` 只接受 `file_`，前缀校验不一致。
- blob_exists 用 COUNT(*) 而非 EXISTS。
- 索引状态机写 `resources.updated_at`（embedding_repo.rs mark_pending/indexing/indexed/failed 均 `SET updated_at = now`）→ 后台索引一跑，资源在"按修改时间排序"的列表里集体上浮，且会触发 change_log/同步噪声。索引状态变更不应触碰业务 updated_at。

---

## B. learning-hub 前端 / dstu API 层

### B1 🔴 invoke 参数命名疑似契约断裂 🧪
- 位置：`src/dstu/api.ts` L775（moveMany 传 `dest_folder`）、L802（searchInFolder 传 `folder_id`）。
- 后端 `dstu_move_many(dest_folder: String)`、`dstu_search_in_folder(folder_id: Option<String>)` 均未加 `rename_all="snake_case"`，Tauri v2 默认只匹配 camelCase。
- 预期后果：moveMany 必失败（缺必填参数）；searchInFolder 的 folder_id 静默为 None → "文件夹内搜索"实际是全库搜索。
- 佐证：`src/utils/settingsApi.ts` 等处均 snake+camel 双传规避此坑，唯独这两处只传 snake。
- moveMany 当前无调用方（死代码+坏契约）；searchInFolder 由 finderStore.executeSearch 实际使用。

### B2 🟡 逐项查询违反"禁止逐行查询"规则 ✅
- "最近文件"视图：`finderStore.loadItems/executeSearch` 对每条 recent 记录单独 `dstu.get(path)`，失败再 `dstu.get('/'+id)` 重试 → 最多 2N 次 IPC。
- `collectNodeIdsForInvalidation`（api.ts L207）：deleteMany/restoreMany/moveMany 成功后又对每个 path 逐个 get（N+1）。
- 建议：补充批量接口 `dstu_get_many(paths) -> Vec<Option<DstuNode>>`，一次往返。

### B3 🟡 搜索语义不完整 ✅
- 回收站/最近视图的搜索只在当前 limit/offset 一页内做 `name.includes` 前端过滤 → 结果不全且无提示。
- trash 搜索的类型映射表缺 `folder`（loadItems 有、executeSearch 无），行为不一致。

### B5 🟡 recentStore 纯前端 localStorage，与后端无失效联动 ✅
- `stores/recentStore.ts`：最近访问完全存 localStorage（50 条 id+path+name），后端无 accessedAt 字段（代码注释自认临时方案）。
- 资源被删除/重命名/移动后 recent 记录不失效：名称陈旧、path 失效（这正是 finderStore 被迫对每条 recent 逐个 `dstu.get` 再按 id 兜底重试的根因，即 B2 的 2N 次 IPC）。彻底删除后仍留死条目，直到 get 失败才在视图层被过滤。
- 建议：后端补 accessed_at + `dstu_list_recent` 批量接口，前端仅做缓存。

### B6 🟡 文件预览先全量 IPC 传输再判"过大" ✅
- `apps/views/FileContentView.tsx` L284-297：`vfs_get_attachment_content` 先把整个文件 base64 返回前端，**之后**才用 `estimateBase64Size > 100MB` 拒绝预览 → 打开超大文件时 IPC 已搬运全量内容（500MB 文件 = ~670MB base64 字符串进前端堆）才提示"文件过大"。
- `node.size` 在组件内可得（依赖数组里就有），应在 invoke 前判断；或后端按大小拒绝/分页。
- 音视频预览同样 base64 全量 → Blob → ObjectURL，不走 Tauri asset protocol 流式播放：~100MB 内的视频要双倍内存，超过即完全不可播。
- 预览渲染安全做得好：DOMPurify 白名单 + href 协议二次检查（sanitizeRenderedDom.ts）✓。

### B4 🟢 导航与排序细节 ✅
- enterFolder 先 await fetchBreadcrumbs 再 navigateTo，无请求序号保护，快速连点可能后发先至（loadItems 自身有 requestId 保护，导航本身没有）。
- sortItems 用 `new Date(updatedAt)` 解析后端混合时间格式（A7 的前端映照），`datetime('now')` 格式会被当本地时区解析 → 排序漂移。
- select 'range' 模式清空既有选择（代码注释自认简化）。
- deleteResource/move/setMetadata 操作前先 get 一次仅为缓存失效收集 id → 每操作多一次 IPC。
- LearningHubSidebar 教材导入（L770-798）：`await addTextbooks` 期间组件卸载时，`if (!isMountedRef.current) return` 早退跳过了 `unlisten()` → textbook-import-progress 事件监听器泄漏（应放 finally 或 effect cleanup）。
- LearningHubSidebar 整体工程质量较好：isMountedRef、watch 防抖 300ms、canvas 视图隔离、删除确认对话框替代 window.confirm 等均已到位 ✓。

---

## C. practice（刷题）/ todo / pomodoro

### C1 🟡 repeat_json 重复规则是死字段 ✅
- `todo_repo.rs` 仅存取 repeat_json，无任何解析；toggle 完成不生成下一次任务；前端仅类型声明（`src/features/todo/types.ts` L37/L115）无 UI/逻辑。
- 要么实现 recurrence 引擎，要么移除字段避免误导。

### C2 🟡 番茄钟计时不抗休眠/重启 ✅
- `usePomodoroStore`：纯 tick 递减无 wall-clock 校准，webview 节流/系统休眠后计时冻结；mode/status/timeLeft 不持久化（partialize 只存 settings/统计），重启应用进行中的番茄钟静默消失，且不会记录 interrupted。
- 建议：基于 sessionStartTime + 当前时间计算剩余；persist 运行态。

### C3 🟢 todo 细节 ✅
- toggle_todo_item 读-改-写非原子（本地单用户影响小）。
- 清空 due_date 的契约是"传空字符串"（normalize_optional_str），隐式约定无文档。
- update_todo_item 的 Option 语义：None=保留、Some("")=清空——estimated/completed_pomodoros 等 i32 字段无法清空（Some 必有值）。
- pomodoro_create_record fire-and-forget，失败仅 console.error，统计静默丢失。
- 今日/逾期查询用 Local::now ✓ 正确。
- `V20260311__todo_constraints.sql`：UPDATE 触发器有 self-ref/环检测，但 INSERT 触发器缺 `parent_id = NEW.id` 自引用检查（客户端自定 id 时可插入自指节点）。
- `V20260309__decouple_todo_from_vfs.sql` 重建表时 `DROP TABLE todo_lists` 若 todo_items 有 FK 引用 todo_lists 且 PRAGMA foreign_keys=ON，迁移行为依赖执行时 FK 开关状态（Refinery 运行环境需确认）。

### C4 🔴 删除题目不清理复习计划，到期列表出现幽灵复习 ✅
- 位置：`question_bank_service.rs::delete_question` L253-270 / `batch_delete_questions` L273-316 —— 只软删 questions + 刷统计，**从不调用 `delete_plan_by_question`**（该函数全仓库无业务调用方）。
- 而 `review_plan_repo.rs::list_due_reviews_with_conn` L348-439 只查 review_plans，**不 JOIN questions 过滤 deleted_at** → 已删除题目的复习计划永远按期到期，前端拿到 plan 后查不到题目（或显示幽灵卡片），且 due 统计虚高。
- answer_submissions 同样不随题目删除清理（delete_submissions_by_question 仅在某个 859 行附近的 tx 中用于其它流程）。
- 建议：删除题目时同事务暂停/删除其 review_plan；list_due_reviews JOIN questions 过滤。

### C5 🟡 复习计划日期用 UTC，与 todo 模块的 Local 语义冲突 ✅
- `review_plan_repo.rs` L242/352/599、`review_plan_service.rs` L203：`Utc::now().format("%Y-%m-%d")` 计算 today/next_review_date。
- UTC+8 用户在 0:00–8:00 间复习：last_review_date 记成"昨天"，到期复习要到本地 8 点后才出现；与 todo（`Local::now`，正确）口径不一致。

### C6 🟡 批量删题 N+1 + N 个事务 ✅
- `question_bank_service.rs::batch_delete_questions` L279-302：循环内逐个 `get_question`（一次查询）+ `batch_delete_questions(&[单个id])`（每次 BEGIN IMMEDIATE 事务）→ 删 100 题 = 200+ 次查询 + 100 个事务。repo 层明明有真正的批量接口却被逐个调用。违反"禁止逐行查询"。

### C8 🟡 前端打开题目集即全量拉取所有题目 ✅
- `src/hooks/useQuestionBankSession.ts::fetchAllQuestions` L173-222：挂载时 while(has_more) 串行翻页把整个题集拉完（50/页）→ 2000 题 = 40 次串行 IPC；分页状态随即 has_more=false，`loadMoreQuestions` 实际成为死代码。
- 与后端 D13（qbank_get_next_question 全量拉题）互为镜像：前后端都没把分页当分页用。
- 其余实现质量不错：requestId+epoch 双重并发防护 ✓、提交后用后端返回的 updated_question/updated_stats 原子更新 ✓、幂等 client_request_id ✓。
- 另：ExamContentView 练习计时器同 C2 模式（setInterval 每秒 +1，无 wall-clock 校准，不持久化）——限时/模拟考超时判定依赖后端 session 状态，影响仅限显示。

### C7 🟢 刷题杂项 ✅
- `submit_answer_with_conn`（question_repo.rs L1731）：`is_correct=None` 且非手动批改时，`?2 = 0` 为 NULL，CASE 落入 `correct_count >= 2 → 'mastered'` 分支——未判分的主观题提交可能直接把题目标为已掌握；同时 is_correct 被覆盖为 NULL 丢失上次判定。
- `rebuild_fts_index_with_conn` L869 对外部内容 FTS5 表执行 `DELETE FROM questions_fts`——外部内容表的 DELETE 会按"当前内容表的值"反查删除索引项，索引已腐化时（A1）无法清干净；应使用 `INSERT INTO questions_fts(questions_fts) VALUES('rebuild')`。
- `process_review`（review_plan_service.rs L190/255）：plan 在事务外读取、事务内按旧值覆盖写——并发提交同一计划会丢更新（本地单用户低风险）。
- `batch_create_from_questions` 用错误信息字符串匹配 "already exists" 判断跳过；为整卷创建计划时每题 4 次查询（get_question + exists + insert + re-get）。
- search_questions（FTS 路径）实现质量较好：参数化、bm25 排序、LIKE 兜底 ✓。但 FTS 正确性受 A1 触发器缺陷影响。

---

## D. chat_v2 互联（引用注入 / 解引用 / workspace）

### D1 🔴 题目集注入读取陈旧快照 ✅
- 位置：`src-tauri/src/chat_v2/vfs_resolver.rs::resolve_exam` L1957。
- 注入内容（题干/答案/解析/状态/OCR）全部来自 `exam_sheets.preview_json` 识别时快照；用户后续在题库编辑的 questions 表数据不参与注入（只有 answer_submissions 作答历史走实表）→ AI 看到的题目是过期版本。
- 建议：注入时改查 questions 表（或 preview 与实表合并，questions 覆盖）。

### D2 🟡 解引用不过滤已删除资源 + 失效静默 ✅
- resolve_note/essay/translation/file 查询无 deleted_at/status 过滤 → 回收站资源仍被注入；mindmap 有过滤，语义不一致。
- 资源真不存在时 note/essay/translation 返回空 vec（无 [已删除] 占位），image/exam/mindmap 有占位文本 → 用户无法感知引用失效，且各类型行为不一。

### D3 🟡 历史消息每次发送全量重解引用 ✅
- `pipeline/history.rs::resolve_history_context_snapshot_v2` L438-516：续聊时对每条历史消息重新读 blob、重新 base64（PDF 预算上限 100页/50MB）→ 长会话延迟线性叠加。
- 建议：解析结果按 (message_id, resource_hash) 缓存，或历史注入退化为文本摘要。

### D4 🟡 useReferenceToChat 取最旧会话 ✅（上轮已发现，保留）
- `src/features/learning-hub/useReferenceToChat.ts` L217-224 取 `sessionIds[0]`（Map 插入序=最旧）而非当前活跃会话，多会话场景引用进错会话。
- 对照：姊妹 hook `useVfsContextInject.ts` L116-127 已做 P1-26 修复（优先 `getCurrentSessionId()`，回退 sessionIds[0]）——同一目录下两条注入链路行为不一致，useReferenceToChat 漏掉了同一修复。

### D5 🟢 诊断日志未降级 ✅
- get_image_ocr_text 每次跑 3 个诊断查询 + info 级 [OCR_DIAG] 日志（vfs_resolver.rs L361-468）；resolve_context_ref_data_to_content 同样 info 刷屏。生产应降为 debug/移除。

### D6 🟢 blocks_to_content 包装 injected_context 时 `[{name}]` 未做转义 ✅

### D7 🔴 前端解析路径（ref_handlers）PDF 多模态无预算上限 ✅
- 位置：`src-tauri/src/vfs/ref_handlers.rs::get_file_multimodal_blocks_with_conn` L1606-1751。
- 后端 chat 路径 `vfs_resolver.rs` 有 MULTIMODAL_BUDGET（100 页/50MB），但前端 `vfs_resolve_resource_refs` 走的这条路径对 PDF **逐页全量 base64，无页数/字节上限**。
- 后果：大 PDF（如 300 页）→ 单次 IPC 返回几百 MB JSON → 前端内存暴涨/卡死；且结果还会进入前端 LRU 缓存（见 D8）。
- exam 的 `get_exam_multimodal_blocks_with_conn` 同样无上限。

### D8 🟡 前端 resolveCache 缓存含 base64 的大对象 ✅
- 位置：`src/features/chat/context/vfsRefApiEnhancements.ts` L479：`LRUCache<string, ResolvedResource>(100, 5min)`。
- ResolvedResource 含 content（image 时为整张图 base64）与 multimodalBlocks（PDF 全页 base64）。100 条 × 数十 MB 级 → 浏览器堆内存风险。容量上限只按"条数"不按字节。
- 另：`batchGetResources` 返回 Map 仅按 sourceId 键控（L572/L629），同一 sourceId 不同 injectModes 的两个 ref 在同一批中互相覆盖（缓存键有 injectModes 但结果 Map 没有）。

### D9 🟡 Image 解析把 base64 与 OCR XML 拼进同一 content 字符串 ✅
- 位置：`ref_handlers.rs` L672-715（`content_parts.join("\n\n")`）；前端靠 `extractImagePayload`/`extractImageOcrText`（`definitions/image.ts` L98/L111）字符串嗅探拆开。
- 协议层用"裸 base64 + XML 文本"混拼单字符串传输结构化数据，脆弱：任何前端嗅探失误（如 OCR 文本本身以 base64 形态开头）都会把 base64 当文本注入 LLM（token 爆炸）。应改为结构化字段（imageBase64 / ocrText 分离）。

### D10 🟡 vfs_get_resource_refs 文件夹展开双重 N+1 ✅
- 位置：`ref_handlers.rs` L77-100：`get_folder_ref_count_with_conn` 为统计 total 对每个 item 完整执行一次 get_resource_ref（N 次查询），随后 `get_folder_refs_with_conn` 又对同一批 item 再查一遍（又 N 次）。违反"禁止逐行查询"，大文件夹注入时明显变慢。可一次 JOIN 查询完成。

### D11 🟢 ref_handlers 杂项 ✅
- `resolve_single_ref_with_conn` 对 exam 同样读 preview_json（与 D1 同源，前端路径也注入陈旧题目快照）。
- `get_resource_content_with_conn` 查 `resources.data` 无 deleted_at 过滤（上游 exists 查的是业务表，资源行软删时仍可读出）。
- `build_folder_path_with_conn` 用标题拼路径，标题含 "/" 时路径歧义；深度上限 11 硬编码。
- `escape_xml_content` 不转义引号（仅内容场景可接受）；`[PDF_DEBUG]`/`[OCR_DIAG]` 大量 info 级日志（同 D5）。
- `inferTypeFromSourceId`（vfsRefApi.ts L27 与 vfsRefApiEnhancements.ts L649 两份重复实现）均不识别 `mm_`/`file_`/`fld_` 前缀，mindmap 会被推断为 'file'。
- `sanitizeSourceId` 快速路径白名单同样缺 `mm_`/`file_` 前缀（仅影响性能路径，不影响正确性）。

### D12 🔴 qbank 工具链 questions 表与 preview_json 双轨写入不同步 ✅
- 位置：`src-tauri/src/chat_v2/tools/qbank_executor.rs`。
- `execute_submit_answer` L517-539：service 路径只写 questions 表，**preview_json 不更新**；降级路径只写 preview_json，questions 表不更新。
- `execute_update_question` L657-726：service 成功只改 questions 表，preview_json 中 answer/explanation/status 保持旧值。
- `execute_reset_progress` L1071-1098：service 路径重置 questions，preview_json 卡片的 attempt_count/status 原样保留；也不重置/暂停对应 review_plans。
- 唯一双写的是 `execute_batch_import`（preview+questions 同事务，S-009 ✓）。
- 与 D1 叠加后果：chat 注入读 preview_json、题库 UI 读 questions 表、统计读 questions 表 → 三视图互相矛盾（AI 看到的题目状态/答案永远停留在最后一次"降级写"或识别时刻）。
- 建议：将 preview_json 降级为纯识别产物（只读），所有运行时状态以 questions 表为 SSOT，注入与导出统一改查 questions。

### D13 🟡 qbank_get_next_question 全量拉题 ✅
- L908-913：`list_all_questions` 为取"下一题"把整个题集全部分页拉完（200/页，上限 1 万页）。sequential/review_first/by_tag 都可用一条带 ORDER/WHERE 的 SQL 完成。大题集时每次工具调用都是全表搬运。
- 另：`QBANK_WRITE_LOCK` 是全局单一互斥锁，不同题集的写操作也互相串行（本地可接受，留意）。

### D14 ✅ send_message / context_snapshot 链路（抽查通过）
- retry/edit-resend/continue 三条路径均从 `meta.context_snapshot.user_refs` 恢复引用；resource decrement 放在事务 COMMIT 后（P0 修复注释属实）；编辑重发的三态语义（None=继承/[]=清空/非空=替换）实现正确；恢复时 hash 优先、id 兜底。未发现新问题。
- workspace injector/coordinator 抽查无新问题（coordinator 含未提交云同步改动，按约定跳过）。

### D15 🟡 resource_read 工具不分页时返回全量文本，无任何长度上限 ✅
- 链路核实：`builtin_resource_executor.rs::execute_read` L1147 不带 page 参数时调 `get_content_by_type`（content_helpers.rs L148-218），对 note/textbook/file 返回**完整抽取文本，无截断**；`context.rs::tool_results_to_messages_impl` L368 `serde_json::to_string(&result.output)` 序列化进 LLM 消息也**无长度上限**。
- 对照组：vfs_resolver 的用户引用注入有页数+字节双预算（I12），essay 有 2 万字符限——同样的内容走"LLM 工具自取"路径就完全裸奔。
- 后果：LLM 对大教材调一次 resource_read（很常见，hint 只是建议分页并不强制）→ 数 MB 文本进入 tool 消息 → 上下文爆掉/请求被 API 拒绝/费用激增；且该结果持久化进会话 data_json，工具循环内每轮 LLM 调用都全量重放。
- 建议：get_content_by_type 出口加硬上限（如 50K 字符 + truncated 标记 + "请用 page_start/page_end"提示），与引用注入路径的预算体系对齐。

---

## F. dstu 协议层（handlers / trash / 路径）

### F1 🔴 B1 后端侧确认：参数命名契约断裂 ✅
- `dstu_move_many(paths, dest_folder)`（handlers.rs L5200）与 `dstu_search_in_folder(folder_id, ...)`（L5324）均为 snake_case 参数且未加 `rename_all = "snake_case"`。Tauri v2 默认期望前端传 camelCase（destFolder/folderId）。
- 前端 `src/dstu/api.ts` 只传 snake_case → `dest_folder` 必填缺失（move_many 调用报错）；`folder_id` 落空为 None → **文件夹内搜索静默退化为全局搜索**（L5489-5490 直接转 dstu_search）。

### F2 🟡 dstu_search_in_folder 逐项 N+1 + 内容召回二次过滤 ✅
- L5370-5459：对文件夹内每个 item 逐个 get_note/get_textbook/get_file/...（N 次查询）再内存 contains 过滤；应一条 JOIN + LIKE/FTS 查询完成。
- 索引召回（L5465）先全局 search_by_index 再用 folder_item_ids 过滤 → 限定文件夹时召回配额被全局结果稀释（folder 外结果被丢弃但占用了 limit）。
- 仅搜索直接子项，不含子文件夹（语义未文档化）。

### F3 🔴 软删除清向量、恢复不重建（A6 全类型扩大，已升级为严重） ✅
- `trash_handlers.rs::dstu_soft_delete` L157-160 删除后立即清理 lance 向量（text+multimodal）；`dstu_trash_restore` L179-227 恢复时**无任何重索引/重置 index_state 逻辑** → 所有资源类型（note/textbook/file/essay/mindmap...）恢复后永久退出语义检索。
- 已核实（indexing.rs L3615-3652 对比 trash_handlers.rs L84-107）：`cleanup_vector_index` 只删 lance 向量，**不删 `vfs_index_units`/`vfs_index_segments` 行、不重置 index_state**。完整清理函数 `VfsFullIndexingService::delete_resource_index`（删向量+删 units+mark_pending+刷新 record_count）存在但回收站路径未用。
- 三重后果：① units/segments 残留指向已删向量的悬挂行，embedding_dim 的 record_count 漂移；② index_state 停留 'indexed'，恢复后 `check_needs_reindex` 认为无需重索引 → 永久退出 RAG；③ 若任何检索/统计直接读 units 表，软删资源仍会出现。
- 修复：dstu_soft_delete 改调 delete_resource_index（或至少同步删 units + mark）；dstu_trash_restore 恢复后 mark_pending 触发重索引。

### F4 🟢 回收站杂项 ✅
- `dstu_list_trash`：8 类各取 limit+offset 条内存合并排序——无总数返回，前端只能以 items.length 推断 hasMore；类型间数量差异大时分页页边界不稳定。
- `dstu_empty_trash`：exam/translation/essay_session 逐个 purge（每个独立事务），任一失败即中断返回 → 回收站清一半；列表上限 1000 条，超出残留；已删除的独立 essay 轮次（essay_ 前缀旧数据）永远无法从回收站清除（注释明示不兼容）。
- `dstu_move_many` 成功后对每项再 get_resource_by_type_and_id 发事件（又一轮 N+1）。
- `dstu_watch/unwatch` 是空操作占位，前端 watch 语义实际仅靠各命令手动 emit。

### F5 🟡 增量同步产生的孤立 Lance 向量只打日志、永不回收 ✅
- `index_service.rs::sync_resource_units_with_conn` L152-159：内容编辑导致 units 收缩/重建时，`sync_units` 返回 `orphaned_lance_row_ids`，但调用链只 `log::warn!`（"These should be cleaned up by the next full index or manual cleanup"），**没有任何清理队列或后台任务**。
- 后果：笔记/题目反复编辑后，LanceDB 积累指向已删 segment 的陈旧向量；RAG 检索可能命中旧内容（payload 里的旧文本），且无 SQLite 行可反查来源。与 F3 是同一族"向量-元数据失同步"问题，但触发路径是日常编辑而非删除，更高频。
- 建议：把 orphaned ids 写入待删队列（类似 `__blob_deletion_queue`），由后台批量 `lance.delete`；或在 sync 后同步调用 delete by row_ids。
- 已沿检索路径核实危害成立：`indexing.rs::enrich_and_filter_results` L4193-4233 只按 resource 存在性+软删过滤，**检索文本直接来自 Lance payload**——资源仍存活时，编辑前的旧片段会作为检索结果返回给 LLM（陈旧上下文注入）。另注：该函数对每条结果逐个 `get_resource`（结果集小，影响有限）。
- 附带核实：`vfs_index_units` 对 resources **无外键**（V20260130 L691-713），purge 后 units 残留只能靠 trash_handlers 的异步清理兜底，单点遗漏即孤儿（与 F3 相互印证）。

## G. 媒体预处理流水线（pdf_processing_service / 索引调度）

### G1 🟡 中断恢复只"重置"不"续跑"：pending 任务无人认领 ✅
- `recover_stuck_tasks`（pdf_processing_service.rs L2388）启动时把 ocr_processing/page_compression/vector_indexing 等中间态重置为 `pending`，但全链路无人消费 pending：
  - `vfs_list_pending_pdf_processing` 后端命令**前端零调用**；`startPdfProcessing`（vfsPdfProcessingApi.ts L201）**零调用方**；
  - `retry()` L2334 只接受 stage∈{error, completed_with_issues}，**pending 不可重试**（chat 附件的重试按钮对其无效）；
  - 向量索引侧 `process_pending_batch` 同样只有 IndexStatusView/诊断面板的手动按钮触发，无后台调度器。
- 后果：重启打断 OCR 的 PDF 永久停在 pending（text 模式可用，但 OCR/压缩/向量索引不再继续），用户无从感知也无 UI 入口恢复（索引状态页只能补向量索引，不能补 OCR）。
- 建议：启动后对 recover 出的 pending 自动 start_pipeline（带并发上限），或把 retry 放宽到 pending。

### G2 🟡 进度持久化高频写 files.updated_at ✅
- `update_processing_status`/`emit_progress`（L2079/L2450）每次进度变更都 `UPDATE files SET ..., updated_at = datetime('now')`。
- 三重问题：① OCR 长流水线期间 files 行被高频改写，"按修改时间排序"的列表反复浮动；② 若 files 有 change_log/同步触发器则产生大量同步噪声；③ `datetime('now')` 又是 A7 里的无 T/Z 格式，与 Rust 写入格式混存同列。
- 与 A11 的 resources.updated_at 问题同根：处理/索引状态写入不应触碰业务 updated_at。

### G3 🟢 流水线杂项 ✅
- `run_pdf_pipeline_internal` L754-755：`let mut issues` 连续声明两次（第一个是死代码，复制粘贴痕迹）。
- PDF 与图片管线对 "image 就绪时机" 设计相反：PDF 等压缩完成才 ready（失败则回退原图 ready），图片上传后立即 ready（注释还保留着"必须等压缩"的旧设计说明）——语义不一致且注释误导。
- 取消/重启竞态防护（generation counter + remove_if + skip_stale_task_side_effects）做得扎实 ✓；stage_vector_indexing 有重复索引防护 ✓。
- OCR 并发=4、指数退避重试 3 次、失败降级 completed_with_issues 设计合理 ✓。
- 兼容事件双发（media-processing-* + pdf-processing-*）长期应收敛到统一事件。

## H. 其余后端模块（mindmap / essay / memory / path_cache）

### H1 🟢 memory 智能写入幂等保留行无启动清理 ✅
- `memory/service.rs`：smart_write 幂等机制完整（INSERT OR IGNORE 占位 + 完成后覆盖 + 24h TTL ✓），但两个边角：
  - 进程在写入中途崩溃时，`IN_PROGRESS` 占位行残留，同一幂等键在 24h TTL 内重试全部得到 Conflict（无启动时清理陈旧 IN_PROGRESS 的逻辑）。
  - 并发等待循环仅 20×50ms=1s，而 smart write 含 LLM 决策调用通常 >1s → 真并发重复请求大概率等不到结果而报错（语义可接受但与"幂等返回相同结果"的意图不符）。

### H2 🟢 mindmap 版本快照无保留策略 ✅
- `mindmap_repo.rs`：每次内容更新都写 `mindmap_versions` + 版本 resource（hash 去重 ✓），读侧 LIMIT 100，但写侧无修剪 → 高频编辑的导图版本表和版本资源无界增长。purge 时孤儿清理做得对 ✓。
- 正面：update 用 BEGIN IMMEDIATE 防 TOCTOU、乐观锁 expected_updated_at、共享资源写时复制、幂等删除区分"已删/不存在"，工程质量在所有 repo 中最高。

### H3 🟢 essay/path_cache 抽查通过 ✅
- essay_repo：事务、软删、回合号生成均规范；session 软删不级联软删子 essays（恢复语义正确，列表入口均经 session 过滤，可接受）。
- path_cache_repo：分批失效（BATCH_SIZE=100）、全量重建带事务、LEFT JOIN 过滤已删资源 ✓。无新问题。

## I. 用户使用生命周期视角（全子应用交互设计 × 后端逻辑）

> 按"用户旅程阶段"组织，引用前文问题编号，并补充本视角下的新发现（I1-I5）。

### I1 🔴 复习闭环断裂：SM-2 复习功能无任何 UI 入口 ✅
- `src/components/ReviewPlanView.tsx`（521 行）、`ReviewSession.tsx`、`ReviewCalendarView.tsx` 三个组件**全仓零导入**（仅 style-lab 扫描数据提及）；`reviewPlanStore` 也只被这三个孤儿组件消费。
- 后端 `review_plan_*` 全套命令、SM-2 算法、日历热力图 API 全部就绪，但用户从任何界面都到达不了复习视图 → "做题 → 错题进复习 → 按期复习"的核心学习闭环在 UI 层断头。
- 叠加 C4（删题留幽灵计划）、C5（UTC 日期）后，即使补上入口，到期列表也先要修数据正确性。
- 这是典型的"后端先行、前端未接线"：要么补侧边栏/题集详情页入口 + 全局到期角标（`useReviewDueCount` 已写好没人用），要么明确砍掉。
- **本轮升级——数据生产侧同样断头**：全仓搜索确认 `create_review_plan`/`get_or_create_plan`/`batch_create_from_questions`/`process_review` 除 review_plan_service 自身的 Tauri 命令外**零调用点**；而这些命令的前端唯一调用方 reviewPlanStore 又只被孤儿组件用。即：**答错题不会自动创建复习计划**——不是"功能藏起来了"，而是整条 SM-2 链路（数据写入→到期计算→复习 UI）端到端从未接通。修复时需同时在答题提交路径挂 get_or_create_plan，并补 UI 入口。

### I2 🟡 番茄钟完成通知出不了应用窗口 ✅
- `usePomodoroStore` 完成时仅 WebAudio 蜂鸣（代码 TODO 自认"Phase 3 换系统通知"）；无 Tauri Notification。
- 用户旅程矛盾点：番茄钟的本意是"用户离开屏幕/专注他处"，但 ① 窗口最小化时 WebView 节流 → C2 的 setInterval 冻结，时间到了也不触发；② 即便触发，蜂鸣在系统静音/不在前台时感知不到。工作完成后 status='paused' 等用户手动开始休息——配合收不到的通知，实际体验是"番茄钟永远停在等待里"。
- 建议：到点判定改 wall-clock（C2）、完成时发系统通知 + 可选自动开始休息。

### I3 🟡 todo 的 due_date 只是个排序字段，没有提醒生命周期 ✅
- 全 todo 模块（前端 components/stores + 后端 todo_repo）无任何 reminder/notification 代码；due_date 仅用于"今日/逾期"列表过滤。
- 用户设了截止时间后：不开 todo 面板就永远不知道逾期；repeat_json（C1）死字段加剧"看起来支持、实际不工作"的预期落差。
- 建议：最小闭环 = 应用内全局角标（逾期数）+ 启动时一次系统通知；repeat 字段要么实现要么从 UI 类型中移除。

### I4 🟡 复习/练习会话状态不抗中断（前端内存态） ✅
- `reviewPlanStore.session`（队列/进度/正确数）纯内存：复习到一半关窗，未答题目全部丢失会话上下文（已答的有后端记录）。ExamContentView 练习计时同样不持久化（C8 备注）。
- 对照：chat_v2 的流式恢复、note 的草稿队列都做了抗中断，学习侧没有对齐。
- 另：`getOverdueCount`/`getTodayDueCount` 用 `new Date().toISOString()`（UTC 日期）做"今天"，是 C5 后端 UTC 问题在前端的镜像，UTC+8 用户 0-8 点统计错位。

### I6 🟡 todo 前端无乐观更新 + 搜索无防抖 ✅
- `useTodoStore`：toggle/create/update/delete 全部走"等后端返回 → 全量 reloadCurrentView()"——勾一个复选框 = 2 次 IPC 往返 + 整个列表重取，无乐观更新，操作多时明显迟滞。
- `setSearch` 每个按键直接触发 `searchItems`（IPC），无防抖（对照 LearningHubSidebar 已有 300ms debounce 的成熟先例）。
- `updateItem`/`toggleItem` 吞错误（只 set error 不 throw），调用方无法感知失败；列表视图是否消费 error 状态未核实。
- （核实：`priorityFilter` 由 TodoMainPanel L556 本地过滤消费，生效，无问题。）

### I7 🟢 desktopStore 快捷方式与 recentStore 同病 ✅
- 桌面快捷方式（resource/folder 类型含 resourceId/path）持久化在 localStorage，资源删除/改名/移动后快捷方式悬挂，无后端失效联动（B5 同族）。

### I8 🟢 TextbookContentView 是体验工程标杆，但暴露 B6 的不一致 ✅
- 阅读进度/书签：2s/1s 防抖 + pending ref + unmount 合并 flush（单次 setMetadata 防竞态覆盖）——做法值得推广 ✓。
- 它在取内容前先查 `node.size > 100MB` 拒绝（L227），**FileContentView 漏了同一检查**（B6 的根因就是没抄这段）；两个视图同链路不同行为。
- 残留小缺口：应用直接退出（非组件卸载）时 2s 防抖窗口内的进度丢失（无 beforeunload flush，对照笔记编辑器有）。

### I9 🟡 番茄钟整个 UI 零国际化（纯硬编码中文） ✅
- `PomodoroPanel.tsx` / `ImmersiveFocusMode.tsx` / `GlobalPomodoroWidget.tsx` 三个组件**均未引入 useTranslation**，"专注中/短休息/暂停/今日 X 个番茄/中断 X 次"等全部硬编码中文。
- 项目其余部分（todo、learning-hub、notes）都已走 i18n（en-US/zh-CN 双语包）——英文用户会看到一个整块中文的番茄钟面板，体验割裂。todo 组件里也有零星硬编码 aria-label（'标记为完成'，TodoMainPanel L192/L374）。

### I10 🟡 学习中心标签页不持久化，重启丢失工作现场 ✅
- `LearningHubPage.tsx` L113：tabs/activeTabId 是纯 useState，应用重启后所有打开的资料标签全部丢失，用户需逐个重新找回。
- 对照：单个资源的阅读进度、书签都有持久化（I8），但"我正打开着哪些资料"这一层没有——现场恢复链条断在最上层。
- 另：MAX_TABS=20 时 LRU 静默淘汰最旧非固定 tab（L137-145），无任何提示，用户会发现"刚才开着的文件不见了"。
- openTab 按 resourceId 去重激活已有 tab 的设计 ✓ 正确。

### I11 🟢 任务-番茄联动的可见性断层 ✅
- 链路本身是通的：TodoMainPanel L277 可从任务启动番茄钟，后端 `pomodoro_repo` L55-61 完成时自动递增 `todo_items.completed_pomodoros` ✓。
- 但：① 番茄完成后 todo store 不会收到通知/刷新，详情抽屉里"番茄 x/y"计数停留旧值直到用户手动切换视图；② `pomodoro_list_by_todo` 后端命令与 `listPomodorosByTodo` 前端 API **零调用方**——用户无处查看某任务的番茄历史（死代码 + 功能缺口，I1 同族）。

### I12 🟡 资源注入聊天被截断时，只告知模型、不告知用户 ✅
- `vfs_resolver.rs`：PDF/教材多模态注入有完善的预算控制（MULTIMODAL_BUDGET_MAX_PAGES/MAX_BYTES，L949-1080/L1832-1942），作文会话有 20000 字符/10 轮上限（L1262-1385）——超限时在 prompt 里插 `<system_note>已截断为前 N 页</system_note>` ✓。
- 但截断事实**不向 UI 发任何事件**：用户引用了一本 300 页教材，以为整本都在上下文里，实际只注入了前 N 页；模型基于残缺内容回答时用户无从校准预期（"为什么 AI 说没看到第 200 页的内容？"）。
- 建议：注入结果带 truncated 标记回传前端，在引用 chip 上显示"已截断（前 N 页）"角标。

### I5 🟢 各子应用"空状态/首次使用"引导不一致 ✅
- exam 空会话自动切 upload 模式 ✓（ExamContentView L719）；note/翻译/作文创建即开 ✓；但 indexStatus 页对"嵌入模型未配置"仅在批量索引失败后给错误提示（错误信息已含可操作指引 ✓），缺事前引导；recent/收藏空态无 CTA。轻微但影响首次体验一致性。

### 生命周期总览（引用既有编号）
| 阶段 | 体验断点 | 相关问题 |
|---|---|---|
| 导入/入库 | 大文件先全量进内存再说"太大"；重启后预处理停摆无感知 | B6, G1, A5 |
| 整理/移动 | 批量移动 API 契约断裂（无调用方掩盖）；最近列表名称/路径陈旧 | B1/F1, B5, A8 |
| 检索/找回 | 文件夹内搜索静默变全局；回收站/最近搜索只过滤当前页；恢复的资源永久退出语义检索 | F1, B3, F3/A6 |
| 阅读/编辑 | 笔记自动保存链路质量高 ✓；大 PDF/媒体预览内存风险 | B6, D7 |
| 做题/复习 | 打开题集全量拉题；复习功能无入口；删题幽灵复习；UTC 日期错位 | C8, I1, C4, C5 |
| 时间管理 | 番茄钟不抗休眠且通知出不了窗口；todo 无提醒、重复任务假字段 | C2, I2, I3, C1 |
| 删除/回收 | 清空回收站可中断在一半；恢复后索引/检索降级 | F4, F3 |
| AI 协同 | 注入陈旧题目快照；引用注错会话；已删资源静默注入 | D1/D12, D4, D2 |
| 中断/重启恢复 | 媒体处理 pending 无人认领；番茄钟/复习会话蒸发；幂等键卡死 24h | G1, C2/I4, H1 |

## E. 待审清单（覆盖追踪）

- [x] vfs/indexing.rs + 索引状态机（claim_pending IMMEDIATE 事务 ✓ / recover_stuck ✓ / delete_resource_index 完整但回收站未用→F3）
- [x] vfs/lance_store.rs 调用面 + embedding_dim_repo（record_count 刷新机制 ✓）
- [ ] vfs/pdf_processing_service.rs（Pipeline 状态机）——待深审
- [x] vfs/ref_handlers.rs（D7-D11）
- [x] vfs repos：note/exam/question/review_plan/folder/blob/file/resource（A 系列 + C 系列）
- [x] dstu/handlers.rs + trash_handlers（F 系列）
- [x] learning-hub：finderStore / recentStore / dragDropRouting / useVfsContextInject / useReferenceToChat / FileContentView / sanitizeRenderedDom / filePreviewResolver（B 系列）；LearningHubSidebar(2803行)/ExamContentView(1219行) 等大文件仅抽样
- [x] practice 后端：question_repo + review_plan_repo + question_bank_service + qbank_executor（C4-C7、D12-D13）
- [x] todo/pomodoro：todo_repo + usePomodoroStore + V20260309/V20260311 迁移（C1-C3）
- [x] chat_v2：vfs_resolver / pipeline/history / workspace injector（已读，逻辑简单无新问题）；coordinator 含未提交云同步改动按约定跳过
- [x] 迁移文件全量过目（vfs 34 个 + chat_v2 17 个清单扫描；重点读 V20260207/V20260302/V20260309/V20260311；确认 A1 触发器无后续修复迁移）
- [x] pdf_processing_service 状态机（G1-G3）
- [x] useQuestionBankSession / qbank 前端层（C8）
- [x] send_message 上下文快照（D14，抽查通过）
- [x] LearningHubSidebar 重点段精读（导入进度监听泄漏；整体质量好）
- [x] FileContentView / 预览链路（B6）
- [x] mindmap/essay/translation repos（H2/H3）
- [x] memory 系统 service/idempotency/audit（H1）
- [x] path_cache_repo（H3）
