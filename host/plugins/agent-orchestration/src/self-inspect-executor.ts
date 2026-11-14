/**
 * self_inspect_executor.rs `SelfInspectExecutor`: a Low, read-only overview of runtime roots, skill
 * registration/loading, the MCP server list and web search configuration. Output is whitelisted and
 * passes the sensitive-key redaction gate; approvals, trust records and secret values are never read.
 */
import { getSessionWithConn, type ChatExecutionContext, type ToolCall, type ToolConcurrency, type ToolResultInfo,
  type ToolSensitivity } from '../../chat/api.ts';
import { mcpEntryRevision, readMcpToolsList, resolvedSessionSkillIds } from '../../agent-skills/portable.ts';
import type { RuntimeRoot } from '../../agent-workspace/portable.ts';
import { agentOrchestrationWorkspaceRuntime } from './workspace-runtime.ts';
import { assembleSelfInspectPayload, canHandleSelfInspectTool, parseInspectSection, redactSensitiveJson,
  sanitizeMcpServerEntry, type InspectSection } from './self-inspect.ts';
import { runStandardTool } from './standard-tool.ts';
import { compareUtf8, utf8ByteLength } from '../../../platform/util/portable.ts';

const EXECUTOR_NAME = 'SelfInspectExecutor';
const WEB_SEARCH_SETTINGS_PREFIX = 'web_search.';
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
/** Rust `String` ordering compares UTF-8 bytes. */
const byteOrder = compareUtf8;
const asObject = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const stringOrNull = (value: unknown): string | null => typeof value === 'string' ? value : null;

/** serde field order of `RuntimeRoot`. */
function rootJson(root: RuntimeRoot): Record<string, unknown> {
  return { id: root.id, kind: root.kind, path: root.path, access: root.access, label: root.label,
    description: root.description, session_scoped: root.session_scoped, configured: root.configured };
}

function collectRuntimeRoots(ctx: ChatExecutionContext, limitations: string[]): unknown {
  const entries: unknown[] = [];
  const services = ctx.services;
  try {
    const roots = agentOrchestrationWorkspaceRuntime().runtimeRootsForSession({
      settings: services.settings, windowsFiles: services.get('nativeWindowsFiles'),
      dataDir: services.app.dataDir, logger: { error: message => services.logger.error(message) } }, ctx.session_id, false);
    entries.push(...roots.map(rootJson));
  } catch (error) {
    limitations.push(`failed to enumerate runtime roots: ${errorText(error)}`);
  }
  if (ctx.skill_package_roots !== null) {
    for (const skillId of Object.keys(ctx.skill_package_roots).sort(byteOrder)) {
      try {
        entries.push(rootJson(agentOrchestrationWorkspaceRuntime().skillPackageRuntimeRoot(skillId,
          ctx.skill_package_roots[skillId]!, { appDataDir: services.app.dataDir })));
      } catch (error) {
        limitations.push(`failed to resolve skill package root for '${skillId}': ${errorText(error)}`);
      }
    }
  }
  const preference = agentOrchestrationWorkspaceRuntime().resolveGroupPreferredRuntimeRoot(ctx);
  const preferred = preference === null ? null : { root_id: preference.rootId,
    project_root_path: preference.projectRootPath === null ? null
      : agentOrchestrationWorkspaceRuntime().redactPathForDisplay(preference.projectRootPath) };
  return { roots: entries, group_preferred_runtime_root: preferred };
}

function collectSkills(ctx: ChatExecutionContext, limitations: string[]): unknown {
  let loaded: string[] = [];
  let active: string[] = [];
  let available = false;
  if (ctx.chat_v2_db !== null) {
    try {
      const state = ctx.services.chatSession.loadSessionState(ctx.session_id);
      available = true;
      if (state !== null) ({ loaded, active } = resolvedSessionSkillIds(state));
    } catch {
      limitations.push('failed to load session skill state');
    }
  } else {
    limitations.push('session skill state unavailable in this execution context');
  }
  const flags = (skillId: string) => ({ loaded: available ? loaded.includes(skillId) : null,
    active: available ? active.includes(skillId) : null });
  const registered: Record<string, unknown>[] = [];
  const contents = ctx.skill_contents;
  if (contents !== null) {
    for (const skillId of Object.keys(contents).sort(byteOrder)) {
      registered.push({ id: skillId, content_length: utf8ByteLength(contents[skillId] ?? ''),
        runtime_admitted: true, admission_error: null, ...flags(skillId) });
    }
  }
  const admissionErrors = ctx.skill_admission_errors;
  if (admissionErrors !== null) {
    for (const skillId of Object.keys(admissionErrors).sort(byteOrder)) {
      // An admitted entry wins if malformed input supplied both maps.
      if (contents !== null && Object.hasOwn(contents, skillId)) continue;
      registered.push({ id: skillId, content_length: null, runtime_admitted: false,
        admission_error: admissionErrors[skillId] ?? null, ...flags(skillId) });
    }
  }
  registered.sort((left, right) => byteOrder(left.id as string, right.id as string));
  return {
    registered_skills: registered,
    loaded_skill_ids: available ? loaded : null,
    active_skill_ids: available ? active : null,
    session_skill_state_available: available,
    note: available
      ? 'registered_skills reflects this request\'s immutable runtime catalog snapshot, including rejected entries and their admission errors. loaded/active reflect current session state. Trust or enable changes made during this tool loop appear in the runtime catalog on the next user turn.'
      : 'registered_skills reflects this request\'s immutable runtime catalog snapshot, including rejected entries; loaded/active state was unavailable in this execution context.',
  };
}

async function collectMcp(ctx: ChatExecutionContext, limitations: string[]): Promise<unknown> {
  if (ctx.main_db === null) {
    limitations.push('main database unavailable in this execution context');
    return { available: false, servers: [],
      note: 'MCP configuration is stored in settings (mcp.tools.list); it was not readable in this execution context.' };
  }
  let items: unknown[];
  try { items = await readMcpToolsList(ctx.services.settings); }
  catch (error) {
    limitations.push(`failed to read mcp.tools.list: ${errorText(error)}`);
    return { available: false, servers: [], note: 'Failed to read mcp.tools.list from secure settings.' };
  }
  return {
    available: true,
    // mcp_manage owns the process revision key, so this revision is the one mcp_update / mcp_remove accept.
    servers: items.map(item => sanitizeMcpServerEntry(item, mcpEntryRevision)).filter(entry => entry !== null),
    note: 'Only management id, display name, transport, enabled state, stable-id presence, and an opaque entry revision are exposed; command, args, env, url, headers, and tokens are omitted. Legacy rows without ids use their display name as the management selector.',
  };
}

function collectSearch(ctx: ChatExecutionContext, limitations: string[]): unknown {
  const settings: { key: string; configured: boolean }[] = [];
  if (ctx.main_db !== null) {
    try {
      for (const row of ctx.services.settings.listByPrefixWithConn(ctx.main_db, WEB_SEARCH_SETTINGS_PREFIX)) {
        if (row.key.startsWith('tool_approval.')) continue;
        settings.push({ key: row.key, configured: row.value.trim() !== '' });
      }
      settings.sort((a, b) => byteOrder(a.key, b.key));
    } catch (error) {
      limitations.push(`failed to read web_search.* settings: ${errorText(error)}`);
    }
  } else {
    limitations.push('main database unavailable in this execution context');
  }
  return { runtime_enabled: ctx.web_search_enabled, settings,
    note: 'Only setting key names and configured flags are shown; values are never returned. Keys stored only in secure store may be invisible here.' };
}

function collectEffectiveRuntime(ctx: ChatExecutionContext, limitations: string[]): unknown {
  let persona: unknown = null;
  if (ctx.chat_v2_db !== null) {
    const failed = 'failed to read current session metadata for effective persona';
    let conn: ReturnType<NonNullable<ChatExecutionContext['chat_v2_db']>['getConnSafe']> | null = null;
    try { conn = ctx.chat_v2_db.getConnSafe(); } catch { limitations.push(failed); }
    if (conn !== null) {
      try {
        const metadata = asObject(getSessionWithConn(conn, ctx.session_id)?.metadata ?? null);
        if (metadata !== null && metadata.effective_agent_profile !== undefined) {
          const effective = asObject(metadata.effective_agent_profile) ?? {};
          persona = { id: stringOrNull(effective.id), model_id: stringOrNull(effective.model_id),
            reasoning_effort: stringOrNull(effective.reasoning_effort),
            skill_ids: Array.isArray(effective.skill_ids) ? [...effective.skill_ids] : [] };
        }
      } catch {
        limitations.push(failed);
      }
    }
  }
  return {
    persona,
    permissions: { execution_allowlist_enforced: ctx.execution_allowed_tools !== null,
      allowed_tool_count: ctx.execution_allowed_tools?.length ?? null, custom_permission_overrides_supported: false },
    features: { web_search_enabled: ctx.web_search_enabled, rag_enabled: ctx.rag_enabled, memory_enabled: ctx.memory_enabled },
    automations: { definitions_exposed: false,
      note: 'Automation definitions and payloads are not part of this session-safe projection.' },
    approval: { policy_details_exposed: false, fail_closed: true,
      note: 'Remembered approvals and trust records are intentionally not returned.' },
  };
}

async function buildReport(args: unknown, ctx: ChatExecutionContext): Promise<unknown> {
  const section: InspectSection = parseInspectSection(args);
  const limitations: string[] = [];
  const all = section === 'all';
  const roots = all || section === 'roots' ? collectRuntimeRoots(ctx, limitations) : undefined;
  const skills = all || section === 'skills' ? collectSkills(ctx, limitations) : undefined;
  const mcp = all || section === 'mcp' ? await collectMcp(ctx, limitations) : undefined;
  const search = all || section === 'search' ? collectSearch(ctx, limitations) : undefined;
  const effectiveRuntime = all ? collectEffectiveRuntime(ctx, limitations) : undefined;
  const payload = assembleSelfInspectPayload(section, { roots, skills, mcp, search, limitations });
  if (effectiveRuntime !== undefined) payload.effective_runtime = effectiveRuntime;
  return redactSensitiveJson(payload);
}

export class SelfInspectExecutor {
  private readonly warn: (message: string) => void;
  constructor(warn: (message: string) => void) { this.warn = warn; }

  canHandle(toolName: string): boolean { return canHandleSelfInspectTool(toolName); }
  execute(call: ToolCall, ctx: ChatExecutionContext): Promise<ToolResultInfo> {
    return runStandardTool(call, ctx, EXECUTOR_NAME, () => buildReport(call.arguments, ctx), this.warn);
  }
  sensitivityLevel(_toolName: string): ToolSensitivity { return 'low'; }
  concurrencyClass(_toolName: string): ToolConcurrency { return 'read_only'; }
  name(): string { return EXECUTOR_NAME; }
}
