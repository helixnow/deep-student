import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import i18next from 'i18next';
import zhNotes from '@/locales/zh-CN/notes.json';
import enNotes from '@/locales/en-US/notes.json';

vi.mock('../features/imageUpload', () => ({
  createImageBlockConfig: () => ({}),
  createImageUploader: () => vi.fn(),
  createTransientBlobUrlRegistry: () => ({ register: vi.fn(), releaseAll: vi.fn() }),
  pickImageWithTauriDialog: vi.fn(),
  validateImageFile: vi.fn(),
}));
vi.mock('../features/mermaidPreview', () => ({ createMermaidObserver: vi.fn() }));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));
vi.mock('@/shared/debug/channels/crepeEditor', () => ({ emitCrepeDebug: vi.fn(), captureDOMSnapshot: vi.fn() }));
vi.mock('@/shared/debug/channels/crepeImageUpload', () => ({
  emitImageUploadDebug: vi.fn(),
  captureDOMInfo: vi.fn(),
  captureImageBlockSnapshot: vi.fn(),
}));
vi.mock('@/debug-panel/events/NotesOutlineDebugChannel', () => ({
  emitOutlineDebugLog: vi.fn(),
  emitOutlineDebugSnapshot: vi.fn(),
}));
vi.mock('@/debug-panel/debugMasterSwitch', () => ({
  debugMasterSwitch: { isEnabled: () => false },
  debugLog: { log: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { CrepeEditor } from '../CrepeEditor';

beforeAll(async () => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  Element.prototype.scrollIntoView = vi.fn();
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(640);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(360);

  if (!i18next.isInitialized) {
    await i18next.init({
      lng: 'zh-CN',
      resources: {
        'zh-CN': { notes: zhNotes },
        'en-US': { notes: enNotes },
      },
      interpolation: { escapeValue: false },
    });
  } else {
    i18next.addResourceBundle('zh-CN', 'notes', zhNotes, true, true);
    i18next.addResourceBundle('en-US', 'notes', enNotes, true, true);
    await i18next.changeLanguage('zh-CN');
  }
});

afterEach(async () => {
  cleanup();
  await i18next.changeLanguage('zh-CN');
});

describe('CrepeEditor accessibility attributes', () => {
  it('exposes role="textbox", aria-multiline, localized aria-label, and tabindex="0" on .ProseMirror and toggles aria-readonly', async () => {
    const onReady = vi.fn();
    const { container, rerender } = render(
      <CrepeEditor
        noteId="a11y-1"
        initialValue="Hello body"
        readonly={false}
        onReady={onReady}
      />,
    );

    await waitFor(() => expect(onReady).toHaveBeenCalled(), { timeout: 5000 });

    const textbox = screen.getByRole('textbox', { name: zhNotes.editor.body_aria_label });
    expect(textbox).toHaveClass('ProseMirror');
    expect(textbox).toHaveAttribute('role', 'textbox');
    expect(textbox).toHaveAttribute('aria-multiline', 'true');
    expect(textbox).toHaveAttribute('aria-label', zhNotes.editor.body_aria_label);
    expect(textbox).toHaveAttribute('tabindex', '0');
    expect(textbox).not.toHaveAttribute('aria-readonly');

    const api = onReady.mock.calls[0][0];
    act(() => {
      api.setMarkdown('Updated markdown');
    });
    expect(container.querySelector('.ProseMirror')).toHaveAttribute('role', 'textbox');
    expect(container.querySelector('.ProseMirror')).toHaveAttribute('aria-label', zhNotes.editor.body_aria_label);
    expect(container.querySelector('.ProseMirror')).toHaveAttribute('tabindex', '0');

    rerender(
      <CrepeEditor
        noteId="a11y-1"
        initialValue="Hello body"
        readonly={true}
        onReady={onReady}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector('.ProseMirror')).toHaveAttribute('aria-readonly', 'true');
    });

    rerender(
      <CrepeEditor
        noteId="a11y-1"
        initialValue="Hello body"
        readonly={false}
        onReady={onReady}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector('.ProseMirror')).not.toHaveAttribute('aria-readonly');
    });
  });

  it('uses localized English aria-label ("Note body") when i18next is en-US', async () => {
    await i18next.changeLanguage('en-US');
    const onReady = vi.fn();

    render(
      <CrepeEditor
        noteId="a11y-en"
        initialValue="English body"
        readonly={false}
        onReady={onReady}
      />,
    );

    await waitFor(() => expect(onReady).toHaveBeenCalled(), { timeout: 5000 });
    const textbox = screen.getByRole('textbox', { name: enNotes.editor.body_aria_label });
    expect(textbox).toHaveClass('ProseMirror');
    expect(textbox).toHaveAttribute('aria-multiline', 'true');
  });
});
