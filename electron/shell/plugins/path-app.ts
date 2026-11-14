/**
 * `plugin:path|*`（tauri-2.11.5 `src/path/plugin.rs`）、`plugin:app|*`（`src/app/plugin.rs`）、
 * `plugin:resources|close`（`src/resources/plugin.rs`）。
 */
import { app, nativeTheme } from 'electron';
import { optString, raw, reqInteger, reqString, reqStringArray, type InvokeInput } from '../args.ts';
import { invalidArgs, missingKey, ShellCommandError } from '../errors.ts';
import * as ops from '../path-ops.ts';
import { UnknownPathError } from '../paths.ts';
import type { BuiltinPlugin } from '../runtime.ts';
import { unsupported } from '../runtime.ts';

/** 与 tauri-2.11.5 编译出的 `tauri::VERSION` 一致。 */
export const TAURI_VERSION = '2.11.5';

function wrap<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof UnknownPathError) throw new ShellCommandError(error.message);
    if (error instanceof Error && (error.message === ops.NO_PARENT || error.message === ops.NO_EXTENSION || error.message === ops.NO_BASENAME)) {
      throw new ShellCommandError(error.message);
    }
    throw error;
  }
}

function directoryArg(input: InvokeInput): number {
  const v = raw(input, 'directory');
  if (v === undefined) throw missingKey(input.command, 'directory');
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 23) {
    throw invalidArgs(input.command, 'directory', `invalid value: ${JSON.stringify(v)}, expected one of 1..=23`);
  }
  return v;
}

export function pathPlugin(): BuiltinPlugin {
  return {
    resolve_directory: (input, ctx) => {
      const directory = directoryArg(input);
      const path = optString(input, 'path');
      return wrap(() => ctx.runtime.paths.resolve(directory, path));
    },
    resolve: (input, ctx) => ops.resolve(reqStringArray(input, 'paths'), process.cwd(), ctx.runtime.platform),
    normalize: (input, ctx) => ops.normalize(reqString(input, 'path'), ctx.runtime.platform),
    join: (input, ctx) => ops.join(reqStringArray(input, 'paths'), ctx.runtime.platform),
    dirname: (input, ctx) => wrap(() => ops.dirname(reqString(input, 'path'), ctx.runtime.platform)),
    extname: (input, ctx) => wrap(() => ops.extname(reqString(input, 'path'), ctx.runtime.platform)),
    basename: (input, ctx) => wrap(() => ops.basename(reqString(input, 'path'), optString(input, 'ext'), ctx.runtime.platform)),
    is_absolute: (input, ctx) => ops.isAbsolute(reqString(input, 'path'), ctx.runtime.platform),
  };
}

export function appPlugin(): BuiltinPlugin {
  const no = (command: string, reason: string) => unsupported('app', command, reason);
  return {
    version: (_input, ctx) => ctx.runtime.appVersion,
    name: (_input, ctx) => ctx.runtime.config.productName,
    tauri_version: () => TAURI_VERSION,
    identifier: (_input, ctx) => ctx.runtime.config.identifier,
    bundle_type: () => null,
    supports_multiple_windows: () => true,
    app_show: () => {
      if (process.platform === 'darwin') app.show();
      return null;
    },
    app_hide: () => {
      if (process.platform === 'darwin') app.hide();
      return null;
    },
    set_app_theme: (input) => {
      const theme = raw(input, 'theme');
      nativeTheme.themeSource = theme === 'dark' ? 'dark' : theme === 'light' ? 'light' : 'system';
      return null;
    },
    set_dock_visibility: (input) => {
      const visible = raw(input, 'visible');
      if (process.platform === 'darwin' && app.dock) {
        if (visible === true) void app.dock.show();
        else app.dock.hide();
      }
      return null;
    },
    default_window_icon: no('default_window_icon', 'image resources (tauri::image::Image rids) are unavailable in the Electron shell'),
    fetch_data_store_identifiers: no('fetch_data_store_identifiers', 'WKWebsiteDataStore identifiers do not exist in Electron'),
    remove_data_store: no('remove_data_store', 'WKWebsiteDataStore identifiers do not exist in Electron'),
  };
}

export function resourcesPlugin(): BuiltinPlugin {
  return {
    close: async (input, ctx) => {
      await ctx.runtime.closeResource(ctx.webviewLabel, reqInteger(input, 'rid'));
      return null;
    },
  };
}
