// Rust sorts `String`/`&str` by UTF-8 bytes; JS `sort()` compares UTF-16 code units. They disagree when
// a BMP character at U+E000 or above (fullwidth `Ｑ`, U+FF31) meets an astral one (`🔥`, U+1F525):
// bytes put `Ｑ` (EF BC B1) first, UTF-16 puts `🔥` (D83D…) first.
import { expect, it } from 'vitest';
import type { AnkiCard, FieldExtractionRule } from '../api.ts';
import { cardEditObservations } from '../src/preference-observations.ts';
import { buildRetemplateFillPrompt, type AnkiRetemplateCardUpdate } from '../src/retemplate-fill.ts';
import { computeFieldLimitWarnings } from '../src/template-selection.ts';
import { checkExpectedVersions, ExpectedVersionsMismatch } from '../src/transform.ts';

const FULLWIDTH = 'Ｑ';
const ASTRAL = '🔥';

function card(extraFields: Record<string, string>): AnkiCard {
  return {
    id: 'card-utf8', front: 'front', back: 'back', text: null, tags: [], images: [], task_id: 'task-utf8',
    is_error_card: false, error_content: null, created_at: '2026-11-07T00:00:00Z',
    updated_at: '2026-11-07T00:00:00Z', extra_fields: extraFields, template_id: null,
  };
}

it('card edit observations visit custom fields in byte order (chatanki_executor.rs:11110–11113)', () => {
  const edits = cardEditObservations(
    card({ [ASTRAL]: 'old', [FULLWIDTH]: 'old' }), card({ [ASTRAL]: 'new', [FULLWIDTH]: 'new' }),
  );
  expect(edits.map((edit) => edit.field)).toEqual([`extra_fields.${FULLWIDTH}`, `extra_fields.${ASTRAL}`]);
});

it('the retemplate fill prompt lists existing custom fields in byte order (chatanki_executor.rs:13098–13104)', () => {
  const source = card({ [ASTRAL]: 'astral value', [FULLWIDTH]: 'fullwidth value' });
  const update: AnkiRetemplateCardUpdate = {
    documentId: 'doc-utf8', card: source, source, missingFields: [{ field: 'Extra', required: true }],
  };
  const prompt = buildRetemplateFillPrompt('Target', [update]);
  const fullwidthAt = prompt.indexOf(`- ${FULLWIDTH}: fullwidth value`);
  const astralAt = prompt.indexOf(`- ${ASTRAL}: astral value`);
  expect(fullwidthAt).toBeGreaterThan(-1);
  expect(astralAt).toBeGreaterThan(fullwidthAt);
});

it('field limit warnings follow byte order of the rule names (chatanki_executor.rs:11623–11628)', () => {
  const rule = (description: string): FieldExtractionRule => ({ max_length: 1, description } as FieldExtractionRule);
  const { warnings } = computeFieldLimitWarnings(
    [{ id: 'card-utf8', templateId: 'tpl-utf8', extraFields: { [ASTRAL]: 'too long', [FULLWIDTH]: 'too long' } }],
    () => ({ [ASTRAL]: rule('astral'), [FULLWIDTH]: rule('fullwidth') }),
  );
  expect(warnings.map((warning) => warning.field)).toEqual([FULLWIDTH, ASTRAL]);
});

it('expectedVersions mismatch lists ids in byte order (chatanki_transform.rs:787–801)', () => {
  let caught: unknown = null;
  try { checkExpectedVersions([ASTRAL, FULLWIDTH], { [`x${ASTRAL}`]: 'v', [`x${FULLWIDTH}`]: 'v' }); }
  catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(ExpectedVersionsMismatch);
  expect((caught as ExpectedVersionsMismatch).missingVersionIds).toEqual([FULLWIDTH, ASTRAL]);
  expect((caught as ExpectedVersionsMismatch).unexpectedVersionIds).toEqual([`x${FULLWIDTH}`, `x${ASTRAL}`]);
});
