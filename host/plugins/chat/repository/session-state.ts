/**
 * `chat_v2_session_state` persistence. Rust source: `chat_v2/repo.rs:2650-2800`.
 */
import type { SessionState } from '../api.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { rustTrim } from '../../../platform/util/index.ts';
import { databaseOperation } from './errors.ts';
import { applySkillState } from '../src/session-skill-state.ts';
import { databaseNow } from '../src/types.ts';
import {
  chatParamsJson, panelStatesJson, serdeChatParams, serdeFeatures, serdePanelStates,
} from '../src/session-state-serde.ts';

export interface SessionStateRow {
  session_id: string;
  chat_params_json: string | null;
  features_json: string | null;
  mode_state_json: string | null;
  input_value: string | null;
  panel_states_json: string | null;
  pending_context_refs_json: string | null;
  loaded_skill_ids_json: string | null;
  active_skill_ids_json: string | null;
  skill_state_json: string | null;
  updated_at: string;
}

function parseJson<T>(value: string | null): T | undefined {
  if (value === null) return undefined;
  try { return JSON.parse(value) as T; } catch { return undefined; }
}

export function saveSessionState(db: SqlExecutor, sessionId: string, state: SessionState): void {
  const chatParams = serdeChatParams(state.chatParams);
  const features = serdeFeatures(state.features);
  const panelStates = serdePanelStates(state.panelStates);
  databaseOperation(() => {
    db.run(`INSERT INTO chat_v2_session_state (session_id, chat_params_json, features_json, mode_state_json, input_value, panel_states_json, pending_context_refs_json, loaded_skill_ids_json, active_skill_ids_json, skill_state_json, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
      ON CONFLICT(session_id) DO UPDATE SET
        chat_params_json = excluded.chat_params_json, features_json = excluded.features_json,
        mode_state_json = excluded.mode_state_json, input_value = excluded.input_value,
        panel_states_json = excluded.panel_states_json,
        pending_context_refs_json = excluded.pending_context_refs_json,
        loaded_skill_ids_json = excluded.loaded_skill_ids_json,
        active_skill_ids_json = excluded.active_skill_ids_json,
        skill_state_json = excluded.skill_state_json, updated_at = excluded.updated_at`,
    [
      sessionId,
      chatParams === undefined ? null : chatParamsJson(chatParams),
      features === undefined ? null : JSON.stringify(features),
      state.modeState === undefined || state.modeState === null ? null : JSON.stringify(state.modeState),
      state.inputValue ?? null,
      panelStates === undefined ? null : panelStatesJson(panelStates),
      state.pendingContextRefsJson ?? null,
      state.loadedSkillIdsJson ?? null,
      state.activeSkillIdsJson ?? null,
      state.skillStateJson ?? null,
      state.updatedAt,
    ]);
  });
}

export function loadSessionState(db: SqlExecutor, sessionId: string): SessionState | null {
  return databaseOperation(() => {
    const row = db.get<SessionStateRow>(`SELECT session_id, chat_params_json, features_json, mode_state_json,
      input_value, panel_states_json, pending_context_refs_json, loaded_skill_ids_json,
      active_skill_ids_json, skill_state_json, updated_at
      FROM chat_v2_session_state WHERE session_id = ?1`, [sessionId]);
    if (!row) return null;
    const state: SessionState = { sessionId: row.session_id, updatedAt: row.updated_at };
    const chatParams = serdeChatParams(parseJson<unknown>(row.chat_params_json));
    if (chatParams !== undefined) state.chatParams = chatParams;
    const features = serdeFeatures(parseJson<unknown>(row.features_json));
    if (features !== undefined) state.features = features;
    const modeState = parseJson<SessionState['modeState']>(row.mode_state_json);
    if (modeState !== undefined) state.modeState = modeState;
    if (row.input_value !== null) state.inputValue = row.input_value;
    const panelStates = serdePanelStates(parseJson<unknown>(row.panel_states_json));
    if (panelStates !== undefined) state.panelStates = panelStates;
    if (row.pending_context_refs_json !== null) state.pendingContextRefsJson = row.pending_context_refs_json;
    if (row.loaded_skill_ids_json !== null) state.loadedSkillIdsJson = row.loaded_skill_ids_json;
    if (row.active_skill_ids_json !== null) state.activeSkillIdsJson = row.active_skill_ids_json;
    if (row.skill_state_json !== null) state.skillStateJson = row.skill_state_json;
    return state;
  });
}

/** `load_session_rag_scope` (chat_v2/session_scope.rs:12-27): None on any failure. */
export function loadRagScope(db: SqlExecutor, sessionId: string): string[] {
  return databaseOperation(() => {
    const row = db.get<{ rag_library_ids_json: string | null }>(
      'SELECT rag_library_ids_json FROM chat_v2_session_state WHERE session_id = ?1', [sessionId]);
    const raw = row?.rag_library_ids_json ?? null;
    if (raw === null) return [];
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return []; }
    if (!Array.isArray(parsed)) return [];
    const ids = parsed.filter((id): id is string => typeof id === 'string');
    const nonEmpty = ids.filter(id => rustTrim(id) !== '');
    return nonEmpty.length > 0 ? nonEmpty : [];
  });
}

/** Backend Option variant (session_scope.rs), distinct from get_rag_scope IPC. */
export function loadBackendRagScope(db: SqlExecutor, sessionId: string): string[] | null {
  const row = db.get<{ rag_library_ids_json: string | null }>(
    'SELECT rag_library_ids_json FROM chat_v2_session_state WHERE session_id = ?1', [sessionId]);
  if (row?.rag_library_ids_json == null) return null;
  let value: unknown;
  try { value = JSON.parse(row.rag_library_ids_json); } catch { return null; }
  if (!Array.isArray(value) || !value.every(id => typeof id === 'string')) return null;
  const ids = value.filter(id => rustTrim(id) !== '');
  return ids.length === 0 ? null : ids;
}

/** `chat_v2_set_rag_scope` upsert (manage_session.rs:2989-3021). */
export function saveRagScope(db: SqlExecutor, sessionId: string, folderIds: string[]): void {
  const ids = folderIds.map(rustTrim).filter(id => id !== '');
  const value = ids.length === 0 ? null : JSON.stringify(ids);
  databaseOperation(() => {
    db.run(`INSERT INTO chat_v2_session_state (session_id, rag_library_ids_json, updated_at)
      VALUES (?1, ?2, ?3)
      ON CONFLICT(session_id) DO UPDATE SET rag_library_ids_json = excluded.rag_library_ids_json`,
    [sessionId, value, databaseNow()]);
  });
}

/** Rust `SessionSkillState` JSON shape (camelCase, empty vectors skipped). */
export interface SessionSkillState {
  manualPinnedSkillIds?: string[];
  modeRequiredBundleIds?: string[];
  agenticSessionSkillIds?: string[];
  branchLocalSkillIds?: string[];
  effectiveAllowedExternalServers?: string[];
  version: number | bigint;
  legacyMigrated?: boolean;
}

/**
 * `update_session_skill_state_v2` (repo.rs:3688-3714): upsert the skill-state
 * columns and refresh `updated_at`, creating the state row when absent.
 */
export function saveSessionSkillState(db: SqlExecutor, sessionId: string, skillState: SessionSkillState): void {
  const existing = loadSessionState(db, sessionId);
  const state: SessionState = existing ?? { sessionId, updatedAt: databaseNow() };
  applySkillState(state, { manualPinnedSkillIds: skillState.manualPinnedSkillIds ?? [],
    modeRequiredBundleIds: skillState.modeRequiredBundleIds ?? [], agenticSessionSkillIds: skillState.agenticSessionSkillIds ?? [],
    branchLocalSkillIds: skillState.branchLocalSkillIds ?? [], effectiveAllowedExternalServers: skillState.effectiveAllowedExternalServers ?? [],
    version: skillState.version, legacyMigrated: skillState.legacyMigrated });
  state.updatedAt = databaseNow();
  saveSessionState(db, sessionId, state);
}
