import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { providerScripts, startLlmService, type LlmService, type RawResponse } from './llm-service.ts';

const fixture = new URL('./__fixtures__/ai-grading-scripted.provider.json', import.meta.url);
const source: unknown = JSON.parse(readFileSync(fixture, 'utf8'));
const scripts = providerScripts(source);
const prefix = 'qbank.ai_grade.scripted.';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop(); });
async function service() {
  const s = await startLlmService({ extraScripts: scripts });
  cleanup.push(() => s.stop());
  return s;
}

// Retain the client-observed headers and entity bytes, independently of the server log.
function post(url: string, body = '{ "model":"wp052-model", "stream":true, "messages":[] }', method = 'POST') {
  return new Promise<{ status: number; rawHeaders: string[]; headers: import('node:http').IncomingHttpHeaders;
    body: string; bodyBase64: string; complete: boolean }>((resolve, reject) => {
    const req = httpRequest(url, { method, agent: false, headers: { 'content-type': 'application/json' } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        const bytes = Buffer.concat(chunks);
        resolve({ status: response.statusCode!, rawHeaders: response.rawHeaders, headers: response.headers,
          body: bytes.toString('utf8'), bodyBase64: bytes.toString('base64'), complete: response.complete });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}
const endpoint = (s: LlmService, id: string) => `${s.baseUrl(id)}/chat/completions`;
function exact(actual: Awaited<ReturnType<typeof post>>, scripted: RawResponse) {
  expect(actual.status).toBe(scripted.status);
  for (const [key, value] of Object.entries(scripted.headers)) expect(actual.headers[key]).toBe(value);
  expect(actual.bodyBase64).toBe(Buffer.from(scripted.chunks.join('')).toString('base64'));
  expect(actual.complete).toBe(true);
  // No dynamic Date or synthetic SSE/content headers are added.
  expect(Object.keys(actual.headers).sort()).toEqual([...Object.keys(scripted.headers), 'connection', 'transfer-encoding'].sort());
}

describe('WP-123 owner provider sidecar over real HTTP', () => {
  it('serves all 10 L14 scripts / 11 responses byte-for-byte with independent per-instance order', async () => {
    const [one, two] = [await service(), await service()];
    const evidence: unknown[] = [];
    expect(Object.keys(scripts)).toHaveLength(10);
    for (const [id, script] of Object.entries(scripts)) {
      // Fully advance one instance before starting the other; sharing a cursor would exhaust it.
      for (const s of [one, two]) {
        for (const expected of script.responses) {
          const response = await post(endpoint(s, id));
          evidence.push({ url: endpoint(s, id), response });
          exact(response, expected);
          expect(s.requests.at(-1)).toMatchObject({ status: expected.status, outcome: 'served',
            end: expected.status >= 400 ? 'http-error' : 'eof', framesWritten: expected.chunks.length,
            raw: { requestBody: '{ "model":"wp052-model", "stream":true, "messages":[] }',
              responseHeaders: expected.headers, chunks: expected.chunks } });
        }
      }
    }
    expect(one.requests.map(r => [r.scriptId, r.round])).toEqual(two.requests.map(r => [r.scriptId, r.round]));
    expect(one.requests).toHaveLength(11);
    const exhausted = await post(endpoint(one, `${prefix}regrade_same_submission_twice`));
    expect(exhausted.status).toBe(409);
    expect(exhausted.body).toBe('{"error":{"message":"x5 llm service: script qbank.ai_grade.scripted.regrade_same_submission_twice has no response 2","type":"x5_llm_service"}}');
    expect(one.requests.at(-1)).toMatchObject({ round: 2, outcome: 'unscripted-round' });
    expect(await one.whenIdle(1000)).toBe(true);
    expect(await two.whenIdle(1000)).toBe(true);
    const dir = mkdtempSync('/tmp/opencode/x5-wp123-http-');
    writeFileSync(`${dir}/raw.json`, JSON.stringify({ evidence, exhausted, requests: [one.requests, two.requests] }, null, 2));
    console.log(`WP-123 HTTP raw: ${dir}/raw.json`);
  });

  it('bad requests do not consume the sidecar, and stream:false does not rewrite owner bytes', async () => {
    const s = await service();
    const id = `${prefix}correct_verdict`;
    expect((await post(endpoint(s, id), '{')).status).toBe(400);
    expect((await post(endpoint(s, id), '', 'GET')).status).toBe(404);
    expect((await post(endpoint(s, 'unknown'))).status).toBe(404);
    const response = await post(endpoint(s, id), '{"stream":false}');
    exact(response, scripts[id]!.responses[0]!);
    expect(s.requests.at(-1)).toMatchObject({ round: 0, stream: false, outcome: 'served' });
    expect(() => providerScripts({ [id]: [{ status: 200, headers: {}, chunks: [null] }] })).toThrow('invalid response');
    await expect(startLlmService({ extraScripts: { 'success.answer': scripts[id]! } })).rejects.toThrow('shadows a built-in');
  });

  it('client cancellation and service stop release in-flight raw writes and consume only the claimed response', async () => {
    // Transport-only pressure fixture: no extra business script or qbank expected result.
    const chunks = Array.from({ length: 128 }, () => 'x'.repeat(64 * 1024));
    const tail = scripts[`${prefix}empty_body`]!.responses[0]!;
    for (const termination of ['client-closed', 'server-stopped'] as const) {
      const s = await startLlmService({ extraScripts: { pressure: { description: 'transport cleanup',
        responses: [{ status: 200, headers: { 'content-type': 'text/plain' }, chunks }, tail] } } });
      cleanup.push(() => s.stop());
      const req = httpRequest(endpoint(s, 'pressure'), { method: 'POST', agent: false });
      req.on('error', () => {});
      req.end('{}');
      const [response] = await once(req, 'response') as [import('node:http').IncomingMessage];
      response.on('error', () => {});
      // Leave the body paused: writes remain outstanding rather than naturally reaching EOF.
      if (termination === 'client-closed') req.destroy();
      else await s.stop();
      expect(await s.whenIdle(1000)).toBe(true);
      expect(s.openCount()).toBe(0);
      expect(s.requests[0]!.end).toBe(termination);
      expect(s.requests[0]!.framesWritten).toBeLessThan(chunks.length);
      if (termination === 'client-closed') {
        exact(await post(endpoint(s, 'pressure')), tail);
        expect(s.requests[1]!.round).toBe(1);
      } else {
        await expect(post(endpoint(s, 'pressure'))).rejects.toMatchObject({ code: 'ECONNREFUSED' });
      }
      console.log(JSON.stringify({ wp123Cleanup: termination, openCount: s.openCount(),
        requests: s.requests.map(({ raw, ...entry }) => ({ ...entry, rawChunksWritten: raw?.chunks.length })) }));
    }
  });

  it('CLI accepts the unmodified sidecar and releases the port on stdin EOF', async () => {
    const child = spawn(process.execPath, ['host/e2e/streaming/wave0/llm-service.ts', '--provider-script', fileURLToPath(fixture)],
      { stdio: ['pipe', 'pipe', 'pipe'] });
    cleanup.push(async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } });
    let out = '', err = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    for (let i = 0; i < 2000 && !out.includes('\n') && child.exitCode === null; i++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(err).toBe('');
    const started = JSON.parse(out.split('\n')[0]!) as { url: string; scripts: string[] };
    expect(started.scripts.slice(-10)).toEqual(Object.keys(scripts));
    const id = `${prefix}regrade_same_submission_twice`;
    const url = `${started.url}/s/${id}/v1/chat/completions`;
    for (const expected of scripts[id]!.responses) exact(await post(url), expected);
    const exited = once(child, 'exit');
    child.stdin.end();
    expect((await exited)[0]).toBe(0);
    const stopped = JSON.parse(out.trim().split('\n').at(-1)!);
    expect(stopped).toMatchObject({ stopped: true, requests: [{ round: 0, end: 'eof' }, { round: 1, end: 'eof' }] });
    await expect(post(url)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });
});
