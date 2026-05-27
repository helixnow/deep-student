import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/stores/viewStore', () => ({
  useViewStore: (selector: (state: { currentView: string }) => unknown) =>
    selector({ currentView: 'chat-v2' }),
}));

vi.mock('@/utils/fileManager', () => ({
  fileManager: {
    saveBinaryFile: vi.fn(),
  },
}));

vi.mock('@/utils/urlOpener', () => ({
  openUrl: vi.fn(),
}));

vi.mock('@/components/ui/NotionButton', () => ({
  NotionButton: ({
    children,
    className,
    iconOnly,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { iconOnly?: boolean }) => (
    <button className={className} data-icon-only={iconOnly ? 'true' : 'false'} {...props}>
      {children}
    </button>
  ),
}));

let InlineImageViewer: typeof import('@/features/chat/components/InlineImageViewer').InlineImageViewer;

describe('InlineImageViewer', () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ InlineImageViewer } = await import('@/features/chat/components/InlineImageViewer'));
  });

  afterEach(() => {
    cleanup();
    document.getElementById('image-viewer-root')?.remove();
  });

  it('shows only the next button on the first image and keeps actions in the bottom tray', async () => {
    render(
      <InlineImageViewer
        images={['/a.png', '/b.png']}
        currentIndex={0}
        isOpen
        onClose={vi.fn()}
        onNext={vi.fn()}
        onPrev={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'common:imageViewer.next' })).toBeInTheDocument();
    });

    expect(screen.queryByRole('button', { name: 'common:imageViewer.prev' })).not.toBeInTheDocument();
    expect(screen.queryByText('1 / 2')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'common:imageViewer.zoomOut' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'common:imageViewer.zoomIn' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'common:imageViewer.rotate' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'common:imageViewer.reset' })).toBeInTheDocument();
  });

  it('shows only the previous button on the last image', async () => {
    render(
      <InlineImageViewer
        images={['/a.png', '/b.png']}
        currentIndex={1}
        isOpen
        onClose={vi.fn()}
        onNext={vi.fn()}
        onPrev={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'common:imageViewer.prev' })).toBeInTheDocument();
    });

    expect(screen.queryByRole('button', { name: 'common:imageViewer.next' })).not.toBeInTheDocument();
  });

  it('does not expose draggable cursor semantics on the image surface', async () => {
    render(
      <InlineImageViewer
        images={['/a.png', '/b.png']}
        currentIndex={0}
        isOpen
        onClose={vi.fn()}
        onNext={vi.fn()}
        onPrev={vi.fn()}
      />
    );

    const image = screen.getByRole('img', { name: 'chatV2:imageViewer.imageAlt' });

    expect(image.style.cursor).toBe('');
  });

  it('closes when clicking the blank overlay area', async () => {
    const onClose = vi.fn();

    const { container } = render(
      <InlineImageViewer
        images={['/a.png']}
        currentIndex={0}
        isOpen
        onClose={onClose}
      />
    );

    await waitFor(() => {
      expect(screen.getByRole('img', { name: 'chatV2:imageViewer.imageAlt' })).toBeInTheDocument();
    });

    const overlay = container.ownerDocument.getElementById('image-viewer-root')?.firstElementChild as HTMLElement | null;
    expect(overlay).toBeTruthy();

    if (!overlay) {
      throw new Error('overlay not found');
    }

    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes when clicking the blank stage area inside the viewer', async () => {
    const onClose = vi.fn();

    const { container } = render(
      <InlineImageViewer
        images={['/a.png']}
        currentIndex={0}
        isOpen
        onClose={onClose}
      />
    );

    await waitFor(() => {
      expect(screen.getByRole('img', { name: 'chatV2:imageViewer.imageAlt' })).toBeInTheDocument();
    });

    const stage = container.ownerDocument.querySelector('#image-viewer-root .flex-1') as HTMLElement | null;
    expect(stage).toBeTruthy();

    if (!stage) {
      throw new Error('stage not found');
    }

    fireEvent.click(stage);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
