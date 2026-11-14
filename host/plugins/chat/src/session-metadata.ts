/**
 * Session metadata runtime state used by generation/skills snapshots.
 * Rust source: `chat_v2/repo.rs:52-156, 3068-3391`.
 *
 * Rust deliberately does not advance `updated_at` for these writes, so this
 * module updates only the metadata column through `updateSession`.
 */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { ChatSession, ChatMessage, SessionState } from '../api.ts';
import { ChatV2Error } from './error.ts';
import { getSession, updateSession } from '../repository/sessions.ts';
import { getSessionMessages } from '../repository/messages.ts';
import { loadSessionState, saveSessionSkillState } from '../repository/session-state.ts';
import { sessionSkillStateFromSnapshot } from './variant-actions.ts';
import type { ChatLogger } from './logger.ts';
import { resolveSkillState, incrementSkillVersion } from './session-skill-state.ts';

const AVAILABLE_SKILLS_SNAPSHOT_KEY = 'availableSkillsSnapshot';
const AVAILABLE_SKILLS_SNAPSHOT_GENERATION_KEY = 'availableSkillsSnapshotGeneration';
const AVAILABLE_SKILLS_SNAPSHOT_PENDING_GENERATION_KEY = 'availableSkillsSnapshotPendingGeneration';
const TOOL_FACE_PREFIX_GENERATION_KEY = 'toolFacePrefixGeneration';
const FROZEN_TOOL_SCHEMA_ORDER_KEY = 'frozenToolSchemaOrder';
const TOOL_SCHEMA_DIGEST_KEY = 'toolSchemaDigest';
const MICROCOMPACT_ANCHOR_KEY = 'microcompactAnchor';

type Metadata = Record<string, unknown>;

function metadataOf(session: ChatSession): Metadata {
  const value = session.metadata;
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Metadata) } : {};
}

function requireSession(db: SqlExecutor, sessionId: string): ChatSession {
  const session = getSession(db, sessionId);
  if (!session) throw new ChatV2Error('SessionNotFound', sessionId);
  return session;
}

function asU64(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function snapshotOf(metadata: Metadata): string | null {
  const value = metadata[AVAILABLE_SKILLS_SNAPSHOT_KEY];
  return typeof value === 'string' ? value : null;
}

function snapshotGeneration(metadata: Metadata): number {
  return asU64(metadata[AVAILABLE_SKILLS_SNAPSHOT_GENERATION_KEY]) ?? 0;
}

function pendingGeneration(metadata: Metadata): number | null {
  return asU64(metadata[AVAILABLE_SKILLS_SNAPSHOT_PENDING_GENERATION_KEY]);
}

function frozenOrder(metadata: Metadata): string[] {
  const value = metadata[FROZEN_TOOL_SCHEMA_ORDER_KEY];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function getFrozenToolSchemaOrder(db: SqlExecutor, sessionId: string): string[] {
  return frozenOrder(metadataOf(requireSession(db, sessionId)));
}

/** repo.rs:2989-3023: append-only, no updated_at change and no write for a subset. */
export function mergeFrozenToolSchemaOrder(db: SqlExecutor, sessionId: string, baseline: readonly string[]): void {
  const session = requireSession(db, sessionId);
  const metadata = metadataOf(session);
  const persisted = frozenOrder(metadata);
  const before = persisted.length;
  for (const name of baseline) if (!persisted.includes(name)) persisted.push(name);
  if (persisted.length === before) return;
  metadata[FROZEN_TOOL_SCHEMA_ORDER_KEY] = persisted;
  updateSession(db, { ...session, metadata });
}

export function getAvailableSkillsSnapshot(db: SqlExecutor, sessionId: string): string | null {
  return snapshotOf(metadataOf(requireSession(db, sessionId)));
}

/** `freeze_session_available_skills_snapshot` (repo.rs:3082-3128). */
export function freezeAvailableSkillsSnapshot(db: SqlExecutor, sessionId: string, snapshot: string): string {
  const session = requireSession(db, sessionId);
  const metadata = metadataOf(session);
  const generation = snapshotGeneration(metadata);
  const pending = pendingGeneration(metadata);
  const effectivePending = pending !== null && pending > generation ? pending : null;
  const existing = snapshotOf(metadata);
  if (existing !== null && effectivePending === null) return existing;
  metadata[AVAILABLE_SKILLS_SNAPSHOT_KEY] = snapshot;
  if (effectivePending !== null) {
    metadata[AVAILABLE_SKILLS_SNAPSHOT_GENERATION_KEY] = effectivePending;
    delete metadata[AVAILABLE_SKILLS_SNAPSHOT_PENDING_GENERATION_KEY];
  }
  updateSession(db, { ...session, metadata });
  return snapshot;
}

/** `mark_session_available_skills_snapshot_stale_with_conn` (repo.rs:3154-3189). */
export function markAvailableSkillsSnapshotStale(db: SqlExecutor, sessionId: string): number | null {
  const session = requireSession(db, sessionId);
  const metadata = metadataOf(session);
  if (snapshotOf(metadata) === null) return null;
  const generation = snapshotGeneration(metadata);
  const pending = pendingGeneration(metadata);
  if (pending !== null && pending > generation) return pending;
  const target = generation + 1;
  metadata[AVAILABLE_SKILLS_SNAPSHOT_PENDING_GENERATION_KEY] = target;
  updateSession(db, { ...session, metadata });
  return target;
}

export interface ToolFacePrefixSnapshot {
  generation: number;
  order: string[];
  schemaDigest: string | null;
}

/** `tool_face_prefix_from_metadata` (repo.rs:139-156). */
function toolFacePrefix(metadata: Metadata): ToolFacePrefixSnapshot | null {
  const generation = asU64(metadata[TOOL_FACE_PREFIX_GENERATION_KEY]);
  const digest = typeof metadata[TOOL_SCHEMA_DIGEST_KEY] === 'string'
    ? metadata[TOOL_SCHEMA_DIGEST_KEY] as string : null;
  const order = frozenOrder(metadata);
  if (generation === null && digest === null && order.length === 0) return null;
  return { generation: generation ?? 0, order, schemaDigest: digest };
}

export function getToolFacePrefix(db: SqlExecutor, sessionId: string): ToolFacePrefixSnapshot | null {
  return toolFacePrefix(metadataOf(requireSession(db, sessionId)));
}

/** `advance_session_tool_face_prefix_with_conn` (repo.rs:3321-3368). */
export function advanceToolFacePrefix(
  db: SqlExecutor,
  sessionId: string,
  snapshot: ToolFacePrefixSnapshot,
): void {
  const session = requireSession(db, sessionId);
  const metadata = metadataOf(session);
  const persisted = toolFacePrefix(metadata);
  const persistedGeneration = persisted?.generation ?? 0;
  const persistedDigest = persisted?.schemaDigest ?? null;
  const mergedOrder = [...(persisted?.order ?? [])];
  const mergedLengthBefore = mergedOrder.length;
  for (const name of snapshot.order) {
    if (!mergedOrder.includes(name)) mergedOrder.push(name);
  }
  const nextGeneration = Math.max(persistedGeneration, snapshot.generation);
  const nextDigest = snapshot.schemaDigest ?? persistedDigest;
  if (nextGeneration === persistedGeneration
    && mergedOrder.length === mergedLengthBefore
    && nextDigest === persistedDigest) {
    return;
  }
  metadata[TOOL_FACE_PREFIX_GENERATION_KEY] = nextGeneration;
  metadata[FROZEN_TOOL_SCHEMA_ORDER_KEY] = mergedOrder;
  if (nextDigest !== null) metadata[TOOL_SCHEMA_DIGEST_KEY] = nextDigest;
  updateSession(db, { ...session, metadata });
}

export interface MicrocompactAnchor {
  lineage: string | null;
  eligibleUserTurns: number;
}

function anchorOf(metadata: Metadata): MicrocompactAnchor | null {
  const anchor = metadata[MICROCOMPACT_ANCHOR_KEY];
  if (anchor === null || typeof anchor !== 'object' || Array.isArray(anchor)) return null;
  const turns = asU64((anchor as Metadata).eligibleUserTurns);
  if (turns === null) return null;
  const lineage = (anchor as Metadata).lineage;
  return { lineage: typeof lineage === 'string' ? lineage : null, eligibleUserTurns: turns };
}

export function getMicrocompactAnchor(db: SqlExecutor, sessionId: string): MicrocompactAnchor | null {
  return anchorOf(metadataOf(requireSession(db, sessionId)));
}

/** `set_session_microcompact_anchor_with_conn` (repo.rs:3235-3261). */
export function setMicrocompactAnchor(db: SqlExecutor, sessionId: string, anchor: MicrocompactAnchor): void {
  const session = requireSession(db, sessionId);
  const metadata = metadataOf(session);
  const existing = anchorOf(metadata);
  if (existing !== null && existing.lineage === anchor.lineage
    && existing.eligibleUserTurns === anchor.eligibleUserTurns) {
    return;
  }
  metadata[MICROCOMPACT_ANCHOR_KEY] = {
    lineage: anchor.lineage,
    eligibleUserTurns: anchor.eligibleUserTurns,
  };
  updateSession(db, { ...session, metadata });
}

/** `resolve_message_skill_snapshot` (manage_session.rs:1518-1550). */
export function resolveMessageSkillSnapshot(message: ChatMessage): {
  manualPinnedSkillIds?: string[]; modeRequiredBundleIds?: string[];
  agenticSessionSkillIds?: string[]; branchLocalSkillIds?: string[];
  effectiveAllowedExternalServers?: string[]; version: number;
} | null {
  const activeId = message.activeVariantId;
  if (activeId !== null && activeId !== undefined) {
    const variant = message.variants?.find(candidate => candidate.id === activeId);
    const snapshot = variant?.meta?.skillSnapshotAfter ?? variant?.meta?.skillSnapshotBefore;
    if (snapshot !== null && snapshot !== undefined) return snapshot;
  }
  return message._meta?.skillSnapshotAfter ?? message._meta?.skillSnapshotBefore ?? null;
}

/** `SessionState::resolved_skill_state` (types.rs:2610-2620). */
export function resolvedSkillState(state: SessionState): import('../repository/session-state.ts').SessionSkillState {
  return resolveSkillState(state);
}

/** `fallback_skill_state_after_history_rebuild` (manage_session.rs:2105-2122). */
export function fallbackSkillStateAfterHistoryRebuild(
  existingState: SessionState | null | undefined,
): import('../repository/session-state.ts').SessionSkillState {
  if (existingState === null || existingState === undefined) return { version: 0 };
  const existing = resolvedSkillState(existingState);
  return {
    manualPinnedSkillIds: existing.manualPinnedSkillIds ?? [],
    modeRequiredBundleIds: existing.modeRequiredBundleIds ?? [],
    agenticSessionSkillIds: [],
    branchLocalSkillIds: [],
    effectiveAllowedExternalServers: [],
    version: incrementSkillVersion(existing.version),
    legacyMigrated: false,
  };
}

/**
 * `rebuild_session_skill_state_from_surviving_history` (manage_session.rs:1552-1573).
 * Errors are returned to the caller; delete_message ignores them like Rust.
 */
export function rebuildSessionSkillStateFromHistory(db: SqlExecutor, sessionId: string, log?: ChatLogger): void {
  const messages = getSessionMessages(db, sessionId, log);
  const existingState = loadSessionState(db, sessionId);
  let rebuilt = null;
  for (const message of [...messages].reverse()) {
    const snapshot = resolveMessageSkillSnapshot(message);
    if (snapshot !== null) {
      rebuilt = sessionSkillStateFromSnapshot(snapshot);
      break;
    }
  }
  const resolved = rebuilt ?? fallbackSkillStateAfterHistoryRebuild(existingState);
  saveSessionSkillState(db, sessionId, resolved);
}

/** `clear_branch_local_skill_state` / `without_branch_local_skills`. */
export function clearBranchLocalSkillState(
  state: import('../repository/session-state.ts').SessionSkillState,
): import('../repository/session-state.ts').SessionSkillState {
  return { ...state, branchLocalSkillIds: [], legacyMigrated: false,
    version: state.branchLocalSkillIds?.length ? incrementSkillVersion(state.version) : state.version };
}
