#!/usr/bin/env node
/**
 * Real-browser smoke for the portable WASM path: Vite serves the TypeScript
 * sources, headless Chromium (Playwright) loads them with no Node globals, and
 * FSRS (F7 engine through MemoryWasi), the tiktoken tokenizer and Argon2id each
 * run one call. Results must equal the goldens the desktop tests pin in
 * `host/platform/native/tests/wasm-portable-fixtures.ts`.
 *
 *   node scripts/portability/browser-wasm-smoke.mjs [--report <path.json>]
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PAGE = '/__portable-wasm-smoke.html';

const html = `<!doctype html><meta charset="utf-8"><script type="module">
import tiktokenWasm from 'tiktoken/tiktoken_bg.wasm?url';
import { DEFAULT_PARAMETERS } from '/host/platform/native/fsrs/api.ts';
import { createWebFsrs } from '/host/platform/native/fsrs/web.ts';
import { webArgon2 } from '/host/platform/native/argon2/web.ts';
import { loadWebTokenizer } from '/host/platform/native/tokenizer/web.ts';
import { createWebWasmEngine, F7_WASM_URL } from '/host/platform/native/wasm/web.ts';
import * as golden from '/host/platform/native/tests/wasm-portable-fixtures.ts';
const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
const result = { environment: { node: typeof process !== 'undefined' && !!process.versions?.node, userAgent: navigator.userAgent, f7Url: String(F7_WASM_URL), tiktokenUrl: tiktokenWasm } };
try {
  const fsrs = createWebFsrs(createWebWasmEngine());
  let started = performance.now();
  const evaluation = await fsrs.evaluate(DEFAULT_PARAMETERS, golden.fsrsCards());
  result.fsrs = { actual: evaluation, expected: golden.FSRS_EVALUATION, tolerance: golden.FSRS_TOLERANCE, match: golden.fsrsEvaluationMatches(evaluation), ms: Math.round(performance.now() - started) };
  started = performance.now();
  const tokenizer = await loadWebTokenizer(fetch(tiktokenWasm));
  result.tokenizer = { actual: [tokenizer.encode(golden.TOKEN_TEXT), tokenizer.encode(golden.TOKEN_TEXT, 'gpt-4o')], expected: [golden.TOKENS_CL100K, golden.TOKENS_O200K], ms: Math.round(performance.now() - started) };
  const encoder = new TextEncoder();
  started = performance.now();
  result.argon2 = { actual: [], expected: golden.ARGON2_VECTORS.map(vector => vector[4]) };
  for (const [m, t, p, length] of golden.ARGON2_VECTORS) {
    result.argon2.actual.push(hex(await webArgon2.deriveKey(encoder.encode(golden.ARGON2_PASSWORD), encoder.encode(golden.ARGON2_SALT), m, t, p, length)));
  }
  result.argon2.ms = Math.round(performance.now() - started);
} catch (error) {
  result.error = String(error && error.stack || error);
}
window.__smoke = result;
</script>`;

const reportIndex = process.argv.indexOf('--report');
const reportPath = reportIndex === -1 ? null : process.argv[reportIndex + 1];

const server = await createServer({
  root: ROOT,
  configFile: false,
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, fs: { strict: false }, hmr: false },
  optimizeDeps: { noDiscovery: true, include: [] },
  plugins: [{
    name: 'portable-wasm-smoke-page',
    configureServer(dev) {
      dev.middlewares.use(PAGE, async (_request, response) => {
        response.setHeader('content-type', 'text/html');
        response.end(await dev.transformIndexHtml(PAGE, html));
      });
    },
  }],
});
await server.listen();
const browser = await chromium.launch();
let exitCode = 1;
try {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(String(error)));
  const wasmResponses = [];
  page.on('response', response => {
    if (response.url().includes('.wasm')) wasmResponses.push({ url: response.url(), status: response.status(), contentType: response.headers()['content-type'] ?? null });
  });
  const { port } = server.httpServer.address();
  await page.goto(`http://127.0.0.1:${port}${PAGE}`);
  await page.waitForFunction(() => window.__smoke !== undefined, null, { timeout: 120_000 });
  const result = await page.evaluate(() => window.__smoke);
  result.wasmResponses = wasmResponses;
  result.pageErrors = pageErrors;
  const same = (entry) => entry !== undefined && JSON.stringify(entry.actual) === JSON.stringify(entry.expected);
  result.pass = result.error === undefined && pageErrors.length === 0 && result.environment.node === false
    && result.fsrs?.match === true && same(result.tokenizer) && same(result.argon2);
  const text = JSON.stringify(result, null, 2);
  process.stdout.write(`${text}\n`);
  if (reportPath) writeFileSync(reportPath, `${text}\n`);
  exitCode = result.pass ? 0 : 1;
} finally {
  await browser.close();
  await server.close();
}
process.exit(exitCode);
