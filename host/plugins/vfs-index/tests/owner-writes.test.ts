/**
 * L12 → L11 owner-write hand-off.
 *
 * `ds-mig/L11-vfs-repos` publishes the exact PDF/media setters in
 * `types/files.ts` / `types/content.ts`; main has not merged them yet. These
 * tests bind a recording owner and assert L12 forwards the exact arguments
 * instead of keeping a second production SQL writer. The L11 branch's own
 * `pdf-owner-writes.test.ts` covers the `updated_at`/transaction semantics.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { VfsReposService } from '../../vfs-repos/api.ts';
import {
  bindVfsTableOwners,
  unbindVfsTableOwners,
} from '../repository/owners.ts';
import {
  cancelMediaRow,
  markRecoveredPendingRow,
  setProcessingErrorRow,
  setProcessingProgressJson,
  updateCompressedBlobHashRow,
  updateExtractedTextRow,
  updateOcrPagesJsonRow,
  updatePreviewJsonOnlyRow,
  updatePreviewJsonRow,
  updateProcessingStatusRow,
  updateResourceOcrTextForFileRow,
} from '../repository/pdf.ts';
import { updateBusinessMmState } from '../repository/multimodal-source.ts';
import {
  saveResourceOcrText, updateResourceOcrTextWithoutTimestamp,
} from '../repository/index-content.ts';

const dbs: SqlExecutor[] = [];

function ownerHarness(): {
  db: SqlExecutor;
  fileCalls: Array<[string, unknown[]]>;
  resourceCalls: Array<[string, unknown[]]>;
  examCalls: Array<[string, unknown[]]>;
  stateCalls: Array<[string, unknown[]]>;
  repos: VfsReposService;
} {
  const fileCalls: Array<[string, unknown[]]> = [];
  const resourceCalls: Array<[string, unknown[]]> = [];
  const examCalls: Array<[string, unknown[]]> = [];
  const stateCalls: Array<[string, unknown[]]> = [];
  const record = (calls: Array<[string, unknown[]]>) =>
    (method: string) => (...args: unknown[]) => { calls.push([method, args]); };
  const repos = {
    files: {
      updatePdfExtractedText: record(fileCalls)('updatePdfExtractedText'),
      updatePdfPreview: record(fileCalls)('updatePdfPreview'),
      updatePdfPreviewOnly: record(fileCalls)('updatePdfPreviewOnly'),
      updatePdfOcrPages: record(fileCalls)('updatePdfOcrPages'),
      updateCompressedBlobHash: record(fileCalls)('updateCompressedBlobHash'),
      cancelProcessing: (conn: unknown, fileId: string) => {
        fileCalls.push(['cancelProcessing', [conn, fileId]]);
        return 1;
      },
      markProcessingRecovered: (conn: unknown, fileId: string) => {
        fileCalls.push(['markProcessingRecovered', [conn, fileId]]);
        return 1;
      },
      setProcessingError: record(fileCalls)('setProcessingError'),
      updateProcessingProgress: record(fileCalls)('updateProcessingProgress'),
      applyProcessingStatus: record(fileCalls)('applyProcessingStatus'),
      applyMultimodalIndexState: record(fileCalls)('applyMultimodalIndexState'),
    },
    resources: {
      saveOcrTextForFile: (...args: unknown[]) => {
        resourceCalls.push(['saveOcrTextForFile', args]);
        return 1;
      },
    },
    exams: {
      applyMultimodalIndexState: record(examCalls)('applyMultimodalIndexState'),
    },
    indexStates: {
      setMmIndexState: record(stateCalls)('setMmIndexState'),
      markMmFailed: record(stateCalls)('markMmFailed'),
    },
  } as unknown as VfsReposService;
  // Fallback SQL must never run when the owner is bound; `run` throws if it is.
  const db = {
    pluck: (sql: string) => {
      if (sql.includes('FROM exam_sheets')) return 'res_exam';
      if (sql.includes('FROM files')) return 'res_tb';
      return null;
    },
    run: () => { throw new Error('local SQL fallback must not run with a bound owner'); },
  } as unknown as SqlExecutor;
  bindVfsTableOwners(db, repos);
  dbs.push(db);
  return { db, fileCalls, resourceCalls, examCalls, stateCalls, repos };
}

afterEach(() => {
  while (dbs.length > 0) unbindVfsTableOwners(dbs.pop()!);
});

describe('L11 PDF/media owner writes', () => {
  it('forwards every files/document setter with the Rust parameters', () => {
    const { db, fileCalls } = ownerHarness();

    updateExtractedTextRow(db, 'file_1', 'page text', 3);
    updatePreviewJsonRow(db, 'file_1', '{"pages":[]}', 3);
    updatePreviewJsonOnlyRow(db, 'file_1', '{"pages":[1]}');
    updateOcrPagesJsonRow(db, 'file_1', '["ocr"]');
    updateCompressedBlobHashRow(db, 'file_1', 'sha-compressed');
    setProcessingProgressJson(db, 'file_1', '{"percent":10}');
    updateProcessingStatusRow(db, 'file_1', 'ocr_processing', '{"percent":10}', null, 123, null);
    setProcessingErrorRow(db, 'file_1', 'ocr failed', 456);
    expect(cancelMediaRow(db, 'file_1')).toBe(1);
    expect(markRecoveredPendingRow(db, 'file_1')).toBe(1);

    expect(fileCalls).toEqual([
      ['updatePdfExtractedText', [db, 'file_1', 'page text', 3]],
      ['updatePdfPreview', [db, 'file_1', '{"pages":[]}', 3]],
      ['updatePdfPreviewOnly', [db, 'file_1', '{"pages":[1]}']],
      ['updatePdfOcrPages', [db, 'file_1', '["ocr"]']],
      ['updateCompressedBlobHash', [db, 'file_1', 'sha-compressed']],
      ['updateProcessingProgress', [db, 'file_1', '{"percent":10}']],
      ['applyProcessingStatus', [db, 'file_1', 'ocr_processing', '{"percent":10}', null, 123, null]],
      ['setProcessingError', [db, 'file_1', 'ocr failed', 456]],
      ['cancelProcessing', [db, 'file_1']],
      ['markProcessingRecovered', [db, 'file_1']],
    ]);
  });

  it('requires resources.saveOcrTextForFile and keeps rows_affected', () => {
    const { db, resourceCalls, repos } = ownerHarness();
    expect(updateResourceOcrTextForFileRow(db, 'file_1', 'recognized', repos)).toBe(1);
    expect(resourceCalls).toEqual([['saveOcrTextForFile', [db, 'file_1', 'recognized']]]);

    const missing = { resources: {} } as unknown as VfsReposService;
    expect(() => updateResourceOcrTextForFileRow(db, 'file_1', 'x', missing))
      .toThrow('L11 vfsRepo.resources.saveOcrTextForFile 未集成');
  });

  it('forwards file and exam multimodal state to their owners', () => {
    const { db, fileCalls, examCalls, stateCalls, repos } = ownerHarness();

    updateBusinessMmState(db, 'textbook', 'file_tb', 'indexed', '[{"page_index":0}]', 0, 1, repos);
    updateBusinessMmState(db, 'exam', 'exam_1', 'indexed', '[{"page_index":1}]', 1024, 1, repos);
    updateBusinessMmState(db, 'textbook', 'file_bad', 'failed', 'boom', 0, 0, repos);

    expect(fileCalls).toEqual([
      ['applyMultimodalIndexState', [db, 'file_tb', 'indexed', '[{"page_index":0}]']],
      ['applyMultimodalIndexState', [db, 'file_bad', 'failed', 'boom']],
    ]);
    expect(examCalls).toEqual([
      ['applyMultimodalIndexState', [db, 'exam_1', 'indexed', '[{"page_index":1}]', 1024]],
    ]);
    // Resource-side state stays on the already-published indexStates owner.
    expect(stateCalls).toEqual([
      ['setMmIndexState', [db, 'res_tb', 'indexed', null]],
      ['setMmIndexState', [db, 'res_exam', 'indexed', null]],
      ['markMmFailed', [db, 'res_tb', 'boom']],
    ]);
  });

  it('requires every files/media setter instead of writing the owner table locally', () => {
    const db = {} as SqlExecutor;
    const attempts: Array<[string, () => unknown]> = [
      ['cancelProcessing', () => cancelMediaRow(db, 'file_1')],
      ['markProcessingRecovered', () => markRecoveredPendingRow(db, 'file_1')],
      ['setProcessingError', () => setProcessingErrorRow(db, 'file_1', 'boom', 1)],
      ['updatePdfExtractedText', () => updateExtractedTextRow(db, 'file_1', 'text', 1)],
      ['updatePdfPreview', () => updatePreviewJsonRow(db, 'file_1', '{}', 1)],
      ['updatePdfPreviewOnly', () => updatePreviewJsonOnlyRow(db, 'file_1', '{}')],
      ['updatePdfOcrPages', () => updateOcrPagesJsonRow(db, 'file_1', '[]')],
      ['updateCompressedBlobHash', () => updateCompressedBlobHashRow(db, 'file_1', 'sha')],
      ['updateProcessingProgress', () => setProcessingProgressJson(db, 'file_1', '{}')],
      ['applyProcessingStatus',
        () => updateProcessingStatusRow(db, 'file_1', 'indexing', '{}', null, 1, null)],
    ];
    for (const [method, call] of attempts) {
      expect(call, method).toThrow(`L11 vfsRepo.files.${method} 未集成`);
    }

    const repos = { files: {}, exams: {} } as unknown as VfsReposService;
    expect(() => updateBusinessMmState(db, 'textbook', 'file_1', 'indexed', null, 0, 1, repos))
      .toThrow('L11 vfsRepo.files.applyMultimodalIndexState 未集成');
    expect(() => updateBusinessMmState(db, 'exam', 'exam_1', 'indexed', null, 768, 1, repos))
      .toThrow('L11 vfsRepo.exams.applyMultimodalIndexState 未集成');
  });

  it('uses the exact conditional OCR cache owner or reports the missing capability', () => {
    const calls: Array<[string, unknown[]]> = [];
    const resources = {
      saveOcrText: (...args: unknown[]) => { calls.push(['saveOcrText', args]); },
    };
    const withoutExact = {
      resources,
      indexStates: {},
    } as unknown as VfsReposService;
    // Rust indexing.rs:1082/3485 must stay atomic and must not update updated_at;
    // without that exact setter L12 reports failure and leaves the cache untouched.
    expect(() => saveResourceOcrText({} as SqlExecutor, 'res_1', 'cached', true, withoutExact))
      .toThrow('L11 vfsRepo.resources.saveOcrTextIfEmptyWithConn 未集成');
    expect(calls).toEqual([]);

    const exact: unknown[] = [];
    const withExact = {
      resources: {
        ...resources,
        saveOcrTextIfEmptyWithConn: (...args: unknown[]) => { exact.push(args); },
      },
      indexStates: {},
    } as unknown as VfsReposService;
    const db = {} as SqlExecutor;
    saveResourceOcrText(db, 'res_1', 'cached', true, withExact);
    expect(exact).toEqual([[db, 'res_1', 'cached']]);
    expect(calls).toEqual([]);

    saveResourceOcrText(db, 'res_1', 'unconditional', false, withExact);
    expect(calls).toEqual([['saveOcrText', [db, 'res_1', 'unconditional']]]);
  });

  it('uses the exact image-OCR cache owner or reports the missing capability', () => {
    const db = {} as SqlExecutor;
    const exact: unknown[] = [];
    const withoutExact = {
      resources: {
        saveOcrText: () => { throw new Error('saveOcrText must not stand in for a no-timestamp write'); },
      },
    } as unknown as VfsReposService;
    // Rust indexing.rs:3354/3949 do not touch updated_at; without the exact
    // owner method the cache attempt must fail rather than report false success.
    expect(() => updateResourceOcrTextWithoutTimestamp(db, 'res_1', 'image text', withoutExact))
      .toThrow('L11 vfsRepo.resources.saveOcrTextWithoutTimestampWithConn 未集成');
    expect(exact).toEqual([]);

    const withExact = {
      resources: {
        saveOcrTextWithoutTimestampWithConn: (...args: unknown[]) => { exact.push(args); },
      },
    } as unknown as VfsReposService;
    updateResourceOcrTextWithoutTimestamp(db, 'res_1', 'image text', withExact);
    expect(exact).toEqual([[db, 'res_1', 'image text']]);
  });
});
