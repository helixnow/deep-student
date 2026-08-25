# Round 3 #10：用户制卡偏好记忆（Mem0 风格 ADD-only）

> 模块：`src-tauri/src/anki_preference_memory.rs`（纯逻辑，零 I/O、零 LLM）
> 路线图对应：`03-optimization-roadmap.md` 第三批 #15「用户制卡偏好记忆 (Mem0 模式)」
> 状态：已实现 + 19 个单元测试；**本轮不接线**，API 供后续 `chatanki_run` 调用

## 1. 动机

用户在制卡会话里的每一次编辑、删卡、附加要求都是偏好信号：把英文答案改写成中文、
反复把被翻译掉的术语写回原文、删掉四成"浅层碎卡"、总是点名同一个模板。当前管线
对这些信号**零记忆**——下个会话一切从头再来，用户被迫每次重复同样的 extraRequirements。

Mem0 的核心思想是把「对话事实」蒸馏成短记忆并在后续注入。本模块做它的制卡特化版，
并刻意收窄为 **ADD-only**：

- Mem0 完整操作集是 ADD / UPDATE / DELETE / NOOP，由 LLM 判定；错误的 UPDATE/DELETE
  会静默毁掉仍然有效的记忆，且难以审计。
- 本版抽取器只产出 ADD：重复观察 → 累计证据数、小幅提升置信度；矛盾偏好（先偏好
  中文后偏好英文）→ 两条条目共存，由**检索层**按 `置信度 × ln(1+证据数)` 择一注入。
- 唯一例外是容量维护：条目超过 64 时淘汰最低分条目，属存储层策略，不属抽取语义。

## 2. 数据流

```text
会话结束                                      下次 chatanki_run
────────────────────────────────────────    ─────────────────────────────────
SessionObservation                           retrieve_preference_prompt(
  ├ extra_requirements（显式要求）              store, goal, 模板名列表, 预算)
  ├ edits: before/after diff                        │
  ├ deletions + generated_count                     ▼
  └ template_used                            "【用户制卡偏好】…（≤ 预算 token）"
        │ extract_preferences（纯启发式）            │
        ▼                                           ▼
  Vec<PreferenceCandidate>                   追加进 build_chatanki_requirements
        │ consolidate（ADD-only）
        ▼
  PreferenceStore（serde 可序列化，调用方持久化）
```

## 3. 抽取信号与置信度

| 偏好类别 | 显式信号（extraRequirements，conf 0.9） | 行为信号（conf 0.5-0.85） |
|---|---|---|
| `Language`（subject: zh/en） | "用中文回答" / "in English"；中英信号并存 → 歧义放弃 | ≥2 次编辑使 CJK 占比同向变化 ≥0.25 且方向占优 |
| `NoTranslation` | "不要翻译" / "保留原文" / "keep original" | 混排文本（CJK≥20%）中跨编辑累计写回 ≥2 个 before 没有的 ASCII 术语（含停用词过滤） |
| `CardDensity`（subject: 数字上限或 None） | "最多 N 张" / "at most N cards"；定性 "少而精/宁缺毋滥" | 生成 ≥5 张且删除比例 ≥30%（置信度随比例走） |
| `TemplatePreference`（subject: 模板名） | "用 X 模板"（带否定前缀 不/别/勿/免 时跳过） | 会话内主动选用模板（仅在无显式信号时补充，conf 0.6） |

设计原则：**缺失信号一律不产出候选**（保守），行为信号置信度必须低于显式要求，
单次行为不足以下结论（语言迁移与术语回写都要求 ≥2 次独立证据）。

## 4. 检索与 token 预算

`retrieve_preference_prompt(store, goal, available_templates, max_tokens)`：

1. **过滤**：`TemplatePreference` 的模板必须在可用模板列表中（忽略大小写、双向包含，
   "填空"可命中"学术填空题"），否则跳过——模板已删/改名时注入无效指令只会浪费预算；
2. **打分**：`置信度 × (1 + ln(1+证据数))`，subject 命中 goal 关键词 +0.5；
3. **每 kind 择一**：最多 4 行，天然消解矛盾条目（zh/en 共存时只注入证据更强的一条）；
4. **预算装箱**：`estimate_tokens`（CJK 每字 1 token、其余 4 字符 ≈ 1 token，刻意高估）
   累加 header + 各行，超预算整行丢弃；一行都放不下 → 返回空串，调用方不注入。

注入文案自带让步条款（"若与本次要求冲突，以本次要求为准"），保证记忆永远只是默认
倾向、不覆盖用户当次指令。

## 5. 公共 API（后续接线参考）

```rust
pub fn extract_preferences(&SessionObservation) -> Vec<PreferenceCandidate>;
pub fn consolidate(&mut PreferenceStore, &[PreferenceCandidate], now_ms) -> ConsolidateOutcome;
pub fn retrieve_preference_prompt(&PreferenceStore, goal, &[String], max_tokens) -> String;
pub fn estimate_tokens(&str) -> usize;
pub const DEFAULT_PROMPT_TOKEN_BUDGET: usize = 120;
pub const MAX_STORE_ENTRIES: usize = 64;
```

接线计划（后续轮次）：

1. `chatanki_executor` 会话收尾处收集 `SessionObservation`（update_card/delete_card 已
   有 before/after 与版本信息，零额外查询）→ `extract` + `consolidate`；
2. `PreferenceStore` 以 JSON 存入用户配置（serde 直接可用，snake_case kind 便于跨端）；
3. `chatanki_run` / `chatanki_start` 在 `build_chatanki_requirements` 前调用
   `retrieve_preference_prompt(store, goal, 模板名列表, 120)`，非空则追加为一条要求；
4. 可选增强：用 LLM 对 `ConsolidateOutcome.added` 做二次归纳（Mem0 完整体），
   纯启发式层保持为确定性兜底。

## 6. 测试（19 个，均通过）

| 组 | 覆盖 |
|---|---|
| extract 显式信号 ×5 | zh/en 语言、中英并存歧义守卫、不翻译、数字密度上限、模板（含否定前缀守卫） |
| extract 行为信号 ×4 | ≥2 次中文化改写产出（单次不产出）、术语回写、删卡 40% 产出 /10% 与小样本不产出、空观察零候选 |
| consolidate ×4 | 新增、重复强化（证据+1/置信度封顶/时间戳）、矛盾共存不改写不删除、容量淘汰 |
| retrieve ×4 | 空库空串、每 kind 择一 + 不可用模板过滤（双向包含匹配）、token 预算（充足/紧张/放不下/0）、goal 关键词加权 |
| 基础设施 ×2 | estimate_tokens 边界（空串/CJK/ASCII 取整/混排）、store serde round-trip |

> 注：本轮主树存在其他子代理在途修改，模块测试通过独立 crate 挂载
> `#[path] mod anki_preference_memory` 验证（同一份源文件、同版本依赖 serde/serde_json/regex）。

## 7. 同轮配套交付

- `src/locales/{zh-CN,en-US}/anki.json`：新增 `agent.*` 文案块（transform 试运行/冲突、
  retemplate fillStatus 六态、`_qa_flags` 规则四类、analyze 路由三来源 + 三路线、
  偏好记忆提示），中英 key 全量对称（脚本校验 1005 = 1005）。
- `docs/user-guide/12-Anki制卡与模板.md`：反映 29 个 chatanki 工具、批量机械变换
  （dry_run → 确认 → apply）、换模板自动补字段（fill_missing_llm）、AI 路由规划
  （plan_route，置信度不足回退启发式）、质检标记与偏好记忆（标注"逐步开放中"）。
- `progress-log.md` / `README.md` / `round3/00-round3-summary.md`：Round 2 收口 +
  Round 3 交付索引，PR [#215](https://github.com/helixnow/deep-student/pull/215)。
