import * as fs from 'node:fs';

/** Rust Write::write_all for the lane's staged workspace/artifact files. */
export function writeAll(fd: number, bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.length) {
    let written: number;
    try { written = fs.writeSync(fd, bytes, offset, bytes.length - offset); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EINTR') continue;
      throw error;
    }
    if (written === 0) throw new Error('failed to write whole buffer');
    offset += written;
  }
}
