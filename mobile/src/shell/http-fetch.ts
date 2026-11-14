/** The WebView fallback must honor the same deadline as Capacitor's native HTTP path. */
export function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number | null | undefined): Promise<Response> {
  return fetch(url, {
    ...init,
    ...(typeof timeoutMs === 'number' && timeoutMs > 0
      ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
  });
}
