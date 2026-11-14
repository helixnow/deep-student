/** 诊断页与完整前端的选择（mobile/src/main.ts）：只有 app 构建、有 #root、没要求诊断时才挂 React 前端。 */
import { describe, expect, it } from 'vitest';
import { installPagePlatform } from '../../src/shell/platform.ts';
import { readShellPlatform } from '../../../src/ui-kernel/services/shell-platform.ts';
import { shouldMountApp } from '../../src/shell/page-mode.ts';

describe('mobile page mode', () => {
  it('mounts the full frontend only in the app build with #root and no diagnostics query', () => {
    expect(shouldMountApp({ mode: 'app', search: '', hasRoot: true })).toBe(true);
    expect(shouldMountApp({ mode: 'app', search: '?diagnostics=0', hasRoot: true })).toBe(true);
    expect(shouldMountApp({ mode: 'app', search: '?diagnostics=1', hasRoot: true })).toBe(false);
    expect(shouldMountApp({ mode: 'app', search: '?diagnostics', hasRoot: true })).toBe(false);
    expect(shouldMountApp({ mode: 'app', search: '', hasRoot: false })).toBe(false);
    expect(shouldMountApp({ mode: 'diagnostics', search: '', hasRoot: true })).toBe(false);
    expect(shouldMountApp({ mode: 'production', search: '', hasRoot: true })).toBe(false);
  });

  it('exposes the page platform the frontend reads (kind mobile, frozen, not redefinable)', () => {
    const page: Record<string, unknown> = {};
    installPagePlatform(page, 'android');
    expect(readShellPlatform(page.__DS_PLATFORM__)).toEqual({ kind: 'mobile', os: 'android' });
    expect(Object.isFrozen(page.__DS_PLATFORM__)).toBe(true);
    expect(() => installPagePlatform(page, 'ios')).toThrow(TypeError);
  });
});
