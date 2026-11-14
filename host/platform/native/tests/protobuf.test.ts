import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import native from '../index.ts';
import { BiliError, decodeDmViewReply, encodeDmViewRequest } from '../protobuf/index.ts';

function framed(body: Uint8Array, flag: number): Uint8Array {
  const frame = Buffer.alloc(5 + body.length);
  frame[0] = flag;
  frame.writeUInt32BE(body.length, 1);
  frame.set(body, 5);
  return frame;
}

const bytes = (...values: number[]) => Uint8Array.from(values);
const text = (value: string) => Buffer.from(value, 'utf8');

function field(fieldNumber: number, payload: Uint8Array): number[] {
  expect(payload.length).toBeLessThan(128);
  return [(fieldNumber << 3) | 2, payload.length, ...payload];
}

/** prost encoding of the fixed gzip test message. */
function sampleReply(): Uint8Array {
  const track = Buffer.from([
    ...field(3, text('ai-zh')),
    ...field(4, text('AI')),
    ...field(5, text('https://aisubtitle.hdslb.com/a')),
    0x38, 0x01, // ai_mark = 1
  ]);
  const subtitle = Buffer.from(field(3, track));
  return Buffer.from(field(3, subtitle));
}

describe('bilibili gRPC DmView subset', () => {
  it('rejects_truncation_missing_state_flags_and_bad_trailers', () => {
    for (const sample of [
      new Uint8Array(),
      new Uint8Array(4),
      bytes(0, 0, 0, 0, 2, 0),
      framed(new Uint8Array(), 2),
      framed(new Uint8Array(), 0),
      framed(text('grpc-status: 7\r\n'), 0x80),
    ]) {
      expect(() => decodeDmViewReply(sample)).toThrow();
    }
    expect(() => decodeDmViewReply(framed(bytes(0x1a, 0), 0), null, '7')).toThrow();
    expect(decodeDmViewReply(framed(bytes(0x1a, 0), 0), null, '0').subtitle?.tracks).toEqual([]);
  });

  it('parses_gzip_typed_tracks', () => {
    const gzip = gzipSync(sampleReply());
    const reply = decodeDmViewReply(framed(gzip, 1), 'gzip');
    expect(reply.subtitle?.tracks[0]).toEqual({
      lan: 'ai-zh',
      lan_doc: 'AI',
      url: 'https://aisubtitle.hdslb.com/a',
      ai_mark: 1,
      ai_from: 0,
      ai_type: 0,
    });
  });

  it('encodeDmViewRequest matches prost field order and gRPC framing', () => {
    const request = encodeDmViewRequest(1n, 2n);
    const spmid = text('main.ugc-video-detail.0.0');
    const body = bytes(0x08, 0x01, 0x10, 0x02, 0x18, 0x01, 0x22, spmid.length, ...spmid);
    expect(request).toEqual(framed(body, 0));
  });

  it('rejects unknown fields with invalid wire types and empty track keys', () => {
    expect(() => decodeDmViewReply(framed(bytes(0x1a, 0x02, 0x18, 0x00), 0))).toThrow();
    const track = Buffer.from([...field(3, text('ai-zh'))]);
    const reply = Buffer.from(field(3, Buffer.from(field(3, track))));
    expect(() => decodeDmViewReply(framed(reply, 0))).toThrow(BiliError);
  });

  it('is provided by the dstu.native plugin', async () => {
    const host = await createTestHost({ plugins: [native] });
    try {
      expect(host.ctx.nativeProtobuf.encodeDmViewRequest(1n, 2n)).toEqual(encodeDmViewRequest(1n, 2n));
    } finally {
      await host.dispose();
    }
  });
});
