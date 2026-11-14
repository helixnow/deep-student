import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AnkiCard } from '../api.ts';
import {
  CHATANKI_CARD_FIELD_LIMIT, applyCardPatch, convertCardForTool, normalizeAgentExtraFields,
  parseChatAnkiAddCardsArgs, parseChatAnkiDeleteCardArgs, parseChatAnkiDeleteCardsArgs,
  parseChatAnkiDeleteLibraryCardArgs,
  parseChatAnkiEnqueueLibraryReviewArgs, parseChatAnkiEnqueueReviewArgs,
  parseChatAnkiExportArgs, parseChatAnkiGetCardsArgs, parseChatAnkiImportApkgArgs,
  parseChatAnkiListLibraryCardsArgs, parseChatAnkiListTemplatesArgs,
  parseChatAnkiRetemplateArgs, parseChatAnkiRetemplateStrategy, parseChatAnkiSetLibrarySuspendedArgs,
  parseChatAnkiSetSuspendedArgs, parseChatAnkiUndoLastReviewArgs,
  parseChatAnkiUndoLibraryLastReviewArgs, parseChatAnkiUpdateCardArgs,
  parseChatAnkiUpdateLibraryCardArgs, selectChatankiCardsPage,
} from '../src/executor-args.ts';

function makeCard(id: string, front: string, back: string): AnkiCard {
  return {
    id, front, back, text: null, tags: [], images: [], task_id: 'task-1', is_error_card: false,
    error_content: null, created_at: '2026-08-24T00:00:00Z',
    updated_at: '2026-08-24T01:00:00Z', extra_fields: {}, template_id: null,
  };
}

function captureError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

describe('chatanki_executor.rs (argument contracts)', () => {
  it('test_chatanki_get_cards_args_and_field_truncation', () => {
    const args = parseChatAnkiGetCardsArgs({
      documentId: 'doc-get', filter: 'edited_only',
    });
    expect(args.page).toBeNull();
    expect(args.pageSize).toBeNull();
    expect(args.filter).toBe('edited_only');

    const card = makeCard('card-get', 'x'.repeat(2_010), 'back');
    card.extra_fields.detail = 'y'.repeat(2_005);
    const output = convertCardForTool(card, 3);
    expect(output.index).toBe(3);
    expect([...(output.front as string)].length).toBe(CHATANKI_CARD_FIELD_LIMIT);
    expect([...(output.extraFields as Record<string, string>).detail as string].length)
      .toBe(CHATANKI_CARD_FIELD_LIMIT);
    expect(output.truncated).toBe(true);
    expect((output.truncatedFields as string[]).sort()).toEqual(['extraFields.detail', 'front']);
    expect(output.version).toBe(card.updated_at);
  });

  it('test_chatanki_update_card_args_preserve_explicit_null_text', () => {
    const args = parseChatAnkiUpdateCardArgs({
      cardId: 'card-null',
      expectedVersion: 'v1',
      patch: {
        text: null,
        extraFields: { ' Question ': 'value', '': 'ignored' },
      },
    });
    expect(args.patch.text).toBeNull();
    expect(args.patch.text === null).toBe(true);
    const card = makeCard('card-null', 'front', 'back');
    card.text = 'old';
    applyCardPatch(card, args.patch);
    expect(card.text).toBeNull();
    expect(card.extra_fields.question).toBe('value');
    expect(Object.hasOwn(card.extra_fields, '')).toBe(false);
    expect(Object.hasOwn(card.extra_fields, ' Question ')).toBe(false);
  });

  it('test_chatanki_update_card_syncs_template_aliases_with_core_fields', () => {
    const card = makeCard('card-template-sync', 'old front', 'old back');
    card.text = 'old {{c1::text}}';
    card.extra_fields.Question = 'old front';
    card.extra_fields.Definition = 'old back';
    card.extra_fields.Text = 'old {{c1::text}}';
    card.extra_fields.Formula = 'preserve';

    const patch = parseChatAnkiUpdateCardArgs({
      cardId: 'card-template-sync',
      expectedVersion: 'v1',
      patch: {
        front: 'new front',
        back: 'new back',
        text: 'new {{c1::text}}',
      },
    }).patch;
    applyCardPatch(card, patch);

    expect(card.front).toBe('new front');
    expect(card.back).toBe('new back');
    expect(card.text).toBe('new {{c1::text}}');
    expect(card.extra_fields.Question).toBe('new front');
    expect(card.extra_fields.Definition).toBe('new back');
    expect(card.extra_fields.Text).toBe('new {{c1::text}}');
    expect(card.extra_fields.Formula).toBe('preserve');
  });

  it('test_chatanki_library_list_arguments_normalize_and_cap_page_size', () => {
    const args = parseChatAnkiListLibraryCardsArgs({
      query: '  spaced query  ',
      templateId: '  design-swiss  ',
      schedule: 'not_enqueued',
      filter: 'error_only',
      page: 0,
      pageSize: 999,
    });
    expect(args.search).toBe('spaced query');
    expect(args.templateId).toBe('design-swiss');
    expect(args.schedule).toBe('not_enqueued');
    expect(args.filter).toBe('error_only');
    expect(args.page).toBe(1);
    expect(args.pageSize).toBe(20);

    const defaults = parseChatAnkiListLibraryCardsArgs({});
    expect(defaults.schedule).toBe('all');
    expect(defaults.filter).toBe('all');
    expect(defaults.page).toBe(1);
    expect(defaults.pageSize).toBe(20);

    expect(captureError(() => parseChatAnkiListLibraryCardsArgs({ schedule: 'reviewed' })))
      .not.toBeNull();
    expect(captureError(() => parseChatAnkiListLibraryCardsArgs({ filter: 'edited_only' })))
      .not.toBeNull();
  });

  it('test_chatanki_library_mutation_arguments_require_explicit_cas_tokens', () => {
    const update = parseChatAnkiUpdateLibraryCardArgs({
      cardId: ' card-update ',
      expectedVersion: ' v1 ',
      patch: { front: 'updated' },
    });
    expect(update.cardId).toBe('card-update');
    expect(update.expectedVersion).toBe('v1');

    const enqueue = parseChatAnkiEnqueueLibraryReviewArgs({
      cards: [
        { cardId: ' card-a ', expectedVersion: ' version-a ' },
        { cardId: 'card-b', expectedVersion: 'version-b' },
      ],
    });
    expect(enqueue).toEqual([
      { cardId: 'card-a', expectedVersion: 'version-a' },
      { cardId: 'card-b', expectedVersion: 'version-b' },
    ]);
    expect(captureError(() => parseChatAnkiEnqueueLibraryReviewArgs({
      cards: [
        { cardId: 'same', expectedVersion: 'v1' },
        { cardId: ' same ', expectedVersion: 'v1' },
      ],
    }))).not.toBeNull();

    const suspend = parseChatAnkiSetLibrarySuspendedArgs({
      cardId: ' card-suspend ', expectedReviewVersion: 9, suspended: true,
    });
    expect(suspend.cardId).toBe('card-suspend');
    expect(suspend.expectedReviewVersion).toBe(9);

    const undo = parseChatAnkiUndoLibraryLastReviewArgs({
      cardId: ' card-undo ', expectedReviewVersion: 10, expectedLogId: ' log-10 ',
    });
    expect(undo.cardId).toBe('card-undo');
    expect(undo.expectedReviewVersion).toBe(10);
    expect(undo.expectedLogId).toBe('log-10');

    const notEnqueued = parseChatAnkiDeleteLibraryCardArgs({
      cardId: ' card-delete ',
      expectedVersion: ' version-delete ',
      expectedReviewVersion: null,
    });
    expect(notEnqueued.expectedReviewVersion.value).toBeNull();

    const enqueued = parseChatAnkiDeleteLibraryCardArgs({
      cardId: 'card-delete', expectedVersion: 'version-delete', expectedReviewVersion: 12,
    });
    expect(enqueued.expectedReviewVersion.value).toBe(12);

    const missing = captureError(() => parseChatAnkiDeleteLibraryCardArgs({
      cardId: 'card-delete', expectedVersion: 'version-delete',
    }));
    expect(errorText(missing)).toContain('use null');
  });

  it('test_chatanki_export_args_require_xor_selector_and_json_library_ids', () => {
    const document = parseChatAnkiExportArgs({
      documentId: ' doc-export ', format: 'APKG',
    });
    expect(document.selector).toEqual({ kind: 'document', documentId: 'doc-export' });
    expect(document.format).toBe('apkg');

    const library = parseChatAnkiExportArgs({
      libraryCardIds: [' card-b ', 'card-a'], format: 'json',
    });
    expect(library.selector).toEqual({ kind: 'libraryCards', cardIds: ['card-b', 'card-a'] });

    expect(errorText(captureError(() => parseChatAnkiExportArgs({
      documentId: 'doc-export', libraryCardIds: ['card-a'], format: 'json',
    })))).toContain('mutually exclusive');
    expect(errorText(captureError(() => parseChatAnkiExportArgs({ format: 'json' }))))
      .toContain('mutually exclusive');
    expect(errorText(captureError(() => parseChatAnkiExportArgs({
      libraryCardIds: ['card-a'], format: 'apkg',
    })))).toContain('format=json');
    expect(errorText(captureError(() => parseChatAnkiExportArgs({
      libraryCardIds: ['card-a', ' card-a '], format: 'json',
    })))).toContain('duplicate');
    expect(errorText(captureError(() => parseChatAnkiExportArgs({
      libraryCardIds: [' '], format: 'json',
    })))).toContain('empty');
    expect(errorText(captureError(() => parseChatAnkiExportArgs({
      libraryCardIds: Array.from({ length: 101 }, (_, index) => `card-${index}`),
      format: 'json',
    })))).toContain('1 to 100');
  });

  it('test_chatanki_delete_and_add_card_arguments', () => {
    const deleteArgs = parseChatAnkiDeleteCardArgs({
      cardId: 'card-delete-args', expectedVersion: 'v1', expectedReviewVersion: null,
    });
    expect(deleteArgs.cardId).toBe('card-delete-args');
    expect(deleteArgs.expectedVersion).toBe('v1');
    expect(deleteArgs.expectedReviewVersion).toBeNull();

    const enqueued = parseChatAnkiDeleteCardArgs({
      cardId: 'card-delete-enqueued', expectedVersion: 'v2', expectedReviewVersion: 7,
    });
    expect(enqueued.expectedReviewVersion).toBe(7);

    expect(errorText(captureError(() => parseChatAnkiDeleteCardArgs({
      cardId: 'card-delete-missing-review', expectedVersion: 'v1',
    })))).toContain('use null');
    expect(captureError(() => parseChatAnkiDeleteCardArgs({
      cardId: 'card-delete-negative-review', expectedVersion: 'v1', expectedReviewVersion: -1,
    }))).not.toBeNull();

    const addArgs = parseChatAnkiAddCardsArgs({
      documentId: 'doc-add-args',
      cards: [{
        front: 'Question', back: 'Answer', tags: ['agent'],
        extraFields: { ' Hint ': 'value' }, templateId: 'design-swiss',
      }],
    });
    expect(addArgs.documentId).toBe('doc-add-args');
    expect(addArgs.cards).toHaveLength(1);
    expect(addArgs.cards[0]?.front).toBe('Question');
    expect(addArgs.cards[0]?.back).toBe('Answer');
    expect(normalizeAgentExtraFields(addArgs.cards[0]?.extraFields ?? {}).hint).toBe('value');
  });

  it('test_chatanki_enqueue_review_arguments_require_exactly_one_selector', () => {
    const document = parseChatAnkiEnqueueReviewArgs({ documentId: '  doc-review  ' });
    expect(document).toEqual({ kind: 'document', documentId: 'doc-review' });

    const cards = parseChatAnkiEnqueueReviewArgs({
      cardIds: [' card-a ', 'card-a', 'card-b'],
    });
    expect(cards).toEqual({ kind: 'cards', cardIds: ['card-a', 'card-b'] });

    for (const invalid of [
      {},
      { documentId: 'doc', cardIds: ['card'] },
      { documentId: '  ' },
      { cardIds: [] },
      { cardIds: [' '] },
    ]) {
      expect(captureError(() => parseChatAnkiEnqueueReviewArgs(invalid)), JSON.stringify(invalid))
        .not.toBeNull();
    }

    const tooMany = Array.from({ length: 101 }, (_, index) => `card-${index}`);
    expect(errorText(captureError(() => parseChatAnkiEnqueueReviewArgs({ cardIds: tooMany }))))
      .toContain('1 to 100');
  });

  it('test_chatanki_agent_review_arguments_are_strict_and_normalized', () => {
    const undo = parseChatAnkiUndoLastReviewArgs({
      cardId: ' card-undo ', expectedReviewVersion: 7, expectedLogId: ' log-7 ',
    });
    expect(undo.cardId).toBe('card-undo');
    expect(undo.expectedReviewVersion).toBe(7);
    expect(undo.expectedLogId).toBe('log-7');

    const suspend = parseChatAnkiSetSuspendedArgs({
      cardId: ' card-suspend ', expectedReviewVersion: 8, suspended: true,
    });
    expect(suspend.cardId).toBe('card-suspend');
    expect(suspend.expectedReviewVersion).toBe(8);
    expect(suspend.suspended).toBe(true);

    for (const invalid of [
      { cardId: 'card', expectedReviewVersion: 1 },
      { cardId: 'card', expectedReviewVersion: 1, expectedLogId: 'log', unexpected: true },
      { cardId: 'card', expectedReviewVersion: '1', expectedLogId: 'log' },
    ]) {
      expect(captureError(() => parseChatAnkiUndoLastReviewArgs(invalid)),
        JSON.stringify(invalid)).not.toBeNull();
    }
    expect(captureError(() => parseChatAnkiUndoLastReviewArgs({
      cardId: ' ', expectedReviewVersion: 1, expectedLogId: 'log',
    }))).not.toBeNull();
    expect(captureError(() => parseChatAnkiSetSuspendedArgs({
      cardId: 'card', expectedReviewVersion: -1, suspended: false,
    }))).not.toBeNull();
    expect(captureError(() => parseChatAnkiSetSuspendedArgs({
      cardId: 'card', expectedReviewVersion: 1, suspended: false, extra: 'rejected',
    }))).not.toBeNull();
  });

  it('test_chatanki_review_versions_keep_the_full_i64_wire_range', () => {
    // 2^63 - 1024 is exactly representable in IEEE-754 and still a valid i64.
    const large = 2 ** 63 - 1024;
    expect(parseChatAnkiUndoLastReviewArgs({
      cardId: 'card', expectedReviewVersion: large, expectedLogId: 'log',
    }).expectedReviewVersion).toBe(large);
    expect(parseChatAnkiSetSuspendedArgs({
      cardId: 'card', expectedReviewVersion: large, suspended: false,
    }).expectedReviewVersion).toBe(large);
    expect(parseChatAnkiUndoLibraryLastReviewArgs({
      cardId: 'card', expectedReviewVersion: large, expectedLogId: 'log',
    }).expectedReviewVersion).toBe(large);
    expect(parseChatAnkiSetLibrarySuspendedArgs({
      cardId: 'card', expectedReviewVersion: large, suspended: false,
    }).expectedReviewVersion).toBe(large);
    expect(parseChatAnkiDeleteCardArgs({
      cardId: 'card', expectedVersion: 'v1', expectedReviewVersion: large,
    }).expectedReviewVersion).toBe(large);
    expect(parseChatAnkiDeleteLibraryCardArgs({
      cardId: 'card', expectedVersion: 'v1', expectedReviewVersion: large,
    }).expectedReviewVersion.value).toBe(large);

    // Still reject values outside the Rust i64 domain: arbitrary_precision's
    // Number::deserialize_i64 is `str::parse::<i64>`, so overflow is `invalid number`.
    const overflow = 2 ** 63;
    expect(errorText(captureError(() => parseChatAnkiSetSuspendedArgs({
      cardId: 'card', expectedReviewVersion: overflow, suspended: false,
    })))).toBe('invalid number');
    expect(errorText(captureError(() => parseChatAnkiDeleteCardArgs({
      cardId: 'card', expectedVersion: 'v1', expectedReviewVersion: -(2 ** 64),
    })))).toBe('invalid number');
  });

  it('D3 preserves exact bigint review snapshot tokens for all session/library CAS parsers', () => {
    for (const token of [9007199254740993n, 9223372036854774785n, 9223372036854775807n]) {
      const args = { cardId: 'card', expectedReviewVersion: token, suspended: false, expectedLogId: 'log' };
      expect(parseChatAnkiSetSuspendedArgs({
        cardId: args.cardId, expectedReviewVersion: token, suspended: args.suspended,
      }).expectedReviewVersion).toBe(token);
      expect(parseChatAnkiSetLibrarySuspendedArgs({
        cardId: args.cardId, expectedReviewVersion: token, suspended: args.suspended,
      }).expectedReviewVersion).toBe(token);
      expect(parseChatAnkiUndoLastReviewArgs({
        cardId: args.cardId, expectedReviewVersion: token, expectedLogId: args.expectedLogId,
      }).expectedReviewVersion).toBe(token);
      expect(parseChatAnkiUndoLibraryLastReviewArgs({
        cardId: args.cardId, expectedReviewVersion: token, expectedLogId: args.expectedLogId,
      }).expectedReviewVersion).toBe(token);
      expect(parseChatAnkiDeleteCardArgs({
        cardId: args.cardId, expectedReviewVersion: token, expectedVersion: 'v1',
      }).expectedReviewVersion).toBe(token);
      expect(parseChatAnkiDeleteLibraryCardArgs({
        cardId: args.cardId, expectedReviewVersion: token, expectedVersion: 'v1',
      }).expectedReviewVersion.value).toBe(token);
    }
    expect(() => parseChatAnkiSetSuspendedArgs({
      cardId: 'card', expectedReviewVersion: 9223372036854775808n, suspended: true,
    })).toThrow(/^invalid number$/);
    expect(() => parseChatAnkiUndoLastReviewArgs({
      cardId: 'card', expectedReviewVersion: -1n, expectedLogId: 'log',
    })).toThrow('non-negative expectedReviewVersion');
  });

  it('test_chatanki_retemplate_selector_validation_and_unknown_fields', () => {
    const validVersions = { 'card-1': 'v1' };
    for (const invalid of [
      {
        targetTemplateId: 'design-lexicon', strategy: 'map_only',
        expectedVersions: validVersions,
      },
      {
        documentId: 'doc-1', cardIds: ['card-1'], targetTemplateId: 'design-lexicon',
        strategy: 'map_only', expectedVersions: { 'card-1': 'v1' },
      },
      {
        cardIds: [], targetTemplateId: 'design-lexicon', strategy: 'map_only',
        expectedVersions: { 'card-1': 'v1' },
      },
      {
        cardIds: ['card-1', ' card-1 '], targetTemplateId: 'design-lexicon',
        strategy: 'map_only', expectedVersions: { 'card-1': 'v1' },
      },
    ]) {
      expect(captureError(() => parseChatAnkiRetemplateArgs(invalid)),
        JSON.stringify(invalid)).not.toBeNull();
    }

    const overLimit = Array.from({ length: 101 }, (_, index) => `card-${index}`);
    expect(captureError(() => parseChatAnkiRetemplateArgs({
      cardIds: overLimit,
      targetTemplateId: 'design-lexicon',
      strategy: 'fill_missing',
      expectedVersions: { 'card-0': 'v1' },
    }))).not.toBeNull();

    expect(captureError(() => parseChatAnkiRetemplateArgs({
      documentId: 'doc-1',
      targetTemplateId: 'design-lexicon',
      strategy: 'map_only',
      expectedVersions: { 'card-1': 'v1' },
      unexpected: true,
    }))).not.toBeNull();
  });

  it('test_chatanki_retemplate_strategy_parses_fill_missing_llm', () => {
    for (const raw of ['map_only', 'fill_missing', 'fill_missing_llm']) {
      expect(parseChatAnkiRetemplateStrategy(raw)).toBe(raw);
    }
    expect(captureError(() => parseChatAnkiRetemplateStrategy('fill_all_llm'))).not.toBeNull();
  });
});

describe('chatanki_executor.rs (argument contract extras)', () => {
  it('test_chatanki_get_cards_owned_snapshot_page_boundaries_and_filters', () => {
    const cards = [1, 2, 3, 4, 5].map((index) => makeCard(
      `card-${index}`, `front-${index}`, 'back',
    ));
    for (const card of cards) card.updated_at = card.created_at;
    cards[1]!.is_error_card = true;
    cards[3]!.is_error_card = true;
    cards[2]!.updated_at = '2026-07-13T00:00:01Z';
    cards[3]!.updated_at = '2026-07-13T00:00:02Z';

    const first = selectChatankiCardsPage(cards, 'all', 1, 2);
    expect(first.total).toBe(5);
    expect(first.items.map((item) => item.id)).toEqual(['card-1', 'card-2']);
    const final = selectChatankiCardsPage(cards, 'all', 3, 2);
    expect(final.items.map((item) => item.id)).toEqual(['card-5']);
    expect(selectChatankiCardsPage(cards, 'all', 4, 2).items).toEqual([]);

    const errors = selectChatankiCardsPage(cards, 'error_only', 1, 10);
    expect(errors.total).toBe(2);
    expect(errors.items.map((item) => item.id)).toEqual(['card-2', 'card-4']);
    expect(errors.items.map((item) => item.index)).toEqual([2, 4]);

    const edited = selectChatankiCardsPage(cards, 'edited_only', 1, 10);
    expect(edited.total).toBe(2);
    expect(edited.items.map((item) => item.id)).toEqual(['card-3', 'card-4']);
  });

  it('retemplate_parser_returns_normalized_selectors_and_versions', () => {
    const request = parseChatAnkiRetemplateArgs({
      documentId: ' doc-1 ',
      targetTemplateId: ' design-lexicon ',
      strategy: 'fill_missing_llm',
      expectedVersions: { ' card-1 ': ' v1 ' },
    });
    expect(request.selector).toEqual({ kind: 'document', documentId: 'doc-1' });
    expect(request.targetTemplateId).toBe('design-lexicon');
    expect(request.strategy).toBe('fill_missing_llm');
    expect(request.expectedVersions['card-1']).toBe('v1');
  });

  it('serde reports missing fields in struct order and finishes decoding before normalize runs', () => {
    expect(errorText(captureError(() => parseChatAnkiUpdateCardArgs({})))).toBe('missing field `cardId`');
    expect(errorText(captureError(() => parseChatAnkiUpdateCardArgs({ cardId: 'c' }))))
      .toBe('missing field `patch`');
    // ChatAnkiRetemplateArgs: target_template_id → strategy → expected_versions, then normalize().
    for (const [raw, expected] of [
      [{}, 'missing field `targetTemplateId`'],
      [{ targetTemplateId: 't' }, 'missing field `strategy`'],
      [{ targetTemplateId: 't', strategy: 'map_only' }, 'missing field `expectedVersions`'],
      [{ targetTemplateId: ' ', strategy: 'map_only', expectedVersions: { c: 'v' } },
        'blocks.ankiCards.errors.retemplateSelectorRequired'],
      [{ documentId: 'd', targetTemplateId: 't', strategy: 'map_only', expectedVersions: null },
        'invalid type: null, expected a map'],
      [{ documentId: 'd', targetTemplateId: 't', strategy: 'map_only', expectedVersions: {} },
        'expectedVersions must not be empty'],
    ] as const) {
      expect(errorText(captureError(() => parseChatAnkiRetemplateArgs(raw))), JSON.stringify(raw)).toBe(expected);
    }
  });

  it('JSON.rawJSON integer atoms decode by literal; Value stores -0 as i64 0', () => {
    const raw = (text: string): unknown => (JSON as typeof JSON & { rawJSON(text: string): unknown }).rawJSON(text);
    expect(parseChatAnkiGetCardsArgs({ documentId: 'd', page: raw('-0'), pageSize: raw('7') }))
      .toMatchObject({ page: 0, pageSize: 7 });
    expect(errorText(captureError(() => parseChatAnkiGetCardsArgs({ documentId: 'd', page: raw('-0.0') }))))
      .toBe('invalid number');
    expect(parseChatAnkiListLibraryCardsArgs({ page: raw('3'), pageSize: raw('-0') }))
      .toMatchObject({ page: 3, pageSize: 1 });
    for (const text of ['2.0', '1e1', '4294967296']) {
      expect(errorText(captureError(() => parseChatAnkiListLibraryCardsArgs({ page: raw(text) }))))
        .toBe('invalid number');
    }
  });

  it('integers follow arbitrary_precision Value decoding; list_templates paging is usize', () => {
    // Non-numbers reach the primitive visitor (`expected u32`); numbers are
    // `str::parse`d from their literal, so any numeric misfit is `invalid number`.
    expect(errorText(captureError(() => parseChatAnkiGetCardsArgs({ documentId: 'd', page: 'x' }))))
      .toBe('invalid type: string "x", expected u32');
    expect(errorText(captureError(() => parseChatAnkiGetCardsArgs({ documentId: 'd', pageSize: 1.5 }))))
      .toBe('invalid number');
    expect(errorText(captureError(() => parseChatAnkiGetCardsArgs({ documentId: 'd', page: 2 ** 32 }))))
      .toBe('invalid number');
    expect(errorText(captureError(() => parseChatAnkiGetCardsArgs({ documentId: 'd', page: -0 }))))
      .toBe('invalid number');
    expect(errorText(captureError(() => parseChatAnkiSetSuspendedArgs({
      cardId: 'c', expectedReviewVersion: '1', suspended: true,
    })))).toBe('invalid type: string "1", expected i64');
    expect(errorText(captureError(() => parseChatAnkiListTemplatesArgs({ page: -1 }))))
      .toBe('invalid number');
    expect(errorText(captureError(() => parseChatAnkiListTemplatesArgs({ pageSize: true }))))
      .toBe('invalid type: boolean `true`, expected usize');
    expect(parseChatAnkiListTemplatesArgs({ page: 2 ** 40, pageSize: 0 }))
      .toEqual({ category: null, activeOnly: null, page: 2 ** 40, pageSize: 0 });
  });

  it('Value Unexpected, OneOf lists and unit enums match serde_json from_value', () => {
    expect(errorText(captureError(() => parseChatAnkiGetCardsArgs({ documentId: 7 }))))
      .toBe('invalid type: number, expected a string');
    expect(errorText(captureError(() => parseChatAnkiGetCardsArgs({ documentId: 'd', page: 'a\u0001"b' }))))
      .toBe('invalid type: string "a\\u{1}\\"b", expected u32');
    // Value::deserialize_enum: string, or a one-key map whose payload is unit.
    expect(parseChatAnkiGetCardsArgs({ documentId: 'd', filter: { error_only: null } }).filter).toBe('error_only');
    expect(errorText(captureError(() => parseChatAnkiGetCardsArgs({ documentId: 'd', filter: 1 }))))
      .toBe('invalid type: number, expected string or map');
    expect(errorText(captureError(() => parseChatAnkiGetCardsArgs({ documentId: 'd', filter: null }))))
      .toBe('invalid type: null, expected string or map');
    expect(errorText(captureError(() => parseChatAnkiGetCardsArgs({ documentId: 'd', filter: 'some' }))))
      .toBe('unknown variant `some`, expected one of `all`, `error_only`, `edited_only`');
    expect(errorText(captureError(() => parseChatAnkiRetemplateArgs({
      documentId: 'd', targetTemplateId: 't', strategy: { map_only: true }, expectedVersions: { c: 'v' },
    })))).toBe('invalid type: boolean `true`, expected unit');
    // OneOf: one name is bare, two are joined with `or`.
    expect(errorText(captureError(() => parseChatAnkiDeleteCardsArgs({ cards: [], extra: 1 }))))
      .toBe('unknown field `extra`, expected `cards`');
    expect(errorText(captureError(() => parseChatAnkiEnqueueReviewArgs({ documentId: 'd', limit: 1 }))))
      .toBe('unknown field `limit`, expected `documentId` or `cardIds`');
    expect(errorText(captureError(() => parseChatAnkiImportApkgArgs({ path: '/x.apkg', deck: 'd' }))))
      .toBe('unknown field `deck`, expected `resourceId` or `path`');
  });

  it('session parsers decode every present key in input order, then report missing fields, then normalize', () => {
    for (const [run, expected] of [
      // A present but mistyped key wins over an earlier-declared missing field.
      [() => parseChatAnkiDeleteCardArgs({ expectedVersion: 5 }), 'invalid type: number, expected a string'],
      [() => parseChatAnkiUpdateCardArgs({ expectedVersion: 1 }), 'invalid type: number, expected a string'],
      [() => parseChatAnkiSetSuspendedArgs({ suspended: 'yes' }), 'invalid type: string "yes", expected a boolean'],
      [() => parseChatAnkiDeleteCardArgs({ extra: 1, cardId: 2 }),
        'unknown field `extra`, expected one of `cardId`, `expectedVersion`, `expectedReviewVersion`'],
      [() => parseChatAnkiDeleteCardArgs({ cardId: 2, extra: 1 }), 'invalid type: number, expected a string'],
      // normalize() only runs once serde has decoded every field.
      [() => parseChatAnkiDeleteCardArgs({ cardId: ' ', expectedVersion: 'v', expectedReviewVersion: 'x' }),
        'invalid type: string "x", expected i64'],
      [() => parseChatAnkiExportArgs({ format: 'csv', deckName: 1 }), 'invalid type: number, expected a string'],
      [() => parseChatAnkiExportArgs({ format: 'csv' }), 'Unsupported export format: csv'],
      // ChatAnkiAddCardInput is deny_unknown_fields; `#[serde(default)]` does not accept null.
      [() => parseChatAnkiAddCardsArgs({ documentId: 'd', cards: [{ front: 'f', note: 'x' }] }),
        'unknown field `note`, expected one of `front`, `back`, `text`, `tags`, `extraFields`, `extra_fields`, `templateId`'],
      [() => parseChatAnkiAddCardsArgs({ documentId: 'd', cards: [{ front: null }] }), 'invalid type: null, expected a string'],
      [() => parseChatAnkiAddCardsArgs({ documentId: 'd', cards: [{ tags: null }] }), 'invalid type: null, expected a sequence'],
      // An alias and its field name in one map are the same field.
      [() => parseChatAnkiUpdateCardArgs({ cardId: 'c', patch: { extraFields: {}, extra_fields: {} }, expectedVersion: 'v' }),
        'duplicate field `extraFields`'],
    ] as const) {
      expect(errorText(captureError(run)), String(run)).toBe(expected);
    }
    expect(parseChatAnkiAddCardsArgs({ documentId: 'd', cards: [{ text: null, extra_fields: { A: 'x' } }], extra: true }))
      .toEqual({ documentId: 'd', cards: [{ front: '', back: '', text: null, tags: [], extraFields: { A: 'x' }, templateId: null }] });
    expect(parseChatAnkiUpdateCardArgs({ cardId: 'c', patch: { text: null }, expectedVersion: 'v', note: 1 }).patch)
      .toEqual({ text: null });
  });
});

describe('chatanki_executor.rs (apkg import source)', () => {
  it('test_chatanki_import_apkg_args_require_one_safe_source', () => {
    const resource = parseChatAnkiImportApkgArgs({ resourceId: ' res_apkg ' });
    expect(resource).toEqual({ kind: 'resourceId', resourceId: 'res_apkg' });

    const absolute = join(tmpdir(), `cards-${Date.now()}.apkg`);
    const path = parseChatAnkiImportApkgArgs({ path: absolute });
    expect(path).toEqual({ kind: 'absolutePath', path: absolute });

    for (const invalid of [
      {},
      { resourceId: 'file_apkg', path: '/tmp/cards.apkg' },
      { path: 'relative/cards.apkg' },
      { resourceId: 'note_not_a_file' },
    ]) {
      const error = captureError(() => parseChatAnkiImportApkgArgs(invalid));
      expect(error, JSON.stringify(invalid)).not.toBeNull();
      expect(errorText(error).length).toBeGreaterThan(0);
    }
  });
});
