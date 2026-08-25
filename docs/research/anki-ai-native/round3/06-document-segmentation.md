# Round 3 #6：文档分段服务加固（document_processing_service.rs）

> 状态：已完成。本轮把 `segment_document` 从「零测试覆盖 + 多个潜伏 bug + 假开关」
> 打磨到「24 个单元测试钉住行为 + 真实边界修复 + 诚实的边界吸附实现」。

## 1. 分段算法（现状，非愿景）

`DocumentProcessingService` 把长文档切成分段任务（`DocumentTask`），每个任务独立走一次
LLM 制卡。分段逻辑已提取为**纯函数**（不依赖数据库），全部可直接单测。

流水线（`segment_document`）：

```text
全文 token 估算（本文件权威口径）
  │  ≤ 每段预算 → 整篇单段返回（含空文档：返回 1 个原样分段）
  ▼
按 \n\n 段落切分 → 贪心聚合（段落边界优先，段落绝不被拆开——除非它自己超预算）
  │  单段落超预算
  ▼
按句末标点（。！？.!?）切句 → 贪心聚合
  │  单句超预算
  ▼
按字符硬切（token 感知二分搜索切点；绝不切坏 UTF-8/CJK/emoji 标量值）
  │  enable_llm_boundary_detection = true 时
  ▼
硬切点规则吸附：段落(\n\n) > 换行 > 句末标点 > 空白（窗口≈段长 20%，至少 16 字符）
  ▼
segment_overlap_size > 0 → 相邻分段注入边界上下文（前段尾部/后段头部），超预算时按
后缀 → 前缀 → 正文顺序裁剪
  ▼
兜底：过滤空/纯空白分段；保证至少 1 段
```

## 2. 参数

| 参数 | 来源 | 默认 | 语义 |
|------|------|------|------|
| 每段预算 | `DEFAULT_MAX_TOKENS_PER_SEGMENT` | 10 000 tokens | 按本文件 `estimate_tokens` 口径；`max_output_tokens_override`/`max_tokens` 较小时取其一半，**下限 256**（`MIN_TOKENS_PER_SEGMENT`） |
| `segment_overlap_size` | `AnkiGenerationOptions`（ChatAnki：普通材料 200，词汇表 0） | 200（serde default） | 相邻分段边界上下文的最大字符数；实际借用量还受「邻段字符数一半」上限约束（见 §4 修复 4） |
| `enable_llm_boundary_detection` | `AnkiGenerationOptions`（ChatAnki 传 `Some(true)`） | `None`（= 关闭） | **规则边界吸附**开关，见 §3 |
| `max_cards_total` | `AnkiGenerationOptions` | `None` | 存在时按 `distribute_global_max_cards` 均摊到各分段（余数从前往后 +1，总量守恒） |

## 3. `enable_llm_boundary_detection`：诚实说明（不是 LLM 定界）

历史问题：该字段由 ChatAnki 传入（`Some(true)`），但后端**从未读取**——是个假开关。

本轮起 `segment_document` 会读取它。开启时，在**硬切点**（超长单句被迫按字符切断处）
附近做纯规则的 "semantic-ish" 边界吸附（`snap_cut_to_boundary`）：

- 在硬切点前约本段长度 20%（至少 16 字符）的窗口内，按优先级向后搜索：
  段落边界 `\n\n`（覆盖 Markdown 标题行前的空行）→ 单个换行 → 句末标点 → 任意空白；
- 只前移切点、不扩大分段，因此**不会破坏 token 预算**；
- 找不到边界或段太短（<32 字符）则维持硬切点。

**这不是 LLM 定界**：切点选择过程没有任何模型调用。若未来实现真正的 LLM 边界检测，
应保留本规则吸附作为降级路径，并更新本节与 `document_processing_service.rs` 模块注释。
段落/句子级切分本来就走自然边界，吸附只影响「超长单句硬切」这一最深的降级路径。

## 4. 本轮修复的真实 bug（均有测试钉住）

1. **零预算死循环**：`max_tokens=0/1` 时旧 `calculate_max_tokens_per_segment` 返回 0，
   `split_by_characters` 的 `max_chars=0` 导致游标永不前进 → 死循环/内存膨胀。
   现在预算钳制 ≥256，且硬切每轮至少消费 1 字符。
   （`max_tokens_per_segment_zero_is_clamped`、`forced_char_split_zero_budget_terminates`）
2. **CJK 硬切约 2 倍超预算**：旧实现用 `max_chars = max_tokens × 2` 粗换算，对 CJK
   （≈1 token/字）产出 ~2 倍预算的分段。现在对切点二分搜索，保证每段估算 ≤ 预算
   （依赖 `estimate_tokens` 的前缀单调性，也已被测试钉住）。
   （`forced_char_split_preserves_cjk_and_emoji`、`estimate_tokens_monotonic_over_prefixes`）
3. **空串下溢 panic**：`byte_index_to_char_index("")` 旧实现 `0 - 1` 下溢。
   （`byte_index_to_char_index_handles_multibyte_and_empty`）
4. **短邻段整段复制（重复 overlap）**：邻段长度 ≤ overlap 时旧 `get_overlap_suffix/prefix`
   返回整个邻段，两个短分段互相完整包含 → 同一内容重复制卡。现在重叠上限还受
   「邻段字符数一半」约束。（`overlap_does_not_fully_duplicate_short_neighbor`）
5. **空/纯空白分段**：trim 后可能残留空段（产生空内容任务）。现在各级 push 均校验，
   `segment_document` 出口统一过滤 + 保底 1 段。（`no_empty_segments_for_whitespace_heavy_document`）
6. **假开关**：见 §3。（`segment_document_reads_llm_boundary_flag` 等 4 个测试）

硬切始终发生在 `char` 边界（`Vec<char>` 索引），不会切坏 CJK/emoji 标量值；无损性
（各段拼接 == 原文）也有测试。已知限制：不做 grapheme cluster 归并，ZWJ 组合 emoji
（如 👨‍👩‍👧）可能被切在标量边界上——不产生非法 UTF-8，只可能把组合表情拆成成员。

## 5. Token 估算：权威规则与口径分歧

代码库存在三套估算，口径**不一致**且短期内不打算统一（分段预算 10k 相对模型上下文
余量充足，偏差不会导致超限）。权威约定写在 `document_processing_service.rs` 模块注释：

| 位置 | 规则 | 用途 |
|------|------|------|
| `document_processing_service.rs::estimate_tokens` | 汉字(U+4E00..=U+9FFF)=1/字 + floor(词数×1.3) + floor(其它字符×0.2)，下限 字符数/4，空串=0 | **分段决策唯一权威** |
| `utils/token_budget.rs::estimate_tokens` | 逐字符加权（ASCII 字母 0.25、CJK/假名/谚文 1.0、emoji 0.8…）；`tokenizer_tiktoken` 特性下用真实 tokenizer | 聊天上下文预算 |
| 前端 `tokenUtils.ts` / `CardAgent.ts` | CJK=1/字、ASCII≈4 字符/token | UI 展示提示，仅供参考 |

钉住测试：`estimate_tokens_pinned_values`（精确值）与
`estimate_tokens_diverges_from_token_budget`（显式断言 `"hello world"` 两套口径 4 ≠ 3）。
任何一侧改公式都会让测试失败，逼迫同步更新注释与本文档。

## 6. 与 ChatAnki 词汇表归一化的关系

ChatAnki（`chatanki_executor.rs`，本任务只读不改）对词汇表类材料有一条明确的上游契约：

1. **归一化**：`normalize_glossary_paragraphs` 把单换行分隔的词条重排为 `\n\n` 分隔——
   正因为本服务按 `\n\n` 切段落，归一化后**每个词条成为一个不可拆分的段落单元**，
   分段绝不会把一个词条切到两个任务里；
2. **overlap=0**：词汇表模式传 `segment_overlap_size: 0`。词条之间没有跨段上下文依赖，
   重叠只会让边界词条在两个任务中各被制卡一次 → 重复卡片。
   测试 `glossary_overlap_0_produces_no_duplication` 用 120 条词汇表钉住：
   每个词条在所有分段中恰好出现一次（不重复、不丢失）；
3. 普通材料传 `segment_overlap_size: 200`，保证跨段知识点的上下文连续性
   （`overlap_200_adjacent_segments_share_boundary_context` 钉住相邻分段共享 ≥80 字符边界上下文）。

即：**归一化决定"段落"的粒度，本服务保证粒度不被破坏；overlap 策略由内容形态决定，
本服务保证 overlap 不放大为整段复制。**

## 7. 测试清单（24 个，全部纯函数、无数据库依赖）

`src-tauri/src/document_processing_service.rs` `mod tests`：

- token 口径：`estimate_tokens_pinned_values` / `estimate_tokens_diverges_from_token_budget` / `estimate_tokens_monotonic_over_prefixes`
- 预算计算：`max_tokens_per_segment_default_and_derived` / `max_tokens_per_segment_zero_is_clamped`
- 基本形态：`empty_document_returns_single_segment` / `whitespace_only_document_returns_single_segment` / `short_document_is_not_segmented`
- 10k 切分与段落优先：`long_document_splits_within_10k_budget` / `paragraph_boundaries_are_preferred`
- overlap：`overlap_200_adjacent_segments_share_boundary_context` / `glossary_overlap_0_produces_no_duplication` / `overlap_does_not_fully_duplicate_short_neighbor`
- 超长单段/硬切：`oversized_single_paragraph_is_split_by_sentences` / `forced_char_split_preserves_cjk_and_emoji` / `forced_char_split_zero_budget_terminates`
- 边界吸附：`boundary_snap_enabled_cuts_at_natural_boundaries` / `boundary_snap_disabled_keeps_hard_cut` / `segment_document_reads_llm_boundary_flag` / `snap_cut_prefers_paragraph_over_sentence`
- 防御与工具：`no_empty_segments_for_whitespace_heavy_document` / `take_prefix_and_suffix_respect_token_limit_and_char_boundaries` / `byte_index_to_char_index_handles_multibyte_and_empty` / `distribute_global_max_cards_cases`

运行：`cd src-tauri && cargo test --lib document_processing_service`
