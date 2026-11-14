/**
 * Quick-assistant window lifecycle — TS port of `src-tauri/src/quick_assistant.rs`.
 *
 * Window creation/positioning is delegated to the F2 shell (`plugin:window|*` and the
 * `window.setVibrancy` equivalent `plugin:window|set_effects`); settings live in the
 * F4 `ctx.settings` store. All persistence keys and the `quick-assistant://shown`
 * event keep the Rust names.
 */
import type { Context } from '@deepseek-ai/cordis';
import {
  GLOBAL_SHORTCUT_TRIGGERED, type BackendEvents, type ShellBridge,
} from '../../../kernel/api.ts';
import type { Logger } from '../../../platform/log/api.ts';

export const QUICK_ASSISTANT_WINDOW_LABEL = 'quick-assistant';
export const QUICK_ASSISTANT_SHOWN_EVENT = 'quick-assistant://shown';
export const QUICK_ASSISTANT_ENABLED_KEY = 'quick_assistant.enabled';
/** v3: logical pixels; v2 stored physical inner_size and broke on 2x displays. */
export const QUICK_ASSISTANT_BOUNDS_KEY = 'quick_assistant.window_bounds.v3';

export const QUICK_ASSISTANT_DEFAULT_WIDTH = 480;
export const QUICK_ASSISTANT_DEFAULT_HEIGHT = 384;
export const QUICK_ASSISTANT_MIN_WIDTH = 400;
export const QUICK_ASSISTANT_MIN_HEIGHT = 320;
export const QUICK_ASSISTANT_MAX_WIDTH = 800;
export const QUICK_ASSISTANT_MAX_HEIGHT = 720;

/** Rust `parse_bounds`: i32 x/y, u32 w/h, zero sizes rejected. */
export function parseQuickAssistantBounds(raw: string): [number, number, number, number] | null {
  const parts = raw.split(',').map(part => part.trim());
  if (parts.length < 4) return null;
  const x = parseSigned(parts[0]!, 2 ** 31 - 1, -(2 ** 31));
  const y = parseSigned(parts[1]!, 2 ** 31 - 1, -(2 ** 31));
  const w = parseUnsigned(parts[2]!, 2 ** 32 - 1);
  const h = parseUnsigned(parts[3]!, 2 ** 32 - 1);
  if (x === null || y === null || w === null || h === null) return null;
  if (w === 0 || h === 0) return null;
  return [x, y, w, h];
}

function parseSigned(raw: string, max: number, min: number): number | null {
  if (!/^[+-]?\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
}

function parseUnsigned(raw: string, max: number): number | null {
  if (!/^\+?\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 && value <= max ? value : null;
}

interface MonitorInfo {
  size: { width: number; height: number };
  position: { x: number; y: number };
}

interface SettingsSurface {
  get(key: string): string | null;
  save(key: string, value: string): void;
}

export interface QuickAssistantDeps {
  readonly platform: 'darwin' | 'win32' | 'linux';
  readonly settings: SettingsSurface;
  readonly shell: ShellBridge;
  readonly events: BackendEvents;
  readonly logger: Logger;
}

/**
 * `desktop::MAIN_WAS_FOCUSED` is per-process state in Rust; each service instance
 * owns the same flag. Window labels and monitor units stay in the shell layer.
 */
export class QuickAssistantService {
  private readonly deps: QuickAssistantDeps;
  private mainWasFocused = false;
  private tail: Promise<void> = Promise.resolve();

  constructor(deps: QuickAssistantDeps) {
    this.deps = deps;
  }

  /** Rust `tauri_plugin_global_shortcut` handler: only `Pressed` toggles. */
  installGlobalShortcut(): void {
    this.deps.events.listen(GLOBAL_SHORTCUT_TRIGGERED, (payload) => {
      const state = payload !== null && typeof payload === 'object'
        ? (payload as Record<string, unknown>)['state'] : undefined;
      if (state !== 'Pressed') return;
      void this.serialized(() => this.toggleInternal());
    });
  }

  /** Rust `is_enabled`: only the literal string `"false"` disables the window. */
  isEnabled(): boolean {
    return this.getSetting(QUICK_ASSISTANT_ENABLED_KEY) !== 'false';
  }

  show(): Promise<void> {
    return this.serialized(() => this.showInternal());
  }

  hide(): Promise<void> {
    return this.serialized(() => this.hideInternal());
  }

  applyEnabled(enabled: boolean): Promise<void> {
    return this.serialized(async () => {
      if (enabled) return;
      if (!(await this.windowExists())) return;
      await this.persistBounds();
      await this.bestEffort('destroy window',
        this.deps.shell.request('plugin:window|destroy', { label: QUICK_ASSISTANT_WINDOW_LABEL }));
    });
  }

  toggle(): Promise<void> {
    return this.serialized(() => this.toggleInternal());
  }

  private async toggleInternal(): Promise<void> {
    if (!this.isEnabled()) return;
    const visible = await this.bestEffort('read visibility',
      this.deps.shell.request<boolean>('plugin:window|is_visible', { label: QUICK_ASSISTANT_WINDOW_LABEL }),
      false);
    if (visible) await this.hideInternal();
    else await this.showInternal();
  }

  private serialized(action: () => Promise<void>): Promise<void> {
    const run = this.tail.then(action, action);
    this.tail = run.catch(error => {
      this.deps.logger.error(`[QuickAssistant] window operation failed: ${errorText(error)}`);
    });
    return run;
  }

  private async showInternal(): Promise<void> {
    const created = await this.ensureWindow();
    if (!created) return;

    const mainFocused = await this.bestEffort('read main focus',
      this.deps.shell.request<boolean>('plugin:window|is_focused', { label: 'main' }), false);
    this.mainWasFocused = mainFocused;

    if (this.deps.platform === 'win32') {
      await this.bestEffort('unminimize',
        this.deps.shell.request('plugin:window|unminimize', { label: QUICK_ASSISTANT_WINDOW_LABEL }));
    }
    await this.positionOnCursorMonitor();
    await this.bestEffort('show window',
      this.deps.shell.request('plugin:window|show', { label: QUICK_ASSISTANT_WINDOW_LABEL }));
    await this.bestEffort('focus window',
      this.deps.shell.request('plugin:window|set_focus', { label: QUICK_ASSISTANT_WINDOW_LABEL }));
    this.deps.events.emit(QUICK_ASSISTANT_SHOWN_EVENT, null);
  }

  private async hideInternal(): Promise<void> {
    if (!(await this.windowExists())) return;
    await this.persistBounds();

    if (this.deps.platform === 'win32') {
      // Rust minimizes first so the OS hands focus back, then hides to leave the taskbar.
      await this.bestEffort('minimize window',
        this.deps.shell.request('plugin:window|minimize', { label: QUICK_ASSISTANT_WINDOW_LABEL }));
      await this.bestEffort('hide window',
        this.deps.shell.request('plugin:window|hide', { label: QUICK_ASSISTANT_WINDOW_LABEL }));
      return;
    }

    await this.bestEffort('hide window',
      this.deps.shell.request('plugin:window|hide', { label: QUICK_ASSISTANT_WINDOW_LABEL }));
    if (this.deps.platform === 'darwin') {
      const mainVisible = await this.bestEffort('read main visibility',
        this.deps.shell.request<boolean>('plugin:window|is_visible', { label: 'main' }), false);
      if (!this.mainWasFocused && !mainVisible) {
        await this.bestEffort('hide application',
          this.deps.shell.request('plugin:app|app_hide', {}));
      }
    }
  }

  private async ensureWindow(): Promise<boolean> {
    if (await this.windowExists()) return true;
    try {
      await this.deps.shell.request('plugin:window|create', {
        options: {
          label: QUICK_ASSISTANT_WINDOW_LABEL,
          url: `index.html?window=${QUICK_ASSISTANT_WINDOW_LABEL}`,
          title: 'Deep Student - Quick Learning',
          width: QUICK_ASSISTANT_DEFAULT_WIDTH,
          height: QUICK_ASSISTANT_DEFAULT_HEIGHT,
          minWidth: QUICK_ASSISTANT_MIN_WIDTH,
          minHeight: QUICK_ASSISTANT_MIN_HEIGHT,
          maxWidth: QUICK_ASSISTANT_MAX_WIDTH,
          maxHeight: QUICK_ASSISTANT_MAX_HEIGHT,
          resizable: true,
          decorations: false,
          transparent: true,
          alwaysOnTop: true,
          skipTaskbar: true,
          visible: false,
          center: true,
        },
      });
    } catch (error) {
      this.deps.logger.error(`[QuickAssistant] failed to create window: ${errorText(error)}`);
      return false;
    }
    // Windows has no visible-on-all-workspaces API; Rust ignores the failure.
    await this.bestEffort('set visible on all workspaces',
      this.deps.shell.request('plugin:window|set_visible_on_all_workspaces', {
        label: QUICK_ASSISTANT_WINDOW_LABEL, value: true,
      }));
    if (this.deps.platform === 'darwin') {
      // Rust applies NSVisualEffectMaterial::HudWindow with state Active and radius 16.
      await this.bestEffort('apply hud window vibrancy',
        this.deps.shell.request('plugin:window|set_effects', {
          label: QUICK_ASSISTANT_WINDOW_LABEL,
          value: { effects: ['hudWindow'], state: 'active', radius: 16 },
        }));
    }
    return true;
  }

  private async positionOnCursorMonitor(): Promise<void> {
    const cursor = await this.bestEffort<{ x: number; y: number } | null>('read cursor position',
      this.deps.shell.request<{ x: number; y: number }>('plugin:window|cursor_position',
        { label: QUICK_ASSISTANT_WINDOW_LABEL }), null);
    let monitor: MonitorInfo | null = cursor === null ? null
      : await this.bestEffort<MonitorInfo | null>('monitor from point',
        this.deps.shell.request<MonitorInfo | null>('plugin:window|monitor_from_point', {
          label: QUICK_ASSISTANT_WINDOW_LABEL, x: cursor.x, y: cursor.y,
        }), null);
    if (monitor === null) {
      monitor = await this.bestEffort<MonitorInfo | null>('primary monitor',
        this.deps.shell.request<MonitorInfo | null>('plugin:window|primary_monitor',
          { label: QUICK_ASSISTANT_WINDOW_LABEL }), null);
    }
    if (monitor === null) return;

    const raw = this.getSetting(QUICK_ASSISTANT_BOUNDS_KEY);
    const saved = raw === null ? null : parseQuickAssistantBounds(raw);
    if (saved !== null) {
      const [x, y, width, height] = saved;
      const centerX = x + Math.trunc(width / 2);
      const centerY = y + Math.trunc(height / 2);
      const inside = centerX >= monitor.position.x
        && centerX < monitor.position.x + monitor.size.width
        && centerY >= monitor.position.y
        && centerY < monitor.position.y + monitor.size.height;
      if (inside) {
        await this.setLogicalSize(width, height);
        await this.setPhysicalPosition(x, y);
        return;
      }
      // Monitor changed: keep the saved size and re-center below.
      await this.setLogicalSize(width, height);
    }

    const size = await this.bestEffort<{ width: number; height: number } | null>('read inner size',
      this.deps.shell.request<{ width: number; height: number }>('plugin:window|inner_size',
        { label: QUICK_ASSISTANT_WINDOW_LABEL }), null);
    if (size === null) return;
    const x = monitor.position.x + Math.trunc((monitor.size.width - size.width) / 2);
    const y = monitor.position.y
      + Math.trunc(Math.max((monitor.size.height - size.height) * 0.24, 24));
    await this.setPhysicalPosition(x, y);
  }

  private async setLogicalSize(width: number, height: number): Promise<void> {
    await this.bestEffort('set logical size',
      this.deps.shell.request('plugin:window|set_size', {
        label: QUICK_ASSISTANT_WINDOW_LABEL, value: { Logical: { width, height } },
      }));
  }

  private async setPhysicalPosition(x: number, y: number): Promise<void> {
    await this.bestEffort('set physical position',
      this.deps.shell.request('plugin:window|set_position', {
        label: QUICK_ASSISTANT_WINDOW_LABEL, value: { Physical: { x, y } },
      }));
  }

  /** Rust `persist_bounds`: position is physical, size is stored in logical pixels. */
  private async persistBounds(): Promise<void> {
    const position = await this.bestEffort<{ x: number; y: number } | null>('read outer position',
      this.deps.shell.request<{ x: number; y: number }>('plugin:window|outer_position',
        { label: QUICK_ASSISTANT_WINDOW_LABEL }), null);
    const size = await this.bestEffort<{ width: number; height: number } | null>('read inner size',
      this.deps.shell.request<{ width: number; height: number }>('plugin:window|inner_size',
        { label: QUICK_ASSISTANT_WINDOW_LABEL }), null);
    const scale = await this.bestEffort<number | null>('read scale factor',
      this.deps.shell.request<number>('plugin:window|scale_factor',
        { label: QUICK_ASSISTANT_WINDOW_LABEL }), null);
    if (position === null || size === null || scale === null) return;
    const width = Math.round(clamp(size.width / scale, QUICK_ASSISTANT_MIN_WIDTH,
      QUICK_ASSISTANT_MAX_WIDTH));
    const height = Math.round(clamp(size.height / scale, QUICK_ASSISTANT_MIN_HEIGHT,
      QUICK_ASSISTANT_MAX_HEIGHT));
    this.saveSetting(QUICK_ASSISTANT_BOUNDS_KEY, `${position.x},${position.y},${width},${height}`);
  }

  private async windowExists(): Promise<boolean> {
    const labels = await this.bestEffort<string[]>('list windows',
      this.deps.shell.request<string[]>('plugin:window|get_all_windows', {}), []);
    return Array.isArray(labels) && labels.includes(QUICK_ASSISTANT_WINDOW_LABEL);
  }

  private getSetting(key: string): string | null {
    try {
      return this.deps.settings.get(key);
    } catch (error) {
      // Rust `get_setting(...).ok().flatten()` swallows the storage error.
      this.deps.logger.debug(`[QuickAssistant] failed to read setting ${key}: ${errorText(error)}`);
      return null;
    }
  }

  private saveSetting(key: string, value: string): void {
    try {
      this.deps.settings.save(key, value);
    } catch (error) {
      // Rust `let _ = state.database.save_setting(...)`.
      this.deps.logger.debug(`[QuickAssistant] failed to save setting ${key}: ${errorText(error)}`);
    }
  }

  private async bestEffort<T>(operation: string, run: Promise<T>): Promise<T | undefined>;
  private async bestEffort<T>(operation: string, run: Promise<T>, fallback: T): Promise<T>;
  private async bestEffort<T>(operation: string, run: Promise<T>, fallback?: T): Promise<T | undefined> {
    try {
      return await run;
    } catch (error) {
      // Rust uses `let _ = ...` for these shell calls; failures are not user-visible.
      this.deps.logger.debug(`[QuickAssistant] ${operation} failed: ${errorText(error)}`);
      return fallback;
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Plugin entry helper: wire the global-shortcut listener and command handlers. */
export function createQuickAssistantService(ctx: Context): QuickAssistantService {
  const service = new QuickAssistantService({
    platform: ctx.app.platform,
    settings: ctx.settings,
    shell: ctx.shell,
    events: ctx.backendEvents,
    logger: ctx.log.logger('deep_student_lib::quick_assistant'),
  });
  service.installGlobalShortcut();
  return service;
}
