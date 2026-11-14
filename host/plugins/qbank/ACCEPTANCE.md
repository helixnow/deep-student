# L14-qbank 独立验收（R5-review-learning，2026-11-04）

## C1指定三原失败中的两条qbank复验（65f668842，2026-11-05）

固定正常main`65f6688428603d219a3c8c2e2577a4685a0c0734`，实际fixture修复34402a1ff已为祖先。`practice.test.ts`改用真实vfsRepo.exams，不再new缺cascade resolver的裸ExamRepo；`authoring-copy.test.ts`装真实vfsRepos+qbank。vfs-repos/index.ts:67的ExamRepo resolver读取qbank.examCascade，qbank/index.ts:253-257提供真实copy/softDelete/restore仓储方法。原测试断言未删改；practice仍有原llm/mastery占位，本次纸张路径不据此签批改/模型链，authoring-copy用实际公开exam仓储配合生产authoring helper，不冒称全kernel命令。

独立job **20261105104219-4c2d52**：三个指定文件联合完整标题筛选，**3files/3pass/15标题过滤skip、31.81s、原始exit0，无Errors/Unhandled/FAIL或Warning段**。其中本域`papers_keep_answers_when_export_hides_them_and_restore_with_the_exam` **4304ms**、`canonical_copy_preserves_materials_and_structured_data_and_restore_preserves_prior_deletions` **3403ms**。前者保文档答案A、加载1题、考试删除后拒读、恢复后1题；后者保copy两题、材料/structured42/新group身份，单题先删再考试删/恢复后该题仍null、另一题live且SQL count=1。

首次job **20261105104122-b39d72**误用完整名锚定正则，实际0执行/18标题过滤、3files skipped、exit0，保留为筛选失配，不算通过或业务失败。随后仅纠正-t，未改实现/测试。三文件命令及translation范围详见聚合报告；不使用供方332/96或旧fulltest红作此main结论，不签完整qbank/Value/20:00全测或ledger指标。报告提交后按§5执行最终tip门禁。

结论：不通过

初审基线：`f23c98702`。实现、测试、SPEC、TESTMAP 均未修改，未编译或运行 Rust。本目录原无 ACCEPTANCE。历史证据保留；最新为正常main基线 `8318071b1` 的Q1真实owner组合探针，见文末。“通过”仅确认列出的抽查行为，不代表整条命令或整lane严格等价。

## 必须修复

- [ ] **Q1 / main答题、改判和客观题practice真实学习链已独立通过；剩余范围明确保留。** `8318071b1`上两个Node生产入口探针安装真实notes/vfs-repos/review/memory/qbank，验证错答建计划、到期答对推进、不重复mastery、未到期不推进、改判建计划、practice重放及同事务失败回滚，均exit0。此前三次错答→learner_profile弱点证据继续有效，不能再称这些主链仅由reviewPlan替身证明。未决限定为`review-plan-effects.ts:32-33,50-51`缺provider仍静默跳过，以及主观题后台批改/人工批改的真实owner组合未在这两个探针中验证；不外推整项签收。
- [ ] **Q2 / main已修取消错误、重试和CommandError解包；传输仍有差异。** `src/llm-completion.ts:95-158`取消返回complete错误、maxRetries=0，非流式回退不再作为成功；`src/llm-grader.ts:31-37`解包CommandError，本轮取消前已收到verdict及配置错误回归通过。但24小时总时限仍不等于Rust无总时限；非流式请求已由L02发出后才拒绝；reasoning_chars改为0而非Rust实际字符数，http_status仍固定200。已修子项认可，完整传输不签收。
- [ ] **Q3 / 命令取消调用与日志已补，runner登记仍缺。** `ec6adc071`→`21a99cc47:index.ts:618-636` 按Rust顺序requestCancelStream→cancelGenerationSession→markCancelled并返回旧快照，missing/terminal/request日志及submit override warn均已补。登记表只有测试调用registerGenerationSession，未有生成runner生产者（`src/generation-session.ts:1-28`、`tests/generation-tasks.test.ts:74-110`）；因此认可命令层修复，不签完整生成取消闭环。（事实更新：此后生成 runner 已接线，`src/generation-runner.ts` 的 `runQbankGeneration` 在同一 `GenerationSessions` 登记 token；本条结论待复核。）
- [x] **Q4 / main复验签收：原两处分支已修。** `d414183bf:src/question-service.ts:196-221,240-258` 单项读取进入catch，update业务错误恢复Database包装，对齐Rust `question_bank_service.rs:329-334,399-416`。本轮全目录独立作业退出0，包含真实命令批量部分失败用例；错误分支结论另有逐分支静态对照，不外推未注入的SAVEPOINT控制语句故障。
- [x] **Q5 / main复验签收：键序和Array/Object区分均已修。** 当前 `src/question-service.ts:140-156` 任一值为数组即进入数组分支，只有两者皆数组才可能相等。`tests/questions.test.ts:201-241` 经真实命令覆盖键序、`[]→{}`、`[1]→{"0":1}`及历史写入，本轮独立全目录通过；对齐Rust `question_bank_service.rs:1685-1698`。
- [ ] **Q6 / 两个原测试覆盖已补齐，lane整体覆盖未闭合。** `9b7f9fdf1`→`21a99cc47` 将两行改为本lane `mastery-correction-contract.test.ts` 的原名ported，用真实review/mastery与生产迁移库补齐首判返回值、链长1/2及false→true→true同向重放。静态确认原两个“合并目标缺断言”子项已修，不再沿用旧描述。候选实际167 ported/74 pending/0 merged，声明76/88命令；Q6整体仍未成立。merged无需审批的纠正继续有效，本轮未跑未集成候选（详见文末）。
  最新main补充：`crop-source-image.test.ts:23-34`fixture只装qbank/vfsRepos，未安装native插件或provide nativeImage；`:55-57`因此仍skip并误标“能力未main”，而F7方法已main。该跳过不能证明真实crop链；需由owner补真实F7装配，保留原断言，见最新诊断章节。
- [x] **Q7 / main复验签收：独立全目录已有干净运行证据。** 作业 `20261104105734-fb823a`：37文件通过，241 passed/2 skipped，exit0，无Errors/Unhandled；348.61s。两项跳过是F7图像能力缺口，明确保留在完整性限制中；签收的是原“无干净运行证据”阻塞，不代表跳过功能完成。此前失败证据保留历史。
- [ ] **Q8 / main已迁移大部分题目写入，仍有跨所有者SQL。** 当前 `src/question-service.ts:52-56,114-128,196-258`使用L11公开QuestionRepository及同连接事务；不能再称CRUD/历史/提交全部重复。仍有 `repository/questions.ts:517-541`直接UPDATE questions的hash/sync/AI字段，生产 `src/grading-service.ts:205-219`调用；FTS写入亦仍在`:450-457`。按v2单写者未闭合。crop/paper已移除直接sharp，改F7接缝；图像缺口对应两项skip，不能签功能完成。Rust复用QuestionRepo的原证据及旧代码行号保留在历史章节。
  最新main运行增量：F7图像编码方法已合入，DOCX原skip现在执行失败；独立逐阶段probe确认decode成功、encode缺`pngjs`。这是提供方编码运行依赖缺口，不能误报坏PNG或Rust解码差异，也不能据方法存在签图像链。

## 建议

- [ ] 将 `index.ts:304-407` 的队列/定时器编排移至 `src/`，入口保持接线职责。

## 已核实通过

- [x] 复核确认：16 条 ported 抽查均调用生产函数，下面逐条列出对应断言；没有用测试替身实现答案判定。
- [x] 复核确认：native import 与 wiring 命令成功；wiring 报 137 ported、未接入 0。它证明模块导入图，不证明 Q1/Q2 的调用链完整。
- [x] 复核确认：抽查 CRUD 的 SQL 位于 `repository/`；`exam_sheets`/索引副作用通过对方 `api.ts` 定义的端口（`src/ports.ts:7-20`）；服务提供名 `qbank` 符合架构规范（`index.ts:106,230`）。生产文件检索未发现 `console.*` 调用或测试目录导入。**题目表所有权不通过，见 Q8。**

## 命令等价抽查（18 条）

下表 TS 路径均以 `host/plugins/qbank/` 为根；Rust 的 `commands.rs` 指 `src-tauri/src/commands.rs`，`service.rs` 指 `src-tauri/crates/dstu-qbank/src/question_bank_service.rs`。

| 命令 | 结论与已检查行为 | TS 证据 | Rust 对照 |
|---|---|---|---|
| qbank_list_questions | 通过：缺省 1/50，页码下限 1，页大小 1–100 | index.ts:255；repository/questions.ts:303-335 | commands.rs:7555-7585 |
| qbank_get_question | 通过：不存在返回 null | index.ts:263；src/question-service.ts:82 | commands.rs:7676-7685 |
| qbank_get_question_by_card_id | 通过：exam/card 双定位，Option→null | index.ts:265；src/question-service.ts:85 | commands.rs:7690-7700 |
| qbank_create_question | 通过：创建后刷新统计；刷新失败 warn 后返回题目 | src/question-service.ts:99-109 | commands.rs:7705；service.rs:183-197 |
| qbank_batch_create_questions | 通过：空列表返回 []，按 exam 刷统计 | src/question-service.ts:111-123 | commands.rs:7719；service.rs:201-226 |
| qbank_update_question | 问题 Q5；record_history 默认 false 和状态变化才刷统计正确 | index.ts:271；src/question-service.ts:126-159 | commands.rs:7733-7754；service.rs:239-272,1685 |
| qbank_batch_update_questions | 问题 Q4；单项 SAVEPOINT、整批事务存在 | src/question-service.ts:163-188 | commands.rs:7765；service.rs:282-351 |
| qbank_delete_question | 通过：先读 exam、删除后尽力刷统计；unit→null | index.ts:275；src/question-service.ts:192-203 | commands.rs:7779；service.rs:355-371 |
| qbank_batch_delete_questions | 问题 Q4：单项读取异常变整批失败 | src/question-service.ts:206-235 | commands.rs:7790；service.rs:378-432 |
| qbank_submit_answer | 问题 Q1；显式 regrade 分支及空白 submission id 分流已核对 | index.ts:279-286；src/question-service.ts:367-461 | commands.rs:7818-7850；service.rs:573-714,962-1027 |
| qbank_get_history | 通过：可空 limit 下传 | index.ts:295；src/question-service.ts:256 | commands.rs:7911-7921 |
| qbank_get_submissions | 通过：limit 缺省 20 | index.ts:297；src/question-service.ts:259 | commands.rs:7926-7936 |
| qbank_reset_progress | 通过：重置、同步标记/hash、删除提交、刷统计同事务 | src/question-service.ts:263-272 | commands.rs:7941；service.rs:1725-1782 |
| qbank_reset_questions_progress | 通过：空输入、逐题 savepoint、统计错误计入 errors | src/question-service.ts:275-303 | commands.rs:7955；service.rs:1793-1917 |
| qbank_get_generation_task | 通过：null/视图隐藏请求正文 | index.ts:239-245 | src-tauri/src/qbank_generation.rs:28；crates/dstu-qbank/src/qbank_generation/mod.rs:233-243 |
| qbank_list_generation_tasks | 通过：默认20、最大100，0保留 | index.ts:247-252 | src-tauri/src/qbank_generation.rs:38；crates/dstu-qbank/src/qbank_generation/mod.rs:247-259 |
| qbank_cancel_generation_task | 问题 Q3；旧状态返回形状正确 | index.ts:492-499 | src-tauri/src/qbank_generation.rs:49；crates/dstu-qbank/src/qbank_generation/mod.rs:263-300 |
| qbank_retry_practice_grading | 问题 Q2：注册后无可用补全实现 | index.ts:396-400；src/llm-grader.ts:77-85 | src-tauri/src/qbank_practice.rs:102-109；crates/dstu-qbank/src/qbank_grading/pipeline.rs:61 |

## 测试真实性抽查（16 条 ported）

前14项 Rust 均为 `src-tauri/crates/dstu-qbank/src/question_bank_service.rs`，TS 均为 `host/plugins/qbank/tests/answer-correctness.test.ts`；TESTMAP 对应 `:164-177`。

| Rust 测试名 | Rust 行 / TS 行 | 结论、实际断言 |
|---|---|---|
| test_single_choice_basic_and_case_insensitive | 3684 / 5 | 通过：A/a/B 三向 |
| test_single_choice_answer_with_option_text | 3700 / 10 | 通过：选项全文、中文答案前缀 |
| test_multiple_choice_order_and_missing | 3725 / 15 | 通过：乱序、漏选、多选 |
| test_multiple_choice_answer_with_option_text | 3748 / 21 | 通过：AC 与 A |
| test_fill_blank_always_ai_graded | 3760 / 25 | 通过：任意答案仍待人工/AI |
| test_subjective_needs_manual_grading | 3779 / 31 | 通过：简答、证明 |
| test_missing_answer_needs_manual_grading | 3791 / 35 | 通过：null、空白答案 |
| test_extract_choice_keys_conservative | 3800 / 39 | 通过：词内字母不误取、全角 |
| test_fullwidth_normalization_in_judging | 3824 / 53 | 通过：全角选择与填空分流 |
| test_true_false_lenient_parsing | 3860 / 61 | 通过：非法用户值/非法标准值区分 |
| test_numeric_tolerance_and_lenient_input | 3898 / 71 | 通过：绝对/相对容差、单位、分数 |
| test_ordering_strict_order | 3957 / 84 | 通过：顺序、长度、无标准顺序 |
| test_matching_pair_set_equality | 3993 / 92 | 通过：集合相等与重复配对 |
| test_fill_blank_structured_multi_blank_always_ai_graded | 4055 / 105 | 通过：structured blanks 不直接判分 |
| status_roundtrip_and_terminal | task_repo.rs:378 / generation-tasks.test.ts:13 | 通过：五种状态和终态布尔 |
| view_omits_request_json_and_stream_event | task_repo.rs:396 / generation-tasks.test.ts:24 | 通过：调用 taskView 后检查字段省略 |

最后两项 Rust 完整路径：`src-tauri/crates/dstu-qbank/src/qbank_generation/task_repo.rs`；TS 完整路径：`host/plugins/qbank/tests/generation-tasks.test.ts`；TESTMAP `:39-40`。obsolete 为0项；merged 两项无需审批，但须证明实际覆盖，见 Q6 增量复核。

## 亲自运行（原始输出摘要）

```text
$ npx vitest run -c vitest.host.config.ts host/plugins/qbank
Test Files  21 passed (21)
Tests       169 passed (169)
Errors      8 errors
Duration    129.56s
Error: [vitest-worker]: Timeout calling "onTaskUpdate"
exit 1

$ npx vitest run -c vitest.host.config.ts host/plugins/qbank --maxWorkers=1
Test Files  21 passed (21)
Tests       169 passed (169)
Errors      4 errors
Duration    119.10s
Error: [vitest-worker]: Timeout calling "onTaskUpdate"
exit 1

$ node scripts/electron-migration/wiring.mjs --lane qbank
合计 ported 137，其中所测模块未从 index.ts 接入 0（0.0%）
```

`node scripts/electron-migration/importable.mjs` 对四个指定入口一次调用（包含 `host/plugins/qbank/index.ts`），原始输出 `importable: ok`，退出0。重启前的另一次限 worker 运行被服务器取消，未计为通过。测试使用测试文件创建的临时数据库，未访问正式数据目录。

## 协调者指令1：Q6 定向纠正与覆盖复核

先执行 `git merge --no-edit main`，得到 `4b9c2809b`（合入的 main 父提交 `35b4fbfdf`）。本轮未改实现/测试/TESTMAP，未改独立验收勾选。

| 原 Rust 用例 → TESTMAP 指定目标 | 原断言覆盖复核 |
|---|---|
| `false_to_true_correction_recomputes_state_and_breaks_first_verdict_lock` → `qbank_verdict_correction_false_to_true_recomputes_state` | 核心行为有覆盖：同键首判锁定、0.35→0.65、total/wrongCount/streak、旧事件wrong不改且tombstone、r1 correct/weight1存活（Rust `src-tauri/tests/mastery_qbank_correction.rs:130-185`；TS `host/plugins/review/tests/mastery.test.ts:70-81`）。仍缺原首判返回值的 total/score 断言，以及锁定后链长1、纠正后链长2（Rust `:122-127,146,186`）；目标未查询链总行数。不是完整等价合并。 |
| `correction_same_direction_replay_is_idempotent` → `qbank_verdict_correction_is_idempotent_and_supports_reflip` | **关键序列缺失**：Rust 首判wrong→纠正true→再次纠正true，断言0.65/total1/wrong0、链仍2且r1仍存活（`:203-237`）。TS重复的是初始false，然后true后直接false重翻（`:86-93`）；没有“纠正为true后的同向重放”，不能用false重放/reflip代替原不变量。 |

真实入口是 review 插件 `index.ts` 提供的 `host.ctx.mastery`，目标测试 `mastery.test.ts:10-15` 使用真实 storage 和生产 mastery 服务；这里的问题是缺断言/缺场景，不是替身。

亲自运行（同时覆盖 R2 新用例，退出 **0**）：

```text
npx vitest run -c vitest.host.config.ts host/plugins/review/tests/fsrs-commands.test.ts host/plugins/review/tests/mastery.test.ts -t 'review_service_exposes_agent_scopes_and_review_statistics|qbank_verdict_correction_false_to_true_recomputes_state|qbank_verdict_correction_is_idempotent_and_supports_reflip' --maxWorkers=1 --no-file-parallelism
Test Files  2 passed (2)
Tests       3 passed | 11 skipped (14)
Duration    4.91s
exit 0
```

11 skipped 来自 `-t` 定向过滤，未修改 skip/断言。两个目标测试通过不能补足源码中不存在的断言。此次是小范围 Linux Node 验证；不关闭 Q7（上轮完整目录运行RPC错误仍未消除）。212断言运行的新增原始事件核实情况见下节，不采用实现者“2 RPC告警、非失败”的定性。

## Q7补充证据：Vitest退出码被管道掩盖

来源：C1协调者补充指令，已只读核实L14原始工具事件；**不是R5亲自新增运行，也不是实现者报告自述**。记录事件显示时间12:16:17（不推定其时区），启动命令为：

```sh
npx vitest run -c vitest.host.config.ts host/plugins/qbank 2>&1 | tail -40
```

未启用pipefail。协调者核实的原始输出关键行：

```text
Vitest caught 2 unhandled errors
Tests 212 passed
Errors 2 errors
```

- 外层shell退出0来自管道末端 `tail`，不能证明Vitest成功；**Vitest自身退出码未知，不从Errors行反向猜测具体值**。
- 更早一次171断言运行使用 `| tail -15`，输出有5 errors，同样不能凭管道状态判定Vitest成功；该次Vitest自身退出码也未获可追溯证据。
- “unhandled errors / Errors”须原样保留，不能改称普通warning或“非失败”。L14应纠正其报告；R5写权限只涵盖验收文件与汇总，本次未修改L14的实现者报告。
- Q7保持未勾选，Q/R资源超时仍为验证阻塞，未据此认定业务断言错误。下次修复验证直接运行Vitest；如需管道过滤，必须启用 `set -o pipefail` 或明确捕获 `PIPESTATUS[0]`，并保留完整Errors与退出状态证据，不能只凭tail摘要报绿。
- 本次无新增测试运行、无断言/skip修改；也无新增跨平台验证。

## 语义差异与覆盖缺口（初审快照）

- 缺陷：Q1–Q5、Q8；SPEC 已登记的“待接线”仍是未完成实现，不是获准的平台差异（`SPEC.md:21-28,386-390`）。
- 已登记平台差异：`docs/dev/electron-migration/decisions.md:52-59` 的 JS 毫秒时间精度；本 lane 使用 `repository/questions.ts:5,20-21` 平台时间函数。没有据此豁免业务取消、事务或日志。
- 缺命令：`cancel_question_bank_import`、`cancel_questions_csv_import`、`export_questions_csv`、`get_csv_preview`、`get_enhanced_statistics`、`get_exam_sheet_session_detail`、`get_learning_heatmap`、`import_question_bank`、`import_question_bank_stream`、`import_questions_csv`、`inspect_pdf_text_for_qbank`、`list_exam_sheet_sessions`、`list_importing_sessions`、`qbank_ai_generate_questions`、`qbank_ai_grade`、`qbank_cancel_grading`、`qbank_complete_paper_export`、`qbank_crop_source_image`、`qbank_export_paper_docx`、`qbank_resolve_authoring_route`、`rename_exam_sheet_session`、`resume_question_import`、`update_exam_sheet_cards`。逐名对比契约 commands 与入口清单，不采信实现进度自述。

## C1 07:19Z：`21a99cc47` Q1–Q6定向复核

### 基线与提交定位

本轮从 `dd4e93150` 正常合并main，运行基线为 `2f65ad2c6`（main父提交 `679fd3e4d`）。L24 `b0ba8b75b`已在该基线；L14 `21a99cc47` **未进入main/HEAD**，因此L14只读候选对象，未摘实现、未搭混合工作树、未用旧代码测试证明新提交。下述TS行号均指 `21a99cc47:host/plugins/qbank/`；不重复运行C1已明确带Errors的文件。

| 编号 | 实现提交/累积快照 | 已核实增量与真实路径 | 当前结论 |
|---|---|---|---|
| Q1 | `78b602870`等→`21a99cc47` | index.hostOf/practiceHostOf取reviewPlan；question-service事务内requireMastery，提交后ensure/advance；practice-service`:293-305`提交后同样回流 | 省略的调用链已补。学习闭环测试使用端口替身验证调用与无mastery回滚，不是完整L15计划持久化集成。 |
| Q2 | `33a4fa3dd`等→`21a99cc47` | index`:410-425,647-653`接llm/llmStreaming/vfsRepo；llm-grader取图→配置→singleShot→verdict | 虚构gradePracticeSnapshot及图片必失败已移除；取消、singleShot隐式策略、诊断语义仍有缺陷，见下。 |
| Q3 | `ec6adc071`→`21a99cc47` | index`:618-636`真正调用LLM取消及本lane token取消后才落库；generation-session按key remove+cancel | 命令分支/日志修复确认；registerGenerationSession仅测试调用，生成runner未登记，不能证明在途生成被终止。 |
| Q4 | `945c9ca04`→`21a99cc47` | question-service`:198-205,241-252`读取错误逐项收集、业务更新失败带Database文案 | 原两个定位问题静态修复；未新增候选运行，原勾选保留。 |
| Q5 | `945c9ca04`→`21a99cc47` | question-service`:137-169`结构比较；questions.test.ts`:201-223`经真实命令验证嵌套键序重排无历史 | 键序缺陷修复，但Array/Object类型混同新问题未修，见下。 |
| Q6两原测试 | `9b7f9fdf1`→`21a99cc47` | tests/mastery-correction-contract.test.ts真实storage迁移+review插件+host.ctx.mastery | 原缺断言及false→true→true序列已齐；不再沿用“仍只有merged旧目标”的描述。lane另有74 pending/12缺命令，不整项签收。 |

### Q1：提交边界保留，实际消费范围仍需区分

客观答案在 `question-service.ts:436-438` 把同一tx传给requireMastery；缺服务抛错发生在事务内。答错/答对计划操作在事务返回后（`:441,472-479`），改判为错也在提交后（`:504-510`）；对应Rust `src-tauri/crates/dstu-qbank/src/question_bank_service.rs:645-714,981-1003`。新测试 `tests/submit-learning-loop.test.ts:85-148`验证错题创建、到期推进、未到期不推进、改判及无mastery回滚；`:27-45`的reviewPlan/mastery是测试端口，不能据此签真实跨插件计划写入。

L15已有reviewPlan候选provider，不再把“无provider”列为永久阻塞；`index.ts:74-77`旧注释仍过时。当前缺服务时helper直接return，不能证明实际profile中该步发生；需在正常集成版本上验证真实提供方，而非再要求L11包装整个mastery事务。

### Q2：传输接线成功不代表旧Rust语义已保留

1. **取消可落成成功练习判分（高）。** `llm-completion.ts:107-123,138-140`调用 `stream.complete(true,null)` 后丢掉它返回的取消错误，返回 `error:null`。`llm-grader.ts:112-122`只检查result.error，若取消前feedback已有合法verdict则返回成功；`practice-grading-queue.ts:161-190`直接按response.ok写正式判分，没有检查cancelled诊断。Rust `qbank_grading/stream.rs:151-155`产生取消Err，`pipeline.rs:124-129,1289-1291`传播失败。普通AI命令另有diagnostics.cancelled分支（`grading-service.ts:402-411`），不能替代practice路径。此为静态可达分析，本轮未运行候选。
2. **默认重试/非流式回退/总时限改变。** `llm-completion.ts:112-115`只覆盖headerTimeout，其余沿用 `defaultSingleShotOptions`：maxRetries=2、20分钟total、32MiB等（同候选 `host/plugins/llm/src/single_shot_stream.ts:36-68`），`runSingleShot:875-895`还会回退nonStream/重试。Rust `qbank_grading/pipeline.rs:1172-1212,1243-1262`正常provider单请求、HTTP错误即终止、120秒idle，只有Codex特定refresh路径；不能默认为同一策略。
3. **诊断单位/状态被近似映射。** `llm-completion.ts:125-134`强写http_status=200、reasoning_chars=reasoningBytes并将正常singleShot返回视为DONE。L02累计reasoningBytes用UTF-8字节（同候选 `single_shot_stream.ts:347-348`），Rust grading按字符计数；中文推理至少单位不一致。原分状态机需保留，不能以返回聚合正文代替所有终态证据。
4. **21a99cc47错误修复不是全链通用。** 该提交仅给 `authoring-route.ts:35-46,81-95` 的LLM配置调用增加CommandError.value解包。practice的 `llm-grader.ts:30-35,92-96`仍只认appError/error_type、不认value，LLM配置的CommandError可被扁平化成LLM错误。`llm-completion.ts:94-98`也没有value解包。认可authoring路由的准确修复，不把它推导为所有批改错误已透传。

`tests/llm-grading-transport.test.ts:72-140`用传输边界替身断言映射，取图测试`:143-197`验证模型收到图片parts（VFS附件读取为替身）。这些比旧固定失败路径有进展，但取消用例`:118-119`恰好断言error=null，没有覆盖“取消前已有verdict不得落正式成绩”。

### Q5：结构比较的新类型遗漏

候选 `structurallyEqual` 仅在“两者都是数组”时检查元素；否则任意两对象比较keys。`[]`和`{}`的keys同为空，于是相等；`[1]`和`{"0":1}`亦会混同。structured_data契约为任意JSON值（`contracts/ipc/generated/L14-qbank.ts:80,446`等），是可达输入而非不支持类型。Rust `serde_json::Value` 的Array/Object不同，`question_bank_service.rs:1685`应记录变化；候选会漏历史。新键序回归测试不覆盖此分支，Q5保持开放。

### Q6：逐条核对原测试覆盖

| Rust `src-tauri/tests/mastery_qbank_correction.rs` | 新TS `tests/mastery-correction-contract.test.ts` | 静态判定 |
|---|---|---|
| `false_to_true_correction_recomputes_state_and_breaks_first_verdict_lock`，`:105-186` | `:56-94`；真实服务入口`:24-31` | 首判total/wrong/0.35，record true仍锁定且链长1，纠正0.65/total1/wrong0/streak1，base tombstone且outcome仍wrong，r1 correct/weight1/live，最终链长2，原关键断言齐全。 |
| `correction_same_direction_replay_is_idempotent`，`:196-237` | `:97-119` | 首判false，纠正true后再次true，score/total/wrongCount和链长2不变、r1仍存活；原缺失的同向重放已真正加入。 |

TESTMAP`:247-248`已映射为两个原名ported，merged=0；本轮静态确认这些覆盖子项已修。候选总计 **167 ported/74 pending**；入口meta声明 **76/88命令**。仍缺12条：cancel_question_bank_import、cancel_questions_csv_import、export_questions_csv、get_csv_preview、get_exam_sheet_session_detail、import_question_bank、import_question_bank_stream、import_questions_csv、qbank_ai_generate_questions、rename_exam_sheet_session、resume_question_import、update_exam_sheet_cards。Q6整体保持未勾选。

### Q7/Q8及新架构边界

- C1本次交付的运行结果：**全目录231 passed、Errors8、exit1；定向65 passed、Errors2、exit1**。这是提供方证据，不是R5本轮运行；未附完整命令/flags不补造。两者均非干净通过，Q7开放，不以断言数增长抵消Errors，也不将RPC自动归因为业务断言失败。
- Q8重复题目仓储没有移除；L11题目所有者、L15mastery/reviewPlan、L18媒体面已有候选，按D1由qbank编排同一SqlExecutor给各所有者，不等L11替qbank包整段mastery业务。
- 候选直接 `import sharp`（`src/crop-source-image.ts:10`、`src/paper-docx.ts:9`）越过F7平台原生边界；依赖获准不等于业务插件可以直连。C1已派回，记录为Q8架构整改范围，不因命令新增就签通过。

本轮L14候选未集成，不提交运行作业。Q1–Q6已修子项认可，未决语义、Q7退出状态与Q8架构仍保留；所有验收勾选不变，未验证Windows/macOS/Electron。

## v2 main复验：`d414183bf`（2026-11-04）

正常merge main得到 `d414183bf`（main父提交 `eeaf5bdc7`），含 `21a99cc47` 及后续修复。本轮按实际源码复验，历史“候选未集成/不改勾选”限制不再用于此基线。Q4、Q5、Q7勾选签收，Q1/Q2/Q6/Q8部分修复认可，未外推整链。

独立作业 `20261104105734-fb823a`，命令：
`npx vitest run -c vitest.host.config.ts host/plugins/qbank --maxWorkers=1 --no-file-parallelism`

结果 **37文件、241 passed/2 skipped、348.61s、exit0，无Errors/Unhandled**；完整输出 `/home/dsdev/.oc-jobs/done/20261104105734-fb823a.log`。

- 历史门禁报错的 `submit_answer_wrong_thrice_writes_mastery_and_weak_point` 本轮2791ms通过，断言见 `tests/mastery-submit.test.ts:69-90`，实际检验数据库弱点回流；reparse目录9条亦通过。本轮结果不改写旧失败原因，未通过修改断言规避失败。
- Q4：生产逐项catch及Database包装与Rust已定位分支对齐。真实命令部分失败测试通过；没有把它声称为所有数据库故障注入覆盖。
- Q5：结构类型反例现由真实命令测试覆盖，本轮通过。
- Q6：`mastery-correction-contract.test.ts`两条生产mastery测试通过，原名/断言缺口签认修复。整体167 ported/74 pending及命令覆盖缺口仍在，所以Q6整项不勾。
- 两项skip原文分别为 `image_block_embeds_png_and_uses_rust_emu_sizing [nativeImage.resizeRgba/encode 未合入 main]`、`crops_relative_region_stores_png_and_appends_question_image [nativeImage.cropRgba/encode 未合入 main]`。全目录exit0是验证状态，不是这些路径完成。
- Q2取消及配置解包已修，但24h代替无限、非流式回退已发请求、推理字符数清零仍不严格等价；Q8剩余写入见顶部。Q3登记仍仅测试调用。

同基线 `typecheck:host` 作业 `20261104105733-20ca4e`、`migration:boundaries` 作业 `20261104105733-b3311b`、只读ledger `20261104105733-5c57be` 均exit0。边界扫描2382文件，0 violation/178 suppressed；机械通过不证明Q8单写者成立。未重复已完成测试，未运行Rust或跨平台桌面验收。

## Q1正常main真实owner最小组合复验（8318071b1）

新基线已集成L15 `reviewPlan`：`review/index.ts:115-138,170-176`发布真实服务，调用时解析L11仓储，传真实mastery。Qbank `index.ts:86-98`动态消费该服务（旧“L15尚未发布”的注释已过时）。原`tests/submit-learning-loop.test.ts:24-41`仍以reviewPlan/mastery替身测调用，因此本轮增加独立运行探针，填补这个具体证据缺口，没有重跑该替身用例。

两作业命令均为 **`node --input-type=module -e <完整JS源码>`**，由全局job submit执行；完整argv/源码保存在`/home/dsdev/.oc-jobs/done/<ID>.json`的cmd数组，stdout在同名.log。未写入或修改仓库测试文件；全部数据库来自`/tmp/opencode/r5-q1-owner-*`隔离目录，运行真实migrations，finally释放host/storage/logger并删除本次临时目录。宿主安装真实notes/vfs-repos/review/memory/qbank，paths/settings/log也用生产构造函数；业务服务无替身。仅用SQL准备exam、固定计划到期日及安装临时故障trigger，不复制业务实现。

| 独立作业 | 实际生产入口与关键断言 | 结果 |
|---|---|---|
| `20261104130347-5e7bf4` | `qbank_create_question` / `qbank_submit_answer` / `review_plan_get_by_question`：错答建持久计划；到期答对total_reviews/total_correct=1，review_history=1，mastery_events总计2而非重复记；未来计划答对不推进 | 4场景组全部通过，exit0 |
| 同作业 | 首判正确无计划，按原submission改错后有计划且answer_submissions仍1；mastery insert故障使submission/attempt_count/event全回滚且不建计划；review_plans insert故障则保留已提交答题/mastery并成功返回 | 同上 |
| `20261104130725-4cfab2` | `qbank_create_practice` / save / submit / get：wrong、due-correct、future-correct、unanswered四题混合，draft阶段无学习写入；提交后仅3个submission/mastery事件、1条review_history；同revision重放结果相等且所有计数不增加 | 2场景组全部通过，exit0 |
| 同作业 | 第二题mastery insert故障：前一题已经执行的question/submission/event写入也回滚；两题无计划，draft answers/revision保留，无已提交attempt | 同上 |

Rust对应：`question_bank_service.rs:650-707`同事务答题/mastery后提交、错题计划best-effort及到期正确推进；`:964-998`改判提交后计划；`review_plan_service.rs:215-226,333-336`练习推进不重复mastery；`qbank_practice.rs:401-566`批量提交后学习副作用。TS调用链：`question-service.ts:448-472,488-505`，`practice-service.ts:225-317`，`review-plan.ts:339-340,382-424`。

本轮没有宣称故障日志逐字载荷已被断言，也没有主观题LLM/人工批改组合证据；Q1已验证部分明确认可，其余限定如顶部。所有旧suite/RPC失败记录保持，不以这两个小探针替代统一门禁或Q2传输验收。

## 新main图像用例失败定位（644d2ddf6自检）

四目录作业`20261104132548-d523e6`结果：**2 files failed/130 passed/1 skipped；1 test failed/1399 passed/100 skipped；Errors1；430.36s；exit1**。Anki streaming beforeAll仍有10秒hook超时，另一个明确失败为本目录 `paper-docx.test.ts:39-55` 的 `image_block_embeds_png_and_uses_rust_emu_sizing`，报`Cannot decode paper image`；RPC onTaskUpdate另记Unhandled Error1，不混为图片失败原因。

### 独立定位到encode依赖，非decode

- `paper-docx.ts:76-90`捕获decode/resize/encode任一错误并返回null，`:106`统一报Cannot decode；故该文案不表明失败发生在解码阶段。Rust `dstu-docs/src/docx_handout.rs:102-120`同样对解码及PNG写入失败返回None，不能要求以改变错误行为掩盖提供方故障。
- 原1px PNG头/三个chunk CRC核对一致，zlib可解压为5字节扫描行；未修改fixture。更强的实际证据为独立作业 **`20261104133759-21ff1f`**，命令`node -e <逐阶段诊断源码>`（完整argv在同名.json）：

```text
DECODE_OK 1 1 ff00007f
ENCODE_FAILED Error: Cannot find module 'pngjs'
Require stack:
- .../host/platform/native/image/encode-worker.mjs
exit 1
```

- F7 `image/operations.ts:102-124`启动encode-worker；worker`:7-9`调用`require('pngjs')`。当前package.json无pngjs/jpeg-js声明，F7 `NEEDS.md:8,43-45`亦登记未批准依赖。无需再运行相同DOCX用例猜测根因：生产decode已成功，encode阶段确实缺模块。probe在该错误后返回，未执行其后DOCX/EMU断言，不把预写断言当已通过。
- 此缺口交F7/依赖协调者按正式发布处理；R5未安装包、替换编码器或修改测试。待运行依赖真实可用后，只需复验原图片正向用例及必要消费者，不重复整套以掩盖此故障。
- crop真实用例仍skip的另一原因是fixture未装native服务（`:23-34`），不是本轮F7方法未main。边界替身用例成功不证明编解码可用；Q6/Q8分别保留真实性/运行接缝限制。

Q7早先d414183bf的独立干净全目录证据保持历史签收，**不代表本次新main图像链通过或当前自检全绿**。总体结论仍不通过。

后续`9b98bb27f`自检的原始测试job `20261104134536-7f2544`仍失败：四目录1 failed/1493 passed/6 skipped，Errors1、exit1；唯一失败用例仍为该DOCX图片，另有RPC onTaskUpdate未处理超时。新版baseline判定把它列为“新增失败”不证明R5文档导致回归；pngjs缺失诊断沿用前次证据，本轮未重复运行。详细四项作业与tip/base见总报告最新补录。
