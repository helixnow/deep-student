// RUST-FIX(RF-P4-plugin-workshop-ui): explicit workshop capability/version confirmation.
// First-use pass: one decision per stage (开始做 / 安装 / 不要了), where to find it once installed, risk said once
// at the install decision, and errors in plain words with the raw text folded under 技术信息.
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DsButton } from '@/components/ui/DsButton';
import { Badge } from '@/components/ui/shad/Badge';
import { Input } from '@/components/ui/shad/Input';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/shad/Card';
import { cn } from '@/lib/utils';
import { describeWorkshopError, type WorkshopNextStep } from './errors';
import { workshopActions, type WorkshopAction, type WorkshopItem, type WorkshopPlace, type WorkshopProgress, type WorkshopSetting } from './types';

export interface WorkshopConfirmationCardProps {
  item: WorkshopItem;
  busy?: boolean;
  /** Raw error of the last action (shown in plain words). */
  error?: string;
  /** True when mounted inside an outer chat tool card (`mcpTool` output slot) to avoid nested card borders. */
  embedded?: boolean;
  /** `input`: the setting values entered on the card, sent with 开始做 / 再试一次. */
  onAction: (action: WorkshopAction, input?: Record<string, string>) => void;
  /** Next step for an error that asks the AI to continue or fix (opens/focuses the workshop conversation). */
  onRepair?: () => void;
  /** Next step for an error that asks for a fresh read. */
  onRefresh?: () => void;
}


/**
 * The one decision of a stage. DsButton paints every variant as ghost (2026-09 ruling), so the primary action gets
 * a quiet filled surface (the same treatment as the plugin manager card's primary) to read as the thing to press.
 */
export const WORKSHOP_PRIMARY = '!bg-muted !text-foreground hover:!bg-[var(--button-plain-hover-bg)] dark:!bg-muted/80';

/** Section label inside the card: small, quiet, never larger than the card title. */
export function WorkshopSectionLabel({ children }: { children: React.ReactNode }) {
  return <h4 data-testid="workshop-section-label" className="text-xs font-medium leading-5 text-muted-foreground">{children}</h4>;
}

/** Stage label key; a work turned off after crashing reads 「已先关掉」, not 「没做成」. */
export function workshopPhaseKey(item: Pick<WorkshopItem, 'phase' | 'error'>): string {
  if (item.phase === 'failed' && item.error) {
    const key = describeWorkshopError(item.error).key;
    if (key === 'crashed' || key === 'activationFailed') return 'workshop.phase.isolated';
  }
  return `workshop.phase.${item.phase}`;
}

/** Short form for the chat tool header: the stage only. */
export function workshopProgressText(t: (key: string, options?: Record<string, unknown>) => string, progress: WorkshopProgress): string {
  if (progress.stage === 'fixing') return t('workshop.progress.fixing', { attempt: progress.attempt });
  if (progress.stage === 'checking' && progress.step === 'link') return t('workshop.progress.link');
  return t(`workshop.progress.${progress.stage}`);
}

/** The card's progress line: what is happening right now (files written so far, which check runs). */
export function workshopProgressDetail(t: (key: string, options?: Record<string, unknown>) => string, progress: WorkshopProgress): string {
  const files = progress.stage !== 'checking' && progress.files?.length ? progress.files.join(t('workshop.progress.fileSeparator')) : '';
  switch (progress.stage) {
    case 'making': return files ? t('workshop.progress.makingFiles', { files }) : t('workshop.progress.makingStart');
    case 'fixing': return files ? t('workshop.progress.fixingFiles', { attempt: progress.attempt, files }) : t('workshop.progress.fixing', { attempt: progress.attempt });
    case 'checking': return t(`workshop.progress.step.${progress.step ?? 'compile'}`);
  }
}

/** A failed start the user can fix on the card: an address that could not be read or a missing / unusable value. */
export function workshopRetryable(item: Pick<WorkshopItem, 'phase' | 'error' | 'settings'>): boolean {
  return item.phase === 'failed' && Boolean(item.settings?.length) && /WORKSHOP_(?:LINK|SETTING_(?:MISSING|INVALID))\b/.test(item.error ?? '');
}

const settingReady = (setting: Pick<WorkshopSetting, 'kind' | 'saved'>, value: string) =>
  setting.kind === 'secret' ? value.trim().length > 0 || setting.saved === true
    : setting.kind === 'text' ? value.trim().length > 0 : /^https:\/\/[^\s/]+\.[^\s]+$/i.test(value.trim());

/** The values the work needs from the user, asked for inside the card before it is made. */
function WorkshopSettingsForm({ settings, values, busy, onChange }: {
  settings: readonly WorkshopSetting[]; values: Record<string, string>; busy?: boolean; onChange: (key: string, value: string) => void;
}) {
  const { t } = useTranslation('plugin_manager');
  return (
    <div className="space-y-2" data-testid="workshop-settings">
      <WorkshopSectionLabel>{t('workshop.settings.label')}</WorkshopSectionLabel>
      {settings.map(setting => {
        const id = `workshop-setting-${setting.key}`;
        const value = values[setting.key] ?? '';
        return (
          <div key={setting.key} className="space-y-1">
            <label htmlFor={id} className="text-sm">{setting.title}</label>
            <Input id={id} data-testid={id} type={setting.kind === 'secret' ? 'password' : setting.kind === 'text' ? 'text' : 'url'}
              inputMode={setting.kind === 'text' || setting.kind === 'secret' ? undefined : 'url'}
              value={value} disabled={busy} spellCheck={false} autoComplete={setting.kind === 'secret' ? 'new-password' : 'off'}
              placeholder={setting.kind === 'secret' ? (setting.saved ? t('workshop.settings.secretSaved') : '') : setting.kind === 'text' ? '' : 'https://…'}
              aria-invalid={value.trim() !== '' && !settingReady(setting, value)}
              className="h-8 text-sm aria-[invalid=true]:border-destructive"
              onChange={event => onChange(setting.key, event.target.value)} />
            {setting.kind === 'ics-url' && (
              <details className="text-xs text-muted-foreground" data-testid="workshop-setting-hint">
                <summary className="cursor-pointer rounded outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('workshop.settings.icsHintTitle')}</summary>
                <p className="mt-1 break-words">{t('workshop.settings.icsHint')}</p>
              </details>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function workshopPlaceText(t: (key: string, options?: Record<string, unknown>) => string, place: WorkshopPlace): string {
  return place.kind === 'selectionButton' ? t('workshop.where.selectionButton') : t(`workshop.where.${place.kind}`, { title: place.title });
}

/** 「装好后在哪里找到它」: one line, from what the work adds; 「预计…」 while it is only the recipe's expectation. */
export function WorkshopWhereToFind({ places, expected = false }: { places?: readonly WorkshopPlace[]; expected?: boolean }) {
  const { t } = useTranslation('plugin_manager');
  if (!places?.length) return null;
  return (
    <p data-testid="workshop-where" data-expected={expected ? 'true' : undefined} className="break-words text-sm">
      <span className="text-muted-foreground">{t(expected ? 'workshop.whereLabelExpected' : 'workshop.whereLabel')}：</span>
      {places.map(place => workshopPlaceText(t, place)).join(t('workshop.whereSeparator'))}
    </p>
  );
}

/** The plain sentence of a Host error, translated (app feature names in the user's words). */
export function workshopErrorText(t: (key: string, options?: Record<string, unknown>) => string, raw: string, name = ''): string {
  const described = describeWorkshopError(raw, name);
  const values: Record<string, unknown> = { ...described.values };
  if (described.values?.services) {
    values.services = described.values.services.split(',')
      .map(service => t(`permission.serviceNames.${service}`, { defaultValue: service })).join(t('workshop.whereSeparator'));
  }
  return t(`workshop.errors.${described.key}`, values);
}

/** A plain sentence, the next step, and the raw text folded away. */
export function WorkshopErrorNotice({ raw, name, busy, tone = 'error', onRepair, onRefresh, onRetry, onRedo, extra }: {
  raw: string; name: string; busy?: boolean; tone?: 'error' | 'quiet';
  onRepair?: () => void; onRefresh?: () => void;
  /** 继续做: run the same proposal again (an interrupted generation). */
  onRetry?: () => void;
  /** 按新版重做: a new proposal of the same description for this app version. */
  onRedo?: () => void;
  extra?: React.ReactNode;
}) {
  const { t } = useTranslation('plugin_manager');
  const described = describeWorkshopError(raw, name);
  // A plugin that was turned off to protect the app is news, not an alarm: said calmly, with the way out next to it.
  const isolated = described.key === 'crashed' || described.key === 'activationFailed' || described.key === 'incompatible';
  const next: WorkshopNextStep = described.next;
  const nextButton = (next === 'repair' || next === 'continue') && onRepair
    ? <DsButton size="sm" variant="primary" disabled={busy} className={WORKSHOP_PRIMARY} data-testid="workshop-error-next" onClick={onRepair}>
      {t(next === 'continue' ? 'workshop.actions.continue' : 'workshop.actions.repair')}
    </DsButton>
    : next === 'retry' && (onRetry ?? onRepair)
      ? <DsButton size="sm" variant="primary" disabled={busy} className={WORKSHOP_PRIMARY} data-testid="workshop-error-next" data-next="retry" onClick={onRetry ?? onRepair}>
        {t(onRetry ? 'workshop.actions.resume' : 'workshop.actions.continue')}
      </DsButton>
      : next === 'redo' && onRedo
        ? <DsButton size="sm" variant="primary" disabled={busy} className={WORKSHOP_PRIMARY} data-testid="workshop-error-next" data-next="redo" onClick={onRedo}>
          {t('workshop.actions.redo')}
        </DsButton>
        : next === 'refresh' && onRefresh
          ? <DsButton size="sm" variant="outline" disabled={busy} data-testid="workshop-error-next" onClick={onRefresh}>{t('workshop.actions.refresh')}</DsButton>
          : null;
  return (
    <div role="alert" data-testid="workshop-error" data-error-key={described.key} className="space-y-2 text-sm">
      <p className={cn('break-words', tone === 'error' && !isolated ? 'text-destructive' : 'text-foreground')}>{workshopErrorText(t, raw, name)}</p>
      {nextButton || extra ? <div className="flex flex-wrap items-center gap-2">{nextButton}{extra}</div> : null}
      {described.raw ? (
        <details className="text-xs text-muted-foreground" data-testid="workshop-error-technical">
          <summary className="cursor-pointer rounded outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('workshop.technical')}</summary>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-2xs">{described.raw}</pre>
        </details>
      ) : null}
    </div>
  );
}

export function WorkshopConfirmationCard({ item, busy, error, embedded = false, onAction, onRepair, onRefresh }: WorkshopConfirmationCardProps) {
  const { t } = useTranslation('plugin_manager');
  const allowed = workshopActions(item.phase);
  const retryable = workshopRetryable(item);
  const deciding = item.phase === 'proposed' || item.phase === 'ready';
  // On a failed work only a retry the user can fix here (a setting) is a card decision; the rest is below the card.
  const actions = allowed.filter(action => action === 'cancel' || (action === 'confirm' && (item.phase !== 'failed' || retryable)));
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries((item.settings ?? []).map(setting => [setting.key, setting.value ?? ''])));
  const askSettings = Boolean(item.settings?.length) && (item.phase === 'proposed' || retryable);
  const settingsReady = !askSettings || (item.settings ?? []).every(setting => settingReady(setting, values[setting.key] ?? ''));
  // The version belongs on the title only when it tells the user something: what this modification turns into.
  const titleText = item.previousVersion && item.version ? `${item.name} · v${item.version}` : item.name;
  const showPlan = deciding || item.phase === 'generating' || item.phase === 'validating' || item.phase === 'installing';
  const body = (
    <>
      {item.description && <p className="break-words">{item.description}</p>}
      {(showPlan || item.phase === 'installed' || item.phase === 'disabled') && <WorkshopWhereToFind places={item.places} expected={item.placesExpected && showPlan} />}
      {/* A modification in progress: the installed version keeps running until the new one is installed. */}
      {showPlan && item.installed && item.installed.phase !== 'undone' && (
        <p data-testid="workshop-installed-alongside" className="text-muted-foreground">{t('workshop.installedAlongside', { version: item.installed.version })}</p>
      )}
      {/* An older card of a work with a newer proposal: one line, the decision is on the newer card. */}
      {item.elsewhere && <p data-testid="workshop-elsewhere" className="text-muted-foreground">{t('workshop.elsewhere', { phase: t(`workshop.phase.${item.elsewhere}`) })}</p>}
      {showPlan && (
        <div className="space-y-1">
          <WorkshopSectionLabel>{t('workshop.canDo')}</WorkshopSectionLabel>
          {item.capabilities.length
            ? <ul data-testid="workshop-capabilities" className="list-inside list-disc break-words">{item.capabilities.map(capability => <li key={capability}>{capability}</li>)}</ul>
            : <p className="text-muted-foreground">{t('workshop.canDoNone')}</p>}
        </div>
      )}
      {showPlan && (
        <div className="space-y-1">
          <WorkshopSectionLabel>{item.previousVersion ? t('workshop.changesSince', { version: item.previousVersion }) : t('workshop.changesNew')}</WorkshopSectionLabel>
          {item.changes.length
            ? <ul className="list-inside list-disc break-words">{item.changes.map((change, index) => <li key={index}>{change}</li>)}</ul>
            : <p className="text-muted-foreground">{t('workshop.changesNone')}</p>}
        </div>
      )}
      {askSettings && item.settings && <WorkshopSettingsForm settings={item.settings} values={values} busy={busy}
        onChange={(key, value) => setValues(current => ({ ...current, [key]: value }))} />}
      {/* 开始做 is the approval to have code written and test-loaded; said where the user gives it. */}
      {item.phase === 'proposed' && <p data-testid="workshop-start-consent" className="text-muted-foreground">{t('workshop.startConsent')}</p>}
      {item.phase === 'editing' && <p data-testid="workshop-editing" className="text-muted-foreground">{t('workshop.agentEditing')}</p>}
      {/* The risk is said once, where the user decides to install. */}
      {item.phase === 'ready' && <p data-testid="workshop-risk" className="text-muted-foreground">{t('workshop.risk')}</p>}
      <div role="status" aria-live="polite" className="space-y-1 break-words empty:hidden">
        {item.progress && <p data-testid="workshop-progress" data-stage={item.progress.stage}>{workshopProgressDetail(t, item.progress)}</p>}
        {item.phase === 'installing' && <p>{t('workshop.installing')}</p>}
        {item.phase === 'cancelled' && <p data-testid="workshop-cancelled" className="text-muted-foreground">
          {item.installed && item.installed.phase !== 'undone' ? t('workshop.cancelledKeepsInstalled', { version: item.installed.version }) : t('workshop.cancelled')}
        </p>}
        {item.phase === 'superseded' && <p data-testid="workshop-superseded" className="text-muted-foreground">{t('workshop.superseded')}</p>}
        {item.rollback === 'restored' && item.phase !== 'failed' && <p className="text-muted-foreground">{t('workshop.restored')}</p>}
        {item.rollback === 'failed' && <p className="text-destructive">{t('workshop.restoreFailed')}</p>}
      </div>
      {error && <WorkshopErrorNotice raw={error} name={item.name} busy={busy} onRepair={onRepair} onRefresh={onRefresh} />}
    </>
  );
  const actionButtons = actions.map(action => {
    const confirmKind = item.phase === 'ready' ? 'install' : item.phase === 'failed' ? 'retry' : 'start';
    const label = action === 'confirm'
      ? t(`workshop.actions.${confirmKind}`)
      : t(deciding ? 'workshop.actions.decline' : 'workshop.actions.stop');
    const input = action === 'confirm' && askSettings ? Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.trim()])) : undefined;
    return (
      <DsButton key={action} size="sm" variant={action === 'confirm' ? 'primary' : 'outline'} disabled={busy || (action === 'confirm' && !settingsReady)}
        className={action === 'confirm' ? WORKSHOP_PRIMARY : undefined}
        data-testid={`workshop-action-${action === 'confirm' ? confirmKind : (deciding ? 'decline' : 'stop')}`}
        onClick={() => (input ? onAction(action, input) : onAction(action))}>
        {label}
      </DsButton>
    );
  });
  const badge = <Badge variant="secondary" data-testid="workshop-phase" data-phase={item.phase}>{t(workshopPhaseKey(item))}</Badge>;

  if (embedded) {
    return (
      <div className="min-w-0 space-y-3" aria-label={t('workshop.label')} data-testid="workshop-card" data-phase={item.phase}>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h3 className="min-w-0 break-words text-sm font-semibold leading-5">{titleText}</h3>
          {/* Embedded in a chat tool card, whose header already shows the stage: no second badge. */}
        </div>
        <div className="space-y-3 text-sm">{body}</div>
        {actions.length > 0 && <div className="flex flex-wrap gap-2">{actionButtons}</div>}
      </div>
    );
  }

  return <Card className="min-w-0 shadow-none" aria-label={t('workshop.label')} data-testid="workshop-card" data-phase={item.phase}>
    <CardHeader className="space-y-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <CardTitle className="break-words text-sm">{titleText}</CardTitle>
        {badge}
      </div>
    </CardHeader>
    <CardContent className="space-y-3 text-sm">{body}</CardContent>
    {actions.length > 0 && <CardFooter className="flex flex-wrap gap-2">{actionButtons}</CardFooter>}
  </Card>;
}
