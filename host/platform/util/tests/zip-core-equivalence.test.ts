/**
 * util 的同步内存版 ZIP 与 `platform/zip/core`（可移植、异步）在共同支持的选项上字节一致，
 * 互相可读：导入方从 `util/zip.ts` 迁到 core 不改变写出的归档。
 */
import { describe, expect, it } from 'vitest';
import { MemoryZipSink, ZipReader, ZipWriter, memoryZipSource, webZipCodec } from '../../zip/core/index.ts';
import { nodeZipCodec } from '../../zip/node/file.ts';
import { readZip, writeZip } from '../zip.ts';

const TEXT = 'hello 你好 '.repeat(2000);
const BLOB = Uint8Array.from({ length: 4096 }, (_, i) => (i * 31) & 0xff);

function utilArchive(): Uint8Array {
  return writeZip([
    { name: 'a.txt', data: TEXT },
    { name: '中文/b.bin', data: BLOB, options: { compression: 'stored' } },
    { name: 'empty.txt', data: '' },
    { name: 'dir', directory: true },
  ]);
}

describe('util zip vs platform/zip/core', () => {
  it.each([['web', webZipCodec], ['node', nodeZipCodec]] as const)('core ZipWriter (%s codec) writes the same bytes as util writeZip', async (_label, codec) => {
    const sink = new MemoryZipSink();
    const writer = new ZipWriter(sink, { codec });
    await writer.addBytes('a.txt', TEXT);
    await writer.addBytes('中文/b.bin', BLOB, { compression: 'stored' });
    await writer.addBytes('empty.txt', '');
    await writer.addDirectory('dir');
    await writer.finish();
    expect(Buffer.from(sink.bytes()).equals(Buffer.from(utilArchive()))).toBe(true);
  });

  it('each side reads the other side’s archive', async () => {
    const reader = await ZipReader.open(memoryZipSource(utilArchive()));
    expect(new TextDecoder().decode(await reader.readEntry(reader.find('a.txt')!))).toBe(TEXT);
    expect(Buffer.from(await reader.readEntry(reader.find('中文/b.bin')!)).equals(Buffer.from(BLOB))).toBe(true);

    const sink = new MemoryZipSink();
    const writer = new ZipWriter(sink);
    await writer.addBytes('a.txt', TEXT);
    await writer.finish();
    const archive = readZip(sink.bytes());
    expect(new TextDecoder().decode(archive.read('a.txt'))).toBe(TEXT);
  });
});
