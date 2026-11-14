import type {
  ChatAnkiApkgVfs, ChatAnkiResolvedApkgFile, ChatAnkiVfsFile,
} from '../api.ts';

interface FileEntry {
  file: ChatAnkiVfsFile;
  blob: Uint8Array | null;
  originalBytes: Uint8Array | null;
  originalSize: number | null;
}

/** In-memory L11 VFS file/blob table used by the APKG resolution contract tests. */
export class ApkgVfsDouble implements ChatAnkiApkgVfs {
  private readonly files = new Map<string, FileEntry>();
  private readonly blobs = new Map<string, Uint8Array>();
  readCount = 0;

  addFile(
    file: ChatAnkiVfsFile,
    options: { blob?: Uint8Array; originalBytes?: Uint8Array; originalSize?: number } = {},
  ): void {
    const blob = options.blob ?? null;
    if (blob !== null && file.blobHash !== null) this.blobs.set(file.blobHash, blob);
    this.files.set(file.id, {
      file: { ...file },
      blob,
      originalBytes: options.originalBytes ?? null,
      originalSize: options.originalSize
        ?? (options.originalBytes === undefined ? null : options.originalBytes.length),
    });
  }

  setOriginalBytes(path: string, bytes: Uint8Array): void {
    const entry = this.findByPath(path);
    if (entry === undefined) throw new Error(`missing original path: ${path}`);
    entry.originalBytes = bytes;
    entry.originalSize = bytes.length;
  }

  resolveApkgFile(rawResourceId: string): ChatAnkiResolvedApkgFile | null {
    const direct = this.files.get(rawResourceId);
    if (direct !== undefined) return { resourceId: rawResourceId, file: { ...direct.file } };
    for (const entry of this.files.values()) {
      if (entry.file.resourceId === rawResourceId) {
        return { resourceId: entry.file.id, file: { ...entry.file } };
      }
    }
    return null;
  }

  readBlob(hash: string): Uint8Array | null {
    return this.blobs.get(hash) ?? null;
  }

  statFile(path: string): { size: number } | null {
    const entry = this.findByPath(path);
    if (entry === undefined || entry.originalSize === null) return null;
    return { size: entry.originalSize };
  }

  isFile(path: string): boolean {
    return this.findByPath(path) !== undefined;
  }

  isVirtualUri(path: string): boolean {
    return path.startsWith('vfs://');
  }

  readFile(path: string): Uint8Array {
    this.readCount += 1;
    const entry = this.findByPath(path);
    if (entry === undefined || entry.originalBytes === null) {
      throw new Error(`missing original bytes: ${path}`);
    }
    return entry.originalBytes;
  }

  private findByPath(path: string): FileEntry | undefined {
    for (const entry of this.files.values()) {
      if (entry.file.originalPath === path) return entry;
    }
    return undefined;
  }
}
