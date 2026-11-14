/**
 * The shell bridge's page-level platform description: `globalThis.__DS_PLATFORM__`, exposed (frozen) by the Electron
 * preload before any page script runs (W06 `electron/API.md`, "页面平台信息"); a mobile shell gives `kind: 'mobile'`
 * through the same global. Browsers and unit tests have no shell, so callers must accept `undefined`.
 *
 * Dependency-free on purpose: `src/utils/platform.ts` (startup code) reads it, and nothing here may pull more modules
 * into the entry chunk. `kind` repeats `UI_PLATFORMS` (meta.ts); a test keeps the two in step.
 */
export type ShellPlatformKind = 'desktop' | 'mobile';
export type ShellPlatformOs = 'macos' | 'windows' | 'linux' | 'android' | 'ios' | 'unknown';

export interface ShellPlatform {
  readonly kind: ShellPlatformKind;
  readonly os: ShellPlatformOs;
  readonly arch?: string;
}

declare global {
  var __DS_PLATFORM__: unknown;
}

/** Node's `process.platform` names (what the Electron preload passes) and the normalized names themselves. */
const OS_NAMES = new Map<string, ShellPlatformOs>([
  ['darwin', 'macos'], ['macos', 'macos'],
  ['win32', 'windows'], ['windows', 'windows'],
  ['linux', 'linux'], ['android', 'android'], ['ios', 'ios'],
]);

/** The shell's platform, normalized; `undefined` without a shell or for a value that is not a platform description. */
export function readShellPlatform(value: unknown = globalThis.__DS_PLATFORM__): ShellPlatform | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { kind, os, arch } = value as Record<string, unknown>;
  if (kind !== 'desktop' && kind !== 'mobile') return undefined;
  const normalized = (typeof os === 'string' && OS_NAMES.get(os.toLowerCase())) || 'unknown';
  return typeof arch === 'string' ? { kind, os: normalized, arch } : { kind, os: normalized };
}
