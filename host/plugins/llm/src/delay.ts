/** Abortable retry delay shared by LLM transports (Web Worker and desktop). */
export function delay(milliseconds: number, _value?: undefined, options?: { signal?: AbortSignal }): Promise<void> {
  const signal = options?.signal;
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(new DOMException('The operation was aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}
