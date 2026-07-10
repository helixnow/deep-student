import { describe, expect, it } from 'vitest';
import zh from '../../../src/locales/zh-CN/workbench.json';
import en from '../../../src/locales/en-US/workbench.json';

function collectKeyPaths(obj: Record<string, unknown>, prefix = ''): string[] {
  const paths: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      paths.push(...collectKeyPaths(value as Record<string, unknown>, path));
    } else {
      paths.push(path);
    }
  }
  return paths.sort();
}

function collectLeafValues(obj: Record<string, unknown>, prefix = ''): Array<[string, unknown]> {
  const leaves: Array<[string, unknown]> = [];
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      leaves.push(...collectLeafValues(value as Record<string, unknown>, path));
    } else {
      leaves.push([path, value]);
    }
  }
  return leaves;
}

describe('workbench i18n parity (zh-CN / en-US)', () => {
  it('has an empty key-set diff between zh-CN and en-US', () => {
    const zhKeys = collectKeyPaths(zh as Record<string, unknown>);
    const enKeys = collectKeyPaths(en as Record<string, unknown>);

    const missingInEn = zhKeys.filter((k) => !enKeys.includes(k));
    const missingInZh = enKeys.filter((k) => !zhKeys.includes(k));

    expect(missingInEn, `keys missing in en-US: ${missingInEn.join(', ')}`).toEqual([]);
    expect(missingInZh, `keys missing in zh-CN: ${missingInZh.join(', ')}`).toEqual([]);
    expect(zhKeys).toEqual(enKeys);
  });

  it('every leaf value is a non-empty string in both locales', () => {
    for (const locale of [zh, en]) {
      for (const [path, value] of collectLeafValues(locale as Record<string, unknown>)) {
        expect(typeof value, `${path} must be a string`).toBe('string');
        expect((value as string).trim().length, `${path} must not be empty`).toBeGreaterThan(0);
      }
    }
  });

  it('covers all key groups required by the parallel task list (P10 §2)', () => {
    const zhKeys = new Set(collectKeyPaths(zh as Record<string, unknown>));
    const requiredKeys = [
      // Dock
      'dock.pin',
      'dock.unpin',
      'dock.closeAll',
      // 窗口
      'window.close',
      'window.minimize',
      'window.zoom',
      'window.restore',
      'window.center',
      'tile.left',
      'tile.right',
      'tile.topLeft',
      'tile.topRight',
      'tile.bottomLeft',
      'tile.bottomRight',
      'tile.fill',
      'tile.center',
      'tile.restore',
      // 俯瞰 / 切换器 / 空桌面
      'expose.title',
      'switcher.title',
      'emptyDesktop.title',
      'emptyDesktop.hint',
      // 设置项
      'settings.mode.title',
      'settings.materialTier.title',
      'settings.wallpaper.title',
      'settings.tileMargins.title',
      'settings.dockAutohide.title',
      'settings.devPanel.title',
      // 快捷键描述
      'shortcuts.tileLeft',
      'shortcuts.cycleNext',
      'shortcuts.cyclePrev',
      'shortcuts.expose',
      // 错误恢复卡 / 冻结占位
      'window.crashTitle',
      'window.reload',
      'window.frozenTitle',
      'window.frozenHint',
    ];
    for (const key of requiredKeys) {
      expect(zhKeys.has(key), `missing required key: ${key}`).toBe(true);
    }
  });

  it('provides every workbench key referenced by the other agents (spot audit)', () => {
    const zhKeys = new Set(collectKeyPaths(zh as Record<string, unknown>));
    const consumedKeys = [
      // appRegistry nameKeys（P7/P8/P9）
      'apps.chat.name',
      // P7 ChatAppWindow（P11 补入）
      'apps.chat.untitledSession',
      'apps.chat.preparing',
      'apps.chat.createFailed',
      'apps.chat.retry',
      'apps.note',
      'apps.textbook',
      'apps.exam',
      'apps.translation',
      'apps.essay',
      'apps.image',
      'apps.file',
      'apps.mindmap',
      'apps.files',
      'apps.todo',
      'apps.skills',
      'apps.templates',
      'apps.taskDashboard',
      'apps.settings',
      'apps.sandbox',
      'apps.pomodoro',
      // Browser (B2c)
      'apps.browser',
      'settings.browserEnabled.title',
      'settings.browserNetworkMode.title',
      'settings.browserAgentControl.title',
      'settings.browserCdpWindows.title',
      'browser.addressPlaceholder',
      'browser.needWorkbench',
      // P5 Dock
      'dock.label',
      'dock.windows',
      'dock.minimized',
      // P3 窗口壳
      'window.tileMenu',
      'window.loading',
      'window.unknownApp',
      'window.crashUnknown',
      // P6 俯瞰 / 切换器
      'expose.empty',
      'expose.untitled',
      'switcher.minimized',
      // P4 壁纸预设
      'wallpaper.aurora',
      'wallpaper.horizon',
      'wallpaper.graphite',
      // P8 内容应用
      'content.missingResource',
      'content.confirmCloseUnsaved',
      // O20 / 桌面化第二波
      'emptyDesktop.actionFiles',
      'cheatsheet.title',
      'desktopMenu.label',
      'a11y.windowRole',
      'files.preview.type.note',
      'dock.closeWindow',
    ];
    for (const key of consumedKeys) {
      expect(zhKeys.has(key), `missing consumed key: ${key}`).toBe(true);
    }
  });
});
