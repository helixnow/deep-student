/**
 * L04 `ExecutionContext` → this lane's executor contexts for the App-roster entries whose execution
 * bodies live here (roster.rs:87–89, 111, 120). Each contribution keeps the executor's own routing,
 * sensitivity and concurrency; only the context projection is added.
 */
import type { ExecutionContext, ToolCall, ToolExecutor, ToolResultInfo } from '../../../chat/api.ts';
import type { NativeWindowsFiles } from '../../../../platform/native/windows/api.ts';
import type { JsonValue } from '../../api.ts';
import type { SettingsLike } from '../runtime-roots.ts';
import type { CodeNavigationContext, CodeNavigationExecutor } from './code-navigation.ts';
import type { FileManagerContext, FileManagerExecutor } from './file-manager.ts';
import type { GitExecutionContext, GitRunShell, GitToolExecutor } from './git.ts';
import type { LocalShellExecuteExecutor } from './shell-execute.ts';
import type { ShellExecuteContext } from './shell-execute/context.ts';
import type { LspNavigationContext, LspNavigationExecutor } from './lsp-navigation.ts';
import type { RuntimeRootRequestExecutor, RuntimeRootRequestToolContext } from './runtime-root-request.ts';
import type { ShellPreflightContext, LocalShellPreflightExecutor } from './shell-preflight.ts';
import { preferredRoot } from './workspace-fs-contribution.ts';

type Sensitivity = 'low' | 'medium' | 'high';
type Concurrency = 'read_only' | 'safe_parallel' | 'serial';
interface LaneExecutor<C> {
  name(): string;
  canHandle(toolName: string): boolean;
  sensitivityLevel(toolName: string): Sensitivity;
  sensitivityLevelForCall?(toolName: string, args: JsonValue): Sensitivity;
  hasDynamicSensitivity?(toolName: string): boolean;
  concurrencyClass?(toolName: string): Concurrency;
  managesCancellation?(toolName: string): boolean;
  resultCharBudget?(toolName: string): number | null;
  execute(call: ToolCall, context: C): Promise<ToolResultInfo>;
}

interface BaseLaneContext {
  windowsFiles: NativeWindowsFiles | undefined;
  sessionId: string;
  dataDir: string;
  settings: SettingsLike;
  skillPackageRoots: ReadonlyMap<string, string> | null;
  blockId: string;
  emitToolCallStart(toolName: string, args: JsonValue, toolCallId: string | null): void;
  emitToolCallEnd(payload: JsonValue): void;
  emitToolCallError(error: string): void;
  saveToolBlock(result: ToolResultInfo): void;
  warn(message: string): void;
}

/** Fields every lane context shares (Rust reads them straight off `ExecutionContext`). */
export function baseLaneContext(context: ExecutionContext): BaseLaneContext {
  return {
    windowsFiles: context.services.get('nativeWindowsFiles'),
    sessionId: context.session_id,
    dataDir: context.services.app.dataDir,
    settings: context.services.settings,
    skillPackageRoots: context.skill_package_roots === null ? null : new Map(Object.entries(context.skill_package_roots)),
    blockId: context.block_id,
    emitToolCallStart: (name, args, id) => context.emitToolCallStart(name, args, id),
    emitToolCallEnd: payload => context.emitToolCallEnd(payload),
    emitToolCallError: error => context.emitToolCallError(error),
    saveToolBlock: result => context.saveToolBlock(result),
    warn: message => context.services.logger.warn(message),
  };
}

export class LaneToolContribution<C> implements ToolExecutor {
  private readonly executor: LaneExecutor<C>;
  private readonly project: (context: ExecutionContext) => C;
  readonly sensitivityLevelForCall?: (toolName: string, args: unknown) => Sensitivity;
  readonly hasDynamicSensitivity?: (toolName: string) => boolean;
  readonly concurrencyClass?: (toolName: string) => Concurrency;
  readonly managesCancellation?: (toolName: string) => boolean;
  readonly resultCharBudget?: (toolName: string) => number | null;

  constructor(executor: LaneExecutor<C>, project: (context: ExecutionContext) => C) {
    if (typeof executor.sensitivityLevel !== 'function') {
      throw new Error(`${executor.name()} must declare sensitivityLevel; lane contributions never default to low`);
    }
    this.executor = executor; this.project = project;
    if (typeof executor.sensitivityLevelForCall === 'function') {
      this.sensitivityLevelForCall = (name, args) => executor.sensitivityLevelForCall!(name, args as JsonValue);
    }
    if (typeof executor.hasDynamicSensitivity === 'function') this.hasDynamicSensitivity = name => executor.hasDynamicSensitivity!(name);
    if (typeof executor.concurrencyClass === 'function') this.concurrencyClass = name => executor.concurrencyClass!(name);
    if (typeof executor.managesCancellation === 'function') this.managesCancellation = name => executor.managesCancellation!(name);
    if (typeof executor.resultCharBudget === 'function') this.resultCharBudget = name => executor.resultCharBudget!(name);
  }

  name(): string { return this.executor.name(); }
  canHandle(toolName: string): boolean { return this.executor.canHandle(toolName); }
  sensitivityLevel(toolName: string): Sensitivity { return this.executor.sensitivityLevel(toolName); }
  execute(call: ToolCall, context: ExecutionContext): Promise<ToolResultInfo> {
    return this.executor.execute(call, this.project(context));
  }
}

export function fileManagerContribution(executor: FileManagerExecutor): LaneToolContribution<FileManagerContext> {
  return new LaneToolContribution(executor, context => baseLaneContext(context));
}

export function codeNavigationContribution(executor: CodeNavigationExecutor): LaneToolContribution<CodeNavigationContext> {
  return new LaneToolContribution(executor, context => ({ ...baseLaneContext(context), isCancelled: () => context.isCancelled() }));
}

/** The LSP executor manages its own cancellation, so it receives the run's signal. */
export function lspNavigationContribution(executor: LspNavigationExecutor): LaneToolContribution<LspNavigationContext> {
  return new LaneToolContribution(executor, context => ({ ...baseLaneContext(context), appVersion: context.services.app.version,
    ...(context.cancellation_token === null ? {} : { signal: context.cancellation_token }) }));
}

export function runtimeRootRequestContribution(executor: RuntimeRootRequestExecutor):
  LaneToolContribution<RuntimeRootRequestToolContext> {
  return new LaneToolContribution(executor, context => baseLaneContext(context));
}

/** Preflight reads the admitted authority tuple and the group's preferred runtime root. */
export function shellPreflightContribution(executor: LocalShellPreflightExecutor): LaneToolContribution<ShellPreflightContext> {
  return new LaneToolContribution(executor, context => ({ ...baseLaneContext(context),
    authority: context.shell_authority_admission, preferredRuntimeRootId: preferredRoot(context) }));
}

/**
 * local_shell_execute_executor.rs:644–653: authority is re-read from the session row (never the
 * admission tuple) at execution start and at the spawn boundary; without the Chat V2 DB it fails.
 */
export function shellExecuteContext(context: ExecutionContext): ShellExecuteContext {
  const shell: ShellExecuteContext = { ...baseLaneContext(context),
    shellAuthorityAdmission: context.shell_authority_admission,
    shellGuardApproved: context.shell_guard_approved,
    preferredRuntimeRootId: preferredRoot(context) };
  if (context.cancellation_token !== null) shell.signal = context.cancellation_token;
  if (context.chat_v2_db !== null) {
    shell.readAuthority = () => {
      const chat = context.services.get('chatSession');
      if (chat === undefined) throw new Error('chatSession service is unavailable');
      const state = chat.getSessionAuthorityState(context.session_id);
      return [state.authorityMode, state.permissionPreset];
    };
  }
  return shell;
}

export function localShellExecuteContribution(executor: LocalShellExecuteExecutor): LaneToolContribution<ShellExecuteContext> {
  return new LaneToolContribution(executor, shellExecuteContext);
}

export interface GitLaneContext extends GitExecutionContext { shell: ShellExecuteContext; }

/** git.rs routes every semantic Git tool through LocalShellExecuteExecutor::execute_shell_with_options. */
export function gitShellChannel(shell: LocalShellExecuteExecutor): GitRunShell {
  return (args, ctx, options) => {
    const shellContext = (ctx as Partial<GitLaneContext>).shell;
    if (shellContext === undefined) throw new Error('Semantic Git tools require the local shell execution context');
    return shell.executeShellWithOptions(args, shellContext, {
      structuredCommandApproved: options.structured_command_approved,
      forceReadOnly: options.force_read_only,
      allowGitMetadataWrite: options.allow_git_metadata_write,
    });
  };
}

export function gitContribution(executor: GitToolExecutor): LaneToolContribution<GitLaneContext> {
  return new LaneToolContribution<GitLaneContext>(executor, context => {
    const shell = shellExecuteContext(context);
    return {
      block_id: context.block_id,
      emitToolCallStart: (name, args, id) => context.emitToolCallStart(name, args, id ?? null),
      emitToolCallEnd: payload => context.emitToolCallEnd(payload),
      emitToolCallError: message => context.emitToolCallError(message),
      saveToolBlock: result => context.saveToolBlock(result),
      warn: message => context.services.logger.warn(message),
      shell,
    };
  });
}
