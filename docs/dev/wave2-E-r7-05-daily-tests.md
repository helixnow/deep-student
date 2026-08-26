# Wave2-E R7-05：daily 三场景测试（重答/改判/再练 × 权威覆盖）

- 轮次：0824 Wave2-E 第 7 轮
- 独占文件：`src/stores/__tests__/recordPracticeAnswer.regrade.test.ts`（只增不删）
- 约束：未跑测试 / 编译 / CI，未改产品代码，未 commit（第 8 轮统一执行）

## 本轮产出

在 R4 测试源码文件末尾追加一个 describe
「**重答/改判/再练 × 权威覆盖组合（R7）**」，共 4 个 it。旧用例
（R4 差量修正 / 旧会话兼容 / 权威回写门禁三组）全部保留未动，文件头
仅补一行 R7 追加说明。

背景：R6-08 已把 submit/regrade 响应的 `daily_progress` 权威快照接进
真实答题路径（hook 透传 → ExamContentView 在 `recordPracticeAnswer`
之后调 `applyAuthoritativeDailyProgress`），「先乐观差量、后权威覆盖」
成为常态时序。旧用例分别单测两侧，本轮补的是两者交织的组合链路。

## 新增 it 清单（4 个）

1. `daily：重答→权威覆盖→再练全链路（答对后重答答错的本地口径偏差被快照修正，覆盖后新题继续乐观叠加）`
   - 固化 R6-08 记录的已知口径差：本地是「最近判定」口径（答对后重答
     答错会 -1），后端是「当日任一次答对即计」口径（不减）；偏差由
     快照修正，且覆盖后的新题首答在权威值上继续乐观 +1（不双计不丢），
     覆盖后的改判仍走差量、`is_completed` 不回退。
2. `daily：快照灌入会话外已答题（无本地基线）→ 改判是完整空操作（不动计数、不建基线），由下一次权威快照收敛`
   - 关闭重开场景：`answered_question_ids` 由快照灌入、`answered_results`
     无基线。断言改判分支因 `questionId in results` 门禁整体短路——
     不动计数、**也不建基线**（反复改判不漂移）；会话内新题首答不受
     牵连；窄缝由下一次权威快照当场收敛（R6-08 验证建议第 2 条）。
3. `daily：权威覆盖保留 answered_results 基线——覆盖后本会话已答题仍可差量改判，同向重复仍为空操作`
   - 固化 `applyAuthoritativeDailyProgress` 的字段边界：覆盖
     completed/correct/is_completed 与 `answered_question_ids`，
     **不动 `answered_results`**。覆盖后 null→true 回补、同向空操作、
     true→false 回收全部照常。
4. `daily/timed 并行：权威覆盖只作用于 daily，timed 会话计数与重答差量基线不受快照影响`
   - 同一题同时命中两个会话时，快照只覆盖 daily；覆盖后改判 timed 走
     自己的基线正常回收，daily 差量下限 0 不为负。

## 与既有用例的分工

| 既有组 | 覆盖点 | 本轮组补什么 |
| --- | --- | --- |
| R4 差量修正 | 单侧乐观差量全转移表 | 差量与权威覆盖交织的时序语义 |
| 旧会话兼容 | 有数组无基线的 fail-closed 不崩 | fail-closed 之后的**收敛路径**（快照灌入来源 + 再次快照收敛） |
| 权威回写门禁 | apply 的 exam/日期/非法计数门禁 | apply 的**字段边界**（保留 answered_results）与 apply 之后的继续作答 |

## 执行门禁

与 R4 约定一致：本文件只写不跑，第 8 轮统一执行。若第 8 轮跑出偏差，
优先核对第 2 条（空操作断言依赖 `questionId in results` 门禁的短路
实现，`src/stores/questionBankStore.ts` recordPracticeAnswer 已答分支）。
