# Wave2-E R6-07：verdict 三路一致性复核

- 角色：0824 Wave2-E 第 6 轮「verdict」复核
- 独占文件：`src-tauri/src/question_bank_service.rs`（原语段）、
  `src-tauri/src/qbank_grading/pipeline.rs`、`src-tauri/src/mastery/service.rs`
  （纠正函数）
- 本轮未跑编译/测试/CI，未 commit（按轮次纪律，由外层统一处理）。
- 复核方式：静态走读三路调用链 + 全库检索旁路写点
  （`UPDATE answer_submissions` / `correct_count` 写入 / `update_submission_correct` 调用方）。

## 1. 结论：三路一致 ✅

三条判分路径全部收敛到
`QuestionBankService::apply_submission_verdict_in_tx`（question_bank_service.rs
L790），无旁路写点：

| 路 | 入口 | 到原语的链路 | grading_method |
|---|---|---|---|
| A 自动/自评去重 | `qbank_submit_answer` → `submit_answer` | 待判定去重分支（L571-581：最近提交 `is_correct IS NULL` 且同答案 + override）→ `regrade_submission_in_tx`（L937）→ 原语 | `manual` |
| B AI 判分管线 | `run_qbank_grading`（qbank_grading/mod.rs 命令层与 chat_v2 `qbank_executor` L2999 共用）| `persist_grading_result` Grade 分支（pipeline.rs L377-378，SAVEPOINT 内传裸 `&conn`）→ 原语 | `ai` |
| C 人工改判 | `qbank_submit_answer` 带 `regrade_submission_id` → `regrade_submission`（L721）| 最近提交守卫（L741-750）→ `regrade_submission_in_tx` → 原语 | `manual` |

三路共享的原语语义（r4-01/r4-02 已落地，本轮走读确认无回退）：

- 同向重放在原语入口幂等短路（`changed=false` 零写入，L802-817）；
- correct_count 差值以**本 submission 旧 is_correct** 为基准
  （NULL/false→true +1、true→false -1、`MAX(0,·)` 防负，L823-827）；
- RowSync 推进（`updated_at` / `local_version`，L831-847）、状态 CASE、
  S-030 `mark_as_modified` + content hash、`refresh_stats_with_conn` 全在事务内；
- 事务外副作用（SM-2 复习计划、learner profile 回流）三路都按
  `VerdictApplyOutcome.needs_review_plan` / `mastery_state` 执行：
  A/C 在 `regrade_submission_in_tx` 外壳（L949-968），B 在 pipeline
  RELEASE 之后（pipeline.rs L239-268），口径对称。

## 2. 换判纠正接线：一致 ✅

原语的 mastery 分路（L892-907）：

- 首判（旧 `is_correct IS NULL`）→ `record_qbank_answer_with_conn`
  （幂等键 `me_qbank_{sid}`，ON CONFLICT DO NOTHING 保证恰好一次）；
- 换判（`Some(old) != new`）→
  `MasteryService::record_qbank_verdict_correction_with_conn`
  （mastery/service.rs L287）：tombstone 链上存活旧信号（只推进
  `deleted_at/updated_at/local_version` 同步元数据）+ 追加修订事件
  `me_qbank_{sid}_r{n}`（weight=1 直写）+ 重算新旧 concept 聚合
  （tags 漂移的 stale concept 一并重算）；
- 同向重放走不到 mastery 段（原语入口已短路）；纠正函数自身另有两层幂等
  （存活末端同向不追加；修订 id 冲突 DO NOTHING）。

因三路都经原语，换判纠正自动覆盖 A/B/C 三路——AI 复判换向（B 路）与
人工换判（A/C 路）产生同构的 tombstone+`_rN` 事件链。

## 3. 本轮补的缺口（独占文件内）

复核发现两处 R4「先落原语、后落纠正接线」遗留的陈旧痕迹，当轮已修：

1. **pipeline.rs 白盒测试断言过弱 + 注释过期**：
   `persist_grade_false_to_true_increments_correct_count` /
   `persist_grade_true_to_false_decrements_correct_count` 仍写着
   "方向纠正待 r4-03 纠正原语接线后改断言"，且只断言
   `wrong + correct == 1`（无方向）。纠正已接线，按其注释自述的后续动作
   收紧为方向断言：false→true 后存活信号必须恰 1 条 `correct`、0 条 `wrong`
   （首判 wrong 被 tombstone）；true→false 对称。辅助函数
   `live_mastery_events` 的 doc 注释同步去掉"若接入"措辞。
2. **mastery/service.rs 纠正函数 doc 注释过期**：
   `record_qbank_verdict_correction_with_conn` 仍写"question_bank 侧接线
   留待后续轮"。改为如实描述：原语换判分路已统一接线（覆盖人工外壳 +
   AI 管线落库段），自持事务版 `record_qbank_verdict_correction`
   （补偿脚本用）也经由此实现，保持 pub。

两处改动均为测试断言收紧与注释纠偏，不改任何产品逻辑；收紧后的断言方向
与 in-crate 白盒测试 `apply_submission_verdict_counts_and_rowsync`
（question_bank_service.rs L4428，_r1 wrong / _r2 correct 链断言）互为印证。
按纪律只写未跑，第 8 轮统一执行。

## 4. 复核过的旁路（确认非缺口 / 残留但不在独占文件）

- `question_repo.rs` `update_submission_correct`（L2530）：零调用死代码
  （全库检索仅定义 + 文档提及），且缺 RowSync 列——r4-09 N4 已记名，
  应在 question_repo 独占轮删除，本轮不越界。
- `question_repo.rs` `submit_answer_with_conn`（L2018 的 correct_count +1）：
  新作答插入路（attempt 递增），不是"既有 submission 判定变化"，
  不属原语管辖，口径正确。
- `chat_v2/tools/qbank_executor.rs` L2648 的 `card.correct_count += 1`：
  写的是 exam_sheets `preview_json` 里的预览卡片（legacy 会话练习存储），
  不落 `questions`/`answer_submissions` 表，与三路 verdict 无交集；
  其 AI 判分子命令（L2999）走的正是 B 路管线。
- `question_sync_service.rs` 的 correct_count 写入：云同步 merge 落地远端值，
  非判分路径。
- `insert_submission_with_conn` 的 RowSync INSERT 缺口（r4-01 §3）与
  `device_id`：仍留 question_repo 独占轮，与本轮结论无关。

## 5. 回复

**三路一致。** A（submit_answer 待判定去重）/ B（AI 管线 persist）/
C（regrade_submission）全部经 `apply_submission_verdict_in_tx` 落库；
换判统一走 `record_qbank_verdict_correction_with_conn`
（tombstone + `_rN` 修订，三路同构）。本轮补了 pipeline 白盒测试的方向断言
与两处过期注释，无产品逻辑缺口。
