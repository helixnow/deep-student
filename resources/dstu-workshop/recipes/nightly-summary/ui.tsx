// Recipe (UI half): the view the evening notification opens. It shows the last summary and a button to write one now.
//
// - Register the view with the id the Host half passes to pluginNotify ('summary'); a nav item makes it reachable.
// - Remote calls are asynchronous: show a waiting line, then the result or the error. Do not reportError() for
//   failures the user can retry (no model configured, no notes today).
import React from 'react';
import { defineUiPlugin, DsButton, DsCard } from '@deepstudent/ui';

interface Summary { noteId: string; title: string; text: string; notes: number; at: string }

function failureText(error: unknown): string {
  const message = error instanceof Error ? error.message : (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' && message ? message.replace(/^[A-Z_]+:\s*/, '') : '没能写出总结，请稍后再试';
}

function SummaryView({ latest, runNow }: { latest: () => Promise<Summary | null>; runNow: () => Promise<Summary | null> }) {
  const [summary, setSummary] = React.useState<Summary | null>(null);
  const [status, setStatus] = React.useState<'idle' | 'running' | 'empty'>('idle');
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;
    latest().then(value => { if (active) setSummary(value); }, reason => { if (active) setError(failureText(reason)); });
    return () => { active = false; };
  }, [latest]);

  const run = () => {
    setStatus('running'); setError(null);
    runNow().then(
      value => { setSummary(value ?? summary); setStatus(value ? 'idle' : 'empty'); },
      reason => { setError(failureText(reason)); setStatus('idle'); },
    );
  };

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 24, maxWidth: 720 }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>每晚学习总结</h2>
        <span style={{ marginLeft: 'auto' }}>
          <DsButton size="sm" disabled={status === 'running'} onClick={run}>{status === 'running' ? '正在总结…' : '现在总结今天'}</DsButton>
        </span>
      </header>
      <p style={{ margin: 0, fontSize: 13, color: 'hsl(var(--muted-foreground))' }}>每天 22:00 自动整理当天改过的笔记，写成一篇「学习总结」笔记并提醒你。</p>
      {error && <p role="alert" style={{ margin: 0, color: 'hsl(var(--destructive))' }}>{error}</p>}
      {status === 'empty' && <p style={{ margin: 0 }}>今天还没有写或改过笔记。</p>}
      {summary && (
        <DsCard>
          <div style={{ padding: 16 }}>
            <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>{summary.title}（{summary.notes} 篇笔记）</h3>
            <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.7 }}>{summary.text}</div>
          </div>
        </DsCard>
      )}
    </section>
  );
}

export default defineUiPlugin({
  meta: { id: '__PLUGIN_ID__', version: '1.0.0', host: true },
  apply(ctx) {
    ctx.ui.i18n.addBundles({ 'zh-CN': { title: '学习总结' }, 'en-US': { title: 'Study summary' } });
    const latest = () => ctx.ui.host.__SERVICE__!.latest!() as Promise<Summary | null>;
    const runNow = () => ctx.ui.host.__SERVICE__!.runNow!() as Promise<Summary | null>;
    ctx.ui.views.register({ id: 'summary', titleKey: 'title', component: () => <SummaryView latest={latest} runNow={runNow} /> });
    ctx.ui.nav.register({ id: 'summary', viewId: 'summary', labelKey: 'title', order: 100 });
  },
});
