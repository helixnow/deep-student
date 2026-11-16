/**
 * Shared IPC argument parsing and validation helpers for mobile shell Tauri plugin handlers.
 */
import type { IpcPayload } from '../../../electron/shell/bridge-messages.ts';

export interface MobilePluginInvoke {
  readonly command: string;
  readonly payload: IpcPayload;
  readonly headers: Record<string, string>;
}

export type MobilePluginHandler = (input: MobilePluginInvoke) => Promise<unknown> | unknown;

/** Parse JSON invoke payload as a plain record; `null` payloads normalize to `{}`. */
export function parseJsonArgs(payload: IpcPayload, pluginName: string): Record<string, unknown> {
  if (payload.contentType !== 'application/json') {
    throw new Error(`${pluginName} commands take JSON arguments`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.data);
  } catch (error) {
    throw new Error(`invalid args JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`invalid args for ${pluginName} command: expected object`);
  }
  return parsed as Record<string, unknown>;
}

export function reqString(args: Record<string, unknown>, key: string, command: string): string {
  const value = args[key];
  if (typeof value !== 'string') {
    throw new Error(`invalid args \`${key}\` for command \`${command}\`: expected string`);
  }
  return value;
}

export function optString(args: Record<string, unknown>, key: string, command: string): string | null {
  const value = args[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new Error(`invalid args \`${key}\` for command \`${command}\`: expected string`);
  }
  return value;
}

export function reqStringArray(args: Record<string, unknown>, key: string, command: string): string[] {
  const value = args[key];
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string')) {
    throw new Error(`invalid args \`${key}\` for command \`${command}\`: expected string[]`);
  }
  return value;
}

export function reqNumber(args: Record<string, unknown>, key: string, command: string): number {
  const value = args[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`invalid args \`${key}\` for command \`${command}\`: expected finite number`);
  }
  return value;
}

export function optRecord(args: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = args[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
