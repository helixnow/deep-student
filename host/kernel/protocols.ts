/**
 * `ctx.protocols`：自定义 URI 协议（pdfstream / filestream / bilistream 等）。
 *
 * Rust 侧 `register_uri_scheme_protocol` / `register_asynchronous_uri_scheme_protocol` 的处理函数直接
 * 返回 `http::Response`，没有错误通道；迁移后处理函数抛错属于缺陷，kernel 统一回 500（见 API.md）。
 */
import { Service, type Context } from '@deepseek-ai/cordis';
import type { ProtocolReply, ProtocolRegistry, ProtocolRequestInfo } from './api.ts';
import { assertKernelSurface, describeError, type KernelState } from './kernel.ts';
import type { ProtocolChunk, ProtocolRequest, ProtocolResponse } from './protocol.ts';

type Handler = (req: ProtocolRequestInfo) => ProtocolReply | Promise<ProtocolReply>;

const SCHEME = /^[a-z][a-z0-9+.-]*$/;
const EMPTY = new Uint8Array(0);
const encoder = new TextEncoder();

function isAsyncIterable(value: unknown): value is AsyncIterable<Uint8Array> {
  return typeof value === 'object' && value !== null && typeof (value as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === 'function';
}

function assertReply(reply: unknown): asserts reply is ProtocolReply {
  if (typeof reply !== 'object' || reply === null) throw new TypeError('protocol handler must return { status, headers, body }');
  const r = reply as ProtocolReply;
  if (!Number.isInteger(r.status) || r.status < 100 || r.status > 599) throw new TypeError(`protocol handler returned invalid status ${String(r.status)}`);
  if (typeof r.headers !== 'object' || r.headers === null) throw new TypeError('protocol handler must return a headers object');
  if (!(r.body instanceof Uint8Array) && !isAsyncIterable(r.body)) throw new TypeError('protocol handler body must be a Uint8Array or an AsyncIterable<Uint8Array>');
}

export class ProtocolService extends Service implements ProtocolRegistry {
  _kernel: KernelState;
  _handlers = new Map<string, Handler>();

  constructor(ctx: Context, kernel: KernelState) {
    super(ctx, 'protocols');
    this._kernel = kernel;
  }

  register(scheme: string, handler: Handler): void {
    if (typeof scheme !== 'string' || !SCHEME.test(scheme)) throw new TypeError(`ctx.protocols.register: invalid scheme ${JSON.stringify(scheme)}`);
    if (typeof handler !== 'function') throw new TypeError(`ctx.protocols.register("${scheme}"): handler must be a function`);
    assertKernelSurface(this._kernel, this.ctx.fiber, `ctx.protocols.register("${scheme}")`);
    this.ctx.effect(() => {
      if (this._handlers.has(scheme)) throw new Error(`ctx.protocols.register("${scheme}"): scheme is already registered`);
      this._handlers.set(scheme, handler);
      return () => {
        if (this._handlers.get(scheme) === handler) this._handlers.delete(scheme);
      };
    }, `ctx.protocols.register(${JSON.stringify(scheme)})`);
  }

  has(scheme: string): boolean {
    return this._handlers.has(scheme);
  }

  /**
   * 处理一次协议请求，通过 `send` 发出 `ProtocolResponse`（以及流式时的 `ProtocolChunk`）。
   * 一次性响应体：一条 `final: true` 的 ProtocolResponse；
   * 流式响应体：先发头（`final: false`，空 body），每个分块一条 `final: false` 的 chunk，最后一条
   * `final: true` 的空 chunk；产出过程抛错时最后一条带 `error`。
   */
  async _serve(request: ProtocolRequest, send: (message: ProtocolResponse | ProtocolChunk) => void): Promise<void> {
    const logger = this._kernel.root.logger('protocols');
    const handler = this._handlers.get(request.scheme);
    if (!handler) {
      logger.warn(`no handler registered for scheme "${request.scheme}" (${request.url})`);
      send({ kind: 'protocol-result', id: request.id, status: 404, headers: {}, body: EMPTY, final: true });
      return;
    }
    let reply: ProtocolReply;
    try {
      const info: ProtocolRequestInfo = { url: request.url, method: request.method, headers: { ...request.headers } };
      if (request.body !== undefined) info.body = request.body;
      reply = await handler(info);
      assertReply(reply);
    } catch (error) {
      const text = describeError(error);
      logger.error(`protocol handler for "${request.scheme}" failed on ${request.url}:\n${text}`);
      send({
        kind: 'protocol-result',
        id: request.id,
        status: 500,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        body: encoder.encode(error instanceof Error ? error.message : String(error)),
        final: true,
      });
      return;
    }
    const headers = { ...reply.headers };
    if (reply.body instanceof Uint8Array) {
      send({ kind: 'protocol-result', id: request.id, status: reply.status, headers, body: reply.body, final: true });
      return;
    }
    send({ kind: 'protocol-result', id: request.id, status: reply.status, headers, body: EMPTY, final: false });
    try {
      for await (const chunk of reply.body) {
        if (!(chunk instanceof Uint8Array)) throw new TypeError('protocol body stream yielded a non-Uint8Array chunk');
        if (chunk.byteLength === 0) continue;
        send({ kind: 'protocol-chunk', id: request.id, body: chunk, final: false });
      }
    } catch (error) {
      const text = describeError(error);
      logger.error(`protocol body stream for "${request.scheme}" failed on ${request.url}:\n${text}`);
      send({ kind: 'protocol-chunk', id: request.id, body: EMPTY, final: true, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    send({ kind: 'protocol-chunk', id: request.id, body: EMPTY, final: true });
  }
}
