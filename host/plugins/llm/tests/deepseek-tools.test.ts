import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { recognizeDeepseekPage } from '../src/deepseek_ocr_api.ts';
import { uploadDeepseekDocument } from '../src/deepseek_files.ts';
import { testDeepseekCapability } from '../src/deepseek_capability_test.ts';
import { buildModel2Messages } from '../src/model2_messages.ts';
import { buildModel2Request } from '../src/model2_request.ts';
import { createProviderRequests } from '../src/provider_requests_service.ts';
import { createStreamEventsService } from '../src/model2_stream_events.ts';
import { readModel2 } from '../src/model2_transport.ts';
import { OpenAIResponsesAdapter } from '../../llm-providers/api.ts';
import type { LlmMcpTools, UnifiedModel2StreamInput } from '../api.ts';
import { makeConfig } from './support.ts';

it('uploads a PDF in the required multipart order and scopes its replay to the selected config', async () => {
  const pdf = new TextEncoder().encode('%PDF-1.7');
  const fileId = await uploadDeepseekDocument(async (url, init) => {
    const req = new Request(url, init);
    expect(req.url).toBe('https://api.deepseek.com/files');
    const form = await req.formData();
    expect([...form.keys()]).toEqual(['purpose', 'file']);
    expect(form.get('purpose')).toBe('rich_layout_recognition');
    expect(await (form.get('file') as File).text()).toBe('%PDF-1.7');
    return Response.json({ id: 'file-api-report' });
  }, 'fixture-key', 'report.pdf', pdf, 'rich_layout_recognition', null);
  const history = [{ role: 'user', content: '总结这份文件', metadata: { canonicalContent: [
    { type: 'file_ref', deepseek_file_id: fileId, deepseek_config_id: 'official' },
    { type: 'file_ref', deepseek_file_id: 'file-api-other', deepseek_config_id: 'other' },
  ] } }];
  const config = makeConfig({ id: 'official', model: 'deepseek-flash' });
  expect(buildModel2Messages(config, history, null, false, [], true).at(-1)).toEqual({ role: 'user', content: [
    { type: 'input_file', file_id: 'file-api-report' }, { type: 'text', text: '总结这份文件' },
  ] });
  expect(buildModel2Messages(config, history, null, false, [], false).at(-1)).toMatchObject({ content: '总结这份文件' });
});

it('recognizes the official OCR page markers and rejects error responses with HTTP 200', async () => {
  const image = 'data:image/png;base64,iVBORw0KGgo=';
  const page = await recognizeDeepseekPage(async (url, init) => {
    const req = new Request(url, init);
    expect(req.url).toBe('https://api.deepseek.com/v1/tools/ocr');
    expect((await req.formData()).get('purpose')).toBe('rich_layout_recognition');
    return new Response('\n\n' + JSON.stringify({ pages: [{ index: 0, finish_reason: 'stop',
      text: '<｜ref｜>标题<｜/ref｜><｜box｜>[[52, 40, 948, 96]]<｜/box｜>' }] }));
  }, 'fixture-key', image, 'rich_layout_recognition');
  expect(page).toBe('<|ref|>标题<|/ref|><|det|>[[52, 40, 948, 96]]<|/det|>');
  await expect(recognizeDeepseekPage(async () => Response.json({ error: { message: 'OCR timed out' } }),
    'fixture-key', image, 'text_recognition')).rejects.toMatchObject({ message: 'DeepSeek OCR: OCR timed out' });
});

it('uses the official Responses wire format and only replays approved sources and text over HTTP', async () => {
  const posted: unknown[] = [];
  let frames: unknown[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    posted.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const frame of frames) response.write(`data: ${JSON.stringify(frame)}\n\n`);
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/responses`;
    const config = makeConfig({ id: 'official', model: 'deepseek-flash', apiProtocol: 'openai_responses',
      modelAdapter: 'deepseek', providerType: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', supportsTools: true });
    const api = createProviderRequests({ createAdapter: () => new OpenAIResponsesAdapter() } as never);
    const stream = createStreamEventsService();
    const emitted: { name: string; payload: unknown }[] = [];
    const input: UnifiedModel2StreamInput = { context: { web_search_enabled: true, custom_tools: [
      { type: 'function', function: { name: 'builtin-web_search' } },
      { type: 'function', function: { name: 'builtin-web_fetch' } },
    ] }, chatHistory: [{ role: 'user', content: 'Summarize https://example.org/article',
      metadata: { canonicalContent: [{ type: 'file_ref', deepseek_file_id: 'file-api-fixture', deepseek_config_id: config.id }] } }],
    streamEvent: 'test_deepseek', subject: '', taskContext: 'chat_v2', enableChainOfThought: false, enableThinking: true, disableTools: true,
    sink: { emit: (name, payload) => emitted.push({ name, payload }) } };
    const webSettings = new Map<string, string>([['deepseek.chat.web_tools', 'true'], ['deepseek.chat.safety_check', 'true'], ['deepseek.chat.files', 'true']]);
    const settings = { get: (key: string) => webSettings.get(key) ?? null };
    const signed = { type: 'web_search_call', id: 'srvtoolu_rl_1', status: 'completed', kind: 'read_link',
      action: { type: 'open_page', url: 'https://example.org/article' },
      page: { url: 'https://example.org/article', title: 'Article' }, signature: 'opaque-signature' };
    const toolItems: unknown[] = [];
    stream.registerStreamHooks(input.streamEvent, { onWebSearch: value => {
      if (value && typeof value === 'object' && 'item' in value) toolItems.push(value.item);
    } });
    const request = async () => {
      const body = await buildModel2Request(config, input, settings, {} as LlmMcpTools, null);
      const prepared = await api.prepareModel2Async(config, body, input.streamEvent, null, false);
      expect(prepared.request.url).toBe('https://api.deepseek.com/v1/responses');
      const response = await fetch(endpoint, { method: 'POST', body: JSON.stringify(prepared.request.body) });
      const collector = stream.create({ streamEvent: input.streamEvent, requestId: 'test', sink: input.sink,
        requireTerminalSuccess: true, isCodex: false });
      await readModel2(response, prepared, input, 'test', { consumePendingCancel: async () => false, clearCancelStream: async () => {} },
        new AbortController().signal, collector);
      return collector.snapshot();
    };
    frames = [
      { type: 'response.output_text.delta', delta: 'Unreviewed' },
      { type: 'response.output_item.done', output_index: 0, item: signed },
      { type: 'response.completed', response: { status: 'completed', output: [signed, { type: 'message', content: [
        { type: 'output_text', text: '🌱事实。', annotations: [
          { type: 'url_citation', url: 'https://example.org/article', start_index: 0, end_index: 3 },
        ] },
      ] }] } },
    ];
    expect((await request()).content).toBe('🌱事实 [1](<https://example.org/article>)。');
    expect(posted[0]).toMatchObject({ safety_check: { level: 'high' },
      tools: [{ type: 'function', name: 'builtin-web_fetch' }, { type: 'deepseek_web_search' }, { type: 'deepseek_read_url' }],
      input: [{ role: 'user', content: [{ type: 'input_file', file_id: 'file-api-fixture' }, { type: 'input_text' }] }],
    });
    expect(toolItems).toEqual([signed]);
    input.chatHistory.push({ role: 'assistant', content: '🌱事实。', metadata: { openai_responses_web_search_items: [signed] } },
      { role: 'user', content: 'Follow up' });
    frames = [
      { type: 'response.output_text.delta', delta: 'Unreviewed' },
      { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'content_filter' }, output: [] } },
    ];
    await expect(request()).rejects.toMatchObject({ message: 'DeepSeek 内容安全审核未通过，未显示回复' });
    expect(posted[1]).toMatchObject({ input: expect.arrayContaining([signed]) });
    expect(emitted.some(event => event.name.endsWith('_safety_blocked'))).toBe(true);
    input.context.deepseek_web_tools_disabled = true;
    frames = [{ type: 'response.completed', response: { status: 'completed', output: [
      { type: 'message', content: [{ type: 'output_text', text: 'No new search' }] },
    ] } }];
    expect((await request()).content).toBe('No new search');
    expect(posted[2]).toMatchObject({ tools: [{ name: 'builtin-web_search' }, { name: 'builtin-web_fetch' }] });
    delete input.context.deepseek_web_tools_disabled;
    webSettings.set('deepseek.chat.web_search', 'false');
    expect((await request()).content).toBe('No new search');
    expect(posted[3]).toMatchObject({ tools: [{ name: 'builtin-web_search' }, { name: 'builtin-web_fetch' }, { type: 'deepseek_read_url' }] });
    webSettings.set('deepseek.chat.web_search', 'true');
    webSettings.set('deepseek.chat.read_url', 'false');
    await request();
    expect(posted[4]).toMatchObject({ tools: [{ name: 'builtin-web_fetch' }, { type: 'deepseek_web_search' }] });
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it('reports capability health from fresh upstream HTTP results without accepting model output in place of a tool call', async () => {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const initial = new Request(`https://api.deepseek.com${req.url}`, { method: 'POST', headers: req.headers as HeadersInit,
      body: Buffer.concat(chunks) });
    res.setHeader('content-type', 'application/json');
    const sent = (body: unknown, status = 200) => { res.statusCode = status; res.end(JSON.stringify(body)); };
    const auth = initial.headers.get('authorization');
    if (req.url === '/v1/tools/fetch') {
      sent(auth === 'Bearer search-fixture' ? { error: { code: 'bad_key' } } : { content: 'local fallback' }, 401);
      return;
    }
    if (auth !== 'Bearer provider-fixture') { sent({}, 403); return; }
    if (req.url === '/files') {
      const form = await initial.formData();
      const file = form.get('file');
      if (form.get('expires_after[seconds]') !== '3600' || !(file instanceof File) || !(await file.text()).includes('34971')) {
        sent({ error: { code: 'bad_file' } }, 400); return;
      }
      sent({ id: 'file-api-probe' }); return;
    }
    const body = await initial.json() as Record<string, unknown>;
    const isFile = JSON.stringify(body.input).includes('file-api-probe');
    const tool = (body.tools as { type: string }[] | undefined)?.[0]?.type;
    sent({ status: 'completed', output: [
      ...(tool === 'deepseek_web_search' ? [{ type: 'web_search_call', status: 'completed', kind: 'search',
        action: { sources: [{ url: 'https://www.iana.org/' }] } }] : []),
      { type: 'message', content: [{ type: 'output_text', text: isFile ? '34971' : 'Example domains' }] },
    ] });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    const local = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const baseUrl = 'https://api.deepseek.com/v1';
    const deps = {
      baseUrl, fetch: (async (url, init) => fetch(local + new URL(String(url)).pathname, init)) as typeof fetch,
      flash: async () => makeConfig({ model: 'deepseek-flash', baseUrl, apiProtocol: 'openai_responses', providerType: 'deepseek' }),
      providerKey: async () => 'provider-fixture', searchKey: async () => 'search-fixture', needContent: false,
    };
    await expect(testDeepseekCapability({ capability: 'chat_search' }, deps)).resolves.toBeGreaterThanOrEqual(0);
    await expect(testDeepseekCapability({ capability: 'chat_files' }, deps)).resolves.toBeGreaterThanOrEqual(0);
    await expect(testDeepseekCapability({ capability: 'chat_read_url' }, deps)).rejects.toMatchObject({ message: expect.stringContaining('usable result') });
    await expect(testDeepseekCapability({ capability: 'fetch' }, deps)).rejects.toMatchObject({ message: 'DeepSeek API: HTTP 401' });
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
