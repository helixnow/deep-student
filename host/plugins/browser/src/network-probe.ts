// src/cmd/network.rs network_probe over reqwest 0.11 (async_impl/client.rs PendingRequest::poll):
// one `ClientBuilder::timeout` budget covers the whole redirect chain, and the default
// `redirect::Policy::limited(10)` errors once 10 URLs are in the chain (9 redirects followed).

const REDIRECT_LIMIT = 10;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface NetworkProbeResult {
  ok: boolean;
  statusCode: number | null;
  rttMs: number;
  error: string | null;
}

/** reqwest `Error` Display: `<kind>[ for url (<url>)][: <source>]`. */
function reqwestError(kind: string, url: string | null, source: string | null): string {
  return `${kind}${url === null ? '' : ` for url (${url})`}${source === null ? '' : `: ${source}`}`;
}

function causeText(error: unknown): string {
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
  return cause instanceof Error ? cause.message : String(cause);
}

async function discardBody(response: Response): Promise<void> {
  // boundary-allow empty-catch: reqwest drops the intermediate redirect body without reading it
  try { await response.body?.cancel(); } catch { /* dropped like the hyper body */ }
}

export async function networkProbe(
  url: string, method: string | null | undefined, timeoutMs: number | null | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<NetworkProbeResult> {
  const timeout = Math.min(Math.max(timeoutMs ?? 5000, 100), 30000);
  const useGet = typeof method === 'string' && method.toLowerCase() === 'get';
  const started = performance.now();
  const elapsed = (): number => Math.trunc(performance.now() - started);
  const fail = (error: string): NetworkProbeResult => ({ ok: false, statusCode: null, rttMs: elapsed(), error });

  let current: URL;
  try { current = new URL(url); }
  catch (error) { return fail(reqwestError('builder error', null, causeText(error))); }

  const signal = AbortSignal.timeout(timeout);
  const chain: string[] = [];
  for (;;) {
    let response: Response;
    try {
      response = await fetchImpl(current.href, { method: useGet ? 'GET' : 'HEAD', redirect: 'manual', signal });
    } catch (error) {
      if (signal.aborted) return fail(reqwestError('error sending request', current.href, 'operation timed out'));
      return fail(reqwestError('error sending request', current.href, causeText(error)));
    }
    if (!REDIRECT_STATUSES.has(response.status)) {
      await discardBody(response);
      return { ok: true, statusCode: response.status, rttMs: elapsed(), error: null };
    }
    const location = response.headers.get('location');
    let next: URL | null = null;
    if (location !== null) {
      try { next = new URL(location, current); } catch { next = null; }
    }
    // A missing or unusable Location returns the 3xx response itself.
    if (next === null) {
      await discardBody(response);
      return { ok: true, statusCode: response.status, rttMs: elapsed(), error: null };
    }
    chain.push(current.href);
    await discardBody(response);
    if (chain.length >= REDIRECT_LIMIT) {
      return fail(reqwestError('error following redirect', current.href, 'too many redirects'));
    }
    if (next.protocol !== 'http:' && next.protocol !== 'https:') {
      return fail(reqwestError('builder error', next.href, 'URL scheme is not allowed'));
    }
    current = next;
  }
}
