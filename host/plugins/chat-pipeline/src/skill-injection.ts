/**
 * pipeline/helpers.rs — transient skill injection (request-only messages).
 *
 * Skills are ordered dependency-first, grouped by authority tier (manual pin,
 * mode bundle, agentic session, branch local), deduped, and byte-identical
 * between the live request and later replay.
 */
import { estimateTokens } from './token-budget.ts';
import {
  isTransientSkillMessage, makeTransientSkillMessage, type LegacyChatMessage,
} from './microcompact.ts';
import { compareUtf8 } from '../../../platform/util/portable.ts';
import { createHasherSync } from '../../../platform/crypto/sync.ts';

export const TRANSIENT_REQUEST_ANCHOR_METADATA_KIND = 'request_context_anchor';

export interface SessionSkillState {
  manualPinnedSkillIds: readonly string[];
  modeRequiredBundleIds: readonly string[];
  agenticSessionSkillIds: readonly string[];
  branchLocalSkillIds: readonly string[];
  version: number;
}

export interface SkillInjectionAudit {
  injectedSkillIds: string[];
  droppedSkillIds: string[];
  missingSkillIds: string[];
  estimatedTokens: number;
  skillStateVersion: number;
}

export interface TransientSkillMessages {
  messages: LegacyChatMessage[];
  audit: SkillInjectionAudit;
}

function pushSkillWithDependencies(skillId: string, tier: number,
  dependencies: ReadonlyMap<string, readonly string[]> | null | undefined,
  seen: Set<string>, visiting: Set<string>, ordered: Array<[string, number]>): void {
  if (seen.has(skillId)) return;
  if (visiting.has(skillId)) return; // cycle: skip the recursive edge
  visiting.add(skillId);

  const deps = dependencies?.get(skillId);
  if (deps !== undefined) {
    const unique = [...new Set(deps)].sort((a, b) =>
      compareUtf8(a, b));
    for (const dep of unique) {
      pushSkillWithDependencies(dep, tier, dependencies, seen, visiting, ordered);
    }
  }

  visiting.delete(skillId);
  if (!seen.has(skillId)) {
    seen.add(skillId);
    ordered.push([skillId, tier]);
  }
}

/** Skill ids in injection order; already-anchored ids (and their deps) are skipped. */
export function orderedSkillIdsForInjection(skillState: SessionSkillState,
  dependencies?: ReadonlyMap<string, readonly string[]> | null,
  alreadyInjected: ReadonlySet<string> = new Set()): Array<[string, number]> {
  const ordered: Array<[string, number]> = [];
  const seen = new Set(alreadyInjected);
  const visiting = new Set<string>();

  const pushGroup = (ids: readonly string[], tier: number): void => {
    const sorted = [...new Set(ids)].sort((a, b) =>
      compareUtf8(a, b));
    for (const skillId of sorted) {
      pushSkillWithDependencies(skillId, tier, dependencies, seen, visiting, ordered);
    }
  };

  pushGroup(skillState.manualPinnedSkillIds, 0);
  pushGroup(skillState.modeRequiredBundleIds, 1);
  pushGroup(skillState.agenticSessionSkillIds, 2);
  pushGroup(skillState.branchLocalSkillIds, 3);
  return ordered;
}

function makeTransientRequestAnchorMessage(): LegacyChatMessage {
  return {
    role: 'user',
    content: '<request_context>Transient skill instructions for this request follow.</request_context>',
    metadata: { kind: TRANSIENT_REQUEST_ANCHOR_METADATA_KIND, hidden: true },
  };
}

/**
 * Inserts transient skill messages at `insertionIndex`. Position 0 is reserved:
 * a request anchor goes first so a skill instruction never becomes the first
 * message of the request.
 */
export function insertTransientSkillMessages(messages: LegacyChatMessage[],
  insertionIndex: number, transientSkillMessages: readonly LegacyChatMessage[]): void {
  if (transientSkillMessages.length === 0) return;
  let insertAt = Math.min(Math.max(0, insertionIndex), messages.length);
  if (insertAt === 0) {
    messages.splice(0, 0, makeTransientRequestAnchorMessage());
    insertAt = 1;
  }
  messages.splice(insertAt, 0, ...transientSkillMessages);
}

export function buildTransientSkillMessagesWithAudit(skillState: SessionSkillState,
  skillContents: ReadonlyMap<string, string>,
  skillDependencies?: ReadonlyMap<string, readonly string[]> | null,
  tokenBudget?: number | null, alreadyInjected: ReadonlySet<string> = new Set()):
  TransientSkillMessages {
  const result: TransientSkillMessages = {
    messages: [],
    audit: {
      injectedSkillIds: [], droppedSkillIds: [], missingSkillIds: [],
      estimatedTokens: 0, skillStateVersion: skillState.version,
    },
  };

  const ordered = orderedSkillIdsForInjection(skillState, skillDependencies, alreadyInjected);
  if (ordered.length === 0) return result;

  let remainingBudget = tokenBudget ?? Number.MAX_SAFE_INTEGER;
  for (const [skillId] of ordered) {
    const content = skillContents.get(skillId);
    if (content === undefined) {
      result.audit.missingSkillIds.push(skillId);
      continue;
    }
    const message = makeTransientSkillMessage(skillId, content);
    const estimatedTokens = estimateTokens(message.content);
    if (estimatedTokens > remainingBudget) {
      result.audit.droppedSkillIds.push(skillId);
      continue;
    }
    remainingBudget -= estimatedTokens;
    result.audit.estimatedTokens += estimatedTokens;
    result.audit.injectedSkillIds.push(skillId);
    result.messages.push(message);
  }
  return result;
}

export function buildTransientSkillMessages(skillState: SessionSkillState,
  skillContents: ReadonlyMap<string, string>,
  skillDependencies?: ReadonlyMap<string, readonly string[]> | null,
  tokenBudget?: number | null): LegacyChatMessage[] {
  return buildTransientSkillMessagesWithAudit(skillState, skillContents, skillDependencies,
    tokenBudget).messages;
}

/** Skill id carried by a transient skill message, when it is one. */
export function transientSkillMessageSkillId(message: LegacyChatMessage): string | null {
  if (!isTransientSkillMessage(message)) return null;
  const metadata = message.metadata;
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const skillId = (metadata as Record<string, unknown>).skillId;
  return typeof skillId === 'string' ? skillId : null;
}

/** Skill ids already anchored in replay history. */
export function anchoredSkillIdsInHistory(
  history: readonly LegacyChatMessage[]): Set<string> {
  const anchored = new Set<string>();
  for (const message of history) {
    const skillId = transientSkillMessageSkillId(message);
    if (skillId !== null) anchored.add(skillId);
  }
  return anchored;
}

/**
 * history.rs::rebuild_anchored_skill_messages — rebuilds replay bytes with the
 * same renderer as the live path. Missing bodies are skipped (never forged).
 */
export function rebuildAnchoredSkillMessages(skillIds: readonly string[],
  skillContents: ReadonlyMap<string, string> | null | undefined): LegacyChatMessage[] {
  return rebuildAnchoredSkillMessagesGated(skillIds, skillContents, null);
}

/** turn-level and tool-level replay anchors (types::SkillInjectionAnchors). */
export interface ToolAnchoredSkills {
  toolCallId: string;
  skillIds: string[];
  roundLastToolCallId?: string | null;
}

export interface SkillInjectionAnchors {
  turnSkillIds: string[];
  beforeTurnUser: boolean;
  toolAnchored: ToolAnchoredSkills[];
  /** skill_id -> sha256 hex captured when the anchor was written. */
  skillContentDigests: ReadonlyMap<string, string>;
  skillContentRev?: number | null;
}

/** types::skill_body_digest: sha256(id, 0x1f, body, 0x1e), lowercase hex. */
export function skillBodyDigest(skillId: string, body: string): string {
  const hash = createHasherSync('SHA-256');
  hash.update(skillId);
  hash.update(Uint8Array.from([0x1f]));
  hash.update(body);
  hash.update(Uint8Array.from([0x1e]));
  return hash.digestHex();
}

/** serde `rename_all = "camelCase"` plus `skip_serializing_if` for anchors. */
export function serializeSkillInjectionAnchors(anchors: SkillInjectionAnchors): string {
  const wire: Record<string, unknown> = {};
  if (anchors.turnSkillIds.length > 0) wire.turnSkillIds = anchors.turnSkillIds;
  if (anchors.beforeTurnUser) wire.beforeTurnUser = true;
  if (anchors.toolAnchored.length > 0) {
    wire.toolAnchored = anchors.toolAnchored.map(entry => {
      const toolWire: Record<string, unknown> = {
        toolCallId: entry.toolCallId,
        skillIds: entry.skillIds,
      };
      if (entry.roundLastToolCallId !== undefined && entry.roundLastToolCallId !== null) {
        toolWire.roundLastToolCallId = entry.roundLastToolCallId;
      }
      return toolWire;
    });
  }
  if (anchors.skillContentDigests.size > 0) {
    wire.skillContentDigests = Object.fromEntries(anchors.skillContentDigests);
  }
  if (anchors.skillContentRev !== undefined && anchors.skillContentRev !== null) {
    wire.skillContentRev = anchors.skillContentRev;
  }
  return JSON.stringify(wire);
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every(entry => typeof entry === 'string') ? [...value] as string[] : null;
}

/** Missing fields default exactly like serde `#[serde(default)]`. */
export function parseSkillInjectionAnchors(raw: string): SkillInjectionAnchors | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const record = recordOf(value);
  if (record === null) return null;

  const turnSkillIds = record.turnSkillIds === undefined
    ? [] : stringArray(record.turnSkillIds);
  const beforeTurnUser = record.beforeTurnUser === undefined
    ? false : record.beforeTurnUser === true;
  if (turnSkillIds === null) return null;
  if (record.beforeTurnUser !== undefined && typeof record.beforeTurnUser !== 'boolean') {
    return null;
  }

  const toolAnchored: ToolAnchoredSkills[] = [];
  if (record.toolAnchored !== undefined) {
    if (!Array.isArray(record.toolAnchored)) return null;
    for (const entry of record.toolAnchored) {
      const tool = recordOf(entry);
      if (tool === null || typeof tool.toolCallId !== 'string') return null;
      const skillIds = tool.skillIds === undefined ? [] : stringArray(tool.skillIds);
      if (skillIds === null) return null;
      const roundLast = tool.roundLastToolCallId;
      if (roundLast !== undefined && roundLast !== null && typeof roundLast !== 'string') {
        return null;
      }
      toolAnchored.push({
        toolCallId: tool.toolCallId,
        skillIds,
        roundLastToolCallId: typeof roundLast === 'string' ? roundLast : null,
      });
    }
  }

  const skillContentDigests = new Map<string, string>();
  if (record.skillContentDigests !== undefined) {
    const digests = recordOf(record.skillContentDigests);
    if (digests === null) return null;
    for (const [id, digest] of Object.entries(digests)) {
      if (typeof digest !== 'string') return null;
      skillContentDigests.set(id, digest);
    }
  }

  const rev = record.skillContentRev;
  if (rev !== undefined && rev !== null && typeof rev !== 'number') return null;

  return {
    turnSkillIds,
    beforeTurnUser,
    toolAnchored,
    skillContentDigests,
    ...(typeof rev === 'number' ? { skillContentRev: rev } : {}),
  };
}

/**
 * Digest-gated replay: an anchor that recorded a body digest only rebuilds when
 * the current body still matches. A mismatch skips (never forges old history
 * bytes from an edited body) and reports the skill id once. Legacy anchors
 * without a digest keep the old "rebuild whenever the body exists" behaviour.
 */
export function rebuildAnchoredSkillMessagesGated(skillIds: readonly string[],
  skillContents: ReadonlyMap<string, string> | null | undefined,
  anchors: SkillInjectionAnchors | null | undefined,
  mismatchedSkillIds: string[] = [], logger?: { warn(message: string): void }): LegacyChatMessage[] {
  const restored: LegacyChatMessage[] = [];
  for (const skillId of skillIds) {
    const content = skillContents?.get(skillId);
    if (content === undefined) {
      logger?.warn(`[ChatV2::pipeline] P1-8: anchored skill '${skillId}' has no content in this request; replay prefix may drift at its position`);
      continue;
    }

    const stored = anchors?.skillContentDigests.get(skillId);
    const current = stored === undefined ? undefined : skillBodyDigest(skillId, content);
    if (stored !== undefined && current !== stored) {
      logger?.warn(`[ChatV2::pipeline] P1-8: anchored skill '${skillId}' content digest mismatch (anchored=${stored}, current=${current}); skipping rebuild instead of forging history with the edited body — replay prefix will drift at its position`);
      if (!mismatchedSkillIds.includes(skillId)) mismatchedSkillIds.push(skillId);
      continue;
    }
    restored.push(makeTransientSkillMessage(skillId, content));
  }
  return restored;
}

/** In-loop `load_skills` batch, excluding skills already injected this request. */
export function buildInLoopSkillMessages(loadedSkillIds: readonly string[],
  skillContents: ReadonlyMap<string, string>,
  skillDependencies: ReadonlyMap<string, readonly string[]> | null | undefined,
  tokenBudget: number | null | undefined, alreadyInjected: ReadonlySet<string>,
  skillStateVersion: number): TransientSkillMessages {
  const batchState: SessionSkillState = {
    manualPinnedSkillIds: [],
    modeRequiredBundleIds: [],
    agenticSessionSkillIds: loadedSkillIds,
    branchLocalSkillIds: [],
    version: skillStateVersion,
  };
  return buildTransientSkillMessagesWithAudit(batchState, skillContents, skillDependencies,
    tokenBudget, alreadyInjected);
}

/**
 * Appends in-loop skill messages after the round's last tool result (falling
 * back to the triggering result, then to the tail). Inserting mid-round would
 * split parallel tool-call groups and drop reasoning_content.
 */
export function insertSkillMessagesAfterToolResult(messages: LegacyChatMessage[],
  toolCallId: string, roundLastToolCallId: string | null | undefined,
  skillMessages: readonly LegacyChatMessage[]): void {
  if (skillMessages.length === 0) return;

  const locateAfterToolResult = (callId: string): number | null => {
    for (let index = messages.length - 1; index >= 0; index--) {
      const result = messages[index]!.tool_result;
      if (result !== undefined && result !== null && result.call_id === callId) return index + 1;
    }
    return null;
  };

  let insertAt = (roundLastToolCallId !== null && roundLastToolCallId !== undefined
    ? locateAfterToolResult(roundLastToolCallId)
    : null)
    ?? locateAfterToolResult(toolCallId)
    ?? messages.length;
  while (insertAt < messages.length && isTransientSkillMessage(messages[insertAt]!)) {
    insertAt += 1;
  }
  messages.splice(insertAt, 0, ...skillMessages);
}
