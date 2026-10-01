import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DstuNode } from '@/dstu';

const { repository } = vi.hoisted(() => ({ repository: {
  node: {} as DstuNode,
  setMetadata: vi.fn(),
} }));
vi.mock('@/dstu', () => ({
  dstu: {
    watch: () => () => {},
    getContent: async () => ({ ok: true, value: '原文' }),
    get: async () => ({ ok: true, value: repository.node }),
    setMetadata: repository.setMetadata,
  },
  updatedAtToVersionToken: (ms: number) => new Date(ms).toISOString(),
}));
vi.mock('@/features/notes/NotesContextPanel', () => ({
  NotesContextPanel: ({ beforeOutline }: { beforeOutline: React.ReactNode }) => <div>{beforeOutline}</div>,
}));
import { NotesPropertiesTab } from '../NotesPropertiesTab';

describe('learning properties through the existing DSTU host', () => {
  beforeEach(() => {
    repository.node = {
      id: 'note_1', path: '/note_1', name: '课程笔记', type: 'note', createdAt: 1000, updatedAt: 1000,
      metadata: { props: { status: 'draft', score: 9, study_mastery: '旧自定义值' } },
    };
    repository.setMetadata.mockReset();
    repository.setMetadata.mockImplementation(async (_path: string, metadata: Record<string, unknown>) => {
      repository.node = { ...repository.node, updatedAt: repository.node.updatedAt + 1000,
        metadata: { ...repository.node.metadata, ...metadata } };
      return { ok: true, value: undefined };
    });
  });
  afterEach(cleanup);

  it('writes typed properties with a version token and reloads them without rewriting legacy values', async () => {
    const { unmount } = render(<NotesPropertiesTab activeResource={repository.node} />);
    expect(screen.getByText(/旧值保留：旧自定义值/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('课程'), { target: { value: '数学' } });
    fireEvent.change(screen.getByLabelText('复习日期'), { target: { value: '2026-09-22' } });
    fireEvent.click(screen.getByRole('button', { name: '保存学习属性' }));
    await waitFor(() => expect(repository.setMetadata).toHaveBeenCalledWith('/note_1', { props: {
      status: 'draft', score: 9, study_mastery: '旧自定义值', study_course: '数学', study_review_date: '2026-09-22',
    } }, new Date(1000).toISOString()));
    await waitFor(() => expect(screen.getByRole('button', { name: '保存学习属性' })).toBeDisabled());
    unmount();
    render(<NotesPropertiesTab activeResource={repository.node} />);
    expect(screen.getByLabelText('课程')).toHaveValue('数学');
    expect(screen.getByLabelText('复习日期')).toHaveValue('2026-09-22');
    fireEvent.change(screen.getByLabelText('章节'), { target: { value: '第二章' } });
    fireEvent.click(screen.getByRole('button', { name: '保存学习属性' }));
    await waitFor(() => expect(repository.setMetadata).toHaveBeenLastCalledWith('/note_1', expect.anything(), new Date(2000).toISOString()));
  });

  it('retains a failed draft and blocks read-only writes', async () => {
    repository.setMetadata.mockResolvedValue({ ok: false, error: { toUserMessage: () => '版本冲突' } });
    const { unmount } = render(<NotesPropertiesTab activeResource={repository.node} />);
    fireEvent.change(screen.getByLabelText('课程'), { target: { value: '待保存课程' } });
    fireEvent.click(screen.getByRole('button', { name: '保存学习属性' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('版本冲突');
    expect(screen.getByLabelText('课程')).toHaveValue('待保存课程');
    unmount();
    render(<NotesPropertiesTab activeResource={repository.node} readOnly />);
    expect(screen.getByLabelText('课程')).toBeDisabled();
    expect(screen.queryByRole('button', { name: '保存学习属性' })).toBeNull();
  });
});
