import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * #65/#66 防回归契约：Linux 桌面主窗口 chrome。
 *
 * 背景：v0.9.35 尚无 tauri.linux.conf.json，Linux 打包直接落到基座
 * tauri.conf.json 的 decorations:false，而前端自定义窗口按钮只在
 * isWindows() 下渲染 —— Debian/KDE（X11 与 Wayland）用户因此既没有
 * 关闭/最大化/最小化按钮，也无法拉伸窗口（GTK 无装饰窗口没有
 * 边缘 resize），X11 上还出现初始窗口过小。
 *
 * Tauri 2 会在 Linux 目标构建时用 JSON Merge Patch 合并
 * tauri.linux.conf.json，其中数组是整体替换：linux conf 的
 * app.windows[0] 必须自带完整窗口定义，任何字段都不会从基座继承。
 *
 * 本契约锁定：Linux 至少存在一条完整窗口 chrome 路径 ——
 * 要么 linux conf 开启原生装饰（decorations + resizable + 可用尺寸），
 * 要么前端壳层在 Linux 下渲染自定义 min/max/close 控件。
 */

const readText = (relativePath: string): string =>
  readFileSync(resolve(process.cwd(), relativePath), 'utf-8');

const baseConf = JSON.parse(readText('src-tauri/tauri.conf.json'));
const linuxConf = JSON.parse(readText('src-tauri/tauri.linux.conf.json'));
const appSource = readText('src/App.tsx');
const statusBarSource = readText('src/features/workbench/components/StatusBar.tsx');

const linuxWindows: Array<Record<string, unknown>> = linuxConf.app?.windows ?? [];
const linuxWindow = linuxWindows[0] ?? {};

const linuxHasNativeChrome =
  linuxWindow.decorations === true && linuxWindow.resizable === true;

// 壳层源码中是否存在 isLinux() 门控的自定义窗口控件渲染路径
const rendersLinuxCustomControls = [appSource, statusBarSource].some((source) =>
  /\bisLinux\(\)[^]{0,200}WindowControls/.test(source),
);

describe('Linux window chrome contract (#65/#66)', () => {
  it('linux conf 保持原生装饰与可拉伸', () => {
    expect(linuxWindows).toHaveLength(1);
    expect(linuxWindow.decorations).toBe(true);
    expect(linuxWindow.resizable).toBe(true);
    expect(linuxWindow.fullscreen).toBe(false);
    // lib.rs 通过 get_webview_window("main") 做显示/聚焦，label 不能漂移
    expect((linuxWindow.label as string | undefined) ?? 'main').toBe('main');
  });

  it('linux conf 自带完整窗口定义（JSON Merge Patch 整体替换 windows 数组，字段不继承基座）', () => {
    for (const key of [
      'title',
      'width',
      'height',
      'minWidth',
      'minHeight',
      'resizable',
      'decorations',
    ]) {
      expect(linuxWindow, `tauri.linux.conf.json windows[0] 缺少 ${key}`).toHaveProperty(key);
    }
  });

  it('默认尺寸可用且不小于最小尺寸（X11 初始小窗防回归）', () => {
    const width = linuxWindow.width as number;
    const height = linuxWindow.height as number;
    const minWidth = linuxWindow.minWidth as number;
    const minHeight = linuxWindow.minHeight as number;

    expect(minWidth).toBeGreaterThanOrEqual(640);
    expect(minHeight).toBeGreaterThanOrEqual(480);
    expect(width).toBeGreaterThanOrEqual(minWidth);
    expect(height).toBeGreaterThanOrEqual(minHeight);
  });

  it('Linux 桌面至少一条完整窗口 chrome 路径：原生装饰或前端自定义控件', () => {
    expect(linuxHasNativeChrome || rendersLinuxCustomControls).toBe(true);
  });

  it('基座 decorations:false 不允许泄漏到 Linux 构建', () => {
    const baseWindow = baseConf.app?.windows?.[0] ?? {};
    if (baseWindow.decorations !== true) {
      // 基座是无边框窗口时，linux conf 必须提供 windows overlay 兜底
      expect(linuxWindows.length).toBeGreaterThan(0);
      expect(linuxHasNativeChrome || rendersLinuxCustomControls).toBe(true);
    }
  });

  it('原生装饰开启时，壳层不为 Linux 重复渲染自定义窗口按钮', () => {
    if (linuxHasNativeChrome) {
      expect(rendersLinuxCustomControls).toBe(false);
      // 当前的平台门控快照：主壳层与工作台菜单栏的自定义三键仅限 Windows。
      // 若这两行改动（例如把控件扩展到 Linux），需同步复核 linux conf 的
      // decorations 设置，避免出现双份窗口按钮或两头皆无。
      expect(appSource).toContain('{isWindows() && <WindowControls />}');
      expect(statusBarSource).toContain('const winChromeInset = isWindows();');
    }
  });
});
