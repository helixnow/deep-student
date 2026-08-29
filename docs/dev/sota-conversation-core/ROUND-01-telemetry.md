# 第一轮补充：缓存命中遥测

来源：[Usage cache telemetry](414d5fd1-4b9c-440f-ad1b-f70d7f4c4439)（`claude-fable-5-thinking-xhigh`）

## 结论

「未测量」和「命中率 0」在数据里不可区分。Responses / Anthropic 流式 / Gemini 流式会把真实断裂掩盖成一条永远为 0 的基线。

## 已交叉验证

- OpenAI CC：`prompt_tokens_details.cached_tokens` 读对了。
- DeepSeek CC：`prompt_cache_hit_tokens` 读对了。
- OpenAI / DeepSeek Responses：`input_tokens_details.cached_tokens` 全仓库未读。两条解析链
  （`llm_adapter.rs` `parse_api_usage`、`model2_pipeline.rs` `extract_usage_tokens`）都缺。
- Anthropic 流式：`message_start` 有 `cache_read_input_tokens`，终态 `message_delta` 通常只有
  `output_tokens`；`build_merged_usage_event` 不回填 cache，消费端又用最后一次 usage 覆盖。
- Anthropic 非流式：`convert_anthropic_response_to_openai` 丢掉 cache 字段。
- Gemini：仅非流式把 `cachedContentTokenCount` 映到顶层；流式只躺在 `original` 子对象。
- 官方 OpenAI CC 流式未发 `stream_options.include_usage`，直连官方时整份 usage 可能缺失。
- `token_source` 落库硬编码 `'api'`，估算行伪装成实测。
- `adapter` 列永远 NULL，报告无法按协议拆；`cache-hit-report.py` 把 NULL 当 0 计入分母。

## 对 DESIGN 的增量

在原有 P0「读 `input_tokens_details`」之外，还必须：

1. Anthropic usage 做字段级合并，而不是终态整包覆盖。
2. Gemini 流式把 `cachedContentTokenCount` 抬到顶层 `cached_tokens`。
3. `record_llm_usage` 真实写入 `token_source` 与协议/adapter。
4. OpenAI CC 请求补 `stream_options.include_usage`。
5. 报告把「cached 全 NULL」显示为「无测量」，不要显示 0%。
