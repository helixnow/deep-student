import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export const PDF_ANNOTATIONS_CHANGED_EVENT = 'pdf-annotations:changed';

export interface PdfAnnotationsChangedPayload {
  textbook_id?: string;
  resource_path?: string;
  kind?: 'bookmarks' | 'highlights' | string;
  action?: string;
  updated_at?: string;
}

export type PdfAnnotationSaveBaseline<T> =
  | { status: 'save'; expectedRevision: string }
  | { status: 'reload'; revision: string; highlights: T[] }
  | { status: 'missing_revision' };

/**
 * Distinguish an annotation conflict from an unrelated textbook update.
 * Reading progress/bookmark changes share files.updated_at; they may advance
 * the revision without changing the last committed highlight array.
 */
export function resolvePdfAnnotationSaveBaseline<T>(
  knownRevision: string | null,
  lastCommittedHighlights: string,
  serverRevision: unknown,
  serverHighlights: unknown,
): PdfAnnotationSaveBaseline<T> {
  if (
    !knownRevision ||
    typeof serverRevision !== 'string' ||
    !serverRevision.trim() ||
    !Array.isArray(serverHighlights)
  ) {
    return { status: 'missing_revision' };
  }
  if (serverRevision === knownRevision) {
    return { status: 'save', expectedRevision: knownRevision };
  }
  if (JSON.stringify(serverHighlights) === lastCommittedHighlights) {
    return { status: 'save', expectedRevision: serverRevision };
  }
  return {
    status: 'reload',
    revision: serverRevision,
    highlights: serverHighlights as T[],
  };
}

export function matchesPdfAnnotationResource(
  resourcePath: string,
  payload: PdfAnnotationsChangedPayload,
): boolean {
  if (payload.resource_path === resourcePath) return true;
  const textbookId = resourcePath.split('/').filter(Boolean).at(-1);
  return Boolean(textbookId && payload.textbook_id === textbookId);
}

export async function subscribePdfAnnotationChanges(
  resourcePath: string,
  onChange: (payload: PdfAnnotationsChangedPayload) => void | Promise<void>,
): Promise<UnlistenFn> {
  return listen<PdfAnnotationsChangedPayload>(PDF_ANNOTATIONS_CHANGED_EVENT, (event) => {
    if (!matchesPdfAnnotationResource(resourcePath, event.payload)) return;
    void onChange(event.payload);
  });
}
