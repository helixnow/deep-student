# R4 #3：翻译 / 作文评分 / 非流式 call_unified_model_2 出口过滤盘点

任务：grep 全部相关 LLM 内容出口，对每个出口统一挂接
`ModelWrapTokenStreamFilter`（GLM/Qwen 协议包装 token 保守过滤，单源
`src-tauri/src/utils/model_special_tokens.rs`），或给出书面豁免论证。

## 出口清单与裁决

| # | 出口 | 文件（咽喉点） | 形态 | 裁决 |
|---|------|----------------|------|------|
| 1 | 翻译流式 | `src-tauri/src/translation/pipeline.rs` → `stream_translate_inner` | SSE 流，`on_chunk` 回调 | **已挂接**（本轮） |
| 2 | 作文批改流式 | `src-tauri/src/essay_grading/pipeline.rs` → `stream_grade` | SSE 流，`on_chunk` 回调 | **已挂接**(本轮) |
| 3 | 标签生成（非流式） | `src-tauri/src/llm_manager/rag_extension.rs`（`call_unified_model_2` 调用点，tag_generation） | 整段返回 → 严格 JSON 解析 | **已挂接**（本轮，always-on，理由见下） |
| 4 | 知识点提取（非流式） | `src-tauri/src/chat_v2/tools/knowledge_executor.rs`（`call_unified_model_2` 调用点） | 整段返回 → JSON 解析 | **已挂接**（本轮，always-on，理由见下） |
| 5 | Chat 主链路流式 | `chat_v2/pipeline/tool_loop.rs` / `multi_variant.rs`（`call_unified_model_2_stream`） | 适配器回调 | **豁免：已有等价过滤**。`ChatV2LLMAdapter` / `VariantLLMAdapter` 各持 `wrap_token_filter`，policy 由 `for_provider_model` 门控（tool_loop.rs:654 / multi_variant.rs:838、1220）。reasoning 路径独立过滤属 R4 #1 独占区，本任务不碰。 |
| 6 | Anki 制卡流式 | `streaming_anki_service.rs` | 自有流式清理算法 | **豁免：E 域独占**。任务红线明确不改其算法；该服务已有本地 special-token 处理。 |
| 7 | 题库批改流式 | `src-tauri/src/qbank_grading/pipeline.rs` → 自有 `stream_grade`（essay 实现的复制品） | SSE 流，`on_chunk` 回调 | **发现但未改（越界）**。与作文出口暴露面相同（前端展示 + 标签解析），但不在 #3 独占区（仅"翻译/作文/非流式 model_2 调用点"可写）。建议后续轮次照搬 #2 的挂接（`config` 就在函数签名里，改法逐行同构）。 |

grep 复核：`\.call_unified_model_2\(`（非流式）全仓仅命中 #3、#4 两个调用点；
`call_unified_model_2_stream` 调用点仅 tool_loop / multi_variant（#5，已有过滤）。

## 挂接方式

### 流式出口（#1 翻译、#2 作文）

两处同构，均在各自域的**唯一咽喉函数**内挂接，调用方无感知：

- 翻译：`stream_translate_inner` 是 `run_translation`（分段循环）、
  `translation/candidates.rs`、`translation/chat_popover.rs`（经
  `stream_translate` 包装）三个调用方的公共入口，挂一处全覆盖。
- 作文：`stream_grade` 是 `run_grading_inner` 的唯一流式入口；chunk 既发
  前端（`emit_data`）又累积供 `</score>` 标签解析，源头过滤同时保护两侧。

实现：函数内持一个局部 `ModelWrapTokenStreamFilter`，policy 用
`ModelWrapTokenPolicy::for_provider_model(config.provider_type, config.provider_scope, config.model)`
门控（两函数签名里都有已解析的 `&ApiConfig`，无 failover 换模问题——这两条
管线不走 failover 包装层）。`StreamEvent::ContentChunk` 先过 `process()`，
空结果不回调；流终局（Completed / Incomplete）`flush()` 尾巴经同一
`on_chunk` 释放。取消路径不冲刷（部分结果本就被丢弃）；供应商流内错误
（translation `terminal_failure`）返回 Err 前不冲刷。

非 GLM/Qwen 路由 policy 为 `Disabled`，`process()` 恒等直通、`flush()`
恒空，对现有行为零改变。

### 非流式出口（#3 标签生成、#4 知识点提取）

在调用点对 `assistant_message` 整段做一次 `process()` + `flush()`，再交给
原有 JSON 解析。**policy 无法门控，故 always-on（`GlmOrQwen`）**，论证：

1. **调用点拿不到最终路由。**`call_unified_model_2` 内部走
   `run_with_failover`（BackgroundTask 场景，允许 key 轮换与模型降级），
   实际命中的 provider/model 不回传给调用方（`StandardModel2Output` 只有
   `assistant_message` / `raw_response` / CoT）。按调用前的默认配置门控会
   在"failover 降级到 GLM/Qwen"时漏过滤，等于白挂。
2. **这两个出口是机器解析的 JSON，不是用户可读散文。**保守过滤的全部
   误删风险都集中在"模型故意在散文中字面引用 special token"的场景
   （`preserves_literal_tokens_in_prose` 负例族）。合法 JSON 输出中不存在
   会被删除的 token 形态：过滤器只删流首/流尾包装、token 独占行、行尾
   粘连 closer，JSON 字符串内部的字面 token 属"行中且后有内容"，恒保留。
3. **泄漏是真实故障。**GLM 非流式回答会以 `<|begin_of_box|>…<|end_of_box|>`
   包裹正文，直接令 `serde_json::from_str` 失败（标签生成整个功能不可用，
   现有 ```json 代码块回退救不了裸 token 包装）。
4. **对无泄漏输出恒等。**gpt/claude 等模型不产这些 token，过滤器扫描一遍
   原样返回，无行为差异。

保守三形态哲学不受影响：过滤器本体与负例测试零改动，本轮只是新增消费方。

## 未挂接残余风险

- #7（qbank_grading）在 GLM/Qwen 路由下仍可能向前端泄漏包装 token，
  等后续轮次按 #2 同构修复。
- 非流式出口若未来新增 `call_unified_model_2` 调用方，需在调用点自带清理
  （或届时把过滤下沉进 `call_unified_model_2_with_config`——那需要
  model2_pipeline.rs 写权，本轮独占区不含）。下沉后可拿到真实 config
  做 policy 门控，是更优终态。

## 本轮改动文件

- `src-tauri/src/translation/pipeline.rs`（stream_translate_inner 挂接 + 终局 flush）
- `src-tauri/src/essay_grading/pipeline.rs`（stream_grade 挂接 + 终局 flush）
- `src-tauri/src/llm_manager/rag_extension.rs`（标签生成调用点整段清理）
- `src-tauri/src/chat_v2/tools/knowledge_executor.rs`（知识提取调用点整段清理）
- 本文档

未执行 cargo/测试（任务红线）；未 commit（按指示）。
