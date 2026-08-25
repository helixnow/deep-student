# Round 5 #4：金标集接通 LLM Critic——真正的 Grounded Judge

> 状态：已落地（代码 + 测试）。**Critic 默认仍然关闭（opt-in）**，见 [§5 开关](#5-开关默认关闭)。

## 1. 背景与目标

Round 4 交付了两块互相独立的组件：

- `anki_critic.rs`（Round 4 #2）：任务收尾后的批量 LLM 裁决（keep|revise|flag），
  但 grounded 参照卡 `ReferenceCard` 只是**预留接口**——生产调用方永远传空切片，
  实际评审只靠内置规则 rubric；
- `anki_gold_set.rs`（Round 4 #10）：从「编辑前原文（`_original_generation`）+
  编辑后现状 + 留存信号」挖掘金标样本，核心产物是修正对
  `RepairPair { original(劣化), edited(金标) }`——但没有任何运行时消费方。

本轮把两者接通：**critic prompt 可携带 0-N 对同源金标（改前劣化 / 改后金标），
让裁决基准从"通用规则"升级为"该文档上真实用户修正过什么"**。

## 2. 数据流

```
任务收尾 Ok(stats)（streaming_anki_service）
  │  critic_opts.critic_enabled()？（默认 false，直接跳过全部）
  ▼
collect_gold_references(db, task, cfg)              [anki_critic]
  │  db.get_cards_for_document(document_id)          同文档全部卡片行
  │  剔除当前任务自己的卡（既当裁判又当被告）与错误卡
  │  extract_original_from_extras(_original_generation)   [anki_gold_set]
  │  mine_gold_set / classify_candidate               挖掘语义零改动
  │  select_grounded_reference_pairs                  金标端 lint 门槛 + 去重 + 上限
  ▼
Vec<ReferenceCard { front/back=金标, degraded_front/back=劣化 }>
  │
  ▼
run_critic_pass(db, llm, task, &refs, &cfg)          [anki_critic]
  │  build_critic_prompt：0 对 → 规则 rubric（行为与接通前逐字节一致）
  │                       ≥1 对 → 同源金标对照模式（含独立预算截断）
  ▼
keep|revise|flag 裁决 → 白名单校验 → plan_updates
  → update_anki_card_if_version_for_library（送审快照 updated_at CAS）
```

### 同源的含义

参照对只来自 `task.document_id` 相同的**兄弟任务**卡片：同一份文档、此前分段
生成、且被用户实际动手修过（`_original_generation` 快照 ≠ 当前内容）。用户在
这份材料上修掉过什么劣化（答案泄露、一卡多事实、空泛提问、语义错误……），
critic 就以同类标准评审新生成的卡。

### 金标质量门槛（`select_grounded_reference_pairs`）

- 只取携带修正对的标签：`EditedMinor` / `EditedMajor` / `ErrorCardRepaired`；
- **金标端必须干净**：`edited` 过生产 lint（Warn+）零命中且非空——脏金标会教坏裁决基准；
- 刻意**不要求**劣化端被 lint 命中：lint 盲区对（规则抓不到、用户却修了的语义劣化）
  恰是 LLM critic 相对规则 rubric 的增量价值；
- 按金标 front 去重、保持确定性顺序、`max_reference_pairs`（默认 6）截断。

## 3. Prompt 形态

无金标（0 对）时 prompt 与 Round 4 完全一致：内置规则 rubric
（事实性 / 最小信息原则 / 重复 / 拿不准一律 keep）。

有金标（≥1 对）时切换为对照模式：

```
评审模式：对照同源金标。…「改前(劣化)」是曾被生成、后被用户修掉的劣化版本；
「改后(金标)」是用户留下的标准卡。…拿不准时一律 keep，宁可漏报，不可误改。

【同源金标参照】
1. 改前(劣化) Q: 快速排序的平均时间复杂度是多少？答案是 O(n log n)。
   改前(劣化) A: O(n log n)
   改后(金标) Q: 快速排序的平均时间复杂度是多少？
   改后(金标) A: O(n log n)
```

评测 harness 也可注入无劣化面的纯金标示例（`degraded_front/back = None`），
渲染为单行 `金标 Q/A`。

## 4. Token 预算：金标绝不挤占待评审卡

金标参照区有**独立预算**，在 `build_critic_prompt` 内落地：

- 对数上限：`max_reference_pairs`（默认 6）；
- 字符预算：`min(max_reference_chars（默认 6000）, max_prompt_chars / 3)`——
  即便配置给出巨大金标预算，硬钳位保证至少 2/3 总预算留给源材料与待评审卡；
- 超预算/超上限的金标对**跳过并计数**（`CriticPrompt.skipped_references`，
  透出到 `CriticSummary.gold_references_truncated`）；
- 边界情形：一对金标都放不进预算 → 干净回退规则 rubric，不留空的金标段落；
- 单字段仍走既有 `max_field_chars` 截断；卡片清单的既有总预算检查
  （`max_prompt_chars`）在金标区之后执行，天然把金标占用计入总账。

## 5. 开关：默认仍关闭

**本轮零默认行为变化**：

- critic 主开关 `enable_critic_pass`（别名 `enable_llm_critic`）经
  `CriticOptions::from_options_json` 对 `anki_generation_options_json` 做
  serde-default 二次解析，**缺省 false**；解析失败也视同关闭。开关不开时
  金标收集与模型调用完全不发生；
- 该开关与确定性 QA lint 的 `enable_qa_pass` 相互独立：`enable_qa_pass`
  只控制零成本的规则 lint（Round 3 #3），critic 是额外一次 LLM 调用，
  必须单独 opt-in。两者默认都为关闭态的部分（critic 全体、lint 的自动修复
  之外的裁决）不会因本轮接线而被激活；
- 开了 critic 但同文档没有任何可用修正对（新文档、无编辑、埋点缺失）时，
  critic 回到规则 rubric——行为与 Round 4 一致。

## 6. 安全边界（继承并复测）

| 约束 | 机制 |
| --- | --- |
| 模型伪造 card_id | 裁决 id 必须命中送审白名单（`allowed_ids`），白名单外一律拒绝并计数（`rejected_unknown_ids`）；`revised` 载荷中的 id/task_id 被解析层忽略 |
| 模型失败 / 超时 / 非法 JSON | `plan_from_model_output` 降级：全部卡片视同 keep、零写入、`degraded` 标记；`run_critic_pass` 永不向上抛错 |
| 模型调用期间用户编辑同一卡片 | 写回使用送审快照的 `updated_at` 做 CAS；版本冲突直接跳过并计入 `persist_failures`，绝不以 critic 的旧快照覆盖用户新内容 |
| 金标收集失败（DB 错误等） | `collect_gold_references` 返回空列表 → 规则 rubric，收集层绝不拖垮制卡收尾 |
| revise 空载荷 | 解析层降级为 flag，绝不用空内容覆盖卡片 |
| 修订轮 | 硬钳位 1 轮不变 |
| executor 工具面 | 零改动 |

## 7. 改动面

| 文件 | 改动 |
| --- | --- |
| `src-tauri/src/anki_gold_set.rs` | 仅加查询/格式化 helper：`extract_original_from_extras`（内存态快照提取）、`select_grounded_reference_pairs`（修正对筛选）。挖掘语义（classify/mine/lint 契约/脱敏）零改动 |
| `src-tauri/src/anki_critic.rs` | `ReferenceCard` 扩展劣化面（serde 向后兼容，可选字段）；`from_repair_pair` 转换；prompt 金标区渲染 + 独立预算截断；`gold_references_from_cards`（纯函数）+ `collect_gold_references`（DB 入口）；`CriticSummary` 增加 `gold_references` / `gold_references_truncated` 观测字段 |
| `src-tauri/src/streaming_anki_service.rs` | 最小改动：critic 启用时先 `collect_gold_references` 再传入 `run_critic_pass`（原来传 `&[]`） |

## 8. 测试（本轮新增 14 例）

`anki_gold_set.rs`（5）：内存态快照提取（含缺键/非法/非对象）；脏金标过滤；
lint 盲区对保留；标签/空白/重复/无对样本过滤；上限与顺序保持。

`anki_critic.rs`（9）：grounded 模式切换与计数；劣化/金标双面渲染；对数上限截断；
预算截断且不饿死待评审卡；全截断回退规则 rubric；`from_repair_pair` 映射
（含 Cloze text 顶替空 back、空劣化面退化）；兄弟卡挖掘（编辑/未编辑/无快照）；
当前任务卡与错误卡剔除；脏金标拒绝；收集层上限。

既有回归全部保留：伪造 card_id 拒绝、失败降级 keep、revise 空载荷降级 flag、
默认关闭、修订轮钳位等。

## 9. 已知限制与后续

- 此路径不 join FSRS 复习日志（`review_count = 0`），`KeptUnedited` 正例桶
  在运行时收集中不产出——修正对不依赖留存信号，不影响本轮目标；后续可把
  高留存正例也注入为纯金标示例；
- `_original_generation` 埋点（gold-set-plan §6 P0）仍未在生成管线写入；
  埋点落地前，存量库中带快照的卡片有限，运行时多数任务将回退规则 rubric——
  这正是"接口先行、默认关闭"的意义；
- 跨文档金标（同学科/同 deck）刻意不做：同源性是 grounded 的核心保证。
