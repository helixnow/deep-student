# Deep Student 0824 供应商适配器 / 协议接线质量评审

对比范围：`v0.9.44`（`1cf6cabc`）→ `origin/cursor/0824-cde6`（`2d41ea8b`）。只评 `src-tauri/src/adapters/**`、`src-tauri/src/providers/**` 的真实 diff；不重复模型目录结论。

## 结论

这轮改造不是简单加字段。OpenAI Responses 的 function call 增量、reasoning item 顺序与去重、服务端 web search 回放，以及 Anthropic/Gemini 缓存用量观测，都补到了协议层，且多数有针对性夹具。

但当前应判 **FAIL，不能把这一块作为稳定协议层验收**：

1. **P0：GPT-5.6+ Responses 请求发送了错误类型的 `prompt_cache_breakpoint`，官方端点会拒绝典型请求。**
2. **P1：Chat Completions 刚请求 `include_usage`，解析器就在 `finish_reason` 提前发 `Done`，会跳过官方随后才发送的 usage chunk。**
3. **P1：`stream_options` 和 GPT-5.6 专属字段都缺少端点/能力门控，通用兼容网关承担新增 400 风险。**
4. **P2：Anthropic 自动缓存与显式断点的组合方向正确，但没有管理四个断点槽位，工具断点的“保留调用方标记”分支实际上不可达。**

## 改造中做对的部分

### Responses 流式工具调用已从“等终态”提升为真正的增量协议

`OpenAIResponsesAdapter` 新增按 item id 保存的 `pending_function_calls`，能处理 `output_item.added`、`function_call_arguments.delta/done`、缺失终态 arguments 的缓冲回填，并按 call id 阻止 `output_item.done` 与最终 response 重复发射（`src-tauri/src/providers/mod.rs:626-643,1053-1172,1873-2020`）。

这不是只多认几个事件名：开始块带 id/name，参数块不带 id 并按 index 追加，终态再用完整值收口，和现有消费语义能够对上。对应测试覆盖 added → 两个 delta → done、done 缺 arguments、终态去重（`:4751-4840`），质量较好。

### 多 reasoning item 的顺序和去重修正是实质性的

旧实现以单个布尔状态判断“是否见过 reasoning item”，一旦流中先出现一个 item，终态中的后续 item 可能整体被跳过。本轮改为按 item id 去重，并在终态按 `response.output` 原序交错发出 reasoning 与 function call（`:717-781,2051-2056`）。测试同时覆盖两个 reasoning/tool round 的相邻顺序，以及“第一个已流出、第二个只在终态出现”的补发（`:5532-5622`）。

### Web search 不再只做 UI 状态，开始保留可回放协议对象

新增逻辑把完整 `web_search_call` item 放入 `WebSearchCall.item`，下一轮从 assistant metadata 原样插回 Responses `input`（`:1258-1329,1442-1454`）。这对无状态 Responses 端点是必要数据，而不是展示附属物。测试覆盖完整 item、合成 annotations 载荷不得冒充可回放 item，以及历史回放顺序（`:4902-4995`）。

### 缓存用量观测的字段归一化总体正确

- Anthropic 从 `message_start` 保存完整 usage，再与 `message_delta` 按字段合并，避免终态只带 output tokens 时丢失 cache read/write（`:2156-2188,2636-2653`）。
- `build_usage_event` 区分“字段缺失”和“实测为 0”，并统一读取 Anthropic、Chat Completions、Responses、DeepSeek 的 cache/reasoning 字段（`:3315-3417`）。
- Gemini 流式 `usageMetadata.cachedContentTokenCount` / `cacheReadInputTokens` 被提升为 `cached_tokens`，且缺字段时不伪造 0（`src-tauri/src/adapters/gemini-openai-converter.rs:1105-1156`）。
- 空工具名在请求发出前被剔除，同时保留无 name 的合法内置工具，修复范围没有误伤 `{"type":"web_search"}`（`src-tauri/src/providers/mod.rs:436-519`）。

这些修改说明本轮对“线上真实协议分片”和“缺失不等于零”有正确认识。

## 阻断问题

### P0：GPT-5.6+ 显式缓存断点的线上 JSON 形状错误

`convert_to_responses_format_for_endpoint` 遇到 GPT-5.6+ 和 system 指令时，会把指令改成 developer input，并写：

```json
{
  "type": "input_text",
  "text": "...",
  "prompt_cache_breakpoint": true
}
```

实现位于 `src-tauri/src/providers/mod.rs:1484-1501`，测试也明确断言值为布尔 `true`（`:4998-5018`）。

但 OpenAI 当前官方契约要求的是对象：

```json
"prompt_cache_breakpoint": { "mode": "explicit" }
```

见 [OpenAI Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching) 与 [Chat API reference](https://developers.openai.com/api/reference/resources/chat)。因此测试不是在保护正确协议，而是在固化错误 wire shape。典型聊天请求都有 system 指令，这使 GPT-5.6+ Responses 主路径直接面临 400，而不只是缓存未命中。

能力门控也过宽。`model_supports_prompt_cache_breakpoint` 只在任意位置查找 `gpt-` 并解析版本（`:668-695`），完全不看已经传入 converter 的 `base_url`；`not-gpt-6`、第三方部署别名或尚未实现该扩展的 Responses 网关都可能被注入 OpenAI 专属字段。相反，同一 adapter 对供应商 reasoning 扩展已经会按 hostname 放行（`:653-665,1613-1621`），缓存断点应采用同样的“型号能力 × 端点能力”边界。

修复要求：

1. 使用官方对象形状，不再发送 boolean；
2. 只对确认支持该字段的端点/能力配置启用，不能靠 model substring 决定；
3. 对官方 GPT-5.6、第三方同名部署、名称中偶然含 `gpt-6` 分别做请求快照测试；
4. 测试应断言完整 wire body，而不是只断言本地 helper 返回 true。

### P1：`include_usage` 与提前 `Done` 相互抵消

本轮对所有流式 `OpenAIAdapter` 请求自动补
`stream_options.include_usage=true`（`:122-135`），目标是拿到缓存命中数据。

官方 Chat Completions 流的顺序却是：

1. 普通 choice chunk，倒数第二个 choice 带 `finish_reason`；
2. 额外 usage chunk，`choices: []`；
3. `data: [DONE]`。

[OpenAI streaming reference](https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events) 明确说明 usage 只在最后的空 choices chunk 中出现。

当前 parser 在看到非空 `finish_reason` 时立即发 `StreamEvent::Done`（`:262-267`）。`Done` 的协议语义就是消费结束，所以下一个 usage-only chunk 不会再被消费；刚加入的 `include_usage` 在官方正常序列中反而拿不到目标数据。

测试没有覆盖这条真实序列。`:3748-3762` 把 usage 人工放进带 `finish_reason` 的同一个 chunk，`:5980-6016` 又只检查请求体是否加字段；两组单测分别通过，却没有证明“请求字段 → 多 chunk 解析 → 最终 usage”闭环。

应把“choice 已完成”和“流已完成”分成两个状态：

- 请求 usage 时继续读到 usage chunk / `[DONE]`；
- 兼容没有 `[DONE]` 的网关时，记录已见 `finish_reason`，在 EOF 再裁决成功，而不是提前终止读取；
- 增加 `finish_reason → choices:[] + usage → [DONE]` 的完整事件序列测试，并断言 usage 在 Done 之前。

### P1：通用 OpenAI-compatible adapter 无条件下发 `stream_options`

`OpenAIAdapter::build_request` 接受任意 `base_url`，但新增逻辑只判断 `stream=true`，没有官方 hostname、provider capability 或 quirks 门控（`:110-135`）。测试也只使用 `https://api.openai.com/v1`，没有不支持该字段的兼容端点负例。

这会把一个观测增强变成请求可用性风险：严格校验未知字段的兼容供应商会直接 400。尤其该类用户选择的通常正是通用 Chat Completions 协议，不能假设“路径兼容”就等于“扩展字段兼容”。

应由供应商能力决定是否发送 `stream_options`；未知端点默认不注入，或在明确识别“unknown field: stream_options”后做一次去字段重试。不能为了拿 usage 让正文请求失效。

### P2：Anthropic 断点策略缺少槽位治理，工具 marker 保留逻辑是死分支

本轮同时：

- 保留顶层 automatic `cache_control`；
- 在 system 稳定尾部补 explicit breakpoint；
- 在最后一个 tool 上再补 explicit breakpoint（`:2313-2348`）。

这与 Anthropic 官方“automatic 可和 explicit 共用”的方向一致。但官方最多四个写入断点，automatic 自身占一个槽；四个 explicit 再叠 automatic 会 400。当前实现只判断 system 中“是否存在任意 marker”，不计已有 marker 数量，也不为 automatic 预留槽位。调用方若已有三个 system marker，再由 adapter 添加一个 tool marker与顶层 automatic，就得到五个槽位。

工具侧的 `has_marker` 检查也没有实际作用：`convert_tool_definition` 无论输入是否带 marker，都把 `cache_control` 初始化为 `None`（`:3178-3212`），因此调用方指定的工具断点会被丢掉，adapter 再强制把断点移到最后一个工具。

这里应先规范化调用方 marker，再统一分配最多四个槽位：

1. 转换工具定义时保留并校验已有 `cache_control`；
2. 统计 system/tool/message 的 explicit markers；
3. 开启 automatic 时只保留最多三个 explicit；
4. 对 TTL 冲突和超额断点在本地给出可定位错误，避免交给远端 400；
5. 增加“已有多个 system/tool marker”的边界测试。

## 最终处置

建议按以下顺序修：

1. 先把 GPT-5.6+ `prompt_cache_breakpoint` 改成官方对象形状，并加入端点能力门控；
2. 再修 Chat Completions 的终止状态机，确保 final usage chunk 不被提前 Done 截断；
3. 将 `stream_options` 从通用默认字段改为供应商能力；
4. 最后收敛 Anthropic cache marker 的保留、TTL 与四槽预算。

完成前，这一块虽然在 Responses 工具流、reasoning 回放和用量归一化上明显强于 v0.9.44，但新增缓存接线同时包含一个确定的官方请求格式错误和一个确定的流终止顺序错误，不能判 PASS。

本评审为静态源码与协议契约复核；按要求未运行编译或门禁。
