import { describe, expect, it } from 'vitest';
import builtinTemplates from '@/data/anki/builtin-templates.json';
import { TemplateRenderService } from '@/services/templateRenderService';
import type { CustomAnkiTemplate } from '@/types';
import {
  applyReviewCardEdit,
  getReviewCardEditValues,
  toRenderableReviewCard,
  type EditableReviewCard,
} from '../reviewCardEditFields';

function builtinTemplate(id: string): CustomAnkiTemplate {
  const raw = builtinTemplates.find((candidate) => candidate.id === id);
  if (!raw) throw new Error(`Missing builtin template: ${id}`);
  return {
    ...raw,
    fields: JSON.parse(raw.fields_json) as string[],
    field_extraction_rules: JSON.parse(raw.field_extraction_rules_json),
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    is_active: true,
    is_built_in: true,
  };
}

describe('review card template-aware editing', () => {
  it('reads and writes design-lab Question/explanation while preserving other fields', () => {
    const template = builtinTemplate('design-lab');
    const card: EditableReviewCard = {
      front: 'stale core question',
      back: 'stale core answer',
      extraFields: {
        Subject: 'Biology',
        Question: 'Actual question',
        Front: 'Legacy injected front',
        optiona: 'A',
        optionb: 'B',
        optionc: 'C',
        optiond: 'D',
        correct: 'A',
        explanation: 'Actual explanation',
        Back: 'Legacy injected back',
        CustomNote: 'keep me',
      },
    };

    expect(getReviewCardEditValues(card, template)).toEqual({
      front: 'Actual question',
      back: 'Actual explanation',
    });

    const edited = applyReviewCardEdit(card, {
      front: 'Edited question',
      back: 'Edited explanation',
    }, template);
    expect(edited.front).toBe('Edited question');
    expect(edited.back).toBe('Edited explanation');
    expect(edited.extraFields.Question).toBe('Edited question');
    expect(edited.extraFields.explanation).toBe('Edited explanation');
    expect(edited.extraFields.Front).toBe('Legacy injected front');
    expect(edited.extraFields.Back).toBe('Legacy injected back');
    expect(edited.extraFields.Subject).toBe('Biology');
    expect(edited.extraFields.CustomNote).toBe('keep me');
  });

  it('keeps distinct Unicode template fields and updates the declared Chinese front/back fields', () => {
    const template = { fields: ['问题', '答案'], note_type: 'Basic' };
    const card: EditableReviewCard = {
      front: '旧 core 正面',
      back: '旧 core 背面',
      extraFields: {
        问题: '真实问题',
        答案: '真实答案',
        来源: '教材',
      },
    };

    expect(getReviewCardEditValues(card, template)).toEqual({
      front: '真实问题',
      back: '真实答案',
    });
    expect(applyReviewCardEdit(card, {
      front: '新问题',
      back: '新答案',
    }, template).extraFields).toEqual({
      问题: '新问题',
      答案: '新答案',
      来源: '教材',
    });
  });

  it('uses design-swiss Front/BackDetail aliases instead of stale core values', () => {
    const template = builtinTemplate('design-swiss');
    const card: EditableReviewCard = {
      front: 'old core front',
      back: 'old core back',
      extraFields: {
        Front: 'Swiss front',
        Author: 'Author',
        BackTitle: 'Definition',
        BackDetail: 'Swiss detail',
      },
    };
    expect(getReviewCardEditValues(card, template)).toEqual({
      front: 'Swiss front',
      back: 'Swiss detail',
    });

    const edited = applyReviewCardEdit(card, { front: 'New term', back: 'New detail' }, template);
    expect(edited.extraFields).toEqual({
      Front: 'New term',
      Author: 'Author',
      BackTitle: 'Definition',
      BackDetail: 'New detail',
    });
  });

  it('re-renders design-lab with the edited primary fields through TemplateRenderService', () => {
    const template = builtinTemplate('design-lab');
    const card: EditableReviewCard = {
      front: 'stale core',
      back: 'stale core',
      extraFields: {
        Subject: 'Physics',
        Question: 'Old rendered question',
        optiona: 'One',
        optionb: 'Two',
        optionc: 'Three',
        optiond: 'Four',
        correct: 'A',
        explanation: 'Old rendered explanation',
      },
    };
    const before = TemplateRenderService.renderCard(toRenderableReviewCard(card), template);
    const edit = applyReviewCardEdit(card, {
      front: 'New rendered question',
      back: 'New rendered explanation',
    }, template);
    const after = TemplateRenderService.renderCard(
      toRenderableReviewCard({ ...card, ...edit }),
      template,
    );

    expect(before.front).toContain('Old rendered question');
    expect(after.front).toContain('New rendered question');
    expect(after.front).not.toContain('Old rendered question');
    expect(after.back).toContain('New rendered explanation');
    expect(after.back).not.toContain('Old rendered explanation');
  });

  it('syncs Cloze text/Text/Extra and re-renders design-redaction with the edited deletion', () => {
    const template = builtinTemplate('design-redaction');
    const card: EditableReviewCard = {
      front: 'stale core front',
      back: 'stale core back',
      text: 'Old context has {{c1::old answer}}.',
      extraFields: {
        Header: 'CONFIDENTIAL',
        Text: 'Old context has {{c1::old answer}}.',
        text: 'Old context has {{c1::old answer}}.',
        Extra: 'Old note',
        Untouched: 'keep me',
      },
    };
    expect(getReviewCardEditValues(card, template)).toEqual({
      front: 'Old context has {{c1::old answer}}.',
      back: 'Old note',
    });

    const before = TemplateRenderService.renderCard(toRenderableReviewCard(card), template);
    const edit = applyReviewCardEdit(card, {
      front: 'New context has {{c1::new answer}}.',
      back: 'New note',
    }, template);
    expect(edit.text).toBe('New context has {{c1::new answer}}.');
    expect(edit.extraFields.Text).toBe('New context has {{c1::new answer}}.');
    expect(edit.extraFields.text).toBe('New context has {{c1::new answer}}.');
    expect(edit.extraFields.Extra).toBe('New note');
    expect(edit.extraFields.Untouched).toBe('keep me');

    const after = TemplateRenderService.renderCard(
      toRenderableReviewCard({ ...card, ...edit }),
      template,
    );
    expect(after.front).not.toBe(before.front);
    expect(after.back).not.toBe(before.back);
    expect(after.front).toContain('New context has');
    expect(after.back).toContain('new answer');
    expect(after.back).toContain('New note');
    expect(after.back).not.toContain('old answer');
  });

  it('allows an empty optional Cloze Extra without synthesizing core back content', () => {
    const template = builtinTemplate('design-redaction');
    const card: EditableReviewCard = {
      front: 'stale core',
      back: '',
      text: 'Earth {{c1::orbits}} the Sun.',
      extraFields: {
        Header: 'SPACE',
        Text: 'Earth {{c1::orbits}} the Sun.',
        Extra: '',
      },
    };

    expect(getReviewCardEditValues(card, template)).toEqual({
      front: 'Earth {{c1::orbits}} the Sun.',
      back: '',
    });
    const edited = applyReviewCardEdit(card, {
      front: 'Mars {{c1::orbits}} the Sun.',
      back: '',
    }, template);
    expect(edited.extraFields.Extra).toBe('');
    expect(edited.back).toBe('');
  });
});
