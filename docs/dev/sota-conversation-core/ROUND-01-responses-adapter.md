# 第一轮补充：OpenAI Responses 适配器

来源：[Responses adapter audit](6de9f30f-2bd1-4bea-9033-65139f5adb0c)

与父代理预审一致：高质量兼容层 + 局部原生（stateless encrypted reasoning、`store:false`、DeepSeek web_search、Codex 通道）。

## 新增、必须修的正确性点

1. **多 reasoning item 回放不保真**（高）：`on_response_reasoning_item` 单值覆盖，且绑到本轮第一个 tool_call。
   交错结构 `reasoning→call1→reasoning→call2` 回放序错，可能 400
   （`reasoning item without required following item`）。
2. **非工具轮不回放上一轮 encrypted reasoning**（中）：普通多轮只回放文本。
3. **流式粒度落后 Codex 桥**：主适配器无 `output_item.added` / `function_call_arguments.delta`，
   `openai_codex/protocol.rs` 桥里反而有。长工具参数期间前端像卡死。
4. `web_search_call.in_progress` 被误标成 `searching`（官方事件无 stage 字段）。
5. 转换丢 `top_p`；`reasoning.summary` 强制 `auto`。

usage / `prompt_cache_key` / `previous_response_id` 与既有 DESIGN 重复，不另列。
OpenAI 官方 hosted `web_search` 仍被 DeepSeek 门控拦住，列为 P2，不是 DeepSeek 回传问题。
