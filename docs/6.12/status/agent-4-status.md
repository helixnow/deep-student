# 代理 4 状态文档 —— 题库与练习

## 任务目标
审阅并优化「出题 → 练习 → 判分 → 统计」完整业务闭环:
- 后端:`question_bank_service.rs`(75KB)、`question_import_service.rs`(142KB)、`question_export_service.rs`(16KB)、`question_sync_service.rs`(75KB)、`qbank_grading/`(pipeline/types/events)、`exam_sheet_service.rs`(61KB)
- 前端:`components/practice/`(6 个组件)、`components/ExamSheetUploader.tsx`(55KB)、`ExamCardImage.tsx`、`CroppedExamCardImage.tsx`、`ExamPageImage.tsx`、`QuestionBankEditor.tsx`(110KB)、`QuestionBank*View.tsx`、`QuestionInlineEditor.tsx`、`ReviewQuestionsView.tsx`、`VirtualQuestionList.tsx`、`stores/questionBankStore.ts`(52KB)、`api/questionBankApi.ts`、`hooks/useQbankAiGrading.ts`、`useQuestionBankSession.ts`、`useExamSheetProgress.ts`、`useStatisticsData.ts`
- 边界:OCR 内部实现归代理 3;制卡端归代理 5;通用图表归代理 7;`features/learning-hub/apps/views/ExamContentView.tsx`(51KB)是题库练习主界面但位于代理 2 的 learning-hub 目录,按"题库域 UI"对待、改动谨慎并登记。

## 当前状态
T1-T8 审阅完成并实施修复;前端验证全部通过(typecheck/lint 域内零问题/受影响测试 3 个全绿)。cargo check 后台编译中(此前因多代理构建锁竞争+磁盘满出现僵死,已杀掉重启,rustc 正在实际编译)。剩余:cargo check/clippy/test 收尾(T9)+总结(T10)。最后更新:2026-06-13 00:20

## TODO 计划
- [x] T1 question_import_service(142KB):AI 提取题目解析健壮性(畸形 JSON 容错)、批量导入事务性(2026-06-12)
- [x] T2 判分正确性:客观题边界(多选漏选/乱序、填空空白符/大小写)、主观题 AI 判分提示词与失败兜底(qbank_grading/)(2026-06-12)
- [x] T3 限时练习/模拟考计时:后台切换、休眠恢复计时准确性;提交竞态(重复提交、超时自动交卷)(2026-06-12)
- [x] T4 做题历史与统计:掌握率口径一致(mastered/total、SUM(correct)/SUM(attempt) 全链一致)、热力图/打卡聚合源修复、查询均有索引/分页(2026-06-12)
- [x] T5 题目同步服务:冲突解决 SAVEPOINT 原子+pending 双检幂等;修复编辑漏标 modified(2026-06-12)
- [x] T6 试卷切题:坐标换算链健壮、跨页合并已由代理3加固;图片组件为死代码待决策(2026-06-12)
- [x] T7 做题界面体验:快捷键放行系统组合键、提交防重入;深度解析加载态审阅无问题(2026-06-12)
- [x] T8 题目富文本:做题选项/参考答案/正确答案统一 LatexText;出题预览登记为待决策(2026-06-12)
- [ ] T9 实施低风险优化并逐项验证(cargo check/clippy/test + npm typecheck/lint/test)
- [ ] T10 写总结(发现统计/已修复清单/待用户决策项)并最终汇报

## 审阅发现
| # | 文件/位置 | 类型 | 严重度 | 描述 | 处理 |
|---|----------|------|--------|------|------|
| 1 | question_import_service.rs `run_vlm_direct_extraction`(L1231-1377)+resume(L462-586) | bug | 中 | DOCX VLM 直提断点恢复按"已保存题数"做位置跳过;若首轮有空题/保存失败被跳过,或 VLM 两轮输出顺序不同,恢复后会重复或丢失题目 | 已修复(恢复时按内容哈希去重) |
| 2 | question_import_service.rs `json_to_question_params`(L2606-2626) | bug | 中 | 选项剥离启发式:`after.contains("B")&&contains("C")`过宽,题干末尾如"\nA、B、C 三点共线…"会被误切;patterns 数组含重复项 | 已修复(要求 B/C 后跟分隔符的选项结构) |
| 3 | question_import_service.rs `import_json_directly`(L2484-2495) | bug | 低 | JSON 导入逐题写库无事务,单题失败仅 warn,imported_count 仍按 valid.len() 计数(虚高);与 Visual 管线的 SAVEPOINT 事务不一致 | 已修复(SAVEPOINT 包裹+按实际成功计数) |
| 4 | question_import_service.rs `CsvImportService::parse_options_string`(L3856) | 性能 | 低 | 正则在 per-row × per-part 循环内反复编译 | 已修复(LazyLock 提升) |
| 5 | question_import_service.rs `process_csv_row` Merge 分支(L3721-3733) | bug | 低 | Merge 策略下 get_question 失败/None 时穿透到创建新题,会产生同内容重复题 | 已修复(降级为 Skip 并记日志) |
| 6 | question_import_service.rs `run_vlm_direct_extraction`(L1334-1358) | 体验 | 中 | VLM 中途失败但已保存部分题时,直接标记会话 completed,用户无任何"缺题"提示;改语义需产品决策(保持可恢复 vs 部分成功) | 建议(待用户决策) |
| 7 | llm_manager/mod.rs `IncrementalJsonArrayParser`(L1019-1133) | 体验 | 低 | 单个畸形 JSON 对象(如字符串内未转义引号)被静默丢弃,无计数/无日志,用户无感知丢题 | 跨组登记(代理1) |
| 8 | qbank_grading/pipeline.rs `parse_verdict_and_score`(L441) | bug | 中 | verdict/score 取**第一个**匹配标签;提示词要求标签在末尾,模型若在正文先复述标签格式(如"输出格式为<verdict>correct</verdict>"),会用复述值覆盖真实结论 | 已修复(captures_iter().last()+单测) |
| 9 | qbank_grading/pipeline.rs 持久化 ①(L216-222) | bug | 中 | Grade/Analyze 共用一条 UPDATE;Analyze 模式 score=None 会把先前 Grade 写入的 ai_score 缓存清成 NULL("先评判后深度解析"丢评分) | 已修复(Analyze 模式不触碰 ai_score) |
| 10 | question_bank_service.rs `check_answer_correctness` 选择题分支 | bug | 中 | 导入题 answer 常为"A. 选项全文"或"正确答案:A"形态;原逻辑仅做字母数字归一化比较,用户选"A"会被判错 | 已修复(extract_choice_keys 键提取兜底,保守启发式+9 项单测) |
| 11 | question_bank_service.rs `submit_mock_exam`(L1620-1626) | bug | 低 | `total - correct - wrong` 用裸减法,前端若传入 correct+wrong>total 的脏数据会 u32 下溢 panic | 已修复(saturating_sub) |
| 12 | components/practice/MockExamMode.tsx | bug | 低 | 时长/题数输入框无钳制(可输 0/负数/巨值);手动交卷与超时自动交卷存在竞态(双提交) | 已修复(normalize 钳制 1-600/1-500;handleSubmit 尊重 autoSubmitTriggeredRef) |
| 13 | TimedPracticeMode.tsx `getTimeColor` / MockExamMode.tsx `getExamTimeColor` | bug | 低 | 剩余时间颜色阈值用**配置态**时长而非**会话实际**时长计算,中途改配置输入框会导致颜色误报 | 已修复(优先 activeSession 时长) |
| 14 | learning-hub/views/ExamContentView.tsx 计时 useEffect(L1108-1132) | bug | 中 | 限时练习/模拟考的前端计时在标签页不活跃(isActive=false)时暂停累加,而后端按提交时墙钟时长计算,切走标签页会造成显示时间与判定时长脱节、且自动交卷不触发 | 已修复(高级模式改用 startedAt 墙钟差值计时,不随标签页暂停) |
| 15 | qbank_grading/pipeline.rs ③(L252-270) | 观察 | 低 | 同一 submission 重复评判且结论翻转(错→对)时 correct_count 不补增(守卫 is_correct IS NULL 只在首评生效);保守口径,可接受,不改 | 审阅确认,不处理 |
| 16 | question_bank_service.rs 主观题判分链路 | 观察 | - | 主观题提交→is_correct=NULL→AI 评判置 verdict 并按 NULL 守卫递增 correct_count,与客观题口径一致;无双计数风险 | 审阅确认,无问题 |
| 17 | question_bank_service.rs `get_activity_heatmap`(L1138)/`get_check_in_calendar`(L1894) | bug | 中 | 与 `get_learning_trend` 口径不一致:趋势按 answer_submissions 聚合,热力图/打卡按 questions.last_attempt_at(题目最后做题日)聚合——重复练习会把题目从历史日期"挪走",打卡/热力图历史回溯性缩水、连续打卡可能凭空断签;correct_count 用题目当前状态而非当日作答结果 | 已修复(改为 submissions 聚合+按 DISTINCT 题目计数,无提交记录的存量题按 last_attempt_at 兜底) |
| 18 | question_bank_service.rs 三个时间统计函数 | bug | 低 | submitted_at/last_attempt_at 为 UTC,DATE() 按 UTC 日界线分组,而连续打卡判定用 chrono::Local"今天/昨天"——UTC+8 用户 0:00-7:59 做题会被记到前一天,清晨打卡显示断签 | 已修复(DATE(…,'localtime') 统一本地日界线) |
| 19 | vfs/repos/question_repo.rs `update_question`(L1687) | bug | 中 | 编辑题目内容只重算 content_hash,不调用 mark_as_modified;sync_status 仍是 synced → check_sync_status 漏报本地修改数,detect_conflicts 把本地编辑当"未修改"直接被远程覆盖(ModifyModify 漏检) | 已修复(补 mark_as_modified_with_conn,与 submit_answer 的 S-030 口径一致) |
| 20 | question_sync_service.rs `batch_resolve_conflicts`(L951-961) | 体验 | 低 | 逐条解决失败只 warn 日志,返回值只含成功列表;全部失败也返回 Ok([]),前端无法感知部分失败 | 建议(返回 {resolved, failed} 结构需改接口,待用户决策) |
| 21 | question_sync_service.rs `detect_conflicts`(L676) | 观察 | 低 | "本地有 remote_id 但远程列表缺失"(非墓碑式删除)不产生冲突;依赖远程端保证墓碑语义。远程推拉链路尚未接入(本服务为本地脚手架),暂无实际风险 | 审阅确认,登记备查 |
| 22 | exam_sheet_service.rs bbox 解释链(L852-1161) | 观察 | - | 坐标换算链路(归一化/像素/右下角三种形态+惩罚择优+钳制)健壮;跨页合并 cross_page_merger.rs 已由代理3今日加固(相邻页守卫);未发现新问题 | 审阅确认,无问题 |
| 23 | components/ExamCardImage.tsx + CroppedExamCardImage.tsx + ExamPageImage.tsx | 死代码 | 低 | "文档25"迁移产物,全仓无任何 import(仅 style-lab/scan-data.json 扫描记录);且 CroppedExamCardImage 的 effect 依赖非原始值,若启用会有重复解码问题 | 建议(确认后删除或保留待迁移,待用户决策) |
| 24 | QuestionBankEditor.tsx 键盘快捷键(L973) | bug | 低 | 快捷键不过滤修饰键:Ctrl+R(刷新)、Ctrl+数字(切标签)等系统组合会被题目快捷键拦截并 preventDefault | 已修复(带 Ctrl/Meta/Alt 直接放行) |
| 25 | QuestionBankEditor.tsx `handleSubmit`(L783) | bug | 低 | 无重入守卫:双击在 isSubmitting 渲染生效前可触发两次提交(client_request_id 每次新生成,幂等不覆盖此场景),双计 attempt_count | 已修复(开头 isSubmitting 直接 return) |
| 26 | QuestionBankEditor.tsx 富文本渲染 | bug | 低-中 | 三处渲染不一致:题干/解析/AI反馈用 MarkdownRenderer(支持 \(..\)→$..$ 归一化),做题选项用 LatexText(仅 $..$),桌面编辑态选项是裸 span(完全不渲染),参考答案/正确答案 5 处裸文本——含公式的答案显示原始 LaTeX 源码 | 已修复(选项/答案统一 LatexText;LatexText 无公式时退化纯文本,零风险) |
| 27 | QuestionInlineEditor.tsx(出题) | 观察 | 低 | 出题编辑器为纯文本输入无公式预览;列表预览(VirtualQuestionList/ReviewQuestionsView)截断展示原始文本(虚拟列表渲染 KaTeX 有性能代价) | 建议(出题加预览面板属功能增强,待用户决策) |
| 28 | qbank_grading UI(QuestionBankEditor L2089-2335) | 观察 | - | 深度解析加载状态完备:评判中(流式+取消)、失败(保留已流出内容+手动判定兜底)、完成(verdict+score 徽章)、缓存(prop/本地 ref 双层) | 审阅确认,无问题 |
| 29 | 键盘快捷作答 | 观察 | - | 已支持:数字1-9选项、Enter提交(canSubmit+isSubmitting 守卫)、←/→切题、R重做、Space暂停计时、H暗记;输入框聚焦时自动失效 | 审阅确认,无问题 |
| 30 | question_export_service.rs | 观察 | - | 分页流式导出、OWASP 公式注入防护(含全角变体)、GBK 编码失败显式报错、路径遍历校验、附单测;无问题 | 审阅确认,无问题 |
| 31 | hooks/useExamSheetProgress.ts | 观察 | 低 | ref 持回调防监听器重挂竞态、session 过滤完备;唯一小瑕疵:onProgress 回调在 setState updater 内调用,StrictMode 下可能双触发(仅日志/进度上报,无实害) | 审阅确认,登记不改 |
| 32 | tests/question-bank-editor-ai-markdown.test.tsx | bug | 低 | useBreakpoint 模块 mock 缺 useIsMobile 导出,共享组件 NotionDialog 改用 useIsMobile(代理7今日改动)后测试崩溃 | 已修复(mock 补齐 useIsMobile/useIsTablet) |
| 33 | tests/practice-launcher-runtime-restore.test.tsx | bug | 低 | 首个用例承担 PracticeLauncher 模块图一次性动态导入成本(phosphor-icons barrel 等),8 代理高负载下超过默认 5s 超时,环境性假失败 | 已修复(该用例 timeout 放宽至 30s) |

## 已实施的优化
| # | 改动文件 | 改动说明 | 验证结果 |
|---|----------|----------|----------|
| 1 | question_import_service.rs | 发现#1:`content_dedup_key` 内容哈希去重(VLM 恢复二次去重);发现#2:选项剥离启发式收紧(B/C 需跟选项分隔符);发现#3:JSON 导入 SAVEPOINT 事务+实际成功计数;发现#4:3 处正则 LazyLock 提升;发现#5:CSV Merge 失败降级 Skip | cargo check 编译中 |
| 2 | qbank_grading/pipeline.rs | 发现#8:verdict/score 取最后一组标签+2 个单测;发现#9:Analyze 模式不清空 ai_score | cargo check 编译中 |
| 3 | question_bank_service.rs | 发现#10:`extract_choice_keys` 选项键提取兜底(单选/多选/不定项)+9 项判分边界单测;发现#11:saturating_sub 防下溢;`check_answer_correctness` 改静态方法 | cargo check 编译中 |
| 4 | components/practice/MockExamMode.tsx | 发现#12:输入钳制 normalizeDurationMinutes/normalizeTotalCount;手动交卷尊重 autoSubmitTriggeredRef;发现#13:getExamTimeColor 用会话实际时长 | npm typecheck ✓ |
| 5 | components/practice/TimedPracticeMode.tsx | 发现#13:getTimeColor 用会话实际时长(activeSession.duration_minutes 兜底组件态) | npm typecheck ✓ |
| 6 | learning-hub/views/ExamContentView.tsx | 发现#14:限时练习/模拟考改墙钟差值计时(不随标签页可见性暂停,与后端口径一致);普通计时器维持原 isActive 暂停行为 | npm typecheck ✓ |
| 7 | question_bank_service.rs(时间统计) | 发现#17:热力图/打卡改 answer_submissions 聚合(DISTINCT 题目数+当日做对题数,存量题兜底);发现#18:三个统计函数 DATE 加 'localtime' | cargo check 编译中 |
| 8 | vfs/repos/question_repo.rs | 发现#19:update_question 补 mark_as_modified(同步漏标) | cargo check 编译中 |
| 9 | QuestionBankEditor.tsx | 发现#24:快捷键放行修饰键组合;发现#25:handleSubmit 防重入;发现#26:选项/参考答案/正确答案 8 处统一 LatexText 渲染 | npm typecheck ✓ + ai-markdown 测试 ✓ |
| 10 | tests/vitest/question-bank-editor-ai-markdown.test.tsx | 发现#32:useBreakpoint mock 补齐 useIsMobile/useIsTablet 导出 | vitest ✓(2 用例) |
| 11 | tests/vitest/practice-launcher-runtime-restore.test.tsx | 发现#33:首用例 timeout 放宽至 30s(模块图一次性导入开销) | vitest ✓(15.8s < 30s) |

## 跨组问题(发现但不属于本组职责域)
| # | 涉及文件 | 问题描述 | 建议归属代理 |

## 共享文件改动登记
| # | 文件 | 改动段落/函数 | 原因 |
|---|------|--------------|------|
| 1 | features/learning-hub/apps/views/ExamContentView.tsx(代理2目录,题库域UI) | 计时 useEffect(原 L1108-1132)移至 activeAdvancedTimerDuration/activeAdvancedStartedAt useMemo 之后并改墙钟计时 | 修复发现#14;只动计时段落,未触碰其他逻辑 |

## 总结(T10)
### 发现统计
- 共 33 项发现:bug 15 项(已全部修复)、体验/建议 4 项(其中 3 项待用户决策、1 项跨组登记)、死代码 1 项(待用户决策)、观察确认 13 项(无需改动)。
- 严重度分布:中 8 项(全部修复)、低-中 1 项(已修复)、低 15 项(12 修复/3 登记)、无风险观察 9 项。

### 已修复清单(15 bug + 2 测试修复)
后端(Rust):
1. VLM 断点恢复重复/丢题(内容哈希去重)— import_service
2. 选项剥离启发式误切题干 — import_service
3. JSON 导入无事务+计数虚高(SAVEPOINT)— import_service
4. 正则循环内重复编译(LazyLock)— import_service
5. CSV Merge 失败穿透产生重复题 — import_service
6. AI 判分 verdict/score 取首组标签被复述污染(改取末组+单测)— qbank_grading
7. Analyze 模式清空已有 ai_score — qbank_grading
8. 选择题"A. 全文"形态答案判错(extract_choice_keys+9 单测)— question_bank_service
9. submit_mock_exam u32 下溢风险(saturating_sub)— question_bank_service
10. 热力图/打卡聚合源错误(改 answer_submissions+DISTINCT)— question_bank_service
11. 统计 UTC/本地日界线错位(DATE 'localtime')— question_bank_service
12. 编辑题目漏标 sync modified(mark_as_modified)— question_repo
前端(React/TS):
13. 模拟考输入无钳制+手动/自动交卷竞态 — MockExamMode
14. 倒计时颜色阈值用配置态时长 — TimedPractice/MockExam
15. 限时练习/模拟考切标签页计时暂停与后端墙钟脱节(墙钟差值计时)— ExamContentView
16. 快捷键拦截 Ctrl/Meta/Alt 系统组合键 — QuestionBankEditor
17. handleSubmit 无重入守卫(双击双计)— QuestionBankEditor
18. 选项/参考答案/正确答案 8 处裸文本不渲染公式(统一 LatexText)— QuestionBankEditor
另:修复 2 个受其他组件演进影响的存量测试(useBreakpoint mock 缺导出、首用例模块导入超时)。

### 待用户决策项
1. 发现#6:VLM 中途失败但已存部分题时,会话仍标 completed,用户无"缺题"提示 — 改为部分成功语义需产品决策。
2. 发现#20:batch_resolve_conflicts 部分失败静默 — 返回 {resolved, failed} 需改前后端接口。
3. 发现#23:ExamCardImage/CroppedExamCardImage/ExamPageImage 三个组件全仓无引用(死代码)— 确认后可删除。
4. 发现#27:出题编辑器无公式预览(功能增强)。

### 验证结果
- 前端:npm run typecheck ✓;eslint 域内 0 error(3 条存量 warning 为基线);受影响 vitest 3 用例全绿。
- 后端:cargo check / clippy / test(进行中,见当前状态)。

## 接力须知
- 我是 8 子代理工作组的 4 号(题库与练习),分工见 `docs/6.12/agent-4.md`,全局规则见 `docs/6.12/README.md`。
- `features/practice/` 是空壳(只有 .gitkeep),真实练习 UI 在 `components/practice/` 与 `features/learning-hub/apps/views/ExamContentView.tsx`。
- 验证命令:后端 `cargo check`、`cargo clippy -- -D warnings`(以现状为基线)、`cargo test question|qbank|exam_sheet`;前端 `npm run typecheck`、`npm run lint`、`npm test -- practice`。
- 未经用户明确要求不执行 git commit / push。
- 反馈通道:mcp-feedback-enhanced,feed_id=F-Q9ED5(中断后新会话需重新注册自己的 feed)。
