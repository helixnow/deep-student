/**
 * aws-sdk request handler over `ctx.http`, replacing
 * `NodeHttpHandler({ connectionTimeout: 30_000, requestTimeout: 120_000 })` (@smithy/node-http-handler 4.14).
 *
 * Kept from NodeHttpHandler: raw request path and sorted query string, no redirect
 * following, the server's reason phrase, `,`-joined repeated headers, the
 * `AbortError` / connect-timeout errors it raised, and socket errors tagged
 * `TimeoutError` so the standard retry strategy still classifies them as transient.
 * fetch refuses `Expect: 100-continue`, so the header is dropped and the body is sent
 * at once (as aws-sdk-s3 in Rust does).
 */

import type { HttpHandlerOptions, HttpRequest, HttpResponse, QueryParameterBag } from '@smithy/types';
import type { HttpBody } from '../../../platform/http/api.ts';
import { NO_WHOLE_REQUEST_TIMEOUT_MS, httpService, transportError, type NetError } from './http.ts';

/** NodeHttpHandler `NODEJS_TIMEOUT_ERROR_CODES`. */
const TIMEOUT_ERROR_CODES: readonly string[] = ['ECONNRESET', 'EPIPE', 'ETIMEDOUT'];

/** Response body handed to the SDK: a web stream that can also be torn down like a Node stream. */
export type S3BodyStream = ReadableStream<Uint8Array> & { destroy(): void };

export interface S3RequestHandlerOptions {
  connectionTimeoutMs: number;
  /**
   * s3.rs `operation_attempt_timeout`: an attempt that has no response headers by then
   * fails as a retryable `TimeoutError`. NodeHttpHandler 4.x only logged this unless
   * `throwOnRequestTimeout` was set, so the port had silently lost the bound.
   */
  requestTimeoutMs: number;
}

function escapeUri(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** @smithy/querystring-builder `buildQueryString`. */
function buildQueryString(query: QueryParameterBag): string {
  const parts: string[] = [];
  for (const key of Object.keys(query).sort()) {
    const value = query[key];
    const name = escapeUri(key);
    if (Array.isArray(value)) {
      for (const item of value) parts.push(`${name}=${escapeUri(item)}`);
    } else {
      parts.push(value || typeof value === 'string' ? `${name}=${escapeUri(value)}` : name);
    }
  }
  return parts.join('&');
}

function requestUrl(request: HttpRequest): string {
  let path = request.path;
  const query = buildQueryString(request.query ?? {});
  if (query) path += `?${query}`;
  if (request.fragment) path += `#${request.fragment}`;
  return `${request.protocol}//${request.hostname}${request.port ? `:${request.port}` : ''}${path}`;
}

/** NodeHttpHandler `buildAbortError`. */
function abortError(signal: object): Error {
  const reason = 'reason' in signal ? signal.reason : undefined;
  const error = reason && !(reason instanceof Error) ? new Error(String(reason)) : new Error('Request aborted');
  error.name = 'AbortError';
  if (reason instanceof Error) error.cause = reason;
  return error;
}

function requestError(error: unknown, connectionTimeoutMs: number): unknown {
  const cause = transportError(error, 'socket hang up') as NetError;
  if (cause?.code === 'UND_ERR_CONNECT_TIMEOUT') {
    return Object.assign(new Error(`@smithy/node-http-handler - the request socket did not establish a connection with the server within the configured timeout of ${connectionTimeoutMs} ms.`), { name: 'TimeoutError' });
  }
  if (cause instanceof Error && cause.code !== undefined && TIMEOUT_ERROR_CODES.includes(cause.code)) cause.name = 'TimeoutError';
  return cause;
}

function requestBody(body: unknown): HttpBody | null {
  if (body === undefined || body === null) return null;
  if (typeof body === 'string' || body instanceof Uint8Array || body instanceof ReadableStream) return body as HttpBody;
  const iterable = body as AsyncIterable<Uint8Array>;
  if (typeof iterable[Symbol.asyncIterator] === 'function') {
    const iterator = iterable[Symbol.asyncIterator]();
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await iterator.next();
        if (next.done) controller.close(); else controller.enqueue(next.value);
      },
      async cancel() { await iterator.return?.(); },
    }, { highWaterMark: 0 });
  }
  return body as HttpBody;
}

function responseBody(source: ReadableStream<Uint8Array> | null, controller: AbortController, cleanup: () => void): S3BodyStream {
  const reader = source?.getReader() ?? null;
  if (reader === null) cleanup();
  const stream = new ReadableStream<Uint8Array>({
    async pull(sink) {
      if (reader === null) { cleanup(); sink.close(); return; }
      try {
        const next = await reader.read();
        if (next.done) { cleanup(); sink.close(); } else sink.enqueue(next.value);
      } catch (error) {
        cleanup();
        sink.error(transportError(error, 'aborted'));
      }
    },
    cancel(reason) {
      cleanup();
      controller.abort();
      return reader?.cancel(reason);
    },
  }, { highWaterMark: 0 });
  return Object.assign(stream, {
    destroy(): void {
      cleanup();
      controller.abort();
      reader?.cancel().catch(() => undefined);
    },
  });
}

export function createS3RequestHandler(options: S3RequestHandlerOptions) {
  return {
    metadata: { handlerProtocol: 'http/1.1' },
    async handle(request: HttpRequest, { abortSignal, requestTimeout }: HttpHandlerOptions = {}): Promise<{ response: HttpResponse }> {
      if (abortSignal?.aborted) throw abortError(abortSignal);
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (name.toLowerCase() !== 'expect') headers.set(name, value);
      }
      const controller = new AbortController();
      let aborted: Error | null = null;
      const onAbort = (): void => {
        aborted ??= abortError(abortSignal!);
        controller.abort(aborted);
      };
      const signal = abortSignal as AbortSignal | undefined;
      signal?.addEventListener?.('abort', onAbort, { once: true });
      const cleanup = (): void => { signal?.removeEventListener?.('abort', onAbort); };
      const timeoutMs = requestTimeout ?? options.requestTimeoutMs;
      const attemptTimer = setTimeout(() => {
        aborted ??= Object.assign(new Error(`@smithy/node-http-handler - [ERROR] a request has exceeded the configured ${timeoutMs} ms requestTimeout.`), {
          name: 'TimeoutError', code: 'ETIMEDOUT',
        });
        controller.abort(aborted);
      }, timeoutMs);
      (attemptTimer as { unref?: () => void }).unref?.();
      let response: Response;
      try {
        response = await httpService().fetch(requestUrl(request), {
          method: request.method,
          headers,
          body: request.method === 'GET' || request.method === 'HEAD' ? null : requestBody(request.body),
          signal: controller.signal,
          redirect: 'manual',
          timeoutMs: NO_WHOLE_REQUEST_TIMEOUT_MS,
        });
      } catch (error) {
        cleanup();
        throw aborted ?? requestError(error, options.connectionTimeoutMs);
      } finally {
        clearTimeout(attemptTimer);
      }
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        responseHeaders[name] = name in responseHeaders ? `${responseHeaders[name]},${value}` : value;
      });
      return {
        response: {
          statusCode: response.status,
          reason: response.statusText,
          headers: responseHeaders,
          body: responseBody(response.body, controller, cleanup),
        },
      };
    },
    updateHttpClientConfig(): void {},
    httpHandlerConfigs(): Record<string, never> { return {}; },
    destroy(): void {},
  };
}
