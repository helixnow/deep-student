/** Select a backup and publish it to OPFS before returning its Host-visible path. */
export function pickBackupFile(
  targetPath: string,
  writeFile: (path: string, bytes: Uint8Array) => Promise<void>,
): Promise<{ path: string; name: string; size: number } | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.zip,application/zip,application/x-zip-compressed';
    input.style.display = 'none';
    document.body.appendChild(input);
    const cleanup = (): void => { input.remove(); };
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) { cleanup(); resolve(null); return; }
      // Catch both reading and OPFS writing failures, not just arrayBuffer() rejection.
      void Promise.resolve().then(async () => {
        const bytes = new Uint8Array(await file.arrayBuffer());
        await writeFile(targetPath, bytes);
        resolve({ path: targetPath, name: file.name, size: bytes.byteLength });
      }).catch(reject).finally(cleanup);
    }, { once: true });
    input.addEventListener('cancel', () => { cleanup(); resolve(null); }, { once: true });
    input.click();
  });
}
