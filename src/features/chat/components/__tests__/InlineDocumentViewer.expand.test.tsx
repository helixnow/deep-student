import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InlineDocumentViewer } from '../InlineDocumentViewer';

vi.mock('@/utils/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/platform')>()),
  isMobilePlatform: vi.fn(() => false),
}));

const props = {
  isOpen: true,
  title: 'notes.txt',
  fileName: 'notes.txt',
  textContent: 'line one\nline two',
  onClose: vi.fn(),
};

const expandButton = () => screen.getByTestId('inline-document-viewer-expand');

describe('RF-W09-inline-viewer-in-app-expand: InlineDocumentViewer expanded preview', () => {
  const openSpy = vi.fn(() => null);
  const createUrlSpy = vi.fn(() => 'blob:mock');

  beforeEach(() => {
    props.onClose.mockReset();
    openSpy.mockClear();
    createUrlSpy.mockClear();
    vi.stubGlobal('open', openSpy);
    Object.defineProperty(URL, 'createObjectURL', { value: createUrlSpy, configurable: true, writable: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(URL, 'createObjectURL');
  });

  it('expands in-app instead of opening a blob URL in a new window', () => {
    const { container } = render(<InlineDocumentViewer {...props} />);
    const inline = screen.getByTestId('inline-document-viewer');
    expect(container.contains(inline)).toBe(true);
    expect(inline).not.toHaveAttribute('data-expanded');

    fireEvent.click(expandButton());

    expect(openSpy).not.toHaveBeenCalled();
    expect(createUrlSpy).not.toHaveBeenCalled();
    const expanded = screen.getByTestId('inline-document-viewer');
    expect(expanded).toHaveAttribute('data-expanded', 'true');
    expect(expanded).toHaveClass('fixed');
    expect(container.contains(expanded)).toBe(false);
    expect(document.body.contains(expanded)).toBe(true);
    expect(expanded).toHaveTextContent('line two');
  });

  it('toggles back to the inline panel', () => {
    const { container } = render(<InlineDocumentViewer {...props} />);
    fireEvent.click(expandButton());
    fireEvent.click(expandButton());

    const inline = screen.getByTestId('inline-document-viewer');
    expect(inline).not.toHaveAttribute('data-expanded');
    expect(container.contains(inline)).toBe(true);
  });

  it('Escape collapses the expanded view first, then closes', () => {
    render(<InlineDocumentViewer {...props} />);
    fireEvent.click(expandButton());

    fireEvent.keyDown(screen.getByTestId('inline-document-viewer'), { key: 'Escape' });
    expect(props.onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('inline-document-viewer')).not.toHaveAttribute('data-expanded');

    fireEvent.keyDown(screen.getByTestId('inline-document-viewer'), { key: 'Escape' });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('offers the expanded preview on mobile too (no WebView navigation involved)', async () => {
    const platform = await import('@/utils/platform');
    vi.mocked(platform.isMobilePlatform).mockReturnValue(true);
    try {
      render(<InlineDocumentViewer {...props} />);
      fireEvent.click(expandButton());
      expect(screen.getByTestId('inline-document-viewer')).toHaveAttribute('data-expanded', 'true');
      expect(openSpy).not.toHaveBeenCalled();
    } finally {
      vi.mocked(platform.isMobilePlatform).mockReturnValue(false);
    }
  });
});
