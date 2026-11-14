/**
 * WebSocket wire codec for `RendererToMain` <-> `MainToRenderer` (`electron/shell/bridge-messages.ts`).
 *
 * - Pure JSON messages travel as UTF-8 text frames.
 * - Binary IPC payloads (`application/octet-stream` invoke requests and `kind: 'raw'` responses/callbacks/channels)
 *   travel as compact binary frames: `[u32be headerByteLength][UTF-8 JSON header][raw payload bytes]`,
 *   preserving 1:1 `Uint8Array` fidelity without base64 inflation.
 */
import type { MainToRenderer, RendererToMain, ResponseBody } from '../../electron/shell/bridge-messages.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface BinaryInvokeHeader {
  wire: 'invoke-raw';
  cmd: string;
  callback: number;
  error: number;
  headers: Record<string, string>;
}

type BinaryMainHeader =
  | { wire: 'result-raw'; callbackId: number; otherId: number }
  | { wire: 'callback-raw'; id: number }
  | { wire: 'channel-raw'; id: number; index: number };

function packBinaryFrame(header: BinaryInvokeHeader | BinaryMainHeader, payload: Uint8Array): Uint8Array {
  const headerBytes = encoder.encode(JSON.stringify(header));
  const frame = new Uint8Array(4 + headerBytes.byteLength + payload.byteLength);
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  view.setUint32(0, headerBytes.byteLength, false);
  frame.set(headerBytes, 4);
  frame.set(payload, 4 + headerBytes.byteLength);
  return frame;
}

function unpackBinaryFrame(frame: Uint8Array): { header: Record<string, unknown>; payload: Uint8Array } {
  if (frame.byteLength < 4) {
    throw new Error('binary wire frame shorter than 4-byte header length');
  }
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const headerLen = view.getUint32(0, false);
  if (headerLen > frame.byteLength - 4) {
    throw new Error(`binary wire frame header length (${headerLen}) exceeds frame size (${frame.byteLength})`);
  }
  const headerJson = decoder.decode(frame.subarray(4, 4 + headerLen));
  const parsed = JSON.parse(headerJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('binary wire frame header must be a JSON object');
  }
  const payload = frame.slice(4 + headerLen);
  return { header: parsed as Record<string, unknown>, payload };
}

export function encodeRendererMessage(message: RendererToMain): string | Uint8Array {
  if (message.type === 'invoke' && message.payload.contentType === 'application/octet-stream') {
    return packBinaryFrame(
      {
        wire: 'invoke-raw',
        cmd: message.cmd,
        callback: message.callback,
        error: message.error,
        headers: message.headers,
      },
      message.payload.data,
    );
  }
  return JSON.stringify(message);
}

export function decodeRendererMessage(data: string | Uint8Array): unknown {
  if (typeof data === 'string') {
    return JSON.parse(data) as unknown;
  }
  const { header, payload } = unpackBinaryFrame(data);
  if (header.wire === 'invoke-raw') {
    return {
      type: 'invoke',
      cmd: header.cmd,
      callback: header.callback,
      error: header.error,
      headers: header.headers,
      payload: {
        contentType: 'application/octet-stream',
        data: payload,
      },
    };
  }
  throw new Error(`unknown binary renderer wire type: ${String(header.wire)}`);
}

export function encodeMainMessage(message: MainToRenderer): string | Uint8Array {
  if (message.type === 'result' && message.body.kind === 'raw') {
    return packBinaryFrame(
      {
        wire: 'result-raw',
        callbackId: message.callbackId,
        otherId: message.otherId,
      },
      message.body.data,
    );
  }
  if (message.type === 'callback' && message.body.kind === 'raw') {
    return packBinaryFrame({ wire: 'callback-raw', id: message.id }, message.body.data);
  }
  if (message.type === 'channel' && message.body?.kind === 'raw') {
    return packBinaryFrame({ wire: 'channel-raw', id: message.id, index: message.index }, message.body.data);
  }
  return JSON.stringify(message);
}

export function decodeMainMessage(data: string | Uint8Array): MainToRenderer {
  if (typeof data === 'string') {
    return JSON.parse(data) as MainToRenderer;
  }
  const { header, payload } = unpackBinaryFrame(data);
  const body: ResponseBody = { kind: 'raw', data: payload };
  if (header.wire === 'result-raw') {
    return {
      type: 'result',
      callbackId: Number(header.callbackId),
      otherId: Number(header.otherId),
      body,
    };
  }
  if (header.wire === 'callback-raw') {
    return {
      type: 'callback',
      id: Number(header.id),
      body,
    };
  }
  if (header.wire === 'channel-raw') {
    return {
      type: 'channel',
      id: Number(header.id),
      index: Number(header.index),
      body,
    };
  }
  throw new Error(`unknown binary main wire type: ${String(header.wire)}`);
}
