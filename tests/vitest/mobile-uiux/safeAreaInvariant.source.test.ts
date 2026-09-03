/**
 * safe-area / 44px 不变量源码契约（0824 Wave2-C R7 · 测试员-safe-area）
 *
 * 锁四组底座事实，防后续轮次悄悄挪走或改写：
 * 1. G 44px token：`--control-height-touch: 44px` + `--touch-target-size` 别名
 *    （shadcn-variables.css），coarse pointer 下 `.touch-target` 44×44 最小热区
 *    （responsive-utilities.css）。
 * 2. env(safe-area-inset)：ios-safe-area.css :root 四向
 *    `--mobile-safe-area-* → var(--android-safe-area-*, env(safe-area-inset-*, 0px))`
 *    全局兜底映射，platform.ts 注入 Android 真实值。
 * 3. mobileShell 变量：MOBILE_SHELL 六个 CSS 变量名 + getMobileShellCssVars()，
 *    且 App.tsx 实际消费（展开到壳树上）。
 * 4. 不变量 18 相关路径存在（wave2-C-r1/08 §4 静态自证的文件级锚点）：
 *    legal NOTICES、Composer* 拆分文件、androidBackCoordinator + back 桥安装。
 *
 * 只做字符串/存在性断言，不数数量、不锁行号——无关重构不误报，
 * 真回归（token 改值、env 兜底被删、拆分文件被合并回去）必然翻红。
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (relPath: string) =>
  readFileSync(resolve(process.cwd(), relPath), 'utf-8');

describe('safe-area invariant: G 44px token', () => {
  const tokensCss = read('src/styles/shadcn-variables.css');
  const responsiveCss = read('src/styles/responsive-utilities.css');

  it('keeps the 44px touch control token and its alias in shadcn-variables.css', () => {
    expect(tokensCss).toContain('--control-height-touch: 44px');
    expect(tokensCss).toContain('--touch-target-size: var(--control-height-touch)');
  });

  it('keeps the coarse-pointer .touch-target 44x44 minimum hit area', () => {
    expect(responsiveCss).toContain('@media (pointer: coarse)');
    const coarseBlock = responsiveCss.slice(
      responsiveCss.indexOf('@media (pointer: coarse)')
    );
    const touchTargetRule = coarseBlock.slice(coarseBlock.indexOf('.touch-target'));
    expect(touchTargetRule).toContain('min-height: 44px !important');
    expect(touchTargetRule).toContain('min-width: 44px !important');
  });

  it('keeps .touch-row anchored to the touch control token', () => {
    expect(responsiveCss).toContain('var(--control-height-touch, 44px)');
  });
});

describe('safe-area invariant: env(safe-area-inset) mappings', () => {
  const iosSafeAreaCss = read('src/styles/ios-safe-area.css');
  const responsiveCss = read('src/styles/responsive-utilities.css');
  const platformSource = read('src/utils/platform.ts');

  it.each(['top', 'right', 'bottom', 'left'] as const)(
    'maps --mobile-safe-area-%s with android override + env() + 0px fallback in :root',
    (side) => {
      expect(iosSafeAreaCss).toContain(
        `--mobile-safe-area-${side}: var(--android-safe-area-${side}, env(safe-area-inset-${side}, 0px))`
      );
    }
  );

  it.each(['top', 'right', 'bottom', 'left'] as const)(
    'keeps the raw --safe-area-inset-%s env() alias in :root',
    (side) => {
      expect(iosSafeAreaCss).toContain(
        `--safe-area-inset-${side}: env(safe-area-inset-${side}, 0px)`
      );
    }
  );

  it('keeps the .safe-area-* utility classes consuming the same fallback chain', () => {
    expect(responsiveCss).toContain(
      'padding-top: var(--android-safe-area-top, env(safe-area-inset-top, 0px))'
    );
    expect(responsiveCss).toContain(
      'padding-bottom: var(--android-safe-area-bottom, env(safe-area-inset-bottom, 0px))'
    );
  });

  it('keeps platform.ts injecting the four --android-safe-area-* values', () => {
    for (const side of ['top', 'bottom', 'left', 'right']) {
      expect(platformSource).toContain(`'--android-safe-area-${side}'`);
    }
  });
});

describe('safe-area invariant: mobileShell contract variables', () => {
  const mobileShellSource = read('src/app/shell/mobileShell.ts');
  const appSource = read('src/App.tsx');

  it('keeps the four-side android→env fallback chains as the shell source of truth', () => {
    for (const side of ['top', 'bottom', 'left', 'right']) {
      expect(mobileShellSource).toContain(
        `var(--android-safe-area-${side}, env(safe-area-inset-${side}, 0px))`
      );
    }
  });

  it('keeps every MOBILE_SHELL css var name', () => {
    for (const varName of [
      '--mobile-safe-area-top',
      '--mobile-safe-area-bottom',
      '--mobile-safe-area-left',
      '--mobile-safe-area-right',
      '--mobile-header-height',
      '--mobile-header-total-height',
    ]) {
      expect(mobileShellSource).toContain(`'${varName}'`);
    }
  });

  it('keeps getMobileShellCssVars() composing header total height from safe-area top', () => {
    expect(mobileShellSource).toContain('export function getMobileShellCssVars()');
    expect(mobileShellSource).toContain(
      'calc(${MOBILE_SHELL.headerHeight}px + ${getMobileSafeAreaTopValue()})'
    );
  });

  it('keeps App.tsx spreading the shell vars onto the app tree', () => {
    expect(appSource).toContain("from './app/shell/mobileShell'");
    expect(appSource).toContain('...getMobileShellCssVars()');
  });
});

describe('safe-area invariant: invariant-18 anchor paths exist', () => {
  const fromRoot = (relPath: string) => resolve(process.cwd(), relPath);

  it('keeps third-party NOTICES under legal/', () => {
    expect(existsSync(fromRoot('legal/THIRD_PARTY_NOTICES.txt'))).toBe(true);
  });

  it.each([
    'ComposerInlinePanel.tsx',
    'ComposerPanelOverlay.tsx',
    'ComposerPlusMenu.tsx',
    'ComposerTextarea.tsx',
    'ComposerToolbar.tsx',
    'ComposerPanel/ComposerPanel.tsx',
    'composerDraftStorage.ts',
  ])('keeps the Composer split file input-bar/%s', (file) => {
    expect(
      existsSync(fromRoot(`src/features/chat/components/input-bar/${file}`))
    ).toBe(true);
  });

  it('keeps the android back coordinator and its App.tsx bridge install', () => {
    expect(
      existsSync(fromRoot('src/app/navigation/androidBackCoordinator.ts'))
    ).toBe(true);
    const appSource = read('src/App.tsx');
    expect(appSource).toContain(
      "from './app/navigation/androidBackCoordinator'"
    );
    expect(appSource).toContain('installAndroidBackBridge()');
  });

  it('keeps the safe-area style anchors on disk', () => {
    for (const relPath of [
      'src/styles/ios-safe-area.css',
      'src/styles/responsive-utilities.css',
      'src/styles/shadcn-variables.css',
      'src/app/shell/mobileShell.ts',
      'src/utils/platform.ts',
    ]) {
      expect(existsSync(fromRoot(relPath))).toBe(true);
    }
  });
});
