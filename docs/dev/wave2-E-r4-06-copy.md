# Wave2-E R4-06：每日一练 streak / target 文案（P2-1 选 B 案）

日期：2026-08-26
范围：`src/components/practice/DailyPracticeMode.tsx` + `src/locales/{zh-CN,en-US}/practice.json` 的 `daily.*` 相关词条。
不改 store、不改 ExamContentView、不改后端。

## 背景（P2-1）

每日目标只以「当前值」存在 `localStorage`（`qbank:dailyTarget:<examId>`），**不按天持久化历史**。
而打卡日历的 `target_achieved` 是后端每次按前端传入的 `daily_target` 现算的
（`get_check_in_calendar`：`target_achieved = question_count >= 当前目标`）。
即：用户上月目标是 20、现在改成 5，上月的绿格/对勾会按 5 重新点亮——旧 UI 没有任何提示，
容易被理解成「当天的历史目标达成情况」。

## 决策：B 案

不引入历史目标持久化（那是 A 案，需要动 store/后端），改为**在 UI 上明确命名为「按当前目标查看」**，
并在文案里明说「不代表当天设置过的目标」。

## 实际口径核对（按 store / 后端真实字段，防止谎报）

| UI 数字 | 字段 | 真实口径 |
| --- | --- | --- |
| 完成卡「答对 X / Y」 | `DailyPracticeResult.correct_count` / `completed_count` | 均**按题去重**：后端 `query_daily_progress` 注释「正确数按当日该题任一次答对计」；前端增量更新（store `updatePracticeProgress`）也用 `answered_question_ids` 去重，重做不重复计。是「答对题数」，**不是**正确尝试次数 |
| 日历格「N题」 | `DailyCheckIn.question_count` | 当日做过的**题数**（按题去重，多次作答同一题算一次） |
| 连续打卡 | `CheckInCalendar.streak_days` | 后端 `query_streak_days` 只看「当天有无任何作答记录」，**与目标是否达成无关** |
| 达标对勾/绿格 | `DailyCheckIn.target_achieved` | `当日题数 >= 当前目标`，全月统一用当前目标现算 |

结论：现有数字本来就是「答对题数」口径，不存在把尝试次数冒充答对数的问题；本轮是把口径**写进文案**，
并补上 streak 与目标解耦、达标标记按当前目标的说明。

## 改动明细

### 词条（zh-CN / en-US `practice.json`，均在 `daily.*` 下）

新增：

- `daily.streakHint`：「当天做过题即算打卡，与目标是否达成无关」/ "Any day you practice counts — the streak doesn't depend on hitting the target"
- `daily.targetHint`：「目标只保存当前值，不会按天记录历史；日历达标标记按当前目标判定」/ "Only the current target is saved — no per-day history. Calendar check marks are judged against the current target"
- `daily.viewByCurrentTarget`：「按当前目标查看」/ "Viewed with current target"（日历标题旁 Badge）
- `daily.calendarTargetHint`：「达标标记按当前目标（{{target}} 题）统一判定，不代表当天设置过的目标」/ "Achieved marks use the current target ({{target}} questions) for every day shown, not the target set on that day"

修改：

- `daily.targetLabel`：zh「今日目标（题数）」→「每日目标（题数）」（「今日」暗示按天独立，实际是全局当前值；en 原文 "Daily Target (questions)" 不变）
- `daily.completedDetail`：zh「答对 {{correct}} / {{total}} 题」→「答对 {{correct}} / {{total}} 题（按题计，同一题重复作答不重复计）」；en "{{correct}} / {{total}} answered correctly" → "{{correct}} / {{total}} questions correct (counted per question, not per attempt)"

未动：`daily.title`、`daily.calendar`（标题本身保持「打卡日历」，语义由 Badge + hint 承担）、
`daily.todayProgress`（确实是今日）、`daily.monthDays` / `daily.monthQuestions` / `daily.streak`、
`modeSummary.*`（他人组件在用，且原文不涉及历史目标歧义）。

### 组件（`DailyPracticeMode.tsx`，纯展示层，无逻辑改动）

- streak 卡片：`streakDays` 标签下加一行 `streakHint` 小字
- 目标设置区：输入行下方加 `targetHint` 说明
- 打卡日历 CardHeader：标题旁加 outline Badge `viewByCurrentTarget`；header 下方加 `calendarTargetHint`（插值当前 `dailyTarget`）

## 是否仍像「历史目标」

不再像。日历标题被明确命名为「按当前目标查看」，且 hint 直说「不代表当天设置过的目标」；
目标输入处也声明「不会按天记录历史」。残留的轻微歧义只有绿格视觉本身（颜色无法自带口径），
已由紧邻的 Badge + hint 覆盖。若未来做 A 案（按天持久化目标），删掉这两条 hint 即可。
