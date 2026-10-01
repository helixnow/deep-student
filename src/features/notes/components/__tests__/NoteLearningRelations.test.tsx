import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NoteLearningRelations } from '../NoteLearningRelations';
import type { NoteRelation, NoteRelationsService } from '../../noteRelations';

afterEach(cleanup);
const relation: NoteRelation = { id: 'rel_a', note_id: 'note_a', block_id: null, type: 'source', resource_id: 'res_pdf', locator: { type: 'page', value: 5 }, revision: 7,
  invalidated_at: null, created_at: 'now', updated_at: 'now', reference: { resource_exists: true, locator_exists: true } };
function serviceFor(rows: NoteRelation[] = []): NoteRelationsService {
  return { list: vi.fn().mockResolvedValue(rows), put: vi.fn().mockResolvedValue(relation), delete: vi.fn().mockResolvedValue(true), referenceStatus: vi.fn().mockResolvedValue(relation.reference) };
}
describe('independent relations UI', () => {
  it('writes typed resource refs, keeps failed edits, and deletes using the displayed revision', async () => {
    const service = serviceFor([relation]);
    const view = render(<NoteLearningRelations noteId="note_a" service={service} />);
    fireEvent.click(await screen.findByRole('button', { name: '编辑关系' }));
    fireEvent.change(screen.getByLabelText('PDF 页码'), { target: { value: '12' } });
    vi.mocked(service.put).mockRejectedValueOnce({ type: 'Conflict', message: 'notes.relation_conflict' });
    fireEvent.click(screen.getByRole('button', { name: '保存关系' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('notes.relation_conflict');
    expect(screen.getByLabelText('PDF 页码')).toHaveValue(12);
    expect(service.put).toHaveBeenCalledWith({ id: 'rel_a', note_id: 'note_a', block_id: null, type: 'source', resource_id: 'res_pdf', locator: { type: 'page', value: 12 }, expected_revision: 7 });
    fireEvent.click(screen.getByRole('button', { name: '解除关系' }));
    await waitFor(() => expect(service.delete).toHaveBeenCalledWith('rel_a', 7));
    view.rerender(<NoteLearningRelations noteId="note_b" service={service} />);
    await waitFor(() => expect(screen.getByLabelText('PDF 页码')).toHaveValue(null));
  });
  it('ignores late old-note loads and keeps invalid references visible', async () => {
    let resolve!: (rows: NoteRelation[]) => void;
    const service = serviceFor([{ ...relation, resource_id: 'missing_target', invalidated_at: 'then' }]);
    vi.mocked(service.list).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const view = render(<NoteLearningRelations noteId="note_a" service={service} />);
    view.rerender(<NoteLearningRelations noteId="note_b" service={service} />);
    await screen.findByText('资源或定位目标已失效');
    await act(async () => resolve([relation]));
    expect(screen.queryByText(/res_pdf/)).toBeNull();
    expect(screen.getByRole('button', { name: '打开关联资源' })).toBeDisabled();
  });
  it('creates card and mistake locators without writing scalar note properties', async () => {
    const service = serviceFor();
    render(<NoteLearningRelations noteId="note_a" service={service} />);
    await waitFor(() => expect(screen.getByLabelText('关系类型')).toBeEnabled());
    fireEvent.change(screen.getByLabelText('关系类型'), { target: { value: 'card' } });
    fireEvent.change(screen.getByLabelText('资源 ID（卡片填文档 ID）'), { target: { value: 'doc_a' } });
    fireEvent.change(screen.getByLabelText('卡片 ID'), { target: { value: 'card_a' } });
    fireEvent.click(screen.getByRole('button', { name: '保存关系' }));
    await waitFor(() => expect(service.put).toHaveBeenCalledWith(expect.objectContaining({ type: 'card', resource_id: 'doc_a', locator: { type: 'card', value: 'card_a' }, expected_revision: null })));
    await waitFor(() => expect(screen.getByLabelText('关系类型')).toBeEnabled());
    fireEvent.change(screen.getByLabelText('关系类型'), { target: { value: 'mistake' } });
    fireEvent.change(screen.getByLabelText('资源 ID（卡片填文档 ID）'), { target: { value: 'res_exam' } });
    fireEvent.change(screen.getByLabelText('题目 ID'), { target: { value: 'q_a' } });
    fireEvent.click(screen.getByRole('button', { name: '保存关系' }));
    await waitFor(() => expect(service.put).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'mistake', resource_id: 'res_exam', locator: { type: 'question', value: 'q_a' } })));
  });
});
