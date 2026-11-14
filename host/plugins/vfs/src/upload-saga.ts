/** vfs/upload_saga.rs. Use `using` or finally/dispose for Rust Drop's warning. */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { vfsRepositories } from '../repository/services.ts';
import type { UploadLog } from '../repository/upload-saga.ts';
import { VfsRepositoryError } from '../../vfs-repos/api.ts';

export class UploadSaga {
  private refs: string[] = [];
  private committed = false;
  private readonly log: UploadLog;
  constructor(log: UploadLog) { this.log = log; }
  recordBlobRef(hash: string): void { this.refs.push(hash); }
  recordPreviewBlobs(preview: { pages: readonly { blobHash: string; compressedBlobHash?: string | null }[] }): void {
    for (const page of preview.pages) {
      this.recordBlobRef(page.blobHash);
      if (page.compressedBlobHash != null && page.compressedBlobHash !== page.blobHash) this.recordBlobRef(page.compressedBlobHash);
    }
  }
  commit(): void { this.committed = true; this.refs = []; }
  abort(conn: SqlExecutor, blobsDir: string): void {
    if (this.committed) return;
    const refs = this.refs; this.refs = [];
    if (refs.length === 0) return;
    this.log.info('[VFS::UploadSaga] Aborting upload, compensating %s blob ref(s)', refs.length);
    const repo = vfsRepositories().blobs;
    for (const hash of refs.reverse()) {
      try { repo.decrementRef(conn, hash); }
      catch (error) {
        if (error instanceof VfsRepositoryError && error.code === 'VFS_NOT_FOUND') {
          this.log.debug('[VFS::UploadSaga] Blob %s already gone during compensation', hash.slice(0, 16));
        } else {
          this.log.warn('[VFS::UploadSaga] Failed to decrement blob %s during compensation: %s (left to background sweep)', hash.slice(0, 16), error);
        }
        continue;
      }
      try { repo.cleanupBlob(conn, blobsDir, hash); }
      catch (error) {
        this.log.warn('[VFS::UploadSaga] Failed to cleanup blob %s during compensation: %s (left to background sweep)', hash.slice(0, 16), error);
      }
    }
  }
  dispose(): void {
    if (!this.committed && this.refs.length > 0) this.log.warn(
      '[VFS::UploadSaga] Dropped with %s uncompensated blob ref(s); caller missed commit()/abort()', this.refs.length);
  }
  [Symbol.dispose](): void { this.dispose(); }
}
