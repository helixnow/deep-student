// Rust: src/chat_v2/tools/chatanki_transform_script.rs.
// 沙箱执行与输出读回；归一化、输出校验、解释器/job 目录分在 transform-script-{spec,output,sandbox}.ts，本文件统一 re-export。
import { join, delimiter, dirname, resolve } from '../../../platform/util/path.ts';
import type {
  AnkiCard, TransformSandboxBackend, TransformSandboxEffects, TransformSandboxPolicy,
  TransformSandboxProcess,
} from '../api.ts';
import { errorText } from './execution.ts';
import {
  CHATANKI_OUTPUT_FILE, CHATANKI_TRANSFORM_SCRIPT_OUTPUT_MAX_BYTES, CHATANKI_TRANSFORM_SCRIPT_PROCESS_MAX,
  CHATANKI_TRANSFORM_SCRIPT_STREAM_MAX_BYTES, CHATANKI_TRANSFORM_SCRIPT_STREAM_TAIL_BYTES,
  SCRIPT_CLEANUP_GRACE_MS, buildScriptInput, type NormalizedTransformScript, type ScriptLanguage,
} from './transform-script-spec.ts';
import {
  buildShellCommand, interpreterSearchDirs, prepareTransformJob, resolveInterpreter,
  transformSandboxPolicy, type PreparedTransformJob,
} from './transform-script-sandbox.ts';
import { TransformFsError, transformFs } from './transform-script-fs.ts';
export * from './transform-script-spec.ts';
export * from './transform-script-output.ts';
export * from './transform-script-sandbox.ts';

// ============================================================================
// 沙箱执行
// ============================================================================

/**
 * transform script 在所有受支持桌面后端上必须具备的资源合同。
 * `sandboxFileSizeMaxBytes` 是平台额外纵深防御（Unix RLIMIT_FSIZE；
 * Windows 为 null）；可移植的输出读入上限始终由 `outputFileMaxBytes` 独立强制。
 */
export interface ScriptResourceLimits {
  streamMaxBytes: number;
  streamTailBytes: number;
  outputFileMaxBytes: number;
  sandboxFileSizeMaxBytes: number | null;
  activeProcessMax: number;
}

export function resourceLimitsToJson(limits: ScriptResourceLimits, timeoutMs: number): Record<string, unknown> {
  return {
    wallClockTimeoutMs: timeoutMs,
    stdoutMaxBytes: limits.streamMaxBytes,
    stderrMaxBytes: limits.streamMaxBytes,
    stdoutTailBytes: limits.streamTailBytes,
    stderrTailBytes: limits.streamTailBytes,
    outputFileMaxBytes: limits.outputFileMaxBytes,
    sandboxFileMaxBytes: limits.sandboxFileSizeMaxBytes,
    activeProcessesMax: limits.activeProcessMax,
  };
}

/** 把平台后端能力收敛为 transform 的可移植资源合同（任一缺失即 fail-closed）。 */
export function transformResourceLimits(effects: TransformSandboxEffects): ScriptResourceLimits {
  if (!effects.enforced) throw new Error('transform script requires an enforced hard sandbox');
  if (!effects.networkEnforced) throw new Error('transform script requires enforced network isolation');
  if (!effects.processGroupIsolated) throw new Error('transform script requires isolated process-group cleanup');
  const activeProcessMax = effects.activeProcessLimit;
  if (activeProcessMax === null || activeProcessMax === undefined) {
    throw new Error('transform script requires an active-process limit');
  }
  if (activeProcessMax === 0 || activeProcessMax > CHATANKI_TRANSFORM_SCRIPT_PROCESS_MAX) {
    throw new Error(
      `sandbox active-process limit ${activeProcessMax} is outside the transform script range ` +
      `1..=${CHATANKI_TRANSFORM_SCRIPT_PROCESS_MAX}`,
    );
  }
  return {
    streamMaxBytes: CHATANKI_TRANSFORM_SCRIPT_STREAM_MAX_BYTES,
    streamTailBytes: CHATANKI_TRANSFORM_SCRIPT_STREAM_TAIL_BYTES,
    outputFileMaxBytes: CHATANKI_TRANSFORM_SCRIPT_OUTPUT_MAX_BYTES,
    sandboxFileSizeMaxBytes: effects.fileSizeLimitBytes,
    activeProcessMax,
  };
}

/** 一次脚本执行的观测报告（成功与否都会尽力填充，进入工具返回值与审计）。 */
export interface ScriptExecutionReport {
  language: ScriptLanguage;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  stdoutBytesRead: number;
  stderrBytesRead: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  sandboxBackend: string;
  interpreter: string;
  resourceLimits: ScriptResourceLimits;
}

export function executionReportToJson(
  report: ScriptExecutionReport, timeoutMs: number,
): Record<string, unknown> {
  return {
    language: report.language,
    exitCode: report.exitCode,
    timedOut: report.timedOut,
    timeoutMs,
    durationMs: report.durationMs,
    stdoutTail: report.stdoutTail,
    stderrTail: report.stderrTail,
    stdoutBytesRead: report.stdoutBytesRead,
    stderrBytesRead: report.stderrBytesRead,
    stdoutTruncated: report.stdoutTruncated,
    stderrTruncated: report.stderrTruncated,
    sandbox: report.sandboxBackend,
    interpreter: report.interpreter,
    resourceLimits: resourceLimitsToJson(report.resourceLimits, timeoutMs),
  };
}

/** 脚本执行失败的结构化分类（全部映射为工具的结构化返回，不抛裸异常）。 */
export type ScriptRunErrorKind =
  | 'sandbox_unavailable'
  | 'interpreter_unavailable'
  | 'setup'
  | 'timed_out'
  | 'non_zero_exit'
  | 'output_missing'
  | 'output_too_large';

export class TransformScriptRunError extends Error {
  readonly kind: ScriptRunErrorKind;
  readonly detail: string;
  readonly report: ScriptExecutionReport | null;
  readonly language: ScriptLanguage | null;
  readonly bytes: number | null;
  readonly limit: number | null;

  constructor(
    kind: ScriptRunErrorKind,
    detail: string,
    options: {
      report?: ScriptExecutionReport | null;
      language?: ScriptLanguage | null;
      bytes?: number | null;
      limit?: number | null;
    } = {},
  ) {
    super(detail);
    this.name = 'TransformScriptRunError';
    this.kind = kind;
    this.detail = detail;
    this.report = options.report ?? null;
    this.language = options.language ?? null;
    this.bytes = options.bytes ?? null;
    this.limit = options.limit ?? null;
  }
}

export interface StreamCapture {
  tail: Uint8Array;
  bytesRead: number;
  truncated: boolean;
}

function appendBoundedTail(tail: Uint8Array, chunk: Uint8Array, tailCap: number): Uint8Array {
  if (chunk.length === 0) return tail;
  const combined = new Uint8Array(tail.length + chunk.length);
  combined.set(tail, 0);
  combined.set(chunk, tail.length);
  if (combined.length <= tailCap) return combined;
  return combined.slice(combined.length - tailCap);
}

/**
 * 有界日志捕获：每条流最多消费 `maxBytes + 1` 字节用于识别超限，报告仅保留
 * 已接受前缀的最后 `tailCap` 字节。超限后停止读取并关闭迭代器（脚本收到 broken pipe）。
 */
export async function drainStreamTail(
  reader: AsyncIterable<Uint8Array>, tailCap: number, maxBytes: number,
): Promise<StreamCapture> {
  let tail: Uint8Array = new Uint8Array(0);
  let bytesRead = 0;
  const probeLimit = maxBytes + 1;
  const iterator = reader[Symbol.asyncIterator]();
  try {
    while (bytesRead < probeLimit) {
      let next: IteratorResult<Uint8Array>;
      try { next = await iterator.next(); }
      catch { break; } // boundary-allow empty-catch: Rust drain_stream_tail treats read Err like EOF (rs:998–999), preserving the captured prefix without a log
      if (next.done === true) break;
      const value = next.value;
      const remaining = probeLimit - bytesRead;
      const consumed = Math.min(value.length, remaining);
      const acceptBudget = Math.max(maxBytes - bytesRead, 0);
      const acceptedBytes = Math.min(acceptBudget, consumed);
      if (acceptedBytes > 0) {
        tail = appendBoundedTail(tail, value.subarray(0, acceptedBytes), tailCap);
      }
      bytesRead += consumed;
      if (bytesRead > maxBytes) break;
    }
  } finally {
    if (iterator.return !== undefined) await iterator.return();
  }
  return { tail, bytesRead, truncated: bytesRead > maxBytes };
}

export function tailToString(tail: Uint8Array): string {
  return new TextDecoder('utf-8').decode(tail);
}

export type BoundedOutputReadErrorKind = 'missing' | 'not_regular' | 'too_large' | 'io';

export class BoundedOutputReadError extends Error {
  readonly kind: BoundedOutputReadErrorKind;
  readonly bytes: number | null;
  readonly limit: number | null;

  constructor(kind: BoundedOutputReadErrorKind, detail = '', bytes: number | null = null, limit: number | null = null) {
    super(detail);
    this.name = 'BoundedOutputReadError';
    this.kind = kind;
    this.bytes = bytes;
    this.limit = limit;
  }
}

/**
 * 输出文件的双重有界读取：先用 lstat 快速拒绝，再只读取 `limit + 1` 字节。
 * 符号链接与非常规文件一律拒绝（不跟随链接目标）。
 */
export function readOutputFileBounded(path: string, limit: number): Uint8Array {
  try {
    return transformFs().readBounded(path, limit);
  } catch (error) {
    if (!(error instanceof TransformFsError)) throw new BoundedOutputReadError('io', errorText(error));
    switch (error.kind) {
      case 'missing': throw new BoundedOutputReadError('missing');
      case 'not_regular': throw new BoundedOutputReadError('not_regular');
      case 'too_large': throw new BoundedOutputReadError('too_large', '', error.bytes, error.limit ?? limit);
      default: throw new BoundedOutputReadError('io', error.message);
    }
  }
}

/** 环境变量白名单：从零构建，不继承父进程任何变量。 */
export function scriptEnvironment(job: PreparedTransformJob, interpreter: string): Record<string, string> {
  const pathDirs: string[] = [];
  const seen = new Set<string>();
  const push = (dir: string): void => {
    if (dir.length === 0 || seen.has(dir)) return;
    seen.add(dir);
    pathDirs.push(dir);
  };
  push(dirname(interpreter));
  for (const dir of interpreterSearchDirs()) push(dir);
  return {
    PATH: pathDirs.join(delimiter),
    CHATANKI_INPUT: job.inputPath,
    CHATANKI_OUTPUT: job.outputPath,
    HOME: job.jobDir,
    TMPDIR: job.jobDir,
    TEMP: job.jobDir,
    TMP: job.jobDir,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    PYTHONUTF8: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    NO_COLOR: '1',
  };
}

export interface RunTransformScriptOptions {
  tempRoot: string;
  documentId: string;
  cards: readonly AnkiCard[];
  script: NormalizedTransformScript;
  warn?: (message: string) => void;
  /** Forwarded unchanged to the L05 spawn capability (timeout/cancel). */
  signal?: AbortSignal;
}

export interface RunTransformScriptResult {
  report: ScriptExecutionReport;
  output: Uint8Array;
  jobRef: string;
}

async function withGrace<T>(promise: Promise<T>, graceMs: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), graceMs);
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function emptyCapture(): StreamCapture {
  return { tail: new Uint8Array(0), bytesRead: 0, truncated: false };
}

/**
 * 在平台沙箱内运行变换脚本并读回输出文件字节。
 * 全链条：capability → 解释器 → job 目录 → 沙箱后端 → 超时看门狗（杀整个进程组）
 * → 输出大小闸门；任何失败均为结构化 `TransformScriptRunError`。
 */
export async function runTransformScript(
  sandbox: TransformSandboxBackend, options: RunTransformScriptOptions,
): Promise<RunTransformScriptResult> {
  const warn = options.warn ?? ((): void => { /* warnings are optional outside a tool call */ });
  let capability: { available: true } | { available: false; reason: string };
  try {
    // L05's probe is asynchronous and only resolves after the native backend
    // answers. Keep Rust's SandboxUnavailable classification at this boundary.
    capability = await sandbox.capability();
  } catch (error) {
    throw new TransformScriptRunError('sandbox_unavailable', errorText(error));
  }
  if (capability.available === false) {
    throw new TransformScriptRunError('sandbox_unavailable', capability.reason);
  }
  const contract = sandbox.contract();
  const { script } = options;
  const interpreter = resolveInterpreter(script.language);
  if (interpreter === null) {
    throw new TransformScriptRunError(
      'interpreter_unavailable',
      `no ${script.language} interpreter found on this machine (searched PATH and standard install locations)`,
      { language: script.language },
    );
  }

  const input = buildScriptInput(options.documentId, options.cards);
  let job: PreparedTransformJob;
  let shellCommand: string;
  let policy: TransformSandboxPolicy;
  let resourceLimits: ScriptResourceLimits;
  let child: TransformSandboxProcess;
  try {
    job = prepareTransformJob(options.tempRoot, script, input);
    shellCommand = buildShellCommand(contract.shellKind, script.language, interpreter, job.scriptPath);
    policy = transformSandboxPolicy(job.jobDir, interpreter);
    resourceLimits = transformResourceLimits(sandbox.effectReport(policy));
  } catch (error) {
    if (error instanceof TransformScriptRunError) throw error;
    throw new TransformScriptRunError('setup', errorText(error));
  }
  const started = performance.now();
  try {
    // L05 resolves spawn only after the native backend has a real pid and
    // streams; a rejection here is Rust's Setup spawn failure (after L05's own
    // command-resource cleanup).
    child = await sandbox.spawn({
      command: shellCommand, cwd: job.jobDir, policy, env: scriptEnvironment(job, interpreter),
      signal: options.signal,
    });
  } catch (error) {
    throw new TransformScriptRunError('setup', `Failed to spawn sandboxed transform script: ${errorText(error)}`);
  }

  const stdoutDrain = child.stdout === null ? null : drainStreamTail(
    child.stdout, CHATANKI_TRANSFORM_SCRIPT_STREAM_TAIL_BYTES, CHATANKI_TRANSFORM_SCRIPT_STREAM_MAX_BYTES,
  ).catch(() => emptyCapture()); // Rust collect_stream maps a failed stream task to an empty capture (rs:1222–1226).
  const stderrDrain = child.stderr === null ? null : drainStreamTail(
    child.stderr, CHATANKI_TRANSFORM_SCRIPT_STREAM_TAIL_BYTES, CHATANKI_TRANSFORM_SCRIPT_STREAM_MAX_BYTES,
  ).catch(() => emptyCapture());

  let timedOut = false;
  let exitCode: number | null = null;
  const waitPromise = child.wait();
  try {
    const waitOutcome = await withGrace<{ done: boolean; code: number | null }>(
      waitPromise.then((code) => ({ done: true, code })).catch((error: unknown) => {
        throw new TransformScriptRunError('setup', `Failed to wait for sandboxed transform script: ${errorText(error)}`);
      }),
      script.timeoutMs,
      { done: false, code: null },
    );
    if (waitOutcome.done) {
      exitCode = waitOutcome.code;
    } else {
      timedOut = true;
      try {
        await child.terminateProcessGroup();
      } catch (error) {
        warn(`[chatanki_transform] failed to terminate timed-out script group: ${errorText(error)}`);
      }
      // Rust ignores the bounded reap result, including a second wait error.
      await withGrace(waitPromise.catch(() => null), SCRIPT_CLEANUP_GRACE_MS, null);
    }
    if (!timedOut) {
      try {
        await child.cleanupFinishedProcessGroup();
      } catch (error) {
        warn(`[chatanki_transform] failed to clean up finished script descendants: ${errorText(error)}`);
      }
    }
  } finally {
    // Rust cleans command resources both on wait Err (rs:1185) and after the
    // normal/timeout branches (rs:1210). Do not let wait rejection bypass it.
    try {
      await child.cleanupResources();
    } catch { // boundary-allow empty-catch: Rust cleanup_command_resources returns () and swallows every failure without a log (dstu-agent shell_sandbox.rs:148 no-op, shell_sandbox/windows.rs:385-395 early returns)
    }
  }

  const stdout = stdoutDrain === null
    ? emptyCapture()
    : await withGrace(stdoutDrain, SCRIPT_CLEANUP_GRACE_MS, emptyCapture());
  const stderr = stderrDrain === null
    ? emptyCapture()
    : await withGrace(stderrDrain, SCRIPT_CLEANUP_GRACE_MS, emptyCapture());

  const report: ScriptExecutionReport = {
    language: script.language,
    exitCode,
    timedOut,
    durationMs: Math.floor(performance.now() - started),
    stdoutTail: tailToString(stdout.tail),
    stderrTail: tailToString(stderr.tail),
    stdoutBytesRead: stdout.bytesRead,
    stderrBytesRead: stderr.bytesRead,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
    sandboxBackend: contract.backend,
    interpreter,
    resourceLimits,
  };

  if (timedOut) {
    throw new TransformScriptRunError('timed_out', `transform script timed out after ${script.timeoutMs}ms`, { report });
  }
  if (exitCode !== 0) {
    throw new TransformScriptRunError(
      'non_zero_exit',
      exitCode === null
        ? 'transform script was killed before exiting'
        : `transform script exited with code ${exitCode}`,
      { report },
    );
  }

  let output: Uint8Array;
  try {
    output = readOutputFileBounded(job.outputPath, CHATANKI_TRANSFORM_SCRIPT_OUTPUT_MAX_BYTES);
  } catch (error) {
    if (!(error instanceof BoundedOutputReadError)) throw error;
    if (error.kind === 'missing') {
      throw new TransformScriptRunError('output_missing', `transform script did not write ${CHATANKI_OUTPUT_FILE}`, { report });
    }
    if (error.kind === 'not_regular') {
      throw new TransformScriptRunError('setup', `${CHATANKI_OUTPUT_FILE} must be a regular file`, { report });
    }
    if (error.kind === 'too_large' && error.bytes !== null && error.limit !== null) {
      throw new TransformScriptRunError(
        'output_too_large',
        `${CHATANKI_OUTPUT_FILE} is ${error.bytes} bytes, exceeding the ${error.limit} byte limit`,
        { report, bytes: error.bytes, limit: error.limit },
      );
    }
    throw new TransformScriptRunError('setup', `Failed to read ${CHATANKI_OUTPUT_FILE}: ${error.message}`, { report });
  }

  return { report, output, jobRef: job.jobRef };
}
