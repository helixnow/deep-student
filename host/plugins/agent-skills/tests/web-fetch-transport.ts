import { HttpError, createHttpService, pickPinnedAddress, type HttpService, type PinnedTransportInit } from '../../../platform/http/index.ts';
import { bareHostname, ipLiteral } from '../../../platform/http/pinned-policy.ts';

export type Resolve = (host: string) => Promise<ReadonlyArray<{ address: string }>>;

export interface PinnedExchange {
  readonly url: URL;
  /** The address `pickPinnedAddress` accepted; the only one a real transport would connect to. */
  readonly address: string;
  readonly init: PinnedTransportInit;
}

/**
 * `ctx.http` with W14's policy layer and address check, the `public-pinned` connection replaced by `connect`
 * (resolution as in `pinned.ts`: IP literals are not resolved, a failing resolver is `dns-failed`).
 * Any request that is not `public-pinned` fails, so web_fetch cannot fall back to an unpinned request unnoticed.
 */
export function pinnedHttp(resolve: Resolve, connect: (exchange: PinnedExchange) => Response | Promise<Response>): HttpService {
  return createHttpService({
    transport: async url => { throw new Error(`unexpected request without destination public-pinned: ${url}`); },
    pinnedTransport: async (href, init) => {
      const url = new URL(href);
      const host = bareHostname(url);
      let addresses: string[];
      if (ipLiteral(host) !== null) addresses = [host];
      else {
        try { addresses = (await resolve(host)).map(answer => answer.address); }
        catch (error) {
          throw new HttpError('BlockedDestination', href, `DNS resolution failed for '${host}': ${(error as Error).message}`, { reason: 'dns-failed', cause: error });
        }
      }
      const address = pickPinnedAddress(href, addresses, init.allowLoopback);
      init.signal?.throwIfAborted();
      return connect({ url, address, init });
    },
    resolveHost: resolve,
  });
}

/** A plain-text response, with `location` for redirects. */
export function page(status: number, options: { location?: string; body?: string; contentType?: string } = {}): Response {
  const headers = new Headers({ 'content-type': options.contentType ?? 'text/plain' });
  if (options.location !== undefined) headers.set('location', options.location);
  return new Response(options.body === undefined || options.body === '' ? null : options.body, { status, headers });
}
