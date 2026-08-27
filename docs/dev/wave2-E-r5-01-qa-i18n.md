# Wave2-E R5-01：QA 质检标记 i18n（lint 条目按 code 本地化）

日期：2026-08-26
范围：`src-tauri/src/anki_qa_lint.rs`（仅文档注释）、
`src/features/chat/plugins/blocks/components/AnkiQaFlagBadge.tsx`、
`src/locales/{zh-CN,en-US}/anki.json` 的 `qaFlags.lint.*`（新增，旧词条不动）。
不改 lint 算法、不删 Rust `message` 字段、不动 `ankiQaFlags.ts` 解析层。

## 问题

`AnkiQaFlagBadge.resolveFlagMessage` 对 lint 条目直接展示 `flag.message`。
后端 `anki_qa_lint.rs` 的 message 全是中文诊断文本（如「front 长度 250 超过最小信息
原则阈值 220（疑似整段粘贴）」），英文界面会原样泄漏中文。critic 条目
（`llm_critic` / `llm_critic_revised`）此前已按 code 走 i18n，lint 条目没有。

## 方案

### 词条（前缀 `qaFlags.lint.<code>`）

zh-CN / en-US `anki.json` 各新增 25 条，key 与 `anki_qa_lint.rs` `codes::ALL`
的稳定 code 逐字对应（snake_case 原样作 key，便于 grep 与契约核对）。
**故意不收录 `legacy_flags_unparsed`**：该条目的 message 就是待展示的原始历史
标记内容，翻译 code 反而会丢信息，走 message 回退是正确行为。
旧词条（`qaFlags.rules.*`、`qaFlags.severity.*` 等）全部保留。
两语言 key 对齐由既有 `tests/vitest/flashcards/localeKeys.test.ts` 的 parity 断言守护。

### 前端解析顺序（`AnkiQaFlagBadge.resolveFlagMessage`）

1. critic code → `agent.critic.*`（不变）；
2. **新增**：lint code 在 `LINT_LABEL_KEYS` 中 → `t('qaFlags.lint.<code>', params)`；
3. 回退 `flag.message`（未收录的未来 code、或数字参数抽取失败）；
4. 旧字段规则 rule 名 → `qaFlags.rules.*`（不变）；
5. 最后回退裸 code（不变）。

### 数字参数插值

后端 `LintIssue` 没有独立 `params` 字段（本轮不加，避免动序列化形状与
`_qa_flags` 协议），数字参数从 message 中按出现顺序抽取（`/\d+(?:\.\d+)?/g`）：

| code | 参数（按 message 中数字顺序） |
| --- | --- |
| `cloze_unclosed` / `cloze_empty_answer` / `cloze_bad_index` | `n`（处数；bad_index 的 message 里「c1」的 1 排第二，不受影响） |
| `front_too_long` | `n`（实际长度）、`limit`（阈值） |
| `near_duplicate` | `percent`（相似度百分比） |
| `mixed_language` | `cjk`、`latin`（两个百分比） |
| `mcq_too_few_options` | `n`（非空选项数；「至少 2 个」的 2 排第二） |
| `field_rule_min_length` | `n`、`min` |
| `field_rule_max_length` | `n`、`max` |

抽到的数字少于该 code 声明的参数数时**放弃词条、回退 message**，
不渲染带空洞的模板。参数名刻意避开 `count`（i18next 的复数保留名）。

## Rust 侧

- `message` 字段**保留不删**：仍是诊断/日志与前端兜底展示的载体；
- 仅更新 `LintIssue.code` / `LintIssue.message` 的文档注释：声明用户可见文案由
  前端按 code 走 `qaFlags.lint.<code>`，并写明「message 中数字出现顺序」是与
  前端抽取器（`LINT_NUMERIC_PARAM_NAMES`）之间的软契约，调文案勿改数字顺序语义；
- lint 算法、code 字面量、`codes::ALL`、序列化形状零改动，
  既有契约测试（`codes_module_*`、`lintContract.test.ts`）不受影响。

## 测试（只写不跑）

`tests/vitest/chat-v2/plugins/blocks/AnkiCardsQaMedia.test.tsx`：

- fixture 的 lint message 从英文占位改为后端真实形态的中文诊断文本；
- 详情断言从「原样展示 message」改为「按 code 出本地化文案 + 数字插值」，
  并显式断言中文诊断不泄漏（`not.toHaveTextContent('最小信息原则')` 等）；
- 新增回退用例：未收录 code 展示 message；`front_too_long` message 缺数字时回退 message；
- mock 字典补 `qaFlags.lint.front_too_long` / `qaFlags.lint.empty_back` 两条。

`ankiQaFlags.test.ts`（解析层）与事件流测试（`_qa_flags` 原样透传）不涉及渲染，未动。
