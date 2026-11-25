/**
 * S2-09 回归测试：.apkg 嵌入图片与音频在 WebUI 模式下通过 read_anki_media 解析渲染，
 * 列表行不泄露裸文件名/裸标签并展示简洁媒体徽标，展开预览与复习卡面完整渲染媒体。
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import type { AnkiCard, AnkiLibraryCard } from '@/types';

const { invokeMock, convertFileSrcMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  convertFileSrcMock: vi.fn((path: string) => `/api/protocol/asset/${encodeURIComponent(path)}`),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
  convertFileSrc: convertFileSrcMock,
}));

vi.mock('@/hooks/useAnkiTemplateLoader', () => ({
  useAnkiTemplateLoader: () => ({ template: null, loading: false }),
}));

vi.mock('@/utils/lazyStyles', () => ({ ensureKatexStyles: vi.fn() }));
vi.mock('@/components/anki/utils/katexSandboxCss', () => ({
  useKatexSandboxCss: () => null,
}));

import { AnkiTemplateCardFace } from '@/components/anki/AnkiTemplateCardFace';
import { clearCardMediaCache } from '@/components/anki/utils/cardMedia';
import { LibraryCardRow } from '../library/LibraryCardRow';
import { toReviewContent } from '../library/libraryView';
import { summarizeCardMedia } from '../cardMathPreview';

const PNG_DATA = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const MP3_DATA = 'data:audio/mpeg;base64,SUQzAwAAAAAA';

describe('S2-09: Anki .apkg embedded media in WebUI (list + review)', () => {
  beforeEach(() => {
    clearCardMediaCache();
    invokeMock.mockReset();
    convertFileSrcMock.mockClear();
    invokeMock.mockImplementation(async (cmd: string, args?: { path?: string }) => {
      if (cmd === 'read_anki_media') {
        const p = args?.path ?? '';
        if (p.endsWith('qa_img_01.png') || p === 'qa_img_01.png') return PNG_DATA;
        if (p.endsWith('qa_audio_01.mp3') || p === 'qa_audio_01.mp3') return MP3_DATA;
        throw new Error(`unexpected media path: ${p}`);
      }
      return null;
    });
  });

  afterEach(() => {
    clearCardMediaCache();
  });

  it('hides raw filenames and [sound:...] tokens in LibraryCardRow and displays clean media indicator badges', () => {
    const libraryCard = {
      id: 'apkg-card-1',
      front: 'Question 1: Identify structure <img src="qa_img_01.png">',
      back: 'Answer 1 [sound:qa_audio_01.mp3]',
      tags: ['deck::biology'],
      images: ['/custom-webui/anki_media/qa_img_01.png', '/custom-webui/anki_media/qa_audio_01.mp3'],
      fields: {},
      extra_fields: {},
      template_id: null,
      created_at: '2026-10-01T00:00:00Z',
      enqueued: true,
      suspended: false,
      state: 0,
      isDue: false,
      stateId: 'state-1',
    } as unknown as AnkiLibraryCard;

    const noop = () => {};
    const { container, getByTestId } = render(
      <ul>
        <LibraryCardRow
          card={libraryCard}
          busy={false}
          deleting={false}
          selected={false}
          expanded={false}
          confirmingDelete={false}
          onToggleSelect={noop}
          onToggleExpand={noop}
          onStartReview={noop}
          onEnqueue={noop}
          onToggleSuspended={noop}
          onRequestDelete={noop}
          onCancelDelete={noop}
          onConfirmDelete={noop}
          onSaveEdit={async () => true}
          onUndoReview={noop}
          onResetProgress={noop}
          onRowKeyDown={noop}
          rowRef={noop}
        />
      </ul>,
    );

    const frontText = container.querySelector('.wb-fc-row-front')?.textContent ?? '';
    const backText = container.querySelector('.wb-fc-row-back')?.textContent ?? '';
    expect(frontText).toContain('Question 1: Identify structure');
    expect(frontText).not.toContain('qa_img_01.png');
    expect(frontText).not.toContain('<img');
    expect(backText).toContain('Answer 1');
    expect(backText).not.toContain('qa_audio_01.mp3');
    expect(backText).not.toContain('[sound:');

    expect(getByTestId('fc-lib-media-images-apkg-card-1').textContent).toContain('1');
    expect(getByTestId('fc-lib-media-audio-apkg-card-1').textContent).toContain('1');
    expect(summarizeCardMedia(libraryCard)).toEqual({ imageCount: 1, audioCount: 1 });
  });

  it('resolves inline HTML images and [sound:...] via read_anki_media into data URLs on Review face (even when card.images is missing)', async () => {
    const card: AnkiCard = {
      id: 'apkg-review-1',
      front: '<div>Diagram: <img src="qa_img_01.png"> [sound:qa_audio_01.mp3]</div>',
      back: 'Back answer',
      tags: [],
      // Empty card.images simulates missing/dropped paths; inline fallback still resolves via read_anki_media
      images: [],
      template_id: null,
    };

    const { container } = render(
      <AnkiTemplateCardFace
        card={card}
        template={null}
        side="front"
        compact={false}
        interactiveFrame
      />,
    );

    await waitFor(() => {
      const iframe = container.querySelector('iframe');
      expect(iframe).not.toBeNull();
      const srcDoc = iframe?.getAttribute('srcdoc') ?? '';
      expect(srcDoc).toContain(PNG_DATA);
      expect(srcDoc).toContain(`<audio class="anki-audio" controls`);
      expect(srcDoc).toContain(MP3_DATA);
    });
    expect(convertFileSrcMock).not.toHaveBeenCalled();
  });

  it('renders plain-text card image and audio attachments via read_anki_media data URLs instead of 403 asset protocol URLs', async () => {
    const card: AnkiCard = {
      id: 'apkg-plain-1',
      front: 'Listen and identify the diagram',
      back: 'Mitosis',
      tags: [],
      images: [
        '/custom-webui/anki_media/qa_img_01.png',
        '/custom-webui/anki_media/qa_audio_01.mp3',
      ],
      template_id: null,
    };

    const { container } = render(
      <AnkiTemplateCardFace
        card={card}
        template={null}
        side="front"
        compact={false}
        interactiveFrame
      />,
    );

    await waitFor(() => {
      const img = container.querySelector('img');
      const audio = container.querySelector('audio.anki-audio');
      expect(img?.getAttribute('src')).toBe(PNG_DATA);
      expect(audio?.getAttribute('src')).toBe(MP3_DATA);
    });
    // Container must stay interactive when audio controls are rendered in light DOM
    const face = container.querySelector('[data-anki-card-face="front"]');
    expect(face?.getAttribute('data-interactive')).toBe('true');
    expect(face?.className).not.toContain('pointer-events-none');
    expect(convertFileSrcMock).not.toHaveBeenCalled();
  });

  it('preserves images, templateId, text, and extraFields in toReviewContent', () => {
    const libraryCard = {
      id: 'apkg-card-2',
      stateId: 'fsrs-2',
      front: 'Q',
      back: 'A',
      text: 'Cloze {{c1::Q}}',
      tags: ['t1'],
      images: ['/data/anki_media/qa_img_01.png', '/data/anki_media/qa_audio_01.mp3'],
      fields: { Front: 'Q' },
      extra_fields: { AnkiCardOrd: '0' },
      template_id: 'tpl-1',
      created_at: '2026-10-01T00:00:00Z',
      enqueued: true,
      suspended: false,
    } as unknown as AnkiLibraryCard;

    const review = toReviewContent(libraryCard);
    expect(review.images).toEqual(['/data/anki_media/qa_img_01.png', '/data/anki_media/qa_audio_01.mp3']);
    expect(review.templateId).toBe('tpl-1');
    expect(review.text).toBe('Cloze {{c1::Q}}');
    expect(review.extraFields).toEqual({ Front: 'Q', AnkiCardOrd: '0' });
  });
});
