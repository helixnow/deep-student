/** Closed fixture trees only: preserve link text and recreate FIFOs without opening them. */
import { execFileSync } from 'node:child_process';
import { constants, copyFileSync, lstatSync, mkdirSync, readdirSync, readlinkSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

export function createSeedFifo(path: string): void {
  if (process.platform === 'win32') throw new Error('FIFO seeds require macOS or Linux');
  execFileSync('mkfifo', [path], { timeout: 5_000 });
}

export function copySeedTree(source: string, destination: string): void {
  const entry = lstatSync(source);
  if (entry.isSymbolicLink()) symlinkSync(readlinkSync(source), destination);
  else if (entry.isFIFO()) createSeedFifo(destination);
  else if (entry.isFile()) copyFileSync(source, destination, constants.COPYFILE_EXCL);
  else if (entry.isDirectory()) {
    mkdirSync(destination, { recursive: true });
    for (const name of readdirSync(source)) copySeedTree(join(source, name), join(destination, name));
  } else throw new Error(`Unsupported seed entry: ${source}`);
}
