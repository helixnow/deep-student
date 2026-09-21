import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/utils/shared', () => ({ isTauriRuntime: false }));
import { PersonalNoteTemplates } from '../PersonalNoteTemplates';
import { NoteLearningPropsFields } from '../NoteLearningPropsFields';

afterEach(cleanup);
beforeEach(() => localStorage.clear());

describe('personal templates UI', () => {
  it('authors, saves, reloads, previews and appends a personal template', async () => {
    const onApplyTemplate = vi.fn().mockResolvedValue(undefined);
    const { unmount } = render(<PersonalNoteTemplates onApplyTemplate={onApplyTemplate} />);
    fireEvent.change(screen.getByLabelText('模板名称'), { target: { value: '我的复习模板' } });
    fireEvent.change(screen.getByLabelText('模板正文（Markdown）'), { target: { value: '## 回顾\n\n**重点**' } });
    await waitFor(() => expect(screen.getByRole('button', { name: '保存个人模板' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '保存个人模板' }));
    await screen.findByText('个人模板已保存');
    unmount();
    render(<PersonalNoteTemplates onApplyTemplate={onApplyTemplate} />);
    fireEvent.click(await screen.findByRole('button', { name: '我的复习模板' }));
    fireEvent.click(screen.getByRole('button', { name: '预览模板' }));
    expect(await screen.findByRole('heading', { name: '回顾' })).toBeInTheDocument();
    expect(onApplyTemplate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '追加到笔记末尾' }));
    await waitFor(() => expect(onApplyTemplate).toHaveBeenCalledWith(expect.objectContaining({ markdown: '## 回顾\n\n**重点**' })));
    expect(screen.queryByRole('button', { name: '确认替换正文' })).toBeNull();
  });

  it('captures a full document and requires preview confirmation; rejects edits since preview', async () => {
    let document = { noteId: 'n', revision: 1, markdown: '完整原文（含未保存段落）' };
    const replaceDocument = vi.fn().mockResolvedValue(true);
    render(<PersonalNoteTemplates onApplyTemplate={vi.fn()} documentHost={{ getDocument: () => document, replaceDocument, variables: { title: '数学' } }} />);
    fireEvent.click(screen.getByRole('button', { name: '从当前完整笔记填入' }));
    await waitFor(() => expect(screen.getByLabelText('模板正文（Markdown）')).toHaveValue(document.markdown));
    fireEvent.change(screen.getByLabelText('模板正文（Markdown）'), { target: { value: '# {{title}}' } });
    fireEvent.click(screen.getByRole('button', { name: '预览模板' }));
    const replace = await screen.findByRole('button', { name: '确认替换正文' });
    expect(replace).toBeDisabled();
    expect(screen.getByText(document.markdown)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: '我确认用预览内容替换整篇笔记' }));
    document = { ...document, revision: 2, markdown: '新编辑' };
    fireEvent.click(replace);
    expect(await screen.findByRole('alert')).toHaveTextContent('笔记已变化');
    expect(replaceDocument).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '预览模板' }));
    await waitFor(() => expect(screen.getByRole('checkbox')).not.toBeChecked());
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: '确认替换正文' }));
    await waitFor(() => expect(replaceDocument).toHaveBeenCalledWith('# 数学\n', document));
  });

  it('keeps authored text when persistence fails', async () => {
    const setItem = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    render(<PersonalNoteTemplates onApplyTemplate={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('模板名称'), { target: { value: '模板' } });
    fireEvent.change(screen.getByLabelText('模板正文（Markdown）'), { target: { value: '待保存的内容' } });
    await waitFor(() => expect(screen.getByRole('button', { name: '保存个人模板' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '保存个人模板' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('quota');
    expect(screen.getByLabelText('模板正文（Markdown）')).toHaveValue('待保存的内容');
    setItem.mockRestore();
  });

  it('persists course defaults and presets, then fills only unset fields into a learning-property draft', async () => {
    const view = render(<PersonalNoteTemplates onApplyTemplate={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('模板名称'), { target: { value: '数学默认模板' } });
    fireEvent.change(screen.getByLabelText('模板正文（Markdown）'), { target: { value: '## 数学' } });
    fireEvent.change(screen.getByLabelText('设为课程默认（留空取消）'), { target: { value: '数学' } });
    fireEvent.change(screen.getByLabelText('预设课程'), { target: { value: '数学' } });
    fireEvent.change(screen.getByLabelText('预设章节'), { target: { value: '模板章节' } });
    fireEvent.change(screen.getByLabelText('预设掌握状态'), { target: { value: 'learning' } });
    fireEvent.change(screen.getByLabelText('预设复习日期'), { target: { value: '2026-09-25' } });
    await waitFor(() => expect(screen.getByRole('button', { name: '保存个人模板' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '保存个人模板' }));
    await screen.findByText('个人模板已保存');
    view.unmount();

    const onSave = vi.fn().mockResolvedValue(true);
    render(<NoteLearningPropsFields value={{ study_course: '数学', study_mastery: '旧值', status: 'legacy' }} onSave={onSave} />);
    fireEvent.change(screen.getByLabelText('章节'), { target: { value: '我的章节草稿' } });
    const details = screen.getByText('从个人模板填入属性预设').closest('details')!;
    details.open = true;
    fireEvent(details, new Event('toggle'));
    await screen.findByText('课程默认：数学默认模板');
    fireEvent.click(screen.getByRole('button', { name: '填入预设草稿' }));
    expect(screen.getByLabelText('章节')).toHaveValue('我的章节草稿');
    expect(screen.getByLabelText('复习日期')).toHaveValue('2026-09-25');
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '保存学习属性' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({
      study_course: '数学', study_mastery: '旧值', status: 'legacy', study_chapter: '我的章节草稿', study_review_date: '2026-09-25',
    }));
  });
});
