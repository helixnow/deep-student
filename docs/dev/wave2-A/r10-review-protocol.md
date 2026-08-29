# r10-review-protocol：第 10 轮 #3 全 PR「provider 协议」交叉终审

- 终审人：Wave2-A 第 10 轮子代理 #3（claude-fable-5-thinking-xhigh）
- 日期：2026-08-26
- 基线：tip `659b8c54`（`git status` 除本轮任务卡外零未提交改动；
  `providers/mod.rs` 最后一次触碰为 `c1cde7e3`）
- 终审对象：`src-tauri/src/providers/mod.rs`（6710 行）七个协议面 +
  两个新接线测试文件（`wave2_a_anthropic_budget_tests.rs` 463 行、
  `wave2_a_prefix_snapshot_tests.rs` 417 行，均 `c1cde7e3` 落盘接线）
- 对照台账：`r1-provider-step22.md` / `r5-provider-p2.md` /
  `r6-p0.md` / `r6-p1.md` / `r6-p2.md`
- 方法：独立通读当前 tip 源码 + grep 全仓调用面 + `git log -S` 溯源，
  不假设任何旧轮结论仍成立。只读，未跑 cargo/npm/任何测试、未 commit
  （按本轮铁律）。所有行号为 tip `659b8c54` 实测。

## 〇、七项终审裁决速览

| # | 审项 | 终审裁决 | 相对前轮台账 |
| --- | --- | --- | --- |
| 1 | `prompt_cache_breakpoint {"mode":"explicit"}` + api.openai.com 端点门控 | **确认** | 维持 r1「已修」/ r6-p0「确认」 |
| 2 | include_usage 终止状态机（finish_reason 不发 Done） | **确认** | 维持 r1「已修」/ r6-p1「确认」 |
| 3 | stream_options 门控 | **确认** | 维持；新增事实：DeepSeek 不注入行为已被新快照测试**反向钉死**（§三.3） |
| 4 | `convert_tool_definition` cache_control 透传 | **确认** | 维持 r5「已修」/ r6-p2「确认」；新增 4 条透传契约测试源码 |
| 5 | `enforce_anthropic_cache_breakpoint_budget`（automatic 占 1、块级 3） | **确认** | 维持；r6-p2 §5.2「system 剥除循环零测试」残留**翻页关闭**（源码层，§五.2） |
| 6 | 保险断点在守卫前追加的潜伏误剥 | **确认仍潜伏、仍不可达、误剥方向仍零测试** | 维持 r6-p2 §5.1 定性；镜像方向已新增测试但不覆盖误剥本体（§六） |
| 7 | `apply_openai_prompt_cache_retention` 已删除、禁止 ttl:24h | **确认已删净** | 引入 `408a9810` → 删除 `4b784bb4`，全仓零代码残留，墓碑注释禁 24h（§七） |

净结论：**七项全部确认，零翻案**。基线增量核实：`4b784bb4`（r6 基线）
→ tip 之间 `providers/mod.rs` 产品代码**零改动**，唯一 diff 是 `:3793-3796`
新增两行 `#[cfg(test)] mod` 接线（+5 行，`git diff 4b784bb4..HEAD` 可证）——
r6 三份二检的产品代码结论直接继承有效；本轮工作量集中在新测试文件的
增量覆盖核定与残留清单翻页。

## 一、P0：断点形状 + 端点门控 —— 确认

### 产品代码（与 r6-p0 逐项对表，零漂移）

1. wire 形状：`convert_to_responses_format_for_endpoint`（`:1453`）双门控
   成立时在 `input[0]` 插 developer 块，断点为块级
   `"prompt_cache_breakpoint": { "mode": "explicit" }`（`:1556-1567`）；
   门控不满足回落顶层 `instructions`（`:1582-1584`），两路互斥。
2. 模型门控 `model_supports_prompt_cache_breakpoint`（`:723-756`）：
   `rsplit('/')` 取型号段 + `gpt-` 前缀锚定，major>5 或 5.minor≥6，
   后缀白名单。本席重推 `not-gpt-5.6` / `deployment-not-gpt-6-preview` /
   `gpt-5.10`（整数比较）三个易错向量，与 r6-p0 手推一致。
3. 端点门控 `endpoint_supports_prompt_cache_breakpoint`（`:758-760`）→
   `is_official_openai_api_endpoint`（`:130-135`）：`url::Url` 解析 host
   精确等于 `api.openai.com`，解析失败 fail-closed。
4. 生产流向：`build_request:1833` 唯一生产构造点、传真实 base_url；
   遗留无端点包装 `convert_to_responses_format`（`:1449-1451`，空 base_url
   恒不注入）本轮重新 grep：**全部调用点仍在测试区**（`:4264` 起 +
   `:5302` 变体钉子内），无生产误接。

### 测试面增量

- 存量：三类主快照 `:5199`、端点变体钉子 `:5283`、模型解析 13 向量
  `:5322`（行号相对 r6-p0 记录 +5，由 `:3793` 接线插入造成，内容未变）。
- 新增（`wave2_a_prefix_snapshot_tests.rs`，R7 #7 交付、`c1cde7e3` 接线）：
  - `openai_responses_developer_breakpoint_prefix_byte_identical_across_consecutive_requests`
    （:201）——gpt-5.6 官方端点连续两次请求 developer 断点块**逐字节**相等
    （serde_json preserve_order 前提），首次把「断点锚点字节稳定」从
    形状断言升级为缓存命中的必要条件断言；
  - `deepseek_responses_instructions_prefix_byte_identical_across_consecutive_requests`
    （:332）——反向门控：不支持断点的模型 system 留顶层 instructions
    且字节稳定，`input[0]` 必须是 user 而非 developer。

裁决：**确认**。r6-p0 §五的 6 条观察（含调用方消息块断点被
`push_message_parts` 静默剥掉的刻意不对称、`include` 只受模型门控的
姿态不对称）本轮抽核未变化，维持「观察非缺陷」定性。

## 二、P1：include_usage 终止状态机 —— 确认

### 产品代码（tip 实测，自 55846040 起第三轮零改动）

- `saw_finish_reason: AtomicBool`（`:83`），`build_request` 开头重置
  （`:153-154`）；
- finish_reason **只置位不发 Done**：`openai_choices_finished`
  （`:329-344`，空 choices 恒 false、多 choice 要求全部完成）为 true 时
  仅 `store(true)`（`:307-310`），注释明示 usage-only 块必须可达；
- Done 三来源互斥完备：`[DONE]`（`:199-204`，清位）、流内
  `{"error":...}`（`:209-221`，清位 + SafetyBlocked + Done）、EOF
  `finish_stream()`（`:317-326`，`swap(false)` 一次性消费）；
- usage 透传：`:300-302` `as_object()` 取值，`usage: null` 噪声块不出
  伪事件（r6-p1 补核结论维持）；
- 严格终止门：`requires_explicit_stream_completion` 对 OpenAIAdapter
  返回 true（`:138-140`）；pipeline 接线 `model2_pipeline.rs:4888`
  （require）、`:5386`（EOF 时 `finish_stream()` 推入 parsed_blocks 尾部，
  尾随 usage 块先入队）、`:5802-5824`（缺失终止判失败）——行号相对
  r6-p1 记录 +4/+5，逻辑逐行比对未变。

### 测试面

存量 5 条全部在位（行号 +5 漂移）：`:3808` 协议布尔、`:3882` 官方序列、
`:3911` 裸 NDJSON EOF、`:3932` 空/部分完成、`:3978` 事件序列（r5 #6
翻案修正后的 `usage["prompt_tokens_details"]["cached_tokens"]` 嵌套键位
在 `:4006` 一带，r6-p1 §一已证钉住真实生产契约，本轮抽核断言未再被改动）。

裁决：**确认**。

## 三、P1：stream_options 门控 —— 确认

1. 注入条件三与（`:161-172`）：`stream == true`（JSON 布尔）&&
   `is_official_openai_api_endpoint(base_url)` && 调用方未显式设置
   `stream_options`。与 P0 共用同一 host 判定函数（`:130-135`）。
2. sanitize 次序（r6-p1 补核维持）：`sanitize_openai_request_body` 只动
   `tools`/`tool_choice`，显式 `stream_options` 原样存活后被
   `contains_key` 尊重。
3. **本轮新增事实**：`wave2_a_prefix_snapshot_tests.rs:325-328`
   （`deepseek_chat_prefix_segments_byte_identical_across_consecutive_requests`
   末段）显式断言 `api.deepseek.com` 端点 **不得** 注入 `stream_options`。
   即 r1 §三「能力白名单扩容（api.deepseek.com / openrouter.ai）」的建议
   如今被一条测试**反向钉死为现状**——后续若真做白名单扩容，属行为
   变更且必须同步改此断言，扩容成本上升了一格。残留定性维持
   「归调研卡的行为变更」，但移交时须附带这条测试的存在。

存量测试 `:6409`（端点门控四段）与 `:6466`（官方变体 4 正 5 负）在位，
行号 +5 漂移、内容未变。

裁决：**确认**。

## 四、P2 修复 1：`convert_tool_definition` cache_control 透传 —— 确认

- 透传行在位：`:3334` `let cache_control = value.get("cache_control").cloned();`
  + `:3335-3340` 构造体承接，注释（`:3331-3333`）留有死分支史。
- `has_marker`（`:2402`）可达性成立，`:2403-2407`「已打 marker 不追加
  尾保险」分支活——r5「透传活化」路线维持。
- 序列化契约：`AnthropicTool.cache_control` 挂 `skip_serializing_if`
  （`:2917-2918`），剥除后字段整体消失。
- **测试面显著增厚**（`wave2_a_anthropic_budget_tests.rs`，R7 #8 交付）：
  在 r5 直接证据测试 `:5772` 之外新增 4 条透传契约——
  marker 在**非尾**工具上位置与载荷（含 `ttl:"1h"` 扩展形态）逐字节保持
  （:244）；嵌进 `function` 对象的 marker 不算透传形态、不被提升
  （:286，以尾断点是裸 ephemeral 而非嵌套 ttl 载荷反证）；非 function
  条目被丢弃时其 marker 零副作用（:316）；全无效 tools 时不序列化
  tools 键（:350）。契约边界从「透传成立」扩展到「什么不算透传」。

裁决：**确认**。`Value::Null` 透传微瑕（`"cache_control": null` →
`Some(Null)`，三处口径一致但序列化出 null 可能被 API 拒）维持 r6-p2
§5.3 定性：仍开、内部自洽、R2 遗留非 r5 引入。本轮补核：system 侧
`extract_system_text_blocks`（`:2987-2989`）对 null 同样承接，两侧
口径对称，不构成新缺陷。

## 五、P2 修复 2：四槽预算守卫 —— 确认（一项残留翻页）

### 1. 产品代码（与 r6-p2 逐行对表，零漂移）

- 常量 `ANTHROPIC_CACHE_BREAKPOINT_BUDGET = 4`（`:2923`）；
  `block_budget = 4 - 1 = 3`（`:2934`，automatic 占 1 槽）。
- 顶层 automatic 恒注入：`:2496-2498`
  `cache_control: Some(CacheControl { cache_type: "ephemeral" })`，
  `CacheControl` 仅 `type` 一字段（`:2889-2892`），**无 ttl**。
- 计数面 = tools marker（`:2936-2941`）+ system marker（`:2942-2945`），
  `saturating_sub` 求 overflow、零则早退；剥除先 tools 循环
  （`:2951-2959`，`Option::take`）后 system 循环（`:2961-2970`，
  `map.remove`），均前剥后保。
- 接线：`:2414` 在 system 尾保险（`:2378-2388`）与 tools 尾保险
  （`:2398-2407`）之后、`system_blocks` 封装（`:2416-2420`）之前。
- 无第三来源与唯一构造路径重验：`convert_openai_to_anthropic` 生产
  调用点全仓仍仅 `build_request:2522` 一处（本轮 grep：其余命中全部
  在 `mod tests` 与两个新测试文件内）；消息块枚举仍无 cache_control 字段。

### 2. 残留翻页：system 剥除循环零测试 —— **已关闭（源码层）**

r6-p2 §5.2 记「三条 P2 测试的剥除全部由 tools 循环消化，system 循环
（`:2961-2970`）零覆盖」并建议补穿透用例。本轮核实
`wave2_a_anthropic_budget_tests.rs` 已精确补位：

- `guard_without_tools_strips_earliest_system_markers_on_overflow`（:133）
  ——tools=None、system 5 marker 超载 2 → 剥最靠前 2 个、尾部 3 个保留
  （纯 system 剥除路径 + `Option<&mut Vec<_>>` None 分支）；
- `guard_overflow_crosses_from_tools_into_system`（:183）——tools 1 +
  system 4 = 5 → 剥 tools 唯一 marker 后**续剥 system 首块**（跨来源
  续剥顺序，恰是 r6-p2 建议的穿透形态）。

另有 6 条守卫直调单元测试（常量锚定 :88、预算内零改动 :95、纯 tools
超载 + 剥后无 null 残留的序列化契约 :155、幸存 marker 载荷逐字节保留
:204、空输入不 panic :226、tools=None 满载保留 :118），把守卫从「只经
端到端触发」升级为可直调单测。**该残留就此翻页**——仍受铁律限定：
只有源码、从未执行。

### 3. 存量三测试

`:5772`（透传抑制尾断点）/ `:5802`（四槽满载）/ `:5850`（超载剥除）
在位，行号 +6 漂移、内容未变。r6-p2 §三.4 的零损剥除论证
（system 侧存活 marker 的前缀覆盖全部 tools 字节）不受新测试影响，维持。

裁决：**确认**。

## 六、潜伏误剥：保险断点在守卫前追加 —— 确认仍潜伏，误剥方向仍零测试

这是七项中唯一「确认但未闭合」的项，本轮把向量边界钉得更细：

### 1. 向量本体（r6-p2 §5.1 形态，tip 代码重验成立）

代码顺序：system 尾保险（`:2384-2388`，system 无块级 marker 时打点）与
tools 尾保险（`:2403-2407`）都在守卫 `:2414` **之前**执行且**预算无感知**。
误剥形态：调用方打 3 个显式 tools marker（has_marker → tools 尾保险不加）
+ 非空未打点 system → system 尾保险自动 +1 → 块级 4 > 3 → 守卫按
prompt 序剥**调用方最靠前的显式 tools marker**，而**自动追加的** system
保险断点存活。自动打点挤掉调用方显式标注，方向颠倒。

### 2. 新测试只钉了镜像方向

`anthropic_auto_tools_tail_breakpoint_yields_to_caller_system_markers`
（budget_tests:382）：调用方 3 个 system marker + 未标 tools → tools 尾
自动断点 +1 超载 → **剥的是自动断点**、调用方 3 个 system marker 全保留。
这条钉死了「自动断点参与预算且无豁免权」的良性方向，注释也如此自述——
但**误剥方向（自动 system 保险挤掉调用方 tools marker）依然没有任何
测试触达**：本轮逐条核对 budget_tests 全部 14 条与 mod.rs 存量 3 条，
无一构造「调用方 ≥3 tools marker + 未打点非空 system」的端到端输入
（直调守卫的用例绕过保险打点，不覆盖此交互）。

### 3. 可达性重验：仍不可达

块级 marker 的生产写入方全仓仍只有 `model2_pipeline.rs:4046-4052`
（1 个 system 块级 ephemeral；`:2687-2694` 同形物是测试夹具）；
无任何生产调用方写 `tools[].cache_control`。真实流量块级 = 1 system
（调用方，抑制 system 尾保险）+ 1 tools 尾保险 = 2 ≤ 3，守卫纯守护。
误剥向量需要调用方喂 ≥3 个 tools marker 才可达——当前不存在此调用面。

### 4. 定性与移交

**确认维持 r6-p2 定性：真实缺陷形态、当前流量不可达、非阻塞。**
修法维持前轮原案（保险打点预算感知化：追加前检查块级余量，或把保险
打点挪到守卫之后由守卫统一裁决），并建议补一条误剥方向的端到端反例
（预期行为：自动保险让位，调用方 3 个 tools marker 全保留）——该反例
在现行代码上会**红**，属「先钉预期再修」的验证轮素材，本席无产品
代码改动权，移交。

## 七、`apply_openai_prompt_cache_retention` —— 确认已删净、24h 禁令在案

任务卡第七项为本轮新增终审面（前五份台账均未单列），完整溯源：

1. **引入**：`408a9810`（0824 主线早期）在 `model2_pipeline.rs` 新增
   `provider_accepts_prompt_cache_retention` +
   `apply_openai_prompt_cache_retention`，后者对 GPT-5.6+ 写
   `prompt_cache_options: {"ttl":"24h"}`、旧代际写
   `prompt_cache_retention: "24h"`（`git show 408a9810` 可证）。
2. **删除**：`4b784bb4`（第 5 轮收轮，R5 #1 P6 裁决）整体删除两函数——
   `git show 4b784bb4^:.../model2_pipeline.rs` 仍见 `:3205` 函数体，
   `4b784bb4` 起只剩墓碑注释。删除理由（死代码：从未被任何请求路径
   调用）与 `git log -S` 双向一致：pickaxe 在 `src-tauri` 路径下的代码
   增删仅 `408a9810`（引入）与 `4b784bb4`（删至注释）两点。
3. **现状**（tip 实测）：
   - 全仓（src-tauri / src / scripts）`apply_openai_prompt_cache_retention`
     唯一命中 = 墓碑注释 `model2_pipeline.rs:3588`；
   - `prompt_cache_retention` / `prompt_cache_options` 作为**代码**零命中，
     任何请求体不可能再携带这两个键；
   - 墓碑注释（`:3588-3599`）明文钉死三条重接线硬约束：只允许官方端点、
     只允许 `ttl:"30m"`、**禁止 24h**（按存储计费成本论证）、接线必须
     附带请求体快照测试。
4. **不混淆面**：`wave2_a_anthropic_budget_tests.rs` 中的
   `"ttl": "1h"`（:47 等 4 处）是 **Anthropic 块级 cache_control 的
   扩展载荷透传夹具**，与 OpenAI `prompt_cache_options` 的 ttl 禁令
   无关；且透传路径只承接调用方输入、产品代码自身不制造任何 ttl
   （automatic 槽 `CacheControl` 无 ttl 字段，§五.1 已证）。
   r6-p2 §5.4「透传 1h marker 恰在末块时与无 ttl automatic 异 TTL
   冲突 400 面」维持仍开、正交、归调研卡。

裁决：**确认**。禁令目前由注释 + 「全仓零写入点」双重成立；若要
机器可执行，需一条「请求体不含 prompt_cache_options/prompt_cache_retention」
的负向快照断言，现无（记入残留 R-6，低优先）。

## 八、对照五份台账的逐项翻页表

| 台账结论 | 本轮终审 |
| --- | --- |
| r1 P0/P1×2「已修」、P2「未修」 | P0/P1 维持已修；P2 已被 r5 修复、r6-p2 确认，本轮再确认 |
| r1 §一建议（端点变体钉子） | r5 已补（`:5283`），维持关闭 |
| r1 §二建议（pipeline 成功面集成测试） | **仍开**（残留 R-1）：本轮 grep `model2_pipeline.rs`，终止门测试仍只有 `:1522/:1533/:1543` 三条失败面 |
| r1 §二建议（trait 单流所有权注释） | **仍开**（残留 R-2）：`:71-76`/`:80-83` 注释无所有权约定；生产实例化仍全部按次新建，风险不变 |
| r1 §三建议（stream_options 能力白名单） | **仍开且成本上升**（残留 R-3）：新快照测试反向钉死 DeepSeek 不注入（§三.3） |
| r5 六条新增测试 | 全部在位（行号 +5/+6 漂移），r6 三份二检的静态可信判定无需重开 |
| r5 §六「守卫不分 marker 来源价值权重」 | 仍开（残留 R-4 的一部分），且镜像测试 :382 恰好演示了「prompt 序剥除在该形态下偶然做对了价值排序」——不改变需要来源标记才能系统化的结论 |
| r5 §六「消息尾断点递进式缓存缺位」 | 仍开，归 #1 调研卡（残留 R-5） |
| r6-p0 六条观察 | 全部维持；无一升级为缺陷 |
| r6-p1 遗留 1/2/3 | = 残留 R-1/R-3/R-2，均仍开 |
| r6-p1 遗留 4（台账行号漂移勘误） | 本轮再漂移一次（`:3793-3796` 接线 +5/+6），本文档行号即最新勘定 |
| r6-p2 §5.1 误剥向量 | 维持「潜伏、不可达」，新增「镜像方向已测、误剥方向未测」的精确化（§六） |
| r6-p2 §5.2 system 剥除循环零测试 | **翻页关闭**（源码层，§五.2） |
| r6-p2 §5.3 Null 透传微瑕 | 仍开，本轮补核 system 侧口径对称（§四） |
| r6-p2 §5.4 automatic 异 TTL 400 面 | 仍开、正交（§七.4） |

## 九、终审后残留清单（全部非阻塞）

| # | 残留 | 首记 | 状态 |
| --- | --- | --- | --- |
| R-1 | pipeline 级「Chat 网关省略 [DONE] + EOF 经 finish_stream → terminal_success == true」成功面集成测试 | r1 §二 | 仍缺，三轮移交，验证轮补 |
| R-2 | `saw_finish_reason` 单流所有权约定入 trait 注释 | r1 §二 | 仍缺（一行文档改动，无席位认领） |
| R-3 | stream_options 能力白名单扩容（行为变更） | r1 §三 | 归调研卡；注意新测试已钉死现状（§三.3） |
| R-4 | 保险打点预算感知化 + 误剥方向端到端反例 | r6-p2 §5.1 | 仍潜伏不可达；反例在现行代码上预期红（§六.4） |
| R-5 | 消息尾断点（对话稳定前缀第 3 槽 + 增量第 4 槽） | r1 §四 | 归 #1 调研卡 |
| R-6 | retention 禁令的负向快照断言（请求体不含 prompt_cache_options / prompt_cache_retention） | 本轮 §七 | 新记，低优先 |
| R-7 | `cache_control: null` 透传微瑕（两侧口径一致，序列化暴露面） | r2 遗留 / r6-p2 §5.3 | 仍开 |
| R-8 | automatic 与透传 ttl marker 的异 TTL 400 面 | r6-p2 §5.4 | 仍开、正交 |

## 十、已验证 / 未验证

### 已验证（静态证据：读码 / grep / git diff / git log -S）

- `4b784bb4..HEAD` 间 `providers/mod.rs` 产品代码零改动（唯一 diff 为
  `:3793-3796` 测试模块接线 +5 行）——七个协议面的 r6 结论继承链完整。
- 七个审项的全部关键行号与形态：门控函数、状态机三来源、注入条件、
  透传行、守卫算术与剥除序、保险打点次序、automatic 无 ttl、
  retention 删净与墓碑禁令。
- 调用面全集：`convert_openai_to_anthropic` 生产唯一 `:2522`；
  responses 无端点包装无生产调用；块级 marker 生产写入方唯一
  `model2_pipeline.rs:4046`；`prompt_cache_options` 全仓零代码命中。
- 新增 20 条测试源码（budget 14 + prefix snapshot 6）的覆盖归属与
  §五.2 翻页、§六.2 镜像/误剥方向区分——逐条读过断言与夹具。
- prefix snapshot 测试的前提 serde_json `preserve_order` 特性确认开启：
  `src-tauri/Cargo.toml:35`（`[dependencies]` 段；`:21` 的裸 serde_json
  属 `[build-dependencies]`，与测试运行时无关）。

### 未验证（诚实归因）

- **未跑任何编译 / 测试**（铁律）：存量 15+ 条与新增 20 条 provider
  相关测试仍全部只是源码存在。新测试文件的可编译性（私有项经
  `super::` 的子模块可见性、`AnthropicTool` 字段构造、
  `AnthropicAdapter::new` 存在性）经静态核对无已知问题，但未经
  rustc 证实。
- 全部 wire 行为（断点被官方端点接受、四槽守卫规避 400、剥除后
  缓存命中率、DeepSeek 不注入的实际收益）无运行时证据。
