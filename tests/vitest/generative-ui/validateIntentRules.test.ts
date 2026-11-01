/**
 * validateIntentRules — Rust validate_genui_intent_rules 的 TS 镜像（方案 1.1 / 1.5 / 6）
 *
 * 一致性：读 WP-A 的 genui_intent_rules_fixtures.json，逐条比对 ok；
 * fixtures 尚未落地时跳过该组。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  GENUI_INTERACTIVE_REQUIRES_AWAIT_MESSAGE,
  isInlineSafeActionId,
  validateIntentRules,
} from '@/features/generative-ui/validateIntentRules';

const FIXTURES_PATH = path.join(
  process.cwd(),
  'src-tauri/crates/dstu-agent/src/chat_v2/tools/genui_intent_rules_fixtures.json',
);
const fixturesExist = fs.existsSync(FIXTURES_PATH);

interface IntentFixture {
  name: string;
  awaitAnswer?: boolean;
  intent: unknown;
  ok: boolean;
  errorContains?: string;
}

const choice = (id: string | undefined, extra: Record<string, unknown> = {}) => ({
  type: 'choice',
  ...(id === undefined ? {} : { id }),
  props: {
    question: '1+1=?',
    options: [
      { id: 'a', label: '1' },
      { id: 'b', label: '2' },
    ],
    ...extra,
  },
});
const form = (id: string) => ({
  type: 'form',
  id,
  props: { fields: [{ name: 'goal', label: '目标', kind: 'text', required: true }] },
});
const image = (source: unknown) => ({ type: 'image', props: { source, alt: 'x' } });
const actionBar = (actions: unknown[]) => ({ type: 'action-bar', props: { actions } });
const intentOf = (...blocks: unknown[]) => ({ version: '1', blocks });

describe('validateIntentRules — tool mode', () => {
  it('display-only intent passes without awaitAnswer and returns no spec', () => {
    const r = validateIntentRules(intentOf({ type: 'text', props: { body: 'x' } }), { mode: 'tool' });
    expect(r).toEqual({ ok: true, spec: null });
  });

  it('await with choice + form returns spec with defaults applied', () => {
    const r = validateIntentRules(intentOf(choice('q1'), { type: 'text', props: { body: 'x' } }, form('f1')), {
      mode: 'tool',
      awaitAnswer: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spec!.blocks.map((b) => [b.type, b.blockId])).toEqual([
      ['choice', 'q1'],
      ['form', 'f1'],
    ]);
    const c = r.spec!.blocks[0]!;
    expect(c.type === 'choice' && c.props.mode).toBe('single');
  });

  it('rejects choice/form without awaitAnswer', () => {
    const r = validateIntentRules(intentOf(choice('q1')), { mode: 'tool' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r).toMatchObject({ code: 'interactive_requires_await' });
      expect((r as { error?: string }).error).toContain(GENUI_INTERACTIVE_REQUIRES_AWAIT_MESSAGE);
    }
  });

  it('rejects awaitAnswer without interactive blocks', () => {
    const r = validateIntentRules(intentOf({ type: 'text', props: { body: 'x' } }), { mode: 'tool', awaitAnswer: true });
    expect(r).toMatchObject({ ok: false, code: 'await_requires_interactive' });
  });

  it('allows 4 interactive blocks, rejects 5', () => {
    const four = intentOf(choice('a'), choice('b'), form('c'), form('d'));
    expect(validateIntentRules(four, { mode: 'tool', awaitAnswer: true }).ok).toBe(true);
    const five = intentOf(choice('a'), choice('b'), form('c'), form('d'), choice('e'));
    expect(validateIntentRules(five, { mode: 'tool', awaitAnswer: true })).toMatchObject({ ok: false, code: 'too_many_interactive' });
  });

  it.each([
    ['missing id', intentOf(choice(undefined))],
    ['bad id', intentOf(choice('has space'))],
    ['id > 64', intentOf(choice('x'.repeat(65)))],
  ])('rejects interactive block with %s', (_n, intent) => {
    expect(validateIntentRules(intent, { mode: 'tool', awaitAnswer: true })).toMatchObject({ ok: false, code: 'interactive_id_invalid' });
  });

  it('rejects duplicate ids (including against non-interactive blocks)', () => {
    expect(validateIntentRules(intentOf(choice('q'), choice('q')), { mode: 'tool', awaitAnswer: true })).toMatchObject({
      ok: false,
      code: 'interactive_id_duplicate',
    });
    expect(
      validateIntentRules(intentOf(choice('q'), { type: 'text', id: 'q', props: { body: 'x' } }), { mode: 'tool', awaitAnswer: true }),
    ).toMatchObject({ ok: false, code: 'interactive_id_duplicate' });
  });

  it('rejects invalid interactive props', () => {
    expect(
      validateIntentRules(intentOf(choice('q', { options: [{ id: 'a', label: 'A' }] })), { mode: 'tool', awaitAnswer: true }),
    ).toMatchObject({ ok: false, code: 'interactive_props_invalid' });
  });

  it('validates image sources and counts option images + image blocks (<= 8)', () => {
    const ok = intentOf(image({ kind: 'resource', resourceId: 'img_1' }));
    expect(validateIntentRules(ok, { mode: 'tool' }).ok).toBe(true);
    expect(validateIntentRules(intentOf(image({ kind: 'url', url: 'http://a.com/x.png' })), { mode: 'tool' })).toMatchObject({
      ok: false,
      code: 'image_source_invalid',
    });
    expect(validateIntentRules(intentOf(image(undefined)), { mode: 'tool' })).toMatchObject({ ok: false, code: 'image_source_invalid' });

    const src = { kind: 'resource', resourceId: 'img_1' };
    const optionImages = choice('q', {
      options: Array.from({ length: 4 }, (_, i) => ({ id: `o${i}`, label: 'x', image: src })),
    });
    const eight = intentOf(optionImages, ...Array.from({ length: 4 }, () => image(src)));
    expect(validateIntentRules(eight, { mode: 'tool', awaitAnswer: true }).ok).toBe(true);
    const nine = intentOf(optionImages, ...Array.from({ length: 5 }, () => image(src)));
    expect(validateIntentRules(nine, { mode: 'tool', awaitAnswer: true })).toMatchObject({ ok: false, code: 'too_many_images' });
  });

  it('followup rules: prompt required, <= 500, id shape, <= 4 per intent', () => {
    const fu = (i: number, prompt: unknown = 'p') => ({ id: `followup:f${i}`, label: 'L', prompt });
    expect(validateIntentRules(intentOf(actionBar([fu(1)])), { mode: 'tool' }).ok).toBe(true);
    expect(validateIntentRules(intentOf(actionBar([{ id: 'followup:x', label: 'L' }])), { mode: 'tool' })).toMatchObject({
      ok: false,
      code: 'followup_invalid',
    });
    expect(validateIntentRules(intentOf(actionBar([fu(1, 'x'.repeat(501))])), { mode: 'tool' })).toMatchObject({
      ok: false,
      code: 'followup_invalid',
    });
    expect(validateIntentRules(intentOf(actionBar([{ id: 'followup:BAD', label: 'L', prompt: 'p' }])), { mode: 'tool' })).toMatchObject({
      ok: false,
      code: 'followup_invalid',
    });
    expect(validateIntentRules(intentOf(actionBar([{ id: 'copy-intent', label: 'L', prompt: 'p' }])), { mode: 'tool' })).toMatchObject({
      ok: false,
      code: 'followup_invalid',
    });
    // 跨 action-bar 计数
    const split = intentOf(actionBar([fu(1), fu(2), fu(3)]), actionBar([fu(4), fu(5)]));
    expect(validateIntentRules(split, { mode: 'tool' })).toMatchObject({ ok: false, code: 'too_many_followups' });
    const four = intentOf(actionBar([fu(1), fu(2)]), actionBar([fu(3), fu(4)]));
    expect(validateIntentRules(four, { mode: 'tool' }).ok).toBe(true);
  });

  it('rejects non-object intent', () => {
    expect(validateIntentRules(null, { mode: 'tool' })).toMatchObject({ ok: false, code: 'intent_invalid' });
    expect(validateIntentRules({ blocks: 'x' }, { mode: 'tool' })).toMatchObject({ ok: false, code: 'intent_invalid' });
  });
});

describe('validateIntentRules — inline mode', () => {
  it('accepts display blocks with inline-safe actions and images', () => {
    const r = validateIntentRules(
      intentOf(
        { type: 'stat-card', props: { title: 't', value: 1 } },
        image({ kind: 'url', url: 'https://example.com/a.png' }),
        actionBar([
          { id: 'copy-block', label: 'c' },
          { id: 'copy-intent', label: 'c' },
          { id: 'open-note:note_1', label: 'n' },
          { id: 'open-pdf-page:res_1:3', label: 'p' },
        ]),
      ),
      { mode: 'inline' },
    );
    expect(r).toEqual({ ok: true, spec: null });
  });

  it('ignores awaitAnswer option and rejects choice/form', () => {
    expect(validateIntentRules(intentOf(choice('q')), { mode: 'inline', awaitAnswer: true })).toMatchObject({
      ok: false,
      code: 'inline_interactive_forbidden',
    });
    expect(validateIntentRules(intentOf(form('f')), { mode: 'inline' })).toMatchObject({ ok: false, code: 'inline_interactive_forbidden' });
  });

  it.each([
    ['followup', { id: 'followup:x', label: 'L', prompt: 'p' }],
    ['apply-note-edit', { id: 'apply-note-edit', label: 'L' }],
    ['dismiss-note-suggestion', { id: 'dismiss-note-suggestion', label: 'L' }],
    ['export-intent', { id: 'export-intent', label: 'L' }],
    ['bare open-note prefix', { id: 'open-note:', label: 'L' }],
  ])('rejects %s action', (_n, action) => {
    expect(validateIntentRules(intentOf(actionBar([action])), { mode: 'inline' })).toMatchObject({
      ok: false,
      code: 'inline_action_forbidden',
    });
  });

  it.each([
    ['meta.researchSessionId', { version: '1', blocks: [], meta: { researchSessionId: 'r1' } }],
    ['top-level researchSessionId', { version: '1', blocks: [], researchSessionId: 'r1' }],
    ['noteEdit', { version: '1', blocks: [], noteEdit: { operation: 'append', content: 'x' } }],
    ['awaitAnswer', { version: '1', blocks: [], awaitAnswer: true }],
  ])('rejects %s', (_n, intent) => {
    expect(validateIntentRules(intent, { mode: 'inline' })).toMatchObject({ ok: false, code: 'inline_field_forbidden' });
  });

  it('isInlineSafeActionId', () => {
    expect(isInlineSafeActionId('copy-block')).toBe(true);
    expect(isInlineSafeActionId('open-pdf:res_1')).toBe(true);
    expect(isInlineSafeActionId('apply-note-edit')).toBe(false);
    expect(isInlineSafeActionId(undefined)).toBe(false);
  });
});

describe.skipIf(!fixturesExist)('validateIntentRules ↔ Rust fixtures parity', () => {
  const fixtures: { intent?: IntentFixture[] } = fixturesExist
    ? JSON.parse(fs.readFileSync(FIXTURES_PATH, 'utf8'))
    : {};
  const cases = fixtures.intent ?? [];

  it('fixtures file has intent cases', () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const r = validateIntentRules(c.intent, { mode: 'tool', awaitAnswer: c.awaitAnswer === true });
    expect(r.ok, r.ok ? 'TS accepted' : `TS rejected: ${(r as { error?: string }).error}`).toBe(c.ok);
  });
});

describe('validateIntentRules — Rust parity details', () => {
  it('rejects non-object blocks', () => {
    expect(validateIntentRules({ blocks: [1] }, { mode: 'tool' })).toMatchObject({ ok: false, code: 'intent_invalid' });
  });

  it('validates image block props (alt required, fit enum, maxHeight range)', () => {
    const src = { kind: 'resource', resourceId: 'img_1' };
    expect(validateIntentRules(intentOf({ type: 'image', props: { source: src } }), { mode: 'tool' })).toMatchObject({
      ok: false,
      code: 'image_props_invalid',
    });
    expect(validateIntentRules(intentOf({ type: 'image', props: { source: src, alt: 'a', fit: 'fill' } }), { mode: 'tool' }).ok).toBe(false);
    expect(validateIntentRules(intentOf({ type: 'image', props: { source: src, alt: 'a', maxHeight: 641 } }), { mode: 'tool' }).ok).toBe(false);
  });

  it('rejects blank choice question / option label (trimmed)', () => {
    expect(validateIntentRules(intentOf(choice('q', { question: '   ' })), { mode: 'tool', awaitAnswer: true }).ok).toBe(false);
    expect(
      validateIntentRules(intentOf(choice('q', { options: [{ id: 'a', label: ' ' }, { id: 'b', label: 'B' }] })), {
        mode: 'tool',
        awaitAnswer: true,
      }).ok,
    ).toBe(false);
  });

  it('rejects non-boolean confirm and backslash / control chars in image url', () => {
    expect(validateIntentRules(intentOf(actionBar([{ id: 'copy-intent', label: 'L', confirm: 'yes' }])), { mode: 'tool' }).ok).toBe(false);
    for (const url of ['https://example.com/a\b.png', 'https://example.com/a\u0001.png', 'https://example.com/a..%2E%2e/x']) {
      expect(validateIntentRules(intentOf(image({ kind: 'url', url })), { mode: 'tool' }).ok, url).toBe(false);
    }
  });
});
