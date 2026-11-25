import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnkiTemplateCardFace } from '@/components/anki/AnkiTemplateCardFace';
import { TRANSPARENT_PIXEL_DATA_URL } from '@/components/anki/utils/cardMedia';
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
  it('renders template math with native MathML and Anki card styles inside the sandbox', () => {
    const mathTemplate = { ...template, front_template: '<div>{{Text}}</div><code>\\(raw\\)</code>', css_style: '.card { color: red; }' };
    const mathCard = { ...card, extra_fields: { Text: 'Energy \\(E=mc^2\\) <img src="bad" onerror="alert(1)">' } };
    const view = render(<AnkiTemplateCardFace card={mathCard} template={mathTemplate} side="front" />);
    const doc = new DOMParser().parseFromString(view.container.querySelector('iframe')!.getAttribute('srcdoc')!, 'text/html');
    expect(doc.body.classList.contains('card')).toBe(true);
    expect(doc.querySelector('math')).not.toBeNull();
    expect(doc.querySelector('msup')).not.toBeNull();
    expect(doc.querySelector('code')?.textContent).toBe('\\(raw\\)');
    expect(doc.querySelector('img')?.hasAttribute('onerror')).toBe(false);
  });

  it('preserves imported cloze ordinal when its template is unavailable', () => {
    const multi = { ...card, text: '{{c1::Alpha}} and {{c2::Beta}}', extra_fields: { AnkiCardOrd: '1' } };
    const view = render(<AnkiTemplateCardFace card={multi} side="front" />);
    const srcdoc = view.container.querySelector('iframe')!.getAttribute('srcdoc')!;
    expect(srcdoc).toContain('Alpha');
    expect(srcdoc).not.toContain('Beta');
    view.rerender(<AnkiTemplateCardFace card={multi} side="back" />);
    expect(view.container.querySelector('iframe')!.getAttribute('srcdoc')).toContain('Beta');
  });

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

  it('masks only the AnkiCardOrd cloze for imported multi-cloze cards', () => {
    const multiText = '{{c1::Alpha}} and {{c2::Beta}}';
    const multi: AnkiCard = {
      id: 'card-multi-cloze',
      front: '',
      back: '',
      text: multiText,
      tags: [],
      images: [],
      // apkg 导入卡：AnkiCardOrd=1（0 起）→ 对应 c2
      extra_fields: { Text: multiText, AnkiCardOrd: '1' },
    };

    const view = render(
      <AnkiTemplateCardFace card={multi} template={template} side="front" />,
    );
    const frontSrcdoc = view.container.querySelector('iframe')?.getAttribute('srcdoc') || '';
    expect(frontSrcdoc).toContain('Alpha');
    expect(frontSrcdoc).toContain('[...]');
    expect(frontSrcdoc).not.toContain('Beta');
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

  afterEach(() => {
    document.documentElement.classList.remove('dark');
    document.documentElement.removeAttribute('data-theme');
  });

  it('never emits raw unresolved relative image src into srcdoc before media resolves (G17 CSP zero-error)', () => {
    const imgCard: AnkiCard = {
      ...card,
      id: 'card-csp-pending',
      front: '<div>Protein plot: <img src="real_protein_plots.png"> [sound:real_audio.mp3]</div>',
      back: 'Back',
      text: '',
      extra_fields: {},
      images: [],
    };
    const { container } = render(
      <AnkiTemplateCardFace card={imgCard} template={null} side="front" compact={false} interactiveFrame />,
    );
    const srcdoc = container.querySelector('iframe')?.getAttribute('srcdoc') ?? '';
    expect(srcdoc).not.toContain('src="real_protein_plots.png"');
    expect(srcdoc).toContain(`src="${TRANSPARENT_PIXEL_DATA_URL}"`);
    expect(srcdoc).toContain('data-anki-media-pending="1"');
    expect(srcdoc).toContain('<button type="button" class="anki-sound anki-sound-btn"');
  });

  it('threads darkMode into sandbox body nightMode classes for dark-mode Cloze contrast (G18)', () => {
    document.documentElement.classList.add('dark');
    const { container } = render(
      <AnkiTemplateCardFace card={card} template={template} side="front" />,
    );
    const doc = new DOMParser().parseFromString(
      container.querySelector('iframe')!.getAttribute('srcdoc')!,
      'text/html',
    );
    expect(doc.body.classList.contains('card')).toBe(true);
    expect(doc.body.classList.contains('nightMode')).toBe(true);
    expect(doc.body.classList.contains('night_mode')).toBe(true);
    expect(doc.head.textContent).toContain('body.card.nightMode .glass-panel .cloze');
  });

  it('opens full-resolution zoom lightbox on sdp-image-click and light-DOM image click without flipping, closing on Esc or backdrop (S5)', () => {
    const PNG_200DPI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const onFlip = vi.fn();
    const imgCard: AnkiCard = {
      ...card,
      id: 'card-zoom-s5',
      front: `<div>Diagram: <img src="${PNG_200DPI}" alt="Protein 200-DPI"></div>`,
      back: 'Back',
      text: '',
      extra_fields: {},
      images: [],
    };

    const { container } = render(
      <div onClick={onFlip}>
        <AnkiTemplateCardFace
          card={imgCard}
          template={null}
          side="front"
          compact={false}
          interactiveFrame
          onFrameClick={onFlip}
        />
      </div>,
    );

    const iframe = container.querySelector('iframe')!;
    expect(iframe).not.toBeNull();

    // Simulate sdp-image-click postMessage from sandbox iframe
    fireEvent(
      window,
      new MessageEvent('message', {
        data: { type: 'sdp-image-click', src: PNG_200DPI, alt: 'Protein 200-DPI' },
        source: iframe.contentWindow,
      }),
    );

    expect(screen.getByTestId('anki-image-lightbox')).toBeInTheDocument();
    expect(screen.getByTestId('anki-image-lightbox-img')).toHaveAttribute('src', PNG_200DPI);
    expect(onFlip).not.toHaveBeenCalled();

    // Zoom controls work without flipping
    fireEvent.click(screen.getByTestId('anki-image-lightbox-zoom-in'));
    expect(screen.getByTestId('anki-image-lightbox-reset')).toHaveTextContent('150%');
    expect(onFlip).not.toHaveBeenCalled();

    // Esc closes lightbox without flipping
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('anki-image-lightbox')).not.toBeInTheDocument();
    expect(onFlip).not.toHaveBeenCalled();

    // Re-open via light-DOM plain-text image attachment and close via backdrop click
    const plainImgCard: AnkiCard = {
      ...card,
      id: 'card-zoom-plain',
      front: 'Inspect scientific figure',
      back: 'Answer',
      text: '',
      extra_fields: {},
      images: [PNG_200DPI],
    };
    const { container: plainContainer } = render(
      <div onClick={onFlip}>
        <AnkiTemplateCardFace
          card={plainImgCard}
          template={null}
          side="front"
          compact={false}
          interactiveFrame
        />
      </div>,
    );
    fireEvent.click(plainContainer.querySelector('img')!);
    expect(screen.getByTestId('anki-image-lightbox')).toBeInTheDocument();
    expect(onFlip).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('anki-image-lightbox-backdrop'));
    expect(screen.queryByTestId('anki-image-lightbox')).not.toBeInTheDocument();
    expect(onFlip).not.toHaveBeenCalled();
  });
});
