// workspace/agent_profile.rs —— 运行时可消费的 agent profile。
//
// profile 在 agent 落库前解析；`skill_id` 仅作为兼容别名保留，不再充当运行时配置。
import type { JsonValue, WorkspaceAgent } from '../../api.ts';
import type { ToolScope } from './grants.ts';
import { scopesFromAllowedTools } from './grants.ts';
import { sha256Hex } from './util.ts';
import { rustTrim } from '../../../../platform/util/portable.ts';
import { silentWorkspaceLogger, type WorkspaceLogger } from './logger.ts';

export const DEFAULT_PROFILE_ID = 'default';
export const WORKER_PROFILE_ID = 'worker';
export const EXPLORER_PROFILE_ID = 'explorer';
export const AGENT_PROFILE_METADATA_KEY = 'agent_profile';

export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export function reasoningEffortAsStr(effort: ReasoningEffort): string {
  return effort;
}

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

export function defaultAgentPermissions(): AgentPermissions {
  return { sandbox: 'inherit', approvalPolicy: 'inherit', networkAccess: false };
}

export interface AgentProfile {
  id: string;
  description: string | null;
  instructions: string;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  allowedTools: string[];
  permissions: AgentPermissions;
  contextInheritance: ContextInheritance;
  skills: string[];
}

/** profile 解析后的确切运行时配置（对应 `AgentRuntimeConfig`）。 */
export interface AgentRuntimeConfig {
  systemInstructions: string;
  modelId: string | null;
  reasoningEffort: ReasoningEffort | null;
  allowedTools: string[];
  permissions: AgentPermissions;
  contextInheritance: ContextInheritance;
  skillIds: string[];
}

export interface AgentProfileOverride {
  instructions?: string | null;
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  allowedTools?: string[] | null;
  permissions?: AgentPermissions | null;
  contextInheritance?: ContextInheritance | null;
  skills?: string[] | null;
}

export interface AgentProfileSelection {
  profileId?: string | null;
  /** 旧调用方兼容输入：已知别名选 profile，未知值作为技能挂到选中的 profile 上。 */
  skillId?: string | null;
  overrides?: AgentProfileOverride;
}

function clonePermissions(permissions: AgentPermissions): AgentPermissions {
  return {
    sandbox: permissions.sandbox,
    approvalPolicy: permissions.approvalPolicy,
    networkAccess: permissions.networkAccess,
  };
}

function cloneContextInheritance(value: ContextInheritance): ContextInheritance {
  return value.mode === 'last_n_turns' ? { mode: 'last_n_turns', turns: value.turns } : { mode: value.mode };
}

function cloneProfile(profile: AgentProfile): AgentProfile {
  return {
    id: profile.id,
    description: profile.description,
    instructions: profile.instructions,
    model: profile.model,
    reasoningEffort: profile.reasoningEffort,
    allowedTools: [...profile.allowedTools],
    permissions: clonePermissions(profile.permissions),
    contextInheritance: cloneContextInheritance(profile.contextInheritance),
    skills: [...profile.skills],
  };
}

function builtInProfile(id: string): AgentProfile | null {
  switch (id) {
    case DEFAULT_PROFILE_ID:
      return {
        id: DEFAULT_PROFILE_ID,
        description: '通用子代理：完成委派任务并向父代理返回简明结论。',
        instructions: 'Complete the delegated task and return a concise, evidence-backed result to the parent agent.',
        model: null,
        reasoningEffort: 'medium',
        allowedTools: [],
        permissions: defaultAgentPermissions(),
        contextInheritance: { mode: 'summary' },
        skills: [],
      };
    case WORKER_PROFILE_ID:
      return {
        id: WORKER_PROFILE_ID,
        description: '执行型子代理：独立完成任务、自行验证并汇报结果。',
        instructions: 'Execute the delegated task independently. Use the available tools, verify the result, and report completion to the parent agent.',
        model: null,
        reasoningEffort: 'high',
        allowedTools: [],
        permissions: { sandbox: 'workspace_write', approvalPolicy: 'inherit', networkAccess: false },
        contextInheritance: { mode: 'summary' },
        skills: [],
      };
    case EXPLORER_PROFILE_ID:
      return {
        id: EXPLORER_PROFILE_ID,
        description: '调研型子代理：只读探索与检索，产出带出处的调研结论。',
        instructions: 'Investigate the delegated question. Prefer primary evidence, keep exploration read-only, and return findings with concrete references.',
        model: null,
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
        permissions: { sandbox: 'read_only', approvalPolicy: 'never', networkAccess: true },
        contextInheritance: { mode: 'last_n_turns', turns: 8 },
        skills: [],
      };
    default:
      return null;
  }
}

const REASONING_EFFORTS: readonly ReasoningEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh'];
const SANDBOX_MODES: readonly SandboxMode[] = ['inherit', 'read_only', 'workspace_write', 'danger_full_access'];
const APPROVAL_POLICIES: readonly ApprovalPolicy[] = ['inherit', 'never', 'on_request'];
const CONTEXT_MODES = ['none', 'summary', 'last_n_turns', 'full'] as const;

function isRecord(value: JsonValue | unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: JsonValue | undefined, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map(item => {
    if (typeof item !== 'string') throw new Error(`${field} entries must be strings`);
    return item;
  });
}

function optionalString(value: JsonValue | undefined, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  return value;
}

function parseReasoningEffort(value: JsonValue | undefined): ReasoningEffort | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' && (REASONING_EFFORTS as readonly string[]).includes(value)) {
    return value as ReasoningEffort;
  }
  throw new Error(`unknown variant \`${String(value)}\`, expected one of ${REASONING_EFFORTS.join(', ')}`);
}

function parsePermissions(value: JsonValue | undefined): AgentPermissions {
  if (value === undefined || value === null) return defaultAgentPermissions();
  if (!isRecord(value)) throw new Error('permissions must be an object');
  const sandboxRaw = value['sandbox'];
  const approvalRaw = value['approvalPolicy'];
  const networkRaw = value['networkAccess'];
  const sandbox = sandboxRaw === undefined ? 'inherit' : sandboxRaw;
  if (typeof sandbox !== 'string' || !(SANDBOX_MODES as readonly string[]).includes(sandbox)) {
    throw new Error(`unknown variant \`${String(sandbox)}\`, expected one of ${SANDBOX_MODES.join(', ')}`);
  }
  const approval = approvalRaw === undefined ? 'inherit' : approvalRaw;
  if (typeof approval !== 'string' || !(APPROVAL_POLICIES as readonly string[]).includes(approval)) {
    throw new Error(`unknown variant \`${String(approval)}\`, expected one of ${APPROVAL_POLICIES.join(', ')}`);
  }
  if (networkRaw !== undefined && typeof networkRaw !== 'boolean') throw new Error('networkAccess must be a boolean');
  return {
    sandbox: sandbox as SandboxMode,
    approvalPolicy: approval as ApprovalPolicy,
    networkAccess: networkRaw === true,
  };
}

function parseContextInheritance(value: JsonValue | undefined): ContextInheritance {
  if (value === undefined || value === null) return { mode: 'summary' };
  if (!isRecord(value)) throw new Error('contextInheritance must be an object');
  const mode = value['mode'];
  if (typeof mode !== 'string') throw new Error('contextInheritance.mode must be a string');
  if (!(CONTEXT_MODES as readonly string[]).includes(mode)) {
    throw new Error(`unknown variant \`${mode}\`, expected one of ${CONTEXT_MODES.join(', ')}`);
  }
  if (mode === 'last_n_turns') {
    const turns = value['turns'];
    if (typeof turns !== 'number' || !Number.isInteger(turns) || turns < 0) {
      throw new Error('contextInheritance.turns must be an unsigned integer');
    }
    return { mode: 'last_n_turns', turns };
  }
  return { mode: mode as 'none' | 'summary' | 'full' };
}

/** serde 形状的 JSON → `AgentProfile`（缺失字段走 serde default）。 */
export function agentProfileFromJson(value: JsonValue): AgentProfile {
  if (!isRecord(value)) throw new Error('invalid type: expected struct AgentProfile');
  const id = value['id'];
  const instructions = value['instructions'];
  if (typeof id !== 'string') throw new Error('missing field `id`');
  if (typeof instructions !== 'string') throw new Error('missing field `instructions`');
  return {
    id,
    description: optionalString(value['description'], 'description'),
    instructions,
    model: optionalString(value['model'], 'model'),
    reasoningEffort: parseReasoningEffort(value['reasoningEffort']),
    allowedTools: stringArray(value['allowedTools'], 'allowedTools'),
    permissions: parsePermissions(value['permissions']),
    contextInheritance: parseContextInheritance(value['contextInheritance']),
    skills: stringArray(value['skills'], 'skills'),
  };
}

/** serde 形状（字段顺序与 Rust 结构体声明一致，None 字段省略）。 */
export function agentProfileToJson(profile: AgentProfile): Record<string, JsonValue> {
  const object: Record<string, JsonValue> = { id: profile.id };
  if (profile.description !== null) object['description'] = profile.description;
  object['instructions'] = profile.instructions;
  if (profile.model !== null) object['model'] = profile.model;
  if (profile.reasoningEffort !== null) object['reasoningEffort'] = profile.reasoningEffort;
  object['allowedTools'] = [...profile.allowedTools];
  object['permissions'] = {
    sandbox: profile.permissions.sandbox,
    approvalPolicy: profile.permissions.approvalPolicy,
    networkAccess: profile.permissions.networkAccess,
  };
  object['contextInheritance'] = profile.contextInheritance.mode === 'last_n_turns'
    ? { mode: 'last_n_turns', turns: profile.contextInheritance.turns }
    : { mode: profile.contextInheritance.mode };
  object['skills'] = [...profile.skills];
  return object;
}

export function runtimeConfigFromProfile(profile: AgentProfile): AgentRuntimeConfig {
  return {
    systemInstructions: profile.instructions,
    modelId: profile.model,
    reasoningEffort: profile.reasoningEffort,
    allowedTools: [...profile.allowedTools],
    permissions: clonePermissions(profile.permissions),
    contextInheritance: cloneContextInheritance(profile.contextInheritance),
    skillIds: [...profile.skills],
  };
}

function normalizeIds(values: string[], label: string): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    const trimmed = rustTrim(value);
    if (trimmed.length === 0) throw new Error(`Agent profile ${label} id must not be empty`);
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      normalized.push(trimmed);
    }
  }
  return normalized;
}

function applyOverrides(profile: AgentProfile, overrides: AgentProfileOverride): void {
  if (overrides.instructions !== undefined && overrides.instructions !== null) {
    profile.instructions = overrides.instructions;
  }
  if (overrides.model !== undefined && overrides.model !== null) profile.model = overrides.model;
  if (overrides.reasoningEffort !== undefined && overrides.reasoningEffort !== null) {
    profile.reasoningEffort = overrides.reasoningEffort;
  }
  if (overrides.allowedTools !== undefined && overrides.allowedTools !== null) {
    profile.allowedTools = overrides.allowedTools;
  }
  if (overrides.permissions !== undefined && overrides.permissions !== null) {
    profile.permissions = clonePermissions(overrides.permissions);
  }
  if (overrides.contextInheritance !== undefined && overrides.contextInheritance !== null) {
    profile.contextInheritance = cloneContextInheritance(overrides.contextInheritance);
  }
  if (overrides.skills !== undefined && overrides.skills !== null) {
    profile.skills = overrides.skills;
  }
}

function validateAndNormalize(profile: AgentProfile): void {
  profile.id = rustTrim(profile.id);
  profile.instructions = rustTrim(profile.instructions);
  if (profile.id.length === 0) throw new Error('Agent profile id must not be empty');
  if (profile.instructions.length === 0) throw new Error('Agent profile instructions must not be empty');
  if (profile.contextInheritance.mode === 'last_n_turns' && profile.contextInheritance.turns === 0) {
    throw new Error('last_n_turns context inheritance requires turns > 0');
  }
  if (profile.model !== null) {
    profile.model = rustTrim(profile.model);
    if (profile.model.length === 0) profile.model = null;
  }
  if (profile.description !== null) {
    profile.description = rustTrim(profile.description);
    if (profile.description.length === 0) profile.description = null;
  }
  profile.allowedTools = normalizeIds(profile.allowedTools, 'tool');
  profile.skills = normalizeIds(profile.skills, 'skill');
}

function trimmedNonEmpty(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = rustTrim(value);
  return trimmed.length === 0 ? null : trimmed;
}

/** User-defined profiles; on desktop `customProfileSource(dir)` (custom-agents.ts) rescans the directory per call. */
export interface CustomProfileSource {
  find(id: string, logger: WorkspaceLogger): AgentProfile | null;
  ids(logger: WorkspaceLogger): string[];
}

export class AgentProfileResolver {
  static builtIn(id: string): AgentProfile | null {
    return builtInProfile(id);
  }

  static resolve(selection: AgentProfileSelection): AgentProfile {
    return AgentProfileResolver.resolveWithCustom(selection, null);
  }

  /**
   * 契约 C6：解析顺序 = 显式 profile_id → 内建优先、内建没有再查 custom 目录；
   * 都没有时错误信息列出内建 + 目录里的自定义名单。
   */
  static resolveWithCustom(
    selection: AgentProfileSelection,
    customProfiles: CustomProfileSource | null,
    logger: WorkspaceLogger = silentWorkspaceLogger,
  ): AgentProfile {
    const legacySkill = trimmedNonEmpty(selection.skillId);
    const selectedId = trimmedNonEmpty(selection.profileId)
      ?? (legacySkill !== null && AgentProfileResolver.builtIn(legacySkill) !== null ? legacySkill : null)
      ?? WORKER_PROFILE_ID;
    const builtIn = AgentProfileResolver.builtIn(selectedId);
    let profile: AgentProfile;
    if (builtIn) {
      profile = builtIn;
    } else {
      const custom = customProfiles === null ? null : customProfiles.find(selectedId, logger);
      if (!custom) {
        const available: string[] = [DEFAULT_PROFILE_ID, WORKER_PROFILE_ID, EXPLORER_PROFILE_ID];
        if (customProfiles !== null) available.push(...customProfiles.ids(logger));
        throw new Error(`Unknown agent profile: ${selectedId}. Available profiles: ${available.join(', ')}`);
      }
      profile = custom;
    }

    if (legacySkill !== null && AgentProfileResolver.builtIn(legacySkill) === null) {
      profile.skills.push(legacySkill);
    }
    applyOverrides(profile, selection.overrides ?? {});
    validateAndNormalize(profile);
    return profile;
  }

  static fromMetadata(metadata: JsonValue | undefined): AgentProfile | null {
    const value = isRecord(metadata) ? metadata[AGENT_PROFILE_METADATA_KEY] : undefined;
    if (value === undefined) return null;
    let profile: AgentProfile;
    try {
      profile = agentProfileFromJson(value);
    } catch (error) {
      throw new Error(`Invalid persisted agent profile: ${error instanceof Error ? error.message : String(error)}`);
    }
    validateAndNormalize(profile);
    return profile;
  }

  /** 持久化 agent（含只有 `skill_id` 的 legacy 行）的运行时 profile。 */
  static resolveForAgent(agent: WorkspaceAgent): AgentProfile {
    const stored = AgentProfileResolver.fromMetadata(agent.metadata);
    if (stored) return stored;
    return AgentProfileResolver.resolve({ skillId: agent.skillId });
  }

  static runtimeConfigForAgent(agent: WorkspaceAgent): AgentRuntimeConfig {
    return runtimeConfigFromProfile(AgentProfileResolver.resolveForAgent(agent));
  }

  static persistIntoMetadata(metadata: JsonValue | undefined, profile: AgentProfile): JsonValue {
    const object: Record<string, JsonValue> = isRecord(metadata) && !Array.isArray(metadata)
      ? { ...metadata }
      : {};
    object[AGENT_PROFILE_METADATA_KEY] = agentProfileToJson(profile);
    return object;
  }

  /** G02-P1：内容锁定哈希（canonical JSON → SHA-256 hex）。 */
  static computedHash(profile: AgentProfile): string {
    return sha256Hex(JSON.stringify(agentProfileToJson(profile)));
  }

  /** G02-P1：profile → grant 工具范围映射。 */
  static grantToolScopes(profile: AgentProfile): ToolScope[] {
    return scopesFromAllowedTools(profile.allowedTools);
  }

  static validateAndNormalize(profile: AgentProfile): void {
    validateAndNormalize(profile);
  }
}

/** `llm_manager::ApiConfig` 中 persona 模型校验用到的字段。 */
export interface PersonaModelConfig {
  id: string;
  enabled: boolean;
  isEmbedding?: boolean;
  isReranker?: boolean;
  isImageGeneration?: boolean;
}

/** persona 的显式模型必须精确命中当前运行时目录里的启用生成模型。 */
export function validatePersonaModelConfig(modelId: string, configs: readonly PersonaModelConfig[]): void {
  const trimmed = rustTrim(modelId);
  const config = configs.find(item => item.id === trimmed);
  if (!config) {
    throw new Error(`PERSONA_MODEL_NOT_FOUND: model configuration id '${trimmed}' does not exist`);
  }
  if (!config.enabled) {
    throw new Error(`PERSONA_MODEL_DISABLED: model configuration '${trimmed}' is disabled or has no usable authentication`);
  }
  if (config.isEmbedding === true || config.isReranker === true || config.isImageGeneration === true) {
    throw new Error(`PERSONA_MODEL_UNSUPPORTED: model configuration '${trimmed}' is not a chat generation model`);
  }
}
