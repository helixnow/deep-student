import { readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import type { AudioDecodeReport, AudioProbe, NativeAudio } from './api.ts';
import { AudioDecodeError } from './api.ts';
export { AudioDecodeError } from './api.ts';
import { removeRun, runWasm, WasmCancelledError } from '../wasm/loader.ts';

const CHUNK_SAMPLES = 16_000;

function guestNames(path: string): { mediaDir: string; guestPath: string } {
  const absolute = resolve(path);
  return { mediaDir: dirname(absolute), guestPath: `/media/${basename(absolute)}` };
}

function replaceGuest(message: string, guestPath: string, path: string): string {
  // Rust prints the path exactly as the caller passed it (`path.display()`),
  // while the WASI sandbox only knows the resolved guest path.
  return message.split(guestPath).join(path);
}

function errorFrom(response: Record<string, unknown>, guestPath: string, path: string): AudioDecodeError {
  return new AudioDecodeError(
    String(response.code),
    replaceGuest(String(response.message), guestPath, path),
  );
}

function cancelled(): AudioDecodeError {
  return new AudioDecodeError('cancelled', '已取消');
}

function pcmChunk(bytes: Buffer, offset: number, samples: number): Int16Array {
  const chunk = new Int16Array(samples);
  for (let index = 0; index < samples; index += 1) {
    chunk[index] = bytes.readInt16LE(offset + index * 2);
  }
  return chunk;
}

export const audio: NativeAudio = {
  async probe(path: string, extensionHint?: string | null): Promise<AudioProbe> {
    const { mediaDir, guestPath } = guestNames(path);
    const run = await runWasm({
      engine: 'audio',
      op: 'probe',
      path: guestPath,
      extension_hint: extensionHint ?? null,
    }, { mediaDir });
    try {
      if (run.response.ok !== true) throw errorFrom(run.response, guestPath, path);
      return run.response.value as AudioProbe;
    } finally {
      await removeRun(run);
    }
  },

  async decodeToMono16k(path: string, options): Promise<AudioDecodeReport> {
    if (options.signal?.aborted) throw cancelled();
    const { mediaDir, guestPath } = guestNames(path);
    const run = await runWasm({
      engine: 'audio',
      op: 'decode',
      path: guestPath,
      extension_hint: options.extensionHint ?? null,
      output_path: '/out/pcm.bin',
      progress_path: '/out/progress.json',
    }, { mediaDir, signal: options.signal }).catch((error: unknown) => {
      if (error instanceof WasmCancelledError) throw cancelled();
      throw error;
    });
    try {
      if (run.response.ok !== true) throw errorFrom(run.response, guestPath, path);
      const report = run.response.report as AudioDecodeReport;
      if (options.signal?.aborted) throw cancelled();

      const progress = JSON.parse(
        await readFile(`${run.outputDir}/progress.json`, 'utf8'),
      ) as number[];
      for (const fraction of progress) {
        if (options.signal?.aborted) throw cancelled();
        options.onProgress(fraction);
      }

      const bytes = await readFile(`${run.outputDir}/pcm.bin`);
      const samples = bytes.length / 2;
      if (samples !== report.samples) {
        throw new Error(
          `f7-native-wasm pcm length mismatch: ${samples} samples written, report says ${report.samples}`,
        );
      }
      for (let offset = 0; offset < samples; offset += CHUNK_SAMPLES) {
        if (options.signal?.aborted) throw cancelled();
        const count = Math.min(CHUNK_SAMPLES, samples - offset);
        await options.sink(pcmChunk(bytes, offset * 2, count));
      }
      if (options.signal?.aborted) throw cancelled();
      return report;
    } finally {
      await removeRun(run);
    }
  },
};
