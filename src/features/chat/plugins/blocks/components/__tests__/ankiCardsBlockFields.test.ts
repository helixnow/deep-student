import { describe, expect, it } from 'vitest';
import type { AnkiCard, CustomAnkiTemplate } from '@/types';
import {
  getCaseInsensitiveValue,
  getRetryableTaskIds,
  hasRealCardId,
  isTemplateCompatibleWithCard,
  mapBlockStatusToPreviewStatus,
  resolveEditableFields,
  resolveSpecialFieldFallback,
  resolveZombieCompletionState,
  setCaseInsensitiveValue,
  toStringRecord,
  tryParseFrontAsFields,
} from '../ankiCardsBlockFields';

function makeCard(overrides: Partial<AnkiCard> = {}): AnkiCard {
  return {
    id: 'card-1',
    front: 'Front text',
    back: 'Back text',
    tags: [],
    ...overrides,
  };
}

function makeTemplate(overrides: Partial<CustomAnkiTemplate> = {}): CustomAnkiTemplate {
  return {
    id: 'tpl-1',
    name: 'Test Template',
    fields: ['Question', 'Answer'],
    front_template: '{{Question}}',
    back_template: '{{Answer}}',
    css: '',
    ...overrides,
  } as CustomAnkiTemplate;
}

describe('ankiCardsBlockFields', () => {
  describe('getRetryableTaskIds', () => {
    it('extracts unique failed and truncated task ids', () => {
      expect(
        getRetryableTaskIds([
          { id: 't1', status: 'Failed' },
          { id: 't2', status: 'completed' },
          { id: ' t3 ', status: ' TRUNCATED ' },
          { id: 't1', status: 'failed' },
          { id: '', status: 'failed' },
          { id: 123, status: 'failed' },
        ]),
      ).toEqual(['t1', 't3']);
    });

    it('returns empty array for non-array input', () => {
      expect(getRetryableTaskIds(null)).toEqual([]);
      expect(getRetryableTaskIds(undefined)).toEqual([]);
      expect(getRetryableTaskIds({ id: 't1', status: 'failed' })).toEqual([]);
    });
  });

  describe('hasRealCardId', () => {
    it('accepts persisted ids and rejects empty or synthetic/batch ids', () => {
      expect(hasRealCardId({ id: 'card-db-123' })).toBe(true);
      expect(hasRealCardId({ id: '  real-id  ' })).toBe(true);
      expect(hasRealCardId({ id: '' })).toBe(false);
      expect(hasRealCardId({ id: '   ' })).toBe(false);
      expect(hasRealCardId({ id: undefined })).toBe(false);
      expect(hasRealCardId({ id: 'anki_synthetic_123' })).toBe(false);
      expect(hasRealCardId({ id: 'chat-batch-block-0' })).toBe(false);
    });
  });

  describe('isTemplateCompatibleWithCard', () => {
    it('returns false when template is null/undefined and true when no required fields', () => {
      expect(isTemplateCompatibleWithCard(makeCard(), null)).toBe(false);
      expect(isTemplateCompatibleWithCard(makeCard(), undefined)).toBe(false);
      expect(isTemplateCompatibleWithCard(makeCard(), makeTemplate())).toBe(true);
    });

    it('checks required fields case-insensitively across fields, extra_fields, and base properties', () => {
      const template = makeTemplate({
        field_extraction_rules: {
          Question: { is_required: true } as any,
          Front: { is_required: true } as any,
          Optional: { is_required: false } as any,
        },
      });
      expect(
        isTemplateCompatibleWithCard(
          makeCard({ front: 'Q', fields: { question: 'What?' } }),
          template,
        ),
      ).toBe(true);
      expect(
        isTemplateCompatibleWithCard(
          makeCard({ front: 'Q', extra_fields: { QUESTION: 'From extra' } }),
          template,
        ),
      ).toBe(true);
      expect(
        isTemplateCompatibleWithCard(
          makeCard({ front: 'Q', fields: { question: '   ' } }),
          template,
        ),
      ).toBe(false);
    });
  });

  describe('toStringRecord & tryParseFrontAsFields', () => {
    it('normalizes mixed object values into string records', () => {
      expect(toStringRecord(null)).toEqual({});
      expect(toStringRecord(['a'])).toEqual({});
      expect(
        toStringRecord({
          str: 'hello',
          num: 42,
          nil: null,
          undef: undefined,
          nested: { a: 1 },
        }),
      ).toEqual({
        str: 'hello',
        num: '42',
        nil: '',
        undef: '',
        nested: '{"a":1}',
      });
    });

    it('parses JSON object fronts into string fields and ignores invalid/non-object JSON', () => {
      expect(tryParseFrontAsFields(undefined)).toEqual({});
      expect(tryParseFrontAsFields('plain text')).toEqual({});
      expect(tryParseFrontAsFields('[1,2,3]')).toEqual({});
      expect(tryParseFrontAsFields('{bad json}')).toEqual({});
      expect(
        tryParseFrontAsFields('{"Question":"Q1","Score":10,"Empty":null,"Meta":{"k":"v"}}'),
      ).toEqual({
        Question: 'Q1',
        Score: '10',
        Empty: '',
        Meta: '{"k":"v"}',
      });
    });
  });

  describe('case-insensitive record helpers & special field fallbacks', () => {
    it('reads and writes keys case-insensitively while preserving matched casing', () => {
      const rec: Record<string, string> = { Question: 'old' };
      expect(getCaseInsensitiveValue(rec, 'question')).toBe('old');
      expect(getCaseInsensitiveValue(rec, 'missing')).toBeUndefined();

      setCaseInsensitiveValue(rec, 'QUESTION', 'new');
      expect(rec).toEqual({ Question: 'new' });

      setCaseInsensitiveValue(rec, 'Answer', '42');
      expect(rec).toEqual({ Question: 'new', Answer: '42' });
    });

    it('resolves front/back/text fallbacks including localized aliases', () => {
      const card = makeCard({ front: 'F', back: 'B', text: 'Cloze {{c1::ans}}' });
      expect(resolveSpecialFieldFallback(card, 'Front')).toBe('F');
      expect(resolveSpecialFieldFallback(card, '正面')).toBe('F');
      expect(resolveSpecialFieldFallback(card, 'back')).toBe('B');
      expect(resolveSpecialFieldFallback(card, '背面')).toBe('B');
      expect(resolveSpecialFieldFallback(card, 'TEXT')).toBe('Cloze {{c1::ans}}');
      expect(resolveSpecialFieldFallback(card, 'Other')).toBe('');
    });
  });

  describe('resolveEditableFields', () => {
    it('falls back to Front/Back when card and template have no field definitions', () => {
      const card = makeCard({ front: 'Q1', back: 'A1' });
      expect(resolveEditableFields(card, null)).toEqual({
        fieldOrder: ['Front', 'Back'],
        values: { Front: 'Q1', Back: 'A1' },
      });
    });

    it('deduplicates case-insensitively, prioritizes fields > extra_fields > parsed front, and excludes internal fields', () => {
      const card = makeCard({
        front: '{"Question":"from-json","Hint":"json-hint","_occlusion":"{}"}',
        back: 'fallback-back',
        fields: { question: 'from-fields', _qa_flags: '[]' },
        extra_fields: { Answer: 'from-extra', _internal: 'secret', _qa_flags: '[{"code":"x"}]' },
      });
      const template = makeTemplate({ fields: ['Question', 'Answer'] });

      expect(resolveEditableFields(card, template)).toEqual({
        fieldOrder: ['Question', 'Answer', 'Hint'],
        values: {
          Question: 'from-fields',
          Answer: 'from-extra',
          Hint: 'json-hint',
        },
      });
    });
  });

  describe('mapBlockStatusToPreviewStatus', () => {
    it('handles terminal overrides, sync states, and block statuses', () => {
      expect(mapBlockStatusToPreviewStatus('success', 'synced', true, 'cancelled')).toBe('cancelled');
      expect(mapBlockStatusToPreviewStatus('success', 'synced', true, 'canceled')).toBe('cancelled');
      expect(mapBlockStatusToPreviewStatus('success', 'synced', true, 'failed')).toBe('error');
      expect(mapBlockStatusToPreviewStatus('success', 'pending', true, 'error')).toBe('error');
      expect(mapBlockStatusToPreviewStatus('running', 'synced', true)).toBe('stored');
      expect(mapBlockStatusToPreviewStatus('pending', 'pending', false)).toBe('parsing');
      expect(mapBlockStatusToPreviewStatus('running', 'pending', false)).toBe('parsing');
      expect(mapBlockStatusToPreviewStatus('running', 'pending', true)).toBe('ready');
      expect(mapBlockStatusToPreviewStatus('success', 'error', true)).toBe('error');
      expect(mapBlockStatusToPreviewStatus('success', 'pending', true)).toBe('ready');
      expect(mapBlockStatusToPreviewStatus('error', 'pending', true)).toBe('error');
      expect(mapBlockStatusToPreviewStatus('unknown')).toBe('ready');
    });
  });

  describe('resolveZombieCompletionState', () => {
    it('marks usable cards as completed or completed_with_errors depending on task statuses', () => {
      expect(resolveZombieCompletionState(['completed'], [{}])).toEqual({
        finalStatus: 'completed',
        blockStatus: 'success',
      });
      expect(resolveZombieCompletionState(['completed', 'failed'], [{}])).toEqual({
        finalStatus: 'completed_with_errors',
        blockStatus: 'success',
      });
      expect(resolveZombieCompletionState(['cancelled'], [{}])).toEqual({
        finalStatus: 'completed_with_errors',
        blockStatus: 'success',
      });
    });

    it('maps zero usable cards to exact watchdog error keys', () => {
      expect(resolveZombieCompletionState(['canceled'], [])).toEqual({
        finalStatus: 'cancelled',
        blockStatus: 'error',
        errorKey: 'blocks.ankiCards.errors.watchdogCancelledWithoutCards',
      });
      expect(resolveZombieCompletionState(['completed'], [{ is_error_card: true }])).toEqual({
        finalStatus: 'error',
        blockStatus: 'error',
        errorKey: 'blocks.ankiCards.errors.watchdogCompletedWithoutCards',
      });
      expect(resolveZombieCompletionState(['truncated'], [{ isErrorCard: true }])).toEqual({
        finalStatus: 'error',
        blockStatus: 'error',
        errorKey: 'blocks.ankiCards.errors.watchdogFailedWithoutCards',
      });
      expect(resolveZombieCompletionState(['unknown_state'], [])).toEqual({
        finalStatus: 'error',
        blockStatus: 'error',
        errorKey: 'blocks.ankiCards.errors.watchdogUnknownWithoutCards',
      });
    });
  });
});
