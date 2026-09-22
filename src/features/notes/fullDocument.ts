import type { CrepeEditorApi } from '@/components/crepe';
import i18n from '@/i18n';
import type { FullDocumentApi, FullDocumentSnapshot } from '@/components/crepe/types';
import { editorViewCtx, parserCtx, serializerCtx } from '@milkdown/kit/core';
import { closeHistory } from '@milkdown/prose/history';
import type { Transaction } from '@milkdown/prose/state';
export type { FullDocumentApi, FullDocumentSnapshot } from '@/components/crepe/types';

/** Independent extension: hosts can adopt this without changing Crepe's base API. */
export type FullDocumentSearchApi = FullDocumentApi & {
  materializeFullDocument: (signal?: AbortSignal) => Promise<FullDocumentSnapshot>;
  applyFullDocumentTransaction: (transaction: Transaction, baseline: FullDocumentSnapshot) => Promise<FullDocumentSnapshot>;
};
export type FullDocumentViewHost = CrepeEditorApi & {
  /** Switch the save composer to the complete view, without writing storage. */
  acceptFullDocumentView?: (markdown: string) => void;
  /** Install the authoritative storage head and its OCC token, or reject. */
  refreshDocumentFromDisk?: () => Promise<void>;
};

/** Append/materialize through a minimal non-history transaction; preserve prefix Undo and selection. */
export function materializeMarkdownView(api: CrepeEditorApi, markdown: string): string {
  const crepe = api.getCrepe();
  if (!crepe) throw new Error(i18n.t('notes:fullDocument.errors.view_unavailable', { defaultValue: '全文编辑器尚未就绪，请重试。' }));
  return crepe.editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const parsed = ctx.get(parserCtx)(markdown);
    if (!parsed) throw new Error(i18n.t('notes:fullDocument.errors.materialize_failed', { defaultValue: '无法加载完整笔记，请重试。' }));
    const start = view.state.doc.content.findDiffStart(parsed.content);
    if (start !== null) {
      const end = view.state.doc.content.findDiffEnd(parsed.content)!;
      const overlap = start - Math.min(end.a, end.b);
      const a = end.a + Math.max(0, overlap);
      const b = end.b + Math.max(0, overlap);
      view.dispatch(view.state.tr.replace(start, a, parsed.slice(start, b)).setMeta('addToHistory', false));
    }
    return ctx.get(serializerCtx)(view.state.doc);
  });
}

export const MAX_NOTE_CONTENT_BYTES = 1024 * 1024;
export const noteContentBytes = (markdown: string): number => new TextEncoder().encode(markdown).byteLength;

export type RetainedNoteDraft = { markdown: string; error: string; previousMarkdown?: string };
const recoveryByWindow = new Map<string, Map<string, RetainedNoteDraft>>();
/** Keep failed drafts through view unmounts for the lifetime of this app process. */
export function fullDocumentRecoveryStore(windowId = 'notes'): Map<string, RetainedNoteDraft> {
  let store = recoveryByWindow.get(windowId);
  if (!store) { store = new Map(); recoveryByWindow.set(windowId, store); }
  return store;
}

export function assertFullDocumentBaseline(current: FullDocumentSnapshot, baseline: FullDocumentSnapshot): void {
  if (current.noteId !== baseline.noteId || current.revision !== baseline.revision || current.markdown !== baseline.markdown) {
    throw new Error(i18n.t('notes:fullDocument.errors.baseline_changed'));
  }
}

export function assertNoteContentSize(markdown: string): void {
  if (noteContentBytes(markdown) > MAX_NOTE_CONTENT_BYTES) {
    const error = new Error(i18n.t('notes:fullDocument.errors.content_too_large'));
    Object.assign(error, { isNonRetryable: true });
    throw error;
  }
}

/** The parser applied this exact revision, but persistence failed. Safe to retry only unchanged. */
export class FullDocumentSaveError extends Error {
  constructor(error: unknown, readonly appliedDocument: FullDocumentSnapshot) {
    super(error instanceof Error ? error.message : String(error), { cause: error });
    this.name = 'FullDocumentSaveError';
  }
}

/** Wrap AFTER the owning view's extension: its window composer and storage OCC remain authoritative. */
export function createFullDocumentApi(
  api: CrepeEditorApi,
  host: {
    noteId: string;
    isCurrent: () => boolean;
    revision: () => number;
    isWindowed: () => boolean;
    retainFailure: (markdown: string, error: unknown, previousMarkdown: string) => void;
    projectView?: (apply: () => string) => void;
  },
): FullDocumentSearchApi {
  const assertCurrent = () => {
    if (!host.isCurrent()) throw new Error(i18n.t('notes:fullDocument.errors.stale_editor'));
  };
  const getFullMarkdown = () => {
    assertCurrent();
    if (!api.getFullMarkdown && host.isWindowed()) {
      throw new Error(i18n.t('notes:fullDocument.errors.read_unavailable'));
    }
    return api.getFullMarkdown?.() ?? api.getMarkdown();
  };
  const getFullDocument = (): FullDocumentSnapshot => ({
    noteId: host.noteId, revision: host.revision(), markdown: getFullMarkdown(),
  });
  const replaceFullDocument = async (markdown: string, baseline: FullDocumentSnapshot) => {
    let appliedDocument: FullDocumentSnapshot | undefined;
    try {
      assertCurrent();
      assertFullDocumentBaseline(getFullDocument(), baseline);
      assertNoteContentSize(markdown);
      if (api.isReadonly()) throw new Error(i18n.t('notes:fullDocument.errors.read_only'));
      const canonical = api.normalizeMarkdown?.(markdown) ?? markdown;
      assertNoteContentSize(canonical);
      if (api.replaceFullMarkdown) {
        // The host applies synchronously before awaiting its save queue. Capture that
        // revision now, so edits made during persistence cannot become the returned baseline.
        const pending = api.replaceFullMarkdown(canonical, { expectedMarkdown: baseline.markdown, baseline });
        const snapshot = getFullDocument();
        if (snapshot.markdown === canonical) appliedDocument = snapshot;
        const applied = await pending;
        assertCurrent();
        if (!applied) throw new Error(i18n.t('notes:fullDocument.errors.not_applied'));
      } else {
        if (host.isWindowed()) throw new Error(i18n.t('notes:fullDocument.errors.write_unavailable'));
        if (!api.flushPendingSave) throw new Error(i18n.t('notes:fullDocument.errors.save_unavailable'));
        try {
          if (!api.setMarkdown(canonical) || api.getMarkdown() !== canonical) throw new Error(i18n.t('notes:fullDocument.errors.not_applied'));
        } catch (error) {
          assertCurrent();
          api.setMarkdown(baseline.markdown);
          throw error;
        }
        appliedDocument = getFullDocument();
        await api.flushPendingSave();
        assertCurrent();
      }
      if (!appliedDocument) throw new Error(i18n.t('notes:fullDocument.errors.not_applied'));
      assertFullDocumentBaseline(getFullDocument(), appliedDocument);
      return appliedDocument;
    } catch (error) {
      // Retain both the candidate and the live pre-operation draft. The host restores
      // its live window on parser rejection; storage failures leave recovery to the user.
      host.retainFailure(markdown, error, baseline.markdown);
      if (appliedDocument) {
        try {
          assertFullDocumentBaseline(getFullDocument(), appliedDocument);
        } catch { throw error; }
        throw new FullDocumentSaveError(error, appliedDocument);
      }
      throw error;
    }
  };
  const materializeFullDocument = async (signal?: AbortSignal) => {
    // Yield so loading/cancel can paint before the parser and DOM work starts.
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) { reject(new DOMException('Search cancelled', 'AbortError')); return; }
      const abort = () => { clearTimeout(timer); reject(new DOMException('Search cancelled', 'AbortError')); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, 0);
      signal?.addEventListener('abort', abort, { once: true });
    });
    assertCurrent();
    if (signal?.aborted) throw new DOMException('Search cancelled', 'AbortError');
    if (api.isDocumentWindowed?.() ?? host.isWindowed()) {
      const viewHost = api as FullDocumentViewHost;
      if (!viewHost.acceptFullDocumentView || !host.projectView) throw new Error('full_document_unavailable');
      const markdown = getFullMarkdown();
      host.projectView(() => {
        const canonical = materializeMarkdownView(api, markdown);
        viewHost.acceptFullDocumentView!(canonical);
        return canonical;
      });
    }
    return getFullDocument();
  };
  const applyFullDocumentTransaction = async (transaction: Transaction, baseline: FullDocumentSnapshot) => {
    assertCurrent();
    assertFullDocumentBaseline(getFullDocument(), baseline);
    if (api.isReadonly()) throw new Error(i18n.t('notes:fullDocument.errors.read_only'));
    if (api.isDocumentWindowed?.() ?? host.isWindowed()) throw new Error('full_document_unavailable');
    const crepe = api.getCrepe();
    if (!crepe || !api.flushPendingSave) throw new Error('full_document_unavailable');
    const candidate = crepe.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      if (!transaction.before.eq(view.state.doc)) throw new Error(i18n.t('notes:fullDocument.errors.baseline_changed'));
      const markdown = ctx.get(serializerCtx)(transaction.doc);
      assertNoteContentSize(markdown);
      // Separate each replace from prior typing AND from the next replace/typing.
      view.dispatch(closeHistory(transaction).setMeta('addToHistory', true));
      view.dispatch(closeHistory(view.state.tr));
      return markdown;
    });
    const applied = getFullDocument();
    try { await api.flushPendingSave(); }
    catch (error) {
      host.retainFailure(candidate, error, baseline.markdown);
      throw new FullDocumentSaveError(error, applied);
    }
    assertCurrent();
    return applied;
  };
  return {
    ...api, getFullMarkdown, getFullDocument, replaceFullDocument, materializeFullDocument, applyFullDocumentTransaction,
    isDocumentWindowed: () => api.isDocumentWindowed?.() ?? host.isWindowed(),
    replaceFullMarkdown: (markdown, options) => {
      const baseline = getFullDocument();
      return replaceFullDocument(markdown, { ...(options.baseline ?? baseline), markdown: options.expectedMarkdown }).then(() => true);
    },
  };
}
