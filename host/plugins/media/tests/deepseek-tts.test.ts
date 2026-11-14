import { expect, it } from 'vitest';
import type { ApiConfig } from '../../llm/api.ts';
import { fromBase64 } from '../../../platform/crypto/encoding.ts';
import { synthesizeDeepseek } from '../src/deepseek-tts.ts';
import { encodeWavMono16k } from '../src/wav.ts';

it('uses the saved DeepSeek model key to request the chosen WAV voice', async () => {
  const wav = new Uint8Array(encodeWavMono16k(new Int16Array(160)));
  const config = { id: 'builtin-deepseek-flash', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'fixture-key' } as ApiConfig;
  const result = await synthesizeDeepseek({ getApiConfigs: async () => [config], decryptApiKey: async key => key },
    async (url, init) => {
      const request = new Request(url, init);
      expect(request.url).toBe('https://api.deepseek.com/v1/tools/tts');
      expect(request.headers.get('authorization')).toBe('Bearer fixture-key');
      expect(await request.json()).toEqual({ text: '你好', voice_id: 'tide', format: 'wav' });
      return new Response(new Uint8Array(wav), { headers: { 'content-type': 'audio/wav' } });
    }, '你好', 'tide');
  expect(fromBase64(result)).toEqual(wav);
});
