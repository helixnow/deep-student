import React from 'react';
import { ExamSheetUploader, type ImportDraftResponse } from '@/components/ExamSheetUploader';

const draft = {
  summary: { id: 'exam_shared', exam_name: 'Reading' },
  preview: { pages: [] },
  draft_job_id: 'job_shared',
  draft_version: 1,
  draft_document: {
    materials: [{ local_id: 'm1', content: 'Shared reading material. '.repeat(60) }],
    groups: [{ local_id: 'g1', label: 'Reading', material_ids: ['m1'], question_ids: ['q1', 'q2', 'q3', 'q4', 'q5'] }],
    questions: Array.from({ length: 5 }, (_, index) => ({
      local_id: `q${index + 1}`,
      group_id: 'g1',
      original_label: String(index + 1),
      content: `Question ${index + 1}: What does the passage establish?`,
      question_type: 'short_answer',
    })),
  },
  model_route: { model: { name: 'Selected multimodal model' }, visual_fallback: null },
} as ImportDraftResponse;

export function ImportDraftHarness() {
  return <div style={{ height: '100vh', width: '100%', overflow: 'hidden' }}><ExamSheetUploader initialDraft={draft} /></div>;
}
