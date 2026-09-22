import { editorViewCtx } from '@milkdown/kit/core';
import type { SelectionBookmark } from '@milkdown/prose/state';
import { assertFullDocumentBaseline, type FullDocumentSearchApi, type FullDocumentSnapshot } from './fullDocument';
import { resolveNoteMarkdownRange } from './noteReviewHost';
import type { NoteTemplateDocumentHost } from './noteTemplates';

export interface TemplateInsertionBookmark {
  bookmark: SelectionBookmark;
  baseline: FullDocumentSnapshot;
  range: { from: number; to: number };
}
export function captureTemplateInsertion(api: FullDocumentSearchApi): TemplateInsertionBookmark {
  const crepe = api.getCrepe();
  if (!crepe) throw new Error('请先在编辑器中选择插入位置。');
  const bookmark = crepe.editor.action(ctx => ctx.get(editorViewCtx).state.selection.getBookmark());
  const selection = crepe.editor.action(ctx => bookmark.resolve(ctx.get(editorViewCtx).state.doc));
  const { baseline, from, to } = resolveNoteMarkdownRange(api, { from: selection.from, to: selection.to });
  return { bookmark, baseline, range: { from, to } };
}
export function templateDocumentHost(api: FullDocumentSearchApi, insertion: () => TemplateInsertionBookmark | null,
  variables: NoteTemplateDocumentHost['variables']): NoteTemplateDocumentHost {
  return {
    getDocument: () => api.getFullDocument(),
    replaceDocument: (markdown, baseline) => api.replaceFullDocument(markdown, baseline),
    getInsertionPoint: () => {
      const captured = insertion();
      if (!captured) throw new Error('请在编辑器中选择位置，再重新打开模板面板。');
      assertFullDocumentBaseline(api.getFullDocument(), captured.baseline);
      return { ...captured.range };
    },
    insertDocument: async (markdown, baseline, position) => {
      const captured = insertion();
      if (!captured) throw new Error('插入位置已失效，请重新打开模板面板。');
      assertFullDocumentBaseline(baseline, captured.baseline);
      assertFullDocumentBaseline(api.getFullDocument(), baseline);
      if (position.from !== captured.range.from || position.to !== captured.range.to) throw new Error('插入位置已改变。');
      return api.replaceFullDocument(baseline.markdown.slice(0, position.from) + markdown + baseline.markdown.slice(position.to), baseline);
    },
    variables,
  };
}
