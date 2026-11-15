let pickerOpen = false;

/** Call in the original button event so Android can open its document picker. */
export function pickWebViewFiles(multiple: boolean, accept?: string): Promise<File[]> {
  if (pickerOpen) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.hidden = true;
    input.multiple = multiple;
    if (accept) input.accept = accept;
    const finish = (files: File[]) => {
      pickerOpen = false;
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => finish(Array.from(input.files ?? [])), { once: true });
    input.addEventListener('cancel', () => finish([]), { once: true });
    document.body.append(input);
    pickerOpen = true;
    try { input.click(); }
    catch (error) {
      pickerOpen = false;
      input.remove();
      reject(error);
    }
  });
}
