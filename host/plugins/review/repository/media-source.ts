import type { SqlExecutor } from '../../../platform/storage/api.ts';

export function mediaFileName(db: SqlExecutor, fileId: string): string | null {
  try {
    const row = db.get<{ type: string; mime_type: string | null; file_name: string }>("SELECT COALESCE(type, '') AS type, mime_type, file_name FROM files WHERE id = ?1", [fileId]);
    if (!row) return null;
    const mime = (row.mime_type ?? '').replace(/[A-Z]/g, c => c.toLowerCase());
    return row.type === 'audio' || row.type === 'video' || mime.startsWith('audio/') || mime.startsWith('video/') ? row.file_name : null;
  } catch { return null; } // Rust: optional().ok().flatten().
}
