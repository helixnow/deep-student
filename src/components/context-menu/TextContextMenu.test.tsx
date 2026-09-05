import * as React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { TextContextMenuProvider } from './TextContextMenu';

vi.mock('@/utils/clipboardUtils', () => ({
  copyTextToClipboard: vi.fn().mockResolvedValue(true),
  readTextFromClipboard: vi.fn().mockResolvedValue('pasted-provider'),
}));

function ControlledField({ initialValue = '' }: { initialValue?: string }) {
  const [value, setValue] = React.useState(initialValue);

  return (
    <>
      <input aria-label="Provider name" value={value} onChange={(event) => setValue(event.target.value)} />
      <output data-testid="controlled-value">{value}</output>
    </>
  );
}

describe('TextContextMenu', () => {
  it('updates React state immediately after pasting into a controlled input', async () => {
    render(
      <TextContextMenuProvider>
        <ControlledField />
      </TextContextMenuProvider>,
    );

    const input = screen.getByLabelText('Provider name');
    fireEvent.contextMenu(input, { clientX: 20, clientY: 20 });

    const pasteItem = await screen.findByRole('menuitem', { name: /粘贴/ });
    await waitFor(() => expect(pasteItem).toBeEnabled());
    fireEvent.click(pasteItem);

    await waitFor(() => {
      expect(input).toHaveValue('pasted-provider');
      expect(screen.getByTestId('controlled-value')).toHaveTextContent('pasted-provider');
    });
  });

  it('updates React state immediately after cutting from a controlled input', async () => {
    render(
      <TextContextMenuProvider>
        <ControlledField initialValue="provider-name" />
      </TextContextMenuProvider>,
    );

    const input = screen.getByLabelText('Provider name') as HTMLInputElement;
    input.setSelectionRange(0, 'provider-'.length);
    fireEvent.contextMenu(input, { clientX: 20, clientY: 20 });

    const cutItem = await screen.findByRole('menuitem', { name: /剪切/ });
    expect(cutItem).toBeEnabled();
    fireEvent.click(cutItem);

    await waitFor(() => {
      expect(input).toHaveValue('name');
      expect(screen.getByTestId('controlled-value')).toHaveTextContent('name');
    });
  });
});
