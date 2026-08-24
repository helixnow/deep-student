# 金标卡集（Gold Set）挖掘方案：从用户编辑记录中提取

> 状态：**部分已实现（Round 4 #10）**。标注/抽取纯函数层 + lint 契约校验 +
> 修正对回归已落地，SQLite 埋点与离线挖掘脚本仍是后续工作。
> 目标不变：把"用户实际保留/修正的卡片"变成制卡质量评估的金标数据，
> 替代纯人工标注。
>
> 已实现（见 `src-tauri/src/anki_gold_set.rs`，纯函数、不接管线）：
>
> - §3 label 步骤：`classify_candidate` / `mine_gold_set`（kept_unedited /
>   edited_minor / edited_major / deleted_early / error_card_repaired /
>   unlabeled 六标签决策树，阈值即本文伪代码数字，`GoldMiningConfig` 可调）；
> - 「改前=劣化、改后=金标」抽取：`RepairPair`（含字符级编辑距离比）+
>   `lint_repair_pair`（直接调用生产 `anki_qa_lint::lint_card` 校验
>   original 命中 / edited 零命中 / lint 盲区三态）；
> - §2 P0 读取端：`extract_original_generation`（`_original_generation`
>   两种存储形态的解析）；
> - §3 export 整形：`fixture_export_bucket` + `to_fixture_json`（含 §4 的
>   PII 样式脱敏 `scrub_pii`）；
> - §5.2 修正对回归：`tests/fixtures/anki-eval/gold/repair-pairs/*.json`
>   被 JS（`tests/vitest/anki/eval/goldPairs.test.ts` + CLI）与 Rust
>   （`repo_repair_pair_fixtures_satisfy_lint_contract`）双侧消费；
> - lint 码跨语言契约：`LINT_CONTRACT_CODES` 清单 + 双向锁定测试
>   （详见 `eval/README.md` 对照表）。
>
> 未实现（后续轮）：`_original_generation` 生成路径写入埋点、
> `anki_card_revisions` 表、FSRS 数据拼装层、离线挖掘 CLI、分层抽样器。

## 1. 核心思路

用户对 AI 生成卡片的后续行为是免费且高置信的质量标注：

| 用户行为 | 质量信号 | 金标用途 |
|---|---|---|
| 生成后未编辑、长期留存并持续复习 | 强正例 | 好卡金标（lint 零误报校准） |
| 生成后小幅编辑（改措辞/修错别字） | 弱正例 + 修正对 | (bad→good) 修复对，训练/评估重写建议 |
| 生成后大幅重写（front/back 语义变化） | 强负例 + 修正对 | 失败模式挖掘、lint 新规则来源 |
| 生成后立即删除 / 从未复习 | 负例（噪声较大） | 需与"内容重复"信号区分 |
| 错误卡被用户手工修好 | 解析失败样本 + 人工修复答案 | Structured Output 回归夹具 |

## 2. 数据源（本仓库现有表，均在本地 SQLite）

- **`anki_cards`**：`front/back/text/extra_fields_json/is_error_card/error_content/
  created_at/updated_at/template_id/task_id`。
  - `created_at ≈ updated_at` → 从未编辑；`updated_at > created_at` → 至少一次编辑。
  - `extra_fields_json._qa_flags` → 生成时即被字段规则标记的卡。
  - `is_error_card=1` 且后续变为正常内容 → "用户修好的错误卡"样本。
- **chatanki 审查流（`chatanki_executor.rs` 的 update/review 工具）**：带
  `review_version` CAS 版本号的逐卡更新是显式的"用户/代理修订"事件。
- **FSRS 复习日志（`fsrs_card_states` / 复习记录表）**：留存 + 复习次数 +
  评分分布（again 率高的卡可能题干有问题）作为留存质量信号。
- **`document_tasks`**：把卡片回溯到生成任务与源文档，用于重建"输入材料 →
  生成卡 → 用户修订"三元组。

### 缺口（需先补的埋点，才能拿到高质量修正对）

当前 `anki_cards` 只有"最新态 + updated_at"，**没有编辑前原文**。方案：

1. 轻量：新增 `anki_card_revisions` 表（card_id, revision, front, back, text,
   edited_at, edit_source: user|agent|import），在卡片 UPDATE 路径写入旧值。
2. 过渡（无 schema 变更）：在 `extra_fields_json` 里追加
   `_original_generation: {front, back, text}`，生成时写入一次、永不更新，
   编辑后即可 diff 出修正对。成本最低，推荐先做这个。

## 3. 挖掘管线（伪代码级）

> label 与 export 两步已实现为纯函数（`anki_gold_set::classify_candidate` /
> `fixture_export_bucket` / `to_fixture_json`）；extract（SQL 拼装）与
> sample（分层抽样）待离线脚本落地。

```
extract:
  SELECT c.*, t.source_type, t.source_id
  FROM anki_cards c JOIN document_tasks t ON c.task_id = t.id
  WHERE c.source_type IN ('mistake', 'document', 'chatanki')

label:
  kept_unedited   := updated_at - created_at < 5min AND review_count >= 3 AND lapse_rate < 0.4
  edited_minor    := edit_distance(orig, final) / len(orig) < 0.25
  edited_major    := 否则（有 _original_generation 时）
  deleted_early   := 删除时间 - 创建时间 < 24h AND review_count == 0

sample:
  每个 (template_id × subject × label) 分层抽样，防止高产用户 / 单一学科主导

export:
  金标正例  → tests/fixtures/anki-eval/gold/positive/*.json
  修正对    → tests/fixtures/anki-eval/gold/repair-pairs/*.json（{original, edited}）
  负例      → tests/fixtures/anki-eval/gold/negative/*.json
```

## 4. 隐私与脱敏（硬约束）

- 全程本地执行（数据在用户 SQLite 中），导出仅限用户显式同意的自愿共享通道。
- 导出前脱敏：正则剥离邮箱/手机号/身份证号样式片段；卡片内容做主题白名单
  （教育类学科）人审后才能进入仓库 fixture。
- 仓库内金标只存"风格等价改写"版本（LLM 改写 + 人工确认），不存用户原文，
  除非来自研发自测账号。

## 5. 金标的消费方式

1. **lint 校准**：正例集合上任何 lint 码命中率 > 2% 即视为误伤，规则需收紧
   阈值或加豁免（对照 `good/` 集的机制，规模从 6 张扩到 ≥100 张）。
2. **修正对回归**（已实现）：`repair-pairs` 中 original 应被 lint 命中、
   edited 应零命中；两端都不满足的对子暴露 lint 盲区，是新规则的第一素材
   来源。JS 侧 `harness.mjs::evaluateRepairPair`（vitest + CLI），Rust 侧
   `anki_gold_set::lint_repair_pair`（生产 lint 引擎复检），盲区按失败暴露
   而非静默通过。
3. **生成质量 A/B**：prompt / 模型 / Structured Output 变更后，在同源材料上
   重新生成并与金标正例做嵌入相似度 + lint 命中对比，量化质量漂移。
4. **错误卡修复评估**：用户修好的错误卡（原始坏 JSON + 人工正确答案）直接
   追加为本 harness 的 `cases/*.txt` + 预期，形成真实世界失败样本的持续回流。

## 6. 分阶段落地

- **P0（无 schema 变更）**：✅ 读取端 `extract_original_generation` +
  全部标注/校验/导出纯函数已实现（Round 4 #10）；⬜ 生成路径写入
  `_original_generation` 埋点；⬜ 离线脚本按第 3 节规则跑通 kept_unedited
  正例导出（研发自测库）。
- **P1**：`anki_card_revisions` 表 + 编辑路径埋点；修正对导出
  （导出整形与校验已就绪，只差数据源）。
- **P2**：FSRS 留存信号并入标签（`GoldCandidate` 已预留
  review_count/again_count 字段与阈值）；分层抽样器；金标集版本化
  （`gold/v1/`，manifest 记录挖掘参数与日期）。
