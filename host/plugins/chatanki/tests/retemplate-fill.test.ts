import { describe, expect, it } from 'vitest';
import type { AnkiCard } from '../api.ts';
import {
  applyRetemplateFillToCard, buildRetemplateFillPrompt, parseRetemplateFillResponse,
  type AnkiRetemplateCardUpdate, type AnkiRetemplateMissingField,
} from '../src/retemplate-fill.ts';

function makeCard(id: string, front: string, back: string): AnkiCard {
  return {
    id, front, back, text: null, tags: [], images: [], task_id: 'task-fill',
    is_error_card: false, error_content: null, created_at: '2026-08-24T00:00:00Z',
    updated_at: '2026-08-24T01:00:00Z', extra_fields: {}, template_id: null,
  };
}

function cloneCard(card: AnkiCard): AnkiCard {
  return { ...card, tags: [...card.tags], images: [...card.images], extra_fields: { ...card.extra_fields } };
}

function makeRetemplateFillUpdate(
  cardId: string, missing: Array<[string, boolean]>,
): AnkiRetemplateCardUpdate {
  const card = makeCard(cardId, 'front text', 'back text');
  for (const [field] of missing) card.extra_fields[field] = '';
  const missingFields: AnkiRetemplateMissingField[] = missing.map(([field, required]) => ({
    field, required,
  }));
  return {
    documentId: 'doc-fill',
    card: cloneCard(card),
    source: cloneCard(card),
    missingFields,
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

describe('chatanki_executor.rs (retemplate fill_missing_llm phase 2)', () => {
  it('test_chatanki_retemplate_fill_prompt_lists_cards_sources_and_missing_fields', () => {
    const update = makeRetemplateFillUpdate('card-prompt', [['Example', true]]);
    update.source.extra_fields.Hint = 'existing hint';
    const prompt = buildRetemplateFillPrompt('Basic', [update]);
    expect(prompt).toContain('cardId: card-prompt');
    expect(prompt).toContain('目标 noteType：Basic');
    expect(prompt).toContain('- front: front text');
    expect(prompt).toContain('- back: back text');
    expect(prompt).toContain('- Hint: existing hint');
    expect(prompt).toContain('缺失字段：Example（必填）');
    expect(prompt).toContain('"cards"');
    expect(prompt).not.toContain('- Example:');
  });

  it('test_chatanki_retemplate_fill_response_parsing_contract', () => {
    const fenced = '```json\n{"cards":[{"cardId":"card-1","fields":{"Example":"an example","Empty":"  ","Number":42}},{"cardId":"","fields":{"X":"y"}},{"cardId":"card-2","fields":{}}]}\n```';
    const generated = parseRetemplateFillResponse(fenced);
    expect(generated.size).toBe(1);
    const fields = generated.get('card-1');
    expect(fields?.get('Example')).toBe('an example');
    expect(fields?.has('Empty')).toBe(false);
    expect(fields?.has('Number')).toBe(false);

    expect(captureError(() => parseRetemplateFillResponse('no json here'))).not.toBeNull();
    expect(captureError(() => parseRetemplateFillResponse('{"cards":"oops"}'))).not.toBeNull();
    expect(captureError(() => parseRetemplateFillResponse('{}'))).not.toBeNull();
  });

  it('fill parse failures carry the serde_json Value error text (UTF-8 byte columns), duplicate keys are last-wins', () => {
    const message = (raw: string) => (captureError(() => parseRetemplateFillResponse(raw)) as Error).message;
    expect(message('结果：{"cards": [}')).toBe('fill response is not valid JSON: expected value at line 1 column 12');
    expect(message('{"cards":[],}')).toBe('fill response is not valid JSON: trailing comma at line 1 column 13');
    expect(message('{\n  "cards": [{"cardId": "卡",}]\n}'))
      .toBe('fill response is not valid JSON: trailing comma at line 2 column 30');
    expect(message('{"cards":"oops"}')).toBe('fill response missing cards array');
    expect(message('} {')).toBe('fill response contains no JSON object');
    const generated = parseRetemplateFillResponse(
      '{"cards":[{"cardId":"c1","fields":{"Front":"a","Front":"  "}},{"cardId":"c2","cardId":"c3","fields":{"Back":"b"}}]}',
    );
    expect([...generated].map(([id, fields]) => [id, [...fields]])).toEqual([['c3', [['Back', 'b']]]]);
  });

  it('test_chatanki_retemplate_fill_apply_matches_missing_fields_only', () => {
    const update = makeRetemplateFillUpdate(
      'card-apply', [['Example', true], ['Usage Note', false]],
    );
    const generated = {
      Example: 'exact match',
      usage_note: 'normalized match',
      Front: 'must be ignored',
    };

    const { card: filledCard, filledFields } = applyRetemplateFillToCard(update, generated);
    expect(filledFields).toEqual(['Example', 'Usage Note']);
    expect(filledCard.extra_fields.Example).toBe('exact match');
    expect(filledCard.extra_fields['Usage Note']).toBe('normalized match');
    expect(Object.hasOwn(filledCard.extra_fields, 'Front')).toBe(false);
    expect(filledCard.front).toBe('front text');

    const empty = applyRetemplateFillToCard(update, {});
    expect(empty.filledFields).toEqual([]);
  });
});
