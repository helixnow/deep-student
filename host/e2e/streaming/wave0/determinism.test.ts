import { describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PROBE = './host/e2e/streaming/wave0/__fixtures__/nondeterminism-probe.mjs';
interface ProbeRecord { kind: string; frames: string[] }

/** The service CLI under the probe; returns its URL and a stop() that yields the probe records. */
async function startCli(log: string) {
  const child = spawn(process.execPath, ['--import', PROBE, 'host/e2e/streaming/wave0/llm-service.ts'],
    { cwd: process.cwd(), env: { ...process.env, W0_NONDETERMINISM_LOG: log }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => { out += chunk; });
  for (let i = 0; i < 2000 && !out.includes('\n'); i++) await new Promise(resolve => setTimeout(resolve, 5));
  const url = new URL((JSON.parse(out.split('\n')[0]!) as { url: string }).url);
  return {
    url,
    async stop(): Promise<ProbeRecord[]> {
      child.kill('SIGTERM');
      const [code] = await once(child, 'exit');
      expect(code).toBe(0);
      return JSON.parse(readFileSync(log, 'utf8')) as ProbeRecord[];
    },
  };
}

/** One request on its own connection; the complete response bytes (status line, headers, body). */
function exchange(url: URL, method: string, path: string, type: string, body: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = connect(Number(url.port), url.hostname);
    const chunks: Buffer[] = [];
    socket.on('data', chunk => chunks.push(chunk));
    socket.on('end', () => resolve(Buffer.concat(chunks)));
    socket.on('error', reject);
    socket.end(Buffer.concat([Buffer.from(`${method} ${path} HTTP/1.1\r\nhost: w0\r\ncontent-type: ${type}\r\n`
      + `content-length: ${body.length}\r\nconnection: close\r\n\r\n`), body]));
  });
}

const json = (value: unknown) => Buffer.from(JSON.stringify(value));
const user = (content: string) => ({ role: 'user', content });
const directive = 'W0_DIRECTIVE {"v":1,"rounds":[[{"id":"call_w0","name":"builtin-template_get","arguments":{"templateId":"61b3c4e1","version":1.0}}]],"final":"W0_DONE"}';
const toolCall = { role: 'assistant', content: null, tool_calls: [{ id: 'call_w0', type: 'function', function: { name: 'builtin-template_get', arguments: '{}' } }] };
const wav = Buffer.concat([Buffer.from('RIFF$\u0019\u0000\u0000WAVEfmt ', 'latin1'), Buffer.from([16, 0, 0, 0, 1, 0, 1, 0, 0x80, 0x3e, 0, 0, 0, 0x7d, 0, 0, 2, 0, 16, 0]),
  Buffer.from('data', 'latin1'), Buffer.from([0, 0x19, 0, 0]), Buffer.alloc(6400)]);
const multipart = (fields: Array<[string, string]>, file: Buffer | null) => Buffer.concat([
  ...(file ? [Buffer.from('--w0b\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\nContent-Type: audio/wav\r\n\r\n'), file, Buffer.from('\r\n')] : []),
  ...fields.map(([name, value]) => Buffer.from(`--w0b\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)),
  Buffer.from('--w0b--\r\n')]);
const FORM = 'multipart/form-data; boundary=w0b';

/** Success and failure requests on every route. */
const REQUESTS: Array<[string, string, string, Buffer]> = [
  ['POST', '/s/success.answer/v1/chat/completions', 'application/json', json({ model: 'm', stream: true, messages: [user('q')] })],
  ['POST', '/s/success.thinking/v1/chat/completions', 'application/json', json({ model: 'm', stream: false, messages: [user('q')] })],
  ['POST', '/s/tool.second-round/v1/chat/completions', 'application/json', json({ model: 'm', stream: true, messages: [user('q')],
    tools: [{ type: 'function', function: { name: 'builtin-echo_text', parameters: {} } }] })],
  ['POST', '/s/w0.directive/v1/chat/completions', 'application/json', json({ model: 'm', stream: true, messages: [user(`<user_query>\n${directive}\n</user_query>`)] })],
  ['POST', '/s/w0.directive/v1/chat/completions', 'application/json', json({ model: 'm', stream: true, messages: [user(directive), toolCall, { role: 'tool', tool_call_id: 'call_w0', content: '{}' }] })],
  ['POST', '/s/w0.directive/v1/chat/completions', 'application/json', json({ model: 'm', stream: true, messages: [user('no directive')] })],
  ['POST', '/s/error.http-500/v1/chat/completions', 'application/json', json({ model: 'm', stream: true, messages: [user('q')] })],
  ['POST', '/s/unknown/v1/chat/completions', 'application/json', json({ model: 'm', messages: [] })],
  ['POST', '/s/vfs.x/v1/embeddings', 'application/json', json({ model: 'w0-text-embedding', input: ['导数描述函数的变化率', '光合作用'], encoding_format: 'float' })],
  ['POST', '/s/vfs.x/v1/embeddings', 'application/json', json({ model: 'w0-vl-embedding', input: [{ text: '细胞' }, { image: 'data:image/png;base64,AAAA' }] })],
  ['POST', '/s/error.http-500/v1/embeddings', 'application/json', json({ model: 'w0-text-embedding', input: 'a' })],
  ['POST', '/s/vfs.x/v1/embeddings', 'application/json', json({ model: 'text-embedding-3-small', input: 'a' })],
  ['POST', '/s/success.answer/v1/audio/transcriptions', FORM, multipart([['model', 'whisper-1'], ['language', 'zh']], wav)],
  ['POST', '/s/success.answer/v1/audio/transcriptions', FORM, multipart([['model', 'whisper-1'], ['response_format', 'verbose_json']], wav)],
  ['POST', '/s/error.http-500/v1/audio/transcriptions', FORM, multipart([['model', 'whisper-1']], wav)],
  ['POST', '/s/success.answer/v1/audio/transcriptions', FORM, multipart([['model', 'whisper-1']], null)],
  ['GET', '/s/success.answer/v1/models', 'application/json', Buffer.alloc(0)],
];

describe('WAVE0 LLM service determinism', () => {
  it('the probe sees every clock and randomness API it guards (positive control)', () => {
    const log = join(mkdtempSync(join(tmpdir(), 'w0-probe-')), 'records.json');
    execFileSync(process.execPath, ['--import', PROBE, '--input-type=module', '-e', [
      "import { randomUUID, randomBytes } from 'node:crypto';",
      'Date.now(); new Date(); Date(); Math.random(); performance.now(); process.hrtime(); process.hrtime.bigint();',
      'randomUUID(); randomBytes(1); crypto.getRandomValues(new Uint8Array(1)); new Date(0);',
    ].join('\n')], { env: { ...process.env, W0_NONDETERMINISM_LOG: log } });
    const kinds = new Set((JSON.parse(readFileSync(log, 'utf8')) as ProbeRecord[]).filter(r => r.frames.some(f => f.includes('[eval'))).map(r => r.kind));
    expect([...kinds].sort()).toEqual(['Date()', 'Date.now', 'Math.random', 'crypto.randomBytes', 'crypto.randomUUID', 'new Date()',
      'performance.now', 'process.hrtime', 'process.hrtime.bigint', 'webcrypto.getRandomValues']);
  });

  it('two service processes answer every route byte-identically (status line, headers, body); no service code reads a clock or randomness', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'w0-determinism-'));
    const one = await startCli(join(dir, 'one.json'));
    const two = await startCli(join(dir, 'two.json'));
    const first: Buffer[] = [], again: Buffer[] = [], other: Buffer[] = [];
    for (const [method, path, type, body] of REQUESTS) {
      first.push(await exchange(one.url, method, path, type, body));
      again.push(await exchange(one.url, method, path, type, body));
      other.push(await exchange(two.url, method, path, type, body));
    }
    const statuses = first.map(response => response.toString('latin1').split('\r\n')[0]);
    expect(statuses).toEqual(['HTTP/1.1 200 OK', 'HTTP/1.1 200 OK', 'HTTP/1.1 200 OK', 'HTTP/1.1 200 OK', 'HTTP/1.1 200 OK',
      'HTTP/1.1 400 Bad Request', 'HTTP/1.1 500 Internal Server Error', 'HTTP/1.1 404 Not Found',
      'HTTP/1.1 200 OK', 'HTTP/1.1 200 OK', 'HTTP/1.1 500 Internal Server Error', 'HTTP/1.1 404 Not Found',
      'HTTP/1.1 200 OK', 'HTTP/1.1 200 OK', 'HTTP/1.1 500 Internal Server Error', 'HTTP/1.1 400 Bad Request', 'HTTP/1.1 404 Not Found']);
    for (const [index, response] of first.entries()) {
      expect(again[index]!.equals(response), `${REQUESTS[index]![1]} same process`).toBe(true);
      expect(other[index]!.equals(response), `${REQUESTS[index]![1]} other process`).toBe(true);
      expect(response.toString('latin1').toLowerCase()).not.toContain('\r\ndate:');
    }
    const records = [...await one.stop(), ...await two.stop()];
    const serviceFrame = (frame: string) => (frame.includes('/host/e2e/streaming/wave0/') && !frame.includes('/__fixtures__/'))
      || frame.includes('/host/plugins/llm-providers/src/replay/');
    const fromService = records.filter(record => record.frames.some(serviceFrame));
    expect(fromService).toEqual([]);
  }, 60_000);
});
