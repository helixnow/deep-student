# Round 5 #10：eval lint 与 anki_qa_lint 完全对齐 + 回归扩容

> 状态：已交付。vitest 3 套件 32 例全绿；good 对照集 13 段仍 0 误伤；
> `node scripts/anki-eval/run-eval.mjs` 退出码 0。生产切卡逻辑零改动。

## 目标

Round 4 #10 把 eval harness 的 JS lint 从自造 UPPER_SNAKE 原型码切换到了
Rust `anki_qa_lint` 的 code 字符串契约，但对齐依赖**正则扫描 Rust 源码里的
字面量**，且 JS 侧对「Rust 有而 JS 没有」的码只有注释级说明，没有机器可查的
完备性保证。本轮把对齐做满：

1. Rust 码有了具名、稳定、可枚举的导出点；
2. JS 侧对 Rust 全部码做**二分归类**（复刻 or 显式声明不复刻），漏归类即红；
3. 两处实现级阈值语义drift被找出并抹平；
4. 边界 fixture 与单测扩容锁住上述语义。

## 改动清单

### 1. Rust：`anki_qa_lint::codes` 稳定常量导出（唯一的生产侧改动）

`src-tauri/src/anki_qa_lint.rs` 新增 `pub mod codes`：26 个
`pub const UPPER_SNAKE: &str = "snake_case"` 常量 + `codes::ALL` 枚举出口。
规则实现内部仍用字面量产出 code（保持 `anki_gold_set.rs` 既有源码扫描契约
测试不变，该文件本轮零改动），常量与字面量的等价由新增的三个测试锁定：

| 测试 | 锁定内容 |
|---|---|
| `codes_module_matches_emitted_literals` | `codes::ALL` == 规则实现实际产出的字面量集合（自扫描 `include_str!`） |
| `codes_module_matches_contract_list` | `codes::ALL` == `anki_gold_set::LINT_CONTRACT_CODES`（编译期引用，非正则） |
| `codes_module_all_is_exhaustive_and_unique` | `ALL` 无重复，且覆盖模块内声明的每个 `&str` 常量 |

不改任何规则行为、不改 `lint_card` 签名、不碰切卡管线。

### 2. JS：`cardLint.mjs` 三张分区表 + 两处语义对齐

新增 `RUST_ONLY_CODES`（12 个码，键名 = Rust 常量名，逐条注明不复刻原因：
tags/mcq/field_rule 依赖模板上下文、duplicate/near_duplicate 依赖跨卡
tracker 状态、mixed_language 属 Info 级低置信提示、legacy_flags_unparsed 属
merge_flags 内部机制）。硬性等式（由契约测试断言）：

```
RUST_ALIGNED_CODES ∪ RUST_ONLY_CODES == anki_qa_lint::codes::ALL   （无交集、无遗漏）
每个条目：JS 键名 == Rust 常量名 && JS 值 == Rust 常量值           （双重逐字节）
EVAL_ONLY_CODES ∩ codes::ALL == ∅
```

实现级对齐（本轮发现并抹平的两处 drift）：

| 位置 | 原 JS 行为 | Rust 语义 | 对齐后 |
|---|---|---|---|
| answer_leak 最小长度 | `normBack.length`（UTF-16 单元） | `b.chars().count()`（码点） | `[...normBack].length` |
| cloze 序号合法性 | `parseInt ≥ 1`（任意大数合法） | `digits.parse::<u32>()`（溢出即非法） | `1 ≤ n ≤ 4294967295` |

### 3. 契约测试升级：`lintContract.test.ts`

新增 `loadRustCodeConstants()` 解析 `codes` 模块（值约束
`[a-z][a-z0-9_]*` 天然排除 `_qa_flags`），断言从 4 项扩到 6 项：
常量↔契约↔产出三方相等、分区二分覆盖、键名+值双对齐、eval-only 不撞名、
snake_case 无重复（含 RUST_ONLY）、README 对照表全覆盖。

### 4. 回归扩容：+3 坏 +3 好 fixture（与 duplicate/near_duplicate/occlusion 无关）

| fixture | 边界 | 预期 |
|---|---|---|
| `cases/31-xxx-residue.txt` | 独立 token "xxx"（两侧非字母数字） | `xxx_residue` |
| `cases/32-empty-brackets.txt` | 空括号对（），书名号《》不误伤 | `empty_brackets` |
| `cases/33-cloze-index-overflow.txt` | 序号超 u32（本轮新对齐点），同卡合法挖空不受影响 | `cloze_bad_index` |
| `good/g09-short-back-answer-echo.txt` | front 字面含单字 back，归一化 1 码点 < 阈值 4 | 零命中 |
| `good/g10-xxx-inside-word.txt` | fooxxxbar 字母内嵌 xxx（与 31 成正反对） | 零命中 |
| `good/g11-front-at-length-limit.txt` | front 恰好 220 可见字符（阈值为严格大于） | 零命中 |

`evalHarness.test.ts` 同步：规模断言升到坏 ≥25 / 好 ≥9，必备类别加
`xxx_residue` / `empty_brackets`，并补 6 组 lint 边界单测
（u32 上下界 4294967295/4294967296、码点计数 4/3 码点、xxx token、
空括号、220/221 off-by-one）。

## 基线（manifest 固化，run-eval 实测）

| 集合 | cases | 段数 | parse_success_rate | error_card_rate | lint_flag_rate |
|---|---|---|---|---|---|
| bad | 33 | 39 | 82.1% | 17.9% | 50.0% |
| good | 11 | 13 | **100%** | **0%** | **0%（零误伤）** |

## 验证

```bash
npx vitest run tests/vitest/anki/eval/     # 3 files, 32 tests, 全绿
node scripts/anki-eval/run-eval.mjs        # 退出码 0，全部 PASS
cd src-tauri && cargo test --lib anki_qa_lint   # codes_module_* 三测试（Rust 侧）
```

## 刻意不做的事

- **不复刻 mixed_language**：规则本身单卡可算，但它是 Info 级低置信提示
  （合法中英术语混排如 g05 的 "SYN、SYN-ACK、ACK" 即触发），复刻会打破
  「good 对照集 0 误伤」的硬约束——这正是把它归入 `RUST_ONLY_CODES`
  并写明原因的价值。
- **不动 `anki_gold_set.rs`**：其源码扫描契约测试依赖字面量形态，
  规则实现保持字面量产出即可让它零改动继续生效。
- **不改生产切卡逻辑**：`streaming_anki_service.rs`、`chatanki_*` 全部零触碰。
