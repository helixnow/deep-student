import { gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import {
  buildDmViewRequest, cuesFromSubtitleJson, decodeDmViewSubtitles, decodeFields,
  defaultSelectedLangs, encodeMessage, fetchBilibiliDmViewSubtitles, fieldBytes,
  fieldVarint, formatVtt, getNumber, getString, parseSubtitleList, parseVtt,
  pickPrimary, sortSubtitleLanguages, unframeGrpc, utf8, readResponseBytesWithLimit, fetchSubtitleCues,
} from '../src/bilibili-dmview-subtitle.ts';
import {
  AudioCorruptFrameError, extractAudioWithCorruptFrameTolerance,
  mergeVadSegments, resampleTo16kS16GlobalGrid, SileroTimeline,
  type AudioTrackSource, type DecodedAudioFrame, type RecoverInfo,
} from '../src/audio-resilience-and-vad.ts';

function frame(message: Uint8Array, gzip = false): Uint8Array {
  const payload = gzip ? gzipSync(message) : message;
  const out = new Uint8Array(5 + payload.length);
  out[0] = gzip ? 1 : 0;
  new DataView(out.buffer).setUint32(1, payload.length, false);
  out.set(payload, 5);
  return out;
}
function subtitle(lan: string, id = '18446744073709551615'): Uint8Array {
  return encodeMessage([
    fieldVarint(1, 18446744073709551615n), fieldBytes(2, utf8(id)),
    fieldBytes(3, utf8(lan)), fieldBytes(4, utf8('中文（自动生成）')),
    fieldBytes(5, utf8('//aisubtitle.hdslb.com/subtitle.json')),
    fieldVarint(7, 1), fieldBytes(8, utf8('中文')), fieldVarint(9, 2),
  ]);
}
const reply = encodeMessage([fieldBytes(3, encodeMessage([
  fieldBytes(3, subtitle('ai-en')), fieldBytes(3, subtitle('ai-zh')),
]))]);

describe('DmView protobuf / gRPC / 字幕', () => {
  it('enforces streamed byte budgets without Content-Length and cancels overflowing downloads', async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(4)); controller.enqueue(new Uint8Array(5)); }, cancel,
    }));
    await expect(readResponseBytesWithLimit(response, 8)).rejects.toThrow('大小超限');
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body!.locked).toBe(false);
    expect(await readResponseBytesWithLimit(new Response(new Uint8Array(8)), 8)).toHaveLength(8);
  });
  it('limits raw gRPC, uncompressed frames and subtitle JSON downloads to 4MiB', async () => {
    const oversized = new Uint8Array(4 * 1024 * 1024 + 1);
    const request = vi.fn<typeof fetch>().mockImplementation(async () => new Response(oversized));
    await expect(fetchBilibiliDmViewSubtitles(request, 1, 2)).rejects.toThrow('大小超限');
    await expect(fetchSubtitleCues(request, 'https://a.test/s')).rejects.toThrow('大小超限');
    await expect(decodeDmViewSubtitles(frame(oversized))).rejects.toThrow('大小超限');
    request.mockResolvedValueOnce(new Response(JSON.stringify({ body: [{ from: 1, to: 2, content: '字幕' }] })));
    expect(await fetchSubtitleCues(request, 'https://a.test/s')).toEqual([{ start: 1, end: 2, text: '字幕' }]);
  });
  it('编码 aid/cid/type/spmid 与大端 gRPC 帧头', () => {
    const request = buildDmViewRequest(123456789, 987654321);
    expect(request[0]).toBe(0);
    expect(new DataView(request.buffer).getUint32(1, false)).toBe(request.length - 5);
    const fields = decodeFields(unframeGrpc(request).message);
    expect(getNumber(fields, 1)).toBe(123456789);
    expect(getNumber(fields, 2)).toBe(987654321);
    expect(getNumber(fields, 3)).toBe(1);
    expect(getString(fields, 4)).toBe('main.ugc-video-detail.0.0');
  });

  it.each([false, true])('正常/gzip 帧解析，保留 id_str（gzip=%s）', async (gzip) => {
    const items = await decodeDmViewSubtitles(frame(reply, gzip));
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ id: '18446744073709551615', aiMark: 1, aiFrom: 2, langSimple: '中文' });
    expect(items[0]?.url).toBe('https://aisubtitle.hdslb.com/subtitle.json');
    expect(sortSubtitleLanguages(items).map((item) => item.lan)).toEqual(['ai-zh', 'ai-en']);
    expect(pickPrimary(items)?.lan).toBe('ai-zh');
    expect(defaultSelectedLangs(items)).toEqual(['ai-zh', 'ai-en']);
    expect(parseSubtitleList(reply)).toEqual(items);
  });

  it('缺少 id_str 不退回失真的数值 id；忽略无 URL 的条目', () => {
    const raw = encodeMessage([fieldVarint(1, 18446744073709551615n), fieldBytes(3, utf8('zh')), fieldBytes(5, utf8('https://a.test/s'))]);
    const message = encodeMessage([fieldBytes(3, encodeMessage([fieldBytes(3, raw), fieldBytes(3, encodeMessage([fieldBytes(3, utf8('en'))]))]))]);
    expect(parseSubtitleList(message)).toMatchObject([{ id: '', lan: 'zh' }]);
  });

  it('拒绝截断帧、无效压缩标记、损坏 protobuf 与超 4MiB 的 gzip', async () => {
    expect(() => unframeGrpc(new Uint8Array(4))).toThrow('过短');
    expect(() => unframeGrpc(frame(reply).subarray(0, 6))).toThrow('不完整');
    const invalid = frame(reply); invalid[0] = 3;
    expect(() => unframeGrpc(invalid)).toThrow('有效');
    expect(() => decodeFields(new Uint8Array([0x80]))).toThrow('中断');
    expect(() => decodeFields(new Uint8Array([0x0a, 3, 0]))).toThrow('不完整');
    await expect(decodeDmViewSubtitles(frame(new Uint8Array(4 * 1024 * 1024 + 1), true))).rejects.toThrow('解压大小超限');
  });

  it('免登录 POST，检查 HTTP / gRPC 错误', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(frame(reply, true))));
    expect(await fetchBilibiliDmViewSubtitles(request, 1, 2)).toHaveLength(2);
    const init = request.mock.calls[0]![1]!;
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/grpc', 'grpc-accept-encoding': 'identity,gzip' });
    expect(init).not.toHaveProperty('credentials');
    request.mockResolvedValueOnce(new Response('', { status: 403 }));
    await expect(fetchBilibiliDmViewSubtitles(request, 1, 2)).rejects.toThrow('HTTP 403');
    request.mockResolvedValueOnce(new Response('', { headers: { 'grpc-status': '7' } }));
    await expect(fetchBilibiliDmViewSubtitles(request, 1, 2)).rejects.toThrow('gRPC 7');
  });

  it('B 站 JSON → 有序 cue → WebVTT，处理毫秒进位及标准 cue 设置', () => {
    const cues = cuesFromSubtitleJson({ body: [
      { from: 61.25, to: 62.5, content: ' Hello\n world ' },
      { from: -1, to: 0, content: '中文' }, { content: ' ' }, null,
    ] });
    expect(cues).toEqual([{ start: 0, end: 1, text: '中文' }, { start: 61.25, end: 62.5, text: 'Hello world' }]);
    expect(parseVtt(formatVtt(cues))).toEqual(cues);
    expect(formatVtt([{ start: 59.9999, end: 60.5, text: '进位' }])).toContain('00:01:00.000');
    expect(parseVtt('WEBVTT\r\n\r\nid\r\n00:01.000 --> 00:02.000 align:start\r\n两行\r\n字幕\r\n')).toEqual([{ start: 1, end: 2, text: '两行\n字幕' }]);
    expect(cuesFromSubtitleJson(null)).toEqual([]);
  });
});

function audioFrame(start: number, end: number, value = 0.5): DecodedAudioFrame {
  return { timestamp: start, sampleRate: 16000, channels: [new Float32Array(Math.round((end - start) * 16000)).fill(value)] };
}
function encodingError(): Error { return Object.assign(new Error('Decoding error.'), { name: 'EncodingError' }); }

describe('PCM 全局网格与坏帧恢复', () => {
  it('235144 帧 × 1024 @44.1kHz：91 分钟不累计漂移，旧 floor 丢失 >7 秒', () => {
    const count = 235144, samples = 1024, rate = 44100;
    const channels = [new Float32Array(samples)];
    let total = 0;
    for (let i = 0; i < count; i++) total += resampleTo16kS16GlobalGrid(channels, rate, i * samples / rate).length;
    const realSeconds = count * samples / rate;
    expect(Math.abs(total / 16000 - realSeconds)).toBeLessThan(0.01);
    expect(realSeconds - count * Math.floor(samples / rate * 16000) / 16000).toBeGreaterThan(7);
  });

  it('绝对网格区间、线性插值、混音和 s16 截幅', () => {
    const start = 0.00001;
    const pcm = resampleTo16kS16GlobalGrid([new Float32Array([0, 1, -1, 2])], 16000, start);
    expect(pcm.length).toBe(Math.ceil((start + 4 / 16000) * 16000) - Math.ceil(start * 16000));
    expect(pcm[0]).toBe(Math.trunc(0.84 * 32767));
    expect(resampleTo16kS16GlobalGrid([new Float32Array([2, -2])], 16000, 0)).toEqual(new Int16Array([32767, -32768]));
    expect(resampleTo16kS16GlobalGrid([new Float32Array([1]), new Float32Array([-1])], 16000, 0)[0]).toBe(0);
  });

  it('30.0s / 584.47s 坏帧各跳 0.05s，补零精确且 recoveries=2', async () => {
    const starts: number[] = [], recoveries: RecoverInfo[] = [];
    const source: AudioTrackSource = {
      async *samples(start) {
        starts.push(start);
        if (start === 0) { yield audioFrame(0, 30); throw encodingError(); }
        if (start < 584.47) { yield audioFrame(start, 584.47); throw encodingError(); }
        yield audioFrame(start, 585);
      },
    };
    const progress = vi.fn();
    const result = await extractAudioWithCorruptFrameTolerance(source, { duration: 585, onRecover: (info) => recoveries.push(info), onProgress: progress });
    expect(starts).toHaveLength(3);
    expect(starts[0]).toBe(0);
    expect(starts[1]).toBeCloseTo(30.05, 10);
    expect(starts[2]).toBeCloseTo(584.52, 10);
    expect(recoveries.map((info) => info.seconds)).toEqual([0.05, 0.05]);
    expect(result.recoveries).toBe(2);
    expect(result.pcm.length).toBe(585 * 16000);
    expect(result.skipped * 16000).toBe(1600);
    for (const at of [30, 584.47]) {
      const begin = Math.ceil(at * 16000), end = Math.ceil((at + 0.05) * 16000);
      expect(result.pcm.slice(begin, end).every((sample) => sample === 0)).toBe(true);
      expect(result.pcm[begin - 1]).toBeGreaterThan(0);
      expect(result.pcm[end]).toBeGreaterThan(0);
    }
    expect(progress).toHaveBeenLastCalledWith(1);
  });

  it('连续无进展按阶梯尝试，超过 7 次抛中文 AudioCorruptFrameError', async () => {
    const starts: number[] = [];
    const source: AudioTrackSource = { async *samples(start) { starts.push(start); throw encodingError(); } };
    await expect(extractAudioWithCorruptFrameTolerance(source)).rejects.toMatchObject({ name: 'AudioCorruptFrameError', recoveries: 7, at: 0 });
    expect(starts).toEqual([0, 0.05, 0.2, 0.5, 1, 2, 5, 10]);
  });

  it('总恢复上限 24、累计补零上限 30s；业务错误不重试', async () => {
    const source: AudioTrackSource = { async *samples(start) { yield audioFrame(start, start + 0.01); throw encodingError(); } };
    await expect(extractAudioWithCorruptFrameTolerance(source)).rejects.toMatchObject({ name: 'AudioCorruptFrameError', recoveries: 24 });
    const silence: AudioTrackSource = { async *samples() { yield audioFrame(31, 32); } };
    await expect(extractAudioWithCorruptFrameTolerance(silence)).rejects.toThrow(AudioCorruptFrameError);
    const error = new Error('网络不可用');
    const samples = vi.fn(async function* () { throw error; });
    await expect(extractAudioWithCorruptFrameTolerance({ samples })).rejects.toBe(error);
    expect(samples).toHaveBeenCalledTimes(1);
  });

  it('seek 重叠帧裁剪、帧资源释放、非整格间隙补零', async () => {
    const close = vi.fn();
    const result = await extractAudioWithCorruptFrameTolerance({ async *samples() {
      yield { ...audioFrame(0, 0.1), close };
      yield { ...audioFrame(0.05, 0.15), close };
      yield { ...audioFrame(0.20001, 0.30001), close };
    } });
    expect(result.pcm.length).toBe(Math.ceil(0.30001 * 16000));
    expect(result.skipped * 16000).toBe(Math.ceil(0.20001 * 16000) - Math.ceil((0.05 + 1600 / 16000) * 16000));
    expect(close).toHaveBeenCalledTimes(3);
  });
});

describe('Silero 时间轴', () => {
  it('96ms/frame，200ms 最小语音至少三帧，300ms redemption 至少四帧', () => {
    const vad = new SileroTimeline();
    for (const probability of [0, 0.5, 0, 0, 0, 0, 0.5, 0.5, 0.27, 0, 0, 0]) vad.accept(probability);
    expect(vad.finish()).toEqual([]);
    const valid = new SileroTimeline();
    [0.5, 0.5, 0.5, 0, 0, 0].forEach(p => valid.accept(p));
    expect(valid.ranges).toEqual([]);
    valid.accept(0);
    expect(valid.ranges).toEqual([{ start: 0, end: 7 * 0.096 }]);
    expect(valid.finish()).toHaveLength(1);
  });
  it('语音尾段在 finish 截止；相邻小于 .4s 且跨度 <=8s 合并', () => {
    const vad = new SileroTimeline();
    [0.5, 0.5, 0, 0, 0, 0.5, 0.5].forEach((p) => vad.accept(p));
    expect(vad.finish()).toEqual([{ start: 0, end: 7 * 0.096 }]);
    const raw = [{ start: 0, end: 3 }, { start: 3.3, end: 7.9 }, { start: 8, end: 8.3 }];
    expect(mergeVadSegments(raw)).toEqual([{ start: 0, end: 7.9 }, { start: 8, end: 8.3 }]);
    expect(raw[0]?.end).toBe(3);
    expect(mergeVadSegments([{ start: 0, end: 1 }, { start: 1.5, end: 1.8 }])).toEqual([{ start: 0, end: 1.8 }]);
  });
});
