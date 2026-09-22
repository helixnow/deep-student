import React from 'react';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BlockTransferDialog } from '../BlockTransferDialog';
import type { BlockTransferService, BlockTransferReceipt } from '../service';

vi.mock('../../../ui/DsDialog', () => ({ DsDialog: ({ children }: { children: React.ReactNode }) => <div role="dialog">{children}</div> }));
afterEach(cleanup);
const receipt: BlockTransferReceipt = { sourceNoteId: 'source', targetNoteId: 'right', result: {
  operation_id: 'op', source_note_id: 'source', target_note_id: 'right', source_updated_at: 's2', target_updated_at: 't2',
  source_version_id: 'sv2', target_version_id: 'tv2', undone: false,
} };
function service(): BlockTransferService {
  return { ensureIdentities: vi.fn(),
    listTargets: vi.fn(async () => [{ id: 'left', title: '同名', path: '/课程一/同名' }, { id: 'right', title: '同名', path: '/课程二/同名' }]),
    move: vi.fn(async () => receipt), undo: vi.fn(async () => ({ ...receipt, result: { ...receipt.result, undone: true } })),
  };
}
describe('cross-page move UI', () => {
  it('distinguishes same-name notes by path, selects exact ID, and provides backend Undo', async () => {
    const api = service();
    render(<BlockTransferDialog sourceNoteId="source" blockIds={['block']} service={api} onClose={vi.fn()} />);
    const radios = await screen.findAllByRole('radio');
    expect(screen.getByText('/课程一/同名 · left')).toBeTruthy(); expect(screen.getByText('/课程二/同名 · right')).toBeTruthy();
    fireEvent.click(radios[1]); fireEvent.click(screen.getByRole('button', { name: '移动', exact: true }));
    await waitFor(() => expect(api.move).toHaveBeenCalledWith('source', 'right', ['block'], expect.any(String)));
    fireEvent.click(await screen.findByRole('button', { name: '撤销移动' }));
    await waitFor(() => expect(api.undo).toHaveBeenCalledWith(receipt));
    expect(await screen.findByText('已撤销移动')).toBeTruthy();
  });
  it('keeps target selection and the same operation ID on failed move retry', async () => {
    const api = service(); vi.mocked(api.move).mockRejectedValueOnce(new Error('保存冲突'));
    render(<BlockTransferDialog sourceNoteId="source" blockIds={['block']} service={api} onClose={vi.fn()} />);
    fireEvent.click((await screen.findAllByRole('radio'))[0]);
    fireEvent.click(screen.getByRole('button', { name: '移动', exact: true }));
    expect(await screen.findByRole('alert')).toHaveTextContent('保存冲突');
    fireEvent.click(screen.getByRole('button', { name: '移动', exact: true }));
    await waitFor(() => expect(api.move).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.move).mock.calls[1]).toEqual(vi.mocked(api.move).mock.calls[0]);
  });
});
