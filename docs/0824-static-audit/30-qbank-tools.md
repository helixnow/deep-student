# 30 — qbank-tools 压缩 + daily_target 1..50 静态审计

- 对照分支:`origin/cursor/0824-cde6`(当前工作区检出内容,纯静态阅读,未运行 git/gh、未执行测试)
- 审计对象:
  - `src/features/chat/skills/builtin-tools/qbank-tools.ts`(技能定义,v2.2.0,30 个 embedded tools)
  - `src-tauri/src/chat_v2/tools/qbank_executor.rs`(Agent 工具执行器)
  - `src-tauri/src/question_bank_service.rs` / `src-tauri/src/commands.rs`(服务层与 Tauri 命令层)
  - `src/components/practice/DailyPracticeMode.tsx` / `src/stores/questionBankStore.ts`(UI 面板与交接水合)
  - `tests/vitest/chat-v2/token-budget.test.ts`、`src/features/chat/skills/__tests__/phase4QbankToolsContract.test.ts`、`tests/vitest/question-bank-practice-handoff.test.ts`(护栏与契约测试)

## A. qbank-tools 压缩审计

### A1. Token 预算护栏

`tests/vitest/chat-v2/token-budget.test.ts` 记录了 R2–R4 三轮 description 精简后的基线:qbank-tools 仍是全部 43 组中最大的单组,schema ≈ 6172 tokens(chars/4 口径);护栏收紧为 `MAX_SINGLE_GROUP_SCHEMA_TOKENS = 6800`、`MAX_TOTAL_SCHEMA_TOKENS = 51500`、`MAX_TOTAL_TOKENS = 75500`,约 10% 余量,并注明越线须有意识上调并在 R4-WI-10 进度文档记录原因。护栏语义清晰,能防止精简成果被增量回吃。qbank-tools 单组余量约 628 tokens(≈10%),后续再往该技能加工具或加长描述空间有限,属已知且被测试守护的状态。

### A2. 压缩后语义保真

抽查压缩后的工具描述与技能正文,治理关键信息均保留、未被压缩掉:

- 风险分级与授权:`qbank_delete_questions` 描述仍完整保留「High、当前 Agent 不可恢复、每次调用前必须 ask-user、授权永不记忆、无人值守不得执行」;创建/更新/收藏的 `reversible` 语义(`reversibleWithApproval` / `reversibleWithOcc` / `reversible=true`)在正文「并发与撤销」与各工具描述中一致。
- OCC 纪律:更新/删除/收藏/书签均要求先读 `updated_at`,批量操作以 `question_id` 为键传完整版本映射,与执行器实现一致。
- 截断与分页:2000 字符字段截断、单页最多 20 条、`has_more`/`truncated` 口径在描述与正文重复声明,防止把截断预览当全文。
- UI 混合模式:timed/mock/daily 三个工具描述均含 `agentCanAnswer=false`、`handoff_persisted=true`、`payloadHydrationSupported=true`、「不会自动打开 UI」;`phase4QbankToolsContract.test.ts` 对这些关键词逐一 `toContain`/`toMatch` 断言,压缩若误删关键词会直接红灯。

结论:压缩由 token 预算测试(体积上限)+ phase4 契约测试(语义下限)双向夹住,当前文件两侧均满足,未发现语义丢失。

## B. daily_target 1..50 链路审计

按层核对范围、默认值与钳制方式:

| 层 | 位置 | 范围/默认 | 说明 |
| --- | --- | --- | --- |
| Agent schema:`qbank_get_daily_practice.count` | `qbank-tools.ts` L731 | 1..=50,默认 10 | 描述注明「与练习面板的每日目标范围一致」 |
| Agent schema:`qbank_get_check_in_calendar.daily_target` | `qbank-tools.ts` L746 | 1..=50,可选,缺省 10 | 「跟随用户每日一练目标」 |
| 执行器:每日一练 | `qbank_executor.rs` L3540 | `read_strict_u32("count", 10, 1, 50)` | 注释说明此前封顶 20 导致用户目标 21–50 无法交给 Agent 续练,已修复 |
| 执行器:打卡日历 | `qbank_executor.rs` L3588–3598 | `(1..=50).contains` 严格校验,越界报 `INVALID_ARGS`「daily_target 必须是 1..=50 的整数」 | `None`/`Null` 透传给服务层缺省 |
| 服务层:日历达标判定 | `question_bank_service.rs` L2847 | `unwrap_or(10).max(1)`,无上限钳制 | doc 注释记录此前硬编码 10 的两类误判(目标 5 做满不达标 / 目标 20 做 10 题反达标) |
| 服务层:每日一练 | `question_bank_service.rs` L2516 | 仅拒绝 `count == 0`,无上限钳制 | 上限由执行器(Agent 路径)与 UI(面板路径)保证 |
| 命令层 | `commands.rs` L6742/L6788 | 直通,不做范围校验 | `daily_target: Option<u32>` 带 `#[serde(default)]` |
| UI 面板 | `DailyPracticeMode.tsx` L68–70、L302–303 | `normalizeDailyTarget` 钳制 5..=50,默认 10,按题目集 localStorage 持久化 | Input `min=5 max=50` |
| 交接水合 | `questionBankStore.ts` L726 | `practiceInteger(session.daily_target, 1, 50)` | 注释记录此前上限 20 会把目标 21–50 的合法交接误判为无效,已修复 |
| 后端单测 | `question_bank_service.rs` L4096–4101 | `daily_target=5` 场景断言进度去重与未达标判定 | — |
| 契约测试 | `phase4QbankToolsContract.test.ts` L166–170 | 断言 `count` schema `{minimum:1, maximum:50, default:10}` | — |

链路判定:Agent 路径(schema 1..=50 → 执行器严格 1..=50 → 服务层)与面板路径(UI 钳 5..=50 → 命令层直通 → 服务层)口径一致且 Agent 范围是 UI 范围的超集,交接水合按 1..=50 收敛,`R1-06-exam.md` 中记录的「UI 5–50 vs 交接校验 1..20 口径分裂」问题在本分支已闭环。默认值 10 在 schema、执行器、服务层、UI 四处一致。

## C. 发现(均为低危/信息级)

1. **[措辞,极低]** `qbank_get_daily_practice.count` 的 schema 描述称与练习面板范围「一致」,实际是超集(Agent 下限 1,面板下限 5);Rust 侧注释用「对齐/兼容」更准确。纯文案,不影响行为。
2. **[测试覆盖,低]** 交接水合修复(20 → 50)缺 21..=50 正例回归:`question-bank-practice-handoff.test.ts` 的 daily 用例仅用 `daily_target: 2`,若上限被回退到 20 只有 store 注释与契约测试(schema 侧)能间接拦截,水合侧无直接红灯。
3. **[纵深防御,信息]** 服务层与命令层均无 50 上限钳制(`get_daily_practice` 仅拒 0;`get_check_in_calendar` 为 `unwrap_or(10).max(1)`)。命令边界为可信 UI 且 UI 已钳 5..=50,Agent 路径由执行器严格校验,当前无实际暴露面;仅当未来新增第三方调用路径时需补上限。
4. **[测试覆盖,信息]** phase4 契约测试未对 `qbank_get_check_in_calendar.daily_target` 的 `minimum/maximum` 做断言(daily `count` 有);执行器侧 Rust 校验存在,风险仅为前端 schema 无声漂移。

## 结论

- qbank-tools 压缩状态健康:体积被 token 预算护栏(单组 6172/6800,≈10% 余量)约束,语义被 phase4 契约测试约束,抽查未发现治理关键信息(风险分级、ask-user 门禁、OCC、截断/分页、UI 混合模式语义)在压缩中丢失。
- daily_target 1..=50 全链路口径一致:Agent schema、执行器严格校验、交接水合上限、UI 钳制(5..=50 子集)、默认值 10 与达标判定缺省全部对齐,历史上的 1..20 交接误判与硬编码 10 达标误判均已在本分支闭环,并有后端单测与契约测试守护。
- 上述 4 项发现均为文案、测试覆盖或纵深防御层面的低危/信息级事项,无功能性缺陷、无安全暴露面,不构成改码必要条件。**本轮不改代码**。
