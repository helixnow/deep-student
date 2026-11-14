/**
 * 学术论文阅读导航内核：
 * 1. 跨页跳转历史栈（ReadingJumpHistory）——支持点击目录 / 内部引用 / 搜索跳页后一键「返回原处」（Alt+← / Alt+→）
 * 2. 文内引用智能识别与目标页定位（`[12]`、` Vaswani et al. (2017)`、`Fig. 3`、`Table 2`、`Eq. (4)`、`Algorithm 1`、`Appendix B`）
 */

export interface JumpHistoryEntry {
  page: number;
  label?: string;
}

export interface ReadingJumpHistoryState {
  backStack: JumpHistoryEntry[];
  forwardStack: JumpHistoryEntry[];
}

export const EMPTY_JUMP_HISTORY: ReadingJumpHistoryState = {
  backStack: [],
  forwardStack: [],
};

const MAX_JUMP_HISTORY_DEPTH = 30;

export interface RecordJumpOptions {
  /** 跳转来源标签（可选，用于提示） */
  label?: string;
  /** 显式引用/目录跳转：即使相邻页（|to - from| === 1）也压栈 */
  force?: boolean;
  /** 非强制跳转时的最小页码跨度（单页默认 2，双页 spread 默认 3） */
  minDelta?: number;
}

/**
 * 记录一次跨页跳转。默认仅在跨越至少 minDelta（默认 2）页时记录，避免正常逐页翻阅污染「返回原处」栈；
 * 点击 PDF 内部链接、目录、书签、批注或图表定位时可传 `force: true`。
 */
export function recordReadingJump(
  state: ReadingJumpHistoryState,
  fromPage: number,
  toPage: number,
  options?: RecordJumpOptions,
): ReadingJumpHistoryState {
  if (
    !Number.isInteger(fromPage) ||
    !Number.isInteger(toPage) ||
    fromPage < 1 ||
    toPage < 1 ||
    fromPage === toPage
  ) {
    return state;
  }

  const minDelta = options?.minDelta ?? 2;
  if (!options?.force && Math.abs(toPage - fromPage) < minDelta) {
    return state;
  }

  const last = state.backStack[state.backStack.length - 1];
  const nextBack =
    last && last.page === fromPage
      ? [...state.backStack.slice(0, -1), { page: fromPage, label: options?.label ?? last.label }]
      : [...state.backStack, { page: fromPage, label: options?.label }];

  const trimmedBack =
    nextBack.length > MAX_JUMP_HISTORY_DEPTH
      ? nextBack.slice(nextBack.length - MAX_JUMP_HISTORY_DEPTH)
      : nextBack;

  return {
    backStack: trimmedBack,
    forwardStack: [],
  };
}

/**
 * 后退到跳转前的页面，并将当前页推入前进栈。
 */
export function navigateJumpBack(
  state: ReadingJumpHistoryState,
  currentPage: number,
): { targetPage: number | null; nextState: ReadingJumpHistoryState } {
  if (state.backStack.length === 0) {
    return { targetPage: null, nextState: state };
  }
  const nextBack = state.backStack.slice(0, -1);
  const target = state.backStack[state.backStack.length - 1]!;
  if (target.page === currentPage) {
    return navigateJumpBack({ backStack: nextBack, forwardStack: state.forwardStack }, currentPage);
  }
  const nextForward =
    Number.isInteger(currentPage) && currentPage >= 1
      ? [...state.forwardStack, { page: currentPage, label: target.label }].slice(-MAX_JUMP_HISTORY_DEPTH)
      : state.forwardStack;
  return {
    targetPage: target.page,
    nextState: {
      backStack: nextBack,
      forwardStack: nextForward,
    },
  };
}

export function peekJumpBackEntry(state: ReadingJumpHistoryState): JumpHistoryEntry | null {
  return state.backStack[state.backStack.length - 1] ?? null;
}

export function peekJumpForwardEntry(state: ReadingJumpHistoryState): JumpHistoryEntry | null {
  return state.forwardStack[state.forwardStack.length - 1] ?? null;
}

/**
 * 前进到返回前的目标页面。
 */
export function navigateJumpForward(
  state: ReadingJumpHistoryState,
  currentPage: number,
): { targetPage: number | null; nextState: ReadingJumpHistoryState } {
  if (state.forwardStack.length === 0) {
    return { targetPage: null, nextState: state };
  }
  const nextForward = state.forwardStack.slice(0, -1);
  const target = state.forwardStack[state.forwardStack.length - 1]!;
  if (target.page === currentPage) {
    return navigateJumpForward({ backStack: state.backStack, forwardStack: nextForward }, currentPage);
  }
  const nextBack =
    Number.isInteger(currentPage) && currentPage >= 1
      ? [...state.backStack, { page: currentPage, label: target.label }].slice(-MAX_JUMP_HISTORY_DEPTH)
      : state.backStack;
  return {
    targetPage: target.page,
    nextState: {
      backStack: nextBack,
      forwardStack: nextForward,
    },
  };
}

// ============================================================================
// 文内学术引用识别与页面定位（无超链接 PDF / 扫描 OCR PDF 同样可用）
// ============================================================================

export type AcademicReferenceKind =
  | 'citation'
  | 'figure'
  | 'table'
  | 'equation'
  | 'algorithm'
  | 'theorem'
  | 'appendix'
  | 'section';

export interface DetectedAcademicReference {
  kind: AcademicReferenceKind;
  /** 主标识符（如 `'12'`, `'3'`, `'B'`, `'Vaswani:2017'`） */
  id: string;
  /** 用于紧凑按钮展示的短标签（如 `'[12]'`, `'Fig. 3'`, `'Table 2'`） */
  displayLabel: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 从用户划选的短文本中识别论文内引用：
 * - 数字文献引用：`[12]`, `[3, 12]`, `[4–7]`
 * - 作者年份引用：`(Vaswani et al., 2017)`, `Vaswani et al. (2017)`, `(He et al., 2016a)`
 * - 图表公式算法定理章节附录：`Fig. 3`, `Figure 4(a)`, `Table 2`, `Eq. (5)`, `Algorithm 1`, `Theorem 2.1`, `Appendix B`, `Section 3.2`
 */
export function detectAcademicReference(rawSelection: string): DetectedAcademicReference | null {
  const cleaned = rawSelection.replace(/\s+/g, ' ').trim();
  if (!cleaned || cleaned.length > 56) return null;

  // 1. 方括号数字文献引用：`[12]`, `[12].`, `[12, 15]`, `[3-5]`
  const bracketCite = /^\[(\d{1,4})(?:\s*[,;–-]\s*\d{1,4})*\][.,;:)]?$/.exec(cleaned);
  if (bracketCite) {
    const id = bracketCite[1]!;
    return { kind: 'citation', id, displayLabel: `[${id}]` };
  }

  // 2. 图（Figure / Fig. / 图）
  const figMatch = /^(?:Figures?|Figs?\.?|图)\s*(\d{1,3}(?:\.\d{1,2})?)(?:\s*\(?[a-zA-Z]\)?)?[.,;:)]?$/i.exec(
    cleaned,
  );
  if (figMatch) {
    const id = figMatch[1]!;
    return { kind: 'figure', id, displayLabel: `Fig. ${id}` };
  }

  // 3. 表（Table / Tab. / 表）
  const tableMatch = /^(?:Tables?|Tabs?\.?|表)\s*([IVX]+|\d{1,3}(?:\.\d{1,2})?)[.,;:)]?$/i.exec(cleaned);
  if (tableMatch) {
    const id = tableMatch[1]!;
    return { kind: 'table', id, displayLabel: `Table ${id}` };
  }

  // 4. 公式（Eq. (4) / Equation 4 / 公式 4 / 式 (4)）
  const eqMatch = /^(?:Equations?|Eqs?\.?|公式|式)\s*\(?(\d{1,3}(?:\.\d{1,2})?)\)?[.,;:)]?$/i.exec(cleaned);
  if (eqMatch) {
    const id = eqMatch[1]!;
    return { kind: 'equation', id, displayLabel: `Eq. (${id})` };
  }

  // 5. 算法（Algorithm 1 / Alg. 2 / 算法 1）
  const algMatch = /^(?:Algorithms?|Algs?\.?|算法)\s*(\d{1,3})[.,;:)]?$/i.exec(cleaned);
  if (algMatch) {
    const id = algMatch[1]!;
    return { kind: 'algorithm', id, displayLabel: `Alg. ${id}` };
  }

  // 6. 定理 / 引理 / 命题 / 推论
  const thmMatch =
    /^(?:Theorems?|Thm\.?|Lemmas?|Propositions?|Prop\.?|Corollary|Cor\.?|定理|引理|命题|推论)\s*(\d{1,3}(?:\.\d{1,2})?)[.,;:)]?$/i.exec(
      cleaned,
    );
  if (thmMatch) {
    const id = thmMatch[1]!;
    return { kind: 'theorem', id, displayLabel: `Thm. ${id}` };
  }

  // 7. 附录（Appendix A / 附录 B）
  const appMatch = /^(?:Appendix|App\.?|附录)\s*([A-Z]|\d{1,2})(?:\.\d{1,2})?[.,;:)]?$/i.exec(cleaned);
  if (appMatch) {
    const id = appMatch[1]!.toUpperCase();
    return { kind: 'appendix', id, displayLabel: `Appendix ${id}` };
  }

  // 8. 章节（Section 3.2 / Sec. 4 / §3.2 / 第 3 节）
  const secMatch = /^(?:Sections?|Secs?\.?|§|第)\s*(\d{1,2}(?:\.\d{1,2}){0,2})\s*(?:节|章)?[.,;:)]?$/i.exec(
    cleaned,
  );
  if (secMatch) {
    const id = secMatch[1]!;
    return { kind: 'section', id, displayLabel: `Sec. ${id}` };
  }

  // 9. 作者-年份文献引用：`(Vaswani et al., 2017)` 或 `Vaswani et al. (2017)`
  const authorYearParen =
    /^\(?([A-Z][a-zA-Z'-]{1,24})(?:\s+(?:et\s+al\.?|and\s+[A-Z][a-zA-Z'-]{1,24}|&\s+[A-Z][a-zA-Z'-]{1,24}))?[, ]+\(?((?:19|20)\d{2}[a-z]?)\)?\)?[.,;:]?$/.exec(
      cleaned,
    );
  if (authorYearParen) {
    const author = authorYearParen[1]!;
    const year = authorYearParen[2]!;
    return {
      kind: 'citation',
      id: `${author}:${year}`,
      displayLabel: `${author} ${year}`,
    };
  }

  return null;
}

const BIBLIOGRAPHY_HEADING_RE = /(?:^|\n|\b)(?:References|Bibliography|Works\s+Cited|参考文献)(?:\b|\s|\n)/i;

/**
 * 评估某页文本是否包含目标引用的「定义处 / 图注表注 / 参考文献条目」。
 * 返回匹配得分：0 = 未命中，1 = 弱命中，2 = 强定义命中，3 = 参考文献区精确条目命中。
 */
export function scorePageForAcademicReference(
  pageText: string,
  ref: DetectedAcademicReference,
  inBackMatterZone = false,
): number {
  if (!pageText) return 0;
  const escapedId = escapeRegExp(ref.id);

  switch (ref.kind) {
    case 'citation': {
      const hasBibHeading = BIBLIOGRAPHY_HEADING_RE.test(pageText);
      const bibBonus = hasBibHeading || inBackMatterZone ? 1 : 0;
      if (ref.id.includes(':')) {
        const [author, year] = ref.id.split(':');
        if (!author || !year) return 0;
        const authorRe = new RegExp(`\\b${escapeRegExp(author)}\\b`, 'i');
        const yearRe = new RegExp(`\\b${escapeRegExp(year)}\\b`);
        if (!authorRe.test(pageText) || !yearRe.test(pageText)) return 0;
        // 条目式特征：作者姓氏出现在句首或段首附近且同段出现年份
        const entryRe = new RegExp(
          `(?:^|\\n|\\[\\d+\\]\\s*)${escapeRegExp(author)}[^\\n]{0,140}\\b${escapeRegExp(year)}\\b`,
          'im',
        );
        if (entryRe.test(pageText)) return 2 + bibBonus;
        return bibBonus > 0 ? 2 : 0;
      }
      // 数字文献条目：`[12] Author...` 或行首 `12. Author...`
      const bracketEntryRe = new RegExp(`(?:^|\\n)\\s*\\[${escapedId}\\]\\s*[A-Z\\u4e00-\\u9fff“"']`, 'm');
      if (bracketEntryRe.test(pageText)) return 2 + bibBonus;
      const inlineBracketEntryRe = new RegExp(`\\[${escapedId}\\]\\s+[A-Z][a-zA-Z'-]+,\\s*[A-Z]`);
      if (inlineBracketEntryRe.test(pageText)) return 2 + bibBonus;
      const numberedEntryRe = new RegExp(`(?:^|\\n)\\s*${escapedId}\\.\\s+[A-Z\\u4e00-\\u9fff]`, 'm');
      if (numberedEntryRe.test(pageText) && bibBonus > 0) return 2 + bibBonus;
      return 0;
    }

    case 'figure': {
      const captionRe = new RegExp(
        `(?:^|\\n)\\s*(?:Figure|Fig\\.?|图)\\s*${escapedId}(?:\\s*[:.：—-]|\\s+[A-Z\\u4e00-\\u9fff])`,
        'im',
      );
      if (captionRe.test(pageText)) return 3;
      const inlineCaptionRe = new RegExp(`\\b(?:Figure|Fig\\.|图)\\s*${escapedId}\\s*[:.：]`, 'i');
      return inlineCaptionRe.test(pageText) ? 2 : 0;
    }

    case 'table': {
      const captionRe = new RegExp(
        `(?:^|\\n)\\s*(?:Table|Tab\\.?|表)\\s*${escapedId}(?:\\s*[:.：—-]|\\s+[A-Z\\u4e00-\\u9fff])`,
        'im',
      );
      if (captionRe.test(pageText)) return 3;
      const inlineCaptionRe = new RegExp(`\\b(?:Table|Tab\\.|表)\\s*${escapedId}\\s*[:.：]`, 'i');
      return inlineCaptionRe.test(pageText) ? 2 : 0;
    }

    case 'algorithm': {
      const captionRe = new RegExp(
        `(?:^|\\n)\\s*(?:Algorithm|Alg\\.?|算法)\\s*${escapedId}(?:\\s*[:.：—-]|\\s+[A-Z\\u4e00-\\u9fff])`,
        'im',
      );
      return captionRe.test(pageText) ? 3 : 0;
    }

    case 'theorem': {
      const defRe = new RegExp(
        `(?:^|\\n)\\s*(?:Theorem|Lemma|Proposition|Corollary|定理|引理|命题|推论)\\s*${escapedId}(?:\\b|\\s*[:.(（])`,
        'im',
      );
      return defRe.test(pageText) ? 3 : 0;
    }

    case 'appendix': {
      const appRe = new RegExp(
        `(?:^|\\n)\\s*(?:Appendix|附录)\\s*${escapedId}(?:\\b|\\s*[:.：—-])`,
        'im',
      );
      return appRe.test(pageText) ? 3 : 0;
    }

    case 'section': {
      const secRe = new RegExp(
        `(?:^|\\n)\\s*${escapedId}\\.?\\s+[A-Z\\u4e00-\\u9fff]`,
        'm',
      );
      return secRe.test(pageText) ? 3 : 0;
    }

    case 'equation': {
      const eqRe = new RegExp(`(?:^|\\s)\\(${escapedId}\\)(?:\\s*$|[.,;\\s])`, 'm');
      return eqRe.test(pageText) ? 2 : 0;
    }
  }
}

export interface LocateReferenceInput {
  numPages: number;
  currentPage: number;
  ref: DetectedAcademicReference;
  getPageText: (pageNumber: number) => Promise<string>;
}

/**
 * 在整篇论文中定位目标引用所在页（1-based）：
 * - 文献引用（`citation`）从文末倒序扫描（References 通常在最后 25% 页面），命中得分 >= 3 时提前短路返回；
 * - 图表/公式/章节按全文顺序扫描（优先非当前页的定义处，若仅当前页含定义则返回当前页）。
 */
export async function locateAcademicReferencePage(
  input: LocateReferenceInput,
): Promise<number | null> {
  const { numPages, currentPage, ref, getPageText } = input;
  if (numPages <= 0) return null;

  const backMatterStart = Math.max(1, Math.floor(numPages * 0.7));
  const candidateOrder: number[] = [];

  if (ref.kind === 'citation' || ref.kind === 'appendix') {
    for (let p = numPages; p >= 1; p--) {
      if (p !== currentPage) candidateOrder.push(p);
    }
    if (currentPage >= 1 && currentPage <= numPages) candidateOrder.push(currentPage);
  } else {
    for (let p = 1; p <= numPages; p++) {
      if (p !== currentPage) candidateOrder.push(p);
    }
    if (currentPage >= 1 && currentPage <= numPages) candidateOrder.push(currentPage);
  }

  let bestPage: number | null = null;
  let bestScore = 0;

  for (const pageNum of candidateOrder) {
    let text = '';
    try {
      text = await getPageText(pageNum);
    } catch {
      continue;
    }
    const inBackMatter = pageNum >= backMatterStart;
    const score = scorePageForAcademicReference(text, ref, inBackMatter);
    if (score > bestScore) {
      bestScore = score;
      bestPage = pageNum;
      // 在文末参考文献区精确命中条目，或在其他页命中强标题定义，直接返回无需扫完余页
      if (score >= 3 && pageNum !== currentPage) {
        return pageNum;
      }
    }
  }

  return bestScore >= 2 ? bestPage : null;
}

export interface AcademicReferencePreview {
  ref: DetectedAcademicReference;
  page: number;
  snippet: string;
}

function clampAcademicSnippet(raw: string, maxChars: number): string {
  const normalized = raw.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  const sliced = normalized.slice(0, maxChars);
  const lastSpace = sliced.lastIndexOf(' ');
  const cut = lastSpace > Math.floor(maxChars * 0.7) ? sliced.slice(0, lastSpace) : sliced;
  return `${cut.trim()}…`;
}

/**
 * 从目标页文本中抽取被引用条目的就地预览摘要（Zotero 7 / ReadCube 风格）：
 * - 文献引用 `[12]` / `Vaswani 2017` → 抽取完整题录条目（作者、标题、会议/年份），遇到下一条 `[13]` 自动截断；
 * - 图表/算法 `Fig. 3` / `Table 2` → 抽取完整 Caption 图注/表注；
 * - 公式 `Eq. (4)` → 兼容左编号 `(4) f(x)=...` 与 LaTeX 右编号 `f(x)=... (4)`，抽取公式上下文；
 * - 定理/章节/附录 → 抽取定义首段或小节标题与导语。
 */
export function extractAcademicReferenceSnippet(
  pageText: string,
  ref: DetectedAcademicReference,
  maxChars = 320,
): string | null {
  if (!pageText || !pageText.trim()) return null;
  const escapedId = escapeRegExp(ref.id);

  switch (ref.kind) {
    case 'citation': {
      if (ref.id.includes(':')) {
        const [author, year] = ref.id.split(':');
        if (!author || !year) return null;
        const entryRe = new RegExp(
          `(?:^|\\n)\\s*(\\[\\d+\\]\\s*)?(${escapeRegExp(author)}[\\s\\S]{0,360}?\\b${escapeRegExp(year)}[a-z]?[\\s\\S]{0,220}?)(?=\\n\\s*(?:\\[\\d+\\]|\\d+\\.\\s+[A-Z]|[A-Z][a-zA-Z'-]+,\\s+[A-Z])|\\n\\s*\\n|$)`,
          'im',
        );
        const m = entryRe.exec(pageText);
        if (m) {
          return clampAcademicSnippet(`${m[1] ?? ''}${m[2] ?? ''}`, maxChars);
        }
        return null;
      }

      // [12] Author, Title... 直至下一条 [13] 或空行
      const bracketRe = new RegExp(
        `(\\[${escapedId}\\]\\s*[A-Z\\u4e00-\\u9fff“"'][\\s\\S]{0,420}?)(?=\\s*\\[\\d+\\]\\s+[A-Z\\u4e00-\\u9fff“"']|\\n\\s*\\[\\d+\\]|\\n\\s*\\n|$)`,
        'm',
      );
      const bracketMatch = bracketRe.exec(pageText);
      if (bracketMatch?.[1]) {
        return clampAcademicSnippet(bracketMatch[1], maxChars);
      }

      const numberedRe = new RegExp(
        `(?:^|\\n)\\s*(${escapedId}\\.\\s+[A-Z\\u4e00-\\u9fff][\\s\\S]{0,420}?)(?=\\n\\s*\\d+\\.\\s+[A-Z\\u4e00-\\u9fff]|\\n\\s*\\n|$)`,
        'm',
      );
      const numberedMatch = numberedRe.exec(pageText);
      if (numberedMatch?.[1]) {
        return clampAcademicSnippet(numberedMatch[1], maxChars);
      }
      return null;
    }

    case 'figure':
    case 'table':
    case 'algorithm': {
      const prefixPattern =
        ref.kind === 'figure'
          ? '(?:Figure|Fig\\.?|图)'
          : ref.kind === 'table'
            ? '(?:Table|Tab\\.?|表)'
            : '(?:Algorithm|Alg\\.?|算法)';
      const captionRe = new RegExp(
        `(?:^|\\n|\\b)(${prefixPattern}\\s*${escapedId}(?:\\s*[:.：—-]|\\s+[A-Z\\u4e00-\\u9fff])[\\s\\S]{0,380}?)(?=\\n\\s*\\n|$)`,
        'im',
      );
      const m = captionRe.exec(pageText);
      return m?.[1] ? clampAcademicSnippet(m[1], maxChars) : null;
    }

    case 'theorem': {
      const defRe = new RegExp(
        `(?:^|\\n)\\s*((?:Theorem|Lemma|Proposition|Corollary|定理|引理|命题|推论)\\s*${escapedId}(?:\\b|\\s*[:.(（])[\\s\\S]{0,380}?)(?=\\n\\s*\\n|$)`,
        'im',
      );
      const m = defRe.exec(pageText);
      return m?.[1] ? clampAcademicSnippet(m[1], maxChars) : null;
    }

    case 'appendix': {
      const appRe = new RegExp(
        `(?:^|\\n)\\s*((?:Appendix|附录)\\s*${escapedId}(?:\\b|\\s*[:.：—-])[\\s\\S]{0,340}?)(?=\\n\\s*\\n|$)`,
        'im',
      );
      const m = appRe.exec(pageText);
      return m?.[1] ? clampAcademicSnippet(m[1], maxChars) : null;
    }

    case 'section': {
      const secRe = new RegExp(
        `(?:^|\\n)\\s*(${escapedId}\\.?\\s+[A-Z\\u4e00-\\u9fff][\\s\\S]{0,340}?)(?=\\n\\s*\\n|$)`,
        'm',
      );
      const m = secRe.exec(pageText);
      return m?.[1] ? clampAcademicSnippet(m[1], maxChars) : null;
    }

    case 'equation': {
      const eqRe = new RegExp(`(?:^|\\s)\\(${escapedId}\\)(?:\\s*$|[.,;\\s])`, 'm');
      const m = eqRe.exec(pageText);
      if (!m || m.index === undefined) return null;
      // 兼顾左编号 `(4) E = mc^2` 与 LaTeX 右编号 `E = mc^2   (4)`
      const lineStart = pageText.lastIndexOf('\n', Math.max(0, m.index - 1));
      const prevLineStart =
        lineStart > 0 ? pageText.lastIndexOf('\n', Math.max(0, lineStart - 1)) : -1;
      const startIdx = Math.max(0, prevLineStart >= 0 ? prevLineStart + 1 : lineStart + 1, m.index - 160);
      const nextBreak = pageText.indexOf('\n\n', m.index);
      const endIdx = Math.min(
        pageText.length,
        nextBreak >= 0 ? nextBreak : m.index + m[0].length + 180,
      );
      return clampAcademicSnippet(pageText.slice(startIdx, endIdx), maxChars);
    }
  }
}

/**
 * 扫描整篇论文定位目标引用，并一步提取用于浮层就地预览的条目/图注/公式摘要（单次扫描，不重复读页）。
 */
export async function previewAcademicReference(
  input: LocateReferenceInput & { maxChars?: number },
): Promise<AcademicReferencePreview | null> {
  const { numPages, currentPage, ref, getPageText, maxChars = 320 } = input;
  if (numPages <= 0) return null;

  const backMatterStart = Math.max(1, Math.floor(numPages * 0.7));
  const candidateOrder: number[] = [];

  if (ref.kind === 'citation' || ref.kind === 'appendix') {
    for (let p = numPages; p >= 1; p--) {
      if (p !== currentPage) candidateOrder.push(p);
    }
    if (currentPage >= 1 && currentPage <= numPages) candidateOrder.push(currentPage);
  } else {
    for (let p = 1; p <= numPages; p++) {
      if (p !== currentPage) candidateOrder.push(p);
    }
    if (currentPage >= 1 && currentPage <= numPages) candidateOrder.push(currentPage);
  }

  let bestPage: number | null = null;
  let bestScore = 0;
  let bestText = '';

  for (const pageNum of candidateOrder) {
    let text = '';
    try {
      text = await getPageText(pageNum);
    } catch {
      continue;
    }
    const inBackMatter = pageNum >= backMatterStart;
    const score = scorePageForAcademicReference(text, ref, inBackMatter);
    if (score > bestScore) {
      bestScore = score;
      bestPage = pageNum;
      bestText = text;
      if (score >= 3 && pageNum !== currentPage) {
        break;
      }
    }
  }

  if (bestScore < 2 || bestPage === null) return null;
  const snippet =
    extractAcademicReferenceSnippet(bestText, ref, maxChars) ??
    clampAcademicSnippet(bestText, Math.min(200, maxChars));

  return {
    ref,
    page: bestPage,
    snippet,
  };
}

// ============================================================================
// AI 阅读 PDF（指定页 / 全文结构化大纲 + 关键页正文组装）
// ============================================================================

export interface PdfOutlineNodeLike {
  title: string;
  items?: PdfOutlineNodeLike[];
}

/**
 * 将 PDF 目录树（Outline）与解析出的页码映射（path -> 1-based page）
 * 格式化为紧凑的 Markdown 章节索引，供 Agent 全文导读与按页调用 `resource_read` 定向巡航。
 */
export function formatPdfOutlineForAgent(
  outline: readonly PdfOutlineNodeLike[] | null | undefined,
  outlinePages?: ReadonlyMap<string, number>,
  maxEntries = 40,
): string {
  if (!outline || outline.length === 0) return '';
  const lines: string[] = [];

  const walk = (nodes: readonly PdfOutlineNodeLike[], prefixPath: string, depth: number) => {
    for (let i = 0; i < nodes.length; i++) {
      if (lines.length >= maxEntries) return;
      const node = nodes[i]!;
      const path = prefixPath ? `${prefixPath}.${i}` : `${i}`;
      const cleanTitle = node.title?.replace(/\s+/g, ' ').trim();
      if (cleanTitle) {
        const page = outlinePages?.get(path);
        const indent = '  '.repeat(Math.min(depth, 3));
        const pageSuffix = typeof page === 'number' && page > 0 ? ` (p. ${page})` : '';
        lines.push(`${indent}- ${cleanTitle}${pageSuffix}`);
      }
      if (node.items && node.items.length > 0 && depth < 3) {
        walk(node.items, path, depth + 1);
      }
    }
  };

  walk(outline, '', 0);
  return lines.join('\n');
}

export type PaperGuideReadingMode = 'overview' | 'current_page' | 'methodology' | 'critique';

const METHOD_SECTION_RE =
  /\b(?:method|methodology|approach|architecture|model|framework|algorithm|formulation|design|implementation)\b|方法|模型|架构|算法|框架|实现/i;
const CRITIQUE_SECTION_RE =
  /\b(?:experiment|evaluation|result|ablation|discussion|limitation|conclusion|analysis)\b|实验|评估|结果|消融|讨论|局限|结论/i;

/**
 * 根据阅读模式智能规划需要提取正文的页码列表（1-based，已排序去重）：
 * - `current_page`：若用户显式勾选了 `selectedPages` 则读全部已勾选页，否则读 `currentPage`；
 * - `overview` / `methodology` / `critique`：
 *   1) 必读首页（第 1–2 页：标题、摘要、引言核心贡献）与当前阅读页 `currentPage`；
 *   2) 合并用户显式勾选的 `selectedPages`；
 *   3) 若目录（`outline` + `outlinePages`）中能匹配到对应章节（如 Methodology / Experiments & Limitations），自动纳入该章节起始页。
 */
export function resolvePaperGuideTargetPages(input: {
  mode: PaperGuideReadingMode;
  numPages: number;
  currentPage: number;
  selectedPages?: Iterable<number>;
  outline?: readonly PdfOutlineNodeLike[] | null;
  outlinePages?: ReadonlyMap<string, number>;
  maxPages?: number;
}): number[] {
  const { mode, numPages, currentPage, selectedPages, outline, outlinePages, maxPages = 6 } = input;
  if (numPages <= 0) return [];

  const clamp = (p: number) => Math.max(1, Math.min(numPages, p));
  const picked = new Set<number>();

  if (selectedPages) {
    for (const p of selectedPages) {
      if (Number.isInteger(p) && p >= 1 && p <= numPages) {
        picked.add(p);
      }
    }
  }

  if (mode === 'current_page') {
    if (picked.size === 0) {
      picked.add(clamp(currentPage));
    }
    return Array.from(picked).sort((a, b) => a - b).slice(0, maxPages);
  }

  // 全文级模式：优先纳入第 1 页（标题+摘要）、第 2 页（引言）、当前页
  picked.add(1);
  if (numPages >= 2 && picked.size < maxPages) {
    picked.add(2);
  }
  picked.add(clamp(currentPage));

  // 从目录匹配目标章节起始页
  if (outline && outlinePages && picked.size < maxPages) {
    const matcher =
      mode === 'methodology'
        ? METHOD_SECTION_RE
        : mode === 'critique'
          ? CRITIQUE_SECTION_RE
          : null;
    if (matcher) {
      const walk = (nodes: readonly PdfOutlineNodeLike[], prefixPath: string) => {
        for (let i = 0; i < nodes.length; i++) {
          if (picked.size >= maxPages) return;
          const node = nodes[i]!;
          const path = prefixPath ? `${prefixPath}.${i}` : `${i}`;
          const page = outlinePages.get(path);
          if (page && page >= 1 && page <= numPages && matcher.test(node.title ?? '')) {
            picked.add(page);
            if (page + 1 <= numPages && picked.size < maxPages) {
              picked.add(page + 1);
            }
          }
          if (node.items?.length) walk(node.items, path);
        }
      };
      walk(outline, '');
    } else if (mode === 'overview' && numPages >= 4 && picked.size < maxPages) {
      // 全文概览额外捎上文末结论页（通常在倒数第 1–2 页，避开纯参考文献末页）
      const conclusionCandidate = Math.max(1, numPages - 1);
      picked.add(conclusionCandidate);
    }
  }

  return Array.from(picked).sort((a, b) => a - b).slice(0, maxPages);
}

/**
 * 将页码集合转换为 `selectionRef` 标准 locator（如 `page:3` 或 `page:3-7`）。
 */
export function buildSelectedPagesLocator(pages: readonly number[], fallbackPage = 1): string {
  const valid = pages.filter((p) => Number.isInteger(p) && p >= 1).sort((a, b) => a - b);
  if (valid.length === 0) return `page:${Math.max(1, fallbackPage)}`;
  if (valid.length === 1) return `page:${valid[0]}`;
  return `page:${valid[0]}-${valid[valid.length - 1]}`;
}

export interface BuildPaperContextSnapshotInput {
  title: string;
  sourceId?: string | null;
  numPages: number;
  currentPage: number;
  mode: PaperGuideReadingMode | 'selected_pages';
  outlineText?: string;
  pageTexts: ReadonlyArray<{ page: number; text: string }>;
  perPageMaxChars?: number;
}

/**
 * 构建注入 `<selection>` 上下文的 PDF 结构化内容快照：
 * - 包含文档总页数、目录大纲（全文模式）、所选页面正文明文（带 `[PDF@sourceId:page]` 锚点）；
 * - 若存在 `sourceId`，附带 `builtin-resource_read(resource_id, page_start, page_end)` 按页续读提示。
 */
export function buildPaperReadingContextSnapshot(input: BuildPaperContextSnapshotInput): string {
  const {
    title,
    sourceId,
    numPages,
    currentPage,
    mode,
    outlineText,
    pageTexts,
    perPageMaxChars = 3200,
  } = input;

  const sections: string[] = [];
  const trimmedId = sourceId?.trim();
  const headerMeta = [
    `文档：《${title}》`,
    numPages > 0 ? `总页数：${numPages} 页` : '',
    `当前阅读位置：第 ${currentPage} 页`,
    trimmedId ? `resource_id：${trimmedId}` : '',
  ]
    .filter(Boolean)
    .join(' ｜ ');
  sections.push(headerMeta);

  if (mode !== 'selected_pages' && outlineText?.trim()) {
    sections.push(`【论文目录大纲（章节 → 页码）】\n${outlineText.trim()}`);
  }

  const nonEmptyPages = pageTexts.filter((item) => item.text.trim().length > 0);
  if (nonEmptyPages.length > 0) {
    const pageBlocks = nonEmptyPages.map(({ page, text }) => {
      const cleaned = text.trim();
      const clipped =
        cleaned.length > perPageMaxChars ? `${cleaned.slice(0, perPageMaxChars)}\n…[本页后续内容省略]` : cleaned;
      const citeTag = trimmedId ? `[PDF@${trimmedId}:${page}] ` : '';
      return `### ${citeTag}第 ${page} 页正文\n${clipped}`;
    });
    const suppliedPages = nonEmptyPages.map(({ page }) => page).join('、');
    sections.push(`【已提供的正文页：${suppliedPages}】\n${pageBlocks.join('\n\n')}`);
  }

  if (trimmedId && numPages > 1) {
    sections.push(
      `【按页深读与引用说明】引用特定页结论时请原样使用 [PDF@${trimmedId}:页码] 标记（用户点击可直接跳回对应页）。如果要对其他章节下结论，请先读取对应页面： builtin-resource_read(resource_id="${trimmedId}", page_start=起始页, page_end=结束页)。`,
    );
  }

  return sections.join('\n\n');
}
