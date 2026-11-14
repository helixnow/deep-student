import { describe, expect, it } from 'vitest';
import { boundedPipeOutput, drainBounded, finishDrainTask } from '../src/tools/shell-execute.ts';

async function* chunks(size: number, count: number, fill = (index: number) => index % 251): AsyncGenerator<Buffer> {
  for (let index = 0; index < count; index += 1) yield Buffer.alloc(size, fill(index));
}

describe('local_shell_execute bounded output drain', () => {
  it('keeps the first max bytes, cuts a chunk at the bound and counts the whole stream', async () => {
    const capture = boundedPipeOutput();
    const source = (async function* () {
      yield Buffer.from('abc');
      yield new Uint8Array([100, 101, 102]);
      yield 'ghij';
      yield Buffer.from('klm');
    })();
    expect(await finishDrainTask(drainBounded(source, capture, 8), 'stdout')).toBeNull();
    expect(capture.visible.toString('utf8')).toBe('abcdefgh');
    expect(capture.total_bytes).toBe(13);
  });

  it('a stream that ends below the bound is kept whole', async () => {
    const capture = boundedPipeOutput();
    await finishDrainTask(drainBounded(chunks(1_000, 5), capture, 1024 * 1024), 'stdout');
    expect(capture.total_bytes).toBe(5_000);
    expect(capture.visible).toEqual(Buffer.concat([0, 1, 2, 3, 4].map(index => Buffer.alloc(1_000, index))));
  });

  it('copies each byte a bounded number of times, like Rust Vec::extend_from_slice (unrestricted mode allows 256 MiB)', async () => {
    const maxBytes = 96 * 1024 * 1024;
    const capture = boundedPipeOutput();
    const started = performance.now();
    await finishDrainTask(drainBounded(chunks(64 * 1024, 1_600), capture, maxBytes), 'stdout');
    const elapsed = performance.now() - started;
    expect(capture.total_bytes).toBe(1_600 * 64 * 1024);
    expect(capture.visible.length).toBe(maxBytes);
    expect(capture.visible[maxBytes - 1]).toBe(1_535 % 251);
    expect(elapsed).toBeLessThan(2_000);
  });
});
