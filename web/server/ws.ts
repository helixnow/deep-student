/**
 * Zero-dependency RFC 6455 WebSocket upgrade and frame codec over `node:http` + `node:net`
 * (plus stateless RFC 7692 `permessage-deflate` and a server ping heartbeat).
 */
import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { constants as zlibConstants, deflateRawSync, inflateRawSync } from 'node:zlib';

const WS_MAGIC_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OPCODE_CONTINUATION = 0x0;
const OPCODE_TEXT = 0x1;
const OPCODE_BINARY = 0x2;
const OPCODE_CLOSE = 0x8;
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0x0a;

const RSV1 = 0x40;
const RSV_OTHER = 0x30;

/** RFC 7692 §7.2.1：解压前要把发送方剥掉的 4 字节尾巴补回去。 */
const PERMESSAGE_DEFLATE_TAIL = Buffer.from([0x00, 0x00, 0xff, 0xff]);

/**
 * 小于这个字节数的文本帧不压缩：ACK、`listen` 帧等小消息压缩后往往更大，
 * 且要多付一次 deflate 的 CPU，得不偿失。
 */
const COMPRESSION_MIN_BYTES = 256;

export interface WebSocketOptions {
  maxPayloadBytes?: number;
  /** 是否与客户端协商 RFC 7692 `permessage-deflate`（默认开启）。 */
  enableCompression?: boolean;
  /** 服务端 PING 心跳间隔（毫秒，`0` 关闭，默认 25s）。 */
  pingIntervalMs?: number;
}

export interface WebSocketConnection {
  readonly open: boolean;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onMessage(listener: (data: string | Uint8Array) => void): void;
  onClose(listener: () => void): void;
}

function buildServerFrame(opcode: number, payload: Uint8Array, rsv1 = false): Buffer {
  const length = payload.byteLength;
  let headerLength = 2;
  if (length >= 126 && length <= 0xffff) headerLength = 4;
  else if (length > 0xffff) headerLength = 10;

  const frame = Buffer.allocUnsafe(headerLength + length);
  frame[0] = 0x80 | (rsv1 ? RSV1 : 0) | (opcode & 0x0f);
  if (length < 126) {
    frame[1] = length;
  } else if (length <= 0xffff) {
    frame[1] = 126;
    frame.writeUInt16BE(length, 2);
  } else {
    frame[1] = 127;
    frame.writeBigUInt64BE(BigInt(length), 2);
  }
  frame.set(payload, headerLength);
  return frame;
}

export function computeWebSocketAccept(secWebSocketKey: string): string {
  return createHash('sha1')
    .update(secWebSocketKey.trim() + WS_MAGIC_GUID, 'latin1')
    .digest('base64');
}

export function rejectUpgrade(socket: Duplex, status: number, statusText: string, body = ''): void {
  const payload = Buffer.from(body, 'utf8');
  socket.write(
    `HTTP/1.1 ${status} ${statusText}\r\n` +
      'Connection: close\r\n' +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      `Content-Length: ${payload.byteLength}\r\n\r\n`,
  );
  if (payload.byteLength > 0) socket.write(payload);
  socket.destroy();
}

/** 客户端是否提供了 `permessage-deflate`（可带参数、可多段）。 */
function offersPermessageDeflate(header: string | string[] | undefined): boolean {
  if (header === undefined) return false;
  const raw = Array.isArray(header) ? header.join(',') : header;
  return raw
    .split(',')
    .some((extension) => extension.split(';')[0]?.trim().toLowerCase() === 'permessage-deflate');
}

function isBufferTooLargeError(error: unknown): boolean {
  if (error instanceof RangeError) return true;
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as NodeJS.ErrnoException).code) === 'ERR_BUFFER_TOO_LARGE'
    : false;
}

export function acceptWebSocketUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  options: WebSocketOptions = {},
): WebSocketConnection | null {
  const upgrade = req.headers.upgrade;
  const key = req.headers['sec-websocket-key'];
  const version = req.headers['sec-websocket-version'];
  if (
    typeof upgrade !== 'string' ||
    upgrade.toLowerCase() !== 'websocket' ||
    typeof key !== 'string' ||
    key.trim() === '' ||
    version !== '13'
  ) {
    rejectUpgrade(socket, 400, 'Bad Request', 'Invalid WebSocket upgrade headers');
    return null;
  }

  const maxPayloadBytes = options.maxPayloadBytes ?? 320 * 1024 * 1024;
  const pingIntervalMs = options.pingIntervalMs ?? 25_000;
  // 无状态 deflate（`no_context_takeover`）不维护滑动字典：每帧独立压缩，
  // 换来不需要为每条连接留 32 KiB 窗口，也避免了上下文不同步导致的全连接错误。
  const compressionNegotiated =
    options.enableCompression !== false && offersPermessageDeflate(req.headers['sec-websocket-extensions']);

  const accept = computeWebSocketAccept(key);
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n` +
      (compressionNegotiated
        ? 'Sec-WebSocket-Extensions: permessage-deflate; server_no_context_takeover; client_no_context_takeover\r\n'
        : '') +
      '\r\n',
  );
  if ('setNoDelay' in socket && typeof socket.setNoDelay === 'function') {
    socket.setNoDelay(true);
  }
  // 半开连接（NAT 超时、手机锁屏）下 TCP 自己发现不了对端消失，靠 keepalive 探测兜底。
  if ('setKeepAlive' in socket && typeof socket.setKeepAlive === 'function') {
    socket.setKeepAlive(true, 30_000);
  }

  let isOpen = true;
  let buffer: Buffer = head.byteLength > 0 ? Buffer.from(head) : Buffer.alloc(0);
  let receiveStorage: Buffer | null = null;
  let fragOpcode: number | null = null;
  let fragCompressed = false;
  let fragChunks: Buffer[] = [];
  let fragBytes = 0;
  let missedPongs = 0;
  let pingTimer: ReturnType<typeof setInterval> | null = null;

  const messageListeners: Array<(data: string | Uint8Array) => void> = [];
  const closeListeners: Array<() => void> = [];

  const markClosed = () => {
    if (!isOpen) return;
    isOpen = false;
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    fragChunks = [];
    fragBytes = 0;
    buffer = Buffer.alloc(0);
    messageListeners.length = 0;
    receiveStorage = null;
    for (const fn of closeListeners.splice(0)) fn();
  };

  const writeFrame = (frame: Buffer): void => {
    // send() 的接口没有异步 drain 信号；慢标签页不能无限堆积结果/事件。
    // 允许两份最大消息在途，超出后断开，让浏览器按既有流程重连。
    if (socket.writableLength + frame.byteLength > 2 * maxPayloadBytes) {
      markClosed();
      socket.destroy();
      return;
    }
    try {
      socket.write(frame);
    } catch {
      markClosed();
      socket.destroy();
    }
  };

  const closeWith = (code = 1000, reason = '') => {
    if (!isOpen) return;
    const reasonBytes = Buffer.from(reason, 'utf8').subarray(0, 123);
    const payload = Buffer.allocUnsafe(2 + reasonBytes.byteLength);
    payload.writeUInt16BE(code, 0);
    reasonBytes.copy(payload, 2);
    try {
      socket.write(buildServerFrame(OPCODE_CLOSE, payload));
    } catch (error) {
      void error;
    }
    markClosed();
    socket.end();
  };

  /**
   * 收帧解压。`maxOutputLength` 让压缩炸弹在解压过程中就被掐断，
   * 不会先膨胀出几百 MB 再被长度检查拒掉。
   */
  const decodeMessage = (payload: Buffer, compressed: boolean, opcode: number): string | Uint8Array | null => {
    let plain = payload;
    if (compressed) {
      try {
        plain = inflateRawSync(Buffer.concat([payload, PERMESSAGE_DEFLATE_TAIL]), {
          finishFlush: zlibConstants.Z_SYNC_FLUSH,
          maxOutputLength: maxPayloadBytes,
        });
      } catch (error) {
        if (isBufferTooLargeError(error)) {
          closeWith(1009, 'Message too big');
        } else {
          closeWith(1007, 'Invalid compressed data');
        }
        socket.destroy();
        return null;
      }
    }
    return opcode === OPCODE_TEXT ? plain.toString('utf8') : new Uint8Array(plain);
  };

  const parseFrames = () => {
    while (isOpen && buffer.byteLength >= 2) {
      const b0 = buffer[0]!;
      const b1 = buffer[1]!;
      const fin = (b0 & 0x80) !== 0;
      const rsv = b0 & 0x70;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      const isDataStart = opcode === OPCODE_TEXT || opcode === OPCODE_BINARY;
      const frameCompressed = (rsv & RSV1) !== 0 && isDataStart && compressionNegotiated;
      let payloadLen = b1 & 0x7f;
      let offset = 2;

      // RSV1 只允许出现在（已协商 deflate 的）消息首帧；其余保留位与未协商的 RSV1 都是协议错误。
      if ((rsv & RSV_OTHER) !== 0 || ((rsv & RSV1) !== 0 && !frameCompressed) || !masked) {
        closeWith(1002, 'Protocol error');
        socket.destroy();
        return;
      }

      if (payloadLen === 126) {
        if (buffer.byteLength < 4) return;
        payloadLen = buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (buffer.byteLength < 10) return;
        const bigLen = buffer.readBigUInt64BE(2);
        if (bigLen > BigInt(maxPayloadBytes)) {
          closeWith(1009, 'Message too big');
          socket.destroy();
          return;
        }
        payloadLen = Number(bigLen);
        offset = 10;
      }

      if (payloadLen > maxPayloadBytes) {
        closeWith(1009, 'Message too big');
        socket.destroy();
        return;
      }

      const frameTotal = offset + 4 + payloadLen;
      if (buffer.byteLength < frameTotal) return;

      const maskKey = buffer.subarray(offset, offset + 4);
      const bodyStart = offset + 4;
      const payload = Buffer.allocUnsafe(payloadLen);
      for (let i = 0; i < payloadLen; i++) {
        payload[i] = buffer[bodyStart + i]! ^ maskKey[i & 3]!;
      }
      buffer = buffer.subarray(frameTotal);

      if (opcode >= 0x8) {
        if (!fin || payloadLen > 125) {
          closeWith(1002, 'Invalid control frame');
          socket.destroy();
          return;
        }
        if (opcode === OPCODE_PING) {
          writeFrame(buildServerFrame(OPCODE_PONG, payload));
        } else if (opcode === OPCODE_CLOSE) {
          const echoCode = payload.byteLength >= 2 ? payload.readUInt16BE(0) : 1000;
          closeWith(echoCode);
        }
        continue;
      }

      if (opcode === OPCODE_CONTINUATION) {
        if (fragOpcode === null) {
          closeWith(1002, 'Unexpected continuation frame');
          socket.destroy();
          return;
        }
        fragBytes += payload.byteLength;
        if (fragBytes > maxPayloadBytes) {
          closeWith(1009, 'Fragmented message too big');
          socket.destroy();
          return;
        }
        fragChunks.push(payload);
        if (fin) {
          const full = Buffer.concat(fragChunks, fragBytes);
          const completedOpcode = fragOpcode;
          const completedCompressed = fragCompressed;
          fragOpcode = null;
          fragCompressed = false;
          fragChunks = [];
          fragBytes = 0;
          const decoded = decodeMessage(full, completedCompressed, completedOpcode);
          if (decoded === null) return;
          for (const listener of messageListeners) listener(decoded);
        }
        continue;
      }

      if (!isDataStart) {
        closeWith(1003, 'Unsupported opcode');
        socket.destroy();
        return;
      }

      if (fragOpcode !== null) {
        closeWith(1002, 'Unfinished fragmented message');
        socket.destroy();
        return;
      }

      if (!fin) {
        fragOpcode = opcode;
        fragCompressed = frameCompressed;
        fragChunks = [payload];
        fragBytes = payload.byteLength;
        continue;
      }

      const decoded = decodeMessage(payload, frameCompressed, opcode);
      if (decoded === null) return;
      for (const listener of messageListeners) listener(decoded);
    }
  };

  socket.on('data', (chunk: Buffer) => {
    // 已经发出 CLOSE（协议错误 / 服务端关闭）后，对端仍可继续灌字节；这些数据不再需要，
    // 直接丢弃，避免 `buffer` 无限增长。
    if (!isOpen) return;
    // 任何入站帧（数据帧、PONG、PING、CLOSE）都证明对端还活着。
    missedPongs = 0;
    if (buffer.byteLength === 0) {
      buffer = chunk;
      receiveStorage = null;
    } else {
      const length = buffer.byteLength + chunk.byteLength;
      const storageOffset = receiveStorage ? buffer.byteOffset - receiveStorage.byteOffset : 0;
      if (!receiveStorage || storageOffset + length > receiveStorage.byteLength) {
        // TCP 半包不应每次复制整个已收大消息；按几何容量扩展，让上传拷贝量保持线性。
        const storage = Buffer.allocUnsafe(Math.max(length, Math.min(buffer.byteLength * 2, maxPayloadBytes + 14)));
        buffer.copy(storage);
        receiveStorage = storage;
        buffer = storage.subarray(0, buffer.byteLength);
      }
      const offset = buffer.byteOffset - receiveStorage.byteOffset;
      chunk.copy(receiveStorage, offset + buffer.byteLength);
      buffer = receiveStorage.subarray(offset, offset + length);
    }
    parseFrames();
    if (buffer.byteLength === 0) receiveStorage = null;
  });
  socket.on('close', markClosed);
  socket.on('end', markClosed);
  socket.on('error', () => {
    markClosed();
  });

  if (buffer.byteLength > 0) {
    queueMicrotask(parseFrames);
  }

  if (pingIntervalMs > 0) {
    pingTimer = setInterval(() => {
      if (!isOpen) {
        if (pingTimer) {
          clearInterval(pingTimer);
          pingTimer = null;
        }
        return;
      }
      // 写入队列未排空时 PING 也无法到达对端。不要把慢下载误判为断线，
      // 也不要在同一批大消息后面重复堆积 PING。半开 TCP 由 keepalive 兜底。
      if (socket.writableLength > 0) return;
      // 连续两个已发送心跳周期没有任何入站帧：对端已经消失。
      if (missedPongs >= 2) {
        markClosed();
        socket.destroy();
        return;
      }
      missedPongs++;
      try {
        writeFrame(buildServerFrame(OPCODE_PING, Buffer.alloc(0)));
      } catch (error) {
        void error;
        markClosed();
        socket.destroy();
      }
    }, pingIntervalMs);
    // 心跳定时器不能单独撑住进程：WebUI 关闭时不该被 25s 的定时器拖住事件循环。
    pingTimer.unref?.();
  }

  return {
    get open() {
      return isOpen;
    },
    send(data: string | Uint8Array) {
      if (!isOpen) return;
      if (typeof data === 'string') {
        const rawBuf = Buffer.from(data, 'utf8');
        if (compressionNegotiated && rawBuf.byteLength >= COMPRESSION_MIN_BYTES) {
          let compressed: Buffer | null = null;
          try {
            compressed = deflateRawSync(rawBuf, {
              finishFlush: zlibConstants.Z_SYNC_FLUSH,
            });
          } catch (error) {
            void error;
            compressed = null;
          }
          if (compressed !== null && compressed.byteLength > 0) {
            const stripped =
              compressed.byteLength >= 4 && compressed.subarray(compressed.byteLength - 4).equals(PERMESSAGE_DEFLATE_TAIL)
                ? compressed.subarray(0, compressed.byteLength - 4)
                : compressed;
            writeFrame(buildServerFrame(OPCODE_TEXT, stripped, true));
            return;
          }
        }
        writeFrame(buildServerFrame(OPCODE_TEXT, rawBuf));
      } else {
        // 二进制帧（PDF / 图片 / 已编码媒体）本身就是压缩数据，再 deflate 只会白烧 CPU。
        writeFrame(buildServerFrame(OPCODE_BINARY, data));
      }
    },
    close(code = 1000, reason = '') {
      closeWith(code, reason);
    },
    onMessage(listener) {
      messageListeners.push(listener);
    },
    onClose(listener) {
      closeListeners.push(listener);
    },
  };
}
