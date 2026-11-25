/**
 * Linux Wayland 原生 Ozone 与 fcitx5/IBus IME 开关（Issue #481 Comment #3）。
 *
 * Electron/Chromium 在 Linux 下默认可能回退到 XWayland，或未启用 Wayland text-input-v3，
 * 导致 fcitx5 在窗口获得焦点时无法切换中英文输入法。
 *
 * 仅在以下条件同时满足时追加开关：
 * - `platform === 'linux'`
 * - 处于 Wayland 会话（`WAYLAND_DISPLAY` 非空，或 `XDG_SESSION_TYPE === 'wayland'`）
 * - 未通过 `DEEP_STUDENT_DISABLE_WAYLAND_IME` 显式关闭（`1` / `true` / `yes` / `on`）
 * - 未通过命令行或 `app.commandLine` 显式传入任何 `--ozone-platform*` 开关
 *
 * 已通过命令行或 `app.commandLine` 传入的单个开关（例如 `--enable-wayland-ime` 或
 * `--wayland-text-input-version=1`）会保持原样，不重复追加也不覆盖。
 *
 * 必须在 `app.whenReady()` 之前调用。
 */

export const DISABLE_WAYLAND_IME_ENV = 'DEEP_STUDENT_DISABLE_WAYLAND_IME';

export interface ChromiumSwitch {
  readonly name: string;
  readonly value?: string;
}

export const LINUX_WAYLAND_IME_SWITCHES: readonly ChromiumSwitch[] = Object.freeze([
  Object.freeze({ name: 'ozone-platform-hint', value: 'auto' }),
  Object.freeze({ name: 'enable-wayland-ime' }),
  Object.freeze({ name: 'wayland-text-input-version', value: '3' }),
]);

export interface LinuxWaylandOptions {
  platform: NodeJS.Platform | string;
  env: Readonly<Record<string, string | undefined>>;
  argv: readonly string[];
  hasSwitch?: (name: string) => boolean;
}

export interface WaylandCommandLine {
  appendSwitch(name: string, value?: string): void;
  hasSwitch?(name: string): boolean;
}

export interface WaylandApp {
  commandLine: WaylandCommandLine;
}

/** 处于 Wayland 会话：`WAYLAND_DISPLAY` 非空或 `XDG_SESSION_TYPE === 'wayland'`。 */
export function isWaylandSession(env: Readonly<Record<string, string | undefined>>): boolean {
  if ((env.WAYLAND_DISPLAY ?? '').trim().length > 0) return true;
  return (env.XDG_SESSION_TYPE ?? '').trim().toLowerCase() === 'wayland';
}

/** 用户通过 `DEEP_STUDENT_DISABLE_WAYLAND_IME` 显式关闭自动追加。 */
export function isWaylandImeDisabled(env: Readonly<Record<string, string | undefined>>): boolean {
  const raw = env[DISABLE_WAYLAND_IME_ENV];
  if (raw === undefined) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function collectCliSwitchNames(argv: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const arg of argv) {
    if (arg === '--') break;
    if (!arg.startsWith('--') || arg.length <= 2) continue;
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    const name = (eq === -1 ? body : body.slice(0, eq)).toLowerCase();
    if (name.length > 0) names.add(name);
  }
  return names;
}

function hasExplicitOzonePlatformFlag(
  cliSwitches: ReadonlySet<string>,
  hasSwitch?: (name: string) => boolean,
): boolean {
  for (const name of cliSwitches) {
    if (name.startsWith('ozone-platform')) return true;
  }
  if (hasSwitch !== undefined) {
    if (hasSwitch('ozone-platform') || hasSwitch('ozone-platform-hint')) return true;
  }
  return false;
}

/**
 * 纯函数计算需要追加的 Chromium 开关列表（不包含已由 CLI 或 `commandLine` 指定的开关）。
 * 不满足 Linux Wayland 条件、已显式 opt-out 或已传 `--ozone-platform*` 时返回空数组。
 */
export function resolveLinuxWaylandSwitches(options: LinuxWaylandOptions): ChromiumSwitch[] {
  if (options.platform !== 'linux') return [];
  if (!isWaylandSession(options.env)) return [];
  if (isWaylandImeDisabled(options.env)) return [];
  const cliSwitches = collectCliSwitchNames(options.argv);
  if (hasExplicitOzonePlatformFlag(cliSwitches, options.hasSwitch)) return [];
  return LINUX_WAYLAND_IME_SWITCHES.filter(
    (sw) => !cliSwitches.has(sw.name) && !(options.hasSwitch?.(sw.name) ?? false),
  );
}

/** 在 `app.whenReady()` 之前调用；返回实际追加的开关列表。 */
export function installLinuxWaylandSwitches(
  app: WaylandApp,
  options: Omit<LinuxWaylandOptions, 'hasSwitch'>,
): ChromiumSwitch[] {
  const hasSwitch = app.commandLine.hasSwitch
    ? (name: string) => app.commandLine.hasSwitch!(name)
    : undefined;
  const switches = resolveLinuxWaylandSwitches({ ...options, hasSwitch });
  for (const sw of switches) {
    if (sw.value === undefined) app.commandLine.appendSwitch(sw.name);
    else app.commandLine.appendSwitch(sw.name, sw.value);
  }
  return switches;
}

export function formatChromiumSwitch(sw: ChromiumSwitch): string {
  return sw.value === undefined ? `--${sw.name}` : `--${sw.name}=${sw.value}`;
}
