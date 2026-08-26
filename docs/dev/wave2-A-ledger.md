# Wave2-A 第 1 轮台账（#10 台账员）

- 作者：0824 Wave2-A 第 1 轮子代理 #10「台账员」（claude-fable-5-thinking-high）
- 日期：2026-08-26
- 性质：只追加的汇总台账。本文档汇总 #1–#9 全部第 1 轮产出 + hooks.rs 工作区改动，
  自身不改任何产品代码。所有「已验证」结论均为静态证据（读代码 / grep / git diff），
  本轮未执行任何编译、测试、CI（铁律）。

---

## 1. 基线

| 项 | 值 |
|---|---|
| 基座 | `origin/cursor/0824-cde6` @ `061b4815`（Step 23 tip：四门禁 + 18 不变量 + Tauri 实机记录） |
| 本枝 | `cursor/0824-wave2-agent-cache-a875`（开枝提交 `44176988`，其上已落 #1/#2/#3/#4/#5/#7/#8/#9 八份 r1 文档提交，tip `4f5bd4fa`） |
| Draft PR | #345 |
| 第 1 轮模型 | 全部子代理 `claude-fable-5-thinking-high`（含本台账员），无 sol / GPT / xhigh |
| 工作区未提交改动 | `src-tauri/src/chat_v2/pipeline/hooks.rs`（#6 的 P8 四小件，+76/−26）+ untracked `docs/dev/wave2-A/ROUND-01-TASKS.md`、`docs/dev/wave2-A/r1-hooks-p8.md`、本文件 |

## 2. 必读缺口声明

`docs/0824-quality-review/*` **不在 tip 061b4815**（目录不存在，已实测确认）。该目录是
P1–P11 缺口编号的原始定义处。本轮按任务卡改用替代必读集：

- `docs/0824-MERGE-PLAN.md` Step 22（provider 修复 `35706d09 → 55846040` 已落、零测试执行）
  与 Step 9 §9.4（18 不变量权威清单）；
- `docs/dev/sota-conversation-core/ROUND-01-{cache-prefix,pipeline,responses-adapter,tools,telemetry}.md`
  与 `ROUND-02-synthesis.md`；
- `docs/dev/0824-g-chat.md`、`docs/dev/0824-g-invariants.md`。

**编号纪律（父代理第 1 轮收轮更正）**：P1–P11 以用户本会话任务书为准，
不以 `docs/0824-quality-review/*` 是否在树为转移。#10 初稿把 P5/P7/P9/P10/P11
重建成 Anthropic 断点 / CC 400 / FIFO / compaction 钩子 / TTL，**已作废**。
那些内容降级为第 3 节后的「额外发现（G 编号）」，不占用 P 号。

## 3. P1–P11 对照总表

| 编号 | 缺口 | 现状 | 本轮结论 | 后续轮次 | 文件:行号 |
|---|---|---|---|---|---|
| P1（锚定） | 多变体并发前缀分叉：[A,X] vs [A,Y] 后 append-only 合并救不了 | 变体各自 load / 中途 store 共享名字序基线，写回竞态决定合并序；T+1 必 miss ≥1 个变体；变体当轮真实字节不可重放 | #7 设计稿完成，二选一论证毕，**裁定方案 A（见第 4 节）** | 第 2 轮落地 | `multi_variant.rs:1270-1275, 1313-1323, 1679-1686`；`helpers.rs:1017-1081`；`repo.rs:2686-2734` |
| P2（锚定） | 技能正文不冻结：锚点只存 id，重放取当前正文 | 编辑技能后历史中部技能消息字节静默漂移，后缀缓存全断且零告警（仅「正文缺失」才 warn） | #8 锚定精确路径 + 提出 `skillContentDigest` 方案（不存正文，兼容隐私约束） | 第 2 轮落 digest 键；第 3 轮做正文快照与换代联动 | `history.rs:158-164, 324-330, 353-359, 809-824`；`types.rs:1080-1083`（`without_skill_contents`） |
| P3（锚定） | schema 字节只冻单窗口；多变体只冻名字序 | 字节冻结容器为 `execute_with_tools` 局部变量，跨回合重建；multi_variant 对 `freeze_tool_schemas_for_prompt_cache` / `frozen_schemas` **零命中**（grep 证实）；`execute_single_variant` 连名字序冻结都没有 | #5 全量锚定完成（原语表 + 8 个生产调用点 + 测试清单），确认是有意设计边界而非 bug，但跨轮字节稳定无兜底 | 第 2 轮评估随代际键持久化字节冻结（挂方案 A 数据键） | `tool_loop.rs:337, 985-995`（:990-991 注释自认窗口级）；`multi_variant.rs:961, 1316-1319, 1679-1682` |
| P4（锚定） | `availableSkillsSnapshot` 首发非原子 + 永久陈旧 | 前端 fire-and-forget 冻结（发送不等待落库）；双窗口竞争靠后端 first-write-wins 裁决，败方已发字节成事实；first-write-wins 无任何换代出口，卸载技能后目录仍列它 | #8 锚定两条精确路径完毕 | 第 3 轮挂 `prefixGeneration` 提供换代出口（本轮不改 TS） | `TauriAdapter.ts:5288-5314, 5323-5341`；`progressiveDisclosure.ts:630-675`；`repo.rs:2772-2811`（first-write-wins :2793-2796） |
| P5（用户任务书） | `llm_content` 崩溃窗口：已发 provider、sidecar 未保存 | 第 1 轮未深锚 persistence.rs；已知热区 `persistence.rs:252-288`（首个网络请求前应补写） | 待第 3 轮落地「当前 user 编译完成后、网络请求前轻量事务补写」 | 第 3 轮 | `src-tauri/src/chat_v2/pipeline/persistence.rs:252-288`（待复核） |
| P6（任务卡锚定） | OpenAI retention 死实现且 5.6+ 分支 ttl 值非法 | 详见第 7 节 | #2、#3、#9 三方独立复核一致：死代码 + `ttl:"24h"` 非法（官方唯一合法值 `"30m"`） | **第 5 轮裁决：优先删除，或改值后再接线；禁止带 24h 接线** | `model2_pipeline.rs:3193-3196, 3205-3214`（:3210 `ttl:"24h"`，:3212 旧代 `"24h"` 合法） |
| P7（用户任务书） | 遥测身份错误：随机 `stream_event` 当 `session_id`；`CHAT_V2_CACHE_DEBUG` 指纹不含 tools、非 post-adapter body | 第 1 轮未深改 model2 记账路径；#2/#3 顺带确认 usage 解析器覆盖三家字段 | 第 5 轮：session_id/variant_id/run_id 分列 + post-adapter 四段指纹 | 第 5 轮 | `model2_pipeline.rs:5709-5738`（身份）、`:4388-4409`（指纹）；`scripts/cache-hit-report.py` |
| P8（任务卡锚定） | hooks.rs 四小件（本轮唯一产品改动） | **本轮已落地**，详见第 8 节 | 完成：删只写字段 / 依赖文档化+断言 / trait 失败语义 / 泛型等待器收敛 | 后续轮若允许改 tool_loop.rs，可把 `ToolAdmission::new` 调用点去参 | `hooks.rs`（工作区 diff +76/−26） |
| P9（用户任务书） | 过滤器与出口：reasoning 通道不过滤、双常量表、consume_prefix O(n²)、非流式出口 | 第 1 轮未落地；常量表路径 `utils/model_special_tokens.rs` 与 `streaming_anki_service.rs:45` 仍在 | 第 4 轮统一挂接；E 域算法不动只做常量引用 | 第 4 轮 | `llm_adapter.rs:1142-1176`；`variant_adapter.rs:451-473`；`model_special_tokens.rs:206-208` |
| P10（用户任务书） | provider 协议回归（Step 22 `55846040` 308 行） | 详见第 5 节独立复核 | P0 已修 / P1×2 已修 / Anthropic 四槽+工具 marker **未修** | 第 5 轮补 P2 + 快照测试钉死已修项 | `providers/mod.rs`（见第 5 节行号） |
| P11（用户任务书） | 行业调研：新 Agent 体系与原体系契合度 | #1–#4 调研完成，14 行矩阵（契合 7 / 半契合 5 / 不契合 2） | 第 5 轮定稿 `docs/dev/wave2-A-agent-architecture.md` | 第 2–5 轮把可静态落地项写入代码 | `docs/dev/wave2-A/r1-agent-frameworks.md` 及三份缓存调研 |

### 额外发现（不占 P 号，G 编号供后续轮参考）

| G | 发现 | 建议轮次 | 出处 |
|---|---|---|---|
| G3 | Anthropic 断点打在整块 system 尾，system 内含 user_profile 等可变段 → 每轮纯写入零命中 | 第 3–4 轮拆稳定/易变块 | #1；`model2_pipeline.rs:3662-3667` |
| G-CC400 | CC 路径 system 数组 + `cache_control` 直发 → 官方 DeepSeek V3.x 确定性 400 | 第 3 轮起：CC 压平+剥离 | #3；`providers/mod.rs:614-651` |
| G-FIFO | FIFO 32K 头删抢在 compaction 前把前缀清零 | 第 3 轮阈值让位 | #4；`compaction.rs:1168` |
| G-compact-hooks | `before_compaction` 不可阻断、无 `after_compaction` | 第 3 轮补切点（默认实现零破坏） | #4 矩阵行 3 |
| G-ttl1h | Anthropic TTL `1h` 缺失 + 四槽无守卫 + 工具 marker 死分支 | 第 5 轮与 P10-P2 打包 | #1 G4/G5/G6/G7；#9 P2 未修 |
| G-misc | 变体重放混拼 CONTENT；Responses `strict:false` 无条件注入；`ROUND-01-cache-prefix.md:34` 顶层 cache_control 非法断言已被 2026-08-26 官方推翻 | 文档勘误 + 后续轮 | #1 G2 / #3 / ROUND-01-pipeline |

## 4. 第 2 轮代际方案裁定：采用方案 A（fan-out 统一代际）

**裁定**：采用 #7 推荐的**方案 A**——会话保持唯一权威 tools 前缀基线 + 代际号 `g`，
fan-out 入口一次性快照 `(g, B_g)` 分发全部变体，环内只推本地不写共享，join 收敛点按
**变体索引序**（非完成竞态序）确定性合并，仅真分叉（≥2 变体产生互异尾部）才 `g+1`。
父代理确认采纳。

**理由**（依 #7 §3 对照表）：

1. **不变式保全**：单一 append-only 序列不变式原样保留，现有 4 条
   `frozen_tool_schema_order_*` repo 测试不动；方案 B 把不变式碎成 N 份 per-variant，
   测试全改。
2. **缓存经济性**：B 的唯一优势（分叉轮下一轮双方都命中）是一次性收益，代价是 N 条
   永不收敛的缓存血统（Anthropic cache write 加价随变体数线性放大）；A 用一次可预算的
   miss 换 T+2 起全体收敛同一前缀。分叉本身（环内披露出不同技能工具）是低频事件。
3. **权威对象唯一**：子代理复用母前缀、单变体续聊晋升，在 A 下都有唯一 `(g, B)` 可引用；
   B 必须先回答「继承哪个 variant 的」，晋升本身又是一次分叉——问题只被推迟。
4. **侵入面**：A = load 上移 + store 下移 + 1 个 generation 键 + 1 个收敛函数；
   B = 键型全面改造 + 谱系规则 + 晋升逻辑 + 分支复制（`repo.rs:1948-2049`）/ GC 连带。
5. **确定性与可测性**：A 的合并序由变体索引决定，消除 `:1275` load 竞态与 store 竞态
   抽签，可复现可测试；重放靠 `VariantMeta.toolFacePrefix`（`B_g[..base_len] + tail`）
   逐字节还原。

**第 2 轮最小文件清单**（依 #7 §4.4，与 #8 §5 键位建议对齐）：

| 文件 | 改动 |
|---|---|
| `src-tauri/src/chat_v2/types.rs` | `ToolFacePrefixSnapshot` 结构 + `VariantMeta.tool_face_prefix`（Option + skip_serializing_if 兼容老数据）；键常量（:459-481 三常量旁） |
| `src-tauri/src/chat_v2/repo.rs` | `TOOL_FACE_PREFIX_GENERATION_METADATA_KEY`；`get/advance_session_tool_face_prefix(_with_conn)`（IMMEDIATE、双键同事务、无变更跳过写库、**不推 `updated_at`**——#8 §2 纪律） |
| `src-tauri/src/chat_v2/pipeline/helpers.rs` | `load_session_tool_face_prefix`（值型扩为 `ToolFaceBaseline{generation, order}`）+ 新增 `converge_session_tool_face_prefix`（锁内合并克隆、放锁写库，锁序不倒置） |
| `src-tauri/src/chat_v2/pipeline/multi_variant.rs` | spawn 前统一快照（`:498` 之前）；删 `:1270-1275` 变体内独立 load；删 `:1320-1323` / `:1683-1686` 中途写回；变体收尾写 `VariantMeta`；`join_all` 后收敛；retry 批（`:2628`/`:2824`）同接 |
| `src-tauri/src/chat_v2/pipeline/tool_loop.rs` | `:331` load 改新结构取 `order`；`:992` 单变体 store 语义不变（纯前缀扩展**不切代**） |
| `prefix_snapshot_tests.rs` / `repo.rs #[cfg(test)]` | 反例测试源码 4 组（写不跑）：确定性收敛+g+1、单扩展不 bump、重放字节还原、双键同事务共存性 |
| `docs/dev/0824-g-invariants.md` | 增补「多变体 tools 前缀代际」不变式一条 |

红线延续：方案 A 不触碰 hooks.rs 任何切点/准入序列/TOCTOU（#7 §4.5 已声明）；
新键写库不推 `updated_at`（#8 §2：推了会扰动 `ORDER BY updated_at DESC` 会话列表排序）。

## 5. Provider 四项（Step 22 `35706d09 → 55846040` 独立复核，依 #9）

| 项 | 裁决 | 关键证据（当前 tip 行号） | 针对性测试 |
|---|---|---|---|
| P0 `prompt_cache_breakpoint` 形状 + 端点门控 | **已修** | `providers/mod.rs:1563` `{"mode":"explicit"}` 块级对象；`:758-760` + `:130-135` host 精确等于 `api.openai.com`（抗后缀伪装）；`:721-756` 模型名完整型号段解析 | 2 个（wire body 快照 `:5091` + 模型解析正反例 `:5172`） |
| P1 `include_usage` 终止状态机 | **已修** | `:79-98` `saw_finish_reason: AtomicBool`；`:303-310` finish_reason 只记标记不发 Done；Done 三来源（`[DONE]` / 流内 error / EOF `finish_stream` `:317-326`）；EOF 接线 `model2_pipeline.rs:5011` | 4 个 mod.rs + 1 harness + 3 个相邻 pipeline 终止门 |
| P1 `stream_options` 端点门控 | **已修** | `:161-172` 注入条件收紧为官方端点 + 未显式设置；调用方显式 false 保留 | 1 个（`:6118`，三情况锁定） |
| P2 Anthropic 四槽预算 + 工具 marker 死分支 | **未修** | 55846040 对 Anthropic 段零改动；`:2405` `has_marker` 恒 false（`convert_tool_definition` 恒 `cache_control: None`，`:3276`）；全文件无「块级断点 ≤4」预算逻辑，当前 2 槽是巧合安全 | **零针对性测试**（相邻现状固化测试 2 个不覆盖缺口） |

**测试口径更正**（#9 §五）：「308 行零测试验证」应更正为——55846040 **自带 12 个
新增/改写的 `#[cfg(test)]` 测试源码**（P0 2 个、P1 终止 4+1 个、stream_options 1 个、
Mythos 2 个等），但**从未执行**（cargo test 未跑，Step 23 四门禁只含 cargo check）。
即「零验证」成立，「零测试」不成立。四项相关测试合计 9（mod.rs）+ 4（相邻）= 13 个，
全部仅为源码存在。

## 6. 调研矩阵摘要（新 Agent 体系 vs 本仓，详见 `docs/dev/wave2-A/r1-agent-frameworks.md`）

#4 产出 14 行矩阵（对标 Claude Code / Claude Agent SDK / OpenAI Agents SDK / OpenCode，
全部 2026-08-26 当日检索），判定分布：**契合 7 / 半契合 5 / 不契合 2**。

契合要点（本仓达到或超过业界）：hooks 准入链（`ToolGateOutcome::Block` + TOCTOU 三段比
Claude Code `PreToolUse` / SDK approvals 语义更重）；tool_loop 与 Agents SDK runner 同构
且多层防失控（doom-loop 指纹终止是 SDK 没有的）；compaction 双端锚定比服务端
`compact_20260112` 更保守；子代理不复用母前缀（业界共识，本仓四档 ContextInheritance
显式化）；system 稳定前缀的三个字节级防护测试比 OpenCode 更系统；名字序 append-only
冻结超过 OpenCode 的字母序治理；历史 append-only 与 typed compaction 记录同构。

不契合两点（即额外发现 G-compact-hooks 与 **P1**）：compaction 边界钩子残缺（无阻断 / 无 after 切点）；
multi_variant 前缀治理——**业界没有「同 session 多变体共扇出」的现成答案**（最近似的
Claude Code agent teams / SDK parallel agents 都是完全独立窗口、成本换隔离），必须自研
代际方案，即第 4 节裁定的方案 A。

半契合缺口：缺失败/批次级钩子切点；compaction 请求不复用主链前缀、触发不联动 cache write
成本（对照 `clear_at_least` 思想）；字节冻结覆盖不完整（P3——OpenCode 教训：任何一处字节
抖动都打掉整段前缀，冻一半等于没冻）；技能正文字节不冻（P2）与目录快照（P4）。

## 7. P6 retention：死实现且 5.6+ 分支 ttl 非法

三方独立复核一致（#2 官方对照、#3 网关面、#9 死代码 grep），本台账员本会话再次 grep 复核：

- `rg -n "apply_openai_prompt_cache_retention|provider_accepts_prompt_cache_retention" src-tauri/src/`
  → 仅命中 `model2_pipeline.rs:3193` 与 `:3205` 两处**定义**，全仓零调用点 = **死代码**。
  线上从未发送过任何 retention 字段，注释宣称的「24h 缓存保留收益」不存在。
- `model2_pipeline.rs:3210`：GPT-5.6+ 分支写 `prompt_cache_options:{"ttl":"24h"}` ——
  **值非法**。官方（S1/S3，2026-08-26 检索）：`prompt_cache_options.ttl` **唯一合法值
  `"30m"`，同时也是默认值**；`prompt_cache_retention` 在 5.6+ 已 deprecated。带着 24h
  接线在官方端点大概率 400/参数拒绝。
- `:3212` 旧代分支 `prompt_cache_retention:"24h"` 值合法但同样未接线；真正有增益的场景
  收窄为 gpt-5.4 及更早 + 无 ZDR 组织（gpt-5.5/5.5-pro 默认已 24h）。

**第 5 轮裁决预置**（依 #2 建议，本台账确认口径）：**优先删除**——5.6+ 分支整删（不发
`prompt_cache_options` 效果等同默认 30m）；旧代分支要么随删、要么改造后经
`provider_accepts_prompt_cache_retention` 门控接进 `prepare_provider_request`（仅官方
OpenAI）。**任何情况下禁止带 `ttl:"24h"` 接线。**

## 8. P8 本轮已落地（hooks.rs，#6 独占改动）

工作区 diff：`hooks.rs` 1 文件 +76/−26（`git diff --stat` 本会话实测），四小件全部落地。
逐件证据（行号 = 改动后工作区，与 `r1-hooks-p8.md` 一致，本台账员抽查核对）：

1. **删只写字段**：`ToolAdmission.approval_arguments` 字段定义、`new()` 初始化、
   `before_tool` 末尾回写三处全删（diff 可证 `-    approval_arguments: Value,` /
   `-            approval_arguments: arguments.clone(),` /
   `-        admission.approval_arguments = approval_arguments;`）。签名兼容：
   `new(_arguments: &Value)` 保留形参（`tool_loop.rs:3189` 调用点本轮禁改），rustdoc
   注明缘由（`:62-65`）。局部变量 `approval_arguments`（`:449` 起 9 处引用）与两个
   `request_*` 形参原样保留——本台账员 grep 核对：结构体上该字段为**零**，保留命中
   全部是局部变量/形参。
2. **依赖文档化 + 断言**：module doc 新增「顺序敏感：准入必须先于审计」段（`:13-20`）；
   `default_pipeline_hooks` rustdoc 展开（`:152-158`）；新增小测试
   `audit_consumed_admission_fields_start_fail_closed`（断言三个审计依赖字段初始
   fail-closed，只写不跑）；既有测试 `default_hooks_keep_approval_gate_first` 原样在
   `:1517`（本台账员 grep 证实）。
3. **trait 失败语义**：trait rustdoc 重写——`before_turn` 可 `Err` 中断回合；
   `before_tool` 用 `ToolGateOutcome::Block` 拦截不走 Result；`after_tool` /
   `before_compaction` 不可失败（diff 中 `:102-116` 段可证）。方法签名零改动。
4. **泛型等待器**：新增 `wait_oneshot_with_optional_cancel`（`:1089-1102`，
   `F: Future` 泛型覆盖两处不同响应类型），`request_tool_approval` 与
   `request_plan_gate` 原两段同构 `tokio::select!` 删除改调之；等待后各业务分支逐字
   保留。本台账员 grep 证实全文件 `tokio::select!` 仅剩 helper 内一处。

禁改区自证（#6 报告 + 本台账员 diff 抽查）：十五段准入序列、TOCTOU 三段、
`ApprovalGateHook` 链首位（`:159-164`，`Arc::new(ApprovalGateHook)` 仍是 vec 首元素）、
catastrophe / fail-closed 测试全部未动；唯一进入准入函数体的 diff 是删除末尾一行
`approval_arguments` 赋值。

## 9. 18 不变量本轮静态自证（grep 抽查，未跑测试套件）

权威清单：`docs/0824-MERGE-PLAN.md` Step 9 §9.4（18 项，Step 23 于 061b4815 记录
18/18 PASS）。**编号勘误**：任务卡所称「7 无生产 ChatV2AnkiAdapter、17 无 mythos-5/haiku-5
真目录」在权威清单中实为 **#6** 与 **#15**（#7 是附件上限、#17 是 Composer 拆分）；
本节按语义抽查、标注权威编号。本会话抽查 5 项，全部 PASS：

**#1 pipeline hooks（ApprovalGateHook 首位）— PASS**

```text
$ rg -n 'Arc::new\(ApprovalGateHook\)|default_pipeline_hooks|default_hooks_keep_approval_gate_first' src-tauri/src/chat_v2/pipeline/hooks.rs
159: pub(crate) fn default_pipeline_hooks() -> Arc<Vec<Arc<dyn PipelineHook>>> {
161:     Arc::new(ApprovalGateHook) as Arc<dyn PipelineHook>,   ← vec 首元素
1517:    fn default_hooks_keep_approval_gate_first() {           ← 守卫测试仍在
```

**#3 H cache 冻结原语在树 — PASS**

```text
$ rg -n 'fn (sort_tool_schemas|freeze_tool_schema_order|merge_frozen_tool_schema_order_baseline|freeze_tool_schemas)_?for_prompt_cache|fn merge_frozen' src-tauri/src/chat_v2/pipeline/tool_loop.rs
26:  pub(crate) fn sort_tool_schemas_for_prompt_cache
39:  pub(crate) fn freeze_tool_schema_order_for_prompt_cache
78:  pub(crate) fn merge_frozen_tool_schema_order_baseline
105: pub(crate) fn freeze_tool_schemas_for_prompt_cache
```

四原语齐在；生产调用点（tool_loop.rs:985-995 等 8 处）由 #5 锚定文档逐一核对。

**#5 model_special_tokens 文件在 — PASS**

```text
$ ls -la src-tauri/src/utils/model_special_tokens.rs   → 存在（30666 字节）
$ rg -n 'model_special_tokens' src-tauri/src/utils/mod.rs → 5: pub mod model_special_tokens;
```

**#6（任务卡称 7）无生产 ChatV2AnkiAdapter — PASS**

```text
$ rg -l 'ChatV2AnkiAdapter' src/ src-tauri/src/   → 6 个文件命中
$ rg -n 'import.*ChatV2AnkiAdapter|new ChatV2AnkiAdapter' src/ src-tauri/src/
  → 仅命中负向守卫测试内的 expect(...).not.toMatch(...) 模式，零生产 import/new
```

6 个命中逐一核对：3 处是历史说明注释（selectionCardGeneration.ts:10、cardforge/index.ts:28、
generateCardsFromText.ts:49），3 处是负向守卫测试（cardGenerationSurfaces.source.test.ts
断言「src/ 下不存在该模块文件、生产面不 import」等）。无生产引用。

**#15（任务卡称 17）无 mythos-5 / haiku-5 真目录条目 — PASS**

```text
$ rg -ln 'mythos-5' src/ src-tauri/src/  → 仅 src-tauri/src/llm_manager/adapters/anthropic.rs
$ rg -n 'mythos-5|haiku-5' src-tauri/src/llm_manager/builtin_vendors.rs
  925:  注释「官方最新 Haiku 仍为 4.5，不存在 claude-haiku-5」
  1682-1687:  负向断言 fabricated `claude-haiku-5` must not enter the builtin catalog
```

内置目录零真实条目。`adapters/anthropic.rs` 的命中是 55846040 搭车的**代际解析器**
（FAMILIES 含 "mythos" 用于 thinking 能力判断）与其测试（:509），非目录条目——与
Step 23 在含该提交的 tip 上判 18/18 PASS 口径一致。

**附带自证**：`git diff --name-only` 全仓仅 `src-tauri/src/chat_v2/pipeline/hooks.rs`
一个已跟踪文件改动；`git status` 对 `src-tauri/src/data_governance/migration/coordinator.rs`
零输出——**coordinator.rs 本会话未碰**（归 D，红线遵守）。

未抽查的其余 13 项（#2/#4/#7-#14/#16-#18）：本轮无人触碰对应文件面（本轮唯一产品改动是
hooks.rs），沿用 Step 23 的 18/18 PASS 记录，不重复取证。

## 10. 第 2 轮任务预告（10 个子代理主题，纳入本轮裁定）

第 2 轮按用户任务书 10 席执行（模型仍全是 `claude-fable-5-thinking-high`），
纳入本轮裁定「方案 A」：

1. 代际设计实现-1 — helpers.rs + multi_variant.rs（fan-out 统一代际）
2. 代际设计实现-2 — tool_loop.rs：schema digest 纳入 prefix generation
3. 统一冻结原语 — 单变体 freeze_tool_schemas 与多变体 freeze_order 收敛
4. 元数据层 — repo.rs / types.rs：prefix generation 持久化键（不推 updated_at）
5. 反例测试源码-分叉（只写不跑）
6. 反例测试源码-恢复（只写不跑）
7. 审阅员-并发（锁序 / IMMEDIATE 事务）
8. 审阅员-语义（hooks 准入 / TOCTOU 未动）
9. 文档员 — tool_loop.rs / helpers.rs 文件头矩阵注释
10. 提交员 — grep 自检 + 父代理 commit/push/更新 #345

同文件同轮单人：先落地 types+repo（#4），再 helpers+multi_variant（#1）与 tool_loop（#2），
冻结原语收敛（#3）在 #1/#2 之后补刀。明确不在第 2 轮：P5 llm_content（第 3 轮）、
P6 retention（第 5 轮）、P7 遥测（第 5 轮）、P9 过滤器（第 4 轮）、P10 未修项（第 5 轮）、
issue #122（禁修）。G-CC400 / G-FIFO / G-compact-hooks / G-ttl1h 见额外发现表。

## 11. 已验证 / 未验证

### 已验证（仅静态证据：读代码 / grep / git diff，本会话或 r1 文档留痕）

- 基线与分支状态：`git log` 证实基座 `061b4815`、开枝 `44176988`、8 份 r1 文档已提交，
  工作区仅 hooks.rs 改动 + 3 个 untracked 文档。
- P8 四小件的 diff 形态（+76/−26）：字段删除、module/trait/fn rustdoc、
  `wait_oneshot_with_optional_cancel` 收敛、`ApprovalGateHook` 仍链首、守卫测试仍在
  `:1517`——本台账员逐条 grep/diff 复核。
- P6 死代码：两函数全仓零调用点、`:3210` ttl `"24h"` 字面量在——本台账员 grep 复核。
- 18 不变量 5 项抽查（#1/#3/#5/#6/#15）grep 证据如第 9 节，全部 PASS；
  coordinator.rs 未碰。
- P1–P4 的现状行号、Provider 四项裁决行号、调研矩阵引用：采信 #1–#9 文档所载
  （各文档自述为全量读码 + 当日 web search 产物），台账员对其中 P6/P8/不变量三块做了
  独立二次抽查，其余为文档间交叉一致性核对（如 P3 的 multi_variant 零命中在 #5 与 #7
  两份文档独立成立）。

### 未验证（诚实归因）

- **未跑任何编译 / 测试 / CI**：hooks.rs 的 P8 改动（含新增测试
  `audit_consumed_admission_fields_start_fail_closed`）**未经 cargo check / cargo test /
  rustfmt 验证**，仅为源码存在；不排除低级编译错误。
- 55846040 自带的 12 个测试与本仓全部既有测试套件本轮**一次都未执行**；第 5 节的
  「已修」裁决基于源码阅读，非运行时证据。
- P5/P7/P9 的**代码深锚**本轮未做（只登记任务书热区行号）；P10 四项已由 #9 独立复核；
  P11 调研矩阵已落盘，架构结论文档留第 5 轮。#10 初稿错误重建的编号已由父代理改回。
- 各调研文档引用的官方文档结论（Anthropic TTL、OpenAI 30m、DeepSeek/Gemini 行为、
  网关 400 实锤）为当日 web 检索产物，未经真实 API 请求验证。
- 18 不变量其余 13 项本轮未重新取证（沿用 Step 23 记录）；抽查的 5 项也仅为静态 grep，
  未跑对应测试。
