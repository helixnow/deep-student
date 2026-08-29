# Wave2-A 第 8 轮（首次允许实测）

tip：`c1cde7e3`。模型 1:1：5×`claude-fable-5-thinking-xhigh` + 5×`gpt-5.6-sol-xhigh-fast`。
若本机 `rustc` 不是 1.98.0：立刻停，不要安装，不要空转，把版本写入报告。

1–6 尝试定向测试（环境不行立即停）：
1 tool_loop  2 hooks  3 helpers  4 providers  5 model_special_tokens  6 prefix_snapshot + vitest TauriAdapter
7–9 静态复核测试断言质量
10 追加 ledger 第 8 轮（已验证/未验证诚实）
