# Wave2-A 第 8 轮 #8：providers 两份 `wave2_a_*` 测试断言质量静态复核

- 日期：2026-08-26
- 模型：`gpt-5.6-sol-xhigh-fast`
- 基线：`cursor/0824-wave2-agent-cache-a875`，tip `c1cde7e3`
- 范围：
  - `src-tauri/src/providers/wave2_a_prefix_snapshot_tests.rs`（6 tests）
  - `src-tauri/src/providers/wave2_a_anthropic_budget_tests.rs`（14 tests）
- 方法：只读测试、对应生产实现及同模块既有测试；未执行 cargo/npm/test/check。

## 结论

| 文件 | 静态结论 | 主要判断 |
|---|---|---|
| `wave2_a_prefix_snapshot_tests.rs` | **有回归价值，但证据边界明显被夸大** | 能证明若干选定 JSON 段的序列化稳定，不能证明完整请求存在相同的 wire-byte 前缀，更不能单独证明供应商缓存必然命中；多条用例还缺少“变化尾部确实被适配器保留”的反空断言。 |
| `wave2_a_anthropic_budget_tests.rs` | **核心断言较强，仍有一个实质性漏口** | 直打生产守卫，3 槽边界、跨 tools→system 剥除顺序和端到端保险断点交互覆盖有效；但“不得序列化 null”的断言只覆盖守卫剥除产生的 `None`，漏掉调用方传入 `cache_control:null` 的实际危险路径。 |

静态对照当前生产实现，20 条测试未见明显“必红”矛盾；这不是执行通过结论。

## 一、`wave2_a_prefix_snapshot_tests.rs`

### 做得好的部分

1. 三条生产转换入口均被直接调用，不是契约副本：
   `OpenAIAdapter::build_request`、Responses 转换和 Anthropic 转换。
2. `segment_bytes` 先拒绝 `Null`，再用 `serde_json::to_vec` 比较，确实能捕获
   **所选段内部**的值或字段顺序漂移。
3. GPT-5.6 developer 块的 role/显式 breakpoint、Anthropic system/tools 尾
   marker、OpenAI tools 缺省 schema 都有独立形状断言，不是只有自比较。
4. OpenAI Responses 用例至少检查了第二次转换后的 `input.len()` 增长，意识到了
   “两次请求实际相同”会令稳定性断言失真。

### A1（高）：分段相等不等于完整请求的 wire-byte 前缀相等

`assert_segment_byte_identical`（:142-149）把 `system`、`tools` 或
`instructions` 从请求中切出来后分别序列化。它只能证明这些孤立 `Value` 相等，
不能证明它们在完整序列化 body 中构成连续前缀：

- OpenAI Chat 夹具的顶层顺序是 `messages` 后 `tools`（:121-127）；第二次请求在
  `messages` 内追加内容后，完整 JSON 已在到达 `tools` 前分叉。
- Responses 生产 payload 先放 `input`（`mod.rs:1572-1576`），`tools` 后加
  （:1657-1664）；DeepSeek 的 `instructions` 也在动态 `input` 之后插入
  （:1582-1584）。
- `AnthropicRequest` 的 serde 字段顺序是 `messages`、`system`、`tools`
  （`mod.rs:2798-2807`），所以 system/tools 同样不是 raw JSON 的首段。

而且供应商 prompt cache 通常按其协议中的规范化 prompt 组件匹配，不能仅凭本地
JSON key 的 wire 顺序推导命中。故文件头 :3-20 的“线路字节稳定前缀，否则缓存
必 miss”以及测试名中的 `prefix`，都比实际断言更强。

建议将结论收窄为“cache-relevant 组件的确定性序列化”，并按各供应商的文档化
prompt 顺序构造一个明确的规范化 tuple 来比较。除非有供应商依据证明 raw body
字节就是 cache key，否则不要把片段字节相等称为 wire-prefix 证明。

### A2（高）：除 OpenAI Responses 外四条用例可在“丢掉新增尾部”时照样通过

只有 OpenAI Responses :234-240 检查输出长度增长，而且只检查 `>`，没有证明旧
输入是新输入的精确前缀。OpenAI Chat、Anthropic、DeepSeek Chat、DeepSeek
Responses 均只比较稳定段；若转换器静默丢弃第二轮新增的 assistant/tool/user，
这些稳定段断言仍会全绿。

每条路径至少应补：

1. 转换后的第一次动态消息序列等于第二次动态消息序列的前缀；
2. 第二次输出中存在 `call_1`、对应工具结果和“把第一道整理成卡片”；
3. 第二次完整动态序列确实不同于第一次。

这比只比较输入夹具或数组长度更能排除退化实现。

### A3（中）：形状 oracle 偏稀，若两次“稳定地错”仍会通过

- OpenAI Chat 只钉首条 role、tools 数量和第三个 schema；未钉 system 正文、
  三个工具的名称/顺序及稳定的 `tool_choice`。`r7-test-inventory.md:182` 声称
  覆盖 tool_choice，但源码没有相应断言。
- OpenAI Responses 未钉 developer 文本、tools 数量/名称/顺序，也未限制
  breakpoint 只能出现一次。
- DeepSeek Responses 以 `input[0].role == "user"` 代替“完全没有
  `prompt_cache_breakpoint`”（:355-359）。若错误字段出现在 user 内容、后续 item
  或其他位置，该断言仍会通过。`mod.rs:5304-5318` 已有更可靠的遍历式反断言，
  可复用同类 helper。
- DeepSeek Chat 只检查第一次 body 不含 `stream_options`（:323-328），第二次的
  端点专属字段漂移不受约束。

应为各路径增加少量完整 expected-shape/subset 断言，并对“不允许出现”的 marker
做全树或所有 input block 的否定检查。

### A4（中）：同输入重复转换是确定性烟测，不是缓存正确性 oracle

`:374-417` 对同一个 `Value` 连续调用纯转换并比较全 body，能抓随机 ID、时间戳或
非确定迭代，是合理烟测；但它对“确定地删错字段、放错 marker、排错顺序”完全
无能为力。该测试不应被计作供应商缓存语义已经验证，且最好为每种完整 body 增加
一个独立 expected-shape oracle。

## 二、`wave2_a_anthropic_budget_tests.rs`

### 做得好的部分

1. `enforce_anthropic_cache_breakpoint_budget` 被直接调用，能精确定位预算守卫；
   同时另有端到端转换用例，层次合理。
2. 预算内、纯 system 超载、纯 tools 超载、跨 tools→system 续剥、空输入均覆盖；
   特别是 :183-199 对跨来源剥除顺序的约束有效。
3. :155-176 不只看 marker 数量，还检查剥除后的 `Option::None` 经 serde 完全省略
   key，能防守卫产生 `cache_control:null`。
4. 非尾工具 marker、嵌套错误位置、被过滤条目、全无效 tools，以及自动 tools
   尾断点参与预算，都是相对于 `mod.rs:5687-5907` 既有内联测试的有效增量。

### B1（高）：`cache_control:null` 的调用方输入未覆盖，静态路径会把 null 发出

文件 :170-171 明确把“不得残留 `cache_control:null`，否则 Anthropic 400”当作
契约，但现有断言只验证守卫用 `take()` 剥除后变成 `None`。

生产 `convert_tool_definition` 在 `mod.rs:3334` 对任何存在的值直接
`cloned()`；因此调用方给出 `"cache_control": null` 时会得到
`Some(Value::Null)`：

- `has_marker` 将其视为已有 marker，抑制尾部保险断点（:2402-2405）；
- `skip_serializing_if = "Option::is_none"` 不会跳过 `Some(Null)`（:2913-2918）；
- 在预算内守卫也不会剥掉它，最终会序列化为 JSON null。

system block 的 `extract_system_text_blocks` 也会原样克隆 null
（:2987-2989），存在同类路径。应新增 tools/system 两个端到端反例，明确契约是
忽略、拒绝还是规范化 null/非对象 marker，并断言最终请求任何位置都没有
`cache_control:null`。这是本文件最值得优先补的断言。

### B2（中）：“零改动/逐字节保真”的文字强于实际断言

- `guard_noop_when_block_markers_within_budget`（:95-113）只逐项检查 marker；
  `guard_without_tools_keeps_system_markers_within_budget`（:118-128）甚至只检查
  marker 数量。若守卫误改 name/text/schema 或重排元素，测试未必发现。
- :201-220、:240-278 所称“逐字节/原样”实际使用 `Value` 相等，而没有像前一
  文件那样对序列化 bytes 做显式断言。

对 no-op 用例应在调用前 clone 整个 tools/system，调用后直接全量相等；若字段
顺序确属契约，再对 marker 的 `serde_json::to_vec` 做 before/after 比较。端到端
透传用例还应把 marker 绑定到工具名，断言三个工具名称与顺序不变。

### B3（中）：超载夹具没有“未标元素夹在 marker 之间”

现有超载输入中的 marker 都是连续的；预算内才出现 `None`。因此它没有专门防住
“循环遇到未标元素错误扣减 overflow”或“遇到空洞提前停止”这类实现退化。建议
各补一条：

- tools：`None, marker, None, marker, marker, marker`；
- system：无 marker 块与 marker 块交错；

并同时断言最终 marker 总数为 3、被剥的是 prompt 序中最早的**实际 marker**，
而不是最早的元素。

### B4（低）：部分端到端用例仍依赖稀疏位置断言

例如 :244-279 证明 index 1 有 ttl marker，却没有断言 index 1 仍是
`beta_tool`；:382-436 钉住具体 marker 去留，但没有统一统计整份请求的 marker
总数。当前生产代码下这些断言足以覆盖目标分支，但补工具 identity 与一个递归
`marker_count <= 4` 不变量后，失败诊断和抗重构能力会更好。

## 三、文档与接线状态

两文件头仍称“尚未在 `providers/mod.rs` 接线”（prefix :22-24；budget :3-5），
但当前 `mod.rs:3793-3796` 已有两个 `#[cfg(test)] mod` 声明。该陈述已过期，容易
让后续台账误判测试不在编译面；建议改成“R7 创建时未接线，现已接线”。

## 建议优先级

1. **先补 B1**：调用方 null/非法 marker 的端到端反例。
2. **再补 A2/A3**：每条 provider 路径证明新增尾部 survives conversion，并做
   全局禁止 marker 反断言。
3. **重述 A1 的证据边界**：片段稳定不是 raw wire prefix，也不是 cache hit 的
   充分条件。
4. 最后用全量 before/after、交错 marker 夹具补强 B2/B3，并清理过期接线说明。

## 执行纪律

本席只做静态阅读并写本报告；未运行任何测试、构建、格式化或依赖安装命令，未改
测试/产品代码，未 commit。
