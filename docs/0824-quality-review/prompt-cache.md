# Prompt cache / H 前缀冻结改造质量评审

评审对象：`v0.9.44` → `origin/cursor/0824-cde6 @ 2d41ea8b`。这里只判断这次缓存改造是否真的改善了请求前缀、重放和测量质量，不把“新增了 helper、metadata 键或测试文件”直接等同于完成。

## 结论

**总体判定：WARN。改造有真质量，明显强于 v0.9.44，但还不能按“会话前缀已经冻结、跨轮缓存已经闭环”验收。**

它不是表面排序或埋点堆叠。目标树确实把 v0.9.44 中最伤命中率的几处根因改到了正确层级：

- 易变画像、待办、检索、Canvas 等离开 system，进入当前 user 的动态尾部；
- `V20260806` 三列从“只有迁移、业务零读写”变成真实的 live 写入和 history 重放；
- 工具排序键改为读取真正的 `function.name`，并增加会话级 append-only 名字序与窗口级 schema 字节冻结；
- `available_skills`、工具序和 microcompact 锚点均有跨进程恢复；
- OpenAI、DeepSeek、Anthropic 的 cache key、usage 字段和断点策略开始按协议分流，而不是向所有兼容端点盲发同一套字段。

这些改动能让普通单变体、工具集合稳定、技能正文不变、正常完成保存的会话获得真实收益。

但“冻结”目前由多种不同强度的机制拼成：名字序跨会话窗口持久化，schema 字节只冻单次工具环，技能目录永久冻但技能正文不冻，多变体又只有名字序；再加上并发分叉和崩溃窗口，最终请求并没有一个统一、可证明的 prefix generation。最值得优先处理的是多变体并发序、技能历史重放和遥测失真。

## 做得好的部分

### 1. 从“稳定字符串”升级成了真正的请求位置治理

`PromptBuilder::build` 只保留 LaTeX、基础指令、AGENTS、用户追加指令和固定引用规则；画像、待办、检索、Canvas、格式提示由 `build_turn_volatile_blocks` 产出，后续进入当前 user 的 `<injected_context>`（`src-tauri/src/chat_v2/prompt_builder.rs:542-588,591-717`；`src-tauri/src/chat_v2/context.rs:1232-1249`）。

这比 v0.9.44 在 system 内部区分“稳定段/动态段”有效得多。只要动态内容仍在 system，哪怕位于字符串末尾，也会挡在全部历史之前；0824 是把它真正移到历史尾部，不只是换标签。

固定注入引用规则也是合理取舍：多付一段恒定 token，换掉“有无检索命中就改 system”的整段失效。

### 2. 重放一致性终于接到了业务链

目标树使用三个旁路字段保存 live 时不可重建的内容：

- `llm_content`：用户实际发送的完整包装；
- `tool_call_id`：provider 原始工具调用 ID；
- `round_text`：工具调用前的助手文本。

写入在 `persist_replay_sidecar`，读取在 history 的用户消息及工具轮重建（`src-tauri/src/chat_v2/pipeline/persistence.rs:184-249`；`src-tauri/src/chat_v2/pipeline/history.rs:241-277,930-1055`）。分支深拷贝也有专用三列复制，正文改写会使旧 `llm_content` 失效（`src-tauri/src/chat_v2/repo.rs:1948-1991,2000-2049`）。

这解决的是 v0.9.44 的实质问题：上一轮 live 发的是包装文本和 provider call ID，下一轮却从裸正文及 `tc_{block_id}` 重建。当前实现还把检索工具输出在 live 与 replay 两侧统一走同一脱敏函数，说明设计不只盯三列本身。

### 3. 单变体工具冻结的实现细节是扎实的

`tool_schema_sort_key` 优先取 `function.name`，修掉了旧实现对 OpenAI function schema 排序实际为 no-op 的问题（`src-tauri/src/chat_v2/pipeline/tool_loop.rs:11-28`）。

`freeze_tool_schemas_for_prompt_cache` 又补了名字序之外的 schema 副本回写。它没有依赖 `Value != Value` 才回写，因为启用 preserve-order 后，语义相等的 JSON 仍可能有不同键序和序列化字节；这里无条件用冻结副本覆盖是正确的（同文件 `:89-131`）。

生产调用也在真正送入 `custom_tools` 后、LLM 调用前执行，不是测试专用 helper（同文件 `:975-995`）。

### 4. metadata 持久化不是粗暴覆盖

三个缓存状态都只更新 session metadata 的单键，并避免推进用户可见的 `updated_at`。工具序在 IMMEDIATE 事务内读、合并、写，无新增时不重写；available skills 使用 first-write-wins，并正确区分“缺键”和合法空串（`src-tauri/src/chat_v2/repo.rs:2653-2813`）。

内存 miss 时先读持久化值，读库期间若另一个执行已经建立内存状态，则用 append-only/`entry.or_insert` 收敛，而不是让迟到的读覆盖新状态（`src-tauri/src/chat_v2/pipeline/helpers.rs:928-1007,1009-1081`）。

这些都是发送热路径里容易被忽略的工程质量点。

### 5. usage 观测字段比 v0.9.44 完整

当前 usage 解析区分：

- Anthropic `cache_read_input_tokens` / `cache_creation_input_tokens`；
- OpenAI Chat Completions `prompt_tokens_details.cached_tokens`；
- OpenAI/DeepSeek Responses `input_tokens_details.cached_tokens`；
- DeepSeek CC `prompt_cache_hit_tokens`；
- Gemini 顶层缓存字段。

缺字段保留为 NULL，显式 0 才表示测得 miss；多种网关重复字段取 max 而非求和（`src-tauri/src/chat_v2/pipeline/llm_adapter.rs:86-148`）。`cache-hit-report.py` 也没有把“无测量”伪装成 0%。这使改造至少具备成本验证的基础。

## 主要缺陷与风险

### 高 — 多变体并发的 append-only 合并不能兑现其注释承诺

多变体确实并行执行（`src-tauri/src/chat_v2/pipeline/multi_variant.rs:498-544`），每个变体会独立调用 `load_skills`，独立向本地工具面追加技能工具（同文件 `:1600-1689`），但所有变体共享同一 session 的 `frozen_tool_schema_order`。

合并原语只是“把共享 entry 中没有的名字追加到尾部”：

```text
共享初始： [A]
变体 1 已发： [A, X]
变体 2 已发： [A, Y]
```

无论写回顺序如何，共享结果只能是 `[A,X,Y]` 或 `[A,Y,X]`。未来某轮若同时出现 X、Y，至少有一个变体曾经发出的 `[A,X]` 或 `[A,Y]` 不再是该轮工具面的前缀。不存在一个普通线性数组能同时保住两个已经分叉的前缀。

因此 `helpers.rs:1049-1056` 所称“任一变体已发出的 tools 前缀不会被其他变体打乱”在分叉追加场景下不成立。现有并发测试只覆盖：

- A 追加 `beta`；
- B 仍是旧基线子集；
- B 写回不得删除 `beta`。

它没有覆盖 A、B 分别追加不同工具（`tool_loop.rs:3763-3780`），正好绕开了不可合并的情形。

这不会执行错工具，但会让多变体及之后切换活跃变体时出现无法解释的 cache miss。修复不能继续加强 `Vec<String>` 的 merge；应二选一：

1. fan-out 前为本批可能出现的工具分配统一确定序，所有变体从同一代际开始；
2. 把冻结基线降到 variant/branch/model 作用域，不再声称一个 session 数组能代表所有分叉。

### 高 — 技能“位置冻结”没有冻结正文，历史会被当前技能内容重写

技能锚点只持久化技能 ID。`ReplaySkillPayloadSnapshot::without_skill_contents` 明确清空正文（`src-tauri/src/chat_v2/types.rs:1057-1101`）；history 重放时从**当前请求**的 `replay_skill_contents` / `skill_contents` 重新取正文。技能已删除时直接跳过并告警（`src-tauri/src/chat_v2/pipeline/history.rs:806-823`）。

所以源码中“以与 live 相同的渲染函数确定性重建消息字节”的前提其实是：

- 技能仍存在；
- 当前正文与当时 live 正文逐字相同。

技能升级、用户编辑、卸载或依赖解析变化后，旧历史位置会得到新正文或整段消失。这不仅打断缓存，还会让模型看到一段从未在当时请求中出现过的“历史指令”，属于语义重放风险。

不持久化技能正文是明确的隐私取舍，但隐私约束不能被描述成精确重放已经成立。更稳妥的方案是：

- 持久化内容摘要与不可变版本 ID；
- 正文进入加密、内容寻址、会话生命周期受控的私有存储；
- 重放只接受同摘要正文；
- 若正文不可得，显式开启新的 prefix generation，而不是把当前正文静默塞回旧位置。

### 中高 — 多变体只冻名字序，单变体也只在一次工具环内冻 schema 字节

单变体使用 `freeze_tool_schemas_for_prompt_cache`；多变体初始和刷新路径都只调用 `freeze_tool_schema_order_for_prompt_cache`（`multi_variant.rs:1270-1325,1675-1689`）。同名 schema 在一个变体工具环中发生键序、描述或参数变化时，多变体没有冻结副本。

即使在单变体，`frozen_tool_schemas` 也在每次 `execute_with_tools` 开始时重建（`tool_loop.rs:304-337`）。也就是说：

- 名字顺序跨用户轮持久化；
- schema 字节只在同一用户轮的递归工具调用中稳定；
- MCP schema 在两次用户发送之间变化时，下一轮立即采纳新字节。

这可能是“功能更新优先于缓存”的合理策略，但名称“H 前缀冻结”容易让人误以为 tools 字节已跨轮冻结。真实能力是“跨轮冻结名字序、轮内冻结字节”。应把 schema digest/version 纳入 prefix generation；变化时明确记录一次代际切换和预期 miss，而不是无标识地换字节。

### 中高 — available skills 快照解决了抖动，也制造了并发首发和长期陈旧

前端首次构建 system 时先把 live catalog 放进模块 Map，随后以 `void invoke(...)` 异步持久化，当前请求不会等待后端 first-write-wins 结果（`src/features/chat/adapters/TauriAdapter.ts:5288-5340`）。

两个窗口在 metadata 尚无快照时可分别生成 A、B：

1. 两边都先用自己的值发首个请求；
2. 后端只让一个值持久化；
3. 失败一方收到权威值后才回灌内存。

最终会收敛，但已经发出的首轮前缀不一致。这里保证的是“竞争后稳定”，不是“第一次发送前原子冻结”。

另一个代价是快照永久不变。会话中途安装的新技能、从不可用变为可用的技能，仍不会出现在旧 catalog；源码注释称它们可由 `load_skills` tool result 表达，但模型在目录里根本看不到新 ID 时，通常没有理由先调用它。尤其旧快照仍写着 `available="false"` 和“不要加载”时，产品能力会长期陈旧。

建议把首次目录改为“持久化成功后再发请求”，并为后续变化设计当前 user 尾部的 `available_skills_delta` 或显式“刷新会话能力”代际；不能在“永不变”和“每轮重算 system”之间二选一。

### 中 — 精确重放旁路没有覆盖首次请求前的崩溃窗口

`save_user_message_immediately` 在 pipeline 执行前只保存原始用户消息和普通 content 块（`src-tauri/src/chat_v2/pipeline/persistence.rs:252-288`）。`llm_content` 必须等编译完成后，由 `persist_replay_sidecar` 在中间保存或最终保存时补写（同文件 `:212-249,552-553,1213-1214`）。

如果 provider 已收到首轮请求，而进程在第一次中间/最终保存前崩溃：

- provider 可能已经建立缓存；
- DB 中用户消息存在；
- `llm_content` 仍为 NULL；
- 重启后 history 回退到旧重建路径。

这条窗口与“即时保存用于防闪退”的目标正好重叠。应在 current user 编译完成后、发起网络请求前，用一个轻量事务补写 `llm_content`；工具 call ID 和 round text 再按工具轮增量写。

### 中 — 24 小时 retention 是完成态注释，实际没有生产接线

`provider_accepts_prompt_cache_retention` 与 `apply_openai_prompt_cache_retention` 完整实现了官方端点门控及模型代际分叉，注释也称其为“P0 缓存：延长保留到 24h”（`src-tauri/src/llm_manager/model2_pipeline.rs:3189-3213`）。

但两者在全仓只有定义，没有生产调用。`prepare_provider_request` 实际只写 `prompt_cache_key`（同文件 `:3260-3308`）。

因此：

- 稳定 cache key 已落地；
- 24h retention 没有落地；
- 当前代码会让阅读者误判目标已完成。

若 24h 是产品目标，应在 provider request 的最终 body 上接线并做官方端点快照测试；若尚未决定，应删除死实现或明确标成实验代码。

### 中 — 现有遥测无法验证多变体稳态，也无法定位真正的前缀分叉

多变体 usage 由 model2 层记录，写入 `session_id` 的值却是带随机 run UUID 的 `stream_event`（`model2_pipeline.rs:5709-5738`；随机 event 构造见 `multi_variant.rs:829-836`）。同一真实会话的下一次发送会得到新 event，`cache-hit-report.py` 又直接按该列分组并把每组第一条当 cold（`scripts/cache-hit-report.py:160-175,263-301`）。

结果是多变体跨用户轮的“steady”统计被切成一批 run 级小会话；工具环内第二次调用可能被算 steady，但它不等于报告宣称的跨轮会话稳态。

调试指纹也比注释弱。`CHAT_V2_CACHE_DEBUG` 只输出转换前 `messages` 的整体 SHA-256（`model2_pipeline.rs:4388-4409`）：

- 没有保存上一请求，自然没有“首个分叉点 diff”；
- 不包含 `tools`；
- 不是 provider adapter 转换后的最终 body；
- 无法观察 Responses 工具扁平化、Anthropic 尾断点、DeepSeek hosted tool 替换后的形状。

所以当前能回答“命中多少”，但不能可靠回答“哪一段先变了”；对多变体连“跨轮命中多少”都可能分组错误。

应分开持久化真实 `session_id`、`variant_id`、`run_id`，并对最终 provider 请求生成结构化 prefix fingerprint：至少分 system/instructions、tools、历史消息、当前 user 四段，记录首个变化段及 prefix generation。

## 测试质量判断

现有测试不是摆设。它覆盖了：

- `function.name` 排序键；
- 新工具只能尾部追加；
- preserve-order 下语义相等但字节不同的 schema 回写；
- metadata 清内存后的工具序和 microcompact 锚点恢复；
- system 动态块迁出；
- `llm_content`、tool ID、round text 的读写与分支复制。

但测试结论普遍停在 helper 或 pre-adapter 层，缺少四类关键反例：

1. 两个并行变体从同一基线分别追加 X、Y，之后某轮同时出现 X、Y；
2. 技能正文在 live 后修改或删除，再重放旧锚点；
3. current user 已发给 provider、sidecar 尚未保存时模拟崩溃；
4. 对 OpenAI Responses、Anthropic、DeepSeek 的**最终 provider body**做连续请求前缀对比，而不是手工拼 `stable_system + tools JSON`。

特别是 `prefix_snapshot_tests.rs:145-234` 只对 helper 输出做 JSON 前缀断言；真实请求之后还会做 Responses 扁平化、Anthropic `cache_control` 标记和 DeepSeek工具替换。它证明了内部编排意图，没有证明线上请求的最终形状。

## 建议的收口顺序

1. **先修多变体作用域。** 不要让一个 session 级 `Vec<String>` 承担分叉变体的线性化承诺；引入 fan-out 前统一代际，或 variant/branch 局部基线。
2. **给技能正文版本化。** 用 digest + 受控私有快照保证旧锚点只重放旧正文；拿不到正文就显式换代，禁止用新正文伪装旧历史。
3. **把 `llm_content` 写入前移到首个网络请求之前。** 关闭崩溃恢复时最明显的精确重放缺口。
4. **原子冻结首次 skills catalog，并设计尾部 delta。** 同时解决多窗口首发竞争与旧会话看不到新能力。
5. **统一工具 prefix generation。** 记录名字序、schema digest、provider 转换版本；单变体与多变体使用同一字节冻结原语，schema 更新形成可观测代际。
6. **修正遥测身份和指纹。** session/variant/run 分列；在 post-adapter body 上按段取指纹并定位首个分叉。
7. **接线或删除 24h retention。** 不保留“看起来已经完成”的无调用实现。

## 最终判断

相对 v0.9.44，0824 的 H 改造把缓存从零散技巧推进到了“请求位置、重放数据、会话状态、协议 usage”四层协作，主方向正确，单变体正常路径也有较好的实现质量。

但它还不是统一的前缀冻结系统：并发变体没有可满足的全局序，技能正文会改写历史，available skills 首发不是原子冻结，sidecar 有崩溃窗口，schema 字节冻结范围又小于名字序范围；同时多变体报告和调试指纹不足以证明线上收益。

因此适合评价为：**高价值改造，核心机制可用；存在确定的并发与重放缺口，遥测尚不足以支撑“缓存闭环已完成”的结论。**
