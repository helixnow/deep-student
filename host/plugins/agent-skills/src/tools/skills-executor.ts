/**
 * `load_skills` meta-tool executor, ported from
 * `src-tauri/crates/dstu-agent/src/chat_v2/tools/skills_executor.rs`.
 *
 * The executor is deliberately thin: it validates the request against the
 * trusted runtime catalog and returns a lightweight receipt. The front end and
 * the next-turn transient injection own the actual skill bodies.
 */

export const LOAD_SKILLS_TOOL_NAME = 'load_skills';
export const BUILTIN_LOAD_SKILLS_TOOL_NAME = 'builtin-load_skills';

export interface LoadedToolOutput {
  /** Registered tool name. */
  name: string;
  /** Skill that provides the tool, so the front end can tell builtin from third-party. */
  skill_id: string;
}

export interface LoadSkillsOutput {
  status: 'success' | 'error';
  requested_skill_ids: string[];
  loaded_skill_ids: string[];
  newly_loaded_skill_ids: string[];
  already_loaded_skill_ids: string[];
  missing_skill_ids: string[];
  available_skill_ids: string[];
  loaded_tool_names: string[];
  loaded_tools: LoadedToolOutput[];
  rejected_skill_ids: string[];
  rejected_skills: Record<string, string>;
  skill_state_version: number;
  message: string;
}

/**
 * `deserialize_string_or_vec`: some models (e.g. Gemini) serialise an array
 * argument as a JSON string. Accept both spellings.
 */
export function parseSkillsArgument(value: unknown): string[] {
  if (typeof value === 'string') {
    let parsed: unknown;
    try { parsed = JSON.parse(value); }
    catch {
      throw new Error(
        `invalid stringified array: '${value}', expected a JSON array string like '["a", "b"]'`,
      );
    }
    if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) {
      throw new Error(
        `invalid stringified array: '${value}', expected a JSON array string like '["a", "b"]'`,
      );
    }
    return parsed as string[];
  }
  if (!Array.isArray(value)) throw new Error('skills must be an array of strings or a JSON array string');
  for (const item of value) {
    if (typeof item !== 'string') throw new Error('skills must contain only strings');
  }
  return [...value];
}

export function classifyRequestedSkills(
  requested: readonly string[],
  skillContents: ReadonlyMap<string, string> | null | undefined,
  admissionErrors: ReadonlyMap<string, string> | null | undefined,
): { loaded: string[]; notFound: string[]; rejected: Map<string, string> } {
  const loaded: string[] = [];
  const notFound: string[] = [];
  const rejected = new Map<string, string>();
  for (const skillId of requested) {
    const reason = admissionErrors?.get(skillId);
    if (reason !== undefined) rejected.set(skillId, reason);
    else if (skillContents?.has(skillId) === true) loaded.push(skillId);
    else notFound.push(skillId);
  }
  return { loaded, notFound, rejected };
}

/**
 * Exact loadable IDs from the trusted runtime catalog. Rejected IDs can never
 * appear; no fuzzy matching or aliases are invented.
 */
export function collectAvailableRuntimeSkillIds(
  skillContents: ReadonlyMap<string, string> | null | undefined,
  admissionErrors: ReadonlyMap<string, string> | null | undefined,
): string[] {
  if (skillContents === null || skillContents === undefined) return [];
  const ids = [...skillContents.keys()]
    .filter(id => id.trim() !== '')
    .filter(id => admissionErrors?.has(id) !== true);
  ids.sort();
  return ids.filter((id, index) => index === 0 || id !== ids[index - 1]!);
}

export function formatAvailableSkillIdsHint(available: readonly string[]): string {
  return available.length === 0
    ? 'The trusted runtime catalog currently contains no loadable skill IDs.'
    : `Available skill IDs (trusted runtime, exact): ${available.join(', ')}`;
}

export function buildLoadSkillsMessage(
  loaded: readonly string[],
  alreadyLoaded: readonly string[],
  missing: readonly string[],
  rejected: ReadonlyMap<string, string>,
  available: readonly string[],
  hasUntrustedRejection: boolean,
  includeAvailableHint: boolean,
): string {
  const parts: string[] = [];
  const hasProblem = missing.length > 0 || rejected.size > 0;

  if (loaded.length === 0 && hasProblem) parts.push('No skills loaded.');
  else if (loaded.length === 0) parts.push('No skills were requested.');
  else if (alreadyLoaded.length === loaded.length) parts.push('Skills already loaded.');
  else parts.push('Skills loaded. Instructions will be provided in the next message.');

  if (alreadyLoaded.length > 0) parts.push(`Already loaded: ${alreadyLoaded.join(', ')}`);
  if (missing.length > 0) parts.push(`Missing: ${missing.join(', ')}`);
  if (rejected.size > 0) {
    const entries = [...rejected.entries()]
      .map(([id, reason]) => `${id} (${reason})`)
      .sort();
    parts.push(`Rejected: ${entries.join(', ')}`);
  }

  // Failed tool results are fed back as `Error: {message}` only; the exact IDs
  // must therefore live in the message itself.
  if (includeAvailableHint) {
    parts.push(formatAvailableSkillIdsHint(available));
    parts.push(
      'Retry load_skills only with exact IDs copied from that list or from <available_skills>; '
      + 'do not guess, translate, shorten, or invent IDs.',
    );
  }
  if (hasUntrustedRejection) {
    parts.push(
      'If trust was granted earlier in this same tool loop, this is the immutable pre-grant '
      + 'runtime catalog snapshot, not a failed grant. Do not retry load_skills in this request; '
      + 'the trusted package becomes loadable on the next user turn.',
    );
  }
  return parts.join(' ');
}

export interface LoadSkillsOutcomeInput {
  requestedSkillIds: readonly string[];
  loadedSkillIds: readonly string[];
  alreadyLoadedSkillIds: readonly string[];
  missingSkillIds: readonly string[];
  rejectedSkills: ReadonlyMap<string, string>;
  availableSkillIds: readonly string[];
  sessionLoadedSkillIds: readonly string[];
  loadedTools: readonly LoadedToolOutput[];
  skillStateVersion: number;
  hasUntrustedRejection: boolean;
  includeAvailableHint: boolean;
}

export function buildLoadSkillsOutput(outcome: LoadSkillsOutcomeInput): LoadSkillsOutput {
  const newlyLoaded = outcome.loadedSkillIds.filter(
    id => !outcome.alreadyLoadedSkillIds.includes(id),
  );
  const rejectedSkillIds = [...outcome.rejectedSkills.keys()].sort();
  const loadedToolNames = [...new Set(outcome.loadedTools.map(tool => tool.name))].sort();

  const message = buildLoadSkillsMessage(
    outcome.loadedSkillIds,
    outcome.alreadyLoadedSkillIds,
    outcome.missingSkillIds,
    outcome.rejectedSkills,
    outcome.availableSkillIds,
    outcome.hasUntrustedRejection,
    outcome.includeAvailableHint,
  );
  const allFailed = outcome.loadedSkillIds.length === 0
    && (outcome.missingSkillIds.length > 0 || outcome.rejectedSkills.size > 0);
  const emptyRequest = outcome.requestedSkillIds.length === 0
    && outcome.loadedSkillIds.length === 0;

  return {
    status: allFailed || emptyRequest ? 'error' : 'success',
    requested_skill_ids: [...outcome.requestedSkillIds],
    loaded_skill_ids: [...outcome.sessionLoadedSkillIds],
    newly_loaded_skill_ids: newlyLoaded,
    already_loaded_skill_ids: [...outcome.alreadyLoadedSkillIds],
    missing_skill_ids: [...outcome.missingSkillIds],
    available_skill_ids: [...outcome.availableSkillIds],
    loaded_tool_names: loadedToolNames,
    loaded_tools: outcome.loadedTools.map(tool => ({ name: tool.name, skill_id: tool.skill_id })),
    rejected_skill_ids: rejectedSkillIds,
    rejected_skills: Object.fromEntries(rejectedSkillIds.map(id => [id, outcome.rejectedSkills.get(id)!])),
    skill_state_version: outcome.skillStateVersion,
    message,
  };
}

function stripPrefix(toolName: string): string {
  if (toolName.startsWith('builtin-')) return toolName.slice('builtin-'.length);
  if (toolName.startsWith('builtin:')) return toolName.slice('builtin:'.length);
  if (toolName.startsWith('mcp_')) return toolName.slice('mcp_'.length);
  return toolName;
}

export class SkillsExecutor {
  static readonly name = 'SkillsExecutor';

  static isLoadSkillsTool(toolName: string): boolean {
    return stripPrefix(toolName) === LOAD_SKILLS_TOOL_NAME;
  }

  static stripPrefix(toolName: string): string {
    return stripPrefix(toolName);
  }

  canHandle(toolName: string): boolean {
    return SkillsExecutor.isLoadSkillsTool(toolName);
  }

  name(): string {
    return SkillsExecutor.name;
  }

  sensitivityLevel(_toolName: string): 'low' {
    return 'low';
  }
}
