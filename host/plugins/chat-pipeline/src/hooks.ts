/**
 * pipeline/hooks.rs — approval-gate/audit ordering and fail-closed admission.
 *
 * The admission record is written by `ApprovalGateHook` before `TaskAuditHook`
 * reads it. Its initial values must never look like evidence: only an explicit
 * write from the approval gate may admit a tool.
 */
import type { AuthorityMode, JsonValue, PermissionPreset, ToolSensitivity } from '../api.ts';
import { shellGuardAdmitted } from './authority-mode.ts';
import { immutableShellCommandGuard, isLocalShellExecuteTool } from '../../agent-workspace/portable.ts';
import type { ShellCommandGuardDecision } from '../../agent-workspace/api.ts';
import type { ToolCall } from '../../chat/api.ts';

/** L05 approval_scope::is_local_shell_execute_tool, pending public export from its owner. */
export type LocalShellCallClassifier = (toolName: string, argumentsValue: JsonValue) => boolean;
export const classifyLocalShellCall: LocalShellCallClassifier = isLocalShellExecuteTool;

/** hooks.rs:171–196. Owner classification must precede any command guard call. */
export function immutableCommandGuardForToolCall(call: ToolCall, classify: LocalShellCallClassifier,
  homeDirectory: () => string | null): ShellCommandGuardDecision | null {
  if (!classify(call.name, call.arguments as JsonValue)) return null;
  const home = homeDirectory();
  const args = call.arguments;
  const command = args !== null && typeof args === 'object' && !Array.isArray(args)
    ? (args as Record<string, unknown>).command : undefined;
  return typeof command === 'string' ? immutableShellCommandGuard(command, null, home === null ? [] : [home]) : null;
}

/** ApprovalManager is required for everything that is not explicitly Low. */
export function approvalManagerRequired(sensitivity: ToolSensitivity | null): boolean {
  return sensitivity !== 'low';
}

/** `default_pipeline_hooks()` order: admission evidence before audit reads it. */
export const DEFAULT_PIPELINE_HOOK_NAMES = ['approval_gate', 'task_audit'] as const;

export function defaultPipelineHookNames(): string[] {
  return [...DEFAULT_PIPELINE_HOOK_NAMES];
}

export type AuthorityAdmission = [AuthorityMode, PermissionPreset];

/**
 * Per-call security evidence (`ToolAdmission`). Every field starts in the
 * fail-closed state; hooks may only add evidence through the explicit mutators.
 */
export class ToolAdmission {
  private immutableGuardAsks = false;
  private approvalRequired = false;
  private approvalRequirementSatisfied = false;
  private externalMcp = false;
  private trustedAutomation = false;
  private admission: AuthorityAdmission | null = null;

  /** `ToolAdmission::new(_arguments)` keeps no copy of the tool arguments. */
  static create(_arguments: JsonValue): ToolAdmission {
    return new ToolAdmission();
  }

  shellGuardAdmitted(): boolean {
    return shellGuardAdmitted(
      this.immutableGuardAsks,
      this.approvalRequired,
      this.approvalRequirementSatisfied,
    );
  }

  authorityAdmission(): AuthorityAdmission | null {
    return this.admission;
  }

  get isExternalMcp(): boolean {
    return this.externalMcp;
  }

  get trustedAutomationPreauthorized(): boolean {
    return this.trustedAutomation;
  }

  markImmutableGuardAsks(): void {
    this.immutableGuardAsks = true;
  }

  markApprovalRequired(): void {
    this.approvalRequired = true;
  }

  markApprovalSatisfied(): void {
    this.approvalRequirementSatisfied = true;
  }

  markExternalMcp(): void {
    this.externalMcp = true;
  }

  markTrustedAutomationPreauthorized(): void {
    this.trustedAutomation = true;
  }

  /** Records the session authority re-checked immediately before execution. */
  recordAuthorityAdmission(mode: AuthorityMode, preset: PermissionPreset): void {
    this.admission = [mode, preset];
  }
}
