import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import {
  InputBarUI,
  MOBILE_DOCK_CLEARANCE_CSS_EXPR,
  MOBILE_DOCK_REVEALED_FALLBACK_PX,
  readMobileDockClearanceSnapshot,
} from '../InputBarUI';
import { createDefaultPanelStates } from '../../../core/types/common';

const { keyboardInsetState } = vi.hoisted(() => ({
  keyboardInsetState: { value: 0 },
}));

vi.mock('@/hooks/usePdfProcessingProgress', () => ({
  usePdfProcessingProgress: vi.fn(),
}));

vi.mock('@/hooks/useTauriDragAndDrop', () => ({
  useTauriDragAndDrop: () => ({
    isDragging: false,
    dropZoneProps: {},
  }),
}));

vi.mock('@/hooks/useKeyboardHeight', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useKeyboardHeight')>();
  return {
    ...actual,
    useKeyboardInset: () => keyboardInsetState.value,
  };
});

vi.mock('@/components/layout/MobileLayoutContext', () => ({
  useMobileLayoutSafe: () => ({
    isMobile: true,
    isFullscreenContent: false,
  }),
}));

function renderMobileInputBar(overrides: Partial<React.ComponentProps<typeof InputBarUI>> = {}) {
  const props: React.ComponentProps<typeof InputBarUI> = {
    inputValue: '',
    canSend: true,
    canAbort: false,
    isStreaming: false,
    attachments: [],
    panelStates: createDefaultPanelStates(),
    onInputChange: vi.fn(),
    onSend: vi.fn(),
    onAbort: vi.fn(),
    onAddAttachment: vi.fn(),
    onUpdateAttachment: vi.fn(),
    onRemoveAttachment: vi.fn(),
    onClearAttachments: vi.fn(),
    onSetPanelState: vi.fn(),
    onToggleThinking: vi.fn(),
    enableThinking: true,
    thinkingStateLabel: '推理：最高',
    placeholder: '输入消息',
    ...overrides,
  };
  return render(<InputBarUI {...props} />);
}

function resetDocumentDockState() {
  document.documentElement.removeAttribute('data-wb-dock-revealed');
  document.documentElement.style.removeProperty('--wb-mobile-dock-clearance');
  document.documentElement.style.removeProperty('--mobile-dock-height');
  document.documentElement.style.removeProperty('--wb-dock-clearance');
}

describe('InputBarUI 360px mobile bottom Dock clearance contract (S4-17)', () => {
  beforeEach(() => {
    cleanup();
    keyboardInsetState.value = 0;
    resetDocumentDockState();
  });

  afterEach(() => {
    cleanup();
    resetDocumentDockState();
  });

  it('reserves zero extra dock clearance when collapsed, immediately adds clearance when mobile Dock is revealed, and resets on collapse', async () => {
    renderMobileInputBar();

    const root = screen.getByTestId('input-bar-v2-root');
    // Control row buttons (+ / reasoning / send) are rendered inside the composer
    expect(screen.getByTestId('thinking-runtime-control')).toBeInTheDocument();
    expect(screen.getByTestId('btn-send')).toBeInTheDocument();

    // Collapsed dock state: 0px clearance, no wasted bottom band
    expect(root.getAttribute('data-mobile-dock-clearance')).toBe('0px');
    expect(root.hasAttribute('data-mobile-dock-cleared')).toBe(false);
    expect(root.style.getPropertyValue('--chat-mobile-dock-clearance')).toBe('0px');
    expect(root.style.paddingBottom).toContain('--wb-mobile-dock-clearance');
    expect(root.style.paddingBottom).toContain('--mobile-dock-height');
    const collapsedDockedHeight = Number.parseFloat(
      root.style.getPropertyValue('--unified-input-docked-height'),
    );

    // Summoning mobile Dock writes data-wb-dock-revealed="true" + --wb-mobile-dock-clearance: 76px (Dock.tsx contract)
    await act(async () => {
      document.documentElement.setAttribute('data-wb-dock-revealed', 'true');
      document.documentElement.style.setProperty('--wb-mobile-dock-clearance', '76px');
      await Promise.resolve();
    });

    expect(root.getAttribute('data-mobile-dock-clearance')).toBe('76px');
    expect(root.getAttribute('data-mobile-dock-cleared')).toBe('true');
    expect(root.style.getPropertyValue('--chat-mobile-dock-clearance')).toBe('76px');
    expect(root.style.paddingBottom).toContain('76px');
    const revealedDockedHeight = Number.parseFloat(
      root.style.getPropertyValue('--unified-input-docked-height'),
    );
    expect(revealedDockedHeight - collapsedDockedHeight).toBe(76);

    // Dismissing mobile Dock clears bottom offset back to 0px immediately
    await act(async () => {
      document.documentElement.removeAttribute('data-wb-dock-revealed');
      document.documentElement.style.setProperty('--wb-mobile-dock-clearance', '0px');
      await Promise.resolve();
    });

    expect(root.getAttribute('data-mobile-dock-clearance')).toBe('0px');
    expect(root.hasAttribute('data-mobile-dock-cleared')).toBe(false);
    expect(root.style.getPropertyValue('--chat-mobile-dock-clearance')).toBe('0px');
  });

  it('falls back to default 76px clearance when data-wb-dock-revealed="true" is set without CSS var, and honors --mobile-dock-height', async () => {
    document.documentElement.setAttribute('data-wb-dock-revealed', 'true');
    expect(readMobileDockClearanceSnapshot()).toEqual({
      revealed: true,
      clearancePx: MOBILE_DOCK_REVEALED_FALLBACK_PX,
    });

    renderMobileInputBar();
    const root = screen.getByTestId('input-bar-v2-root');
    expect(root.getAttribute('data-mobile-dock-clearance')).toBe(
      `${MOBILE_DOCK_REVEALED_FALLBACK_PX}px`,
    );
    expect(root.getAttribute('data-mobile-dock-cleared')).toBe('true');

    // Alternate --mobile-dock-height custom property works even when --wb-mobile-dock-clearance is 0px
    await act(async () => {
      document.documentElement.removeAttribute('data-wb-dock-revealed');
      document.documentElement.style.setProperty('--wb-mobile-dock-clearance', '0px');
      document.documentElement.style.setProperty('--mobile-dock-height', '68px');
      await Promise.resolve();
    });

    expect(root.getAttribute('data-mobile-dock-clearance')).toBe('68px');
    expect(root.getAttribute('data-mobile-dock-cleared')).toBe('true');
    expect(root.style.paddingBottom).toContain('68px');
  });

  it('wires chat-beautify.css <= 767.98px mobile rules to --wb-mobile-dock-clearance, --mobile-dock-height, and data-wb-dock-revealed', () => {
    expect(MOBILE_DOCK_CLEARANCE_CSS_EXPR).toContain('--wb-mobile-dock-clearance');
    expect(MOBILE_DOCK_CLEARANCE_CSS_EXPR).toContain('--mobile-dock-height');

    const cssPath = path.resolve(__dirname, '../../../styles/chat-beautify.css');
    const css = fs.readFileSync(cssPath, 'utf-8');

    expect(css).toContain('@media (width <= 767.98px)');
    expect(css).toContain('var(--wb-mobile-dock-clearance, 0px)');
    expect(css).toContain('var(--mobile-dock-height, 0px)');
    expect(css).toContain("[data-wb-dock-revealed='true'] .chat-v2 .unified-input-docked");
    expect(css).toContain('var(--wb-mobile-dock-clearance, 76px)');
  });
});
