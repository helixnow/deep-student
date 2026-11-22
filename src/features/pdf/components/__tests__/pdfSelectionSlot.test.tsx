import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { UiKernel } from '@/ui-kernel/kernel';
import { UiKernelProvider } from '@/ui-kernel/react';
import { defineUiPlugin } from '@/ui-sdk';
import { installOfficialUiPlugins } from '@/ui-plugins/official/install';
import { memoryRegistryAdapters } from '@/ui-plugins/testing/registries';

const selectionState = {
  selectedText: 'Feynman path integral',
  selectionRect: { top: 40, left: 60, width: 120, height: 20, bottom: 60 },
  isVisible: true,
  contextBefore: 'before text ',
  contextAfter: ' after text',
  clear: vi.fn(),
};

vi.mock('@/ui-kernel/bootstrap', () => ({
  getAppKernel: () => ({
    dnd: { emitAutoExcerpt: vi.fn(), startExcerptDrag: (_event: unknown, input: unknown) => input },
  }),
}));

vi.mock('@/stores/viewStore', () => ({
  useViewStore: (selector: (s: { currentView: string }) => unknown) => selector({ currentView: 'workbench' }),
}));

let mockMobile = false;
vi.mock('@/hooks/useMediaQuery', () => ({ useMediaQuery: () => mockMobile }));
vi.mock('@/features/chat/context/selectionRef', () => ({ selectionToChat: vi.fn() }));

vi.mock('@/shared/selection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/selection')>();
  return { ...actual, useTextSelection: () => selectionState };
});

vi.mock('@/shared/notes', async (importOriginal) => ({
  truncateNoteTitle: (await importOriginal<typeof import('@/shared/notes')>()).truncateNoteTitle,
  useSaveAsNoteFlow: () => ({
    start: vi.fn(),
    isSaving: false,
    pickerProps: { open: false, onOpenChange: () => {}, onConfirm: () => {}, title: 'Folder', inline: false },
  }),
  SaveAsNoteFolderPicker: () => null,
}));

vi.mock('@/features/chat/components/ExplainPopover', () => ({ ExplainPopover: () => null }));
vi.mock('@/features/chat/components/TranslationPopover', () => ({ TranslationPopover: () => null }));
vi.mock('@/features/chat/services/selectionCardGeneration', () => ({ generateCardsFromSelection: vi.fn() }));

import { PdfSelectionActions } from '../PdfSelectionActions';

describe('pdf.selectionToolbar slot in PdfSelectionActions', () => {
  let kernel: UiKernel;

  beforeEach(async () => {
    cleanup();
    mockMobile = false;
    kernel = new UiKernel(memoryRegistryAdapters());
    await installOfficialUiPlugins(kernel);
  });

  afterEach(async () => {
    cleanup();
    await kernel.dispose();
  });

  function renderPdfActions(isMobileLike = false) {
    const Host: React.FC = () => {
      const containerRef = React.useRef<HTMLDivElement>(null);
      const [mounted, setMounted] = React.useState(false);
      React.useEffect(() => setMounted(true), []);
      return (
        <div ref={containerRef} style={{ position: 'relative' }}>
          <div data-page-number="3" className="textLayer">
            <span data-testid="page-text">{selectionState.selectedText}</span>
          </div>
          {mounted && (
            <PdfSelectionActions
              containerRef={containerRef}
              enabled
              isMobileLike={isMobileLike}
              documentTitle="Quantum Notes"
              selectionSourceId="res-pdf-1"
            />
          )}
        </div>
      );
    };

    const view = render(
      <UiKernelProvider kernel={kernel}>
        <Host />
      </UiKernelProvider>,
    );

    const range = document.createRange();
    range.selectNodeContents(screen.getByTestId('page-text'));
    const domSelection = window.getSelection()!;
    domSelection.removeAllRanges();
    domSelection.addRange(range);
    return view;
  }

  it('filters by kinds, runs contributed callback with full context, hides touch text label when icon present, and reports errors', async () => {
    const runSpy = vi.fn();
    const epubSpy = vi.fn();
    const PdfIcon = ({ size }: { size?: number }) => <span data-testid="pdf-plugin-icon" data-size={size}>S</span>;

    const goodPlugin = defineUiPlugin({
      meta: { id: 'community.pdf-tools', version: '1.0.0' },
      apply(ctx) {
        ctx.ui.contribute('pdf.selectionToolbar', {
          id: 'summarize',
          value: {
            label: 'PDF Summarize',
            icon: PdfIcon,
            kinds: ['pdf', 'document'],
            run: runSpy,
          },
        });
        ctx.ui.contribute('pdf.selectionToolbar', {
          id: 'epub-only',
          value: {
            label: 'Epub Only',
            kinds: ['epub'],
            run: epubSpy,
          },
        });
        ctx.ui.contribute('pdf.selectionToolbar', {
          id: 'broken-run',
          value: {
            label: 'Broken Run',
            run: () => { throw new Error('boom pdf run'); },
          },
        });
      },
    });

    await act(async () => {
      await kernel.install(goodPlugin, { origin: 'community' });
    });

    renderPdfActions(false);

    const btn = await screen.findByRole('button', { name: 'PDF Summarize', hidden: true });
    expect(screen.queryByRole('button', { name: 'Epub Only', hidden: true })).toBeNull();
    expect(screen.getByTestId('pdf-plugin-icon')).toBeInTheDocument();

    fireEvent.click(btn);
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(runSpy).toHaveBeenCalledWith({
      text: 'Feynman path integral',
      contextBefore: 'before text ',
      contextAfter: ' after text',
      page: 3,
      resourceId: 'res-pdf-1',
      documentTitle: 'Quantum Notes',
      kind: 'pdf',
    });

    const brokenBtn = screen.getByRole('button', { name: 'Broken Run', hidden: true });
    fireEvent.click(brokenBtn);
    await waitFor(() => {
      expect(kernel.errors.list('community.pdf-tools').some(r => r.phase === 'report' && r.slot === 'pdf.selectionToolbar')).toBe(true);
    });

    // Touch mode keeps aria-label via SelectionToolbar ToolbarButton and hides visual text when icon exists
    cleanup();
    mockMobile = true;
    renderPdfActions(true);
    const touchBtn = await screen.findByRole('button', { name: 'PDF Summarize', hidden: true });
    expect(touchBtn).toHaveTextContent('S');
    expect(touchBtn).not.toHaveTextContent('PDF Summarize');
  });
});
