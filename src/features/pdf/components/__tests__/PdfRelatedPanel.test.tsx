import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { invoke, get, navigate } = vi.hoisted(() => ({ invoke: vi.fn(), get: vi.fn(), navigate: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@/dstu', () => ({ dstu: { get } }));
vi.mock('@/features/notes/noteOrigin', () => ({ navigateToNoteOrigin: navigate }));
vi.mock('@/components/custom-scroll-area', () => ({ CustomScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
import PdfRelatedPanel from '../PdfRelatedPanel';

afterEach(() => { cleanup(); invoke.mockReset(); get.mockReset(); navigate.mockReset(); });

describe('PdfRelatedPanel', () => {
  it('queries by both DSTU id and VFS resource id, lists notes and chats, and opens them', async () => {
    get.mockResolvedValue({ ok: true, value: { id: 'file_a', resourceId: 'res_a' } });
    invoke.mockImplementation(async (cmd: string) => cmd === 'notes_list_referencing_resource'
      ? [{ noteId: 'note_1', title: '第三章摘录', updatedAt: '2026-10-01', via: 'origin' }]
      : [{ sessionId: 'sess_1', title: '推导讨论', messageId: 'msg_9', lastReferencedAt: 1 }]);
    const onOpenNote = vi.fn();
    window.addEventListener('DSTU_OPEN_NOTE', onOpenNote);
    render(<PdfRelatedPanel sourceId="file_a" />);
    fireEvent.click(await screen.findByRole('button', { name: /第三章摘录/ }));
    expect(onOpenNote).toHaveBeenCalled();
    window.removeEventListener('DSTU_OPEN_NOTE', onOpenNote);
    expect(invoke).toHaveBeenCalledWith('notes_list_referencing_resource', { resourceIds: ['file_a', 'res_a'] });
    expect(invoke).toHaveBeenCalledWith('chat_v2_list_sessions_referencing', { sourceIds: ['file_a', 'res_a'], limit: 20 });
    fireEvent.click(screen.getByRole('button', { name: /推导讨论/ }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ kind: 'chat', sessionId: 'sess_1', messageId: 'msg_9' }));
  });

  it('shows empty states', async () => {
    get.mockResolvedValue({ ok: false });
    invoke.mockResolvedValue([]);
    render(<PdfRelatedPanel sourceId="tb_1" />);
    expect(await screen.findByText(/还没有笔记引用这份资料/)).toBeInTheDocument();
    expect(screen.getByText('还没有对话讨论过这份资料。')).toBeInTheDocument();
  });
});
