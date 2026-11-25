import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import type { AnkiCard } from '@/types';
import { AnkiTemplateCardFace } from '../AnkiTemplateCardFace';
import { clearCardMediaCache } from '../utils/cardMedia';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
}));

const DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function apkgImageCard(overrides: Partial<AnkiCard> = {}): AnkiCard {
  return {
    id: 'card-sota06-1',
    front: '<div>Analyze the plot:<br><img src="real_protein_plots.png"></div>',
    back: 'Plain text answer explaining the protein kinetics.',
    text: '',
    tags: [],
    images: ['/data/anki_media/real_protein_plots.png'],
    note_type: 'Basic',
    created_at: '2026-11-25T00:00:00Z',
    ...overrides,
  };
}

describe('AnkiTemplateCardFace SOTA06 media & layout regressions', () => {
  beforeEach(() => {
    cleanup();
    clearCardMediaCache();
    vi.mocked(invoke).mockReset();
  });

  it('shows non-collapsing placeholder during cold media load, mounts resolved iframe once ready, and hits sync cache with zero flicker on revisit', async () => {
    let resolveMedia!: (value: string) => void;
    const pendingPromise = new Promise<string>((resolve) => {
      resolveMedia = resolve;
    });
    vi.mocked(invoke).mockReturnValueOnce(pendingPromise);

    const card = apkgImageCard();
    const { container, unmount } = render(
      <AnkiTemplateCardFace card={card} side="front" compact={false} />,
    );

    // Cold cache: does not mount a collapsed pending iframe while inline image is still resolving
    const loadingBox = screen.getByTestId('anki-card-media-loading');
    expect(loadingBox).toHaveAttribute('aria-busy', 'true');
    expect(loadingBox.style.minHeight).toBe('200px');
    expect(container.querySelector('iframe')).toBeNull();

    resolveMedia(DATA_URL);

    await waitFor(() => {
      const iframe = container.querySelector('iframe');
      expect(iframe).not.toBeNull();
      const doc = iframe!.getAttribute('srcdoc') ?? '';
      const bodyPart = doc.slice(doc.indexOf('<body'));
      expect(bodyPart).toContain(`src="${DATA_URL}"`);
      expect(bodyPart).not.toContain('data-anki-media-pending="1"');
    });

    unmount();

    // Warm cache revisit (e.g. Undo / next visit): renders resolved iframe synchronously with zero loading placeholder
    const { container: revisitContainer } = render(
      <AnkiTemplateCardFace card={card} side="front" compact={false} />,
    );
    expect(screen.queryByTestId('anki-card-media-loading')).toBeNull();
    const revisitIframe = revisitContainer.querySelector('iframe');
    expect(revisitIframe).not.toBeNull();
    expect(revisitIframe!.getAttribute('srcdoc')).toContain(`src="${DATA_URL}"`);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('does not leak front inline images onto a plain-text back face', async () => {
    vi.mocked(invoke).mockResolvedValue(DATA_URL);
    const card = apkgImageCard();

    const { container } = render(
      <AnkiTemplateCardFace card={card} side="back" compact={false} />,
    );

    await waitFor(() => {
      expect(screen.getByText('Plain text answer explaining the protein kinetics.')).toBeTruthy();
    });
    // Image is referenced inline on the front face, so it must NOT leak into back attachments
    expect(container.querySelector('[data-anki-zoom-trigger="true"]')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
  });

  it('applies lg:h-auto on attachment zoom trigger DsButton so desktop 32px button height does not clip images', async () => {
    vi.mocked(invoke).mockResolvedValue(DATA_URL);
    const card = apkgImageCard({
      front: 'Plain front question',
      back: 'Plain back answer',
      images: ['/data/anki_media/standalone_attachment.png'],
    });

    const { container } = render(
      <AnkiTemplateCardFace card={card} side="back" compact={false} />,
    );

    await waitFor(() => {
      const trigger = container.querySelector('[data-anki-zoom-trigger="true"]');
      expect(trigger).not.toBeNull();
      expect(trigger!.className).toContain('h-auto');
      expect(trigger!.className).toContain('lg:h-auto');
      expect(trigger!.className).toContain('!h-auto');
    });
  });
});
