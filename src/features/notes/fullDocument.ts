import type { CrepeEditorApi } from '@/components/crepe';
import i18n from '@/i18n';
import type { FullDocumentApi, FullDocumentSnapshot } from '@/components/crepe/types';
export type { FullDocumentApi, FullDocumentSnapshot } from '@/components/crepe/types';

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
  },
): FullDocumentApi {
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
  return {
    ...api, getFullMarkdown, getFullDocument, replaceFullDocument,
    replaceFullMarkdown: (markdown, options) => {
      const baseline = getFullDocument();
      return replaceFullDocument(markdown, { ...(options.baseline ?? baseline), markdown: options.expectedMarkdown }).then(() => true);
    },
  };
}
