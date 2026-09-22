import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
const { invoke, list } = vi.hoisted(() => ({ invoke: vi.fn(), list: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@/dstu', () => ({ dstu: { list } }));
import { NoteRelationTargetPicker } from '../NoteRelationTargetPicker';
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe('relation picker uses actual resource identities', () => {
  it('chooses a PDF by title but returns its VFS resource ID', async () => {
    list.mockResolvedValue({ ok: true, value: [{ id: 'file_pdf', resourceId: 'res_pdf', name: '教材.pdf', previewType: 'pdf' }] });
    const choose = vi.fn();
    render(<NoteRelationTargetPicker type="source" onChoose={choose} />);
    fireEvent.click(screen.getByRole('button', { name: '从资源库选择' }));
    fireEvent.click(await screen.findByRole('button', { name: '教材.pdf' }));
    expect(list).toHaveBeenCalledWith('/', expect.objectContaining({ typeFilter: 'file' }));
    expect(list).toHaveBeenCalledWith('/', expect.objectContaining({ typeFilter: 'textbook' }));
    expect(choose).toHaveBeenCalledWith('res_pdf', '1', '教材.pdf');
  });
  it('uses library card documentId and persisted card ID', async () => {
    invoke.mockResolvedValue({ items: [{ id: 'card_a', documentId: 'doc_a', front: '导数定义' }], total: 1 });
    const choose = vi.fn();
    render(<NoteRelationTargetPicker type="card" onChoose={choose} />);
    fireEvent.click(screen.getByRole('button', { name: '从资源库选择' }));
    fireEvent.click(await screen.findByRole('button', { name: '导数定义' }));
    expect(invoke).toHaveBeenCalledWith('list_anki_library_cards', { request: { search: '', page: 1, pageSize: 30 } });
    expect(choose).toHaveBeenCalledWith('doc_a', 'card_a', '导数定义');
  });
  it('lists questions using exam source ID but stores the exam resource ID', async () => {
    list.mockResolvedValue({ ok: true, value: [{ id: 'exam_a', resourceId: 'res_exam', name: '错题集' }] });
    invoke.mockResolvedValue({ questions: [{ id: 'q_a', content: '积分题', question_label: '1' }], total: 1 });
    const choose = vi.fn();
    render(<NoteRelationTargetPicker type="mistake" onChoose={choose} />);
    fireEvent.click(screen.getByRole('button', { name: '从资源库选择' }));
    fireEvent.click(await screen.findByRole('button', { name: '错题集' }));
    expect(list).toHaveBeenCalledWith('/', expect.objectContaining({ typeFilter: 'exam' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('qbank_list_questions', { request: { exam_id: 'exam_a', filters: {}, page: 1, page_size: 30 } }));
    fireEvent.click(await screen.findByRole('button', { name: '1 积分题' }));
    expect(choose).toHaveBeenCalledWith('res_exam', 'q_a', '1 积分题');
  });
});
