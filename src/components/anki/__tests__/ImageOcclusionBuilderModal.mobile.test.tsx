import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/hooks/useBreakpoint', () => ({
  useBreakpoint: () => ({ isSmallScreen: true }),
}));
vi.mock('@/hooks/useMediaQuery', () => ({
  useMediaQuery: () => true,
}));
vi.mock('@/hooks/useEventRegistry', () => ({
  useEventRegistry: vi.fn(),
}));
vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));
vi.mock('@/components/ui/DsDialog', () => ({
  DsDialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => (
    open ? <div data-testid="mock-dialog">{children}</div> : null
  ),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
  }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

import { ImageOcclusionBuilderModal } from '../occlusion/ImageOcclusionBuilderModal';

describe('ImageOcclusionBuilderModal mobile touch usability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses iOS-safe text-base inputs, enlarged touch corner handles, and explicit delete button', () => {
    render(
      <ImageOcclusionBuilderModal
        open
        onOpenChange={vi.fn()}
        initialDetail={{
          imageDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
          naturalWidth: 400,
          naturalHeight: 300,
          defaultDeckName: '解剖学',
        }}
      />,
    );

    const deckInput = screen.getByTestId('occlusion-deck-input');
    const extraInput = screen.getByTestId('occlusion-extra-note-input');
    expect(deckInput.className).toContain('text-base');
    expect(extraInput.className).toContain('text-base');

    const stage = screen.getByTestId('occlusion-svg-stage');
    vi.spyOn(stage, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 350,
      height: 260,
      right: 350,
      bottom: 260,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    // Draw one occlusion box on stage (jsdom lacks PointerEvent, so use MouseEvent with pointerId)
    const dispatchPointer = (type: string, clientX: number, clientY: number) => {
      const evt = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX, clientY });
      Object.defineProperty(evt, 'pointerId', { value: 1 });
      fireEvent(stage, evt);
    };
    dispatchPointer('pointerdown', 50, 40);
    dispatchPointer('pointermove', 180, 140);
    dispatchPointer('pointerup', 180, 140);

    expect(screen.getByTestId('occlusion-draft-box-1')).toBeInTheDocument();

    // Enlarged hit targets for all 4 corner handles on coarse/narrow screen
    for (const corner of ['nw', 'ne', 'sw', 'se'] as const) {
      const handle = screen.getByTestId(`occlusion-resize-${corner}`);
      expect(Number(handle.getAttribute('width'))).toBeGreaterThanOrEqual(100);
      expect(Number(handle.getAttribute('height'))).toBeGreaterThanOrEqual(100);
    }

    const labelInput = screen.getByTestId('occlusion-box-label-input');
    expect(labelInput.className).toContain('text-base');

    // Explicit toolbar delete button removes selected box without right-click
    const toolbarDelete = screen.getByTestId('occlusion-toolbar-delete-box-btn');
    expect(toolbarDelete).toBeEnabled();
    fireEvent.click(toolbarDelete);
    expect(screen.queryByTestId('occlusion-draft-box-1')).not.toBeInTheDocument();
  });
});
