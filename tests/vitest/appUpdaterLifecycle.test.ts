/**
 * useAppUpdater 生命周期契约测试（source-level）。
 *
 * 钉住 2026-09 更新链路修复的关键行为，防止回归：
 * 1. 桌面端安装完成后不自动 relaunch（readyToRelaunch 交给用户决定时机）；
 *    relaunch 只能出现在 relaunchApp 中。
 * 2. Android 应用内安装：流式下载 + 写 AppCache + 调起 install_apk 命令。
 * 3. 渠道探测 fail-closed：stable 用户在两个清单源都失败时不得放行 check()。
 * 4. 成功检查统一记录 lastCheck（手动检查也刷新"每 N 天"基准）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'vitest';

const hookPath = path.resolve(process.cwd(), 'src/hooks/useAppUpdater.ts');
const source = readFileSync(hookPath, 'utf8');

// 截取 downloadAndInstall 的桌面段（await update.downloadAndInstall 之后到 catch 之前），
// 断言该段不直接调用 relaunch。
function desktopPostInstallSegment(src: string): string {
  const start = src.indexOf('await update.downloadAndInstall(');
  assert.notEqual(start, -1, 'desktop downloadAndInstall call must exist');
  const end = src.indexOf('} catch (err: any) {', start);
  assert.notEqual(end, -1, 'desktop downloadAndInstall catch must exist');
  return src.slice(start, end);
}

describe('useAppUpdater lifecycle contracts', () => {
  it('does not auto-relaunch after desktop install; exposes readyToRelaunch + relaunchApp', () => {
    const segment = desktopPostInstallSegment(source);
    assert.doesNotMatch(segment, /await relaunch\(\)/u, 'post-install segment must not call relaunch() directly');
    assert.match(segment, /readyToRelaunch:\s*true/u, 'post-install segment must set readyToRelaunch');
    // relaunch 唯一合法入口是 relaunchApp（供用户主动触发）
    assert.match(source, /const relaunchApp = useCallback/u);
    assert.match(source, /readyToRelaunch: boolean;/u);
  });

  it('installs APK in-app on Android via streaming download + install_apk command', () => {
    assert.match(source, /const downloadApkAndInstall = useCallback/u);
    assert.match(source, /resp\.body\.getReader\(\)/u, 'APK download must stream the body');
    assert.match(source, /BaseDirectory\.AppCache/u, 'APK must be written under AppCache (FileProvider scope)');
    assert.match(source, /invoke\('install_apk', \{ path: absPath \}\)/u, 'must invoke install_apk with the absolute path');
    assert.match(source, /canInstallInApp: mobile && android/u);
  });

  it('gates stable-channel users with a fail-closed two-level channel probe', () => {
    assert.match(source, /async function probeReleaseChannel\(\)/u);
    assert.match(source, /GH_LATEST_URL/u, 'must fall back to the GitHub latest.json asset');
    // 桌面 stable 分支：channel === null 时 return false，而不是放行 check()
    const desktopBranch = source.slice(source.indexOf("getUpdateChannel() === 'stable'"));
    assert.match(desktopBranch, /channel === null/u);
    assert.match(desktopBranch, /return false/u);
  });

  it('records last-check time on every successful check (including manual ones)', () => {
    assert.match(source, /const succeed = useCallback/u);
    assert.match(source, /setLastCheckTime\(\);\s*\n\s*return true;/u, 'succeed() must persist last-check time');
    // 启动 effect 不再单独记录（避免手动检查漏记的双重标准）
    const effectStart = source.indexOf('// 启动后延迟静默检查');
    assert.notEqual(effectStart, -1);
    const effectSegment = source.slice(effectStart);
    assert.doesNotMatch(effectSegment, /setLastCheckTime\(\)/u, 'startup effect must delegate recording to succeed()');
  });

  it('surfaces startup-detected updates via a global notification (badge can be hidden)', () => {
    assert.match(source, /showGlobalNotification\(\s*'info',\s*i18n\.t\('common:update\.notifyMessage'/u);
    assert.match(source, /lastNotifiedVersion/u, 'notification must be one-shot per version');
    // 去重必须模块级：App 顶层与 AboutTab 各持一个 hook 实例
    assert.match(source, /^let lastNotifiedVersion/um, 'dedupe must survive across hook instances');
  });
});
