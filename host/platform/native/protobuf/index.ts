/**
 * Minimal prost-compatible codec for the Bilibili DmView subset.
 * Field numbers, merge rules and gRPC frame errors follow
 * `dstu-media/src/media/bilibili_transport/grpc.rs`.
 */
import { crc32, inflateRawSync } from 'node:zlib';
import type { NativeProtobuf, SubtitleTrack } from './api.ts';

const API_LIMIT = 2 * 1024 * 1024;
const SPMID = 'main.ugc-video-detail.0.0';

export class BiliError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'BiliError';
    this.code = code;
  }
}

const invalid = () => new BiliError('subtitle-protocol', 'B 站字幕协议响应无效');
const grpcError = () => new BiliError('grpc-status', 'B 站字幕接口返回 gRPC 错误');

function encodeVarint(value: bigint): number[] {
  const bytes: number[] = [];
  let remaining = BigInt.asUintN(64, value);
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining !== 0n) byte |= 0x80;
    bytes.push(byte);
  } while (remaining !== 0n);
  return bytes;
}

function encodeVarintField(field: number, value: bigint): number[] {
  if (value === 0n) return [];
  return [...encodeVarint(BigInt(field << 3)), ...encodeVarint(value)];
}

function encodeStringField(field: number, value: string): number[] {
  if (value.length === 0) return [];
  const bytes = Buffer.from(value, 'utf8');
  return [...encodeVarint(BigInt((field << 3) | 2)), ...encodeVarint(BigInt(bytes.length)), ...bytes];
}

/** `grpc.rs::request`: a single data frame with the fixed DmView fields. */
export function encodeDmViewRequest(aid: bigint, cid: bigint): Uint8Array {
  const body = [
    ...encodeVarintField(1, aid),
    ...encodeVarintField(2, cid),
    ...encodeVarintField(3, 1n),
    ...encodeStringField(4, SPMID),
  ];
  const frame = Buffer.alloc(5 + body.length);
  frame[0] = 0;
  frame.writeUInt32BE(body.length, 1);
  frame.set(body, 5);
  return frame;
}

function readVarint(bytes: Uint8Array, start: number): [bigint, number] {
  let value = 0n;
  let offset = start;
  for (let index = 0; index < 10; index++) {
    if (offset >= bytes.length) throw invalid();
    const byte = bytes[offset++]!;
    value |= BigInt(byte & 0x7f) << BigInt(index * 7);
    if ((byte & 0x80) === 0) return [BigInt.asUintN(64, value), offset];
  }
  throw invalid();
}

function readLengthDelimited(bytes: Uint8Array, start: number): [Uint8Array, number] {
  const [length, afterLength] = readVarint(bytes, start);
  if (length > BigInt(bytes.length)) throw invalid();
  const end = afterLength + Number(length);
  if (end > bytes.length) throw invalid();
  return [bytes.subarray(afterLength, end), end];
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw invalid();
  }
}

function int32(value: bigint): number {
  return Number(BigInt.asIntN(32, value));
}

/** Skips an unknown field; groups recurse until their matching end tag. */
function skipField(bytes: Uint8Array, start: number, field: number, wire: number, depth = 0): number {
  if (depth > 64) throw invalid();
  switch (wire) {
    case 0: return readVarint(bytes, start)[1];
    case 1: {
      if (start + 8 > bytes.length) throw invalid();
      return start + 8;
    }
    case 2: return readLengthDelimited(bytes, start)[1];
    case 5: {
      if (start + 4 > bytes.length) throw invalid();
      return start + 4;
    }
    case 3: {
      let offset = start;
      while (offset < bytes.length) {
        const [key, afterKey] = readVarint(bytes, offset);
        const innerField = Number(key >> 3n);
        const innerWire = Number(key & 7n);
        offset = afterKey;
        if (innerWire === 4) {
          if (innerField !== field) throw invalid();
          return offset;
        }
        offset = skipField(bytes, offset, innerField, innerWire, depth + 1);
      }
      throw invalid();
    }
    default: throw invalid();
  }
}

function decodeTrack(data: Uint8Array): SubtitleTrack {
  const track: SubtitleTrack = { lan: '', lan_doc: '', url: '', ai_mark: 0, ai_from: 0, ai_type: 0 };
  let offset = 0;
  while (offset < data.length) {
    const [key, afterKey] = readVarint(data, offset);
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    offset = afterKey;
    switch (field) {
      case 3: case 4: case 5: {
        if (wire !== 2) throw invalid();
        const [value, next] = readLengthDelimited(data, offset);
        track[field === 3 ? 'lan' : field === 4 ? 'lan_doc' : 'url'] = decodeUtf8(value);
        offset = next;
        break;
      }
      case 7: case 9: case 10: {
        if (wire !== 0) throw invalid();
        const [value, next] = readVarint(data, offset);
        track[field === 7 ? 'ai_mark' : field === 9 ? 'ai_from' : 'ai_type'] = int32(value);
        offset = next;
        break;
      }
      default: offset = skipField(data, offset, field, wire);
    }
  }
  return track;
}

function mergeTracks(target: SubtitleTrack[], data: Uint8Array): void {
  let offset = 0;
  while (offset < data.length) {
    const [key, afterKey] = readVarint(data, offset);
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    offset = afterKey;
    if (field === 3) {
      if (wire !== 2) throw invalid();
      const [value, next] = readLengthDelimited(data, offset);
      target.push(decodeTrack(value));
      offset = next;
    } else {
      offset = skipField(data, offset, field, wire);
    }
  }
}

function decodeDmViewReplyBody(data: Uint8Array): SubtitleTrack[] | null {
  let subtitle: SubtitleTrack[] | null = null;
  let offset = 0;
  while (offset < data.length) {
    const [key, afterKey] = readVarint(data, offset);
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    offset = afterKey;
    if (field === 3) {
      if (wire !== 2) throw invalid();
      const [value, next] = readLengthDelimited(data, offset);
      subtitle ??= [];
      mergeTracks(subtitle, value);
      offset = next;
    } else {
      offset = skipField(data, offset, field, wire);
    }
  }
  return subtitle;
}

/** flate2::read::GzDecoder semantics for one member: header, raw inflate, CRC/ISIZE. */
function decodeGzip(bytes: Uint8Array, maximum: number): Uint8Array {
  if (bytes.length < 10 || bytes[0] !== 0x1f || bytes[1] !== 0x8b || bytes[2] !== 8 || (bytes[3]! & 0xe0)) throw invalid();
  const flags = bytes[3]!;
  let offset = 10;
  if (flags & 4) {
    if (offset + 2 > bytes.length) throw invalid();
    const length = (bytes[offset]! | (bytes[offset + 1]! << 8));
    offset += 2 + length;
  }
  for (const flag of [8, 16]) {
    if (flags & flag) {
      const end = bytes.indexOf(0, offset);
      if (end === -1) throw invalid();
      offset = end + 1;
    }
  }
  if (flags & 2) {
    if (offset + 2 > bytes.length || (crc32(bytes.subarray(0, offset)) & 0xffff) !== (bytes[offset]! | (bytes[offset + 1]! << 8))) throw invalid();
    offset += 2;
  }
  if (offset > bytes.length) throw invalid();
  let output: Buffer;
  try {
    output = inflateRawSync(bytes.subarray(offset), { maxOutputLength: maximum });
  } catch (error) {
    if ((error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') {
      throw new BiliError('response-too-large', '字幕解压后超过大小限制');
    }
    throw invalid();
  }
  const trailer = bytes.length - 8;
  if (trailer < offset) throw invalid();
  const expectedCrc = ((bytes[trailer]! | (bytes[trailer + 1]! << 8) | (bytes[trailer + 2]! << 16) | (bytes[trailer + 3]! << 24)) >>> 0);
  const expectedSize = ((bytes[trailer + 4]! | (bytes[trailer + 5]! << 8) | (bytes[trailer + 6]! << 16) | (bytes[trailer + 7]! << 24)) >>> 0);
  if (crc32(output) !== expectedCrc || (output.length >>> 0) !== expectedSize) throw invalid();
  return output;
}

/** `grpc.rs::decode`; `encoding`/`status` mirror the HTTP headers Rust receives. */
export function decodeDmViewReply(
  bytes: Uint8Array, encoding: string | null = null, status: string | null = null,
): { subtitle: { tracks: SubtitleTrack[] } | null } {
  if (status !== null && status !== '0') throw grpcError();
  if (bytes.length > API_LIMIT || bytes.length < 5) throw invalid();
  let cursor = 0;
  let message: SubtitleTrack[] | null = null;
  let messageSeen = false;
  let trailerSeen = false;
  while (cursor < bytes.length) {
    if (cursor + 5 > bytes.length) throw invalid();
    const flag = bytes[cursor]!;
    const length = ((bytes[cursor + 1]! << 24) | (bytes[cursor + 2]! << 16) | (bytes[cursor + 3]! << 8) | bytes[cursor + 4]!) >>> 0;
    if (length > API_LIMIT) throw invalid();
    cursor += 5;
    if (cursor + length > bytes.length) throw invalid();
    const data = bytes.subarray(cursor, cursor + length);
    cursor += length;
    if (flag === 0x80) {
      if (trailerSeen) throw invalid();
      trailerSeen = true;
      let trailers: string;
      try {
        trailers = new TextDecoder('utf-8', { fatal: true }).decode(data);
      } catch {
        throw invalid();
      }
      const statuses = trailers.split('\n')
        .map(line => {
          const colon = line.indexOf(':');
          return colon === -1 ? null : [line.slice(0, colon), line.slice(colon + 1).trim()] as const;
        })
        .filter((entry): entry is readonly [string, string] => entry !== null)
        .filter(([key]) => key.toLowerCase() === 'grpc-status')
        .map(([, value]) => value);
      if (statuses.length !== 1 || statuses[0] !== '0') throw grpcError();
      continue;
    }
    if (messageSeen || trailerSeen) throw invalid();
    let payload: Uint8Array;
    if (flag === 0) payload = data;
    else if (flag === 1 && encoding === 'gzip') {
      try {
        payload = decodeGzip(data, API_LIMIT + 1);
      } catch (error) {
        if (error instanceof BiliError) throw error;
        throw invalid();
      }
      if (payload.length > API_LIMIT) throw new BiliError('response-too-large', '字幕解压后超过大小限制');
    } else throw invalid();
    message = decodeDmViewReplyBody(payload);
    messageSeen = true;
  }
  if (!messageSeen) throw invalid();
  if (message === null) {
    throw new BiliError('subtitle-protocol', '字幕响应缺少状态，无法确认是否无字幕');
  }
  if (message.some(track => track.lan.trim() === '' || track.url.trim() === '')) throw invalid();
  return { subtitle: { tracks: message } };
}

export const protobuf: NativeProtobuf = {
  encodeDmViewRequest,
  decodeDmViewReply,
};
