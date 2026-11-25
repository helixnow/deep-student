import React, { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OverlayCoordinatorProvider,
  useOverlayCoordinator,
} from '../OverlayCoordinator';
import { DsDialog } from '@/components/ui/DsDialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/shad/Popover';
import { AppMenu, AppMenuContent, AppMenuItem, AppMenuTrigger } from '@/components/ui/app-menu/AppMenu';
import { AppSelect } from '@/components/ui/app-menu/AppSelect';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/shad/Tooltip';

vi.mock('@/hooks/useBreakpoint', () => ({ useIsMobile: () => false }));
vi.mock('@/hooks/useKeyboardHeight', () => ({
  useKeyboardHeight: () => 0,
  getLayoutViewportObscuredHeight: () => 0,
}));

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockImplementation(function (this: HTMLElement) {
    return this.parentElement;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OverlayCoordinator Escape layering stack', () => {
  it('tracks LIFO escape layers without triggering re-renders and integrates with registerInteractiveOverlay', () => {
    let renderCount = 0;
    let api!: ReturnType<typeof useOverlayCoordinator>;

    function Probe() {
      renderCount += 1;
      api = useOverlayCoordinator();
      return null;
    }

    render(
      <OverlayCoordinatorProvider>
        <Probe />
      </OverlayCoordinatorProvider>,
    );

    const rendersAfterMount = renderCount;
    const dialogA = Symbol('dialog-a');
    const dialogB = Symbol('dialog-b');

    const releaseA = api.registerEscapeLayer({ id: dialogA, kind: 'dialog' });
    expect(renderCount).toBe(rendersAfterMount);
    expect(api.getTopEscapeLayerId()).toBe(dialogA);
    expect(api.hasEscapeLayerAbove(dialogA)).toBe(false);

    const releaseB = api.registerEscapeLayer({ id: dialogB, kind: 'dialog' });
    expect(renderCount).toBe(rendersAfterMount);
    expect(api.getTopEscapeLayerId()).toBe(dialogB);
    expect(api.hasEscapeLayerAbove(dialogA)).toBe(true);
    expect(api.hasEscapeLayerAbove(dialogB)).toBe(false);

    // registerInteractiveOverlay pushes on top of dialogB
    let releaseInteractive!: () => void;
    act(() => {
      releaseInteractive = api.registerInteractiveOverlay();
    });
    expect(api.hasEscapeLayerAbove(dialogB)).toBe(true);
    expect(api.getTopEscapeLayerId()).not.toBe(dialogB);

    // Releasing interactive overlay makes dialogB top again (idempotent)
    act(() => {
      releaseInteractive();
      releaseInteractive();
    });
    expect(api.hasEscapeLayerAbove(dialogB)).toBe(false);
    expect(api.getTopEscapeLayerId()).toBe(dialogB);

    releaseB();
    releaseB();
    expect(api.hasEscapeLayerAbove(dialogA)).toBe(false);
    expect(api.getTopEscapeLayerId()).toBe(dialogA);

    releaseA();
    expect(api.getTopEscapeLayerId()).toBeNull();
  });

  it('closes ONLY inner Popover on first Escape, then closes DsDialog and restores focus on second Escape', async () => {
    function Harness() {
      const [dialogOpen, setDialogOpen] = useState(false);
      const [popoverOpen, setPopoverOpen] = useState(false);
      return (
        <OverlayCoordinatorProvider>
          <button type="button" onClick={() => setDialogOpen(true)}>
            Open Dialog
          </button>
          <DsDialog open={dialogOpen} onOpenChange={setDialogOpen} showClose={false}>
            <button type="button">Dialog Action</button>
            <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
              <PopoverTrigger asChild>
                <button type="button">Open Popover</button>
              </PopoverTrigger>
              <PopoverContent>
                <div>Inner Popover Body</div>
              </PopoverContent>
            </Popover>
          </DsDialog>
        </OverlayCoordinatorProvider>
      );
    }

    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Open Dialog' });
    act(() => opener.focus());
    fireEvent.click(opener);

    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();

    const popoverTrigger = screen.getByRole('button', { name: 'Open Popover' });
    fireEvent.click(popoverTrigger);
    expect(screen.getByText('Inner Popover Body')).toBeInTheDocument();

    // Dispatch Escape from the outer dialog button (NOT inside PopoverContent)
    const dialogAction = screen.getByRole('button', { name: 'Dialog Action' });
    act(() => dialogAction.focus());
    fireEvent.keyDown(dialogAction, { key: 'Escape' });

    // First Escape closes ONLY the inner Popover; DsDialog remains open!
    expect(screen.getByRole('dialog', { hidden: false })).toBeInTheDocument();
    expect(dialog).toBeInTheDocument();
    await waitFor(() => {
      const popoverEl = screen.queryByText('Inner Popover Body')?.closest('[data-state]');
      expect(!popoverEl || popoverEl.getAttribute('data-state') === 'closed').toBe(true);
    });

    // Second Escape closes DsDialog and restores focus to opener!
    fireEvent.keyDown(dialogAction, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Dialog Action' })).not.toBeInTheDocument();
    });
    expect(opener).toHaveFocus();
  });

  it('closes ONLY inner AppMenu / AppSelect on first Escape, then closes DsDialog and restores focus on second Escape', async () => {
    function Harness() {
      const [dialogOpen, setDialogOpen] = useState(false);
      const [selected, setSelected] = useState('opt1');
      return (
        <OverlayCoordinatorProvider>
          <button type="button" onClick={() => setDialogOpen(true)}>
            Launch Settings
          </button>
          <DsDialog open={dialogOpen} onOpenChange={setDialogOpen} showClose={false}>
            <AppSelect
              ariaLabel="Pick Mode"
              value={selected}
              onValueChange={setSelected}
              options={[
                { value: 'opt1', label: 'Mode Alpha' },
                { value: 'opt2', label: 'Mode Beta' },
              ]}
            />
            <AppMenu>
              <AppMenuTrigger asChild>
                <button type="button">More Menu</button>
              </AppMenuTrigger>
              <AppMenuContent>
                <AppMenuItem onClick={() => {}}>Menu Item A</AppMenuItem>
              </AppMenuContent>
            </AppMenu>
          </DsDialog>
        </OverlayCoordinatorProvider>
      );
    }

    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Launch Settings' });
    act(() => opener.focus());
    fireEvent.click(opener);
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    // Open AppSelect inside DsDialog
    const selectTrigger = screen.getByRole('button', { name: 'Pick Mode' });
    fireEvent.click(selectTrigger);
    expect(screen.getByRole('menu')).toHaveAttribute('data-state', 'open');

    // Escape #1 with focus on trigger (not inside menu content) closes ONLY AppSelect
    fireEvent.keyDown(selectTrigger, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(document.querySelector('[role="menu"][data-state="open"]')).toBeNull();

    // Open AppMenu inside DsDialog
    const moreBtn = screen.getByRole('button', { name: 'More Menu' });
    fireEvent.click(moreBtn);
    expect(document.querySelector('[role="menu"][data-state="open"]')).not.toBeNull();

    // Escape #2 closes ONLY AppMenu
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(document.querySelector('[role="menu"][data-state="open"]')).toBeNull();

    // Escape #3 closes DsDialog and restores focus to opener
    fireEvent.keyDown(moreBtn, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(opener).toHaveFocus();
  });

  it('dismisses ONLY an inner Tooltip on first Escape, then closes DsDialog on second Escape', async () => {
    function Harness() {
      const [dialogOpen, setDialogOpen] = useState(false);
      return (
        <OverlayCoordinatorProvider>
          <button type="button" onClick={() => setDialogOpen(true)}>
            Open With Tooltip
          </button>
          <DsDialog open={dialogOpen} onOpenChange={setDialogOpen} showClose={false}>
            <Tooltip delayDuration={0}>
              <TooltipTrigger asChild>
                <button type="button">Hover Info</button>
              </TooltipTrigger>
              <TooltipContent>Detailed tooltip text</TooltipContent>
            </Tooltip>
          </DsDialog>
        </OverlayCoordinatorProvider>
      );
    }

    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Open With Tooltip' });
    act(() => opener.focus());
    fireEvent.click(opener);

    const infoBtn = screen.getByRole('button', { name: 'Hover Info' });
    fireEvent.mouseEnter(infoBtn);
    expect(screen.getByRole('tooltip')).toHaveAttribute('data-state', 'open');

    // Escape #1 dismisses ONLY Tooltip; DsDialog stays open
    fireEvent.keyDown(infoBtn, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(document.querySelector('[role="tooltip"][data-state="open"]')).toBeNull();

    // Escape #2 closes DsDialog and restores focus
    fireEvent.keyDown(infoBtn, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(opener).toHaveFocus();
  });

  it('defers Escape to inner Radix popper / listbox / OverlayCoordinator layer, while still closing over static listboxes', async () => {
    function Harness() {
      const [dialogOpen, setDialogOpen] = useState(false);
      const [radixOpen, setRadixOpen] = useState(false);
      const [customOverlayOpen, setCustomOverlayOpen] = useState(false);
      const { registerInteractiveOverlay } = useOverlayCoordinator();

      React.useEffect(() => {
        if (!radixOpen) return;
        const onCaptureEsc = (event: KeyboardEvent) => {
          if (event.key === 'Escape') {
            // Mirrors @radix-ui/react-use-escape-keydown: capture phase, does not call preventDefault
            setRadixOpen(false);
          }
        };
        document.addEventListener('keydown', onCaptureEsc, { capture: true });
        return () => document.removeEventListener('keydown', onCaptureEsc, { capture: true });
      }, [radixOpen]);

      React.useEffect(() => {
        if (!customOverlayOpen) return;
        const release = registerInteractiveOverlay();
        const onEsc = (event: KeyboardEvent) => {
          if (event.key === 'Escape') setCustomOverlayOpen(false);
        };
        document.addEventListener('keydown', onEsc);
        return () => {
          release();
          document.removeEventListener('keydown', onEsc);
        };
      }, [customOverlayOpen, registerInteractiveOverlay]);

      return (
        <>
          {/* Background Finder-style static listbox outside dialog must NOT block Escape */}
          <div role="listbox" aria-label="Background files">
            <div role="option" aria-selected="false">Background Item</div>
          </div>
          <button type="button" onClick={() => setDialogOpen(true)}>
            Open Complex Dialog
          </button>
          <DsDialog open={dialogOpen} onOpenChange={setDialogOpen} showClose={false}>
            {/* Static inline listbox inside dialog (like FinderMoveFolderDialog) must NOT block Escape */}
            <div role="listbox" aria-label="Static folder list">
              <div role="option" aria-selected="false">Root</div>
            </div>
            <button type="button" onClick={() => setRadixOpen(true)}>
              Open Radix Select
            </button>
            <button type="button" onClick={() => setCustomOverlayOpen(true)}>
              Open Coordinator Overlay
            </button>
          </DsDialog>
          {radixOpen && (
            <div data-radix-popper-content-wrapper="">
              <div role="listbox" data-state="open">
                <div role="option" aria-selected="true">Radix Option</div>
              </div>
            </div>
          )}
        </>
      );
    }

    render(
      <OverlayCoordinatorProvider>
        <Harness />
      </OverlayCoordinatorProvider>,
    );

    const opener = screen.getByRole('button', { name: 'Open Complex Dialog' });
    act(() => opener.focus());
    fireEvent.click(opener);
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    // 1. Open Radix popper -> Escape closes ONLY Radix popper
    fireEvent.click(screen.getByRole('button', { name: 'Open Radix Select' }));
    expect(document.querySelector('[data-radix-popper-content-wrapper]')).not.toBeNull();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(document.querySelector('[data-radix-popper-content-wrapper]')).toBeNull();

    // 2. Open OverlayCoordinator-registered layer (no DOM menu role) -> Escape closes ONLY that layer
    fireEvent.click(screen.getByRole('button', { name: 'Open Coordinator Overlay' }));
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    // 3. Now only static listboxes remain -> single Escape closes DsDialog and restores focus!
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(opener).toHaveFocus();
  });

  it('closes foreground DsDialog first when opened from an already-open background Popover', async () => {
    function Harness() {
      const [popoverOpen, setPopoverOpen] = useState(false);
      const [dialogOpen, setDialogOpen] = useState(false);
      return (
        <OverlayCoordinatorProvider>
          <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
            <PopoverTrigger asChild>
              <button type="button">Open Background Popover</button>
            </PopoverTrigger>
            <PopoverContent>
              <button type="button" onClick={() => setDialogOpen(true)}>
                Open Modal From Popover
              </button>
            </PopoverContent>
          </Popover>
          <DsDialog open={dialogOpen} onOpenChange={setDialogOpen} showClose={false}>
            <button type="button">Inside Modal</button>
          </DsDialog>
        </OverlayCoordinatorProvider>
      );
    }

    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Background Popover' }));
    const openModalBtn = screen.getByRole('button', { name: 'Open Modal From Popover' });
    act(() => openModalBtn.focus());
    fireEvent.click(openModalBtn);
    expect(screen.getByRole('button', { name: 'Inside Modal' })).toBeInTheDocument();

    // Escape #1 must close foreground DsDialog (top of stack), NOT get blocked by background Popover
    fireEvent.keyDown(screen.getByRole('button', { name: 'Inside Modal' }), { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Inside Modal' })).not.toBeInTheDocument();
    });
    // Background popover is still open and trigger inside it got focus back
    expect(openModalBtn).toBeInTheDocument();
    expect(openModalBtn).toHaveFocus();
  });
});
