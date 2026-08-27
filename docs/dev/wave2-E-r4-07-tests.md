# Wave2-E R4-07：qbank 测试源码（三路计数 / 改判回写 / 旧卡兼容）

- 轮次：0824 Wave2-E 第 4 轮「qbank 测试源码」；模型 claude-fable-5-thinking-high。
- 硬规则：本轮**只写不跑**（未执行 cargo test / vitest / typecheck），未 commit，
  未改任何产品文件。两个测试文件头部均标注 **第 8 轮才统一执行**。
- 独占新建文件（本轮仅这三个）：
  1. `src-tauri/tests/qbank_verdict_three_paths.rs`
  2. `src/stores/__tests__/recordPracticeAnswer.regrade.test.ts`（目录为本轮新建；
     vitest.config.ts 的 `src/**/*.{test,spec}.{ts,tsx}` include 已覆盖，无需改配置）
  3. 本文档

## 一、写作基线（与并行修复的关系）

本轮与第 4 轮修复角色并行。写作时工作区（未提交改动）已包含：

- 后端：`apply_submission_verdict_in_tx` 原语（pub(crate)，含 RowSync 推进、
  MAX(0,·) 防负、同向幂等零写入）、`SubmitAnswerResult.daily_progress`
  （`DailyProgressSnapshot`，serde default + skip_serializing_if）、
  `build_daily_progress_snapshot`；regrade/submit 去重分支已改走原语。
- 前端：`recordPracticeAnswer` 的 R4 差量修正（`answered_results` 判定基线、
  改判差量、旧会话 fail-closed 首答锁）、`applyAuthoritativeDailyProgress`、
  `handleMarkCorrect` 回写（r4-05）。

测试全部走 **pub API**（`QuestionBankService::{submit_answer, regrade_submission,
get_daily_practice}`、`VfsQuestionRepo` 读接口、store 公开 action），不触碰
pub(crate) 原语本体——原语白盒表格测试由修复方放在
`question_bank_service.rs` 的 in-crate `mod tests`
（`apply_submission_verdict_counts_and_rowsync` 等），两层互补不重复。

## 二、三路计数等价意图（文档化 + 能测的部分）

契约表（判定转移 → correct_count / status / 是否新插 submission）完整记录于
`qbank_verdict_three_paths.rs` 文件头，三路要求同一口径：

| 转移 | correct_count | status | 新插 submission |
|---|---|---|---|
| NULL→true | +1 | in_progress / mastered | 否 |
| NULL→false | 0 | review | 否 |
| false→true | +1 | in_progress / mastered | 否 |
| true→false | -1（MAX(0,·)） | review | 否 |
| 同向 | 0（零写入，RowSync 不推进） | 不变 | 否 |

- **A 路（submit_answer 去重分支）与 C 路（regrade_submission）**：本文件直接黑盒测。
- **B 路（AI 管线 run_qbank_grading）**：`QbankGradingEmitter` 强依赖 tauri Window，
  建 tauri App 的集成测试必须在 Cargo.toml 注册 `harness = false` 目标
  （产品文件，本轮禁改），故 B 路**无法在本文件直测**——只能文档化：
  - B 路首判（NULL→true，grading_method='ai'）已由既有
    `tests/qbank_executor_e2e.rs` 覆盖；
  - B 路换判等价（false→true +1 / true→false -1 / 写 mastery）：写作期间
    r4-02 已把 pipeline 落库段（`persist_grading_result`）迁移到共享原语，
    并自带 3 个 in-crate 持久化白盒单测（NULL→true 防重复 / false→true /
    true→false）；第 8 轮如需 e2e 级覆盖，可扩展 `qbank_executor_e2e.rs`
    （对同一 submission 连续两次 `builtin-qbank_ai_grade` 不同 verdict），
    对齐上表。

## 三、测试文件与函数清单

### `src-tauri/tests/qbank_verdict_three_paths.rs`（Rust 集成，7 个 `#[test]`）

| 函数 | 覆盖 |
|---|---|
| `manual_regrade_walks_full_transition_table_without_new_attempts` | C 路全转移表：NULL→false→true→true(幂等)→false；attempt 恒 1、submission 恒 1 条、防负、状态 CASE、grading_method='manual' |
| `pending_override_resubmit_merges_into_regrade_without_double_count` | A 路去重分支：待判定 + 同答案 override 重提 = 原地改判同一条 submission，不双计 |
| `decided_override_resubmit_remains_a_real_second_attempt` | A 路边界：已判定后带 override 重提 = 真实新作答（attempt 2、两次答对 → mastered），启发式不误并 |
| `pub_regrade_entrypoint_advances_submission_rowsync_columns` | 公开入口路由到原语的 RowSync 语义：改写推进 updated_at/local_version，同向幂等不推进 |
| `daily_progress_write_back_matches_get_daily_practice` | 改判回写：submit/regrade 响应的 `daily_progress` 权威快照与 `get_daily_practice` 同口径（按题去重、改判翻转当日 correct） |
| `legacy_question_without_submission_rows_still_counts_into_daily` | 旧卡兼容①：无 submission 行的存量题按 `last_attempt_at` 兜底计入 daily，并与新提交按题去重合并 |
| `submit_answer_result_without_daily_progress_field_still_deserializes` | 旧卡兼容②：缺 `daily_progress` 键的旧载荷仍可反序列化（守护 `#[serde(default)]`） |

夹具与既有 `qbank_executor_e2e.rs` 同源：`MigrationCoordinator` 跑生产迁移建
VFS 库 + 生产仓储写入，无 tauri / 无 mockito / 全同步 `#[test]`
（默认 harness，cargo 自动发现，无需 Cargo.toml 注册）。

### `src/stores/__tests__/recordPracticeAnswer.regrade.test.ts`（vitest，14 个 `it`）

describe「recordPracticeAnswer 改判回写（R4 差量修正）」：

1. `daily：待判定(null)改判为对时回补 correct，completed 不重复计`
2. `daily：改判全转移表（true→false 回收、false→true 回补、null→false 零变化），下限 0`
3. `daily：同向重复上报是空操作（连点两次"我答对了"）`
4. `daily：改判不改变 is_completed（达标由题数决定，与判定无关）`
5. `timed：差量口径与 daily 一致（null→true 回补、true→false 回收，answered 不动）`
6. `会话门禁在改判路径同样生效（非会话题目/其他题库的改判被忽略）`

describe「旧会话兼容（旧卡无 R4 daily 字段）」：

7. `旧会话只有 answered_question_ids、无 answered_results 基线：改判保持首答锁 fail-closed`
8. `后端原始 daily payload（无任何前端补充字段）：首答建立基线，随后可改判`
9. `timed 旧会话（有数组无基线）同样保持首答锁`

describe「applyAuthoritativeDailyProgress 权威回写」：

10. `同 exam 同日期：覆盖 completed/correct，is_completed 缺省时按 target 推导`
11. `后端显式 is_completed 优先于本地推导`
12. `跨零点旧会话（日期不一致）：不覆盖并返回 false`
13. `exam 不匹配或无 daily 会话：返回 false 且无副作用`
14. `非法计数（负数/非整数）不覆盖`

基线行为（首答幂等、目标达成、daily_target 持久化）已由
`tests/vitest/question-bank-practice-progress.test.ts` 覆盖，本文件不重复。

## 四、已知风险（第 8 轮执行时注意）

1. 两个文件断言的是 R4 修复后的目标契约；若并行修复在收口前语义有变
   （字段改名、`daily_progress` 挂载路径回退），以修复方最终契约为准调整断言。
2. `daily_progress_write_back_matches_get_daily_practice` 若在本地日界线附近
   （前后两次调用跨零点）可能出现 completed 口径抖动——纯时钟边界，非产品缺陷。
3. B 路换判等价目前无 e2e 级覆盖（原因见第二节），是本轮已知且声明的缺口。
4. mock_exam 的 `results` 改判回写在组件层（`handleMarkCorrect`，r4-05），
   store 级测试无法覆盖，留给组件/CT 层。
