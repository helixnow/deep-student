# R4 #1：reasoning 路径独立包装 token 过滤器

任务卡：`ROUND-04-TASKS.md` #1。两适配器 `on_reasoning_chunk` 从裸转发改为
先过 `ModelWrapTokenStreamFilter` 再累积/emit，且过滤器实例与 content 路径**独立**。

## 结论速览

| 位置 | 新字段名 | 与 content 过滤器共享实例？ |
|---|---|---|
| `llm_adapter.rs` · `ChatV2LLMAdapter` | `reasoning_wrap_token_filter: std::sync::Mutex<ModelWrapTokenStreamFilter>` | **否** |
| `variant_adapter.rs` · `VariantLLMAdapter` | `reasoning_wrap_token_filter: Mutex<ModelWrapTokenStreamFilter>` | **否** |
| `stream_filter_core.rs` · `StreamFilterCore`（未接线骨架，顺手填实） | `reasoning_wrap_token_filter: ModelWrapTokenStreamFilter` | **否** |

三处均以构造入参 `wrap_token_policy`（`Copy`）另建一个全新实例，与既有
`wrap_token_filter`（content 路径）互不共享任何状态。

## 为什么必须独立实例

`ModelWrapTokenStreamFilter` 是跨 chunk 的**有状态**过滤器：内部维护逻辑行
前缀、markdown 围栏/inline-code 等行状态，用于区分"行首协议包装 token"与
"正文里被引用的字面 token"（负例测试 `preserves_literal_tokens_in_prose`
守护的语义）。reasoning 与 content 两路 chunk 在流中交错到达，若共用同一
实例，reasoning 片段会被拼进 content 的当前逻辑行（反之亦然），污染行前缀
判定——既可能把正文行误判成 token 行吞掉，也可能让真 token 漏过。

## 各文件改动

### `llm_adapter.rs`（ChatV2LLMAdapter）

- 新字段 `reasoning_wrap_token_filter`，构造时用同一 `wrap_token_policy` 另建实例。
- `on_reasoning_chunk`：保序不变——`touch_activity` → `enable_thinking` 门 →
  置 `reasoning_content_observed = true`（在空判之前，"字段是否出现"语义不变）→
  **空 `text` 早退（保留）** → 过 `reasoning_wrap_token_filter.process()` →
  过滤结果为空则早退（不建块、不 emit）→ 累积 `filtered` 并发 THINKING chunk。
- `finalize_all_inner`：新增冲刷 reasoning 过滤器尾巴（`flush()`），非空且
  `enable_thinking` 时累积到 `accumulated_reasoning` 并补发 THINKING chunk。
  尾巴**直接归 thinking**，不回灌 `think_tag_buffer`（reasoning 通道不参与
  `<think>` 标签状态机）；置于 `finalize_thinking()` 之前，保证块未关先补尾。
- `reset_stream_state`：外层重试时同步 `reset()` 该过滤器。

### `variant_adapter.rs`（VariantLLMAdapter）

- 同名新字段 `reasoning_wrap_token_filter`，同法构造。
- `on_reasoning_chunk`：`enable_thinking` 门 → 空 `text` 早退 → 过独立过滤器 →
  过滤结果为空则早退（**不建 thinking 块**，避免为被暂扣片段发空块 start）→
  惰性建块 → emit / `ctx.append_reasoning` 均改用 `filtered`。
- `finalize_all_inner`：同 LLM 侧，冲 reasoning 尾巴直接归 thinking，
  置于 `finalize_thinking()` 之前。
- `reset_for_new_round`：新一轮时同步 `reset()` 该过滤器。

### `stream_filter_core.rs`（可选项，已填）

骨架仍未接线（`pipeline.rs` 未声明 mod），仅按同一设计填实挂点，供第二刀
迁移时调用点零改动：

- `process_reasoning`：过独立 `reasoning_wrap_token_filter`，产出 `Thinking(filtered)`；
  空 chunk / 全被暂扣返回空 Vec。
- `flush`：先冲 reasoning 尾巴（直接 `Thinking`，不回灌 think 缓冲），再走
  原 content 尾巴逻辑；`reset` 同步重置两个过滤器。
- **未做** content 路径 think 标签状态机的大迁移（明确不属本任务）。

## 未动的语义（红线自查）

- content 路径（`on_content_chunk` → `wrap_token_filter` → `think_tag_buffer` →
  `process_think_tag_buffer`）一行未改；`<think>` 标签状态机、最早匹配优先、
  不完整前缀保留、HTML 负例语义全部原样。
- 空 `text` 早退保留（LLM 侧且仍在 `reasoning_content_observed` 置位之后）。
- `parse_api_usage`、工具调用 preparing/args-delta、web_search、
  reasoning item 配对等路径未触碰。
- 未执行 cargo/npm/测试；未 commit（按任务约束）。
