# Wave2-E R5-04：options 单点化（StructuredOutputOptions 薄委托）

- 轮次：0824 Wave2-E 第 5 轮「options 单点化」
- 独占文件：`src-tauri/src/anki_protocol.rs`
- 约束：`models.rs` 只读；streaming 仅动一处过期注释（调用点与函数签名不变）；
  未跑测试，未 commit

## 背景

`output_protocol` / `enable_qa_pass` 早期无法直接加到
`models::AnkiGenerationOptions`（当时禁改文件以穷举字段的结构体字面量构造该
struct，加字段会引发编译失败），因此 `anki_protocol::StructuredOutputOptions`
自带 serde 定义，对同一份 options JSON 做「二次解析」。该约束已解除：
`AnkiGenerationOptions` 现已带有这两个字段（`models.rs` 1336-1341 行，
serde-default + skip_serializing_if），二次解析成为重复的 wire 契约。

## 改动内容

1. **删除过期设计注释**：`StructuredOutputOptions` 上的「为什么不直接加在
   `AnkiGenerationOptions` 上（禁改字面量所以二次解析）」整段说明已删除，
   替换为薄投影语义说明。

2. **薄委托实现**：`StructuredOutputOptions` 去掉 `Deserialize` 派生与
   `#[serde(default)]` 属性（不再自带 wire 契约）；`from_options_json`
   改为解析 `AnkiGenerationOptions` 后只投影 `output_protocol` /
   `enable_qa_pass` 两个字段，解析失败仍回退 `Self::default()`。
   函数签名（`&str -> Self`）与结构体公开字段不变，调用方
   （`streaming_anki_service.rs` 两处、`anki_critic.rs` 一处）零改动。

3. **默认值语义不变**：`qa_pass_enabled()` 缺省仍为 `true`；
   `output_protocol` 缺省 `None` 仍等价于 `auto`。**未回退 `enableQaPass`**
   （wire 字段名仍为 snake_case `enable_qa_pass`，单点定义在
   `AnkiGenerationOptions` 上）。

4. **streaming 最小改动**：仅更新调用点上方 3 行过期注释
   （原文引用已删除的「不能直接加到 AnkiGenerationOptions」设计说明），
   调用代码未动。

5. **测试补一例**：`structured_options_parse_from_options_json` 新增
   「非完整 AnkiGenerationOptions JSON（缺必填字段）回退默认」断言，
   固化单点解析后不再对残缺 JSON 做宽松字段提取的行为。

## 行为差异说明

唯一的语义变化：缺少 `deck_name` 等必填字段、但带有 `output_protocol` 的
残缺 JSON，旧实现能宽松提取扩展字段，新实现回退默认（auto + QA 开）。
生产路径无影响——`anki_generation_options_json` 由主流程以完整
`AnkiGenerationOptions` 序列化写入，且流式服务主解析对同一 JSON 已做严格
校验、失败即提前返回，`from_options_json` 不会在残缺 JSON 上被实际调用。

## 未做的事

- 未删除 `StructuredOutputOptions` 结构体本身：调用方读取
  `.output_protocol` 字段与 `.qa_pass_enabled()` 方法，保留薄投影可让
  streaming / critic 调用点零改动；
- 未动 `anki_critic.rs` 中引用旧「二次解析」模式的模块注释（非独占文件，
  `CriticOptions` 的收敛属后续轮次）；
- 未动 `models.rs`（只读），其字段注释仍提及 `StructuredOutputOptions`，
  类型仍存在、描述仍成立。
