import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@/features/learning-hub/apps/UnifiedAppPanel', () => ({ default: ({ resourceId }: { resourceId: string }) => <div>reader:{resourceId}</div> }));
import { NoteRelationPreview } from '../NoteRelationPreview';
import type { NoteRelation } from '../../noteRelations';
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const relation: NoteRelation = { id: 'rel_a', note_id: 'note_a', block_id: null, type: 'source', resource_id: 'res_pdf', locator: { type: 'page', value: 12 }, revision: 1,
  invalidated_at: null, created_at: 'now', updated_at: 'now', reference: { resource_exists: true, locator_exists: true } };

describe('relation reader resolves ID refs and locates the real target', () => {
  it('resolves VFS resource ID to source file, mounts reader and awaits PDF focus acknowledgement', async () => {
    invoke.mockResolvedValue({ sourceId: 'file_pdf' });
    const focused = vi.fn((event: Event) => (event as CustomEvent).detail.acknowledge(true));
    document.addEventListener('pdf-ref:focus', focused);
    try {
      render(<NoteRelationPreview relation={relation} onClose={vi.fn()} />);
      await screen.findByText('reader:file_pdf');
      fireEvent.click(screen.getByRole('button', { name: '定位到关联位置' }));
      await waitFor(() => expect(focused).toHaveBeenCalled());
      expect((focused.mock.calls[0][0] as CustomEvent).detail).toMatchObject({ sourceId: 'file_pdf', pageNumber: 12 });
      expect(invoke).toHaveBeenCalledWith('vfs_get_resource', { resourceId: 'res_pdf' });
    } finally { document.removeEventListener('pdf-ref:focus', focused); }
  });
  it('reads the selected actual Anki card, not a resource title or copied props', async () => {
    invoke.mockResolvedValue([{ id: 'other', front: 'wrong', back: '' }, { id: 'card_a', front: '题面', back: '答案' }]);
    render(<NoteRelationPreview relation={{ ...relation, type: 'card', resource_id: 'doc_a', locator: { type: 'card', value: 'card_a' } }} onClose={vi.fn()} />);
    await screen.findByText('题面'); expect(screen.getByText('答案')).toBeInTheDocument();
    expect(screen.queryByText('wrong')).toBeNull();
    expect(invoke).toHaveBeenCalledWith('get_document_cards', { documentId: 'doc_a' });
  });
});
