/**
 * pipeline/persistence.rs — pure helpers shared by the save paths.
 *
 * Skill bodies are transient request data: replay snapshots keep the
 * lightweight affordances (ids, dependencies, embedded tools) but never the
 * instruction text. Cited-memory ids turn rendered `[记忆-N]` citations back
 * into real note ids so retrieval usage can be observed per reply.
 */
import type { SendOptions } from '../../../../contracts/ipc/generated/_shared.ts';
import type { ReplaySkillPayloadSnapshot } from '../../../../contracts/ipc/generated/L04-chat-session.ts';

/**
 * Backend-only send options that are `#[serde(skip)]` on the Rust struct and
 * therefore absent from the generated frontend contract.
 */
export type BackendSendOptions = SendOptions & {
  /** types.rs:2157, serde(skip): persona selection must never capability-fallback. */
  strictModelId?: boolean;
  executionAllowedTools?: string[] | null;
  userMessageOrigin?: unknown | null;
  streamGeneration?: number | bigint | null;
  skillInjectionAnchors?: import('../../chat/api.ts').SkillInjectionAnchors | null;
};

/** types::ReplaySkillPayloadSnapshot::without_skill_contents. */
export function buildReplaySkillPayloadSnapshot(
  options: BackendSendOptions,
): ReplaySkillPayloadSnapshot | null {
  const snapshot: ReplaySkillPayloadSnapshot = {
    activeSkillIds: options.activeSkillIds ?? [],
    ...(options.executionAllowedTools === undefined || options.executionAllowedTools === null
      ? {}
      : { executionAllowedTools: options.executionAllowedTools }),
    // Bodies are deliberately dropped: only ids and shapes may be persisted.
    skillContents: {},
    skillDependencies: options.skillDependencies ?? {},
    skillEmbeddedTools: options.skillEmbeddedTools ?? {},
    mcpToolSchemas: options.mcpToolSchemas ?? [],
    selectedMcpServers: options.mcpTools ?? [],
  };
  return replaySnapshotHasMetadata(snapshot) ? snapshot : null;
}

/** types::ReplaySkillPayloadSnapshot::has_replay_metadata. */
export function replaySnapshotHasMetadata(snapshot: ReplaySkillPayloadSnapshot): boolean {
  return (snapshot.activeSkillIds?.length ?? 0) > 0
    || snapshot.executionAllowedTools !== undefined
    || Object.keys(snapshot.skillDependencies ?? {}).length > 0
    || Object.keys(snapshot.skillEmbeddedTools ?? {}).length > 0
    || (snapshot.mcpToolSchemas?.length ?? 0) > 0
    || (snapshot.selectedMcpServers?.length ?? 0) > 0;
}

const CITED_MEMORY_PATTERN = /\[(?:记忆|memory)-(\d+)(?::[^\]]*)?\]/giu;
const CITED_MEMORY_TAG_PATTERN = /\[(?:记忆|memory)-(\d+)(?::[^\]]*)?\]/iu;

const U64_MAX = (1n << 64n) - 1n;

/** Rust `str::parse::<u64>()` as a set key; `null` on overflow. */
function u64Key(digits: string): string | null {
  const value = BigInt(digits);
  return value > U64_MAX ? null : value.toString();
}

function citedIndex(value: string): string | null {
  const match = value.match(CITED_MEMORY_TAG_PATTERN);
  return match === null ? null : u64Key(match[1]!);
}

function outputSources(output: unknown): unknown[] | null {
  if (output === null || typeof output !== 'object' || Array.isArray(output)) return null;
  const sources = (output as Record<string, unknown>).sources;
  return Array.isArray(sources) ? sources : null;
}

function fieldOf(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>)[key];
}

/**
 * Extracts the memory note ids actually cited by the answer.
 *
 * - `[记忆-N]` in the reply text (also `[memory-N]`, any case, optional
 *   `:suffix` before the closing bracket);
 * - matching `citationTag` entries in successful tool outputs; compressed
 *   summaries carry `noteId: null` and expose `sourceNoteIds` instead.
 *
 * Ids are deduped per reply (set semantics), preserving source order.
 * persistence.rs:252 extract_cited_memory_note_ids.
 */
export function extractCitedMemoryNoteIds(finalContent: string,
  toolResults: ReadonlyArray<{ readonly success?: boolean; readonly output?: unknown }>): string[] {
  const citedIndexes = new Set<string>();
  for (const match of finalContent.matchAll(CITED_MEMORY_PATTERN)) {
    const key = u64Key(match[1]!);
    if (key !== null) citedIndexes.add(key);
  }
  if (citedIndexes.size === 0) return [];

  const noteIds: string[] = [];
  const seen = new Set<string>();
  const pushId = (id: string): void => {
    if (id === '' || seen.has(id)) return;
    seen.add(id);
    noteIds.push(id);
  };

  for (const result of toolResults) {
    if (result.success !== true) continue;
    const sources = outputSources(result.output);
    if (sources === null) continue;

    for (const source of sources) {
      const tag = fieldOf(source, 'citationTag');
      if (typeof tag !== 'string') continue;
      const index = citedIndex(tag);
      if (index === null || !citedIndexes.has(index)) continue;

      // Regular entry: noteId (camelCase first, snake_case fallback).
      const noteId = fieldOf(source, 'noteId');
      const snakeNoteId = fieldOf(source, 'note_id');
      if (typeof noteId === 'string') pushId(noteId);
      else if (typeof snakeNoteId === 'string') pushId(snakeNoteId);

      // Compressed summary entry: real members live in sourceNoteIds.
      const sourceNoteIds = fieldOf(source, 'sourceNoteIds');
      if (Array.isArray(sourceNoteIds)) {
        for (const value of sourceNoteIds) {
          if (typeof value === 'string') pushId(value);
        }
      }
    }
  }
  return noteIds;
}
