/**
 * 移动端 `plugin:dialog|*` 处理（对应 `@tauri-apps/plugin-dialog` 的 `open`、`save`、`message`、`ask`、`confirm`）。
 *
 * - `open`：通过 `<input type="file">` 选文件后直接流式写入 OPFS `/deep-student/tmp/dialog-picks/<uuid>/<name>`，
 *   返回 Host 可读路径（不支持目录选择，避免静默降级误导前端）；
 * - `save`：为导出流程在 OPFS `/deep-student/tmp/dialog-saves/<uuid>/<name>` 生成并预创建可写暂存路径；
 * - `message` / `ask` / `confirm`：映射为浏览器原生 `alert` / `confirm`。
 */

export type OpfsBlobWriter = (path: string, data: Blob | Uint8Array) => Promise<void>;
export type OpfsDirCreator = (dirPath: string) => Promise<void>;

const DIALOG_PICKS_DIR = '/deep-student/tmp/dialog-picks';
const DIALOG_SAVES_DIR = '/deep-student/tmp/dialog-saves';

/** 将 Tauri `DialogFilter[]` 映射为 `<input type="file">` 的 `accept` 属性值。 */
export function filtersToAccept(filters: unknown): string {
  if (!Array.isArray(filters)) return '';
  const tokens = new Set<string>();
  for (const filter of filters) {
    if (!filter || typeof filter !== 'object') continue;
    const extensions = (filter as { extensions?: unknown }).extensions;
    if (!Array.isArray(extensions)) continue;
    for (const entry of extensions) {
      if (typeof entry !== 'string') continue;
      const trimmed = entry.trim();
      if (!trimmed || trimmed === '*' || trimmed === '*.*') continue;
      if (trimmed.includes('/')) {
        tokens.add(trimmed);
        continue;
      }
      const normalized = trimmed.replace(/^\.+/, '');
      if (!normalized || normalized === '*') continue;
      tokens.add(`.${normalized}`);
    }
  }
  return [...tokens].join(',');
}

/** 清理用户选中文件名中的路径分隔符与控制字符，避免 OPFS 路径穿越或非法句柄名。 */
export function sanitizeDialogFileName(rawName: string): string {
  const base = rawName.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[\x00-\x1f]/g, '_').trim();
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return 'file';
  return cleaned;
}

function formatDialogText(args: Record<string, unknown>): string {
  const msg = typeof args.message === 'string' ? args.message : args.message == null ? '' : String(args.message);
  const title = typeof args.title === 'string' ? args.title.trim() : '';
  if (title && msg) return `${title}\n\n${msg}`;
  return title || msg;
}

function resolveMessageResult(args: Record<string, unknown>): string {
  if (typeof args.okButtonLabel === 'string') return args.okButtonLabel;
  const buttons = args.buttons;
  if (buttons && typeof buttons === 'object' && typeof (buttons as { OkCustom?: unknown }).OkCustom === 'string') {
    return (buttons as { OkCustom: string }).OkCustom;
  }
  return 'Ok';
}

function resolveSaveFileName(rawDefaultPath: unknown): string {
  if (typeof rawDefaultPath !== 'string') return 'export.bin';
  const base = rawDefaultPath.split(/[\\/]/).pop()?.replace(/[\x00-\x1f]/g, '_').trim() ?? '';
  if (base === '' || base === '.' || base === '..') return 'export.bin';
  return sanitizeDialogFileName(base);
}

function openFilePicker(options: Record<string, unknown>, writeFile: OpfsBlobWriter): Promise<string | string[] | null> {
  if (options.directory === true) {
    return Promise.reject(new Error('当前移动端暂不支持选择本地文件夹'));
  }
  if (typeof document === 'undefined') {
    return Promise.reject(new Error('当前环境不支持文件选择器'));
  }
  const multiple = Boolean(options.multiple);
  const accept = filtersToAccept(options.filters);

  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = multiple;
    if (accept) input.accept = accept;
    input.style.display = 'none';
    document.body.appendChild(input);

    let settled = false;
    const finish = (done: () => void): void => {
      if (settled) return;
      settled = true;
      input.remove();
      done();
    };

    input.addEventListener('change', () => {
      const selected = Array.from(input.files ?? []);
      if (selected.length === 0) {
        finish(() => resolve(null));
        return;
      }
      const files = multiple ? selected : [selected[0]!];
      void Promise.resolve()
        .then(async () => {
          const paths: string[] = [];
          for (const file of files) {
            const targetPath = `${DIALOG_PICKS_DIR}/${crypto.randomUUID()}/${sanitizeDialogFileName(file.name)}`;
            await writeFile(targetPath, file);
            paths.push(targetPath);
          }
          return multiple ? paths : (paths[0] ?? null);
        })
        .then(
          result => finish(() => resolve(result)),
          (error: unknown) => finish(() => reject(error)),
        );
    }, { once: true });

    input.addEventListener('cancel', () => {
      finish(() => resolve(null));
    }, { once: true });

    input.click();
  });
}

/** 创建供 `MobileShellOptions.onDialogCommand` 使用的对话框处理器。 */
export function createMobileDialogHandler(
  writeFile: OpfsBlobWriter,
  ensureDir?: OpfsDirCreator,
): (command: string, args: Record<string, unknown>) => Promise<unknown> {
  return async (command, args) => {
    switch (command) {
      case 'open': {
        const rawOptions = args.options;
        const options = rawOptions && typeof rawOptions === 'object' && !Array.isArray(rawOptions)
          ? (rawOptions as Record<string, unknown>)
          : {};
        return openFilePicker(options, writeFile);
      }
      case 'save': {
        const rawOptions = args.options;
        const options = rawOptions && typeof rawOptions === 'object' && !Array.isArray(rawOptions)
          ? (rawOptions as Record<string, unknown>)
          : {};
        const fileName = resolveSaveFileName(options.defaultPath);
        const parentDir = `${DIALOG_SAVES_DIR}/${crypto.randomUUID()}`;
        await ensureDir?.(parentDir);
        return `${parentDir}/${fileName}`;
      }
      case 'message':
        globalThis.alert?.(formatDialogText(args));
        return resolveMessageResult(args);
      case 'ask':
      case 'confirm':
        return Boolean(globalThis.confirm?.(formatDialogText(args)));
      default:
        throw new Error(`unsupported dialog command "${command}"`);
    }
  };
}
