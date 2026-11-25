import type { TFunction } from 'i18next';
import {
  ATTACHMENT_ALLOWED_EXTENSIONS,
  ATTACHMENT_ALLOWED_TYPES,
} from '../../core/constants';
import type { AttachmentMeta } from '../../core/types/common';

const ANKI_DECK_EXTENSIONS = new Set(['apkg', 'colpkg']);

export interface UnsupportedChatAttachmentClassification {
  kind: 'anki_deck' | 'unsupported_type';
  ext: string;
}

export function extractChatAttachmentExtension(fileName: string): string {
  const idx = fileName.lastIndexOf('.');
  if (idx <= 0 || idx === fileName.length - 1) return '';
  return fileName.slice(idx + 1).trim().toLowerCase();
}

export function isUnsupportedFileTypeError(errorDetail: string): boolean {
  return errorDetail.includes('UNSUPPORTED_FILE_TYPE');
}

export function classifyUnsupportedChatAttachment(
  fileName: string,
  fileMime: string,
): UnsupportedChatAttachmentClassification | null {
  const ext = extractChatAttachmentExtension(fileName);
  if (ANKI_DECK_EXTENSIONS.has(ext)) {
    return { kind: 'anki_deck', ext };
  }

  const normalizedMime = fileMime.trim().toLowerCase();
  const isAllowed =
    (normalizedMime.length > 0 && ATTACHMENT_ALLOWED_TYPES.includes(normalizedMime))
    || (ext.length > 0 && ATTACHMENT_ALLOWED_EXTENSIONS.includes(ext));

  if (!isAllowed) {
    return { kind: 'unsupported_type', ext };
  }

  return null;
}

export function formatUnsupportedChatAttachmentMessage(
  params: {
    fileName: string;
    fileMime?: string;
    kind?: 'anki_deck' | 'unsupported_type';
  },
  t: TFunction,
): string {
  const ext = extractChatAttachmentExtension(params.fileName);
  if (params.kind === 'anki_deck' || ANKI_DECK_EXTENSIONS.has(ext)) {
    const extDisplay = ext ? `.${ext}` : '.apkg';
    return t('chatV2:input.unsupportedAnkiDeck', { ext: extDisplay });
  }

  const extDisplay = ext
    ? `.${ext}`
    : (params.fileMime?.trim() || params.fileName);
  return t('chatV2:input.unsupportedFileType', {
    name: params.fileName,
    ext: extDisplay,
  });
}

export function filterPersistableDraftAttachments<T extends Pick<AttachmentMeta, 'status'>>(
  attachments: readonly T[] | undefined,
): T[] {
  if (!attachments || attachments.length === 0) return [];
  return attachments.filter((att) => att.status !== 'error');
}
