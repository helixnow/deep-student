import { afterEach, describe, expect, it } from 'vitest';
import { embeddingModels, embeddingResponse, embeddingVector, fnv1a32 } from '../../../plugins/llm-providers/src/replay/embeddings.ts';
import { startLlmService, type LlmService } from './llm-service.ts';

const services: LlmService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.stop())); });
async function service() { const s = await startLlmService(); services.push(s); return s; }

async function post(url: string, payload: unknown) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload) });
  return { status: response.status, type: response.headers.get('content-type'), date: response.headers.get('date'), text: await response.text() };
}

const cosine = (a: number[], b: number[]) => {
  const dot = a.reduce((sum, value, i) => sum + value * b[i]!, 0);
  const norm = (v: number[]) => Math.sqrt(v.reduce((sum, value) => sum + value * value, 0));
  return dot / (norm(a) * norm(b));
};

describe('WAVE0 embeddings: vectors are a pure function of model, input and dimensions', () => {
  it('fnv1a32 matches the reference values and hashes UTF-8 bytes', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(fnv1a32('a')).toBe(0xe40c292c);
    expect(fnv1a32('foobar')).toBe(0xbf9cf968);
    expect(fnv1a32('导')).toBe(fnv1a32('\u5bfc'));
  });

  it('text vectors: native dimension, integer components, never zero, same text → same vector', () => {
    const vector = embeddingVector('导数描述函数的变化率', 768);
    expect(vector).toHaveLength(768);
    expect(vector.every(Number.isInteger)).toBe(true);
    // 1 (w0) + 10 unigrams + 9 bigrams.
    expect(vector.reduce((sum, value) => sum + value, 0)).toBe(20);
    expect(embeddingVector('导数描述函数的变化率', 768)).toEqual(vector);
    expect(embeddingVector('', 768).reduce((sum, value) => sum + value, 0)).toBe(1);
  });

  it('texts sharing characters are closer than unrelated texts (retrieval is lexical, not noise)', () => {
    const note = embeddingVector('导数\n导数描述函数的变化率。求导是微积分的基本运算。', 768);
    expect(cosine(embeddingVector('导数', 768), note)).toBeGreaterThan(cosine(embeddingVector('光合作用', 768), note));
  });

  it('serves the OpenAI list shape; string input = one-item array; key order and whitespace do not matter', async () => {
    const s = await service();
    const url = `${s.baseUrl('vfs.any-scenario-id')}/embeddings`;
    const one = await post(url, { model: 'w0-text-embedding', input: '导数', encoding_format: 'float' });
    expect(one.status).toBe(200);
    expect(one.type).toBe('application/json');
    expect(one.date).toBeNull();
    expect(JSON.parse(one.text)).toEqual({ object: 'list', data: [{ object: 'embedding', index: 0, embedding: embeddingVector('导数', 768) }],
      model: 'w0-text-embedding', usage: { prompt_tokens: 2, total_tokens: 2 } });
    const reordered = await post(url, '{ "input" : ["导数"], "encoding_format":"float", "model":"w0-text-embedding" }');
    expect(reordered.text).toBe(one.text);
    expect(s.requests.map(r => [r.scriptId, r.round, r.stream, r.outcome, r.status, r.end])).toEqual([
      ['vfs.any-scenario-id', null, false, 'served', 200, 'done'], ['vfs.any-scenario-id', null, false, 'served', 200, 'done']]);
  });

  it('multimodal items: text/image/instruction, null = absent, one vector per item in input order', async () => {
    const s = await service();
    const items = [{ text: '细胞', image: null }, { image: 'data:image/png;base64,iVBORw0KGgo=' },
      { text: '图', image: 'data:image/png;base64,AAAA', instruction: '找图' }];
    const served = JSON.parse((await post(`${s.baseUrl('x')}/embeddings`, { model: 'w0-vl-embedding', input: items })).text);
    expect(served.data.map((d: { index: number; embedding: number[] }) => [d.index, d.embedding.length])).toEqual([[0, 1024], [1, 1024], [2, 1024]]);
    expect(served.data[0].embedding).toEqual(embeddingVector('细胞', 1024));
    expect(served.data[1].embedding).toEqual(embeddingVector({ text: null, image: 'data:image/png;base64,iVBORw0KGgo=', instruction: null }, 1024));
    expect(served.usage).toEqual({ prompt_tokens: 2 + 1 + (1 + 1 + 2), total_tokens: 7 });
  });

  it('dimensions shortens the vector; every model in the table answers at its native dimension', () => {
    for (const [model, { dimension }] of Object.entries(embeddingModels)) {
      const result = embeddingResponse({ model, input: ['a'] });
      expect(result.ok && (result.json as { data: Array<{ embedding: number[] }> }).data[0]!.embedding).toHaveLength(dimension);
    }
    const short = embeddingResponse({ model: 'w0-text-embedding', input: 'a', dimensions: 64 });
    expect(short.ok && (short.json as { data: Array<{ embedding: number[] }> }).data[0]!.embedding).toEqual(embeddingVector('a', 64));
  });

  it('refuses malformed requests with explicit 400/404 errors (never a guessed vector)', async () => {
    const s = await service();
    const url = `${s.baseUrl('x')}/embeddings`;
    const cases: Array<[unknown, number, string]> = [
      ['not json', 400, 'bad-json'],
      [[], 400, 'bad-embedding-request'],
      [{ input: 'a' }, 400, 'bad-embedding-request'],
      [{ model: 'text-embedding-3-small', input: 'a' }, 404, 'unknown-embedding-model'],
      [{ model: 'w0-text-embedding', input: [] }, 400, 'bad-embedding-request'],
      [{ model: 'w0-text-embedding', input: [1] }, 400, 'bad-embedding-request'],
      [{ model: 'w0-text-embedding', input: [{ text: 'a', video: 'v' }] }, 400, 'bad-embedding-request'],
      [{ model: 'w0-text-embedding', input: [{ text: 1 }] }, 400, 'bad-embedding-request'],
      [{ model: 'w0-text-embedding', input: 'a', encoding_format: 'base64' }, 400, 'bad-embedding-request'],
      [{ model: 'w0-text-embedding', input: 'a', dimensions: 769 }, 400, 'bad-embedding-request'],
      [{ model: 'w0-text-embedding', input: 'a', dimensions: 1.5 }, 400, 'bad-embedding-request'],
    ];
    for (const [payload, status] of cases) {
      const response = await post(url, payload);
      expect([response.status, JSON.parse(response.text).error.type]).toEqual([status, 'x5_llm_service']);
    }
    expect(s.requests.map(r => r.outcome)).toEqual(cases.map(([, , outcome]) => outcome));
    expect(JSON.parse((await post(url, { model: 'nope', input: 'a' })).text).error.message)
      .toBe('x5 llm service: unknown embedding model nope (known: w0-text-embedding, w0-vl-embedding)');
  });

  it('error script: a rounds script whose round 0 is an HTTP error fails the embedding request with that body', async () => {
    const s = await service();
    const failed = await post(`${s.baseUrl('error.http-500')}/embeddings`, { model: 'w0-text-embedding', input: 'a' });
    expect(failed).toEqual({ status: 500, type: 'application/json', date: null,
      text: '{"error":{"message":"x5 deterministic upstream failure","type":"server_error"}}' });
    expect(s.requests[0]).toMatchObject({ scriptId: 'error.http-500', round: 0, outcome: 'served', status: 500, end: 'http-error' });
    // Other scripts (and unknown ids) do not change the vectors.
    const answer = await post(`${s.baseUrl('success.answer')}/embeddings`, { model: 'w0-text-embedding', input: 'a' });
    expect(answer.text).toBe((await post(`${s.baseUrl('w0.directive')}/embeddings`, { model: 'w0-text-embedding', input: 'a' })).text);
  });
});
