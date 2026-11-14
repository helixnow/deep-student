/**
 * Runtime-consumable agent profiles (workspace/agent_profile.rs:8–468).
 *
 * A profile is resolved before an agent is persisted. `skill_id` remains a
 * compatibility alias; unknown values are recorded as a skill on the selected
 * profile instead of selecting a new profile.
 */
export const DEFAULT_PROFILE_ID = 'default';
export const WORKER_PROFILE_ID = 'worker';
export const EXPLORER_PROFILE_ID = 'explorer';
export const AGENT_PROFILE_METADATA_KEY = 'agent_profile';

export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export type ContextInheritance =
  | { mode: 'none' }
  | { mode: 'summary' }
  | { mode: 'last_n_turns'; turns: number }
  | { mode: 'full' };

export type SandboxMode = 'inherit' | 'read_only' | 'workspace_write' | 'danger_full_access';
export type ApprovalPolicy = 'inherit' | 'never' | 'on_request';

export interface AgentPermissions {
  sandbox: SandboxMode;
  approvalPolicy: ApprovalPolicy;
  networkAccess: boolean;
}

export interface AgentProfile {
  id: string;
  description?: string;
  instructions: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  allowedTools: string[];
  permissions: AgentPermissions;
  contextInheritance: ContextInheritance;
  skills: string[];
}

export interface AgentProfileOverride {
  instructions?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  allowedTools?: string[];
  permissions?: AgentPermissions;
  contextInheritance?: ContextInheritance;
  skills?: string[];
}

export interface AgentProfileSelection {
  profileId?: string | null;
  skillId?: string | null;
  overrides?: AgentProfileOverride;
}

/** A custom persona as loaded from `workspaces/agents/*.md`. */
export interface CustomAgentProfileDefinition {
  id: string;
  description?: string;
  instructions: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  allowedTools?: string[];
  permissions?: AgentPermissions;
  contextInheritance?: ContextInheritance;
  skills?: string[];
}

const DEFAULT_PERMISSIONS: AgentPermissions = {
  sandbox: 'inherit',
  approvalPolicy: 'inherit',
  networkAccess: false,
};

/** agent_profile.rs:190–278. */
export function builtInAgentProfile(id: string): AgentProfile | null {
  switch (id) {
    case DEFAULT_PROFILE_ID:
      return {
        id: DEFAULT_PROFILE_ID,
        description: '通用子代理：完成委派任务并向父代理返回简明结论。',
        instructions: 'Complete the delegated task and return a concise, evidence-backed result to the parent agent.',
        reasoningEffort: 'medium',
        allowedTools: [],
        permissions: { ...DEFAULT_PERMISSIONS },
        contextInheritance: { mode: 'summary' },
        skills: [],
      };
    case WORKER_PROFILE_ID:
      return {
        id: WORKER_PROFILE_ID,
        description: '执行型子代理：独立完成任务、自行验证并汇报结果。',
        instructions: 'Execute the delegated task independently. Use the available tools, verify the result, and report completion to the parent agent.',
        reasoningEffort: 'high',
        allowedTools: [],
        permissions: {
          sandbox: 'workspace_write',
          approvalPolicy: 'inherit',
          networkAccess: false,
        },
        contextInheritance: { mode: 'summary' },
        skills: [],
      };
    case EXPLORER_PROFILE_ID:
      return {
        id: EXPLORER_PROFILE_ID,
        description: '调研型子代理：只读探索与检索，产出带出处的调研结论。',
        instructions: 'Investigate the delegated question. Prefer primary evidence, keep exploration read-only, and return findings with concrete references.',
        reasoningEffort: 'high',
        allowedTools: [
          'builtin-unified_search',
          'builtin-rag_search',
          'builtin-web_search',
          'builtin-web_fetch',
          'builtin-resource_list',
          'builtin-resource_read',
          'builtin-resource_search',
          'builtin-folder_list',
          'builtin-memory_read',
          'builtin-memory_list',
        ],
        permissions: {
          sandbox: 'read_only',
          approvalPolicy: 'never',
          networkAccess: true,
        },
        contextInheritance: { mode: 'last_n_turns', turns: 8 },
        skills: [],
      };
    default:
      return null;
  }
}

function trimmedNonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function applyOverrides(profile: AgentProfile, overrides: AgentProfileOverride): void {
  if (overrides.instructions !== undefined) profile.instructions = overrides.instructions;
  if (overrides.model !== undefined) profile.model = overrides.model;
  if (overrides.reasoningEffort !== undefined) profile.reasoningEffort = overrides.reasoningEffort;
  if (overrides.allowedTools !== undefined) profile.allowedTools = overrides.allowedTools;
  if (overrides.permissions !== undefined) profile.permissions = overrides.permissions;
  if (overrides.contextInheritance !== undefined) {
    profile.contextInheritance = overrides.contextInheritance;
  }
  if (overrides.skills !== undefined) profile.skills = overrides.skills;
}

function normalizeIds(values: string[], label: string): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    if (value === '') throw new Error(`Agent profile ${label} id must not be empty`);
    if (!seen.has(value)) {
      seen.add(value);
      normalized.push(value);
    }
  }
  return normalized;
}

/** agent_profile.rs:414–452. */
function validateAndNormalize(profile: AgentProfile): void {
  profile.id = profile.id.trim();
  profile.instructions = profile.instructions.trim();
  if (profile.id === '') throw new Error('Agent profile id must not be empty');
  if (profile.instructions === '') throw new Error('Agent profile instructions must not be empty');
  if (profile.contextInheritance.mode === 'last_n_turns'
    && profile.contextInheritance.turns === 0) {
    throw new Error('last_n_turns context inheritance requires turns > 0');
  }
  if (profile.model !== undefined) {
    profile.model = profile.model.trim();
    if (profile.model === '') profile.model = undefined;
  }
  if (profile.description !== undefined) {
    profile.description = profile.description.trim();
    if (profile.description === '') profile.description = undefined;
  }
  profile.allowedTools = normalizeIds(profile.allowedTools, 'tool');
  profile.skills = normalizeIds(profile.skills, 'skill');
}

function fromCustomDefinition(definition: CustomAgentProfileDefinition): AgentProfile {
  return {
    id: definition.id,
    ...(definition.description === undefined ? {} : { description: definition.description }),
    instructions: definition.instructions,
    ...(definition.model === undefined ? {} : { model: definition.model }),
    ...(definition.reasoningEffort === undefined
      ? {} : { reasoningEffort: definition.reasoningEffort }),
    allowedTools: [...(definition.allowedTools ?? [])],
    permissions: definition.permissions ?? { ...DEFAULT_PERMISSIONS },
    contextInheritance: definition.contextInheritance ?? { mode: 'summary' },
    skills: [...(definition.skills ?? [])],
  };
}

export interface ResolveAgentProfileOptions {
  /** Custom personas already loaded from `workspaces/agents/*.md`. */
  customProfiles?: readonly CustomAgentProfileDefinition[];
}

/**
 * agent_profile.rs:280–315. Explicit `profile_id` wins; a known built-in
 * `skill_id` acts as a legacy alias; otherwise the worker profile is selected.
 */
export function resolveAgentProfile(
  selection: AgentProfileSelection,
  options: ResolveAgentProfileOptions = {},
): AgentProfile {
  const legacySkill = trimmedNonEmpty(selection.skillId);
  const explicitId = trimmedNonEmpty(selection.profileId);
  const selectedId = explicitId
    ?? (legacySkill !== null && builtInAgentProfile(legacySkill) !== null ? legacySkill : null)
    ?? WORKER_PROFILE_ID;

  const customProfiles = options.customProfiles ?? [];
  const builtIn = builtInAgentProfile(selectedId);
  const custom = builtIn === null
    ? customProfiles.find((profile) => profile.id === selectedId)
    : undefined;
  if (builtIn === null && custom === undefined) {
    const available = [DEFAULT_PROFILE_ID, WORKER_PROFILE_ID, EXPLORER_PROFILE_ID,
      ...customProfiles.map((profile) => profile.id)];
    throw new Error(`Unknown agent profile: ${selectedId}. Available profiles: ${available.join(', ')}`);
  }

  const profile = builtIn !== null ? builtIn : fromCustomDefinition(custom!);
  if (legacySkill !== null && builtInAgentProfile(legacySkill) === null) {
    profile.skills.push(legacySkill);
  }
  applyOverrides(profile, selection.overrides ?? {});
  validateAndNormalize(profile);
  return profile;
}
