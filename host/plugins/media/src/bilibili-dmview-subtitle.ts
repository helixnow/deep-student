/** B 站 App DmView：无需 Cookie 的轻量 protobuf / gRPC 字幕客户端。 */
export type WireType = 0 | 1 | 2 | 5;
export interface ProtoField { field: number; wire: WireType; value: number | Uint8Array }

export function encodeVarint(value: number | bigint): number[] {
  let v = typeof value === 'bigint' ? value : BigInt(Math.trunc(value));
  if (v < 0n) throw new RangeError('varint 不支持负数');
  const out: number[] = [];
  do {
    const byte = Number(v & 127n);
    v >>= 7n;
    out.push(v > 0n ? byte | 128 : byte);
  } while (v > 0n);
  return out;
}
export function fieldVarint(field: number, value: number | bigint): number[] {
  return [...encodeVarint(field * 8), ...encodeVarint(value)];
}
export function fieldBytes(field: number, value: Uint8Array): number[] {
  return [...encodeVarint(field * 8 + 2), ...encodeVarint(value.length), ...value];
}
export function encodeMessage(parts: readonly (number[] | Uint8Array)[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}
export function utf8(value: string): Uint8Array { return new TextEncoder().encode(value); }

function readVarint(buf: Uint8Array, offset: number): [number, number] {
  let value = 0n;
  for (let shift = 0n; shift < 70n; shift += 7n) {
    const byte = buf[offset++];
    if (byte === undefined) throw new RangeError('protobuf 数据在 varint 中断');
    value |= BigInt(byte & 127) << shift;
    if (!(byte & 128)) return [Number(value), offset];
  }
  throw new RangeError('protobuf varint 超过 64 位');
}
export function decodeFields(buf: Uint8Array): ProtoField[] {
  const out: ProtoField[] = [];
  let offset = 0;
  while (offset < buf.length) {
    const [key, next] = readVarint(buf, offset);
    offset = next;
    const field = Math.floor(key / 8);
    const wire = (key & 7) as WireType;
    if (wire === 0) {
      const [value, end] = readVarint(buf, offset);
      out.push({ field, wire, value }); offset = end;
    } else {
      let size: number;
      if (wire === 2) [size, offset] = readVarint(buf, offset);
      else if (wire === 1) size = 8;
      else if (wire === 5) size = 4;
      else throw new RangeError(`protobuf 出现不支持的 wire type ${wire}`);
      if (offset + size > buf.length) throw new RangeError('protobuf 字段数据不完整');
      out.push({ field, wire, value: buf.subarray(offset, offset + size) });
      offset += size;
    }
  }
  return out;
}
export function getBytes(fields: ProtoField[], field: number): Uint8Array[] {
  return fields.filter((f) => f.field === field && f.wire === 2).map((f) => f.value as Uint8Array);
}
export function getBytesFirst(fields: ProtoField[], field: number): Uint8Array | undefined {
  return getBytes(fields, field)[0];
}
export function getNumber(fields: ProtoField[], field: number): number | undefined {
  return fields.find((f) => f.field === field && f.wire === 0)?.value as number | undefined;
}
export function getString(fields: ProtoField[], field: number): string | undefined {
  const bytes = getBytesFirst(fields, field);
  return bytes ? new TextDecoder().decode(bytes) : undefined;
}

export const DM_VIEW_URL = 'https://app.biliapi.net/bilibili.community.service.dm.v1.DM/DmView';
export interface BiliSubtitleItem {
  /** 仅使用 id_str，绝不把 64 位数值 id 转回字符串。 */
  id: string;
  lan: string;
  lanDoc: string;
  langSimple: string;
  url: string;
  aiMark: number | null;
  aiFrom: number | null;
}
export function buildDmViewRequest(aid: number, cid: number): Uint8Array {
  const message = encodeMessage([
    fieldVarint(1, aid), fieldVarint(2, cid), fieldVarint(3, 1),
    fieldBytes(4, utf8('main.ugc-video-detail.0.0')),
  ]);
  const out = new Uint8Array(5 + message.length);
  new DataView(out.buffer).setUint32(1, message.length, false);
  out.set(message, 5);
  return out;
}
export function unframeGrpc(data: Uint8Array): { compressed: boolean; message: Uint8Array } {
  if (data.length > 4 * 1024 * 1024) throw new Error('字幕响应大小超限');
  if (data.length < 5) throw new Error('gRPC 响应过短');
  if (data[0] !== 0 && data[0] !== 1) throw new Error('字幕接口返回的不是有效 gRPC 数据帧');
  const size = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(1, false);
  if (size + 5 > data.length) throw new Error('字幕接口响应不完整');
  return { compressed: data[0] === 1, message: data.subarray(5, 5 + size) };
}
async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([Uint8Array.from(data).buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 4 * 1024 * 1024) throw new Error('字幕解压大小超限');
      chunks.push(value);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  return encodeMessage(chunks);
}
export function parseSubtitleList(message: Uint8Array): BiliSubtitleItem[] {
  const out: BiliSubtitleItem[] = [];
  for (const wrapper of getBytes(decodeFields(message), 3)) {
    for (const raw of getBytes(decodeFields(wrapper), 3)) {
      const fields = decodeFields(raw);
      const url = getString(fields, 5), lan = getString(fields, 3);
      if (!url || !lan) continue;
      out.push({
        id: getString(fields, 2) ?? '', lan, lanDoc: getString(fields, 4) ?? lan,
        langSimple: getString(fields, 8) ?? '', url: url.startsWith('//') ? `https:${url}` : url,
        aiMark: getNumber(fields, 7) ?? null, aiFrom: getNumber(fields, 9) ?? null,
      });
    }
  }
  return out;
}
/** 接收完整 gRPC 帧（可能 gzip），返回保持服务端顺序的字幕列表。 */
export async function decodeDmViewSubtitles(data: Uint8Array): Promise<BiliSubtitleItem[]> {
  const { compressed, message } = unframeGrpc(data);
  return parseSubtitleList(compressed ? await gunzip(message) : message);
}
/** Stop downloading as soon as the byte budget is exceeded, even without Content-Length. */
export async function readResponseBytesWithLimit(response: Response, maxBytes = 4 * 1024 * 1024): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('字幕响应大小超限');
      chunks.push(value);
    }
    return encodeMessage(chunks);
  } finally {
    try { await reader.cancel(); } finally { reader.releaseLock(); }
  }
}
export async function fetchBilibiliDmViewSubtitles(request: typeof fetch, aid: number, cid: number): Promise<BiliSubtitleItem[]> {
  const response = await request(DM_VIEW_URL, {
    method: 'POST', body: Uint8Array.from(buildDmViewRequest(aid, cid)).buffer,
    headers: { 'Content-Type': 'application/grpc', 'grpc-accept-encoding': 'identity,gzip' },
  });
  if (!response.ok) throw new Error(`字幕列表接口失败 HTTP ${response.status}`);
  const status = response.headers.get('grpc-status');
  if (status && status !== '0') throw new Error(`字幕列表接口失败 gRPC ${status}：${response.headers.get('grpc-message') || '服务返回错误'}`);
  return decodeDmViewSubtitles(await readResponseBytesWithLimit(response));
}

export interface SubtitleCue { start: number; end: number; text: string; id?: string }
export function cuesFromSubtitleJson(json: unknown): SubtitleCue[] {
  const body = (json as { body?: unknown[] } | null)?.body;
  if (!Array.isArray(body)) return [];
  const cues: SubtitleCue[] = [];
  for (const value of body) {
    const line = value as { from?: number; to?: number; content?: string } | null;
    if (typeof line?.content !== 'string') continue;
    const text = line.content.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const start = Number.isFinite(line.from) ? Math.max(0, line.from!) : 0;
    const end = Number.isFinite(line.to) && line.to! > start ? line.to! : start + 1;
    cues.push({ start: Math.round(start * 1000) / 1000, end: Math.round(end * 1000) / 1000, text });
  }
  return cues.sort((a, b) => a.start - b.start);
}
export async function fetchSubtitleCues(request: typeof fetch, url: string): Promise<SubtitleCue[]> {
  const response = await request(url);
  if (!response.ok) throw new Error(`字幕文件下载失败 HTTP ${response.status}（链接可能已过期）`);
  return cuesFromSubtitleJson(JSON.parse(new TextDecoder().decode(await readResponseBytesWithLimit(response))));
}
function vttTime(seconds: number): string {
  const ms = Math.round(Math.max(0, seconds) * 1000);
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
}
export function formatVtt(cues: readonly SubtitleCue[]): string {
  return `WEBVTT\n\n${cues.map((cue, i) => `${i + 1}\n${vttTime(cue.start)} --> ${vttTime(cue.end)}\n${cue.text}`).join('\n\n')}\n`;
}
export function parseVtt(value: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  const timestamp = /^(?:(\d+):)?(\d{2}):(\d{2})\.(\d{3})$/;
  const seconds = (s: string): number => {
    const match = timestamp.exec(s);
    return match ? Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000 : NaN;
  };
  for (const block of value.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split(/\n\s*\n/)) {
    const lines = block.split('\n');
    if (/^(WEBVTT|NOTE|STYLE|REGION)(\s|$)/.test(lines[0] ?? '')) continue;
    const at = lines.findIndex((line) => line.includes('-->'));
    if (at < 0) continue;
    const [from, to] = (lines[at] ?? '').split(/\s+-->\s+/);
    const start = seconds((from ?? '').trim()), end = seconds(to?.trim().split(/\s/)[0] ?? '');
    const text = lines.slice(at + 1).join('\n').trim();
    if (Number.isFinite(start) && end > start && text) cues.push({ start, end, text });
  }
  return cues;
}
export function langRank(lan: string): number {
  const s = lan.toLowerCase().replace(/^ai[-_]/, '');
  if (['zh', 'zh-cn', 'zh-hans', 'yue'].includes(s)) return 0;
  if (s.startsWith('zh') || s.startsWith('yue')) return 1;
  return s === 'en' || s.startsWith('en-') ? 2 : 3;
}
export function sortSubtitleLanguages(items: readonly BiliSubtitleItem[]): BiliSubtitleItem[] {
  return [...items].sort((a, b) => langRank(a.lan) - langRank(b.lan));
}
export function pickPrimary(items: readonly BiliSubtitleItem[]): BiliSubtitleItem | null {
  return sortSubtitleLanguages(items)[0] ?? null;
}
export function defaultSelectedLangs(items: readonly BiliSubtitleItem[]): string[] {
  const zh = items.find((item) => langRank(item.lan) <= 1);
  const en = items.find((item) => langRank(item.lan) === 2);
  const selected = [zh, en].filter((item): item is BiliSubtitleItem => !!item);
  return (selected.length ? selected : items.slice(0, 1)).map((item) => item.lan);
}
