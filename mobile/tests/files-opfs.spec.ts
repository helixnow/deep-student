/**
 * 端到端：移动端 `ctx.files`（host/platform/files/opfs.ts，由 mobile.json 装配）在真实浏览器 Worker 的 OPFS 上运行
 * 与桌面实现同一套一致性用例（host/platform/files/tests/conformance.ts），并核对平台差异的显式错误。
 */
import { expect, test, type Page } from '@playwright/test';

async function boot(page: Page): Promise<void> {
  await page.goto('/index.html');
  await page.waitForFunction(() => document.body.dataset.ready !== undefined, undefined, { timeout: 60_000 });
  expect(await page.evaluate(() => document.body.dataset.ready), await page.locator('#status').textContent() ?? '').toBe('true');
}

function diag<T = any>(page: Page, method: string): Promise<T> {
  return page.evaluate(async (m) => (await globalThis.__dstuMobile!).hostCall('mobileDiagnostics', m, []), method) as Promise<T>;
}

test('ctx.files on real OPFS passes the desktop conformance suite', async ({ page }) => {
  await boot(page);
  const report = await diag<{ flavor: string; roots: Array<{ name: string; path: string }>; results: Array<{ name: string; ok: boolean; error?: string }> }>(page, 'filesConformance');
  expect(report.flavor).toBe('posix');
  expect(report.roots.map(root => root.path)).toEqual(['/deep-student', '/deep-student/local', '/deep-student/config', '/deep-student/cache', '/deep-student/logs', '/deep-student/tmp']);
  expect(report.results.length).toBeGreaterThanOrEqual(20);
  expect(report.results.filter(result => !result.ok)).toEqual([]);
});

test('platform differences surface as explicit errors on the real engine', async ({ page }) => {
  await boot(page);
  const rules = await diag<Record<string, any>>(page, 'filesPlatformRules');
  expect(rules.grant).toMatchObject({ name: 'FileError', kind: 'UnsupportedOnPlatform' });
  expect(rules.grant.message).toMatch(/^UNSUPPORTED_ON_PLATFORM: files\.grant is not available on mobile/);
  // Chromium 的目录句柄没有 move()：显式拒绝，源目录原样保留。
  expect(rules.directoryRename).toMatchObject({ name: 'FileError', kind: 'UnsupportedOnPlatform' });
  expect(rules.afterDirectoryRename).toBe('x');
  expect(rules.atomic).toBe('new');
  expect(rules.atomicEntries).toEqual(['a', 'old.txt']);
  expect(rules.secondWriter).toMatchObject({ name: 'FileError', kind: 'Other', osCode: 'NoModificationAllowedError' });
  // openFile 写入句柄占用同步访问句柄直到 close()；getFile() 读取与只读句柄不受影响，并看到句柄的写入。
  expect(rules.heldWriter).toMatchObject({ name: 'FileError', kind: 'Other', osCode: 'NoModificationAllowedError' });
  expect(rules.heldReads).toEqual(['held!', 'held!', 'eld!']);
  expect(rules.afterHeldClose).toBe('free');
  expect(rules.poolDirectory).toMatchObject({ name: 'FileError', kind: 'OutsideRoots' });
  expect(rules.directoryStat).toEqual({ kind: 'directory', size: 0, modifiedMs: 0, createdMs: null, unixMode: null });
});
