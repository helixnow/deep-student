import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  DOUBLE_ENCODED_VIRTUAL_URI_REJECTED,
  PENDING_SAF_PERSIST_DIR,
  PENDING_SAF_PERSIST_FILE,
  isVirtualUri,
  persistableSafQueueFile,
  queuePersistableSafUri,
  rejectDoubleEncodedVirtualUri,
  sanitizeForLegacy,
} from '../../../platform/storage/unified-file-manager.ts';

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l22-saf-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// sync_r10_android.rs::content_uri_and_saf_paths_classify_as_virtual
it('content_uri_and_saf_paths_classify_as_virtual', () => {
  const virtualInputs = [
    'content://com.android.externalstorage.documents/document/primary%3ADownload%2Fbackup.zip',
    'content://com.android.providers.downloads.documents/document/446',
    'CONTENT://authority/document/1',
    '  content://authority/document/2',
    'primary:Download/QQ/backup.zip',
    'secondary:Backups/backup.zip',
    'raw:/storage/emulated/0/Download/backup.zip',
    'asset://bundle/file.pdf',
    'ph://ABCD-1234/L0/001',
  ];
  for (const input of virtualInputs) expect(isVirtualUri(input), `must be virtual: ${input}`).toBe(true);

  const localInputs = [
    '/storage/emulated/0/Download/backup.zip',
    '/home/student/backup.zip',
    'C:\\Users\\alice\\Documents\\backup.zip',
    'file:///home/student/backup.zip',
    './relative/backup.zip',
    '',
  ];
  for (const input of localInputs) expect(isVirtualUri(input), `must be local: ${input}`).toBe(false);
});

// sync_r10_android.rs::double_encoded_content_uri_is_not_classified_virtual
it('double_encoded_content_uri_is_not_classified_virtual', () => {
  const doubleEncoded = 'content%3A%2F%2Fcom.android.externalstorage.documents%2Fdocument%2Fprimary%3Abackup.zip';
  expect(isVirtualUri(doubleEncoded)).toBe(false);
  expect(() => rejectDoubleEncodedVirtualUri(doubleEncoded)).toThrow(DOUBLE_ENCODED_VIRTUAL_URI_REJECTED);
});

// sync_r10_android.rs::rust_side_must_queue_content_uri_for_main_activity_persist
it('rust_side_must_queue_content_uri_for_main_activity_persist', () => {
  const dir = tempDir();
  const content = 'content://com.android.externalstorage.documents/document/primary%3ADownload%2Fbackup.zip';
  queuePersistableSafUri(dir, content);
  expect(fs.readFileSync(persistableSafQueueFile(dir, content), 'utf8')).toBe(content);
  expect(PENDING_SAF_PERSIST_FILE).toBe('pending_saf_persist.uri');
  expect(PENDING_SAF_PERSIST_DIR).toBe('pending_saf_persist');
});

// sync_r10_android.rs::legacy_sanitizer_preserves_content_uri_encoding_but_decodes_local_paths
it('legacy_sanitizer_preserves_content_uri_encoding_but_decodes_local_paths', () => {
  const contentUri = 'content://com.android.externalstorage.documents/document/primary%3ADownload%2Fbackup.zip';
  expect(sanitizeForLegacy(contentUri)).toBe(contentUri);
  expect(sanitizeForLegacy('file:///home/student/my%20notes.pdf')).toBe('/home/student/my notes.pdf');
});
