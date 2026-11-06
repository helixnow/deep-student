export const INK_MIME = 'application/vnd.deepstudent.ink+json' as const;
export const INK_EXTENSION = 'dsink' as const;

export function isInkFile(mimeType: string | undefined, fileName: string | undefined): boolean {
  const mimeEssence = (mimeType ?? '').toLowerCase().split(';', 1)[0]?.trim();
  const extension = fileName?.split('.').pop()?.toLowerCase();
  return mimeEssence === INK_MIME || extension === INK_EXTENSION;
}
