#!/usr/bin/env node
// Measure a real, built WebUI backed by an isolated Node Host. Run after `npm run build:web`.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { startWebServer } from '../../web/server/main.ts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const distDir = process.argv[2] ?? join(repoRoot, 'dist-web');
if (!existsSync(join(distDir, 'index.html'))) {
  throw new Error('Missing WebUI build: run npm run build:web first, or pass the build directory.');
}
const appDataDir = mkdtempSync(join(tmpdir(), 'dstu-web-startup-'));
process.env.DEEP_STUDENT_KEY_SEED_FILE_ONLY = '1';
const token = randomBytes(24).toString('hex');
const timeout = 120_000;
const dock = '[data-testid="wb-dock-item-chat"]';
const composer = '[data-testid="input-bar-v2-textarea"]';
const browser = await chromium.launch();
let web;
try {
  web = await startWebServer({
    repoRoot, distDir, appDataDir, host: '127.0.0.1', port: 0, prod: true, token,
    disableAuth: false, trustProxy: false, log: () => {},
  });
  const origin = new URL(web.url).origin;
  const contextOptions = { serviceWorkers: 'block', viewport: { width: 1440, height: 900 } };
  const setup = await browser.newContext(contextOptions);
  let storageState;
  try {
    const auth = await setup.request.post(`${origin}/api/auth/session`, { data: { token } });
    if (!auth.ok()) throw new Error(`WebUI login failed: HTTP ${auth.status()}`);
    const page = await setup.newPage();
    await page.goto(origin, { waitUntil: 'commit', timeout });
    await page.getByRole('button', { name: /我已阅读并同意|I have read and agree/ }).click({ timeout });
    await page.locator(dock).waitFor({ timeout });
    const welcome = page.getByRole('button', { name: /先随便看看|Just look around first/ });
    const tour = page.getByTestId('wb-empty-tour-skip');
    // The tour and welcome card are first-run UI; dismiss either if it blocks the dock.
    await page.addLocatorHandler(welcome, () => welcome.click());
    await page.addLocatorHandler(tour, () => tour.click());
    await page.locator(dock).click({ timeout });
    await page.locator(composer).first().waitFor({ timeout });
    storageState = await setup.storageState();
  } finally {
    await setup.close();
  }

  const runs = [];
  for (let index = 0; index < 3; index++) {
    const context = await browser.newContext({ ...contextOptions, storageState });
    try {
      const page = await context.newPage();
      await page.addInitScript(() => {
        let lcp = null;
        const observer = new PerformanceObserver(list => { lcp = list.getEntries().at(-1)?.startTime ?? lcp; });
        observer.observe({ type: 'largest-contentful-paint', buffered: true });
        performance.setResourceTimingBufferSize(5000);
        window.readStartupPaint = () => ({
          fcpMs: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null,
          lcpBeforeChatClickMs: observer.takeRecords().at(-1)?.startTime ?? lcp,
        });
      });
      const cdp = await context.newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false, latency: 150, downloadThroughput: 1_600_000 / 8, uploadThroughput: 750_000 / 8,
      });
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      await page.goto(origin, { waitUntil: 'commit', timeout });
      const chatDock = page.locator(dock);
      await chatDock.waitFor({ timeout });
      const shell = await page.evaluate(() => ({ dockVisibleMs: performance.now(), ...window.readStartupPaint() }));
      await chatDock.click({ timeout });
      const input = page.locator(composer).first();
      await input.waitFor({ timeout });
      if (!await input.isEditable()) throw new Error('The chat composer is visible but not editable.');
      const chat = await page.evaluate(() => {
        const scripts = performance.getEntriesByType('resource').filter(resource => {
          const url = new URL(resource.name);
          return url.origin === location.origin && url.pathname.endsWith('.js');
        });
        return {
          composerReadyMs: performance.now(),
          jsFiles: scripts.length,
          jsEncodedBodyBytes: scripts.reduce((sum, resource) => sum + resource.encodedBodySize, 0),
        };
      });
      runs.push({ ...shell, ...chat });
    } finally {
      await context.close();
    }
  }
  const median = key => {
    const values = runs.map(run => run[key]).filter(value => value !== null).sort((a, b) => a - b);
    return values.length === runs.length ? Math.round(values[Math.floor(values.length / 2)]) : null;
  };
  console.log(JSON.stringify({
    profile: 'Cold authenticated navigation, 150 ms RTT / 1.6 Mbps down / 0.75 Mbps up, 4x CPU',
    median: Object.fromEntries(Object.keys(runs[0]).map(key => [key, median(key)])),
    runs,
  }, null, 2));
} finally {
  try { await browser.close(); } finally { await web?.close(); }
}
