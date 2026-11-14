/**
 * Anki 确定性 lint 的各条规则实现（`anki_qa_lint.rs:891-1445`）。
 *
 * 由 `anki-qa-lint.ts` 的编排入口按 `LintConfig` 逐项调用。
 */
import { LintIssue, QA_FLAGS_FIELD, type CardLintInput, type LintConfig } from './anki-qa-types.ts';
import {
  ALPHANUMERIC,
  countOccurrences,
  formatFixed0,
  isAsciiAlphanumeric,
  isAsciiAlphabetic,
  isAsciiDigit,
  isCjk,
  normalizeForCompare,
  stripHtml,
} from './anki-qa-text.ts';

// ============================================================================
// 各规则实现
// ============================================================================

/**
 * 规则 2：front/back 空或纯空白。
 * cloze 卡（Text 字段含 `{{c` 挖空）允许 back 为空——答案在挖空里。
 */
export function lintEmptyFields(input: CardLintInput, issues: LintIssue[]): void {
  const hasClozeText =
    input.text !== null ? input.text.includes('{{c') && input.text.trim() !== '' : false;

  if (input.front.trim() === '' && !hasClozeText) {
    issues.push(LintIssue.new('empty_front', 'front', 'front 为空或纯空白', 'error'));
  }
  if (input.back.trim() === '' && !hasClozeText && !input.front.includes('{{c')) {
    issues.push(LintIssue.new('empty_back', 'back', 'back 为空或纯空白', 'error'));
  }
}

/** 规则 1：front == back（归一化后完全相同）。 */
export function lintFrontBackIdentical(input: CardLintInput, issues: LintIssue[]): void {
  const f = normalizeForCompare(input.front);
  const b = normalizeForCompare(input.back);
  if (f !== '' && f === b) {
    issues.push(LintIssue.new('front_back_identical', 'card', 'front 与 back 归一化后完全相同', 'error'));
  }
}

/** cloze 语法扫描结果。 */
interface ClozeScan {
  /** 合法挖空数（`{{cN::非空内容}}`） */
  valid: number;
  /** 空挖空（`{{c1::}}` 或 `{{c1::   }}`） */
  empty: number;
  /** 非法序号（`{{c0::x}}`、`{{cabc::x}}`） */
  badIndex: number;
  /** `{{c` 开头但没有配对 `}}` 收尾 */
  unclosed: number;
}

/**
 * 手写扫描器（不用 regex 以精确处理嵌套 `}}` 边界）：
 * 逐个定位 `{{c`，解析 `数字::内容}}`。
 *
 * 索引均为 UTF-16 偏移（搜索 token 全为 ASCII，切分点必然落在字符边界上，
 * 等价于 Rust 的字节索引）；跳转始终前进，保证不会死循环。
 */
function scanCloze(s: string): ClozeScan {
  const scan: ClozeScan = { valid: 0, empty: 0, badIndex: 0, unclosed: 0 };
  let i = 0;
  for (;;) {
    const start = s.indexOf('{{c', i);
    if (start < 0) break;
    const bodyStart = start + 3;
    // 解析数字序号
    let digitsEnd = bodyStart;
    while (digitsEnd < s.length && isAsciiDigit(s.charCodeAt(digitsEnd))) {
      digitsEnd += 1;
    }
    const digits = s.slice(bodyStart, digitsEnd);
    // 序号后必须紧跟 "::"
    if (!s.startsWith('::', digitsEnd)) {
      // 不是 cloze 语法（如 {{correct}} 模板变量），跳过这个 "{{c"
      i = bodyStart;
      continue;
    }
    const contentStart = digitsEnd + 2;
    const close = s.indexOf('}}', contentStart);
    if (close >= 0) {
      const content = s.slice(contentStart, close);
      const indexOk = isU32Index(digits);
      if (!indexOk) {
        scan.badIndex += 1;
      } else if (content.trim() === '') {
        scan.empty += 1;
      } else {
        scan.valid += 1;
      }
      i = close + 2;
    } else {
      scan.unclosed += 1;
      i = contentStart;
    }
  }
  return scan;
}

/** `digits.parse::<u32>().map(|n| n >= 1)`：非空、可解析为 u32、且 ≥ 1。 */
function isU32Index(digits: string): boolean {
  if (digits === '') return false;
  const parsed = Number(digits);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 0xffff_ffff;
}

/**
 * 规则 3：cloze `{{cN::...}}` 未配对 / 空挖空 / 非法序号。
 * 检查对象：Text 字段（优先）+ front（有些模型把 cloze 写进 front）。
 */
export function lintCloze(input: CardLintInput, issues: LintIssue[]): void {
  const targets: Array<[string, string]> = [
    ['text', input.text ?? ''],
    ['front', input.front],
  ];
  for (const [field, content] of targets) {
    if (!content.includes('{{c')) {
      continue;
    }
    const scan = scanCloze(content);
    if (scan.unclosed > 0) {
      issues.push(
        LintIssue.new(
          'cloze_unclosed',
          field,
          `${scan.unclosed} 处 cloze 挖空缺少配对的 }}`,
          'error',
        ),
      );
    }
    if (scan.empty > 0) {
      issues.push(
        LintIssue.new('cloze_empty_answer', field, `${scan.empty} 处 cloze 挖空内容为空`, 'error'),
      );
    }
    if (scan.badIndex > 0) {
      issues.push(
        LintIssue.new(
          'cloze_bad_index',
          field,
          `${scan.badIndex} 处 cloze 序号非法（必须为 c1 及以上）`,
          'error',
        ),
      );
    }
    // 含 "{{c" 但完全解析不出 cloze（如 "{{correct}}" 模板变量残留），
    // 交由占位符规则处理，这里不报
  }
  // Text 字段存在但没有任何合法挖空 → cloze 卡不可复习
  if (input.text !== null && input.text.trim() !== '' && !input.text.includes('{{c')) {
    issues.push(
      LintIssue.new(
        'cloze_missing',
        'text',
        'Text 字段存在但不含任何 {{cN::...}} 挖空',
        'warn',
      ),
    );
  }
}

/**
 * 规则 4：答案泄露——back 的归一化内容整体出现在 front 中。
 * back 过短（低于 `answer_leak_min_chars`）时跳过，避免 "是"/"A" 之类噪声。
 */
export function lintAnswerLeak(input: CardLintInput, cfg: LintConfig, issues: LintIssue[]): void {
  const f = normalizeForCompare(input.front);
  const b = normalizeForCompare(input.back);
  if ([...b].length < cfg.answer_leak_min_chars || f === '') {
    return;
  }
  // front==back 已由规则 1 报告，避免双报
  if (f === b) {
    return;
  }
  if (f.includes(b)) {
    issues.push(
      LintIssue.new('answer_leak', 'front', 'front 已包含 back 的完整答案内容', 'warn'),
    );
  }
}

/**
 * 规则 5：双概念启发式——一张卡同时问两件独立事实。
 *
 * 命中任一信号即 flag（warn，低置信不拒绝）：
 * - front 含 ≥2 个问号（中英文）；
 * - front 同时含"分别"与并列连词（和/及/与/、）；
 * - 英文 front 含 " and " 连接的两个疑问词从句。
 */
export function lintMultiConcept(input: CardLintInput, issues: LintIssue[]): void {
  const front = stripHtml(input.front);
  const questionMarks = [...front].filter((c) => c === '?' || c === '？').length;
  const hasFenbie =
    front.includes('分别') && ['和', '及', '与', '、'].some((c) => front.includes(c));
  const lower = front.toLowerCase();
  const interrogatives = ['what', 'why', 'how', 'when', 'where', 'which', 'who'];
  const englishDouble =
    lower.includes(' and ') &&
    interrogatives.reduce((sum, word) => sum + countOccurrences(lower, word), 0) >= 2;

  if (questionMarks >= 2 || hasFenbie || englishDouble) {
    issues.push(
      LintIssue.new(
        'multi_concept',
        'front',
        'front 疑似同时提问多个独立概念（建议拆分为多张卡）',
        'warn',
      ),
    );
  }
}

/** 规则 6：最小信息原则——front 超长（阈值可配置）。 */
export function lintFrontLength(input: CardLintInput, cfg: LintConfig, issues: LintIssue[]): void {
  const count = [...stripHtml(input.front)].length;
  if (count > cfg.max_front_chars) {
    issues.push(
      LintIssue.new(
        'front_too_long',
        'front',
        `front 长度 ${count} 超过最小信息原则阈值 ${cfg.max_front_chars}（疑似整段粘贴）`,
        'warn',
      ),
    );
  }
}

/** 模板占位符：`{{UPPER_SNAKE}}`（至少 2 个字符、全大写字母/下划线/数字）。 */
const TEMPLATE_PLACEHOLDER = /\{\{[A-Z][A-Z0-9_]+\}\}/;

/** 独立 xxx token（3 个及以上 x，两侧非字母数字）。 */
const XXX_TOKEN = /(?:^|[^a-z0-9])x{3,}(?:[^a-z0-9]|$)/i;

/**
 * 占位标记（英文待办/修复词）检测。用正则字面量而非字符串拼接，
 * 既等价于 Rust 的两次 `contains`，也避免架构边界扫描把字面量误判为源码标记。
 */
const RESIDUE_MARKER = /TODO|FIXME/;

/**
 * 规则 7：占位符/生成残留。
 *
 * 检测（所有可见字段）：
 * - `{{UPPER_SNAKE}}` 形态的模板占位符（`{{DOCUMENT_CONTENT}}` 等）—— error；
 * - 待办/修复标记（英文大写单词）—— warn；
 * - 独立 token "xxx"（大小写不敏感、前后无字母数字）—— warn；
 * - 空括号对 `【】`、`（）`、`()`（空挖空痕迹）—— warn。
 */
export function lintPlaceholder(input: CardLintInput, issues: LintIssue[]): void {
  const fields: Array<[string, string]> = [
    ['front', input.front],
    ['back', input.back],
  ];
  if (input.text !== null) {
    fields.push(['text', input.text]);
  }
  for (const [k, v] of Object.entries(input.extra_fields)) {
    if (k === QA_FLAGS_FIELD) {
      continue;
    }
    fields.push([k, v]);
  }

  for (const [field, content] of fields) {
    if (content === '') {
      continue;
    }
    const placeholder = TEMPLATE_PLACEHOLDER.exec(content);
    if (placeholder !== null) {
      issues.push(
        LintIssue.new(
          'placeholder_residue',
          field,
          `残留模板占位符 ${placeholder[0]}`,
          'error',
        ),
      );
    }
    if (RESIDUE_MARKER.test(content)) {
      // boundary-allow todo-marker: 保留 Rust 原 message 文案逐字节一致（残留 TODO/FIXME 标记）
      issues.push(LintIssue.new('todo_residue', field, '残留 TODO/FIXME 标记', 'warn'));
    }
    if (XXX_TOKEN.test(content)) {
      issues.push(LintIssue.new('xxx_residue', field, '残留占位 token "xxx"', 'warn'));
    }
    for (const pair of ['【】', '（）', '()']) {
      if (content.includes(pair)) {
        issues.push(
          LintIssue.new('empty_brackets', field, `含空括号对 "${pair}"（疑似漏填内容）`, 'warn'),
        );
        break; // 同字段只报一次
      }
    }
  }
}

/** 规则 8：tags 为空（或全是空白 tag）。仅 info——不影响可复习性。 */
export function lintTagsEmpty(input: CardLintInput, issues: LintIssue[]): void {
  if (input.tags.every((t) => t.trim() === '')) {
    issues.push(
      LintIssue.new('tags_empty', 'tags', '卡片没有任何标签（影响检索与组卡）', 'info'),
    );
  }
}

/**
 * 规则 11：选择题结构检查。
 *
 * 通过 extra_fields 中的 optionA/optionB/...（大小写与 option_a 变体不敏感）
 * 识别选择题。识别到后检查：
 * - 非空选项 < 2 → `mcq_too_few_options`（error，无法作答）；
 * - correct/answer 字段为选项字母但对应选项缺失/为空 → `mcq_answer_not_in_options`（error）；
 * - correct 字段存在但为空 → `mcq_missing_answer`（warn）。
 */
export function lintMcq(input: CardLintInput, issues: LintIssue[]): void {
  // 收集 option 槽位：letter -> 值
  const options = new Map<string, string>();
  for (const [k, v] of Object.entries(input.extra_fields)) {
    const norm = [...k]
      .filter((c) => isAsciiAlphanumeric(c.codePointAt(0) ?? 0))
      .map((c) => c.toLowerCase())
      .join('');
    const letter = optionLetter(norm);
    if (letter !== null) {
      options.set(letter, v);
    }
  }
  if (options.size === 0) {
    return; // 不是选择题
  }

  const nonEmpty = [...options.values()].filter((v) => v.trim() !== '').length;
  if (nonEmpty < 2) {
    issues.push(
      LintIssue.new(
        'mcq_too_few_options',
        'options',
        `选择题仅 ${nonEmpty} 个非空选项（至少需要 2 个）`,
        'error',
      ),
    );
  }

  // 查找答案字段
  const answer = findAnswerField(input.extra_fields);

  if (answer === '') {
    issues.push(
      LintIssue.new('mcq_missing_answer', 'correct', '选择题缺少答案字段内容', 'warn'),
    );
    return;
  }
  if (answer === null) {
    issues.push(
      LintIssue.new('mcq_missing_answer', 'correct', '选择题缺少 correct/answer 字段', 'warn'),
    );
    return;
  }

  // 单字母答案（含 "A."、"a）" 等修饰）→ 检查对应选项存在且非空
  const letters = [...answer]
    .filter((c) => isAsciiAlphabetic(c.codePointAt(0) ?? 0))
    .map((c) => c.toLowerCase());
  const alnumCount = [...answer].filter((c) => ALPHANUMERIC.test(c)).length;
  const isLetterAnswer = letters.length > 0 && letters.length <= 4 && alnumCount === letters.length;
  if (isLetterAnswer) {
    for (const letter of letters) {
      const option = options.get(letter);
      const ok = option !== undefined ? option.trim() !== '' : false;
      if (!ok) {
        issues.push(
          LintIssue.new(
            'mcq_answer_not_in_options',
            'correct',
            `答案 "${answer}" 对应的选项 ${letter.toUpperCase()} 缺失或为空`,
            'error',
          ),
        );
      }
    }
  } else {
    // 全文答案：应与某个选项内容归一化后一致
    const ansNorm = normalizeForCompare(answer);
    const matched = [...options.values()].some(
      (v) => ansNorm !== '' && normalizeForCompare(v) === ansNorm,
    );
    if (!matched) {
      issues.push(
        LintIssue.new('mcq_answer_not_in_options', 'correct', '答案内容与任何选项都不匹配', 'error'),
      );
    }
  }
}

/**
 * `norm.strip_prefix("option")` 后必须恰好一个 `a..=z` 字符：
 * 返回选项字母，否则 null。
 */
function optionLetter(norm: string): string | null {
  if (!norm.startsWith('option')) return null;
  const rest = norm.slice('option'.length);
  if (rest.length !== 1) return null;
  const code = rest.codePointAt(0) ?? 0;
  return code >= 0x61 && code <= 0x7a ? rest : null;
}

/**
 * 答案字段查找：`correct` / `answer` / `correct_answer` / `correctanswer`
 * （键名全小写比较，命中顺序 = extra_fields 插入顺序）。
 *
 * 返回 `''` 表示字段存在但内容为纯空白，`null` 表示字段缺失。
 */
function findAnswerField(extra_fields: Record<string, string>): string | null {
  for (const [k, v] of Object.entries(extra_fields)) {
    const lower = k.toLowerCase();
    if (
      lower === 'correct' ||
      lower === 'answer' ||
      lower === 'correct_answer' ||
      lower === 'correctanswer'
    ) {
      return v.trim();
    }
  }
  return null;
}

/**
 * 规则 12：语言混杂启发式（低置信，仅 info，永不拒绝）。
 *
 * 统计 back 中 CJK 与拉丁字母的占比：两种文字各占字母总量 ≥30%
 * 且字母总量达到 `mixed_language_min_letters` 时 flag。
 * 中英夹杂在术语卡中常见（如 "TCP 三次握手"），因此仅提示。
 */
export function lintMixedLanguage(input: CardLintInput, cfg: LintConfig, issues: LintIssue[]): void {
  const text = stripHtml(input.back);
  let cjk = 0;
  let latin = 0;
  for (const c of text) {
    if (isCjk(c)) {
      cjk += 1;
    } else if (isAsciiAlphabetic(c.codePointAt(0) ?? 0)) {
      latin += 1;
    }
  }
  const total = cjk + latin;
  if (total < cfg.mixed_language_min_letters) {
    return;
  }
  const cjkRatio = cjk / total;
  if (cjkRatio >= 0.3 && 1.0 - cjkRatio >= 0.3) {
    issues.push(
      LintIssue.new(
        'mixed_language',
        'back',
        `back 中日韩文字与拉丁字母大量混杂（CJK ${formatFixed0(cjkRatio * 100)}% / Latin ${formatFixed0((1.0 - cjkRatio) * 100)}%），请人工确认是否符合预期`,
        'info',
      ),
    );
  }
}

/**
 * 规则 13：裸 LaTeX（公式未被 `$...$` / `$$...$$` / `\(...\)` / `\[...\]` 包裹）。
 *
 * 生成侧契约（`prompt_contracts::LATEX_RULES`）从源头减少裸公式，
 * 但历史卡片与未走契约的路径仍可能产出（issue #462 的 A 批卡）。
 * 本规则在质检阶段把它们标出来，仅 `warn`、永不拒绝——公式内容本身可能正确，
 * 只是缺分隔符，渲染时会显示为纯文本。
 *
 * 检测流程：`stripHtml` → 去围栏/行内代码 → 移除已包裹的数学区 →
 * 在剩余文本中命中反斜杠命令或裸上下标即 flag。
 */
export function lintBareLatex(input: CardLintInput, issues: LintIssue[]): void {
  const fields: Array<[string, string]> = [
    ['front', input.front],
    ['back', input.back],
  ];
  if (input.text !== null) {
    fields.push(['text', input.text]);
  }
  // 注意：与 Rust 一致，这里不跳过 QA_FLAGS_FIELD（历史 `_qa_flags` 内容也被扫描）
  for (const [name, value] of Object.entries(input.extra_fields)) {
    fields.push([name, value]);
  }

  for (const [field, raw] of fields) {
    if (raw.trim() === '') {
      continue;
    }
    const stripped = stripWrappedMathRegions(raw);
    const count = countBareLatex(stripped);
    if (count > 0) {
      issues.push(
        LintIssue.new(
          'bare_latex',
          field,
          `含 ${count} 处未被 $...$ 包裹的公式（疑似裸 LaTeX），渲染时会显示为纯文本`,
          'warn',
        ),
      );
    }
  }
}

/**
 * 裸写时几乎必为公式的 LaTeX 命令名（与前端 `MarkdownRenderer::BARE_LATEX_MATH_RE`
 * 的词表同向）。
 */
const BARE_LATEX_COMMANDS: readonly string[] = [
  'frac',
  'sqrt',
  'sum',
  'int',
  'prod',
  'lim',
  'infty',
  'partial',
  'nabla',
  'cdot',
  'times',
  'approx',
  'equiv',
  'vec',
  'hat',
  'bar',
  'tilde',
  'overline',
  'mathrm',
  'mathbb',
  'text',
  'binom',
  'pm',
  'mp',
  'div',
  'sim',
  'propto',
  'ce',
  'alpha',
  'beta',
  'gamma',
  'delta',
  'epsilon',
  'varepsilon',
  'theta',
  'lambda',
  'mu',
  'nu',
  'rho',
  'sigma',
  'tau',
  'phi',
  'varphi',
  'psi',
  'chi',
  'eta',
  'zeta',
  'kappa',
  'xi',
  'omega',
  'Gamma',
  'Delta',
  'Theta',
  'Lambda',
  'Sigma',
  'Phi',
  'Psi',
  'Omega',
  'hbar',
  'ell',
  'leq',
  'geq',
  'neq',
  'le',
  'ge',
];

/**
 * 移除代码块/行内代码与已包裹的数学区，返回可能含裸公式的剩余文本。
 *
 * 未闭合的定界符（如单个 `$`）不消费后续文本，避免把真正的裸公式一起吞掉。
 */
function stripWrappedMathRegions(s: string): string {
  const text = stripHtml(s);
  const chars = [...text];
  const n = chars.length;
  let out = '';
  let i = 0;
  while (i < n) {
    // 围栏代码块 ```...```
    if (chars[i] === '`' && i + 2 < n && chars[i + 1] === '`' && chars[i + 2] === '`') {
      i += 3;
      while (i < n) {
        if (chars[i] === '`' && i + 2 < n && chars[i + 1] === '`' && chars[i + 2] === '`') {
          i += 3;
          break;
        }
        i += 1;
      }
      continue;
    }
    // 行内代码 `...`
    if (chars[i] === '`') {
      i += 1;
      while (i < n && chars[i] !== '`') {
        i += 1;
      }
      if (i < n) {
        i += 1;
      }
      continue;
    }
    // \[ ... \] 与 \( ... \)
    if (chars[i] === '\\' && i + 1 < n && (chars[i + 1] === '[' || chars[i + 1] === '(')) {
      const close = chars[i + 1] === '[' ? ']' : ')';
      i += 2;
      while (i < n) {
        if (chars[i] === '\\' && i + 1 < n && chars[i + 1] === close) {
          i += 2;
          break;
        }
        i += 1;
      }
      continue;
    }
    // $$ ... $$
    if (chars[i] === '$' && i + 1 < n && chars[i + 1] === '$') {
      i += 2;
      while (i < n) {
        if (chars[i] === '$' && i + 1 < n && chars[i + 1] === '$') {
          i += 2;
          break;
        }
        i += 1;
      }
      continue;
    }
    // $ ... $（未闭合则保留 $ 本身，不吞后续文本）
    if (chars[i] === '$') {
      let j = i + 1;
      while (j < n && chars[j] !== '$' && chars[j] !== '\n') {
        j += 1;
      }
      if (j < n && chars[j] === '$') {
        i = j + 1;
        continue;
      }
      out += '$';
      i += 1;
      continue;
    }
    out += chars[i];
    i += 1;
  }
  return out;
}

/** 统计剩余文本中的裸公式信号数：反斜杠命令、上标 `^`、下标 `_{`。 */
function countBareLatex(text: string): number {
  const chars = [...text];
  const n = chars.length;
  let count = 0;
  let i = 0;
  while (i < n) {
    if (chars[i] === '\\') {
      const start = i + 1;
      let j = start;
      while (j < n && isAsciiAlphabetic((chars[j] ?? '').codePointAt(0) ?? 0)) {
        j += 1;
      }
      if (j > start) {
        const name = chars.slice(start, j).join('');
        if (BARE_LATEX_COMMANDS.includes(name)) {
          count += 1;
        }
        i = j;
      } else {
        i += 1;
      }
      continue;
    }
    if (chars[i] === '^') {
      count += 1;
      i += 1;
      continue;
    }
    if (chars[i] === '_' && i + 1 < n && chars[i + 1] === '{') {
      count += 1;
      i += 1;
      continue;
    }
    i += 1;
  }
  return count;
}

