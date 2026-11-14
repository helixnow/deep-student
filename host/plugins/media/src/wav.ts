import { closeSync, mkdirSync, openSync, readSync, unlinkSync, writeSync } from 'node:fs';
import { join } from '../../../platform/util/path.ts';
import { tmpdir } from 'node:os';
import { MediaError } from './errors.ts';

export function encodeWavMono16k(samples: Int16Array): Uint8Array {
  const dataLen = samples.length * 2;
  const out = Buffer.allocUnsafe(44 + dataLen);
  out.write('RIFF', 0);
  out.writeUInt32LE((36 + dataLen) >>> 0, 4);
  out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(16_000, 24);
  out.writeUInt32LE(32_000, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36);
  out.writeUInt32LE(dataLen >>> 0, 40);
  for (let i = 0; i < samples.length; i++) out.writeInt16LE(samples[i]!, 44 + i * 2);
  return out;
}

export class PcmSpoolWriter {
  _fd: number | null;
  _path: string;
  _samples = 0;
  constructor(dir: string | null = null) {
    const root = dir ?? tmpdir();
    if (dir !== null) mkdirSync(root, { recursive: true });
    this._path = join(root, `media-pcm-${globalThis.crypto.randomUUID()}.raw`);
    this._fd = openSync(this._path, 'wx+', 0o600);
  }
  write(pcm: Int16Array): void {
    if (this._fd === null) throw new MediaError('Io', 'spool already finished');
    const bytes = Buffer.allocUnsafe(pcm.length * 2);
    for (let i = 0; i < pcm.length; i++) bytes.writeInt16LE(pcm[i]!, i * 2);
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(this._fd, bytes, offset, bytes.length - offset);
    this._samples += pcm.length;
  }
  finish(): PcmSpool {
    if (this._fd === null) throw new MediaError('Io', 'spool already finished');
    const spool = new PcmSpool(this._fd, this._path, this._samples);
    this._fd = null;
    return spool;
  }
  close(): void {
    if (this._fd === null) return;
    closeSync(this._fd);
    this._fd = null;
    unlinkSync(this._path);
  }
}

export class PcmSpool {
  _fd: number;
  _path: string;
  _samples: number;
  _closed = false;
  constructor(fd: number, path: string, samples: number) {
    this._fd = fd; this._path = path; this._samples = samples;
  }
  samples(): number { return this._samples; }
  durationMs(): number { return Math.trunc(this._samples * 1000 / 16_000); }
  readMs(startMs: number, endMs: number): Int16Array {
    const start = Math.trunc(Math.max(startMs, 0) * 16_000 / 1000);
    const end = Math.min(Math.trunc(Math.max(endMs, 0) * 16_000 / 1000), this._samples);
    if (end <= start) return new Int16Array();
    const bytes = Buffer.allocUnsafe((end - start) * 2);
    let offset = 0;
    while (offset < bytes.length) {
      const n = readSync(this._fd, bytes, offset, bytes.length - offset, start * 2 + offset);
      if (n === 0) throw new MediaError('Io', 'failed to fill whole buffer');
      offset += n;
    }
    return Int16Array.from({ length: end - start }, (_, i) => bytes.readInt16LE(i * 2));
  }
  close(): void {
    if (this._closed) return;
    closeSync(this._fd);
    this._closed = true;
    unlinkSync(this._path);
  }
}
