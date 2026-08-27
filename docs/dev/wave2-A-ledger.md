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

---

# Wave2-A 第 2 轮台账（#10 提交员/台账，只追加）

- 作者：0824 Wave2-A 第 2 轮子代理 #10「提交员/台账」（claude-fable-5-thinking-high）
- 日期：2026-08-26
- 性质：只追加章节。第 1 轮 P1–P11 编号与内容一字不改。本席未改任何产品代码、
  未执行 cargo/npm/测试、未 commit/push（父代理收轮）。
- 依据：`docs/dev/wave2-A/r2-impl-generation.md`（#1）、`r2-impl-tool-loop.md`（#2）、
  `r2-unified-freeze.md`（#3）、`r2-repo-prefix-gen.md`（#4）、
  `r2-review-concurrency.md`（#7）、`r2-review-semantics.md`（#8），
  以及本席对工作区 `git diff --stat` / `git log` / grep 的独立复核。

## R2-1. 本轮 diff 形态（提交员独立取证）

已提交（`d0505bc6`，wip）：`ROUND-02-TASKS.md`、`r2-repo-prefix-gen.md`、
`repo.rs`（+312/−2）、`types.rs`（+44）、`pipeline.rs`（+4，测试模块注册）、
`prefix_generation_fork_tests.rs`（+280，新文件）、
`prefix_generation_restore_tests.rs`（+539，新文件）。

工作区未提交（相对 `HEAD = d0505bc6`）：

```
 src-tauri/src/chat_v2/pipeline.rs               |  23 +--
 src-tauri/src/chat_v2/pipeline/helpers.rs       | 204 +++++++++++++----
 src-tauri/src/chat_v2/pipeline/multi_variant.rs | 144 +++++++++---
 src-tauri/src/chat_v2/pipeline/tool_loop.rs     | 105 ++++++--
 4 files changed, 405 insertions(+), 71 deletions(-)
```

untracked：`r2-impl-generation.md`、`r2-impl-tool-loop.md`、`r2-unified-freeze.md`、
`r2-review-concurrency.md`、`r2-review-semantics.md`（+ 本文件本节改动）。

## R2-2. 方案 A（fan-out 统一代际）落地状态：产品接线已完成（四层齐备）

| 层 | 席位 | 状态 | 要点 |
|---|---|---|---|
| repo/types（`d0505bc6` 已提交） | #4 | ✅ 完成 | 三键 `toolFacePrefixGeneration`（u64）+ `frozenToolSchemaOrder`（原键保留权威）+ `toolSchemaDigest`；`ToolFacePrefixSnapshot` + `VariantMeta.tool_face_prefix`；`get/advance_session_tool_face_prefix(_with_conn)` IMMEDIATE 事务读-合并-写、generation 取 max 只进不退、digest None 不抹已有值、无变更早退、不推 `updated_at`；缺键回退 generation=0；分支复制零改动（metadata clone 免费继承） |
| helpers/pipeline（工作区） | #1 | ✅ 完成 | `frozen_tool_schema_orders` 值型升级为 `ToolFaceBaseline { generation, order, schema_digest }`（单锁不变）；新增 `load_session_tool_face_prefix`（miss 回填永不 bump）与 `converge_session_tool_face_prefix`（按 variant_index 升序合并、真分叉才 +1、单变体构造上不切代、放锁后 advance）；旧 load/store 改薄封装、持久化通道升级为 advance 双键同事务 |
| multi_variant（工作区） | #1+#3 | ✅ 完成 | 三处 fan-out（主 `:509`、重试批 `:2756`、单变体重试 `:2969`）spawn 前一次快照 Arc 分发；变体内独立 load 与两处中途 store 已删（环内只推本地副本）；join 后三处 converge（`:600`/`:2844`/`:2991`）统一收敛；变体结束写 `VariantMeta.tool_face_prefix`（generation 写入口代际不自增、digest 写变体本地推进值）；多变体补齐此前缺失的字节级 schema 冻结 |
| tool_loop 单变体（工作区） | #2+#3 | ✅ 完成 | `tool_schema_digest`（名字序 sha256 + 0x1f/0x1e 定界，空窗口 None）；load 改走 `load_session_tool_face_prefix` 三元组就位（generation/digest 不再局部缺省）；digest 变化只打 info **不 bump**（单变体纯扩展不切代纪律）；store 仍 append-only 不动 generation |

**接缝已闭合**：#2 落地时因 #1 并行而内联的 load/store 段 TODO，已由 #3 收敛时删除。
本席 grep 复核：本轮 4 文件 diff 中 **TODO 零命中**（`multi_variant.rs:628` 的检索资源
TODO 为基线遗留，非本轮引入）。

## R2-3. 统一入口 `freeze_tool_face_for_prompt_cache`（#3）

- 位置 `tool_loop.rs:181`，`pub(crate)`，签名
  `(tools, frozen_names, frozen_schemas) -> Option<String>`：内部即原
  `freeze_tool_schemas_for_prompt_cache`（名字序 append-only 冻结 + 已发出 schema
  窗口内无条件字节回写，语义逐字未动）+ 返回 `tool_schema_digest`。
- 三个调用点（本席 grep 复核）：单变体环内 `tool_loop.rs:1057`、多变体初始 MCP
  注入 `multi_variant.rs:1362`、load_skills 渐进披露刷新 `multi_variant.rs:1728`。
- **门面不是替代**：`freeze_tool_schema_order_for_prompt_cache` /
  `freeze_tool_schemas_for_prompt_cache` / `tool_schema_digest` 原符号全部保留，
  既有冻结测试与反例测试仍直接调用原语。
- 返回 None（空窗口）不得抹掉已有 digest；Some 时推进本地窗口 digest。

## R2-4. 反例测试源码：已落盘、已注册、未执行

- `prefix_generation_fork_tests.rs`（#5，280 行）与
  `prefix_generation_restore_tests.rs`（#6，539 行）已随 `d0505bc6` 提交，
  并在 `pipeline.rs:92/:94` 注册 `mod`（`:90` 的 `prefix_snapshot_tests` 为
  第 1 轮 `59c7f0aa` 既有）。
- 契约锚点：#1 的 converge 语义逐条对齐 `converge_orders_by_variant_index`
  （A 追加 X、B 追加 Y → `[base…, X, Y]` 且 +1；单变体 append 不 bump），
  load 回填对齐 `locked_refill_baseline`（miss 回填永不 bump）。
- **一次都未运行**（铁律）：不排除编译错误；`cargo test` 留给父代理收轮后的
  验证轮。

## R2-5. 审阅结论：双确认、零翻案

- **#7 并发/锁序：确认。** 五项检查全过——①无 mutex×SQLite IMMEDIATE 交叉死锁
  （三原语零跨锁持有、事务体不回调内存锁、写路径统一 IMMEDIATE 无升级死锁）；
  ②load miss 双建收敛 generation=0；③converge 放锁后写库；④变体中途写共享态
  已彻底消除（唯一写点收归 join 后 converge）；⑤store 与 converge 并发不会错误
  bump。附 3 条低危备注（变体早退跳过 meta 写回、跨路径分叉理论窗口、async 内
  同步 DB IO），均为缓存效率取舍，不构成正确性缺陷、不需要补丁。
- **#8 hooks 语义/TOCTOU：确认。** hooks.rs 第 2 轮零改动（相对基线仅第 1 轮 P8
  提交 `167eb104`）；`ApprovalGateHook` 仍链首、十五段准入未触及、TOCTOU 三段
  （入口 Kill Switch / 审批后复核 / tool_loop 执行前终检）全部在位；tool_loop
  四个 hook 调用点仅行号下移、控制流逐字节不变；multi_variant 工具执行仍全量走
  `execute_tool_calls → execute_single_tool`，删除的中途 store 不在准入路径上。

## R2-6. 已验证（静态）/ 未验证

### 已验证（仅静态证据：读代码 / grep / git diff）

- 本轮 diff 全貌与归属：已提交 `d0505bc6`（#4 + #5/#6 测试源码）与工作区 4 文件
  改动（#1/#2/#3），文件面与各席任务卡独占声明一致——本席 `git log` / `git
  status` / `git diff --stat` 复核。
- 统一入口三调用点行号（`tool_loop.rs:181/:1057`、`multi_variant.rs:1362/:1728`）
  与测试模块注册（`pipeline.rs:90/92/94`）——本席 grep 复核。
- 本轮 4 文件 diff TODO 零命中（#2 接缝 TODO 已被 #3 删除）——本席 grep 复核。
- hooks.rs 本轮零 diff、`coordinator.rs`/`repo.rs` 旧函数保留——采信 #7/#8
  文档所载 grep/diff 证据，与本席 `git status`（hooks.rs 不在改动列表）交叉一致。
- 锁序/事务边界/切代规则的正确性论证：采信 #7 逐行审阅（含代码引用块），
  #8 对准入序列逐段核对；两份审阅相互独立、结论一致。

### 未验证（诚实归因）

- **未跑任何编译 / 测试 / CI**：本轮 +405/−71 产品代码与 819 行新测试源码
  **未经 cargo check / cargo test / rustfmt**；#8 亦标注审阅期间行号随并行写入
  漂移，静态行号仅为快照。不排除低级编译错误（如可见性、借用、feature gate）。
- digest 稳定性依赖 serde_json preserve_order 的论证（#2）为源码推理，
  未以运行时字节对拍验证。
- provider 侧 prompt cache 命中率收益（方案 A 的动机）无任何真实 API 证据。
- #7 的 3 条低危备注（变体早退 / 跨路径分叉窗口 / 同步 DB IO）本轮未修，
  留后续轮评估。

## R2-7. 第 3 轮预告（按用户任务书）

1. **P5 llm_content 前移**：assistant 历史重建时 llm_content 优先于 UI content，
   消除「显示文本 ≠ 发送字节」的缓存失配（第 1 轮 P5 登记项，本轮明确不做）。
2. **技能正文版本化**：load_skills 渐进披露的技能正文纳入版本/摘要管理，
   与 tools 面 digest 同构，防技能文本漂移破坏前缀。
3. **崩溃窗口测试**：converge 写库前进程崩溃 / advance 半途的恢复路径反例
   （只写不跑，延续 #5/#6 模式）。
4. **Utf8 探针**：多字节字符在冻结字节边界/截断路径上的探针测试。
5. **双适配器审阅**：Anthropic + OpenAI Responses 两适配器对 `(g, B_g, digest)`
   消费口径的一致性审阅。

（第 2 轮遗留输入：#7 三条低危备注、R2-4 未执行的测试套件、#2 digest 运行时
对拍——由第 3 轮及验证轮酌情吸收。）

## R2-8. 收轮交接（给父代理）

- 待 add：4 个产品文件（工作区 M）+ 6 份 untracked r2 文档 + 本台账追加节。
- 本席未 commit/push/gh（铁律）；Draft PR #345 更新由父代理执行。
- **不标 Goal complete**：编译/测试验证轮未跑，第 3 轮任务书已排。

---

# Wave2-A 第 3 轮台账（#10 台账员，只追加）

- 作者：0824 Wave2-A 第 3 轮子代理 #10「台账员」（claude-fable-5-thinking-high）
- 日期：2026-08-26
- 性质：只追加章节。第 1 轮 P1–P11 编号与内容一字不改，第 2 轮章节不动。
  本席未改任何产品代码、未执行 cargo/npm/测试、未 commit/push（父代理收轮）。
- 依据：`docs/dev/wave2-A/ROUND-03-TASKS.md` 与七份 r3 文档
  （`r3-llm-content-forward.md` #1、`r3-skill-digest-types.md` #2、
  `r3-skill-replay-gate.md` #3、`r3-utf8-probe.md` #6、`r3-adapter-parallel.md` #7、
  `r3-review-replay.md` #8、`r3-review-branch-copy.md` #9），
  以及本席对工作区 `git status` / `git diff` / grep 的独立复核。

## R3-1. 本轮 diff 形态（台账员独立取证）

基线枝 tip `f94f88d1`（第 2 轮四层接线已提交）。第 3 轮全部改动均在工作区未提交：

```
 src-tauri/src/chat_v2/pipeline.rs             |  17 +（mod 注册 + 阶段 4.6 调用）
 src-tauri/src/chat_v2/pipeline/history.rs     | 138 +/− （#3 门禁 + 测试）
 src-tauri/src/chat_v2/pipeline/persistence.rs |  61 + （#1 新函数）
 src-tauri/src/chat_v2/pipeline/tool_loop.rs   |  46 + （digest 生产者，见 R3-4）
 src-tauri/src/chat_v2/types.rs                | 124 + （#2 digest 类型合同）
 src-tauri/src/llm_manager/utf8_stream.rs      |  23 + （#6 探针）
 src-tauri/src/utils/sse_buffer.rs             |  15 + （#6 探针）
```

untracked 新文件：`llm_content_crash_tests.rs`（#4，205 行）、
`skill_replay_digest_tests.rs`（#5，441 行）、`stream_filter_core.rs`（#7 骨架，141 行）
+ `ROUND-03-TASKS.md` + 七份 r3 文档 + 本台账追加节。

红线自证（本席 grep/status 复核）：coordinator.rs / hooks.rs / helpers.rs /
multi_variant.rs 本轮零改动；过滤器负例测试未删（#5/#7 文件均为新增）。

## R3-2. #1 llm_content 前移（P5 落地）

- 新函数 `ChatV2Pipeline::persist_user_llm_content_early`（persistence.rs:275），
  **唯一调用点为 pipeline.rs 阶段 4.6 @ :993**（#1 文档锚定行号；父代理在文件头
  挂 5 行 `mod` 声明后，本席复核当前工作区已漂移至 **:998**，仍是全仓唯一调用点）。
- 时机链（#8 逐条核实属实）：`save_user_message_immediately` 行已 INSERT（:732）→
  阶段 4.5 `compile_frozen_context`（:984-987）后 `live_user_llm_content()` 为 Some →
  阶段 4.6 轻量 UPDATE 只写 user CONTENT 块 `llm_content` 一列 → 阶段 5
  `execute_with_tools`（tool_loop.rs:1188 发起首个主对话 provider 请求）。
- 措辞收窄（#8 §1.2，采纳）：阶段 3 检索 / 4.5 辅助 MM/OCR 可能更早有网络 I/O，
  但它们是 llm_content 的**输入**，逻辑上不存在更早的持久化点——口径统一为
  「**首个主对话 provider 请求之前**」。
- 明确不做：save_results 整体不前移；工具块 `tool_call_id`/`round_text` 留原 sidecar；
  失败只 warn 不阻断，后续保存点同参幂等重写。
- 两个既有怪癖记录不翻案（#8 §1.3）：is_continue 轮写入「未发送的包装」与既有
  save_results 逐字节同行为；multi_variant 扇出不走 `execute_internal`，变体崩溃
  窗口仍在，留后续轮。

## R3-3. #2/#3 技能 digest 类型 + history 重放门禁（P2 推进）

- **类型合同（types.rs，#2）**：`SkillInjectionAnchors` 增 `skill_content_digests:
  HashMap<String, String>`（skill_id → sha256 hex）+ `skill_content_rev: Option<u64>`，
  均 `serde(default)` + 空值跳过——旧 JSON 可解析、无 digest 时序列化字节与 r3 前
  一致（双向兼容）。`skill_body_digest(id, body) = sha256(id‖0x1f‖body‖0x1e)`，
  复用仓内 sha2 不引新 crate，骨架与 `tool_schema_digest`/`DoomLoopGuard` 同族。
  钉死向量 `316f875d…bd3dc` 由 #8 用 `sha256sum` 独立验算通过（本轮唯一可提前
  证伪的硬事实）。隐私纪律保持：`without_skill_contents` 不动，anchors 只存不可逆
  hash，正文仍不落库。
- **重放门禁（history.rs，#3）**：新增 `rebuild_anchored_skill_messages_gated`
  （原二参签名降级为兼容包装传 `anchors=None`，保住 helpers.rs 与 #5 测试的既有
  断言）。判定表：正文缺失 → warn+skip（旧行为）；digest 匹配 → 重建（live 同
  渲染函数，字节相等）；**digest 不一致 → warn+skip，禁止用新正文伪装旧历史**；
  无 digest（旧锚点）→ 旧行为兼容。三个消费点 `history.rs:159`（turn 级）/
  `:327`（tool 级命中）/ `:358`（tool 级兜底）全部过门禁，#8 核实 digest 与锚点
  严格同源同轮，无跨轮错配。

## R3-4. digest 生产者已落（缺口 B 关闭——静态）

#8 审阅时点全仓 grep 确认 digest **无生产写入方**（缺口 B：门禁对一切真实数据
空转）。本席取证期间，生产者已由并行席位落入工作区：`tool_loop.rs` +46 行，
两处锚点构造在**锚定时刻**填 digest（本席读 diff 复核）：

- turn 级（tool_loop.rs:708-737 区）：对 `built.audit.injected_skill_ids` 逐 id 取
  渲染注入消息所用的**同一** `skill_contents` 调 `skill_body_digest` 写入 map；
- tool 级（:1972-2008 区）：load_skills 环内锚定同理，正文来源即渲染本批消息的
  同一 `batch_contents`，与 turn 级共用消息级 digest map。

两处均遵守：digest 与发出字节严格同源；正文不可得的 id 不写（重放侧走「旧锚点
无 digest」兼容分支），不编造假 digest；不 bump prefix generation。
**缺口 B 在源码层面关闭**（未编译验证，见 R3-8）。

## R3-5. #6 Utf8 探针（#122 只定位不修复）与 #4/#5 测试

- **探针（#6）**：`utf8_stream.rs`（decode `Some(invalid_len)` 真非法分支 :80-87、
  flush 非空残留 :113-116）与 `sse_buffer.rs`（flush lossy 尾部 :211-216）共三个
  `log::warn!`。只记录长度类元数据（invalid_len / valid_up_to / pos / pending 长度 /
  chunk_len / 行数），**不打印任何 chunk 字节或用户文本**（PII 纪律）。两文件头
  均注明「issue #122 定位探针，**不声称修复**」；U+FFFD 替换语义零改动。探针
  只能证明/排除这两个文件内的两条 `�` 产生路径，不覆盖前端渲染层。
- **测试只写不跑（#4/#5）**：`llm_content_crash_tests.rs` 模拟「已发 provider、
  sidecar 未保存时崩溃」（无前移 → 下一轮 history 只有裸 user；有前移 →
  llm_content 在）；`skill_replay_digest_tests.rs` 覆盖技能正文修改/删除后重放
  旧锚点（digest 变 → 不得输出新正文；删除 → warn+skip）。两文件的
  `#[cfg(test)] mod` 已由父代理挂入 `pipeline.rs:96/:98`。注意：#5 文件内
  「无门禁生产函数按 id 盲取返回 v2 字节」的反例段按其文件头声明，应在门禁
  落地后改为对门禁版断言 skip——本轮该文件已冻结，留后续轮收口。

## R3-6. #7 双适配器骨架（未大迁移）

- 对照 `llm_adapter.rs` vs `variant_adapter.rs` 盘点**平行点 14 条**，其中
  #1–#5（wrap_token_filter 应用、`<think>` 标签状态机约 180 行、flush 冲刷、
  on_content_chunk、on_reasoning_chunk）为逐行级复制约 400 行，划为第一刀。
- 骨架 `stream_filter_core.rs`（141 行）已建：纯状态机（不持锁、不持 emitter、
  不管块生命周期），`process_content / process_reasoning / flush / reset` 四入口，
  返回 `Vec<RoutedPiece>{Thinking|Content}`。**本轮不迁移任何现有逻辑**；块生命
  周期与工具 args 节流留第二刀。
- 关键锚点：两侧 `on_reasoning_chunk` 目前均为**裸转发不过任何过滤器**——
  `process_reasoning` 当前直通，即第 4 轮 reasoning 过滤的一行挂点。
- 挂载状态勘误（本席复核）：#7 文档与骨架文件头均写「未在 pipeline.rs 声明
  mod、属死代码占位」，但父代理收轮时已挂 `pipeline.rs:99`
  `pub(crate) mod stream_filter_core;`——骨架**已参与编译**。文件自带
  `#![allow(dead_code)]`（注释着 R4 接线后移除），故挂载无告警风险，但两处
  文档表述已过时，第 4 轮接线者注意。

## R3-7. 审阅结论（#8 重放正确性 / #9 分支复制）

- **#8 重放确认，零翻案**：#1 时机链、写入幂等、失败语义确认；#2 算法/兼容/
  隐私/钉死向量确认；#3 门禁语义、三消费点、作用域、字节一致性确认。但合同
  未收全，两缺口：
  - **缺口 A（仍开）**：API 合同明文要求 digest 冲突「返回『需开新 prefix
    generation』信号」，当前实现只 warn+skip——技能消息从历史前缀消失（前缀
    实质失效）而 r2 的 `toolFacePrefixGeneration` 代际层不知情，违反「前缀变更
    必须显式换代」纪律。本席 grep 复核：history.rs 无 `digest_conflict` /
    `GatedRebuild`，信号未落。#8 已给补丁草案（gated 版返回
    `GatedRebuild { messages, digest_conflict }`，三消费点 OR 后落 ctx），
    **列入第 4 轮**。
  - **缺口 B（已关，见 R3-4）**：#8 审阅时点生产者缺失的结论在当时成立，
    随后 tool_loop.rs +46 落地，本席以晚于 #8 的工作区状态复核关闭。
  - 小问题 C（仍开）：二参兼容入口非 test 构建下潜在 dead_code 告警，本席
    grep 复核 history.rs 无 `cfg_attr`/`allow(dead_code)` 处理，留第 4 轮或
    验证轮顺手处置。
- **#9 分支复制确认，不翻案**：digest 随消息 `meta_json` 整体 clone（
  `manage_session.rs:1587` `meta: msg.meta.clone()`）**免费继承**，
  `copy_block_replay_with_conn` 三列 SQL（repo.rs:1988-1997）**不需要、也不应该**
  为 digest 扩第四列——「JSON 容器整体继承，物理列才需要逐列 SQL」。
  `without_skill_runtime_contents` 只清正文不碰 anchors；ID 重映射不触 meta。
  确认一条不变量：**provider tool_call_id 在分支复制全链路必须逐字保持**，
  否则锚点定位链断。非阻塞记录：旧 build 写回会丢新键（降级即合同规定的
  旧锚点行为，故障安全）。

## R3-8. 已验证（静态）/ 未验证

### 已验证（仅静态证据：读代码 / grep / git diff，本席或 r3 文档留痕）

- 本轮 diff 全貌与席位归属（R3-1 清单）——本席 `git status` / `git diff --stat`
  复核，与各席独占表一致（#1 的 pipeline.rs 调用 + 父代理 mod 注册共处一文件，
  任务卡允许）。
- `persist_user_llm_content_early` 全仓唯一调用点（persistence.rs 定义 +
  pipeline.rs 阶段 4.6 一处）——本席 grep 复核。
- 门禁三消费点行号（:159/:327/:358）、二参兼容包装（history.rs:820-824 委托
  gated 传 None）——本席 grep 复核。
- tool_loop.rs 生产者两处落地形态（+46，turn/tool 级同源填 digest）——本席读
  diff 复核（晚于 #8 审阅时点）。
- 缺口 A 未落（history.rs 零命中 `digest_conflict`/`GatedRebuild`）、小问题 C
  未处置——本席 grep 复核。
- 钉死向量 sha256 独立验算（#8 用 `printf | sha256sum`）——采信 #8，属运行
  哈希工具而非 cargo/测试，不违铁律。
- #6 探针只记长度元数据、文件头免责声明在——本席读 diff 复核。
- 红线：coordinator.rs / hooks.rs 本轮零改动——本席 `git status` 复核。

### 未验证（诚实归因）

- **未跑任何编译 / 测试 / CI**：本轮 +371（7 个 M 文件）+ 787 行新文件
  （两测试 + 骨架）**未经 cargo check / cargo test / rustfmt**；#4/#5 测试与
  types/history 的新 `#[cfg(test)]` 模块均仅为源码存在，不排除低级编译错误。
  缺口 B 的「关闭」同样仅是源码层面。
- #8 审阅期间行号随并行写入漂移（如 pipeline.rs :993→:998），静态行号仅为
  快照口径。
- 探针能否真实命中 #122 的乱码路径、digest 门禁在真实编辑技能场景下的行为，
  均无运行时证据。
- 崩溃窗口收窄的实际收益（崩溃后下一轮 history 含 llm_content）依赖 #4 测试
  与真实崩溃复现，本轮均未执行。

## R3-9. 第 4 轮预告（按用户任务书 + 本轮遗留）

主题五项（P9 域为主）：

1. **reasoning 过滤**：两适配器 `on_reasoning_chunk` 裸转发 → 接
   `StreamFilterCore::process_reasoning`（挂点已备好，见 R3-6）。
2. **常量表统一**：`utils/model_special_tokens.rs` 与
   `streaming_anki_service.rs:45` 双常量表收敛为单一来源引用。
3. **非流式出口**：出口路径挂接同一过滤（E 域算法不动只做常量引用）。
4. **consume_prefix O(n²)**：算法面评估与修复。
5. **目录生命周期**：P4 `availableSkillsSnapshot` first-write-wins 无换代出口，
   挂 prefixGeneration 提供出口。

第 3 轮遗留并入：缺口 A 切代信号（#8 §4.1 草案）、小问题 C dead_code、
#5 反例段改门禁断言、multi_variant 扇出路径的 llm_content 前移与
stream_filter_core 文档挂载表述勘误（R3-6）。

## R3-10. 收轮交接（给父代理）

- 待 add：7 个产品文件（工作区 M）+ 3 个新 rs 文件 + 8 份 untracked 文档 +
  本台账追加节。
- 本席未 commit/push/gh（铁律）；Draft PR #345 更新由父代理执行。
- **不标 Goal complete**：编译/测试验证轮未跑，缺口 A 未收，第 4 轮任务书已排。

---

# Wave2-A 第 4 轮台账（#10 台账员，只追加）

- 作者：0824 Wave2-A 第 4 轮子代理 #10「台账员」（claude-fable-5-thinking-high）
- 日期：2026-08-26
- 性质：只追加章节。第 1 轮 P1–P11 编号与内容一字不改，第 2/3 轮章节不动。
  本席未改任何产品代码、未执行 cargo/npm/测试、未 commit/push（父代理收轮）。
- 依据：`docs/dev/wave2-A/ROUND-04-TASKS.md` 与六份 r4 文档
  （`r4-reasoning-filter.md` #1、`r4-tokens-cursor.md` #2、`r4-export-filter.md` #3、
  `r4-catalog-atomic.md` #5、`r4-catalog-compaction.md` #6、`r4-catalog-delta.md` #7、
  `r4-review-filter-philosophy.md` #8），以及本席对工作区
  `git status` / `git diff` / `git hash-object` / grep 的独立复核。

## R4-1. 本轮 diff 形态（台账员独立取证）

基线枝 tip `6069675e`（第 3 轮已提交）。第 4 轮全部改动均在工作区未提交，
`git diff --stat` 合计 **13 文件，+897/−95**：

```
 src-tauri/src/chat_v2/pipeline/compaction.rs       |  21 +   （#6 换代标记调用）
 src-tauri/src/chat_v2/pipeline/llm_adapter.rs      |  54 +/− （#1 reasoning 过滤）
 src-tauri/src/chat_v2/pipeline/stream_filter_core.rs |  46 +/−（#1 骨架挂点填实）
 src-tauri/src/chat_v2/pipeline/variant_adapter.rs  |  51 +/− （#1 reasoning 过滤）
 src-tauri/src/chat_v2/repo.rs                      | 358 +/− （#6 双键+freeze 扩展+3 测试）
 src-tauri/src/chat_v2/tools/knowledge_executor.rs  |  17 +/− （#3 非流式清理）
 src-tauri/src/essay_grading/pipeline.rs            |  27 +/− （#3 流式挂接）
 src-tauri/src/llm_manager/rag_extension.rs         |  18 +/− （#3 非流式清理）
 src-tauri/src/streaming_anki_service.rs            |  18 +/− （#2 删本地表改 use 单源）
 src-tauri/src/translation/pipeline.rs              |  27 +/− （#3 流式挂接）
 src-tauri/src/utils/model_special_tokens.rs        |  86 +/− （#2 pub(crate)+游标+测试）
 src/features/chat/adapters/TauriAdapter.ts         | 132 +/− （#5 原子首发）
 src/features/chat/skills/progressiveDisclosure.ts  | 137 +   （#7 delta 最小落地）
```

untracked：`ROUND-04-TASKS.md` + 上列六份 r4 文档 + 本台账追加节。
**席位缺席记录**：任务卡 #9 应产出的 `r4-review-frontend.md`（前端审阅）
**不存在于工作区**——TauriAdapter.ts / progressiveDisclosure.ts 两处前端改动
本轮无独立审阅文档，第 5 轮或验证轮应补审。

红线自证（本席 grep/status 复核）：coordinator.rs / hooks.rs / helpers.rs /
multi_variant.rs / history.rs 本轮零改动；`streaming_anki_service.rs` E 域算法
函数体零改动（仅常量引用换源）；#122 未碰。

## R4-2. #1 reasoning 独立过滤（P9 推进）

- 两适配器 `on_reasoning_chunk` 从裸转发改为先过 `ModelWrapTokenStreamFilter`：
  `ChatV2LLMAdapter` 与 `VariantLLMAdapter` 各新增字段
  `reasoning_wrap_token_filter`，以同一 `wrap_token_policy` **另建实例，
  与 content 路径 `wrap_token_filter` 零共享**——两路 chunk 流中交错，
  共用实例会互相污染逻辑行前缀判定（把正文行误判成 token 行或漏放真 token）。
- 保序纪律：LLM 侧 `touch_activity` → `enable_thinking` 门 →
  `reasoning_content_observed` 置位（仍在空判之前，「字段是否出现」语义不变）→
  空 `text` 早退（保留）→ 过滤 → 滤后为空则早退（不建块不 emit）。
- finalize 冲刷：reasoning 尾巴 `flush()` 后**直接归 thinking**、不回灌
  `think_tag_buffer`（reasoning 通道不参与 `<think>` 状态机），置于
  `finalize_thinking()` 之前；`reset_stream_state` / `reset_for_new_round`
  均同步 `reset()`。
- content 路径一行未改；非 GLM/Qwen 路由 policy `Disabled` 恒等直通。
- `stream_filter_core.rs` 的 `process_reasoning` / `flush` / `reset` 顺手按
  同一设计填实（供第二刀迁移零改调用点），但两适配器仍未改调该核心。

## R4-3. #2 常量表单源 + consume_prefix 游标化（P9 推进）

- `MODEL_SPECIAL_TOKENS` 由模块私有提升为 **`pub(crate) const`**
  （`model_special_tokens.rs:36`，本席 grep 复核全仓唯一定义、仍为 5 token
  一字未增删）；`streaming_anki_service.rs` 删除本地重复表改
  `use` 单源，**E 域三个算法函数体与其全部测试逐字节保持**。
- `consume_prefix` 从每字符 `input.drain(..)`（每次 memmove 整个尾部，
  大 chunk O(n²)）改为 **O(1) 游标前进**（新字段 `input_cursor`，恒落 char
  边界）+ 主循环读取改经 `pending_input()` + 每趟 `process_available` 收尾
  一次 `compact_input()` 回收——逐字节语义与旧实现等价，纯性能改写，
  控制流与 hold/early-break 判定未动。
- 新增大 chunk 回归测试 `large_single_chunk_keeps_semantics_with_cursor_consumption`
  （`model_special_tokens.rs:839`，2000 行正例+负例混合、char 边界撕半对拍，
  只写不跑）。
- `process_newline` 重置 inline-code：复核结论 = Step 22 `daf5b78e` 已修
  （代码与回归测试均在位），本轮不重复改，仅书面确认。

## R4-4. #3 出口盘点：4 挂接 + 2 豁免 + 1 越界移交

grep 复核（#3 文档 + 本席）：非流式 `.call_unified_model_2(` 全仓仅两个调用点，
流式 `call_unified_model_2_stream` 仅 tool_loop / multi_variant。七出口裁决：

| 出口 | 裁决 |
|---|---|
| 翻译流式 `stream_translate_inner` | **挂接**：局部过滤器，policy `for_provider_model` 门控（管线不走 failover，config 可信），终局 `flush()`，取消/错误路径不冲刷 |
| 作文流式 `stream_grade` | **挂接**：同构；chunk 双消费（前端展示 + `</score>` 解析）在源头过滤 |
| 标签生成非流式（`rag_extension.rs`） | **挂接，always-on `GlmOrQwen`**：failover 在 `call_unified_model_2` 内部换模、调用点拿不到最终路由无法门控；出口是机器解析 JSON，合法 JSON 不含会被误删的 token 形态，GLM 裸 `<|begin_of_box|>` 包装则直接打崩 `serde_json::from_str`；对无泄漏输出恒等 |
| 知识点提取非流式（`knowledge_executor.rs`） | **挂接，always-on**：同上论证 |
| Chat 主链路流式 | **豁免**：两适配器已有等价过滤（+本轮 #1 补齐 reasoning） |
| Anki 制卡流式 | **豁免**：E 域独占红线，自有本地处理 |
| 题库批改流式 `qbank_grading/pipeline.rs` | **发现但越界未改**（不在 #3 独占区）；与作文出口暴露面相同，留后续轮按 #2 同构挂接 |

**#8 缺口即时关闭**：#8 §4 截稿时（16:00 UTC）非流式两处挂接与 #3 盘点文档
均未落盘，其「应核对」提醒成立于当时；本席取证时点二者均已入工作区
（diff 引文见上，always-on 论证与 #8 给出的可接受豁免思路同向但更强——
直接挂接而非豁免）。模式同 R3-4 缺口 B：审阅时点差，非分歧。

## R4-5. #5 目录原子首发（P4 推进，TauriAdapter.ts）

- 「首次无快照」路径从 fire-and-forget 改为 **await 冻结成功后才进入 LLM
  请求**：新增 `ensureAvailableSkillsSnapshotFrozen()`（`:5350`）替代原
  `persistAvailableSkillsSnapshot`；`buildSystemPromptWithSkills` /
  `buildSendOptions` 改 async，8 个 send/retry 入口调用点补 await
  （sendMessage / executeWakeSession / executeSendMessage / executeRetry /
  executeEditAndResend / continueMessage / executeRetryVariant /
  executeRetryAllVariants）——任何产生 LLM 请求的路径都被冻结确认闸住。
- 模块级状态（适配器重建不丢事实）：`persistedAvailableSkillsSnapshotSessions`
  Set（`:178`，后端确认写入；loadSession hydrate 回灌直接标记）+
  `inflightAvailableSkillsSnapshotFreezes` Map（`:179`，并发发送共享同一
  Promise 防重复 RPC）。本席 grep 复核三符号均在位。
- **first-write-wins 保持**：await 返回的生效值若与本地字节不同（多窗口竞争
  败方），以生效值构建本次 system——第一条请求即与持久化权威逐字节一致，
  回灌晚到窗口关闭。
- **失败策略 fail-closed 不发**：冻结 RPC 失败抛错沿既有 try/catch 中止发送；
  内存快照保留原字节可重试。理由：该快照是 system 第 0 字节前缀的持久化
  权威，降级发送等于重开 P4 防的缓存击穿窗口。
- 已知边界如实记录：`clearSessionAvailableSkillsSnapshot` 不清 persisted 集合
  （会话 UUID 不复用，无正确性影响）。

## R4-6. #6 compaction 换代标记（P4 推进；**未重生成目录字符串**）

- **落点**：`persist_prepared_compaction` 同一 `conn.transaction()` 内
  （`compaction.rs:1114` 调 `mark_session_available_skills_snapshot_stale_with_conn`），
  标记失败整个 compaction 事务回滚——换代声明与压缩记录原子共存亡。
- **诚实口径：事务内写的是显式换代标记，不是重生成的目录字符串。**
  `<available_skills>` 目录的唯一生产者在前端 `progressiveDisclosure.ts`
  （live registry / 门控求值 / XML 转义全在前端进程内存），后端 `skills.rs`
  只是 SKILL.md 文件处理器；后端影子实现渲染器意味着两处逐字节对齐的生成器，
  任何一字节漂移都打碎缓存——故后端只声明「该换代了」，快照本体由前端下轮
  按 live registry 重生成并经既有 freeze 原语作为新代 first write 冻结。
- 持久化契约（session.metadata 双键，常量定义于 repo.rs）：
  `availableSkillsSnapshotGeneration`（缺键=0，普通首冻不写，旧会话字节形态
  不变）+ `availableSkillsSnapshotPendingGeneration`（仅 compaction 事务写，
  幂等：有效 pending 不再 +1，多次 compaction 折叠为一次换代）。
  `freeze_..._with_conn` 语义扩展：**仅存在有效 pending（严格大于当前代）时
  才允许覆盖已冻结快照**，同时 `generation := pending` 并删 pending 键；
  其余路径与升级前逐字节等价。first-write-wins 未被静默放松——覆盖只能走
  换代键，既有测试 `available_skills_snapshot_freeze_is_first_write_wins`
  一字未动（本席 grep 复核 `repo.rs:4931` 在位）。
- 缓存经济性：compaction 后 tail 起点前历史全被摘要替换，system+tools 之后
  字节必变、前缀缓存已报废，此时换目录增量损失仅 system+tools 段——零成本
  换代时机论证成立。
- 新增测试 3 个（本席 grep 复核 `repo.rs:5035/:5145/:5203`，只写不跑）：
  显式换代 bump / 从未冻结 no-op / 空串冻结+标记后允许目录。
- **与 #7 设计稿两处偏离已书面化**（r4-catalog-compaction.md §「偏离及理由」）：
  ①事务内不重生成本体（后端不可行）→ 单代号键拆双键表达跨进程中间态；
  ②不新增独立 refresh API → 扩展既有 freeze 原语（覆盖门闩=有效 pending，
  普通路径误覆写面为零，前端零新命令）。键名以 #6 文档为准。
- 前端接线本轮未做（#5 独占 TauriAdapter）：换代标记暂为落库哑数据，
  **不造成任何行为回退**；接线三步（读 pending → live 重生成 → 调既有
  freeze 命令回灌）已在 #6 文档写明，无需新增 Tauri 命令。

## R4-7. #7 目录 delta 设计定稿 + 最小落地

- **双通道分工**：`available_skills_delta` 尾部瞬态块为常态通道（每轮请求
  构建时即时渲染、只拼当前最后一条 user 消息尾部、**不持久化进历史**——
  尾部本就是每轮新字节区，零缓存成本）；compaction 换代（#6）为收敛点
  （基线换 live 全量，delta 自然清空，尾部不无限增长）。
- **基线语义零新键**：基线 = 解析冻结快照字节得到的可用技能 ID 集
  （`extractCatalogSkillIds`，`available="false"` 门控条目不计入；空串快照
  = 空基线，恰好修复「空目录冻结会话整会话拿不到技能」场景）。不另存 ID
  列表，避免「快照是 A 窗口的、ID 表是 B 窗口的」撕裂态。
- delta 口径与 `generateAvailableSkillsPrompt` 可用段逐条一致再减基线；
  未冻结返回 null（首轮 system 本就是 live 全量）；门控中新技能不进 delta。
- **first-write-wins 自查**：delta 路径对快照 Map 只读（刻意不调会产生冻结
  副作用的 `getSessionAvailableSkillsPrompt`），不调 hydrate / freeze。
- 最小落地（progressiveDisclosure.ts +137，本席 grep 复核 `:741/:758/:783/:816`
  四符号在位）：类型 + `extractCatalogSkillIds` + `computeAvailableSkillsDelta`
  + `generateAvailableSkillsDeltaPrompt` + 私有 `unescapeXmlAttr`（& 最后替换
  防二次解码）。**发送路径接线未做**（TauriAdapter 归 #5 独占），接线指引
  已写明：delta 置于瞬态技能指令之后，防模型误读为已加载。

## R4-8. #8 过滤哲学审阅：三案全确认未放宽 + 一处陈述翻案

- 评审依据溯源到原始提交 `b0bf113d` 的「保守三形态」（行首外层包装 / 纯
  token 行 / 配对闭合）与 Step 22 `daf5b78e` 的四条保留面；放宽判据四条
  （扩删除形态 / 收窄保留面 / 删弱负例 / 全局替换）。
- **裁决：#1/#2/#3 产品改动全部通过四判据，零放宽。**#1/#3 属覆盖面扩展
  （新消费方复用过滤器本体，本体状态机零改动）；#2 属纯性能改写 + 可见性
  提升；新增测试是加严不是放宽。
- **blob 指纹闭环（本席独立复核）**：#8 §0 截稿七文件 blob
  （`c0144ba9/470ae5cf/ce4652e7/5e3d2aa5/75ad640a/fd04ad34/5b0b8ea4`）与
  本席收口时点 `git hash-object` **逐一相符**——#8 审阅过的七文件截稿后
  零追加改动，其结论对当前工作区直接有效。#8 未覆盖的六文件
  （rag_extension / knowledge_executor / repo / compaction / TauriAdapter /
  progressiveDisclosure）中前两个即 R4-4 所记的截稿后落地项。
- #8 五分钟复核清单本席逐项执行：负例测试 5（model_special_tokens）+ 2
  （anki）全在位未改（grep 行号 `:653/:681/:691/:771/:803` 与 `:3535/:3541`）；
  `MODEL_SPECIAL_TOKENS: &[&str]` 全仓唯一定义；四个新挂点 diff 新增行
  **零 `replace(` 式清理**（本席 grep 复核）。
- **翻案项（陈述性，非语义）**：R3 所称「stream_filter_core 骨架未在
  pipeline.rs 声明 mod、属死代码占位」不实——R3 提交 `6069675e` 自己就加了
  `pipeline.rs:99` 的 mod 声明，骨架自 R3 起参与编译（本台账 R3-6 当时已
  勘误过挂载状态，与 #8 结论一致；`r4-reasoning-filter.md:53` 又沿袭了
  「未声明 mod」半句，同样不实）。处置：R5 接线时统一改口
  「mod 已于 R3 声明，`#![allow(dead_code)]` 待接线后移除」。

## R4-9. 第 3 轮遗留项状态（本席 grep 复核）

| 遗留项 | 状态 |
|---|---|
| 缺口 A：digest 冲突应发换代信号（R3-7） | **仍开**——history.rs 零命中 `digest_conflict`/`GatedRebuild`，本轮无人认领，续留第 5 轮或验证轮 |
| 小问题 C：二参兼容入口 dead_code 告警 | **仍开**——history.rs 无 `allow(dead_code)`/`cfg_attr` 处理（history.rs 本轮零 diff） |
| #5 反例段改门禁断言 | 未做（文件冻结状态未变） |
| multi_variant 扇出路径 llm_content 前移 | 未做（multi_variant.rs 本轮零 diff） |
| stream_filter_core 文档挂载表述勘误 | **部分完成**：#8 已书面翻案并给处置建议（R4-8），源码头注释与两份文档的改口留 R5 接线时顺手 |

新遗留（本轮产生）：qbank_grading 出口未挂接（R4-4 越界项）、#9 前端审阅
文档缺席（R4-1）、#6 换代标记的前端接线与 #7 delta 的发送路径接线
（两者都卡在 TauriAdapter 独占权，天然是同一次接线）。

## R4-10. 已验证（静态）/ 未验证

### 已验证（仅静态证据：读代码 / grep / git diff / git hash-object）

- 本轮 diff 全貌与席位归属（R4-1 清单，13 文件 +897/−95）——本席
  `git status` / `git diff --stat` 复核，与任务卡独占表一致。
- #8 截稿七文件 blob 指纹与当前工作区逐一相符（R4-8）——本席逐文件
  `git hash-object` 复核。
- 负例测试 7 条全在位、常量表全仓单源 `pub(crate)`、新挂点零 `replace(`、
  大 chunk 回归测试在 `:839`——本席 grep 复核（#8 清单逐项重跑）。
- 非流式两处挂接的 diff 引文（always-on 论证注释 + process/flush 形态）、
  compaction `:1114` 调用点、repo 双键常量与 4 个测试（1 旧 3 新）行号、
  TauriAdapter 三符号、progressiveDisclosure 四符号——本席 grep/diff 复核。
- 红线：coordinator / hooks / helpers / multi_variant / history 本轮零改动，
  E 域算法函数体未动——本席 `git status` + diff 复核。
- 缺口 A / 小问题 C 仍开——本席 grep 复核（R4-9）。

### 未验证（诚实归因）

- **未跑任何编译 / 测试 / CI**：本轮 13 文件 +897/−95（含 Rust 与 TS 两侧）
  **未经 cargo check / cargo test / tsc / npm test / rustfmt**；repo.rs 三个
  新测试与 model_special_tokens 大 chunk 测试均仅为源码存在，不排除低级
  编译错误。TauriAdapter 的 async 化改造（8 调用点）尤其未经类型检查。
- 游标化「逐字节等价」、reasoning 独立实例防污染、always-on 过滤对合法
  JSON 恒等——均为源码推理与审阅确认，无运行时对拍。
- fail-closed 首发在真实冻结 RPC 失败下的用户体验、compaction 换代标记被
  前端兑现的端到端链路（前端接线未做）——无任何运行时证据。
- #9 前端审阅缺席：TauriAdapter / progressiveDisclosure 两处改动只有作者
  自述文档与本席静态抽查，无独立第二人审阅。

## R4-11. 第 5 轮预告（按用户任务书 + 本轮遗留）

主题五项：

1. **遥测身份（P7）**：`model2_pipeline.rs:5709-5738` 随机 `stream_event`
   冒充 `session_id` → session_id / variant_id / run_id 分列。
2. **prefix 指纹（P7）**：`CHAT_V2_CACHE_DEBUG` 指纹改 post-adapter 四段
   （含 tools），对齐 `scripts/cache-hit-report.py` 消费口径。
3. **retention 裁决（P6）**：按第 1 轮预置口径执行——优先删除 5.6+ 分支
   （禁止带 `ttl:"24h"` 接线），旧代分支删或改造后门控接线。
4. **provider P0/P1/P2（P10）**：快照测试钉死已修项（P0 + P1×2）；补
   Anthropic 四槽预算 + 工具 marker 死分支（P2，与 G-ttl1h 打包）。
5. **架构结论文档（P11）**：定稿 `docs/dev/wave2-A-agent-architecture.md`
   （14 行矩阵收口）。

本轮遗留并入候选：缺口 A 换代信号、qbank 出口挂接、#6/#7 前端接线
（TauriAdapter 一次做完）、stream_filter_core 文档改口、#9 补审。

## R4-12. 收轮交接（给父代理）

- 待 add：13 个产品文件（工作区 M）+ 8 份 untracked 文档（含 ROUND-04-TASKS）
  + 本台账追加节。
- 本席未 commit/push/gh（铁律）；Draft PR #345 更新由父代理执行。
- **不标 Goal complete**：编译/测试验证轮未跑，缺口 A 未收，#9 审阅缺席，
  前端接线未做，第 5 轮任务书已排。

---

# Wave2-A 第 5 轮台账（#10 台账员，只追加）

- 作者：0824 Wave2-A 第 5 轮子代理 #10「台账员」（claude-fable-5-thinking-high）
- 日期：2026-08-26
- 性质：只追加章节。第 1 轮 P1–P11 编号与内容一字不改，第 2/3/4 轮章节不动。
  本席未改任何产品代码、未执行 cargo/npm/测试、未 commit/push（父代理收轮）。
- 依据：`docs/dev/wave2-A/ROUND-05-TASKS.md` 与七份 r5 文档
  （`r5-model2-telemetry.md` #1、`r5-provider-p2.md` #2、
  `r5-digest-generation-signal.md` #8、`r5-catalog-pending.md` #9、
  `r5-review-model2.md` #5、`r5-review-providers.md` #6、`r5-review-arch.md` #7）
  与 #4 产出 `docs/dev/wave2-A-agent-architecture.md`（可写面即架构结论文档，
  无独立 r5 报告），以及本席对工作区 `git status` / `git diff` / grep 的独立复核。

## R5-1. 本轮 diff 形态（台账员独立取证）

基线枝 tip `2d70b400`（第 4 轮已提交，**含 `r4-review-frontend.md`**——R4-1 所记
「#9 前端审阅缺席」已在第 4 轮收轮时补齐入库，本席 `git log` 复核该文件随
`2d70b400` 提交，缺席记录就此关闭）。第 5 轮全部改动均在工作区未提交，
`git diff --stat` 合计 **12 文件，+1438/−139**：

```
 scripts/cache-hit-report.py                    | 198 +/− （#3 三级分组）
 src-tauri/src/chat_v2/pipeline/helpers.rs      |  71 +   （#8 信号记录函数）
 src-tauri/src/chat_v2/pipeline/history.rs      | 124 +/− （#8 门禁带信号版）
 src-tauri/src/data_governance/migration/llm_usage.rs | 62 +/−（#1 migration 注册）
 src-tauri/src/llm_manager/model2_pipeline.rs   | 488 +/− （#1 三件事）
 src-tauri/src/llm_usage/{collector,database,mod,repo,types}.rs | 142 +/−（#1 写入路径）
 src-tauri/src/providers/mod.rs                 | 346 +/− （#2 P0/P1/P2）
 src/features/chat/adapters/TauriAdapter.ts     | 146 +/− （#9 pending 消费）
```

untracked：`docs/dev/wave2-A-agent-architecture.md`（#4）、`ROUND-05-TASKS.md`、
上列七份 r5 文档、新 migration `V20260826__add_stream_identity.sql`（#1，
加法新文件，旧 migration 零触碰）+ 本台账追加节。

红线自证（本席 grep/status 复核 + #5 交叉确认）：coordinator.rs / hooks.rs /
tool_loop.rs / multi_variant.rs / types.rs / repo.rs 本轮零改动；车道纪律合规
（#5 逐文件核对 12 个改动文件归属，无跨席交叠）。

## R5-2. #1 model2 三件事（P6 删除 + P7 双落地）

- **P6 retention：已删**。`apply_openai_prompt_cache_retention` /
  `provider_accepts_prompt_cache_retention` 两个死实现整体删除（本席 grep 复核：
  全仓仅剩 `model2_pipeline.rs:3584-3593` 的裁决注释，注明「若将来接线：仅官方
  端点、仅 `ttl:"30m"`、**禁止 24h**、必须快照测试」）。第 1 轮第 7 节预置口径
  「优先删除」如约执行；#5 复核删除安全（`model_supports_prompt_cache_breakpoint`
  活调用点不受牵连）。
- **遥测身份三列（P7）**：`llm_usage_logs` 不再把随机 `stream_event` 当
  `session_id` 落库——新增 `variant_id` / `run_id` 两列（types.rs:143/:148，
  migration `V20260826__add_stream_identity.sql` 加法新列 + 变体维度聚合索引），
  记录点从 `chat_v2_event_{session}_var_{variant}_run_{run}` 形状解析还原真实
  三元组（解析器与 `tool_loop::build_run_scoped_stream_event` 构造格式对拍，
  与既有 `chat_v2_session_scope_and_generation` 同口径 `rsplit_once`）。
- **post-adapter 四段指纹（P7）**：`CHAT_V2_CACHE_DEBUG=1` 指纹从
  pre-adapter 换到 post-adapter 最终 body（`:4897`），按
  system / tools / history / current-user 四段取指纹并记录首个分叉段；
  三个测试源码在位（`:1321/:1342/:1375`，覆盖 OpenAI Chat / Responses /
  Anthropic 三形态切分与分叉定位，只写不跑）。

## R5-3. #2 provider P2 落地（P10 收口）

- **P2 修复 1——工具 marker 死分支已活**：`convert_tool_definition` 收口处
  透传调用方 `cache_control`（不再恒 `None`），`:2402` 的 `has_marker` 判定
  自此可达；#6 确认证据链完整。
- **P2 修复 2——四槽预算守卫**：新增
  `enforce_anthropic_cache_breakpoint_budget`（`:2930`，调用点 `:2414`）：
  `ANTHROPIC_CACHE_BREAKPOINT_BUDGET = 4`，顶层 automatic 恒注入占 1 槽，
  块级断点（tools + system）预算 3，超额按「tools 先于 system、段内靠前先剥」
  剥除（留尾剥头，越靠后断点覆盖前缀越长）。
- 测试源码：P2 三条边界 + P0 三类变体 + P1 事件序列 + stream_options 钉死，
  只写不跑。其中 P1 事件序列一条被 #6 翻案（见 R5-6）。
- G-ttl1h 中「四槽无守卫 + 工具 marker 死分支」两项就此关闭（源码层面）；
  第 1 轮第 5 节 P2「未修」裁决翻页为「已修（未验证）」。

## R5-4. #3 报告脚本三级分组

`scripts/cache-hit-report.py` +198/−：分组身份升级为 session_id / variant_id /
run_id 三级（多变体 steady-state 按 `(session_id, variant_id)` 聚合，run_id 仅
用于 per-session 行）；对旧库存量的 `chat_v2_event_` 形状 session_id 一律解析
还原（与 `chat_v2_session_scope_and_generation` 同口径），修正此前多变体 steady
统计把每个 stream_event 当独立会话的失真；**缺列降级**——旧库无新列时 NULL
占位、报表不崩、分组降级为解析还原（无法解析按原值整体分组），输出头部注明
当前生效分组模式。

## R5-5. #4 架构结论文档定稿（P11 收口）

`docs/dev/wave2-A-agent-architecture.md` 落盘（untracked）：契合度矩阵终稿
**21 行**（A 部分 14 行承接 r1 #4 矩阵并按 2–4 轮落地更新状态迁移 + B 部分
缓存工程面扩展），判定口径四档（契合 / 半契合 / 不契合 / **已改造（待验证）**
——新档位诚实标注 2–4 轮源码落地但零验证的项）。「子代理不复用母前缀是业界
共识」如任务卡要求写明（Claude Code / Agents SDK / OpenCode 三方同向）。
#7 审阅确认（见 R5-6）。

## R5-6. #8/#9 遗留收口：digest 切代信号 + pending 前端消费

- **缺口 A 收口（#8）——信号走 catalog pending 通道**：R3-7 缺口 A（digest
  冲突只 warn+skip、代际层不知情）本轮落地，但**未采用 #8 r3 草案的
  `GatedRebuild` 返回值形态**，而是：门禁升级为
  `rebuild_anchored_skill_messages_gated_with_signal`（三消费点 `:164/:333/:365`
  全部改走，本席 grep 复核），冲突信号聚合到唯一写点
  `record_skill_digest_prefix_generation_signal`（helpers.rs:1215 起）——
  复用 R4 #6 的 `availableSkillsSnapshotPendingGeneration` 换代键声明
  「该换代了」，幂等折叠（已有有效 pending 不重复 +1），持久化失败降级为
  仅日志、**不阻断发送**。二参兼容包装 `rebuild_anchored_skill_messages`
  仍在（:843，委托 gated 传 None）；小问题 C（dead_code 告警处置）本席 grep
  复核仍未做，续留验证轮。
- **R4 前端接线闭环（#9）**：TauriAdapter.ts +146——loadSession hydrate 时
  读取 compaction/digest 信号写入的 pending 键记录 `pendingGeneration`
  （`:194/:218/:233/:3804`）；冻结入口按「pendingGeneration 有效 → 跳过旧冻结
  字节、按 live registry 重新生成、`generation := pendingGeneration` 兑现并
  清除 pending」（`:5440-5483`）。first-write-wins 未放松（覆盖仍只能走换代
  键）；兑现成功前 pending 不清除，重试不丢换代意图。R4-9 所记「#6/#7 前端
  接线」中 #6 换代标记一侧就此闭环；#7 delta 发送路径接线仍未做。

## R5-7. 审阅结论：主体确认 + 两处翻案

- **#5（model2）**：遥测三列、指纹实现、P6 删除、coordinator 未碰、车道纪律
  五项全确认。**翻案 R5-M2-1（低危）**：#1 自述与注释宣称「scope key =
  session::variant 即 provider 端 prompt cache 的真实存活作用域」**过强**——
  该 key 实际按 assistant 消息/变体轮转，跨 turn 对比不会发生，每个新 turn
  都记 `baseline`；代码本身正确，宣称需下轮改口。
- **#6（provider）**：P2 两修复确认（automatic 占 1 槽有官方文档背书，
  「4−1=3」算术精确正确，顺带纠正 r1 台账「顶层字段非标」的过时定性）；
  剥除序正确；存量测试兼容。**翻案：P1 新测试
  `openai_adapter_choice_completion_keeps_event_sequence_until_done_marker`
  源码有错、一旦执行必挂**——断言 `usage["cached_tokens"]`，但 Chat 适配器
  透传的原始 usage 对象里该键嵌在 `prompt_tokens_details` 之下、顶层不存在，
  得 `Value::Null` 与 `json!(8)` 恒不等；应改
  `usage["prompt_tokens_details"]["cached_tokens"]`（验证轮首跑前必须修）。
  另记 1 个守卫之外的潜伏缺陷（保险断点先打点后核算的误剥向量，当前流量
  不可达）与 system 剥除循环零测试覆盖。
- **#7（架构文档）**：确认、不翻案。判定与统计自洽、证据等级标注诚实、
  无谎称验证；三处小勘误（diff 体量数字、A1 变化列措辞、免责声明覆盖面）
  建议父代理或 #4 顺手修正。

## R5-8. 遗留项状态（含 R4 遗留，本席 grep 复核）

| 遗留项 | 状态 |
|---|---|
| 缺口 A：digest 冲突换代信号（R3-7/R4-9） | **已收口**（R5-6，走 catalog pending 通道，形态偏离 r3 草案已书面化） |
| #9 前端审阅缺席（R4-1） | **已关闭**——`r4-review-frontend.md` 随 `2d70b400` 入库 |
| #6 换代标记前端接线（R4-9） | **已闭环**（R5-6 #9） |
| #7 delta 发送路径接线 | 仍开（TauriAdapter 本轮 #9 独占面仅 snapshot 段） |
| qbank_grading 出口挂接（R4-4 越界项） | 仍开 |
| 小问题 C：二参兼容入口 dead_code | 仍开（history.rs 本轮改动未含处置） |
| stream_filter_core 文档改口（R4-8） | 仍开（本轮无人接线） |
| 新增（本轮）：P1 测试键位错误、R5-M2-1 宣称改口、#7 三处勘误、守卫外误剥向量 | 验证轮/第 6 轮处置 |

## R5-9. 已验证（静态）/ 未验证

### 已验证（仅静态证据：读代码 / grep / git diff）

- 本轮 diff 全貌与席位归属（R5-1，12 文件 +1438/−139）——本席
  `git status` / `git diff --stat` 复核，与任务卡独占表及 #5 车道核对一致。
- P6 两函数全仓零残留（仅裁决注释）、遥测两新列与 migration 文件、四段指纹
  三测试行号、`enforce_anthropic_cache_breakpoint_budget` 与透传修复、
  报告脚本三级分组说明、架构文档 21 行矩阵字样、门禁三消费点走
  `_with_signal`、helpers 信号函数、TauriAdapter pending 四符号——
  均为本席 grep/读 diff 逐项复核。
- 红线：coordinator / hooks / tool_loop / multi_variant 本轮零改动——本席
  `git status` 复核，#5 交叉确认。
- 两处翻案的证据链（cached_tokens 键位、scope key 轮转）——采信 #6/#5
  逐行审阅（含代码引文与官方文档链接），与本席对相应源码段的抽查一致。

### 未验证（诚实归因）

- **未跑任何编译 / 测试 / CI**：本轮 12 文件 +1438/−139（Rust + TS + Python +
  SQL migration）**未经 cargo check / cargo test / tsc / python 执行 /
  rustfmt**；#6 已静态证明 P1 事件序列测试**执行必挂**，验证轮首跑前必须
  先修键位。migration 在真实旧库上的加列行为、报告脚本对新旧两代库的降级
  路径均无运行时证据。
- 四槽守卫在真实 Anthropic 请求上的 400 规避、四段指纹对真实分叉的定位
  效果、pending 兑现的端到端链路（compaction/digest 信号 → 前端重生成）——
  均无运行时证据。
- 父代理口径记录：P6/P7/P10/P11 四个方向至此**审+改约 95% 完成**（余量 =
  两处翻案的修正 + 验证轮执行），该完成度为静态口径，非验证声明。

## R5-10. 第 6 轮预告

**十面二检**：十个席位对 1–5 轮全部落地面做第二遍交叉检查（含本轮两处
翻案的修正落地、#7 三处勘误、R5-M2-1 改口、遗留表 R5-8 的开放项清点）。
仍不执行编译/测试（验证轮另排）。

## R5-11. 收轮交接（给父代理）

- 待 add：12 个产品/脚本文件（工作区 M）+ 10 个 untracked 文件（架构文档、
  ROUND-05-TASKS、七份 r5 文档、migration SQL）+ 本台账追加节。
- 本席未 commit/push/gh（铁律）；Draft PR #345 更新由父代理执行。
- **不标 Goal complete**：编译/测试验证轮未跑，P1 事件序列测试已知必挂
  待修，两处翻案待改口，第 6 轮十面二检已排。

---

# Wave2-A 第 6 轮台账（#10 台账员，只追加）

- 作者：0824 Wave2-A 第 6 轮子代理 #10「provider P2 + 台账」（claude-fable-5-thinking-high）
- 日期：2026-08-26
- 性质：只追加章节。第 1 轮 P1–P11 编号与内容一字不改，第 2/3/4/5 轮章节不动。
  本席未改任何产品代码、未执行 cargo/npm/测试、未 commit/push（父代理收轮）。
- 依据：`docs/dev/wave2-A/ROUND-06-TASKS.md` 与**十份 r6 文档全量读毕**
  （`r6-gen.md` #1、`r6-freeze.md` #2、`r6-llm-content.md` #3、`r6-skill.md` #4、
  `r6-filter.md` #5、`r6-catalog.md` #6、`r6-telemetry.md` #7、`r6-p0.md` #8、
  `r6-p1.md` #9、`r6-p2.md` #10 本席自产），以及本席对工作区
  `git status` / `git diff` / `git log -S` / grep 的独立复核。

## R6-1. 本轮 diff 形态（台账员独立取证）

基线枝 tip `4b784bb4`（第 5 轮已提交）。第 6 轮为**十面二检轮**（对 1–5 轮
全部落地面做第二遍交叉检查），改动均在工作区未提交，`git diff --stat` 合计
**4 文件，+119/−42**：

```
 scripts/cache-hit-report.py                     | 18 +   （#7 两处 bug 修）
 src-tauri/src/chat_v2/pipeline/helpers.rs       | 58 +/− （#1 digest 收敛接线）
 src-tauri/src/chat_v2/pipeline/multi_variant.rs | 61 +/− （#1 三调用点传全快照）
 src-tauri/src/utils/model_special_tokens.rs     | 24 +   （#5 tail-hold 泄漏修）
```

untracked：`ROUND-06-TASKS.md` + 十份 r6 文档 + 本台账追加节。

红线自证（本席 grep/status 复核）：hooks.rs / coordinator.rs / tool_loop.rs /
history.rs / repo.rs / types.rs / persistence.rs 本轮零改动；负例测试一条
未删未改（#5 §1 逐条清点）；provider 三席（#8/#9/#10）按任务卡只写文档，
`providers/mod.rs` 零工作区改动。

## R6-2. 十面裁决总表

| # | 面 | 裁决 | 一句话结论 |
|---|---|---|---|
| 1 | 代际（helpers/multi_variant） | **翻案 + 补丁** | order/generation 全确认；会话级 `schema_digest` 死接线（converge 收不到变体 digest → `toolSchemaDigest` 生产死键）——本轮唯一明确产品 bug，已在独占面落最小补丁（见 R6-3） |
| 2 | 冻结原语（tool_loop） | 确认 | 三原语自 r2 零漂移、单变体不切代成立；独立检出同一 digest 断头（F-1）上报不越权修，另记 F-2/F-3/F-4 三条低危备忘 |
| 3 | llm_content（persistence） | 确认（零改动） | 8 条数据行生命周期链全过（含本轮新核的「后续保存不抹早写」SQL 列清单证据）；新明确一处**既有**缺口：retry 轮 live 包装无处落库（§3.3，修复位在 retry handler，越权只记录） |
| 4 | 技能版本化（history） | 确认（零改动） | r3 门禁四分支 + r5 信号边界/幂等/记录点全部与代码对上；留档五条非 bug 观察（缺正文不进信号、tool 锚点滤空静默、变体路径无锚点还原等） |
| 5 | 过滤器（model_special_tokens） | **确认 ×2 + 补丁 ×1** | 游标化与 reasoning 独立过滤二检通过；检出并修复空白行致 tail-hold 原样泄漏的明确 bug（`"…<|im_end|>\n\n"` 契约违背）+ 1 条回归测试 |
| 6 | 目录生命周期（progressiveDisclosure） | 确认（零改动） | 原子首发/pending 兑现/delta/换代键四面全确认（含本轮新析的分支复制继承正确性）；delta 接线认识升级：需跨 TS/Rust 传输面，建议接线轮排成对席位 |
| 7 | 遥测（cache-hit-report.py） | **补丁 ×2** | Rust↔Python 解析器对拍主体确认；修复 `--days` 截止串时间戳形状混用（字典序陷阱、最多多算近一天）与非数字代际后缀读写两侧分组分歧两处明确 bug |
| 8 | provider P0 | 确认（只文档） | 断点形状/双门控/三类快照 + 两伴随测试静态模拟执行全绿、快照层与 wire 层等价；6 条观察（含调用方块级断点静默丢弃属刻意单一作者制） |
| 9 | provider P1 | 确认（只文档） | R5-6「执行必挂」断言已在合入前改正且钉住真实生产契约（下游双消费点交叉验证）；补核 `usage: null` 噪声与实例复用两个此前未记录面；9 条相关测试无第二个必挂断言 |
| 10 | provider P2 + 台账 | 确认（只文档） | 透传活化/四槽守卫全项重验通过；新增零损剥除论证（system marker 存活时 tools 前缀仍被覆盖）；#6 三遗留（误剥向量/system 剥除零覆盖/Null 微瑕）维持定性 |

**裁决分布：确认 8 / 翻案 1（#1，含补丁）/ 补丁 3 面（#1、#5、#7）。**
1–5 轮的核心裁决（方案 A 代际、digest 门禁、四槽预算、遥测三列、原子首发
等）**无一被推翻**；唯一翻案对象是 r2 起三份文档一致宣称却从未接通的
digest 持久化链路。

## R6-3. 本轮唯一产品级翻案：`toolSchemaDigest` 死接线（#1 修，#2 独立检出）

- **双席独立收敛于同一结论**：#2（冻结原语面）从 tool_loop 侧顺链发现
  converge 只收 order、变体 digest 无人消费、持久化键循环依赖无引导点
  （F-1），因修复位在 helpers/multi_variant 不越权，上报待裁；#1（代际面）
  同轮独立翻案并按独占权限落地补丁——轮内闭环，无需跨轮顺延。
- **缺陷定性**（两席一致）：纯观测面缺陷，**无请求字节错误**——order/
  generation/变体重放全不受影响；但 `tool_loop.rs:1137-1138` 注释、矩阵 F2、
  ROUND-02 任务卡合同三处一致描述的「digest 推进只在 converge、摘要落库
  对账」在 `4b784bb4` 上为假，且单变体「digest changed」日志每窗口首建
  恒报 `None -> Some(...)`，对账观测永久失真。
- **补丁形态**（本席读 diff 复核）：converge 入参
  `&[(usize, Vec<String>)]` → `&[(usize, ToolFacePrefixSnapshot)]`，
  multi_variant 三调用点（主扇出/重试批/单变体重试）不再 `.map` 丢弃
  digest；锁外共识判定 + 锁内条件采纳——仅「本地 order 恰等于收敛结果
  且全体候选 digest 一致」才写入，真分叉/字节互异/全 None 保持既有值
  （None 永不抹掉）。**不改 order 合并、fork 判定、bump 条件、锁序，
  不改发往 provider 的任何字节**；tool_loop/repo/types 零改动，
  tool_loop 的「digest 推进只在 converge」注释由假变真。
- 新增覆盖债：digest 共识采纳无测试（fork 契约副本未覆盖新行为，
  #1 §4.1 与 #2 F-4 同记），留验证轮。

## R6-4. 另两处补丁摘要（#5、#7，各自独占面）

- **#5 tail-hold 空白行泄漏**：模块契约「粘流末、其后直到 flush 只有空白
  的 close token 应删除」被 `process_newline` 破坏——只有紧跟 closer 的
  第一个换行继续 hold，随后的空行触发 `release_tail_hold` 把
  `<|im_end|>` 原样放行。修复为候选行无 token 且 hold 非空（此时必为纯
  空白）时空白连换行追加进双缓冲继续 hold；「空行后仍有正文则原样放行」
  负例语义零回退，新增回归测试 1 条。三处文档同向证明是契约 bug 而非
  设计取舍，翻不了案。
- **#7 报告脚本两 bug**：① `--days` 用 `datetime('now')`（空格分隔）与
  存量 RFC3339（'T' 分隔）做 TEXT 字典序比较，`'T' > ' '` 使截止日当天
  全量放行——改 `strftime('%Y-%m-%dT%H:%M:%S', 'now', ?1)` 同形状；
  ② 代际后缀非数字时 Rust 写入侧整体 fallback、Python 读侧却继续拆列，
  同一行两侧分组分歧——改为与 Rust 同口径整体不拆（`isascii()+isdigit()`
  排除全角数字）。顺带记录：`repo.rs:214/:638` Rust 侧两条查询同踩
  ① 的 idiom，越车道未修，列入遗留。

## R6-5. R5-8 遗留表逐项更新（本席 grep/git 复核）

| 遗留项 | 状态 |
|---|---|
| P1 事件序列测试键位错误（R5-6 翻案「执行必挂」） | **已关闭**——断言在 `4b784bb4` 落库时即为修正后形态 `usage["prompt_tokens_details"]["cached_tokens"]`（本席 `git log -S` 独立取证：该测试在 `2d70b400` 不存在、入库即修正；#8 §五.6 / #9 §一 交叉一致），父代理第 5 轮收轮时已吸收 #6 修法 |
| R5-M2-1 宣称改口（scope key 过强表述） | **已澄清定性**——#7 §一核实该翻案只打 CACHE_DEBUG 指纹 scope key，usage 行不受影响（单变体记账走 tool_loop 路，不经 stream_event 解析）；注释改口仍未做，留验证轮顺手 |
| #7 架构文档三处勘误 | 未处置（本轮无席位覆盖该文档） |
| 守卫外误剥向量（保险打点先于核算） | 仍开——#10 重验代码顺序与可达性（生产打点面 = `model2_pipeline.rs:4046` 1 个 system marker，块级合计 2 ≤ 3），维持潜伏级 |
| #7 delta 发送路径接线 | 仍开，**认识升级**：#6 §3.2 论证接线需 SendOptions 新字段透传 + Rust 注入点，跨 TS/Rust 两侧独占面——三轮顺延的根因即单席独占面不够，建议接线轮排成对席位 |
| qbank_grading 出口挂接（R4-4 越界项） | 仍开（本轮无席位认领） |
| 小问题 C：二参兼容入口 dead_code | 仍开（history.rs 本轮零改动，#4 未处置） |
| stream_filter_core 文档改口（R4-8） | 仍开（无人接线） |

## R6-6. 本轮新增遗留/观察（供第 7 轮与验证轮）

1. **retry 轮 live 包装无处落库**（#3 §3.3，新明确的既有缺口）：retry 传
   新 `user_message_id`，早写与 save_results 双双查不到块——retry 实发
   包装从未写入原 user 行，下一轮 history 重放首发字节，与 retry 轮 live
   字节可漂移。V20260806 起既有语义、非 R3 引入；修复位在 retry handler。
   与 multi_variant 扇出无早写（R3 已记）同组。
2. **digest 共识采纳零测试**（#1/#2 同记）+ **变体早退漏收敛第四处**
   （#1 §1.5 新点名 `:1630` `?` 传播，维持低危）。
3. **F-2/F-3/F-4**（#2）：digest 截断字节切片理论 panic（不可达）、digest
   是窗口冻结快照身份而非单轮请求指纹（遥测消费方勿误用）、digest/门面无
   直接单测。
4. **#4 五条观察**中值得留意两条：技能删除/停用（正文缺失）不进切代信号
   ——有 digest 即证明锚定时正文在，缺失同为确定性漂移，属语义扩展候选；
   变体路径 `load_variant_chat_history` 完全无技能锚点还原（multi_variant
   席位面）。
5. **Rust 侧 `--days` 同形陷阱**（#7）：`llm_usage/repo.rs:214/:638` 与
   脚本 bug ① 同 idiom，待裁决修复。
6. **P2 面维持项**（#10）：守卫 system 剥除循环零测试覆盖（建议验证轮补
   1 条穿透用例）、`Value::Null` 透传微瑕（内部口径自洽、仅序列化面）、
   automatic 异 TTL 400 面（归后续调研卡）。
7. **#8 观察 1**：Responses 面调用方块级断点被 `push_message_parts` 静默
   剥掉——刻意的适配器单一作者制（守 S13 陷阱与 4 写槽预算），记为设计
   决策非缺陷；与 Anthropic 侧 tools 透传开口形成有意不对称。
8. **台账勘误（#9 移交，本席在此更正）**：第 1 轮第 5 节 P1 行所记 EOF
   接线行号 `model2_pipeline.rs:5011` 现漂移至 `:5382`、stream_options
   测试 `:6118` 现漂移至 `:6404`（内容均未变仅行号）；r1「Anthropic 顶层
   cache_control 非标」定性已由 R5 #6 按官方文档纠正为标准 automatic
   caching 参数（占 1 槽），引用 r1 台账者以 R5-7/R6 口径为准。

## R6-7. 已验证（静态）/ 未验证

### 已验证（仅静态证据：读代码 / grep / git diff / git log -S）

- 本轮 diff 全貌与席位归属（R6-1，4 文件 +119/−42）——本席 `git status` /
  `git diff --stat` 复核，与任务卡独占表一致（#1 两文件、#5 一文件、
  #7 一脚本，其余七席零代码改动）。
- 红线：hooks / coordinator / tool_loop / history / repo / types /
  persistence / providers 本轮零改动——本席 status + grep 复核。
- P1 测试键位修正的落库时点（`git log -S` 唯一命中 `4b784bb4` +
  `2d70b400` 反证）——本席独立取证，#8/#9 交叉一致。
- #1 补丁的 diff 形态（converge 签名升级、三调用点、共识判定块）与
  #5 补丁（process_newline 中间臂 + 回归测试）、#7 补丁（WHERE 子句 +
  代际校验）——本席逐 hunk 读 diff 复核。
- P2 面全部行号与代码形态——本席在 `r6-p2.md` 逐项重验（透传、守卫、
  接线序、唯一构造路径、三测试、枚举无 cache_control）。
- 十份 r6 文档的裁决与证据链——本席全量通读；跨席结论（F-1 双席独立、
  P1 键位三席取证）相互印证无矛盾。

### 未验证（诚实归因）

- **未跑任何编译 / 测试 / CI**（铁律）：本轮 +119/−42（Rust×3 + Python×1）
  未经 cargo check / cargo test / python 执行；#1 digest 收敛与 #5 泄漏修
  的新增行为均无测试执行证据（#5 有测试源码、#1 连源码覆盖都缺）。
- 各席「静态模拟执行会绿」的判定（#8 三类快照、#9 九条测试）均为人工
  推演，非运行时证据。
- #7 两 bug 的修复效果（报表行集收窄、分组一致）未对真实库运行对拍。

## R6-8. 第 7 轮 / 验证轮预告

十面二检收官：1–5 轮核心裁决零翻案，唯一产品 bug（digest 死接线）轮内
闭环。累计未验证债务已达 6 轮（r2 起全部产品改动 + 全部测试源码零执行），
**验证轮（cargo check / cargo test / tsc / 脚本试跑）应为最高优先级**；
候选清单：digest 共识采纳契约测试、守卫 system 剥除穿透用例、R5-M2-1
注释改口、stream_filter_core 文档改口、retry 落库缺口裁决、delta 跨面
接线成对席位、qbank 出口挂接、Rust 侧 `--days` idiom。

## R6-9. 收轮交接（给父代理）

- 待 add：4 个产品/脚本文件（工作区 M）+ 11 个 untracked 文件
  （ROUND-06-TASKS + 十份 r6 文档）+ 本台账追加节。
- 本席未 commit/push/gh（铁律）；Draft PR #345 更新由父代理执行。
- **不标 Goal complete**：编译/测试验证轮仍未跑，digest 收敛无测试覆盖，
  验证轮任务书待排。

---

# Wave2-A 第 7 轮测试台账（#9，只追加）

- 作者：0824 Wave2-A 第 7 轮子代理 #9「测试台账」（claude-fable-5-thinking-high）
- 日期：2026-08-26
- 性质：只追加章节。第 1–6 轮章节一字不动。本席未改任何产品代码、未改任何
  测试文件、未执行 cargo/npm/测试、未 commit/push（父代理收轮）。
- 依据：`docs/dev/wave2-A/ROUND-07-TASKS.md`（tip `618634a6`，与本席 `git log`
  复核一致）+ 本席对工作区 `git status` / `git diff` / `wc -l` / grep 的
  逐文件取证 + 八个测试文件头部自述通读。
- **取证时点声明**：第 7 轮各席**并行写作**，本席于 17:03–17:13 UTC 间
  三次快照，`17:12:43Z` 时点八个测试文件（#1–#8 可写面）已全部落盘且
  3 个 M 文件 diff 自 17:09 起稳定；此后若有席位追加，以父代理收轮时
  #10 的 `r7-test-inventory.md` 索引为最终口径，本台账为快照口径。

## R7-1. 本轮 diff 形态（测试台账员独立取证，17:12:43Z 快照）

基线枝 tip `618634a6`（第 6 轮已提交）。第 7 轮为**反例测试源码补强轮**
（只写不跑，禁改产品逻辑），全部改动均在工作区未提交：

- **M（强化既有，`git diff --stat` 合计 3 文件 +791/−6）**：
  `prefix_generation_fork_tests.rs`（+81/−6）、
  `skill_replay_digest_tests.rs`（+314）、`llm_content_crash_tests.rs`（+402）。
- **untracked（新建 5 个测试文件）**：`prefix_generation_fork_finale_tests.rs`、
  `skill_replay_edit_delete_tests.rs`、`llm_content_retry_gap_tests.rs`
  （以上 pipeline/ 下）+ `providers/wave2_a_prefix_snapshot_tests.rs`、
  `providers/wave2_a_anthropic_budget_tests.rs`。
- untracked 文档：`ROUND-07-TASKS.md` + 本台账追加节（#10 的
  `r7-test-inventory.md` 于本席快照时点尚未落盘）。

红线自证（本席 status/grep 复核）：产品代码零改动——`pipeline.rs` /
`providers/mod.rs` / hooks / coordinator / tool_loop / history / helpers /
multi_variant / repo / types / persistence 全部不在 diff 中；本轮 diff
只有测试源码与文档。

## R7-2. 测试台账总表（本会话全部只写不跑测试文件）

行数为「基线 → 快照」，测试数同。执行状态：**八个文件全部未执行**（铁律，
连 cargo check 都未跑）。

| # | 文件 | 性质 | 行数 | 测试数 | 打的对象 | 预期红/绿（静态推演） |
|---|---|---|---|---|---|---|
| 1 | `pipeline/prefix_generation_fork_tests.rs` | 强化（终局） | 284→359 | 3→4 | 契约副本（converge/advance，DB-free） | **绿**。新增 `t_plus_2_steady_state_after_fork_both_variants_share_order_and_generation`：分叉轮 T 起连跑 T→T+1→T+2 完整时间线，T+2 两变体同序同代（generation 恒 1、字节跨轮全等）；文件头明示旧行为（变体内各自 load+中途 store）下测试 1/2 会红，方案 A 下全绿 |
| 2 | `pipeline/prefix_generation_fork_finale_tests.rs` | 新建 | 473 | 4 | 契约副本（同上三副本 + metadata 往返） | **绿**。A/B 后轮同现 X、Y 四稳态：后轮同现（Δg=0、advance 跳写）/ T+1..T+4 多轮+索引洗牌不漂移 / 跨进程重启从 metadata 恢复同现 / 迟到旧快照写回免疫不回退。文件头自带红绿论证（旧竞态行为下 1/2 红） |
| 3 | `pipeline/skill_replay_digest_tests.rs` | 强化（终局） | 441→745 | 5→7 | 第 1–4 节仍为 r3 契约副本；**新第 5 节改打生产门禁** `rebuild_anchored_skill_messages_gated_with_signal` + `skill_body_digest` | **绿**。两条终局：正文修改（mismatch→skip+去重信号→回退 v1 自愈且不再发信号）、删除（skip 且**永不**发信号，与 mismatch 严格区分；同 id 恢复需字节精确还原）。R3-5 所记「反例段留后续轮收口」就此收口——生产入口直断言，兼容二参入口为既有反例专门保留 |
| 4 | `pipeline/skill_replay_edit_delete_tests.rs` | 新建 | 479 | 7 | **生产入口**（history 门禁 + 锚点 meta JSON 序列化往返 + 插入层） | **绿**。编辑/删除全生命周期 7 条：编辑→skip+信号 / 编辑回滚自愈无新信号 / 删除→skip 无信号（**反例钉死 r6 #4 观察 1 残余缺口现状，若后续语义扩展该断言应翻转**）/ 删除但 replay 快照携旧正文照常重建 / 混合场景逐锚判定+信号去重 / 旧锚点无 digest 盲取新正文（兼容档代价反例）/ 全 skip 插入层零残留 |
| 5 | `pipeline/llm_content_crash_tests.rs` | 强化 | 205→607 | 3→13 | 假件（FakeUserBlockRow 等，复刻 repo/persistence/history 语义，不触真实 DB） | **绿**。+10 条：崩溃点细分（早写前无害/早写后发送前锚点）、保存点重建不抹早写（复刻 ON CONFLICT SET 列清单）、编辑重发不复活旧包装、旧库无列静默跳过不阻断发送、legacy 多 CONTENT 块写读同行+首块空串遮蔽现状角落、空白串不视同缺失、多字节逐字节保真、**multi_variant 扇出无早写窗口仍在（记录非修复）** |
| 6 | `pipeline/llm_content_retry_gap_tests.rs` | 新建 | 454 | 7 | 假件（模拟 retry ctx / sidecar 查找 / history 组装，不触真实管线） | **绿**（全部按快照口径断言可过）。测试 1–4 **固化 R6-6 遗留 1 的现状缺口**：retry 全新 user_message_id 使早写与 save 点双双跳过、陈旧 sidecar 下轮漂移、错失 NULL 回填、retry 轮自身双重包含；测试 5–6 以假件模拟**修复合同**（复用前置 user id → 缺口 1–4 闭合），是修复落地后的目标语义预演；测试 7 空串边界不变量。「只写预期」即此：现状与修复合同并陈，修复落地时 1–4 翻转、5–6 转生产断言 |
| 7 | `providers/wave2_a_prefix_snapshot_tests.rs` | 新建 | 417 | 6 | **生产适配器**（OpenAIAdapter / OpenAIResponsesAdapter / AnthropicAdapter 转换全路径） | **绿**。三家（+DeepSeek 两形态共 5 路）连续两次请求 post-adapter body 稳定前缀段（tools+system/instructions/developer 断点块）serde_json 字节逐字对比 + 同 body 重转换全字节确定性；依赖 preserve_order（Cargo.toml 已启用，文件头声明）。任何 marker 漂移/字段序抖动在此以字节 diff 暴露 |
| 8 | `providers/wave2_a_anthropic_budget_tests.rs` | 新建 | 463 | 14 | **生产守卫与转换**（`enforce_anthropic_cache_breakpoint_budget` 直调 + `convert_openai_to_anthropic` 端到端） | **绿**。R5-3 四槽/透传的增量补位：预算常量=4、守卫 no-op/空入参/纯 tools 超载/**剥除跨 tools→system 边界**（R6-6 §6 所记「system 剥除循环零测试覆盖」就此补上）/剥后无 `cache_control: null` 残留/存活 marker 载荷逐字节保真；透传契约（位置保持、嵌 function 不算、丢弃条目 marker 无副作用、全无效 tools 无 tools 键）；守卫×尾部保险断点交互（自动断点参与预算、超载先剥） |

**合计**：本轮新增测试函数 51 个（1+4+2+7+10+7+6+14），新建文件 2286 行 +
强化 +791 行；连同 1–6 轮存量（`prefix_snapshot_tests.rs` 234/4、
`prefix_generation_restore_tests.rs` 539/3 及散布各产品文件的 `#[cfg(test)]`
模块），**全部测试自 r1 起累计零执行**。

## R7-3. mod 接线状态（父代理收轮事项）

本席 grep 复核（快照时点）：

- `pipeline.rs:87-98` 既有 6 个测试 mod 声明在位（parallel_exec /
  prefix_snapshot / fork / restore / llm_content_crash / skill_replay_digest），
  **强化的三个文件已在编译面**；
- 三个新建 pipeline 测试文件（fork_finale / edit_delete / retry_gap）的
  `#[cfg(test)] mod` 声明**尚未挂**（任务卡明示由父代理加）；
- `providers/mod.rs` 零 `wave2_a` 命中——两个 providers 测试文件同样待挂。
  口径差异记录：#8 文件头写「由父代理接线」，#7 文件头写「由集成轮统一
  接线」，任务卡口径为父代理——以父代理收轮实际动作为准。
- 未挂 mod 前五个新文件不参与编译，「预期绿」连编译门都未过，纯为源码存在。

## R7-4. 已验证（静态）/ 未验证

### 已验证（仅静态证据：读代码 / grep / git diff / wc）

- 本轮 diff 全貌与席位归属（R7-1）——本席三次快照复核，与任务卡
  #1–#8 可写面一一对应，无越面改动、产品代码零 diff。
- 八文件的行数/测试数/测试函数名全量清点（R7-2 表）——本席
  `rg '#\[(tokio::)?test\]'` 逐文件枚举。
- 八文件头部自述（只写不跑声明、红绿论证、契约副本↔生产项对照表、
  缺口现状 vs 修复合同的区分）——本席逐文件通读头部。
- 强化三文件的 diff 增量形态（#1 终局测试、#3 第 5 节转生产断言、
  #5 十条新场景）——本席逐 hunk 读 diff。
- mod 接线现状（R7-3）——本席 grep 复核。

### 未验证（诚实归因）

- **未跑任何编译 / 测试 / CI**（铁律）：本轮 3077 行测试源码连同 1–6 轮
  全部存量**未经 cargo check / cargo test / rustfmt**，「预期绿」均为
  静态推演。风险梯度：#4/#3 第 5 节/#7/#8 直打生产符号（签名/可见性
  漂移即编译错）＞ #1/#2 契约副本（副本与生产语义漂移则绿得虚假）＞
  #5/#6 纯假件（假件复刻语义若与生产不符则固化了错误契约）。
- #7 的字节确定性依赖 serde_json preserve_order 的论证仍是源码推理
  （R2-6 旧债），无运行时对拍。
- #6 的修复合同（测试 5–6）对应的产品修复**本轮未做也不许做**——
  retry 缺口本身仍开（R6-6 遗留 1 状态不变）。
- 并行快照口径：17:12:43Z 后若有席位追加改动，本表行数/测试数可能
  过期，以 #10 索引与父代理收轮 diff 为准。

## R7-5. 收轮交接（给父代理）

- 待挂 mod：`pipeline.rs` × 3（fork_finale / edit_delete / retry_gap）+
  `providers/mod.rs` × 2（wave2_a 两文件），均 `#[cfg(test)]`。
- 待 add：3 个 M 测试文件 + 5 个新测试文件 + `ROUND-07-TASKS.md` +
  #10 的 `r7-test-inventory.md`（本席快照后落盘）+ 本台账追加节。
- 本席未 commit/push/gh（遵嘱）；验证轮（cargo check → cargo test）
  仍为最高优先级欠账（承接 R6-8），首跑顺序建议：先 check 全仓，
  再按 R7-4 风险梯度从直打生产符号的四个文件跑起。

---

# Wave2-A 第 8 轮台账（#10 台账员，只追加）

- 作者：0824 Wave2-A 第 8 轮子代理 #10「台账员」（`gpt-5.6-sol-xhigh-fast`）
- 日期：2026-08-26
- 基线：`cursor/0824-wave2-agent-cache-a875` @ `c1cde7e3`
- 性质：只追加章节。第 1–7 轮章节一字不动；本席未改任何产品/测试代码，
  未执行编译、测试或格式化，未安装依赖或工具链，未 commit/push。
- 依据：`ROUND-08-TASKS.md` 与九份 `r8-*.md` 全量读毕（六份环境阻断报告 +
  `r8-assert-quality-{a,b,c}.md` 三份静态断言复核），以及本席独立执行的
  `rustc --version`、`rustup toolchain list`、`git status` 静态取证。

## R8-1. 实测入口被工具链版本门禁阻断

本机实测为：

```text
rustc 1.83.0 (90b35a623 2024-11-26)
1.83.0-x86_64-unknown-linux-gnu (active, default)
```

任务卡要求 `rustc 1.98.0`；本机仅安装 1.83.0，**未安装 1.98.0**。六个实测席位均在
版本探针后立即停止：未安装、升级或切换工具链，未执行 `cargo test`、`cargo check`、
`cargo build` 或 `rustfmt`，**未空转编译**。

| # | 原定实测面 | 结果 |
|---|---|---|
| 1 | `tool_loop` 定向测试 | 未执行；rustc 1.83.0 阻断 |
| 2 | `hooks` 定向测试 | 未执行；rustc 1.83.0 阻断 |
| 3 | `helpers` 定向测试 | 未执行；rustc 1.83.0 阻断 |
| 4 | `providers` 定向测试 | 未执行；rustc 1.83.0 阻断 |
| 5 | `model_special_tokens` 定向测试 | 未执行；rustc 1.83.0 阻断 |
| 6 | Rust `prefix_snapshot` + Vitest `TauriAdapter` | Rust 未执行；Vitest runner/依赖未物化，亦未执行 |

#6 另确认 Node `v22.14.0` 存在，但 `node_modules/.bin/vitest` 与全局 `vitest` 均不存在。
按任务约束未执行 `npm install` / `npm ci` / `npx`，因此 TauriAdapter 测试同样只能记为
**未验证（依赖未安装）**，不能记为通过或失败。

## R8-2. #7–#9 静态断言质量复核结论

| 复核面 | 规模 | 静态裁决 |
|---|---:|---|
| fork | 8 tests / 80 assertions | **低**。核心 converge/generation/restart/advance 多为测试内副本，未调用生产 `converge_session_tool_face_prefix` 或真实 repo；生产实现大面积突变仍可假绿。 |
| skill | 14 / 104 | **门禁中上、全链低**。终局用例直打生产 digest gate/插入原语，能抓门禁回归；但生产锚点写入、history 三消费点、repo 换代信号未贯通。前四条 FNV 副本也不验证生产 SHA-256。 |
| llm_content crash | 13 / 35 | **低**。全部核心时序、持久化和重放由 fake/手写副本模拟；可作场景清单，不能验收生产阶段 4.6、SQLite UPDATE/读取或真实 history override。 |
| provider prefix snapshot | 6 | **有回归价值但证据边界被夸大**。三家生产转换入口确有直调，选定 JSON 组件的确定性序列化可证；孤立段相等不等于完整 wire-byte 前缀，更不能推出缓存命中。除 Responses 的部分长度检查外，新增动态尾部被转换器丢弃时多条测试仍可绿。 |
| Anthropic budget | 14 | **核心较强，留一个实质漏口**。生产守卫、3 槽边界、跨 tools→system 剥除顺序及保险断点交互均有有效断言；但调用方传入 `cache_control:null` 会形成 `Some(Value::Null)` 并可能原样序列化，现有“无 null”测试只覆盖守卫 `take()` 产生的 `None`。 |
| `model_special_tokens` | 17 | **A-**。完整输出精确相等、正反例、跨 chunk、flush、Markdown、reset、大块语义覆盖较强；公共 helper 把 `process` 与 `flush` 输出合并后才断言，未锁正常文本及时流出，亦不锁 O(n²) 复杂度及完整 reset/分割矩阵。 |
| `hooks` | 6 | **C**。默认链顺序、准入初值、灾难命令分类三条有生产锚点；另三条 fail-closed 测试只调用测试专用 `approval_manager_required`，真实 `ApprovalGateHook::before_tool` 即使错误放行仍可全绿，单条质量为 D。 |

三份静态报告的共同结论：测试场景设计本身有价值，但“测试数量/断言数量”不能替代生产
seam。当前 35 条 fork/skill/crash 测试尤其不能整体作为 fork/crash 落地正确性的验收证据；
provider 20 条静态未见明显必红矛盾，也仍不构成执行通过。

## R8-3. 静态复核给出的补强优先级

1. **最高优先：hooks fail-closed 改打生产路径。** 直调
   `ApprovalGateHook::before_tool`，覆盖 Low/Medium/High/unknown +
   `approval_manager=None`，并用 counting executor 证明 Block 后零执行。
2. **fork/crash 从副本迁到生产 seam。** fork 抽生产纯内核供 80 处既有 oracle
   复用，并留真实 DB 的 load/converge/advance/restart 用例；crash 用测试 DB +
   真实 early persist/repo/history 链，不再比较同源 String clone。
3. **补 Anthropic null 输入反例。** tools/system 两路均覆盖调用方
   `cache_control:null`/非法 marker，钉死最终请求无 JSON null。
4. **收窄 provider prefix 宣称并补动态尾部存活断言。** 组件确定性不能写成 raw
   wire prefix/cache hit 充分证据；每条转换路径应证明第二轮 assistant/tool/user
   尾部仍在。
5. **保留并加强有效面。** skill 补生产锚点→metadata/repo→history→signal
   贯通；token filter 补逐次输出 trace、全 token 分割矩阵与 reset 状态矩阵。

## R8-4. 已验证 / 未验证

### 已验证（仅环境探针与静态读码）

- `HEAD = c1cde7e3`；第 8 轮工作区只有 `ROUND-08-TASKS.md`、九份 `r8-*.md`
  与本台账追加，产品/测试代码零改动。
- 本机 rustc 实为 1.83.0；`rustup toolchain list` 仅列 1.83.0 active/default，
  1.98.0 未安装。
- 九份报告已全量读取；上表结论均来自静态调用边界、生产符号引用与断言 oracle
  复核，不冒充运行时证据。

### 未验证

- 第 8 轮原定六组 Rust 定向测试全部零执行；TauriAdapter Vitest 亦零执行。
- 自第 1 轮累计的 Rust/TS 测试债仍未获得任何本轮编译或运行证据；不能声明可编译，
  不能声明任一测试通过或失败。
- 三份断言复核未做 mutation test，其“典型错误仍可假绿”均为静态调用图推演。

## R8-5. 收轮交接

- 待父代理处理：本台账修改 + `ROUND-08-TASKS.md` + 九份 `r8-*.md`；本席未
  commit/push。
- 验证目标仍未达成：需先由环境提供项目要求的 Rust 1.98.0 与已物化的前端依赖，
  再执行定向测试；执行前宜先按 R8-3 修复最高风险的脱靶断言。

---

# Wave2-A 第 9 轮台账（#10 台账员，只追加）

- 作者：0824 Wave2-A 第 9 轮子代理 #10「组装/红线自证/轮末台账」
  （`gpt-5.6-sol-xhigh-fast`）
- 日期：2026-08-26
- 基线：`cursor/0824-wave2-agent-cache-a875` @ `dd300cd3`；官方基座
  `origin/cursor/0824-cde6` @ `061b4815`
- 性质：只追加本节，第 1–8 轮正文一字不改；本席未改产品/测试代码，未安装依赖或
  工具链，未执行 npm/cargo/编译/测试，未 commit/push。
- 依据：`docs/dev/wave2-A/ROUND-09-TASKS.md`、本席静态 grep / `git diff`，
  以及取证时点的工作区状态。

## R9-1. 按任务卡登记的本轮预期产出

以下仅是任务卡的**预期产出清单**，不在各席文件出现前冒充已完成：

| # | 独占面 | 本轮预期产出 |
|---|---|---|
| 1 | `history.rs` compat 入口属性/注释 + `r9-open-items.md` | 小问题 C dead_code 属性收口；遗漏项按已闭合/仍开/观察项分类 |
| 2 | `wave2-A-agent-architecture.md` 只追加 | 架构文档勘误节；补记 B2/B4/B7 状态 |
| 3 | `stream_filter_core.rs` 文件头 + `r4-catalog-delta.md` 只追加 | 骨架挂载状态改口；目录换代键名勘误 |
| 4 | `tool_loop.rs:1-39` rustdoc | 按 R3–R6 现状重写「冻什么/不冻什么/何时切代」矩阵说明 |
| 5 | `r2-freeze-matrix.md` 只追加 + `r9-clear-freeze-matrix.md` | 清理语义与冻结语义终稿矩阵 |
| 6 | `model2_pipeline.rs` fingerprint 注释 + `r9-dead-code.md` | R5-M2-1 scope 宣称收窄；死代码扫描报告 |
| 7 | `r9-write-only.md` | 只写字段最终扫描，只报告，不删除序列化字段 |
| 8 | `r9-i18n.md` | 本会话新增日志/文案的一致性扫描 |
| 9 | `r9-pr-body.md` | PR 描述初稿，明确区分静态已验证与运行时未验证 |
| 10 | 本台账只追加 | 组装任务卡预期、红线 grep 自证与轮末诚实状态 |

首次取证时 `docs/dev/wave2-A/r9-*.md` 为 **0 份**；本节落笔后的第二次快照出现
`r9-pr-body.md`（#9），摘录其结论：

> “状态：**Draft**。本文中的‘已落地’只表示源码/文档层面的静态落地，不表示已经
> 通过编译、测试、CI 或真实 provider 请求验证。”

其余席位产物仍以父代理收轮时工作区为准。

## R9-2. 七条红线静态自证

以下均为本席实际执行的静态命令与关键命中；“无输出”只证明当前源码/差异面未命中，
不等同于编译或运行通过。

1. **默认 hooks 顺序未变，审计钩子仍在 — PASS（静态）**

   ```text
   $ rg -n -C4 'default_pipeline_hooks|ApprovalGateHook|TaskAuditHook' \
       src-tauri/src/chat_v2/pipeline/hooks.rs
   159:pub(crate) fn default_pipeline_hooks() -> Arc<Vec<Arc<dyn PipelineHook>>> {
   160:    Arc::new(vec![
   161:        Arc::new(ApprovalGateHook) as Arc<dyn PipelineHook>,
   162:        Arc::new(TaskAuditHook) as Arc<dyn PipelineHook>,
   163:    ])
   1517:    fn default_hooks_keep_approval_gate_first() {
   1523:        assert_eq!(names, ["approval_gate", "task_audit"]);
   ```

   `ApprovalGateHook` 仍是 `vec` 首元素，`TaskAuditHook` 仍紧随其后；顺序守卫测试源码也在。

2. **保留字面 token 的负例测试仍在 — PASS（静态）**

   ```text
   $ rg -n 'preserves_literal_tokens_in_prose' \
       src-tauri/src/utils/model_special_tokens.rs
   691:    fn preserves_literal_tokens_in_prose() {
   ```

   测试体仍断言正文中的 `<|im_end|>` / `<|begin_of_box|>` 字面量原样保留。

3. **`coordinator.rs` 相对官方基座零 diff — PASS（静态）**

   ```text
   $ git diff --exit-code origin/cursor/0824-cde6 -- \
       src-tauri/src/data_governance/migration/coordinator.rs
   （无输出，exit 0）
   ```

4. **无生产 `ChatV2AnkiAdapter` — PASS（静态）**

   ```text
   $ rg -n --glob '!**/__tests__/**' --glob '!**/*.test.*' \
       --glob '!**/*.spec.*' \
       '(import[^;]*ChatV2AnkiAdapter|new[[:space:]]+ChatV2AnkiAdapter)' \
       src src-tauri/src
   （无输出，exit 1）
   ```

   广搜名称的命中仅为历史说明注释与负向守卫测试；`src` 下也没有名称含
   `ChatV2AnkiAdapter` 的模块文件。未发现生产 import 或构造。

5. **无 `mythos-5` / `haiku-5` 真实内置目录条目 — PASS（静态）**

   ```text
   $ rg -n 'model:[[:space:]]*"[^"]*(mythos-5|haiku-5)|id:[[:space:]]*"[^"]*(mythos-5|haiku-5)' \
       src-tauri/src/llm_manager/builtin_vendors.rs
   （无输出，exit 1）
   ```

   宽搜仅命中适配层代际解析/测试，以及 `builtin_vendors.rs:1681-1692` 的负向目录
   守卫（明确断言无 `claude-haiku-5` 且无 `mythos`，内置 Haiku 为 4.5），不是真实目录项。

6. **`apply_openai_prompt_cache_retention` 实现/调用已不存在 — PASS（静态）**

   ```text
   $ rg -n 'fn[[:space:]]+apply_openai_prompt_cache_retention|apply_openai_prompt_cache_retention[[:space:]]*\(' \
       src-tauri/src
   （无输出，exit 1）
   $ rg -n 'apply_openai_prompt_cache_retention' src-tauri/src
   src-tauri/src/llm_manager/model2_pipeline.rs:3584:
     // P6 裁决（R5 #1）：`apply_openai_prompt_cache_retention` /
   ```

   唯一残留是说明该死实现已删除的裁决注释，不存在函数定义或调用。

7. **UTF-8 invalid warn 探针仍在，且明确不声称修复 #122 — PASS（静态）**

   ```text
   $ rg -n -C3 'issue #122|Some\(invalid_len\)|log::warn!' \
       src-tauri/src/llm_manager/utf8_stream.rs
   3://! 注：本文件包含 issue #122 定位探针（invalid 分支的 log::warn，仅记录长度类
   4://! 元数据，不记录任何 chunk/用户文本内容），不声称修复 #122。
   75:                        Some(invalid_len) => {
   76:                            // issue #122 定位探针（不声称修复）：真正非法字节触发
   80:                            log::warn!(
   113:            log::warn!(
   ```

   真非法字节分支与 flush 残留分支的 warn 均在；注释只称定位探针，未宣称修复。

## R9-3. 已验证 / 未验证

### 已验证（仅静态）

- 任务卡十席预期产出已登记；七条红线均以源码 grep 或定向 `git diff` 取证。
- `HEAD = dd300cd3`，分支为 `cursor/0824-wave2-agent-cache-a875`；本席写入前工作区
  只有 untracked `ROUND-09-TASKS.md`，随后出现 #1 的 `history.rs` 改动与 #9 的
  `r9-pr-body.md`；本席未改这两处。
- 本席可写面仅本台账追加节，未改更早轮次正文或任何产品/测试文件。

### 未验证

- 环境仍为 `rustc 1.83.0 (90b35a623 2024-11-26)`，不满足任务卡所述项目
  Rust 1.98 环境；按约束未安装、升级或切换工具链。
- 未执行任何 cargo/npm/编译/格式化/测试/CI 门禁；七条 PASS 全是静态结论，
  不证明代码可编译、测试可运行或运行时行为正确。
- 第二次快照仅见 #9 的 `r9-pr-body.md`；其余预期产出没有在本节冒充完成。

## R9-4. 收轮交接

- 本席仅追加了「Wave2-A 第 9 轮台账（#10 台账员，只追加）」一节。
- 本席未 commit/push/改 PR；后续若出现 `r9-*.md`，由父代理收轮时补齐汇总结论。
- 验证门禁仍未运行，本节不标 Goal complete。

## R9-5. 父代理收轮补记

第 9 轮十席文件均已落盘。父代理抽查产品 diff 后认定：`history.rs` 仅
`cfg_attr`+rustdoc；`stream_filter_core.rs` 仅文件头；`tool_loop.rs` 仅文件头
矩阵改口；`model2_pipeline.rs` 仅 fingerprint 注释。另按 #8 i18n 建议改了两处
内部日志措辞（`pipeline.rs` / `persistence.rs` 的 `save_results will backfill`
过强承诺 → 「target missing / later save points may retry」），未改控制流。
TauriAdapter 用户通知英文化留给后续会话（需 i18n key，越出本轮扫尾）。

---

# 第 10 轮终版归档

- 日期：2026-08-26。
- 本会话第 1–10 轮至此完成；本节只追加终版归档，不改写第 1–9 轮正文。
- 全部产物停在独立演进枝 `cursor/0824-wave2-agent-cache-a875` 与 Draft PR #345；
  不整支合回官方枝，是否选择性吸收、何时转 Ready 均留人工裁决。
- **不标 Goal complete**：这里的“完成”只指十轮静态审阅、实现与文档归档完成，
  不表示编译、测试、CI、真实 provider 请求或缓存收益验证完成。
- 官方 tip 仍为 `origin/cursor/0824-cde6` @ `061b4815`。本枝 tip 不在台账中固化为
  后续永真值；本次归档快照的 `git log -1 --oneline` 为
  `659b8c54 docs(wave2-A): close round-9 leftover docs and wording`，最终一律以
  实际执行 `git log -1` 的结果为准。

## P1–P11 终态

“已落地待验证”表示生产实现或约定文档已静态落盘，但运行门禁为零；“部分”表示
核心改造已落盘，同时同一问题面仍有明确产品缺口；“未做”表示整项没有落地。

| 项 | 终态 | 终版口径 |
|---|---|---|
| P1 | **已落地待验证** | 方案 A 的 generation / snapshot / 确定性 converge 与 digest 共识采纳链已落盘；跨路径并发窄窗和真实恢复收益仍待验证。 |
| P2 | **部分** | 技能正文 digest 门禁、同源生产、冲突去重信号已落盘；正文缺失不触发切代、multi-variant 技能锚点还原等产品债未收。 |
| P3 | **已落地待验证** | 名字序、schema 字节、digest 已收敛到会话级 tool-face 冻结/恢复语义；字节对拍和 fork/restore 尚未运行。 |
| P4 | **部分** | 目录原子首发、pending generation 与 reload 后兑现已落盘；delta 发送链及 live 会话即时拾取 pending 未接通。 |
| P5 | **部分** | 主对话发送前 early persist 已落盘；retry 新 id 与 multi_variant 扇出的崩溃窗仍未修。 |
| P6 | **已落地待验证** | 非法 `ttl:"24h"` 的零调用 retention 死实现已删除，未来复活约束已钉死；仅有静态删除证据。 |
| P7 | **部分** | session / variant / run 分列、四段 post-adapter 指纹和报表口径已落盘；V20260826 中断收敛与 Rust 侧时间窗债未收。 |
| P8 | **已落地待验证** | hooks 四小件已落盘，默认顺序与 TOCTOU 静态未变；fail-closed 测试仍有脱离生产 seam 的质量债。 |
| P9 | **部分** | reasoning 独立过滤、常量单源、游标化和已授权出口已落盘；qbank_grading 出口仍未挂接。 |
| P10 | **部分** | Step 22 P0/P1 与 Anthropic P2 四槽/marker 改造已静态落盘；G-CC400、G3 和 null/守卫覆盖债仍在。 |
| P11 | **已落地待验证** | 21 行 Agent/provider 架构矩阵及后续原则已归档；其“契合/已改造”判断仍只获静态证据。 |

整项归类为“未做”的 P 项为**无**；“未做”集中在上表各“部分”项和下述残留
产品债，不能因 P1–P11 均有产物而省略。

## 已验证 / 未验证

### 已验证（仅静态）

- 仅验证源码/文档存在性、符号与调用关系、`grep` / `git diff` / `git log` 证据，
  以及跨席位静态复核；“已落地”一律不等于可编译或运行正确。
- 静态确认官方 tip 仍为 `061b4815`，本会话产物位于独立枝及 Draft #345；
  `coordinator.rs` 红线、默认 hooks 顺序和既有负例均维持先前静态口径。

### 未验证（编译测试门禁与残留产品债）

- npm/TypeScript/Vite、cargo check/test/build、rustfmt、migration checker、Vitest、
  CI、真实 SQLite 升级/中断恢复、真实 provider 请求、缓存命中率和 mutation test
  均未形成通过证据；本轮亦未执行 npm/cargo/安装/编译/测试。
- 残留产品债至少包括：retry 与 multi_variant early-persist、catalog delta 与 live
  pending 接线、技能删除切代、G-CC400、Anthropic 稳定/易变 system 拆分、FIFO/
  compaction 协同、V20260826 中断收敛、qbank 出口、hooks 测试生产 seam，以及
  明确未修的 issue #122。
- 因此本枝继续保持 Draft，编译测试门禁与上述产品债共同构成“不标 Goal complete”
  的终版理由。

## 第 10 轮并行文档摘录

归档终检时已出现 1 份 `r10-*.md`，摘录一句：

- `r10-pr-body.md`：> “状态：**Draft**。本文中的‘已落地’只表示源码/文档层面的
  静态落地，不表示已经通过编译、测试、CI 或真实 provider 请求验证。”

其余任务卡中的预期文件名在终检时尚未出现，不冒充已落盘产物。

## R10-父代理收轮补记

十席文件收轮时已全部落盘：`r10-review-{concurrency,replay,protocol,frontend}.md`、
`r10-redlines.md`、`r10-cache-hit-static.md`、`r10-residual-risks.md`、
`r10-pr-body.md`、`r10-delivery.md`、`ROUND-10-TASKS.md`。四人交叉终审均为
确认（并发面 1 条文档级翻案：compaction 事务接了 pending mark；重放面 1 条
文档级翻案：变体 sidecar 保存点实为测试模块）。红线 10/10 静态 PASS。
PR #345 **保持 Draft**，不转 Ready。不标 Goal complete。
