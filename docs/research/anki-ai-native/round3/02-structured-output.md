# Round 3 #2：流式制卡从分隔符协议升级到 Structured Output + 协议模块化

> 分支：`cursor/anki-ai-native-research-bfca`
> 涉及文件：`src-tauri/src/anki_protocol.rs`（新建）、`src-tauri/src/streaming_anki_service.rs`、`src-tauri/src/lib.rs`
> 禁改约束：`chatanki_executor.rs`、`chatanki_transform.rs`、前端 skill index.ts 未动

## 1. 背景与问题

Round 1/2 的流式制卡依赖「分隔符协议」：prompt 指令要求模型在每张卡片 JSON 后输出
`<<<ANKI_CARD_JSON_END>>>`，解析侧用 brace-depth 状态机 + 分隔符兜底切卡。该协议
存在三类结构性弱点：

1. **字符串即协议**：分隔符字面量在 `build_prompt`、`extract_card_from_buffer`、
   重试任务构造三处重复拷贝，任何一处笔误即协议破裂；
2. **输出结构靠祈使句约束**：字段类型 / 必填 / 枚举全靠自然语言指令，模型漂移时
   只能事后 QA 留痕（`_qa_flags`），无法在供应商侧前置约束；
3. **中文 few-shot 牵引**：示例 JSON 用中文占位（"问题内容"），会把英文材料的
   卡片语言拉向中文，与「卡片语言必须与材料一致」的系统要求打架。

与此同时，`providers/mod.rs` 在前几轮已经为四种供应商协议实现了
`response_format` 的转换管线（见 §5），制卡链路是唯一没有接上的消费者。

## 2. 新协议模块 `anki_protocol.rs`

| 导出 | 作用 |
|---|---|
| `CARD_DELIMITER` / `BROKEN_DELIMITER_TAIL` | 分隔符常量唯一权威定义，prompt 侧与解析侧共用 |
| `CARDS_WRAPPER_KEY` / `TEMPLATE_ID_KEY` / `JSON_SCHEMA_NAME` | 结构化协议的键名常量 |
| `OutputProtocol{Delimiter, JsonObject, JsonSchema}` | 三种输出协议（serde snake_case） |
| `StructuredOutputOptions` | options JSON 的协议扩展字段二次解析（`output_protocol` / `enable_qa_pass`） |
| `detect_schema_capability()` | 供应商结构化输出能力保守探测 |
| `resolve_output_protocol()` | 协议决策（显式请求 > auto 按能力） |
| `format_instructions()` | 按协议生成 prompt 的「重要指令」段 |
| `is_multi_template()` | 多模板判定，`build_prompt` 与 `parse_and_save_card` 共用 |
| `build_card_schema()` / `build_cards_response_schema()` / `build_response_format()` | 从 `FieldExtractionRule` 生成 JSON Schema 与 `response_format` |
| `repair_json()` | 轻量 JSON 修复（serde 失败后试一次） |
| `strip_wrapper_prefix()` / `unwrap_cards_array()` | 结构化 wrapper 的流式剥离与整体展开 |
| `is_probably_structured_output_rejection()` | HTTP 400/404/422 的运行时回退判定 |

## 3. 协议默认值与决策矩阵

wire 字段：options JSON 顶层 `output_protocol`（`auto` / `delimiter` /
`json_object` / `json_schema`），**缺省等价 `auto`**。

```text
显式 delimiter / json_object / json_schema  → 尊重请求（json_schema 在能力未知时也尊重，
                                              失败由运行时回退兜底）
auto（默认）：
  能力 = JsonSchema      → json_schema
  能力 = JsonObjectOnly  → delimiter（json_object 仅显式请求时使用）
  能力 = Unknown         → delimiter（不静默假设 OpenAI 兼容端点支持 response_format）
非法取值 → delimiter
```

能力探测（`detect_schema_capability`，与 providers 侧转换能力一一对应）：

| 判定依据 | 能力 |
|---|---|
| `api_protocol` 含 anthropic / google / gemini / responses | JsonSchema |
| `model_adapter` ∈ {anthropic, claude, google, gemini} | JsonSchema |
| base_url 为 api.anthropic.com / generativelanguage.googleapis.com | JsonSchema |
| provider_type=openai 或 base_url 含 api.openai.com | JsonSchema（CC 原生支持） |
| DeepSeek 官方（provider/base_url） | JsonObjectOnly（官方文档仅承诺 json_object） |
| 其余 OpenAI 兼容端点（网关/本地推理/中转） | Unknown → 回退 delimiter |

**运行时回退**：结构化请求若被端点以 HTTP 400/404/422 拒绝（典型为
`response_format` 不支持或 schema 方言不合法，如 Gemini 对 `oneOf` /
`additionalProperties` 的 OpenAPI 子集限制），服务层以 delimiter 协议重建
prompt 重试一次。失败发生在 HTTP 状态检查阶段（任何卡片入库之前），重试不会
产生重复卡片。用户取消（`CANCELLED_BY_USER`）不触发回退。

## 4. Schema 生成示例

单模板（选择题，规则含 required/enum/长度约束）生成的 `response_format`：

```json
{
  "type": "json_schema",
  "json_schema": {
    "name": "anki_cards",
    "strict": false,
    "schema": {
      "type": "object",
      "properties": {
        "cards": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "front":   { "type": "string", "minLength": 2, "description": "题干" },
              "correct": { "type": "string", "enum": ["A", "B", "C", "D"] },
              "tags":    { "type": "array", "items": { "type": "string" } }
            },
            "required": ["front", "correct"],
            "additionalProperties": false
          }
        }
      },
      "required": ["cards"],
      "additionalProperties": false
    }
  }
}
```

多模板：`items` 为 `{"oneOf": [variant...]}`，每个 variant 携带判别字段
`"template_id": {"type": "string", "enum": ["<该模板ID>"]}` 并列入 `required`
（用 `enum` 单值而非 `const`，兼容 Gemini 的 OpenAPI 3.0 子集）。字段来源优先
`template_fields_by_id`，回退 `template_descriptions.fields`；规则来源
`field_extraction_rules_by_id`。规则表里有、字段清单没列的字段也纳入
properties，避免被 `additionalProperties: false` 误伤。

设计取舍：

- `strict: false`——strict 模式要求全部属性必填（可选字段需 union null 表达），
  与模板「可选字段」语义冲突，且部分中转不支持；
- schema 完全无法生成（无任何模板字段信息）时降级 `json_object`，指令段不变。

## 5. 与 providers/mod.rs 转换管线的对接点

制卡侧只注入 **OpenAI Chat Completions 形态** 的
`request_body["response_format"]`，转换由既有管线完成，制卡侧零适配：

| 供应商路径 | 转换函数 / 位置 | 目标形态 |
|---|---|---|
| OpenAI CC（默认 `OpenAIAdapter`） | 请求体透传 | `response_format` 原样直达端点 |
| OpenAI Responses（`OpenAIResponsesAdapter`） | `convert_response_format_to_text_format`（providers/mod.rs ~841，注入点 ~1262） | `text.format = {type:"json_schema", name, schema, strict}`（扁平化） |
| Anthropic（`AnthropicAdapter`） | `convert_response_format_for_anthropic`（providers/mod.rs ~2847，注入点 ~1945） | GA 形态 `output_config.format = {type:"json_schema", schema:{...}}` |
| Gemini（`GeminiAdapter`） | adapters/gemini-openai-converter.rs ~1726 | `generation_config.response_mime_type = "application/json"` + `response_schema` |

即：`stream_cards_from_ai` 构造 body → `build_provider_adapter(api_config)` 选
适配器 → `prepare_provider_request` 调 `adapter.build_request(body)` → 各适配器
消费 `response_format`。这条链在翻译/结构化等模块已验证，制卡是新增消费者。

## 6. 结构化协议下的流式切卡（保住首卡延迟）

结构化输出强制整段响应为一个 `{"cards": [...]}` 对象，朴素做法要等整个对象闭合
才能解析，首卡延迟劣化为全响应时长。本实现用 `strip_wrapper_prefix` 在流入侧
剥掉 `{"cards": [` 前缀（仅当完整前缀已到达，跨 chunk 安全），数组内的卡片对象
随即成为缓冲区的「顶层对象」，**既有 brace-depth 切卡状态机原样逐卡切出**，
首卡延迟与 delimiter 协议持平。收尾残留 `]}` 不含 `{`，被既有收尾逻辑当作
非卡片内容静默丢弃。若整个 wrapper 在 flush 阶段才到达（未经过逐 chunk 切卡），
收尾路径用 `expand_wrapper_payloads` 整体展开为逐卡 payload 再解析。

## 7. 其他修复

- **轻量 JSON 修复**：`parse_and_save_card` 的 serde 解析失败后调用
  `repair_json` 试一次（去尾逗号、补闭合括号、补截断字符串引号、截去配平对象后
  的尾部垃圾），修复结果必须能被 serde 解析才采纳，否则保留原始错误语义；
- **示例 JSON 语言中性化**：`"front": "问题内容"` → `"front": "<question>"` 等，
  消除中文 few-shot 对非中文材料的语言牵引；
- **单模板 generation_prompt 附加而非替换**（任务 #8，已在本文件解决）：
  `chatanki_executor::build_generation_options` 把模板 `generation_prompt` 装进
  `custom_anki_prompt`，旧版 `build_prompt` 用它**整体替换**默认 prompt，把通用
  质量要求（最小信息原则、语言一致性等）一并丢弃。现改为：默认 prompt 恒定保留，
  `custom_anki_prompt` 作为「模板生成说明」段附加其后。executor 侧无需再改；
  副作用说明：CardForge 前端若把 `custom_anki_prompt` 当「完全替换」使用，行为
  会变为「默认 + 自定义」叠加——经查前端语义即"模板生成提示词"，叠加更符合意图；
- **`enable_qa_pass`**（wire 字段，缺省 true）：置 false 时字段 QA 校验照跑但
  `_qa_flags` 不落盘（供追求纯净 extra_fields 的调用方使用）；
- **`is_multi_template` 去重**：`build_prompt` 与 `parse_and_save_card` 原先各有
  一份四条件判定（条件相同、顺序不同），现共用 `anki_protocol::is_multi_template`。

## 8. wire 字段为何没加在 `AnkiGenerationOptions` 上（重要偏差说明）

任务原计划在 `models.rs::AnkiGenerationOptions` 增加 `output_protocol` /
`enable_qa_pass` serde default 字段。实际不可行：`chatanki_executor.rs`
（本轮**禁改**）第 9586 行与 `enhanced_anki_service.rs` 三处以**穷举字段的结构体
字面量**构造该 struct（无 `..Default::default()`），Rust 字面量必须列出全部字段，
加任何新字段都会让禁改文件编译失败（`#[serde(default)]` 只影响反序列化，不影响
字面量穷举检查）。

采用的等价方案：`anki_protocol::StructuredOutputOptions` 对**同一份**
`anki_generation_options_json` 做 serde-default 二次解析。wire 格式与「直接加
字段」完全一致（options JSON 顶层加 `"output_protocol": "json_schema"` 即生效），
前端/executor 无需感知差异。后续若允许改 executor，把 executor 的字面量改为
`..Default::default()` 风格后即可把字段迁回 `AnkiGenerationOptions`。

## 9. 未接线处（后续轮次）

1. **前端未发送 `output_protocol`**：前端 options 未携带该字段，所有请求走
   `auto`。对 OpenAI 官方 / Claude / Gemini 配置 auto 即启用 json_schema；
   若需强制或禁用，需要前端（CardForge 设置或 skill 参数）透出该字段；
2. **chatanki_executor 未显式选协议**：executor 构造的 options 同样走 auto。
   其 `build_chatanki_requirements` 注释「StreamingAnkiService will add
   delimiter/JSON formatting requirements」仍然成立（指令由本服务按协议生成），
   无需改动；但若希望 ChatAnki 链路强制 json_schema，需要 executor 在 options
   JSON 中写入 `output_protocol`（禁改约束解除后）；
3. **错误卡重试任务固定 delimiter**：`build_retry_task_for_document` 生成的修复
   prompt 明确要求分隔符输出（修复输入本身是坏 JSON 残片，delimiter 更稳）。若
   要统一，重试任务的 options JSON 可写入 `output_protocol: "delimiter"` 显式化；
4. **Gemini 多模板 `oneOf` 兼容性**：Gemini responseSchema 为 OpenAPI 3.0 子集，
   对 `oneOf` / `additionalProperties` 支持随 API 版本演进；不兼容时端点返回 400，
   由运行时回退兜底（多付一次失败请求）。若实测 Gemini 400 率高，可在
   `build_cards_response_schema` 按 capability 生成 `anyOf` 或裁剪方言；
5. **能力探测是静态启发式**：`detect_schema_capability` 基于 ApiConfig 字段，
   无法感知网关背后真实模型。理想态是把 `llm_manager::effective_api_protocol_for_config`
   提为 `pub(crate)` 直接复用（本轮 llm_manager 不在可改清单，未动）；
6. **json_object 从不被 auto 选中**：JsonObjectOnly 供应商（DeepSeek 官方）auto
   下回退 delimiter。若实测 DeepSeek json_object + wrapper 稳定性优于 delimiter，
   可把 auto 策略升级为三级（json_schema > json_object > delimiter）。

## 10. 测试

新增 28 个单测（要求 ≥10）：

- `anki_protocol.rs` 内 21 个：常量一致性、协议指令（delimiter 引用共享常量 /
  结构化不含分隔符）、协议决策（auto×3 能力、显式覆盖、非法值）、能力探测矩阵、
  schema 生成（类型/required/enum、长度约束/描述、无规则历史默认、多模板
  oneOf+template_id）、response_format 三形态、is_multi_template 四来源、
  repair（尾逗号/补括号/截尾垃圾/不可修复/字符串内分隔符不受扰）、wrapper
  剥离（完整/不完整/非 wrapper/空白变体）、wrapper 展开、StructuredOutputOptions
  解析（新字段/旧版缺省/坏 JSON）；
- `streaming_anki_service.rs` 内 7 个：prompt 与解析侧共用分隔符常量、结构化
  指令不含分隔符且引用 wrapper 键、示例 JSON 语言中性、custom_anki_prompt 附加
  语义、wrapper 剥离后 brace 切卡器逐卡流式切出（跨 chunk）、
  expand_wrapper_payloads 展开 + 截断修复、response_format 注入矩阵。

测试结果（2026-08-24，`cargo test --lib -- anki_protocol:: streaming_anki_service::`）：
**81 passed / 0 failed**（anki_protocol 21 + streaming_anki_service 60，其中含
Round 2 全部既有测试：brace 切卡器、字段 QA、模板解析、clean_json_string 等）。
