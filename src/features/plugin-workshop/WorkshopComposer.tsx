import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Info, ShieldChevron, Sparkle } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { Textarea } from '@/components/ui/shad/Textarea';
import { cn } from '@/lib/utils';
import type { PluginManagerWorkshop } from '@/features/plugin-manager/workshop';
import { getErrorMessage } from '@/utils/errorUtils';

export interface WorkshopComposerProps {
  workshop?: PluginManagerWorkshop;
  disabled?: boolean;
  safeMode?: boolean;
  disabledReason?: string;
}

/** The user's own send action delegates the request; example prompts remain editable drafts. */
export function WorkshopComposer({ workshop, disabled = false, safeMode = false, disabledReason }: WorkshopComposerProps) {
  const { t } = useTranslation('plugin_manager');
  const id = useId();
  const statusId = useId();
  const [prompt, setPrompt] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();

  const hasSubmit = Boolean(workshop?.onSubmit);
  const canSubmit = !disabled && hasSubmit;
  const inputDisabled = sending || !canSubmit;

  const statusKind: 'safe-mode' | 'disabled' | 'unavailable' | 'submit-unavailable' | null = disabled
    ? (safeMode ? 'safe-mode' : 'disabled')
    : !workshop
      ? 'unavailable'
      : !hasSubmit
        ? 'submit-unavailable'
        : null;

  const statusMessage = statusKind === null
    ? undefined
    : disabled && disabledReason
      ? disabledReason
      : statusKind === 'safe-mode'
        ? t('workshop.composer.safeModeDisabled')
        : statusKind === 'disabled'
          ? t('workshop.composer.disabled')
          : statusKind === 'unavailable'
            ? t('workshop.composer.unavailable')
            : t('workshop.composer.submitUnavailable');

  const submit = async () => {
    const text = prompt.trim();
    if (!text || !workshop?.onSubmit || sending || disabled) return;
    setSending(true);
    setError(undefined);
    try {
      await workshop.onSubmit(text);
      setPrompt(current => current.trim() === text ? '' : current);
    } catch (cause) {
      const raw = getErrorMessage(cause);
      setError(workshop.describeError?.(raw) ?? raw);
    } finally { setSending(false); }
  };

  return (
    <form
      className="space-y-3 rounded-2xl border border-border bg-background p-4"
      data-testid="workshop-composer"
      onSubmit={event => { event.preventDefault(); void submit(); }}
    >
      <label htmlFor={id} className="block text-base font-semibold">{t('workshop.composer.title')}</label>
      {statusMessage ? (
        <div
          id={statusId}
          aria-live="polite"
          data-testid="workshop-composer-status"
          data-reason={statusKind ?? undefined}
          className={cn(
            'flex items-start gap-2 rounded-xl border px-3 py-2 text-xs leading-relaxed',
            statusKind === 'safe-mode'
              ? 'border-warning/30 bg-warning/10 text-warning'
              : 'border-border bg-muted/60 text-muted-foreground',
          )}
        >
          {statusKind === 'safe-mode'
            ? <ShieldChevron className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            : <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />}
          <span className={cn('min-w-0 break-words', statusKind === 'safe-mode' && 'text-foreground/90')}>
            {statusMessage}
          </span>
        </div>
      ) : null}
      <Textarea
        id={id}
        data-testid="workshop-request"
        value={prompt}
        onChange={event => setPrompt(event.target.value)}
        placeholder={t('workshop.composer.placeholder')}
        rows={3}
        disabled={inputDisabled}
        aria-describedby={statusMessage ? statusId : undefined}
        onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void submit(); } }}
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-xs leading-relaxed text-muted-foreground">{t('workshop.composer.description')}</p>
        <DsButton
          type="submit"
          variant="primary"
          disabled={!prompt.trim() || !canSubmit || sending}
          aria-describedby={statusMessage ? statusId : undefined}
          data-testid="workshop-submit"
        >
          <Sparkle className="mr-1.5 size-4" aria-hidden="true" />
          {t(sending ? 'workshop.composer.sending' : 'workshop.composer.submit')}
        </DsButton>
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </form>
  );
}
