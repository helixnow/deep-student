import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const saveAsNoteStart = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const table: Record<string, string> = {
        'pdf:annotations.filter_placeholder': '筛选批注内容…',
        'pdf:annotations.filter_by_color': '按颜色筛选',
        'pdf:annotations.no_filter_match': '没有符合筛选条件的批注',
        'pdf:annotations.export': `导出为笔记（${opts?.num ?? 0}）`,
        'pdf:annotations.export_hint': '导出提示',
        'pdf:annotations.summary_title': `《${opts?.name ?? ''}》批注汇总`,
        'pdf:annotations.summary_title_fallback': '批注汇总',
        'pdf:annotations.locate': `定位到第 ${opts?.page ?? 1} 页`,
        'pdf:annotations.add_note': '添加批注笔记',
        'pdf:annotations.edit_note': '编辑批注笔记',
        'pdf:annotations.note_placeholder': '记录批注想法…',
        'pdf:annotations.save_note': '保存',
        'pdf:annotations.cancel_note': '取消',
        'pdf:annotations.comment_prefix': '批注：',
        'pdf:annotations.semantic_yellow': '核心结论',
        'pdf:annotations.semantic_purple': '公式数据',
        'pdf:toolbar.page': `第 ${opts?.page ?? 1} 页`,
        'pdf:toolbar.no_highlights': '暂无批注',
        'pdf:toolbar.no_highlights_hint': '在页面中划选文字即可添加高亮',
        'pdf:toolbar.delete_highlight': '删除批注',
        'pdf:selection.note_source': `—— 摘自《${opts?.name ?? ''}》第 ${opts?.page ?? 1} 页`,
        'pdf:a11y.delete': '删除',
      };
      return table[key] ?? key;
    },
  }),
}));

vi.mock('@/shared/notes', () => ({
  useSaveAsNoteFlow: () => ({
    start: saveAsNoteStart,
    isSaving: false,
    pickerProps: {
      open: false,
      onOpenChange: () => {},
      onConfirm: () => {},
      title: '选择保存目录',
      inline: false,
    },
  }),
  SaveAsNoteFolderPicker: () => null,
}));

import { PdfAnnotationsPanel } from '../PdfAnnotationsPanel';
import type { AnnotationHighlight } from '../../pdfAnnotationList';

const SAMPLE_HIGHLIGHTS: AnnotationHighlight[] = [
  {
    id: 'hl-1',
    pageIndex: 2,
    text: 'Transformer eliminates recurrence entirely.',
    color: '#fef08a',
    rects: [{ x: 0.1, y: 0.2, width: 0.5, height: 0.03 }],
    createdAt: 100,
    coordVersion: 2,
    comment: '用自注意力替代循环结构，实现并行训练。',
  },
  {
    id: 'hl-2',
    pageIndex: 4,
    text: 'Attention(Q, K, V) = softmax(QK^T / sqrt(d_k))V',
    color: '#e9d5ff',
    rects: [{ x: 0.1, y: 0.4, width: 0.6, height: 0.04 }],
    createdAt: 200,
    coordVersion: 2,
  },
];

beforeEach(() => {
  cleanup();
  saveAsNoteStart.mockReset();
});

describe('PdfAnnotationsPanel academic comments and semantic color tags', () => {
  it('renders semantic color chips, displays comments, and filters by comment text', () => {
    render(
      <PdfAnnotationsPanel
        highlights={SAMPLE_HIGHLIGHTS}
        fileName="Attention.pdf"
        resourcePath="/论文/tb_attn"
        onSelectHighlight={vi.fn()}
        onRemoveHighlight={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: '核心结论' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '公式数据' })).toBeTruthy();
    expect(screen.getByText('用自注意力替代循环结构，实现并行训练。')).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText('筛选批注内容…'), {
      target: { value: '并行训练' },
    });
    expect(screen.getByText('Transformer eliminates recurrence entirely.')).toBeTruthy();
    expect(screen.queryByText('Attention(Q, K, V) = softmax(QK^T / sqrt(d_k))V')).toBeNull();
  });

  it('supports inline note editing via button or Ctrl+Enter without triggering page jump', () => {
    const onSelect = vi.fn();
    const onUpdateComment = vi.fn();
    render(
      <PdfAnnotationsPanel
        highlights={SAMPLE_HIGHLIGHTS}
        fileName="Attention.pdf"
        resourcePath="/论文/tb_attn"
        onSelectHighlight={onSelect}
        onRemoveHighlight={vi.fn()}
        onUpdateHighlightComment={onUpdateComment}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '添加批注笔记' }));
    const textarea = screen.getByPlaceholderText('记录批注想法…');
    fireEvent.change(textarea, { target: { value: '  缩放因子 sqrt(d_k) 防止梯度消失  ' } });
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });

    expect(onUpdateComment).toHaveBeenCalledWith('hl-2', '缩放因子 sqrt(d_k) 防止梯度消失');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('exports highlight comments alongside quotes and pdfref:// backlinks', () => {
    render(
      <PdfAnnotationsPanel
        highlights={SAMPLE_HIGHLIGHTS}
        fileName="Attention.pdf"
        resourcePath="/论文/tb_attn"
        onSelectHighlight={vi.fn()}
        onRemoveHighlight={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '导出为笔记（2）' }));
    expect(saveAsNoteStart).toHaveBeenCalledTimes(1);
    const payload = saveAsNoteStart.mock.calls[0]![0] as { content: string; title: string };
    expect(payload.title).toBe('《Attention.pdf》批注汇总');
    expect(payload.content).toContain('**批注：**用自注意力替代循环结构，实现并行训练。');
    expect(payload.content).toContain('pdfref://tb_attn?page=2');
  });
});
