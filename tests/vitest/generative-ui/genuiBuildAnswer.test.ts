/**
 * buildGenerativeUIAnswer / validateGenerativeUIAnswer（方案 1.4 / 1.5 答案校验规则）
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { choicePropsSchema, formPropsSchema } from '@/features/generative-ui/schema';
import {
  buildChoiceAnswer,
  buildFormAnswer,
  buildGenerativeUIAnswer,
  sanitizeGenerativeUIAnswerSummary,
  validateGenerativeUIAnswer,
  type GenerativeUIInteractiveDraft,
} from '@/features/generative-ui/interaction/buildAnswer';
import { validateIntentRules } from '@/features/generative-ui/validateIntentRules';
import { countGenuiChars } from '@/features/generative-ui/interaction/limits';

const single = choicePropsSchema.parse({
  question: '1+1=?',
  options: [
    { id: 'a', label: '1' },
    { id: 'b', label: '2' },
    { id: 'c', label: '3' },
  ],
});
const multiple = choicePropsSchema.parse({
  question: '选两个',
  mode: 'multiple',
  minSelect: 2,
  maxSelect: 2,
  allowOther: true,
  options: [
    { id: 'a', label: 'A' },
    { id: 'b', label: 'B' },
    { id: 'c', label: 'C' },
  ],
});
const optionalChoice = choicePropsSchema.parse({ ...single, required: false });
const form = formPropsSchema.parse({
  fields: [
    { name: 'goal', label: '目标', kind: 'text', required: true, maxLength: 10 },
    { name: 'age', label: '年龄', kind: 'number', min: 0, max: 120, unit: '岁' },
    { name: 'mins', label: '分钟', kind: 'slider', min: 10, max: 60, step: 10 },
    { name: 'stars', label: '评分', kind: 'rating' },
    { name: 'remind', label: '提醒', kind: 'switch' },
  ],
});

const codes = (r: unknown) => ((r as { issues?: Array<{ code: string }> }).issues ?? []).map((i) => i.code);

describe('buildChoiceAnswer', () => {
  it('single exactly one, ordered by options, dedupes', () => {
    expect(buildChoiceAnswer('q', single, { selected: ['b', 'b'] })).toEqual({ answer: { selected: ['b'] }, issues: [] });
    expect(codes(buildChoiceAnswer('q', single, { selected: [] }))).toEqual(['choice_required']);
    expect(codes(buildChoiceAnswer('q', single, { selected: ['a', 'b'] }))).toEqual(['choice_too_many']);
    expect(codes(buildChoiceAnswer('q', single, { selected: ['zz'] }))).toContain('choice_unknown_option');
  });

  it('required=false allows zero', () => {
    expect(buildChoiceAnswer('q', optionalChoice, { selected: [] }).issues).toEqual([]);
  });

  it('multiple bounds with other counted', () => {
    expect(buildChoiceAnswer('m', multiple, { selected: ['c', 'a'] })).toEqual({ answer: { selected: ['a', 'c'] }, issues: [] });
    expect(buildChoiceAnswer('m', multiple, { selected: ['a'], other: ' 自定义 ' })).toEqual({
      answer: { selected: ['a'], other: '自定义' },
      issues: [],
    });
    expect(codes(buildChoiceAnswer('m', multiple, { selected: ['a'] }))).toEqual(['choice_too_few']);
    expect(codes(buildChoiceAnswer('m', multiple, { selected: ['a', 'b'], other: 'x' }))).toEqual(['choice_too_many']);
    expect(codes(buildChoiceAnswer('m', multiple, { selected: ['a'], other: 'x'.repeat(501) }))).toContain('choice_other_too_long');
  });

  it('other requires allowOther; blank other ignored', () => {
    expect(codes(buildChoiceAnswer('q', single, { selected: [], other: 'x' }))).toContain('choice_other_not_allowed');
    expect(buildChoiceAnswer('q', single, { selected: ['a'], other: '   ' })).toEqual({ answer: { selected: ['a'] }, issues: [] });
  });
});

describe('buildFormAnswer', () => {
  it('normalizes values, optional empty → null, switch default false', () => {
    const r = buildFormAnswer('f', form, { goal: ' 考研 ', age: '18', mins: 30, stars: 4 });
    expect(r.issues).toEqual([]);
    expect(r.answer).toEqual({ goal: '考研', age: 18, mins: 30, stars: 4, remind: false });
    const empty = buildFormAnswer('f', form, { goal: 'x', age: '' });
    expect(empty.answer).toMatchObject({ age: null, mins: null, stars: null });
  });

  it.each([
    [{ goal: '' }, 'field_required'],
    [{ goal: 'x'.repeat(11) }, 'field_too_long'],
    [{ goal: 'x', age: 121 }, 'field_out_of_range'],
    [{ goal: 'x', age: 'abc' }, 'field_not_number'],
    [{ goal: 'x', age: Number.NaN }, 'field_not_number'],
    [{ goal: 'x', mins: 5 }, 'field_out_of_range'],
    [{ goal: 'x', mins: 25 }, 'field_step_mismatch'],
    [{ goal: 'x', stars: 6 }, 'field_out_of_range'],
    [{ goal: 'x', stars: 2.5 }, 'field_out_of_range'],
    [{ goal: 'x', stars: 0 }, 'field_out_of_range'],
    [{ goal: 'x', remind: 'yes' }, 'field_invalid'],
  ])('%j → %s', (state, code) => {
    expect(codes(buildFormAnswer('f', form, state))).toContain(code);
  });

  it('slider step tolerance for floats', () => {
    const f = formPropsSchema.parse({ fields: [{ name: 's', label: 'S', kind: 'slider', min: 0, max: 1, step: 0.1 }] });
    expect(buildFormAnswer('f', f, { s: 0.3 }).issues).toEqual([]);
  });
});

describe('buildGenerativeUIAnswer', () => {
  const drafts = (choiceState: { selected: string[]; other?: string }, formState: Record<string, unknown>): GenerativeUIInteractiveDraft[] => [
    { type: 'choice', blockId: 'q1', props: multiple, state: choiceState },
    { type: 'form', blockId: 'f1', props: form, state: formState as never },
  ];

  it('builds payload with label summary', () => {
    const r = buildGenerativeUIAnswer(drafts({ selected: ['a'], other: '其它' }, { goal: '考研', age: 20, remind: true, stars: 5 }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.data).toEqual({
      q1: { selected: ['a'], other: '其它' },
      f1: { goal: '考研', age: 20, mins: null, stars: 5, remind: true },
    });
    expect(r.payload.summary).toBe('选两个：A、其他：其它\n目标：考研；年龄：20岁；评分：5/5；提醒：是');
  });

  it('collects issues instead of building', () => {
    const r = buildGenerativeUIAnswer(drafts({ selected: [] }, {}));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(codes(r)).toEqual(expect.arrayContaining(['choice_required', 'field_required']));
  });

  it('custom labels (i18n)', () => {
    const r = buildGenerativeUIAnswer(
      [{ type: 'form', blockId: 'f', props: formPropsSchema.parse({ fields: [{ name: 'on', label: 'On', kind: 'switch' }] }), state: { on: false } }],
      { labels: { keyValueSeparator: ': ', no: 'No' } },
    );
    expect(r.ok && r.payload.summary).toBe('On: No');
  });

  it('truncates summary to 500 code points and keeps it non-empty', () => {
    const longQ = choicePropsSchema.parse({
      question: '问'.repeat(300),
      mode: 'multiple',
      options: Array.from({ length: 12 }, (_, i) => ({ id: `o${i}`, label: `选项${'长'.repeat(110)}${i}` })),
    });
    const r = buildGenerativeUIAnswer([
      { type: 'choice', blockId: 'q', props: longQ, state: { selected: longQ.options.map((o) => o.id) } },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(countGenuiChars(r.payload.summary)).toBe(500);
      expect(r.payload.summary.endsWith('…')).toBe(true);
    }
    const empty = buildGenerativeUIAnswer([{ type: 'choice', blockId: 'q', props: optionalChoice, state: { selected: [] } }]);
    expect(empty.ok && empty.payload.summary).toBe('1+1=?：（未选择）');
  });

  it('rejects data over 16000 chars', () => {
    const big = formPropsSchema.parse({
      fields: Array.from({ length: 12 }, (_, i) => ({ name: `t${i}`, label: 'T', kind: 'text', maxLength: 2000 })),
    });
    const state = Object.fromEntries(big.fields.map((f) => [f.name, 'x'.repeat(2000)]));
    const r = buildGenerativeUIAnswer([{ type: 'form', blockId: 'f', props: big, state }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(codes(r)).toEqual(['data_too_large']);
  });

  it('rejects empty and duplicate drafts', () => {
    expect(buildGenerativeUIAnswer([])).toMatchObject({ ok: false });
    const d: GenerativeUIInteractiveDraft = { type: 'choice', blockId: 'q', props: single, state: { selected: ['a'] } };
    const r = buildGenerativeUIAnswer([d, d]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(codes(r)).toEqual(['duplicate_block']);
  });

  it('sanitizes control characters except \\n and \\t', () => {
    expect(sanitizeGenerativeUIAnswerSummary(' a\u0000b\u0007\tc\nd\u009f ')).toBe('ab\tc\nd');
  });
});

describe('validateGenerativeUIAnswer (strict payload)', () => {
  const spec = {
    blocks: [
      { type: 'choice' as const, blockId: 'q1', props: single },
      { type: 'form' as const, blockId: 'f1', props: form },
    ],
  };

  it('accepts a well-formed payload and rebuilds in spec order', () => {
    const r = validateGenerativeUIAnswer(spec, ' ok ', {
      f1: { goal: 'x', age: null, mins: 20, stars: 3, remind: true },
      q1: { selected: ['c'] },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload.summary).toBe('ok');
      expect(Object.keys(r.payload.data)).toEqual(['q1', 'f1']);
    }
  });

  it.each([
    ['empty summary', '  ', { q1: { selected: ['a'] }, f1: { goal: 'x' } }],
    ['summary > 500', 'x'.repeat(501), { q1: { selected: ['a'] }, f1: { goal: 'x' } }],
    ['data not object', 's', []],
    ['unknown block key', 's', { q1: { selected: ['a'] }, f1: { goal: 'x' }, zz: {} }],
    ['missing required block', 's', { f1: { goal: 'x' } }],
    ['number as string', 's', { q1: { selected: ['a'] }, f1: { goal: 'x', age: '18' } }],
    ['unknown form field', 's', { q1: { selected: ['a'] }, f1: { goal: 'x', hack: 1 } }],
    ['selected not array', 's', { q1: { selected: 'a' }, f1: { goal: 'x' } }],
    ['choice extra key', 's', { q1: { selected: ['a'], note: 'x' }, f1: { goal: 'x' } }],
  ])('rejects %s', (_n, summary, data) => {
    expect(validateGenerativeUIAnswer(spec, summary, data).ok).toBe(false);
  });
});

const FIXTURES_PATH = path.join(
  process.cwd(),
  'src-tauri/crates/dstu-agent/src/chat_v2/tools/genui_intent_rules_fixtures.json',
);
const fixturesExist = fs.existsSync(FIXTURES_PATH);

interface AnswerFixture {
  name: string;
  intent: unknown;
  summary: unknown;
  data: unknown;
  ok: boolean;
}

describe.skipIf(!fixturesExist)('validateGenerativeUIAnswer ↔ Rust answer fixtures parity', () => {
  const fixtures: { answer?: AnswerFixture[] } = fixturesExist ? JSON.parse(fs.readFileSync(FIXTURES_PATH, 'utf8')) : {};
  const cases = fixtures.answer ?? [];

  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const rules = validateIntentRules(c.intent, { mode: 'tool', awaitAnswer: true });
    expect(rules.ok, rules.ok ? '' : `fixture intent rejected by TS rules: ${(rules as { error?: string }).error}`).toBe(true);
    const spec = (rules as { spec?: Parameters<typeof validateGenerativeUIAnswer>[0] | null }).spec;
    if (!spec) return;
    const r = validateGenerativeUIAnswer(spec, c.summary, c.data);
    expect(r.ok, r.ok ? 'TS accepted' : `TS rejected: ${JSON.stringify((r as { issues?: unknown }).issues)}`).toBe(c.ok);
  });
});

describe('Rust parity details', () => {
  it('null block value counts as absent', () => {
    const optSpec = { blocks: [{ type: 'choice' as const, blockId: 'q', props: optionalChoice }] };
    expect(validateGenerativeUIAnswer(optSpec, 's', { q: null }).ok).toBe(true);
    const reqSpec = { blocks: [{ type: 'choice' as const, blockId: 'q', props: single }] };
    expect(validateGenerativeUIAnswer(reqSpec, 's', { q: null }).ok).toBe(false);
  });

  it('strips control chars from text and other', () => {
    expect(buildFormAnswer('f', form, { goal: 'a\u0000b' }).answer.goal).toBe('ab');
    expect(buildChoiceAnswer('m', multiple, { selected: ['a'], other: 'x\u0007y' }).answer.other).toBe('xy');
  });

  it('optional switch may be null in strict payload, required may not', () => {
    const f = formPropsSchema.parse({
      fields: [
        { name: 'a', label: 'A', kind: 'switch' },
        { name: 'b', label: 'B', kind: 'switch', required: true },
      ],
    });
    const spec = { blocks: [{ type: 'form' as const, blockId: 'f', props: f }] };
    expect(validateGenerativeUIAnswer(spec, 's', { f: { a: null, b: true } })).toMatchObject({
      ok: true,
      payload: { data: { f: { a: null, b: true } } },
    });
    expect(validateGenerativeUIAnswer(spec, 's', { f: { a: true } }).ok).toBe(false);
  });
});
