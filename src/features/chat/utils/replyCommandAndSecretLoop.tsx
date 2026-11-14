import React, { useCallback, useState } from 'react';
import { Eye, EyeSlash, Play, ShieldCheck, Stop } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';

// ============================================================================
// 1. 聊天流 bash/sh 代码块一键运行与幂等自动续跑控制器 (ReplyCommandLoopController)
// ============================================================================

export const REPLY_COMMAND_NOTE_METADATA_KEY = 'openchamberReplyCommand';
export const REPLY_COMMAND_CONTINUATION_METADATA_KEY = 'openchamberReplyCommandContinuation';

const RUNNABLE_SHELL_LANGUAGES = new Set(['bash', 'sh', 'zsh', 'shell']);

export interface ReplyCommandVisibilityParams {
  isStreaming: boolean;
  language: string | null | undefined;
  isPeekSurface?: boolean;
  command?: string;
}

export interface ReplyCommandAnchor {
  replyMessageId: string;
  command: string;
  shellMessageId: string;
  continuationId: string;
  startedAt: number;
}

export interface ReplyCommandSettlement {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stoppedByUser: boolean;
}

export type ReplyCommandStatus = 'running' | 'finished' | 'failed' | 'stopped';

export interface ReplyCommandRunState {
  anchor: ReplyCommandAnchor;
  status: ReplyCommandStatus;
  settlement: ReplyCommandSettlement | null;
  continued: boolean;
}

export interface ReplyCommandContinuationPayload {
  /** 固定为 anchor.continuationId，供服务端/多端去重拒绝重复唤醒 */
  id: string;
  continuationId: string;
  replyMessageId: string;
  shellMessageId: string;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  synthetic: true;
  text: string;
  metadata: {
    [REPLY_COMMAND_CONTINUATION_METADATA_KEY]: {
      shellMessageId: string;
      replyMessageId: string;
      continuationId: string;
      exitCode: number;
    };
  };
}

export interface ShellTimelineRowLike {
  id?: string;
  messageId?: string;
  shellMessageId?: string;
  role?: string;
  metadata?: Record<string, unknown>;
  info?: {
    id: string;
    role: string;
    metadata?: Record<string, unknown>;
  };
}

export interface ReplyCommandLoopOptions {
  now?: () => number;
  redactOutput?: (text: string) => string;
  onTriggerContinuation?: (payload: ReplyCommandContinuationPayload) => void | Promise<void>;
}

/**
 * 归一化代码块语言标识并判定是否属于可一键执行的 Shell 语言族
 */
export function isRunnableShellLanguage(language: string | null | undefined): boolean {
  if (typeof language !== 'string') return false;
  const normalized = language.trim().toLowerCase().replace(/^language-/, '');
  return RUNNABLE_SHELL_LANGUAGES.has(normalized);
}

/**
 * 准入守卫：仅当助手消息已完整结束（!isStreaming）、非预览浮窗（!isPeekSurface）、
 * 且语言属于 bash | sh | zsh | shell 时允许显示运行按钮（防止半截流式命令被截断误执行）
 */
export function canShowReplyCommandRunButton({
  isStreaming,
  language,
  isPeekSurface = false,
  command,
}: ReplyCommandVisibilityParams): boolean {
  if (isStreaming || isPeekSurface) return false;
  if (!isRunnableShellLanguage(language)) return false;
  if (command !== undefined && command.trim().length === 0) return false;
  return true;
}

/**
 * 单调递增 ID 生成器（参考 OpenChamber ascendingId）：
 * 即使在同一毫秒内连续调用，序列号严格单调递增，字典序与时序完全一致。
 */
export class MonotonicIdGenerator {
  private lastTimestamp = 0;
  private counter = 0;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  public next(prefix: string): string {
    const current = Math.max(0, Math.floor(this.now()));
    if (current > this.lastTimestamp) {
      this.lastTimestamp = current;
      this.counter = 0;
    } else {
      this.counter += 1;
    }
    const tsPart = this.lastTimestamp.toString(16).padStart(12, '0');
    const seqPart = this.counter.toString(16).padStart(6, '0');
    return `${prefix}_${tsPart}_${seqPart}`;
  }
}

function extractRowInfo(row: ShellTimelineRowLike): {
  id: string;
  role: string | undefined;
  metadata: Record<string, unknown> | undefined;
} {
  if (row.info && typeof row.info === 'object') {
    return {
      id: row.info.id,
      role: row.info.role,
      metadata: row.info.metadata,
    };
  }
  return {
    id: row.shellMessageId ?? row.messageId ?? row.id ?? '',
    role: row.role,
    metadata: row.metadata,
  };
}

function readAnchorFromNoteMetadata(
  metadata: Record<string, unknown> | undefined,
): Pick<ReplyCommandAnchor, 'replyMessageId' | 'shellMessageId'> | null {
  const raw = metadata?.[REPLY_COMMAND_NOTE_METADATA_KEY];
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const replyMessageId =
    typeof obj.replyMessageId === 'string'
      ? obj.replyMessageId
      : typeof obj.replyMessageID === 'string'
        ? obj.replyMessageID
        : '';
  const shellMessageId =
    typeof obj.shellMessageId === 'string'
      ? obj.shellMessageId
      : typeof obj.shellMessageID === 'string'
        ? obj.shellMessageID
        : '';
  if (!replyMessageId || !shellMessageId) return null;
  return { replyMessageId, shellMessageId };
}

/**
 * 聊天流 bash 代码块一键运行与幂等续跑三段式状态机控制器
 */
export class ReplyCommandLoopController {
  private readonly redactOutput: (text: string) => string;
  private readonly idGen: MonotonicIdGenerator;
  private readonly now: () => number;
  private readonly onTriggerContinuation?: (
    payload: ReplyCommandContinuationPayload,
  ) => void | Promise<void>;
  private readonly runsByShellId = new Map<string, ReplyCommandRunState>();
  private readonly shellOrder: string[] = [];
  private readonly triggeredContinuationIds = new Set<string>();

  constructor(options: ReplyCommandLoopOptions = {}) {
    this.redactOutput = options.redactOutput ?? ((text) => text);
    this.now = options.now ?? Date.now;
    this.idGen = new MonotonicIdGenerator(this.now);
    this.onTriggerContinuation = options.onTriggerContinuation;
  }

  /**
   * 阶段 1：生成唯一单调递增的 shellMessageId 与 continuationId，注册前置绑定锚点
   */
  public startRun(replyMessageId: string, command: string): ReplyCommandAnchor {
    const normalizedReplyId = replyMessageId.trim();
    const normalizedCommand = command.trim();
    if (!normalizedReplyId) {
      throw new Error('[ReplyCommandLoopController::startRun] replyMessageId is required');
    }
    if (!normalizedCommand) {
      throw new Error('[ReplyCommandLoopController::startRun] command is required');
    }

    const shellMessageId = this.idGen.next('msg_shell');
    const continuationId = this.idGen.next('msg_cont');
    const anchor: ReplyCommandAnchor = {
      replyMessageId: normalizedReplyId,
      command,
      shellMessageId,
      continuationId,
      startedAt: this.now(),
    };

    this.runsByShellId.set(shellMessageId, {
      anchor,
      status: 'running',
      settlement: null,
      continued: false,
    });
    this.shellOrder.push(shellMessageId);
    return anchor;
  }

  /**
   * 构造与锚点对应的隐藏合成会话备注消息（用于刷新后重连定位代码块运行记录）
   */
  public buildSessionNoteMessage(anchor: ReplyCommandAnchor): {
    role: 'synthetic';
    text: string;
    metadata: Record<string, unknown>;
  } {
    return {
      role: 'synthetic',
      text: `The user is running this command from your reply:\n${this.redactOutput(anchor.command)}`,
      metadata: {
        [REPLY_COMMAND_NOTE_METADATA_KEY]: { ...anchor, command: this.redactOutput(anchor.command) },
      },
    };
  }

  /**
   * 阶段 2：将已被代码块内联输出框认领的 shellMessageId 从主聊天时间线剔除，
   * 避免同一输出在代码块下方和对话底部重复出现两次。
   * 若传入 loadedReplyIds，仅当所属 replyMessageId 已加载时才剔除（防止孤儿输出丢失）。
   */
  public filterDuplicateShellTimelineRows<T extends ShellTimelineRowLike>(
    rows: readonly T[],
    options?: { loadedReplyIds?: ReadonlySet<string> },
  ): T[] {
    const claimedShellToReply = new Map<string, string>();
    for (const [shellId, state] of this.runsByShellId.entries()) {
      claimedShellToReply.set(shellId, state.anchor.replyMessageId);
    }

    const assistantIdsInRows = new Set<string>();
    for (const row of rows) {
      const info = extractRowInfo(row);
      if (info.role === 'assistant' && info.id) {
        assistantIdsInRows.add(info.id);
      }
      if (info.role === 'synthetic' || info.metadata) {
        const parsedNote = readAnchorFromNoteMetadata(info.metadata);
        if (parsedNote) {
          claimedShellToReply.set(parsedNote.shellMessageId, parsedNote.replyMessageId);
        }
      }
    }

    if (claimedShellToReply.size === 0) {
      return [...rows];
    }

    const effectiveLoadedReplies =
      options?.loadedReplyIds ??
      (assistantIdsInRows.size > 0 ? assistantIdsInRows : null);

    return rows.filter((row) => {
      const info = extractRowInfo(row);
      if (!info.id) return true;
      const isShellRow = info.role === undefined || info.role === 'shell';
      if (!isShellRow) return true;

      const ownerReplyId = claimedShellToReply.get(info.id);
      if (!ownerReplyId) return true;

      if (effectiveLoadedReplies && !effectiveLoadedReplies.has(ownerReplyId)) {
        return true;
      }
      return false;
    });
  }

  /**
   * 阶段 3：仅当命令自然结束（stoppedByUser === false）且该 continuationId 尚未触发过续跑时，
   * 生成幂等自动续跑载荷（多次调用同一 continuationId 严格只触发一次，多端在线绝不唤醒 Agent 两次）
   */
  public settleRunAndBuildContinuation(
    shellMessageId: string,
    settlement: ReplyCommandSettlement,
  ): ReplyCommandContinuationPayload | null {
    const state = this.runsByShellId.get(shellMessageId);
    if (!state) return null;

    const exitCode = settlement.exitCode;
    state.settlement = {
      exitCode: settlement.exitCode,
      stdout: this.redactOutput(settlement.stdout),
      stderr: this.redactOutput(settlement.stderr),
      stoppedByUser: settlement.stoppedByUser,
    };

    if (settlement.stoppedByUser) {
      state.status = 'stopped';
      return null;
    }

    state.status = exitCode === 0 ? 'finished' : 'failed';
    if (exitCode === null) return null;

    const { continuationId, replyMessageId, command } = state.anchor;
    if (this.triggeredContinuationIds.has(continuationId)) {
      return null;
    }

    this.triggeredContinuationIds.add(continuationId);
    state.continued = true;

    const payload: ReplyCommandContinuationPayload = {
      id: continuationId,
      continuationId,
      replyMessageId,
      shellMessageId,
      command: this.redactOutput(command),
      exitCode,
      stdout: this.redactOutput(settlement.stdout),
      stderr: this.redactOutput(settlement.stderr),
      synthetic: true,
      text: 'The command the user ran from your reply has ended; its output is above. Continue from it.',
      metadata: {
        [REPLY_COMMAND_CONTINUATION_METADATA_KEY]: {
          shellMessageId,
          replyMessageId,
          continuationId,
          exitCode,
        },
      },
    };

    void this.onTriggerContinuation?.(payload);
    return payload;
  }

  public getRunState(shellMessageId: string): ReplyCommandRunState | null {
    const state = this.runsByShellId.get(shellMessageId);
    return state ? { ...state, anchor: { ...state.anchor } } : null;
  }

  public findLatestRun(replyMessageId: string, command: string): ReplyCommandRunState | null {
    for (let i = this.shellOrder.length - 1; i >= 0; i -= 1) {
      const state = this.runsByShellId.get(this.shellOrder[i]);
      if (
        state &&
        state.anchor.replyMessageId === replyMessageId &&
        state.anchor.command === command
      ) {
        return { ...state, anchor: { ...state.anchor } };
      }
    }
    return null;
  }

  public hasTriggeredContinuation(continuationId: string): boolean {
    return this.triggeredContinuationIds.has(continuationId);
  }
}

export interface ReplyCommandActionButtonProps {
  isStreaming: boolean;
  language: string | null | undefined;
  command: string;
  isPeekSurface?: boolean;
  isRunning?: boolean;
  isStarting?: boolean;
  onRun: () => void;
  onStop?: () => void;
  className?: string;
}

export const ReplyCommandActionButton: React.FC<ReplyCommandActionButtonProps> = ({
  isStreaming,
  language,
  command,
  isPeekSurface = false,
  isRunning = false,
  isStarting = false,
  onRun,
  onStop,
  className,
}) => {
  const { t } = useTranslation('chatV2');

  if (!canShowReplyCommandRunButton({ isStreaming, language, isPeekSurface, command })) {
    return null;
  }

  const label = isRunning
    ? t('replyCommand.stopTitle', '停止运行')
    : t('replyCommand.runTitle', '运行命令');

  return (
    <button
      type="button"
      data-reply-command-run=""
      disabled={isStarting}
      aria-label={label}
      title={label}
      onClick={isRunning ? onStop : onRun}
      className={cn(
        'inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:opacity-50',
        className,
      )}
    >
      {isRunning ? <Stop size={13} weight="fill" /> : <Play size={13} weight="fill" />}
    </button>
  );
};

// ============================================================================
// 2. 零上下文泄露的临时密钥请求引擎与输出脱敏器 (SecretVaultSessionManager)
// ============================================================================

export const SECRET_FILE_MODE = 0o600 as const;
export const SECRET_FILE_TTL_MS = 24 * 60 * 60 * 1000;
export const SECRET_ENV_CACHE_TTL_MS = 10 * 60 * 1000;
export const MIN_REDACTABLE_SECRET_LENGTH = 4;
const SECRET_MAX_VALUE_LENGTH = 16_000;
const NUL_CHAR = '\u0000';

export type SecretDeliveryMode = 'file_path_handoff' | 'env_injection';

export interface ActiveSecretDescriptor {
  label: string;
  value: string;
}

export type ActiveSecretInput =
  | ReadonlyArray<ActiveSecretDescriptor>
  | Record<string, string>
  | ReadonlyMap<string, string>;

export interface ControlledSecretFileRecord {
  filePath: string;
  mode: typeof SECRET_FILE_MODE;
  createdAt: number;
  expiresAt: number;
  sessionId: string;
  callId: string;
  label: string;
}

export interface FilePathHandoffResult {
  mode: 'file_path_handoff';
  status: 'saved';
  filePath: string;
  fileMode: typeof SECRET_FILE_MODE;
  expiresAt: number;
  summary: string;
  note: string;
}

export interface EnvInjectionResult {
  mode: 'env_injection';
  status: 'submitted';
  envName: string;
  label: string;
  remembered: boolean;
  expiresAt: number | null;
  summary: string;
  note: string;
}

export interface SecretDeclinedResult {
  mode: SecretDeliveryMode;
  status: 'declined';
  label: string;
  summary: string;
  note: string;
}

export type SecretResolutionResult =
  | FilePathHandoffResult
  | EnvInjectionResult
  | SecretDeclinedResult;

/**
 * KMP 前缀函数：线性时间 O(M) 构造部分匹配表
 */
function buildKmpPrefix(pattern: string): Int32Array {
  const prefix = new Int32Array(pattern.length);
  for (let i = 1; i < pattern.length; i += 1) {
    let len = prefix[i - 1];
    while (len > 0 && pattern[i] !== pattern[len]) {
      len = prefix[len - 1];
    }
    if (pattern[i] === pattern[len]) {
      len += 1;
    }
    prefix[i] = len;
  }
  return prefix;
}

/**
 * KMP 线性扫描查找所有命中区间（含重叠命中）
 */
function findAllOccurrences(pattern: string, text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  if (!pattern || !text || pattern.length > text.length) return ranges;

  const prefix = buildKmpPrefix(pattern);
  let matched = 0;
  for (let i = 0; i < text.length; i += 1) {
    while (matched > 0 && text[i] !== pattern[matched]) {
      matched = prefix[matched - 1];
    }
    if (text[i] === pattern[matched]) {
      matched += 1;
    }
    if (matched === pattern.length) {
      ranges.push([i - pattern.length + 1, i + 1]);
      matched = prefix[matched - 1];
    }
  }
  return ranges;
}

function leadingTailOverlap(pattern: string, text: string): number {
  const head = text.slice(0, Math.max(0, pattern.length - 1));
  const combined = `${pattern}${NUL_CHAR}${head}`;
  const prefix = buildKmpPrefix(combined);
  return prefix[prefix.length - 1];
}

function normalizeActiveSecrets(activeSecrets: ActiveSecretInput): ActiveSecretDescriptor[] {
  const list: ActiveSecretDescriptor[] = [];
  if (Array.isArray(activeSecrets)) {
    for (const entry of activeSecrets) {
      if (entry && typeof entry.label === 'string' && typeof entry.value === 'string') {
        list.push({ label: entry.label.trim(), value: entry.value });
      }
    }
  } else if (activeSecrets instanceof Map) {
    for (const [label, value] of activeSecrets.entries()) {
      if (typeof label === 'string' && typeof value === 'string') {
        list.push({ label: label.trim(), value });
      }
    }
  } else if (activeSecrets && typeof activeSecrets === 'object') {
    for (const [label, value] of Object.entries(activeSecrets)) {
      if (typeof value === 'string') {
        list.push({ label: label.trim(), value });
      }
    }
  }

  return list
    .filter((item) => item.label.length > 0 && item.value.length >= MIN_REDACTABLE_SECRET_LENGTH)
    .sort((a, b) => b.value.length - a.value.length);
}

/**
 * 输出自动脱敏器（吸收自 OpenChamber secret-run.js redactSecrets）：
 * 将 stdout/stderr 中出现的任何长度 >= 4 的密钥明文一次性自动替换为 `[secret:LABEL]`。
 * 所有区间均在原始文本上基于 KMP + 差分数组同步计算，按最长匹配优先染色，
 * 杜绝重叠密钥半截泄露或二次替换移位误伤。
 */
export function redactSecretsFromCommandOutput(
  output: string,
  activeSecrets: ActiveSecretInput,
  options?: { cutAtStart?: boolean },
): string {
  if (!output) return output;
  const secrets = normalizeActiveSecrets(activeSecrets);
  if (secrets.length === 0) return output;

  const owner: Array<string | null> = new Array(output.length).fill(null);

  for (const { label, value } of secrets) {
    const ranges = findAllOccurrences(value, output);
    if (options?.cutAtStart) {
      const tailLen = leadingTailOverlap(value, output);
      if (tailLen >= MIN_REDACTABLE_SECRET_LENGTH) {
        ranges.push([0, tailLen]);
      }
    }
    if (ranges.length === 0) continue;

    const diff = new Int32Array(output.length + 1);
    for (const [start, end] of ranges) {
      diff[start] += 1;
      diff[end] -= 1;
    }

    let depth = 0;
    for (let i = 0; i < output.length; i += 1) {
      depth += diff[i];
      if (depth > 0 && owner[i] === null) {
        owner[i] = label;
      }
    }
  }

  const pieces: string[] = [];
  let cursor = 0;
  for (let i = 0; i < output.length; i += 1) {
    const label = owner[i];
    if (label === null || (i > 0 && owner[i - 1] === label)) continue;
    pieces.push(output.slice(cursor, i), `[secret:${label}]`);
    cursor = i;
    while (cursor < output.length && owner[cursor] === label) {
      cursor += 1;
    }
    i = cursor - 1;
  }
  pieces.push(output.slice(cursor));
  return pieces.join('');
}

export interface SecretVaultSessionOptions {
  now?: () => number;
  tempDir?: string;
  fileTtlMs?: number;
  envCacheTtlMs?: number;
  onWriteControlledFile?: (
    filePath: string,
    plaintext: string,
    mode: typeof SECRET_FILE_MODE,
  ) => void | Promise<void>;
  onRemoveControlledFile?: (filePath: string) => void | Promise<void>;
}

interface EnvSecretLease {
  envName: string;
  label: string;
  value: string;
  expiresAt: number;
}

/**
 * 零上下文泄露临时密钥会话管理器：
 * 1. file_path_handoff：生成 0o600 权限、24h 过期的受控临时文件路径，返回给工具的载荷绝不含密钥明文；
 * 2. env_injection：支持可选 10 分钟会话内存租约缓存与 stdout/stderr 自动脱敏。
 */
export class SecretVaultSessionManager {
  private readonly now: () => number;
  private readonly tempDir: string;
  private readonly fileTtlMs: number;
  private readonly envCacheTtlMs: number;
  private readonly idGen: MonotonicIdGenerator;
  private readonly onWriteControlledFile?: SecretVaultSessionOptions['onWriteControlledFile'];
  private readonly onRemoveControlledFile?: SecretVaultSessionOptions['onRemoveControlledFile'];

  /** 受控文件私密存储表（仅宿主要求读取文件时内部可见，绝不序列化到工具返回值） */
  private readonly privateFileVault = new Map<
    string,
    { record: ControlledSecretFileRecord; plaintext: string }
  >();
  /** 会话级 10 分钟环境变量内存缓存 key = `${sessionId}\u0000${envName}` */
  private readonly envLeases = new Map<string, EnvSecretLease>();

  constructor(options: SecretVaultSessionOptions = {}) {
    this.now = options.now ?? Date.now;
    this.tempDir = (options.tempDir ?? '/tmp/opencode/secrets').replace(/\/+$/, '');
    this.fileTtlMs = options.fileTtlMs ?? SECRET_FILE_TTL_MS;
    this.envCacheTtlMs = options.envCacheTtlMs ?? SECRET_ENV_CACHE_TTL_MS;
    this.idGen = new MonotonicIdGenerator(this.now);
    this.onWriteControlledFile = options.onWriteControlledFile;
    this.onRemoveControlledFile = options.onRemoveControlledFile;
  }

  private validatePlaintext(value: string): void {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error('[SecretVaultSessionManager] Secret value must not be empty');
    }
    if (value.length > SECRET_MAX_VALUE_LENGTH) {
      throw new Error(
        `[SecretVaultSessionManager] Secret exceeds max length of ${SECRET_MAX_VALUE_LENGTH}`,
      );
    }
    if (value.includes(NUL_CHAR)) {
      throw new Error('[SecretVaultSessionManager] Secret must not contain NUL characters');
    }
  }

  private leaseKey(sessionId: string, envName: string): string {
    return `${sessionId}${NUL_CHAR}${envName}`;
  }

  /**
   * 模式 1：file_path_handoff —— 写入受控临时文件（mode: 0o600, expiresAt: now + 24h），
   * 仅把文件路径返回给工具调用，密钥明文永不进入消息历史或 LLM 上下文。
   */
  public async submitFilePathHandoff(params: {
    sessionId: string;
    callId: string;
    label: string;
    value: string;
  }): Promise<FilePathHandoffResult> {
    this.validatePlaintext(params.value);
    const createdAt = this.now();
    const expiresAt = createdAt + this.fileTtlMs;
    const token = this.idGen.next('sec');
    const filePath = `${this.tempDir}/${token}`;

    const record: ControlledSecretFileRecord = {
      filePath,
      mode: SECRET_FILE_MODE,
      createdAt,
      expiresAt,
      sessionId: params.sessionId,
      callId: params.callId,
      label: params.label.trim(),
    };

    await this.onWriteControlledFile?.(filePath, params.value, SECRET_FILE_MODE);
    this.privateFileVault.set(filePath, { record, plaintext: params.value });

    return {
      mode: 'file_path_handoff',
      status: 'saved',
      filePath,
      fileMode: SECRET_FILE_MODE,
      expiresAt,
      summary: `Saved secret (${record.label}) to controlled temporary file`,
      note: 'The user saved the secret to a private 0600 file deleted after 24 hours. Read it inside the command that needs it and never print, echo, or log its contents.',
    };
  }

  /**
   * 模式 2：env_injection —— 注入受控执行环境并支持可选 10 分钟内存缓存，绝不向模型暴露明文
   */
  public submitEnvInjection(params: {
    sessionId: string;
    callId: string;
    envName: string;
    label?: string;
    value: string;
    rememberForTenMinutes?: boolean;
  }): EnvInjectionResult {
    this.validatePlaintext(params.value);
    const envName = params.envName.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(envName)) {
      throw new Error(`[SecretVaultSessionManager] Invalid environment variable name: ${envName}`);
    }

    const label = (params.label ?? envName).trim() || envName;
    const remember = Boolean(params.rememberForTenMinutes);
    let expiresAt: number | null = null;

    if (remember) {
      expiresAt = this.now() + this.envCacheTtlMs;
      this.envLeases.set(this.leaseKey(params.sessionId, envName), {
        envName,
        label,
        value: params.value,
        expiresAt,
      });
    }

    return {
      mode: 'env_injection',
      status: 'submitted',
      envName,
      label,
      remembered: remember,
      expiresAt,
      summary: `Injected secret (${label}) into isolated environment variable ${envName}`,
      note: 'The secret was injected into the process environment. Any occurrence in stdout/stderr is redacted as [secret:LABEL].',
    };
  }

  /**
   * 拒绝密钥请求：生成干净的只读摘要，不阻塞会话
   */
  public declineSecretRequest(params: {
    sessionId: string;
    callId: string;
    label: string;
    mode: SecretDeliveryMode;
  }): SecretDeclinedResult {
    const label = params.label.trim();
    return {
      mode: params.mode,
      status: 'declined',
      label,
      summary: `Declined secret request (${label})`,
      note: 'The user declined to provide this secret. Continue without it or explain what requires it.',
    };
  }

  /**
   * 查询受控文件元信息（不含明文），若已超过 24h 自动清理并返回 null
   */
  public getControlledFileMetadata(filePath: string): ControlledSecretFileRecord | null {
    const entry = this.privateFileVault.get(filePath);
    if (!entry) return null;
    if (entry.record.expiresAt <= this.now()) {
      this.privateFileVault.delete(filePath);
      void this.onRemoveControlledFile?.(filePath);
      return null;
    }
    return { ...entry.record };
  }

  /**
   * 清理所有已过期的 24h 临时密钥文件
   */
  public async sweepExpiredFiles(): Promise<number> {
    const current = this.now();
    let removed = 0;
    for (const [filePath, entry] of [...this.privateFileVault.entries()]) {
      if (entry.record.expiresAt <= current) {
        this.privateFileVault.delete(filePath);
        await this.onRemoveControlledFile?.(filePath);
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * 读取会话内尚未过期的 10 分钟环境变量缓存（供子进程执行器内部注入，过期自动驱逐）
   */
  public getCachedEnvSecret(sessionId: string, envName: string): string | null {
    const key = this.leaseKey(sessionId, envName);
    const lease = this.envLeases.get(key);
    if (!lease) return null;
    if (lease.expiresAt <= this.now()) {
      this.envLeases.delete(key);
      return null;
    }
    return lease.value;
  }

  /**
   * 对命令执行输出做自动脱敏（合并当前会话活跃的缓存密钥与单次注入密钥）
   */
  public redactSessionCommandOutput(
    sessionId: string,
    output: string,
    transientSecrets?: ActiveSecretInput,
  ): string {
    const current = this.now();
    const descriptors: ActiveSecretDescriptor[] = [];

    for (const [key, lease] of [...this.envLeases.entries()]) {
      if (lease.expiresAt <= current) {
        this.envLeases.delete(key);
        continue;
      }
      if (key.startsWith(`${sessionId}${NUL_CHAR}`)) {
        descriptors.push({ label: lease.envName, value: lease.value });
      }
    }

    if (transientSecrets) {
      descriptors.push(...normalizeActiveSecrets(transientSecrets));
    }

    return redactSecretsFromCommandOutput(output, descriptors);
  }

  /**
   * 清空指定会话缓存的全部环境变量密钥
   */
  public forgetSessionSecrets(sessionId: string): number {
    let count = 0;
    const prefix = `${sessionId}${NUL_CHAR}`;
    for (const key of [...this.envLeases.keys()]) {
      if (key.startsWith(prefix)) {
        this.envLeases.delete(key);
        count += 1;
      }
    }
    return count;
  }
}

// ============================================================================
// 3. <SecretRequestCard /> 零上下文泄露单行私密密钥输入卡与自动坍缩摘要
// ============================================================================

export interface SecretRequestCardProps {
  sessionId: string;
  callId: string;
  label: string;
  reason: string;
  mode?: SecretDeliveryMode;
  envName?: string;
  placeholder?: string;
  vaultManager?: SecretVaultSessionManager;
  initialResolution?: SecretResolutionResult | null;
  onResolved?: (result: SecretResolutionResult) => void | Promise<void>;
  className?: string;
}

export const SecretRequestCard: React.FC<SecretRequestCardProps> = ({
  sessionId,
  callId,
  label,
  reason,
  mode = 'file_path_handoff',
  envName = 'SECRET_TOKEN',
  placeholder,
  vaultManager,
  initialResolution = null,
  onResolved,
  className,
}) => {
  const { t } = useTranslation('chatV2');
  const [defaultVault] = useState(() => new SecretVaultSessionManager());
  const activeVault = vaultManager ?? defaultVault;

  const [secretValue, setSecretValue] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [rememberTenMinutes, setRememberTenMinutes] = useState(false);
  const [busy, setBusy] = useState(false);
  const [resolution, setResolution] = useState<SecretResolutionResult | null>(initialResolution);

  const handleSubmit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (busy || !secretValue.trim()) return;
      setBusy(true);
      try {
        const result: SecretResolutionResult =
          mode === 'env_injection'
            ? activeVault.submitEnvInjection({
                sessionId,
                callId,
                envName,
                label,
                value: secretValue,
                rememberForTenMinutes: rememberTenMinutes,
              })
            : await activeVault.submitFilePathHandoff({
                sessionId,
                callId,
                label,
                value: secretValue,
              });

        setSecretValue('');
        setRevealed(false);
        setResolution(result);
        await onResolved?.(result);
      } finally {
        setBusy(false);
      }
    },
    [
      activeVault,
      busy,
      callId,
      envName,
      label,
      mode,
      onResolved,
      rememberTenMinutes,
      secretValue,
      sessionId,
    ],
  );

  const handleDecline = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = activeVault.declineSecretRequest({
        sessionId,
        callId,
        label,
        mode,
      });
      setSecretValue('');
      setRevealed(false);
      setResolution(result);
      await onResolved?.(result);
    } finally {
      setBusy(false);
    }
  }, [activeVault, busy, callId, label, mode, onResolved, sessionId]);

  // 提交或拒绝后自动坍缩为单行只读摘要（绝不残留明文或输入框）
  if (resolution) {
    const isDeclined = resolution.status === 'declined';
    const collapsedText = isDeclined
      ? t('secretRequest.collapsedDeclined', '已拒绝提供密钥：{{label}}', { label })
      : resolution.mode === 'env_injection'
        ? t('secretRequest.collapsedEnvSubmitted', '已注入受控环境变量：{{label}}', {
            label,
          })
        : t('secretRequest.collapsedFileSaved', '已存入临时隔离文件：{{label}}', { label });

    return (
      <div
        data-testid="secret-request-collapsed"
        data-secret-status={resolution.status}
        data-secret-mode={resolution.mode}
        className={cn(
          'flex items-center gap-2 rounded-lg border border-border/35 bg-card/40 px-3 py-2 text-xs text-muted-foreground',
          className,
        )}
      >
        <span
          className={cn(
            'h-1.5 w-1.5 shrink-0 rounded-full',
            isDeclined ? 'bg-muted-foreground' : 'bg-success',
          )}
        />
        <span className="min-w-0 flex-1 truncate text-foreground">{collapsedText}</span>
        {resolution.mode === 'file_path_handoff' && (
          <code className="shrink-0 font-mono tabular-nums text-[11px] text-muted-foreground">
            0600
          </code>
        )}
      </div>
    );
  }

  const toggleRevealLabel = revealed
    ? t('secretRequest.hideSecret', '隐藏密钥')
    : t('secretRequest.showSecret', '显示密钥');

  return (
    <div
      data-testid="secret-request-card"
      data-secret-request-status="waiting"
      data-secret-mode={mode}
      className={cn(
        'space-y-2.5 rounded-xl border border-border/35 bg-card/50 p-3.5 text-sm',
        className,
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-semibold text-foreground">{label}</span>
        {mode === 'env_injection' && (
          <code className="shrink-0 font-mono text-xs text-muted-foreground">{envName}</code>
        )}
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">{reason}</p>

      <form className="flex items-center gap-2" onSubmit={handleSubmit}>
        <div className="relative min-w-0 flex-1">
          <input
            type={revealed ? 'text' : 'password'}
            value={secretValue}
            onChange={(e) => setSecretValue(e.target.value)}
            placeholder={placeholder ?? t('secretRequest.placeholder', '输入临时密钥')}
            aria-label={t('secretRequest.inputLabel', '临时密钥输入框')}
            autoComplete="off"
            data-1p-ignore="true"
            data-lpignore="true"
            data-bwignore="true"
            disabled={busy}
            className="w-full rounded-md border border-border/35 bg-background py-1.5 pl-2.5 pr-8 text-xs text-foreground outline-none focus:border-primary disabled:opacity-60"
          />
          <button
            type="button"
            aria-label={toggleRevealLabel}
            aria-pressed={revealed}
            title={toggleRevealLabel}
            disabled={busy}
            onClick={() => setRevealed((prev) => !prev)}
            className="absolute right-1.5 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            {revealed ? <EyeSlash size={14} /> : <Eye size={14} />}
          </button>
        </div>

        <button
          type="submit"
          disabled={busy || !secretValue.trim()}
          className="inline-flex shrink-0 items-center justify-center rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          {t('secretRequest.save', '保存')}
        </button>
      </form>

      {mode === 'env_injection' && (
        <label className="flex w-fit cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={rememberTenMinutes}
            disabled={busy}
            onChange={(e) => setRememberTenMinutes(e.target.checked)}
            className="rounded border-border/35 accent-primary"
          />
          <span>{t('secretRequest.remember10m', '在当前会话内存中记住 10 分钟')}</span>
        </label>
      )}

      <div className="flex items-center gap-1.5 border-t border-border/35 pt-2 text-xs text-muted-foreground">
        <ShieldCheck size={14} className="shrink-0 text-success" />
        <span className="min-w-0 flex-1">
          {t('secretRequest.privacy', '密钥不会进入消息历史或模型上下文')}
        </span>
        <button
          type="button"
          disabled={busy}
          onClick={() => void handleDecline()}
          className="shrink-0 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:opacity-50"
        >
          {t('secretRequest.decline', '拒绝')}
        </button>
      </div>
    </div>
  );
};

export default SecretRequestCard;
