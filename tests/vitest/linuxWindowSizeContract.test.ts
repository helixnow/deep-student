import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// #65/#66：X11 桌面下主窗口「显示得很小」。契约分两层：
// 1) tauri.linux.conf.json 的默认逻辑尺寸不得低于最小客户区；
// 2) lib.rs 保留运行时 HiDPI 兜底（按逻辑像素复核并在 scale 变化时复检）。
describe('Linux window size contract (#65/#66 X11 too-small)', () => {
  const config = JSON.parse(
    readFileSync(resolve(process.cwd(), 'src-tauri/tauri.linux.conf.json'), 'utf-8'),
  );
  const mainWindow = config.app.windows[0];

  it('declares a resizable main window with logical min size bounds', () => {
    expect(mainWindow.resizable).toBe(true);
    expect(mainWindow.minWidth).toBeGreaterThan(0);
    expect(mainWindow.minHeight).toBeGreaterThan(0);
  });

  it('keeps the default logical size at or above the minimum client area', () => {
    expect(mainWindow.width).toBeGreaterThanOrEqual(mainWindow.minWidth);
    expect(mainWindow.height).toBeGreaterThanOrEqual(mainWindow.minHeight);
  });

  it('backs the config with the runtime X11 HiDPI guard in lib.rs', () => {
    const libSource = readFileSync(
      resolve(process.cwd(), 'src-tauri/src/lib.rs'),
      'utf-8',
    );
    expect(libSource).toContain('fn enforce_linux_main_window_min_logical_size');
    // 必须按逻辑像素比较（物理像素 / scale factor），不能直接用物理尺寸。
    expect(libSource).toContain('to_logical::<f64>(scale_factor)');
    // scale factor 可能在窗口映射后才更新，必须在变化时复检。
    expect(libSource).toContain('tauri::WindowEvent::ScaleFactorChanged');
  });
});
