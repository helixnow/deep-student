import React, { useState } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DsAlertDialog, DsDialog } from '../DsDialog';

vi.mock('@/hooks/useBreakpoint', () => ({ useIsMobile: () => false }));
vi.mock('@/hooks/useKeyboardHeight', () => ({ useKeyboardHeight: () => 0, getLayoutViewportObscuredHeight: () => 0 }));

beforeEach(() => {
  // JSDOM has no layout; model visible controls for the real focus trap.
  vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockImplementation(function () { return this.parentElement; });
});
afterEach(() => vi.restoreAllMocks());

function Harness({ initiallyOpen = false, autoFocus = false }: { initiallyOpen?: boolean; autoFocus?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const [confirm, setConfirm] = useState(false);
  return <>
    <button onClick={() => setOpen(true)}>Open history</button>
    <DsDialog open={open} onOpenChange={setOpen} showClose={false}>
      <input aria-label="Version name" autoFocus={autoFocus} />
      <button onClick={() => setConfirm(true)}>Restore version</button>
      <DsAlertDialog open={confirm} onOpenChange={setConfirm} title="Restore?" cancelText="Cancel restore" confirmText="Confirm restore" />
    </DsDialog>
  </>;
}

describe('DsDialog keyboard layers', () => {
  it.each([{ isComposing: true }, { keyCode: 229 }])('does not consume IME Escape (%j)', (composition) => {
    render(<Harness initiallyOpen />);
    expect(fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape', ...composition })).toBe(true);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('consumes only the top dialog Escape before window focus-mode handling and restores each opener', async () => {
    let focusMode = true;
    const host = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented) focusMode = false; };
    window.addEventListener('keydown', host);
    try {
      render(<Harness autoFocus />);
      const opener = screen.getByRole('button', { name: 'Open history' });
      act(() => opener.focus());
      fireEvent.click(opener);
      expect(screen.getByRole('textbox')).toHaveFocus();
      const restore = screen.getByRole('button', { name: 'Restore version' });
      act(() => restore.focus());
      fireEvent.click(restore);
      const alert = screen.getByRole('alertdialog');
      expect(within(alert).getByRole('button', { name: 'Cancel restore' })).toHaveFocus();
      expect(fireEvent.keyDown(document.activeElement!, { key: 'Escape' })).toBe(false);
      await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(restore).toHaveFocus();
      expect(focusMode).toBe(true);
      expect(fireEvent.keyDown(restore, { key: 'Escape' })).toBe(false);
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(opener).toHaveFocus();
      expect(focusMode).toBe(true);
      fireEvent.keyDown(opener, { key: 'Escape' });
      expect(focusMode).toBe(false);
    } finally { window.removeEventListener('keydown', host); }
  });

  it('traps Tab even when mounted open, and honors an inner Escape consumer', () => {
    const onOpenChange = vi.fn();
    render(<DsDialog open onOpenChange={onOpenChange} showClose={false}>
      <input aria-label="First" onKeyDown={(event) => { if (event.key === 'Escape') event.preventDefault(); }} />
      <button>Last</button>
    </DsDialog>);
    const first = screen.getByRole('textbox');
    const last = screen.getByRole('button', { name: 'Last' });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: 'Escape' });
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
