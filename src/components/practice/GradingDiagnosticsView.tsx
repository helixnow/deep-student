import { useTranslation } from 'react-i18next';
import type { GradingDiagnostics } from '@/api/practiceApi';

export function GradingDiagnosticsView({ diagnostics }: { diagnostics?: GradingDiagnostics | null }) {
  const { t } = useTranslation('practice');
  if (!diagnostics) return null;
  return (
    <details className="text-xs text-muted-foreground">
      <summary className="cursor-pointer">{t('batch.diagnostics.title')}</summary>
      {diagnostics.error_message && <p className="mt-2 break-words text-destructive">{diagnostics.error_message}</p>}
      <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 break-words">
        <dt>{t('batch.diagnostics.status')}</dt><dd>{t(`batch.diagnostics.${diagnostics.status}`)}</dd>
        <dt>{t('batch.diagnostics.model')}</dt><dd>{diagnostics.model}</dd>
        <dt>{t('batch.diagnostics.outputLimit')}</dt><dd>{diagnostics.max_output_tokens}</dd>
        {diagnostics.finish_reason && <><dt>{t('batch.diagnostics.finishReason')}</dt><dd>{diagnostics.finish_reason}</dd></>}
        {diagnostics.http_status != null && <><dt>HTTP</dt><dd>{diagnostics.http_status}</dd></>}
        <dt>{t('batch.diagnostics.responseChars')}</dt><dd>{diagnostics.response_chars}</dd>
        {diagnostics.usage && <><dt>{t('batch.diagnostics.usage')}</dt><dd><pre className="whitespace-pre-wrap break-all">{JSON.stringify(diagnostics.usage, null, 2)}</pre></dd></>}
      </dl>
    </details>
  );
}
