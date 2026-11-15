// Android can start this build with a WebView older than URL.parse and AbortSignal.any.
// Install the missing standards before either the page or the Host Worker loads its dependencies.
function parseUrl(input: string | URL, base?: string | URL): URL | null {
  // Web IDL converts arguments before attempting to parse them.
  const url = String(input);
  const baseUrl = base === undefined ? undefined : String(base);
  try { return new URL(url, baseUrl); }
  catch { return null; }
}

if (typeof URL.parse !== 'function') {
  Object.defineProperty(URL, 'parse', { value: parseUrl, configurable: true, writable: true });
}
if (typeof URL.canParse !== 'function') {
  Object.defineProperty(URL, 'canParse', {
    value: (input: string | URL, base?: string | URL) => parseUrl(input, base) !== null,
    configurable: true, writable: true,
  });
}
if (typeof AbortSignal.any !== 'function') {
  Object.defineProperty(AbortSignal, 'any', {
    value(signals: Iterable<AbortSignal>): AbortSignal {
      const sources = Array.from(signals);
      const controller = new AbortController();
      const aborted = sources.find(signal => signal.aborted);
      if (aborted) controller.abort(aborted.reason);
      else for (const source of new Set(sources)) {
        source.addEventListener('abort', () => controller.abort(source.reason), {
          once: true, signal: controller.signal,
        });
      }
      return controller.signal;
    },
    configurable: true, writable: true,
  });
}
