/**
 * `dstu-media/src/media/bilibili_transport/grpc.rs`: minimal typed DmView
 * subset over gRPC-Web framing (protobuf + optional gzip), used to read
 * subtitle tracks without DASH. Unknown protobuf fields are skipped like prost.
 */
import { gunzipSync } from 'node:zlib';
import { BiliRequestError } from './bilibili-policy.ts';

export const API_LIMIT = 2 * 1024 * 1024;

export interface BiliGrpcTrack {
  lan: string;
  lanDoc: string;
  url: string;
  aiMark: number;
  aiFrom: number;
  aiType: number;
}

function invalid(): never {
  throw new BiliRequestError('subtitle-protocol', 'B 站字幕协议响应无效');
}

function readVarint(data: Uint8Array, start: number): [bigint, number] {
  let value = 0n;
  let shift = 0n;
  let pos = start;
  for (;;) {
    if (pos >= data.length || shift > 63n) invalid();
    const byte = data[pos]!;
    pos += 1;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [value, pos];
    shift += 7n;
  }
}

function readLength(data: Uint8Array, pos: number): [number, number] {
  const [value, next] = readVarint(data, pos);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) invalid();
  return [Number(value), next];
}

function readString(data: Uint8Array, pos: number, length: number): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(pos, pos + length)); }
  catch { invalid(); }
}

function int32(value: bigint): number {
  return Number(BigInt.asIntN(32, value));
}

function skipField(wire: number, data: Uint8Array, pos: number): number {
  if (wire === 0) return readVarint(data, pos)[1];
  if (wire === 1) return pos + 8;
  if (wire === 5) return pos + 4;
  return invalid();
}

function decodeTrack(data: Uint8Array): BiliGrpcTrack {
  const track: BiliGrpcTrack = { lan: '', lanDoc: '', url: '', aiMark: 0, aiFrom: 0, aiType: 0 };
  let pos = 0;
  while (pos < data.length) {
    const [key, afterKey] = readVarint(data, pos);
    pos = afterKey;
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (wire === 2) {
      const [length, afterLength] = readLength(data, pos);
      if (afterLength + length > data.length) invalid();
      if (field === 3) track.lan = readString(data, afterLength, length);
      else if (field === 4) track.lanDoc = readString(data, afterLength, length);
      else if (field === 5) track.url = readString(data, afterLength, length);
      pos = afterLength + length;
    } else if (wire === 0) {
      const [value, next] = readVarint(data, pos);
      pos = next;
      if (field === 7) track.aiMark = int32(value);
      else if (field === 9) track.aiFrom = int32(value);
      else if (field === 10) track.aiType = int32(value);
    } else {
      pos = skipField(wire, data, pos);
    }
    if (pos > data.length) invalid();
  }
  return track;
}

function decodeSubtitle(data: Uint8Array): BiliGrpcTrack[] {
  const tracks: BiliGrpcTrack[] = [];
  let pos = 0;
  while (pos < data.length) {
    const [key, afterKey] = readVarint(data, pos);
    pos = afterKey;
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (wire === 2) {
      const [length, afterLength] = readLength(data, pos);
      if (afterLength + length > data.length) invalid();
      if (field === 3) tracks.push(decodeTrack(data.subarray(afterLength, afterLength + length)));
      pos = afterLength + length;
    } else {
      pos = skipField(wire, data, pos);
    }
    if (pos > data.length) invalid();
  }
  return tracks;
}

function decodeReply(data: Uint8Array): BiliGrpcTrack[] | null {
  let subtitle: BiliGrpcTrack[] | null = null;
  let pos = 0;
  while (pos < data.length) {
    const [key, afterKey] = readVarint(data, pos);
    pos = afterKey;
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (wire === 2) {
      const [length, afterLength] = readLength(data, pos);
      if (afterLength + length > data.length) invalid();
      if (field === 3) subtitle = decodeSubtitle(data.subarray(afterLength, afterLength + length));
      pos = afterLength + length;
    } else {
      pos = skipField(wire, data, pos);
    }
    if (pos > data.length) invalid();
  }
  return subtitle;
}

function protocolError(message: string): BiliRequestError {
  return new BiliRequestError('subtitle-protocol', message);
}

function gzipPayload(data: Uint8Array): Uint8Array {
  try {
    return gunzipSync(data, { maxOutputLength: API_LIMIT + 1 });
  } catch (error) {
    if ((error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') {
      throw new BiliRequestError('response-too-large', '字幕解压后超过大小限制');
    }
    throw protocolError('B 站字幕协议响应无效');
  }
}

function trailerStatuses(data: Uint8Array): string[] {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(data); }
  catch { invalid(); }
  const statuses: string[] = [];
  for (const line of text.split('\n')) {
    const clean = line.endsWith('\r') ? line.slice(0, -1) : line;
    const colon = clean.indexOf(':');
    if (colon < 0) continue;
    const key = clean.slice(0, colon);
    if (key.replace(/[A-Z]/g, c => c.toLowerCase()) !== 'grpc-status') continue;
    statuses.push(clean.slice(colon + 1).trim());
  }
  return statuses;
}

function varint(value: bigint): number[] {
  const bytes: number[] = [];
  let rest = value;
  while (rest >= 0x80n) {
    bytes.push(Number(rest & 0x7fn) | 0x80);
    rest >>= 7n;
  }
  bytes.push(Number(rest));
  return bytes;
}

function lengthDelimited(tag: number, data: Uint8Array): number[] {
  return [...varint(BigInt((tag << 3) | 2)), ...varint(BigInt(data.length)), ...data];
}

/** `grpc::request`：DmViewRequest（aid/cid/kind=1/spmid）+ 5 字节 gRPC-Web 头。 */
export function encodeGrpcRequest(aid: number, cid: number): Uint8Array {
  const spmid = new TextEncoder().encode('main.ugc-video-detail.0.0');
  const payload = [
    ...varint(BigInt((1 << 3) | 0)), ...varint(BigInt(aid)),
    ...varint(BigInt((2 << 3) | 0)), ...varint(BigInt(cid)),
    ...varint(BigInt((3 << 3) | 0)), ...varint(1n),
    ...lengthDelimited(4, spmid),
  ];
  const frame = new Uint8Array(5 + payload.length);
  frame[0] = 0;
  frame[1] = (payload.length >>> 24) & 0xff;
  frame[2] = (payload.length >>> 16) & 0xff;
  frame[3] = (payload.length >>> 8) & 0xff;
  frame[4] = payload.length & 0xff;
  frame.set(payload, 5);
  return frame;
}

export function decodeGrpcTracks(
  bytes: Uint8Array,
  encoding: string | null,
  status: string | null,
): BiliGrpcTrack[] {
  if (status !== null && status !== '0') {
    throw new BiliRequestError('grpc-status', 'B 站字幕接口返回 gRPC 错误');
  }
  if (bytes.length > API_LIMIT || bytes.length < 5) invalid();

  let cursor = 0;
  let message: BiliGrpcTrack[] | null = null;
  let sawMessage = false;
  let trailerSeen = false;
  while (cursor < bytes.length) {
    if (cursor + 5 > bytes.length) invalid();
    const flag = bytes[cursor]!;
    const length = ((bytes[cursor + 1]! << 24) | (bytes[cursor + 2]! << 16)
      | (bytes[cursor + 3]! << 8) | bytes[cursor + 4]!) >>> 0;
    if (length > API_LIMIT) invalid();
    cursor += 5;
    if (cursor + length > bytes.length) invalid();
    const data = bytes.subarray(cursor, cursor + length);
    cursor += length;

    if (flag === 0x80) {
      if (trailerSeen) invalid();
      trailerSeen = true;
      const statuses = trailerStatuses(data);
      if (statuses.length !== 1 || statuses[0] !== '0') {
        throw new BiliRequestError('grpc-status', 'B 站字幕接口返回 gRPC 错误');
      }
      continue;
    }
    if (sawMessage || trailerSeen) invalid();
    let payload: Uint8Array;
    if (flag === 0) payload = data;
    else if (flag === 1 && encoding === 'gzip') payload = gzipPayload(data);
    else invalid();
    message = decodeReply(payload);
    sawMessage = true;
  }
  if (!sawMessage) invalid();
  if (message === null) {
    throw protocolError('字幕响应缺少状态，无法确认是否无字幕');
  }
  if (message.some(track => track.lan.trim() === '' || track.url.trim() === '')) {
    throw protocolError('B 站字幕协议响应无效');
  }
  return message;
}
