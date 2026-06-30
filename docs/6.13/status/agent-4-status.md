# 代理 4 状态文档（round 2）—— 题库与练习

> 第一轮状态见 `docs/6.12/status/agent-4-status.md`（33 项发现 / 15 bug 已修 + 2 测试，禁止清空回退）。
> 本轮目标：① P1 死代码清理（#23 三件套组件）；② P3 产品/接口取舍（#6/#20/#27）只出方案等用户拍板。
> feed_id=F-VH2CQ。本文档随进展持续更新。

## 当前状态（2026-06-13）
- ✅ **P1 #23 已落地并验证**：删除三件套死代码组件（grep 全仓 + tsc 兜底确认无引用后删除）。
- ✅ **P3 #6/#20/#27 已落地并验证**：用户指示"直接开始干"，按我推荐方案实施（#6=方案 B；#20=结构化 `{resolved, failed}`；#27=折叠式公式预览）。
- ✅ 附带清理 `question_import_service.rs:50` 一处预存在未用 import（`VlmExtractedQuestion`，P1 死代码，本域；与本轮 #6 改动无关，删除后后端警告回到 ≤ 基线）。
- 共享文件改动：`src/locales/{zh-CN,en-US}/exam_sheet.json` 各加 1 个键（见登记表）。

## 本轮已实施改动汇总（round 2）
| # | 方案 | 后端改动 | 前端改动 | 验证 |
|---|------|----------|----------|------|
| #6 | 方案 B（完成但提示缺题） | `question_import_service.rs`：`run_vlm_direct_extraction` 返回 `(usize, bool)`（saved, partial）；`Completed` 变体加 `#[serde(default)] partial: bool`；2 个 VLM 调用方解构 `vlm_partial`；7 处 `Completed` emit 补 `partial`（仅 2 处 VLM 路径为真） | `ExamSheetUploader.tsx`：payload 加 `partial?`；`Completed` 分支 partial 时显示 `import_done_partial`（非阻塞，不触发失败态） | cargo check 0 错误；tsc 0 |
| #20 | 结构化返回 | `question_sync_service.rs`：新增 `ConflictResolveFailure{conflict_id,error}` + `BatchResolveConflictsResult{resolved,failed}`；`batch_resolve_conflicts(_with_conn)` 与命令 `qbank_batch_resolve_conflicts` 返回该结构；循环收集失败明细 | `questionBankStore.ts`：加同名 TS 类型；`batchResolveSyncConflicts` 消费 `result.resolved` 更新缓存、返回结构；`SyncConflictDialog.tsx`：批量后 `failed>0` 时 `unifiedAlert(warning)` 提示部分失败 | cargo check 0 错误；tsc 0；lint 改动区 0 error |
| #27 | 折叠式公式预览 | — | `QuestionInlineEditor.tsx`：加 `Eye` 图标 + `LatexText` import + `showPreview` 态 + 折叠预览面板（题干/选项/答案/解析走 LatexText，无公式自动退化纯文本）；标题复用 `common:preview`（无新 locale 键） | tsc 0；lint 该文件 0 问题；practice/question-bank 测试 8/8 |

> 设计取舍：#6 选「给 `Completed` 加 `serde(default) partial`」而非「新增变体」，因前端用 `switch(payload.type)` 无 default 分支，新增变体会被静默忽略（连完成都不显示）；optional 字段对旧前端反序列化向后兼容。

## P1 — 死代码清理（已完成）

### #23 ExamCardImage / CroppedExamCardImage / ExamPageImage 三件套删除
- **删前验证**（满足 agent-4.md「删除前务必再次 grep 确认无任何 import/JSX/lazy 引用」要求）：
  - 全仓 grep 三组件名：源码侧唯一非自引用是 `ExamCardImage.tsx` → `import { CroppedExamCardImage, type BoundingBox } from './CroppedExamCardImage'`（**三件套内部引用**，三者同删后消失）。
  - `useCroppedImage`（CroppedExamCardImage 导出的 hook）全仓**零 importer**。
  - `from '…(ExamCardImage|ExamPageImage|CroppedExamCardImage)'` 在所有 `.ts/.tsx` 中仅 1 处（即上面那条内部引用）。
  - 其余命中均为文档（6.12/6.13）与 `src/components/style-lab/scan-data.json`（扫描记录，非运行时引用，符合 agent-4.md 预期）。
  - 三文件均为纯展示型 React 组件，无全局副作用（无 `customElements`/无注册表/无模块级副作用）。
- **删除**：`src/components/ExamCardImage.tsx`、`CroppedExamCardImage.tsx`、`ExamPageImage.tsx`（共 ~19.7KB）。
- **验证**：
  - `npm run typecheck` → exit 0（无悬空引用，确认三者确为死代码）。
  - `npm run lint` → exit 1 但为**纯基线**（1440 problems / 211 errors，均为既有问题；grep lint 输出无任何三组件名；删除只减文件不增代码，不可能新增 lint 错误）。
  - `npm test -- practice question-bank` → **4 文件 / 8 测试全绿**（exit 0）。
- **备注**：`scan-data.json` 是 style-lab 工具的扫描快照，里面仍有三组件路径记录。它不是运行时引用，按 agent-4.md 口径属"扫描记录"无需处理；如需可由维护者重跑扫描刷新（非本域职责，未改）。

## P3 — 产品/接口取舍（只出方案，等用户拍板）

> 纪律：高风险/破坏性/产品取舍/前后端契约变更只登记方案，待确认后落地。

### #6 VLM 直提中途失败但仍标 `completed`（无"缺题"提示）
- **位置**：`question_import_service.rs:run_vlm_direct_extraction`（L1381-1405 的 partial-failure 分支）+ 完成事件 `QuestionImportProgress::Completed`（变体定义 L106-110）。
- **现状**：`vlm_result` 为 `Err` 但 `total_saved > skip_count` 时，仅 `log::warn!("…部分成功")`，随后照常推进 `current_stage = DocxVlmDirectDone` 并返回 `Ok(total_saved)`；调用方发 `Completed { total_questions: total_saved }`。`Completed` 变体**无任何"部分/缺题"字段**，用户界面看到的是正常成功。
- **方案 A（保留可恢复）**：partial-failure 分支**不推进** stage 到 `DocxVlmDirectDone`（保持 checkpoint 可 resume），改发"部分完成/失败"事件，前端提供「继续导入」入口补齐缺题。
  - 优点：用户能真正补齐缺失题目。代价：需前端 resume 入口 + "部分态"语义；resume 重复风险已有内容哈希去重兜底（第一轮 #1 已加）。
- **方案 B（完成但显式提示缺题数）**：给 `Completed` 增 `partial: bool`（或新增 `CompletedPartial` 变体 / `missing` 计数），前端完成提示显示「VLM 中断，已提取 N 题，可能缺题」。
  - 先例：`pdf_ocr_service.rs` 的 `Completed` 事件已有 `has_failures/failed_count` 字段，可对齐此模式。
  - 优点：改动小、语义清晰、即时可见。代价：触及 `QuestionImportProgress::Completed` 枚举 + emit 站点（可只让 DOCX VLM 这一处用新变体，避免改全部 7 处）+ 前端事件处理。
- **建议**：先做 **B**（低风险、即时可见，复用 OCR has_failures 先例）；若需完整补题体验再追加 **A** 的 resume。**请拍板：A / B / A+B。**

### #20 `batch_resolve_conflicts` 部分失败静默
- **位置**：`question_sync_service.rs:batch_resolve_conflicts_with_conn`（L935-970）。
- **现状**：逐条 `resolve_conflict_with_conn`，失败仅 `warn!`，只把成功项收进 `resolved`；**全失败也返回 `Ok([])`**，前端无法区分"本无冲突"与"全部解决失败"。
- **方案**：改返回结构 `BatchResolveResult { resolved: Vec<Question>, failed: Vec<{conflict_id, error}> }`（或保守版：保留 `resolved` 再附 `failed_count/failed_ids`）。
- **影响**：**前后端契约变更（中风险）**——需改 ① 后端函数返回类型；② 命令层（`commands.rs`，命令/壳层一致性负责人=代理7，本域相关段落落地前需与代理7对齐口径并登记）；③ 前端 `questionBankApi.ts` 类型 + 调用 UI（提示部分失败）。
- **建议**：值得做（静默失败是真问题）；按纪律因"改接口"先登记等确认。可折中走"保守版"最小化前端改动。**请拍板：是否动接口 / 走完整结构 or 保守计数版。**

### #27 `QuestionInlineEditor`（出题）无公式预览
- **位置**：`src/components/QuestionInlineEditor.tsx`（题干/答案/解析/选项均为 `Textarea`/`Input` 纯文本，无 KaTeX 预览）。
- **现状**：做题侧已统一 `LatexText` 渲染（第一轮 #26），但**出题编辑态**无任何公式预览，是四个 AI 工作台里唯一无预览者。属功能增强（非 bug）。
- **方案**：在编辑区加一个折叠的「实时预览」只读面板，复用 `LatexText`/`MarkdownRenderer` 渲染 content/answer/explanation/options。
- **影响**：**纯前端**、新增 UI，无后端/契约变更，风险低。本编辑器是单题编辑（非虚拟列表），无 KaTeX 列表渲染性能顾虑。
- **建议**：可做（提升出题体验、与其他工作台一致）；因属增强项先报方案。**请拍板：是否本轮加预览面板。**

## 二轮深审发现（round 2 deep audit）
> 用户指示"继续挖，继续干"。对 hooks / store / qbank_grading / 选题与判分后端 / 虚拟列表做了一轮新审。结论：第一轮加固充分，仅发现 1 个可修 bug + 1 个低危观察。

| # | 位置 | 类型 | 严重度 | 描述 | 处理 |
|---|------|------|--------|------|------|
| R2-1 | `hooks/useStatisticsData.ts` | bug/性能 | 中 | 具体 hook（`useEnhancedStatistics` 等）每次渲染传入**新的箭头函数** `fetcher`，进入 `fetchData` 依赖 → `fetchData` 每次渲染重建 → ① 自动刷新 `setInterval` 每次渲染被清除重建、消费组件若在 60s 内重渲染则**自动刷新永不触发**；② 初始加载 effect 反复调度。 | **已修复**：`fetcher`/`onError` 用 ref 持有，从 `fetchData` 依赖移除（deps 改为 `[cacheKey,getFromCache,saveToCache]`），effect 稳定。tsc ✓ |
| R2-2 | `hooks/useQbankAiGrading.ts` | bug（潜在挂起） | 低-中 | `startGrading` 返回的 Promise 在**超时**(`resetTimeout` 回调)与 `cancelGrading`/`resetState`/卸载路径下不 settle（`resetTimeout` 在 executor 外、拿不到 resolve/reject；cancel 先置 ref=null+unlisten 使迟到 'cancelled' 被守卫忽略）→ `await startGrading()` 永久挂起、`.finally` 不执行。当前两个调用点为 fire-and-forget 故无显性故障，但属真实潜在隐患。 | **已修复**：加 `settleRef`/`failRef` 持有当前 Promise 的 settle/fail；超时→`fail(timeout)`、cancel/reset/卸载→`settle('cancelled')`；settle/fail 内置幂等并清 ref。`startGrading` 的 async executor 加 `eslint-disable no-async-promise-executor`（主体 try/catch 包裹、早退同步 reject，安全）。tsc ✓ / lint ✓ |

| R2-3 | `components/practice/PaperGenerator.tsx:handleExport` | 产品缺口 | 低 | 组卷预览可用，但「导出」按钮（pdf/word/markdown）原仅 `console.log` 的 TODO 桩 → 点击无反应。 | **已实现 markdown 导出**：拼接 MD（题干/选项/答案/解析，遵循 includeAnswers/includeExplanations）→ `save()` 对话框选路径 → 复用后端 `save_text_to_file` 落盘；pdf/word 给出「即将推出」提示而非静默。tsc ✓ / lint ✓。pdf/word 为较大功能仍待立项。 |

> 已核查无问题：`useQuestionBankSession`（epoch+requestId 双守卫、分页去重、位置持久化完备）；`useExamSheetProgress`（ref 回调+session 过滤，R1 #31 的 StrictMode onProgress 双触发仍登记不改）；`questionBankStore`（loadQuestions requestId 守卫 / loadMore examId 守卫 / deleteQuestion 已审计修复 pagination+currentId / getters 边界 OK）；`qbank_grading/{events,types}`（`#[serde(rename="type")]` 正确，FE `switch(payload.type)` 契约对齐）；`get_daily_practice`/`generate_mock_exam`/`submit_answer`（事务+幂等短路+主观题 None+答错自动建 SM-2 计划+配比超额随机裁剪）；`submit_answer_with_conn`（状态 CASE：manual→in_progress / 错→review / 对且 correct_count+1≥2→mastered，S-030 同步标记完备）；`exam_sheet_service.update_exam_sheet_cards`（删卡关联错题守卫+裁剪文件清理+新增页越界校验）；CSV 导入（`flexible` 读取、逐行错误隔离、`existing_hashes` 文件内去重、R1 已修 Merge 穿透/正则）；`question_export_service.escape_csv_cell`（OWASP 公式注入：半/全角 `=+-@`+tab 中和+引号转义，单测覆盖）；`DailyPracticeMode`（日历数学正确、target 钳 [5,50] 无除零）；`PaperGenerator` 预览；`VirtualQuestionList`（tanstack measureElement 标准用法）；`QuestionBankEditor`（提交防重入、快捷键修饰键放行、AI 调用点 fire-and-forget）。

## 跨组问题（发现但不属于本组职责域）
| # | 涉及文件 | 问题描述 | 建议归属代理 |
|---|----------|----------|--------------|
| （暂无新增；第一轮 #7 IncrementalJsonArrayParser 已登记代理1） | | | |

## 共享文件改动登记（round 2）
| # | 文件 | 改动段落/函数 | 原因 |
|---|------|---------------|------|
| 1 | `src/locales/zh-CN/exam_sheet.json` | `uploader.import_done_partial` 新增 1 键 | #6 部分完成提示文案（本域 exam_sheet 命名空间） |
| 2 | `src/locales/en-US/exam_sheet.json` | `uploader.import_done_partial` 新增 1 键 | #6 同上（中英对齐，check:i18n 通过） |

> 说明：#20 的命令 `qbank_batch_resolve_conflicts` 定义在本域 `question_sync_service.rs`，`lib.rs` 仅按函数名注册、返回类型自动推导，**无需改 `lib.rs`/`commands.rs`**。`SyncConflictDialog.tsx` 用 `t(key,{defaultValue})` 内联兜底文案（沿用该文件既有 `conflictBatchResolveFailed` 模式），未新增 locale 键。

## 验证基线与本轮结果
- `cargo check`（src-tauri/）：exit 0；删除 L50 未用 import 后警告回到 ≤ 基线（我的两文件 question_import_service / question_sync_service 零警告）。
- `npm run typecheck`：exit 0（删组件后 + 三特性后各一次）。
- `npm run lint`（改动文件）：QuestionInlineEditor / questionBankStore 零问题；ExamSheetUploader 与 SyncConflictDialog 各自的 error/warning 均为**预存在**（L195/199 空 `catch{}`、L82 unused-disable，非本轮改动区）。
- `npm run check:i18n`：exit 0（exam_sheet 中英键完全一致、行差 0）。
- `npm test -- practice question-bank`：4 文件 / 8 测试全绿。
