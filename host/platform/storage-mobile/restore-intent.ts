/** OPFS path shared by the mobile shell, worker preflight and backup service. */
export const MOBILE_APP_DATA_DIR = '/deep-student';
export const MOBILE_RESTORE_INTENT_FILE = 'pending-mobile-restore.json';

export function mobileRestoreIntentPath(baseDir: string): string {
  return `${baseDir}/recovery/${MOBILE_RESTORE_INTENT_FILE}`;
}

/** Only a missing entry confirms normal startup; an unreadable marker needs recovery. */
export async function hasMobileRestoreIntent(root: FileSystemDirectoryHandle): Promise<boolean> {
  try {
    const base = await root.getDirectoryHandle(MOBILE_APP_DATA_DIR.slice(1));
    const recovery = await base.getDirectoryHandle('recovery');
    // Look up the entry name rather than reading it: even an invalid marker must block ordinary startup.
    await recovery.getFileHandle(MOBILE_RESTORE_INTENT_FILE);
    return true;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') return false;
    return true;
  }
}
