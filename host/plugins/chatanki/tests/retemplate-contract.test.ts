import { expect, it } from 'vitest';
import type {
  AnkiCard, AnkiRetemplateCardUpdate, AnkiRetemplateTarget,
} from '../api.ts';
import { preflightCardMutation, persistCardMutation } from '../src/mutation-target.ts';
import { fsrsCardsChangedPayload } from '../src/review-payloads.ts';
import {
  retemplateFillFailed, retemplateFillSummary, retemplateUpdateForTool, writeRetemplateFill,
  type RetemplateFillOutcome,
} from '../src/retemplate-fill.ts';
import { CardStoreDouble } from './chatanki-card-double.ts';
import { ChatBlockStoreDouble } from './chat-block-double.ts';

let versionCounter = 0;

function makeCard(
  id: string, taskId: string, front: string, back: string,
  overrides: Partial<AnkiCard> = {},
): AnkiCard {
  versionCounter += 1;
  const seconds = String(versionCounter % 60).padStart(2, '0');
  return {
    id, front, back, text: null, tags: ['tag'], images: [], task_id: taskId,
    is_error_card: false, error_content: null,
    created_at: '2026-08-24T00:00:00Z',
    updated_at: `2026-08-24T01:00:${seconds}Z`,
    extra_fields: {}, template_id: 'design-swiss',
    ...overrides,
  };
}

function makeTarget(
  templateId: string, noteType: string, fields: string[], requiredFields: string[],
): AnkiRetemplateTarget {
  return { templateId, noteType, fields, requiredFields };
}

function expectedVersions(cards: readonly AnkiCard[]): Map<string, string> {
  return new Map(cards.map((card) => [card.id, card.updated_at]));
}

it('test_chatanki_retemplate_maps_aliases_base_fields_and_required_normalization', () => {
  const repo = new CardStoreDouble();
  const taskId = repo.seedDocument('doc-map', 'session-map');
  const card = makeCard('card-map', taskId, 'base front', 'base back', {
    text: 'base text',
    tags: ['tag-a', 'tag-b'],
    extra_fields: {
      Front: 'stale canonical extra',
      front: 'stale lower extra',
      some_key: 'normalized',
      Canonical: 'exact',
      canonical: 'lower',
      loweronly: 'lower only',
      legacy: 'preserved',
    },
  });
  expect(repo.insertCard(card)).toBe(true);
  const target = makeTarget(
    'design-lexicon', 'Basic',
    ['Word', 'Definition', 'Front', 'Text', 'Tags', 'Some-Key', 'Canonical',
      'LowerOnly', 'Needs Value'],
    ['needs_value'],
  );

  const result = repo.retemplateCardsForSession(
    { kind: 'document', documentId: 'doc-map' }, target, expectedVersions([card]),
    'session-map', ['doc-map'],
  );
  expect(result.kind).toBe('updated');
  if (result.kind !== 'updated') throw new Error('unreachable');
  const update = result.updates[0];
  if (update === undefined) throw new Error('missing update');
  expect(update.card.extra_fields.Word).toBe('base front');
  expect(update.card.extra_fields.Definition).toBe('base back');
  expect(update.card.extra_fields.Front).toBe('base front');
  expect(update.card.extra_fields.Text).toBe('base text');
  expect(update.card.extra_fields.Tags).toBe('["tag-a","tag-b"]');
  expect(update.card.extra_fields['Some-Key']).toBe('normalized');
  expect(update.card.extra_fields.Canonical).toBe('exact');
  expect(update.card.extra_fields.LowerOnly).toBe('lower only');
  expect(update.card.extra_fields.legacy).toBe('preserved');
  expect(update.missingFields).toEqual([{ field: 'Needs Value', required: true }]);
});

it('test_chatanki_retemplate_rejects_document_card_and_mixed_ownership', () => {
  const repo = new CardStoreDouble();
  const taskId = repo.seedDocument('doc-owned', 'session-owner');
  const card = makeCard('card-owned', taskId, 'front', 'back');
  expect(repo.insertCard(card)).toBe(true);
  const versions = expectedVersions([card]);
  const target = makeTarget('target', 'Basic', ['Front', 'Back'], []);

  expect(repo.retemplateCardsForSession(
    { kind: 'document', documentId: 'doc-owned' }, target, versions,
    'session-other', ['doc-owned'],
  ).kind).toBe('ownershipRejected');
  expect(repo.retemplateCardsForSession(
    { kind: 'cards', cardIds: ['card-owned'] }, target, versions,
    'session-other', ['doc-owned'],
  ).kind).toBe('ownershipRejected');

  repo.addTask('doc-owned', 'task-mixed-owner', 'session-other');
  const second = makeCard('card-mixed', 'task-mixed-owner', 'two', 'answer');
  expect(repo.insertCard(second)).toBe(true);
  expect(repo.retemplateCardsForSession(
    { kind: 'document', documentId: 'doc-owned' }, target,
    expectedVersions([card, second]), 'session-owner', ['doc-owned'],
  ).kind).toBe('ownershipRejected');
});

it('test_chatanki_retemplate_rejects_cross_document_card_selection', () => {
  const repo = new CardStoreDouble();
  const taskA = repo.seedDocument('doc-a', 'session-cross');
  const taskB = repo.seedDocument('doc-b', 'session-cross');
  const cardA = makeCard('card-a', taskA, 'a', 'answer-a');
  const cardB = makeCard('card-b', taskB, 'b', 'answer-b');
  expect(repo.insertCard(cardA)).toBe(true);
  expect(repo.insertCard(cardB)).toBe(true);

  const result = repo.retemplateCardsForSession(
    { kind: 'cards', cardIds: ['card-a', 'card-b'] },
    makeTarget('target', 'Basic', ['Front', 'Back'], []),
    expectedVersions([cardA, cardB]), 'session-cross', ['doc-a', 'doc-b'],
  );
  expect(result).toEqual({ kind: 'crossDocumentSelection', documentIds: ['doc-a', 'doc-b'] });
});

it('test_chatanki_retemplate_requires_exact_version_set', () => {
  const repo = new CardStoreDouble();
  const taskId = repo.seedDocument('doc-version-set', 'session-version-set');
  const cardA = makeCard('card-version-a', taskId, 'a', 'answer-a');
  const cardB = makeCard('card-version-b', taskId, 'b', 'answer-b');
  expect(repo.insertCard(cardA)).toBe(true);
  expect(repo.insertCard(cardB)).toBe(true);
  const expected = expectedVersions([cardA]);
  expected.set('ghost-card', 'ghost-version');

  const result = repo.retemplateCardsForSession(
    { kind: 'document', documentId: 'doc-version-set' },
    makeTarget('target', 'Basic', ['Front', 'Back'], []),
    expected, 'session-version-set', ['doc-version-set'],
  );
  expect(result).toEqual({
    kind: 'expectedVersionsMismatch',
    missingVersionIds: ['card-version-b'],
    unexpectedVersionIds: ['ghost-card'],
  });
});

it('test_chatanki_retemplate_document_live_set_add_and_delete_never_partially_write', () => {
  const repo = new CardStoreDouble();
  const taskId = repo.seedDocument('doc-live-set', 'session-live-set');
  const cardA = makeCard('card-live-a', taskId, 'a', 'answer-a');
  expect(repo.insertCard(cardA)).toBe(true);
  const expectedBeforeAdd = expectedVersions([cardA]);
  const cardB = makeCard('card-live-b', taskId, 'b', 'answer-b');
  expect(repo.insertCard(cardB)).toBe(true);
  const target = makeTarget('target-live', 'Basic', ['Word'], []);

  const afterAdd = repo.retemplateCardsForSession(
    { kind: 'document', documentId: 'doc-live-set' }, target,
    expectedBeforeAdd, 'session-live-set', ['doc-live-set'],
  );
  expect(afterAdd).toEqual({
    kind: 'expectedVersionsMismatch',
    missingVersionIds: ['card-live-b'],
    unexpectedVersionIds: [],
  });

  const expectedBeforeDelete = expectedVersions([cardA, cardB]);
  // Rust test fixture uses `UPDATE anki_cards SET deleted_at` directly; the
  // production delete handler physically removes the row instead.
  repo.softDeleteCard('card-live-b');
  const afterDelete = repo.retemplateCardsForSession(
    { kind: 'document', documentId: 'doc-live-set' }, target,
    expectedBeforeDelete, 'session-live-set', ['doc-live-set'],
  );
  expect(afterDelete).toEqual({
    kind: 'expectedVersionsMismatch',
    missingVersionIds: [],
    unexpectedVersionIds: ['card-live-b'],
  });

  const unchanged = [cardA, cardB].filter((card) =>
    repo.templateId(card.id) === 'design-swiss' && repo.localVersion(card.id) === 0);
  expect(unchanged.length).toBe(2);
});

it('test_chatanki_retemplate_document_set_change_rejects_before_write', () => {
  const repo = new CardStoreDouble();
  const taskId = repo.seedDocument('doc-set', 'session-set');
  const card = makeCard('card-set', taskId, 'front', 'back');
  expect(repo.insertCard(card)).toBe(true);

  const result = repo.retemplateCardsForSession(
    { kind: 'cards', cardIds: ['card-set'] },
    makeTarget('target-set', 'Basic', ['Word'], []),
    expectedVersions([card]), 'session-set', ['doc-preflight-stale'],
  );
  expect(result).toEqual({ kind: 'documentSetChanged', documentIds: ['doc-set'] });
  const reloaded = repo.getCardWithDocument('card-set');
  expect(reloaded?.card.template_id).toBe('design-swiss');
  expect(reloaded?.card.updated_at).toBe(card.updated_at);
});

it('test_chatanki_retemplate_one_stale_version_rolls_back_entire_batch', () => {
  const repo = new CardStoreDouble();
  const taskId = repo.seedDocument('doc-stale', 'session-stale');
  const cardA = makeCard('card-stale-a', taskId, 'a', 'answer-a');
  const cardB = makeCard('card-stale-b', taskId, 'b', 'answer-b');
  expect(repo.insertCard(cardA)).toBe(true);
  expect(repo.insertCard(cardB)).toBe(true);
  const expected = expectedVersions([cardA, cardB]);
  expected.set('card-stale-b', 'stale-version');

  const result = repo.retemplateCardsForSession(
    { kind: 'document', documentId: 'doc-stale' },
    makeTarget('target-stale', 'Basic', ['Word'], []),
    expected, 'session-stale', ['doc-stale'],
  );
  expect(result.kind).toBe('versionConflict');
  const cards = repo.getCardsForDocument('doc-stale');
  expect(cards.every((candidate) => candidate.template_id === 'design-swiss')).toBe(true);
  expect(cards.every((candidate) => !Object.hasOwn(candidate.extra_fields, 'Word'))).toBe(true);
});

it('test_chatanki_retemplate_updates_one_hundred_cards_atomically', () => {
  const repo = new CardStoreDouble();
  const taskId = repo.seedDocument('doc-hundred', 'session-hundred');
  const cards: AnkiCard[] = [];
  for (let index = 0; index < 100; index += 1) {
    const card = makeCard(
      `card-hundred-${String(index).padStart(3, '0')}`, taskId,
      `front ${index}`, `back ${index}`,
    );
    expect(repo.insertCard(card)).toBe(true);
    cards.push(card);
  }
  const expected = expectedVersions(cards);
  const target = makeTarget(
    'design-lexicon', 'Basic', ['Word', 'Definition'], ['Word', 'Definition'],
  );

  const staleExpected = new Map(expected);
  staleExpected.set('card-hundred-099', 'stale-last-card-version');
  const staleResult = repo.retemplateCardsForSession(
    { kind: 'document', documentId: 'doc-hundred' }, target,
    staleExpected, 'session-hundred', ['doc-hundred'],
  );
  expect(staleResult.kind).toBe('versionConflict');
  expect(cards.filter((card) =>
    repo.getCardWithDocument(card.id)?.card.template_id === 'design-swiss'
    && repo.localVersion(card.id) === 0).length).toBe(100);

  const result = repo.retemplateCardsForSession(
    { kind: 'document', documentId: 'doc-hundred' }, target,
    expected, 'session-hundred', ['doc-hundred'],
  );
  expect(result.kind).toBe('updated');
  if (result.kind !== 'updated') throw new Error('unreachable');
  expect(result.updates.length).toBe(100);
  expect(result.updates.every((update) => update.missingFields.length === 0)).toBe(true);
  expect(cards.filter((card) =>
    repo.getCardWithDocument(card.id)?.card.template_id === 'design-lexicon'
    && repo.localVersion(card.id) === 1).length).toBe(100);
});

it('test_chatanki_retemplate_cloze_guard_uses_only_valid_text_and_rolls_back', () => {
  const repo = new CardStoreDouble();
  const taskId = repo.seedDocument('doc-cloze', 'session-cloze');
  const missingText = makeCard(
    'card-cloze-missing', taskId, '{{c1::front-only}}', 'back',
  );
  const fakeMarkup = makeCard('card-cloze-fake', taskId, 'front', 'back', {
    text: '{{color}} and {{c1::}}',
  });
  const valid = makeCard('card-cloze-valid', taskId, 'front', 'back', {
    text: 'A {{c1::valid answer::hint}} here',
  });
  for (const card of [missingText, fakeMarkup, valid]) {
    expect(repo.insertCard(card)).toBe(true);
  }

  const result = repo.retemplateCardsForSession(
    { kind: 'document', documentId: 'doc-cloze' },
    makeTarget('design-redaction', 'Cloze', ['Text'], ['Text']),
    expectedVersions([missingText, fakeMarkup, valid]),
    'session-cloze', ['doc-cloze'],
  );
  expect(result).toEqual({
    kind: 'invalidCloze', cardIds: ['card-cloze-fake', 'card-cloze-missing'],
  });
  expect(repo.getCardsForDocument('doc-cloze')
    .every((card) => card.template_id === 'design-swiss')).toBe(true);
});

it('test_chatanki_retemplate_map_only_and_fill_missing_source_contract', () => {
  const repo = new CardStoreDouble();
  const taskId = repo.seedDocument('doc-missing', 'session-missing');
  const card = makeCard(
    'card-missing', taskId, 'x'.repeat(2_000 + 10), 'back',
  );
  expect(repo.insertCard(card)).toBe(true);
  const result = repo.retemplateCardsForSession(
    { kind: 'document', documentId: 'doc-missing' },
    makeTarget('target-missing', 'Basic', ['Unmapped Field'], ['unmapped_field']),
    expectedVersions([card]), 'session-missing', ['doc-missing'],
  );
  expect(result.kind).toBe('updated');
  if (result.kind !== 'updated') throw new Error('unreachable');
  const update = result.updates[0];
  if (update === undefined) throw new Error('missing update');

  const mapOnly = retemplateUpdateForTool(update, 'map_only', null);
  expect(mapOnly.missingFields).toEqual(['Unmapped Field']);
  expect((mapOnly.missingFieldDetails as Array<Record<string, unknown>>)[0]?.required)
    .toBe(true);
  expect(mapOnly.source).toBeUndefined();
  expect(mapOnly.fillStatus).toBeUndefined();

  const fillMissing = retemplateUpdateForTool(update, 'fill_missing', null);
  expect((fillMissing.source as Record<string, unknown>).truncated).toBe(true);
  expect([...((fillMissing.source as Record<string, unknown>).front as string)].length)
    .toBe(2_000);
});

it('test_chatanki_retemplate_fill_missing_llm_cas_write_back_conflict_and_payload', () => {
  const repo = new CardStoreDouble();
  const taskId = repo.seedDocument('doc-fill-llm', 'session-fill-llm');
  const card = makeCard('card-fill-llm', taskId, 'front', 'back');
  expect(repo.insertCard(card)).toBe(true);
  const result = repo.retemplateCardsForSession(
    { kind: 'document', documentId: 'doc-fill-llm' },
    makeTarget('target-fill', 'Basic', ['Front', 'Example'], []),
    expectedVersions([card]), 'session-fill-llm', ['doc-fill-llm'],
  );
  expect(result.kind).toBe('updated');
  if (result.kind !== 'updated') throw new Error('unreachable');
  const update = result.updates[0];
  if (update === undefined) throw new Error('missing update');
  expect(update.missingFields).toEqual([{ field: 'Example', required: false }]);
  const staleUpdate = structuredClone(update);
  const phase1Version = update.card.updated_at;

  const casUpdate = (next: AnkiCard, expected: string) =>
    repo.updateCardIfVersionForSession(next, expected, 'session-fill-llm');
  const outcome = writeRetemplateFill(
    update, new Map([['Example', 'generated example']]), casUpdate,
  );
  expect(outcome.status).toBe('filled');
  expect(outcome.filledFields).toEqual(['Example']);
  expect(outcome.error).toBeNull();
  expect(update.missingFields).toEqual([]);
  expect(update.card.updated_at).not.toBe(phase1Version);
  expect(repo.getCardsForDocument('doc-fill-llm')[0]?.extra_fields.Example)
    .toBe('generated example');

  const skippedUpdate = structuredClone(staleUpdate);
  const skipped = writeRetemplateFill(
    skippedUpdate, new Map([['Unrelated', 'value']]), casUpdate,
  );
  expect(skipped.status).toBe('skipped');

  const conflictedUpdate = structuredClone(staleUpdate);
  const conflict = writeRetemplateFill(
    conflictedUpdate, new Map([['Example', 'generated example']]), casUpdate,
  );
  expect(conflict.status).toBe('conflict');
  expect(conflict.error).toBe('version_conflict');
  expect(conflictedUpdate.card.updated_at).toBe(update.card.updated_at);

  const payload = retemplateUpdateForTool(update, 'fill_missing_llm', outcome);
  expect(payload.fillStatus).toBe('filled');
  expect(payload.filledFields).toEqual(['Example']);
  expect(payload.missingFields).toEqual([]);
  expect(payload.source).toBeUndefined();
  expect(payload.version).toBe(update.card.updated_at);

  const untouched = retemplateUpdateForTool(update, 'fill_missing_llm', null);
  expect(untouched.fillStatus).toBe('not_needed');
  expect(untouched.filledFields).toEqual([]);

  const outcomes = new Map<string, RetemplateFillOutcome>([
    ['card-fill-llm', outcome],
    ['card-conflict', {
      status: 'conflict', filledFields: [], error: 'version_conflict',
    }],
    ['card-failed', retemplateFillFailed('llm error')],
  ]);
  const summary = retemplateFillSummary(outcomes);
  expect(summary).toEqual({
    attempted: 3, filled: 1, partial: 0, skipped: 0, conflicts: 1, failed: 1,
  });
});

it('test_chatanki_retemplate_batch_ui_upsert_and_fsrs_event_payload', () => {
  const store = new ChatBlockStoreDouble();
  store.seedAnkiCardsBlock(
    'block-retemplate-ui', 'session-retemplate-ui', 'doc-retemplate-ui',
    {}, [{ id: 'card-ui-1', template_id: 'old' }], [],
  );
  const target = preflightCardMutation(
    store, 'session-retemplate-ui', 'doc-retemplate-ui',
  );
  expect(target.blockId).toBe('block-retemplate-ui');

  persistCardMutation(store, target, 'doc-retemplate-ui', {
    documentId: 'doc-retemplate-ui',
    cardMutation: 'upsert',
    cards: [
      { id: 'card-ui-1', template_id: 'target' },
      { id: 'card-ui-2', template_id: 'target' },
    ],
  });
  const block = store.getBlock('block-retemplate-ui');
  expect((block?.toolOutput as Record<string, unknown>).cards).toHaveLength(2);

  const payload = fsrsCardsChangedPayload(
    'cards_retemplated', ['card-ui-1', 'card-ui-2'], 'run-retemplate',
  );
  expect(payload.action).toBe('cards_retemplated');
  expect(payload.entityIds).toEqual(['card-ui-1', 'card-ui-2']);
  expect(payload.runId).toBe('run-retemplate');
});
