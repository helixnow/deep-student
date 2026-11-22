// 「它存了什么 / 清空它的数据」 for a workshop plugin (F20): what its UI half keeps in `ctx.ui.storage`
// (local keys under `ds:plugin:<id>:`, the only plugin storage the app can enumerate), and a way to clear it.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash } from '@phosphor-icons/react';

import { DsButton } from '@/components/ui/DsButton';
import { pluginStoragePrefix } from '@/ui-kernel/services/storage';
import { usePluginManagerWorkshop } from './workshop';

export interface PluginStoredData { keys: string[]; bytes: number }

function localStore(): Storage | null {
  try { return typeof window !== 'undefined' ? window.localStorage : null; } catch { return null; }
}

/** The plugin's stored keys (without the prefix) and their total size. */
export function pluginStoredData(pluginId: string, storage: Storage | null = localStore()): PluginStoredData {
  if (!storage) return { keys: [], bytes: 0 };
  const prefix = pluginStoragePrefix(pluginId);
  const keys: string[] = [];
  let bytes = 0;
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!key?.startsWith(prefix)) continue;
    keys.push(key.slice(prefix.length));
    bytes += (key.length + (storage.getItem(key)?.length ?? 0)) * 2;
  }
  return { keys: keys.sort(), bytes };
}

/** Removes every key of the plugin; returns how many were removed. */
export function clearPluginStoredData(pluginId: string, storage: Storage | null = localStore()): number {
  if (!storage) return 0;
  const prefix = pluginStoragePrefix(pluginId);
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter((key): key is string => Boolean(key?.startsWith(prefix)));
  for (const key of keys) storage.removeItem(key);
  return keys.length;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function PluginDataSection({ pluginId, name }: { pluginId: string; name: string }) {
  const { t } = useTranslation('plugin_manager');
  const workshop = usePluginManagerWorkshop();
  const [localData, setLocalData] = useState(() => pluginStoredData(pluginId));
  const [hostData, setHostData] = useState<{ readonly keys: readonly string[]; readonly bytes: number } | null>(null);
  const [clearing, setClearing] = useState(false);
  const [cleared, setCleared] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);
  // Two-step inline confirmation (no window.confirm): first click asks, second click clears.
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    setLocalData(pluginStoredData(pluginId));
    setHostData(null);
    setCleared(false);
    setClearError(null);
    setConfirming(false);
    if (!workshop?.storedData) return undefined;
    let cancelled = false;
    void workshop.storedData(pluginId)
      .then((next) => { if (!cancelled) setHostData(next); })
      .catch(() => { if (!cancelled) setHostData(null); });
    return () => { cancelled = true; };
  }, [pluginId, workshop]);

  const data = useMemo(() => ({
    keys: Array.from(new Set([...localData.keys, ...(hostData?.keys ?? [])])).sort(),
    bytes: localData.bytes + (hostData?.bytes ?? 0),
  }), [localData, hostData]);

  const clear = useCallback(() => {
    setConfirming(false);
    setClearError(null);
    clearPluginStoredData(pluginId);
    setLocalData(pluginStoredData(pluginId));
    if (!workshop?.clearStoredData) {
      setHostData(null);
      setCleared(true);
      return;
    }
    setClearing(true);
    void workshop.clearStoredData(pluginId)
      .then(async () => {
        setHostData(workshop.storedData ? await workshop.storedData(pluginId) : null);
        setCleared(true);
      })
      .catch((error) => {
        const raw = error instanceof Error ? error.message : String(error);
        setClearError(workshop.describeError ? workshop.describeError(raw) : raw);
      })
      .finally(() => { setClearing(false); });
  }, [pluginId, workshop]);

  return (
    <div className="space-y-2" data-testid="plugin-detail-data">
      {data.keys.length ? (
        <>
          <p className="text-sm text-foreground/80">{t('workshop.dataItems', { count: data.keys.length, size: formatSize(data.bytes) })}</p>
          <p className="min-w-0 break-all font-mono text-xs text-muted-foreground" data-testid="plugin-detail-data-keys">
            {data.keys.slice(0, 12).join(', ')}{data.keys.length > 12 ? ' …' : ''}
          </p>
          {confirming ? (
            <div className="flex flex-wrap items-center gap-2" data-testid="plugin-detail-data-confirm">
              <p className="text-xs text-foreground/80">{t('workshop.dataClearConfirm', { name })}</p>
              <DsButton variant="danger" size="sm" disabled={clearing} className="gap-1.5" data-testid="plugin-detail-data-clear-confirm" onClick={clear}>
                <Trash className="size-4" aria-hidden="true" />{t('workshop.dataClear')}
              </DsButton>
              <DsButton variant="default" size="sm" disabled={clearing} onClick={() => setConfirming(false)}>{t('common:cancel', { defaultValue: '取消' })}</DsButton>
            </div>
          ) : (
            <DsButton variant="outline" size="sm" disabled={clearing} className="gap-1.5 !text-destructive" data-testid="plugin-detail-data-clear" onClick={() => setConfirming(true)}>
              <Trash className="size-4" aria-hidden="true" />{t('workshop.dataClear')}
            </DsButton>
          )}
        </>
      ) : <p className="text-xs text-muted-foreground">{t(cleared ? 'workshop.dataCleared' : 'workshop.dataEmpty')}</p>}
      {clearError ? <p className="text-xs text-destructive" data-testid="plugin-detail-data-error">{clearError}</p> : null}
    </div>
  );
}
