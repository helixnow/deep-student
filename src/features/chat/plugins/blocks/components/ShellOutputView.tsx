/**
 * Chat V2 - 本地 Shell 执行输出专用渲染
 *
 * 用于渲染 local_shell_execute 工具的结构化输出：命令、runtime root、cwd、
 * exit code、耗时、stdout/stderr 分栏、截断提示、env/network 策略摘要，以及失败解释。
 *
 * 设计约束：复用现有 mcp_tool 块的视觉语言（bg-muted、border-border、font-mono、
 * phosphor 图标、紧凑字号），不新增终端窗口、模态框或侧栏。
 */

import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import {
  Terminal,
  CheckCircle,
  WarningCircle,
  Clock,
  Copy,
  Check,
  CaretDown,
  CaretRight,
} from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { copyTextToClipboard } from '@/utils/clipboardUtils';

// ============================================================================
// 类型
// ============================================================================

interface ShellExecuteOutput {
  command?: string;
  command_hash?: string;
  command_redacted?: boolean;
  command_prefix?: string;
  root_id?: string;
  cwd?: string;
  timeout_ms?: number;
  duration_ms?: number;
  timed_out?: boolean;
  exit_code?: number | null;
  success?: boolean;
  stdout?: string;
  stderr?: string;
  stdout_bytes?: number;
  stderr_bytes?: number;
  stdout_truncated?: boolean;
  stderr_truncated?: boolean;
  root?: {
    id?: string;
    path?: string;
    access?: string;
    session_scoped?: boolean;
  };
  env_policy?: {
    inherit_parent_env?: boolean;
    allowlist_mode?: boolean;
    inherited_keys?: string[];
    explicit_keys?: string[];
    denied_keys?: string[];
  };
  network_policy?: {
    allow_network?: boolean;
    network_capable_command?: boolean;
  };
  sandbox?: {
    backend?: string;
    shell_kind?: string;
    output_encoding?: string;
    enforced?: boolean;
    network_enforced?: boolean;
    readable_roots?: number;
    writable_roots?: number;
  };
}

export interface ShellOutputViewProps {
  output: unknown;
  className?: string;
}

/** 从工具输出中解包 shell 执行结果（兼容 `{ result: {...} }` 包装）。 */
export function extractShellExecuteOutput(output: unknown): ShellExecuteOutput | null {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return null;
  const data = output as Record<string, unknown>;
  const inner =
    data.result && typeof data.result === 'object' && !Array.isArray(data.result)
      ? (data.result as Record<string, unknown>)
      : data;
  // 只要带有 shell 执行的判别字段之一即视为 shell 输出
  if (
    'stdout' in inner ||
    'stderr' in inner ||
    'exit_code' in inner ||
    'timed_out' in inner
  ) {
    return inner as ShellExecuteOutput;
  }
  return null;
}

// ============================================================================
// 子组件
// ============================================================================

/** 单栏默认最多渲染的字符数；超出部分折叠为「显示全部」按钮，避免超大输出拖垮渲染 */
const STREAM_PANE_CLAMP_CHARS = 20_000;

/** 去除 ANSI 转义序列（颜色/光标控制码），终端着色输出在 UI 中显示为纯文本 */
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;

function stripAnsi(text: string): string {
  return text.includes('\u001b') ? text.replace(ANSI_ESCAPE_RE, '') : text;
}

const CopyButton: React.FC<{ text: string; label: string }> = ({ text, label }) => {
  const [copied, setCopied] = useState(false);
  const resetTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => () => {
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
  }, []);
  if (!text) return null;
  return (
    <DsButton
      variant="ghost"
      size="sm"
      onClick={async () => {
        const ok = await copyTextToClipboard(text);
        if (ok) {
          setCopied(true);
          if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
          resetTimerRef.current = setTimeout(() => setCopied(false), 1500);
        }
      }}
      className="!h-auto min-h-8 lg:min-h-0 [@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11 !p-1 text-2xs text-muted-foreground hover:text-foreground"
      aria-label={label}
      title={label}
    >
      {copied ? <Check size={11} className="text-success" /> : <Copy size={11} />}
    </DsButton>
  );
};

const StreamPane: React.FC<{
  title: string;
  text: string;
  truncated?: boolean;
  copyLabel: string;
  truncatedLabel: string;
  tone: 'stdout' | 'stderr';
}> = ({ title, text, truncated, copyLabel, truncatedLabel, tone }) => {
  const { t } = useTranslation('chatV2');
  const [showAll, setShowAll] = useState(false);
  // 显示用文本：去 ANSI 控制码；复制仍用原始文本
  const displayText = useMemo(() => stripAnsi(text), [text]);
  const isClamped = !showAll && displayText.length > STREAM_PANE_CLAMP_CHARS;
  // 保留尾部内容（结论/错误通常在最后）
  const visibleText = isClamped
    ? '…' + displayText.slice(-STREAM_PANE_CLAMP_CHARS)
    : displayText;
  if (!text) return null;
  return (
    <div className="mt-2">
      <div className="mb-1 flex items-center justify-between">
        <span
          className={cn(
            'text-2xs font-semibold uppercase tracking-wider',
            tone === 'stderr' ? 'text-destructive/80' : 'text-muted-foreground',
          )}
        >
          {title}
        </span>
        <CopyButton text={text} label={copyLabel} />
      </div>
      <CustomScrollArea fullHeight={false} className="max-h-60 rounded" viewportClassName="max-h-60">
        <pre
          className={cn(
            'p-2 text-xs font-mono whitespace-pre-wrap break-words',
            tone === 'stderr'
              ? 'bg-destructive/5 dark:bg-destructive/10 text-destructive/90'
              : 'bg-muted/40 dark:bg-muted/20 text-foreground/90',
          )}
        >
          {visibleText}
        </pre>
      </CustomScrollArea>
      {isClamped && (
        <DsButton
          variant="ghost"
          size="sm"
          onClick={() => setShowAll(true)}
          className="mt-0.5 !h-auto min-h-8 lg:min-h-0 [@media(pointer:coarse)]:!min-h-11 !p-1 [@media(pointer:coarse)]:!px-3 text-2xs text-muted-foreground hover:text-foreground"
        >
          {t('shellOutput.showFull', {
            
            kb: (displayText.length / 1024).toFixed(0),
          })}
        </DsButton>
      )}
      {truncated && (
        <div className="mt-0.5 text-2xs text-muted-foreground">{truncatedLabel}</div>
      )}
    </div>
  );
};

// ============================================================================
// 主组件
// ============================================================================

export const ShellOutputView: React.FC<ShellOutputViewProps> = ({ output, className }) => {
  const { t } = useTranslation('chatV2');
  const data = useMemo(() => extractShellExecuteOutput(output), [output]);
  const [showMeta, setShowMeta] = useState(false);

  // 注意：early return 必须放在所有 hooks 之后（rules-of-hooks），
  // 否则 data 在 null / 非 null 间切换时 hooks 数量不一致会导致 React 抛错
  const timedOut = data?.timed_out === true;
  const exitCode = typeof data?.exit_code === 'number' ? data.exit_code : null;
  const success = data?.success === true;
  const durationMs = typeof data?.duration_ms === 'number' ? data.duration_ms : undefined;
  const hasStderr = Boolean(data?.stderr && data.stderr.trim());
  const hasStdout = Boolean(data?.stdout && data.stdout.trim());

  const statusTone = timedOut || (!success && exitCode !== 0)
    ? 'error'
    : success
      ? 'success'
      : 'warn';

  const StatusIcon = statusTone === 'success' ? CheckCircle : WarningCircle;

  // 失败解释：把 exit code / 超时翻译成可操作提示
  const failureHint = useMemo(() => {
    if (timedOut) {
      return t('shellOutput.hint.timeout');
    }
    if (!success && exitCode !== null && exitCode !== 0) {
      if (hasStderr) {
        return t('shellOutput.hint.nonZeroWithStderr');
      }
      return t('shellOutput.hint.nonZero');
    }
    return null;
  }, [timedOut, success, exitCode, hasStderr, t]);

  if (!data) return null;

  const envPolicy = data.env_policy;
  const netPolicy = data.network_policy;
  const sandbox = data.sandbox;
  const envExplicit = Array.isArray(envPolicy?.explicit_keys) ? envPolicy?.explicit_keys.length : 0;
  const inheritedEnvKeys = Array.isArray(envPolicy?.inherited_keys) ? envPolicy.inherited_keys : null;

  return (
    <div className={cn('shell-output-view', className)}>
      {/* 头部：图标 + 命令 + 状态徽章 */}
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-2">
        <Terminal size={12} />
        <span>{t('shellOutput.title')}</span>
      </div>

      <div className="rounded border border-border/30 bg-muted/30 dark:bg-muted/20 overflow-hidden">
        {/* 命令行 */}
        {data.command && (
          <div className="flex items-start gap-2 px-2 py-1.5 border-b border-border/20">
            <span className="text-[color:hsl(var(--primary))] font-mono text-xs shrink-0 select-none">$</span>
            <code className="flex-1 min-w-0 font-mono text-xs text-foreground break-all">
              {data.command}
            </code>
            <CopyButton text={data.command} label={t('shellOutput.copyCommand')} />
          </div>
        )}

        {data.command_redacted && (
          <div className="flex flex-wrap items-center gap-1.5 border-b border-border/20 px-2 py-1 text-2xs text-muted-foreground">
            <span className="rounded bg-warning/10 px-1.5 py-0.5 font-mono text-warning">
              command:redacted
            </span>
            {data.command_hash && (
              <span className="rounded bg-muted px-1.5 py-0.5 font-mono" title={data.command_hash}>
                hash:{data.command_hash.slice(0, 8)}
              </span>
            )}
          </div>
        )}

        {/* 状态条：exit code / 耗时 / root / cwd */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 py-1.5 text-[11px]">
          <span
            className={cn(
              'inline-flex items-center gap-1 font-medium',
              statusTone === 'success' && 'text-success',
              statusTone === 'error' && 'text-destructive',
              statusTone === 'warn' && 'text-warning',
            )}
          >
            <StatusIcon size={13} weight="fill" />
            {timedOut
              ? t('shellOutput.timedOut')
              : t('shellOutput.exitCode', { code: exitCode ?? '—' })}
          </span>
          {durationMs !== undefined && (
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <Clock size={11} />
              {durationMs >= 1000 ? `${(durationMs / 1000).toFixed(1)}s` : `${durationMs}ms`}
            </span>
          )}
          {data.root_id && (
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <span className="opacity-60">root</span>
              <code className="font-mono">{data.root_id}</code>
            </span>
          )}
          {data.root?.path && (
            <span className="inline-flex min-w-0 items-center gap-1 text-muted-foreground">
              <span className="opacity-60">path</span>
              <code className="max-w-[18rem] truncate font-mono" title={data.root.path}>{data.root.path}</code>
            </span>
          )}
          {data.root?.access && (
            <code className="font-mono text-muted-foreground">{data.root.access}</code>
          )}
          {data.cwd && (
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <span className="opacity-60">cwd</span>
              <code className="font-mono truncate max-w-[12rem]" title={data.cwd}>{data.cwd}</code>
            </span>
          )}
        </div>

        {/* 输出分栏 */}
        <div className="px-2 pb-2">
          <StreamPane
            title="stdout"
            tone="stdout"
            text={data.stdout ?? ''}
            truncated={data.stdout_truncated}
            copyLabel={t('shellOutput.copyStdout')}
            truncatedLabel={t('shellOutput.truncated')}
          />
          <StreamPane
            title="stderr"
            tone="stderr"
            text={data.stderr ?? ''}
            truncated={data.stderr_truncated}
            copyLabel={t('shellOutput.copyStderr')}
            truncatedLabel={t('shellOutput.truncated')}
          />
          {!hasStdout && !hasStderr && (
            <div className="mt-2 text-xs text-muted-foreground italic">
              {t('shellOutput.noOutput')}
            </div>
          )}
        </div>

        {/* 失败解释 */}
        {failureHint && (
          <div className="mx-2 mb-2 rounded bg-warning/10 border border-warning/60 px-2 py-1.5 text-[11px] text-warning">
            {failureHint}
          </div>
        )}

        {/* 策略摘要（折叠） */}
        {(envPolicy || netPolicy || sandbox) && (
          <div className="border-t border-border/20 px-2 py-1">
            <DsButton
              variant="ghost"
              size="sm"
              onClick={() => setShowMeta((v) => !v)}
              className="!h-auto min-h-8 lg:min-h-0 !p-0.5 !gap-1 text-2xs text-muted-foreground hover:text-foreground [@media(pointer:coarse)]:!min-h-11"
            >
              {showMeta ? <CaretDown size={10} /> : <CaretRight size={10} />}
              {t('shellOutput.policy')}
            </DsButton>
            {showMeta && (
              <div className="mt-1 flex flex-wrap gap-1.5 pb-1">
                {netPolicy && (
                  <span className="rounded bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground">
                    {netPolicy.allow_network
                      ? t('shellOutput.netOn')
                      : t('shellOutput.netOff')}
                  </span>
                )}
                {envPolicy?.allowlist_mode && (
                  <span className="rounded bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground">
                    {t('shellOutput.envAllowlist')}
                  </span>
                )}
                {envPolicy?.inherit_parent_env === true && (
                  <span className="rounded bg-warning/10 px-1.5 py-0.5 text-2xs text-warning">
                    parent-env
                  </span>
                )}
                {inheritedEnvKeys && (
                  <span
                    className="max-w-[18rem] truncate rounded bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground"
                    title={inheritedEnvKeys.join(', ') || 'none'}
                  >
                    inherited:{inheritedEnvKeys.length}
                    {inheritedEnvKeys.length > 0 ? ` [${inheritedEnvKeys.join(', ')}]` : ''}
                  </span>
                )}
                {envExplicit > 0 && (
                  <span className="rounded bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground">
                    {t('shellOutput.envExplicit', { count: envExplicit })}
                  </span>
                )}
                {sandbox?.backend && (
                  <span className="rounded bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground">
                    sandbox:{sandbox.backend}
                  </span>
                )}
                {sandbox?.shell_kind && (
                  <span className="rounded bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground">
                    shell:{sandbox.shell_kind}
                  </span>
                )}
                {sandbox?.output_encoding && (
                  <span className="rounded bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground">
                    encoding:{sandbox.output_encoding}
                  </span>
                )}
                {typeof sandbox?.readable_roots === 'number' && (
                  <span className="rounded bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground">
                    readable-roots:{sandbox.readable_roots}
                  </span>
                )}
                {sandbox?.enforced === false && (
                  <span className="rounded bg-danger/10 px-1.5 py-0.5 text-2xs text-danger">
                    sandbox:unenforced
                  </span>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default ShellOutputView;
