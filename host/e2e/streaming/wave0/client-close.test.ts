/**
 * How the WAVE0 LLM service logs the end of a streamed response when the client goes away near the end.
 * The request log is G3 evidence (`llmRequests`), so both outcomes are pinned:
 * - the client reads `[DONE]` and drops the connection before HTTP EOF, as both backends do (A stops at the
 *   marker in model2_pipeline.rs and drops the reqwest stream; B's readModel2 breaks on Done and cancels the
 *   reader) → `done`;
 * - a write fails because the peer is gone, `[DONE]` included → `client-closed`, and `framesWritten` counts
 *   only the writes that succeeded.
 * A real peer cannot be timed into the second case: the service writes a whole scripted round within one turn
 * of the event loop. The failing write (EPIPE, then the socket closes) is injected at `ServerResponse#write`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { ServerResponse, request as httpRequest, type IncomingMessage } from 'node:http';
import { startLlmService, type LlmService, type ResponseScript } from './llm-service.ts';

const services: LlmService[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(services.splice(0).map(service => service.stop()));
});

const DONE = 'data: [DONE]\n\n';
const RAW: ResponseScript = { description: 'two literal chunks, then HTTP EOF',
  responses: [{ status: 200, headers: { 'content-type': 'text/event-stream' }, chunks: ['data: {"a":1}\n\n', 'data: {"b":2}\n\n'] }] };
const request = JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'q' }] });

async function service(): Promise<LlmService> {
  const started = await startLlmService({ extraScripts: { raw: RAW } });
  services.push(started);
  return started;
}

/**
 * POST and read the stream. With `dropAfter`, the request is destroyed as soon as the received text ends with it
 * (before HTTP EOF); otherwise reading stops at EOF or at a connection error.
 */
async function read(s: LlmService, id: string, dropAfter?: string): Promise<{ text: string; how: 'dropped' | 'eof' | 'error' }> {
  const req = httpRequest(new URL(`${s.baseUrl(id)}/chat/completions`), { method: 'POST', headers: { 'content-type': 'application/json' } });
  req.on('error', () => {});
  req.end(request);
  const [response] = await once(req, 'response') as [IncomingMessage];
  response.setEncoding('utf8');
  let text = '';
  return new Promise(resolve => {
    response.on('data', (chunk: string) => {
      text += chunk;
      if (dropAfter !== undefined && text.endsWith(dropAfter)) {
        req.destroy();
        resolve({ text, how: 'dropped' });
      }
    });
    response.on('end', () => resolve({ text, how: 'eof' }));
    response.on('error', () => resolve({ text, how: 'error' }));
    response.on('close', () => resolve({ text, how: response.complete ? 'eof' : 'error' }));
  });
}

/** The next write of exactly `chunk` fails as a write to a reset peer does: EPIPE to the callback, then the socket closes. */
function failWriteOf(chunk: string): void {
  const write = ServerResponse.prototype.write;
  vi.spyOn(ServerResponse.prototype, 'write').mockImplementation(function (this: ServerResponse, ...args: unknown[]) {
    if (args[0] !== chunk) return Reflect.apply(write, this, args) as boolean;
    const callback = args.find((arg): arg is (error: Error) => void => typeof arg === 'function');
    const error = Object.assign(new Error('write EPIPE'), { code: 'EPIPE', syscall: 'write' });
    this.socket?.destroy();
    process.nextTick(() => callback?.(error));
    return false;
  });
}

describe('WAVE0 LLM service: a client close around [DONE] is logged as what happened on the wire', () => {
  it('a client that stops at [DONE] and drops the connection before HTTP EOF is logged done', async () => {
    const s = await service();
    const { text, how } = await read(s, 'success.answer', DONE);
    expect(how).toBe('dropped');
    expect(text.split('\n\n').filter(Boolean)).toHaveLength(5);
    expect(await s.whenIdle(2000)).toBe(true);
    expect(s.requests).toEqual([expect.objectContaining({ scriptId: 'success.answer', outcome: 'served', status: 200, framesWritten: 4, end: 'done' })]);
  });

  it('a [DONE] write that fails because the client is gone is logged client-closed; every frame before it counts', async () => {
    failWriteOf(DONE);
    const s = await service();
    const { text, how } = await read(s, 'success.answer');
    expect(how).toBe('error');
    expect(text).not.toContain('[DONE]');
    expect(text.split('\n\n').filter(Boolean)).toHaveLength(4);
    expect(await s.whenIdle(2000)).toBe(true);
    expect(s.requests).toEqual([expect.objectContaining({ scriptId: 'success.answer', outcome: 'served', status: 200, framesWritten: 4, end: 'client-closed' })]);
  });

  it('a frame write that fails mid-stream stops the round there: client-closed, framesWritten = frames before it', async () => {
    const s = await service();
    const first = await read(s, 'success.answer');
    const second = first.text.split('\n\n')[1]! + '\n\n';
    failWriteOf(second);
    const { text, how } = await read(s, 'success.answer');
    expect(how).toBe('error');
    expect(text).toBe(first.text.split('\n\n')[0]! + '\n\n');
    expect(await s.whenIdle(2000)).toBe(true);
    expect(s.requests.map(r => [r.outcome, r.framesWritten, r.end])).toEqual([['served', 4, 'done'], ['served', 1, 'client-closed']]);
  });

  it('a sidecar response whose last chunk write fails is logged client-closed, not eof; raw.chunks holds what was written', async () => {
    failWriteOf(RAW.responses[0]!.chunks[1]!);
    const s = await service();
    const { text, how } = await read(s, 'raw');
    expect(how).toBe('error');
    expect(text).toBe(RAW.responses[0]!.chunks[0]);
    expect(await s.whenIdle(2000)).toBe(true);
    expect(s.requests[0]).toMatchObject({ scriptId: 'raw', outcome: 'served', status: 200, framesWritten: 1, end: 'client-closed' });
    expect(s.requests[0]!.raw!.chunks).toEqual([RAW.responses[0]!.chunks[0]]);
  });

  it('without a failing write the same sidecar ends eof after both chunks', async () => {
    const s = await service();
    const { text, how } = await read(s, 'raw');
    expect([how, text]).toEqual(['eof', RAW.responses[0]!.chunks.join('')]);
    expect(s.requests[0]).toMatchObject({ framesWritten: 2, end: 'eof' });
  });
});
