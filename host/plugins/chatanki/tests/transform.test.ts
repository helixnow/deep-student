import { describe, expect, it } from 'vitest';
import type { AnkiCard, ChatAnkiAsyncNativeRegex } from '../api.ts';
import {
  CHATANKI_TRANSFORM_FIELD_GROWTH_MAX_BYTES, CHATANKI_TRANSFORM_OPS_LIMIT,
  CHATANKI_TRANSFORM_REPLACEMENT_MAX_LEN, CHATANKI_TRANSFORM_TAG_MAX_CHARS,
  applyTransformOpsAsync, changedFieldNames, checkExpectedVersions, compileTransformOpsAsync,
  normalizeTransformArgs, parseTransformArgs, planTransformOpsAsync, selectTransformCards,
  transformFieldsAreValid, transformFieldsFromCard,
  type NormalizedTransformOp, type NormalizedTransformSelection, type TransformFields,
} from '../src/transform.ts';
import { regex as nativeRegexEngine } from '../../../platform/native/regex/index.ts';

const compile = (ops: NormalizedTransformOp[]) => compileTransformOpsAsync(ops, nativeRegexEngine);

const fields = (front: string, back: string, text: string | null, tags: string[]): TransformFields => ({ front, back, text, tags });

function makeCard(id: string, isError: boolean, edited: boolean): AnkiCard {
  return {
    front: `front-${id}`, back: `back-${id}`, text: null, tags: [], images: [], id,
    task_id: 'task-1', is_error_card: isError, error_content: null,
    created_at: '2026-08-24T00:00:00Z',
    updated_at: edited ? '2026-08-24T01:00:00Z' : '2026-08-24T00:00:00Z',
    extra_fields: {}, template_id: null,
  };
}

const parse = (raw: unknown) => normalizeTransformArgs(parseTransformArgs(raw));
const op = async (value: NormalizedTransformOp) => compile([value]);

describe('chatanki_transform.rs', () => {
  it('normalize_rejects_script_and_ops_together', () => {
    const error = (() => { try { parse({ documentId: 'doc-1', transform: {
      script: { language: 'python', code: 'print(1)' }, ops: [{ op: 'tag_add', tags: ['x'] }] } }); } catch (error) { return error as Error; } })();
    expect(error!.message).toContain('mutually exclusive');
  });

  it('normalize_requires_script_or_ops', () => {
    expect(() => parse({ documentId: 'doc-1', transform: {} })).toThrow('exactly one of script or ops');
  });

  it('normalize_script_mode_carries_language_code_and_default_timeout', () => {
    const request = parse({ documentId: 'doc-1', transform: { script: { language: 'python', code: 'print(1)' } } });
    expect(request.script).toEqual({ language: 'python', code: 'print(1)', timeoutMs: 30_000 });
    expect(request.ops).toBeNull();
    expect(request.mode).toBe('dry_run');
  });

  it('normalize_script_mode_propagates_script_contract_errors', () => {
    expect(() => parse({ documentId: 'doc-1', transform: { script: { language: 'python', code: '  ' } } }))
      .toThrow('must not be empty');
    expect(() => parse({ documentId: 'doc-1', transform: { script: { language: 'python', code: '1', timeoutMs: 500 } } }))
      .toThrow('1000..=120000');
  });

  it('plan_transform_ops_produces_after_plans_in_selection_order', async () => {
    const compiled = await op({ kind: 'tag_add', tags: ['新'] });
    const plans = await planTransformOpsAsync(
      compiled, [makeCard('card-1', false, false), makeCard('card-2', false, false)], nativeRegexEngine,
    );
    expect(plans).toHaveLength(2);
    for (const plan of plans) {
      expect(plan.kind).toBe('after');
      expect(plan.kind === 'after' && plan.fields.tags).toEqual(['新']);
    }
  });

  it('normalize_defaults_to_dry_run_and_default_live_selection', () => {
    const request = parse({ documentId: ' doc-1 ', transform: { ops: [{ op: 'tag_add', tags: [' 复习 ', '复习'] }] } });
    expect(request.documentId).toBe('doc-1');
    expect(request.mode).toBe('dry_run');
    expect(request.selection).toEqual({ kind: 'default_live' });
    expect(request.expectedVersions).toEqual({});
    expect(request.ops).toEqual([{ kind: 'tag_add', tags: ['复习'] }]);
  });

  it('normalize_apply_requires_expected_versions', () => {
    expect(() => parse({ documentId: 'doc-1', mode: 'apply', transform: { ops: [{ op: 'tag_add', tags: ['x'] }] } }))
      .toThrow('requires expectedVersions');
    expect(() => parse({ documentId: 'doc-1', mode: 'apply', expectedVersions: {}, transform: { ops: [{ op: 'tag_add', tags: ['x'] }] } }))
      .toThrow('requires expectedVersions');
  });

  it('normalize_apply_trims_expected_versions_and_rejects_duplicates', () => {
    const request = parse({ documentId: 'doc-1', mode: 'apply', expectedVersions: { ' card-1 ': ' v1 ' },
      transform: { ops: [{ op: 'tag_add', tags: ['x'] }] } });
    expect(request.expectedVersions['card-1']).toBe('v1');
    expect(() => parse({ documentId: 'doc-1', mode: 'apply',
      expectedVersions: { 'card-1': 'v1', ' card-1 ': 'v2' }, transform: { ops: [{ op: 'tag_add', tags: ['x'] }] } }))
      .toThrow('duplicate normalized card IDs');
  });

  it('normalize_selection_card_ids_and_filter_are_exclusive', () => {
    expect(() => parse({ documentId: 'doc-1', selection: { cardIds: ['card-1'], filter: 'all' },
      transform: { ops: [{ op: 'tag_add', tags: ['x'] }] } })).toThrow('mutually exclusive');
    expect(() => parse({ documentId: 'doc-1', selection: {}, transform: { ops: [{ op: 'tag_add', tags: ['x'] }] } }))
      .toThrow('selection requires');
  });

  it('normalize_selection_rejects_duplicate_card_ids', () => {
    expect(() => parse({ documentId: 'doc-1', selection: { cardIds: ['card-1', ' card-1 '] },
      transform: { ops: [{ op: 'tag_add', tags: ['x'] }] } })).toThrow('duplicate IDs');
  });

  it('normalize_rejects_unknown_op', () => {
    expect(() => parse({ documentId: 'doc-1', transform: { ops: [{ op: 'cloze_wrap', field: 'text', pattern: 'x' }] } }))
      .toThrow('unknown variant');
  });

  it('serde phase matches from_value on the app graph (key order, OneOf, default mode, nested script)', () => {
    const ops = [{ op: 'tag_add', tags: ['x'] }];
    const failure = (raw: unknown): string => {
      try { parseTransformArgs(raw); } catch (error) { return (error as Error).message; }
      return 'ok';
    };
    for (const [raw, expected] of [
      [{}, 'missing field `documentId`'],
      [{ documentId: 'd' }, 'missing field `transform`'],
      // Present fields decode in input order before any missing field is reported.
      [{ transform: { ops: 1 } }, 'invalid type: number, expected a sequence'],
      [{ mode: 'x', documentId: 2 }, 'unknown variant `x`, expected `dry_run` or `apply`'],
      [{ documentId: 2, mode: 'x' }, 'invalid type: number, expected a string'],
      [{ documentId: 'd', extra: 1, transform: { ops } },
        'unknown field `extra`, expected one of `documentId`, `selection`, `mode`, `transform`, `expectedVersions`, `purpose`'],
      // `#[serde(default)] mode` is not Option: an explicit null still has to decode.
      [{ documentId: 'd', mode: null, transform: { ops } }, 'invalid type: null, expected string or map'],
      [{ documentId: 'd', mode: 'preview', transform: { ops } }, 'unknown variant `preview`, expected `dry_run` or `apply`'],
      [{ documentId: 'd', transform: { ops, extra: 1 } }, 'unknown field `extra`, expected `script` or `ops`'],
      [{ documentId: 'd', selection: { ids: [] }, transform: { ops } }, 'unknown field `ids`, expected `cardIds` or `filter`'],
      [{ documentId: 'd', transform: { ops: [{ tags: ['x'] }] } }, 'missing field `op`'],
      [{ documentId: 'd', transform: { ops: [{ op: 'tag_add', field: 'body' }] } },
        'unknown variant `body`, expected one of `front`, `back`, `text`'],
      // TransformScriptSpec decodes inside the serde phase; timeoutMs is u64 under arbitrary_precision.
      [{ documentId: 'd', transform: { script: { language: 'python', code: '1', timeoutMs: -1 } } }, 'invalid number'],
      [{ documentId: 'd', transform: { script: { language: 'python', code: '1', timeoutMs: 1.5 } } }, 'invalid number'],
      [{ documentId: 'd', transform: { script: { language: 'python', code: '1', timeoutMs: '5' } } },
        'invalid type: string "5", expected u64'],
      [{ documentId: 'd', transform: { script: { language: 'python' } } }, 'missing field `code`'],
      [{ documentId: 'd', transform: { script: { code: '1', language: 'ruby' } } },
        'unknown variant `ruby`, expected `python` or `node`'],
    ] as const) {
      expect(failure(raw), JSON.stringify(raw)).toBe(expected);
    }
    expect(parseTransformArgs({ documentId: 'd', mode: { apply: null }, transform: { ops } }).mode).toBe('apply');
    expect(parseTransformArgs({ documentId: 'd', transform: { script: { language: 'node', code: '1', timeoutMs: null } } })
      .transform.script).toEqual({ language: 'node', code: '1', timeoutMs: null });
  });

  it('normalize_regex_replace_requires_field_and_pattern', () => {
    expect(() => parse({ documentId: 'doc-1', transform: { ops: [{ op: 'regex_replace', pattern: 'x' }] } }))
      .toThrow('requires field');
    expect(() => parse({ documentId: 'doc-1', transform: { ops: [{ op: 'regex_replace', field: 'front' }] } }))
      .toThrow('non-empty pattern');
  });

  it('normalize_tag_ops_reject_regex_parameters', () => {
    expect(() => parse({ documentId: 'doc-1', transform: { ops: [{ op: 'tag_remove', tags: ['x'], pattern: 'y' }] } }))
      .toThrow('only accept the tags parameter');
  });

  it('normalize_enforces_ops_limit', () => {
    const ops = Array.from({ length: CHATANKI_TRANSFORM_OPS_LIMIT + 1 }, (_, index) => ({ op: 'tag_add', tags: [`tag-${index}`] }));
    expect(() => parse({ documentId: 'doc-1', transform: { ops } })).toThrow('1..=20');
  });

  it('regex_replace_supports_capture_groups', async () => {
    const compiled = await op({ kind: 'regex_replace', field: 'back', pattern: '(\\d+)ms', replacement: '$1 毫秒' });
    const before = fields('Q', '耗时 30ms 与 45ms', null, []);
    const after = await applyTransformOpsAsync(compiled, before, nativeRegexEngine);
    expect(after.back).toBe('耗时 30 毫秒 与 45 毫秒');
    expect(changedFieldNames(before, after)).toEqual(['back']);
  });

  // chatanki_transform.rs:562-592 expands against captures of the full original
  // field, then replaces all matches in that same field. Re-matching a suffix
  // loses left context and turns `\B(foo)` at offset 1 into no match.
  it('regex_replace_expands_captures_without_losing_left_context', async () => {
    const compiled = await op({ kind: 'regex_replace', field: 'front', pattern: '\\B(foo)', replacement: '<$1>' });
    const after = await applyTransformOpsAsync(compiled, fields('afoo', 'A', null, []), nativeRegexEngine);
    expect(after.front).toBe('a<foo>');
  });

  it('regex_replace_on_null_text_is_noop', async () => {
    const compiled = await op({ kind: 'regex_replace', field: 'text', pattern: 'term', replacement: '{{c1::term}}' });
    const before = fields('Q', 'A', null, []);
    const after = await applyTransformOpsAsync(compiled, before, nativeRegexEngine);
    expect(after).toEqual(before);
    expect(changedFieldNames(before, after)).toEqual([]);
  });

  it('invalid_pattern_reports_op_index', async () => {
    let caught: any;
    try {
      await compile([
        { kind: 'tag_add', tags: ['ok'] },
        { kind: 'regex_replace', field: 'front', pattern: '(unclosed', replacement: '' },
      ]);
    } catch (error) { caught = error; }
    expect(caught.opIndex).toBe(1);
    expect(caught.pattern).toBe('(unclosed');
    expect(caught.error ?? caught.message).toBeTruthy();
  });

  it('tag_add_deduplicates_and_tag_remove_deletes', async () => {
    const compiled = await compile([
      { kind: 'tag_add', tags: ['生物', '重点'] },
      { kind: 'tag_remove', tags: ['草稿'] },
    ]);
    const before = fields('Q', 'A', null, ['生物', '草稿']);
    const after = await applyTransformOpsAsync(compiled, before, nativeRegexEngine);
    expect(after.tags).toEqual(['生物', '重点']);
    expect(changedFieldNames(before, after)).toEqual(['tags']);
  });

  it('ops_apply_in_declared_order', async () => {
    const compiled = await compile([
      { kind: 'regex_replace', field: 'front', pattern: 'cat', replacement: 'dog' },
      { kind: 'regex_replace', field: 'front', pattern: 'dog', replacement: 'wolf' },
    ]);
    expect((await applyTransformOpsAsync(compiled, fields('cat', 'A', null, []), nativeRegexEngine)).front)
      .toBe('wolf');
  });

  it('bounded_replace_preserves_regex_capture_expansion_semantics', async () => {
    const compiled = await op({ kind: 'regex_replace', field: 'front',
      pattern: '(?P<letter>[a-z])|(?P<number>[0-9])', replacement: '${letter}${number}$$' });
    expect((await applyTransformOpsAsync(compiled, fields('ab12', 'A', null, []), nativeRegexEngine)).front)
      .toBe('a$b$1$2$');
  });

  it('security_regex_growth_is_rejected_before_result_allocation', async () => {
    const compiled = await op({ kind: 'regex_replace', field: 'front', pattern: '(?s).',
      replacement: 'x'.repeat(CHATANKI_TRANSFORM_REPLACEMENT_MAX_LEN) });
    let caught: any;
    try {
      await applyTransformOpsAsync(
        compiled, fields('a'.repeat(4096), 'A', null, []), nativeRegexEngine,
      );
    }
    catch (error) { caught = error; }
    expect(caught.opIndex).toBe(0);
    expect(caught.field).toBe('front');
    expect(caught.bytes).toBeGreaterThan(CHATANKI_TRANSFORM_FIELD_GROWTH_MAX_BYTES);
    expect(caught.bytes).toBe(CHATANKI_TRANSFORM_FIELD_GROWTH_MAX_BYTES + CHATANKI_TRANSFORM_REPLACEMENT_MAX_LEN);
  });

  it('security_capture_expansion_growth_reports_the_first_preallocation_overrun', async () => {
    const compiled = await op({ kind: 'regex_replace', field: 'front',
      pattern: '(?s)(.)', replacement: '$1'.repeat(1024) });
    let caught: any;
    try {
      await applyTransformOpsAsync(
        compiled, fields('a'.repeat(2048), 'A', null, []), nativeRegexEngine,
      );
    }
    catch (error) { caught = error; }
    expect(caught.opIndex).toBe(0);
    expect(caught.field).toBe('front');
    expect(caught.bytes).toBeGreaterThan(CHATANKI_TRANSFORM_FIELD_GROWTH_MAX_BYTES);
    expect(caught.bytes).toBe(CHATANKI_TRANSFORM_FIELD_GROWTH_MAX_BYTES + 1024);
  });

  // These two boundary tests check forwarding only, not the F7 implementation.
  // Independent real primitive/tool checks live in regex-projected-real-host.test.ts.
  it('security_capture_expansion_forwards_the_rust_limit_to_f7_projection', async () => {
    const replacement = '$1'.repeat(1024);
    const compiled = await op({ kind: 'regex_replace', field: 'front',
      pattern: '(?s)(.)', replacement });
    const before = 'a'.repeat(2048);
    const calls: Array<{ text: string; replacement: string; limit: number }> = [];
    let materialized = 0;
    const projectedRegex = {
      ...nativeRegexEngine,
      replaceAll: async (
        pattern: Parameters<ChatAnkiAsyncNativeRegex['replaceAll']>[0],
        text: string, repl: string,
      ) => {
        materialized += 1;
        return nativeRegexEngine.replaceAll(pattern, text, repl);
      },
      replaceAllProjected: async (
        _pattern: Parameters<ChatAnkiAsyncNativeRegex['replaceAll']>[0],
        text: string, repl: string, limitBytes: number,
      ) => {
        calls.push({ text, replacement: repl, limit: limitBytes });
        return { ok: false as const, bytes: limitBytes + 7 };
      },
    } as ChatAnkiAsyncNativeRegex;

    let caught: any;
    try {
      await applyTransformOpsAsync(compiled, fields(before, 'A', null, []), projectedRegex);
    } catch (error) { caught = error; }
    expect(caught.opIndex).toBe(0);
    expect(caught.field).toBe('front');
    expect(caught.bytes).toBe(CHATANKI_TRANSFORM_FIELD_GROWTH_MAX_BYTES + 7);
    expect(calls).toEqual([{
      text: before,
      replacement,
      limit: CHATANKI_TRANSFORM_FIELD_GROWTH_MAX_BYTES,
    }]);
    expect(materialized).toBe(0);
  });

  it('security_projected_replace_raises_the_limit_to_an_oversized_input', async () => {
    const oversized = 'x'.repeat(CHATANKI_TRANSFORM_FIELD_GROWTH_MAX_BYTES + 4096);
    const compiled = await op({ kind: 'regex_replace', field: 'back',
      pattern: 'never-matches-9f8e7d', replacement: '$1' });
    let observedLimit = 0;
    const projectedRegex = {
      ...nativeRegexEngine,
      replaceAllProjected: async (
        _pattern: Parameters<ChatAnkiAsyncNativeRegex['replaceAll']>[0],
        text: string, _repl: string, limitBytes: number,
      ) => {
        observedLimit = limitBytes;
        return { ok: true as const, value: text, bytes: Buffer.byteLength(text, 'utf8') };
      },
    } as ChatAnkiAsyncNativeRegex;

    const after = await applyTransformOpsAsync(
      compiled, fields('Q', oversized, null, []), projectedRegex,
    );
    expect(observedLimit).toBe(Buffer.byteLength(oversized, 'utf8'));
    expect(after.back).toBe(oversized);
  });

  it('security_regex_growth_bomb_is_blocked_per_card', async () => {
    const compiled = await compile([
      { kind: 'regex_replace', field: 'front', pattern: '(?s).', replacement: 'y'.repeat(CHATANKI_TRANSFORM_REPLACEMENT_MAX_LEN) },
      { kind: 'regex_replace', field: 'front', pattern: '(?s).', replacement: 'z'.repeat(CHATANKI_TRANSFORM_REPLACEMENT_MAX_LEN) },
    ]);
    const bomb = { ...makeCard('card-bomb', false, false), front: 'x'.repeat(4096) };
    const tiny = { ...makeCard('card-tiny', false, false), front: 'ok' };
    const plans = await planTransformOpsAsync(compiled, [bomb, tiny], nativeRegexEngine);
    expect(plans[0]).toMatchObject({ kind: 'invalid', code: 'field_growth_exceeded' });
    expect((plans[0] as any).detail).toContain('ops[0]');
    expect((plans[0] as any).detail).toContain('front');
    expect(plans[1]).toMatchObject({ kind: 'invalid', code: 'field_growth_exceeded' });
    expect((plans[1] as any).detail).toContain('ops[1]');
  });

  it('security_shrinking_or_keeping_oversized_field_is_allowed', async () => {
    const oversized = 'x'.repeat(CHATANKI_TRANSFORM_FIELD_GROWTH_MAX_BYTES + 4096);
    const before = fields('Q', oversized, null, []);
    const shrink = await op({ kind: 'regex_replace', field: 'back', pattern: 'x{1000}', replacement: 'x' });
    const shrunk = await applyTransformOpsAsync(shrink, before, nativeRegexEngine);
    expect(shrunk.back.length).toBeLessThan(before.back.length);
    const noop = await op({ kind: 'regex_replace', field: 'back', pattern: 'never-matches-9f8e7d', replacement: 'y' });
    expect((await applyTransformOpsAsync(noop, before, nativeRegexEngine)).back).toBe(before.back);
  });

  it('security_normalize_rejects_overlong_tag', () => {
    const overlong = 't'.repeat(CHATANKI_TRANSFORM_TAG_MAX_CHARS + 1);
    expect(() => parse({ documentId: 'doc-1', transform: { ops: [{ op: 'tag_add', tags: [overlong] }] } }))
      .toThrow('must not exceed');
  });

  it('transform_fields_validity_matches_card_content_rules', () => {
    expect(transformFieldsAreValid(fields('Q', 'A', null, []))).toBe(true);
    expect(transformFieldsAreValid(fields('', '', '{{c1::x}}', []))).toBe(true);
    expect(transformFieldsAreValid(fields('Q', '', null, []))).toBe(false);
    expect(transformFieldsAreValid(fields('', '', '  ', []))).toBe(false);
  });

  it('default_selection_excludes_error_cards', () => {
    const selected = selectTransformCards([makeCard('card-1', false, false), makeCard('card-2', true, false)],
      { kind: 'default_live' } satisfies NormalizedTransformSelection);
    expect(selected.map((card) => card.id)).toEqual(['card-1']);
  });

  it('filter_selection_matches_get_cards_semantics', () => {
    const cards = [makeCard('card-1', false, false), makeCard('card-2', true, false), makeCard('card-3', false, true)];
    expect(selectTransformCards(cards, { kind: 'filter', filter: 'all' })).toHaveLength(3);
    const edited = selectTransformCards(cards, { kind: 'filter', filter: 'edited_only' });
    expect(edited.map((card) => card.id)).toEqual(['card-3']);
    const errors = selectTransformCards(cards, { kind: 'filter', filter: 'error_only' });
    expect(errors.map((card) => card.id)).toEqual(['card-2']);
  });

  it('card_ids_selection_reports_missing_ids', () => {
    let caught: any;
    try { selectTransformCards([makeCard('card-1', false, false)], { kind: 'cards', cardIds: ['card-1', 'card-ghost'] }); }
    catch (error) { caught = error; }
    expect(caught.missingCards).toEqual(['card-ghost']);
  });

  it('expected_versions_must_match_selection_exactly', () => {
    let caught: any;
    try { checkExpectedVersions(['card-1', 'card-2'], { 'card-2': 'v1', 'card-3': 'v1' }); }
    catch (error) { caught = error; }
    expect(caught.missingVersionIds).toEqual(['card-1']);
    expect(caught.unexpectedVersionIds).toEqual(['card-3']);
    expect(() => checkExpectedVersions(['card-1', 'card-2'], { 'card-1': 'v1', 'card-2': 'v2' })).not.toThrow();
  });
});
