/** vfs/attachment_config.rs. memory_config writes belong to L17. */
import type { VfsDatabase } from '../api.ts';
import { VfsError } from './error.ts';
import { createFolderRecord } from '../repository/folders.ts';
import { vfsRepositories } from '../repository/services.ts';
export const ATTACHMENT_ROOT_FOLDER_KEY = 'attachment_root_folder_id';
export const DEFAULT_ATTACHMENT_FOLDER_TITLE = '附件';
/** Required L17 memoryConfig surface. set must use SQLite datetime('now') for updated_at. */
export interface AttachmentConfigStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}
interface AttachmentLog {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
}
export class AttachmentConfig {
  private readonly database: VfsDatabase;
  private readonly store: () => AttachmentConfigStore;
  private readonly log: AttachmentLog;
  constructor(database: VfsDatabase, store: () => AttachmentConfigStore, log: AttachmentLog) {
    this.database = database;
    this.store = store;
    this.log = log;
  }
  getRootFolderId(): string | null {
    // Resolve the dependency first: missing owner service is not a failed SQLite query.
    const store = this.store();
    try { return store.get(ATTACHMENT_ROOT_FOLDER_KEY) || null; }
    catch { return null; }
  }
  setRootFolderId(id: string): void {
    this.store().set(ATTACHMENT_ROOT_FOLDER_KEY, id);
    this.log.debug('[Attachment::Config] Set %s = %s', ATTACHMENT_ROOT_FOLDER_KEY, id);
  }
  getOrCreateRootFolder(): string {
    const id = this.getRootFolderId();
    if (id !== null) {
      if (vfsRepositories().folders.folderExists(this.database.getConnSafe(), id)) {
        this.log.debug('[Attachment::Config] Using existing root folder: %s', id);
        return id;
      }
      this.log.warn('[Attachment::Config] Configured folder %s not found, creating new one', id);
    }
    return this.createFolder(DEFAULT_ATTACHMENT_FOLDER_TITLE, true);
  }
  createRootFolder(title: string): string { return this.createFolder(title, false); }
  private createFolder(title: string, defaultFolder: boolean): string {
    const folder = createFolderRecord(title);
    vfsRepositories().folders.createFolder(this.database.getConnSafe(), folder);
    this.setRootFolderId(folder.id);
    this.log.info(defaultFolder ? '[Attachment::Config] Created default attachment folder: %s (%s)'
      : '[Attachment::Config] Created attachment root folder: %s (%s)', title, folder.id);
    return folder.id;
  }
  getRootFolderTitle(): string | null {
    const id = this.getRootFolderId();
    return id === null ? null : vfsRepositories().folders.getFolder(this.database.getConnSafe(), id)?.title ?? null;
  }
}
export function requireAttachmentConfigStore(store: AttachmentConfigStore | undefined): AttachmentConfigStore {
  if (!store) throw new VfsError('Other', 'memoryConfig is required for attachment configuration');
  return store;
}
