import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DISABLE_WAYLAND_IME_ENV,
  formatChromiumSwitch,
  installLinuxWaylandSwitches,
  isWaylandImeDisabled,
  isWaylandSession,
  LINUX_WAYLAND_IME_SWITCHES,
  resolveLinuxWaylandSwitches,
  type WaylandApp,
} from '../shell/linux-wayland.ts';

const root = join(import.meta.dirname, '../..');

function fakeWaylandApp(initialSwitches: readonly string[] = []) {
  const recorded: Array<[string] | [string, string]> = [];
  const present = new Set<string>(initialSwitches);
  const app: WaylandApp = {
    commandLine: {
      hasSwitch: (name: string) => present.has(name),
      appendSwitch: (...args: [string] | [string, string]) => {
        recorded.push(args);
        present.add(args[0]);
      },
    },
  };
  return { app, recorded, present };
}

describe('Linux Wayland IME switches (Issue #481 Comment #3)', () => {
  it('detects Wayland sessions via WAYLAND_DISPLAY or XDG_SESSION_TYPE=wayland', () => {
    expect(isWaylandSession({ WAYLAND_DISPLAY: 'wayland-0' })).toBe(true);
    expect(isWaylandSession({ WAYLAND_DISPLAY: 'wayland-1', XDG_SESSION_TYPE: 'x11' })).toBe(true);
    expect(isWaylandSession({ XDG_SESSION_TYPE: 'wayland' })).toBe(true);
    expect(isWaylandSession({ XDG_SESSION_TYPE: ' Wayland ' })).toBe(true);
    expect(isWaylandSession({})).toBe(false);
    expect(isWaylandSession({ WAYLAND_DISPLAY: '   ', XDG_SESSION_TYPE: 'x11' })).toBe(false);
    expect(isWaylandSession({ XDG_SESSION_TYPE: 'tty' })).toBe(false);
  });

  it('parses DEEP_STUDENT_DISABLE_WAYLAND_IME opt-out flag cleanly', () => {
    for (const value of ['1', 'true', 'TRUE', 'yes', 'on', ' 1 ']) {
      expect(isWaylandImeDisabled({ [DISABLE_WAYLAND_IME_ENV]: value }), value).toBe(true);
    }
    for (const value of [undefined, '', '   ', '0', 'false', 'no', 'off']) {
      expect(isWaylandImeDisabled({ [DISABLE_WAYLAND_IME_ENV]: value }), String(value)).toBe(false);
    }
  });

  it('does nothing on non-Linux platforms even when Wayland env vars are set', () => {
    for (const platform of ['darwin', 'win32'] as const) {
      const { app, recorded } = fakeWaylandApp();
      const applied = installLinuxWaylandSwitches(app, {
        platform,
        env: { WAYLAND_DISPLAY: 'wayland-0', XDG_SESSION_TYPE: 'wayland' },
        argv: ['/Applications/Deep Student'],
      });
      expect(applied).toEqual([]);
      expect(recorded).toEqual([]);
    }
  });

  it('does nothing on Linux X11 / non-Wayland sessions', () => {
    const { app, recorded } = fakeWaylandApp();
    const applied = installLinuxWaylandSwitches(app, {
      platform: 'linux',
      env: { DISPLAY: ':0', XDG_SESSION_TYPE: 'x11' },
      argv: ['/opt/deep-student/deep-student'],
    });
    expect(applied).toEqual([]);
    expect(recorded).toEqual([]);
  });

  it('appends ozone-platform-hint, enable-wayland-ime, and wayland-text-input-version=3 on Linux Wayland', () => {
    for (const env of [
      { WAYLAND_DISPLAY: 'wayland-0' },
      { XDG_SESSION_TYPE: 'wayland' },
    ]) {
      const { app, recorded } = fakeWaylandApp();
      const applied = installLinuxWaylandSwitches(app, {
        platform: 'linux',
        env,
        argv: ['/opt/deep-student/deep-student'],
      });
      expect(applied).toEqual(LINUX_WAYLAND_IME_SWITCHES);
      expect(recorded).toEqual([
        ['ozone-platform-hint', 'auto'],
        ['enable-wayland-ime'],
        ['wayland-text-input-version', '3'],
      ]);
      // Ensure boolean switch is called with 1 argument, not (name, undefined).
      expect(recorded[1]).toHaveLength(1);
      expect(applied.map(formatChromiumSwitch)).toEqual([
        '--ozone-platform-hint=auto',
        '--enable-wayland-ime',
        '--wayland-text-input-version=3',
      ]);
    }
  });

  it('skips all Wayland switches when DEEP_STUDENT_DISABLE_WAYLAND_IME opt-out is enabled', () => {
    const { app, recorded } = fakeWaylandApp();
    const applied = installLinuxWaylandSwitches(app, {
      platform: 'linux',
      env: { WAYLAND_DISPLAY: 'wayland-0', [DISABLE_WAYLAND_IME_ENV]: '1' },
      argv: ['/opt/deep-student/deep-student'],
    });
    expect(applied).toEqual([]);
    expect(recorded).toEqual([]);
  });

  it('respects explicit --ozone-platform* CLI flags and commandLine switches by appending nothing', () => {
    for (const argv of [
      ['/opt/ds', '--ozone-platform=x11'],
      ['/opt/ds', '--ozone-platform=wayland'],
      ['/opt/ds', '--ozone-platform', 'x11'],
      ['/opt/ds', '--ozone-platform-hint=x11'],
      ['/opt/ds', '--ozone-platform-hint=auto'],
      ['/opt/ds', '--ozone-platform-hint', 'wayland'],
      ['/opt/ds', '--OZONE-PLATFORM=x11'],
    ]) {
      const { app, recorded } = fakeWaylandApp();
      expect(
        installLinuxWaylandSwitches(app, {
          platform: 'linux',
          env: { WAYLAND_DISPLAY: 'wayland-0' },
          argv,
        }),
        argv.join(' '),
      ).toEqual([]);
      expect(recorded).toEqual([]);
    }

    for (const existing of ['ozone-platform', 'ozone-platform-hint']) {
      const { app, recorded } = fakeWaylandApp([existing]);
      expect(
        installLinuxWaylandSwitches(app, {
          platform: 'linux',
          env: { WAYLAND_DISPLAY: 'wayland-0' },
          argv: ['/opt/ds'],
        }),
        existing,
      ).toEqual([]);
      expect(recorded).toEqual([]);
    }
  });

  it('ignores positional arguments after -- when checking CLI flags', () => {
    const switches = resolveLinuxWaylandSwitches({
      platform: 'linux',
      env: { WAYLAND_DISPLAY: 'wayland-0' },
      argv: ['/opt/ds', '--', '--ozone-platform=x11'],
    });
    expect(switches).toEqual(LINUX_WAYLAND_IME_SWITCHES);
  });

  it('avoids duplicating or overriding already-passed IME switches and is idempotent', () => {
    const { app, recorded } = fakeWaylandApp();
    const first = installLinuxWaylandSwitches(app, {
      platform: 'linux',
      env: { WAYLAND_DISPLAY: 'wayland-0' },
      argv: ['/opt/ds', '--wayland-text-input-version=1', '--enable-wayland-ime'],
    });
    expect(first).toEqual([{ name: 'ozone-platform-hint', value: 'auto' }]);
    expect(recorded).toEqual([['ozone-platform-hint', 'auto']]);

    // Second invocation sees ozone-platform-hint already present on app.commandLine -> no-op.
    const second = installLinuxWaylandSwitches(app, {
      platform: 'linux',
      env: { WAYLAND_DISPLAY: 'wayland-0' },
      argv: ['/opt/ds'],
    });
    expect(second).toEqual([]);
    expect(recorded).toEqual([['ozone-platform-hint', 'auto']]);
  });

  it('does not duplicate a single switch already set via app.commandLine', () => {
    const { app, recorded } = fakeWaylandApp(['enable-wayland-ime']);
    const applied = installLinuxWaylandSwitches(app, {
      platform: 'linux',
      env: { XDG_SESSION_TYPE: 'wayland' },
      argv: ['/opt/ds'],
    });
    expect(applied).toEqual([
      { name: 'ozone-platform-hint', value: 'auto' },
      { name: 'wayland-text-input-version', value: '3' },
    ]);
    expect(recorded).toEqual([
      ['ozone-platform-hint', 'auto'],
      ['wayland-text-input-version', '3'],
    ]);
  });

  it('main invokes installLinuxWaylandSwitches after dropDevOnlyEnv and before app.whenReady / directEntry', () => {
    const main = readFileSync(join(root, 'electron/main.ts'), 'utf8');
    const drop = main.indexOf('dropDevOnlyEnv(process.env, app.isPackaged)');
    const call = main.indexOf('installLinuxWaylandSwitches(app,');
    const directEntry = main.indexOf('const directEntry');
    const ready = main.indexOf('whenReady');
    expect(drop).toBeGreaterThan(0);
    expect(call).toBeGreaterThan(drop);
    expect(call).toBeLessThan(directEntry);
    if (ready >= 0) expect(call).toBeLessThan(ready);
  });
});
