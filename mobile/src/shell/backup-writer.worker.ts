// WebView 113 supports synchronous OPFS access in a dedicated worker, but not createWritable().
import { createOpfsFiles, mobileRoots, type OpfsDirectoryHandle } from '../../../host/platform/files/opfs.ts';
import type { RandomAccessFile } from '../../../host/platform/files/api.ts';

type WriterCommand = { kind: 'open'; path: string } | { kind: 'write'; bytes: Uint8Array } | { kind: 'close' } | { kind: 'abort' };
const files = navigator.storage.getDirectory().then(root =>
  createOpfsFiles({ root: root as unknown as OpfsDirectoryHandle, roots: mobileRoots('/deep-student') }),
);
let target: string | undefined;
let handle: RandomAccessFile | undefined;
let position = 0;

async function command(message: WriterCommand): Promise<void> {
  if (message.kind === 'open') {
    if (target) throw new Error('A backup is already open');
    // The Host supplies a fresh temporary path. Never overwrite an existing OPFS file.
    handle = await (await files).openFile(message.path, { mode: 'exclusive', createParents: true });
    target = message.path;
  } else if (message.kind === 'abort') {
    try { await handle?.close(); }
    finally { if (target) await (await files).rm(target, { force: true }); }
  } else if (!handle) {
    throw new Error('The backup is not open');
  } else if (message.kind === 'write') {
    await handle.write(message.bytes, position);
    position += message.bytes.byteLength;
  } else {
    await handle.sync();
    await handle.close();
    handle = undefined;
  }
}
self.addEventListener('message', (event: MessageEvent<WriterCommand>) => {
  void command(event.data).then(
    () => self.postMessage({}),
    (error: unknown) => self.postMessage({ error: error instanceof Error ? error.message : String(error) }),
  );
});
