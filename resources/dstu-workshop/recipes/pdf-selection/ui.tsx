// Recipe (UI half): a button in the PDF reader's selection toolbar. Clicking it asks the Host half to explain the
// selected passage and shows the answer in a small card, with a button that saves it as a note.
//
// - `pdf.selectionToolbar` entries get the selection at click time: { text, page?, resourceId?, documentTitle?, kind }.
//   `kinds: ['pdf']` keeps the button off the EPUB / document readers (omit it to show it everywhere).
// - `icon` is a component ({ size }) rendered by the toolbar; without it the label is shown as text.
// - Transient UI goes into createPluginOverlay(ctx): removed with the plugin, never blocks the reader.
import React from 'react';
import { createPluginOverlay, defineUiPlugin, DsButton, type PdfSelectionContext } from '@deepstudent/ui';

type Explain = (passage: PdfSelectionContext) => Promise<{ text: string }>;
type Save = (passage: PdfSelectionContext, explanation: string) => Promise<{ noteId: string }>;

const WIDTH = 380;

function failureText(error: unknown): string {
  const message = error instanceof Error ? error.message : (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' && message ? message.replace(/^[A-Z_]+:\s*/, '') : '没能讲解这段，请稍后再试';
}

function BulbIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
      <path d="M176 232a8 8 0 0 1-8 8H88a8 8 0 0 1 0-16h80a8 8 0 0 1 8 8Zm40-128a87.6 87.6 0 0 1-33.6 69.2A16.2 16.2 0 0 0 176 186v6a16 16 0 0 1-16 16H96a16 16 0 0 1-16-16v-6a16 16 0 0 0-6.2-12.6A88 88 0 1 1 216 104Z" />
    </svg>
  );
}

function ExplainCard({ passage, explain, save, onClose }: { passage: PdfSelectionContext; explain: Explain; save: Save; onClose: () => void }) {
  const [text, setText] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);

  React.useEffect(() => {
    let active = true;
    explain(passage).then(result => { if (active) setText(result.text); }, reason => { if (active) setError(failureText(reason)); });
    return () => { active = false; };
  }, [explain, passage]);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div role="dialog" aria-label="讲解这段" style={{
      position: 'fixed', right: 24, bottom: 24, width: WIDTH, maxHeight: '60vh', overflow: 'auto', borderRadius: 12,
      border: '1px solid hsl(var(--border))', background: 'hsl(var(--popover))', color: 'hsl(var(--popover-foreground))',
      boxShadow: '0 18px 48px -12px hsl(var(--foreground) / 0.28)', padding: 16,
    }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>讲解{passage.page ? `（第 ${passage.page} 页）` : ''}</h3>
        <span style={{ marginLeft: 'auto' }}><DsButton variant="ghost" size="sm" aria-label="关闭" onClick={onClose}>×</DsButton></span>
      </header>
      <p style={{ margin: '8px 0', paddingLeft: 8, borderLeft: '2px solid hsl(var(--border))', fontSize: 12, color: 'hsl(var(--muted-foreground))' }}>{passage.text.slice(0, 160)}</p>
      <div aria-live="polite" style={{ fontSize: 14, lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>
        {error ? <span role="alert" style={{ color: 'hsl(var(--destructive))' }}>{error}</span> : text ?? '正在讲解…'}
      </div>
      <footer style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
        <DsButton variant="outline" size="sm" disabled={!text || saved} onClick={() => {
          save(passage, text ?? '').then(() => setSaved(true), reason => setError(failureText(reason)));
        }}>{saved ? '已存成笔记' : '存成笔记'}</DsButton>
      </footer>
    </div>
  );
}

export default defineUiPlugin({
  meta: { id: '__PLUGIN_ID__', version: '1.0.0', host: true },
  apply(ctx) {
    const overlay = createPluginOverlay(ctx);
    const explain: Explain = passage => ctx.ui.host.__SERVICE__!.explain!(passage) as Promise<{ text: string }>;
    const save: Save = (passage, explanation) => ctx.ui.host.__SERVICE__!.save!(passage, explanation) as Promise<{ noteId: string }>;
    const close = () => overlay.render(null);

    ctx.ui.contribute('pdf.selectionToolbar', {
      id: '__PLUGIN_ID__/explain',
      value: {
        label: '讲解这段',
        icon: BulbIcon,
        kinds: ['pdf'],
        run(selection) {
          // Pass only plain JSON to the Host half.
          const passage: PdfSelectionContext = { ...selection };
          overlay.render(<ExplainCard key={Date.now()} passage={passage} explain={explain} save={save} onClose={close} />);
        },
      },
    });
  },
});
