import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { AnkiCard, CustomAnkiTemplate } from '@/types';

vi.mock('../ShadowDomPreview', () => ({
  ShadowDomPreview: ({ html }: { html: string }) => (
    <div data-testid="mock-shadow-dom-preview">{html.slice(0, 32)}</div>
  ),
}));
vi.mock('@/hooks/useResolvedCardMedia', () => ({
  useResolvedCardMedia: ({ front, back }: { front: string; back: string }) => ({
    front,
    back,
    frontReady: true,
    backReady: true,
  }),
}));

import { AnkiTemplateCardFace, extractAccessibleCardText } from '../AnkiTemplateCardFace';

function sampleCard(overrides: Partial<AnkiCard> = {}): AnkiCard {
  return {
    id: 'card-apkg-1',
    front:
      '<style>.card{font-family:arial}</style><div class="q">What causes osmotic lysis?</div><script>window.x=1</script>[sound:word.mp3]',
    back: '<div><strong>Water influx</strong> bursts the membrane.<br>See chapter 4.</div>',
    tags: [],
    note_type: 'Basic',
    created_at: '2026-11-24T00:00:00Z',
    ...overrides,
  };
}

describe('AnkiTemplateCardFace accessible light-DOM text (S2-09)', () => {
  beforeEach(() => {
    cleanup();
  });

  it('extractAccessibleCardText strips style/script tags and sound markers while preserving text', () => {
    const text = extractAccessibleCardText(
      '<style>.card{color:red}</style><div class="front">Mitosis<br>Prophase</div><script>alert(1)</script>[sound:pronounce.mp3]',
    );
    expect(text).toContain('Mitosis');
    expect(text).toContain('Prophase');
    expect(text).not.toContain('font-family');
    expect(text).not.toContain('color:red');
    expect(text).not.toContain('alert(1)');
    expect(text).not.toContain('[sound:');
  });

const TEMPLATE: CustomAnkiTemplate = {
  id: 'tpl-apkg-1',
  name: 'APKG Template',
  description: 'Imported deck template',
  version: '1.0',
  preview_front: '',
  preview_back: '',
  note_type: 'Basic',
  fields: ['Front', 'Back'],
  generation_prompt: '',
  front_template: '<div class="front-card">{{Front}}</div>',
  back_template: '<div class="back-card">{{Front}}<hr id="answer">{{Back}}</div>',
  css_style: '.front-card { font-family: Arial; }',
  field_extraction_rules: {},
  created_at: '2026-11-24T00:00:00Z',
};

  it('renders readable light-DOM front and back text layers alongside ShadowDomPreview', () => {
    const card = sampleCard();
    const { rerender } = render(
      <AnkiTemplateCardFace
        card={card}
        template={TEMPLATE}
        side="front"
        fallbackText="What causes osmotic lysis?"
      />,
    );

    const frontText = screen.getByTestId('anki-card-face-front-text');
    expect(frontText).toHaveTextContent('What causes osmotic lysis?');
    expect(frontText.textContent).not.toContain('font-family');
    expect(frontText.textContent).not.toContain('[sound:');

    rerender(
      <AnkiTemplateCardFace
        card={card}
        template={TEMPLATE}
        side="back"
        fallbackText="Water influx bursts the membrane."
      />,
    );

    const backText = screen.getByTestId('anki-card-face-back-text');
    expect(backText).toHaveTextContent('Water influx bursts the membrane.');
    expect(backText).toHaveTextContent('See chapter 4.');
  });
});
