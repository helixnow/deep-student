model=claude-fable-5-thinking-xhigh
# 38 — utf8_stream 调用方与 model_special_tokens 生产接入审计

审计范围：`llm_manager/utf8_stream.rs`（增量 UTF-8 解码器）的全部调用方，
所有 `bytes_stream()` 文本流入口是否绕过该解码器；以及
`utils/model_special_tokens.rs`（GLM/Qwen 协议 token 流式过滤器）在生产管线
的接入点、policy 解析、flush/reset 时机与未覆盖路径。静态审计，未运行代码。

## 结论

**PASS（带 3 条低危/信息级发现）。两条链路的生产接入完整，未发现会造成
用户可见乱码或 token 泄漏回归的缺口；发现的问题属于实现重复与覆盖口径
不一致，建议后续收敛。本轮不改代码。**

1. `Utf8StreamDecoder` 的**唯一**直接调用方是 `utils/sse_buffer.rs::SseEventBuffer`
   （字节入口 `process_bytes` / 收尾 `flush`）。全部 7 条 LLM 流式生产管线
   （chat 主管线、题目解析、作文评分、题库评分、翻译、VLM grounding、Anki 制卡）
   均以 `SseEventBuffer` 作为字节入口，且都有流末 flush 收尾。模块注释
   `utf8_stream.rs:12-14` 宣称的"所有 LLM 流式管线统一使用"与实际一致。
2. 逐一核查其余 `bytes_stream()` / `from_utf8_lossy` 调用点：没有第二条
   "逐 chunk lossy 解码 LLM 文本流"的路径。Codex OAuth/错误体是**整体收集后**
   一次性 lossy 解码（无跨 chunk 切断问题）；MCP SSE 传输由
   `reqwest_eventsource` 在库内完成增量 UTF-8 解码后才进 `SseLineBuffer`
   （接收 `&str`）；其余均为子进程输出、二进制下载或文档解析，与本题无关。
3. `ModelWrapTokenStreamFilter` 在 chat_v2 的单变体（`tool_loop.rs:549-567` →
   `ChatV2LLMAdapter`）与多变体两条入口（`multi_variant.rs:810-827`、
   `1188-1205` → `VariantLLMAdapter`）全部接入。policy 由
   `for_provider_model(provider_type, provider_scope, model)` 从当前 API 配置
   解析，配置解析失败时兜底 `Disabled`（保守方向正确：宁可不删）。
   过滤顺序正确（wrap filter → think-tag 解析），`finalize_all_inner` 把
   filter `flush()` 尾巴回注 think-tag 缓冲，`reset_for_new_round` /
   `reset_stream_state` 均重置 filter，权威 content 取自过滤后的累积文本
   而非未过滤的 `_final_text`。
4. **发现 A（低）**：`streaming_anki_service.rs:45-51` 自带一份与
   `utils/model_special_tokens.rs:8-14` 完全相同的 `MODEL_SPECIAL_TOKENS`
   常量，并实现了独立的收尾清理（`strip_model_special_tokens`），未复用共享
   模块。两份 token 清单当前一致，但存在漂移风险；且 Anki 的清理不做
   GLM/Qwen 路由门控（无条件执行），与 chat 的 policy 口径不同——因其语义
   保守（仅剥纯 token 残片/JSON 外包装），实际风险低。
5. **发现 B（低）**：wrap filter 只挂在 `on_content_chunk`；
   `on_reasoning_chunk` 与工具参数 delta 不过滤。翻译、作文/题库评分、
   VLM grounding 四条管线完全没有 special-token 清理（它们共享
   `SseEventBuffer` 但不共享过滤器）。若 GLM/Qwen 在这些管线泄漏 token，
   会进入结构化解析或译文正文。历史 issue（#58/#122/#187/#268）均集中在
   chat 与 Anki，此处按"未观察到即不扩面"处理可接受，记录为已知边界。
6. **发现 C（信息）**：`SseLineBuffer`（字符串入口）生产调用方仅剩
   `mcp/sse_transport.rs`；其余管线已全部迁移到字节入口的 `SseEventBuffer`。
   `SseLineBuffer` 无 UTF-8 职责（上游库已解码），不构成缺口。

**无需产品修复；建议后续把 Anki 的 token 清单改为引用共享常量以消除
发现 A 的漂移风险。本轮不改代码。**

## 一、utf8_stream 调用方清单

`Utf8StreamDecoder` 的公开 API 为 `decode(&[u8]) -> String` 与
`flush() -> String`（半截尾字节按 lossy 语义补 U+FFFD）。全仓检索
`Utf8StreamDecoder` 仅命中一个生产调用方：

- `src-tauri/src/utils/sse_buffer.rs:128,182,203`：`SseEventBuffer` 持有
  decoder，`process_bytes` 内先增量解码再切行；`flush` 先冲刷 decoder 残留
  再冲刷行缓冲；`clear` 丢弃 decoder 残留。

`SseEventBuffer` 的生产调用方（即 utf8_stream 的间接调用方）共 7 处：

| 管线 | 位置 | 流末收尾 |
| --- | --- | --- |
| chat 主管线（model2） | `llm_manager/model2_pipeline.rs:4838` | `process_sse_stream_input(buffer, None)` → `flush()`（`:550-558`） |
| 题目解析（流式切题） | `llm_manager/mod.rs:7767` | `:7836-7838` 处理剩余行；读流错误且已有内容时 break 到 flush 而非丢尾 |
| 作文评分 | `essay_grading/pipeline.rs:1317` | `handle_sse_block` 收尾遍历 |
| 题库评分 | `qbank_grading/pipeline.rs:658` | 同上 |
| 翻译 | `translation/pipeline.rs:1151` | 同上 |
| VLM grounding | `vlm_grounding_service.rs:994` | `:1136-1138` 处理剩余行 |
| Anki 流式制卡 | `streaming_anki_service.rs:1200` | `:1417` `sse_buffer.flush()` 后继续解析剩余事件 |

另有 `providers/mod.rs:101-103`（`extract_stream_data_payload` 包装）与
`adapters/gemini-openai-converter.rs:752`：二者只消费已切好的事件块字符串，
在 UTF-8 层之上，不构成独立入口。

## 二、可能绕过增量解码的字节流入口核查

对全部 `bytes_stream()` 与 `from_utf8_lossy` 命中逐一分类：

- **整体收集后一次解码（无跨 chunk 问题）**：
  `model2_pipeline.rs:3061-3094`（Codex 错误响应体，`:3110` 收齐后才
  `from_utf8_lossy`）；`openai_codex/manager.rs:1848-1874`（OAuth 响应体，
  同模式）。字节先完整拼进 `Vec<u8>`，切断字符在拼接后自然复原。
- **上游库已完成增量解码**：`mcp/sse_transport.rs:224,242-250` 使用
  `reqwest_eventsource::EventSource`，`msg.data` 到达时已是完整 `String`，
  再进 `SseLineBuffer::process_chunk(&str)`。该路径的 UTF-8 正确性由
  eventsource 库承担，不在本仓职责内。
- **非 LLM 文本流**：`cloud_storage/webdav.rs`（二进制下载）、
  `chat_v2/tools/fetch_executor.rs`（限额下载后统一解码）、子进程
  stdout/stderr、文档/XML 解析等。与流式乱码议题无关。

结论：不存在"逐 chunk 对 LLM 文本流做 lossy 解码"的残余路径，issue #122
的修复面完整。

## 三、model_special_tokens 生产接入

### policy 解析（3 处，口径一致）

- 单变体：`chat_v2/pipeline/tool_loop.rs:549-559` 从
  `resolve_active_api_config` 取 `provider_type/provider_scope/model` 调
  `for_provider_model`，失败兜底 `Disabled`，传入
  `ChatV2LLMAdapter::new`（`llm_adapter.rs:227,245-249`）。
- 多变体首发：`multi_variant.rs:810-820`；多变体重试：`:1188-1198`。均按
  变体自己的 `model_id` 解析（`resolve_api_config_by_id`），不会把主模型的
  policy 误用到变体模型上。
- 门控范围（`model_special_tokens.rs:28-52`）：provider 命中
  `qwen/dashscope/zhipu/bigmodel`，或模型名含 `qwen/chatglm` 或分词后以
  `glm/qwq/qvq` 开头。非命中路由完全直通（`process` 原样返回 chunk），
  对 GPT/Claude 等零开销、零误删。

### 过滤器生命周期（两个适配器行为一致）

- **process**：`llm_adapter.rs:1116-1129` / `variant_adapter.rs:425-448`，
  content chunk 先过 wrap filter，输出再进 think-tag 缓冲。顺序正确：
  token 剥离发生在 `<think>` 标签解析之前，二者的持锁互不嵌套。
- **flush**：`llm_adapter.rs:382-392` / `variant_adapter.rs:103-114`，
  `finalize_all_inner` 把 filter 尾巴（被暂扣的半截 token 前缀或候选行）
  回注 think-tag 缓冲后统一冲刷，不丢尾。
- **reset**：`llm_adapter.rs:563-566`（`reset_stream_state`，工具环跨轮）
  与 `variant_adapter.rs:409-412`（`reset_for_new_round`）都重置 filter，
  避免上一轮的 wrapper 开启状态泄漏到下一轮。
- **权威文本一致性**：`on_complete` 的终态 content 取
  `accumulated_content`（由过滤后的 chunk 累积，`llm_adapter.rs:406-412`、
  `variant_adapter.rs:125-127`），不用 hooks 传入的未过滤 `_final_text`，
  前端 reconcile 不会把已剥离的 token 又补回来。

### Anki 路径（独立实现）

`streaming_anki_service.rs` 不用流式过滤器，而是在两个离散点做保守清理：
收尾残留（`:1447`）与错误卡可修复性判定（`:98-102`）、卡片 JSON 解析前
（`:1751`）。语义为 #268 版本：仅当整段是纯 token 残片，或 token 仅出现在
完整 JSON 体外侧时才剥离，正文字面 token 一律保留。与共享模块目标一致，
但 token 清单是复制品（见结论发现 A）。

## 四、缺口与风险汇总

| 编号 | 等级 | 内容 | 建议 |
| --- | --- | --- | --- |
| A | 低 | Anki 的 `MODEL_SPECIAL_TOKENS` 是共享常量的复制品，且清理不做路由门控 | 改为 `pub` 引用共享常量；门控可维持现状（清理语义本身保守） |
| B | 低 | reasoning chunk 与翻译/评分/VLM 管线无 token 过滤 | 观察到实际泄漏再扩面，避免误删结构化输出 |
| C | 信息 | `SseLineBuffer` 仅剩 MCP 一个调用方，职责已收窄 | 无需动作 |

本轮不改代码。
