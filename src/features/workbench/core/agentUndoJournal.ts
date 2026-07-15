import { nanoid } from 'nanoid';
import type {
  AgentActionCall,
  AgentCapabilityRisk,
  AgentJsonValue,
  AgentUndoDurability,
} from './types';

export const AGENT_UNDO_JOURNAL_KEY = 'desktop.acr.undoJournal.v3';
export const MAX_AGENT_UNDO_ENTRIES = 20;
const MAX_INVERSE_BYTES = 64 * 1024;
const MAX_EXPECTED_STATE_BYTES = 64 * 1024;
const MAX_JOURNAL_BYTES = 256 * 1024;

export interface AgentUndoJournalEntry {
  version: 3;
  token: string;
  createdAt: number;
  /** Empty only for direct legacy/test callers; bridge-created entries are session-bound. */
  sessionId: string;
  typeId: string;
  windowId?: string;
  instanceKey: string | null;
  inverse: AgentActionCall[];
  /** Forward post-state. Revert is allowed only while this OCC snapshot still matches. */
  expectedRevision: string;
  expectedState: Record<string, AgentJsonValue>;
  requiredRisk: AgentCapabilityRisk;
  label?: string;
  durability: AgentUndoDurability;
}

const entries = new Map<string, AgentUndoJournalEntry>();
const revertFlights = new Map<string, Promise<unknown>>();

function jsonCloneInverse(inverse: AgentActionCall[]): AgentActionCall[] | null {
  try {
    const encoded = JSON.stringify(inverse);
    if (encoded.length > MAX_INVERSE_BYTES) return null;
    const decoded = JSON.parse(encoded) as unknown;
    if (!Array.isArray(decoded)) return null;
    for (const action of decoded) {
      if (!action || typeof action !== 'object' || typeof action.name !== 'string') {
        return null;
      }
    }
    return decoded as AgentActionCall[];
  } catch {
    return null;
  }
}

function jsonCloneExpectedState(
  state: Record<string, AgentJsonValue>,
): Record<string, AgentJsonValue> | null {
  try {
    const encoded = JSON.stringify(state);
    if (encoded.length > MAX_EXPECTED_STATE_BYTES) return null;
    const decoded = JSON.parse(encoded) as unknown;
    return decoded && typeof decoded === 'object' && !Array.isArray(decoded)
      ? (decoded as Record<string, AgentJsonValue>)
      : null;
  } catch {
    return null;
  }
}

function readPersistent(): AgentUndoJournalEntry[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(AGENT_UNDO_JOURNAL_KEY);
    if (!raw) return [];
    const decoded = JSON.parse(raw) as unknown;
    if (!Array.isArray(decoded)) return [];
    return decoded.filter((entry): entry is AgentUndoJournalEntry => {
      if (!entry || typeof entry !== 'object') return false;
      const value = entry as Partial<AgentUndoJournalEntry>;
      return value.version === 3
        && typeof value.token === 'string'
        && typeof value.createdAt === 'number'
        && typeof value.sessionId === 'string'
        && typeof value.typeId === 'string'
        && typeof value.expectedRevision === 'string'
        && Boolean(value.expectedState)
        && typeof value.expectedState === 'object'
        && (value.requiredRisk === 'read'
          || value.requiredRisk === 'low'
          || value.requiredRisk === 'medium'
          || value.requiredRisk === 'high')
        && Array.isArray(value.inverse);
    }).map((entry) => ({ ...entry, durability: 'persistent' as const }));
  } catch {
    return [];
  }
}

function hydratePersistent(): void {
  for (const entry of readPersistent()) {
    if (!entries.has(entry.token)) entries.set(entry.token, entry);
  }
}

function sortedEntries(): AgentUndoJournalEntry[] {
  return [...entries.values()].sort((a, b) => a.createdAt - b.createdAt);
}

function evictOverflow(): void {
  const sorted = sortedEntries();
  while (sorted.length > MAX_AGENT_UNDO_ENTRIES) {
    const oldest = sorted.shift();
    if (oldest) entries.delete(oldest.token);
  }
}

function writePersistent(): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    const persistent = sortedEntries().filter((entry) => entry.durability === 'persistent');
    let encoded = JSON.stringify(persistent);
    while (encoded.length > MAX_JOURNAL_BYTES && persistent.length > 0) {
      const oldest = persistent.shift();
      if (oldest) entries.delete(oldest.token);
      encoded = JSON.stringify(persistent);
    }
    localStorage.setItem(AGENT_UNDO_JOURNAL_KEY, encoded);
    return true;
  } catch {
    return false;
  }
}

export function recordAgentUndo(input: {
  sessionId: string;
  typeId: string;
  windowId?: string;
  instanceKey: string | null;
  inverse: AgentActionCall[];
  expectedRevision: string;
  expectedState: Record<string, AgentJsonValue>;
  requiredRisk: AgentCapabilityRisk;
  label?: string;
  /** Non-idempotent inverse sequences remain session-only to avoid crash/replay ambiguity. */
  persist?: boolean;
}): { token: string; durability: AgentUndoDurability } | null {
  const inverse = jsonCloneInverse(input.inverse);
  const expectedState = jsonCloneExpectedState(input.expectedState);
  if (!inverse?.length || !input.expectedRevision.trim() || !expectedState) return null;
  hydratePersistent();
  const token = `acr-undo:${nanoid(12)}`;
  const entry: AgentUndoJournalEntry = {
    version: 3,
    token,
    createdAt: Date.now(),
    sessionId: input.sessionId,
    typeId: input.typeId,
    windowId: input.windowId,
    instanceKey: input.instanceKey,
    inverse,
    expectedRevision: input.expectedRevision,
    expectedState,
    requiredRisk: input.requiredRisk,
    label: input.label,
    durability: input.persist === false ? 'session' : 'persistent',
  };
  entries.set(token, entry);
  evictOverflow();

  const storageWritten = writePersistent();
  if (entry.durability === 'persistent' && !storageWritten) {
    entry.durability = 'session';
  }
  return { token, durability: entry.durability };
}

export function updateAgentUndo(
  token: string,
  inverse: AgentActionCall[],
  expected: {
    revision: string;
    state: Record<string, AgentJsonValue>;
  },
): AgentUndoJournalEntry | null {
  hydratePersistent();
  const entry = entries.get(token);
  const cloned = jsonCloneInverse(inverse);
  const expectedState = jsonCloneExpectedState(expected.state);
  if (!entry || !cloned || !expected.revision.trim() || !expectedState) return null;
  entry.inverse = cloned;
  entry.expectedRevision = expected.revision;
  entry.expectedState = expectedState;
  if (entry.durability === 'persistent' && !writePersistent()) {
    entry.durability = 'session';
  }
  return entry;
}

export function getAgentUndo(token: string): AgentUndoJournalEntry | null {
  hydratePersistent();
  return entries.get(token) ?? null;
}

export function consumeAgentUndo(token: string): AgentUndoJournalEntry | null {
  hydratePersistent();
  const entry = entries.get(token) ?? null;
  if (!entry) return null;
  entries.delete(token);
  if (entry.durability === 'persistent') writePersistent();
  return entry;
}

/** Concurrent calls for one token share the same replay and terminal result. */
export function runAgentUndoExclusive<T>(
  token: string,
  task: () => Promise<T>,
): Promise<T> {
  const existing = revertFlights.get(token);
  if (existing) return existing as Promise<T>;
  const flight = task().finally(() => {
    if (revertFlights.get(token) === flight) revertFlights.delete(token);
  });
  revertFlights.set(token, flight);
  return flight;
}

export function hasAgentUndoFlight(token: string): boolean {
  return revertFlights.has(token);
}

export function resetAgentUndoJournalForTests(options?: { clearStorage?: boolean }): void {
  entries.clear();
  revertFlights.clear();
  if (options?.clearStorage && typeof localStorage !== 'undefined') {
    try {
      localStorage.removeItem(AGENT_UNDO_JOURNAL_KEY);
    } catch {
      /* best effort */
    }
  }
}
