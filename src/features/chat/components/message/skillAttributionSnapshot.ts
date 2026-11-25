import type { MessageMeta, SkillStateSnapshot, VariantMeta } from '../../core/types/message';
import { skillRegistry } from '../../skills/registry';

export type SkillAttributionSource = 'pinned' | 'agentic' | 'runtime';

export interface SnapshotSkillEntry {
  id: string;
  name: string;
  source: SkillAttributionSource;
}

export interface MessageSkillAttributionSnapshot {
  skills: SnapshotSkillEntry[];
  capturedAt: number;
}

const STORAGE_KEY = 'deepstudent.skillAttributionSnapshots.v1';
const MAX_PERSISTED_SNAPSHOTS = 300;

let skillSnapshotCache: Map<string, MessageSkillAttributionSnapshot> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function cloneSnapshot(snapshot: MessageSkillAttributionSnapshot): MessageSkillAttributionSnapshot {
  return {
    skills: snapshot.skills.map((item) => ({ ...item })),
    capturedAt: snapshot.capturedAt,
  };
}

export function buildSkillSnapshotKey(params: {
  sessionId?: string | null;
  messageId?: string | null;
  variantId?: string | null;
}): string | null {
  const messageId = typeof params.messageId === 'string' ? params.messageId.trim() : '';
  if (!messageId) return null;
  const sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : '';
  const variantId = typeof params.variantId === 'string' && params.variantId.trim()
    ? params.variantId.trim()
    : 'default';
  return `${sessionId}:${messageId}:${variantId}`;
}

export function defaultResolveSkillDisplayName(skillId: string): string {
  const skill = skillRegistry.get(skillId);
  return skill?.name?.trim() || skillId;
}

export function extractBoundSkillIdsFromSession(
  skillStateJson: string | null | undefined,
  fallbackActiveSkillIds?: string[] | null,
): string[] {
  if (typeof skillStateJson === 'string' && skillStateJson.trim().length > 0) {
    try {
      const parsed = JSON.parse(skillStateJson) as { manualPinnedSkillIds?: unknown };
      if (Array.isArray(parsed?.manualPinnedSkillIds)) {
        return normalizeIds(parsed.manualPinnedSkillIds);
      }
    } catch {
      // Fall through to activeSkillIds fallback on malformed JSON.
    }
  }
  return normalizeIds(fallbackActiveSkillIds);
}

function parseExplicitSkillSnapshot(raw: unknown): MessageSkillAttributionSnapshot | null {
  if (!isRecord(raw) || !Array.isArray(raw.skills)) return null;
  const skills: SnapshotSkillEntry[] = [];
  const seen = new Set<string>();
  for (const item of raw.skills) {
    if (!isRecord(item) || typeof item.id !== 'string' || !item.id.trim()) continue;
    const id = item.id.trim();
    if (seen.has(id)) continue;
    seen.add(id);
    const source: SkillAttributionSource =
      item.source === 'pinned' || item.source === 'agentic' || item.source === 'runtime'
        ? item.source
        : 'pinned';
    skills.push({
      id,
      name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : defaultResolveSkillDisplayName(id),
      source,
    });
  }
  return {
    skills,
    capturedAt: typeof raw.capturedAt === 'number' ? raw.capturedAt : Date.now(),
  };
}

function collectFromSkillStateSnapshot(
  snapshot: SkillStateSnapshot | undefined,
  entriesById: Map<string, SnapshotSkillEntry>,
  resolveName: (skillId: string) => string,
): boolean {
  if (!snapshot || typeof snapshot !== 'object') return false;
  let foundMetadata = false;

  if (Array.isArray(snapshot.manualPinnedSkillIds)) {
    foundMetadata = true;
    for (const id of normalizeIds(snapshot.manualPinnedSkillIds)) {
      if (!entriesById.has(id)) {
        entriesById.set(id, { id, name: resolveName(id), source: 'pinned' });
      }
    }
  }
  if (Array.isArray(snapshot.agenticSessionSkillIds)) {
    foundMetadata = true;
    for (const id of normalizeIds(snapshot.agenticSessionSkillIds)) {
      if (!entriesById.has(id)) {
        entriesById.set(id, { id, name: resolveName(id), source: 'agentic' });
      }
    }
  }
  if (Array.isArray(snapshot.branchLocalSkillIds)) {
    foundMetadata = true;
    for (const id of normalizeIds(snapshot.branchLocalSkillIds)) {
      if (!entriesById.has(id)) {
        entriesById.set(id, { id, name: resolveName(id), source: 'agentic' });
      }
    }
  }
  return foundMetadata;
}

/**
 * Extract an immutable per-message skill snapshot from persisted message/variant metadata.
 * Returns `null` when the message metadata does not contain any skill snapshot fields yet
 * (e.g. a freshly settled live turn before DB reload), allowing fallback to persisted/captured state.
 */
export function extractMessageSkillSnapshotFromMeta(
  messageMeta: (MessageMeta & Record<string, unknown>) | Record<string, unknown> | null | undefined,
  variantMeta?: (VariantMeta & Record<string, unknown>) | Record<string, unknown> | null,
  resolveName: (skillId: string) => string = defaultResolveSkillDisplayName,
): MessageSkillAttributionSnapshot | null {
  if (isRecord(variantMeta)) {
    const explicitVariant = parseExplicitSkillSnapshot(variantMeta.skillAttributionSnapshot);
    if (explicitVariant) return explicitVariant;
  }
  if (isRecord(messageMeta)) {
    const explicitMessage = parseExplicitSkillSnapshot(messageMeta.skillAttributionSnapshot);
    if (explicitMessage) return explicitMessage;
  }

  const entriesById = new Map<string, SnapshotSkillEntry>();
  let hasAnySkillMeta = false;

  const vMeta = isRecord(variantMeta) ? (variantMeta as VariantMeta & Record<string, unknown>) : undefined;
  const mMeta = isRecord(messageMeta) ? (messageMeta as MessageMeta & Record<string, unknown>) : undefined;

  const primaryStateSnapshot =
    vMeta?.skillSnapshotAfter ??
    vMeta?.skillSnapshotBefore ??
    mMeta?.skillSnapshotAfter ??
    mMeta?.skillSnapshotBefore;
  if (collectFromSkillStateSnapshot(primaryStateSnapshot, entriesById, resolveName)) {
    hasAnySkillMeta = true;
  }

  const runtimeSnapshot =
    vMeta?.skillRuntimeAfter ??
    vMeta?.skillRuntimeBefore ??
    mMeta?.skillRuntimeAfter ??
    mMeta?.skillRuntimeBefore;
  if (runtimeSnapshot && typeof runtimeSnapshot === 'object') {
    if (Array.isArray(runtimeSnapshot.activeSkillIds)) {
      hasAnySkillMeta = true;
      for (const id of normalizeIds(runtimeSnapshot.activeSkillIds)) {
        if (!entriesById.has(id)) {
          entriesById.set(id, { id, name: resolveName(id), source: 'pinned' });
        }
      }
    }
  }

  const anchors = mMeta?.skillInjectionAnchors;
  if (isRecord(anchors)) {
    if (Array.isArray(anchors.turnSkillIds)) {
      hasAnySkillMeta = true;
      for (const id of normalizeIds(anchors.turnSkillIds)) {
        if (!entriesById.has(id)) {
          entriesById.set(id, { id, name: resolveName(id), source: 'runtime' });
        }
      }
    }
    if (Array.isArray(anchors.toolAnchored)) {
      hasAnySkillMeta = true;
      for (const item of anchors.toolAnchored) {
        if (isRecord(item) && typeof item.skillId === 'string' && item.skillId.trim()) {
          const id = item.skillId.trim();
          if (!entriesById.has(id)) {
            entriesById.set(id, { id, name: resolveName(id), source: 'agentic' });
          }
        }
      }
    }
  }

  if (Array.isArray(mMeta?.toolResults)) {
    for (const tr of mMeta.toolResults) {
      if (!isRecord(tr)) continue;
      const toolName = typeof tr.toolName === 'string' ? tr.toolName : '';
      if (toolName !== 'load_skills' && toolName !== 'builtin-load_skills') continue;
      const input = isRecord(tr.input) ? tr.input : undefined;
      const ids = normalizeIds(input?.skill_ids ?? input?.skillIds);
      if (ids.length > 0) {
        hasAnySkillMeta = true;
        for (const id of ids) {
          if (!entriesById.has(id)) {
            entriesById.set(id, { id, name: resolveName(id), source: 'agentic' });
          }
        }
      }
    }
  }

  if (!hasAnySkillMeta) return null;

  return {
    skills: Array.from(entriesById.values()),
    capturedAt: Date.now(),
  };
}

export function snapshotFromSkillIds(
  skillIds: string[],
  resolveName: (skillId: string) => string = defaultResolveSkillDisplayName,
  source: SkillAttributionSource = 'pinned',
): MessageSkillAttributionSnapshot {
  const seen = new Set<string>();
  const skills: SnapshotSkillEntry[] = [];
  for (const rawId of skillIds) {
    const id = typeof rawId === 'string' ? rawId.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    skills.push({
      id,
      name: resolveName(id),
      source,
    });
  }
  return {
    skills,
    capturedAt: Date.now(),
  };
}

function loadCache(): Map<string, MessageSkillAttributionSnapshot> {
  if (skillSnapshotCache) return skillSnapshotCache;
  skillSnapshotCache = new Map();
  if (typeof window === 'undefined' || !window.localStorage) {
    return skillSnapshotCache;
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return skillSnapshotCache;
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return skillSnapshotCache;
    for (const [key, value] of Object.entries(parsed)) {
      const snap = parseExplicitSkillSnapshot(value);
      if (snap) {
        skillSnapshotCache.set(key, snap);
      }
    }
  } catch {
    // Ignore storage errors.
  }
  return skillSnapshotCache;
}

function persistCache(cache: Map<string, MessageSkillAttributionSnapshot>): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    while (cache.size > MAX_PERSISTED_SNAPSHOTS) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey === undefined) break;
      cache.delete(oldestKey);
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(cache.entries())));
  } catch {
    // Ignore quota/storage errors.
  }
}

export function getPersistedMessageSkillSnapshot(
  key: string | null,
): MessageSkillAttributionSnapshot | null {
  if (!key) return null;
  const found = loadCache().get(key);
  return found ? cloneSnapshot(found) : null;
}

/**
 * Write-once persistence: once a message captures the skills used when it was generated,
 * later binding/unbinding in the composer never mutates historical message badges.
 */
export function savePersistedMessageSkillSnapshot(
  key: string,
  snapshot: MessageSkillAttributionSnapshot,
): MessageSkillAttributionSnapshot {
  const cache = loadCache();
  const existing = cache.get(key);
  if (existing) {
    return cloneSnapshot(existing);
  }
  const cloned = cloneSnapshot(snapshot);
  cache.set(key, cloned);
  persistCache(cache);
  return cloneSnapshot(cloned);
}

export function clearPersistedMessageSkillSnapshots(): void {
  skillSnapshotCache = new Map();
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Ignore storage errors.
    }
  }
}
