# Wave2-A 第 10 轮（终检交付）

- tip：`659b8c54`（第 9 轮扫尾已 push）
- 官方基座：`origin/cursor/0824-cde6` @ `061b4815`
- 模型 1:1：#1–#5 = `claude-fable-5-thinking-xhigh`；#6–#10 = `gpt-5.6-sol-xhigh-fast`
- 允许实测，但本机仍是 **rustc 1.83.0 / 无 node_modules**。环境不行立即停：
  不要装 Rust 1.98、不要 `npm install`、不要空转。
- 同文件同轮单人。本轮以文档终检为主，禁止新开大产品面。
- 禁止碰：`coordinator.rs`、hooks 准入/TOCTOU、负例测试、整支 merge、#122「修复」。
- 保持 Draft；转正由人工决定。本席不 commit / 不改 GitHub PR 正文。

| # | 模型 | 独占可写 | 任务 |
|---|---|---|---|
| 1 | xhigh | `docs/dev/wave2-A/r10-review-concurrency.md` | 全 PR 交叉终审：并发/锁序/IMMEDIATE |
| 2 | xhigh | `docs/dev/wave2-A/r10-review-replay.md` | 全 PR 交叉终审：重放/digest/llm_content |
| 3 | xhigh | `docs/dev/wave2-A/r10-review-protocol.md` | 全 PR 交叉终审：provider 协议 |
| 4 | xhigh | `docs/dev/wave2-A/r10-review-frontend.md` | 全 PR 交叉终审：目录生命周期/TauriAdapter |
| 5 | xhigh | `docs/dev/wave2-A/r10-redlines.md` | 红线 grep 自证（hooks/负例/coordinator） |
| 6 | sol-xhigh-fast | `docs/dev/wave2-A/r10-cache-hit-static.md` | 改造前后前缀断裂点静态推演 |
| 7 | sol-xhigh-fast | `docs/dev/wave2-A/r10-residual-risks.md` | 遗留风险清单 |
| 8 | sol-xhigh-fast | `docs/dev/wave2-A/r10-pr-body.md` | PR 描述定稿（已验证/未验证） |
| 9 | sol-xhigh-fast | `docs/dev/wave2-A-ledger.md` 只追加终版节 | 台账归档 |
| 10 | sol-xhigh-fast | `docs/dev/wave2-A/r10-delivery.md` | 组装十席 + 交付清单（不 commit） |
