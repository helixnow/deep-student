/** `question_import_draft_response`（commands.rs:1069-1085）：`?` 只原样传播 L18 的 AppError。 */
import { describe, expect, it } from 'vitest';
import { ExamSheetSessionError, type ExamSheetSessionService } from '../../media/api.ts';
import { draftResponse, type ImportResult } from '../src/question-import-service.ts';

function sessionsThrowing(failure: unknown): ExamSheetSessionService {
  return {
    getExamSheetSessionDetail: async () => { throw failure; },
  } as unknown as ExamSheetSessionService;
}

const result = { session_id: 's1' } as ImportResult;

describe('draftResponse error propagation', () => {
  it('unwraps ExamSheetSessionError to its AppError', async () => {
    const failure = new ExamSheetSessionError({ error_type: 'NotFound', message: '整卷不存在', details: null });
    await expect(draftResponse(sessionsThrowing(failure), result))
      .rejects.toMatchObject({ appError: { error_type: 'NotFound', message: '整卷不存在' } });
  });

  it('classifies other errors as database even when they carry an appError field', async () => {
    const failure = Object.assign(new Error('底层失败'), {
      appError: { error_type: 'Validation', message: '伪造的线缆值', details: null },
    });
    await expect(draftResponse(sessionsThrowing(failure), result))
      .rejects.toMatchObject({ appError: { error_type: 'Database', message: '底层失败' } });
  });
});
