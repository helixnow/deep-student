# r1-anthropic-cache：Anthropic Prompt Caching 官方契约 vs 本仓差距清单

Wave2-A 第 1 轮 #1 调研员产出。检索日期：**2026-08-26**。
基线：`cursor/0824-wave2-agent-cache-a875` @ `44176988`（基座 `061b4815`，Step 23）。
本文只读代码 + 官方文档调研，未改任何产品代码。行号均以当前 tip 为准。

## 一、官方契约要点（2026-08-26 版官方文档）

引用来源（均于 2026-08-26 检索）：

- [Anthropic 官方 Prompt caching 文档](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)（下称「官方主文档」）
- [Claude Cookbook: Prompt caching through the Claude API](https://platform.claude.com/cookbook/misc-prompt-caching)
- [anthropics/skills claude-api prompt-caching.md](https://github.com/anthropics/skills/blob/main/skills/claude-api/shared/prompt-caching.md)
- [anthropics/anthropic-cookbook misc/prompt_caching.ipynb](https://github.com/anthropics/anthropic-cookbook/blob/main/misc/prompt_caching.ipynb)
- 旁证（第三方网关行为）：[OpenRouter prompt caching 指南](https://openrouter.ai/docs/guides/best-practices/prompt-caching)

契约要点逐条：

1. **两种模式并存**：
   - **Automatic caching（官方推荐）**：请求体**顶层**加 `"cache_control": {"type":"ephemeral"}`，系统自动把断点放到「最后一个可缓存块」，并随对话增长自动前移。顶层 `cache_control` 是 Messages API 合法参数（注意：本仓旧文档 `docs/dev/sota-conversation-core/ROUND-01-cache-prefix.md:34` 断言「顶层 cache_control 不是 Messages API 合法参数」，按 2026-08-26 官方文档该断言**已过时**）。
   - **Explicit breakpoints**：在具体 content block 上打 `cache_control`，用于精细控制/独立缓存 system 与工具/混合 TTL。
   - 两者**可组合**；组合时 automatic 断点**占用 4 个槽位之一**。
2. **TTL**：默认 5 分钟（每次命中刷新）；可选 `{"type":"ephemeral","ttl":"1h"}`（写入价 2x，5m 写入价 1.25x，读 0.1x）。**混用约束：1h 断点必须出现在所有 5m 断点之前**，否则不合法。
3. **四槽预算与 400 面**：每请求最多 4 个显式断点。边界（官方主文档 Automatic caching → Edge cases）：
   - 尾块已有显式标记且 TTL 与顶层相同 → automatic 为 no-op；
   - 尾块显式标记 TTL 与顶层**不同 → 400**；
   - 已有 4 个显式断点再加顶层 automatic → **400**（无空槽）；
   - 尾块不可作断点目标时系统静默向前找最近合法块，找不到则跳过缓存；
   - 顶层 automatic 在 legacy Amazon Bedrock（Opus 4.6 及更早集成）**返回 400**，该端点只能用显式断点。
4. **最小 token 门槛（按模型，静默失败）**：512（Opus 5 / Fable 5 / Mythos 5）、1024（Opus 4.8 / Sonnet 5 / Sonnet 4.6 / Sonnet 4.5 / Opus 4.1 / Opus 4 / Sonnet 4）、2048（Mythos Preview / Opus 4.7 / Haiku 3.5）、4096（Opus 4.6 / Opus 4.5 / Haiku 4.5）。低于门槛**不报错、不缓存**；判定方法是响应 usage 中 `cache_creation_input_tokens` 与 `cache_read_input_tokens` 同时为 0。
5. **前缀层级与失效序**：缓存按 `tools → system → messages` 顺序整体哈希；某层变化使该层及其后所有层失效（工具定义变 → 全部失效；system 变 → system+messages 失效；`tool_choice`/图片/thinking 配置/effort 变 → 至少 messages 失效，thinking/effort 对 tools/system 的波及为 model-specific）。
6. **断点必须放在稳定前缀尾**：官方明文（主文档 lookback 一节）「For a prompt with a varying suffix…place the breakpoint at the end of the static prefix, not on the varying block」。断点打在易变块之后 = 每请求都是新写入、永无命中。**Lookback 窗口为 20 块**：每个断点最多回看 20 个位置找已有缓存条目；单轮新增 ≥20 块会掉出窗口，官方建议提前多打一个断点。
7. **工具定义缓存**：在 `tools` 数组**最后一个工具**上打 `cache_control`，即缓存全部工具定义为单一前缀。
8. **usage 观测**：`cache_read_input_tokens`（命中）、`cache_creation_input_tokens`（写入）；启用 1h 后另有细分对象 `cache_creation: {ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}`，其和等于 `cache_creation_input_tokens`。流式协议中完整 usage 在 `message_start`，`message_delta` 终态通常只有 `output_tokens`。
9. **不可缓存**：thinking 块不能直接打 `cache_control`（但作为历史内容可被顺带缓存）；空 text 块不可缓存；子内容块（citations）不可直接缓存。
10. **GA 状态**：prompt caching 已 GA，无需 `anthropic-beta: prompt-caching-2024-07-31` 头。

## 二、本仓现状盘点（文件:行号）

Anthropic 请求转换主路径 `src-tauri/src/providers/mod.rs`（`AnthropicAdapter::convert_openai_to_anthropic`，:2256-2493）：

- **顶层 automatic**：每个请求无条件带 `cache_control: {type:"ephemeral"}`（:2489-2492；结构体 :2825-2829）。
- **system 尾保险断点**：调用方无块级标记时，在最后一个 system 块补 `ephemeral`（:2378-2388）；有标记则原样保留、不追加（:2337-2340、`extract_system_text_blocks` :2914-2939 透传块级 `cache_control` 原值）。
- **tools 尾保险断点**：无标记时在最后一个工具补 `ephemeral`（:2403-2411）；但 `convert_tool_definition` 恒定返回 `cache_control: None`（:3272-3277），调用方（OpenAI 形态 body）打的工具级标记**永远进不来**。
- **CacheControl 结构**：只有 `type` 字段（:2881-2885），无 `ttl`。
- **usage 观测**：`message_start` 完整 usage 缓存 + `message_delta` 字段级合并（:2192-2254）；`build_usage_event` 解析 `cache_read_input_tokens`/`cache_creation_input_tokens` 并上抛 `cached_tokens`/`cache_write_tokens`（:3396-3454）；非流式路径 :3578-3589。
- **beta 头**：prompt-caching beta 头已按 GA 清理不发（:2520-2522）。

上游打点 `src-tauri/src/llm_manager/model2_pipeline.rs`：

- 整个 system prompt 作为**单个 text 块**、块尾打 `cache_control`（:3662-3667）；测试夹具同形（:2509-2516）；「注入落当前 user、system 字节不变」有测试（:2503-2539 起）。
- usage 侧 `cached_tokens`/`cache_write_tokens` 提取（:7720-7781）。

现有测试（`providers/mod.rs` `#[cfg(test)]`）：

- `anthropic_adds_tools_and_system_tail_cache_breakpoints`（:5540-5582）：顶层保留 + system 尾 + tools 尾三点。
- `anthropic_preserves_caller_block_level_system_cache_control`（:5587-5616）：调用方稳定段尾标记原样保留、易变尾块不追加。
- `anthropic_build_usage_event_collects_cached_tokens`（:5849-5858）、message_start/message_delta 合并三测（:5997-6114）。

相关背景：`docs/0824-MERGE-PLAN.md` Step 22（:1007-1027）记录 provider 修复 `35706d09 → 55846040` 已落地、零测试验证遗留（P2「Anthropic 四槽+工具 marker 死分支」列为评审项之一，见 #9 台账复核）。`chat_v2` 侧 `available_skills` 目录已做会话级冻结快照（`chat_v2/repo.rs:2736-2800`、`types.rs:461-463`），system 中仍含 `user_profile` 段（`chat_v2/prompt_builder.rs:620-627`）。

## 三、差距清单

每条：官方契约 / 本仓现状（文件:行号）/ 状态 / 第 2–5 轮是否可静态落地（「静态」= 只改代码与测试源码，不跑构建）。

| # | 官方契约 | 本仓现状 | 状态 | 2–5 轮静态落地 |
|---|---|---|---|---|
| G1 | 顶层 automatic `cache_control` 为合法参数，自动断点随对话前移 | `providers/mod.rs:2489-2492` 无条件下发；测试 :5562-5566 | **已对齐** | 无需（保持） |
| G2 | 旧结论「顶层 cache_control 非法」已被官方文档推翻 | `docs/dev/sota-conversation-core/ROUND-01-cache-prefix.md:34` 仍写「该路径等于没有 prompt caching」 | **缺失**（文档过时，误导后续轮次） | 可：追加勘误注记（docs-only） |
| G3 | 断点应放**稳定前缀尾**，易变块后打点=永不命中 | `model2_pipeline.rs:3662-3667` 把整个 system 当**单块**、块尾打点；system 内含 `user_profile`（`prompt_builder.rs:620-627`）等会话内可变段；adapter 的「拆稳定/易变、保留调用方稳定段尾标记」能力已具备（`providers/mod.rs:2381-2388`、测试 :5587-5616）但上游从不拆块 | **半对齐**（机制在，用法不符） | 可：prompt_builder/model2_pipeline 把 system 拆「稳定块(打点)+易变块(不打点)」，与 #8 prompt 链锚定配合 |
| G4 | TTL：默认 5m，可 `ttl:"1h"`（写 2x） | `CacheControl` 无 `ttl` 字段（`providers/mod.rs:2881-2885`）；三处打点全部硬编码 5m（:2386、:2408、:2490）；块级透传路径 :2928-2930 理论可带 ttl 但无上游产生 | **缺失** | 可：加 `Option<String> ttl` + 序列化 + 上游配置开关；纯代码可静态验证 |
| G5 | 混用 TTL 时 1h 必须在 5m 之前 | 无任何排序校验（全仓无 `ttl` 生产者，当前不触发） | **缺失**（G4 落地时必须同步） | 可：转换层加断言/重排 + 单测 |
| G6 | 四槽预算；4 显式+automatic → 400；尾块显式 TTL 与顶层不同 → 400 | 本仓结构性最多产生 3 槽（tools 尾 :2403-2411、system 尾或调用方标记 :2381-2388、顶层 :2489），不超额；但**无计数守卫**——调用方多块 system 各自带标记即可 >4 槽直接 400 | **半对齐** | 可：转换尾部加「显式断点计数 ≤3（留 1 给 automatic）、超额剥除最早多余标记」+ 单测 |
| G7 | 工具缓存 = 最后一个工具打 `cache_control` | tools 尾保险断点 :2403-2411 行为正确；但 `convert_tool_definition` 恒 `cache_control: None`（:3272-3277）→ :2405 `has_marker` **恒 false 死分支**，调用方无法自定义工具断点/TTL | **半对齐**（结果对、透传死） | 可：`convert_tool_definition` 读取 `tool.cache_control` 或 `function.cache_control` 透传 + 单测激活死分支 |
| G8 | 最小 token 门槛（512/1024/2048/4096 按模型）；低于门槛静默不缓存，判据是两 usage 字段同 0 | 无门槛感知；usage 两字段已上抛（`providers/mod.rs:3396-3454`、:3578-3589；`model2_pipeline.rs:7720-7781`）可供判定，但无「打了点却全 0」的遥测/日志告警 | **半对齐**（观测在、判定缺） | 可：usage 事件消费处加调试日志/遥测计数；与 #telemetry 轮次配合 |
| G9 | 20 块 lookback；单轮新增 ≥20 块建议追加中位断点 | 完全依赖 automatic 单点，无历史内显式断点；长工具环单轮可产生大量块（tool_use + tool_result 各成块） | **缺失**（低优先，automatic 覆盖常规轮） | 可：tool_loop 长环路径在倒数第 N 轮 user 块补第 4 槽断点；需与 G6 预算守卫联动 |
| G10 | 流式 usage：`message_start` 含完整缓存字段，终态 delta 仅 output | `message_start` 缓存 + 字段级合并（:2192-2254），测试 :5997-6114 | **已对齐** | 无需 |
| G11 | 1h 启用后 `cache_creation` 细分对象（5m/1h 分桶） | 未解析（`build_usage_event` :3432-3454 只取顶层 `cache_creation_input_tokens`） | **缺失**（仅 G4 落地后才有意义） | 可：usage 解析加 `cache_creation.ephemeral_1h_input_tokens` 分桶 |
| G12 | thinking 配置/effort 变更至少失效 messages 缓存（model-specific 波及 tools/system）；「effort 显式设为默认值 = 省略」 | 本仓 per-request 决定 thinking/effort（:2310-2327、:2447-2463），无「会话内保持 thinking/effort 稳定以保缓存」的约束或文档注记 | **半对齐**（行为合法、缓存代价未声明） | 可：注释/文档注记 + 会话级配置固定建议（docs+注释级） |
| G13 | 顶层 automatic 在 legacy Bedrock（Opus 4.6 及更早集成）400；第三方 Anthropic 兼容网关兼容性不一 | 顶层字段无条件下发（:2489-2492），无按 base_url/端点门控 | **半对齐**（官方直连对齐；兼容网关有 400 风险面，与 #3 调研员的网关 400 面交叉） | 可：按 base_url 白名单门控顶层字段（保留块级断点兜底）+ 单测 |
| G14 | prompt caching GA，无需 beta 头 | beta 头已清理（:2520-2522） | **已对齐** | 无需 |

统计：**14 条**——已对齐 3（G1/G10/G14）、半对齐 6（G3/G6/G7/G8/G12/G13）、缺失 5（G2/G4/G5/G9/G11）。全部 11 条非对齐项均可在第 2–5 轮以「只写代码/测试/文档、不跑构建」方式静态落地；其中 G4+G5+G11（TTL 全链路）建议同轮打包，G6+G7+G9（槽位预算+工具透传+长环断点）建议同轮打包。

## 四、最关键的 3 个缺口

1. **G3 断点不在稳定前缀尾**（`model2_pipeline.rs:3662-3667` 单块 system 整体打点；`prompt_builder.rs:620-627` user_profile 在 system 内）：只要 system 任一字节变化，system+messages 两层缓存全灭，system 尾断点变成每轮纯写入（1.25x）零命中；这是当前对实际命中率影响最大的结构性问题，且 adapter 侧保留机制（:2381-2388）已就绪，只差上游拆块。
2. **G4/G5 TTL `1h` 全链路缺失**（`providers/mod.rs:2881-2885` 无 ttl 字段；:2386/:2408/:2490 三处硬编码 5m）：官方 1h 档 + 排序约束完全未建模，长间隔会话（>5 分钟回复间隔）无法保温缓存。
3. **G7 工具 marker 死分支 + G6 四槽无守卫**（`providers/mod.rs:3272-3277` 恒 None → :2405 恒 false；无显式断点计数）：调用方工具断点/TTL 透传不可达，且缺「≤4 槽（automatic 占 1）」预算守卫，上游一旦多打块级标记即触发官方 400 边界。

## 五、引用

- https://platform.claude.com/docs/en/build-with-claude/prompt-caching （检索：2026-08-26）
- https://platform.claude.com/cookbook/misc-prompt-caching （检索：2026-08-26）
- https://github.com/anthropics/skills/blob/main/skills/claude-api/shared/prompt-caching.md （检索：2026-08-26）
- https://github.com/anthropics/anthropic-cookbook/blob/main/misc/prompt_caching.ipynb （检索：2026-08-26）
- https://openrouter.ai/docs/guides/best-practices/prompt-caching （检索：2026-08-26，第三方网关旁证）
