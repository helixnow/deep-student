# Wave2-A 第 6 轮任务卡（全面二检）

tip：`4b784bb4`。模型全是 `claude-fable-5-thinking-high`。禁止编译/测试。
每人一面：产出「确认 / 翻案 / 补丁」三选一。有独占文件才允许当轮落地补丁；provider 三席只写文档（同文件冲突）。

| # | 面 | 可写 |
|---|---|---|
| 1 | 代际 | 文档 `r6-gen.md`；补丁限 helpers.rs / multi_variant.rs |
| 2 | 冻结原语 | `r6-freeze.md`；补丁限 tool_loop.rs |
| 3 | llm_content | `r6-llm-content.md`；补丁限 persistence.rs |
| 4 | 技能版本化 | `r6-skill.md`；补丁限 history.rs |
| 5 | 过滤器 | `r6-filter.md`；补丁限 model_special_tokens.rs |
| 6 | 目录生命周期 | `r6-catalog.md`；补丁限 progressiveDisclosure.ts |
| 7 | 遥测 | `r6-telemetry.md`；补丁限 scripts/cache-hit-report.py |
| 8 | provider P0 | 只写 `r6-p0.md` |
| 9 | provider P1 | 只写 `r6-p1.md` |
| 10 | provider P2 + 台账追加 | `r6-p2.md` + ledger 第 6 轮段 |

红线：hooks 准入/TOCTOU/ApprovalGateHook 首位、coordinator、负例测试、#122 不声称修复。
