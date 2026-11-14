import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import {
  Crc32, canonicalReason, charCount, crc32, decodeUtf8Strict,
  isCharBoundary, rustTrim, rustTrimEnd, rustTrimStart, statusLine, takeChars,
  truncateUtf8, truncateUtf8Exact, utf8ByteLength, utf8ErrorMessage,
} from '../index.ts';
import { ZipArchive, ZipWriter, readZip, writeZip } from '../node.ts';

describe('Rust str::trim family', () => {
  it('uses Unicode White_Space, not JS trim semantics', () => {
    expect(rustTrim('\u0085\t a \n\u3000')).toBe('a');
    expect(rustTrim('\u00a0x\u202f')).toBe('x');
    // JS String.prototype.trim removes U+FEFF; Rust does not.
    expect(rustTrim('\uFEFFx\uFEFF')).toBe('\uFEFFx\uFEFF');
    expect('\uFEFFx\uFEFF'.trim()).toBe('x');
    expect(rustTrimStart(' \t x ')).toBe('x ');
    expect(rustTrimEnd(' x \n')).toBe(' x');
  });
});

describe('UTF-8 length and char-boundary truncation', () => {
  it('counts bytes and Unicode scalars like Rust', () => {
    expect(utf8ByteLength('abc')).toBe(3);
    expect(utf8ByteLength('中文')).toBe(6);
    expect(utf8ByteLength('a😀b')).toBe(6);
    expect(charCount('a😀b')).toBe(3);
    expect(takeChars('a😀b', 2)).toBe('a😀');
    expect(takeChars('a😀b', 10)).toBe('a😀b');
  });

  it('truncates to the longest prefix that does not split a code point', () => {
    expect(truncateUtf8('a😀b', 0)).toBe('');
    expect(truncateUtf8('a😀b', 1)).toBe('a');
    expect(truncateUtf8('a😀b', 2)).toBe('a');
    expect(truncateUtf8('a😀b', 4)).toBe('a');
    expect(truncateUtf8('a😀b', 5)).toBe('a😀');
    expect(truncateUtf8('a😀b', 6)).toBe('a😀b');
    expect(truncateUtf8('a😀b', 99)).toBe('a😀b');
    expect(() => truncateUtf8('a', -1)).toThrow(RangeError);
  });

  it('truncateUtf8Exact mirrors Rust String::truncate panics', () => {
    expect(truncateUtf8Exact('a😀b', 1)).toBe('a');
    expect(truncateUtf8Exact('a😀b', 5)).toBe('a😀');
    expect(truncateUtf8Exact('a😀b', 6)).toBe('a😀b');
    expect(() => truncateUtf8Exact('a😀b', 2)).toThrow(/not a char boundary/);
    expect(() => truncateUtf8Exact('a', 2)).toThrow(/out of bounds/);
    expect(isCharBoundary('a😀b', 1)).toBe(true);
    expect(isCharBoundary('a😀b', 2)).toBe(false);
    expect(isCharBoundary('a😀b', 5)).toBe(true);
    expect(isCharBoundary('a😀b', 7)).toBe(false);
  });

  it('reports Rust FromUtf8Error Display text', () => {
    expect(utf8ErrorMessage(Buffer.from([0x61, 0xff, 0x62]))).toBe('invalid utf-8 sequence of 1 bytes from index 1');
    expect(utf8ErrorMessage(Buffer.from([0xe2, 0x82]))).toBe('incomplete utf-8 byte sequence from index 0');
    expect(utf8ErrorMessage(Buffer.from([0xe2, 0x82, 0x28]))).toBe('invalid utf-8 sequence of 2 bytes from index 0');
    expect(utf8ErrorMessage(Buffer.from([0xf0, 0x90, 0x80]))).toBe('incomplete utf-8 byte sequence from index 0');
    expect(utf8ErrorMessage(Buffer.from([0xed, 0xa0, 0x80]))).toBe('invalid utf-8 sequence of 1 bytes from index 0');
    expect(utf8ErrorMessage(Buffer.from('ok😀', 'utf8'))).toBeNull();
    expect(() => decodeUtf8Strict(Buffer.from([0x61, 0xff]))).toThrow('invalid utf-8 sequence of 1 bytes from index 1');
    expect(decodeUtf8Strict(Buffer.from('\uFEFFx', 'utf8'))).toBe('\uFEFFx');
  });
});

describe('http canonical_reason', () => {
  const expected: [number, string][] = [
    [100, 'Continue'], [101, 'Switching Protocols'], [102, 'Processing'], [103, 'Early Hints'],
    [200, 'OK'], [201, 'Created'], [202, 'Accepted'], [203, 'Non Authoritative Information'],
    [204, 'No Content'], [205, 'Reset Content'], [206, 'Partial Content'], [207, 'Multi-Status'],
    [208, 'Already Reported'], [226, 'IM Used'], [300, 'Multiple Choices'], [301, 'Moved Permanently'],
    [302, 'Found'], [303, 'See Other'], [304, 'Not Modified'], [305, 'Use Proxy'],
    [307, 'Temporary Redirect'], [308, 'Permanent Redirect'], [400, 'Bad Request'], [401, 'Unauthorized'],
    [402, 'Payment Required'], [403, 'Forbidden'], [404, 'Not Found'], [405, 'Method Not Allowed'],
    [406, 'Not Acceptable'], [407, 'Proxy Authentication Required'], [408, 'Request Timeout'], [409, 'Conflict'],
    [410, 'Gone'], [411, 'Length Required'], [412, 'Precondition Failed'], [413, 'Payload Too Large'],
    [414, 'URI Too Long'], [415, 'Unsupported Media Type'], [416, 'Range Not Satisfiable'], [417, 'Expectation Failed'],
    [418, "I'm a teapot"], [421, 'Misdirected Request'], [422, 'Unprocessable Entity'], [423, 'Locked'],
    [424, 'Failed Dependency'], [425, 'Too Early'], [426, 'Upgrade Required'], [428, 'Precondition Required'],
    [429, 'Too Many Requests'], [431, 'Request Header Fields Too Large'], [451, 'Unavailable For Legal Reasons'],
    [500, 'Internal Server Error'], [501, 'Not Implemented'], [502, 'Bad Gateway'], [503, 'Service Unavailable'],
    [504, 'Gateway Timeout'], [505, 'HTTP Version Not Supported'], [506, 'Variant Also Negotiates'],
    [507, 'Insufficient Storage'], [508, 'Loop Detected'], [510, 'Not Extended'],
    [511, 'Network Authentication Required'],
  ];
  it('matches the http crate table and returns null for unknown codes', () => {
    expect(expected).toHaveLength(62);
    for (const [status, reason] of expected) expect(canonicalReason(status), String(status)).toBe(reason);
    expect(canonicalReason(306)).toBeNull();
    expect(canonicalReason(999)).toBeNull();
    expect(statusLine(404)).toBe('404 Not Found');
    expect(statusLine(599)).toBe('599 <unknown status code>');
  });
});

describe('CRC-32', () => {
  it('matches the standard check value and supports incremental updates', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
    const first = crc32(Buffer.from('1234'));
    expect(crc32(Buffer.from('56789'), first)).toBe(0xcbf43926);
    const hasher = new Crc32().update(Buffer.from('1234')).update(Buffer.from('56789'));
    expect(hasher.finalize()).toBe(0xcbf43926);
    expect(hasher.finalize()).toBe(0xcbf43926);
  });
});

describe('ZIP writer / reader', () => {
  it('round-trips stored and deflated entries with metadata and UTF-8 names', () => {
    const writer = new ZipWriter();
    writer.addFile('plain.txt', 'hello', { compression: 'stored', unixPermissions: 0o600 });
    writer.addFile('目录/压缩.txt', 'hello '.repeat(100), { compression: 'deflated' });
    writer.addDirectory('empty');
    const bytes = writer.finish();
    const archive = readZip(bytes);
    expect(archive.entries.map(entry => entry.name)).toEqual(['plain.txt', '目录/压缩.txt', 'empty/']);
    expect(archive.entry('plain.txt')).toMatchObject({ compression: 'stored', size: 5, compressedSize: 5, isDirectory: false });
    expect(archive.entry('目录/压缩.txt')).toMatchObject({ compression: 'deflated', size: 600 });
    expect(archive.read('plain.txt').toString('utf8')).toBe('hello');
    expect(archive.read('目录/压缩.txt').toString('utf8')).toBe('hello '.repeat(100));
    expect(archive.read('empty/').length).toBe(0);
    expect(() => archive.read('missing')).toThrow(/no entry/);
    expect(writeZip([{ name: 'a.txt', data: 'a' }]).length).toBeGreaterThan(0);
  });

  it('interoperates with JSZip in both directions', async () => {
    const ours = writeZip([
      { name: 'stored.txt', data: 'stored', options: { compression: 'stored' } },
      { name: 'deflated.txt', data: 'deflated '.repeat(50) },
    ]);
    const jszip = await JSZip.loadAsync(ours);
    expect(await jszip.file('stored.txt')!.async('string')).toBe('stored');
    expect(await jszip.file('deflated.txt')!.async('string')).toBe('deflated '.repeat(50));

    const source = new JSZip();
    source.file('one.txt', 'first');
    source.file('sub/two.txt', 'second');
    const bytes = await source.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const archive = readZip(bytes);
    expect(archive.entry('one.txt')).toMatchObject({ compression: 'deflated' });
    expect(archive.read('one.txt').toString('utf8')).toBe('first');
    expect(archive.read('sub/two.txt').toString('utf8')).toBe('second');
  });

  it('rejects a corrupted entry through the CRC check', () => {
    const bytes = writeZip([{ name: 'a.txt', data: 'hello', options: { compression: 'stored' } }]);
    const nameLength = bytes.readUInt16LE(26);
    const dataStart = 30 + nameLength;
    bytes[dataStart] = bytes[dataStart]! ^ 0xff;
    expect(() => readZip(bytes).read('a.txt')).toThrow(/CRC32 mismatch/);
    expect(readZip(bytes).read('a.txt', { verifyCrc: false }).toString('utf8')).not.toBe('hello');
  });

  it('refuses unsupported compression methods and truncated archives', () => {
    const bytes = writeZip([{ name: 'a.txt', data: 'hello' }]);
    const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    bytes.writeUInt16LE(99, central + 10);
    const archive = readZip(bytes);
    expect(archive.entry('a.txt')!.compression).toBe('unsupported');
    expect(() => archive.read('a.txt')).toThrow(/unsupported Zip compression/);
    expect(() => readZip(bytes.subarray(0, 20))).toThrow(/End of Central Directory/);
  });

  it('exposes the entry type through ZipArchive and ZipEntryInfo', () => {
    const archive: ZipArchive = readZip(writeZip([{ name: 'x', data: 'y' }]));
    expect(archive.entries[0]).toMatchObject({ name: 'x', size: 1 });
  });
});
