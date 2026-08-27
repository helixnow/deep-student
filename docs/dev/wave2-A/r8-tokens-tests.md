# Wave2-A 第 8 轮 #5 — model_special_tokens 定向测试记录

- 日期：2026-08-26 (UTC)
- 模型：claude-fable-5-thinking-xhigh
- 基线：枝 `cursor/0824-wave2-agent-cache-a875` tip `c1cde7e3`（与任务卡一致）
- 任务：定向实测 `utils/model_special_tokens.rs` 内联套件（:639–:863，17 条，
  含 r6 #5 tail-hold 泄漏回归 `strips_tail_glued_closer_followed_by_blank_lines_at_flush`）
- 前置检查：`rustc --version`

## 结果：未执行测试（环境版本不符）

```
rustc 1.83.0 (90b35a623 2024-11-26)
cargo 1.83.0 (5ffbef321 2024-10-29)
```

要求版本为 1.98.0，实际为 1.83.0。按本轮约束立刻停：

- 未执行 rustup / 安装 / 升级；
- 未运行 cargo test / cargo check；
- 未改任何测试或产品代码；
- 未 commit / push。

model_special_tokens 套件验证欠账保持不变（自 r4 #2 起累计零执行，
见 `r7-test-inventory.md` §4）。记录版本后停止。
