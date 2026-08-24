# Round 3 #5：FSRS 复习数据回流到制卡生成

> 状态：已实现并接线（后端）。差异化 SOTA 项——市面 AI 制卡工具（含 Anki 生态的
> AI 插件）普遍是"单向生成"：复习数据只进调度器，从不反哺生成。本项把 FSRS
> 复习信号闭环回流进制卡 prompt，让新卡"知道"用户已经忘过什么。

## 隐私声明（重要）

**所有数据不出本地。** 画像与干扰预警的全部输入来自本地 SQLite
（`fsrs_card_states` / `fsrs_review_logs` 所在的 mistakes.db），聚合在进程内
纯函数完成，产物只是注入到本机制卡 prompt 的一段文本。没有任何网络请求、
没有遥测、没有云端存储。发给 LLM 的内容仅限用户已配置的制卡模型请求本身
（与不开启此功能时的制卡请求属于同一信道），且只含 **卡片正面摘要**，
不含答案、复习时间线等细节。

## 架构

```
制卡入口 EnhancedAnkiService::start_document_processing_inner
    │  options.fsrs_feedback (None=默认开启, Some(false)=关闭)
    ▼
anki_fsrs_feedback::build_feedback_injection(db, document_content, cfg)
    │
    ├─ FsrsReviewService::list_feedback_rows(limit)   ← 唯一 SQL（只读联表）
    │      fsrs_card_states ⋈ anki_cards ⋈ document_tasks
    │      按 lapses DESC 取前 N 行；查询失败 → 返回 None（降级，不阻断制卡）
    │
    ├─ build_profile(rows, now, cfg)          ← 纯函数：用户复习画像
    │      · 高 lapse/due 模板统计（TemplateLapseStat）
    │      · 易混淆标签（≥2 卡且平均 lapse ≥1 的标签，TagLapseStat）
    │      · 平均可提取性（rs-fsrs FSRS-5 遗忘曲线 (1+19/81·t/S)^-0.5）
    │      · 高遗忘卡片 front 摘要示例
    │
    ├─ build_interference_hints(rows, content, cfg)   ← 纯函数：同批次语义干扰
    │      对即将制卡的材料提取关键词（拉丁词 + CJK bigram，零依赖词法启发式），
    │      与库内高 lapse 卡 front 求重叠，命中者列为"近义高遗忘卡"
    │
    └─ render_*_section(…)                    ← 纯函数：渲染 + 字符预算截断
    ▼
注入 options.custom_requirements（现有最高优先级 section，
StreamingAnkiService::build_prompt 原样带入 system prompt，无需改流式切卡逻辑），
同时回填 options.user_review_profile 供前端/调试查看本次实际注入内容。
```

## 注入内容示例

```
【用户复习画像 · FSRS 本地统计（数据仅本地，不上传）】
- 复习库规模：214 张已入队，其中 180 张已复习，23 张当前到期
- 平均可提取性（retrievability）：0.87
- 高遗忘模板：cloze-choice（12 卡 / 34 次遗忘 / 5 张到期，平均 2.8）
- 易混淆标签：三角函数（5 卡 / 14 次遗忘）；洛必达法则（3 卡 / 9 次遗忘）
- 高遗忘卡片示例：
  · 「sin(A+B) 的展开式是什么？」（lapses=6）
制卡建议（基于以上画像）：
- 涉及上述易混淆标签/高遗忘模板的知识点，请拆成更小的原子卡（一卡一问）。
- 对高遗忘卡对应的概念，优先生成角度不同的强化卡（举例、反例、应用场景），而非重复原表述。

【同批次语义干扰预警 · 库内已有的高遗忘近义卡（数据仅本地）】
以下卡片与本次材料主题相近且历史遗忘率高：
- 不要生成与其重复或仅换措辞的卡片；
- 若新内容与其确实相邻易混，请生成「对比卡」：正面同时呈现两个易混概念并要求区分。
1. 「sin(A+B) 的展开式是什么？」（lapses=6）
2. 「cos(A+B) 的展开式是什么？」（lapses=4）
```

## 开关与降级语义

| 场景 | 行为 |
| --- | --- |
| `options.fsrs_feedback == None`（默认） | 开启，自动构建并注入 |
| `options.fsrs_feedback == Some(false)` | 完全跳过，零查询 |
| `options.user_review_profile` 调用方已显式提供 | 直接使用调用方文本，不再查库 |
| FSRS 表查询失败（表缺失/锁/损坏） | `warn!` 日志 + 返回 `None`，制卡照常进行 |
| 空库 / 无任何复习信号 | 返回 `None`，不注入任何 section |

`AnkiGenerationOptions` 新增字段均 `#[serde(default)]`，旧前端 payload 无需变更。
ChatAnki 路径（`chatanki_executor` → `EnhancedAnkiService`）保持默认 `None`，
自动享受同一回流。

## Token/字符预算

`FsrsFeedbackConfig`（默认值）集中控制注入体积，按"中文 1 字 ≈ 1 token"保守估算：

- `max_profile_chars = 1400`、`max_interference_chars = 1600`：两个 section 合计 ≤ 3000 字符；
- `max_interference_cards = 8`、`max_high_lapse_cards = 6`、`front_excerpt_chars = 60`：
  逐条截断，超预算即停止追加；
- `scan_limit = 500`（SQL 层上限 2000）：控制查询体量。

## `suggest_splits`：高 lapse 卡拆分建议（纯函数 API）

```rust
pub fn suggest_splits(front: &str, back: &str, max_suggestions: usize) -> Vec<SplitSuggestion>
// SplitSuggestion { front, back, rationale }
```

对反复遗忘的卡给出「拆成更小原子卡」的确定性启发式建议（零 LLM 成本）：

1. **枚举答案**（`1.`/`1、`/`(1)`/`①`/`-`/`·` 行首标记，或 ≥3 段分号列表）
   → 每个要点一张 `front（要点 i/n）` 卡；
2. **对比型正面**（`A 与/和 B 的区别/异同/对比`）→ A、B 各拆一张单概念卡
   （原对比卡保留，先掌握单点再对比）；
3. **长多句答案**（≥3 句且 >120 字符）→「核心结论」+「补充细节」两张卡；
4. 已是原子卡 → 返回空（不制造噪音）。

当前为纯 API + 测试，暂未接新的前端工具（遵循"优先不改 skill schema"约束）；
后续可由复习界面的 leech 卡操作菜单或 Agent 只读工具直接调用。

## 文件清单

| 文件 | 变更 |
| --- | --- |
| `src-tauri/src/anki_fsrs_feedback.rs` | 新增：画像/干扰/拆分纯函数 + 编排入口 + 17 个单测 |
| `src-tauri/src/fsrs_review_service.rs` | 新增 `FsrsFeedbackRow` + 只读 `list_feedback_rows` |
| `src-tauri/src/enhanced_anki_service.rs` | 生成入口注入（默认开启可关，失败降级） |
| `src-tauri/src/models.rs` | `AnkiGenerationOptions` 新增 `fsrs_feedback` / `user_review_profile`（serde default） |
| `src-tauri/src/lib.rs` | 注册模块 |
| `src-tauri/tests/anki_fsrs_feedback.rs` | 5 个真实 SQLite 集成测试（空库降级/排序上限/双 section/无关材料/聚合正确性） |

## 测试覆盖（22 个）

模块内单测（17，纯函数零 DB）：画像 camelCase 序列化 roundtrip、空库空画像、
FSRS-5 可提取性精确值（stability=5 · 5 天 → 0.9）、模板排序/截断、易混淆标签
过滤/排序/截断、画像字符预算截断、front 摘要多字节安全、CJK/拉丁关键词提取、
干扰关键词命中与低 lapse 排除、干扰列表上限、干扰渲染预算、枚举拆分、
分号/对比拆分、长答案拆分与原子卡 no-op、枚举标记边界（含 `2026年` 不误判）、
配置默认值/序列化、due/reviewed 计数。

集成测试（5，真实迁移建库）：空库降级为 `None`、`list_feedback_rows` 排序与
limit、注入同时含画像+干扰 section 且不含无关卡/答案、无关材料只注入画像、
画像聚合（due/标签/模板）与真实调度状态一致。

## 后续方向

- 把 `suggest_splits` 暴露为 Agent 只读工具（`fsrs://suggest-splits`），在复习端
  对 leech 卡一键"拆卡重制"；
- 干扰匹配从词法重叠升级为本地 embedding 相似度（LanceDB 已在库内），仍保持本地；
- 画像纳入 `fsrs_review_logs` 的评分节奏（Again 率随时间变化）以捕捉"正在恶化"的主题。
