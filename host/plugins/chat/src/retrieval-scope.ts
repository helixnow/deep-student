/** Rust session_scope.rs:9-25: all connection/SQL/JSON failures are None, not command errors. */
import type { ChatV2Database } from '../api.ts';
import { loadBackendRagScope } from '../repository/session-state.ts';

export function loadSessionRagScope(database: ChatV2Database, sessionId: string): string[] | null {
  try { return loadBackendRagScope(database.getConnSafe(), sessionId); }
  catch { return null; }
}
