# qbank 等价场景包 v0（WP-052：题目增删查改 / 作答 / 判分 / 掌握度副作用；WP-156：检索与统计）

格式遵循 `WAVE0-EQUIVALENCE.md` §3 v0：`domain / commands / scenarios[{id, seed:"empty", steps, capture, normalize:[]}]`。

- 跨步引用只用整串 `${n.path}`（n < 当前步序号），不嵌入字符串。
- `capture` 统一 `{events:true, db:["*"]}`（含 WP-156 中少数只有一步只读调用的空库 / 错误场景）。
- `expect:"error"` 只是注释，标注"预期 A 在此步返回 Err"。期望结果一律以 A（Rust）回放为准，本包不预写返回值。
- `normalize` 全部为 `[]`；候选规则见下文"normalize 候选"，未生效。

## 文件

| 文件 | 命令数 | 场景数 | 可运行 |
|---|---|---|---|
| `questions-crud.json` | 12 | 71 | 是 |
| `answer-mastery.json` | 4 | 63 | 是 |
| `ai-grading.json` | 2 | 24 | 是（无外网，见下文） |
| `pending-provider/ai-grading-scripted.json` | 1 | 10 | 否，等待 runner 支持脚本化 LLM |
| `pending-provider/ai-grading-scripted.provider.json` | — | — | 上一文件的 SSE 应答脚本（外部输入，非期望输出） |
| `search-fts.json`（WP-156） | 2 | 29 | 是 |
| `stats-time.json`（WP-156） | 5 | 58 | 是（依赖本地日期，见 WP-156 节） |

WP-052：可运行场景共 158 个（成功 101、错误 57），pending 10 个（成功 7、错误 3），合计 168，覆盖 18 个命令。WP-156 的数字见下文"WP-156"节。

## 外部（非本 lane）setup 命令

这些命令出现在 `steps` 中，但不列入 `commands`，归属由对应 lane 负责：

| 命令 | 归属 | 用途 |
|---|---|---|
| `dstu_create` | L13-vfs-api（`src-tauri/crates/dstu-vfs/src/dstu/handlers.rs:727`，exam 分支 :1097） | 建题目集。`questions.exam_id` 对 `exam_sheets` 有外键且 `foreign_keys=ON`，seed=empty 下必须先建 exam。参数取自前端 `src/dstu/factory.ts:161` → `src/dstu/api.ts:336`：`{path:'/', options:{type:'exam', name, metadata:{status:'empty',pageCount:0,questionCount:0}}}`；返回 DstuNode 的 `.id` 即 exam_id |
| `save_api_configurations` | L02-llm-manager（`src-tauri/src/commands.rs:2150`） | AI 评判的模型配置（ApiConfig，camelCase） |
| `save_model_assignments` | L02-llm-manager（`src-tauri/src/commands.rs:2183`） | 模型分配（`qbank_ai_grading_model_config_id` / `model2_config_id`，snake_case） |

## 命令表

Rust 列：入口 → service → repo。所有命令的入口都有 `QuestionBankService not initialized` 分支（服务未初始化），正常启动时不可达，不单独建场景。下文"反序列化 Err"指 Tauri 参数反序列化失败（缺必填键或类型/枚举不符）。

| 命令 | 前端调用点 | Rust | 可达 Err / 提前返回分支 |
|---|---|---|---|
| `qbank_create_question` | `src/components/QuestionInlineEditor.tsx:668`；`src/quick-assistant/service.ts:256` | `src-tauri/src/commands.rs:7705` → `question_bank_service.rs:183` → `question_repo.rs:2203` | 反序列化 Err（缺 `params`/`content`、非法 `question_type`/`difficulty`）；`exam_id` 外键失败（database Err）；`parent_id` 指向不存在题目（是否触发外键以 A 为准）；refresh_stats 失败只记 warn、不返回 Err |
| `qbank_batch_create_questions` | `src/essay-grading/essayMistakes.ts:63` | `commands.rs:7719` → `question_bank_service.rs:201` → `question_repo.rs:2293` | 空列表直接 `Ok([])`；任一条外键失败 → `BEGIN IMMEDIATE` 整批回滚并返回 Err |
| `qbank_get_question` | `src/hooks/useQuestionBankSession.ts:489`；`src/features/learning-hub/mistakeBook/useMistakeRedoSession.ts:99,187`；`src/features/learning-today/dueMistakesReview.ts:60` | `commands.rs:7676` → `question_bank_service.rs:167` → `question_repo.rs:2071` | 不存在 / 已软删 → `Ok(null)`；反序列化 Err（缺 `questionId`） |
| `qbank_list_questions` | `src/hooks/useQuestionBankSession.ts:285,303,445`；`src/features/notes/components/NoteRelationTargetPicker.tsx:37` | `commands.rs:7573`（`page.max(1)`、`page_size.clamp(1,100)`）→ `question_bank_service.rs:115` → `question_repo.rs:1216` | `filters` 缺省 / null → 默认；反序列化 Err（缺 `exam_id`、负数 page、非法 status） |
| `qbank_update_question` | `src/stores/questionBankStore.ts:1553`；`src/features/learning-hub/apps/views/ExamContentView.tsx:1919` | `commands.rs:7741` → `question_bank_service.rs:230/239` → `question_repo.rs:2344` | 题目不存在 / 已软删 → NotFound（`question_repo.rs:2503/2519`）；`expected_updated_at` 不匹配 → `QBANK_CONFLICT: expected_updated_at=…`（:2499），空串视为未提供；`record_history=false` 不写历史；`status` 有值才刷新统计；反序列化 Err（缺 `params`） |
| `qbank_batch_update_questions` | `src/stores/questionBankStore.ts:1620,1683,1758` | `commands.rs:7765` → `question_bank_service.rs:282` | 空 `question_ids` → 直接 Ok（零计数）；单题不存在 / 重复 / OCC 冲突只回滚该题 SAVEPOINT 并记入 `errors`，不返回 Err；反序列化 Err（缺 `params`） |
| `qbank_delete_question` | `src/stores/questionBankStore.ts:1574`；`ExamContentView.tsx:1944` | `commands.rs:7779` → `question_bank_service.rs:355` → `question_repo.rs:2622` | 不存在 → Err；重复删除（`deleted_at IS NOT NULL`，affected=0）→ NotFound（:2631） |
| `qbank_batch_delete_questions` | `ExamContentView.tsx:1843`；`src/components/ExamSheetUploader.tsx:818` | `commands.rs:7790` → `question_bank_service.rs:378` | 空列表 → 直接 Ok；不存在 / 重复 / 已删 → 记入 `errors`（`{id}: not found`，:411），不返回 Err；反序列化 Err（缺 `questionIds`） |
| `qbank_submit_answer` | `src/hooks/useQuestionBankSession.ts:542`；`src/stores/questionBankStore.ts:1797`；`src/features/learning-hub/mistakeBook/useMistakeRedoSession.ts:156` | `commands.rs:7818` → `question_bank_service.rs:501`（submit）/ `:751`（regrade）；判分 `:1058 check_answer_correctness` | `regrade_submission_id` 非空且有 `is_correct_override` → 走 regrade：题目不存在（:767）、`该题还没有作答记录，无法改判`（:775）、`要改判的作答已不是最近一次提交，请刷新后重试`（:778）、提交属于别的题目；只有 regrade id 没有 override / regrade id 为空串 → 按普通提交；`client_request_id` 重复 → 短路返回原结果（空串不做幂等）；题目不存在 / 已删 → `Question not found: {id}`（:526/:541）；无参考答案或主观题 → 待人工批改（pending）；反序列化 Err（缺 `user_answer`、override 类型错误） |
| `qbank_toggle_favorite` | `useQuestionBankSession.ts:615`；`ExamContentView.tsx:1868`；`useMistakeRedoSession.ts:206` | `commands.rs:7855` → `question_bank_service.rs:1562` | 不存在 / 已删 → `Question not found: {id}`（:1565） |
| `qbank_get_stats` | `useQuestionBankSession.ts:357`；`src/stores/questionBankStore.ts:1860` | `commands.rs:7869` → `question_bank_service.rs:1594` → `question_repo.rs:2878` | 未知 exam → `Ok(null)`；反序列化 Err（缺 `examId`） |
| `qbank_refresh_stats` | `src/stores/questionBankStore.ts:1872`；`useQuestionBankSession.ts:490,640` | `commands.rs:7897` → `question_bank_service.rs:1609` → `question_repo.rs:2918` | 未知 exam → 写统计行时外键失败（以 A 为准） |
| `qbank_get_history` | `src/components/QuestionHistoryView.tsx:202`；`src/components/practice/QuestionExplanation.tsx:48` | `commands.rs:7911` → `question_bank_service.rs:1619` → `question_repo.rs:2814`（`limit.unwrap_or(100)`，:2819） | 不存在题目 → 空数组；`limit` 为 0 / u32::MAX 的边界；负数 limit → 反序列化 Err |
| `qbank_reset_progress` | `src/stores/questionBankStore.ts:1882` | `commands.rs:7941` → `question_bank_service.rs:1725` | 未知 exam（统计刷新外键，以 A 为准）；跳过已软删题 |
| `qbank_reset_questions_progress` | `ExamContentView.tsx:1818` | `commands.rs:7955` → `question_bank_service.rs:1793` | 空列表 → 直接 Ok；不存在 / 已删 → 记入 `errors`（`{id}: not found`，:1832/:1858），不返回 Err；反序列化 Err（缺 `questionIds`） |
| `qbank_list_mistakes` | `src/features/learning-hub/mistakeBook/mistakeBookApi.ts:102` | `commands.rs:7601` → `question_bank_service.rs:127` → `question_repo.rs:1416`（`page_size.clamp(1,200)`，:1423） | `filters` / `page` / `page_size` 缺省走默认值；反序列化 Err（page 类型错误） |
| `qbank_ai_grade` | `src/hooks/useQbankAiGrading.ts:327` | `src-tauri/src/qbank_grading.rs:23` → `src-tauri/crates/dstu-qbank/src/qbank_grading/mod.rs:26` → `pipeline.rs:152 run_qbank_grading` | 题目不存在 `题目不存在: {id}`（:169）；Grade 模式无 / 空 submission → `AI 评判需要作答记录：请先提交答案`（:184）；`作答记录 {sid} 不属于题目 {qid}`（:192）；`作答记录不存在: {id}`（:200）；配置解析 `resolve_grading_config`（:710）：`未找到模型配置`（:730/:758）、`模型配置已禁用`（:732）、`嵌入模型不支持 AI 评判`（:736/:761）、`重排序模型不支持 AI 评判`（:742/:767）；Model2 回退：`对话模型未配置` / `找不到已启用的有效对话模型配置（禁止使用嵌入/重排序模型）`（`dstu-llm/src/llm_manager/mod.rs:6945/6951`）；发送前已取消 → `Ok(null)` + cancelled 事件（`pipeline.rs:1166` → :309）；`评判请求失败: {e}`（:1205）；HTTP 非 2xx（:1208）；正文为空 `AI 未返回批改正文…`（:323）；第二次取消检查（:336）；反序列化 Err（缺 / 非法 `mode`） |
| `qbank_cancel_grading` | `src/hooks/useQbankAiGrading.ts:159,381,402,423` | `src-tauri/src/qbank_grading.rs:34` → `qbank_grading/mod.rs:67` | 总是 `Ok(())`（未知流 / 空名 / 重复取消都只写 cancel_registry）；反序列化 Err（缺 `streamEventName`） |

## 覆盖表（按场景 id 前缀归属命令）

一个场景只计一次。"成功"指场景内没有 `expect:"error"` 步骤。其他命令作为前置或断言步骤的使用不计入此表。

| 命令 | 成功 | 错误 | pending 成功 | pending 错误 |
|---|---|---|---|---|
| `qbank_create_question` | 6 | 6 | 0 | 0 |
| `qbank_batch_create_questions` | 3 | 1 | 0 | 0 |
| `qbank_get_question` | 2 | 1 | 0 | 0 |
| `qbank_list_questions` | 7 | 3 | 0 | 0 |
| `qbank_update_question` | 9 | 6 | 0 | 0 |
| `qbank_batch_update_questions` | 5 | 1 | 0 | 0 |
| `qbank_delete_question` | 1 | 2 | 0 | 0 |
| `qbank_batch_delete_questions` | 3 | 1 | 0 | 0 |
| `qbank_toggle_favorite` | 1 | 2 | 0 | 0 |
| `qbank_get_stats` | 2 | 1 | 0 | 0 |
| `qbank_refresh_stats` | 2 | 1 | 0 | 0 |
| `qbank_get_history` | 4 | 1 | 0 | 0 |
| `qbank_submit_answer`（含 `mastery.*`、`review.*`） | 42 | 8 | 0 | 0 |
| `qbank_reset_progress` | 3 | 1 | 0 | 0 |
| `qbank_reset_questions_progress` | 4 | 1 | 0 | 0 |
| `qbank_list_mistakes` | 3 | 1 | 0 | 0 |
| `qbank_ai_grade` | 2 | 19 | 7 | 3 |
| `qbank_cancel_grading` | 2 | 1 | 0 | 0 |
| 合计 | 101 | 57 | 7 | 3 |

批量命令把单项失败折叠进 `BatchResult.errors`、不返回 Err，所以这些单项失败场景计为"成功"（例如 `batch_update.partial_missing_and_duplicate`、`batch_delete.missing_duplicate_and_deleted`、`reset_questions.missing_and_deleted`）。

### 场景要点

- **作答判分**：覆盖每种题型的判对 / 判错：单选（全角 / 大小写、按选项 key 回退）、多选（顺序无关）、不定项（structured 参考）、判断（多种写法；参考答案非法时转人工）、数值（绝对 / 相对容差、多种格式、回退字符串答案）、排序、连线、主观题（转人工 pending）、other。
- **重复提交**：同一 `client_request_id` 短路（包括 pending 的回放）；空串不做幂等；不带 id 时计两次；幂等键按题隔离。
- **改判与归属**：改判只针对最近一次提交（`err_regrade_not_latest`）；提交与题目绑定（`err_regrade_other_question_submission`、`ai_grade.err_submission_of_other_question`）；已删题不可作答 / 收藏 / 更新。qbank 本身没有用户或权限维度，归属边界只到这一层。
- **掌握度副作用**：概念键取第一个非空 tag，否则 `item:<question_id>`（`mastery.*`）；答错后在提交后创建 SM-2 复习计划，到期后答对推进计划（`review.wrong_then_correct_due_plan`）；再次答错复用同一计划（`review.wrong_twice_reuses_plan`）。复习计划写在 DB 中，由 `db:["*"]` 捕获。

## AI 评判的确定性处理

- **不访问外网**：`ai-grading.json` 中需要实际发请求的配置，`baseUrl` 统一设为 `http://127.0.0.1:9/v1`（本机 discard 端口，连接会被拒绝），以确定性方式走到 `评判请求失败`。apiKey 是占位字符串，不是真实密钥。
- **预取消**：先调用 `qbank_cancel_grading({streamEventName:"qbank_grading_stream_<sid>"})` 写入 cancel_registry，再调用 `qbank_ai_grade`。`stream_grade` 在发送 HTTP 之前消费取消标记（`pipeline.rs:1166`），返回 `Ok(null)` 并发出 cancelled 事件，全程不发网络请求。
- **判分成功路径**（verdict / score 解析、写回 ai_feedback、Analyze 写解析、AI 判对后人工改判等）需要一个可编程的本地 LLM，放在 `pending-provider/`，不进入可运行集：
  - 场景中的 `baseUrl` 是占位串 `"${provider.url}"`。它不是 v0 跨步引用，需要 runner 替换成 X7 `record/provider.mjs` 起的本地地址。
  - `ai-grading-scripted.provider.json` 按场景 id 和请求顺序给出 status / headers / SSE chunks，属于外部输入。请求体由 A 记录后与 B 比较，不预写。

## normalize 候选（未生效，`normalize` 仍为 `[]`）

以下字段 A/B 天然不同，等首次 A/B 回放后再由 runner 方确认规则：

- 主键：`q_*`（题目）、`exam_*`（题目集）、submission / history / review plan id（nanoid）、`temp_*` uuid。
- 时间戳：`created_at`、`updated_at`、`last_attempt_at`、`ai_graded_at`、`deleted_at`、复习计划的 due 时间。
- 连接失败错误文本：`评判请求失败: {e}` 中的 `{e}` 是 reqwest 的错误描述，Node 实现的文本必然不同。建议只比较前缀 `评判请求失败: `。
- OCC 冲突消息中嵌入的时间戳：`QBANK_CONFLICT: expected_updated_at=…, actual_updated_at=…`。

## 未覆盖与剩余命令

本包不覆盖：

- `qbank_get_submissions`、`qbank_get_question_by_card_id`：没有前端调用点，contract 中仍存在。
- 检索 / FTS 重建 / 按题型计数 / 趋势 / 热力图 / 知识点对比 / 打卡日历：已由 WP-156 覆盖（见下文）；`qbank_get_knowledge_stats` 无前端调用，WP-156 显式排除。
- 图片作答 / 配图题的多模态分支（`reject_non_multimodal`，`pipeline.rs:715`）：需要文件 / blob seed。

L14-qbank 共 88 个命令（`contracts/ipc/L14-qbank.json`），WP-052 覆盖 18 个，下表为 WP-052 时剩余的 70 个；其中 `qbank_search_questions` `qbank_rebuild_fts_index` `qbank_count_by_type` `qbank_get_learning_trend` `qbank_get_activity_heatmap` `qbank_get_knowledge_stats_with_comparison` `qbank_get_check_in_calendar` 已由 WP-156 覆盖，现剩 63 个：

`cancel_question_bank_import` `cancel_questions_csv_import` `export_questions_csv` `get_csv_exportable_fields` `get_csv_preview` `get_enhanced_statistics` `get_exam_sheet_session_detail` `get_learning_heatmap` `import_question_bank` `import_question_bank_stream` `import_questions_csv` `inspect_pdf_text_for_qbank` `list_exam_sheet_sessions` `list_importing_sessions` `qbank_ai_generate_questions` `qbank_cancel_generation_task` `qbank_commit_authoring_draft` `qbank_complete_paper_export` `qbank_count_by_type` `qbank_create_practice` `qbank_crop_source_image` `qbank_delete_group` `qbank_delete_material` `qbank_delete_practice` `qbank_export_document` `qbank_export_paper_docx` `qbank_export_portable` `qbank_generate_mock_exam` `qbank_generate_paper` `qbank_get_activity_heatmap` `qbank_get_authoring_draft` `qbank_get_check_in_calendar` `qbank_get_daily_practice` `qbank_get_generation_task` `qbank_get_knowledge_stats` `qbank_get_knowledge_stats_with_comparison` `qbank_get_learning_trend` `qbank_get_paper` `qbank_get_practice` `qbank_get_question_by_card_id` `qbank_get_source_images` `qbank_get_source_page` `qbank_get_submissions` `qbank_grade_practice_manually` `qbank_legacy_audit` `qbank_legacy_migrate_selected` `qbank_list_authoring_drafts` `qbank_list_generation_tasks` `qbank_list_papers` `qbank_list_practices` `qbank_list_structure` `qbank_rebuild_fts_index` `qbank_remove_question_image` `qbank_reparse_report` `qbank_reparse_resolve` `qbank_resolve_authoring_route` `qbank_resume_practice_grading` `qbank_retry_practice_grading` `qbank_review_authoring_draft` `qbank_save_practice` `qbank_search_questions` `qbank_start_timed_practice` `qbank_submit_mock_exam` `qbank_submit_practice` `qbank_update_group` `qbank_update_material` `qbank_update_paper` `rename_exam_sheet_session` `resume_question_import` `update_exam_sheet_cards`

## 阻塞项

| 阻塞 | 影响 | 归属 |
|---|---|---|
| qbank 尚无 A/B runner（X1 `scenario-v0.ts` 与 b-driver 未合入 main） | 本包只做了 JSON / contract 静态校验，没有回放 | X1 / X5 |
| 脚本化 LLM 未接入场景（X7 `record/provider.mjs` 已存在，但不能按场景加载 `.provider.json`，也不替换 `${provider.url}`） | `pending-provider/` 中的 10 个场景无法运行 | X5 / X7 |
| exam 只能通过 `dstu_create` 建立 | 每个场景依赖 L13 的 exam 创建在 B 侧可用 | L13-vfs-api |
| AI 评判配置依赖 `save_api_configurations` / `save_model_assignments` | ai-grading 场景依赖 L02 在 B 侧可用 | L02-llm-manager |
| 图片作答需要文件 / blob seed | 多模态分支未覆盖 | X3 / L11 |

## WP-156：检索与统计

### 文件与数字

| 文件 | commands | 场景（成功 / 错误） | 步数 |
|---|---|---|---|
| `search-fts.json` | `qbank_search_questions` `qbank_rebuild_fts_index` | 29（22 / 7） | 274 |
| `stats-time.json` | `qbank_count_by_type` `qbank_get_knowledge_stats_with_comparison` `qbank_get_learning_trend` `qbank_get_activity_heatmap` `qbank_get_check_in_calendar` | 58（28 / 30） | 268 |

合计 87 个场景、542 步，7 个目标命令，全部可运行（无 pending 文件）。目标命令步数（成功步 / `expect:"error"` 步）：search 63/7，rebuild 4/0，count_by_type 9/3，knowledge_comparison 10/2，trend 16/7，heatmap 19/8，calendar 24/10。统计类成功场景都先作答 seed 出非空数据，空库 / 未知 exam 只作为单独的默认值场景。

### 排除

- `qbank_get_knowledge_stats`：前端没有 invoke，wave0 inventory 也没有列出。唯一调用方是 Rust chat 工具 `src-tauri/src/chat_v2/tools/qbank_executor.rs:4005/5497`，它直接调用 service，不经过 IPC。`src/features/chat/skills/builtin-tools/qbank-tools.ts:972` 的 `builtin-qbank_get_knowledge_stats` 只是工具 schema。前端用的是 `_with_comparison` 版本，其 `current` 与本命令出自同一 service 函数（`question_bank_service.rs:2157`），由 `qbank.knowledge_stats.*` 覆盖。
- `qbank_search_questions` / `qbank_rebuild_fts_index` 保留：`src/stores/questionBankStore.ts:1497/1520` 有真实 invoke，inventory 也列为 caller；但目前没有 UI 组件调用这两个 store action。

### 跨域 seed 命令（不在 `commands` 中）

| 命令 | 归属 | 用途 |
|---|---|---|
| `dstu_create` | L13-vfs-api（同上文） | 建 exam |
| `qbank_create_question` `qbank_submit_answer` `qbank_update_question` `qbank_delete_question` `qbank_toggle_favorite` | L14-qbank（WP-052 已覆盖） | 造题、作答（驱动 status / 提交记录）、改内容（FTS 触发器）、软删、收藏 |
| `pomodoro_create_record` | L13-vfs-api（`src-tauri/crates/dstu-vfs/src/vfs/todo_handlers.rs:1176`，前端 `src/features/pomodoro/api.ts:53`） | 打卡日历的专注时长。`focus_seconds_by_local_date`（`pomodoro_repo.rs:463`）按 `created_at`（插入时的当前时间）过滤，入参 `startTime` 写死不影响落在哪天；只统计 `type='work'` 且 `completed/interrupted` |

### 命令来源表

Rust 列：`src-tauri/src/commands.rs` 入口 → `src-tauri/crates/dstu-qbank/src/question_bank_service.rs` → `src-tauri/crates/dstu-vfs/src/vfs/repos/question_repo.rs`。场景 id 省略前缀 `qbank.`。

| 命令 | 前端调用点 | Rust | 可达分支 → 场景 |
|---|---|---|---|
| `qbank_search_questions` | `src/stores/questionBankStore.ts:1497`（`request:{keyword, exam_id, filters: filters\|\|{}, page, page_size: 50}`）；host `host/plugins/qbank/index.ts:516` | `commands.rs:7642`（请求 7618，`default_page`=1 / `default_page_size`=50 在 7565）→ service :148 → repo :655/668 | 前端形状 / 全局 / 省略字段默认 → `search.keyword_in_exam_frontend_shape` `global_across_exams` `defaults_omitted_fields_and_null_filters`；`escape_fts5_query`（:605）大小写、多列、多词隐式 AND、特殊字符、CJK unicode61 → `case_insensitive_multi_column` `multi_token_implicit_and` `special_chars_escaped` `cjk_unicode61_tokens`；`sanitize_search_keyword`（:618）空白关键词在 :683 提前返回且 page/page_size 不 clamp → `blank_keyword_early_return_unclamped`；200 字截断 → `long_keyword_truncated_200_chars`；`page.max(1)` / `page_size.clamp(1,100)`（:712-713）与 `has_more`（:947）→ `page_clamp_bounds`；`QuestionSearchFilters`（:461，flatten `QuestionFilters` :364）→ `filter_status_difficulty` `filter_type_tags_empty_arrays` `filter_favorite_bookmark`；前端 `base` 包装键 / `search` 字段被静默忽略 → `frontend_base_wrapper_and_search_field_ignored`；`SearchSortBy`（:472）+ `order_clause`（:812）→ `sort_by_variants`；软删排除 → `soft_deleted_excluded`；FTS 触发器随更新 → `update_reindexes_content`；未知 / 空 exam、空库 → `unknown_and_empty_exam_scope` `empty_db_no_rows`；反序列化 Err → `search.err_missing_keyword` `err_invalid_status_enum` `err_invalid_sort_by` `err_negative_page` `err_keyword_not_string` `err_filters_wrong_type` `err_missing_request` |
| `qbank_rebuild_fts_index` | `src/stores/questionBankStore.ts:1520`（`{}`）；host `index.ts:519` | `commands.rs:7665` → service :161 → repo :1139/1148（SAVEPOINT `qbank_rebuild_fts`） | 空库 → `rebuild_fts.empty_db`；排除软删、重复重建幂等，重建后检索 → `rebuild_fts.excludes_soft_deleted_idempotent`；更新 / 删除后重建 → `rebuild_fts.after_update_and_delete` |
| `qbank_count_by_type` | `src/components/practice/PaperGenerator.tsx:166`（`{examId}`）；host `index.ts:551` | `commands.rs:7883` → service :1600 → repo :2854（HashMap，排除软删；Rust 测试 :4041） | 多题型、排除软删与其他 exam → `count_by_type.mixed_types_excludes_deleted_and_other_exam`；默认题型 `other`（repo :2216）→ `default_type_other`；改题型 → `type_change_moves_count`；空 / 未知 / 空串 exam → `empty_unknown_and_blank_exam`；反序列化 Err → `err_missing_examId` `err_snake_case_key` `err_examId_number` |
| `qbank_get_knowledge_stats_with_comparison` | `src/stores/questionBankStore.ts:1983`（`request:{exam_id}`）；UI `KnowledgeRadar.tsx:458`；host `index.ts:624` | `commands.rs:8056`（请求 8033）→ service :2249 → :2157（`json_each(tags)`，`LIMIT 10` 在 :2190）；`previous` 恒为空（:2258） | status 分桶（repo :2548 CASE）与 mastery / correct 取整 → `knowledge_stats.status_buckets_and_rates`；Top10 截断 → `top10_limit_distinct_totals`；同 total 并列 → `equal_total_tie_order`；软删 / 无标签 / 重复标签 → `excludes_deleted_untagged_dup_tag`；手动 status、主观题待评 → `manual_status_and_pending_subjective`；空库 / 未知 exam → `empty_db_and_unknown_exam`；反序列化 Err → `err_missing_request` `err_exam_id_number` |
| `qbank_get_learning_trend` | `src/stores/questionBankStore.ts:1940`（`request:{exam_id, start_date, end_date}`）；UI `LearningTrendChart.tsx:534`；host `index.ts:621` | `commands.rs:7990`（请求 7977）→ service :1925（`DATE(submitted_at,'localtime')`，`fill_missing_dates` :2018） | 按 exam 统计次数与正确率 → `trend.attempts_correct_rate_by_exam`；主观题待评只计次数 → `subjective_pending_attempt_only`；过去窗口补零、闰日 → `past_window_zero_filled_leap_day`；恰好 3700 天 → `max_range_3700_days`；软删排除 → `deleted_question_excluded`；不补零的日期串 → `unpadded_date_strings`；空库 / 未知 exam 补零 → `empty_db_and_unknown_exam_zero_filled`；:1933/1935 格式 Err → `err_start_format` `err_end_invalid_day` `err_start_empty`；:1937 → `err_start_after_end`；:1940（>3700 天）→ `err_range_3701_days`；反序列化 Err → `err_missing_end_date` `err_missing_request` |
| `qbank_get_activity_heatmap` | `src/stores/questionBankStore.ts:1963`、`src/features/learning-today/weeklyReport.ts:82`（`request:{exam_id:null, year}`）；UI `QuestionBankStatsView.tsx:248`、`LearningHeatmapChart.tsx:246`；host `index.ts:629` | `commands.rs:8019`（请求 8008）→ service :2062（`level` 在 :2135） | level 阈值 0 / 1-3 / 4-6 / 7-10 / >10 按去重题数 → `heatmap.level_thresholds_distinct_questions`；重复提交只算一次、取 MAX correct → `repeat_submissions_count_once_max_correct`；exam 过滤 / 全局 / 软删 → `exam_filter_global_and_deleted`；1970 / 9999 边界无数据 → `valid_year_bounds_without_data`；空库 → `empty_db`；:2068 `年份无效` → `err_year_1969` `err_year_10000` `err_year_zero` `err_year_negative`；反序列化 Err → `err_year_i32_overflow` `err_missing_year` `err_year_string` `err_missing_request` |
| `qbank_get_check_in_calendar` | `src/stores/questionBankStore.ts:2381`（`request:{exam_id, year, month, daily_target}`）；UI `DailyPracticeMode.tsx:144`；host `index.ts:632` | `commands.rs:8194`（请求 8183，`daily_target` 为 `serde(default)`）→ service :2969 | `daily_target` 缺省 10 / `.max(1)`（:2982）与 `target_achieved`（:3086）→ `calendar.daily_target_threshold`；全局 streak 取到今天为止的历史（`query_streak_days` :3111、`compute_streak_days` :3171）、查询其他月份 → `global_streak_from_history_other_months`；番茄专注秒数 → `pomodoro_focus_seconds`；exam 范围 / 软删 / 未知 exam → `exam_scope_deleted_unknown`；空库默认值 → `empty_db_defaults`；月 / 年边界、跨年 → `month_year_bounds_rollover`；:2977 `月份必须在 1-12 之间` → `err_month_zero` `err_month_13`；:2980 `年份无效` → `err_year_1969` `err_year_10000`；反序列化 Err → `err_month_negative` `err_missing_month` `err_missing_year` `err_daily_target_negative` `err_daily_target_string` `err_missing_request` |

### 日期与时区假设

- 趋势 / 热力图 / 日历都按本地日期统计（SQL `'localtime'`、`chrono::Local`），作答时间只能是"现在"。场景假设 A 与 B 在同一本地日期、同一时区回放，且日期在 2026-11 或 2026-12。
- 为吸收月末 / 年末翻转，含当日数据的步骤同时查询 11 月、12 月和宽窗口 2026-01-01..2027-12-31；不在当前月的那一步结果为空，这是预期。
- 日期窗口与边界全部取 Rust 的规则：3700 天上限（2016-01-01..2026-02-17 恰好 3700 天）、年份 1970..=9999、月份 1..=12。

### normalize 候选（未生效，`normalize` 仍为 `[]`）

- `search_time_ms`（检索耗时）。
- 主键与时间戳：同 WP-052（题目 / exam / submission / 番茄记录 id，`created_at` / `updated_at` / `last_attempt_at`）。
- `qbank_count_by_type` 返回 HashMap，键序不确定；如 runner 按对象逐键比较需按键排序。
- 并列顺序：知识点统计 `ORDER BY total DESC` 同值时顺序未定义（`equal_total_tie_order` 专门暴露这一点）；检索 `created_*` / `updated_*` 排序在同一时间戳内的次序同理。

排序与错误前缀均未预先批准，等首次 A/B 回放后由 runner 方确认。

### pending（未覆盖分支）

| 分支 | 位置 | 原因 |
|---|---|---|
| 无 submissions 时热力图回退到 `last_attempt_at` | service :2062 起 | 需要历史数据；`qbank_reset_progress` 会同时清掉两者，seed=empty 下造不出"有 last_attempt_at 无提交" |
| FTS 表缺失时 warn + LIKE 回退 | repo :696/966 | 正常迁移后的 DB 一定有 FTS 表，属 DB 故障 |
| 重建 FTS 失败回滚（`FTS5 rebuild failed, rolled back`） | repo :1191 | DB 故障 |
| 番茄专注查询失败只 warn 继续（`[QuestionBankService] pomodoro focus lookup failed`） | service :3054 | DB 故障 |
| 行解码失败跳过（`log_and_skip_err`） | repo 检索 / 统计 | 需要损坏数据 |
| `QuestionBankService not initialized` | 所有入口 | 正常启动不可达 |
| 超大 page（如 `u32::MAX`） | repo `(page-1)*page_size` / `offset+page_size` | debug 构建下整数溢出会 panic，不写入场景 |
| 跨真实过去日期的专注秒数与 streak（如"昨天打卡"） | service :3111/:3171 | 需要回填时间的 seed，无可用命令 |

### 阻塞

同上文"阻塞项"：qbank 尚无 A/B runner（X1/X5），本包只做了 JSON / contract 静态校验（作业 `20261105185218-542f42`，退出码 0）。另外 `pomodoro_create_record` 依赖 L13-vfs-api 在 B 侧可用。


## WP-228：G3 命令语料 v1（成功场景）

清单来源 `board/corpus/WP-228-L14-qbank.md`（56 条，在768=是 49 条）。本包只写成功场景；错误分支归 W-L14（`g3w-*.json`，id 前缀 `g3w.`），本包没有读改这些文件。格式与约定同上文：`seed:"empty"`、整值 `${n.path}` 引用、`capture:{events:true,db:["*"]}`、`normalize:[]`，不预写返回值，成功文件中没有 `expect:"error"` 步骤。

### 文件

| 文件 | commands | 场景 | 步数 | 可运行 |
|---|---|---|---|---|
| `g3-practice.json` | 9 | 15 | 109 | 是 |
| `g3-paper-exam.json` | 11 | 24 | 92 | 是 |
| `g3-import-export.json` | 11 | 33 | 91 | 是（CSV 写 `/tmp/l14-qbank-g3-*.csv`，见下） |
| `g3-structure.json` | 13 | 23 | 92 | 是 |
| `g3-authoring-generation.json` | 10 | 11 | 42 | 是（AI 出题后台任务指向 `http://127.0.0.1:9/v1`，最终失败属预期） |
| `pending-provider/g3-practice-llm.json` | 6 | 3 | 27 | 否：answers 键引用（不需要 LLM，文件名沿用 pending 目录约定） |
| `pending-provider/g3-paper-exam-pending.json` | 1 | 2 | 2 | 否：需 `${fixture.pendingExportRequestId}` / 事件取值 |
| `pending-provider/g3-authoring-generation-llm.json` | 3 | 2 | 11 | 否：需 `${provider.url}` 多模态脚本 LLM + `${fixture.qbank_page_png_base64}` |

可运行 106 个场景（全部为成功场景），pending 7 个。

### 逐命令覆盖表（成功 / 理由）

"成功"指至少一个可运行场景中该命令作为非 `expect` 步骤出现，且该场景无 `expect:"error"` 步骤；场景数按含该命令的场景计（一个场景可计入多个命令）。

在768=是：45/49 有可运行成功场景；在768=否：7/7

| 命令 | 在768 | Rust | 成功 | 可运行成功场景数：示例 id | 理由 / pending |
|---|---|---|---|---|---|
| `cancel_question_bank_import` | 是 | `src-tauri/src/commands.rs:1264` | 成功 | 3：`qbank.g3.import_stream.with_import_id_then_cancel` 等 |  |
| `cancel_questions_csv_import` | 是 | `src-tauri/src/commands.rs:1859` | 成功 | 3：`qbank.g3.csv_cancel.unknown_id` 等 |  |
| `export_questions_csv` | 是 | `src-tauri/src/commands.rs:1875` | 成功 | 12：`qbank.g3.csv_export.default_fields_two_questions` 等 |  |
| `get_csv_exportable_fields` | 否 | `src-tauri/src/commands.rs:2005` | 成功 | 1：`qbank.g3.exportable_fields.list` |  |
| `get_csv_preview` | 是 | `src-tauri/src/commands.rs:1967` | 成功 | 3：`qbank.g3.csv_preview.after_export_rows_limit` 等 |  |
| `get_enhanced_statistics` | 是 | `src-tauri/src/commands.rs:2109` | 成功 | 1：`qbank.g3.paper.enhanced_stats.empty_data_dir` | 只有空数据目录（全 0）的 Ok 返回；带数据的统计依赖多个别域表，未造 |
| `get_exam_sheet_session_detail` | 否 | `src-tauri/src/commands.rs:945` | 成功 | 2：`qbank.g3.structure.get_exam_sheet_session_detail.seeded_card` 等 |  |
| `get_learning_heatmap` | 是 | `src-tauri/src/commands.rs:8244` | 成功 | 4：`qbank.g3.paper.heatmap.empty_range` 等 |  |
| `import_question_bank_stream` | 是 | `src-tauri/src/commands.rs:1122` | 成功 | 10：`qbank.g3.import_stream.json_full_document` 等 |  |
| `import_questions_csv` | 是 | `src-tauri/src/commands.rs:1709` | 成功 | 5：`qbank.g3.csv_import.roundtrip_creates_new_exam` 等 |  |
| `list_exam_sheet_sessions` | 否 | `src-tauri/src/commands.rs:932` | 成功 | 1：`qbank.g3.structure.list_exam_sheet_sessions.limit_and_default` |  |
| `list_importing_sessions` | 否 | `src-tauri/src/commands.rs:1646` | 成功 | 3：`qbank.g3.importing_sessions.empty_db` 等 |  |
| `qbank_ai_generate_questions` | 是 | `src-tauri/src/qbank_generation.rs:16` | 成功 | 2：`qbank.g3.authgen.generate_submit_get_list_cancel` 等 | 另有 pending 1（`qbank.g3.authgen.pending.generate_completed_authoring_draft`） |
| `qbank_cancel_generation_task` | 是 | `src-tauri/src/qbank_generation.rs:48` | 成功 | 3：`qbank.g3.authgen.generate_submit_get_list_cancel` 等 |  |
| `qbank_commit_authoring_draft` | 是 | `src-tauri/src/commands.rs:1361` | 成功 | 3：`qbank.g3.authgen.list_get_commit_imported_json` 等 |  |
| `qbank_complete_paper_export` | 是 | `src-tauri/crates/dstu-qbank/src/qbank_practice/export_bridge.rs:66` | 未覆盖 | 0 | 无可运行成功路径：`EXPORTS` 只由聊天工具 `export_for_tool`（`export_bridge.rs:29`，调用方 `chat_v2/tools/qbank_executor.rs:4161`）写入，纯命令回放下 `requestId` 必然不存在 → `Export request expired`（:73）。pending 需 runner 从 `qbank-export-paper` 事件取 `request_id` |
| `qbank_create_practice` | 是 | `src-tauri/src/qbank_practice.rs:16` | 成功 | 14：`qbank.g3.practice.create_sequential_start_index` 等 |  |
| `qbank_crop_source_image` | 是 | `src-tauri/src/commands.rs:8609` | 未覆盖 | 0 | 需要真实源图 blob（图片导入管线 + 多模态 LLM 产生），pending 给出 1×1 PNG fixture 与 `${provider.url}` |
| `qbank_delete_group` | 是 | `src-tauri/src/commands.rs:1612` | 成功 | 3：`qbank.g3.structure.delete_group.ungroup_preserves_material` 等 |  |
| `qbank_delete_material` | 是 | `src-tauri/src/commands.rs:1453` | 成功 | 1：`qbank.g3.structure.delete_material.unreferenced_after_group_cleared` |  |
| `qbank_delete_practice` | 是 | `src-tauri/src/qbank_practice.rs:63` | 成功 | 1：`qbank.g3.practice.delete_draft_and_attempt` |  |
| `qbank_export_document` | 是 | `src-tauri/src/commands.rs:1489` | 成功 | 3：`qbank.g3.export_document.two_questions` 等 |  |
| `qbank_export_paper_docx` | 是 | `src-tauri/crates/dstu-qbank/src/qbank_practice/export.rs:228` | 成功 | 3：`qbank.g3.paper.export_docx.full_blocks` 等 |  |
| `qbank_export_portable` | 是 | `src-tauri/src/commands.rs:1633` | 成功 | 3：`qbank.g3.import_stream.zip_portable_roundtrip` 等 |  |
| `qbank_generate_mock_exam` | 是 | `src-tauri/src/commands.rs:8106` | 成功 | 2：`qbank.g3.paper.mock_exam.generate_distributions` 等 |  |
| `qbank_generate_paper` | 是 | `src-tauri/src/commands.rs:8168` | 成功 | 6：`qbank.g3.paper.generate.type_selection_persisted` 等 |  |
| `qbank_get_authoring_draft` | 否 | `src-tauri/src/commands.rs:1386` | 成功 | 3：`qbank.g3.authgen.list_get_commit_imported_json` 等 |  |
| `qbank_get_daily_practice` | 是 | `src-tauri/src/commands.rs:8147` | 成功 | 3：`qbank.g3.paper.daily.fresh_new_questions` 等 |  |
| `qbank_get_generation_task` | 是 | `src-tauri/src/qbank_generation.rs:27` | 成功 | 2：`qbank.g3.authgen.generate_submit_get_list_cancel` 等 |  |
| `qbank_get_paper` | 是 | `src-tauri/src/qbank_practice.rs:80` | 成功 | 2：`qbank.g3.paper.generate.type_selection_persisted` 等 |  |
| `qbank_get_practice` | 是 | `src-tauri/src/qbank_practice.rs:33` | 成功 | 12：`qbank.g3.practice.create_sequential_start_index` 等 | 另有 pending 3（`qbank.g3.practice.save_and_submit_answered_mixed`） |
| `qbank_get_source_images` | 是 | `src-tauri/src/commands.rs:8515` | 成功 | 2：`qbank.g3.authgen.source_images_empty_exam` 等 | 可运行的 2 个只返回 `[]`（无图题目集）；真实图片在 pending `qbank.g3.authgen.pending.source_images_and_crop_from_imported_page` |
| `qbank_get_source_page` | 否 | `src-tauri/crates/dstu-qbank/src/qbank_source_view.rs:339` | 成功 | 1：`qbank.g3.authgen.source_page_vfs_text_file` |  |
| `qbank_grade_practice_manually` | 是 | `src-tauri/src/qbank_practice.rs:112` | 未覆盖 | 0 | 前置要求结果 `status!="unanswered"`，只能先 `qbank_save_practice` 写 `answers`；`answers` 是以动态题目 id 为键的 Map，runner v0 只解析值上的 `${n.path}`，不解析键。pending 场景按 `{"${n.id}": "B"}` 写好，本身不需要 LLM |
| `qbank_legacy_audit` | 是 | `src-tauri/src/commands.rs:1542` | 成功 | 3：`qbank.g3.structure.legacy_audit.preview_card_unmatched` 等 |  |
| `qbank_legacy_migrate_selected` | 是 | `src-tauri/src/commands.rs:1555` | 成功 | 1：`qbank.g3.structure.legacy_migrate_selected.unmatched_card_to_question` |  |
| `qbank_list_authoring_drafts` | 是 | `src-tauri/src/commands.rs:1398` | 成功 | 3：`qbank.g3.authgen.list_get_commit_imported_json` 等 |  |
| `qbank_list_generation_tasks` | 是 | `src-tauri/src/qbank_generation.rs:37` | 成功 | 3：`qbank.g3.authgen.generate_submit_get_list_cancel` 等 |  |
| `qbank_list_papers` | 是 | `src-tauri/src/qbank_practice.rs:72` | 成功 | 4：`qbank.g3.paper.generate.multi_type_word_config` 等 |  |
| `qbank_list_practices` | 是 | `src-tauri/src/qbank_practice.rs:42` | 成功 | 14：`qbank.g3.practice.create_sequential_start_index` 等 | 另有 pending 2（`qbank.g3.practice.save_and_submit_answered_mixed`） |
| `qbank_list_structure` | 是 | `src-tauri/src/commands.rs:1530` | 成功 | 9：`qbank.g3.structure.list_structure.material_group_exam` 等 |  |
| `qbank_reparse_report` | 是 | `src-tauri/src/commands.rs:1576` | 成功 | 4：`qbank.g3.structure.reparse_report.pending_draft_explicit_job` 等 |  |
| `qbank_reparse_resolve` | 是 | `src-tauri/src/commands.rs:1590` | 成功 | 2：`qbank.g3.structure.reparse_resolve.keep_all_and_idempotent_replay` 等 |  |
| `qbank_resolve_authoring_route` | 是 | `src-tauri/src/commands.rs:1467` | 成功 | 2：`qbank.g3.authgen.route_text_model_no_vision` 等 |  |
| `qbank_resume_practice_grading` | 是 | `src-tauri/src/qbank_practice.rs:96` | 成功 | 2：`qbank.g3.practice.resume_grading_empty_database` 等 |  |
| `qbank_retry_practice_grading` | 是 | `src-tauri/src/qbank_practice.rs:101` | 未覆盖 | 0 | 同上（answers 键引用），另需结果 `status=="failed"`：只能由后台批改队列失败产生，runner 无"等 DB 条件"屏障 |
| `qbank_save_practice` | 是 | `src-tauri/src/qbank_practice.rs:25` | 成功 | 3：`qbank.g3.practice.save_marked_index_and_elapsed` 等 | 另有 pending 3（`qbank.g3.practice.save_and_submit_answered_mixed`） |
| `qbank_start_timed_practice` | 是 | `src-tauri/src/commands.rs:8081` | 成功 | 2：`qbank.g3.paper.timed.basic` 等 |  |
| `qbank_submit_mock_exam` | 是 | `src-tauri/src/commands.rs:8126` | 成功 | 2：`qbank.g3.paper.mock_exam.submit_unanswered_session` 等 |  |
| `qbank_submit_practice` | 是 | `src-tauri/src/qbank_practice.rs:53` | 成功 | 5：`qbank.g3.practice.submit_unanswered_all_results` 等 | 另有 pending 3（`qbank.g3.practice.save_and_submit_answered_mixed`） |
| `qbank_update_group` | 是 | `src-tauri/src/commands.rs:1501` | 成功 | 4：`qbank.g3.structure.delete_material.unreferenced_after_group_cleared` 等 |  |
| `qbank_update_material` | 是 | `src-tauri/src/commands.rs:1432` | 成功 | 1：`qbank.g3.structure.update_material.body_and_version_bump` |  |
| `qbank_update_paper` | 是 | `src-tauri/src/qbank_practice.rs:85` | 成功 | 3：`qbank.g3.paper.update.rename_then_get` 等 |  |
| `rename_exam_sheet_session` | 否 | `src-tauri/src/commands.rs:980` | 成功 | 2：`qbank.g3.structure.rename_exam_sheet_session.set_name` 等 |  |
| `resume_question_import` | 是 | `src-tauri/src/commands.rs:1285` | 成功 | 3：`qbank.g3.resume.after_json_import` 等 |  |
| `update_exam_sheet_cards` | 是 | `src-tauri/src/commands.rs:957` | 成功 | 2：`qbank.g3.structure.update_exam_sheet_cards.update_card_text` 等 |  |

### 本包新增的跨域 / 跨命令 setup（不计入覆盖）

| 命令 | owner | Rust | 用途 |
|---|---|---|---|
| `dstu_create`（type=exam） | L13-vfs-api | `crates/dstu-vfs/src/dstu/handlers.rs:727`（exam 分支 :1097） | 建题目集 |
| `dstu_create`（type=file） | L13-vfs-api | `crates/dstu-vfs/src/dstu/handlers.rs:1208` | 造 VFS 文件，作 `qbank_get_source_page` 的 `sourceId` |
| `dstu_update`（resourceType=exam） | L13-vfs-api | `crates/dstu-vfs/src/dstu/handlers.rs:1439` → `handler_utils/content_helpers.rs:753` | 写 `exam_sheets.preview_json`，造历史卡片 / 整卷卡片 |
| `save_api_configurations` | L02-llm-manager | `src-tauri/src/commands.rs:2150` | authoring route / AI 出题的模型配置 |
| `import_question_bank`（format=json/zip） | L14-qbank（不在本清单） | `src-tauri/src/commands.rs:1088` | 免 LLM 地产生草稿、material、group |
| `qbank_create_question` `qbank_submit_answer` | L14-qbank（WP-052 已覆盖） | `commands.rs:7705` / `:7818` | 造题、作答 |

### runner 侧缺口（导致未覆盖或 pending）

| 缺口 | 影响命令 | 需要 |
|---|---|---|
| 对象键上的 `${n.path}` 不解析（`scenario-v0.mjs` `resolveReferences` 只处理值） | `qbank_grade_practice_manually` `qbank_retry_practice_grading`，以及 save/submit 带答案的变体 | 键引用支持（X1/X7） |
| 无"等后台任务 / DB 条件"屏障 | `qbank_retry_practice_grading`；AI 出题后台任务终态 | 可等待的 DB 条件或任务终态（X1/X7） |
| 进程内 pending export 无法从场景注入 | `qbank_complete_paper_export` | 从 `qbank-export-paper` 事件取 `request_id` 或测试 seed 钩子（X1/X3） |
| 文件 / 图片 fixture 与脚本化多模态 LLM | `qbank_crop_source_image`，`qbank_get_source_images` 的非空分支 | `${fixture.*}`、`${provider.url}`（X3/X5/X7） |
| CSV 场景使用固定绝对路径 `/tmp/l14-qbank-g3-<场景>.csv`（导出返回值回显，后续步骤整值引用 `file_path`） | `export_questions_csv` `import_questions_csv` `get_csv_preview` | A/B 若同时跑同一场景会争用同一文件；请 runner 串行跑这些场景，或提供 per-run 目录占位后改为 `${fixture.*}` |

### 未运行

本包只做了本地静态校验（JSON 可解析、id 全局唯一、引用指向更早的成功步骤、capture/normalize 合规），没有 A/B 回放，不计 C。

### 分组明细（作者记录）

#### WP-228 · L14-qbank · G3 练习分组（g3-practice）

文件：`host/plugins/qbank/equivalence/g3-practice.json`（可运行，15 场景 / 109 步）
`host/plugins/qbank/equivalence/pending-provider/g3-practice-llm.json`（pending，3 场景）
Rust 业务体全部在 `src-tauri/crates/dstu-qbank/src/qbank_practice.rs`（`src-tauri/src/qbank_practice.rs` 只是取 `AppState` 的薄包装）。所有场景 `seed=empty`、`capture={events:true,db:["*"]}`、`normalize=[]`。

##### 逐命令覆盖

| 命令 | 前端调用点(文件:行) | Rust(文件:行) | 成功场景 id | 备注/前置/owner |
|---|---|---|---|---|
| `qbank_create_practice` | `src/api/practiceApi.ts:95`；UI `src/components/practice/BatchPracticeWorkspace.tsx:215,701`、`src/features/learning-hub/apps/views/ExamContentView.tsx:1440-1447`、`src/features/learning-hub/mistakeBook/MistakeRedoOverlay.tsx:34-42` | 包装 `src-tauri/src/qbank_practice.rs:16` → 业务 `dstu-qbank/src/qbank_practice.rs:570` → `create_draft:219` | `qbank.g3.practice.create_sequential_start_index`、`create_timed_duration_deadline`、`create_idempotent_same_id`、`create_dedupes_ids_and_truncates_title`、`create_from_attempt_restart`、`create_mistake_redo_cross_exam_scope`、`list_attempts_two_records_order`、`create_zero_duration_and_unknown_start_question` | 8 个成功变体：顺序（`start_question_id` 定位 `current_index`）、限时（`duration_seconds` 生成 `deadline`）、同 id 重放返回既有草稿、重复 question_ids 去重 + 标题截断 200 字、`attempt_id` 克隆上一次交卷题目（前端「再练一次」）、`scope_id="__mistake_redo__"` 跨题目集组卷（错题重做，`create_draft:281` 的 scope 豁免分支）、同一 exam 连开两场（配合交卷/list 多行顺序）、`duration_seconds:0` 视为无时限 + 不在列表的 `start_question_id` 回退 0 |
| `qbank_save_practice` | `src/api/practiceApi.ts:100`；`BatchPracticeWorkspace.tsx:136` | 包装 `:25` → 业务 `:580` → `save_draft:338` | `save_marked_index_and_elapsed`（另在 `submit_unanswered_all_results`、`delete_draft_and_attempt` 中作前置） | 逐步 `revision` 递增（1→2→3）、`marked_ids`/`current_index`/`elapsed_seconds` 持久化；**`answers` 只能为空对象**，见"阻塞" |
| `qbank_get_practice` | `src/api/practiceApi.ts:96,98`；`BatchPracticeWorkspace.tsx:206,215,219,243,255,327`、`PracticeRuntimeBridge.tsx:48` | 包装 `:33` → 业务 `:587` | `create_sequential_start_index`、`create_timed_duration_deadline`、`create_idempotent_same_id`、`create_dedupes_ids_and_truncates_title`、`save_marked_index_and_elapsed`、`submit_unanswered_all_results`、`submit_replay_is_idempotent`、`resume_grading_with_timed_draft`、`create_from_attempt_restart`、`create_mistake_redo_cross_exam_scope`、`list_attempts_two_records_order`、`create_zero_duration_and_unknown_start_question` | draft 分支（`submitted:false`）与 attempt 分支（`submitted:true`）都覆盖；返回 `PracticeDraft`/`PracticeAttempt` 的 serde 形状 |
| `qbank_list_practices` | `src/api/practiceApi.ts:116`；`PracticeRecords.tsx:24`、`PaperLibrary.tsx:47` | 包装 `:42` → 业务 `:601` | `create_sequential_start_index`、`create_timed_duration_deadline`、`create_dedupes_ids_and_truncates_title`、`save_marked_index_and_elapsed`、`submit_unanswered_all_results`、`submit_replay_is_idempotent`、`list_practices_paging_and_scopes`、`delete_draft_and_attempt`、`resume_grading_empty_database`、`resume_grading_with_timed_draft`、`create_from_attempt_restart`、`create_mistake_redo_cross_exam_scope`、`list_attempts_two_records_order`、`create_zero_duration_and_unknown_start_question` | 成功且带数据的分支：draft 列表（`status:"draft"`、`correct_count:0`）、attempt 列表（`status:"completed"`、`pending_count:0`、多条按 `created_at DESC`）、`offset` 缺省/null/2/5（越界→`[]`）、未知 scope→`[]`；draft 按 `updated_at DESC,id DESC`、attempt 按 `created_at DESC,id DESC`，场景里 id 命名与创建顺序同向，避免时间戳并列导致的顺序歧义 |
| `qbank_submit_practice` | `src/api/practiceApi.ts:111`；`BatchPracticeWorkspace.tsx:310` | 包装 `:53` → 业务 `:664` → `submit_draft:393` | `submit_unanswered_all_results`、`submit_replay_is_idempotent`、`delete_draft_and_attempt`、`create_from_attempt_restart`、`list_attempts_two_records_order` | 全部题未作答的成功交卷：`results[].status="unanswered"`、`is_correct=null`、`score=null`、`submission_id=null`、`attempt.status="completed"`，草稿被删除；同 id 二次交卷短路返回既有 attempt（第二次传旧 revision 也不报错）+ 事件 `qbank-practice-updated` |
| `qbank_delete_practice` | `src/api/practiceApi.ts:122`；`PracticeRecords.tsx:41` | 包装 `:63` → 业务 `:676` | `delete_draft_and_attempt` | 两条分支：`submitted:false`→物理删 `qbank_practice_drafts`（随后 list 为空）；`submitted:true`→软删 `qbank_practice_attempts.deleted_at`（随后 list submitted 为空）。额外覆盖删除不存在的 draft 仍 `Ok(null)`（幂等删除） |
| `qbank_grade_practice_manually` | `src/api/practiceApi.ts:126`；`BatchPracticeWorkspace.tsx:965` | 包装 `:112` → 业务 `:1060` | 无（pending：`qbank.g3.practice.grade_manually_upgrade_and_downgrade`） | 需 attempt 中某题 `status!="unanswered"`，而创造该状态必须写入 `answers`（键＝动态题目 id），v0 runner 不支持，见"阻塞" |
| `qbank_retry_practice_grading` | `src/api/practiceApi.ts:124`；`BatchPracticeWorkspace.tsx:943` | 包装 `:101` → 业务 `:1027` | 无（pending：`qbank.g3.practice.retry_failed_grading`） | 需 `results[].status=="failed"`，只能由后台 AI 批改队列失败产生；除 `answers` 键问题外还需要"等后台任务落库"的屏障，见"阻塞" |
| `qbank_resume_practice_grading` | `src/api/practiceApi.ts:127`；`PracticeRuntimeBridge.tsx:21`、`BatchPracticeWorkspace.tsx:223` | 包装 `:96` → 业务 `:744` | `resume_grading_empty_database`、`resume_grading_with_timed_draft` | 总是 `Ok(null)`（契约 result=null）：空库 resume 只跑一遍批改队列；带 `deadline` 的草稿 resume 会重新注册截止计时（重复调用不重复注册），草稿保持未交卷状态 |

##### 跨域 setup 命令

| 命令 | owner lane | Rust 文件:行 | 用途 |
|---|---|---|---|
| `dstu_create`（type=exam） | L13-vfs-api | `src-tauri/crates/dstu-vfs/src/dstu/handlers.rs:727`（exam 分支 :1097） | 每个场景先建题目集，返回 `DstuNode.id` 作 `scope_id`/`exam_id`（`questions.exam_id` 有外键，seed=empty 下必须先建） |
| `qbank_create_question` | L14-qbank（本 lane，WP-052 已覆盖） | `src-tauri/src/commands.rs:7705` → `dstu-qbank/src/question_bank_service.rs:183` | 造题（`single_choice` / `true_false` / `multiple_choice` / `essay`），返回题目 id 供 `question_ids` 引用 |

##### 统计

| 项 | 数 |
|---|---|
| 可运行场景 | 15（全部无 `expect:"error"`，共 109 步） |
| pending 场景 | 3（`pending-provider/g3-practice-llm.json`） |
| 可运行覆盖命令 | 7 / 9（create / save / get / list / submit / delete / resume） |
| 含 pending 的覆盖命令 | 9 / 9 |

##### 阻塞（重要，影响其他含"动态 id 作 Map 键"入参的命令）

1. **`answers` 的键必须是动态题目 id，runner v0 不支持键上的整值引用。**
   `SavePracticeRequest.answers: HashMap<String,String>`（`qbank_practice.rs:103`）以题目 id 为键；`resolveReferences`（`scripts/electron-migration/record/scenario-v0.mjs:58-78`）只递归对象**值**，不解析键，所以 `{"${1.id}":"B"}` 会原样作为字面键，`save_draft` 立刻返回 `Answer does not belong to this practice`（`:350-358`）。题目 id 由 `nanoid` 随机生成（`question_repo.rs:2207`），无法预置，seed 只有 `empty`。
   影响：任何"有作答的练习"——`qbank_save_practice` 写入答案、`qbank_submit_practice` 的 correct/incorrect/partial 判分、`qbank_grade_practice_manually`（要求非 unanswered）、`qbank_retry_practice_grading`（要求 failed）。
   需要的 runner 扩展：对象键支持整值引用（`"${n.path}": value`），且比较器保持键的动态 id 与返回/事件/外键一致。三个 pending 场景已按这个形状写好，runner 支持后即可直接移入可运行集。

2. **后台 AI 批改队列与 capture 的竞态（`qbank_retry_practice_grading`）。**
   `qbank_submit_practice` 返回后 `start_grading` 异步跑队列（`qbank_practice.rs:735`）；`empty` seed 无模型配置时 `resolve_grading_config` 走 Model2 回退并立即失败 `对话模型未配置`（`pipeline.rs:777` → `dstu-llm/src/llm_manager/mod.rs:6945`），`record_grading_failure` 把结果置 `failed`、`attempt.status` 置 `needs_review`。失败**必然发生但没有同步屏障**：A 是 tokio spawn、B 是 Promise 微任务，`executeScenario` 每步后立即 capture（`scenario-v0.mjs:96-100`），命中的是 pending 还是 failed 不确定，且 `retry` 之后又会再起一轮批改。
   需要的 runner 扩展：可等待的 DB 条件屏障（例如等 `qbank_practice_jobs.status='failed'`），retry 前后各一次；否则 `retry` 会命中 `Only failed grading can be retried`（`:1046`）。

3. `qbank_create_practice` 的 `paper_id` 分支（`:262-267`）与"按试卷开始练习"（前端 `ExamContentView.tsx:2809`）需要 `qbank_generate_paper` 产出的试卷，属其他分组；本组未覆盖，也没有先建纸卷再建练习的串联步骤。

##### 非确定字段 / normalize 候选（`normalize` 仍为 `[]`）

- 时间戳：`created_at`、`updated_at`（draft/attempt 与 summary）、`submitted_at`。Rust `Utc::now().to_rfc3339()` 为纳秒精度，B 端只到毫秒，必然不同。
- 限时练习的 `deadline`：`create_timed_duration_deadline` / `resume_grading_with_timed_draft` 不传 `started_at`，`deadline = now + duration`，A/B 相差若干秒（故意不传固定 `started_at`：既保留前端真实形状，也避开两个陷阱——远端未来时间会让 B 的 `setTimeout` 超过 2^31-1ms 溢出而立刻交卷，固定过去时间会让两端都在 3 秒后自动交卷）。
- `origin_device_id`（attempt 文档内）与 `qbank_practice_attempts.device_id`：设备 id 按实例生成，A/B 不同。同步 lane 若已有 device id 归一规则，可复用。
- 事件 `qbank-practice-updated` 的 payload 是 attempt id，可保序比较；批改队列失败时 `error` 文本为 `对话模型未配置`（A/B 文案来自各自实现，需 A1/A2 双录后确认）。

#### WP-228 G3 试卷 / 考试 / 每日一练 / 统计（L14-qbank）

文件：

- 可运行：`host/plugins/qbank/equivalence/g3-paper-exam.json`（24 个场景，11 条命令）
- pending：`host/plugins/qbank/equivalence/pending-provider/g3-paper-exam-pending.json`（2 个场景，1 条命令）

全部场景 `seed:"empty"`、`capture:{events:true,db:["*"]}`、`normalize:[]`。跨步引用只用整串 `${n.path}`，
n < 当前步且不引用带 `expect` 的步（本包没有 `expect` 步）。随机选题相关命令（`qbank_generate_paper` /
`qbank_generate_mock_exam` / `qbank_start_timed_practice` / `qbank_get_daily_practice`）不预写期望返回，
只断言"能成功返回"由 A 实录决定。

##### 命令表

| 命令 | 前端调用点(文件:行) | Rust(文件:行) | 成功场景 id | 备注/前置/owner |
|---|---|---|---|---|
| `qbank_generate_paper` | `src/stores/questionBankStore.ts:2359` | `src-tauri/src/commands.rs:8168` → `crates/dstu-qbank/src/question_bank_service.rs:2854` →（落库 `crates/dstu-qbank/src/qbank_practice.rs:172 save_paper`） | `qbank.g3.paper.generate.type_selection_persisted`、`...generate.all_with_difficulty_and_tags`、`...generate.multi_type_word_config`（+ 3 个 update 场景复用） | 需先 `dstu_create` 建 exam 并 `qbank_create_question` 建题（exam_id 外键）。题型配比命中不足 → Err（不写）；`type_selection` 为空 → 走难度/标签筛选最多 500 题。`export_format:word/markdown` 只写进 config，本命令**不生成文件**（`export_path` 恒 null），真正导出在聊天工具 `execute_generate_paper`（`qbank_executor.rs:4161`），不属本 lane 命令面 |
| `qbank_list_papers` | `src/api/practiceApi.ts:128` | `src-tauri/src/qbank_practice.rs:72` → `crates/dstu-qbank/src/qbank_practice.rs:692` | `qbank.g3.paper.generate.multi_type_word_config`、`...update.null_title_keeps_paper`、`...update.soft_delete_hides_from_list`、`...list.empty_exam` | 顶层参数 `examId`（camelCase）；按 `created_at DESC`，过滤 `deleted_at IS NULL`。空题目集 → `Ok([])` |
| `qbank_get_paper` | `src/api/practiceApi.ts:129` | `src-tauri/src/qbank_practice.rs:80` → `crates/dstu-qbank/src/qbank_practice.rs:705`（`load_paper :184`） | `qbank.g3.paper.generate.type_selection_persisted`、`...update.rename_then_get` | 读 `qbank_papers.document_json`；标题改名后 `title` 与 `config.title` 都变（`update.rename_then_get` 末步读回验证）。未知 / 已软删 → `Paper not found`（不写） |
| `qbank_update_paper` | `src/api/practiceApi.ts:131` | `src-tauri/src/qbank_practice.rs:85` → `crates/dstu-qbank/src/qbank_practice.rs:711` | `...update.rename_then_get`（改名 + 前后空格裁剪）、`...update.null_title_keeps_paper`（title=null 只 bump `local_version`）、`...update.soft_delete_hides_from_list`（deleted=true 软删） | 返回 unit（null）。`title` 可选，空串 / >200 字符 → Err（不写）。软删后 `qbank_list_papers` 看不到、`qbank_get_paper` 会 Err |
| `qbank_export_paper_docx` | `src/components/practice/paperExport.ts:398` | `crates/dstu-qbank/src/qbank_practice/export.rs:228`（`build_docx :97`） | `qbank.g3.paper.export_docx.full_blocks`、`...empty_blocks`、`...heading_levels_and_page_break` | 同步命令、无状态依赖：`title` + `PaperBlock[]` → base64 DOCX。覆盖 heading(level 0/1/2 + page_break)、paragraph(bold/italic/多行)、table、space(带/不带 lines)、空 blocks（只写标题页）。**image 块未覆盖**：需要真实图片 data URL（Rust 走 `docx_handout::prepare_png`，host 走 `paperImageCodecOf`），属需要 fixture 的输入，未写成场景（见末节） |
| `qbank_complete_paper_export` | `src/components/practice/PracticeRuntimeBridge.tsx:33,39` | `crates/dstu-qbank/src/qbank_practice/export_bridge.rs:66` | 无可运行成功场景；pending：`qbank.g3.paper.complete_export.word_pending_request`、`...markdown_pending_request` | **读码结论**：`EXPORTS`（:17）只由 `export_for_tool`（:29）写入，而它只被聊天工具 `execute_generate_paper`（`src-tauri/src/chat_v2/tools/qbank_executor.rs:4161`）调用。`requestId` 不在表里 → `Err(Validation "Export request expired")`（:73-75）。纯命令回放无法先造出 pending 请求，所以没有可达的 Ok 路径；一旦命中 pending，即使 `data` 不合法命令本身也返回 `Ok(())`（错误只经 oneshot 回给 `export_for_tool` 的等待方，:114）。详见末节所需 hook |
| `qbank_generate_mock_exam` | `src/stores/questionBankStore.ts:2276` | `src-tauri/src/commands.rs:8106` → `crates/dstu-qbank/src/question_bank_service.rs:2338` | `qbank.g3.paper.mock_exam.generate_distributions`（题型配比 2+1，total 3）、`...fill_to_total`（无配比，total 5 > 库里 3 题 → 实际 3） | `config` 全字段必填（`MockExamConfig__De`：duration_minutes/type_distribution/difficulty_distribution/shuffle/include_mistakes，total_count/tags 可 null）。`include_mistakes:false` 时排除 `review` 状态。配比与 total_count 都选不出题 → Err（不写） |
| `qbank_submit_mock_exam` | `src/stores/questionBankStore.ts:2311` | `src-tauri/src/commands.rs:8126` → `crates/dstu-qbank/src/question_bank_service.rs:2463` | `...mock_exam.submit_unanswered_session`（未作答会话，真实 question_ids）、`...mock_exam.submit_stale_question_ids`（答题但题 id 已不在库：跨设备 / 已删题，`get_questions_by_ids` 返回空集，仍按 answers/results 出分） | session 由前端持有并回传（`MockExamSession__De`）。**没有**"generate→submit 整对象引用"场景：本波约定只允许 `${n.path}`，不能整对象 `${n}`；且 `answers`/`results` 是以题目 id 为 key 的 map，key 无法用 `${n.path}` 占位。`started_at`/`ended_at` 用固定 RFC3339，`time_spent_seconds` 确定（1800 / 900） |
| `qbank_start_timed_practice` | `src/stores/questionBankStore.ts:2253` | `src-tauri/src/commands.rs:8081` → `crates/dstu-qbank/src/question_bank_service.rs:2276` | `qbank.g3.paper.timed.basic`（3 题取 2）、`...timed.capped_by_available`（要 5 题只有 2 题 → `question_count` 回落实到 2） | `question_count`/`duration_minutes` 为 0 → Err（不写）；空题库 → Err（不写）。返回会话不落库 |
| `qbank_get_daily_practice` | `src/stores/questionBankStore.ts:2337` | `src-tauri/src/commands.rs:8147` → `crates/dstu-qbank/src/question_bank_service.rs:2615` | `...daily.fresh_new_questions`（5 题取 3，全 new，`is_completed=false`）、`...daily.after_all_answered_is_completed`（当天答完 2 题再来取 2：`completed_count=2`、`is_completed=true`，exclude 后按第 5 步回填已答题）、`...daily.count_exceeds_available`（要 5 题只有 2 题，`daily_target=5` 但只返回 2 个 id） | 依赖本地日期（`chrono::Local`，`query_daily_progress :2767`）。`count=0` → Err（不写）。"错题优先"分支需要 review 状态题且当天未作答，命令面无法跨天造数据，未覆盖（见末节） |
| `get_enhanced_statistics` | `src/utils/settingsApi.ts:267` | `src-tauri/src/commands.rs:2109` → `crates/dstu-storage/src/file_manager.rs:745` | `qbank.g3.paper.enhanced_stats.empty_data_dir` | 无参数、无 AppState 业务前置；只需 `state.file_manager`。返回 `{image_stats:{total_files,total_size_bytes,file_types,oldest_file,newest_file},timestamp}`，`timestamp` 每次不同（normalize 候选，未启用）。空数据目录 → `total_files=0` 且 images 目录不存在时提前 `Ok`（:754-759） |
| `get_learning_heatmap` | `src/hooks/useLearningHeatmap.ts:96` | `src-tauri/src/commands.rs:8244` | `...heatmap.month_with_answers`（先建 exam+2 题并各提交 1 次，再查 2026-11-01..2026-11-30）、`...heatmap.empty_range`（2025-06-01..03 全 0）、`...heatmap.single_day`（单日区间 → 1 条）、`...heatmap.reversed_range_empty`（start>end → `Ok([])`） | **注入 app-handle**，不取 `State<'_, AppState>` 参数但在内部 `app_handle.state::<AppState>()`（:8337）。查询库：Chat V2 DB（`try_state::<ChatV2Database>`，:8299；会话 :8307 / 消息 :8322）、**VFS 库**（notes :8344、files.last_opened_at :8360、exam_sheets :8376、translations :8391、essays :8406、**answer_submissions :8421**、study_time_daily :8435）、**主库**（`state.database` 的 anki_cards :8450）。计数 `count` 为 9 项明细之和、**不含** `studySeconds`（:8463-8476）。所有子查询失败都 `unwrap_or_default()` 静默降级，所以本命令没有可达 Err（日期格式非法除外）。区间先按天铺满再聚合，日期按本地日界（`DATE(...,'localtime')` / `study_time_daily.date` 原值） |

##### 跨域 / 他 lane setup 命令

| 命令 | owner lane | Rust 文件:行 | 用途 |
|---|---|---|---|
| `dstu_create`（type=exam） | L13-vfs-api | `src-tauri/crates/dstu-vfs/src/dstu/handlers.rs:727`，exam 分支 :1097 | 每个场景第 0 步建题目集，`${0.id}` 即 `exam_id`（`questions.exam_id` 外键） |
| `qbank_create_question` | L14-qbank（本 lane，非本文件目标命令） | `src-tauri/src/commands.rs:7705` | 造题：`single_choice` / `multiple_choice` / `true_false`，带 difficulty/tags |
| `qbank_submit_answer` | L14-qbank（本 lane，非本文件目标命令） | `src-tauri/src/commands.rs:7818` | 造 `answer_submissions` 行（热力图 `questionsAnswered`）、造当天进度（每日一练 `completed_count`） |

##### pending：`qbank_complete_paper_export` 需要 runner/X3 提供什么

现状（逐字读码）：

1. `export_bridge.rs:17` 的 `EXPORTS: LazyLock<Mutex<HashMap<String,PendingExport>>>` 是进程内单次等待表。
2. 唯一写入口是 `export_for_tool`（:29-45）：生成 `uuid` → 插入 `{title, format, sender}` → `window.emit("qbank-export-paper", ExportRequest{request_id, paper, format, include_answers, include_explanations})`（:46-58）→ 120s 超时等待。
3. 该函数只被聊天工具 `execute_generate_paper`（`src-tauri/src/chat_v2/tools/qbank_executor.rs:4161`，条件 `export_format != preview`）调用；`qbank_generate_paper` 命令本身不导出文件。
4. `qbank_complete_paper_export`（:66）第一步就是 `EXPORTS.remove(&request_id)`，取不到直接 `Err(AppError::validation("Export request expired"))`（:73-75）。

因此回放器必须能在调用该命令前让 EXPORTS 里存在一条 pending 记录，并把它的 `request_id` 交给场景。两种可行 hook（任一即可）：

- **(A) 推荐**：runner 支持一步"聊天工具调用"（`builtin-qbank_generate_paper`，参数 `exam_id` + `export_format:"word"`，需先建 exam/题），该步会 emit
  `qbank-export-paper` 事件（`capture.events=true` 已开启），runner 从事件 payload 的 `request_id` 取值，
  再以下一步 `qbank_complete_paper_export` 回传。此时 `data` 必须是"PK"开头的 base64（word）或非空 UTF-8（markdown）/
  `%PDF-`（pdf）：本包给的 `"UEsDBA=="`（字节 `50 4B 03 04`）与 `"aGVsbG8="`（`hello`）就是按此校验挑的
  （`export_bridge.rs:83-88`）。文件落在 `app_data_dir/exports/qbank/{title}-{request_id}.{docx|md|pdf}`。
- **(B) 仅测试钩子**：runner/X3 暴露一个 seed 接口，在回放进程内直接注册 pending 请求（等价于
  `export_for_tool` 的插入 + 一个丢弃用的 sender，`format` 取 `word`/`markdown`），并把 id 以
  `${fixture.pendingExportRequestId}` 注入。**注意**：这种情况下 `export_for_tool` 的等待方不存在，
  文件仍会写盘，但"回传结果"无法被观察；A/B 只能比对 `Ok(null)` 与 db/文件副作用。

pending 文件里的两个场景除 `requestId` 占位符外都可直接跑；`data` 已按格式校验要求给死值。
未写 `error` 非空 / 非法 base64 / 格式不匹配的 pending 场景（命令仍返回 `Ok(())`，属错误语义，归 W-L14）。

##### 未覆盖 / 已知缺口

| 项 | 原因 | 归属 |
|---|---|---|
| `qbank_export_paper_docx` 的 `image` 块（`PaperRun.image` / `PaperBlock.image`） | 需要真实图片 data URL（PNG/JPEG base64 或 data URI），Rust `docx_handout::prepare_png` 会解码并按 50MB / 600pt 约束缩放；runner v0 无临时文件占位 | 需要 X3 提供 fixture：`data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==`（1×1 PNG），可整串写进 `runs[0].image` |
| `qbank_get_daily_practice` 的"错题优先"（`source_distribution.mistake_count>0`） | 需要一条 `status='review'` 且**当天未作答**的题；命令面只有答错才置 review（`crates/dstu-vfs/src/vfs/repos/question_repo.rs:2570-2575`），而答过的题会被 `answered_today_ids` 排除，同一天内不可达 | 需要回填 `last_attempt_at`/`answer_submissions.submitted_at` 为过去日期的 seed（无命令） |
| `get_learning_heatmap` 的 chat / anki / 笔记 / 教材等非 qbank 计数 | 需 Chat V2、anki、VFS notes/files 等别 lane 的命令造数据；本包只覆盖 `questionsAnswered`（qbank 作答）与全 0 区间 | 跨 lane（Chat V2 / L15-anki / L13-vfs）|
| `qbank_submit_mock_exam` 的 generate→submit 整对象透传 | 场景引用只允许 `${n.path}`，不能整对象 `${n}`；`answers`/`results` 的 key 是动态题目 id，无法占位 | 若 WAVE0 §3 后续支持整对象引用或 key 插值，可加一条真正的 `generate_mock_exam → submit_mock_exam(${n})` |

##### 统计

- 可运行场景 **24** 个（每条目标命令 ≥1 个；`get_learning_heatmap` 4 个、`generate_paper` 3 个 + 3 个复用、`update_paper` 3 个）。
- pending 场景 **2** 个（`qbank_complete_paper_export`）。
- 覆盖命令 **12/12**：11 条可运行 + 1 条（`qbank_complete_paper_export`）pending／读码确认为"无 pending 请求必 Err"。

##### 日期与时区假设

- `qbank_get_daily_practice` 与 `get_learning_heatmap` 按**本地日期**统计（`chrono::Local`、SQL `'localtime'`）；
  热力图"带数据"场景假设 A/B 在同一本地日期、同一时区回放，且日期落在 **2026-11**（窗口取整月 2026-11-01..2026-11-30，
  与 `stats-time.json` 的 WP-156 口径一致）。若回放日期落在窗口外，该场景只应剩全 0 计数（同一场景内仍能把
  `questionsAnswered` 的差值与 db 快照对齐）。
- `qbank_submit_mock_exam` 的 `time_spent_seconds` 用固定 `started_at`/`ended_at`，与回放时间无关（1800s / 900s）。
- 所有"今天"相关的口径（每日一练 completed/is_completed、热力图当天计数）无法在 JSON 里钉死，期望值以 A 实录为准。

#### WP-228 分组：题目导入 / 导出 / CSV（11 条命令）

产出文件：`host/plugins/qbank/equivalence/g3-import-export.json`
覆盖命令：`export_questions_csv` `import_questions_csv` `cancel_questions_csv_import` `get_csv_preview` `import_question_bank_stream` `cancel_question_bank_import` `resume_question_import` `qbank_export_document` `qbank_export_portable`（在 768=是，先写）；`get_csv_exportable_fields` `list_importing_sessions`（在 768=否，后写，同文件内）。

##### 命令表

| 命令 | 前端调用点(文件:行) | Rust(文件:行) | 成功场景 id | 备注/前置/owner |
|---|---|---|---|---|
| `export_questions_csv` | `src/stores/questionBankStore.ts:2050`；`src/components/QuestionBankExportDialog.tsx:603` | `src-tauri/src/commands.rs:1876` → `crates/dstu-qbank/src/question_export_service.rs:125`（`export_csv`） | `qbank.g3.csv_export.default_fields_two_questions`<br>`qbank.g3.csv_export.selected_fields_utf8_bom`<br>`qbank.g3.csv_export.default_fields_with_answer_records`<br>`qbank.g3.csv_export.gbk_filtered_by_difficulty` | 成功 4 变体：全默认字段（题干/题型/选项/答案/解析/难度/标签/题号）、`include_answers=true` 追加答题记录列（user_answer/is_correct/attempt_count/correct_count/status）、显式 `fields` + `utf8_bom`、`gbk` + `filters.difficulty=["hard"]`。`request` 内字段是 snake_case（`CsvExportCommandRequest` 无 rename_all）。非虚拟路径下 `CsvExportResult.file_path` 原样回显调用方给的 `file_path`，可被后续步骤整值引用（预览 / 导入 / 取消共 10 个场景用它串联）。空题目集会走 `没有可导出的题目`（W-L14 错误分支），本包不写。 |
| `get_csv_preview` | `src/stores/questionBankStore.ts:2004`；`src/components/CsvImportDialog.tsx:268` | `src-tauri/src/commands.rs:1968` → `question_import_service.rs:4087`（`preview_csv`） | `qbank.g3.csv_preview.after_export_rows_limit`<br>`qbank.g3.csv_preview.gbk_default_rows`<br>`qbank.g3.csv_preview.utf8_bom_zero_rows` | 前置文件由 `export_questions_csv` 生成，`filePath` 用 `${n.file_path}` 整值引用（导出写的就是同一绝对路径，文件内容确定）。覆盖 `rows=1`、`rows` 缺省（默认 5）、`rows=0`（`total_rows` 仍计入）。编码由文件字节探测：`utf8_bom` 导出→`UTF-8`（BOM 被剥掉），`gbk` 导出→`GBK`。 |
| `import_questions_csv` | `src/stores/questionBankStore.ts:2019`；`src/components/CsvImportDialog.tsx:402` | `src-tauri/src/commands.rs:1710` → `question_import_service.rs:4120`（`import_csv`） | `qbank.g3.csv_import.roundtrip_creates_new_exam`<br>`qbank.g3.csv_import.into_existing_exam_subset_mapping`<br>`qbank.g3.csv_import.duplicate_overwrite_same_exam`<br>`qbank.g3.csv_import.duplicate_skip_default_strategy` | 前置 CSV 由本包 `export_questions_csv` 产出，`field_mapping` 的键就是导出表头的中文显示名（`题干内容`/`题目类型`/`选项`/`答案`/`解析`/`难度`/`标签`/`题号`，见 `EXPORTABLE_FIELDS` `question_export_service.rs:66`），因此导出→导入可闭环：默认 8 列全映射、子集映射（content/answer/question_label）、`duplicate_strategy="overwrite"`（命中同题干→更新，成功计数 1）、缺省策略 `skip`（全部跳过）。`exam_id` 指向不存在的 id 时 `ensure_exam_exists`（:4593）会按 `exam_name` 新建题目集并返回新 id。 |
| `cancel_questions_csv_import` | `src/components/CsvImportDialog.tsx:245,505` | `src-tauri/src/commands.rs:1860` | `qbank.g3.csv_cancel.unknown_id`<br>`qbank.g3.csv_cancel.blank_id`<br>`qbank.g3.csv_cancel.after_completed_import` | 未知 id / 空串 → `Ok(false)`（:1864-1871 提前返回，真实成功路径）。`after_completed_import` 先带 `import_id` 跑完一次导入（命令结束时 `state.csv_import_cancellations` 已按 ptr_eq 移除，:1813-1823），再取消同一 id → `Ok(false)`，覆盖"已登记过的 id 在终态后不可取消"。**`Ok(true)` 变体做不到**：令牌只在 `import_questions_csv` 内同步登记并在返回前移除，`spawn_blocking` 在命令返回前 await 完成，顺序执行场景无法观察到在途窗口；需要 runner 支持并发调用/暂停（见下"未覆盖"）。 |
| `import_question_bank_stream` | `src/components/ExamSheetUploader.tsx:687` | `src-tauri/src/commands.rs:1123` → `question_import_service.rs:401/420`（`prepare_document`） | `qbank.g3.import_stream.json_full_document`<br>`qbank.g3.import_stream.json_legacy_questions_only_default_name`<br>`qbank.g3.import_stream.json_into_existing_session`<br>`qbank.g3.import_stream.zip_portable_roundtrip`<br>`qbank.g3.import_stream.with_import_id_then_cancel` | **不需要 LLM**：`format="json"` 走 `prepare_document` 的 json 分支（:448），`format="zip"` 走 `import_portable`（:442），都不解析模型配置。变体：完整 v2 文档（2 题）+ `import_id`；仅 `questions[]`（camelCase `questionType`/`questionLabel`，走 :454-478 归一化）且不传 `name`（默认名 `导入的题目集`）；`session_id=${dstu_create}` 追加入已有题目集（`create_import_session` :2736 分支）；便携包 zip 回导（`content=${n.base64}` 引用 `qbank_export_portable`，含 1 题）；带 `import_id` 完成后再次取消 → `Ok(false)`（顺带覆盖 `cancel_question_bank_import` 的已登记终态）。返回 `QuestionImportDraftResponse` 是 flatten 的 `summary`/`preview` + snake_case 的 `draft_job_id`/`draft_version`/`draft_document`/`model_route`/`committed`，题目落在草稿里（`committed=false`，正式题目表仍为空）。非 json/zip 的 txt/md/pdf/docx 需要 LLM（`resolve_question_authoring_config`），不写入可运行集。 |
| `cancel_question_bank_import` | `src/components/ExamSheetUploader.tsx:388,970,1007` | `src-tauri/src/commands.rs:1265` | `qbank.g3.import_cancel.unknown_id`<br>`qbank.g3.import_cancel.blank_id`<br>`qbank.g3.import_stream.with_import_id_then_cancel` | 未知 id / 空串 → `Ok(false)`（:1266-1275）。第三条先跑完带 `import_id` 的导入再取消 → `Ok(false)`。**`Ok(true)` 变体做不到**：令牌仅在 `import_question_bank_stream` / `resume_question_import` 执行期间存在，两者都在同一命令内 await 完成后移除登记（:1244-1252、:1353-1355），顺序场景无在途窗口。 |
| `resume_question_import` | `src/components/ExamSheetUploader.tsx:1054`；`src/utils/systemApi.ts:398` | `src-tauri/src/commands.rs:1286` → `question_import_service.rs:741`（`resume_import`） | `qbank.g3.resume.after_json_import`<br>`qbank.g3.resume.with_import_id`<br>`qbank.g3.resume.after_import_into_existing_session` | **不需要 LLM**：json 导入把 `import_state_json` 写成 `{"schema_version":2,"job_id":...}`（`prepare_document` :563-568），`resume_import` 命中 :801-821 的 job_id 分支，直接重读 `qbank_import_jobs` 返回草稿；`sessionId` 用 `${n.summary.id}` 整值引用。覆盖：不带 `importId`、带 `importId`（登记取消令牌后正常移除）、恢复"追加到已有题目集"的会话。`source_bundle` 分支（:753）与旧 checkpoint 分支都需要 LLM/旧格式 checkpoint，未写入。 |
| `qbank_export_document` | `src/api/questionBankApi.ts:401` | `src-tauri/src/commands.rs:1490` → `crates/dstu-qbank/src/question_export_service/authoring.rs:17`（`export_document`） | `qbank.g3.export_document.two_questions`<br>`qbank.g3.export_document.empty_exam`<br>`qbank.g3.export_document.preserves_label_tags_and_options` | 纯内存返回 JSON（`schema_version:2`/`mode:"extract"`/`materials`/`groups`/`questions`/`sources`/`source_pages`），不落盘。覆盖 2 题（选择题 + 简答题）、空题目集（各数组为空）、单题字段保真（options/answer/explanation/difficulty/tags/question_label）。 |
| `qbank_export_portable` | `src/api/questionBankApi.ts:412` | `src-tauri/src/commands.rs:1634` → `authoring.rs:146`（`export_portable`） | `qbank.g3.export_portable.with_questions`<br>`qbank.g3.export_portable.empty_exam`<br>（回导见 `qbank.g3.import_stream.zip_portable_roundtrip`） | 返回 `{base64,name}`（zip：`document.json` + `manifest.json`），无 blob 资产时 `assets` 为空。`name` 形如 `question-bank-{exam_id}.zip`。空题目集也能成功导出（不调用 `QuestionDocument::validate`）。有题目时可直接作为 `import_question_bank_stream(format:"zip")` 的 `content` 整值引用。 |
| `get_csv_exportable_fields` | `src/stores/questionBankStore.ts:2072` | `src-tauri/src/commands.rs:2006` → `question_export_service.rs:105` | `qbank.g3.exportable_fields.list` | 无参数、无状态，恒定返回 18 个 `(key, 中文名)` 二元组（`EXPORTABLE_FIELDS`，:66-85）。 |
| `list_importing_sessions` | `src/utils/systemApi.ts:388` | `src-tauri/src/commands.rs:1647` → `crates/dstu-vfs/src/vfs/repos/exam_repo.rs:1532` | `qbank.g3.importing_sessions.empty_db`<br>`qbank.g3.importing_sessions.after_json_import`<br>`qbank.g3.importing_sessions.after_commit_cleared` | 只查 `exam_sheets.status='importing' AND deleted_at IS NULL`。空库 → `[]`；json 导入后新建的会话状态就是 `importing`（`create_import_session` :2782），`import_state_json` 是 `{"schema_version":2,"job_id":...}`、`existing_question_count=0`（题目只在草稿里）；提交草稿（`qbank_commit_authoring_draft` 置 `completed` 并清 import_state，`commands.rs:1375-1377`）后再查 → `[]`。 |

##### 跨域/跨命令 setup（不在 `commands` 中，不计入本组覆盖）

| 命令 | owner lane | Rust 文件:行 | 用途 |
|---|---|---|---|
| `dstu_create` | L13-vfs-api | `src-tauri/crates/dstu-vfs/src/dstu/handlers.rs:727`（exam 分支 :1097） | 建题目集；参数形状同 `questions-crud.json`。`seed=empty` 下导出/建题都先要 exam |
| `qbank_create_question` | L14-qbank（WP-052 已覆盖） | `src-tauri/src/commands.rs:7705` → `question_bank_service.rs:183` | 造导出数据源（选择题/简答题） |
| `qbank_commit_authoring_draft` | L14-qbank（本 lane 其他分组） | `src-tauri/src/commands.rs:1361` → `qbank_authoring_service.rs:236` | 让导入会话从 `importing` 变 `completed`，用于 `list_importing_sessions` 的"清空"变体 |

##### 统计

- 可运行场景：33；pending 场景：0；覆盖命令：11 / 11（768=是 9 条全部覆盖；768=否 2 条也已覆盖）。
- 场景步数：91。所有场景 `seed="empty"`、`capture={events:true,db:["*"]}`、`normalize=[]`；无 `expect:"error"`。
- 每命令可直接验证的成功步数（含作为 setup 的复用）：`export_questions_csv` 12、`import_questions_csv` 5、`get_csv_preview` 3、`cancel_questions_csv_import` 3、`import_question_bank_stream` 10、`cancel_question_bank_import` 3、`resume_question_import` 3、`qbank_export_document` 3、`qbank_export_portable` 3、`get_csv_exportable_fields` 1、`list_importing_sessions` 3。

##### 文件路径与 fixture 说明（重要）

CSV 三个命令需要真实文件，本包按"**导出返回值可整值引用**"串联，不依赖外部 fixture：

- `export_questions_csv` 的 `file_path` 是调用方给的路径；非虚拟 URI 分支下 `CsvExportResult.file_path` 原样回显该值（`commands.rs:1902-1904` → `CsvExportService::export_csv` 返回 `file_path: request.file_path.clone()`，`question_export_service.rs:244`）。
- 场景用固定绝对路径 `/tmp/l14-qbank-g3-*.csv`（每个场景一个独立文件名，避免互相覆盖），导出会 `File::create` 创建/截断该文件；后续步骤用 `"${n.file_path}"` 引用，不写字面量路径。
- 该路径对 A（Rust）与 B（Node 适配层，`host/plugins/qbank/src/csv-commands.ts:198-245`）行为一致：两边都直接写普通路径并回显 `file_path`。**runner 需要保证 `/tmp` 可写**（当前 X1 `scenario-v0.mjs` 只重定向 `HOME/XDG_*/TMPDIR`，不禁止绝对路径）。若后续 runner 收紧为仅允许 seed 目录，请把这三个场景的字面量路径替换为 `${fixture.csv_export}` 并移入 `pending-provider/`（届时需要的外部输入如下）。

**fixture 逐字内容**（若需外部提供 CSV；等于 `export_questions_csv` 默认 8 字段、含 1 道单选题、UTF-8 无 BOM 时写出的字节，`\n` 换行）：

```csv
题干内容,题目类型,选项,答案,解析,难度,标签,题号
下列哪个是质数？,单选题,A. 4; B. 7; C. 9,B,7 只能被 1 和自身整除。,简单,数论,
```

（不含表头共 1 行；`total_rows=1`。GBK 变体请把同一内容用 GBK 编码写出；`utf8_bom` 变体在文件开头加 `EF BB BF`。）

##### 未覆盖的成功分支（及原因）

| 分支 | 位置 | 原因 |
|---|---|---|
| `cancel_questions_csv_import` / `cancel_question_bank_import` 返回 `Ok(true)` | `commands.rs:1274`、`:1869` | 令牌只在导入命令内部登记，且命令在返回前 await 完成并移除登记；顺序执行的 v0 runner 无法制造"在途"窗口。需要 runner 支持并发 invoke 或暂停/恢复任务。`Ok(false)` 已覆盖未知 id、空串、已登记过但已终态三种真实成功路径。 |
| `import_question_bank_stream` 的 txt/md/pdf/docx 分支 | `question_import_service.rs:484-546` | 需要真实 LLM（`resolve_question_authoring_config` + `run_document`）。json/zip 分支已给出无 LLM 成功路径。 |
| `export_questions_csv` 虚拟 URI 分支 | `commands.rs:1889-1901` | 需要 `Window` 与 `unified_file_manager::copy_file` 写回虚拟 URI（桌面/远程存储），headless runner 无该外部实现。 |
| `get_csv_preview` 虚拟 URI 分支 | `commands.rs:1975-1986` | 同上（`ensure_local_path` 物化虚拟 URI）。 |
| `resume_question_import` 的 `source_bundle` 分支 / 旧 checkpoint 分支 | `question_import_service.rs:753-799`、`:824` 起 | 前者需要真实 LLM 与可恢复的来源 bundle；后者需要旧版 `ImportCheckpointState` JSON（新代码不再写入该格式）。 |

#### WP-228 G3 结构 / 历史迁移 / 整卷命令（`g3-structure.json`）

文件：`host/plugins/qbank/equivalence/g3-structure.json`；23 个可运行成功场景，0 个 pending，覆盖 13 个目标命令。
所有场景 `seed:"empty"`，`capture` 统一 `{events:true, db:["*"]}`，`normalize:[]`；不预写期望值，不含 `expect:"error"` 步骤。

##### 目标命令表

| 命令 | 前端调用点(文件:行) | Rust(文件:行) | 成功场景 id | 备注/前置 |
|---|---|---|---|---|
| `qbank_list_structure` | `src/api/questionBankApi.ts:309`；UI `src/components/QuestionStructureManager.tsx:147` | `src-tauri/src/commands.rs:1530` → `dstu-qbank/src/qbank_management.rs:155` | `qbank.g3.structure.list_structure.material_group_exam`；`qbank.g3.structure.list_structure.empty_exam` | 有数据场景由 `import_question_bank(format=json)` + `qbank_commit_authoring_draft` 造出 material/group；空题目集返回空数组 |
| `qbank_update_material` | `src/api/questionBankApi.ts:239`；UI `src/components/QuestionMaterialView.tsx:210` | `commands.rs:1432` → `dstu-qbank/src/qbank_authoring_service.rs:541` | `qbank.g3.structure.update_material.body_and_version_bump` | 材料来自 authoring commit；第二次更新用 `${4.version}` 证明版本递增 |
| `qbank_delete_material` | `src/api/questionBankApi.ts:340`；UI `src/components/QuestionStructureManager.tsx:350` | `commands.rs:1453` → `qbank_authoring_service.rs:561` | `qbank.g3.structure.delete_material.unreferenced_after_group_cleared` | 先用 `qbank_update_group(materialIds:[])` 解除引用，再用 `list_structure` 返回的 material version 删除 |
| `qbank_update_group` | `src/api/questionBankApi.ts:317`；UI `src/components/QuestionStructureManager.tsx:291` | `commands.rs:1501` → `qbank_management.rs:283` | `qbank.g3.structure.update_group.reorder_members`；`qbank.g3.structure.update_group.remove_member_solo_group` | 不是 upsert，必须有已提交题组；后者覆盖“移出成员且组内仍有材料 → 生成 solo group”分支 |
| `qbank_delete_group` | `src/api/questionBankApi.ts:332`；UI `src/components/QuestionStructureManager.tsx:355` | `commands.rs:1612` → `qbank_management.rs:474` | `qbank.g3.structure.delete_group.ungroup_preserves_material`；`qbank.g3.structure.delete_group.delete_members`；`qbank.g3.structure.delete_group.ungroup_without_material` | 覆盖 `ungroup`（有材料 → solo group）、`delete_members`（软删子题）、`ungroup`（材料已解除 → ungrouped questions） |
| `qbank_legacy_audit` | `src/components/QuestionImportAuditPanel.tsx:158` | `commands.rs:1542` → `dstu-qbank/src/qbank_legacy_reconcile.rs:265` | `qbank.g3.structure.legacy_audit.preview_card_unmatched`；`qbank.g3.structure.legacy_audit.empty_exam` | 历史卡片通过 `dstu_update(resourceType:"exam")` 写 `exam_sheets.preview_json`（card_id=`c1`，`ocr_text` 非空）造出；空题目集返回零计数 |
| `qbank_legacy_migrate_selected` | `src/components/QuestionImportAuditPanel.tsx:166` | `commands.rs:1555` → `qbank_legacy_reconcile.rs:275` | `qbank.g3.structure.legacy_migrate_selected.unmatched_card_to_question` | 引用 `${2.migratable_card_ids.0}` 与 `${2.audit_version}`；同场景再 audit（matched）并用旧版本重放验证幂等回执 |
| `qbank_reparse_report` | `src/components/QuestionImportAuditPanel.tsx:177` | `commands.rs:1576` → `qbank_legacy_reconcile.rs:476` | `qbank.g3.structure.reparse_report.pending_draft_explicit_job`；`qbank.g3.structure.reparse_report.pending_draft_latest_job` | 草稿来自 `import_question_bank(format=json)` 且未提交；分别覆盖显式 `jobId` 与省略 `jobId` 取最近草稿 |
| `qbank_reparse_resolve` | `src/components/QuestionImportAuditPanel.tsx:189` | `commands.rs:1590` → `qbank_legacy_reconcile.rs:488` | `qbank.g3.structure.reparse_resolve.keep_all_and_idempotent_replay`；`qbank.g3.structure.reparse_resolve.import_first_item_as_new` | 前者 `decisions:[]`（全部 keep）→ 再次 report（resolved）→ 同决策重放返回已存回执；后者对 `items.0` 执行 `import_as_new`，产生新正式题目 |
| `update_exam_sheet_cards` | `src/utils/systemApi.ts:349`；`src/api/questionBankApi.ts:607` | `commands.rs:957` → `dstu-vision/src/exam_sheet_service.rs:312` | `qbank.g3.structure.update_exam_sheet_cards.update_card_text`；`qbank.g3.structure.update_exam_sheet_cards.delete_card` | 整卷 preview 由 `dstu_update(resourceType:"exam")` 写入；卡片只改 `ocr_text/tags/question_label` 或删除，不触碰图片文件；要求该 session 无正式题目（本场景满足） |
| `list_exam_sheet_sessions` | `src/utils/systemApi.ts:323` | `commands.rs:932` → `exam_sheet_service.rs:252` | `qbank.g3.structure.list_exam_sheet_sessions.limit_and_default` | 两个 `dstu_create` 会话；覆盖显式 `limit:10` 与 `request:{}`（默认 50，`unwrap_or(50).min(200)`） |
| `get_exam_sheet_session_detail` | `src/utils/systemApi.ts:336` | `commands.rs:945` → `exam_sheet_service.rs:299` | `qbank.g3.structure.get_exam_sheet_session_detail.seeded_card`；`qbank.g3.structure.get_exam_sheet_session_detail.empty_exam` | 有卡片场景的页宽高已写入 preview，避免 enrich 阶段读图片文件；空会话返回 `pages:[]` |
| `rename_exam_sheet_session` | `src/utils/systemApi.ts:362` | `commands.rs:980` → `exam_sheet_service.rs:312`（内部转发 `update_exam_sheet_cards`） | `qbank.g3.structure.rename_exam_sheet_session.set_name`；`qbank.g3.structure.rename_exam_sheet_session.clear_name` | 第二次同名改名走“无变更仍 Ok”；`exam_name:null` 显式清空名称 |

##### 跨域 / 跨组 setup 命令

| 命令 | owner lane / 组 | Rust 文件:行 | 用途 |
|---|---|---|---|
| `dstu_create` | L13-vfs-api | `dstu-vfs/src/dstu/handlers.rs:1097`（exam 分支） | 建题目集，返回 `.id` 作 examId、`.path` 供 `dstu_update` |
| `dstu_update`（`resourceType:"exam"`） | L13-vfs-api | `dstu-vfs/src/dstu/handlers.rs:1439` → `dstu/handler_utils/content_helpers.rs:753` | 整体写 `exam_sheets.preview_json`：造 legacy 卡片（audit/migrate）与整卷卡片（exam sheet detail/cards） |
| `import_question_bank`（`format:"json"`） | L14-qbank（导入命令组 / `g3-import-export.json`） | 前端 `host/plugins/qbank/index.ts:453`；`commands.rs:1088` → `dstu-qbank/src/question_import_service.rs:392/448` | **无需 LLM**：JSON 分支直接反序列化 `QuestionDocument`、校验并保存草稿；`session_id` 指向已建 exam |
| `qbank_commit_authoring_draft` | L14-qbank（导入/草稿组） | 前端 `host/plugins/qbank/index.ts:691`、`src/components/ExamSheetUploader.tsx:802`；`commands.rs:1362` → `qbank_authoring_service.rs:238` | 提交 JSON 草稿，按 document 的 groups/materials 创建 `qbank_groups` / `qbank_materials` / questions；回执含 `group_ids`、`material_ids` |

##### 前置状态与覆盖说明

- seed=empty 下**没有**直接创建 material/group 的 IPC：`qbank_update_group` 只改已存在题组（非 upsert），`qbank_create_question` 不产 group/material。确定性路径只有
  `import_question_bank(format:"json")`（question_import_service 的 JSON 分支不解析模型、不联网）+ `qbank_commit_authoring_draft`，故本组不需要 pending 文件。
- legacy 预览与整卷卡片同样没有专用 IPC；使用 `dstu_update(resourceType:"exam")` 整体覆盖 `preview_json` 是前端可达的既有写入口（`dstu-crud.json:4827` 已有同型场景）。
- 乐观锁值全部来自前一步返回值整值引用：material `version` 来自 `qbank_list_structure`，group `version` 来自 `qbank_list_structure`，legacy `audit_version`/`migratable_card_ids[0]` 来自 `qbank_legacy_audit`，reparse `report_version`/`items[0].local_id` 来自 `qbank_reparse_report`，草稿 `draft_job_id`/`draft_version` 来自 `import_question_bank`。
- `replace_existing` 分支（reparse）需要正式题目带稳定 `source_key`，本 seed=empty 可运行集无法确定性造出（`qbank_create_question` 不写 `source_key`），未写入成功场景。

##### 统计

| 指标 | 数量 |
|---|---|
| 可运行场景 | 23 |
| pending 场景 | 0 |
| 覆盖目标命令 | 13 / 13 |
| 使用的外部 setup 命令 | 4（`dstu_create`、`dstu_update`、`import_question_bank`、`qbank_commit_authoring_draft`） |

按命令的成功场景数：`qbank_list_structure` 2、`qbank_update_material` 1、`qbank_delete_material` 1、`qbank_update_group` 2、`qbank_delete_group` 3、`qbank_legacy_audit` 2、`qbank_legacy_migrate_selected` 1、`qbank_reparse_report` 2、`qbank_reparse_resolve` 2、`update_exam_sheet_cards` 2、`list_exam_sheet_sessions` 1、`get_exam_sheet_session_detail` 2、`rename_exam_sheet_session` 2。

#### WP-228 G3 出题 / 草稿 / 源图分组（9+2 条命令）

可运行文件：`host/plugins/qbank/equivalence/g3-authoring-generation.json`（11 场景 / 10 命令）
Pending 文件：`host/plugins/qbank/equivalence/pending-provider/g3-authoring-generation-llm.json`（2 场景 / 3 命令）

##### 命令表

| 命令 | 前端调用点(文件:行) | Rust(文件:行) | 成功场景 id | 备注/前置/owner |
|---|---|---|---|---|
| `qbank_list_authoring_drafts` | `src/features/learning-hub/apps/views/ExamContentView.tsx:1976` | `src-tauri/src/commands.rs:1399` → `crates/dstu-qbank/src/qbank_authoring_service.rs:118` | `qbank.g3.authgen.list_get_commit_imported_json`、`qbank.g3.authgen.two_drafts_then_commit_newest`（另外两个场景里作为"提交后变空"的状态断言） | 前置：草稿由 `import_question_bank`（json，无需 LLM）产生；只列 `ready/needs_review/partial`，`committed` 后不再出现；`ORDER BY created_at DESC,id` |
| `qbank_commit_authoring_draft` | `src/components/ExamSheetUploader.tsx:802`、`src/components/AiQuestionGenerationPanel.tsx:415` | `src-tauri/src/commands.rs:1362` → `qbank_authoring_service.rs:236/252` | `qbank.g3.authgen.list_get_commit_imported_json`（全选提交）、`qbank.g3.authgen.commit_subset_only`（子集提交，partial=true）、`qbank.g3.authgen.two_drafts_then_commit_newest` | 前置：`expectedVersion` 必须等于当前 draft version（新建草稿=1）；成功后 job 置 `committed`、exam 置 `completed`；同一 job 同选择重复提交幂等（未单列场景） |
| `qbank_get_authoring_draft` | `src/features/learning-hub/apps/views/ExamContentView.tsx:1989` | `src-tauri/src/commands.rs:1387` → `qbank_authoring_service.rs:108` | `qbank.g3.authgen.list_get_commit_imported_json`、`qbank.g3.authgen.two_drafts_then_commit_newest`、`qbank.g3.authgen.commit_subset_only`（提交后读已 committed 草稿） | jobId 取自 list/import 返回值；未知 job 是错误分支（W-L14），未写 |
| `qbank_resolve_authoring_route` | `src/components/ExamSheetUploader.tsx:431` | `src-tauri/src/commands.rs:1468` → `crates/dstu-llm/src/llm_manager/question_authoring.rs:137` | `qbank.g3.authgen.route_text_model_no_vision`（requiresVision=false）、`qbank.g3.authgen.route_multimodal_vision`（多模态模型 + requiresVision=true） | 前置：`save_api_configurations`（L02）。显式 `modelConfigId` 只要求 enabled 且非 embedding/reranker/image-generation。requiresVision=true 且主模型非多模态 → 走 `resolve_visual_fallback`（`question_authoring_runner.rs:770`），需要 `ocr.available_models` 里已启用多模态引擎，runner 无对应 setup 命令，故该分支只写"主模型本身多模态"的可确定成功路径 |
| `qbank_get_source_images` | `src/components/ImageCropDialog.tsx:86` | `src-tauri/src/commands.rs:8516`（`examId`，读取 `metadata_json.source_image_hashes`，回退 `preview_json.pages[].blob_hash`） | 可运行：`qbank.g3.authgen.source_images_empty_exam`、`qbank.g3.authgen.source_images_empty_imported_exam`（均返回 `[]`）；真实数据：`qbank.g3.authgen.pending.source_images_and_crop_from_imported_page` | 真实图片必须存在 exam 的 pages/blob 且在 VFS 磁盘上，只能由图片导入管线产生 → pending（见下"需要的外部输入"）。空数组是合法成功路径 |
| `qbank_crop_source_image` | `src/components/ImageCropDialog.tsx:189` | `src-tauri/src/commands.rs:8610`（解码→裁剪→PNG→`VfsBlobRepo::store_blob`+`VfsFileRepo::create_file`→追加到 question.images） | 仅 `qbank.g3.authgen.pending.source_images_and_crop_from_imported_page`（第 4 步） | 必须有真实可解码的源图片 blob（`request.blob_hash` 指向 blobs 表且文件在盘上）与已存在的题目 → 依赖 pending fixture，可运行集无法构造（runner v0 无临时文件/DB seed 写入口） |
| `qbank_ai_generate_questions` | `src/hooks/useQbankAiGeneration.ts:95` | `src-tauri/src/qbank_generation.rs:17` → `crates/dstu-qbank/src/qbank_generation/mod.rs:42`（先 `resolve_question_authoring_config`，再 `create_task` 后 `background_tasks::spawn`，立即返回 task 视图） | 可运行：`qbank.g3.authgen.generate_submit_get_list_cancel`、`qbank.g3.authgen.generate_minimal_request_defaults`（省略 max_questions/specs 走默认）；pending：`qbank.g3.authgen.pending.generate_completed_authoring_draft` | 可运行场景 baseUrl=`http://127.0.0.1:9/v1`（discard 端口），提交后返回 `status:"queued"`；**后台任务随后必然 failed，属预期**。返回值 `status`/`error`/`finishedAt` 与 `qbank_generation_tasks` 行状态取决于后台调度时机（queued/running/failed/cancelled 之一），等价比较时属于 normalize 候选（本包未启用） |
| `qbank_get_generation_task` | `src/hooks/useQbankGenerationTasks.ts:106`、`src/features/chat/plugins/blocks/qbankQuestionsBlock.tsx:81` | `src-tauri/src/qbank_generation.rs:28` → `qbank_generation/mod.rs:233` | `qbank.g3.authgen.generate_submit_get_list_cancel`（真实 taskId）、`qbank.g3.authgen.generation_unknown_ids`（未知 id → `null`） | 未知任务返回 `Ok(null)`，是成功路径；同样受后台状态时机影响 |
| `qbank_list_generation_tasks` | `src/hooks/useQbankAiGeneration.ts:70` | `src-tauri/src/qbank_generation.rs:38` → `qbank_generation/mod.rs:247`（`limit.unwrap_or(20).min(100)`） | `qbank.g3.authgen.generate_submit_get_list_cancel`（limit=10）、`qbank.g3.authgen.generate_minimal_request_defaults`（省略 limit 走默认 20）、`qbank.g3.authgen.generation_unknown_ids`（空数组） | 未建任务 / 未知 exam → `[]` |
| `qbank_cancel_generation_task` | `src/hooks/useQbankAiGeneration.ts:120` | `src-tauri/src/qbank_generation.rs:49` → `qbank_generation/mod.rs:263` | `qbank.g3.authgen.generate_submit_get_list_cancel`（真实 taskId：未终态则置 cancelled 并返回取消前视图）、`qbank.g3.authgen.generation_unknown_ids`（未知 id → `null`） | 已终态任务只回读不报错；返回视图是"取消动作之前"的快照，故其 `status` 可能是 queued/running/failed，属 normalize 候选 |
| `qbank_get_source_page` | `src/components/QuestionSourceViewer.tsx:131` | `src-tauri/crates/dstu-qbank/src/qbank_source_view.rs:339`（`get_source_page_with_conn` :210；VFS 文件兜底 :110） | `qbank.g3.authgen.source_page_vfs_text_file`（page=null 与 page=1 两种入参） | 走的是 `qbank_sources` 缺失时的 `files` 兜底分支：`sourceId` = `dstu_create` 建出的 `file_*`。真实 `qbank_sources` 页图路径的 `qsource_*` id 由 commit 内部生成、不出现在任何命令返回值里，runner v0 只能整值引用，故只能随图片导入 pending 场景验证（同一 pending 文件里 body 已含源页，后续补一条 `qbank_get_source_page` 只需把 `${2.0.blobHash}` 换成源 id，待 runner 支持从 SQL/seed 取 `qbank_sources.id`） |

##### 跨域 setup 命令（不在本文件 `commands` 里）

| 命令 | owner lane | Rust 文件:行 | 用途 |
|---|---|---|---|
| `import_question_bank`（format=json） | L14-qbank（导入分组，非本组） | `src-tauri/src/commands.rs:1088` → `crates/dstu-qbank/src/question_import_service.rs:2937`（`import_json_directly` → `save_draft` :557） | **无 LLM** 地产生真实 authoring 草稿（`qbank_import_jobs` 行 + `exam_sheets` + `draft_job_id/draft_version/draft_document`），是 list/get/commit 的唯一可运行前置 |
| `qbank_create_question` | L14-qbank（题目 CRUD 分组） | `src-tauri/src/commands.rs:7705` | pending 场景里给已导入的图片题目集挂一道题，供 crop 使用 |
| `dstu_create`（type=exam） | L13-vfs-api | `crates/dstu-vfs/src/dstu/handlers.rs:727`，exam 分支 :1097 | 建空题目集（AI 出题 / route / 空源图 / source page 的 exam_id） |
| `dstu_create`（type=file, `fileBase64`+`metadata.mimeType`) | L13-vfs-api | `crates/dstu-vfs/src/dstu/handlers.rs:1208`（files 分支） | 造一个真实 VFS 文件行，给 `qbank_get_source_page` 的 `files` 兜底分支当 `sourceId`（文本内容见下） |
| `save_api_configurations` | L02-llm-manager | `src-tauri/src/commands.rs:2150` | 写 `ApiConfig`（`baseUrl` / `isMultimodal` / `enabled`），route 与 AI 出题共用 |

##### 需要的外部输入（pending）

1. `${fixture.qbank_page_png_base64}` —— 一张 1×1 PNG 的 **base64 文本**（`import_question_bank` 的 `content`，`format:"png"`）。内容逐字为：

```
iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==
```

   该图被图片导入管线写入 `blobs`/`exam_sheets.preview_json.pages[].blob_hash` 后，`qbank_get_source_images` 才能返回真实 `blobHash/dataUrl`，`qbank_crop_source_image` 才有可解码的源 blob（1×1 → 裁剪比 0..1 全部落在合法边界内，`crop_width=1.0` 得到 1×1 PNG）。

2. `${provider.url}` —— 脚本化多模态 LLM（pending-provider 约定）。需覆盖两条路径：
   - 图片导入（`format:"png"`）：返回一个合法 QuestionDocument v2 根对象（`schema_version:2`、`mode:"extract"`、`questions[].local_id/content/question_type/answer`），且 `coverage` 必须覆盖该图片的唯一边界页 `{source_id: <prompt 参考资料清单里的 source_id>, page: 1, status: "processed"}`，否则 `validate_coverage`（`question_authoring_runner.rs:795`）会拒绝；
   - AI 出题（`qbank_ai_generate_questions`）：返回同样合法的 `mode:"generate"` 文档（含 `coverage: []`）。pending 出题场景的第 3/4 步（`qbank_get_generation_task` + `qbank_list_authoring_drafts`）只有在 **runner 能把后台任务跑到终态** 后才有意义；当前 runner 无轮询/等待"任务不再 queued/running"的原语（`waitAfter` 只匹配 `eventType`/`type:phase`，而 `qbank_generation_task_event` 的 payload 是 GenerationTaskView，不含这两个字段），因此该 pending 场景需要 X3 支持"等待后台任务终态"或让 provider 响应足够快且在下一步前完成写入。

##### 统计

- 可运行场景：11 个（成功 11 / 错误 0），覆盖 10 条命令；每条目标命令至少 1 个成功场景（`qbank_crop_source_image` 除外，见下）。
- pending 场景：2 个（成功 2 / 错误 0），覆盖 3 条命令（`qbank_get_source_images`、`qbank_crop_source_image`、`qbank_ai_generate_questions`）。
- 覆盖命令数：11 / 11 写有成功场景（9 条可运行 + 2 条仅 pending 或含 pending）。唯一缺可运行成功场景的是 `qbank_crop_source_image`：需要真实源图片 blob + 已有题目，runner v0 无法在可运行集中构造（pending 已给完整链路）。
- 已知非确定性（建议后续加 normalize，本包按规范留空）：AI 出题后台任务的 `status`/`error`/`finishedAt`、`qbank_generation_tasks` 行状态、`qbank_cancel_generation_task` 返回快照状态。
