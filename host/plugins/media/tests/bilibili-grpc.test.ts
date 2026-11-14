import { expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { decodeGrpcTracks } from '../src/bilibili-grpc.ts';

function varint(value: number): Buffer {
  const bytes: number[] = [];
  let rest = value;
  do {
    let byte = rest & 0x7f;
    rest = Math.trunc(rest / 128);
    if (rest > 0) byte |= 0x80;
    bytes.push(byte);
  } while (rest > 0);
  return Buffer.from(bytes);
}

function field(tag: number, payload: Buffer): Buffer {
  return Buffer.concat([varint((tag << 3) | 2), varint(payload.length), payload]);
}

function varintField(tag: number, value: number): Buffer {
  return Buffer.concat([varint(tag << 3), varint(value)]);
}

function frame(body: Uint8Array, flag: number): Buffer {
  const header = Buffer.alloc(5);
  header[0] = flag;
  header.writeUInt32BE(body.length, 1);
  return Buffer.concat([header, Buffer.from(body)]);
}

it('rejects_truncation_missing_state_flags_and_bad_trailers', () => {
  for (const bytes of [
    Buffer.alloc(0),
    Buffer.alloc(4),
    Buffer.from([0, 0, 0, 0, 2, 0]),
    frame(Buffer.alloc(0), 2),
    frame(Buffer.alloc(0), 0),
    frame(Buffer.from('grpc-status: 7\r\n', 'utf8'), 0x80),
  ]) {
    expect(() => decodeGrpcTracks(bytes, null, null)).toThrow();
  }
  expect(() => decodeGrpcTracks(frame(Buffer.from([0x1a, 0]), 0), null, '7')).toThrow();
  expect(decodeGrpcTracks(frame(Buffer.from([0x1a, 0]), 0), null, '0')).toEqual([]);
});

it('parses_gzip_typed_tracks', () => {
  const track = Buffer.concat([
    field(3, Buffer.from('ai-zh', 'utf8')),
    field(4, Buffer.from('AI', 'utf8')),
    field(5, Buffer.from('https://aisubtitle.hdslb.com/a', 'utf8')),
    varintField(7, 1),
  ]);
  const subtitle = field(3, track);
  const reply = field(3, subtitle);
  const gzip = gzipSync(reply);
  const tracks = decodeGrpcTracks(frame(gzip, 1), 'gzip', null);
  expect(tracks.length).toBe(1);
  expect(tracks[0]!.lan).toBe('ai-zh');
  expect(tracks[0]!.lanDoc).toBe('AI');
  expect(tracks[0]!.url).toBe('https://aisubtitle.hdslb.com/a');
  expect(tracks[0]!.aiMark).toBe(1);
});
