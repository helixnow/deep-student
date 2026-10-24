import { describe, expect, it, vi } from 'vitest';
import type { Question } from '@/api/questionBankApi';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { buildCanonicalExportDocument } from '../QuestionBankExportDialog';

const canonicalDocument = {
  schema_version: 2 as const,
  mode: 'extract',
  materials: [{
    local_id: 'qmat_1',
    content: '共享材料正文',
    images: [],
    source_refs: [{ source_id: 'src_1', page: 1 }],
  }],
  groups: [{
    local_id: 'qgroup_1',
    label: '阅读理解一',
    material_ids: ['qmat_1'],
    question_ids: ['q_1'],
  }],
  questions: [{
    local_id: 'q_1',
    group_id: 'qgroup_1',
    original_label: '1',
    content: '子题',
    question_type: 'numeric' as const,
    options: null,
    answer: '3.14',
    explanation: '圆周率',
    structured_data: { answer_value: 3.14, tolerance: 0.01 },
    source_refs: [{ source_id: 'src_1', page: 2 }],
    images: [{ id: 'file_1', name: 'fig.png', mime: 'image/png', hash: 'a'.repeat(64) }],
  }],
  unmatched_answers: [],
  coverage: [],
  issues: [],
};

const progress = [{
  id: 'q_1',
  status: 'mastered',
  attemptCount: 2,
  correctCount: 1,
  isFavorite: true,
}] as unknown as Question[];

describe('buildCanonicalExportDocument', () => {
  it('uses the backend v2 export and preserves materials, structured_data, source refs and images', async () => {
    invokeMock.mockResolvedValue(canonicalDocument);

    const document = await buildCanonicalExportDocument('exam_1', {
      includeAnswer: true,
      includeExplanation: true,
      includeStatus: true,
      includeStats: true,
    }, progress);

    expect(invokeMock).toHaveBeenCalledWith('qbank_export_document', { examId: 'exam_1' });
    expect(document.materials).toEqual(canonicalDocument.materials);
    expect(document.groups).toEqual(canonicalDocument.groups);
    expect(document.questions[0].structured_data).toEqual({ answer_value: 3.14, tolerance: 0.01 });
    expect(document.questions[0].source_refs).toEqual([{ source_id: 'src_1', page: 2 }]);
    expect(document.questions[0].images).toHaveLength(1);
    expect(document.questions[0].status).toBe('mastered');
    expect(document.questions[0].attempt_count).toBe(2);
    expect(document.questions[0].is_favorite).toBe(true);
  });

  it('strips answers only when the user opts out, never dropping structure', async () => {
    invokeMock.mockResolvedValue(canonicalDocument);

    const document = await buildCanonicalExportDocument('exam_1', {
      includeAnswer: false,
      includeExplanation: false,
      includeStatus: false,
      includeStats: false,
    }, progress);

    expect(document.questions[0].answer).toBeUndefined();
    expect(document.questions[0].explanation).toBeUndefined();
    expect(document.questions[0].structured_data).toEqual({ answer_value: 3.14, tolerance: 0.01 });
    expect(document.questions[0].group_id).toBe('qgroup_1');
    expect(document.questions[0].status).toBeUndefined();
  });
});
