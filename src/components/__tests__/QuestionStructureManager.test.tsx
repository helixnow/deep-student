import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { QuestionStructureManager } from '../QuestionStructureManager';
import type { Question, QuestionBankStructure } from '@/api/questionBankApi';

afterEach(() => {
  cleanup();
  invokeMock.mockReset();
});

function question(id: string, label: string, content: string, groupId: string | null = null): Question {
  return {
    id,
    questionLabel: label,
    content,
    questionType: 'short_answer',
    options: [],
    answer: '答案',
    explanation: '',
    difficulty: 'easy',
    tags: [],
    status: 'new',
    attemptCount: 0,
    correctCount: 0,
    isFavorite: false,
    images: [],
    groupId,
    groupPosition: null,
    groupLabel: null,
    materials: [],
  };
}

const questions: Question[] = [
  question('q1', '1', '阅读子题一', 'g1'),
  question('q2', '2', '阅读子题二', 'g1'),
  question('q3', '3', '完形子题一', 'g2'),
  question('q4', '4', '未分组题目四'),
];

function structureFixture(overrides: Partial<QuestionBankStructure> = {}): QuestionBankStructure {
  return {
    exam_id: 'exam_1',
    materials: [
      { id: 'm1', content: '共享阅读材料一', images: [], version: 2 },
      { id: 'm2', content: '未使用材料二', images: [], version: 5 },
    ],
    groups: [
      {
        id: 'g1',
        exam_id: 'exam_1',
        label: '阅读理解一',
        position: 0,
        version: 3,
        material_ids: ['m1'],
        question_ids: ['q1', 'q2'],
      },
      {
        id: 'g2',
        exam_id: 'exam_1',
        label: '完形填空',
        position: 1,
        version: 1,
        material_ids: [],
        question_ids: ['q3'],
      },
    ],
    ...overrides,
  };
}

function mockStructureApi(overrides?: {
  structure?: QuestionBankStructure;
  updateGroup?: ReturnType<typeof vi.fn>;
  deleteGroup?: ReturnType<typeof vi.fn>;
  deleteMaterial?: ReturnType<typeof vi.fn>;
}) {
  const structure = overrides?.structure ?? structureFixture();
  invokeMock.mockImplementation((command: string) => {
    switch (command) {
      case 'qbank_list_structure':
        return Promise.resolve(structure);
      case 'qbank_update_group':
        return overrides?.updateGroup
          ? overrides.updateGroup()
          : Promise.resolve({
              exam_id: 'exam_1',
              group: {
                id: 'g1',
                exam_id: 'exam_1',
                label: '阅读理解一',
                position: 0,
                version: 4,
                material_ids: ['m1'],
                question_ids: ['q1', 'q2'],
              },
              removed_question_ids: [],
              solo_group_ids: [],
            });
      case 'qbank_delete_group':
        return overrides?.deleteGroup ? overrides.deleteGroup() : Promise.resolve(undefined);
      case 'qbank_delete_material':
        return overrides?.deleteMaterial ? overrides.deleteMaterial() : Promise.resolve(undefined);
      default:
        return Promise.reject(new Error(`unexpected command: ${command}`));
    }
  });
}

async function renderManager(options: { editable?: boolean; onChanged?: () => void } = {}) {
  render(
    <QuestionStructureManager
      open
      onOpenChange={() => {}}
      examId="exam_1"
      questions={questions}
      editable={options.editable}
      onChanged={options.onChanged}
    />,
  );
  await screen.findByText('阅读理解一');
}

function updateGroupCall(index = -1) {
  const calls = invokeMock.mock.calls.filter(([command]) => command === 'qbank_update_group');
  return calls.at(index)?.[1] as Record<string, unknown> | undefined;
}

beforeEach(() => {
  invokeMock.mockReset();
});

describe('QuestionStructureManager', () => {
  it('loads the canonical structure and shows linked vs unused materials', async () => {
    mockStructureApi();
    await renderManager();

    expect(invokeMock).toHaveBeenCalledWith('qbank_list_structure', { examId: 'exam_1' });
    expect(screen.getByText(/1 · 阅读子题一/)).toBeInTheDocument();
    expect(screen.getByText(/2 · 阅读子题二/)).toBeInTheDocument();
    expect(screen.getByText('完形填空')).toBeInTheDocument();
    const g1 = screen.getByRole('region', { name: '阅读理解一' });
    expect(within(g1).getByRole('button', { name: '共享阅读材料一' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByText('未使用材料二').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /删除材料/ })).toBeInTheDocument();
  });

  it('reorders members with the up/down controls using the group version for OCC', async () => {
    mockStructureApi();
    await renderManager();

    fireEvent.click(screen.getAllByRole('button', { name: '下移' })[0]);

    await waitFor(() => expect(updateGroupCall()).toMatchObject({
      groupId: 'g1',
      label: '阅读理解一',
      questionIds: ['q2', 'q1'],
      materialIds: ['m1'],
      expectedVersion: 3,
    }));
  });

  it('adds only ungrouped questions as members', async () => {
    mockStructureApi();
    await renderManager();

    fireEvent.click(screen.getAllByRole('button', { name: '添加子题' })[0]);
    expect(screen.queryByRole('button', { name: /添加 .*完形子题一/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /添加 .*未分组题目四/ }));

    await waitFor(() => expect(updateGroupCall()).toMatchObject({
      groupId: 'g1',
      questionIds: ['q1', 'q2', 'q4'],
    }));
  });

  it('removes a member while keeping the remaining order', async () => {
    mockStructureApi();
    await renderManager();

    fireEvent.click(screen.getAllByRole('button', { name: '移出题组' })[0]);

    await waitFor(() => expect(updateGroupCall()).toMatchObject({
      groupId: 'g1',
      questionIds: ['q2'],
    }));
  });

  it('edits the group label', async () => {
    mockStructureApi();
    await renderManager();

    fireEvent.click(screen.getAllByRole('button', { name: '编辑题组名称' })[0]);
    fireEvent.change(screen.getByLabelText('题组名称'), { target: { value: '阅读理解二' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(updateGroupCall()).toMatchObject({
      groupId: 'g1',
      label: '阅读理解二',
      expectedVersion: 3,
    }));
  });

  it('links and unlinks shared materials per group', async () => {
    mockStructureApi();
    await renderManager();

    const g2 = screen.getByRole('region', { name: '完形填空' });
    fireEvent.click(within(g2).getByRole('button', { name: '共享阅读材料一' }));

    await waitFor(() => expect(updateGroupCall()).toMatchObject({
      groupId: 'g2',
      materialIds: ['m1'],
      questionIds: ['q3'],
      expectedVersion: 1,
    }));
  });

  it('dissolves a group only after explicit confirmation and refreshes the canonical view', async () => {
    const onChanged = vi.fn();
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    mockStructureApi();
    await renderManager({ onChanged });

    fireEvent.click(screen.getAllByRole('button', { name: '解散题组' })[0]);
    const confirmBar = screen.getByRole('alertdialog', { name: '解散题组' });
    expect(within(confirmBar).getByText(/共享材料不会被删除/)).toBeInTheDocument();
    fireEvent.click(within(confirmBar).getByRole('button', { name: '解散' }));

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('qbank_delete_group', {
      groupId: 'g1',
      mode: 'ungroup',
      expectedVersion: 3,
    }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(dispatchSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'qbank:refresh' }));
    dispatchSpy.mockRestore();
  });

  it('deletes a group and its members only after explicit confirmation', async () => {
    mockStructureApi();
    await renderManager();

    fireEvent.click(screen.getAllByRole('button', { name: '删除题组及子题' })[0]);
    const confirmBar = screen.getByRole('alertdialog', { name: '删除题组及子题' });
    expect(within(confirmBar).getByText(/2 道子题/)).toBeInTheDocument();
    fireEvent.click(within(confirmBar).getByRole('button', { name: '删除' }));

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('qbank_delete_group', {
      groupId: 'g1',
      mode: 'delete_members',
      expectedVersion: 3,
    }));
  });

  it('deletes only unused materials with their own version', async () => {
    mockStructureApi();
    await renderManager();

    fireEvent.click(screen.getByRole('button', { name: /删除材料/ }));
    const confirmBar = screen.getByRole('alertdialog', { name: '删除未使用材料' });
    fireEvent.click(within(confirmBar).getByRole('button', { name: '删除' }));

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('qbank_delete_material', {
      materialId: 'm2',
      expectedVersion: 5,
    }));
  });

  it('surfaces OCC conflicts, reloads the latest structure, and never reports success', async () => {
    mockStructureApi({ updateGroup: () => Promise.reject(new Error('题组版本已变化')) });
    await renderManager();

    fireEvent.click(screen.getAllByRole('button', { name: '下移' })[0]);

    expect(await screen.findByRole('alert')).toHaveTextContent(/重新载入最新结构/);
    await waitFor(() => {
      const listCalls = invokeMock.mock.calls.filter(([command]) => command === 'qbank_list_structure');
      expect(listCalls).toHaveLength(2);
    });
  });

  it('hides write controls in read-only mode', async () => {
    mockStructureApi();
    await renderManager({ editable: false });

    expect(screen.queryByRole('button', { name: '编辑题组名称' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '添加子题' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '解散题组' })).not.toBeInTheDocument();
    const materialChips = screen.getAllByRole('button', { name: '共享阅读材料一' });
    expect(materialChips.length).toBeGreaterThan(0);
    for (const chip of materialChips) expect(chip).toBeDisabled();
  });
});
