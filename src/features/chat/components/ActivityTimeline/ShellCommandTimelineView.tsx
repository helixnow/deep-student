import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CheckCircle,
  CircleNotch,
  Clock,
  ShieldWarning,
  Terminal,
  WarningCircle,
} from '@phosphor-icons/react';
import { cn } from '@/utils/cn';
import { ShellOutputView, extractShellExecuteOutput } from '../../plugins/blocks/components';

type ShellToolKind = 'preflight' | 'execute';

interface ShellCommandDescriptorInput {
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: unknown;
  toolError?: string;
  toolStatus?: string;
  isPreparing?: boolean;
  isRunning?: boolean;
}

export interface ShellCommandDescriptor {
  kind: ShellToolKind;
  command: string;
  verbKey: 'checking' | 'checked' | 'blocked' | 'running' | 'ran' | 'failed' | 'pending';
  tone: 'muted' | 'running' | 'success' | 'error';
  rootId?: string;
  cwd?: string;
  riskLevel?: string;
  reasons: string[];
  error?: string;
}

function normalizeToolName(toolName: string): string {
  return toolName
    .replace(/^builtin[-:]/, '')
    .replace(/^mcp_/, '')
    .replace(/^mcp\.tools\./, '')
    .replace(/^.*\./, '');
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  if (record.result && typeof record.result === 'object' && !Array.isArray(record.result)) {
    return record.result as Record<string, unknown>;
  }
  return record;
}

function readString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0);
}

export function isShellTimelineTool(toolName?: string): boolean {
  const normalized = normalizeToolName(toolName || '');
  return normalized === 'local_shell_preflight' || normalized === 'local_shell_execute';
}

export function getShellCommandDescriptor({
  toolName,
  toolInput,
  toolOutput,
  toolError,
  toolStatus,
  isPreparing = false,
  isRunning = false,
}: ShellCommandDescriptorInput): ShellCommandDescriptor | null {
  const normalized = normalizeToolName(toolName || '');
  if (normalized !== 'local_shell_preflight' && normalized !== 'local_shell_execute') return null;

  const output = asRecord(toolOutput);
  const input = toolInput || {};
  const kind: ShellToolKind = normalized === 'local_shell_execute' ? 'execute' : 'preflight';
  const command = readString(output.command, input.command) || '';
  const riskLevel = readString(output.risk_level);
  const reasons = Array.isArray(output.reasons)
    ? output.reasons.filter((reason): reason is string => typeof reason === 'string' && reason.length > 0)
    : [];
  const blocked = riskLevel === 'blocked' || output.would_execute === false && reasons.length > 0;
  const failed = toolStatus === 'error' || Boolean(toolError) || output.success === false && kind === 'execute';

  let verbKey: ShellCommandDescriptor['verbKey'];
  let tone: ShellCommandDescriptor['tone'];
  if (isPreparing || isRunning) {
    verbKey = kind === 'preflight' ? 'checking' : 'running';
    tone = 'running';
  } else if (blocked) {
    verbKey = 'blocked';
    tone = 'error';
  } else if (failed) {
    verbKey = 'failed';
    tone = 'error';
  } else if (toolStatus === 'success') {
    verbKey = kind === 'preflight' ? 'checked' : 'ran';
    tone = 'success';
  } else {
    verbKey = 'pending';
    tone = 'muted';
  }

  return {
    kind,
    command,
    verbKey,
    tone,
    rootId: readString(output.root_id, input.root_id),
    cwd: readString(output.cwd, input.cwd),
    riskLevel,
    reasons,
    error: readString(toolError, output.error, output.message),
  };
}

export function shellCommandVerb(
  descriptor: ShellCommandDescriptor,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  return t(`timeline.shell.${descriptor.verbKey}`, {
    defaultValue: {
      checking: '正在检查',
      checked: '已检查',
      blocked: '已拦截',
      running: '正在运行',
      ran: '已运行',
      failed: '运行失败',
      pending: '等待运行',
    }[descriptor.verbKey],
  });
}

interface ShellCommandTimelineViewProps extends ShellCommandDescriptorInput {
  className?: string;
}

export const ShellCommandTimelineView: React.FC<ShellCommandTimelineViewProps> = ({
  className,
  ...input
}) => {
  const { t } = useTranslation('chatV2');
  const descriptor = useMemo(() => getShellCommandDescriptor(input), [input]);
  const executeOutput = useMemo(() => extractShellExecuteOutput(input.toolOutput), [input.toolOutput]);

  if (!descriptor) return null;
  if (descriptor.kind === 'execute' && executeOutput) {
    return <ShellOutputView output={input.toolOutput} className={className} />;
  }

  const StatusIcon = descriptor.tone === 'running'
    ? CircleNotch
    : descriptor.tone === 'success'
      ? CheckCircle
      : descriptor.tone === 'error'
        ? WarningCircle
        : Clock;

  return (
    <div className={cn('overflow-hidden rounded-md border border-border/60 bg-muted/20', className)}>
      <div className="flex items-center gap-1.5 border-b border-border/40 px-3 py-2 text-xs text-muted-foreground">
        {descriptor.kind === 'preflight' ? <ShieldWarning size={13} /> : <Terminal size={13} />}
        <span>{descriptor.kind === 'preflight'
          ? t('timeline.shell.preflight', { defaultValue: 'Shell 检查' })
          : t('shellOutput.title', { defaultValue: '本地命令' })}</span>
      </div>

      <div className="flex items-start gap-2 px-3 py-2.5">
        <span className="shrink-0 select-none font-mono text-xs text-primary">$</span>
        <code className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-xs text-foreground">
          {descriptor.command || t('timeline.shell.commandUnavailable', { defaultValue: '命令内容不可用' })}
        </code>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/40 px-3 py-2 text-[11px]">
        <span className={cn(
          'inline-flex items-center gap-1 font-medium',
          descriptor.tone === 'running' && 'text-primary',
          descriptor.tone === 'success' && 'text-success',
          descriptor.tone === 'error' && 'text-destructive',
          descriptor.tone === 'muted' && 'text-muted-foreground',
        )}>
          <StatusIcon size={12} className={cn(descriptor.tone === 'running' && 'animate-spin')} />
          {shellCommandVerb(descriptor, t)}
        </span>
        {descriptor.riskLevel && (
          <code className="font-mono text-muted-foreground">risk:{descriptor.riskLevel}</code>
        )}
        {descriptor.rootId && (
          <span className="text-muted-foreground">
            root <code className="font-mono">{descriptor.rootId}</code>
          </span>
        )}
        {descriptor.cwd && (
          <span className="min-w-0 text-muted-foreground">
            cwd <code className="font-mono">{descriptor.cwd}</code>
          </span>
        )}
      </div>

      {(descriptor.error || descriptor.reasons.length > 0) && (
        <div className="border-t border-border/40 px-3 py-2 text-[11px] leading-relaxed text-destructive/90">
          {descriptor.error && <div>{descriptor.error}</div>}
          {descriptor.reasons.map((reason) => <div key={reason}>{reason}</div>)}
        </div>
      )}
    </div>
  );
};
