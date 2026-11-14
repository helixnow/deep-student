import type { Json } from '../api.ts';
import { rustTrim } from '../../../platform/util/index.ts';

export interface SubagentCallArgs {
  task: string;
  workspaceId: string | null;
  profile: string | null;
  skillId: string | null;
  model: string | null;
  context: Json;
  wait: boolean;
  resumeAgentSessionId: string | null;
  title: string | null;
  agentMetadata: Json;
}
function optionalTrimmedString(args: Record<string, Json>, key: string): string | null {
  const value = args[key];
  return typeof value === 'string' ? rustTrim(value) || null : null;
}
export function parseSubagentArgs(value: Json): SubagentCallArgs {
  const args = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const task = optionalTrimmedString(args, 'task');
  if (task === null) throw new Error('task is required');
  return {
    task, workspaceId: optionalTrimmedString(args, 'workspace_id'),
    profile: optionalTrimmedString(args, 'profile'), skillId: optionalTrimmedString(args, 'skill_id'),
    model: optionalTrimmedString(args, 'model'), context: args.context ?? null,
    wait: typeof args.wait === 'boolean' ? args.wait : true,
    resumeAgentSessionId: optionalTrimmedString(args, 'resume_agent_session_id'),
    title: null, agentMetadata: null,
  };
}
export function buildTaskContent(args: SubagentCallArgs): string {
  return args.context === null ? args.task : `${args.task}\n\n[Context]\n${JSON.stringify(args.context, null, 2)}`;
}
export function deriveWorkspaceName(task: string): string {
  return [...rustTrim(task)].slice(0, 24).join('') || 'Subagent Task';
}
export function buildProfileSkillSnapshot(skillIds: readonly string[], available: ReadonlyMap<string, string> | null): Map<string, string> {
  if (skillIds.length === 0) return new Map();
  if (available === null) throw new Error(`Profile requires skills [${skillIds.join(', ')}], but the current runtime has no skill content registry`);
  const snapshot = new Map<string, string>();
  const missing: string[] = [];
  for (const skillId of skillIds) {
    const content = available.get(skillId);
    if (content !== undefined) snapshot.set(skillId, content);
    else missing.push(skillId);
  }
  if (missing.length) throw new Error(`Profile skills are unavailable in the current runtime: [${missing.join(', ')}]. Refusing to create a worker that would silently ignore them.`);
  return snapshot;
}
export function isOwnAgentCompletion(content: string, agentSessionId: string): boolean {
  let value: Json;
  try { value = JSON.parse(content) as Json; }
  catch { return false; }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const kind = Object.hasOwn(value, 'kind') ? value.kind : value.type;
  return kind === 'agent_completion' && value.agent_session_id === agentSessionId;
}

/** subagent_executor.rs:1084–1097. */
export function canHandleSubagentTool(toolName: string): boolean {
  const bare = toolName.startsWith('builtin-') ? toolName.slice('builtin-'.length) : toolName;
  return bare === 'subagent_call';
}

export const SUBAGENT_CALL_SENSITIVITY = 'Medium' as const;

/** The blocking wait path cancels the child pipeline itself before returning. */
export function managesSubagentCancellation(toolName: string): boolean {
  return canHandleSubagentTool(toolName);
}
