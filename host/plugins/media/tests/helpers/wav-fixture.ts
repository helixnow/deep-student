/**
 * Test-only WAV fixture mirroring the Rust tests'
 * `decoder::tests::write_wav` / `tone` / `pipeline::tests::lecture_wav` helpers.
 */
import { writeFileSync } from 'node:fs';

export function writeWav(
  path: string,
  rate: number,
  channels: number,
  samples: readonly number[],
): void {
  const dataLen = samples.length * 2;
  const out = Buffer.alloc(44 + dataLen);
  out.write('RIFF', 0);
  out.writeUInt32LE(36 + dataLen, 4);
  out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(channels, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * channels * 2, 28);
  out.writeUInt16LE(channels * 2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36);
  out.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < samples.length; i++) out.writeInt16LE(samples[i]!, 44 + i * 2);
  writeFileSync(path, out);
}

export function tone(rate: number, secs: number, freq: number, amp: number): number[] {
  const n = Math.trunc(rate * secs);
  return Array.from({ length: n }, (_, i) => Math.trunc(
    amp * 32767 * Math.sin(2 * Math.PI * freq * i / rate)));
}

/** 合成"讲课"：语音块（200 Hz + 谐波）与静音交替。 */
export function lectureWav(
  path: string,
  blocks: ReadonlyArray<readonly [number, boolean]>,
  rate: number,
): void {
  const pcm: number[] = [];
  let t = 0;
  for (const [secs, voiced] of blocks) {
    const count = Math.trunc(secs * rate);
    for (let i = 0; i < count; i++) {
      const x = t / rate;
      const v = voiced
        ? 0.3 * Math.sin(2 * Math.PI * 200 * x) + 0.1 * Math.sin(2 * Math.PI * 650 * x)
        : 0;
      pcm.push(Math.trunc(v * 32767));
      t += 1;
    }
  }
  writeWav(path, rate, 1, pcm);
}
