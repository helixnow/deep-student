/**
 * `dstu-anki/src/document_processing_service.rs::tests` 全量移植（31 个用例）。
 *
 * 纯分段逻辑直接调用 `src/document-processing.ts`；最后一个 `tokio::test` 使用
 * 真实迁移后的 `mistakes` 库（`createAnkiTestEnv()`）走完整落库路径。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AnkiGenerationOptions } from '../../../../contracts/ipc/generated/L16-anki.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { isRustWhitespace, rustTrim } from '../../../platform/paths/compat.ts';
import {
  DocumentProcessingService,
  MIN_TOKENS_PER_SEGMENT,
  SENTENCE_ENDS,
  byteIndexToCharIndex,
  calculateMaxTokensPerSegment,
  countTableDataRows,
  distributeGlobalMaxCards,
  distributeGlobalMaxCardsWeighted,
  ensureRowCoverage,
  estimateTokens,
  getOverlapPrefix,
  getOverlapSuffix,
  segmentDocument,
  segmentWithoutOverlap,
  snapCutToBoundary,
  splitByCharacters,
  takePrefixWithTokenLimit,
  takeSuffixWithTokenLimit,
} from '../src/document-processing.ts';
import { createAnkiTestEnv, type AnkiTestEnv } from './env.ts';

// ---------------------------------------------------------------- 测试工具

/** Rust `str::lines`（末行换行可选，去掉每行末尾的 `\r`）。 */
function linesOf(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts.map((part) => (part.endsWith('\r') ? part.slice(0, -1) : part));
}

function codePoints(text: string): string[] {
  return Array.from(text);
}

function countMatches(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/** Rust `char::is_whitespace` 过滤（`segment_document_reads_llm_boundary_flag` 用）。 */
function stripWhitespace(text: string): string {
  let out = '';
  for (const ch of text) {
    if (!isRustWhitespace(ch.codePointAt(0)!)) out += ch;
  }
  return out;
}

/**
 * `dstu-util/src/utils/token_budget.rs::estimate_tokens` 的启发式路径
 * （`tokenizer_tiktoken` 未启用），仅用于钉住两套估算口径的差异。
 */
function tokenBudgetEstimateTokens(text: string): number {
  if (text === '') return 0;
  const cjk = (cp: number): boolean =>
    (cp >= 0x4e00 && cp <= 0x9fff)
    || (cp >= 0x3400 && cp <= 0x4dbf)
    || (cp >= 0x20000 && cp <= 0x2a6df)
    || (cp >= 0x2a700 && cp <= 0x2b73f)
    || (cp >= 0x2b740 && cp <= 0x2b81f)
    || (cp >= 0x2b820 && cp <= 0x2ceaf)
    || (cp >= 0x2ceb0 && cp <= 0x2ebef)
    || (cp >= 0xf900 && cp <= 0xfaff);
  const kana = (cp: number): boolean => (cp >= 0x3040 && cp <= 0x309f) || (cp >= 0x30a0 && cp <= 0x30ff);
  const hangul = (cp: number): boolean =>
    (cp >= 0xac00 && cp <= 0xd7af) || (cp >= 0x1100 && cp <= 0x11ff) || (cp >= 0x3130 && cp <= 0x318f);
  let total = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) {
      const alphanumeric =
        (cp >= 0x30 && cp <= 0x39) || (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a);
      const whitespace = cp === 0x20 || cp === 0x09 || cp === 0x0a || cp === 0x0d || cp === 0x0b || cp === 0x0c;
      total = Math.fround(total + (alphanumeric ? 0.25 : whitespace ? 0.05 : 0.3));
      continue;
    }
    total = Math.fround(total + (cjk(cp) || kana(cp) || hangul(cp) ? 1.0 : 0.8));
  }
  return Math.max(1, Math.round(total));
}

/** 构造测试用的最小 AnkiGenerationOptions（对应 Rust `test_options`）。 */
function testOptions(overlap: number): AnkiGenerationOptions {
  return {
    deck_name: 'Default',
    note_type: 'Basic',
    enable_images: false,
    max_cards_per_mistake: 10,
    segment_overlap_size: overlap,
  };
}

/** 生成超过默认 10k token 预算的多段落中文文档（每段带唯一编号标记）。 */
function buildLongParagraphDoc(paragraphs: number, charsPerParagraph: number): string[] {
  const docs: string[] = [];
  for (let i = 0; i < paragraphs; i += 1) {
    const marker = `知识点编号${String(i).padStart(3, '0')}的内容`;
    let paragraph = '';
    while (codePoints(paragraph).length < charsPerParagraph) {
      paragraph += marker;
    }
    docs.push(paragraph);
  }
  return docs;
}

/** 构造一个无句末标点、每 200 字符插入一个换行的超长「单句」。 */
function buildNewlineRiddledRun(): string {
  let text = '';
  const filler = '连续内容没有句读符号只有逗号，';
  let charsSinceNewline = 0;
  while (estimateTokens(text) < 25_000) {
    text += filler;
    charsSinceNewline += codePoints(filler).length;
    if (charsSinceNewline >= 200) {
      text += '\n';
      charsSinceNewline = 0;
    }
  }
  return text;
}

/** 判断 b 中是否存在长度为 window 的子串也出现在 a 中。 */
function longestSharedWindow(a: string, b: string, window: number): boolean {
  const bChars = codePoints(b);
  if (bChars.length < window) {
    return a.includes(b);
  }
  // 只需检查 b 的前 600 字符（重叠上下文注入在分段头部）
  const scan = Math.min(bChars.length, 600);
  for (let start = 0; start <= Math.max(0, scan - window); start += 1) {
    const candidate = bChars.slice(start, start + window).join('');
    if (a.includes(candidate)) {
      return true;
    }
  }
  return false;
}

/** UTF-16 索引处的 UTF-8 字节偏移（模拟 `rfind`/`find` 返回的字节索引）。 */
function byteIndexOf(text: string, utf16Index: number): number {
  return Buffer.byteLength(text.slice(0, utf16Index), 'utf8');
}

describe('crates/dstu-anki/src/document_processing_service.rs::tests', () => {
  let env: AnkiTestEnv;
  let db: DatabaseHandle;

  beforeAll(async () => {
    env = await createAnkiTestEnv();
    db = env.storage.database('mistakes');
  }, 120_000);

  afterAll(async () => {
    await env.dispose();
  });

  beforeEach(() => {
    // 共享迁移库：每个用例从干净的业务数据开始（与 Rust 的 setup_migrated_db 等价）。
    db.exec(`
      DELETE FROM fsrs_review_logs;
      DELETE FROM fsrs_card_states;
      DELETE FROM anki_cards;
      DELETE FROM document_tasks;
    `);
  });

  /// 词表（制表符表格，单元格里有「。」）：分段只在行边界，每个词恰好出现一次，
  /// 后续段开头重复表头。回归：按句末标点切把行拆进两段，60 词只出 45 张卡。
  it('glossary_table_segments_keep_rows_whole_and_repeat_header', () => {
    const header = '单词\t音标\t词性\t中文释义\t例句(英)\t例句译文';
    let table = `=== 词汇 Unit07 ===\n${header}\n`;
    for (let i = 0; i < 60; i += 1) {
      table += `word${i}\t/wɜːd${i}/\tv.\t释义${i}，含义说明\tThis is example sentence number ${i} for the word.\t这是第${i}个例句的译文。还有一句。\n`;
    }
    const segments = segmentWithoutOverlap(table, 400, false);
    expect(segments.length).toBeGreaterThan(2);

    const seen = new Map<string, number>();
    segments.forEach((segment, idx) => {
      for (const line of linesOf(segment)) {
        if (line.startsWith('word')) {
          expect(countMatches(line, '\t'), `行被切断: ${line}`).toBe(5);
          const word = line.split('\t')[0]!;
          seen.set(word, (seen.get(word) ?? 0) + 1);
        }
      }
      if (idx > 0) {
        expect(segment.startsWith(header), `第 ${idx} 段缺表头`).toBe(true);
      }
    });
    expect(seen.size).toBe(60);
    expect([...seen.values()].every((count) => count === 1)).toBe(true);
  });

  /// 文件标题行紧跟超长表格：标题不再单独成段（单独成段时模型只拿到标题会凭空编卡）。
  it('short_lead_paragraph_is_merged_into_following_long_paragraph', () => {
    let table = '单词\t释义\n';
    for (let i = 0; i < 80; i += 1) {
      table += `word${i}\t这是第${i}个词的释义，包含一些说明文字。\n`;
    }
    const content = `# 词表.xlsx\n\n${table}`;
    const segments = segmentWithoutOverlap(content, 300, false);
    expect(segments.length).toBeGreaterThan(1);
    expect(segments[0]!.startsWith('# 词表.xlsx\n\n单词'), segments[0]!).toBe(true);
    expect(segments.every((segment) => linesOf(segment).some((line) => line.startsWith('word')))).toBe(true);
  });

  /// 段落首行是数据行（无表头）时不得当成表头在后续段重复。
  it('data_row_is_not_mistaken_for_header', () => {
    let table = '';
    for (let i = 0; i < 60; i += 1) {
      table += `word${i}\t/wɜːd${i}/\tv.\t释义${i}\tThis is a fairly long example sentence number ${i}.\n`;
    }
    const segments = segmentWithoutOverlap(table, 300, false);
    const firstLines = segments
      .map((segment) => linesOf(segment)[0])
      .filter((line): line is string => line !== undefined);
    const seen = new Set<string>();
    for (const line of firstLines) {
      expect(seen.has(line), `数据行被当作表头重复: ${line}`).toBe(false);
      seen.add(line);
    }
  });

  it('single_line_paragraph_still_splits_by_sentence', () => {
    const paragraph = '这是一句很长的话。'.repeat(200);
    const segments = segmentWithoutOverlap(paragraph, 300, false);
    expect(segments.length).toBeGreaterThan(1);
    expect(segments.every((segment) => segment.endsWith('。'))).toBe(true);
  });

  // ---------------- token 估算：钉住权威规则 ----------------

  it('estimate_tokens_pinned_values', () => {
    // 空串 → 0
    expect(estimateTokens('')).toBe(0);
    // 纯英文: 11 字符, 2 词, 0 汉字 → floor(2*1.3)=2 + floor(11*0.2)=2 = 4
    expect(estimateTokens('hello world')).toBe(4);
    // 纯中文: 4 汉字 + 1 词 → 4 + floor(1.3)=1 = 5
    expect(estimateTokens('你好世界')).toBe(5);
    // 混合: "你好, world! 😀" → 2 汉字 + floor(3*1.3)=3 + floor(10*0.2)=2 = 7
    expect(estimateTokens('你好, world! 😀')).toBe(7);
    // 下限规则: 长串无空白 ASCII → max(公式值, 字符数/4)
    const s = 'a'.repeat(100);
    // 公式: 0 + floor(1*1.3)=1 + floor(100*0.2)=20 = 21; 下限 100/4=25 → 25
    expect(estimateTokens(s)).toBe(25);
  });

  it.each([
    ['甲\u3000乙', 4],
    ['甲\u3001乙', 3],
    ['甲\u0085乙', 4],
    ['甲\u2000乙', 4],
    ['甲\uFEFF乙', 3],
    ['甲😀乙', 3],
    ['テスト한글😀🚀', 2],
    ['\u3000', 0],
    ['\uFEFF', 1],
  ] as const)('estimate_tokens_whitespace_upper_bound preserves %j as %i tokens', (text, expected) => {
    // Rust :257-276: count scalar values and split_whitespace words, then the
    // unchanged f32 products/truncation. U+3000 is whitespace; U+3001/BOM are not.
    expect(estimateTokens(text)).toBe(expected);
  });

  /// 钉住与 token_budget.rs 的已知口径差异（模块注释中声明为可接受）。
  it('estimate_tokens_diverges_from_token_budget', () => {
    const text = 'hello world';
    const ours = estimateTokens(text);
    const budget = tokenBudgetEstimateTokens(text);
    expect(ours).toBe(4);
    expect(budget).toBe(3); // token_budget: 10*0.25 + 0.05 ≈ 2.55 → round 3
    expect(
      ours,
      '两套估算口径当前不同且已被文档接受；若变为一致请更新模块注释',
    ).not.toBe(budget);
  });

  it('estimate_tokens_monotonic_over_prefixes', () => {
    // splitByCharacters 的二分搜索依赖前缀单调性，钉住该性质
    const text = '混合mixed内容123，标点。emoji😀和space word尾部';
    const chars = codePoints(text);
    let prev = 0;
    for (let end = 1; end <= chars.length; end += 1) {
      const prefix = chars.slice(0, end).join('');
      const tokens = estimateTokens(prefix);
      expect(tokens, '前缀扩展时 token 估算必须单调不减').toBeGreaterThanOrEqual(prev);
      prev = tokens;
    }
  });

  // ---------------- 每段预算计算 ----------------

  it('max_tokens_per_segment_default_and_derived', () => {
    // 未设置 → 默认 10k
    expect(calculateMaxTokensPerSegment(testOptions(200))).toBe(10_000);

    // 很大的 max_tokens 不影响默认值
    expect(calculateMaxTokensPerSegment({ ...testOptions(200), max_tokens: 50_000 })).toBe(10_000);

    // 较小的 max_tokens → 取一半
    expect(calculateMaxTokensPerSegment({ ...testOptions(200), max_tokens: 8_000 })).toBe(4_000);

    // override 优先于 max_tokens
    expect(
      calculateMaxTokensPerSegment({
        ...testOptions(200),
        max_tokens: 8_000,
        max_output_tokens_override: 2_000,
      }),
    ).toBe(1_000);
  });

  it('max_tokens_per_segment_zero_is_clamped', () => {
    // 修复钉住：max_tokens=0 时旧实现返回 0 → 下游死循环；现在钳制到下限
    expect(calculateMaxTokensPerSegment({ ...testOptions(200), max_tokens: 0 })).toBe(
      MIN_TOKENS_PER_SEGMENT,
    );
    expect(
      calculateMaxTokensPerSegment({ ...testOptions(200), max_output_tokens_override: 1 }),
    ).toBe(MIN_TOKENS_PER_SEGMENT);
  });

  // ---------------- 基本形态：空文档 / 短文档 ----------------

  it('empty_document_returns_single_segment', () => {
    const segments = segmentDocument('', testOptions(200));
    expect(segments).toEqual(['']);
  });

  it('whitespace_only_document_returns_single_segment', () => {
    const content = '   \n\n  \t \n ';
    const segments = segmentDocument(content, testOptions(200));
    expect(segments.length).toBe(1);
    expect(segments[0]).toBe(content);
  });

  it('short_document_is_not_segmented', () => {
    const content = '第一段内容。\n\n第二段内容。';
    const segments = segmentDocument(content, testOptions(200));
    expect(segments).toEqual([content]);
  });

  // ---------------- 10k token 默认预算切分 ----------------

  it('long_document_splits_within_10k_budget', () => {
    const opts = testOptions(0);
    // 10 段 × 3000 汉字 ≈ 30k tokens → 至少 3 段
    const paragraphs = buildLongParagraphDoc(10, 3000);
    const content = paragraphs.join('\n\n');
    const segments = segmentDocument(content, opts);
    expect(segments.length, `约 30k tokens 的文档应切成至少 3 段，实际 ${segments.length} 段`).toBeGreaterThanOrEqual(3);
    segments.forEach((segment, i) => {
      const tokens = estimateTokens(segment);
      expect(tokens, `分段${i + 1}估算 ${tokens} tokens 超过 10k 预算`).toBeLessThanOrEqual(10_000);
      expect(rustTrim(segment) !== '', `分段${i + 1}为空白`).toBe(true);
    });
  });

  // ---------------- 段落边界优先 ----------------

  it('paragraph_boundaries_are_preferred', () => {
    const opts = testOptions(0);
    const paragraphs = buildLongParagraphDoc(8, 3000);
    const content = paragraphs.join('\n\n');
    const segments = segmentDocument(content, opts);
    expect(segments.length).toBeGreaterThan(1);
    // 每个分段必须由完整段落拼接而成（overlap=0 且单段落未超预算）
    for (const segment of segments) {
      for (const part of segment.split('\n\n')) {
        expect(
          paragraphs.some((paragraph) => paragraph === part),
          `分段中出现被切碎的段落: ${codePoints(part).slice(0, 30).join('')}...`,
        ).toBe(true);
      }
    }
    // 所有段落都被覆盖且各出现一次（无重叠时不得重复、不得丢失）
    const joined = segments.join('\n\n');
    for (const paragraph of paragraphs) {
      expect(countMatches(joined, paragraph), 'overlap=0 时每个段落应恰好出现一次').toBe(1);
    }
  });

  // ---------------- overlap = 200（ChatAnki 普通材料默认值） ----------------

  it('overlap_200_adjacent_segments_share_boundary_context', () => {
    const opts = testOptions(200);
    const paragraphs = buildLongParagraphDoc(10, 3000);
    const content = paragraphs.join('\n\n');
    const segments = segmentDocument(content, opts);
    expect(segments.length).toBeGreaterThan(1);
    // 相邻分段之间必须共享边界上下文：
    // 分段 i 的尾部包含分段 i+1 正文的开头（后重叠），
    // 分段 i+1 的头部包含分段 i 正文的结尾（前重叠）。
    for (let i = 0; i + 1 < segments.length; i += 1) {
      expect(
        longestSharedWindow(segments[i]!, segments[i + 1]!, 80),
        'overlap=200 时相邻分段应共享至少 80 字符的边界上下文',
      ).toBe(true);
    }
    // 重叠不得导致超预算
    for (const segment of segments) {
      expect(estimateTokens(segment)).toBeLessThanOrEqual(10_000);
    }
  });

  // ---------------- overlap = 0（ChatAnki 词汇表模式） ----------------

  it('glossary_overlap_0_produces_no_duplication', () => {
    const opts = testOptions(0);
    // 模拟 ChatAnki normalize_glossary_paragraphs 之后的词汇表：条目以 \n\n 分隔
    const entries: string[] = [];
    for (let i = 0; i < 120; i += 1) {
      const marker = String(i).padStart(3, '0');
      entries.push(`${i + 1}. 术语${marker}：${`这是术语${marker}的详细解释内容`.repeat(12)}`);
    }
    const content = entries.join('\n\n');
    expect(estimateTokens(content), '测试语料必须超过预算').toBeGreaterThan(10_000);
    const segments = segmentDocument(content, opts);
    expect(segments.length).toBeGreaterThan(1);
    const joined = segments.join('\n\n');
    // overlap=0：每个条目恰好出现一次（不重复 → 不会重复制卡；不丢失）
    entries.forEach((_entry, i) => {
      const marker = `术语${String(i).padStart(3, '0')}：`;
      expect(countMatches(joined, marker), `词汇表条目 ${i} 在 overlap=0 时应恰好出现一次`).toBe(1);
    });
  });

  // ---------------- 超长单段（句子切分路径） ----------------

  it('oversized_single_paragraph_is_split_by_sentences', () => {
    const opts = testOptions(0);
    // 单个段落（无 \n\n），由大量带句号的句子组成，总量 > 10k tokens
    let paragraph = '';
    for (let i = 0; i < 1500; i += 1) {
      paragraph += `这是第${i}个完整句子的内容表述。`;
    }
    expect(estimateTokens(paragraph)).toBeGreaterThan(10_000);
    const segments = segmentDocument(paragraph, opts);
    expect(segments.length).toBeGreaterThan(1);
    for (const segment of segments) {
      expect(estimateTokens(segment)).toBeLessThanOrEqual(10_000);
      // 句子切分路径下每段应以句末标点收尾（不会把句子拦腰切断）
      const chars = codePoints(segment);
      const last = chars[chars.length - 1]!;
      expect(
        SENTENCE_ENDS.includes(last),
        `句子切分产生的分段应以句末标点结尾，实际结尾: ${JSON.stringify(last)}`,
      ).toBe(true);
    }
  });

  // ---------------- CJK / emoji 硬切不坏字符、无损 ----------------

  it('forced_char_split_preserves_cjk_and_emoji', () => {
    // 单个"句子"（无任何句末标点/空白）強制走 splitByCharacters
    const unit = '汉字テスト한글😀🚀内容';
    let text = '';
    while (estimateTokens(text) < 25_000) {
      text += unit;
    }
    const segments = splitByCharacters(text, 10_000, false);
    expect(segments.length).toBeGreaterThan(1);
    // 1) 无损：拼接后与原文逐字节一致（该输入无纯空白块）
    expect(segments.join(''), '硬切必须无损且不切坏任何字符').toBe(text);
    // 2) 每段都是合法 UTF-8（JS string 保证）且非空
    for (const segment of segments) {
      expect(segment.length).toBeGreaterThan(0);
      // 3) 不超预算（修复了旧实现 CJK 约 2 倍超预算的 bug）
      expect(
        estimateTokens(segment),
        `硬切分段超预算: ${estimateTokens(segment)} tokens`,
      ).toBeLessThanOrEqual(10_000);
    }
  });

  it('forced_char_split_zero_budget_terminates', () => {
    // 修复钉住：旧实现 max_tokens=0 → max_chars=0 → 死循环
    const text = 'abc汉字😀';
    const segments = splitByCharacters(text, 0, false);
    expect(segments.length).toBeGreaterThan(0);
    expect(segments.join('')).toBe(text);
  });

  // ---------------- 边界吸附（enable_llm_boundary_detection） ----------------

  it('boundary_snap_enabled_cuts_at_natural_boundaries', () => {
    const text = buildNewlineRiddledRun();
    const segments = splitByCharacters(text, 10_000, true);
    expect(segments.length).toBeGreaterThan(1);
    // 除最后一段外，吸附后的切点应落在换行边界（段以 '\n' 收尾）
    for (const segment of segments.slice(0, segments.length - 1)) {
      const chars = codePoints(segment);
      const last = chars[chars.length - 1];
      expect(last, `开启边界吸附后硬切点应吸附到换行边界，实际结尾: ${JSON.stringify(last)}`).toBe('\n');
    }
    // 吸附只前移切点，不得超预算
    for (const segment of segments) {
      expect(estimateTokens(segment)).toBeLessThanOrEqual(10_000);
    }
  });

  it('boundary_snap_disabled_keeps_hard_cut', () => {
    const text = buildNewlineRiddledRun();
    const segments = splitByCharacters(text, 10_000, false);
    expect(segments.length).toBeGreaterThan(1);
    // 未开启吸附时，硬切点按 token 预算落点，几乎不可能恰好全部落在换行上
    const nonNewlineEndings = segments
      .slice(0, segments.length - 1)
      .filter((segment) => {
        const chars = codePoints(segment);
        return chars[chars.length - 1] !== '\n';
      }).length;
    expect(nonNewlineEndings, '关闭吸附时应存在非换行结尾的硬切分段').toBeGreaterThan(0);
  });

  it('segment_document_reads_llm_boundary_flag', () => {
    // 端到端验证：通过 options 传入开关（而不是直接调 splitByCharacters）
    const opts = { ...testOptions(0), enable_llm_boundary_detection: true };
    const text = buildNewlineRiddledRun();
    const segments = segmentDocument(text, opts);
    expect(segments.length).toBeGreaterThan(1);
    // segmentWithoutOverlap 会 trim 每段；验证切点吸附体现在段尾完整性上：
    // 拼接后不缺失任何内容字符（换行/空白 trim 掉属预期）。
    expect(stripWhitespace(segments.join(''))).toBe(stripWhitespace(text));
  });

  it('snap_cut_prefers_paragraph_over_sentence', () => {
    // 窗口内同时存在 \n\n、\n 与句号时，优先段落边界
    const chars = codePoints('内容'.repeat(100)); // 200 字符
    chars[150] = '。';
    chars[170] = '\n';
    chars[171] = '\n';
    const hardEnd = 200;
    expect(snapCutToBoundary(chars, 0, hardEnd), '应吸附到 \\n\\n 之后').toBe(172);
    // 只有句号时吸附到句号后
    const chars2 = codePoints('内容'.repeat(100));
    chars2[180] = '。';
    expect(snapCutToBoundary(chars2, 0, hardEnd), '应吸附到句末标点之后').toBe(181);
    // 无任何边界时维持硬切点
    const chars3 = codePoints('内容'.repeat(100));
    expect(snapCutToBoundary(chars3, 0, hardEnd)).toBe(hardEnd);
  });

  // ---------------- 重叠不整段复制（重复 overlap 修复） ----------------

  it('overlap_does_not_fully_duplicate_short_neighbor', () => {
    // 邻段只有 60 字符而 overlap=200：旧实现会把整个邻段复制进来
    const shortNeighbor = '短段落内容'.repeat(12); // 60 字符
    const neighborChars = codePoints(shortNeighbor).length;
    const suffix = getOverlapSuffix(shortNeighbor, 200);
    if (suffix !== null) {
      expect(
        codePoints(suffix).length,
        `重叠最多借用邻段一半内容，实际 ${codePoints(suffix).length} / ${neighborChars}`,
      ).toBeLessThanOrEqual(Math.trunc(neighborChars / 2));
    }
    const prefix = getOverlapPrefix(shortNeighbor, 200);
    if (prefix !== null) {
      expect(codePoints(prefix).length).toBeLessThanOrEqual(Math.trunc(neighborChars / 2));
    }
    // 空邻段/1字符邻段 → 不产生重叠（而不是 panic 或整段复制）
    expect(getOverlapSuffix('', 200)).toBeNull();
    expect(getOverlapPrefix('字', 200)).toBeNull();
  });

  // ---------------- 空段防御 ----------------

  it('no_empty_segments_for_whitespace_heavy_document', () => {
    const opts = testOptions(200);
    const paragraphs = buildLongParagraphDoc(8, 3000);
    // 段落之间夹杂纯空白"段落"
    const content = paragraphs.join('\n\n   \n\n\t\n\n');
    const segments = segmentDocument(content, opts);
    expect(segments.length).toBeGreaterThan(1);
    segments.forEach((segment, i) => {
      expect(rustTrim(segment) !== '', `分段${i + 1}是空白段`).toBe(true);
    });
  });

  // ---------------- 前后缀 token 截取工具 ----------------

  it('take_prefix_and_suffix_respect_token_limit_and_char_boundaries', () => {
    const text = '你好世界hello world😀日本語テキスト';
    for (const limit of [0, 1, 3, 5, 8, 100]) {
      const prefix = takePrefixWithTokenLimit(text, limit);
      expect(estimateTokens(prefix)).toBeLessThanOrEqual(limit);
      expect(text.startsWith(prefix), '前缀必须落在字符边界上').toBe(true);
      const suffix = takeSuffixWithTokenLimit(text, limit);
      expect(estimateTokens(suffix)).toBeLessThanOrEqual(limit);
      expect(text.endsWith(suffix), '后缀必须落在字符边界上').toBe(true);
    }
    // limit 足够大时应取全文
    expect(takePrefixWithTokenLimit(text, 1000)).toBe(text);
    expect(takeSuffixWithTokenLimit(text, 1000)).toBe(text);
  });

  it('byte_index_to_char_index_handles_multibyte_and_empty', () => {
    const text = 'a。b😀c';
    // rfind('。') 的字节索引应映射回字符索引 1
    const sentenceIndex = byteIndexOf(text, text.lastIndexOf('。'));
    expect(byteIndexToCharIndex(text, sentenceIndex)).toBe(1);
    const emojiIndex = byteIndexOf(text, text.indexOf('😀'));
    expect(byteIndexToCharIndex(text, emojiIndex)).toBe(3);
    // 修复钉住：空串不再下溢 panic
    expect(byteIndexToCharIndex('', 0)).toBe(0);
  });

  // ---------------- 卡片总额度分配 ----------------

  it('distribute_global_max_cards_weighted_follows_segment_size', () => {
    // 词表分段：15 / 2 / 10 / 15 / 8 / 14 词，总 65 张——词多的段多分
    const limits = distributeGlobalMaxCardsWeighted(65, [15, 2, 10, 15, 8, 14]);
    expect(sum(limits)).toBe(65);
    expect(limits[0]! >= 15 && limits[3]! >= 15, `${limits}`).toBe(true);
    expect(limits[1]! <= 3, `${limits}`).toBe(true);
    // 等权重时与等分一致
    expect(distributeGlobalMaxCardsWeighted(10, [5, 5, 5])).toEqual([4, 3, 3]);
    // 总量不超过段数时沿用等距抽样
    expect(distributeGlobalMaxCardsWeighted(2, [9, 1, 1, 9])).toEqual([1, 0, 0, 1]);
    expect(distributeGlobalMaxCardsWeighted(4, [0, 0])).toEqual([2, 2]);
  });

  it('row_coverage_keeps_one_card_per_table_row_when_budget_allows', () => {
    // 6 段共 60 行、总配额 60：加权取整给第 5 段 13 张而它有 14 行
    const rows = [13, 2, 9, 14, 6, 14];
    const limits = ensureRowCoverage([14, 3, 10, 15, 7, 13], rows);
    expect(sum(limits)).toBe(62);
    expect(limits.every((limit, index) => limit >= rows[index]!), `${limits}`).toBe(true);
    // 配额不足以每行一张时不干预
    expect(ensureRowCoverage([5, 5], [10, 10])).toEqual([5, 5]);
    // 非表格段（行数 0）不受影响
    expect(ensureRowCoverage([4, 3], [0, 0])).toEqual([4, 3]);
    const segment = '单词\t音标\t词性\nalpha\t/a/\tn.\nbeta\t/b/\tn.';
    expect(countTableDataRows(segment)).toBe(2);
  });

  it('distribute_global_max_cards_cases', () => {
    expect(distributeGlobalMaxCards(10, 3)).toEqual([4, 3, 3]);
    expect(distributeGlobalMaxCards(3, 3)).toEqual([1, 1, 1]);
    // F14：2 张分给 4 段时等距抽样（首段 + 末段），不再全部堆在前段
    expect(distributeGlobalMaxCards(2, 4)).toEqual([1, 0, 0, 1]);
    // 1 张时取中段，避免永远只取开头
    expect(distributeGlobalMaxCards(1, 5)).toEqual([0, 0, 1, 0, 0]);
    expect(distributeGlobalMaxCards(0, 3)).toEqual([0, 0, 0]);
    expect(distributeGlobalMaxCards(-5, 2)).toEqual([0, 0]);
    expect(distributeGlobalMaxCards(5, 0)).toEqual([]);
    // 总量守恒 + total < segments 时首尾都可能入选
    const sparse = distributeGlobalMaxCards(3, 10);
    expect(sum(sparse)).toBe(3);
    expect(sparse[0]!, `首段应可能入选: ${sparse}`).toBeGreaterThan(0);
    expect(sparse[9]!, `末段必须参与抽样，避免结论章被永久跳过: ${sparse}`).toBeGreaterThan(0);
    const dist = distributeGlobalMaxCards(103, 7);
    expect(sum(dist)).toBe(103);
  });

  it('max_cards_total_distributes_quota_across_persisted_segments', async () => {
    // 0824 评审 #4（多分段额度）：CardAgent 形状的 options
    // （maxCards → max_cards_total）经真实任务创建路径落库后，
    // 每段任务持久化的额度必须来自总额度分配（总和守恒），
    // 而不是每段都拿满 max_cards_per_mistake 导致总数放大。
    const service = new DocumentProcessingService(db);

    // CardAgent 装配形状：maxCards=10 同时写入总额度与单段兜底上限
    const options: AnkiGenerationOptions = {
      ...testOptions(0),
      max_cards_per_mistake: 10,
      max_cards_total: 10,
    };

    // 约 3 万 token 的长文档（默认 1 万 token/段预算）→ 必然多段
    const paragraph = '细胞呼吸分为糖酵解、丙酮酸氧化脱羧与三羧酸循环三个阶段，各阶段的场所与产物都不相同。'.repeat(25);
    const document = new Array<string>(30).fill(paragraph).join('\n\n');

    const [_documentId, tasks] = await service.processDocumentAndCreateTasks(document, '长文档', options);
    expect(tasks.length, `长文档必须切成多段，实际 ${tasks.length} 段`).toBeGreaterThanOrEqual(3);

    const perSegment = tasks.map((task) => {
      const parsed = JSON.parse(task.anki_generation_options_json) as AnkiGenerationOptions;
      return parsed.max_cards_per_mistake;
    });
    expect(sum(perSegment), `分段额度总和必须等于 max_cards_total: ${perSegment}`).toBe(10);
    expect(
      perSegment.every((limit) => limit < 10),
      `任何单段都不得独占全部额度（否则退化回旧的每段上限语义）: ${perSegment}`,
    ).toBe(true);
  });
});
