import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import {
  deleteQuestionGroup,
  deleteQuestionMaterial,
  getQuestionBankStructure,
  updateQuestionGroup,
} from '../questionBankApi';

beforeEach(() => {
  invokeMock.mockReset();
});

describe('question bank structure management API', () => {
  it('reads the canonical structure with the exam id', async () => {
    const structure = { exam_id: 'exam_1', materials: [], groups: [] };
    invokeMock.mockResolvedValue(structure);

    await expect(getQuestionBankStructure('exam_1')).resolves.toEqual(structure);
    expect(invokeMock).toHaveBeenCalledWith('qbank_list_structure', { examId: 'exam_1' });
  });

  it('updates a group with label, member order, material links and expected version', async () => {
    const updated = {
      exam_id: 'exam_1',
      group: {
        id: 'g1',
        exam_id: 'exam_1',
        label: '阅读二',
        position: 0,
        version: 4,
        material_ids: ['m1'],
        question_ids: ['q2', 'q1'],
      },
      removed_question_ids: [],
      solo_group_ids: [],
    };
    invokeMock.mockResolvedValue(updated);

    await expect(updateQuestionGroup('g1', {
      label: '阅读二',
      questionIds: ['q2', 'q1'],
      materialIds: ['m1'],
      expectedVersion: 3,
    })).resolves.toEqual(updated);

    expect(invokeMock).toHaveBeenCalledWith('qbank_update_group', {
      groupId: 'g1',
      label: '阅读二',
      questionIds: ['q2', 'q1'],
      materialIds: ['m1'],
      expectedVersion: 3,
    });
  });

  it('passes the explicit delete mode for groups', async () => {
    invokeMock.mockResolvedValue(undefined);

    await deleteQuestionGroup('g1', 'ungroup', 3);
    await deleteQuestionGroup('g2', 'delete_members', 7);

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'qbank_delete_group', {
      groupId: 'g1',
      mode: 'ungroup',
      expectedVersion: 3,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'qbank_delete_group', {
      groupId: 'g2',
      mode: 'delete_members',
      expectedVersion: 7,
    });
  });

  it('deletes a material with its expected version', async () => {
    invokeMock.mockResolvedValue(undefined);

    await deleteQuestionMaterial('m1', 2);

    expect(invokeMock).toHaveBeenCalledWith('qbank_delete_material', {
      materialId: 'm1',
      expectedVersion: 2,
    });
  });
});
