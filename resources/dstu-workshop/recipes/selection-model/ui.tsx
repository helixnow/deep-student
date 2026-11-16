// Recipe (UI half): add a button to the notes editor's selection toolbar; clicking it asks the model (through the
// Host half) and shows the answer in a small card next to the selection, with a copy button.
//
// - `editor.selectionToolbar` is built once per editor instance: the button appears in editors opened after install.
// - Buttons are icon-only unless the item sets `showLabel: true`; then the host shows the label as text and sizes the
//   button for it. Never add CSS of your own to resize toolbar buttons. Keep the label short (「编成口诀」).
// - Read the selection from the DOM (window.getSelection()); editor internals are not part of the SDK.
// - Transient UI goes into createPluginOverlay(ctx): it is removed with the plugin and never blocks the editor.
// - The model call is asynchronous: show a waiting line, then the result or the error. Do not reportError() for
//   failures the user can retry (no model configured, network).
import React from 'react';
import { createPluginOverlay, defineUiPlugin, DsButton } from '@deepstudent/ui';

interface Request { text: string; left: number; right: number; bottom: number; seq: number }
type Ask = (text: string) => Promise<{ lines: string[] }>;

const WIDTH = 348;
// Icon only (an SVG string): with `showLabel` the host puts the label next to it and sizes both.
const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor"><path d="M112 40 136 112 208 136 136 160 112 232 88 160 16 136 88 112Z"/><path d="M200 16 211 45 240 56 211 67 200 96 189 67 160 56 189 45Z"/></svg>';

/** Host rejections arrive as plain objects ({ message }) or Errors. */
function failureText(error: unknown): string {
  const message = error instanceof Error ? error.message : (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' && message ? message.replace(/^[A-Z_]+:\s*/, '') : '没能编出口诀，请稍后再试';
}

function MnemonicCard({ request, ask, onClose }: { request: Request; ask: Ask; onClose: () => void }) {
  const [lines, setLines] = React.useState<string[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);
  const card = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    let active = true;
    setLines(null); setError(null); setCopied(false);
    ask(request.text).then(
      result => { if (active) setLines(result.lines); },
      reason => { if (active) setError(failureText(reason)); },
    );
    return () => { active = false; };
  }, [ask, request.seq, request.text]);

  // Close on a press outside the card or on Escape, without covering the editor.
  React.useEffect(() => {
    const onPointerDown = (event: PointerEvent) => { if (!card.current?.contains(event.target as Node)) onClose(); };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  const left = Math.max(16, Math.min(window.innerWidth - WIDTH - 16, (request.left + request.right) / 2 - WIDTH / 2));
  const top = Math.max(16, Math.min(window.innerHeight - 260, request.bottom + 12));
  return (
    <div ref={card} role="dialog" aria-label="编成口诀" style={{
      position: 'fixed', left, top, width: WIDTH, borderRadius: 12, border: '1px solid hsl(var(--border))',
      background: 'hsl(var(--popover))', color: 'hsl(var(--popover-foreground))', boxShadow: '0 18px 48px -12px hsl(var(--foreground) / 0.28)',
    }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px 4px' }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>编成口诀</h3>
        <span style={{ marginLeft: 'auto' }}><DsButton variant="ghost" size="sm" aria-label="关闭" onClick={onClose}>×</DsButton></span>
      </header>
      <p style={{ margin: '0 16px', paddingLeft: 8, borderLeft: '2px solid hsl(var(--border))', fontSize: 12, color: 'hsl(var(--muted-foreground))', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{request.text}</p>
      <div aria-live="polite" style={{ minHeight: 132, padding: '12px 16px 4px' }}>
        {error ? <p role="alert" style={{ margin: 0, fontSize: 14, color: 'hsl(var(--destructive))' }}>{error}</p>
          : lines ? lines.map((line, index) => <p key={index} style={{ margin: 0, fontSize: 18, fontWeight: 500, lineHeight: 1.9, letterSpacing: '0.08em' }}>{line}</p>)
            : <p style={{ margin: 0, fontSize: 14, color: 'hsl(var(--muted-foreground))' }}>正在编口诀…</p>}
      </div>
      <footer style={{ display: 'flex', justifyContent: 'flex-end', padding: '10px 16px', borderTop: '1px solid hsl(var(--border) / 0.5)' }}>
        <DsButton variant="outline" size="sm" disabled={!lines} onClick={() => {
          void navigator.clipboard?.writeText((lines ?? []).join('\n')).then(() => setCopied(true), () => setError('复制失败，请手动选择文字复制'));
        }}>{copied ? '已复制' : '复制'}</DsButton>
      </footer>
    </div>
  );
}

export default defineUiPlugin({
  meta: { id: '__PLUGIN_ID__', version: '1.0.0', host: true },
  apply(ctx) {
    const overlay = createPluginOverlay(ctx);
    const ask: Ask = text => ctx.ui.host.__SERVICE__!.mnemonic!(text) as Promise<{ lines: string[] }>;
    const close = () => overlay.render(null);
    let seq = 0;

    ctx.ui.contribute('editor.selectionToolbar', {
      id: '__PLUGIN_ID__/mnemonic',
      order: 30, // after the built-in groups
      value: {
        build(toolbar) {
          toolbar.addGroup('workshop-mnemonic', '口诀').addItem('mnemonic', {
            label: '编成口诀',
            icon: ICON,
            showLabel: true, // labelled button: icon + 「编成口诀」 as text
            onRun: () => {
              const selection = window.getSelection();
              const text = selection?.toString().replace(/\s+/g, ' ').trim() ?? '';
              if (!selection || selection.rangeCount === 0 || !text) return;
              const rect = selection.getRangeAt(0).getBoundingClientRect();
              overlay.render(<MnemonicCard request={{ text, left: rect.left, right: rect.right, bottom: rect.bottom, seq: ++seq }} ask={ask} onClose={close} />);
            },
          });
        },
      },
    });
  },
});
