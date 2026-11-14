import { describe, expect, it } from 'vitest';
import type { ExecutionContext, ToolResultInfo } from '../../chat/api.ts';
import { FetchChatToolExecutor } from '../src/tools/fetch-chat-executor.ts';
import { htmlToMarkdownText } from '../src/tools/fetch-executor.ts';
import { pinnedHttp } from './web-fetch-transport.ts';

const encoder = new TextEncoder();

interface BodyProbe {
  pulledBytes: number;
  closed: boolean;
  discarded: boolean;
}

/** A response body that pulls from `pieces` only on demand; cancelling it (the executor discarding the response) is recorded. */
function hopOf(status: number, headers: Headers, pieces: AsyncGenerator<Uint8Array>, probe: { discarded: boolean }): Response {
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await pieces.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel() {
      probe.discarded = true;
      await pieces.return(undefined);
    },
  }, { highWaterMark: 0 });
  return new Response(body, { status, headers });
}

/** A response whose body yields `chunk` until `totalBytes`, recording how much was pulled. */
function streamingHop(status: number, contentType: string, chunk: Uint8Array, totalBytes: number, probe: BodyProbe): Response {
  async function* body(): AsyncGenerator<Uint8Array> {
    try {
      for (let sent = 0; sent < totalBytes; sent += chunk.length) {
        const piece = chunk.subarray(0, Math.min(chunk.length, totalBytes - sent));
        probe.pulledBytes += piece.length;
        yield piece;
      }
    } finally {
      probe.closed = true;
    }
  }
  return hopOf(status, new Headers({ 'content-type': contentType }), body(), probe);
}

function run(hop: () => Response): Promise<ToolResultInfo> {
  const executor = new FetchChatToolExecutor({
    settings: () => null,
    artifactRoot: () => '/nonexistent',
    log: { debug: () => undefined, info: () => undefined, warn: () => undefined },
    http: () => pinnedHttp(async () => [{ address: '93.184.216.34' }], () => hop()),
    files: () => null,
  });
  const ctx = {
    session_id: 'sess', block_id: 'blk', cancellation_token: null, isCancelled: () => false,
    emitToolCallStart: () => undefined, emitToolCallEnd: () => undefined, emitToolCallError: () => undefined,
    saveToolBlock: () => undefined,
  } as unknown as ExecutionContext;
  return executor.execute({ id: 'call', name: 'builtin-web_fetch', arguments: { url: 'https://site.test/x' } }, ctx);
}

/** The pre-fix excerpt: decode the whole body, keep 500 code points, trim. */
function fullBodyExcerpt(bytes: Uint8Array): string {
  return Array.from(new TextDecoder().decode(bytes)).slice(0, 500).join('').trim();
}

const freshProbe = (): BodyProbe => ({ pulledBytes: 0, closed: false, discarded: false });

describe('web_fetch numeric character references (L1)', () => {
  it('out-of-range, NUL and surrogate references become U+FFFD instead of throwing', () => {
    expect(htmlToMarkdownText('<p>&#x110000;</p>')).toBe('\uFFFD');
    expect(htmlToMarkdownText('<p>a&#99999999;b</p>')).toBe('a\uFFFDb');
    expect(htmlToMarkdownText('<p>&#99999999999999999999999999;</p>')).toBe('\uFFFD');
    expect(htmlToMarkdownText(`<p>&#x${'f'.repeat(400)};</p>`)).toBe('\uFFFD');
    expect(htmlToMarkdownText('<p>[&#0;][&#x0;][&#xD800;][&#xdfff;][&#55296;]</p>'))
      .toBe('[\uFFFD][\uFFFD][\uFFFD][\uFFFD][\uFFFD]');
  });

  it('valid references around the boundaries decode as before', () => {
    expect(htmlToMarkdownText('<p>&#x10FFFF;|&#xD7FF;|&#xE000;|&#65;|&#x4e2d;|&#x1F600;|&#1114111;</p>'))
      .toBe('\u{10FFFF}|\uD7FF|\uE000|A|中|😀|\u{10FFFF}');
    expect(htmlToMarkdownText('<p>&#X41;</p>')).toBe('&#X41;');
    expect(htmlToMarkdownText('<p>&#xZZ; &bogus; &amp;lt;</p>')).toBe('&#xZZ; &bogus; &lt;');
  });

  it('names inherited from Object.prototype are unknown entities and stay literal, as in html5ever', () => {
    expect(htmlToMarkdownText('<p>&constructor; &Constructor; &amp;</p>')).toBe('&constructor; &Constructor; &');
  });

  it('a page with an invalid reference is still fetched', async () => {
    const page = encoder.encode('<html><body><p>bad &#x110000; ref</p></body></html>');
    const result = await run(() => streamingHop(200, 'text/html', page, page.length, freshProbe()));
    expect(result.error).toBeUndefined();
    expect((result.output as Record<string, unknown>).content).toBe('bad \uFFFD ref');
  });
});

describe('web_fetch non-2xx body excerpt (L3)', () => {
  it('reads only a few KiB of a 64 MiB error body and stops the stream', async () => {
    const probe = freshProbe();
    const chunk = encoder.encode('x'.repeat(1024));
    const result = await run(() => streamingHop(500, 'text/plain', chunk, 64 * 1024 * 1024, probe));
    expect(result.error).toBe(`HTTP request failed with status 500: Internal Server Error\nResponse body (excerpt): ${'x'.repeat(500)}`);
    expect(probe.pulledBytes).toBeLessThanOrEqual(8 * 1024);
    expect(probe.closed).toBe(true);
    expect(probe.discarded).toBe(true);
  });

  it('an error body larger than the old 64 MiB cap still yields its excerpt', async () => {
    const probe = freshProbe();
    const chunk = encoder.encode('busy '.repeat(13_000));
    const result = await run(() => streamingHop(503, 'text/plain', chunk, 65 * 1024 * 1024, probe));
    expect(result.error).toBe(`HTTP request failed with status 503: Service Unavailable\nResponse body (excerpt): ${'busy '.repeat(100).trim()}`);
    expect(probe.pulledBytes).toBeLessThan(1024 * 1024);
  });

  it.each([
    ['short body with surrounding whitespace', encoder.encode('  rate limit exceeded  ')],
    ['multibyte text cut mid-character', encoder.encode('中'.repeat(5000))],
    ['four-byte characters', encoder.encode('😀'.repeat(3000))],
    ['leading whitespace counts toward the 500 characters', encoder.encode(`${' '.repeat(498)}abcdef`)],
    ['BOM then text', Uint8Array.from([0xef, 0xbb, 0xbf, ...encoder.encode('é'.repeat(3000))])],
    ['invalid UTF-8 bytes', Uint8Array.from({ length: 6000 }, (_, index) => (index % 3 === 0 ? 0xff : 0x61))],
    ['body ending in a truncated sequence', Uint8Array.from([...encoder.encode('tail '), 0xe4, 0xb8])],
    ['empty body', new Uint8Array(0)],
  ])('%s: excerpt equals decoding the whole body', async (_label, body) => {
    for (const chunkSize of [1, 7, 4096, 1 << 16]) {
      const probe = freshProbe();
      let offset = 0;
      const hop = (): Response => {
        async function* pieces(): AsyncGenerator<Uint8Array> {
          try {
            for (; offset < body.length; offset += chunkSize) {
              const piece = body.subarray(offset, offset + chunkSize);
              probe.pulledBytes += piece.length;
              yield piece;
            }
          } finally { probe.closed = true; }
        }
        return hopOf(404, new Headers(), pieces(), probe);
      };
      const expected = fullBodyExcerpt(body);
      const result = await run(hop);
      expect(result.error).toBe(`HTTP request failed with status 404: Not Found${expected === '' ? '' : `\nResponse body (excerpt): ${expected}`}`);
      expect(probe.closed).toBe(true);
    }
  });

  const gbk = (repeat: number) => Uint8Array.from(Array.from({ length: repeat }, () => [0xd6, 0xd0, 0xce, 0xc4, 0xb4, 0xed, 0xce, 0xf3]).flat());
  const utf16 = (text: string, bigEndian: boolean) => Uint8Array.from([...text].flatMap(char => {
    const code = char.charCodeAt(0);
    return bigEndian ? [code >> 8, code & 0xff] : [code & 0xff, code >> 8];
  }));
  it.each([
    ['Content-Type charset (GBK)', 'text/html; charset=GBK', gbk(1000), '中文错误'.repeat(125)],
    ['quoted charset label', 'text/plain; charset="gb2312"', gbk(10), '中文错误'.repeat(10)],
    ['a UTF-16LE BOM wins over the header', 'text/plain; charset=gbk', Uint8Array.from([0xff, 0xfe, ...utf16('é'.repeat(3000), false)]), 'é'.repeat(500)],
    ['a UTF-16BE BOM', 'text/plain', Uint8Array.from([0xfe, 0xff, ...utf16('quota exceeded', true)]), 'quota exceeded'],
    ['an unknown label falls back to UTF-8', 'text/plain; charset=x-not-a-charset', encoder.encode('  über limit  '), 'über limit'],
  ])('%s: the excerpt decodes like reqwest Response::text()', async (_label, contentType, body, expected) => {
    for (const chunkSize of [1, 3, 4096]) {
      let offset = 0;
      const hop = (): Response => hopOf(429, new Headers({ 'content-type': contentType }),
        (async function* () { for (; offset < body.length; offset += chunkSize) yield body.subarray(offset, offset + chunkSize); })(), { discarded: false });
      expect((await run(hop)).error).toBe(`HTTP request failed with status 429: Too Many Requests\nResponse body (excerpt): ${expected}`);
    }
  });
});
