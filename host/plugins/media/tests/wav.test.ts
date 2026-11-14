import { expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { encodeWavMono16k, PcmSpoolWriter } from '../src/wav.ts';

it('wav_header_is_valid', () => {
  const wav = Buffer.from(encodeWavMono16k(Int16Array.from([1, -1, 300])));
  expect(wav.subarray(0, 4).toString()).toBe('RIFF');
  expect(wav.subarray(8, 12).toString()).toBe('WAVE');
  expect(wav.readUInt32LE(24)).toBe(16_000);
  expect(wav.readUInt32LE(40)).toBe(6);
  expect(wav.length).toBe(50);
});

it('spool_roundtrip_by_time_range', async () => {
  const host = await createTestHost();
  try {
    const writer = new PcmSpoolWriter(host.app.dataDir);
    const pcm = Int16Array.from({ length: 48_000 }, (_, i) => i % 30_000);
    for (let i = 0; i < pcm.length; i += 1234) writer.write(pcm.subarray(i, i + 1234));
    const spool = writer.finish();
    try {
      expect(spool.samples()).toBe(48_000);
      expect(spool.durationMs()).toBe(3_000);
      const mid = spool.readMs(1_000, 1_500);
      expect(mid.length).toBe(8_000);
      expect(mid[0]).toBe(pcm[16_000]);
      expect(spool.readMs(2_900, 9_000).length).toBe(1_600);
      expect(spool.readMs(5_000, 6_000).length).toBe(0);
    } finally { spool.close(); }
  } finally { await host.dispose(); }
});
