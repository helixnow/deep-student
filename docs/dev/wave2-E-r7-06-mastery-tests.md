# Wave2-E R7-06：mastery 换判纠正集成测试

- 角色：0824 Wave2-E 第 7 轮「mastery 纠正测试」
- 新增文件：`src-tauri/tests/mastery_qbank_correction.rs`（独占，纯测试）
- 未改任何产品代码；未跑测试（round discipline，第 8 轮统一执行）；未 commit。
- 已做 `cargo check --test mastery_qbank_correction` 编译校验：
  通过，新文件 0 warning（仅既有 lib warnings）。编译校验不属"跑测试"，
  用于兑现"最小可编译"要求。

## 1. 被测公开面

pub 自持事务版换判纠正（补偿脚本入口，内部即
`record_qbank_verdict_correction_with_conn`，mastery/service.rs）：

```rust
MasteryService::record_qbank_verdict_correction(
    &self, submission_id, question_id, tags, new_is_correct,
) -> Result<MasteryState, AppError>
```

锁定契约：换判不再被首判幂等键 `me_qbank_{sid}` + ON CONFLICT DO NOTHING
锁死——tombstone 存活旧信号（append-only，只推进同步元数据）+ 追加修订
`me_qbank_{sid}_r{n}`（weight=1 直写）+ 按存活事件重算聚合。

## 2. db fixture：可构造，无需 skip

对照 `tests/qbank_verdict_three_paths.rs` 的同款夹具：
`MigrationCoordinator::migrate_single(DatabaseId::Vfs)` 真实迁移建库 +
`VfsDatabase::new` 打开，不 mock 存储层；`mastery_events` /
`mastery_states` 表由生产迁移建立。互操作测试另用生产仓储
（`VfsExamRepo` / `VfsQuestionRepo`）造题。**未触发 skip 分支。**

一个集成测试特有的约束：in-crate 白盒测试用的时钟覆盖
`set_now_override_ms` 是 `#[cfg(test)]`，tests/ crate 拿不到。本文件因此
只用与挂钟无关的确定性断言——负向信号恒 weight=1、纠正事件绕过
`compute_event_weight_with_conn` 的 60s 防刷衰减直写 weight=1，故
EMA（α=0.30，起点 0.5）两步分数是常数：

- 首判 wrong：0.5 + 0.3·(0.0 − 0.5) = **0.35**
- 纠正后仅存活 `_r1`(correct)：0.5 + 0.3·(1.0 − 0.5) = **0.65**

## 3. 测试函数（3 个）

| 函数 | 场景 | 关键断言 |
|---|---|---|
| `false_to_true_correction_recomputes_state_and_breaks_first_verdict_lock` | record 路首判 wrong → 复现 record 路换向被 DO NOTHING 锁死 → pub 纠正 false→true | 锁死复现（score 停 0.35 / 链仍 1 条）；纠正后 score=0.65、total=1、wrong_count=0、streak=1；base 事件 tombstone 且 outcome 仍 'wrong'（append-only）；`_r1` 存活、outcome='correct'、weight=1 |
| `correction_same_direction_replay_is_idempotent` | 纠正落链后同向重放（补偿脚本重跑） | 不追加 `_r2`、不 tombstone 既有修订、聚合保持 0.65/total=1 |
| `compensation_entry_interops_with_product_written_verdict_chain` | 产品链写首判（`submit_answer` 待判定 + `regrade_submission(false)`）→ 事务外 pub 补偿纠正 true → 产品再同向 regrade(true) | 补偿作用于产品写入的同一条 `me_qbank_{sid}` 链；concept 取题目首个 tag；产品后续同向改判经原语纠正分路幂等短路，链保持 base(tombstone)+`_r1` 恰 2 条（信号不重复计） |

## 4. 与既有测试的分工（不重复覆盖）

- in-crate 白盒 `mastery/service.rs::tests::qbank_verdict_correction_false_to_true_recomputes_state`
  / `..._is_idempotent_and_supports_reflip`：带时钟覆盖的精确链走查
  （含 reflip `_r2`、退化首判）——本文件不重复 reflip/退化分支；
- `tests/qbank_verdict_three_paths.rs`：三路判分的 correct_count/RowSync
  黑盒——本文件不碰计数断言；
- 本文件新增的是跨 crate 的 **pub API** 契约锁定 + 补偿入口与产品判分链
  的同库互操作（此前无任何 tests/ 级覆盖触及 mastery 纠正）。

## 5. 回复

测试函数名（`src-tauri/tests/mastery_qbank_correction.rs`）：

1. `false_to_true_correction_recomputes_state_and_breaks_first_verdict_lock`
2. `correction_same_direction_replay_is_idempotent`
3. `compensation_entry_interops_with_product_written_verdict_chain`

db 可构造（真实迁移夹具），无 skip；文件已通过 `cargo check` 编译校验，
按纪律未运行。
