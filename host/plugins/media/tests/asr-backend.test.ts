import { expect, it } from 'vitest';
import { AsrEndpoint, classifyFailure, type AsrHttpError } from '../src/asr.ts';
import { HttpAsrBackend } from '../src/asr-backend.ts';
import { encodeWavMono16k } from '../src/wav.ts';
import type { AsrFetch } from '../src/voice-input.ts';
import { jsonResponder, startServer } from './helpers/http-fixture.ts';

const fetchAsr: AsrFetch = (input, init) => fetch(input, init);

it('sends the official DeepSeek WAV request without OpenAI transcription fields', async () => {
  const wav = new Uint8Array(encodeWavMono16k(new Int16Array(1600)));
  const deepseek = new AsrEndpoint('deepseek', 'DeepSeek', 'https://api.deepseek.com/v1', 'fixture-key', 'deepseek-asr', null);
  const backend = new HttpAsrBackend(deepseek, 'zh', async (url, init) => {
    const request = new Request(url, init);
    expect(request.url).toBe('https://api.deepseek.com/v1/tools/asr');
    expect(request.headers.get('authorization')).toBe('Bearer fixture-key');
    const form = await request.formData();
    expect([...form.keys()]).toEqual(['file']);
    const file = form.get('file') as File;
    expect(file.type).toBe('audio/wav');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(wav);
    return Response.json({ text: '语音识别样本' });
  });
  expect(await backend.transcribe(wav)).toMatchObject({ text: '语音识别样本' });
});

function endpoint(baseUrl: string, apiKey: string, model: string): AsrEndpoint {
  return new AsrEndpoint('siliconflow', 'SiliconFlow', baseUrl, apiKey, model, null);
}

it('http_backend_posts_wav_and_records_bounds', async () => {
  const server = await startServer(jsonResponder(
    { text: '段落', segments: [{ start: 0.2, end: 0.7 }] }));
  try {
    const backend = new HttpAsrBackend(endpoint(`${server.url}/v1`, 'sk-media', 'whisper-1'), null, fetchAsr);
    const result = await backend.transcribe(encodeWavMono16k(new Int16Array(1600)));
    expect(result.text).toBe('段落');
    expect(result.speechBoundsMs).toEqual([200, 700]);

    const request = server.requests[0]!;
    expect(request.url).toBe('/v1/audio/transcriptions');
    expect(request.headers.authorization).toBe('Bearer sk-media');
    expect(request.body).toContain('verbose_json');
    expect(request.body).toContain('whisper-1');
  } finally { await server.close(); }
});

it('http_backend_sends_qwen_flash_segments_as_input_audio', async () => {
  const server = await startServer(jsonResponder(
    { choices: [{ message: { content: '这一段' } }] }));
  try {
    const backend = new HttpAsrBackend(
      endpoint(`${server.url}/compatible-mode/v1`, 'sk-qwen', 'qwen3-asr-flash'), null, fetchAsr);
    const result = await backend.transcribe(encodeWavMono16k(new Int16Array(1600)));
    expect(result.text).toBe('这一段');
    expect(result.speechBoundsMs).toBeNull();

    const request = server.requests[0]!;
    expect(request.url).toBe('/compatible-mode/v1/chat/completions');
    expect(request.headers.authorization).toBe('Bearer sk-qwen');
    expect(request.body).toContain('"data":"data:audio/wav;base64,UklGR');
  } finally { await server.close(); }
});

it('http_backend_downgrades_when_verbose_json_rejected', async () => {
  let seen = 0;
  const server = await startServer((request, response) => {
    if (request.body.includes('verbose_json')) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end('{"error":"unsupported response_format"}');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"text":"ok"}');
    seen += 1;
  });
  try {
    const backend = new HttpAsrBackend(endpoint(`${server.url}/v1`, 'sk', 'whisper-large'), null, fetchAsr);
    const wav = encodeWavMono16k(new Int16Array(160));
    expect((await backend.transcribe(wav)).text).toBe('ok');
    expect((await backend.transcribe(wav)).text).toBe('ok');
    // 第一次带 verbose_json 被拒，之后两次降级为普通 json
    expect(server.requests.filter(request => request.body.includes('verbose_json'))).toHaveLength(1);
    expect(seen).toBe(2);
  } finally { await server.close(); }
});

it('http_backend_surfaces_retry_after', async () => {
  const server = await startServer((_request, response) => {
    response.writeHead(429, { 'retry-after': '7', 'content-type': 'text/plain' });
    response.end('slow down');
  });
  try {
    const backend = new HttpAsrBackend(
      endpoint(`${server.url}/v1`, 'sk', 'Qwen/Qwen3-ASR-1.7B'), null, fetchAsr);
    let failure: AsrHttpError | null = null;
    try { await backend.transcribe(encodeWavMono16k(new Int16Array(160))); }
    catch (error) { failure = error as AsrHttpError; }
    expect(failure).not.toBeNull();
    expect(classifyFailure(failure!)).toEqual({ kind: 'rate_limited', retryAfterSeconds: 7 });
  } finally { await server.close(); }
});
