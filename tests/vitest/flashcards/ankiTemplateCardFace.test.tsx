import React from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AnkiTemplateCardFace } from '@/components/anki/AnkiTemplateCardFace';
import type { AnkiCard, CustomAnkiTemplate } from '@/types';

const card: AnkiCard = {
  id: 'card-cloze',
  front: '',
  back: '',
  text: 'The capital is {{c1::Paris::city}}.',
  tags: [],
  images: [],
  extra_fields: { Text: 'The capital is {{c1::Paris::city}}.' },
};

const template: CustomAnkiTemplate = {
  id: 'template-cloze',
  name: 'Cloze',
  description: '',
  version: '1',
  preview_front: '',
  preview_back: '',
  note_type: 'Cloze',
  fields: ['Text'],
  generation_prompt: '',
  front_template: '<div>{{cloze:Text}}</div>',
  back_template: '<div>{{cloze:Text}}</div>',
  css_style: '.cloze { color: transparent; }',
  field_extraction_rules: {},
  created_at: '',
  updated_at: '',
  is_active: true,
  is_built_in: false,
};

describe('AnkiTemplateCardFace', () => {
  it('renders controlled template sides without leaking a Cloze answer on the front', () => {
    const view = render(
      <AnkiTemplateCardFace card={card} template={template} side="front" />,
    );
    const frontSrcdoc = view.container.querySelector('iframe')?.getAttribute('srcdoc') || '';
    expect(frontSrcdoc).toContain('[...]');
    expect(frontSrcdoc).toContain('city');
    expect(frontSrcdoc).not.toContain('Paris');
    expect(frontSrcdoc).not.toContain('cloze-live-reveal');

    view.rerender(
      <AnkiTemplateCardFace card={card} template={template} side="back" />,
    );
    const backSrcdoc = view.container.querySelector('iframe')?.getAttribute('srcdoc') || '';
    expect(backSrcdoc).toContain('Paris');
  });

  it('uses controlled plain-text fallbacks without a template', () => {
    const view = render(
      <AnkiTemplateCardFace
        card={{ ...card, front: 'Question', back: 'Answer' }}
        template={null}
        side="front"
      />,
    );
    expect(view.getByText('Question')).toBeInTheDocument();
    expect(view.container.querySelector('iframe')).toBeNull();

    view.rerender(
      <AnkiTemplateCardFace
        card={{ ...card, front: 'Question', back: 'Answer' }}
        template={null}
        side="back"
      />,
    );
    expect(view.getByText('Answer')).toBeInTheDocument();
  });
});
