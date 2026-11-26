import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowsLeftRight, CaretDown, CaretRight, CircleNotch, FileCode } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { resolveAgentDisplayName, type PeerExchangeRecord } from '../types';

export interface PeerExchangeStripProps {
  exchange: PeerExchangeRecord;
  defaultExpanded?: boolean;
  className?: string;
}

export const PeerExchangeStrip: React.FC<PeerExchangeStripProps> = ({
  exchange,
  defaultExpanded = false,
  className,
}) => {
  const { t } = useTranslation(['agentMesh']);
  const [expanded, setExpanded] = useState(defaultExpanded);

  const fromLabel = useMemo(
    () => resolveAgentDisplayName(exchange.fromAgent, exchange.fromAgentName),
    [exchange.fromAgent, exchange.fromAgentName],
  );

  const toLabel = useMemo(
    () => resolveAgentDisplayName(exchange.toAgent, exchange.toAgentName),
    [exchange.toAgent, exchange.toAgentName],
  );

  const rounds = Math.max(1, exchange.rounds || 1);

  const summaryText = useMemo(() => {
    if (exchange.kind === 'handoff') {
      if (exchange.changedFiles.length > 0) {
        return t('agentMesh:peerStrip.handoffSummaryWithFiles', {
          from: fromLabel,
          to: toLabel,
          count: exchange.changedFiles.length,
          defaultValue: '{{from}} → {{to}} · 交接实现与 {{count}} 个改动文件',
        });
      }
      return t('agentMesh:peerStrip.handoffSummary', {
        from: fromLabel,
        to: toLabel,
        rounds,
        defaultValue: '{{from}} ⇄ {{to}} · 交接 {{rounds}} 轮',
      });
    }
    if (exchange.topic && exchange.topic.trim()) {
      return t('agentMesh:peerStrip.askSummaryWithTopic', {
        from: fromLabel,
        to: toLabel,
        topic: exchange.topic.trim(),
        rounds,
        defaultValue: '{{from}} ⇄ {{to}} · 就「{{topic}}」请教 {{rounds}} 轮',
      });
    }
    return t('agentMesh:peerStrip.askSummary', {
      from: fromLabel,
      to: toLabel,
      rounds,
      defaultValue: '{{from}} ⇄ {{to}} · 请教 {{rounds}} 轮',
    });
  }, [exchange.changedFiles.length, exchange.kind, exchange.topic, fromLabel, rounds, t, toLabel]);

  return (
    <div
      data-testid={`peer-exchange-strip-${exchange.id}`}
      data-exchange-kind={exchange.kind}
      className={cn(
        'rounded-lg border border-border/35 bg-foreground/[0.015] transition-colors',
        className,
      )}
    >
      <DsButton
        variant="ghost"
        size="sm"
        data-testid="peer-exchange-strip-trigger"
        aria-expanded={expanded}
        aria-label={t('agentMesh:peerStrip.expandAria', {
          defaultValue: '展开或收起智能体间协作详情',
        })}
        onClick={() => setExpanded((prev) => !prev)}
        className="!h-auto w-full !justify-between gap-2 !rounded-lg !px-3 !py-1.5 text-left font-normal text-caption text-muted-foreground hover:bg-foreground/[0.03] hover:text-foreground"
      >
        <span className="flex min-w-0 items-center gap-2">
          <ArrowsLeftRight size={13} className="shrink-0 text-primary/75" />
          <span className="truncate">{summaryText}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {exchange.status === 'running' && (
            <span className="inline-flex items-center gap-1 text-2xs text-primary">
              <CircleNotch size={11} className="animate-spin motion-reduce:animate-none" />
              <span>{t('agentMesh:peerStrip.runningBadge', { defaultValue: '协商中…' })}</span>
            </span>
          )}
          {expanded ? <CaretDown size={12} /> : <CaretRight size={12} />}
        </span>
      </DsButton>

      {expanded && (
        <div
          data-testid="peer-exchange-strip-body"
          className="space-y-2.5 border-t border-border/30 px-3 py-2.5 text-xs"
        >
          {exchange.messages && exchange.messages.length > 0 ? (
            <div className="space-y-2">
              {exchange.messages.map((msg) => (
                <div
                  key={msg.id}
                  className="rounded-md border border-border/30 bg-background/60 px-2.5 py-1.5"
                >
                  <div className="mb-0.5 text-2xs font-medium text-muted-foreground">
                    {resolveAgentDisplayName(msg.sender, msg.senderName)}
                  </div>
                  <div className="whitespace-pre-wrap break-words text-foreground/90">
                    {msg.text}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="space-y-2">
              <div className="rounded-md border border-border/30 bg-background/60 px-2.5 py-1.5">
                <div className="mb-0.5 text-2xs font-medium text-muted-foreground">
                  {fromLabel} ·{' '}
                  {t('agentMesh:peerStrip.questionLabel', { defaultValue: '提问 / 交接说明' })}
                </div>
                <div className="whitespace-pre-wrap break-words text-foreground/90">
                  {exchange.questionOrSummary}
                </div>
              </div>

              {exchange.responseText && (
                <div className="rounded-md border border-border/30 bg-background/60 px-2.5 py-1.5">
                  <div className="mb-0.5 text-2xs font-medium text-muted-foreground">
                    {toLabel} ·{' '}
                    {t('agentMesh:peerStrip.responseLabel', { defaultValue: '同伴回复' })}
                  </div>
                  <div className="whitespace-pre-wrap break-words text-foreground/90">
                    {exchange.responseText}
                  </div>
                </div>
              )}
            </div>
          )}

          {exchange.changedFiles.length > 0 && (
            <div className="space-y-1">
              <div className="text-2xs text-muted-foreground">
                {t('agentMesh:peerStrip.changedFilesLabel', { defaultValue: '交接改动文件' })}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {exchange.changedFiles.map((filePath) => (
                  <span
                    key={filePath}
                    data-testid="peer-exchange-changed-file"
                    className="inline-flex items-center gap-1 rounded-md border border-border/35 bg-background/70 px-2 py-0.5 font-mono text-2xs text-foreground/85"
                  >
                    <FileCode size={11} className="shrink-0 text-muted-foreground" />
                    <span>{filePath}</span>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

PeerExchangeStrip.displayName = 'PeerExchangeStrip';

export default PeerExchangeStrip;
