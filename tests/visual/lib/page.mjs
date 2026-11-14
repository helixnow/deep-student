/**
 * Deterministic page setup for the demo-shell layers (DOM golden, IPC trace, screenshots).
 *
 * - App-level environment is pinned identically on every host: macOS desktop user agent and
 *   navigator.platform, zh-CN, Asia/Shanghai, a fixed start time (Playwright clock, time still flows),
 *   seeded Math.random / crypto.getRandomValues / randomUUID, reduced motion.
 * - Only rasterisation (fonts, anti-aliasing) still depends on the host, which is why screenshots and
 *   DOM goldens are stored per platform while IPC traces are shared.
 */
export const FIXED_TIME = new Date('2026-03-02T09:30:00+08:00');
export const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';
export const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
};

/** Runs in the page before any app script. Kept free of closures over Node values. */
function pageInit() {
  Object.defineProperty(Navigator.prototype, 'platform', { configurable: true, get: () => 'MacIntel' });
  Object.defineProperty(Navigator.prototype, 'userAgentData', { configurable: true, get: () => undefined });
  Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { configurable: true, get: () => 8 });
  Object.defineProperty(Navigator.prototype, 'deviceMemory', { configurable: true, get: () => 8 });

  let seed = 0x2f6b1d3;
  const next = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  Math.random = next;
  const fill = (array) => {
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(next() * 256);
    return array;
  };
  crypto.getRandomValues = fill;
  crypto.randomUUID = () => {
    const b = fill(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  };

  // IPC trace: wrap whatever invoke the Tauri mocks install. The accessor makes
  // `'__TAURI_INTERNALS__' in window` true slightly early, but the demo entries assign it before any
  // app module is imported, and every module that branches on it is an app module.
  const trace = [];
  window.__DS_TRACE__ = trace;
  window.__DS_TRACE_STEP__ = 'boot';
  const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
  const shape = (value, depth) => {
    if (Array.isArray(value)) {
      const keys = new Set();
      for (const item of value) if (isPlain(item)) for (const k of Object.keys(item)) if (item[k] !== undefined) keys.add(k);
      return keys.size && depth > 0 ? `[]{${[...keys].sort().join(',')}}` : '';
    }
    if (!isPlain(value) || depth <= 0) return '';
    const parts = Object.keys(value).filter((k) => value[k] !== undefined).sort().map((k) => `${k}${shape(value[k], depth - 1)}`);
    return `{${parts.join(',')}}`;
  };
  const record = (cmd, args) => {
    const step = window.__DS_TRACE_STEP__;
    if (cmd === 'plugin:event|listen' || cmd === 'plugin:event|unlisten' || cmd === 'plugin:event|emit') {
      const row = { step, call: `${cmd.slice('plugin:event|'.length)}:${args?.event ?? '?'}` };
      // Chat block events carry their phase (start/chunk/end); only scene clock moves read it, goldens never do.
      const phase = cmd === 'plugin:event|emit' && isPlain(args?.payload) ? args.payload.phase : undefined;
      if (typeof phase === 'string') row.phase = phase;
      trace.push(row);
      return;
    }
    const keys = isPlain(args) ? shape(args, 2) : args === undefined ? '' : `<${Object.prototype.toString.call(args).slice(8, -1)}>`;
    trace.push({ step, call: `${cmd}(${keys.replace(/^\{|\}$/g, '')})` });
  };
  const wrapInternals = (internals) => {
    if (!internals || typeof internals !== 'object' || internals.__dsTraced) return internals;
    let inner = internals.invoke;
    Object.defineProperty(internals, '__dsTraced', { value: true });
    Object.defineProperty(internals, 'invoke', {
      configurable: true,
      enumerable: true,
      get: () => (inner ? (cmd, args, options) => { record(cmd, args); return inner(cmd, args, options); } : inner),
      set: (fn) => { inner = fn; },
    });
    return internals;
  };
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    configurable: true,
    get: () => undefined,
    set: (value) => {
      // From the first assignment on it is a plain data property again.
      Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, writable: true, enumerable: true, value: wrapInternals(value) });
    },
  });
}

/** `reducedMotion` and `initScripts` (run after pageInit, before any app script) exist for motion-check.mjs. */
export async function newScenePage(browser, { viewport = 'desktop', theme = 'light', reducedMotion = 'reduce', initScripts = [] } = {}) {
  const context = await browser.newContext({
    viewport: VIEWPORTS[viewport],
    deviceScaleFactor: 1,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    colorScheme: theme === 'dark' ? 'dark' : 'light',
    reducedMotion,
    userAgent: USER_AGENT,
  });
  // Nothing may leave the machine; the demo is fully mocked.
  await context.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort('internetdisconnected'));
  await context.addInitScript(pageInit);
  for (const script of initScripts) await context.addInitScript(script);
  const page = await context.newPage();
  await page.clock.install({ time: FIXED_TIME });
  const errors = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message.split('\n')[0]}`));
  return { context, page, errors };
}

/** Resolve when the DOM has had no mutation for `quietMs` (page clock time), or after `timeoutMs`. */
export async function waitForQuiet(page, { quietMs = 800, timeoutMs = 20_000 } = {}) {
  return page.evaluate(({ quietMs, timeoutMs }) => new Promise((resolve) => {
    const start = performance.now();
    let last = performance.now();
    const observer = new MutationObserver(() => { last = performance.now(); });
    observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    const tick = () => {
      const now = performance.now();
      if (now - last >= quietMs || now - start >= timeoutMs) {
        observer.disconnect();
        resolve(now - last >= quietMs);
        return;
      }
      setTimeout(tick, 50);
    };
    setTimeout(tick, 50);
  }), { quietMs, timeoutMs });
}

export async function settle(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].filter((img) => !img.complete).map((img) => new Promise((resolve) => {
      img.addEventListener('load', resolve, { once: true });
      img.addEventListener('error', resolve, { once: true });
    })));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  return waitForQuiet(page);
}

export async function setStep(page, name) {
  await page.evaluate((step) => { window.__DS_TRACE_STEP__ = step; }, name);
}

export async function readTrace(page) {
  return page.evaluate(() => window.__DS_TRACE__ ?? []);
}
