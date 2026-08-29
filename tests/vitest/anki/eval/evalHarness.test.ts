/**
 * 制卡质量 eval harness：坏输出回放基线（Round 3 #9，Round 4 #10 升级）。
 *
 * 回放 tests/fixtures/anki-eval/ 下的真实风格失败样本，
 * 断言解析结局（parse_ok / repair_ok / error_card）与 lint 命中码
 * 与 manifest.json 中固化的预期完全一致，构成回归基线：
 * 后续 Structured Output 落地时，这些 fixture 的
 * 预期只允许朝更好方向翻转（error_card → parse_ok），不允许劣化。
 *
 * Round 4 #10 起：lint 码复用 Rust 生产模块 anki_qa_lint 的 code 字符串契约
 * （对齐锁定见同目录 lintContract.test.ts），金标修正对回归见 goldPairs.test.ts。
 *
 * 解析逻辑为生产 Rust 私有函数的测试侧复刻（见 replayParser.mjs 头部
 * DRIFT RISK 说明）；生产侧同场景由 streaming_anki_service.rs 内联
 * Rust 单测锚定，两侧互为校验。
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';

// @ts-expect-error 共享 .mjs 模块无类型声明（与 CLI scripts/anki-eval/run-eval.mjs 共用同一实现）
import { loadManifest, runCase, diffExpectation, computeMetrics } from '../../../../scripts/anki-eval/lib/harness.mjs';
// @ts-expect-error 同上
import { lintCard, LINT_CODES } from '../../../../scripts/anki-eval/lib/cardLint.mjs';
// @ts-expect-error 同上
import { extractCardFromBuffer, cleanJsonString } from '../../../../scripts/anki-eval/lib/replayParser.mjs';

const REPO_ROOT = path.resolve(__dirname, '../../../..');

interface CaseDef {
  id: string;
  set: 'bad' | 'good';
  category: string;
  file: string;
  entry: 'stream' | 'direct';
  chunkSize: number;
  expected: {
    cards: Array<{ outcome: string; lintCodes: string[]; frontIncludes?: string }>;
    droppedProse: number;
  };
}

interface CaseResult {
  id: string;
  cards: Array<{ outcome: string; lintCodes: string[]; stage: string; card?: Record<string, unknown> }>;
  droppedProse: number;
}

async function loadAll(): Promise<{ cases: CaseDef[]; results: Map<string, CaseResult> }> {
  const manifest = await loadManifest(REPO_ROOT);
  const results = new Map<string, CaseResult>();
  for (const caseDef of manifest.cases as CaseDef[]) {
    results.set(caseDef.id, await runCase(caseDef, REPO_ROOT));
  }
  return { cases: manifest.cases as CaseDef[], results };
}

describe('anki eval harness：坏输出回放基线', () => {
  it('fixture 规模达标：坏样本 ≥25，好卡对照 ≥9', async () => {
    const { cases } = await loadAll();
    const bad = cases.filter((c) => c.set === 'bad');
    const good = cases.filter((c) => c.set === 'good');
    expect(bad.length).toBeGreaterThanOrEqual(25);
    expect(good.length).toBeGreaterThanOrEqual(9);
    // 覆盖任务要求的失败类别（Round 4 #10 起含 lint/critic 边界类别，
    // Round 5 #10 起含 xxx_residue / empty_brackets 边界对）
    const categories = new Set(bad.map((c) => c.category));
    for (const required of [
      'missing_delimiter',
      'glued_json',
      'trailing_comma',
      'markdown_fence',
      'start_end_mixed',
      'mixed_language_noise',
      'empty_cloze',
      'answer_leak',
      'front_back_identical',
      'cloze_broken',
      'multi_concept',
      'front_too_long',
      'placeholder_residue',
      'xxx_residue',
      'empty_brackets',
      'lint_blind_spot',
    ]) {
      expect(categories, `缺少类别 ${required}`).toContain(required);
    }
  });

  it('每个 fixture 的实际结局与 manifest 预期一致（回归基线）', async () => {
    const { cases, results } = await loadAll();
    const failures: string[] = [];
    for (const caseDef of cases) {
      const actual = results.get(caseDef.id)!;
      const problems: string[] = diffExpectation(caseDef, actual);
      if (problems.length > 0) {
        failures.push(`[${caseDef.id}] ${problems.join('；')}`);
      }
    }
    expect(failures, failures.join('\n')).toEqual([]);
  });

  it('好卡对照集：全部 parse_ok、零错误卡、零 lint 误伤', async () => {
    const { cases, results } = await loadAll();
    const goodResults = cases.filter((c) => c.set === 'good').map((c) => results.get(c.id)!);
    const metrics = computeMetrics(goodResults);
    expect(metrics.parseSuccessRate).toBe(1);
    expect(metrics.errorCardRate).toBe(0);
    expect(metrics.lintFlagRate).toBe(0);
    expect(metrics.repairOk).toBe(0);
    expect(metrics.droppedProse).toBe(0);
  });

  it('指标草表口径自洽（parse_success_rate + error_card_rate = 1）', async () => {
    const { cases, results } = await loadAll();
    for (const set of ['bad', 'good'] as const) {
      const subset = cases.filter((c) => c.set === set).map((c) => results.get(c.id)!);
      const metrics = computeMetrics(subset);
      expect(metrics.totalSegments).toBe(metrics.parseOk + metrics.repairOk + metrics.errorCards);
      expect(metrics.parseSuccessRate + metrics.errorCardRate).toBeCloseTo(1, 10);
      expect(metrics.lintFlagRate).toBeGreaterThanOrEqual(0);
      expect(metrics.lintFlagRate).toBeLessThanOrEqual(1);
    }
  });

  it('坏样本基线指标处于预期区间（存在错误卡与 lint 命中，防基线空转）', async () => {
    const { cases, results } = await loadAll();
    const badResults = cases.filter((c) => c.set === 'bad').map((c) => results.get(c.id)!);
    const metrics = computeMetrics(badResults);
    // 坏样本集必须真实产生错误卡与 lint 命中，否则说明夹具失效
    expect(metrics.errorCards).toBeGreaterThan(0);
    expect(metrics.lintFlagged).toBeGreaterThan(0);
    expect(metrics.repairOk).toBeGreaterThan(0);
    expect(metrics.parseOk).toBeGreaterThan(0);
  });
});

describe('解析器复刻单元行为（与生产 Rust 单测同场景锚定）', () => {
  it('字符串内的分隔符文本不触发切卡', () => {
    const state = {
      buffer: '{"front": "关于 <<<ANKI_CARD_JSON_END>>> 的卡", "back": "A"}<<<ANKI_CARD_JSON_END>>>',
    };
    const first = extractCardFromBuffer(state);
    expect(first.kind).toBe('card');
    expect(first.content).toContain('<<<ANKI_CARD_JSON_END>>>');
    expect(JSON.parse(first.content).front).toContain('<<<ANKI_CARD_JSON_END>>>');
  });

  it('半包 JSON 跨 chunk 补齐后无需分隔符即切卡', () => {
    const state = { buffer: '{"front": "Q", "ba' };
    expect(extractCardFromBuffer(state).kind).toBe('wait');
    state.buffer += 'ck": "A"}';
    const result = extractCardFromBuffer(state);
    expect(result.kind).toBe('card');
    expect(JSON.parse(result.content)).toEqual({ front: 'Q', back: 'A' });
  });

  it('空分隔符段被静默消费（对齐 Rust None 语义）', () => {
    const state = { buffer: '<<<ANKI_CARD_JSON_END>>>rest' };
    expect(extractCardFromBuffer(state).kind).toBe('consumed_empty');
    expect(state.buffer).toBe('rest');
  });

  it('clean_json_string 剥围栏/BOM 并截取对象', () => {
    expect(cleanJsonString('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(cleanJsonString('\uFEFF{"a":1}')).toBe('{"a":1}');
    expect(cleanJsonString('前缀噪声 {"a":1} 后缀')).toBe('{"a":1}');
  });
});

describe('lint 规则（Rust anki_qa_lint 契约对齐后）', () => {
  it('空 cloze 命中 cloze_empty_answer，合法 cloze 不命中', () => {
    expect(lintCard({ text: '答案是 {{c1::}}。' })).toContain(LINT_CODES.CLOZE_EMPTY_ANSWER);
    expect(lintCard({ text: '答案是 {{c1::线粒体}}。' })).toEqual([]);
  });

  it('答案泄露命中 answer_leak，短 token 重叠不误报', () => {
    expect(lintCard({ front: '答案是 O(n log n) 吗？', back: 'O(n log n)' })).toContain(
      LINT_CODES.ANSWER_LEAK
    );
    expect(lintCard({ front: 'HTTP/2 的改进？', back: '多路复用与 HPACK。' })).toEqual([]);
  });

  it('客套话与占位符分别命中 filler_phrase / placeholder_text（eval-only 码）', () => {
    expect(lintCard({ front: 'Q', back: '好的，以下是答案：X' })).toContain(LINT_CODES.FILLER_PHRASE);
    expect(lintCard({ front: 'Q', back: 'TODO' })).toContain(LINT_CODES.PLACEHOLDER_TEXT);
  });

  it('front==back 命中 front_back_identical 且 answer_leak 让位（不双报）', () => {
    const codes = lintCard({ front: '牛顿第一定律', back: '牛顿第一定律' });
    expect(codes).toContain(LINT_CODES.FRONT_BACK_IDENTICAL);
    expect(codes).not.toContain(LINT_CODES.ANSWER_LEAK);
  });

  it('cloze 破损三态：unclosed / bad_index / missing（码与 Rust 一致）', () => {
    expect(lintCard({ text: '沸点是 {{c1::100 摄氏度' })).toContain(LINT_CODES.CLOZE_UNCLOSED);
    expect(lintCard({ text: '沸点是 {{c0::100}} 摄氏度' })).toContain(LINT_CODES.CLOZE_BAD_INDEX);
    expect(lintCard({ front: '沸点', back: '100℃', text: '水的沸点是 100 摄氏度' })).toContain(
      LINT_CODES.CLOZE_MISSING
    );
  });

  it('front 含合法 cloze 字面量不误报 placeholder_residue（元语法边界）', () => {
    expect(lintCard({ front: 'cloze 语法 {{c1::答案}} 中 c1 表示什么？', back: '第一个挖空的序号' })).toEqual(
      []
    );
    expect(lintCard({ front: '请总结 {{DOCUMENT_CONTENT}}', back: '内容' })).toContain(
      LINT_CODES.PLACEHOLDER_RESIDUE
    );
  });

  it('cloze 序号 u32 溢出判 cloze_bad_index（与 Rust digits.parse::<u32>() 同界）', () => {
    // u32::MAX = 4294967295：恰好等于上界合法，+1 即非法
    expect(lintCard({ text: '产物是 {{c4294967295::葡萄糖}}。' })).toEqual([]);
    expect(lintCard({ text: '产物是 {{c4294967296::葡萄糖}}。' })).toContain(LINT_CODES.CLOZE_BAD_INDEX);
    expect(lintCard({ text: '产物是 {{c99999999999::葡萄糖}} 和 {{c2::氧气}}。' })).toEqual([
      LINT_CODES.CLOZE_BAD_INDEX,
    ]);
  });

  it('answer_leak 最小长度按 Unicode 码点计（4 码点起判，短答案回显不误报）', () => {
    // 归一化后 back 恰好 4 码点且被 front 包含 → 命中
    expect(lintCard({ front: '答案是 abcd 吗？', back: 'abcd' })).toContain(LINT_CODES.ANSWER_LEAK);
    // 3 码点 → 低于阈值不判泄露（Rust answer_leak_min_chars=4）
    expect(lintCard({ front: '答案是 abc 吗？', back: 'abc' })).toEqual([]);
    // 单字「否」被 front 字面包含也不误报（g09 fixture 的单测锚点）
    expect(lintCard({ front: '是否成立？答案填是或否。', back: '否' })).toEqual([]);
  });

  it('xxx_residue 独立 token 边界：两侧非字母数字才命中（g10/31 fixture 锚点）', () => {
    expect(lintCard({ front: '第几页？', back: '见教材第 xxx 页' })).toContain(LINT_CODES.XXX_RESIDUE);
    expect(lintCard({ front: 'fooxxxbar 合法吗？', back: '合法的变量名' })).toEqual([]);
  });

  it('empty_brackets 空括号对命中，非空括号与书名号不误报（32 fixture 锚点）', () => {
    expect(lintCard({ front: '作者是（）', back: '曹雪芹' })).toContain(LINT_CODES.EMPTY_BRACKETS);
    expect(lintCard({ front: '《红楼梦》的作者（清代）是谁？', back: '曹雪芹' })).toEqual([]);
  });

  it('front_too_long 阈值为严格大于 220 可见字符（off-by-one 边界，g11 锚点）', () => {
    const at = '问'.repeat(219) + '？';
    const over = '问'.repeat(220) + '？';
    expect(lintCard({ front: at, back: '答案' })).toEqual([]);
    expect(lintCard({ front: over, back: '答案' })).toEqual([LINT_CODES.FRONT_TOO_LONG]);
  });

  it('结构化 issue 形状对齐 Rust LintIssue：{code, field}', async () => {
    // @ts-expect-error 共享 .mjs 模块无类型声明
    const { lintCardIssues } = await import('../../../../scripts/anki-eval/lib/cardLint.mjs');
    const issues = lintCardIssues({ front: '什么是尾递归优化？', back: '   ' });
    expect(issues).toEqual([{ code: 'empty_back', field: 'back' }]);
  });
});
