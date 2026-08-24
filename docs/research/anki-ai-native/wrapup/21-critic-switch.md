# ChatAnki grounded critic 公开开关

## 结论

`builtin-chatanki_run` 与 `builtin-chatanki_start` 现在公开可选参数
`enableCriticPass`。它只负责启用既有 grounded LLM critic，不改写 critic 引擎。

- 缺省：关闭；Rust 参数为 `None`，下游按 `false` 解释，不收集金标、不调用 critic 模型。
- 显式 `false`：保持关闭，并以 `Some(false)` 写入生成 options。
- 显式 `true`：以 `Some(true)` 写入 `options.enable_critic_pass`；现有 streaming
  成功收尾路径随后执行 grounded critic。
- Rust 解析层兼容 snake_case alias `enable_critic_pass`；公开 Schema 使用
  `enableCriticPass`。
- `enable_llm_critic` 继续只作 critic 内部兼容别名，ChatAnki 不同时写两个开关。

## Agent 使用纪律

该开关默认关闭。只有用户明确要求“质检”“复审”或“critic”时，Agent 才传
`enableCriticPass=true`。普通制卡、默认 `wait -> get_cards` 验收流程或 Agent
自行认为内容重要，都不构成开启理由。

critic 会增加一次模型评审调用；模型失败、超时或非法输出仍沿用既有
fail-open 行为，降级为全部 keep。写回继续使用送审快照 CAS，不能覆盖评审期间的
用户编辑。

## 接线

```text
run/start enableCriticPass
  -> ChatAnkiRunArgs / ChatAnkiStartArgs
  -> ChatAnkiGenerationTuning.enable_critic_pass
  -> AnkiGenerationOptions.enable_critic_pass
  -> streaming 收尾的既有 CriticOptions / run_critic_pass
```

没有公开 critic token 预算、Sidekick 路由或 `enable_llm_critic`；本次只增加一个
最小布尔入口。

## 契约测试

Rust 单测覆盖 run/start 省略默认关闭、camelCase 与 snake_case alias 显式开启、
非布尔值拒绝，以及 `build_generation_options` 对 `None`、`Some(false)`、
`Some(true)` 的精确透传。

Vitest 契约覆盖 run/start 精确字段清单、默认 `false` 的 boolean Schema、非布尔值
拒绝、参数保持可选、只在 allowlisted run/start 上公开，以及“仅用户明确要求才开启”
的 skill 文案。
