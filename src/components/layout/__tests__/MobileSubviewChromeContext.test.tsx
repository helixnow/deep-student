import React, { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FolderPickerDialog } from '@/features/learning-hub/components/finder/FolderPickerDialog';
import { MobileSubviewChromeProvider, useMobileSubviewChromeHost } from '../MobileSubviewChromeContext';

vi.mock('@/dstu', () => ({
  folderApi: { getFolderTree: async () => ({ ok: true, value: [] }) },
}));

afterEach(cleanup);

describe('mobile Finder subview chrome', () => {
  it('does not publish from a closed picker on mount, tab changes or unmount', () => {
    const setSubviewChrome = vi.fn();
    const value = { setSubviewChrome };
    const picker = (tab: string) => (
      <MobileSubviewChromeProvider value={value}>
        <FolderPickerDialog open={false} inline onOpenChange={() => tab} onConfirm={() => {}} />
        <div>{tab}</div>
      </MobileSubviewChromeProvider>
    );
    const view = render(picker('Markdown'));
    view.rerender(picker('Missing PDF'));
    expect(screen.getByText('Missing PDF')).toBeTruthy();
    view.unmount();
    expect(setSubviewChrome).not.toHaveBeenCalled();
  });

  it('takes over the host header and restores it using the latest back callback', async () => {
    const closedFor = vi.fn();
    const Hub = ({ tab, title }: { tab: string; title: string }) => {
      const { activeSubviewChrome, subviewChromeHost } = useMobileSubviewChromeHost();
      const [open, setOpen] = useState(false);
      return (
        <MobileSubviewChromeProvider value={subviewChromeHost}>
          <h1>{activeSubviewChrome?.title ?? tab}</h1>
          <button onClick={() => setOpen(true)}>Move selection</button>
          {activeSubviewChrome && <button onClick={activeSubviewChrome.onBack}>Go back</button>}
          <FolderPickerDialog
            inline
            open={open}
            title={title}
            onOpenChange={(next) => {
              setOpen(next);
              if (!next) closedFor(tab);
            }}
            onConfirm={() => {}}
          />
        </MobileSubviewChromeProvider>
      );
    };
    const view = render(<Hub tab="Markdown" title="Move to folder" />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Move selection' })));
    expect(screen.getByRole('heading').textContent).toBe('Move to folder');

    view.rerender(<Hub tab="Missing PDF" title="Choose a folder" />);
    expect(screen.getByRole('heading').textContent).toBe('Choose a folder');
    fireEvent.click(screen.getByRole('button', { name: 'Go back' }));
    expect(closedFor).toHaveBeenCalledExactlyOnceWith('Missing PDF');
    expect(screen.getByRole('heading').textContent).toBe('Missing PDF');
  });
});
