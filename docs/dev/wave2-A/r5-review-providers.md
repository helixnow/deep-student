# r5-review-providers：第 5 轮 #6 审阅 —— providers/mod.rs P2 修复与测试源码

- 审阅人：Wave2-A 第 5 轮子代理 #6（claude-fable-5-thinking-high）
- 日期：2026-08-26
- 审阅对象：`src-tauri/src/providers/mod.rs` 未提交改动（+346 行，对照 tip `2d70b400`）
  与 `docs/dev/wave2-A/r5-provider-p2.md` 报告
- 方法：只读 diff + 周边生产代码全量走读 + Anthropic 官方 prompt-caching 文档核查。
  未改产品代码、未跑任何测试、未 commit（按本卡铁律）。

## 〇、裁决速览

| # | 审项 | 裁决 |
| --- | --- | --- |
| 1 | P2 修复 1：`convert_tool_definition` 透传 `cache_control` | **确认已修**，死分支已活，证据链完整 |
| 2 | P2 修复 2：四槽预算守卫的算术（automatic 占 1 槽） | **确认正确**，官方文档背书；顺带纠正 r1 台账「顶层字段非标」的过时定性 |
| 3 | 中心问题：守卫会不会误剥合法断点 | **守卫自身的剥除算术不误剥**；但存在 1 个守卫之外制造的误剥向量（保险断点先打点、后核算，见 §二.4），当前流量不可达，属潜伏缺陷 |
| 4 | P1 新测试 `openai_adapter_choice_completion_keeps_event_sequence_until_done_marker` | **翻案：测试源码有错，一旦执行必挂**——`usage["cached_tokens"]` 断言的键在 Chat 适配器原始 usage 对象里不存在（§三） |
| 5 | P2 三条边界测试 + P0 变体测试 + stream_options 钉死测试 | **确认可信**（逐条追代码核过）；但守卫的 system 剥除循环零覆盖（§四.2） |
| 6 | 存量测试兼容性推演 | **确认**：既有两条 Anthropic 测试块级 marker ≤ 3，守卫不触发 |

净结论：**两处产品代码修复均成立、方向正确**；6 条新测试中 5 条可信、
1 条（P1 事件序列）断言键位写错。报告 `r5-provider-p2.md` 的主体陈述准确，
需更正两点（§六）。

## 一、P2 修复 1：透传活化死分支 —— 确认

逐行核实（当前工作区行号）：

- `convert_tool_definition` 收口处新增
  `let cache_control = value.get("cache_control").cloned();`（`:3334`），
  从 OpenAI 形状 `tools[]` 条目顶层读取（与 Anthropic 原生 `tools[]` 携带
  marker 的位置约定一致，合理）；
- `convert_openai_to_anthropic` 里 `:2402` 的
  `has_marker = converted.iter().any(|tool| tool.cache_control.is_some())`
  由恒 false 变为可达，`:2403-2407`「已有 marker 不追加尾保险断点」分支
  真正生效——r1 §四建议 1 的「透传活化」路线，落地无偏差；
- 注释同步（`:2398-2401`）与实现一致。

一个微瑕（不翻案）：透传不校验值形状。调用方传 `"cache_control": null`
时 `.cloned()` 得 `Some(Value::Null)` → 既计入 `has_marker` 抑制尾保险断点，
又计入守卫预算，还会序列化出 `"cache_control": null` 上线。system 侧
`extract_system_text_blocks`（`:2987-2989`）同病，属 R2 遗留、非本轮引入，
一并记入遗留即可。

## 二、四槽守卫：中心问题「会不会误剥合法断点」

### 1. 预算算术：automatic 占 1 槽 —— 正确，且有官方文档背书

守卫按 `ANTHROPIC_CACHE_BREAKPOINT_BUDGET - 1 = 3` 给块级断点留槽
（`:2934`），前提是顶层 automatic `cache_control`（`:2496-2498` 恒注入）
真占一槽。r1 台账曾把该顶层字段定性为「非标」，若属实则预算该是 4、
守卫会白剥第 4 个合法断点——这是本审最大的翻案候选，因此专门核了
[Anthropic 官方 prompt-caching 文档](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)：

- 顶层 `cache_control` 即官方 **automatic caching**，是标准参数
  （legacy Bedrock 除外）；
- 官方明确「**Automatic caching uses one slot**」，且「若已存在 4 个显式
  块级断点，再带 automatic 会 400（no slots left for automatic caching）」。

因此 4 − 1 = 3 的算术**精确正确**：在本适配器恒注入 automatic 的前提下，
块级 marker 留到第 4 个必 400，剥到 3 个是必须动作，不是误剥。
r1「非标」定性按现行文档已过时，顺带纠正。

### 2. 剥除序：前剥后保 —— 正确

tools 先于 system、段内靠前先剥（`:2951-2970`），与 Anthropic 前缀序
（tools → system → messages）一致；越靠后的断点覆盖的稳定前缀越长，
留尾剥头是正确的价值排序。官方文档的 lookback 机制（断点后移 20+ 块
会错过早期缓存写）说明保留多个中间断点确有回退价值——剥除必有损失，
但在「必须剥」的前提下剥最前面的损失最小。无异议。

### 3. 计数面完整性 —— 确认无第三来源

`AnthropicContentBlock` 枚举（`:2845-2881`）的所有变体
（Text/Image/Thinking/RedactedThinking/ToolUse/ToolResult）均无
`cache_control` 字段，消息块结构上不可能携带 marker——守卫注释
「消息块转换不承接 cache_control」经核属实，tools + system 即当前全集。
守卫在 `system_blocks` 封装成 `Value::Array` 之前接线（`:2414` 先于
`:2416-2420`），顺序正确；`convert_openai_to_anthropic` 是 Anthropic
build_request 唯一构造路径（`:2522`），无旁路。

### 4. 真正的误剥向量：保险断点先打点、后核算（守卫之外，潜伏）

守卫不区分「调用方显式 marker」与「本适配器自动追加的保险断点」，
而两处保险打点（system 尾 `:2384-2388`、tools 尾 `:2403-2407`）都发生在
守卫核算**之前**。由此存在一个具体误剥场景：

- 调用方在 tools 上显式打 3 个 marker（合法：3 显式 + automatic = 4，
  官方允许），system 存在但未打 marker；
- system 尾保险断点自动追加 → 块级合计 4 > 3；
- 守卫按前剥后保，剥掉**调用方最靠前的显式 tools marker**，而本适配器
  自己追加的保险断点存活。

即：请求本在预算内，是管线自己的保险打点制造了超载，然后让调用方
的显式断点买单。对偶场景（调用方 3 个 system marker + tools 未打 →
追加的 tools 尾保险断点被守卫剥回）是自打自剥、无害；有害的只有
「调用方 ≥3 个 tools marker + 非空未打点 system」这一种形态。

严重度评估：**潜伏、非现行**。当前唯一生产打点方 `model2_pipeline`
只打 1 个 system marker，tools 透传本轮才开口、尚无调用方使用；
报告 §六 也自知「不区分来源」并移交。但报告没点破「保险断点会
**制造**超载再吃掉调用方 marker」这一层——建议后续修法二选一：
保险打点改为预算感知（追加前查剩余槽位，满了就不追加），或给
marker 加来源标记、超载时先剥自动来源。前者改动最小。

### 5. 场外备注（不计入本卡）

官方文档另有 TTL 冲突面：末块显式 marker 与 automatic 同 TTL 时
automatic 为 no-op，**异 TTL 时 400**。本适配器恒注入无 ttl 字段的
automatic（默认 5m），调用方一旦透传带 `"ttl":"1h"` 的块级 marker 且
恰在末块，会踩 400。与四槽预算正交，记入遗留，归后续调研卡。

### 中心问题裁决

**守卫的核算与剥除逻辑本身不会误剥**：预算算术有官方文档背书，
剥除序价值排序正确，计数面完整。唯一误剥向量来自守卫**上游**的
保险打点顺序（§二.4），当前流量不可达。守卫落地是净收益，确认。

## 三、P1 事件序列新测试：翻案 —— 断言键位错误，执行必挂

`openai_adapter_choice_completion_keeps_event_sequence_until_done_marker`
（`:3973`）的终态断言：

```3997:4001:src-tauri/src/providers/mod.rs
        assert!(matches!(
            &events[2],
            StreamEvent::Usage(usage)
                if usage["total_tokens"] == json!(18) && usage["cached_tokens"] == json!(8)
        ));
```

但 OpenAI **Chat** 适配器的 `parse_stream` 把 usage 原样透传：

```300:302:src-tauri/src/providers/mod.rs
                if let Some(usage) = json_data["usage"].as_object() {
                    events.push(StreamEvent::Usage(Value::Object(usage.clone())));
                }
```

测试喂入的 usage 块里 `cached_tokens` 嵌在 `prompt_tokens_details` 之下，
顶层无此键——`usage["cached_tokens"]` 得 `Value::Null`，与 `json!(8)` 不等，
matches! 守卫失败，断言必挂。把嵌套字段抬到顶层的归一化函数
`build_usage_event`（`:3443`，正是产出顶层 `cached_tokens` 的那个）
全文件只有 Responses 适配器（`:2251/:2253`）与 Anthropic 适配器（`:2716`）
调用，Chat 适配器不走它——已 grep 核实无旁路归一化。

既有同类测试 `openai_adapter_emits_usage_before_done_for_official_chunk_sequence`
（`:3900`）只断言顶层确实存在的 `total_tokens`，所以没踩这个坑；新测试
想额外钉住缓存命中字段，键位却写成了归一化后的形状。

修复方向（一行）：断言改为
`usage["prompt_tokens_details"]["cached_tokens"] == json!(8)`。
测试其余部分（finish_reason 后补发内容块、usage-only 块、全程无 Done、
`[DONE]` 后 `finish_stream()` 为空）经代码追踪均正确，事件数 4 与保序
断言成立——只坏在这一个键。报告 §二把该测试描述为
「Usage{total_tokens:18, cached_tokens:8}」，与实际适配器输出形状不符，
属报告与测试同源的错误认知。

本轮铁律「只写不跑」正是这类缺陷的温床：这条测试在首次 `cargo test`
时就会红，届时容易被误判为产品回归。**必须在合入前改断言**。

## 四、其余 5 条新测试逐条核

### 1. P2 三条（`:5766` / `:5796` / `:5844`）—— 断言与实现逐行对得上

- **passthrough 抑制尾断点**（`:5766`）：tools[0] 带 marker、tools[1] 不带 →
  透传保留 + `has_marker` 命中不追加尾块。`AnthropicTool.cache_control`
  为 None 时 `skip_serializing_if` 不序列化，`tools[1].get(...).is_none()`
  成立。可信，且是死分支活化的直接证据。
- **四槽满载**（`:5796`）：system 2 显式 marker（抑制 system 尾保险）+
  tools 1 自动尾断点 = 3 = 预算，automatic 顶层保留。恰好压在
  overflow == 0 的边界上。可信。
- **超载剥前**（`:5844`）：tools 2 显式 + system 3 显式 = 5，overflow 2 →
  剥两个 tools marker，system 3 个与 automatic 全保留。与守卫两个循环的
  实际行为一致。可信。

**覆盖缺口**：三条测试的剥除全部由第一个循环（tools）消化，守卫的
**system 剥除循环（`:2961-2970`）零覆盖**——没有任何测试让 overflow
穿透 tools 进入 system（如 1 tools + 4 system marker），也没有
tools 为 None 时纯 system 超载的用例。「system 内靠前块先剥」目前
只是注释承诺，不是被测行为。建议下轮补 1 条穿透用例。

### 2. P0 变体钉子（`:5277`）—— 可信

官方端点带 query/fragment：`is_official_openai_api_endpoint` 走
`url::Url` host 解析（`:130-135`），`https://api.openai.com/v1/?token=x#frag`
host 仍为 `api.openai.com` → 门控通过，developer 块插在 input[0] 且
content[0] 带 `{"mode":"explicit"}`（`:1555-1566`），断言的取值路径正确。
无端点包装 `convert_to_responses_format`（`:1449-1451` 传空 base_url）→
门控恒 false → system 回落顶层 instructions（`:1582-1584`），
「永不注入」的全量遍历断言写法稳健（content 非数组时 `unwrap_or(true)`）。

### 3. stream_options 钉死（`:6460`）—— 可信，9 个用例逐一追过

正例 4：裸域/尾斜杠/大写 host（url crate 归一化小写）/query+fragment，
host 均解析为 `api.openai.com` → 注入。负例 5：子域、连字符伪装、
后缀伪装 host 不等 → 不注入；无 scheme `api.openai.com/v1` 与空串
`Url::parse` 失败 → fail-safe 不注入；空 base_url 下
`openai_endpoint_url` 仍能拼出 url，`build_request` 不报错，
`.expect("request should build")` 不会 panic。与既有
`openai_adapter_gates_stream_options_include_usage_by_endpoint`（`:6403`）
互补不重复。r1 提的能力白名单扩容未做、明示移交——范围裁剪正当，
「钉死现状」本就是本卡口径。

## 五、存量测试兼容性 —— 确认报告推演

- `anthropic_adds_tools_and_system_tail_cache_breakpoints`（`:5684`）：
  system 尾 1 + tools 尾 1 = 块级 2 ≤ 3，守卫不触发；断言含
  「非尾 tools 块不打点」，与透传改动不冲突（body 里没打 marker）。
- `anthropic_preserves_caller_block_level_system_cache_control`（`:5731`）：
  块级 1，守卫不触发。
- 生产打点面 `model2_pipeline` 1 system marker + tools 自动尾 = 2，
  守卫在现实流量下确为纯守护。报告 §「存量测试兼容性推演」全部属实。

## 六、对 r5-provider-p2.md 的更正清单

1. **§二 P1 测试描述**：「Usage{total_tokens:18, cached_tokens:8}」不成立，
   Chat 适配器透传原始 usage 对象，`cached_tokens` 在
   `prompt_tokens_details` 之下；测试断言键位错误，执行必挂（§三）。
   这是唯一需要动测试源码的更正。
2. **§一 预算语义**：「automatic 占 1 槽」报告当作前提陈述、未给依据；
   经官方文档核实该前提成立（§二.1），同时 r1 台账「顶层字段非标」
   的定性应标记为已过时。
3. **§六 遗留**第一条应加重一档：不只是「不区分来源的价值权重」问题，
   保险断点先打点后核算会**主动制造超载**并吃掉调用方显式 marker
   （§二.4 的具体形态），修法建议保险打点预算感知化。

## 七、裁决

- P2 两处产品修复：**确认合格**。透传活化证据链完整；四槽守卫算术、
  剥除序、计数面、接线位置全部核实无误，且预算前提获官方文档背书。
- 中心问题：**守卫不会误剥合法断点**——唯一误剥向量在守卫上游的
  保险打点顺序，潜伏不可达，已记遗留并给出最小修法。
- 测试源码：6 新增中 5 条可信；P1 事件序列测试**必须在合入前改
  `cached_tokens` 断言键位**，否则首次执行即红。另记守卫 system
  剥除循环零覆盖为下轮补测项。
