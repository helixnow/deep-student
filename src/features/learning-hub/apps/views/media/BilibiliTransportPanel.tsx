import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Browser, Check, Link, PlugsConnected, X } from '@phosphor-icons/react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { DsButton } from '@/components/ui/DsButton';
import { Input } from '@/components/ui/shad/Input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/shad/Select';
import { Checkbox } from '@/components/ui/shad/Checkbox';
import { getErrorMessage } from '@/utils/errorUtils';
import { bilibiliTransportApi, refreshBilibiliTransport, useBilibiliTransport, type BilibiliRouteMode } from './bilibiliTransport';

export function BilibiliTransportPanel() {
  const { t } = useTranslation('learningHub');
  const status = useBilibiliTransport();
  const [proxy, setProxy] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pairing, setPairing] = useState<{ url: string; scriptUrl: string } | null>(null);
  const configuredProxy = status?.settings.proxyUrl;
  useEffect(() => { if (configuredProxy !== undefined) setProxy(configuredProxy ?? ''); }, [configuredProxy]);
  const action = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await fn(); await refreshBilibiliTransport(); }
    catch (cause) { setError(getErrorMessage(cause)); }
    finally { setBusy(false); }
  };
  if (!status) return null;
  const bridge = status.bridge;
  const label = (name: string) => t(`mediaBilibili.transport.${name}`);
  return <section className="min-w-0 space-y-2 border-b border-border pb-3 text-xs" data-bilibili-transport="">
    <div className="flex flex-wrap items-center gap-2">
      <PlugsConnected size={16} aria-hidden="true" />
      <span className="font-medium">{label('title')}</span>
      <Select value={status.settings.mode} disabled={busy} onValueChange={(value) => void action(() => bilibiliTransportApi.configure({ ...status.settings, mode: value as BilibiliRouteMode }))}>
        <SelectTrigger className="h-8 w-36 text-xs" aria-label={label('mode')}><SelectValue /></SelectTrigger>
        <SelectContent>{(['auto', 'browser_bridge', 'native', 'proxy'] as const).map((mode) => <SelectItem key={mode} value={mode}>{label(mode)}</SelectItem>)}</SelectContent>
      </Select>
      <span className="min-w-0 text-muted-foreground" role="status">{label(`state.${bridge.state}`)}</span>
    </div>
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-muted-foreground">{label('browserAccount')}</span>
      <span className="min-w-0 break-words">{bridge.account?.loggedIn ? bridge.account.uname || String(bridge.account.mid ?? '') : label('anonymous')}</span>
      {bridge.parsing && <span>{label(bridge.media ? 'fullCapability' : 'parsingOnly')}</span>}
      {bridge.scriptVersion && <span className="text-muted-foreground">v{bridge.scriptVersion}</span>}
      {bridge.connectionId ? <DsButton variant="ghost" size="sm" disabled={busy} onClick={() => void action(async () => { await bilibiliTransportApi.disconnect(); setPairing(null); })}><X size={14} aria-hidden="true" />{label('disconnect')}</DsButton>
        : <DsButton variant="ghost" size="sm" disabled={busy} onClick={() => void action(async () => { const next = await bilibiliTransportApi.pair(); setPairing(next); await openUrl(next.url); })}><Browser size={14} aria-hidden="true" />{label('connect')}</DsButton>}
    </div>
    {bridge.state === 'awaiting_approval' && bridge.connectionId && <DsButton variant="primary" size="sm" disabled={busy} onClick={() => void action(() => bilibiliTransportApi.approve(bridge.connectionId!))}><Check size={14} aria-hidden="true" />{label('approve')}</DsButton>}
    {pairing && bridge.state === 'pairing' && <div className="flex flex-wrap gap-2">
      <DsButton variant="ghost" size="sm" onClick={() => void action(() => openUrl(pairing.scriptUrl))}><Link size={14} aria-hidden="true" />{label('installScript')}</DsButton>
      <DsButton variant="ghost" size="sm" onClick={() => void action(() => openUrl(pairing.url))}><Browser size={14} aria-hidden="true" />{label('pairPage')}</DsButton>
    </div>}
    <details className="space-y-2" open={status.settings.mode === 'proxy' || undefined}><summary className="cursor-pointer text-muted-foreground">{label('proxyAddress')}</summary><div className="space-y-2">
      <div className="flex gap-2"><Input value={proxy} onChange={(event) => setProxy(event.target.value)} className="h-8 min-w-0 flex-1 text-xs" aria-label={label('proxyAddress')} placeholder="http://127.0.0.1:7890" />
        <DsButton size="sm" disabled={busy || !proxy.trim()} onClick={() => void action(() => bilibiliTransportApi.configure({ ...status.settings, proxyUrl: proxy.trim() }))}>{label('save')}</DsButton></div>
      <label className="flex items-center gap-2"><Checkbox checked={status.settings.proxyInAuto} disabled={busy} onCheckedChange={(value) => void action(() => bilibiliTransportApi.configure({ ...status.settings, proxyInAuto: value === true }))} />{label('proxyInAuto')}</label>
    </div></details>
    {!!status.diagnostics?.length && <details><summary className="cursor-pointer text-muted-foreground">{label('diagnostics')}</summary><ul className="max-h-36 overflow-auto py-2 font-mono text-2xs">{status.diagnostics.slice(-8).reverse().map((item) => <li key={item.requestId} className="break-all py-0.5">#{item.requestId} {item.route} {item.stage} {item.host} {item.status ?? item.errorCode} {item.elapsedMs}ms {item.bytes}B</li>)}</ul></details>}
    {(error || bridge.lastError) && <p role="alert" className="break-words text-destructive">{error ?? `${bridge.lastError!.message} (${bridge.lastError!.code})`}</p>}
  </section>;
}
