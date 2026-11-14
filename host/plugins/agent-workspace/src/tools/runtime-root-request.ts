/**
 * `runtime_root_request` 工具执行器：移植
 * `chat_v2/tools/runtime_root_request_executor.rs`。
 *
 * High 敏感度：agent 请求用户授权只读 authorized runtime root。
 * critical 目录在 agent 发起路径下直接拒绝（比 Settings 手动更严）；broad 目录允许但带警示。
 * 宿主依赖（settings、事件、块持久化）通过 `RuntimeRootRequestToolContext` 注入。
 */
import { chronoRfc3339 } from '../../../../platform/time/index.ts';
import { rustTrim } from '../../../../platform/util/index.ts';
import type { JsonValue, ToolCall, ToolResultInfo, ToolSensitivity } from './shared.ts';
import { stripToolNamespace, successResult } from './shared.ts';
import { DEFAULT_TOOL_RESULT_CHAR_BUDGET } from './workspace-fs.ts';
import {
  assessAuthorizedRootRiskCanonical, canonicalizeExistingDir, ioMessage,
  stripWindowsVerbatimPrefix, type AuthorizedRootRisk,
} from '../runtime-paths.ts';
import {
  authorizeRuntimeRootPath, RUNTIME_ROOT_PROVENANCE_PREFIX, type RuntimeRootDeps, type SettingsLike,
} from '../runtime-roots.ts';

export const toolNames = {
  RUNTIME_ROOT_REQUEST: 'runtime_root_request',
} as const;

export const HINT = '已授权只读；可用 workspace_file_list/read 或 local_shell_execute(root_id=...) 访问；可在 Settings > 工具权限 撤销';

export const CRITICAL_REJECTION = '该目录范围过大，agent 不代理授权，请用户到 Settings > 工具权限 手动添加';

export const BROAD_WARNING = '该目录属于 Desktop/Downloads/Documents 等较宽个人目录，授权后 agent 可只读访问其下全部文件；请确认用途后再批准';

type JsonObject = { [key: string]: JsonValue };

/** Rust `RuntimeRootProvenance`（字段即 serde 默认 snake_case 顺序）。 */
export interface RuntimeRootProvenance {
  purpose: string;
  session_id: string;
  granted_at: string;
  risk: string;
}

/** 工具执行的宿主上下文：Rust `ExecutionContext` 中本模块实际用到的部分。 */
export interface RuntimeRootRequestToolContext {
  windowsFiles?: RuntimeRootDeps['windowsFiles'];
  sessionId: string;
  settings: SettingsLike;
  blockId?: string | null;
  emitToolCallStart?: (toolName: string, args: JsonValue, toolCallId: string | null) => void;
  emitToolCallEnd?: (payload: JsonValue) => void;
  emitToolCallError?: (error: string) => void;
  saveToolBlock?: (result: ToolResultInfo) => void;
  warn?: (message: string) => void;
}

function failureResult(
  toolCallId: string | null,
  blockId: string | null,
  toolName: string,
  input: JsonValue,
  error: string,
  durationMs: number,
): ToolResultInfo {
  const result: ToolResultInfo = { toolName, input, output: null, success: false, error, durationMs };
  if (toolCallId !== null && toolCallId !== '') result.toolCallId = toolCallId;
  if (blockId !== null && blockId !== '') result.blockId = blockId;
  return result;
}

function argsObject(args: JsonValue): Record<string, JsonValue> | null {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return null;
  return args as Record<string, JsonValue>;
}

/** `parse_args`：path 与 purpose 均为必填，trim 后不能为空。 */
export function parseArgs(args: JsonValue): { path: string; purpose: string } {
  const rawPath = argsObject(args)?.['path'];
  const path = typeof rawPath === 'string' ? rustTrim(rawPath) : '';
  if (path === '') {
    throw new Error('path is required (absolute directory path; shown on the approval card)');
  }
  const rawPurpose = argsObject(args)?.['purpose'];
  const purpose = typeof rawPurpose === 'string' ? rustTrim(rawPurpose) : '';
  if (purpose === '') {
    throw new Error('purpose is required (one sentence explaining why this directory is needed)');
  }
  return { path, purpose };
}

/** `build_success_payload`：broad 风险额外附带 `risk_warning`。 */
export function buildSuccessPayload(
  rootId: string,
  path: string,
  risk: AuthorizedRootRisk,
  purpose: string,
  newlyGranted: boolean,
): JsonObject {
  const payload: JsonObject = {
    root_id: rootId,
    path,
    risk,
    purpose,
    newly_granted: newlyGranted,
    hint: HINT,
  };
  if (risk === 'broad') {
    payload['risk_warning'] = BROAD_WARNING;
  }
  return payload;
}

/** `write_provenance`：把授权来源写入 settings（`runtime_root.provenance.<root_id>`）。 */
export function writeProvenance(
  settings: SettingsLike,
  rootId: string,
  purpose: string,
  sessionId: string,
  risk: AuthorizedRootRisk,
): void {
  const provenance: RuntimeRootProvenance = {
    purpose,
    session_id: sessionId,
    granted_at: chronoRfc3339(),
    risk,
  };
  let jsonText: string;
  try {
    jsonText = JSON.stringify(provenance);
  } catch (error) {
    throw new Error(`Failed to serialize runtime root provenance: ${ioMessage(error)}`);
  }
  const key = `${RUNTIME_ROOT_PROVENANCE_PREFIX}${rootId}`;
  try {
    settings.save(key, jsonText);
  } catch (error) {
    throw new Error(`Failed to persist runtime root provenance: ${ioMessage(error)}`);
  }
}

export class RuntimeRootRequestExecutor {
  private readonly getWindowsFiles?: () => RuntimeRootRequestToolContext['windowsFiles'];
  constructor(getWindowsFiles?: () => RuntimeRootRequestToolContext['windowsFiles']) { this.getWindowsFiles = getWindowsFiles; }
  canHandle(toolName: string): boolean {
    return stripToolNamespace(toolName) === toolNames.RUNTIME_ROOT_REQUEST;
  }

  /** `execute_request`：授权与策略都基于 canonical 目标，原始写法不参与安全决策。 */
  executeRequest(args: JsonValue, ctx: RuntimeRootRequestToolContext): JsonObject {
    const { path: rawPath, purpose } = parseArgs(args);

    // Authorization and policy both operate on the canonical target. The raw
    // spelling may contain symlinks, `..`, verbatim prefixes, or 8.3 aliases
    // and must never be used as the security decision.
    let canonical: string;
    try {
      canonical = canonicalizeExistingDir(rawPath, 'authorized runtime root');
    } catch (error) {
      throw new Error(`Failed to authorize directory '${rawPath}': ${(error as Error).message}. Ask the user to confirm the path exists and is a directory.`);
    }
    const canonicalDisplay = stripWindowsVerbatimPrefix(canonical);
    const risk = assessAuthorizedRootRiskCanonical(canonical);
    if (risk === 'critical') {
      throw new Error(CRITICAL_REJECTION);
    }

    let outcome: ReturnType<typeof authorizeRuntimeRootPath>;
    try {
      outcome = authorizeRuntimeRootPath(ctx.settings, canonicalDisplay, null,
        this.getWindowsFiles ? this.getWindowsFiles() : ctx.windowsFiles);
    } catch (error) {
      throw new Error(`Failed to authorize directory '${canonicalDisplay}': ${(error as Error).message}. Ask the user to confirm the path exists and is a directory.`);
    }

    if (outcome.newlyGranted) {
      writeProvenance(ctx.settings, outcome.rootId, purpose, ctx.sessionId, risk);
    }

    // 成功 payload 展示 canonical 路径（剥 `\\?\` 前缀），而非模型提供的原始写法。
    return buildSuccessPayload(
      outcome.rootId,
      stripWindowsVerbatimPrefix(outcome.path),
      risk,
      purpose,
      outcome.newlyGranted,
    );
  }

  async execute(call: ToolCall, ctx: RuntimeRootRequestToolContext): Promise<ToolResultInfo> {
    const start = performance.now();
    ctx.emitToolCallStart?.(call.name, call.arguments, call.id);

    let result: JsonObject;
    try {
      result = this.executeRequest(call.arguments, ctx);
    } catch (error) {
      const durationMs = Math.trunc(performance.now() - start);
      const message = error instanceof Error ? error.message : String(error);
      ctx.emitToolCallError?.(message);
      const failed = failureResult(call.id, ctx.blockId ?? null, call.name, call.arguments, message, durationMs);
      if (ctx.saveToolBlock) {
        try {
          ctx.saveToolBlock(failed);
        } catch (saveError) {
          ctx.warn?.(`[RuntimeRootRequestExecutor] Failed to save tool block: ${ioMessage(saveError)}`);
        }
      }
      return failed;
    }

    const durationMs = Math.trunc(performance.now() - start);
    ctx.emitToolCallEnd?.({ result, durationMs });
    const succeeded = successResult(call.id, ctx.blockId ?? null, call.name, call.arguments, result, durationMs);
    if (ctx.saveToolBlock) {
      try {
        ctx.saveToolBlock(succeeded);
      } catch (error) {
        ctx.warn?.(`[RuntimeRootRequestExecutor] Failed to save tool block: ${ioMessage(error)}`);
      }
    }
    return succeeded;
  }

  sensitivityLevel(_toolName: string): ToolSensitivity {
    return 'high';
  }

  /** Rust `ToolExecutor::result_char_budget` 默认值（本执行器未覆盖）。 */
  resultCharBudget(_toolName: string): number | null {
    return DEFAULT_TOOL_RESULT_CHAR_BUDGET;
  }

  name(): string {
    return 'RuntimeRootRequestExecutor';
  }
}

export const runtimeRootRequestExecutor = new RuntimeRootRequestExecutor();
