import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkle } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { Textarea } from '@/components/ui/shad/Textarea';
import type { PluginManagerWorkshop } from '@/features/plugin-manager/workshop';

/** The user's own send action delegates the request; example prompts remain editable drafts. */
export function WorkshopComposer({ workshop, disabled = false }: { workshop?: PluginManagerWorkshop; disabled?: boolean }) {
  const { t } = useTranslation('plugin_manager');
  const id = useId();
  const [prompt, setPrompt] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async () => {
    const text = prompt.trim();
    if (!text || !workshop?.onSubmit || sending || disabled) return;
    setSending(true);
    setError(undefined);
    try {
      await workshop.onSubmit(text);
      setPrompt(current => current.trim() === text ? '' : current);
    } catch (cause) {
      const { getErrorMessage } = await import('@/utils/errorUtils');
      const raw = getErrorMessage(cause);
      setError(workshop.describeError?.(raw) ?? raw);
    } finally { setSending(false); }
  };
  return <form className="space-y-3 rounded-2xl border border-border bg-background p-4" data-testid="workshop-composer"
    onSubmit={event => { event.preventDefault(); void submit(); }}>
    <label htmlFor={id} className="block text-base font-semibold">{t('workshop.composer.title')}</label>
    <Textarea id={id} data-testid="workshop-request" value={prompt} onChange={event => setPrompt(event.target.value)}
      placeholder={t('workshop.composer.placeholder')} rows={3} disabled={sending || disabled}
      onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void submit(); } }} />
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="max-w-xl text-xs leading-relaxed text-muted-foreground">{t('workshop.composer.description')}</p>
      <DsButton type="submit" variant="primary" disabled={!prompt.trim() || !workshop?.onSubmit || sending || disabled} data-testid="workshop-submit">
        <Sparkle className="mr-1.5 size-4" aria-hidden="true" />{t(sending ? 'workshop.composer.sending' : 'workshop.composer.submit')}
      </DsButton>
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </form>;
}
