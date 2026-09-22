import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { create, get, setMetadata } = vi.hoisted(() => ({ create: vi.fn(), get: vi.fn(), setMetadata: vi.fn() }));
vi.mock('@/dstu', () => ({ dstu: { create, get, setMetadata }, updatedAtToVersionToken: (ms: number) => new Date(ms).toISOString() }));
vi.mock('@/utils/shared', () => ({ isTauriRuntime: false }));
import { CreateLearningNoteDialog } from '../CreateLearningNoteDialog';
import { savePersonalNoteTemplate } from '../../personalNoteTemplates';

const node = { id: 'note_created', type: 'note', path: '/note_created', updatedAt: 1000, metadata: {} };
beforeEach(() => { localStorage.clear(); create.mockReset(); get.mockReset().mockResolvedValue({ ok: true, value: node }); setMetadata.mockReset().mockResolvedValue({ ok: true, value: undefined }); });
afterEach(cleanup);
describe('visible new-note template choices', () => {
  it('shows the course default without forcing it, preserves edited props, persists metadata through OCC', async () => {
    await savePersonalNoteTemplate({ title: '数学默认', markdown: '# {{title}}\n复习', defaultForCourse: '数学', learningPreset: { course: '模板课程', chapter: '模板章节', mastery: 'learning' } });
    create.mockResolvedValue({ ok: true, value: node });
    const onCreated = vi.fn();
    render(<CreateLearningNoteDialog folderId="fld_a" onClose={vi.fn()} onCreated={onCreated} />);
    fireEvent.change(screen.getByLabelText('笔记标题'), { target: { value: '积分' } });
    fireEvent.change(screen.getByLabelText('所属课程'), { target: { value: '数学' } });
    await screen.findByRole('option', { name: '课程默认：数学默认' });
    expect(screen.getByLabelText('新建模板')).toHaveValue('none');
    fireEvent.change(screen.getByLabelText('章节'), { target: { value: '我填的章节' } });
    fireEvent.change(screen.getByLabelText('新建模板'), { target: { value: 'course-default' } });
    expect(screen.getByLabelText('章节')).toHaveValue('我填的章节');
    fireEvent.click(screen.getByRole('button', { name: '创建笔记' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith('/', { type: 'note', name: '积分', content: '# 积分\n复习', metadata: { folderId: 'fld_a' } }));
    expect(setMetadata).toHaveBeenCalledWith(node.path, { props: { study_course: '数学', study_chapter: '我填的章节', study_mastery: 'learning' } }, new Date(1000).toISOString());
    expect(onCreated).toHaveBeenCalledWith(node);
  });
  it('creates blank on explicit choice and retains form on storage failure', async () => {
    create.mockResolvedValue({ ok: false, error: { toUserMessage: () => 'disk full' } });
    const onCreated = vi.fn(); const onClose = vi.fn();
    render(<CreateLearningNoteDialog onClose={onClose} onCreated={onCreated} />);
    fireEvent.change(screen.getByLabelText('笔记标题'), { target: { value: '保留标题' } });
    fireEvent.click(screen.getByRole('button', { name: '创建笔记' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('disk full');
    expect(create).toHaveBeenCalledWith('/', { type: 'note', name: '保留标题', content: '', metadata: {} });
    expect(screen.getByLabelText('笔记标题')).toHaveValue('保留标题');
    expect(onCreated).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
  });
  it('shows a selected template course but allows explicitly clearing it', async () => {
    const template = await savePersonalNoteTemplate({ title: '数学模板', markdown: '模板正文', learningPreset: { course: '数学' } });
    create.mockResolvedValue({ ok: true, value: node });
    render(<CreateLearningNoteDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    await screen.findByRole('option', { name: '数学模板' });
    fireEvent.change(screen.getByLabelText('笔记标题'), { target: { value: '无课程笔记' } });
    fireEvent.change(screen.getByLabelText('新建模板'), { target: { value: template.id } });
    expect(screen.getByLabelText('所属课程')).toHaveValue('数学');
    fireEvent.change(screen.getByLabelText('所属课程'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: '创建笔记' }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(setMetadata).not.toHaveBeenCalled();
  });
  it('retries failed property persistence on the same created note without duplicating the body', async () => {
    create.mockResolvedValue({ ok: true, value: node });
    setMetadata.mockResolvedValueOnce({ ok: false, error: { toUserMessage: () => 'disk full' } });
    const onCreated = vi.fn();
    render(<CreateLearningNoteDialog onClose={vi.fn()} onCreated={onCreated} />);
    fireEvent.change(screen.getByLabelText('笔记标题'), { target: { value: '积分' } });
    fireEvent.change(screen.getByLabelText('所属课程'), { target: { value: '数学' } });
    fireEvent.click(screen.getByRole('button', { name: '创建笔记' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('正文已创建');
    expect(onCreated).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '重试保存属性' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(node));
    expect(create).toHaveBeenCalledTimes(1); expect(setMetadata).toHaveBeenCalledTimes(2);
  });
});
