/**
 * Session write actions shared by manage_session commands.
 * Rust source: `chat_v2/handlers/manage_session.rs`.
 */
import type { ChatSession, SessionSettings, SessionState } from '../api.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { ChatV2Error } from './error.ts';
import { databaseOperation } from '../repository/errors.ts';
import { incrementSkillVersion, parseSkillIds, parseSkillState, resolveSkillState,
  applySkillState, type SkillState } from './session-skill-state.ts';
export type { SkillState } from './session-skill-state.ts';
export { applySkillState } from './session-skill-state.ts';
import type { ApprovalManager } from '../../agent-workspace/api.ts';
import { rustTrim } from '../../../platform/util/index.ts';
import { databaseNow, databaseTimestamp, generateSessionId, utcNow } from './types.ts';
import { createSession, getSession, otherActiveSuperSessionExists, updateSession } from '../repository/sessions.ts';
import { getGroup } from '../repository/groups.ts';
import { loadSessionState, saveSessionState } from '../repository/session-state.ts';
import { rebuildSessionSkillStateFromHistory } from './session-metadata.ts';
import { errorText, type ChatLogger } from './logger.ts';
import { parseAuthorityMode, parsePermissionPreset, sessionAuthorityFromMetadata as authorityFromMetadata,
  applySessionAuthorityMetadata as applyAuthorityMetadata } from './session-authority.ts';
import type { AuthorityMode } from '../api.ts';

const VALID_MODES = ['chat', 'analysis', 'review', 'textbook', 'bridge', 'general_chat'] as const;
const MANUALLY_ARCHIVED_BY_KEY = 'manuallyArchivedBy';
const SUPER_AGENT_METADATA_KEY = 'super_agent';

/** Metadata keys owned by backend runtime state; settings patches never overwrite them. */
const BACKEND_AUTHORITATIVE_METADATA_KEYS = [
  'availableSkillsSnapshot',
  'availableSkillsSnapshotGeneration',
  'availableSkillsSnapshotPendingGeneration',
  'toolFacePrefixGeneration',
  'frozenToolSchemaOrder',
  'toolSchemaDigest',
  'microcompactAnchor',
  MANUALLY_ARCHIVED_BY_KEY,
  'groupArchivedBy',
  'branchedFrom',
  SUPER_AGENT_METADATA_KEY,
] as const;

function persistStatusDebug(status: ChatSession['persistStatus']): string {
  return status === 'archived' ? 'Archived' : status === 'deleted' ? 'Deleted' : 'Active';
}

function now(): string {
  return utcNow();
}

function metadataObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function createSessionAction(
  db: DatabaseHandle,
  mode: string,
  title: string | null | undefined,
  metadata: unknown,
  groupId: string | null | undefined,
  log: ChatLogger,
  initializeRuntimeRoots: (sessionId: string) => void,
): ChatSession {
  log.info(`[ChatV2::handlers] chat_v2_create_session: mode=${mode}, title=${title == null ? 'None' : `Some(${JSON.stringify(title)})`}`);
  if (!(VALID_MODES as readonly string[]).includes(mode)) {
    throw new ChatV2Error('Validation', `Invalid session mode: ${mode}. Valid modes: [${VALID_MODES.map(value => `"${value}"`).join(', ')}]`);
  }
  const normalizedGroupId = groupId !== null && groupId !== undefined && rustTrim(groupId) !== ''
    ? groupId
    : null;
  if (normalizedGroupId !== null) {
    const group = getGroup(db, normalizedGroupId);
    if (group === null) {
      log.warn(`[ChatV2::handlers] Ignoring non-existent group_id: ${normalizedGroupId}`);
      throw new ChatV2Error('GroupNotFound', normalizedGroupId);
    }
    if (group.persistStatus !== 'active') {
      log.warn(`[ChatV2::handlers] Ignoring deleted/archived group_id: ${normalizedGroupId}`);
      throw new ChatV2Error('GroupNotFound', `${normalizedGroupId} (inactive)`);
    }
  }
  const timestamp = now();
  const session: ChatSession = {
    id: generateSessionId(),
    mode,
    titleLocked: title !== null && title !== undefined,
    persistStatus: 'active',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  if (title !== null && title !== undefined) session.title = title;
  if (metadata !== null && metadata !== undefined) session.metadata = metadata;
  if (normalizedGroupId !== null) session.groupId = normalizedGroupId;
  createSession(db, session);
  try { initializeRuntimeRoots(session.id); }
  catch (error) { log.warn(`[ChatV2::handlers] Failed to initialize runtime roots for ${session.id}: ${errorText(error)}`); }
  log.info(`[ChatV2::handlers] Created session: id=${session.id}, mode=${session.mode}`);
  return session;
}

function isAuthoritativeKey(key: string): boolean {
  return (BACKEND_AUTHORITATIVE_METADATA_KEYS as readonly string[]).includes(key);
}

/** `patch_session_metadata` (manage_session.rs:1298-1349). */
export function patchSessionMetadata(
  existing: unknown,
  incoming: unknown,
  mentioned: boolean,
): unknown {
  if (!mentioned) return existing;
  const authoritative: Array<[string, unknown]> = [];
  if (existing !== null && typeof existing === 'object' && !Array.isArray(existing)) {
    for (const key of BACKEND_AUTHORITATIVE_METADATA_KEYS) {
      const value = (existing as Record<string, unknown>)[key];
      if (value !== undefined) authoritative.push([key, value]);
    }
  }

  let next: Record<string, unknown>;
  if (incoming !== null && typeof incoming === 'object' && !Array.isArray(incoming)) {
    next = { ...(incoming as Record<string, unknown>) };
    for (const key of Object.keys(next)) {
      if (isAuthoritativeKey(key) || next[key] === null) delete next[key];
    }
  } else if (incoming === null || incoming === undefined) {
    next = {};
  } else if (authoritative.length === 0) {
    return incoming;
  } else {
    return existing;
  }

  for (const [key, value] of authoritative) next[key] = value;
  return Object.keys(next).length === 0 ? undefined : next;
}

export function updateSessionSettingsAction(
  db: DatabaseHandle,
  sessionId: string,
  settings: SessionSettings,
): ChatSession {
  return databaseOperation(() => db.transaction(tx => {
    const existing = getSession(tx, sessionId);
    if (!existing) throw new ChatV2Error('SessionNotFound', sessionId);
    if (existing.persistStatus !== 'active') {
      throw new ChatV2Error('Validation', `只能归档活跃会话，当前状态: ${persistStatusDebug(existing.persistStatus)}`);
    }
    const userRenamed = settings.title !== undefined && settings.title !== null;
    const updated: ChatSession = {
      ...existing,
      updatedAt: now(),
      titleLocked: userRenamed ? true : existing.titleLocked,
      metadata: patchSessionMetadata(existing.metadata, settings.metadata, settings.metadata !== undefined),
    };
    if (userRenamed) updated.title = settings.title!;
    updateSession(tx, updated);
    return updated;
  }, { behavior: 'immediate' }));
}

function isActiveSuperMetadata(metadata: unknown): boolean {
  if (metadata === null || typeof metadata !== 'object') return false;
  const marker = (metadata as Record<string, unknown>)[SUPER_AGENT_METADATA_KEY];
  return marker !== null && typeof marker === 'object'
    && (marker as Record<string, unknown>).active === true;
}

export function archiveSessionAction(db: DatabaseHandle, sessionId: string): void {
  const existing = getSession(db, sessionId);
  if (!existing) throw new ChatV2Error('SessionNotFound', sessionId);
  if (isActiveSuperMetadata(existing.metadata)) {
    throw new ChatV2Error('Validation',
      'Super-agent 会话不能归档。如需清空，请删除该会话（会自动新建一个空的 Super-agent 会话）。');
  }
  const timestamp = now();
  const metadata = metadataObject(existing.metadata);
  metadata[MANUALLY_ARCHIVED_BY_KEY] = { archivedAt: databaseTimestamp(timestamp) };
  updateSession(db, {
    ...existing,
    persistStatus: 'archived',
    updatedAt: timestamp,
    metadata,
  });
}

export function softDeleteSessionAction(db: DatabaseHandle, sessionId: string): ChatSession {
  const existing = getSession(db, sessionId);
  if (!existing) throw new ChatV2Error('SessionNotFound', sessionId);
  const deleted: ChatSession = { ...existing, persistStatus: 'deleted', updatedAt: now() };
  updateSession(db, deleted);
  return deleted;
}

export function retireSuperMetadata(metadata: Record<string, unknown>): void {
  if (!(SUPER_AGENT_METADATA_KEY in metadata)) return;
  metadata[SUPER_AGENT_METADATA_KEY] = {
    active: false,
    retired_at: databaseNow(),
  };
  delete metadata.pinned;
}

export function restoreSessionAction(db: DatabaseHandle, sessionId: string): ChatSession {
  const existing = getSession(db, sessionId);
  if (!existing) throw new ChatV2Error('SessionNotFound', sessionId);
  const original = existing.metadata;
  const isObject = original !== null && typeof original === 'object' && !Array.isArray(original);
  const metadata = isObject ? { ...(original as Record<string, unknown>) } : original;
  if (isObject) {
    delete (metadata as Record<string, unknown>)[MANUALLY_ARCHIVED_BY_KEY];
    delete (metadata as Record<string, unknown>).groupArchivedBy;
  }
  if (isActiveSuperMetadata(metadata) && otherActiveSuperSessionExists(db, sessionId)) {
    retireSuperMetadata(metadata as Record<string, unknown>);
  }
  if (existing.groupId !== undefined && existing.groupId !== null) {
    const group = getGroup(db, existing.groupId);
    if (!group) throw new ChatV2Error('GroupNotFound', existing.groupId);
    if (group.persistStatus === 'archived') {
      throw new ChatV2Error('Validation',
        '该会话属于已归档课题，请先恢复整个课题，避免其它历史会话脱离课题分组。');
    }
    if (group.persistStatus === 'deleted') throw new ChatV2Error('GroupNotFound', existing.groupId);
  }
  const restored: ChatSession = {
    ...existing,
    persistStatus: 'active',
    updatedAt: now(),
    metadata,
  };
  updateSession(db, restored);
  // restore_session_in_db discards the rebuild result (`let _ = rebuild_…`).
  try { rebuildSessionSkillStateFromHistory(db, sessionId); } catch { return restored; }
  return restored;
}

// ============================================================
// Session state (save_session)
// ============================================================

/** `merge_session_skill_state` + `clear_branch_local_skill_state`. */
export function mergeSessionSkillState(existing: SessionState | null, incoming: SessionState): SessionState {
  const incomingSkillState = parseSkillState(incoming.skillStateJson);
  const base = incomingSkillState !== undefined
    ? incomingSkillState
    : existing === null ? undefined : resolveSkillState(existing);
  if (base === undefined) return incoming;

  const merged: SkillState = {
    manualPinnedSkillIds: [...(base.manualPinnedSkillIds ?? [])],
    modeRequiredBundleIds: [...(base.modeRequiredBundleIds ?? [])],
    agenticSessionSkillIds: [...(base.agenticSessionSkillIds ?? [])],
    branchLocalSkillIds: [...(base.branchLocalSkillIds ?? [])],
    effectiveAllowedExternalServers: [...(base.effectiveAllowedExternalServers ?? [])],
    version: base.version ?? 0,
    legacyMigrated: base.legacyMigrated,
  };

  if (incomingSkillState === undefined) {
    const nextManual = parseSkillIds(incoming.activeSkillIdsJson);
    const previousManual = merged.manualPinnedSkillIds;
    merged.manualPinnedSkillIds = nextManual;
    if (nextManual.length !== previousManual.length || nextManual.some((id, index) => id !== previousManual[index])) {
      merged.version = incrementSkillVersion(merged.version);
    }
  }
  merged.legacyMigrated = false;
  if (merged.branchLocalSkillIds.length > 0) {
    merged.branchLocalSkillIds = [];
    merged.version = incrementSkillVersion(merged.version);
  }
  const result: SessionState = { ...incoming };
  applySkillState(result, merged);
  return result;
}

export function saveSessionAction(db: DatabaseHandle, sessionId: string, state: SessionState): void {
  const session = getSession(db, sessionId);
  if (!session) throw new ChatV2Error('SessionNotFound', sessionId);
  const existing = loadSessionState(db, sessionId);
  saveSessionState(db, sessionId, mergeSessionSkillState(existing, state));
}

// ============================================================
// Authority mode / permission preset
// ============================================================

export function authorityModeFromMetadata(metadata: unknown): AuthorityMode {
  return authorityFromMetadata(metadata).authorityMode;
}

export function setAuthorityModeAction(db: DatabaseHandle, sessionId: string, mode: string, log?: ChatLogger): ChatSession {
  const parsed = parseAuthorityMode(mode);
  if (parsed === null) {
    throw new ChatV2Error('Validation', `Invalid authority mode '${mode}'. Valid modes: ask, plan, craft`);
  }
  log?.info(`[ChatV2::handlers] chat_v2_set_authority_mode: session=${sessionId}, mode=${parsed}`);
  const session = getSession(db, sessionId);
  if (!session) throw new ChatV2Error('SessionNotFound', sessionId);
  const authority = authorityFromMetadata(session.metadata);
  authority.authorityMode = parsed;
  if (parsed !== 'plan') delete authority.plan;
  const updated: ChatSession = {
    ...session,
    metadata: applyAuthorityMetadata(session.metadata, authority),
    updatedAt: now(),
  };
  updateSession(db, updated);
  return updated;
}

export function setPermissionPresetAction(
  getDb: () => DatabaseHandle,
  sessionId: string,
  preset: string,
  confirm: boolean | null | undefined,
  approvals: Pick<ApprovalManager, 'clearSessionRemembered'> | undefined,
): ChatSession {
  const parsed = parsePermissionPreset(preset);
  if (parsed === null) {
    throw new ChatV2Error('Validation',
      `Invalid permission preset '${preset}'. Valid presets: cautious, relaxed, full_access, danger_full_access`);
  }
  if (parsed === 'danger_full_access' && confirm !== true) {
    throw new ChatV2Error('Validation',
      'Enabling danger_full_access requires the explicit danger confirmation (confirm=true).');
  }
  if (approvals === undefined) throw new ChatV2Error('Other', 'ApprovalManager is not available');
  approvals.clearSessionRemembered(sessionId);
  const db = getDb();
  const session = getSession(db, sessionId);
  if (!session) throw new ChatV2Error('SessionNotFound', sessionId);
  const authority = authorityFromMetadata(session.metadata);
  authority.permissionPreset = parsed;
  const updated: ChatSession = {
    ...session,
    metadata: applyAuthorityMetadata(session.metadata, authority),
    updatedAt: now(),
  };
  updateSession(db, updated);
  return updated;
}
