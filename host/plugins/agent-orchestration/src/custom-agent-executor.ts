/**
 * `CustomAgentExecutor` (custom_agent_executor.rs:83–117, 311–337, 598–782, 929–953, 1005–1099).
 *
 * Registered through L07 `agentTools`; L04's `ToolExecutorRegistry` dispatches it as the
 * `CustomAgentExecutor` entry of the workspace-coordinator roster group (roster.rs:98).
 */
import type { ChatExecutionContext, ToolCall, ToolResultInfo, ToolSensitivity } from '../../chat/api.ts';
import { validatePersonaModelConfig } from '../../agent-workspace/portable.ts';
import type { WorkspaceCoordinator } from '../../agent-workspace/api.ts';
import {
  CUSTOM_AGENT_TOOL_NAMES, CustomAgentStore, canHandleCustomAgentTool, customAgentSensitivityLevel,
  validatePersonaContent, validatePersonaFileName,
} from './custom-agent.ts';
import { stripToolNamespace } from './automation-tool-args.ts';

export const CUSTOM_AGENT_EXECUTOR_NAME = 'CustomAgentExecutor';

type CustomAgentDirs = Pick<WorkspaceCoordinator, 'customAgentsDir' | 'customAgentsPendingDir'>;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** custom_agent_executor.rs:311–337. */
export async function validateModelForWrite(ctx: Pick<ChatExecutionContext, 'llm_manager'>,
  model: string | null): Promise<unknown[]> {
  if (model === null) return [];
  const manager = ctx.llm_manager ?? null;
  if (manager === null) {
    return [{
      code: 'PERSONA_MODEL_CATALOG_UNAVAILABLE',
      model_id: model,
      message: 'The model catalog was unavailable in this execution context. The profile was accepted with an explicit warning; runtime will still require the exact model configuration and will not fall back.',
    }];
  }
  let configs;
  try {
    configs = await manager.getApiConfigs();
  } catch (error) {
    return [{
      code: 'PERSONA_MODEL_CATALOG_UNAVAILABLE',
      model_id: model,
      message: `Failed to read the model catalog: ${message(error)}. Runtime will require the exact model configuration and will not fall back.`,
    }];
  }
  validatePersonaModelConfig(model, configs);
  return [];
}

export class CustomAgentExecutor {
  private readonly coordinator: CustomAgentDirs;
  private readonly warn: (message: string) => void;

  constructor(coordinator: CustomAgentDirs, warn: (message: string) => void) {
    this.coordinator = coordinator;
    this.warn = warn;
  }

  /** Rust reads `agents_dir()` / `pending_dir()` from the coordinator on every call. */
  private store(): CustomAgentStore {
    return new CustomAgentStore({
      agentsDir: this.coordinator.customAgentsDir(),
      pendingDir: this.coordinator.customAgentsPendingDir(),
    });
  }

  /** custom_agent_executor.rs:598–614, then the store's staged write. */
  private async proposeDraft(args: unknown, ctx: ChatExecutionContext): Promise<Record<string, unknown>> {
    const object = args !== null && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {};
    const rawFileName = Object.hasOwn(object, 'file_name') ? object.file_name : object.fileName;
    if (typeof rawFileName !== 'string') throw new Error('file_name is required');
    const fileName = validatePersonaFileName(rawFileName);
    const content = object.content;
    if (typeof content !== 'string') throw new Error('content is required (full persona Markdown with YAML frontmatter)');
    const { name: agentName, description, model } = validatePersonaContent(content);
    const warnings = await validateModelForWrite(ctx, model);
    return this.store().writeProposalDraft({ fileName, content, agentName, description }, ctx.session_id, warnings);
  }

  /** custom_agent_executor.rs:768–782. */
  private async propose(args: unknown, ctx: ChatExecutionContext): Promise<Record<string, unknown>> {
    const raw = args !== null && typeof args === 'object' && !Array.isArray(args)
      ? (args as Record<string, unknown>).action : undefined;
    const action = typeof raw === 'string' ? raw : 'propose';
    switch (action) {
      case 'propose': return this.proposeDraft(args, ctx);
      case 'list': return this.store().executeProposeList();
      case 'reject': return this.store().executeProposeReject(args);
      default: throw new Error(`Unsupported action '${action}'. Allowed: propose, list, reject`);
    }
  }

  /** custom_agent_executor.rs:929–953: model validation precedes the locked apply. */
  private async applyChecked(args: unknown, ctx: ChatExecutionContext): Promise<Record<string, unknown>> {
    const store = this.store();
    const content = store.readProposalDraftForModelValidation(args);
    const { model } = validatePersonaContent(content);
    const warnings = await validateModelForWrite(ctx, model);
    const output = await store.executeApply(args);
    if (warnings.length > 0) output.warnings = warnings;
    return output;
  }

  private async dispatch(short: string, args: unknown, ctx: ChatExecutionContext): Promise<Record<string, unknown>> {
    switch (short) {
      case CUSTOM_AGENT_TOOL_NAMES.list: return this.store().executeList();
      case CUSTOM_AGENT_TOOL_NAMES.get: return this.store().executeGet(args);
      case CUSTOM_AGENT_TOOL_NAMES.propose: return this.propose(args, ctx);
      case CUSTOM_AGENT_TOOL_NAMES.apply: return this.applyChecked(args, ctx);
      case CUSTOM_AGENT_TOOL_NAMES.remove: return this.store().executeRemove(args);
      default: throw new Error(`Unsupported custom agent tool: ${short}`);
    }
  }

  /** custom_agent_executor.rs:1007–1071. */
  async execute(call: ToolCall, ctx: ChatExecutionContext): Promise<ToolResultInfo> {
    const started = performance.now();
    const short = stripToolNamespace(call.name);
    ctx.emitToolCallStart(call.name, call.arguments, call.id);
    let output: Record<string, unknown> | undefined;
    let error: string | undefined;
    try { output = await this.dispatch(short, call.arguments, ctx); }
    catch (cause) { error = message(cause); }
    const durationMs = Math.trunc(performance.now() - started);
    let result: ToolResultInfo;
    if (error === undefined) {
      ctx.emitToolCallEnd({ result: output, durationMs });
      result = { toolCallId: call.id, blockId: ctx.block_id, toolName: call.name,
        input: call.arguments, output, success: true, durationMs };
    } else {
      ctx.emitToolCallError(error);
      result = { toolCallId: call.id, blockId: ctx.block_id, toolName: call.name,
        input: call.arguments, output: null, success: false, error, durationMs };
    }
    try { ctx.saveToolBlock(result); }
    catch (cause) { this.warn(`[CustomAgentExecutor] Failed to save tool block: ${message(cause)}`); }
    return result;
  }

  canHandle(toolName: string): boolean {
    return canHandleCustomAgentTool(toolName);
  }

  /** custom_agent_executor.rs:1084–1094; serde snake_case of `ToolSensitivity`. */
  sensitivityLevel(toolName: string): ToolSensitivity {
    return customAgentSensitivityLevel(toolName).toLowerCase() as ToolSensitivity;
  }

  name(): string {
    return CUSTOM_AGENT_EXECUTOR_NAME;
  }
}
