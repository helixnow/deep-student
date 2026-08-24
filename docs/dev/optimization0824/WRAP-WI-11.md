# WRAP-WI-11：Provider Quirks 阶段 1 落地报告

> 代理：SA-WRAP-WI11  
> 模型：`gpt-5.6-sol-xhigh-fast`  
> 基线：`cursor/optimization0824-5575` @ `d8d7e6fe`  
> 工作分支：`cursor/wi11-provider-quirks-5d64`  
> 日期：2026-08-24

## 交付范围

阶段 1 的 11-1a～11-1d 已全部落地：

- 新增 `src-tauri/src/llm_manager/provider_quirks.rs`，集中解析
  max-token 字段、采样参数、Qwen tool-result、DeepSeek 服务端搜索、GPT JSON
  格式、reasoning 回传及运行期 reasoning 覆盖策略。
- S1～S4 与 B1～B3 已迁移；`model2_pipeline.rs` 中的
  `is_mimo_config`、`is_mistral_config`、`is_qwen_config`、
  `is_mimo_endpoint` 已删除。
- B4/B9 统一消费 `reasoning_passback`，B13 两处统一消费
  `force_json_response_format`。
- S7 白名单集中到 `FORCED_REASONING_MODEL_PATTERNS` 及边界匹配表，
  保留原有 GPT-5、Codex、gpt-oss、o1/o3/o4 行为。
- 连通性测试的 MiMo 判定改由 `EndpointQuirks` 提供。

## 回归基线

落盘两组无网络快照：

- `provider_quirks_phase1.json`：4 协议 × 官方/第三方 × reasoning 开关，
  共 16 组 `resolve_quirks` 输出。
- `provider_requests_phase1.json`：相同 16 组配置经真实
  `prepare_provider_request` 后的 URL、header 键集和 body 顶层键集。

另有表驱动单测覆盖 MiMo、Mistral、Qwen、DeepSeek 官方与第三方，以及
S7 强制/可关闭 reasoning 模型。

## 验证门禁

交付分支以以下 cargo 测试范围作为验收：

```text
cargo test --lib provider_quirks
cargo test --lib reasoning_policy
cargo test --lib llm_manager::model2_pipeline
```

本轮未修改 `src-tauri/src/chat_v2/pipeline/tool_loop.rs`，阶段 2～4 也未提前实施。
