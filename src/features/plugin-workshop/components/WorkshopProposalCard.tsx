import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowCounterClockwise, ArrowSquareOut, ChatCircleText, DotsThree, Export, NotePencil, Power, Sparkle, Trash } from '@phosphor-icons/react';
import { AppMenu, AppMenuContent, AppMenuItem, AppMenuSeparator, AppMenuTrigger } from '@/components/ui/app-menu/AppMenu';
import { DsButton } from '@/components/ui/DsButton';
import { WorkshopConfirmationCard, workshopRetryable, WorkshopErrorNotice, type WorkshopConfirmationCardProps } from '../WorkshopConfirmationCard';
import { primaryPlace, type WorkshopItem, type WorkshopPlace } from '../types';
import { describeWorkshopError, isEnvironmentErrorKey } from '../errors';

/** Technical information a learner can paste into a bug report (「导出诊断」): no settings values, no secrets. */
export function workshopDiagnostics(item: WorkshopItem): string {
  return [
    `work: ${item.name} (${item.id}, record ${item.proposalId}, revision ${item.revision ?? '?'})`,
    `phase: ${item.phase}${item.version ? `, version ${item.version}` : ''}${item.installed ? `, installed ${item.installed.version} (${item.installed.phase})` : ''}`,
    item.generation ? `last run: ${item.generation.attempts ?? '?'} round(s), ${Math.round((item.generation.durationMs ?? 0) / 1000)} s${item.generation.tokens ? `, ${item.generation.tokens} tokens` : ''}` : '',
    `description: ${item.description ?? ''}`,
    `changes: ${item.changes.join(' | ')}`,
    `error key: ${item.error ? describeWorkshopError(item.error).key : 'none'}`,
    '--- error ---', item.error ?? '',
  ].filter(Boolean).join('\n');
}


export interface WorkshopProposalCardProps extends WorkshopConfirmationCardProps {
  /** Opens/focuses the workshop conversation for a change or a fix; never silently resubmits an installation. */
  onRepair: () => void;
  exportPath?: string;
  /** 「在文件夹中显示」 for the exported file (absent where the platform cannot reveal files). */
  onReveal?: (path: string) => void;
}

/** The one primary action of an installed work, by what it adds. */
export function workshopPrimaryLabel(t: (key: string, options?: Record<string, unknown>) => string, item: Pick<WorkshopItem, 'name' | 'places'>, place = primaryPlace(item)): string {
  if (!place || place.kind === 'app') return t('card.openNamed', { name: place?.kind === 'app' ? place.title : item.name });
  if (place.kind === 'selectionButton') return t('card.tryNotes');
  return t('card.trySay', { phrase: place.title });
}

function PrimaryIcon({ place }: { place?: WorkshopPlace }) {
  const Icon = place?.kind === 'selectionButton' ? NotePencil : place?.kind === 'agentTool' ? ChatCircleText : ArrowSquareOut;
  return <Icon className="size-4" aria-hidden="true" />;
}

/**
 * The chat card after the decision: installed → one primary action by kind + 「让 AI 改」 + ⋯ (停用 / 卸载 / 导出);
 * off → 启用; uninstalled → 恢复; failed → a plain sentence with 「让 AI 修」 and 「回到上一版」.
 */
export function WorkshopProposalCard({ onRepair, exportPath, onReveal, ...props }: WorkshopProposalCardProps) {
  const { t } = useTranslation('plugin_manager');
  const { item, busy, onAction } = props;
  // 「打开」 can wait for the view to appear after install (up to 5 s): say so while it does.
  const [opening, setOpening] = useState(false);
  useEffect(() => { if (!busy) setOpening(false); }, [busy]);
  const tryIt = () => { setOpening(true); onAction('try'); };
  const place = primaryPlace(item);
  // 「回到上一版」 is about the installed version (its predecessor), never about a proposal in progress.
  const canGoBack = item.installed ? Boolean(item.installed.previousVersion)
    : Boolean(item.previousVersion && item.previousVersion !== item.version);
  // A work that was never installed can be deleted once it is no longer in progress.
  const canDiscard = !item.installed && (item.phase === 'failed' || item.phase === 'cancelled');
  const discard = canDiscard ? (
    <DsButton size="sm" variant="ghost" disabled={busy} className="gap-1.5 text-muted-foreground" data-testid="workshop-discard" onClick={() => onAction('discard')}>
      <Trash className="size-4" aria-hidden="true" />{t('workshop.actions.discard')}
    </DsButton>
  ) : null;
  const live = item.phase === 'installed' || item.phase === 'disabled';
  // Offer a smaller version when the work itself failed, rather than for environment errors.
  const canReduce = item.phase === 'failed'
    && !isEnvironmentErrorKey(describeWorkshopError(item.error ?? '').key);
  const [copied, setCopied] = useState(false);
  const copyDiagnostics = () => {
    void navigator.clipboard?.writeText(workshopDiagnostics(item)).then(() => setCopied(true), () => setCopied(false));
  };
  const more = live ? (
    <AppMenu>
      <AppMenuTrigger asChild>
        <DsButton size="sm" variant="ghost" iconOnly disabled={busy} data-testid="workshop-more" aria-label={t('workshop.actions.more')}>
          <DotsThree className="size-5" weight="bold" aria-hidden="true" />
        </DsButton>
      </AppMenuTrigger>
      <AppMenuContent align="end" width={200}>
        {item.phase === 'installed' ? <AppMenuItem icon={<Power size={16} />} data-testid="workshop-menu-disable" onClick={() => onAction('disable')}>{t('workshop.actions.disable')}</AppMenuItem> : null}
        {canGoBack ? <AppMenuItem icon={<ArrowCounterClockwise size={16} />} data-testid="workshop-menu-restore-previous" title={t('workshop.restoreDataHint')} onClick={() => onAction('restore')}>{t('workshop.actions.restorePrevious')}</AppMenuItem> : null}
        <AppMenuItem icon={<Export size={16} />} data-testid="workshop-menu-export" onClick={() => onAction('export')}>{t('workshop.actions.export')}</AppMenuItem>
        <AppMenuSeparator />
        <AppMenuItem destructive icon={<Trash size={16} />} data-testid="workshop-menu-uninstall" onClick={() => onAction('undo')}>{t('workshop.actions.uninstall')}</AppMenuItem>
      </AppMenuContent>
    </AppMenu>
  ) : null;
  const modify = (
    <DsButton size="sm" variant="outline" disabled={busy} className="gap-1.5" data-testid="workshop-modify" onClick={onRepair}>
      <Sparkle className="size-4" aria-hidden="true" />{t('workshop.actions.modify')}
    </DsButton>
  );
  return <div className="space-y-2.5">
    <WorkshopConfirmationCard {...props} onRepair={onRepair} />
    {item.phase === 'installed' && <p role="status" data-testid="workshop-installed" className="text-sm text-success">{busy && opening ? t('workshop.opening') : t('workshop.installed')}</p>}
    {item.phase === 'disabled' && !item.error && <p role="status" className="text-sm text-muted-foreground">{t('workshop.disabled')}</p>}
    {item.phase === 'disabled' && item.error && <WorkshopErrorNotice raw={item.error} name={item.name} busy={busy} emphasis={false} onRepair={onRepair} onRedo={() => onAction('redo')} />}
    {item.phase === 'undone' && <p role="status" data-testid="workshop-undone" className="text-sm text-muted-foreground">{t('workshop.undone')}</p>}
    {(live || item.phase === 'undone') && (
      <div className="flex flex-wrap items-center gap-2 pt-0.5" data-testid="workshop-installed-actions">
        {item.phase === 'installed' && (
          <DsButton size="sm" variant="primary" disabled={busy} className="gap-1.5" data-testid="workshop-primary" data-place={place?.kind ?? 'app'} onClick={tryIt}>
            <PrimaryIcon place={place} />{workshopPrimaryLabel(t, item, place)}
          </DsButton>
        )}
        {item.phase === 'disabled' && (
          <DsButton size="sm" variant="primary" disabled={busy} data-testid="workshop-enable" onClick={() => onAction('try')}>{t('workshop.actions.enable')}</DsButton>
        )}
        {item.phase === 'undone' && (
          <DsButton size="sm" variant="primary" disabled={busy} data-testid="workshop-restore" onClick={() => onAction('restore')}>{t('workshop.actions.restore')}</DsButton>
        )}
        {modify}
        {more}
      </div>
    )}
    {exportPath && (
      <div role="status" className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" data-testid="workshop-exported">
        <span className="min-w-0 break-all">{t('workshop.exported', { path: exportPath })}</span>
        {onReveal ? <DsButton size="sm" variant="ghost" data-testid="workshop-reveal" onClick={() => onReveal(exportPath)}>{t('workshop.actions.reveal')}</DsButton> : null}
      </div>
    )}
    {item.phase === 'cancelled' && discard ? <div className="flex flex-wrap items-center gap-2">{discard}</div> : null}
    {item.phase === 'failed' && (
      <div className="space-y-2 text-sm" data-testid="workshop-failed">
        <WorkshopErrorNotice raw={item.error ?? ''} name={item.name} busy={busy} emphasis={!workshopRetryable(item)} onRepair={onRepair}
          onRetry={() => onAction('confirm')} onRedo={() => onAction('redo')}
          extra={<>
            {canGoBack && item.rollback !== 'restored' && (!item.installed || item.installed.phase === 'failed') ? (
              <DsButton size="sm" variant="outline" disabled={busy} data-testid="workshop-restore-previous" onClick={() => onAction('restore')}>
                {t('workshop.actions.restorePrevious')}
              </DsButton>
            ) : null}
            {canReduce ? (
              <DsButton size="sm" variant="outline" disabled={busy} data-testid="workshop-reduce" onClick={() => onAction('reduce')}>
                {t('workshop.actions.reduce')}
              </DsButton>
            ) : null}
            {canReduce ? (
              <DsButton size="sm" variant="ghost" disabled={busy} data-testid="workshop-diagnostics" onClick={copyDiagnostics}>
                {t(copied ? 'workshop.actions.diagnosticsCopied' : 'workshop.actions.diagnostics')}
              </DsButton>
            ) : null}
            {discard}
          </>} />
        {canGoBack && item.rollback !== 'restored' && (!item.installed || item.installed.phase === 'failed')
          ? <p data-testid="workshop-restore-data-hint" className="text-xs text-muted-foreground">{t('workshop.restoreDataHint')}</p>
          : null}
        {/* A failed modification: the installed version is untouched and keeps running. */}
        {item.installed && item.installed.phase !== 'failed' && item.installed.phase !== 'undone'
          ? <p role="status" data-testid="workshop-installed-untouched" className="text-muted-foreground">{t('workshop.installedUntouched', { version: item.installed.version })}</p>
          : null}
        {item.rollback === 'restored' || item.rollback === 'not-needed'
          ? <p role="status" className="text-muted-foreground">{t('workshop.recovered')}</p>
          : null}
      </div>
    )}
  </div>;
}
