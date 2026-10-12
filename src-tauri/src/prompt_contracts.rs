//! 跨链路共享的 LLM 输出契约常量（单一来源，避免各模块各写一份后漂移）。
//!
//! 现状背景：数学公式契约原本只在 `chat_v2::prompt_builder` 内私有，
//! 制卡 / 出题 / 批改 / 结构化 / OCR 等链路要么没有、要么各写一份措辞不一的
//! 规则，导致同一应用内产出质量不一致（见 issue #462）。本模块把契约收敛到
//! 一处，任何需要约束公式输出的链路都从这里引用。
//!
//! 修改本文件中的常量会同时影响所有引用方；`chat_v2::prompt_builder` 侧有
//! 字符预算与结构测试兜底，新增引用方需各自补「prompt 含该契约」的测试。

/// LaTeX 输出规则（XML 格式），`priority="highest"`。
///
/// 规则要点：`$...$` / `$$...$$` 成对包裹、禁止裸露 LaTeX、禁用代码块包裹、
/// 禁用 `\(...\)` / `\[...\]`、仅用 KaTeX 支持的命令、`\boxed{}` 需包裹。
pub const LATEX_RULES: &str = r#"<latex_rules version="1" priority="highest">
<description>数学公式输出规范，必须严格遵守</description>
<rules>
1. 任何数学表达式必须使用 $...$ (行内) 或 $$...$$ (块级) 包裹，分隔符必须成对闭合。
2. 禁止裸露 LaTeX：不得出现未被 $ 或 $$ 包裹的 \frac、\sqrt、\int、\sum、\lim、上下标 ^/_ 等。
3. 严禁用任何形式的 Markdown 代码块（三反引号）包裹数学内容，包括 ```math、```latex 等，全部改用 $/$$ 直接输出。
4. 禁止使用 \(...\) 与 \[...\] 作为分隔符。
5. 多行/展示型公式须使用 $$ 并独立成段，起止各占一行；行内使用单 $ 且不跨段落。
6. 仅使用 KaTeX 支持的命令；多字符上下标需加花括号；中文/非 ASCII 请置于 \text{...}；矩阵使用 bmatrix 环境。
7. \boxed{} 命令必须用 $...$ 包裹：正确格式为 $\boxed{C}$，禁止使用 [\boxed{C}] 等未包裹格式。
</rules>
<examples type="correct">
- 行内：$\lim_{x\to 0}\frac{\sin(ax)-\sin(bx)}{x}=a-b$
- 块级：
$$
\int_0^1 x^2\,\mathrm{d}x = \tfrac{1}{3}
$$
</examples>
<examples type="incorrect">
- \lim_{x\to 0} \frac{\sin x}{x} （未包裹）
- \( \int_a^b f(x)\,\mathrm{d}x \) （错误分隔符）
- ```math ... ``` （代码块包裹，禁止！）
</examples>
<self_check>
发送前自检：若检测到数学符号未在 $ 或 $$ 内，请重写并补齐分隔符后再发送。
</self_check>
</latex_rules>"#;

/// 结构化 / 字段 / OCR 类链路的公式输出要求（中文一句话版）。
///
/// 这些链路的产出是 JSON 字段或纯文本抽取结果，放不下完整 `LATEX_RULES`；
/// 本常量给出与之一致的核心约束，作为各模块的单一来源，避免措辞漂移。
pub const LATEX_OUTPUT_BRIEF: &str = "数学/化学公式必须用 LaTeX 书写并以 $...$（行内）或 $$...$$（块级）包裹，分隔符成对闭合；禁止裸写公式（如 10^5、\\frac），禁止使用 \\(...\\) 或 \\[...\\]，禁止用代码块包裹公式。";

/// 同 [`LATEX_OUTPUT_BRIEF`] 的英文版（用于面向英文模型的 OCR 抽取提示）。
pub const LATEX_OUTPUT_BRIEF_EN: &str = "Write every math/chemistry formula in LaTeX wrapped in $...$ (inline) or $$...$$ (block) with paired delimiters; never output bare LaTeX (e.g. 10^5, \\frac), never use \\(...\\) or \\[...\\], and never wrap formulas in code fences.";

#[cfg(test)]
mod tests {
    use super::{LATEX_OUTPUT_BRIEF, LATEX_OUTPUT_BRIEF_EN, LATEX_RULES};

    /// 契约的核心约束必须在场，防止未来编辑误删关键规则。
    #[test]
    fn latex_rules_contains_core_constraints() {
        assert!(LATEX_RULES.contains("禁止裸露 LaTeX"));
        assert!(LATEX_RULES.contains("priority=\"highest\""));
        assert!(LATEX_RULES.contains("\\boxed{} 命令必须用 $...$ 包裹"));
        assert!(LATEX_RULES.contains("禁止使用 \\(...\\) 与 \\[...\\]"));
    }

    /// 一句话版必须与完整版同向：都要求 $...$ 包裹、都禁止裸写。
    #[test]
    fn latex_output_brief_is_consistent_with_full_rules() {
        assert!(LATEX_OUTPUT_BRIEF.contains("$...$"));
        assert!(LATEX_OUTPUT_BRIEF.contains("禁止裸写"));
        assert!(LATEX_OUTPUT_BRIEF_EN.contains("$...$"));
        assert!(LATEX_OUTPUT_BRIEF_EN.contains("bare LaTeX"));
    }
}
