import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DsButton } from '@/components/ui/DsButton';
import { getBackupJob, importZip, restoreBackup, type BackupJobResultPayload } from '@/api/dataGovernance';
import type { StartupRecoveryIncident } from './dataRecoveryApi';

async function waitForRecoveryJob(jobId: string, update: (message: string | null) => void): Promise<BackupJobResultPayload | null> {
  for (;;) {
    const job = await getBackupJob(jobId);
    if (!job) throw new Error('Backup job unavailable');
    update(job.message ?? null);
    if (job.status === 'cancelled') return null;
    if (job.status === 'completed' && job.result?.success) return job.result;
    if (job.status === 'failed' || job.status === 'completed') throw new Error(job.result?.error ?? job.message ?? 'Backup job failed');
    await new Promise(resolve => window.setTimeout(resolve, 500));
  }
}

export function MobileRestoreRecovery({ incident }: { incident: StartupRecoveryIncident }) {
  const { t } = useTranslation('data', { keyPrefix: 'recovery.mobile_restore' });
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(incident.status === 'resolved');

  const repair = async (priorId?: string) => {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      let id = priorId;
      if (id === undefined) {
        const imported = await importZip('mobile-picker:', undefined, password || undefined);
        const result = await waitForRecoveryJob(imported.job_id, setMessage);
        if (!result) return;
        if (result.stats?.restorable !== true || typeof result.stats.backup_id !== 'string') throw new Error(t('complete_backup_required'));
        id = result.stats.backup_id;
      }
      const job = await restoreBackup(id);
      if (await waitForRecoveryJob(job.job_id, setMessage)) setReady(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
      setMessage(null);
    }
  };

  return (
    <section className="max-w-xl space-y-5">
      <h1 className="text-2xl font-semibold tracking-tight">{t(ready ? 'completed_title' : 'title')}</h1>
      <p className="text-sm leading-6 text-muted-foreground">{t(ready ? 'completed_description' : 'description')}</p>
      {ready ? (
        <DsButton className="min-h-11" onClick={() => window.location.reload()}>{t('restart')}</DsButton>
      ) : (
        <>
          <p className="break-words rounded-lg border px-3 py-2 font-mono text-sm" role="alert">{incident.recovery_error || incident.reason}</p>
          {incident.previous_backup_id && (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">{t('previous_description')}</p>
              <DsButton className="min-h-11" disabled={busy} onClick={() => void repair(incident.previous_backup_id!)}>{t('previous')}</DsButton>
            </div>
          )}
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">{t('choose_description')}</p>
            <label className="block text-sm font-medium" htmlFor="mobile-recovery-password">{t('password')}</label>
            <input id="mobile-recovery-password" className="block min-h-11 w-full max-w-sm rounded-md border bg-background px-3 text-base"
              type="password" autoComplete="off" value={password} onChange={event => setPassword(event.target.value)} disabled={busy} />
            <DsButton className="min-h-11" variant="outline" disabled={busy} onClick={() => void repair()}>{t('choose')}</DsButton>
          </div>
          {busy && <p className="text-sm" role="status">{message || t('working')}</p>}
          {error && <p className="break-words text-sm text-destructive" role="alert">{error}</p>}
        </>
      )}
    </section>
  );
}
