import { abortStagedUpload, stageBlobUpload } from '@/utils/stagedUpload';
import i18n from '@/i18n';

// The Host bounds parsing and relinking at the same limit.
const MAX_MOBILE_TEXTBOOK_BYTES = 50 * 1024 * 1024;
const ATTACHMENT_ONLY_DOCUMENTS = new Set(['xlsx', 'xls', 'xlsb', 'ods', 'pptx', 'rtf']);

/** These files use the existing attachment path and its format-specific preview. */
export const canParseAsMobileTextbook = (extension: string) => !ATTACHMENT_ONLY_DOCUMENTS.has(extension);

export async function withStagedTextbookFile<T>(file: File, run: (source: string) => Promise<T>): Promise<T> {
  if (file.size > MAX_MOBILE_TEXTBOOK_BYTES) {
    throw new Error(i18n.t('learningHub:textbook.mobileImportTooLarge', {
      defaultValue: 'This file exceeds the 50 MB limit on Android.',
    }));
  }
  const uploadId = await stageBlobUpload(file, { name: file.name });
  try {
    return await run('dstu-staged:' + uploadId);
  } finally {
    // Committers consume the handle; also release it if the command could not start.
    await abortStagedUpload(uploadId);
  }
}
