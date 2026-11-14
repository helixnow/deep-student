export interface CacheInputEntry { directory: boolean; mode: number; mtimeMs: number; bytes: Buffer | null }
export function snapshotCacheInput(root: string): Map<string, CacheInputEntry>;
export function sameCacheInput(before: Map<string, CacheInputEntry>, after: Map<string, CacheInputEntry>): boolean;
