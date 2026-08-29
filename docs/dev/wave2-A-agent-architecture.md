# Wave2-A 架构结论:新 Agent 体系 vs 本仓契合度矩阵(终稿)

- 作者:0824 Wave2-A 第 5 轮 #4「架构结论」(claude-fable-5-thinking-high)
- 日期:2026-08-26
- 基线:`cursor/0824-wave2-agent-cache-a875` @ `2d70b400`(第 4 轮已收);对标外部体系的检索日期均为 2026-08-26
- 输入:r1 四份调研(`docs/dev/wave2-A/r1-anthropic-cache.md`、`r1-openai-cache.md`、`r1-deepseek-gemini.md`、`r1-agent-frameworks.md`)+ 第 2–4 轮全部落地文档与台账(`docs/dev/wave2-A-ledger.md` R2/R3/R4 章节)
- 性质:只写文档。本席未改任何产品代码、未执行任何编译/测试。文中「已落地」均指**源码层面静态落地**,第 2–4 轮全部改动尚未经 cargo check / cargo test / tsc 验证(台账 R2-6 / R3-8 / R4-10 诚实归因)。**本文档不标 Goal complete**。

---

## 1. 三条设计原则(定稿)

本仓 chat_v2 缓存与 Agent 体系的三条最高设计原则,经 r1 四方对标(Claude Code / Claude Agent SDK / OpenAI Agents SDK / OpenCode)确认与业界共识一致或更强,第 2–4 轮的全部落地均围绕它们展开:

### 原则一:会话内工具面 append-only

一个会话内,发给 provider 的 tools 数组只允许**尾部追加**,已发出的名字序与 schema 字节不得变动。业界对照:OpenCode 用字母序确定性排序防文件系统枚举抖动([issue #18215](https://github.com/anomalyco/opencode/issues/18215):排序抖动 → 0% 缓存命中);OpenAI 官方缓存文档明文「keep tool definitions, ordering, and schemas consistent」、新工具 append 到 context 末尾。本仓走得更远:「首见序 append-only」冻结(`freeze_tool_schema_order_for_prompt_cache`)+ schema 字节冻结 + 第 2 轮起三键持久化(`toolFacePrefixGeneration` / `frozenToolSchemaOrder` / `toolSchemaDigest`),把约定升级为机制。

### 原则二:system 稳定前缀

system prompt 分稳定层与动态层,稳定层跨轮字节不变、动态内容(日期、检索结果、瞬态技能指令)一律落当前 user 消息或尾部瞬态块。业界对照:OpenCode S1/S2 双块拆分(稳定块 + 动态块各打断点,跨 repo 命中 87%→97.7%,并有 midnight-date 事故教训);Anthropic 官方「断点放稳定前缀尾,易变块后打点 = 每请求纯写入永无命中」。本仓 `prompt_builder` 只产稳定层,配三个字节级防护测试(白名单拼接 / 禁运行时日期 / 跨轮字节稳定),防护体系比 OpenCode 更系统;第 4 轮又把 `<available_skills>` 目录首发改为 await 冻结成功才发请求,闭合了 system 第 0 字节前缀的持久化权威。

### 原则三:子代理不复用母前缀

子代理运行在独立 session、自有 system prompt,不继承母对话的前缀字节;母子间信息传递走显式受控通道。这是**业界共识**:Claude Code subagent 隔离上下文窗口 + 任务简报,只回传摘要;OpenAI Agents SDK 的 handoff / agents-as-tools 子 agent 都是独立请求;OpenCode 同向。本仓实现:子代理独立 session + 独立 system prompt(`subagent_executor.rs`),上下文继承显式四档 `ContextInheritance::{None, Summary, LastNTurns, Full}`(`agent_profile.rs`),运行时回传 typed completion。缓存收益不来自「母子共享前缀」,而来自「同 profile 多次派发的子代理彼此命中自己的稳定 system 前缀」——这一点与 Claude Code「子代理复用配置层使自身前缀可缓存」同构(自证测试仍欠,见矩阵 A7)。

**推论(多变体场景)**:业界没有「同 session 多变体共扇出」的现成答案(最近似的 Claude Code agent teams / SDK parallel agents 均为完全独立窗口,成本换隔离)。本仓自研的方案 A(fan-out 统一代际)是三原则在多变体下的延伸:fan-out 入口一次快照 `(g, B_g)` 分发、环内只推本地、join 按变体索引序确定性收敛、真分叉才 `g+1`——用一次可预算的 miss 换 T+2 起全体收敛同一前缀,保住单一 append-only 序列不变式。

---

## 2. 契合度矩阵终稿(21 行)

判定口径:**契合** = 本仓已达业界同等或更强;**半契合** = 方向一致但有缺口;**不契合** = 业界有明确实践而本仓缺位或相反;**已改造(待验证)** = r1 判为缺陷、第 2–4 轮已在源码层面落地改造、尚未经编译/测试/运行时验证。「变化」列记录相对 r1 初判(`r1-agent-frameworks.md` 14 行矩阵)的状态迁移。

### 2.1 A 部分:Agent 体系结构面(14 行,承接 r1 #4 矩阵并按 2–4 轮落地更新)

| # | 维度 | 业界实践 | 本仓现状(含 2–4 轮落地) | 终稿判定 | 变化 | 改造建议 |
|---|------|----------|--------------------------|----------|------|----------|
| A1 | hooks 准入链(执行前拦截) | Claude Code `PreToolUse` exit 2 阻断、stderr 回喂 | `ToolGateOutcome::Block` + `ApprovalGateHook` 链首 + TOCTOU 三段;r1 P8 已落地失败语义文档化 + fail-closed 断言(`167eb104`) | **契合** | 半契合项(文档化)已收口 | 无需再动 |
| A2 | hooks 失败/批次切点 | Claude Code `PostToolUseFailure` / `PostToolBatch`(批次归一后、下一次模型调用前可停环) | `after_tool` 仅成功后触发;并行批次归一无批次级钩子。2–4 轮未动 | 半契合 | 无 | 后续补 `after_tool_failure` / `after_round`(trait 默认实现零破坏),审计钩子借此覆盖失败路径 |
| A3 | compaction 边界钩子 | Claude Code `PreCompact` 可阻断、`PostCompact` 可重注入 | `before_compaction` 无返回值不可阻断,无 `after_compaction` 切点。2–4 轮未动 | **不契合** | 无 | `before_compaction` 升级返回 skip/proceed,补 `after_compaction`;与 G-FIFO(32K 头删抢跑)同批处理 |
| A4 | tool_loop 工具环结构 | OpenAI Agents SDK runner 同构环;仅 `max_turns` 硬上限 | `execute_with_tools` 同构且更强:doom-loop 指纹终止、轮上限软硬结合、超限落 `tool_limit` 块而非抛错 | **契合** | 无 | 无结构性改动 |
| A5 | compaction 算法形态 | Anthropic `compact_20260112` 阈值触发、摘要块替换头部 | tail 锚定压缩(首 2 user turn 逐字保留 + 末 N turn + 中段摘要),双端锚定比服务端更保守 | **契合** | 无 | 算法不动;FIFO 触发次序问题归 A3 同批 |
| A6 | compaction 与 prompt cache 交互 | Anthropic `clear_at_least`(清一次值回票价);OpenCode compaction 做成上一请求的前缀延伸 | **部分改善**:r4 #6 把「目录换代标记」落进 compaction 同一事务(压缩后前缀本就报废,零成本换代时机);但摘要生成请求仍不复用主链前缀、触发阈值不联动 cache write 成本 | 半契合 | 改善(换代时机已联动) | 摘要请求改主链前缀延伸;触发条件联动「至少释放 X tokens」 |
| A7 | 子代理 prompt 是否复用母前缀 | 业界共识:**不复用**,fresh context + 自有 system + 任务简报 | 独立 session + 独立 system + `ContextInheritance` 四档显式化,方向与业界完全一致 | **契合** | 无 | 缺一条自证:同 profile 多次派发的子代理 system 走 `stable_system` 字节纪律的跨派发稳定测试 |
| A8 | 子代理并发/深度/完成契约 | Claude Code 子窗只回摘要 + 元数据 trailer | 并发 4 / 深度 3 / 超时双档 / runtime-owned typed completion / 输出截 4000 字符 | **契合** | 无 | 无需动 |
| A9 | system 稳定前缀 | OpenCode S1/S2 双块 + 禁易变量进稳定块 | 稳定层/动态层分离 + 三个字节级防护测试;r4 #5 目录**原子首发**(await 冻结成功才进 LLM 请求,fail-closed 不发),8 个 send/retry 入口全闸 | **契合** | 强化(P4 首发竞态收口) | 若技能/agent 列表将来进稳定前缀,必须按名字确定性排序(预防 OpenCode #18215 型抖动) |
| A10 | 会话内工具面 append-only | OpenCode 字母序 + schema 剔除易变字段 | r1 缺口 P3(字节冻结只活单窗口)已由 r2 关闭:三键随会话持久化、统一入口 `freeze_tool_face_for_prompt_cache`(名字序 + 字节 + digest 三元组),多变体补齐此前缺失的字节级冻结 | **已改造(待验证)** | 半契合 → 改造完成 | 验证轮跑 `prefix_generation_fork/restore_tests`;digest 稳定性(serde_json preserve_order)需运行时字节对拍 |
| A11 | multi_variant 前缀治理 | 业界无同 session 多变体现成答案(agent teams / parallel agents 均独立窗口) | r1 判「唯一业界没答案 + 本仓有真实缺陷」;r2 方案 A 四层落地:spawn 前统一快照 Arc 分发、删两处中途写回、join 后按变体索引序收敛、真分叉才 g+1、`VariantMeta.tool_face_prefix` 支持逐字节重放;并发/语义双审阅零翻案 | **已改造(待验证)** | 不契合 → 改造完成 | 验证轮;第 5 轮 #8/#9 正在收 digest 冲突切代信号与前端 pending generation 消费(见 §4) |
| A12 | skills 渐进披露与注入治理 | Claude Code 目录常驻 system;OpenCode 列表进稳定块、正文驻留 transcript 位置冻结 | r1 缺口 P2/P4 大部收口:r3 `skill_body_digest` 合同 + 重放门禁(digest 不一致 → warn+skip,禁新正文伪装旧历史)+ 生产者同源填 digest;r4 目录原子首发 + compaction 换代双键 + delta 瞬态尾部通道设计与最小落地 | 半契合(收口中) | 大幅改善 | 剩余:缺口 A(digest 冲突返回切代信号,r5 #8 进行中)、前端换代兑现与 delta 发送路径接线(r5 #9 / 后续)、qbank 出口挂接 |
| A13 | 审计与准入的钩子间依赖 | Claude Code hooks 彼此独立、stdin JSON 传上下文 | r1 P8 已落地:module doc 声明「准入必须先于审计」、依赖字段 fail-closed 断言测试、`ToolAdmission` 字段私有化 | **契合** | 半契合 → 收口 | 长期若开放第三方钩子再评估显式上下文传递 |
| A14 | 历史 append-only 与重放 | Agents SDK session 跑前 prepend / 跑后 append;typed compaction 块 | 历史只尾插 + 带 `tailStartMessageId` 的显式 compaction 记录;r3 重放门禁进一步保证「重放字节 = 当时发出字节」;r3 #9 确认分支复制 digest 随 meta_json 免费继承、tool_call_id 全链路逐字保持 | **契合** | 强化 | 无需动 |

### 2.2 B 部分:Provider 缓存契约面(7 行,综合 r1 #1/#2/#3 三份调研)

| # | 维度 | 官方契约(2026-08-26) | 本仓现状 | 终稿判定 | 改造建议 |
|---|------|------------------------|----------|----------|----------|
| B1 | Anthropic 断点位置 | 断点必须放**稳定前缀尾**;易变块后打点 = 每轮纯写入(1.25x)零命中 | G3:整个 system 当单块、块尾打点,而 system 内含 `user_profile` 等会话内可变段;adapter 侧「拆稳定/易变、保留调用方稳定段尾标记」机制已具备但上游从不拆块 | **不契合**(机制在、用法不符;对实际命中率影响最大的结构性问题) | 上游把 system 拆「稳定块(打点)+ 易变块(不打点)」,与 prompt 链锚定配合 |
| B2 | Anthropic TTL / 四槽 / 工具 marker | 可选 `ttl:"1h"`(1h 断点须在 5m 之前);每请求 ≤4 显式断点否则 400;工具缓存 = 最后一个工具打标 | `CacheControl` 无 ttl 字段、三处硬编码 5m;无槽位计数守卫;`convert_tool_definition` 恒 `cache_control: None` → `has_marker` 死分支 | 半契合(r5 #2 落地中:四槽预算 + 工具 marker 死分支修复) | TTL 全链路(G4/G5/G11)与槽位守卫同批;`cache_creation` 5m/1h 分桶解析随 TTL 落地 |
| B3 | OpenAI Responses 显式断点 / key / 端点门控 | 块级 `prompt_cache_breakpoint:{"mode":"explicit"}` 仅 GPT-5.6+;顶层 instructions 打不了断点须迁 developer 块;`prompt_cache_key` 必须稳定 | P0 三件全对齐:断点形状逐字节同形 + instructions 迁移 + 模型/端点双门控(fail-closed 到 api.openai.com);key 稳定不随机、DeepSeek 官方排除;`function_call_output` 断点零写入陷阱天然规避 | **契合** | 可选:端点白名单扩 Azure Foundry / Bedrock(官方已支持);explicit-only 模式按工作负载实测后再议 |
| B4 | OpenAI retention | GPT-5.6+ 上 `prompt_cache_options.ttl` **唯一合法值 `"30m"`**(即默认);`prompt_cache_retention` 已 deprecated | P6:死实现(两函数全仓零调用点)且 5.6+ 分支带非法值 `ttl:"24h"`——注释宣称的 24h 保留收益从未存在 | **不契合**(死实现带错值;r5 #1 裁决执行中) | 优先**删除** 5.6+ 分支(不发即默认 30m);旧代分支删或经门控仅官方 OpenAI 接线 `prompt_cache_retention:"24h"`;**任何情况禁止带 24h 接线** |
| B5 | CC 路径 `cache_control` 400 面 | DeepSeek CC 的 system.content 是 string required,数组即 400;Fireworks / Azure Mistral 类严格网关对块级 `cache_control` 400(实锤名单) | G-CC400:model2 给每个请求的 system 打「数组 + cache_control」,CC 清洗层只清 tools 不剥 cache_control 不压平 → 官方 DeepSeek V3.x(协议回落 CC)**确定性 400** | **不契合**(P0 级 400 面,全矩阵唯一「线上确定性炸」项) | CC 路径按端点压平 system 为 string 并剥 `cache_control`(保留 Anthropic / OpenRouter / LiteLLM 白名单透传);`strict:false` 无条件注入、`store`/`prompt_cache_key` 发一切 Responses 网关两处中低风险面同批评估 |
| B6 | DeepSeek / Gemini 自动缓存与 usage 观测 | 两家全自动缓存无需请求参数;usage 字段名三家四形态各异 | 四处解析器覆盖除 Gemini Interactions API 外全部命中字段;「presence 即测量、NULL≠0、多格式取 max」口径正确;Gemini 抬升无字段不注入避免伪 0;`stream_options` 端点门控与业界修复方向一致 | **契合** | Gemini 显式缓存(cachedContents)为可选增强;DeepSeek Responses 超 1M 无预检属防御缺口低优先 |
| B7 | 遥测身份与命中率度量 | 命中率优化的前提是可信度量:稳定 session 维度 + 分段指纹定位首个分叉 | P7:`record_llm_usage_cache_ext` 拿随机 `stream_event` 冒充 session_id,多变体 steady 统计失真;`CHAT_V2_CACHE_DEBUG` 指纹非 post-adapter 最终 body、不含 tools 段 | **不契合**(r5 #1/#3 落地中) | session_id / variant_id / run_id 分列;指纹改 post-adapter 四段(system / tools / history / current-user)记录首个分叉段;`cache-hit-report.py` 按新列分组 |

### 2.3 统计

**矩阵合计 21 行**(A 部分 14 + B 部分 7)。终稿判定分布:

| 判定 | 行 | 数量 |
|------|----|------|
| 契合 | A1 A4 A5 A7 A8 A9 A13 A14 B3 B6 | 10 |
| 已改造(待验证) | A10 A11 | 2 |
| 半契合 | A2 A6 A12 B2 | 4 |
| 不契合 | A3 B1 B4 B5 B7 | 5 |

相对 r1 初判(14 行:契合 7 / 半契合 5 / 不契合 2)的迁移:不契合的 A11(multi_variant 代际)与半契合的 A10(字节冻结单窗口)经第 2 轮方案 A 改造完成待验证;半契合的 A13 经 P8 收口为契合;A6/A9/A12/A14 获得实质强化。B 部分 5 个非契合项中,B2/B4/B7 三项由第 5 轮并行席位落地中,B1/B5 为已锚定未认领的最大遗留。

---

## 3. 缓存命中原则(定稿)

第 2–4 轮落地沉淀出的六条命中原则,后续一切缓存相关改动须逐条对照:

1. **分层失效模型是一切决策的前提**。缓存按 `tools → system → messages` 顺序整体哈希,前层任一字节变化使该层及其后全部失效。因此治理优先级恒为:tools 面(append-only + 字节冻结)> system 面(稳定前缀)> messages 面(历史 append-only + 重放字节一致)。
2. **前缀变更必须显式换代,禁止静默漂移**。任何会改变已发前缀字节的事件(多变体真分叉、compaction、技能编辑、目录变更)都要经代际键(`toolFacePrefixGeneration` / `availableSkillsSnapshot[Pending]Generation`)显式声明,由消费方在下一个稳定窗口兑现;first-write-wins 只能被换代键推翻,不能被普通路径覆写。
3. **字节纪律不冻一半**。OpenCode 教训:任何一处字节抖动都打掉整段前缀,冻一半等于没冻。名字序、schema 字节、技能正文 digest、注入锚点位置须同时成立;digest 必须与实际发出字节严格同源(锚定时刻取渲染所用的同一份内容),禁止事后按 id 盲取。
4. **断点只打在稳定前缀尾**。易变内容(日期、user_profile、检索结果、瞬态技能指令)一律落动态层/当前 user/尾部瞬态块;断点后的字节必须跨轮稳定,否则断点是每轮纯写入。这是 B1 尚未达成、后续改造的核心判据。
5. **客户端全量重放 + 稳定 key,不依赖服务端状态**。默认 `store:false`,靠 prompt cache(断点 + 稳定 `prompt_cache_key`)而非 `previous_response_id` / conversation 换性能——与 Codex 官方实践同路线,隐私更严;换代/压缩产物必须支持逐字节重放(`VariantMeta.toolFacePrefix`、typed compaction 记录、digest 门禁)。
6. **观测先行,presence 即测量**。`cached_tokens` / `cache_write_tokens` NULL = 未测量 ≠ 0;「打了断点却 hit/write 双 0」= 低于模型最小 token 门槛的静默失败信号;命中率结论只能建立在 B7 修复后的真实 session 维度数据上,禁止拿静态推理当收益证据。

---

## 4. 后续路线

按依赖序排列(前项是后项的前提),不标 Goal complete:

### 路线一(最高优先):验证轮 + 遥测闭环——把「静态落地」变成「可信事实」

第 2–4 轮累计 30+ 文件、约 +1700/−170 产品与测试源码**一次都未编译**,不排除低级编译错误;方案 A 的缓存收益、digest 稳定性(serde_json preserve_order)、游标化等价性均只有源码推理。行动项:cargo check / cargo test / tsc / rustfmt 全量过一遍并跑 `prefix_generation_fork/restore_tests`、`skill_replay_digest_tests`、`llm_content_crash_tests`;第 5 轮 P7 遥测(session_id 分列 + post-adapter 四段指纹 + `cache-hit-report.py`)接通后,用真实 API 的命中率数据回验方案 A 与断点策略——这是全部缓存工作的收益证明链,没有它一切判定停留在「待验证」。

### 路线二:换代机制端到端兑现——收口 A11/A12 的最后一公里

代际层(r2)、digest 门禁(r3)、compaction 换代标记与 delta 通道(r4)目前是「后端已声明、前端未兑现」的半闭环:缺口 A(digest 冲突只 warn+skip 不发切代信号,r5 #8 进行中)、TauriAdapter 消费 `availableSkillsSnapshotPendingGeneration` 兑现目录换代(r5 #9 进行中)、delta 发送路径接线、`stream_filter_core` 第二刀迁移与文档改口、#5 反例段改门禁断言。全部收口后,「前缀变更必须显式换代」原则才真正端到端成立。

### 路线三:缓存击穿面收口——B1/B5 两个已锚定未认领的最大遗留 + compaction 边界

(a) **B5 CC 400 面**(P0 级):CC 路径压平 system 为 string 并剥 `cache_control`,否则官方 DeepSeek V3.x 用户确定性 400,这是全矩阵唯一线上必炸项;(b) **B1 Anthropic 断点位置**:system 拆稳定/易变块,把「每轮纯写入零命中」修成真命中,是对实际命中率影响最大的单项改造;(c) **compaction 边界**(A3/A6 残余):`before_compaction` 可阻断 + `after_compaction` 切点、FIFO 32K 头删让位于 compaction、摘要请求改主链前缀延伸并联动「至少释放 X tokens」阈值。

### 路线四(次优先,随做随收)

Anthropic TTL 1h 全链路 + 四槽守卫(B2 残余,含 `cache_creation` 分桶解析);子代理跨派发 system 字节稳定自证测试(A7);hooks 失败/批次切点(A2);qbank 出口挂接、Gemini 显式缓存、Responses 端点白名单扩面、DeepSeek 1M 预检等低优先项。

---

## 5. 输入文档清单

| 文档 | 角色 |
|------|------|
| `docs/dev/wave2-A/r1-anthropic-cache.md` | Anthropic 官方契约 14 条差距(G1–G14),B1/B2 依据 |
| `docs/dev/wave2-A/r1-openai-cache.md` | OpenAI Responses/缓存/Agents SDK 对照,B3/B4 依据 |
| `docs/dev/wave2-A/r1-deepseek-gemini.md` | DeepSeek/Gemini/网关 400 面,B5/B6 依据 |
| `docs/dev/wave2-A/r1-agent-frameworks.md` | 14 行架构矩阵初稿(A 部分前身)与四体系要点 |
| `docs/dev/wave2-A-ledger.md` | 第 1–4 轮台账:P1–P11 对照、方案 A 裁定、R2/R3/R4 落地取证与未验证归因 |
| `docs/dev/wave2-A/r2-*.md`(7 份) | 方案 A 四层落地与并发/语义双审阅(A10/A11 依据) |
| `docs/dev/wave2-A/r3-*.md`(8 份) | llm_content 前移、技能 digest 合同/门禁/生产者、重放与分支复制审阅(A12/A14 依据) |
| `docs/dev/wave2-A/r4-*.md`(8 份) | reasoning 过滤、常量单源、出口挂接、目录原子首发/换代/delta、过滤哲学审阅(A6/A9/A12 依据) |

外部引用以各 r1 文档内的引用清单为准(均为 2026-08-26 检索),本文不重复罗列。

---

## 6. 第 9 轮勘误与状态补记(只追加,§1–§5 原文一字未动)

- 作者:0824 Wave2-A 第 9 轮子代理 #2(claude-fable-5-thinking-xhigh)
- 日期:2026-08-26;基线:`cursor/0824-wave2-agent-cache-a875` @ `dd300cd3`(第 8 轮已收)
- 性质:只写文档,追加勘误。本席未改任何产品代码、未执行编译/测试。下列「现况」均为本席对当前工作区源码的 grep/读码复核(静态证据),并与台账 R5/R6/R7/R8 章节交叉核实。**第 8 轮实测入口已被工具链门禁阻断(本机 rustc 1.83,仓需 1.98,台账 R8-1),验证轮至今未发生,全部「已改造(待验证)」项的"待验证"状态整体维持。本节不标 Goal complete。**

### 6.1 B2 状态勘误:四槽预算 + 工具 marker 已改造(待验证);TTL 1h 仍缺

勘误:§2.2 B2 行原句「`convert_tool_definition` 恒 `cache_control: None` → `has_marker` 死分支」与判定「半契合(r5 #2 落地中:四槽预算 + 工具 marker 死分支修复)」。现况:第 5 轮已在源码层面落地完毕,第 9 轮口径判定为**已改造(待验证)**:

- 工具 marker 透传:`convert_tool_definition` 收口处透传调用方 `cache_control`(`providers/mod.rs:3334`,不再恒 `None`),`:2402` 的 `has_marker` 判定自此可达——调用方已打块级 marker 时原样保留、不再无条件追加尾部保险断点(伴随测试 `anthropic_tool_cache_control_passthrough_suppresses_tail_breakpoint` @ `:5772`,只写未跑)。
- 四槽预算守卫:`enforce_anthropic_cache_breakpoint_budget`(`:2930`,调用点 `:2414`,`ANTHROPIC_CACHE_BREAKPOINT_BUDGET = 4` @ `:2923`)——顶层 automatic 恒占 1 槽,块级(tools + system)预算 3,超额按「tools 先于 system、段内靠前先剥」留尾剥头。第 6 轮 #10 二检全项重验通过(R6-2 行 10,含零损剥除论证);第 7 轮补预算契约测试文件 `wave2_a_anthropic_budget_tests.rs`(`#[cfg(test)]` 接线于 `:3796`,只写未跑)。
- **仍缺(维持原改造建议,归 §4 路线四)**:TTL 1h 全链路未动——`CacheControl` 结构体至今仅 `cache_type` 一个字段(`:2889-2892`),`providers/mod.rs` 全文件无 `ttl` 字样(本席 grep 复核);`cache_creation` 5m/1h 分桶解析同样未落。B2 剩余缺口就此收窄为「TTL 1h + 分桶解析」。

### 6.2 B4 状态勘误:retention 死实现已删除,禁止再带 24h 接线

勘误:§2.2 B4 行原句「P6:死实现(两函数全仓零调用点)且 5.6+ 分支带非法值 `ttl:"24h"`」与判定「**不契合**(死实现带错值;r5 #1 裁决执行中)」。现况:第 5 轮已按第 1 轮第 7 节「优先删除」裁决执行完毕——`apply_openai_prompt_cache_retention` / `provider_accepts_prompt_cache_retention` 两个死实现**整体删除**,本席 grep 复核全仓仅剩 `model2_pipeline.rs:3588` 起的 P6 裁决注释(钉死三条接线硬约束:仅官方 OpenAI 端点、GPT-5.6+ 仅 `ttl:"30m"`、必须快照测试;R5-2 取证、r5 #5 审阅确认删除安全)。第 9 轮口径判定为**已改造(待验证)**;因被删实现本就零调用点,线上请求字节从未含 retention 参数(不发即官方默认 30m,恰为唯一合法值),残余风险仅编译级。**任何情况禁止再带 `ttl:"24h"` / `prompt_cache_retention:"24h"` 接线**——该禁令已以原位注释形式钉在未来复活者的必经之路上。

### 6.3 B7 状态勘误:遥测身份三列已改造(待验证);coordinator 中断收敛硬编码 V20260824 未修

勘误:§2.2 B7 行原句「P7:`record_llm_usage_cache_ext` 拿随机 `stream_event` 冒充 session_id,多变体 steady 统计失真」与判定「**不契合**(r5 #1/#3 落地中)」。现况:第 5 轮已落地、第 6 轮二检并修 2 bug,第 9 轮口径判定为**已改造(待验证)**:

- session/variant/run 分列:`llm_usage/types.rs:143/:148` 新增 `variant_id` / `run_id` 两列(builder `:264/:270`);migration `V20260826__add_stream_identity.sql` 注册于 `data_governance/migration/llm_usage.rs:152`、入迁移集 `:193`(`SET.count() == 8` 断言在位),读路径 `llm_usage/repo.rs:688-690` 已引用——均本席 grep 复核。
- 四段指纹与报告脚本:`CHAT_V2_CACHE_DEBUG` 指纹改 post-adapter 最终 body 四段切分并记录首个分叉段(R5-2);`scripts/cache-hit-report.py` 三级分组(session_id / variant_id / run_id 共 27 处命中,本席 grep),第 6 轮 #7 又修复 `--days` 时间戳形状字典序陷阱与非数字代际后缀两侧分组分歧两处 bug(R6-4)。
- **未修(注明,本轮归 D)**:仓内「ALTER 已落盘、refinery history 未落盘」中断态的两处显式收敛**均硬编码只认 V20260824**——`data_governance/migration/coordinator.rs:3843`(`CACHE_WRITE_VERSION: i32 = 20260824`)与 `llm_usage/database.rs:495`(`VERSION: i32 = 20260824`),本席 grep 复核至今如此。V20260826 同为重放边界之后的 ADD COLUMN(且为**两条** ALTER,V20260824 式「列存在即证明整迁移落盘」的证明不可照搬),残留态重跑将以 `duplicate column name: variant_id` 硬失败且两条收敛路径都不认领(R5-M2-2,P2)。`coordinator.rs` 在第 9 轮红线禁碰清单内,本轮**归 D、未修**,待后续显式授权 coordinator.rs + database.rs 成对收敛并仿 V20260824 双侧测试补齐。

### 6.4 原则三维持声明

§1 原则三「子代理不复用母前缀」**原文维持,不改向**。第 5–8 轮无任何朝「母子共享前缀」方向的改动(各轮台账红线自证,`subagent_executor.rs` / `agent_profile.rs` 零触碰);A7 判定维持契合。A7 改造建议中的自证测试(同 profile 跨派发子代理 system 走 `stable_system` 字节纪律的稳定测试)**仍欠**——第 7 轮测试席补的是会话内跨轮 system 稳定测试(`system_prefix_bytes_identical_across_rounds_*` 等,见 `r7-test-inventory.md` :87/:115),未覆盖子代理跨派发场景,继续挂 §4 路线四。

### 6.5 统计补充:第 9 轮口径判定分布(§2.3 原文不动)

按 6.1–6.3 勘误后的**第 9 轮口径**(基线 `dd300cd3`,静态证据,21 行不变):

| 判定 | 行 | 数量 |
|------|----|------|
| 契合 | A1 A4 A5 A7 A8 A9 A13 A14 B3 B6 | 10 |
| 已改造(待验证) | A10 A11 B2 B4 B7 | 5 |
| 半契合 | A2 A6 A12 | 3 |
| 不契合 | A3 B1 B5 | 3 |

相对 §2.3 终稿分布(10/2/4/5)的迁移:B2(半契合)与 B4/B7(不契合)三行经第 5 轮落地迁入「已改造(待验证)」;A12 维持半契合但实质收窄(缺口 A 与前端换代兑现已闭环,见 6.6-1,剩 delta 发送路径接线与 qbank 出口挂接)。「已改造(待验证)」5 行共同等待同一个验证轮(第 8 轮已尝试、被 rustc 1.83 工具链门禁阻断,R8-1);「不契合」只剩 A3(compaction 边界钩子)、B1(Anthropic 断点位置)、B5(CC 400 面)三个未认领结构项,与 §4 路线三口径一致。

### 6.6 历史勘误三处(正文过时句,原段不改写)

1. **勘误**:§2.1 A11 行原句「第 5 轮 #8/#9 正在收 digest 冲突切代信号与前端 pending generation 消费(见 §4)」及 §4 路线二原句「缺口 A(digest 冲突只 warn+skip 不发切代信号,r5 #8 进行中)、TauriAdapter 消费 `availableSkillsSnapshotPendingGeneration` 兑现目录换代(r5 #9 进行中)」。**现况**:两项均已于第 5 轮落地——缺口 A 走 catalog pending 通道收口(门禁升级 `rebuild_anchored_skill_messages_gated_with_signal` 三消费点全改走,信号聚合唯一写点 `record_skill_digest_prefix_generation_signal`,R5-6,本席 grep 复核两符号在 history.rs/helpers.rs 在位);前端 pending 兑现闭环(TauriAdapter.ts `pendingGeneration` 13 处命中,本席 grep;R5-6 取证、R6-2 行 6 二检确认)。另补记 A11 面新事实:第 6 轮唯一产品级翻案——会话级 `toolSchemaDigest` 死接线(converge 只收 order 不收变体 digest)由 #1 检出并在独占面修复(R6-3),纯观测面缺陷、无请求字节错误;digest 共识采纳仍零测试覆盖(验证轮项)。delta 发送路径接线三轮顺延仍开,R6-5 认识升级:需跨 TS/Rust 两侧独占面,建议接线轮排成对席位。
2. **勘误**:§2.3 末句「B2/B4/B7 三项由第 5 轮并行席位落地中,B1/B5 为已锚定未认领的最大遗留」。**现况**:前半句已过时——三项第 5 轮已落地(R5-2/R5-3),其中 B2/B7 面经第 6 轮十面二检重验(R6-2 行 7/10),B4 删除经 r5 #5 审阅确认删除安全(R5-7);后半句维持有效(B1/B5 至第 9 轮仍未认领)。
3. **勘误**(处置台账 R6-5 所记「#7 架构文档三处勘误未处置」,依据 `r5-review-arch.md` §四):
   - §4 路线一原句「第 2–4 轮累计 30+ 文件、约 +1700/−170 产品与测试源码一次都未编译」——数字**低估约一半**。r5 #7 实测 `git diff --stat 167eb104..2d70b400 -- src-tauri/src src` 为 **26 个唯一源码文件、+3722/−162**(其中四个新增测试文件合计 +1465);「30+」系按轮次人次(8+10+13=31)误计,「+1700」漏加 R2 已提交部分(+360)与全部测试文件。方向不变(体量巨大且零验证),量化口径以本条为准。
   - §2.1 A1 行「变化」列原句「半契合项(文档化)已收口」——措辞错误:r1 初判 A1 即为契合,从未有过半契合判定(半契合→契合的迁移只发生在 A13);本意应为「r1 的改造建议(P8 文档化)已收口」。不影响 §2.3 统计(迁移句只列 A13,正确)。
   - 文档头免责声明原句「第 2–4 轮全部改动尚未经 cargo check / cargo test / tsc 验证」——覆盖面偏窄:第 1 轮 P8 的 hooks.rs 改动(`167eb104`)与 A1/B3 所依赖的 Step 22「已修」裁决同为静态结论、自带测试从未执行。口径应读作「**第 1–5 轮(现至第 8 轮)全部产品改动与 Step 22 已修裁决均为静态结论,未经运行时验证**」。属表述收紧,不改 B3 判定。
