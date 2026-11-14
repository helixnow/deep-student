import { describe, expect, it } from 'vitest';
import {
  buildImportChangedPayload,
  emptyApkgMediaReport,
  serializeApkgImportResult,
  type ApkgImportResult,
} from '../src/apkg-types.ts';

function baseResult(overrides: Partial<ApkgImportResult> = {}): ApkgImportResult {
  return {
    documentId: 'document-1',
    importedCards: 2,
    importedTemplates: 0,
    mediaSkipped: 3,
    mediaImported: 1,
    mediaReport: emptyApkgMediaReport(),
    warnings: [],
    cardIds: ['card-1', 'card-2'],
    reviewEnqueue: null,
    ...overrides,
  };
}

describe('cmd/apkg_import.rs::tests', () => {
  it('import_changed_payload_uses_imported_anki_card_ids', () => {
    const result = baseResult();
    expect(buildImportChangedPayload(result)).toEqual({
      source: 'user',
      action: 'import',
      documentId: 'document-1',
      entityIds: ['card-1', 'card-2'],
    });
    expect(serializeApkgImportResult(result)).toEqual({
      documentId: 'document-1',
      importedCards: 2,
      importedTemplates: 0,
      mediaSkipped: 3,
      mediaImported: 1,
    });
  });

  it('import_result_with_warnings_serializes_them_for_frontend', () => {
    const result = baseResult({
      documentId: 'document-2',
      importedCards: 1,
      importedTemplates: 1,
      mediaSkipped: 1,
      mediaImported: 0,
      mediaReport: {
        declared: 1,
        imported: 0,
        skipped: 1,
        skips: [{ reason: 'entry_missing', count: 1, filenames: ['a.png'] }],
        mediaDir: '/tmp/anki_media',
      },
      warnings: ['媒体清单声明的条目在包内缺失，已跳过: 0 (a.png)'],
      cardIds: ['card-1'],
    });
    const value = serializeApkgImportResult(result);
    expect(value.importedTemplates).toBe(1);
    expect(value.warnings?.[0]).toContain('a.png');
    expect(value.mediaReport?.skipped).toBe(1);
    expect(value.mediaReport?.skips?.[0]?.reason).toBe('entry_missing');
    expect(value.mediaReport?.skips?.[0]?.count).toBe(1);
    expect(value.mediaReport?.skips?.[0]?.filenames?.[0]).toBe('a.png');
    expect(value.mediaReport?.mediaDir).toBe('/tmp/anki_media');
  });
});
