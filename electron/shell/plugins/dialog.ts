/**
 * `plugin:dialog|*`（tauri-plugin-dialog-2.6.0 `src/commands.rs`、`src/desktop.rs`、`src/lib.rs`）。
 * 选中的文件/目录与 Rust 版一样加入 fs 插件作用域与 asset 协议作用域。
 */
import { dialog, type BrowserWindow, type MessageBoxOptions, type OpenDialogOptions, type SaveDialogOptions } from 'electron';
import { optString, raw, reqObject, reqString, type InvokeInput } from '../args.ts';
import { invalidArgs } from '../errors.ts';
import type { BuiltinPlugin, CommandContext } from '../runtime.ts';

interface DialogFilter {
  name: string;
  extensions: string[];
}

function filters(input: InvokeInput, options: Record<string, unknown>): DialogFilter[] {
  const value = options.filters;
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw invalidArgs(input.command, 'options', 'invalid type for `filters`, expected a sequence');
  return value.map((f: unknown) => {
    const filter = f as { name?: unknown; extensions?: unknown };
    if (typeof filter.name !== 'string' || !Array.isArray(filter.extensions)) {
      throw invalidArgs(input.command, 'options', 'invalid filter, expected `{ name, extensions }`');
    }
    return { name: filter.name, extensions: filter.extensions.map(String) };
  });
}

function parentWindow(ctx: CommandContext): BrowserWindow | null {
  return ctx.runtime.windows.get(ctx.windowLabel)?.browserWindow ?? null;
}

type Buttons =
  | { kind: 'Ok' }
  | { kind: 'OkCancel' }
  | { kind: 'YesNo' }
  | { kind: 'YesNoCancel' }
  | { kind: 'OkCustom'; ok: string }
  | { kind: 'OkCancelCustom'; ok: string; cancel: string }
  | { kind: 'YesNoCancelCustom'; yes: string; no: string; cancel: string };

function parseButtons(input: InvokeInput, value: unknown): Buttons | null {
  if (value === undefined || value === null) return null;
  if (value === 'Ok' || value === 'OkCancel' || value === 'YesNo' || value === 'YesNoCancel') return { kind: value };
  if (typeof value === 'object') {
    const v = value as { OkCustom?: unknown; OkCancelCustom?: unknown; YesNoCancelCustom?: unknown };
    if (typeof v.OkCustom === 'string') return { kind: 'OkCustom', ok: v.OkCustom };
    if (Array.isArray(v.OkCancelCustom)) return { kind: 'OkCancelCustom', ok: String(v.OkCancelCustom[0]), cancel: String(v.OkCancelCustom[1]) };
    if (Array.isArray(v.YesNoCancelCustom)) {
      return { kind: 'YesNoCancelCustom', yes: String(v.YesNoCancelCustom[0]), no: String(v.YesNoCancelCustom[1]), cancel: String(v.YesNoCancelCustom[2]) };
    }
  }
  throw invalidArgs(input.command, 'buttons', 'unknown variant, expected one of `Ok`, `OkCancel`, `YesNo`, `YesNoCancel`, `OkCustom`, `OkCancelCustom`, `YesNoCancelCustom`');
}

/** 每个按钮：显示文字 + 被点击时的 `MessageDialogResult` 序列化值。 */
function buttonSpecs(buttons: Buttons): { labels: string[]; results: string[]; cancelId: number } {
  switch (buttons.kind) {
    case 'Ok':
      return { labels: ['OK'], results: ['Ok'], cancelId: 0 };
    case 'OkCancel':
      return { labels: ['OK', 'Cancel'], results: ['Ok', 'Cancel'], cancelId: 1 };
    case 'YesNo':
      return { labels: ['Yes', 'No'], results: ['Yes', 'No'], cancelId: 1 };
    case 'YesNoCancel':
      return { labels: ['Yes', 'No', 'Cancel'], results: ['Yes', 'No', 'Cancel'], cancelId: 2 };
    case 'OkCustom':
      return { labels: [buttons.ok], results: [buttons.ok], cancelId: 0 };
    case 'OkCancelCustom':
      return { labels: [buttons.ok, buttons.cancel], results: [buttons.ok, buttons.cancel], cancelId: 1 };
    case 'YesNoCancelCustom':
      return { labels: [buttons.yes, buttons.no, buttons.cancel], results: [buttons.yes, buttons.no, buttons.cancel], cancelId: 2 };
  }
}

function okLabel(buttons: Buttons): string | null {
  if (buttons.kind === 'OkCustom' || buttons.kind === 'OkCancelCustom') return buttons.ok;
  if (buttons.kind === 'YesNoCancelCustom') return buttons.yes;
  return null;
}

function kind(input: InvokeInput): MessageBoxOptions['type'] {
  const k = raw(input, 'kind');
  if (k === undefined || k === null || k === 'info') return 'info';
  if (k === 'warning') return 'warning';
  if (k === 'error') return 'error';
  throw invalidArgs(input.command, 'kind', `unknown variant \`${String(k)}\`, expected one of \`info\`, \`warning\`, \`error\``);
}

async function showMessage(input: InvokeInput, ctx: CommandContext, buttons: Buttons): Promise<string> {
  const specs = buttonSpecs(buttons);
  const title = optString(input, 'title');
  const options: MessageBoxOptions = {
    type: kind(input),
    message: reqString(input, 'message'),
    buttons: specs.labels,
    defaultId: 0,
    cancelId: specs.cancelId,
    noLink: true,
    ...(title !== null ? { title } : {}),
  };
  const parent = parentWindow(ctx);
  const result = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
  return specs.results[result.response] ?? 'Cancel';
}

/** `MessageDialogBuilder::show` 的布尔化。 */
function toBool(result: string, buttons: Buttons): boolean {
  if (result === 'Ok' || result === 'Yes') return true;
  const label = okLabel(buttons);
  return label === null ? result === 'Ok' : result === label;
}

function allowSelected(ctx: CommandContext, path: string, asDirectory: boolean, recursive: boolean): void {
  if (asDirectory) {
    ctx.runtime.fsScope.allowDirectory(path, recursive);
    ctx.runtime.assetScope.allowDirectory(path, true);
  } else {
    ctx.runtime.fsScope.allowFile(path);
    ctx.runtime.assetScope.allowFile(path);
  }
}

export function dialogPlugin(): BuiltinPlugin {
  return {
    open: async (input, ctx) => {
      const options = reqObject(input, 'options');
      const directory = options.directory === true;
      const multiple = options.multiple === true;
      const recursive = options.recursive === true;
      const properties: NonNullable<OpenDialogOptions['properties']> = [directory ? 'openDirectory' : 'openFile'];
      if (multiple) properties.push('multiSelections');
      if (options.canCreateDirectories !== false) properties.push('createDirectory');
      const dialogOptions: OpenDialogOptions = { properties, filters: filters(input, options) };
      if (typeof options.title === 'string') dialogOptions.title = options.title;
      if (typeof options.defaultPath === 'string') dialogOptions.defaultPath = options.defaultPath;
      const parent = parentWindow(ctx);
      const result = parent ? await dialog.showOpenDialog(parent, dialogOptions) : await dialog.showOpenDialog(dialogOptions);
      if (result.canceled || result.filePaths.length === 0) return null;
      for (const p of result.filePaths) allowSelected(ctx, p, directory, recursive);
      return multiple ? result.filePaths : result.filePaths[0];
    },
    save: async (input, ctx) => {
      const options = reqObject(input, 'options');
      const dialogOptions: SaveDialogOptions = {
        filters: filters(input, options),
        properties: options.canCreateDirectories === false ? ['showOverwriteConfirmation'] : ['createDirectory', 'showOverwriteConfirmation'],
      };
      if (typeof options.title === 'string') dialogOptions.title = options.title;
      if (typeof options.defaultPath === 'string') dialogOptions.defaultPath = options.defaultPath;
      const parent = parentWindow(ctx);
      const result = parent ? await dialog.showSaveDialog(parent, dialogOptions) : await dialog.showSaveDialog(dialogOptions);
      if (result.canceled || !result.filePath) return null;
      allowSelected(ctx, result.filePath, false, false);
      return result.filePath;
    },
    message: async (input, ctx) => {
      const ok = optString(input, 'okButtonLabel');
      const buttons = parseButtons(input, raw(input, 'buttons')) ?? (ok !== null ? { kind: 'OkCustom', ok } : { kind: 'Ok' });
      return showMessage(input, ctx, buttons);
    },
    ask: async (input, ctx) => {
      const yes = optString(input, 'yesButtonLabel');
      const no = optString(input, 'noButtonLabel');
      const buttons: Buttons =
        yes !== null
          ? { kind: 'OkCancelCustom', ok: yes, cancel: no ?? 'No' }
          : no !== null
            ? { kind: 'OkCancelCustom', ok: 'Yes', cancel: no }
            : { kind: 'YesNo' };
      return toBool(await showMessage(input, ctx, buttons), buttons);
    },
    confirm: async (input, ctx) => {
      const ok = optString(input, 'okButtonLabel');
      const cancel = optString(input, 'cancelButtonLabel');
      const buttons: Buttons =
        ok !== null
          ? { kind: 'OkCancelCustom', ok, cancel: cancel ?? 'Cancel' }
          : cancel !== null
            ? { kind: 'OkCancelCustom', ok: 'Ok', cancel }
            : { kind: 'OkCancel' };
      return toBool(await showMessage(input, ctx, buttons), buttons);
    },
  };
}

