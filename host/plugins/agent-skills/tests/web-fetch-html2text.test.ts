import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { OfficeParsingError, type NativeOffice } from '../../../platform/native/office/api.ts';
import { office as wasiOffice } from '../../../platform/native/office/extract.ts';
import type { ExecutionContext, ToolResultInfo } from '../../chat/api.ts';
import { FetchChatToolExecutor } from '../src/tools/fetch-chat-executor.ts';
import { page, pinnedHttp } from './web-fetch-transport.ts';

const PAGE = '<nav>Menu</nav><h1>Title</h1><p>Hello &amp; welcome &#X43; &#x80; &#150;</p>'
  + '<ul><li>one</li><li>two</li></ul><p>See <a href="https://example.com/x">link</a>.</p>';
/** `html2text::from_read(<PAGE without the nav>, 80)` printed by html2text 0.16.7 built natively. */
const RUST_HTML2TEXT = '# Title\n\nHello & welcome C € –\n* one\n* two\n\nSee [link][1].\n\n[1]: https://example.com/x\n';

function harness(office: (() => Pick<NativeOffice, 'extractText'> | null) | undefined, body: string) {
  const warnings: string[] = [];
  const executor = new FetchChatToolExecutor({
    settings: () => null, artifactRoot: sessionId => path.join(tmpdir(), 's01-html2text', sessionId),
    log: { debug: () => undefined, info: () => undefined, warn: message => { warnings.push(message); } },
    http: () => pinnedHttp(async () => [{ address: '93.184.216.34' }], () => page(200, { body, contentType: 'text/html; charset=utf-8' })),
    files: () => null,
    ...(office === undefined ? {} : { office }),
  });
  const ctx = { session_id: 's', block_id: 'b', cancellation_token: null, isCancelled: () => false,
    emitToolCallStart: () => undefined, emitToolCallEnd: () => undefined, emitToolCallError: () => undefined,
    saveToolBlock: () => undefined } as unknown as ExecutionContext;
  const run = (): Promise<ToolResultInfo> => executor.execute({ id: 'c', name: 'web_fetch', arguments: { url: 'https://site.test/' } }, ctx);
  return { run, warnings };
}

describe('web_fetch HTML conversion through nativeOffice html2text', () => {
  it('matches Rust html2text output (entities, lists, link references) apart from the engine-side trim', async () => {
    const result = await harness(() => wasiOffice, PAGE).run();
    // nativeOffice.extractText trims; Rust web_fetch keeps the trailing newline (W01 handoff).
    expect(result).toMatchObject({ success: true, output: { content: RUST_HTML2TEXT.trim() } });
  });

  it('keeps the cleaned HTML when html2text reports a parsing error, as Rust does', async () => {
    const failing = { extractText: async () => { throw new OfficeParsingError('Other', 'HTML 转文本失败: boom'); } };
    const h = harness(() => failing, '<nav>Menu</nav><p>Body</p>');
    expect(await h.run()).toMatchObject({ success: true, output: { content: '<p>Body</p>' } });
    expect(h.warnings).toEqual(['[FetchExecutor] HTML 转文本失败，回退清理后内容: boom']);
  });

  it('fails the call instead of silently converting when the engine itself breaks', async () => {
    const broken = { extractText: async () => { throw new Error('wasm instantiate failed'); } };
    expect(await harness(() => broken, PAGE).run()).toMatchObject({ success: false, error: expect.stringContaining('wasm instantiate failed') });
  });

  it('uses the TS converter when no nativeOffice service is registered', async () => {
    const result = await harness(() => null, '<p>plain</p>').run();
    expect(result).toMatchObject({ success: true, output: { content: 'plain' } });
  });
});
