import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { providerScripts, startLlmService, type LlmService } from './llm-service.ts';
import { parseMultipart, wavDurationMs } from '../../../plugins/llm-providers/src/replay/transcriptions.ts';

const services: LlmService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.stop())); });
async function service(extraScripts = {}) { const s = await startLlmService({ extraScripts }); services.push(s); return s; }

/** 16 kHz mono 16-bit PCM WAV with `ms` of silence. */
function wav(ms: number): Buffer {
  const data = Buffer.alloc((32_000 * ms) / 1000);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1'); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8, 'latin1');
  header.write('fmt ', 12, 'latin1'); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16_000, 24); header.writeUInt32LE(32_000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1'); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** What undici (B: voice-input.ts / asr.ts FormData) puts on the wire. */
async function undiciForm(fields: Record<string, string>, file: Buffer, filename = 'voice-input.wav') {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(file)], { type: 'audio/wav' }), filename);
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  const encoded = new Response(form);
  return { contentType: encoded.headers.get('content-type')!, body: Buffer.from(await encoded.arrayBuffer()) };
}

/** reqwest multipart (A): `--boundary\r\n` parts, file part before the model in the connection probe. */
function reqwestForm(boundary: string, parts: Array<{ name: string; value: string | Buffer; filename?: string; type?: string }>) {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const disposition = `form-data; name="${part.name}"${part.filename ? `; filename="${part.filename}"` : ''}`;
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: ${disposition}\r\n${part.type ? `Content-Type: ${part.type}\r\n` : ''}\r\n`));
    chunks.push(Buffer.isBuffer(part.value) ? part.value : Buffer.from(part.value));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { contentType: `multipart/form-data; boundary=${boundary}`, body: Buffer.concat(chunks) };
}

async function post(url: string, form: { contentType: string; body: Buffer }) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': form.contentType }, body: new Uint8Array(form.body) });
  return { status: response.status, type: response.headers.get('content-type'), date: response.headers.get('date'), text: await response.text() };
}

const audio = wav(300);
const sha256 = createHash('sha256').update(audio).digest('hex');

describe('WAVE0 multipart parser', () => {
  it('reads undici FormData parts byte for byte', async () => {
    const form = await undiciForm({ model: 'FunAudioLLM/SenseVoiceSmall', language: 'zh' }, audio);
    const parsed = parseMultipart(form.contentType, form.body);
    expect(parsed.ok && parsed.parts.map(p => [p.name, p.filename, p.contentType, p.data.length])).toEqual([
      ['file', 'voice-input.wav', 'audio/wav', audio.length], ['model', null, null, 27], ['language', null, null, 2]]);
    expect(parsed.ok && Buffer.from(parsed.parts[0]!.data).equals(audio)).toBe(true);
  });

  it('accepts a quoted boundary, preamble and epilogue; rejects a body that is not multipart/form-data', () => {
    const inner = reqwestForm('b-1', [{ name: 'model', value: 'm' }]);
    const framed = Buffer.concat([Buffer.from('preamble\r\n'), inner.body, Buffer.from('epilogue')]);
    const parsed = parseMultipart('multipart/form-data; boundary="b-1"', framed);
    expect(parsed.ok && parsed.parts.map(p => [p.name, Buffer.from(p.data).toString()])).toEqual([['model', 'm']]);
    expect(parseMultipart('application/json', inner.body)).toMatchObject({ ok: false });
    expect(parseMultipart('multipart/form-data', inner.body)).toMatchObject({ ok: false, message: 'multipart content-type has no boundary' });
    expect(parseMultipart(inner.contentType, inner.body.subarray(0, inner.body.length - 8))).toMatchObject({ ok: false });
    expect(parseMultipart('multipart/form-data; boundary=x', Buffer.from('--x\r\nContent-Disposition: form-data\r\n\r\nv\r\n--x--')))
      .toMatchObject({ ok: false, message: 'part 0: Content-Disposition has no name' });
  });

  it('WAV duration comes from the data chunk and byte rate; other bytes have none', () => {
    expect(wavDurationMs(audio)).toBe(300);
    expect(wavDurationMs(wav(1250))).toBe(1250);
    expect(wavDurationMs(Buffer.from('OggS not a wav'))).toBeNull();
  });
});

describe('WAVE0 /audio/transcriptions', () => {
  it('json (default): the script text; the response does not depend on boundary or part order', async () => {
    const s = await service();
    const url = `${s.baseUrl('success.answer')}/audio/transcriptions`;
    const fromUndici = await post(url, await undiciForm({ model: 'whisper-1', language: 'zh' }, audio));
    expect(fromUndici).toEqual({ status: 200, type: 'application/json', date: null, text: '{"text":"固定回答"}' });
    const fromReqwest = await post(url, reqwestForm('3f2a-reqwest', [
      { name: 'file', value: audio, filename: 'voice-input.wav', type: 'audio/wav' }, { name: 'language', value: 'zh' }, { name: 'model', value: 'whisper-1' }]));
    expect(fromReqwest).toEqual(fromUndici);
    expect(s.requests[0]).toEqual({ seq: 0, method: 'POST', path: '/s/success.answer/v1/audio/transcriptions', scriptId: 'success.answer',
      round: 0, stream: false, outcome: 'served', status: 200, framesWritten: 0, end: 'done', body: { parts: [
        { name: 'file', filename: 'voice-input.wav', contentType: 'audio/wav', size: audio.length, sha256 },
        { name: 'model', value: 'whisper-1' }, { name: 'language', value: 'zh' }] } });
  });

  it('text and verbose_json formats; verbose_json reports the WAV duration and one segment', async () => {
    const s = await service();
    const url = `${s.baseUrl('success.answer')}/audio/transcriptions`;
    expect(await post(url, await undiciForm({ model: 'whisper-1', response_format: 'text' }, audio)))
      .toEqual({ status: 200, type: 'text/plain; charset=utf-8', date: null, text: '固定回答' });
    const verbose = await post(url, await undiciForm({ model: 'whisper-1', response_format: 'verbose_json', language: 'zh' }, audio));
    expect(verbose.text).toBe('{"task":"transcribe","language":"zh","duration":0.3,"text":"固定回答","segments":[{"id":0,"seek":0,"start":0,"end":0.3,"text":"固定回答"}]}');
    const opaque = await post(url, await undiciForm({ model: 'whisper-1', response_format: 'verbose_json' }, Buffer.from('webm bytes'), 'a.webm'));
    expect(JSON.parse(opaque.text)).toEqual({ task: 'transcribe', language: 'unknown', duration: null, text: '固定回答', segments: [] });
  });

  it('error and empty scripts: error.http-500 returns its body; success.empty an empty text', async () => {
    const s = await service();
    const form = await undiciForm({ model: 'whisper-1' }, audio);
    expect(await post(`${s.baseUrl('error.http-500')}/audio/transcriptions`, form)).toEqual({ status: 500, type: 'application/json', date: null,
      text: '{"error":{"message":"x5 deterministic upstream failure","type":"server_error"}}' });
    expect((await post(`${s.baseUrl('success.empty')}/audio/transcriptions`, form)).text).toBe('{"text":""}');
    expect(s.requests.map(r => [r.scriptId, r.outcome, r.status, r.end])).toEqual([
      ['error.http-500', 'served', 500, 'http-error'], ['success.empty', 'served', 200, 'done']]);
  });

  it('a provider sidecar answers with its literal response, like chat requests', async () => {
    const s = await service(providerScripts({ 'asr.literal': [{ status: 200, headers: { 'content-type': 'application/json' }, chunks: ['{"text":"逐字"}'] }] }));
    const served = await post(`${s.baseUrl('asr.literal')}/audio/transcriptions`, await undiciForm({ model: 'whisper-1' }, audio));
    expect([served.status, served.text]).toEqual([200, '{"text":"逐字"}']);
    expect(s.requests[0]).toMatchObject({ round: 0, outcome: 'served', end: 'eof', raw: { chunks: ['{"text":"逐字"}'] } });
  });

  it('refuses what it cannot answer with explicit errors; unsupported response_format names the field (A retries without it)', async () => {
    const s = await service();
    const url = (script: string) => `${s.baseUrl(script)}/audio/transcriptions`;
    const statuses = [
      await post(url('success.answer'), { contentType: 'application/json', body: Buffer.from('{}') }),
      await post(url('success.answer'), await undiciForm({ model: 'whisper-1', response_format: 'srt' }, audio)),
      await post(url('success.answer'), reqwestForm('b', [{ name: 'model', value: 'whisper-1' }])),
      await post(url('success.answer'), reqwestForm('b', [{ name: 'file', value: audio, filename: 'a.wav' }])),
      await post(url('success.answer'), reqwestForm('b', [{ name: 'file', value: audio, filename: 'a.wav' }, { name: 'model', value: 'a' }, { name: 'model', value: 'b' }])),
      await post(url('nope'), await undiciForm({ model: 'whisper-1' }, audio)),
      await post(url('w0.directive'), await undiciForm({ model: 'whisper-1' }, audio)),
    ].map(r => r.status);
    expect(statuses).toEqual([400, 400, 400, 400, 400, 404, 409]);
    expect(s.requests.map(r => r.outcome)).toEqual(['bad-multipart', 'unsupported-response-format', 'bad-transcription-request',
      'bad-transcription-request', 'bad-transcription-request', 'unknown-script', 'unscripted-route']);
    expect((s.requests[1]!.body as { parts: unknown[] }).parts).toHaveLength(3);
    expect(s.requests[0]!.body).toBe('{}');
    const srt = await post(url('success.answer'), await undiciForm({ model: 'whisper-1', response_format: 'srt' }, audio));
    expect(JSON.parse(srt.text).error.message).toContain('response_format');
  });
});
