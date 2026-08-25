# Round 3 #3：确定性卡片质检 lint 引擎（零 LLM 成本）

> 模块：`src-tauri/src/anki_qa_lint.rs`
> 接入点：`StreamingAnkiService::parse_and_save_card`（卡片构建前）
> 状态：已实现 + 48 个单元测试

## 1. 动机

LLM 生成的 Anki 卡片存在一批**高频、可机器判定**的失败模式（参考
Memory Machines 与 arXiv 2507.05629 对 LLM 制卡失败的归类）：
front/back 相同、答案泄露、cloze 语法破损、占位符残留、一卡多问等。
这些问题不需要再花一次 LLM 调用去"评审"——纯规则引擎在微秒级即可
判定，**token 成本为零**，且判定结果可复现、可测试、可回归。

本模块把这批规则收敛为一个独立、无副作用的 lint 引擎：

- 输入：卡片切面（front/back/text/tags/extra_fields 的借用，零拷贝）；
- 输出：结构化违规列表 `[{code, field, message, severity}]`；
- 行为：**默认 flag 入库不丢卡**，可选升级为拒绝。

## 2. 规则清单

| # | 失败模式 | code | 严重度 | 说明 |
|---|---------|------|--------|------|
| 1 | front == back | `front_back_identical` | Error | 归一化（去 HTML/空白/标点、转小写）后完全相同 |
| 2 | 空字段 | `empty_front` / `empty_back` | Error | cloze 卡（Text 含 `{{c`）豁免空 back |
| 3 | cloze 破损 | `cloze_unclosed` / `cloze_empty_answer` / `cloze_bad_index` / `cloze_missing` | Error / Warn | 手写扫描器解析 `{{cN::...}}`，检查未配对 `}}`、空挖空、`c0` 等非法序号；Text 字段存在但无任何挖空 → Warn |
| 4 | 答案泄露 | `answer_leak` | Warn | 归一化 back 整体出现在 front 中；back 短于 `answer_leak_min_chars`（默认 4）跳过以免 "是"/"A" 噪声 |
| 5 | 双概念 | `multi_concept` | Warn | 启发式：≥2 个问号 / "分别"+并列连词 / 英文 " and "+双疑问词 |
| 6 | 最小信息原则 | `front_too_long` | Warn | front 可见字符（剥 HTML 后）超过 `max_front_chars`（默认 220，可配） |
| 7 | 占位符残留 | `placeholder_residue` / `todo_residue` / `xxx_residue` / `empty_brackets` | Error / Warn | `{{UPPER_SNAKE}}`（含 `{{DOCUMENT_CONTENT}}`）为 Error；TODO/FIXME、独立 `xxx` token、空 `【】（）()` 为 Warn。cloze 语法 `{{c1::…}}` 不误报 |
| 8 | tags 空 | `tags_empty` | Info | 不影响可复习性，仅提示 |
| 9 | 同文档重复卡 | `duplicate_card` | Warn | `FingerprintTracker` 持有归一化 front 指纹集合；DB 唯一索引仍是最终防线 |
| 10 | 字段规则 | `field_rule_min_length` / `field_rule_max_length` / `field_rule_allowed_values` / `field_rule_pattern` | Warn | 包装既有 `FieldExtractionRule` 的 min/max/allowed_values/regex 语义（`lint_field_against_rule`） |
| 11 | 选择题结构 | `mcq_too_few_options` / `mcq_answer_not_in_options` / `mcq_missing_answer` | Error / Warn | 通过 extra_fields 的 `optionA`~`optionD`（含 `option_a` 变体）识别选择题；非空选项 <2、字母答案无对应选项、全文答案与所有选项不匹配 → Error；缺答案字段 → Warn |
| 12 | 语言混杂 | `mixed_language` | Info | 低置信启发式：back 中 CJK 与拉丁字母各占 ≥30% 且字母总量 ≥24。**永不拒绝**（中英夹杂术语卡常见） |

## 3. 严重度与行为级别

```text
LintSeverity: Info < Warn < Error
LintLevel:    Flag（默认） | Reject
```

- **Flag（默认）**：所有违规仅写入 `extra_fields["_qa_flags"]`，卡片照常入库。
  这是"违规不毙卡"的既有产品决策——LLM 轻微越界很常见，毙卡损失内容。
- **Reject**：`should_reject(issues, cfg)` 仅在配置为 Reject **且**存在
  `Error` 级违规时返回 true。`Warn`/`Info` 在任何配置下都不触发拒绝，
  这是"低置信只 flag 不拒绝"的硬保证（有测试锁定）。

## 4. 公共 API

```rust
// 无状态 lint（不含重复检测）
pub fn lint_card(input: &CardLintInput, cfg: &LintConfig) -> Vec<LintIssue>;

// 带文档级重复检测（tracker 与文档同生命周期）
pub fn lint_card_with_tracker(
    input: &CardLintInput, cfg: &LintConfig, tracker: &mut FingerprintTracker,
) -> Vec<LintIssue>;

// 合并进 extra_fields["_qa_flags"]（保留既有条目、(code,field) 去重、幂等）
pub fn merge_flags(extra_fields: &mut HashMap<String, String>, issues: &[LintIssue]);

// 拒绝决策（仅 Reject 级别 + Error 违规）
pub fn should_reject(issues: &[LintIssue], cfg: &LintConfig) -> bool;

// 规则 10 的独立入口（供 lint 管线外复用）
pub fn lint_field_against_rule(
    field_name: &str, value: &str, rule: &FieldExtractionRule,
) -> Vec<LintIssue>;
```

`LintConfig` 全字段 `serde(default)`：前端/调用方只传增量配置即可，
每条规则可独立开关，阈值（`max_front_chars`、`answer_leak_min_chars`、
`mixed_language_min_letters`）可调。

## 5. `_qa_flags` 协议兼容

`extract_fields_with_rules`（既有代码）已经会把字段规则违规写成
`[{field, rule, message}]` JSON 数组存进 `extra_fields["_qa_flags"]`。
`merge_flags` 的合并策略：

1. 解析既有数组，条目原样保留在前（不丢失、不改写）；
2. lint 条目序列化为 `{code, field, message, severity}` 追加在后
   （以 `code` 键区分来源）；
3. 按 `(code, field)` 去重 → 重复调用幂等；
4. 零违规且原本无 flags 时**不写键**（干净卡片不带 `_qa_flags`）；
5. 既有值不是合法 JSON 时不静默丢弃，包装为
   `{code: "legacy_flags_unparsed"}` 条目保留原文。

## 6. 生成管线接入（本轮已接）

`StreamingAnkiService::parse_and_save_card` 在字段提取
（`extract_fields_with_rules`）与占位符清理（`clean_template_placeholders`）
之后、`AnkiCard` 构建与入库之前调用：

```rust
let lint_issues = crate::anki_qa_lint::lint_card(
    &crate::anki_qa_lint::CardLintInput {
        front: &cleaned_front,
        back: &cleaned_back,
        text: cleaned_extra_fields.get("text").map(String::as_str),
        tags: &cleaned_tags,
        extra_fields: &cleaned_extra_fields,
    },
    &crate::anki_qa_lint::LintConfig::default(),
);
crate::anki_qa_lint::merge_flags(&mut cleaned_extra_fields, &lint_issues);
```

之后不需要任何新增统计代码：流式循环既有逻辑
（`card.extra_fields.contains_key(QA_FLAGS_FIELD)` →
`StreamStats::flagged_cards += 1`）自动把 lint 命中的卡计入
`flagged_cards`，并通过既有 `anki_generation_event` 的 stats 载荷
上报前端。`QA_FLAGS_FIELD` 常量在两个模块中各自声明（避免耦合），
由单测 `qa_flags_field_name_matches_streaming_service` 锁定一致。

### 6.1 为什么规则 9 未接进流式路径

`parse_and_save_card` 是 `&self` 方法、无文档级可变状态；把
`FingerprintTracker` 穿透进去需要改流式循环与多个调用点的签名，
超出本轮"仅在既有 `_qa_flags` 写入处调用 lint"的边界约定。当前：

- **落库去重已有保障**：DB 唯一索引使 `insert_anki_card` 对重复卡返回
  false，流式循环计入 `StreamStats::duplicate_cards`；
- `FingerprintTracker` 已实现并测试，供后续轮次（或 chatanki 批量导入
  路径）在拥有文档级循环所有权的地方接入，把"重复"从静默跳过升级为
  显式 `duplicate_card` flag。

### 6.2 其他调用方如何接入

任何拿到卡片字段的地方都可以调用（引擎无状态、无 IO）：

- **chatanki 批量导入**：导入循环里 `lint_card_with_tracker` + 每文档
  一个 tracker，`should_reject` 决定是否进隔离区；
- **前端 QA 面板**：读取卡片 `extra_fields._qa_flags`，按 `code` 分组、
  按 `severity` 着色，支持"仅看 Error"过滤与批量修复入口；
- **导出前校验**：apkg 导出前跑一遍 Reject 级别，把 Error 卡列入
  确认清单。

## 7. 测试

`cargo test --lib anki_qa_lint`，共 48 个单元测试，覆盖：

- 每条规则的命中 + 不误报（阴/阳性各至少一例）；
- cloze 扫描器边界：未配对、空挖空、`c0` 非法序号、front 中的 cloze、
  `{{correct}}` 模板变量不误判为 cloze；
- 归一化鲁棒性：HTML 标签、空白、大小写不影响 front==back 与指纹判定；
- `merge_flags`：保留既有条目、幂等、干净卡不写键、非法旧值包装保留；
- `should_reject`：Flag 永不拒；Reject 仅对 Error；Info（tags 空、
  语言混杂）在任何级别都不拒；
- `LintConfig` serde 增量反序列化与规则独立开关；
- 与 `streaming_anki_service::QA_FLAGS_FIELD` 的常量一致性。

## 8. 成本与性能

- LLM 成本：0（纯规则）；
- 单卡耗时：微秒级（两个静态正则 + 线性扫描；正则可在后续轮次用
  `once_cell` 缓存，当前每卡编译 2 个小正则在流式吞吐下不可感知）；
- 内存：`FingerprintTracker` 每文档 O(卡数 × 归一化 front 长度)。

## 9. 后续方向（不在本轮范围）

1. 把 `LintConfig` 暴露到 `AnkiGenerationOptions`，让模板/用户自定义
   阈值与级别；
2. 流式路径接入 `FingerprintTracker`（需要循环级状态穿透）；
3. 前端 QA 面板消费 `severity` 分层展示与一键重生成；
4. 语义级规则（卡间近重复、front 与文档源的事实一致性）留给
   embedding/LLM 评审层——那是另一个成本档位，与本模块互补。
