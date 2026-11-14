/**
 * L04 ↔ skill workshop adapter: the production registration object for Rust
 * `SkillWorkshopExecutor` (`pipeline/roster.rs:72`), wrapping the ported
 * propose/apply bodies with `ToolExecutor::execute`
 * (`skill_workshop_executor.rs:1263-1323`).
 *
 * Per call it maps the Rust context reads onto Host owners:
 * `window_ref().app_handle().path().app_data_dir()` → `paths.appDataDir`
 * (window still required, like `window_ref`), `expand_path` /
 * `validate_skill_path` → `SkillFiles`, `ctx.main_db` settings → F4
 * `settings.*WithConn(main_db, …)`, and `ctx.session_id`.
 */
import path from 'node:path';
import type { ChatExecutionContext, ToolCall, ToolExecutor, ToolResultInfo } from '../../../chat/api.ts';
import type { SettingsWithConn } from '../../../../platform/settings/api.ts';
import type { SkillFiles } from '../files.ts';
import { DEFAULT_AGENT_SKILLS_BASE } from '../skill-package.ts';
import { commandDisplayMessage } from '../skill-replay.ts';
import {
  SKILL_WORKSHOP_APPLY, SKILL_WORKSHOP_EXECUTOR_NAME, SKILL_WORKSHOP_PROPOSE,
  SkillWorkshopExecutor, canHandleSkillWorkshopTool, skillWorkshopSensitivity,
  type WorkshopSettingsStore,
} from './skill-workshop-executor.ts';
import { PROPOSALS_SUBDIR } from './skill-workshop-proposals.ts';

export interface SkillWorkshopToolLogger {
  warn(message: string): void;
}

export interface SkillWorkshopToolExecutorOptions {
  files: SkillFiles;
  appDataDir: () => string;
  /** F4 `ctx.settings`: the `*WithConn` seam is bound to the call's `main_db`. */
  settings: () => SettingsWithConn;
  logger: SkillWorkshopToolLogger;
}

const nativeJson = JSON as JSON & { rawJSON(text: string): unknown };

/**
 * serde_json writes u64 digits. Exact Host bigints become native raw JSON atoms
 * so the event payload, persisted `tool_output` and LLM text keep the digits.
 */
function toolOutputJson(value: unknown): unknown {
  if (typeof value === 'bigint') return nativeJson.rawJSON(value.toString());
  if (Array.isArray(value)) return value.map(toolOutputJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toolOutputJson(item)]));
  }
  return value;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class SkillWorkshopToolExecutor implements ToolExecutor {
  private readonly options: SkillWorkshopToolExecutorOptions;

  constructor(options: SkillWorkshopToolExecutorOptions) {
    this.options = options;
  }

  name(): string { return SKILL_WORKSHOP_EXECUTOR_NAME; }
  canHandle(toolName: string): boolean { return canHandleSkillWorkshopTool(toolName); }
  sensitivityLevel(toolName: string): 'medium' | 'high' { return skillWorkshopSensitivity(toolName); }

  private provenanceStore(context: ChatExecutionContext): WorkshopSettingsStore | null {
    const db = context.main_db;
    if (db === null) return null;
    const settings = this.options.settings();
    return {
      getSetting: key => settings.getWithConn(db, key),
      saveSetting: (key, value) => { settings.saveWithConn(db, key, value); },
      deleteSetting: key => { settings.deleteWithConn(db, key); },
    };
  }

  async execute(call: ToolCall, context: ChatExecutionContext): Promise<ToolResultInfo> {
    const started = performance.now();
    const short = SkillWorkshopExecutor.stripNamespace(call.name);
    context.emitToolCallStart(call.name, call.arguments, call.id);

    // Rust `window_ref()` panics without a window: no error event, no block.
    let panic: { error: unknown } | null = null;
    const { files } = this.options;
    const workshop = new SkillWorkshopExecutor({
      proposalsRoot: () => {
        try { context.windowRef(); }
        catch (error) { panic = { error }; throw error; }
        return path.join(this.options.appDataDir(), PROPOSALS_SUBDIR);
      },
      skillsBase: files.expandPath(DEFAULT_AGENT_SKILLS_BASE),
      validateSkillPath: skillFile => {
        try { files.validatePath(skillFile); }
        catch (error) { throw new Error(commandDisplayMessage(error)); }
      },
      provenanceStore: this.provenanceStore(context),
      sessionId: context.session_id,
      logger: this.options.logger,
    });

    let output: unknown;
    let failure: string | undefined;
    try {
      if (short === SKILL_WORKSHOP_PROPOSE) output = workshop.propose(call.arguments);
      else if (short === SKILL_WORKSHOP_APPLY) output = workshop.apply(call.arguments);
      else throw new Error(`Unsupported skill workshop tool: ${short}`);
    } catch (error) {
      if (panic !== null) throw (panic as { error: unknown }).error;
      failure = errorText(error);
    }
    const durationMs = Math.trunc(performance.now() - started);

    let result: ToolResultInfo;
    if (failure === undefined) {
      const json = toolOutputJson(output);
      context.emitToolCallEnd({ result: json, durationMs });
      result = {
        toolCallId: call.id, blockId: context.block_id, toolName: call.name,
        input: call.arguments, output: json, success: true, durationMs,
      };
    } else {
      context.emitToolCallError(failure);
      result = {
        toolCallId: call.id, blockId: context.block_id, toolName: call.name,
        input: call.arguments, output: null, success: false, error: failure, durationMs,
      };
    }
    try { context.saveToolBlock(result); }
    catch (error) {
      this.options.logger.warn(`[SkillWorkshopExecutor] Failed to save tool block: ${errorText(error)}`);
    }
    return result;
  }
}
