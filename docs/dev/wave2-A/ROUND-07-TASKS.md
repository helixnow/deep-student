# Wave2-A 第 7 轮（反例测试源码补强，只写不跑）

tip：`618634a6`。模型全是 `claude-fable-5-thinking-high`。禁止执行测试。

| # | 可写 |
|---|---|
| 1 | 强化 `prefix_generation_fork_tests.rs` 终局 |
| 2 | 新建 `prefix_generation_fork_finale_tests.rs`（A/B 后轮同现 X、Y 的稳态） |
| 3 | 强化 `skill_replay_digest_tests.rs` |
| 4 | 新建 `skill_replay_edit_delete_tests.rs` |
| 5 | 强化 `llm_content_crash_tests.rs` |
| 6 | 新建 `llm_content_retry_gap_tests.rs`（记录 retry 窗口，只写预期） |
| 7 | 新建 `src-tauri/src/providers/wave2_a_prefix_snapshot_tests.rs`（三家连续请求 post-adapter 前缀对比） |
| 8 | 新建 `src-tauri/src/providers/wave2_a_anthropic_budget_tests.rs`（四槽/透传，可纯函数测守卫） |
| 9 | 追加 ledger「测试台账」：每个测试文件、预期红/绿、未执行 |
| 10 | 写 `r7-test-inventory.md` 索引 |

pipeline.rs / providers/mod.rs 的 mod 声明由父代理加。不要改产品逻辑。
