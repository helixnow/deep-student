import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/utils/shared', () => ({ isTauriRuntime: false }));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));
// 预览/编辑用真实 Crepe 在 jsdom 下过重：以只读文本 / 受控 textarea 代替，保留 onChange/onReady 契约
vi.mock('@/components/crepe', () => ({
  CrepeEditor: ({ defaultValue, readonly, onChange, onReady }: {
    defaultValue?: string; readonly?: boolean; onChange?: (value: string) => void;
    onReady?: (api: { getMarkdown: () => string; setMarkdown: (markdown: string) => boolean }) => void;
  }) => {
    const [value, setValue] = React.useState(defaultValue ?? '');
    const ref = React.useRef(value); ref.current = value;
    React.useEffect(() => { onReady?.({ getMarkdown: () => ref.current, setMarkdown: (markdown) => { ref.current = markdown; setValue(markdown); return true; } }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
    return readonly
      ? <div data-testid="template-preview">{value}</div>
      : <textarea aria-label="template-body" value={value} onChange={(event) => { setValue(event.target.value); onChange?.(event.target.value); }} />;
  },
}));
import { NotesTemplatePanel } from '../NotesTemplatePanel';
import { NoteLearningPropsFields } from '../NoteLearningPropsFields';
import { PERSONAL_NOTE_TEMPLATES_KEY } from '../../personalNoteTemplates';

afterEach(cleanup);
beforeEach(() => localStorage.clear());

const seed = (templates: unknown[]) => localStorage.setItem(PERSONAL_NOTE_TEMPLATES_KEY, JSON.stringify(templates));
const mine = { id: 'personal:a', title: '我的复习模板', summary: '', markdown: '## 回顾\n\n**重点**', revision: 1 };

function renderPanel(props: Partial<React.ComponentProps<typeof NotesTemplatePanel>> = {}) {
  const onRequestClose = vi.fn();
  const onApplyTemplate = vi.fn().mockResolvedValue(undefined);
  const view = render(<NotesTemplatePanel open panelId="tpl" onRequestClose={onRequestClose} onApplyTemplate={onApplyTemplate} {...props} />);
  return { ...view, onRequestClose, onApplyTemplate };
}

describe('template gallery dialog', () => {
  it('lists built-in and personal templates, previews the rendered body and appends without a document host', async () => {
    seed([mine]);
    const { onApplyTemplate, onRequestClose } = renderPanel();
    expect(screen.getByRole('button', { name: '听课笔记' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(await screen.findByRole('button', { name: '我的复习模板' }));
    expect(screen.getByTestId('template-preview')).toHaveTextContent('## 回顾');
    expect(screen.queryByRole('textbox', { name: '模板正文（Markdown）' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '使用模板' }));
    await waitFor(() => expect(onApplyTemplate).toHaveBeenCalledWith(expect.objectContaining({ markdown: '## 回顾\n\n**重点**' })));
    expect(onRequestClose).toHaveBeenCalled();
  });

  it('inserts at the captured position, keeps the dialog open with the error on failure, and retries', async () => {
    seed([mine]);
    const baseline = { noteId: 'note_a', revision: 1, markdown: '整篇原文' };
    const insertDocument = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(true);
    const replaceDocument = vi.fn().mockResolvedValue(true);
    const { onRequestClose } = renderPanel({ documentHost: { getDocument: () => baseline, replaceDocument,
      getInsertionPoint: () => ({ from: 2, to: 2 }), insertDocument } });
    fireEvent.click(await screen.findByRole('button', { name: '我的复习模板' }));
    fireEvent.click(screen.getByRole('button', { name: '插入当前位置' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('disk full');
    expect(onRequestClose).not.toHaveBeenCalled();
    expect(insertDocument).toHaveBeenCalledWith('## 回顾\n\n**重点**', baseline, { from: 2, to: 2 });
    fireEvent.click(screen.getByRole('button', { name: '插入当前位置' }));
    await waitFor(() => expect(onRequestClose).toHaveBeenCalled());
    expect(replaceDocument).not.toHaveBeenCalled();
  });

  it('requires an explicit confirmation to replace, and fails closed when the note changed after opening', async () => {
    seed([{ ...mine, markdown: '# {{title}}' }]);
    let document = { noteId: 'n', revision: 1, markdown: '完整原文' };
    const replaceDocument = vi.fn().mockResolvedValue(true);
    const { onRequestClose } = renderPanel({ documentHost: { getDocument: () => document, replaceDocument, variables: { title: '数学' } } });
    fireEvent.click(await screen.findByRole('button', { name: '我的复习模板' }));
    fireEvent.click(screen.getByRole('button', { name: '替换全文' }));
    expect(screen.getByText(/将用此模板替换整篇笔记/)).toBeInTheDocument();
    document = { ...document, revision: 2, markdown: '新编辑' };
    fireEvent.click(screen.getByRole('button', { name: '确认替换正文' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('笔记已变化');
    expect(replaceDocument).not.toHaveBeenCalled();
    // 失败后已重新捕获基线：再次确认即作用于最新内容
    fireEvent.click(screen.getByRole('button', { name: '确认替换正文' }));
    await waitFor(() => expect(replaceDocument).toHaveBeenCalledWith('# 数学\n', document));
    expect(onRequestClose).toHaveBeenCalled();
  });

  it('saves the current note as a template with the real editor, then deletes it', async () => {
    const document = { noteId: 'n', revision: 1, markdown: '## 当前笔记结构' };
    renderPanel({ documentHost: { getDocument: () => document, replaceDocument: vi.fn(), variables: { title: '线代' } } });
    fireEvent.click(screen.getByRole('button', { name: '将当前笔记存为模板' }));
    expect(screen.getByLabelText('模板名称')).toHaveValue('线代');
    expect(screen.getByLabelText('template-body')).toHaveValue('## 当前笔记结构');
    fireEvent.change(screen.getByLabelText('模板名称'), { target: { value: '线代模板' } });
    fireEvent.click(screen.getByRole('button', { name: '保存个人模板' }));
    expect(await screen.findByRole('button', { name: '线代模板' })).toHaveAttribute('aria-pressed', 'true');
    expect(JSON.parse(localStorage.getItem(PERSONAL_NOTE_TEMPLATES_KEY)!)[0]).toMatchObject({ title: '线代模板', markdown: '## 当前笔记结构' });
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    fireEvent.click(screen.getAllByRole('button', { name: '删除' }).at(-1)!);
    await waitFor(() => expect(screen.queryByRole('button', { name: '线代模板' })).toBeNull());
    expect(JSON.parse(localStorage.getItem(PERSONAL_NOTE_TEMPLATES_KEY)!)).toEqual([]);
  });

  it('keeps the draft when persistence fails', async () => {
    const setItem = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: '新建模板' }));
    fireEvent.change(screen.getByLabelText('模板名称'), { target: { value: '模板' } });
    fireEvent.change(screen.getByLabelText('template-body'), { target: { value: '待保存的内容' } });
    fireEvent.click(screen.getByRole('button', { name: '保存个人模板' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('quota');
    expect(screen.getByLabelText('template-body')).toHaveValue('待保存的内容');
    setItem.mockRestore();
  });

  it('persists course defaults and presets, then fills only unset fields into a learning-property draft', async () => {
    const view = renderPanel();
    fireEvent.click(screen.getByRole('button', { name: '新建模板' }));
    fireEvent.change(screen.getByLabelText('模板名称'), { target: { value: '数学默认模板' } });
    fireEvent.change(screen.getByLabelText('template-body'), { target: { value: '## 数学' } });
    fireEvent.change(screen.getByLabelText('设为课程默认（留空取消）'), { target: { value: '数学' } });
    fireEvent.change(screen.getByLabelText('预设课程'), { target: { value: '数学' } });
    fireEvent.change(screen.getByLabelText('预设章节'), { target: { value: '模板章节' } });
    fireEvent.change(screen.getByLabelText('预设掌握状态'), { target: { value: 'learning' } });
    fireEvent.change(screen.getByLabelText('预设复习日期'), { target: { value: '2026-09-25' } });
    fireEvent.click(screen.getByRole('button', { name: '保存个人模板' }));
    expect(await screen.findByText('数学 默认')).toBeInTheDocument();
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
