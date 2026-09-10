/**
 * 壁纸链路诊断单测：锁定「诊断不影响功能」与「诊断在 Tauri 运行时确实落到
 * log_debug_message」两条契约——后者是问题 3 现场排查的唯一入口，静默失效
 * 会让用户实测时白等一场。
 */
/* eslint-disable no-console -- 断言诊断日志的 console 输出 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async () => null),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

import {
  describeDiagError,
  logWallpaperDiag,
  WALLPAPER_DIAG_PREFIX,
} from '../wallpaperDiagnostics';

const scope = window as unknown as Record<string, unknown>;

function stripTauriGlobals(): void {
  delete scope.__TAURI_INTERNALS__;
  delete scope.__TAURI_IPC__;
}

beforeEach(() => {
  invokeMock.mockClear();
  stripTauriGlobals();
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  stripTauriGlobals();
});

describe('logWallpaperDiag', () => {
  it('非 Tauri 环境只写 console，不触发 IPC', () => {
    logWallpaperDiag('render', { kind: 'image' });

    expect(console.info).toHaveBeenCalledWith(
      expect.stringContaining(`${WALLPAPER_DIAG_PREFIX} render`),
    );
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('Tauri 运行时经 log_debug_message 写入应用日志', async () => {
    scope.__TAURI_INTERNALS__ = {};

    logWallpaperDiag('image:error', { imageUrl: 'http://asset.localhost/x.png' });

    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('log_debug_message', {
        message: expect.stringContaining(`${WALLPAPER_DIAG_PREFIX} image:error`),
      });
    });
    const [, args] = invokeMock.mock.calls[0] as unknown as [string, { message: string }];
    expect(args.message).toContain('asset.localhost');
  });

  it('payload 不可序列化时不抛错，仍输出阶段名', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => logWallpaperDiag('render', circular)).not.toThrow();
    expect(console.info).toHaveBeenCalledWith(
      expect.stringContaining(`${WALLPAPER_DIAG_PREFIX} render`),
    );
  });
});

describe('describeDiagError', () => {
  it('Error 保留名称与信息，非 Error 走 String()', () => {
    expect(describeDiagError(new TypeError('boom'))).toBe('TypeError: boom');
    expect(describeDiagError('plain')).toBe('plain');
    expect(describeDiagError(undefined)).toBe('undefined');
  });
});
