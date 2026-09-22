import React, { useEffect, useState } from 'react';
import { readNoteFormat, supportsNoteFormat } from './noteEditorHost';
import { NotesAPI } from '@/utils/notesApi';
import { copyTextToClipboard } from '@/utils/clipboardUtils';
import { fileManager } from '@/utils/fileManager';
import { DsButton } from '@/components/ui/DsButton';

/** No editor or save lifecycle is mounted until storage confirms its format. */
export function NoteFormatGate({ noteId, children }: { noteId?: string; children: React.ReactNode }) {
  const [state, setState] = useState<{ noteId: string; supported: boolean; raw?: string; title?: string; error?: string }>();
  const [attempt, retry] = useState(0);
  const [actionError, setActionError] = useState('');
  useEffect(() => {
    let active = true;
    if (!noteId) return;
    setState(undefined);
    setActionError('');
    void (async () => {
      try {
        const format = await readNoteFormat(noteId);
        if (!active) return;
        if (supportsNoteFormat(format)) { setState({ noteId, supported: true }); return; }
        const stored = await NotesAPI.historyCurrent(noteId);
        if (active) setState({ noteId, supported: false, raw: stored.content_md, title: stored.title });
      } catch (error) {
        if (active) setState({ noteId, supported: false, error: error instanceof Error ? error.message : String(error) });
      }
    })();
    return () => { active = false; };
  }, [noteId, attempt]);
  if (!noteId) return <>{children}</>;
  if (state?.noteId !== noteId) return <p role="status">正在确认笔记格式…</p>;
  if (state.supported) return <>{children}</>;
  const run = async (task: () => Promise<unknown>) => {
    try { setActionError(''); await task(); } catch (error) { setActionError(String(error)); }
  };
  return <section className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-5" aria-label="笔记原文只读视图">
    <p role="alert">{state.error ?? '此笔记使用尚不支持的格式，已显示完整原文。请使用兼容版本编辑。'}</p>
    {state.raw !== undefined && <>
      <div className="flex gap-2">
        <DsButton onClick={() => void run(async () => { if (!await copyTextToClipboard(state.raw!)) throw new Error('复制失败，请重试。'); })}>复制完整原文</DsButton>
        <DsButton onClick={() => void run(() => fileManager.saveTextFile({ content: state.raw!, title: '导出笔记原文',
          defaultFileName: `${state.title || noteId}.md`, filters: [{ name: 'Markdown', extensions: ['md'] }] }))}>导出原文</DsButton>
      </div>
      <pre aria-label="完整笔记原文" className="whitespace-pre-wrap break-words font-mono text-sm">{state.raw}</pre>
    </>}
    {actionError && <p role="alert">{actionError}</p>}
    <DsButton variant="outline" onClick={() => retry(value => value + 1)}>重新检查格式</DsButton>
  </section>;
}
