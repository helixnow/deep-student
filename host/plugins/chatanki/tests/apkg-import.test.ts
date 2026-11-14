import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import type {
  ChatAnkiApkgImportResult, ChatAnkiSessionResourceLookup, ChatAnkiVfsFile, ContextRef,
} from '../api.ts';
import { ChatAnkiApkgError } from '../api.ts';
import {
  MAX_APKG_ARCHIVE_BYTES, apkgImportResultForTool, resolveApkgResourceBytes,
  verifyApkgResourceInSessionContext,
} from '../src/apkg-import.ts';
import { fsrsImportChangedPayload } from '../src/review-payloads.ts';
import { ApkgVfsDouble } from './apkg-vfs-double.ts';

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function makeFile(overrides: Partial<ChatAnkiVfsFile> & { id: string }): ChatAnkiVfsFile {
  return {
    resourceId: null, fileName: 'cards.apkg', size: 0, sha256: '',
    blobHash: null, originalPath: null, ...overrides,
  };
}

function errorCodeOf(thunk: () => unknown): { type: string; errorCode: string } {
  try {
    thunk();
  } catch (caught) {
    if (caught instanceof ChatAnkiApkgError) {
      return { type: caught.type, errorCode: caught.errorCode };
    }
    throw caught;
  }
  throw new Error('expected ChatAnkiApkgError');
}

it('test_chatanki_import_apkg_rejects_resource_from_another_session_context', () => {
  const ownerRefs: ContextRef[] = [
    { resourceId: 'file_current.apkg', hash: 'hash-file', typeId: 'file' },
    { resourceId: 'res_current_apkg', hash: 'hash-resource', typeId: 'file' },
  ];
  const lookup: ChatAnkiSessionResourceLookup = {
    resolveSessionUserRefs(sessionId, resourceIds) {
      if (sessionId !== 'session-resource-owner') return null;
      return ownerRefs.filter((ref) => resourceIds.includes(ref.resourceId));
    },
  };

  expect(() => verifyApkgResourceInSessionContext(
    lookup, 'session-resource-owner', 'file_current.apkg',
  )).not.toThrow();
  expect(() => verifyApkgResourceInSessionContext(
    lookup, 'session-resource-owner', 'res_current_apkg',
  )).not.toThrow();

  expect(errorCodeOf(() => verifyApkgResourceInSessionContext(
    lookup, 'session-resource-other', 'file_current.apkg',
  ))).toEqual({ type: 'NotFound', errorCode: 'apkg_not_found' });
});

it('test_chatanki_import_apkg_resolves_file_attachment_and_resource_ids', () => {
  const vfs = new ApkgVfsDouble();
  const originalBytes = new Uint8Array(Buffer.from('original-apkg-bytes'));
  const blobBytes = new Uint8Array(Buffer.from('blob-fallback-bytes'));
  vfs.addFile(
    makeFile({
      id: 'file_apkg_direct', resourceId: 'res_apkg_direct', fileName: 'cards.apkg',
      size: 19, sha256: 'sha-file-apkg', blobHash: 'blob-hash',
      originalPath: '/tmp/cards.apkg',
    }),
    { blob: blobBytes, originalBytes },
  );

  const direct = resolveApkgResourceBytes(vfs, 'file_apkg_direct');
  expect(direct.sourceName).toBe('cards.apkg');
  expect(direct.bytes).toEqual(blobBytes);

  vfs.setOriginalBytes(
    '/tmp/cards.apkg', new Uint8Array(Buffer.from('replaced-original-bytes')),
  );
  const afterOriginalChange = resolveApkgResourceBytes(vfs, 'file_apkg_direct');
  expect(afterOriginalChange.bytes).toEqual(blobBytes);

  const indirect = resolveApkgResourceBytes(vfs, 'res_apkg_direct');
  expect(indirect.bytes).toEqual(blobBytes);

  const attachmentBytes = new Uint8Array(Buffer.from('attachment-apkg-bytes'));
  vfs.addFile(
    makeFile({
      id: 'att_apkg_test', resourceId: 'res_att_apkg_test',
      fileName: 'attachment.apkg', size: 21, sha256: 'sha-att-apkg',
      blobHash: 'attachment-blob', originalPath: null,
    }),
    { blob: attachmentBytes },
  );
  const attachment = resolveApkgResourceBytes(vfs, 'att_apkg_test');
  expect(attachment.sourceName).toBe('attachment.apkg');
  expect(attachment.bytes).toEqual(attachmentBytes);
});

it('test_chatanki_import_apkg_original_only_requires_recorded_sha256_match', () => {
  const vfs = new ApkgVfsDouble();
  const originalBytes = new Uint8Array(Buffer.from('verified-original-only-apkg'));
  vfs.addFile(
    makeFile({
      id: 'file_original_only', fileName: 'original-only.apkg',
      size: originalBytes.length, sha256: sha256Hex(originalBytes),
      blobHash: null, originalPath: '/tmp/original-only.apkg',
    }),
    { originalBytes },
  );

  const resolved = resolveApkgResourceBytes(vfs, 'file_original_only');
  expect(resolved.bytes).toEqual(originalBytes);

  vfs.setOriginalBytes(
    '/tmp/original-only.apkg', new Uint8Array(Buffer.from('tampered-original-only-apkg')),
  );
  expect(errorCodeOf(() => resolveApkgResourceBytes(vfs, 'file_original_only')))
    .toEqual({ type: 'Validation', errorCode: 'apkg_resource_mismatch' });
});

it('test_chatanki_import_apkg_rejects_oversized_vfs_file_before_allocation', () => {
  const vfs = new ApkgVfsDouble();
  vfs.addFile(
    makeFile({
      id: 'file_oversized', fileName: 'oversized.apkg', size: 0,
      sha256: 'sha-oversized-apkg', blobHash: null,
      originalPath: '/tmp/oversized.apkg',
    }),
    { originalSize: MAX_APKG_ARCHIVE_BYTES + 1 },
  );

  expect(errorCodeOf(() => resolveApkgResourceBytes(vfs, 'file_oversized')))
    .toEqual({ type: 'Validation', errorCode: 'apkg_limit_exceeded' });
  expect(vfs.readCount).toBe(0);
});

it('test_chatanki_import_apkg_result_and_domain_event_contract', () => {
  const result: ChatAnkiApkgImportResult = {
    documentId: 'doc-imported', importedCards: 2, importedTemplates: 0,
    mediaSkipped: 1, mediaImported: 0,
    mediaReport: {
      declared: 1, imported: 0, skipped: 1, mediaDir: null,
      skips: [{ reason: 'entry_missing', count: 1, filenames: ['a.png'] }],
    },
    warnings: [], cardIds: ['card-a', 'card-b'], reviewEnqueue: null,
  };
  expect(apkgImportResultForTool(result)).toEqual({
    documentId: 'doc-imported',
    importedCards: 2,
    importedTemplates: 0,
    mediaSkipped: 1,
    mediaImported: 0,
    mediaReport: {
      declared: 1,
      imported: 0,
      skipped: 1,
      skips: [{ reason: 'entry_missing', count: 1, filenames: ['a.png'] }],
    },
  });

  const payload = fsrsImportChangedPayload(
    result.documentId, result.cardIds, 'run-import',
  );
  expect(payload.action).toBe('import');
  expect(payload.documentId).toBe('doc-imported');
  expect(payload.entityIds).toEqual(['card-a', 'card-b']);
  expect(payload.runId).toBe('run-import');
});
