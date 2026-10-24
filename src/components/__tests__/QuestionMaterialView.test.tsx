import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import {
  QuestionMaterialView,
  buildDisplayGroups,
  shouldRenderMaterialHeader,
} from '../QuestionMaterialView';
import type { Question, QuestionMaterial } from '@/api/questionBankApi';

afterEach(() => {
  cleanup();
  invokeMock.mockReset();
});

const material: QuestionMaterial = {
  id: 'qmat_1',
  content: '共享文章：数据并行训练通过多卡分摊批次。',
  images: [],
  source_refs: [{ source_id: 'src_1', page: 1 }],
  version: 3,
};

describe('QuestionMaterialView', () => {
  it('renders shared material content before the question body', () => {
    render(<QuestionMaterialView materials={[material]} />);
    expect(screen.getByText(/共享文章：数据并行训练/)).toBeInTheDocument();
    expect(screen.getByText(/src_1/)).toBeInTheDocument();
  });

  it('saves edits with the material version for OCC and reports the updated material', async () => {
    invokeMock.mockResolvedValue({ ...material, content: '更新后的材料', version: 4 });
    const onUpdated = vi.fn();

    render(<QuestionMaterialView materials={[material]} mode="edit" onUpdated={onUpdated} />);
    fireEvent.click(screen.getByRole('button', { name: /编辑材料/ }));
    fireEvent.change(screen.getByLabelText('编辑共享材料'), {
      target: { value: '更新后的材料' },
    });
    fireEvent.click(screen.getByRole('button', { name: /保存/ }));

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('qbank_update_material', {
      materialId: 'qmat_1',
      content: '更新后的材料',
      expectedVersion: 3,
    }));
    await waitFor(() => expect(onUpdated).toHaveBeenCalledWith(expect.objectContaining({
      id: 'qmat_1',
      version: 4,
    })));
  });

  it('keeps the draft and warns instead of overwriting on version conflict', async () => {
    invokeMock.mockRejectedValue(new Error('material version conflict'));

    render(<QuestionMaterialView materials={[material]} mode="edit" />);
    fireEvent.click(screen.getByRole('button', { name: /编辑材料/ }));
    fireEvent.change(screen.getByLabelText('编辑共享材料'), {
      target: { value: '我的新版本' },
    });
    fireEvent.click(screen.getByRole('button', { name: /保存/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/重新载入/);
    expect(screen.getByLabelText('编辑共享材料')).toHaveValue('我的新版本');
  });

  it('never discards unsaved edits when the parent refreshes a newer material version', () => {
    const { rerender } = render(<QuestionMaterialView materials={[material]} mode="edit" />);
    fireEvent.click(screen.getByRole('button', { name: /编辑材料/ }));
    fireEvent.change(screen.getByLabelText('编辑共享材料'), {
      target: { value: '我的未保存草稿' },
    });

    rerender(
      <QuestionMaterialView
        materials={[{ ...material, content: '其他设备的新内容', version: 4 }]}
        mode="edit"
      />,
    );

    expect(screen.getByLabelText('编辑共享材料')).toHaveValue('我的未保存草稿');
  });

  it('follows external updates while the draft is still pristine', () => {
    const { rerender } = render(<QuestionMaterialView materials={[material]} mode="edit" />);
    fireEvent.click(screen.getByRole('button', { name: /编辑材料/ }));

    rerender(
      <QuestionMaterialView
        materials={[{ ...material, content: '其他设备的新内容', version: 4 }]}
        mode="edit"
      />,
    );

    expect(screen.getByLabelText('编辑共享材料')).toHaveValue('其他设备的新内容');
  });
});

describe('material grouping helpers', () => {
  const q = (
    id: string,
    groupId: string | null,
    materials: QuestionMaterial[] = [],
  ): Pick<Question, 'id' | 'groupId' | 'groupLabel' | 'materials'> => ({
    id,
    groupId,
    groupLabel: groupId ? '阅读理解一' : null,
    materials,
  });

  it('renders material once per contiguous group', () => {
    expect(shouldRenderMaterialHeader(q('q1', 'g1', [material]), null)).toBe(true);
    expect(shouldRenderMaterialHeader(q('q2', 'g1', [material]), q('q1', 'g1', [material]))).toBe(false);
    expect(shouldRenderMaterialHeader(q('q3', 'g2', [material]), q('q2', 'g1', [material]))).toBe(true);
    // 独立题各自展示
    expect(shouldRenderMaterialHeader(q('q4', null, [material]), q('q3', null, [material]))).toBe(true);
  });

  it('builds stable display groups without guessing membership across non-contiguous ids', () => {
    const groups = buildDisplayGroups([
      q('q1', 'g1', [material]),
      q('q2', 'g1'),
      q('q3', null),
      q('q4', 'g1'),
    ]);

    expect(groups.map((group) => group.key)).toEqual(['g1', 'question:q3', 'g1']);
    expect(groups[0].questionIds).toEqual(['q1', 'q2']);
    expect(groups[0].materials).toEqual([material]);
    expect(groups[2].questionIds).toEqual(['q4']);
  });
});
