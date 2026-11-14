import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const invokeMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock('../renderers/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => (
    <div data-testid="md-content">{content}</div>
  ),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const table: Record<string, string> = {
        'selectionToolbar.explain': '解释',
        'selectionToolbar.copy': '复制',
        'selectionToolbar.copied': '已复制',
        'selectionToolbar.addToChat': '添加到聊天',
        'explainPopover.thinking': '思考中...',
        'explainPopover.saveToAnnotation': '存入批注',
        'explainPopover.savedToAnnotation': '已存批注',
        'explainPopover.lensAriaLabel': '学术精读视角',
        'explainPopover.lenses.intuition': '通俗直觉',
        'explainPopover.lenses.formula': '公式拆解',
        'explainPopover.lenses.critique': '方法审视',
        'explainPopover.lenses.prereq': '先修背景',
        'explainPopover.academicPrompts.contextBlock': `[CTX:${opts?.before ?? ''}|${opts?.after ?? ''}]\n`,
        'explainPopover.academicPrompts.intuition': `[INTUITION] ${opts?.context ?? ''}${opts?.text ?? ''}`,
        'explainPopover.academicPrompts.formula': `[FORMULA] ${opts?.context ?? ''}${opts?.text ?? ''}`,
        'explainPopover.academicPrompts.critique': `[CRITIQUE] ${opts?.context ?? ''}${opts?.text ?? ''}`,
        'explainPopover.academicPrompts.prereq': `[PREREQ] ${opts?.context ?? ''}${opts?.text ?? ''}`,
        'common:actions.expand': '展开',
        'common:actions.collapse': '收起',
        'common:actions.close': '关闭',
        'common:actions.retry': '重试',
      };
      return table[key] ?? key;
    },
  }),
}));

import { ExplainPopover } from '../ExplainPopover';

beforeEach(() => {
  cleanup();
  invokeMock.mockReset();
});

describe('ExplainPopover academic reading lenses & pin-to-annotation', () => {
  it('switches academic lenses with surrounding context, caches per-lens answers, and pins to annotation', async () => {
    invokeMock
      .mockResolvedValueOnce({
        assistant_message: '直觉解读：用缩放点积衡量查询与键的相似度。',
        input_tokens: 20,
        output_tokens: 30,
      })
      .mockResolvedValueOnce({
        assistant_message: '公式拆解：Q 为查询矩阵，d_k 为键向量维度。',
        input_tokens: 25,
        output_tokens: 35,
      });

    const onSaveToAnnotation = vi.fn();
    render(
      <ExplainPopover
        sourceText="softmax(QK^T / sqrt(d_k))V"
        isVisible
        academicMode
        contextBefore="We compute the matrix of outputs as:"
        contextAfter="where d_k is the key dimension."
        onClose={vi.fn()}
        onSaveToAnnotation={onSaveToAnnotation}
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId('md-content').textContent).toContain('直觉解读'),
    );
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock.mock.calls[0]![1]).toEqual({
      prompt: expect.stringContaining('[INTUITION] [CTX:We compute the matrix of outputs as:|where d_k is the key dimension.]'),
    });

    // 切换到「公式拆解」视角
    fireEvent.click(screen.getByRole('tab', { name: '公式拆解' }));
    await waitFor(() =>
      expect(screen.getByTestId('md-content').textContent).toContain('公式拆解：Q 为查询矩阵'),
    );
    expect(invokeMock).toHaveBeenCalledTimes(2);

    // 切回「通俗直觉」视角：命中会话缓存，不重复请求 LLM
    fireEvent.click(screen.getByRole('tab', { name: '通俗直觉' }));
    await waitFor(() =>
      expect(screen.getByTestId('md-content').textContent).toContain('直觉解读'),
    );
    expect(invokeMock).toHaveBeenCalledTimes(2);

    // 一键存入批注
    fireEvent.click(screen.getByRole('button', { name: '存入批注' }));
    expect(onSaveToAnnotation).toHaveBeenCalledWith('直觉解读：用缩放点积衡量查询与键的相似度。');
    expect(screen.getByRole('button', { name: '已存批注' })).toBeTruthy();
  });
});
