import { addTypedEventListener } from '@/events';

let pickerOpen = false;

/**
 * 移动端浏览器/WebView 取消文件选择后可能不派发 `cancel` 事件；
 * 窗口重新获得焦点后等待短暂宽限期（给 `change` 事件先行触发的机会），
 * 仍未收到 `change` / `cancel` 时主动收尾并释放 `pickerOpen` 锁。
 */
const FOCUS_FALLBACK_DELAY_MS = 400;

/** Call in the original button event so Android/iOS/WebUI can open its document picker. */
export function pickWebViewFiles(
  multiple: boolean,
  accept?: string,
  options?: { signal?: AbortSignal },
): Promise<File[]> {
  if (pickerOpen) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.hidden = true;
    input.multiple = multiple;
    if (accept) input.accept = accept;

    const signal = options?.signal;
    let settled = false;
    let focusTimer: ReturnType<typeof setTimeout> | null = null;
    let disposeWindowFocus: (() => void) | null = null;

    const cleanup = () => {
      if (focusTimer !== null) {
        clearTimeout(focusTimer);
        focusTimer = null;
      }
      disposeWindowFocus?.();
      disposeWindowFocus = null;
      input.removeEventListener('change', onChange);
      input.removeEventListener('cancel', onCancel);
      signal?.removeEventListener('abort', onAbort);
      input.remove();
    };

    const finish = (files: File[]) => {
      if (settled) return;
      settled = true;
      pickerOpen = false;
      cleanup();
      resolve(files);
    };

    const onChange = () => finish(Array.from(input.files ?? []));
    const onCancel = () => finish([]);
    const onAbort = () => finish([]);
    const onWindowFocus = () => {
      if (settled) return;
      if (focusTimer !== null) clearTimeout(focusTimer);
      focusTimer = setTimeout(() => {
        focusTimer = null;
        finish(Array.from(input.files ?? []));
      }, FOCUS_FALLBACK_DELAY_MS);
    };

    if (signal?.aborted) {
      resolve([]);
      return;
    }

    input.addEventListener('change', onChange, { once: true });
    input.addEventListener('cancel', onCancel, { once: true });
    disposeWindowFocus = addTypedEventListener('focus', () => onWindowFocus());
    signal?.addEventListener('abort', onAbort, { once: true });

    document.body.append(input);
    pickerOpen = true;
    try {
      input.click();
    } catch (error) {
      settled = true;
      pickerOpen = false;
      cleanup();
      reject(error);
    }
  });
}
