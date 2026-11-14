// cmd/notes.rs::notes_db_stats: VFS file size, row counts and notes_assets scan.
import { notesLog } from './log.ts';
import { join } from '../../../platform/util/path.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { notesLocalRuntime } from '../src/local-runtime.ts';

export interface NotesDbStats {
  db_path: string;
  file_size_bytes: number;
  total_notes: number;
  total_versions: number;
  total_assets: number;
  total_asset_bytes: number;
}

/** Rust ignores a missing/unreadable database file and a failed notes count. */
export function notesDbStats(handle: DatabaseHandle, activeDir: string): NotesDbStats {
  let fileSize = 0;
  try {
    fileSize = notesLocalRuntime().stat(handle.path).size;
  } catch (error) {
    notesLog.warn(`[notes] cannot stat VFS database ${handle.path}: ${String(error)}`);
  }
  let totalNotes = 0;
  try {
    totalNotes = Number(handle.get<{ count: number }>('SELECT COUNT(*) AS count FROM notes')?.count ?? 0);
  } catch (error) {
    notesLog.warn(`[notes] cannot count notes: ${String(error)}`);
  }
  const totalVersions = Number(handle.get<{ count: number }>('SELECT COUNT(*) AS count FROM note_document_revisions')?.count ?? 0);
  const assets = scanAssets(join(activeDir, 'notes_assets'));
  return {
    db_path: handle.path,
    file_size_bytes: fileSize,
    total_notes: totalNotes,
    total_versions: totalVersions,
    total_assets: assets.count,
    total_asset_bytes: assets.bytes,
  };
}

function scanAssets(root: string): { count: number; bytes: number } {
  let count = 0;
  let bytes = 0;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let children: string[];
    try {
      children = notesLocalRuntime().readDirNames(dir);
    } catch {
      continue;
    }
    for (const child of children) {
      const path = join(dir, child);
      let info;
      try {
        info = notesLocalRuntime().stat(path);
      } catch {
        continue;
      }
      if (info.kind === 'directory') stack.push(path);
      else if (info.kind === 'file') {
        count += 1;
        bytes += info.size;
      }
    }
  }
  return { count, bytes };
}
