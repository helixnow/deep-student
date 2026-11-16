/** The WebView fallback must honor the same deadline as Capacitor's native HTTP path. */
export function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number | null | undefined): Promise<Response> {
  const hasTimeout = typeof timeoutMs === 'number' && timeoutMs > 0;
  if (!hasTimeout) return fetch(url, init);
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = init.signal && typeof AbortSignal.any === 'function'
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal;
  return fetch(url, { ...init, signal });
}
