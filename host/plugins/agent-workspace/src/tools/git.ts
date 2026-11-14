/**
 * `chat_v2/tools/git_executor.rs` 的 TS 移植：语义 Git 工具组（git_status /
 * git_diff / git_log / git_branch / git_commit）。
 *
 * 与原实现一致：
 * - 只接受严格结构化参数，命令由后端按固定模板构造；
 * - 执行通道通过构造参数注入（原实现持有一个 `LocalShellExecuteExecutor`），
 *   执行器自身不注册 `local_shell_execute`；
 * - 读命令 Medium / ReadOnly，写命令 High / Serial，`git_branch` 按 action
 *   动态降级 list；
 * - 路径/分支名/提交信息按平台 quoting 后进入固定命令模板。
 */
import type {
  JsonValue, ToolCall, ToolResultInfo, ToolConcurrency, ToolSensitivity,
} from './shared.ts';
import { stripToolNamespace } from './shared.ts';
import { windowsHasGitBash } from './shell-sandbox-windows.ts';
import { rustTrim } from '../../../../platform/util/index.ts';

export const GIT_TOOL_NAMES = {
  GIT_STATUS: 'git_status',
  GIT_DIFF: 'git_diff',
  GIT_LOG: 'git_log',
  GIT_BRANCH: 'git_branch',
  GIT_COMMIT: 'git_commit',
} as const;

export const MAX_PATHS = 200;
export const MAX_PATH_CHARS = 512;
export const MAX_BRANCH_NAME_CHARS = 200;
export const MAX_MESSAGE_CHARS = 4000;
export const DEFAULT_LOG_LIMIT = 20;
export const MAX_LOG_LIMIT = 100;
export const GIT_DIFF_MAX_OUTPUT_BYTES = 256 * 1024;

/** POSIX（/bin/sh）单引号 quoting：无法表达的单引号拆为 '\'' 三段式。 */
export function quoteArgPosix(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Windows PowerShell 单引号 quoting：单引号成对加倍，无其他转义语义。
 * 没有 pwsh 7 时回落的 powershell.exe 5.1 给 git.exe 拼命令行时只给含空白的参数包一层裸双引号、不做转义，
 * 参数内的 " 或包裹前的末尾 \ 会让 git 把它重新拆成多个参数（越过 `--` 成为选项）。
 */
export function quoteArgPowershell(value: string): string {
  // RUST-FIX(RF-S01-git-powershell-native-quote): Rust passes these through, so a git_commit message like `a b" --amend "c` became git options on PowerShell 5.1
  if (value.includes('"') || (value.endsWith('\\') && /[\s\u0085]/u.test(value))) {
    throw new Error('Windows PowerShell cannot pass this value to git intact: remove ASCII double quotes, and any trailing backslash from a value with whitespace');
  }
  // RUST-FIX(RF-S01-git-powershell-typographic-quote): PowerShell also ends a single-quoted string at U+2018..U+201B; Rust doubles only ', so `’; cmd` in a git_diff path ran cmd.
  return `'${value.replace(/['\u2018-\u201B]/gu, '$&$&')}'`;
}

/**
 * 按运行平台选择 quoting（原 `quote_arg`）。Windows 上有 trusted git-bash
 * 时使用 POSIX quoting，否则使用 PowerShell quoting；其余平台恒为 POSIX。
 */
export function quoteArg(
  value: string,
  platform: NodeJS.Platform = process.platform,
  hasGitBash: boolean = windowsHasGitBash(),
): string {
  if (platform === 'win32') return hasGitBash ? quoteArgPosix(value) : quoteArgPowershell(value);
  return quoteArgPosix(value);
}

export function invalidArgument(field: string, reason: string): string {
  return `Invalid '${field}': ${reason}`;
}

export function argumentsObject(argumentsValue: JsonValue): Record<string, JsonValue> {
  if (argumentsValue === null || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue)) {
    throw new Error(invalidArgument('arguments', 'expected a JSON object'));
  }
  return argumentsValue;
}

export function ensureAllowedKeys(
  argumentsValue: Record<string, JsonValue>,
  allowed: readonly string[],
): void {
  const key = Object.keys(argumentsValue).find(candidate => !allowed.includes(candidate));
  if (key !== undefined) {
    throw new Error(invalidArgument(key, 'unknown field for this tool; additional properties are not allowed'));
  }
}

/**
 * 校验单个 git 路径参数：必须是相对路径，禁止绝对路径、`..` 组件、
 * 前导 `-`（防 option 注入）与控制字符。
 */
export function validateRepoRelativePath(rawPath: string): string {
  const trimmed = rustTrim(rawPath);
  if (trimmed === '') {
    throw new Error(invalidArgument('paths', 'path entries must not be blank'));
  }
  if ([...trimmed].length > MAX_PATH_CHARS) {
    throw new Error(invalidArgument('paths', `path entries must contain at most ${MAX_PATH_CHARS} characters`));
  }
  if (trimmed.startsWith('-')) {
    throw new Error(invalidArgument('paths', `path '${trimmed}' must not start with '-'`));
  }
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(trimmed)) {
    throw new Error(invalidArgument('paths', `path '${trimmed}' contains a control character`));
  }
  if (isAbsoluteRepoPath(trimmed)) {
    throw new Error(invalidArgument('paths', `path '${trimmed}' must be relative to the selected root`));
  }
  if (trimmed.split(/[\\/]/u).includes('..')) {
    throw new Error(invalidArgument('paths', `path '${trimmed}' must not contain '..'`));
  }
  return trimmed;
}

function isAbsoluteRepoPath(value: string): boolean {
  return value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:/u.test(value);
}

export function optionalPaths(
  argumentsValue: Record<string, JsonValue>,
  required: boolean,
): string[] | null {
  if (!Object.hasOwn(argumentsValue, 'paths')) {
    if (required) {
      throw new Error(invalidArgument('paths', 'field is required and must be a non-empty array'));
    }
    return null;
  }
  const value = argumentsValue['paths'];
  if (!Array.isArray(value)) {
    throw new Error(invalidArgument('paths', 'expected an array of relative paths'));
  }
  if (value.length === 0) {
    if (required) {
      throw new Error(invalidArgument('paths', 'must contain at least one path; git_commit never stages the whole tree'));
    }
    return [];
  }
  if (value.length > MAX_PATHS) {
    throw new Error(invalidArgument('paths', `must contain at most ${MAX_PATHS} entries`));
  }
  const paths: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new Error(invalidArgument('paths', 'entries must be strings'));
    }
    paths.push(validateRepoRelativePath(item));
  }
  return paths;
}

/**
 * 分支名校验：非空、禁止前导 `-`（防 option 注入）、禁止空白/控制字符
 * 与 `..`；其余 refname 规则由 git 自身拒绝并回报。
 */
export function validateBranchName(name: string): string {
  const trimmed = rustTrim(name);
  if (trimmed === '') {
    throw new Error(invalidArgument('name', 'branch name must not be blank'));
  }
  if ([...trimmed].length > MAX_BRANCH_NAME_CHARS) {
    throw new Error(invalidArgument('name', `branch name must contain at most ${MAX_BRANCH_NAME_CHARS} characters`));
  }
  if (trimmed.startsWith('-')) {
    throw new Error(invalidArgument('name', "branch name must not start with '-'"));
  }
  if (/[\s\u0085]|[\u0000-\u001f\u007f-\u009f]/u.test(trimmed)) {
    throw new Error(invalidArgument('name', 'branch name must not contain whitespace or control characters'));
  }
  if (trimmed.includes('..')) {
    throw new Error(invalidArgument('name', "branch name must not contain '..'"));
  }
  return trimmed;
}

export function gitCommand(subcommand: string): string {
  return `git --no-pager --no-optional-locks --literal-pathspecs ${subcommand}`;
}

export function buildGitStatusCommand(): string {
  return gitCommand('status --porcelain=v1 --branch');
}

export function buildGitDiffCommand(staged: boolean, paths: readonly string[] | null): string {
  let command = gitCommand('diff');
  if (staged) command += ' --staged';
  if (paths !== null && paths.length > 0) {
    command += ' --';
    for (const path of paths) command += ` ${quoteArg(path)}`;
  }
  return command;
}

export function buildGitLogCommand(limit: number): string {
  return gitCommand(`log -n ${limit} --format='%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1e'`);
}

export function buildGitBranchListCommand(): string {
  return gitCommand("branch --format='%(HEAD)%x1f%(refname:short)%x1f%(objectname:short)%x1f%(subject)%x1e'");
}

export function buildGitBranchCreateCommand(name: string): string {
  return gitCommand(`branch -- ${quoteArg(name)}`);
}

export function buildGitBranchSwitchCommand(name: string): string {
  return gitCommand(`switch -- ${quoteArg(name)}`);
}

/** 安全删除：固定 `-d`（拒绝删除未合并分支），不提供 force。 */
export function buildGitBranchDeleteCommand(name: string): string {
  return gitCommand(`branch -d -- ${quoteArg(name)}`);
}

export function buildGitAddCommand(paths: readonly string[]): string {
  let command = gitCommand('add --');
  for (const path of paths) command += ` ${quoteArg(path)}`;
  return command;
}

export function buildGitCommitCommand(message: string, paths: readonly string[]): string {
  let command = gitCommand(`-c commit.gpgSign=false commit -m ${quoteArg(message)} --`);
  for (const path of paths) command += ` ${quoteArg(path)}`;
  return command;
}

function asJsonObject(value: JsonValue): Record<string, JsonValue> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

/** 从 shell 输出中提取给模型的紧凑摘要。 */
export function shellStepJson(output: JsonValue): JsonValue {
  const record = asJsonObject(output);
  const success = record['success'] === true;
  const stdout = record['stdout'];
  const stderr = record['stderr'];
  return {
    command: record['command'] ?? null,
    exit_code: record['exit_code'] ?? null,
    success,
    stdout: typeof stdout === 'string' ? stdout : '',
    stderr: typeof stderr === 'string' ? stderr : '',
    file_change_summary: record['file_change_summary'] ?? null,
    change_set: record['change_set'] ?? null,
    change_set_complete: record['change_set_complete'] ?? null,
    change_set_error: record['change_set_error'] ?? null,
  };
}

export function shellOutputFailed(output: JsonValue): string | null {
  const record = asJsonObject(output);
  if (record['success'] === true) return null;
  const rawExitCode = record['exit_code'];
  const exitCode = typeof rawExitCode === 'number' && Number.isInteger(rawExitCode)
    ? String(rawExitCode)
    : '<none>';
  const rawStderr = record['stderr'];
  const stderr = rustTrim(typeof rawStderr === 'string' ? rawStderr : '');
  const stderrTail = [...stderr].slice(-1000).join('');
  return stderrTail === ''
    ? `git command failed with exit code ${exitCode}`
    : `git command failed with exit code ${exitCode}: ${stderrTail}`;
}

export class GitToolFailure extends Error {
  readonly output: JsonValue | null;

  constructor(message: string, output: JsonValue | null = null) {
    super(message);
    this.name = 'GitToolFailure';
    this.output = output;
  }

  static plain(message: string): GitToolFailure {
    return new GitToolFailure(message, null);
  }

  static withOutput(message: string, output: JsonValue): GitToolFailure {
    return new GitToolFailure(message, output);
  }
}

/** `ShellExecuteOptions`（local_shell_execute_executor.rs，字段名保持一致）。 */
export interface GitShellExecuteOptions {
  structured_command_approved: boolean;
  force_read_only: boolean;
  allow_git_metadata_write: boolean;
}

/** 执行上下文的最小依赖面；kernel/DB 绑定的部分由宿主注入。 */
export interface GitExecutionContext {
  block_id: string;
  emitToolCallStart?: (toolName: string, argumentsValue: JsonValue, toolCallId?: string) => void;
  emitToolCallEnd?: (payload: JsonValue) => void;
  emitToolCallError?: (message: string) => void;
  saveToolBlock?: (result: ToolResultInfo) => void;
  /** Rust `log::warn!` 的出口；生产注入 kernel `ctx.logger`。 */
  warn?: (message: string) => void;
}

export type GitRunShell = (
  args: JsonValue,
  ctx: GitExecutionContext,
  options: GitShellExecuteOptions,
) => Promise<JsonValue> | JsonValue;

/** 未注入执行通道时的显式失败；Git 执行器在本 lane 不注册 shell 通道。 */
function unboundRunShell(): JsonValue {
  throw new Error('Semantic Git tools require an injected shell execution channel');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failureResult(
  call: ToolCall,
  ctx: GitExecutionContext,
  message: string,
  output: JsonValue,
  durationMs: number,
): ToolResultInfo {
  return {
    toolCallId: call.id,
    blockId: ctx.block_id,
    toolName: call.name,
    input: call.arguments,
    output,
    success: false,
    error: message,
    durationMs,
  };
}

export class GitToolExecutor {
  private readonly runShell: GitRunShell;

  constructor(runShell: GitRunShell = unboundRunShell) {
    this.runShell = runShell;
  }

  static shellArguments(command: string, write: boolean): Record<string, JsonValue> {
    const args: Record<string, JsonValue> = {
      command,
      root_id: 'workspace',
      inherit_env: false,
      env: { GIT_TERMINAL_PROMPT: '0' },
    };
    // 只读命令跳过快照；写命令必须保留文件变更追踪。
    if (!write) args['track_file_changes'] = false;
    return args;
  }

  private runGit(command: string, write: boolean, ctx: GitExecutionContext): Promise<JsonValue> | JsonValue {
    const args = GitToolExecutor.shellArguments(command, write);
    return this.runShell(args, ctx, {
      structured_command_approved: true,
      force_read_only: !write,
      allow_git_metadata_write: write,
    });
  }

  async executeGitStatus(
    argumentsValue: Record<string, JsonValue>,
    ctx: GitExecutionContext,
  ): Promise<JsonValue> {
    ensureAllowedKeys(argumentsValue, []);
    const output = await this.runGit(buildGitStatusCommand(), false, ctx);
    const error = shellOutputFailed(output);
    if (error !== null) throw new Error(error);
    const record = asJsonObject(output);
    return {
      action: 'status',
      format: 'porcelain',
      root_id: record['root_id'] ?? null,
      porcelain: record['stdout'] ?? null,
    };
  }

  async executeGitDiff(
    argumentsValue: Record<string, JsonValue>,
    ctx: GitExecutionContext,
  ): Promise<JsonValue> {
    ensureAllowedKeys(argumentsValue, ['staged', 'paths']);
    let staged = false;
    if (Object.hasOwn(argumentsValue, 'staged')) {
      const value = argumentsValue['staged'];
      if (typeof value !== 'boolean') throw new Error(invalidArgument('staged', 'expected a boolean'));
      staged = value;
    }
    const paths = optionalPaths(argumentsValue, false);
    const command = buildGitDiffCommand(staged, paths);
    const args = GitToolExecutor.shellArguments(command, false);
    args['max_output_bytes'] = GIT_DIFF_MAX_OUTPUT_BYTES;
    const output = await this.runShell(args, ctx, {
      structured_command_approved: true,
      force_read_only: true,
      allow_git_metadata_write: false,
    });
    const error = shellOutputFailed(output);
    if (error !== null) throw new Error(error);
    const record = asJsonObject(output);
    return {
      action: 'diff',
      staged,
      paths: paths ?? [],
      root_id: record['root_id'] ?? null,
      diff: record['stdout'] ?? null,
      stdout_truncated: record['stdout_truncated'] === true,
    };
  }

  async executeGitLog(
    argumentsValue: Record<string, JsonValue>,
    ctx: GitExecutionContext,
  ): Promise<JsonValue> {
    ensureAllowedKeys(argumentsValue, ['limit']);
    let limit: number;
    const raw = argumentsValue['limit'];
    if (raw === undefined || raw === null) {
      limit = DEFAULT_LOG_LIMIT;
    } else {
      if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
        throw new Error(invalidArgument('limit', 'expected an integer'));
      }
      if (raw > 0xffff_ffff || raw < 1 || raw > MAX_LOG_LIMIT) {
        throw new Error(invalidArgument('limit', 'must be between 1 and 100'));
      }
      limit = raw;
    }
    const output = await this.runGit(buildGitLogCommand(limit), false, ctx);
    const error = shellOutputFailed(output);
    if (error !== null) throw new Error(error);
    const record = asJsonObject(output);
    return {
      action: 'log',
      limit,
      root_id: record['root_id'] ?? null,
      log: record['stdout'] ?? null,
    };
  }

  async executeGitBranch(
    argumentsValue: Record<string, JsonValue>,
    ctx: GitExecutionContext,
  ): Promise<JsonValue> {
    ensureAllowedKeys(argumentsValue, ['action', 'name']);
    const actionValue = argumentsValue['action'];
    if (typeof actionValue !== 'string') {
      throw new Error(invalidArgument('action', 'field is required and must be a string'));
    }
    switch (actionValue) {
      case 'list': {
        const output = await this.runGit(buildGitBranchListCommand(), false, ctx);
        const error = shellOutputFailed(output);
        if (error !== null) throw new Error(error);
        const record = asJsonObject(output);
        return {
          action: 'list',
          root_id: record['root_id'] ?? null,
          branches: record['stdout'] ?? null,
        };
      }
      case 'create':
      case 'switch':
      case 'delete': {
        const nameValue = argumentsValue['name'];
        if (typeof nameValue !== 'string') {
          throw new Error(invalidArgument('name', 'field is required for create/switch/delete'));
        }
        const name = validateBranchName(nameValue);
        const command = actionValue === 'create'
          ? buildGitBranchCreateCommand(name)
          : actionValue === 'switch'
            ? buildGitBranchSwitchCommand(name)
            : buildGitBranchDeleteCommand(name);
        const output = await this.runGit(command, true, ctx);
        const error = shellOutputFailed(output);
        if (error !== null) throw new Error(error);
        const record = asJsonObject(output);
        return {
          action: actionValue,
          name,
          root_id: record['root_id'] ?? null,
          stdout: record['stdout'] ?? null,
          stderr: record['stderr'] ?? null,
          file_change_summary: record['file_change_summary'] ?? null,
          change_set: record['change_set'] ?? null,
          change_set_complete: record['change_set_complete'] ?? null,
          change_set_error: record['change_set_error'] ?? null,
        };
      }
      default:
        throw new Error(invalidArgument(
          'action',
          `unknown action '${actionValue}'; expected one of list/create/switch/delete`,
        ));
    }
  }

  async executeGitCommit(
    argumentsValue: Record<string, JsonValue>,
    ctx: GitExecutionContext,
  ): Promise<JsonValue> {
    try {
      ensureAllowedKeys(argumentsValue, ['message', 'paths']);
    } catch (error) {
      throw GitToolFailure.plain(errorMessage(error));
    }
    const messageValue = argumentsValue['message'];
    if (typeof messageValue !== 'string') {
      throw GitToolFailure.plain(invalidArgument('message', 'field is required and must be a string'));
    }
    const message = rustTrim(messageValue);
    if (message === '') {
      throw GitToolFailure.plain(invalidArgument('message', 'must not be blank'));
    }
    if ([...message].length > MAX_MESSAGE_CHARS) {
      throw GitToolFailure.plain(invalidArgument('message', `must contain at most ${MAX_MESSAGE_CHARS} characters`));
    }
    let paths: string[];
    try {
      const parsed = optionalPaths(argumentsValue, true);
      if (parsed === null) {
        throw new Error(invalidArgument('paths', 'field is required and must be a non-empty array'));
      }
      paths = parsed;
    } catch (error) {
      throw GitToolFailure.plain(errorMessage(error));
    }

    // 固定两段式：git add -- <paths> 成功后 git commit -m <message>。两条命令都先构造，quoting 拒绝的参数不会留下已暂存的路径。
    let addCommand: string;
    let commitCommand: string;
    try {
      addCommand = buildGitAddCommand(paths);
      commitCommand = buildGitCommitCommand(message, paths);
    } catch (error) {
      throw GitToolFailure.plain(errorMessage(error));
    }
    let addOutput: JsonValue;
    try {
      addOutput = await this.runGit(addCommand, true, ctx);
    } catch (error) {
      throw GitToolFailure.plain(errorMessage(error));
    }
    const addError = shellOutputFailed(addOutput);
    if (addError !== null) {
      throw GitToolFailure.withOutput(
        `git add staged nothing or failed: ${addError}`,
        {
          action: 'commit',
          paths,
          add: shellStepJson(addOutput),
          commit: null,
        },
      );
    }
    let commitOutput: JsonValue;
    try {
      commitOutput = await this.runGit(commitCommand, true, ctx);
    } catch (error) {
      throw GitToolFailure.withOutput(
        `git add succeeded but git commit could not start: ${errorMessage(error)}`,
        {
          action: 'commit',
          paths,
          add: shellStepJson(addOutput),
          commit: null,
        },
      );
    }
    const commitError = shellOutputFailed(commitOutput);
    if (commitError !== null) {
      throw GitToolFailure.withOutput(
        `git add succeeded but git commit failed: ${commitError}`,
        {
          action: 'commit',
          paths,
          add: shellStepJson(addOutput),
          commit: shellStepJson(commitOutput),
        },
      );
    }
    const record = asJsonObject(commitOutput);
    return {
      action: 'commit',
      paths,
      root_id: record['root_id'] ?? null,
      add: shellStepJson(addOutput),
      commit: shellStepJson(commitOutput),
    };
  }

  canHandle(toolName: string): boolean {
    const name = stripToolNamespace(toolName);
    return name === GIT_TOOL_NAMES.GIT_STATUS
      || name === GIT_TOOL_NAMES.GIT_DIFF
      || name === GIT_TOOL_NAMES.GIT_LOG
      || name === GIT_TOOL_NAMES.GIT_BRANCH
      || name === GIT_TOOL_NAMES.GIT_COMMIT;
  }

  sensitivityLevel(toolName: string): ToolSensitivity {
    const name = stripToolNamespace(toolName);
    // git_branch 混合读写，名称级按 High 收口（fail-closed）。
    if (name === GIT_TOOL_NAMES.GIT_BRANCH || name === GIT_TOOL_NAMES.GIT_COMMIT) return 'high';
    return 'medium';
  }

  sensitivityLevelForCall(toolName: string, argumentsValue: JsonValue): ToolSensitivity {
    if (stripToolNamespace(toolName) === GIT_TOOL_NAMES.GIT_BRANCH) {
      const action = asJsonObject(argumentsValue)['action'];
      return action === 'list' ? 'medium' : 'high';
    }
    return this.sensitivityLevel(toolName);
  }

  hasDynamicSensitivity(toolName: string): boolean {
    return stripToolNamespace(toolName) === GIT_TOOL_NAMES.GIT_BRANCH;
  }

  concurrencyClass(toolName: string): ToolConcurrency {
    const name = stripToolNamespace(toolName);
    if (name === GIT_TOOL_NAMES.GIT_STATUS
      || name === GIT_TOOL_NAMES.GIT_DIFF
      || name === GIT_TOOL_NAMES.GIT_LOG) {
      return 'read_only';
    }
    return 'serial';
  }

  managesCancellation(): boolean {
    return true;
  }

  resultCharBudget(): number | null {
    return null;
  }

  name(): string {
    return 'GitToolExecutor';
  }

  async execute(call: ToolCall, ctx: GitExecutionContext): Promise<ToolResultInfo> {
    const started = performance.now();
    ctx.emitToolCallStart?.(call.name, call.arguments, call.id);

    let output: JsonValue;
    try {
      let argumentsValue: Record<string, JsonValue>;
      try {
        argumentsValue = argumentsObject(call.arguments);
      } catch (error) {
        throw GitToolFailure.plain(errorMessage(error));
      }
      const name = stripToolNamespace(call.name);
      switch (name) {
        case GIT_TOOL_NAMES.GIT_STATUS:
          output = await this.executeGitStatus(argumentsValue, ctx);
          break;
        case GIT_TOOL_NAMES.GIT_DIFF:
          output = await this.executeGitDiff(argumentsValue, ctx);
          break;
        case GIT_TOOL_NAMES.GIT_LOG:
          output = await this.executeGitLog(argumentsValue, ctx);
          break;
        case GIT_TOOL_NAMES.GIT_BRANCH:
          output = await this.executeGitBranch(argumentsValue, ctx);
          break;
        case GIT_TOOL_NAMES.GIT_COMMIT:
          output = await this.executeGitCommit(argumentsValue, ctx);
          break;
        default:
          throw GitToolFailure.plain(`Unknown git tool: ${name}`);
      }
    } catch (error) {
      const failure = error instanceof GitToolFailure
        ? error
        : GitToolFailure.plain(errorMessage(error));
      const durationMs = Math.trunc(performance.now() - started);
      ctx.emitToolCallError?.(failure.message);
      const result = failureResult(
        call,
        ctx,
        failure.message,
        failure.output ?? null,
        durationMs,
      );
      this.saveBlock(ctx, result);
      return result;
    }

    const durationMs = Math.trunc(performance.now() - started);
    ctx.emitToolCallEnd?.({ result: output, durationMs });
    const result: ToolResultInfo = {
      toolCallId: call.id,
      blockId: ctx.block_id,
      toolName: call.name,
      input: call.arguments,
      output,
      success: true,
      durationMs,
    };
    this.saveBlock(ctx, result);
    return result;
  }

  private saveBlock(ctx: GitExecutionContext, result: ToolResultInfo): void {
    if (ctx.saveToolBlock === undefined) return;
    try {
      ctx.saveToolBlock(result);
    } catch (error) {
      // 与原实现一致：持久化失败只记录，不改变工具结果。
      ctx.warn?.(`[GitToolExecutor] Failed to persist tool block: ${errorMessage(error)}`);
    }
  }
}
