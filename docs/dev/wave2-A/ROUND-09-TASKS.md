# Wave2-A 第 9 轮（扫尾）

- tip：`dd300cd3`（第 8 轮停测记录）
- 官方基座：`origin/cursor/0824-cde6` @ `061b4815`（本轮开轮已 fetch，未前进）
- 模型 1:1：#1–#5 = `claude-fable-5-thinking-xhigh`；#6–#10 = `gpt-5.6-sol-xhigh-fast`
- 允许实测，但本机仍是 **rustc 1.83.0 / 无 node_modules**。环境不行立即停：
  不要装 Rust 1.98、不要 `npm install`、不要空转 cargo/npm。
- 同文件同轮单人。产品逻辑大改禁止；本轮只收口文档/注释/死代码属性/台账。
- 禁止碰：`coordinator.rs`、Composer 移动热区、桌面 Composer 行为、Anki 算法、
  hooks 准入序列 / TOCTOU、负例测试、整支 merge。
- 禁止声称修了 issue #122。禁止标 Goal complete。
- 本席不 commit / 不 push / 不改 PR #345 正文（父代理收轮）。

| # | 模型 | 独占可写 | 任务 |
|---|---|---|---|
| 1 | xhigh | `history.rs`（仅 compat 入口属性/注释）+ `docs/dev/wave2-A/r9-open-items.md` | 遗漏项分类闭合表 + 小问题 C dead_code 属性 |
| 2 | xhigh | `docs/dev/wave2-A-agent-architecture.md`（只追加勘误节，不改写更早节正文） | 架构文档勘误 + B2/B4/B7 状态补记 |
| 3 | xhigh | `stream_filter_core.rs`（仅文件头）+ `docs/dev/wave2-A/r4-catalog-delta.md`（只追加勘误节） | 骨架文档改口 + 目录键名勘误 |
| 4 | xhigh | `tool_loop.rs` 文件头 rustdoc（:1-39） | 冻/不冻/切代矩阵按 R3–R6 现状改口 |
| 5 | xhigh | `docs/dev/wave2-A/r2-freeze-matrix.md`（只追加）+ 新建 `r9-clear-freeze-matrix.md` | 清什么/不清什么 + 冻什么/不冻什么终稿 |
| 6 | sol-xhigh-fast | `model2_pipeline.rs`（仅 fingerprint 注释）+ `docs/dev/wave2-A/r9-dead-code.md` | 死代码扫 + R5-M2-1 注释改口 |
| 7 | sol-xhigh-fast | `docs/dev/wave2-A/r9-write-only.md` | 只写字段最后一扫（只报告，不删序列化字段） |
| 8 | sol-xhigh-fast | `docs/dev/wave2-A/r9-i18n.md` | 本会话新增日志/文案一致性 |
| 9 | sol-xhigh-fast | `docs/dev/wave2-A/r9-pr-body.md` | PR 描述初稿（已验证/未验证诚实清单） |
| 10 | sol-xhigh-fast | `docs/dev/wave2-A-ledger.md`（只追加第 9 轮） | 组装 + grep 红线自证 + 轮末台账 |
