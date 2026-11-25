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
  targetVariantId?: string | null;
  skillInjectionAnchors?: import('../../chat/api.ts').SkillInjectionAnchors | null;
};

function collectRelevantSkillIds(options: BackendSendOptions): Set<string> {
  const relevant = new Set<string>();
  for (const id of options.activeSkillIds ?? []) {
    if (typeof id === 'string' && id.length > 0) relevant.add(id);
  }
  const anchors = options.skillInjectionAnchors;
  if (anchors != null) {
    for (const id of anchors.turnSkillIds ?? []) {
      if (typeof id === 'string' && id.length > 0) relevant.add(id);
    }
    for (const entry of anchors.toolAnchored ?? []) {
      for (const id of entry.skillIds ?? []) {
        if (typeof id === 'string' && id.length > 0) relevant.add(id);
      }
    }
  }
  const activeToolNames = new Set(
    (options.mcpToolSchemas ?? [])
      .map(schema => schema?.name)
      .filter((name): name is string => typeof name === 'string' && name.length > 0),
  );
  if (activeToolNames.size > 0 && options.skillEmbeddedTools != null) {
    for (const [skillId, tools] of Object.entries(options.skillEmbeddedTools)) {
      if (Array.isArray(tools) && tools.some(tool => typeof tool?.name === 'string' && activeToolNames.has(tool.name))) {
        relevant.add(skillId);
      }
    }
  }
  const dependencies = options.skillDependencies;
  if (dependencies != null && relevant.size > 0) {
    const queue = [...relevant];
    while (queue.length > 0) {
      const skillId = queue.pop()!;
      for (const dep of dependencies[skillId] ?? []) {
        if (typeof dep === 'string' && dep.length > 0 && !relevant.has(dep)) {
          relevant.add(dep);
          queue.push(dep);
        }
      }
    }
  }
  return relevant;
}

function pickRecordKeys<T>(
  record: Record<string, T> | null | undefined,
  keys: ReadonlySet<string>,
): Record<string, T> {
  if (record == null || keys.size === 0) return {};
  const filtered: Record<string, T> = {};
  for (const [key, value] of Object.entries(record)) {
    if (keys.has(key)) filtered[key] = value;
  }
  return filtered;
}

/** types::ReplaySkillPayloadSnapshot::without_skill_contents. */
export function buildReplaySkillPayloadSnapshot(
  options: BackendSendOptions,
): ReplaySkillPayloadSnapshot | null {
  // Frontend sends the entire runtime-admitted skill catalog (~287 KB of schemas)
  // transiently so the backend can service lazy `load_skills` calls mid-turn.
  // Persist only skills that were actually active or loaded during this turn so
  // message meta_json and multi-variant variants_json never bloat past size caps.
  const relevantSkillIds = collectRelevantSkillIds(options);
  const snapshot: ReplaySkillPayloadSnapshot = {
    activeSkillIds: options.activeSkillIds ?? [],
    ...(options.executionAllowedTools === undefined || options.executionAllowedTools === null
      ? {}
      : { executionAllowedTools: options.executionAllowedTools }),
    // Bodies are deliberately dropped: only ids and shapes may be persisted.
    skillContents: {},
    skillDependencies: pickRecordKeys(options.skillDependencies, relevantSkillIds),
    skillEmbeddedTools: pickRecordKeys(options.skillEmbeddedTools, relevantSkillIds),
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
