// note_lease_repo.rs: notes-only cross-WebView freeze barrier and transactional
// write fence. ACKs compare typed complete Markdown drafts, never serialized maps.
const randomUUID = () => globalThis.crypto.randomUUID();
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type {
  FrozenDraft, LeaseCancellation, LeaseNote, LeaseStatus, ParticipantStatus,
} from '../../../../contracts/ipc/generated/L10-notes.ts';
import type { NoteLeaseAuth } from '../../../../contracts/ipc/generated/_shared.ts';
import { conflict, invalid } from './errors.ts';
import { decodeJson } from './json.ts';
import { noteRepository } from './notes.ts';
import { noteRevisionRepository } from './revisions.ts';
import { noteTransaction } from './transaction.ts';
import { rustTrim } from '../../../platform/util/index.ts';

export const PARTICIPANT_TTL = 45;
export const LEASE_TTL = 30;

function tokenId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function participant(conn: SqlExecutor, id: string, webview: string, now: number): string {
  const row = conn.get<{ note_id: string }>(
    'SELECT note_id FROM note_editor_participants WHERE id=?1 AND webview_label=?2 AND expires_at>?3',
    [id, webview, now]);
  if (row === undefined) conflict('notes.participant_expired');
  return row.note_id;
}

function status(conn: SqlExecutor, token: string): LeaseStatus | null {
  const row = conn.get<{ operation_id: string; owner_id: string; phase: string; expires_at: number }>(
    'SELECT operation_id,owner_id,phase,expires_at FROM note_editor_leases WHERE token=?1', [token]);
  if (row === undefined) return null;
  const notes = conn.all<LeaseNote>(
    `SELECT ln.note_id,n.updated_at FROM note_editor_lease_notes ln
       JOIN notes n ON n.id=ln.note_id WHERE ln.token=?1 ORDER BY ln.note_id`, [token]);
  const waitingFor = conn.all<{ participant_id: string }>(
    `SELECT participant_id FROM note_editor_lease_acks WHERE token=?1
       AND CASE WHEN ?2='refreshing' THEN refreshed=0 ELSE draft_json IS NULL END
     ORDER BY participant_id`, [token, row.phase]).map((entry) => entry.participant_id);
  return {
    token,
    operation_id: row.operation_id,
    owner_id: row.owner_id,
    phase: row.phase,
    expires_at: Number(row.expires_at),
    notes,
    waiting_for: waitingFor,
  };
}

function required(conn: SqlExecutor, token: string, now: number): LeaseStatus {
  const current = status(conn, token);
  if (current === null) conflict('notes.lease_expired');
  const dead = Number(conn.get<{ present: number }>(
    `SELECT EXISTS(SELECT 1 FROM note_editor_lease_acks a
       LEFT JOIN note_editor_participants p ON p.id=a.participant_id
     WHERE a.token=?1 AND (p.id IS NULL OR p.expires_at<=?2)) AS present`, [token, now])?.present ?? 0) !== 0;
  if (current.expires_at <= now || dead) conflict('notes.lease_expired');
  return current;
}

function owned(conn: SqlExecutor, auth: NoteLeaseAuth, webview: string, now: number): LeaseStatus {
  participant(conn, auth.participant_id, webview, now);
  const current = required(conn, auth.token, now);
  if (current.owner_id !== auth.participant_id) conflict('notes.lease_owner_mismatch');
  return current;
}

function remove(conn: SqlExecutor, token: string, reason: string): LeaseCancellation {
  const current = status(conn, token);
  conn.run('DELETE FROM note_editor_lease_acks WHERE token=?1', [token]);
  conn.run('DELETE FROM note_editor_lease_notes WHERE token=?1', [token]);
  conn.run('DELETE FROM note_editor_write_grants WHERE token=?1', [token]);
  conn.run('DELETE FROM note_editor_leases WHERE token=?1', [token]);
  return {
    token,
    note_ids: current === null ? [] : current.notes.map((note) => note.note_id),
    reason,
  };
}

function cleanup(
  conn: SqlExecutor,
  now: number | bigint,
  window: string | null,
  webview: string | null,
): LeaseCancellation[] {
  return noteTransaction(conn, () => {
    conn.run('DELETE FROM note_editor_participants WHERE expires_at<=?1 OR window_label=?2 OR webview_label=?3',
      [now, window, webview]);
    const tokens = conn.all<{ token: string }>(
      `SELECT token FROM note_editor_leases l WHERE expires_at<=?1
         OR NOT EXISTS(SELECT 1 FROM note_editor_participants p WHERE p.id=l.owner_id)
         OR EXISTS(SELECT 1 FROM note_editor_lease_acks a WHERE a.token=l.token
           AND NOT EXISTS(SELECT 1 FROM note_editor_participants p WHERE p.id=a.participant_id))`,
      [now]).map((row) => row.token);
    return tokens.map((token) => remove(conn, token, 'participant_closed_or_expired'));
  });
}

/** serde_json::from_str::<FrozenDraft>; parse/shape errors become VfsError::InvalidArgument. */
function frozenDraft(raw: string): FrozenDraft {
  let parsed: unknown;
  try {
    parsed = decodeJson(raw);
  } catch (error) {
    invalid(error instanceof Error ? error.message : String(error));
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    invalid(`invalid type: ${parsed === null ? 'null' : typeof parsed}, expected struct FrozenDraft`);
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.markdown !== 'string') invalid('invalid type: expected a string for markdown');
  if (typeof record.expected_updated_at !== 'string') {
    invalid('invalid type: expected a string for expected_updated_at');
  }
  return { markdown: record.markdown, expected_updated_at: record.expected_updated_at };
}

export const noteLeaseRepository = {
  now: nowSeconds,
  participant,
  status,
  required,
  owned,
  remove,

  register(conn: SqlExecutor, noteId: string, webview: string, window: string, now: number): ParticipantStatus {
    return noteTransaction(conn, () => {
      if (noteRepository.getNote(noteId, conn) === null) invalid('Note missing');
      const id = tokenId('nep');
      conn.run('INSERT INTO note_editor_participants VALUES(?1,?2,?3,?4,?5)',
        [id, webview, window, noteId, now + PARTICIPANT_TTL]);
      const token = conn.get<{ token: string }>(
        'SELECT token FROM note_editor_lease_notes WHERE note_id=?1', [noteId])?.token ?? null;
      let activeLease: LeaseStatus | null = null;
      if (token !== null) {
        conn.run('INSERT INTO note_editor_lease_acks(token,participant_id) VALUES(?1,?2)', [token, id]);
        // A new editor joins the barrier before any subsequent flush/commit.
        conn.run(`UPDATE note_editor_leases SET phase='pending',expires_at=MIN(expires_at,?2)
          WHERE token=?1 AND phase='ready'`, [token, now + LEASE_TTL]);
        activeLease = status(conn, token);
      }
      return { participant_id: id, expires_at: now + PARTICIPANT_TTL, active_lease: activeLease };
    });
  },

  heartbeat(conn: SqlExecutor, id: string, webview: string, now: number): ParticipantStatus {
    return noteTransaction(conn, () => {
      const noteId = participant(conn, id, webview, now);
      conn.run('UPDATE note_editor_participants SET expires_at=?2 WHERE id=?1', [id, now + PARTICIPANT_TTL]);
      // Pending ACKs have a fixed deadline; heartbeats cannot wait forever.
      conn.run(`UPDATE note_editor_leases SET expires_at=?2
        WHERE owner_id=?1 AND expires_at>?3 AND phase!='pending'`, [id, now + LEASE_TTL, now]);
      const token = conn.get<{ token: string }>(
        'SELECT token FROM note_editor_lease_notes WHERE note_id=?1', [noteId])?.token ?? null;
      return {
        participant_id: id,
        expires_at: now + PARTICIPANT_TTL,
        active_lease: token === null ? null : status(conn, token),
      };
    });
  },

  begin(
    conn: SqlExecutor,
    owner: string,
    webview: string,
    operationId: string,
    noteIds: readonly string[],
    now: number,
  ): LeaseStatus {
    return noteTransaction(conn, () => {
      participant(conn, owner, webview, now);
      const ids = [...new Set(noteIds)].sort();
      if (ids.length === 0 || rustTrim(operationId).length === 0) {
        invalid('Operation and note IDs required');
      }
      const existing = conn.get<{ token: string }>(
        'SELECT token FROM note_editor_leases WHERE operation_id=?1', [operationId])?.token;
      if (existing !== undefined) {
        const current = owned(conn, { participant_id: owner, token: existing }, webview, now);
        const leased = [...new Set(current.notes.map((note) => note.note_id))].sort();
        if (leased.length !== ids.length || leased.some((id, index) => id !== ids[index])) {
          conflict('notes.lease_operation_mismatch');
        }
        return current;
      }
      const token = tokenId('nel');
      conn.run("INSERT INTO note_editor_leases VALUES(?1,?2,?3,'pending',?4)",
        [token, operationId, owner, now + LEASE_TTL]);
      for (const id of ids) {
        if (noteRepository.getNote(id, conn) === null) invalid('Note missing');
        if (Number(conn.get<{ present: number }>(
          'SELECT EXISTS(SELECT 1 FROM note_editor_lease_notes WHERE note_id=?1) AS present', [id])?.present ?? 0) !== 0) {
          conflict('notes.lease_conflict');
        }
        conn.run('INSERT INTO note_editor_lease_notes VALUES(?1,?2)', [id, token]);
        conn.run(`INSERT INTO note_editor_lease_acks(token,participant_id)
          SELECT ?1,id FROM note_editor_participants WHERE note_id=?2 AND expires_at>?3`,
        [token, id, now]);
      }
      // The owner must be among the editors covered by this lease.
      if (Number(conn.get<{ present: number }>(
        'SELECT EXISTS(SELECT 1 FROM note_editor_lease_acks WHERE token=?1 AND participant_id=?2) AS present',
        [token, owner])?.present ?? 0) === 0) {
        invalid('Owner note must be in note_ids');
      }
      const created = status(conn, token);
      if (created === null) invalid('Lease missing');
      return created;
    });
  },

  ack(conn: SqlExecutor, auth: NoteLeaseAuth, webview: string, draft: FrozenDraft, now: number): LeaseStatus {
    return noteTransaction(conn, () => {
      const noteId = participant(conn, auth.participant_id, webview, now);
      const current = required(conn, auth.token, now);
      if (current.phase !== 'pending' && current.phase !== 'ready') conflict('notes.lease_phase');
      const note = noteRepository.getNote(noteId, conn);
      if (note === null) invalid('Note missing');
      if (draft.expected_updated_at !== note.updatedAt) conflict('notes.lease_stale_draft');
      // ACKs are immutable until flush updates their agreed OCC baseline.
      const previous = conn.all<{ draft_json: string }>(
        `SELECT a.draft_json FROM note_editor_lease_acks a
           JOIN note_editor_participants p ON p.id=a.participant_id
         WHERE a.token=?1 AND p.note_id=?2 AND a.draft_json IS NOT NULL`,
        [auth.token, noteId]);
      for (const row of previous) {
        const saved = frozenDraft(row.draft_json);
        if (saved.markdown !== draft.markdown || saved.expected_updated_at !== draft.expected_updated_at) {
          conflict('notes.lease_divergent_drafts');
        }
      }
      const raw = JSON.stringify(draft);
      if (conn.run('UPDATE note_editor_lease_acks SET draft_json=?3 WHERE token=?1 AND participant_id=?2',
        [auth.token, auth.participant_id, raw]).changes !== 1) {
        conflict('notes.lease_participant_mismatch');
      }
      conn.run(`UPDATE note_editor_leases SET phase='ready' WHERE token=?1
        AND NOT EXISTS(SELECT 1 FROM note_editor_lease_acks WHERE token=?1 AND draft_json IS NULL)`, [auth.token]);
      return required(conn, auth.token, now);
    });
  },

  /** Called inside the same savepoint as the body write; SQL triggers back raw SQL up. */
  checkWrite(conn: SqlExecutor, noteId: string): void {
    if (Number(conn.get<{ present: number }>(
      `SELECT EXISTS(SELECT 1 FROM note_editor_lease_notes ln WHERE ln.note_id=?1
         AND NOT EXISTS(SELECT 1 FROM note_editor_write_grants g WHERE g.token=ln.token)) AS present`,
      [noteId])?.present ?? 0) !== 0) {
      conflict('notes.lease_conflict');
    }
  },

  authorized<T>(
    conn: SqlExecutor,
    auth: NoteLeaseAuth,
    webview: string,
    now: number,
    commit: boolean,
    work: () => T,
  ): T {
    return noteTransaction(conn, () => {
      // Acquire SQLite's writer lock before inspecting the barrier.
      conn.run('INSERT INTO note_editor_write_grants VALUES(?1)', [auth.token]);
      const current = owned(conn, auth, webview, now);
      if (current.phase !== 'ready') conflict('notes.lease_not_ready');
      if (commit) {
        const drafts = conn.all<{ note_id: string; draft_json: string }>(
          `SELECT p.note_id,a.draft_json FROM note_editor_lease_acks a
             JOIN note_editor_participants p ON p.id=a.participant_id WHERE a.token=?1`, [auth.token]);
        for (const row of drafts) {
          const draft = frozenDraft(row.draft_json);
          const live = noteRevisionRepository.current(conn, row.note_id);
          if (live.content_md !== draft.markdown || live.updated_at !== draft.expected_updated_at) {
            conflict('notes.lease_flush_required');
          }
        }
      }
      const result = work();
      if (commit) {
        for (const note of current.notes) {
          const live = noteRevisionRepository.current(conn, note.note_id);
          const draft: FrozenDraft = {
            markdown: live.content_md,
            expected_updated_at: live.updated_at,
          };
          conn.run(`UPDATE note_editor_lease_acks SET draft_json=?3
            WHERE token=?1 AND participant_id IN (SELECT id FROM note_editor_participants WHERE note_id=?2)`,
          [auth.token, note.note_id, JSON.stringify(draft)]);
        }
      }
      conn.run('DELETE FROM note_editor_write_grants WHERE token=?1', [auth.token]);
      return result;
    });
  },

  finish(conn: SqlExecutor, auth: NoteLeaseAuth, webview: string, now: number): LeaseStatus {
    return noteTransaction(conn, () => {
      const current = owned(conn, auth, webview, now);
      if (current.phase !== 'ready') conflict('notes.lease_not_ready');
      conn.run("UPDATE note_editor_leases SET phase='refreshing',expires_at=?2 WHERE token=?1",
        [auth.token, now + LEASE_TTL]);
      return required(conn, auth.token, now);
    });
  },

  /** Flush only the exact complete draft agreed by every editor for this note. */
  flush(
    conn: SqlExecutor,
    auth: NoteLeaseAuth,
    webview: string,
    noteId: string,
    capabilities: readonly string[],
    now: number,
  ): LeaseNote {
    return this.authorized(conn, auth, webview, now, false, () => {
      const raw = conn.get<{ draft_json: string | null }>(
        `SELECT a.draft_json FROM note_editor_lease_acks a
           JOIN note_editor_participants p ON p.id=a.participant_id
         WHERE a.token=?1 AND p.note_id=?2 LIMIT 1`, [auth.token, noteId])?.draft_json ?? null;
      if (raw === null) {
        if (!required(conn, auth.token, now).notes.some((note) => note.note_id === noteId)) {
          conflict('notes.lease_scope');
        }
        const live = noteRevisionRepository.current(conn, noteId);
        return { note_id: noteId, updated_at: live.updated_at };
      }
      const draft = frozenDraft(raw);
      const live = noteRevisionRepository.current(conn, noteId);
      const note = live.content_md === draft.markdown && live.updated_at === draft.expected_updated_at
        ? noteRepository.getNote(noteId, conn)
        : noteRepository.updateNoteWithCapabilities(conn, noteId, {
          content: draft.markdown, expectedUpdatedAt: draft.expected_updated_at,
        }, capabilities);
      if (note === null || note === undefined) invalid('Note missing');
      draft.expected_updated_at = note.updatedAt;
      conn.run(`UPDATE note_editor_lease_acks SET draft_json=?3
        WHERE token=?1 AND participant_id IN (SELECT id FROM note_editor_participants WHERE note_id=?2)`,
      [auth.token, noteId, JSON.stringify(draft)]);
      return { note_id: note.id, updated_at: note.updatedAt };
    });
  },

  refreshAck(
    conn: SqlExecutor,
    auth: NoteLeaseAuth,
    webview: string,
    updatedAt: string,
    now: number,
  ): LeaseStatus {
    return noteTransaction(conn, () => {
      const noteId = participant(conn, auth.participant_id, webview, now);
      const current = required(conn, auth.token, now);
      if (current.phase !== 'refreshing') conflict('notes.lease_phase');
      if (!current.notes.some((note) => note.note_id === noteId && note.updated_at === updatedAt)) {
        conflict('notes.lease_stale_refresh');
      }
      if (conn.run('UPDATE note_editor_lease_acks SET refreshed=1 WHERE token=?1 AND participant_id=?2',
        [auth.token, auth.participant_id]).changes !== 1) {
        conflict('notes.lease_participant_mismatch');
      }
      return required(conn, auth.token, now);
    });
  },

  release(conn: SqlExecutor, auth: NoteLeaseAuth, webview: string, cancel: boolean, now: number): LeaseCancellation {
    return noteTransaction(conn, () => {
      const current = owned(conn, auth, webview, now);
      if (!cancel && (current.phase !== 'refreshing' || current.waiting_for.length > 0)) {
        conflict('notes.lease_refresh_pending');
      }
      return remove(conn, auth.token, cancel ? 'cancelled' : 'released');
    });
  },

  cleanup,

  unregister(conn: SqlExecutor, id: string, webview: string, now: number): LeaseCancellation[] {
    return noteTransaction(conn, () => {
      conn.run('DELETE FROM note_editor_participants WHERE id=?1 AND webview_label=?2', [id, webview]);
      return cleanup(conn, now, null, null);
    });
  },
};
